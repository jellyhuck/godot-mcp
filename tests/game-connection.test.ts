/**
 * Exercises the run_project -> interaction server connection flow against a
 * fake game: a local TCP server that behaves like mcp_interaction_server.gd.
 * No Godot binary is needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GodotServer } from '../src/index.js';
import { FakeGame, startFakeGame, stopFakeGame } from './helpers/fake-game.js';

function makeProc(instance: any, pid: number, announcedPort: number | null, requestedPort: number) {
  const proc = {
    process: { pid, kill() {} },
    output: [],
    errors: [],
    outputOffset: 0,
    errorOffset: 0,
    requestedInteractionPort: requestedPort,
    interactionPort: announcedPort,
  };
  instance.activeProcess = proc;
  return proc;
}

describe('game interaction connection', () => {
  let instance: any;
  let fake: FakeGame | null = null;
  let sigintListeners: NodeJS.SignalsListener[];

  beforeEach(() => {
    sigintListeners = process.listeners('SIGINT');
    instance = new GodotServer({ godotPath: '/nonexistent/godot' });
    // Shorten the announcement wait so the fallback path is testable
    instance.PORT_ANNOUNCEMENT_TIMEOUT_MS = 300;
  });

  afterEach(async () => {
    instance.disconnectFromGame();
    instance.activeProcess = null;
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintListeners.includes(listener)) process.removeListener('SIGINT', listener);
    }
    await stopFakeGame(fake);
    fake = null;
  });

  it('connects to the port announced by the game and verifies the pid', async () => {
    fake = await startFakeGame({ pid: 4242 });
    const proc = makeProc(instance, 4242, fake.port, 0);
    const result = await instance.connectToGame('/fake/project', proc);
    expect(result).toMatchObject({ connected: true, port: fake.port, attempts: 1 });
    expect(instance.gameConnection.connected).toBe(true);
    expect(instance.gameConnection.port).toBe(fake.port);
    expect(fake.received.map(l => JSON.parse(l).command)).toEqual(['hello']);
    expect(proc).toMatchObject({ connectState: 'connected', connectReason: null });
  });

  it('drops the connection when the game belongs to another process', async () => {
    fake = await startFakeGame({ pid: 1 });
    const proc = makeProc(instance, 4242, fake.port, 0);
    const result = await instance.connectToGame('/fake/project', proc);
    expect(result).toMatchObject({ connected: false, reason: 'handshake-failed', port: fake.port });
    expect(instance.gameConnection.connected).toBe(false);
    expect(instance.gameConnection.socket).toBeNull();
    expect(instance.gameConnection.port).toBeNull();
    expect(proc).toMatchObject({ connectState: 'failed', connectReason: 'handshake-failed' });
  });

  it('accepts an interaction server that predates the hello command', async () => {
    fake = await startFakeGame('unknown-command');
    const proc = makeProc(instance, 4242, fake.port, 0);
    const result = await instance.connectToGame('/fake/project', proc);
    expect(result.connected).toBe(true);
    expect(instance.gameConnection.connected).toBe(true);
  });

  it('falls back to the requested fixed port when nothing is announced', async () => {
    fake = await startFakeGame({ pid: 4242 });
    const proc = makeProc(instance, 4242, null, fake.port);
    const result = await instance.connectToGame('/fake/project', proc);
    expect(result).toMatchObject({ connected: true, port: fake.port });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(instance.gameConnection.connected).toBe(true);
    expect(instance.gameConnection.port).toBe(fake.port);
  });

  it('gives up without connecting when an ephemeral port is never announced', async () => {
    fake = await startFakeGame({ pid: 4242 });
    const proc = makeProc(instance, 4242, null, 0);
    const result = await instance.connectToGame('/fake/project', proc);
    expect(result).toMatchObject({ connected: false, reason: 'no-port', port: null, attempts: 0 });
    expect(instance.gameConnection.connected).toBe(false);
    expect(fake.received).toHaveLength(0);
  });

  it('reports an unreachable server when nothing listens on the announced port', async () => {
    fake = await startFakeGame({ pid: 4242 });
    const closedPort = fake.port;
    await stopFakeGame(fake);
    fake = null;
    const proc = makeProc(instance, 4242, closedPort, 0);
    const result = await instance.connectToGame('/fake/project', proc, Date.now() + 1200);
    expect(result).toMatchObject({ connected: false, reason: 'unreachable', port: closedPort });
    expect(result.attempts).toBeGreaterThanOrEqual(2);
    expect(instance.gameConnection.connected).toBe(false);
  });

  it('aborts when the game exits before announcing a port', async () => {
    const proc = makeProc(instance, 4242, null, 0);
    const pending = instance.connectToGame('/fake/project', proc);
    instance.activeProcess = null;
    const result = await pending;
    expect(result).toMatchObject({ connected: false, reason: 'superseded' });
    expect(instance.gameConnection.connected).toBe(false);
  });

  it('wakes up as soon as a tracked process exits', async () => {
    let settle: (value: unknown) => void = () => {};
    const proc: any = makeProc(instance, 4242, null, 0);
    proc.exit = new Promise(resolve => {
      settle = resolve;
    });
    proc.portAnnounced = new Promise(() => {});
    const started = Date.now();
    const pending = instance.connectToGame('/fake/project', proc, Date.now() + 10000);
    setTimeout(() => {
      proc.exited = true;
      proc.exitCode = 3;
      settle({ code: 3, signal: null });
    }, 50);
    const result = await pending;
    expect(result).toMatchObject({ connected: false, reason: 'exited' });
    expect(result.message).toContain('code 3');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
