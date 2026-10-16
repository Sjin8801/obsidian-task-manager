import { watch, type FSWatcher } from 'node:fs';
import { taskRoot } from './local-vault.ts';
import { statusSettingsFile } from './status-config.ts';
import type { VaultSelection } from './shared.ts';

// `folder` is the task folder relative to the vault root, with forward slashes and no trailing slash.
// Windows also sends metadata-only `change` events for the task folder and its ancestors at arbitrary
// times, even when nothing was written. Real edits arrive as events below the folder, and replacing,
// deleting or renaming the folder or an ancestor arrives as `rename`, so only `rename` counts there.
export function isRelevantChange(folder: string, event: string, filename: string | null): boolean {
  if (!filename) return true;
  const relative = filename.replaceAll('\\', '/');
  // The TaskNotes settings hold the status list, so a change there refreshes the views even though it is a hidden folder.
  if (relative === statusSettingsFile) return true;
  if (relative.split('/').some(part => part.startsWith('.') || part === 'node_modules')) return false;
  if (folder === '.') return true;
  if (relative === folder || folder.startsWith(relative + '/')) return event === 'rename';
  return relative.startsWith(folder + '/');
}

// Observe directory replacement too. Events only invalidate views; reads still validate paths.
export function watchVault(selection: VaultSelection, changed: () => void): () => void {
  let watcher: FSWatcher | undefined, stopped = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(quiet); clearTimeout(deadline); quiet = deadline = undefined;
    if (!stopped) changed();
  };
  const queue = () => {
    clearTimeout(quiet); quiet = setTimeout(flush, 250);
    deadline ??= setTimeout(flush, 1000);
  };
  const folder = selection.taskRelativePath.replaceAll('\\', '/').replace(/\/$/, '');
  const recover = () => {
    watcher?.close(); watcher = undefined;
    if (stopped || retry) return;
    queue();
    retry = setTimeout(() => { retry = undefined; void start(); }, 5000);
  };
  async function start() {
    try {
      const root = await taskRoot({ ...selection, taskRelativePath: '.' });
      if (stopped) return;
      watcher = watch(root, { recursive: true }, (event, filename) => {
        if (isRelevantChange(folder, event, filename)) queue();
      });
      watcher.on('error', recover);
      queue();
    } catch { recover(); }
  }
  void start();
  return () => {
    stopped = true; watcher?.close();
    clearTimeout(quiet); clearTimeout(deadline); clearTimeout(retry);
  };
}
