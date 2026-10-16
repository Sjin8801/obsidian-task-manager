import { VaultError, type LocalVault, type RelationGraph } from './local-vault.ts';
import { readNote, writeNote } from './save-task.ts';
import { readTaskNotesSettings } from './status-config.ts';
import { parseLink, resolveLink } from '../../packages/tasknotes/links.ts';
import { createsLoop, linkFor, relationEnds, relationKinds } from '../../packages/tasknotes/relation-edit.ts';
import type { RelationTask } from '../../packages/tasknotes/relations.ts';
import { parseTask, previewRelationPatch, previewTaskPatch, revisionOf, TaskDataError, validatePath } from '../../packages/tasknotes/task.ts';
import { replaceFile } from './replace-file.ts';
import type { EditRelationInput, FindRelatedInput, RelationCandidate, RelationKind, VaultSelection } from './shared.ts';

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const sameSelection = (a: VaultSelection, b: VaultSelection) => !!a && a.vaultPath === b.vaultPath && a.taskRelativePath === b.taskRelativePath;

function graphOf(graph: RelationGraph | null): RelationGraph {
  // Without the list of every note's name a link cannot be written or read back with certainty, so nothing is changed.
  if (!graph) throw new VaultError('RELATIONS_UNAVAILABLE');
  return graph;
}
const tasksByPath = (graph: RelationGraph) => new Map(graph.tasks.map(task => [task.path, task]));

/**
 * Adds or takes out one relationship. The note that gets the link is this task's own for a project or a blocker, and the other task's for a
 * subtask or a blocked task (those are the other side of a link written in that task). Only that note is changed; the revision it is
 * checked against is the one read here, so an add or a remove always applies to the note as it is now.
 */
export async function editRelation(selection: VaultSelection, input: EditRelationInput, vault: LocalVault, backupRoot: string, now = new Date(), replace: typeof replaceFile = replaceFile): Promise<{ changed: boolean }> {
  try {
    if (!input || typeof input !== 'object' || !input.selection || !sameSelection(input.selection, selection)) throw new VaultError('VAULT_CHANGED');
    if (!text(input.path) || !relationKinds.includes(input.kind) || (input.action !== 'add' && input.action !== 'remove') || !input.other || typeof input.other !== 'object') throw new VaultError('INVALID_REQUEST');
    validatePath(input.path);
    const graph = graphOf(await vault.relationGraph()), byPath = tasksByPath(graph);
    const open = byPath.get(input.path);
    if (!open) throw new VaultError('TASK_NOT_FOUND');
    const other = input.other as Record<string, unknown>;
    let otherTask: RelationTask | null = null, linkedPath: string | null = null, raw: string | null = null;
    if ('task' in other) {
      if (!text(other.task)) throw new VaultError('INVALID_REQUEST');
      otherTask = byPath.get(other.task) ?? null;
      if (!otherTask) throw new VaultError('TASK_NOT_FOUND');
      if (otherTask === open) throw new VaultError('RELATION_SELF');
    } else if ('note' in other) {
      // Only a project can be a note that is not a task.
      if (input.kind !== 'project' || !text(other.note) || graph.index.byLowerPath.get(other.note.toLowerCase()) !== other.note) throw new VaultError('INVALID_REQUEST');
      linkedPath = other.note;
      if (linkedPath === open.vaultPath) throw new VaultError('RELATION_SELF');
    } else if ('raw' in other) {
      if (input.action !== 'remove' || (input.kind !== 'project' && input.kind !== 'blockedBy') || !text(other.raw)) throw new VaultError('INVALID_REQUEST');
      raw = other.raw.trim();
    } else throw new VaultError('INVALID_REQUEST');
    if ((input.kind === 'subtask' || input.kind === 'blocking') && !otherTask) throw new VaultError('INVALID_REQUEST');

    // The note that is written, the note it is linked to, and which of its two lists is changed.
    const ends = otherTask ? relationEnds<RelationTask>(input.kind, open, otherTask) : { edited: open, linked: null, property: input.kind === 'blockedBy' ? 'blockedBy' as const : 'project' as const };
    const edited = ends.edited, property = ends.property;
    if (ends.linked) linkedPath = ends.linked.vaultPath;
    if (graph.recurring.has(edited.id)) throw new VaultError('RECURRING_READ_ONLY');
    const taskPaths = new Set(graph.tasks.map(task => task.vaultPath));
    // A blocker is a task; a project can be any note.
    const scope = property === 'blockedBy' ? taskPaths : undefined;
    const leadsToLinked = (link: string) => {
      const parsed = parseLink(link);
      return !!parsed && linkedPath !== null && resolveLink(parsed, edited.vaultPath, graph.index, scope).path === linkedPath;
    };
    const { statuses, fields, relations: names, identification } = await readTaskNotesSettings(selection.vaultPath);
    const source = await readNote(selection, edited.path);
    const revision = revisionOf(source.raw);
    const current = parseTask(edited.path, source.raw, statuses, fields, names, identification);
    if (current.recurring) throw new VaultError('RECURRING_READ_ONLY');
    let add: string | null = null;
    if (input.action === 'add') {
      if (linkedPath === null) throw new VaultError('INVALID_REQUEST');
      const existing = property === 'project' ? current.projects : current.blockedBy.map(entry => entry.uid);
      if (existing.some(leadsToLinked)) return { changed: false };
      const linkedTask = ends.linked;
      if (linkedTask && createsLoop(property === 'project' ? 'parent' : 'blocker', edited.id, linkedTask.id, graph.relations)) throw new VaultError('RELATION_LOOP');
      add = linkFor(linkedPath, graph.index, edited.vaultPath, scope);
    }
    const remove = input.action === 'remove' ? (raw !== null ? (link: string) => link.trim() === raw : leadsToLinked) : () => false;
    let updated = previewRelationPatch(source.raw, revision, { kind: property, names, remove, add });
    if (updated === source.raw) return { changed: false };
    // TaskNotes keeps a modified time; changing a relationship is a change to the task.
    updated = previewTaskPatch(updated, revisionOf(updated), { dateModified: now.toISOString().replace(/\.\d{3}Z$/, 'Z') }, fields);
    const expected = parseTask(edited.path, updated, statuses, fields, names, identification);
    await writeNote(selection, edited.path, source, revision, updated, expected.revision, backupRoot, now, replace);
    return { changed: true };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    if (error instanceof TaskDataError) throw new VaultError(error.code);
    throw new VaultError('SAVE_FAILED');
  }
}

const collator = (value: string) => value.toLocaleLowerCase('ko');
/**
 * The tasks (and, for a project, the other notes) the person can choose from, found by name. Left out: this task, whatever is already
 * linked in that way, repeating tasks when the change would have to be written in their note, and anything that would make a loop.
 */
export function findRelated(graph: RelationGraph, input: Pick<FindRelatedInput, 'path' | 'kind' | 'q'>, limit = 12): RelationCandidate[] {
  const open = tasksByPath(graph).get(input.path);
  if (!open) throw new VaultError('TASK_NOT_FOUND');
  const relations = graph.relations.get(open.id);
  const kind: RelationKind = input.kind;
  const linkedTasks = new Set<string>(), linkedPaths = new Set<string>();
  if (relations) {
    const refs = kind === 'project' ? relations.projects.map(p => p.task) : kind === 'subtask' ? relations.subtasks : kind === 'blockedBy' ? relations.blockedBy.map(b => b.task) : relations.blocking;
    for (const ref of refs) if (ref) linkedTasks.add(ref.id);
    if (kind === 'project') for (const project of relations.projects) if (project.path) linkedPaths.add(project.path);
  }
  const query = collator(input.q.trim());
  const found: (RelationCandidate & { sort: string })[] = [];
  const parentLike = kind === 'project' || kind === 'subtask';
  for (const task of graph.tasks) {
    if (task.id === open.id || linkedTasks.has(task.id) || !(!query || collator(task.title).includes(query))) continue;
    const ends = relationEnds<RelationTask>(kind, open, task);
    if (graph.recurring.has(ends.edited.id)) continue;
    if (createsLoop(parentLike ? 'parent' : 'blocker', ends.edited.id, ends.linked.id, graph.relations)) continue;
    const slash = task.path.lastIndexOf('/');
    found.push({ other: { task: task.path }, title: task.title, hint: slash >= 0 ? task.path.slice(0, slash) : '', task: true, status: task.status, rawStatus: task.rawStatus, sort: (task.status === 'done' ? '1' : '0') + collator(task.title) });
  }
  if (kind === 'project') {
    const taskPaths = new Set(graph.tasks.map(task => task.vaultPath));
    for (const note of graph.index.paths) {
      if (taskPaths.has(note) || linkedPaths.has(note) || note === open.vaultPath) continue;
      const name = note.slice(note.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      if (query && !collator(name).includes(query)) continue;
      const slash = note.lastIndexOf('/');
      found.push({ other: { note }, title: name, hint: slash >= 0 ? note.slice(0, slash) : '', task: false, status: null, rawStatus: null, sort: '2' + collator(name) });
    }
  }
  return found.sort((a, b) => a.sort.localeCompare(b.sort, 'ko')).slice(0, limit).map(({ sort: _sort, ...candidate }) => candidate);
}

export async function findRelatedFor(selection: VaultSelection, input: FindRelatedInput, vault: LocalVault): Promise<RelationCandidate[]> {
  if (!input || typeof input !== 'object' || !input.selection || !sameSelection(input.selection, selection)) throw new VaultError('VAULT_CHANGED');
  if (!text(input.path) || !relationKinds.includes(input.kind) || typeof input.q !== 'string' || input.q.length > 200) throw new VaultError('INVALID_REQUEST');
  return findRelated(graphOf(await vault.relationGraph()), input);
}
