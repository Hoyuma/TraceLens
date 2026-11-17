import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/theme.css';
import { AnnotationEditor, Brand, LangSelect, sendUi, useChanged, useReplay, useSession } from '../ui/common';
import { getScenario, listProjects, listScenarios, listSteps, putProject, putScenario } from '../shared/db';
import { SCHEMA_VERSION, hasAnnotation, newId, type Project, type Scenario, type Step } from '../shared/types';
import { captureLevel, captureProblems, kindLabel, stepSummary } from '../shared/describe';
import { t, useI18n } from '../ui/i18n';
import { SETTINGS_KEY, type RecordSettings } from '../shared/messages';

const params = new URLSearchParams(location.search);
const TAB_OVERRIDE = params.get('tabId') ? Number(params.get('tabId')) : null; // 自動テスト・別ウィンドウ表示用
const SEL_KEY = 'tracelens.selection';

function fmtElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function App() {
  const { lang } = useI18n();
  const session = useSession();
  const replay = useReplay();
  const [projects, setProjects] = useState<Project[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [projectId, setProjectId] = useState('');
  const [scenarioId, setScenarioId] = useState('');
  const [creating, setCreating] = useState<'project' | 'scenario' | null>(null);
  const [form, setForm] = useState({ name: '', desc: '' });
  const [steps, setSteps] = useState<Step[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [recTab, setRecTab] = useState<chrome.tabs.Tab | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const [allSites, setAllSites] = useState(false);
  const [settings, setSettings] = useState<RecordSettings>({});
  useEffect(() => { void chrome.storage.local.get(SETTINGS_KEY).then((r) => setSettings((r[SETTINGS_KEY] as RecordSettings | undefined) ?? {})); }, []);
  const changeSetting = (patchS: RecordSettings) => {
    setSettings((cur) => ({ ...cur, ...patchS }));
    // 表示言語など、別のページが書いた項目を消さないよう、保存済みの値に重ねて書く
    void chrome.storage.local.get(SETTINGS_KEY).then((r) => chrome.storage.local.set({ [SETTINGS_KEY]: { ...((r[SETTINGS_KEY] as RecordSettings | undefined) ?? {}), ...patchS } }));
  };

  const activeScenarioId = session?.scenarioId ?? scenarioId;

  const loadLists = async () => {
    const ps = await listProjects();
    setProjects(ps);
    const saved = (await chrome.storage.local.get(SEL_KEY))[SEL_KEY] as { projectId?: string; scenarioId?: string } | undefined;
    const pid = ps.find((p) => p.id === (projectId || saved?.projectId))?.id ?? ps[0]?.id ?? '';
    setProjectId(pid);
    const ss = pid ? await listScenarios(pid) : [];
    setScenarios(ss);
    setScenarioId((cur) => ss.find((s) => s.id === (cur || saved?.scenarioId))?.id ?? ss.at(-1)?.id ?? '');
  };
  useEffect(() => {
    void loadLists();
    const h = () => void loadLists();
    window.addEventListener('focus', h);
    return () => window.removeEventListener('focus', h); // eslint-disable-next-line
  }, []);
  // 記録中は、そのセッションのプロジェクト・シナリオを選択欄に反映する（別の画面から開始された場合も含む）
  useEffect(() => {
    if (!session) return;
    void (async () => {
      const sc = await getScenario(session.scenarioId);
      if (!sc) return;
      setProjects(await listProjects()); setProjectId(sc.projectId);
      setScenarios(await listScenarios(sc.projectId)); setScenarioId(sc.id);
    })();
  }, [session?.sessionId]);
  useEffect(() => { if (!projectId) return; void listScenarios(projectId).then((ss) => { setScenarios(ss); setScenarioId((cur) => ss.find((s) => s.id === cur)?.id ?? ss.at(-1)?.id ?? ''); }); }, [projectId]);
  useEffect(() => { if (projectId) void chrome.storage.local.set({ [SEL_KEY]: { projectId, scenarioId } }); }, [projectId, scenarioId]);

  const loadSteps = () => { if (activeScenarioId) void listSteps(activeScenarioId).then(setSteps); else setSteps([]); };
  useEffect(loadSteps, [activeScenarioId, session?.sessionId]);
  useChanged(loadSteps);

  // 記録対象タブ（開始前は、このウィンドウで表示中のタブ）
  useEffect(() => {
    const refresh = async () => {
      const t = TAB_OVERRIDE ? await chrome.tabs.get(TAB_OVERRIDE).catch(() => null) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
      setTab(t);
      setRecTab(session ? await chrome.tabs.get(session.tabId).catch(() => null) : null);
      setAllSites(await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false));
    };
    void refresh();
    const h = () => void refresh();
    chrome.tabs.onActivated.addListener(h); chrome.tabs.onUpdated.addListener(h);
    return () => { chrome.tabs.onActivated.removeListener(h); chrome.tabs.onUpdated.removeListener(h); };
  }, [session?.tabId, session?.needsPermission]);

  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, []);

  const elapsed = session ? (session.pausedAt ?? Date.now()) - session.startedAt - session.pausedAccumMs : 0;
  const sessionSteps = useMemo(() => (session ? steps.filter((s) => s.sessionId === session.sessionId) : steps), [steps, session]);
  const recent = sessionSteps.slice(-8).reverse();
  const selected = sessionSteps.find((s) => s.id === selId) ?? sessionSteps.at(-1) ?? null;
  const problems = sessionSteps.filter((s) => captureLevel(s) === 'fail').flatMap((s) => captureProblems(s, lang, false).map((p) => ({ seq: s.seq, p }))).slice(-3);

  const act = async (msg: Parameters<typeof sendUi>[0]) => {
    setBusy(true); setError('');
    const r = await sendUi(msg);
    setBusy(false);
    if (!r.ok && r.message) setError(r.message);
    return r;
  };
  const start = async () => {
    if (!scenarioId) { setError(t('sp.errNoScenario')); return; }
    if (!tab?.id) { setError(t('sp.errNoTab')); return; }
    await act({ t: 'ui:start', scenarioId, tabId: tab.id });
  };
  const create = async () => {
    const name = form.name.trim();
    if (!name) return;
    const now = new Date().toISOString();
    if (creating === 'project') {
      const p: Project = { schemaVersion: SCHEMA_VERSION, id: newId('prj'), name, description: form.desc.trim(), createdAt: now };
      await putProject(p); setProjects([...projects, p]); setProjectId(p.id); setScenarioId('');
    } else if (creating === 'scenario' && projectId) {
      const s: Scenario = { schemaVersion: SCHEMA_VERSION, id: newId('scn'), projectId, name, purpose: form.desc.trim(), preconditions: '', expectedResult: '', openQuestions: '', createdAt: now, updatedAt: now, sessions: [], groups: [], replacementRules: [] };
      await putScenario(s); setScenarios([...scenarios, s]); setScenarioId(s.id);
    }
    setCreating(null); setForm({ name: '', desc: '' });
  };
  const openReview = () => void chrome.tabs.create({ url: chrome.runtime.getURL(`review.html#scenario=${activeScenarioId}`) });
  const openManage = () => void chrome.tabs.create({ url: chrome.runtime.getURL(`review.html#scenario=${activeScenarioId}&manage=1`) });
  // 新しいタブへの記録継続: チェックを入れる操作の同期的な延長で、任意のホスト権限を要求する（許可されなくても設定は有効にでき、その場合はタブごとの再許可になる）
  const toggleFollow = (on: boolean) => {
    if (on && !allSites) void chrome.permissions.request({ origins: ['<all_urls>'] }).then(setAllSites, () => {});
    changeSetting({ followNewTab: on });
  };
  const requestAllSites = async () => {
    const ok = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    setAllSites(ok);
  };

  const shownTab = session ? recTab : tab;
  const notTarget = session && tab && tab.id !== session.tabId && !TAB_OVERRIDE;
  const status = !session ? 'idle' : session.status;

  return (
    <div className="sp">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}><Brand /><LangSelect /></div>

      <div className="card">
        <div className="sec-title">{t('sp.target')}</div>
        <div className="row">
          <select className="grow" data-testid="project-select" value={projectId} disabled={!!session} onChange={(e) => setProjectId(e.target.value)} aria-label={t('sp.projectAria')}>
            {projects.length === 0 && <option value="">{t('sp.noProject')}</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button data-testid="new-project" disabled={!!session} onClick={() => { setCreating('project'); setForm({ name: '', desc: '' }); }}>{t('sp.newProject')}</button>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <select className="grow" data-testid="scenario-select" value={scenarioId} disabled={!!session || !projectId} onChange={(e) => setScenarioId(e.target.value)} aria-label={t('sp.scenarioAria')}>
            {scenarios.length === 0 && <option value="">{t('sp.noScenario')}</option>}
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button data-testid="new-scenario" disabled={!!session || !projectId} onClick={() => { setCreating('scenario'); setForm({ name: '', desc: '' }); }}>{t('sp.newScenario')}</button>
        </div>
        {creating && (
          <div style={{ marginTop: 8 }}>
            <label className="f"><span>{creating === 'project' ? t('sp.projectName') : t('sp.scenarioName')}</span><input data-testid="create-name" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="f"><span>{creating === 'project' ? t('sp.descOpt') : t('sp.purposeOpt')}</span><input data-testid="create-desc" value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} /></label>
            <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setCreating(null)}>{t('common.cancel')}</button>
              <button className="primary" data-testid="create-ok" disabled={!form.name.trim()} onClick={create}>{t('sp.createOk')}</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="sec-title">{session ? t('sp.tabFixed') : t('sp.tabShown')}</div>
        {shownTab?.url ? (<>
          <div className="ellipsis" data-testid="target-title">{shownTab.title || t('sp.untitled')}</div>
          <div className="ellipsis small muted">{shownTab.url}</div>
        </>) : (
          <div className="small muted">{t('sp.noAccess')}</div>
        )}
        {notTarget && <div className="note warn">{t('sp.notTarget')}</div>}
        <div className="note info small">{(session ? session.followNewTab : settings.followNewTab) ? t('sp.oneTabFollow') : t('sp.oneTabNoFollow')}</div>
        {session?.pendingSwitch && <div className="note warn" data-testid="pending-switch">{t('sp.pendingSwitch')}</div>}
      </div>

      <div className="card">
        <div className="status">
          <span className={`dot ${status === 'recording' ? 'rec' : status === 'paused' ? 'pause' : ''}`} />
          <span className={`badge ${status === 'recording' ? 'rec' : status === 'paused' ? 'pause' : ''}`} data-testid="status">{status === 'recording' ? t('sp.statusRec') : status === 'paused' ? t('sp.statusPause') : t('sp.statusIdle')}</span>
          <span className="time" data-testid="elapsed" title={t('sp.elapsedTitle')}>{fmtElapsed(elapsed)}</span>
        </div>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {!session && <button className="primary" data-testid="btn-start" disabled={busy || !scenarioId || !!replay} onClick={start}>{t('sp.start')}</button>}
          {session?.status === 'recording' && <button data-testid="btn-pause" disabled={busy} onClick={() => act({ t: 'ui:pause' })}>{t('sp.pause')}</button>}
          {session?.status === 'paused' && <button className="primary" data-testid="btn-resume" disabled={busy} onClick={() => act({ t: 'ui:resume' })}>{t('sp.resume')}</button>}
          {session && <button className="danger" data-testid="btn-stop" disabled={busy} onClick={() => act({ t: 'ui:stop' })}>{t('sp.stop')}</button>}
        </div>
        {session && (
          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <button data-testid="btn-capture" title={t('sp.captureTitle')} disabled={busy || session.status !== 'recording'} onClick={() => act({ t: 'ui:manual-capture' })}>{t('sp.capture')}</button>
            <button data-testid="btn-capture-full" title={t('sp.captureFullTitle')} disabled={busy || session.status !== 'recording'} onClick={() => act({ t: 'ui:manual-capture', mode: 'full-page' })}>{t('sp.captureFull')}</button>
            <button data-testid="btn-capture-element" title={t('sp.captureElTitle')} disabled={busy || session.status !== 'recording' || session.picker} onClick={() => act({ t: 'ui:picker', on: true, shot: 'element' })}>{t('sp.captureEl')}</button>
            <button data-testid="btn-picker" className={session.picker ? 'on' : ''} disabled={busy || session.status !== 'recording'} onClick={() => act({ t: 'ui:picker', on: !session.picker })}>{session.picker ? t('sp.pickerCancel') : t('sp.picker')}</button>
          </div>
        )}
        {session?.picker && <div className="note info">{t('sp.pickerNote')}</div>}
        {replay && !session && <div className="note warn" data-testid="replay-running-note">{t('sp.replayRunning')}</div>}
        {error && <div className="note err" data-testid="error">{error}</div>}
        {session?.needsPermission && <div className="note err" data-testid="needs-permission">{t('sp.interrupted', { reason: session.needsPermission })}</div>}
        {problems.map((x, i) => <div key={i} className="note warn">{t('sp.stepProblem', { seq: x.seq, p: x.p })}</div>)}
      </div>

      <div className="card">
        <div className="sec-title">{sessionSteps.length ? t('sp.recentWithCount', { n: sessionSteps.length }) : t('sp.recent')}</div>
        {recent.length === 0 ? <div className="small muted">{t('sp.none')}</div> : (
          <ul className="steps-mini" data-testid="recent-steps">
            {recent.map((s) => (
              <li key={s.id} className={selected?.id === s.id ? 'sel' : ''} onClick={() => setSelId(s.id)}>
                <span className="n">{s.seq}</span><span className="kind">{kindLabel(s.kind, lang)}</span>
                <span className="grow ellipsis" title={stepSummary(s, lang)}>{stepSummary(s, lang)}</span>
                {hasAnnotation(s.annotation) && <span className="flag memo" title={t('sp.memoFlagTitle')}>✎</span>}
                {captureLevel(s) === 'fail' && <span className="flag fail" title={captureProblems(s, lang).join('\n')}>⚠</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <div className="card">
          <div className="sec-title">{selected.id === sessionSteps.at(-1)?.id ? t('sp.memoLast') : t('sp.memoStep', { seq: selected.seq })}</div>
          <div className="small ellipsis">{selected.seq}. {stepSummary(selected, lang)}</div>
          <AnnotationEditor step={selected} compact onSaved={loadSteps} />
        </div>
      )}

      <div className="card">
        <button data-testid="btn-review" disabled={!activeScenarioId} onClick={openReview} style={{ width: '100%' }}>{t('sp.openReview')}</button>
        <button data-testid="btn-manage" onClick={openManage} style={{ width: '100%', marginTop: 6 }}>{t('sp.openManage')}</button>
        <details style={{ marginTop: 8, borderTop: 'none' }} data-testid="record-options">
          <summary className="small">{t('sp.optSummary')}</summary>
          <div className="small muted" style={{ marginTop: 4 }}>{t('sp.optNote')}</div>
          <label className="row small" style={{ gap: 4, marginTop: 6, alignItems: 'flex-start' }}><input type="checkbox" data-testid="opt-before-shot" disabled={!!session} checked={!!settings.beforeShot} onChange={(e) => changeSetting({ beforeShot: e.target.checked })} /><span>{t('sp.optBefore')}</span></label>
          <label className="row small" style={{ gap: 4, marginTop: 6, alignItems: 'flex-start' }}><input type="checkbox" data-testid="opt-follow-tab" disabled={!!session} checked={!!settings.followNewTab} onChange={(e) => toggleFollow(e.target.checked)} /><span>{t('sp.optFollow')}</span></label>
        </details>
        <details style={{ marginTop: 8, borderTop: 'none' }}>
          <summary className="small">{t('sp.accessSummary')}</summary>
          <div className="small muted" style={{ marginTop: 4 }}>
            {t('sp.accessBody')}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="small grow">{allSites ? t('sp.allSitesOn') : t('sp.allSitesOff')}</span>
            {!allSites ? <button className="small" onClick={requestAllSites}>{t('sp.grant')}</button> : <button className="small" onClick={() => chrome.permissions.remove({ origins: ['<all_urls>'] }).then(() => setAllSites(false))}>{t('sp.revoke')}</button>}
          </div>
        </details>
        <div className="small muted" style={{ marginTop: 6 }}>{t('sp.local')}</div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
