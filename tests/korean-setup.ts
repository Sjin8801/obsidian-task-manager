import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The TaskNotes settings of a Korean setup: Korean property names and Korean status values. A test that is about such a setup
 * (rather than about TaskNotes' own defaults) writes this into its vault first, the same way a person would set it in TaskNotes.
 */
export async function koreanSetup(vaultRoot: string): Promise<void> {
  const directory = path.join(vaultRoot, '.obsidian', 'plugins', 'tasknotes');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'data.json'), JSON.stringify({
    fieldMapping: { status: '상태', priority: '우선순위', scheduled: '예정일', due: '마감일', completedDate: '완료일', dateModified: '수정일' },
    customStatuses: [
      { id: 'none', value: '없음', label: '없음', color: '#cccccc', isCompleted: false, order: 0 },
      { id: 'open', value: '시작', label: '시작', color: '#808080', isCompleted: false, order: 1 },
      { id: 'in-progress', value: '진행 중', label: '진행 중', color: '#0066cc', isCompleted: false, order: 2 },
      { id: 'done', value: '완료', label: '완료', color: '#00aa00', isCompleted: true, order: 3 },
    ],
  }));
}
