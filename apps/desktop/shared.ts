import type { TaskList, TaskRecord } from '../../packages/contracts/task.ts';
import type { StatusOption } from '../../packages/contracts/statuses.ts';
import type { RelationKind, TaskRelations } from '../../packages/contracts/relations.ts';
import type { LanguagePreference } from './i18n/index.ts';
export type { TaskRecord, StatusOption, TaskRelations, RelationKind };
export type TaskScope = string;
// `statuses` is the list from the TaskNotes settings that these tasks were read with.
export interface Agenda extends TaskList { fetchedAt: string; issues: { path: string; code: string }[]; statuses: StatusOption[]; relations: Record<string, TaskRelations> }
export interface SearchResult { items: TaskRecord[]; nextCursor: string | null; fetchedAt: string; issues: { path: string; code: string }[]; statuses: StatusOption[]; relations: Record<string, TaskRelations> }
export type Result<T> = { ok: true; value: T } | { ok: false; code: string };
export interface VaultSelection { vaultPath: string; taskRelativePath: string }
// Headless Sync: `ob sync --continuous` run and watched by the app. See headless-sync.ts.
export type SyncPhase = 'off' | 'starting' | 'connecting' | 'syncing' | 'synced' | 'offline' | 'stalled' | 'problem';
export type SyncProblem = 'NO_VAULT' | 'NOT_INSTALLED' | 'NODE_MISSING' | 'NOT_LOGGED_IN' | 'NOT_CONFIGURED' | 'BAD_MODE' | 'ALREADY_RUNNING' | 'REMOTE_MISSING' | 'ENCRYPTION_KEY' | 'CRASHED';
export interface SyncStatus {
  enabled: boolean; phase: SyncPhase; problem: SyncProblem | null;
  phaseSince: number | null; startedAt: number | null; lastSyncedAt: number | null; lastActivityAt: number | null;
  progress: { done: number; total: number } | null; restarts: number; lastError: string | null; mode: string | null; recent: string[];
}
export interface DesktopStatus { language: LanguagePreference; autoStart: boolean; autoStartSupported: boolean; connected: boolean; categories: string[]; vault: VaultSelection | null; shortcut: string; shortcutRegistered: boolean; shortcutError: string | null; sync: SyncStatus }
export interface TaskEdits { category?: string; status?: string; priority?: string; scheduled?: string | null; due?: string | null; body?: string }
export interface SaveTaskInput { selection: VaultSelection; path: string; revision: string; changes: TaskEdits }
/** The other end of a relationship: a task (by its path in the task folder), any other note (by its path in the vault), or an entry as written in the note, which is how a broken link is taken out. */
export type RelationOther = { task: string } | { note: string } | { raw: string };
export interface EditRelationInput { selection: VaultSelection; path: string; kind: RelationKind; action: 'add' | 'remove'; other: RelationOther }
/** A task or note that can be chosen for a relationship, found by the name it is shown under. */
export interface RelationCandidate { other: RelationOther; title: string; hint: string; task: boolean; status: TaskRecord['status'] | null; rawStatus: string | null }
export interface FindRelatedInput { selection: VaultSelection; path: string; kind: RelationKind; q: string }
export interface DesktopBridge {
  setLanguage(value: LanguagePreference): Promise<Result<DesktopStatus>>;
  setAutoStart(value: boolean): Promise<Result<DesktopStatus>>;
  setHeadlessSync(value: boolean): Promise<Result<DesktopStatus>>;
  retryHeadlessSync(): Promise<Result<DesktopStatus>>;
  onSyncStatus(callback: (status: SyncStatus) => void): () => void;
  setShortcut(value: string): Promise<Result<DesktopStatus>>;
  setShortcutCapture(value: boolean): Promise<Result<null>>;
  addCategory(name: string): Promise<Result<DesktopStatus>>;
  saveTask(input: SaveTaskInput): Promise<Result<TaskRecord>>;
  editRelation(input: EditRelationInput): Promise<Result<{ changed: boolean }>>;
  findRelated(input: FindRelatedInput): Promise<Result<RelationCandidate[]>>;
  status(): Promise<Result<DesktopStatus>>;
  selectVault(): Promise<Result<DesktopStatus>>;
  selectTaskFolder(): Promise<Result<DesktopStatus>>;
  agenda(scope: TaskScope): Promise<Result<{ agenda: Agenda; stale: boolean; error: string | null }>>;
  search(input: { scope: TaskScope; q: string; cursor?: string }): Promise<Result<SearchResult>>;
  forgetVault(): Promise<Result<null>>;
  hide(): Promise<Result<null>>;
  showPet(): Promise<Result<null>>;
  onOpenTask(callback: (value: { task: TaskRecord; relations: TaskRelations | null; selection: VaultSelection }) => void): () => void;
  getTask(path: string): Promise<Result<{ task: TaskRecord; relations: TaskRelations | null } | null>>;
  onChanged(callback: () => void): () => void;
  onBack(callback: () => void): () => void;
  onShow(callback: () => void): () => void;
}
declare global { interface Window { taskManager?: DesktopBridge } }
