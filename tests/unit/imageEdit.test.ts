import { describe, expect, it } from 'vitest';
import { blockSizeFor, composeEdited, maskKindOf, metaForCrop, normalizeCrop, pixelate, readPngSize, targetRectInImage, toCropSpace, type RGBAImage } from '../../src/ui/image';
import { buildExport } from '../../src/shared/export';
import { mkArtifacts, mkProject, mkScenario, mkStep } from './fixtures';

/** 各画素が一意な値を持つ画像（座標から値が決まる）。マーカーで「どの画素が出力に残ったか」を調べる。 */
function gradient(w: number, h: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; data[i] = (x * 7 + y * 3) % 256; data[i + 1] = (x * 5 + y * 11) % 256; data[i + 2] = (x * 13 + y) % 256; data[i + 3] = 255; }
  return { data, width: w, height: h };
}
const px = (im: RGBAImage, x: number, y: number) => Array.from(im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));

describe('切り抜きの座標計算', () => {
  it('normalizeCrop: 整数化・画像内へのクランプ・無効な範囲は null', () => {
    expect(normalizeCrop({ x: 10.4, y: 5.2, width: 50.2, height: 40.1 }, 200, 100)).toEqual({ x: 10, y: 5, width: 51, height: 41 });
    expect(normalizeCrop({ x: -20, y: -5, width: 60, height: 30 }, 200, 100)).toEqual({ x: 0, y: 0, width: 40, height: 25 });
    expect(normalizeCrop({ x: 150, y: 50, width: 500, height: 500 }, 200, 100)).toEqual({ x: 150, y: 50, width: 50, height: 50 });
    expect(normalizeCrop({ x: 0, y: 0, width: 200, height: 100 }, 200, 100)).toBeNull(); // 全体=切り抜きなし
    expect(normalizeCrop({ x: 0, y: 0, width: 3, height: 50 }, 200, 100)).toBeNull(); // 小さすぎる
    expect(normalizeCrop({ x: NaN, y: 0, width: 50, height: 50 }, 200, 100)).toBeNull();
    expect(normalizeCrop(undefined, 200, 100)).toBeNull();
  });
  it('toCropSpace: 原本座標から切り抜き後の座標へ。範囲外は null、はみ出しは切り詰める', () => {
    const crop = { x: 50, y: 20, width: 100, height: 60 };
    expect(toCropSpace({ x: 60, y: 30, width: 10, height: 10 }, crop)).toEqual({ x: 10, y: 10, width: 10, height: 10 });
    expect(toCropSpace({ x: 0, y: 0, width: 10, height: 10 }, crop)).toBeNull();
    expect(toCropSpace({ x: 40, y: 10, width: 30, height: 20 }, crop)).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    expect(toCropSpace({ x: 140, y: 70, width: 50, height: 50 }, crop)).toEqual({ x: 90, y: 50, width: 10, height: 10 });
    expect(toCropSpace({ x: 5, y: 6, width: 7, height: 8 }, null)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });
  it('targetRectInImage: 切り抜き範囲外のハイライトは null、内側なら切り抜き後の座標', () => {
    const vp = { width: 100, height: 50 }, img = { width: 200, height: 100 }; // 2倍
    expect(targetRectInImage({ x: 10, y: 10, width: 10, height: 5 }, vp, img, null)).toEqual({ x: 20, y: 20, width: 20, height: 10 });
    const crop = { x: 100, y: 0, width: 100, height: 100 };
    expect(targetRectInImage({ x: 10, y: 10, width: 10, height: 5 }, vp, img, crop)).toBeNull();
    expect(targetRectInImage({ x: 60, y: 10, width: 10, height: 5 }, vp, img, crop)).toEqual({ x: 20, y: 20, width: 20, height: 10 });
    expect(targetRectInImage({ x: 45, y: 10, width: 10, height: 5 }, vp, img, crop)).toEqual({ x: 0, y: 20, width: 10, height: 10 }); // 一部だけ範囲内
  });
  it('metaForCrop: viewport と対象位置を切り抜き後に合わせる。対応を確認できなければ null と理由', () => {
    const meta = { viewport: { width: 100, height: 50, devicePixelRatio: 2, scrollX: 0, scrollY: 0 }, targetRectAtCapture: { x: 60, y: 10, width: 10, height: 5 } };
    const crop = { x: 100, y: 0, width: 100, height: 100 };
    const m = metaForCrop(meta, crop, { width: 200, height: 100 });
    expect(m.viewport).toMatchObject({ width: 50, height: 50 });
    expect(m.targetRectAtCapture).toEqual({ x: 10, y: 10, width: 10, height: 5 });
    expect(m.cropNote).toContain('切り抜き');
    const out = metaForCrop({ ...meta, targetRectAtCapture: { x: 5, y: 5, width: 10, height: 5 } }, crop, { width: 200, height: 100 });
    expect(out.targetRectAtCapture).toBeNull();
    expect(out.targetRectNote).toContain('切り抜き範囲の外');
    const unknown = metaForCrop(meta, crop, undefined);
    expect(unknown.targetRectAtCapture).toBeNull();
    expect(unknown.viewport).toBeNull();
    expect(unknown.targetRectNote).toContain('確認できない');
    expect(metaForCrop(meta, null, undefined)).toMatchObject({ viewport: meta.viewport, targetRectAtCapture: meta.targetRectAtCapture, cropNote: null });
  });
  it('readPngSize: PNG のヘッダーから大きさを読む。PNG でなければ null', () => {
    const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(b.buffer).setUint32(16, 640); new DataView(b.buffer).setUint32(20, 480);
    expect(readPngSize(b)).toEqual({ width: 640, height: 480 });
    expect(readPngSize(new TextEncoder().encode('RENDERED:0'))).toBeNull();
  });
});

describe('画像の編集（画素計算）', () => {
  it('既存の塗りつぶし（kind 省略）は黒で不透明に塗り、領域の外は変えない', () => {
    const src = gradient(40, 30);
    const out = composeEdited(src, [{ x: 5, y: 5, width: 10, height: 10 }]);
    expect(px(out, 5, 5)).toEqual([0, 0, 0, 255]);
    expect(px(out, 14, 14)).toEqual([0, 0, 0, 255]);
    expect(px(out, 15, 15)).toEqual(px(src, 15, 15));
    expect(px(out, 4, 5)).toEqual(px(src, 4, 5));
    expect(out.width).toBe(40);
    expect(maskKindOf({ x: 0, y: 0, width: 1, height: 1 })).toBe('fill');
  });
  it('入力画像は変更しない（原本の画素を壊さない）', () => {
    const src = gradient(40, 30); const copy = new Uint8ClampedArray(src.data);
    composeEdited(src, [{ x: 0, y: 0, width: 20, height: 20, kind: 'blur' }, { x: 0, y: 0, width: 5, height: 5 }], { x: 10, y: 10, width: 20, height: 15 });
    expect(Array.from(src.data)).toEqual(Array.from(copy));
  });
  it('ぼかし: ブロックごとの平均になり、元の画素の差が失われる（多対一）', () => {
    const src = gradient(60, 40);
    const rect = { x: 10, y: 5, width: 40, height: 30 };
    const out = composeEdited(src, [{ ...rect, kind: 'blur' }]);
    // 領域内の異なる画素がほぼ均質化している（隣接画素の差が元より小さい）
    const diff = (im: RGBAImage) => { let d = 0; for (let x = rect.x; x < rect.x + rect.width - 1; x++) d += Math.abs(im.data[(20 * im.width + x) * 4] - im.data[(20 * im.width + x + 1) * 4]); return d; };
    expect(diff(out)).toBeLessThan(diff(src) / 3);
    // 領域の外は不変
    expect(px(out, 9, 5)).toEqual(px(src, 9, 5));
    expect(px(out, 50, 20)).toEqual(px(src, 50, 20));
    // 元の画素と一致する画素はほとんど残らない
    let same = 0; for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) if (px(out, x, y).join() === px(src, x, y).join()) same++;
    expect(same / (rect.width * rect.height)).toBeLessThan(0.1);
  });
  it('異なる元画像でも、ブロック平均が同じなら同じ結果になる（元の画素は復元できない）', () => {
    const a = gradient(24, 24), b = gradient(24, 24);
    // 12px ブロック内で和を保ったまま画素を入れ替える
    for (let c = 0; c < 4; c++) { const i = c, j = ((0 * 24 + 1) * 4) + c; const t = b.data[i]; b.data[i] = b.data[j]; b.data[j] = t; }
    pixelate(a, { x: 0, y: 0, width: 24, height: 24 }, 12); pixelate(b, { x: 0, y: 0, width: 24, height: 24 }, 12);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
  it('blockSizeFor: 小さな領域でも 12px 以上、大きい領域は短辺の約1/3', () => {
    expect(blockSizeFor(20, 10)).toBe(12);
    expect(blockSizeFor(300, 150)).toBe(50);
  });
  it('切り抜き: 出力は範囲の画素だけで、範囲外の画素は出力に存在しない', () => {
    const w = 60, h = 40;
    const src = gradient(w, h);
    const crop = { x: 20, y: 10, width: 25, height: 15 };
    const out = composeEdited(src, [], crop);
    expect([out.width, out.height]).toEqual([25, 15]);
    expect(out.data.length).toBe(25 * 15 * 4);
    for (let y = 0; y < 15; y++) for (let x = 0; x < 25; x++) expect(px(out, x, y)).toEqual(px(src, x + 20, y + 10));
    // 範囲外の画素に特別な値を入れても、出力にその値は現れない
    const marked = gradient(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < crop.x || x >= crop.x + crop.width || y < crop.y || y >= crop.y + crop.height) { const i = (y * w + x) * 4; marked.data[i] = 250; marked.data[i + 1] = 1; marked.data[i + 2] = 251; marked.data[i + 3] = 255; }
    const out2 = composeEdited(marked, [], crop);
    for (let i = 0; i < out2.data.length; i += 4) expect(!(out2.data[i] === 250 && out2.data[i + 1] === 1 && out2.data[i + 2] === 251)).toBe(true);
  });
  it('切り抜きとマスクの併用: マスクは切り抜き後の座標へ変換され、範囲外のマスクは無視、はみ出しは切り詰め', () => {
    const src = gradient(60, 40);
    const crop = { x: 20, y: 10, width: 25, height: 15 };
    const out = composeEdited(src, [
      { x: 25, y: 12, width: 5, height: 5 },                 // 内側
      { x: 0, y: 0, width: 10, height: 10 },                 // 範囲外
      { x: 40, y: 20, width: 30, height: 30, kind: 'blur' }, // 右下にはみ出す
    ], crop);
    expect(px(out, 5, 2)).toEqual([0, 0, 0, 255]);
    expect(px(out, 9, 6)).toEqual([0, 0, 0, 255]);
    expect(px(out, 10, 7)).not.toEqual([0, 0, 0, 255]);
    expect(px(out, 0, 0)).toEqual(px(src, 20, 10));
    // 切り抜き後の領域外の画素（元画像の x=40..）で、ぼかしが範囲外の画素を読んでいない: 範囲の内側だけで平均になる
    const only = gradient(60, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) if (x >= 45 || y >= 25) { const i = (y * 60 + x) * 4; only.data[i] = 255; only.data[i + 1] = 255; only.data[i + 2] = 255; }
    const a = composeEdited(src, [{ x: 40, y: 20, width: 30, height: 30, kind: 'blur' }], crop);
    const b = composeEdited(only, [{ x: 40, y: 20, width: 30, height: 30, kind: 'blur' }], crop);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
  it('無効な切り抜き（画像全体・小さすぎる）は切り抜きなしとして扱う', () => {
    const src = gradient(40, 30);
    expect(composeEdited(src, [], { x: 0, y: 0, width: 40, height: 30 }).width).toBe(40);
    expect(composeEdited(src, [], { x: 5, y: 5, width: 2, height: 2 }).width).toBe(40);
  });
});

describe('出力 ZIP のメタ情報', () => {
  const NOW = '2026-11-16T12:00:00.000Z';
  const pngLike = (w: number, h: number) => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const dv = new DataView(b.buffer); dv.setUint32(16, w); dv.setUint32(20, h); return b; };
  it('ぼかし・切り抜きを renderImage に渡し、件数・画像サイズ・変換後の位置を steps.json に出す', async () => {
    const step = mkStep(1);
    const arts = mkArtifacts(step);
    const shot = arts.find((a) => a.type === 'screenshot')!;
    shot.masks = [{ x: 1, y: 1, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10, kind: 'blur' }];
    shot.crop = { x: 100, y: 0, width: 100, height: 100 };
    shot.cropSourceSize = { width: 200, height: 100 };
    shot.meta = { viewport: { width: 100, height: 50, devicePixelRatio: 2, scrollX: 0, scrollY: 0 }, targetRectAtCapture: { x: 60, y: 10, width: 10, height: 5 } };
    let seen: unknown[] = [];
    const r = await buildExport({ project: mkProject(), scenario: mkScenario(), steps: [step], artifacts: arts, rules: [], exportedAt: NOW, toolVersion: '0.2.0', renderImage: async (_b, masks, crop) => { seen = [masks, crop]; return pngLike(100, 100); } });
    expect(seen[1]).toEqual({ x: 100, y: 0, width: 100, height: 100 });
    expect((seen[0] as unknown[]).length).toBe(2);
    const textOf = (path: string) => r.files.find((f) => f.path === path)!.text!;
    const steps = JSON.parse(textOf('steps.json'));
    const s = steps.steps[0].artifacts.screenshot;
    expect(s).toMatchObject({ maskedRegionCount: 1, blurredRegionCount: 1, cropped: true, imageSize: { width: 100, height: 100 } });
    expect(s.viewport).toMatchObject({ width: 50, height: 50 });
    expect(s.targetRectAtCapture).toEqual({ x: 10, y: 10, width: 10, height: 5 });
    const mtext = textOf('manifest.json');
    expect(JSON.parse(mtext).redaction).toMatchObject({ maskedImageRegions: 1, blurredImageRegions: 1, croppedImages: 1 });
    expect(mtext).not.toContain('"x": 100'); // 切り抜きで除いた領域の座標を出力しない
  });
});
