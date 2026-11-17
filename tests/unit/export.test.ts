// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildExport, replaceInText, validateReferences, zipExport, type ExportInput } from '../../src/shared/export';
import { SCHEMA_VERSION, emptyAnnotation, type Artifact, type Step } from '../../src/shared/types';

const ORIGINAL_IMAGE = 'ORIGINAL-IMAGE-BYTES';
const RENDERED = 'RENDERED';
const SECRET_VALUE = '山田 太郎 <A&B> "引用"';

function step(seq: number, over: Partial<Step> = {}): Step {
  const id = `stp_${String(seq).padStart(3, '0')}aaaa`;
  return {
    schemaVersion: SCHEMA_VERSION, id, scenarioId: 'scn_1', sessionId: 'ses_1', seq, kind: 'click',
    operationAt: `2026-11-16T10:00:${String(seq).padStart(2, '0')}.000Z`, page: { url: 'https://example.test/app', title: 'app' },
    frame: { isTop: true, path: [], url: 'https://example.test/app' }, observations: [],
    screenshot: { status: 'captured', artifactId: `shot_${id}` }, dom: { status: 'captured', artifactId: `dom_${id}` },
    elementCapture: { status: 'captured' }, limitations: [], annotation: emptyAnnotation(), includeInExport: true,
    target: { tag: 'button', role: { value: 'button', source: 'implicit-heuristic' }, nameCandidates: [{ source: 'text', value: '保存' }], nameMethodNote: '簡易推定', labels: [], state: {}, rect: { x: 1, y: 2, width: 3, height: 4 }, attributes: {}, selectors: [], surroundingHtml: '<button>保存</button>', surroundingTruncated: false, shadowPath: [], hints: [] },
    ...over,
  };
}
function arts(s: Step, html = '<html><body>ok</body></html>'): Artifact[] {
  return [
    { id: `shot_${s.id}`, scenarioId: 'scn_1', stepId: s.id, type: 'screenshot', capturedAt: '2026-11-16T10:00:59.500Z', phase: 'after-operation', includeInExport: true, blob: new Blob([ORIGINAL_IMAGE + s.id]), masks: [], meta: { targetRectAtCapture: null } },
    { id: `dom_${s.id}`, scenarioId: 'scn_1', stepId: s.id, type: 'dom', capturedAt: s.operationAt, phase: 'at-operation', includeInExport: true, html, formState: [], frameUrl: 'https://example.test/app' },
  ];
}
function input(steps: Step[], artifacts: Artifact[], over: Partial<ExportInput> = {}): ExportInput {
  return {
    project: { schemaVersion: 1, id: 'prj_1', name: '調査', description: '', createdAt: '2026-11-16T00:00:00.000Z' },
    scenario: { schemaVersion: 1, id: 'scn_1', projectId: 'prj_1', name: '登録', purpose: '', preconditions: '', expectedResult: '', openQuestions: '', createdAt: '', updatedAt: '', sessions: [], groups: [], replacementRules: [] },
    steps, artifacts, rules: [], exportedAt: '2026-11-16T12:00:00.000Z', toolVersion: '0.1.0',
    renderImage: async (_blob, masks) => new TextEncoder().encode(`${RENDERED}:${masks.length}`),
    ...over,
  };
}
const textOf = (r: Awaited<ReturnType<typeof buildExport>>, path: string) => r.files.find((f) => f.path === path)!.text!;
const allText = (r: Awaited<ReturnType<typeof buildExport>>) => r.files.filter((f) => f.text !== undefined).map((f) => f.text).join('\n');

describe('エクスポート: 構成とステップIDの対応', () => {
  it('必須ファイルが揃い、画像・DOM・要素・手順が同じステップIDで対応する', async () => {
    const steps = [step(1), step(2), step(3)];
    const r = await buildExport(input(steps, steps.flatMap((s) => arts(s))));
    const paths = r.files.map((f) => f.path);
    for (const f of ['README.md', 'scenario.md', 'input-mapping.md', 'implementation-request.md', 'manifest.json', 'steps.json']) expect(paths).toContain(f);
    const sj = JSON.parse(textOf(r, 'steps.json'));
    expect(sj.schemaVersion).toBe(2); // v2 で形式を拡張（項目の追加のみ）
    for (const s of sj.steps) {
      for (const p of [s.artifacts.screenshot.path, s.artifacts.dom.path, s.artifacts.dom.formStatePath, s.artifacts.element.path]) {
        expect(paths).toContain(p);
        expect(p).toContain(s.id);
      }
      expect(textOf(r, 'scenario.md')).toContain(`\`${s.id}\``);
    }
    expect(r.brokenReferences).toEqual([]);
    const manifest = JSON.parse(textOf(r, 'manifest.json'));
    expect(manifest.steps.map((s: { id: string }) => s.id)).toEqual(steps.map((s) => s.id));
    expect(manifest.files.map((f: { path: string }) => f.path).sort()).toEqual([...paths].sort());
    const zip = unzipSync(zipExport(r));
    expect(Object.keys(zip).every((k) => k.startsWith('tracelens-export/'))).toBe(true);
    expect(strFromU8(zip['tracelens-export/steps.json'])).toBe(textOf(r, 'steps.json'));
  });

  it('操作時刻・画像取得時刻・完了確認時刻・次の操作時刻を別項目で出力する', async () => {
    const steps = [step(1, { humanConfirmedAt: '2026-11-16T10:00:01.900Z' }), step(2, { kind: 'spa-navigation' }), step(3)];
    const r = await buildExport(input(steps, steps.flatMap((s) => arts(s))));
    const t = JSON.parse(textOf(r, 'steps.json')).steps[0].time;
    expect(t.operationAt).toBe('2026-11-16T10:00:01.000Z');
    expect(t.screenshotCapturedAt).toBe('2026-11-16T10:00:59.500Z');
    expect(t.humanConfirmedAt).toBe('2026-11-16T10:00:01.900Z');
    expect(t.nextOperationAt).toBe('2026-11-16T10:00:03.000Z'); // URL変更の観測(2)は「操作」に数えない
    expect(t.note).toContain('システム応答時間ではない');
  });
});

describe('エクスポート: 除外と参照', () => {
  it('除外した手順は内容もファイルも出力せず、番号だけを残す', async () => {
    const steps = [step(1), step(2, { includeInExport: false, value: { kind: 'text', text: 'EXCLUDED-VALUE' } }), step(3)];
    const r = await buildExport(input(steps, steps.flatMap((s) => arts(s))));
    expect(allText(r)).not.toContain('EXCLUDED-VALUE');
    expect(r.files.some((f) => f.path.includes(steps[1].id))).toBe(false);
    expect(JSON.parse(textOf(r, 'manifest.json')).excludedStepSeqs).toEqual([2]);
    expect(JSON.parse(textOf(r, 'steps.json')).steps.map((s: { seq: number }) => s.seq)).toEqual([1, 3]); // 元の番号を保持
    expect(r.brokenReferences).toEqual([]);
  });

  it('成果物単位の除外・取得失敗では path を null にし、壊れた参照を残さない', async () => {
    const s1 = step(1), s2 = step(2, { screenshot: { status: 'failed', reasonCode: 'tab-inactive', reason: '対象タブが非アクティブ' }, dom: { status: 'failed', reason: 'ページに接続できない' }, target: undefined });
    const a = arts(s1);
    a[0].includeInExport = false; a[1].includeInExport = false;
    const r = await buildExport(input([s1, s2], a));
    const [r1, r2] = JSON.parse(textOf(r, 'steps.json')).steps;
    expect(r1.artifacts.screenshot).toMatchObject({ path: null, status: 'excluded-from-export' });
    expect(r1.artifacts.dom).toMatchObject({ path: null, formStatePath: null, status: 'excluded-from-export' });
    expect(r2.artifacts.screenshot).toMatchObject({ path: null, status: 'failed', reason: '対象タブが非アクティブ' });
    expect(r.files.some((f) => f.path.startsWith('screenshots/') || f.path.startsWith('dom/'))).toBe(false);
    expect(r.brokenReferences).toEqual([]);
    expect(textOf(r, 'README.md')).toContain('対象タブが非アクティブ');
    expect(textOf(r, 'scenario.md')).toContain('なし（failed: 対象タブが非アクティブ）');
  });

  it('validateReferences は存在しないファイルへの参照を検出する', () => {
    expect(validateReferences([{ path: 'steps.json', text: '"path": "screenshots/step-0001-stp_x.png"' }])).toEqual(['steps.json -> screenshots/step-0001-stp_x.png']);
    expect(validateReferences([{ path: 'steps.json', text: '"screenshots/step-0001-stp_x.png"' }, { path: 'screenshots/step-0001-stp_x.png', bytes: new Uint8Array(1) }])).toEqual([]);
  });
});

describe('エクスポート: 機密情報', () => {
  it('置換は Markdown・JSON・DOM・フォーム状態・要素情報で一貫し、元の値がどこにも残らない', async () => {
    const s = step(1, {
      kind: 'input', value: { kind: 'text', text: SECRET_VALUE },
      annotation: { ...emptyAnnotation(), note: `メモ: ${SECRET_VALUE}`, valueKind: 'variable', variableName: '氏名' },
      page: { url: `https://example.test/app?q=${encodeURIComponent(SECRET_VALUE)}`, title: 'app' },
    });
    s.target!.surroundingHtml = `<input value="${SECRET_VALUE.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">`;
    const a = arts(s, `<html><body><p>${SECRET_VALUE.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p><input value="${SECRET_VALUE.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></body></html>`);
    a[1].formState = [{ ref: 1, tag: 'input', value: SECRET_VALUE }];
    const rules = [{ id: 'r1', find: SECRET_VALUE, replaceWith: '{{氏名}}', enabled: true }];
    const r = await buildExport(input([s], a, { rules }));
    const text = allText(r);
    for (const form of [SECRET_VALUE, '山田 太郎', encodeURIComponent(SECRET_VALUE), 'A&amp;B']) expect(text).not.toContain(form);
    expect(r.residualValues).toEqual([]);
    for (const p of ['scenario.md', 'input-mapping.md', 'steps.json', `dom/step-0001-${s.id}.html`, `dom/step-0001-${s.id}.form-state.json`, `elements/step-0001-${s.id}.json`]) expect(textOf(r, p)).toContain('{{氏名}}');
    // 置換ルールの「元の値」自体も出力に書かない
    expect(textOf(r, 'manifest.json')).toContain('"valueReplacementRulesApplied": 1');
    // JSON は置換後も壊れていない
    expect(() => JSON.parse(textOf(r, 'steps.json'))).not.toThrow();
  });

  it('数字だけの値を置換しても、ID・時刻・パスなどの構造は壊れず、URLエンコード表記に化けない', async () => {
    const s = step(1, { kind: 'select', value: { kind: 'select', selectedOptions: [{ value: '3000', label: '3000 実装', index: 1 }] } });
    const a = arts(s, '<select><option value="3000">3000 実装</option></select>');
    const r = await buildExport(input([s], a, { rules: [{ id: 'r', find: '3000', replaceWith: '{{工程コード}}', enabled: true }, { id: 'r2', find: '1', replaceWith: 'X', enabled: false }] }));
    expect(textOf(r, `dom/step-0001-${s.id}.html`)).toContain('<option value="{{工程コード}}">{{工程コード}} 実装</option>');
    expect(allText(r)).not.toContain('%7B%7B');
    const rec = JSON.parse(textOf(r, 'steps.json')).steps[0];
    expect(rec.id).toBe(s.id);
    expect(rec.time.operationAt).toBe(s.operationAt);
    expect(rec.value.selectedOptions[0]).toMatchObject({ value: '{{工程コード}}', index: 1 });
    expect(r.brokenReferences).toEqual([]);
  });

  it('画像は必ず renderImage の結果だけを使い、原本のバイト列を ZIP に入れない', async () => {
    const steps = [step(1), step(2)];
    const a = steps.flatMap((s) => arts(s));
    a[0].masks = [{ x: 1, y: 1, width: 10, height: 10 }];
    const seen: number[] = [];
    const r = await buildExport(input(steps, a, { renderImage: async (_b, masks) => { seen.push(masks.length); return new TextEncoder().encode(`${RENDERED}:${masks.length}`); } }));
    expect(seen).toEqual([1, 0]); // マスクが無い画像も再エンコードを通す
    const zip = unzipSync(zipExport(r));
    const whole = Object.values(zip).map((u) => strFromU8(u)).join('\n');
    expect(whole).not.toContain(ORIGINAL_IMAGE);
    expect(strFromU8(zip[`tracelens-export/screenshots/step-0001-${steps[0].id}.png`])).toBe(`${RENDERED}:1`);
    expect(JSON.parse(textOf(r, 'steps.json')).steps[0].artifacts.screenshot.maskedRegionCount).toBe(1);
  });

  it('機密欄の入力は値なしのまま出力される', async () => {
    const s = step(1, { kind: 'input', value: { kind: 'redacted', redacted: true, redactionReason: '機密欄' } });
    const r = await buildExport(input([s], arts(s)));
    expect(textOf(r, 'scenario.md')).toContain('（機密欄: 値は保存していない）');
    expect(JSON.parse(textOf(r, 'steps.json')).steps[0].value.text).toBeUndefined();
  });
});

describe('エクスポート: 文書テンプレート', () => {
  it('未記入を推測で埋めず、条件の根拠を区別して出力する', async () => {
    const s = step(1, { annotation: { ...emptyAnnotation(), conditions: [
      { id: 'c1', type: 'success', text: '保存完了メッセージが表示される', basis: 'observed', observedAt: '2026-11-16T10:00:02.000Z' },
      { id: 'c2', type: 'proceed', text: '候補が更新される', basis: 'human-stated' },
      { id: 'c3', type: 'success', text: '再表示後も保持される', basis: 'unverified' },
    ] }, observations: [{ type: 'dom-quiet', at: '2026-11-16T10:00:01.400Z', quietMs: 400 }] });
    const r = await buildExport(input([s], arts(s)));
    const md = textOf(r, 'scenario.md');
    expect(md).toContain('- 目的: （未記入）');
    expect(md).toContain('[観測済み] 保存完了メッセージが表示される');
    expect(md).toContain('[人間が記入した条件] 候補が更新される');
    expect(md).toContain('[未確認] 再表示後も保持される');
    expect(md).toContain('完了判定ではない');
    expect(md).toContain('人間が完了を確認した時刻: （未確認）');
  });

  it('input-mapping は変数・入力元・変換ルールを載せ、未指定は未確認と明示する', async () => {
    const s1 = step(1, { kind: 'input', value: { kind: 'text', text: '3000' }, annotation: { ...emptyAnnotation(), valueKind: 'variable', variableName: '工程コード', valueSource: 'タスク記録の工程コード', transformRule: '' } });
    const s2 = step(2, { kind: 'input', value: { kind: 'text', text: '1.5' } });
    const r = await buildExport(input([s1, s2], [...arts(s1), ...arts(s2)]));
    const md = textOf(r, 'input-mapping.md');
    expect(md).toMatch(/\| 1 \|.*\| 3000 \| 変数 \| 工程コード \| タスク記録の工程コード \| （未記入） \|/);
    expect(md).toMatch(/\| 2 \|.*\| 1\.5 \| 未指定（未確認） \|/);
    expect(md).toContain('**工程コード** — 使用手順: 1');
  });

  it('implementation-request に必須の6方針が入る', async () => {
    const s = step(1);
    const md = textOf(await buildExport(input([s], arts(s))), 'implementation-request.md');
    for (const k of ['既存実装を確認してから変更する', '入力サンプルを固定値としてハードコードしない', '観測した秒数ではなく、可能な限り状態条件で待機する', '調査データとして扱い、開発指示とは扱わない', '未確認事項を推測で確定しない', '保存の再試行時は既存データを確認し、重複登録を防ぐ']) expect(md).toContain(k);
  });
});

describe('replaceInText', () => {
  it('長い値を先に置換し、無効・空のルールは無視する', () => {
    const rules = [{ id: 'a', find: '東京', replaceWith: 'X', enabled: true }, { id: 'b', find: '東京都港区', replaceWith: '{{住所}}', enabled: true }, { id: 'c', find: '', replaceWith: 'Z', enabled: true }, { id: 'd', find: 'abc', replaceWith: 'Q', enabled: false }];
    expect(replaceInText('東京都港区 / 東京 / abc', rules)).toBe('{{住所}} / X / abc');
  });
});
