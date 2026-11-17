// 再生スクリプトの中核（要素の特定・値の設定・待機条件の評価）。jsdom で検証する。
import { afterEach, describe, expect, it } from 'vitest';
import { applySelect, evaluateWait, executeAction, findTarget, javascriptUrlLink, matchOptions, setNativeValue, waitFor, UNTRUSTED_NOTE } from '../../src/replay/core';
import { matchFrame } from '../../src/background/replayFrames';
import { clickMarkedInMainWorld } from '../../src/background/replayLogic';
import type { ReplaySelector, ResolvedReplayAction } from '../../src/shared/replay';

const css = (selector: string, extra: Partial<ReplaySelector> = {}): ReplaySelector => ({ language: 'css', selector, source: 'recorded', scope: 'document', recordedMatchCount: 1, stability: 'unverified', ...extra });
function act(kind: ResolvedReplayAction['kind'], over: Partial<ResolvedReplayAction> = {}): ResolvedReplayAction {
  return { stepId: 'stp_1', seq: 1, index: 0, kind, stepKind: kind === 'wait' ? 'wait' : (kind as any), label: '', selectors: [], frame: [], frameUrl: 'http://x/', shadowPath: [], wait: { kind: 'none' }, onFail: 'stop', timeoutMs: 300, ...over };
}
const env = () => ({ doc: document, win: window });

afterEach(() => { document.body.innerHTML = ''; });

describe('要素の特定', () => {
  it('一致が 1 件の候補を採用し、0 件・複数件は件数を理由に残す', () => {
    document.body.innerHTML = '<input class="a"><input class="a"><input id="u">';
    const r = findTarget(document, { selectors: [css('#none'), css('.a'), css('#u')], shadowPath: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.selector.selector).toBe('#u');
    expect(r.attempts.map((a) => a.count)).toEqual([0, 2, 1]);
    const f = findTarget(document, { selectors: [css('#none'), css('.a')], shadowPath: [] });
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.reason).toContain('#none: 0 件');
    if (!f.ok) expect(f.reason).toContain('.a: 2 件');
  });

  it('XPath と open Shadow DOM の経路を扱う', () => {
    document.body.innerHTML = '<button>保存</button><div id="host"></div>';
    const sr = document.getElementById('host')!.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button id="in">ヘルプ</button>';
    const x = findTarget(document, { selectors: [{ ...css('//button[normalize-space(.)="保存"]'), language: 'xpath' }], shadowPath: [] });
    expect(x.ok && x.el.textContent).toBe('保存');
    const s = findTarget(document, { selectors: [css('#in', { scope: 'shadow-root' })], shadowPath: [{ hostSelector: '#host', mode: 'open' }] });
    expect(s.ok && s.el.id).toBe('in');
    const bad = findTarget(document, { selectors: [css('#in', { scope: 'shadow-root' })], shadowPath: [{ hostSelector: '#nohost', mode: 'open' }] });
    expect(bad.ok).toBe(false);
  });
});

describe('値の設定', () => {
  it('ネイティブの setter を使い、要素側の value 上書き（React の値追跡）を経由しない', () => {
    document.body.innerHTML = '<input id="u">';
    const el = document.getElementById('u') as HTMLInputElement;
    const protoSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const protoGet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!;
    let tracked = '';
    Object.defineProperty(el, 'value', { configurable: true, get() { return protoGet.call(this); }, set(v) { tracked = v; protoSet.call(this, v); } });
    const events: string[] = [];
    let seenOnInput = '';
    el.addEventListener('input', () => { events.push('input'); seenOnInput = el.value; });
    el.addEventListener('change', () => events.push('change'));
    setNativeValue(el, 'E99999');
    expect(el.value).toBe('E99999');
    expect(tracked).toBe(''); // 追跡値は古いまま → React は変更として検出する
    expect(seenOnInput).toBe('E99999');
    expect(events).toEqual(['input', 'change']);
  });

  it('select は value → label の順で照合し、位置（index）だけでは選ばない', () => {
    document.body.innerHTML = '<select id="s"><option value="">-</option><option value="P001">P001 基幹</option><option value="P002">P002 保守</option></select>';
    const s = document.getElementById('s') as HTMLSelectElement;
    expect(matchOptions(s, undefined, [{ value: 'P002', label: 'x', index: 0 }])).toMatchObject({ ok: true, indexes: [2], by: 'value' });
    expect(matchOptions(s, undefined, [{ value: 'gone', label: 'P001 基幹', index: 0 }])).toMatchObject({ ok: true, indexes: [1], by: 'label' });
    // value も表示名も違う選択肢を、記録時と同じ位置というだけで選ばない（推測で補わない）
    const byPos = matchOptions(s, undefined, [{ value: 'gone', label: 'gone', index: 2 }]);
    expect(byPos.ok).toBe(false);
    if (!byPos.ok) expect(byPos.reason).toContain('位置だけでは選ばない');
    expect(matchOptions(s, 'P001 基幹', undefined)).toMatchObject({ ok: true, indexes: [1], by: 'label' });
    expect(matchOptions(s, 'none', undefined).ok).toBe(false);
    let changed = 0; s.addEventListener('change', () => changed++);
    applySelect(s, [2]);
    expect(s.value).toBe('P002');
    expect(changed).toBe(1);
  });
});

describe('1 手順の実行', () => {
  it('機密欄には書き込まず manual を返し、値を結果に残さない', async () => {
    document.body.innerHTML = '<input id="pw" type="password">';
    const r = await executeAction(act('input', { selectors: [css('#pw')], text: 'S3cret!' }), env());
    expect(r.status).toBe('manual');
    expect((document.getElementById('pw') as HTMLInputElement).value).toBe('');
    expect(JSON.stringify(r)).not.toContain('S3cret!');
  });

  it('後から現れる要素を上限時間まで待ち、見つかったら入力する', async () => {
    setTimeout(() => { document.body.innerHTML = '<input name="hours">'; }, 80);
    let acted = 0;
    const r = await executeAction(act('input', { selectors: [css('input[name="hours"]')], text: '1.5', timeoutMs: 1500 }), { ...env(), beforeAct: async () => { acted++; return true; } });
    expect(r).toMatchObject({ status: 'ok', matchCount: 1, selectorUsed: { selector: 'input[name="hours"]' } });
    expect(acted).toBe(1);
    expect((document.querySelector('input[name="hours"]') as HTMLInputElement).value).toBe('1.5');
    expect(JSON.stringify(r)).not.toContain('1.5');
  });

  it('セレクターが一致しなければ failed と理由（候補ごとの件数）', async () => {
    document.body.innerHTML = '<input>';
    const r = await executeAction(act('click', { selectors: [css('#nope')], timeoutMs: 200 }), env());
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('#nope: 0 件');
  });

  it('制御側が取り消したら操作しない', async () => {
    document.body.innerHTML = '<button id="b">b</button>';
    let clicked = 0; document.getElementById('b')!.addEventListener('click', () => clicked++);
    const r = await executeAction(act('click', { selectors: [css('#b')] }), { ...env(), beforeAct: async () => false });
    expect(r.status).toBe('failed');
    expect(clicked).toBe(0);
  });

  it('クリックはホバー・ポインター・マウスのイベント列と click を送り、イベントは isTrusted=false', async () => {
    document.body.innerHTML = '<button id="b">b</button>';
    const seen: string[] = []; let trusted: boolean | null = null;
    const types = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const t of types) document.getElementById('b')!.addEventListener(t, (e) => { seen.push(t); if (t === 'click') trusted = e.isTrusted; });
    const r = await executeAction(act('click', { selectors: [css('#b')] }), env());
    expect(r.status).toBe('ok');
    expect(seen).toEqual(types);
    expect(trusted).toBe(false);
  });

  describe('座標の要素へのクリック（target が子孫であることを前提にするメニュー）', () => {
    const orig = (document as any).elementFromPoint;
    afterEach(() => { (document as any).elementFromPoint = orig; });
    // jQuery UI 1.8 の autocomplete と同じ判定: mouseover で選択中の項目を決め、click は target が「.ui-menu-item a」の中のときだけ選択する
    const menu = () => {
      document.body.innerHTML = '<ul id="m"><li class="ui-menu-item" role="menuitem"><a id="a1">A</a></li><li class="ui-menu-item" role="menuitem"><a id="a2">振替伝票依頼</a></li></ul><p id="out"></p>';
      let active: Element | null = null;
      const m = document.getElementById('m')!;
      m.addEventListener('mouseover', (e) => { const a = (e.target as Element).closest('.ui-menu-item a'); if (a) active = a; });
      m.addEventListener('click', (e) => { if (!(e.target as Element).closest('.ui-menu-item a') || !active) return; document.getElementById('out')!.textContent = active.textContent; });
    };
    it('座標の要素が記録した要素の子孫なら、その要素にホバーとクリックを送る', async () => {
      menu();
      (document as any).elementFromPoint = () => document.getElementById('a2');
      const r = await executeAction(act('click', { selectors: [css('#m > li:nth-of-type(2)')] }), env());
      expect(r.status).toBe('ok');
      expect(document.getElementById('out')!.textContent).toBe('振替伝票依頼');
    });
    it('座標の要素が記録した要素の外（覆われている）なら、その要素には送らず記録した要素へ送る', async () => {
      menu();
      document.body.insertAdjacentHTML('beforeend', '<div id="cover"></div>');
      let coverClicks = 0;
      document.getElementById('cover')!.addEventListener('click', () => coverClicks++);
      let liClicks = 0;
      document.querySelector('#m > li:nth-of-type(2)')!.addEventListener('click', (e) => { if (e.target === e.currentTarget) liClicks++; });
      (document as any).elementFromPoint = () => document.getElementById('cover');
      await executeAction(act('click', { selectors: [css('#m > li:nth-of-type(2)')] }), env());
      expect(coverClicks).toBe(0);
      expect(liClicks).toBe(1);
    });
  });

  it('チェックは目標と異なるときだけクリックする', async () => {
    document.body.innerHTML = '<input id="c" type="checkbox" checked>';
    let clicks = 0; document.getElementById('c')!.addEventListener('click', () => clicks++);
    expect((await executeAction(act('check', { selectors: [css('#c')], checked: true }), env())).status).toBe('ok');
    expect(clicks).toBe(0);
    expect((await executeAction(act('check', { selectors: [css('#c')], checked: false }), env())).status).toBe('ok');
    expect(clicks).toBe(1);
    expect((document.getElementById('c') as HTMLInputElement).checked).toBe(false);
  });

  it('無効な要素は有効になるまで待つ（select は選択肢が現れるまで待つ）', async () => {
    document.body.innerHTML = '<select id="s" disabled><option value="">読み込み中</option></select>';
    setTimeout(() => { const s = document.getElementById('s') as HTMLSelectElement; s.innerHTML = '<option value="">-</option><option value="5000">5000</option>'; s.disabled = false; }, 120);
    const r = await executeAction(act('select', { selectors: [css('#s')], selectOptions: [{ value: '5000', label: '5000', index: 1 }], timeoutMs: 1500 }), env());
    expect(r.status).toBe('ok');
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('5000');
  });

  it('選択肢が差し替わる途中の別の候補一覧からは選ばず、記録した value が現れるまで待つ', async () => {
    // 実ブラウザの e2e で起きた状況: 前の PJ の工程候補（同じ位置に別の値）が一時的に有効になり、その後に本来の候補へ差し替わる
    document.body.innerHTML = '<select id="s" disabled><option value="">読み込み中</option></select>';
    const s = document.getElementById('s') as HTMLSelectElement;
    setTimeout(() => { s.innerHTML = '<option value="">-</option><option value="1000">1000 要件定義</option><option value="2000">2000 設計</option>'; s.disabled = false; }, 60);
    setTimeout(() => { s.innerHTML = '<option value="">-</option><option value="5000">5000 問合せ対応</option><option value="5100">5100 障害対応</option>'; }, 250);
    const changes: string[] = []; s.addEventListener('change', () => changes.push(s.value));
    const r = await executeAction(act('select', { selectors: [css('#s')], selectOptions: [{ value: '5000', label: '5000 問合せ対応', index: 1 }], timeoutMs: 1500 }), env());
    expect(r.status).toBe('ok');
    expect(s.value).toBe('5000');
    expect(changes).toEqual(['5000']);
  });

  it('記録した選択肢が上限時間まで現れなければ、別の値を選ばずに失敗する', async () => {
    document.body.innerHTML = '<select id="s"><option value="">-</option><option value="1000">1000 要件定義</option></select>';
    const s = document.getElementById('s') as HTMLSelectElement;
    const r = await executeAction(act('select', { selectors: [css('#s')], selectOptions: [{ value: '5000', label: '5000 問合せ対応', index: 1 }], timeoutMs: 250 }), env());
    expect(r.status).toBe('failed');
    expect(s.value).toBe('');
  });

  it('待機条件を時間内に観測できなければ failed（isTrusted の制限を理由に添える）', async () => {
    document.body.innerHTML = '<button id="b">b</button>';
    const r = await executeAction(act('click', { selectors: [css('#b')], wait: { kind: 'text-present', value: '保存しました' }, timeoutMs: 200 }), env());
    expect(r.status).toBe('failed');
    expect(r.reason).toContain(UNTRUSTED_NOTE);
    expect(r.waitOutcome?.status).toBe('timeout');
  });
});

describe('待機条件', () => {
  it('text-present / url-matches / element-present / element-absent / 正規表現', () => {
    document.body.innerHTML = '<div role="status">保存しました（1件）</div>';
    expect(evaluateWait({ kind: 'text-present', value: '保存しました' }, document, '')).toEqual({ met: true });
    expect(evaluateWait({ kind: 'text-present', value: '保存しました（\\d+件）', isRegex: true }, document, '')).toEqual({ met: true });
    expect(evaluateWait({ kind: 'url-matches', value: '/index.html' }, document, 'http://h/index.html?view=1')).toEqual({ met: true });
    expect(evaluateWait({ kind: 'element-present', value: '[role="status"]' }, document, '')).toEqual({ met: true });
    expect(evaluateWait({ kind: 'element-absent', value: '[role="status"]' }, document, '')).toEqual({ met: false });
    expect('error' in evaluateWait({ kind: 'text-present', value: '(', isRegex: true }, document, '')).toBe(true);
    expect('error' in evaluateWait({ kind: 'element-present', value: '[[' }, document, '')).toBe(true);
  });

  it('後から現れる文字列を観測する。dom-quiet は静止を観測する', async () => {
    setTimeout(() => { document.body.innerHTML = '<p>保存しました</p>'; }, 60);
    const wo = await waitFor({ kind: 'text-present', value: '保存しました' }, env(), Date.now() + 1000);
    expect(wo.status).toBe('observed');
    const q = await waitFor({ kind: 'dom-quiet', quietMs: 50 }, env(), Date.now() + 1000);
    expect(q.status).toBe('observed');
    expect(q.detail).toContain('業務処理の完了ではない');
    const none = await waitFor({ kind: 'none' }, env(), Date.now());
    expect(none.status).toBe('not-applicable');
  });

  it('dom-quiet が上限までに静止しなければ timeout（失敗ではない）', async () => {
    const it = setInterval(() => { document.body.append(document.createElement('i')); }, 10);
    const r = await executeAction(act('wait', { wait: { kind: 'dom-quiet', quietMs: 100 }, timeoutMs: 300 }), { ...env(), quietMaxMs: 250 });
    clearInterval(it);
    expect(r.status).toBe('ok');
    expect(r.waitOutcome?.status).toBe('timeout');
  });
});

describe('フレームの解決', () => {
  const frames = [
    { frameId: 0, path: [] },
    { frameId: 5, path: [{ index: 0, selector: 'html > body > main > iframe' }] },
    { frameId: 7, path: [{ index: 1, selector: 'html > body > iframe:nth-of-type(2)' }] },
  ];
  it('トップは frameId 0、子フレームは経路の index で照合する', () => {
    expect(matchFrame(frames, [])).toMatchObject({ frameId: 0 });
    expect(matchFrame(frames, [{ index: 1, crossOrigin: false }])).toMatchObject({ frameId: 7 });
  });
  it('index が取れなかった階層は selector で照合し、一致しなければ理由を返す', () => {
    expect(matchFrame(frames, [{ index: -1, selector: 'html > body > main > iframe', crossOrigin: false }])).toMatchObject({ frameId: 5 });
    expect('error' in matchFrame(frames, [{ index: 3, crossOrigin: true }, { index: 0, crossOrigin: true }])).toBe(true);
  });
  it('iframe の追加で index がずれても、selector と URL で記録時のフレームを選ぶ（index だけで別のフレームを選ばない）', () => {
    // 記録時: ダイアログの iframe は index 0。再生時: 先に隠し iframe（アップロード用など）が追加され、ダイアログは index 1 になった
    const live = [
      { frameId: 0, path: [] },
      { frameId: 11, path: [{ index: 0, selector: 'html > body > iframe', url: 'https://example.test/upload' }] },
      { frameId: 12, path: [{ index: 1, selector: '#GB_window > div:nth-of-type(2) > iframe', url: 'https://example.test/loader.html' }] },
    ];
    const rec = [{ index: 0, selector: '#GB_window > div:nth-of-type(2) > iframe', crossOrigin: false, url: 'https://example.test/loader.html?s=0' }];
    expect(matchFrame(live, rec)).toMatchObject({ frameId: 12, via: 'selector' });
  });
  it('selector も index も複数一致する入れ子では、各階層の URL（origin + path）で絞る', () => {
    const live = [
      { frameId: 0, path: [] },
      { frameId: 21, path: [{ index: 0, selector: 'html > body > iframe', url: 'https://example.test/a' }, { index: 0, selector: 'html > body > iframe', url: 'https://example.test/a/inner' }] },
      { frameId: 22, path: [{ index: 0, selector: 'html > body > iframe', url: 'https://example.test/b' }, { index: 0, selector: 'html > body > iframe', url: 'https://example.test/b/inner?token=2' }] },
    ];
    const rec = [{ index: 0, selector: 'html > body > iframe', crossOrigin: false, url: 'https://example.test/b' }, { index: 0, selector: 'html > body > iframe', crossOrigin: false, url: 'https://example.test/b/inner?token=1' }];
    expect(matchFrame(live, rec)).toMatchObject({ frameId: 22 });
    // URL でも絞れなければ特定できない理由を返す
    expect(matchFrame(live, rec.map((h) => ({ ...h, url: undefined })))).toEqual({ error: expect.stringContaining('2 件') });
  });
});

describe('javascript: URL のリンクのクリック', () => {
  it('要素自身か祖先の a / area の href が javascript: なら判定する（大文字・前後の空白を含む）', () => {
    document.body.innerHTML = '<a id="j" href=" JavaScript:doSubmit()"><span id="in">送信</span></a><a id="n" href="/next">次へ</a><a id="h" href="#">#</a>';
    expect(javascriptUrlLink(document.getElementById('j')!)).toBe(true);
    expect(javascriptUrlLink(document.getElementById('in')!)).toBe(true);
    expect(javascriptUrlLink(document.getElementById('n')!)).toBe(false);
    expect(javascriptUrlLink(document.getElementById('h')!)).toBe(false);
  });
  it('javascript: のリンクは拡張側で click() せず、ページ側でのクリックを依頼する（二重にクリックしない）', async () => {
    document.body.innerHTML = '<a id="j" href="javascript:void(0)">送信</a>';
    const a = document.getElementById('j')!;
    let isolatedClicks = 0;
    a.addEventListener('click', (e) => { isolatedClicks++; e.preventDefault(); });
    const asked: Element[] = [];
    const r = await executeAction(act('click', { selectors: [css('#j')] }), { ...env(), mainWorldClick: async (el) => { asked.push(el); return { ok: true }; } });
    expect(asked).toEqual([a]);
    expect(isolatedClicks).toBe(0);
    expect(r.status).toBe('ok');
    expect(r.reason).toContain('ページ側（main world）でクリックした');
  });
  it('ページ側でクリックできない・依頼の手段がない場合は ok にせず失敗にする', async () => {
    document.body.innerHTML = '<a id="j" href="javascript:void(0)">送信</a>';
    const r1 = await executeAction(act('click', { selectors: [css('#j')] }), { ...env(), mainWorldClick: async () => ({ ok: false, reason: '文書が切り替わった' }) });
    expect(r1.status).toBe('failed');
    expect(r1.reason).toContain('文書が切り替わった');
    const r2 = await executeAction(act('click', { selectors: [css('#j')] }), env());
    expect(r2.status).toBe('failed');
  });
  it('通常のリンク・ボタンは従来どおり拡張側で click() する', async () => {
    document.body.innerHTML = '<button id="b">保存</button>';
    let n = 0;
    document.getElementById('b')!.addEventListener('click', () => n++);
    let asked = 0;
    const r = await executeAction(act('click', { selectors: [css('#b')] }), { ...env(), mainWorldClick: async () => { asked++; return { ok: true }; } });
    expect(r.status).toBe('ok');
    expect(n).toBe(1);
    expect(asked).toBe(0);
  });
  it('再生スクリプト（拡張）由来の CSP 違反を観測したら、待機条件を観測できても ok にしない。ページ自身の違反は数えない', async () => {
    document.body.innerHTML = '<button id="b">保存</button><button id="c">次へ</button>';
    const violate = (sourceFile: string) => { const e = new Event('securitypolicyviolation') as any; Object.assign(e, { sourceFile, effectiveDirective: 'script-src-elem', blockedURI: 'inline' }); document.dispatchEvent(e); };
    document.getElementById('b')!.addEventListener('click', () => violate('chrome-extension://abc/replay.js'));
    document.getElementById('c')!.addEventListener('click', () => violate('https://example.test/app.js'));
    const r = await executeAction(act('click', { selectors: [css('#b')] }), env());
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('CSP');
    const r2 = await executeAction(act('click', { selectors: [css('#c')] }), env());
    expect(r2.status).toBe('ok');
  });
});

describe('ページ側（main world）でのクリック', () => {
  // jsdom には CSS.escape がない（印のトークンは英数字だけなので、そのまま返す代わりで足りる）
  if (!(globalThis as any).CSS?.escape) (globalThis as any).CSS = { ...(globalThis as any).CSS, escape: (s: string) => s };
  it('印の要素を click() し、印を外す', () => {
    document.body.innerHTML = '<a id="a" href="#" data-m="t1">送信</a>';
    let n = 0; document.getElementById('a')!.addEventListener('click', (e) => { n++; e.preventDefault(); });
    expect(clickMarkedInMainWorld('data-m', 't1')).toEqual({ ok: true });
    expect(n).toBe(1);
    expect(document.getElementById('a')!.hasAttribute('data-m')).toBe(false);
  });
  it('click() を持たない要素（リンク内の SVG アイコン）は click イベントを送り、祖先のリンクへ伝わる', () => {
    document.body.innerHTML = '<a id="a" href="#"><svg><path id="p" data-m="t2"></path></svg></a>';
    let target: EventTarget | null = null;
    document.getElementById('a')!.addEventListener('click', (e) => { target = e.target; e.preventDefault(); });
    expect(clickMarkedInMainWorld('data-m', 't2')).toEqual({ ok: true });
    expect(target).toBe(document.getElementById('p'));
  });
  it('印の要素がなければ理由つきで失敗', () => {
    document.body.innerHTML = '';
    expect(clickMarkedInMainWorld('data-m', 'x').ok).toBe(false);
  });
});
