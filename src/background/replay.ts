// 再生の制御（Service Worker）
// - 状態は chrome.storage.session の REPLAY_STATE_KEY（ActiveReplay）。SW が停止しても続きから再開する。
//   secret の変数の値だけは SW のメモリに持ち、失われたら secret-required で一時停止する。
// - 結果は IndexedDB の ReplayRun（手順ごとの ReplayStepResult）。ok は「操作を実行し待機条件を観測できた」であり、業務処理の完了ではない。
// - 記録セッションと同時に動かさない。必須権限は増やさない（tabs / webNavigation / debugger は使わない）。
// - ページ内の操作は replay.js（対象タブの各フレームに都度注入。マニフェストに登録しない）。
// - 判断の部分（注入エラーの分類、再開時に操作するか、停止の確定、応答の扱い、同一文書内の移動）は replayLogic.ts。
import { SCHEMA_VERSION, newId, type FrameHop, type WaitCondition } from '../shared/types';
import { getScenario, listReplayRuns, listScenarios, listSteps, patchReplayRun, putReplayRun } from '../shared/db';
import {
  RELOAD_AS_GET_NOTE, buildReplayPlan, initialResults, planVariableNames, preflight, recordVariableValues, resolveAction,
  type ActedState, type ReplayAction, type ReplayRun, type ReplayRunStatus, type ReplayStepResult, type ResolvedReplayAction, type WaitOutcome,
} from '../shared/replay';
import {
  EVT_CHANGED, REPLAY_STATE_KEY, STATE_KEY,
  type ActiveReplay, type ActiveReplayWait, type ReplayActedReply, type ReplayPageMsg, type ReplayRunReply, type ReplayUiMsg, type ReplayUiReply, type ToReplayAuxMsg, type ToReplayMsg,
} from '../shared/messages';
import { KIND_LABEL } from '../shared/types';
import { matchFrame, type FrameCandidate } from './replayFrames';
import { classifyInjectError, decideRunReply, isSameDocumentNavigation, missingOrigin, originOf, reloadTarget, stepEntryMode, stopMode, stoppedStepResult } from './replayLogic';

const iso = (ms: number = Date.now()) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** ページから応答がない場合（ダイアログで止まっているなど）に、上限時間に足す猶予 */
const REPLY_GRACE_MS = 3000;
const LOAD_TIMEOUT_MIN_MS = 15_000;
/**
 * 待機条件だけの観測（replay:wait）を 1 回で待つ上限。上限時間が長い手順でも、1 つの要求が長く続かないよう区切って問い合わせ直す
 * （拡張の SW は 1 つの要求が 5 分を超えると停止されうる。developer.chrome.com の Service Worker のライフサイクル、2026-11-17 確認）
 */
const WAIT_CHUNK_MS = 60_000;
/** 手順の実行中に拡張 API を定期的に呼び、アイドルでの停止を避ける（Chrome 110 以降、拡張 API の呼び出しでアイドルのタイマーが戻る） */
const KEEPALIVE_MS = 20_000;
/** # だけが違う URL への移動で、URL の変化を待つ上限 */
const SAME_DOC_SETTLE_MS = 2_000;
/** 現在の URL が読めず、移動先に # がある場合: 読み込みの開始を観測できなくても、この時間の後に読み込み済みとみなす */
const UNKNOWN_DOC_FALLBACK_MS = 3_000;

// ---- 状態 -------------------------------------------------------------------
let cache: ActiveReplay | null | undefined;
async function getR(): Promise<ActiveReplay | null> {
  if (cache === undefined) cache = ((await chrome.storage.session.get(REPLAY_STATE_KEY))[REPLAY_STATE_KEY] as ActiveReplay | undefined) ?? null;
  return cache;
}
async function setR(r: ActiveReplay | null): Promise<void> {
  cache = r;
  if (r) await chrome.storage.session.set({ [REPLAY_STATE_KEY]: r }); else await chrome.storage.session.remove(REPLAY_STATE_KEY);
}
let lock: Promise<unknown> = Promise.resolve();
/** 状態の読み書きを直列化する（実行中の手順を待たない短い処理だけをここで行う） */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = lock.then(fn, fn);
  lock = p.catch((e) => console.warn('[TraceLens replay]', e));
  return p;
}
/** secret の変数の値（runId → 値）。SW のメモリのみ。 */
const secretMem = new Map<string, Record<string, string>>();
let driving = false;

function notify() { chrome.runtime.sendMessage({ t: EVT_CHANGED }).catch(() => {}); }

export async function isReplayActive(): Promise<boolean> { return !!(await getR()); }

// ---- 停止の伝達 ----------------------------------------------------------------
/** 停止の要求で実行中の手順を打ち切るための例外（drive が受けて、実行中の手順を「停止時に実行中」として確定する） */
class StopSignal extends Error { constructor() { super('replay stopped'); } }
interface ExecCtx { signal: AbortSignal; /** 移動（tabs.update）を発行した */ navIssued: boolean }
/** 実行中の手順（drive の中だけで設定する） */
let currentExec: { runId: string; ctl: AbortController } | null = null;

function check(ctx: ExecCtx) { if (ctx.signal.aborted) throw new StopSignal(); }
function race<T>(p: Promise<T>, ctx: ExecCtx): Promise<T> {
  if (ctx.signal.aborted) return Promise.reject(new StopSignal());
  return new Promise<T>((res, rej) => {
    const on = () => rej(new StopSignal());
    ctx.signal.addEventListener('abort', on, { once: true });
    p.then((v) => { ctx.signal.removeEventListener('abort', on); res(v); }, (e) => { ctx.signal.removeEventListener('abort', on); rej(e); });
  });
}
const nap = (ms: number, ctx: ExecCtx) => race(sleep(ms), ctx);

// ---- 注入とページ呼び出し -----------------------------------------------------
type Ready = { ok: true } | { ok: false; code: 'permission' | 'restricted' | 'tab-gone' | 'timeout'; message: string; /** permission: 注入できなかったページの URL（分かる場合） */ url?: string };

async function ensureReady(tabId: number, deadline: number, ctx: ExecCtx): Promise<Ready> {
  let last = '';
  for (;;) {
    check(ctx);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, code: 'tab-gone', message: '対象タブが閉じられた' };
    if (tab.status !== 'loading') {
      try {
        await race(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['replay.js'], injectImmediately: true }), ctx);
        return { ok: true };
      } catch (e) {
        if (e instanceof StopSignal) throw e;
        last = String((e as Error)?.message || e);
        const c = classifyInjectError(last);
        if (c.code === 'restricted') return { ok: false, code: 'restricted', message: `再生スクリプトを注入できないページ（ブラウザ内部ページなど）: ${last}` };
        if (c.code === 'permission') {
          const url = c.url ?? tab.url ?? tab.pendingUrl;
          const o = originOf(url);
          // アクセス権はあるのに注入できない（PDF の表示など）場合は、許可しても解決しない
          if (o && (await chrome.permissions.contains({ origins: [`${o}/*`] }).catch(() => false))) return { ok: false, code: 'restricted', message: `アクセス権はあるが再生スクリプトを注入できないページ（PDF の表示など）: ${last}` };
          return { ok: false, code: 'permission', message: last, url };
        }
      }
    }
    if (Date.now() >= deadline) return { ok: false, code: 'timeout', message: last ? `再生スクリプトを注入できなかった: ${last}` : 'ページの読み込みが上限時間内に終わらなかった' };
    await nap(150, ctx);
  }
}

async function resolveFrame(tabId: number, path: FrameHop[], ctx: ExecCtx): Promise<{ frameId: number } | { error: string }> {
  if (!path.length) return { frameId: 0 };
  try {
    const res = await race(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => (window as any).__tracelensReplay?.describe?.() ?? null }), ctx);
    const frames: FrameCandidate[] = res.filter((r) => r.result).map((r) => ({ frameId: r.frameId, ...(r.result as { path: FrameCandidate['path']; url: string }) }));
    return matchFrame(frames, path);
  } catch (e) {
    if (e instanceof StopSignal) throw e;
    return { error: `フレームの情報を取得できなかった: ${String((e as Error)?.message || e)}` };
  }
}

/** 応答がない場合に打ち切る */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
}

async function overlay(tabId: number, text: string | null) {
  await chrome.tabs.sendMessage(tabId, { t: 'replay:overlay', text } satisfies ToReplayAuxMsg, { frameId: 0 }).catch(() => {});
}
/** 再生中の表示。再生が終了・差し替え・停止中なら出さず、出した直後に終わっていたら消す */
async function showOverlay(r: ActiveReplay, text: string, ctx: ExecCtx) {
  const live = async () => { const cur = await getR(); return !ctx.signal.aborted && !!cur && cur.runId === r.runId && cur.status !== 'stopping'; };
  if (!(await live())) return;
  await overlay(r.tabId, text);
  if (!(await live())) await overlay(r.tabId, null);
}

// ---- 1 手順の実行 -----------------------------------------------------------
type Outcome =
  | { kind: 'done'; result: ReplayStepResult }               // 結果を記録して onFail / 進行の判定へ
  /** 位置を進めずに一時停止。keepMark: actedResume を残す（再開時に操作せず待機の観測から続ける） */
  | { kind: 'pause'; wait: ActiveReplayWait; result?: ReplayStepResult; keepMark?: boolean }
  | { kind: 'interrupt'; reason: string }
  | { kind: 'stale' };                                        // 実行中に再生が終了・差し替えられた

const failed = (stepId: string, startedAt: string, reason: string, extra: Partial<ReplayStepResult> = {}): Outcome =>
  ({ kind: 'done', result: { stepId, status: 'failed', reason, startedAt, endedAt: iso(), ...extra } });

function permissionPause(rd: Extract<Ready, { ok: false }>, stepId: string, expectedUrl?: string): Outcome {
  const o = missingOrigin(rd.url);
  const expected = originOf(expectedUrl);
  const where = 'origin' in o ? o.origin : `このページ（URL を読めないためオリジンを特定できない${expected ? `。想定されるオリジン: ${expected}` : ''}）`;
  return { kind: 'pause', wait: { code: 'permission', stepId, ...o, message: `${where} へのアクセス権がないため、再生スクリプトを注入できない。アクセスを許可してから再開してください（詳細: ${rd.message}）` } };
}

function readyFailure(rd: Extract<Ready, { ok: false }>, startedAt: string, stepId: string, expectedUrl?: string, extra: Partial<ReplayStepResult> = {}): Outcome {
  if (rd.code === 'tab-gone') return { kind: 'interrupt', reason: '対象タブが閉じられた' };
  if (rd.code === 'permission') return permissionPause(rd, stepId, expectedUrl);
  return failed(stepId, startedAt, rd.message, extra);
}

async function currentEpoch(): Promise<number> { return (await getR())?.docEpoch ?? -1; }

/**
 * 読み込みの完了を待つ（epoch0 より後に読み込みが始まり、完了したこと）。
 * fallbackMs: 読み込みの開始を観測できなくても、この時間の後にタブが complete なら読み込み済みとみなす（同一文書内の移動の可能性がある場合）
 */
async function waitNavigated(tabId: number, epoch0: number, deadline: number, ctx: ExecCtx, fallbackMs?: number): Promise<{ ok: true; assumed?: boolean } | { ok: false; reason: string; gone?: boolean }> {
  const t0 = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, reason: '対象タブが閉じられた', gone: true };
    if ((await currentEpoch()) > epoch0 && tab.status === 'complete') return { ok: true };
    if (fallbackMs !== undefined && Date.now() - t0 >= fallbackMs && (await currentEpoch()) === epoch0 && tab.status === 'complete') return { ok: true, assumed: true };
    if (Date.now() >= deadline) return { ok: false, reason: 'ページの読み込みの完了を上限時間内に観測できなかった' };
    await nap(100, ctx);
  }
}

/** 待機条件だけをページで観測する（文書が切り替わったら新しい文書で観測し直す。長い待機は区切って問い合わせ直す） */
async function pageWait(r: ActiveReplay, cond: WaitCondition, frame: FrameHop[], deadline: number, ctx: ExecCtx): Promise<{ wo: WaitOutcome } | { ready: Extract<Ready, { ok: false }> } | { error: string }> {
  if (cond.kind === 'none') return { wo: { kind: 'none', status: 'not-applicable' } };
  const path = cond.kind === 'url-matches' ? [] : frame;
  for (;;) {
    const ready = await ensureReady(r.tabId, deadline, ctx);
    if (!ready.ok) return { ready };
    const f = await resolveFrame(r.tabId, path, ctx);
    if ('error' in f) { if (Date.now() >= deadline) return { error: f.error }; await nap(200, ctx); continue; }
    const epoch = await currentEpoch();
    const remaining = Math.max(deadline - Date.now(), 500);
    // dom-quiet は「上限まで静止しなかった」も結果として使うため区切らない
    const chunk = cond.kind === 'dom-quiet' ? remaining : Math.min(remaining, WAIT_CHUNK_MS);
    const reply = await race(withTimeout(chrome.tabs.sendMessage(r.tabId, { t: 'replay:wait', runId: r.runId, wait: cond, timeoutMs: chunk } satisfies ToReplayAuxMsg, { frameId: f.frameId }).catch(() => null) as Promise<ReplayRunReply | null>, chunk + REPLY_GRACE_MS), ctx);
    if (reply === 'timeout') return { error: 'ページから応答がない（ダイアログの表示中などでページのスクリプトが止まっている可能性がある）' };
    // 応答の途中で文書が切り替わった場合、古い文書での観測結果は使わない
    if (reply && reply.waitOutcome && (await currentEpoch()) === epoch) {
      if (reply.waitOutcome.status === 'timeout' && cond.kind !== 'dom-quiet' && Date.now() < deadline - 100) continue; // 区切りの時間切れ。上限まで問い合わせ直す
      return { wo: reply.waitOutcome };
    }
    if (Date.now() >= deadline) return { wo: { kind: cond.kind, status: 'timeout', at: iso(), detail: 'ページの切り替わりが続き、上限時間内に条件を観測できなかった' } };
    await nap(100, ctx);
  }
}

function resultFromWait(stepId: string, startedAt: string, wo: WaitOutcome, extra: Partial<ReplayStepResult> = {}): ReplayStepResult {
  const ok = wo.status === 'observed' || wo.status === 'not-applicable' || (wo.status === 'timeout' && wo.kind === 'dom-quiet');
  return { stepId, status: ok ? 'ok' : 'failed', startedAt, endedAt: iso(), waitOutcome: wo, ...(ok ? {} : { reason: wo.status === 'failed' ? `待機条件を評価できない: ${wo.detail ?? ''}` : `待機条件（${wo.kind}）を上限時間内に観測できなかった` }), ...extra };
}

const joinDetail = (...xs: (string | undefined)[]) => xs.filter(Boolean).join('。') || undefined;

/** 操作済みの手順について、待機条件だけを観測する（操作はしない） */
async function observeAfterAct(r: ActiveReplay, a: ReplayAction, action: ResolvedReplayAction, startedAt: string, deadline: number, extra: Partial<ReplayStepResult>, ctx: ExecCtx): Promise<Outcome> {
  const t0 = Date.now();
  while ((await chrome.tabs.get(r.tabId).catch(() => null))?.status === 'loading' && Date.now() - t0 < LOAD_TIMEOUT_MIN_MS) await nap(100, ctx);
  const w = await pageWait(r, action.wait, action.frame, Math.max(deadline, Date.now() + 1500), ctx);
  if ('ready' in w) {
    if (w.ready.code === 'permission') {
      const o = missingOrigin(w.ready.url);
      const where = 'origin' in o ? `遷移したページ（${o.origin}）` : '遷移したページ（URL を読めないためオリジンを特定できない）';
      return {
        kind: 'pause', keepMark: true,
        wait: { code: 'permission', stepId: a.stepId, actedResume: true, ...o, message: `操作の後に${where}へのアクセス権がないため、待機条件を観測できない。アクセスを許可してから再開すると、操作はせず、この手順の待機条件の観測から続ける（操作は実行済み）。詳細: ${w.ready.message}` },
        result: { stepId: a.stepId, status: 'failed', reason: '遷移後のページへのアクセス権がなく、待機条件を観測できなかった（操作は実行済み）', startedAt, endedAt: iso(), ...extra },
      };
    }
    return readyFailure(w.ready, startedAt, a.stepId, undefined, extra);
  }
  if ('error' in w) return failed(a.stepId, startedAt, w.error, extra);
  return { kind: 'done', result: resultFromWait(a.stepId, startedAt, w.wo, extra) };
}

async function execStep(r: ActiveReplay, a: ReplayAction, ctx: ExecCtx): Promise<Outcome> {
  const startedAt = iso();
  const deadline = Date.now() + a.timeoutMs;
  if (a.kind === 'unsupported') return { kind: 'done', result: { stepId: a.stepId, status: 'skipped', reason: a.unsupportedReason ?? '再生に対応していない種別', startedAt, endedAt: startedAt } };
  if (a.kind === 'manual') {
    const reason = a.manualReason ?? '人が操作して続行する';
    return { kind: 'pause', wait: { code: 'manual-step', stepId: a.stepId, message: reason }, result: { stepId: a.stepId, status: 'manual', reason, startedAt } };
  }
  const values = { ...r.variableValues, ...(secretMem.get(r.runId) ?? {}) };
  const res = resolveAction(a, values);
  if (!res.ok) {
    const secrets = res.missing.filter((n) => r.secretVariableNames.includes(n));
    if (secrets.length) return { kind: 'pause', wait: { code: 'secret-required', names: secrets, message: `機密の変数（${secrets.join(', ')}）の値がない（Service Worker の再起動で失われた可能性がある）。値を入力して再開してください` } };
    return failed(a.stepId, startedAt, `変数の値がない: ${res.missing.join(', ')}`, { acted: 'no' });
  }
  const action = res.action;
  const tab = await chrome.tabs.get(r.tabId).catch(() => null);
  if (!tab) return { kind: 'interrupt', reason: '対象タブが閉じられた' };
  const progress = `手順 ${a.index + 1} / ${r.plan.length}（${KIND_LABEL[a.stepKind]}）`;

  // ---- 移動 ----
  if (action.kind === 'navigate') {
    const epoch0 = await currentEpoch();
    const loadDeadline = Date.now() + Math.max(a.timeoutMs, LOAD_TIMEOUT_MIN_MS);
    let detail: string | undefined;
    let target = action.url;
    if (r.openedTab && a.index === 0) {
      // SW がこの URL で開いたタブ。もう一度読み込まず、読み込みの完了だけを待つ
      ctx.navIssued = true;
      for (;;) {
        const t = await chrome.tabs.get(r.tabId).catch(() => null);
        if (!t) return { kind: 'interrupt', reason: '対象タブが閉じられた' };
        if (t.status === 'complete') break;
        if (Date.now() >= loadDeadline) return failed(a.stepId, startedAt, 'ページの読み込みの完了を上限時間内に観測できなかった', { acted: 'yes' });
        await nap(100, ctx);
      }
    } else {
      if (action.reload) {
        // 記録した再読み込みは、フォームの再送信（重複登録）を避けるため、現在の URL へ GET で移動し直す
        const rt = reloadTarget(tab.url, action.url);
        if (!rt) return failed(a.stepId, startedAt, '再読み込みの移動先の URL が分からない（現在の URL を読めず、記録時の URL もない）', { acted: 'no' });
        target = rt.url;
        detail = joinDetail(RELOAD_AS_GET_NOTE, rt.usedRecorded ? '現在の URL を読めないため、記録時の URL へ移動した' : undefined);
      }
      if (!target) return failed(a.stepId, startedAt, '移動先の URL がない', { acted: 'no' });
      const same = action.reload ? false : isSameDocumentNavigation(tab.url, target);
      check(ctx);
      try {
        await chrome.tabs.update(r.tabId, { url: target });
        ctx.navIssued = true;
      } catch (e) {
        return failed(a.stepId, startedAt, `移動できなかった: ${String((e as Error)?.message || e)}`, { acted: 'no', detail });
      }
      if (same === true) {
        // # だけが違う: 文書は読み込まれず、tabs.onUpdated の loading が来ないことがある。URL の変化を待つ
        const t0 = Date.now();
        for (;;) {
          const t = await chrome.tabs.get(r.tabId).catch(() => null);
          if (!t) return { kind: 'interrupt', reason: '対象タブが閉じられた' };
          if ((t.url === target && t.status === 'complete') || Date.now() - t0 >= SAME_DOC_SETTLE_MS) break;
          await nap(100, ctx);
        }
        detail = joinDetail(detail, '同一文書内の移動（# 以降だけが違う）のため、読み込みの完了ではなく URL の変化を待った');
      } else {
        const nav = await waitNavigated(r.tabId, epoch0, loadDeadline, ctx, same === 'unknown' ? UNKNOWN_DOC_FALLBACK_MS : undefined);
        if (!nav.ok) return nav.gone ? { kind: 'interrupt', reason: nav.reason } : failed(a.stepId, startedAt, nav.reason, { acted: 'yes', detail });
        if (nav.assumed) detail = joinDetail(detail, '読み込みの開始を観測できなかった（# だけが違う同一文書内の移動の可能性がある）ため、読み込み済みとみなして待機条件を観測した');
      }
    }
    const w = await pageWait(r, action.wait, [], Math.max(deadline, Date.now() + 1000), ctx);
    if ('ready' in w) return readyFailure(w.ready, startedAt, a.stepId, target, { acted: 'yes', detail });
    if ('error' in w) return failed(a.stepId, startedAt, w.error, { acted: 'yes', detail });
    await showOverlay(r, progress, ctx);
    return { kind: 'done', result: resultFromWait(a.stepId, startedAt, w.wo, { acted: 'yes', ...(detail ? { detail } : {}) }) };
  }

  // ---- 待機だけの手順 ----
  if (action.kind === 'wait') {
    const w = await pageWait(r, action.wait, action.frame, deadline, ctx);
    if ('ready' in w) return readyFailure(w.ready, startedAt, a.stepId, action.frameUrl, { acted: 'no' });
    if ('error' in w) return failed(a.stepId, startedAt, w.error, { acted: 'no' });
    return { kind: 'done', result: resultFromWait(a.stepId, startedAt, w.wo) };
  }

  // ---- 操作 ----
  if (stepEntryMode(r, a) === 'observe-only') {
    // 一時停止（遷移後の権限待ち）・SW の再起動の前に操作済み。操作はせず、待機条件の観測だけを行う
    const m = r.actedResume!;
    await showOverlay(r, progress, ctx).catch(() => {});
    return observeAfterAct(r, a, action, startedAt, deadline, {
      acted: 'yes', selectorUsed: m.selectorUsed, matchCount: m.matchCount,
      detail: 'この手順の操作は一時停止（または Service Worker の再起動）の前に実行済み。再開後は操作せず、待機条件だけを観測した',
    }, ctx);
  }
  let lastReason: string | undefined;
  for (;;) {
    const ready = await ensureReady(r.tabId, deadline, ctx);
    if (!ready.ok) return readyFailure(ready, startedAt, a.stepId, action.frameUrl, { acted: 'no' });
    await showOverlay(r, progress, ctx);
    const f = await resolveFrame(r.tabId, action.frame, ctx);
    if ('error' in f) {
      if (Date.now() < deadline) { await nap(200, ctx); continue; }
      return failed(a.stepId, startedAt, f.error, { acted: 'no' });
    }
    check(ctx);
    const attemptId = newId('att');
    const ok = await withLock(async () => {
      const cur = await getR();
      if (!cur || cur.runId !== r.runId || cur.status === 'stopping') return false;
      cur.inFlight = { position: a.index, stepId: a.stepId, attemptId, acted: false };
      await setR(cur);
      return true;
    });
    if (!ok) { check(ctx); return { kind: 'stale' }; }
    const epoch = await currentEpoch();
    const remaining = Math.max(deadline - Date.now(), 1000);
    const msg: ToReplayMsg = { t: 'replay:run', runId: r.runId, attemptId, action: { ...action, timeoutMs: remaining } };
    let failedSend = false;
    const reply = await race(withTimeout((chrome.tabs.sendMessage(r.tabId, msg, { frameId: f.frameId }) as Promise<ReplayRunReply | undefined>).catch(() => { failedSend = true; return undefined; }), remaining + REPLY_GRACE_MS + 1500), ctx);
    // 試行を締める: 以後、この試行についてのページからの replay:acted は受け付けない（操作したかを確定させる）
    const dec = await withLock(async () => {
      const cur = await getR();
      if (!cur || cur.runId !== r.runId) return null;
      const acted = cur.inFlight?.attemptId === attemptId && cur.inFlight.acted;
      const d = decideRunReply({ reply, acted, docChanged: cur.docEpoch !== epoch, failedSend, pastDeadline: Date.now() >= deadline, lastReason });
      cur.inFlight = undefined;
      // 操作の後に観測し直す場合は、印を残してから観測する（この間に SW が再起動しても、再開時に操作し直さない）
      if (d.kind === 'observe-after-act') cur.actedResume = { position: a.index, stepId: a.stepId, attemptId, acted: true, startedAt, selectorUsed: reply !== 'timeout' ? reply?.selectorUsed : undefined, matchCount: reply !== 'timeout' ? reply?.matchCount : undefined };
      await setR(cur);
      return d;
    });
    if (!dec) return { kind: 'stale' };
    const rep = reply !== 'timeout' ? reply : undefined;
    switch (dec.kind) {
      case 'fail': return failed(a.stepId, startedAt, dec.reason, { acted: dec.acted });
      case 'use-reply':
        return { kind: 'done', result: { stepId: a.stepId, status: rep!.status, reason: rep!.reason, selectorUsed: rep!.selectorUsed, matchCount: rep!.matchCount, waitOutcome: rep!.waitOutcome, startedAt, endedAt: rep!.status === 'manual' ? undefined : iso(), acted: dec.acted } };
      case 'manual': return { kind: 'done', result: { stepId: a.stepId, status: 'manual', reason: rep?.reason, startedAt } };
      case 'observe-after-act':
        // 操作の後に文書が切り替わった（ページ遷移）。古い文書での観測結果は使わず、新しい文書で待機条件を観測する
        return observeAfterAct(r, a, action, startedAt, deadline, {
          acted: dec.acted, selectorUsed: rep?.selectorUsed, matchCount: rep?.matchCount,
          detail: dec.acted === 'yes' ? '操作の後に文書が切り替わった（ページ遷移）ため、待機条件は切り替わった後のページで観測した' : '操作の結果を受け取れなかった（操作は実行された可能性がある）ため、操作し直さず待機条件だけを観測した',
        }, ctx);
      case 'retry':
        // 操作する前に接続が切れた（読み込み中・スクリプト未準備）。上限時間まで再試行する
        lastReason = dec.lastReason;
        await nap(200, ctx);
    }
  }
}

// ---- 進行 -------------------------------------------------------------------
async function setRunStatus(runId: string, status: ReplayRunStatus) {
  await patchReplayRun(runId, (run) => { run.status = status; });
}
async function putResult(runId: string, index: number, result: ReplayStepResult) {
  await patchReplayRun(runId, (run) => { run.results[index] = result; });
}

async function finish(r: ActiveReplay, status: ReplayRunStatus, reason?: string) {
  await patchReplayRun(r.runId, (run) => { run.status = status; run.endedAt = iso(); if (reason) run.reason = reason; else delete run.reason; });
  secretMem.delete(r.runId);
  const cur = await getR();
  if (cur && cur.runId === r.runId) await setR(null);
  await overlay(r.tabId, null);
  notify();
}

/** 停止時の確定: 失敗で一時停止していた場合は failed、それ以外は stopped */
function stopStatus(r: ActiveReplay): { status: ReplayRunStatus; reason: string } {
  if (r.waitReason?.code === 'failed-step') return { status: 'failed', reason: `手順の失敗で停止した: ${r.waitReason.message}` };
  return { status: 'stopped', reason: '人が停止した' };
}

/** 停止時に実行中だった手順を確定する（ロックの中で呼ぶ）。navIssued: その手順で移動を発行した */
async function settleStoppedStep(cur: ActiveReplay, a: ReplayAction, startedAt: string, navIssued: boolean) {
  const m = cur.actedResume;
  const acted: ActedState = m && m.stepId === a.stepId && m.position === a.index ? 'yes'
    : cur.inFlight && cur.inFlight.stepId === a.stepId && cur.inFlight.acted ? 'possibly'
    : navIssued ? 'yes' : 'no';
  await putResult(cur.runId, a.index, stoppedStepResult(a.stepId, startedAt, acted, iso()));
  cur.inFlight = undefined; cur.actedResume = undefined;
  await setR(cur);
}

async function drive(): Promise<void> {
  if (driving) return;
  driving = true;
  let normalExit = false;
  const keepalive = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, KEEPALIVE_MS);
  try {
    for (;;) {
      const r = await withLock(getR);
      if (!r) break;
      if (r.status === 'stopping') { const s = stopStatus(r); await finish(r, s.status, s.reason); break; }
      if (r.status !== 'running') break;
      if (r.position >= r.plan.length) { await finish(r, 'completed'); break; }
      const action = r.plan[r.position];
      const startedAt = iso();
      await putResult(r.runId, action.index, { stepId: action.stepId, status: 'pending', startedAt });
      notify();
      const ctl = new AbortController();
      currentExec = { runId: r.runId, ctl };
      const ctx: ExecCtx = { signal: ctl.signal, navIssued: false };
      let out: Outcome | { kind: 'stopped' };
      try { out = await execStep(r, action, ctx); }
      catch (e) {
        out = e instanceof StopSignal ? { kind: 'stopped' }
          : { kind: 'done', result: { stepId: action.stepId, status: 'failed', reason: `再生の制御で例外が発生した: ${String((e as Error)?.message || e)}`, startedAt: iso(), endedAt: iso() } };
      } finally { currentExec = null; }
      if (out.kind === 'stale') continue;
      if (out.kind === 'stopped') {
        // 停止の要求で打ち切った。実行中だった手順を「停止時に実行中」として確定し、ループの先頭で run を確定する
        await withLock(async () => {
          const cur = await getR();
          if (cur && cur.runId === r.runId) await settleStoppedStep(cur, action, startedAt, ctx.navIssued);
        });
        continue;
      }
      if (out.kind === 'interrupt') { const cur = await getR(); if (cur && cur.runId === r.runId) await finish(cur, 'interrupted', out.reason); break; }
      const o = out;
      await withLock(async () => {
        const cur = await getR();
        if (!cur || cur.runId !== r.runId) return;
        cur.inFlight = undefined;
        if (o.kind === 'pause') {
          if (!o.keepMark) cur.actedResume = undefined;
          if (o.result) await putResult(r.runId, action.index, o.result);
          if (cur.status !== 'stopping') { cur.status = 'paused'; cur.waitReason = o.wait; await setRunStatus(r.runId, 'paused'); }
          await setR(cur);
          return;
        }
        // done: 手順の結果が確定したので、操作済みの印を消す
        cur.actedResume = undefined;
        await putResult(r.runId, action.index, o.result);
        if (action.index === 0) cur.openedTab = undefined;
        const isFailed = o.result.status === 'failed';
        const manual = o.result.status === 'manual';
        if (manual) {
          if (cur.status !== 'stopping') { cur.status = 'paused'; cur.waitReason = { code: 'manual-step', stepId: action.stepId, message: o.result.reason ?? '人が操作して続行する' }; await setRunStatus(r.runId, 'paused'); }
        } else if (isFailed && action.onFail === 'stop') {
          if (cur.status !== 'stopping') { cur.status = 'paused'; cur.waitReason = { code: 'failed-step', stepId: action.stepId, message: o.result.reason ?? '失敗', acted: o.result.acted ?? 'no' }; await setRunStatus(r.runId, 'paused'); }
        } else {
          cur.position = r.position + 1;
          if (cur.status === 'running' && cur.stepMode && cur.position < cur.plan.length) { cur.status = 'paused'; cur.waitReason = { code: 'step-mode', message: '1 手順を実行して一時停止した' }; await setRunStatus(r.runId, 'paused'); }
          else if (cur.status === 'paused' && !cur.waitReason) cur.waitReason = { code: 'paused-by-user', message: '人が一時停止した' };
        }
        await setR(cur);
      });
      notify();
    }
    normalExit = true;
  } finally {
    clearInterval(keepalive);
    driving = false;
  }
  // 終了の直前に再開・停止の要求が来ていた場合（drive が動いているとみなされて起動されなかった）に取りこぼさない
  if (normalExit) {
    const cur = await getR();
    if (cur && (cur.status === 'running' || cur.status === 'stopping')) setTimeout(() => void drive(), 0);
  }
}

// ---- UI からのメッセージ -----------------------------------------------------
async function start(msg: Extract<ReplayUiMsg, { t: 'ui:replay-start' }>): Promise<ReplayUiReply> {
  if ((await chrome.storage.session.get(STATE_KEY))[STATE_KEY]) return { ok: false, code: 'recording-active', message: '記録中のセッションがあります。記録を終了してから再生してください。' };
  if (await getR()) return { ok: false, code: 'replay-active', message: 'すでに再生中です。停止してから開始してください。' };
  const sc = await getScenario(msg.scenarioId);
  if (!sc) return { ok: false, code: 'no-scenario', message: 'シナリオが見つかりません。' };
  let plan: ReplayAction[];
  try { plan = buildReplayPlan(sc, await listSteps(sc.id), { fromStepId: msg.fromStepId, toStepId: msg.toStepId, onlyStepIds: msg.onlyStepIds }); }
  catch (e) { return { ok: false, code: 'invalid-range', message: String((e as Error)?.message || e) }; }
  if (!plan.length) return { ok: false, code: 'empty-plan', message: '再生する手順がありません（範囲の指定、または「再生しない」の設定を確認してください）。' };
  const variables = sc.variables ?? [];
  const provided: Record<string, string | undefined> = { ...(msg.variableValues ?? {}) };
  const pf = preflight(plan, variables, provided);
  if (pf.missingVariables.length) return { ok: false, code: 'preflight', message: `値が決まらない変数があります: ${pf.missingVariables.map((m) => m.name).join(', ')}`, preflight: pf };

  const names = planVariableNames(plan);
  const secretNames = names.filter((n) => variables.find((v) => v.name === n)?.secret);
  const values: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const n of names) {
    const v = variables.find((x) => x.name === n);
    const val = provided[n] ?? (v && !v.secret ? v.defaultValue : undefined);
    if (val === undefined) continue;
    if (secretNames.includes(n)) secrets[n] = val; else values[n] = val;
  }

  const first = plan[0];
  const startsWithNav = first.kind === 'navigate' && !!first.url && !first.reload;
  const needOrigin = async (url: string): Promise<ReplayUiReply | null> => {
    const origin = originOf(url);
    if (!origin) return { ok: false, code: 'unsupported-url', message: `http / https 以外の URL では再生を開始できません: ${url}`, preflight: pf };
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);
    return granted ? null : { ok: false, code: 'permission-required', origin, message: `${origin} へのアクセスが許可されていません。許可してから開始してください。`, preflight: pf };
  };

  let tabId: number;
  let windowId: number | undefined;
  let openedTab = false;
  if (msg.tabId !== undefined) {
    const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
    if (!tab || tab.id === undefined) return { ok: false, code: 'no-tab', message: '再生対象のタブが見つかりません。' };
    // 既存のタブで開始する: タブのページへのアクセス権を開始前に確かめる（先頭が移動なら、移動先のアクセス権も）
    const url = tab.url ?? tab.pendingUrl;
    if (originOf(url)) { const e = await needOrigin(url!); if (e) return e; }
    else if (!startsWithNav) {
      if (url) return { ok: false, code: 'unsupported-url', message: `対象タブのページでは再生を開始できません（http / https 以外）: ${url}`, preflight: pf };
      return { ok: false, code: 'permission-required', originUnknown: true, message: '対象タブの URL を読めない（アクセスが許可されていない）ため、どのサイトへのアクセスが必要か分かりません。対象のサイトへのアクセスを許可してから開始してください。', preflight: pf };
    }
    if (startsWithNav) { const e = await needOrigin(first.url!); if (e) return e; }
    tabId = tab.id; windowId = tab.windowId;
  } else {
    // 計画の先頭が移動でない場合は、どのページから始めるべきか確認できないため開かない（途中の URL から始めると文脈が合わない）
    if (!startsWithNav) return { ok: false, code: 'no-start-url', message: '計画の最初の手順がページの移動ではないため、新しいタブで開始できません。範囲を記録開始・ページ遷移の手順から始めるか、再生する既存のタブを選んでください。', preflight: pf };
    const e = await needOrigin(first.url!);
    if (e) return e;
    const tab = await chrome.tabs.create({ url: first.url, active: true });
    if (tab.id === undefined) return { ok: false, code: 'no-tab', message: '新しいタブを開けませんでした。' };
    tabId = tab.id; windowId = tab.windowId; openedTab = true;
  }

  const now = Date.now();
  const run: ReplayRun = {
    schemaVersion: SCHEMA_VERSION, id: newId('rpl'), scenarioId: sc.id, startedAt: iso(now), status: 'running', mode: msg.mode,
    range: msg.fromStepId || msg.toStepId || msg.onlyStepIds ? { fromStepId: msg.fromStepId, toStepId: msg.toStepId, onlyStepIds: msg.onlyStepIds } : undefined,
    planStepIds: plan.map((a) => a.stepId), variableValues: recordVariableValues(variables, names, { ...values, ...secrets }), results: initialResults(plan, iso(now)),
  };
  await putReplayRun(run);
  if (Object.keys(secrets).length) secretMem.set(run.id, secrets);
  const r: ActiveReplay = {
    runId: run.id, scenarioId: sc.id, tabId, windowId, mode: msg.mode, status: 'running', plan, position: 0, stepMode: msg.mode === 'step',
    variableValues: values, secretVariableNames: secretNames, startedAt: now, docEpoch: 0, openedTab: openedTab || undefined,
  };
  await setR(r);
  void drive();
  notify();
  return { ok: true, replay: r, preflight: pf };
}

function acceptSecrets(r: ActiveReplay, vals: Record<string, string> | undefined) {
  if (!vals) return;
  const mem = { ...(secretMem.get(r.runId) ?? {}) };
  for (const [k, v] of Object.entries(vals)) {
    if (r.secretVariableNames.includes(k)) mem[k] = v;
    else r.variableValues[k] = v;
  }
  secretMem.set(r.runId, mem);
}

export async function onReplayUi(msg: ReplayUiMsg): Promise<ReplayUiReply> {
  if (msg.t === 'ui:replay-start') return withLock(() => start(msg));
  const reply = await withLock(async (): Promise<ReplayUiReply> => {
    const r = await getR();
    if (msg.t === 'ui:replay-state') return { ok: true, replay: r };
    if (!r) return { ok: false, code: 'no-replay', message: '再生中ではありません。', replay: null };
    switch (msg.t) {
      case 'ui:replay-pause': {
        if (r.status !== 'running') return { ok: false, code: 'not-running', message: '実行中ではありません。', replay: r };
        r.status = 'paused'; r.waitReason = { code: 'paused-by-user', message: '人が一時停止した（実行中の手順は最後まで実行してから止まる）' };
        await setR(r); await setRunStatus(r.runId, 'paused');
        return { ok: true, replay: r };
      }
      case 'ui:replay-resume': case 'ui:replay-step': {
        if (msg.t === 'ui:replay-resume') acceptSecrets(r, msg.variableValues);
        if (r.status === 'stopping') return { ok: false, code: 'stopping', message: '停止処理中です。', replay: r };
        if (r.status === 'running') {
          if (msg.t === 'ui:replay-step') { r.stepMode = true; await setR(r); return { ok: true, replay: r }; }
          return { ok: false, code: 'not-paused', message: '一時停止中ではありません。', replay: r };
        }
        const w = r.waitReason;
        if (w?.code === 'manual-step') return { ok: false, code: 'manual-pending', message: '人の操作を待っている手順があります。操作が終わったら「操作完了」で続行してください。', replay: r };
        if (r.secretVariableNames.length) {
          const mem = secretMem.get(r.runId) ?? {};
          const lacking = r.secretVariableNames.filter((n) => mem[n] === undefined && r.plan.slice(r.position).some((a) => a.value?.source === 'template' && a.value.template.includes(n)));
          if (lacking.length) {
            r.waitReason = { code: 'secret-required', names: lacking, message: `機密の変数（${lacking.join(', ')}）の値が必要です。値を入力して再開してください。` };
            await setR(r);
            return { ok: false, code: 'secret-required', message: r.waitReason.message, replay: r };
          }
        }
        // failed-step / permission からの再開は、同じ手順を再試行する（位置は進めていない）。
        // 操作済みの印（actedResume）がある手順は、操作をせず待機条件の観測から続ける
        if (w?.code === 'failed-step' || w?.code === 'permission') {
          const a = r.plan[r.position];
          const observeOnly = !!a && stepEntryMode(r, a) === 'observe-only';
          await putResult(r.runId, r.position, { stepId: a.stepId, status: 'pending', startedAt: iso(), ...(observeOnly ? { acted: 'yes' as const, detail: '操作は実行済み。再開後は操作せず、待機条件の観測から続ける' } : {}) });
        }
        r.status = 'running'; r.waitReason = undefined; r.stepMode = msg.t === 'ui:replay-step'; // resume は連続実行に戻す
        await setR(r); await setRunStatus(r.runId, 'running');
        return { ok: true, replay: r };
      }
      case 'ui:replay-continue-manual': {
        const w = r.waitReason;
        if (r.status !== 'paused' || !w || (w.code !== 'manual-step' && w.code !== 'failed-step')) return { ok: false, code: 'not-waiting', message: '人の操作・確認を待っている手順はありません。', replay: r };
        if (w.stepId !== msg.stepId) return { ok: false, code: 'step-mismatch', message: '待っている手順と異なります。', replay: r };
        const a = r.plan[r.position];
        const now = iso();
        await patchReplayRun(r.runId, (run) => {
          const prev = run.results[a.index];
          run.results[a.index] = w.code === 'manual-step'
            ? { ...prev, stepId: a.stepId, status: 'manual', reason: w.message, detail: '人が操作して続行した', endedAt: now }
            : { ...prev, stepId: a.stepId, status: 'skipped', reason: `再生が失敗したため、人の指示でこの手順を飛ばして続行した（失敗の理由: ${w.message}）`, endedAt: now };
        });
        r.position += 1; r.inFlight = undefined; r.actedResume = undefined; r.waitReason = undefined;
        if (r.stepMode && r.position < r.plan.length) { r.waitReason = { code: 'step-mode', message: '1 手順を実行して一時停止した' }; }
        else { r.status = 'running'; await setRunStatus(r.runId, 'running'); }
        await setR(r);
        return { ok: true, replay: r };
      }
      case 'ui:replay-stop': {
        if (r.status === 'stopping') return { ok: true, replay: r };
        if (stopMode(driving) === 'finish-now') {
          // 手順を実行していない（一時停止中で drive も止まっている）。その場で確定する
          const s = stopStatus(r);
          r.status = 'stopping';
          const f = r.inFlight;
          if (f) { const a = r.plan[f.position]; if (a) await settleStoppedStep(r, a, iso(), false); }
          await setR(r);
          await finish(r, s.status, s.reason);
          return { ok: true, replay: null };
        }
        // 手順の実行中: stopping にして実行中の手順を打ち切り、確定は drive で行う（実行中だった手順を pending のまま残さない）
        r.status = 'stopping'; await setR(r);
        if (currentExec?.runId === r.runId) currentExec.ctl.abort();
        return { ok: true, replay: r };
      }
    }
    return { ok: false, code: 'unknown', message: '不明な操作です。' };
  });
  const cur = await getR();
  if (cur && (cur.status === 'running' || cur.status === 'stopping')) void drive();
  notify();
  return reply;
}

/** 再生スクリプトからのメッセージ（対象タブ・同じ再生・同じ試行のものだけ受け付ける） */
export async function onReplayPage(msg: ReplayPageMsg, sender: chrome.runtime.MessageSender): Promise<ReplayActedReply> {
  return withLock(async () => {
    const r = await getR();
    if (!r || sender.tab?.id !== r.tabId || r.runId !== msg.runId) return { proceed: false };
    if (r.status === 'stopping') return { proceed: false };
    const f = r.inFlight;
    if (!f || f.stepId !== msg.stepId || f.attemptId !== msg.attemptId) return { proceed: false };
    f.acted = true;
    await setR(r);
    return { proceed: true };
  });
}

// ---- タブの監視と起動時の回復 -------------------------------------------------
export function initReplay(): void {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'loading') return;
    void withLock(async () => {
      const r = await getR();
      if (!r || r.tabId !== tabId) return;
      r.docEpoch++;
      await setR(r);
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void withLock(async () => {
      const r = await getR();
      if (!r || r.tabId !== tabId) return;
      return r;
    }).then(async (r) => { if (r) await finish(r, 'interrupted', '対象タブが閉じられたため中断した'); });
  });

  void (async () => {
    // 状態の確認と、取り残された再生結果の確定を 1 つのロックの中で行う（直後の開始要求と競合させない）
    const r = await withLock(async () => {
      const cur = await getR();
      if (cur) return cur;
      // ブラウザの終了・拡張の再読み込みで状態が失われた再生を、中断として確定する
      for (const sc of await listScenarios()) {
        for (const run of await listReplayRuns(sc.id)) {
          if (run.status !== 'running' && run.status !== 'paused') continue;
          await patchReplayRun(run.id, (x) => { x.status = 'interrupted'; x.endedAt = iso(); x.reason = 'ブラウザの終了または拡張機能の再読み込みにより中断した（それまでの結果は保存済み）'; });
        }
      }
      return null;
    });
    if (r) {
      const tab = await chrome.tabs.get(r.tabId).catch(() => null);
      if (!tab) { await finish(r, 'interrupted', '対象タブが見つからないため中断した（Service Worker の再起動後）'); return; }
      const f = r.inFlight;
      if (f && r.status !== 'paused') {
        await withLock(async () => {
          const cur = await getR();
          if (!cur || cur.runId !== r.runId) return;
          if (cur.status === 'stopping') {
            const a = cur.plan[f.position];
            if (a) { await settleStoppedStep(cur, a, iso(), false); return; }
          }
          cur.inFlight = undefined;
          if (f.acted) {
            // 操作は実行された可能性があるが、結果（待機の観測）を受け取れていない。再試行すると二重操作になり得るため一時停止する
            const reason = 'Service Worker の再起動により、この手順の結果を受け取れなかった（操作は実行された可能性がある）';
            await putResult(cur.runId, f.position, { stepId: f.stepId, status: 'failed', reason, acted: 'possibly', startedAt: iso(), endedAt: iso() });
            if (cur.status !== 'stopping') { cur.status = 'paused'; cur.waitReason = { code: 'failed-step', stepId: f.stepId, message: reason, acted: 'possibly' }; await setRunStatus(cur.runId, 'paused'); }
          }
          // 操作前だった場合は、同じ手順を最初からやり直す（ページ側の古い試行は attemptId が一致しないため操作しない）。
          // actedResume の印がある場合は、drive が操作をせず待機条件の観測から続ける
          await setR(cur);
        });
      }
      notify();
      void drive();
    }
  })().catch((e) => console.warn('[TraceLens replay] recovery', e));
}
