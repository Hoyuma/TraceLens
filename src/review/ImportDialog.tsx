import { useEffect, useMemo, useState } from 'react';
import { deleteScenario, listProjects, listScenarios, listSteps, putScenario } from '../shared/db';
import {
  IMPORT_RESEARCH_DATA_WARNING, importParsedExport, importStepsFromScenario, parseExportZip, planStepCopy, scenarioFromDraft,
  type CopyPlan, type ParsedExport,
} from '../shared/importScenario';
import { flattenGroupTree } from '../shared/groups';
import { orderedSteps } from '../shared/steps';
import { type Project, type Scenario, type Step } from '../shared/types';
import { kindLabel, stepSummary } from '../shared/describe';
import { getLang, t, useI18n } from '../ui/i18n';
import { Modal } from '../ui/common';

type Parsed = Extract<ParsedExport, { ok: true }>;

interface Props {
  scenario: Scenario;
  steps: Step[];
  /** 記録中のシナリオ ID（そのシナリオへは取り込めない） */
  recordingScenarioId?: string | null;
  lockReason: string | null;
  onClose: () => void;
  onDone: (scenarioId: string) => void;
}

/** 取り込み時の固定の注意文は、表示言語に合わせて表示する（保存データ・出力には影響しない） */
const warnText = (w: string) => (w === IMPORT_RESEARCH_DATA_WARNING ? t('im.researchWarning') : w);

function ResultNote({ plan }: { plan: CopyPlan }) {
  return (
    <div className="note info" data-testid="import-result">{t('im.result', { n: plan.steps.length, m: plan.artifacts.length })}</div>
  );
}

export function ImportDialog({ scenario, steps, lockReason, onClose, onDone }: Props) {
  const [tab, setTab] = useState<'scenario' | 'zip'>('scenario');
  return (
    <Modal title={t('im.title')} onClose={onClose} width={820} testId="import-dialog">
      <div className="note warn" data-testid="import-research-warning">{warnText(IMPORT_RESEARCH_DATA_WARNING)}</div>
      <div className="row" style={{ margin: '8px 0' }}>
        <button className={tab === 'scenario' ? 'on' : ''} data-testid="import-tab-scenario" onClick={() => setTab('scenario')}>{t('im.fromScenario')}</button>
        <button className={tab === 'zip' ? 'on' : ''} data-testid="import-tab-zip" onClick={() => setTab('zip')}>{t('im.fromZip')}</button>
      </div>
      {tab === 'scenario' ? <FromScenario scenario={scenario} steps={steps} lockReason={lockReason} onDone={onDone} /> : <FromZip scenario={scenario} lockReason={lockReason} onDone={onDone} />}
    </Modal>
  );
}

// ---- (a) 別シナリオから --------------------------------------------------------------

function FromScenario({ scenario, steps, lockReason, onDone }: { scenario: Scenario; steps: Step[]; lockReason: string | null; onDone: (id: string) => void }) {
  const { lang } = useI18n();
  const [all, setAll] = useState<{ sc: Scenario; project?: Project }[]>([]);
  const [srcId, setSrcId] = useState('');
  const [srcSteps, setSrcSteps] = useState<Step[]>([]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [parentId, setParentId] = useState('');
  const [newName, setNewName] = useState('');
  const [withArts, setWithArts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<CopyPlan | null>(null);

  useEffect(() => { void (async () => {
    const [ps, ss] = await Promise.all([listProjects(), listScenarios()]);
    setAll(ss.map((sc) => ({ sc, project: ps.find((p) => p.id === sc.projectId) })));
    setSrcId((cur) => cur || ss.find((s) => s.id !== scenario.id)?.id || ss[0]?.id || '');
  })(); }, [scenario.id]);
  useEffect(() => { if (!srcId) { setSrcSteps([]); return; } void listSteps(srcId).then((s) => { const o = orderedSteps(s); setSrcSteps(o); setPick(new Set(o.map((x) => x.id))); }); setDone(null); }, [srcId]);

  const src = all.find((x) => x.sc.id === srcId)?.sc;
  const preview = useMemo(() => {
    if (!src || pick.size === 0) return null;
    try {
      return planStepCopy({ kind: 'scenario', scenario: { id: src.id, name: src.name, groups: src.groups ?? [], variables: src.variables ?? [] }, steps: srcSteps, artifacts: [] },
        { scenario, steps }, { stepIds: [...pick], newGroupName: newName.trim() || undefined, newGroupParentId: parentId || null, copyArtifacts: false, now: new Date().toISOString() });
    } catch (e) { return { error: String(e) }; }
  }, [src, srcSteps, pick, newName, parentId, scenario, steps]);

  const run = async () => {
    if (lockReason || !srcId) return;
    setBusy(true); setErr('');
    try {
      const plan = await importStepsFromScenario({ sourceScenarioId: srcId, targetScenarioId: scenario.id, stepIds: [...pick], newGroupName: newName.trim() || undefined, newGroupParentId: parentId || null, copyArtifacts: withArts });
      setDone(plan); onDone(scenario.id);
    } catch (e) { setErr(t('im.fail', { err: (e as Error).message ?? String(e) })); } finally { setBusy(false); }
  };
  const toggle = (id: string, on: boolean) => setPick((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });

  return (
    <div data-testid="import-from-scenario">
      <label className="f"><span>{t('im.srcScenario')}</span>
        <select data-testid="import-src" value={srcId} onChange={(e) => setSrcId(e.target.value)}>
          {all.map(({ sc, project }) => <option key={sc.id} value={sc.id}>{project?.name ?? '?'} / {sc.name}{sc.id === scenario.id ? t('im.thisScenario') : ''}</option>)}
        </select></label>
      <div className="sec-title" style={{ marginTop: 10 }}>{t('im.stepsTitle', { pick: pick.size, total: srcSteps.length })}</div>
      <div className="row small"><button className="link" onClick={() => setPick(new Set(srcSteps.map((s) => s.id)))}>{t('im.selectAll')}</button><button className="link" onClick={() => setPick(new Set())}>{t('im.selectNone')}</button></div>
      <ul className="pick-list" data-testid="import-steps">
        {srcSteps.map((s) => (
          <li key={s.id}><label className="row" style={{ gap: 6 }}><input type="checkbox" checked={pick.has(s.id)} onChange={(e) => { const on = e.target.checked; toggle(s.id, on); }} />
            <span className="n">{s.seq}</span><span className="kind">{kindLabel(s.kind, lang)}</span><span className="ellipsis grow">{stepSummary(s, lang)}</span></label></li>
        ))}
        {srcSteps.length === 0 && <li className="muted">{t('im.noSteps')}</li>}
      </ul>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <label className="row small" style={{ gap: 4 }}>{t('im.destGroup')}
          <select data-testid="import-parent" style={{ width: 'auto' }} value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">{t('grp.top')}</option>
            {flattenGroupTree(scenario.groups).map(({ group, depth }) => <option key={group.id} value={group.id}>{'　'.repeat(depth)}{group.name}</option>)}
          </select></label>
        <label className="row small" style={{ gap: 4 }}>{t('im.newGroup')}
          <input data-testid="import-newgroup" style={{ width: 160 }} value={newName} placeholder={t('im.newGroupPh')} onChange={(e) => setNewName(e.target.value)} /></label>
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" data-testid="import-arts" checked={withArts} onChange={(e) => { const on = e.target.checked; setWithArts(on); }} />{t('im.copyArts')}</label>
      </div>
      <div className="small muted">{t('im.note')}</div>
      {preview && 'error' in preview && <div className="note err">{preview.error}</div>}
      {preview && 'warnings' in preview && preview.warnings.filter((w) => w !== IMPORT_RESEARCH_DATA_WARNING).map((w, i) => <div key={i} className="note warn" data-testid="import-warning">{warnText(w)}</div>)}
      {lockReason && <div className="note err" data-testid="import-locked">{lockReason}</div>}
      {err && <div className="note err" data-testid="import-error">{err}</div>}
      {done && <ResultNote plan={done} />}
      <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="primary" data-testid="import-run" disabled={busy || !!lockReason || pick.size === 0 || !srcId} onClick={() => void run()}>{busy ? t('im.running') : t('im.runN', { n: pick.size })}</button>
      </div>
    </div>
  );
}

// ---- (b) 出力 ZIP から ---------------------------------------------------------------

function FromZip({ scenario, lockReason, onDone }: { scenario: Scenario; lockReason: string | null; onDone: (id: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [err, setErr] = useState('');
  const [dest, setDest] = useState<'new' | 'existing'>('new');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(scenario.projectId);
  const [name, setName] = useState('');
  const [withArts, setWithArts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CopyPlan | null>(null);
  useEffect(() => { void listProjects().then(setProjects); }, []);

  const choose = async (f: File | null) => {
    setFile(f); setParsed(null); setErr(''); setDone(null);
    if (!f) return;
    try {
      const r = parseExportZip(new Uint8Array(await f.arrayBuffer()));
      if (!r.ok) { setErr(t('im.cannot', { reason: r.reason })); return; }
      setParsed(r); setName(r.scenarioDraft.name);
    } catch (e) { setErr(t('im.zipFail', { err: String(e) })); }
  };

  const run = async () => {
    if (!parsed) return;
    if (dest === 'existing' && lockReason) return;
    setBusy(true); setErr('');
    let created: string | null = null;
    try {
      let targetId = scenario.id;
      if (dest === 'new') {
        const sc = scenarioFromDraft(projectId, { ...parsed.scenarioDraft, name: name.trim() || parsed.scenarioDraft.name }, new Date().toISOString());
        await putScenario(sc); created = sc.id; targetId = sc.id;
      }
      const plan = await importParsedExport(targetId, parsed, { copyArtifacts: withArts });
      setDone(plan); onDone(targetId);
    } catch (e) {
      if (created) await deleteScenario(created).catch(() => false); // 途中で失敗したら、作りかけのシナリオを残さない
      setErr(t('im.fail', { err: (e as Error).message ?? String(e) }));
    } finally { setBusy(false); }
  };

  const d = parsed?.scenarioDraft;
  return (
    <div data-testid="import-from-zip">
      <label className="f"><span>{t('im.zipLabel')}</span>
        <input type="file" accept=".zip,application/zip" data-testid="import-file" onChange={(e) => void choose(e.target.files?.[0] ?? null)} /></label>
      {err && <div className="note err" data-testid="import-error">{err}</div>}
      {file && !parsed && !err && <div className="small muted">{t('im.loading')}</div>}
      {parsed && d && (<>
        <div className="sec-title" style={{ marginTop: 10 }}>{t('im.confirm')}</div>
        <table className="t" data-testid="import-summary"><tbody>
          <tr><th style={{ width: 130 }}>{t('im.srcName')}</th><td>{d.name}</td></tr>
          <tr><th>{t('im.thSteps')}</th><td>{t('im.countN', { n: parsed.steps.length })}</td></tr>
          <tr><th>{t('im.thImgDom')}</th><td>{t('im.countAB', { a: parsed.images.length, b: parsed.doms.length })}</td></tr>
          <tr><th>{t('im.thGroupVar')}</th><td>{t('im.countAB', { a: d.groups.length, b: d.variables.length })}</td></tr>
          <tr><th>{t('im.thFormat')}</th><td>schemaVersion {d.schemaVersion}{d.toolVersion ? ` / TraceLens ${d.toolVersion}` : ''}{d.exportedAt ? ` / ${t('im.exportedAt', { v: d.exportedAt })}` : ''}</td></tr>
        </tbody></table>
        {parsed.warnings.filter((w) => w !== IMPORT_RESEARCH_DATA_WARNING).map((w, i) => <div key={i} className="note warn" data-testid="import-warning">{warnText(w)}</div>)}
        <div className="sec-title" style={{ marginTop: 10 }}>{t('im.dest')}</div>
        <div className="row" style={{ gap: 12 }}>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="dest" data-testid="import-dest-new" checked={dest === 'new'} onChange={() => setDest('new')} />{t('im.destNew')}</label>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="dest" data-testid="import-dest-existing" checked={dest === 'existing'} onChange={() => setDest('existing')} />{t('im.destExisting', { name: scenario.name })}</label>
        </div>
        {dest === 'new' && (
          <div className="row" style={{ marginTop: 6 }}>
            <select data-testid="import-project" style={{ width: 'auto' }} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label={t('sp.projectAria')}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <input data-testid="import-name" className="grow" value={name} onChange={(e) => setName(e.target.value)} aria-label={t('sp.scenarioName')} />
          </div>
        )}
        <label className="row small" style={{ gap: 4, marginTop: 6 }}><input type="checkbox" data-testid="import-arts" checked={withArts} onChange={(e) => { const on = e.target.checked; setWithArts(on); }} />{t('im.copyArts')}</label>
        <div className="small muted">{t('im.zipNote')}</div>
        {dest === 'existing' && lockReason && <div className="note err" data-testid="import-locked">{lockReason}</div>}
        {done && <ResultNote plan={done} />}
        <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
          <button className="primary" data-testid="import-run" disabled={busy || (dest === 'existing' && !!lockReason) || (dest === 'new' && (!projectId || !name.trim()))} onClick={() => void run()}>{busy ? t('im.running') : t('im.run')}</button>
        </div>
      </>)}
    </div>
  );
}
