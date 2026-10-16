import assert from 'node:assert/strict';
import test from 'node:test';
import { shortDate, taskDateParts } from '../packages/contracts/dates.ts';
import { summarizePet } from '../apps/desktop/pet-model.ts';
import { parseTask } from '../packages/tasknotes/task.ts';
import { defaultStatuses } from '../packages/contracts/statuses.ts';

const today = '2026-09-30';

test('a date is shown as month/day, with the year only when it is not this year', () => {
  assert.equal(shortDate('2026-09-05', today), '9/5');
  assert.equal(shortDate('2026-12-31', today), '12/31');
  assert.equal(shortDate('2025-12-30', today), '2025/12/30');
  assert.equal(shortDate('2027-01-02', today), '2027/1/2');
});

test('a date with a time is shown as the Seoul day, and unreadable or missing dates are not shown', () => {
  assert.equal(shortDate('2026-09-13T18:00:00+09:00', today), '9/13');
  assert.equal(shortDate('2026-09-13T16:00:00Z', today), '9/14', '16:00 UTC is already the next day in Seoul');
  for (const bad of [null, '', 'soon', '2026-13-40', '09/13']) assert.equal(shortDate(bad, today), null, String(bad));
});

test('a row shows the scheduled date, then the due date, and leaves out the one that is missing', () => {
  const parts = (scheduled: string | null, due: string | null, status: 'open' | 'done' = 'open') => taskDateParts({ status, scheduled, due }, today).map(p => `${p.kind === 'scheduled' ? '예정' : '마감'} ${p.text}${p.late ? '!' : ''}`);
  assert.deepEqual(parts('2026-09-16', '2026-10-05'), ['예정 9/16', '마감 10/5']);
  assert.deepEqual(parts('2026-09-16', null), ['예정 9/16']);
  assert.deepEqual(parts(null, '2026-10-05'), ['마감 10/5']);
  assert.deepEqual(parts(null, null), []);
});

test('a due date that has passed is flagged while the task is unfinished, and never once it is done', () => {
  const late = (due: string, status: 'open' | 'done' | 'unknown' = 'open') => taskDateParts({ status, scheduled: null, due }, today)[0]!.late;
  assert.equal(late('2026-09-29'), true);
  assert.equal(late('2026-09-30'), false, 'due today is not late');
  assert.equal(late('2026-10-01'), false);
  assert.equal(late('2026-09-01', 'done'), false);
  assert.equal(late('2026-09-01', 'unknown'), true);
  // A passed scheduled date alone is not flagged: only the due date is.
  assert.equal(taskDateParts({ status: 'open', scheduled: '2026-09-01', due: '2026-10-05' }, today).some(p => p.late), false);
});

test('the widget list carries both dates from the notes', () => {
  const task = parseTask('a.md', '---\ntags: [task]\n예정일: 2026-09-16\n마감일: 2026-10-05\n---\n');
  const summary = summarizePet({ date: today, timezone: 'Asia/Seoul', fetchedAt: '', today: [task], overdue: [], completed: [], issues: [], statuses: [...defaultStatuses], relations: {} }, 'vault');
  assert.equal(summary.tasks[0]!.scheduled, '2026-09-16'); assert.equal(summary.tasks[0]!.due, '2026-10-05');
});
