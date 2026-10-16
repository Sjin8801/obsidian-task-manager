/** How a task relates to the notes and tasks around it. Derived from the notes' links, never stored (docs/tasknotes-reference.md §4). */
import type { TaskState } from './task.ts';

/** One `blockedBy` entry: the task that blocks this one, and how (default FINISHTOSTART). */
export interface BlockedBy { uid: string; reltype: string; gap: string | null }

/** A task as another task's relationships show it. `path` is the task's own path, the one used to open it. */
export interface TaskRef { id: string; path: string; title: string; status: TaskState; rawStatus: string | null; scheduled: string | null; due: string | null }

/** A project or parent: any note a task's `projects` points at. `task` is set when that note is itself a task. */
export interface ProjectRef { name: string; /** The link as written in the note, which is how an entry is taken out again. */ link: string; path: string | null; task: TaskRef | null; unresolved: 'not_found' | 'ambiguous' | 'path_traversal' | null }

/** One blocker. `done` is true when it no longer blocks (the task is complete). A blocker that cannot be found still blocks. */
export interface DependencyRef { name: string; link: string; reltype: string; gap: string | null; task: TaskRef | null; unresolved: 'not_found' | 'ambiguous' | 'path_traversal' | null; done: boolean }

export interface TaskRelations {
  /** Everything in `projects`, in the order written, resolved. */
  projects: ProjectRef[];
  /** Tasks whose `projects` point at this task. */
  subtasks: TaskRef[];
  subtasksDone: number;
  /** This task's own `blockedBy`. */
  blockedBy: DependencyRef[];
  /** Tasks whose `blockedBy` point at this task. */
  blocking: TaskRef[];
  /** True while any blocker is unfinished or cannot be found. */
  blocked: boolean;
}

/**
 * What a person changes, seen from the task they have open:
 *  project   - a project or parent this task belongs to (its own `projects`)
 *  subtask   - a task that belongs to this one (that task's `projects`)
 *  blockedBy - a task that blocks this one (its own `blockedBy`)
 *  blocking  - a task this one blocks (that task's `blockedBy`)
 */
export type RelationKind = 'project' | 'subtask' | 'blockedBy' | 'blocking';
