import { describe, expect, it } from 'vitest';
import {
  buildStepTree, cleanReplayConfig, editLockReason, effectiveParents, moveStepChanges, planOriginPatterns, planStepDrop, replayOptionsFor,
  sameReplayConfig, undefinedTemplateVariables, validateReplayConfig, validateSelectorText, validateWaitCondition, variableReport, visibleNodes,
  type GroupNode, type TreeNode,
} from '../../src/review/logic';
import { reorderSteps } from '../../src/shared/steps';
import type { StepGroup } from '../../src/shared/types';
import { mkScenario, mkStep } from './fixtures';

const g = (id: string, parentId: string | null = null, order?: number): StepGroup => ({ id, name: id, parentId, order });
const ids = (nodes: TreeNode[]): string[] => nodes.map((n) => (n.type === 'step' ? `s${n.step.seq}` : `G:${n.group.id}[${ids(n.children).join(',')}]`));

describe('手順のツリー', () => {
  it('グループは中の最初の手順の位置に置き、入れ子にする', () => {
    const steps = [mkStep(1), mkStep(2, { groupId: 'A' }), mkStep(3, { groupId: 'B' }), mkStep(4), mkStep(5, { groupId: 'A' })];
    const tree = buildStepTree([g('A'), g('B', 'A')], steps);
    expect(ids(tree)).toEqual(['s1', 'G:A[s2,G:B[s3],s5]', 's4']);
    expect((tree[1] as GroupNode).stepCount).toBe(3);
  });

  it('並べ替え（order）を反映し、手順のないグループは末尾へ', () => {
    const steps = [mkStep(1), mkStep(2, { order: 0.5 }), mkStep(3)];
    expect(ids(buildStepTree([g('E')], steps))).toEqual(['s2', 's1', 's3', 'G:E[]']);
  });

  it('循環・存在しない親のグループは最上位として扱い、取りこぼさない', () => {
    const groups = [g('A', 'B'), g('B', 'A'), g('C', 'ghost')];
    const eff = effectiveParents(groups);
    expect(eff.get('A')).toBeNull();
    expect(eff.get('C')).toBeNull();
    const steps = [mkStep(1, { groupId: 'A' }), mkStep(2, { groupId: 'B' }), mkStep(3, { groupId: 'C' }), mkStep(4, { groupId: 'nogroup' })];
    const flat = visibleNodes(buildStepTree(groups, steps), new Set());
    expect(flat.filter((n) => n.type === 'step')).toHaveLength(4);
  });

  it('折りたたんだグループの中は visibleNodes に含めない', () => {
    const steps = [mkStep(1, { groupId: 'A' }), mkStep(2)];
    const tree = buildStepTree([g('A')], steps);
    expect(visibleNodes(tree, new Set(['A'])).map((n) => n.type)).toEqual(['group', 'step']);
    expect(visibleNodes(tree, new Set()).map((n) => n.type)).toEqual(['group', 'step', 'step']);
  });
});

describe('並べ替えとドラッグ', () => {
  const steps = [mkStep(1), mkStep(2, { groupId: 'A' }), mkStep(3, { groupId: 'A' }), mkStep(4)];
  const groups = [g('A')];

  it('上下の移動は同じグループ内の隣と入れ替え、seq は触らない', () => {
    const ch = moveStepChanges(steps, groups, steps[2].id, 'up');
    expect(ch.length).toBeGreaterThan(0);
    const next = steps.map((s) => ({ ...s, order: ch.find((c) => c.stepId === s.id)?.order ?? s.order }));
    const ord = [...next].sort((a, b) => (a.order ?? a.seq) - (b.order ?? b.seq)).map((s) => s.seq);
    expect(ord).toEqual([1, 3, 2, 4]);
    expect(next.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
  });

  it('グループの先頭で上へ、末尾で下へは動かせない', () => {
    expect(moveStepChanges(steps, groups, steps[1].id, 'up')).toEqual([]);
    expect(moveStepChanges(steps, groups, steps[2].id, 'down')).toEqual([]);
    expect(moveStepChanges(steps, groups, steps[0].id, 'up')).toEqual([]);
  });

  it('手順へのドロップは前後に置き、移動先の手順のグループになる', () => {
    const p = planStepDrop(steps, groups, steps[3].id, steps[1].id, 'before')!;
    expect(p.groupId).toBe('A');
    expect(p.changes).toEqual(reorderSteps(steps, [steps[3].id], steps[1].id));
    const after = planStepDrop(steps, groups, steps[0].id, steps[3].id, 'after')!;
    expect(after.groupId).toBeUndefined();
    expect(planStepDrop(steps, groups, steps[0].id, steps[0].id, 'before')).toBeNull();
  });
});

describe('再生設定の検査', () => {
  it('セレクターの構文を検査する', () => {
    expect(validateSelectorText('css', '#a > .b')).toBeNull();
    expect(validateSelectorText('css', '###')).not.toBeNull();
    expect(validateSelectorText('css', '  ')).not.toBeNull();
    expect(validateSelectorText('xpath', "//button[text()='保存']")).toBeNull();
    expect(validateSelectorText('xpath', '//[')).not.toBeNull();
  });

  it('待機条件: 正規表現の不正・値の欠落をエラーにする', () => {
    expect(validateWaitCondition({ kind: 'none' })).toEqual([]);
    expect(validateWaitCondition({ kind: 'text-present', value: '(', isRegex: true })).toHaveLength(1);
    expect(validateWaitCondition({ kind: 'text-present', value: '(', isRegex: false })).toEqual([]);
    expect(validateWaitCondition({ kind: 'url-matches', value: '' })).toHaveLength(1);
    expect(validateWaitCondition({ kind: 'element-present', value: '.toast' })).toEqual([]);
    expect(validateWaitCondition({ kind: 'element-absent', value: '###' })).toHaveLength(1);
    expect(validateWaitCondition({ kind: 'dom-quiet', quietMs: 0 })).toHaveLength(1);
  });

  it('値テンプレート・タイムアウトも検査する', () => {
    expect(validateReplayConfig({ valueTemplate: '{{ok}}' })).toEqual([]);
    expect(validateReplayConfig({ valueTemplate: '{{ bad name }}' }).length).toBeGreaterThan(0);
    expect(validateReplayConfig({ valueTemplate: '{{x' }).length).toBeGreaterThan(0);
    expect(validateReplayConfig({ timeoutMs: -1 }).length).toBeGreaterThan(0);
    expect(validateReplayConfig({ selector: { language: 'css', selector: '' } })).toEqual([]); // 空は「未指定」
  });

  it('cleanReplayConfig は既定値・空の指定を落とす', () => {
    expect(cleanReplayConfig({})).toBeUndefined();
    expect(cleanReplayConfig({ skip: false, onFail: 'stop', selector: { language: 'css', selector: ' ' } })).toBeUndefined();
    expect(cleanReplayConfig({ onFail: 'continue', wait: { kind: 'dom-quiet', quietMs: 300, value: 'x', isRegex: true } })).toEqual({ onFail: 'continue', wait: { kind: 'dom-quiet', quietMs: 300 } });
    expect(sameReplayConfig(undefined, { skip: false })).toBe(true);
    expect(sameReplayConfig(undefined, { skip: true })).toBe(false);
  });

  it('未定義の変数を拾う', () => {
    expect(undefinedTemplateVariables('{{a}}-{{b}}', [{ id: '1', name: 'a' }])).toEqual(['b']);
  });
});

describe('変数の使用状況', () => {
  it('使用数・未定義・未使用を数える', () => {
    const steps = [mkStep(1, { replay: { valueTemplate: '{{a}}{{b}}' } }), mkStep(2, { replay: { valueTemplate: '{{a}}' } })];
    const r = variableReport([{ id: '1', name: 'a' }, { id: '2', name: 'unused' }], steps, []);
    expect(r.rows).toEqual([{ name: 'a', usedCount: 2 }, { name: 'unused', usedCount: 0 }]);
    expect(r.undefinedNames).toEqual(['b']);
    expect(r.unusedNames).toEqual(['unused']);
  });
});

describe('再生の開始', () => {
  it('対象から範囲を決める', () => {
    expect(replayOptionsFor('all', {})).toEqual({ mode: 'all', opts: {} });
    expect(replayOptionsFor('from-selected', { selectedId: 'x' })).toEqual({ mode: 'range', opts: { fromStepId: 'x' } });
    expect(replayOptionsFor('only-selected', { selectedId: 'x' })).toEqual({ mode: 'step', opts: { onlyStepIds: ['x'] } });
    expect(replayOptionsFor('range', { fromId: 'a', toId: 'b' })).toEqual({ mode: 'range', opts: { fromStepId: 'a', toStepId: 'b' } });
    expect('error' in replayOptionsFor('only-selected', {})).toBe(true);
  });

  it('権限を求めるオリジンは http/https の重複なしだけ', () => {
    const o = planOriginPatterns([
      { url: 'https://a.example.test/x?y=1', frameUrl: 'https://a.example.test/p' }, { frameUrl: 'http://b.example.test:8080/q' },
      { frameUrl: 'chrome://settings' }, { frameUrl: 'not a url' }, { frameUrl: '' },
    ]);
    expect(o).toEqual(['https://a.example.test/*', 'http://b.example.test:8080/*']);
  });
});

describe('記録中の制約', () => {
  it('記録中のシナリオだけ理由つきで不可', () => {
    const sc = mkScenario('scn_1');
    expect(editLockReason(sc, 'scn_1')).toContain('記録中');
    expect(editLockReason(sc, 'scn_2')).toBeNull();
    expect(editLockReason(sc, undefined)).toBeNull();
  });
});
