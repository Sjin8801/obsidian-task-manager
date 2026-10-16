import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTask } from '../packages/tasknotes/task.ts';
import { categoryOf } from '../apps/desktop/categories.ts';
import { findPetTask, fitPeekHeight, isListed, peekChrome, peekMaxHeight, peekMinHeight, petBounds, petErrorText, raiseEveryMs, readPetPreferences, shouldRaise, rollGap, rollSeconds, rollSpeed, statusChoices, summarizePet, undoStatus, type PetTask } from '../apps/desktop/pet-model.ts';
import { defaultStatuses } from '../packages/contracts/statuses.ts';
import type { Agenda } from '../apps/desktop/shared.ts';
const task = (name: string, status = '시작') => parseTask(name + '.md', `---\ntags: [task]\n상태: ${status}\n---\n`);
test('pet counts unique unfinished daily tasks, prioritizes progress and includes every task in the preview', () => {
  const one = task('one'), active = task('active', '진행 중'), done = task('done', '완료');
  const agenda: Agenda = { date: '2026-09-28', timezone: 'Asia/Seoul', fetchedAt: '', today: [one, active, task('three'), task('four')], overdue: [one], completed: [done], issues: [], statuses: [...defaultStatuses], relations: {} };
  const summary = summarizePet(agenda, 'vault');
  assert.equal(summary.total, 4); assert.equal(summary.tasks.length, 4); assert.equal(summary.tasks[0]?.id, active.id);
  assert(!('body' in summary.tasks[0]!)); assert.equal(summary.selectionKey, 'vault');
  assert.equal(summarizePet({ ...agenda, today: [], overdue: [], issues: [{ path: 'bad.md', code: 'READ_FAILED' }] }, 'vault').partial, true);
});
test('pet stays visible on negative-coordinate monitors and expands away from edges', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  for (const x of [-99999, -1920, -1900, -1000, -200, 99999]) for (const y of [-9999, 0, 10, 600, 1000, 99999]) {
    const compact = petBounds({ x, y }, false, area), expanded = petBounds(compact, true, area);
    assert(expanded.x >= area.x && expanded.x + expanded.width <= area.x + area.width);
    assert(expanded.y >= area.y && expanded.y + expanded.height <= area.y + area.height);
    assert.equal(expanded.x + (expanded.left ? 0 : expanded.width - compact.width), compact.x);
    assert.equal(expanded.y + (expanded.below ? 0 : expanded.height - compact.height), compact.y);
  }
});
test('expanded widget window shrinks to a short list and keeps the button where it was', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  // Default is the full-size window, so nothing shrinks until the panel reports a smaller height.
  assert.equal(petBounds({ x: 0, y: 500 }, true, { x: 0, y: 0, width: 1920, height: 1040 }).height, peekMaxHeight + peekChrome);
  const full = petBounds({ x: -1000, y: 600 }, true, area).height;
  for (const peek of [peekMinHeight, 120, 151, peekMaxHeight]) {
    const height = petBounds({ x: -1000, y: 600 }, true, area, peek).height;
    assert.equal(height, peek + peekChrome);
    assert(height <= full);
    for (const x of [-99999, -1920, -1000, -200, 99999]) for (const y of [-9999, 0, 10, 200, 600, 1000, 99999]) {
      const compact = petBounds({ x, y }, false, area), expanded = petBounds(compact, true, area, peek);
      assert(expanded.x >= area.x && expanded.x + expanded.width <= area.x + area.width);
      assert(expanded.y >= area.y && expanded.y + expanded.height <= area.y + area.height);
      assert.equal(expanded.x + (expanded.left ? 0 : expanded.width - compact.width), compact.x);
      assert.equal(expanded.y + (expanded.below ? 0 : expanded.height - compact.height), compact.y);
    }
  }
  // A short list fits above a button near the top edge that the full-size window would have pushed below.
  const near = petBounds({ x: -1000, y: 200 }, false, area);
  assert.equal(petBounds(near, true, area).below, true);
  assert.equal(petBounds(near, true, area, 100).below, false);
});
test('measured panel height is clamped to the supported range and ignores non-finite values', () => {
  assert.equal(fitPeekHeight(0), peekMinHeight);
  assert.equal(fitPeekHeight(-50), peekMinHeight);
  assert.equal(fitPeekHeight(150.2), 151);
  assert.equal(fitPeekHeight(peekMaxHeight), peekMaxHeight);
  assert.equal(fitPeekHeight(5000), peekMaxHeight);
  assert.equal(fitPeekHeight(NaN), peekMaxHeight);
  assert.equal(fitPeekHeight(Infinity), peekMaxHeight);
});
test('each preview task carries the category the task list shows for it', () => {
  const tagged = (name: string, tags: string) => parseTask(name + '.md', `---\ntags: [${tags}]\n상태: 시작\n---\n`);
  const tasks = { work: tagged('work', 'task, 업무'), plain: tagged('plain', 'task'), custom: tagged('custom', 'task, 보고서'), both: tagged('both', 'task, 업무, 보고서'), personal: tagged('personal', 'task, 개인') };
  const agenda: Agenda = { date: '2026-09-28', timezone: 'Asia/Seoul', fetchedAt: '', today: Object.values(tasks), overdue: [], completed: [], issues: [], statuses: [...defaultStatuses], relations: {} };
  const byName = (categories?: readonly string[]) => Object.fromEntries(summarizePet(agenda, 'vault', categories).tasks.map(t => [t.path.replace('.md', ''), t.category]));
  // Default categories: a task without a work tag counts as personal, and an unregistered tag does not create a category.
  assert.deepEqual(byName(), { work: '업무', plain: '개인', custom: '개인', both: '업무', personal: '개인' });
  // A category the user added shows up, and the first registered one wins when several tags match.
  assert.deepEqual(byName(['업무', '개인', '보고서']), { work: '업무', plain: '개인', custom: '보고서', both: '업무', personal: '개인' });
  assert.deepEqual(byName(['보고서', '업무', '개인']).both, '보고서');
  // The widget must never disagree with the list, which uses categoryOf too.
  for (const categories of [undefined, ['업무', '개인', '보고서'], ['보고서', '업무', '개인']] as const) {
    for (const t of summarizePet(agenda, 'vault', categories).tasks) assert.equal(t.category, categoryOf(Object.values(tasks).find(x => x.path === t.path)!, categories), `${t.path} with ${categories}`);
  }
  // Only what the panel needs is passed on (never the note body). revision and recurring are for changing the status from the list, scheduled and due are the dates the row shows.
  assert.deepEqual(Object.keys(summarizePet(agenda, 'vault').tasks[0]!).sort(), ['category', 'due', 'id', 'path', 'rawStatus', 'recurring', 'revision', 'scheduled', 'status', 'subtasks', 'subtasksDone', 'title']);
});
test('a long title flows at one steady speed and never faster than it can be read', () => {
  // One loop is the text plus the gap; the loop time follows from the speed, so short and long titles flow equally fast.
  assert.equal(rollSeconds(373), (373 + rollGap) / rollSpeed);
  for (const width of [200, 373, 800, 2000]) assert(Math.abs((width + rollGap) / rollSeconds(width) - rollSpeed) < 1e-9, `${width}px`);
  // Very short overflows keep a minimum loop time instead of racing past.
  for (const width of [1, 40, 90]) { assert.equal(rollSeconds(width), 2.5); assert((width + rollGap) / rollSeconds(width) < rollSpeed); }
  for (const bad of [0, -20, NaN, Infinity]) assert.equal(rollSeconds(bad), 6, String(bad));
});
test('invalid saved pet preferences recover without hiding the widget or accepting non-finite positions', () => {
  const fallback = { x: 500, y: 500, hidden: false, alwaysOnTop: true, peek: true };
  assert.deepEqual(readPetPreferences(null, fallback), fallback);
  assert.deepEqual(readPetPreferences({ x: Infinity, y: NaN, hidden: 'yes' }, fallback), fallback);
  assert.deepEqual(readPetPreferences({ x: -300, y: 40, hidden: true, alwaysOnTop: false, peek: false }, fallback), { x: -300, y: 40, hidden: true, alwaysOnTop: false, peek: false });
});
const listed = (over: Partial<PetTask> = {}): PetTask => ({ id: 'a', path: 'a.md', revision: 'r1', title: 'A', status: 'open', rawStatus: '시작', category: '업무', recurring: false, scheduled: null, due: null, subtasks: [], subtasksDone: 0, ...over });
const snapshotOf = (...tasks: PetTask[]) => ({ kind: 'ready' as const, total: tasks.length, tasks, partial: false, selectionKey: 'vault', statuses: [...defaultStatuses] });
test('the list carries what a status change needs: the note revision and whether it repeats', () => {
  const summary = summarizePet({ date: '2026-09-28', timezone: 'Asia/Seoul', fetchedAt: '', today: [parseTask('r.md', '---\ntags: [task]\nrecurrence: FREQ=DAILY\n---\n')], overdue: [], completed: [], issues: [], statuses: [...defaultStatuses], relations: {} }, 'vault');
  assert.equal(summary.tasks[0]!.recurring, true);
  assert.match(summary.tasks[0]!.revision, /^[a-f0-9]{64}$/);
});
test('a status request must point at a task in the list that is still on screen', () => {
  const snapshot = snapshotOf(listed(), listed({ id: 'b' }));
  assert.equal(findPetTask(snapshot, { id: 'b', selectionKey: 'vault' })?.id, 'b');
  for (const bad of [undefined, null, 'a', 5, {}, { id: 'a' }, { selectionKey: 'vault' }, { id: 7, selectionKey: 'vault' }, { id: 'a', selectionKey: 'other-vault' }, { id: 'gone', selectionKey: 'vault' }]) assert.equal(findPetTask(snapshot, bad), null, JSON.stringify(bad));
});
test('the status menu offers the same four statuses as the app and checks the current one', () => {
  assert.deepEqual(statusChoices(listed()).map(c => c.status), defaultStatuses.map(s => s.value));
  assert.deepEqual(statusChoices(listed({ rawStatus: 'in-progress' })).filter(c => c.checked).map(c => c.status), ['in-progress']);
  assert.deepEqual(statusChoices(listed({ rawStatus: '진행 중' })).filter(c => c.checked).map(c => c.status), ['in-progress'], 'a Korean value in a note is recognised too');
  const korean = [{ value: '없음', label: '없음', color: null, completed: false }, { value: '시작', label: '시작', color: null, completed: false }, { value: '진행 중', label: '진행 중', color: null, completed: false }, { value: '완료', label: '완료', color: null, completed: true }];
  assert.deepEqual(statusChoices(listed({ rawStatus: 'in-progress' }), korean).filter(c => c.checked).map(c => c.status), ['진행 중'], 'and an English one against a Korean list');
  assert.deepEqual(statusChoices(listed({ rawStatus: null })).filter(c => c.checked), [], 'a note with no status has none checked');
  assert(statusChoices(listed()).every(c => c.enabled));
  assert(statusChoices(listed({ recurring: true })).every(c => !c.enabled), 'a repeating task can only be changed in Obsidian');
});
test('undo goes back to the status the note had, or Open when it had none', () => {
  assert.equal(undoStatus('in-progress'), 'in-progress'); assert.equal(undoStatus('open'), 'open'); assert.equal(undoStatus('none'), 'none');
  assert.equal(undoStatus('진행 중'), 'in-progress', 'a Korean value stands for the listed status');
  assert.equal(undoStatus(null), 'open'); assert.equal(undoStatus('somewhere else'), 'open');
  const korean = [{ value: '없음', label: '없음', color: null, completed: false }, { value: '시작', label: '시작', color: null, completed: false }, { value: '완료', label: '완료', color: null, completed: true }];
  assert.equal(undoStatus(null, korean), '시작'); assert.equal(undoStatus('open', korean), '시작');
});
test('a refused change says why in plain words, for the cases a person can act on', () => {
  assert.match(petErrorText('REVISION_CONFLICT'), /다른 곳에서 먼저 바뀌어/);
  assert.match(petErrorText('SELECTION_BUSY'), /다시 시도/);
  for (const code of ['SAVE_FAILED', 'INVALID_DATE', undefined, 42]) assert.match(petErrorText(code), /앱에서 확인/);
});
test('the widget is only raised while it is visible, always-on-top and not closed', () => {
  const on = { alwaysOnTop: true, hidden: false, closed: false, visible: true };
  assert.equal(shouldRaise(on), true);
  for (const off of [{ alwaysOnTop: false }, { hidden: true }, { closed: true }, { visible: false }]) assert.equal(shouldRaise({ ...on, ...off }), false, JSON.stringify(off));
  assert(raiseEveryMs >= 500 && raiseEveryMs <= 5000, 'often enough to be noticed, rarely enough to cost nothing');
});
test('a task under a parent that is also listed is shown under that parent, which can open every one of its subtasks', () => {
  const parent = task('parent'), child = task('child'), alone = task('alone'), finished = task('finished', '완료');
  const ref = (t: ReturnType<typeof task>) => ({ id: t.id, path: t.path, title: t.title, status: t.status, rawStatus: t.rawStatus, scheduled: t.scheduled, due: t.due });
  const relations = (over: object) => ({ projects: [], subtasks: [], subtasksDone: 0, blockedBy: [], blocking: [], blocked: false, ...over });
  const agenda: Agenda = { date: '2026-09-28', timezone: 'Asia/Seoul', fetchedAt: '', today: [parent, child, alone], overdue: [], completed: [], issues: [], statuses: [...defaultStatuses], relations: {
    [parent.id]: relations({ subtasks: [ref(child), ref(finished)], subtasksDone: 1 }),
    [child.id]: relations({ projects: [{ name: 'parent', path: parent.path, task: ref(parent), unresolved: null }] }),
  } };
  const summary = summarizePet(agenda, 'vault');
  assert.deepEqual(summary.tasks.map(t => t.title), ['parent', 'alone'], 'the child is not a row of its own');
  assert.equal(summary.total, 3, 'it is still one of the day\'s tasks');
  const shown = summary.tasks[0]!;
  assert.deepEqual(shown.subtasks.map(s => s.title), ['child', 'finished']); assert.equal(shown.subtasksDone, 1);
  assert.deepEqual(summary.tasks[1]!.subtasks, []); assert.equal(summary.tasks[1]!.subtasksDone, 0);
  // Every task the list shows, as a row or under one, can be opened; anything else cannot, not even a note that exists.
  for (const id of [parent.id, child.id, finished.id, alone.id]) assert.equal(isListed(summary, id), true, id);
  assert.equal(isListed(summary, 'elsewhere.md'), false);
});
