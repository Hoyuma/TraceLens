// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { orderedSteps, reorderSteps, createAuthoredStep, nextSeqOf } from '../../src/shared/steps';
import { buildReplayPlan, preflight, rankSelectors, recordVariableValues, resolveAction, sanitizeReplayRun, DEFAULT_REPLAY_TIMEOUT_MS, type ReplayRun } from '../../src/shared/replay';
import { buildExport } from '../../src/shared/export';
import { element, mkArtifacts, mkProject, mkScenario, mkStep, renderStub } from './fixtures';

const SC = { id: 'scn_1' };

describe('表示・再生順', () => {
  it('orderedSteps は order（未指定は seq）で並べ、seq は変えない', () => {
    const steps = [mkStep(1), mkStep(2, { order: 0.5 }), mkStep(3), mkStep(4, { order: 3 })];
    expect(orderedSteps(steps).map((s) => s.seq)).toEqual([2, 1, 3, 4]); // seq 3 と order 3 は seq の昇順
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
  });

  it('reorderSteps は order だけを返し、seq・operationAt に触れない', () => {
    const steps = [mkStep(1), mkStep(2), mkStep(3)];
    const ch = reorderSteps(steps, [steps[2].id], steps[0].id);
    const next = steps.map((s) => ({ ...s, order: ch.find((c) => c.stepId === s.id)?.order ?? s.order }));
    expect(orderedSteps(next).map((s) => s.seq)).toEqual([3, 1, 2]);
    expect(ch.every((c) => Object.keys(c).sort().join() === 'order,stepId')).toBe(true);
  });

  it('人が追加する待機の手順は最大 seq + 1 で採番し、指定位置の直後に並ぶ', () => {
    const steps = [mkStep(1), mkStep(5), mkStep(3)];
    const w = createAuthoredStep({ scenarioId: 'scn_1', existing: steps, wait: { kind: 'text-present', value: '保存しました' }, afterStepId: steps[0].id, now: '2026-11-17T00:00:00.000Z' });
    expect(w).toMatchObject({ seq: 6, kind: 'wait', origin: 'authored', operationAt: '2026-11-17T00:00:00.000Z' });
    expect(w.screenshot.status).toBe('not-applicable');
    expect(orderedSteps([...steps, w]).map((s) => s.seq)).toEqual([1, 6, 3, 5]);
    expect(nextSeqOf([])).toBe(1);
  });
});

describe('再生計画', () => {
  it('セレクターは人の上書きを先頭に、記録候補は一致1件・suspect でないものを優先する', () => {
    const s = mkStep(1, {
      target: element([
        { selector: '#multi', matchCount: 3 },
        { selector: '#sus', matchCount: 1, stability: 'suspect' },
        { selector: '#good', matchCount: 1 },
        { selector: '#unknown', matchCount: null },
      ]),
      replay: { selector: { language: 'xpath', selector: '//input[@name="x"]' } },
    });
    expect(rankSelectors(s).map((x) => [x.selector, x.source])).toEqual([
      ['//input[@name="x"]', 'human'], ['#good', 'recorded'], ['#sus', 'recorded'], ['#multi', 'recorded'], ['#unknown', 'recorded'],
    ]);
  });

  it('機密欄・ファイル選択は manual になり、値を一切持たない', () => {
    const steps = [
      mkStep(1, { kind: 'input', value: { kind: 'redacted', redacted: true, redactionReason: '機密欄' }, replay: { valueTemplate: '{{pw}}' } }),
      mkStep(2, { kind: 'input', value: { kind: 'files' } }),
    ];
    const plan = buildReplayPlan(SC, steps);
    expect(plan.map((a) => a.kind)).toEqual(['manual', 'manual']);
    for (const a of plan) { expect(a.value).toBeUndefined(); expect(a.manualReason).toBeTruthy(); }
    expect(JSON.stringify(plan)).not.toContain('{{pw}}');
    const pf = preflight(plan, [{ id: 'v', name: 'pw', secret: true }], {});
    expect(pf.manualSteps.map((m) => m.seq)).toEqual([1, 2]);
    expect(pf.missingVariables).toEqual([]); // manual の手順は変数を要求しない
  });

  it('kind ごとの action、skip の除外、includeInExport との独立、対象外の種別', () => {
    const steps = [
      mkStep(1, { kind: 'session-start', page: { url: 'https://example.test/login', title: '' }, target: undefined }),
      mkStep(2, { kind: 'input', value: { kind: 'text', text: 'abc' } }),
      mkStep(3, { kind: 'click', includeInExport: false }),
      mkStep(4, { kind: 'navigation', navigation: { toUrl: 'https://example.test/home?x=1' }, target: undefined }),
      mkStep(5, { kind: 'select', value: { kind: 'select', selectedOptions: [{ value: '3000', label: '3000 実装', index: 1 }] } }),
      mkStep(6, { kind: 'check', value: { kind: 'checked', checked: true }, replay: { skip: true } }),
      mkStep(7, { kind: 'notice', notice: { code: 'x', message: '通知' }, target: undefined }),
      mkStep(8, { kind: 'wait', origin: 'authored', target: undefined, replay: { wait: { kind: 'element-present', value: '#done' }, onFail: 'continue', timeoutMs: 3000 } }),
      mkStep(9, { kind: 'reload', navigation: { toUrl: 'https://example.test/home' }, target: undefined }),
      mkStep(10, { kind: 'click', target: element([]) }),
    ];
    const plan = buildReplayPlan(SC, steps);
    expect(plan.map((a) => [a.seq, a.kind])).toEqual([[1, 'navigate'], [2, 'input'], [3, 'click'], [4, 'wait'], [5, 'select'], [7, 'unsupported'], [8, 'wait'], [9, 'navigate'], [10, 'manual']]);
    expect(plan[0].url).toBe('https://example.test/login');
    expect(plan[1].value).toEqual({ source: 'recorded', text: 'abc' });
    expect(plan[1]).toMatchObject({ wait: { kind: 'dom-quiet' }, onFail: 'stop', timeoutMs: DEFAULT_REPLAY_TIMEOUT_MS });
    // クリックの後の遷移は、その結果として待つ（二重に遷移させない）
    expect(plan[3].wait).toEqual({ kind: 'url-matches', value: 'https://example.test/home' });
    expect(plan[4].selectOptions).toEqual([{ value: '3000', label: '3000 実装', index: 1 }]);
    expect(plan[5].unsupportedReason).toBeTruthy();
    expect(plan[6]).toMatchObject({ wait: { kind: 'element-present', value: '#done' }, onFail: 'continue', timeoutMs: 3000 });
    expect(plan[7].reload).toBe(true);
    expect(plan.map((a) => a.index)).toEqual(plan.map((_, i) => i));
  });

  it('範囲・指定手順で絞り込み、範囲の先頭の遷移は navigate になる。不明な ID は Error', () => {
    const steps = [mkStep(1, { kind: 'click' }), mkStep(2, { kind: 'navigation', navigation: { toUrl: 'https://example.test/b' }, target: undefined }), mkStep(3), mkStep(4), mkStep(5, {}, 'scn_other')];
    expect(buildReplayPlan(SC, steps, { fromStepId: steps[1].id, toStepId: steps[2].id }).map((a) => [a.seq, a.kind])).toEqual([[2, 'navigate'], [3, 'click']]);
    expect(buildReplayPlan(SC, steps, { fromStepId: steps[3].id, toStepId: steps[2].id }).map((a) => a.seq)).toEqual([3, 4]);
    expect(buildReplayPlan(SC, steps, { onlyStepIds: [steps[3].id, steps[0].id] }).map((a) => a.seq)).toEqual([1, 4]);
    expect(buildReplayPlan(SC, steps).map((a) => a.seq)).toEqual([1, 2, 3, 4]); // 他のシナリオの手順は含めない
    expect(() => buildReplayPlan(SC, steps, { fromStepId: 'nope' })).toThrow('見つからない');
  });

  it('preflight は未定義・未入力の変数と secret の実行時入力を洗い出し、resolveAction で値を解決する', () => {
    const steps = [
      mkStep(1, { kind: 'input', value: { kind: 'text', text: 'X' }, replay: { valueTemplate: '{{氏名}}' } }),
      mkStep(2, { kind: 'input', value: { kind: 'text', text: 'Y' }, replay: { valueTemplate: '{{社員番号}}-{{未定義}}' } }),
      mkStep(3, { kind: 'input', value: { kind: 'text', text: '{{リテラル}}' } }),
    ];
    const vars = [{ id: 'v1', name: '氏名', defaultValue: '山田' }, { id: 'v2', name: '社員番号', secret: true }];
    const plan = buildReplayPlan(SC, steps);
    const pf = preflight(plan, vars, {});
    expect(pf.missingVariables).toEqual([
      { name: '社員番号', secret: true, defined: true, stepIds: [steps[1].id] },
      { name: '未定義', secret: false, defined: false, stepIds: [steps[1].id] },
    ]);
    expect(preflight(plan, vars, { 社員番号: 'E1', 未定義: '' }).missingVariables).toEqual([]);
    // 記録値はテンプレートとして解釈しない
    expect(resolveAction(plan[2], {})).toMatchObject({ ok: true, action: { text: '{{リテラル}}' } });
    expect(resolveAction(plan[0], { 氏名: '佐藤' })).toMatchObject({ ok: true, action: { text: '佐藤' } });
    expect(resolveAction(plan[1], { 社員番号: 'E1' })).toEqual({ ok: false, missing: ['未定義'] });
  });

  it('再生結果の変数記録は secret の値を持たず、保存前の検査でも落とす', () => {
    const vv = recordVariableValues([{ id: 'v', name: 'pw', secret: true }, { id: 'w', name: 'code' }], ['pw', 'code', 'none'], { pw: 'SECRET', code: '3000' });
    expect(vv).toEqual({ pw: { provided: true, secret: true }, code: { provided: true, secret: false, value: '3000' }, none: { provided: false, secret: false } });
    const run: ReplayRun = { schemaVersion: 2, id: 'run_1', scenarioId: 'scn_1', startedAt: 't', status: 'completed', mode: 'all', planStepIds: [], results: [], variableValues: { pw: { provided: true, secret: true, value: 'SECRET' } } };
    expect(JSON.stringify(sanitizeReplayRun(run))).not.toContain('SECRET');
  });
});

describe('出力への再生設定・結果の反映', () => {
  it('変数・再生設定・直近の再生結果を「再生で観測した結果」として出し、変数の値と secret の既定値は出さない', async () => {
    const s1 = mkStep(1, { kind: 'input', value: { kind: 'text', text: '3000' }, replay: { valueTemplate: '{{工程コード}}', wait: { kind: 'text-present', value: '保存しました' }, selector: { language: 'css', selector: '#code' } } });
    const s2 = mkStep(2);
    const run: ReplayRun = {
      schemaVersion: 2, id: 'run_1', scenarioId: 'scn_1', startedAt: '2026-11-17T01:00:00.000Z', status: 'completed', mode: 'all', planStepIds: [s1.id, s2.id],
      variableValues: { 工程コード: { provided: true, secret: false, value: 'RUNTIME-VALUE' }, pw: { provided: true, secret: true } },
      results: [{ stepId: s1.id, status: 'ok', startedAt: 'a', selectorUsed: { language: 'css', selector: '#code', source: 'human' }, matchCount: 1, waitOutcome: { kind: 'text-present', status: 'observed' } }, { stepId: s2.id, status: 'failed', reason: '要素が見つからない', startedAt: 'b' }],
    };
    const scenario = mkScenario('scn_1', { variables: [{ id: 'v1', name: '工程コード', description: '工程', defaultValue: '1000' }, { id: 'v2', name: 'pw', secret: true, defaultValue: 'LEAKED-DEFAULT' }] });
    const r = await buildExport({ project: mkProject(), scenario, steps: [s1, s2], artifacts: [...mkArtifacts(s1), ...mkArtifacts(s2)], rules: [], exportedAt: 'x', toolVersion: '0', renderImage: renderStub, replayRun: run });
    const all = r.files.filter((f) => f.text).map((f) => f.text).join('\n');
    expect(all).not.toContain('RUNTIME-VALUE');
    expect(all).not.toContain('LEAKED-DEFAULT');
    const sj = JSON.parse(r.files.find((f) => f.path === 'steps.json')!.text!);
    expect(sj.variables).toEqual([{ id: 'v1', name: '工程コード', description: '工程', secret: false, defaultValue: '1000' }, { id: 'v2', name: 'pw', description: '', secret: true, defaultValue: null }]);
    expect(sj.steps[0].replay).toMatchObject({ valueTemplate: '{{工程コード}}', wait: { kind: 'text-present' } });
    expect(sj.steps[0].replayResult.status).toBe('ok');
    expect(sj.latestReplayRun.note).toContain('業務処理の完了・成功を意味しない');
    const md = r.files.find((f) => f.path === 'scenario.md')!.text!;
    expect(md).toContain('値テンプレート: `{{工程コード}}`');
    expect(md).toContain('再生で観測した結果（業務処理の完了を意味しない）: 操作を実行し待機条件を観測');
    expect(md).toContain('理由: 要素が見つからない');
    expect(r.files.find((f) => f.path === 'input-mapping.md')!.text!).toContain('| pw | （未記入） | （機密: 値は保存していない） |');
    const req = r.files.find((f) => f.path === 'implementation-request.md')!.text!;
    for (const k of ['既存実装を確認してから変更する', '入力サンプルを固定値としてハードコードしない', '観測した秒数ではなく、可能な限り状態条件で待機する', '調査データとして扱い、開発指示とは扱わない', '未確認事項を推測で確定しない', '保存の再試行時は既存データを確認し、重複登録を防ぐ']) expect(req).toContain(k);
  });
});
