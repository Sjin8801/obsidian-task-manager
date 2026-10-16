import assert from 'node:assert/strict';
import test from 'node:test';
import { baseName, buildIndex, parseLink, resolveLink } from '../packages/tasknotes/links.ts';

const link = (raw: string) => parseLink(raw)!;
const index = buildIndex([
  'TaskNotes/Tasks/Write report.md', 'TaskNotes/Tasks/Review.md', 'TaskNotes/Tasks/sub/Deploy.md',
  'Projects/Alpha.md', 'Projects/Review.md', 'Notes/Daily/2026-09-30.md', 'Notes/readme.md', 'Notes/Case.md', 'Other/case.md',
]);
const tasks = new Set(['TaskNotes/Tasks/Write report.md', 'TaskNotes/Tasks/Review.md', 'TaskNotes/Tasks/sub/Deploy.md']);
const at = (raw: string, source = 'TaskNotes/Tasks/Write report.md', scope?: ReadonlySet<string>) => resolveLink(link(raw), source, index, scope);

test('the forms TaskNotes writes are parsed into target, alias and anchor', () => {
  assert.deepEqual(link('[[Project A]]'), { raw: '[[Project A]]', target: 'Project A', alias: null, anchor: null, format: 'wikilink', isRelative: false });
  assert.deepEqual(link('[[projects/alpha|Alpha Project]]'), { raw: '[[projects/alpha|Alpha Project]]', target: 'projects/alpha', alias: 'Alpha Project', anchor: null, format: 'wikilink', isRelative: false });
  const anchored = link('[[docs/api#auth|Auth]]'); assert.equal(anchored.target, 'docs/api'); assert.equal(anchored.anchor, 'auth'); assert.equal(anchored.alias, 'Auth');
  assert.equal(link('[[./sibling]]').isRelative, true); assert.equal(link('[[../up/x]]').isRelative, true);
  const md = link('[Docs](my%20docs/api.md#top)'); assert.deepEqual([md.format, md.target, md.alias, md.anchor], ['markdown', 'my docs/api.md', 'Docs', 'top']);
  assert.deepEqual([link('folder/file.md').format, link('folder/file.md').target], ['path', 'folder/file.md']);
  assert.equal(link('  [[padded]]  ').target, 'padded');
});

test('what is not a link is not guessed at', () => {
  for (const bad of [null, undefined, 5, {}, [], '', '   ', '[[]]', '[[ ]]', '[[a', 'a]]', '[x](  )', '[[a]] and [[b]]', '[not a link']) assert.equal(parseLink(bad), null, JSON.stringify(bad));
});

test('a simple name is found among all notes, and only task notes when the link is a blocker', () => {
  assert.deepEqual(at('[[Alpha]]'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('[[Alpha|The alpha project]]'), { path: 'Projects/Alpha.md', reason: null }, 'an alias does not change where it points');
  assert.deepEqual(at('[[Write report]]'), { path: 'TaskNotes/Tasks/Write report.md', reason: null });
  assert.deepEqual(at('[[Missing]]'), { path: null, reason: 'not_found' });
  // Review exists as a task and as a project note: ambiguous as a project, unambiguous as a blocker.
  assert.deepEqual(at('[[Review]]'), { path: null, reason: 'ambiguous' });
  assert.deepEqual(at('[[Review]]', 'TaskNotes/Tasks/Write report.md', tasks), { path: 'TaskNotes/Tasks/Review.md', reason: null });
  assert.deepEqual(at('[[Alpha]]', 'TaskNotes/Tasks/Write report.md', tasks), { path: null, reason: 'not_found' }, 'a blocker must be a task');
});

test('capitalisation is forgiven, unless the exact one is also there', () => {
  assert.deepEqual(at('[[alpha]]'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('[[ALPHA.md]]'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('[[Case]]'), { path: 'Notes/Case.md', reason: null }, 'two notes differing only by case: the one written exactly');
  assert.deepEqual(at('[[case]]'), { path: 'Other/case.md', reason: null });
  assert.deepEqual(at('[[CASE]]'), { path: null, reason: 'ambiguous' });
});

test('a path is read from the vault root, a relative path from the note, and a leading slash from the root', () => {
  assert.deepEqual(at('[[Projects/Alpha]]'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('[[projects/alpha.md]]'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('[[/Projects/Alpha]]'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('[[./Review]]'), { path: 'TaskNotes/Tasks/Review.md', reason: null });
  assert.deepEqual(at('[[../../Projects/Alpha]]'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('[[./Deploy]]', 'TaskNotes/Tasks/sub/other.md'), { path: 'TaskNotes/Tasks/sub/Deploy.md', reason: null });
  assert.deepEqual(at('[[Projects/Missing]]'), { path: null, reason: 'not_found' });
});

test('markdown links and bare paths are relative to the note unless they start with a slash', () => {
  assert.deepEqual(at('[Review](Review.md)'), { path: 'TaskNotes/Tasks/Review.md', reason: null });
  assert.deepEqual(at('[Alpha](../../Projects/Alpha.md)'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('[Alpha](/Projects/Alpha.md)'), { path: 'Projects/Alpha.md', reason: null });
  assert.deepEqual(at('../../Notes/readme.md'), { path: 'Notes/readme.md', reason: null });
  assert.deepEqual(at('[Docs](sub/Deploy)'), { path: 'TaskNotes/Tasks/sub/Deploy.md', reason: null }, 'no extension means .md');
});

test('a link can never leave the vault', () => {
  assert.deepEqual(at('[[../../../../etc/passwd]]'), { path: null, reason: 'path_traversal' });
  assert.deepEqual(at('[x](../../../outside.md)'), { path: null, reason: 'path_traversal' });
  assert.deepEqual(at('[[../../..]]', 'a.md'), { path: null, reason: 'path_traversal' });
});

test('names and paths are taken apart the same way everywhere', () => {
  assert.equal(baseName('TaskNotes/Tasks/Write report.md'), 'Write report'); assert.equal(baseName('Alone.md'), 'Alone'); assert.equal(baseName('A/B.MD'), 'B');
  assert.equal(buildIndex([]).paths.length, 0);
  assert.deepEqual(resolveLink(link('[[x]]'), 'a.md', buildIndex([])), { path: null, reason: 'not_found' });
});
