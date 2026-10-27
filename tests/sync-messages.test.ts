import assert from 'node:assert/strict';
import test from 'node:test';
import { problemHint, problemTitle, relativeTime, syncAlert, syncNeedsAttention, syncSummary, trayLabel } from '../apps/desktop/sync-messages.ts';
import type { SyncPhase, SyncProblem, SyncStatus } from '../apps/desktop/shared.ts';

const base: SyncStatus = { enabled: true, phase: 'synced', problem: null, phaseSince: null, startedAt: null, lastSyncedAt: null, lastActivityAt: null, progress: null, restarts: 0, lastError: null, mode: 'bidirectional', recent: [] };
const status = (patch: Partial<SyncStatus>): SyncStatus => ({ ...base, ...patch });
const problems: SyncProblem[] = ['NO_VAULT', 'NOT_INSTALLED', 'NODE_MISSING', 'NOT_LOGGED_IN', 'NOT_CONFIGURED', 'BAD_MODE', 'ALREADY_RUNNING', 'REMOTE_MISSING', 'ENCRYPTION_KEY', 'NODE_MISMATCH', 'CRASHED'];

test('relative times round to the unit a person would say', () => {
  const now = 10_000_000_000;
  const ago = (seconds: number) => relativeTime(now, now - seconds * 1000);
  assert.equal(ago(0), '방금'); assert.equal(ago(44), '방금'); assert.equal(ago(45), '1분 전');
  assert.equal(ago(5 * 60), '5분 전'); assert.equal(ago(59 * 60), '59분 전');
  assert.equal(ago(60 * 60), '1시간 전'); assert.equal(ago(5 * 3600), '5시간 전'); assert.equal(ago(47 * 3600), '47시간 전');
  assert.equal(ago(72 * 3600), '3일 전');
  assert.equal(relativeTime(now, now + 5000), '방금', 'a clock that moved back never shows a negative age');
});

test('every phase has a status line and every problem has a title and a hint', () => {
  const now = 10_000_000_000;
  const phases: SyncPhase[] = ['off', 'starting', 'connecting', 'syncing', 'synced', 'offline', 'stalled', 'problem'];
  for (const phase of phases) assert(syncSummary(status({ phase, problem: phase === 'problem' ? 'CRASHED' : null }), now).text.length > 0, phase);
  assert.deepEqual(syncSummary(status({ phase: 'off', enabled: false }), now), { tone: 'off', text: '꺼짐' });
  assert.deepEqual(syncSummary(status({ phase: 'syncing', progress: { done: 3, total: 9 } }), now), { tone: 'busy', text: '동기화 중 (3/9)' });
  assert.deepEqual(syncSummary(status({ phase: 'syncing' }), now), { tone: 'busy', text: '동기화 중…' });
  assert.deepEqual(syncSummary(status({ phase: 'synced', lastSyncedAt: now - 3 * 60_000 }), now), { tone: 'ok', text: '최신 상태 · 마지막 동기화 3분 전' });
  assert.deepEqual(syncSummary(status({ phase: 'synced' }), now), { tone: 'ok', text: '최신 상태' });
  assert.equal(syncSummary(status({ phase: 'stalled' }), now).tone, 'warn');
  assert.equal(syncSummary(status({ phase: 'problem', problem: 'NOT_LOGGED_IN' }), now).text, problemTitle('NOT_LOGGED_IN'));
  for (const problem of problems) { assert(problemTitle(problem).length > 0, problem); assert(problemHint(problem, 'C:\\vault').length > 0, problem); }
});

test('hints put the real vault path into the commands the user has to run', () => {
  const path = 'C:\\Users\\me\\My Vault';
  assert(problemHint('NOT_CONFIGURED', path).includes(`--path "${path}"`));
  assert(problemHint('BAD_MODE', path).includes(`ob sync-config --path "${path}" --mode bidirectional`));
  assert(problemHint('NOT_LOGGED_IN', path).includes('ob login'));
  assert(problemHint('NOT_INSTALLED', path).includes('npm install -g obsidian-headless'));
  for (const problem of problems) assert(!problemHint(problem, path).includes('{path}'), `${problem} has no leftover placeholder`);
});

test('the tray tooltip only mentions sync while the feature is on', () => {
  const now = 10_000_000_000;
  assert.equal(trayLabel(status({ phase: 'off', enabled: false }), now), '');
  assert.equal(trayLabel(status({ phase: 'synced', lastSyncedAt: now }), now), ' · 동기화: 최신 상태 · 마지막 동기화 방금');
  assert.equal(trayLabel(status({ phase: 'problem', problem: 'CRASHED' }), now), ` · 동기화: ${problemTitle('CRASHED')}`);
});

test('the title-bar chip appears only for stalls and real problems', () => {
  assert.equal(syncNeedsAttention(status({ phase: 'synced' })), false);
  assert.equal(syncNeedsAttention(status({ phase: 'connecting' })), false);
  assert.equal(syncNeedsAttention(status({ phase: 'offline' })), false, 'a short disconnect is normal');
  assert.equal(syncNeedsAttention(status({ phase: 'stalled' })), true);
  assert.equal(syncNeedsAttention(status({ phase: 'problem', problem: 'CRASHED' })), true);
  assert.equal(syncNeedsAttention(status({ phase: 'problem', problem: 'NO_VAULT' })), false, 'no vault yet is not an alarm');
  assert.equal(syncNeedsAttention(status({ phase: 'off', enabled: false })), false);
  assert.equal(syncNeedsAttention(status({ phase: 'stalled', enabled: false })), false);
});

test('a notification is offered when a problem appears or the sync stalls, once per change', () => {
  const healthy = status({ phase: 'synced' });
  const broken = status({ phase: 'problem', problem: 'NOT_LOGGED_IN' });
  const alert = syncAlert(healthy, broken);
  assert.equal(alert?.key, 'problem:NOT_LOGGED_IN'); assert.equal(alert?.title, '동기화가 멈췄어요');
  assert(alert?.body.includes(problemTitle('NOT_LOGGED_IN')));
  assert.equal(syncAlert(broken, broken), null, 'the same problem again is not news');
  assert.equal(syncAlert(broken, status({ phase: 'problem', problem: 'CRASHED' }))?.key, 'problem:CRASHED', 'a different problem is');
  assert.equal(syncAlert(healthy, status({ phase: 'problem', problem: 'NO_VAULT' })), null);
  assert.equal(syncAlert(healthy, status({ phase: 'off', enabled: false })), null);
  assert.equal(syncAlert(healthy, status({ phase: 'offline' })), null);
  const stalled = syncAlert(status({ phase: 'connecting' }), status({ phase: 'stalled' }));
  assert.equal(stalled?.key, 'stalled'); assert(stalled?.body.includes('네트워크'));
  assert.equal(syncAlert(status({ phase: 'stalled' }), status({ phase: 'stalled', lastError: 'x' })), null);
  // No note titles or paths ever end up in the text.
  for (const problem of problems) { const text = syncAlert(healthy, status({ phase: 'problem', problem })); if (text) assert(!/[\\/]|\.md/.test(text.body), problem); }
});
