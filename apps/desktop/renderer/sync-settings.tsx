import React, { useEffect, useReducer, useState } from 'react';
import type { DesktopStatus } from '../shared.ts';
import { problemHint, syncSummary } from '../sync-messages.ts';
import { useI18n } from './i18n.tsx';


// Settings block for "Headless 동기화 실행": the switch, a live status line and the steps a new user needs.
export function SyncSettings({ status, onStatus }: { status: DesktopStatus; onStatus: (status: DesktopStatus) => void }) {
  const { t, r } = useI18n();
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const [, tick] = useReducer((count: number) => count + 1, 0);
  // Relative times ("3분 전") are recomputed every 15 seconds.
  useEffect(() => { const timer = setInterval(tick, 15_000); return () => clearInterval(timer); }, []);
  const sync = status.sync, vaultPath = status.vault?.vaultPath ?? t('<볼트 폴더 경로>'), summary = syncSummary(sync, Date.now(), t);
  async function call(action: () => Promise<{ ok: true; value: DesktopStatus } | { ok: false; code: string }> | undefined) {
    if (saving) return;
    setSaving(true); setError(null);
    try { const result = await action(); if (result?.ok) onStatus(result.value); else setError(t('동기화 설정을 저장하지 못했어요. 다시 시도해 주세요.')); }
    catch { setError(t('동기화 설정을 저장하지 못했어요. 다시 시도해 주세요.')); }
    finally { setSaving(false); }
  }
  const api = window.taskManager;
  return <section className="theme-settings sync-settings" aria-label={t('Headless 동기화 실행')}>
    <h2>{t('옵시디언 동기화')}</h2>
    <p className="hint">{t('옵시디언 앱을 켜 두지 않아도 Obsidian Sync를 백그라운드에서 계속 동기화해요. 이 PC의 옵시디언 앱 Sync는 꺼 주세요. 함께 켜면 충돌할 수 있어요.')}</p>
    <label><input type="checkbox" checked={sync.enabled} disabled={saving || !api} onChange={e => { const enabled = e.currentTarget.checked; void call(() => api?.setHeadlessSync(enabled)); }}/>{' '}{t('Headless 동기화 실행')}</label>
    {sync.enabled && <div className={`sync-status ${summary.tone}`} role="status"><span className="sync-dot" aria-hidden="true"/><strong>{summary.text}</strong></div>}
    {sync.phase === 'problem' && sync.problem && <div className="notice error" role="alert">{problemHint(sync.problem, vaultPath, t)}</div>}
    {sync.phase === 'problem' && sync.problem && sync.problem !== 'NO_VAULT' && <div className="settings-buttons"><button className="secondary" disabled={saving} onClick={() => void call(() => api?.retryHeadlessSync())}>{t('다시 시도')}</button></div>}
    {sync.enabled && sync.phase === 'stalled' && <p className="hint">{t('서버에 연결되지 않은 채 오래 지났어요. 인터넷 연결을 확인해 주세요. 연결되면 자동으로 이어져요.')}</p>}
    {sync.enabled && sync.lastError && sync.phase !== 'problem' && <p className="hint">{t('최근 오류: {error}', { error: sync.lastError })}</p>}
    {sync.enabled && sync.restarts > 0 && <p className="hint">{t('동기화가 멈춰 {n}번 다시 시작했어요.', { n: sync.restarts })}</p>}
    {sync.enabled && sync.mode && <p className="hint">{t('동기화 방식: {mode}', { mode: sync.mode === 'bidirectional' ? t('양방향') : sync.mode })}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <details className="sync-guide"><summary>{t('처음 준비하는 방법')}</summary>
      <p className="hint">{t('Obsidian Sync 구독이 필요해요. 이 앱은 계정 정보나 암호화 비밀번호를 다루지 않아요. 아래 3~4번은 터미널에서 한 번만 하면 돼요.')}</p>
      <ol>
        <li>{t('Node.js 22 이상을 설치해요.')}</li>
        <li>{r('터미널에서 {command} 를 실행해요.', { command: <code>npm install -g obsidian-headless</code> })}</li>
        <li>{r('{command} 으로 Obsidian 계정에 로그인해요.', { command: <code>ob login</code> })}</li>
        <li>{r('{setup} 로 이 볼트를 연결해요. 원격 볼트 이름은 {list} 로 볼 수 있어요.', { setup: <code>{`ob sync-setup --vault "${t('원격 볼트 이름')}" --path "${vaultPath}"`}</code>, list: <code>ob sync-list-remote</code> })}</li>
        <li>{t('옵시디언 앱의 설정 → Sync에서 이 PC의 동기화를 꺼요.')}</li>
        <li>{r('위의 {name} 을 켜요.', { name: <strong>{t('Headless 동기화 실행')}</strong> })}</li>
      </ol>
    </details>
    {sync.enabled && <details className="sync-log"><summary>{t('최근 출력 ({n}줄)', { n: sync.recent.length })}</summary><pre>{sync.recent.length ? sync.recent.join('\n') : t('아직 출력이 없어요.')}</pre></details>}
  </section>;
}
