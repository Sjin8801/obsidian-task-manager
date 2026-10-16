import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex } from '../packages/tasknotes/links.ts';
import { buildRelations, nestSubtasks, readBlockedBy, readProjects, type RelationTask } from '../packages/tasknotes/relations.ts';
import type { TaskState } from '../packages/contracts/task.ts';

// Tasks live in TaskNotes/Tasks; projects are ordinary notes in Projects/. Nothing here depends on those folder names.
const task = (name: string, extra: Partial<RelationTask> & { state?: TaskState } = {}): RelationTask => ({
  id: name, path: `${name}.md`, vaultPath: `TaskNotes/Tasks/${name}.md`, title: name, status: extra.state ?? 'open', rawStatus: null, scheduled: null, due: null, projects: [], blockedBy: [], ...extra,
});
const dep = (uid: string, reltype = 'FINISHTOSTART', gap: string | null = null) => ({ uid, reltype, gap });
const notes = ['Projects/Alpha.md', 'Projects/Beta.md', 'Archive/Beta.md', 'Notes/Reference.md'];
const build = (tasks: RelationTask[]) => buildRelations(tasks, buildIndex([...tasks.map(t => t.vaultPath), ...notes]));

test('a task points at a project note, and the project is not a task', () => {
  const r = build([task('Draft', { projects: ['[[Alpha]]', '[[Projects/Beta|The Beta effort]]'] })]).get('Draft')!;
  assert.deepEqual(r.projects.map(p => [p.name, p.path, p.task, p.unresolved]), [['Alpha', 'Projects/Alpha.md', null, null], ['The Beta effort', 'Projects/Beta.md', null, null]]);
  assert.deepEqual([r.subtasks, r.blockedBy, r.blocking, r.blocked], [[], [], [], false]);
});

test('a task pointing at another task makes that one a parent, and the other side sees a subtask', () => {
  const all = build([task('Parent'), task('Child B', { projects: ['[[Parent]]'] }), task('Child A', { projects: ['[[Parent]]', '[[Alpha]]'], state: 'done' }), task('Loner')]);
  const parent = all.get('Parent')!;
  assert.deepEqual(parent.subtasks.map(t => t.title), ['Child B', 'Child A'], 'still to do first, then finished');
  assert.equal(parent.subtasksDone, 1);
  assert.deepEqual(parent.projects, [], 'the parent itself belongs to nothing: subtasks are only recorded on the child');
  const child = all.get('Child A')!;
  assert.deepEqual(child.projects.map(p => [p.name, p.task?.id ?? null]), [['Parent', 'Parent'], ['Alpha', null]]);
  assert.deepEqual(all.get('Loner')!.subtasks, []);
});

test('blockers: unfinished or missing ones block, a finished one does not, and the other side sees what it blocks', () => {
  const all = build([
    task('Blocker open'), task('Blocker done', { state: 'done' }),
    task('Waits on open', { blockedBy: [dep('[[Blocker open]]', 'FINISHTOSTART', 'P1D')] }),
    task('Waits on done', { blockedBy: [dep('[[Blocker done]]')] }),
    task('Waits on missing', { blockedBy: [dep('[[Nothing like it]]')] }),
    task('Waits on both', { blockedBy: [dep('[[Blocker done]]'), dep('[[Blocker open]]', 'STARTTOSTART')] }),
  ]);
  const opens = all.get('Waits on open')!;
  assert.equal(opens.blocked, true); assert.deepEqual(opens.blockedBy.map(d => [d.name, d.reltype, d.gap, d.done, d.unresolved]), [['Blocker open', 'FINISHTOSTART', 'P1D', false, null]]);
  assert.equal(all.get('Waits on done')!.blocked, false); assert.equal(all.get('Waits on done')!.blockedBy[0]!.done, true);
  const missing = all.get('Waits on missing')!;
  assert.equal(missing.blocked, true); assert.deepEqual([missing.blockedBy[0]!.task, missing.blockedBy[0]!.unresolved, missing.blockedBy[0]!.done], [null, 'not_found', false]);
  assert.equal(all.get('Waits on both')!.blocked, true);
  assert.deepEqual(all.get('Blocker open')!.blocking.map(t => t.title), ['Waits on both', 'Waits on open'], 'blocking is the other side of blockedBy');
  assert.deepEqual(all.get('Blocker done')!.blocking.map(t => t.title), ['Waits on both', 'Waits on done']);
});

test('a blocker has to be a task: a note of the same name is not one', () => {
  const all = build([task('Alpha'), task('Needs alpha', { blockedBy: [dep('[[Alpha]]')] })]);
  assert.equal(all.get('Needs alpha')!.blockedBy[0]!.task?.id, 'Alpha');
  const none = build([task('Needs project note', { blockedBy: [dep('[[Reference]]')] })]).get('Needs project note')!;
  assert.deepEqual([none.blockedBy[0]!.task, none.blockedBy[0]!.unresolved, none.blocked], [null, 'not_found', true]);
});

test('an ambiguous or unresolved project is kept, named, and marked, not dropped or guessed', () => {
  const r = build([task('Lost', { projects: ['[[Beta]]', '[[Not there]]', '[[Not there|Shown name]]'] })]).get('Lost')!;
  assert.deepEqual(r.projects.map(p => [p.name, p.path, p.unresolved]), [['Beta', null, 'ambiguous'], ['Not there', null, 'not_found'], ['Shown name', null, 'not_found']]);
});

test('a task that links to itself is ignored, and a loop between two tasks does not hang', () => {
  const alone = build([task('Self', { projects: ['[[Self]]'], blockedBy: [dep('[[Self]]')] })]).get('Self')!;
  assert.deepEqual([alone.projects, alone.subtasks, alone.blockedBy, alone.blocking, alone.blocked], [[], [], [], [], false]);
  const loop = build([task('One', { projects: ['[[Two]]'], blockedBy: [dep('[[Two]]')] }), task('Two', { projects: ['[[One]]'], blockedBy: [dep('[[One]]')] })]);
  assert.deepEqual([loop.get('One')!.subtasks.map(t => t.id), loop.get('One')!.blocking.map(t => t.id), loop.get('One')!.blocked], [['Two'], ['Two'], true]);
});

test('paths and relative links resolve from where the task lives', () => {
  const nested: RelationTask = { ...task('Deep', { projects: ['[[../Parent]]', '[[../../../Projects/Alpha]]'] }), vaultPath: 'TaskNotes/Tasks/sub/Deep.md' };
  const parent: RelationTask = task('Parent');
  const r = buildRelations([nested, parent], buildIndex([nested.vaultPath, parent.vaultPath, ...notes])).get('Deep')!;
  assert.deepEqual(r.projects.map(p => [p.name, p.path]), [['Parent', 'TaskNotes/Tasks/Parent.md'], ['Alpha', 'Projects/Alpha.md']]);
});

test('projects are read from one link, a list, or an unquoted [[link]] that YAML turned into a list', () => {
  assert.deepEqual(readProjects('[[A]]'), ['[[A]]']);
  assert.deepEqual(readProjects(['[[A]]', '[[B|b]]']), ['[[A]]', '[[B|b]]']);
  assert.deepEqual(readProjects([['A']]), ['[[A]]'], 'projects: [[A]] without quotes');
  assert.deepEqual(readProjects([['A'], '[[B]]']), ['[[A]]', '[[B]]']);
  for (const empty of [null, undefined, '', [], [''], [null, 5, {}], '   ']) assert.deepEqual(readProjects(empty), [], JSON.stringify(empty));
  assert.deepEqual(readProjects('Notes/plain.md'), ['Notes/plain.md'], 'a plain path is a link too');
});

test('blockedBy is read as { uid, reltype, gap }, with the default type and bare links accepted', () => {
  assert.deepEqual(readBlockedBy([{ uid: '[[A]]', reltype: 'STARTTOSTART', gap: 'PT4H' }]), [{ uid: '[[A]]', reltype: 'STARTTOSTART', gap: 'PT4H' }]);
  assert.deepEqual(readBlockedBy([{ uid: '[[A]]' }]), [{ uid: '[[A]]', reltype: 'FINISHTOSTART', gap: null }]);
  assert.deepEqual(readBlockedBy(['[[A]]', { uid: [['B']] }]), [{ uid: '[[A]]', reltype: 'FINISHTOSTART', gap: null }, { uid: '[[B]]', reltype: 'FINISHTOSTART', gap: null }]);
  assert.equal(readBlockedBy([{ uid: '[[A]]', reltype: 'SOMETHINGNEW' }])[0]!.reltype, 'SOMETHINGNEW', 'a type we do not know is kept as written');
  for (const empty of [null, undefined, [], {}, [{}], [{ uid: '' }], [{ uid: 5 }], [null], 5]) assert.deepEqual(readBlockedBy(empty), [], JSON.stringify(empty));
});

test('a task is named by its title, a note by its file name, and an alias in the link wins over both', () => {
  const titled: RelationTask = { ...task('file-name'), title: 'A nicer title' };
  const user = task('User', { projects: ['[[file-name]]', '[[file-name|my words]]', '[[Alpha]]'], blockedBy: [dep('[[file-name]]'), dep('[[file-name|called this]]')] });
  const r = buildRelations([titled, user], buildIndex([titled.vaultPath, user.vaultPath, ...notes])).get('User')!;
  assert.deepEqual(r.projects.map(p => p.name), ['A nicer title', 'my words', 'Alpha']);
  assert.deepEqual(r.blockedBy.map(d => d.name), ['A nicer title', 'called this']);
});

test('a subtask is shown under its parent when both are listed, and on its own when the parent is not', () => {
  const tasks = [task('Parent'), task('Child', { projects: ['[[Parent]]'] }), task('Orphan', { projects: ['[[Other parent]]'] }), task('Plain'), task('Other parent')];
  const all = Object.fromEntries(build(tasks));
  const list = (names: string[]) => nestSubtasks(tasks.filter(t => names.includes(t.id)), all);
  const both = list(['Parent', 'Child', 'Plain']);
  assert.deepEqual(both.roots.map(t => t.id), ['Parent', 'Plain']); assert.deepEqual([...both.nested], ['Child']);
  const alone = list(['Child', 'Plain']);
  assert.deepEqual(alone.roots.map(t => t.id), ['Child', 'Plain'], 'the parent is not in this list, so the child keeps its own row'); assert.equal(alone.nested.size, 0);
  assert.deepEqual(list(['Orphan']).roots.map(t => t.id), ['Orphan']);
});

test('nesting goes one level, handles several parents, and never makes a task disappear', () => {
  const tasks = [task('Top'), task('Middle', { projects: ['[[Top]]'] }), task('Bottom', { projects: ['[[Middle]]'] }), task('Two parents', { projects: ['[[Top]]', '[[Other top]]'] }), task('Other top')];
  const all = Object.fromEntries(build(tasks));
  const r = nestSubtasks(tasks, all);
  assert.deepEqual(r.roots.map(t => t.id).sort(), ['Bottom', 'Other top', 'Top'], 'Bottom has a parent that is itself nested, so it stays on its own');
  assert.deepEqual([...r.nested].sort(), ['Middle', 'Two parents']);
  // Tasks that are each other's parents all stay on their own.
  const loop = [task('One', { projects: ['[[Two]]'] }), task('Two', { projects: ['[[One]]'] })];
  assert.deepEqual(nestSubtasks(loop, Object.fromEntries(build(loop))).roots.map(t => t.id), ['One', 'Two']);
  assert.deepEqual(nestSubtasks([], {}).roots, []);
  assert.deepEqual(nestSubtasks([task('No relations known')], {}).roots.map(t => t.id), ['No relations known']);
});
