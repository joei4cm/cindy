// Verifies the managed browser's process identity proof and the OS-level tree
// teardown that reclaims a CDP port from a survivor the graceful close could
// not stop. The decisive property: a candidate is only ever signalled when
// the OS proves it is the managed browser, so an unrelated browser is never
// killed by this path.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findPortOwnerPids, killPortOwner } = vi.hoisted(() => ({
  findPortOwnerPids: vi.fn<(port: number) => Promise<number[]>>(),
  killPortOwner: vi.fn<(pid: number, logger?: unknown) => Promise<boolean>>(),
}));

vi.mock('../../../cindy-brain/portReclaim.js', () => ({
  findPortOwnerPids: (port: number) => findPortOwnerPids(port),
  killPortOwner: (pid: number, logger?: unknown) => killPortOwner(pid, logger),
}));

import {
  commandLineHasExactArgument,
  readWindowsProcessCommandLine,
  terminateManagedChromeProcessTree,
  type ManagedChromeCommandRunner,
} from '../managed-chrome-process.js';

const servers: Server[] = [];

beforeEach(() => {
  findPortOwnerPids.mockResolvedValue([]);
  killPortOwner.mockResolvedValue(true);
});

afterEach(async () => {
  vi.clearAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A loopback port that is still held by a live listener. */
async function heldPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

/** A loopback port nothing listens on. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('commandLineHasExactArgument', () => {
  const dir = '/Users/me/Library/Application Support/Cindy/browser/Cindy';

  it('rejects a value the expected one is merely a prefix of', () => {
    // The reason this cannot be `includes`: the result feeds a process kill, so
    // matching `<dir>-backup` would terminate an unrelated browser and its tree.
    expect(commandLineHasExactArgument(
      `chrome --user-data-dir=${dir}-backup --remote-debugging-port=18800`,
      `--user-data-dir=${dir}`,
    )).toBe(false);
    expect(commandLineHasExactArgument(
      'chrome --remote-debugging-port=188000',
      '--remote-debugging-port=18800',
    )).toBe(false);
  });

  it('accepts the argument when it stands as its own token', () => {
    for (const line of [
      `chrome --user-data-dir=${dir} --remote-debugging-port=18800`,
      `chrome "--user-data-dir=${dir}" --headless`,
      `--user-data-dir=${dir}`,
    ]) {
      expect(commandLineHasExactArgument(line, `--user-data-dir=${dir}`), line).toBe(true);
    }
  });

  it('accepts a Unicode profile path as its own token', () => {
    // Windows profiles may live under non-ASCII paths; the exact-argument
    // proof must still recognise them so the tree kill is not skipped.
    const unicodeDir = 'C:\\用户\\Cindy 数据\\user-data';
    expect(commandLineHasExactArgument(
      `chrome --user-data-dir=${unicodeDir} --remote-debugging-port=18800`,
      `--user-data-dir=${unicodeDir}`,
    )).toBe(true);
    expect(commandLineHasExactArgument(
      `chrome --user-data-dir=${unicodeDir}-backup --remote-debugging-port=18800`,
      `--user-data-dir=${unicodeDir}`,
    )).toBe(false);
  });
});

describe('readWindowsProcessCommandLine', () => {
  it('pins the PowerShell console to UTF-8 so Unicode profile paths survive identity matching', async () => {
    // OutputEncoding is the encoding the console WRITES with. Without the pin,
    // a non-UTF-8 system code page mojibakes the profile path, the exact
    // identity comparison fails, and taskkill /T /F never runs for that user.
    const unicodeDir = 'C:\\用户\\Cindy 数据\\user-data';
    const runCommand = vi.fn<ManagedChromeCommandRunner>(async () => ({
      stdout: `chrome.exe --user-data-dir=${unicodeDir} --remote-debugging-port=18800\r\n`,
    }));
    const commandLine = await readWindowsProcessCommandLine(4321, runCommand);
    expect(commandLine).toContain(`--user-data-dir=${unicodeDir}`);
    const script = runCommand.mock.calls[0]?.[1].join(' ') ?? '';
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)');
    // The full proof this decode feeds: both exact arguments still match.
    expect(commandLineHasExactArgument(
      commandLine!,
      `--user-data-dir=${unicodeDir}`,
    )).toBe(true);
    expect(commandLineHasExactArgument(
      commandLine!,
      '--remote-debugging-port=18800',
    )).toBe(true);
  });

  it('returns null when the query fails so callers never signal an unproven pid', async () => {
    const runCommand = vi.fn<ManagedChromeCommandRunner>(async () => {
      throw new Error('query failed');
    });
    await expect(readWindowsProcessCommandLine(4321, runCommand)).resolves.toBeNull();
  });
});

describe('terminateManagedChromeProcessTree', () => {
  const logger = { warn: vi.fn() };
  const userDataDir = '/managed/browser/Cindy/user-data';

  it('never signals a port owner the OS cannot prove is the managed browser', async () => {
    // Anything can hold a fixed port once Chrome exits, so a candidate whose
    // identity cannot be proven must be left running — and the port staying
    // bound is what keeps the caller fail-closed. The zero budget skips the
    // release wait: this port is never going to be freed.
    findPortOwnerPids.mockResolvedValue([4242]);
    const port = await heldPort();

    const result = await terminateManagedChromeProcessTree({
      cdpHttpUrl: `http://127.0.0.1:${port}`,
      userDataDir,
      logger,
      isManagedProcess: async () => false,
      portReleaseTimeoutMs: 0,
    });

    expect(killPortOwner).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.portReleased).toBe(false);
  });

  it('kills the proven managed browser and reports the port released', async () => {
    findPortOwnerPids.mockResolvedValue([4242]);
    const port = await freePort();

    const result = await terminateManagedChromeProcessTree({
      cdpHttpUrl: `http://127.0.0.1:${port}`,
      userDataDir,
      logger,
      isManagedProcess: async (pid) => pid === 4242,
    });

    expect(killPortOwner).toHaveBeenCalledWith(4242, expect.anything());
    expect(result.killedPids).toEqual([4242]);
    expect(result.portReleased).toBe(true);
  });

  it('reports the port as still held when the kill could not free it', async () => {
    // The kill was issued but the survivor kept the port: the caller must not
    // read the teardown as a clean exit. The zero budget skips the wait so the
    // suite does not sit out the production timeout on a port that never frees.
    findPortOwnerPids.mockResolvedValue([4242]);
    const port = await heldPort();

    const result = await terminateManagedChromeProcessTree({
      cdpHttpUrl: `http://127.0.0.1:${port}`,
      userDataDir,
      logger,
      isManagedProcess: async () => true,
      portReleaseTimeoutMs: 0,
    });

    expect(killPortOwner).toHaveBeenCalledTimes(1);
    expect(result.killedPids).toEqual([4242]);
    expect(result.portReleased).toBe(false);
  });

  it('waits for the port to be released instead of probing once', async () => {
    // A delivered signal is not an exit: the process can drop its listening
    // socket a moment after `kill` returns. Probing once right after the signal
    // would call that a failure, and the caller would keep the route
    // hard-blocked over a browser that did exit — the user would have to stop a
    // second time. The listener drops its socket as soon as a probe finds it,
    // so the first probe always reports "still listening" and only a second
    // look can see the release. The 10ms poll interval keeps the wait real but
    // far below the suite's no-long-wait budget.
    findPortOwnerPids.mockResolvedValue([4242]);
    const server = createServer();
    server.on('connection', () => server.close());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const result = await terminateManagedChromeProcessTree({
      cdpHttpUrl: `http://127.0.0.1:${port}`,
      userDataDir,
      logger,
      isManagedProcess: async () => true,
      portReleaseTimeoutMs: 1_000,
      portReleasePollIntervalMs: 10,
    });

    expect(result.killedPids).toEqual([4242]);
    expect(result.portReleased).toBe(true);
  });
});
