import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/theme.css';
import { AnnotationEditor, Brand, sendUi, useChanged, useSession } from '../ui/common';
import { getScenario, listProjects, listScenarios, listSteps, putProject, putScenario } from '../shared/db';
import { KIND_LABEL, SCHEMA_VERSION, hasAnnotation, newId, type Project, type Scenario, type Step } from '../shared/types';
import { captureLevel, captureProblems, stepSummary } from '../shared/describe';

const params = new URLSearchParams(location.search);
const TAB_OVERRIDE = params.get('tabId') ? Number(params.get('tabId')) : null; // 自動テスト・別ウィンドウ表示用
const SEL_KEY = 'tracelens.selection';

function fmtElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function App() {
  const session = useSession();
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
  const problems = sessionSteps.filter((s) => captureLevel(s) === 'fail').flatMap((s) => captureProblems(s).filter((p) => !p.includes('取得待ち')).map((p) => ({ seq: s.seq, p }))).slice(-3);

  const act = async (msg: Parameters<typeof sendUi>[0]) => {
    setBusy(true); setError('');
    const r = await sendUi(msg);
    setBusy(false);
    if (!r.ok && r.message) setError(r.message);
    return r;
  };
  const start = async () => {
    if (!scenarioId) { setError('シナリオを選択または作成してください。'); return; }
    if (!tab?.id) { setError('記録対象のタブが見つかりません。'); return; }
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
  const requestAllSites = async () => {
    const ok = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    setAllSites(ok);
  };

  const shownTab = session ? recTab : tab;
  const notTarget = session && tab && tab.id !== session.tabId && !TAB_OVERRIDE;
  const status = !session ? 'idle' : session.status;

  return (
    <div className="sp">
      <Brand />

      <div className="card">
        <div className="sec-title">調査対象</div>
        <div className="row">
          <select className="grow" data-testid="project-select" value={projectId} disabled={!!session} onChange={(e) => setProjectId(e.target.value)} aria-label="プロジェクト">
            {projects.length === 0 && <option value="">（プロジェクトなし）</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button data-testid="new-project" disabled={!!session} onClick={() => { setCreating('project'); setForm({ name: '', desc: '' }); }}>＋ PJ</button>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <select className="grow" data-testid="scenario-select" value={scenarioId} disabled={!!session || !projectId} onChange={(e) => setScenarioId(e.target.value)} aria-label="シナリオ">
            {scenarios.length === 0 && <option value="">（シナリオなし）</option>}
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button data-testid="new-scenario" disabled={!!session || !projectId} onClick={() => { setCreating('scenario'); setForm({ name: '', desc: '' }); }}>＋ シナリオ</button>
        </div>
        {creating && (
          <div style={{ marginTop: 8 }}>
            <label className="f"><span>{creating === 'project' ? 'プロジェクト名' : 'シナリオ名'}</span><input data-testid="create-name" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="f"><span>{creating === 'project' ? '説明（任意）' : '調査目的（任意・後から編集可）'}</span><input data-testid="create-desc" value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} /></label>
            <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setCreating(null)}>キャンセル</button>
              <button className="primary" data-testid="create-ok" disabled={!form.name.trim()} onClick={create}>作成</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="sec-title">記録対象タブ{session ? '（固定）' : '（表示中のタブ）'}</div>
        {shownTab?.url ? (<>
          <div className="ellipsis" data-testid="target-title">{shownTab.title || '(無題)'}</div>
          <div className="ellipsis small muted">{shownTab.url}</div>
        </>) : (
          <div className="small muted">このタブにはまだアクセスが許可されていません。記録したいタブを表示して、ツールバーの TraceLens アイコンをクリックしてください。</div>
        )}
        {notTarget && <div className="note warn">いま表示中のタブは記録対象ではありません（記録されません）。</div>}
        <div className="note info small">記録するのはこのタブだけです。新しいタブ・別ウィンドウへの記録継続は未対応です。</div>
      </div>

      <div className="card">
        <div className="status">
          <span className={`dot ${status === 'recording' ? 'rec' : status === 'paused' ? 'pause' : ''}`} />
          <span className={`badge ${status === 'recording' ? 'rec' : status === 'paused' ? 'pause' : ''}`} data-testid="status">{status === 'recording' ? '記録中' : status === 'paused' ? '一時停止中' : '待機中'}</span>
          <span className="time" data-testid="elapsed" title="記録時間（一時停止中を除く）">{fmtElapsed(elapsed)}</span>
        </div>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {!session && <button className="primary" data-testid="btn-start" disabled={busy || !scenarioId} onClick={start}>● 記録を開始</button>}
          {session?.status === 'recording' && <button data-testid="btn-pause" disabled={busy} onClick={() => act({ t: 'ui:pause' })}>一時停止</button>}
          {session?.status === 'paused' && <button className="primary" data-testid="btn-resume" disabled={busy} onClick={() => act({ t: 'ui:resume' })}>再開</button>}
          {session && <button className="danger" data-testid="btn-stop" disabled={busy} onClick={() => act({ t: 'ui:stop' })}>■ 終了</button>}
        </div>
        {session && (
          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <button data-testid="btn-capture" disabled={busy || session.status !== 'recording'} onClick={() => act({ t: 'ui:manual-capture' })}>画面を保存</button>
            <button data-testid="btn-picker" className={session.picker ? 'on' : ''} disabled={busy || session.status !== 'recording'} onClick={() => act({ t: 'ui:picker', on: !session.picker })}>{session.picker ? '選択をキャンセル' : '要素を選んで注記'}</button>
          </div>
        )}
        {session?.picker && <div className="note info">ページ上の要素をクリックして選択します（クリックによる送信・遷移は起きません）。Esc でもキャンセルできます。</div>}
        {error && <div className="note err" data-testid="error">{error}</div>}
        {session?.needsPermission && <div className="note err" data-testid="needs-permission">記録が中断しています: {session.needsPermission}</div>}
        {problems.map((x, i) => <div key={i} className="note warn">手順 {x.seq}: {x.p}</div>)}
      </div>

      <div className="card">
        <div className="sec-title">最近の操作{sessionSteps.length ? `（全 ${sessionSteps.length} 件）` : ''}</div>
        {recent.length === 0 ? <div className="small muted">まだ記録がありません。</div> : (
          <ul className="steps-mini" data-testid="recent-steps">
            {recent.map((s) => (
              <li key={s.id} className={selected?.id === s.id ? 'sel' : ''} onClick={() => setSelId(s.id)}>
                <span className="n">{s.seq}</span><span className="kind">{KIND_LABEL[s.kind]}</span>
                <span className="grow ellipsis" title={stepSummary(s)}>{stepSummary(s)}</span>
                {hasAnnotation(s.annotation) && <span className="flag memo" title="注記あり">✎</span>}
                {captureLevel(s) === 'fail' && <span className="flag fail" title={captureProblems(s).join('\n')}>⚠</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <div className="card">
          <div className="sec-title">{selected.id === sessionSteps.at(-1)?.id ? '直前の操作へのメモ' : `手順 ${selected.seq} へのメモ`}（任意）</div>
          <div className="small ellipsis">{selected.seq}. {stepSummary(selected)}</div>
          <AnnotationEditor step={selected} compact onSaved={loadSteps} />
        </div>
      )}

      <div className="card">
        <button data-testid="btn-review" disabled={!activeScenarioId} onClick={openReview} style={{ width: '100%' }}>レビュー画面を開く</button>
        <details style={{ marginTop: 8, borderTop: 'none' }}>
          <summary className="small">アクセス権について</summary>
          <div className="small muted" style={{ marginTop: 4 }}>
            TraceLens は、アイコンをクリックしたタブへの一時的なアクセス（同一オリジン内の遷移まで有効）だけで動作します。別オリジンへ遷移すると権限が失効するため、対象タブでアイコンを再クリックしてください。
            複数オリジンをまたぐ調査では、任意で全サイトへのアクセスを許可できます（許可しても記録するのは対象タブだけです）。
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="small grow">全サイトへのアクセス: {allSites ? '許可済み' : '未許可（既定）'}</span>
            {!allSites ? <button className="small" onClick={requestAllSites}>許可する（任意）</button> : <button className="small" onClick={() => chrome.permissions.remove({ origins: ['<all_urls>'] }).then(() => setAllSites(false))}>取り消す</button>}
          </div>
        </details>
        <div className="small muted" style={{ marginTop: 6 }}>記録はこのブラウザ内にのみ保存され、外部へ送信されません。</div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
