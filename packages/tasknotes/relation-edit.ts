/**
 * The rules for changing a task's relationships: which link to write, and which changes would turn a relationship into a loop.
 * Pure: no file system. The note is changed by previewRelationPatch (task.ts); this decides what to put in it.
 */
import type { RelationKind, TaskRelations } from '../contracts/relations.ts';
import { baseName, parseLink, resolveLink, type VaultIndex } from './links.ts';
import { TaskDataError } from './task.ts';

export type { RelationKind };
export const relationKinds: readonly RelationKind[] = ['project', 'subtask', 'blockedBy', 'blocking'];

/** Which note the change is written to, and which note it points at. A subtask or a blocked task is changed in its own note, not in this one. */
export function relationEnds<T>(kind: RelationKind, open: T, other: T): { edited: T; linked: T; property: 'project' | 'blockedBy' } {
  switch (kind) {
    case 'project': return { edited: open, linked: other, property: 'project' };
    case 'subtask': return { edited: other, linked: open, property: 'project' };
    case 'blockedBy': return { edited: open, linked: other, property: 'blockedBy' };
    case 'blocking': return { edited: other, linked: open, property: 'blockedBy' };
  }
}

/**
 * The link to write for the note at `target`: its name when no other note has that name (`[[Project A]]`, the way Obsidian writes it),
 * else its path without `.md`. The link is read back the way TaskNotes reads it and must lead to `target`, or nothing is written.
 */
export function linkFor(target: string, index: VaultIndex, source: string, taskPaths?: ReadonlySet<string>): string {
  const name = baseName(target);
  const unique = (index.byLowerName.get(name.toLowerCase()) ?? []).length === 1;
  for (const text of unique ? [name, target.replace(/\.md$/i, '')] : [target.replace(/\.md$/i, '')]) {
    const link = `[[${text}]]`, parsed = parseLink(link);
    if (parsed && resolveLink(parsed, source, index, taskPaths).path === target) return link;
  }
  throw new TaskDataError('UNLINKABLE');
}

/**
 * Whether `gainer` taking `other` as its parent (or blocker) would make a loop: `other` is already `gainer`, or already below it
 * (or, for blockers, already blocked by it). Follows the relationships as they are now, by task id.
 */
export function createsLoop(relation: 'parent' | 'blocker', gainer: string, other: string, relations: ReadonlyMap<string, TaskRelations>): boolean {
  const next = (id: string): string[] => {
    const found = relations.get(id);
    if (!found) return [];
    return (relation === 'parent' ? found.projects.map(p => p.task?.id) : found.blockedBy.map(b => b.task?.id)).filter((x): x is string => !!x);
  };
  const seen = new Set<string>(), queue = [other];
  while (queue.length) {
    const id = queue.pop()!;
    if (id === gainer) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...next(id));
  }
  return false;
}
