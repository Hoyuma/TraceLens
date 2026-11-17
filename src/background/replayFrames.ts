// 再生の対象フレームの解決（純粋な処理）。
// SW は replay.js を allFrames で注入した後、各フレームの経路（FrameDescription）を executeScript の結果として受け取り、
// 記録時の frame.path（トップからの経路）と照合して frameId を決める。
import type { FrameHop } from '../shared/types';

export interface FrameCandidate { frameId: number; documentId?: string; path: { index: number; selector?: string; url?: string }[]; url?: string }

/** URL の比較は origin + path だけで行う（クエリ・# には使い捨てのトークンが入ることが多い） */
export function urlKey(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try { const x = new URL(u); return x.protocol === 'about:' ? x.href : `${x.origin}${x.pathname}`; } catch { return undefined; }
}

type HopTest = (f: FrameCandidate['path'][number], h: FrameHop) => boolean;
/** 記録時に selector がある階層は selector で照合する（同一オリジンなら再生側でも取れる） */
const bySel: HopTest = (f, h) => (h.selector ? f.selector === h.selector : h.index >= 0 && f.index === h.index);
/** 記録時に index がある階層は index で照合する */
const byIdx: HopTest = (f, h) => (h.index >= 0 ? f.index === h.index : !!h.selector && f.selector === h.selector);
const both: HopTest = (f, h) => bySel(f, h) && byIdx(f, h);

/** 階層ごとの URL（origin + path）が記録と一致するか。記録または再生側で URL が分からない階層は判断に使わない */
function urlAgrees(f: FrameCandidate, recorded: readonly FrameHop[], frameUrl?: string): boolean {
  return recorded.every((h, i) => {
    const want = urlKey(i === recorded.length - 1 ? h.url ?? frameUrl : h.url);
    const got = urlKey(i === recorded.length - 1 ? f.path[i].url ?? f.url : f.path[i].url);
    return !want || !got || want === got;
  });
}

/**
 * 記録時の経路と一致するフレームを選ぶ。次の順に試し、一致が 1 件になった段階で採用する。
 *  1. 各階層の selector と index の両方が一致
 *  2. selector で照合（記録時に selector がない階層は index）。iframe の追加・削除で index がずれた場合
 *  3. index で照合（記録時に index がない階層は selector）。iframe 要素の構造が変わった場合
 * 各段階で複数件なら、各階層の URL（origin + path）が記録と一致するものに絞る。
 * それでも 1 件にならなければ理由を返す（対応を確認できないフレームで操作しない）。
 */
export function matchFrame(frames: readonly FrameCandidate[], recorded: readonly FrameHop[], frameUrl?: string): { frameId: number; documentId?: string; via?: string } | { error: string } {
  if (!recorded.length) {
    const top = frames.find((f) => f.path.length === 0);
    return top ? { frameId: top.frameId, documentId: top.documentId } : { error: 'トップフレームに再生スクリプトを注入できていない' };
  }
  const sameDepth = frames.filter((f) => f.path.length === recorded.length);
  let most = 0;
  const tiers: [string, HopTest][] = [['selector と index', both], ['selector', bySel], ['index', byIdx]];
  for (const [label, test] of tiers) {
    const hit = sameDepth.filter((f) => recorded.every((h, i) => test(f.path[i], h)));
    if (hit.length === 1) return { frameId: hit[0].frameId, documentId: hit[0].documentId, via: label };
    if (hit.length > 1) {
      const narrowed = hit.filter((f) => urlAgrees(f, recorded, frameUrl));
      if (narrowed.length === 1) return { frameId: narrowed[0].frameId, documentId: narrowed[0].documentId, via: `${label} + URL` };
      most = Math.max(most, narrowed.length || hit.length);
    }
  }
  return {
    error: most === 0
      ? `記録時のフレーム経路（深さ ${recorded.length}）に一致するフレームがない（注入できたフレーム ${frames.length} 件、同じ深さ ${sameDepth.length} 件。アクセス権のないフレームには注入できない）`
      : `記録時のフレーム経路に一致するフレームが ${most} 件あり、対象を特定できない`,
  };
}

/** 経路の表示（診断用） */
export function describePath(path: readonly { index: number; selector?: string }[]): string {
  if (!path.length) return 'トップ';
  return path.map((h) => `${h.selector ?? '(セレクター不明)'}[${h.index}]`).join(' > ');
}
