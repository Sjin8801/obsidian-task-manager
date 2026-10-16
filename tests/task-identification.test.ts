import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultIdentification, isTaskFrontmatter, parseIdentification } from '../packages/contracts/identification.ts';
import { isTaskNote, parseTask } from '../packages/tasknotes/task.ts';
import { readTaskNotesSettings } from '../apps/desktop/status-config.ts';
import { LocalVault } from '../apps/desktop/local-vault.ts';

test('the TaskNotes settings say how a task is recognised; anything incomplete means the task tag', () => {
  assert.deepEqual(parseIdentification({}), defaultIdentification);
  assert.deepEqual(parseIdentification({ taskTag: '#todo' }), { method: 'tag', tag: 'todo' });
  assert.deepEqual(parseIdentification({ taskTag: '  ' }), defaultIdentification);
  assert.deepEqual(parseIdentification({ taskIdentificationMethod: 'property', taskPropertyName: 'type', taskPropertyValue: 'task' }), { method: 'property', name: 'type', value: 'task' });
  assert.deepEqual(parseIdentification({ taskIdentificationMethod: 'property', taskPropertyName: 'type', taskPropertyValue: '' }), defaultIdentification);
});

test('a tag matches itself or a tag under it, in any case, like TaskNotes', () => {
  const todo = { method: 'tag', tag: 'todo' } as const;
  assert.equal(isTaskFrontmatter({ tags: ['Todo'] }, todo), true);
  assert.equal(isTaskFrontmatter({ tags: '#todo/work' }, todo), true);
  assert.equal(isTaskFrontmatter({ tags: ['todos'] }, todo), false);
  assert.equal(isTaskFrontmatter({ tags: ['task'] }, todo), false);
  assert.equal(isTaskFrontmatter({}, todo), false);
});

test('a property matches its value, a list item, or true/false written as text', () => {
  const byType = { method: 'property', name: 'type', value: 'task' } as const;
  assert.equal(isTaskFrontmatter({ type: 'task' }, byType), true);
  assert.equal(isTaskFrontmatter({ type: ['note', 'task'] }, byType), true);
  assert.equal(isTaskFrontmatter({ type: 'Task' }, byType), false);
  assert.equal(isTaskFrontmatter({ tags: ['task'] }, byType), false, 'the tag no longer counts');
  const flag = { method: 'property', name: 'isTask', value: 'true' } as const;
  assert.equal(isTaskFrontmatter({ isTask: true }, flag), true);
  assert.equal(isTaskFrontmatter({ isTask: false }, flag), false);
});

test('a note recognised by a property is read and needs no tags', () => {
  const byType = { method: 'property', name: 'type', value: 'task' } as const;
  const raw = '---\ntype: task\nstatus: open\nscheduled: 2026-09-30\n---\nbody\n';
  assert.equal(isTaskNote(raw, byType), true);
  assert.equal(isTaskNote(raw), false);
  const task = parseTask('a.md', raw, undefined, undefined, undefined, byType);
  assert.deepEqual(task.tags, []);
  assert.equal(task.scheduled, '2026-09-30');
  assert.throws(() => parseTask('a.md', raw), /NOT_A_TASK/);
});

test('a vault whose TaskNotes settings use a property lists those notes', async t => {
  const vault = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-identification-')));
  t.after(() => rm(vault, { recursive: true, force: true }));
  await mkdir(path.join(vault, '.obsidian', 'plugins', 'tasknotes'), { recursive: true });
  await writeFile(path.join(vault, '.obsidian', 'plugins', 'tasknotes', 'data.json'), JSON.stringify({ taskIdentificationMethod: 'property', taskPropertyName: 'kind', taskPropertyValue: 'task' }));
  await writeFile(path.join(vault, 'by-property.md'), '---\nkind: task\nstatus: open\nscheduled: 2026-09-30\n---\n');
  await writeFile(path.join(vault, 'by-tag.md'), '---\ntags: [task]\nstatus: open\nscheduled: 2026-09-30\n---\n');
  assert.deepEqual((await readTaskNotesSettings(vault)).identification, { method: 'property', name: 'kind', value: 'task' });
  const agenda = await new LocalVault({ vaultPath: vault, taskRelativePath: '.' }).agenda('all', new Date('2026-09-30T03:00:00Z'));
  assert.deepEqual(agenda.today.map(task => task.path), ['by-property.md']);
});
