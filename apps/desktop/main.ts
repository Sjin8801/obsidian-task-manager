import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, protocol, screen, session, Tray } from 'electron';
import { existsSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HeadlessSync, locateHeadless, preflightSync, runCommand, spawnHeadless, type SyncTimings } from './headless-sync.ts';
import { syncAlert, trayLabel } from './sync-messages.ts';
import { SyncSettings } from './sync-store.ts';
import { loginItemName, loginItemState, repairLegacyLoginItem } from './login-item.ts';
import { importProfile, readStartupEntry, sourceProfileFrom, type RunProgram, type StartupEntry } from './import-profile.ts';
import { LocalVault, selectVault, selectTaskFolder, validSelection, VaultError } from './local-vault.ts';
import { ShortcutStore } from './shortcut-store.ts';
import { CategoryStore } from './category-store.ts';
import { LanguageStore } from './language-store.ts';
import { translate, type Translate } from './i18n/index.ts';
import { categoryScope, defaultCategoriesFor, validCategory } from './categories.ts';
import { defaultStatuses } from '../../packages/contracts/statuses.ts';
import { saveTask } from './save-task.ts';
import { editRelation, findRelatedFor } from './edit-relation.ts';
import { PetWindow } from './pet-window.ts';
import { summarizePet, type PetSnapshot } from './pet-model.ts';
import { watchVault } from './vault-watcher.ts';
import type { Agenda, DesktopStatus, EditRelationInput, FindRelatedInput, SaveTaskInput, TaskRecord, TaskScope, VaultSelection } from './shared.ts';
import type { TaskRelations } from '../../packages/contracts/relations.ts';

app.setName('Obsidian Task Manager');
const loginLaunch = process.argv.includes('--task-autostart');
const profileArgument = process.argv.find(arg => arg.startsWith('--task-profile='))?.slice('--task-profile='.length);
if (profileArgument || !app.isPackaged) app.setPath('userData', path.resolve(profileArgument ?? process.env.TASK_DESKTOP_DATA ?? path.join(__dirname, '../../.local/desktop')));
// No quotes of our own in the arguments: Electron quotes and escapes them, and a doubled quote breaks the launch at login (see login-item.ts).
const loginOptions = { path: process.execPath, args: [...(app.isPackaged ? [] : [path.join(__dirname, 'main.cjs')]), '--task-autostart', `--task-profile=${app.getPath('userData')}`] };
// openAtLogin is not usable here: Electron answers false whenever the arguments contain a switch. Read the registered entry instead.
const autoStart = () => process.platform === 'win32' && loginItemState(app.getLoginItemSettings(loginOptions).launchItems, loginOptions) === 'active';
protocol.registerSchemesAsPrivileged([{ scheme: 'taskmanager', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let win: BrowserWindow, tray: Tray, quitting = false, shortcutCapture = false, vault: LocalVault | null = null;
let generation = 0, selectionBusy = false;
let pet: PetWindow | undefined;
let stopWatching: (() => void) | undefined;
let sync: HeadlessSync | undefined;
function observeVault() {
  pet?.refresh();
  sync?.setVault(vault?.selection.vaultPath ?? null);
  stopWatching?.(); stopWatching = undefined;
  if (vault) stopWatching = watchVault(vault.selection, () => {
    if (!win.isDestroyed()) win.webContents.send('task:changed');
    pet?.refresh();
  });
}
const cache = new Map<TaskScope, Agenda>();
let shortcuts: ShortcutStore, language: LanguageStore, applyTrayLanguage: () => void = () => {};
// The words of the parts the main process draws itself (tray, menus, dialogs, notifications), in the language chosen now.
const tm: Translate = (source, params) => translate(language.locale, source, params);
const profile = (name: string) => path.join(app.getPath('userData'), name);
const runProgram: RunProgram = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
const status = (): DesktopStatus => ({ autoStart: autoStart(), autoStartSupported: process.platform === 'win32', connected: !!vault, language: language.preference, categories: [...(vault?.categories ?? defaultCategoriesFor(language.locale))], vault: vault?.selection ?? null, shortcut: shortcuts.shortcut, shortcutRegistered: shortcuts.registered, shortcutError: shortcuts.error, sync: sync!.status() });
async function saveSelection(selection: VaultSelection) {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(profile('vault.json.tmp'), JSON.stringify(selection), { mode: 0o600 });
  await rename(profile('vault.json.tmp'), profile('vault.json'));
}
function show() {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [width = 680, height = 620] = win.getSize();
  win.setPosition(Math.round(area.x + (area.width - width) / 2), Math.max(area.y, Math.round(area.y + (area.height - height) / 3)));
  win.show(); win.focus(); win.webContents.send('task:show');
}
const needVault = () => { if (!vault) throw new VaultError('NO_VAULT'); return vault; };
const scopeOf = (scope: unknown): TaskScope => { if (!['all', 'completed', ...needVault().categories.map(categoryScope)].includes(scope as string)) throw new VaultError('INVALID_REQUEST'); return scope as TaskScope; };

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (win && !argv.includes('--task-autostart')) show(); });
  app.on('before-quit', () => { quitting = true; stopWatching?.(); pet?.dispose(); sync?.dispose(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.whenReady().then(async () => {
    // The installed app's first run takes over the settings of a run from source (see import-profile.ts), and its start at login, so
    // the two do not both start. Isolated profiles (tests) never do this.
    // Test hooks used only by scripts/smoke-packaged.ts: the entry to read instead of the registry, and a file that records the takeover
    // instead of Windows.
    const testEntry = process.env.TASK_TEST_STARTUP_ENTRY;
    if (app.isPackaged && process.platform === 'win32' && (testEntry || !process.env.TASK_DESKTOP_DATA) && !existsSync(profile('vault.json'))) {
      try {
        const entry: StartupEntry = testEntry ? JSON.parse(testEntry) : await readStartupEntry(runProgram), from = sourceProfileFrom(entry.command, process.execPath);
        if (from && await importProfile(from, app.getPath('userData')) && entry.enabled) {
          if (testEntry) await appendFile(process.env.TASK_TEST_LOGIN_LOG!, 'takeover\n');
          else app.setLoginItemSettings({ ...loginOptions, name: loginItemName, openAtLogin: true, enabled: true });
        }
      } catch { /* Then the vault is chosen again on the first screen. */ }
    }
    language = new LanguageStore(profile('language.json'), () => app.getLocale());
    await language.load();
    const categoryStore = new CategoryStore(profile('categories'));
    const loadVault = async (selection: VaultSelection) => new LocalVault(selection, await categoryStore.load(selection.vaultPath, language.locale));
    // An older version registered the login entry with quoted arguments, so the app could not start from it. Repair that once.
    // Isolated profiles (tests) never touch this shared per-user entry.
    if (process.platform === 'win32' && !process.env.TASK_DESKTOP_DATA) {
      try { repairLegacyLoginItem({ get: () => app.getLoginItemSettings(loginOptions).launchItems, set: options => app.setLoginItemSettings(options) }, loginOptions); }
      catch { /* The settings switch can still repair it. */ }
    }
    const syncSettings = new SyncSettings(profile('sync.json'));
    await syncSettings.load();
    // Test hooks used only by scripts/smoke-sync.ts: short waits, and notifications written to a file instead of shown.
    const fastTimings: Partial<SyncTimings> = { backoff: [150, 250], lockRetryMs: 250, lockRetries: 2, stallMs: 1500, checkMs: 200, stableMs: 5000, maxQuickFailures: 3 };
    const alertedAt = new Map<string, number>();
    const notify = (title: string, body: string) => {
      const log = process.env.TASK_TEST_NOTIFY_LOG;
      if (log) { void appendFile(log, JSON.stringify({ title, body }) + '\n').catch(() => {}); return; }
      if (!Notification.isSupported()) return;
      const toast = new Notification({ title, body }); toast.on('click', show); toast.show();
    };
    sync = new HeadlessSync({
      locate: () => locateHeadless({ env: process.env, platform: process.platform, exists: existsSync, realpath: realpathSync }),
      preflight: (command, vaultPath) => preflightSync(runCommand, command, vaultPath),
      spawn: (command, vaultPath) => spawnHeadless(command, vaultPath, process.env),
      now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
      ...(process.env.TASK_HEADLESS_TEST_TIMINGS === '1' ? { timings: fastTimings } : {}),
      onChange: (next, previous) => {
        if (win && !win.isDestroyed()) win.webContents.send('task:syncStatus', next);
        tray?.setToolTip('Obsidian Task Manager' + trayLabel(next, Date.now(), tm));
        const alert = syncAlert(previous, next, tm);
        // The same problem is announced at most once every 30 minutes.
        if (alert && Date.now() - (alertedAt.get(alert.key) ?? 0) > 30 * 60_000) { alertedAt.set(alert.key, Date.now()); notify(alert.title, alert.body); }
      },
    });
    let startupError: string | null = null;
    try {
      const saved: unknown = JSON.parse(await readFile(profile('vault.json'), 'utf8'));
      if (!validSelection(saved)) throw new Error('Invalid selection');
      vault = await loadVault(saved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') startupError = 'LOCAL_STORAGE_ERROR';
    }
    // Legacy server credentials are left untouched. This desktop never loads them or makes API requests.
    const assets: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/pet.html': ['pet.html', 'text/html; charset=utf-8'], '/pet.js': ['pet.js', 'text/javascript; charset=utf-8'], '/pet.css': ['pet.css', 'text/css; charset=utf-8'],
      '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'],
      '/PretendardVariable.woff2': ['PretendardVariable.woff2', 'font/woff2'],
    };
    protocol.handle('taskmanager', async request => {
      const url = new URL(request.url), asset = assets[url.pathname];
      if (url.hostname !== 'app' || !asset || request.method !== 'GET') return new Response('', { status: 404 });
      return new Response(await readFile(path.join(__dirname, 'renderer', asset[0])), { headers: { 'Content-Type': asset[1] } });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('taskmanager://app/') }));
    win = new BrowserWindow({ width: 680, height: 620, minWidth: 440, minHeight: 500, show: false, frame: false,
      backgroundColor: '#202022', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('app-command', (_event, command) => {
      if (command === 'browser-backward') win.webContents.send('task:back');
    });
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && !input.isAutoRepeat && (input.key === 'BrowserBack' || (input.alt && input.key === 'ArrowLeft' && !input.control && !input.meta && !input.shift))) {
        event.preventDefault(); win.webContents.send('task:back');
      }
    });
    win.on('blur', () => { shortcutCapture = false; });
    win.on('hide', () => { shortcutCapture = false; });
    win.webContents.on('render-process-gone', () => { shortcutCapture = false; });
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    const handle = (name: string, fn: (value: any) => unknown) => ipcMain.handle('task:' + name, async (event, value: unknown) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== 'taskmanager://app/index.html') return { ok: false, code: 'INVALID_REQUEST' };
      try { return { ok: true, value: await fn(value) }; }
      catch (error) { return { ok: false, code: error instanceof VaultError ? error.code : 'LOCAL_STORAGE_ERROR' }; }
    });
    handle('setShortcutCapture', value => {
      if (typeof value !== 'boolean') throw new VaultError('INVALID_REQUEST');
      shortcutCapture = value && win.isFocused(); return null;
    });
    handle('setAutoStart', value => {
      if (typeof value !== 'boolean' || process.platform !== 'win32') throw new VaultError('INVALID_REQUEST');
      app.setLoginItemSettings({ ...loginOptions, name: loginItemName, openAtLogin: value, enabled: value });
      if (autoStart() !== value) throw new VaultError('LOCAL_STORAGE_ERROR');
      return status();
    });
    handle('setShortcut', async value => { await shortcuts.save(value); return status(); });
    // The language is chosen in the settings. The built-in categories are named in that language, so the vault is read again with them.
    handle('setLanguage', async value => {
      if (selectionBusy) throw new VaultError('SELECTION_BUSY');
      if (value !== 'auto' && value !== 'ko' && value !== 'en') throw new VaultError('INVALID_REQUEST');
      selectionBusy = true;
      try {
        await language.save(value).catch(() => { throw new VaultError('LOCAL_STORAGE_ERROR'); });
        if (vault) { generation++; vault = await loadVault(vault.selection); cache.clear(); }
        applyTrayLanguage(); pet?.languageChanged(); pet?.refresh();
        return status();
      } finally { selectionBusy = false; }
    });
    handle('setHeadlessSync', async value => {
      if (typeof value !== 'boolean') throw new VaultError('INVALID_REQUEST');
      try { await syncSettings.save(value); } catch { throw new VaultError('LOCAL_STORAGE_ERROR'); }
      sync!.setEnabled(value); return status();
    });
    handle('retryHeadlessSync', () => { sync!.retry(); return status(); });
    handle('status', () => { if (startupError) { const code = startupError; startupError = null; throw new VaultError(code); } return status(); });
    const pick = async (taskFolder: boolean) => {
      if (selectionBusy) throw new VaultError('SELECTION_BUSY');
      selectionBusy = true;
      try {
        const current = taskFolder ? needVault() : vault;
        const choice = await dialog.showOpenDialog(win, {
          title: taskFolder ? tm('이 볼트 안의 작업 폴더 선택') : tm('Obsidian 볼트 선택'),
          buttonLabel: taskFolder ? tm('작업 폴더 선택') : tm('볼트 선택'),
          properties: ['openDirectory', 'dontAddToRecent'],
          ...(current ? { defaultPath: current.selection.vaultPath } : {}),
        });
        if (choice.canceled || !choice.filePaths[0]) return status();
        const next = taskFolder ? await selectTaskFolder(current!.selection, choice.filePaths[0]) : await selectVault(choice.filePaths[0]);
        const nextVault = await loadVault(next);
        await saveSelection(next);
        generation++; vault = nextVault; cache.clear(); observeVault();
        return status();
      } finally { selectionBusy = false; }
    };
    handle('selectVault', () => pick(false));
    handle('selectTaskFolder', () => pick(true));
    handle('agenda', async value => {
      const scope = scopeOf(value), current = needVault(), version = generation;
      try {
        const agenda = await current.agenda(scope);
        if (generation !== version) throw new VaultError('VAULT_CHANGED');
        cache.set(scope, agenda);
        return { agenda, stale: false, error: null };
      } catch (error) {
        if (generation !== version) throw new VaultError('VAULT_CHANGED');
        const agenda = cache.get(scope);
        if (agenda) return { agenda, stale: true, error: error instanceof VaultError ? error.code : 'VAULT_UNAVAILABLE' };
        throw error;
      }
    });
    handle('search', async input => {
      if (!input || typeof input.q !== 'string' || input.q.length > 200 || (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 2048))) throw new VaultError('INVALID_REQUEST');
      const current = needVault(), version = generation;
      const result = await current.search(scopeOf(input.scope), input.q, input.cursor);
      if (generation !== version) throw new VaultError('VAULT_CHANGED');
      return result;
    });
    handle('getTask', async value => {
      if (typeof value !== 'string' || value.length > 4096) throw new VaultError('INVALID_REQUEST');
      const current = needVault(), version = generation;
      const task = await current.getTask(value);
      if (version !== generation) throw new VaultError('VAULT_CHANGED');
      return task;
    });
    handle('addCategory', async name => {
      if (selectionBusy) throw new VaultError('SELECTION_BUSY');
      if (!validCategory(name)) throw new VaultError('INVALID_CATEGORY');
      selectionBusy = true;
      try {
        const current = needVault();
        if (current.categories.length >= 32 && !current.categories.includes(name)) throw new VaultError('CATEGORY_LIMIT');
        const categories = await categoryStore.add(current.selection.vaultPath, name, language.locale);
        generation++; vault = new LocalVault(current.selection, categories); cache.clear(); pet?.refresh(); return status();
      } finally { selectionBusy = false; }
    });
    // Shared by the app window and the widget's status menu, so both get the same conflict check and backup.
    const commitTask = async (input: SaveTaskInput) => {
      if (selectionBusy) throw new VaultError('SELECTION_BUSY');
      selectionBusy = true;
      try {
        const saved = await saveTask(needVault().selection, input, profile('task-backups'), new Date(), needVault().categories);
        generation++; vault = new LocalVault(needVault().selection, needVault().categories); cache.clear(); pet?.refresh(); return saved;
      } finally { selectionBusy = false; }
    };
    handle('saveTask', commitTask);
    // A relationship is written in one note (this task's, or the other task's), with the same backup and conflict check as any other change.
    handle('editRelation', async (input: EditRelationInput) => {
      if (selectionBusy) throw new VaultError('SELECTION_BUSY');
      selectionBusy = true;
      try {
        const current = needVault(), result = await editRelation(current.selection, input, current, profile('task-backups'));
        if (result.changed) { generation++; vault = new LocalVault(current.selection, current.categories); cache.clear(); pet?.refresh(); }
        return result;
      } finally { selectionBusy = false; }
    });
    handle('findRelated', async (input: FindRelatedInput) => {
      const current = needVault(), version = generation;
      const found = await findRelatedFor(current.selection, input, current);
      if (generation !== version) throw new VaultError('VAULT_CHANGED');
      return found;
    });
    handle('forgetVault', async () => {
      if (selectionBusy) throw new VaultError('SELECTION_BUSY');
      selectionBusy = true;
      try {
        await unlink(profile('vault.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        generation++; vault = null; cache.clear(); observeVault(); return null;
      } finally { selectionBusy = false; }
    });
    handle('showPet', async () => { await pet?.show(); return null; });
    handle('hide', () => { win.hide(); return null; });
    const pixels = Buffer.alloc(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const tick = (x >= 7 && x <= 14 && Math.abs(y - x - 7) <= 2) || (x >= 13 && x <= 25 && Math.abs(y + x - 34) <= 2);
      const i = (y * 32 + x) * 4;
      pixels[i] = tick ? 245 : 139; pixels[i + 1] = tick ? 245 : 97; pixels[i + 2] = tick ? 245 : 112; pixels[i + 3] = 255;
    }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }));
    // The tray's menu and tooltip are made again when the language changes.
    applyTrayLanguage = () => {
      tray.setToolTip('Obsidian Task Manager' + trayLabel(sync!.status(), Date.now(), tm));
      tray.setContextMenu(Menu.buildFromTemplate([{ label: tm('오늘 작업 열기'), click: show }, { label: tm('미니 위젯 보이기'), click: () => { void pet?.show(); } }, { type: 'separator' }, { label: tm('종료'), click: () => app.quit() }]));
    };
    applyTrayLanguage();
    tray.on('click', show);
    shortcuts = new ShortcutStore(profile('shortcut.json'), globalShortcut, () => {
      if (shortcutCapture && win.isFocused()) return;
      win.isVisible() && win.isFocused() ? win.hide() : show();
    });
    await shortcuts.load();
    observeVault();
    sync.setEnabled(syncSettings.enabled);
    await win.loadURL('taskmanager://app/index.html'); if (!loginLaunch) show();
    pet = await PetWindow.create(profile('pet.json'), async (): Promise<PetSnapshot> => {
      if (!vault) return { kind: 'disconnected', total: 0, tasks: [], partial: false, selectionKey: '', statuses: [...defaultStatuses] };
      const current = vault, version = generation;
      const agenda = await current.agenda('all');
      if (version !== generation) throw new VaultError('VAULT_CHANGED');
      return summarizePet(agenda, JSON.stringify(current.selection), current.categories);
    }, async requested => {
      show();
      if (!requested) return true;
      if (!vault || JSON.stringify(vault.selection) !== requested.selectionKey) return false;
      const current = vault, version = generation;
      try {
        const agenda = await current.agenda('all');
        let found: { task: TaskRecord; relations: TaskRelations | null } | null = null;
        const listed = [...agenda.today, ...agenda.overdue].find(t => t.id === requested.id);
        if (listed) found = { task: listed, relations: agenda.relations[listed.id] ?? null };
        else {
          // A subtask shown under its parent need not be due today. Its path is in the parent's relations.
          const sub = Object.values(agenda.relations).flatMap(r => r.subtasks).find(t => t.id === requested.id);
          found = sub ? await current.getTask(sub.path) : null;
        }
        if (!found || version !== generation) return false;
        win.webContents.send('task:openTask', { ...found, selection: current.selection }); return true;
      } catch { return false; }
    }, (target, status) => commitTask({ selection: needVault().selection, path: target.path, revision: target.revision, changes: { status } }), () => tm);
  }).catch(() => { console.error('The app could not start. Check the local profile and the environment.'); app.quit(); });
}
