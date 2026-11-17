// 再生スクリプトの中核（ページ内で要素を特定し、操作し、待機条件を観測する）。
// chrome API に依存しない（jsdom で単体テストする）。
//
// 方針:
//  - 再生で起こすイベントは isTrusted=false。記録用スクリプトはこれを記録しない（原則 13）。
//    信頼されたイベントだけに反応するページでは操作が効かないため、待機の時間切れの理由にその可能性を書く。
//  - 機密欄（sensitive.ts の判定）には値を書き込まず manual を返す。入力値は結果・理由に書かない。
//  - 待機の observed は「条件を観測できた」であって業務処理の完了ではない。
import type { ReplaySelector, ResolvedReplayAction, WaitOutcome } from '../shared/replay';
import { DEFAULT_QUIET_MAX_MS, DEFAULT_QUIET_MS } from '../shared/replay';
import type { ReplayRunReply } from '../shared/messages';
import type { WaitCondition } from '../shared/types';
import { isSensitiveField, markSensitiveFields } from '../shared/sensitive';

export const OVERLAY_TAG = 'tracelens-replay-overlay';
const POLL_MS = 100;
/** 操作後の待機に最低限確保する時間（上限時間の直前に要素が見つかった場合でも観測する） */
const MIN_WAIT_AFTER_ACTION_MS = 1000;
export const UNTRUSTED_NOTE = '再生のイベントは isTrusted=false のため、信頼されたイベントだけに反応するページでは操作が効かない可能性がある';

const iso = () => new Date().toISOString();

// ---- 要素の特定 -----------------------------------------------------------------

export interface SelectorAttempt { language: 'css' | 'xpath'; selector: string; source: 'human' | 'recorded'; count: number | null; error?: string }

type Root = Document | ShadowRoot;

/** shadowPath をたどって ShadowRoot を得る（各ホストは一致 1 件のみ採用） */
export function resolveShadowRoot(doc: Document, path: readonly { hostSelector: string }[]): { root: Root } | { error: string } {
  let root: Root = doc;
  for (const hop of path) {
    let hosts: NodeListOf<Element>;
    try { hosts = root.querySelectorAll(hop.hostSelector); } catch { return { error: `Shadow ホストのセレクターが不正: ${hop.hostSelector}` }; }
    if (hosts.length !== 1) return { error: `Shadow ホスト ${hop.hostSelector} の一致が ${hosts.length} 件` };
    const sr = (hosts[0] as HTMLElement).shadowRoot;
    if (!sr) return { error: `Shadow ホスト ${hop.hostSelector} に open な ShadowRoot がない` };
    root = sr;
  }
  return { root };
}

/** 1 つのセレクターで検索する。xpath はドキュメント全体（Shadow 内は対象外）。 */
export function queryAll(doc: Document, sel: Pick<ReplaySelector, 'language' | 'selector' | 'scope'>, shadowPath: readonly { hostSelector: string }[]): { els: Element[] } | { error: string } {
  let root: Root = doc;
  if (sel.scope === 'shadow-root') {
    const r = resolveShadowRoot(doc, shadowPath);
    if ('error' in r) return r;
    root = r.root;
  }
  if (sel.language === 'xpath') {
    if (root !== doc) return { error: 'Shadow DOM 内では XPath を使えない' };
    try {
      const snap = doc.evaluate(sel.selector, doc, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
      const els: Element[] = [];
      for (let i = 0; i < snap.snapshotLength; i++) { const n = snap.snapshotItem(i); if (n && n.nodeType === 1) els.push(n as Element); }
      return { els };
    } catch { return { error: 'XPath が不正' }; }
  }
  try { return { els: [...root.querySelectorAll(sel.selector)].filter((e) => e.tagName.toLowerCase() !== OVERLAY_TAG) }; } catch { return { error: 'CSS セレクターが不正' }; }
}

export type FindResult =
  | { ok: true; el: Element; selector: ReplaySelector; attempts: SelectorAttempt[] }
  | { ok: false; reason: string; attempts: SelectorAttempt[] };

/** action.selectors を順に試し、一致が 1 件のものを採用する（0 件・複数件は次へ） */
export function findTarget(doc: Document, action: Pick<ResolvedReplayAction, 'selectors' | 'shadowPath'>): FindResult {
  const attempts: SelectorAttempt[] = [];
  for (const s of action.selectors) {
    const r = queryAll(doc, s, action.shadowPath);
    if ('error' in r) { attempts.push({ language: s.language, selector: s.selector, source: s.source, count: null, error: r.error }); continue; }
    attempts.push({ language: s.language, selector: s.selector, source: s.source, count: r.els.length });
    if (r.els.length === 1) return { ok: true, el: r.els[0], selector: s, attempts };
  }
  if (!action.selectors.length) return { ok: false, reason: '対象要素のセレクターがない', attempts };
  return { ok: false, reason: `一致が 1 件のセレクターがなかった（${describeAttempts(attempts)}）`, attempts };
}

export function describeAttempts(attempts: readonly SelectorAttempt[]): string {
  return attempts.map((a) => `${a.source === 'human' ? '人の指定 ' : ''}${a.language} ${a.selector}: ${a.error ? a.error : `${a.count} 件`}`).join(' / ');
}

// ---- 操作 -----------------------------------------------------------------------

const viewOf = (el: Element): (Window & typeof globalThis) => (el.ownerDocument.defaultView ?? window) as Window & typeof globalThis;

export function isTextInput(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden', 'file'].includes(((el as HTMLInputElement).type || '').toLowerCase());
}

/** 操作できない理由（無効化されているなど）。操作できるなら null。 */
export function notActionable(el: Element): string | null {
  if (!el.isConnected) return '対象要素がページから外れた';
  try { if (el.matches(':disabled')) return '対象要素が無効（disabled）'; } catch { /* ignore */ }
  return null;
}

function fire(el: Element, type: string, init: EventInit & Record<string, unknown> = {}, ctor: 'Event' | 'MouseEvent' | 'PointerEvent' | 'InputEvent' | 'KeyboardEvent' = 'Event'): boolean {
  const w = viewOf(el) as any;
  const C = w[ctor] ?? (ctor === 'PointerEvent' ? w.MouseEvent : w.Event);
  return el.dispatchEvent(new C(type, { bubbles: true, cancelable: true, composed: true, ...init }));
}

/** クリックの前段（ポインター・マウスのイベント列）を送り、クリックの座標を返す */
function pressSequence(el: Element): { clientX: number; clientY: number; button: number } {
  try { (el as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center' }); } catch { /* ignore */ }
  const r = el.getBoundingClientRect();
  const pos = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
  fire(el, 'pointerdown', { ...pos, pointerType: 'mouse', isPrimary: true, buttons: 1 }, 'PointerEvent');
  fire(el, 'mousedown', { ...pos, buttons: 1 }, 'MouseEvent');
  try { (el as HTMLElement).focus?.({ preventScroll: true }); } catch { /* ignore */ }
  fire(el, 'pointerup', { ...pos, pointerType: 'mouse', isPrimary: true }, 'PointerEvent');
  fire(el, 'mouseup', pos, 'MouseEvent');
  return pos;
}

/** ポインター・マウスのイベント列を送り、click() する。 */
export function clickElement(el: Element): void {
  const pos = pressSequence(el);
  if (typeof (el as HTMLElement).click === 'function') (el as HTMLElement).click();
  else fire(el, 'click', { ...pos, detail: 1 }, 'MouseEvent');
}

/**
 * クリックで javascript: URL へのリンクをたどるか（要素自身か祖先の a / area の href が javascript:）。
 * 拡張の isolated world から click() すると、javascript: URL は拡張側の CSP で判定されてブロックされる
 * （実在の業務サイトで確認: "Running the JavaScript URL violates the following Content Security Policy directive 'script-src 'self' … chrome-extension://…"）。
 */
export function javascriptUrlLink(el: Element): boolean {
  const a = el.closest?.('a[href], area[href]');
  return !!a && /^\s*javascript:/i.test(a.getAttribute('href') ?? '');
}

export { MAIN_CLICK_ATTR } from '../shared/messages';

/**
 * ネイティブの value setter で値を設定し、input / change を送る。
 * React 等が要素に持つ value の上書き（値の追跡）を経由しないため、制御された入力でも変更として検出される。
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const w = viewOf(el);
  const proto = el.tagName.toLowerCase() === 'textarea' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
  if (setter) setter.call(el, text); else el.value = text;
  fire(el, 'input', { inputType: 'insertReplacementText' }, 'InputEvent');
  fire(el, 'change');
}

/** contenteditable: 中身をテキストで置き換えて input を送る（リッチエディタ独自のモデルには反映されない可能性がある） */
export function setEditableText(el: HTMLElement, text: string): void {
  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
  el.textContent = text;
  fire(el, 'input', { inputType: 'insertReplacementText' }, 'InputEvent');
}

export type OptionMatch = { ok: true; indexes: number[]; by: 'value' | 'label' } | { ok: false; reason: string };

/**
 * select の option を選ぶ: テンプレートの値・記録値とも value → label の順で照合する。
 * 位置（index）だけでは照合しない: value も表示名も違う選択肢を位置だけで選ぶのは推測であり、
 * 選択肢が遅れて差し替わる画面では、差し替え途中の別の候補一覧から別の値を選んでしまう（実ブラウザの e2e で確認）。
 * 一致しない間は readiness が上限時間まで待ち、それでも一致しなければ理由つきで失敗にする。
 */
export function matchOptions(sel: HTMLSelectElement, text: string | undefined, recorded: readonly { value: string; label: string; index: number }[] | undefined): OptionMatch {
  const opts = [...sel.options];
  const label = (o: HTMLOptionElement) => (o.label || o.text || '').replace(/\s+/g, ' ').trim();
  const usable = (o: HTMLOptionElement | undefined) => !!o && !o.disabled;
  if (text !== undefined) {
    let i = opts.findIndex((o) => usable(o) && o.value === text);
    if (i >= 0) return { ok: true, indexes: [i], by: 'value' };
    i = opts.findIndex((o) => usable(o) && label(o) === text.trim());
    if (i >= 0) return { ok: true, indexes: [i], by: 'label' };
    return { ok: false, reason: `指定した値に一致する選択肢がない（選択肢 ${opts.length} 件）` };
  }
  if (!recorded || !recorded.length) return { ok: false, reason: '選ぶ選択肢の記録がない' };
  const out: number[] = [];
  let by: 'value' | 'label' = 'value';
  for (const r of recorded) {
    let i = opts.findIndex((o) => usable(o) && o.value === r.value);
    if (i < 0) { i = opts.findIndex((o) => usable(o) && label(o) === r.label.replace(/\s+/g, ' ').trim()); if (i >= 0 && by === 'value') by = 'label'; }
    if (i < 0) return { ok: false, reason: `記録した選択肢（value=${r.value}）に value・表示名とも一致する選択肢がない（選択肢 ${opts.length} 件。位置だけでは選ばない）` };
    out.push(i);
  }
  return { ok: true, indexes: out, by };
}

export function applySelect(sel: HTMLSelectElement, indexes: readonly number[]): void {
  try { sel.focus({ preventScroll: true }); } catch { /* ignore */ }
  if (sel.multiple) [...sel.options].forEach((o, i) => { o.selected = indexes.includes(i); });
  else sel.selectedIndex = indexes[0];
  fire(sel, 'input');
  fire(sel, 'change');
}

/** keydown / keyup を送る。Enter が入力欄上で既定動作を止められなかった場合は、フォームの暗黙の送信を requestSubmit() で再現する。 */
export function pressKey(el: Element, key: NonNullable<ResolvedReplayAction['key']>): { implicitSubmit: boolean } {
  const init = { key: key.key, code: key.key.length === 1 ? undefined : key.key, ctrlKey: key.ctrl, altKey: key.alt, shiftKey: key.shift, metaKey: key.meta };
  try { (el as HTMLElement).focus?.({ preventScroll: true }); } catch { /* ignore */ }
  const notPrevented = fire(el, 'keydown', init, 'KeyboardEvent');
  let implicitSubmit = false;
  if (notPrevented && key.key === 'Enter' && !key.ctrl && !key.alt && !key.meta && el.tagName.toLowerCase() === 'input' && isTextInput(el)) {
    const form = (el as HTMLInputElement).form;
    if (form) {
      const submitter = form.querySelector('button:not([type]),button[type="submit" i],input[type="submit" i],input[type="image" i]') as HTMLElement | null;
      if (submitter && (submitter as HTMLButtonElement).disabled) { /* 無効な送信ボタンがあるときは送信しない（ブラウザと同じ） */ }
      else {
        try { form.requestSubmit(submitter && (submitter as HTMLButtonElement).form === form ? (submitter as HTMLButtonElement) : undefined); implicitSubmit = true; } catch { /* ignore */ }
      }
    }
  }
  fire(el, 'keyup', init, 'KeyboardEvent');
  return { implicitSubmit };
}

// ---- 待機条件 ---------------------------------------------------------------------

function pageText(doc: Document): string {
  const b = doc.body;
  if (!b) return '';
  const t = (b as HTMLElement).innerText;
  return typeof t === 'string' && t.length ? t : b.textContent || '';
}

/** 待機条件を 1 回評価する（dom-quiet と none は対象外） */
export function evaluateWait(cond: WaitCondition, doc: Document, href: string): { met: boolean } | { error: string } {
  const v = cond.value ?? '';
  const test = (s: string): { met: boolean } | { error: string } => {
    if (cond.isRegex) { try { return { met: new RegExp(v).test(s) }; } catch { return { error: '正規表現が不正' }; } }
    return { met: s.includes(v) };
  };
  switch (cond.kind) {
    case 'element-present': case 'element-absent': {
      if (!v) return { error: 'セレクターが指定されていない' };
      let n: number;
      try { n = [...doc.querySelectorAll(v)].filter((e) => e.tagName.toLowerCase() !== OVERLAY_TAG).length; } catch { return { error: 'CSS セレクターが不正' }; }
      return { met: cond.kind === 'element-present' ? n > 0 : n === 0 };
    }
    case 'text-present': if (!v) return { error: '文字列が指定されていない' }; return test(pageText(doc));
    case 'url-matches': if (!v) return { error: 'URL が指定されていない' }; return test(href);
    default: return { error: `この関数では評価しない種別: ${cond.kind}` };
  }
}

export interface WaitEnv { doc: Document; win: Window; href?: () => string; now?: () => number }

const isOverlayMutation = (r: MutationRecord) => {
  const t = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
  if (t && (t.tagName.toLowerCase() === OVERLAY_TAG || t.closest?.(OVERLAY_TAG))) return true;
  return r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].length > 0 && [...r.addedNodes, ...r.removedNodes].every((n) => (n as Element).tagName?.toLowerCase() === OVERLAY_TAG);
};

/** DOM の変化が quietMs 止まるのを待つ。maxMs を超えたら timeout（失敗ではなく観測できなかったという結果）。 */
export function waitDomQuiet(env: WaitEnv, quietMs: number, maxMs: number): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    const W = env.win as Window & typeof globalThis;
    let qt: ReturnType<typeof setTimeout>;
    const done = (o: WaitOutcome) => { mo.disconnect(); clearTimeout(qt); clearTimeout(mt); resolve(o); };
    const mo = new W.MutationObserver((recs) => {
      if (recs.every(isOverlayMutation)) return;
      clearTimeout(qt); qt = setTimeout(() => done({ kind: 'dom-quiet', status: 'observed', at: iso(), detail: `DOM の変化が ${quietMs}ms 止まった（画面変化の観測であり、業務処理の完了ではない）` }), quietMs);
    });
    mo.observe(env.doc, { subtree: true, childList: true, attributes: true, characterData: true });
    qt = setTimeout(() => done({ kind: 'dom-quiet', status: 'observed', at: iso(), detail: `DOM の変化が ${quietMs}ms 止まった（画面変化の観測であり、業務処理の完了ではない）` }), quietMs);
    const mt = setTimeout(() => done({ kind: 'dom-quiet', status: 'timeout', at: iso(), detail: `${maxMs}ms 以内に DOM の変化が ${quietMs}ms 止まらなかった` }), Math.max(maxMs, quietMs));
  });
}

/** 待機条件を観測する。deadline（epoch ms）までに観測できなければ timeout。 */
export async function waitFor(cond: WaitCondition, env: WaitEnv, deadline: number, quietMaxMs = DEFAULT_QUIET_MAX_MS): Promise<WaitOutcome> {
  const now = env.now ?? Date.now;
  if (cond.kind === 'none') return { kind: 'none', status: 'not-applicable' };
  if (cond.kind === 'dom-quiet') {
    const q = cond.quietMs && cond.quietMs > 0 ? cond.quietMs : DEFAULT_QUIET_MS;
    return waitDomQuiet(env, q, Math.min(Math.max(deadline - now(), q), Math.max(quietMaxMs, q * 2)));
  }
  const href = env.href ?? (() => env.win.location.href);
  const W = env.win as Window & typeof globalThis;
  return new Promise((resolve) => {
    let finished = false;
    let mo: MutationObserver | null = null;
    let it: ReturnType<typeof setInterval> | undefined;
    const finish = (o: WaitOutcome) => { if (finished) return; finished = true; mo?.disconnect(); clearInterval(it); resolve(o); };
    const check = () => {
      const r = evaluateWait(cond, env.doc, href());
      if ('error' in r) return finish({ kind: cond.kind, status: 'failed', at: iso(), detail: r.error });
      if (r.met) return finish({ kind: cond.kind, status: 'observed', at: iso() });
      if (now() >= deadline) finish({ kind: cond.kind, status: 'timeout', at: iso(), detail: '上限時間までに条件を観測できなかった' });
    };
    check();
    if (finished) return;
    mo = new W.MutationObserver(check);
    mo.observe(env.doc, { subtree: true, childList: true, attributes: true, characterData: true });
    it = setInterval(check, POLL_MS);
  });
}

// ---- 1 手順の実行 -----------------------------------------------------------------

export interface ExecEnv extends WaitEnv {
  /** 操作の直前に呼ぶ。false を返したら操作しない（SW 側で取り消された） */
  beforeAct?: (info: { selector?: ReplaySelector }) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  quietMaxMs?: number;
  /** javascript: URL のリンクを、ページ側（main world）でクリックする（SW に依頼する）。未指定ならページ側では実行できない */
  mainWorldClick?: (el: Element) => Promise<{ ok: boolean; reason?: string }>;
}

/** CSP の違反のうち、再生スクリプト（拡張）由来のもの（ページ自身の違反は数えない） */
function watchExtensionCsp(doc: Document): { stop(): string | null } {
  let hit: string | null = null;
  const on = (e: Event) => {
    const v = e as SecurityPolicyViolationEvent;
    if (/^chrome-extension:|^moz-extension:/i.test(v.sourceFile ?? '')) hit = `${v.effectiveDirective || v.violatedDirective}${v.blockedURI ? `、ブロック対象: ${v.blockedURI}` : ''}`;
  };
  try { doc.addEventListener('securitypolicyviolation', on, true); } catch { /* ignore */ }
  return { stop() { try { doc.removeEventListener('securitypolicyviolation', on, true); } catch { /* ignore */ } return hit; } };
}

const OPERATIONS = new Set(['click', 'input', 'select', 'check', 'key']);

/** 機密欄の判定（記録時の印付けと同じ判定を使う） */
function sensitive(el: Element): boolean {
  try { markSensitiveFields(el.ownerDocument); } catch { /* ignore */ }
  return isSensitiveField(el);
}

/** 操作の準備ができているか（要素の状態・select の選択肢）。できていなければ理由。 */
function readiness(a: ResolvedReplayAction, el: Element): { ok: true; options?: number[] } | { ok: false; reason: string; fatal?: boolean } {
  const na = notActionable(el);
  if (na && a.kind !== 'key') return { ok: false, reason: na };
  const tag = el.tagName.toLowerCase();
  if (a.kind === 'input') {
    if (!isTextInput(el) && !(el as HTMLElement).isContentEditable) return { ok: false, reason: `入力できない要素（${tag}）`, fatal: true };
    if (isTextInput(el) && el.readOnly) return { ok: false, reason: '対象要素が読み取り専用（readonly）' };
  }
  if (a.kind === 'select') {
    if (tag !== 'select') return { ok: false, reason: `select 要素ではない（${tag}）`, fatal: true };
    const m = matchOptions(el as HTMLSelectElement, a.text, a.selectOptions);
    if (!m.ok) return { ok: false, reason: m.reason };
    return { ok: true, options: m.indexes };
  }
  if (a.kind === 'check') {
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    if (tag !== 'input' || (type !== 'checkbox' && type !== 'radio')) return { ok: false, reason: `チェックボックス・ラジオボタンではない（${tag}）`, fatal: true };
    if (type === 'radio' && a.checked === false && (el as HTMLInputElement).checked) return { ok: false, reason: 'ラジオボタンはクリックでオフにできない', fatal: true };
  }
  return { ok: true };
}

/**
 * 1 手順（操作 + 待機、または待機のみ）を実行する。
 * ok は「操作を実行し、待機条件を観測できた」という意味で、業務処理の完了ではない。
 */
export async function executeAction(a: ResolvedReplayAction, env: ExecEnv): Promise<ReplayRunReply> {
  const now = env.now ?? Date.now;
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + a.timeoutMs;
  if (a.kind === 'wait') {
    const wo = await waitFor(a.wait, env, deadline, env.quietMaxMs);
    return waitReply(wo, false);
  }
  if (!OPERATIONS.has(a.kind)) return { status: 'failed', reason: `ページ内では実行しない種別: ${a.kind}` };

  const needsTarget = a.kind !== 'key' || a.selectors.length > 0;
  let el: Element | null = null;
  let used: ReplaySelector | undefined;
  let options: number[] | undefined;
  let attempts: SelectorAttempt[] = [];
  const diagOf = (): Pick<ReplayRunReply, 'attempts' | 'href' | 'iframeCount'> => ({ attempts, ...docDiag(env) });
  if (needsTarget) {
    let lastReason = '';
    for (;;) {
      const f = findTarget(env.doc, a);
      attempts = f.attempts;
      if (f.ok) {
        if ((a.kind === 'input' || a.kind === 'select' || a.kind === 'check') && sensitive(f.el)) {
          return { status: 'manual', reason: '機密欄のため自動では操作しない。人が操作して続行する', selectorUsed: sel(f.selector), matchCount: 1, ...diagOf() };
        }
        const r = readiness(a, f.el);
        if (r.ok) { el = f.el; used = f.selector; options = r.options; break; }
        lastReason = r.reason;
        if (r.fatal) return { status: 'failed', reason: r.reason, selectorUsed: sel(f.selector), matchCount: 1, ...diagOf() };
      } else lastReason = f.reason;
      if (now() >= deadline) return { status: 'failed', reason: `上限時間（${a.timeoutMs}ms）までに対象要素を操作できる状態で特定できなかった: ${lastReason}`, ...diagOf() };
      await sleep(POLL_MS);
    }
  } else {
    el = (env.doc.activeElement as Element | null) ?? env.doc.body;
  }
  if (!el) return { status: 'failed', reason: 'キー操作の対象がない' };
  if (a.kind === 'input' && a.text === undefined) return { status: 'failed', reason: '入力する値がない' };

  if (env.beforeAct && !(await env.beforeAct({ selector: used }))) return { status: 'failed', reason: '再生の制御側で取り消されたため操作していない' };

  let note = '';
  const csp = watchExtensionCsp(env.doc);
  try {
    switch (a.kind) {
      case 'click':
        if (javascriptUrlLink(el)) {
          // javascript: URL は拡張側から実行するとブロックされるため、ページ側（main world）でクリックする
          pressSequence(el);
          if (!env.mainWorldClick) { csp.stop(); return { status: 'failed', reason: 'javascript: URL のリンクは、ページ側でのクリックが使えないため実行できない', selectorUsed: sel(used), matchCount: 1, ...diagOf() }; }
          const m = await env.mainWorldClick(el);
          if (!m.ok) { csp.stop(); return { status: 'failed', reason: `javascript: URL のリンクを、ページ側でクリックできなかった: ${m.reason ?? '理由不明'}（クリックの前段のイベントは送った）`, selectorUsed: sel(used), matchCount: 1, ...diagOf() }; }
          note = 'javascript: URL のリンクのため、ページ側（main world）でクリックした';
        } else clickElement(el);
        break;
      case 'input':
        if (isTextInput(el)) setNativeValue(el, a.text!);
        else { setEditableText(el as HTMLElement, a.text!); note = 'contenteditable は中身のテキストを置き換えた（リッチエディタ独自の内部状態には反映されない可能性がある）'; }
        break;
      case 'select': applySelect(el as HTMLSelectElement, options ?? []); break;
      case 'check': {
        const input = el as HTMLInputElement;
        if (input.checked !== !!a.checked) clickElement(input);
        if (input.checked !== !!a.checked) return { status: 'failed', reason: `クリック後もチェック状態が目標（${a.checked ? 'オン' : 'オフ'}）と異なる。${UNTRUSTED_NOTE}`, selectorUsed: sel(used), matchCount: used ? 1 : undefined };
        break;
      }
      case 'key': {
        if (!a.key) return { status: 'failed', reason: 'キーの記録がない' };
        const r = pressKey(el, a.key);
        if (r.implicitSubmit) note = 'Enter によるフォームの暗黙の送信を requestSubmit() で再現した';
        if (a.key.key === 'Tab') note = '合成した Tab キーではフォーカスは移動しない（ブラウザの既定動作は再現しない）';
        break;
      }
    }
  } catch (e) {
    csp.stop();
    return { status: 'failed', reason: `操作中に例外が発生した: ${(e as Error)?.name ?? 'Error'}`, selectorUsed: sel(used), matchCount: used ? 1 : undefined };
  }
  const d = diagOf(); // 操作の直後（遷移の前）に文書の情報を控える
  const wo = await waitFor(a.wait, env, Math.max(deadline, now() + MIN_WAIT_AFTER_ACTION_MS), env.quietMaxMs);
  const blocked = csp.stop();
  if (blocked) {
    // 再生スクリプトの処理がページの CSP でブロックされた: 操作が効いていない可能性があるため、待機条件を観測できても ok にしない
    return { status: 'failed', reason: `操作の一部がコンテンツ セキュリティ ポリシー（CSP）でブロックされた（${blocked}）。操作が効いていない可能性がある`, waitOutcome: wo, selectorUsed: sel(used), matchCount: used ? 1 : undefined, ...d };
  }
  const rep = { ...waitReply(wo, true), ...d };
  if (used) { rep.selectorUsed = sel(used); rep.matchCount = 1; }
  if (note && rep.status === 'ok') rep.reason = note;
  return rep;
}

/** 診断用: 文書の URL と iframe / frame 要素の数（取得できなければ省く） */
function docDiag(env: WaitEnv): { href?: string; iframeCount?: number } {
  const out: { href?: string; iframeCount?: number } = {};
  try { out.href = env.href ? env.href() : env.win.location.href; } catch { /* ignore */ }
  try { out.iframeCount = env.doc.querySelectorAll('iframe,frame').length; } catch { /* ignore */ }
  return out;
}

function sel(s: ReplaySelector | undefined): ReplayRunReply['selectorUsed'] {
  return s ? { language: s.language, selector: s.selector, source: s.source } : undefined;
}

/** 待機の結果から応答を作る。dom-quiet の時間切れは失敗にしない（画面変化の観測ができなかっただけ）。 */
export function waitReply(wo: WaitOutcome, afterOperation: boolean): ReplayRunReply {
  if (wo.status === 'observed' || wo.status === 'not-applicable') return { status: 'ok', waitOutcome: wo };
  if (wo.status === 'timeout' && wo.kind === 'dom-quiet') return { status: 'ok', waitOutcome: wo };
  if (wo.status === 'failed') return { status: 'failed', reason: `待機条件を評価できない: ${wo.detail ?? ''}`, waitOutcome: wo };
  return { status: 'failed', reason: `待機条件（${wo.kind}）を上限時間内に観測できなかった${afterOperation ? `。${UNTRUSTED_NOTE}` : ''}`, waitOutcome: wo };
}

// ---- フレームの経路 ---------------------------------------------------------------

export interface FrameDescription { isTop: boolean; path: { index: number; selector?: string; url?: string }[]; url: string; readyState?: string; iframeCount?: number }
