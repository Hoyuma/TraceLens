// 模擬業務ページ用の最小静的サーバー（TraceLens 本体とは独立）
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// 申請画面への遷移の連鎖（302 リダイレクト → フォームの自動送信（POST）→ 使い捨てトークンつきの画面）。
// 途中の URL を GET で開き直すと、トークンが無効・POST でないため申請画面にならない（実在の業務システムでよくある作り）。
const tokens = new Set();
const newToken = () => Math.random().toString(36).slice(2, 10);
const html = (res, body, status = 200) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
const invalidPage = (why) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>エラー</title><link rel="stylesheet" href="/style.css"></head><body><main class="card"><h1>画面遷移が不正です</h1><p id="flow-error">${why}</p></main></body></html>`;

async function flow(req, res, url) {
  if (url.pathname === '/flow/start') {
    const mark = newToken(); tokens.add(`mark:${mark}`);
    res.writeHead(302, { location: `/flow/switch?mark=${mark}`, 'cache-control': 'no-store' }).end();
    return true;
  }
  if (url.pathname === '/flow/switch') {
    const mark = url.searchParams.get('mark') ?? '';
    if (!tokens.delete(`mark:${mark}`)) { html(res, invalidPage('この画面は直接開けません（mark が無効）'), 400); return true; }
    const tok = newToken(); tokens.add(`tok:${tok}`);
    html(res, `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>切り替え中</title></head><body><form id="switchForm" method="POST" action="/flow/form?mark=${mark}&amp;tok=${tok}"><input type="hidden" name="flow" value="apply"></form><script>setTimeout(() => document.getElementById('switchForm').submit(), 150);</script></body></html>`);
    return true;
  }
  if (url.pathname === '/flow/form') {
    const tok = url.searchParams.get('tok') ?? '';
    if (req.method !== 'POST') { html(res, invalidPage('この画面は直接開けません（POST ではない）'), 405); return true; }
    if (!tokens.delete(`tok:${tok}`)) { html(res, invalidPage('この画面は直接開けません（トークンが無効または使用済み）'), 400); return true; }
    html(res, await readFile(join(dir, 'flow-form.html')));
    return true;
  }
  return false;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/flow/')) { req.resume(); if (await flow(req, res, url)) return; }
  const path = decodeURIComponent(url.pathname);
  const file = normalize(join(dir, path === '/' ? 'index.html' : path));
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`模擬業務ページ: http://127.0.0.1:${port}/login.html`));
