// 画面プレビュー: 記録した DOM スナップショットを、外部へ通信せず・スクリプトを動かさずに表示するための処理。
// - 一致の判定は、読み込みの起きない文書（DOMParser）の上で、記録した属性のまま行う
// - 表示用の文書は、読み込みを起こす属性（src・srcset・外部の href など）を外し、CSP で通信を禁じたうえで iframe に入れる
// - 各要素に data-tl-i（通し番号）を付け、判定用の文書と表示用の文書の要素を対応づける
// - 要素の位置は、記録時に付けた data-tracelens-box（DOM の取得時点・トップのビューポート基準）を使う。
//   画像の取得時刻とは別の時点の位置であり、画像と一致する保証はない
import type { FormStateEntry, Rect, ScreenshotMeta } from '../shared/types';
import { BOX_ATTR } from '../shared/domSerialize';

export const INDEX_ATTR = 'data-tl-i';
export const HIT_ATTR = 'data-tl-hit';
export const HOVER_ATTR = 'data-tl-hover';
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; frame-src 'none'; form-action 'none'";

export interface PreparedSnapshot {
  /** 判定用（記録した属性のまま。読み込みは起きない） */
  doc: Document;
  /** 表示用の HTML（iframe の srcdoc に入れる） */
  srcdoc: string;
  elementCount: number;
}

/** 読み込みを起こす属性・要素を外す（表示用の文書だけに適用する） */
const DROP_TAGS = new Set(['script', 'noscript', 'link', 'meta', 'base', 'object', 'embed', 'applet', 'portal']);
const LOAD_ATTRS = new Set(['src', 'srcset', 'poster', 'background', 'data', 'ping', 'lowsrc', 'dynsrc', 'srcdoc', 'imagesrcset', 'manifest', 'codebase', 'archive', 'longdesc', 'cite', 'formaction', 'action']);
const URL_IN_CSS = /url\s*\([^)]*\)|@import[^;]*;?/gi;

function eachElement(root: ParentNode, fn: (el: Element) => void) {
  const walk = (n: ParentNode) => {
    for (const el of Array.from(n.children)) {
      fn(el);
      walk(el);
      if (el.tagName.toLowerCase() === 'template') walk((el as HTMLTemplateElement).content);
    }
  };
  walk(root);
}

function sanitizeForDisplay(doc: Document) {
  const drop: Element[] = [];
  eachElement(doc, (el) => {
    const tag = el.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) { drop.push(el); return; }
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if (LOAD_ATTRS.has(n)) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'xlink:href') && tag !== 'a' && tag !== 'area') el.removeAttribute(a.name);
      else if (n === 'style' && URL_IN_CSS.test(a.value)) el.setAttribute('style', a.value.replace(URL_IN_CSS, 'none'));
      URL_IN_CSS.lastIndex = 0;
    }
    if (tag === 'style') el.textContent = (el.textContent ?? '').replace(URL_IN_CSS, '');
    if (tag === 'img') el.setAttribute('data-tl-img', '');
    if (tag === 'iframe' || tag === 'frame') el.setAttribute('data-tl-frame', '');
  });
  drop.forEach((el) => el.remove());
}

/** フォームの現在値（formState）を表示用の文書に反映する。機密欄（redacted）は反映しない */
function applyFormState(doc: Document, formState: FormStateEntry[] = []) {
  const byRef = new Map(formState.map((f) => [String(f.ref), f]));
  for (const el of Array.from(doc.querySelectorAll('[data-tracelens-ref]'))) {
    const f = byRef.get(el.getAttribute('data-tracelens-ref') ?? '');
    if (!f || f.redacted) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const vals = new Set(f.selectedValues ?? (f.value !== undefined ? [f.value] : []));
      for (const o of Array.from(el.querySelectorAll('option'))) { if (vals.has(o.getAttribute('value') ?? o.textContent ?? '')) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
    } else if (f.checked !== undefined) { if (f.checked) el.setAttribute('checked', ''); else el.removeAttribute('checked'); }
    else if (tag === 'textarea') el.textContent = f.value ?? '';
    else if (f.type !== 'file' && f.value !== undefined) el.setAttribute('value', f.value);
  }
}

const PREVIEW_STYLE = `
[${HIT_ATTR}]{outline:3px solid #e07b00 !important;outline-offset:-2px;background-color:rgba(224,123,0,.16) !important}
[${HOVER_ATTR}]{outline:2px dashed #2f6f8f !important;outline-offset:-1px}
[data-tl-img]{display:inline-block;min-width:16px;min-height:16px;background:repeating-linear-gradient(45deg,#ddd 0 6px,#eee 6px 12px)}
[data-tl-frame]{border:1px dashed #999;background:#f4f4f4}
`;

export function prepareSnapshot(html: string, formState?: FormStateEntry[]): PreparedSnapshot {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  let i = 0;
  eachElement(doc, (el) => { el.setAttribute(INDEX_ATTR, String(i++)); });
  const view = parser.parseFromString(`<!DOCTYPE html>${doc.documentElement.outerHTML}`, 'text/html');
  sanitizeForDisplay(view);
  applyFormState(view, formState);
  const head = view.head ?? view.documentElement.insertBefore(view.createElement('head'), view.body);
  const style = view.createElement('style'); style.textContent = PREVIEW_STYLE;
  head.prepend(style);
  // CSP は先頭に置く（以降の要素の読み込みに適用されるため）
  const meta = view.createElement('meta'); meta.setAttribute('http-equiv', 'Content-Security-Policy'); meta.setAttribute('content', PREVIEW_CSP);
  head.prepend(meta);
  return { doc, srcdoc: `<!DOCTYPE html>${view.documentElement.outerHTML}`, elementCount: i };
}

export type MatchResult = { ok: true; elements: Element[] } | { ok: false; error: string };

/** 記録した DOM でのセレクターの一致。シャドウ DOM 内（template に展開した部分）は対象外 */
export function matchSelector(doc: Document, language: 'css' | 'xpath', selector: string): MatchResult {
  const sel = selector.trim();
  if (!sel) return { ok: true, elements: [] };
  try {
    if (language === 'css') return { ok: true, elements: Array.from(doc.querySelectorAll(sel)) };
    const r = doc.evaluate(sel, doc, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
    const out: Element[] = [];
    for (let k = 0; k < r.snapshotLength; k++) { const n = r.snapshotItem(k); if (n && n.nodeType === 1) out.push(n as Element); }
    return { ok: true, elements: out };
  } catch (e) { return { ok: false, error: String((e as Error)?.message || e) }; }
}

export function indexOf(el: Element): string | null { return el.getAttribute(INDEX_ATTR); }

/** 記録時の要素の位置（DOM の取得時点・トップのビューポート基準, CSS px）。記録していなければ null */
export function boxOf(el: Element): Rect | null {
  const v = el.getAttribute(BOX_ATTR);
  if (!v) return null;
  const n = v.split(',').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[2] <= 0 || n[3] <= 0) return null;
  return { x: n[0], y: n[1], width: n[2], height: n[3] };
}

/**
 * DOM の位置を画像に重ねてよいか。ビューポートの大きさとスクロール位置が、DOM の取得時と画像の取得時で同じ場合だけ。
 * 同じでも、取得時刻の間に画面が変わっていればずれる（呼び出し側で時刻を併記する）。
 */
export function overlayCheck(boxViewport: { width: number; height: number; scrollX: number; scrollY: number } | undefined, shotMeta: ScreenshotMeta | undefined): { ok: true } | { ok: false; reason: string } {
  if (!boxViewport) return { ok: false, reason: 'この DOM には要素の位置を記録していない（以前の記録・クロスオリジンのフレーム内など）' };
  const vp = shotMeta?.viewport;
  if (!vp) return { ok: false, reason: '画像のビューポートの情報がない' };
  if (vp.width !== boxViewport.width || vp.height !== boxViewport.height) return { ok: false, reason: 'DOM の取得時と画像の取得時でビューポートの大きさが異なる' };
  if (vp.scrollX !== boxViewport.scrollX || vp.scrollY !== boxViewport.scrollY) return { ok: false, reason: 'DOM の取得時と画像の取得時でスクロール位置が異なる' };
  return { ok: true };
}
