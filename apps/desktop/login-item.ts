import path from 'node:path';

// Windows "start at login" entry for this app. Electron writes it to HKCU\...\Run and reads it back as `launchItems`.
// Two things about that round trip are easy to get wrong (both were bugs here):
//  - Electron already quotes and escapes arguments, so paths must be passed without quotes of our own. A quoted path is stored as \"path\",
//    and at login Windows hands the app a path with literal quote characters, which does not exist, so the app never starts.
//  - Electron reports command-line switches (--task-autostart, --task-profile=...) separately from `args` and then answers
//    `openAtLogin: false` for any options that contain a switch. `launchItems` is the only reliable thing to read.
export const loginItemName = 'Obsidian Task Manager';
export interface LoginItem { name: string; path: string; args: string[]; enabled: boolean }
export interface LoginExpectation { path: string; args: string[] }
// off: nothing registered or switched off in Windows. active: registered correctly. legacy: registered by an older version with quoted
// arguments (the app cannot start from it). other: an entry with this name that points somewhere else; left alone.
export type LoginItemState = 'off' | 'active' | 'legacy' | 'other';

export const same = (a: string, b: string) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const strip = (arg: string) => arg.replaceAll('"', '');
const positional = (args: string[]) => args.map(strip).filter(arg => !arg.startsWith('--'));

export function loginItemState(items: LoginItem[] | undefined, expected: LoginExpectation): LoginItemState {
  const item = (items ?? []).find(candidate => candidate.name === loginItemName);
  if (!item || !item.enabled) return 'off';
  if (!same(item.path, expected.path)) return 'other';
  const want = positional(expected.args), got = positional(item.args);
  if (got.length !== want.length || !got.every((arg, index) => same(arg, want[index]!))) return 'other';
  return item.args.some(arg => arg.includes('"')) ? 'legacy' : 'active';
}

// Windows' rules for a command line: quotes group, and \" is a literal quote (which is how the old code's broken entry shows up).
export function windowsArguments(command: string): string[] {
  const args: string[] = [];
  let current = '', quoted = false, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && command[i + 1] === '"') { current += '"'; i++; started = true; }
    else if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) args.push(current); current = ''; started = false; }
    else { current += char; started = true; }
  }
  if (started) args.push(current);
  return args;
}

// Electron's getLoginItemSettings lists nothing for an executable whose file name has a space ("Obsidian Task Manager.exe"), even right
// after it wrote the entry itself, so the installed app could never see its own entry. The entry is read from the registry instead
// (readStartupEntry in import-profile.ts) and shaped like the items Electron would have listed.
export interface StartupEntryLike { command: string | null; enabled: boolean }
export function loginItemsFromEntry(entry: StartupEntryLike): LoginItem[] {
  const [path, ...args] = windowsArguments(entry.command ?? '');
  return path ? [{ name: loginItemName, path, args, enabled: entry.enabled }] : [];
}

export interface LoginItemApi {
  get(): LoginItem[] | undefined;
  set(options: { path: string; args: string[]; name: string; openAtLogin: boolean; enabled: boolean }): void;
}
// Rewrites an entry an older version registered in the broken quoted format, keeping it on. Anything else, including an entry the user
// switched off in Windows, is left alone. Returns whether it repaired something.
export function repairLegacyLoginItem(api: LoginItemApi, expected: LoginExpectation): boolean {
  if (loginItemState(api.get(), expected) !== 'legacy') return false;
  api.set({ path: expected.path, args: expected.args, name: loginItemName, openAtLogin: true, enabled: true });
  return loginItemState(api.get(), expected) === 'active';
}
