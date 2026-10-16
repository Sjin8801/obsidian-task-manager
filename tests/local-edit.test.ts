import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, rename, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalVault, selectVault, defaultTaskFolder } from '../apps/desktop/local-vault.ts';
import { saveTask } from '../apps/desktop/save-task.ts';
import { parseTask, selectDailyTasks, previewCategoryPatch, revisionOf } from '../packages/tasknotes/task.ts';
import { CategoryStore } from '../apps/desktop/category-store.ts';
import { categoryOf, categoryScope } from '../apps/desktop/categories.ts';
import type { TaskEdits } from '../apps/desktop/shared.ts';

const now = new Date('2026-09-16T02:00:00Z');
const raw = '\uFEFF---\r\ntags: [task, 업무]\r\n상태: 시작 # keep comment\r\n우선순위: normal\r\n예정일: 2026-09-15\r\n마감일: 2026-09-18\r\nprojects: ["[[Project A]]"]\r\ncustom: {keep: yes}\r\n---\r\n\r\nOriginal [[link]] body.\r\n';
import { koreanSetup } from './korean-setup.ts';
import { koreanFieldNames } from '../packages/contracts/fields.ts';
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-edit-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vaultRoot = path.join(root, 'vault'), backups = path.join(root, 'backups');
  const folder = path.join(vaultRoot, defaultTaskFolder); await mkdir(folder, { recursive: true }); await koreanSetup(vaultRoot);
  const file = path.join(folder, 'task.md'); await writeFile(file, raw);
  const selection = await selectVault(vaultRoot);
  const save = (revision: string, changes: TaskEdits) => saveTask(selection, { selection, path: 'task.md', revision, changes }, backups, now);
  return { root, folder, file, selection, backups, save };
}
test('daily list includes missed scheduled dates, applies work precedence, and keeps completed out of active list', () => {
  const note = (name: string, fields: string) => parseTask(name + '.md', '---\ntags: [task]\n' + fields + '\n---\n');
  const items = [
    note('scheduled past', '예정일: 2026-09-15\n마감일: 2026-09-21'),
    note('due past', '마감일: 2026-09-14\n예정일: 2026-09-20'),
    note('today', '예정일: 2026-09-16\n상태: 진행 중'),
    note('future', '예정일: 2026-09-17'), note('undated', '상태: 시작'),
    note('done', '예정일: 2026-09-15\n상태: 완료\n완료일: 2026-09-16'),
    parseTask('both.md', '---\ntags: [task, 업무, 개인]\n예정일: 2026-09-16\n---\n'),
  ];
  const all = selectDailyTasks(items, now);
  // Only a passed due date puts a task first (미룸); a passed scheduled date alone keeps its scheduled-date order.
  assert.deepEqual(all.today.map(t => t.title), ['due past', 'scheduled past', 'both', 'today']);
  assert.deepEqual(all.overdue, []); assert.deepEqual(all.completed.map(t => t.title), ['done']);
  assert.deepEqual(selectDailyTasks(items, now, 'work').today.map(t => t.title), ['both']);
  assert.deepEqual(selectDailyTasks(items, now, 'personal').today.map(t => t.title), ['due past', 'scheduled past', 'today']);
  assert.equal(items[2]!.status, 'open');
});
test('tasks in sub-folders of the task folder are part of the daily list too', async t => {
  // TaskNotes can file tasks in sub-folders (by year, by project), so the list reads the whole folder.
  const f = await fixture(t); await mkdir(path.join(f.folder, 'nested')); await writeFile(path.join(f.folder, 'nested', 'task.md'), raw);
  const vault = new LocalVault(f.selection);
  assert.equal((await vault.agenda('all', now)).today.length, 2);
  assert.equal((await vault.search('all', '')).items.length, 2);
});
test('status save preserves original bytes, creates a source backup, records completion and clears it on reopen', async t => {
  const f = await fixture(t);
  const done = await f.save(parseTask('task.md', raw).revision, { status: '완료' });
  const saved = await readFile(f.file, 'utf8');
  assert(saved.startsWith('\uFEFF---\r\n')); assert(saved.includes('상태: 완료 # keep comment'));
  assert(saved.includes('projects: ["[[Project A]]"]\r\ncustom: {keep: yes}\r\n'));
  assert.equal(done.body, parseTask('task.md', raw).body);
  assert.equal(done.completed, '2026-09-16'); assert.equal(done.status, 'done');
  const files = await readdir(f.backups); assert.equal(files.length, 2);
  assert.equal(await readFile(path.join(f.backups, files.find(p => p.endsWith('.md'))!), 'utf8'), raw);
  const reopened = await f.save(done.revision, { status: '진행 중', due: null, priority: 'high', body: '\n\nEdited [[link]].\n' });
  assert.equal(reopened.completed, null); assert.equal(reopened.due, null); assert.equal(reopened.priority, 'high');
  assert.equal(reopened.body, '\r\n\r\nEdited [[link]].\r\n');
  assert.equal(reopened.title, 'task');
  assert.equal((await new LocalVault(f.selection).agenda('all', now)).today[0]!.rawStatus, '진행 중');
});
test('stale revision, another vault, invalid edits and recurrence never overwrite notes', async t => {
  const f = await fixture(t), revision = parseTask('task.md', raw).revision;
  await writeFile(f.file, raw + 'External change.');
  await assert.rejects(f.save(revision, { status: '완료' }), /REVISION_CONFLICT/);
  assert.equal(await readFile(f.file, 'utf8'), raw + 'External change.');
  await assert.rejects(saveTask(f.selection, { selection: { ...f.selection, vaultPath: f.root }, path: 'task.md', revision, changes: { status: '완료' } }, f.backups), /VAULT_CHANGED/);
  await writeFile(f.file, raw);
  await assert.rejects(f.save(revision, { due: '2026-02-30' }), /INVALID_DATE/);
  await assert.rejects(f.save(revision, { status: 'unexpected' }), /INVALID_REQUEST/);
  await assert.rejects(saveTask(f.selection, { selection: f.selection, path: '../task.md', revision, changes: { status: '완료' } }, f.backups), /INVALID_PATH/);
  const recurring = raw.replace('custom:', 'recurrence: FREQ=DAILY\r\ncustom:'); await writeFile(f.file, recurring);
  await assert.rejects(f.save(parseTask('task.md', recurring).revision, { status: '완료' }), /RECURRING_READ_ONLY/);
  assert.equal(await readFile(f.file, 'utf8'), recurring);
  await assert.rejects(readdir(f.backups), /ENOENT/);
});
test('linked files and replaced folders cannot redirect a save', async t => {
  const f = await fixture(t), revision = parseTask('task.md', raw).revision;
  const outside = path.join(f.root, 'outside'); await mkdir(outside); const other = path.join(outside, 'task.md'); await writeFile(other, raw);
  await rm(f.file); await link(other, f.file);
  await assert.rejects(f.save(revision, { status: '완료' }), /UNSAFE_FILE/);
  await rm(f.file); await rename(f.folder, f.folder + '-old');
  await symlink(outside, f.folder, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.save(revision, { status: '완료' }), /VAULT_LINK_NOT_ALLOWED/);
  assert.equal(await readFile(other, 'utf8'), raw);
});

test('category patches replace classification tags only across flow, block, scalar, BOM and CRLF forms', () => {
  const catalog = ['업무', '개인', '학습'];
  for (const tags of [
    'tags: [task, 업무, 보고서] # keep tags comment',
    'tags:\n  - task # keep task comment\n  - 업무\n  - 개인\n  - 보고서 # keep report comment',
    'tags: [task, "#업무", 보고서]',
    'tags: task',
  ]) {
    for (const eol of ['\n', '\r\n']) {
      const raw = ('\uFEFF---\n' + tags + '\ncustom: {exact: "001"}\n상태: 시작\n---\n\nBody [[project]]\n').replace(/\n/g, eol);
      const result = previewCategoryPatch(raw, revisionOf(raw), catalog, '학습');
      const before = parseTask('task.md', raw), after = parseTask('task.md', result);
      assert(after.tags.includes('task')); assert(after.tags.includes('학습'));
      assert(!after.tags.includes('업무')); assert(!after.tags.includes('개인'));
      assert.equal(after.tags.includes('보고서'), before.tags.includes('보고서'));
      assert.equal(after.body, before.body);
      assert(result.includes('custom: {exact: "001"}' + eol + '상태: 시작'));
      assert(result.startsWith('\uFEFF---' + eol));
      for (const comment of ['keep tags comment', 'keep task comment', 'keep report comment']) if (raw.includes(comment)) assert(result.includes(comment));
    }
  }
});
test('moving a task writes its source tags, retains backup and uses the extended category in agenda and search', async t => {
  const f = await fixture(t), catalog = ['업무', '개인', '학습'];
  const original = raw.replace('[task, 업무]', '[task, 업무, 보고서]'); await writeFile(f.file, original);
  const task = parseTask('task.md', original);
  const saved = await saveTask(f.selection, { selection: f.selection, path: task.path, revision: task.revision, changes: { category: '학습' } }, f.backups, now, catalog);
  assert.deepEqual(saved.tags, ['task', '학습', '보고서']);
  assert.equal(categoryOf(saved, catalog), '학습');
  const vault = new LocalVault(f.selection, catalog);
  assert.equal((await vault.agenda('work', now)).today.length, 0);
  assert.equal((await vault.agenda('personal', now)).today.length, 0);
  assert.equal((await vault.agenda(categoryScope('학습'), now)).today.length, 1);
  assert.equal((await vault.search(categoryScope('학습'), '')).items.length, 1);
  const personal = await saveTask(f.selection, { selection: f.selection, path: task.path, revision: saved.revision, changes: { category: '개인' } }, f.backups, now, catalog);
  assert.deepEqual(personal.tags, ['task', '개인', '보고서']);
  assert.equal((await vault.agenda('personal', now)).today.length, 1);
  await assert.rejects(saveTask(f.selection, { selection: f.selection, path: task.path, revision: task.revision, changes: { category: '업무' } }, f.backups, now, catalog), /REVISION_CONFLICT/);
  assert.deepEqual(parseTask(task.path, await readFile(f.file, 'utf8')).tags, personal.tags);
  await assert.rejects(saveTask(f.selection, { selection: f.selection, path: task.path, revision: personal.revision, changes: { category: 'unregistered' } }, f.backups, now, catalog), /INVALID_CATEGORY/);
});
test('category catalog persists per vault without treating unrelated tags as categories', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'catalog');
  const store = new CategoryStore(directory);
  assert.deepEqual(await store.load(f.selection.vaultPath), ['업무', '개인']);
  await store.add(f.selection.vaultPath, '학습'); await store.add(f.selection.vaultPath, '학습');
  assert.deepEqual(await new CategoryStore(directory).load(f.selection.vaultPath), ['업무', '개인', '학습']);
  assert.deepEqual(await store.load('another-vault'), ['업무', '개인']);
  await assert.rejects(store.add(f.selection.vaultPath, 'task'), /Invalid category/);
  assert.equal(categoryOf({ tags: ['task', '보고서'] }, await store.load(f.selection.vaultPath)), '개인');
});

test('English TaskNotes fields load and save without adding duplicate Korean fields', async t => {
  const f = await fixture(t);
  const english = '---\ntags: [task, 개인]\nstatus: open # keep\npriority: High\nscheduled: 2026-09-15\ndue: 2026-09-21\ncreated: 2026-01-01\nmodified: 2026-01-01\n---\nEnglish body';
  await writeFile(f.file, english);
  const original = parseTask('task.md', english);
  assert.equal(original.status, 'open'); assert.equal(original.priority, 'high');
  assert.equal(original.scheduled, '2026-09-15'); assert.equal(original.due, '2026-09-21'); assert.deepEqual(original.warnings, []);
  assert.equal((await new LocalVault(f.selection).agenda('personal', now)).today.length, 1);
  const done = await f.save(original.revision, { status: '완료', due: null });
  const saved = await readFile(f.file, 'utf8');
  assert(saved.includes('status: done # keep')); assert(saved.includes('completedDate: 2026-09-16')); assert(!/^due:/m.test(saved), 'clearing the due date takes the property out, as TaskNotes does');
  assert(!saved.includes('상태:')); assert(!saved.includes('완료일:')); assert(!saved.includes('수정일:')); assert(!saved.includes('dateModified:'));
  assert(saved.includes('modified: 2026-09-16')); assert.equal(done.body, original.body);
  const reopened = await f.save(done.revision, { status: '진행 중' });
  assert.equal(reopened.rawStatus, 'in-progress'); assert.equal(reopened.completed, null);
  assert.equal((await new LocalVault(f.selection).search('completed', '')).items.length, 0);
});
test('mixed field precedence is explicit, conflicts warn, and edits update existing aliases consistently', async t => {
  const f = await fixture(t);
  const mixed = '---\ntags: [task]\n상태: 시작\nstatus: done\n예정일: null\nscheduled: 2026-09-16\n---\nbody';
  await writeFile(f.file, mixed);
  // With the Korean names set in TaskNotes, those win over the English ones that sit next to them.
  const task = parseTask('task.md', mixed, undefined, koreanFieldNames);
  assert.notEqual(task.status, 'done'); assert.equal(task.scheduled, null);
  assert(task.warnings.includes('CONFLICTING_FIELDS:상태/status'));
  assert(task.warnings.includes('CONFLICTING_FIELDS:예정일/scheduled'));
  const done = await f.save(task.revision, { status: '완료', scheduled: '2026-09-17' });
  const saved = await readFile(f.file, 'utf8');
  assert(saved.includes('상태: 완료')); assert(saved.includes('status: done'));
  assert(saved.includes('예정일: 2026-09-17')); assert(saved.includes('scheduled: 2026-09-17'));
  assert(!done.warnings.some(w => w.startsWith('CONFLICTING_FIELDS')));
});
test('completed search includes historical, undated and English tasks across pages but excludes active tasks', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 101; i++) await writeFile(path.join(f.folder, `old-${i}.md`), '---\ntags: [task]\nstatus: done\ncompletedDate: 2020-01-01\n---\n');
  await mkdir(path.join(f.folder, 'archive'));
  await writeFile(path.join(f.folder, 'archive', 'undated.md'), '---\ntags: [task]\n상태: 완료\n---\n');
  await writeFile(path.join(f.folder, 'newest.md'), '---\ntags: [task]\n상태: 완료\n완료일: 2026-09-16\n---\n');
  const vault = new LocalVault(f.selection);
  const first = await vault.search('completed', '');
  assert.equal(first.items.length, 100); assert(first.nextCursor); assert.equal(first.items[0]!.path, 'newest.md');
  const second = await vault.search('completed', '', first.nextCursor);
  assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null);
  assert.equal(second.items.at(-1)!.path, 'archive/undated.md');
  assert([...first.items, ...second.items].every(t => t.status === 'done'));
  assert.equal((await vault.search('completed', 'undated')).items.length, 1);
  assert.equal((await vault.search('completed', 'task')).items.length, 0);
  await assert.rejects(vault.search('all', '', first.nextCursor), /CURSOR_EXPIRED/);
});
