import path from 'node:path';
import { cp, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
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
 * One value of a `reg export` file: a REG_SZ as its text, a REG_BINARY as its bytes, null when the value is missing or of another type.
 * Strings escape \ and " with a backslash; binary is `hex:xx,xx,...`, wrapped onto more lines with a trailing `,\`.
 */
export function regFileValue(file: string, name: string): string | number[] | null {
  const prefix = `"${name.replace(/[\\"]/g, '\\$&')}"=`;
  const line = file.replace(/,\\\r?\n\s*/g, ',').split(/\r?\n/).find(candidate => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length) ?? '';
  const text = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
  if (text) return text[1]!.replace(/\\(.)/g, '$1');
  const binary = /^hex:([0-9a-f]{2}(?:,[0-9a-f]{2})*)?$/i.exec(value);
  return binary ? (binary[1]?.split(',') ?? []).map(byte => parseInt(byte, 16)) : null;
}

/**
 * This app's start-at-login entry as Windows holds it: the command in HKCU\...\Run, and whether it is switched on (switching it off in
 * Windows settings or Task Manager is kept in StartupApproved\Run, whose first byte is 3 when off). The keys are read with
 * `reg export`, whose file is always UTF-16, so a path with Korean or other letters arrives intact; `reg query` prints in the console's
 * code page, and PowerShell with -ExecutionPolicy Bypass is what antivirus software flags. A missing StartupApproved\Run means on.
 */
export async function readStartupEntry(run: RunProgram): Promise<StartupEntry> {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion', dir = await mkdtemp(path.join(os.tmpdir(), 'task-startup-'));
  const exported = async (subkey: string, name: string) => {
    const file = path.join(dir, name);
    await run('reg.exe', ['export', `${key}\\${subkey}`, file, '/y']);
    return (await readFile(file)).toString('utf16le');
  };
  try {
    const command = regFileValue(await exported('Run', 'run.reg'), loginItemName);
    const approved = regFileValue(await exported('Explorer\\StartupApproved\\Run', 'approved.reg').catch(() => ''), loginItemName);
    return { command: typeof command === 'string' ? command : null, enabled: !(Array.isArray(approved) && approved[0] === 3) };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
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
