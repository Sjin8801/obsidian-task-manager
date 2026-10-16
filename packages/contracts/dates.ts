/** Date rules shared by the vault code and the renderer, so both agree on what "today" and "overdue" mean. */
import type { TaskRecord } from './task.ts';

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}

// "Today" and clock times are those of the PC's own time zone, the same as TaskNotes in Obsidian. Tests pin one with useTimeZone
// so that they do not depend on the machine they run on.
let pinnedZone: string | undefined;
export function useTimeZone(zone: string | undefined): void { pinnedZone = zone; }
export function timeZone(): string { return pinnedZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone; }

/** The calendar day (YYYY-MM-DD) of a moment, in this time zone. */
export function localDate(instant: Date): string {
  if (Number.isNaN(instant.valueOf())) throw new Error('INVALID_DATE');
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timeZone(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// A date, or a date with a time. TaskNotes writes a time as 2026-09-30T09:00 (no seconds, no time zone); other tools write seconds
// and a zone. A value with no zone is a time on the local clock, as TaskNotes reads it.
const dateTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

/** The local day and, when the value has a time, the local clock time (HH:mm). Null when the value is not a readable date. */
export function localClock(value: string | null): { date: string; time: string | null } | null {
  if (value === null || value === '') return null;
  if (isCalendarDate(value)) return { date: value, time: null };
  const match = dateTime.exec(value);
  if (!match || !isCalendarDate(match[1]!) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return null;
  if (!match[5]) return { date: match[1]!, time: `${match[2]}:${match[3]}` };
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return { date: localDate(instant), time: `${get('hour')}:${get('minute')}` };
}

export function dateKey(value: string | null): string | null {
  return localClock(value)?.date ?? null;
}

/** The value a note stores for a date and an optional time: 2026-09-30, or 2026-09-30T09:00. Empty when there is no date. */
export function composeDate(date: string, time: string | null): string {
  return date ? (time ? `${date}T${time}` : date) : '';
}

/** The same moment in the one form the editor writes. A value that cannot be read is returned as it is. */
export function normalizeDate(value: string | null): string {
  const clock = localClock(value);
  return clock ? composeDate(clock.date, clock.time) : value ?? '';
}

/** What the editor may save: a plain date, or a date with a time written as HH:mm. */
export function isSavableDate(value: string): boolean {
  if (isCalendarDate(value)) return true;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  return !!match && isCalendarDate(match[1]!) && Number(match[2]) <= 23 && Number(match[3]) <= 59;
}

/** A task is "미룸" when its due date has passed and it is not finished. A past scheduled date alone does not count. */
export function isOverdue(task: Pick<TaskRecord, 'status' | 'due'>, today: string): boolean {
  if (task.status === 'done') return false;
  const due = dateKey(task.due);
  return due !== null && due < today;
}

/** A date for a list row: 9/16, or 2025/12/30 when it is not this year. Null when there is no date or it cannot be read. */
export function shortDate(value: string | null, today: string): string | null {
  const key = dateKey(value);
  if (!key) return null;
  const [year, month, day] = key.split('-').map(Number);
  return key.slice(0, 4) === today.slice(0, 4) ? `${month}/${day}` : `${year}/${month}/${day}`;
}
/** shortDate, followed by the time (09:00) when the value has one. */
export function shortDateTime(value: string | null, today: string): string | null {
  const day = shortDate(value, today);
  const time = localClock(value)?.time;
  return day && time ? `${day} ${time}` : day;
}

export interface DatePart { kind: 'scheduled' | 'due'; text: string; late: boolean }
/** The scheduled and due dates a task row shows, in that order. A date that is missing is left out. `late` marks a passed due date on an unfinished task. */
export function taskDateParts(task: Pick<TaskRecord, 'status' | 'scheduled' | 'due'>, today: string): DatePart[] {
  const parts: DatePart[] = [];
  const scheduled = shortDateTime(task.scheduled, today), due = shortDateTime(task.due, today);
  if (scheduled) parts.push({ kind: 'scheduled', text: scheduled, late: false });
  if (due) parts.push({ kind: 'due', text: due, late: isOverdue(task, today) });
  return parts;
}
