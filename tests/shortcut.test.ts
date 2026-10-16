import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultShortcut, shortcutFromKey, validShortcut } from '../apps/desktop/shortcut.ts';
import { ShortcutStore } from '../apps/desktop/shortcut-store.ts';
function registrar() {
  const bindings = new Map<string, () => void>(), blocked = new Set<string>();
  return { bindings, blocked, register(key: string, callback: () => void) { if (blocked.has(key) || bindings.has(key)) return false; bindings.set(key, callback); return true; }, unregister(key: string) { bindings.delete(key); } };
}
async function fixture() {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'task-shortcut-')), 'shortcut.json');
  const native = registrar(); let toggles = 0;
  const store = new ShortcutStore(file, native, () => { toggles++; });
  await store.load(); return { file, native, store, toggles: () => toggles };
}
test('shortcut validates IPC values and records physical keys independently of Korean layout', () => {
  for (const value of [defaultShortcut, 'Alt+Space', 'Control+Alt+Shift+F12', 'Control+1']) assert(validShortcut(value));
  for (const value of [null, {}, 'A', 'Shift+A', 'Control+Control+A', 'Meta+A', 'Control+bogus', 'Control+Shift', 'Shift+Control+A']) assert(!validShortcut(value));
  const event = { code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, isComposing: false, getModifierState: () => false };
  assert.equal(shortcutFromKey(event), 'Control+Shift+K');
  assert.equal(shortcutFromKey({ ...event, isComposing: true }), null);
  assert.equal(shortcutFromKey({ ...event, metaKey: true }), null);
});
test('shortcut changes immediately, releases previous key and restores on restart', async () => {
  const f = await fixture(); assert(f.store.registered);
  await f.store.save('Control+Alt+J');
  assert(!f.native.bindings.has(defaultShortcut));
  f.native.bindings.get('Control+Alt+J')!(); assert.equal(f.toggles(), 1);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { shortcut: 'Control+Alt+J' });
  const restarted = new ShortcutStore(f.file, registrar(), () => {}); await restarted.load();
  assert.equal(restarted.shortcut, 'Control+Alt+J'); assert(restarted.registered);
  await f.store.save(defaultShortcut); assert(f.native.bindings.has(defaultShortcut));
});
test('unavailable shortcuts and persistence failures preserve the working binding and saved setting', async () => {
  const f = await fixture(); await f.store.save(defaultShortcut);
  f.native.blocked.add('Alt+Space');
  await assert.rejects(f.store.save('Alt+Space'), { code: 'SHORTCUT_UNAVAILABLE' });
  assert(f.native.bindings.has(defaultShortcut));
  await mkdir(f.file + '.tmp');
  await assert.rejects(f.store.save('Control+Alt+J'), { code: 'SHORTCUT_SAVE_FAILED' });
  assert.equal(f.store.shortcut, defaultShortcut); assert(f.store.registered);
  assert(f.native.bindings.has(defaultShortcut)); assert(!f.native.bindings.has('Control+Alt+J'));
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { shortcut: defaultShortcut });
});
test('invalid saved setting recovers, startup conflict remains visible and concurrent saves are guarded', async () => {
  const f = await fixture(); f.native.unregister(defaultShortcut);
  await writeFile(f.file, '{bad JSON'); f.native.blocked.add(defaultShortcut);
  const recovering = new ShortcutStore(f.file, f.native, () => {}); await recovering.load();
  assert.equal(recovering.shortcut, defaultShortcut); assert(!recovering.registered); assert.equal(recovering.error, 'SHORTCUT_LOAD_FAILED');
  const saving = recovering.save('Control+Alt+J');
  await assert.rejects(recovering.save('Control+Alt+K'), { code: 'SHORTCUT_BUSY' });
  await saving; assert(recovering.registered); assert.equal(recovering.error, null);
});
