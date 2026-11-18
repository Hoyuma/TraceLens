import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/theme.css';
import { AnnotationEditor, Brand, ConfirmDialog, LangSelect, useChanged, useReplay, useSession } from '../ui/common';
import { deleteStep, getProject, getScenario, listArtifacts, listProjects, listReplayRuns, listScenarios, listSteps, patchStep } from '../shared/db';
import { createGroup, flattenGroupTree } from '../shared/groups';
import { orderedSteps } from '../shared/steps';
import type { ReplayRun } from '../shared/replay';
import { newId, type Artifact, type Project, type Scenario, type Step } from '../shared/types';
import { fmtTime, stepSummary, captureProblems, kindLabel } from '../shared/describe';
import { originLabel, statusLabel, t, useI18n } from '../ui/i18n';
import { ExportDialog } from './ExportDialog';
import { ShotView } from './ShotView';
import { Details } from './Details';
import { ScenarioInfo } from './ScenarioInfo';
import { StepList } from './StepList';
import { GroupManager } from './GroupManager';
import { StepReplayEditor } from './StepReplayEditor';
import { ReplayPanel } from './ReplayPanel';
import { StepResultView } from './ResultViews';
import { AddStepDialog } from './AddStepDialog';
import { VariablesDialog } from './VariablesDialog';
import { ImportDialog } from './ImportDialog';
import { ManageDialog } from './ManageDialog';
import { applyGroupOp, setStepsGroup } from './actions';
import { editLockReason } from './logic';
import { OP_KINDS } from './labels';

const hashParams = new URLSearchParams(location.hash.slice(1));

function App() {
  const { lang } = useI18n();
  const session = useSession();
  const replay = useReplay();
  const [projects, setProjects] = useState<Project[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState(hashParams.get('scenario') ?? '');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [arts, setArts] = useState<Artifact[]>([]);
  const [runs, setRuns] = useState<ReplayRun[]>([]);
  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [tab, setTab] = useState<'intent' | 'replay'>('intent');
  const [showInfo, setShowInfo] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [dialog, setDialog] = useState<null | 'add' | 'vars' | 'import' | 'manage'>(hashParams.get('manage') === '1' ? 'manage' : null);
  const [delStep, setDelStep] = useState<Step | null>(null);
  const [range, setRange] = useState({ from: '', to: '' });
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [groupErr, setGroupErr] = useState('');

  const load = async () => {
    const [ps, ss] = await Promise.all([listProjects(), listScenarios()]);
    setProjects(ps); setScenarios(ss);
    const id = ss.find((s) => s.id === scenarioId)?.id ?? ss.at(-1)?.id ?? '';
    if (id !== scenarioId) { setScenarioId(id); if (!id) { setScenario(null); setSteps([]); setArts([]); setRuns([]); } return; }
    if (!id) return;
    const sc = await getScenario(id);
    if (!sc) return;
    const [st, ar, pj, rn] = await Promise.all([listSteps(id), listArtifacts(id), getProject(sc.projectId), listReplayRuns(id)]);
    setScenario(sc); setSteps(st); setArts(ar); setProject(pj ?? null); setRuns(rn);
  };
  useEffect(() => { void load(); history.replaceState(null, '', `#scenario=${scenarioId}`); /* eslint-disable-next-line */ }, [scenarioId]);
  useChanged(() => void load());

  // 再生の進行に合わせて結果を読み直す（再生が終わった直後も 1 回）
  const replayKey = replay ? `${replay.runId}:${replay.position}:${replay.status}` : 'none';
  useEffect(() => { if (scenarioId) void listReplayRuns(scenarioId).then(setRuns); /* eslint-disable-next-line */ }, [replayKey, scenarioId]);
  useEffect(() => {
    if (!replay) return;
    const i = setInterval(() => { if (scenarioId) void listReplayRuns(scenarioId).then(setRuns); }, 1500);
    return () => clearInterval(i);
  }, [replay?.runId, scenarioId]);
  useEffect(() => { setViewRunId(null); }, [scenarioId]);

  const ordered = useMemo(() => orderedSteps(steps), [steps]);
  const artById = useMemo(() => new Map(arts.map((a) => [a.id, a])), [arts]);
  const sel = steps.find((s) => s.id === selId) ?? ordered[0] ?? null;
  const shotOf = (s: Step) => (s.screenshot.status === 'captured' && s.screenshot.artifactId ? artById.get(s.screenshot.artifactId) : undefined);
  const afterShot = sel ? shotOf(sel) : undefined;
  const pressArt = sel?.pressScreenshot?.status === 'captured' && sel.pressScreenshot.artifactId ? artById.get(sel.pressScreenshot.artifactId) : undefined;
  const [shotKind, setShotKind] = useState<'press' | 'after'>('press');
  const showPress = shotKind === 'press' && !!pressArt;
  const shot = showPress ? pressArt : afterShot;
  const dom = sel?.dom.artifactId ? artById.get(sel.dom.artifactId) : undefined;
  const fallback = useMemo(() => {
    if (!sel || shot) return undefined;
    const prev = [...steps].filter((s) => s.seq < sel.seq && s.sessionId === sel.sessionId).reverse().find((s) => shotOf(s));
    return prev ? { step: prev, art: shotOf(prev)! } : undefined; // eslint-disable-next-line
  }, [sel?.id, shot, steps, artById]);
  const nextOpAt = sel ? steps.find((s) => s.seq > sel.seq && s.sessionId === sel.sessionId && OP_KINDS.has(s.kind))?.operationAt : undefined;

  const viewRun = runs.find((r) => r.id === viewRunId) ?? runs.at(-1);
  const results = useMemo(() => new Map((viewRun?.results ?? []).map((r) => [r.stepId, r])), [viewRun]);
  const currentStepId = replay && replay.scenarioId === scenarioId ? replay.plan[replay.position]?.stepId : undefined;

  const lock = scenario ? editLockReason(scenario, session?.scenarioId) : null;
  const replayingThis = !!replay && replay.scenarioId === scenarioId;
  const reload = () => void load();
  const goEdit = (stepId: string) => { setSelId(stepId); setTab('replay'); };
  const goScenario = (id: string) => { if (id !== scenarioId) { setSelId(null); setScenarioId(id); } else void load(); };

  const toggleInclude = async (s: Step) => { await patchStep(s.id, (x) => { x.includeInExport = !x.includeInExport; }); reload(); };
  const doDelete = async () => {
    const s = delStep; setDelStep(null);
    if (!s) return;
    await deleteStep(s.id);
    setSelId(null); reload();
  };

  const setGroup = async (value: string) => {
    if (!sel || !scenario) return;
    if (value === '__new') { setNewGroup(''); setGroupErr(''); return; }
    const from = Number(range.from) || sel.seq, to = Number(range.to) || sel.seq;
    const ids = steps.filter((s) => s.seq >= Math.min(from, to) && s.seq <= Math.max(from, to)).map((s) => s.id);
    await setStepsGroup(ids, value || undefined);
    setRange({ from: '', to: '' }); reload();
  };
  const createInlineGroup = async () => {
    if (!sel || !scenario || newGroup === null) return;
    const gid = newId('grp');
    const name = newGroup;
    const e = await applyGroupOp(scenario.id, (g) => createGroup(g, name, null, gid));
    if (e) { setGroupErr(e); return; }
    const from = Number(range.from) || sel.seq, to = Number(range.to) || sel.seq;
    await setStepsGroup(steps.filter((s) => s.seq >= Math.min(from, to) && s.seq <= Math.max(from, to)).map((s) => s.id), gid);
    setNewGroup(null); setRange({ from: '', to: '' }); reload();
  };

  const flatGroups = scenario ? flattenGroupTree(scenario.groups) : [];
  const delBlocked = lock ?? (replayingThis ? t('rv.delBlockedReplay') : null);

  return (
    <div className="rv">
      <div className="rv-top">
        <Brand />
        <span style={{ flex: 1 }} />
        <LangSelect />
        <select data-testid="rv-scenario" value={scenarioId} onChange={(e) => { setSelId(null); setScenarioId(e.target.value); }} aria-label={t('rv.scenarioAria')}>
          {scenarios.length === 0 && <option value="">{t('rv.noRecords')}</option>}
          {scenarios.map((s) => <option key={s.id} value={s.id}>{projects.find((p) => p.id === s.projectId)?.name ?? '?'} / {s.name}</option>)}
        </select>
        <button data-testid="btn-info" className={showInfo ? 'on' : ''} onClick={() => setShowInfo(!showInfo)}>{t('rv.info')}</button>
        <button data-testid="btn-vars" disabled={!scenario} onClick={() => setDialog('vars')}>{t('rv.vars')}</button>
        <button data-testid="btn-replay" className={showReplay || replayingThis ? 'on' : ''} disabled={!scenario} onClick={() => setShowReplay(!showReplay)}>{replayingThis ? t('rv.replayRunning') : t('rv.replay')}</button>
        <button data-testid="btn-import" disabled={!scenario} onClick={() => setDialog('import')}>{t('rv.import')}</button>
        <button data-testid="btn-manage" onClick={() => setDialog('manage')}>{t('rv.manage')}</button>
        <button className="primary" data-testid="btn-export" disabled={!scenario || !project} onClick={() => setShowExport(true)}>{t('rv.export')}</button>
      </div>
      {!scenario ? <div className="empty">{t('rv.empty')}</div> : (
        <div className="rv-body">
          <div className="col side">
            {session?.scenarioId === scenario.id && <div className="note warn" data-testid="recording-note">{t('rv.recordingNote')}</div>}
            <StepList scenario={scenario} steps={steps} selId={sel?.id ?? null} onSelect={setSelId} onChanged={reload} results={results} currentStepId={currentStepId} />
            <div className="row" style={{ marginTop: 8 }}>
              <button data-testid="btn-add-step" disabled={!!lock} title={lock ?? ''} onClick={() => setDialog('add')}>{t('rv.addStep')}</button>
            </div>
            {lock && <div className="small muted" data-testid="add-locked">{lock}</div>}
            <div style={{ marginTop: 10 }}><GroupManager scenario={scenario} steps={steps} onChanged={reload} /></div>
          </div>
          <div className="col mid">
            {showInfo && <ScenarioInfo scenario={scenario} onSaved={reload} />}
            {(showReplay || replayingThis) && <ReplayPanel scenario={scenario} steps={steps} selId={sel?.id ?? null} session={session} replay={replay} runs={runs} viewRunId={viewRun?.id ?? null} onViewRun={setViewRunId} onGoEdit={goEdit} onSelectStep={setSelId} onChanged={reload} />}
            {sel && sel.pressScreenshot && (
              <div className="row small" style={{ marginBottom: 6, flexWrap: 'wrap' }} data-testid="shot-kind">
                <button className={showPress ? 'on' : ''} data-testid="shot-kind-press" disabled={!pressArt} onClick={() => setShotKind('press')}>{t('rv.shotPress')}</button>
                <button className={!showPress ? 'on' : ''} data-testid="shot-kind-after" onClick={() => setShotKind('after')}>{t('rv.shotAfter')}</button>
                {!pressArt && <span className="muted" data-testid="press-none">{t('rv.pressNone', { status: statusLabel(sel.pressScreenshot.status), reason: sel.pressScreenshot.reason ?? t('shot.noReason') })}</span>}
              </div>
            )}
            {sel && showPress && (sel.pressScreenshot?.notes?.length ?? 0) > 0 && <div className="note info small" data-testid="press-notes">{sel.pressScreenshot!.notes!.join(' / ')}</div>}
            {sel ? <ShotView step={sel} art={shot} fallback={fallback} onChanged={reload} /> : <div className="empty">{t('rv.selectLeft')}</div>}
          </div>
          <div className="col side">
            {sel && (<>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <b>{t('rv.step', { seq: sel.seq })}</b> <span className="kind">{kindLabel(sel.kind, lang)}</span>
                {(sel.origin ?? 'recorded') !== 'recorded' && <span className={`badge origin ${sel.origin}`} data-testid="sel-origin">{originLabel(sel.origin ?? 'recorded')}</span>}
                <span className="small muted">{fmtTime(sel.operationAt)}{sel.origin === 'authored' ? t('rv.addedAt') : sel.origin === 'imported' ? t('rv.importedAtLabel') : ''}</span>
              </div>
              {sel.importedFrom && <div className="small muted" data-testid="sel-imported-from">{t('rv.importedFrom', { name: sel.importedFrom.scenarioName ?? t('rv.unknownName'), seq: sel.importedFrom.seq, time: fmtTime(sel.importedFrom.operationAt) })}</div>}
              <div className="small" style={{ wordBreak: 'break-all' }}>{stepSummary(sel, lang)}</div>
              <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <button data-testid="btn-exclude-step" onClick={() => void toggleInclude(sel)}>{sel.includeInExport ? t('rv.exclude') : t('rv.include')}</button>
                <button className="danger" data-testid="btn-delete-step" disabled={!!delBlocked} title={delBlocked ?? ''} onClick={() => setDelStep(sel)}>{t('rv.delete')}</button>
              </div>
              {delBlocked && <div className="small muted">{delBlocked}</div>}
              <div className="tabs" role="tablist" style={{ marginTop: 10 }}>
                <button role="tab" aria-selected={tab === 'intent'} className={tab === 'intent' ? 'on' : ''} data-testid="tab-intent" onClick={() => setTab('intent')}>{t('rv.tabIntent')}</button>
                <button role="tab" aria-selected={tab === 'replay'} className={tab === 'replay' ? 'on' : ''} data-testid="tab-replay" onClick={() => setTab('replay')}>{t('rv.tabReplay')}</button>
              </div>
              {tab === 'intent' && (<>
                {captureProblems(sel, lang).map((p, i) => <div key={i} className="note warn">{p}</div>)}
                <AnnotationEditor step={sel} onSaved={reload} />
                <div className="f" style={{ marginTop: 10 }}>
                  <span className="small muted">{t('rv.group')}</span>
                  <div className="row">
                    <select data-testid="group-select" value={sel.groupId && scenario.groups.some((g) => g.id === sel.groupId) ? sel.groupId : ''} onChange={(e) => void setGroup(e.target.value)}>
                      <option value="">{t('rv.none')}</option>
                      {flatGroups.map(({ group, depth }) => <option key={group.id} value={group.id}>{'　'.repeat(depth)}{group.name}</option>)}
                      <option value="__new">{t('rv.newGroup')}</option>
                    </select>
                  </div>
                  {newGroup !== null && (
                    <div className="row" style={{ marginTop: 4 }}>
                      <input data-testid="group-inline-name" autoFocus className="grow" value={newGroup} placeholder={t('rv.groupNamePh')} onChange={(e) => setNewGroup(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newGroup.trim()) void createInlineGroup(); if (e.key === 'Escape') setNewGroup(null); }} />
                      <button className="primary" data-testid="group-inline-ok" disabled={!newGroup.trim()} onClick={() => void createInlineGroup()}>{t('rv.createApply')}</button>
                      <button onClick={() => setNewGroup(null)}>{t('common.undo')}</button>
                    </div>
                  )}
                  {groupErr && <div className="note err">{groupErr}</div>}
                  <div className="row small muted" style={{ marginTop: 3 }}>{t('rv.rangeLabel')}{' '}<input style={{ width: 48 }} value={range.from} placeholder={String(sel.seq)} onChange={(e) => setRange({ ...range, from: e.target.value })} />〜<input style={{ width: 48 }} value={range.to} placeholder={String(sel.seq)} onChange={(e) => setRange({ ...range, to: e.target.value })} />{t('rv.rangeHint')}</div>
                </div>
                <Details step={sel} dom={dom} shot={afterShot} steps={steps} nextOpAt={nextOpAt} onChanged={reload} />
              </>)}
              {tab === 'replay' && (<>
                <div className="sec-title" style={{ marginTop: 8 }}>{t('rv.replayResult')}</div>
                <StepResultView result={results.get(sel.id)} run={viewRun} onEdit={() => setTab('replay')} />
                <div className="sec-title" style={{ marginTop: 12 }}>{t('rv.replaySettings')}</div>
                <StepReplayEditor key={sel.id} step={sel} scenario={scenario} steps={steps} onSaved={reload} />
              </>)}
            </>)}
          </div>
        </div>
      )}
      {showExport && scenario && project && <ExportDialog project={project} scenario={scenario} steps={steps} artifacts={arts} replayRun={runs.at(-1) ?? null} onClose={() => setShowExport(false)} onGoStep={(id) => setSelId(id)} reload={load} />}
      {dialog === 'add' && scenario && <AddStepDialog scenario={scenario} steps={steps} afterStepId={sel?.id ?? null} groupId={sel?.groupId} onClose={() => setDialog(null)} onAdded={(id) => { setDialog(null); setSelId(id); reload(); }} />}
      {dialog === 'vars' && scenario && <VariablesDialog scenario={scenario} steps={steps} onClose={() => setDialog(null)} onSaved={reload} />}
      {dialog === 'import' && scenario && <ImportDialog scenario={scenario} steps={steps} lockReason={lock} onClose={() => setDialog(null)} onDone={goScenario} />}
      {dialog === 'manage' && <ManageDialog busyScenarioIds={{ recording: session?.scenarioId, replaying: replay?.scenarioId }} onClose={() => setDialog(null)} onChanged={reload} />}
      {delStep && (
        <ConfirmDialog title={t('rv.deleteTitle')} okLabel={t('rv.deleteOk')} danger onCancel={() => setDelStep(null)} onOk={() => void doDelete()}>
          <p>{t('rv.deleteBody', { seq: delStep.seq, summary: stepSummary(delStep, lang) })}</p>
          <p className="small" data-testid="delete-note"><b>{t('rv.deleteNoteB')}</b>{t('rv.deleteNoteRest')}</p>
          {delStep.origin === 'recorded' && <div className="note warn">{t('rv.deleteRecorded')}</div>}
        </ConfirmDialog>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
