import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { taskRoot, VaultError } from './local-vault.ts';
import { replaceFile } from './replace-file.ts';
import { defaultCategories, categoryOf, categoryTags } from './categories.ts';
import { readTaskNotesSettings } from './status-config.ts';
import { findStatus } from '../../packages/contracts/statuses.ts';
import { isSavableDate } from '../../packages/contracts/dates.ts';
import type { SaveTaskInput, VaultSelection } from './shared.ts';
import { parseTask, previewCategoryPatch, previewTaskPatch, replaceTaskBody, revisionOf, localDate, TaskDataError, validatePath } from '../../packages/tasknotes/task.ts';

async function target(selection: VaultSelection, relative: string) {
  validatePath(relative);
  let current = await taskRoot(selection);
  for (const part of relative.split('/')) {
    if (part.startsWith('.') || part === 'node_modules') throw new VaultError('INVALID_PATH');
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink() || await realpath(current) !== current) throw new VaultError('VAULT_LINK_NOT_ALLOWED');
  }
  return current;
}
export async function readNote(selection: VaultSelection, relative: string) {
  const file = await target(selection, relative);
  const before = await lstat(file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || stat.ino !== before.ino || stat.dev !== before.dev) throw new VaultError('UNSAFE_FILE');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) { const result = await handle.read(bytes, size, bytes.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    const after = await handle.stat();
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new VaultError('REVISION_CONFLICT');
    // Keep the BOM in the decoded source so it survives a save.
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
    return { file, raw, mode: stat.mode };
  } finally { await handle.close(); }
}

type NoteSource = Awaited<ReturnType<typeof readNote>>;
/**
 * Puts `updated` in place of the note that was read as `source`: the old text is kept in `backupRoot` first, the new text is written next
 * to the note and swapped in, and the swap is refused if the note changed since `revision`. Returns the text as it is on disk afterwards,
 * which must be the text that was expected (`expectedRevision`).
 */
export async function writeNote(selection: VaultSelection, relative: string, source: NoteSource, revision: string, updated: string, expectedRevision: string, backupRoot: string, now: Date, replace: typeof replaceFile = replaceFile): Promise<string> {
    const id = randomUUID();
    await mkdir(backupRoot, { recursive: true });
    await writeFile(path.join(backupRoot, id + '.md'), source.raw, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(backupRoot, id + '.json'), JSON.stringify({ selection, path: relative, revision, savedAt: now.toISOString() }), { flag: 'wx', mode: 0o600 });
    const temporary = path.join(path.dirname(source.file), '.task-manager-' + id + '.tmp');
    try {
      const handle = await open(temporary, 'wx', source.mode & 0o777);
      try { await handle.writeFile(updated, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      const latest = await readNote(selection, relative);
      if (latest.file !== source.file || revisionOf(latest.raw) !== revision) throw new VaultError('REVISION_CONFLICT');
      // Windows refuses to replace a note while another program (Obsidian, sync, antivirus) has it open; that clears in moments.
      await replace(temporary, source.file);
      const saved = await readNote(selection, relative);
      if (revisionOf(saved.raw) !== expectedRevision) throw new VaultError('SAVE_VERIFICATION_FAILED');
      return saved.raw;
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Backups are outside the vault. Reject stale revisions before replacing a note. */
export async function saveTask(selection: VaultSelection, input: SaveTaskInput, backupRoot: string, now = new Date(), categories: readonly string[] = defaultCategories, replace: typeof replaceFile = replaceFile) {
  try {
    if (!input || !input.selection || input.selection.vaultPath !== selection.vaultPath || input.selection.taskRelativePath !== selection.taskRelativePath) throw new VaultError('VAULT_CHANGED');
    if (typeof input.path !== 'string' || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || !input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) throw new VaultError('INVALID_REQUEST');
    const changes = input.changes, keys = Object.keys(changes);
    if (!keys.length || keys.some(k => !['category', 'status', 'priority', 'scheduled', 'due', 'body'].includes(k))) throw new VaultError('INVALID_REQUEST');
    // The allowed statuses are the ones set up in TaskNotes now, not the ones the window was showing when it was opened.
    const { statuses, fields, relations, identification } = await readTaskNotesSettings(selection.vaultPath);
    if ('status' in changes && !statuses.some(s => s.value === changes.status)) throw new VaultError('INVALID_REQUEST');
    if ('priority' in changes && !['none', 'low', 'normal', 'high'].includes(changes.priority!)) throw new VaultError('INVALID_REQUEST');
    for (const key of ['scheduled', 'due'] as const) if (key in changes && changes[key] !== null && (typeof changes[key] !== 'string' || !isSavableDate(changes[key]!))) throw new VaultError('INVALID_DATE');
    if ('body' in changes && (typeof changes.body !== 'string' || Buffer.byteLength(changes.body) > 512 * 1024 || changes.body.includes('\0'))) throw new VaultError('INVALID_REQUEST');
    if ('category' in changes && (typeof changes.category !== 'string' || !categories.includes(changes.category))) throw new VaultError('INVALID_CATEGORY');
    const source = await readNote(selection, input.path);
    if (revisionOf(source.raw) !== input.revision) throw new VaultError('REVISION_CONFLICT');
    const task = parseTask(input.path, source.raw, statuses, fields, relations, identification);
    if (task.recurring) throw new VaultError('RECURRING_READ_ONLY');
    const patch: Record<string, string | null> = {};
    if (changes.status !== undefined && changes.status !== (findStatus(task.rawStatus, statuses)?.value ?? task.rawStatus)) {
      patch.status = changes.status;
      const finishing = statuses.find(s => s.value === changes.status)!.completed;
      // Moving between two finished statuses keeps the date the task was finished on.
      if (finishing && task.status !== 'done') patch.completedDate = localDate(now);
      else if (!finishing && task.status === 'done') patch.completedDate = null;
    }
    if (changes.priority !== undefined && changes.priority !== task.rawPriority) patch.priority = changes.priority;
    if ('scheduled' in changes && changes.scheduled !== task.scheduled) patch.scheduled = changes.scheduled!;
    if ('due' in changes && changes.due !== task.due) patch.due = changes.due!;
    const categoryChanged = changes.category !== undefined && (categoryOf(task, categories) !== changes.category || !task.tags.includes(changes.category) || task.tags.filter(t => categoryTags(categories).includes(t)).length !== 1);
    if (!categoryChanged && !Object.keys(patch).length && (changes.body === undefined || changes.body === task.body)) return task;
    // TaskNotes' form for a moment in time: UTC to the second, with no fractions (2026-09-30T02:00:00Z).
    patch.dateModified = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    let updated = previewTaskPatch(source.raw, input.revision, patch, fields);
    if (categoryChanged) updated = previewCategoryPatch(updated, revisionOf(updated), categoryTags(categories), changes.category!);
    if (changes.body !== undefined && changes.body !== task.body) updated = replaceTaskBody(updated, changes.body.replace(/\r?\n/g, source.raw.includes('\r\n') ? '\r\n' : '\n'));
    if (Buffer.byteLength(updated) > 1024 * 1024) throw new VaultError('UNSAFE_FILE');
    const expected = parseTask(input.path, updated, statuses, fields, relations, identification);
    const saved = await writeNote(selection, input.path, source, input.revision, updated, expected.revision, backupRoot, now, replace);
    return parseTask(input.path, saved, statuses, fields, relations, identification);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    if (error instanceof TaskDataError) throw new VaultError(error.code);
    throw new VaultError('SAVE_FAILED');
  }
}
