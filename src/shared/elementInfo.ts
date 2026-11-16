// 操作対象要素の情報を取得する。
// 名前(accessible name)は簡易推定の「候補」であり、完全な accname 計算の結果ではない。
import type { ElementInfo, ValueInfo } from './types';
import { buildSelectorCandidates, cssPath } from './selectors';
import { serializeDom } from './domSerialize';
import { isSensitiveField, REDACTED_NOTE } from './sensitive';

const IMPLICIT_ROLE: Record<string, string> = {
  button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', nav: 'navigation', main: 'main',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', table: 'table', tr: 'row', td: 'cell', th: 'columnheader',
  ul: 'list', ol: 'list', li: 'listitem', form: 'form', dialog: 'dialog', img: 'img', option: 'option', summary: 'button',
};
const INPUT_ROLE: Record<string, string> = {
  checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider',
  number: 'spinbutton', search: 'searchbox', text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox', '': 'textbox',
};
const KEEP_ATTRS = /^(data-|aria-)|^(class|for|title|href|value|autocomplete|maxlength|pattern|inputmode|tabindex|contenteditable|alt|src|action|method)$/i;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

function labelsOf(el: Element): string[] {
  const out: string[] = [];
  const ls = (el as HTMLInputElement).labels;
  if (ls) ls.forEach((l) => out.push(norm(l.textContent)));
  else {
    const wrap = el.closest('label'); if (wrap) out.push(norm(wrap.textContent));
    const id = el.getAttribute('id');
    if (id) el.ownerDocument.querySelectorAll('label').forEach((l) => { if (l.getAttribute('for') === id) out.push(norm(l.textContent)); });
  }
  return Array.from(new Set(out.filter(Boolean))).map((s) => clip(s, 200));
}

export function describeElement(el: Element): ElementInfo {
  const tag = el.tagName.toLowerCase();
  const sensitive = isSensitiveField(el);
  const type = el.getAttribute('type')?.toLowerCase();
  const explicitRole = el.getAttribute('role');
  let role: ElementInfo['role'] = { value: null, source: 'none' };
  if (explicitRole) role = { value: explicitRole, source: 'attribute' };
  else {
    const guess = tag === 'input' ? INPUT_ROLE[type || ''] : tag === 'a' && !el.hasAttribute('href') ? undefined : IMPLICIT_ROLE[tag];
    if (guess) role = { value: guess, source: 'implicit-heuristic' };
  }

  const labels = labelsOf(el);
  const names: { source: string; value: string }[] = [];
  const add = (source: string, v: string | null | undefined) => { const t = norm(v); if (t) names.push({ source, value: clip(t, 200) }); };
  const lb = el.getAttribute('aria-labelledby');
  if (lb) add('aria-labelledby', lb.split(/\s+/).map((i) => el.ownerDocument.getElementById(i)?.textContent || '').join(' '));
  add('aria-label', el.getAttribute('aria-label'));
  labels.forEach((l) => add('label', l));
  add('alt', el.getAttribute('alt'));
  if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) add('value', el.getAttribute('value'));
  const isFormField = tag === 'input' || tag === 'textarea' || tag === 'select';
  const text = isFormField ? '' : norm((el as HTMLElement).innerText ?? el.textContent);
  if (!isFormField) add('text', text);
  add('title', el.getAttribute('title'));
  add('placeholder', el.getAttribute('placeholder'));

  const state: Record<string, boolean | string> = {};
  const anyEl = el as HTMLInputElement;
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) state.checked = anyEl.checked;
  if ('disabled' in anyEl && anyEl.disabled) state.disabled = true;
  if (anyEl.readOnly) state.readOnly = true;
  if (anyEl.required) state.required = true;
  for (const a of ['aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked', 'aria-invalid', 'aria-disabled', 'aria-busy']) {
    const v = el.getAttribute(a); if (v !== null) state[a] = v;
  }
  if (tag === 'option') state.selected = (el as HTMLOptionElement).selected;

  const attributes: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (!KEEP_ATTRS.test(a.name)) continue;
    if (sensitive && a.name.toLowerCase() === 'value') continue;
    attributes[a.name] = clip(a.value, 300);
  }

  // 周辺DOM: 対象を含む小さめの祖先
  let ctx: Element = el;
  for (let i = 0; i < 3 && ctx.parentElement && ctx.parentElement.tagName !== 'BODY' && ctx.parentElement.tagName !== 'HTML'; i++) {
    if ((ctx.parentElement.outerHTML || '').length > 6000) break;
    ctx = ctx.parentElement;
  }
  const sur = serializeDom(ctx, 8000, false);

  const shadowPath: ElementInfo['shadowPath'] = [];
  let r = el.getRootNode();
  while (r && r.nodeType === 11 && (r as ShadowRoot).host) {
    const host = (r as ShadowRoot).host;
    shadowPath.unshift({ hostSelector: cssPath(host).selector, mode: 'open' });
    r = host.getRootNode();
  }

  const hints: string[] = [];
  if (tag === 'canvas') hints.push('canvas 要素: 内部の描画内容・構造は取得できない（位置のみ）');
  if (tag.includes('-') && !(el as HTMLElement).shadowRoot) hints.push('カスタム要素: closed Shadow DOM の可能性があり、内部は取得できない（open な Shadow DOM は検出されなかった）');
  if (tag === 'iframe') hints.push('iframe 要素自体が対象。フレーム内部の操作は、アクセス可能なフレームでのみ記録される');

  const b = el.getBoundingClientRect();
  const info: ElementInfo = {
    tag, role, nameCandidates: names,
    nameMethodNote: 'TraceLens の簡易推定による候補（aria属性・label・テキスト等の列挙）。完全な Accessible Name 計算の結果ではない',
    labels, state,
    rect: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
    attributes, selectors: buildSelectorCandidates(el),
    surroundingHtml: sur.html, surroundingTruncated: sur.truncated, shadowPath, hints,
  };
  const id = el.getAttribute('id'); if (id) info.id = id;
  const name = el.getAttribute('name'); if (name) info.name = name;
  if (type) info.type = type;
  if (text) info.text = clip(text, 200);
  const ph = el.getAttribute('placeholder'); if (ph) info.placeholder = ph;
  return info;
}

/** 入力・選択内容の読み取り。機密欄は値を読まない。 */
export function readValue(el: Element): ValueInfo | undefined {
  const tag = el.tagName.toLowerCase();
  if (isSensitiveField(el)) return { kind: 'redacted', redacted: true, redactionReason: REDACTED_NOTE };
  if (tag === 'select') {
    const s = el as HTMLSelectElement;
    const all = Array.from(s.options);
    return {
      kind: 'select',
      selectedOptions: Array.from(s.selectedOptions).map((o) => ({ value: o.value, label: norm(o.textContent), index: o.index })),
      availableOptions: all.slice(0, 200).map((o) => ({ value: o.value, label: norm(o.textContent), disabled: o.disabled })),
      availableOptionsTruncated: all.length > 200,
    };
  }
  if (tag === 'input') {
    const i = el as HTMLInputElement;
    const type = (i.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return { kind: 'checked', checked: i.checked, text: i.value };
    if (type === 'file') return { kind: 'files', text: Array.from(i.files || []).map((f) => f.name).join(', ') };
    return { kind: 'text', text: i.value };
  }
  if (tag === 'textarea') return { kind: 'text', text: (el as HTMLTextAreaElement).value };
  if ((el as HTMLElement).isContentEditable) return { kind: 'text', text: clip((el as HTMLElement).innerText || '', 5000) };
  return undefined;
}
