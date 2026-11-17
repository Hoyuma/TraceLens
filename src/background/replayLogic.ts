// 再生の制御の判断部分（chrome API に依存しない。tests/unit/replayControl.test.ts で検査する）
// - 注入エラーの分類、足りないオリジンの特定
// - 手順を操作から始めるか、待機の観測だけから再開するか（遷移後の権限待ちからの再開で二重操作しない）
// - 停止の確定（実行中の手順を成功にも未実行にも見せない）
// - replay:run の応答の扱い（受け取れた失敗理由を優先する）
// - 同一文書内の移動（# だけが違う URL）と、記録した再読み込みの再生先
import type { ActedState, ReplayAction, ReplayStepResult } from '../shared/replay';
import type { ActiveReplay, ReplayRunReply } from '../shared/messages';

// ---- 注入エラー ---------------------------------------------------------------
export type InjectErrorClass = { code: 'restricted' | 'permission' | 'other'; url?: string };

const QUOTED_URL = /"([a-z][a-z0-9+.-]*:[^"]*)"/i;
const ACCESSIBLE_SCHEMES = new Set(['http', 'https', 'file']);

/**
 * executeScript のエラー文を分類する。
 * エラー文に含まれる URL（`.pdf` や `chrome` を含むパスなど）には一致させない: 判定は引用符・URL を取り除いた本文と、
 * 引用された URL のスキームだけで行う。
 */
export function classifyInjectError(message: string): InjectErrorClass {
  const url = message.match(QUOTED_URL)?.[1];
  const scheme = url ? url.slice(0, url.indexOf(':')).toLowerCase() : undefined;
  // 「Cannot access a chrome:// URL」のように、スキームそのものが文の一部になっている形
  if (/^\s*(Error:\s*)?Cannot access a [a-z][a-z0-9+.-]*:(\/\/)? URL/i.test(message)) return { code: 'restricted', url };
  const bare = message.replace(/"[^"]*"/g, '""').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<url>');
  if (/extensions gallery|web ?store|showing error page|ExtensionsSettings policy|runtime_blocked_hosts/i.test(bare)) return { code: 'restricted', url };
  if (url && scheme && !ACCESSIBLE_SCHEMES.has(scheme)) return { code: 'restricted', url };
  if (/must request permission|Cannot access contents|permission to access|Missing host permission/i.test(bare)) return { code: 'permission', url: url && scheme && ACCESSIBLE_SCHEMES.has(scheme) ? url : undefined };
  return { code: 'other', url };
}

export function originOf(url: string | undefined): string | undefined {
  try { const u = new URL(url ?? ''); return /^https?:$/.test(u.protocol) ? u.origin : undefined; } catch { return undefined; }
}

/** 実際に足りないオリジン（読める URL の最初のもの）。分からなければ originUnknown */
export function missingOrigin(...urls: (string | undefined)[]): { origin: string } | { originUnknown: true } {
  for (const u of urls) { const o = originOf(u); if (o) return { origin: o }; }
  return { originUnknown: true };
}

// ---- 再開時に操作するか -----------------------------------------------------------
/**
 * 'observe-only': この手順は操作済み（actedResume の印がある）。操作せず待機条件の観測だけを行う。
 * 印は storage.session の ActiveReplay にあるため、SW の再起動後も有効。
 */
export function stepEntryMode(r: Pick<ActiveReplay, 'actedResume' | 'position'>, a: Pick<ReplayAction, 'index' | 'stepId'>): 'act' | 'observe-only' {
  const m = r.actedResume;
  return m && m.acted && m.stepId === a.stepId && m.position === a.index && r.position === a.index ? 'observe-only' : 'act';
}

// ---- 停止 ---------------------------------------------------------------------
/** 手順を実行中（drive が動いている）なら stopping にして実行側で確定する。そうでなければその場で確定する */
export function stopMode(driving: boolean): 'finish-now' | 'defer' {
  return driving ? 'defer' : 'finish-now';
}

/** 停止時に実行中だった手順の結果。ok にも pending（未実行）にもしない */
export function stoppedStepResult(stepId: string, startedAt: string, acted: ActedState, now: string): ReplayStepResult {
  if (acted === 'no') return { stepId, status: 'skipped', reason: '停止時に実行中だった。操作は実行していない（停止したため打ち切った）', acted, stoppedWhileRunning: true, startedAt, endedAt: now };
  return {
    stepId, status: 'failed', acted, stoppedWhileRunning: true, startedAt, endedAt: now,
    reason: acted === 'yes' ? '停止時に実行中だった（操作は実行済み。待機条件の観測は打ち切ったため結果は未確認）' : '停止時に実行中だった（操作は実行された可能性がある。結果は未確認）',
  };
}

// ---- replay:run の応答 -------------------------------------------------------------
export type RunReplyDecision =
  | { kind: 'fail'; reason: string; acted: ActedState }
  | { kind: 'use-reply'; acted: ActedState }
  | { kind: 'manual' }
  | { kind: 'observe-after-act'; acted: ActedState }
  | { kind: 'retry'; lastReason?: string };

export const NO_REPLY_REASON = 'ページから応答がない（ダイアログの表示中などでページのスクリプトが止まっている可能性がある）';

/**
 * replay:run の応答をどう扱うか。
 * - acted: ページが操作の直前に replay:acted で確認し、許可を受けた（応答を受け取れなければ「可能性がある」）
 * - 応答と文書の切り替わりが同時なら、受け取れた失敗理由を「結果を受け取れなかった」で上書きしない
 */
export function decideRunReply(i: { reply: ReplayRunReply | undefined | 'timeout'; acted: boolean; docChanged: boolean; failedSend: boolean; pastDeadline: boolean; lastReason?: string }): RunReplyDecision {
  if (i.reply === 'timeout') return { kind: 'fail', reason: `${NO_REPLY_REASON}${i.acted ? '。操作は実行された可能性がある' : ''}`, acted: i.acted ? 'possibly' : 'no' };
  const reply = i.reply;
  if (reply && !i.docChanged) return { kind: 'use-reply', acted: i.acted ? 'yes' : 'no' };
  if (reply?.status === 'manual') return { kind: 'manual' };
  if (i.acted) return { kind: 'observe-after-act', acted: i.docChanged ? 'yes' : 'possibly' };
  const lastReason = reply?.reason ?? i.lastReason;
  if (i.pastDeadline) return { kind: 'fail', reason: lastReason ?? (i.failedSend ? 'ページとの接続が切れ、操作できなかった' : 'ページから結果を受け取れなかった'), acted: 'no' };
  return { kind: 'retry', lastReason };
}

// ---- 移動 ---------------------------------------------------------------------
const stripHash = (u: URL) => { const c = new URL(u.href); c.hash = ''; return c.href; };

/**
 * from から to への移動が同一文書内（# だけが違う）か。
 * - to に # がなければ文書の読み込みになる（false）
 * - from が読めない（アクセス権がない）場合は 'unknown'
 */
export function isSameDocumentNavigation(from: string | undefined, to: string): boolean | 'unknown' {
  let t: URL;
  try { t = new URL(to); } catch { return false; }
  if (!to.includes('#')) return false;
  if (!from) return 'unknown';
  try { return stripHash(new URL(from)) === stripHash(t); } catch { return 'unknown'; }
}

/** 記録した再読み込みの再生先。フォームの再送信を起こさないよう、現在の URL（読めなければ記録の URL）へ GET で移動し直す */
export function reloadTarget(current: string | undefined, recorded: string | undefined): { url: string; droppedFragment: boolean; usedRecorded: boolean } | null {
  const base = current && /^https?:/i.test(current) ? current : recorded;
  if (!base) return null;
  try {
    const u = new URL(base);
    const droppedFragment = !!u.hash || base.endsWith('#');
    u.hash = '';
    return { url: u.href.replace(/#$/, ''), droppedFragment, usedRecorded: base !== current };
  } catch { return null; }
}
