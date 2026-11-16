// 配布用ビルド(dist: ホスト権限なし)で、実際の権限フローを確認する。
// 仮想ディスプレイ(Xvfb)上の実ウィンドウに対し、XTest でツールバーとショートカットを実操作する。
//  - ツールバーの拡張メニュー → TraceLens をクリック → サイドパネルが開き、activeTab が付与される
//  - 同一オリジン内の遷移では権限が維持され、別オリジンへ遷移すると失効する（失効は明示される）
//  - ショートカット(Alt+Shift+S)で再許可すると記録が継続する
// 座標はこの検証環境（Chromium のウィンドウ 1200x900, 英語UI）に合わせた固定値。
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'tests/e2e/.out-real');
const ext = resolve(root, 'dist');
const PORT = 4392, DISPLAY = ':96';
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, name, ok, detail = '') => { results.push({ id, name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? `  — ${detail}` : ''}`); };

const server = spawn(process.execPath, [resolve(root, 'mock-site/server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1700x1000x24'], { stdio: 'ignore' });
await sleep(1200);
process.env.DISPLAY = DISPLAY;
const X = (...a) => execFileSync('python3', [resolve(root, 'tests/e2e/xinput.py'), ...a.map(String)], { env: { ...process.env, DISPLAY } });
const xshot = (n) => execFileSync('import', ['-window', 'root', resolve(out, `${n}.png`)], { env: { ...process.env, DISPLAY } });

const ctx = await chromium.launchPersistentContext(resolve(out, 'profile'), {
  channel: 'chromium', headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--window-position=0,0', '--window-size=1200,900', '--disable-features=Translate'],
});
let ua = '';
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  check('P00', '配布用ビルドはホスト権限を要求していない', !manifest.host_permissions && JSON.stringify(manifest.permissions) === JSON.stringify(['activeTab', 'scripting', 'sidePanel', 'storage', 'unlimitedStorage']), JSON.stringify(manifest.permissions));
  const page = ctx.pages()[0];
  await page.goto(`http://127.0.0.1:${PORT}/login.html`);
  ua = await page.evaluate(() => navigator.userAgent);
  await sleep(1000);
  const tabs = () => sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url ?? null })));
  const panels = () => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length);
  const state = () => sw.evaluate(async () => (await chrome.storage.session.get('tracelens.activeSession'))['tracelens.activeSession'] ?? null);
  const dump = () => sw.evaluate(async () => {
    const d = await new Promise((res, rej) => { const r = indexedDB.open('tracelens'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = (s) => new Promise((res) => { const r = d.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
    const steps = (await all('steps')).sort((a, b) => a.seq - b.seq);
    d.close();
    return steps.map((s) => ({ seq: s.seq, kind: s.kind, shot: s.screenshot.status, shotReason: s.screenshot.reason, dom: s.dom.status, notice: s.notice?.code, url: s.page.url, text: s.value?.text }));
  });

  check('P01', 'アイコンをクリックする前は、拡張からタブのURLが見えず、サイドパネルも開いていない', (await tabs())[0].url === null && (await panels()) === 0, JSON.stringify(await tabs()));

  // ツールバーの拡張メニュー → TraceLens を実クリック
  X('click', 1087, 63); await sleep(900);
  xshot('1-extensions-menu');
  X('click', 875, 224); await sleep(2000);
  xshot('2-sidepanel-open');
  check('P02', 'アイコンのクリックでサイドパネルが開く', (await panels()) === 1, `SIDE_PANEL contexts=${await panels()}`);
  check('P03', 'アイコンのクリックで、表示中のタブへのアクセス(activeTab)が付与される', /login\.html/.test((await tabs())[0].url ?? ''), JSON.stringify(await tabs()));

  // サイドパネル内のUIを操作（Playwright から見えない場合は別ウィンドウのパネルで代替）
  let panel = ctx.pages().find((p) => p.url().includes('sidepanel.html'));
  let panelMode = 'side-panel';
  if (!panel) {
    panelMode = 'popup-fallback';
    const pp = ctx.waitForEvent('page');
    const tabId = (await tabs())[0].id;
    await sw.evaluate((id) => chrome.windows.create({ url: `sidepanel.html?tabId=${id}`, type: 'popup', left: 1210, top: 0, width: 460, height: 950, focused: false }), tabId);
    panel = await pp;
  }
  console.log('panel mode:', panelMode);
  await panel.waitForSelector('[data-testid="btn-start"]');
  await panel.click('[data-testid="new-project"]');
  await panel.fill('[data-testid="create-name"]', '権限確認');
  await panel.click('[data-testid="create-ok"]');
  await panel.click('[data-testid="new-scenario"]');
  await panel.fill('[data-testid="create-name"]', 'activeTab の確認');
  await panel.click('[data-testid="create-ok"]');
  await panel.waitForFunction(() => document.querySelector('[data-testid="scenario-select"]').value !== '');
  await panel.click('[data-testid="btn-start"]');
  await panel.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === '記録中', null, { timeout: 8000 });
  await sleep(1800);
  let steps = await dump();
  check('P04', `activeTab だけで記録を開始でき、開始時の画面とDOMを取得できる（パネル: ${panelMode}）`, steps[0]?.kind === 'session-start' && steps[0].shot === 'captured' && steps[0].dom === 'captured', JSON.stringify(steps[0]));
  xshot('3-recording');

  // 同一オリジン内の遷移
  await page.click('#userId'); await page.keyboard.type('E777', { delay: 40 });
  await page.click('#login'); await page.waitForURL(/index\.html/);
  await sleep(2200);
  steps = await dump();
  const nav = steps.find((s) => s.kind === 'navigation');
  check('P05', '同一オリジン内のページ遷移では権限が維持され、遷移後も操作・画面・DOMを記録できる', steps.some((s) => s.kind === 'input' && s.text === 'E777') && nav?.shot === 'captured' && nav.dom === 'captured' && !(await state()).needsPermission, JSON.stringify(steps.map((s) => [s.kind, s.shot])));

  // 別オリジンへ遷移（127.0.0.1 → localhost）
  const n0 = steps.length;
  await page.goto(`http://localhost:${PORT}/index.html`);
  await sleep(2000);
  await page.click('#add-row');
  await sleep(1200);
  steps = await dump();
  const added = steps.slice(n0);
  const st = await state();
  check('P06', '別オリジンへ遷移すると権限が失効し、取得失敗の通知として明示される（黙って記録が欠けない）', added.length === 1 && added[0].kind === 'notice' && added[0].notice === 'no-permission' && added[0].dom === 'failed' && !!st.needsPermission, JSON.stringify(added));
  const warn = await panel.locator('[data-testid="needs-permission"]').count();
  check('P07', '失効中であることが記録パネルに表示される', warn === 1, '');
  xshot('4-permission-lost');

  // ショートカットで再許可（ポインターをページ上に置いてキー入力）
  X('click', 400, 600); await sleep(300);
  const n1 = (await dump()).length; // ページ上のクリックは権限失効中のため記録されない
  X('key', 'alt+shift+s'); await sleep(3500);
  steps = await dump();
  const re = steps.slice(n1);
  check('P08', 'ショートカット(Alt+Shift+S)で再許可され、記録が継続し、画面を保存できる', !(await state()).needsPermission && re.some((s) => s.kind === 'navigation' && /localhost/.test(s.url)) && re.some((s) => s.kind === 'manual-capture' && s.shot === 'captured' && s.dom === 'captured'), JSON.stringify(re.map((s) => [s.kind, s.shot, s.dom])));
  await page.click('#add-row'); await sleep(1500);
  steps = await dump();
  check('P09', '再許可後は操作が再び記録される', steps.at(-1).kind === 'click' && steps.at(-1).shot === 'captured', JSON.stringify(steps.at(-1)));

  await panel.click('[data-testid="btn-stop"]');
  await panel.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === '待機中');
  steps = await dump();
  check('P10', '終了時の画面とDOMが保存される', steps.at(-1).kind === 'session-end' && steps.at(-1).shot === 'captured', JSON.stringify(steps.at(-1)));
  xshot('5-finished');
} catch (e) {
  try { xshot('error'); } catch { /* ignore */ }
  check('PZZ', 'スクリプトが最後まで実行される', false, e?.stack ?? String(e));
} finally {
  await ctx.close().catch(() => {});
  xvfb.kill(); server.kill();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(resolve(out, 'results.json'), JSON.stringify({ browser: ua, ranAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed  (browser: ${ua})`);
process.exit(failed.length ? 1 : 0);
