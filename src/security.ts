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
