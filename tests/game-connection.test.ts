/**
 * Exercises the run_project -> interaction server connection flow against a
 * fake game: a local TCP server that behaves like mcp_interaction_server.gd.
 * No Godot binary is needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server, Socket } from 'net';
import { AddressInfo } from 'net';
import { GodotServer } from '../src/index.js';

type HelloBehaviour = { pid: number } | 'unknown-command' | 'silent';

function startFakeGame(behaviour: HelloBehaviour): Promise<{ server: Server; port: number; received: string[] }> {
  return new Promise(resolve => {
    const received: string[] = [];
    const server = createServer((socket: Socket) => {
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          received.push(line);
          const req = JSON.parse(line);
          if (behaviour === 'silent') continue;
          const reply = behaviour === 'unknown-command'
            ? { error: `Unknown command: ${req.command}`, id: req.id }
            : { success: true, pid: behaviour.pid, port: (server.address() as AddressInfo).port, id: req.id };
          socket.write(JSON.stringify(reply) + '\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, received });
    });
  });
}

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
  let fake: { server: Server; port: number; received: string[] } | null = null;
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
    if (fake) {
      await new Promise(resolve => fake!.server.close(resolve));
      fake = null;
    }
  });

  it('connects to the port announced by the game and verifies the pid', async () => {
    fake = await startFakeGame({ pid: 4242 });
    const proc = makeProc(instance, 4242, fake.port, 0);
    await instance.connectToGame('/fake/project', proc);
    expect(instance.gameConnection.connected).toBe(true);
    expect(instance.gameConnection.port).toBe(fake.port);
    expect(fake.received.map(l => JSON.parse(l).command)).toEqual(['hello']);
  });

  it('drops the connection when the game belongs to another process', async () => {
    fake = await startFakeGame({ pid: 1 });
    const proc = makeProc(instance, 4242, fake.port, 0);
    await instance.connectToGame('/fake/project', proc);
    expect(instance.gameConnection.connected).toBe(false);
    expect(instance.gameConnection.socket).toBeNull();
    expect(instance.gameConnection.port).toBeNull();
  });

  it('accepts an interaction server that predates the hello command', async () => {
    fake = await startFakeGame('unknown-command');
    const proc = makeProc(instance, 4242, fake.port, 0);
    await instance.connectToGame('/fake/project', proc);
    expect(instance.gameConnection.connected).toBe(true);
  });

  it('falls back to the requested fixed port when nothing is announced', async () => {
    fake = await startFakeGame({ pid: 4242 });
    const proc = makeProc(instance, 4242, null, fake.port);
    await instance.connectToGame('/fake/project', proc);
    expect(instance.gameConnection.connected).toBe(true);
    expect(instance.gameConnection.port).toBe(fake.port);
  });

  it('gives up without connecting when an ephemeral port is never announced', async () => {
    fake = await startFakeGame({ pid: 4242 });
    const proc = makeProc(instance, 4242, null, 0);
    await instance.connectToGame('/fake/project', proc);
    expect(instance.gameConnection.connected).toBe(false);
    expect(fake.received).toHaveLength(0);
  });

  it('aborts when the game exits before announcing a port', async () => {
    const proc = makeProc(instance, 4242, null, 0);
    const pending = instance.connectToGame('/fake/project', proc);
    instance.activeProcess = null;
    await pending;
    expect(instance.gameConnection.connected).toBe(false);
  });
});
