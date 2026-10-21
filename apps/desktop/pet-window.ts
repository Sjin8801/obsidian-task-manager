import { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compactSize, findPetTask, fitPeekHeight, isListed, leaveCheckMs, noticeSeconds, peekMaxHeight, peekSubtaskRoom, petBounds, petErrorText, raiseEveryMs, readPetPreferences, shouldRaise, statusChoices, undoStatus, type PetNotice, type PetPreferences, type PetSnapshot, type PetStatusTarget, type PetView } from './pet-model.ts';
import { defaultStatuses, findStatus } from '../../packages/contracts/statuses.ts';
import type { Translate } from './i18n/index.ts';
import { localizeStatuses } from './i18n/statuses.ts';

// Saves one note's status. Refused (with an error code) when the note has changed since `revision`.
export type ChangeStatus = (target: { path: string; revision: string }, status: string) => Promise<{ revision: string }>;

export class PetWindow {
  readonly window: BrowserWindow;
  private preferences: PetPreferences;
  private expanded = false;
  private peekHeight = peekMaxHeight;
  private passing = false;
  private leaveTimer: ReturnType<typeof setInterval> | undefined;
  private snapshot: PetSnapshot = { kind: 'loading', total: 0, tasks: [], partial: false, selectionKey: '', statuses: [...defaultStatuses] };
  private settingsError = false;
  // Which side of the list the button was last drawn on, as the page was told.
  private shown = { below: false, left: false };
  private timer: ReturnType<typeof setInterval>;
  private raiseTimer: ReturnType<typeof setInterval>;
  private writing: Promise<void> = Promise.resolve();
  private pending = false;
  private refreshing = false;
  private closed = false;
  private dragging: { x: number; y: number; startX: number; startY: number } | null = null;
  // While the status menu is open the pointer is over the menu, not the list. The list must stay so the choice has a target.
  private menuOpen = false;
  private notice: PetNotice | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  // The last task finished from this list, kept so it can be put back while the notice is shown.
  private undoTarget: { path: string; revision: string; status: string } | null = null;
  private readonly displayChanged = () => { this.applyBounds(); };
  private constructor(private file: string, preferences: PetPreferences,
    private read: () => Promise<PetSnapshot>, private openMain: (task?: { id: string; selectionKey: string }) => Promise<boolean>,
    private changeStatus: ChangeStatus, private t: () => Translate) {
    this.preferences = preferences;
    const bounds = this.layout();
    this.window = new BrowserWindow({ ...bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      hasShadow: false, resizable: false, maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: preferences.alwaysOnTop,
      title: t()('오늘 할 일 · 미니 위젯'), webPreferences: { preload: path.join(__dirname, 'pet-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', e => e.preventDefault());
    this.window.on('close', e => { if (!this.closed) { e.preventDefault(); void this.hide(); } });
    const handle = (name: string, fn: (v: any) => unknown) => ipcMain.handle('pet:' + name, (event, value: unknown) => {
      if (event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame || event.senderFrame.url !== 'taskmanager://app/pet.html') throw new Error('INVALID_REQUEST');
      return fn(value);
    });
    handle('state', () => this.view());
    handle('expand', value => { if (typeof value !== 'boolean') throw new Error('INVALID_REQUEST'); this.setExpanded(value); });
    handle('fit', value => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000) throw new Error('INVALID_REQUEST');
      const next = fitPeekHeight(value, peekMaxHeight + peekSubtaskRoom);
      if (next === this.peekHeight) return;
      this.peekHeight = next;
      if (this.expanded) this.fitBounds();
    });
    handle('passThrough', value => { if (typeof value !== 'boolean') throw new Error('INVALID_REQUEST'); this.setPassThrough(value); });
    handle('open', value => {
      if (value !== undefined && (!value || typeof value.id !== 'string' || typeof value.selectionKey !== 'string' || value.selectionKey !== this.snapshot.selectionKey || !isListed(this.snapshot, value.id))) return false;
      this.setExpanded(false); return this.openMain(value);
    });
    handle('menu', () => { this.contextMenu(); });
    handle('taskMenu', value => { const task = findPetTask(this.snapshot, value); if (task) this.statusMenu(task); });
    handle('undo', () => this.undo());
    // The menus are drawn by Windows, which follows the system colours. Pass on the app's own light/dark choice so they match it.
    handle('theme', value => { if (value !== 'light' && value !== 'dark') throw new Error('INVALID_REQUEST'); nativeTheme.themeSource = value; });
    handle('drag', value => this.drag(value));
    screen.on('display-removed', this.displayChanged); screen.on('display-metrics-changed', this.displayChanged);
    this.timer = setInterval(() => this.refresh(), 30_000);
    this.raiseTimer = setInterval(() => this.raise(), raiseEveryMs);
  }
  static async create(file: string, read: () => Promise<PetSnapshot>, openMain: (task?: { id: string; selectionKey: string }) => Promise<boolean>, changeStatus: ChangeStatus, t: () => Translate) {
    const area = screen.getPrimaryDisplay().workArea;
    const fallback: PetPreferences = { x: area.x + area.width - compactSize.width - 24, y: area.y + area.height - compactSize.height - 24, hidden: false, alwaysOnTop: true, peek: true };
    let preferences = fallback;
    try { preferences = readPetPreferences(JSON.parse(await readFile(file, 'utf8')), fallback); } catch { /* First launch or invalid preferences use the visible default. */ }
    const pet = new PetWindow(file, preferences, read, openMain, changeStatus, t);
    app.once('before-quit', () => pet.dispose());
    await pet.window.loadURL('taskmanager://app/pet.html');
    pet.applyBounds(); pet.setPassThrough(true);
    if (!preferences.hidden) pet.window.showInactive();
    pet.refresh(); return pet;
  }
  private layout() {
    const p = this.preferences;
    const area = screen.getDisplayMatching({ x: p.x, y: p.y, ...compactSize }).workArea;
    return petBounds(p, this.expanded, area, this.peekHeight);
  }
  private view(): PetView {
    const { below, left } = this.layout();
    this.shown = { below, left };
    return { snapshot: this.snapshot, expanded: this.expanded, below, left, settingsError: this.settingsError, notice: this.notice };
  }
  private publish() { if (!this.closed && !this.window.isDestroyed()) this.window.webContents.send('pet:state', this.view()); }
  private applyBounds() {
    if (this.closed) return;
    const compact = petBounds(this.preferences, false, screen.getDisplayMatching({ ...this.preferences, ...compactSize }).workArea);
    this.preferences.x = compact.x; this.preferences.y = compact.y;
    const { x, y, width, height } = this.layout();
    this.window.setBounds({ x, y, width, height }); this.publish();
  }
  // The list got longer or shorter (the page reports the height with its longest subtasks open, which does not change while they slide):
  // move the window, and tell the page only when the button has gone to the other side of the list (its edges, not its height, are what the
  // page lays out by).
  private fitBounds() {
    if (this.closed) return;
    const { x, y, width, height, below, left } = this.layout();
    this.window.setBounds({ x, y, width, height });
    if (below !== this.shown.below || left !== this.shown.left) this.publish();
  }
  // The window is taller than the list whenever the list has room for subtasks that are not open, and it has a margin around the button.
  // Those parts are see-through, and a click there must reach the window behind. `forward` keeps the pointer moves coming to the page, so
  // it can say when the pointer is back over the list or the button.
  private setPassThrough(value: boolean) {
    if (this.passing === value || this.closed || this.window.isDestroyed()) return;
    this.passing = value; this.window.setIgnoreMouseEvents(value, { forward: true });
    this.watchLeave(!value);
  }
  // Once click-through is switched off, Chromium does not hear about the pointer leaving the window (it started tracking the pointer through
  // the forwarded moves, and that tracking is not set up again), so the list stayed open after the pointer had gone. While the widget takes the
  // pointer, look where the real pointer is and tell the page when it is outside the window; the page then closes the list as on any leave.
  private watchLeave(on: boolean) {
    clearInterval(this.leaveTimer); this.leaveTimer = undefined;
    if (!on) return;
    this.leaveTimer = setInterval(() => {
      if (this.closed || this.window.isDestroyed() || !this.window.isVisible() || this.dragging) return;
      const cursor = screen.getCursorScreenPoint(), b = this.window.getBounds();
      if (cursor.x < b.x || cursor.y < b.y || cursor.x >= b.x + b.width || cursor.y >= b.y + b.height) this.window.webContents.send('pet:pointerLeft');
    }, leaveCheckMs);
  }
  private raise() {
    if (this.closed || this.window.isDestroyed()) return;
    if (shouldRaise({ alwaysOnTop: this.preferences.alwaysOnTop, hidden: this.preferences.hidden, closed: this.closed, visible: this.window.isVisible() })) this.window.moveTop();
  }
  private setExpanded(value: boolean, force = false) {
    if (!value && this.menuOpen && !force) return;
    const next = value && this.preferences.peek && !this.dragging;
    if (this.expanded === next) return;
    this.expanded = next; this.applyBounds();
    if (next) this.raise();
  }
  private persist() {
    const json = JSON.stringify(this.preferences);
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', json, { mode: 0o600 }); await rename(this.file + '.tmp', this.file);
      this.settingsError = false;
    }).catch(() => { this.settingsError = true; }).finally(() => this.publish());
    return this.writing;
  }
  private async drag(v: unknown) {
    if (!v || typeof v !== 'object') throw new Error('INVALID_REQUEST');
    const value = v as { phase: string; x: number; y: number };
    if (!['start', 'move', 'end'].includes(value.phase) || !Number.isFinite(value.x) || !Number.isFinite(value.y) || Math.abs(value.x) > 100000 || Math.abs(value.y) > 100000) throw new Error('INVALID_REQUEST');
    if (value.phase === 'start') {
      this.dragging = { x: this.preferences.x, y: this.preferences.y, startX: value.x, startY: value.y };
      this.setExpanded(false, true);
    } else if (this.dragging) {
      this.preferences.x = this.dragging.x + value.x - this.dragging.startX;
      this.preferences.y = this.dragging.y + value.y - this.dragging.startY;
      this.applyBounds();
      if (value.phase === 'end') { this.dragging = null; await this.persist(); }
    }
  }
  private contextMenu() {
    const t = this.t();
    Menu.buildFromTemplate([
      { label: t('오늘 작업 열기'), click: () => { void this.openMain(); } },
      { type: 'separator' },
      { label: t('마우스를 올리면 목록 펼치기'), type: 'checkbox', checked: this.preferences.peek, click: item => { this.preferences.peek = item.checked; this.setExpanded(false); void this.persist(); } },
      { label: t('항상 위에 표시'), type: 'checkbox', checked: this.preferences.alwaysOnTop, click: item => { this.preferences.alwaysOnTop = item.checked; this.window.setAlwaysOnTop(item.checked); void this.persist(); } },
      { label: t('위젯 숨기기'), click: () => { void this.hide(); } },
    ]).popup({ window: this.window });
  }
  private statusMenu(task: PetStatusTarget) {
    const choose = (status: string) => { void this.applyStatus(task, status); };
    this.menuOpen = true;
    const t = this.t();
    Menu.buildFromTemplate([
      ...statusChoices(task, localizeStatuses(this.snapshot.statuses, t)).map(choice => ({ label: choice.label, type: 'radio' as const, checked: choice.checked, enabled: choice.enabled, click: () => choose(choice.status) })),
      ...(task.recurring ? [{ label: t('반복 작업은 Obsidian에서 수정해 주세요.'), enabled: false }] : []),
      { type: 'separator' as const },
      { label: t('앱에서 열기'), click: () => { this.setExpanded(false, true); void this.openMain({ id: task.id, selectionKey: this.snapshot.selectionKey }); } },
    ]).popup({ window: this.window, callback: () => {
      this.menuOpen = false;
      // The pointer may have gone elsewhere while the menu was open. If so the list closes now, as it would have without the menu.
      if (this.closed || this.window.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint(), bounds = this.window.getBounds();
      if (cursor.x < bounds.x || cursor.y < bounds.y || cursor.x >= bounds.x + bounds.width || cursor.y >= bounds.y + bounds.height) this.setExpanded(false);
    } });
  }
  private setNotice(notice: PetNotice | null) {
    clearTimeout(this.noticeTimer); this.notice = notice;
    if (notice) this.noticeTimer = setTimeout(() => { this.notice = null; this.undoTarget = null; this.publish(); }, (notice.error ? noticeSeconds.error : noticeSeconds.undo) * 1000);
    this.publish();
  }
  private async applyStatus(task: PetStatusTarget, status: string) {
    const statuses = this.snapshot.statuses;
    if (task.recurring || status === findStatus(task.rawStatus, statuses)?.value) return;
    try {
      const saved = await this.changeStatus({ path: task.path, revision: task.revision }, status);
      // A finished task leaves this list, so offer to put it back. Any other change is visible in the row itself.
      if (statuses.find(s => s.value === status)?.completed) { this.undoTarget = { path: task.path, revision: saved.revision, status: undoStatus(task.rawStatus, statuses) }; this.setNotice({ text: this.t()('‘{title}’ 완료했어요', { title: task.title }), error: false, undo: true }); }
      else { this.undoTarget = null; this.setNotice(null); }
    } catch (error) {
      this.undoTarget = null; this.setNotice({ text: petErrorText((error as { code?: unknown })?.code, this.t()), error: true, undo: false });
    }
    this.refresh();
  }
  private async undo() {
    const target = this.undoTarget; if (!target) return;
    this.undoTarget = null;
    try { await this.changeStatus({ path: target.path, revision: target.revision }, target.status); this.setNotice(null); }
    catch (error) { this.setNotice({ text: petErrorText((error as { code?: unknown })?.code, this.t()), error: true, undo: false }); }
    this.refresh();
  }
  /** The language changed: the window's own title follows. (The menus are made when they are opened.) */
  languageChanged() { if (!this.window.isDestroyed()) this.window.setTitle(this.t()('오늘 할 일 · 미니 위젯')); }
  async show() { this.preferences.hidden = false; this.setExpanded(false, true); this.applyBounds(); this.window.showInactive(); this.refresh(); await this.persist(); }
  private async hide() { this.preferences.hidden = true; this.menuOpen = false; this.setExpanded(false, true); this.window.hide(); await this.persist(); }
  refresh() {
    if (this.closed || this.preferences.hidden) return;
    this.pending = true;
    if (this.refreshing) return;
    this.refreshing = true;
    void (async () => {
      while (this.pending && !this.closed) {
        this.pending = false;
        try { const next = await this.read(); if (!this.pending) this.snapshot = next; }
        catch { if (!this.pending) this.snapshot = { kind: 'unavailable', total: 0, tasks: [], partial: false, selectionKey: '', statuses: this.snapshot.statuses }; }
        if (!this.pending) this.publish();
      }
    })().finally(() => { this.refreshing = false; });
  }
  dispose() { if (this.closed) return; this.closed = true; clearInterval(this.timer); clearInterval(this.raiseTimer); clearInterval(this.leaveTimer); clearTimeout(this.noticeTimer); screen.removeListener('display-removed', this.displayChanged); screen.removeListener('display-metrics-changed', this.displayChanged); this.window.destroy(); }
}
