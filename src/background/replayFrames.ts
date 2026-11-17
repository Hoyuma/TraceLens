// 再生の対象フレームの解決（純粋な処理）。
// SW は replay.js を allFrames で注入した後、各フレームの経路（FrameDescription）を executeScript の結果として受け取り、
// 記録時の frame.path（トップからの経路）と照合して frameId を決める。
import type { FrameHop } from '../shared/types';

export interface FrameCandidate { frameId: number; path: { index: number; selector?: string }[]; url?: string }

/**
 * 記録時の経路と一致するフレームを選ぶ。
 * 1. 各階層の index がすべて一致するもの（記録時に index が取れなかった階層は selector で照合）
 * 2. 1 が 0 件なら、selector が記録されている階層を selector で、それ以外を index で照合
 * 一致が 1 件でなければ理由を返す（対応を確認できないフレームで操作しない）。
 */
export function matchFrame(frames: readonly FrameCandidate[], recorded: readonly FrameHop[]): { frameId: number } | { error: string } {
  if (!recorded.length) {
    const top = frames.find((f) => f.path.length === 0);
    return top ? { frameId: top.frameId } : { error: 'トップフレームに再生スクリプトを注入できていない' };
  }
  const sameDepth = frames.filter((f) => f.path.length === recorded.length);
  const byIndex = sameDepth.filter((f) => recorded.every((h, i) => (h.index >= 0 ? f.path[i].index === h.index : !!h.selector && f.path[i].selector === h.selector)));
  if (byIndex.length === 1) return { frameId: byIndex[0].frameId };
  const bySelector = sameDepth.filter((f) => recorded.every((h, i) => (h.selector ? f.path[i].selector === h.selector : f.path[i].index === h.index)));
  if (bySelector.length === 1) return { frameId: bySelector[0].frameId };
  const n = Math.max(byIndex.length, bySelector.length);
  return { error: n === 0 ? `記録時のフレーム経路（深さ ${recorded.length}）に一致するフレームがない（注入できたフレーム ${frames.length} 件。アクセス権のないフレームには注入できない）` : `記録時のフレーム経路に一致するフレームが ${n} 件あり、対象を特定できない` };
}
