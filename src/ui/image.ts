// 出力用画像の生成。塗りつぶし・ぼかし・切り抜きは画像そのものに焼き込み、必ず再エンコードする
// （原本の Blob をそのまま出力に流さない）。
//
// 座標はすべて「原本画像のピクセル座標」で保存する。出力時に切り抜き後の座標へ変換する。
// 計算は DOM に依存しない純粋関数（RGBA 配列）に分けてあり、単体テストできる。
import type { ImageMask, MaskKind, Rect, ScreenshotMeta } from '../shared/types';

export interface RGBAImage { data: Uint8ClampedArray; width: number; height: number }

/** 切り抜きの最小サイズ(px)。これより小さい範囲は無効として扱う */
export const MIN_CROP = 8;

export const maskKindOf = (m: ImageMask): MaskKind => (m.kind === 'blur' ? 'blur' : 'fill');

/** 切り抜き範囲を整数に丸め、画像内に収める。無効・画像全体と同じ場合は null（=切り抜きなし）。 */
export function normalizeCrop(crop: Rect | null | undefined, imgW: number, imgH: number): Rect | null {
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)) return null;
  const x0 = Math.max(0, Math.floor(crop.x)), y0 = Math.max(0, Math.floor(crop.y));
  const x1 = Math.min(imgW, Math.ceil(crop.x + crop.width)), y1 = Math.min(imgH, Math.ceil(crop.y + crop.height));
  if (x1 - x0 < MIN_CROP || y1 - y0 < MIN_CROP) return null;
  if (x0 === 0 && y0 === 0 && x1 === imgW && y1 === imgH) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * 原本座標の矩形を、切り抜き後の座標へ変換して切り抜き範囲に収める。
 * 完全に範囲外なら null（描かない／適用しない）。crop が無ければ整数化のみ。
 * 整数化は外側へ丸める（塗りつぶしの取りこぼしを避けるため、少し広めにする）。
 */
export function toCropSpace(r: Rect, crop: Rect | null | undefined): Rect | null {
  const ox = crop ? crop.x : 0, oy = crop ? crop.y : 0;
  let x0 = Math.floor(r.x) - ox, y0 = Math.floor(r.y) - oy;
  let x1 = Math.ceil(r.x + r.width) - ox, y1 = Math.ceil(r.y + r.height) - oy;
  const maxW = crop ? crop.width : Infinity, maxH = crop ? crop.height : Infinity;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(maxW, x1); y1 = Math.min(maxH, y1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** モザイクのブロックの大きさ。領域の短辺を約3分割し、最低 12px。文字が判読できない粗さにする。 */
export function blockSizeFor(w: number, h: number): number {
  return Math.max(12, Math.ceil(Math.min(w, h) / 3));
}

/** 領域をブロック平均に置き換える（多対一の変換で、元の画素は復元できない）。領域の外は読まない。 */
export function pixelate(img: RGBAImage, rect: Rect, block: number): void {
  const { data, width } = img;
  const x1 = rect.x + rect.width, y1 = rect.y + rect.height;
  for (let by = rect.y; by < y1; by += block) {
    for (let bx = rect.x; bx < x1; bx += block) {
      const ex = Math.min(bx + block, x1), ey = Math.min(by + block, y1);
      const sum = [0, 0, 0, 0]; let n = 0;
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * width + x) * 4; sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; sum[3] += data[i + 3]; n++; }
      const avg = sum.map((v) => Math.round(v / n));
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * width + x) * 4; data[i] = avg[0]; data[i + 1] = avg[1]; data[i + 2] = avg[2]; data[i + 3] = avg[3]; }
    }
  }
}

/** 領域内だけを使うボックスぼかし（水平→垂直）。領域の外の画素は読まない・書かない。 */
export function boxBlur(img: RGBAImage, rect: Rect, radius: number): void {
  if (radius < 1) return;
  const { data, width } = img;
  const tmp = new Float32Array(rect.width * rect.height * 4);
  const idx = (x: number, y: number) => ((rect.y + y) * width + rect.x + x) * 4;
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const a = Math.max(0, x - radius), b = Math.min(rect.width - 1, x + radius), n = b - a + 1;
    for (let c = 0; c < 4; c++) { let s = 0; for (let k = a; k <= b; k++) s += data[idx(k, y) + c]; tmp[(y * rect.width + x) * 4 + c] = s / n; }
  }
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const a = Math.max(0, y - radius), b = Math.min(rect.height - 1, y + radius), n = b - a + 1;
    for (let c = 0; c < 4; c++) { let s = 0; for (let k = a; k <= b; k++) s += tmp[(k * rect.width + x) * 4 + c]; data[idx(x, y) + c] = Math.round(s / n); }
  }
}

/** 粗いモザイク化＋ぼかし。 */
export function blurRegion(img: RGBAImage, rect: Rect): void {
  const block = blockSizeFor(rect.width, rect.height);
  pixelate(img, rect, block);
  boxBlur(img, rect, Math.max(2, Math.floor(block / 4)));
}

export function fillRegion(img: RGBAImage, rect: Rect): void {
  const { data, width } = img;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) { const i = (y * width + x) * 4; data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255; }
}

/**
 * 切り抜き → マスク適用。出力は切り抜き範囲の画素だけから作る（範囲外の画素は出力に入らない）。
 * マスクは原本座標で渡し、ここで切り抜き後の座標へ変換する（範囲外のマスクは無視）。
 */
export function composeEdited(src: RGBAImage, masks: ImageMask[], cropIn?: Rect | null): RGBAImage {
  const crop = normalizeCrop(cropIn, src.width, src.height);
  let out: RGBAImage;
  if (crop) {
    const data = new Uint8ClampedArray(crop.width * crop.height * 4);
    for (let y = 0; y < crop.height; y++) {
      const from = ((crop.y + y) * src.width + crop.x) * 4;
      data.set(src.data.subarray(from, from + crop.width * 4), y * crop.width * 4);
    }
    out = { data, width: crop.width, height: crop.height };
  } else out = { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
  for (const m of masks) {
    const r = toCropSpace(m, crop);
    if (!r) continue;
    const rr = { x: r.x, y: r.y, width: Math.min(r.width, out.width - r.x), height: Math.min(r.height, out.height - r.y) };
    if (rr.width <= 0 || rr.height <= 0) continue;
    if (maskKindOf(m) === 'blur') blurRegion(out, rr); else fillRegion(out, rr);
  }
  return out;
}

/**
 * ビューポート(CSS px)基準の対象矩形を、切り抜き後の画像座標へ変換する。
 * 切り抜き範囲外なら null（ハイライトを描かない）。
 */
export function targetRectInImage(tr: Rect, vp: { width: number; height: number }, img: { width: number; height: number }, crop?: Rect | null): Rect | null {
  const sx = img.width / vp.width, sy = img.height / vp.height;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return null;
  const r = { x: tr.x * sx, y: tr.y * sy, width: tr.width * sx, height: tr.height * sy };
  if (!crop) return r;
  const x0 = Math.max(r.x, crop.x), y0 = Math.max(r.y, crop.y), x1 = Math.min(r.x + r.width, crop.x + crop.width), y1 = Math.min(r.y + r.height, crop.y + crop.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0 - crop.x, y: y0 - crop.y, width: x1 - x0, height: y1 - y0 };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 切り抜き後の出力に付ける画像メタ情報（viewport・対象位置）を整合させる。
 * 原本サイズが不明なときは位置の対応を確認できないため、対象位置は null にして理由を書く。
 */
export function metaForCrop(meta: ScreenshotMeta | undefined, crop: Rect | null | undefined, srcSize: { width: number; height: number } | undefined): { viewport: ScreenshotMeta['viewport'] | null; targetRectAtCapture: Rect | null; targetRectNote: string | null; cropNote: string | null } {
  const vp = meta?.viewport ?? null;
  const tr = meta?.targetRectAtCapture ?? null;
  const baseNote = meta?.targetRectNote ?? null;
  if (!crop) return { viewport: vp, targetRectAtCapture: tr, targetRectNote: baseNote, cropNote: null };
  if (!srcSize) return { viewport: null, targetRectAtCapture: null, targetRectNote: '画像を切り抜いたが、原本の大きさが記録されていないため、位置の対応を確認できない', cropNote: '切り抜き済み。viewport は切り抜き後の画像と対応しないため出力しない' };
  const c = normalizeCrop(crop, srcSize.width, srcSize.height);
  if (!c) return { viewport: vp, targetRectAtCapture: tr, targetRectNote: baseNote, cropNote: null };
  if (!vp) return { viewport: null, targetRectAtCapture: null, targetRectNote: '切り抜き済みで、取得時の表示領域の大きさが無いため位置の対応を確認できない', cropNote: '切り抜き済み' };
  const sx = srcSize.width / vp.width, sy = srcSize.height / vp.height;
  const newVp = { ...vp, width: round2(c.width / sx), height: round2(c.height / sy) };
  let rect: Rect | null = null; let note: string | null = baseNote;
  if (tr) {
    const r = targetRectInImage(tr, vp, srcSize, c);
    if (r) rect = { x: round2(r.x / sx), y: round2(r.y / sy), width: round2(r.width / sx), height: round2(r.height / sy) };
    else note = '対象要素の位置が切り抜き範囲の外にあるため出力しない';
  }
  return { viewport: newVp, targetRectAtCapture: rect, targetRectNote: note, cropNote: '切り抜き済み。viewport の width/height と対象位置は切り抜き後の画像に合わせて変換した（scrollX/scrollY は切り抜き前の値のまま）' };
}

/** PNG の IHDR から画像サイズを読む。PNG でなければ null。 */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export async function renderMasked(blob: Blob, masks: ImageMask[], crop?: Rect | null): Promise<Uint8Array> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const src = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  const edited = composeEdited({ data: src.data, width: src.width, height: src.height }, masks, crop);
  const outCanvas = new OffscreenCanvas(edited.width, edited.height);
  outCanvas.getContext('2d')!.putImageData(new ImageData(edited.data as Uint8ClampedArray<ArrayBuffer>, edited.width, edited.height), 0, 0);
  const out = await outCanvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await out.arrayBuffer());
}
