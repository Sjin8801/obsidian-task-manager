import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalVault, selectVault } from '../apps/desktop/local-vault.ts';
import { listVaultNotes } from '../apps/desktop/vault-index.ts';
import { statusSettingsFile } from '../apps/desktop/status-config.ts';

// A small made-up vault. Nothing here depends on how any real vault is laid out: the task folder, the project folder and the
// property names are all chosen by the test (and by the TaskNotes settings it writes).
const today = new Date('2026-09-30T01:00:00Z');
const task = (props: string, status = 'open') => `---\ntags: [task]\nstatus: ${status}\nscheduled: 2026-09-30\n${props}\n---\n\nbody\n`;

async function makeVault(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vault-rel-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const vault = path.join(root, 'vault');
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(vault, name)), { recursive: true }); await writeFile(path.join(vault, name), content); }
  return { root, vault };
}
// The app works on the vault's canonical path, so a test does too.
async function open(vault: string, taskRelativePath: string) { return new LocalVault({ ...(await selectVault(vault)), taskRelativePath }); }

test('the vault is listed for links: every note, but not hidden folders, node_modules, other files or links', async t => {
  const { root, vault } = await makeVault(t, {
    'a.md': '', 'Folder/b.md': '', 'Folder/Deep/c.MD': '', 'note.txt': '', 'Folder/image.png': '',
    '.obsidian/plugins/x/readme.md': '', '.trash/old.md': '', 'node_modules/pkg/readme.md': '', '.hidden.md': '',
  });
  assert.deepEqual((await listVaultNotes(vault))!.sort(), ['Folder/Deep/c.MD', 'Folder/b.md', 'a.md']);
  const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret.md'), '');
  try { await symlink(outside, path.join(vault, 'Linked'), 'junction'); await symlink(path.join(outside, 'secret.md'), path.join(vault, 'secret-link.md')); }
  catch { t.diagnostic('this account cannot create links; the link part was skipped'); return; }
  assert.deepEqual((await listVaultNotes(vault))!.sort(), ['Folder/Deep/c.MD', 'Folder/b.md', 'a.md'], 'a link to somewhere else is not followed');
});

test('a vault with more notes than the limit is not scanned, rather than scanned halfway', async t => {
  const { vault } = await makeVault(t, { 'one.md': '', 'two.md': '', 'three.md': '' });
  assert.equal((await listVaultNotes(vault, 3))!.length, 3);
  assert.equal(await listVaultNotes(vault, 2), null);
});

test('the vault tells each task its projects, subtasks and blockers, whatever the folders are called', async t => {
  const { vault } = await makeVault(t, {
    'Work/Tasks/Parent.md': task(''),
    'Work/Tasks/Child one.md': task('projects: ["[[Parent]]", "[[Launch]]"]'),
    'Work/Tasks/Child two.md': task('projects: ["[[Parent]]"]', 'done'),
    'Work/Tasks/Waits.md': task('blockedBy:\n  - uid: "[[Child one]]"\n    reltype: FINISHTOSTART\n    gap: P2D'),
    'Elsewhere/Launch.md': '# a project note, not a task\n',
  });
  const v = await open(vault, 'Work/Tasks');
  const agenda = await v.agenda('all', today);
  const byTitle = Object.fromEntries([...agenda.today, ...agenda.completed].map(x => [x.title, agenda.relations[x.id]!]));
  assert.deepEqual(byTitle['Parent']!.subtasks.map(s => s.title), ['Child one', 'Child two']);
  assert.equal(byTitle['Parent']!.subtasksDone, 1);
  assert.deepEqual(byTitle['Child one']!.projects.map(p => [p.name, p.task?.title ?? null, p.unresolved]), [['Parent', 'Parent', null], ['Launch', null, null]]);
  assert.equal(byTitle['Child one']!.projects[1]!.path, 'Elsewhere/Launch.md', 'a project note outside the task folder is found');
  assert.deepEqual([byTitle['Waits']!.blocked, byTitle['Waits']!.blockedBy[0]!.name, byTitle['Waits']!.blockedBy[0]!.gap], [true, 'Child one', 'P2D']);
  assert.deepEqual(byTitle['Child one']!.blocking.map(b => b.title), ['Waits']);
  // The same answers come with a search and with a single task.
  assert.equal((await v.search('all', 'Parent')).relations[agenda.today.find(x => x.title === 'Parent')!.id]!.subtasks.length, 2);
  const single = await v.getTask('Child one.md');
  assert.deepEqual([single!.task.title, single!.relations!.projects.length, single!.relations!.blocking.length], ['Child one', 2, 1]);
  assert.equal(await v.getTask('missing.md'), null);
});

test('the property names come from the TaskNotes settings, and the usual names are still read', async t => {
  const settings = { fieldMapping: { projects: 'belongsTo', blockedBy: 'waitingFor' } };
  const { vault } = await makeVault(t, {
    [statusSettingsFile]: JSON.stringify(settings),
    'Tasks/Boss.md': task(''),
    'Tasks/Report.md': task('belongsTo: ["[[Boss]]"]\nwaitingFor:\n  - uid: "[[Boss]]"'),
    'Tasks/Ignored.md': task('projects: ["[[Boss]]"]'),
  });
  const agenda = await (await open(vault, 'Tasks')).agenda('all', today);
  const id = (title: string) => agenda.today.find(x => x.title === title)!.id;
  assert.deepEqual(agenda.relations[id('Boss')]!.subtasks.map(s => s.title), ['Ignored', 'Report'], 'the renamed property counts, and so does the usual one');
  assert.equal(agenda.relations[id('Report')]!.blockedBy[0]!.name, 'Boss');
  // A note that still uses the usual name is read too, so nothing is lost while a vault is being changed over to the new name.
  assert.deepEqual(agenda.relations[id('Ignored')]!.projects.map(p => p.name), ['Boss']);
});

test('a small vault has relations alongside its tasks', async t => {
  const { vault } = await makeVault(t, { 'Tasks/A.md': task('projects: ["[[B]]"]'), 'Tasks/B.md': task('') });
  const agenda = await (await open(vault, 'Tasks')).agenda('all', today);
  assert.equal(agenda.today.length, 2); assert(Object.keys(agenda.relations).length > 0, 'a small vault has relations');
});
