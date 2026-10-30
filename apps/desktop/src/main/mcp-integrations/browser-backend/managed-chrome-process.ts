// Managed Chrome process identity and OS-level teardown.
//
// The managed browser is identified by two command-line arguments:
// `--user-data-dir=<profile>` and `--remote-debugging-port=<port>`. Anything
// destructive must be proven by exactly those two arguments:
//
// - Holding the CDP port is NOT identity. The port outlives the browser
//   whenever Windows orphans Chromium's children (a `TerminateProcess` on the
//   parent leaves the children running), and any other program can take a
//   fixed port once Chrome exits.
// - The profile directory alone is not identity either, but combined with the
//   port it is what makes a kill safe: only Cindy's own managed browser is
//   launched with that pair.
//
// The graceful (CDP) and the forceful (OS) teardown paths share this module so
// they can never drift apart on what "our browser" means.

import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

import { pidIsManagedChromeForProfile } from '@cindy/browser-control-runtime';

import {
  findPortOwnerPids,
  killPortOwner,
  type PortReclaimLogger,
} from '../../cindy-brain/portReclaim.js';

const execFileAsync = promisify(execFile);

export interface ManagedChromeProcessLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ManagedChromeTermination {
  /** PIDs proven to be the managed browser and signalled. */
  killedPids: number[];
  /** Whether the CDP port was free once the teardown finished. */
  portReleased: boolean;
}

/**
 * Whether a command line carries this exact argument, respecting token
 * boundaries.
 *
 * A substring test is not sufficient: `--user-data-dir=/p/Cindy` is a prefix of
 * `--user-data-dir=/p/Cindy-backup`, so `includes` would accept an unrelated
 * browser and hand it to a process kill. The argument must be delimited by
 * whitespace or quotes on both sides (or sit at a string edge).
 */
export function commandLineHasExactArgument(commandLine: string, argument: string): boolean {
  let offset = commandLine.indexOf(argument);
  while (offset >= 0) {
    const before = offset === 0 ? '' : commandLine[offset - 1];
    const after = commandLine[offset + argument.length] ?? '';
    if ((!before || /[\s"']/.test(before)) && (!after || /[\s"']/.test(after))) return true;
    offset = commandLine.indexOf(argument, offset + 1);
  }
  return false;
}

/** Injectable command runner so tests can pin the PowerShell script and decode path. */
export type ManagedChromeCommandRunner = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>;

/**
 * Windows command-line identity for a PID.
 *
 * The vendored `readManagedProcessCommandLine` only implements Linux (/proc)
 * and macOS (ps), returning null on win32 — so the shared identity verifier
 * always answers "not ours" there, which would silently disable the very
 * teardown this platform needs. Query Win32_Process for the command line so
 * the same profile/port proof can be applied.
 *
 * Returns null on any failure, so callers treat an unknown identity as "do not
 * signal" rather than assuming ownership.
 */
export async function readWindowsProcessCommandLine(
  pid: number,
  runCommand: ManagedChromeCommandRunner = execFileAsync,
): Promise<string | null> {
  try {
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}`
      + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const { stdout } = await runCommand(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Pin the console to BOM-less UTF-8 before writing: OutputEncoding is
        // "the encoding the console uses to write output", so on a system whose
        // code page is not UTF-8 a profile path with non-ASCII characters would
        // otherwise come back mojibake. The identity comparison is exact, so
        // mojibake would fail it and silently skip the very teardown this
        // function gates. Same pin as desktopProcessIdentity.ts.
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
          + `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; `
          + 'if ($p) { [string]$p.CommandLine }',
      ],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 },
    );
    const text = stdout.trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** Whether a PID is a Chrome launched for exactly this profile and CDP port. */
export async function isManagedChromeProcess(params: {
  pid: number;
  cdpPort: number;
  userDataDir: string;
}): Promise<boolean> {
  if (process.platform !== 'win32') {
    return pidIsManagedChromeForProfile(params);
  }
  const commandLine = await readWindowsProcessCommandLine(params.pid);
  if (!commandLine) return false;
  // Same two proofs the POSIX path requires: our profile AND our debug port.
  // Exact-argument matching, not substring: `--user-data-dir=<dir>` is a prefix
  // of `--user-data-dir=<dir>-backup`, and this result feeds `taskkill /T /F`.
  return commandLineHasExactArgument(commandLine, `--user-data-dir=${params.userDataDir}`)
    && commandLineHasExactArgument(commandLine, `--remote-debugging-port=${params.cdpPort}`);
}

/**
 * Whether anything still holds the CDP port.
 *
 * Deliberately a bare TCP connect, not an HTTP request: accepting a connection
 * is handled by the OS/socket layer, so a Chrome stalled on its main thread
 * still completes it while failing to answer `/json/version`. That difference
 * is the whole point — it separates "process gone" from "process busy".
 */
export async function isCdpPortListening(cdpHttpUrl: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(cdpHttpUrl);
  } catch {
    return false;
  }
  const port = Number(target.port || 80);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* best effort */ }
      resolve(listening);
    };
    const socket = createConnection({ port, host });
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true)); // reachable but unresponsive
    socket.once('error', () => finish(false));
  });
}

/**
 * How long a signalled browser may take to drop its listening socket, and how
 * often to re-check while it does.
 *
 * `kill` returning is not the process exiting: the kernel can hand the socket
 * back a moment later, so probing once right after the signal would call a
 * successful teardown a failure — and the caller would keep the route
 * hard-blocked over a browser that did exit. The budget has to be long enough
 * for a dying Chromium to unwind, and short enough that a genuinely stuck port
 * still fails fast (the caller stays fail-closed either way).
 */
const PORT_RELEASE_TIMEOUT_MS = 3_000;
const PORT_RELEASE_POLL_INTERVAL_MS = 100;

/**
 * Wait, within a bounded budget, for the CDP port to actually be free.
 *
 * Returns as soon as a probe finds nothing listening; when the budget runs out
 * with the port still held, returns false so the caller keeps its hard block
 * rather than optimistically declaring the teardown a success.
 */
async function waitForCdpPortReleased(
  cdpHttpUrl: string,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? PORT_RELEASE_TIMEOUT_MS;
  const pollIntervalMs = opts?.pollIntervalMs ?? PORT_RELEASE_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isCdpPortListening(cdpHttpUrl))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Terminate the managed browser's process tree at the OS level.
 *
 * The graceful CDP close cannot always finish the job. On Windows the vendored
 * stop escalates to `proc.kill('SIGKILL')`, which is a `TerminateProcess` on
 * the one process handle it launched: Chromium's children survive as orphans,
 * and one of them keeps the CDP port bound. The route then can never be
 * verified stopped, so the backend hard-blocks every later request — including
 * `start` — for the rest of the process lifetime.
 *
 * `taskkill /T /F` kills the whole tree, so the orphans go with it; POSIX gets
 * `SIGKILL` on the process that owns the port. Every candidate is proven to be
 * the managed browser first (both identifying arguments, read from the OS), so
 * a stranger's process is never signalled — and a candidate that cannot be
 * proven is left alone, which keeps the caller fail-closed.
 *
 * Issuing the kill is not an exit: `taskkill` can fail on permissions or lose
 * a race, and even a delivered signal leaves the process (and the socket it
 * owns) alive for a moment. The caller must re-verify independently;
 * `portReleased` reports what the OS could confirm within a bounded wait after
 * the signals were sent.
 */
export async function terminateManagedChromeProcessTree(params: {
  cdpHttpUrl: string;
  userDataDir: string;
  logger: ManagedChromeProcessLogger;
  /**
   * Identity proof for a candidate PID. Test seam; production reads the OS
   * command line and requires Cindy's own profile and CDP port.
   */
  isManagedProcess?: (pid: number) => Promise<boolean>;
  /**
   * Bounded wait for the OS to actually free the port after the signals.
   * Test seam; production waits long enough for a dying process to drop its
   * listening socket.
   */
  portReleaseTimeoutMs?: number;
  portReleasePollIntervalMs?: number;
}): Promise<ManagedChromeTermination> {
  const { cdpHttpUrl, userDataDir, logger } = params;
  let cdpPort: number;
  try {
    cdpPort = Number(new URL(cdpHttpUrl).port || 80);
  } catch {
    return { killedPids: [], portReleased: false };
  }
  const reclaimLogger: PortReclaimLogger = {
    info: (message, meta) => logger.warn(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
  };
  const killedPids: number[] = [];
  for (const pid of await findPortOwnerPids(cdpPort)) {
    const owned = params.isManagedProcess
      ? await params.isManagedProcess(pid)
      : await isManagedChromeProcess({ pid, cdpPort, userDataDir });
    if (!owned) {
      logger.warn('skipping CDP port owner: not the managed browser', { pid });
      continue;
    }
    if (await killPortOwner(pid, reclaimLogger)) {
      killedPids.push(pid);
      logger.warn('terminated the managed browser process tree', { pid, cdpPort });
    }
  }
  const portReleased = await waitForCdpPortReleased(cdpHttpUrl, {
    timeoutMs: params.portReleaseTimeoutMs,
    pollIntervalMs: params.portReleasePollIntervalMs,
  });
  return { killedPids, portReleased };
}
