import { useCallback, useEffect, useRef, useState } from 'react';
import { EVT_CHANGED, STATE_KEY, type ActiveSession, type UiMsg, type UiReply } from '../shared/messages';
import { patchStep } from '../shared/db';
import { newId, type Annotation, type Condition, type Step } from '../shared/types';
import { fmtTime } from '../shared/describe';

export function sendUi(msg: UiMsg): Promise<UiReply> {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, message: String(e) }));
}

/** 記録データの変更通知（Service Worker から）で再読み込みする */
export function useChanged(cb: () => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let t: number | undefined;
    const h = (msg: { t?: string }) => { if (msg?.t === EVT_CHANGED) { clearTimeout(t); t = window.setTimeout(() => ref.current(), 120); } };
    chrome.runtime.onMessage.addListener(h);
    return () => { chrome.runtime.onMessage.removeListener(h); clearTimeout(t); };
  }, []);
}

export function useSession(): ActiveSession | null {
  const [s, setS] = useState<ActiveSession | null>(null);
  useEffect(() => {
    chrome.storage.session.get(STATE_KEY).then((v) => setS((v[STATE_KEY] as ActiveSession) ?? null));
    const h = (ch: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'session' && STATE_KEY in ch) setS((ch[STATE_KEY].newValue as ActiveSession) ?? null); };
    chrome.storage.onChanged.addListener(h);
    return () => chrome.storage.onChanged.removeListener(h);
  }, []);
  return s;
}

export function Brand() {
  return <div className="brand"><b>TraceLens</b><small>操作と意図を、実装につなぐ</small></div>;
}

const BASIS: [Condition['basis'], string][] = [['human-stated', '人間が記入'], ['observed', '観測済み'], ['unverified', '未確認']];

function CondList({ type, label, hint, a, update }: { type: Condition['type']; label: string; hint: string; a: Annotation; update: (p: Partial<Annotation>) => void }) {
  const list = a.conditions.filter((c) => c.type === type);
  const set = (id: string, p: Partial<Condition>) => update({ conditions: a.conditions.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  return (
    <div className="f" style={{ marginTop: 8 }}>
      <div className="row"><span className="small muted grow">{label}</span>
        <button className="link small" data-testid={`add-${type}`} onClick={() => update({ conditions: [...a.conditions, { id: newId('cnd'), type, text: '', basis: 'human-stated' }] })}>＋ 追加</button></div>
      {list.length === 0 && <div className="small muted">未記入（例: {hint}）</div>}
      {list.map((c) => (
        <div className="cond" key={c.id}>
          <input data-testid={`cond-${type}`} value={c.text} placeholder={hint} onChange={(e) => set(c.id, { text: e.target.value })} />
          <select value={c.basis} title="この条件の根拠" onChange={(e) => set(c.id, { basis: e.target.value as Condition['basis'], observedAt: e.target.value === 'observed' ? c.observedAt ?? new Date().toISOString() : undefined })}>
            {BASIS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button title="削除" onClick={() => update({ conditions: a.conditions.filter((x) => x.id !== c.id) })}>×</button>
        </div>
      ))}
    </div>
  );
}

/** 意図・条件の編集。記録中でも終了後でも使う。変更は自動保存。 */
export function AnnotationEditor({ step, compact, onSaved }: { step: Step; compact?: boolean; onSaved?: () => void }) {
  const [a, setA] = useState<Annotation>(step.annotation);
  const [confirmedAt, setConfirmedAt] = useState(step.humanConfirmedAt);
  const pending = useRef<{ id: string; a: Annotation } | null>(null);
  const timer = useRef<number>();
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    void patchStep(p.id, (s) => { s.annotation = p.a; }).then(() => onSaved?.());
  }, [onSaved]);
  useEffect(() => { setA(step.annotation); setConfirmedAt(step.humanConfirmedAt); return flush; /* eslint-disable-next-line */ }, [step.id]);
  const update = (p: Partial<Annotation>) => {
    const next = { ...a, ...p };
    setA(next);
    pending.current = { id: step.id, a: next };
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 300);
  };
  const confirm = (on: boolean) => {
    const at = on ? new Date().toISOString() : undefined;
    setConfirmedAt(at);
    void patchStep(step.id, (s) => { s.humanConfirmedAt = at; }).then(() => onSaved?.());
  };
  const hasValue = !!step.value || a.valueKind !== 'unspecified';
  const liveObs = step.observations.filter((o) => o.type === 'live-region') as Extract<Step['observations'][number], { type: 'live-region' }>[];
  return (
    <div data-testid="annotation-editor">
      <label className="f"><span>操作の目的</span><input data-testid="f-purpose" value={a.purpose} placeholder="例: 登録する工程を選ぶ" onChange={(e) => update({ purpose: e.target.value })} /></label>
      {hasValue || !compact ? (
        <div className="f" style={{ marginTop: 8 }}>
          <span className="small muted">入力値の扱い{step.value && !step.value.redacted && step.value.text !== undefined ? `（記録時の入力例: 「${step.value.text}」）` : ''}</span>
          <div className="row" style={{ marginTop: 2 }}>
            {([['unspecified', '未指定'], ['fixed', '固定値'], ['variable', '変数']] as const).map(([v, l]) => (
              <label key={v} className="row" style={{ gap: 3 }}><input type="radio" name={`vk-${step.id}`} data-testid={`vk-${v}`} checked={a.valueKind === v} onChange={() => update({ valueKind: v })} />{l}</label>
            ))}
          </div>
          {a.valueKind === 'variable' && (<>
            <label className="f"><span>変数名</span><input data-testid="f-variable" value={a.variableName} placeholder="例: 工程コード" onChange={(e) => update({ variableName: e.target.value })} /></label>
            <label className="f"><span>入力元の項目名</span><input data-testid="f-source" value={a.valueSource} placeholder="例: タスク記録の工程コード" onChange={(e) => update({ valueSource: e.target.value })} /></label>
            {!compact && <label className="f"><span>変換ルール</span><input data-testid="f-transform" value={a.transformRule} placeholder="例: 分を 0.25 時間単位に丸める" onChange={(e) => update({ transformRule: e.target.value })} /></label>}
          </>)}
        </div>
      ) : null}
      {!compact && <CondList type="proceed" label="次へ進む条件" hint="工程の候補が更新され、目的の工程が選べる" a={a} update={update} />}
      <CondList type="success" label="成功条件" hint="保存完了メッセージが表示される" a={a} update={update} />
      {!compact && liveObs.length > 0 && (
        <div className="note info">観測された通知表示:
          {liveObs.map((o, i) => (
            <div key={i} className="row"><span className="grow">「{o.text}」<span className="muted">（{fmtTime(o.at)}）</span></span>
              <button className="link small" onClick={() => update({ conditions: [...a.conditions, { id: newId('cnd'), type: 'success', text: `「${o.text}」が表示される`, basis: 'observed', observedAt: o.at }] })}>成功条件に追加</button></div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small muted grow">人間による完了確認: {confirmedAt ? fmtTime(confirmedAt) : '未確認'}</span>
        {confirmedAt ? <button className="link small" onClick={() => confirm(false)}>取消</button> : <button data-testid="confirm-done" onClick={() => confirm(true)}>いま完了を確認</button>}
      </div>
      {!compact && <label className="f"><span>分岐・繰り返しの説明</span><textarea data-testid="f-branching" value={a.branching} placeholder="例: 登録する行数ぶん、行追加〜工数入力を繰り返す" onChange={(e) => update({ branching: e.target.value })} /></label>}
      <label className="f"><span>補足メモ</span><textarea data-testid="f-note" value={a.note} placeholder="例: PJを選択した後に候補が更新される" onChange={(e) => update({ note: e.target.value })} /></label>
      {!compact && <label className="f"><span>未確認事項</span><textarea data-testid="f-open" value={a.openQuestions} onChange={(e) => update({ openQuestions: e.target.value })} /></label>}
    </div>
  );
}
