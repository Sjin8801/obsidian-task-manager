/**
 * Links between notes, as TaskNotes stores them in `projects` and `blockedBy` (tasknotes-spec chapter 11, docs/tasknotes-reference.md).
 * Everything here works on paths relative to the vault root, written with "/", so it needs no file system and is the same on every OS.
 */

export type LinkFormat = 'wikilink' | 'markdown' | 'path';
export interface ParsedLink { raw: string; target: string; alias: string | null; anchor: string | null; format: LinkFormat; isRelative: boolean }

/** [[target]], [[target|alias]], [[target#anchor|alias]], [text](path.md) or a bare path. Anything that is not a non-empty string is not a link. */
export function parseLink(value: unknown): ParsedLink | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const wiki = /^\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]$/.exec(raw);
  if (wiki) {
    const target = wiki[1]!.trim();
    return target ? { raw, target, alias: wiki[3]?.trim() || null, anchor: wiki[2]?.trim() || null, format: 'wikilink', isRelative: /^\.\.?\//.test(target) } : null;
  }
  const markdown = /^\[([^\]]*)\]\(([^)#]*)(?:#([^)]*))?\)$/.exec(raw);
  if (markdown) {
    let target = markdown[2]!.trim();
    try { target = decodeURIComponent(target); } catch { /* keep it as written */ }
    return target ? { raw, target, alias: markdown[1]!.trim() || null, anchor: markdown[3]?.trim() || null, format: 'markdown', isRelative: /^\.\.?\//.test(target) } : null;
  }
  // A string with brackets that is not one of the forms above is not a path to guess at.
  if (/[[\]]/.test(raw)) return null;
  return { raw, target: raw, alias: null, anchor: null, format: 'path', isRelative: /^\.\.?\//.test(raw) };
}

/** Every markdown note in the vault, by its path. The simple-name lookup needs all of them, not only the tasks. */
export interface VaultIndex { paths: readonly string[]; byLowerPath: ReadonlyMap<string, string>; byLowerName: ReadonlyMap<string, readonly string[]> }
export function buildIndex(paths: readonly string[]): VaultIndex {
  const byLowerPath = new Map<string, string>(), byLowerName = new Map<string, string[]>();
  for (const path of paths) {
    byLowerPath.set(path.toLowerCase(), path);
    const name = baseName(path).toLowerCase();
    byLowerName.set(name, [...(byLowerName.get(name) ?? []), path]);
  }
  return { paths, byLowerPath, byLowerName };
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');

export type Unresolved = 'not_found' | 'ambiguous' | 'path_traversal';
export type Resolution = { path: string; reason: null } | { path: null; reason: Unresolved };

/** Joins and normalises, or null when the result would leave the vault. */
function normalise(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

const withExtension = (path: string) => (/\.[^/.]+$/.test(path) ? path : path + '.md');

/**
 * Turns a link found in the note at `sourcePath` into the path of the note it points at.
 * A simple name like [[Project A]] is looked up among every note (or, with `taskPaths`, only among task notes, which is how
 * `blockedBy` links are read). When several notes share the name the link is ambiguous and points at none of them.
 */
export function resolveLink(link: ParsedLink, sourcePath: string, index: VaultIndex, taskPaths?: ReadonlySet<string>): Resolution {
  const found = (candidate: string | null): Resolution => {
    if (candidate === null) return { path: null, reason: 'path_traversal' };
    const path = withExtension(candidate);
    // An exact path wins; Obsidian also finds a note whatever the capitalisation, so that is the fallback.
    const exact = index.byLowerPath.get(path.toLowerCase());
    return exact ? { path: exact, reason: null } : { path: null, reason: 'not_found' };
  };
  const dir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  const target = link.target;
  if (link.format !== 'wikilink') return found(normalise(target.startsWith('/') ? target : `${dir}/${target}`));
  if (link.isRelative) return found(normalise(`${dir}/${target}`));
  if (target.startsWith('/')) return found(normalise(target));
  if (target.includes('/')) return found(normalise(target));
  // A simple name.
  const name = target.replace(/\.md$/i, '').toLowerCase();
  const candidates = (index.byLowerName.get(name) ?? []).filter(path => !taskPaths || taskPaths.has(path));
  if (candidates.length === 1) return { path: candidates[0]!, reason: null };
  // Two notes that differ only in capitalisation: the one written exactly as the link is the one meant.
  const exact = candidates.filter(path => baseName(path) === target.replace(/\.md$/i, ''));
  if (exact.length === 1) return { path: exact[0]!, reason: null };
  return { path: null, reason: candidates.length ? 'ambiguous' : 'not_found' };
}
