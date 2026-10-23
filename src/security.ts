import { existsSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

export function canonicalPath(target: string): string {
  let ancestor = resolve(target);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}

export function isPathWithinRoot(target: string, root: string): boolean {
  const location = relative(canonicalPath(root), canonicalPath(target));
  return location === '' || (location !== '..' && !location.startsWith('..' + sep) && !isAbsolute(location));
}

export function isPathWithinAllowedRoots(target: string, roots: string[]): boolean {
  return roots.length === 0 || roots.some(root => isPathWithinRoot(target, root));
}

export function validateToolPaths(args: Record<string, unknown>, roots: string[]): string | null {
  for (const key of ['projectPath', 'directory']) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== 'string' || !args[key]) return `Invalid ${key}.`;
    if (!isPathWithinAllowedRoots(args[key] as string, roots)) return `${key} is outside the allowed roots (GODOT_MCP_ALLOWED_DIRS).`;
  }
  if (typeof args.projectPath !== 'string') return null;
  const projectPath = args.projectPath;
  const keys = ['filePath', 'newPath', 'directoryPath', 'scriptPath', 'resourcePath', 'texturePath', 'scenePath', 'shaderPath', 'translationPath', 'scene', 'subdirectory'];
  for (const key of keys) {
    if (args[key] === undefined || args[key] === '') continue;
    if (typeof args[key] !== 'string') return `Invalid ${key}.`;
    const target = resolve(projectPath, (args[key] as string).replace(/^res:\/\//, ''));
    if (!isPathWithinRoot(target, projectPath)) return `${key} is outside the project directory.`;
  }
  if (args.outputPath !== undefined) {
    if (typeof args.outputPath !== 'string') return 'Invalid outputPath.';
    if (!isPathWithinAllowedRoots(resolve(projectPath, args.outputPath.replace(/^res:\/\//, '')), roots)) return 'outputPath is outside the allowed roots (GODOT_MCP_ALLOWED_DIRS).';
  }
  if (Array.isArray(args.scriptPaths)) {
    for (const scriptPath of args.scriptPaths) {
      if (typeof scriptPath !== 'string' || !isPathWithinRoot(resolve(projectPath, scriptPath.replace(/^res:\/\//, '')), projectPath)) return 'scriptPaths contains a path outside the project directory.';
    }
  }
  return null;
}

// Godot engine flags allowed in run_project's engineArgs, mapped to whether they take a value.
// Anything not listed (--path, --main-pack, --script, -e, --log-file, --write-movie, ...) is
// rejected so callers cannot change the project, run mode or write files outside allowed roots.
const ALLOWED_ENGINE_FLAGS = new Map<string, boolean>([
  ['-v', false], ['--verbose', false], ['-q', false], ['--quiet', false], ['--no-header', false],
  ['--headless', false], ['-f', false], ['--fullscreen', false], ['-m', false], ['--maximized', false],
  ['-w', false], ['--windowed', false], ['-t', false], ['--always-on-top', false], ['--single-window', false],
  ['--disable-vsync', false], ['--print-fps', false], ['--debug-collisions', false], ['--debug-paths', false],
  ['--debug-navigation', false], ['--debug-avoidance', false], ['--debug-stringnames', false],
  ['--debug-canvas-item-redraw', false], ['--disable-crash-handler', false], ['--disable-render-loop', false],
  ['--gpu-validation', false], ['--gpu-abort', false], ['--generate-spirv-debug-info', false],
  ['--profiling', false], ['--gpu-profile', false], ['--enable-delta-smoothing', false],
  ['--disable-delta-smoothing', false],
  ['-l', true], ['--language', true], ['--resolution', true], ['--position', true], ['--screen', true],
  ['--display-driver', true], ['--audio-driver', true], ['--rendering-method', true], ['--rendering-driver', true],
  ['--gpu-index', true], ['--text-driver', true], ['--tablet-driver', true], ['--xr-mode', true],
  ['--fixed-fps', true], ['--time-scale', true], ['--frame-delay', true], ['--max-fps', true],
  ['--audio-output-latency', true], ['--accessibility', true],
]);

export function validateEngineArgs(args: unknown): string | null {
  if (args === undefined) return null;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return 'engineArgs must be an array of strings.';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (!flag.startsWith('-')) return `engineArgs: unexpected positional argument "${flag}".`;
    if (!ALLOWED_ENGINE_FLAGS.has(flag)) return `engineArgs: flag "${flag}" is not allowed.`;
    if (ALLOWED_ENGINE_FLAGS.get(flag)) {
      if (i + 1 >= args.length) return `engineArgs: flag "${flag}" requires a value.`;
      i++;
    }
  }
  return null;
}

export function validateUserArgs(args: unknown): string | null {
  if (args === undefined) return null;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return 'userArgs must be an array of strings.';
  return null;
}
