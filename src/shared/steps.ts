// 手順の並び順・人が追加する手順（純粋な処理。chrome API に依存しない）
// seq は元の操作順で、並べ替え・削除・取り込みでも書き換えない。表示・再生順は order で表す。
import { SCHEMA_VERSION, emptyAnnotation, newId, type Step, type StepReplayConfig, type WaitCondition } from './types';

/** 表示・再生順の値。未指定は seq。 */
export function effectiveOrder(s: Pick<Step, 'order' | 'seq'>): number {
  return typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : s.seq;
}

/** 表示・再生順に並べた新しい配列を返す。order が同じなら seq の昇順。元の配列は変えない。 */
export function orderedSteps<T extends Pick<Step, 'order' | 'seq'>>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => effectiveOrder(a) - effectiveOrder(b) || a.seq - b.seq);
}

/** シナリオ内で次に使う seq（最大 seq + 1）。authored / imported の手順の採番に使う。 */
export function nextSeqOf(steps: readonly Pick<Step, 'seq'>[]): number {
  return steps.reduce((m, s) => Math.max(m, s.seq), 0) + 1;
}

/** 表示順の末尾に置くための order */
export function nextOrderOf(steps: readonly Pick<Step, 'order' | 'seq'>[]): number {
  return steps.reduce((m, s) => Math.max(m, effectiveOrder(s)), 0) + 1;
}

/**
 * 手順を beforeStepId の直前（null なら末尾）へ移す並べ替え。
 * 変更が必要な手順の order だけを返す（seq・operationAt は変えない）。
 * 全手順に 1 から連番の order を振り直すため、結果は常に一意な順序になる。
 */
export function reorderSteps(steps: readonly Step[], moveIds: string[], beforeStepId: string | null): { stepId: string; order: number }[] {
  const moving = new Set(moveIds);
  if (beforeStepId && moving.has(beforeStepId)) return [];
  const ordered = orderedSteps(steps);
  const moved = ordered.filter((s) => moving.has(s.id));
  const rest = ordered.filter((s) => !moving.has(s.id));
  const at = beforeStepId ? rest.findIndex((s) => s.id === beforeStepId) : rest.length;
  if (at < 0) return [];
  const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  const out: { stepId: string; order: number }[] = [];
  next.forEach((s, i) => { if (s.order !== i + 1) out.push({ stepId: s.id, order: i + 1 }); });
  return out;
}

export interface AuthoredStepInput {
  scenarioId: string;
  /** 現在のシナリオの手順（seq・order の採番に使う） */
  existing: readonly Step[];
  /** 既定は wait（待機条件だけの手順） */
  kind?: 'wait';
  wait: WaitCondition;
  /** 表示順でこの手順の直後に置く。未指定は末尾。 */
  afterStepId?: string | null;
  groupId?: string;
  replay?: Omit<StepReplayConfig, 'wait'>;
  now: string;
  /** URL など、追加時点のページ情報（任意） */
  pageUrl?: string;
}

/**
 * 人が追加する手順（origin: authored）を作る。保存は呼び出し側（db.addStep）。
 * seq は最大 seq + 1、operationAt は作成時刻（記録された操作時刻ではない）。
 * 記録中のシナリオに追加すると記録側の採番と衝突するため、記録中は追加しない前提。
 */
export function createAuthoredStep(input: AuthoredStepInput): Step {
  const ordered = orderedSteps(input.existing);
  let order = nextOrderOf(input.existing);
  if (input.afterStepId) {
    const i = ordered.findIndex((s) => s.id === input.afterStepId);
    if (i >= 0) {
      const cur = effectiveOrder(ordered[i]);
      const nxt = ordered[i + 1] ? effectiveOrder(ordered[i + 1]) : cur + 2;
      order = (cur + nxt) / 2;
    }
  }
  const url = input.pageUrl ?? '';
  return {
    schemaVersion: SCHEMA_VERSION, id: newId('stp'), scenarioId: input.scenarioId, sessionId: 'authored', seq: nextSeqOf(input.existing),
    kind: input.kind ?? 'wait', operationAt: input.now,
    page: { url, title: '' }, frame: { isTop: true, path: [], url },
    observations: [],
    screenshot: { status: 'not-applicable', reasonCode: 'authored', reason: '人が追加した手順のため画面は取得していない' },
    dom: { status: 'not-applicable', reasonCode: 'authored', reason: '人が追加した手順のため DOM は取得していない' },
    elementCapture: { status: 'not-applicable' },
    limitations: [], annotation: emptyAnnotation(), includeInExport: true,
    groupId: input.groupId, origin: 'authored', order,
    replay: { ...(input.replay ?? {}), wait: input.wait },
  };
}
