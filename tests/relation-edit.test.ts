import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTask, previewRelationPatch, revisionOf, TaskDataError } from '../packages/tasknotes/task.ts';
import { defaultRelationFieldNames } from '../packages/contracts/fields.ts';

const names = defaultRelationFieldNames;
const note = (yaml: string, eol = '\n') => `---${eol}${yaml.replace(/\n/g, eol)}${eol}---${eol}본문 첫 줄${eol}둘째 줄`;
const add = (raw: string, kind: 'project' | 'blockedBy', link: string) => previewRelationPatch(raw, revisionOf(raw), { kind, names, remove: () => false, add: link });
const drop = (raw: string, kind: 'project' | 'blockedBy', link: string) => previewRelationPatch(raw, revisionOf(raw), { kind, names, remove: l => l === link, add: null });
const projectsOf = (raw: string) => parseTask('t.md', raw).projects;
const blockersOf = (raw: string) => parseTask('t.md', raw).blockedBy;
const base = 'tags: [task]\ntitle: 작업\n상태: 시작';

test('a project is added to a note that has none, as a quoted list at the end', () => {
  const out = add(note(base), 'project', '[[로드맵]]');
  assert.deepEqual(projectsOf(out), ['[[로드맵]]']);
  assert.equal(out, note(base + '\nprojects:\n  - "[[로드맵]]"'));
});
test('a project is appended to a block list and the other lines stay exactly as they were', () => {
  const raw = note(base + '\nprojects:\n  - "[[A]]"\n# 메모\n우선순위: high');
  const out = add(raw, 'project', '[[B]]');
  assert.equal(out, note(base + '\nprojects:\n  - "[[A]]"\n  - "[[B]]"\n# 메모\n우선순위: high'));
  assert.deepEqual(projectsOf(out), ['[[A]]', '[[B]]']);
});
test('one project is taken out of a list, the others and the rest of the note are untouched', () => {
  const raw = note(base + '\nprojects:\n  - "[[A]]"\n  - "[[B]]"\n  - "[[C]]"\n우선순위: high');
  const out = drop(raw, 'project', '[[B]]');
  assert.equal(out, note(base + '\nprojects:\n  - "[[A]]"\n  - "[[C]]"\n우선순위: high'));
});
test('taking out the last project removes the property', () => {
  const raw = note(base + '\nprojects:\n  - "[[A]]"\n우선순위: high');
  assert.equal(drop(raw, 'project', '[[A]]'), note(base + '\n우선순위: high'));
  const last = note(base + '\nprojects:\n  - "[[A]]"');
  assert.equal(drop(last, 'project', '[[A]]'), note(base));
  assert.equal(drop(note('projects: "[[A]]"\n' + base), 'project', '[[A]]'), note(base));
});
test('a single link written as a plain value becomes a list when another is added', () => {
  const out = add(note(base + '\nprojects: "[[A]]"\n우선순위: high'), 'project', '[[B]]');
  assert.deepEqual(projectsOf(out), ['[[A]]', '[[B]]']);
  assert.match(out, /우선순위: high/);
});
test('a flow list stays a flow list', () => {
  const out = add(note(base + '\nprojects: ["[[A]]", "[[B]]"]'), 'project', '[[C]]');
  assert.match(out, /^projects: \[ ?"\[\[A\]\]", "\[\[B\]\]", "\[\[C\]\]" ?\]$/m);
  assert.deepEqual(projectsOf(out), ['[[A]]', '[[B]]', '[[C]]']);
});
test('an unquoted [[Name]], which YAML reads as a list in a list, is written back as the quoted link it stands for', () => {
  const raw = note(base + '\nprojects:\n  - [[A]]\n  - "[[B]]"');
  assert.deepEqual(projectsOf(raw), ['[[A]]', '[[B]]']);
  const out = drop(raw, 'project', '[[B]]');
  assert.deepEqual(projectsOf(out), ['[[A]]']);
  const added = add(raw, 'project', '[[C]]');
  assert.deepEqual(projectsOf(added), ['[[A]]', '[[B]]', '[[C]]']);
});
test('a property with nothing after it is filled in', () => {
  const out = add(note(base + '\nprojects:\n우선순위: high'), 'project', '[[A]]');
  assert.deepEqual(projectsOf(out), ['[[A]]']);
  assert.match(out, /우선순위: high/);
  assert.equal(drop(note(base + '\nprojects:'), 'project', '[[A]]'), note(base + '\nprojects:'), 'nothing to take out leaves the note as it is');
});
test('Windows line endings and a byte order mark are kept', () => {
  const raw = '﻿' + note(base + '\nprojects:\n  - "[[A]]"\n우선순위: high', '\r\n');
  const out = add(raw, 'project', '[[B]]');
  assert.equal(out, '﻿' + note(base + '\nprojects:\n  - "[[A]]"\n  - "[[B]]"\n우선순위: high', '\r\n'));
  assert.equal(drop(out, 'project', '[[A]]'), '﻿' + note(base + '\nprojects:\n  - "[[B]]"\n우선순위: high', '\r\n'));
  assert.equal(drop(add(raw, 'project', '[[B]]'), 'project', '[[B]]'), raw);
  const empty = '﻿' + note(base + '\nprojects:\n우선순위: high', '\r\n');
  assert.equal(add(empty, 'project', '[[A]]'), '﻿' + note(base + '\nprojects:\n  - "[[A]]"\n우선순위: high', '\r\n'));
});
test('a blocker is written as TaskNotes writes it, and other entries keep their gap and kind', () => {
  const raw = note(base + '\nblockedBy:\n  - uid: "[[A]]"\n    reltype: STARTTOSTART\n    gap: P1D');
  const out = add(raw, 'blockedBy', '[[B]]');
  assert.deepEqual(blockersOf(out), [{ uid: '[[A]]', reltype: 'STARTTOSTART', gap: 'P1D' }, { uid: '[[B]]', reltype: 'FINISHTOSTART', gap: null }]);
  assert.match(out, /blockedBy:\n {2}- uid: "\[\[A\]\]"\n {4}reltype: STARTTOSTART\n {4}gap: P1D\n {2}- uid: "\[\[B\]\]"\n {4}reltype: FINISHTOSTART/);
  const first = add(note(base), 'blockedBy', '[[A]]');
  assert.deepEqual(blockersOf(first), [{ uid: '[[A]]', reltype: 'FINISHTOSTART', gap: null }]);
  assert.deepEqual(blockersOf(drop(out, 'blockedBy', '[[A]]')), [{ uid: '[[B]]', reltype: 'FINISHTOSTART', gap: null }]);
  assert.equal(drop(first, 'blockedBy', '[[A]]'), note(base));
});
test('the snake_case spelling of blockedBy is edited under the name the note uses', () => {
  const raw = note(base + '\nblocked_by:\n  - uid: "[[A]]"');
  const out = add(raw, 'blockedBy', '[[B]]');
  assert.match(out, /blocked_by:/); assert(!/^blockedBy:/m.test(out));
  assert.deepEqual(blockersOf(out).map(b => b.uid), ['[[A]]', '[[B]]']);
});
test('a name set in the TaskNotes settings is the one written to a note that has none', () => {
  const raw = note(base);
  const custom = { projects: 'parent', blockedBy: 'blockedBy' };
  const out = previewRelationPatch(raw, revisionOf(raw), { kind: 'project', names: custom, remove: () => false, add: '[[A]]' });
  assert.match(out, /^parent:\n {2}- "\[\[A\]\]"/m);
  assert.deepEqual(parseTask('t.md', out, undefined, undefined, custom).projects, ['[[A]]']);
});
test('entries that are not links are left alone, and a change to a stale note is refused', () => {
  const raw = note(base + '\nprojects:\n  - "[[A]]"\n  - 그냥 글자[는 링크 아님]');
  const out = add(raw, 'project', '[[B]]');
  assert.match(out, /그냥 글자\[는 링크 아님\]/);
  assert.throws(() => previewRelationPatch(raw, 'f'.repeat(64), { kind: 'project', names, remove: () => false, add: '[[B]]' }), (e: unknown) => e instanceof TaskDataError && e.code === 'REVISION_CONFLICT');
});
test('nothing to take out and nothing to add returns the very same text', () => {
  const raw = note(base + '\nprojects:\n  - "[[A]]"');
  assert.equal(drop(raw, 'project', '[[없음]]'), raw);
  assert.equal(previewRelationPatch(raw, revisionOf(raw), { kind: 'project', names, remove: () => false, add: null }), raw);
});
test('a list that cannot be edited safely is refused, not rewritten', () => {
  assert.throws(() => add(note(base + '\nprojects: 12'), 'project', '[[A]]'), (e: unknown) => e instanceof TaskDataError && e.code === 'UNSUPPORTED_PATCH');
  assert.throws(() => add(note(base + '\nprojects: &p\n  - "[[A]]"'), 'project', '[[B]]'), (e: unknown) => e instanceof TaskDataError);
});
