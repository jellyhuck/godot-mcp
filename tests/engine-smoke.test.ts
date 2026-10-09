import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GodotServer } from '../src/index.js';

it.skipIf(!process.env.GODOT_SMOKE_PATH)('creates, edits, reads and saves a scene through the headless engine', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'godot-engine-smoke-'));
  const projectPath = join(workspace, 'project');
  const listeners = process.listeners('SIGINT');
  const instance: any = new GodotServer({ godotPath: process.env.GODOT_SMOKE_PATH });
  const addedListeners = process.listeners('SIGINT').filter(listener => !listeners.includes(listener));
  const client = new Client({ name: 'headless-smoke', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  }
  try {
    const version = await call('get_godot_version', {});
    const match = JSON.stringify(version.content).match(/(\d+\.\d+)\.\d+/);
    expect(match).not.toBeNull();
    await call('create_project', { projectPath, projectName: 'EngineSmoke' });
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain('"' + match![1] + '"');
    await call('create_scene', { projectPath, scenePath: 'main.tscn', rootNodeType: 'Node2D' });
    expect(readFileSync(join(projectPath, 'main.tscn'), 'utf8')).toContain('type="Node2D"');
    await call('add_node', { projectPath, scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'Marker' });
    await call('modify_scene_node', { projectPath, scenePath: 'main.tscn', nodePath: 'Marker', properties: { visible: false } });
    expect(readFileSync(join(projectPath, 'main.tscn'), 'utf8')).toContain('visible = false');
    const scene = await call('read_scene', { projectPath, scenePath: 'main.tscn' });
    expect(JSON.stringify(scene.content)).toContain('Marker');
    await call('save_scene', { projectPath, scenePath: 'main.tscn', newPath: 'saved.tscn' });
    expect(readFileSync(join(projectPath, 'saved.tscn'), 'utf8')).toContain('Marker');
  } finally {
    await client.close();
    await instance.server.close();
    for (const listener of addedListeners) process.removeListener('SIGINT', listener);
    rmSync(workspace, { recursive: true, force: true });
  }
}, 120000);
