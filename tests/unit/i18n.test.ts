// 多言語 UI（日本語・英語）の辞書とエンジンの検査。出力ZIPの文言は対象外（言語設定の影響を受けない）。
import { describe, expect, it } from 'vitest';
import { ja } from '../../src/ui/dict-ja';
import { en } from '../../src/ui/dict-en';
import { DEFAULT_LANG, format, getLang, t, translate, trKnown, type TKey } from '../../src/ui/i18n';
import { stepSummary, waitLabel, captureProblems, kindLabel } from '../../src/shared/describe';
import { KIND_LABEL } from '../../src/shared/types';
import { mkStep } from './fixtures';

const params = (s: string) => [...s.replace(/{{[^}]*}}/g, '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('辞書', () => {
  it('ja と en のキーが一致し、空の文言がない', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
    for (const k of Object.keys(ja) as TKey[]) {
      expect(ja[k].length, `ja ${k}`).toBeGreaterThan(0);
      expect(en[k].length, `en ${k}`).toBeGreaterThan(0);
    }
  });
  it('ja と en で {パラメータ} の集合が同じ', () => {
    for (const k of Object.keys(ja) as TKey[]) expect(params(en[k]), k).toBe(params(ja[k]));
  });
  it('英訳は原則の表現を守る（セレクターを stable と呼ばない）', () => {
    for (const k of Object.keys(en) as TKey[]) expect(en[k], k).not.toMatch(/\bstable\b/i);
  });
  it('「未確認」は unverified、「未記入」は not entered', () => {
    expect(en['common.unverified']).toBe('unverified');
    expect(en['ann.notEntered']).toMatch(/not entered/i);
  });
});

describe('t() と書式', () => {
  it('既定の言語は日本語', () => {
    expect(DEFAULT_LANG).toBe('ja');
    expect(getLang()).toBe('ja');
    expect(t('common.close')).toBe('閉じる');
  });
  it('パラメータを置換する。未指定のパラメータと {{…}} はそのまま残す', () => {
    expect(translate('en', 'sp.stepProblem', { seq: 3, p: 'x' })).toBe('Step 3: x');
    expect(format('a {x} {y}', { x: 1 })).toBe('a 1 {y}');
    expect(translate('ja', 'sre.vtPh')).toBe('例: {{工程コード}}');
    expect(translate('en', 'sre.vtPh')).toContain('{{');
  });
  it('定型の検査メッセージだけ英語にし、それ以外はそのまま返す（既定の日本語では何も変えない）', () => {
    expect(trKnown('グループ名が空')).toBe('グループ名が空');
    expect(trKnown('知らない文言')).toBe('知らない文言');
  });
});

describe('shared の表示用ラベルは既定（日本語）で出力が変わらない', () => {
  it('stepSummary / waitLabel / kindLabel の既定は日本語、en を渡すと英語', () => {
    const s = mkStep(1, { kind: 'click' });
    expect(stepSummary(s)).toBe(stepSummary(s, 'ja'));
    expect(stepSummary(s)).toContain('クリック');
    expect(stepSummary(s, 'en')).toMatch(/^Click/);
    expect(waitLabel(undefined)).toBe('既定（DOM変化の短い静止）');
    expect(waitLabel({ kind: 'dom-quiet', quietMs: 400 }, 'en')).toBe('DOM changes settle (400ms)');
    expect(kindLabel('input')).toBe(KIND_LABEL.input);
    expect(kindLabel('input', 'en')).toBe('Input');
  });
  it('captureProblems: 取得待ちを除外できる。reason は記録データ由来でそのまま', () => {
    const s = mkStep(1, { kind: 'click' });
    s.screenshot = { status: 'failed', reason: '日本語の理由' };
    s.dom = { status: 'pending' };
    expect(captureProblems(s)).toEqual(['画面: 日本語の理由', 'DOM: 取得待ち']);
    expect(captureProblems(s, 'en')).toEqual(['Screen: 日本語の理由', 'DOM: pending capture']);
    expect(captureProblems(s, 'en', false)).toEqual(['Screen: 日本語の理由']);
  });
});
