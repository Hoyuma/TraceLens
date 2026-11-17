// 手順グループの入れ子（純粋な処理。chrome API に依存しない）
// 操作はすべて新しい配列を返し、引数は変更しない。保存は db.ts 側で 1 トランザクションで行う。
import { newId, type Step, type StepGroup } from './types';

export type GroupResult<T = object> = ({ ok: true; groups: StepGroup[] } & T) | { ok: false; reason: string };

const parentOf = (g: StepGroup) => g.parentId ?? null;

/** 同じ親の子グループを表示順で返す */
export function childGroups(groups: readonly StepGroup[], parentId: string | null): StepGroup[] {
  return groups
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => parentOf(g) === parentId)
    .sort((a, b) => (a.g.order ?? a.i) - (b.g.order ?? b.i) || a.i - b.i)
    .map(({ g }) => g);
}

/** 祖先 → 自分の順のパス。存在しない ID は空配列。循環していても止まる（循環を見つけたらそこで打ち切る）。 */
export function groupPath(groups: readonly StepGroup[], groupId: string | null | undefined): StepGroup[] {
  if (!groupId) return [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out: StepGroup[] = [];
  const seen = new Set<string>();
  let cur = byId.get(groupId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    const p = parentOf(cur);
    cur = p ? byId.get(p) : undefined;
  }
  return out;
}

export function groupPathNames(groups: readonly StepGroup[], groupId: string | null | undefined): string[] {
  return groupPath(groups, groupId).map((g) => g.name);
}

/** 0 が最上位 */
export function groupDepth(groups: readonly StepGroup[], groupId: string): number {
  return Math.max(0, groupPath(groups, groupId).length - 1);
}

/** groupId の子孫（自分は含まない） */
export function descendantGroupIds(groups: readonly StepGroup[], groupId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => { for (const c of groups) if (parentOf(c) === id && !out.has(c.id) && c.id !== groupId) { out.add(c.id); walk(c.id); } };
  walk(groupId);
  return out;
}

/** groupId の親を newParentId にしてよいか（自分自身・子孫を親にすると循環する） */
export function validateGroupParent(groups: readonly StepGroup[], groupId: string, newParentId: string | null): { ok: true } | { ok: false; reason: string } {
  if (!groups.some((g) => g.id === groupId)) return { ok: false, reason: 'グループが見つからない' };
  if (newParentId === null) return { ok: true };
  if (!groups.some((g) => g.id === newParentId)) return { ok: false, reason: '移動先のグループが見つからない' };
  if (newParentId === groupId) return { ok: false, reason: 'グループを自分自身の中には移動できない' };
  if (descendantGroupIds(groups, groupId).has(newParentId)) return { ok: false, reason: 'グループを自分の子孫の中には移動できない（循環する）' };
  return { ok: true };
}

/** グループ全体の検査（循環、存在しない親、ID の重複、空の名前）。問題がなければ空配列。 */
export function validateGroups(groups: readonly StepGroup[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const g of groups) {
    if (ids.has(g.id)) errs.push(`グループ ID が重複している: ${g.id}`);
    ids.add(g.id);
    if (!g.name.trim()) errs.push(`グループ名が空: ${g.id}`);
  }
  for (const g of groups) {
    const p = parentOf(g);
    if (p && !ids.has(p)) errs.push(`親グループが見つからない: ${g.id} → ${p}`);
    const seen = new Set<string>([g.id]);
    let cur = p;
    while (cur) {
      if (seen.has(cur)) { errs.push(`グループの親子関係が循環している: ${g.id}`); break; }
      seen.add(cur);
      cur = groups.find((x) => x.id === cur)?.parentId ?? null;
    }
  }
  return errs;
}

/** 表示用: 木を深さ優先で平らにする（循環・親なしのグループは最上位として扱う） */
export function flattenGroupTree(groups: readonly StepGroup[]): { group: StepGroup; depth: number; path: string[] }[] {
  const out: { group: StepGroup; depth: number; path: string[] }[] = [];
  const done = new Set<string>();
  const ids = new Set(groups.map((g) => g.id));
  const walk = (parentId: string | null, depth: number, path: string[]) => {
    for (const g of childGroups(groups, parentId)) {
      if (done.has(g.id)) continue;
      done.add(g.id);
      const p = [...path, g.name];
      out.push({ group: g, depth, path: p });
      walk(g.id, depth + 1, p);
    }
  };
  walk(null, 0, []);
  // 親が存在しない・循環しているものも取りこぼさない
  for (const g of groups) if (!done.has(g.id)) { const p = parentOf(g); if (!p || !ids.has(p) || !done.has(p)) { done.add(g.id); out.push({ group: g, depth: 0, path: [g.name] }); walk(g.id, 1, [g.name]); } }
  return out;
}

export function createGroup(groups: readonly StepGroup[], name: string, parentId: string | null = null, id = newId('grp')): GroupResult<{ group: StepGroup }> {
  const n = name.trim();
  if (!n) return { ok: false, reason: 'グループ名が空' };
  if (parentId && !groups.some((g) => g.id === parentId)) return { ok: false, reason: '親グループが見つからない' };
  const siblings = childGroups(groups, parentId);
  const order = siblings.reduce((m, g, i) => Math.max(m, g.order ?? i), -1) + 1;
  const group: StepGroup = { id, name: n, parentId, order };
  return { ok: true, groups: [...groups, group], group };
}

export function renameGroup(groups: readonly StepGroup[], groupId: string, name: string): GroupResult {
  const n = name.trim();
  if (!n) return { ok: false, reason: 'グループ名が空' };
  if (!groups.some((g) => g.id === groupId)) return { ok: false, reason: 'グループが見つからない' };
  return { ok: true, groups: groups.map((g) => (g.id === groupId ? { ...g, name: n } : g)) };
}

/** 親を変える（循環は拒否）。order を省略すると移動先の末尾。 */
export function moveGroup(groups: readonly StepGroup[], groupId: string, newParentId: string | null, order?: number): GroupResult {
  const v = validateGroupParent(groups, groupId, newParentId);
  if (!v.ok) return v;
  const siblings = childGroups(groups, newParentId).filter((g) => g.id !== groupId);
  const o = order ?? siblings.reduce((m, g, i) => Math.max(m, g.order ?? i), -1) + 1;
  return { ok: true, groups: groups.map((g) => (g.id === groupId ? { ...g, parentId: newParentId, order: o } : g)) };
}

/**
 * グループを削除する。子グループと所属していた手順は、削除したグループの親へ繰り上げる。
 * 手順は削除しない。stepMoves は groupId を変える手順の一覧（undefined は「グループなし」）。
 */
export function removeGroup(groups: readonly StepGroup[], steps: readonly Pick<Step, 'id' | 'groupId'>[], groupId: string): GroupResult<{ stepMoves: { stepId: string; groupId: string | undefined }[] }> {
  const target = groups.find((g) => g.id === groupId);
  if (!target) return { ok: false, reason: 'グループが見つからない' };
  const parent = parentOf(target);
  const next = groups.filter((g) => g.id !== groupId).map((g) => (parentOf(g) === groupId ? { ...g, parentId: parent } : g));
  const stepMoves = steps.filter((s) => s.groupId === groupId).map((s) => ({ stepId: s.id, groupId: parent ?? undefined }));
  return { ok: true, groups: next, stepMoves };
}
