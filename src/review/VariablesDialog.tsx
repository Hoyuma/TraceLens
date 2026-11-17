import { useMemo, useState } from 'react';
import { patchScenario } from '../shared/db';
import { newVariable, sanitizeVariables, validateVariables } from '../shared/variables';
import type { Scenario, ScenarioVariable, Step } from '../shared/types';
import { Modal } from '../ui/common';
import { t, trKnown } from '../ui/i18n';
import { variableReport } from './logic';

/** シナリオの変数表。保存するまで反映されない。secret の既定値は保存しない。 */
export function VariablesDialog({ scenario, steps, onClose, onSaved }: { scenario: Scenario; steps: Step[]; onClose: () => void; onSaved: () => void }) {
  const [vars, setVars] = useState<ScenarioVariable[]>(() => (scenario.variables ?? []).map((v) => ({ ...v })));
  const [saving, setSaving] = useState(false);
  const errors = useMemo(() => validateVariables(vars), [vars]);
  const report = useMemo(() => variableReport(vars, steps, scenario.replacementRules), [vars, steps, scenario.replacementRules]);
  const usedBy = new Map(report.rows.map((r) => [r.name, r.usedCount]));
  const patch = (id: string, p: Partial<ScenarioVariable>) => setVars(vars.map((v) => (v.id === id ? { ...v, ...p } : v)));
  const dirty = JSON.stringify(sanitizeVariables(vars)) !== JSON.stringify(sanitizeVariables(scenario.variables ?? []));

  const save = async () => {
    if (errors.length) return;
    setSaving(true);
    await patchScenario(scenario.id, (s) => { s.variables = sanitizeVariables(vars); });
    setSaving(false); onSaved(); onClose();
  };

  return (
    <Modal title={t('rv.vars')} onClose={onClose} width={760} testId="variables-dialog" footer={<>
      <span className="small muted" style={{ marginRight: 'auto' }}>{t('var.ref')}</span>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" data-testid="vars-save" disabled={saving || errors.length > 0 || !dirty} onClick={() => void save()}>{t('sre.save')}</button>
    </>}>
      <table className="t">
        <thead><tr><th>{t('scn.name')}</th><th>{t('var.default')}</th><th>{t('var.desc')}</th><th style={{ width: 54 }}>secret</th><th style={{ width: 50 }}>{t('var.used')}</th><th style={{ width: 30 }} /></tr></thead>
        <tbody>
          {vars.map((v) => (
            <tr key={v.id} data-testid="var-row">
              <td><input data-testid="var-name" value={v.name} onChange={(e) => patch(v.id, { name: e.target.value })} /></td>
              <td>
                {v.secret
                  ? <><input data-testid="var-default" disabled value="" placeholder={t('var.noStore')} /><div className="small muted" data-testid="var-secret-note">{t('var.secretNote')}</div></>
                  : <input data-testid="var-default" value={v.defaultValue ?? ''} onChange={(e) => patch(v.id, { defaultValue: e.target.value === '' ? undefined : e.target.value })} />}
              </td>
              <td><input data-testid="var-desc" value={v.description ?? ''} onChange={(e) => patch(v.id, { description: e.target.value || undefined })} /></td>
              <td><input type="checkbox" data-testid="var-secret" checked={!!v.secret} onChange={(e) => { const on = e.target.checked; setVars(vars.map((x) => { if (x.id !== v.id) return x; if (on) { const { defaultValue: _d, ...rest } = x; return { ...rest, secret: true }; } return { ...x, secret: false }; })); }} /></td>
              <td data-testid="var-used">{usedBy.get(v.name) ?? 0}</td>
              <td><button title={t('var.delTitle')} aria-label={t('common.delete')} onClick={() => setVars(vars.filter((x) => x.id !== v.id))}>×</button></td>
            </tr>
          ))}
          {vars.length === 0 && <tr><td colSpan={6} className="muted">{t('var.none')}</td></tr>}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 6 }}><button data-testid="var-add" onClick={() => setVars([...vars, newVariable('')])}>{t('var.add')}</button></div>
      {errors.map((e, i) => <div key={i} className="note err" data-testid="var-error">{trKnown(e)}</div>)}
      {report.undefinedNames.length > 0 && (
        <div className="note warn" data-testid="var-undefined">{t('var.undefined')}
          {report.undefinedNames.map((n) => <span key={n} style={{ marginLeft: 8 }}>{`{{${n}}}`} <button className="link small" onClick={() => setVars([...vars, newVariable(n)])}>{t('var.addShort')}</button></span>)}
        </div>
      )}
      {report.unusedNames.filter((n) => n).length > 0 && <div className="note info" data-testid="var-unused">{t('var.unused', { names: report.unusedNames.filter((n) => n).join(t('var.sep')) })}</div>}
      <div className="small muted" style={{ marginTop: 8 }}>
        {t('var.usedNote')}
      </div>
    </Modal>
  );
}
