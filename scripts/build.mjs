// TraceLens ビルド: (1) ページ+Service Worker (ESM)  (2) コンテンツスクリプト (単一IIFE)  (3) 再生スクリプト (単一IIFE)
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const outDir = resolve(root, e2e ? 'dist-e2e' : 'dist');

await build({
  root, configFile: false, logLevel: 'warn', base: './', publicDir: false, esbuild: { charset: 'ascii' },
  plugins: [react()],
  build: {
    outDir, emptyOutDir: true, target: 'chrome116', minify: false, sourcemap: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(root, 'sidepanel.html'),
        review: resolve(root, 'review.html'),
        background: resolve(root, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

await build({
  root, configFile: false, logLevel: 'warn', publicDir: false, esbuild: { charset: 'ascii' },
  build: {
    outDir, emptyOutDir: false, target: 'chrome116', minify: false,
    lib: { entry: resolve(root, 'src/content/index.ts'), formats: ['iife'], name: 'TraceLensContent', fileName: () => 'content.js' },
  },
});

// 再生スクリプト（単一IIFE。再生対象タブにだけ都度注入する。マニフェストには登録しない）
await build({
  root, configFile: false, logLevel: 'warn', publicDir: false, esbuild: { charset: 'ascii' },
  build: {
    outDir, emptyOutDir: false, target: 'chrome116', minify: false,
    lib: { entry: resolve(root, 'src/replay/index.ts'), formats: ['iife'], name: 'TraceLensReplay', fileName: () => 'replay.js' },
  },
});

// 注入スクリプトに非文字（U+FFFE / U+FFFF など）が入ると Chrome が「UTF-8 でない」として読み込みを拒否するため検査する
for (const f of ['content.js', 'replay.js']) {
  const s = readFileSync(resolve(outDir, f), 'utf8');
  if (/[￾￿﷐-﷯]/.test(s)) throw new Error(`${f} に非文字が含まれている`);
}

const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.base.json'), 'utf8'));
if (e2e) {
  // 自動テスト専用: ツールバーアイコンのクリック(activeTab付与)を自動化できないため、
  // テスト用ビルドに限りホスト権限を事前付与する。配布用 dist/ には含めない。
  manifest.name = 'TraceLens (E2E test build)';
  manifest.host_permissions = ['<all_urls>'];
}
writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// アイコン（外部アセットなしで生成）: 紺地に白いレンズ
function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size * 0.44, cy = size * 0.44, r = size * 0.27, w = Math.max(1.2, size * 0.09);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = y * (size * 4 + 1) + 1 + x * 4; const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const t = (x - cx) - (y - cy); const along = ((x - cx) + (y - cy)) / Math.SQRT2;
    const handle = Math.abs(t) / Math.SQRT2 < w * 0.6 && along > r && along < size * 0.52;
    const ring = Math.abs(d - r) < w / 2;
    const white = ring || handle;
    const [R, G, B] = white ? [255, 255, 255] : [36, 59, 83];
    raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync(resolve(outDir, 'icons'), { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(resolve(outDir, `icons/icon${s}.png`), icon(s));
console.log(`[tracelens] built -> ${outDir}${e2e ? ' (E2E test build: host_permissions 付き)' : ''}`);
