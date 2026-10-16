import { hasTag, personalTags, workTags, type TaskRecord } from '../../packages/contracts/task.ts';
import type { Locale } from './i18n/index.ts';

// A category is a tag on the task. Two are always there, under the name each language gives them: work is a task with the work tag,
// personal is everything else. Tasks tagged in either language's name are recognised in both, so changing the language does not move them.
const builtIn = { work: { ko: '업무', en: 'work' }, personal: { ko: '개인', en: 'personal' } } as const;
const workNames = workTags, personalNames = personalTags;
export function defaultCategoriesFor(locale: Locale): string[] { return [builtIn.work[locale], builtIn.personal[locale]]; }
export const defaultCategories: readonly string[] = defaultCategoriesFor('ko');
/** Whether a category is one of the two that are always there, in whichever language. */
export function builtInKind(category: string): 'work' | 'personal' | null {
  const name = category.toLowerCase();
  return (workNames as readonly string[]).includes(name) ? 'work' : (personalNames as readonly string[]).includes(name) ? 'personal' : null;
}
/** Every tag that stands for a category here: the list's own and the built-in names in both languages. Used to take a task's old category off it. */
export function categoryTags(categories: readonly string[]): string[] { return [...new Set([...categories, ...workNames, ...personalNames])]; }

export function validCategory(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^[\p{L}\p{N}_-]+$/u.test(value) && /[\p{L}_-]/u.test(value) && !['task', 'all', '전체'].includes(value.toLowerCase());
}
export function categoryScope(category: string): string {
  return builtInKind(category) ?? 'category:' + category;
}
export function categoryOf(task: Pick<TaskRecord, 'tags'>, categories: readonly string[] = defaultCategories): string {
  for (const category of categories) {
    const kind = builtInKind(category);
    if (kind === 'personal') continue;
    if (kind === 'work' ? hasTag(task.tags, workTags) : task.tags.includes(category)) return category;
  }
  return categories.find(category => builtInKind(category) === 'personal') ?? defaultCategories[1]!;
}
export function inScope(task: TaskRecord, scope: string, categories: readonly string[]): boolean {
  if (scope === 'completed') return task.status === 'done';
  return scope === 'all' || categoryScope(categoryOf(task, categories)) === scope;
}
