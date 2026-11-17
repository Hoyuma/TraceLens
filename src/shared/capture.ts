// ページ全体・要素単位の画面取得の、純粋な計算部分（chrome API・DOM に依存しない）
// 取得そのもの（captureVisibleTab・OffscreenCanvas）は Service Worker 側。
import type { Rect } from './types';

/** ページ全体の取得の上限。超えたら途中までであることを記録する。 */
export const FULL_PAGE_LIMITS: { maxFrames: number; maxHeightDevicePx: number; maxTotalPixels: number } = {
  /** 合成する画像の最大枚数 */
  maxFrames: 15,
  /** 合成画像の高さの上限（デバイス px。canvas の実用上の上限に余裕を持たせた値） */
  maxHeightDevicePx: 16000,
  /** 合成画像の合計画素数の上限（デバイス px） */
  maxTotalPixels: 48_000_000,
};

export interface ScrollPlanInput {
  /** ドキュメント全体の高さ（CSS px） */
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  limits?: Partial<typeof FULL_PAGE_LIMITS>;
}
export interface ScrollPlan {
  /** 順に移動するスクロール位置（CSS px）。最後の位置は、スクロール可能な最下端に合わせる。 */
  positions: number[];
  /** 合成される範囲の高さ（CSS px） */
  coveredHeight: number;
  /** 上限により、ページの最後まで取得しない */
  partial: boolean;
  partialReason?: string;
}

/** スクロール位置の計画。1 画面ずつ重ならずに進める（固定ヘッダーの重複は避けられない）。 */
export function planScroll(inp: ScrollPlanInput): ScrollPlan {
  const lim = { ...FULL_PAGE_LIMITS, ...(inp.limits ?? {}) };
  const vh = Math.max(1, Math.floor(inp.viewportHeight));
  const dpr = inp.devicePixelRatio > 0 ? inp.devicePixelRatio : 1;
  const page = Math.max(vh, Math.ceil(inp.pageHeight));
  const maxByHeight = Math.max(vh, Math.floor(lim.maxHeightDevicePx / dpr));
  const maxByPixels = Math.max(vh, Math.floor(lim.maxTotalPixels / (Math.max(1, inp.viewportWidth) * dpr * dpr)));
  const maxByFrames = lim.maxFrames * vh;
  const cap = Math.min(maxByHeight, maxByPixels, maxByFrames);
  const target = Math.min(page, cap);
  const positions: number[] = [];
  for (let y = 0; y + vh < target; y += vh) positions.push(y);
  // 最後の 1 枚は、取得する範囲の最下端に合わせる（重なる部分は後の画像で上書きする）
  positions.push(Math.max(0, target - vh));
  const uniq = [...new Set(positions)];
  const partial = page > cap;
  let partialReason: string | undefined;
  if (partial) {
    const why = cap === maxByFrames ? `枚数の上限（${lim.maxFrames} 枚）` : cap === maxByHeight ? `高さの上限（${lim.maxHeightDevicePx} デバイス px）` : `合計画素数の上限（${lim.maxTotalPixels} px）`;
    partialReason = `${why}を超えるため、ページの先頭から ${target}px（全体 ${page}px）までを取得した`;
  }
  return { positions: uniq, coveredHeight: Math.min(page, target), partial, partialReason };
}

export interface ScannedFrame { scrollY: number; imageWidth: number; imageHeight: number }
export interface ComposeLayout {
  width: number;
  height: number;
  /** 各画像を描く位置（合成画像の座標。デバイス px）。順に描く（後の画像が重なりを上書き） */
  draws: { index: number; dy: number }[];
}

/** 取得した各画像を、実際のスクロール位置に合わせて配置する */
export function composeLayout(frames: ScannedFrame[], devicePixelRatio: number, coveredHeightCss: number): ComposeLayout {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (!frames.length) return { width: 0, height: 0, draws: [] };
  const width = Math.max(...frames.map((f) => f.imageWidth));
  const draws = frames.map((f, index) => ({ index, dy: Math.round(f.scrollY * dpr) }));
  const bottom = Math.max(...frames.map((f, i) => draws[i].dy + f.imageHeight));
  const height = Math.max(1, Math.min(bottom, Math.round(coveredHeightCss * dpr)));
  return { width, height, draws };
}

/** 要素の矩形（CSS px, ビューポート基準）から、画像上の切り出し範囲を求める。見えている部分だけ。 */
export function cropForElement(
  rect: Rect, viewport: { width: number; height: number }, imageWidth: number, imageHeight: number,
): { crop: Rect; clipped: boolean; visibleRatio: number } | null {
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(viewport.width, rect.x + rect.width), y1 = Math.min(viewport.height, rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0 || rect.width <= 0 || rect.height <= 0) return null;
  const sx = imageWidth / viewport.width, sy = imageHeight / viewport.height;
  const crop: Rect = { x: Math.floor(x0 * sx), y: Math.floor(y0 * sy), width: Math.max(1, Math.ceil((x1 - x0) * sx)), height: Math.max(1, Math.ceil((y1 - y0) * sy)) };
  crop.width = Math.min(crop.width, imageWidth - crop.x); crop.height = Math.min(crop.height, imageHeight - crop.y);
  const visibleRatio = ((x1 - x0) * (y1 - y0)) / (rect.width * rect.height);
  return { crop, clipped: visibleRatio < 0.999, visibleRatio };
}

/** 取得前後に測った矩形が同じ（許容 2px）か。違えば要素の位置を確認できなかったものとして切り出さない。 */
export function sameRect(a: Rect | null | undefined, b: Rect | null | undefined, tol = 2): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}
