// セレクター候補の生成。各候補が「記録時点で何件に一致したか」を併記する。
// 安定性は検証していないため 'unverified' か 'suspect'(動的・位置依存の疑い) のみを付ける。
import type { SelectorCandidate } from './types';

/** id からセレクターを作る。単純な識別子は #id、それ以外（数字始まり・記号・非ASCII）は属性セレクターにしてエスケープの差異を避ける */
export function idSelector(id: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ? `#${id}` : `[id="${attrEscape(id)}"]`;
}
function attrEscape(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

const DYNAMIC_ID_PATTERNS: [RegExp, string][] = [
  [/\d{4,}/, '4桁以上の連番・数値を含む'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-/i, 'UUID形式を含む'],
  [/[0-9a-f]{8,}/i, '長い16進文字列を含む'],
  [/^(:r|ember|react-|mui-|radix-|headlessui-|ext-gen|yui_|gwt-|__)/i, 'フレームワーク自動生成の接頭辞'],
];

export function dynamicIdSuspicion(id: string): string | null {
  for (const [re, why] of DYNAMIC_ID_PATTERNS) if (re.test(id)) return why;
  return null;
}

type Root = Document | ShadowRoot;
function rootOf(el: Element): Root { return el.getRootNode() as Root; }
function count(root: Root, sel: string): number | null { try { return root.querySelectorAll(sel).length; } catch { return null; } }
function countXPath(doc: Document, xp: string): number | null {
  try { return doc.evaluate(`count(${xp})`, doc, null, 1 /* NUMBER_TYPE */, null).numberValue; } catch { return null; }
}
function xpLiteral(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return 'concat(' + s.split('"').map((p) => `"${p}"`).join(`, '"', `) + ')';
}

const TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy'];
const UNVERIFIED = '記録時点の一致件数のみ確認。画面や日をまたいだ安定性は未検証';

export function cssPath(el: Element): { selector: string; anchoredById: boolean } {
  const parts: string[] = [];
  let cur: Element | null = el;
  let anchored = false;
  while (cur && cur.nodeType === 1) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'html') { parts.unshift('html'); break; }
    const id = cur.getAttribute('id');
    if (id && cur !== el && !dynamicIdSuspicion(id) && count(rootOf(cur), idSelector(id)) === 1) {
      parts.unshift(idSelector(id)); anchored = true; break;
    }
    let part = tag;
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return { selector: parts.join(' > '), anchoredById: anchored };
}

export function buildSelectorCandidates(el: Element): SelectorCandidate[] {
  const out: SelectorCandidate[] = [];
  const root = rootOf(el);
  const scope: SelectorCandidate['scope'] = root.nodeType === 11 ? 'shadow-root' : 'document';
  const tag = el.tagName.toLowerCase();
  const push = (kind: SelectorCandidate['kind'], selector: string, suspect: string | null, note = UNVERIFIED) =>
    out.push({ kind, selector, language: 'css', matchCount: count(root, selector), scope, stability: suspect ? 'suspect' : 'unverified', stabilityNote: suspect ? `動的生成の疑い（${suspect}）。再読込後に変わる可能性があり、安定性は不明` : note });

  const id = el.getAttribute('id');
  if (id) push('id', idSelector(id), dynamicIdSuspicion(id));
  for (const a of TEST_ATTRS) { const v = el.getAttribute(a); if (v) push('test-attribute', `[${a}="${attrEscape(v)}"]`, null); }
  const name = el.getAttribute('name');
  if (name) push('name', `${tag}[name="${attrEscape(name)}"]`, dynamicIdSuspicion(name));
  const aria = el.getAttribute('aria-label');
  if (aria) push('aria-label', `${tag}[aria-label="${attrEscape(aria)}"]`, null, UNVERIFIED + '。表示言語や文言変更の影響を受ける');
  const href = tag === 'a' ? el.getAttribute('href') : null;
  if (href && href.length < 200) push('href', `a[href="${attrEscape(href)}"]`, null);

  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const doc = el.ownerDocument;
  if (scope === 'document' && text && text.length <= 60 && (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button' || tag === 'label' || tag === 'option')) {
    const xp = `//${tag}[normalize-space(.)=${xpLiteral(text)}]`;
    out.push({ kind: 'text-xpath', selector: xp, language: 'xpath', matchCount: countXPath(doc, xp), scope, stability: 'unverified', stabilityNote: UNVERIFIED + '。表示文言の変更の影響を受ける' });
  }

  const p = cssPath(el);
  out.push({ kind: 'css-path', selector: p.selector, language: 'css', matchCount: count(root, p.selector), scope, stability: 'suspect', stabilityNote: '位置依存（nth-of-type等）のセレクター。行の追加・並び替えで別要素を指す可能性があり、安定性は不明' });
  return out;
}
