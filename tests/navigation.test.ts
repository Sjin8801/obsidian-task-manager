import assert from 'node:assert/strict';
import test from 'node:test';
import { BackInputGate, initialNavigation, navigationReducer as reduce } from '../apps/desktop/renderer/navigation.ts';
import { parseTask } from '../packages/tasknotes/task.ts';
const task = parseTask('work.md', '---\ntags: [task, 업무]\n상태: 시작\n---\n본문');
test('back unwinds editor, detail, search and tab without discarding the preceding screen', () => {
  let state = reduce(initialNavigation, { type: 'scope', scope: 'completed' });
  state = reduce(state, { type: 'query', query: 'w' });
  state = reduce(state, { type: 'query', query: 'work' });
  state = reduce(state, { type: 'open', screen: 'detail', task });
  state = reduce(state, { type: 'open', screen: 'editor', task });
  state = reduce(state, { type: 'back' }); assert.equal(state.current.screen, 'detail');
  state = reduce(state, { type: 'open', screen: 'settings' });
  state = reduce(state, { type: 'back' }); assert.equal(state.current.task, task);
  state = reduce(state, { type: 'back' }); assert.equal(state.current.query, 'work');
  state = reduce(state, { type: 'back' }); assert.equal(state.current.query, ''); assert.equal(state.current.scope, 'completed');
  state = reduce(state, { type: 'back' }); assert.deepEqual(state, initialNavigation);
  assert.equal(reduce(state, { type: 'back' }), state);
});
test('saved editor returns to updated detail and vault reset clears old history', () => {
  let state = reduce(initialNavigation, { type: 'open', screen: 'detail', task });
  state = reduce(state, { type: 'open', screen: 'editor', task });
  const updated = { ...task, body: '수정 본문', revision: 'updated' };
  state = reduce(state, { type: 'saved', task: updated });
  assert.equal(state.current.screen, 'detail'); assert.equal(state.current.task?.revision, 'updated');
  state = reduce(state, { type: 'reset' }); assert.deepEqual(state, initialNavigation);
  assert.equal(reduce(state, { type: 'back' }), state);
});
test('one back press delivered as DOM and native input only navigates once', () => {
  const gate = new BackInputGate();
  assert(gate.accept('mouse', 1000)); assert(!gate.accept('native', 1005));
  assert(gate.accept('mouse', 1100)); assert(!gate.accept('native', 1105));
  assert(gate.accept('native', 1500)); assert(!gate.accept('mouse', 1505));
  assert(gate.accept('native', 1600));
});

test('external removal clears task views from back history while preserving the search', () => {
  let state = reduce(initialNavigation, { type: 'query', query: 'work' });
  state = reduce(state, { type: 'open', screen: 'detail', task });
  state = reduce(state, { type: 'open', screen: 'editor', task });
  state = reduce(state, { type: 'back' });
  state = reduce(state, { type: 'removed', id: task.id });
  assert.equal(state.current.screen, 'list'); assert.equal(state.current.query, 'work');
  assert(state.history.every(view => view.task?.id !== task.id));
});

test('search popup restores results from detail and closes to the original filter in one step', () => {
  let state = reduce(initialNavigation, { type: 'scope', scope: 'work' });
  const original = state;
  state = reduce(state, { type: 'open', screen: 'search' });
  state = reduce(state, { type: 'query', query: 'w' });
  state = reduce(state, { type: 'query', query: 'work' });
  state = reduce(state, { type: 'scope', scope: 'all' });
  state = reduce(state, { type: 'open', screen: 'detail', task });
  state = reduce(state, { type: 'back' });
  assert.equal(state.current.screen, 'search'); assert.equal(state.current.query, 'work');
  assert.equal(state.current.scope, 'all');
  state = reduce(state, { type: 'back' });
  assert.deepEqual(state, original);
});
