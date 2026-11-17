// レビュー画面の保存処理（IndexedDB への書き込み）。判断（検査・計画）は logic.ts と shared/ の純粋関数が行う。
import { deleteGroup, patchScenario, patchStep } from '../shared/db';
import type { GroupResult } from '../shared/groups';
import type { StepGroup } from '../shared/types';
import type { OrderChange } from './logic';

/** グループの変更。失敗した場合は理由を返す（保存しない）。 */
export async function applyGroupOp(scenarioId: string, op: (groups: StepGroup[]) => GroupResult<object>): Promise<string | null> {
  let err: string | null = null;
  await patchScenario(scenarioId, (s) => { const r = op(s.groups); if (r.ok) s.groups = r.groups; else err = r.reason; });
  return err;
}

export async function removeGroupAction(scenarioId: string, groupId: string): Promise<string | null> {
  const r = await deleteGroup(scenarioId, groupId);
  return r.ok ? null : r.reason;
}

/** order だけを書き換える（seq・operationAt は変えない） */
export async function applyOrder(changes: readonly OrderChange[]): Promise<void> {
  for (const c of changes) await patchStep(c.stepId, (s) => { s.order = c.order; });
}

export async function setStepsGroup(stepIds: readonly string[], groupId: string | undefined): Promise<void> {
  for (const id of stepIds) await patchStep(id, (s) => { if (groupId) s.groupId = groupId; else delete s.groupId; });
}
