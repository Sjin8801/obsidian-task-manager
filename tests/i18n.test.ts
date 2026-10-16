import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { en } from '../apps/desktop/i18n/en.ts';
import { languageNames, parseLanguagePreference, resolveLocale, translate, translator } from '../apps/desktop/i18n/index.ts';
import { localizeStatuses } from '../apps/desktop/i18n/statuses.ts';
import { LanguageStore } from '../apps/desktop/language-store.ts';
import { builtInKind, categoryOf, categoryScope, categoryTags, defaultCategoriesFor, inScope, validCategory } from '../apps/desktop/categories.ts';
import { CategoryStore } from '../apps/desktop/category-store.ts';
import { problemHint, problemTitle, relativeTime, syncAlert, syncSummary, trayLabel } from '../apps/desktop/sync-messages.ts';
import { petErrorText } from '../apps/desktop/pet-model.ts';
import { defaultStatuses } from '../packages/contracts/statuses.ts';
import { parseTask } from '../packages/tasknotes/task.ts';
import type { SyncStatus } from '../apps/desktop/shared.ts';
import { collectSources } from './i18n-sources.ts';

// The places in a text: {name}, and the number a word is chosen by in {name:one|other}.
const places = (text: string) => [...new Set([...text.matchAll(/\{(\w+)(?::[^|}]*\|[^}]*)?\}/g)].map(match => match[1]!))].sort().join(',');

test('every text the code gives the translator has an English one, and none is left over', () => {
  const used = collectSources();
  const missing = [...used.keys()].filter(source => !(source in en));
  assert.deepEqual(missing, [], `no English for: ${missing.map(source => `${source} (${used.get(source)![0]})`).join('; ')}`);
  const stale = Object.keys(en).filter(source => !used.has(source));
  assert.deepEqual(stale, [], 'English texts that nothing asks for');
  assert(used.size > 300, 'the scan finds the texts (a broken scan would find none and pass)');
});

test('an English text fills in the same places as the Korean one, and is not empty', () => {
  for (const [source, english] of Object.entries(en)) {
    assert(english.trim().length > 0, source);
    assert.equal(places(english), places(source), `places differ in: ${source}`);
  }
});

test('Korean is shown as written, English is looked up, and a text with no English falls back to the Korean', () => {
  assert.equal(translate('ko', '저장'), '저장');
  assert.equal(translate('en', '저장'), 'Save');
  assert.equal(translate('en', '이런 문장은 아직 번역이 없어요'), '이런 문장은 아직 번역이 없어요');
  assert.equal(translator('en')('{label} 시간', { label: 'Due' }), 'Due time');
  assert.equal(translator('ko')('{label} 시간', { label: '마감일' }), '마감일 시간');
  assert.equal(translate('en', '{done}/{total} 완료', { done: 2, total: 5 }), '2/5 done');
});

test('a word that depends on the number takes the form for 1 or for anything else', () => {
  assert.equal(translate('en', '오늘 할 일 {n}개', { n: 1 }), '1 task today');
  assert.equal(translate('en', '오늘 할 일 {n}개', { n: 4 }), '4 tasks today');
  assert.equal(translate('en', '오늘 할 일 {n}개', { n: 0 }), '0 tasks today');
  assert.equal(translate('en', '{n}시간 전', { n: 1 }), '1 hour ago');
  assert.equal(translate('en', '{n}시간 전', { n: 5 }), '5 hours ago');
  assert.equal(translate('en', '파일·폴더 {n}개를 확인해야 해요. 목록이 일부 누락될 수 있어요.', { n: 1 }), '1 file or folder needs checking. The list may be missing some tasks.');
  assert.equal(translate('en', '파일·폴더 {n}개를 확인해야 해요. 목록이 일부 누락될 수 있어요.', { n: 3 }), '3 files or folders need checking. The list may be missing some tasks.');
  assert.equal(translate('ko', '오늘 할 일 {n}개', { n: 4 }), '오늘 할 일 4개');
});

test('the language follows the system until one is chosen: Korean for a Korean system, English for the rest', () => {
  for (const system of ['ko', 'ko-KR', 'KO_kr']) assert.equal(resolveLocale('auto', system), 'ko', system);
  for (const system of ['en-US', 'en', 'ja-JP', 'de', 'kok', '', undefined]) assert.equal(resolveLocale('auto', system), 'en', String(system));
  assert.equal(resolveLocale('en', 'ko-KR'), 'en'); assert.equal(resolveLocale('ko', 'en-US'), 'ko');
  for (const [value, expected] of [['ko', 'ko'], ['en', 'en'], ['auto', 'auto'], ['fr', 'auto'], [null, 'auto'], [3, 'auto']] as const) assert.equal(parseLanguagePreference(value), expected);
  assert.deepEqual(languageNames, { ko: '한국어', en: 'English' });
});

test('the choice of language is kept in the profile and read back; a damaged file means "follow the system"', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'language-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'profile', 'language.json');
  const first = new LanguageStore(file, () => 'en-US'); await first.load();
  assert.equal(first.preference, 'auto'); assert.equal(first.locale, 'en');
  await first.save('ko');
  assert.equal(first.locale, 'ko');
  const second = new LanguageStore(file, () => 'en-US'); await second.load();
  assert.equal(second.preference, 'ko'); assert.equal(second.locale, 'ko', 'kept for the next launch');
  await assert.rejects(second.save('fr'), /INVALID_REQUEST/); assert.equal(second.preference, 'ko', 'a bad value is refused and changes nothing');
  await writeFile(file, '{ not json');
  const third = new LanguageStore(file, () => 'ko-KR'); await third.load();
  assert.equal(third.preference, 'auto'); assert.equal(third.locale, 'ko');
});

test("TaskNotes' own four statuses are named in the language of the screens; a status of your own is shown as written", () => {
  const korean = translator('ko'), english = translator('en');
  assert.deepEqual(localizeStatuses(defaultStatuses, english).map(s => s.label), ['None', 'Open', 'In progress', 'Done']);
  assert.deepEqual(localizeStatuses(defaultStatuses, korean).map(s => s.label), ['없음', '시작', '진행 중', '완료']);
  assert.deepEqual(localizeStatuses(defaultStatuses, english).map(s => s.value), ['none', 'open', 'in-progress', 'done'], 'the value written to a note is never translated');
  const mine = [{ value: 'open', label: 'To do', color: null, completed: false }, { value: 'waiting', label: 'Waiting', color: null, completed: false }, { value: '시작', label: '시작', color: null, completed: false }];
  assert.deepEqual(localizeStatuses(mine, english).map(s => s.label), ['To do', 'Waiting', '시작'], 'renamed or added statuses are left alone');
});

test("the two categories every vault has are named in the language, and a task tagged in either language's name belongs to them", () => {
  assert.deepEqual(defaultCategoriesFor('ko'), ['업무', '개인']); assert.deepEqual(defaultCategoriesFor('en'), ['work', 'personal']);
  assert.equal(builtInKind('업무'), 'work'); assert.equal(builtInKind('Work'), 'work'); assert.equal(builtInKind('개인'), 'personal'); assert.equal(builtInKind('personal'), 'personal'); assert.equal(builtInKind('학습'), null);
  assert.equal(categoryScope('work'), 'work'); assert.equal(categoryScope('업무'), 'work'); assert.equal(categoryScope('personal'), 'personal'); assert.equal(categoryScope('study'), 'category:study');
  const task = (...tags: string[]) => parseTask('t.md', `---\ntags: [task${tags.map(tag => ', ' + tag).join('')}]\n---\n`);
  for (const list of [defaultCategoriesFor('ko'), defaultCategoriesFor('en')]) {
    const [work, personal] = list as [string, string];
    assert.equal(categoryOf(task('업무'), list), work, 'a Korean work tag in either language'); assert.equal(categoryOf(task('work'), list), work); assert.equal(categoryOf(task('Work'), list), work);
    assert.equal(categoryOf(task(), list), personal); assert.equal(categoryOf(task('other'), list), personal);
    assert.equal(inScope(task('work'), 'work', list), true); assert.equal(inScope(task('work'), 'personal', list), false); assert.equal(inScope(task('x'), 'personal', list), true);
  }
  assert.equal(categoryOf(task('study', 'work'), ['work', 'personal', 'study']), 'work', 'work comes first, as before');
  assert.equal(categoryOf(task('study'), ['work', 'personal', 'study']), 'study');
  assert.deepEqual(categoryTags(['work', 'personal', 'study']).sort(), ['study', 'work', 'personal', '업무', '개인'].sort(), 'to take a category off a task, both languages count');
  assert.equal(validCategory('all'), false); assert.equal(validCategory('전체'), false); assert.equal(validCategory('study'), true);
});

test('added categories are kept per vault without the built-in two, and the built-in two follow the language', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'categories-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const store = new CategoryStore(path.join(root, 'categories'));
  assert.deepEqual(await store.load('/vault', 'en'), ['work', 'personal']);
  assert.deepEqual(await store.add('/vault', 'study', 'en'), ['work', 'personal', 'study']);
  assert.deepEqual(await store.load('/vault', 'ko'), ['업무', '개인', 'study'], 'the same vault in the other language');
  assert.deepEqual(await store.add('/vault', 'work', 'ko'), ['업무', '개인', 'study'], 'a built-in name is not added again');
  assert.deepEqual(await store.add('/vault', '업무', 'en'), ['work', 'personal', 'study']);
  // An older profile kept the Korean two in the file; they are not shown twice in English.
  await writeFile(path.join(root, 'categories', (await readdir(path.join(root, 'categories')))[0]!), JSON.stringify(['업무', '개인', 'study']));
  assert.deepEqual(await store.load('/vault', 'en'), ['work', 'personal', 'study']);
});

const status = (over: Partial<SyncStatus>): SyncStatus => ({ enabled: true, phase: 'synced', problem: null, phaseSince: null, startedAt: null, lastSyncedAt: null, lastActivityAt: null, progress: null, restarts: 0, lastError: null, mode: null, recent: [], ...over });
test('the sync messages are translated, with the numbers and the vault path in place', () => {
  const english = translator('en'), now = 1_000_000_000;
  assert.equal(relativeTime(now, now - 10_000, english), 'just now'); assert.equal(relativeTime(now, now - 5 * 60_000, english), '5 min ago'); assert.equal(relativeTime(now, now - 3 * 3_600_000, english), '3 hours ago'); assert.equal(relativeTime(now, now - 2 * 86_400_000, english), '2 days ago');
  assert.equal(syncSummary(status({ phase: 'syncing', progress: { done: 3, total: 9 } }), now, english).text, 'Syncing (3/9)');
  assert.equal(syncSummary(status({ phase: 'synced', lastSyncedAt: now }), now, english).text, 'Up to date · last synced just now');
  assert.equal(trayLabel(status({ phase: 'offline' }), now, english), ' · Sync: Disconnected · reconnecting');
  assert.equal(trayLabel(status({ phase: 'off', enabled: false }), now, english), '');
  assert.match(problemHint('NOT_CONFIGURED', 'C:/Notes', english), /--path "C:\/Notes"/); assert.equal(problemTitle('CRASHED', english), 'Sync keeps stopping');
  const alert = syncAlert(status({}), status({ phase: 'problem', problem: 'NOT_LOGGED_IN' }), english)!;
  assert.equal(alert.title, 'Sync has stopped'); assert.equal(alert.body, 'You need to sign in to your Obsidian account. Details are in the vault settings of the app.');
  assert.equal(syncAlert(status({ phase: 'connecting' }), status({ phase: 'stalled' }), english)!.title, 'Sync is delayed');
});

test('a refused status change in the widget is explained in the language', () => {
  assert.match(petErrorText('REVISION_CONFLICT', translator('en')), /changed somewhere else/);
  assert.match(petErrorText('SELECTION_BUSY', translator('en')), /other save/);
  assert.match(petErrorText(undefined, translator('en')), /Could not change the status/);
  assert.match(petErrorText('REVISION_CONFLICT'), /다른 곳에서 먼저/, 'Korean without a translator, as before');
});
