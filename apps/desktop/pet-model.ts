import { statusKey } from '../../packages/contracts/task.ts';
import { categoryOf, defaultCategories } from './categories.ts';
import { defaultStatuses, findStatus } from '../../packages/contracts/statuses.ts';
import type { Agenda, StatusOption, TaskRecord } from './shared.ts';
import { korean, type Translate } from './i18n/index.ts';
import type { TaskRef } from '../../packages/contracts/relations.ts';
import { nestSubtasks } from '../../packages/tasknotes/relations.ts';
// `category` is the same 업무/개인/added category the task list shows, from categoryOf().
// `revision` is the note as the list last read it: changing the status is refused if the note has changed since.
// `subtasks` are every task that points at this one as its project, still to do first; like a row, each opens its task and changes its status.
export interface PetTask { id: string; path: string; revision: string; title: string; status: TaskRecord['status']; rawStatus: string | null; category: string; recurring: boolean; scheduled: string | null; due: string | null; subtasks: TaskRef[]; subtasksDone: number }
// `statuses` is the list from the TaskNotes settings, which the status menu offers.
export interface PetSnapshot { kind: 'ready' | 'disconnected' | 'unavailable' | 'loading'; total: number; tasks: PetTask[]; partial: boolean; selectionKey: string; statuses: StatusOption[] }
export interface PetPreferences { x: number; y: number; hidden: boolean; alwaysOnTop: boolean; peek: boolean }
export interface Area { x: number; y: number; width: number; height: number }
export interface PetLayout extends Area { below: boolean; left: boolean }
export const compactSize = { width: 176, height: 56 };
// The preview panel grows with its list up to peekMaxHeight and then scrolls. peekChrome is everything else in the
// expanded window: top margin 8 + gap 6 + button 40 + bottom margin 8. Keep these in step with pet.css (.peek max-height).
export const peekMaxHeight = 320, peekMinHeight = 80, peekChrome = 62;
// Open subtasks make the list taller than peekMaxHeight by their own height, up to this much more, so they show in full instead of scrolling
// out of sight (a full list scrolls, and its first row's subtasks used to open above the visible part).
export const peekSubtaskRoom = 320;
export function fitPeekHeight(measured: number, max = peekMaxHeight): number {
  if (!Number.isFinite(measured)) return max;
  return Math.min(max, Math.max(peekMinHeight, Math.ceil(measured)));
}
// Another always-on-top window (a meeting bar, a recorder, a sticky note) can take the top of the topmost windows and cover the widget
// while its own always-on-top setting is still on. Setting it again does nothing; moveTop() puts the widget back without taking focus.
export const raiseEveryMs = 2000;
// While the widget takes the pointer, how often the main process looks whether the real pointer has left the window (see watchLeave).
export const leaveCheckMs = 100;
export function shouldRaise(state: { alwaysOnTop: boolean; hidden: boolean; closed: boolean; visible: boolean }): boolean {
  return state.alwaysOnTop && !state.hidden && !state.closed && state.visible;
}
// A title that does not fit flows left at a steady rollSpeed (px/s) and comes around again after rollGap px.
// rollGap must match the padding in pet.css (.roll-track>span).
export const rollGap = 28, rollSpeed = 50;
export function rollSeconds(textWidth: number): number {
  if (!Number.isFinite(textWidth) || textWidth <= 0) return 6;
  return Math.max(2.5, (textWidth + rollGap) / rollSpeed);
}
export function summarizePet(agenda: Agenda, selectionKey: string, categories: readonly string[] = defaultCategories): PetSnapshot {
  const tasks = [...new Map([...agenda.today, ...agenda.overdue].filter(t => t.status !== 'done').map(t => [t.id, t])).values()];
  tasks.sort((a, b) => Number(statusKey(b.rawStatus) === 'in-progress') - Number(statusKey(a.rawStatus) === 'in-progress'));
  return { kind: 'ready', total: tasks.length, partial: agenda.issues.length > 0, selectionKey, statuses: agenda.statuses,
    // A task whose parent is also in the list is shown under that parent, as in the app. `total` still counts it: it is still a task for today.
    tasks: nestSubtasks(tasks, agenda.relations).roots.map(task => ({ id: task.id, path: task.path, revision: task.revision, title: task.title, status: task.status, rawStatus: task.rawStatus, category: categoryOf(task, categories), recurring: task.recurring, scheduled: task.scheduled, due: task.due,
      subtasks: agenda.relations[task.id]?.subtasks ?? [], subtasksDone: agenda.relations[task.id]?.subtasksDone ?? 0 })) };
}
// Changing a task's status from the list (right-click on a row or on a subtask under one).
export interface PetTaskRef { id: string; selectionKey: string }
/** What the status menu needs of a row or a subtask. */
export type PetStatusTarget = Pick<PetTask, 'id' | 'path' | 'revision' | 'title' | 'rawStatus' | 'recurring'>;
/** The listed task or subtask a request points at, or null when the request is malformed or the list has moved on since it was drawn. */
export function findPetTask(snapshot: PetSnapshot, request: unknown): PetStatusTarget | null {
  if (!request || typeof request !== 'object') return null;
  const { id, selectionKey } = request as Partial<PetTaskRef>;
  if (typeof id !== 'string' || typeof selectionKey !== 'string' || selectionKey !== snapshot.selectionKey) return null;
  return snapshot.tasks.find(t => t.id === id) ?? snapshot.tasks.flatMap(t => t.subtasks).find(sub => sub.id === id) ?? null;
}
/** Whether the list on screen shows this task, either as a row or under one. Opening anything else is refused: the list has moved on. */
export function isListed(snapshot: PetSnapshot, id: string): boolean {
  return snapshot.tasks.some(t => t.id === id || t.subtasks.some(sub => sub.id === id));
}
/** `status` is what gets saved in the note; `label` is the name shown. */
export interface StatusChoice { status: string; label: string; checked: boolean; enabled: boolean }
/** Every status set up in TaskNotes, in its order. A repeating task can only be changed in Obsidian, so its choices are disabled. */
export function statusChoices(task: Pick<PetTask, 'rawStatus' | 'recurring'>, statuses: readonly StatusOption[] = defaultStatuses): StatusChoice[] {
  const current = findStatus(task.rawStatus, statuses)?.value;
  return statuses.map(s => ({ status: s.value, label: s.label, checked: current === s.value, enabled: !task.recurring }));
}
/** A status to go back to: the one the note had, else Open, else the first status that is not finished. */
export function undoStatus(rawStatus: string | null, statuses: readonly StatusOption[] = defaultStatuses): string {
  return findStatus(rawStatus, statuses)?.value ?? statuses.find(s => statusKey(s.value) === 'open')?.value ?? statuses.find(s => !s.completed)?.value ?? 'open';
}
/** A short status line under the title for anything beyond the two plain starting statuses (In progress, a status of your own, …), by the name shown on screen. */
export function statusNote(rawStatus: string | null, statuses: readonly StatusOption[] = defaultStatuses): string | null {
  const found = findStatus(rawStatus, statuses);
  const key = found ? statusKey(found.value) : null;
  return found && key !== 'none' && key !== 'open' ? found.label : null;
}
export interface PetNotice { text: string; error: boolean; undo: boolean }
export const noticeSeconds = { undo: 8, error: 6 };
export function petErrorText(code: unknown, t: Translate = korean): string {
  if (code === 'REVISION_CONFLICT') return t('다른 곳에서 먼저 바뀌어서 저장하지 않았어요. 목록을 새로 불러왔어요.');
  if (code === 'SELECTION_BUSY') return t('다른 저장이 끝나면 다시 시도해 주세요.');
  return t('상태를 바꾸지 못했어요. 앱에서 확인해 주세요.');
}
export function petBounds(p: Pick<PetPreferences, 'x' | 'y'>, expanded: boolean, area: Area, peekHeight = peekMaxHeight): PetLayout {
  const width = Math.min(expanded ? 308 : compactSize.width, area.width);
  const height = Math.min(expanded ? fitPeekHeight(peekHeight, peekMaxHeight + peekSubtaskRoom) + peekChrome : compactSize.height, area.height);
  const x = Math.round(Math.max(area.x, Math.min(p.x, area.x + area.width - compactSize.width)));
  const y = Math.round(Math.max(area.y, Math.min(p.y, area.y + area.height - compactSize.height)));
  const left = x - (width - compactSize.width) < area.x;
  const below = y - (height - compactSize.height) < area.y;
  return { x: Math.round(Math.max(area.x, Math.min(left ? x : x - width + compactSize.width, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(below ? y : y - height + compactSize.height, area.y + area.height - height))), width, height, below, left };
}
export function readPetPreferences(value: unknown, fallback: PetPreferences): PetPreferences {
  if (!value || typeof value !== 'object') return fallback;
  const v = value as Record<string, unknown>;
  return { x: typeof v.x === 'number' && Number.isFinite(v.x) ? Math.round(v.x) : fallback.x,
    y: typeof v.y === 'number' && Number.isFinite(v.y) ? Math.round(v.y) : fallback.y,
    hidden: typeof v.hidden === 'boolean' ? v.hidden : fallback.hidden,
    alwaysOnTop: typeof v.alwaysOnTop === 'boolean' ? v.alwaysOnTop : fallback.alwaysOnTop,
    peek: typeof v.peek === 'boolean' ? v.peek : fallback.peek };
}
export interface PetView { snapshot: PetSnapshot; expanded: boolean; below: boolean; left: boolean; settingsError: boolean; notice: PetNotice | null }
export interface PetBridge {
  state(): Promise<PetView>;
  expand(value: boolean): Promise<void>;
  fit(peekHeight: number): Promise<void>;
  // true while the pointer is over a see-through part of the window, so clicks there reach whatever is behind the widget.
  passThrough(value: boolean): Promise<void>;
  open(task?: { id: string; selectionKey: string }): Promise<boolean>;
  menu(): Promise<void>;
  taskMenu(task: PetTaskRef): Promise<void>;
  theme(value: 'light' | 'dark'): Promise<void>;
  undo(): Promise<void>;
  drag(value: { phase: 'start' | 'move' | 'end'; x: number; y: number }): Promise<void>;
  onState(callback: (state: PetView) => void): () => void;
  // The real pointer is outside the window although the page did not hear it leave.
  onPointerLeft(callback: () => void): () => void;
}
declare global { interface Window { taskPet?: PetBridge } }
