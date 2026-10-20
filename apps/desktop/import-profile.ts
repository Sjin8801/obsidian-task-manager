import path from 'node:path';
import { cp, rename, rm, stat } from 'node:fs/promises';
import { loginItemName, same } from './login-item.ts';

// The installed app keeps its settings in %APPDATA%; a run from source keeps them in <project>/.local/desktop. When someone moves from
// one to the other, the installed app's first run copies the settings over so the vault, categories, shortcut and widget position stay.
//
// The only trace of where that project is: the start-at-login entry a run from source registers,
//   "<project>\node_modules\electron\dist\electron.exe" "<project>\dist\desktop\main.cjs" --task-autostart "--task-profile=<profile>"
// Electron's own getLoginItemSettings cannot be used to find it: it lists only entries for the executable that asks, so the installed
// app never sees the run from source's entry. The entry is read from the registry instead (readStartupEntry).

/** The settings, by name in the profile. task-backups is not copied: the backups stay where they were made. */
export const importedFiles = ['vault.json', 'language.json', 'shortcut.json', 'pet.json', 'sync.json'] as const;
/** The added categories, and the screens' own storage (theme, opened subtask trees). */
export const importedFolders = ['categories', 'Local Storage'] as const;

/** A Windows command line split into its arguments, without the quotes. Enough for paths, which cannot contain quotes. */
export function splitCommandLine(command: string): string[] {
  const args: string[] = [];
  let current = '', quoted = false, started = false;
  for (const char of command) {
    if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) args.push(current); current = ''; started = false; }
    else { current += char; started = true; }
  }
  if (started) args.push(current);
  return args;
}

/** The profile folder of the run from source that a start-at-login command starts, or null when the command is not one. */
export function sourceProfileFrom(command: string | null, ownExecutable: string): string | null {
  const [executable, ...args] = splitCommandLine(command ?? '');
  if (!executable || same(executable, ownExecutable)) return null;
  const script = args.find(arg => !arg.startsWith('--'));
  if (!script || !path.win32.isAbsolute(script) || path.win32.basename(script).toLowerCase() !== 'main.cjs') return null;
  const profile = args.find(arg => arg.startsWith('--task-profile='))?.slice('--task-profile='.length);
  if (profile && path.win32.isAbsolute(profile)) return path.win32.normalize(profile);
  // Without the switch the profile is the default of a run from source: .local\desktop in the project (see main.ts).
  return path.win32.join(path.win32.dirname(script), '..', '..', '.local', 'desktop');
}

export interface StartupEntry { command: string | null; enabled: boolean }
/** Runs a program and gives back what it printed. */
export type RunProgram = (file: string, args: string[]) => Promise<string>;
/**
 * This app's start-at-login entry as Windows holds it: the command in HKCU\...\Run, and whether it is switched on (switching it off in
 * Windows settings or Task Manager is kept in StartupApproved\Run, whose first byte is 3 when off). PowerShell prints it as UTF-8 so a
 * path with Korean or other letters arrives intact.
 */
export async function readStartupEntry(run: RunProgram): Promise<StartupEntry> {
  const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion';
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$command = (Get-ItemProperty -LiteralPath '${key}\\Run' -Name '${loginItemName}' -ErrorAction SilentlyContinue).'${loginItemName}'`,
    `$approved = (Get-ItemProperty -LiteralPath '${key}\\Explorer\\StartupApproved\\Run' -Name '${loginItemName}' -ErrorAction SilentlyContinue).'${loginItemName}'`,
    '@{ command = $command; enabled = -not ($approved -and $approved[0] -eq 3) } | ConvertTo-Json -Compress',
  ].join('; ');
  const parsed: unknown = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]));
  const value = parsed && typeof parsed === 'object' ? parsed as { command?: unknown; enabled?: unknown } : {};
  return { command: typeof value.command === 'string' ? value.command : null, enabled: value.enabled !== false };
}

const exists = (file: string) => stat(file).then(() => true, () => false);

/**
 * Copies the settings from `from` into `to` when `to` has no vault chosen yet and `from` has one. A file or folder that cannot be copied
 * (the other app may be running and holding it) is skipped; a folder is copied whole or not at all. Returns whether the vault came over.
 */
export async function importProfile(from: string, to: string): Promise<boolean> {
  if (await exists(path.join(to, 'vault.json')) || !await exists(path.join(from, 'vault.json'))) return false;
  for (const name of importedFiles) {
    if (await exists(path.join(from, name))) await cp(path.join(from, name), path.join(to, name), { force: false, errorOnExist: false }).catch(() => {});
  }
  for (const name of importedFolders) {
    const source = path.join(from, name), target = path.join(to, name), partial = target + '.importing';
    if (!await exists(source) || await exists(target)) continue;
    try { await cp(source, partial, { recursive: true }); await rename(partial, target); }
    catch { await rm(partial, { recursive: true, force: true }).catch(() => {}); }
  }
  return exists(path.join(to, 'vault.json'));
}
