import assert from 'node:assert/strict';
import test from 'node:test';
import { loginItemName, loginItemState, repairLegacyLoginItem, type LoginItem, type LoginItemApi } from '../apps/desktop/login-item.ts';

const exe = 'C:\\app\\node_modules\\electron\\dist\\electron.exe';
const main = 'C:\\app\\dist\\desktop\\main.cjs';
const profile = 'C:\\app\\.local\\desktop';
// What the app asks Windows to run: no quotes of its own, switches included.
const expected = { path: exe, args: [main, '--task-autostart', `--task-profile=${profile}`] };
const item = (patch: Partial<LoginItem> = {}): LoginItem => ({ name: loginItemName, path: exe, args: [main], enabled: true, ...patch });

// Read from Electron on the user's PC after the old code had registered the entry: quotes were escaped into the value,
// --task-autostart was reported as a switch (missing from args) and openAtLogin came back false.
const realLegacyEntry: LoginItem = { name: 'Obsidian Task Manager', path: exe, args: [`"${main}"`, `"--task-profile=${profile}"`], enabled: true };

test('the entry registered by the old code is recognised as broken, not as active', () => {
  assert.equal(loginItemState([realLegacyEntry], expected), 'legacy');
});

test('a correctly registered entry is active, whether or not Electron lists the switches', () => {
  assert.equal(loginItemState([item()], expected), 'active');
  assert.equal(loginItemState([item({ args: [main, '--task-autostart', `--task-profile=${profile}`] })], expected), 'active');
  assert.equal(loginItemState([item({ path: exe.toUpperCase(), args: [main.toLowerCase().replaceAll('\\', '/')] })], expected), 'active', 'Windows paths compare without case or slash style');
  // A packaged app has no script argument, only switches.
  assert.equal(loginItemState([item({ args: [] })], { path: exe, args: ['--task-autostart', `--task-profile=${profile}`] }), 'active');
});

test('nothing registered, or switched off in Windows, counts as off', () => {
  assert.equal(loginItemState(undefined, expected), 'off');
  assert.equal(loginItemState([], expected), 'off');
  assert.equal(loginItemState([item({ enabled: false })], expected), 'off');
  assert.equal(loginItemState([item({ name: 'Some Other App' })], expected), 'off');
  assert.equal(loginItemState([item({ name: 'Some Other App' }), item()], expected), 'active');
});

test('an entry with our name that runs something else is left alone', () => {
  assert.equal(loginItemState([item({ path: 'C:\\other\\electron.exe' })], expected), 'other');
  assert.equal(loginItemState([item({ args: ['C:\\other\\main.cjs'] })], expected), 'other');
  assert.equal(loginItemState([item({ args: [main, 'extra.cjs'] })], expected), 'other');
  assert.equal(loginItemState([item({ args: [] })], expected), 'other');
});

function fakeApi(start: LoginItem[]) {
  let items = start; const writes: Parameters<LoginItemApi['set']>[0][] = [];
  const api: LoginItemApi = {
    get: () => items,
    set: options => {
      writes.push(options);
      // Electron writes the value with the arguments as given; unquoted arguments read back unquoted.
      items = options.openAtLogin ? [{ name: options.name, path: options.path, args: options.args.filter(arg => !arg.startsWith('--')), enabled: options.enabled }] : [];
    },
  };
  return { api, writes, current: () => items };
}

test('the old quoted entry is rewritten once, with unquoted arguments, and stays on', () => {
  const fake = fakeApi([realLegacyEntry]);
  assert.equal(repairLegacyLoginItem(fake.api, expected), true);
  assert.equal(fake.writes.length, 1);
  assert.deepEqual(fake.writes[0], { path: exe, args: expected.args, name: 'Obsidian Task Manager', openAtLogin: true, enabled: true });
  assert(fake.writes[0]!.args.every(arg => !arg.includes('"')), 'no quotes of our own');
  assert.equal(loginItemState(fake.current(), expected), 'active');
  assert.equal(repairLegacyLoginItem(fake.api, expected), false, 'a second start has nothing to repair');
  assert.equal(fake.writes.length, 1);
});

test('nothing else is ever rewritten, in particular not an entry the user switched off', () => {
  for (const start of [[], [item()], [item({ enabled: false })], [{ ...realLegacyEntry, enabled: false }], [item({ path: 'C:\\other\\electron.exe' })], [item({ args: ['C:\\other\\main.cjs'] })], [{ ...realLegacyEntry, path: 'C:\\other\\electron.exe' }]]) {
    const fake = fakeApi(start);
    assert.equal(repairLegacyLoginItem(fake.api, expected), false);
    assert.equal(fake.writes.length, 0, JSON.stringify(start));
  }
});

test('a repair that does not take reports failure instead of claiming success', () => {
  const stuck: LoginItemApi = { get: () => [realLegacyEntry], set: () => {} };
  assert.equal(repairLegacyLoginItem(stuck, expected), false);
});
