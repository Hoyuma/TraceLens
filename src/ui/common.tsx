import { useCallback, useEffect, useRef, useState } from 'react';
import { EVT_CHANGED, REPLAY_STATE_KEY, STATE_KEY, type ActiveReplay, type ActiveSession, type ReplayUiMsg, type ReplayUiReply, type UiMsg, type UiReply } from '../shared/messages';
import { patchStep } from '../shared/db';
import { newId, type Annotation, type Condition, type Step } from '../shared/types';
import { fmtTime } from '../shared/describe';
import { LANGS, setLang, t, useI18n, type Lang } from './i18n';

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

/** 進行中の再生（chrome.storage.session）。useSession と同じ方式で購読する。 */
export function useReplay(): ActiveReplay | null {
  const [s, setS] = useState<ActiveReplay | null>(null);
  useEffect(() => {
    chrome.storage.session.get(REPLAY_STATE_KEY).then((v) => setS((v[REPLAY_STATE_KEY] as ActiveReplay) ?? null)).catch(() => setS(null));
    const h = (ch: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'session' && REPLAY_STATE_KEY in ch) setS((ch[REPLAY_STATE_KEY].newValue as ActiveReplay) ?? null); };
    chrome.storage.onChanged.addListener(h);
    return () => chrome.storage.onChanged.removeListener(h);
  }, []);
  return s;
}

const REPLAY_REPLY_TIMEOUT_MS = 30_000;

/**
 * 再生エンジン（Service Worker）へ送る。応答が無い・拒否された場合も、理由つきの ok:false を返す
 * （エンジンが未対応・停止中でも UI を壊さない）。
 */
export async function sendReplay(msg: ReplayUiMsg | (Omit<Extract<ReplayUiMsg, { t: 'ui:replay-start' }>, 'tabId'> & { tabId?: number })): Promise<ReplayUiReply> {
  let timer: number | undefined;
  try {
    const timeout = new Promise<ReplayUiReply>((res) => { timer = window.setTimeout(() => res({ ok: false, code: 'timeout', message: t('common.replayTimeout', { s: REPLAY_REPLY_TIMEOUT_MS / 1000 }) }), REPLAY_REPLY_TIMEOUT_MS); });
    const r = await Promise.race([chrome.runtime.sendMessage(msg) as Promise<ReplayUiReply | undefined>, timeout]);
    if (!r) return { ok: false, code: 'no-reply', message: t('common.replayNoReply') };
    if (!r.ok && !r.message) return { ...r, message: t('common.replayFailedCode', { code: r.code ?? t('common.unknown') }) };
    return r;
  } catch (e) {
    return { ok: false, code: 'send-failed', message: t('common.replaySendFailed', { err: String(e) }) };
  } finally { clearTimeout(timer); }
}

/** モーダル。Esc で閉じる。 */
export function Modal({ title, onClose, children, footer, width, testId }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number; testId?: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" data-testid={testId} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal" style={width ? { width: `min(${width}px, 94vw)`, height: 'auto', maxHeight: '92vh' } : undefined}>
        <header><h2 style={{ fontSize: 15 }}>{title}</h2><span style={{ flex: 1 }} /><button onClick={onClose} data-testid="modal-close">{t('common.close')}</button></header>
        <div className="content">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

/** 確認ダイアログ（window.confirm は使わない） */
export function ConfirmDialog({ title, children, okLabel, danger, busy, onOk, onCancel }: { title: string; children: React.ReactNode; okLabel: string; danger?: boolean; busy?: boolean; onOk: () => void; onCancel: () => void }) {
  return (
    <Modal title={title} onClose={onCancel} width={520} testId="confirm-dialog" footer={<>
      <button data-testid="confirm-cancel" onClick={onCancel}>{t('common.cancel')}</button>
      <button data-testid="confirm-ok" className={danger ? 'danger' : 'primary'} disabled={busy} onClick={onOk}>{okLabel}</button>
    </>}>
      {children}
    </Modal>
  );
}

export function Brand() {
  useI18n();
  return <div className="brand"><b>TraceLens</b><small>{t('brand.tagline')}</small></div>;
}

/**
 * 表示言語の選択（サイドパネルとレビュー画面のヘッダー）。選んだ言語は chrome.storage.local に保存され、別のページにも反映される。
 * 出力ZIPと保存済みデータの文言は言語にかかわらず日本語のままなので、英語表示のときはその旨を注記する。
 */
export function LangSelect() {
  const { lang } = useI18n();
  return (
    <span className="lang-sel" style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, maxWidth: 240 }}>
      <select data-testid="lang-select" value={lang} aria-label={t('lang.label')} title={t('lang.label')} style={{ width: 'auto' }} onChange={(e) => void setLang(e.target.value as Lang)}>
        {LANGS.map((l) => <option key={l} value={l}>{l === 'ja' ? '日本語' : 'English'}</option>)}
      </select>
      {lang !== 'ja' && <small className="muted" data-testid="lang-note" style={{ fontSize: 10, lineHeight: 1.3 }}>{t('lang.note')}</small>}
    </span>
  );
}

const BASIS_KEYS = [['human-stated', 'ann.basisHuman'], ['observed', 'ann.basisObserved'], ['unverified', 'ann.basisUnverified']] as const;

function CondList({ type, label, hint, a, update }: { type: Condition['type']; label: string; hint: string; a: Annotation; update: (p: Partial<Annotation>) => void }) {
  const list = a.conditions.filter((c) => c.type === type);
  const set = (id: string, p: Partial<Condition>) => update({ conditions: a.conditions.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  return (
    <div className="f" style={{ marginTop: 8 }}>
      <div className="row"><span className="small muted grow">{label}</span>
        <button className="link small" data-testid={`add-${type}`} onClick={() => update({ conditions: [...a.conditions, { id: newId('cnd'), type, text: '', basis: 'human-stated' }] })}>{t('ann.add')}</button></div>
      {list.length === 0 && <div className="small muted">{t('ann.notEntered', { hint })}</div>}
      {list.map((c) => (
        <div className="cond" key={c.id}>
          <input data-testid={`cond-${type}`} value={c.text} placeholder={hint} onChange={(e) => set(c.id, { text: e.target.value })} />
          <select value={c.basis} title={t('ann.basisTitle')} onChange={(e) => set(c.id, { basis: e.target.value as Condition['basis'], observedAt: e.target.value === 'observed' ? c.observedAt ?? new Date().toISOString() : undefined })}>
            {BASIS_KEYS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
          </select>
          <button title={t('common.delete')} onClick={() => update({ conditions: a.conditions.filter((x) => x.id !== c.id) })}>×</button>
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
      <label className="f"><span>{t('ann.purpose')}</span><input data-testid="f-purpose" value={a.purpose} placeholder={t('ann.purposeEx')} onChange={(e) => update({ purpose: e.target.value })} /></label>
      {hasValue || !compact ? (
        <div className="f" style={{ marginTop: 8 }}>
          <span className="small muted">{t('ann.valueHandling')}{step.value && !step.value.redacted && step.value.text !== undefined ? t('ann.valueExample', { v: step.value.text }) : ''}</span>
          <div className="row" style={{ marginTop: 2 }}>
            {([['unspecified', 'ann.vkUnspecified'], ['fixed', 'ann.vkFixed'], ['variable', 'ann.vkVariable']] as const).map(([v, l]) => (
              <label key={v} className="row" style={{ gap: 3 }}><input type="radio" name={`vk-${step.id}`} data-testid={`vk-${v}`} checked={a.valueKind === v} onChange={() => update({ valueKind: v })} />{t(l)}</label>
            ))}
          </div>
          {a.valueKind === 'variable' && (<>
            <label className="f"><span>{t('ann.varName')}</span><input data-testid="f-variable" value={a.variableName} placeholder={t('ann.varNameEx')} onChange={(e) => update({ variableName: e.target.value })} /></label>
            <label className="f"><span>{t('ann.source')}</span><input data-testid="f-source" value={a.valueSource} placeholder={t('ann.sourceEx')} onChange={(e) => update({ valueSource: e.target.value })} /></label>
            {!compact && <label className="f"><span>{t('ann.transform')}</span><input data-testid="f-transform" value={a.transformRule} placeholder={t('ann.transformEx')} onChange={(e) => update({ transformRule: e.target.value })} /></label>}
          </>)}
        </div>
      ) : null}
      {!compact && <CondList type="proceed" label={t('ann.proceed')} hint={t('ann.proceedEx')} a={a} update={update} />}
      <CondList type="success" label={t('ann.success')} hint={t('ann.successEx')} a={a} update={update} />
      {!compact && liveObs.length > 0 && (
        <div className="note info">{t('ann.liveObserved')}
          {liveObs.map((o, i) => (
            <div key={i} className="row"><span className="grow">{t('ann.quote', { v: o.text })}<span className="muted">{t('ann.paren', { v: fmtTime(o.at) })}</span></span>
              <button className="link small" onClick={() => update({ conditions: [...a.conditions, { id: newId('cnd'), type: 'success', text: t('ann.shownText', { v: o.text }), basis: 'observed', observedAt: o.at }] })}>{t('ann.addToSuccess')}</button></div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small muted grow">{t('ann.humanConfirm')} {confirmedAt ? fmtTime(confirmedAt) : t('common.unverified')}</span>
        {confirmedAt ? <button className="link small" onClick={() => confirm(false)}>{t('common.undo')}</button> : <button data-testid="confirm-done" onClick={() => confirm(true)}>{t('ann.confirmNow')}</button>}
      </div>
      {!compact && <label className="f"><span>{t('ann.branching')}</span><textarea data-testid="f-branching" value={a.branching} placeholder={t('ann.branchingEx')} onChange={(e) => update({ branching: e.target.value })} /></label>}
      <label className="f"><span>{t('ann.note')}</span><textarea data-testid="f-note" value={a.note} placeholder={t('ann.noteEx')} onChange={(e) => update({ note: e.target.value })} /></label>
      {!compact && <label className="f"><span>{t('ann.open')}</span><textarea data-testid="f-open" value={a.openQuestions} onChange={(e) => update({ openQuestions: e.target.value })} /></label>}
    </div>
  );
}
