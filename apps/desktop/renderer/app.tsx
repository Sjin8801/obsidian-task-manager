import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agenda, DesktopStatus, SearchResult, TaskRecord, TaskScope } from '../shared.ts';
import './style.css';
import type { TaskEdits, TaskRelations } from '../shared.ts';
import { categoryOf, categoryScope, defaultCategories } from '../categories.ts';
import { isOverdue, localDate, taskDateParts, timeZone } from '../../../packages/contracts/dates.ts';
import { defaultStatuses, findStatus, statusName } from '../../../packages/contracts/statuses.ts';
import type { TaskRef } from '../../../packages/contracts/relations.ts';
import { statusDot } from './status-dot.tsx';
import { RelationChips, RelationSections, SubtaskList, SubtaskToggle, type RelationEditing } from './relations.tsx';
import { nestSubtasks } from '../../../packages/tasknotes/relations.ts';
import { ShortcutSettings } from './shortcut-settings.tsx';
import { SyncSettings } from './sync-settings.tsx';
import { syncNeedsAttention } from '../sync-messages.ts';
import { shortcutLabel } from '../shortcut.ts';
import { BackInputGate, initialNavigation, navigationReducer } from './navigation.ts';
import { TaskEditor, type TaskEditorHandle } from './task-editor.tsx';
import { initialTheme, applyTheme, type Theme } from './theme.ts';
import { I18nProvider, useI18n } from './i18n.tsx';
import { N, languageNames, type LanguagePreference, type Translate } from '../i18n/index.ts';
import { localizeStatuses } from '../i18n/statuses.ts';

const api = window.taskManager;
// Scrolls a message into view when it first appears, so an error is never hidden below the fold of a long settings page.
const reveal = (element: HTMLElement | null) => { element?.scrollIntoView({ block: 'nearest' }); };
const messages: Record<string, string> = {
  INVALID_CATEGORY: N('분류 이름에는 한글·영문·숫자·밑줄·하이픈을 사용할 수 있어요. task와 전체는 제외해 주세요.'),
  CATEGORY_LIMIT: N('분류는 최대 32개까지 추가할 수 있어요.'),
  REVISION_CONFLICT: N('Obsidian이나 다른 앱에서 이 작업이 바뀌었어요. 입력한 내용은 남아 있어요. 최신 목록을 다시 열어 확인해 주세요.'),
  RECURRING_READ_ONLY: N('반복 작업은 Obsidian에서 수정해 주세요.'),
  INVALID_DATE: N('변경할 날짜는 YYYY-MM-DD 형식으로 입력해 주세요.'),
  SAVE_FAILED: N('저장하지 못했어요. 파일 접근 권한과 남은 공간을 확인해 주세요.'),
  SAVE_VERIFICATION_FAILED: N('저장 직후 파일이 다시 바뀌었어요. 원본 백업을 유지했으니 최신 내용을 확인해 주세요.'),
  UNSUPPORTED_PATCH: N('이 속성의 형식은 앱에서 안전하게 수정할 수 없어요. Obsidian에서 수정해 주세요.'),
  UNSAFE_FILE: N('이 파일은 크기나 연결 형식 때문에 수정할 수 없어요.'),
  NO_VAULT: N('먼저 Obsidian 볼트를 선택해 주세요.'),
  INVALID_VAULT: N('선택한 폴더를 열 수 없어요. 볼트 폴더를 다시 선택해 주세요.'),
  INVALID_TASK_FOLDER: N('선택한 볼트 안의 작업 폴더를 골라 주세요.'),
  VAULT_LINK_NOT_ALLOWED: N('외부 폴더로 연결된 바로가기는 읽지 않아요. 실제 폴더를 선택해 주세요.'),
  VAULT_UNAVAILABLE: N('볼트나 작업 폴더를 읽지 못했어요. 폴더 위치와 접근 권한을 확인해 주세요.'),
  SCAN_LIMIT_EXCEEDED: N('읽을 파일이 너무 많아요. 볼트 설정에서 작업 폴더를 좁혀 주세요.'),
  LOCAL_STORAGE_ERROR: N('볼트 선택 정보를 저장하거나 불러오지 못했어요. 다시 선택해 주세요.'),
  CURSOR_EXPIRED: N('검색 중 파일이 바뀌었어요. 새로고침해서 다시 검색해 주세요.'),
  VAULT_CHANGED: N('선택한 볼트가 바뀌었어요. 새로고침해 주세요.'),
  SELECTION_BUSY: N('열려 있는 폴더 선택 창을 먼저 닫아 주세요.'),
  INVALID_REQUEST: N('입력 내용을 확인해 주세요.'),
  RELATION_LOOP: N('서로가 서로의 상위(또는 차단) 작업이 되어서 연결할 수 없어요.'),
  RELATION_SELF: N('작업을 자기 자신과 연결할 수는 없어요.'),
  TASK_NOT_FOUND: N('연결할 작업을 찾을 수 없어요. 목록을 새로고침해 주세요.'),
  RELATIONS_UNAVAILABLE: N('볼트의 노트가 너무 많아 관계를 확인할 수 없어서 수정하지 않았어요.'),
  UNLINKABLE: N('이 이름으로는 링크를 만들 수 없어요. 노트 이름에 [ ] | # 가 들어 있는지 확인해 주세요.'),
  INVALID_PATH: N('작업 파일 경로가 올바르지 않아요.'),
};
const explainWith = (t: Translate, code: string) => messages[code] ? t(messages[code]!) : t('요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
const stateNames = { open: N('예정'), done: N('완료'), unknown: N('상태 확인') };
function formatDate(date: string, intl: string) {
  // A calendar day, not a moment: it is named in UTC so that no time zone moves it to the day before.
  return new Intl.DateTimeFormat(intl, { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));
}
const today = () => localDate(new Date());
function App() {
  const { t, r, intl, setPreference } = useI18n();
  const explain = (code: string) => explainWith(t, code);
  const [languageSaving, setLanguageSaving] = useState(false), [languageError, setLanguageError] = useState<string | null>(null);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [autoStartSaving, setAutoStartSaving] = useState(false), [autoStartError, setAutoStartError] = useState('');
  const [shortcutSaving, setShortcutSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [themeError, setThemeError] = useState(false);
  async function changeLanguage(choice: LanguagePreference) {
    if (!api || languageSaving) return;
    setLanguageSaving(true); setLanguageError(null);
    const result = await api.setLanguage(choice);
    setLanguageSaving(false);
    if (result.ok) { setStatus(result.value); setPreference(result.value.language); refresh(); }
    else setLanguageError(explain(result.code));
  }
  // The main process keeps the choice; the screens follow it (and the widget through the shared storage).
  useEffect(() => { if (status) setPreference(status.language); }, [status?.language]);
  function changeTheme(next: Theme) {
    setTheme(next); applyTheme(next);
    try { localStorage.setItem('taskmanager-theme', next); setThemeError(false); }
    catch { setThemeError(true); }
  }
  const [navigation, navigate] = useReducer(navigationReducer, initialNavigation);
  const { scope, query, screen, task } = navigation.current;
  const searching = screen === 'search';
  const settings = screen === 'settings', selected = screen === 'detail' ? task : null, editing = screen === 'editor' ? task : null;
  const setScope = (scope: TaskScope) => navigate({ type: 'scope', scope });
  const setQuery = (query: string) => navigate({ type: 'query', query });
  const openDetail = (task: TaskRecord) => navigate({ type: 'open', screen: 'detail', task });
  const openEditor = (task: TaskRecord) => navigate({ type: 'open', screen: 'editor', task });
  const openSettings = () => { setActionError(null); navigate({ type: 'open', screen: 'settings' }); };
  const listing = searching || scope === 'completed' || !!query.trim();
  const openSearch = () => { setActions(false); navigate({ type: 'open', screen: 'search' }); };
  const [agenda, setAgenda] = useState<Agenda | null>(null), [results, setResults] = useState<SearchResult | null>(null);
  // The statuses set up in TaskNotes, as of the last read; the built-in four until something has been read.
  const statuses = useMemo(() => localizeStatuses(agenda?.statuses ?? results?.statuses ?? defaultStatuses, t), [agenda?.statuses, results?.statuses, t]);
  // The lists carry the relations of the tasks they show. A task opened from the widget or from another task brings its own.
  const [extraRelations, setExtraRelations] = useState<Record<string, TaskRelations>>({});
  const relationsOf = (task: TaskRecord): TaskRelations | null => agenda?.relations[task.id] ?? results?.relations[task.id] ?? extraRelations[task.id] ?? null;
  // Which parents are open in the list. Remembered, so the list looks the same the next time.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => { try { return new Set<string>(JSON.parse(localStorage.getItem('taskmanager-expanded') ?? '[]')); } catch { return new Set<string>(); } });
  const toggleSubtasks = (id: string) => setExpanded(current => {
    const next = new Set(current); if (!next.delete(id)) next.add(id);
    try { localStorage.setItem('taskmanager-expanded', JSON.stringify([...next].slice(-200))); } catch { /* the choice is just not remembered */ }
    return next;
  });
  // Changing relationships from the detail screen: found by name, written in the note that holds the link (see edit-relation.ts).
  // A repeating task is read-only here, as everywhere else.
  const relationEditing: RelationEditing | null = api && status?.vault && selected && !selected.recurring ? {
    find: async (kind, q) => { const result = await api.findRelated({ selection: status.vault!, path: selected.path, kind, q }); return result.ok ? result.value : explain(result.code); },
    change: async (kind, action, other) => {
      const result = await api.editRelation({ selection: status.vault!, path: selected.path, kind, action, other });
      if (!result.ok) return explain(result.code);
      setSavedMessage(!result.value.changed ? t('이미 연결되어 있어요.') : action === 'add' ? t('연결했어요.') : t('연결을 해제했어요.')); refresh(); return null;
    },
  } : null;
  const remember = (task: TaskRecord, relations: TaskRelations | null) => { if (relations) setExtraRelations(current => ({ ...current, [task.id]: relations })); };
  function openRelated(ref: TaskRef) {
    void api?.getTask(ref.path).then(result => {
      if (!result.ok) { setError(explain(result.code)); return; }
      if (!result.value) { setSavedMessage(t('이 작업을 찾을 수 없어요. 목록을 새로고침해 주세요.')); return; }
      remember(result.value.task, result.value.relations); navigate({ type: 'open', screen: 'detail', task: result.value.task });
    });
  }
  const [error, setError] = useState<string | null>(null), [stale, setStale] = useState(false), [loading, setLoading] = useState(false);
  // Why a vault or folder choice (or another settings action) was refused. Kept apart from `error`, which every list load resets:
  // a load that finished after the refusal used to wipe the message before it could be read.
  const [actionError, setActionError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false), [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null), [savedMessage, setSavedMessage] = useState('');
  const [context, setContext] = useState<{ task: TaskRecord; x: number; y: number } | null>(null);
  const [addingCategory, setAddingCategory] = useState(false), [categoryName, setCategoryName] = useState('');
  const [dragging, setDragging] = useState(false), [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragTask = useRef<TaskRecord | null>(null);
  const categories = status?.categories ?? defaultCategories;
  const tabs = [{ id: 'all', label: t('전체') }, ...categories.map(c => ({ id: categoryScope(c), label: c === '완료' || c.toLowerCase() === t('완료').toLowerCase() ? t('완료 (분류)') : c })), { id: 'completed', label: t('완료') }];
  const busy = shortcutSaving || !!editing || !!context || saving || dragging || addingCategory;
  const [day, setDay] = useState(today()), [revision, setRevision] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0), [showCompleted, setShowCompleted] = useState(false), [actions, setActions] = useState(false);
  const visibleTasks = useMemo(() => {
    // In the day's lists a subtask whose parent is listed with it is shown under that parent, so the keyboard skips its own row.
    const ordered = (tasks: TaskRecord[], nest: boolean) => categories.flatMap(c => { const items = tasks.filter(t => categoryOf(t, categories) === c); return nest ? nestSubtasks(items, agenda?.relations ?? {}).roots : items; });
    return listing ? ordered(results?.items ?? [], false) : agenda ? [...ordered(agenda.today, true), ...ordered(agenda.overdue, false), ...(showCompleted ? ordered(agenda.completed, true) : [])] : [];
  }, [listing, results, agenda, showCompleted, categories]);
  const searchInput = useRef<HTMLInputElement>(null), request = useRef(0);
  const editorRef = useRef<TaskEditorHandle>(null);
  const viewKey = useRef(''), loadedCount = useRef(0);
  const previousTasks = useRef(visibleTasks);
  const backGate = useRef(new BackInputGate());
  const goBack = useCallback(() => {
    if (saving || choosing || dragging || shortcutSaving) return;
    if (actions) { setActions(false); return; }
    if (context) { setContext(null); return; }
    if (addingCategory) { setAddingCategory(false); return; }
    if (editing) { editorRef.current?.back(); return; }
    navigate({ type: 'back' });
  }, [saving, choosing, dragging, shortcutSaving, actions, context, addingCategory, editing]);
  useEffect(() => {
    const back = (source: string) => { if (backGate.current.accept(source, performance.now())) goBack(); };
    const unsubscribe = api?.onBack(() => back('native'));
    const mouse = (event: MouseEvent) => {
      if (event.button !== 3) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === 'mouseup') back('mouse');
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      if (event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey && !event.shiftKey)) {
        event.preventDefault(); event.stopImmediatePropagation(); back('key');
      }
    };
    for (const name of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(name, mouse as EventListener, true);
    window.addEventListener('keydown', key, true);
    return () => {
      unsubscribe?.();
      for (const name of ['mousedown', 'mouseup', 'auxclick']) window.removeEventListener(name, mouse as EventListener, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [goBack]);
  const refresh = useCallback(() => { setRevision(n => n + 1); }, []);
  useEffect(() => api?.onChanged(refresh), [refresh]);
  useEffect(() => api?.onSyncStatus(sync => setStatus(current => current ? { ...current, sync } : current)), []);
  useEffect(() => api?.onOpenTask(value => {
    if (JSON.stringify(value.selection) !== JSON.stringify(status?.vault)) return;
    if (busy || choosing) { setSavedMessage(t('편집이나 작업을 마친 뒤 위젯에서 다시 선택해 주세요.')); return; }
    setActions(false); remember(value.task, value.relations); navigate({ type: 'open', screen: 'detail', task: value.task });
  }), [busy, choosing, status?.vault]);
  useEffect(() => {
    if (!api || !selected || busy || !status?.connected) return;
    let canceled = false;
    void api.getTask(selected.path).then(result => {
      if (canceled) return;
      if (result.ok && result.value) { remember(result.value.task, result.value.relations); navigate({ type: 'saved', task: result.value.task }); }
      else if (result.ok) {
        navigate({ type: 'removed', id: selected.id });
        setSavedMessage(t('이 작업이 삭제되었거나 작업 목록에서 제외됐어요.'));
      }
    });
    return () => { canceled = true; };
  }, [selected?.id, screen, revision, busy, status?.vault?.vaultPath, status?.vault?.taskRelativePath]);
  useEffect(() => {
    if (!api) { setError(t('이 화면은 데스크톱 앱에서 실행해 주세요.')); setReady(true); return; }
    void api.status().then(result => { if (result.ok) setStatus(result.value); else setError(explain(result.code)); setReady(true); });
    return api.onShow(() => { setDay(today()); setActions(false); refresh(); searchInput.current?.focus(); });
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => { const next = today(); setDay(previous => previous === next ? previous : next); }, 30_000);
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || editing || saving || dragging || shortcutSaving) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!event.repeat) goBack(); return; }
      if (addingCategory || context) return;
      if (!status?.connected) return;
      if (!searching && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setActions(value => !value); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openSearch(); searchInput.current?.focus(); return; }
      if (searching && event.key === 'Tab' && !context) {
        const controls = [...document.querySelectorAll<HTMLElement>('.search-dialog button:not(:disabled), .search-dialog input:not(:disabled), .search-dialog summary, .search-dialog [tabindex="0"]')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); refresh(); return; }
      if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) { event.preventDefault(); const tab = tabs[Number(event.key) - 1]; if (tab) setScope(tab.id); return; }
      if (actions) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); const buttons = [...document.querySelectorAll<HTMLButtonElement>('.actions-panel button')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        }
        return;
      }
      if (settings || selected || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target !== searchInput.current && !target.closest('.task') && !target.closest('.task-line') && !target.closest('.search-trigger') && target !== document.body) return;
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && visibleTasks.length) {
        event.preventDefault(); setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : visibleTasks.length - 1)) % visibleTasks.length);
      }
      const highlighted = visibleTasks[activeIndex];
      if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && highlighted && target !== searchInput.current && agenda?.relations[highlighted.id]?.subtasks.length) {
        if (expanded.has(highlighted.id) !== (event.key === 'ArrowRight')) { event.preventDefault(); toggleSubtasks(highlighted.id); }
      }
      if (event.key === 'Enter' && visibleTasks[activeIndex]) { event.preventDefault(); openDetail(visibleTasks[activeIndex]!); }
    };
    window.addEventListener('keydown', key); return () => { clearInterval(timer); window.removeEventListener('keydown', key); };
  }, [editing, saving, shortcutSaving, context, dragging, addingCategory, categories, selected, settings, actions, query, status?.connected, activeIndex, visibleTasks, expanded, agenda, refresh, goBack, searching]);
  useEffect(() => { setActiveIndex(0); }, [query, scope]);
  useEffect(() => {
    const previous = previousTasks.current; previousTasks.current = visibleTasks;
    setActiveIndex(index => {
      const next = visibleTasks.findIndex(task => task.id === previous[index]?.id);
      return next >= 0 ? next : Math.max(0, Math.min(index, visibleTasks.length - 1));
    });
  }, [visibleTasks]);
  useEffect(() => {
    if (searching) searchInput.current?.focus();
    else if (screen === 'list') document.querySelector<HTMLButtonElement>('.search-trigger')?.focus();
  }, [scope, screen]);
  useEffect(() => { document.querySelector('.task.highlighted')?.scrollIntoView({ block: 'nearest' }); }, [activeIndex]);
  useEffect(() => { if (actions) document.querySelector<HTMLButtonElement>('.actions-panel button')?.focus(); else if (!settings && !selected) searchInput.current?.focus(); }, [actions, settings, selected, status?.connected]);
  useEffect(() => {
    const sequence = ++request.current;
    if (!api || !status?.connected || busy) { setLoading(false); return; }
    const key = JSON.stringify([status.vault, scope, query.trim(), day]);
    const changedView = viewKey.current !== key;
    if (changedView) {
      viewKey.current = key; loadedCount.current = 0;
      setResults(null); setAgenda(null); setStale(false); setError(null);
    }
    // Keep the existing rows mounted during refreshes of this same view.
    setLoading(true);
    const timer = setTimeout(async () => {
      if (!api) return;
      if (listing) {
        let result = await api.search({ scope, q: query.trim() });
        if (sequence !== request.current) return;
        // Refresh all pages the user has opened without collapsing the list.
        while (result.ok && result.value.nextCursor && result.value.items.length < loadedCount.current) {
          const next = await api.search({ scope, q: query.trim(), cursor: result.value.nextCursor });
          if (sequence !== request.current) return;
          if (!next.ok) { result = next; break; }
          result = { ok: true, value: { ...next.value, items: [...result.value.items, ...next.value.items] } };
        }
        if (result.ok) {
          loadedCount.current = result.value.items.length;
          setResults(result.value); setError(null); setStale(false);
        } else { setError(explain(result.code)); setStale(true); }
      } else {
        const result = await api.agenda(scope);
        if (sequence !== request.current) return;
        if (result.ok) { setAgenda(result.value.agenda); setStale(result.value.stale); setError(result.value.error ? explain(result.value.error) : null); }
        else { setError(explain(result.code)); setStale(true); }
      }
      setLoading(false);
    }, query.trim() ? 200 : 0);
    return () => { clearTimeout(timer); request.current++; };
  }, [scope, query, status?.connected, status?.vault?.vaultPath, status?.vault?.taskRelativePath, revision, day, busy, listing]);

  useEffect(() => {
    if (!status?.connected) return;
    const update = () => { if (document.visibilityState === 'visible' && !selected && !settings && !actions && !loading && !choosing && !busy) refresh(); };
    const timer = setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); };
  }, [status?.connected, selected, settings, actions, loading, choosing, busy, refresh]);
  async function chooseVault(taskFolder = false) {
    if (!api || choosing) return;
    setChoosing(true); setError(null); setActionError(null);
    const result = await (taskFolder ? api.selectTaskFolder() : api.selectVault());
    setChoosing(false);
    if (result.ok) {
      const changed = JSON.stringify(result.value.vault) !== JSON.stringify(status?.vault ?? null);
      setStatus(result.value);
      if (changed) { request.current++; setAgenda(null); setResults(null); navigate({ type: 'reset' }); setActions(false); setStale(false); setEditError(null); refresh(); }
    } else setActionError(explain(result.code));
  }
  async function forgetVault() {
    if (!api || choosing) return; setChoosing(true); setError(null); setActionError(null);
    const result = await api.forgetVault(); setChoosing(false);
    if (result.ok) { request.current++; setStatus(null); setAgenda(null); setResults(null); navigate({ type: 'reset' }); setStale(false); }
    else setActionError(explain(result.code));
  }
  async function more() {
    if (!api || !results?.nextCursor) return;
    // Preserve the requested page even if a file event interrupts this request.
    loadedCount.current = results.items.length + 100;
    // A refresh is already reading the list: start it again so it reads the extra page too. Ignoring the click here (or disabling
    // the button while loading) lost it whenever a file change arrived just as it was pressed.
    if (loading) { refresh(); return; }
    const sequence = request.current; setLoading(true);
    const next = await api.search({ scope, q: query.trim(), cursor: results.nextCursor });
    if (sequence !== request.current) return;
    if (next.ok) { loadedCount.current = results.items.length + next.value.items.length; setResults({ ...next.value, items: [...results.items, ...next.value.items] }); }
    else if (next.code === 'CURSOR_EXPIRED') refresh();
    else setError(explain(next.code));
    setLoading(false);
  }
  function taskRow(task: TaskRecord, nestable = false) {
    const overdue = isOverdue(task, day);
    const index = visibleTasks.findIndex(t => t.id === task.id);
    return <button draggable={!task.recurring && !saving && !stale} onDragStart={e => {
      if (task.recurring || saving || stale) { e.preventDefault(); return; }
      dragTask.current = task; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-tasknote', task.id); setDragging(true); setActions(false);
    }} onDragEnd={() => { dragTask.current = null; setDragging(false); setDropTarget(null); }} id={'task-' + task.id} aria-current={activeIndex === index ? 'true' : undefined} className={'task ' + (task.status === 'done' ? 'done ' : '') + (activeIndex === index ? 'highlighted' : '')} key={task.id} onMouseMove={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onClick={() => setActiveIndex(index)} onDoubleClick={() => { setEditError(null); openEditor(task); }} onContextMenu={event => { event.preventDefault(); setActiveIndex(index); setContext({ task, x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 292) }); }}>
      {statusDot(task.rawStatus, statuses, t)}
      <span className="task-main"><span className="task-title">{overdue && <span className="overdue-label">{t('(미룸)')}{' '}</span>}{task.title}</span><span className="task-meta">{categoryOf(task, categories)}<span>·</span>{statusName(task.rawStatus, statuses) ?? t(stateNames[task.status])}{taskDateParts(task, day).map(part => <span key={part.kind} className={'task-date' + (part.late ? ' late' : '')} title={part.kind === 'scheduled' ? t('예정일') : t('마감일')}>· {part.kind === 'scheduled' ? t('예정') : t('마감')} {part.text}</span>)}<RelationChips relations={relationsOf(task)} hideSubtasks={nestable}/>{scope === 'completed' && <span>· {task.completed ? t('{date} 완료', { date: task.completed.slice(0, 10) }) : t('완료일 없음')}</span>}{task.recurring && <span>{t('반복 · 조회만 가능')}</span>}</span></span>
      {task.priority === 'high' && <span className="priority" title={t('높은 우선순위')}>{t('높음')}</span>}<span className="row-arrow" aria-hidden="true">›</span>
    </button>;
  }
  // A row in the day's lists. A task with subtasks gets their count and an arrow, and its subtasks open under it.
  function taskLine(task: TaskRecord) {
    const relations = relationsOf(task), subtasks = relations?.subtasks ?? [], open = expanded.has(task.id);
    if (!relations || !subtasks.length) return taskRow(task, true);
    return <div className="task-line" key={task.id}>
      <div className="task-line-main">{taskRow(task, true)}<SubtaskToggle relations={relations} open={open} onToggle={() => toggleSubtasks(task.id)}/></div>
      <SubtaskList subtasks={subtasks} statuses={statuses} open={open} today={day} onOpen={openRelated}/>
    </div>;
  }
  function dropProps(category: string) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!dragTask.current || saving || categoryOf(dragTask.current, categories) === category) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(category);
      },
      onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null); },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault(); const task = dragTask.current;
        dragTask.current = null; setDragging(false); setDropTarget(null);
        if (task && e.dataTransfer.getData('application/x-tasknote') === task.id && categoryOf(task, categories) !== category) void save(task, { category });
      },
    };
  }
  function grouped(tasks: TaskRecord[], completed = false) {
    return categories.filter(c => scope === 'all' || scope === 'completed' || categoryScope(c) === scope).map(category => {
      const items = tasks.filter(t => categoryOf(t, categories) === category);
      if (completed && !items.length) return null;
      return <div key={category} className={'category-group ' + (dropTarget === category ? 'drop-active' : '')} data-category={category} role="group" aria-label={completed ? t('{category} 완료 작업', { category }) : t('{category} 작업', { category })} {...dropProps(category)}>
        <div className="category-divider"><span>{category}</span><span className="category-count">{items.length}</span><span className="divider-line"/></div>
        {nestSubtasks(items, agenda?.relations ?? {}).roots.map(taskLine)}{!items.length && <p className="drop-hint">{dragging ? t('여기에 놓으면 {category}로 변경돼요', { category }) : t('작업을 여기로 끌어 분류를 바꿀 수 있어요')}</p>}
      </div>;
    });
  }
  async function addCategory(e: React.FormEvent) {
    e.preventDefault(); if (!api || saving) return;
    setSaving(true); setEditError(null);
    const result = await api.addCategory(categoryName.trim()); setSaving(false);
    if (result.ok) { setStatus(result.value); setCategoryName(''); setAddingCategory(false); setScope('all'); refresh(); }
    else setEditError(explain(result.code));
  }
  async function save(task: TaskRecord, changes: TaskEdits) {
    if (!api || !status?.vault || saving) return;
    setSaving(true); setEditError(null); setError(null); setSavedMessage('');
    const result = await api.saveTask({ selection: status.vault, path: task.path, revision: task.revision, changes });
    setSaving(false);
    if (result.ok) { navigate({ type: 'saved', task: result.value }); setContext(null); setSavedMessage(changes.category ? t('{category}로 옮겼어요.', { category: changes.category }) : t('저장했어요.')); refresh(); }
    else if (editing) setEditError(explain(result.code));
    else { setContext(null); setEditError(changes.category && result.code === 'REVISION_CONFLICT' ? t('다른 앱에서 이 작업이 바뀌어 이동하지 않았어요. 최신 내용을 확인해 주세요.') : explain(result.code)); }
  }
  useEffect(() => {
    if (!context) return;
    document.querySelector<HTMLButtonElement>('.context-menu button[aria-checked="true"]')?.focus();
  }, [context]);
  useEffect(() => { if (!savedMessage) return; const timer = setTimeout(() => setSavedMessage(''), 3000); return () => clearTimeout(timer); }, [savedMessage]);
  const connected = !!status?.connected;
  const issues = listing ? results?.issues : agenda?.issues;
  const fetchedAt = listing ? results?.fetchedAt : agenda?.fetchedAt;
  const vaultName = status?.vault?.vaultPath.split(/[\\/]/).filter(Boolean).at(-1) ?? t('볼트');
  const outdated = !!agenda && agenda.date !== day;
  return <div className={'app ' + (connected && !settings && !selected && !editing ? 'browsing' : '')}>
    <div className="titlebar" inert={searching}><span className="brand-mark">✓</span><span>TaskNotes</span><span className="breadcrumb">/</span><span>{!connected ? t('볼트 선택') : settings ? t('볼트 설정') : editing ? t('작업 편집') : selected ? t('작업 상세') : scope === 'completed' ? t('완료 작업') : t('오늘 작업')}</span><span className="titlebar-spacer"/>{status && connected && syncNeedsAttention(status.sync) && <button className="sync-chip" onClick={() => { if (!settings) openSettings(); }}>{t('동기화 {state}', { state: status.sync.phase === 'stalled' ? t('지연') : t('문제') })}</button>}<button aria-label={t('창 숨기기')} onClick={() => void api?.hide()}>−</button></div>
    {!ready ? <div className="empty">{t('선택한 볼트를 확인하고 있어요.')}</div> : !connected ? <main className="connect">
      <span className="eyebrow">{t('내 볼트에서 바로')}</span><h1>{t('오늘의 작업을')}<br/>{t('더 가까이.')}</h1>
      <p className="intro">{t('이 PC에 저장된 Obsidian 볼트를 선택하세요.')}<br/>{t('볼트 안의 TaskNotes를 바로 보여드릴게요.')}</p>
      <button className="primary vault-select" onClick={() => void chooseVault()} disabled={choosing || !api}>{choosing ? t('폴더 선택 중…') : t('Obsidian 볼트 선택')}<span>→</span></button>
      {actionError && <div className="notice error" role="alert">{actionError}</div>}{error && <div className="notice error" role="alert">{error}</div>}
      <p className="hint">{t('볼트 선택은 다음 실행에도 유지돼요.')}<br/>{t('다른 기기의 변경 내용은 이 PC에 동기화된 뒤 표시돼요.')}</p>
    </main> : <>
      <header><div><span className="eyebrow">{formatDate(day, intl)}</span><h1>{scope === 'completed' ? t('완료 작업') : t('오늘 작업')}<span className="count">{scope === 'completed' ? results?.items.length ?? '—' : agenda ? agenda.today.length : '—'}</span></h1></div><button className="icon-button" disabled={busy} aria-label={t('볼트 설정')} onClick={() => { settings ? goBack() : openSettings(); }}>⚙</button></header>
      {editing ? <TaskEditor statuses={statuses} backRef={editorRef} key={editing.id} task={editing} saving={saving} error={editError} onSave={changes => void save(editing, changes)} onClose={() => { navigate({ type: 'back' }); setEditError(null); refresh(); }}/>
      : settings ? <main className="settings"><h2>{t('선택한 볼트')}</h2><p className="intro">{t('이 PC에 저장된 파일을 읽고 있어요.')}</p>
        {actionError && <div role="alert" className="notice error" ref={reveal}>{actionError}</div>}{error && <div role="alert" className="notice error" ref={reveal}>{error}</div>}
        <dl><dt>{t('볼트')}</dt><dd>{status?.vault?.vaultPath}</dd><dt>{t('작업 폴더')}</dt><dd>{status?.vault?.taskRelativePath === '.' ? t('볼트 전체에서 task 태그 검색') : status?.vault?.taskRelativePath}</dd><dt>{t('창 열기')}</dt><dd>{shortcutLabel(status!.shortcut)}</dd><dt>{t('뒤로가기')}</dt><dd>{t('Esc / 마우스 뒤로가기')}</dd></dl>
        <section className="theme-settings"><h2>{t('미니 위젯')}</h2><p className="hint">{t('바탕화면에서 오늘 할 일을 확인해요. 위젯을 드래그해 옮기고 우클릭으로 표시 방식을 바꿀 수 있어요.')}</p><button className="secondary" onClick={() => { void api?.showPet().then(result => { if (!result.ok) setActionError(explain(result.code)); }); }}>{t('미니 위젯 보이기')}</button></section>
        <section className="theme-settings" aria-label={t('언어 설정')}><h2>{t('언어')}</h2><div className="theme-options" role="group" aria-label={t('화면 언어')}>
          {(['auto', 'ko', 'en'] as const).map(choice => <button key={choice} className="theme-choice" aria-pressed={(status?.language ?? 'auto') === choice} disabled={languageSaving} onClick={() => void changeLanguage(choice)}>{choice === 'auto' ? t('시스템 설정 따르기') : languageNames[choice]}</button>)}
        </div><p className="hint">{t('선택한 언어는 다음 실행에도 유지돼요.')}</p>{languageError && <p className="notice error" role="alert">{languageError}</p>}</section>
        <section className="theme-settings" aria-label={t('테마 설정')}><h2>{t('테마')}</h2><div className="theme-options" role="group" aria-label={t('앱 테마')}>
          <button className="theme-choice" aria-pressed={theme === 'light'} onClick={() => changeTheme('light')}><span aria-hidden="true">☀</span>{' '}{t('화이트')}</button>
          <button className="theme-choice" aria-pressed={theme === 'dark'} onClick={() => changeTheme('dark')}><span aria-hidden="true">☾</span>{' '}{t('블랙')}</button>
        </div><p className="hint">{t('선택한 테마는 다음 실행에도 유지돼요.')}</p>{themeError && <p className="notice error" role="alert">{t('테마를 저장하지 못했어요. 이번 실행에만 적용돼요.')}</p>}</section>
        <section className="theme-settings"><h2>{t('자동 시작')}</h2><label><input type="checkbox" checked={status?.autoStart ?? false} disabled={autoStartSaving || !status?.autoStartSupported} onChange={async e => {
          const enabled = e.currentTarget.checked; setAutoStartSaving(true); setAutoStartError('');
          try { const result = await api!.setAutoStart(enabled); if (result.ok) setStatus(result.value); else setAutoStartError(t('자동 시작 설정을 저장하지 못했어요. Windows 설정 → 앱 → 시작 프로그램에서 이 앱이 꺼져 있지 않은지 확인해 주세요.')); }
          catch { setAutoStartError(t('자동 시작 설정을 저장하지 못했어요.')); }
          finally { setAutoStartSaving(false); }
        }}/>{' '}{t('Windows 로그인 시 자동 시작')}</label>{autoStartError && <p className="notice error" role="alert" ref={reveal}>{autoStartError}</p>}<p className="hint">{t('본창은 숨긴 채 트레이와 위젯을 시작해요. 위젯을 숨겨 두었다면 트레이만 표시해요.')}</p></section>
        <SyncSettings status={status!} onStatus={setStatus}/>
        <ShortcutSettings status={status!} onSaved={setStatus} onBusy={setShortcutSaving}/>
        <div className="settings-buttons"><button className="secondary" onClick={() => void chooseVault()} disabled={choosing}>{t('다른 볼트 선택')}</button><button className="secondary" onClick={() => void chooseVault(true)} disabled={choosing}>{t('작업 폴더 변경')}</button></div>
        <p className="hint">{t('task 태그가 있는 노트를 읽어요. 속성 이름과 상태는 TaskNotes 설정을 따라요.')}<br/>{t('파일이 저장되면 목록에 자동으로 반영돼요.')}</p>
        <button className="text-button" onClick={() => void forgetVault()} disabled={choosing}>{t('볼트 선택 해제')}</button><button className="text-button" disabled={shortcutSaving} onClick={goBack}>{t('← 뒤로')}</button></main>
      : selected ? <main className="detail"><button className="text-button" onClick={goBack}>{t('← 뒤로')}</button><button className="secondary" onClick={() => { openEditor(selected); setEditError(null); }}>{t('상세 수정')}</button><span className="eyebrow">{statusName(selected.rawStatus, statuses) ?? t(stateNames[selected.status])}</span><h2>{selected.title}</h2><dl><dt>{t('예정일')}</dt><dd>{selected.scheduled ?? t('없음')}</dd><dt>{t('마감일')}</dt><dd>{selected.due ?? t('없음')}</dd><dt>{t('분류')}</dt><dd>{selected.tags.filter(t => t !== 'task').join(' · ') || t('없음')}</dd></dl><RelationSections relations={relationsOf(selected)} statuses={statuses} onOpen={openRelated} editing={relationEditing}/>{selected.recurring && <p className="rel-note">{t('반복 작업의 관계는 Obsidian에서 수정해 주세요.')}</p>}{selected.warnings.length > 0 && <div className="notice">{t('원본 속성 중 확인이 필요한 항목이 있어요. 수정하지 않은 속성은 그대로 유지돼요.')}</div>}<pre className="body-text">{selected.body.trim() || t('본문이 없는 작업이에요.')}</pre></main>
      : <>{searching && <button className="search-backdrop" aria-label={t('검색 닫기')} tabIndex={-1} onClick={goBack}/>}<div className={searching ? 'list-view search-dialog' : 'list-view'} role={searching ? 'dialog' : undefined} aria-modal={searching || undefined} aria-label={searching ? t('작업 검색') : undefined}><div className="controls">{searching && <><div className="search-heading"><span>{t('작업 검색 · 모든 날짜')}</span><button aria-label={t('검색 팝업 닫기')} onClick={goBack}><kbd>Esc</kbd> ×</button></div><div className="search-box"><span aria-hidden="true">⌕</span><input ref={searchInput} aria-label={t('전체 작업 검색')} placeholder={scope === 'completed' ? t('완료한 작업 검색') : t('모든 날짜의 작업 검색')} value={query} onChange={e => setQuery(e.target.value)} maxLength={200}/>{query ? <button aria-label={t('검색 지우기')} onClick={() => setQuery('')}>×</button> : <kbd>Ctrl F</kbd>}</div></>}<div className="filter-row"><button className="vault-name" title={status?.vault?.vaultPath} onClick={() => { openSettings(); }}>{vaultName}</button><span className="date-label">{formatDate(day, intl)}</span>{!searching && <button className="search-trigger" onClick={openSearch} aria-label={t('작업 검색 열기')}>{t('⌕ 검색')}{' '}<kbd>Ctrl F</kbd></button>}<button className="refresh" onClick={refresh} disabled={loading}>{loading && !agenda && !results ? t('불러오는 중…') : t('↻ 새로고침')}</button></div><div className="category-tabs"><div className="filters" role="tablist" aria-label={t('작업 분류')}>{tabs.map(tab => <button role="tab" aria-selected={scope === tab.id} className={(tab.id === 'completed' ? 'completed-tab ' : '') + (scope === tab.id ? 'active ' : '') + (dropTarget === tab.label ? 'drop-active' : '')} key={tab.id} disabled={saving || addingCategory} onClick={() => setScope(tab.id)} {...(tab.id === 'all' || tab.id === 'completed' ? {} : dropProps(categories.find(c => categoryScope(c) === tab.id)!))}>{tab.label}</button>)}</div><button className="add-category" aria-label={t('분류 추가')} disabled={saving || dragging} onClick={() => { setAddingCategory(v => !v); setEditError(null); }}>＋</button></div>
        {addingCategory && <form className="category-form" onSubmit={e => void addCategory(e)}><label>{t('분류 이름')}<input autoFocus aria-label={t('분류 이름')} placeholder={t('예: 학습')} value={categoryName} onChange={e => setCategoryName(e.target.value)} maxLength={40} disabled={saving}/></label><button type="submit" className="secondary" disabled={saving || !categoryName.trim()}>{t('추가')}</button><button type="button" className="text-button" onClick={() => setAddingCategory(false)} disabled={saving}>{t('취소')}</button><p className="hint">{t('같은 이름의 태그를 분류로 사용해요.')}</p></form>}
        </div>
        <main className="task-content" aria-busy={loading}>
          {editError && <div className="notice error" role="alert">{editError}<button onClick={() => setEditError(null)} aria-label={t('저장 오류 닫기')}> ×</button></div>}{error && <div className="notice error" role="alert">{error}{stale && t(' 마지막으로 받은 목록을 표시하고 있어요.')}</div>}
          {outdated && <div className="notice">{t('{date}에 받은 목록입니다. 오늘 날짜로 다시 읽지 못했어요.', { date: agenda?.date ?? '' })}</div>}
          {!!issues?.length && <div className="notice">{t('파일·폴더 {n}개를 확인해야 해요. 목록이 일부 누락될 수 있어요.', { n: issues.length })}<details><summary>{t('확인할 파일')}</summary>{issues.map(i => <div key={i.path}>{i.path} · {i.code}</div>)}</details></div>}
          {listing ? <section><div className="section-label">{scope === 'completed' ? (query.trim() ? t('완료 작업 검색 결과') : t('완료한 작업 · 모든 날짜')) : t('검색 결과')} <span>{results?.items.length ?? 0}{results?.nextCursor ? '+' : ''}</span></div>{grouped(results?.items ?? [], scope === 'completed')}{results && results.items.length === 0 && <div className="empty"><span>⌕</span><h2>{scope === 'completed' && !query.trim() ? t('완료한 작업이 없어요.') : t('찾는 작업이 없어요.')}</h2><p>{scope === 'completed' && !query.trim() ? t('상태를 완료로 바꾸면 여기에 모아 보여드려요.') : t('다른 제목이나 분류로 검색해 보세요.')}</p></div>}{results?.nextCursor && <button className="secondary load-more" onClick={() => void more()}>{t('더 보기')}</button>}</section>
          : agenda ? <><section><div className="section-label">{outdated ? t('마지막 목록') : t('오늘 할 일')}<span>{agenda.today.length}</span></div>{grouped(agenda.today)}{agenda.today.length === 0 && <div className="empty"><span>✓</span><h2>{t('확인할 작업이 없어요.')}</h2><p>{t('다른 날짜의 작업은 검색으로 찾을 수 있어요.')}</p></div>}</section>{agenda.overdue.length > 0 && <section><div className="section-label">{t('마감 지난 작업')}<span>{agenda.overdue.length}</span></div>{agenda.overdue.map(task => taskRow(task))}</section>}{agenda.completed.length > 0 && <details className="completed" open={showCompleted} onToggle={e => setShowCompleted(e.currentTarget.open)}><summary>{t('완료한 작업')}{' '}<span>{agenda.completed.length}</span></summary>{grouped(agenda.completed, true)}</details>}</> : loading ? <div className="empty">{t('작업을 불러오고 있어요.')}</div> : null}
        </main></div></>}
      {context && <><button className="context-backdrop" aria-label={t('상태 메뉴 닫기')} disabled={saving} onClick={() => setContext(null)} onContextMenu={e => { e.preventDefault(); if (!saving) setContext(null); }}/><div className="context-menu" role="menu" aria-label={t('상태 변경')} style={{ left: Math.max(8, context.x), top: Math.max(34, context.y) }} onKeyDown={e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const at = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
      }}><div className="section-label">{t('상태 변경')}{saving ? t(' · 저장 중…') : ''}</div>{statuses.map(({ value, label }) => <button role="menuitemradio" aria-checked={findStatus(context.task.rawStatus, statuses)?.value === value} disabled={saving || context.task.recurring} key={value} onClick={() => void save(context.task, { status: value })}><span className="status-option">{statusDot(value, statuses, t)}{label}</span><span>{findStatus(context.task.rawStatus, statuses)?.value === value ? '✓' : ''}</span></button>)}<div className="menu-separator"/><button role="menuitem" disabled={saving} onClick={() => { openEditor(context.task); setEditError(null); setContext(null); }}>{t('상세 수정')}{' '}<span>{t('더블클릭')}</span></button>{context.task.recurring && <p className="hint">{t('반복 작업은 Obsidian에서 수정해 주세요.')}</p>}</div></>}
      {actions && <><button className="actions-backdrop" aria-label={t('동작 메뉴 닫기')} onClick={() => setActions(false)}/><div className="actions-panel" role="dialog" aria-label={t('작업 동작')}><div className="section-label">{t('동작')}</div>{!settings && !selected && visibleTasks[activeIndex] && <button onClick={() => { openDetail(visibleTasks[activeIndex]!); setActions(false); }}>{t('작업 상세 보기')}{' '}<kbd>↵</kbd></button>}<button onClick={() => { refresh(); setActions(false); }}>{t('목록 새로고침')}{' '}<kbd>Ctrl R</kbd></button><button onClick={() => { navigate({ type: 'scope', scope: 'completed', clearQuery: true }); setActions(false); }}>{t('완료 작업 모아보기')}</button><button onClick={() => { openSettings(); setActions(false); }}>{t('볼트 설정')}</button><button onClick={() => { setActions(false); void api?.hide(); }}>{t('창 숨기기')}</button></div></>}
      <footer inert={searching}><span className={'connection-dot ' + (error ? 'offline' : '')}/><span>{fetchedAt ? `${stale ? t('마지막 조회') : t('갱신')} ${new Intl.DateTimeFormat(intl, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timeZone() }).format(new Date(fetchedAt))}` : t('로컬 볼트')}</span><span className="footer-spacer"/><span role="status">{savedMessage}</span><span className="open-hint">{t('드래그 분류 · 우클릭 상태 · 더블클릭 수정')}</span><button disabled={busy} className="actions-toggle" onClick={() => setActions(value => !value)} aria-expanded={actions}>{t('동작')}{' '}<kbd>Ctrl K</kbd></button></footer>
    </>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><App/></I18nProvider>);
