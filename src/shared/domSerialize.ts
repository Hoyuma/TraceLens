// 操作時点の DOM を文字列化する。
// - script/style の中身は保存しない
// - 機密欄の value 属性は出力しない。フォームの現在値は formState に別途保存（機密欄は redacted）
// - open Shadow DOM は <template shadowrootmode="open"> として展開
// - iframe の中身は展開しない（フレーム内で操作があれば、そのフレーム自身のスナップショットを取る）
// - box を渡すと、各要素に data-tracelens-box="x,y,w,h"（取得時点の位置。トップのビューポート基準, CSS px）を付ける。
//   レビュー画面で、セレクターに一致した要素を画像の上に示すためのもの。画像の取得時刻とは別の時点の位置。
import type { FormStateEntry } from './types';
import { isSensitiveField } from './sensitive';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const OWN_TAG = 'tracelens-overlay';

function escText(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s: string): string { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

export interface SerializeResult { html: string; formState: FormStateEntry[]; truncated: boolean }
export const BOX_ATTR = 'data-tracelens-box';

export function serializeDom(root: Node, maxChars = 3_000_000, collectForm = true, box?: (el: Element) => string | null): SerializeResult {
  const out: string[] = [];
  const formState: FormStateEntry[] = [];
  let size = 0;
  let truncated = false;
  let ref = 0;
  const emit = (s: string) => { if (truncated) return; if (size + s.length > maxChars) { truncated = true; out.push('<!-- TraceLens: サイズ上限のため以降を省略 -->'); return; } out.push(s); size += s.length; };

  const walk = (node: Node): void => {
    if (truncated) return;
    if (node.nodeType === 3) { emit(escText(node.nodeValue || '')); return; }
    if (node.nodeType === 9 || node.nodeType === 11) { node.childNodes.forEach(walk); return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === OWN_TAG) return; // TraceLens 自身のオーバーレイは記録に含めない
    const sensitive = isSensitiveField(el);
    let s = `<${tag}`;
    for (const a of Array.from(el.attributes)) {
      if (sensitive && a.name.toLowerCase() === 'value') continue;
      if (a.name.toLowerCase() === BOX_ATTR) continue; // ページ自身が持つ同名の属性は、位置の記録と混同しないよう出力しない
      s += ` ${a.name}="${escAttr(a.value)}"`;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const r = ++ref;
      s += ` data-tracelens-ref="${r}"`;
      if (collectForm) formState.push(formEntry(el, r, sensitive));
    }
    if (tag === 'iframe' || tag === 'frame') {
      let access = 'cross-origin-inaccessible';
      try { if ((el as HTMLIFrameElement).contentDocument) access = 'same-origin-not-inlined'; } catch { /* cross-origin */ }
      s += ` data-tracelens-frame="${access}"`;
    }
    if (tag === 'canvas') s += ' data-tracelens-note="canvas-content-not-captured"';
    if (box) { const b = box(el); if (b) s += ` ${BOX_ATTR}="${b}"`; }
    emit(s + '>');
    if (VOID.has(tag)) return;
    if (tag === 'script' || tag === 'style') { emit(`/* TraceLens: ${tag} の内容は保存しない */`); }
    else if (tag === 'textarea') { /* 現在値は formState 側。初期値テキストは機密欄以外のみ */ if (!sensitive) emit(escText(el.textContent || '')); }
    else {
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) { emit('<template shadowrootmode="open">'); sr.childNodes.forEach(walk); emit('</template>'); }
      el.childNodes.forEach(walk);
    }
    emit(`</${tag}>`);
  };
  walk(root);
  return { html: out.join(''), formState, truncated };
}

function formEntry(el: Element, ref: number, sensitive: boolean): FormStateEntry {
  const tag = el.tagName.toLowerCase();
  const e: FormStateEntry = { ref, tag };
  const type = el.getAttribute('type'); if (type) e.type = type.toLowerCase();
  const name = el.getAttribute('name'); if (name) e.name = name;
  const id = el.getAttribute('id'); if (id) e.id = id;
  if ((el as HTMLInputElement).disabled) e.disabled = true;
  if (sensitive) { e.redacted = true; return e; }
  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    e.selectedValues = Array.from(sel.selectedOptions).map((o) => o.value);
    e.value = sel.value;
  } else if (tag === 'input' && (e.type === 'checkbox' || e.type === 'radio')) {
    e.checked = (el as HTMLInputElement).checked;
    e.value = (el as HTMLInputElement).value;
  } else if (tag === 'input' && e.type === 'file') {
    e.value = `(ファイル ${((el as HTMLInputElement).files || []).length} 件: 内容は保存しない)`;
  } else {
    e.value = (el as HTMLInputElement).value;
  }
  return e;
}
