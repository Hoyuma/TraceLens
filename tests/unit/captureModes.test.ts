// ページ全体・要素単位の画像、操作前の画面の参照、新規タブへの切り替えの純粋部分と、出力への反映
import { describe, expect, it } from 'vitest';
import { FULL_PAGE_LIMITS, composeLayout, cropForElement, planScroll, sameRect } from '../../src/shared/capture';
import { decideBeforeScreenshot, SAFETY_MS, type RefShot } from '../../src/shared/beforeShot';
import { applySwitch, decideOnCreated, decideOnRemoved, type TabSwitchState } from '../../src/shared/tabSwitch';
import { buildExport } from '../../src/shared/export';
import { mkArtifacts, mkProject, mkScenario, mkStep, renderStub } from './fixtures';

describe('planScroll', () => {
  it('1 画面に収まるページは 1 位置だけ', () => {
    const p = planScroll({ pageHeight: 500, viewportWidth: 1000, viewportHeight: 700, devicePixelRatio: 1 });
    expect(p.positions).toEqual([0]); expect(p.partial).toBe(false);
  });
  it('最後の位置はスクロール可能な最下端に合わせる', () => {
    const p = planScroll({ pageHeight: 2000, viewportWidth: 1000, viewportHeight: 700, devicePixelRatio: 1 });
    expect(p.positions).toEqual([0, 700, 1300]); expect(p.coveredHeight).toBe(2000); expect(p.partial).toBe(false);
  });
  it('枚数の上限を超えると途中までで、理由を持つ', () => {
    const p = planScroll({ pageHeight: 100000, viewportWidth: 1000, viewportHeight: 500, devicePixelRatio: 1 });
    expect(p.partial).toBe(true); expect(p.positions.length).toBeLessThanOrEqual(FULL_PAGE_LIMITS.maxFrames); expect(p.partialReason).toMatch(/上限/);
    expect(p.coveredHeight).toBeLessThan(100000);
  });
  it('高さ・画素数の上限は devicePixelRatio を考慮する', () => {
    const p = planScroll({ pageHeight: 30000, viewportWidth: 1000, viewportHeight: 1000, devicePixelRatio: 2, limits: { maxFrames: 100 } });
    expect(p.partial).toBe(true); expect(p.coveredHeight * 2).toBeLessThanOrEqual(FULL_PAGE_LIMITS.maxHeightDevicePx);
  });
});

describe('composeLayout / cropForElement', () => {
  it('実際のスクロール位置に合わせて配置し、高さは取得した範囲まで', () => {
    const l = composeLayout([{ scrollY: 0, imageWidth: 1000, imageHeight: 700 }, { scrollY: 700, imageWidth: 1000, imageHeight: 700 }, { scrollY: 1300, imageWidth: 1000, imageHeight: 700 }], 1, 2000);
    expect(l.width).toBe(1000); expect(l.height).toBe(2000); expect(l.draws.map((d) => d.dy)).toEqual([0, 700, 1300]);
  });
  it('devicePixelRatio 2 では位置を 2 倍して配置する', () => {
    const l = composeLayout([{ scrollY: 0, imageWidth: 2000, imageHeight: 1400 }, { scrollY: 650, imageWidth: 2000, imageHeight: 1400 }], 2, 1350);
    expect(l.draws.map((d) => d.dy)).toEqual([0, 1300]); expect(l.height).toBe(2700);
  });
  it('要素が収まっていれば画像上の座標へ換算し、clipped にならない', () => {
    const c = cropForElement({ x: 100, y: 50, width: 200, height: 40 }, { width: 1000, height: 700 }, 2000, 1400)!;
    expect(c.crop).toEqual({ x: 200, y: 100, width: 400, height: 80 }); expect(c.clipped).toBe(false);
  });
  it('一部が表示領域外なら見えている部分だけを切り出し、clipped とする', () => {
    const c = cropForElement({ x: 900, y: 650, width: 200, height: 100 }, { width: 1000, height: 700 }, 1000, 700)!;
    expect(c.crop).toEqual({ x: 900, y: 650, width: 100, height: 50 }); expect(c.clipped).toBe(true); expect(c.visibleRatio).toBeCloseTo(0.25);
  });
  it('完全に外なら切り出さない（null）', () => {
    expect(cropForElement({ x: 1200, y: 10, width: 50, height: 50 }, { width: 1000, height: 700 }, 1000, 700)).toBeNull();
  });
  it('取得前後の矩形の一致判定は、確認できなければ false', () => {
    expect(sameRect({ x: 1, y: 1, width: 10, height: 10 }, { x: 2, y: 1, width: 10, height: 10 })).toBe(true);
    expect(sameRect({ x: 1, y: 1, width: 10, height: 10 }, { x: 20, y: 1, width: 10, height: 10 })).toBe(false);
    expect(sameRect({ x: 1, y: 1, width: 10, height: 10 }, null)).toBe(false);
  });
});

describe('decideBeforeScreenshot', () => {
  const vp = { width: 1000, height: 700, devicePixelRatio: 1, scrollX: 0, scrollY: 0 };
  const prev: RefShot = { artifactId: 'shot_a', stepId: 'stp_a', capturedAt: '2026-11-16T10:00:05.000Z', startedAtMs: 5000, docEpoch: 1, viewport: vp };
  const base = { docEpoch: 1, operationAtMs: 9000, viewport: vp, lastChange: null as null, prev };
  it('観測の範囲で変化がなければ、直前の画像を参照する（basis と参照先の時刻を持つ）', () => {
    const r = decideBeforeScreenshot(base);
    expect(r).toMatchObject({ status: 'captured', artifactId: 'shot_a', refStepId: 'stp_a', capturedAt: '2026-11-16T10:00:05.000Z', basis: 'previous-observation' });
  });
  it('画像の取得開始より前の変化は、画像に写っているものとして参照できる', () => {
    expect(decideBeforeScreenshot({ ...base, lastChange: { atMs: 5000 - SAFETY_MS - 1, kind: 'dom' } }).status).toBe('captured');
  });
  it('取得開始以降の DOM 変化・スクロール・リサイズは未取得（理由つき）', () => {
    for (const [kind, code] of [['dom', 'change-observed'], ['scroll', 'scrolled'], ['resize', 'resized'], ['tracking-start', 'change-observed']] as const) {
      const r = decideBeforeScreenshot({ ...base, lastChange: { atMs: 6000, kind } });
      expect(r.status).toBe('skipped'); expect(r.reasonCode).toBe(code); expect(r.reason).toBeTruthy(); expect(r.artifactId).toBeUndefined();
    }
  });
  it('前の画像がない・別文書・ビューポート不一致・観測情報なしは未取得', () => {
    expect(decideBeforeScreenshot({ ...base, prev: null }).reasonCode).toBe('no-previous');
    expect(decideBeforeScreenshot({ ...base, docEpoch: 2 }).reasonCode).toBe('document-changed');
    expect(decideBeforeScreenshot({ ...base, viewport: { ...vp, width: 900 } }).reasonCode).toBe('viewport-changed');
    expect(decideBeforeScreenshot({ ...base, viewport: { ...vp, scrollY: 40 } }).reasonCode).toBe('scrolled');
    expect(decideBeforeScreenshot({ ...base, lastChange: undefined }).reasonCode).toBe('no-observation');
    expect(decideBeforeScreenshot({ ...base, viewport: undefined }).reasonCode).toBe('viewport-unknown');
  });
  it('操作より後に取得を始めた画像は操作前として扱わない', () => {
    expect(decideBeforeScreenshot({ ...base, operationAtMs: 4000 }).reasonCode).toBe('not-before-operation');
  });
});

describe('tabSwitch', () => {
  const st: TabSwitchState = { current: { tabId: 1, windowId: 10 }, stack: [] };
  const created = { id: 2, windowId: 11, openerTabId: 1 };
  it('対象タブから開かれたタブだけが対象。設定無効・一時停止中・他のタブ由来は無視', () => {
    expect(decideOnCreated(st, { enabled: true, recording: true, created, hasAccess: true })).toEqual({ action: 'switch', to: { tabId: 2, windowId: 11 } });
    expect(decideOnCreated(st, { enabled: false, recording: true, created, hasAccess: true }).action).toBe('ignore');
    expect(decideOnCreated(st, { enabled: true, recording: false, created, hasAccess: true }).action).toBe('ignore');
    expect(decideOnCreated(st, { enabled: true, recording: true, created: { ...created, openerTabId: 9 }, hasAccess: true }).action).toBe('ignore');
  });
  it('権限がなければ切り替えず保留する', () => {
    expect(decideOnCreated(st, { enabled: true, recording: true, created, hasAccess: false }).action).toBe('pending');
  });
  it('切り替えると元のタブが stack に積まれ、同時に記録するのは 1 つだけ', () => {
    const n = applySwitch(st, { tabId: 2, windowId: 11 });
    expect(n.current.tabId).toBe(2); expect(n.stack).toEqual([{ tabId: 1, windowId: 10 }]);
    const m = applySwitch(n, { tabId: 3, windowId: 11 });
    expect(m.stack.map((t) => t.tabId)).toEqual([1, 2]);
  });
  it('切り替え先が閉じられたら、残っている元のタブへ戻る', () => {
    const n = applySwitch(applySwitch(st, { tabId: 2, windowId: 11 }), { tabId: 3, windowId: 11 });
    const d = decideOnRemoved(n, 3, new Set([1, 2]));
    expect(d.action).toBe('return'); if (d.action === 'return') { expect(d.to.tabId).toBe(2); expect(d.state.stack.map((t) => t.tabId)).toEqual([1]); }
    const d2 = decideOnRemoved(n, 3, new Set([1]));
    expect(d2.action === 'return' && d2.to.tabId).toBe(1);
  });
  it('戻れるタブがなければ end（履歴の有無を区別）、現在以外のタブの終了は none', () => {
    const n = applySwitch(st, { tabId: 2, windowId: 11 });
    const d = decideOnRemoved(n, 2, new Set());
    expect(d).toMatchObject({ action: 'end', stackWasEmpty: false });
    expect(decideOnRemoved(st, 1, new Set())).toMatchObject({ action: 'end', stackWasEmpty: true });
    const o = decideOnRemoved(n, 1, new Set([2]));
    expect(o.action).toBe('none'); expect(o.state.stack).toEqual([]); expect(o.state.current.tabId).toBe(2);
  });
  it('保留中のタブが閉じられたら保留を解く', () => {
    const p: TabSwitchState = { ...st, pending: { tabId: 5, windowId: 10 } };
    expect(decideOnRemoved(p, 5, new Set([1])).state.pending).toBeNull();
    expect(applySwitch(p, { tabId: 5, windowId: 10 }).pending).toBeNull();
  });
});

describe('出力: 取得方法と操作前の画面の参照', () => {
  async function run(over: { refExcluded?: boolean; refShotExcluded?: boolean } = {}) {
    const a = mkStep(1, { id: 'stp_a' });
    const b = mkStep(2, { id: 'stp_b', beforeScreenshot: { status: 'captured', artifactId: 'shot_stp_a', capturedAt: '2026-11-16T10:00:59.500Z', refStepId: 'stp_a', basis: 'previous-observation' } });
    const c = mkStep(3, { id: 'stp_c', beforeScreenshot: { status: 'skipped', reasonCode: 'change-observed', reason: '前の画像の取得後に画面変化を観測した（DOM の変化）', basis: 'previous-observation' } });
    if (over.refExcluded) a.includeInExport = false;
    const arts = [a, b, c].flatMap((s) => mkArtifacts(s));
    arts[0].captureInfo = { method: 'full-page', frameCount: 3, partial: true, partialReason: '上限のため途中まで', notes: ['固定ヘッダーが重複することがある'] };
    if (over.refShotExcluded) arts[0].includeInExport = false;
    return buildExport({ project: mkProject(), scenario: mkScenario(), steps: [a, b, c], artifacts: arts, rules: [], exportedAt: '2026-11-16T12:00:00.000Z', toolVersion: '0.1.0', renderImage: renderStub });
  }
  const recs = (r: Awaited<ReturnType<typeof run>>) => JSON.parse(r.files.find((f) => f.path === 'steps.json')!.text!).steps as any[];
  it('参照先の画像が出力にあれば path を持ち、操作直前の画像ではない旨を添える', async () => {
    const r = await run();
    const rs = recs(r);
    expect(rs[1].beforeScreenshot).toMatchObject({ status: 'captured', path: rs[0].artifacts.screenshot.path, basis: 'previous-observation' });
    expect(rs[1].beforeScreenshot.note).toMatch(/操作直前に取得した画像ではなく/);
    expect(rs[2].beforeScreenshot).toMatchObject({ status: 'skipped', path: null, reasonCode: 'change-observed' });
    expect(rs[0].beforeScreenshot).toBeNull();
    expect(rs[0].artifacts.screenshot.capture).toMatchObject({ method: 'full-page', frameCount: 3, partial: true });
    expect(rs[0].artifacts.screenshot.reason).toBeNull();
    expect(r.brokenReferences).toEqual([]);
  });
  it('参照先の手順・画像が出力対象外なら、path は null で理由を残し、壊れた参照を作らない', async () => {
    for (const o of [{ refExcluded: true }, { refShotExcluded: true }]) {
      const r = await run(o);
      const b = recs(r).find((x) => x.id === 'stp_b');
      expect(b.beforeScreenshot).toMatchObject({ status: 'unavailable', path: null }); expect(b.beforeScreenshot.reason).toMatch(/含まれていない/);
      expect(r.brokenReferences).toEqual([]);
    }
  });
});
