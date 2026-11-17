// 「操作前の画面」の参照判定（純粋関数）
// 新しい画像は作らない。直前の観測で取得した画像以降に、観測の範囲で画面変化がないときだけ、その画像を参照する。
// 「観測の範囲で変化なし」であり、画面が同一である保証ではない（CSS の :hover・アニメーション・動画・canvas・
// 別オリジンのフレーム内の変化などは観測できない）。
import type { BeforeScreenshot } from './types';

export type ChangeKind = 'dom' | 'scroll' | 'resize' | 'tracking-start';

/** 直前に取得した（参照候補の）画像の情報。SW が画像の保存時に記録する。 */
export interface RefShot {
  artifactId: string;
  stepId: string;
  /** 画像の取得時刻（保存時） */
  capturedAt: string;
  /** captureVisibleTab を呼ぶ直前の時刻 (ms)。これより後の変化は画像に写っていない可能性がある */
  startedAtMs: number;
  docEpoch: number;
  viewport?: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
}

export interface BeforeInput {
  /** この手順を保存する時点の docEpoch */
  docEpoch: number;
  operationAtMs: number;
  /** 操作時点のビューポート（コンテンツスクリプトが報告） */
  viewport?: RefShot['viewport'];
  /** 観測した最後の画面変化（なければ null。変化の観測情報を得られなければ undefined） */
  lastChange?: { atMs: number; kind: ChangeKind } | null;
  prev: RefShot | null;
}

const CHANGE_LABEL: Record<ChangeKind, string> = { dom: 'DOM の変化', scroll: 'スクロール', resize: 'ウィンドウサイズの変更', 'tracking-start': '観測の開始・再開（それ以前の変化は観測していない）' };
/** 画像の取得開始より、この時間以上前の変化だけを「画像に写っている」とみなす余裕 */
export const SAFETY_MS = 80;

const skip = (reasonCode: string, reason: string): BeforeScreenshot => ({ status: 'skipped', reasonCode, reason, basis: 'previous-observation' });

export function decideBeforeScreenshot(i: BeforeInput): BeforeScreenshot {
  if (!i.prev) return skip('no-previous', '参照できる直前の画像がない（まだ取得していない、または取得に失敗した）');
  if (i.prev.docEpoch !== i.docEpoch) return skip('document-changed', '前の画像を取得した後にページ（文書）が切り替わった');
  if (i.prev.startedAtMs >= i.operationAtMs) return skip('not-before-operation', '前の画像の取得が操作より後に始まっているため、操作前の画面として扱わない');
  if (i.lastChange === undefined) return skip('no-observation', '画面変化を観測できなかった（フレーム内の操作などのため）ので判定しない');
  if (i.lastChange && i.lastChange.atMs > i.prev.startedAtMs - SAFETY_MS) {
    return skip(i.lastChange.kind === 'scroll' ? 'scrolled' : i.lastChange.kind === 'resize' ? 'resized' : 'change-observed', `前の画像の取得後に画面変化を観測した（${CHANGE_LABEL[i.lastChange.kind]}）`);
  }
  const a = i.prev.viewport, b = i.viewport;
  if (!a || !b) return skip('viewport-unknown', 'ビューポートの情報がなく、前の画像と同じ表示領域か確認できない');
  if (a.width !== b.width || a.height !== b.height || a.devicePixelRatio !== b.devicePixelRatio) return skip('viewport-changed', 'ビューポートの大きさが前の画像の取得時と異なる');
  if (a.scrollX !== b.scrollX || a.scrollY !== b.scrollY) return skip('scrolled', 'スクロール位置が前の画像の取得時と異なる');
  return { status: 'captured', artifactId: i.prev.artifactId, capturedAt: i.prev.capturedAt, refStepId: i.prev.stepId, basis: 'previous-observation' };
}
