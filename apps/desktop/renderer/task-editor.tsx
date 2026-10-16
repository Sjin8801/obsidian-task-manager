import React, { useEffect, useImperativeHandle, useState } from 'react';
import { findStatus } from '../../../packages/contracts/statuses.ts';
import type { StatusOption, TaskEdits, TaskRecord } from '../shared.ts';
import { composeDate, normalizeDate, localClock } from '../../../packages/contracts/dates.ts';
import { joinBody, splitBody } from './body-text.ts';
import { useI18n } from './i18n.tsx';

export interface TaskEditorHandle { back(): void }

// A date to pick, with a switch that adds a time when the task needs one (a note stores 2026-09-30, or 2026-09-30T09:00).
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const clock = localClock(value);
  // Something that is not a date is shown as typed, so it can be corrected or cleared.
  if (value && !clock) return <div className="date-field"><label>{label}<input aria-label={label} type="text" value={value} placeholder="YYYY-MM-DD" onChange={e => onChange(e.target.value)}/></label><div className="date-options"><button type="button" className="date-clear" onClick={() => onChange('')}>{t('날짜 지우기')}</button></div></div>;
  const date = clock?.date ?? '', time = clock?.time ?? null;
  return <div className="date-field">
    <span className="date-field-name">{label}</span>
    <div className="date-inputs">
      <input aria-label={label} type="date" value={date} onChange={e => onChange(composeDate(e.target.value, time))}/>
      {time !== null && <input aria-label={t('{label} 시간', { label })} type="time" value={time} onChange={e => onChange(composeDate(date, e.target.value || null))}/>}
    </div>
    <div className="date-options">
      <label className="date-time-toggle"><input type="checkbox" aria-label={t('{label} 시간 포함', { label })} checked={time !== null} disabled={!date} onChange={e => onChange(composeDate(date, e.target.checked ? '09:00' : null))}/>{t('시간 포함')}</label>
      {value && <button type="button" className="date-clear" onClick={() => onChange('')}>{t('날짜 지우기')}</button>}
    </div>
  </div>;
}

export function TaskEditor({ task, statuses, saving, error, onSave, onClose, backRef }: {
  backRef: React.Ref<TaskEditorHandle>; statuses: readonly StatusOption[];
  task: TaskRecord; saving: boolean; error: string | null;
  onSave: (changes: TaskEdits) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  // The blank line after the properties is hidden while editing and restored on save (see body-text.ts).
  const { lead, text } = splitBody(task.body.replace(/\r\n/g, '\n'));
  const initial = { status: findStatus(task.rawStatus, statuses)?.value ?? task.rawStatus ?? '', priority: task.rawPriority ?? '', scheduled: task.scheduled ?? '', due: task.due ?? '', body: text };
  const [draft, setDraft] = useState(initial), [discard, setDiscard] = useState(false);
  // Dates are compared by the day and time they mean, so a note holding 2026-09-13T18:00:00+09:00 is not changed just by opening it.
  const same = (a: string, b: string) => normalizeDate(a) === normalizeDate(b);
  const dirty = draft.status !== initial.status || draft.priority !== initial.priority || draft.body !== initial.body || !same(draft.scheduled, initial.scheduled) || !same(draft.due, initial.due);
  function close() {
    if (saving) return;
    if (discard) setDiscard(false);
    else if (dirty) setDiscard(true);
    else onClose();
  }
  useImperativeHandle(backRef, () => ({ back: close }));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) close(); }
      // Keep application shortcuts from changing the view while a draft is open.
      if ((e.ctrlKey || e.metaKey) && ['k', 'f', 'r', '1', '2', '3'].includes(e.key.toLowerCase())) e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  });
  function save(e: React.FormEvent) {
    e.preventDefault();
    const changes: TaskEdits = {};
    for (const key of ['status', 'priority'] as const) if (draft[key] !== initial[key]) changes[key] = draft[key];
    if (draft.body !== initial.body) changes.body = joinBody(lead, draft.body);
    for (const key of ['scheduled', 'due'] as const) if (!same(draft[key], initial[key])) changes[key] = normalizeDate(draft[key]) || null;
    onSave(changes);
  }
  // Save and its messages stay pinned at the top so they are visible without scrolling.
  return <main className="detail editor" aria-label={t('작업 편집')}>
    <div className="editor-bar">
      <div className="editor-bar-row">
        <button className="text-button" onClick={() => close()} disabled={saving}>{t('← 뒤로')}</button>
        <div className="editor-buttons"><button type="button" className="secondary" onClick={() => close()} disabled={saving}>{t('취소')}</button><button type="submit" form="task-editor-form" className="primary" disabled={saving || !dirty || task.recurring}>{saving ? t('저장 중…') : t('저장')}</button></div>
      </div>
      {task.recurring && <div className="notice">{t('반복 작업은 Obsidian에서 수정해 주세요.')}</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {discard ? <div className="notice" role="alert">{t('저장하지 않은 변경 내용을 버릴까요?')}<div className="editor-buttons"><button type="button" className="secondary" onClick={() => setDiscard(false)}>{t('계속 편집')}</button><button type="button" className="secondary" onClick={onClose}>{t('변경 내용 버리기')}</button></div></div> : null}
    </div>
    <h2>{task.title}</h2><p className="hint">{t('제목과 노트 링크는 유지돼요.')}</p>
    <form id="task-editor-form" onSubmit={save}>
      <fieldset disabled={saving || task.recurring}>
        <div className="form-row"><label>{t('상태')}<select aria-label={t('상태')} autoFocus value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}>
          {!statuses.some(s => s.value === initial.status) && <option value={initial.status}>{initial.status || t('없음 (속성 없음)')}</option>}
          {statuses.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select></label><label>{t('우선순위')}<select aria-label={t('우선순위')} value={draft.priority} onChange={e => setDraft({ ...draft, priority: e.target.value })}>
          {!['none', 'low', 'normal', 'high'].includes(initial.priority) && <option value={initial.priority}>{initial.priority || t('없음 (속성 없음)')}</option>}
          {Object.entries({ none: t('없음'), low: t('낮음'), normal: t('보통'), high: t('높음') }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label></div>
        <div className="form-row">{(['scheduled', 'due'] as const).map(key => <DateField key={key} label={key === 'scheduled' ? t('예정일') : t('마감일')} value={draft[key]} onChange={value => setDraft({ ...draft, [key]: value })}/>)}</div>
        <label>{t('상세 내용')}<textarea aria-label={t('상세 내용')} rows={8} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })}/></label>
      </fieldset>
    </form>
  </main>;
}
