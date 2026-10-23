import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appendBoundedLines, readLogPage } from '../src/logs.js';
import { isPathWithinAllowedRoots, validateEngineArgs, validateToolPaths, validateUserArgs, validateWriteMoviePath } from '../src/security.js';

describe('MCP filesystem boundaries', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'godot-mcp-test-'));
  const allowed = join(workspace, 'allowed');
  const outside = join(workspace, 'allowed-sibling');
  const project = join(allowed, 'project');
  const client = new Client({ name: 'regression-tests', version: '1.0.0' });
  let instance: any;
  let addedListeners: NodeJS.SignalsListener[];

  beforeAll(async () => {
    mkdirSync(project, { recursive: true });
    mkdirSync(outside, { recursive: true });
    for (const directory of [project, outside]) {
      writeFileSync(join(directory, 'project.godot'), 'config_version=5\n');
      writeFileSync(join(directory, 'secret.txt'), 'original');
    }
    symlinkSync(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    vi.stubEnv('GODOT_MCP_ALLOWED_DIRS', allowed);
    const { GodotServer } = await import('../src/index.js');
    const listeners = process.listeners('SIGINT');
    instance = new GodotServer();
    addedListeners = process.listeners('SIGINT').filter(listener => !listeners.includes(listener));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await instance?.server.close();
    for (const listener of addedListeners || []) process.removeListener('SIGINT', listener);
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  });

  it.each(['read_file', 'write_file', 'delete_file', 'create_directory', 'launch_editor', 'create_project', 'read_scene', 'create_scene', 'manage_plugins', 'set_main_scene'])('rejects an outside project for %s before side effects', async name => {
    const result = await client.callTool({ name, arguments: { project_path: outside, filePath: 'secret.txt', content: 'changed', directoryPath: 'new', scenePath: 'main.tscn', projectName: 'test', action: 'list' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('outside the allowed roots');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('original');
  });

  it('allows valid file reads within the project', async () => {
    const result = await client.callTool({ name: 'read_file', arguments: { projectPath: project, filePath: 'secret.txt' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('original');
  });

  it('rejects symbolic-link escape including new files under it', async () => {
    for (const filePath of ['escape/secret.txt', 'escape/new/nested.txt']) {
      const result = await client.callTool({ name: 'write_file', arguments: { projectPath: project, filePath, content: 'changed' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('outside the project directory');
    }
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('original');
  });

  it('rejects traversal and outside discovery/export roots', async () => {
    expect(validateToolPaths({ projectPath: project, filePath: '../secret.txt' }, [allowed])).toContain('outside the project');
    expect(validateToolPaths({ projectPath: project, outputPath: outside }, [allowed])).toContain('outside the allowed roots');
    expect(isPathWithinAllowedRoots(outside, [allowed])).toBe(false);
    const result = await client.callTool({ name: 'list_projects', arguments: { directory: outside } });
    expect(result.isError).toBe(true);
  });

  it('checks normalized path aliases and script path arrays', async () => {
    const requests = [
      { name: 'write_file', arguments: { project_path: project, file_path: 'escape/secret.txt', content: 'changed' } },
      { name: 'validate_scripts', arguments: { project_path: project, script_paths: [join(outside, 'script.gd')] } },
      { name: 'export_project', arguments: { project_path: project, output_path: join(outside, 'export.exe'), preset_name: 'Windows' } }
    ];
    for (const request of requests) {
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('outside');
    }
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('original');
  });

  it('rejects run_project engine flags that escape the project before side effects', async () => {
    for (const engine_args of [['--path', outside], ['--main-pack', join(outside, 'game.pck')], [join(outside, 'project.godot')], ['--write-movie', join(outside, 'run.avi')], ['--write-movie', '../../allowed-sibling/run.avi'], ['--write-movie', 'res://escape/run.avi'], ['--write-movie', 'user://run.avi']]) {
      const result = await client.callTool({ name: 'run_project', arguments: { project_path: project, engine_args } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('engineArgs');
    }
    expect(existsSync(join(outside, 'run.avi'))).toBe(false);
    expect(existsSync(join(project, 'mcp_interaction_server.gd'))).toBe(false);
    expect(readFileSync(join(project, 'project.godot'), 'utf8')).toBe('config_version=5\n');
  });

  it('provides items for every array in every advertised schema', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(157);
    function visit(schema: any) {
      if (!schema || typeof schema !== 'object') return;
      if (schema.type === 'array') expect(schema.items).toBeDefined();
      for (const value of Object.values(schema)) visit(value);
    }
    for (const tool of tools) visit(tool.inputSchema);
  });

  it('propagates the detected engine version to new project feature flags', async () => {
    const version = vi.spyOn(instance, 'detectGodotNetSdkVersion').mockResolvedValue('4.7.0');
    const destination = join(allowed, 'scaffold');
    const result = await client.callTool({ name: 'create_project', arguments: { projectPath: destination, projectName: 'Scaffold', dotnet: true } });
    expect(result.isError).not.toBe(true);
    expect(readFileSync(join(destination, 'project.godot'), 'utf8')).toContain('PackedStringArray("4.7", "C#")');
    expect(readFileSync(join(destination, 'Scaffold.csproj'), 'utf8')).toContain('Godot.NET.Sdk/4.7.0');
    version.mockRestore();
  });

  it('returns independent cursor pages through the actual log handler', async () => {
    instance.activeProcess = { output: ['one', 'two', 'three'], errors: [], outputOffset: 10, errorOffset: 0, process: { kill: () => {} } };
    const first: any = await client.callTool({ name: 'game_get_logs', arguments: { cursor: 0, limit: 2 } });
    const firstPage = JSON.parse(first.content[0].text);
    expect(firstPage).toMatchObject({ logs: ['one', 'two'], nextCursor: 12, dropped: true, hasMore: true });
    const second: any = await client.callTool({ name: 'game_get_logs', arguments: { cursor: firstPage.nextCursor, limit: 2 } });
    expect(JSON.parse(second.content[0].text)).toMatchObject({ logs: ['three'], nextCursor: 13, hasMore: false });
    instance.activeProcess = null;
  });
});

describe('bounded runtime logs', () => {
  it('retains the newest lines and bounds individual line size', () => {
    const buffer = ['old'];
    expect(appendBoundedLines(buffer, ['x'.repeat(10000), 'latest'], 2)).toBe(1);
    expect(buffer[0]).toHaveLength(4096);
    expect(buffer[1]).toBe('latest');
  });

  it('rejects invalid cursors and page sizes', () => {
    expect(() => readLogPage([], 0, -1)).toThrow('cursor');
    expect(() => readLogPage([], 0, 0, 501)).toThrow('limit');
  });
});

describe('run_project argument validation', () => {
  it('accepts allowlisted engine flags with and without values', () => {
    expect(validateEngineArgs(undefined)).toBeNull();
    expect(validateEngineArgs([])).toBeNull();
    expect(validateEngineArgs(['--verbose', '--headless', '-w', '--resolution', '1280x720', '--rendering-method', 'gl_compatibility'])).toBeNull();
  });

  it('rejects flags that change the project, run mode or write files', () => {
    for (const flag of ['--path', '--main-pack', '--script', '-s', '-e', '--editor', '--log-file', '--export-release', '--remote-fs']) {
      expect(validateEngineArgs([flag, 'value'])).toContain('not allowed');
    }
  });

  describe('--write-movie', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'godot-mcp-movie-'));
    const allowed = join(workspace, 'allowed');
    const outside = join(workspace, 'allowed-sibling');
    const project = join(allowed, 'project');
    beforeAll(() => {
      mkdirSync(project, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    });
    afterAll(() => rmSync(workspace, { recursive: true, force: true }));

    it('accepts movie files inside the allowed roots', () => {
      for (const value of ['run.avi', 'recordings/frames.PNG', 'res://run.avi', join(project, 'run.avi'), join(allowed, 'other', 'run.avi')]) {
        expect(validateEngineArgs(['--write-movie', value, '--fixed-fps', '60'], project, [allowed])).toBeNull();
      }
      expect(validateEngineArgs(['--write-movie', join(outside, 'run.avi')], project, [])).toBeNull();
    });

    it('rejects movie files outside the allowed roots, including traversal and symlinks', () => {
      for (const value of [join(outside, 'run.avi'), '../../allowed-sibling/run.avi', 'res://../../allowed-sibling/run.avi', 'escape/run.avi', 'res://escape/run.avi']) {
        expect(validateEngineArgs(['--write-movie', value], project, [allowed])).toContain('outside the allowed roots');
      }
    });

    it('rejects non-file, unsupported and non-filesystem movie paths', () => {
      expect(validateEngineArgs(['--write-movie'], project, [allowed])).toContain('requires a value');
      expect(validateEngineArgs(['--write-movie', '--verbose'], project, [allowed])).toContain('requires a file path');
      expect(validateEngineArgs(['--write-movie', ''], project, [allowed])).toContain('requires a file path');
      expect(validateEngineArgs(['--write-movie', 'res://'], project, [allowed])).toContain('must name a file');
      expect(validateEngineArgs(['--write-movie', 'recordings/'], project, [allowed])).toContain('must name a file');
      expect(validateEngineArgs(['--write-movie', 'run.mp4'], project, [allowed])).toContain('must end with .avi or .png');
      expect(validateEngineArgs(['--write-movie', 'run'], project, [allowed])).toContain('must end with .avi or .png');
      expect(validateEngineArgs(['--write-movie', 'user://run.avi'], project, [allowed])).toContain('filesystem or res://');
      expect(validateEngineArgs(['--write-movie', 'file:///tmp/run.avi'], project, [allowed])).toContain('filesystem or res://');
      expect(validateEngineArgs(['--write-movie', 'run.avi'])).toContain('requires a project path');
      expect(validateWriteMoviePath('run.avi', project, [outside])).toContain('outside the allowed roots');
    });
  });

  it('rejects positional arguments, inline values and missing values', () => {
    expect(validateEngineArgs(['other/project.godot'])).toContain('positional');
    expect(validateEngineArgs(['--resolution', '1x1', 'res://main.tscn'])).toContain('positional');
    expect(validateEngineArgs(['--resolution=1x1'])).toContain('not allowed');
    expect(validateEngineArgs(['--resolution'])).toContain('requires a value');
  });

  it('rejects non-string engine arguments', () => {
    expect(validateEngineArgs('--verbose')).toContain('array of strings');
    expect(validateEngineArgs(['--verbose', 1])).toContain('array of strings');
  });

  it('accepts any strings as user arguments', () => {
    expect(validateUserArgs(undefined)).toBeNull();
    expect(validateUserArgs(['--path', '/elsewhere', 'level=2'])).toBeNull();
    expect(validateUserArgs('--level')).toContain('array of strings');
    expect(validateUserArgs([null])).toContain('array of strings');
  });
});
