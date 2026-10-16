import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { composeDate, isOverdue, isSavableDate, normalizeDate, localClock, shortDateTime, taskDateParts } from '../packages/contracts/dates.ts';
import { parseTask, selectDailyTasks, revisionOf } from '../packages/tasknotes/task.ts';
import { selectVault, defaultTaskFolder } from '../apps/desktop/local-vault.ts';
import { saveTask } from '../apps/desktop/save-task.ts';
import type { TaskEdits } from '../apps/desktop/shared.ts';

const today = '2026-09-30';

test('a date with a time is read in its usual forms, on the Seoul clock', () => {
  const read = (value: string) => JSON.stringify(localClock(value));
  assert.equal(read('2026-09-30'), '{"date":"2026-09-30","time":null}');
  assert.equal(read('2026-09-30T09:00'), '{"date":"2026-09-30","time":"09:00"}', 'what TaskNotes writes');
  assert.equal(read('2026-09-30T09:00:30'), '{"date":"2026-09-30","time":"09:00"}');
  assert.equal(read('2026-09-30T09:00:00+09:00'), '{"date":"2026-09-30","time":"09:00"}');
  assert.equal(read('2026-09-30T09:00+09:00'), '{"date":"2026-09-30","time":"09:00"}');
  assert.equal(read('2026-09-30T00:30:00.000+09:00'), '{"date":"2026-09-30","time":"00:30"}');
  // A value with a zone is moved to Seoul time, which can be the next day.
  assert.equal(read('2026-09-30T09:00:00Z'), '{"date":"2026-09-30","time":"18:00"}');
  assert.equal(read('2026-09-30T20:00:00Z'), '{"date":"2026-10-01","time":"05:00"}');
  assert.equal(read('2026-09-30T00:00:00-05:00'), '{"date":"2026-09-30","time":"14:00"}');
});

test('values that are not a real date and time are not read', () => {
  for (const bad of [null, '', 'soon', '09:00', '2026-09-30T', '2026-09-30T9:00', '2026-09-30T24:00', '2026-09-30T09:60', '2026-09-30T09:00:60', '2026-02-30T09:00', '2026-13-01T09:00', '2026-09-30 09:00', '2026-09-30T09:00 ']) {
    assert.equal(localClock(bad), null, JSON.stringify(bad));
  }
});

test('the editor writes a plain date or a date with HH:mm, and only those', () => {
  assert.equal(composeDate('2026-09-30', null), '2026-09-30');
  assert.equal(composeDate('2026-09-30', '09:00'), '2026-09-30T09:00');
  assert.equal(composeDate('', '09:00'), '', 'no date means no value');
  assert.equal(composeDate('', null), '');
  for (const ok of ['2026-09-30', '2026-09-30T09:00', '2026-09-30T23:59', '2026-09-30T00:00']) assert.equal(isSavableDate(ok), true, ok);
  for (const bad of ['', 'soon', '2026-09-30T09:00:00', '2026-09-30T09:00:00+09:00', '2026-09-30T9:00', '2026-09-30T24:00', '2026-09-30T09:60', '2026-02-30T09:00', '2026-02-30']) assert.equal(isSavableDate(bad), false, bad);
});

test('a note is only counted as changed when its day or time changes, not its spelling', () => {
  assert.equal(normalizeDate('2026-09-13T18:00:00+09:00'), '2026-09-13T18:00');
  assert.equal(normalizeDate('2026-09-13T18:00'), '2026-09-13T18:00');
  assert.equal(normalizeDate('2026-09-13T18:00:00+09:00'), normalizeDate('2026-09-13T18:00'));
  assert.equal(normalizeDate('2026-09-13'), '2026-09-13');
  assert.equal(normalizeDate(null), ''); assert.equal(normalizeDate(''), '');
  assert.equal(normalizeDate('soon'), 'soon', 'something unreadable is left as it is');
});

test('a task due or scheduled at a time is listed and judged by its Seoul day', () => {
  const note = (name: string, props: string) => parseTask(name + '.md', `---\ntags: [task]\n상태: 시작\n${props}\n---\n`);
  const t = note('timed', '예정일: 2026-09-30T09:00');
  assert.equal(t.scheduled, '2026-09-30T09:00'); assert(!t.warnings.some(w => w.startsWith('INVALID_DATE')), 'no warning for a time written the way TaskNotes writes it');
  const list = selectDailyTasks([note('a', '예정일: 2026-09-30'), note('b', '예정일: 2026-09-30T09:00'), note('c', '예정일: 2026-09-30T09:00:00+09:00'), note('d', '예정일: 2026-10-01T09:00')], new Date('2026-09-30T01:00:00Z'));
  assert.deepEqual(list.today.map(x => x.path), ['a.md', 'b.md', 'c.md']);
  assert.equal(isOverdue({ status: 'open', due: '2026-09-29T23:30' }, today), true);
  assert.equal(isOverdue({ status: 'open', due: '2026-09-30T00:10' }, today), false, 'due today is not late, whatever the time');
  assert.equal(isOverdue({ status: 'open', due: '2026-09-29T15:00:00Z' }, today), false, '15:00 UTC is already the 30th in Seoul');
});

test('a row shows the time after the date when the task has one', () => {
  assert.equal(shortDateTime('2026-09-30T09:00', today), '9/30 09:00');
  assert.equal(shortDateTime('2026-09-30', today), '9/30');
  assert.equal(shortDateTime('2025-12-30T18:30:00+09:00', today), '2025/12/30 18:30');
  assert.equal(shortDateTime('soon', today), null);
  assert.deepEqual(taskDateParts({ status: 'open', scheduled: '2026-09-30T09:00', due: '2026-10-05' }, today).map(p => `${p.kind === 'scheduled' ? '예정' : '마감'} ${p.text}`), ['예정 9/30 09:00', '마감 10/5']);
});

import { koreanSetup } from './korean-setup.ts';
async function noteVault(t: TestContext, props: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dates-time-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vaultRoot = path.join(root, 'vault'), folder = path.join(vaultRoot, defaultTaskFolder);
  await mkdir(folder, { recursive: true }); await koreanSetup(vaultRoot);
  const file = path.join(folder, 'task.md'); await writeFile(file, `---\ntags: [task]\n상태: 시작\n${props}\n---\n\nbody\n`);
  const selection = await selectVault(vaultRoot);
  const save = async (changes: TaskEdits) => saveTask(selection, { selection, path: 'task.md', revision: revisionOf(await readFile(file, 'utf8')), changes }, path.join(root, 'b'), new Date('2026-09-30T01:00:00Z'));
  const lines = async () => (await readFile(file, 'utf8')).split('\n').filter(l => /^(예정일|마감일)/.test(l));
  return { save, lines };
}

test('saving keeps a time, adds one, changes one and removes one', async t => {
  const n = await noteVault(t, '예정일: 2026-09-30T09:00\n마감일: 2026-10-05');
  await n.save({ status: '진행 중' });
  assert.deepEqual(await n.lines(), ['예정일: 2026-09-30T09:00', '마감일: 2026-10-05'], 'other edits leave the time alone');
  await n.save({ scheduled: '2026-09-30T14:30' });
  assert.deepEqual(await n.lines(), ['예정일: 2026-09-30T14:30', '마감일: 2026-10-05'], 'a time can be changed');
  await n.save({ due: '2026-10-05T18:00' });
  assert.deepEqual(await n.lines(), ['예정일: 2026-09-30T14:30', '마감일: 2026-10-05T18:00'], 'a time can be added to a plain date');
  await n.save({ scheduled: '2026-09-30' });
  assert.deepEqual(await n.lines(), ['예정일: 2026-09-30', '마감일: 2026-10-05T18:00'], 'a time can be taken off');
  const saved = await n.save({ due: null });
  assert.equal(saved.due, null);
});

test('saving refuses a value the editor never writes', async t => {
  const n = await noteVault(t, '예정일: 2026-09-30');
  for (const bad of ['2026-09-30T09:00:00+09:00', '2026-09-30T24:00', '2026-09-30 09:00', 'soon']) await assert.rejects(n.save({ scheduled: bad }), { code: 'INVALID_DATE' }, bad);
  assert.deepEqual(await n.lines(), ['예정일: 2026-09-30']);
});
