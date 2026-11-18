// 押下時の画面の判定（純粋関数。chrome API・DOM に依存しない）
// pointerdown を観測した直後に取得を始めた画像を、その操作の「押下時の画面」として残してよいかを決める。
// 取得は押下より後に始まるため、押下時点と同一の画面である保証はない。観測した変化は notes に書く。
// 判定に使う画面変化は観測の範囲（各フレームの MutationObserver・スクロール・リサイズ）だけ。
import type { Rect } from './types';

export interface PressCaptureOk { ok: true; startedAtMs: number; endedAtMs: number }
export interface PressCaptureNg { ok: false; reasonCode: string; reason: string }

export interface PressDecisionInput {
  pressAtMs: number;
  /** 操作（クリック・値の変更など）を観測した時刻 */
  operationAtMs: number;
  /** 取得の結果。null は取得の情報が見つからない（Service Worker の再起動など） */
  capture: PressCaptureOk | PressCaptureNg | null;
  /** 押下以降に最初に観測した画面変化の時刻。null は観測していない */
  firstChangeAtMs: number | null;
  /** 押下時と取得の完了時で、トップの文書・タブが同じか */
  sameDocument: boolean;
  /** 押下時と取得の完了後に測った対象要素の矩形（トップのビューポート基準） */
  rectAtPress: Rect | null;
  rectAfterCapture: Rect | null;
}

export type PressDecision =
  | { keep: true; notes: string[]; highlight: boolean; highlightNote?: string }
  | { keep: false; reasonCode: string; reason: string };

/** 押下から取得までの許容時間。これを超えたら押下時の画面として扱わない */
export const PRESS_MAX_DELAY_MS = 1500;

const sameRect = (a: Rect | null, b: Rect | null, tol = 2) =>
  !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;

export function decidePressShot(i: PressDecisionInput): PressDecision {
  const c = i.capture;
  if (!c) return { keep: false, reasonCode: 'press-lost', reason: '押下時の画面の取得情報が見つからない（Service Worker の再起動などのため）' };
  if (!c.ok) return { keep: false, reasonCode: c.reasonCode, reason: c.reason };
  if (!i.sameDocument) return { keep: false, reasonCode: 'page-changed', reason: '押下から取得の完了までにページまたはタブが切り替わったため、押下時の画面として保存しない' };
  if (c.startedAtMs - i.pressAtMs > PRESS_MAX_DELAY_MS) return { keep: false, reasonCode: 'press-late', reason: `押下から取得の開始まで ${c.startedAtMs - i.pressAtMs}ms かかったため、押下時の画面として保存しない` };
  const ch = i.firstChangeAtMs;
  if (ch !== null && ch < c.startedAtMs && ch >= i.operationAtMs) {
    return { keep: false, reasonCode: 'changed-after-operation', reason: '操作の後、取得の開始前に画面変化を観測したため、操作後の画面が写っている可能性がある。押下時の画面としては保存しない' };
  }
  const notes: string[] = [];
  if (ch !== null && ch < c.startedAtMs) notes.push('押下から取得の開始までに画面変化（DOM・スクロールなど）を観測した（押下による表示の変化などの可能性）。押下の直前とまったく同じ画面ではない');
  else if (ch !== null && ch <= c.endedAtMs) notes.push('取得中に画面変化を観測した。変化の前後のどちらが写っているかは分からない');
  if (c.startedAtMs > i.operationAtMs) notes.push('操作（クリックなど）を観測した後に取得を開始した（取得の開始までに画面変化は観測していない）');
  notes.push(`押下から取得の開始まで約 ${Math.max(0, c.startedAtMs - i.pressAtMs)}ms。観測できる範囲（DOM・スクロール・サイズ）の外の変化（:hover・:active・アニメーション・canvas など）は分からない`);
  const highlight = sameRect(i.rectAtPress, i.rectAfterCapture);
  const highlightNote = highlight ? undefined
    : !i.rectAtPress ? '押下時に対象要素の位置を確認できなかったため、操作位置を強調しない'
      : '押下時と取得後で対象要素の位置が一致しなかった（または確認できなかった）ため、操作位置を強調しない';
  return { keep: true, notes, highlight, ...(highlightNote ? { highlightNote } : {}) };
}

/** 押下と操作の対象要素が対応するか（同じ要素・祖先と子孫・label とその入力欄） */
export function pressRelated(press: Element, op: Element): boolean {
  if (press === op || press.contains(op) || op.contains(press)) return true;
  const ctl = (el: Element) => (el.tagName === 'LABEL' ? (el as HTMLLabelElement).control : null);
  const pl = press.closest?.('label');
  return ctl(press) === op || (!!pl && ctl(pl) === op) || ctl(op) === press;
}
