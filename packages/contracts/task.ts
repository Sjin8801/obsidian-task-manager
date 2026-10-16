/** Transport model. Dates remain lossless strings; display normalization never rewrites files. */
import type { BlockedBy } from './relations.ts';
/** done: a status the TaskNotes settings mark as completed. unknown: no status, or one that is not in the settings. */
export type TaskState = 'open' | 'done' | 'unknown';
export type Priority = 'high' | 'normal' | 'low' | 'none' | 'unknown';
export type TaskScope = 'all' | 'work' | 'personal';
export interface TaskRecord {
  id: string;
  path: string;
  revision: string;
  title: string;
  titleSource: 'title' | 'filename';
  status: TaskState;
  rawStatus: string | null;
  priority: Priority;
  rawPriority: string | null;
  scheduled: string | null;
  due: string | null;
  completed: string | null;
  tags: string[];
  /** The links in `projects`, as written. Turned into projects, parents and subtasks by buildRelations. */
  projects: string[];
  /** The entries of `blockedBy`. */
  blockedBy: BlockedBy[];
  body: string;
  recurring: boolean;
  warnings: string[];
}
export interface TaskList {
  date: string;
  /** The IANA time zone "today" was worked out in. */
  timezone: string;
  today: TaskRecord[];
  overdue: TaskRecord[];
  completed: TaskRecord[];
}
/** The tags that make a task a work task or a personal one, in each language the app speaks (lower case). */
export const workTags: readonly string[] = ['업무', 'work'], personalTags: readonly string[] = ['개인', 'personal'];
export const hasTag = (tags: readonly string[], names: readonly string[]): boolean => tags.some(tag => names.includes(tag.toLowerCase()));

/** The four statuses TaskNotes starts with. */
export type BuiltInStatus = 'none' | 'open' | 'in-progress' | 'done';
// What a status value may be spelled as: TaskNotes' own values, older English ones, and the Korean ones many Korean setups use.
const statusSynonyms = new Map<string, BuiltInStatus>([
  ['none', 'none'], ['없음', 'none'],
  ['open', 'open'], ['todo', 'open'], ['시작', 'open'],
  ['in-progress', 'in-progress'], ['진행 중', 'in-progress'],
  ['done', 'done'], ['completed', 'done'], ['완료', 'done'],
]);
/** Which of the four a status value stands for, or null for a status of the person's own (or no status). */
export function statusKey(raw: string | null): BuiltInStatus | null {
  return raw === null ? null : statusSynonyms.get(raw.trim().toLowerCase()) ?? null;
}
