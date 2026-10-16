import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultStatuses, findStatus, parseStatusSettings, customStatusColor } from '../packages/contracts/statuses.ts';
import { parseTask } from '../packages/tasknotes/task.ts';
import { LocalVault, selectVault, defaultTaskFolder } from '../apps/desktop/local-vault.ts';
import { readStatuses, statusSettingsFile } from '../apps/desktop/status-config.ts';
import { saveTask } from '../apps/desktop/save-task.ts';
import { statusChoices, statusNote, undoStatus } from '../apps/desktop/pet-model.ts';
import type { TaskEdits } from '../apps/desktop/shared.ts';

const entry = (value: unknown, extra: Record<string, unknown> = {}) => ({ id: String(value), value, label: value, color: '#123456', isCompleted: false, order: 0, ...extra });
const custom = [
  entry('없음', { order: 0 }), entry('시작', { order: 1 }), entry('진행 중', { order: 2 }),
  entry('지연', { order: 3, color: '#cc3300' }), entry('보류', { order: 4, isCompleted: true, color: '#557755' }), entry('완료', { order: 5, isCompleted: true }),
];

test('the status list follows the TaskNotes settings: its order, its completed flag, its colours', () => {
  const list = parseStatusSettings({ customStatuses: [entry('완료', { order: 3, isCompleted: true }), entry('지연', { order: 2 }), entry('시작', { order: 1 }), entry('없음', { order: 0 })] })!;
  assert.deepEqual(list.map(s => s.value), ['없음', '시작', '지연', '완료']);
  assert.deepEqual(list.map(s => s.completed), [false, false, false, true]);
  assert.equal(list[2]!.color, '#123456');
  // Without an order the file's own order is kept.
  assert.deepEqual(parseStatusSettings({ customStatuses: [{ value: 'b' }, { value: 'a' }] })!.map(s => s.value), ['b', 'a']);
});

test('a settings file with no usable list means the built-in four; a bad entry is skipped, not fatal', () => {
  for (const data of [null, undefined, 5, 'x', [], {}, { customStatuses: 'x' }, { customStatuses: [] }, { customStatuses: [null, 3, {}, { value: '' }, { value: '   ' }] }]) assert.equal(parseStatusSettings(data), null, JSON.stringify(data));
  const list = parseStatusSettings({ customStatuses: [null, entry(''), entry(7), entry('지연'), entry('지연'), entry('a\nb'), entry('x'.repeat(65)), entry(' 보류 ', { isCompleted: 'yes' })] })!;
  assert.deepEqual(list.map(s => s.value), ['지연', '보류'], 'duplicates, multi-line and over-long values are skipped and the value is trimmed');
  assert.equal(list[1]!.completed, false, 'only an explicit true counts as completed');
});

test('colours are only accepted as hex, and the list is capped', () => {
  const list = parseStatusSettings({ customStatuses: [entry('a', { color: 'red; background:url(x)' }), entry('b', { color: '#abc' }), entry('c', { color: '#12345678' }), entry('d', { color: 42 })] })!;
  assert.deepEqual(list.map(s => s.color), [null, '#abc', '#12345678', null]);
  const many = parseStatusSettings({ customStatuses: Array.from({ length: 60 }, (_, i) => entry('s' + i, { order: i })) })!;
  assert.equal(many.length, 32);
});

test('a property value is matched to the list, including the English names older notes hold', () => {
  const list = parseStatusSettings({ customStatuses: custom })!;
  assert.equal(findStatus('지연', list)?.value, '지연');
  assert.equal(findStatus('  지연 ', list)?.value, '지연');
  assert.equal(findStatus('in-progress', list)?.value, '진행 중');
  assert.equal(findStatus('done', list)?.value, '완료');
  assert.equal(findStatus('모르는 상태', list), null);
  assert.equal(findStatus(null, list), null);
  assert.equal(findStatus('지연', defaultStatuses), null, 'the built-in four do not know 지연');
});

test('a task with a status added in TaskNotes is known, and a completed one counts as done', () => {
  const list = parseStatusSettings({ customStatuses: custom })!;
  const note = (status: string) => parseTask('t.md', `---\ntags: [task]\n상태: ${status}\n---\n`, list);
  assert.equal(note('지연').status, 'open'); assert(!note('지연').warnings.includes('UNKNOWN_STATUS'));
  assert.equal(note('보류').status, 'done', 'a status TaskNotes marks as completed finishes the task');
  assert.equal(note('완료').status, 'done');
  assert.equal(note('없는 상태').status, 'unknown'); assert(note('없는 상태').warnings.includes('UNKNOWN_STATUS'));
  // Without the settings the same note is unknown, as before.
  assert.equal(parseTask('t.md', '---\ntags: [task]\n상태: 지연\n---\n').status, 'unknown');
  assert.equal(parseTask('t.md', '---\ntags: [task]\n---\n', list).status, 'unknown');
});

test('the four built-in statuses behave as before when there are no settings', () => {
  const note = (status: string) => parseTask('t.md', `---\ntags: [task]\n상태: ${status}\n---\n`);
  assert.deepEqual(['없음', '시작', '진행 중', '완료'].map(s => note(s).status), ['open', 'open', 'open', 'done']);
  assert.equal(note('in-progress').status, 'open'); assert.equal(note('done').status, 'done');
});

async function vaultWith(t: TestContext, settings?: string | Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'status-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vaultRoot = path.join(root, 'vault'), folder = path.join(vaultRoot, defaultTaskFolder);
  await mkdir(folder, { recursive: true });
  const file = path.join(vaultRoot, ...statusSettingsFile.split('/'));
  if (settings !== undefined) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof settings === 'string' ? settings : JSON.stringify(settings)); }
  return { root, vaultRoot, folder, file, backups: path.join(root, 'backups') };
}

test('the settings are read from the vault, and anything unexpected falls back to the built-in four', async t => {
  const fallback = defaultStatuses.map(s => s.value);
  assert.deepEqual((await readStatuses((await vaultWith(t)).vaultRoot)).map(s => s.value), fallback, 'no settings file');
  assert.deepEqual((await readStatuses((await vaultWith(t, { customStatuses: custom })).vaultRoot)).map(s => s.value), ['없음', '시작', '진행 중', '지연', '보류', '완료']);
  for (const bad of ['{not json', '', '[]', 'null', '{"customStatuses":[]}']) assert.deepEqual((await readStatuses((await vaultWith(t, bad)).vaultRoot)).map(s => s.value), fallback, JSON.stringify(bad));
  const big = await vaultWith(t, JSON.stringify({ customStatuses: custom, padding: 'x'.repeat(1024 * 1024) }));
  assert.deepEqual((await readStatuses(big.vaultRoot)).map(s => s.value), fallback, 'a file over 1 MB is not read');
});

test('a settings file that is a link to somewhere else is not followed', async t => {
  const outside = await vaultWith(t, { customStatuses: custom });
  const v = await vaultWith(t);
  await mkdir(path.dirname(v.file), { recursive: true });
  try { await symlink(outside.file, v.file); } catch { t.skip('this account cannot create symbolic links'); return; }
  assert.deepEqual((await readStatuses(v.vaultRoot)).map(s => s.value), defaultStatuses.map(s => s.value));
});

test('the vault reads its tasks with the statuses from the settings and hands the list on', async t => {
  const v = await vaultWith(t, { customStatuses: custom });
  await writeFile(path.join(v.folder, 'late.md'), '---\ntags: [task]\n상태: 지연\n예정일: 2026-09-16\n---\n');
  await writeFile(path.join(v.folder, 'shelved.md'), '---\ntags: [task]\n상태: 보류\n예정일: 2026-09-16\n---\n');
  const vault = new LocalVault(await selectVault(v.vaultRoot));
  const now = new Date('2026-09-16T02:00:00Z');
  const agenda = await vault.agenda('all', now);
  assert.deepEqual(agenda.statuses.map(s => s.value), ['없음', '시작', '진행 중', '지연', '보류', '완료']);
  assert.deepEqual(agenda.today.map(x => x.title), ['late'], 'a status the settings mark as completed leaves the active list');
  assert.deepEqual((await vault.search('all', '')).statuses.map(s => s.value), agenda.statuses.map(s => s.value));
  // Change the settings and the next read follows them.
  await writeFile(v.file, JSON.stringify({ customStatuses: [entry('시작'), entry('지연', { isCompleted: true })] }));
  const again = await vault.agenda('all', now);
  assert.deepEqual(again.statuses.map(s => s.value), ['시작', '지연']);
  // 지연 is finished now. 보류 is no longer listed, so that note is a status nobody knows: it stays visible, flagged.
  assert.deepEqual(again.today.map(x => x.title), ['shelved']);
  assert.equal(again.today[0]!.status, 'unknown');
});

const now = new Date('2026-09-16T02:00:00Z');
const noteRaw = (status: string, extra = '') => `---\ntags: [task, 업무]\n상태: ${status}\n${extra}---\n\nbody\n`;
async function saver(t: TestContext, settings: Record<string, unknown> | undefined, status = '시작', extra = '') {
  const v = await vaultWith(t, settings);
  const file = path.join(v.folder, 'task.md'); await writeFile(file, noteRaw(status, extra));
  const selection = await selectVault(v.vaultRoot);
  const load = async () => parseTask('task.md', await readFile(file, 'utf8'), await readStatuses(v.vaultRoot));
  const save = async (changes: TaskEdits) => saveTask(selection, { selection, path: 'task.md', revision: (await load()).revision, changes }, v.backups, now);
  return { file, save, load };
}

test('a status added in TaskNotes can be saved, and one it does not list is refused', async t => {
  const s = await saver(t, { customStatuses: custom });
  const saved = await s.save({ status: '지연' });
  assert.match(await readFile(s.file, 'utf8'), /상태: 지연/);
  assert.equal(saved.status, 'open'); assert.equal(saved.completed, null);
  await assert.rejects(s.save({ status: '없는 상태' }), { code: 'INVALID_REQUEST' });
  assert.match(await readFile(s.file, 'utf8'), /상태: 지연/, 'a refused change leaves the note alone');
  // Without settings the same status is refused, as it always was.
  const plain = await saver(t, undefined);
  await assert.rejects(plain.save({ status: '지연' }), { code: 'INVALID_REQUEST' });
});

test('finishing follows the completed flag: the finish date is written, kept between finished statuses, and removed on reopening', async t => {
  const s = await saver(t, { customStatuses: custom });
  const finished = await s.save({ status: '보류' });
  assert.equal(finished.status, 'done'); assert.equal(finished.completed, '2026-09-16', 'a completed custom status writes the finish date');
  // Between two finished statuses the date the task was finished on stays.
  const earlier = await saver(t, { customStatuses: custom }, '보류', '완료일: 2026-09-01\n');
  const moved = await earlier.save({ status: '완료' });
  assert.equal(moved.status, 'done'); assert.equal(moved.completed, '2026-09-01');
  const reopened = await earlier.save({ status: '지연' });
  assert.equal(reopened.status, 'open'); assert.equal(reopened.completed, null, 'reopening removes the finish date');
});

test('the menus offer every status in the settings, check the current one, and show a note for the ones beyond the plain two', () => {
  const list = parseStatusSettings({ customStatuses: custom })!;
  const task = { rawStatus: '지연', recurring: false };
  assert.deepEqual(statusChoices(task, list).map(c => c.status), ['없음', '시작', '진행 중', '지연', '보류', '완료']);
  assert.deepEqual(statusChoices(task, list).filter(c => c.checked).map(c => c.status), ['지연']);
  assert.equal(statusNote('지연', list), '지연'); assert.equal(statusNote('진행 중', list), '진행 중');
  assert.equal(statusNote('시작', list), null); assert.equal(statusNote('없음', list), null); assert.equal(statusNote(null, list), null);
  assert.equal(undoStatus('지연', list), '지연'); assert.equal(undoStatus(null, list), '시작');
  const noStart = parseStatusSettings({ customStatuses: [entry('대기'), entry('끝', { isCompleted: true })] })!;
  assert.equal(undoStatus(null, noStart), '대기', 'with no 시작 the first unfinished status is used');
});

test('only a status you added gets its own colour; the built-in four keep the app styles', () => {
  const list = parseStatusSettings({ customStatuses: custom })!;
  assert.equal(customStatusColor('지연', list), '#cc3300');
  for (const value of ['없음', '시작', '진행 중', '완료', 'in-progress', null]) assert.equal(customStatusColor(value, list), null, String(value));
  assert.equal(customStatusColor('a', parseStatusSettings({ customStatuses: [entry('a', { color: 'nope' })] })!), '#8d8bc5', 'a status with no usable colour gets a neutral one');
});
