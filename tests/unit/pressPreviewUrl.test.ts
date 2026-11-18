// 押下時の画面・画面プレビュー・再生時の URL の置き換え
import { describe, expect, it } from 'vitest';
import { strFromU8 } from 'fflate';
import { decidePressShot, pressRelated, PRESS_MAX_DELAY_MS } from '../../src/shared/pressShot';
import { rewriteUrl, validateUrlRewrite } from '../../src/shared/urlRewrite';
import { buildReplayPlan, URL_REWRITE_NOTE } from '../../src/shared/replay';
import { serializeDom, BOX_ATTR } from '../../src/shared/domSerialize';
import { buildExport, validateReferences } from '../../src/shared/export';
import { exportImageTarget } from '../../src/review/logic';
import { boxOf, matchSelector, overlayCheck, prepareSnapshot, INDEX_ATTR } from '../../src/review/preview';
import type { Artifact, UrlRewrite } from '../../src/shared/types';
import { mkArtifacts, mkProject, mkScenario, mkStep, renderStub } from './fixtures';

const rect = { x: 10, y: 20, width: 100, height: 30 };
const base = { pressAtMs: 1000, operationAtMs: 1100, firstChangeAtMs: null, sameDocument: true, rectAtPress: rect, rectAfterCapture: rect };
const ok = (startedAtMs: number, endedAtMs: number) => ({ ok: true as const, startedAtMs, endedAtMs });

describe('押下時の画面の判定', () => {
  it('変化を観測せず位置も一致すれば、強調つきで残す', () => {
    const d = decidePressShot({ ...base, capture: ok(1010, 1080) });
    expect(d).toMatchObject({ keep: true, highlight: true });
  });
  it('操作の後・取得の開始前に変化を観測したら残さない（操作後の画面が写っている可能性）', () => {
    const d = decidePressShot({ ...base, capture: ok(1150, 1250), firstChangeAtMs: 1120 });
    expect(d).toMatchObject({ keep: false, reasonCode: 'changed-after-operation' });
  });
  it('押下から操作までの変化（押下による表示の変化）は残すが注記する', () => {
    const d = decidePressShot({ ...base, capture: ok(1010, 1080), firstChangeAtMs: 1005 });
    expect(d.keep).toBe(true);
    if (d.keep) expect(d.notes.join()).toContain('押下から取得の開始までに画面変化');
  });
  it('取得中の変化・取得の開始が操作より後であることを注記する', () => {
    const d = decidePressShot({ ...base, capture: ok(1150, 1250), firstChangeAtMs: 1200 });
    expect(d.keep).toBe(true);
    if (d.keep) { expect(d.notes.join()).toContain('取得中に画面変化'); expect(d.notes.join()).toContain('操作（クリックなど）を観測した後に取得を開始した'); }
  });
  it('位置が一致しなければ強調しない', () => {
    const d = decidePressShot({ ...base, capture: ok(1010, 1080), rectAfterCapture: { ...rect, y: 200 } });
    expect(d).toMatchObject({ keep: true, highlight: false });
  });
  it('取得の失敗・情報の喪失・文書の切り替え・遅すぎる取得は理由つきで残さない', () => {
    expect(decidePressShot({ ...base, capture: { ok: false, reasonCode: 'rate-limited', reason: 'x' } })).toMatchObject({ keep: false, reasonCode: 'rate-limited' });
    expect(decidePressShot({ ...base, capture: null })).toMatchObject({ keep: false, reasonCode: 'press-lost' });
    expect(decidePressShot({ ...base, capture: ok(1010, 1080), sameDocument: false })).toMatchObject({ keep: false, reasonCode: 'page-changed' });
    expect(decidePressShot({ ...base, capture: ok(1000 + PRESS_MAX_DELAY_MS + 1, 3000) })).toMatchObject({ keep: false, reasonCode: 'press-late' });
  });
  it('押下と操作の要素の対応（同じ要素・祖先と子孫・label と入力欄）', () => {
    document.body.innerHTML = '<button id="b"><span id="s">保存</span></button><label id="l" for="c">同意</label><input id="c" type="checkbox"><div id="o"></div>';
    const $ = (id: string) => document.getElementById(id)!;
    expect(pressRelated($('s'), $('b'))).toBe(true);
    expect(pressRelated($('l'), $('c'))).toBe(true);
    expect(pressRelated($('o'), $('b'))).toBe(false);
  });
});

describe('DOM の位置の記録と画面プレビュー', () => {
  it('serializeDom は box を渡すと位置を付け、ページ自身の同名属性は出力しない', () => {
    document.body.innerHTML = `<div id="a" ${BOX_ATTR}="fake">x</div>`;
    const r = serializeDom(document, undefined, true, (el) => (el.id === 'a' ? '1,2,3,4' : null));
    expect(r.html).toContain(`id="a" ${BOX_ATTR}="1,2,3,4"`);
    expect(r.html).not.toContain('fake');
  });
  it('表示用の HTML は読み込みを起こす属性・スクリプトを外し、CSP で通信を禁じる。一致の判定は記録した属性のまま', () => {
    const html = `<!DOCTYPE html><html><head><link rel="stylesheet" href="https://cdn.example.test/a.css"><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://x.test"></head>
      <body><img src="https://img.example.test/a.png" srcset="https://img.example.test/b.png 2x" class="logo"><a href="/next" onclick="steal()">次へ</a>
      <div style="background:url(https://bg.example.test/x.png)">bg</div><iframe src="https://frame.example.test/"></iframe>
      <input data-tracelens-ref="1" name="n"><input data-tracelens-ref="2" type="password" name="p"></body></html>`;
    const p = prepareSnapshot(html, [{ ref: 1, tag: 'input', value: '山田' }, { ref: 2, tag: 'input', redacted: true }]);
    expect(p.srcdoc).toContain("Content-Security-Policy");
    expect(p.srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(p.srcdoc.indexOf('<body'));
    for (const bad of ['cdn.example.test', 'img.example.test', 'bg.example.test', 'frame.example.test', '<script', 'onclick', 'refresh']) expect(p.srcdoc).not.toContain(bad);
    expect(p.srcdoc).toContain('href="/next"'); // リンクの href はセレクターのために残す（表示側で操作を受け付けない）
    expect(p.srcdoc).toContain('value="山田"');
    // 判定用の文書は記録した属性のまま（img[src] のセレクターも一致する）
    const m = matchSelector(p.doc, 'css', 'img[src="https://img.example.test/a.png"]');
    expect(m.ok && m.elements.length).toBe(1);
    const i = m.ok ? m.elements[0].getAttribute(INDEX_ATTR) : null;
    expect(p.srcdoc).toContain(`${INDEX_ATTR}="${i}"`);
  });
  it('XPath と誤ったセレクター', () => {
    const p = prepareSnapshot('<html><body><button>保存</button><button>戻る</button></body></html>');
    const m = matchSelector(p.doc, 'xpath', '//button[normalize-space(.)="保存"]');
    expect(m.ok && m.elements.length).toBe(1);
    expect(matchSelector(p.doc, 'css', 'div[').ok).toBe(false);
  });
  it('位置を画像に重ねるのは、ビューポートとスクロールが同じ場合だけ', () => {
    const p = prepareSnapshot(`<html><body><div ${BOX_ATTR}="5,6,7,8">a</div><div ${BOX_ATTR}="bad">b</div></body></html>`);
    const [a, b] = Array.from(p.doc.querySelectorAll('div'));
    expect(boxOf(a)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(boxOf(b)).toBeNull();
    const bv = { width: 800, height: 600, scrollX: 0, scrollY: 0 };
    const meta = { targetRectAtCapture: null, viewport: { ...bv, devicePixelRatio: 1 } };
    expect(overlayCheck(bv, meta).ok).toBe(true);
    expect(overlayCheck({ ...bv, scrollY: 10 }, meta).ok).toBe(false);
    expect(overlayCheck(undefined, meta).ok).toBe(false);
  });
});

describe('再生時の URL の置き換え', () => {
  const rule = (from: string, to: string, enabled = true): UrlRewrite => ({ id: 'url_1', from, to, enabled });
  it('先頭部分の一致は境界で区切る', () => {
    const r = [rule('https://test.example.com', 'https://new.example.com')];
    expect(rewriteUrl('https://test.example.com/app?a=1', r).url).toBe('https://new.example.com/app?a=1');
    expect(rewriteUrl('https://test.example.com', r).url).toBe('https://new.example.com');
    expect(rewriteUrl('https://test.example.com.evil.test/app', r).url).toBe('https://test.example.com.evil.test/app');
    expect(rewriteUrl('https://test.example.com/app', [rule('https://test.example.com/', 'https://new.example.com/v2/')]).url).toBe('https://new.example.com/v2/app');
    expect(rewriteUrl('https://test.example.com/app', [rule('https://test.example.com/', 'https://new.example.com')]).url).toBe('https://new.example.com/app');
    expect(rewriteUrl('https://test.example.com/app', [rule('https://test.example.com/', 'https://new.example.com', false)]).url).toBe('https://test.example.com/app');
  });
  it('規則の検査', () => {
    expect(validateUrlRewrite({ from: 'https://a.test/', to: 'https://b.test/' })).toEqual([]);
    expect(validateUrlRewrite({ from: 'ftp://a.test', to: '' }).length).toBe(2);
    expect(validateUrlRewrite({ from: 'https://a.test/?q', to: 'https://b.test/#x' }).length).toBe(2);
  });
  it('再生の計画で遷移先・URL の待機・フレームの URL を置き換え、記録は書き換えない', () => {
    const steps = [
      mkStep(1, { kind: 'session-start', page: { url: 'https://test.example.com/login', title: '' }, frame: { isTop: true, path: [], url: 'https://test.example.com/login' } }),
      mkStep(2, { kind: 'click', frame: { isTop: true, path: [], url: 'https://test.example.com/login' } }),
      mkStep(3, { kind: 'navigation', navigation: { toUrl: 'https://test.example.com/menu' }, page: { url: 'https://test.example.com/menu', title: '' } }),
    ];
    const before = JSON.stringify(steps);
    const plan = buildReplayPlan(mkScenario('scn_1', { urlRewrites: [rule('https://test.example.com/', 'https://new.example.com/')] }), steps);
    expect(plan[0]).toMatchObject({ kind: 'navigate', url: 'https://new.example.com/login' });
    expect(plan[0].note).toContain(URL_REWRITE_NOTE);
    expect(plan[1].frameUrl).toBe('https://new.example.com/login');
    expect(plan[2]).toMatchObject({ kind: 'wait', wait: { kind: 'url-matches', value: 'https://new.example.com/menu' } });
    expect(JSON.stringify(steps)).toBe(before);
    // 規則がなければ従来どおり
    expect(buildReplayPlan(mkScenario(), steps)[0]).toMatchObject({ url: 'https://test.example.com/login' });
  });
});

describe('押下時の画面の出力', () => {
  it('別ファイル（.press.png）で出力し、参照が壊れない。対象外・未取得は path null と理由', async () => {
    const s1 = mkStep(1, { pressScreenshot: { status: 'captured', artifactId: 'press_a', pressAt: '2026-11-16T10:00:00.900Z', captureStartedAt: '2026-11-16T10:00:00.910Z', capturedAt: '2026-11-16T10:00:00.990Z', notes: ['注記'] } });
    const s2 = mkStep(2, { pressScreenshot: { status: 'skipped', reasonCode: 'rate-limited', reason: '上限' } });
    const press: Artifact = { id: 'press_a', scenarioId: 'scn_1', stepId: s1.id, type: 'screenshot', capturedAt: '2026-11-16T10:00:00.990Z', phase: 'at-press', includeInExport: true, blob: new Blob(['ORIGINAL-PRESS']), masks: [{ x: 0, y: 0, width: 5, height: 5 }], meta: { targetRectAtCapture: null } };
    const r = await buildExport({ project: mkProject(), scenario: mkScenario(), steps: [s1, s2], artifacts: [...mkArtifacts(s1), ...mkArtifacts(s2), press], rules: [], exportedAt: '2026-11-16T12:00:00.000Z', toolVersion: '0.1.0', renderImage: renderStub });
    const sj = JSON.parse(r.files.find((f) => f.path === 'steps.json')!.text!);
    const p1 = sj.steps[0].artifacts.pressScreenshot;
    expect(p1).toMatchObject({ status: 'captured', path: `screenshots/step-0001-${s1.id}.press.png`, pressAt: '2026-11-16T10:00:00.900Z', maskedRegionCount: 1 });
    const f = r.files.find((x) => x.path === p1.path)!;
    expect(strFromU8(f.bytes!)).toBe('RENDERED:1'); // 原本ではなく再エンコード結果
    expect(sj.steps[1].artifacts.pressScreenshot).toMatchObject({ path: null, status: 'skipped', reason: '上限' });
    expect(r.brokenReferences).toEqual([]);
    expect(validateReferences([{ path: 'README.md', text: 'screenshots/step-0001-x.press.png' }])).toEqual(['README.md -> screenshots/step-0001-x.press.png']);
  });
});

describe('出力ダイアログの画像と手順の対応', () => {
  it('.press.png は押下時の画面の成果物、.png は操作後の画面の成果物を指す', () => {
    const s = mkStep(3, { id: 'stp_abc_1', pressScreenshot: { status: 'captured', artifactId: 'press_stp_abc_1' } });
    expect(exportImageTarget('screenshots/step-0003-stp_abc_1.press.png', [s])).toEqual({ stepId: 'stp_abc_1', press: true, artifactId: 'press_stp_abc_1' });
    expect(exportImageTarget('screenshots/step-0003-stp_abc_1.png', [s])).toEqual({ stepId: 'stp_abc_1', press: false, artifactId: 'shot_stp_abc_1' });
    expect(exportImageTarget('screenshots/step-0003-other.png', [s])).toBeNull();
  });
});
