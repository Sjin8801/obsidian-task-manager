import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTask, previewScalarPatch, revisionOf, selectToday, dateKey, localDate } from '../packages/tasknotes/task.ts';

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}.md`, import.meta.url), 'utf8');
const today = new Date('2026-09-14T01:00:00Z');
const minimal = (fields: string) => `---\ntags: [task]\n상태: 시작\n우선순위: normal\n${fields}\n---\n\n본문\n`;

test('legacy missing title falls back to filename and keeps raw priority', async () => {
  const task = parseTask('제목 없는 작업.md', await fixture('제목 없는 작업'));
  assert.equal(task.title, '제목 없는 작업');
  assert.equal(task.titleSource, 'filename');
  assert.equal(task.priority, 'normal');
  assert.equal(task.rawPriority, 'Normal');
  assert.equal(task.scheduled, '2026-09-13T15:00:00Z');
  assert.equal(selectToday([task], today).today.length, 1);
});

test('scheduled today and overdue appears once; completion date appears in completed', async () => {
  const task = parseTask('일반 작업.md', await fixture('일반 작업'));
  const done = parseTask('완료 작업.md', await fixture('완료 작업'));
  const result = selectToday([task, task, done], today);
  assert.equal(result.today.length, 1);
  assert.equal(result.overdue.length, 0);
  assert.equal(result.completed.length, 1);
  assert.equal(selectToday([task], today, 'personal').today.length, 0);
});

test('past scheduled alone is not overdue; unknown status stays visible with warning', () => {
  const past = parseTask('past.md', minimal('예정일: 2026-09-13'));
  const overdue = parseTask('overdue.md', minimal('마감일: 2026-09-13'));
  const unknown = parseTask('unknown.md', minimal('예정일: 2026-09-14').replace('상태: 시작', '상태: 새로운상태'));
  const result = selectToday([past, overdue, unknown], today);
  assert.deepEqual(result.overdue.map(t => t.path), ['overdue.md']);
  assert.equal(result.today[0]?.status, 'unknown');
  assert.ok(result.today[0]?.warnings.includes('UNKNOWN_STATUS'));
});

test('Korea midnight, leap days and invalid or ambiguous timestamps', () => {
  assert.equal(localDate(new Date('2026-09-13T14:59:59Z')), '2026-09-13');
  assert.equal(localDate(new Date('2026-09-13T15:00:00Z')), '2026-09-14');
  assert.equal(dateKey('2026-09-14'), '2026-09-14');
  assert.equal(dateKey('2024-02-29'), '2024-02-29');
  for (const value of ['2026-02-29', '2026-02-30T10:00:00Z', '2026-09-14T24:00:00Z', '2026-09-14T24:00', '2026-09-14T10:60', '2026-09-14 10:00']) {
    assert.equal(dateKey(value), null, value);
  }
  // A time with no zone is a time on the Seoul clock: TaskNotes writes 2026-09-14T10:00 that way, and the app works in Seoul time.
  assert.equal(dateKey('2026-09-14T10:00:00'), '2026-09-14');
  assert.equal(dateKey('2026-09-14T10:00'), '2026-09-14');
  assert.equal(dateKey('2026-09-14T23:59'), '2026-09-14', 'no zone conversion moves it to another day');
});

test('scalar preview preserves all bytes outside changed values including body and comments', async () => {
  const raw = await fixture('일반 작업');
  const patched = previewScalarPatch(raw, revisionOf(raw), { 상태: '완료' });
  assert.equal(patched, raw.replace('상태: 시작 #', '상태: 완료 #'));
  assert.equal(parseTask('task.md', patched).rawPriority, 'High');
  assert.equal(previewScalarPatch(raw, revisionOf(raw), { 상태: '시작' }), raw);
});

test('preview preserves CRLF and BOM and safely quotes punctuation', async () => {
  const raw = '\uFEFF' + (await fixture('일반 작업')).replace(/\r?\n/g, '\r\n');
  const patched = previewScalarPatch(raw, revisionOf(raw), { title: '테스트: 확인 #1', 완료일: '2026-09-14' });
  assert.equal(parseTask('task.md', patched).title, '테스트: 확인 #1');
  assert.equal(parseTask('task.md', patched).completed, '2026-09-14');
  assert.ok(patched.startsWith('\uFEFF---\r\n'));
  assert.ok(!/(?<!\r)\n/.test(patched));
  assert.equal(parseTask('task.md', patched).body, parseTask('task.md', raw).body);
});

test('stale revisions and unsafe scalar structures fail without changing input', () => {
  const raw = minimal('title: before');
  assert.throws(() => previewScalarPatch(raw, 'outdated', { title: 'after' }), /REVISION_CONFLICT/);
  assert.throws(() => previewScalarPatch(raw, revisionOf(raw), { tags: 'task' }), /UNSUPPORTED_PATCH/);
  const anchored = minimal('title: &title before\nalias: *title');
  assert.throws(() => previewScalarPatch(anchored, revisionOf(anchored), { title: 'after' }), /UNSUPPORTED_PATCH/);
});

test('malformed frontmatter, duplicate keys, non-tasks and traversal are rejected', () => {
  assert.throws(() => parseTask('task.md', 'body only'), /MISSING_FRONTMATTER/);
  assert.throws(() => parseTask('task.md', minimal('상태: 완료')), /INVALID_FRONTMATTER/);
  assert.throws(() => parseTask('task.md', minimal('').replace('tags: [task]', 'tags: [note]')), /NOT_A_TASK/);
  for (const path of ['../task.md', '/task.md', 'a/../task.md', 'a\\task.md', 'C:task.md', 'task.md:stream', 'a//task.md']) {
    assert.throws(() => parseTask(path, minimal('')), /INVALID_PATH/);
  }
});

test('recurrence is detected and marked unsupported instead of silently treated as ordinary', () => {
  const task = parseTask('task.md', minimal('recurrence: FREQ=DAILY\n예정일: 2026-09-14'));
  assert.equal(task.recurring, true);
  assert.ok(task.warnings.includes('RECURRENCE_NOT_IMPLEMENTED'));
});

test('prototype-like states are unknown and malformed tag arrays are rejected', () => {
  const task = parseTask('task.md', minimal('').replace('상태: 시작', '상태: __proto__'));
  assert.equal(task.status, 'unknown');
  assert.throws(() => parseTask('task.md', minimal('').replace('tags: [task]', 'tags: [task, 123]')), /INVALID_TAGS/);
});
