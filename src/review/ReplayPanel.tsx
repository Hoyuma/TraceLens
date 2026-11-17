import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildReplayPlan, planVariableNames, preflight, type ReplayAction, type ReplayRun } from '../shared/replay';
import type { ActiveReplay, ActiveSession, ReplayUiMsg } from '../shared/messages';
import { orderedSteps } from '../shared/steps';
import { stepSummary } from '../shared/describe';
import { getLang, runStatusLabel, t, trKnown, useI18n } from '../ui/i18n';
import type { Scenario, Step } from '../shared/types';
import { sendReplay } from '../ui/common';
import { REPLAY_TARGET_LABEL, replayTargetLabel, planOriginPatterns, replayOptionsFor, resultCounts, type ReplayTarget } from './logic';
import { fmtDateTime } from './ResultViews';

interface Props {
  scenario: Scenario;
  steps: Step[];
  selId: string | null;
  session: ActiveSession | null;
  replay: ActiveReplay | null;
  runs: ReplayRun[];
  viewRunId: string | null;
  onViewRun: (id: string | null) => void;
  onGoEdit: (stepId: string) => void;
  onSelectStep: (stepId: string) => void;
}

/** 実行時の値が空でないか（secret は空欄を「未入力」とみなす） */
const hasValue = (v: string | undefined, secret: boolean) => v !== undefined && (!secret || v !== '');

/** 再生先にできる既存のタブ。tabs 権限なしでは、アクセスが許可されたサイトのタブだけ url / title が見える */
interface TabCandidate { id: number; title: string; url: string; origin: string }
async function listTabCandidates(): Promise<TabCandidate[]> {
  try {
    const tabs = await chrome.tabs.query({});
    const out: TabCandidate[] = [];
    for (const tb of tabs) {
      if (tb.id === undefined || !tb.url) continue;
      try { const u = new URL(tb.url); if (u.protocol === 'http:' || u.protocol === 'https:') out.push({ id: tb.id, title: tb.title || tb.url, url: tb.url, origin: u.origin }); } catch { /* 読めない URL は候補にしない */ }
    }
    return out;
  } catch { return []; }
}

export function ReplayPanel({ scenario, steps, selId, session, replay, runs, viewRunId, onViewRun, onGoEdit, onSelectStep }: Props) {
  const { lang } = useI18n();
  const [target, setTarget] = useState<ReplayTarget>('all');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [values, setValues] = useState<Record<string, string | undefined>>({});
  const [secretInput, setSecretInput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tabChoice, setTabChoice] = useState<'new' | number>('new');
  const [tabCands, setTabCands] = useState<TabCandidate[]>([]);
  const [retryArmed, setRetryArmed] = useState(false);
  const refreshTabs = useCallback(() => { void listTabCandidates().then(setTabCands); }, []);
  useEffect(() => { if (!replay) refreshTabs(); }, [replay, refreshTabs]);
  const vars = scenario.variables ?? [];
  const ordered = useMemo(() => orderedSteps(steps), [steps]);
  const mine = replay?.scenarioId === scenario.id;
  const otherReplay = !!replay && !mine;

  const optsRes = replayOptionsFor(target, { selectedId: selId ?? undefined, fromId: fromId || ordered[0]?.id, toId: toId || ordered.at(-1)?.id });
  const planRes = useMemo((): { plan: ReplayAction[] } | { error: string } => {
    if ('error' in optsRes) return { error: optsRes.error };
    try { return { plan: buildReplayPlan(scenario, steps, optsRes.opts) }; } catch (e) { return { error: (e as Error).message }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id, steps, target, selId, fromId, toId]);
  const plan = 'plan' in planRes ? planRes.plan : [];

  const names = useMemo(() => planVariableNames(plan), [plan]);
  const provided = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const n of names) {
      const v = vars.find((x) => x.name === n);
      const x = values[n] ?? (v && !v.secret ? v.defaultValue : undefined);
      if (hasValue(x, !!v?.secret)) out[n] = x;
    }
    return out;
  }, [names, values, vars]);
  const pf = useMemo(() => preflight(plan, vars, provided), [plan, vars, provided]);
  const origins = useMemo(() => planOriginPatterns(plan), [plan]);
  const startBlock = session ? t('rp.blockRecording') : replay ? t('rp.blockOther') : null;
  const firstNav = plan[0]?.kind === 'navigate' && !!plan[0].url && !plan[0].reload;

  const send = async (m: ReplayUiMsg) => {
    setBusy(true); setMsg('');
    const r = await sendReplay(m);
    setBusy(false);
    if (!r.ok) setMsg(r.message ?? t('rp.rejected'));
    return r;
  };

  // ユーザー操作の同期的な延長で権限を要求する（await の後だと拒否される）
  const start = () => {
    if (startBlock || !('plan' in planRes) || plan.length === 0 || 'error' in optsRes) return;
    const o = optsRes;
    const tab = tabChoice === 'new' ? undefined : tabCands.find((x) => x.id === tabChoice);
    if (tabChoice !== 'new' && !tab) { setMsg(t('rp.tabGone')); return; }
    // 既存のタブで再生する場合は、そのタブのサイトへのアクセスも同じ要求に含める
    const reqOrigins = tab && !origins.includes(`${tab.origin}/*`) ? [...origins, `${tab.origin}/*`] : origins;
    const permP: Promise<boolean> = reqOrigins.length ? chrome.permissions.request({ origins: reqOrigins }).catch(() => false) : Promise.resolve(true);
    const variableValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(provided)) if (v !== undefined) variableValues[k] = v;
    void (async () => {
      setBusy(true); setMsg('');
      if (!(await permP)) { setBusy(false); setMsg(t('rp.permDenied')); return; }
      const r = await sendReplay({ t: 'ui:replay-start', scenarioId: scenario.id, mode: o.mode, ...o.opts, ...(tab ? { tabId: tab.id } : {}), variableValues });
      setBusy(false);
      if (!r.ok) { setMsg(r.message ?? t('rp.startFail')); if (r.preflight) setMsg((m) => t('rp.preflightNote', { m })); return; }
      setValues((v) => { const n = { ...v }; for (const x of vars) if (x.secret) delete n[x.name]; return n; }); // secret の値は画面にも残さない
    })();
  };

  // 実際に足りないオリジンを要求する。分からない場合は任意権限の <all_urls> を要求する（クリックの同期的な延長で呼ぶ）
  const reauth = () => {
    const w = replay?.waitReason;
    const want = w?.code === 'permission' && w.origin ? [`${w.origin}/*`] : w?.code === 'permission' && w.originUnknown ? ['<all_urls>'] : planOriginPatterns(replay?.plan ?? []);
    const p = chrome.permissions.request({ origins: want }).catch(() => false);
    void (async () => {
      if (!(await p)) { setMsg(t('rp.reauthDenied')); return; }
      await send({ t: 'ui:replay-resume' });
    })();
  };
  const resumeWithSecrets = async () => {
    const r = await send({ t: 'ui:replay-resume', variableValues: Object.fromEntries(Object.entries(secretInput).filter(([, v]) => v !== '')) });
    if (r.ok) setSecretInput({});
  };

  const viewRun = runs.find((r) => r.id === viewRunId) ?? runs.at(-1);
  const wr = replay?.waitReason;
  const wrKey = wr ? `${wr.code}:${'stepId' in wr ? wr.stepId ?? '' : ''}` : '';
  useEffect(() => { setRetryArmed(false); }, [wrKey]);
  const retryRisk = wr?.code === 'failed-step' && (wr.acted === 'yes' || wr.acted === 'possibly') ? wr.acted : null;
  const cur = replay ? replay.plan[replay.position] : undefined;
  const missingBlocking = pf.missingVariables.length > 0 || pf.sensitiveTemplates.length > 0;

  return (
    <div className="card" style={{ marginBottom: 10 }} data-testid="replay-panel">
      <div className="row"><div className="sec-title grow" style={{ marginBottom: 0 }}>{t('rp.title')}</div>
        {replay && <span className={`badge ${replay.status === 'running' ? 'rec' : 'pause'}`} data-testid="replay-status">{replay.status === 'running' ? t('run.running') : replay.status === 'stopping' ? t('rp.stopping') : t('run.paused')}</span>}</div>

      <div className="note info" data-testid="replay-limits">
        <b>{t('rp.limitsTitle')}</b>
        <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
          <li>{t('rp.l1').split('{code}')[0]}<code>isTrusted=false</code>{t('rp.l1').split('{code}')[1]}</li>
          <li>{t('rp.l2')}</li>
          <li>{t('rp.l3')}</li>
          <li>{t('rp.l4')}</li>
          <li>{t('rp.l5')}</li>
        </ul>
      </div>

      {otherReplay && <div className="note warn" data-testid="replay-other">{t('rp.otherReplay')}</div>}

      {mine && replay && (
        <div data-testid="replay-running" style={{ marginTop: 8 }}>
          <div className="small">{t(replay.stepMode ? 'rp.progressStep' : 'rp.progress', { pos: Math.min(replay.position + 1, replay.plan.length), total: replay.plan.length })}</div>
          {cur && <div className="small" data-testid="replay-current">{t('rp.nextLabel')} <a href="#" onClick={(e) => { e.preventDefault(); onSelectStep(cur.stepId); }}>{t('rv.step', { seq: cur.seq })}</a> — {cur.label}</div>}
          {wr && (
            <div className={`note ${wr.code === 'failed-step' || wr.code === 'permission' ? 'err' : 'warn'}`} data-testid="replay-wait" data-code={wr.code}>
              <div>{wr.message}</div>
              {wr.code === 'manual-step' && <>
                <div className="small">{t('rp.manualHint')}</div>
                <button className="primary" data-testid="replay-continue-manual" disabled={busy} onClick={() => void send({ t: 'ui:replay-continue-manual', stepId: wr.stepId })}>{t('rp.continue')}</button>
              </>}
              {wr.code === 'failed-step' && <>
                <div className="small">{t('rp.failedHint')}</div>
                {retryRisk && <div className="note warn" data-testid="replay-retry-warning" data-acted={retryRisk}>{t(retryRisk === 'yes' ? 'rp.retryWarnYes' : 'rp.retryWarnPossibly')}</div>}
                <div className="row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                  {/* 操作済み（の可能性がある）手順の再試行は、警告を出したうえで確認を挟む（二重操作の防止） */}
                  {retryRisk && retryArmed
                    ? <button className="danger" data-testid="replay-retry-confirm" disabled={busy} onClick={() => { setRetryArmed(false); void send({ t: 'ui:replay-resume' }); }}>{t('rp.retryConfirm')}</button>
                    : <button data-testid="replay-retry" disabled={busy} onClick={() => { if (retryRisk) setRetryArmed(true); else void send({ t: 'ui:replay-resume' }); }}>{t('rp.retry')}</button>}
                  {retryRisk && retryArmed && <button data-testid="replay-retry-cancel" disabled={busy} onClick={() => setRetryArmed(false)}>{t('common.cancel')}</button>}
                  <button data-testid="replay-skip-step" disabled={busy} onClick={() => void send({ t: 'ui:replay-continue-manual', stepId: wr.stepId })}>{t('rp.skipBtn')}</button>
                  <button className="link small" data-testid="replay-edit-failed" onClick={() => onGoEdit(wr.stepId)}>{t('rp.editFailed')}</button>
                </div>
              </>}
              {wr.code === 'secret-required' && <>
                {wr.names.map((n) => (
                  <label key={n} className="f"><span>{t('rp.secretName', { n })}</span>
                    <input type="password" autoComplete="off" data-testid="replay-secret-input" value={secretInput[n] ?? ''} onChange={(e) => setSecretInput({ ...secretInput, [n]: e.target.value })} /></label>
                ))}
                <button className="primary" data-testid="replay-secret-resume" disabled={busy || wr.names.some((n) => !secretInput[n])} onClick={() => void resumeWithSecrets()}>{t('rp.secretResume')}</button>
              </>}
              {wr.code === 'permission' && <>
                <div className="small" data-testid="replay-perm-hint">{wr.origin ? t('rp.permHintOrigin', { origin: wr.origin }) : wr.originUnknown ? t('rp.permHintUnknown') : t('rp.permHint')}</div>
                {wr.actedResume && <div className="small" data-testid="replay-acted-resume">{t('rp.actedResumeNote')}</div>}
                <button className="primary" data-testid="replay-reauth" data-origin={wr.origin ?? (wr.originUnknown ? '<all_urls>' : '')} disabled={busy} onClick={reauth}>{wr.originUnknown && !wr.origin ? t('rp.reauthAll') : t('rp.reauth')}</button>
              </>}
              {(wr.code === 'paused-by-user' || wr.code === 'step-mode') && <div className="small">{t('rp.pausedHint')}</div>}
            </div>
          )}
          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            {replay.status === 'running' && <button data-testid="replay-pause" disabled={busy} onClick={() => void send({ t: 'ui:replay-pause' })}>{t('sp.pause')}</button>}
            {/* 失敗で止まっているときは、汎用の再開を無効にし、確認つきの「再試行」「スキップ」だけを使う（二重操作の防止） */}
            {replay.status === 'paused' && <button className="primary" data-testid="replay-resume" title={wr?.code === 'failed-step' ? t('rp.resumeFailedTitle') : undefined} disabled={busy || wr?.code === 'secret-required' || wr?.code === 'permission' || wr?.code === 'failed-step'} onClick={() => void send({ t: 'ui:replay-resume' })}>{t('sp.resume')}</button>}
            {replay.status === 'paused' && <button data-testid="replay-step" disabled={busy || wr?.code === 'secret-required' || wr?.code === 'permission' || wr?.code === 'failed-step' || wr?.code === 'manual-step'} onClick={() => void send({ t: 'ui:replay-step' })}>{t('rp.stepOne')}</button>}
            <button className="danger" data-testid="replay-stop" disabled={busy || replay.status === 'stopping'} onClick={() => void send({ t: 'ui:replay-stop' })}>{t('rp.stopBtn')}</button>
          </div>
        </div>
      )}

      {!replay && (
        <div data-testid="replay-setup" style={{ marginTop: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="row small" style={{ gap: 4 }}>{t('rp.target')}
              <select data-testid="replay-target" style={{ width: 'auto' }} value={target} onChange={(e) => setTarget(e.target.value as ReplayTarget)}>
                {(Object.keys(REPLAY_TARGET_LABEL) as ReplayTarget[]).map((k) => <option key={k} value={k}>{replayTargetLabel(k)}</option>)}
              </select></label>
            {target === 'range' && (<>
              <select data-testid="replay-from" style={{ width: 'auto', maxWidth: 160 }} value={fromId || ordered[0]?.id || ''} onChange={(e) => setFromId(e.target.value)} aria-label={t('rp.fromAria')}>
                {ordered.map((s) => <option key={s.id} value={s.id}>{s.seq}. {stepSummary(s, lang).slice(0, 24)}</option>)}</select>
              <span className="small">〜</span>
              <select data-testid="replay-to" style={{ width: 'auto', maxWidth: 160 }} value={toId || ordered.at(-1)?.id || ''} onChange={(e) => setToId(e.target.value)} aria-label={t('rp.toAria')}>
                {ordered.map((s) => <option key={s.id} value={s.id}>{s.seq}. {stepSummary(s, lang).slice(0, 24)}</option>)}</select>
            </>)}
          </div>
          {(target === 'from-selected' || target === 'only-selected') && <div className="small muted">{t('rp.selectedLabel', { v: selId ? t('rv.step', { seq: steps.find((s) => s.id === selId)?.seq ?? '?' }) : t('rp.selectedNone') })}</div>}

          {'error' in planRes && <div className="note err" data-testid="replay-plan-error">{trKnown(planRes.error)}</div>}
          {'plan' in planRes && (
            <div className="small" style={{ marginTop: 6 }} data-testid="replay-plan-summary">
              {t('rp.planCount', { n: plan.filter((a) => a.kind !== 'unsupported').length })}
              {!firstNav && plan.length > 0 && tabChoice === 'new' && <div className="note warn" data-testid="replay-nofirstnav">{t('rp.noFirstNav')}<div className="small">{t('rp.noFirstNavPickTab')}</div></div>}
            </div>
          )}

          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <label className="row small" style={{ gap: 4 }}>{t('rp.tabLabel')}
              <select data-testid="replay-tab" style={{ width: 'auto', maxWidth: 280 }} value={tabChoice === 'new' ? 'new' : String(tabChoice)} onChange={(e) => setTabChoice(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
                <option value="new">{t('rp.tabNew')}</option>
                {tabCands.map((c) => <option key={c.id} value={String(c.id)} title={c.url}>{t('rp.tabExisting', { title: c.title.slice(0, 40) })}</option>)}
                {tabChoice !== 'new' && !tabCands.some((c) => c.id === tabChoice) && <option value={String(tabChoice)}>{t('rp.tabGone')}</option>}
              </select></label>
            <button className="link small" data-testid="replay-tab-refresh" onClick={refreshTabs}>{t('rp.tabRefresh')}</button>
          </div>
          <div className="small muted" data-testid="replay-tab-note">{t('rp.tabNote')}</div>

          {pf.manualSteps.length > 0 && <div className="note info" data-testid="replay-manual-list">{t('rp.manualList', { list: pf.manualSteps.map((m) => t('rv.step', { seq: m.seq })).join(t('var.sep')) })}<div className="small">{[...new Set(pf.manualSteps.map((m) => m.reason))].join(' / ')}</div></div>}
          {pf.sensitiveTemplates.length > 0 && <div className="note err" data-testid="replay-sensitive-block">{t('rp.sensitiveBlock', { list: pf.sensitiveTemplates.map((m) => t('rv.step', { seq: m.seq })).join(t('var.sep')) })}</div>}
          {pf.unsupported.length > 0 && <div className="note info" data-testid="replay-unsupported-list">{t('rp.unsupported', { list: pf.unsupported.map((m) => t('rv.step', { seq: m.seq })).join(t('var.sep')) })}</div>}

          {names.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="sec-title">{t('rp.varsTitle')}</div>
              {names.map((n) => {
                const v = vars.find((x) => x.name === n);
                const secret = !!v?.secret;
                return (
                  <label key={n} className="f" data-testid="replay-var">
                    <span>{n}{secret ? t('rp.secretNoStore') : ''}{!v ? t('rp.noDef') : ''}{v?.description ? ` — ${v.description}` : ''}</span>
                    <input type={secret ? 'password' : 'text'} autoComplete="off" data-testid={`replay-var-${n}`} value={values[n] ?? (v && !v.secret ? v.defaultValue ?? '' : '')}
                      onChange={(e) => setValues({ ...values, [n]: e.target.value })} />
                  </label>
                );
              })}
              {pf.missingVariables.length > 0 && <div className="note warn" data-testid="replay-missing">{t('rp.missing', { list: pf.missingVariables.map((m) => t('rp.missingItem', { name: m.name, secret: m.secret ? t('rp.secretTag') : '', seqs: m.stepIds.map((id) => steps.find((s) => s.id === id)?.seq).join(', ') })).join(t('var.sep')) })}</div>}
            </div>
          )}

          {origins.length > 0 && (
            <div style={{ marginTop: 8 }} data-testid="replay-origins">
              <div className="sec-title">{t('rp.originsTitle')}</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{origins.map((o) => <li key={o}><code>{o}</code></li>)}</ul>
              <div className="small muted">{t('rp.originsNote')}</div>
            </div>
          )}

          {startBlock && <div className="note err" data-testid="replay-blocked">{startBlock}</div>}
          {msg && <div className="note err" data-testid="replay-error">{msg}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" data-testid="replay-start" disabled={busy || !!startBlock || !('plan' in planRes) || plan.length === 0 || missingBlocking} onClick={start}>{t('rp.start')}</button>
            {pf.missingVariables.length > 0 && <span className="small muted">{t('rp.missingBlock')}</span>}
          </div>
        </div>
      )}
      {replay && msg && <div className="note err" data-testid="replay-error">{msg}</div>}

      <div style={{ marginTop: 10 }}>
        <div className="sec-title">{t('rp.history', { n: runs.length })}</div>
        {runs.length === 0 && <div className="small muted" data-testid="replay-no-runs">{t('rp.noRuns')}</div>}
        <ul className="runs" data-testid="replay-runs">
          {[...runs].reverse().map((r) => {
            const c = resultCounts(r);
            const stale = !replay && (r.status === 'running' || r.status === 'paused');
            return (
              <li key={r.id} className={r.id === viewRun?.id ? 'sel' : ''} data-testid="replay-run-row" data-run-id={r.id} data-status={r.status} onClick={() => onViewRun(r.id)}>
                <div className="row"><span>{fmtDateTime(r.startedAt)}</span><span className="badge">{stale ? t('rp.staleStatus') : runStatusLabel(r.status)}</span></div>
                <div className="small muted">{t('rp.counts', { ok: c.ok, failed: c.failed, manual: c.manual, skipped: c.skipped, pending: c.pending, n: r.planStepIds.length })}{r.reason ? ` — ${r.reason}` : ''}</div>
              </li>
            );
          })}
        </ul>
        {viewRun && <div className="small muted">{t('rp.viewing', { time: fmtDateTime(viewRun.startedAt) })}</div>}
      </div>
    </div>
  );
}
