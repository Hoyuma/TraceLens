// レビュー画面の純粋な処理（chrome API に依存しない。単体テスト対象）
// 利用者に見せる検査メッセージは ui/i18n の t()（既定は日本語）で組み立てる。
// 表示用のツリー、並べ替え・ドラッグの計画、再生設定の検査、再生開始前の計算をここに置く。
import { effectiveOrder, orderedSteps, reorderSteps } from '../shared/steps';
import { templateProblems, extractVariableNames, collectUsedVariables } from '../shared/variables';
import { DEFAULT_REPLAY_TIMEOUT_MS, type ReplayAction, type ReplayStepResult } from '../shared/replay';
import type { ReplayMode, ReplayRun } from '../shared/replay';
import { t } from '../ui/i18n';
import type { ReplacementRule, Scenario, ScenarioVariable, Step, StepGroup, StepReplayConfig, WaitCondition } from '../shared/types';

// ---- 手順のツリー ---------------------------------------------------------------

/**
 * グループの見出し。グループの手順が連続していないときは、表示・再生順を崩さないよう同じグループを複数の区間に分けて出す。
 * part は区間の番号（0 が最初）。stepCount はグループ全体（子孫を含む）の手順数。
 */
export interface GroupNode { type: 'group'; group: StepGroup; depth: number; children: TreeNode[]; stepCount: number; part: number }
export interface StepNode { type: 'step'; step: Step; depth: number }
export type TreeNode = GroupNode | StepNode;

/** 実際に使う親。存在しない親・循環に入っているグループは最上位として扱う。 */
export function effectiveParents(groups: readonly StepGroup[]): Map<string, string | null> {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = new Map<string, string | null>();
  for (const g of groups) {
    const p = g.parentId ?? null;
    if (!p || !byId.has(p)) { out.set(g.id, null); continue; }
    const seen = new Set<string>([g.id]);
    let cur: string | null = p;
    let cyclic = false;
    while (cur) {
      if (seen.has(cur)) { cyclic = true; break; }
      seen.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    out.set(g.id, cyclic ? null : p);
  }
  return out;
}

/** 手順の所属先（存在するグループのときだけ。それ以外は最上位） */
export function containerOf(step: Pick<Step, 'groupId'>, groups: readonly StepGroup[]): string | null {
  return step.groupId && groups.some((g) => g.id === step.groupId) ? step.groupId : null;
}

/**
 * 表示用のツリー。手順は表示・再生順（orderedSteps。buildReplayPlan と出力と同じ順）のまま並べ、順序を入れ替えない。
 * グループの手順が連続していない場合は、同じグループの見出しを区間ごとに繰り返す（part で区別）。
 * 手順を持たないグループは、親の最後の区間（親が無ければ最上位）の末尾にグループの order 順で置く。
 */
export function buildStepTree(groups: readonly StepGroup[], steps: readonly Step[]): TreeNode[] {
  const ordered = orderedSteps(steps);
  const parents = effectiveParents(groups);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const gIdx = new Map(groups.map((g, i) => [g.id, i]));
  const kids = new Map<string | null, StepGroup[]>();
  for (const g of groups) { const p = parents.get(g.id) ?? null; kids.set(p, [...(kids.get(p) ?? []), g]); }
  const direct = new Map<string | null, number>();
  for (const s of ordered) { const c = containerOf(s, groups); direct.set(c, (direct.get(c) ?? 0) + 1); }
  const countSteps = (id: string): number => (direct.get(id) ?? 0) + (kids.get(id) ?? []).reduce((n, c) => n + countSteps(c.id), 0);
  const pathOf = (id: string | null): string[] => {
    const out: string[] = [];
    for (let cur = id; cur; cur = parents.get(cur) ?? null) out.unshift(cur);
    return out;
  };

  const root: TreeNode[] = [];
  const parts = new Map<string, number>();
  const lastSection = new Map<string, GroupNode>();
  const open = (id: string, into: TreeNode[], depth: number): GroupNode => {
    const part = parts.get(id) ?? 0;
    parts.set(id, part + 1);
    const node: GroupNode = { type: 'group', group: byId.get(id)!, depth, children: [], stepCount: countSteps(id), part };
    into.push(node);
    lastSection.set(id, node);
    return node;
  };

  let stack: GroupNode[] = [];
  for (const s of ordered) {
    const path = pathOf(containerOf(s, groups));
    let keep = 0;
    while (keep < stack.length && keep < path.length && stack[keep].group.id === path[keep]) keep++;
    stack = stack.slice(0, keep);
    for (let i = keep; i < path.length; i++) stack.push(open(path[i], i === 0 ? root : stack[i - 1].children, i));
    (stack.length ? stack[stack.length - 1].children : root).push({ type: 'step', step: s, depth: path.length });
  }

  const sortKey = (g: StepGroup) => g.order ?? gIdx.get(g.id) ?? 0;
  const place = (g: StepGroup): GroupNode => {
    const have = lastSection.get(g.id);
    if (have) return have;
    const p = parents.get(g.id) ?? null;
    const parentNode = p ? place(byId.get(p)!) : null;
    return open(g.id, parentNode ? parentNode.children : root, parentNode ? parentNode.depth + 1 : 0);
  };
  for (const g of [...groups].sort((a, b) => sortKey(a) - sortKey(b))) if (!parts.has(g.id)) place(g);
  return root;
}

/** 木を平らにする（折りたたまれたグループの中は含めない） */
export function visibleNodes(tree: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: readonly TreeNode[]) => { for (const n of nodes) { out.push(n); if (n.type === 'group' && !collapsed.has(n.group.id)) walk(n.children); } };
  walk(tree);
  return out;
}

// ---- 並べ替え・ドラッグ -----------------------------------------------------------

export type OrderChange = { stepId: string; order: number };

/** 同じ所属先の中で 1 つ上 / 下へ。動かせないときは空配列。seq は変えない。 */
export function moveStepChanges(steps: readonly Step[], groups: readonly StepGroup[], stepId: string, dir: 'up' | 'down'): OrderChange[] {
  const ordered = orderedSteps(steps);
  const me = ordered.find((s) => s.id === stepId);
  if (!me) return [];
  const c = containerOf(me, groups);
  const sib = ordered.filter((s) => containerOf(s, groups) === c);
  const i = sib.findIndex((s) => s.id === stepId);
  if (dir === 'up') return i > 0 ? reorderSteps(steps, [stepId], sib[i - 1].id) : [];
  return i >= 0 && i < sib.length - 1 ? reorderSteps(steps, [sib[i + 1].id], stepId) : [];
}

export interface StepDropPlan { changes: OrderChange[]; groupId: string | undefined }

/** 手順を別の手順の前後へドロップする。移動先の手順と同じグループになる。 */
export function planStepDrop(steps: readonly Step[], groups: readonly StepGroup[], dragId: string, targetId: string, where: 'before' | 'after'): StepDropPlan | null {
  if (dragId === targetId) return null;
  const ordered = orderedSteps(steps);
  const target = ordered.find((s) => s.id === targetId);
  if (!target || !ordered.some((s) => s.id === dragId)) return null;
  let beforeId: string | null = targetId;
  if (where === 'after') {
    const rest = ordered.filter((s) => s.id !== dragId);
    const at = rest.findIndex((s) => s.id === targetId);
    beforeId = rest[at + 1]?.id ?? null;
  }
  const changes = reorderSteps(steps, [dragId], beforeId);
  return { changes, groupId: containerOf(target, groups) ?? undefined };
}

// ---- 再生設定の検査 ----------------------------------------------------------------

export const TIMEOUT_MAX_MS = 600_000;

function cssIsValid(sel: string): boolean {
  if (typeof document === 'undefined') return true;
  try { document.createDocumentFragment().querySelector(sel); return true; } catch { return false; }
}
function xpathIsValid(sel: string): boolean {
  if (typeof document === 'undefined' || typeof document.evaluate !== 'function') return true;
  try { document.evaluate(sel, document, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null); return true; } catch { return false; }
}

export function validateSelectorText(language: 'css' | 'xpath', selector: string): string | null {
  if (!selector.trim()) return t('logic.selEmpty');
  if (language === 'css' && !cssIsValid(selector.trim())) return t('logic.cssInvalid');
  if (language === 'xpath' && !xpathIsValid(selector.trim())) return t('logic.xpathInvalid');
  return null;
}

export function validateRegexText(text: string): string | null {
  try { new RegExp(text); return null; } catch (e) { return t('logic.regexInvalid', { msg: (e as Error).message }); }
}

export function validateWaitCondition(w: WaitCondition): string[] {
  const errs: string[] = [];
  switch (w.kind) {
    case 'none': break;
    case 'dom-quiet':
      if (w.quietMs !== undefined && !(Number.isFinite(w.quietMs) && w.quietMs > 0 && w.quietMs <= TIMEOUT_MAX_MS)) errs.push(t('logic.quietInvalid'));
      break;
    case 'element-present': case 'element-absent': {
      const e = validateSelectorText('css', w.value ?? '');
      if (e) errs.push(t('logic.waitElement', { e }));
      break;
    }
    case 'text-present': case 'url-matches':
      if (!w.value) errs.push(t('logic.waitValueEmpty'));
      else if (w.isRegex) { const e = validateRegexText(w.value); if (e) errs.push(e); }
      break;
  }
  return errs;
}

/** 再生設定の検査。問題がなければ空配列。 */
export function validateReplayConfig(c: StepReplayConfig): string[] {
  const errs: string[] = [];
  if (c.selector && c.selector.selector.trim()) { const e = validateSelectorText(c.selector.language, c.selector.selector); if (e) errs.push(t('logic.selOverride', { e })); }
  if (c.wait) errs.push(...validateWaitCondition(c.wait));
  if (c.timeoutMs !== undefined && !(Number.isFinite(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= TIMEOUT_MAX_MS)) errs.push(t('logic.timeoutRange', { max: TIMEOUT_MAX_MS }));
  if (c.valueTemplate !== undefined) errs.push(...templateProblems(c.valueTemplate));
  return errs;
}

/** 未指定の項目を落とす。何も残らなければ undefined。 */
export function cleanReplayConfig(c: StepReplayConfig): StepReplayConfig | undefined {
  const out: StepReplayConfig = {};
  if (c.skip) out.skip = true;
  if (c.valueTemplate !== undefined) out.valueTemplate = c.valueTemplate;
  if (c.selector && c.selector.selector.trim()) out.selector = { language: c.selector.language, selector: c.selector.selector.trim() };
  if (c.wait) {
    const w: WaitCondition = { kind: c.wait.kind };
    if (c.wait.value !== undefined && ['element-present', 'element-absent', 'text-present', 'url-matches'].includes(c.wait.kind)) w.value = c.wait.value;
    if (c.wait.isRegex && (c.wait.kind === 'text-present' || c.wait.kind === 'url-matches')) w.isRegex = true;
    if (c.wait.kind === 'dom-quiet' && c.wait.quietMs !== undefined) w.quietMs = c.wait.quietMs;
    out.wait = w;
  }
  if (c.onFail && c.onFail !== 'stop') out.onFail = c.onFail;
  if (c.timeoutMs !== undefined) out.timeoutMs = c.timeoutMs;
  return Object.keys(out).length ? out : undefined;
}

export function sameReplayConfig(a: StepReplayConfig | undefined, b: StepReplayConfig | undefined): boolean {
  return JSON.stringify(cleanReplayConfig(a ?? {}) ?? null) === JSON.stringify(cleanReplayConfig(b ?? {}) ?? null);
}

/** 値テンプレートに現れる変数のうち、シナリオに定義がないもの */
export function undefinedTemplateVariables(template: string | undefined, variables: readonly ScenarioVariable[]): string[] {
  const defined = new Set(variables.map((v) => v.name));
  return extractVariableNames(template).filter((n) => !defined.has(n));
}

// ---- 変数の使用状況 ------------------------------------------------------------------

export interface VariableReport {
  rows: { name: string; usedCount: number }[];
  /** 使われているが定義がない */
  undefinedNames: string[];
  /** 定義はあるが使われていない */
  unusedNames: string[];
}

export function variableReport(variables: readonly ScenarioVariable[], steps: readonly Step[], rules: readonly ReplacementRule[]): VariableReport {
  const used = collectUsedVariables(steps, rules);
  const usedMap = new Map(used.map((u) => [u.name, u.usages.length]));
  const defined = new Set(variables.map((v) => v.name));
  return {
    rows: variables.map((v) => ({ name: v.name, usedCount: usedMap.get(v.name) ?? 0 })),
    undefinedNames: used.map((u) => u.name).filter((n) => !defined.has(n)),
    unusedNames: variables.filter((v) => !usedMap.has(v.name)).map((v) => v.name),
  };
}

// ---- 再生の開始 ----------------------------------------------------------------------

export type ReplayTarget = 'all' | 'from-selected' | 'range' | 'only-selected';
export const REPLAY_TARGET_LABEL: Record<ReplayTarget, string> = {
  all: '全体', 'from-selected': '選択した手順から最後まで', range: '選択範囲（開始〜終了）', 'only-selected': '選択した手順だけ',
};
/** 画面に出す再生対象の名前（表示言語に従う。既定は REPLAY_TARGET_LABEL と同じ） */
export function replayTargetLabel(k: ReplayTarget): string {
  return t(({ all: 'logic.tAll', 'from-selected': 'logic.tFrom', range: 'logic.tRange', 'only-selected': 'logic.tOnly' } as const)[k]);
}

export function replayOptionsFor(target: ReplayTarget, sel: { selectedId?: string; fromId?: string; toId?: string }): { mode: ReplayMode; opts: { fromStepId?: string; toStepId?: string; onlyStepIds?: string[] } } | { error: string } {
  switch (target) {
    case 'all': return { mode: 'all', opts: {} };
    case 'from-selected':
      return sel.selectedId ? { mode: 'range', opts: { fromStepId: sel.selectedId } } : { error: t('logic.noFrom') };
    case 'range':
      return sel.fromId && sel.toId ? { mode: 'range', opts: { fromStepId: sel.fromId, toStepId: sel.toId } } : { error: t('logic.noFromTo') };
    case 'only-selected':
      return sel.selectedId ? { mode: 'step', opts: { onlyStepIds: [sel.selectedId] } } : { error: t('logic.noStep') };
  }
}

/** 計画が触れるページのオリジン（chrome.permissions.request の origins 形式。http / https のみ） */
export function planOriginPatterns(plan: readonly Pick<ReplayAction, 'url' | 'frameUrl'>[]): string[] {
  const out: string[] = [];
  const add = (u?: string) => {
    if (!u) return;
    try { const x = new URL(u); if (x.protocol === 'http:' || x.protocol === 'https:') { const p = `${x.origin}/*`; if (!out.includes(p)) out.push(p); } } catch { /* 無効な URL は無視 */ }
  };
  for (const a of plan) { add(a.url); add(a.frameUrl); }
  return out;
}

// ---- 再生結果の表示 -------------------------------------------------------------------

export function resultCounts(run: Pick<ReplayRun, 'results'> | undefined): Record<ReplayStepResult['status'], number> {
  const c: Record<ReplayStepResult['status'], number> = { ok: 0, failed: 0, skipped: 0, manual: 0, pending: 0 };
  for (const r of run?.results ?? []) c[r.status]++;
  return c;
}

export function timeoutLabel(ms?: number): string { return ms === undefined ? t('logic.timeoutDefault', { ms: DEFAULT_REPLAY_TIMEOUT_MS }) : `${ms} ms`; }

/** 並べ替え後の番号表示用: 表示順での位置（1 始まり）。seq と別に表示して「seq は変わらない」ことを示す。 */
export function displayPositions(steps: readonly Step[]): Map<string, number> {
  return new Map(orderedSteps(steps).map((s, i) => [s.id, i + 1]));
}

export function isReordered(steps: readonly Step[]): boolean {
  return steps.some((s) => s.order !== undefined && effectiveOrder(s) !== s.seq);
}

/** 記録中・再生中の制約（理由つき）。null なら可。 */
export function editLockReason(scenario: Pick<Scenario, 'id'>, recordingScenarioId?: string | null): string | null {
  return recordingScenarioId && recordingScenarioId === scenario.id ? t('logic.lockRecording') : null;
}
