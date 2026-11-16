import { describe, expect, it } from 'vitest';
import { InputAggregator, type InputSession } from '../../src/shared/inputAggregator';

function setup() {
  const log: string[] = [];
  const done: InputSession<string>[] = [];
  let n = 0;
  const agg = new InputAggregator<string>({
    onStart: (s) => log.push(`start:${s.key}`),
    onUpdate: (s) => log.push(`update:${s.key}`),
    onFinalize: (s, reason) => { log.push(`final:${s.key}:${reason}:${s.value}`); done.push({ ...s }); },
  }, () => `id${++n}`);
  return { agg, log, done };
}

describe('InputAggregator（入力の集約）', () => {
  it('同じ欄への連続入力は1件にまとまり、最終値だけが確定値になる', () => {
    const { agg, done, log } = setup();
    'E12345'.split('').forEach((_, i) => agg.edit('user', 'E12345'.slice(0, i + 1), 100 + i));
    agg.finalize('blur', 200);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ value: 'E12345', editCount: 6, startAt: 100, lastAt: 105, usedIme: false });
    expect(log.filter((l) => l.startsWith('start'))).toHaveLength(1);
  });

  it('日本語IMEの変換途中（composition）を別ステップにしない', () => {
    const { agg, done } = setup();
    agg.compositionStart('memo', 1);
    for (const [i, t] of ['せ', 'せっ', 'せっけ', 'せっけい', '設計'].entries()) agg.edit('memo', t, 2 + i);
    agg.compositionEnd('memo', 10);
    agg.compositionStart('memo', 11);
    for (const [i, t] of ['設計れ', '設計れび', '設計レビュー'].entries()) agg.edit('memo', t, 12 + i);
    agg.compositionEnd('memo', 20);
    agg.finalize('blur', 30);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ value: '設計レビュー', usedIme: true, composing: false });
  });

  it('別の欄の編集が始まると、前の欄を先に確定する（順序が保たれる）', () => {
    const { agg, log } = setup();
    agg.edit('a', '1', 1); agg.edit('a', '12', 2);
    agg.edit('b', 'x', 3);
    agg.finalize('blur', 4);
    expect(log).toEqual(['start:a', 'update:a', 'final:a:other-field:12', 'start:b', 'final:b:blur:x']);
  });

  it('確定は冪等で、編集のない composition 開始だけでは何も記録しない', () => {
    const { agg, done, log } = setup();
    agg.compositionStart('a', 1);
    agg.finalize('blur', 2);
    agg.finalize('blur', 3);
    expect(done).toHaveLength(0);
    expect(log).toEqual([]);
    agg.edit('a', 'v', 4);
    agg.finalize('blur', 5); agg.finalize('page-unload', 6);
    expect(done).toHaveLength(1);
  });

  it('機密欄は値を null のまま扱い、編集回数だけを数える', () => {
    const { agg, done } = setup();
    agg.edit('pw', null, 1); agg.edit('pw', null, 2);
    agg.finalize('blur', 3, null);
    expect(done[0].value).toBeNull();
    expect(done[0].editCount).toBe(2);
  });

  it('確定時に渡した最終値で上書きする（change で値が整形された場合）', () => {
    const { agg, done } = setup();
    agg.edit('h', '1.', 1);
    agg.finalize('change', 2, '1.5');
    expect(done[0].value).toBe('1.5');
  });
});
