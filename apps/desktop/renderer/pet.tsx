import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { statusKey } from '../../../packages/contracts/task.ts';
import { peekChrome, peekMaxHeight, peekSubtaskRoom, rollSeconds, statusNote, type PetTask, type PetView } from '../pet-model.ts';
import { localDate, taskDateParts } from '../../../packages/contracts/dates.ts';
import { customStatusColor } from '../../../packages/contracts/statuses.ts';
import { applyTheme, initialTheme } from './theme.ts';
import { I18nProvider, useI18n } from './i18n.tsx';
import { localizeStatuses } from '../i18n/statuses.ts';
import type { Translate } from '../i18n/index.ts';
import './pet.css';
const api = window.taskPet!;
const localToday = () => localDate(new Date());
// The line under a title: a status beyond the plain two (진행 중, 지연, …) and the scheduled and due dates, when the task has them.
function rowDetail(task: Pick<PetTask, 'rawStatus' | 'status' | 'scheduled' | 'due'>, statuses: PetView['snapshot']['statuses'], t: Translate) {
  const note = statusNote(task.rawStatus, statuses), parts = taskDateParts(task, localToday());
  if (!note && !parts.length) return null;
  return <small>{note}{parts.map((part, index) => <span key={part.kind} className={part.late ? 'late' : undefined}>{note || index ? ' · ' : ''}{part.kind === 'scheduled' ? t('예정') : t('마감')} {part.text}</span>)}</small>;
}
// The same status circle in front of a row and of a subtask. A subtask is a TaskRef: the status is what the note says, not what the list changed.
// A finished one is filled and ticked, as in the app (green, or the status's own colour when it has one).
function dot(task: { rawStatus: string | null; status: PetTask['status'] }, statuses: PetView['snapshot']['statuses']) {
  const color = customStatusColor(task.rawStatus, statuses);
  return <span className={'dot ' + (color ? 'custom' : statusKey(task.rawStatus) === 'in-progress' ? 'in-progress' : task.status === 'unknown' ? 'unknown' : 'open') + (task.status === 'done' ? ' done' : '')} style={color ? { borderColor: color, background: color } : undefined}/>;
}
// Subtasks open only when the pointer has stayed on a row for a second (resting there, not passing over), and close a moment after it leaves,
// so crossing the gap between two rows does not flicker. Keyboard focus opens them at once.
const revealDelay = { open: 1000, close: 220 };
// The longest the list takes to finish moving is the stagger of the last subtask plus the time of one slide (see .pet-sub-item in pet.css).
const slideMs = 900;
// The window is as tall as the list gets with its longest set of subtasks open, so subtasks slide inside a window that stays still. It used to
// follow the list frame by frame, and that made the widget shake: Windows draws the old frame at the new window position for a frame or two,
// and a window growing upward moves its top edge every frame. openGap is the margin an open set of subtasks adds (.pet-group.open .pet-subs).
const openGap = 3;
// `list`: the list with every set of subtasks closed. `shown`: what the open (or opening, or closing) subtasks add now. `tallest`: what the
// longest set adds once open.
function measure(panel: HTMLElement) {
  let shown = 0, tallest = 0;
  for (const subs of panel.querySelectorAll<HTMLElement>('.pet-subs')) {
    // A closed subtask's slot is 0px tall but the row inside it keeps its full height (the slot only clips it), so it can be measured now.
    const rows = subs.querySelectorAll<HTMLElement>('.pet-sub');
    tallest = Math.max(tallest, [...rows].reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) + openGap);
    shown += subs.getBoundingClientRect().height + (subs.parentElement!.classList.contains('open') ? openGap : 0);
  }
  // The panel's own height is exact; once it is full and scrolls, the whole content is its scroll height (whole pixels) plus the border.
  const content = panel.scrollHeight > panel.clientHeight + 1 ? panel.scrollHeight + panel.offsetHeight - panel.clientHeight : panel.getBoundingClientRect().height;
  return { list: content - shown, shown, tallest };
}
// Open subtasks are added to the list's height cap, so they show in full instead of scrolling out of sight, and the rows already on screen stay
// where they are. Set every frame while they slide, before the panel is drawn, so the cap grows exactly as fast as the subtasks do.
function fitPanel(panel: HTMLElement) {
  panel.style.maxHeight = `min(${peekMaxHeight + Math.min(measure(panel).shown, peekSubtaskRoom)}px, calc(100% - ${peekChrome}px))`;
}
// A title that does not fit flows left at a steady speed and comes around again, like a ticker (see .roll-track in pet.css).
const rollStyle = (seconds: number) => ({ '--roll-time': `${seconds.toFixed(2)}s` }) as React.CSSProperties;
function Pet() {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState<string | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRevealed = useRef<string | null>(null), belowRef = useRef(false);
  const [view, setView] = useState<PetView | null>(null), [error, setError] = useState(''), [roll, setRoll] = useState<{ id: string; seconds: number } | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressed = useRef(false);
  const peek = useRef<HTMLElement>(null);
  const keep =() => { if (leave.current) clearTimeout(leave.current); };
  const reveal = (id: string | null, delay: number) => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    if (!delay) { setRevealed(id); return; }
    revealTimer.current = setTimeout(() => setRevealed(id), delay);
  };
  const run = (promise: Promise<unknown>) => { void promise.catch(() => setError(t('앱에서 확인해 주세요.'))); };
  const expand = () => { keep(); if (!pointer.current) run(api.expand(true)); };
  const collapse = () => { keep(); leave.current = setTimeout(() => { if (!pointer.current) run(api.expand(false)); }, 220); };
  // Only the list and the button count as the widget; the rest of the window is see-through (the window itself is the target there). Over
  // it the pointer has left the widget, as far as a person can see, and clicks go to the window behind.
  const over = useRef(false);
  const hover = (solid: boolean) => {
    if (over.current === solid) return;
    over.current = solid; run(api.passThrough(!solid));
    if (solid) expand(); else collapse();
  };
  useEffect(() => {
    run(api.state().then(setView));
    const unsubscribe = api.onState(setView);
    // The main process saw the real pointer outside the window; treat it as the leave the page did not hear (not while dragging the button).
    const unsubscribeLeft = api.onPointerLeft(() => { if (!pointer.current) hover(false); });
    // The app window changes the theme in shared storage; follow it here and tell the main process, which draws the menus.
    const theme = () => { applyTheme(initialTheme()); run(api.theme(initialTheme())); }; theme(); window.addEventListener('storage', theme);
    return () => { unsubscribe(); unsubscribeLeft(); keep(); if (revealTimer.current) clearTimeout(revealTimer.current); window.removeEventListener('storage', theme); };
  }, []);
  const startRoll = (id: string, row: HTMLElement) => {
    const title = row.querySelector<HTMLElement>('.task-title');
    const overflows = !!title && title.scrollWidth - title.clientWidth > 1;
    // People who asked their system for less motion keep the plain ellipsis.
    setRoll(title && overflows && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? { id, seconds: rollSeconds(title.scrollWidth) } : null);
  };
  // Tell the main process how tall the list can get so the window fits a short list. The panel resizes every frame while subtasks slide,
  // but this height does not change then; it moves only by sub-pixel rounding, which the 2px threshold ignores.
  const expanded = !!view?.expanded;
  const report = useRef<() => void>(() => {});
  useEffect(() => {
    const el = peek.current;
    if (!expanded || !el) { report.current = () => {}; return; }
    let sent = -1;
    report.current = () => {
      const { list, tallest } = measure(el), height = Math.min(list, peekMaxHeight) + Math.min(tallest, peekSubtaskRoom);
      if (Math.abs(height - sent) >= 2) { sent = height; run(api.fit(Math.ceil(height))); }
    };
    report.current();
    const observer = new ResizeObserver(() => report.current());
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);
  // A closed set of subtasks takes no room, so one that gains a subtask does not resize the panel; measure again whenever the list changes.
  useEffect(() => { report.current(); }, [view]);
  useEffect(() => { if (!expanded) { setRoll(null); setRevealed(null); } }, [expanded]);
  useEffect(() => {
    // The row that was opened or closed stays where it is on screen. Normally the layout already sees to that (the list grows on the side
    // the window grows, and its height cap grows with the subtasks); when the subtasks are taller than peekSubtaskRoom the panel scrolls
    // instead, and it is the scroll position that is moved to make up for it.
    const id = revealed ?? lastRevealed.current; lastRevealed.current = revealed;
    const panel = peek.current, row = id && panel ? panel.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`) : null;
    if (!panel) return;
    const place = () => { const box = row!.getBoundingClientRect(); return belowRef.current ? box.top : box.bottom - window.innerHeight; };
    // Measured against where the row started, not where it was a frame ago: the scroll position is kept in whole pixels, and correcting
    // frame by frame lost the fraction each time, so the row crept about 2px over one opening.
    const start = row ? place() : 0, until = performance.now() + slideMs; let frame = 0;
    const tick = () => {
      fitPanel(panel);
      const drift = row ? place() - start : 0;
      if (Math.abs(drift) >= 0.5 && panel.scrollHeight > panel.clientHeight) panel.scrollTop += drift;
      if (performance.now() < until) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [revealed]);
  belowRef.current = !!view?.below;
  const snapshot = useMemo(() => view?.snapshot && { ...view.snapshot, statuses: localizeStatuses(view.snapshot.statuses, t) }, [view?.snapshot, t]);
  const label =snapshot?.kind === 'ready' ? (snapshot.partial ? t('오늘 할 일 {n}개 · 확인 필요', { n: snapshot.total }) : snapshot.total ? t('오늘 할 일 {n}개', { n: snapshot.total }) : t('오늘 할 일 끝!')) : snapshot?.kind === 'disconnected' ? t('볼트 선택') : snapshot?.kind === 'unavailable' ? t('확인 필요') : t('읽는 중…');
  const open = (id?: string) => { setError(''); run(api.open(id ? { id, selectionKey: snapshot!.selectionKey } : undefined).then(ok => { if (!ok) setError(t('작업이 바뀌었어요. 앱에서 확인해 주세요.')); })); };
  const finish = (event: React.PointerEvent) => {
    const p = pointer.current; pointer.current = null;
    if (p?.moved) { suppressed.current = true; run(api.drag({ phase: 'end', x: event.screenX, y: event.screenY })); }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <main className={`pet-window ${view?.expanded ? 'expanded' : ''} ${view?.below ? 'below' : 'above'} ${view?.left ? 'left' : 'right'}`}
    onMouseMove={e => hover(e.target !== e.currentTarget)} onMouseLeave={() => hover(false)} onContextMenu={e => { e.preventDefault(); keep(); run(api.menu()); }}
    onKeyDown={e => { if (e.key === 'Escape') { run(api.expand(false)); (document.activeElement as HTMLElement)?.blur(); } }}>
    {view?.expanded && <section className="peek" ref={peek} aria-label={t('오늘 할 일 미리보기')}>
      <div className="peek-heading"><h1>{label}</h1><button aria-label={t('목록 접기')} onClick={() => run(api.expand(false))}>−</button></div>
      {view.notice && <div className={'pet-notice' + (view.notice.error ? ' error' : '')} role={view.notice.error ? 'alert' : 'status'}><span>{view.notice.text}</span>{view.notice.undo && <button onClick={() => run(api.undo())}>{t('되돌리기')}</button>}</div>}
      {snapshot?.kind === 'ready' && snapshot.tasks.map(task => <div className={'pet-group' + (revealed === task.id ? ' open' : '')} key={task.id} data-task={task.id} onMouseEnter={() => task.subtasks.length ? reveal(task.id, revealDelay.open) : reveal(null, revealDelay.close)} onMouseLeave={() => reveal(null, revealDelay.close)} onFocus={() => reveal(task.subtasks.length ? task.id : null, 0)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) reveal(null, revealDelay.close); }}>
        <button className={'pet-task' + (roll?.id === task.id ? ' rolling' : '')} onClick={() => open(task.id)} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); keep(); run(api.taskMenu({ id: task.id, selectionKey: snapshot.selectionKey })); }} onMouseEnter={e => startRoll(task.id, e.currentTarget)} onFocus={e => startRoll(task.id, e.currentTarget)} onMouseLeave={() => setRoll(null)} onBlur={() => setRoll(null)}>{dot(task, snapshot.statuses)}<span className="task-category" title={task.category}>{task.category}</span><span className="task-copy"><span className="task-title" style={roll?.id === task.id ? rollStyle(roll.seconds) : undefined}>{roll?.id === task.id ? <span className="roll-track"><span>{task.title}</span><span aria-hidden="true">{task.title}</span></span> : task.title}</span>{rowDetail(task, snapshot.statuses, t)}</span>{task.subtasks.length > 0 && <span className="pet-subcount" title={t('하위 작업 {done}개 완료, 전체 {total}개', { done: task.subtasksDone, total: task.subtasks.length })}>{task.subtasksDone}/{task.subtasks.length}</span>}<span className="arrow">›</span></button>
        {task.subtasks.length > 0 && <div className="pet-subs" style={{ '--n': task.subtasks.length } as React.CSSProperties} role="group" aria-label={t('하위 작업')}>{task.subtasks.map((sub, index) => <div className="pet-sub-item" style={{ '--i': view?.below ? index : task.subtasks.length - 1 - index } as React.CSSProperties} key={sub.id}><div className="pet-sub-inner">
          {/* A long title flows like a row's. A finished one is struck through and ticked, so its status and dates are left out to keep it one line. */}
          <button className={'pet-sub' + (sub.status === 'done' ? ' done' : '') + (roll?.id === `${task.id}/${sub.id}` ? ' rolling' : '')} tabIndex={revealed === task.id ? 0 : -1} onClick={() => open(sub.id)}
            onMouseEnter={e => startRoll(`${task.id}/${sub.id}`, e.currentTarget)} onFocus={e => startRoll(`${task.id}/${sub.id}`, e.currentTarget)} onMouseLeave={() => setRoll(null)} onBlur={() => setRoll(null)}>
            {dot(sub, snapshot.statuses)}<span className="task-copy"><span className="task-title" style={roll?.id === `${task.id}/${sub.id}` ? rollStyle(roll.seconds) : undefined}>{roll?.id === `${task.id}/${sub.id}` ? <span className="roll-track"><span>{sub.title}</span><span aria-hidden="true">{sub.title}</span></span> : sub.title}</span>{sub.status === 'done' ? null : rowDetail(sub, snapshot.statuses, t)}</span></button>
        </div></div>)}</div>}
      </div>)}
      {snapshot?.kind === 'ready' && !snapshot.total && <p className="empty">{snapshot.partial ? t('읽지 못한 작업을 앱에서 확인해 주세요.') : t('잠깐 쉬어가도 좋아요.')}</p>}
      {snapshot?.kind === 'unavailable' && <p className="empty">{t('볼트를 읽지 못했어요.')}<br/>{t('앱에서 폴더를 확인해 주세요.')}</p>}
      {snapshot?.kind === 'disconnected' && <p className="empty">{t('위젯을 누르고 볼트를 선택해 주세요.')}</p>}
      {/* Stays at the bottom while a long list scrolls, like the title at the top (see .peek-footer in pet.css). */}
      <div className="peek-footer">
        <button className="all-tasks" onClick={() => open()}>{t('앱에서 모두 보기')}{' '}<span>↗</span></button>
        {(error || view.settingsError) && <p className="error" role="alert">{error || t('위치·설정을 저장하지 못했어요.')}</p>}
      </div>
    </section>}
    <button className="pet-button" aria-label={t('{label} · 작업 앱 열기', { label })} onFocus={expand}
      onPointerDown={e => { if (e.button !== 0) return; suppressed.current = false; pointer.current = { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => {
        const p = pointer.current; if (!p) { expand(); return; } if (p.id !== e.pointerId) return;
        if (!p.moved && Math.hypot(e.screenX - p.x, e.screenY - p.y) > 5) { p.moved = true; run(api.drag({ phase: 'start', x: p.x, y: p.y })); }
        if (p.moved) run(api.drag({ phase: 'move', x: e.screenX, y: e.screenY }));
      }} onPointerUp={finish} onPointerCancel={finish}
      onClick={() => { if (suppressed.current) { suppressed.current = false; return; } open(); }}>
      <span className="pet-caption"><strong>{label}</strong></span>
    </button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Pet/></I18nProvider>);
