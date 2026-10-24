/**
 * Test doubles for the run_project launch flow: a fake in-game interaction
 * server (a TCP server behaving like mcp_interaction_server.gd) and a fake
 * child process standing in for the spawned Godot binary.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { createServer, Server, Socket } from 'net';
import { AddressInfo } from 'net';

export type HelloBehaviour = { pid: number } | 'unknown-command' | 'silent';

export interface FakeGame {
  server: Server;
  port: number;
  received: string[];
}

export function startFakeGame(behaviour: HelloBehaviour): Promise<FakeGame> {
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

export function stopFakeGame(fake: FakeGame | null): Promise<void> {
  if (!fake) return Promise.resolve();
  return new Promise(resolve => fake.server.close(() => resolve()));
}

/** The line mcp_interaction_server.gd prints once it is listening. */
export function announcementLine(port: number): string {
  return `McpInteractionServer: Listening on 127.0.0.1:${port}\n`;
}

/**
 * Minimal stand-in for the ChildProcess returned by child_process.spawn:
 * stdout/stderr streams the test writes to, plus manual exit/error events.
 */
export class FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | undefined;

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
    setImmediate(() => this.emit('exit', null, this.killSignal));
    return true;
  }

  /** Simulate the game exiting on its own. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }

  /** Simulate a spawn failure such as ENOENT. */
  failToSpawn(message = 'spawn ENOENT'): void {
    this.emit('error', Object.assign(new Error(message), { code: 'ENOENT' }));
  }
}
