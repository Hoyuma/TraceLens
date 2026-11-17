// シナリオ変数と値テンプレート（純粋な処理。chrome API に依存しない）
// テンプレートの書式は {{変数名}}（前後の空白は無視）。{{ をそのまま書くための書き方はない。
// 値テンプレートとして扱うのは Step.replay.valueTemplate だけで、記録された値はテンプレートとして解釈しない。
import { newId, type ReplacementRule, type Scenario, type ScenarioVariable, type Step } from './types';

export const VARIABLE_NAME_MAX = 64;
/** 文字・数字・結合文字と _ - ・ . のみ。空白や {} は使えない。 */
const NAME_RE = /^[\p{L}\p{N}\p{M}_\-・.]+$/u;
const TEMPLATE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export function validateVariableName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name) return { ok: false, reason: '変数名が空' };
  if (name.length > VARIABLE_NAME_MAX) return { ok: false, reason: `変数名が長すぎる（${VARIABLE_NAME_MAX} 文字まで）` };
  if (!NAME_RE.test(name)) return { ok: false, reason: '変数名に使えない文字が含まれている（文字・数字と _ - ・ . のみ）' };
  return { ok: true };
}

/** テンプレート中の変数名（有効な名前だけ、初出順、重複なし） */
export function extractVariableNames(template: string | undefined | null): string[] {
  if (!template) return [];
  const out: string[] = [];
  for (const m of template.matchAll(TEMPLATE_RE)) { const n = m[1]; if (validateVariableName(n).ok && !out.includes(n)) out.push(n); }
  return out;
}

/** テンプレートの書式の問題（無効な変数名の {{…}}、閉じていない {{）。 */
export function templateProblems(template: string | undefined | null): string[] {
  if (!template) return [];
  const errs: string[] = [];
  for (const m of template.matchAll(TEMPLATE_RE)) { const v = validateVariableName(m[1]); if (!v.ok) errs.push(`{{${m[1]}}}: ${v.reason}`); }
  const rest = template.replace(TEMPLATE_RE, '');
  if (rest.includes('{{') || rest.includes('}}')) errs.push('閉じていない {{ または }} がある');
  return errs;
}

export interface ResolveResult { ok: boolean; text: string; missing: string[] }

/**
 * {{name}} を values の値で置き換える。値が無い（undefined）変数は missing に入れ、テキストには {{name}} のまま残す。
 * 空文字は「値として空を指定した」とみなす。置換後の値はさらに展開しない（1 回だけ）。
 */
export function resolveTemplate(template: string, values: Readonly<Record<string, string | undefined>>): ResolveResult {
  const missing: string[] = [];
  const text = template.replace(TEMPLATE_RE, (whole, name: string) => {
    if (!validateVariableName(name).ok) { if (!missing.includes(name)) missing.push(name); return whole; }
    const v = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    if (v === undefined) { if (!missing.includes(name)) missing.push(name); return whole; }
    return v;
  });
  return { ok: missing.length === 0, text, missing };
}

/** 変数一覧の検査（名前の妥当性・重複）。問題がなければ空配列。 */
export function validateVariables(vars: readonly ScenarioVariable[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const v of vars) {
    const r = validateVariableName(v.name);
    if (!r.ok) errs.push(`「${v.name}」: ${r.reason}`);
    if (seen.has(v.name)) errs.push(`変数名が重複している: ${v.name}`);
    seen.add(v.name);
  }
  return errs;
}

/** 保存前に機密の変数の既定値を落とす（保存 API はこれを必ず通す） */
export function sanitizeVariables(vars: readonly ScenarioVariable[]): ScenarioVariable[] {
  return vars.map((v) => {
    if (!v.secret) return { ...v };
    const { defaultValue: _drop, ...rest } = v;
    return { ...rest, secret: true };
  });
}

export function sanitizeScenarioForSave(s: Scenario): Scenario {
  return s.variables ? { ...s, variables: sanitizeVariables(s.variables) } : s;
}

export function newVariable(name: string, over: Partial<Omit<ScenarioVariable, 'id' | 'name'>> = {}): ScenarioVariable {
  return sanitizeVariables([{ id: newId('var'), name, ...over }])[0];
}

export type VariableUsage =
  | { kind: 'valueTemplate'; stepId: string; seq: number }
  | { kind: 'annotation'; stepId: string; seq: number }
  | { kind: 'replacementRule'; ruleId: string };

/**
 * シナリオ内で使われている変数名を集める。
 * 対象: 手順の replay.valueTemplate、annotation.variableName（値の種別が変数のもの）、置換ルールの replaceWith の {{…}}。
 */
export function collectUsedVariables(steps: readonly Step[], rules: readonly ReplacementRule[] = []): { name: string; usages: VariableUsage[] }[] {
  const map = new Map<string, VariableUsage[]>();
  const add = (name: string, u: VariableUsage) => { map.set(name, [...(map.get(name) ?? []), u]); };
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
    for (const n of extractVariableNames(s.replay?.valueTemplate)) add(n, { kind: 'valueTemplate', stepId: s.id, seq: s.seq });
    const an = s.annotation?.variableName?.trim();
    if (an && s.annotation.valueKind === 'variable') add(an, { kind: 'annotation', stepId: s.id, seq: s.seq });
  }
  for (const r of rules) for (const n of extractVariableNames(r.replaceWith)) add(n, { kind: 'replacementRule', ruleId: r.id });
  return [...map].map(([name, usages]) => ({ name, usages }));
}

/** 変数の既定値（secret は既定値を持たない）と、与えられた値を合わせる。与えられた値が優先。 */
export function effectiveVariableValues(vars: readonly ScenarioVariable[], provided: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const v of vars) if (!v.secret && v.defaultValue !== undefined) out[v.name] = v.defaultValue;
  for (const [k, x] of Object.entries(provided)) if (x !== undefined) out[k] = x;
  return out;
}
