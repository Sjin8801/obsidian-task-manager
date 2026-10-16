import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { revisionOf } from '../../packages/tasknotes/task.ts';
import { builtInKind, defaultCategoriesFor, validCategory } from './categories.ts';
import type { Locale } from './i18n/index.ts';

export class CategoryStore {
  constructor(private directory: string) {}
  private file(vaultPath: string) { return path.join(this.directory, revisionOf(vaultPath) + '.json'); }
  /** The two built-in categories, in the language's names, then the ones added for this vault. */
  async load(vaultPath: string, locale: Locale = 'ko'): Promise<string[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file(vaultPath), 'utf8'));
      if (!Array.isArray(value) || !value.every(validCategory) || value.length > 32) throw new Error('Invalid categories');
      return [...new Set([...defaultCategoriesFor(locale), ...value.filter(category => !builtInKind(category))])];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultCategoriesFor(locale); throw error; }
  }
  async add(vaultPath: string, category: string, locale: Locale = 'ko'): Promise<string[]> {
    if (!validCategory(category)) throw new Error('Invalid category');
    const categories = await this.load(vaultPath, locale);
    if (categories.includes(category) || builtInKind(category)) return categories;
    if (categories.length >= 32) throw new Error('Category limit');
    categories.push(category);
    await mkdir(this.directory, { recursive: true });
    const file = this.file(vaultPath);
    // Only the added ones are kept; the built-in two come from the language.
    await writeFile(file + '.tmp', JSON.stringify(categories.filter(name => !builtInKind(name))), { mode: 0o600 });
    await rename(file + '.tmp', file);
    return categories;
  }
}
