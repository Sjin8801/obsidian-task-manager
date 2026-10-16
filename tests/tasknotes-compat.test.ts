import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseTask, previewScalarPatch, previewTaskPatch, revisionOf } from '../packages/tasknotes/task.ts';
import { defaultStatuses, parseStatusSettings, statusName } from '../packages/contracts/statuses.ts';
import { defaultFieldNames, parseFieldMapping } from '../packages/contracts/fields.ts';
import { selectVault, defaultTaskFolder } from '../apps/desktop/local-vault.ts';
import { statusSettingsFile } from '../apps/desktop/status-config.ts';
import { saveTask } from '../apps/desktop/save-task.ts';
import { statusChoices, statusNote } from '../apps/desktop/pet-model.ts';
import type { TaskEdits } from '../apps/desktop/shared.ts';

// What TaskNotes itself does (see docs/tasknotes-reference.md). Each of these once differed in this app.
const now = new Date('2026-09-30T01:02:03.456Z');
const note = (props: string, eol = '\n') => `---${eol}tags: [task]${eol}${props.split('\n').join(eol)}${eol}---${eol}${eol}body${eol}`;

import { koreanSetup } from './korean-setup.ts';
// Without settings of its own a test vault is a Korean setup, as the notes in these tests are written that way.
async function vaultWith(t: TestContext, props: string, settings?: object, eol = '\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compat-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vaultRoot = path.join(root, 'vault'), folder = path.join(vaultRoot, defaultTaskFolder);
  await mkdir(folder, { recursive: true });
  if (settings) { const file = path.join(vaultRoot, ...statusSettingsFile.split('/')); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(settings)); } else await koreanSetup(vaultRoot);
  const file = path.join(folder, 'task.md'); await writeFile(file, note(props, eol));
  const selection = await selectVault(vaultRoot);
  const save = async (changes: TaskEdits) => saveTask(selection, { selection, path: 'task.md', revision: revisionOf(await readFile(file, 'utf8')), changes }, path.join(root, 'b'), now);
  return { file, save, text: () => readFile(file, 'utf8') };
}

test('the modified date is written the way TaskNotes writes it: UTC to the second, no fractions', async t => {
  const n = await vaultWith(t, '상태: 시작');
  await n.save({ status: '진행 중' });
  assert.match(await n.text(), /수정일: 2026-09-30T01:02:03Z\n/);
  assert(!(await n.text()).includes('.456'));
});

test('clearing a value takes the property out instead of leaving `key: null`', async t => {
  const n = await vaultWith(t, '상태: 완료\n예정일: 2026-09-15\n마감일: 2026-09-20\n완료일: 2026-09-16\n우선순위: normal');
  await n.save({ status: '시작' });
  let text = await n.text();
  assert(!/완료일/.test(text), 'reopening removes the completion date'); assert(!text.includes('null'));
  assert.match(text, /예정일: 2026-09-15\n마감일: 2026-09-20\n우선순위: normal\n수정일: /, 'the other properties stay, in order');
  await n.save({ due: null });
  text = await n.text(); assert(!/마감일/.test(text)); assert(!text.includes('null')); assert.match(text, /예정일: 2026-09-15\n우선순위: normal/);
  await n.save({ scheduled: null });
  assert(!/예정일/.test(await n.text()));
  const reread = parseTask('task.md', await n.text());
  assert.equal(reread.due, null); assert.equal(reread.scheduled, null); assert.equal(reread.completed, null);
});

test('clearing works on the last property, with Windows line breaks, with a comment, and for English names', async t => {
  const last = await vaultWith(t, '상태: 완료\n완료일: 2026-09-16');
  await last.save({ status: '시작' });
  assert(!/완료일/.test(await last.text())); assert.match(await last.text(), /\n---\r?\n/, 'the frontmatter is still closed');
  const crlf = await vaultWith(t, '상태: 완료\n완료일: 2026-09-16\n우선순위: high', undefined, '\r\n');
  await crlf.save({ status: '시작' });
  const text = await crlf.text(); assert(!/완료일/.test(text)); assert(!/[^\r]\n/.test(text.replace(/^﻿/, '')), 'every line break is still a Windows one');
  const commented = await vaultWith(t, '상태: 완료 # keep\n마감일: 2026-09-20 # note\n우선순위: high');
  await commented.save({ due: null });
  assert.match(await commented.text(), /상태: 완료 # keep\n우선순위: high/); assert(!/마감일|# note/.test(await commented.text()));
  const english = await vaultWith(t, 'status: done\ncompletedDate: 2026-09-16\ndue: 2026-09-20', { fieldMapping: { status: 'status', completedDate: 'completedDate', due: 'due', dateModified: 'dateModified' }, customStatuses: [{ value: 'open', label: 'Open', isCompleted: false, order: 0 }, { value: 'done', label: 'Done', isCompleted: true, order: 1 }] });
  await english.save({ status: 'open' });
  assert.match(await english.text(), /status: open\n/); assert(!/completedDate/.test(await english.text())); assert.match(await english.text(), /dateModified: 2026-09-30T01:02:03Z/);
});

test('removing is a no-op for a property that is not there, and is refused for anything but a one-line value', () => {
  const raw = note('상태: 시작');
  assert.equal(previewScalarPatch(raw, revisionOf(raw), { 완료일: undefined }), raw);
  const listed = note('상태: 시작\n마감일:\n  - a\n  - b');
  assert.throws(() => previewScalarPatch(listed, revisionOf(listed), { 마감일: undefined }), /UNSUPPORTED_PATCH/);
  // null keeps its older meaning: write `key: null`.
  assert.match(previewScalarPatch(raw, revisionOf(raw), { 우선순위: null }), /우선순위: null/);
  assert.equal(previewTaskPatch(raw, revisionOf(raw), { 완료일: null }), raw, 'clearing what is not there changes nothing');
});

test('a note made from a repeating task is as read-only as the series itself', async t => {
  const keys: Record<string, string> = {
    'recurrence_parent': 'recurrence_parent: "[[Weekly review]]"', 'occurrence_date': 'occurrence_date: 2026-09-30',
    'occurrence_materialization': 'occurrence_materialization: manual', 'occurrence_next_trigger': 'occurrence_next_trigger: completion',
    'occurrence_template': 'occurrence_template: "[[daily]]"', 'occurrence_past_horizon': 'occurrence_past_horizon: P7D', 'occurrence_future_horizon': 'occurrence_future_horizon: P14D',
    'recurrenceParent': 'recurrenceParent: "[[Weekly review]]"', 'occurrenceDate': 'occurrenceDate: 2026-09-30',
    'recurrence': 'recurrence: "FREQ=WEEKLY"', 'complete_instances': 'complete_instances: [2026-09-23]',
  };
  for (const [name, line] of Object.entries(keys)) {
    const task = parseTask('t.md', note(`상태: 시작\n${line}`));
    assert.equal(task.recurring, true, name); assert(task.warnings.includes('RECURRENCE_NOT_IMPLEMENTED'), name);
  }
  for (const empty of ['recurrence_parent:', 'occurrence_date: ""', 'complete_instances: []']) assert.equal(parseTask('t.md', note(`상태: 시작\n${empty}`)).recurring, false, empty);
  assert.equal(parseTask('t.md', note('상태: 시작\n예정일: 2026-09-30')).recurring, false);
  const n = await vaultWith(t, '상태: 시작\nrecurrence_parent: "[[Weekly review]]"\noccurrence_date: 2026-09-30');
  const before = await n.text();
  await assert.rejects(n.save({ status: '완료' }), { code: 'RECURRING_READ_ONLY' });
  assert.equal(await n.text(), before, 'the note is untouched');
});

test('a status is shown by its TaskNotes label and saved by its value', async t => {
  const settings = { customStatuses: [
    { value: 'none', label: 'None', order: 0 }, { value: 'open', label: 'Open', order: 1 },
    { value: 'in-progress', label: 'In progress', order: 2 }, { value: 'done', label: 'Done', order: 3, isCompleted: true },
  ] };
  const list = parseStatusSettings(settings)!;
  assert.deepEqual(list.map(s => [s.value, s.label]), [['none', 'None'], ['open', 'Open'], ['in-progress', 'In progress'], ['done', 'Done']]);
  assert.equal(statusName('in-progress', list), 'In progress'); assert.equal(statusName('done', list), 'Done'); assert.equal(statusName(null, list), null);
  const choices = statusChoices({ rawStatus: 'in-progress', recurring: false }, list);
  assert.deepEqual(choices.map(c => [c.status, c.label, c.checked]), [['none', 'None', false], ['open', 'Open', false], ['in-progress', 'In progress', true], ['done', 'Done', false]]);
  assert.equal(statusNote('in-progress', list), 'In progress', 'the widget shows the label too');
  // Saving writes the value, not the label.
  const n = await vaultWith(t, 'status: open', settings);
  await n.save({ status: 'in-progress' });
  assert.match(await n.text(), /status: in-progress\n/); assert(!(await n.text()).includes('In progress'));
});

test('a missing, blank or unsafe label falls back to the value, and the built-in statuses show their own names', () => {
  const list = parseStatusSettings({ customStatuses: [{ value: 'a' }, { value: 'b', label: '   ' }, { value: 'c', label: 7 }, { value: 'd', label: 'x'.repeat(80) }, { value: 'e', label: 'bad\nlabel' }, { value: 'f', label: ' Fine ' }] })!;
  assert.deepEqual(list.map(s => s.label), ['a', 'b', 'c', 'd', 'e', 'Fine']);
  assert.deepEqual(defaultStatuses.map(s => [s.value, s.label]), [['none', 'None'], ['open', 'Open'], ['in-progress', 'In progress'], ['done', 'Done']], "TaskNotes' own four");
  assert.equal(statusName('open', defaultStatuses), 'Open');
  assert.equal(statusName('시작', defaultStatuses), 'Open', 'a Korean value in a note reads as the status it stands for');
  assert.equal(statusName('todo', defaultStatuses), 'Open', 'and so does an older spelling');
  assert.equal(statusName('blocked', defaultStatuses), 'blocked', 'a status the list does not know is shown as written');
  assert.deepEqual(parseFieldMapping({}), { ...defaultFieldNames });
});

test("a vault without TaskNotes settings gets TaskNotes' own property names and statuses", async t => {
  const n = await vaultWith(t, 'status: open\npriority: normal', {});
  await n.save({ status: 'done', scheduled: '2026-10-01', due: '2026-10-05' });
  const text = await n.text();
  assert.match(text, /^status: done$/m); assert.match(text, /^completedDate: \d{4}-\d{2}-\d{2}$/m);
  assert.match(text, /^scheduled: 2026-10-01$/m); assert.match(text, /^due: 2026-10-05$/m); assert.match(text, /^dateModified: \d{4}-\d{2}-\d{2}T[\d:]+Z$/m);
  assert(!/[가-힣]/.test(text.split('---')[1]!), 'no Korean property name is added to an English note');
  await assert.rejects(n.save({ status: '완료' }), { code: 'INVALID_REQUEST' }, 'the status has to be one of the list (here the four of TaskNotes)');
});

test('a note that is written in Korean keeps its Korean names when a property is added, with no settings to say otherwise', async t => {
  const n = await vaultWith(t, '상태: 시작\n우선순위: normal', {});
  await n.save({ status: 'done', scheduled: '2026-10-01' });
  const text = await n.text();
  assert.match(text, /^상태: done$/m); assert.match(text, /^예정일: 2026-10-01$/m); assert.match(text, /^완료일: \d{4}-\d{2}-\d{2}$/m); assert.match(text, /^수정일: /m);
  assert(!/^(status|scheduled|completedDate|dateModified):/m.test(text), 'one spelling per note');
  assert.equal(parseTask('t.md', text).status, 'done', 'and it reads back as finished');
});
