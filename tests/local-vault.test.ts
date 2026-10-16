import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalVault, selectVault, selectTaskFolder, defaultTaskFolder } from '../apps/desktop/local-vault.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-vault-test-'));
  const raw = await readFile('tests/fixtures/일반 작업.md', 'utf8');
  t.after(async () => {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  return { root, raw };
}
test('local selection discovers TaskNotes and rereads external edits without writing notes', async t => {
  const { root, raw } = await fixture(t);
  const folder = path.join(root, defaultTaskFolder); await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'task.md'); await writeFile(file, raw);
  const selection = await selectVault(root); assert.equal(selection.taskRelativePath, defaultTaskFolder);
  const vault = new LocalVault(selection);
  const agenda = await vault.agenda('work', new Date('2026-09-14T02:00:00Z'));
  assert.equal(agenda.today.length, 1); assert.deepEqual(agenda.issues, []);
  assert.equal(await readFile(file, 'utf8'), raw);
  await writeFile(file, raw.replace('테스트 업무 검토', '외부 수정 반영'));
  assert.equal((await vault.search('all', '외부 수정')).items.length, 1);
  assert.equal((await vault.search('personal', '')).items.length, 0);
  await rm(file);
  assert.equal((await vault.search('all', '')).items.length, 0);
});
test('whole-vault fallback ignores ordinary notes and hidden directories, reports malformed files and links', async t => {
  const { root, raw } = await fixture(t);
  const folder = path.join(root, 'vault'); await mkdir(folder);
  await mkdir(path.join(folder, '.obsidian'));
  await writeFile(path.join(folder, '.obsidian', 'hidden.md'), raw);
  await writeFile(path.join(folder, 'daily.md'), 'a normal daily note\n- [ ] checklist');
  await writeFile(path.join(folder, 'normal.md'), '---\ntitle: Normal note\n---\nbody');
  await writeFile(path.join(folder, 'tagged.md'), '---\ntags: [daily]\n---\nbody');
  await writeFile(path.join(folder, 'bad.md'), '---\ntags: [task\n---\nbody');
  await writeFile(path.join(folder, 'task.md'), raw);
  const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.md'), raw);
  await symlink(outside, path.join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const selection = await selectVault(folder); assert.equal(selection.taskRelativePath, '.');
  const list = await new LocalVault(selection).search('all', '');
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.issues.map(i => i.code).sort(), ['INVALID_FRONTMATTER', 'LINK_NOT_ALLOWED']);
});
test('folder selection stays inside vault and revalidates disappeared or replaced directories', async t => {
  const { root, raw } = await fixture(t);
  const folder = path.join(root, 'vault'); await mkdir(folder);
  const inside = path.join(folder, 'custom'); await mkdir(inside);
  const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.md'), raw);
  const selection = await selectVault(folder);
  await assert.rejects(selectTaskFolder(selection, outside), /INVALID_TASK_FOLDER/);
  const chosen = await selectTaskFolder(selection, inside);
  const vault = new LocalVault(chosen);
  await rename(inside, path.join(folder, 'moved'));
  await assert.rejects(vault.search('all', ''), /VAULT_UNAVAILABLE/);
  await symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(vault.search('all', ''), /VAULT_LINK_NOT_ALLOWED/);
});
test('local search cursors cannot cross vaults, filters or externally changed snapshots', async t => {
  const { root, raw } = await fixture(t);
  const first = path.join(root, 'first'), second = path.join(root, 'second'); await mkdir(first); await mkdir(second);
  for (let i = 0; i < 101; i++) await writeFile(path.join(first, `task-${i}.md`), raw);
  await writeFile(path.join(second, 'task.md'), raw);
  const vault = new LocalVault(await selectVault(first)), other = new LocalVault(await selectVault(second));
  const list = await vault.search('all', ''); assert.equal(list.items.length, 100); assert(list.nextCursor);
  const end = await vault.search('all', '', list.nextCursor); assert.equal(end.items.length, 1); assert.equal(end.nextCursor, null);
  await assert.rejects(other.search('all', '', list.nextCursor), /CURSOR_EXPIRED/);
  await assert.rejects(vault.search('work', '', list.nextCursor), /CURSOR_EXPIRED/);
  await writeFile(path.join(first, 'task-0.md'), raw + '\nchanged');
  await assert.rejects(vault.search('all', '', list.nextCursor), /CURSOR_EXPIRED/);
});
