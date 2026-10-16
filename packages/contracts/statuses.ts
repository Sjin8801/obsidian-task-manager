/** The statuses a task can have. TaskNotes keeps the list in its own settings; these are the built-in four it starts with. */
import { statusKey } from './task.ts';

export interface StatusOption {
  /** What is written to the note's status property. */
  value: string;
  /** The name shown on screen: the "label" of the TaskNotes setting, or the value when it has none. */
  label: string;
  /** A hex colour from the TaskNotes settings, or null. */
  color: string | null;
  /** True when the status means the task is finished (TaskNotes' "isCompleted"). */
  completed: boolean;
}

export const defaultStatuses: readonly StatusOption[] = [
  { value: 'none', label: 'None', color: '#cccccc', completed: false },
  { value: 'open', label: 'Open', color: '#808080', completed: false },
  { value: 'in-progress', label: 'In progress', color: '#0066cc', completed: false },
  { value: 'done', label: 'Done', color: '#00aa00', completed: true },
];

const maxStatuses = 32, maxValueLength = 64;

/**
 * Reads the status list out of TaskNotes' settings file (its parsed data.json). Returns null when the file has no usable list,
 * so the caller falls back to the built-in four. A bad entry is skipped rather than failing the whole list, because the
 * settings belong to another plugin and are not ours to reject.
 */
export function parseStatusSettings(data: unknown): StatusOption[] | null {
  const list = data && typeof data === 'object' ? (data as { customStatuses?: unknown }).customStatuses : undefined;
  if (!Array.isArray(list)) return null;
  const found: { option: StatusOption; order: number; index: number }[] = [];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const value = typeof entry.value === 'string' ? entry.value.trim() : '';
    // The value is written into a note's properties, so keep it to one plain line.
    if (!value || value.length > maxValueLength || /[\u0000-\u001f\u007f]/.test(value) || found.some(f => f.option.value === value)) continue;
    const label = typeof entry.label === 'string' && entry.label.trim() && entry.label.trim().length <= maxValueLength && !/[\u0000-\u001f\u007f]/.test(entry.label) ? entry.label.trim() : value;
    const color = typeof entry.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(entry.color) ? entry.color : null;
    found.push({ option: { value, label, color, completed: entry.isCompleted === true }, order: typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : index, index });
  }
  if (!found.length) return null;
  return found.sort((a, b) => a.order - b.order || a.index - b.index).slice(0, maxStatuses).map(f => f.option);
}

/** The listed status a property value stands for. A note may spell a built-in status another way (open, todo, 시작), and still means the listed one. */
export function findStatus(raw: string | null, statuses: readonly StatusOption[]): StatusOption | null {
  if (raw === null) return null;
  const text = raw.trim();
  const key = statusKey(text);
  return statuses.find(s => s.value === text) ?? (key ? statuses.find(s => statusKey(s.value) === key) ?? null : null);
}

/** The name to show for a property value: the label of the listed status, else the name of the built-in status it stands for, else the value itself. */
export function statusName(raw: string | null, statuses: readonly StatusOption[]): string | null {
  const key = statusKey(raw);
  return findStatus(raw, statuses)?.label ?? defaultStatuses.find(d => d.value === key)?.label ?? raw;
}

/** The colour to draw for a status you added in TaskNotes. The built-in four keep the app's own dot styles, so this is null for them. */
export function customStatusColor(raw: string | null, statuses: readonly StatusOption[]): string | null {
  const found = findStatus(raw, statuses);
  return found && statusKey(found.value) === null ? found.color ?? '#8d8bc5' : null;
}
