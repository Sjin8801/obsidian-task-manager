import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isRelevantChange, watchVault } from '../apps/desktop/vault-watcher.ts';

test('watcher coalesces writes, survives task-directory replacement and stops cleanly', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-watch-'));
  const folder = path.join(root, 'tasks');
  await mkdir(folder);
  await mkdir(path.join(folder, '.hidden'));
  let count = 0;
  const stop = watchVault({ vaultPath: await realpath(root), taskRelativePath: 'tasks' }, () => { count++; });
  t.after(async () => {
    stop();
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const waitChange = async (before: number) => {
    const until = Date.now() + 3000;
    while (count === before && Date.now() < until) await delay(20);
    assert(count > before, 'file event must be delivered');
    await delay(350);
  };
  await waitChange(0);
  let before = count;
  await writeFile(path.join(root, 'unrelated.md'), 'ignored');
  await writeFile(path.join(folder, '.hidden', 'ignore.md'), 'ignored');
  await delay(500); assert.equal(count, before);
  for (let n = 0; n < 5; n++) await writeFile(path.join(folder, 'a.md'), String(n));
  await waitChange(before); assert.equal(count, before + 1);
  before = count;
  await rename(folder, folder + '-old');
  await waitChange(before);
  before = count;
  await mkdir(folder);
  await mkdir(path.join(folder, 'nested'));
  await writeFile(path.join(folder, 'nested', 'new.md'), 'new');
  await waitChange(before);
  before = count;
  stop(); await writeFile(path.join(folder, 'after-stop.md'), 'stopped');
  await delay(500); assert.equal(count, before);
});

test('folder and ancestor metadata changes are ignored, but every real edit still counts', () => {
  const nested = 'Object/TaskNotes/Tasks';
  // Windows sends these on its own, without any write (observed on idle vaults).
  for (const stray of [nested, 'Object/TaskNotes', 'Object', 'Object\\TaskNotes\\Tasks']) {
    assert.equal(isRelevantChange(nested, 'change', stray), false, `change on ${stray}`);
  }
  assert.equal(isRelevantChange('tasks', 'change', 'tasks'), false);
  // Replacing, deleting or renaming the folder or an ancestor is reported as rename.
  for (const moved of [nested, 'Object/TaskNotes', 'Object']) {
    assert.equal(isRelevantChange(nested, 'rename', moved), true, `rename of ${moved}`);
  }
  assert.equal(isRelevantChange('tasks', 'rename', 'tasks'), true);
  // Entries below the folder count for both event types, on Windows and POSIX separators.
  for (const event of ['change', 'rename']) {
    assert.equal(isRelevantChange(nested, event, 'Object/TaskNotes/Tasks/a.md'), true);
    assert.equal(isRelevantChange(nested, event, 'Object\\TaskNotes\\Tasks\\sub\\b.md'), true);
    assert.equal(isRelevantChange('tasks', event, 'tasks/nested/new.md'), true);
  }
  // Unrelated paths, siblings that only share a prefix, hidden and dependency folders stay ignored.
  for (const event of ['change', 'rename']) {
    assert.equal(isRelevantChange(nested, event, 'Object/Other/x.md'), false);
    assert.equal(isRelevantChange(nested, event, 'Object/TaskNotes/Tasks-old/a.md'), false);
    assert.equal(isRelevantChange(nested, event, 'Object/TaskNotes/TasksExtra'), false);
    assert.equal(isRelevantChange('tasks', event, 'tasks/.hidden/ignore.md'), false);
    assert.equal(isRelevantChange('tasks', event, 'tasks/node_modules/x.md'), false);
    assert.equal(isRelevantChange('tasks', event, 'unrelated.md'), false);
    assert.equal(isRelevantChange('tasks', event, '.obsidian/workspace.json'), false);
    assert.equal(isRelevantChange('tasks', event, '.obsidian/plugins/tasknotes/data.json'), true, 'the TaskNotes settings hold the status list');
    assert.equal(isRelevantChange('tasks', event, '.obsidian\\plugins\\tasknotes\\data.json'), true);
    assert.equal(isRelevantChange('tasks', event, '.obsidian/plugins/other/data.json'), false);
  }
  // Unknown file name: assume relevant. Whole-vault mode keeps everything except hidden entries.
  assert.equal(isRelevantChange(nested, 'change', null), true);
  assert.equal(isRelevantChange('.', 'change', 'Anything/x.md'), true);
  assert.equal(isRelevantChange('.', 'change', '.git/HEAD'), false);
});

// Each operation must still be noticed on a nested task folder even though folder-level `change` is ignored.
const nestedOperations: Record<string, (vault: string, tasks: string) => Promise<void>> = {
  'creating a task file': (_vault, tasks) => writeFile(path.join(tasks, 'new.md'), 'new'),
  'editing a task file in place': (_vault, tasks) => writeFile(path.join(tasks, 'a.md'), 'edited'),
  'deleting a task file': (_vault, tasks) => unlink(path.join(tasks, 'a.md')),
  'renaming a task file': (_vault, tasks) => rename(path.join(tasks, 'a.md'), path.join(tasks, 'b.md')),
  'replacing a file atomically': async (_vault, tasks) => { await writeFile(path.join(tasks, 'a.tmp'), 'z'); await rename(path.join(tasks, 'a.tmp'), path.join(tasks, 'a.md')); },
  'creating a subfolder with a task': async (_vault, tasks) => { await mkdir(path.join(tasks, 'sub')); await writeFile(path.join(tasks, 'sub', 'n.md'), 'n'); },
  'renaming the task folder away': (_vault, tasks) => rename(tasks, tasks + '-old'),
  'deleting the task folder': (_vault, tasks) => rm(tasks, { recursive: true }),
  'renaming an ancestor of the task folder': (vault) => rename(path.join(vault, 'Object'), path.join(vault, 'Object2')),
};
for (const [name, operate] of Object.entries(nestedOperations)) {
  test(`nested task folder: ${name} is reported`, async t => {
    const vault = await mkdtemp(path.join(os.tmpdir(), 'task-watch-nested-'));
    const tasks = path.join(vault, 'Object', 'TaskNotes', 'Tasks');
    await mkdir(tasks, { recursive: true });
    await writeFile(path.join(tasks, 'a.md'), 'first');
    let count = 0;
    const stop = watchVault({ vaultPath: await realpath(vault), taskRelativePath: 'Object/TaskNotes/Tasks' }, () => { count++; });
    t.after(async () => {
      stop();
      assert(path.resolve(vault).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await rm(vault, { recursive: true, force: true });
    });
    const waitFor = async (above: number, message: string) => {
      const until = Date.now() + 3000;
      while (count <= above && Date.now() < until) await delay(20);
      assert(count > above, message);
    };
    await waitFor(0, 'initial refresh must be delivered');
    await delay(350);
    const before = count;
    await operate(vault, tasks);
    await waitFor(before, `${name} must reach the watcher`);
  });
}
