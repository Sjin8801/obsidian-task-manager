import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { selectVault, defaultTaskFolder } from '../apps/desktop/local-vault.ts';
import { saveTask } from '../apps/desktop/save-task.ts';
import { defaultCategories } from '../apps/desktop/categories.ts';
import { replaceFile } from '../apps/desktop/replace-file.ts';
import { revisionOf } from '../packages/tasknotes/task.ts';

// On Windows, replacing a note fails while another program has it open (Obsidian, its sync, antivirus, our own refresh).
// Without a retry roughly one save in three failed while a reader was running.
const original = '---\ntags: [task]\n상태: 시작\n---\n\nbody\n', now = new Date('2026-09-16T02:00:00Z');
const busy = (code: string) => Object.assign(new Error(code), { code });

import { koreanSetup } from './korean-setup.ts';
async function note(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'save-read-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vaultRoot = path.join(root, 'vault'), folder = path.join(vaultRoot, defaultTaskFolder);
  await mkdir(folder, { recursive: true }); await koreanSetup(vaultRoot);
  const file = path.join(folder, 'task.md');
  await writeFile(file, original);
  const selection = await selectVault(vaultRoot);
  const save = async (status: string, replace?: typeof replaceFile) => saveTask(selection, { selection, path: 'task.md', revision: revisionOf(await readFile(file, 'utf8')), changes: { status } }, path.join(root, 'backups'), now, defaultCategories, replace);
  return { file, folder, save };
}

test('a save goes through when the note is busy for the first tries', async t => {
  const n = await note(t);
  let tries = 0;
  const saved = await n.save('진행 중', (from, to) => replaceFile(from, to, { delays: [0, 0, 0, 0], rename: async (a, b) => { if (++tries <= 3) throw busy(['EPERM', 'EBUSY', 'EACCES'][tries - 1]!); await (await import('node:fs/promises')).rename(a, b); } }));
  assert.equal(tries, 4); assert.equal(saved.rawStatus, '진행 중');
  assert.match(await readFile(n.file, 'utf8'), /상태: 진행 중/);
  assert.deepEqual((await readdir(n.folder)).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left behind');
});

test('a note that stays busy fails the save, leaves the note as it was and cleans up', async t => {
  const n = await note(t);
  await assert.rejects(n.save('진행 중', (from, to) => replaceFile(from, to, { delays: [0, 0], rename: async () => { throw busy('EPERM'); } })), { code: 'SAVE_FAILED' });
  assert.equal(await readFile(n.file, 'utf8'), original);
  assert.deepEqual((await readdir(n.folder)).filter(name => name.endsWith('.tmp')), []);
});

test('an error that waiting cannot fix is not retried', async t => {
  const n = await note(t);
  let tries = 0;
  await assert.rejects(n.save('진행 중', (from, to) => replaceFile(from, to, { delays: [0, 0, 0], rename: async () => { tries++; throw busy('ENOSPC'); } })), { code: 'SAVE_FAILED' });
  assert.equal(tries, 1); assert.equal(await readFile(n.file, 'utf8'), original);
});

// The real thing, with a reader that keeps coming back to the note the way Obsidian or a scan would (a pause between reads,
// not a loop that never lets go, which would starve any retry on a slow machine). The pause was 1 ms, about a thousand reads a
// second: on the CI runner a save then sometimes ran out of retries (3 failures in about 25 runs, never on a desktop PC). 10 ms is
// still a hundred reads a second, far more than Obsidian or a sync client makes.
const readerPauseMs = 10;
test('a note can be saved while something else keeps reading it', async t => {
  const n = await note(t);
  let reading = true;
  const reader = (async () => { while (reading) { try { await readFile(n.file); await stat(n.file); } catch { /* the note is being replaced */ } await sleep(readerPauseMs); } })();
  try {
    for (let i = 0; i < 30; i++) {
      const status = i % 2 ? '시작' : '진행 중';
      assert.equal((await n.save(status)).rawStatus, status, `save ${i}`);
    }
  } finally { reading = false; await reader; }
});
