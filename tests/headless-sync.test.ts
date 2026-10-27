import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultTimings, HeadlessSync, interpretLine, locateHeadless, preflightSync, type HeadlessCommand, type Located, type Preflight, type RunCommand, type SyncChild, type SyncDeps } from '../apps/desktop/headless-sync.ts';
import type { SyncStatus } from '../apps/desktop/shared.ts';

class FakeChild implements SyncChild {
  private lines: ((line: string) => void)[] = []; private exits: ((code: number | null) => void)[] = [];
  killed = false;
  constructor(readonly vault: string) {}
  onLine(callback: (line: string) => void) { this.lines.push(callback); }
  onExit(callback: (code: number | null) => void) { this.exits.push(callback); }
  kill() { this.killed = true; }
  say(line: string) { for (const callback of this.lines) callback(line); }
  exit(code: number | null = 1) { for (const callback of this.exits) callback(code); }
}

// A manual clock: timers only fire when the test advances time, so restart delays and the five-minute stall rule run instantly.
function harness(options: { located?: () => Located; preflight?: () => Promise<Preflight>; spawnError?: boolean; timings?: Partial<typeof defaultTimings> } = {}) {
  let time = 1_000_000, nextId = 1;
  const timers = new Map<number, { at: number; run: () => void; every?: number }>();
  const children: FakeChild[] = [], changes: { next: SyncStatus; previous: SyncStatus }[] = [];
  let preflights = 0;
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const deps: SyncDeps = {
    locate: () => options.located ? options.located() : { ok: true, command: { node: 'node', script: 'cli.js' } },
    preflight: async () => { preflights++; return options.preflight ? options.preflight() : { problem: null, mode: 'bidirectional' }; },
    spawn: (_command: HeadlessCommand, vault: string) => { if (options.spawnError) throw new Error('spawn failed'); const child = new FakeChild(vault); children.push(child); return child; },
    now: () => time,
    setTimeout: (run, ms) => { const id = nextId++; timers.set(id, { at: time + ms, run }); return id; },
    clearTimeout: id => { timers.delete(id as number); },
    setInterval: (run, ms) => { const id = nextId++; timers.set(id, { at: time + ms, run, every: ms }); return id; },
    clearInterval: id => { timers.delete(id as number); },
    onChange: (next, previous) => { changes.push({ next, previous }); },
    ...(options.timings ? { timings: options.timings } : {}),
  };
  const sync = new HeadlessSync(deps);
  async function advance(ms: number) {
    const end = time + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      time = Math.max(time, timer.at);
      if (timer.every) timer.at += timer.every; else timers.delete(id);
      timer.run(); await flush();
    }
    time = end; await flush();
  }
  return { sync, children, changes, advance, flush, timers, get preflights() { return preflights; }, get now() { return time; } };
}
async function started(vault = 'C:\\vault') {
  const h = harness();
  h.sync.setVault(vault); h.sync.setEnabled(true); await h.flush();
  return h;
}

test('interpretLine understands the phrases obsidian-headless prints', () => {
  const cases: [string, unknown][] = [
    ['Connecting...', { kind: 'connecting' }],
    ['Waiting to connect to server', { kind: 'offline' }],
    ['Disconnected', { kind: 'offline' }],
    ['Disconnected. Code: 1006', { kind: 'offline' }],
    ['Fully synced', { kind: 'synced' }],
    ['12:01:05 Fully synced', { kind: 'synced' }],
    ['Uploading (2/5) Notes/a.md', { kind: 'progress', done: 2, total: 5 }],
    ['Downloading Notes/b.md', { kind: 'transfer' }],
    ['Downloaded', { kind: 'transfer' }],
    ['Upload complete Notes/a.md', { kind: 'transfer' }],
    ['Another sync instance is already running for this vault.', { kind: 'problem', problem: 'ALREADY_RUNNING' }],
    ['No account logged in. Run "ob login" first.', { kind: 'problem', problem: 'NOT_LOGGED_IN' }],
    ['No sync configuration found for C:\\vault', { kind: 'problem', problem: 'NOT_CONFIGURED' }],
    ["Run 'ob sync-setup' first.", { kind: 'problem', problem: 'NOT_CONFIGURED' }],
    ['The connected remote vault no longer exists.', { kind: 'problem', problem: 'REMOTE_MISSING' }],
    ['Encryption key not found. Run setup again.', { kind: 'problem', problem: 'ENCRYPTION_KEY' }],
    ['End-to-end encryption key missing. Run setup again.', { kind: 'problem', problem: 'ENCRYPTION_KEY' }],
    ['was compiled against a different Node.js version using', { kind: 'info' }],
    ['NODE_MODULE_VERSION 127. This version of Node.js requires', { kind: 'problem', problem: 'NODE_MISMATCH' }],
    ["code: 'ERR_DLOPEN_FAILED'", { kind: 'problem', problem: 'NODE_MISMATCH' }],
    ['Sync error: Error: socket hang up', { kind: 'error', text: 'Sync error: Error: socket hang up' }],
    ['Scanning for changes...', { kind: 'info' }],
    ['', { kind: 'info' }],
  ];
  for (const [line, expected] of cases) assert.deepEqual(interpretLine(line), expected, line);
  // A note whose name looks like a status message must not be read as one.
  assert.deepEqual(interpretLine('Uploading (1/3) Not logged in.md'), { kind: 'progress', done: 1, total: 3 });
  assert.deepEqual(interpretLine('Downloading Fully synced.md'), { kind: 'transfer' });
  assert.deepEqual(interpretLine('Downloading Encryption key ideas.md'), { kind: 'transfer' });
});

test('locateHeadless finds the package next to the ob shim and the matching node', () => {
  const files = new Set(['C:\\Users\\me\\AppData\\Roaming\\npm\\ob.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\obsidian-headless\\cli.js', 'C:\\Program Files\\nodejs\\node.exe']);
  const win = (env: Record<string, string>, extra: string[] = []) => locateHeadless({ env, platform: 'win32', exists: file => files.has(file) || extra.includes(file), realpath: file => file });
  const command = { node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\obsidian-headless\\cli.js' };
  assert.deepEqual(win({ Path: 'C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs' }), { ok: true, command });
  // A quoted PATH entry and the %APPDATA%\npm fallback when npm's folder is not on PATH.
  assert.deepEqual(win({ PATH: '"C:\\Program Files\\nodejs"', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }), { ok: true, command });
  // node.exe next to the shim wins, like the shim itself.
  const local = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node.exe';
  assert.deepEqual(win({ PATH: 'C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs' }, [local]), { ok: true, command: { ...command, node: local } });
  assert.deepEqual(win({ PATH: 'C:\\Windows' }), { ok: false, problem: 'NOT_INSTALLED' });
  files.delete('C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(win({ PATH: 'C:\\Users\\me\\AppData\\Roaming\\npm' }), { ok: false, problem: 'NODE_MISSING' });
});

test('locateHeadless honours explicit overrides and POSIX symlinks', () => {
  const files = new Set(['D:\\tools\\ob\\cli.js', 'D:\\tools\\node.exe']);
  const exists = (file: string) => files.has(file);
  assert.deepEqual(locateHeadless({ env: { TASK_HEADLESS_ENTRY: 'D:\\tools\\ob\\cli.js', TASK_HEADLESS_NODE: 'D:\\tools\\node.exe', PATH: '' }, platform: 'win32', exists, realpath: f => f }),
    { ok: true, command: { node: 'D:\\tools\\node.exe', script: 'D:\\tools\\ob\\cli.js' } });
  assert.deepEqual(locateHeadless({ env: { TASK_HEADLESS_ENTRY: 'D:\\missing\\cli.js', PATH: '' }, platform: 'win32', exists, realpath: f => f }), { ok: false, problem: 'NOT_INSTALLED' });
  const posix = new Set(['/usr/local/bin/ob', '/usr/local/bin/node', '/usr/local/lib/node_modules/obsidian-headless/cli.js']);
  assert.deepEqual(locateHeadless({ env: { PATH: '/usr/bin:/usr/local/bin' }, platform: 'linux', exists: f => posix.has(f), realpath: () => '/usr/local/lib/node_modules/obsidian-headless/cli.js' }),
    { ok: true, command: { node: '/usr/local/bin/node', script: '/usr/local/lib/node_modules/obsidian-headless/cli.js' } });
  // A shim that does not point at the package is not accepted.
  assert.deepEqual(locateHeadless({ env: { PATH: '/usr/local/bin' }, platform: 'linux', exists: f => posix.has(f), realpath: () => '/usr/local/bin/other-tool' }), { ok: false, problem: 'NOT_INSTALLED' });
});

test('preflightSync reads the mode without a shell and recognises setup problems', async () => {
  const command = { node: 'node', script: 'cli.js' };
  const vault = 'C:\\My Vault & "notes"';
  let seen: string[] = [];
  const answer = (result: { code: number | null; stdout?: string; stderr?: string }): RunCommand => async (_cmd, args) => { seen = args; return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }; };
  assert.deepEqual(await preflightSync(answer({ code: 0, stdout: '{"syncMode":"bidirectional"}' }), command, vault), { problem: null, mode: 'bidirectional' });
  assert.deepEqual(seen, ['cli.js', 'sync-status', '--path', vault, '--json'], 'the path travels as one argument');
  assert.deepEqual(await preflightSync(answer({ code: 0, stdout: '{"syncMode":"mirror-remote"}' }), command, vault), { problem: 'BAD_MODE', mode: 'mirror-remote' });
  assert.deepEqual(await preflightSync(answer({ code: 0, stdout: '{"syncMode":"pull-only"}' }), command, vault), { problem: 'BAD_MODE', mode: 'pull-only' });
  assert.deepEqual(await preflightSync(answer({ code: 1, stderr: 'No sync configuration found for C:\\x\nRun \'ob sync-setup\' first.' }), command, vault), { problem: 'NOT_CONFIGURED', mode: null });
  assert.deepEqual(await preflightSync(answer({ code: 1, stderr: 'No account logged in. Run "ob login" first.' }), command, vault), { problem: 'NOT_LOGGED_IN', mode: null });
  // Anything unexpected is left for the real sync to report instead of blocking it.
  assert.deepEqual(await preflightSync(answer({ code: 1, stderr: 'something new' }), command, vault), { problem: null, mode: null });
  assert.deepEqual(await preflightSync(answer({ code: null }), command, vault), { problem: null, mode: null });
  assert.deepEqual(await preflightSync(answer({ code: 0, stdout: 'not json' }), command, vault), { problem: null, mode: null });
});

test('a healthy run goes from starting through connecting and syncing to synced', async () => {
  const h = await started('C:\\vault');
  assert.equal(h.children.length, 1); assert.equal(h.children[0]!.vault, 'C:\\vault');
  assert.equal(h.sync.status().phase, 'starting'); assert.equal(h.sync.status().mode, 'bidirectional');
  const child = h.children[0]!;
  child.say('Connecting...'); assert.equal(h.sync.status().phase, 'connecting');
  child.say('Uploading (1/4) a.md'); assert.deepEqual([h.sync.status().phase, h.sync.status().progress], ['syncing', { done: 1, total: 4 }]);
  await h.advance(1000);
  child.say('Fully synced');
  const status = h.sync.status();
  assert.equal(status.phase, 'synced'); assert.equal(status.problem, null); assert.equal(status.progress, null);
  assert.equal(status.lastSyncedAt, h.now); assert.equal(status.enabled, true); assert(status.recent.includes('Fully synced'));
  // The change callback saw each phase change with the previous state.
  const phases = h.changes.map(change => change.next.phase);
  assert.deepEqual(phases.filter((phase, index) => phase !== phases[index - 1]), ['starting', 'connecting', 'syncing', 'synced']);
  assert.equal(h.changes.at(-1)!.previous.phase, 'syncing');
});

test('it stays off until enabled, and enabling without a vault asks for one', async () => {
  const h = harness();
  h.sync.setVault('C:\\vault'); await h.flush();
  assert.equal(h.sync.status().phase, 'off'); assert.equal(h.children.length, 0);
  h.sync.setVault(null); h.sync.setEnabled(true); await h.flush();
  assert.deepEqual([h.sync.status().phase, h.sync.status().problem], ['problem', 'NO_VAULT']); assert.equal(h.children.length, 0);
  h.sync.setVault('C:\\vault'); await h.flush();
  assert.equal(h.children.length, 1); assert.equal(h.sync.status().problem, null);
});

test('a missing ob or node stops before anything is started, and retry works once it is installed', async () => {
  let located: Located = { ok: false, problem: 'NOT_INSTALLED' };
  const h = harness({ located: () => located });
  h.sync.setVault('C:\\vault'); h.sync.setEnabled(true); await h.flush();
  assert.deepEqual([h.sync.status().phase, h.sync.status().problem], ['problem', 'NOT_INSTALLED']); assert.equal(h.children.length, 0);
  await h.advance(10 * 60_000);
  assert.equal(h.children.length, 0, 'no retry loop for a problem only the user can fix');
  located = { ok: true, command: { node: 'node', script: 'cli.js' } };
  h.sync.retry(); await h.flush();
  assert.equal(h.children.length, 1); assert.equal(h.sync.status().problem, null);
});

test('a one-way sync mode is refused because it would undo edits made by this app', async () => {
  const h = harness({ preflight: async () => ({ problem: 'BAD_MODE', mode: 'mirror-remote' }) });
  h.sync.setVault('C:\\vault'); h.sync.setEnabled(true); await h.flush();
  assert.deepEqual([h.sync.status().phase, h.sync.status().problem, h.sync.status().mode], ['problem', 'BAD_MODE', 'mirror-remote']);
  assert.equal(h.children.length, 0);
});

test('problems the user must fix are reported once and are not retried in a loop', async () => {
  for (const [line, problem] of [['No account logged in. Run "ob login" first.', 'NOT_LOGGED_IN'], ['The connected remote vault no longer exists.', 'REMOTE_MISSING'], ['Encryption key not found. Run setup again.', 'ENCRYPTION_KEY'], ["Run 'ob sync-setup' first.", 'NOT_CONFIGURED'], ["code: 'ERR_DLOPEN_FAILED'", 'NODE_MISMATCH']] as const) {
    const h = await started();
    h.children[0]!.say(line); h.children[0]!.exit(1);
    assert.deepEqual([h.sync.status().phase, h.sync.status().problem], ['problem', problem], line);
    await h.advance(10 * 60_000);
    assert.equal(h.children.length, 1, `${problem}: no restart`);
  }
  const h = await started();
  h.children[0]!.say('Another sync instance is already running for this vault.'); h.children[0]!.exit(1);
  h.sync.retry(); await h.flush();
  assert.equal(h.children.length, 2, 'retry starts a fresh client');
});

test('an unexpected exit restarts with a growing delay and gives up after repeated quick failures', async () => {
  const h = await started();
  const delays = [3000, 10_000, 30_000, 60_000, 60_000];
  for (const [index, delay] of delays.entries()) {
    h.children[index]!.exit(1);
    assert.equal(h.sync.status().phase, 'starting', 'shows that it is restarting');
    await h.advance(delay - 1); assert.equal(h.children.length, index + 1, `not before ${delay}ms`);
    await h.advance(1); assert.equal(h.children.length, index + 2, `after ${delay}ms`);
  }
  assert.equal(h.sync.status().restarts, 5);
  h.children[5]!.exit(1);
  assert.deepEqual([h.sync.status().phase, h.sync.status().problem], ['problem', 'CRASHED']);
  await h.advance(10 * 60_000); assert.equal(h.children.length, 6);
});

test('a client that ran for a while before stopping starts the failure count over', async () => {
  const h = await started();
  for (let index = 0; index < 4; index++) { h.children[index]!.exit(1); await h.advance(60_000); }
  assert.equal(h.children.length, 5);
  await h.advance(defaultTimings.stableMs + 1);
  h.children[4]!.exit(1);
  await h.advance(3000);
  assert.equal(h.children.length, 6, 'the first-failure delay again');
  assert.notEqual(h.sync.status().problem, 'CRASHED');
});

test('a full synced state also resets the failure count', async () => {
  const h = await started();
  for (let index = 0; index < 4; index++) { h.children[index]!.exit(1); await h.advance(60_000); }
  h.children[4]!.say('Fully synced'); h.children[4]!.exit(1);
  await h.advance(3000);
  assert.equal(h.children.length, 6);
});

test('a stale lock from a client we just stopped is retried, a real second client is reported', async () => {
  const stale = await started();
  const first = stale.children[0]!;
  first.say('Another sync instance is already running for this vault.'); first.exit(1);
  assert.equal(stale.sync.status().phase, 'starting');
  await stale.advance(defaultTimings.lockRetryMs);
  assert.equal(stale.children.length, 2);
  stale.children[1]!.say('Connecting...');
  assert.equal(stale.sync.status().problem, null); assert.equal(stale.sync.status().phase, 'connecting');

  const other = await started();
  for (let attempt = 0; attempt <= defaultTimings.lockRetries; attempt++) {
    other.children[attempt]!.say('Another sync instance is already running for this vault.'); other.children[attempt]!.exit(1);
    await other.advance(defaultTimings.lockRetryMs);
  }
  assert.deepEqual([other.sync.status().phase, other.sync.status().problem], ['problem', 'ALREADY_RUNNING']);
  assert.equal(other.children.length, defaultTimings.lockRetries + 1);
});

test('staying disconnected for five minutes is reported as stalled until it syncs again', async () => {
  const h = await started();
  const child = h.children[0]!;
  child.say('Connecting...');
  await h.advance(defaultTimings.stallMs - defaultTimings.checkMs); assert.equal(h.sync.status().phase, 'connecting');
  await h.advance(2 * defaultTimings.checkMs); assert.equal(h.sync.status().phase, 'stalled');
  child.say('Connecting...'); child.say('Disconnected');
  assert.equal(h.sync.status().phase, 'stalled', 'reconnect noise does not hide the stall');
  child.say('Fully synced'); assert.equal(h.sync.status().phase, 'synced');
  child.say('Disconnected'); assert.equal(h.sync.status().phase, 'offline');
  await h.advance(10_000); child.say('Fully synced');
  await h.advance(60 * 60_000); assert.equal(h.sync.status().phase, 'synced', 'quiet while synced is normal');
});

test('turning it off stops the client and clears the status; turning it on starts fresh', async () => {
  const h = await started();
  h.children[0]!.say('Fully synced');
  h.sync.setEnabled(false);
  assert.equal(h.children[0]!.killed, true);
  assert.deepEqual([h.sync.status().phase, h.sync.status().enabled, h.sync.status().lastSyncedAt, h.sync.status().recent], ['off', false, null, []]);
  h.children[0]!.exit(1); await h.advance(60_000);
  assert.equal(h.children.length, 1, 'the exit of the client we stopped is not a crash');
  h.sync.setEnabled(true); await h.flush();
  assert.equal(h.children.length, 2);
});

test('switching to another vault restarts the client on the new path', async () => {
  const h = await started('C:\\one');
  h.sync.setVault('C:\\one'); await h.flush(); assert.equal(h.children.length, 1, 'same vault: nothing happens');
  h.sync.setVault('C:\\two'); await h.flush();
  assert.equal(h.children[0]!.killed, true); assert.equal(h.children[1]!.vault, 'C:\\two');
  h.sync.setVault(null); await h.flush();
  assert.equal(h.children[1]!.killed, true); assert.equal(h.sync.status().problem, 'NO_VAULT');
});

test('dispose stops the client and ignores anything that arrives later', async () => {
  const h = await started();
  h.sync.dispose();
  assert.equal(h.children[0]!.killed, true);
  const before = h.changes.length;
  h.children[0]!.say('Fully synced'); h.children[0]!.exit(1); await h.advance(60_000);
  assert.equal(h.changes.length, before); assert.equal(h.children.length, 1); assert.equal(h.timers.size, 0, 'no timers left behind');
  h.sync.setEnabled(true); await h.flush(); assert.equal(h.children.length, 1, 'stays disposed');
});

test('a burst of progress lines is reported a few times a second, not once per line', async () => {
  const h = await started();
  const child = h.children[0]!;
  const before = h.changes.length;
  for (let index = 1; index <= 200; index++) child.say(`Uploading (${index}/200) file-${index}.md`);
  await h.advance(1000);
  assert(h.changes.length - before <= 4, `got ${h.changes.length - before} updates`);
  assert.deepEqual(h.sync.status().progress, { done: 200, total: 200 });
  assert.equal(h.sync.status().recent.length, 30, 'only the last 30 lines are kept');
});

test('a spawn that throws is treated like a crash and retried', async () => {
  const h = harness({ spawnError: true });
  h.sync.setVault('C:\\vault'); h.sync.setEnabled(true); await h.flush();
  assert.equal(h.sync.status().phase, 'starting');
  await h.advance(60 * 60_000);
  assert.deepEqual([h.sync.status().phase, h.sync.status().problem], ['problem', 'CRASHED']);
});

test('a failing preflight does not block the real sync from reporting its own error', async () => {
  const h = harness({ preflight: async () => { throw new Error('boom'); } });
  h.sync.setVault('C:\\vault'); h.sync.setEnabled(true); await h.flush();
  assert.equal(h.children.length, 1);
});

test('lines and exits from an older client are ignored after a restart', async () => {
  const h = await started();
  const old = h.children[0]!;
  h.sync.retry(); await h.flush();
  assert.equal(h.children.length, 2);
  old.say('Fully synced'); old.exit(1);
  assert.equal(h.sync.status().phase, 'starting'); assert.equal(h.sync.status().lastSyncedAt, null);
  await h.advance(60_000); assert.equal(h.children.length, 2);
});
