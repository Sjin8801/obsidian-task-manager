import assert from 'node:assert/strict';
import test from 'node:test';
import { isOverdue } from '../packages/contracts/dates.ts';

const today = '2026-09-16';

test('미룸 means the due date has passed and the task is not finished', () => {
  assert.equal(isOverdue({ status: 'open', due: '2026-09-15' }, today), true);
  assert.equal(isOverdue({ status: 'open', due: '2026-01-01' }, today), true);
  assert.equal(isOverdue({ status: 'unknown', due: '2026-09-15' }, today), true);
});

test('a due date of today or later, or none, is not 미룸', () => {
  assert.equal(isOverdue({ status: 'open', due: today }, today), false);
  assert.equal(isOverdue({ status: 'open', due: '2026-09-17' }, today), false);
  assert.equal(isOverdue({ status: 'open', due: null }, today), false);
});

test('a finished task is never 미룸, even with a past due date', () => {
  assert.equal(isOverdue({ status: 'done', due: '2026-09-01' }, today), false);
});

test('a past scheduled date alone is not 미룸 (the task only carries no due date or a later one)', () => {
  // isOverdue reads only the due date, so a scheduled date cannot make a task overdue.
  const task = { status: 'open' as const, due: '2026-09-21', scheduled: '2026-09-01' };
  assert.equal(isOverdue(task, today), false);
});

test('a due timestamp is judged by its Seoul calendar day', () => {
  // 2026-09-15T16:00Z is already 2026-09-16 in Seoul, so it is due today, not overdue.
  assert.equal(isOverdue({ status: 'open', due: '2026-09-15T16:00:00Z' }, today), false);
  assert.equal(isOverdue({ status: 'open', due: '2026-09-15T14:59:59Z' }, today), true);
  assert.equal(isOverdue({ status: 'open', due: 'not a date' }, today), false);
});
