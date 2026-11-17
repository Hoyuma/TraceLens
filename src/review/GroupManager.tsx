import { useState } from 'react';
import { createGroup, descendantGroupIds, flattenGroupTree, moveGroup, renameGroup } from '../shared/groups';
import type { Scenario, Step } from '../shared/types';
import { ConfirmDialog } from '../ui/common';
import { t, trKnown } from '../ui/i18n';
import { applyGroupOp, removeGroupAction } from './actions';

/** グループの作成・名前変更・親の変更・削除（prompt は使わない） */
export function GroupManager({ scenario, steps, onChanged }: { scenario: Scenario; steps: Step[]; onChanged: () => void }) {
  const groups = scenario.groups;
  const flat = flattenGroupTree(groups);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const run = async (op: () => Promise<string | null>) => { setErr(''); const e = await op(); if (e) setErr(e); onChanged(); return !e; };
  const create = async () => {
    const n = name;
    if (await run(() => applyGroupOp(scenario.id, (g) => createGroup(g, n, parent || null)))) setName('');
  };
  const delTarget = del ? groups.find((g) => g.id === del) : undefined;
  const delSteps = del ? steps.filter((s) => s.groupId === del).length : 0;
  const delChildren = del ? groups.filter((g) => g.parentId === del).length : 0;
  const delParentName = delTarget?.parentId ? groups.find((g) => g.id === delTarget.parentId)?.name : undefined;

  return (
    <details data-testid="group-manager">
      <summary>{t('grp.manage', { n: groups.length })}</summary>
      <div className="row" style={{ marginTop: 6 }}>
        <input data-testid="group-new-input" className="grow" value={name} placeholder={t('grp.newName')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void create(); }} />
        <select data-testid="group-new-parent" style={{ width: 120 }} value={parent} onChange={(e) => setParent(e.target.value)} aria-label={t('grp.parent')}>
          <option value="">{t('grp.top')}</option>
          {flat.map(({ group, depth }) => <option key={group.id} value={group.id}>{'　'.repeat(depth)}{group.name}</option>)}
        </select>
        <button data-testid="group-create" disabled={!name.trim()} onClick={() => void create()}>{t('sp.createOk')}</button>
      </div>
      {err && <div className="note err" data-testid="group-manager-error">{trKnown(err)}</div>}
      <table className="t" style={{ marginTop: 6 }}><tbody>
        {flat.map(({ group, depth }) => {
          const banned = descendantGroupIds(groups, group.id);
          return (
            <tr key={group.id} data-testid="group-manage-row" data-group-id={group.id}>
              <td style={{ paddingLeft: 5 + depth * 12 }}>
                {edit?.id === group.id ? (
                  <div className="row">
                    <input data-testid="group-rename-input" autoFocus value={edit.name} onChange={(e) => setEdit({ id: group.id, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter' && edit.name.trim()) { const n = edit.name; void run(() => applyGroupOp(scenario.id, (g) => renameGroup(g, group.id, n))).then(() => setEdit(null)); } if (e.key === 'Escape') setEdit(null); }} />
                    <button data-testid="group-rename-ok" disabled={!edit.name.trim()} onClick={() => { const n = edit.name; void run(() => applyGroupOp(scenario.id, (g) => renameGroup(g, group.id, n))).then(() => setEdit(null)); }}>{t('sre.save')}</button>
                    <button onClick={() => setEdit(null)}>{t('common.undo')}</button>
                  </div>
                ) : (
                  <div className="row"><span className="grow">{group.name}</span>
                    <button className="link small" data-testid="group-rename" onClick={() => setEdit({ id: group.id, name: group.name })}>{t('grp.rename')}</button></div>
                )}
              </td>
              <td style={{ width: 110 }}>
                <select data-testid="group-parent" aria-label={t('grp.parent')} value={group.parentId ?? ''} onChange={(e) => { const v = e.target.value || null; void run(() => applyGroupOp(scenario.id, (g) => moveGroup(g, group.id, v))); }}>
                  <option value="">{t('grp.top')}</option>
                  {flat.filter((x) => x.group.id !== group.id && !banned.has(x.group.id)).map((x) => <option key={x.group.id} value={x.group.id}>{'　'.repeat(x.depth)}{x.group.name}</option>)}
                </select>
              </td>
              <td style={{ width: 44 }}><button className="danger small" data-testid="group-delete" onClick={() => setDel(group.id)}>{t('common.delete')}</button></td>
            </tr>
          );
        })}
        {flat.length === 0 && <tr><td colSpan={3} className="muted">{t('grp.none')}</td></tr>}
      </tbody></table>
      <div className="small muted">{t('grp.cycleNote')}</div>
      {delTarget && (
        <ConfirmDialog title={t('grp.delTitle')} okLabel={t('grp.delTitle')} danger onCancel={() => setDel(null)} onOk={() => { const id = delTarget.id; setDel(null); void run(() => removeGroupAction(scenario.id, id)); }}>
          <p>{t('grp.delBody', { name: delTarget.name })}</p>
          <p className="small" data-testid="group-delete-note">{t('grp.delNote', { steps: delSteps, children: delChildren, dest: delParentName ? t('grp.destParent', { name: delParentName }) : t('grp.destTop') })}</p>
        </ConfirmDialog>
      )}
    </details>
  );
}
