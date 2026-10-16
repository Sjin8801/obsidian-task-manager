import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFile } from './replace-file.ts';

// Remembers whether "Headless 동기화 실행" is on. It is off until the user turns it on.
export class SyncSettings {
  enabled = false;
  constructor(private file: string) {}
  async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      this.enabled = !!data && typeof data === 'object' && 'headlessSync' in data && data.headlessSync === true;
    } catch { this.enabled = false; }
  }
  async save(value: boolean) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', JSON.stringify({ headlessSync: value }) + '\n', { mode: 0o600 });
    await replaceFile(this.file + '.tmp', this.file);
    this.enabled = value;
  }
}
