import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright-core';
import { localDate } from '../packages/contracts/dates.ts';
import { execFile } from 'node:child_process';
import { readStartupEntry, sourceProfileFrom } from '../apps/desktop/import-profile.ts';

// The packaged app from `npm run dist` (release/win-unpacked), before it is installed: it starts, reads its screens and font out of
// app.asar, keeps its data in the profile it is given, lists a vault's tasks and shows the widget. It runs with an isolated profile and
// TASK_DESKTOP_DATA set, so it never imports settings or touches the start-at-login entry; that entry is only read, to report what the
// first run of an installed copy would import on this PC.
const executable = path.resolve('release', 'win-unpacked', 'Obsidian Task Manager.exe');
await mkdir('.local', { recursive: true });
const root = await mkdtemp(path.resolve('.local', 'packaged-smoke-'));
const vault = path.join(root, 'vault'), tasks = path.join(vault, 'TaskNotes', 'Tasks'), profile = path.join(root, 'profile');
await mkdir(tasks, { recursive: true }); await mkdir(profile);
await writeFile(path.join(profile, 'language.json'), JSON.stringify({ language: 'en' }));
await writeFile(path.join(profile, 'pet.json'), JSON.stringify({ x: 700, y: 380, hidden: false, alwaysOnTop: true, peek: true }));
await writeFile(path.join(tasks, 'a.md'), `---\ntitle: Packaged task\ntags: [task, work]\nstatus: open\nscheduled: ${localDate(new Date())}\n---\n`);
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE; env.TASK_DESKTOP_DATA = profile;
const app = await _electron.launch({ executablePath: executable, args: [`--task-profile=${profile}`], env, chromiumSandbox: true, timeout: 30_000 });
try {
  const page = await app.firstWindow();
  const pet = app.windows().find(window => window !== page) ?? await app.waitForEvent('window');
  const facts = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData'), appPath: app.getAppPath(), name: app.getName() }));
  assert.equal(facts.packaged, true);
  assert.equal(path.resolve(facts.userData), path.resolve(profile));
  assert.match(facts.appPath, /app\.asar$/);
  assert.equal(facts.name, 'Obsidian Task Manager');
  await page.locator('.vault-select').waitFor();
  // The font is served from inside app.asar by the app's own protocol.
  assert.deepEqual(await page.evaluate(async () => (await document.fonts.load('16px Pretendard')).map(face => face.status)), ['loaded'], 'Pretendard loaded');
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog; }, vault);
  await page.locator('.vault-select').click();
  await page.locator('.task').filter({ hasText: 'Packaged task' }).waitFor();
  await pet.waitForURL('taskmanager://app/pet.html');
  await pet.locator('.pet-caption strong').filter({ hasText: '1 task today' }).waitFor();
  await page.screenshot({ path: path.join(root, 'packaged.png') });
  const entry = await readStartupEntry((file, args) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (error, out) => error ? reject(error) : resolve(out))));
  console.log(JSON.stringify({ ok: true, ...facts, startAtLoginOn: entry.enabled && !!entry.command, wouldImportFrom: sourceProfileFrom(entry.command, executable), folder: root }, null, 2));
} finally { await app.close(); }

// The first run of an installed copy on a PC where the app ran from source and started at login: the settings come over, the vault is
// open straight away, and the start at login is taken over. The entry is handed in, and the takeover is written to a file, not to Windows.
const source = path.join(root, 'source-project'), sourceProfile = path.join(source, '.local', 'desktop'), installed = path.join(root, 'installed');
const loginLog = path.join(root, 'login.log');
await mkdir(sourceProfile, { recursive: true }); await mkdir(installed);
await writeFile(path.join(sourceProfile, 'vault.json'), JSON.stringify({ vaultPath: await realpath(vault), taskRelativePath: 'TaskNotes/Tasks' }));
await writeFile(path.join(sourceProfile, 'language.json'), JSON.stringify({ language: 'en' }));
await writeFile(path.join(sourceProfile, 'pet.json'), JSON.stringify({ x: 700, y: 380, hidden: false, alwaysOnTop: true, peek: true }));
const command = `"${path.join(source, 'node_modules', 'electron', 'dist', 'electron.exe')}" "${path.join(source, 'dist', 'desktop', 'main.cjs')}" --task-autostart "--task-profile=${sourceProfile}"`;
const importing = await _electron.launch({ executablePath: executable, args: [`--task-profile=${installed}`], chromiumSandbox: true, timeout: 30_000,
  env: { ...env, TASK_DESKTOP_DATA: installed, TASK_TEST_STARTUP_ENTRY: JSON.stringify({ command, enabled: true }), TASK_TEST_LOGIN_LOG: loginLog } });
try {
  const page = await importing.firstWindow();
  await page.locator('.task').filter({ hasText: 'Packaged task' }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(path.join(installed, 'vault.json'), 'utf8')).taskRelativePath, 'TaskNotes/Tasks');
  assert.equal(await readFile(loginLog, 'utf8'), 'takeover\n');
  console.log('Import on first run: settings copied, vault open, start at login taken over.');
} finally { await importing.close(); }
