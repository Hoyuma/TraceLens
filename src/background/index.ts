// TraceLens Service Worker
// - 記録セッションの状態は chrome.storage.session、記録本体は IndexedDB に置き、
//   Service Worker が停止・再起動しても保存済みの記録を失わない
// - 収集対象は、ユーザーが記録を開始した1つのタブだけ
import { SCHEMA_VERSION, emptyAnnotation, newId, type Artifact, type ArtifactPhase, type EnvironmentInfo, type ScreenshotMeta, type Step, type StepKind } from '../shared/types';
import { addStep, getScenario, getStep, listScenarios, listSteps, patchScenario, patchStep, putArtifact } from '../shared/db';
import { EVT_CHANGED, STATE_KEY, type ActiveSession, type ContentMsg, type DomFailure, type DomPayload, type FinishReply, type HelloReply, type ShotMetaReply, type StepDraft, type UiMsg, type UiReply } from '../shared/messages';

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
const NO_SHOT: StepKind[] = ['notice'];
async function storeDom(step: Step, dom: DomPayload | DomFailure | undefined): Promise<void> {
  if (!dom) return;
  if ('failed' in dom) { step.dom = { status: 'failed', reasonCode: 'serialize-error', reason: dom.reason }; return; }
  const a: Artifact = { id: `dom_${step.id}`, scenarioId: step.scenarioId, stepId: step.id, type: 'dom', capturedAt: dom.capturedAt, phase: dom.phase, includeInExport: true, html: dom.html, formState: dom.formState, truncated: dom.truncated, frameUrl: dom.frameUrl };
  await putArtifact(a);
  step.dom = { status: 'captured', artifactId: a.id };
  if (dom.truncated) step.limitations.push({ code: 'dom-truncated', message: 'DOMがサイズ上限を超えたため、後半を省略して保存した' });
}
async function storeStep(s: ActiveSession, draft: StepDraft, dom?: DomPayload | DomFailure, over: Partial<Step> = {}): Promise<Step> {
  const step: Step = {
    schemaVersion: SCHEMA_VERSION, id: draft.id, scenarioId: s.scenarioId, sessionId: s.sessionId, seq: s.nextSeq++,
    kind: draft.kind, operationAt: draft.operationAt, operationEndAt: draft.operationEndAt, page: draft.page, frame: draft.frame,
    target: draft.target, value: draft.value, key: draft.key, navigation: draft.navigation,
    observations: [], screenshot: NO_SHOT.includes(draft.kind) ? { status: 'not-applicable' } : { status: 'pending' },
    dom: { status: 'pending' }, elementCapture: draft.elementCapture, limitations: draft.limitations ?? [],
    annotation: draft.annotation ?? emptyAnnotation(), includeInExport: true, ...over,
  };
  await setS(s);
  await storeDom(step, dom);
  await addStep(step);
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
    if (st.screenshot.status !== 'pending' && st.dom.status !== 'pending') continue;
    await patchStep(st.id, (x) => {
      if (x.screenshot.status === 'pending') x.screenshot = { status: 'skipped', reasonCode: 'not-captured', reason };
      if (x.dom.status === 'pending') x.dom = { status: 'failed', reasonCode: 'not-captured', reason: reason.replace('画面', 'DOM') };
    });
  }
}

// ---- 画面取得 ---------------------------------------------------------------
let lastCaptureAt = 0;
let capChain: Promise<unknown> = Promise.resolve();
type Shot = { stepId: string; phase: ArtifactPhase };
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
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const s = await getS();
  if (!s) return failShots(shots, 'not-recording', '記録が終了していたため画面を取得していない');
  if (s.status !== 'recording' && !final) return failShots(shots, 'paused', '一時停止中のため画面を取得していない');
  if (s.docEpoch !== epoch) return failShots(shots, 'page-changed', '取得前にページが切り替わったため、この操作の画面は取得していない');
  const tab = await chrome.tabs.get(s.tabId).catch(() => null);
  if (!tab) return failShots(shots, 'tab-gone', '対象タブが閉じられていたため画面を取得できない');
  if (!tab.active) return failShots(shots, 'tab-inactive', '対象タブが前面に表示されていなかったため取得していない（他のタブの画像を混在させないため）');
  const metas = new Map<string, ScreenshotMeta>();
  for (const sh of shots) metas.set(sh.stepId, { ...(await getMeta(s.tabId, sh.stepId)), ...(timingNote ? { timingNote } : {}) });
  lastCaptureAt = Date.now();
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    const m = String((e as Error)?.message || e);
    const perm = /permission|activeTab|all_urls/i.test(m);
    return failShots(shots, perm ? 'no-permission' : 'capture-error', perm ? `画面取得の権限がない（対象タブでツールバーの TraceLens アイコンをクリックすると再許可される）: ${m}` : `画面取得に失敗: ${m}`);
  }
  const capturedAt = iso();
  const tab2 = await chrome.tabs.get(s.tabId).catch(() => null);
  const s2 = await getS();
  if (!tab2 || !tab2.active || (tab.url && tab2.url !== tab.url) || !s2 || s2.docEpoch !== epoch)
    return failShots(shots, 'changed-during-capture', '取得中にタブまたはページが切り替わったため、画像を破棄した');
  const blob = await (await fetch(dataUrl)).blob();
  for (const sh of shots) {
    const a: Artifact = { id: `shot_${sh.stepId}`, scenarioId: s.scenarioId, stepId: sh.stepId, type: 'screenshot', capturedAt, phase: sh.phase, includeInExport: true, blob, meta: metas.get(sh.stepId), masks: [] };
    await putArtifact(a);
    await patchStep(sh.stepId, (x) => { x.screenshot = { status: 'captured', artifactId: a.id }; });
  }
  notify();
}

// ---- コンテンツスクリプトからのメッセージ ------------------------------------
async function onContent(msg: ContentMsg, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const s = await getS();
  const tabId = sender.tab?.id;
  const mine = !!s && tabId === s.tabId;
  switch (msg.t) {
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
      return { recording: true, paused: s.status === 'paused', picker: s.picker, announce, fromUrl } satisfies HelloReply;
    }
    case 'step': {
      if (!s || !mine || s.status !== 'recording') return { ok: false };
      const d = msg.step;
      d.frame.browserFrameId = sender.frameId;
      if (!d.frame.isTop && sender.tab?.url) d.page = { ...d.page, url: sender.tab.url, title: sender.tab.title ?? d.page.title };
      if (d.kind === 'spa-navigation' && d.navigation) s.lastUrl = d.navigation.toUrl;
      await storeStep(s, d, msg.dom, d.kind === 'session-start' || d.kind === 'navigation' || d.kind === 'reload' ? {} : msg.dom ? {} : { dom: { status: 'failed', reasonCode: 'no-dom', reason: 'DOMが送信されなかった' } });
      notify();
      return { ok: true };
    }
    case 'patch': {
      const last = (await chrome.storage.session.get(LAST_ENDED_KEY))[LAST_ENDED_KEY] as { tabId: number; sessionId: string } | undefined;
      const st = await getStep(msg.stepId);
      if (!st) return { ok: false };
      const ok = (mine && st.sessionId === s!.sessionId) || (!!last && last.tabId === tabId && last.sessionId === st.sessionId);
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
      if (!s || !mine || s.status !== 'recording') { await failShots(msg.shots, 'not-recording', '記録中ではないため画面を取得していない'); return { ok: false }; }
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

async function manualCapture(s: ActiveSession): Promise<UiReply> {
  if (s.status !== 'recording') return { ok: false, code: 'paused', message: '一時停止中は画面を保存できません。再開してください。' };
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
      const ns: ActiveSession = { scenarioId: sc.id, sessionId: newId('ses'), tabId: tab.id, windowId: tab.windowId, status: 'recording', startedAt: Date.now(), pausedAccumMs: 0, lastUrl: tab.url, awaitingStart: true, picker: false, nextSeq: (steps.at(-1)?.seq ?? 0) + 1, docEpoch: 0 };
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
    case 'ui:manual-capture': return s ? manualCapture(s) : { ok: false };
    case 'ui:picker': {
      if (!s || s.status !== 'recording') return { ok: false, message: '記録中のみ利用できます。' };
      s.picker = msg.on; await setS(s); broadcastSync(s.tabId);
      return { ok: true, session: s };
    }
  }
}

chrome.runtime.onMessage.addListener((msg: ContentMsg | UiMsg | { t: string }, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string' || msg.t === EVT_CHANGED) return;
  const isUi = msg.t.startsWith('ui:');
  if (isUi && sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return; // UI操作は拡張ページからのみ
  enqueue(() => (isUi ? onUi(msg as UiMsg) : onContent(msg as ContentMsg, sender))).then(sendResponse, (e) => sendResponse({ ok: false, message: String(e) }));
  return true;
});

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
    if (!s || s.tabId !== tabId) return;
    await endSession(s, 'ended', '対象タブが閉じられたため終了');
  });
});
chrome.tabs.onCreated.addListener((tab) => {
  void enqueue(async () => {
    const s = await getS();
    if (!s || s.status !== 'recording' || tab.openerTabId !== s.tabId) return;
    await bgStep(s, 'notice', {
      notice: { code: 'new-tab-unsupported', message: '記録対象タブから新しいタブまたはウィンドウが開かれた。新しいタブ側の操作は記録していない（初期版は未対応）' },
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
