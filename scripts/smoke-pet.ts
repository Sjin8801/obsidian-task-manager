import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import electron from 'electron';
import { localDate } from '../packages/tasknotes/task.ts';
import { shortDate } from '../packages/contracts/dates.ts';
import { koreanSetup } from '../tests/korean-setup.ts';
import { fitPeekHeight, peekChrome, peekMaxHeight, peekSubtaskRoom, rollSpeed } from '../apps/desktop/pet-model.ts';
await mkdir('.local', { recursive: true });
const root = await mkdtemp(path.resolve('.local/pet-smoke-'));
const vault = path.join(root, 'vault'), tasks = path.join(vault, 'TaskNotes/Tasks'), profile = path.join(root, 'profile');
await mkdir(tasks, { recursive: true }); await mkdir(profile);
// The notes below are written the way a Korean TaskNotes setup writes them, so the vault has that setup (property names, status values).
await koreanSetup(vault);
// The checks read Korean text whatever language this PC uses.
await writeFile(path.join(profile, 'language.json'), JSON.stringify({ language: 'ko' }));
await writeFile(path.join(profile, 'vault.json'), JSON.stringify({ vaultPath: vault, taskRelativePath: 'TaskNotes/Tasks' }));
// Start the widget away from the default bottom-right corner, where the real widget usually sits: a person hovering that one
// would send real mouse events to this window too (the panel collapsed and the title roll restarted in the middle of runs).
await writeFile(path.join(profile, 'pet.json'), JSON.stringify({ x: 700, y: 380, hidden: false, alwaysOnTop: true, peek: true }));
const raw = (title: string, status = '시작') => `---\ntitle: ${title}\ntags: [task, 업무]\n상태: ${status}\n예정일: ${localDate(new Date())}\n---\n합성 테스트 본문`;
for (let i = 0; i < 4; i++) await writeFile(path.join(tasks, `${i}.md`), raw('테스트 작업 ' + i, i === 2 ? '진행 중' : '시작'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE; env.TASK_DESKTOP_DATA = profile;
let desktop: ElectronApplication | undefined;
let page!: Page, pet!: Page;
const errors: string[] = [];
async function launch(autoStart = false) {
  desktop = await _electron.launch({ executablePath: electron as unknown as string, args: [path.resolve('dist/desktop/main.cjs'), ...(autoStart ? ['--task-autostart', `--task-profile=${profile}`] : [])], cwd: process.cwd(), env, chromiumSandbox: true });
  page = await desktop.firstWindow();
  pet = desktop.windows().find(w => w !== page) ?? await desktop.waitForEvent('window');
  await pet.waitForURL('taskmanager://app/pet.html');
  for (const window of [page, pet]) { window.setDefaultTimeout(10000); window.on('pageerror', e => errors.push(e.message)); }
  // Letting clicks through to the window behind cannot be tried from here: the test pointer exists only inside the page. Switching it on and
  // off also makes Windows send the page events for the real pointer, wherever that is, which closed the list in the middle of runs. So the
  // switch is recorded, not applied, and the window stays an ordinary one.
  await desktop.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!, calls: boolean[] = [];
    (globalThis as any).__passThrough = calls; win.setIgnoreMouseEvents(false);
    win.setIgnoreMouseEvents = ignore => { calls.push(ignore); };
  });
  // The widget also looks at the real pointer to notice it leaving (watchLeave in pet-window.ts). That pointer is wherever the person running
  // this left it, so it is put on the widget here; a step that needs it elsewhere sets __cursor.
  await desktop.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!, g = globalThis as any;
    g.__cursor = null;
    screen.getCursorScreenPoint = () => { if (g.__cursor) return g.__cursor; const b = win.getBounds(); return { x: Math.round(b.x + b.width / 2), y: b.y + b.height - 20 }; };
  });
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 4개' }).waitFor();
}
async function menu(label: string) {
  await desktop!.evaluate(({ Menu }, label) => {
    const original = Menu.prototype.popup;
    Menu.prototype.popup = function () {
      Menu.prototype.popup = original;
      const item = this.items.find(item => item.label === label);
      if (!item) throw new Error('Menu item not found');
      item.click?.(item, undefined, {});
    };
  }, label);
  await pet.locator('.pet-button').click({ button: 'right' });
}
const petWindowHeight = () => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!.getBounds().height);
// A stray real pointer can close the panel mid-run (the test pointer only exists inside the page, so it never leaves on its own).
// Reopen it the way a person would and count it in result.json, so one stray hand does not fail the run but a panel that keeps
// closing still shows up.
let reopened = 0;
async function ensurePeek() {
  if (await pet.locator('.peek').count()) return;
  reopened++;
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
}
// The panel reports its height over IPC, so wait until the window settles on its height + 62px of margins, gap and button. The height is
// the list's with its longest set of subtasks open (tallestHeight in pet.tsx), so `expected` is the panel + 62 only while no subtasks are hidden.
async function settledLayout() {
  await ensurePeek();
  let last!: { panel: number; scrolls: boolean; blank: number; gap: number; panelTop: number; panelBottom: number; buttonTop: number; buttonBottom: number; viewport: number; window: number; expected: number };
  for (let attempt = 0; attempt < 60; attempt++) {
    const { list, longest, ...m } = await pet.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.peek')!, button = document.querySelector('.pet-button')!;
      const p = panel.getBoundingClientRect(), b = button.getBoundingClientRect(), tail = panel.lastElementChild!.getBoundingClientRect();
      let shown = 0, longest = 0;
      for (const subs of document.querySelectorAll<HTMLElement>('.pet-subs')) {
        longest = Math.max(longest, [...subs.querySelectorAll('.pet-sub')].reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) + 3);
        shown += subs.getBoundingClientRect().height + (subs.parentElement!.classList.contains('open') ? 3 : 0);
      }
      const content = panel.scrollHeight > panel.clientHeight + 1 ? panel.scrollHeight + panel.offsetHeight - panel.clientHeight : p.height;
      return { panel: Math.ceil(p.height), scrolls: panel.scrollHeight > panel.clientHeight + 1, blank: p.bottom - tail.bottom, list: content - shown, longest,
        gap: p.top >= b.bottom ? p.top - b.bottom : b.top - p.bottom, panelTop: p.top, panelBottom: p.bottom, buttonTop: b.top, buttonBottom: b.bottom, viewport: window.innerHeight };
    });
    const room = peekMaxHeight + peekSubtaskRoom;
    last = { ...m, window: await petWindowHeight(), expected: fitPeekHeight(Math.min(list, peekMaxHeight) + Math.min(longest, peekSubtaskRoom), room) + peekChrome };
    // The page leaves out changes under 2px (sub-pixel rounding while subtasks slide), so the window may be 1px off.
    if (Math.abs(last.window - last.expected) <= 1) break;
    await delay(50);
  }
  return last;
}
function assertHugsButton(layout: Awaited<ReturnType<typeof settledLayout>>, message: string) {
  assert.equal(layout.window, layout.panel + 62, `${message}: window must be panel height + 62`);
  assert(Math.abs(layout.gap - 6) <= 1, `${message}: panel must sit 6px from the button, got ${layout.gap}`);
  assert(layout.panelTop >= -1 && layout.panelBottom <= layout.viewport + 1, `${message}: panel must stay inside the window ${JSON.stringify(layout)}`);
  assert(layout.buttonTop >= -1 && layout.buttonBottom <= layout.viewport + 1, `${message}: button must stay inside the window`);
}
try {
  await launch();
  assert.equal(await pet.locator('svg, img, canvas').count(), 0);
  assert.equal(await pet.evaluate(() => !!window.taskManager || 'require' in window || 'process' in window), false);
  // The menus are drawn by Windows, so they follow the app's own light/dark choice only if the main process is told about it.
  const menuTheme = async (expected: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await desktop!.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === expected) return;
      await delay(50);
    }
    assert.equal(await desktop!.evaluate(({ nativeTheme }) => nativeTheme.themeSource), expected, 'menu theme follows the app theme');
  };
  await menuTheme('dark');
  await page.evaluate(() => localStorage.setItem('taskmanager-theme', 'light')); await menuTheme('light');
  await page.evaluate(() => localStorage.removeItem('taskmanager-theme')); await menuTheme('dark');
  // Another always-on-top window (a meeting bar, a recorder) can take the top and cover the widget while its own setting is still on.
  // Real windows, read from the screen: the widget must come back above it by itself, and only while "항상 위에 표시" is on.
  const buttonBox = (await pet.locator('.pet-button').boundingBox())!;
  const spot = await desktop!.evaluate(({ BrowserWindow, screen }, box) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!, b = win.getBounds();
    const dip = { x: Math.round(b.x + box.x + 6), y: Math.round(b.y + box.y + box.height / 2) };
    return { dip, screen: screen.dipToScreenPoint(dip) };
  }, buttonBox);
  // Reading the screen needs a desktop this process can see. On a locked PC the read fails ("The handle is invalid") and every pixel
  // comes back black, which would look like a dark widget; so a failed read is its own answer, and the check is skipped, not failed.
  // A read can also fail without an error: from a sandboxed shell every pixel came back 0,0,0 with alpha 0, where a pixel really
  // copied from the screen is opaque. A transparent pixel therefore counts as a failed read too.
  // The colour alone cannot say whose pixel it is: any dark window there (another smoke run's widget sits on this same spot) looked
  // like this widget. So Windows is asked which window is at the spot, that is compared with this run's two windows, and the colour
  // only confirms the window really painted there.
  // No named functions inside evaluate(): tsx wraps them in a helper that does not exist in the app's main process.
  const handles = () => desktop!.evaluate(({ BrowserWindow }) => {
    const [widget, cover] = [BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html')), (globalThis as any).coverWindow as InstanceType<typeof BrowserWindow> | null | undefined]
      .map(w => { if (!w || w.isDestroyed()) return null; const h = w.getNativeWindowHandle(); return (h.length === 8 ? h.readBigUInt64LE() : BigInt(h.readUInt32LE())).toString(); });
    return { widget, cover };
  });
  const x = Math.round(spot.screen.x), y = Math.round(spot.screen.y);
  const spotScript = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class Spot {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$b = [System.Drawing.Bitmap]::new(1, 1); $g = [System.Drawing.Graphics]::FromImage($b)
try { $g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size) } catch { 'unavailable'; exit }
$c = $b.GetPixel(0, 0); if ($c.A -eq 0) { 'unavailable'; exit }
$p = New-Object Spot+P; $p.X = ${x}; $p.Y = ${y}
$h = [Spot]::GetAncestor([Spot]::WindowFromPoint($p), 2)
$t = New-Object System.Text.StringBuilder 256; [void][Spot]::GetWindowText($h, $t, 256); $id = 0; [void][Spot]::GetWindowThreadProcessId($h, [ref]$id)
ConvertTo-Json -Compress -InputObject @{ r = $c.R; g = $c.G; b = $c.B; window = $h.ToInt64().ToString(); pid = $id; title = $t.ToString() }`;
  const colourAt = async () => {
    const own = await handles();
    const text = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(spotScript, 'utf16le').toString('base64')], { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    if (text === 'unavailable') return 'unavailable';
    const { r, g, b, window, pid, title } = JSON.parse(text) as { r: number; g: number; b: number; window: string; pid: number; title: string };
    if (window === own.cover) return r > 200 && g < 90 && b < 90 ? 'other window' : `the test window, but painted ${r},${g},${b} instead of red`;
    if (window === own.widget) return r < 90 && g < 90 && b < 90 ? 'widget' : `the widget, but painted ${r},${g},${b}`;
    return `a window from outside this run (pid ${pid}, "${title}") at ${x},${y}; is another smoke run open?`;
  };
  const atStart = await colourAt(), canReadScreen = atStart !== 'unavailable';
  if (!canReadScreen) console.log('Window-order check skipped: the screen cannot be read right now (is the PC locked, or is this shell sandboxed?).');
  else assert.equal(atStart, 'widget', 'nothing else is over the widget before the window-order check');
  // A small window showing a plain red page. The app only lets its own session load its own pages, so the test window uses a
  // session of its own: an empty window was painted black some of the time, which a pixel read cannot tell from a dark widget.
  const coverWidget = () => desktop!.evaluate(async ({ BrowserWindow }, at) => {
    const w = new BrowserWindow({ x: at.x - 40, y: at.y - 40, width: 80, height: 80, frame: false, alwaysOnTop: true, show: false, skipTaskbar: true, focusable: false, backgroundColor: '#ff0000', webPreferences: { partition: 'cover-test' } });
    (globalThis as any).coverWindow = w;
    await w.loadURL('data:text/html,<body style="margin:0;background:rgb(255,0,0)"></body>');
    w.showInactive(); w.moveTop();
  }, spot.dip);
  const uncoverWidget = () => desktop!.evaluate(() => { (globalThis as any).coverWindow?.destroy(); (globalThis as any).coverWindow = null; });
  const widgetBack = async (seconds: number) => { for (let i = 0; i < seconds * 2; i++) { if (await colourAt() === 'widget') return true; await delay(500); } return false; };
  if (canReadScreen) {
    // With the setting off nothing raises the widget, so the window that took the top stays above it.
    await menu('항상 위에 표시'); await delay(300);
    await coverWidget(); await delay(500);
    assert.equal(await colourAt(), 'other window', 'the test window really covers the widget');
    await delay(4500);
    assert.equal(await colourAt(), 'other window', 'with "항상 위에 표시" off the widget is not raised');
    // Switch the setting on while it is covered: the widget comes back above the window on its own, which is what was missing.
    await menu('항상 위에 표시'); await delay(300);
    assert(await widgetBack(8), 'the widget comes back above a window that took the top');
    await uncoverWidget();
  }
  // Opening the widget menu above hovered the button, which opened the list. Close it again before the compact size is read.
  await pet.evaluate(() => window.taskPet!.expand(false));
  for (let i = 0; i < 40 && (await petWindowHeight()) !== 56; i++) await delay(50);
  const compact = await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!.getBounds());
  await pet.screenshot({ path: path.join(root, 'pet-compact-dark.png') });
  await pet.locator('.pet-button').hover(); await pet.getByRole('region', { name: '오늘 할 일 미리보기' }).waitFor();
  assert.equal(await pet.locator('.pet-task').count(), 4);
  assert((await pet.locator('.pet-task').first().innerText()).includes('테스트 작업 2'));
  // Each row says when the task is scheduled (these notes have a scheduled date of today and no due date).
  const todayKey = localDate(new Date());
  assert.equal((await pet.locator('.pet-task').filter({ hasText: '테스트 작업 0' }).locator('small').innerText()).trim(), `예정 ${shortDate(todayKey, todayKey)}`);
  assert.match(await pet.locator('.pet-task').filter({ hasText: '테스트 작업 2' }).locator('small').innerText(), /^진행 중 · 예정 \d/);
  await pet.screenshot({ path: path.join(root, 'pet-expanded-dark.png') });
  const four = await settledLayout();
  assertHugsButton(four, 'four tasks'); assert(four.window <= peekMaxHeight + peekChrome); assert(!four.scrolls, 'four tasks must not need a scrollbar');
  // Each row starts with its category, in front of the title (the smoke vault tags all four as 업무), and the label stays inside the row.
  assert.deepEqual(await pet.locator('.pet-task .task-category').allInnerTexts(), ['업무', '업무', '업무', '업무']);
  const labelGeometry = await pet.evaluate(() => [...document.querySelectorAll('.pet-task')].map(row => {
    const r = row.getBoundingClientRect(), c = row.querySelector('.task-category')!.getBoundingClientRect(), t = row.querySelector('.task-title')!.getBoundingClientRect();
    return { beforeTitle: c.right <= t.left + 0.5, insideRow: c.top >= r.top - 0.5 && c.bottom <= r.bottom + 0.5 };
  }));
  assert(labelGeometry.every(row => row.beforeTitle && row.insideRow), `category label must sit before the title inside its row: ${JSON.stringify(labelGeometry)}`);
  // The panel title says the count once; the old separate "오늘 할 일" label above it is gone.
  assert.equal(await pet.locator('.peek-heading h1').innerText(), '오늘 할 일 4개');
  assert.equal(await pet.locator('.peek-heading span').count(), 0);
  assert.equal(((await pet.locator('.peek').innerText()).match(/오늘 할 일/g) ?? []).length, 1);
  // Keep the preview open: tasks beyond the former three-item cutoff must update too.
  await writeFile(path.join(tasks, 'new.md'), raw('새로 추가한 작업'));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 5개' }).waitFor({ timeout: 4000 });
  await ensurePeek(); await pet.getByRole('button', { name: '새로 추가한 작업', exact: false }).waitFor({ timeout: 4000 });
  assert.equal(await pet.locator('.pet-task').count(), 5);
  const five = await settledLayout();
  assertHugsButton(five, 'five tasks'); assert(!five.scrolls, 'five tasks must not need a scrollbar');
  await pet.getByRole('button', { name: '새로 추가한 작업', exact: false }).scrollIntoViewIfNeeded();
  await writeFile(path.join(tasks, 'new.md'), raw('새 작업 이름 수정'));
  await ensurePeek(); await pet.getByRole('button', { name: '새 작업 이름 수정', exact: false }).waitFor({ timeout: 4000 });
  assert.equal(await pet.getByRole('button', { name: '새로 추가한 작업', exact: false }).count(), 0);
  await unlink(path.join(tasks, 'new.md'));
  await pet.getByRole('button', { name: '새 작업 이름 수정', exact: false }).waitFor({ state: 'detached', timeout: 4000 });
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 4개' }).waitFor({ timeout: 4000 });

  // Right-clicking a row opens that task's status menu. The menu is native, so the popup is captured instead of shown, and its
  // items are clicked from the main process: the save that follows is the real one (conflict check, backup, file write).
  await desktop!.evaluate(({ Menu }) => {
    const g = globalThis as any; g.popups = []; g.originalPopup = Menu.prototype.popup;
    Menu.prototype.popup = function (options) { g.popups.push({ menu: this, callback: options?.callback }); };
  });
  const lastMenu = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = await desktop!.evaluate(() => { const g = globalThis as any; return g.popups.length; });
      if (found) return desktop!.evaluate(() => { const g = globalThis as any; return g.popups.at(-1).menu.items.map((i: any) => ({ label: i.label, type: i.type, checked: i.checked, enabled: i.enabled })); });
      await delay(50);
    }
    throw new Error('no menu opened');
  };
  const clickMenuItem = (label: string) => desktop!.evaluate((_electron, label) => { const g = globalThis as any; g.popups.at(-1).menu.items.find((i: any) => i.label === label).click(); }, label);
  const closeMenu = () => desktop!.evaluate(() => { const g = globalThis as any; g.popups.at(-1).callback?.(); g.popups.length = 0; });
  const noteText = (name: string) => readFile(path.join(tasks, name), 'utf8');
  // Closing the menu closes the list too when the real pointer is elsewhere, so bring it back the way a person would.
  const reopenList = async () => { await pet.locator('.pet-button').hover(); await pet.getByRole('region', { name: '오늘 할 일 미리보기' }).waitFor(); };
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 3' }).click({ button: 'right' });
  const statusItems = await lastMenu();
  assert.deepEqual(statusItems.filter((i: any) => i.type === 'radio').map((i: any) => i.label), ['없음', '시작', '진행 중', '완료']);
  assert.deepEqual(statusItems.filter((i: any) => i.checked).map((i: any) => i.label), ['시작'], 'the current status is checked');
  assert(statusItems.filter((i: any) => i.type === 'radio').every((i: any) => i.enabled));
  assert(statusItems.some((i: any) => i.label === '앱에서 열기'));
  assert(!statusItems.some((i: any) => i.label === '오늘 작업 열기'), 'a row opens the task menu, not the widget menu');
  // The pointer is over the menu, not the list: closing the list now must not take the target away.
  await pet.evaluate(() => window.taskPet!.expand(false)); await delay(300);
  assert.equal((await pet.evaluate(() => window.taskPet!.state())).expanded, true, 'the list stays open while the menu is open');
  await clickMenuItem('완료');
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 3개' }).waitFor({ timeout: 4000 });
  assert(/상태: 완료/.test(await noteText('3.md')), 'the note is saved as done');
  assert(/완료일: \d{4}-\d{2}-\d{2}/.test(await noteText('3.md')), 'the completion date is written like the app does');
  const doneNotice = pet.locator('.pet-notice');
  await doneNotice.waitFor(); assert((await doneNotice.innerText()).includes('테스트 작업 3'));
  assert.equal(await pet.locator('.pet-task').filter({ hasText: '테스트 작업 3' }).count(), 0, 'a finished task leaves the list');
  await pet.screenshot({ path: path.join(root, 'pet-done-notice.png') });
  await pet.getByRole('button', { name: '되돌리기', exact: true }).click();
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 4개' }).waitFor({ timeout: 4000 });
  assert(/상태: 시작/.test(await noteText('3.md')), 'undo puts the previous status back');
  assert(!/상태: 완료/.test(await noteText('3.md')));
  await doneNotice.waitFor({ state: 'detached', timeout: 4000 });
  await closeMenu(); await reopenList();
  // A status other than done changes the row in place and needs no notice.
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 0' }).click({ button: 'right' });
  await lastMenu(); await clickMenuItem('진행 중');
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 0' }).filter({ hasText: '진행 중' }).waitFor({ timeout: 4000 });
  assert(/상태: 진행 중/.test(await noteText('0.md')));
  assert.equal(await pet.locator('.pet-notice').count(), 0);
  await closeMenu(); await reopenList();
  await writeFile(path.join(tasks, '0.md'), raw('테스트 작업 0'));
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 0' }).filter({ hasText: '진행 중' }).waitFor({ state: 'detached', timeout: 4000 });
  // The note changes while the menu is open: the choice is refused and says why, and the other app's change is kept.
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 2' }).click({ button: 'right' });
  await lastMenu();
  const external = raw('테스트 작업 2', '진행 중') + '\n다른 앱에서 고친 내용';
  await writeFile(path.join(tasks, '2.md'), external);
  await clickMenuItem('완료');
  const conflict = pet.locator('.pet-notice.error');
  await conflict.waitFor({ timeout: 4000 }); assert((await conflict.innerText()).includes('다른 곳에서 먼저 바뀌어'));
  assert.equal(await noteText('2.md'), external, 'a refused change leaves the note as the other app wrote it');
  await pet.screenshot({ path: path.join(root, 'pet-conflict-notice.png') });
  await closeMenu(); await reopenList();
  await conflict.waitFor({ state: 'detached', timeout: 10000 });
  await writeFile(path.join(tasks, '2.md'), raw('테스트 작업 2', '진행 중'));
  // A status added in TaskNotes shows up in the menu while the app runs, and can be chosen.
  const settingsFile = path.join(vault, '.obsidian/plugins/tasknotes/data.json');
  await mkdir(path.dirname(settingsFile), { recursive: true });
  const listed = (value: string, order: number, extra: object = {}) => ({ id: value, value, label: value, color: '#888888', isCompleted: false, order, ...extra });
  await writeFile(settingsFile, JSON.stringify({ customStatuses: [listed('없음', 0), listed('시작', 1), listed('진행 중', 2), listed('지연', 3, { color: '#cc3300' }), listed('완료', 4, { isCompleted: true, color: '#00aa00' })] }));
  let offered: string[] = [];
  for (let attempt = 0; attempt < 30 && !offered.includes('지연'); attempt++) {
    await delay(300); await reopenList();
    await pet.locator('.pet-task').filter({ hasText: '테스트 작업 1' }).click({ button: 'right' });
    offered = (await lastMenu()).filter((i: any) => i.type === 'radio').map((i: any) => i.label);
    if (!offered.includes('지연')) { await closeMenu(); }
  }
  assert.deepEqual(offered, ['없음', '시작', '진행 중', '지연', '완료'], 'the menu follows the TaskNotes settings, in their order');
  await clickMenuItem('지연');
  const late = pet.locator('.pet-task').filter({ hasText: '테스트 작업 1' });
  await late.filter({ hasText: '지연' }).waitFor({ timeout: 4000 });
  assert(/상태: 지연/.test(await noteText('1.md')), 'a status added in TaskNotes is written to the note');
  assert.equal(await late.locator('.dot.custom').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(204, 51, 0)', 'its colour comes from the settings');
  assert.equal(await pet.locator('.pet-notice').count(), 0);
  await pet.screenshot({ path: path.join(root, 'pet-custom-status.png') });
  await closeMenu(); await reopenList();
  await writeFile(path.join(tasks, '1.md'), raw('테스트 작업 1'));
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 1' }).filter({ hasText: '지연' }).waitFor({ state: 'detached', timeout: 4000 });
  await koreanSetup(vault); // back to the setup the other notes are written for
  await desktop!.evaluate(({ Menu }) => { const g = globalThis as any; Menu.prototype.popup = g.originalPopup; });
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 4개' }).waitFor({ timeout: 4000 });
  await pet.locator('.pet-task').filter({ hasText: '진행 중' }).first().waitFor({ timeout: 4000 });

  // Two in-progress tasks each add a status line; four tasks must still fit without a scrollbar.
  const inProgressRows = pet.locator('.pet-task').filter({ hasText: '진행 중' });
  await writeFile(path.join(tasks, '1.md'), raw('테스트 작업 1', '진행 중'));
  await ensurePeek(); await inProgressRows.nth(1).waitFor({ timeout: 4000 });
  const twoActive = await settledLayout();
  assertHugsButton(twoActive, 'four tasks, two in progress'); assert(!twoActive.scrolls, 'two in-progress tasks must not need a scrollbar');
  await pet.screenshot({ path: path.join(root, 'pet-expanded-two-active.png') });
  await writeFile(path.join(tasks, '1.md'), raw('테스트 작업 1'));
  await inProgressRows.nth(1).waitFor({ state: 'detached', timeout: 4000 });
  // Only a list longer than the cap gets a scrollbar, and then the panel is exactly the cap (keeps pet.css and pet-model.ts in step).
  const fills = Array.from({ length: 6 }, (_, i) => `fill-${i}.md`);
  for (const [i, name] of fills.entries()) await writeFile(path.join(tasks, name), raw('채움 작업 ' + i));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 10개' }).waitFor({ timeout: 4000 });
  const capped = await settledLayout();
  assertHugsButton(capped, 'ten tasks'); assert.equal(capped.panel, peekMaxHeight); assert.equal(capped.window, peekMaxHeight + peekChrome); assert(capped.scrolls);
  await pet.screenshot({ path: path.join(root, 'pet-expanded-capped.png') });
  // Scrolled to the end, the title is still where it was, and it is the title that is drawn there, not a row that went under it.
  const title = () => pet.locator('.peek-heading h1').evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, shown: !!document.elementFromPoint(r.left + 4, r.top + r.height / 2)?.closest('.peek-heading') }; });
  // "앱에서 모두 보기" likewise stays at the bottom: on screen at the top of a full list (it used to be below the fold), and still there at the end.
  const footer = () => pet.locator('.all-tasks').evaluate(el => {
    const r = el.getBoundingClientRect(), p = el.closest('.peek')!.getBoundingClientRect();
    return { bottom: r.bottom, inside: r.top >= p.top && r.bottom <= p.bottom + 0.5, shown: !!document.elementFromPoint(r.left + 8, r.top + r.height / 2)?.closest('.all-tasks') };
  });
  const titleBefore = await title(), footerBefore = await footer();
  assert(footerBefore.inside && footerBefore.shown, `"앱에서 모두 보기" is on screen at the top of a full list (${JSON.stringify(footerBefore)})`);
  await pet.locator('.peek').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const titleAfter = await title(), footerAfter = await footer();
  assert(await pet.locator('.peek').evaluate(el => el.scrollTop > 40), 'the list did scroll');
  assert(titleAfter.shown && Math.abs(titleAfter.top - titleBefore.top) < 0.5, `the title stays at the top of a scrolled list (${JSON.stringify({ titleBefore, titleAfter })})`);
  assert(footerAfter.shown && Math.abs(footerAfter.bottom - footerBefore.bottom) < 0.5, `"앱에서 모두 보기" stays at the bottom of a scrolled list (${JSON.stringify({ footerBefore, footerAfter })})`);
  await pet.screenshot({ path: path.join(root, 'pet-expanded-capped-scrolled.png') });
  await pet.locator('.peek').evaluate(el => { el.scrollTop = 0; });
  for (const name of fills) await unlink(path.join(tasks, name));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 4개' }).waitFor({ timeout: 4000 });
  // A title that does not fit rolls while its row is hovered and returns when the pointer leaves; a title that fits never rolls.
  await writeFile(path.join(tasks, 'long.md'), raw('분기별 프로젝트 진행 현황 점검 보고서 작성 및 다음 분기 개선안 검토 회의 자료 준비'));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 5개' }).waitFor({ timeout: 4000 });
  const longRow = pet.locator('.pet-task').filter({ hasText: '분기별 프로젝트 진행' }), longTitle = longRow.locator('.task-title');
  const fullTitle = '분기별 프로젝트 진행 현황 점검 보고서 작성 및 다음 분기 개선안 검토 회의 자료 준비';
  await ensurePeek();
  assert.equal(await longTitle.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
  assert.equal(await longTitle.locator('.roll-track').count(), 0);
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 3' }).hover(); await delay(500);
  assert.equal(await pet.locator('.pet-task.rolling').count(), 0, 'a title that fits must not roll');
  await longRow.hover();
  await pet.locator('.pet-task.rolling').waitFor({ timeout: 2000 });
  const labelBefore = await longRow.locator('.task-category').boundingBox();
  const copies = longTitle.locator('.roll-track > span');
  assert.equal(await copies.count(), 2, 'the title is repeated so the loop has no jump');
  assert.equal(await copies.nth(1).getAttribute('aria-hidden'), 'true'); assert.equal(await copies.first().innerText(), fullTitle);
  // A ticker: one direction, a steady speed, no pause after it starts, and a seamless wrap. Sampled for one full loop plus a second.
  const flow = await pet.evaluate(`new Promise(resolve => {
    var track = document.querySelector('.pet-task.rolling .roll-track');
    var seconds = parseFloat(track.parentElement.style.getPropertyValue('--roll-time'));
    var loop = track.getBoundingClientRect().width / 2, samples = [], begin = performance.now();
    var timer = setInterval(function () {
      samples.push({ t: performance.now() - begin, x: new DOMMatrix(getComputedStyle(track).transform).m41 });
      if (performance.now() - begin > (seconds + 1.2) * 1000) { clearInterval(timer); resolve({ seconds: seconds, loop: loop, samples: samples }); }
    }, 50);
  })`) as { seconds: number; loop: number; samples: { t: number; x: number }[] };
  assert(Math.abs(flow.loop / flow.seconds - rollSpeed) < 2, `speed ${flow.loop / flow.seconds}px/s should be about ${rollSpeed}`);
  const steps = flow.samples.slice(1).map((sample, index) => ({ dx: sample.x - flow.samples[index]!.x, dt: (sample.t - flow.samples[index]!.t) / 1000, t: sample.t }));
  const wraps = steps.filter(step => step.dx > 30);
  assert(wraps.length >= 1, 'the title comes around again');
  for (const wrap of wraps) assert(Math.abs(wrap.dx - flow.loop) < 6, `the wrap must be one whole loop: ${wrap.dx} vs ${flow.loop}`);
  assert.equal(steps.filter(step => step.dx > 0.6 && step.dx <= 30).length, 0, 'never moves backwards');
  const moving = steps.filter(step => step.dx < -0.5 && step.dx > -30);
  const speed = moving.reduce((sum, step) => sum - step.dx / step.dt, 0) / moving.length;
  assert(Math.abs(speed - rollSpeed) < 9, `average speed ${Math.round(speed)}px/s should be about ${rollSpeed}`);
  let still = 0, longestStill = 0;
  for (const step of steps.filter(step => step.t > 700)) { still = Math.abs(step.dx) < 0.5 ? still + 1 : 0; longestStill = Math.max(longestStill, still); }
  assert(longestStill < 5, `no pauses once it is moving (longest ${longestStill} samples)`);
  assert.deepEqual(await longRow.locator('.task-category').boundingBox(), labelBefore, 'the category label stays put while the title flows');
  await pet.screenshot({ path: path.join(root, 'pet-title-rolled.png') });
  await pet.locator('.pet-button').hover();
  await pet.locator('.pet-task.rolling').waitFor({ state: 'detached', timeout: 2000 });
  assert.equal(await longTitle.locator('.roll-track').count(), 0); assert.equal(await longTitle.innerText(), fullTitle);
  assert.equal(await longTitle.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
  await unlink(path.join(tasks, 'long.md'));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 4개' }).waitFor({ timeout: 4000 });
  // A task without the work tag is labelled 개인, the same as in the task list.
  await writeFile(path.join(tasks, 'private.md'), raw('개인 일정 확인').replace('[task, 업무]', '[task, 개인]'));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 5개' }).waitFor({ timeout: 4000 });
  // The test pointer is remembered in window coordinates, so a window that shrank leaves it outside and the panel closes; a real
  // pointer stays on the button. Hover the button again, as a person opening the preview would.
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
  assert.equal(await pet.locator('.pet-task').filter({ hasText: '개인 일정 확인' }).locator('.task-category').innerText(), '개인');
  assert.deepEqual((await pet.locator('.pet-task .task-category').allInnerTexts()).sort(), ['개인', '업무', '업무', '업무', '업무']);
  await pet.screenshot({ path: path.join(root, 'pet-category-labels.png') });
  await unlink(path.join(tasks, 'private.md'));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 4개' }).waitFor({ timeout: 4000 });

  // Subtasks: hidden under their parent; resting the pointer on the parent opens them one after the other, in a window that already has room for them.
  const child = (title: string, status: string) => raw(title, status).replace(/\n---\n/, `\n${status === '완료' ? `완료일: ${todayKey}\n` : ''}projects:\n  - "[[tree-parent]]"\n---\n`);
  await writeFile(path.join(tasks, 'tree-parent.md'), raw('위젯 상위 작업'));
  await writeFile(path.join(tasks, 'tree-a.md'), child('위젯 하위 A', '시작'));
  await writeFile(path.join(tasks, 'tree-b.md'), child('위젯 하위 B', '완료'));
  await writeFile(path.join(tasks, 'tree-c.md'), child('위젯 하위 C 소매 매장 아웃바운드 녹취 STT 기반 효과성 분석 보고서 작성 및 다음 분기 개선안 검토', '시작'));
  // Finish three of the four tasks above so the list is short and the window has room to grow (a long list is capped, and then it would not).
  // What is left: one task, the parent and the two unfinished children; the finished child is not counted.
  for (const i of [0, 1, 3]) await writeFile(path.join(tasks, `${i}.md`), raw('테스트 작업 ' + i, '완료'));
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
  await pet.locator('.pet-task').filter({ hasText: '위젯 상위 작업' }).waitFor({ timeout: 4000 });
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 3' }).waitFor({ state: 'detached', timeout: 4000 });
  await ensurePeek(); assert.match(await pet.locator('.pet-caption strong').innerText(), /오늘 할 일 4개/);
  const treeRow = pet.locator('.pet-task').filter({ hasText: '위젯 상위 작업' }), treeOpen = pet.locator('.pet-group.open').filter({ has: treeRow });
  await treeRow.waitFor({ timeout: 4000 });
  assert.equal(await pet.locator('.pet-task').count(), 2, 'the children are not rows of their own');
  assert.equal((await treeRow.locator('.pet-subcount').innerText()).trim(), '1/3', 'the row says how many subtasks are done');
  assert.equal(await pet.locator('.pet-sub').first().isVisible(), false, 'closed subtasks take no room');
  assert.equal(await pet.locator('.pet-group.open').count(), 0);
  // The window already has room for the subtasks while they are closed. That room is see-through: the page itself is under the pointer there.
  const closedLayout = await settledLayout(), closedHeight = closedLayout.window;
  assert(Math.abs(closedLayout.window - closedLayout.expected) <= 1, `the window is as tall as the list with its subtasks open (${JSON.stringify(closedLayout)})`);
  assert(closedLayout.window >= closedLayout.panel + peekChrome + 60, `room for the subtasks is kept above the list (${JSON.stringify(closedLayout)})`);
  assert.equal(await pet.evaluate(() => document.elementFromPoint(150, 4)?.classList.contains('pet-window')), true, 'nothing is drawn in that room');
  // Clicks there go to the window behind; the pointer moving into it has left the widget, so the list closes. Back on the button it is the widget's again.
  const passThrough = () => desktop!.evaluate(() => ((globalThis as any).__passThrough as boolean[]).at(-1));
  await pet.mouse.move(150, 4); await pet.locator('.peek').waitFor({ state: 'detached', timeout: 2000 });
  assert.equal(await passThrough(), true, 'clicks in the see-through room reach the window behind');
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
  assert.equal(await passThrough(), false, 'the button takes clicks again');
  // Chromium does not hear the pointer leave the window once click-through was switched off, so the list stayed open after the pointer had
  // gone. The real pointer is watched while the widget takes it: outside the window, the list closes and clicks go through again.
  await desktop!.evaluate(() => { (globalThis as any).__cursor = { x: -5000, y: -5000 }; });
  await pet.locator('.peek').waitFor({ state: 'detached', timeout: 2000 });
  assert.equal(await passThrough(), true, 'a pointer that left the window lets clicks through again');
  await desktop!.evaluate(() => { (globalThis as any).__cursor = null; });
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
  assert.equal(await passThrough(), false, 'and the widget takes the pointer when it comes back');
  assert.equal((await settledLayout()).window, closedHeight);
  // Sample the window in the main process and the three subtask slots in the page while the pointer moves onto the parent.
  await desktop!.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!;
    const samples: { t: number; h: number; y: number }[] = [], begin = Date.now();
    (globalThis as any).__petHeights = samples;
    const timer = setInterval(() => { const b = win.getBounds(); samples.push({ t: Date.now() - begin, h: b.height, y: b.y }); if (Date.now() - begin > 4200) clearInterval(timer); }, 8);
  });
  const slots = pet.evaluate(`new Promise(resolve => {
    var begin = performance.now(), samples = [];
    var timer = setInterval(function () {
      var parent = Array.from(document.querySelectorAll('.pet-task')).find(function (el) { return el.textContent.indexOf('위젯 상위 작업') >= 0; });
      samples.push({ t: performance.now() - begin, h: Array.from(document.querySelectorAll('.pet-sub-item')).map(function (el) { return el.getBoundingClientRect().height; }), at: parent ? parent.getBoundingClientRect().bottom - window.innerHeight : null });
      if (performance.now() - begin > 4000) { clearInterval(timer); resolve(samples); }
    }, 8);
  })`) as Promise<{ t: number; h: number[]; at: number | null }[]>;
  await treeRow.hover();
  // Not at once: the pointer has to rest on the row for a second.
  await delay(600); assert.equal(await treeOpen.count(), 0, 'passing over a row does not open it');
  await treeOpen.waitFor({ timeout: 5000 });
  const slotSamples = await slots; await delay(300);
  const heights = await desktop!.evaluate(() => (globalThis as any).__petHeights as { t: number; h: number; y: number }[]);
  // The three slots start opening one after another, in order.
  const startOf = (index: number) => slotSamples.find(sample => (sample.h[index] ?? 0) > 2)?.t;
  // The widget sits low on the screen, so the window grows upward and the subtasks open above their parent, the one next to it first.
  assert.equal(await pet.locator('.pet-window.above').count(), 1);
  const starts = [2, 1, 0].map(startOf);
  assert(starts.every(t => t !== undefined), `all three subtasks appear (${starts})`);
  assert(starts[0]! >= 900, `nothing opens before the pointer has rested for a second: ${starts}`);
  assert(starts[0]! < starts[1]! && starts[1]! < starts[2]!, `one after another, nearest the parent first: ${starts}`);
  assert(starts[1]! - starts[0]! >= 30 && starts[2]! - starts[1]! >= 30, `with a visible gap between them: ${starts}`);
  // The parent stays where the pointer is: its distance from the bottom of the window does not change while the list opens.
  const at = slotSamples.map(sample => sample.at).filter((value): value is number => value !== null);
  assert(Math.max(...at) - Math.min(...at) <= 1.5, `the parent row does not move (${Math.min(...at)} to ${Math.max(...at)})`);
  // The window does not move or resize while they slide open. When it followed the list frame by frame the widget shook: Windows draws the old
  // frame at the new window position for a frame or two, and a window growing upward moved its top edge every frame.
  assert(heights.length > 100 && heights.every(sample => sample.h === closedHeight && sample.y === heights[0]!.y), `the window stays still while the list opens (${[...new Set(heights.map(s => `${s.y}/${s.h}`))]})`);
  await delay(1100);
  const settledOpen = await settledLayout();
  assert.equal(settledOpen.scrolls, false);
  assert(Math.abs(settledOpen.window - (settledOpen.panel + peekChrome)) <= 1, `open, the list fills the room the window kept for it (${JSON.stringify({ ...settledOpen, closedHeight, open: await treeOpen.count() })})`);
  const parentBox = (await treeRow.boundingBox())!, subsBox = (await pet.locator('.pet-subs').filter({ has: pet.locator('.pet-sub') }).first().boundingBox())!;
  assert(subsBox.y + subsBox.height <= parentBox.y + 2, 'the subtasks are above their parent');
  assert.deepEqual(await pet.locator('.pet-sub .task-title').allTextContents(), ['위젯 하위 A', '위젯 하위 C 소매 매장 아웃바운드 녹취 STT 기반 효과성 분석 보고서 작성 및 다음 분기 개선안 검토', '위젯 하위 B'], 'still to do first, then finished');
  assert.equal(await pet.locator('.pet-sub.done .task-title').evaluate(el => getComputedStyle(el).textDecorationLine), 'line-through');
  // A finished subtask is struck through and ticked, so its status and dates are left out to keep it one line.
  const doneSub = pet.locator('.pet-sub.done');
  assert.equal(await doneSub.locator('small').count(), 0, 'a finished subtask has no status or date line');
  assert.equal(await doneSub.locator('.dot.done').count(), 1, 'a finished subtask is ticked');
  assert.equal(await pet.locator('.pet-sub:not(.done) .dot.done').count(), 0, 'one still to do is not');
  assert.equal(await pet.locator('.pet-sub:not(.done) small').count(), 2, 'subtasks still to do keep their date line');
  // A subtask title that does not fit flows while it is hovered and stops when the pointer leaves, like a row's.
  const longSub = pet.locator('.pet-sub').filter({ hasText: '위젯 하위 C' });
  assert.equal(await longSub.locator('.roll-track').count(), 0);
  await longSub.hover(); await pet.locator('.pet-sub.rolling .roll-track').waitFor({ timeout: 2000 });
  assert.equal(await longSub.locator('.roll-track > span').count(), 2, 'the title is repeated so the loop has no jump');
  await pet.screenshot({ path: path.join(root, 'pet-subtask-rolling.png') });
  await treeRow.hover(); await pet.locator('.pet-sub.rolling').waitFor({ state: 'detached', timeout: 2000 });
  await pet.screenshot({ path: path.join(root, 'pet-subtasks-open.png') });
  // Moving the pointer away closes them together; the window keeps its size.
  await pet.locator('.pet-task').filter({ hasText: '테스트 작업 2' }).hover();
  await pet.locator('.pet-group.open').waitFor({ state: 'detached', timeout: 2000 });
  await delay(1100); await settledLayout();
  assert.equal(await petWindowHeight(), closedHeight, 'the window is the same size with the subtasks closed');
  // A subtask opens in the app, also one that is not on today's list (the finished one).
  for (const title of ['위젯 하위 A', '위젯 하위 B']) {
    // The pointer comes from elsewhere, as it would for a person; one already resting on the row would not be entering it.
    // Opening a subtask closes the list, so the second round opens it again from the button first.
    await pet.locator('.pet-button').hover(); await settledLayout(); await pet.locator('.pet-task').filter({ hasText: '테스트 작업 2' }).hover(); await treeRow.hover(); await treeOpen.waitFor({ timeout: 5000 });
    await delay(1100); await pet.locator('.pet-sub').filter({ hasText: title }).click();
    await page.locator('.detail h2').filter({ hasText: title }).waitFor({ timeout: 4000 });
  }
  // The same when the list is full and scrolls: the parent still stays under the pointer while its subtasks open, and they show in full. The case
  // that hid them: the parent is the first row under the title, and its subtasks open above it. In progress, the parent is listed near the top.
  for (let i = 0; i < 8; i++) await writeFile(path.join(tasks, `cap-${i}.md`), raw('채움 ' + i));
  await writeFile(path.join(tasks, 'tree-parent.md'), raw('위젯 상위 작업', '진행 중'));
  // The window keeps room for the subtasks above a full list, which does not fit above the widget where it is; move it lower for this part
  // (and back after it, since a later step checks where a drag leaves it).
  const moveWidget = (dy: number) => pet.evaluate(async dy => {
    await window.taskPet!.drag({ phase: 'start', x: 500, y: 500 }); await window.taskPet!.drag({ phase: 'move', x: 500, y: 500 + dy }); await window.taskPet!.drag({ phase: 'end', x: 500, y: 500 + dy });
  }, dy);
  await moveWidget(360);
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
  await pet.locator('.pet-task').filter({ hasText: '채움 7' }).waitFor({ timeout: 5000 });
  await treeRow.filter({ hasText: '진행 중' }).waitFor({ timeout: 5000 });
  await settledLayout();
  assert.equal(await pet.locator('.pet-window.above').count(), 1, 'the list opens above the widget, so subtasks open above their parent');
  assert.equal(await pet.locator('.peek').evaluate(el => el.scrollHeight > el.clientHeight + 1), true, 'the list is full, so it scrolls');
  const underTitle = await pet.locator('.peek').evaluate(panel => {
    const parent = [...panel.querySelectorAll('.pet-task')].find(el => el.textContent!.includes('위젯 상위 작업'))!, title = panel.querySelector('.peek-heading')!;
    panel.scrollTop += parent.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
    return parent.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
  });
  assert(Math.abs(underTitle) <= 1, `the parent is the first row under the title (${underTitle})`);
  const fullSamples = pet.evaluate(`new Promise(resolve => {
    var begin = performance.now(), samples = [];
    var timer = setInterval(function () {
      var parent = Array.from(document.querySelectorAll('.pet-task')).find(function (el) { return el.textContent.indexOf('위젯 상위 작업') >= 0; });
      var open = !!document.querySelector('.pet-group.open');
      samples.push({ open: open, mark: !!window.__mark, at: parent ? parent.getBoundingClientRect().bottom - window.innerHeight : null });
      if (performance.now() - begin > 3600) { clearInterval(timer); resolve(samples); }
    }, 8);
  })`) as Promise<{ open: boolean; mark: boolean; at: number | null }[]>;
  await treeRow.hover(); await treeOpen.waitFor({ timeout: 5000 }); await delay(900);
  // Only the opening is measured: moving the test pointer elsewhere afterwards makes the page scroll that row into view on its own.
  await pet.evaluate(() => { (window as unknown as { __mark: boolean }).__mark = true; });
  const full = await fullSamples;
  const opening = full.slice(full.findIndex(sample => sample.open), full.findIndex(sample => sample.mark));
  const fullAt = opening.map(sample => sample.at).filter((value): value is number => value !== null);
  assert(opening.length > 20, 'it opened and was watched while it did');
  assert(Math.max(...fullAt) - Math.min(...fullAt) <= 2.5, `the parent row does not move in a full list either (${Math.min(...fullAt)} to ${Math.max(...fullAt)})`);
  // The list grew by the subtasks' height into the room the window kept, so all of them are on screen, below the title and inside the panel.
  const subsShown = await pet.locator('.peek').evaluate(panel => {
    const p = panel.getBoundingClientRect(), title = panel.querySelector('.peek-heading')!.getBoundingClientRect();
    return [...panel.querySelectorAll('.pet-group.open .pet-sub')].map(el => { const r = el.getBoundingClientRect(); return r.top >= title.bottom - 0.5 && r.bottom <= p.bottom + 0.5 && r.top >= 0; });
  });
  assert(subsShown.length === 3 && subsShown.every(Boolean), `the subtasks of the first row show in full (${subsShown})`);
  assert.equal(await pet.locator('.peek').evaluate(el => Math.round(el.getBoundingClientRect().height) > 320), true, 'the full list grew to show them');
  await pet.screenshot({ path: path.join(root, 'pet-subtasks-full-list.png') });
  await moveWidget(-360);
  for (let i = 0; i < 8; i++) await unlink(path.join(tasks, `cap-${i}.md`));
  await pet.locator('.pet-task').filter({ hasText: '채움 7' }).waitFor({ state: 'detached', timeout: 5000 });
  await page.keyboard.press('Escape');
  for (const name of ['tree-parent', 'tree-a', 'tree-b', 'tree-c']) await unlink(path.join(tasks, name + '.md'));
  for (const i of [0, 1, 3]) await writeFile(path.join(tasks, `${i}.md`), raw('테스트 작업 ' + i));
  await pet.locator('.pet-button').hover(); await pet.locator('.pet-task').filter({ hasText: '테스트 작업 3' }).waitFor({ timeout: 4000 });
  await pet.locator('.pet-task').filter({ hasText: '위젯 상위 작업' }).waitFor({ state: 'detached', timeout: 4000 });
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 4개' }).waitFor({ timeout: 4000 });

  await page.getByRole('button', { name: '창 숨기기', exact: true }).click();
  assert.equal(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.isVisible()), false);
  await pet.locator('.pet-button').click();
  assert.equal(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.isVisible()), true);
  await pet.locator('.pet-button').hover(); await pet.locator('.pet-task').first().click();
  await page.locator('.detail h2').filter({ hasText: '테스트 작업 2' }).waitFor();
  await page.getByRole('button', { name: '상세 수정', exact: true }).click();
  await page.getByLabel('상세 내용', { exact: true }).fill('버리면 안 되는 초안');
  await pet.locator('.pet-button').hover(); await pet.locator('.pet-task').nth(1).click();
  assert.equal(await page.getByLabel('상세 내용', { exact: true }).inputValue(), '버리면 안 되는 초안');
  await page.getByRole('button', { name: '취소', exact: true }).click(); await page.getByRole('button', { name: '변경 내용 버리기', exact: true }).click();
  await page.keyboard.press('Escape');
  await writeFile(path.join(tasks, '0.md'), raw('외부에서 완료', '완료'));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 3개' }).waitFor({ timeout: 4000 });
  // Exercise settings without changing this PC's actual Windows startup registration. The fake goes in before the page reads the
  // status (hence the reload), so the switch starts from the fake's empty state and not from whatever this PC has registered:
  // the real entry is per user, and once the app repaired or created it the switch would start out on.
  await desktop!.evaluate(({ app }) => {
    const originalGet = app.getLoginItemSettings.bind(app);
    (globalThis as any).loginTest = { entry: null, writes: [] };
    // Behaves like Electron on Windows: the entry is stored under its name with the arguments as given, `launchItems` lists it
    // without the switches, and `openAtLogin` reads false whenever the arguments hold a switch. Nothing may depend on openAtLogin.
    app.setLoginItemSettings = options => {
      const test = (globalThis as any).loginTest; test.writes.push(options);
      if (test.fail) return; // Windows refusing the write leaves the registered entry as it was.
      test.entry = options.openAtLogin ? { name: options.name, path: options.path, args: (options.args ?? []).filter(arg => !arg.startsWith('--')), enabled: options.enabled !== false } : null;
    };
    app.getLoginItemSettings = options => {
      const entry = (globalThis as any).loginTest.entry;
      return { ...originalGet(options), openAtLogin: false, executableWillLaunchAtLogin: !!entry && entry.enabled, launchItems: entry ? [{ ...entry, scope: 'user' }] : [] };
    };
  });
  await page.reload(); await page.locator('.task').first().waitFor();
  await page.keyboard.press('Control+k'); await page.locator('.actions-panel').getByRole('button', { name: '볼트 설정', exact: true }).click();
  const startup = page.getByRole('checkbox', { name: 'Windows 로그인 시 자동 시작' });
  assert.equal(await startup.isChecked(), false, 'the switch starts from the fake, which has nothing registered');
  await startup.click(); await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('.theme-settings input[type=checkbox]')?.checked);
  await startup.click(); await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.theme-settings input[type=checkbox]')?.checked === false);
  const loginWrites = await desktop!.evaluate(() => (globalThis as any).loginTest.writes);
  assert.deepEqual(loginWrites.map((v: any) => v.openAtLogin), [true, false]);
  assert(loginWrites[0].args.includes('--task-autostart'));
  assert(loginWrites[0].args.some((arg: string) => arg.includes(profile)));
  // Electron quotes and escapes arguments itself; a quote of our own ends up in the launch command and the app cannot start at login.
  assert(loginWrites[0].args.every((arg: string) => !arg.includes('"')), `arguments must not contain quotes: ${JSON.stringify(loginWrites[0].args)}`);
  assert(loginWrites[0].args[0].endsWith('main.cjs')); assert.equal(loginWrites[0].name, 'Obsidian Task Manager');
  // A save that fails shows its message right below the switch and inside the visible part of the page (it used to appear at the very bottom).
  await desktop!.evaluate(() => { (globalThis as any).loginTest.fail = true; });
  await startup.click();
  const failure = page.locator('.theme-settings .notice.error').filter({ hasText: '자동 시작 설정을 저장하지 못했어요' });
  await failure.waitFor();
  const place = await page.evaluate(() => {
    const alert = [...document.querySelectorAll('.theme-settings .notice.error')].find(el => el.textContent?.includes('자동 시작'))!;
    const label = alert.parentElement!.querySelector('label')!.getBoundingClientRect(), box = alert.getBoundingClientRect(), pane = document.querySelector('.settings')!.getBoundingClientRect();
    return { gap: box.top - label.bottom, top: box.top, bottom: box.bottom, visibleTop: pane.top, visibleBottom: Math.min(pane.bottom, window.innerHeight) };
  });
  assert(place.gap >= 0 && place.gap < 60, `message must sit right under the switch, gap ${place.gap}`);
  assert(place.top >= place.visibleTop - 1 && place.bottom <= place.visibleBottom + 1, `message must be inside the visible area: ${JSON.stringify(place)}`);
  assert.equal(await startup.isChecked(), false, 'a failed save leaves the switch off');
  await page.screenshot({ path: path.join(root, 'autostart-error.png') });
  await desktop!.evaluate(() => { (globalThis as any).loginTest.fail = false; });
  await startup.click(); await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.theme-settings input[type=checkbox]')?.checked === true);
  assert.equal(await failure.count(), 0, 'the message goes away once a save works');
  await startup.click(); await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.theme-settings input[type=checkbox]')?.checked === false);
  await page.getByRole('button', { name: '화이트', exact: false }).click();
  await pet.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
  await pet.screenshot({ path: path.join(root, 'pet-expanded-light.png') });
  // Fewer tasks must shrink the panel and the window instead of leaving blank space below the list.
  const three = await settledLayout();
  assertHugsButton(three, 'three tasks');
  await writeFile(path.join(tasks, '1.md'), raw('외부에서 완료 2', '완료'));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 2개' }).waitFor({ timeout: 4000 });
  const two = await settledLayout();
  assertHugsButton(two, 'two tasks'); assert(two.panel < three.panel && two.window < three.window); assert(!two.scrolls); assert(two.blank <= 16, `blank below the list: ${two.blank}`);
  await pet.screenshot({ path: path.join(root, 'pet-expanded-two-tasks.png') });
  await writeFile(path.join(tasks, '1.md'), raw('테스트 작업 1'));
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 3개' }).waitFor({ timeout: 4000 });
  // Simulate pointer coordinates through the same narrow drag bridge; do not move the physical pointer.
  await pet.evaluate(async () => {
    await window.taskPet!.drag({ phase: 'start', x: 500, y: 500 });
    await window.taskPet!.drag({ phase: 'move', x: 440, y: 460 });
    await window.taskPet!.drag({ phase: 'end', x: 440, y: 460 });
  });
  const saved = JSON.parse(await readFile(path.join(profile, 'pet.json'), 'utf8'));
  assert.equal(saved.x, compact.x - 60); assert.equal(saved.y, compact.y - 40);
  await menu('마우스를 올리면 목록 펼치기');
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor({ state: 'hidden' });
  await menu('항상 위에 표시');
  assert.equal(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!.isAlwaysOnTop()), false);
  await menu('위젯 숨기기');
  assert.equal(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!.isVisible()), false);
  await page.getByRole('button', { name: '미니 위젯 보이기', exact: true }).click();
  assert.equal(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!.isVisible()), true);
  // Windows may briefly deny a directory rename while the app finishes a file read.
  for (let attempt = 0; ; attempt++) {
    try { await rename(tasks, tasks + '-offline'); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 20) throw error; await delay(50); }
  }
  await pet.locator('.pet-caption strong').filter({ hasText: '확인 필요' }).waitFor({ timeout: 4000 });
  await rename(tasks + '-offline', tasks);
  await pet.locator('.pet-caption strong').filter({ hasText: '오늘 할 일 3개' }).waitFor({ timeout: 4000 });
  await page.getByRole('button', { name: '볼트 선택 해제', exact: true }).click();
  await pet.locator('.pet-caption strong').filter({ hasText: '볼트 선택' }).waitFor({ timeout: 4000 });
  // Restore only the synthetic profile for restart validation.
  await desktop!.close(); desktop = undefined;
  await writeFile(path.join(profile, 'vault.json'), JSON.stringify({ vaultPath: vault, taskRelativePath: 'TaskNotes/Tasks' }));
  await writeFile(path.join(tasks, '0.md'), raw('테스트 작업 0'));
  await launch(true);
  assert.equal(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.isVisible()), false);
  const restored = await desktop!.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!; return { ...w.getBounds(), top: w.isAlwaysOnTop() }; });
  assert.equal(restored.x, saved.x); assert.equal(restored.y, saved.y); assert.equal(restored.top, false);
  assert.equal(await pet.locator('html').getAttribute('data-theme'), 'light');
  // Near the top edge the panel opens below the button and must still hug it.
  await menu('마우스를 올리면 목록 펼치기');
  await pet.evaluate(async () => {
    await window.taskPet!.drag({ phase: 'start', x: 500, y: 500 });
    await window.taskPet!.drag({ phase: 'move', x: 500, y: -5000 });
    await window.taskPet!.drag({ phase: 'end', x: 500, y: -5000 });
  });
  await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
  await pet.locator('main.below').waitFor();
  const below = await settledLayout();
  assertHugsButton(below, 'panel below the button'); assert(below.panelTop > below.buttonTop);
  await pet.screenshot({ path: path.join(root, 'pet-expanded-below.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ synthetic: true, widgetFitsContent: true, widgetScrollsPastCap: true, widgetFitsBelowButton: true, widgetNoDuplicateHeading: true, widgetNoScrollbarBelowCap: true, widgetTitleRolling: true, compactCount: true, allTasksWithProgressFirst: true, livePreviewCreateRenameDelete: true, opensMain: true, opensTaskDetail: true, draftPreserved: true, liveFiles: true, themeSync: true, dragCoordinatesPersist: true, menuActions: true, restoreHidden: true, folderRecovery: true, forgetClears: true, restart: true, autoStartSettingsMocked: true, autoStartHiddenLaunch: true, physicalWindowsLoginTested: false, physicalDragTested: false, windowOrderChecked: canReadScreen, panelReopenedAfterStrayPointer: reopened, pageErrors: errors }, null, 2));
  console.log('Pet smoke passed: ' + root + (reopened ? ` (panel reopened ${reopened}x after closing on its own)` : ''));
} catch (error) {
  if (pet!) await pet.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  if (page!) await page.screenshot({ path: path.join(root, 'failure-main.png') }).catch(() => {});
  throw error;
}
finally { await desktop?.close(); }
