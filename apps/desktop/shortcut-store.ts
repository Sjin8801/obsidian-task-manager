import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultShortcut, validShortcut } from './shortcut.ts';
import { VaultError } from './local-vault.ts';
interface Registrar { register(key: string, callback: () => void): boolean; unregister(key: string): void }
export class ShortcutStore {
  shortcut = defaultShortcut;
  registered = false;
  error: string | null = null;
  private busy = false;
  constructor(private file: string, private registrar: Registrar, private toggle: () => void) {}
  private register(key: string) { try { return this.registrar.register(key, this.toggle); } catch { return false; } }
  async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || !('shortcut' in data) || !validShortcut(data.shortcut)) throw new Error('Invalid shortcut');
      this.shortcut = data.shortcut;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = 'SHORTCUT_LOAD_FAILED';
    }
    this.registered = this.register(this.shortcut);
  }
  async save(value: unknown) {
    if (!validShortcut(value)) throw new VaultError('INVALID_SHORTCUT');
    if (this.busy) throw new VaultError('SHORTCUT_BUSY');
    this.busy = true;
    const alreadyRegistered = value === this.shortcut && this.registered;
    try {
      // Keep the previous binding until both registration and persistence succeed.
      if (!alreadyRegistered && !this.register(value)) throw new VaultError('SHORTCUT_UNAVAILABLE');
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file + '.tmp', JSON.stringify({ shortcut: value }) + '\n', { mode: 0o600 });
        await rename(this.file + '.tmp', this.file);
      } catch {
        if (!alreadyRegistered) this.registrar.unregister(value);
        throw new VaultError('SHORTCUT_SAVE_FAILED');
      }
      if (this.registered && value !== this.shortcut) this.registrar.unregister(this.shortcut);
      this.shortcut = value; this.registered = true; this.error = null;
    } finally { this.busy = false; }
  }
}
