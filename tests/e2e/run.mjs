// TraceLens E2E 検証: 実際の Chromium に拡張を読み込み、模擬業務ページで
// 「記録 → レビュー → ZIP出力」を通しで確認する。
//
// 注意: ツールバーアイコンのクリック(activeTab 付与)は自動化できないため、このスクリプトは
// host_permissions を事前付与したテスト用ビルド(dist-e2e)を使い、記録パネルはサイドパネルではなく
// 別ウィンドウ(sidepanel.html?tabId=…)として開く。配布用ビルドの権限フローは real-permissions.mjs で別途確認する。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'tests/e2e/.out');
const ext = resolve(root, 'dist-e2e');
const PORT = 4391;
const DEBUG_PORT = 9377;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'S3cret!Pass-7731';
const MEMO = '設計レビュー対応';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [resolve(root, 'mock-site/server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await sleep(600);

const userDataDir = resolve(out, 'profile');
const launch = () => chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium', headless: true, locale: 'ja-JP', viewport: { width: 1100, height: 760 }, acceptDownloads: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--remote-debugging-port=${DEBUG_PORT}`],
});

async function getSw(context) { return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')); }
/** 拡張ページ上で IndexedDB の全件を読む（Blob はサイズだけに置き換える） */
async function dump(extPage) {
  return extPage.evaluate(async () => {
    const d = await new Promise((res, rej) => { const r = indexedDB.open('tracelens'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = (s) => new Promise((res, rej) => { const r = d.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const o = { projects: await all('projects'), scenarios: await all('scenarios'), steps: await all('steps'), artifacts: await all('artifacts') };
    for (const a of o.artifacts) if (a.blob) { a.blobSize = a.blob.size; delete a.blob; }
    d.close();
    o.steps.sort((a, b) => a.seq - b.seq);
    return o;
  });
}
const kinds = (steps) => steps.map((s) => s.kind);

let diag = async () => {};
let context = await launch();
let browserVersion = context.browser()?.version() ?? '';
try {
  let sw = await getSw(context);
  const extId = new URL(sw.url()).host;
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${BASE}/login.html`);
  browserVersion = await page.evaluate(() => navigator.userAgent);

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('login.html')).id);
  const panelP = context.waitForEvent('page');
  await sw.evaluate((id) => chrome.windows.create({ url: `sidepanel.html?tabId=${id}`, type: 'popup', width: 420, height: 960, focused: false }), tabId);
  const panel = await panelP;
  panel.on('console', (m) => { if (m.type() === 'error') console.log('[panel console]', m.text()); });
  panel.on('pageerror', (e) => console.log('[panel error]', String(e)));
  sw.on('console', (m) => console.log('[sw console]', m.text()));
  diag = async () => console.log('[panel text]', (await panel.locator('body').innerText().catch(() => '')).slice(0, 600));
  await panel.waitForSelector('[data-testid="btn-start"]');

  // --- 2. プロジェクトとシナリオの作成 ---
  await panel.click('[data-testid="new-project"]');
  await panel.fill('[data-testid="create-name"]', '勤怠システム刷新調査');
  await panel.fill('[data-testid="create-desc"]', 'テスト環境での登録手順の調査');
  await panel.click('[data-testid="create-ok"]');
  await panel.click('[data-testid="new-scenario"]');
  await panel.fill('[data-testid="create-name"]', '工数の登録');
  await panel.fill('[data-testid="create-desc"]', '工数登録の画面構造と手順を把握する');
  await panel.click('[data-testid="create-ok"]');
  await panel.waitForFunction(() => document.querySelector('[data-testid="scenario-select"]').value !== '');

  // --- 3. 記録開始 ---
  await panel.click('[data-testid="btn-start"]');
  await panel.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === '記録中');
  await sleep(1500);
  let db = await dump(panel);
  check('A01', '記録開始でセッション開始ステップと開始時の画面・DOMが保存される', db.steps.length === 1 && db.steps[0].kind === 'session-start' && db.steps[0].screenshot.status === 'captured' && db.steps[0].dom.status === 'captured', JSON.stringify(db.steps.map((s) => [s.kind, s.screenshot.status, s.dom.status])));

  // --- 4. ログイン（パスワード欄） → ページ遷移 ---
  await page.bringToFront();
  await page.click('#userId');
  await page.keyboard.type('E12345', { delay: 30 });
  await page.click('#password');
  await page.keyboard.type(PASSWORD, { delay: 20 });
  await sleep(300);
  await page.click('#login');
  await page.waitForURL(/index\.html/);
  await sleep(1800);
  db = await dump(panel);
  check('A02', '入力は欄ごとに1ステップへ集約される（1文字ずつにならない）', JSON.stringify(kinds(db.steps)) === JSON.stringify(['session-start', 'input', 'input', 'click', 'navigation']), kinds(db.steps).join(','));
  check('A03', '入力値と編集回数が記録される', db.steps[1].value?.text === 'E12345' && db.steps[1].value?.editCount === 6, JSON.stringify(db.steps[1].value));
  check('A04', 'パスワード欄は redacted として記録される', db.steps[2].value?.redacted === true && db.steps[2].value?.text === undefined, JSON.stringify(db.steps[2].value));
  const nav = db.steps[4];
  check('A05', 'ページ遷移後も記録が継続し、遷移ステップに遷移元・遷移先が残る', nav.kind === 'navigation' && /login\.html/.test(nav.navigation.fromUrl) && /index\.html/.test(nav.navigation.toUrl) && nav.dom.status === 'captured' && nav.screenshot.status === 'captured', JSON.stringify([nav.navigation, nav.dom.status, nav.screenshot]));
  check('A06', '遷移を起こしたクリックは「操作後の画面なし」を理由付きで残す（遷移後の画面を流用しない）', db.steps[3].screenshot.status === 'skipped' && !!db.steps[3].screenshot.reason, JSON.stringify(db.steps[3].screenshot));

  // --- 5. 業務操作: 対象日・PJ・工程・工数・IME入力 ---
  const base0 = db.steps.length;
  await page.focus('#workDate');
  await page.keyboard.type('11162026', { delay: 40 }); // ヘッドレスChromiumの日付欄は mm/dd/yyyy の順
  await sleep(900);
  const pj = page.locator('.entry-row select[name="pj"]').first();
  await pj.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown'); // P002
  await sleep(1500); // 工程候補は遅れて更新される
  const st = page.locator('.entry-row select[name="step"]').first();
  await st.focus();
  await page.keyboard.press('ArrowDown'); // 5000
  await sleep(700);
  await page.locator('.entry-row input[name="hours"]').first().click();
  await page.keyboard.type('1.5', { delay: 40 });
  await sleep(200);
  // 日本語IME入力を CDP で再現（変換途中の composition を複数回発生させてから確定）
  await page.locator('.entry-row input[name="memo"]').first().click();
  const cdp = await context.newCDPSession(page);
  for (const t of ['せ', 'せっ', 'せっけ', 'せっけい', '設計']) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(40); }
  await cdp.send('Input.insertText', { text: '設計' });
  for (const t of ['れ', 'れび', 'れびゅ', 'れびゅー', 'レビュー']) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(40); }
  await cdp.send('Input.insertText', { text: 'レビュー' });
  for (const t of ['た', 'たい', 'たいお', 'たいおう', '対応']) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(40); }
  await cdp.send('Input.insertText', { text: '対応' });
  await sleep(300);
  await page.click('#save');
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('保存しました'));
  await sleep(1800);
  db = await dump(panel);
  const seg = db.steps.slice(base0);
  const segKinds = kinds(seg);
  check('B01', '操作の順序と種別が正しい（日付入力→PJ選択→工程選択→工数入力→メモ入力→保存クリック）', JSON.stringify(segKinds) === JSON.stringify(['input', 'select', 'select', 'select', 'input', 'input', 'click']), segKinds.join(','));
  const selPj = seg.filter((s) => s.kind === 'select' && s.target?.name === 'pj').at(-1);
  const selStep = seg.find((s) => s.kind === 'select' && s.target?.name === 'step');
  check('B02', 'select の選択値・表示ラベル・その時点の候補一覧が記録される', selPj?.value?.selectedOptions?.[0]?.value === 'P002' && selStep?.value?.selectedOptions?.[0]?.value === '5000' && selStep.value.availableOptions.some((o) => o.value === '5100'), JSON.stringify([selPj?.value?.selectedOptions, selStep?.value?.selectedOptions]));
  const memo = seg.find((s) => s.kind === 'input' && s.target?.name === 'memo');
  check('B03', '日本語IME入力が細分化されず1ステップになる', seg.filter((s) => s.target?.name === 'memo').length === 1 && memo?.value?.text === MEMO && memo.value.usedIme === true, JSON.stringify(memo?.value));
  const hours = seg.find((s) => s.target?.name === 'hours');
  check('B04', '対象要素の情報（name・aria-label由来の名前候補・セレクター候補と一致件数）が記録される', hours?.target?.nameCandidates?.some((n) => n.source === 'aria-label' && n.value === '工数') && hours.target.selectors.every((c) => typeof c.matchCount === 'number') && hours.target.selectors.some((c) => c.kind === 'name' && c.matchCount === 1), JSON.stringify(hours?.target?.selectors?.map((c) => [c.kind, c.matchCount, c.stability])));
  check('B05', '動的に見えるID・位置依存セレクターは安定と断定せず suspect と記録される', seg.some((s) => s.target?.selectors?.some((c) => c.kind === 'css-path' && c.stability === 'suspect')) && hours.target.nameMethodNote.includes('完全な Accessible Name 計算の結果ではない'), '');
  const save = seg.at(-1);
  const live = save.observations.filter((o) => o.type === 'live-region').map((o) => o.text);
  check('B06', '保存クリック後の画面変化（通知領域の表示）が観測として記録される', live.some((t) => t.startsWith('保存しました')), JSON.stringify(save.observations.map((o) => o.type + ':' + (o.text ?? o.reason ?? ''))));
  const saveShot = db.artifacts.find((a) => a.id === save.screenshot.artifactId);
  check('B07', '操作時刻と画像取得時刻が別々に保存され、画像は操作より後に取得されている', !!saveShot && saveShot.capturedAt !== save.operationAt && new Date(saveShot.capturedAt) > new Date(save.operationAt) && saveShot.phase === 'after-operation', `${save.operationAt} / ${saveShot?.capturedAt}`);
  check('B08', '操作位置は取得直前に再計測した矩形として保存される', !!saveShot?.meta?.targetRectAtCapture && saveShot.meta.targetRectAtCapture.width > 0, JSON.stringify(saveShot?.meta?.targetRectAtCapture));
  const dateStep = seg[0];
  const domArt = db.artifacts.find((a) => a.id === save.dom.artifactId);
  check('B09', '操作時点のDOMと、HTMLに残らないフォーム値(formState)が保存される', domArt?.html.includes('id="save"') && domArt.formState.some((f) => f.name === 'hours' && f.value === '1.5') && domArt.formState.some((f) => f.name === 'pj' && f.value === 'P002') && !domArt.html.includes('const MASTER'), `formState=${domArt?.formState?.length}`);
  check('B10', '日付入力も1ステップに集約される', dateStep.kind === 'input' && dateStep.value?.text === '2026-11-16', JSON.stringify(dateStep.value));

  // --- 6. 一時停止中は記録しない ---
  const n1 = db.steps.length;
  await panel.click('[data-testid="btn-pause"]');
  await panel.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === '一時停止中');
  await page.click('#add-row');
  await page.locator('.entry-row input[name="memo"]').last().click();
  await page.keyboard.type('paused-typing');
  await page.keyboard.press('Tab');
  await sleep(800);
  db = await dump(panel);
  check('C01', '一時停止中の操作は記録されない', db.steps.length === n1 && !JSON.stringify(db).includes('paused-typing'), `${n1} -> ${db.steps.length}`);
  await panel.click('[data-testid="btn-resume"]');
  await panel.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === '記録中');
  await sleep(300);

  // --- 7. Service Worker を強制停止しても記録が継続する ---
  let swStopped = false;
  try {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const t = targets.find((x) => x.type === 'service_worker' && x.url.includes(extId));
    const ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const closed = new Promise((r) => sw.once('close', () => r(true)));
    ws.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: t.id } }));
    swStopped = await Promise.race([closed, sleep(2500).then(() => false)]);
    const after = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    console.log('SW target after closeTarget:', after.filter((x) => x.type === 'service_worker').length, 'playwright close event:', swStopped);
    if (!after.some((x) => x.type === 'service_worker' && x.url.includes(extId))) swStopped = true;
    ws.close();
  } catch (e) { console.log('SW stop not available:', e?.stack ?? String(e)); }
  await page.locator('.entry-row input[name="hours"]').last().click();
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await sleep(1500);
  db = await dump(panel);
  const afterSw = db.steps.slice(n1);
  check('C02', `Service Worker 停止後も記録が継続し、既存の記録も残る（SW停止を${swStopped ? '確認' : '確認できず'}）`, swStopped && afterSw.some((s) => s.kind === 'input' && s.value?.text === '2') && db.steps.length > n1 && db.steps[0].kind === 'session-start', kinds(afterSw).join(','));
  check('C03', 'Enter キーが、直前の入力の確定後にキー操作として記録される', JSON.stringify(kinds(afterSw)) === JSON.stringify(['input', 'key']) && afterSw[1].key?.key === 'Enter', kinds(afterSw).join(','));
  sw = await getSw(context);

  // --- 8. 必須入力エラー（2行目の未入力） ---
  await page.click('#save');
  await sleep(1500);
  db = await dump(panel);
  const errStep = db.steps.at(-1);
  check('C04', '必須入力エラーの表示が alert の観測として記録される', errStep.kind === 'click' && errStep.observations.some((o) => o.type === 'live-region' && o.role === 'alert' && o.text.includes('必須')), JSON.stringify(errStep.observations.filter((o) => o.type === 'live-region')));

  // --- 9. iframe / Shadow DOM ---
  await page.frameLocator('iframe').locator('#ack').click();
  await sleep(1200);
  await page.locator('help-tip').locator('#help-btn').click();
  await sleep(1200);
  db = await dump(panel);
  const frameStep = db.steps.find((s) => s.target?.id === 'ack');
  const shadowStep = db.steps.find((s) => s.target?.id === 'help-btn');
  check('D01', 'iframe 内の操作がフレーム経路つきで記録される', !!frameStep && frameStep.frame.isTop === false && frameStep.frame.path.length === 1 && frameStep.frame.path[0].crossOrigin === false && /iframe/.test(frameStep.frame.path[0].selector), JSON.stringify(frameStep?.frame));
  check('D02', 'open Shadow DOM 内の操作が Shadow 経路つきで記録される', !!shadowStep && shadowStep.target.shadowPath.length === 1 && /help-tip/.test(shadowStep.target.shadowPath[0].hostSelector) && shadowStep.target.selectors.some((c) => c.scope === 'shadow-root'), JSON.stringify(shadowStep?.target?.shadowPath));
  const frameShot = db.artifacts.find((a) => a.id === frameStep?.screenshot.artifactId);
  check('D03', '同一オリジン iframe 内の要素位置はトップ基準へ換算される', !!frameShot?.meta?.targetRectAtCapture && frameShot.meta.targetRectAtCapture.y > 200, JSON.stringify(frameShot?.meta?.targetRectAtCapture));

  // --- 10. SPA 内の URL 変更・再読込 ---
  await page.click('#nav-list');
  await sleep(1500);
  await page.reload();
  await sleep(1800);
  db = await dump(panel);
  const spa = db.steps.find((s) => s.kind === 'spa-navigation');
  const rl = db.steps.find((s) => s.kind === 'reload');
  check('E01', 'SPA 内の URL 変更が記録される', !!spa && /view=list/.test(spa.navigation.toUrl) && db.steps[db.steps.indexOf(spa) - 1].kind === 'click', JSON.stringify(spa?.navigation));
  check('E02', '再読込が reload として記録され、その後も記録が継続する', !!rl && rl.dom.status === 'captured' && rl.screenshot.status === 'captured', JSON.stringify(rl && [rl.navigation, rl.screenshot.status]));
  check('E03', '再表示後の一覧に登録値が保持されていることが DOM で確認できる', db.artifacts.find((a) => a.id === rl?.dom.artifactId)?.html.includes('5000'), '');

  // --- 11. 手動の画面保存 / 要素を選んで注記 ---
  await panel.click('[data-testid="btn-capture"]');
  await sleep(1500);
  db = await dump(panel);
  const manual = db.steps.at(-1);
  check('F01', '「画面を保存」で手動保存ステップ（画面・DOM）が追加される', manual.kind === 'manual-capture' && manual.screenshot.status === 'captured' && manual.dom.status === 'captured' && db.artifacts.find((a) => a.id === manual.screenshot.artifactId)?.phase === 'manual', JSON.stringify([manual.kind, manual.screenshot, manual.dom.status]));

  await panel.click('[data-testid="btn-picker"]');
  await sleep(500);
  await page.keyboard.press('Escape');
  await sleep(500);
  const pickerOff = await panel.locator('[data-testid="btn-picker"]').textContent();
  const nBeforePick = (await dump(panel)).steps.length;
  check('F02', '要素選択モードは Esc でキャンセルでき、ステップは追加されない', pickerOff === '要素を選んで注記' && nBeforePick === db.steps.length, pickerOff);
  await panel.click('[data-testid="btn-picker"]');
  await sleep(500);
  await page.click('#clear-all'); // 通常クリックなら登録データが消えるボタン
  await sleep(1500);
  db = await dump(panel);
  const note = db.steps.at(-1);
  const stillThere = await page.evaluate(() => localStorage.getItem('mock-kintai-entries'));
  check('F03', '要素選択モードのクリックは要素注記として記録され、ページ側の処理（データ消去）は起きない', note.kind === 'element-note' && note.target?.id === 'clear-all' && !!stillThere && db.steps.filter((s) => s.kind === 'click' && s.target?.id === 'clear-all').length === 0, JSON.stringify([note.kind, note.target?.id, !!stillThere]));
  const noteDom = db.artifacts.find((a) => a.id === note.dom.artifactId);
  check('F04', 'TraceLens 自身のオーバーレイは DOM 記録に含まれない', !!noteDom && !noteDom.html.includes('tracelens-overlay'), '');

  // --- 12. 対象外タブ・非アクティブ時 ---
  const nBeforeOther = db.steps.length;
  const other = await context.newPage();
  await other.goto(`${BASE}/index.html`);
  await other.click('#add-row');
  await other.locator('.entry-row input[name="memo"]').first().click();
  await other.keyboard.type('other-tab-secret');
  await other.keyboard.press('Tab');
  await sleep(1000);
  db = await dump(panel);
  const otherSteps = db.steps.slice(nBeforeOther);
  check('G01', '対象外タブでの操作は記録されない（新規タブが開いた通知のみ）', !JSON.stringify(db).includes('other-tab-secret') && otherSteps.every((s) => s.kind === 'notice'), kinds(otherSteps).join(',') || '(なし)');
  // 対象タブが背面にある状態で画面保存 → 別タブの画像を混ぜず、失敗として残す
  await panel.click('[data-testid="btn-capture"]');
  await sleep(1500);
  db = await dump(panel);
  const bg = db.steps.at(-1);
  check('G02', '対象タブが非アクティブのときは別タブの画像を保存せず、理由付きの取得失敗になる', bg.kind === 'manual-capture' && bg.screenshot.status === 'failed' && bg.screenshot.reasonCode === 'tab-inactive' && !db.artifacts.some((a) => a.stepId === bg.id && a.type === 'screenshot'), JSON.stringify(bg.screenshot));
  await other.close();
  await page.bringToFront();
  await sleep(400);

  // --- 13. 記録できないページ（ブラウザ内部ページ） ---
  await page.goto('chrome://version/');
  await sleep(1500);
  db = await dump(panel);
  const notice = db.steps.filter((s) => s.kind === 'notice').at(-1);
  const needs = await panel.locator('[data-testid="needs-permission"]').count();
  check('G03', 'ブラウザ内部ページへの遷移は取得失敗として明示される（空の成功データにしない）', notice?.notice?.code === 'restricted-page' && notice.dom.status === 'failed' && !!notice.dom.reason && needs === 1, JSON.stringify(notice?.notice));
  await page.goto(`${BASE}/index.html?view=list`);
  await sleep(1800);
  db = await dump(panel);
  check('G04', '記録可能なページへ戻ると記録が再開される', db.steps.at(-1).kind === 'navigation' && (await panel.locator('[data-testid="needs-permission"]').count()) === 0, db.steps.at(-1).kind);

  // --- 14. 記録パネルから直前の操作へメモ ---
  await panel.fill('[data-testid="f-purpose"]', '登録済みデータの再表示を確認する');
  await sleep(700);
  await panel.screenshot({ path: resolve(out, 'panel-recording.png') });

  // --- 15. 終了 ---
  await panel.click('[data-testid="btn-stop"]');
  await panel.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === '待機中');
  await sleep(500);
  db = await dump(panel);
  const end = db.steps.at(-1);
  check('H01', '終了時に最終状態（画面・DOM）が保存され、セッションが終了状態になる', end.kind === 'session-end' && end.screenshot.status === 'captured' && end.dom.status === 'captured' && db.scenarios[0].sessions[0].status === 'ended', JSON.stringify([end.kind, end.screenshot.status, db.scenarios[0].sessions[0].status]));
  check('H02', '取得待ちのまま残った成果物がない（すべて取得済みか理由付き）', db.steps.every((s) => s.screenshot.status !== 'pending' && s.dom.status !== 'pending' && (['captured', 'not-applicable'].includes(s.screenshot.status) || !!s.screenshot.reason)), JSON.stringify(db.steps.filter((s) => s.screenshot.status === 'pending' || s.dom.status === 'pending').map((s) => s.seq)));
  check('H03', 'seq が欠番・重複なく操作順に振られている', db.steps.every((s, i) => s.seq === i + 1), '');
  check('H04', 'パネルで書いたメモが保存されている', db.steps.some((s) => s.annotation.purpose === '登録済みデータの再表示を確認する'), '');
  const nAfterStop = db.steps.length;
  await page.click('#nav-entry');
  await sleep(800);
  check('H05', '終了後の操作は記録されない', (await dump(panel)).steps.length === nAfterStop, '');
  check('H06', '環境情報（ブラウザ・拡張バージョン）がセッションに保存される', /Chrom/.test(db.scenarios[0].sessions[0].environment.userAgent) && !!db.scenarios[0].sessions[0].environment.extensionVersion, JSON.stringify(db.scenarios[0].sessions[0].environment.brands));

  // --- 16. パスワードが保存データのどこにも無い ---
  const raw = JSON.stringify(db);
  const pwStep = db.steps[2];
  const loginDom = db.artifacts.filter((a) => a.type === 'dom' && a.frameUrl?.includes('login.html'));
  check('S01', 'パスワード値が保存データ（イベント・DOM・フォーム状態）に含まれない', !raw.includes(PASSWORD) && loginDom.length >= 3 && loginDom.every((a) => a.formState.find((f) => f.id === 'password')?.redacted === true && a.formState.find((f) => f.id === 'password')?.value === undefined), `login DOM snapshots=${loginDom.length}, pwStep.value=${JSON.stringify(pwStep.value)}`);
  check('S02', 'パスワード以外の入力値は記録されている（除外が過剰でない）', raw.includes('E12345') && raw.includes(MEMO), '');

  // --- 17. ブラウザを再起動しても保存済みの記録を開ける ---
  await context.close();
  context = await launch();
  sw = await getSw(context);
  const review = context.pages()[0] ?? (await context.newPage());
  await review.setViewportSize({ width: 1500, height: 900 });
  await review.goto(`chrome-extension://${extId}/review.html`);
  await review.waitForSelector('[data-testid="step-row"]');
  const rows = await review.locator('[data-testid="step-row"]').count();
  check('R01', 'ブラウザ再起動後もレビュー画面で保存済みの記録を開ける', rows === nAfterStop, `${rows} / ${nAfterStop}`);

  // --- 18. レビュー: 注記（変数・成功条件）の編集と保持 ---
  const hoursId = db.steps.find((s) => s.target?.name === 'hours' && s.value?.text === '1.5').id;
  const memoId = db.steps.find((s) => s.target?.name === 'memo' && s.value?.text === MEMO).id;
  const saveId = save.id;
  await review.click(`[data-step-id="${hoursId}"]`);
  await review.fill('[data-testid="f-purpose"]', '工数を入力する');
  await review.click('[data-testid="vk-variable"]');
  await review.fill('[data-testid="f-variable"]', '工数時間');
  await review.fill('[data-testid="f-source"]', 'タスク記録の集計工数');
  await review.fill('[data-testid="f-transform"]', '分を0.25時間単位に丸める');
  await review.click(`[data-step-id="${memoId}"]`);
  await review.click('[data-testid="vk-variable"]');
  await review.fill('[data-testid="f-variable"]', '作業メモ');
  await review.click(`[data-step-id="${saveId}"]`);
  await review.click('[data-testid="add-success"]');
  await review.fill('[data-testid="cond-success"]', '保存完了メッセージが表示される');
  await review.click('[data-testid="add-proceed"]');
  await review.fill('[data-testid="cond-proceed"]', '保存中の表示が消える');
  await review.click('[data-testid="confirm-done"]');
  await review.click('[data-testid="btn-info"]');
  await review.fill('[data-testid="sc-open"]', '月締め後の修正可否は未確認');
  await sleep(700);
  const hl = await review.locator('[data-testid="highlight"]').count();
  const shotTime = await review.locator('[data-testid="shot-time"]').textContent();
  check('R02', 'レビュー画面で操作位置の強調と、画像取得時刻・操作時刻の両方が表示される', hl === 1 && /画像の取得時刻/.test(shotTime) && /操作時刻/.test(shotTime), shotTime);
  await review.reload();
  await review.waitForSelector('[data-testid="step-row"]');
  db = await dump(review);
  const hs = db.steps.find((s) => s.id === hoursId), ss = db.steps.find((s) => s.id === saveId);
  check('R03', '変数・入力元・変換ルール・成功条件・完了確認時刻を編集して再読込後も保持される', hs.annotation.valueKind === 'variable' && hs.annotation.variableName === '工数時間' && hs.annotation.valueSource === 'タスク記録の集計工数' && hs.annotation.transformRule.includes('0.25') && ss.annotation.conditions.some((c) => c.type === 'success' && c.basis === 'human-stated' && c.text.includes('保存完了')) && ss.annotation.conditions.some((c) => c.type === 'proceed') && !!ss.humanConfirmedAt && db.scenarios[0].openQuestions.includes('月締め'), JSON.stringify([hs.annotation.variableName, ss.annotation.conditions.length, ss.humanConfirmedAt]));
  check('R04', '記録の元の順序と時刻は編集後も変わらない', db.steps.every((s, i) => s.seq === i + 1) && hs.operationAt === hours.operationAt, '');

  // 画面がない手順: 理由と「直前の記録画面」表示
  const loginClickId = db.steps[3].id;
  await review.click(`[data-step-id="${loginClickId}"]`);
  const noShot = await review.locator('[data-testid="no-shot"]').textContent();
  const fb = await review.locator('[data-testid="fallback-label"]').textContent();
  check('R05', '画面がない手順は理由を表示し、代わりの画像は「直前の記録画面」と明示して強調表示しない', /遷移/.test(noShot) && /直前の記録画面/.test(fb) && (await review.locator('[data-testid="highlight"]').count()) === 0, noShot);
  check('R06', '取得失敗のある手順と、画面を取得していない手順が一覧で区別して示される', (await review.locator('[data-testid="flag-fail"]').count()) >= 2 && (await review.locator('[data-testid="flag-skip"]').count()) >= 1, '');
  const lateShots = db.artifacts.filter((a) => a.meta?.timingNote);
  check('R07', '静止を待てずに次の操作の開始時点で取得した画像は、その旨が画像に記録される', lateShots.length >= 1 && lateShots.every((a) => a.meta.timingNote.includes('次の操作の開始時点')), `late=${lateShots.length}`);

  // --- 19. 塗りつぶし・除外・置換 → ZIP 出力 ---
  await review.click(`[data-step-id="${saveId}"]`);
  await review.waitForSelector('[data-testid="shot"] img');
  await review.click('[data-testid="btn-mask"]');
  const box = await review.locator('[data-testid="shot"]').boundingBox();
  await review.mouse.move(box.x + box.width * 0.10, box.y + box.height * 0.20);
  await review.mouse.down();
  await review.mouse.move(box.x + box.width * 0.60, box.y + box.height * 0.45, { steps: 5 });
  await review.mouse.up();
  await review.waitForSelector('[data-testid="mask"]');
  await review.click('[data-testid="btn-mask"]');
  await review.screenshot({ path: resolve(out, 'review.png') });
  // 手順の除外（ユーザーID入力）と、成果物単位の除外（手動保存の画像）
  const userStepId = db.steps[1].id;
  await review.locator(`[data-step-id="${userStepId}"] [data-testid="step-include"]`).click();
  await sleep(400);
  await review.click(`[data-step-id="${manual.id}"]`);
  await review.waitForSelector('[data-testid="shot"] img');
  await sleep(300);
  await review.locator('[data-testid="shot-include"]').click();
  await sleep(400);
  // グループ化
  review.once('dialog', (d) => d.accept('工数行の入力'));
  await review.click(`[data-step-id="${hoursId}"]`);
  await review.selectOption('[data-testid="group-select"]', '__new');
  await sleep(600);

  await review.click('[data-testid="btn-export"]');
  await review.waitForSelector('[data-testid="preview-summary"]');
  await review.click('[data-testid="rule-add"]');
  await review.locator('[data-testid="rule-find"]').last().fill(MEMO);
  await review.locator('[data-testid="rule-with"]').last().fill('{{作業メモ}}');
  await review.click('[data-testid="rule-add"]');
  await review.locator('[data-testid="rule-find"]').last().fill('5000');
  await review.locator('[data-testid="rule-with"]').last().fill('{{工程コード}}');
  await review.click('[data-testid="preview-refresh"]');
  await review.waitForSelector('[data-testid="residual-ok"]');
  await review.screenshot({ path: resolve(out, 'export-dialog.png') });
  const dl = review.waitForEvent('download');
  await review.click('[data-testid="btn-download"]');
  const download = await dl;
  const zipPath = resolve(out, 'tracelens-export.zip');
  await download.saveAs(zipPath);

  const zip = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const names = Object.keys(zip).filter((n) => !n.endsWith('/'));
  const text = (n) => strFromU8(zip[`tracelens-export/${n}`]);
  const required = ['README.md', 'scenario.md', 'input-mapping.md', 'implementation-request.md', 'manifest.json', 'steps.json'];
  check('X01', 'ZIP に必須ファイルとディレクトリが揃っている', required.every((f) => names.includes(`tracelens-export/${f}`)) && ['screenshots/', 'dom/', 'elements/'].every((d) => names.some((n) => n.startsWith(`tracelens-export/${d}`))), `${names.length} files`);
  const stepsJson = JSON.parse(text('steps.json'));
  const manifest = JSON.parse(text('manifest.json'));
  let refOk = true; const refProblems = [];
  for (const s of stepsJson.steps) {
    for (const [k, p] of [['screenshot', s.artifacts.screenshot.path], ['dom', s.artifacts.dom.path], ['formState', s.artifacts.dom.formStatePath], ['element', s.artifacts.element.path]]) {
      if (p === null) continue;
      if (!names.includes(`tracelens-export/${p}`) || !p.includes(s.id)) { refOk = false; refProblems.push(`${s.seq}:${k}`); }
    }
    if (s.artifacts.element.path && JSON.parse(text(s.artifacts.element.path)).stepId !== s.id) { refOk = false; refProblems.push(`${s.seq}:element-id`); }
    if (s.artifacts.dom.path && !text(s.artifacts.dom.path).includes(`stepId=${s.id}`)) { refOk = false; refProblems.push(`${s.seq}:dom-id`); }
  }
  const artifactFiles = names.filter((n) => /\/(screenshots|dom|elements)\//.test(n));
  const orphan = artifactFiles.filter((n) => !stepsJson.steps.some((s) => n.includes(s.id)));
  check('X02', '画像・DOM・要素・手順がステップIDで対応し、参照切れ・孤立ファイルがない', refOk && orphan.length === 0 && manifest.schemaVersion === 1 && manifest.steps.length === stepsJson.steps.length, JSON.stringify([refProblems, orphan]));
  const scenarioMd = text('scenario.md');
  check('X03', 'scenario.md に各手順がステップIDつきで載り、未記入・根拠区分が明示される', stepsJson.steps.every((s) => scenarioMd.includes(`\`${s.id}\``)) && scenarioMd.includes('（未記入）') && scenarioMd.includes('[人間が記入した条件] 保存完了メッセージが表示される') && scenarioMd.includes('グループ: 工数行の入力'), '');
  check('X04', 'input-mapping.md に変数・入力元・変換ルールが載る', /工数時間/.test(text('input-mapping.md')) && /タスク記録の集計工数/.test(text('input-mapping.md')) && /未指定（未確認）/.test(text('input-mapping.md')), '');
  const req = text('implementation-request.md');
  check('X05', 'implementation-request.md に6つの実装方針が含まれる', ['既存実装を確認してから変更する', 'ハードコードしない', '状態条件で待機', '開発指示とは扱わない', '推測で確定しない', '重複登録を防ぐ'].every((k) => req.includes(k)), '');
  const allText = names.filter((n) => !n.endsWith('.png')).map((n) => strFromU8(zip[n])).join('\n');
  check('X06', '置換した値が Markdown・JSON・DOM のどこにも残らず、置換後の文字列に統一されている', !allText.includes(MEMO) && !allText.includes('5000') && scenarioMd.includes('{{作業メモ}}') && text('steps.json').includes('{{作業メモ}}') && names.filter((n) => n.endsWith('.html')).some((n) => strFromU8(zip[n]).includes('{{工程コード}}')), JSON.stringify({ memo: allText.includes(MEMO), code: names.filter((n) => !n.endsWith('.png') && strFromU8(zip[n]).includes('5000')).map((n) => { const s = strFromU8(zip[n]); const i = s.indexOf('5000'); return n + ':' + s.slice(Math.max(0, i - 40), i + 20); }).slice(0, 4) }));
  check('X07', '除外した手順は出力に含まれず、番号だけが manifest に残る', !stepsJson.steps.some((s) => s.id === userStepId) && !text('scenario.md').includes(userStepId) && manifest.excludedStepSeqs.includes(2) && !names.some((n) => n.includes(userStepId)), JSON.stringify(manifest.excludedStepSeqs));
  const manualRec = stepsJson.steps.find((s) => s.id === manual.id);
  check('X08', '成果物単位で除外した画像はファイルも参照も残らない', manualRec.artifacts.screenshot.path === null && manualRec.artifacts.screenshot.status === 'excluded-from-export' && !names.some((n) => n.includes(manual.id) && n.endsWith('.png')), JSON.stringify(manualRec.artifacts.screenshot));
  check('X09', 'パスワード値が ZIP に含まれない', !allText.includes(PASSWORD) && !names.some((n) => Buffer.from(zip[n]).includes(Buffer.from(PASSWORD))), '');
  const saveRec = stepsJson.steps.find((s) => s.id === saveId);
  check('X10', 'steps.json で操作・画面変化・画像取得・完了確認・次の操作の各時刻が別項目になっている', !!saveRec.time.operationAt && !!saveRec.time.screenshotCapturedAt && saveRec.time.operationAt !== saveRec.time.screenshotCapturedAt && !!saveRec.time.humanConfirmedAt && !!saveRec.time.nextOperationAt && saveRec.time.screenChangeObservations.length > 0, JSON.stringify({ op: saveRec.time.operationAt, shot: saveRec.time.screenshotCapturedAt, human: saveRec.time.humanConfirmedAt, next: saveRec.time.nextOperationAt }));
  check('X11', '取得失敗が README と steps.json に理由つきで出力される', /取得できなかった情報/.test(text('README.md')) && text('README.md').includes('対象タブが前面に表示されていなかった') && stepsJson.steps.some((s) => s.kind === 'notice' && s.notice.code === 'restricted-page'), '');

  // 画像: マスク領域が実際に黒で塗られ、原本と一致するバイト列が ZIP に無い
  const maskedName = `tracelens-export/${saveRec.artifacts.screenshot.path}`;
  const px = await review.evaluate(async ({ bytes, artId }) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const d = await new Promise((res) => { const r = indexedDB.open('tracelens'); r.onsuccess = () => res(r.result); });
    const a = await new Promise((res) => { const r = d.transaction('artifacts').objectStore('artifacts').get(artId); r.onsuccess = () => res(r.result); });
    d.close();
    const m = a.masks[0];
    const inside = [...g.getImageData(Math.round(m.x + m.width / 2), Math.round(m.y + m.height / 2), 1, 1).data];
    const corner = [...g.getImageData(m.x + 2, m.y + 2, 1, 1).data];
    const outside = [...g.getImageData(Math.min(bmp.width - 2, m.x + m.width + 20), 5, 1, 1).data];
    const ob = await createImageBitmap(a.blob); const oc = new OffscreenCanvas(ob.width, ob.height); const og = oc.getContext('2d'); og.drawImage(ob, 0, 0);
    const origInside = og.getImageData(m.x, m.y, m.width, m.height).data; let nonBlack = 0; for (let i = 0; i < origInside.length; i += 4) if (origInside[i] + origInside[i + 1] + origInside[i + 2] > 30) nonBlack++;
    const all = g.getImageData(m.x, m.y, m.width, m.height).data; let leak = 0; for (let i = 0; i < all.length; i += 4) if (all[i] + all[i + 1] + all[i + 2] > 0) leak++;
    return { inside, corner, outside, mask: m, size: [bmp.width, bmp.height], origNonBlack: nonBlack, leak, originalBytes: [...new Uint8Array(await a.blob.arrayBuffer())].length, masksInDb: a.masks.length };
  }, { bytes: [...zip[maskedName]], artId: saveShot.id });
  check('X12', '塗りつぶしが出力画像そのものに適用されている（マスク範囲の全画素が黒、原本側には内容がある）', px.leak === 0 && px.inside.slice(0, 3).every((v) => v === 0) && px.origNonBlack > 100 && px.outside.slice(0, 3).some((v) => v > 0), JSON.stringify({ mask: px.mask, leak: px.leak, origNonBlack: px.origNonBlack, outside: px.outside }));
  const origBlobs = await review.evaluate(async () => {
    const d = await new Promise((res) => { const r = indexedDB.open('tracelens'); r.onsuccess = () => res(r.result); });
    const arts = await new Promise((res) => { const r = d.transaction('artifacts').objectStore('artifacts').getAll(); r.onsuccess = () => res(r.result); });
    d.close();
    const out = [];
    for (const a of arts) if (a.blob) { const h = await crypto.subtle.digest('SHA-256', await a.blob.arrayBuffer()); out.push([...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')); }
    return out;
  });
  const { createHash } = await import('node:crypto');
  const zipPngHashes = names.filter((n) => n.endsWith('.png')).map((n) => createHash('sha256').update(zip[n]).digest('hex'));
  check('X13', 'ZIP 内の画像はすべて再エンコードされたもので、保存済み原本と同一のバイト列は含まれない', zipPngHashes.length > 5 && zipPngHashes.every((h) => !origBlobs.includes(h)), `zip png=${zipPngHashes.length}, originals=${origBlobs.length}`);
  check('X14', '出力後も保存済みの記録（原本・置換前の値）は変更されていない', (await dump(review)).steps.find((s) => s.id === memoId).value.text === MEMO && px.masksInDb === 1, '');

  writeFileSync(resolve(out, 'export-file-list.txt'), names.sort().join('\n'));
  for (const f of ['scenario.md', 'input-mapping.md', 'README.md', 'implementation-request.md', 'manifest.json']) writeFileSync(resolve(out, `sample-${f}`), text(f));
} catch (e) {
  await diag();
  check('ZZZ', 'E2E スクリプトが最後まで実行される', false, e?.stack ?? String(e));
} finally {
  await context.close().catch(() => {});
  server.kill();
}

const failed = results.filter((r) => !r.ok);
writeFileSync(resolve(out, 'results.json'), JSON.stringify({ browser: browserVersion, ranAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed  (browser: ${browserVersion})`);
process.exit(failed.length ? 1 : 0);
