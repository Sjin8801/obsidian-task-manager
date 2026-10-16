import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from 'playwright-core';
import electron from 'electron';
import { localDate } from '../packages/contracts/dates.ts';

// The pictures in the READMEs, taken from the real app on a made-up vault, once in English and once in Korean.
// Run with `npm run docs:screenshots`; the windows take the focus for about half a minute.
type Locale = 'en' | 'ko';
const day = (offset: number) => localDate(new Date(Date.now() + offset * 86_400_000));
const words = {
  en: {
    project: 'Q4 planning', report: 'Write the quarterly report', numbers: 'Collect the sales numbers', summary: 'Draft the summary',
    slides: 'Review the slides with the team', dentist: 'Book a dentist appointment', passport: 'Renew passport', work: 'work', personal: 'personal',
  },
  ko: {
    project: '4분기 계획', report: '분기 보고서 작성', numbers: '매출 자료 모으기', summary: '요약 초안 쓰기',
    slides: '팀과 발표 자료 검토', dentist: '치과 예약하기', passport: '여권 갱신', work: '업무', personal: '개인',
  },
} as const;

async function vaultFor(root: string, locale: Locale): Promise<string> {
  const w = words[locale], vault = path.join(root, 'vault'), tasks = path.join(vault, 'TaskNotes', 'Tasks');
  await mkdir(tasks, { recursive: true }); await mkdir(path.join(vault, 'Projects'));
  await writeFile(path.join(vault, 'Projects', w.project + '.md'), `# ${w.project}\n`);
  const note = (title: string, lines: string[]) => writeFile(path.join(tasks, title + '.md'), `---\ntitle: ${title}\n${lines.join('\n')}\n---\n`);
  await note(w.report, [`tags: [task, ${w.work}]`, 'status: in-progress', 'priority: high', `scheduled: ${day(0)}`, `due: ${day(2)}`, `projects:\n  - "[[${w.project}]]"`]);
  await note(w.numbers, [`tags: [task, ${w.work}]`, 'status: done', `completedDate: ${day(-1)}`, `scheduled: ${day(-1)}`, `projects:\n  - "[[${w.report}]]"`]);
  await note(w.summary, [`tags: [task, ${w.work}]`, 'status: open', 'priority: normal', `scheduled: ${day(0)}`, `projects:\n  - "[[${w.report}]]"`]);
  await note(w.slides, [`tags: [task, ${w.work}]`, 'status: open', `due: ${day(-1)}`, `blockedBy:\n  - uid: "[[${w.summary}]]"\n    reltype: FINISHTOSTART`]);
  await note(w.dentist, [`tags: [task, ${w.personal}]`, 'status: open', `scheduled: ${day(0)}T18:30`]);
  await note(w.passport, ['tags: [task]', 'status: open', 'priority: low', `due: ${day(0)}`]);
  return vault;
}

async function shoot(locale: Locale) {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(path.resolve('.local', 'screenshots-')), profile = path.join(root, 'profile');
  const vault = await vaultFor(root, locale), w = words[locale], out = (name: string) => path.resolve('docs', 'images', `${locale}-${name}.png`);
  await mkdir(profile); await mkdir(path.resolve('docs', 'images'), { recursive: true });
  await writeFile(path.join(profile, 'language.json'), JSON.stringify({ language: locale }));
  await writeFile(path.join(profile, 'pet.json'), JSON.stringify({ x: 700, y: 120, hidden: false, alwaysOnTop: true, peek: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE; env.TASK_DESKTOP_DATA = profile;
  const app = await _electron.launch({ executablePath: electron as unknown as string, args: [path.resolve('dist/desktop/main.cjs')], cwd: process.cwd(), env, chromiumSandbox: true });
  try {
    const page = await app.firstWindow();
    const pet = app.windows().find(window => window !== page) ?? await app.waitForEvent('window');
    await pet.waitForURL('taskmanager://app/pet.html');
    // As in smoke-pet.ts: the widget watches the real pointer to notice it leaving, so it is told the pointer is on it.
    await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'))!;
      win.setIgnoreMouseEvents = () => {};
      screen.getCursorScreenPoint = () => { const b = win.getBounds(); return { x: Math.round(b.x + b.width / 2), y: b.y + b.height - 20 }; };
    });
    await page.locator('.vault-select').waitFor();
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog;
    }, vault);
    await page.locator('.vault-select').click();
    await page.locator('.task').filter({ hasText: w.report }).first().waitFor();
    await page.locator('.sub-toggle').first().click(); await page.locator('.sub-toggle[aria-expanded="true"]').waitFor();
    await page.mouse.move(0, 0); await delay(300);
    await page.screenshot({ path: out('today') });
    await page.locator('.task').filter({ hasText: w.report }).first().click(); await page.keyboard.press('Enter');
    await page.locator('.body-text').waitFor(); await delay(300);
    await page.screenshot({ path: out('task-detail') });
    await pet.locator('.pet-button').hover(); await pet.locator('.peek').waitFor();
    await pet.locator('.pet-task').filter({ hasText: w.report }).hover(); await pet.locator('.pet-group.open').waitFor(); await delay(600);
    await pet.screenshot({ path: out('widget') });
  } catch (error) {
    // Where it stopped, for finding out why.
    for (const [index, window] of app.windows().entries()) await window.screenshot({ path: path.join(root, `failure-${index}.png`) }).catch(() => {});
    console.error('Stopped; the windows are in ' + root);
    throw error;
  } finally { await app.close(); }
}

for (const locale of ['en', 'ko'] as const) await shoot(locale);
console.log('Screenshots written to docs/images.');
