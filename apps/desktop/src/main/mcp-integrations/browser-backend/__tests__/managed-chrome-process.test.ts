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
  terminateManagedChromeProcessTree,
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
});

describe('terminateManagedChromeProcessTree', () => {
  const logger = { warn: vi.fn() };
  const userDataDir = '/managed/browser/Cindy/user-data';

  it('never signals a port owner the OS cannot prove is the managed browser', async () => {
    // Anything can hold a fixed port once Chrome exits, so a candidate whose
    // identity cannot be proven must be left running — and the port staying
    // bound is what keeps the caller fail-closed.
    findPortOwnerPids.mockResolvedValue([4242]);
    const port = await heldPort();

    const result = await terminateManagedChromeProcessTree({
      cdpHttpUrl: `http://127.0.0.1:${port}`,
      userDataDir,
      logger,
      isManagedProcess: async () => false,
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
    // read the teardown as a clean exit.
    findPortOwnerPids.mockResolvedValue([4242]);
    const port = await heldPort();

    const result = await terminateManagedChromeProcessTree({
      cdpHttpUrl: `http://127.0.0.1:${port}`,
      userDataDir,
      logger,
      isManagedProcess: async () => true,
    });

    expect(killPortOwner).toHaveBeenCalledTimes(1);
    expect(result.killedPids).toEqual([4242]);
    expect(result.portReleased).toBe(false);
  });
});
