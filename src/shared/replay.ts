// 再生の計画と結果の型（純粋な処理。chrome API・自動化技術に依存しない）
// 実行（ページ上の操作・待機の観測）は後続の再生エンジン（src/replay/, src/background/）が担う。
//
// 方針:
//  - 計画は orderedSteps（表示・再生順）から、replay.skip の手順を除いて作る。includeInExport とは独立
//    （出力対象外にした手順も、skip でなければ再生する。出力と再生は目的が違うため）。
//  - 機密欄（value.kind === 'redacted' / value.redacted）とファイル選択は自動入力せず manual にする。
//    manual の action は値を一切持たない（記録時点で値を保存していない）。
//  - 待機は状態条件で行う。記録時の操作間隔（時刻差）は待機時間に使わない。
//  - 結果の ok は「操作を実行し、待機条件を観測できた」という意味で、業務処理の完了を意味しない。
import { orderedSteps } from './steps';
import { extractVariableNames, resolveTemplate } from './variables';
import type { FrameHop, ISO, Scenario, ScenarioVariable, SelectorCandidate, Step, StepKind, WaitCondition } from './types';
import { stepSummary } from './describe';

/** 1 手順あたりの既定の上限時間（対象要素の出現待ち + 操作 + 待機条件の観測） */
export const DEFAULT_REPLAY_TIMEOUT_MS = 10_000;
/** 操作後の既定の待機: DOM 変化の短い静止（記録時の静止判定と同じ 400ms） */
export const DEFAULT_QUIET_MS = 400;
/** 既定の静止待ちの上限。超えても失敗にはせず waitOutcome を timeout とする */
export const DEFAULT_QUIET_MAX_MS = 2_500;
export const DEFAULT_WAIT: Readonly<WaitCondition> = Object.freeze({ kind: 'dom-quiet', quietMs: DEFAULT_QUIET_MS });
export const DEFAULT_ON_FAIL: 'stop' | 'continue' = 'stop';

export type ReplayActionKind = 'click' | 'input' | 'select' | 'check' | 'key' | 'navigate' | 'wait' | 'manual' | 'unsupported';

export interface ReplaySelector {
  language: 'css' | 'xpath';
  selector: string;
  /** human: 人が指定した上書き / recorded: 記録時の候補 */
  source: 'human' | 'recorded';
  candidateKind?: SelectorCandidate['kind'];
  scope: 'document' | 'shadow-root';
  /** 記録時点の一致件数（人の指定は null）。再生時の一致件数ではない。 */
  recordedMatchCount: number | null;
  /** 安定性は検証していない（unverified / suspect のみ）。人の指定は unverified。 */
  stability: 'unverified' | 'suspect';
}

/** 値の出どころ。recorded の text はテンプレートとして解釈しない。 */
export type ReplayValue =
  | { source: 'template'; template: string }
  | { source: 'recorded'; text: string };

export interface ReplayAction {
  stepId: string;
  seq: number;
  /** 計画の中での位置（0 始まり） */
  index: number;
  kind: ReplayActionKind;
  stepKind: StepKind;
  label: string;
  /** 試す順。エンジンは先頭から、一致が 1 件のものを使う（複数一致・0 件は次へ）。 */
  selectors: ReplaySelector[];
  /** トップからのフレーム経路（記録時点）。トップは空配列。 */
  frame: FrameHop[];
  frameUrl: string;
  shadowPath: { hostSelector: string; mode: 'open' }[];
  /** input / select の値。テンプレートなら {{変数}} を含む。manual / 機密欄では持たない。 */
  value?: ReplayValue;
  /** select: 記録時に選んだ option（テンプレート指定がない場合に使う） */
  selectOptions?: { value: string; label: string; index: number }[];
  /** check: 記録時の状態 */
  checked?: boolean;
  key?: Step['key'];
  /**
   * navigate: 移動先。reload は記録された再読み込み。
   * 再生では、フォームの再送信（重複登録）を避けるため、現在の URL へ GET で移動し直す（RELOAD_AS_GET_NOTE）。
   */
  url?: string;
  reload?: boolean;
  /** (追加) 再生の仕方についての注記（reload の再生方法など）。UI・結果に表示する */
  note?: string;
  /** 操作後の待機条件（wait 手順では待機そのもの） */
  wait: WaitCondition;
  onFail: 'stop' | 'continue';
  timeoutMs: number;
  /** manual: 人が操作して続行する理由 */
  manualReason?: string;
  /** unsupported: 再生対象外の理由（エンジンは skipped として結果に残す） */
  unsupportedReason?: string;
}

/** 変数を解決した action（SW → 再生スクリプト）。text はテンプレートを解決した値か記録値。 */
export type ResolvedReplayAction = Omit<ReplayAction, 'value'> & { text?: string };

/** 記録した再読み込みの再生方法（制限として UI・結果に出す） */
export const RELOAD_AS_GET_NOTE = '記録した再読み込みは、フォームの再送信（重複登録）を避けるため、現在の URL へ GET で移動し直して再生する（ブラウザの再読み込みとは異なる。URL の # 以降は外す）';

export interface ReplayPlanOptions { fromStepId?: string; toStepId?: string; onlyStepIds?: string[] }

const OPERATION_KINDS = new Set<StepKind>(['click', 'input', 'select', 'check', 'key']);
const UNSUPPORTED: Partial<Record<StepKind, string>> = {
  notice: '通知の記録のため再生しない',
  'manual-capture': '画面保存の記録のため再生しない',
  'element-note': '要素注記の記録のため再生しない',
  'session-end': '記録終了の記録のため再生しない',
};

/** 記録された候補を並べる: 記録時の一致 1 件 → suspect でない、の順に優先（同順位は記録の順）。 */
export function rankSelectors(step: Pick<Step, 'target' | 'replay'>): ReplaySelector[] {
  const out: ReplaySelector[] = [];
  const o = step.replay?.selector;
  if (o && o.selector.trim()) out.push({ language: o.language, selector: o.selector.trim(), source: 'human', scope: 'document', recordedMatchCount: null, stability: 'unverified' });
  const rec = (step.target?.selectors ?? []).map((c, i) => ({ c, i, tier: (c.matchCount === 1 ? 0 : 2) + (c.stability === 'suspect' ? 1 : 0) }));
  rec.sort((a, b) => a.tier - b.tier || a.i - b.i);
  for (const { c } of rec) out.push({ language: c.language, selector: c.selector, source: 'recorded', candidateKind: c.kind, scope: c.scope, recordedMatchCount: c.matchCount, stability: c.stability });
  return out;
}

const isRedacted = (s: Step) => s.value?.kind === 'redacted' || !!s.value?.redacted;

function urlContainsValue(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url; }
}

/**
 * 再生計画を作る（scenario に属する手順だけを使う）。範囲の ID が見つからない場合は Error を投げる。
 * - 対象: orderedSteps のうち replay.skip でないもの（includeInExport とは独立）
 * - from / to: 表示・再生順での範囲（両端を含む）。逆順なら入れ替える。
 * - onlyStepIds: 指定した手順だけ（範囲と併用可）
 * - navigation / spa-navigation: 計画の先頭、または直前の手順が操作でない場合は navigate。
 *   直前が操作（クリック等）の場合は、その操作の結果として起きる遷移とみなし url-matches の wait にする
 *   （同じ遷移を二重に起こして重複登録につながるのを避ける）。
 */
export function buildReplayPlan(scenario: Pick<Scenario, 'id'>, steps: readonly Step[], opts: ReplayPlanOptions = {}): ReplayAction[] {
  const all = orderedSteps(steps.filter((s) => s.scenarioId === scenario.id));
  let list = all.filter((s) => !s.replay?.skip);
  if (opts.fromStepId || opts.toStepId) {
    const pos = (id: string | undefined, label: string) => {
      if (!id) return -1;
      const i = all.findIndex((s) => s.id === id);
      if (i < 0) throw new Error(`${label}の手順が見つからない: ${id}`);
      return i;
    };
    let a = opts.fromStepId ? pos(opts.fromStepId, '開始') : 0;
    let b = opts.toStepId ? pos(opts.toStepId, '終了') : all.length - 1;
    if (a > b) [a, b] = [b, a];
    const inRange = new Set(all.slice(a, b + 1).map((s) => s.id));
    list = list.filter((s) => inRange.has(s.id));
  }
  if (opts.onlyStepIds) {
    const only = new Set(opts.onlyStepIds);
    for (const id of only) if (!all.some((s) => s.id === id)) throw new Error(`指定した手順が見つからない: ${id}`);
    list = list.filter((s) => only.has(s.id));
  }

  return list.map((s, index) => {
    const r = s.replay ?? {};
    const base: ReplayAction = {
      stepId: s.id, seq: s.seq, index, kind: 'unsupported', stepKind: s.kind, label: stepSummary(s),
      selectors: rankSelectors(s), frame: s.frame.path, frameUrl: s.frame.url, shadowPath: s.target?.shadowPath ?? [],
      wait: r.wait ?? { ...DEFAULT_WAIT }, onFail: r.onFail ?? DEFAULT_ON_FAIL, timeoutMs: r.timeoutMs && r.timeoutMs > 0 ? r.timeoutMs : DEFAULT_REPLAY_TIMEOUT_MS,
    };
    const prev = list[index - 1];
    const manual = (reason: string): ReplayAction => ({ ...base, kind: 'manual', manualReason: reason });
    const needTarget = (a: ReplayAction): ReplayAction => (a.selectors.length ? a : manual('対象要素のセレクターがないため、人が操作して続行する'));
    switch (s.kind) {
      case 'click': return needTarget({ ...base, kind: 'click' });
      case 'input': {
        if (isRedacted(s)) return manual('機密欄のため値を保存していない。人が入力して続行する');
        if (s.value?.kind === 'files') return manual('ファイル選択は自動で行わない。人が選択して続行する');
        const value: ReplayValue = r.valueTemplate !== undefined ? { source: 'template', template: r.valueTemplate } : { source: 'recorded', text: s.value?.text ?? '' };
        return needTarget({ ...base, kind: 'input', value });
      }
      case 'select': {
        if (isRedacted(s)) return manual('機密欄のため値を保存していない。人が選択して続行する');
        const a: ReplayAction = { ...base, kind: 'select', selectOptions: s.value?.selectedOptions ?? [] };
        if (r.valueTemplate !== undefined) a.value = { source: 'template', template: r.valueTemplate };
        return needTarget(a);
      }
      case 'check':
        if (isRedacted(s)) return manual('機密欄のため状態を保存していない。人が操作して続行する');
        return needTarget({ ...base, kind: 'check', checked: !!s.value?.checked });
      case 'key': return { ...base, kind: 'key', key: s.key };
      case 'session-start': return { ...base, kind: 'navigate', url: s.page.url };
      case 'reload': return { ...base, kind: 'navigate', url: s.navigation?.toUrl ?? s.page.url, reload: true, note: RELOAD_AS_GET_NOTE };
      case 'navigation': case 'spa-navigation': {
        const url = s.navigation?.toUrl ?? s.page.url;
        if (prev && OPERATION_KINDS.has(prev.kind)) return { ...base, kind: 'wait', wait: r.wait ?? { kind: 'url-matches', value: urlContainsValue(url) } };
        if (s.kind === 'spa-navigation' && prev) return { ...base, kind: 'wait', wait: r.wait ?? { kind: 'url-matches', value: urlContainsValue(url) } };
        return { ...base, kind: 'navigate', url };
      }
      case 'wait': return { ...base, kind: 'wait', wait: r.wait ?? { kind: 'none' } };
      default: return { ...base, kind: 'unsupported', unsupportedReason: UNSUPPORTED[s.kind] ?? '再生に対応していない種別' };
    }
  });
}

/** 計画の action で使われている変数名 */
export function planVariableNames(plan: readonly ReplayAction[]): string[] {
  const out: string[] = [];
  for (const a of plan) if (a.value?.source === 'template') for (const n of extractVariableNames(a.value.template)) if (!out.includes(n)) out.push(n);
  return out;
}

export interface PreflightResult {
  /** 値が決まらない変数（secret で実行時入力が必要なものを含む）。defined: シナリオの変数一覧にあるか */
  missingVariables: { name: string; secret: boolean; defined: boolean; stepIds: string[] }[];
  /** 人が操作して続行する手順 */
  manualSteps: { stepId: string; seq: number; reason: string }[];
  /** 再生対象外（エンジンは skipped として残す） */
  unsupported: { stepId: string; seq: number; reason: string }[];
}

/** 実行前の確認。provided の undefined は未入力、空文字は「空を指定」とみなす。secret は既定値を持たないので実行時入力が必要。 */
export function preflight(plan: readonly ReplayAction[], variables: readonly ScenarioVariable[], provided: Readonly<Record<string, string | undefined>>): PreflightResult {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const missing = new Map<string, { name: string; secret: boolean; defined: boolean; stepIds: string[] }>();
  for (const a of plan) {
    if (a.value?.source !== 'template') continue;
    for (const n of extractVariableNames(a.value.template)) {
      const v = byName.get(n);
      const has = provided[n] !== undefined || (!!v && !v.secret && v.defaultValue !== undefined);
      if (has) continue;
      const m = missing.get(n) ?? { name: n, secret: !!v?.secret, defined: !!v, stepIds: [] };
      if (!m.stepIds.includes(a.stepId)) m.stepIds.push(a.stepId);
      missing.set(n, m);
    }
  }
  return {
    missingVariables: [...missing.values()],
    manualSteps: plan.filter((a) => a.kind === 'manual').map((a) => ({ stepId: a.stepId, seq: a.seq, reason: a.manualReason ?? '' })),
    unsupported: plan.filter((a) => a.kind === 'unsupported').map((a) => ({ stepId: a.stepId, seq: a.seq, reason: a.unsupportedReason ?? '' })),
  };
}

/** action の値を解決する（SW が replay:run を送る直前に呼ぶ）。values は既定値を含めた実行時の値。 */
export function resolveAction(action: ReplayAction, values: Readonly<Record<string, string | undefined>>): { ok: true; action: ResolvedReplayAction } | { ok: false; missing: string[] } {
  const { value, ...rest } = action;
  if (!value) return { ok: true, action: rest };
  if (value.source === 'recorded') return { ok: true, action: { ...rest, text: value.text } };
  const r = resolveTemplate(value.template, values);
  if (!r.ok) return { ok: false, missing: r.missing };
  return { ok: true, action: { ...rest, text: r.text } };
}

// ---- 結果 -------------------------------------------------------------------

export type ReplayMode = 'all' | 'step' | 'range';
export type ReplayRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted';

/** 待機条件の観測結果。observed は条件を観測できたこと（業務処理の完了ではない）。 */
export interface WaitOutcome {
  kind: WaitCondition['kind'];
  status: 'observed' | 'timeout' | 'not-applicable' | 'failed';
  at?: ISO;
  detail?: string;
}

/**
 * 1 手順の再生結果。
 * - ok: 操作を実行し、待機条件を観測できた。**業務処理の完了・成功を意味しない。**
 * - failed / skipped は reason を必ず持つ。
 * - manual: 人の操作待ち、または人が操作して続行した。
 * reason / detail に入力値を書かない（機密の変数・機密欄の値を残さない）。
 */
export interface ReplayStepResult {
  stepId: string;
  status: 'ok' | 'failed' | 'skipped' | 'manual' | 'pending';
  reason?: string;
  detail?: string;
  /** 実際に使ったセレクター */
  selectorUsed?: { language: 'css' | 'xpath'; selector: string; source: 'human' | 'recorded' };
  /** 再生時点の一致件数 */
  matchCount?: number;
  startedAt: ISO;
  endedAt?: ISO;
  waitOutcome?: WaitOutcome;
  /**
   * (追加) この手順の操作を実行したか。yes: 実行した / possibly: 実行された可能性がある（応答を受け取れなかった）/ no: 実行していない。
   * 未設定は記録していない（旧データ、または操作を伴わない結果）。再試行で二重操作になり得るかの判断に使う。
   */
  acted?: ActedState;
  /** (追加) 停止の要求を受けたときに実行中だった手順（ok にも未実行にもしない。reason に理由がある） */
  stoppedWhileRunning?: boolean;
}

/** 操作を実行したか（再試行で二重操作になり得るか） */
export type ActedState = 'yes' | 'possibly' | 'no';

/** 実行時の変数の記録。secret の変数は値を入れず provided だけ残す（保存 API 側でも落とす）。 */
export interface ReplayVariableRecord { provided: boolean; secret: boolean; value?: string }

export interface ReplayRun {
  schemaVersion: number;
  id: string;
  scenarioId: string;
  startedAt: ISO;
  endedAt?: ISO;
  status: ReplayRunStatus;
  /** 終了・中断の理由（failed / stopped / interrupted のとき） */
  reason?: string;
  mode: ReplayMode;
  range?: ReplayPlanOptions;
  /** 計画に含めた手順（順序どおり） */
  planStepIds: string[];
  variableValues: Record<string, ReplayVariableRecord>;
  results: ReplayStepResult[];
}

/** 実行時の値から ReplayRun.variableValues を作る（secret は値を落とす） */
export function recordVariableValues(variables: readonly ScenarioVariable[], names: readonly string[], values: Readonly<Record<string, string | undefined>>): Record<string, ReplayVariableRecord> {
  const out: Record<string, ReplayVariableRecord> = {};
  const byName = new Map(variables.map((v) => [v.name, v]));
  for (const n of names) {
    const secret = !!byName.get(n)?.secret;
    const v = values[n];
    out[n] = secret ? { provided: v !== undefined, secret: true } : v === undefined ? { provided: false, secret: false } : { provided: true, secret: false, value: v };
  }
  return out;
}

/** 保存前の検査: secret の値を落とす（保存 API はこれを必ず通す） */
export function sanitizeReplayRun(run: ReplayRun): ReplayRun {
  const vv: Record<string, ReplayVariableRecord> = {};
  for (const [k, v] of Object.entries(run.variableValues ?? {})) vv[k] = v.secret ? { provided: v.provided, secret: true } : { ...v };
  return { ...run, variableValues: vv };
}

/** 結果の初期値（すべて pending） */
export function initialResults(plan: readonly ReplayAction[], now: ISO): ReplayStepResult[] {
  return plan.map((a) => ({ stepId: a.stepId, status: 'pending', startedAt: now }));
}

export const REPLAY_STATUS_LABEL: Record<ReplayStepResult['status'], string> = {
  ok: '操作を実行し待機条件を観測', failed: '失敗', skipped: '再生しなかった', manual: '人が操作', pending: '未実行',
};
export const RUN_STATUS_LABEL: Record<ReplayRunStatus, string> = {
  running: '再生中', paused: '一時停止中', completed: '最後まで実行（業務処理の完了は未確認）', failed: '失敗で停止', stopped: '人が停止', interrupted: '中断',
};
