import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseTasksFolder, defaultTasksFolder } from '../packages/contracts/folder.ts';
import { selectVault } from '../apps/desktop/local-vault.ts';
import { statusSettingsFile } from '../apps/desktop/status-config.ts';

test('the task folder comes out of the TaskNotes settings as a plain folder inside the vault', () => {
  assert.equal(defaultTasksFolder, 'TaskNotes/Tasks');
  assert.equal(parseTasksFolder({ tasksFolder: 'Work/Tasks' }), 'Work/Tasks');
  assert.equal(parseTasksFolder({ tasksFolder: ' Work\\Tasks\\ ' }), 'Work/Tasks', 'Windows separators, spaces and a trailing slash');
  assert.equal(parseTasksFolder({ tasksFolder: './Tasks/' }), 'Tasks');
  assert.equal(parseTasksFolder({ tasksFolder: 'Projet été/Tâches' }), 'Projet été/Tâches', 'any language');
  for (const bad of [undefined, null, 5, '', ' ', '.', '/', '/etc', '\\server\share', 'C:/Tasks', '../Tasks', 'a/../b', '.hidden/Tasks', 'node_modules/x', 'Tasks/{{year}}', 'a:b', 'a|b', 'a?b', 'Tasks.', 'x'.repeat(241)]) {
    assert.equal(parseTasksFolder({ tasksFolder: bad }), null, JSON.stringify(bad));
  }
  for (const data of [null, undefined, 5, 'x', [], {}]) assert.equal(parseTasksFolder(data), null);
});

async function vaultWith(t: TestContext, folders: string[], settings?: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-folder-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vault = path.join(root, 'vault');
  await mkdir(vault, { recursive: true });
  for (const folder of folders) await mkdir(path.join(vault, folder), { recursive: true });
  if (settings !== undefined) { const file = path.join(vault, ...statusSettingsFile.split('/')); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(settings)); }
  return vault;
}

test('the task folder of the TaskNotes settings is selected when it exists', async t => {
  const vault = await vaultWith(t, ['Work/Tasks', 'TaskNotes/Tasks'], { tasksFolder: 'Work/Tasks' });
  assert.equal((await selectVault(vault)).taskRelativePath, 'Work/Tasks');
});
test("TaskNotes' own default folder is next, then the whole vault", async t => {
  assert.equal((await selectVault(await vaultWith(t, ['TaskNotes/Tasks'], { tasksFolder: 'Missing' }))).taskRelativePath, 'TaskNotes/Tasks', 'the folder in the settings does not exist');
  assert.equal((await selectVault(await vaultWith(t, ['TaskNotes/Tasks']))).taskRelativePath, 'TaskNotes/Tasks', 'no settings');
  assert.equal((await selectVault(await vaultWith(t, ['Notes']))).taskRelativePath, '.', 'neither exists: every note with a task tag');
  assert.equal((await selectVault(await vaultWith(t, ['Notes'], { tasksFolder: '../outside' }))).taskRelativePath, '.', 'a folder outside the vault is not used');
});
