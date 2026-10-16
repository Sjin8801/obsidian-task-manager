import React, { useEffect, useRef, useState } from 'react';
import type { DesktopStatus } from '../shared.ts';
import { defaultShortcut, shortcutFromKey, shortcutLabel } from '../shortcut.ts';
import { N } from '../i18n/index.ts';
import { useI18n } from './i18n.tsx';
const errors: Record<string, string> = {
  INVALID_SHORTCUT: N('Ctrl 또는 Alt와 다른 키를 함께 눌러 주세요. Shift도 조합할 수 있어요.'),
  SHORTCUT_UNAVAILABLE: N('다른 앱에서 사용 중이거나 Windows에서 사용할 수 없는 조합이에요. 기존 단축키는 유지했어요.'),
  SHORTCUT_SAVE_FAILED: N('단축키를 저장하지 못했어요. 기존 단축키는 유지했어요.'),
  SHORTCUT_BUSY: N('단축키를 변경하고 있어요. 잠시 후 다시 시도해 주세요.'),
};
export function ShortcutSettings({ status, onSaved, onBusy }: { status: DesktopStatus; onSaved: (status: DesktopStatus) => void; onBusy: (busy: boolean) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(status.shortcut), [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const blur = () => input.current?.blur();
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('blur', blur); void window.taskManager?.setShortcutCapture(false); };
  }, []);
  async function save() {
    if (!window.taskManager || saving) return;
    setSaving(true); onBusy(true); setError(null); setSaved(false);
    try {
      const result = await window.taskManager.setShortcut(draft);
      if (result.ok) { onSaved(result.value); setSaved(true); }
      else setError(errors[result.code] ? t(errors[result.code]!) : t('단축키를 변경하지 못했어요. 다시 시도해 주세요.'));
    } finally { setSaving(false); onBusy(false); }
  }
  return <section className="shortcut-settings" aria-label={t('단축키 설정')}>
    <h2>{t('단축키')}</h2><p className="hint">{t('어느 화면에서든 앱을 열거나 숨기는 키예요.')}</p>
    <label>{t('앱 열기·숨기기')}<input ref={input} aria-label={t('앱 단축키')} aria-describedby="shortcut-help" readOnly disabled={saving} value={shortcutLabel(draft)}
      className={recording ? 'recording' : ''}
      onFocus={() => { setRecording(true); setSaved(false); void window.taskManager?.setShortcutCapture(true); }}
      onBlur={() => { setRecording(false); void window.taskManager?.setShortcutCapture(false); }}
      onKeyDown={event => {
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) return;
        if (event.key === 'Escape') { input.current?.blur(); return; }
        event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key) || event.repeat) return;
        const next = shortcutFromKey(event.nativeEvent);
        setSaved(false);
        if (next) { setDraft(next); setError(null); } else setError(errors.INVALID_SHORTCUT!);
      }}/></label>
    <p id="shortcut-help" className="hint">{recording ? t('원하는 키 조합을 눌러 주세요. Esc로 뒤로가기.') : t('입력란을 누른 뒤 Ctrl 또는 Alt와 다른 키를 함께 눌러 주세요.')}</p>
    <div className="settings-buttons"><button className="secondary" disabled={saving} onClick={() => { setDraft(defaultShortcut); setError(null); setSaved(false); }}>{t('기본값')}</button><button className="secondary" disabled={saving || (draft === status.shortcut && status.shortcutRegistered && !status.shortcutError)} onClick={() => void save()}>{saving ? t('저장 중…') : t('단축키 저장')}</button></div>
    {status.shortcutError && <p className="notice">{t('저장된 단축키 설정을 읽지 못해 기본값을 적용했어요. 다시 저장해 주세요.')}</p>}
    {!status.shortcutRegistered && <p className="notice">{t('현재 단축키를 등록하지 못했어요. 다른 조합을 지정하거나 트레이 아이콘으로 열어 주세요.')}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {saved && <p className="hint" role="status">{t('단축키를 저장했어요. 다음 실행에도 유지돼요.')}</p>}
  </section>;
}
