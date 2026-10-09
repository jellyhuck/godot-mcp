import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('initializes the stdio server when its executable is reached through a directory alias', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'godot-cli-entry-'));
  const alias = join(directory, 'entry');
  const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
  symlinkSync(build, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(alias, 'index.js')],
    env: { GODOT_PATH: process.execPath },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'cli-entry-regression', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(157);
    expect(tools.some(tool => tool.name === 'read_file')).toBe(true);
  } finally {
    await client.close();
    unlinkSync(alias);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it('keeps library imports safe when the entry argument is absent or unresolvable', async () => {
  const entry = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'index.js')).href;
  const execute = promisify(execFile);
  for (const argument of [undefined, join(tmpdir(), 'godot-mcp-missing-entry.js')]) {
    const assign = argument === undefined ? 'delete process.argv[1]' : 'process.argv[1] = ' + JSON.stringify(argument);
    const code = assign + '; await import(' + JSON.stringify(entry) + '); process.stdout.write("imported");';
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000 });
    expect(stdout).toBe('imported');
  }
}, 15000);
