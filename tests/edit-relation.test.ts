import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalVault, selectVault, VaultError } from '../apps/desktop/local-vault.ts';
import { editRelation, findRelated } from '../apps/desktop/edit-relation.ts';
import type { EditRelationInput, RelationKind, RelationOther } from '../apps/desktop/shared.ts';

// A made-up vault: the task folder, the project folder and the note names are the test's own.
const note = (title: string, extra = '', status = 'open') => `---\ntags: [task]\ntitle: ${title}\nstatus: ${status}\nscheduled: 2026-09-30\n${extra}---\n\n본문\n`;
const now = new Date('2026-09-30T03:04:05.678Z');

async function setup(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'edit-rel-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vaultDir = path.join(root, 'vault');
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(vaultDir, name)), { recursive: true }); await writeFile(path.join(vaultDir, name), content); }
  const selection = { ...(await selectVault(vaultDir)), taskRelativePath: 'Tasks' };
  const vault = () => new LocalVault(selection);
  const backups = path.join(root, 'backups');
  const edit = (path: string, kind: RelationKind, action: 'add' | 'remove', other: RelationOther) => editRelation(selection, { selection, path, kind, action, other } as EditRelationInput, vault(), backups, now);
  const read = (name: string) => readFile(path.join(vaultDir, name), 'utf8');
  const relationsOf = async (name: string) => { const v = vault(), found = await v.getTask(name); return found!.relations!; };
  return { selection, vault, backups, edit, read, relationsOf, root };
}
const code = (promise: Promise<unknown>) => promise.then(() => 'no error', (error: unknown) => (error instanceof VaultError ? error.code : String(error)));

test('a task is put under a parent: only its own note changes, and the parent then lists it as a subtask', async t => {
  const { edit, read, relationsOf, backups } = await setup(t, { 'Tasks/Parent.md': note('Parent'), 'Tasks/Child.md': note('Child') });
  const parentBefore = await read('Tasks/Parent.md');
  assert.deepEqual(await edit('Child.md', 'project', 'add', { task: 'Parent.md' }), { changed: true });
  const text = await read('Tasks/Child.md');
  assert.match(text, /projects:\n {2}- "\[\[Parent\]\]"/);
  assert.match(text, /^dateModified: 2026-09-30T03:04:05Z$/m, "the modified time is kept up to date, as TaskNotes does");
  assert.equal(await read('Tasks/Parent.md'), parentBefore, 'the parent note is not touched');
  assert.deepEqual((await relationsOf('Parent.md')).subtasks.map(s => s.title), ['Child']);
  assert.equal((await readdir(backups)).filter(name => name.endsWith('.md')).length, 1, 'the old text is kept');
  assert.deepEqual(await edit('Child.md', 'project', 'add', { task: 'Parent.md' }), { changed: false }, 'adding it again changes nothing');
});

test('a subtask is added from the parent, which writes the link in the subtask\'s note', async t => {
  const { edit, read, relationsOf } = await setup(t, { 'Tasks/Parent.md': note('Parent'), 'Tasks/Child.md': note('Child') });
  const parentBefore = await read('Tasks/Parent.md');
  assert.deepEqual(await edit('Parent.md', 'subtask', 'add', { task: 'Child.md' }), { changed: true });
  assert.match(await read('Tasks/Child.md'), /projects:\n {2}- "\[\[Parent\]\]"/);
  assert.equal(await read('Tasks/Parent.md'), parentBefore);
  assert.deepEqual((await relationsOf('Parent.md')).subtasks.map(s => s.title), ['Child']);
  assert.deepEqual(await edit('Parent.md', 'subtask', 'remove', { task: 'Child.md' }), { changed: true });
  assert.doesNotMatch(await read('Tasks/Child.md'), /projects/);
  assert.deepEqual((await relationsOf('Parent.md')).subtasks, []);
});

test('blockers: one is added to this task, another is made to wait for it', async t => {
  const { edit, read, relationsOf } = await setup(t, { 'Tasks/A.md': note('A'), 'Tasks/B.md': note('B'), 'Tasks/C.md': note('C') });
  await edit('A.md', 'blockedBy', 'add', { task: 'B.md' });
  assert.match(await read('Tasks/A.md'), /blockedBy:\n {2}- uid: "\[\[B\]\]"\n {4}reltype: FINISHTOSTART/);
  await edit('A.md', 'blocking', 'add', { task: 'C.md' });
  assert.match(await read('Tasks/C.md'), /blockedBy:\n {2}- uid: "\[\[A\]\]"/);
  const relations = await relationsOf('A.md');
  assert.deepEqual(relations.blockedBy.map(b => b.task?.title), ['B']); assert.deepEqual(relations.blocking.map(b => b.title), ['C']);
  assert.equal(relations.blocked, true);
  await edit('A.md', 'blocking', 'remove', { task: 'C.md' });
  assert.deepEqual((await relationsOf('A.md')).blocking, []);
  await edit('A.md', 'blockedBy', 'remove', { raw: '[[B]]' });
  assert.deepEqual((await relationsOf('A.md')).blockedBy, []);
  assert.doesNotMatch(await read('Tasks/A.md'), /blockedBy/);
});

test('a project that is an ordinary note is linked by its name, and by its path when another note has the same name', async t => {
  const { edit, read, relationsOf } = await setup(t, { 'Tasks/A.md': note('A'), 'Tasks/B.md': note('B'), 'Projects/Roadmap.md': '# 로드맵', 'Projects/Q4/Plan.md': '', 'Archive/Plan.md': '' });
  await edit('A.md', 'project', 'add', { note: 'Projects/Roadmap.md' });
  assert.match(await read('Tasks/A.md'), /- "\[\[Roadmap\]\]"/);
  assert.equal((await relationsOf('A.md')).projects[0]!.path, 'Projects/Roadmap.md');
  await edit('B.md', 'project', 'add', { note: 'Projects/Q4/Plan.md' });
  assert.match(await read('Tasks/B.md'), /- "\[\[Projects\/Q4\/Plan\]\]"/);
  assert.equal((await relationsOf('B.md')).projects[0]!.path, 'Projects/Q4/Plan.md', 'it leads to the note that was chosen, not the other Plan');
});

test('an entry that does not lead anywhere can still be taken out, by the text written in the note', async t => {
  const { edit, read, relationsOf } = await setup(t, { 'Tasks/A.md': note('A', 'projects:\n  - "[[Gone]]"\n  - "[[B]]"\n'), 'Tasks/B.md': note('B') });
  const relations = await relationsOf('A.md');
  assert.equal(relations.projects[0]!.unresolved, 'not_found'); assert.equal(relations.projects[0]!.link, '[[Gone]]');
  await edit('A.md', 'project', 'remove', { raw: '[[Gone]]' });
  assert.match(await read('Tasks/A.md'), /projects:\n {2}- "\[\[B\]\]"/); assert.doesNotMatch(await read('Tasks/A.md'), /Gone/);
});

test('a change that would make a loop, or point a task at itself, is refused and nothing is written', async t => {
  const { edit, read } = await setup(t, { 'Tasks/A.md': note('A'), 'Tasks/B.md': note('B', 'projects:\n  - "[[A]]"\n'), 'Tasks/C.md': note('C', 'projects:\n  - "[[B]]"\n'), 'Tasks/X.md': note('X', 'blockedBy:\n  - uid: "[[Y]]"\n'), 'Tasks/Y.md': note('Y') });
  const before = await Promise.all(['A', 'B', 'C', 'X', 'Y'].map(n => read(`Tasks/${n}.md`)));
  assert.equal(await code(edit('A.md', 'project', 'add', { task: 'C.md' })), 'RELATION_LOOP', 'A under its own grandchild');
  assert.equal(await code(edit('C.md', 'subtask', 'add', { task: 'A.md' })), 'RELATION_LOOP', 'the same from the other side');
  assert.equal(await code(edit('Y.md', 'blockedBy', 'add', { task: 'X.md' })), 'RELATION_LOOP', 'two tasks waiting for each other');
  assert.equal(await code(edit('X.md', 'blocking', 'add', { task: 'Y.md' })), 'RELATION_LOOP', 'making Y wait for X, which already waits for Y');
  assert.equal(await code(edit('Y.md', 'blocking', 'add', { task: 'X.md' })), 'no error', 'the blocker that is already there, said from the other side, changes nothing');
  assert.equal(await code(edit('A.md', 'project', 'add', { task: 'A.md' })), 'RELATION_SELF');
  assert.equal(await code(edit('A.md', 'project', 'add', { note: 'Tasks/A.md' })), 'RELATION_SELF');
  assert.deepEqual(await Promise.all(['A', 'B', 'C', 'X', 'Y'].map(n => read(`Tasks/${n}.md`))), before);
});

test('a repeating task is not changed, whichever side of the relationship its note is', async t => {
  const { edit, read } = await setup(t, { 'Tasks/Daily.md': note('Daily', 'recurrence: FREQ=DAILY\n'), 'Tasks/Other.md': note('Other') });
  const before = await read('Tasks/Daily.md');
  assert.equal(await code(edit('Daily.md', 'project', 'add', { task: 'Other.md' })), 'RECURRING_READ_ONLY');
  assert.equal(await code(edit('Other.md', 'subtask', 'add', { task: 'Daily.md' })), 'RECURRING_READ_ONLY');
  assert.equal(await code(edit('Other.md', 'blocking', 'add', { task: 'Daily.md' })), 'RECURRING_READ_ONLY');
  assert.equal(await read('Tasks/Daily.md'), before);
  // The repeating task can still be what another task points at.
  assert.equal(await code(edit('Other.md', 'project', 'add', { task: 'Daily.md' })), 'no error');
});

test('requests that make no sense are refused', async t => {
  const { edit, selection, vault, backups } = await setup(t, { 'Tasks/A.md': note('A'), 'Tasks/B.md': note('B'), 'Notes/N.md': '' });
  assert.equal(await code(edit('Nope.md', 'project', 'add', { task: 'B.md' })), 'TASK_NOT_FOUND');
  assert.equal(await code(edit('A.md', 'project', 'add', { task: 'Nope.md' })), 'TASK_NOT_FOUND');
  assert.equal(await code(edit('A.md', 'subtask', 'add', { note: 'Notes/N.md' })), 'INVALID_REQUEST', 'only a project can be a note that is not a task');
  assert.equal(await code(edit('A.md', 'project', 'add', { note: 'Notes/Missing.md' })), 'INVALID_REQUEST');
  assert.equal(await code(edit('A.md', 'project', 'add', { raw: '[[B]]' })), 'INVALID_REQUEST', 'an entry as written can only be taken out');
  assert.equal(await code(edit('../A.md', 'project', 'add', { task: 'B.md' })), 'INVALID_PATH');
  assert.equal(await code(edit('A.md', 'sideways' as RelationKind, 'add', { task: 'B.md' })), 'INVALID_REQUEST');
  assert.equal(await code(editRelation(selection, { selection: { ...selection, taskRelativePath: 'Other' }, path: 'A.md', kind: 'project', action: 'add', other: { task: 'B.md' } }, vault(), backups)), 'VAULT_CHANGED');
});

test('the people can be found by name: not this task, not what is already linked, not what would make a loop', async t => {
  const { vault } = await setup(t, { 'Tasks/Alpha.md': note('Alpha'), 'Tasks/Beta.md': note('Beta', 'projects:\n  - "[[Alpha]]"\n'), 'Tasks/Gamma.md': note('Gamma'), 'Tasks/Done.md': note('Done task', '', 'done'), 'Tasks/Daily.md': note('Daily', 'recurrence: FREQ=DAILY\n'), 'Projects/Roadmap.md': '', 'Projects/Alphabet.md': '' });
  const graph = (await vault().relationGraph())!;
  const names = (kind: RelationKind, q: string, path = 'Alpha.md') => findRelated(graph, { path, kind, q }).map(c => c.title);
  assert.deepEqual(names('project', ''), ['Daily', 'Gamma', 'Done task', 'Alphabet', 'Roadmap'], 'tasks to do first, then finished ones, then other notes; not itself, not Beta (a child of Alpha: it would be a loop)');
  assert.deepEqual(names('project', 'alp'), ['Alphabet'], 'by part of the name, notes that are not tasks included');
  assert.deepEqual(names('subtask', ''), ['Gamma', 'Done task'], 'not Beta (already a subtask), not the repeating Daily (its note would have to change), no notes');
  assert.deepEqual(names('blockedBy', 'a'), ['Beta', 'Daily', 'Gamma', 'Done task'], 'blockers are tasks; a repeating task can block');
  assert.deepEqual(names('blocking', 'a'), ['Beta', 'Gamma', 'Done task']);
  assert.deepEqual(findRelated(graph, { path: 'Alpha.md', kind: 'project', q: '' }, 2).length, 2, 'the list is cut at the limit');
  assert.deepEqual(findRelated(graph, { path: 'Gamma.md', kind: 'project', q: 'roadmap' })[0]!.other, { note: 'Projects/Roadmap.md' });
  assert.deepEqual(findRelated(graph, { path: 'Gamma.md', kind: 'project', q: 'beta' })[0]!.other, { task: 'Beta.md' });
});
