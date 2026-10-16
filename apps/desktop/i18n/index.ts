/**
 * The words on the screens, in Korean and in English.
 *
 * The Korean text in the code is the key: t(<the Korean text>) shows that text as it is in Korean and looks it up in `en` (en.ts) for English.
 * A text with something in it says where: a place is written {n} and filled from the second argument. A word that changes with the number is written
 * `{n:task|tasks}` in the English text (the first form for 1, the second for anything else). tests/i18n.test.ts checks that every text
 * passed to t() has an English one, that none is left over, and that both say the same places.
 *
 * This file has no Electron and no React in it: the main process, the screens and the widget all use it.
 */
import { en } from './en.ts';

export type Locale = 'ko' | 'en';
/** What the person chose: one language, or whatever the system uses. */
export type LanguagePreference = 'auto' | Locale;
export const locales: readonly Locale[] = ['ko', 'en'];
export const languageNames: Readonly<Record<Locale, string>> = { ko: '한국어', en: 'English' };

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return value === 'ko' || value === 'en' ? value : 'auto';
}

/** The language to show: the one chosen, or Korean for a Korean system and English for everything else. */
export function resolveLocale(preference: LanguagePreference, system: string | undefined): Locale {
  if (preference !== 'auto') return preference;
  return /^ko(?:$|[-_])/i.test(system ?? '') ? 'ko' : 'en';
}

/** The tag to give Intl for dates and numbers. */
export const intlLocale: Readonly<Record<Locale, string>> = { ko: 'ko-KR', en: 'en-US' };

export type Params = Readonly<Record<string, string | number>>;
export type Translate = (source: string, params?: Params) => string;

export function translate(locale: Locale, source: string, params?: Params): string {
  const text = locale === 'ko' ? source : en[source] ?? source;
  if (!params) return text;
  return text
    .replace(/\{(\w+):([^|}]*)\|([^}]*)\}/g, (match, name: string, one: string, other: string) => (name in params ? (Number(params[name]) === 1 ? one : other) : match))
    .replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Marks a text for translation where it is written down but shown later: N is called where the text is written, t when it is shown. Returns the text as it is. */
export const N = (source: string): string => source;
/** Korean as written: what a function that is given no translator shows. */
export const korean: Translate = (source, params) => translate('ko', source, params);

export function translator(locale: Locale): Translate {
  return (source, params) => translate(locale, source, params);
}
