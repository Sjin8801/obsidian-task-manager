import React from 'react';
import { customStatusColor, findStatus, statusName } from '../../../packages/contracts/statuses.ts';
import { statusKey } from '../../../packages/contracts/task.ts';
import type { StatusOption } from '../shared.ts';
import type { Translate } from '../i18n/index.ts';

const statusStyles = new Map([['none', 'none'], ['open', 'started'], ['in-progress', 'progress'], ['done', 'done']]);

// The four built-in statuses keep their own dot styles; a status added in TaskNotes is drawn in the colour set there.
export function statusDot(rawStatus: string | null, statuses: readonly StatusOption[], t: Translate) {
  const known = findStatus(rawStatus, statuses), label = statusName(rawStatus, statuses), color = customStatusColor(rawStatus, statuses);
  return <span className={'state-dot ' + (color ? 'custom' : statusStyles.get(statusKey(known?.value ?? rawStatus) ?? '') ?? 'unknown') + (color && known?.completed ? ' finished' : '')} style={color ? { borderColor: color, background: color } : undefined} title={label ?? t('상태 확인')} aria-hidden="true">{known?.completed ? '✓' : ''}</span>;
}
