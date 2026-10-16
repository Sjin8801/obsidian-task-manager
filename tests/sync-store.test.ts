import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SyncSettings } from '../apps/desktop/sync-store.ts';

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-store-'));
  try { await run(dir); } finally { assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(dir, { recursive: true, force: true }); }
}

test('headless sync is off by default and remembers the choice across restarts', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'profile', 'sync.json');
    const first = new SyncSettings(file); await first.load();
    assert.equal(first.enabled, false);
    await first.save(true);
    assert.equal(first.enabled, true);
    const second = new SyncSettings(file); await second.load();
    assert.equal(second.enabled, true);
    await second.save(false);
    const third = new SyncSettings(file); await third.load();
    assert.equal(third.enabled, false);
    assert.deepEqual(await readdir(path.dirname(file)), ['sync.json'], 'no temporary file is left behind');
  });
});

test('an unreadable or wrong settings file means off, never on', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'sync.json');
    for (const content of ['{not json', '', 'null', '[]', '{"headlessSync":"yes"}', '{"headlessSync":1}', '{"other":true}']) {
      await writeFile(file, content);
      const settings = new SyncSettings(file); await settings.load();
      assert.equal(settings.enabled, false, JSON.stringify(content));
    }
    await writeFile(file, '{"headlessSync":true}\n');
    const settings = new SyncSettings(file); await settings.load();
    assert.equal(settings.enabled, true);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).headlessSync, true);
  });
});

test('a failed save keeps the previous value', async () => {
  await withDir(async dir => {
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'a file where a folder is needed');
    const settings = new SyncSettings(path.join(blocker, 'sync.json'));
    await assert.rejects(settings.save(true));
    assert.equal(settings.enabled, false);
  });
});
