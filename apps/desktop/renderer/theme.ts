export type Theme = 'dark' | 'light';
export function initialTheme(): Theme {
  try { return localStorage.getItem('taskmanager-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}
export function applyTheme(theme: Theme) { document.documentElement.dataset.theme = theme; }
applyTheme(initialTheme());
