/**
 * Drives handleRunProject end to end without a Godot binary: child_process.spawn
 * is mocked to return a FakeChild whose stdout the test feeds, and the game's
 * interaction server is a fake TCP server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GodotServer } from '../src/index.js';
import { FakeChild, FakeGame, announcementLine, startFakeGame, stopFakeGame } from './helpers/fake-game.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

const BASE_PROJECT = '; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name="RunTest"\nrun/main_scene="res://main.tscn"\n';
const CUSTOM_LOOP_PROJECT = BASE_PROJECT + 'run/main_loop_type="MyLoop"\n';
const CUSTOM_LOOP_WITH_AUTOLOAD = CUSTOM_LOOP_PROJECT + '\n[autoload]\n\nMcpInteractionServer="*res://addons/mcp/mcp_interaction_server.gd"\n';

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function parseSuccess(result: any): any {
  expect(result.isError, result.content?.[0]?.text).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

function parseError(result: any): { headline: string; details: any } {
  expect(result.isError).toBe(true);
  const text: string = result.content[0].text;
  const newline = text.indexOf('\n');
  return { headline: text.slice(0, newline), details: JSON.parse(text.slice(newline + 1)) };
}

describe('run_project waits for the game connection', () => {
  let instance: any;
  let workspace: string;
  let projectPath: string;
  let fakes: FakeGame[] = [];
  let sigintListeners: NodeJS.SignalsListener[];

  async function fakeGame(pid: number): Promise<FakeGame> {
    const fake = await startFakeGame({ pid });
    fakes.push(fake);
    return fake;
  }

  function writeProject(content: string) {
    writeFileSync(join(projectPath, 'project.godot'), content);
  }

  function nextChild(pid: number | undefined = 4242): FakeChild {
    const child = new FakeChild(pid);
    spawnMock.mockReturnValueOnce(child);
    return child;
  }

  beforeEach(() => {
    sigintListeners = process.listeners('SIGINT');
    instance = new GodotServer({ godotPath: '/nonexistent/godot' });
    instance.godotPath = '/fake/godot';
    workspace = mkdtempSync(join(tmpdir(), 'godot-run-project-'));
    projectPath = join(workspace, 'project');
    mkdirSync(projectPath);
    writeProject(BASE_PROJECT);
    spawnMock.mockReset();
  });

  afterEach(async () => {
    instance.disconnectFromGame();
    instance.activeProcess = null;
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintListeners.includes(listener)) process.removeListener('SIGINT', listener);
    }
    for (const fake of fakes) await stopFakeGame(fake);
    fakes = [];
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns only once the game announced its port and passed the hello handshake', async () => {
    const fake = await fakeGame(4242);
    const child = nextChild(4242);

    const pending = instance.handleRunProject({ projectPath, scene: 'res://main.tscn' });
    await tick();
    expect(instance.gameConnection.connected).toBe(false);
    child.stdout.write('Godot Engine v4.4\n');
    child.stdout.write(announcementLine(fake.port));
    const info = parseSuccess(await pending);

    expect(info).toMatchObject({
      status: 'connected',
      connected: true,
      awaitedConnection: true,
      pid: 4242,
      port: fake.port,
      projectPath,
      scene: 'res://main.tscn',
      bootstrap: true,
      mainLoopType: null,
      requestedPort: 0,
      connectAttempts: 1,
      timeoutSeconds: 30,
    });
    expect(typeof info.elapsedMs).toBe('number');
    expect(info.output).toContain('Godot Engine v4.4');
    expect(instance.gameConnection.connected).toBe(true);
    expect(instance.gameConnection.port).toBe(fake.port);
    expect(instance.activeProcess.connectState).toBe('connected');
    expect(fake.received.map(l => JSON.parse(l).command)).toEqual(['hello']);

    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('/fake/godot');
    expect(args[0]).toBe('-d');
    expect(args).toContain('--script');
    expect(args).toContain(instance.bootstrapScriptPath);
    expect(opts.env.GODOT_MCP_PORT).toBe('0');
    expect(opts.env.GODOT_MCP_SCENE).toBe('res://main.tscn');
  });

  it('falls back to a pinned port when the game never announces one', async () => {
    const fake = await fakeGame(4242);
    nextChild(4242);

    const info = parseSuccess(await instance.handleRunProject({ projectPath, port: fake.port, timeout: 0.4 }));
    expect(info).toMatchObject({ connected: true, port: fake.port, requestedPort: fake.port });
    expect(info.elapsedMs).toBeGreaterThanOrEqual(350);
  });

  it('fails after the timeout but keeps the game running and tracked', async () => {
    const child = nextChild(4242);

    const { headline, details } = parseError(await instance.handleRunProject({ projectPath, timeout: 0.3 }));
    expect(headline).toContain('did not connect within 0.3s');
    expect(headline).toContain('pid 4242');
    expect(headline).toContain('still running');
    expect(details).toMatchObject({
      status: 'connect-timeout',
      connected: false,
      reason: 'no-port',
      running: true,
      pid: 4242,
      exitCode: null,
      announcedPort: null,
      timeoutSeconds: 0.3,
    });
    expect(child.killed).toBe(false);
    expect(instance.activeProcess).not.toBeNull();
    expect(instance.activeProcess.connectState).toBe('failed');

    const debug = parseSuccess(await instance.handleGetDebugOutput());
    expect(debug).toMatchObject({ pid: 4242, running: true, connected: false, connectState: 'failed', connectReason: 'no-port' });

    const stopped = parseSuccess(await instance.handleStopProject());
    expect(stopped).toMatchObject({ message: 'Godot project stopped', pid: 4242, wasConnected: false });
    expect(child.killed).toBe(true);
    expect(instance.activeProcess).toBeNull();
  });

  it('fails immediately when Godot exits before connecting', async () => {
    const child = nextChild(4242);

    const started = Date.now();
    const pending = instance.handleRunProject({ projectPath, timeout: 10 });
    await tick();
    child.stderr.write('SCRIPT ERROR: Parse Error: boom\n');
    child.exit(1);
    const { headline, details } = parseError(await pending);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(headline).toBe('Godot exited with code 1 before the game connected.');
    expect(details).toMatchObject({ status: 'exited', reason: 'exited', running: false, exitCode: 1, exitSignal: null, pid: 4242 });
    expect(details.errors).toContain('SCRIPT ERROR: Parse Error: boom');
    expect(instance.activeProcess).toBeNull();
    expect(instance.gameConnection.projectPath).toBeNull();
  });

  it('fails immediately when the binary cannot be spawned', async () => {
    const child = new FakeChild(undefined);
    spawnMock.mockReturnValueOnce(child);

    const pending = instance.handleRunProject({ projectPath, timeout: 10 });
    await tick();
    child.failToSpawn('spawn /fake/godot ENOENT');
    const { headline, details } = parseError(await pending);

    expect(headline).toBe('Failed to start Godot: spawn /fake/godot ENOENT');
    expect(details).toMatchObject({ status: 'spawn-error', reason: 'spawn-error', running: false, spawnError: 'spawn /fake/godot ENOENT', pid: null });
    expect(instance.activeProcess).toBeNull();
  });

  it('returns right away for a custom main loop project without the autoload', async () => {
    writeProject(CUSTOM_LOOP_PROJECT);
    nextChild(4242);

    const info = parseSuccess(await instance.handleRunProject({ projectPath, scene: 'res://main.tscn', timeout: 10 }));
    expect(info).toMatchObject({
      status: 'started',
      connected: false,
      awaitedConnection: false,
      reason: 'custom-main-loop-without-autoload',
      pid: 4242,
      bootstrap: false,
      mainLoopType: 'MyLoop',
      port: null,
    });
    expect(info.elapsedMs).toBeLessThan(1000);
    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).not.toContain('--script');
    expect(args[args.length - 1]).toBe('res://main.tscn');
    expect(instance.activeProcess.connectState).toBe('skipped');
    expect(instance.gameConnection.projectPath).toBe(projectPath);
  });

  it('awaits the connection for a custom main loop project that registers the autoload', async () => {
    writeProject(CUSTOM_LOOP_WITH_AUTOLOAD);
    const fake = await fakeGame(4242);
    const child = nextChild(4242);

    const pending = instance.handleRunProject({ projectPath });
    await tick();
    child.stdout.write(announcementLine(fake.port));
    const info = parseSuccess(await pending);

    expect(info).toMatchObject({ connected: true, awaitedConnection: true, bootstrap: false, mainLoopType: 'MyLoop', port: fake.port });
    expect(spawnMock.mock.calls[0][1]).not.toContain('--script');
  });

  it('resolves a pending run as superseded when another run_project replaces it', async () => {
    const first = nextChild(1001);
    const firstPending = instance.handleRunProject({ projectPath, timeout: 5 });
    await tick();

    const fake = await fakeGame(1002);
    const second = nextChild(1002);
    const secondPending = instance.handleRunProject({ projectPath });
    await tick();
    second.stdout.write(announcementLine(fake.port));

    const { details } = parseError(await firstPending);
    expect(details).toMatchObject({ status: 'superseded', reason: 'superseded', running: false, pid: 1001 });
    expect(first.killed).toBe(true);

    const info = parseSuccess(await secondPending);
    expect(info).toMatchObject({ connected: true, pid: 1002, port: fake.port });
    expect(instance.gameConnection.port).toBe(fake.port);
    expect(instance.activeProcess.process).toBe(second);
  });

  it('resolves a pending run as superseded when stop_project is called first', async () => {
    const child = nextChild(4242);
    const pending = instance.handleRunProject({ projectPath, timeout: 5 });
    await tick();

    parseSuccess(await instance.handleStopProject());
    const { headline, details } = parseError(await pending);
    expect(headline).toBe('Godot process was stopped or replaced before the game connected.');
    expect(details.status).toBe('superseded');
    expect(child.killed).toBe(true);
  });

  it('reports a failed handshake and leaves the game tracked', async () => {
    const fake = await fakeGame(1);
    const child = nextChild(4242);

    const pending = instance.handleRunProject({ projectPath });
    await tick();
    child.stdout.write(announcementLine(fake.port));
    const { headline, details } = parseError(await pending);

    expect(headline).toContain('Game connection failed');
    expect(details).toMatchObject({ status: 'connect-failed', reason: 'handshake-failed', running: true, announcedPort: fake.port });
    expect(instance.gameConnection.connected).toBe(false);
    expect(instance.activeProcess).not.toBeNull();
    expect(child.killed).toBe(false);
  });

  it('rejects invalid timeout values before spawning', async () => {
    for (const timeout of [0, -1, 'abc', 4000]) {
      const result = await instance.handleRunProject({ projectPath, timeout });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid timeout');
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('honours the connectTimeoutMs server option as the default budget', async () => {
    const quick: any = new GodotServer({ godotPath: '/nonexistent/godot', connectTimeoutMs: 200 });
    quick.godotPath = '/fake/godot';
    try {
      nextChild(4242);
      const { details } = parseError(await quick.handleRunProject({ projectPath }));
      expect(details).toMatchObject({ status: 'connect-timeout', timeoutSeconds: 0.2 });
    } finally {
      quick.disconnectFromGame();
      quick.activeProcess = null;
    }
  });
});
