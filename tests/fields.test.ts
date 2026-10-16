import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultFieldNames, parseFieldMapping, validFieldName } from '../packages/contracts/fields.ts';
import { parseTask, previewTaskPatch, revisionOf } from '../packages/tasknotes/task.ts';
import { LocalVault, selectVault, defaultTaskFolder } from '../apps/desktop/local-vault.ts';
import { readTaskNotesSettings, statusSettingsFile } from '../apps/desktop/status-config.ts';
import { saveTask } from '../apps/desktop/save-task.ts';
import { defaultStatuses } from '../packages/contracts/statuses.ts';
import type { TaskEdits } from '../apps/desktop/shared.ts';

const renamed = parseFieldMapping({ fieldMapping: { scheduled: '시작일' } });
const note = (props: string) => `---\ntags: [task]\n${props}---\n\nbody\n`;

test('the property names follow the TaskNotes field mapping, and anything missing keeps its usual name', () => {
  assert.deepEqual(renamed, { ...defaultFieldNames, scheduled: '시작일' });
  assert.deepEqual(parseFieldMapping({ fieldMapping: { status: '진행상태', due: '끝나는날', completedDate: '끝낸날', dateModified: '고친날', priority: '중요도', scheduled: '시작일' } }),
    { status: '진행상태', priority: '중요도', scheduled: '시작일', due: '끝나는날', completedDate: '끝낸날', dateModified: '고친날' });
  for (const data of [null, undefined, 5, 'x', [], {}, { fieldMapping: null }, { fieldMapping: 'x' }, { fieldMapping: {} }]) assert.deepEqual(parseFieldMapping(data), { ...defaultFieldNames }, JSON.stringify(data));
});

test('a property name that is not safe to write into a note is ignored, not used', () => {
  for (const bad of ['', ' ', ' 시작일', '시작일 ', 'a: b', 'a\nb', '#x', '[x]', '"x"', "it's", 'x'.repeat(65), 'tags', 'Title', 7, null, {}, ['시작일']]) {
    assert.equal(validFieldName(bad), false, JSON.stringify(bad));
    assert.equal(parseFieldMapping({ fieldMapping: { scheduled: bad } }).scheduled, 'scheduled', JSON.stringify(bad));
  }
  for (const good of ['시작일', 'start_date', 'start-date', 'Start Date', 'date2', '_x']) assert.equal(validFieldName(good), true, good);
});

test('two fields cannot share a name, and a field cannot take a name another field already answers to', () => {
  assert.deepEqual(parseFieldMapping({ fieldMapping: { scheduled: '날짜', due: '날짜' } }), { ...defaultFieldNames }, 'a clash means none of the settings are used');
  assert.equal(parseFieldMapping({ fieldMapping: { scheduled: '마감일' } }).scheduled, 'scheduled', "another field's Korean name");
  assert.equal(parseFieldMapping({ fieldMapping: { scheduled: 'due' } }).scheduled, 'scheduled', "another field's English name");
  assert.equal(parseFieldMapping({ fieldMapping: { scheduled: 'scheduled', status: 'status' } }).scheduled, 'scheduled', 'its own English name is fine');
});

test('a note is read under the name in the settings, the usual name, or the English one', () => {
  assert.equal(parseTask('t.md', note('시작일: 2026-09-20\n'), defaultStatuses, renamed).scheduled, '2026-09-20');
  assert.equal(parseTask('t.md', note('예정일: 2026-09-21\n'), defaultStatuses, renamed).scheduled, '2026-09-21', 'a note that still has the old name is read during the change');
  assert.equal(parseTask('t.md', note('scheduled: 2026-09-22\n'), defaultStatuses, renamed).scheduled, '2026-09-22');
  assert.equal(parseTask('t.md', note('시작일: 2026-09-20\n')).scheduled, null, 'without the setting the app does not know 시작일');
  // Both names at once: the one in the settings wins and the difference is reported.
  const both = parseTask('t.md', note('예정일: 2026-09-21\n시작일: 2026-09-20\n'), defaultStatuses, renamed);
  assert.equal(both.scheduled, '2026-09-20'); assert(both.warnings.some(w => w.startsWith('CONFLICTING_FIELDS:')));
  const other = parseFieldMapping({ fieldMapping: { status: '진행상태', completedDate: '끝낸날' } });
  const custom = parseTask('t.md', note('진행상태: 완료\n끝낸날: 2026-09-01\n'), defaultStatuses, other);
  assert.equal(custom.status, 'done'); assert.equal(custom.completed, '2026-09-01');
});

test('an edit is written under the name the note uses, or the name in the settings when the note has none', () => {
  const edit = (raw: string, patch: Record<string, string | null>) => previewTaskPatch(raw, revisionOf(raw), patch, renamed);
  assert.match(edit(note('시작일: 2026-09-20\n'), { scheduled: '2026-10-01' }), /시작일: 2026-10-01/);
  const old = edit(note('예정일: 2026-09-20\n'), { scheduled: '2026-10-01' });
  assert.match(old, /예정일: 2026-10-01/); assert(!old.includes('시작일'), 'a note is not renamed behind its owner\'s back');
  const added = edit(note('상태: 시작\n'), { scheduled: '2026-10-01' });
  assert.match(added, /시작일: 2026-10-01/); assert(!added.includes('예정일'), 'a new property takes the name in the settings');
  const bothNames = edit(note('예정일: 2026-09-20\n시작일: 2026-09-20\n'), { scheduled: '2026-10-01' });
  assert.match(bothNames, /예정일: 2026-10-01/); assert.match(bothNames, /시작일: 2026-10-01/);
  // English notes stay English.
  const english = edit(note('status: open\nscheduled: 2026-09-20\n'), { scheduled: '2026-10-01' });
  assert.match(english, /scheduled: 2026-10-01/);
  // The settings name this field, and the note's status is under the settings' name too (it is TaskNotes' own), so the settings win.
  const englishNew = edit(note('status: open\n'), { scheduled: '2026-10-01' });
  assert.match(englishNew, /시작일: 2026-10-01/);
  // A note that uses none of the settings' names but TaskNotes' own ones stays in those.
  const otherNames = previewTaskPatch(note('status: open\n'), revisionOf(note('status: open\n')), { scheduled: '2026-10-01' }, parseFieldMapping({ fieldMapping: { status: '진행상태', scheduled: '시작일' } }));
  assert.match(otherNames, /scheduled: 2026-10-01/);
  // A name that is not a field of ours is still refused.
  assert.throws(() => previewTaskPatch(note(''), revisionOf(note('')), { evil: 'x' }, renamed), /UNSUPPORTED_PATCH/);
});

async function vaultWith(t: TestContext, settings?: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fields-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vaultRoot = path.join(root, 'vault'), folder = path.join(vaultRoot, defaultTaskFolder);
  await mkdir(folder, { recursive: true });
  const file = path.join(vaultRoot, ...statusSettingsFile.split('/'));
  if (settings) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(settings)); }
  return { vaultRoot, folder, file, backups: path.join(root, 'backups') };
}

test('the settings file supplies the property names, and an unusable file means the usual ones', async t => {
  assert.deepEqual((await readTaskNotesSettings((await vaultWith(t, { fieldMapping: { scheduled: '시작일' } })).vaultRoot)).fields, renamed);
  assert.deepEqual((await readTaskNotesSettings((await vaultWith(t)).vaultRoot)).fields, { ...defaultFieldNames });
  assert.deepEqual((await readTaskNotesSettings((await vaultWith(t, { fieldMapping: { scheduled: 'a: b' } })).vaultRoot)).fields, { ...defaultFieldNames });
});

test('the vault lists a note that keeps its start date under the renamed property', async t => {
  const v = await vaultWith(t, { fieldMapping: { scheduled: '시작일' } });
  await writeFile(path.join(v.folder, 'renamed.md'), note('시작일: 2026-09-16\n'));
  await writeFile(path.join(v.folder, 'old.md'), note('예정일: 2026-09-16\n'));
  const agenda = await new LocalVault(await selectVault(v.vaultRoot)).agenda('all', new Date('2026-09-16T02:00:00Z'));
  assert.deepEqual(agenda.today.map(x => x.title).sort(), ['old', 'renamed'], 'both the new and the old name are read during the change');
  // Without the setting the renamed note has no date and is not listed.
  await rm(v.file);
  assert.deepEqual((await new LocalVault(await selectVault(v.vaultRoot)).agenda('all', new Date('2026-09-16T02:00:00Z'))).today.map(x => x.title), ['old']);
});

test('saving writes the renamed properties, and leaves an old name alone', async t => {
  const settings = { fieldMapping: { scheduled: '시작일', dateModified: '고친날', completedDate: '끝낸날' } };
  const v = await vaultWith(t, settings);
  const file = path.join(v.folder, 'task.md'); await writeFile(file, note('상태: 시작\n시작일: 2026-09-15\n'));
  const selection = await selectVault(v.vaultRoot), now = new Date('2026-09-16T02:00:00Z');
  const save = async (changes: TaskEdits) => saveTask(selection, { selection, path: 'task.md', revision: revisionOf(await readFile(file, 'utf8')), changes }, v.backups, now);
  const saved = await save({ scheduled: '2026-09-20', status: 'done' });
  const text = await readFile(file, 'utf8');
  assert.match(text, /시작일: 2026-09-20/); assert.match(text, /고친날: 2026-09-16/); assert.match(text, /끝낸날: 2026-09-16/);
  assert(!/예정일|수정일|완료일/.test(text), 'no property is added under the usual name');
  assert.equal(saved.scheduled, '2026-09-20'); assert.equal(saved.completed, '2026-09-16'); assert.equal(saved.status, 'done');
  // A note that has not been moved to the new name yet keeps its own name when edited.
  await writeFile(file, note('상태: 시작\n예정일: 2026-09-15\n'));
  const before = await save({ scheduled: '2026-09-25' });
  assert.match(await readFile(file, 'utf8'), /예정일: 2026-09-25/); assert(!(await readFile(file, 'utf8')).includes('시작일'));
  assert.equal(before.scheduled, '2026-09-25');
});
