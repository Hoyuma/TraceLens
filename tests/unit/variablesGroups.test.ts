// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { collectUsedVariables, extractVariableNames, resolveTemplate, sanitizeScenarioForSave, templateProblems, validateVariableName, validateVariables, effectiveVariableValues } from '../../src/shared/variables';
import { createGroup, flattenGroupTree, groupPath, groupPathNames, moveGroup, removeGroup, renameGroup, validateGroupParent, validateGroups } from '../../src/shared/groups';
import { buildExport } from '../../src/shared/export';
import { emptyAnnotation, type StepGroup } from '../../src/shared/types';
import { mkArtifacts, mkProject, mkScenario, mkStep, renderStub } from './fixtures';

describe('変数と値テンプレート', () => {
  it('テンプレートから有効な変数名を初出順・重複なしで取り出す', () => {
    expect(extractVariableNames('{{氏名}} / {{ 工程コード }} / {{氏名}} / {{a b}} / {{}}')).toEqual(['氏名', '工程コード']);
    expect(extractVariableNames(undefined)).toEqual([]);
    expect(templateProblems('{{a b}} {{x')).toHaveLength(2);
  });

  it('変数を解決し、未定義の変数は missing に入れて {{名前}} のまま残す', () => {
    expect(resolveTemplate('{{姓}} {{名}}', { 姓: '山田', 名: '太郎' })).toEqual({ ok: true, text: '山田 太郎', missing: [] });
    expect(resolveTemplate('{{姓}} {{名}}', { 姓: '山田' })).toEqual({ ok: false, text: '山田 {{名}}', missing: ['名'] });
    // 空文字は「空を指定」とみなす。値の中の {{…}} は再展開しない
    expect(resolveTemplate('[{{a}}]', { a: '' })).toEqual({ ok: true, text: '[]', missing: [] });
    expect(resolveTemplate('{{a}}', { a: '{{b}}', b: 'x' }).text).toBe('{{b}}');
    // プロトタイプの項目を値として拾わない
    expect(resolveTemplate('{{constructor}}', {}).ok).toBe(false);
  });

  it('変数名の検証と、一覧の重複検査', () => {
    expect(validateVariableName('工程コード').ok).toBe(true);
    expect(validateVariableName('a b').ok).toBe(false);
    expect(validateVariableName('{x}').ok).toBe(false);
    expect(validateVariableName('').ok).toBe(false);
    expect(validateVariables([{ id: '1', name: 'a' }, { id: '2', name: 'a' }])).toEqual(['変数名が重複している: a']);
  });

  it('secret の変数は保存前に既定値を落とし、実行時の値の合成でも既定値を使わない', () => {
    const s = sanitizeScenarioForSave(mkScenario('scn_1', { variables: [{ id: 'v1', name: 'pw', secret: true, defaultValue: 'SECRET' }, { id: 'v2', name: 'code', defaultValue: '3000' }] }));
    expect(s.variables![0]).toEqual({ id: 'v1', name: 'pw', secret: true });
    expect(s.variables![1].defaultValue).toBe('3000');
    expect(effectiveVariableValues([{ id: 'v1', name: 'pw', secret: true, defaultValue: 'LEAK' }, { id: 'v2', name: 'code', defaultValue: '3000' }], { x: '1' })).toEqual({ code: '3000', x: '1' });
  });

  it('シナリオ内で使われている変数を、値テンプレート・注記の変数名・置換ルールの置換後から集める', () => {
    const steps = [
      mkStep(2, { replay: { valueTemplate: '{{氏名}}様' } }),
      mkStep(1, { annotation: { ...emptyAnnotation(), valueKind: 'variable', variableName: '工程コード' } }),
      mkStep(3, { annotation: { ...emptyAnnotation(), valueKind: 'fixed', variableName: '使わない' } }),
    ];
    const used = collectUsedVariables(steps, [{ id: 'r1', find: 'x', replaceWith: '{{氏名}}', enabled: true }]);
    expect(used.map((u) => u.name)).toEqual(['工程コード', '氏名']);
    expect(used[1].usages).toEqual([{ kind: 'valueTemplate', stepId: steps[0].id, seq: 2 }, { kind: 'replacementRule', ruleId: 'r1' }]);
  });
});

describe('グループの入れ子', () => {
  const G: StepGroup[] = [
    { id: 'a', name: 'A', parentId: null },
    { id: 'b', name: 'B', parentId: 'a' },
    { id: 'c', name: 'C', parentId: 'b' },
    { id: 'd', name: 'D' },
  ];

  it('パスは祖先から自分の順で、存在しない ID は空', () => {
    expect(groupPathNames(G, 'c')).toEqual(['A', 'B', 'C']);
    expect(groupPath(G, 'zz')).toEqual([]);
    expect(flattenGroupTree(G).map((x) => [x.group.id, x.depth])).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 0]]);
  });

  it('自分自身・子孫を親にする移動（循環）を拒否する', () => {
    expect(validateGroupParent(G, 'a', 'c')).toMatchObject({ ok: false, reason: expect.stringContaining('循環') });
    expect(validateGroupParent(G, 'a', 'a').ok).toBe(false);
    expect(moveGroup(G, 'a', 'b').ok).toBe(false);
    const m = moveGroup(G, 'c', 'd');
    expect(m.ok && groupPathNames(m.groups, 'c')).toEqual(['D', 'C']);
    expect(validateGroups([{ id: 'x', name: 'X', parentId: 'y' }, { id: 'y', name: 'Y', parentId: 'x' }]).some((e) => e.includes('循環'))).toBe(true);
    // 循環したデータでもパスの計算は止まる
    expect(groupPath([{ id: 'x', name: 'X', parentId: 'y' }, { id: 'y', name: 'Y', parentId: 'x' }], 'x').length).toBe(2);
  });

  it('削除すると子グループと手順を親へ繰り上げ、手順は消さない', () => {
    const steps = [{ id: 's1', groupId: 'b' }, { id: 's2', groupId: 'c' }, { id: 's3', groupId: 'a' }];
    const r = removeGroup(G, steps, 'b');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.groups.map((g) => g.id)).toEqual(['a', 'c', 'd']);
    expect(r.groups.find((g) => g.id === 'c')!.parentId).toBe('a');
    expect(r.stepMoves).toEqual([{ stepId: 's1', groupId: 'a' }]);
    const top = removeGroup(G, steps, 'a');
    expect(top.ok && top.stepMoves).toEqual([{ stepId: 's3', groupId: undefined }]);
    expect(G.find((g) => g.id === 'c')!.parentId).toBe('b'); // 引数は変更しない
  });

  it('作成・名前変更は空の名前を拒否する', () => {
    expect(renameGroup(G, 'a', '  ').ok).toBe(false);
    const r = renameGroup(G, 'a', '新しい名前');
    expect(r.ok && r.groups[0].name).toBe('新しい名前');
    const c = createGroup(G, '子', 'c');
    expect(c.ok && groupPathNames(c.groups, c.group.id)).toEqual(['A', 'B', 'C', '子']);
    expect(createGroup(G, '子', 'nope').ok).toBe(false);
  });

  it('出力: steps.json は group（末端の名前）と groupPath を出し、Markdown は深さに応じた見出しにする', async () => {
    const groups: StepGroup[] = [{ id: 'g1', name: '登録', parentId: null }, { id: 'g2', name: '明細', parentId: 'g1' }];
    const steps = [mkStep(1, { groupId: 'g1' }), mkStep(2, { groupId: 'g2' }), mkStep(3, { groupId: 'g1' }), mkStep(4)];
    const r = await buildExport({ project: mkProject(), scenario: mkScenario('scn_1', { groups }), steps, artifacts: steps.flatMap((s) => mkArtifacts(s)), rules: [], exportedAt: 'x', toolVersion: '0', renderImage: renderStub });
    const sj = JSON.parse(r.files.find((f) => f.path === 'steps.json')!.text!);
    expect(sj.steps.map((s: { group: string | null }) => s.group)).toEqual(['登録', '明細', '登録', null]);
    expect(sj.steps.map((s: { groupPath: string[] }) => s.groupPath)).toEqual([['登録'], ['登録', '明細'], ['登録'], []]);
    expect(sj.groups[1]).toMatchObject({ id: 'g2', parentId: 'g1', path: ['登録', '明細'] });
    const md = r.files.find((f) => f.path === 'scenario.md')!.text!;
    expect(md).toContain('### グループ: 登録\n\n#### 手順 1');
    expect(md).toContain('#### グループ: 明細\n\n##### 手順 2');
    expect(md).toContain('### グループ: 登録（続き）\n\n#### 手順 3');
    expect(md).toContain('### （グループなし）\n\n#### 手順 4');
  });
});
