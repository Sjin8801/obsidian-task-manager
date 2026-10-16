import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLanguagePreference, resolveLocale, type LanguagePreference, type Locale } from './i18n/index.ts';

/**
 * Which language the person chose, kept in the app's profile (the main process needs it too: the tray, the menus and the
 * notifications are drawn here, not by the screens). Until they choose, the language follows the system.
 */
export class LanguageStore {
  preference: LanguagePreference = 'auto';
  constructor(private file: string, private systemLocale: () => string) {}
  async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      this.preference = parseLanguagePreference(data && typeof data === 'object' ? (data as { language?: unknown }).language : undefined);
    } catch { /* No file yet, or one that cannot be read: follow the system. */ }
  }
  get locale(): Locale { return resolveLocale(this.preference, this.systemLocale()); }
  async save(value: unknown) {
    const next = parseLanguagePreference(value);
    if (value !== next) throw new Error('INVALID_REQUEST');
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', JSON.stringify({ language: next }) + '\n', { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
    this.preference = next;
  }
}
