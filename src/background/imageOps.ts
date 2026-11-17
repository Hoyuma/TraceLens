// Service Worker 内での画像の合成・切り出し（OffscreenCanvas）
// OffscreenCanvas / createImageBitmap が Service Worker で使えない環境では失敗を返す（取得失敗として理由を残す）。
import { composeLayout, type ScannedFrame } from '../shared/capture';
import type { Rect } from '../shared/types';

export type ImgResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function unsupported(): string | null {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return 'この環境の Service Worker では OffscreenCanvas / createImageBitmap が使えないため、画像を加工できない';
  return null;
}

export async function composeFullPage(blobs: Blob[], frames: ScannedFrame[], devicePixelRatio: number, coveredHeightCss: number): Promise<ImgResult<{ blob: Blob; width: number; height: number }>> {
  const u = unsupported(); if (u) return { ok: false, reason: u };
  const layout = composeLayout(frames, devicePixelRatio, coveredHeightCss);
  if (!layout.width || !layout.height) return { ok: false, reason: '合成する画像がない' };
  const bitmaps: ImageBitmap[] = [];
  try {
    const canvas = new OffscreenCanvas(layout.width, layout.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, reason: 'canvas の 2D コンテキストを取得できない' };
    for (const d of layout.draws) {
      const bmp = await createImageBitmap(blobs[d.index]);
      bitmaps.push(bmp);
      ctx.drawImage(bmp, 0, d.dy);
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { ok: true, value: { blob, width: layout.width, height: layout.height } };
  } catch (e) {
    return { ok: false, reason: `画像の合成に失敗: ${String((e as Error)?.message || e)}` };
  } finally { for (const b of bitmaps) b.close(); }
}

export async function cropBlob(blob: Blob, crop: Rect): Promise<ImgResult<Blob>> {
  const u = unsupported(); if (u) return { ok: false, reason: u };
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(crop.width, crop.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, reason: 'canvas の 2D コンテキストを取得できない' };
    ctx.drawImage(bmp, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return { ok: true, value: await canvas.convertToBlob({ type: 'image/png' }) };
  } catch (e) {
    return { ok: false, reason: `画像の切り出しに失敗: ${String((e as Error)?.message || e)}` };
  } finally { bmp?.close(); }
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'undefined') return null;
  try { const b = await createImageBitmap(blob); const r = { width: b.width, height: b.height }; b.close(); return r; } catch { return null; }
}
