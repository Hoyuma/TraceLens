// 出力用画像の生成。塗りつぶしは画像そのものに焼き込み、必ず再エンコードする
// （原本の Blob をそのまま出力に流さない）。
import type { Rect } from '../shared/types';

export async function renderMasked(blob: Blob, masks: Rect[]): Promise<Uint8Array> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  ctx.fillStyle = '#000';
  for (const m of masks) ctx.fillRect(Math.floor(m.x), Math.floor(m.y), Math.ceil(m.width), Math.ceil(m.height));
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await out.arrayBuffer());
}
