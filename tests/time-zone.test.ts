import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, isOverdue, localClock, localDate, timeZone, useTimeZone } from '../packages/contracts/dates.ts';
import { parseTask, selectDailyTasks } from '../packages/tasknotes/task.ts';

const inZone = <T>(zone: string | undefined, run: () => T): T => {
  const before = timeZone();
  useTimeZone(zone);
  try { return run(); } finally { useTimeZone(before); }
};

test('without a pinned zone the app uses the PC time zone', () => {
  inZone(undefined, () => {
    assert.equal(timeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    assert.equal(localDate(now), expected);
  });
});

test('today, overdue and clock times follow the time zone, not Seoul', () => {
  // 2026-09-30 01:00 UTC is the evening of the 29th in New York and the morning of the 30th in Seoul.
  const now = new Date('2026-09-30T01:00:00Z');
  const note = (name: string, scheduled: string) => parseTask(name + '.md', `---\ntags: [task]\nstatus: open\nscheduled: ${scheduled}\n---\n`);
  const tasks = [note('29th', '2026-09-29'), note('30th', '2026-09-30')];
  const titles = (zone: string) => inZone(zone, () => selectDailyTasks(tasks, now, 'all').today.map(task => task.path));
  assert.deepEqual(titles('America/New_York'), ['29th.md']);
  assert.deepEqual(titles('Asia/Seoul'), ['29th.md', '30th.md']);
  inZone('America/New_York', () => {
    assert.equal(localDate(now), '2026-09-29');
    assert.deepEqual(localClock('2026-09-30T01:00:00Z'), { date: '2026-09-29', time: '21:00' });
    // A time with no zone is a time on the local clock, wherever that is.
    assert.deepEqual(localClock('2026-09-30T09:00'), { date: '2026-09-30', time: '09:00' });
    assert.equal(dateKey('2026-09-30T02:00:00Z'), '2026-09-29');
    assert.equal(isOverdue({ status: 'open', due: '2026-09-29' }, localDate(now)), false, 'due today in New York');
  });
});
