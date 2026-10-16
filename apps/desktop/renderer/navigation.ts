import type { TaskRecord } from '../shared.ts';
export interface View { screen: 'list' | 'search' | 'detail' | 'editor' | 'settings'; scope: string; query: string; task: TaskRecord | null }
export interface Navigation { current: View; history: View[] }
export const initialNavigation: Navigation = { current: { screen: 'list', scope: 'all', query: '', task: null }, history: [] };
export type NavigationAction = { type: 'open'; screen: View['screen']; task?: TaskRecord } | { type: 'scope'; scope: string; clearQuery?: boolean } | { type: 'query'; query: string } | { type: 'back' } | { type: 'reset' } | { type: 'saved'; task: TaskRecord } | { type: 'removed'; id: string };
export function navigationReducer(state: Navigation, action: NavigationAction): Navigation {
  if (action.type === 'reset') return initialNavigation;
  if (action.type === 'back') return state.history.length ? { current: state.history.at(-1)!, history: state.history.slice(0, -1) } : state;
  if (action.type === 'removed') {
    const history = state.history.filter(v => v.task?.id !== action.id);
    if (state.current.task?.id !== action.id) return { ...state, history };
    return { current: history.at(-1) ?? { ...state.current, screen: 'list', task: null }, history: history.slice(0, -1) };
  }
  if (action.type === 'saved') {
    const update = (v: View): View => v.task?.id === action.task.id ? { ...v, task: action.task } : v;
    const updated = { current: update(state.current), history: state.history.map(update) };
    return state.current.screen === 'editor' ? navigationReducer(updated, { type: 'back' }) : updated;
  }
  if (state.current.screen === 'search' && action.type === 'query') return { ...state, current: { ...state.current, query: action.query } };
  if (state.current.screen === 'search' && action.type === 'scope') return { ...state, current: { ...state.current, scope: action.scope, query: action.clearQuery ? '' : state.current.query } };
  let next: View;
  if (action.type === 'open') next = { ...state.current, screen: action.screen, task: action.task ?? null };
  else if (action.type === 'scope') next = { ...state.current, screen: 'list', task: null, scope: action.scope, query: action.clearQuery ? '' : state.current.query };
  else next = { ...state.current, screen: 'list', task: null, query: action.query };
  if (next.screen === state.current.screen && next.scope === state.current.scope && next.query === state.current.query && next.task?.id === state.current.task?.id) return state;
  // Typing a search is one navigation step, not one step per character.
  const replacingSearch = action.type === 'query' && state.current.screen === 'list' && !!state.current.query && !!next.query;
  return { current: next, history: replacingSearch ? state.history : [...state.history, state.current].slice(-50) };
}
// Some mice emit both a DOM button event and a native browser command for one press.
export class BackInputGate {
  private last: { source: string; time: number } | null = null;
  accept(source: string, time: number) {
    if (this.last && this.last.source !== source && time - this.last.time < 200) return false;
    this.last = { source, time }; return true;
  }
}
