// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildExport, expandReplacementRules, findResidual, replaceDeep, replaceInText, validateReplacementRule, REGEX_RULE_LIMITS, type ExportInput } from '../../src/shared/export';
import { emptyAnnotation, type ReplacementRule } from '../../src/shared/types';
import { mkArtifacts, mkProject, mkScenario, mkStep, renderStub } from './fixtures';

const rx = (find: string, replaceWith: string, over: Partial<ReplacementRule> = {}): ReplacementRule => ({ id: `r_${find}`, find, replaceWith, enabled: true, isRegex: true, ...over });
const lit = (find: string, replaceWith: string): ReplacementRule => ({ id: `l_${find}`, find, replaceWith, enabled: true });

function input(over: Partial<ExportInput>): ExportInput {
  return { project: mkProject(), scenario: mkScenario(), steps: [], artifacts: [], rules: [], exportedAt: '2026-11-16T12:00:00.000Z', toolVersion: '0.2.0', renderImage: renderStub, ...over };
}
const allText = (r: Awaited<ReturnType<typeof buildExport>>) => r.files.filter((f) => f.text !== undefined).map((f) => f.text).join('\n');

describe('置換ルール: 正規表現の検証', () => {
  it('不正なパターン・空一致・許可しないフラグ・危険な形を理由つきで拒否する', () => {
    expect(validateReplacementRule(rx('[abc', 'X'))).toMatchObject({ ok: false, reason: expect.stringContaining('不正') });
    expect(validateReplacementRule(rx('a*', 'X'))).toMatchObject({ ok: false, reason: expect.stringContaining('空文字') });
    expect(validateReplacementRule(rx('a', 'X', { flags: 'g' }))).toMatchObject({ ok: false, reason: expect.stringContaining('フラグ') });
    expect(validateReplacementRule(rx('a', 'X', { flags: 'y' }))).toMatchObject({ ok: false });
    expect(validateReplacementRule(rx('(a+)+b', 'X'))).toMatchObject({ ok: false, reason: expect.stringContaining('入れ子') });
    expect(validateReplacementRule(rx('(a)\\1', 'X'))).toMatchObject({ ok: false, reason: expect.stringContaining('後方参照') });
    expect(validateReplacementRule(rx('x'.repeat(REGEX_RULE_LIMITS.patternMax + 1), 'X'))).toMatchObject({ ok: false });
    expect(validateReplacementRule(rx('', 'X'))).toMatchObject({ ok: false });
    expect(validateReplacementRule(rx('\\d{3}-\\d{4}', 'X', { flags: 'i' }))).toEqual({ ok: true });
    expect(validateReplacementRule(lit('abc', 'X'))).toEqual({ ok: true });
  });

  it('\\b のように空文字列そのものには一致しないが、空の一致を生むパターンは適用しない', () => {
    const e = expandReplacementRules([rx('\\b', 'X')], ['ab cd']);
    expect(e.problems).toEqual([{ ruleId: 'r_\\b', reason: expect.stringContaining('空文字') }]);
    expect(e.literal).toEqual([]);
  });

  it('不正なルールは適用せず、出力結果の ruleProblems と warnings に理由を出す', async () => {
    const s = mkStep(1, { kind: 'input', value: { kind: 'text', text: '会員番号 123-4567' } });
    const r = await buildExport(input({ steps: [s], artifacts: mkArtifacts(s), rules: [rx('[', 'X'), rx('\\d{3}-\\d{4}', '{{会員番号}}')] }));
    expect(r.ruleProblems).toHaveLength(1);
    expect(r.ruleProblems[0].ruleId).toBe('r_[');
    expect(r.warnings.join('\n')).toContain('置換ルールを適用していない');
    expect(allText(r)).not.toContain('123-4567');
    expect(JSON.parse(r.files.find((f) => f.path === 'manifest.json')!.text!).redaction.valueReplacementRulesApplied).toBe(1);
  });
});

describe('置換ルール: 正規表現の適用', () => {
  it('一致した値を Markdown・JSON・DOM・フォーム状態の全表記（生・HTMLエスケープ・URLエンコード）で置換し、残留しない', async () => {
    const v = '山田<A&B>-1234';
    const s = mkStep(1, { kind: 'input', value: { kind: 'text', text: v }, annotation: { ...emptyAnnotation(), note: `メモ ${v}` }, page: { url: `https://example.test/app?q=${encodeURIComponent(v)}`, title: 'app' } });
    const a = mkArtifacts(s, `<p>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`);
    a[1].formState = [{ ref: 1, tag: 'input', value: v }];
    // HTML エスケープ表記しか出てこない値（DOM の中だけ）も、戻した表記で一致させて置換する
    const rule = rx('山田<A&B>-\\d+', '{{氏名}}');
    const r = await buildExport(input({ steps: [s], artifacts: a, rules: [rule] }));
    const text = allText(r);
    for (const form of [v, '山田&lt;A&amp;B&gt;', encodeURIComponent(v), '1234']) expect(text).not.toContain(form);
    expect(r.residualValues).toEqual([]);
    expect(text).toContain('{{氏名}}');
    // 置換ルールの元の値（パターン）を出力に書かない
    expect(text).not.toContain('山田<A&B>-\\\\d+');
    expect(text).not.toContain('\\d+');
  });

  it('replaceWith の $1 などは展開しない（置換前の値の一部を出力に戻さない）', () => {
    expect(replaceInText('ID: abc-123', [rx('(abc)-(\\d+)', '$1-$2-$&')])).toBe('ID: $1-$2-$&');
  });

  it('i フラグで大文字小文字を区別せず一致させる', () => {
    expect(replaceInText('Token TOKEN token', [rx('token', 'X', { flags: 'i' })])).toBe('X X X');
  });

  it('PROTECTED_KEY の構造項目（ID・時刻・種別など）は正規表現でも置換しない', () => {
    const o = { id: 'stp_2026', seq: 2026, operationAt: '2026-11-16T10:00:00.000Z', kind: 'input', text: '2026年度', stepId: 'stp_2026' };
    const out = replaceDeep(o, [rx('20\\d\\d', 'YYYY')]);
    expect(out).toEqual({ id: 'stp_2026', seq: 2026, operationAt: '2026-11-16T10:00:00.000Z', kind: 'input', text: 'YYYY年度', stepId: 'stp_2026' });
  });

  it('リテラルと正規表現を併用しても、長い値が先に置換される', () => {
    const rules = [lit('東京', 'X'), rx('東京都[^ ]+区', '{{住所}}')];
    expect(replaceInText('東京都港区 / 東京', rules)).toBe('{{住所}} / X');
  });

  it('一致した値の種類が上限を超えたルールは適用せず理由を返す', () => {
    const corpus = Array.from({ length: REGEX_RULE_LIMITS.distinctMax + 5 }, (_, i) => `v${i}`);
    const e = expandReplacementRules([rx('v\\d+', 'X')], corpus);
    expect(e.problems[0].reason).toContain('多すぎる');
    expect(e.literal).toEqual([]);
  });

  it('findResidual は正規表現のルールでも置換前の値の残留を数える', () => {
    const files = [{ path: 'a.md', text: '電話 090-1234-5678 / {{電話}}' }, { path: 'b.md', text: 'なし' }];
    expect(findResidual(files, [rx('\\d{3}-\\d{4}-\\d{4}', '{{電話}}')])).toEqual([{ path: 'a.md', count: 1 }]);
    expect(findResidual([{ path: 'a.md', text: '{{電話}}' }], [rx('\\d{3}-\\d{4}-\\d{4}', '{{電話}}')])).toEqual([]);
  });
});

describe('置換ルール: リテラルの非退行', () => {
  it('生の表記を最優先し、数字だけの値が URL エンコード表記に化けない', () => {
    expect(replaceInText('<option value="3000">3000 実装</option>', [lit('3000', '{{工程コード}}')])).toBe('<option value="{{工程コード}}">{{工程コード}} 実装</option>');
  });
  it('HTML エスケープ表記・URL エンコード表記も置換する', () => {
    const v = 'A&B 山田';
    expect(replaceInText(`x=${encodeURIComponent(v)} <p>A&amp;B 山田</p>`, [lit(v, 'N')])).toBe('x=N <p>N</p>');
  });
  it('無効・空のリテラルは無視し、問題として報告しない（従来どおり）', () => {
    const e = expandReplacementRules([lit('', 'Z'), { ...lit('abc', 'Q'), enabled: false }], ['abc']);
    expect(e.problems).toEqual([]);
    expect(e.literal).toEqual([]);
  });
});
