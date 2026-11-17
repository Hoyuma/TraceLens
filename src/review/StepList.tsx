import { useMemo, useState } from 'react';
import { patchStep } from '../shared/db';
import { moveGroup, validateGroupParent } from '../shared/groups';
import { captureLevel, captureProblems, kindLabel, stepSummary } from '../shared/describe';
import { originLabel, t, trKnown, useI18n } from '../ui/i18n';
import type { ReplayStepResult } from '../shared/replay';
import { hasAnnotation, type Scenario, type Step } from '../shared/types';
import { applyGroupOp, applyOrder, setStepsGroup } from './actions';
import { buildStepTree, displayPositions, isReordered, moveStepChanges, planStepDrop, type GroupNode, type StepNode, type TreeNode } from './logic';
import { ResultBadge } from './ResultViews';

interface Props {
  scenario: Scenario;
  steps: Step[];
  selId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  results: Map<string, ReplayStepResult>;
  /** 再生中の手順 */
  currentStepId?: string;
}

type Drag = { kind: 'step' | 'group'; id: string } | null;
type Over = { key: string; where: 'before' | 'after' | 'into' } | null;

export function StepList({ scenario, steps, selId, onSelect, onChanged, results, currentStepId }: Props) {
  const { lang } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<Over>(null);
  const [err, setErr] = useState('');
  const groups = scenario.groups;
  const tree = useMemo(() => buildStepTree(groups, steps), [groups, steps]);
  const pos = useMemo(() => displayPositions(steps), [steps]);
  const reordered = isReordered(steps);

  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setInclude = async (s: Step, on: boolean) => { await patchStep(s.id, (x) => { x.includeInExport = on; }); onChanged(); };
  const endDrag = () => { setDrag(null); setOver(null); };

  const move = async (s: Step, dir: 'up' | 'down') => { await applyOrder(moveStepChanges(steps, groups, s.id, dir)); onChanged(); };

  const dropOnStep = async (target: Step, where: 'before' | 'after') => {
    if (drag?.kind !== 'step') return;
    const plan = planStepDrop(steps, groups, drag.id, target.id, where);
    endDrag();
    if (!plan) return;
    await applyOrder(plan.changes);
    await setStepsGroup([drag.id], plan.groupId);
    onChanged();
  };
  const dropOnGroup = async (gid: string | null) => {
    const d = drag; endDrag();
    if (!d) return;
    setErr('');
    if (d.kind === 'step') { await setStepsGroup([d.id], gid ?? undefined); onChanged(); return; }
    const e = await applyGroupOp(scenario.id, (g) => moveGroup(g, d.id, gid));
    if (e) setErr(e);
    onChanged();
  };
  const canDropGroup = (gid: string | null): boolean => {
    if (!drag) return false;
    if (drag.kind === 'step') return true;
    return validateGroupParent(groups, drag.id, gid).ok;
  };
  const whereOf = (e: React.DragEvent): 'before' | 'after' => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? 'before' : 'after'; };

  const renderStep = (n: StepNode) => {
    const s = n.step;
    const probs = captureProblems(s, lang, false);
    const dispPos = pos.get(s.id);
    const o = over?.key === s.id ? over.where : null;
    const up = moveStepChanges(steps, groups, s.id, 'up').length > 0;
    const down = moveStepChanges(steps, groups, s.id, 'down').length > 0;
    return (
      <li key={s.id}
        className={`s ${selId === s.id ? 'sel' : ''} ${s.includeInExport ? '' : 'excluded'} ${currentStepId === s.id ? 'now' : ''} ${drag?.id === s.id ? 'dragging' : ''} ${o ? `drop-${o}` : ''}`}
        style={{ paddingLeft: 6 + n.depth * 14 }}
        data-testid="step-row" data-step-id={s.id} data-kind={s.kind} data-seq={s.seq} data-origin={s.origin ?? 'recorded'}
        draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move'; setDrag({ kind: 'step', id: s.id }); }} onDragEnd={endDrag}
        onDragOver={(e) => { if (drag?.kind === 'step' && drag.id !== s.id) { e.preventDefault(); const w = whereOf(e); if (over?.key !== s.id || over.where !== w) setOver({ key: s.id, where: w }); } }}
        onDrop={(e) => { e.preventDefault(); void dropOnStep(s, whereOf(e)); }}
        onClick={() => onSelect(s.id)}>
        <input type="checkbox" title={t('sl.includeTitle')} data-testid="step-include" checked={s.includeInExport} onClick={(e) => e.stopPropagation()} onChange={(e) => { const on = e.target.checked; void setInclude(s, on); }} />
        <span className="n" title={t('sl.seqTitle', { seq: s.seq })}>{s.seq}{dispPos !== undefined && dispPos !== s.seq && <small className="pos" title={t('sl.posTitle', { pos: dispPos })} data-testid="step-pos">→{dispPos}</small>}</span>
        <div className="body">
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}><span className="kind">{kindLabel(s.kind, lang)}</span>
            {(s.origin ?? 'recorded') !== 'recorded' && <span className={`badge origin ${s.origin}`} data-testid="origin-badge" title={s.importedFrom ? t('sl.importedTitle', { name: s.importedFrom.scenarioName ?? '', seq: s.importedFrom.seq }) : t('sl.authoredTitle')}>{originLabel(s.origin ?? 'recorded')}</span>}
            {hasAnnotation(s.annotation) && <span className="flag memo" title={t('sp.memoFlagTitle')}>{t('sl.memo')}</span>}
            {captureLevel(s) === 'fail' && <span className="flag fail" title={probs.join('\n')} data-testid="flag-fail">{t('sl.failFlag')}</span>}
            {captureLevel(s) === 'skip' && <span className="flag muted" title={probs.join('\n')} data-testid="flag-skip">{t('sl.noShot')}</span>}
            {!s.includeInExport && <span className="flag muted">{t('sl.excluded')}</span>}
            {s.replay?.skip && <span className="flag muted" data-testid="flag-replay-skip" title={t('sl.skipTitle')}>{t('sl.skip')}</span>}
            <ResultBadge result={results.get(s.id)} />
            <span style={{ flex: 1 }} />
            <span className="mv">
              <button className="mini" data-testid="step-up" title={t('sl.upTitle')} aria-label={t('sl.up')} disabled={!up} onClick={(e) => { e.stopPropagation(); void move(s, 'up'); }}>↑</button>
              <button className="mini" data-testid="step-down" title={t('sl.downTitle')} aria-label={t('sl.down')} disabled={!down} onClick={(e) => { e.stopPropagation(); void move(s, 'down'); }}>↓</button>
            </span>
          </div>
          <div className="sum">{stepSummary(s)}</div>
        </div>
      </li>
    );
  };

  const renderGroup = (n: GroupNode): JSX.Element[] => {
    const g = n.group;
    const open = !collapsed.has(g.id);
    const ok = canDropGroup(g.id);
    const isOver = over?.key === g.id;
    const head = (
      <li key={`g-${g.id}`} className={`g ${isOver && ok ? 'drop-into' : ''}`} style={{ paddingLeft: 4 + n.depth * 14 }} data-testid="group-row" data-group-id={g.id}
        draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', g.id); e.dataTransfer.effectAllowed = 'move'; setDrag({ kind: 'group', id: g.id }); }} onDragEnd={endDrag}
        onDragOver={(e) => { if (drag && drag.id !== g.id && ok) { e.preventDefault(); if (over?.key !== g.id) setOver({ key: g.id, where: 'into' }); } }}
        onDrop={(e) => { e.preventDefault(); if (ok) void dropOnGroup(g.id); else endDrag(); }}>
        <button className="link" data-testid="group-toggle" aria-label={open ? t('sl.collapse') : t('sl.expand')} aria-expanded={open} onClick={() => toggle(g.id)}>{open ? '▾' : '▸'}</button>
        <span title={t('sl.groupDragTitle')}>{g.name}</span>
        <span className="muted">{' '}{t('sl.groupCount', { n: n.stepCount })}</span>
      </li>
    );
    return [head, ...(open ? renderNodes(n.children) : [])];
  };

  const renderNodes = (nodes: readonly TreeNode[]): JSX.Element[] => nodes.flatMap((n) => (n.type === 'step' ? [renderStep(n)] : renderGroup(n)));

  return (
    <div data-testid="step-list-wrap">
      <div className="sec-title">{t('sl.title', { n: steps.length, m: steps.filter((s) => s.includeInExport).length })}</div>
      {reordered && <div className="small muted" data-testid="reorder-note">{t('sl.reorderNote')}</div>}
      {err && <div className="note err" data-testid="group-error">{trKnown(err)}</div>}
      {drag && <div className={`dropzone ${over?.key === '__root' ? 'on' : ''}`} data-testid="drop-root"
        onDragOver={(e) => { if (canDropGroup(null)) { e.preventDefault(); if (over?.key !== '__root') setOver({ key: '__root', where: 'into' }); } }}
        onDrop={(e) => { e.preventDefault(); void dropOnGroup(null); }}>{drag.kind === 'step' ? t('sl.dropStep') : t('sl.dropGroup')}</div>}
      <ul className="slist" data-testid="step-list">{renderNodes(tree)}</ul>
      {steps.length === 0 && <div className="small muted">{t('sl.empty')}</div>}
      {steps.length > 0 && <div className="small muted" style={{ marginTop: 6 }}>{t('sl.hint')}</div>}
    </div>
  );
}
