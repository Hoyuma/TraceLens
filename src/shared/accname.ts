// Accessible Name / role の計算。
// W3C「Accessible Name and Description Computation 1.2」と HTML-AAM の主要部分を、外部ライブラリなしで実装した簡易版。
//
// 【限界（断定しない）】
//  - ブラウザが実際に公開する名前と一致するとは保証しない。ブラウザとの一致は未検証。
//  - 扱わないもの: CSS の生成内容(::before / ::after)、closed Shadow DOM、レイアウトに依存する可視判定の一部
//    （位置・サイズ・clip・opacity など。display:none / visibility:hidden / hidden 属性 / aria-hidden のみ）、
//    SVG 内の <title>/<desc>、CSS による text-transform などの表示上の変換、aria-describedby（説明は計算しない）、
//    ブラウザ固有の差（既定ラベルの翻訳、<summary> や <input type=file> の扱いなど）。
//  - 機密欄（sensitive.ts の判定）の値は、埋め込みコントロールの値としても value 由来の名前としても使わない。
import { isSensitiveField } from './sensitive';

export type RoleSource = 'explicit' | 'implicit-html-aam' | 'none';
export interface ComputedRole { value: string | null; source: RoleSource; note?: string }
export interface ComputedName { value: string; rule: string; ruleLabel: string; note: string }

export const ACCNAME_NOTE = '計算した名前（accname 準拠の実装による。ブラウザの結果との一致は未検証。CSS 生成内容・closed Shadow DOM・レイアウト依存の可視判定の一部・ブラウザ固有の差は扱えない）';
export const ROLE_NOTE = '計算した role（ARIA の明示 role と HTML-AAM の暗黙 role の主要部分による。ブラウザの結果との一致は未検証）';

export const RULE_LABEL: Record<string, string> = {
  'aria-labelledby': 'aria-labelledby の参照先から計算（規則 2B）',
  'aria-label': 'aria-label 属性（規則 2C）',
  'native-label': 'ネイティブのラベル（label 要素）（規則 2D）',
  'native-alt': 'alt 属性（規則 2D）',
  'native-value': 'ボタン系の value 属性（規則 2D）',
  'native-legend': 'fieldset の legend（規則 2D）',
  'native-caption': 'table の caption（規則 2D）',
  'native-figcaption': 'figure の figcaption（規則 2D）',
  'native-title': 'title 属性（規則 2D/2I）',
  'native-placeholder': 'placeholder 属性（規則 2D。順位は title の後）',
  'native-option-label': 'option/optgroup の label 属性（規則 2D）',
  content: '内容からの名前（規則 2F）',
  'embedded-value': '埋め込みコントロールの値（規則 2E）',
  none: '名前を計算できなかった',
};

// ---------- role ----------

const ARIA_ROLES = new Set(`alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem`.split(/\s+/));

const NAME_FROM_CONTENT = new Set(['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem']);

const SECTIONING = 'article, aside, main, nav, section';

const INPUT_TYPE_ROLE: Record<string, string | null> = {
  button: 'button', image: 'button', reset: 'button', submit: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox', password: 'textbox',
  color: null, date: null, 'datetime-local': null, file: null, month: null, time: null, week: null, hidden: null,
};

/** 暗黙 role（HTML-AAM の主要部分）。名前に依存して決まるもの(form/section)は withName で切り替える。 */
function implicitRole(el: Element, withName: boolean): { role: string | null; note?: string } {
  const tag = el.tagName.toLowerCase();
  const attr = (n: string) => el.getAttribute(n);
  switch (tag) {
    case 'a': case 'area': return attr('href') !== null ? { role: 'link' } : { role: 'generic' };
    case 'article': return { role: 'article' };
    case 'aside': return { role: 'complementary' };
    case 'button': return { role: 'button' };
    case 'datalist': return { role: 'listbox' };
    case 'dd': return { role: 'definition' };
    case 'dt': return { role: 'term' };
    case 'details': case 'fieldset': case 'optgroup': return { role: 'group' };
    case 'dialog': return { role: 'dialog' };
    case 'figure': return { role: 'figure' };
    case 'footer': return { role: el.closest(`${SECTIONING}, [role="article"], [role="main"]`) ? 'generic' : 'contentinfo' };
    case 'header': return { role: el.closest(`${SECTIONING}, [role="article"], [role="main"]`) ? 'generic' : 'banner' };
    // form / section は名前がある場合だけ form / region（名前が無ければ generic）
    case 'form': return { role: withName && !computeAccessibleName(el).value ? 'generic' : 'form' };
    case 'section': return { role: withName && !computeAccessibleName(el).value ? 'generic' : 'region' };
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return { role: 'heading' };
    case 'hr': return { role: 'separator' };
    case 'html': return { role: 'document' };
    case 'img': return attr('alt') === '' ? { role: 'presentation', note: 'alt が空のため装飾画像（presentation）' } : { role: 'img' };
    case 'input': {
      const type = (attr('type') || 'text').toLowerCase();
      if (!(type in INPUT_TYPE_ROLE)) return { role: 'textbox', note: '未知の type はテキスト入力として扱う' };
      const base = INPUT_TYPE_ROLE[type];
      if ((type === 'text' || type === 'email' || type === 'tel' || type === 'url' || type === 'search') && el.hasAttribute('list')) return { role: 'combobox' };
      return { role: base };
    }
    case 'li': return { role: el.parentElement && /^(ul|ol|menu)$/i.test(el.parentElement.tagName) ? 'listitem' : 'generic' };
    case 'main': return { role: 'main' };
    case 'math': return { role: 'math' };
    case 'menu': case 'ol': case 'ul': return { role: 'list' };
    case 'meter': return { role: 'meter' };
    case 'nav': return { role: 'navigation' };
    case 'option': return { role: 'option' };
    case 'output': return { role: 'status' };
    case 'p': return { role: 'paragraph' };
    case 'progress': return { role: 'progressbar' };
    case 'select': return { role: el.hasAttribute('multiple') || Number(attr('size')) > 1 ? 'listbox' : 'combobox' };
    case 'summary': return { role: 'button', note: 'HTML-AAM では対応する role なし。ブラウザの実装に合わせて button とした' };
    case 'table': return { role: 'table' };
    case 'tbody': case 'thead': case 'tfoot': return { role: 'rowgroup' };
    case 'td': { const t = el.closest('table'); const tr = t?.getAttribute('role'); return { role: tr === 'grid' || tr === 'treegrid' ? 'gridcell' : 'cell' }; }
    case 'th': { const sc = (attr('scope') || '').toLowerCase(); return { role: sc === 'row' || sc === 'rowgroup' ? 'rowheader' : 'columnheader', note: 'scope 属性のみで判定（表の構造からの推定はしない）' }; }
    case 'tr': return { role: 'row' };
    case 'textarea': return { role: 'textbox' };
    case 'caption': return { role: 'caption' };
    case 'code': return { role: 'code' };
    case 'em': return { role: 'emphasis' };
    case 'strong': return { role: 'strong' };
    case 'sub': return { role: 'subscript' };
    case 'sup': return { role: 'superscript' };
    case 'del': case 's': return { role: 'deletion' };
    case 'ins': return { role: 'insertion' };
    case 'time': return { role: 'time' };
    case 'blockquote': return { role: 'blockquote' };
    case 'search': return { role: 'search' };
    case 'div': case 'span': case 'body': return { role: 'generic' };
    default: return { role: null };
  }
}

function roleOf(el: Element, withName: boolean): ComputedRole {
  const raw = el.getAttribute('role');
  if (raw !== null) {
    const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const first = tokens.find((t) => ARIA_ROLES.has(t));
    if (first) return { value: first, source: 'explicit', note: tokens[0] !== first ? '先頭のトークンが無効だったため、次の有効なトークンを採用' : undefined };
    if (tokens.length) {
      const imp = implicitRole(el, withName);
      return { value: imp.role, source: imp.role ? 'implicit-html-aam' : 'none', note: `role 属性「${raw}」に有効なトークンがないため暗黙 role を使用` };
    }
  }
  const imp = implicitRole(el, withName);
  return imp.role ? { value: imp.role, source: 'implicit-html-aam', note: imp.note } : { value: null, source: 'none', note: imp.note };
}

/**
 * role を計算する。
 * 扱わない: presentational role の競合解決（フォーカス可能な要素に none が指定された場合など）、
 * 親子関係で変わる role（th の厳密な行/列判定など）、ブラウザ固有の差。
 */
export function computeRole(el: Element): ComputedRole { return roleOf(el, true); }

// ---------- name ----------

interface Ctx {
  /** 現在の再帰スタック（循環防止） */
  stack: Set<Node>;
  /** aria-labelledby の走査の途中か */
  inLabelledby: boolean;
  /** 名前計算の起点（ルート）ノード */
  root: Element;
  /** 非表示でも含める（aria-labelledby が直接参照した要素の部分木） */
  includeHidden: boolean;
  /** 子孫としての再帰か */
  isRecursion: boolean;
}
interface Res { text: string; rule: string }
const EMPTY: Res = { text: '', rule: 'none' };

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function isHiddenNode(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return true;
  try {
    const view = el.ownerDocument.defaultView;
    const cs = view?.getComputedStyle(el);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse')) return true;
  } catch { /* 取得できなければ可視として扱う（レイアウト依存の判定は扱わない） */ }
  return false;
}

const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', 'title', 'meta', 'link']);

function isInlineDisplay(el: Element): boolean {
  try {
    const d = el.ownerDocument.defaultView?.getComputedStyle(el).display;
    return !d || d === 'inline' || d === 'contents' || d.startsWith('inline');
  } catch { return true; }
}

function labelsOf(el: Element): Element[] {
  const tag = el.tagName.toLowerCase();
  const labelable = tag === 'button' || tag === 'meter' || tag === 'output' || tag === 'progress' || tag === 'select' || tag === 'textarea' || (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() !== 'hidden');
  if (!labelable) return [];
  const native = (el as HTMLInputElement).labels;
  if (native && native.length) return Array.from(native);
  const out: Element[] = [];
  const id = el.getAttribute('id');
  const root = el.getRootNode() as Document | ShadowRoot;
  if (id && 'querySelectorAll' in root) root.querySelectorAll('label[for]').forEach((l) => { if (l.getAttribute('for') === id) out.push(l); });
  const wrap = el.closest('label');
  if (wrap && !wrap.hasAttribute('for') && !out.includes(wrap)) out.push(wrap);
  return out;
}

function idRefs(el: Element, attr: string): Element[] {
  const v = el.getAttribute(attr);
  if (!v) return [];
  const root = el.getRootNode() as Document | ShadowRoot;
  const out: Element[] = [];
  for (const id of v.split(/\s+/).filter(Boolean)) {
    const t = 'getElementById' in root ? (root as Document).getElementById(id) : (root as ShadowRoot).querySelector(`[id="${id.replace(/"/g, '\\"')}"]`);
    if (t) out.push(t);
  }
  return out;
}

/** 埋め込みコントロールの値（規則 2E）。機密欄は値を返さない。 */
function embeddedValue(el: Element, role: string | null): string | null {
  if (isSensitiveField(el)) return null;
  const tag = el.tagName.toLowerCase();
  if (role === 'textbox' || role === 'searchbox') {
    if (tag === 'input' || tag === 'textarea') return (el as HTMLInputElement).value;
    if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') !== null) return el.textContent ?? '';
    return null;
  }
  if (role === 'combobox' || role === 'listbox') {
    if (tag === 'select') return Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.label || o.textContent || '').join(' ');
    if (tag === 'input') return (el as HTMLInputElement).value;
    const sel = el.querySelectorAll('[role="option"][aria-selected="true"]');
    if (sel.length) return Array.from(sel).map((o) => o.textContent ?? '').join(' ');
    return null;
  }
  if (role === 'slider' || role === 'spinbutton' || role === 'scrollbar' || role === 'progressbar' || role === 'meter') {
    const vt = el.getAttribute('aria-valuetext');
    if (vt) return vt;
    const vn = el.getAttribute('aria-valuenow');
    if (vn) return vn;
    if (tag === 'input') return (el as HTMLInputElement).value;
    return null;
  }
  return null;
}

function compute(el: Element, ctx: Ctx): Res {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return EMPTY;
  if (ctx.stack.has(el)) return EMPTY; // 循環参照・自己参照の防止
  // 2A: 非表示（aria-labelledby が直接参照した要素の部分木は含める）
  isSensitiveField(el); // 観測した時点で機密欄を印付けする（後で type が切り替わっても値を使わない）
  if (!ctx.includeHidden && el !== ctx.root && isHiddenNode(el)) return EMPTY;
  ctx.stack.add(el);
  try {
    const role = roleOf(el, false).value;
    const isRoot = el === ctx.root;

    // 2B: aria-labelledby（走査の途中でなければ）
    if (!ctx.inLabelledby) {
      const refs = idRefs(el, 'aria-labelledby');
      if (refs.length) {
        // 自分自身への参照は許される（循環防止のスタックから自分を外して計算する）
        const parts = refs.map((r) => compute(r, { ...ctx, stack: r === el ? new Set([...ctx.stack].filter((x) => x !== el)) : ctx.stack, inLabelledby: true, includeHidden: true, isRecursion: true }).text);
        const joined = clean(parts.join(' '));
        if (joined) return { text: joined, rule: 'aria-labelledby' };
      }
    }

    // 2E(先頭に評価): 部分木の再帰中に出会った埋め込みコントロールは値を使う（aria-label より優先）
    let embeddedHandled = false;
    if (ctx.isRecursion && !isRoot && role && /^(textbox|searchbox|combobox|listbox|slider|spinbutton|scrollbar)$/.test(role)) {
      embeddedHandled = true;
      const v = embeddedValue(el, role);
      if (v !== null && clean(v)) return { text: clean(v), rule: 'embedded-value' };
    }

    // 2C: aria-label
    const al = el.getAttribute('aria-label');
    if (!embeddedHandled && al !== null && clean(al)) return { text: clean(al), rule: 'aria-label' };

    // 2D: ネイティブの名前
    const nat = nativeName(el, ctx);
    if (nat.text) return nat;

    // 2F: 内容からの名前
    const tag = el.tagName.toLowerCase();
    const allowContent = NAME_FROM_CONTENT.has(role ?? '') || ctx.isRecursion || ctx.inLabelledby;
    if (allowContent && tag !== 'img' && tag !== 'input' && tag !== 'textarea' && tag !== 'select' && role !== 'img') {
      const t = fromChildren(el, ctx);
      if (clean(t)) return { text: t, rule: 'content' };
    }

    // 2I: ツールチップ属性
    const title = el.getAttribute('title');
    if (title !== null && clean(title)) return { text: clean(title), rule: 'native-title' };
    return EMPTY;
  } finally {
    ctx.stack.delete(el);
  }
}

function labelText(label: Element, target: Element, ctx: Ctx): string {
  // ラベル内のコントロール自身は再帰しない（自己参照の防止。値を名前に含めない）
  const stack = new Set(ctx.stack); stack.add(target);
  return compute(label, { stack, inLabelledby: false, root: label, includeHidden: false, isRecursion: true }).text;
}

function nativeName(el: Element, ctx: Ctx): Res {
  const tag = el.tagName.toLowerCase();
  const attr = (n: string) => el.getAttribute(n);
  const nonEmpty = (v: string | null) => (v !== null && clean(v) ? clean(v) : '');
  const labels = () => clean(labelsOf(el).map((l) => labelText(l, el, ctx)).filter(Boolean).join(' '));
  const title = () => nonEmpty(attr('title'));

  if (tag === 'input') {
    const type = (attr('type') || 'text').toLowerCase();
    if (type === 'hidden') return EMPTY;
    if (type === 'button' || type === 'submit' || type === 'reset') {
      // value は機密欄では使わない（type 切替後の password 等）
      const v = isSensitiveField(el) ? '' : nonEmpty(attr('value'));
      if (v) return { text: v, rule: 'native-value' };
      const l = labels(); if (l) return { text: l, rule: 'native-label' };
      const t = title(); if (t) return { text: t, rule: 'native-title' };
      return EMPTY;
    }
    if (type === 'image') {
      const a = nonEmpty(attr('alt')); if (a) return { text: a, rule: 'native-alt' };
      const l = labels(); if (l) return { text: l, rule: 'native-label' };
      const t = title(); if (t) return { text: t, rule: 'native-title' };
      return EMPTY;
    }
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'meter' || tag === 'progress' || tag === 'output') {
    const l = labels(); if (l) return { text: l, rule: 'native-label' };
    const t = title(); if (t) return { text: t, rule: 'native-title' };
    if (tag === 'input' || tag === 'textarea') { const p = nonEmpty(attr('placeholder')); if (p) return { text: p, rule: 'native-placeholder' }; }
    return EMPTY;
  }
  if (tag === 'button') {
    const l = labels(); if (l) return { text: l, rule: 'native-label' };
    return EMPTY; // 内容 → title は呼び出し側（2F, 2I）
  }
  if (tag === 'img' || tag === 'area') {
    const a = attr('alt');
    if (a !== null && clean(a)) return { text: clean(a), rule: 'native-alt' };
    const t = title(); if (t) return { text: t, rule: 'native-title' };
    return EMPTY;
  }
  if (tag === 'fieldset') {
    const lg = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'legend');
    if (lg) { const t = clean(compute(lg, { stack: new Set([...ctx.stack, el]), inLabelledby: false, root: lg, includeHidden: false, isRecursion: true }).text); if (t) return { text: t, rule: 'native-legend' }; }
    return EMPTY;
  }
  if (tag === 'table') {
    const cap = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'caption');
    if (cap) { const t = clean(compute(cap, { stack: new Set([...ctx.stack, el]), inLabelledby: false, root: cap, includeHidden: false, isRecursion: true }).text); if (t) return { text: t, rule: 'native-caption' }; }
    return EMPTY;
  }
  if (tag === 'figure') {
    const cap = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'figcaption');
    if (cap) { const t = clean(compute(cap, { stack: new Set([...ctx.stack, el]), inLabelledby: false, root: cap, includeHidden: false, isRecursion: true }).text); if (t) return { text: t, rule: 'native-figcaption' }; }
    return EMPTY;
  }
  if (tag === 'option' || tag === 'optgroup') {
    const l = nonEmpty(attr('label')); if (l) return { text: l, rule: 'native-option-label' };
  }
  return EMPTY;
}

function fromChildren(el: Element, ctx: Ctx): string {
  const nodes: Node[] = [];
  const sr = (el as HTMLElement).shadowRoot; // open な Shadow DOM のみ（closed は見えない）
  const source: Node[] = sr ? Array.from(sr.childNodes) : Array.from(el.childNodes);
  const expand = (n: Node) => {
    if (n.nodeType === 1 && (n as Element).tagName.toLowerCase() === 'slot' && typeof (n as HTMLSlotElement).assignedNodes === 'function') {
      const assigned = (n as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length) { assigned.forEach(expand); return; }
    }
    nodes.push(n);
  };
  source.forEach(expand);
  let out = '';
  for (const n of nodes) {
    if (n.nodeType === 3) { out += n.nodeValue ?? ''; continue; }
    if (n.nodeType !== 1) continue;
    const child = n as Element;
    const r = compute(child, { ...ctx, isRecursion: true });
    if (!r.text) continue;
    out += isInlineDisplay(child) ? r.text : ` ${r.text} `;
  }
  return out; // 空白の正規化は最後に一度だけ行う（インライン要素の前後の空白を保つ）
}

/**
 * Accessible Name を計算する。
 * 結果の rule は決まった規則の ID（RULE_LABEL 参照）。名前が空なら rule は 'none'。
 * ブラウザの結果との一致は保証しない（ファイル先頭の限界を参照）。
 */
export function computeAccessibleName(el: Element): ComputedName {
  // 起点自身が非表示でも名前は計算する（操作対象の記録が目的）。子孫の非表示は除外する。
  const ctx: Ctx = { stack: new Set(), inLabelledby: false, root: el, includeHidden: false, isRecursion: false };
  const r = compute(el, ctx);
  return { value: clean(r.text), rule: r.rule, ruleLabel: RULE_LABEL[r.rule] ?? r.rule, note: ACCNAME_NOTE };
}
