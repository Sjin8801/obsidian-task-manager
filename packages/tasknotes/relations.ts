import type { BlockedBy, DependencyRef, ProjectRef, TaskRef, TaskRelations } from '../contracts/relations.ts';
import type { TaskState } from '../contracts/task.ts';
import { baseName, parseLink, resolveLink, type VaultIndex } from './links.ts';

/** A link value as YAML hands it over. An unquoted [[Name]] is read as a list holding "Name"; Obsidian shows that as a link too. */
function linkText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  // `uid: [[Name]]` is a list in a list, `[[Name]]` a list: unwrap single-item lists down to the name and put the brackets back.
  let inner: unknown = value, wrapped = false;
  while (Array.isArray(inner) && inner.length === 1) { inner = inner[0]; wrapped = true; }
  if (!wrapped || typeof inner !== 'string' || !inner.trim()) return null;
  const text = inner.trim();
  return text.startsWith('[[') ? text : `[[${text}]]`;
}

/** The `projects` property: one link or a list of them. Entries that are not links are dropped, not guessed at. */
export function readProjects(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  return items.map(linkText).filter((text): text is string => text !== null && parseLink(text) !== null);
}

/**
 * The `blockedBy` property: a list of { uid, reltype, gap }. A bare link is accepted too. A missing reltype is FINISHTOSTART, the
 * default (FINISHTOSTART, STARTTOSTART, FINISHTOFINISH and STARTTOFINISH exist); anything else is kept as written, not corrected.
 */
export function readBlockedBy(value: unknown): BlockedBy[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const result: BlockedBy[] = [];
  for (const item of items) {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const uid = linkText(entry ? entry.uid : item);
    if (!uid || !parseLink(uid)) continue;
    const reltype = entry && typeof entry.reltype === 'string' && entry.reltype.trim() ? entry.reltype.trim() : 'FINISHTOSTART';
    const gap = entry && typeof entry.gap === 'string' && entry.gap.trim() ? entry.gap.trim() : null;
    result.push({ uid, reltype, gap });
  }
  return result;
}

/** What the relationship rules need to know about a task. `vaultPath` is where the note is in the vault; `path` is the task's own path. */
export interface RelationTask { id: string; path: string; vaultPath: string; title: string; status: TaskState; rawStatus: string | null; scheduled: string | null; due: string | null; projects: string[]; blockedBy: BlockedBy[] }

const ref = (task: RelationTask): TaskRef => ({ id: task.id, path: task.path, title: task.title, status: task.status, rawStatus: task.rawStatus, scheduled: task.scheduled, due: task.due });
const byTitle = (a: TaskRef, b: TaskRef) => a.title.localeCompare(b.title, 'ko') || a.path.localeCompare(b.path, 'ko');
// Subtasks still to do come first; the finished ones follow, each group by title.
const openFirst = (a: TaskRef, b: TaskRef) => Number(a.status === 'done') - Number(b.status === 'done') || byTitle(a, b);

/**
 * Works out every task's projects, subtasks and blockers, and what blocks what, from the links in the tasks themselves.
 * Subtasks and "blocking" are never written in the notes: they are the other side of someone else's link.
 * A task that links to itself is ignored. Returns the relations by task id.
 */
export function buildRelations(tasks: readonly RelationTask[], index: VaultIndex): Map<string, TaskRelations> {
  const byVaultPath = new Map(tasks.map(task => [task.vaultPath, task]));
  const taskPaths = new Set(byVaultPath.keys());
  const result = new Map<string, TaskRelations>();
  const get = (task: RelationTask): TaskRelations => {
    let relations = result.get(task.id);
    if (!relations) { relations = { projects: [], subtasks: [], subtasksDone: 0, blockedBy: [], blocking: [], blocked: false }; result.set(task.id, relations); }
    return relations;
  };
  for (const task of tasks) get(task);
  for (const task of tasks) {
    const relations = get(task);
    for (const raw of task.projects) {
      const link = parseLink(raw)!, resolution = resolveLink(link, task.vaultPath, index);
      const target = resolution.path === null || resolution.path === task.vaultPath ? null : byVaultPath.get(resolution.path) ?? null;
      if (resolution.path === task.vaultPath) continue;
      relations.projects.push({ link: raw, name: link.alias ?? target?.title ?? baseName(resolution.path ?? link.target), path: resolution.path, task: target ? ref(target) : null, unresolved: resolution.reason });
      if (target) get(target).subtasks.push(ref(task));
    }
    for (const entry of task.blockedBy) {
      const link = parseLink(entry.uid)!, resolution = resolveLink(link, task.vaultPath, index, taskPaths);
      const blocker = resolution.path === null || resolution.path === task.vaultPath ? null : byVaultPath.get(resolution.path) ?? null;
      if (resolution.path === task.vaultPath) continue;
      const done = blocker !== null && blocker.status === 'done';
      relations.blockedBy.push({ link: entry.uid, name: link.alias ?? blocker?.title ?? baseName(resolution.path ?? link.target), reltype: entry.reltype, gap: entry.gap, task: blocker ? ref(blocker) : null, unresolved: resolution.reason, done });
      if (!done) relations.blocked = true;
      if (blocker) get(blocker).blocking.push(ref(task));
    }
  }
  for (const relations of result.values()) {
    relations.subtasks.sort(openFirst); relations.blocking.sort(byTitle);
    relations.subtasksDone = relations.subtasks.filter(task => task.status === 'done').length;
  }
  return result;
}

export type { ProjectRef, DependencyRef };

/**
 * Which of the tasks listed together appear on their own, and which only under a parent that is listed with them.
 * A task is nested when one of its parents is itself on its own in this list; then it is shown under that parent, not twice.
 * A task whose parent is not in the list stays on its own. So does one whose parent is nested (the list goes one level deep), and
 * so do tasks that are each other's parents, so no task ever disappears from the list.
 */
export function nestSubtasks<T extends { id: string }>(tasks: readonly T[], relations: Readonly<Record<string, TaskRelations | undefined>>): { roots: T[]; nested: Set<string> } {
  const listed = new Set(tasks.map(task => task.id));
  const parentsOf = (id: string) => (relations[id]?.projects ?? []).map(project => project.task?.id).filter((parent): parent is string => !!parent && parent !== id && listed.has(parent));
  const topLevel = new Set(tasks.filter(task => parentsOf(task.id).length === 0).map(task => task.id));
  const nested = new Set(tasks.filter(task => !topLevel.has(task.id) && parentsOf(task.id).some(parent => topLevel.has(parent))).map(task => task.id));
  return { roots: tasks.filter(task => !nested.has(task.id)), nested };
}
