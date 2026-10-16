import React, { useEffect, useId, useRef, useState } from 'react';
import type { DependencyRef, ProjectRef, TaskRef, TaskRelations } from '../../../packages/contracts/relations.ts';
import { statusName } from '../../../packages/contracts/statuses.ts';
import type { RelationCandidate, RelationKind, RelationOther, StatusOption } from '../shared.ts';
import { statusDot } from './status-dot.tsx';
import { useI18n } from './i18n.tsx';
import { N, type Translate } from '../i18n/index.ts';
import { taskDateParts } from '../../../packages/contracts/dates.ts';

const unresolvedHints = { not_found: N('노트를 찾을 수 없어요'), ambiguous: N('같은 이름의 노트가 여러 개예요'), path_traversal: N('볼트 밖을 가리키고 있어요') } as const;
// What each kind of blocker means. FINISHTOSTART is the usual one and needs no explaining.
const relationKinds: Record<string, string> = {
  STARTTOSTART: N('시작해야 시작할 수 있어요'), FINISHTOFINISH: N('끝나야 끝낼 수 있어요'), STARTTOFINISH: N('시작해야 끝낼 수 있어요'),
};

/** An ISO 8601 duration as people say it: P1D is 1일, PT4H is 4시간. Anything it cannot read is shown as written. */
export function describeGap(gap: string, t: Translate): string {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(gap);
  if (!match || gap === 'P' || gap.endsWith('T')) return gap;
  const [, weeks, days, hours, minutes] = match;
  return [weeks && t('{n}주', { n: weeks }), days && t('{n}일', { n: days }), hours && t('{n}시간', { n: hours }), minutes && t('{n}분', { n: minutes })].filter(Boolean).join(' ');
}

/** The short tags at the end of a list row: project, how far the subtasks are, and whether something blocks it. */
export function RelationChips({ relations, hideSubtasks = false }: { relations: TaskRelations | null | undefined; hideSubtasks?: boolean }) {
  const { t } = useI18n();
  if (!relations) return null;
  // A row that has its own subtask toggle already says how far they are.
  const projects = relations.projects, total = hideSubtasks ? 0 : relations.subtasks.length;
  if (!projects.length && !total && !relations.blocked) return null;
  return <>
    {projects.length > 0 && <span className="rel-chip" title={t('속한 프로젝트: {names}', { names: projects.map(p => p.name).join(', ') })}>{projects[0]!.name}{projects.length > 1 && <span className="rel-more"> +{projects.length - 1}</span>}</span>}
    {total > 0 && <span className="rel-chip" title={t('하위 작업 {done}개 완료, 전체 {total}개', { done: relations.subtasksDone, total })}>{t('하위 {done}/{total}', { done: relations.subtasksDone, total })}</span>}
    {relations.blocked && <span className="rel-chip blocked" title={t('끝나지 않은 작업이 이 작업을 막고 있어요')}>{t('막힘')}</span>}
  </>;
}

function TaskLink({ task, statuses, onOpen }: { task: TaskRef; statuses: readonly StatusOption[]; onOpen: (task: TaskRef) => void }) {
  const { t } = useI18n();
  return <button type="button" className="rel-link" onClick={() => onOpen(task)}>{statusDot(task.rawStatus, statuses, t)}<span className="rel-text">{task.title}</span><span className="rel-note">{statusName(task.rawStatus, statuses) ?? ''}</span></button>;
}

function Project({ project, statuses, onOpen }: { project: ProjectRef; statuses: readonly StatusOption[]; onOpen: (task: TaskRef) => void }) {
  const { t } = useI18n();
  if (project.task) return <div className="rel-row"><TaskLink task={project.task} statuses={statuses} onOpen={onOpen}/><span className="rel-note">{t('상위 작업')}</span></div>;
  return <div className="rel-row"><span className="rel-name" title={project.path ?? undefined}>{project.name}</span>{project.unresolved && <span className="rel-note warn">{t(unresolvedHints[project.unresolved])}</span>}</div>;
}

function Blocker({ blocker, statuses, onOpen }: { blocker: DependencyRef; statuses: readonly StatusOption[]; onOpen: (task: TaskRef) => void }) {
  const { t } = useI18n();
  const kind = relationKinds[blocker.reltype];
  return <div className="rel-row">
    {blocker.task ? <TaskLink task={blocker.task} statuses={statuses} onOpen={onOpen}/> : <span className="rel-name">{blocker.name}</span>}
    <span className={'rel-tag' + (blocker.done ? ' done' : ' open')}>{blocker.done ? t('끝남') : t('아직 안 끝남')}</span>
    {blocker.unresolved && <span className="rel-note warn">{t(unresolvedHints[blocker.unresolved])}</span>}
    {kind && <span className="rel-note">{t(kind)}</span>}
    {blocker.gap && <span className="rel-note">{t('간격 {gap}', { gap: describeGap(blocker.gap, t) })}</span>}
  </div>;
}

const kindTitles: Record<RelationKind, string> = { project: N('속한 프로젝트'), subtask: N('하위 작업'), blockedBy: N('차단 원인'), blocking: N('이 작업이 막고 있는 작업') };
// What the add button says: the thing being added.
const kindAdds: Record<RelationKind, string> = { project: N('프로젝트·상위 작업'), subtask: N('하위 작업'), blockedBy: N('차단 원인'), blocking: N('막고 있는 작업') };
const kindOrder: readonly RelationKind[] = ['project', 'subtask', 'blockedBy', 'blocking'];
const pickerHints: Record<RelationKind, string> = { project: N('이름으로 작업이나 노트를 찾아요'), subtask: N('이 작업에 속하게 할 작업을 이름으로 찾아요'), blockedBy: N('이 작업을 막는 작업을 이름으로 찾아요'), blocking: N('이 작업이 막을 작업을 이름으로 찾아요') };

/** What the detail screen needs to change relationships. Each call answers with null when it worked, or a message to show. */
export interface RelationEditing {
  find(kind: RelationKind, q: string): Promise<RelationCandidate[] | string>;
  change(kind: RelationKind, action: 'add' | 'remove', other: RelationOther): Promise<string | null>;
}

/** A search box with the matching tasks (and, for a project, notes) under it. Chosen by name: nobody has to know which file it is. */
function RelationPicker({ kind, find, statuses, onPick, onClose }: { kind: RelationKind; find: RelationEditing['find']; statuses: readonly StatusOption[]; onPick: (candidate: RelationCandidate) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState(''), [items, setItems] = useState<RelationCandidate[] | null>(null), [active, setActive] = useState(0), [problem, setProblem] = useState('');
  const list = useId(), input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      void find(kind, q).then(found => {
        if (stale) return;
        if (typeof found === 'string') { setProblem(found); setItems([]); } else { setProblem(''); setItems(found); setActive(0); }
      });
    }, q ? 120 : 0);
    return () => { stale = true; clearTimeout(timer); };
  }, [kind, q]);
  const key = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    // The window goes back on Escape; here it only closes the box.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (!items?.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(at => (at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length); }
    else if (event.key === 'Enter') { event.preventDefault(); onPick(items[active]!); }
  };
  return <div className="rel-picker">
    <input ref={input} role="combobox" aria-expanded="true" aria-controls={list} aria-activedescendant={items?.length ? `${list}-${active}` : undefined} aria-label={t('{kind} 찾기', { kind: t(kindAdds[kind]) })} placeholder={t(pickerHints[kind])} value={q} onChange={event => setQ(event.target.value)} onKeyDown={key} maxLength={200}/>
    <div id={list} role="listbox" aria-label={t('찾은 항목')}>
      {items?.map((item, index) => <button type="button" role="option" id={`${list}-${index}`} aria-selected={index === active} className={'rel-option' + (index === active ? ' active' : '')} key={JSON.stringify(item.other)} onMouseEnter={() => setActive(index)} onClick={() => onPick(item)}>
        {item.task ? statusDot(item.rawStatus, statuses, t) : <span className="rel-note-icon" aria-hidden="true">▤</span>}<span className="rel-text">{item.title}</span>
        <span className="rel-note">{item.task ? t('작업') : t('노트')}{item.hint ? ` · ${item.hint}` : ''}</span>
      </button>)}
    </div>
    {items && !items.length && !problem && <p className="rel-empty" role="status">{q.trim() ? t('맞는 항목이 없어요.') : t('고를 수 있는 항목이 없어요.')}</p>}
    {problem && <p className="rel-error" role="alert">{problem}</p>}
  </div>;
}

/**
 * The detail screen's relationship sections. Without `editing` a section with nothing in it is left out, so a task with no relations
 * shows nothing here. With it, every section can take a new entry (found by name), and each entry has a button to take it out again.
 */
export function RelationSections({ relations, statuses, onOpen, editing = null }: { relations: TaskRelations | null | undefined; statuses: readonly StatusOption[]; onOpen: (task: TaskRef) => void; editing?: RelationEditing | null }) {
  const { t } = useI18n();
  const title = (kind: RelationKind) => t(kindTitles[kind]), add = (kind: RelationKind) => t(kindAdds[kind]);
  const [picking, setPicking] = useState<RelationKind | null>(null), [pending, setPending] = useState(false), [problem, setProblem] = useState('');
  const projects = relations?.projects ?? [], subtasks = relations?.subtasks ?? [], blockedBy = relations?.blockedBy ?? [], blocking = relations?.blocking ?? [];
  const counts: Record<RelationKind, number> = { project: projects.length, subtask: subtasks.length, blockedBy: blockedBy.length, blocking: blocking.length };
  if (!editing && !counts.project && !counts.subtask && !counts.blockedBy && !counts.blocking) return null;
  const run = async (kind: RelationKind, action: 'add' | 'remove', other: RelationOther) => {
    if (!editing || pending) return;
    setPending(true); setProblem('');
    const message = await editing.change(kind, action, other);
    setPending(false);
    if (message) setProblem(message); else if (action === 'add') setPicking(null);
  };
  const remove = (kind: RelationKind, other: RelationOther, name: string) => editing && <button type="button" className="rel-remove" aria-label={t('{name} 연결 해제', { name })} title={t('연결 해제')} disabled={pending} onClick={() => void run(kind, 'remove', other)}>×</button>;
  const addButton = (kind: RelationKind) => editing && <button type="button" className="rel-add" aria-label={t('{kind} 추가', { kind: add(kind) })} aria-expanded={picking === kind} disabled={pending} onClick={() => { setProblem(''); setPicking(picking === kind ? null : kind); }}>{t('＋ 추가')}</button>;
  const picker = (kind: RelationKind) => editing && picking === kind && <RelationPicker kind={kind} find={editing.find} statuses={statuses} onClose={() => setPicking(null)} onPick={candidate => void run(kind, 'add', candidate.other)}/>;
  const empty = editing ? kindOrder.filter(kind => !counts[kind]) : [];
  return <div className="relations">
    {projects.length > 0 && <section className="rel-section" aria-label={title('project')}><div className="rel-title">{title('project')}{addButton('project')}</div>{projects.map((project, i) => <div className="rel-entry" key={i}><Project project={project} statuses={statuses} onOpen={onOpen}/>{remove('project', { raw: project.link }, project.name)}</div>)}{picker('project')}</section>}
    {subtasks.length > 0 && <section className="rel-section" aria-label={title('subtask')}><div className="rel-title">{title('subtask')} <span className="rel-note">{t('{done}/{total} 완료', { done: relations!.subtasksDone, total: subtasks.length })}</span>{addButton('subtask')}</div>{subtasks.map(task => <div className="rel-entry" key={task.id}><div className="rel-row"><TaskLink task={task} statuses={statuses} onOpen={onOpen}/></div>{remove('subtask', { task: task.path }, task.title)}</div>)}{picker('subtask')}</section>}
    {blockedBy.length > 0 && <section className="rel-section" aria-label={title('blockedBy')}><div className="rel-title">{title('blockedBy')} {relations!.blocked && <span className="rel-tag open">{t('막힌 상태')}</span>}{addButton('blockedBy')}</div>{blockedBy.map((blocker, i) => <div className="rel-entry" key={i}><Blocker blocker={blocker} statuses={statuses} onOpen={onOpen}/>{remove('blockedBy', { raw: blocker.link }, blocker.name)}</div>)}{picker('blockedBy')}</section>}
    {blocking.length > 0 && <section className="rel-section" aria-label={title('blocking')}><div className="rel-title">{title('blocking')}{addButton('blocking')}</div>{blocking.map(task => <div className="rel-entry" key={task.id}><div className="rel-row"><TaskLink task={task} statuses={statuses} onOpen={onOpen}/></div>{remove('blocking', { task: task.path }, task.title)}</div>)}{picker('blocking')}</section>}
    {empty.length > 0 && <div className="rel-adders" role="group" aria-label={t('관계 추가')}>{empty.map(kind => <button type="button" className={'rel-add-kind' + (picking === kind ? ' open' : '')} key={kind} aria-expanded={picking === kind} disabled={pending} onClick={() => { setProblem(''); setPicking(picking === kind ? null : kind); }}>{t('＋ {kind}', { kind: add(kind) })}</button>)}</div>}
    {empty.map(kind => picker(kind) && <section className="rel-section" key={kind} aria-label={t('{kind} 추가', { kind: title(kind) })}><div className="rel-title">{title(kind)}</div>{picker(kind)}</section>)}
    {problem && <p className="rel-error" role="alert">{problem}</p>}
  </div>;
}

/** Done/total of a task's subtasks, with an arrow that opens and closes the list under it. */
export function SubtaskToggle({ relations, open, onToggle }: { relations: TaskRelations; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const total = relations.subtasks.length;
  return <button type="button" className={'sub-toggle' + (open ? ' open' : '')} aria-expanded={open} aria-label={t('하위 작업 {total}개 중 {done}개 완료, {action}', { total, done: relations.subtasksDone, action: open ? t('접기') : t('펼치기') })} onClick={onToggle}>
    <span className="sub-count">{relations.subtasksDone}/{total}</span><span className="sub-chevron" aria-hidden="true">▸</span>
  </button>;
}

/** The subtasks under a task. Each one slides in a moment after the one before; they close together, a little faster. */
export function SubtaskList({ subtasks, statuses, open, today, onOpen }: { subtasks: readonly TaskRef[]; statuses: readonly StatusOption[]; open: boolean; today: string; onOpen: (task: TaskRef) => void }) {
  const { t } = useI18n();
  return <div className={'sub-list' + (open ? ' open' : '')} style={{ '--n': subtasks.length } as React.CSSProperties} role="group" aria-label={t('하위 작업')}>
    {subtasks.map((task, index) => <div className="sub-item" style={{ '--i': index } as React.CSSProperties} key={task.id}><div className="sub-inner">
      <button type="button" className={'sub-row' + (task.status === 'done' ? ' done' : '')} tabIndex={open ? 0 : -1} onClick={() => onOpen(task)}>
        {statusDot(task.rawStatus, statuses, t)}<span className="sub-title">{task.title}</span>
        <span className="sub-meta">{statusName(task.rawStatus, statuses) ?? ''}{taskDateParts(task, today).map(part => <span key={part.kind} className={part.late ? 'late' : undefined}> · {part.kind === 'scheduled' ? t('예정') : t('마감')} {part.text}</span>)}</span>
      </button>
    </div></div>)}
  </div>;
}
