import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron, type ElectronApplication } from 'playwright-core';
import electron from 'electron';
import { localDate, parseTask } from '../packages/tasknotes/task.ts';
import { shortDate, shortDateTime } from '../packages/contracts/dates.ts';
import { koreanSetup } from '../tests/korean-setup.ts';

// Real Electron, real local Markdown reads, simulated native folder-picker results.
// No API server, Obsidian process, network dependency or production vault access.
await mkdir('.local', { recursive: true });
const root = await mkdtemp(path.resolve('.local', 'local-desktop-smoke-'));
const vault = path.join(root, '테스트 볼트'), tasks = path.join(vault, 'TaskNotes/Tasks');
const second = path.join(root, '다른 볼트'), profile = path.join(root, 'profile');
await mkdir(tasks, { recursive: true }); await mkdir(second); await mkdir(profile);
// The notes below are written the way a Korean TaskNotes setup writes them, so the vault has that setup (property names, status values).
await koreanSetup(vault);
await writeFile(path.join(profile, 'connection.bin'), 'legacy profile is not loaded');
// The checks below read Korean text whatever language this PC uses; the language switch is tried further down.
await writeFile(path.join(profile, 'language.json'), JSON.stringify({ language: 'ko' }));
const raw = (await readFile('tests/fixtures/일반 작업.md', 'utf8')).replaceAll('2026-09-14', localDate(new Date()));
await writeFile(path.join(tasks, 'work.md'), raw);
await writeFile(path.join(tasks, 'personal.md'), raw.replace('테스트 업무 검토', '테스트 개인 작업').replace('- 업무', '- 개인'));
await writeFile(path.join(second, 'only.md'), raw.replace('테스트 업무 검토', '다른 볼트 작업'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE; env.TASK_DESKTOP_DATA = profile;
let desktop: ElectronApplication | undefined;
const errors: string[] = [];
async function launch() {
  const instance = await _electron.launch({ executablePath: electron as unknown as string, args: [path.resolve('dist/desktop/main.cjs')], cwd: process.cwd(), env, chromiumSandbox: true, timeout: 30_000 });
  const page = await instance.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  const widget = instance.windows().find(window => window !== page) ?? await instance.waitForEvent('window');
  await widget.waitForURL('taskmanager://app/pet.html');
  await widget.locator('.pet-caption').waitFor();
  page.setDefaultTimeout(10_000); return { instance, page };
}
async function nativeBack() {
  await desktop!.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.emit('app-command', {}, 'browser-backward');
  });
}
async function mouseBack() {
  const page = await desktop!.firstWindow();
  const input = await page.context().newCDPSession(page);
  // Real Chromium side-button input, rather than only a synthetic app-command.
  await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'back', buttons: 8, x: 350, y: 60, clickCount: 1 });
  await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'back', buttons: 0, x: 350, y: 60, clickCount: 1 });
  await input.detach();
}
async function picker(directory: string | null) {
  await desktop!.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = (async () => ({ canceled: selected === null, filePaths: selected ? [selected] : [] })) as typeof dialog.showOpenDialog;
  }, directory);
}
try {
  let launched = await launch(); desktop = launched.instance; let page = launched.page;
  await page.getByRole('button', { name: 'Obsidian 볼트 선택' }).waitFor();
  assert.equal(await page.getByLabel('서버 주소').count(), 0);
  assert.equal(await page.getByLabel('일회용 연결 코드').count(), 0);
  await page.screenshot({ path: path.join(root, 'welcome.png') });
  await picker(null); await page.getByRole('button', { name: 'Obsidian 볼트 선택' }).click();
  await page.getByRole('button', { name: 'Obsidian 볼트 선택' }).waitFor();
  await picker(vault); await page.getByRole('button', { name: 'Obsidian 볼트 선택' }).click();
  await page.getByRole('button').filter({ hasText: '테스트 업무 검토' }).waitFor();
  assert.equal(await page.locator('.task').count(), 2);
  await page.getByRole('tab', { name: '업무', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 1);
  await page.getByRole('tab', { name: '전체', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  assert.equal(await page.getByLabel('전체 작업 검색').count(), 0);
  await page.getByRole('button', { name: '작업 검색 열기' }).focus();
  const before = await page.locator('.task.highlighted').getAttribute('id');
  await page.keyboard.press('ArrowDown'); assert.notEqual(await page.locator('.task.highlighted').getAttribute('id'), before);
  await page.keyboard.press('Enter'); await page.locator('.body-text').waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '작업 검색 열기' }).waitFor();
  await page.keyboard.press('Control+f');
  await page.getByLabel('전체 작업 검색').fill('개인');
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 1 && document.querySelector('.task-title')?.textContent?.endsWith('테스트 개인 작업'));
  await page.getByRole('button', { name: '검색 팝업 닫기' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  await page.getByRole('button', { name: '창 숨기기', exact: true }).click();
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.isVisible()), false);
  await desktop.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!; window.show(); window.focus(); });
  await page.getByRole('button').filter({ hasText: '테스트 업무 검토' }).waitFor();
  // Back restores the preceding screen and filters; Esc uses the same behavior.
  await page.getByRole('tab', { name: '업무', exact: true }).click();
  await page.locator('.task').dblclick();
  await mouseBack();
  await page.getByRole('button', { name: '작업 검색 열기' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '업무', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('tab', { name: '전체', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Control+f');
  await page.getByLabel('전체 작업 검색').fill('업무');
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 1);
  await page.getByLabel('전체 작업 검색').focus(); await page.keyboard.press('Enter');
  await page.locator('.body-text').waitFor();
  await page.getByRole('button', { name: '상세 수정', exact: true }).click();
  await page.getByLabel('상세 내용', { exact: true }).fill('뒤로가기 중 보존할 초안');
  await mouseBack(); await page.getByRole('button', { name: '계속 편집', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: '계속 편집', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('상세 내용', { exact: true }).inputValue(), '뒤로가기 중 보존할 초안');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '변경 내용 버리기', exact: true }).click();
  await page.locator('.body-text').waitFor();
  assert.equal(await readFile(path.join(tasks, 'work.md'), 'utf8'), raw);
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await mouseBack(); await page.locator('.body-text').waitFor();
  // Duplicate native + DOM signals from one mouse press must not skip a second screen.
  await nativeBack(); assert.equal(await page.locator('.body-text').count(), 1);
  await page.keyboard.press('Escape'); await page.getByLabel('전체 작업 검색').waitFor();
  assert.equal(await page.getByLabel('전체 작업 검색').inputValue(), '업무');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('전체 작업 검색').count(), 0);
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  await page.locator('.task').first().click({ button: 'right' });
  await mouseBack(); await page.getByRole('menu', { name: '상태 변경' }).waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: '완료', exact: true }).click();
  await page.keyboard.press('Control+f');
  await page.getByLabel('전체 작업 검색').fill('아무 검색');
  await mouseBack();
  assert.equal(await page.getByLabel('전체 작업 검색').count(), 0);
  assert.equal(await page.getByRole('tab', { name: '완료', exact: true }).getAttribute('aria-selected'), 'true');
  await mouseBack();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  // Mouse drivers may map Back to Alt+Left. Test that input path as well.
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 220));
  await page.keyboard.press('Alt+ArrowLeft'); await page.getByRole('button', { name: '작업 검색 열기' }).waitFor();
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.isVisible()), true);
  // Each row shows when the task is scheduled and when it is due, and flags a passed due date.
  const todayKey = localDate(new Date());
  const dated = page.locator('.task').filter({ hasText: '테스트 업무 검토' });
  assert.equal((await dated.locator('.task-date').allInnerTexts()).map(t => t.replace(/s+/g, ' ').trim()).join(' '), `· 예정 ${shortDate(todayKey, todayKey)} · 마감 ${shortDateTime('2026-09-13T18:00:00+09:00', todayKey)}`);
  assert.equal(await dated.locator('.task-date.late').count(), 1, 'only the passed due date is flagged');
  await page.screenshot({ path: path.join(root, 'desktop.png') });
  const appState = await desktop.evaluate(({ BrowserWindow, globalShortcut }) => ({ windows: BrowserWindow.getAllWindows().length, shortcutRegistered: globalShortcut.isRegistered('CommandOrControl+Shift+Space') }));
  assert.equal(appState.windows, 2);
  assert.equal(await page.evaluate(() => 'require' in window || 'process' in window), false);
  assert.equal(await page.evaluate(() => Object.keys(window.taskManager ?? {}).sort().join(',')), 'addCategory,agenda,editRelation,findRelated,forgetVault,getTask,hide,onBack,onChanged,onOpenTask,onShow,onSyncStatus,retryHeadlessSync,saveTask,search,selectTaskFolder,selectVault,setAutoStart,setHeadlessSync,setLanguage,setShortcut,setShortcutCapture,showPet,status');
  assert.equal(await readFile(path.join(tasks, 'work.md'), 'utf8'), raw);
  // Native HTML drag and drop uses only synthetic task files.
  await page.locator('.task-content[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('.category-group[data-category="업무"] .task').count(), 1);
  assert.equal(await page.locator('.category-group[data-category="개인"] .task').count(), 1);
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).dragTo(page.locator('.category-group[data-category="개인"] .category-divider'));
  await page.waitForFunction(() => document.querySelectorAll('.category-group[data-category="개인"] .task').length === 2);
  let moved = parseTask('work.md', await readFile(path.join(tasks, 'work.md'), 'utf8'));
  assert(moved.tags.includes('개인')); assert(!moved.tags.includes('업무')); assert(moved.tags.includes('task'));
  await page.getByRole('button', { name: '분류 추가', exact: true }).click();
  await page.getByLabel('분류 이름').fill('학습'); await page.getByRole('button', { name: '추가', exact: true }).click();
  await page.getByRole('tab', { name: '학습', exact: true }).waitFor();
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).dragTo(page.getByRole('tab', { name: '학습', exact: true }));
  await page.waitForFunction(() => document.querySelectorAll('.category-group[data-category="학습"] .task').length === 1);
  moved = parseTask('work.md', await readFile(path.join(tasks, 'work.md'), 'utf8'));
  assert(moved.tags.includes('학습')); assert(!moved.tags.includes('개인')); assert(!moved.tags.includes('업무'));
  await page.getByRole('tab', { name: '학습', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 1);
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).dragTo(page.getByRole('tab', { name: '업무', exact: true }));
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 0);
  moved = parseTask('work.md', await readFile(path.join(tasks, 'work.md'), 'utf8'));
  assert(moved.tags.includes('업무')); assert(!moved.tags.includes('학습'));
  await page.getByRole('tab', { name: '전체', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  // A concurrent external edit must reject a drop instead of overwriting the source.
  const external = await readFile(path.join(tasks, 'work.md'), 'utf8') + '\n외부 분류 변경 테스트';
  await writeFile(path.join(tasks, 'work.md'), external);
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).dragTo(page.locator('.category-group[data-category="개인"] .category-divider'));
  await page.getByRole('alert').filter({ hasText: '다른 앱에서' }).waitFor();
  assert.equal(await readFile(path.join(tasks, 'work.md'), 'utf8'), external);
  await page.waitForFunction(() => document.querySelectorAll('.category-group[data-category="업무"] .task').length === 1);
  await page.getByRole('button', { name: '저장 오류 닫기' }).click();
  // Mouse-only updates write synthetic notes and preserve other metadata.
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).click({ button: 'right' });
  await page.getByRole('menu', { name: '상태 변경' }).waitFor();
  const menuColors = await page.getByRole('menu', { name: '상태 변경' }).locator('.state-dot').evaluateAll(nodes => nodes.map(n => { const css = getComputedStyle(n); return [css.borderColor, css.backgroundColor].join('|'); }));
  assert.equal(new Set(menuColors).size, 4);
  const startedColor = await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).locator('.state-dot').evaluate(n => getComputedStyle(n).backgroundColor);
  await page.screenshot({ path: path.join(root, 'status-menu.png') });
  await page.getByRole('menuitemradio', { name: '진행 중', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.task')].some(t => t.textContent?.includes('테스트 업무 검토') && t.textContent.includes('진행 중')));
  assert((await readFile(path.join(tasks, 'work.md'), 'utf8')).includes('상태: 진행 중'));
  assert.equal(await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).locator('.state-dot').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(0, 102, 204)');
  assert.notEqual(startedColor, 'rgb(0, 102, 204)');
  // A status added in TaskNotes appears in the app's menu and editor while the app runs, and can be chosen.
  const settingsFile = path.join(vault, '.obsidian/plugins/tasknotes/data.json');
  await mkdir(path.dirname(settingsFile), { recursive: true });
  const listed = (value: string, order: number, extra: object = {}) => ({ id: value, value, label: value, color: '#888888', isCompleted: false, order, ...extra });
  // The same settings rename the start date property: this note keeps its start date under 시작일.
  await writeFile(path.join(tasks, 'renamed.md'), `---
title: 이름 바꾼 작업
tags: [task, 업무]
상태: 시작
시작일: ${localDate(new Date())}
---

본문
`);
  await writeFile(settingsFile, JSON.stringify({ fieldMapping: { scheduled: '시작일' }, customStatuses: [listed('없음', 0), listed('시작', 1), listed('진행 중', 2), listed('지연', 3, { color: '#cc3300' }), listed('완료', 4, { isCompleted: true })] }));
  const reviewRow = page.locator('.task').filter({ hasText: '테스트 업무 검토' }), statusMenu = page.getByRole('menu', { name: '상태 변경' }), lateItem = page.getByRole('menuitemradio', { name: '지연', exact: true });
  for (let attempt = 0; attempt < 30; attempt++) {
    await reviewRow.click({ button: 'right' }); await statusMenu.waitFor();
    if (await lateItem.count()) break;
    await page.keyboard.press('Escape'); await delay(300);
  }
  assert.deepEqual(await statusMenu.getByRole('menuitemradio').allInnerTexts().then(items => items.map(t => t.replace(/✓/g, '').replace(/\s+/g, ' ').trim())), ['없음', '시작', '진행 중', '지연', '완료'], 'the app menu follows the TaskNotes settings');
  await lateItem.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.task')].some(t => t.textContent?.includes('테스트 업무 검토') && t.textContent.includes('지연')));
  assert((await readFile(path.join(tasks, 'work.md'), 'utf8')).includes('상태: 지연'));
  assert.equal(await reviewRow.locator('.state-dot').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(204, 51, 0)', 'a status added in TaskNotes is drawn in its own colour');
  await reviewRow.dblclick(); await page.getByRole('main', { name: '작업 편집' }).waitFor();
  assert.equal(await page.getByLabel('상태', { exact: true }).inputValue(), '지연');
  assert.deepEqual(await page.getByLabel('상태', { exact: true }).locator('option').allInnerTexts(), ['없음', '시작', '진행 중', '지연', '완료'], 'the editor lists the same statuses');
  await page.getByRole('button', { name: '취소', exact: true }).click(); await page.getByRole('button', { name: '작업 검색 열기' }).waitFor();
  await reviewRow.click({ button: 'right' }); await statusMenu.waitFor();
  await page.getByRole('menuitemradio', { name: '진행 중', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.task')].some(t => t.textContent?.includes('테스트 업무 검토') && t.textContent.includes('진행 중')));
  // The property names follow the TaskNotes field mapping: the note is listed, edited with the usual 예정일 label, and saved under the name in the settings.
  const renamedRow = page.locator('.task').filter({ hasText: '이름 바꾼 작업' });
  await renamedRow.waitFor({ timeout: 8000 });
  await renamedRow.dblclick(); await page.getByRole('main', { name: '작업 편집' }).waitFor();
  // The screen keeps calling it 예정일, as TaskNotes does; only the property name in the note follows the settings.
  assert.equal(await page.getByLabel('예정일', { exact: true }).inputValue(), localDate(new Date()));
  await page.getByLabel('예정일', { exact: true }).fill('2026-01-05');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '작업 검색 열기' }).waitFor();
  const renamedRaw = await readFile(path.join(tasks, 'renamed.md'), 'utf8');
  assert(/시작일: 2026-01-05/.test(renamedRaw), 'the date is saved under the name in the settings');
  assert(!/예정일/.test(renamedRaw), 'no property is added under the old name');
  await unlink(path.join(tasks, 'renamed.md'));
  await renamedRow.waitFor({ state: 'detached', timeout: 8000 });
  await koreanSetup(vault); // back to the setup the other notes are written for
  // A date can carry a time: pick the date, switch on the time when it is needed. A note keeps its time when other things are edited.
  const timedFile = path.join(tasks, 'timed.md');
  await writeFile(timedFile, `---
title: 시간 있는 작업
tags: [task, 업무]
상태: 시작
예정일: ${todayKey}T09:00
마감일: ${todayKey}
---

본문
`);
  const timedRow = page.locator('.task').filter({ hasText: '시간 있는 작업' });
  await timedRow.waitFor({ timeout: 8000 });
  assert.match(await timedRow.innerText(), new RegExp(`예정 ${shortDate(todayKey, todayKey)} 09:00`), 'the row shows the time');
  const saveEditor = async () => { await page.getByRole('button', { name: '저장', exact: true }).click(); await page.getByRole('button', { name: '작업 검색 열기' }).waitFor(); };
  const timedLines = async () => (await readFile(timedFile, 'utf8')).split('\n').filter(l => /^(예정일|마감일)/.test(l));
  await timedRow.dblclick(); await page.getByRole('main', { name: '작업 편집' }).waitFor();
  assert.equal(await page.getByLabel('예정일', { exact: true }).inputValue(), todayKey);
  assert.equal(await page.getByLabel('예정일 시간', { exact: true }).inputValue(), '09:00');
  assert.equal(await page.getByRole('checkbox', { name: '예정일 시간 포함' }).isChecked(), true, 'a note with a time opens with the time switched on');
  assert.equal(await page.getByRole('checkbox', { name: '마감일 시간 포함' }).isChecked(), false);
  assert.equal(await page.getByLabel('마감일 시간', { exact: true }).count(), 0, 'no time field for a plain date');
  await page.getByRole('button', { name: '저장', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '저장', exact: true }).isDisabled(), true, 'opening a note does not change it');
  await page.getByLabel('예정일 시간', { exact: true }).fill('14:30'); await saveEditor();
  assert.deepEqual(await timedLines(), [`예정일: ${todayKey}T14:30`, `마감일: ${todayKey}`]);
  await timedRow.dblclick(); await page.getByRole('main', { name: '작업 편집' }).waitFor();
  await page.getByRole('checkbox', { name: '마감일 시간 포함' }).check();
  assert.equal(await page.getByLabel('마감일 시간', { exact: true }).inputValue(), '09:00', 'switching the time on starts at 09:00');
  await page.getByLabel('마감일 시간', { exact: true }).fill('18:00'); await saveEditor();
  assert.deepEqual(await timedLines(), [`예정일: ${todayKey}T14:30`, `마감일: ${todayKey}T18:00`]);
  await timedRow.dblclick(); await page.getByRole('main', { name: '작업 편집' }).waitFor();
  await page.getByRole('checkbox', { name: '예정일 시간 포함' }).uncheck(); await saveEditor();
  assert.deepEqual(await timedLines(), [`예정일: ${todayKey}`, `마감일: ${todayKey}T18:00`], 'switching the time off keeps the date');
  await timedRow.dblclick(); await page.getByRole('main', { name: '작업 편집' }).waitFor();
  await page.screenshot({ path: path.join(root, 'editor-dates.png') });
  await page.getByRole('button', { name: '날짜 지우기' }).first().click(); await saveEditor();
  assert.deepEqual(await timedLines(), [`마감일: ${todayKey}T18:00`], 'clearing a date takes the property out, as TaskNotes does');
  await unlink(timedFile);
  await timedRow.waitFor({ state: 'detached', timeout: 8000 });
  // How tasks relate: a project note outside the task folder, a parent with two subtasks, and a task blocked by the parent.
  // Links name files, not titles, so the notes below are linked by file name.
  const relationFiles = ['rel-parent.md', 'rel-child-a.md', 'rel-child-b.md', 'rel-blocked.md'];
  await mkdir(path.join(vault, 'Projects'), { recursive: true });
  await writeFile(path.join(vault, 'Projects', '로드맵.md'), '# 프로젝트 노트\n');
  const relationNote = (title: string, status: string, extra = '') => `---\ntitle: ${title}\ntags: [task, 업무]\n상태: ${status}\n예정일: ${todayKey}\n${extra}---\n\n본문\n`;
  await writeFile(path.join(tasks, 'rel-parent.md'), relationNote('관계 상위 작업', '시작'));
  await writeFile(path.join(tasks, 'rel-child-a.md'), relationNote('관계 하위 A', '시작', 'projects:\n  - "[[rel-parent]]"\n  - "[[로드맵]]"\n'));
  await writeFile(path.join(tasks, 'rel-child-b.md'), relationNote('관계 하위 B', '완료', `완료일: ${todayKey}\nprojects:\n  - "[[rel-parent]]"\n`));
  await writeFile(path.join(tasks, 'rel-blocked.md'), relationNote('관계 막힌 작업', '시작', 'blockedBy:\n  - uid: "[[rel-parent]]"\n    reltype: FINISHTOSTART\n    gap: P1D\n'));
  // Found by its title element: a subtask's chip repeats its parent's title, so matching the whole row would find both.
  const relRow = (title: string) => page.locator('.task').filter({ has: page.locator('.task-title', { hasText: new RegExp(`^${title}$`) }) });
  await relRow('관계 상위 작업').waitFor({ timeout: 8000 }); await relRow('관계 막힌 작업').waitFor();
  const chips = async (title: string) => (await relRow(title).locator('.rel-chip').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
  // A subtask whose parent is in the same list is shown under the parent, not as a row of its own.
  assert.equal(await relRow('관계 하위 A').count(), 0, 'a subtask is not listed twice');
  const parentLine = page.locator('.task-line').filter({ has: relRow('관계 상위 작업') });
  const toggle = parentLine.locator('.sub-toggle');
  assert.equal((await toggle.innerText()).replace(/\s+/g, ''), '1/2▸', 'the parent says how far its subtasks are, with an arrow');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'the subtasks start closed');
  assert.equal(await parentLine.locator('.rel-chip').count(), 0, 'the toggle is the only place that count is shown');
  assert.deepEqual(await chips('관계 막힌 작업'), ['막힘'], 'a task whose blocker is unfinished says so');
  const subRow = (title: string) => parentLine.locator('.sub-row').filter({ hasText: title });
  assert.equal(await subRow('관계 하위 A').isVisible(), false, 'closed subtasks take no room');
  // Opening: the subtasks appear one after the other, still to do first, then the finished one.
  await toggle.click();
  await subRow('관계 하위 B').waitFor({ state: 'visible' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual((await parentLine.locator('.sub-row .sub-title').allInnerTexts()), ['관계 하위 A', '관계 하위 B'], 'still to do first, then finished');
  assert.equal(await subRow('관계 하위 B').evaluate(el => getComputedStyle(el.querySelector('.sub-title')!).textDecorationLine), 'line-through', 'a finished subtask is struck through');
  await page.screenshot({ path: path.join(root, 'relations-list.png') });
  // The choice is remembered, and the arrow keys do the same as the toggle.
  await page.reload(); await relRow('관계 상위 작업').waitFor();
  assert.equal(await parentLine.locator('.sub-toggle').getAttribute('aria-expanded'), 'true', 'an open parent stays open the next time');
  await parentLine.locator('.sub-toggle').click();
  assert.equal(await parentLine.locator('.sub-toggle').getAttribute('aria-expanded'), 'false');
  await relRow('관계 상위 작업').hover(); await page.keyboard.press('ArrowRight');
  assert.equal(await parentLine.locator('.sub-toggle').getAttribute('aria-expanded'), 'true', 'the right arrow opens the highlighted parent');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await parentLine.locator('.sub-toggle').getAttribute('aria-expanded'), 'false', 'the left arrow closes it');
  // The detail screen names every relation, and a related task opens in place.
  await parentLine.locator('.sub-toggle').click();
  await subRow('관계 하위 A').click();
  await page.getByRole('heading', { name: '관계 하위 A' }).waitFor();
  const projectSection = page.getByRole('region', { name: '속한 프로젝트' });
  assert.deepEqual((await projectSection.locator('.rel-row').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()), ['관계 상위 작업 시작 상위 작업', '로드맵'], 'the project note outside the task folder is found by its link');
  await page.screenshot({ path: path.join(root, 'relations-detail.png') });
  await projectSection.locator('.rel-link', { hasText: '관계 상위 작업' }).click();
  await page.getByRole('heading', { name: '관계 상위 작업' }).waitFor();
  const subtaskSection = page.getByRole('region', { name: '하위 작업' });
  assert.match(await subtaskSection.locator('.rel-title').innerText(), /1\/2 완료/);
  assert.equal(await subtaskSection.locator('.rel-link').count(), 2);
  assert.deepEqual((await page.getByRole('region', { name: '이 작업이 막고 있는 작업' }).locator('.rel-row').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()), ['관계 막힌 작업 시작']);
  await subtaskSection.locator('.rel-link', { hasText: '관계 하위 B' }).click();
  await page.getByRole('heading', { name: '관계 하위 B' }).waitFor();
  await page.getByRole('button', { name: '← 뒤로' }).click(); await page.getByRole('button', { name: '← 뒤로' }).click(); await page.getByRole('button', { name: '← 뒤로' }).click();
  await relRow('관계 막힌 작업').click(); await relRow('관계 막힌 작업').press('Enter');
  await page.getByRole('heading', { name: '관계 막힌 작업' }).waitFor();
  const blockerRows = (await page.getByRole('region', { name: '차단 원인' }).locator('.rel-row').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
  assert.equal(blockerRows.length, 1); assert.match(blockerRows[0]!, /관계 상위 작업/); assert.match(blockerRows[0]!, /아직 안 끝남/); assert.match(blockerRows[0]!, /간격 1일/);
  await page.getByRole('button', { name: '← 뒤로' }).click();
  // Changing relationships from the detail screen, by name. Two new tasks; nothing here names a file to the person.
  await writeFile(path.join(tasks, 'rel-edit-a.md'), relationNote('편집 대상 A', '시작'));
  await writeFile(path.join(tasks, 'rel-edit-b.md'), relationNote('편집 대상 B', '시작'));
  relationFiles.push('rel-edit-a.md', 'rel-edit-b.md');
  const noteText = (name: string) => readFile(path.join(tasks, name), 'utf8');
  await relRow('편집 대상 A').waitFor({ timeout: 8000 }); await relRow('편집 대상 B').waitFor();
  await relRow('편집 대상 A').click(); await relRow('편집 대상 A').press('Enter');
  await page.getByRole('heading', { name: '편집 대상 A' }).waitFor();
  assert.equal(await page.getByRole('region', { name: '속한 프로젝트', exact: true }).count(), 0, 'a task with nothing yet has no empty sections');
  assert.deepEqual(await page.getByRole('group', { name: '관계 추가' }).getByRole('button').allInnerTexts(), ['＋ 프로젝트·상위 작업', '＋ 하위 작업', '＋ 차단 원인', '＋ 막고 있는 작업'], 'each kind can be added');
  // A project that is an ordinary note, found by part of its name. Escape closes the box and leaves the screen where it is.
  await page.getByRole('button', { name: '＋ 프로젝트·상위 작업' }).click();
  const box = page.getByRole('combobox', { name: '프로젝트·상위 작업 찾기' });
  await box.waitFor(); await box.press('Escape');
  await box.waitFor({ state: 'detached' }); await page.getByRole('heading', { name: '편집 대상 A' }).waitFor();
  await page.getByRole('button', { name: '＋ 프로젝트·상위 작업' }).click();
  await box.fill('로드');
  await page.getByRole('option', { name: /로드맵/ }).waitFor();
  assert.match(await page.getByRole('option', { name: /로드맵/ }).innerText(), /노트 · Projects/, 'a note says it is a note and where it is');
  await box.press('Enter');
  const projectsOfA = page.getByRole('region', { name: '속한 프로젝트', exact: true });
  await projectsOfA.getByText('로드맵').waitFor({ timeout: 8000 });
  assert.match(await noteText('rel-edit-a.md'), /projects:\n {2}- "\[\[로드맵\]\]"/, 'the link is written in this task\'s own note');
  // A subtask is chosen from the parent; the link goes in the subtask's note.
  await page.getByRole('button', { name: '＋ 하위 작업' }).click();
  await page.getByRole('combobox', { name: '하위 작업 찾기' }).fill('편집 대상 B');
  await page.getByRole('option', { name: /편집 대상 B/ }).click();
  await page.getByRole('region', { name: '하위 작업', exact: true }).getByText('편집 대상 B').waitFor({ timeout: 8000 });
  assert.match(await noteText('rel-edit-b.md'), /projects:\n {2}- "\[\[rel-edit-a\]\]"/);
  assert.doesNotMatch(await noteText('rel-edit-a.md'), /편집 대상 B|rel-edit-b/, 'this task\'s note does not name its subtask');
  // Its own subtask is not offered as a parent (that would be a loop); the box says there is nothing to pick.
  await page.getByRole('region', { name: '속한 프로젝트', exact: true }).getByRole('button', { name: '프로젝트·상위 작업 추가' }).click();
  await page.getByRole('combobox', { name: '프로젝트·상위 작업 찾기' }).fill('편집 대상 B');
  await page.getByText('맞는 항목이 없어요.').waitFor();
  await page.getByRole('combobox', { name: '프로젝트·상위 작업 찾기' }).press('Escape');
  // A blocker, then the blockers go again, each by its own × button.
  await page.getByRole('button', { name: '＋ 차단 원인' }).click();
  await page.getByRole('combobox', { name: '차단 원인 찾기' }).fill('관계 상위');
  await page.getByRole('option', { name: /관계 상위 작업/ }).click();
  await page.getByRole('region', { name: '차단 원인', exact: true }).getByText('관계 상위 작업').waitFor({ timeout: 8000 });
  assert.match(await noteText('rel-edit-a.md'), /blockedBy:\n {2}- uid: "\[\[rel-parent\]\]"\n {4}reltype: FINISHTOSTART/);
  await page.screenshot({ path: path.join(root, 'relations-editing.png') });
  await page.getByRole('button', { name: '관계 상위 작업 연결 해제' }).click();
  await page.getByRole('region', { name: '차단 원인', exact: true }).waitFor({ state: 'detached', timeout: 8000 });
  assert.doesNotMatch(await noteText('rel-edit-a.md'), /blockedBy/);
  await page.getByRole('button', { name: '로드맵 연결 해제' }).click();
  await page.getByRole('region', { name: '속한 프로젝트', exact: true }).waitFor({ state: 'detached', timeout: 8000 });
  await page.getByRole('button', { name: '편집 대상 B 연결 해제' }).click();
  await page.getByRole('region', { name: '하위 작업', exact: true }).waitFor({ state: 'detached', timeout: 8000 });
  assert.doesNotMatch(await noteText('rel-edit-b.md'), /projects/);
  assert.equal((await noteText('rel-edit-a.md')).replace(/^(수정일|dateModified): .*\n/m, ''), relationNote('편집 대상 A', '시작'), 'taking everything out leaves the note as it was, apart from the modified time');
  await page.getByRole('button', { name: '← 뒤로' }).click();
  for (const name of relationFiles) await unlink(path.join(tasks, name));
  await unlink(path.join(vault, 'Projects', '로드맵.md'));
  await relRow('관계 상위 작업').waitFor({ state: 'detached', timeout: 8000 });
  await page.evaluate(() => localStorage.removeItem('taskmanager-expanded'));
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).dblclick();
  await page.getByRole('main', { name: '작업 편집' }).waitFor();
  // The blank line after the properties is not shown as empty lines in front of the text.
  assert(!(await page.getByLabel('상세 내용', { exact: true }).inputValue()).startsWith('\n'));
  await page.getByLabel('상세 내용', { exact: true }).fill('마우스로 편집한 테스트 본문 [[연결]]');
  await page.getByLabel('우선순위', { exact: true }).selectOption('high');
  await page.getByLabel('예정일', { exact: true }).fill('2026-09-15');
  await page.getByLabel('마감일', { exact: true }).fill('2026-09-30');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.webContents.send('task:show'));
  assert.equal(await page.getByLabel('상세 내용', { exact: true }).inputValue(), '마우스로 편집한 테스트 본문 [[연결]]');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '계속 편집', exact: true }).click();
  // Save stays reachable at the top of the editor even after scrolling down.
  await page.locator('.editor').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const saveBox = (await page.getByRole('button', { name: '저장', exact: true }).boundingBox())!;
  const editorBox = (await page.locator('.editor').boundingBox())!;
  assert(saveBox.y >= editorBox.y && saveBox.y + saveBox.height <= editorBox.y + 80, `save button at ${saveBox.y - editorBox.y}px from the top of the editor`);
  await page.locator('.editor').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(root, 'editor.png') });
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '작업 검색 열기' }).waitFor();
  let savedRaw = await readFile(path.join(tasks, 'work.md'), 'utf8');
  assert(savedRaw.includes('마우스로 편집한 테스트 본문 [[연결]]'));
  assert(/\n---\r?\n\r?\n마우스로 편집한 테스트 본문/.test(savedRaw), 'the blank line after the properties is written back');
  assert(savedRaw.includes('우선순위: high')); assert(savedRaw.includes('2026-09-30'));
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).dblclick();
  await page.getByLabel('상세 내용', { exact: true }).fill('충돌 시 보존할 초안');
  await writeFile(path.join(tasks, 'work.md'), savedRaw + '\n외부 편집');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '다른 앱에서' }).waitFor();
  assert.equal(await page.getByLabel('상세 내용', { exact: true }).inputValue(), '충돌 시 보존할 초안');
  assert.equal(await readFile(path.join(tasks, 'work.md'), 'utf8'), savedRaw + '\n외부 편집');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '변경 내용 버리기', exact: true }).click();
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).click({ button: 'right' });
  await page.getByRole('menuitemradio', { name: '완료', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task-content > section .task').length === 1);
  savedRaw = await readFile(path.join(tasks, 'work.md'), 'utf8');
  assert(savedRaw.includes('상태: 완료')); assert(savedRaw.includes('완료일:'));
  await writeFile(path.join(tasks, 'old-english.md'), '---\ntags: [task, 개인]\nstatus: done\npriority: normal\ncompletedDate: 2020-01-01\n---\nLegacy complete body');
  await writeFile(path.join(tasks, 'old-undated.md'), '---\ntags: [task, 업무]\n상태: 완료\n---\n');
  await page.getByRole('tab', { name: '완료', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 3);
  assert.equal(await page.locator('.task:not(.done)').count(), 0);
  await page.keyboard.press('Control+f');
  await page.getByLabel('전체 작업 검색').fill('old-english');
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 1);
  assert.equal(await page.locator('.state-dot.done').count(), 1);
  await page.locator('.task').dblclick();
  assert.equal(await page.getByLabel('상태', { exact: true }).inputValue(), '완료');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '검색 팝업 닫기' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 3);
  await page.screenshot({ path: path.join(root, 'completed-tab.png') });
  await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).click({ button: 'right' });
  await page.getByRole('menuitemradio', { name: '시작', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task-content > section .task').length === 2);
  assert(!/완료일/.test(await readFile(path.join(tasks, 'work.md'), 'utf8')), 'reopening a task takes its completion date out instead of leaving an empty one');
  assert.equal(await page.locator('.task').filter({ hasText: '테스트 업무 검토' }).count(), 0);
  await page.getByRole('tab', { name: '전체', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  await page.screenshot({ path: path.join(root, 'desktop.png') });
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await page.getByRole('button', { name: '화이트', exact: false }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await page.locator('.app').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(root, 'light-settings.png') });
  await page.getByRole('button', { name: '블랙', exact: false }).click();
  assert.equal(await page.locator('.app').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(32, 32, 34)');
  await page.getByRole('button', { name: '화이트', exact: false }).click();
  // The language: English in the settings, the list, the tray-less parts of the main process and the widget; then back to Korean.
  const petPage = desktop!.windows().find(w => w.url().endsWith('/pet.html'))!;
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Language', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'language.json'), 'utf8')).language, 'en', 'the choice is kept in the profile');
  await page.getByRole('heading', { name: 'Theme', exact: true }).waitFor(); await page.getByRole('button', { name: 'Light', exact: false }).waitFor();
  await petPage.locator('.pet-caption strong').filter({ hasText: /tasks? today/ }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: path.join(root, 'english-settings.png') });
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.getByRole('tab', { name: 'All', exact: true }).waitFor();
  assert.deepEqual((await page.getByRole('tab').allInnerTexts()).map(t => t.trim()).slice(0, 3), ['All', 'work', 'personal'], 'the built-in categories take the language');
  await page.getByRole('button', { name: 'Open task search' }).waitFor();
  await page.screenshot({ path: path.join(root, 'english-list.png') });
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: 'Vault settings', exact: true }).click();
  await page.getByRole('button', { name: '한국어', exact: true }).click();
  await page.getByRole('heading', { name: '언어', exact: true }).waitFor();
  await petPage.locator('.pet-caption strong').filter({ hasText: /오늘 할 일 \d+개/ }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: '← 뒤로', exact: true }).click();
  await page.getByRole('tab', { name: '업무', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'light-list.png') });
  await page.getByRole('button', { name: '작업 검색 열기' }).click();
  await page.getByRole('dialog', { name: '작업 검색', exact: true }).waitFor();
  assert.equal(await page.getByLabel('전체 작업 검색').evaluate(el => el === document.activeElement), true);
  await page.getByLabel('전체 작업 검색').fill('테스트');
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  assert(await page.locator('footer').evaluate(el => Math.abs(el.getBoundingClientRect().bottom - window.innerHeight) <= 2));
  // Tab remains in the modal; hidden background controls cannot receive focus.
  await page.locator('.search-dialog .task').last().focus(); await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: '검색 팝업 닫기' }).evaluate(el => el === document.activeElement), true);
  await page.getByLabel('전체 작업 검색').focus();
  await page.screenshot({ path: path.join(root, 'light-search.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.setSize(440, 620));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(root, 'light-search-narrow.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.setSize(680, 620));
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: '작업 검색', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '작업 검색 열기' }).evaluate(el => el === document.activeElement), true);
  await desktop.close(); desktop = undefined;
  launched = await launch(); desktop = launched.instance; page = launched.page;
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByRole('button').filter({ hasText: '테스트 업무 검토' }).waitFor();
  await page.getByRole('tab', { name: '학습', exact: true }).waitFor();
  // Observe actual row removals, not just the eventual successful refresh.
  await page.locator('.task-content[aria-busy="false"]').waitFor();
  await page.getByRole('button', { name: '작업 검색 열기' }).focus(); await page.keyboard.press('ArrowDown');
  const selectedBeforeRefresh = await page.locator('.task.highlighted').getAttribute('id');
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.task')];
    (window as any).refreshRows = rows;
    (window as any).removedRefreshRows = false;
    const observer = new MutationObserver(records => {
      for (const record of records) for (const removed of record.removedNodes) {
        if (rows.some(row => removed === row || removed.contains(row))) (window as any).removedRefreshRows = true;
      }
    });
    observer.observe(document.querySelector('.task-content')!, { childList: true, subtree: true });
    (window as any).refreshObserver = observer;
  });
  await writeFile(path.join(tasks, 'work.md'), raw.replace('테스트 업무 검토', '외부 수정 반영'));
  await page.getByRole('button', { name: '↻ 새로고침', exact: true }).click();
  await page.getByRole('button').filter({ hasText: '외부 수정 반영' }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).removedRefreshRows), false);
  assert.equal(await page.evaluate(() => (window as any).refreshRows.every((row: Element) => row.isConnected)), true);
  assert.equal(await page.locator('.task.highlighted').getAttribute('id'), selectedBeforeRefresh);
  await page.mouse.move(1, 1);
  // File events must update the UI well before the 30-second fallback interval.
  const liveStarted = Date.now();
  await writeFile(path.join(tasks, 'work.md'), raw.replace('테스트 업무 검토', '자동 갱신 반영'));
  await page.getByRole('button').filter({ hasText: '자동 갱신 반영' }).waitFor({ timeout: 3000 });
  const liveUpdateMs = Date.now() - liveStarted;
  assert.equal(await page.evaluate(() => (window as any).removedRefreshRows), false);
  assert.equal(await page.locator('.task.highlighted').getAttribute('id'), selectedBeforeRefresh);
  await page.evaluate(() => (window as any).refreshObserver.disconnect());
  // Detail views also reread external changes, without replacing an editor draft.
  await page.keyboard.press('Control+f');
  await page.getByLabel('전체 작업 검색').fill('자동 갱신 반영');
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 1);
  await page.getByLabel('전체 작업 검색').press('Enter'); await page.locator('.body-text').waitFor();
  await writeFile(path.join(tasks, 'work.md'), raw.replace('테스트 업무 검토', '자동 갱신 반영') + '\n실시간 상세 갱신');
  await page.locator('.body-text').filter({ hasText: '실시간 상세 갱신' }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: '상세 수정', exact: true }).click();
  await page.getByLabel('상세 내용', { exact: true }).fill('보존할 실시간 편집 초안');
  const concurrent = raw.replace('테스트 업무 검토', '자동 갱신 반영') + '\n다른 앱의 새 본문';
  await writeFile(path.join(tasks, 'work.md'), concurrent);
  await page.waitForTimeout(700);
  assert.equal(await page.getByLabel('상세 내용', { exact: true }).inputValue(), '보존할 실시간 편집 초안');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '다른 앱에서' }).waitFor();
  assert.equal(await readFile(path.join(tasks, 'work.md'), 'utf8'), concurrent);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '변경 내용 버리기', exact: true }).click();
  await page.locator('.body-text').filter({ hasText: '다른 앱의 새 본문' }).waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '검색 팝업 닫기' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  // Atomic replacement, creation, rename and deletion all work without manual refresh.
  await writeFile(path.join(tasks, 'incoming.tmp'), raw.replace('테스트 업무 검토', '원자적 저장 반영'));
  await rename(path.join(tasks, 'incoming.tmp'), path.join(tasks, 'work.md'));
  await page.getByRole('button').filter({ hasText: '원자적 저장 반영' }).waitFor({ timeout: 3000 });
  await writeFile(path.join(tasks, 'created.md'), raw.replace('테스트 업무 검토', '외부 생성 작업'));
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 3, null, { timeout: 3000 });
  await rename(path.join(tasks, 'created.md'), path.join(tasks, 'renamed.md'));
  await page.waitForFunction(async () => { const r = await window.taskManager!.getTask('renamed.md'); return r.ok && r.value?.task.path === 'renamed.md'; });
  await page.keyboard.press('Control+f');
  await page.getByLabel('전체 작업 검색').fill('외부 생성 작업');
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 1);
  await page.getByLabel('전체 작업 검색').press('Enter'); await page.locator('.body-text').waitFor();
  await unlink(path.join(tasks, 'renamed.md'));
  await page.getByLabel('전체 작업 검색').waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: '검색 팝업 닫기' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2, null, { timeout: 3000 });
  // Expanded completed history keeps its loaded pages and scroll position on refresh.
  for (let i = 0; i < 105; i++) await writeFile(path.join(tasks, `history-${i}.md`), '---\ntags: [task, 업무]\nstatus: done\n---\n');
  await page.getByRole('tab', { name: '완료', exact: true }).click();
  await desktop.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.webContents.send('task:changed'), 50); });
  await page.getByRole('button', { name: '더 보기', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 107);
  await page.locator('.task-content').evaluate(el => { el.scrollTop = 1200; });
  const historyScroll = await page.locator('.task-content').evaluate(el => el.scrollTop);
  assert(historyScroll > 0);
  await page.locator('.task').first().evaluate(el => { (window as any).historyRow = el; });
  await writeFile(path.join(tasks, 'history-0.md'), '---\ntags: [task, 업무]\nstatus: done\ntitle: 갱신된 완료 작업\n---\n');
  await page.waitForFunction(() => document.querySelector('.task-content')?.textContent?.includes('갱신된 완료 작업'), null, { timeout: 3000 });
  assert.equal(await page.locator('.task').count(), 107);
  assert.equal(await page.evaluate(() => (window as any).historyRow.isConnected), true);
  assert.equal(await page.locator('.task-content').evaluate(el => el.scrollTop), historyScroll);
  await mouseBack();
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);

  await rename(tasks, tasks + '-moved');
  await page.getByRole('button', { name: '↻ 새로고침', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '마지막으로 받은 목록' }).waitFor();
  assert.equal(await page.locator('.task').count(), 2);
  await desktop.close(); desktop = undefined;
  launched = await launch(); desktop = launched.instance; page = launched.page;
  await page.getByRole('alert').filter({ hasText: '볼트나 작업 폴더' }).waitFor();
  assert.equal(await page.locator('.task').count(), 0);
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await picker(second); await page.getByRole('button', { name: '다른 볼트 선택' }).click();
  await page.getByRole('button').filter({ hasText: '다른 볼트 작업' }).waitFor();
  assert.equal(await page.locator('.task').count(), 1);
  await page.getByRole('tab', { name: '완료', exact: true }).click();
  await page.getByRole('heading', { name: '완료한 작업이 없어요.', exact: true }).waitFor();
  assert.equal(await page.locator('.task').count(), 0);
  await page.getByRole('tab', { name: '전체', exact: true }).click();
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await picker(root); await page.getByRole('button', { name: '작업 폴더 변경' }).click();
  await page.getByRole('alert').filter({ hasText: '볼트 안의 작업 폴더' }).waitFor();
  // The list keeps loading behind the settings screen. A load that lands after the refusal (here a file change) must not take the
  // message away; it used to, whenever the load from the tab click above finished late (about 3 runs in 5).
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.webContents.send('task:changed'));
  await delay(1000);
  assert.equal(await page.getByRole('alert').filter({ hasText: '볼트 안의 작업 폴더' }).count(), 1, 'a list refresh keeps the refused folder message');
  assert.equal(await page.getByRole('tab', { name: '학습', exact: true }).count(), 0);
  const custom = path.join(second, 'custom'); await mkdir(custom);
  await writeFile(path.join(custom, 'task.md'), raw.replace('테스트 업무 검토', '다른 폴더 작업'));
  await picker(custom); await page.getByRole('button', { name: '작업 폴더 변경' }).click();
  await page.getByRole('button').filter({ hasText: '다른 폴더 작업' }).waitFor();
  assert.equal(await page.locator('.task').count(), 1);
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await page.getByRole('button', { name: '← 뒤로', exact: true }).click();
  for (const category of ['학습', '운동', '가족', '재무', '사이드프로젝트', '여행']) {
    await page.getByRole('button', { name: '분류 추가', exact: true }).click();
    await page.getByLabel('분류 이름').fill(category); await page.getByRole('button', { name: '추가', exact: true }).click();
    await page.getByRole('tab', { name: category, exact: true }).waitFor();
  }
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.setSize(440, 620));
  await page.getByRole('tab', { name: '여행', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole('tab').count(), 10);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(root, 'wrapped-tabs.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.setSize(680, 620));
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await page.getByLabel('앱 단축키', { exact: true }).click();
  await page.keyboard.press('Control+Alt+Shift+F9');
  assert.equal(await page.getByLabel('앱 단축키', { exact: true }).inputValue(), 'Ctrl + Alt + Shift + F9');
  assert.equal(await page.getByRole('dialog', { name: '작업 동작' }).count(), 0);
  await page.getByRole('button', { name: '단축키 저장', exact: true }).click();
  await page.getByText('단축키를 저장했어요. 다음 실행에도 유지돼요.', { exact: true }).waitFor();
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F9')), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'shortcut.json'), 'utf8')), { shortcut: 'Control+Alt+Shift+F9' });
  // Simulate a competing app's occupied key without changing the real user's shortcuts.
  await desktop.evaluate(({ globalShortcut }) => { (globalThis as any).originalRegister = globalShortcut.register; globalShortcut.register = (key, callback) => key === 'Control+Alt+Shift+F10' ? false : (globalThis as any).originalRegister.call(globalShortcut, key, callback); });
  await page.getByLabel('앱 단축키', { exact: true }).click();
  await page.keyboard.press('Control+Alt+Shift+F10');
  await page.getByRole('button', { name: '단축키 저장', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '기존 단축키는 유지했어요' }).waitFor();
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F9')), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'shortcut.json'), 'utf8')), { shortcut: 'Control+Alt+Shift+F9' });
  await page.screenshot({ path: path.join(root, 'shortcut-settings.png') });
  await desktop.close(); desktop = undefined;
  launched = await launch(); desktop = launched.instance; page = launched.page;
  await page.getByRole('button').filter({ hasText: '다른 폴더 작업' }).waitFor();
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  assert.equal(await page.getByLabel('앱 단축키', { exact: true }).inputValue(), 'Ctrl + Alt + Shift + F9');
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F9')), true);
  await page.getByLabel('앱 단축키', { exact: true }).click(); await page.keyboard.press('a');
  await page.getByRole('alert').filter({ hasText: 'Ctrl 또는 Alt' }).waitFor();
  await page.getByRole('button', { name: '기본값', exact: true }).click();
  assert.equal(await page.getByLabel('앱 단축키', { exact: true }).inputValue(), 'Ctrl + Shift + Space');
  await page.getByRole('button', { name: '← 뒤로', exact: true }).click();

  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  await page.getByRole('button', { name: '볼트 선택 해제' }).click();
  await page.getByRole('button', { name: 'Obsidian 볼트 선택' }).waitFor();
  await desktop.close(); desktop = undefined;
  launched = await launch(); desktop = launched.instance; page = launched.page;
  await page.getByRole('button', { name: 'Obsidian 볼트 선택' }).waitFor();
  assert.deepEqual(errors, []);
  const report = { synthetic: true, desktop: 'real Electron window', folderPicker: 'native result simulated in main process', apiServerRequired: false, vaultSelection: true, cancelSelection: true, filtersSearchKeyboard: true, searchPopup: true, searchEscapeRestoresList: true, searchRestoredFromDetail: true, whiteAndBlackThemes: true, themePersists: true, categoryGroups: true, dragWritesSourceTags: true, dragToEmptyGroup: true, dragToCategoryTab: true, addedCategoryPersists: true, categoryVaultIsolation: true, wrappedTabsAt440px: true, dragConflictRejected: true, completedHistoryTab: true, completedSearch: true, completedReopenRemovesRow: true, englishMetadata: true, completedEmptyState: true, statusColors: true, configurableShortcut: true, shortcutPersists: true, shortcutConflictKeepsPrevious: true, chromiumMouseBack: true, nativeAndMouseDeduplicated: true, altLeftBack: true, escPreviousScreen: true, filtersRestoredOnBack: true, dirtyMouseBackGuard: true, refreshKeepsRowsMounted: true, refreshKeepsSelection: true, automaticRefreshWithoutBlankList: true, liveUpdateMs, liveDetail: true, liveDraftPreserved: true, liveCreateRenameDelete: true, liveAtomicReplacement: true, refreshKeepsExpandedPagesAndScroll: true, mouseStatusMenu: true, doubleClickEdit: true, realFileSave: true, conflictPreservesDraft: true, dirtyEscapeGuard: true, showPreservesDraft: true, completeAndReopen: true, restartSelection: true, externalEdit: true, missingFolderAndRecovery: true, switchVaultIsolation: true, outsideFolderRejected: true, customTaskFolder: true, forgetPersists: true, singleMainWindowAndPet: true, shortcutRegistered: appState.shortcutRegistered, physicalGlobalShortcutTested: false, pageErrors: errors, screenshot: path.relative(process.cwd(), path.join(root, 'desktop.png')) };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (desktop) { const page = await desktop.firstWindow(); await page.screenshot({ path: path.join(root, 'failure.png') }); console.log(await page.locator('body').innerText()); console.log(await page.locator('textarea').evaluateAll(nodes => nodes.map(n => n.outerHTML))); }
  throw error;
} finally { if (desktop) await desktop.close(); }
