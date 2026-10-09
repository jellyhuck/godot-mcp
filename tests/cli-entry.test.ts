import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
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
