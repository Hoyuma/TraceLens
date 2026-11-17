// 拡張 UI（サイドパネル・レビュー画面）の多言語化。日本語（既定）と英語。
//
// 範囲: 画面に出す文言だけ。出力ZIP（Markdown / JSON）と、記録データに保存された文言
// （notice・limitations・reason など）は言語設定にかかわらず日本語のまま（AI に渡す資料の形式を変えない）。
// 外部通信・依存パッケージは使わない。言語は chrome.storage.local の既存の設定キー（SETTINGS_KEY）に保存する。
import { useEffect, useState } from 'react';
import { SETTINGS_KEY, type RecordSettings } from '../shared/messages';
import type { DescLang } from '../shared/describe';
import { ja } from './dict-ja';
import { en } from './dict-en';

export type Lang = DescLang;
/** 辞書のキー。ja を基準とし、en に不足・余剰があると typecheck で検出される。 */
export type TKey = keyof typeof ja;

export const LANGS: readonly Lang[] = ['ja', 'en'];
/** 製品の主言語のため、ブラウザの UI 言語にかかわらず日本語を既定にする */
export const DEFAULT_LANG: Lang = 'ja';
export const DICTS: Record<Lang, Record<TKey, string>> = { ja, en };

let current: Lang = DEFAULT_LANG;
const listeners = new Set<() => void>();

export function getLang(): Lang { return current; }

/** {name} を params の値に置き換える。params が無いときは何もしない（{{変数名}} のような文言をそのまま扱うため）。 */
export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
}

export function translate(lang: Lang, key: TKey, params?: Record<string, string | number>): string {
  return format(DICTS[lang][key] ?? DICTS.ja[key] ?? key, params);
}

/** 現在の表示言語での文言 */
export function t(key: TKey, params?: Record<string, string | number>): string { return translate(current, key, params); }

function apply(l: unknown): void {
  const next: Lang = l === 'en' ? 'en' : DEFAULT_LANG;
  if (next === current) return;
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((f) => f());
}

/** 言語を切り替えて保存する。ほかの設定項目（記録の追加設定）は消さない。 */
export async function setLang(l: Lang): Promise<void> {
  apply(l);
  try {
    const st = typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
    if (!st) return;
    const cur = ((await st.get(SETTINGS_KEY))[SETTINGS_KEY] as RecordSettings | undefined) ?? {};
    await st.set({ [SETTINGS_KEY]: { ...cur, lang: l } });
  } catch { /* 保存できなくても、このページの表示は切り替わっている */ }
}

let inited = false;
/** 保存済みの言語を読み、ほかのページでの切り替え（storage の変更）も購読する。ページごとに 1 回だけ。 */
export function initLang(): void {
  if (inited) return;
  inited = true;
  try {
    const st = typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
    if (!st) return;
    void st.get(SETTINGS_KEY).then((r) => apply((r[SETTINGS_KEY] as RecordSettings | undefined)?.lang), () => undefined);
    chrome.storage.onChanged?.addListener((ch, area) => { if (area === 'local' && SETTINGS_KEY in ch) apply((ch[SETTINGS_KEY].newValue as RecordSettings | undefined)?.lang); });
  } catch { /* 既定（日本語）のまま */ }
}

/** 言語の変更で再描画させる。lang と t を返す。 */
export function useI18n(): { lang: Lang; t: typeof t } {
  const [, force] = useState(0);
  useEffect(() => {
    initLang();
    const f = () => force((x) => x + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return { lang: current, t };
}

// ---- 共有ラベル（shared の値から表示名を引く。キーは辞書に持つ） ------------------------------

const has = (key: string): key is TKey => key in ja;
const lookup = (prefix: string, v: string): string => { const k = `${prefix}.${v}`; return has(k) ? t(k) : v; };

export const originLabel = (o: string): string => lookup('origin', o);
export const statusLabel = (s: string): string => lookup('status', s);
export const phaseLabel = (p: string): string => lookup('phase', p);
export const replayStatusLabel = (s: string): string => lookup('rs', s);
export const runStatusLabel = (s: string): string => lookup('run', s);

/**
 * shared が日本語で返す定型の検査メッセージを、表示言語に合わせて置き換える。
 * 辞書にない文言（動的な値を含むもの、記録データ由来のもの）はそのまま返す。
 */
const KNOWN: Map<string, TKey> = new Map((Object.keys(ja) as TKey[]).filter((k) => k.startsWith('known.')).map((k) => [ja[k], k]));
export function trKnown(msg: string): string {
  if (current === 'ja') return msg;
  const k = KNOWN.get(msg);
  return k ? t(k) : msg;
}
