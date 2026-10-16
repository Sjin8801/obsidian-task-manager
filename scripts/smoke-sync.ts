import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import electron from 'electron';
import { localDate } from '../packages/tasknotes/task.ts';

// Real Electron with a fake `ob` (obsidian-headless): no Obsidian account, network, real vault or Obsidian Sync is touched.
// The fake reads its behaviour from scenario.txt / mode.txt in its own folder, so each step can switch it.
await mkdir('.local', { recursive: true });
const root = await mkdtemp(path.resolve('.local/sync-smoke-'));
const vault = path.join(root, '테스트 볼트 & 노트'), tasks = path.join(vault, 'TaskNotes/Tasks'), profile = path.join(root, 'profile');
const fake = path.join(root, 'fake-ob'), notifyLog = path.join(root, 'notifications.jsonl');
await mkdir(tasks, { recursive: true }); await mkdir(profile); await mkdir(fake);
// The checks read Korean text whatever language this PC uses.
await writeFile(path.join(profile, 'language.json'), JSON.stringify({ language: 'ko' }));
await writeFile(path.join(tasks, 'a.md'), `---\ntitle: 동기화 테스트\ntags: [task]\n상태: 시작\n예정일: ${localDate(new Date())}\n---\n합성 본문`);
await writeFile(path.join(profile, 'vault.json'), JSON.stringify({ vaultPath: vault, taskRelativePath: 'TaskNotes/Tasks' }));
await writeFile(path.join(fake, 'cli.cjs'), `
const fs = require('node:fs'), path = require('node:path');
const read = (name, fallback) => { try { return fs.readFileSync(path.join(__dirname, name), 'utf8').trim(); } catch { return fallback; } };
const [command, ...rest] = process.argv.slice(2);
const vault = rest[rest.indexOf('--path') + 1];
const scenario = read('scenario.txt', 'ok');
if (command === 'sync-status') {
  if (scenario === 'notconfigured') { console.error('No sync configuration found for ' + vault); console.error("Run 'ob sync-setup' first."); process.exitCode = 1; }
  else console.log(JSON.stringify({ vaultName: 'MyVault', vaultPath: vault, syncMode: read('mode.txt', 'bidirectional') }, null, 2));
} else if (command === 'sync') {
  fs.appendFileSync(path.join(__dirname, 'starts.log'), JSON.stringify({ pid: process.pid, vault, args: rest }) + '\\n');
  if (scenario === 'notloggedin') { console.error('No account logged in. Run "ob login" first.'); process.exitCode = 1; }
  else if (scenario === 'crash') { console.error('Sync failed: boom'); process.exitCode = 1; }
  else if (scenario === 'locked') { console.error('Another sync instance is already running for this vault.'); process.exitCode = 1; }
  else {
    console.log('Connecting...');
    if (scenario === 'ok') setTimeout(() => { console.log('Uploading (1/2) a.md'); console.log('Uploading (2/2) b.md'); console.log('Fully synced'); }, 250);
    setInterval(() => {}, 1000);
  }
} else process.exitCode = 2;
`);
const setScenario = (name: string) => writeFile(path.join(fake, 'scenario.txt'), name);
const setMode = (mode: string) => writeFile(path.join(fake, 'mode.txt'), mode);
const starts = async () => (await readFile(path.join(fake, 'starts.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid: number; vault: string; args: string[] });
const notifications = async () => (await readFile(notifyLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { title: string; body: string });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean> | boolean, message: string, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  assert.fail(message);
}

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { TASK_DESKTOP_DATA: profile, TASK_HEADLESS_ENTRY: path.join(fake, 'cli.cjs'), TASK_HEADLESS_NODE: process.execPath, TASK_HEADLESS_TEST_TIMINGS: '1', TASK_TEST_NOTIFY_LOG: notifyLog });
let desktop: ElectronApplication | undefined;
let page!: Page;
const errors: string[] = [];
async function launch() {
  desktop = await _electron.launch({ executablePath: electron as unknown as string, args: [path.resolve('dist/desktop/main.cjs')], cwd: process.cwd(), env, chromiumSandbox: true, timeout: 30_000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('.task').first().waitFor();
  await page.keyboard.press('Control+k');
  await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await section().waitFor();
}
const section = () => page.getByRole('region', { name: 'Headless 동기화 실행' });
const box = () => section().getByRole('checkbox', { name: 'Headless 동기화 실행' });
const statusLine = () => section().locator('.sync-status');
const chip = () => page.locator('.sync-chip');
const waitStatus = (text: string, timeout = 8000) => statusLine().filter({ hasText: text }).waitFor({ timeout });
async function switchSync(on: boolean) {
  if ((await box().isChecked()) !== on) await box().click();
  if (on) await statusLine().waitFor(); else await statusLine().waitFor({ state: 'detached' });
}
async function restartSync() { await switchSync(false); await switchSync(true); }
async function openLog() { const log = section().locator('details.sync-log'); if (!(await log.getAttribute('open') !== null)) await log.locator('summary').click(); return log.locator('pre').innerText(); }

try {
  await launch();

  // Off until the user turns it on; the guide shows the real vault path in the command to run.
  assert.equal(await box().isChecked(), false);
  assert.equal(await statusLine().count(), 0); assert.equal((await starts()).length, 0);
  await section().locator('details.sync-guide summary').click();
  const setupCommand = await section().locator('.sync-guide code').filter({ hasText: 'ob sync-setup' }).innerText();
  assert(setupCommand.includes(`--path "${vault}"`), setupCommand);
  assert((await section().innerText()).includes('옵시디언 앱 Sync는 꺼 주세요'));

  // Healthy: starts once with the vault path as a single argument, reaches "최신 상태", and shows the mode.
  await setScenario('ok'); await switchSync(true);
  await waitStatus('최신 상태');
  assert.equal(await box().isChecked(), true);
  const first = (await starts())[0]!;
  assert.deepEqual(first.args, ['--continuous', '--path', vault]); assert.equal(first.vault, vault);
  assert(alive(first.pid), 'the client is running');
  assert((await section().innerText()).includes('동기화 방식: 양방향'));
  assert.equal(JSON.parse(await readFile(path.join(profile, 'sync.json'), 'utf8')).headlessSync, true);
  assert.equal(await chip().count(), 0);
  assert((await openLog()).includes('Fully synced'));
  await page.screenshot({ path: path.join(root, 'sync-ok.png') });

  // Turning it off stops the client.
  await switchSync(false);
  await until(() => !alive(first.pid), 'the client stops when turned off');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'sync.json'), 'utf8')).headlessSync, false);

  // Not logged in: explained with the command to run, announced once, and not retried in a loop.
  await setScenario('notloggedin'); await switchSync(true);
  await waitStatus('로그인해야');
  assert((await section().locator('.notice.error').innerText()).includes('ob login'));
  await chip().waitFor(); assert.equal(await chip().innerText(), '동기화 문제');
  await until(async () => (await notifications()).some(n => n.title === '동기화가 멈췄어요' && n.body.includes('로그인')), 'a notification is shown');
  const before = (await starts()).length; await delay(1500);
  assert.equal((await starts()).length, before, 'no retry loop');
  await page.screenshot({ path: path.join(root, 'sync-problem.png') });
  await setScenario('ok'); await section().getByRole('button', { name: '다시 시도' }).click();
  await waitStatus('최신 상태'); await chip().waitFor({ state: 'detached' });

  // A one-way sync mode is refused before anything runs, and the text says how to fix it.
  await setMode('mirror-remote'); const beforeMode = (await starts()).length; await restartSync();
  await waitStatus('양방향이 아니에요');
  const modeHint = await section().locator('.notice.error').innerText();
  assert(modeHint.includes('--mode bidirectional') && modeHint.includes(`--path "${vault}"`), modeHint);
  assert.equal((await starts()).length, beforeMode, 'not started in a one-way mode');
  await setMode('bidirectional'); await section().getByRole('button', { name: '다시 시도' }).click(); await waitStatus('최신 상태');

  // Vault not connected to sync: explained before starting.
  await setScenario('notconfigured'); const beforeConfig = (await starts()).length; await restartSync();
  await waitStatus('연결되지 않았어요');
  assert((await section().locator('.notice.error').innerText()).includes(`ob sync-setup --vault "원격 볼트 이름" --path "${vault}"`));
  assert.equal((await starts()).length, beforeConfig);
  await setScenario('ok'); await section().getByRole('button', { name: '다시 시도' }).click(); await waitStatus('최신 상태');

  // Keeps crashing: retried a few times, then given up with the last output on screen.
  await setScenario('crash'); const beforeCrash = (await starts()).length; await restartSync();
  await waitStatus('계속 멈춰요');
  assert.equal((await starts()).length - beforeCrash, 4, 'first run plus three restarts');
  assert((await openLog()).includes('Sync failed: boom'));
  await until(async () => (await notifications()).some(n => n.body.includes('계속 멈춰요')), 'a notification for the crash loop');
  await setScenario('ok'); await section().getByRole('button', { name: '다시 시도' }).click(); await waitStatus('최신 상태');

  // Another client already syncs this vault: retried briefly for a stale lock, then reported.
  await setScenario('locked'); const beforeLock = (await starts()).length; await restartSync();
  await waitStatus('이미 동기화하고 있어요');
  assert.equal((await starts()).length - beforeLock, 3);
  await setScenario('ok'); await section().getByRole('button', { name: '다시 시도' }).click(); await waitStatus('최신 상태');

  // Connected to nothing for too long: reported as stalled (short timings in this test).
  await setScenario('connecting'); await restartSync();
  await waitStatus('오래 연결되지 않아요');
  await chip().waitFor(); assert.equal(await chip().innerText(), '동기화 지연');
  await until(async () => (await notifications()).some(n => n.title === '동기화가 지연되고 있어요'), 'a notification for the stall');
  await setScenario('ok'); await restartSync(); await waitStatus('최신 상태'); await chip().waitFor({ state: 'detached' });

  // Quitting the app stops the client; the choice is remembered and the next launch starts it again.
  const running = (await starts()).at(-1)!;
  assert(alive(running.pid));
  await desktop!.close(); desktop = undefined;
  await until(() => !alive(running.pid), 'the client stops when the app quits', 8000);
  const beforeRestart = (await starts()).length;
  await launch();
  assert.equal(await box().isChecked(), true);
  await waitStatus('최신 상태');
  assert.equal((await starts()).length, beforeRestart + 1);

  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ synthetic: true, fakeObsidianHeadless: true, offByDefault: true, guideHasVaultPath: true, startsWithVaultAsOneArgument: true, statusSynced: true,
    stopsWhenTurnedOff: true, notLoggedIn: true, noRetryLoop: true, oneWayModeRefused: true, notConfigured: true, crashLoopGivesUp: true, alreadyRunning: true, stallDetected: true,
    notifications: true, titleBarChip: true, stopsWhenAppQuits: true, rememberedAcrossLaunches: true, realObsidianSyncTouched: false, pageErrors: errors }, null, 2));
  console.log('Sync smoke passed: ' + root);
} catch (error) { if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error; }
finally { await desktop?.close(); }
