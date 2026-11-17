// 新規タブ・別ウィンドウへの記録対象の切り替え（純粋な状態遷移）
// 同時に記録するタブは常に 1 つ。切り替えると、元のタブは tabStack に積み、閉じられたら戻る。

export interface TabRef { tabId: number; windowId: number }
export interface TabSwitchState {
  /** 現在の記録対象 */
  current: TabRef;
  /** 切り替え前のタブ（直近が末尾） */
  stack: TabRef[];
  /** 権限がなく切り替えられなかった新しいタブ。アイコンのクリックで activeTab が付与されたら切り替える */
  pending?: TabRef | null;
}

export type CreatedDecision =
  | { action: 'ignore' }
  | { action: 'switch'; to: TabRef }
  | { action: 'pending'; to: TabRef };

/** tabs.onCreated: 対象タブから開かれたタブだけが対象。権限があれば切り替え、なければ保留する。 */
export function decideOnCreated(st: TabSwitchState, o: { enabled: boolean; recording: boolean; created: { id?: number; windowId: number; openerTabId?: number }; hasAccess: boolean }): CreatedDecision {
  if (!o.enabled || !o.recording || o.created.id === undefined || o.created.openerTabId !== st.current.tabId) return { action: 'ignore' };
  const to = { tabId: o.created.id, windowId: o.created.windowId };
  return o.hasAccess ? { action: 'switch', to } : { action: 'pending', to };
}

export type RemovedDecision =
  | { action: 'none'; state: TabSwitchState }
  | { action: 'return'; to: TabRef; state: TabSwitchState }
  /** 戻れるタブがない（stackWasEmpty: そもそも切り替え履歴がなかった） */
  | { action: 'end'; stackWasEmpty: boolean; state: TabSwitchState };

/** tabs.onRemoved。alive は、まだ存在するタブの ID 集合。 */
export function decideOnRemoved(st: TabSwitchState, removedTabId: number, alive: ReadonlySet<number>): RemovedDecision {
  const pending = st.pending?.tabId === removedTabId ? null : st.pending;
  if (removedTabId !== st.current.tabId) {
    const stack = st.stack.filter((t) => t.tabId !== removedTabId);
    return { action: 'none', state: { ...st, stack, pending } };
  }
  const stackWasEmpty = st.stack.length === 0;
  const rest = st.stack.filter((t) => t.tabId !== removedTabId);
  for (let i = rest.length - 1; i >= 0; i--) {
    if (alive.has(rest[i].tabId)) return { action: 'return', to: rest[i], state: { current: rest[i], stack: rest.slice(0, i), pending } };
  }
  return { action: 'end', stackWasEmpty, state: { ...st, stack: [], pending } };
}

/** 切り替えの実行後の状態 */
export function applySwitch(st: TabSwitchState, to: TabRef): TabSwitchState {
  return { current: to, stack: [...st.stack.filter((t) => t.tabId !== to.tabId && t.tabId !== st.current.tabId), st.current].slice(-8), pending: st.pending?.tabId === to.tabId ? null : st.pending };
}
