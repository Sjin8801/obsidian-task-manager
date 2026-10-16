import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';

/** More notes than this and the vault is not scanned for links: a project or subtask is then simply not shown, never guessed. */
export const maxIndexedNotes = 50_000;
const maxDepth = 32;

/**
 * Every markdown note in the vault, as a path relative to the vault root with "/" separators. Task links such as [[Project A]] can
 * point at any note, so resolving them needs the whole list, not only the task folder.
 * Hidden folders (.obsidian, .git, .trash) and node_modules are skipped, and so is anything that is a link: the app reads files only
 * inside the vault. Returns null when there are too many notes to list.
 */
export async function listVaultNotes(vaultPath: string, limit = maxIndexedNotes): Promise<string[] | null> {
  if ((await lstat(vaultPath)).isSymbolicLink()) return null;
  const notes: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<boolean> => {
    if (depth > maxDepth) return true;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!(await walk(path.join(directory, entry.name), prefix + entry.name + '/', depth + 1))) return false; }
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        if (notes.length >= limit) return false;
        notes.push(prefix + entry.name);
      }
    }
    return true;
  };
  return (await walk(vaultPath, '', 0)) ? notes : null;
}
