import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importProfile, readStartupEntry, sourceProfileFrom, splitCommandLine } from '../apps/desktop/import-profile.ts';

const raw = String.raw;
const installedExe = raw`C:\Users\me\AppData\Local\Programs\obsidian-task-manager\Obsidian Task Manager.exe`;
// The entry a run from source writes, as Windows stores it (this is the shape found on the author's PC).
const fromSource = (project: string, profile = project + raw`\.local\desktop`) =>
  raw`"${project}\node_modules\electron\dist\electron.exe" "${project}\dist\desktop\main.cjs" --task-autostart "--task-profile=${profile}"`;

test('a command line is split the way Windows does for paths', () => {
  assert.deepEqual(splitCommandLine(raw`"C:\a b\x.exe" "C:\c d\main.cjs" --task-autostart "--task-profile=C:\e f"`),
    [raw`C:\a b\x.exe`, raw`C:\c d\main.cjs`, '--task-autostart', raw`--task-profile=C:\e f`]);
  assert.deepEqual(splitCommandLine('  plain  args '), ['plain', 'args']);
  assert.deepEqual(splitCommandLine(''), []);
});

test('the profile of a run from source is read from its start-at-login command', () => {
  assert.equal(sourceProfileFrom(fromSource(raw`C:\Work\obsidian-task-manager`), installedExe), raw`C:\Work\obsidian-task-manager\.local\desktop`);
  assert.equal(sourceProfileFrom(fromSource(raw`C:\사용자\홍길동\otm`, raw`D:\profiles\mine`), installedExe), raw`D:\profiles\mine`, 'the profile switch wins');
  assert.equal(sourceProfileFrom(raw`"C:\otm\node_modules\electron\dist\electron.exe" "C:\otm\dist\desktop\main.cjs" --task-autostart`, installedExe),
    raw`C:\otm\.local\desktop`, 'without the switch, the default next to main.cjs');
  assert.equal(sourceProfileFrom(null, installedExe), null);
  assert.equal(sourceProfileFrom(`"${installedExe}" --task-autostart "--task-profile=${raw`C:\x`}"`, installedExe), null, 'the installed app itself');
  assert.equal(sourceProfileFrom(raw`"C:\elsewhere\electron.exe" "C:\elsewhere\app.js"`, installedExe), null, 'not this project');
  assert.equal(sourceProfileFrom(raw`"C:\otm\electron.exe" dist\desktop\main.cjs`, installedExe), null, 'a relative path says nothing');
});

test('the startup entry is read through PowerShell as UTF-8 JSON, and a switched-off entry is reported off', async () => {
  const calls: string[][] = [];
  const answer = (json: string) => async (file: string, args: string[]) => { calls.push([file, ...args]); return json; };
  const command = fromSource(raw`C:\사용자\otm`);
  assert.deepEqual(await readStartupEntry(answer(JSON.stringify({ command, enabled: true }))), { command, enabled: true });
  assert.equal(calls[0]![0], 'powershell.exe');
  assert.match(calls[0]!.at(-1)!, /OutputEncoding = \[Text\.Encoding\]::UTF8/);
  assert.match(calls[0]!.at(-1)!, /'Obsidian Task Manager'/);
  assert.deepEqual(await readStartupEntry(answer('{"command":null,"enabled":true}')), { command: null, enabled: true });
  assert.deepEqual(await readStartupEntry(answer(JSON.stringify({ command, enabled: false }))), { command, enabled: false });
});

async function profiles(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'import-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = path.join(root, 'source'), to = path.join(root, 'installed');
  await mkdir(path.join(from, 'categories'), { recursive: true }); await mkdir(path.join(from, 'Local Storage', 'leveldb'), { recursive: true });
  await mkdir(path.join(from, 'task-backups'), { recursive: true }); await mkdir(to, { recursive: true });
  await writeFile(path.join(from, 'vault.json'), '{"vaultPath":"C:\\\\Vault","taskRelativePath":"."}');
  await writeFile(path.join(from, 'pet.json'), '{"x":1}');
  await writeFile(path.join(from, 'categories', 'abc.json'), '["업무","개인"]');
  await writeFile(path.join(from, 'Local Storage', 'leveldb', '000003.log'), 'theme');
  await writeFile(path.join(from, 'task-backups', 'note.md'), 'a private note');
  return { from, to };
}

test('the settings are copied into an installed app that has no vault yet, but not the backups', async t => {
  const { from, to } = await profiles(t);
  assert.equal(await importProfile(from, to), true);
  assert.equal(await readFile(path.join(to, 'vault.json'), 'utf8'), await readFile(path.join(from, 'vault.json'), 'utf8'));
  assert.equal(await readFile(path.join(to, 'pet.json'), 'utf8'), '{"x":1}');
  assert.equal(await readFile(path.join(to, 'categories', 'abc.json'), 'utf8'), '["업무","개인"]');
  assert.equal(await readFile(path.join(to, 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'theme');
  assert.deepEqual((await readdir(to)).sort(), ['Local Storage', 'categories', 'pet.json', 'vault.json']);
  assert.deepEqual((await readdir(from)).sort(), ['Local Storage', 'categories', 'pet.json', 'task-backups', 'vault.json'], 'the source profile is left as it was');
});

test('nothing is copied once the installed app has a vault, or when the source has none', async t => {
  const { from, to } = await profiles(t);
  await writeFile(path.join(to, 'vault.json'), '{"mine":true}');
  assert.equal(await importProfile(from, to), false);
  assert.deepEqual(await readdir(to), ['vault.json']);
  assert.equal(await readFile(path.join(to, 'vault.json'), 'utf8'), '{"mine":true}');
  const empty = path.join(path.dirname(to), 'nothing');
  await mkdir(empty);
  assert.equal(await importProfile(empty, path.join(path.dirname(to), 'fresh')), false);
  assert.equal(await importProfile(path.join(path.dirname(to), 'missing'), to), false);
});
