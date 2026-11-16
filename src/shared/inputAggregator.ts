// 同一入力欄への連続した編集を1ステップにまとめる状態機械（DOM非依存・テスト対象）。
// - 1文字ごとにステップ化しない
// - IME 変換中(composition)の途中経過を別ステップにしない
// - 別の欄の編集、blur/change、他の操作、ページ離脱などで確定する

export interface InputSession<K> {
  id: string;
  key: K;
  startAt: number;
  lastAt: number;
  editCount: number;
  /** 機密欄は null（値を保持しない） */
  value: string | null;
  usedIme: boolean;
  composing: boolean;
  /** 最初の編集が通知済みか（composition 開始だけでは通知しない） */
  started: boolean;
}

export interface AggregatorCallbacks<K> {
  onStart(s: InputSession<K>): void;
  onUpdate(s: InputSession<K>): void;
  onFinalize(s: InputSession<K>, reason: string): void;
}

export class InputAggregator<K> {
  private cur: InputSession<K> | null = null;
  constructor(private cb: AggregatorCallbacks<K>, private makeId: () => string) {}

  get current(): InputSession<K> | null { return this.cur; }

  private ensure(key: K, at: number): InputSession<K> {
    if (this.cur && this.cur.key !== key) this.finalize('other-field', at);
    if (!this.cur) this.cur = { id: this.makeId(), key, startAt: at, lastAt: at, editCount: 0, value: null, usedIme: false, composing: false, started: false };
    return this.cur;
  }

  compositionStart(key: K, at: number): void {
    const s = this.ensure(key, at);
    s.usedIme = true; s.composing = true;
  }

  compositionEnd(key: K, at: number): void {
    if (this.cur && this.cur.key === key) { this.cur.composing = false; this.cur.lastAt = at; }
  }

  edit(key: K, value: string | null, at: number): void {
    const s = this.ensure(key, at);
    s.value = value; s.lastAt = at; s.editCount++;
    if (!s.started) { s.started = true; this.cb.onStart(s); } else this.cb.onUpdate(s);
  }

  /** 進行中の入力を確定する。進行中でなければ何もしない（冪等）。 */
  finalize(reason: string, _at: number, finalValue?: string | null): void {
    const s = this.cur;
    if (!s) return;
    this.cur = null;
    if (!s.started) return; // composition が始まっただけで編集なし
    if (finalValue !== undefined) s.value = finalValue;
    s.composing = false;
    this.cb.onFinalize(s, reason);
  }
}
