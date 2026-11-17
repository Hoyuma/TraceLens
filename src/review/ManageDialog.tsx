import { useEffect, useState } from 'react';
import { deleteProject, deleteScenario, listProjects, listReplayRuns, listScenarios, listSteps, renameProject } from '../shared/db';
import type { Project, Scenario } from '../shared/types';
import { ConfirmDialog, Modal } from '../ui/common';
import { t } from '../ui/i18n';

interface Counts { steps: number; runs: number }
type Target = { kind: 'project'; project: Project } | { kind: 'scenario'; scenario: Scenario };

interface Props {
  /** 記録中・再生中のシナリオ ID（削除不可） */
  busyScenarioIds: { recording?: string; replaying?: string };
  onClose: () => void;
  onChanged: () => void;
}

export function ManageDialog({ busyScenarioIds, onClose, onChanged }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [counts, setCounts] = useState<Record<string, Counts>>({});
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [ps, ss] = await Promise.all([listProjects(), listScenarios()]);
    setProjects(ps); setScenarios(ss);
    const c: Record<string, Counts> = {};
    for (const s of ss) c[s.id] = { steps: (await listSteps(s.id)).length, runs: (await listReplayRuns(s.id)).length };
    setCounts(c);
  };
  useEffect(() => { void load(); }, []);

  const why = (scenarioId: string): string | null => {
    if (busyScenarioIds.recording === scenarioId) return t('mng.recording');
    if (busyScenarioIds.replaying === scenarioId) return t('rv.delBlockedReplay');
    return null;
  };
  const projectBlock = (p: Project): string | null => { for (const s of scenarios.filter((x) => x.projectId === p.id)) { const w = why(s.id); if (w) return t('mng.projectBlock', { name: s.name, why: w }); } return null; };
  const sum = (ss: Scenario[]) => ss.reduce((a, s) => ({ steps: a.steps + (counts[s.id]?.steps ?? 0), runs: a.runs + (counts[s.id]?.runs ?? 0) }), { steps: 0, runs: 0 });

  const rename = async () => {
    if (!edit) return;
    const r = await renameProject(edit.id, edit.name);
    if (!r) { setErr(t('mng.renameFail')); return; }
    setEdit(null); setErr(''); await load(); onChanged();
  };
  const doDelete = async () => {
    if (!target) return;
    setBusy(true); setErr('');
    try {
      if (target.kind === 'project') { const w = projectBlock(target.project); if (w) throw new Error(w); await deleteProject(target.project.id); }
      else { const w = why(target.scenario.id); if (w) throw new Error(w); await deleteScenario(target.scenario.id); }
      setTarget(null); await load(); onChanged();
    } catch (e) { setErr(t('mng.deleteFail', { err: (e as Error).message ?? String(e) })); setTarget(null); } finally { setBusy(false); }
  };

  const tScenarios = target?.kind === 'project' ? scenarios.filter((s) => s.projectId === target.project.id) : target ? [target.scenario] : [];
  const tc = sum(tScenarios);

  return (
    <Modal title={t('mng.title')} onClose={onClose} width={760} testId="manage-dialog">
      <div className="small muted">{t('mng.warn')}</div>
      {err && <div className="note err" data-testid="manage-error">{err}</div>}
      {projects.map((p) => {
        const ss = scenarios.filter((s) => s.projectId === p.id);
        const pb = projectBlock(p);
        return (
          <div key={p.id} className="card" style={{ marginTop: 10 }} data-testid="manage-project" data-project-id={p.id}>
            <div className="row">
              {edit?.id === p.id ? (<>
                <input data-testid="manage-rename-input" className="grow" autoFocus value={edit.name} onChange={(e) => setEdit({ id: p.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setEdit(null); }} />
                <button className="primary" data-testid="manage-rename-ok" disabled={!edit.name.trim()} onClick={() => void rename()}>{t('sre.save')}</button>
                <button onClick={() => setEdit(null)}>{t('common.undo')}</button>
              </>) : (<>
                <b className="grow">{p.name}</b>
                <button data-testid="manage-rename" onClick={() => setEdit({ id: p.id, name: p.name })}>{t('grp.rename')}</button>
                <button className="danger" data-testid="manage-delete-project" disabled={!!pb} title={pb ?? ''} onClick={() => setTarget({ kind: 'project', project: p })}>{t('mng.delProject')}</button>
              </>)}
            </div>
            {pb && <div className="small muted">{pb}</div>}
            <table className="t" style={{ marginTop: 6 }}><tbody>
              {ss.map((s) => {
                const w = why(s.id);
                return (
                  <tr key={s.id} data-testid="manage-scenario" data-scenario-id={s.id}>
                    <td>{s.name}</td>
                    <td className="muted" style={{ width: 200 }}>{t('mng.counts', { steps: counts[s.id]?.steps ?? '…', runs: counts[s.id]?.runs ?? '…' })}</td>
                    <td style={{ width: 150, textAlign: 'right' }}><button className="danger small" data-testid="manage-delete-scenario" disabled={!!w} title={w ?? ''} onClick={() => setTarget({ kind: 'scenario', scenario: s })}>{t('mng.delScenario')}</button>{w && <div className="small muted">{w}</div>}</td>
                  </tr>
                );
              })}
              {ss.length === 0 && <tr><td className="muted">{t('mng.noScenarios')}</td></tr>}
            </tbody></table>
          </div>
        );
      })}
      {projects.length === 0 && <div className="empty">{t('mng.noProjects')}</div>}
      {target && (
        <ConfirmDialog title={target.kind === 'project' ? t('mng.delProjectTitle') : t('mng.delScenarioTitle')} okLabel={t('rv.deleteOk')} danger busy={busy} onCancel={() => setTarget(null)} onOk={() => void doDelete()}>
          <p>{target.kind === 'project' ? t('mng.delBodyProject', { name: target.project.name }) : t('mng.delBodyScenario', { name: target.scenario.name })}</p>
          <p data-testid="manage-delete-impact">{target.kind === 'project' ? t('mng.impactProject', { sc: tScenarios.length, steps: tc.steps, runs: tc.runs }) : t('mng.impactScenario', { steps: tc.steps, runs: tc.runs })}</p>
          <p className="small"><b>{t('mng.irreversible')}</b></p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}
