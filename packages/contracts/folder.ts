/** Where TaskNotes puts new tasks when its settings say nothing else. */
export const defaultTasksFolder = 'TaskNotes/Tasks';

/**
 * The folder for tasks from the TaskNotes settings (its parsed data.json, "tasksFolder"), as a path inside the vault written with "/".
 * Returns null when there is none, or it is not a plain folder inside the vault (an absolute path, "..", a hidden folder, a name with
 * {{template}} parts), so the caller falls back to the usual folder.
 */
export function parseTasksFolder(data: unknown): string | null {
  const value = data && typeof data === 'object' ? (data as { tasksFolder?: unknown }).tasksFolder : undefined;
  if (typeof value !== 'string') return null;
  const parts = value.trim().replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.');
  if (!parts.length || value.length > 240 || /^(?:\/|\\|[A-Za-z]:)/.test(value.trim())) return null;
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules' || /[\u0000-\u001f<>:"|?*{}]/.test(part) || /[. ]$/.test(part))) return null;
  return parts.join('/');
}
