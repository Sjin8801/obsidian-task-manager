import path from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { defaultStatuses, parseStatusSettings, type StatusOption } from '../../packages/contracts/statuses.ts';
import { parseTasksFolder } from '../../packages/contracts/folder.ts';
import { defaultIdentification, parseIdentification, type TaskIdentification } from '../../packages/contracts/identification.ts';
import { defaultFieldNames, defaultRelationFieldNames, parseFieldMapping, parseRelationFields, type FieldNames, type RelationFieldNames } from '../../packages/contracts/fields.ts';

/** Where the TaskNotes plugin keeps its settings, relative to the vault. */
export const statusSettingsFile = '.obsidian/plugins/tasknotes/data.json';
/** `tasksFolder` is where the settings say tasks live, or null. */
export interface TaskNotesSettings { statuses: StatusOption[]; fields: FieldNames; relations: RelationFieldNames; identification: TaskIdentification; tasksFolder: string | null }

/**
 * What the app takes from the TaskNotes settings: the status list, the property name each field is stored under, how a task is
 * recognised and the task folder. The file
 * belongs to another plugin, so anything unexpected (missing, unreadable, a link pointing elsewhere, too big, not JSON, nothing
 * usable in it) quietly means TaskNotes' own defaults: the built-in four statuses and the usual property names.
 */
export async function readTaskNotesSettings(vaultPath: string): Promise<TaskNotesSettings> {
  const fallback = (): TaskNotesSettings => ({ statuses: [...defaultStatuses], fields: { ...defaultFieldNames }, relations: { ...defaultRelationFieldNames }, identification: defaultIdentification, tasksFolder: null });
  try {
    const file = path.join(vaultPath, ...statusSettingsFile.split('/'));
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return fallback();
    const root = await realpath(vaultPath), real = await realpath(file);
    if (path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real))) return fallback();
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const data: unknown = JSON.parse(await handle.readFile('utf8'));
      return { statuses: parseStatusSettings(data) ?? [...defaultStatuses], fields: parseFieldMapping(data), relations: parseRelationFields(data), identification: parseIdentification(data), tasksFolder: parseTasksFolder(data) };
    } finally { await handle.close(); }
  } catch { return fallback(); }
}
export async function readStatuses(vaultPath: string): Promise<StatusOption[]> { return (await readTaskNotesSettings(vaultPath)).statuses; }
