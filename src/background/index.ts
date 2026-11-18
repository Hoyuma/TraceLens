// TraceLens Service Worker
// - 記録セッションの状態は chrome.storage.session、記録本体は IndexedDB に置き、
//   Service Worker が停止・再起動しても保存済みの記録を失わない
// - 収集対象は、ユーザーが記録を開始した1つのタブだけ
import { SCHEMA_VERSION, emptyAnnotation, newId, type Artifact, type ArtifactPhase, type CaptureInfo, type EnvironmentInfo, type ScreenshotMeta, type Step, type StepKind } from '../shared/types';
import { FULL_PAGE_LIMITS, cropForElement, planScroll, sameRect, type ScannedFrame } from '../shared/capture';
import { decideBeforeScreenshot } from '../shared/beforeShot';
import { decidePressShot } from '../shared/pressShot';
import { applySwitch, decideOnCreated, decideOnRemoved, type TabRef, type TabSwitchState } from '../shared/tabSwitch';
import { composeFullPage, cropBlob, imageSize } from './imageOps';
import { addStep, getScenario, getStep, listScenarios, listSteps, patchScenario, patchStep, putArtifact } from '../shared/db';
import { initReplay, isReplayActive, onReplayPage, onReplayUi } from './replay';
import type { ReplayPageMsg, ReplayUiMsg } from '../shared/messages';
import { EVT_CHANGED, SETTINGS_KEY, STATE_KEY, type RecordSettings, type ScanBeginReply, type ScanEndReply, type ScanScrollReply, type ActiveSession, type ContentMsg, type DomFailure, type DomPayload, type FinishReply, type HelloReply, type PressRectReply, type ShotMetaReply, type StepDraft, type UiMsg, type UiReply } from '../shared/messages';

const LAST_ENDED_KEY = 'tracelens.lastEnded';
const CAPTURE_MIN_INTERVAL_MS = 600; // captureVisibleTab は毎秒2回まで (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)
const iso = (ms: number = Date.now()) => new Date(ms).toISOString();

// ---- 状態 -------------------------------------------------------------------
let cache: ActiveSession | null | undefined;
async function getS(): Promise<ActiveSession | null> {
  if (cache === undefined) cache = ((await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as ActiveSession | undefined) ?? null;
  return cache;
}
async function setS(s: ActiveSession | null): Promise<void> {
  cache = s;
  if (s) await chrome.storage.session.set({ [STATE_KEY]: s }); else await chrome.storage.session.remove(STATE_KEY);
}
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch((e) => console.warn('[TraceLens]', e));
  return p;
}
function notify() { chrome.runtime.sendMessage({ t: EVT_CHANGED }).catch(() => {}); }
function broadcastSync(tabId: number) { chrome.tabs.sendMessage(tabId, { t: 'sync' }).catch(() => {}); }

function environment(): EnvironmentInfo {
  const uad = (navigator as any).userAgentData;
  return { userAgent: navigator.userAgent, brands: uad?.brands, platform: uad?.platform, language: navigator.language, extensionVersion: chrome.runtime.getManifest().version };
}

// ---- 注入 -------------------------------------------------------------------
type InjectResult = { ok: true } | { ok: false; code: 'restricted-page' | 'no-permission'; message: string };
async function inject(tabId: number): Promise<InjectResult> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'], injectImmediately: true });
    return { ok: true };
  } catch (e) {
    const m = String((e as Error)?.message || e);
    const restricted = /chrome:\/\/|edge:\/\/|devtools:|extensions gallery|web ?store|cannot be scripted|chrome-extension:|extension:\/\/|about:|view-source|error page|pdf/i.test(m);
    return { ok: false, code: restricted ? 'restricted-page' : 'no-permission', message: m };
  }
}
const INJECT_GUIDE: Record<string, string> = {
  'restricted-page': 'このページ（ブラウザ内部ページ・拡張機能ストア等）は拡張機能から操作を記録できません。',
  'no-permission': 'このタブへのアクセス権がありません。記録したいタブを表示した状態でツールバーの TraceLens アイコンをクリックしてください（別オリジンへ遷移すると権限は失効します）。',
};

// ---- ステップ保存 -----------------------------------------------------------
const NO_SHOT: StepKind[] = ['notice', 'prefill'];
const BEFORE_KINDS = new Set<StepKind>(['click', 'input', 'select', 'check', 'key']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function storeDom(step: Step, dom: DomPayload | DomFailure | undefined): Promise<void> {
  if (!dom) return;
  if ('failed' in dom) { step.dom = { status: 'failed', reasonCode: 'serialize-error', reason: dom.reason }; return; }
  const a: Artifact = { id: `dom_${step.id}`, scenarioId: step.scenarioId, stepId: step.id, type: 'dom', capturedAt: dom.capturedAt, phase: dom.phase, includeInExport: true, html: dom.html, formState: dom.formState, truncated: dom.truncated, frameUrl: dom.frameUrl, ...(dom.boxViewport ? { boxViewport: dom.boxViewport } : {}) };
  await putArtifact(a);
  step.dom = { status: 'captured', artifactId: a.id };
  if (dom.truncated) step.limitations.push({ code: 'dom-truncated', message: 'DOMがサイズ上限を超えたため、後半を省略して保存した' });
}
async function storeStep(s: ActiveSession, draft: StepDraft, dom?: DomPayload | DomFailure, over: Partial<Step> = {}): Promise<Step> {
  const step: Step = {
    schemaVersion: SCHEMA_VERSION, id: draft.id, scenarioId: s.scenarioId, sessionId: s.sessionId, seq: s.nextSeq++,
    kind: draft.kind, operationAt: draft.operationAt, operationEndAt: draft.operationEndAt, page: draft.page, frame: draft.frame,
    target: draft.target, value: draft.value, key: draft.key, navigation: draft.navigation, ...(draft.prefill ? { prefill: draft.prefill } : {}),
    observations: [], screenshot: NO_SHOT.includes(draft.kind) ? { status: 'not-applicable' } : { status: 'pending' },
    dom: { status: 'pending' }, elementCapture: draft.elementCapture, limitations: draft.limitations ?? [],
    annotation: draft.annotation ?? emptyAnnotation(), includeInExport: true, ...over,
  };
  if (draft.press && s.pressShot !== false) step.pressScreenshot = { status: 'pending', pressAt: iso(draft.press.atMs) };
  if (s.beforeShot && BEFORE_KINDS.has(draft.kind)) {
    // 新しい画像は作らない。直前の観測で取得した画像以降に画面変化の観測がなければ、その画像を参照する
    const opMs = Date.parse(draft.operationAt);
    let lastChange: { atMs: number; kind: import('../shared/beforeShot').ChangeKind } | null | undefined;
    if (draft.observedChange === undefined) lastChange = undefined;
    else {
      const all = [...(draft.observedChange ? [draft.observedChange] : []), ...(s.changes ?? []).filter((c) => c.atMs < opMs)];
      lastChange = all.length ? all.reduce((a, b) => (b.atMs > a.atMs ? b : a)) : null;
    }
    step.beforeScreenshot = decideBeforeScreenshot({ docEpoch: s.docEpoch, operationAtMs: opMs, viewport: draft.page.viewport, lastChange, prev: s.lastShot ?? null });
  }
  await setS(s);
  await storeDom(step, dom);
  await addStep(step);
  if (step.pressScreenshot && draft.press) void finishPress(step, draft.press, draft.frame.browserFrameId ?? 0).catch((e) => console.warn('[TraceLens] press', e));
  return step;
}
async function bgStep(s: ActiveSession, kind: StepKind, over: Partial<Step>): Promise<Step> {
  const tab = await chrome.tabs.get(s.tabId).catch(() => null);
  // タブのURLが見えない（アクセス権なし）場合に、古いURLをこのステップのURLとして記録しない
  const url = tab?.url ?? '(URL取得不可: このタブへのアクセス権がない、またはタブが存在しない)';
  const draft: StepDraft = { id: newId('stp'), kind, operationAt: iso(), page: { url, title: tab?.title ?? '' }, frame: { isTop: true, path: [], url }, elementCapture: { status: 'not-applicable' }, limitations: [] };
  return storeStep(s, draft, undefined, over);
}
/** 取得待ちのまま残った成果物を、理由付きの「未取得」に確定する */
async function settlePending(scenarioId: string, sessionId: string, reason: string, beforeSeq = Infinity): Promise<void> {
  for (const st of await listSteps(scenarioId)) {
    if (st.sessionId !== sessionId || st.seq >= beforeSeq) continue;
    if (st.screenshot.status !== 'pending' && st.dom.status !== 'pending' && st.pressScreenshot?.status !== 'pending') continue;
    await patchStep(st.id, (x) => {
      if (x.screenshot.status === 'pending') x.screenshot = { status: 'skipped', reasonCode: 'not-captured', reason };
      if (x.pressScreenshot?.status === 'pending') x.pressScreenshot = { ...x.pressScreenshot, status: 'skipped', reasonCode: 'not-captured', reason: reason.replace('画面', '押下時の画面') };
      if (x.dom.status === 'pending') x.dom = { status: 'failed', reasonCode: 'not-captured', reason: reason.replace('画面', 'DOM') };
    });
  }
}

// ---- 画面取得 ---------------------------------------------------------------
let lastCaptureAt = 0;
/**
 * captureVisibleTab の呼び出し枠を待って確保する（押下時の画面の取得と共有するため、確保は同期的に行う）。
 * 戻った直後（同じマイクロタスクの続き）で captureVisibleTab を呼ぶこと。
 */
async function waitCaptureSlot(): Promise<void> {
  for (;;) {
    const w = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
    if (w <= 0) { lastCaptureAt = Date.now(); return; }
    await sleep(w);
  }
}
const captureErr = (e: unknown) => {
  const m = String((e as Error)?.message || e);
  const perm = /permission|activeTab|all_urls/i.test(m);
  return { reasonCode: perm ? 'no-permission' : 'capture-error', reason: perm ? `画面取得の権限がない（対象タブでツールバーの TraceLens アイコンをクリックすると再許可される）: ${m}` : `画面取得に失敗: ${m}` };
};

// ---- 押下時の画面 -------------------------------------------------------------
// pointerdown の通知を受けたら、キューを通さずにすぐ取得を始める（クリックの処理で画面が変わる前の画像を残すため）。
// 画像は手順と結びつくまでメモリにだけ置く（SW が停止したら失われ、手順には理由つきの未取得を残す）。
type PressCapture = { ok: true; startedAtMs: number; endedAtMs: number; blob: Blob; sameDocument: boolean } | { ok: false; reasonCode: string; reason: string };
interface PressEntry { id: string; tabId: number; epoch: number; sessionId: string; atMs: number; rect: import('../shared/types').Rect | null; rectNote?: string; viewport?: ScreenshotMeta['viewport']; firstChangeAtMs: number | null; result: Promise<PressCapture> }
const presses = new Map<string, PressEntry>();
const PRESS_KEEP_MS = 20000;
function noteChangeForPresses(tabId: number, atMs: number) {
  for (const e of presses.values()) {
    if (e.tabId !== tabId) continue;
    const at = Math.max(atMs, e.atMs);
    if (at >= e.atMs && (e.firstChangeAtMs === null || at < e.firstChangeAtMs)) e.firstChangeAtMs = at;
  }
}
async function startPress(msg: Extract<ContentMsg, { t: 'press' }>, sender: chrome.runtime.MessageSender): Promise<void> {
  const s = await getS();
  if (!s || s.status !== 'recording' || sender.tab?.id !== s.tabId || s.pressShot === false) return;
  const capture = async (): Promise<PressCapture> => {
    // 枠を待つと押下時の画面ではなくなるため、空いていなければ取得しない
    if (lastCaptureAt + CAPTURE_MIN_INTERVAL_MS > Date.now()) return { ok: false, reasonCode: 'rate-limited', reason: '直前の画面取得から間がなく、取得回数の上限（毎秒 2 回）のため、押下時の画面を取得していない' };
    lastCaptureAt = Date.now();
    const startedAtMs = lastCaptureAt;
    let dataUrl: string;
    try { dataUrl = await chrome.tabs.captureVisibleTab(s.windowId, { format: 'png' }); } catch (e) { return { ok: false, ...captureErr(e) }; }
    const endedAtMs = Date.now();
    const tab = await chrome.tabs.get(s.tabId).catch(() => null);
    const cur = await getS();
    const sameDocument = !!tab && tab.active && tab.windowId === s.windowId && !!cur && cur.sessionId === s.sessionId && cur.docEpoch === s.docEpoch && cur.tabId === s.tabId;
    const blob = await (await fetch(dataUrl)).blob();
    return { ok: true, startedAtMs, endedAtMs, blob, sameDocument };
  };
  const e: PressEntry = { id: msg.pressId, tabId: s.tabId, epoch: s.docEpoch, sessionId: s.sessionId, atMs: msg.atMs, rect: msg.rect, rectNote: msg.rectNote, viewport: msg.viewport, firstChangeAtMs: null, result: capture() };
  presses.set(e.id, e);
  setTimeout(() => presses.delete(e.id), PRESS_KEEP_MS);
}
/** 手順に結びついた押下の画像を判定して保存する */
async function finishPress(step: Step, p: NonNullable<StepDraft['press']>, frameId: number): Promise<void> {
  const e = presses.get(p.id);
  const cap = e ? await e.result : null;
  await sleep(150); // 他のフレームからの画面変化の通知（最大 0.1 秒間引く）を待つ
  presses.delete(p.id);
  let rectAfter: import('../shared/types').Rect | null = null;
  let viewport = e?.viewport;
  if (e && cap?.ok) {
    const r = (await chrome.tabs.sendMessage(e.tabId, { t: 'press-rect', pressId: p.id }, { frameId }).catch(() => null)) as PressRectReply | null;
    rectAfter = r?.rect ?? null;
    if (!viewport) {
      const top = frameId === 0 ? r : (await chrome.tabs.sendMessage(e.tabId, { t: 'press-rect', pressId: '' }, { frameId: 0 }).catch(() => null)) as PressRectReply | null;
      viewport = top?.viewport;
    }
  }
  const changes = [e?.firstChangeAtMs ?? null, p.firstChangeAtMs].filter((x): x is number => x !== null);
  const d = decidePressShot({
    pressAtMs: p.atMs, operationAtMs: Date.parse(step.operationAt),
    capture: cap ? (cap.ok ? { ok: true, startedAtMs: cap.startedAtMs, endedAtMs: cap.endedAtMs } : cap) : null,
    firstChangeAtMs: changes.length ? Math.min(...changes) : null,
    sameDocument: !!cap && (!cap.ok || cap.sameDocument),
    rectAtPress: e?.rect ?? null, rectAfterCapture: rectAfter,
  });
  if (!d.keep || !cap || !cap.ok) {
    const r = d.keep ? { reasonCode: 'press-lost', reason: '押下時の画面の取得情報が見つからない' } : d;
    await patchStep(step.id, (x) => { if (x.pressScreenshot?.status === 'pending') x.pressScreenshot = { ...x.pressScreenshot, status: 'skipped', reasonCode: r.reasonCode, reason: r.reason }; });
    notify();
    return;
  }
  const capturedAt = iso(cap.endedAtMs);
  const meta: ScreenshotMeta = {
    url: step.page.url, viewport, targetRectAtCapture: d.highlight && viewport ? e!.rect : null,
    targetRectNote: d.highlight && viewport ? '押下時に測った対象要素の位置（取得の完了後に測り直して一致を確認した）' : d.highlightNote ?? e?.rectNote ?? 'トップのビューポートの情報がないため、操作位置を強調しない',
    timingNote: d.notes.join(' / '),
  };
  const a: Artifact = { id: `press_${step.id}`, scenarioId: step.scenarioId, stepId: step.id, type: 'screenshot', capturedAt, phase: 'at-press', includeInExport: true, blob: cap.blob, meta, masks: [] };
  const cur = await getStep(step.id);
  if (!cur || cur.pressScreenshot?.status !== 'pending') return; // 手順が削除された・記録終了で確定済み
  await putArtifact(a);
  await patchStep(step.id, (x) => { x.pressScreenshot = { status: 'captured', artifactId: a.id, pressAt: iso(p.atMs), captureStartedAt: iso(cap.startedAtMs), capturedAt, notes: d.notes }; });
  notify();
}

let capChain: Promise<unknown> = Promise.resolve();
type Shot = { stepId: string; phase: ArtifactPhase; method?: 'visible' | 'element' };
function requestShots(shots: Shot[], epoch: number, final = false, timingNote?: string): Promise<void> {
  const p = capChain.then(() => doShots(shots, epoch, final, timingNote));
  capChain = p.catch((e) => console.warn('[TraceLens] capture', e));
  return p;
}
async function failShots(shots: Shot[], reasonCode: string, reason: string) {
  for (const sh of shots) await patchStep(sh.stepId, (x) => { if (x.screenshot.status !== 'captured') x.screenshot = { status: 'failed', reasonCode, reason }; });
  notify();
}
async function getMeta(tabId: number, stepId: string): Promise<ScreenshotMeta> {
  const step = await getStep(stepId);
  const fid = step?.frame.browserFrameId ?? 0;
  const top = (await chrome.tabs.sendMessage(tabId, { t: 'shot-meta', stepId }, { frameId: 0 }).catch(() => null)) as ShotMetaReply | null;
  let meta: ScreenshotMeta = top?.meta ?? { targetRectAtCapture: null, targetRectNote: 'ページから取得時点の情報を得られなかった' };
  if (fid !== 0) {
    const f = (await chrome.tabs.sendMessage(tabId, { t: 'shot-meta', stepId }, { frameId: fid }).catch(() => null)) as ShotMetaReply | null;
    meta = { ...meta, targetRectAtCapture: f?.meta.targetRectAtCapture ?? null, targetRectNote: f ? f.meta.targetRectNote : 'フレームから対象要素の位置を取得できなかった' };
  }
  if (!step?.target) { meta.targetRectAtCapture = null; meta.targetRectNote = undefined; }
  else if (!meta.targetRectAtCapture && !meta.targetRectNote) meta.targetRectNote = '取得時点で対象要素との対応を確認できなかった';
  return meta;
}
async function doShots(shots: Shot[], epoch: number, final: boolean, timingNote?: string): Promise<void> {
  const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const s = await getS();
  if (!s) return failShots(shots, 'not-recording', '記録が終了していたため画面を取得していない');
  if (s.status !== 'recording' && !final) return failShots(shots, 'paused', '一時停止中のため画面を取得していない');
  if (s.docEpoch !== epoch) return failShots(shots, 'page-changed', '取得前にページが切り替わったため、この操作の画面は取得していない');
  const tab = await chrome.tabs.get(s.tabId).catch(() => null);
  if (!tab) return failShots(shots, 'tab-gone', '対象タブが閉じられていたため画面を取得できない');
  if (!tab.active) return failShots(shots, 'tab-inactive', '対象タブが前面に表示されていなかったため取得していない（他のタブの画像を混在させないため）');
  const metas = new Map<string, ScreenshotMeta>();
  const metaStart = Date.now();
  for (const sh of shots) metas.set(sh.stepId, { ...(await getMeta(s.tabId, sh.stepId)), ...(timingNote ? { timingNote } : {}) });
  // 要素選択の強調表示（TraceLens 自身のオーバーレイ）が画像に写らないよう、消えて描画されるのを待つ
  if (shots.some((x) => x.method === 'element')) await sleep(160);
  let dataUrl: string;
  try {
    await waitCaptureSlot(); // 押下時の画面の取得と枠を共有する
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    const r = captureErr(e);
    return failShots(shots, r.reasonCode, r.reason);
  }
  const capturedAt = iso();
  const tab2 = await chrome.tabs.get(s.tabId).catch(() => null);
  const s2 = await getS();
  if (!tab2 || !tab2.active || (tab.url && tab2.url !== tab.url) || !s2 || s2.docEpoch !== epoch)
    return failShots(shots, 'changed-during-capture', '取得中にタブまたはページが切り替わったため、画像を破棄した');
  const blob = await (await fetch(dataUrl)).blob();
  let kept = false;
  for (const sh of shots) {
    let out = blob; let meta = metas.get(sh.stepId); let info: CaptureInfo | undefined;
    if (sh.method === 'element') {
      const r = await cropElement(s.tabId, sh.stepId, blob, meta);
      if (!r.ok) { await failShots([sh], r.code, r.reason); continue; }
      out = r.blob; meta = r.meta; info = r.info;
    }
    const a: Artifact = { id: `shot_${sh.stepId}`, scenarioId: s.scenarioId, stepId: sh.stepId, type: 'screenshot', capturedAt, phase: sh.phase, includeInExport: true, blob: out, meta, masks: [], ...(info ? { captureInfo: info } : {}) };
    await putArtifact(a);
    const partial = info?.partial ? info.partialReason : undefined;
    await patchStep(sh.stepId, (x) => {
      x.screenshot = { status: 'captured', artifactId: a.id, ...(partial ? { reasonCode: 'partial', reason: partial } : {}) };
      if (partial) x.limitations.push({ code: 'element-clipped', message: partial });
    });
    // 表示領域の通常取得は、次の操作の「操作前の画面」の参照元になりうる（切り出し・合成した画像は対象外）
    if (!sh.method || sh.method === 'visible') {
      const cur = await getS();
      if (cur && cur.beforeShot && cur.docEpoch === epoch) { cur.lastShot = { artifactId: a.id, stepId: sh.stepId, capturedAt, startedAtMs: metaStart, docEpoch: epoch, viewport: meta?.viewport }; kept = true; }
    }
  }
  if (kept) { const cur = await getS(); if (cur) await setS(cur); }
  notify();
}

/** 取得した表示領域の画像から、要素の矩形で切り出す。取得の前後で位置を測り直して一致した場合だけ。 */
async function cropElement(tabId: number, stepId: string, blob: Blob, meta?: ScreenshotMeta): Promise<{ ok: true; blob: Blob; meta: ScreenshotMeta; info: CaptureInfo } | { ok: false; code: string; reason: string }> {
  const before = meta?.targetRectAtCapture, vp = meta?.viewport;
  if (!before || !vp) return { ok: false, code: 'element-not-located', reason: `取得直前に要素の位置を確認できなかったため、要素の画像を切り出していない（${meta?.targetRectNote ?? '理由不明'}）` };
  const after = (await getMeta(tabId, stepId)).targetRectAtCapture;
  if (!sameRect(before, after)) return { ok: false, code: 'element-moved', reason: '取得の前後で要素の位置が一致しなかった（または確認できなかった）ため、要素の画像を切り出していない' };
  const size = await imageSize(blob);
  if (!size) return { ok: false, code: 'image-unsupported', reason: 'この環境では画像のサイズを読み取れないため、要素の画像を切り出せない' };
  const c = cropForElement(before, vp, size.width, size.height);
  if (!c) return { ok: false, code: 'element-outside', reason: '要素が表示領域の外にあったため、要素の画像を切り出していない' };
  const cut = await cropBlob(blob, c.crop);
  if (!cut.ok) return { ok: false, code: 'image-op-failed', reason: cut.reason };
  const partialReason = c.clipped ? `要素の一部が表示領域の外にあったため、見えている部分（面積の約 ${Math.round(c.visibleRatio * 100)}%）だけを切り出した。表示領域外の部分は含まない` : undefined;
  const info: CaptureInfo = {
    method: 'element', cropRect: c.crop, elementRectCss: before, elementClipped: c.clipped, partial: c.clipped, partialReason,
    notes: ['表示領域の画像から、取得直前と直後に確認した要素の矩形で切り出した画像。矩形内に重なっている他の要素やポップアップも写る。'],
  };
  return { ok: true, blob: cut.value, info, meta: { ...(meta as ScreenshotMeta), targetRectAtCapture: null, targetRectNote: '要素単位で切り出した画像のため、操作位置の強調はしない（要素の矩形は captureInfo に記録）' } };
}

// ---- コンテンツスクリプトからのメッセージ ------------------------------------
async function onContent(msg: ContentMsg, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const s = await getS();
  const tabId = sender.tab?.id;
  const mine = !!s && tabId === s.tabId;
  switch (msg.t) {
    case 'change': {
      if (s && mine && s.beforeShot) { s.changes = [...(s.changes ?? []), { atMs: msg.atMs, kind: msg.kind }].slice(-16); await setS(s); }
      return { ok: true };
    }
    case 'hello': {
      if (!s || !mine) return { recording: false, paused: false, picker: false, announce: null } satisfies HelloReply;
      let announce: HelloReply['announce'] = null;
      let fromUrl: string | undefined;
      if (msg.top) {
        if (msg.init) { s.docEpoch++; await settlePending(s.scenarioId, s.sessionId, 'ページ遷移・再読込のため、この操作の画面は取得していない'); }
        if (s.status === 'recording') {
          if (s.awaitingStart) { announce = 'session-start'; s.awaitingStart = false; }
          else if (msg.init) { announce = 'navigation'; fromUrl = s.lastUrl; }
        }
        s.lastUrl = msg.url; s.needsPermission = undefined; s.lastNoticeKey = undefined;
        await setS(s);
      }
      return { recording: true, paused: s.status === 'paused', picker: s.picker, pickerMode: s.pickerShot === 'element' ? 'element' : 'note', trackChanges: !!s.beforeShot || s.pressShot !== false, announce, fromUrl, sessionId: s.sessionId } satisfies HelloReply;
    }
    case 'step': {
      if (!s || !mine || s.status !== 'recording') return { ok: false };
      const d = msg.step;
      d.frame.browserFrameId = sender.frameId;
      if (!d.frame.isTop && sender.tab?.url) d.page = { ...d.page, url: sender.tab.url, title: sender.tab.title ?? d.page.title };
      if (d.kind === 'spa-navigation' && d.navigation) s.lastUrl = d.navigation.toUrl;
      // 入力済みの値の観測は、直後の操作の手順で DOM を保存するため、この手順では DOM を取得しない
      await storeStep(s, d, msg.dom, d.kind === 'prefill' ? { dom: { status: 'not-applicable' } } : d.kind === 'session-start' || d.kind === 'navigation' || d.kind === 'reload' ? {} : msg.dom ? {} : { dom: { status: 'failed', reasonCode: 'no-dom', reason: 'DOMが送信されなかった' } });
      notify();
      return { ok: true };
    }
    case 'patch': {
      const last = (await chrome.storage.session.get(LAST_ENDED_KEY))[LAST_ENDED_KEY] as { tabId: number; sessionId: string } | undefined;
      const st = await getStep(msg.stepId);
      if (!st) return { ok: false };
      const ok = (mine && st.sessionId === s!.sessionId) || (!!last && last.tabId === tabId && last.sessionId === st.sessionId) || (!!s && s.sessionId === st.sessionId && !!s.tabStack?.some((t) => t.tabId === tabId)); // 切り替え前のタブからの、確定済みの手順への追記
      if (!ok) return { ok: false };
      await patchStep(msg.stepId, (x) => {
        if (msg.set?.value) x.value = msg.set.value;
        if (msg.set?.operationEndAt) x.operationEndAt = msg.set.operationEndAt;
        if (msg.set?.page) x.page = msg.set.page;
        if (msg.observations) x.observations.push(...msg.observations);
      });
      if (msg.dom) { const cur = await getStep(msg.stepId); if (cur) { const tmp = { ...cur, limitations: [...cur.limitations] }; await storeDom(tmp, msg.dom); await patchStep(msg.stepId, (x) => { x.dom = tmp.dom; x.limitations = tmp.limitations; }); } }
      notify();
      return { ok: true };
    }
    case 'shot': {
      if (!s || !mine || s.status !== 'recording') { await failShots(msg.shots, s && !mine ? 'tab-switched' : 'not-recording', s && !mine ? '記録対象タブが切り替わったため、切り替え前のタブの画面は取得していない' : '記録中ではないため画面を取得していない'); return { ok: false }; }
      void requestShots(msg.shots, s.docEpoch, false, msg.timingNote);
      return { ok: true };
    }
    case 'shot-skip': {
      await patchStep(msg.stepId, (x) => { if (x.screenshot.status === 'pending') x.screenshot = { status: 'skipped', reasonCode: msg.reasonCode, reason: msg.reason }; });
      notify();
      return { ok: true };
    }
    case 'picker-done': {
      if (s && mine) { s.picker = false; await setS(s); broadcastSync(s.tabId); notify(); }
      return { ok: true };
    }
    case 'frames-changed': {
      if (s && mine) await inject(s.tabId);
      return { ok: true };
    }
  }
}

// ---- セッション制御 ---------------------------------------------------------
async function endSession(s: ActiveSession, status: 'ended' | 'interrupted', endReason: string): Promise<void> {
  await settlePending(s.scenarioId, s.sessionId, '記録終了までに画面を取得できなかった');
  await patchScenario(s.scenarioId, (sc) => {
    const ses = sc.sessions.find((x) => x.id === s.sessionId);
    if (ses) { ses.status = status; ses.endedAt = iso(); ses.endReason = endReason; const p = ses.pauses.at(-1); if (p && !p.resumedAt) p.resumedAt = ses.endedAt; }
  });
  await chrome.storage.session.set({ [LAST_ENDED_KEY]: { tabId: s.tabId, sessionId: s.sessionId } });
  await setS(null);
  broadcastSync(s.tabId);
  notify();
}

const FULL_PAGE_NOTES = [
  '固定ヘッダー・固定フッターなど画面に固定された要素は、各位置の画像に写るため重複して写ることがある',
  '遅延読み込みやスクロールで内容が変わるページでは、各位置の取得時点の状態を継ぎ合わせた画像であり、実際の見た目と一致しないことがある',
  '対象はウィンドウ自体のスクロール。ページ内の別のスクロール領域（overflow）の続きは取得しない',
];

/** ページ全体: 取得を始めたら、取得は captureVisibleTab の間隔に従って順に行う（記録のキューとは別に進める） */
async function startFullPage(s: ActiveSession): Promise<UiReply> {
  const begin = (await chrome.tabs.sendMessage(s.tabId, { t: 'scan-begin' }, { frameId: 0 }).catch(() => null)) as ScanBeginReply | null;
  if (!begin) {
    const st = await bgStep(s, 'manual-capture', { dom: { status: 'failed', reasonCode: 'page-unreachable', reason: 'ページに接続できないためDOMを取得できない（ブラウザ内部ページ、またはアクセス権の失効）' }, screenshot: { status: 'failed', reasonCode: 'page-unreachable', reason: 'ページに接続できないため、ページ全体を取得できない' } });
    notify();
    return { ok: true };
  }
  if (!begin.ok || !begin.stepId || !begin.viewport) return { ok: false, code: 'scan-refused', message: begin.reason ?? 'ページ全体を取得できません。' };
  const p = capChain.then(() => runFullPage(s.tabId, begin, s.docEpoch, s.sessionId));
  capChain = p.catch((e) => console.warn('[TraceLens] full-page', e));
  return { ok: true };
}
async function waitStep(id: string, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await getStep(id)) return true; await sleep(100); }
  return false;
}
type Fail = { code: string; reason: string };
async function runFullPage(tabId: number, begin: ScanBeginReply, epoch: number, sessionId: string): Promise<void> {
  const stepId = begin.stepId!, vp = begin.viewport!;
  const dpr = vp.devicePixelRatio || 1;
  const plan = planScroll({ pageHeight: begin.pageHeight ?? vp.height, viewportWidth: vp.width, viewportHeight: vp.height, devicePixelRatio: dpr });
  const frames: ScannedFrame[] = []; const blobs: Blob[] = [];
  const notes = [...FULL_PAGE_NOTES];
  if (begin.noWindowScroll) notes.push('ウィンドウ自体がスクロールしないページだった。内部のスクロール領域だけが動くページの場合、その続きは取得していない');
  let fail: Fail | null = null; let firstAt = '', lastAt = ''; let heightChanged = false;
  const check = async (): Promise<Fail | null> => {
    const cur = await getS();
    if (!cur || cur.sessionId !== sessionId) return { code: 'not-recording', reason: '記録が終了したため、ページ全体の取得を中止した' };
    if (cur.status !== 'recording') return { code: 'paused', reason: '一時停止されたため、ページ全体の取得を中止した' };
    if (cur.docEpoch !== epoch || cur.tabId !== tabId) return { code: 'page-changed', reason: '取得中にページまたは記録対象タブが切り替わったため、取得を破棄した' };
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return { code: 'tab-gone', reason: '対象タブが閉じられたため、取得を中止した' };
    if (!t.active) return { code: 'tab-inactive', reason: '対象タブが前面に表示されなくなったため、取得を破棄した（他のタブの画像を混在させないため）' };
    return null;
  };
  for (const y of plan.positions) {
    if ((fail = await check())) break;
    const r = (await chrome.tabs.sendMessage(tabId, { t: 'scan-scroll', y }, { frameId: 0 }).catch(() => null)) as ScanScrollReply | null;
    if (!r || r.docToken !== begin.docToken) { fail = { code: 'page-changed', reason: '取得中にページへ接続できなくなった、またはページが切り替わったため、取得を破棄した' }; break; }
    const maxY = Math.max(0, r.pageHeight - vp.height);
    if (Math.abs(r.scrollY - y) > 2 && Math.abs(r.scrollY - maxY) > 2) { fail = { code: 'scroll-mismatch', reason: '指定したスクロール位置へ移動できなかった（ユーザーのスクロールなど）ため、取得を破棄した' }; break; }
    if (Math.abs(r.pageHeight - (begin.pageHeight ?? 0)) > 2) heightChanged = true;
    if (frames.length && frames[frames.length - 1].scrollY === r.scrollY) continue;
    const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    if ((fail = await check())) break;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) { fail = { code: 'tab-gone', reason: '対象タブが閉じられたため、取得を中止した' }; break; }
    let url: string;
    try { await waitCaptureSlot(); url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); } catch (e) {
      const m = String((e as Error)?.message || e);
      fail = { code: /permission|activeTab|all_urls/i.test(m) ? 'no-permission' : 'capture-error', reason: `画面取得に失敗: ${m}` }; break;
    }
    const at = iso(); firstAt ||= at; lastAt = at;
    const tab2 = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab2 || !tab2.active || (tab.url && tab2.url !== tab.url)) { fail = { code: 'changed-during-capture', reason: '取得中にタブまたはページが切り替わったため、画像を破棄した' }; break; }
    const b = await (await fetch(url)).blob();
    const sz = await imageSize(b);
    if (!sz) { fail = { code: 'image-unsupported', reason: 'この環境では画像のサイズを読み取れないため、合成できない' }; break; }
    blobs.push(b); frames.push({ scrollY: r.scrollY, imageWidth: sz.width, imageHeight: sz.height });
  }
  // 終了時は必ずスクロール位置を戻す（失敗・中止のときも）
  const end = (await chrome.tabs.sendMessage(tabId, { t: 'scan-end', x: vp.scrollX, y: vp.scrollY }, { frameId: 0 }).catch(() => null)) as ScanEndReply | null;
  if (!fail && end?.interfered) fail = { code: 'user-interference', reason: '取得中にユーザー操作（スクロール・キー・クリックなど）があったため、画像を破棄した' };
  if (!fail && !end) fail = { code: 'page-changed', reason: '取得の終了時にページへ接続できなかった（ページが切り替わった可能性）ため、画像を破棄した' };
  if (!fail && !frames.length) fail = { code: 'no-frames', reason: '画像を取得できなかった' };
  await waitStep(stepId);
  if (!fail) fail = await check();
  if (fail) { await failShots([{ stepId, phase: 'manual' }], fail.code, fail.reason); return; }
  const c = await composeFullPage(blobs, frames, dpr, plan.coveredHeight);
  if (!c.ok) { await failShots([{ stepId, phase: 'manual' }], 'image-op-failed', c.reason); return; }
  if (heightChanged) notes.push('取得中にページの高さが変化した（遅延読み込みなど）。先頭の高さの計測値より後の部分は含まれない、または継ぎ目がずれることがある');
  if (end && !end.restored) notes.push('スクロール位置を元に戻せなかった可能性がある');
  const info: CaptureInfo = {
    method: 'full-page', frameCount: frames.length, composedHeightCss: plan.coveredHeight, pageHeightCss: begin.pageHeight,
    partial: plan.partial, partialReason: plan.partialReason, notes: [...notes, `各画像の取得時刻の範囲: ${firstAt} 〜 ${lastAt}`, `上限: 最大 ${FULL_PAGE_LIMITS.maxFrames} 枚・高さ ${FULL_PAGE_LIMITS.maxHeightDevicePx} デバイス px・合計 ${FULL_PAGE_LIMITS.maxTotalPixels} 画素`],
  };
  const st = await getStep(stepId);
  const s = await getS();
  const a: Artifact = {
    id: `shot_${stepId}`, scenarioId: st?.scenarioId ?? s?.scenarioId ?? '', stepId, type: 'screenshot', capturedAt: lastAt, phase: 'manual', includeInExport: true, blob: c.value.blob, masks: [], captureInfo: info,
    meta: { url: st?.page.url, viewport: vp, targetRectAtCapture: null, targetRectNote: 'ページ全体の合成画像のため、操作位置の強調はしない', timingNote: `ページ全体を ${frames.length} 枚のスクロール取得で合成した画像（各部分の取得時刻は異なる）。${plan.partial ? plan.partialReason + '。' : ''}固定ヘッダーの重複・遅延読み込み・スクロールで変化する内容は、実際の見た目と一致しないことがある` },
  };
  await putArtifact(a);
  await patchStep(stepId, (x) => {
    x.screenshot = { status: 'captured', artifactId: a.id, ...(plan.partial ? { reasonCode: 'partial', reason: plan.partialReason } : {}) };
    x.limitations.push({ code: 'full-page-composite', message: 'ページ全体の画像は、スクロールしながら取得した表示領域の画像の合成であり、実際の見た目と一致しないことがある' });
    if (plan.partial) x.limitations.push({ code: 'full-page-partial', message: plan.partialReason ?? '上限により途中までを取得した' });
  });
  notify();
}

async function manualCapture(s: ActiveSession, mode: 'visible' | 'full-page' = 'visible'): Promise<UiReply> {
  if (s.status !== 'recording') return { ok: false, code: 'paused', message: '一時停止中は画面を保存できません。再開してください。' };
  if (mode === 'full-page') return startFullPage(s);
  const r = await chrome.tabs.sendMessage(s.tabId, { t: 'manual-capture' }, { frameId: 0 }).catch(() => null);
  if (!r) {
    // ページに接続できない（内部ページ・権限失効など）。DOMは取得失敗として残し、画像だけ試みる
    const st = await bgStep(s, 'manual-capture', { dom: { status: 'failed', reasonCode: 'page-unreachable', reason: 'ページに接続できないためDOMを取得できない（ブラウザ内部ページ、またはアクセス権の失効）' } });
    void requestShots([{ stepId: st.id, phase: 'manual' }], s.docEpoch);
    notify();
  }
  return { ok: true };
}

async function onUi(msg: UiMsg): Promise<UiReply> {
  const s = await getS();
  switch (msg.t) {
    case 'ui:state': return { ok: true, session: s };
    case 'ui:start': {
      if (s) return { ok: false, code: 'already', message: 'すでに記録中のセッションがあります。終了してから開始してください。' };
      const sc = await getScenario(msg.scenarioId);
      if (!sc) return { ok: false, code: 'no-scenario', message: 'シナリオが見つかりません。' };
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      if (!tab || tab.id === undefined) return { ok: false, code: 'no-tab', message: '記録対象のタブが見つかりません。' };
      const steps = await listSteps(sc.id);
      const settings = ((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as RecordSettings | undefined) ?? {};
      const ns: ActiveSession = { scenarioId: sc.id, sessionId: newId('ses'), tabId: tab.id, windowId: tab.windowId, status: 'recording', startedAt: Date.now(), pausedAccumMs: 0, lastUrl: tab.url, awaitingStart: true, picker: false, beforeShot: !!settings?.beforeShot, pressShot: settings?.pressShot !== false, followNewTab: !!settings?.followNewTab, tabStack: [], nextSeq: (steps.at(-1)?.seq ?? 0) + 1, docEpoch: 0 };
      await setS(ns);
      const r = await inject(tab.id);
      if (!r.ok) { await setS(null); return { ok: false, code: r.code, message: `${INJECT_GUIDE[r.code]}（詳細: ${r.message}）` }; }
      await patchScenario(sc.id, (x) => { x.sessions.push({ id: ns.sessionId, startedAt: iso(ns.startedAt), status: 'recording', startUrl: tab.url, environment: environment(), pauses: [] }); });
      broadcastSync(tab.id);
      notify();
      return { ok: true, session: ns };
    }
    case 'ui:pause': {
      if (!s || s.status !== 'recording') return { ok: false };
      s.status = 'paused'; s.pausedAt = Date.now(); s.picker = false;
      await setS(s);
      await patchScenario(s.scenarioId, (sc) => { const ses = sc.sessions.find((x) => x.id === s.sessionId); if (ses) { ses.status = 'paused'; ses.pauses.push({ pausedAt: iso() }); } });
      broadcastSync(s.tabId);
      return { ok: true, session: s };
    }
    case 'ui:resume': {
      if (!s || s.status !== 'paused') return { ok: false };
      s.pausedAccumMs += Date.now() - (s.pausedAt ?? Date.now()); s.pausedAt = undefined; s.status = 'recording';
      await setS(s);
      await patchScenario(s.scenarioId, (sc) => { const ses = sc.sessions.find((x) => x.id === s.sessionId); if (ses) { ses.status = 'recording'; const p = ses.pauses.at(-1); if (p) p.resumedAt = iso(); } });
      await inject(s.tabId);
      broadcastSync(s.tabId);
      return { ok: true, session: s };
    }
    case 'ui:stop': {
      if (!s) return { ok: false };
      const fin = (await chrome.tabs.sendMessage(s.tabId, { t: 'finish' }, { frameId: 0 }).catch(() => null)) as FinishReply | null;
      if (s.status === 'paused') {
        await bgStep(s, 'session-end', { dom: { status: 'skipped', reasonCode: 'paused', reason: '一時停止中に終了したため取得していない' }, screenshot: { status: 'skipped', reasonCode: 'paused', reason: '一時停止中に終了したため取得していない' } });
      } else if (fin?.step) {
        const st = await storeStep(s, fin.step, fin.dom);
        await requestShots([{ stepId: st.id, phase: 'session-end' }], s.docEpoch, true).catch(() => {});
      } else {
        const st = await bgStep(s, 'session-end', { dom: { status: 'failed', reasonCode: 'page-unreachable', reason: 'ページに接続できないためDOMを取得できない（ブラウザ内部ページ、またはアクセス権の失効）' } });
        await requestShots([{ stepId: st.id, phase: 'session-end' }], s.docEpoch, true).catch(() => {});
      }
      await endSession(s, 'ended', 'ユーザーが終了');
      return { ok: true, session: null };
    }
    case 'ui:manual-capture': return s ? manualCapture(s, msg.mode) : { ok: false };
    case 'ui:picker': {
      if (!s || s.status !== 'recording') return { ok: false, message: '記録中のみ利用できます。' };
      s.picker = msg.on; s.pickerShot = msg.on ? msg.shot : undefined; await setS(s); broadcastSync(s.tabId);
      return { ok: true, session: s };
    }
  }
}

chrome.runtime.onMessage.addListener((msg: ContentMsg | UiMsg | { t: string }, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string' || msg.t === EVT_CHANGED) return;
  // 再生 (v2): 制御は replay.ts。UI からの指示は拡張ページ由来に限る。ページからは replay:acted と replay:main-click だけを受け付ける。
  if (msg.t === 'replay:acted' || msg.t === 'replay:main-click') { void onReplayPage(msg as ReplayPageMsg, sender).then(sendResponse, () => sendResponse(msg.t === 'replay:acted' ? { proceed: false } : { ok: false, reason: 'Service Worker で例外が発生した' })); return true; }
  if (msg.t.startsWith('ui:replay-')) {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    enqueue(() => onReplayUi(msg as ReplayUiMsg)).then(sendResponse, (e) => sendResponse({ ok: false, message: String(e) }));
    return true;
  }
  // 押下時の画面: 取得の開始を遅らせないよう、記録のキューを通さずに扱う
  if (msg.t === 'press') { void startPress(msg as Extract<ContentMsg, { t: 'press' }>, sender); return; }
  if (msg.t === 'press-change') { const m = msg as Extract<ContentMsg, { t: 'press-change' }>; const e = presses.get(m.pressId); if (e && e.tabId === sender.tab?.id && (e.firstChangeAtMs === null || m.atMs < e.firstChangeAtMs)) e.firstChangeAtMs = m.atMs; return; }
  if (msg.t === 'change' && sender.tab?.id !== undefined) { const m = msg as Extract<ContentMsg, { t: 'change' }>; noteChangeForPresses(sender.tab.id, m.firstAtMs ?? m.atMs); }
  const isUi = msg.t.startsWith('ui:');
  if (isUi && sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return; // UI操作は拡張ページからのみ
  enqueue(async () => {
    if (msg.t === 'ui:start' && (await isReplayActive())) return { ok: false, code: 'replay-active', message: '再生中は記録を開始できません。再生を停止してから開始してください。' } satisfies UiReply;
    return isUi ? onUi(msg as UiMsg) : onContent(msg as ContentMsg, sender);
  }).then(sendResponse, (e) => sendResponse({ ok: false, message: String(e) }));
  return true;
});
initReplay();

// ---- タブの監視（対象タブのみ） ----------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'loading' && info.status !== 'complete') return;
  void enqueue(async () => {
    const s = await getS();
    if (!s || s.tabId !== tabId) return;
    const r = await inject(tabId);
    if (r.ok || info.status !== 'complete') return;
    const key = `${r.code}|${tab.url ?? ''}`;
    if (s.lastNoticeKey === key) return;
    s.lastNoticeKey = key; s.needsPermission = INJECT_GUIDE[r.code]; s.docEpoch++;
    await setS(s);
    await settlePending(s.scenarioId, s.sessionId, 'ページ遷移のため、この操作の画面は取得していない');
    if (s.status === 'recording') {
      await bgStep(s, 'notice', {
        notice: { code: r.code, message: r.code === 'restricted-page' ? '記録できないページへ遷移した。このページ上の操作・DOM・画面は記録されていない' : '別オリジンへの遷移などによりアクセス権が失効した。再許可されるまで、操作・DOM・画面は記録されていない' },
        dom: { status: 'failed', reasonCode: r.code, reason: INJECT_GUIDE[r.code] },
        limitations: [{ code: r.code, message: r.message }],
      });
    }
    notify();
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(async () => {
    const s = await getS();
    if (!s) return;
    if (s.tabId !== tabId && !s.tabStack?.some((t) => t.tabId === tabId) && s.pendingSwitch?.tabId !== tabId) return;
    if (!s.followNewTab && !s.tabStack?.length) { if (s.tabId === tabId) await endSession(s, 'ended', '対象タブが閉じられたため終了'); return; }
    const st = swState(s);
    const alive = new Set<number>();
    for (const t of st.stack) if (await chrome.tabs.get(t.tabId).then(() => true, () => false)) alive.add(t.tabId);
    const dec = decideOnRemoved(st, tabId, alive);
    if (dec.action === 'none') { s.tabStack = dec.state.stack; s.pendingSwitch = dec.state.pending; await setS(s); notify(); return; }
    if (dec.action === 'return') {
      await moveRecording(s, dec.state, '切り替え先のタブが閉じられたため、元のタブへ戻した', 'tab-switch-from', 'tab-switch-back');
      notify();
      return;
    }
    if (!dec.stackWasEmpty && s.status === 'recording') {
      await bgStep(s, 'notice', { notice: { code: 'tab-switch-end', message: '記録対象のタブが閉じられ、戻れる元のタブがないため、記録を終了した' }, dom: { status: 'not-applicable' } });
    }
    await endSession(s, 'ended', dec.stackWasEmpty ? '対象タブが閉じられたため終了' : '対象タブが閉じられ、戻れる元のタブがないため終了');
  });
});

// ---- 新規タブ・別ウィンドウへの記録対象の切り替え（任意設定。同時に記録するタブは常に 1 つ） --------
const swState = (s: ActiveSession): TabSwitchState => ({ current: { tabId: s.tabId, windowId: s.windowId }, stack: s.tabStack ?? [], pending: s.pendingSwitch ?? null });
async function describeTab(tabId: number): Promise<string> {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  return `タブ ${tabId}${t?.title ? `「${t.title}」` : ''}${t?.url ? `（${t.url}）` : ''}`;
}
async function hasHostAccess(url?: string): Promise<boolean> {
  if (await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false)) return true;
  try { if (url && /^https?:/.test(url)) return await chrome.permissions.contains({ origins: [new URL(url).origin + '/*'] }); } catch { /* 無視 */ }
  return false;
}
/** 記録対象を切り替える。前後に通知の手順を残し、docEpoch を上げ、保留中の成果物を確定する。 */
async function moveRecording(s: ActiveSession, next: TabSwitchState, reason: string, codeBefore: string, codeAfter: string): Promise<void> {
  const oldTabId = s.tabId;
  const from = await describeTab(oldTabId), to = await describeTab(next.current.tabId);
  if (s.status === 'recording') await bgStep(s, 'notice', { notice: { code: codeBefore, message: `記録対象を ${from} から ${to} へ切り替える（理由: ${reason}）。この通知までが切り替え前のタブの記録` }, dom: { status: 'not-applicable' } });
  s.tabId = next.current.tabId; s.windowId = next.current.windowId; s.tabStack = next.stack; s.pendingSwitch = next.pending ?? null;
  s.docEpoch++; s.lastUrl = undefined; s.needsPermission = undefined; s.lastNoticeKey = undefined; s.lastShot = undefined; s.changes = []; s.picker = false; s.pickerShot = undefined;
  await setS(s);
  await settlePending(s.scenarioId, s.sessionId, '記録対象タブが切り替わったため、この操作の画面は取得していない');
  if (oldTabId !== s.tabId) broadcastSync(oldTabId); // 切り替え前のタブは、次の hello で記録対象でないと分かり停止する
  await inject(s.tabId);
  broadcastSync(s.tabId);
  if (s.status === 'recording') await bgStep(s, 'notice', { notice: { code: codeAfter, message: `${to} を記録対象にした（切り替え元: ${from}。理由: ${reason}）。同時に記録するタブは 1 つで、切り替え前のタブの操作は記録されない` }, dom: { status: 'not-applicable' } });
}

chrome.tabs.onCreated.addListener((tab) => {
  void enqueue(async () => {
    const s = await getS();
    if (!s || s.status !== 'recording' || tab.openerTabId !== s.tabId) return;
    if (s.followNewTab) {
      const dec = decideOnCreated(swState(s), { enabled: true, recording: true, created: tab, hasAccess: await hasHostAccess(tab.url || tab.pendingUrl) });
      if (dec.action === 'switch') { await moveRecording(s, applySwitch(swState(s), dec.to), '対象タブから新しいタブまたはウィンドウが開かれたため', 'tab-switch-from', 'tab-switch-to'); notify(); return; }
      if (dec.action === 'pending') {
        s.pendingSwitch = dec.to; await setS(s);
        await bgStep(s, 'notice', {
          notice: { code: 'new-tab-needs-permission', message: `記録対象タブから新しいタブまたはウィンドウ（タブ ${dec.to.tabId}）が開かれた。このタブへのアクセス権がないため記録対象を切り替えていない。新しいタブでツールバーの TraceLens アイコンをクリックすると、記録対象をそのタブへ切り替えて続ける` },
          dom: { status: 'not-applicable' },
        });
        notify();
        return;
      }
    }
    await bgStep(s, 'notice', {
      notice: { code: 'new-tab-unsupported', message: '記録対象タブから新しいタブまたはウィンドウが開かれた。新しいタブ側の操作は記録していない（新規タブへの記録継続の設定が無効）' },
      dom: { status: 'not-applicable' },
    });
    notify();
  });
});

// ---- ツールバーアイコン / ショートカット（activeTab の付与契機） ----------------
chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open はユーザー操作の同期的な延長で呼ぶ必要がある
  if (tab.windowId !== undefined) chrome.sidePanel?.open({ windowId: tab.windowId }).catch(() => {});
  void enqueue(async () => {
    const s = await getS();
    if (s && tab.id !== undefined && s.pendingSwitch?.tabId === tab.id && tab.id !== s.tabId) {
      // 新しいタブで activeTab が付与された。記録対象をそのタブへ切り替えて続ける
      const to: TabRef = { tabId: tab.id, windowId: tab.windowId };
      await moveRecording(s, applySwitch(swState(s), to), 'ユーザーが新しいタブでアクセスを許可したため', 'tab-switch-from', 'tab-switch-to');
      notify();
      return;
    }
    if (!s || tab.id !== s.tabId) return;
    const r = await inject(s.tabId);
    if (r.ok) { s.needsPermission = undefined; await setS(s); broadcastSync(s.tabId); }
  });
});
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'capture-screen') return;
  void enqueue(async () => {
    const s = await getS();
    if (!s || !tab || tab.id !== s.tabId) return;
    const regranted = !!s.needsPermission;
    const r = await inject(s.tabId);
    if (!regranted) { await manualCapture(s); return; }
    if (r.ok) { s.needsPermission = undefined; await setS(s); }
    // 再許可の直後は、注入したスクリプトの準備（遷移ステップの記録）を待ってから画面を保存する
    setTimeout(() => void enqueue(async () => { const cur = await getS(); if (cur && cur.sessionId === s.sessionId) await manualCapture(cur); }), 700);
  });
});

// ---- 中断されたセッションの回復（ブラウザ終了・拡張の再読み込み） ---------------
void enqueue(async () => {
  if (await getS()) return;
  for (const sc of await listScenarios()) {
    const open = sc.sessions.filter((x) => x.status === 'recording' || x.status === 'paused');
    if (!open.length) continue;
    for (const ses of open) await settlePending(sc.id, ses.id, '記録が中断されたため取得していない');
    await patchScenario(sc.id, (x) => x.sessions.forEach((ses) => {
      if (ses.status === 'recording' || ses.status === 'paused') { ses.status = 'interrupted'; ses.endedAt = iso(); ses.endReason = 'ブラウザの終了または拡張機能の再読み込みにより中断（それまでの記録は保存済み）'; }
    }));
  }
});
