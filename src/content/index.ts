// TraceLens コンテンツスクリプト（記録対象タブにのみ、Service Worker から注入される）
// - ユーザー操作(isTrusted)だけを記録し、スクリプト起因のイベントや TraceLens 自身のUIは無視する
// - 記録中でない/一時停止中は何も送らない
import type { ArtifactPhase, CaptureStatus, FrameHop, FrameInfo, Limitation, Observation, PageInfo, ScreenshotMeta, StepKind, ValueInfo } from '../shared/types';
import { newId } from '../shared/types';
import type { ContentMsg, DomFailure, DomPayload, FinishReply, HelloReply, PressRectReply, ScanBeginReply, ScanEndReply, ScanScrollReply, ShotMetaReply, StepDraft, ToContentMsg } from '../shared/messages';
import { pressRelated } from '../shared/pressShot';
import type { ChangeKind } from '../shared/beforeShot';
import { describeElement, readValue } from '../shared/elementInfo';
import { serializeDom } from '../shared/domSerialize';
import { fieldHasValue, isAutofilled, isSensitiveField, markSensitiveFields, REDACTED_NOTE, valueDiffersFromDefault } from '../shared/sensitive';
import { cssPath } from '../shared/selectors';
import { InputAggregator, type InputSession } from '../shared/inputAggregator';

declare global { interface Window { __tracelensContent?: boolean } }

(() => {
  if (window.__tracelensContent) return;
  window.__tracelensContent = true;

  const QUIET_MS = 400;        // DOM変化がこの時間止まったら「静止を観測」
  const SHOT_MAX_MS = 2500;    // 静止しなくてもこの時間で操作後の画面を取得
  const OBS_MAX_MS = 8000;     // 観測の打ち切り
  const OVERLAY_TAG = 'tracelens-overlay';

  const isTop = window.top === window;
  let recording = false;
  let paused = false;
  let pickerOn = false;
  let pickerMode: 'note' | 'element' = 'note';
  let dead = false;
  const active = () => recording && !paused && !dead;
  const iso = (ms: number = Date.now()) => new Date(ms).toISOString();

  function send(msg: ContentMsg): Promise<any> {
    if (dead) return Promise.resolve(undefined);
    try {
      return chrome.runtime.sendMessage(msg).catch((e) => { if (!chrome.runtime?.id || /context invalidated/i.test(String(e))) dead = true; return undefined; });
    } catch { dead = true; return Promise.resolve(undefined); }
  }

  // ---- ページ・フレーム情報 -------------------------------------------------
  function pageInfo(): PageInfo {
    return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) } };
  }
  function frameInfo(): FrameInfo {
    const path: FrameHop[] = [];
    let w: Window = window;
    let guard = 0;
    while (w !== w.parent && guard++ < 20) {
      const parent = w.parent;
      let index = -1;
      try { for (let i = 0; i < parent.frames.length; i++) if (parent.frames[i] === w) { index = i; break; } } catch { /* ignore */ }
      const hop: FrameHop = { index, crossOrigin: true };
      try { const fe = w.frameElement; if (fe) { hop.selector = cssPath(fe).selector; hop.crossOrigin = false; } } catch { /* cross-origin */ }
      try { hop.url = w.location.href; } catch { /* cross-origin */ }
      path.unshift(hop);
      w = parent;
    }
    return { isTop, path, url: location.href };
  }
  function topRect(el: Element): { rect: ScreenshotMeta['targetRectAtCapture']; note?: string } {
    if (!el.isConnected) return { rect: null, note: '対象要素が取得時点のDOMに存在しない' };
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { rect: null, note: '対象要素が取得時点で非表示' };
    let x = r.x, y = r.y;
    let w: Window = window;
    try {
      while (w !== w.parent) {
        const fe = w.frameElement;
        if (!fe) return { rect: null, note: 'クロスオリジンフレーム内の要素のため、画像上の位置を確認できない' };
        const fr = fe.getBoundingClientRect();
        x += fr.x + fe.clientLeft; y += fr.y + fe.clientTop;
        w = w.parent;
      }
    } catch { return { rect: null, note: 'クロスオリジンフレーム内の要素のため、画像上の位置を確認できない' }; }
    const vw = (w as Window).innerWidth, vh = (w as Window).innerHeight;
    if (x + r.width <= 0 || y + r.height <= 0 || x >= vw || y >= vh) return { rect: null, note: '対象要素が取得時点の表示領域の外にある' };
    return { rect: { x: Math.round(x), y: Math.round(y), width: Math.round(r.width), height: Math.round(r.height) } };
  }

  // ---- DOM スナップショット -------------------------------------------------
  /** このフレームの左上の、トップのビューポート上の位置。クロスオリジンを挟むなど確認できなければ null */
  function frameOffset(): { x: number; y: number; top: Window } | null {
    let x = 0, y = 0;
    let w: Window = window;
    try {
      while (w !== w.parent) {
        const fe = w.frameElement;
        if (!fe) return null;
        const fr = fe.getBoundingClientRect();
        x += fr.x + fe.clientLeft; y += fr.y + fe.clientTop;
        w = w.parent;
      }
      return { x, y, top: w };
    } catch { return null; }
  }
  function snapshotDom(phase: ArtifactPhase): DomPayload | DomFailure {
    try {
      markSensitiveFields(document);
      // 要素の位置（トップのビューポート基準）。レビュー画面でセレクターに一致した要素を画像に重ねるためのもの
      const off = frameOffset();
      const box = off ? (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return `${Math.round(r.x + off.x)},${Math.round(r.y + off.y)},${Math.round(r.width)},${Math.round(r.height)}`;
      } : undefined;
      const r = serializeDom(document, undefined, true, box);
      const dt = document.doctype ? `<!DOCTYPE ${document.doctype.name}>\n` : '';
      const boxViewport = off ? { width: off.top.innerWidth, height: off.top.innerHeight, scrollX: Math.round(off.top.scrollX), scrollY: Math.round(off.top.scrollY) } : undefined;
      return { html: dt + r.html, formState: r.formState, truncated: r.truncated, phase, capturedAt: iso(), frameUrl: location.href, ...(boxViewport ? { boxViewport } : {}) };
    } catch (e) {
      return { failed: true, reason: `DOMの直列化に失敗: ${String(e)}` };
    }
  }

  // ---- ステップ生成 ---------------------------------------------------------
  const stepEls = new Map<string, WeakRef<Element>>();
  function makeStep(kind: StepKind, el?: Element | null, extra: Partial<StepDraft> = {}, id = newId('stp')): StepDraft {
    let elementCapture: CaptureStatus = { status: 'not-applicable' };
    const limitations: Limitation[] = [];
    let target: StepDraft['target'];
    if (el) {
      try {
        target = describeElement(el);
        elementCapture = { status: 'captured' };
        target.hints.forEach((h) => limitations.push({ code: 'element-hint', message: h }));
      } catch (e) {
        elementCapture = { status: 'failed', reasonCode: 'describe-error', reason: `要素情報の取得に失敗: ${String(e)}` };
      }
      stepEls.set(id, new WeakRef(el));
      if (stepEls.size > 60) stepEls.delete(stepEls.keys().next().value!);
    }
    const frame = frameInfo();
    if (!isTop && frame.path.some((h) => h.crossOrigin)) limitations.push({ code: 'cross-origin-frame', message: 'クロスオリジンフレーム内の操作。フレームの経路は index のみで、親ページ内のセレクターは取得できない' });
    return { id, kind, operationAt: iso(), page: pageInfo(), frame, target, elementCapture, limitations, ...(trackChanges ? { observedChange: lastChange } : {}), ...extra };
  }
  /** ユーザー操作のステップを送る。進行中の観測は「次の操作」により終了する。 */
  function emit(step: StepDraft, phase: ArtifactPhase = 'at-operation', opEl?: Element | null) {
    if (phase !== 'manual') scanPrefilled(opEl ?? null); // 画面保存・要素注記は操作ではないため観測しない
    flushChange();
    endObservation('next-operation');
    void send({ t: 'step', step, dom: snapshotDom(phase) });
  }

  // ---- 入力済みの値の観測 ---------------------------------------------------
  // 人が入力していないのに値が入っている入力欄（ブラウザの自動入力・入力内容の復元・ページのスクリプトなど）を、
  // 操作の直前に「入力済みの値」の手順として残す。人の操作ではない（原則 13）。再生では既定で値をそのまま使う。
  // 対象: このフレームの文書の、表示されている編集可能なテキスト系の入力欄で、値が入っていて、
  //       自動入力の表示があるか、HTML の初期値と違うもの。人が入力した欄・一度観測した欄は除く（文書ごと）。
  const PREFILL_MAX = 20;
  // 記録セッションごとに分ける（一時停止・再開では保つ。同じページで新しい記録を始めたら観測し直す）
  let accounted = new WeakSet<Element>();
  let accountedSession: string | undefined;
  function scanPrefilled(opEl: Element | null) {
    let n = 0;
    let list: NodeListOf<Element>;
    try { list = document.querySelectorAll('input,textarea'); } catch { return; }
    for (const el of Array.from(list)) {
      if (n >= PREFILL_MAX) break;
      if (el === opEl || accounted.has(el) || agg.current?.key === el) continue;
      const f = el as HTMLInputElement;
      if (!isTextLike(el) || f.type === 'file' || f.disabled || f.readOnly) continue;
      if (!el.getClientRects().length) continue; // 表示されていない
      if (!fieldHasValue(el)) continue;
      const autofill = isAutofilled(el);
      if (!autofill && !valueDiffersFromDefault(el)) continue;
      accounted.add(el);
      const sensitive = isSensitiveField(el);
      const value: ValueInfo = sensitive ? { kind: 'redacted', redacted: true, redactionReason: REDACTED_NOTE } : { kind: 'text', text: textOf(el) ?? '' };
      const step = makeStep('prefill', el, { value, prefill: { autofill } });
      step.limitations.push({ code: 'prefill', message: '人の操作ではない。次の操作の直前に、入力欄に値が入っていることを観測した（値が入った時刻・経緯は記録していない。ブラウザの自動入力・入力内容の復元・ページのスクリプトなどが考えられる）' });
      if (autofill) step.limitations.push({ code: 'browser-autofill', message: '観測した時点で、ブラウザの自動入力の表示（:autofill）があった。再生時はブラウザが同じ値を入れるとは限らず、人がページを操作するまで値をページに渡さないことがある' });
      void send({ t: 'step', step });
      n++;
    }
  }

  // ---- 操作前の画面の参照判定用: 画面変化を観測した時刻だけを持つ（内容は持たない・送らない） --------
  // 観測の範囲（DOM の変化・スクロール・リサイズ）だけ。:hover・アニメーション・動画・canvas などは観測できない。
  let trackChanges = false;
  let lastChange: { atMs: number; kind: ChangeKind } | null = null;
  let changeSentAt = 0;
  let changeT: number | undefined;
  /** 間引いている範囲で最初に観測した変化の時刻（押下時の画面の判定に使う） */
  let firstUnsent: number | undefined;
  const sendChange = () => {
    if (!lastChange) return;
    void send({ t: 'change', atMs: lastChange.atMs, kind: lastChange.kind, ...(firstUnsent !== undefined ? { firstAtMs: firstUnsent } : {}) });
    firstUnsent = undefined;
  };
  function noteChange(kind: ChangeKind) {
    notePressChange();
    if (!trackChanges) return;
    lastChange = { atMs: Date.now(), kind };
    firstUnsent ??= lastChange.atMs;
    const now = Date.now();
    if (now - changeSentAt >= 100) { changeSentAt = now; sendChange(); }
    else if (changeT === undefined) changeT = window.setTimeout(() => { changeT = undefined; changeSentAt = Date.now(); sendChange(); }, 100);
  }
  function flushChange() {
    if (changeT === undefined) return;
    clearTimeout(changeT); changeT = undefined; changeSentAt = Date.now();
    sendChange();
  }

  // ---- 押下時の画面 -----------------------------------------------------------
  // pointerdown の時点で SW に取得を始めさせる（クリックの処理で画面が変わる前の画像を残すため）。
  // 押下の後に起きた操作（クリック・値の変更・入力の開始）の要素が押下した要素と対応するときだけ、その操作の手順に結びつける。
  const PRESS_LINK_MS = 10000;
  let press: { id: string; atMs: number; el: WeakRef<Element>; firstChangeAtMs: number | null } | null = null;
  /** 取得後に位置を測り直すため、結びつけた後もしばらく要素を引けるようにする */
  const pressEls = new Map<string, WeakRef<Element>>();
  function notePressChange() {
    if (!press || press.firstChangeAtMs !== null) return;
    press.firstChangeAtMs = Date.now();
    void send({ t: 'press-change', pressId: press.id, atMs: press.firstChangeAtMs });
  }
  function onPointerDown(e: PointerEvent) {
    if (!e.isTrusted || pickerOn || !active() || scanning || e.button !== 0 || !e.isPrimary) return;
    const raw = deepTarget(e);
    if (!raw || isOwn(raw)) return;
    const el = raw.closest(INTERACTIVE) || raw;
    const tr = topRect(el);
    press = { id: newId('prs'), atMs: Date.now(), el: new WeakRef(el), firstChangeAtMs: null };
    pressEls.set(press.id, press.el);
    if (pressEls.size > 10) pressEls.delete(pressEls.keys().next().value!);
    void send({ t: 'press', pressId: press.id, atMs: press.atMs, rect: tr.rect, rectNote: tr.note, ...(isTop ? { viewport: pageInfo().viewport } : {}) });
  }
  /** 操作の手順に、対応する押下を結びつける（1 回の押下は 1 つの手順にだけ） */
  function takePress(el: Element | null): StepDraft['press'] {
    const p = press;
    if (!p || !el || Date.now() - p.atMs > PRESS_LINK_MS) return undefined;
    const pe = p.el.deref();
    if (!pe || !pressRelated(pe, el)) return undefined;
    press = null;
    return { id: p.id, atMs: p.atMs, firstChangeAtMs: p.firstChangeAtMs };
  }
  function setTracking(on: boolean) {
    if (on === trackChanges) return;
    trackChanges = on;
    if (on) noteChange('tracking-start'); else lastChange = null;
  }
  // ページ全体の取得中は TraceLens 自身がスクロールするため、ここでは数えない（終了時に 1 回、スクロールとして数える）
  let scanning = false;
  window.addEventListener('scroll', () => { if (!scanning) noteChange('scroll'); }, { capture: true, passive: true });
  window.addEventListener('resize', () => { if (!scanning) noteChange('resize'); }, { passive: true });

  // ---- 画面変化の観測（業務処理の完了判定ではない） ---------------------------
  // 最初の静止を観測した後も、次の操作か観測時間の上限までは変化を見続ける。
  // （例: 「保存中…」→ 静止 →「保存しました」。後から変化があれば、静止のたびに画面を取り直す）
  interface Obs {
    stepIds: string[]; shots: { stepId: string; phase: ArtifactPhase }[]; shotCount: number; dirty: boolean; quietCount: number;
    first?: number; last?: number; count: number; seen: Set<string>; items: Observation[];
    quietT?: number; maxT?: number; shotT?: number;
  }
  const MAX_SHOTS_PER_OBS = 3;
  let obs: Obs | null = null;

  function beginObservation(stepId: string, shotPhase: ArtifactPhase | null) {
    if (obs) { // 受動的に観測したイベント(URL変更など)は進行中の観測に合流する
      obs.stepIds.push(stepId);
      if (shotPhase) { obs.shots.push({ stepId, phase: shotPhase }); if (obs.shotCount > 0) void send({ t: 'shot', shots: [{ stepId, phase: shotPhase }] }); }
      return;
    }
    const o: Obs = { stepIds: [stepId], shots: shotPhase ? [{ stepId, phase: shotPhase }] : [], shotCount: 0, dirty: true, quietCount: 0, count: 0, seen: new Set(), items: [] };
    obs = o;
    o.quietT = window.setTimeout(onQuiet, QUIET_MS);
    o.shotT = window.setTimeout(fireShot, SHOT_MAX_MS);
    o.maxT = window.setTimeout(() => endObservation('timeout'), OBS_MAX_MS);
  }
  function fireShot() {
    if (!obs || !obs.dirty || obs.shotCount >= MAX_SHOTS_PER_OBS) return;
    obs.dirty = false; obs.shotCount++;
    if (obs.shots.length) void send({ t: 'shot', shots: obs.shots });
  }
  /** たまった観測結果を送る（ページ離脱で失われにくいよう、静止のたびに送る） */
  function flushObs(o: Obs, extra: Observation[] = []) {
    const items: Observation[] = [];
    if (o.count && o.first && o.last) items.push({ type: 'dom-mutations', firstAt: iso(o.first), lastAt: iso(o.last), count: o.count });
    items.push(...o.items, ...extra);
    o.count = 0; o.first = o.last = undefined; o.items = [];
    if (items.length) for (const stepId of o.stepIds) void send({ t: 'patch', stepId, observations: items });
  }
  function onQuiet() {
    const o = obs;
    if (!o) return;
    o.quietCount++;
    flushObs(o, o.quietCount <= 5 ? [{ type: 'dom-quiet', at: iso(), quietMs: QUIET_MS }] : []);
    fireShot();
  }
  const SKIP_REASON: Record<string, string> = {
    'next-operation': '画面変化が落ち着く前に次の操作が行われたため、操作後の画面を取得していない',
    'page-unload': 'ページ遷移・再読込が始まったため、操作後の画面を取得していない',
    paused: '一時停止または終了のため、操作後の画面を取得していない',
    timeout: '観測を打ち切ったため、操作後の画面を取得していない',
  };
  function endObservation(reason: 'quiet' | 'timeout' | 'next-operation' | 'page-unload' | 'paused') {
    const o = obs;
    if (!o) return;
    obs = null;
    clearTimeout(o.quietT); clearTimeout(o.maxT); clearTimeout(o.shotT);
    flushObs(o, [{ type: 'ended', at: iso(), reason }]);
    if (o.shotCount > 0 || !o.shots.length) return;
    // 静止を待つ前に次の操作が始まった場合は、その時点で取得し、その旨を画像に注記する（取得しないより有用なため）
    if (reason === 'next-operation') void send({ t: 'shot', shots: o.shots, timingNote: '画面変化の静止を待たず、次の操作の開始時点で取得した（次の操作の影響が写っている可能性がある）' });
    else for (const s of o.shots) void send({ t: 'shot-skip', stepId: s.stepId, reasonCode: reason, reason: SKIP_REASON[reason] || reason });
  }

  const LIVE_SEL = '[role="alert"],[role="status"],[role="alertdialog"],[role="dialog"],[aria-live],output,dialog';
  const isOwnMutation = (r: MutationRecord) => {
    const t = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
    if (!t || t.tagName.toLowerCase() === OVERLAY_TAG) return true;
    return r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every((n) => (n as Element).tagName?.toLowerCase() === OVERLAY_TAG);
  };
  const mo = new MutationObserver((records) => {
    if ((trackChanges || press) && !scanning && records.some((r) => !isOwnMutation(r))) noteChange('dom');
    const o = obs;
    if (!o) return;
    let relevant = 0;
    for (const r of records) {
      const t = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
      if (!t || t.tagName.toLowerCase() === OVERLAY_TAG) continue;
      if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every((n) => (n as Element).tagName?.toLowerCase() === OVERLAY_TAG)) continue;
      relevant++;
      const live = t.closest?.(LIVE_SEL);
      if (live && o.items.length < 20) {
        const text = ((live as HTMLElement).innerText || live.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const role = live.getAttribute('role') || (live.hasAttribute('aria-live') ? `aria-live=${live.getAttribute('aria-live')}` : live.tagName.toLowerCase());
        if (text && !o.seen.has(role + text)) { o.seen.add(role + text); o.items.push({ type: 'live-region', at: iso(), role, text }); }
      }
    }
    if (!relevant) return;
    const now = Date.now();
    o.first ??= now; o.last = now; o.count += relevant; o.dirty = true;
    clearTimeout(o.quietT);
    o.quietT = window.setTimeout(onQuiet, QUIET_MS);
  });
  let observing = false;
  function setObserving(on: boolean) {
    if (on === observing) return;
    observing = on;
    if (on) mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    else mo.disconnect();
  }

  // ---- 入力の集約 -----------------------------------------------------------
  function isTextLike(el: Element | null): el is HTMLElement {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') return !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden'].includes(((el as HTMLInputElement).type || '').toLowerCase());
    return (el as HTMLElement).isContentEditable === true;
  }
  const textOf = (el: Element): string | null => (isSensitiveField(el) ? null : readValue(el)?.text ?? '');
  function toValue(s: InputSession<Element>): ValueInfo {
    if (isSensitiveField(s.key) || s.value === null) return { kind: 'redacted', redacted: true, redactionReason: REDACTED_NOTE, usedIme: s.usedIme, editCount: s.editCount };
    const base = readValue(s.key);
    return { kind: base?.kind === 'files' ? 'files' : 'text', text: s.value, usedIme: s.usedIme, editCount: s.editCount };
  }
  let updateT: number | undefined;
  let lastFinal: { el: WeakRef<Element>; value: string | null } | null = null;
  const agg = new InputAggregator<Element>({
    onStart(s) { accounted.add(s.key); emit(makeStep('input', s.key, { value: toValue(s), press: takePress(s.key) }, s.id), 'at-operation', s.key); },
    onUpdate(s) {
      clearTimeout(updateT);
      updateT = window.setTimeout(() => { if (agg.current === s) void send({ t: 'patch', stepId: s.id, set: { value: toValue(s) } }); }, 800);
    },
    onFinalize(s) {
      clearTimeout(updateT);
      lastFinal = { el: new WeakRef(s.key), value: s.value };
      void send({ t: 'patch', stepId: s.id, set: { value: toValue(s), operationEndAt: iso(s.lastAt) } });
      if (active()) beginObservation(s.id, 'after-operation');
      else void send({ t: 'shot-skip', stepId: s.id, reasonCode: 'paused', reason: SKIP_REASON.paused });
    },
  }, () => newId('stp'));
  function finalizeInput(reason: string) {
    const c = agg.current;
    if (c) agg.finalize(reason, Date.now(), c.key.isConnected ? textOf(c.key) : undefined);
  }

  // ---- イベント処理 ---------------------------------------------------------
  const deepTarget = (e: Event): Element | null => {
    const t = (e.composedPath?.()[0] || e.target) as Node | null;
    return t && t.nodeType === 1 ? (t as Element) : t?.parentElement ?? null;
  };
  const isOwn = (el: Element | null) => !!el && (el.tagName.toLowerCase() === OVERLAY_TAG || !!el.closest?.(OVERLAY_TAG));
  const INTERACTIVE = 'button,a[href],select,input,textarea,label,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[contenteditable=""],[contenteditable="true"]';

  function onClick(e: MouseEvent) {
    if (!e.isTrusted || pickerOn || !active()) return;
    const raw = deepTarget(e);
    if (!raw || isOwn(raw)) return;
    const el = raw.closest(INTERACTIVE) || raw;
    const tag = el.tagName.toLowerCase();
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    // 値の変化として記録されるもの・単なるフォーカス移動はクリックとして重複記録しない
    if (tag === 'select' || tag === 'option') return;
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return;
    if (tag === 'label' && (el as HTMLLabelElement).control) return;
    if (isTextLike(el) && !(el as HTMLInputElement).readOnly) return;
    finalizeInput('other-operation');
    const step = makeStep('click', el, { press: takePress(el) });
    if (e.detail === 0) step.limitations.push({ code: 'synthetic-activation', message: 'ポインター操作ではないクリック（キーボード操作やフォームの暗黙送信で発生）の可能性がある' });
    emit(step, 'at-operation', el);
    beginObservation(step.id, 'after-operation');
  }

  const STEPPED_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'number', 'range', 'color']);
  /** 記録していない間（一時停止中など）に人が編集した欄は、入力済みの値として観測しない（記録しない操作の内容を残さないため） */
  function noteUnrecordedEdit(e: Event) {
    if (!e.isTrusted || (active() && !pickerOn)) return;
    const el = deepTarget(e);
    if (el && !isOwn(el)) accounted.add(el);
  }
  function onChange(e: Event) {
    noteUnrecordedEdit(e);
    if (!e.isTrusted || pickerOn || !active()) return;
    const el = deepTarget(e);
    if (!el || isOwn(el)) return;
    const tag = el.tagName.toLowerCase();
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    if (tag === 'select' || (tag === 'input' && (type === 'checkbox' || type === 'radio'))) {
      finalizeInput('other-operation');
      const step = makeStep(tag === 'select' ? 'select' : 'check', el, { value: readValue(el), press: takePress(el) });
      emit(step);
      beginObservation(step.id, 'after-operation');
      return;
    }
    if (!isTextLike(el)) return;
    const now = Date.now();
    // 日付・数値などの欄は、部分入力のたびに change が発火する。ここでは確定せず、フォーカスが外れた時にまとめる
    if (STEPPED_TYPES.has(type) && el.ownerDocument.activeElement === el) {
      if (agg.current?.key !== el || agg.current.value !== textOf(el)) agg.edit(el, textOf(el), now);
      return;
    }
    if (agg.current?.key !== el) {
      // Enter などで確定済みの入力に対して、同じ値の change が遅れて届いた場合は重複記録しない
      if (lastFinal && lastFinal.el.deref() === el && lastFinal.value === textOf(el)) return;
      agg.edit(el, textOf(el), now);
    }
    agg.finalize('change', now, textOf(el));
  }

  function onInput(e: Event) {
    noteUnrecordedEdit(e);
    if (!e.isTrusted || pickerOn || !active()) return;
    const el = deepTarget(e);
    if (!el || isOwn(el) || !isTextLike(el)) return;
    isSensitiveField(el);
    if (agg.current?.key === el && agg.current.value !== null && agg.current.value === textOf(el)) return; // 値が変わらない通知は編集回数に数えない
    agg.edit(el, textOf(el), Date.now());
  }
  function onComposition(e: CompositionEvent) {
    if (!e.isTrusted || !active()) return;
    const el = deepTarget(e);
    if (!el || !isTextLike(el)) return;
    if (e.type === 'compositionstart') agg.compositionStart(el, Date.now()); else agg.compositionEnd(el, Date.now());
  }
  function onFocusOut(e: FocusEvent) {
    const el = deepTarget(e);
    if (el && agg.current?.key === el) agg.finalize('blur', Date.now(), textOf(el));
  }

  const ALWAYS_KEYS = new Set(['Enter', 'Tab', 'Escape']);
  const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
  const WIDGET_ROLES = /^(listbox|option|menu|menuitem|menubar|combobox|grid|gridcell|tab|tablist|slider|tree|treeitem|radiogroup|spinbutton)$/;
  function onKeyDown(e: KeyboardEvent) {
    if (!e.isTrusted || pickerOn || !active() || e.repeat) return;
    if (e.isComposing || e.keyCode === 229) return; // IME 変換確定の Enter などは操作として扱わない
    const el = deepTarget(e);
    if (isOwn(el)) return;
    const key = e.key;
    const text = isTextLike(el);
    let record = false;
    if (ALWAYS_KEYS.has(key)) record = !(key === 'Enter' && el?.tagName === 'TEXTAREA' && !e.ctrlKey && !e.metaKey) && !(key === 'Enter' && text && (el as HTMLElement).isContentEditable);
    else if (/^F\d{1,2}$/.test(key)) record = true;
    else if (NAV_KEYS.has(key)) record = !text && !!el && (WIDGET_ROLES.test(el.getAttribute('role') || '') || el.hasAttribute('aria-activedescendant'));
    else if ((e.ctrlKey || e.metaKey || e.altKey) && key.length === 1 && !/^[acvxz]$/i.test(key)) record = true;
    if (!record) return;
    finalizeInput('key');
    const step = makeStep('key', el, { key: { key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey } });
    emit(step);
    beginObservation(step.id, 'after-operation');
  }

  // ---- URL 変更 (SPA) -------------------------------------------------------
  let lastHref = location.href;
  function checkUrl() {
    if (location.href === lastHref) return;
    const from = lastHref;
    lastHref = location.href;
    if (!isTop || !active()) return;
    if (obs) obs.items.push({ type: 'url-change', at: iso(), from, to: location.href });
    // URL変更は「操作」ではなく観測イベント。進行中の観測は終了させずに合流する。
    const step = makeStep('spa-navigation', null, { navigation: { fromUrl: from, toUrl: location.href, navigationType: 'same-document' } });
    void send({ t: 'step', step, dom: snapshotDom('at-operation') });
    beginObservation(step.id, 'after-operation');
  }

  // ---- 要素選択モード -------------------------------------------------------
  let overlay: HTMLElement | null = null;
  let box: HTMLElement | null = null;
  function showOverlay() {
    if (overlay) return;
    overlay = document.createElement(OVERLAY_TAG);
    const sr = overlay.attachShadow({ mode: 'closed' });
    sr.innerHTML = `<style>
      .box{position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2f6f8f;background:rgba(47,111,143,.14);border-radius:3px;display:none}
      .tip{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#243b53;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:6px 12px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
    </style><div class="box"></div>${isTop ? '<div class="tip">TraceLens: 注記する要素をクリック（Esc でキャンセル）</div>' : ''}`;
    box = sr.querySelector('.box');
    document.documentElement.appendChild(overlay);
  }
  function hideOverlay() { overlay?.remove(); overlay = null; box = null; }
  function setPicker(on: boolean) {
    if (on === pickerOn) return;
    pickerOn = on;
    if (on) { finalizeInput('other-operation'); showOverlay(); } else hideOverlay();
  }
  function pickerMove(e: MouseEvent) {
    if (!pickerOn || !box) return;
    const el = deepTarget(e);
    if (!el || isOwn(el)) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  /** 選択モード中はページ側の処理（送信・遷移など）を起こさない */
  function pickerBlock(e: Event) {
    if (!pickerOn) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type !== 'click' || !e.isTrusted) return;
    const el = deepTarget(e);
    if (!el || isOwn(el)) return;
    hideOverlay(); pickerOn = false;
    const step = makeStep('element-note', el, { value: readValue(el) });
    emit(step, 'manual');
    void send({ t: 'picker-done', cancelled: false, stepId: step.id });
    void send({ t: 'shot', shots: [{ stepId: step.id, phase: 'manual', method: pickerMode === 'element' ? 'element' : 'visible' }] });
  }
  function pickerKey(e: KeyboardEvent) {
    if (!pickerOn) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape' && e.type === 'keydown') { setPicker(false); void send({ t: 'picker-done', cancelled: true }); }
  }

  // ---- リスナー登録（window の capture 段階） --------------------------------
  const opt = { capture: true, passive: true } as const;
  const block = { capture: true } as const;
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'submit']) window.addEventListener(t, pickerBlock, block);
  window.addEventListener('keydown', pickerKey, block);
  window.addEventListener('keyup', pickerKey, block);
  window.addEventListener('mousemove', pickerMove, opt);
  window.addEventListener('pointerdown', onPointerDown, opt);
  window.addEventListener('click', onClick, opt);
  window.addEventListener('change', onChange, opt);
  window.addEventListener('input', onInput, opt);
  window.addEventListener('compositionstart', onComposition, opt);
  window.addEventListener('compositionend', onComposition, opt);
  window.addEventListener('focusout', onFocusOut, opt);
  window.addEventListener('keydown', onKeyDown, opt);
  window.addEventListener('pagehide', () => { finalizeInput('page-unload'); endObservation('page-unload'); });
  window.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) void sync(true); });
  window.addEventListener('popstate', () => setTimeout(checkUrl, 0));
  window.addEventListener('hashchange', () => setTimeout(checkUrl, 0));
  try { (window as any).navigation?.addEventListener('currententrychange', () => setTimeout(checkUrl, 0)); } catch { /* 未対応ブラウザ */ }
  setInterval(() => { if (active()) checkUrl(); else lastHref = location.href; }, 500);
  {
    // iframe / frame の読み込みを検知して、SW に全フレームへの注入をやり直させる。
    // トップだけでなく各フレームで検知する: フレームの中にあとから追加された入れ子のフレーム（ダイアログ内の処理用フレームなど）の
    // 読み込みは、そのフレームの文書でしか観測できないため（トップだけで検知していたときは、入れ子のフレーム内の操作を記録できなかった）
    let ft: number | undefined;
    document.addEventListener('load', (e) => {
      const tag = (e.target as Element)?.tagName;
      if (!active() || (tag !== 'IFRAME' && tag !== 'FRAME')) return;
      clearTimeout(ft); ft = window.setTimeout(() => void send({ t: 'frames-changed' }), 80);
    }, true);
  }

  // ---- ページ全体の取得（SW が各位置で captureVisibleTab して合成する。スクロールは TraceLens が起こしたもの） ----
  // ユーザーの操作として記録しない（isTrusted でないため既存のハンドラーは反応しない）。取得中にユーザー操作があれば破棄させる。
  let scanOrigin = { x: 0, y: 0 };
  let scanInterfered = false;
  let scanTimer: number | undefined;
  const docToken = newId('doc');
  const pageHeight = () => Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0);
  const onInterfere = (e: Event) => { if (scanning && e.isTrusted) scanInterfered = true; };
  for (const t of ['wheel', 'keydown', 'pointerdown', 'touchstart']) window.addEventListener(t, onInterfere, { capture: true, passive: true });
  const scrollNow = (x: number, y: number) => window.scrollTo({ left: x, top: y, behavior: 'instant' as ScrollBehavior });
  function endScan(): ScanEndReply {
    clearTimeout(scanTimer);
    const was = scanning;
    scanning = false;
    if (was) { scrollNow(scanOrigin.x, scanOrigin.y); noteChange('scroll'); }
    return { interfered: scanInterfered, restored: Math.abs(scrollY - scanOrigin.y) <= 2 && Math.abs(scrollX - scanOrigin.x) <= 2 };
  }
  function handleScan(msg: Extract<ToContentMsg, { t: 'scan-begin' | 'scan-scroll' | 'scan-end' }>, respond: (r: unknown) => void) {
    if (msg.t === 'scan-begin') {
      if (!active() || pickerOn || scanning) { respond({ ok: false, reason: pickerOn ? '要素選択中のためページ全体を取得できない' : scanning ? '別のページ全体の取得が進行中' : '記録中ではない' } satisfies ScanBeginReply); return; }
      finalizeInput('other-operation');
      const step = makeStep('manual-capture');
      emit(step, 'manual');
      scanOrigin = { x: Math.round(scrollX), y: Math.round(scrollY) };
      scanning = true; scanInterfered = false;
      scanTimer = window.setTimeout(() => { endScan(); }, 90000); // SW が途中で止まっても、スクロール位置を戻す
      const h = pageHeight();
      respond({ ok: true, stepId: step.id, docToken, pageHeight: h, viewport: pageInfo().viewport, noWindowScroll: h <= innerHeight + 1 } satisfies ScanBeginReply);
      return;
    }
    if (msg.t === 'scan-scroll') {
      if (!scanning) { respond({ scrollY: Math.round(scrollY), pageHeight: pageHeight(), docToken } satisfies ScanScrollReply); return; }
      scrollNow(scanOrigin.x, msg.y);
      window.setTimeout(() => respond({ scrollY: Math.round(scrollY), pageHeight: pageHeight(), docToken } satisfies ScanScrollReply), 120);
      return;
    }
    respond(endScan());
  }

  // ---- Service Worker との同期 ----------------------------------------------
  function whenLoaded(fn: () => void) {
    if (document.readyState === 'complete') { fn(); return; }
    let done = false;
    const run = () => { if (!done) { done = true; fn(); } };
    window.addEventListener('load', () => setTimeout(run, 0), { once: true });
    setTimeout(run, 6000);
  }
  const navEntry = () => performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;

  async function sync(init: boolean) {
    const reply: HelloReply | undefined = await send({ t: 'hello', top: isTop, url: location.href, init, navType: navEntry()?.type, timeOrigin: performance.timeOrigin });
    if (!reply) return;
    const wasActive = active();
    recording = reply.recording; paused = reply.paused;
    if (reply.sessionId && reply.sessionId !== accountedSession) {
      // 新しい記録セッション: 前のセッションで観測・入力した欄も、このセッションでは改めて観測する
      if (accountedSession !== undefined) accounted = new WeakSet<Element>();
      accountedSession = reply.sessionId;
    }
    if (wasActive && !active()) { finalizeInput('paused'); endObservation('paused'); }
    setObserving(active());
    pickerMode = reply.pickerMode ?? 'note';
    setTracking(active() && !!reply.trackChanges);
    setPicker(reply.picker && active());
    if (active()) { lastHref = location.href; markSensitiveFields(document); }
    if (!isTop || !active() || !reply.announce) return;
    const navType = navEntry()?.type;
    const kind: StepKind = reply.announce === 'session-start' ? 'session-start' : navType === 'reload' ? 'reload' : 'navigation';
    const phase: ArtifactPhase = kind === 'session-start' ? 'session-start' : 'after-load';
    const step = makeStep(kind, null, kind === 'session-start' ? {} : { navigation: { fromUrl: reply.fromUrl, toUrl: location.href, navigationType: navType, navigationStartAt: iso(performance.timeOrigin) } });
    void send({ t: 'step', step });
    whenLoaded(() => {
      if (!active()) return;
      void send({ t: 'patch', stepId: step.id, set: { page: pageInfo() }, dom: snapshotDom(phase) });
      beginObservation(step.id, phase);
    });
  }

  chrome.runtime.onMessage.addListener((msg: ToContentMsg, _sender, sendResponse) => {
    if (dead) return;
    if (msg.t === 'sync') { void sync(false); return; }
    if (msg.t === 'scan-begin' || msg.t === 'scan-scroll' || msg.t === 'scan-end') { if (isTop) handleScan(msg, sendResponse); return true; }
    if (msg.t === 'press-rect') {
      const el = pressEls.get(msg.pressId)?.deref();
      if (!el) { if (isTop) sendResponse({ rect: null, viewport: pageInfo().viewport } satisfies PressRectReply); return; }
      sendResponse({ rect: topRect(el).rect, ...(isTop ? { viewport: pageInfo().viewport } : {}) } satisfies PressRectReply);
      return;
    }
    if (msg.t === 'shot-meta') {
      const el = stepEls.get(msg.stepId)?.deref();
      if (!el && !isTop) return; // このフレームの要素ではない
      const tr = el ? topRect(el) : { rect: null, note: undefined as string | undefined };
      const meta: ScreenshotMeta = { url: isTop ? location.href : undefined, viewport: isTop ? pageInfo().viewport : undefined, targetRectAtCapture: tr.rect, targetRectNote: tr.note };
      sendResponse({ meta } satisfies ShotMetaReply);
      return;
    }
    if (!isTop) return;
    if (msg.t === 'manual-capture') {
      if (!active()) return;
      finalizeInput('other-operation');
      const step = makeStep('manual-capture');
      emit(step, 'manual');
      void send({ t: 'shot', shots: [{ stepId: step.id, phase: 'manual' }] });
      sendResponse({ ok: true, stepId: step.id });
      return;
    }
    if (msg.t === 'finish') {
      finalizeInput('paused');
      endObservation('paused');
      setPicker(false);
      sendResponse({ step: makeStep('session-end'), dom: snapshotDom('session-end') } satisfies FinishReply);
    }
  });

  void sync(true);
})();
