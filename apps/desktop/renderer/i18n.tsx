import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { intlLocale, parseLanguagePreference, resolveLocale, translate, translator, type LanguagePreference, type Locale, type Params, type Translate } from '../i18n/index.ts';

// The choice is kept by the main process (see language-store.ts). It is also kept here, in the storage the main window and the widget share,
// so a window shows the right language from its first frame and the other window follows when it changes.
const storageKey = 'taskmanager-language';
function stored(): LanguagePreference {
  try { return parseLanguagePreference(localStorage.getItem(storageKey)); } catch { return 'auto'; }
}

export interface I18n {
  locale: Locale;
  /** The tag to give Intl for dates and numbers. */
  intl: string;
  preference: LanguagePreference;
  setPreference(value: LanguagePreference): void;
  t: Translate;
  /** Like t, but the places can hold elements (a <code> inside a sentence, say), so the sentence is translated as a whole. */
  r(source: string, values: Readonly<Record<string, React.ReactNode>>): React.ReactNode;
}

const korean: I18n = { locale: 'ko', intl: intlLocale.ko, preference: 'ko', setPreference: () => {}, t: translator('ko'), r: (source, values) => rich('ko', source, values) };
const Context = createContext<I18n>(korean);

function rich(locale: Locale, source: string, values: Readonly<Record<string, React.ReactNode>>): React.ReactNode {
  const parts = translate(locale, source).split(/(\{\w+\})/);
  return parts.map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name !== undefined && name in values ? <React.Fragment key={index}>{values[name]}</React.Fragment> : part;
  });
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [preference, setState] = useState<LanguagePreference>(stored);
  const locale = resolveLocale(preference, navigator.language);
  const value = useMemo<I18n>(() => ({
    locale, intl: intlLocale[locale], preference, t: translator(locale), r: (source, values) => rich(locale, source, values),
    setPreference: next => { try { localStorage.setItem(storageKey, next); } catch { /* it is just not remembered here */ } setState(next); },
  }), [locale, preference]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  // The other window changed it.
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === storageKey) setState(stored()); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useI18n = (): I18n => useContext(Context);
export type { Params, Translate };
