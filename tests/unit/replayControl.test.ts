// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DiagLog, classifyInjectError, decideRunReply, documentChanged, isSameDocumentNavigation, missingOrigin, reloadTarget, stepEntryMode, stopMode, stoppedStepResult,
} from '../../src/background/replayLogic';
import { buildReplayPlan, RELOAD_AS_GET_NOTE } from '../../src/shared/replay';
import { planStepCopy, remapBeforeScreenshot } from '../../src/shared/importScenario';
import { mkArtifacts, mkScenario, mkStep } from './fixtures';

describe('注入エラーの分類 (L1)', () => {
  it('エラー文中の URL（.pdf / chrome を含むパス）で「注入できないページ」に誤分類しない', () => {
    const m = 'Cannot access contents of url "https://example.test/files/report.pdf". Extension manifest must request permission to access this host.';
    expect(classifyInjectError(m)).toEqual({ code: 'permission', url: 'https://example.test/files/report.pdf' });
    const m2 = 'Cannot access contents of url "https://example.test/chrome://x/edge://y/view-source". Extension manifest must request permission to access this host.';
    expect(classifyInjectError(m2).code).toBe('permission');
  });
  it('URL を含まない権限エラーは permission（url なし）', () => {
    expect(classifyInjectError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')).toEqual({ code: 'permission', url: undefined });
  });
  it('ブラウザ内部ページ・ギャラリー・エラーページ・ポリシーは restricted', () => {
    expect(classifyInjectError('Cannot access a chrome:// URL').code).toBe('restricted');
    expect(classifyInjectError('Cannot access a chrome-extension:// URL of different extension').code).toBe('restricted');
    expect(classifyInjectError('The extensions gallery cannot be scripted.').code).toBe('restricted');
    expect(classifyInjectError('Frame with ID 0 is showing error page').code).toBe('restricted');
    expect(classifyInjectError('This page cannot be scripted due to an ExtensionsSettings policy.').code).toBe('restricted');
    expect(classifyInjectError('Cannot access contents of url "chrome-error://chromewebdata/". Extension manifest must request permission to access this host.').code).toBe('restricted');
  });
  it('その他は other（上限時間まで再試行）', () => {
    expect(classifyInjectError('No frame with id 3 in tab 5.').code).toBe('other');
  });
});

describe('足りないオリジン (H2)', () => {
  it('読める URL の最初のオリジン。読めなければ originUnknown', () => {
    expect(missingOrigin(undefined, 'https://a.test/x?y')).toEqual({ origin: 'https://a.test' });
    expect(missingOrigin(undefined, 'chrome://newtab')).toEqual({ originUnknown: true });
    expect(missingOrigin()).toEqual({ originUnknown: true });
  });
});

describe('再開時に操作するか (H1)', () => {
  const a = { index: 2, stepId: 'stp_c' };
  it('操作済みの印が同じ手順・位置にあれば、操作せず観測だけ', () => {
    expect(stepEntryMode({ position: 2, actedResume: { position: 2, stepId: 'stp_c', acted: true, startedAt: 'x' } }, a)).toBe('observe-only');
  });
  it('印がない・別の手順・別の位置なら操作する', () => {
    expect(stepEntryMode({ position: 2 }, a)).toBe('act');
    expect(stepEntryMode({ position: 2, actedResume: { position: 2, stepId: 'stp_other', acted: true, startedAt: 'x' } }, a)).toBe('act');
    expect(stepEntryMode({ position: 3, actedResume: { position: 2, stepId: 'stp_c', acted: true, startedAt: 'x' } }, { index: 3, stepId: 'stp_c' })).toBe('act');
  });
});

describe('停止の確定 (M1)', () => {
  it('手順の実行中は実行側で確定し、そうでなければその場で確定する', () => {
    expect(stopMode(true)).toBe('defer');
    expect(stopMode(false)).toBe('finish-now');
  });
  it('実行中だった手順を ok にも pending（未実行）にもしない', () => {
    for (const acted of ['yes', 'possibly', 'no'] as const) {
      const r = stoppedStepResult('s', 't0', acted, 't1');
      expect(r.status).not.toBe('ok');
      expect(r.status).not.toBe('pending');
      expect(r.reason).toMatch(/停止時に実行中/);
      expect(r.acted).toBe(acted);
      expect(r.stoppedWhileRunning).toBe(true);
      expect(r.endedAt).toBe('t1');
    }
    expect(stoppedStepResult('s', 't0', 'possibly', 't1')).toMatchObject({ status: 'failed', reason: expect.stringMatching(/可能性/) });
    expect(stoppedStepResult('s', 't0', 'no', 't1').status).toBe('skipped');
  });
});

describe('replay:run の応答の扱い (M2 / L2)', () => {
  const base = { acted: false, docChanged: false, failedSend: false, pastDeadline: false };
  it('応答待ちの時間切れ: 操作の確認があれば possibly、なければ no', () => {
    expect(decideRunReply({ ...base, reply: 'timeout', acted: true })).toMatchObject({ kind: 'fail', acted: 'possibly' });
    expect(decideRunReply({ ...base, reply: 'timeout' })).toMatchObject({ kind: 'fail', acted: 'no' });
  });
  it('同じ文書で応答を受け取れたらそれを使う（acted は確認の有無）', () => {
    expect(decideRunReply({ ...base, reply: { status: 'failed', reason: '要素がない' } })).toEqual({ kind: 'use-reply', acted: 'no' });
    expect(decideRunReply({ ...base, reply: { status: 'ok' }, acted: true })).toEqual({ kind: 'use-reply', acted: 'yes' });
  });
  it('操作後に文書が切り替わった: 操作し直さず観測だけ', () => {
    expect(decideRunReply({ ...base, reply: undefined, acted: true, docChanged: true, failedSend: true })).toEqual({ kind: 'observe-after-act', acted: 'yes' });
    expect(decideRunReply({ ...base, reply: undefined, acted: true, failedSend: true })).toEqual({ kind: 'observe-after-act', acted: 'possibly' });
  });
  it('失敗の応答と文書の切り替わりが同時なら、受け取れた理由を残す', () => {
    const d1 = decideRunReply({ ...base, reply: { status: 'failed', reason: '対象要素が 2 件に一致した' }, docChanged: true });
    expect(d1).toEqual({ kind: 'retry', lastReason: '対象要素が 2 件に一致した' });
    const d2 = decideRunReply({ ...base, reply: undefined, failedSend: true, pastDeadline: true, lastReason: '対象要素が 2 件に一致した' });
    expect(d2).toEqual({ kind: 'fail', reason: '対象要素が 2 件に一致した', acted: 'no' });
    const d3 = decideRunReply({ ...base, reply: undefined, failedSend: true, pastDeadline: true });
    expect(d3).toMatchObject({ kind: 'fail', reason: 'ページとの接続が切れ、操作できなかった' });
  });
});

describe('移動 (L3)', () => {
  it('# だけが違う移動は同一文書内。# なしへの移動は読み込み。現在の URL が読めなければ unknown', () => {
    expect(isSameDocumentNavigation('https://a.test/p?q=1', 'https://a.test/p?q=1#sec')).toBe(true);
    expect(isSameDocumentNavigation('https://a.test/p#a', 'https://a.test/p#b')).toBe(true);
    expect(isSameDocumentNavigation('https://a.test/p#a', 'https://a.test/p')).toBe(false);
    expect(isSameDocumentNavigation('https://a.test/p', 'https://a.test/q#a')).toBe(false);
    expect(isSameDocumentNavigation(undefined, 'https://a.test/p#a')).toBe('unknown');
    expect(isSameDocumentNavigation(undefined, 'https://a.test/p')).toBe(false);
  });
  it('再読み込みは現在の URL へ GET で移動し直す（# は外す。読めなければ記録の URL）', () => {
    expect(reloadTarget('https://a.test/p?x=1#top', 'https://a.test/old')).toEqual({ url: 'https://a.test/p?x=1', droppedFragment: true, usedRecorded: false });
    expect(reloadTarget(undefined, 'https://a.test/old')).toEqual({ url: 'https://a.test/old', droppedFragment: false, usedRecorded: true });
    expect(reloadTarget(undefined, undefined)).toBeNull();
  });
  it('計画の reload には再生方法の注記が付く', () => {
    const plan = buildReplayPlan({ id: 'scn_1' }, [mkStep(1, { kind: 'reload' })]);
    expect(plan[0]).toMatchObject({ kind: 'navigate', reload: true, note: RELOAD_AS_GET_NOTE });
  });
});

describe('取り込みと操作前の画面の参照 (M4)', () => {
  const NOW = '2026-11-17T09:00:00.000Z';
  const src = () => {
    const a = mkStep(1, {}, 'src');
    const b = mkStep(2, { beforeScreenshot: { status: 'captured', artifactId: `shot_${a.id}`, capturedAt: '2026-11-16T10:00:59.500Z', refStepId: a.id, basis: 'previous-observation' } }, 'src');
    return { a, b, arts: [...mkArtifacts(a), ...mkArtifacts(b)] };
  };
  const copy = (steps: ReturnType<typeof mkStep>[], arts: ReturnType<typeof mkArtifacts>, stepIds: string[], copyArtifacts: boolean) =>
    planStepCopy({ kind: 'scenario', scenario: { id: 'src', name: '元', groups: [] }, steps, artifacts: arts }, { scenario: mkScenario('dst'), steps: [] }, { stepIds, copyArtifacts, now: NOW });

  it('参照先も取り込むと、新しい手順 ID と成果物 ID に付け替える', () => {
    const { a, b, arts } = src();
    const p = copy([a, b], arts, [a.id, b.id], true);
    const nb = p.steps[1];
    expect(nb.beforeScreenshot).toEqual({ status: 'captured', artifactId: `shot_${p.idMap[a.id]}`, capturedAt: '2026-11-16T10:00:59.500Z', refStepId: p.idMap[a.id], basis: 'previous-observation' });
    expect(p.artifacts.some((x) => x.id === nb.beforeScreenshot!.artifactId)).toBe(true);
    expect(JSON.stringify(nb.beforeScreenshot)).not.toContain(a.id);
  });
  it('参照先を取り込まない場合は理由つきの未取得（取り込み元を指さない）', () => {
    const { a, b, arts } = src();
    const p = copy([a, b], arts, [b.id], true);
    expect(p.steps[0].beforeScreenshot).toMatchObject({ status: 'skipped', reasonCode: 'ref-not-imported', basis: 'previous-observation' });
    expect(p.steps[0].beforeScreenshot!.artifactId).toBeUndefined();
    expect(p.steps[0].beforeScreenshot!.refStepId).toBeUndefined();
    expect(p.steps[0].beforeScreenshot!.reason).toBeTruthy();
  });
  it('画像をコピーしない場合も理由つきの未取得', () => {
    const { a, b, arts } = src();
    const p = copy([a, b], arts, [a.id, b.id], false);
    expect(p.steps[1].beforeScreenshot).toMatchObject({ status: 'skipped', reasonCode: 'not-imported' });
    expect(p.steps[1].beforeScreenshot!.artifactId).toBeUndefined();
  });
  it('参照先の画像が取り込めなかった場合は failed', () => {
    const { a, b, arts } = src();
    const p = copy([a, b], arts.filter((x) => x.id !== `shot_${a.id}`), [a.id, b.id], true);
    expect(p.steps[1].beforeScreenshot).toMatchObject({ status: 'failed', reasonCode: 'artifact-missing' });
  });
  it('未取得の参照は状態と理由だけを残す', () => {
    const r = remapBeforeScreenshot({ status: 'skipped', reasonCode: 'scrolled', reason: 'スクロールした', basis: 'previous-observation' }, { idMap: {}, copyArtifacts: true, srcById: new Map(), stepById: new Map() });
    expect(r).toEqual({ status: 'skipped', reasonCode: 'scrolled', reason: 'スクロールした', basis: 'previous-observation' });
  });
});

describe('文書の切り替わり（documentId による判定）', () => {
  it('トップと対象フレームの documentId が同じなら、タブの読み込み状態が変わっても切り替わりとしない', () => {
    expect(documentChanged({ top: 'T1', target: 'F1' }, { top: 'T1', target: 'F1' }, true)).toEqual({ changed: false, basis: 'document-id' });
  });
  it('トップまたは対象フレームの documentId が変われば切り替わり', () => {
    expect(documentChanged({ top: 'T1', target: 'F1' }, { top: 'T2', target: 'F1' }, false).changed).toBe(true);
    expect(documentChanged({ top: 'T1', target: 'F1' }, { top: 'T1', target: 'F2' }, false).changed).toBe(true);
  });
  it('対象フレームに到達できなければ切り替わり。応答がない・documentId が取れない場合はタブの読み込み状態で判断する', () => {
    expect(documentChanged({ top: 'T1' }, 'unreachable', false)).toEqual({ changed: true, basis: 'unreachable' });
    expect(documentChanged({ top: 'T1' }, 'unknown', false)).toEqual({ changed: false, basis: 'tab-status' });
    expect(documentChanged({}, { top: 'T1' }, true)).toEqual({ changed: true, basis: 'tab-status' });
  });
});

describe('診断ログ', () => {
  it('同じ出来事が続く場合は回数だけ数え、上限を超えた分は件数だけ残す', () => {
    let n = 0;
    const d = new DiagLog(() => `t${n++}`);
    expect(d.empty).toBe(true);
    d.add('フレームを特定できない'); d.add('フレームを特定できない'); d.add('フレームを特定できない');
    d.add('別の出来事');
    const s = d.snapshot();
    expect(s.log).toEqual([{ at: 't0', text: 'フレームを特定できない', repeat: 3, lastAt: 't2' }, { at: 't3', text: '別の出来事' }]);
    for (let i = 0; i < 200; i++) d.add(`e${i}`);
    expect(d.snapshot().log.length).toBe(80);
    expect(d.snapshot().truncated).toBe(200 - 78);
  });
  it('スナップショットは後の追加の影響を受けない', () => {
    const d = new DiagLog();
    d.add('a');
    const s = d.snapshot();
    d.add('a');
    expect(s.log[0].repeat).toBeUndefined();
  });
});

const SC = { id: 'scn_1' };
describe('操作の後に続く遷移の連鎖（リダイレクト・自動送信）', () => {
  const nav = (seq: number, url: string) => mkStep(seq, { kind: 'navigation', navigation: { toUrl: url }, target: undefined });
  it('操作の後の連続した遷移はすべて待機にし、途中の URL を直接開かない。途中の遷移は後続の遷移先でも一致とみなす', () => {
    const steps = [
      mkStep(1, { kind: 'click' }),
      nav(2, 'https://example.test/apply/direct/flow_000'),
      nav(3, 'https://example.test/switch/content'),
      nav(4, 'https://example.test/view.jssps?im_mark=abc&token=1'),
      mkStep(5, { kind: 'click' }),
    ];
    const plan = buildReplayPlan(SC, steps);
    expect(plan.map((a) => a.kind)).toEqual(['click', 'wait', 'wait', 'wait', 'click']);
    expect(plan.some((a) => a.kind === 'navigate')).toBe(false);
    const w2 = plan[1].wait, w4 = plan[3].wait;
    expect(w2).toMatchObject({ kind: 'url-matches', isRegex: true });
    const re = new RegExp(w2.value!);
    for (const u of ['https://example.test/apply/direct/flow_000', 'https://example.test/switch/content', 'https://example.test/view.jssps?im_mark=zzz&token=9']) expect(re.test(u)).toBe(true);
    expect(re.test('https://example.test/other')).toBe(false);
    // 連鎖の最後は自分の URL だけ（クエリのトークンは条件に含めない）
    expect(w4).toEqual({ kind: 'url-matches', value: 'https://example.test/view.jssps' });
    expect(plan[1].note).toContain('リダイレクト');
    expect(plan[3].note).toContain('リダイレクト');
  });
  it('正規表現の記号を含む URL はエスケープする', () => {
    const plan = buildReplayPlan(SC, [mkStep(1, { kind: 'click' }), nav(2, 'https://example.test/forma(2f)view(5f)a.jssps'), nav(3, 'https://example.test/b+c')]);
    const re = new RegExp(plan[1].wait.value!);
    expect(re.test('https://example.test/forma(2f)view(5f)a.jssps')).toBe(true);
    expect(re.test('https://example.test/forma2fview5fa.jssps')).toBe(false);
  });
  it('連鎖でない単独の遷移は従来どおり部分一致。操作でない手順に続く遷移は navigate', () => {
    const plan = buildReplayPlan(SC, [mkStep(1, { kind: 'click' }), nav(2, 'https://example.test/a?x=1'), mkStep(3, { kind: 'wait', origin: 'authored', target: undefined }), nav(4, 'https://example.test/b')]);
    expect(plan[1].wait).toEqual({ kind: 'url-matches', value: 'https://example.test/a' });
    expect(plan[1].note).toBeUndefined();
    expect(plan[3]).toMatchObject({ kind: 'navigate', url: 'https://example.test/b' });
  });
  it('人が指定した待機条件は連鎖の既定より優先する', () => {
    const plan = buildReplayPlan(SC, [mkStep(1, { kind: 'click' }), nav(2, 'https://example.test/a'), { ...nav(3, 'https://example.test/b'), replay: { wait: { kind: 'text-present', value: '申請' } } }]);
    expect(plan[2].wait).toEqual({ kind: 'text-present', value: '申請' });
  });
});
