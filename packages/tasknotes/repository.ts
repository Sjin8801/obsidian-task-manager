import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { isTaskNote, parseTask, revisionOf, TaskDataError, validatePath } from './task.ts';
import type { TaskRecord } from '../contracts/task.ts';
import type { StatusOption } from '../contracts/statuses.ts';
import type { FieldNames, RelationFieldNames } from '../contracts/fields.ts';
import type { TaskIdentification } from '../contracts/identification.ts';
import { ApiError } from './errors.ts';

export interface ReadIssue { path: string; code: string }
export interface Snapshot { tasks: TaskRecord[]; issues: ReadIssue[]; revision: string }
export class TaskRepository {
  constructor(private root: string, private options: { vault?: boolean; statuses?: readonly StatusOption[]; fields?: FieldNames; relations?: RelationFieldNames; identification?: TaskIdentification } = {}) { this.root = path.resolve(root); }
  async snapshot(): Promise<Snapshot> {
    const tasks: TaskRecord[] = [], issues: ReadIssue[] = [];
    let entriesRead = 0, totalBytes = 0;
    try {
      if ((await lstat(this.root)).isSymbolicLink()) throw new Error('root link');
      const canonicalRoot = await realpath(this.root);
      const inside = (p: string) => { const r = path.relative(canonicalRoot, p); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > 16) throw new ApiError('STORAGE_UNAVAILABLE', 503);
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (this.options.vault && (item.name.startsWith('.') || item.name === 'node_modules')) continue;
          if (++entriesRead > (this.options.vault ? 25000 : 3000)) throw new ApiError('SCAN_LIMIT_EXCEEDED', 503);
          const filename = path.join(directory, item.name);
          const relative = path.relative(this.root, filename).split(path.sep).join('/');
          if (item.isSymbolicLink()) { issues.push({ path: relative, code: 'LINK_NOT_ALLOWED' }); continue; }
          if (item.isDirectory()) {
            if (!(await lstat(filename)).isSymbolicLink() && inside(await realpath(filename))) await walk(filename, depth + 1);
            else issues.push({ path: relative, code: 'LINK_NOT_ALLOWED' });
            continue;
          }
          if (!item.name.endsWith('.md')) continue;
          try {
            validatePath(relative);
            const stat = await lstat(filename);
            if (!stat.isFile() || stat.isSymbolicLink() || !inside(await realpath(filename))) throw new TaskDataError('LINK_NOT_ALLOWED');
            if (stat.size > 1_048_576) throw new TaskDataError('FILE_TOO_LARGE');
            const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
              const before = await handle.stat();
              if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) throw new TaskDataError('EXTERNAL_CHANGE');
              const buffer = Buffer.alloc(1_048_577);
              let count = 0;
              while (count < buffer.length) {
                const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
                if (!bytesRead) break;
                count += bytesRead;
              }
              if (count > 1_048_576) throw new TaskDataError('FILE_TOO_LARGE');
              totalBytes += count;
              if (totalBytes > (this.options.vault ? 134_217_728 : 16_777_216)) throw new ApiError('SCAN_LIMIT_EXCEEDED', 503);
              const after = await handle.stat();
              if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new TaskDataError('EXTERNAL_CHANGE');
              let raw: string;
              try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, count)); }
              catch { throw new TaskDataError('INVALID_UTF8'); }
              if (!this.options.vault || isTaskNote(raw, this.options.identification)) tasks.push(parseTask(relative, raw, this.options.statuses, this.options.fields, this.options.relations, this.options.identification));
            } finally { await handle.close(); }
          } catch (error) {
            if (error instanceof ApiError) throw error;
            issues.push({ path: relative, code: error instanceof TaskDataError ? error.code : 'READ_FAILED' });
          }
        }
      };
      await walk(this.root, 0);
    } catch (error) {
      if (this.options.vault && error instanceof ApiError) throw error;
      throw new ApiError('STORAGE_UNAVAILABLE', 503);
    }
    tasks.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    issues.sort((a, b) => a.path.localeCompare(b.path));
    return { tasks, issues, revision: revisionOf(JSON.stringify([tasks.map(t => [t.id, t.revision]), issues])) };
  }
}
