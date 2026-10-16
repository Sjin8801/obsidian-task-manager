import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { TaskRepository, type Snapshot } from '../../packages/tasknotes/repository.ts';
import { ApiError } from '../../packages/tasknotes/errors.ts';
import { revisionOf, selectDailyTasks, dateKey } from '../../packages/tasknotes/task.ts';
import { defaultCategories, inScope } from './categories.ts';
import { readTaskNotesSettings } from './status-config.ts';
import { defaultTasksFolder } from '../../packages/contracts/folder.ts';
import { listVaultNotes } from './vault-index.ts';
import { buildIndex, type VaultIndex } from '../../packages/tasknotes/links.ts';
import { buildRelations, type RelationTask } from '../../packages/tasknotes/relations.ts';
import type { RelationFieldNames } from '../../packages/contracts/fields.ts';
import type { StatusOption } from '../../packages/contracts/statuses.ts';
import type { TaskRelations } from '../../packages/contracts/relations.ts';
import type { TaskRecord } from '../../packages/contracts/task.ts';
import type { Agenda, SearchResult, TaskScope, VaultSelection } from './shared.ts';

export class VaultError extends Error { constructor(public code: string) { super(code); } }
// TaskNotes' own default for where tasks live. The folder from the TaskNotes settings is tried first (see selectVault).
export const defaultTaskFolder = defaultTasksFolder;
export function validSelection(value: unknown): value is VaultSelection {
  if (!value || typeof value !== 'object') return false;
  const v = value as VaultSelection;
  return typeof v.vaultPath === 'string' && path.isAbsolute(v.vaultPath) &&
    typeof v.taskRelativePath === 'string' && !!v.taskRelativePath &&
    !path.isAbsolute(v.taskRelativePath) && !v.taskRelativePath.split(/[\\/]/).includes('..');
}
export async function taskRoot(selection: VaultSelection): Promise<string> {
  if (!validSelection(selection)) throw new VaultError('INVALID_VAULT');
  try {
    // Revalidate on each read so a removed directory or replacement junction cannot escape the vault.
    const root = selection.vaultPath;
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new VaultError('VAULT_LINK_NOT_ALLOWED');
    let current = root;
    for (const segment of selection.taskRelativePath.split(/[\\/]/).filter(s => s && s !== '.')) {
      if (segment.startsWith('.') || segment === 'node_modules') throw new VaultError('INVALID_TASK_FOLDER');
      current = path.join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(current) !== current) throw new VaultError('VAULT_LINK_NOT_ALLOWED');
    }
    if (!(await lstat(current)).isDirectory()) throw new VaultError('INVALID_VAULT');
    return current;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('VAULT_UNAVAILABLE');
  }
}
export async function selectVault(directory: string): Promise<VaultSelection> {
  const root = await realpath(directory).catch(() => { throw new VaultError('INVALID_VAULT'); });
  const selection = { vaultPath: root, taskRelativePath: '.' };
  await taskRoot(selection);
  // The task folder of the TaskNotes settings, else TaskNotes' own default; whichever exists. With neither the whole vault is read.
  const { tasksFolder } = await readTaskNotesSettings(root);
  for (const candidate of [tasksFolder, defaultTaskFolder]) {
    if (!candidate) continue;
    try { await taskRoot({ ...selection, taskRelativePath: candidate }); selection.taskRelativePath = candidate; break; }
    catch (error) { if (!(error instanceof VaultError)) throw error; }
  }
  await taskRoot(selection);
  return selection;
}
export async function selectTaskFolder(selection: VaultSelection, directory: string): Promise<VaultSelection> {
  const canonical = await realpath(directory).catch(() => { throw new VaultError('VAULT_UNAVAILABLE'); });
  const relative = path.relative(selection.vaultPath, canonical) || '.';
  const next = { vaultPath: selection.vaultPath, taskRelativePath: relative.split(path.sep).join('/') };
  if (!validSelection(next)) throw new VaultError('INVALID_TASK_FOLDER');
  await taskRoot(next);
  return next;
}
/** What the relationship rules worked from: the tasks (with where each note is in the vault), every note's name, and what came out. Null when the vault was too big to scan. */
export interface RelationGraph { tasks: RelationTask[]; index: VaultIndex; relations: ReadonlyMap<string, TaskRelations>; names: RelationFieldNames; /** Ids of the repeating tasks, which are read-only here. */ recurring: ReadonlySet<string> }
type VaultSnapshot = Snapshot & { statuses: StatusOption[]; relations: ReadonlyMap<string, TaskRelations>; graph: RelationGraph | null };
export class LocalVault {
  private pending: Promise<VaultSnapshot> | null = null;
  constructor(readonly selection: VaultSelection, readonly categories: readonly string[] = defaultCategories) {}
  // The TaskNotes settings (status list, property names) are read with every scan, so a change there shows up on the next refresh.
  private snapshot(): Promise<VaultSnapshot> {
    if (!this.pending) {
      this.pending = taskRoot(this.selection).then(async root => {
        const { statuses, fields, relations: relationFields, identification } = await readTaskNotesSettings(this.selection.vaultPath);
        // Projects and blockers are links to any note in the vault, so the whole vault's note names are listed with the tasks.
        const [snapshot, notes] = await Promise.all([new TaskRepository(root, { vault: true, statuses, fields, relations: relationFields, identification }).snapshot(), listVaultNotes(this.selection.vaultPath).catch(() => null)]);
        // Task paths are relative to the task folder, links are resolved from the vault root.
        const folder = this.selection.taskRelativePath.replaceAll('\\', '/').replace(/^\.\/?|\/$/g, '');
        const tasks: RelationTask[] = snapshot.tasks.map(task => ({ id: task.id, path: task.path, vaultPath: folder ? `${folder}/${task.path}` : task.path, title: task.title, status: task.status, rawStatus: task.rawStatus, scheduled: task.scheduled, due: task.due, projects: task.projects, blockedBy: task.blockedBy }));
        const index = notes ? buildIndex(notes) : null;
        const relations = index ? buildRelations(tasks, index) : new Map<string, TaskRelations>();
        return { ...snapshot, statuses, relations, graph: index ? { tasks, index, relations, names: relationFields, recurring: new Set(snapshot.tasks.filter(task => task.recurring).map(task => task.id)) } : null };
      })
        .catch(error => { throw error instanceof ApiError ? new VaultError(error.code === 'SCAN_LIMIT_EXCEEDED' ? error.code : 'VAULT_UNAVAILABLE') : error; })
        .finally(() => { this.pending = null; });
    }
    return this.pending;
  }
  /** The relations of these tasks only: the screens ask about the tasks they show, not the whole vault. */
  private pick(snapshot: VaultSnapshot, tasks: readonly TaskRecord[]): Record<string, TaskRelations> {
    const picked: Record<string, TaskRelations> = {};
    for (const task of tasks) { const found = snapshot.relations.get(task.id); if (found) picked[task.id] = found; }
    return picked;
  }
  /** The tasks, the notes and the relations as they are now, for changing them; null when the vault has too many notes to scan. */
  async relationGraph(): Promise<RelationGraph | null> { return (await this.snapshot()).graph; }
  async getTask(taskPath: string) {
    const snapshot = await this.snapshot();
    if (snapshot.issues.some(issue => issue.path === taskPath)) throw new VaultError('VAULT_UNAVAILABLE');
    const task = snapshot.tasks.find(candidate => candidate.path === taskPath);
    return task ? { task, relations: snapshot.relations.get(task.id) ?? null } : null;
  }
  async agenda(scope: TaskScope, now = new Date()): Promise<Agenda> {
    const snapshot = await this.snapshot();
    const list = selectDailyTasks(snapshot.tasks.filter(t => inScope(t, scope, this.categories)), now, 'all');
    return { ...list, fetchedAt: now.toISOString(), issues: snapshot.issues, statuses: snapshot.statuses, relations: this.pick(snapshot, [...list.today, ...list.overdue, ...list.completed]) };
  }
  async search(scope: TaskScope, q: string, cursor?: string): Promise<SearchResult> {
    const snapshot = await this.snapshot(), limit = 100;
    const key = revisionOf(JSON.stringify([this.selection, snapshot.revision, this.categories, scope, q]));
    let offset = 0;
    if (cursor) {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new VaultError('INVALID_REQUEST'); }
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) throw new VaultError('INVALID_REQUEST');
      if (parsed[0] !== key) throw new VaultError('CURSOR_EXPIRED');
      offset = parsed[1] as number;
    }
    const tasks = snapshot.tasks.filter(t => inScope(t, scope, this.categories) && t.title.toLocaleLowerCase('ko').includes(q.toLocaleLowerCase('ko')));
    if (scope === 'completed') tasks.sort((a, b) => (dateKey(b.completed) ?? '').localeCompare(dateKey(a.completed) ?? '') || a.path.localeCompare(b.path, 'ko'));
    const items = tasks.slice(offset, offset + limit);
    return { items, issues: snapshot.issues, statuses: snapshot.statuses, relations: this.pick(snapshot, items), fetchedAt: new Date().toISOString(),
      nextCursor: offset + limit < tasks.length ? Buffer.from(JSON.stringify([key, offset + limit])).toString('base64url') : null };
  }
}
