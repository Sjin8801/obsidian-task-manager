import { defaultStatuses, type StatusOption } from '../../../packages/contracts/statuses.ts';
import { statusKey, type BuiltInStatus } from '../../../packages/contracts/task.ts';
import { N, type Translate } from './index.ts';

// The names of the four statuses TaskNotes starts with, in the language of the screens.
const builtInNames: Record<BuiltInStatus, string> = { none: N('없음'), open: N('시작'), 'in-progress': N('진행 중'), done: N('완료') };

/**
 * The status list with the names of the four built-in statuses in the language of the screens. Only an entry that is exactly TaskNotes' own
 * (its value and its name) is translated: a status the person renamed, or added, is shown as they wrote it.
 */
export function localizeStatuses(statuses: readonly StatusOption[], t: Translate): StatusOption[] {
  return statuses.map(status => {
    const key = statusKey(status.value), builtIn = defaultStatuses.find(d => d.value === key);
    return key && builtIn && status.value === builtIn.value && status.label === builtIn.label ? { ...status, label: t(builtInNames[key]) } : status;
  });
}
