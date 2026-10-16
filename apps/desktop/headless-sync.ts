import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import type { SyncPhase, SyncProblem, SyncStatus } from './shared.ts';

// Runs Obsidian's official headless client (`ob sync --continuous`, package obsidian-headless) for the selected vault and watches it.
// The app never handles the Obsidian login or the vault's encryption password: `ob login` and `ob sync-setup` are done once in a terminal.
// The client is started as `node <cli.js> ...` instead of through the npm `ob.cmd` shim, so no shell parses the vault path.

export interface HeadlessCommand { node: string; script: string }
export type Located = { ok: true; command: HeadlessCommand } | { ok: false; problem: 'NOT_INSTALLED' | 'NODE_MISSING' };
export interface LocateOptions { env: Record<string, string | undefined>; platform: NodeJS.Platform; exists(file: string): boolean; realpath(file: string): string }

// Finds obsidian-headless's cli.js next to the `ob` shim on PATH (or in %APPDATA%\npm) and the node that should run it.
// TASK_HEADLESS_ENTRY and TASK_HEADLESS_NODE override both, for installs in unusual places.
export function locateHeadless({ env, platform, exists, realpath }: LocateOptions): Located {
  const win = platform === 'win32', p = win ? path.win32 : path.posix;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const dirs = (env[pathKey] ?? '').split(win ? ';' : ':').map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (win && env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm'));
  let script = env.TASK_HEADLESS_ENTRY?.trim() ?? '', shimDir = '';
  if (script) { if (!exists(script)) return { ok: false, problem: 'NOT_INSTALLED' }; }
  else {
    for (const dir of dirs) {
      const shim = (win ? ['ob.cmd', 'ob.ps1', 'ob'] : ['ob']).map(name => p.join(dir, name)).find(exists);
      if (!shim) continue;
      const packaged = p.join(dir, 'node_modules', 'obsidian-headless', 'cli.js');
      if (exists(packaged)) { script = packaged; shimDir = dir; break; }
      if (!win) {
        try { const real = realpath(shim); if (p.basename(real) === 'cli.js' && exists(real)) { script = real; shimDir = dir; break; } }
        catch { /* Not a link to the package. */ }
      }
    }
    if (!script) return { ok: false, problem: 'NOT_INSTALLED' };
  }
  const exe = win ? 'node.exe' : 'node', explicit = env.TASK_HEADLESS_NODE?.trim();
  const node = [...(explicit ? [explicit] : []), ...(shimDir ? [p.join(shimDir, exe)] : []), ...dirs.map(dir => p.join(dir, exe))].find(exists);
  return node ? { ok: true, command: { node, script } } : { ok: false, problem: 'NODE_MISSING' };
}

export type LineEvent =
  | { kind: 'problem'; problem: SyncProblem } | { kind: 'connecting' } | { kind: 'offline' } | { kind: 'synced' }
  | { kind: 'progress'; done: number; total: number } | { kind: 'transfer' } | { kind: 'error'; text: string } | { kind: 'info' };

// Reads one output line of `ob`. Matching is on phrases from obsidian-headless 0.0.14, not on an exact format, so a timestamp prefix does not matter.
// Transfer lines are checked first: they contain file names, and a note called "Not logged in" must not look like an error.
export function interpretLine(line: string): LineEvent {
  const text = line.trim(), lower = text.toLowerCase();
  const progress = /uploading \((\d+)\/(\d+)\)/i.exec(text);
  if (progress) return { kind: 'progress', done: Number(progress[1]), total: Number(progress[2]) };
  if (/^\W*(uploading|downloading|downloaded|upload complete)\b/i.test(text)) return { kind: 'transfer' };
  if (lower.includes('another sync instance is already running')) return { kind: 'problem', problem: 'ALREADY_RUNNING' };
  if (lower.includes('no account logged in') || lower.includes('not logged in')) return { kind: 'problem', problem: 'NOT_LOGGED_IN' };
  if (lower.includes('no sync configuration found') || (lower.includes('sync-setup') && lower.includes('first'))) return { kind: 'problem', problem: 'NOT_CONFIGURED' };
  if (lower.includes('remote vault no longer exists')) return { kind: 'problem', problem: 'REMOTE_MISSING' };
  if (lower.includes('encryption key')) return { kind: 'problem', problem: 'ENCRYPTION_KEY' };
  if (lower.includes('fully synced')) return { kind: 'synced' };
  if (lower.includes('waiting to connect') || lower.includes('disconnected')) return { kind: 'offline' };
  if (lower.includes('connecting')) return { kind: 'connecting' };
  if (lower.includes('sync error:') || lower.includes('sync failed:')) return { kind: 'error', text: text.slice(0, 200) };
  return { kind: 'info' };
}

export interface RunResult { code: number | null; stdout: string; stderr: string }
export type RunCommand = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>;
export const runCommand: RunCommand = (command, args, timeoutMs) => new Promise(resolve => {
  execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

export interface Preflight { problem: SyncProblem | null; mode: string | null }
// A read-only look before starting: is the vault connected to sync, and does it sync in both directions?
// `pull-only` never uploads and `mirror-remote` reverts local edits, so either would undo this app's task changes.
export async function preflightSync(run: RunCommand, command: HeadlessCommand, vaultPath: string): Promise<Preflight> {
  const result = await run(command.node, [command.script, 'sync-status', '--path', vaultPath, '--json'], 20_000);
  if (result.code === 0) {
    try {
      const mode: unknown = (JSON.parse(result.stdout) as { syncMode?: unknown }).syncMode;
      if (typeof mode === 'string') return { problem: mode === 'bidirectional' ? null : 'BAD_MODE', mode };
    } catch { /* Unexpected output: let the real sync report what is wrong. */ }
    return { problem: null, mode: null };
  }
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    const event = interpretLine(line);
    if (event.kind === 'problem') return { problem: event.problem, mode: null };
  }
  return { problem: null, mode: null };
}

export interface SyncChild { onLine(callback: (line: string) => void): void; onExit(callback: (code: number | null) => void): void; kill(): void }
export function spawnHeadless(command: HeadlessCommand, vaultPath: string, env: NodeJS.ProcessEnv): SyncChild {
  const child = spawn(command.node, [command.script, 'sync', '--continuous', '--path', vaultPath],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  const lines: ((line: string) => void)[] = [], exits: ((code: number | null) => void)[] = [];
  let exited = false;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = (pending + chunk).split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) for (const callback of lines) callback(part);
    });
    stream.on('end', () => { if (pending) for (const callback of lines) callback(pending); pending = ''; });
  }
  const finish = (code: number | null) => { if (exited) return; exited = true; for (const callback of exits) callback(code); };
  child.on('error', () => finish(null));
  child.on('close', code => finish(code));
  return { onLine: callback => { lines.push(callback); }, onExit: callback => { exits.push(callback); }, kill: () => { child.kill(); } };
}

export interface SyncTimings { backoff: number[]; lockRetryMs: number; lockRetries: number; stallMs: number; checkMs: number; stableMs: number; maxQuickFailures: number }
export const defaultTimings: SyncTimings = { backoff: [3000, 10_000, 30_000, 60_000], lockRetryMs: 6000, lockRetries: 3, stallMs: 5 * 60_000, checkMs: 30_000, stableMs: 60_000, maxQuickFailures: 5 };

type Timer = unknown;
export interface SyncDeps {
  locate(): Located;
  preflight(command: HeadlessCommand, vaultPath: string): Promise<Preflight>;
  spawn(command: HeadlessCommand, vaultPath: string): SyncChild;
  now(): number;
  setTimeout(callback: () => void, ms: number): Timer; clearTimeout(timer: Timer): void;
  setInterval(callback: () => void, ms: number): Timer; clearInterval(timer: Timer): void;
  onChange(next: SyncStatus, previous: SyncStatus): void;
  timings?: Partial<SyncTimings>;
}

const problemsNeedingYou: SyncProblem[] = ['NOT_LOGGED_IN', 'NOT_CONFIGURED', 'REMOTE_MISSING', 'ENCRYPTION_KEY'];

export class HeadlessSync {
  private readonly t: SyncTimings;
  private enabled = false; private vaultPath: string | null = null;
  private phase: SyncPhase = 'off'; private problem: SyncProblem | null = null; private phaseSince: number | null = null;
  private startedAt: number | null = null; private lastSyncedAt: number | null = null; private lastActivityAt: number | null = null;
  private progress: { done: number; total: number } | null = null; private restarts = 0; private lastError: string | null = null;
  private mode: string | null = null; private recent: string[] = [];
  private child: SyncChild | null = null; private starting = false; private run = 0; private disposed = false;
  private failures = 0; private lockTries = 0; private seen: SyncProblem | null = null;
  private restartTimer: Timer | null = null; private checkTimer: Timer | null = null; private emitTimer: Timer | null = null;
  private last: SyncStatus; private lastEmitAt = 0;
  constructor(private readonly deps: SyncDeps) { this.t = { ...defaultTimings, ...deps.timings }; this.last = this.status(); }

  status(): SyncStatus {
    return { enabled: this.enabled, phase: this.phase, problem: this.phase === 'problem' ? this.problem : null, phaseSince: this.phaseSince, startedAt: this.startedAt,
      lastSyncedAt: this.lastSyncedAt, lastActivityAt: this.lastActivityAt, progress: this.progress ? { ...this.progress } : null,
      restarts: this.restarts, lastError: this.lastError, mode: this.mode, recent: [...this.recent] };
  }
  setEnabled(value: boolean) {
    if (this.disposed) return;
    this.enabled = value;
    this.stopChild(); this.clearRestart(); this.clearProblem();
    if (value) { this.failures = 0; this.lockTries = 0; this.restarts = 0; this.startChecker(); }
    else { this.stopChecker(); this.resetTelemetry(); }
    this.reconcile();
  }
  setVault(vaultPath: string | null) {
    if (this.disposed || vaultPath === this.vaultPath) return;
    this.vaultPath = vaultPath;
    this.stopChild(); this.clearRestart(); this.clearProblem(); this.failures = 0; this.lockTries = 0;
    this.reconcile();
  }
  // "다시 시도": clears whatever stopped it and starts over.
  retry() {
    if (this.disposed || !this.enabled) return;
    this.stopChild(); this.clearRestart(); this.clearProblem(); this.failures = 0; this.lockTries = 0; this.restarts = 0;
    this.reconcile();
  }
  dispose() {
    this.disposed = true; this.stopChild(); this.clearRestart(); this.stopChecker();
    if (this.emitTimer !== null) { this.deps.clearTimeout(this.emitTimer); this.emitTimer = null; }
  }

  private reconcile() {
    if (this.disposed) return;
    if (!this.enabled) { this.setPhase('off'); this.emit(); return; }
    if (!this.vaultPath) { this.fail('NO_VAULT'); return; }
    if (this.child || this.starting || this.restartTimer !== null) return;
    if (this.phase === 'problem') return;
    void this.begin();
  }
  private async begin() {
    const id = ++this.run, vault = this.vaultPath;
    if (vault === null) return;
    this.starting = true; this.seen = null;
    this.setPhase('starting'); this.emit();
    const located = this.deps.locate();
    let problem: SyncProblem | null = located.ok ? null : located.problem, mode: string | null = null;
    if (located.ok) {
      try { const pre = await this.deps.preflight(located.command, vault); problem = pre.problem; mode = pre.mode; }
      catch { /* Let the real sync report what is wrong. */ }
    }
    if (id !== this.run || this.disposed) return;
    this.starting = false;
    if (mode) this.mode = mode;
    if (!located.ok || problem) { this.fail(problem ?? 'NOT_INSTALLED'); return; }
    this.launch(located.command, vault, id);
  }
  private launch(command: HeadlessCommand, vault: string, id: number) {
    let child: SyncChild;
    try { child = this.deps.spawn(command, vault); }
    catch { this.handleExit(null, 0); return; }
    this.child = child; this.startedAt = this.deps.now(); this.progress = null;
    child.onLine(line => { if (id === this.run) this.handleLine(line); });
    child.onExit(code => { if (id === this.run) this.handleExit(code, this.startedAt === null ? 0 : this.deps.now() - this.startedAt); });
    this.emit();
  }
  private handleLine(raw: string) {
    const line = raw.trim();
    if (!line) return;
    this.recent.push(line.slice(0, 300)); if (this.recent.length > 30) this.recent.shift();
    this.lastActivityAt = this.deps.now();
    const event = interpretLine(line);
    let changed = false;
    switch (event.kind) {
      case 'problem': this.seen = event.problem; break;
      case 'connecting': case 'offline': if (this.phase !== 'stalled') changed = this.setPhase(event.kind === 'connecting' ? 'connecting' : 'offline'); break;
      case 'progress': changed = this.setPhase('syncing'); this.progress = { done: event.done, total: event.total }; break;
      case 'transfer': changed = this.setPhase('syncing'); break;
      case 'synced': changed = this.setPhase('synced'); this.lastSyncedAt = this.deps.now(); this.progress = null; this.failures = 0; this.lockTries = 0; break;
      case 'error': this.lastError = event.text; break;
      case 'info': break;
    }
    this.emit(!changed);
  }
  private handleExit(code: number | null, uptime: number) {
    void code;
    this.child = null; this.startedAt = null; this.progress = null;
    const seen = this.seen; this.seen = null;
    if (seen && problemsNeedingYou.includes(seen)) { this.fail(seen); return; }
    if (seen === 'ALREADY_RUNNING') {
      // The lock of a client we stopped ourselves goes stale after about 5 seconds, so retry a few times before blaming someone else.
      if (++this.lockTries > this.t.lockRetries) { this.fail('ALREADY_RUNNING'); return; }
      this.setPhase('starting'); this.emit(); this.scheduleRestart(this.t.lockRetryMs); return;
    }
    if (uptime >= this.t.stableMs) this.failures = 0;
    this.failures++; this.restarts++;
    if (this.failures > this.t.maxQuickFailures) { this.fail('CRASHED'); return; }
    this.setPhase('starting'); this.emit();
    this.scheduleRestart(this.t.backoff[Math.min(this.failures, this.t.backoff.length) - 1] ?? 60_000);
  }
  private scheduleRestart(ms: number) {
    this.clearRestart();
    this.restartTimer = this.deps.setTimeout(() => { this.restartTimer = null; this.reconcile(); }, ms);
  }
  private fail(problem: SyncProblem) {
    this.stopChild(); this.clearRestart();
    this.problem = problem; this.setPhase('problem'); this.emit();
  }
  private setPhase(phase: SyncPhase) {
    if (this.phase === phase) return false;
    this.phase = phase; this.phaseSince = this.deps.now(); return true;
  }
  private stopChild() {
    this.run++; this.starting = false;
    const child = this.child; this.child = null; this.startedAt = null; this.progress = null;
    if (child) { try { child.kill(); } catch { /* Already gone. */ } }
  }
  private clearRestart() { if (this.restartTimer !== null) { this.deps.clearTimeout(this.restartTimer); this.restartTimer = null; } }
  private clearProblem() { this.problem = null; if (this.phase === 'problem') this.phase = 'off'; }
  private resetTelemetry() { this.lastSyncedAt = null; this.lastActivityAt = null; this.lastError = null; this.mode = null; this.recent = []; this.restarts = 0; this.phaseSince = null; }
  private startChecker() { if (this.checkTimer === null) this.checkTimer = this.deps.setInterval(() => this.checkStall(), this.t.checkMs); }
  private stopChecker() { if (this.checkTimer !== null) { this.deps.clearInterval(this.checkTimer); this.checkTimer = null; } }
  // Still running but not connected for a long time: say so instead of showing "connecting" forever.
  private checkStall() {
    if (!this.child || this.phaseSince === null) return;
    if (['starting', 'connecting', 'offline'].includes(this.phase) && this.deps.now() - this.phaseSince >= this.t.stallMs) { this.setPhase('stalled'); this.emit(); }
  }
  // Phase changes are reported at once; progress and log lines at most about three times a second.
  private emit(soft = false) {
    const now = this.deps.now();
    if (soft && now - this.lastEmitAt < 300) {
      if (this.emitTimer === null) this.emitTimer = this.deps.setTimeout(() => { this.emitTimer = null; this.emit(); }, 300);
      return;
    }
    if (this.emitTimer !== null) { this.deps.clearTimeout(this.emitTimer); this.emitTimer = null; }
    const next = this.status();
    if (JSON.stringify(next) === JSON.stringify(this.last)) return;
    const previous = this.last; this.last = next; this.lastEmitAt = now;
    this.deps.onChange(next, previous);
  }
}
