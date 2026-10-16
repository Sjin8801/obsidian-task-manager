import { N, korean, type Translate } from './i18n/index.ts';
import type { SyncProblem, SyncStatus } from './shared.ts';

// Wording for Headless Sync, shared by the settings screen, the tray tooltip and notifications. No Node or DOM imports.
// Every function that makes text takes the translator last; without one the text is Korean.
export type SyncTone = 'off' | 'ok' | 'busy' | 'warn' | 'error';

export function relativeTime(now: number, then: number, t: Translate = korean): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return t('방금');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('{n}분 전', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{n}시간 전', { n: hours });
  return t('{n}일 전', { n: Math.round(hours / 24) });
}

const problemText: Record<SyncProblem, { title: string; hint: string }> = {
  NO_VAULT: { title: N('볼트를 먼저 선택해 주세요'), hint: N('동기화할 볼트가 정해지면 자동으로 시작해요.') },
  NOT_INSTALLED: { title: N('ob 명령을 찾지 못했어요'), hint: N('터미널에서 npm install -g obsidian-headless 를 실행해 설치해 주세요. Node.js 22 이상이 필요해요.') },
  NODE_MISSING: { title: N('Node.js를 찾지 못했어요'), hint: N('Node.js 22 이상을 설치한 뒤 다시 시도해 주세요.') },
  NOT_LOGGED_IN: { title: N('Obsidian 계정에 로그인해야 해요'), hint: N('터미널에서 ob login 을 실행해 로그인해 주세요.') },
  NOT_CONFIGURED: { title: N('이 볼트가 동기화에 연결되지 않았어요'), hint: N('터미널에서 ob sync-setup --vault "원격 볼트 이름" --path "{path}" 를 실행해 주세요. 원격 볼트 이름은 ob sync-list-remote 로 볼 수 있어요.') },
  BAD_MODE: { title: N('동기화 방식이 양방향이 아니에요'), hint: N('이 앱에서 수정한 작업이 서버에 올라가지 않거나 되돌려질 수 있어요. ob sync-config --path "{path}" --mode bidirectional 로 바꿔 주세요.') },
  ALREADY_RUNNING: { title: N('이 볼트를 다른 곳에서 이미 동기화하고 있어요'), hint: N('열려 있는 터미널의 ob sync 를 닫고, 옵시디언 앱의 Sync 는 끈 뒤 다시 시도해 주세요.') },
  REMOTE_MISSING: { title: N('연결된 원격 볼트가 없어졌어요'), hint: N('ob sync-setup 을 다시 실행해 볼트를 연결해 주세요.') },
  ENCRYPTION_KEY: { title: N('암호화 키를 찾지 못했어요'), hint: N('ob sync-setup 을 다시 실행해 암호화 비밀번호를 입력해 주세요.') },
  CRASHED: { title: N('동기화가 계속 멈춰요'), hint: N('아래 최근 출력을 확인하고 다시 시도해 주세요.') },
};
export const problemTitle = (problem: SyncProblem, t: Translate = korean) => t(problemText[problem].title);
export const problemHint = (problem: SyncProblem, vaultPath: string, t: Translate = korean) => t(problemText[problem].hint, { path: vaultPath });

export function syncSummary(status: SyncStatus, now: number, t: Translate = korean): { tone: SyncTone; text: string } {
  switch (status.phase) {
    case 'off': return { tone: 'off', text: t('꺼짐') };
    case 'problem': return { tone: 'error', text: status.problem ? problemTitle(status.problem, t) : t('문제가 생겼어요') };
    case 'starting': return { tone: 'busy', text: t('시작하는 중…') };
    case 'connecting': return { tone: 'busy', text: t('서버에 연결하는 중…') };
    case 'syncing': return { tone: 'busy', text: status.progress ? t('동기화 중 ({done}/{total})', { done: status.progress.done, total: status.progress.total }) : t('동기화 중…') };
    case 'synced': return { tone: 'ok', text: status.lastSyncedAt === null ? t('최신 상태') : t('최신 상태 · 마지막 동기화 {when}', { when: relativeTime(now, status.lastSyncedAt, t) }) };
    case 'offline': return { tone: 'warn', text: t('연결이 끊겼어요 · 다시 연결하는 중') };
    case 'stalled': return { tone: 'warn', text: t('오래 연결되지 않아요 · 네트워크를 확인해 주세요') };
  }
}

// Tray tooltip suffix; empty while the feature is off so the tooltip stays unchanged for people who do not use it.
export function trayLabel(status: SyncStatus, now: number, t: Translate = korean): string {
  return status.phase === 'off' ? '' : t(' · 동기화: {status}', { status: syncSummary(status, now, t).text });
}

// The title-bar chip appears only when something needs attention.
export function syncNeedsAttention(status: SyncStatus): boolean {
  return status.enabled && (status.phase === 'stalled' || (status.phase === 'problem' && status.problem !== 'NO_VAULT'));
}

// A notification is worth showing when a problem first appears or the sync stalls. No file names or paths in the text.
export function syncAlert(previous: SyncStatus, next: SyncStatus, t: Translate = korean): { key: string; title: string; body: string } | null {
  if (next.phase === 'problem' && next.problem && next.problem !== 'NO_VAULT' && previous.problem !== next.problem) {
    return { key: `problem:${next.problem}`, title: t('동기화가 멈췄어요'), body: t('{problem}. 앱의 볼트 설정에서 자세한 안내를 볼 수 있어요.', { problem: problemTitle(next.problem, t) }) };
  }
  if (next.phase === 'stalled' && previous.phase !== 'stalled') {
    return { key: 'stalled', title: t('동기화가 지연되고 있어요'), body: t('서버에 오래 연결되지 않았어요. 네트워크를 확인해 주세요.') };
  }
  return null;
}
