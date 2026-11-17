import { useState } from 'react';
import { patchScenario, patchStep } from '../shared/db';
import { templateProblems } from '../shared/variables';
import { newVariable } from '../shared/variables';
import { valueLabel } from '../shared/describe';
import { DEFAULT_REPLAY_TIMEOUT_MS } from '../shared/replay';
import { getLang, t, trKnown } from '../ui/i18n';
import type { Scenario, Step, StepReplayConfig } from '../shared/types';
import { cleanReplayConfig, sameReplayConfig, undefinedTemplateVariables, validateReplayConfig, validateSelectorText } from './logic';
import { WaitEditor } from './WaitEditor';

const isSecretStep = (s: Step) => s.value?.kind === 'redacted' || !!s.value?.redacted;

/** 手順ごとの再生設定。保存は「保存」ボタンで行い、検査に通らない内容は保存できない。 */
export function StepReplayEditor({ step, scenario, onSaved }: { step: Step; scenario: Scenario; onSaved: () => void }) {
  const [draft, setDraft] = useState<StepReplayConfig>(step.replay ?? {});
  const [msg, setMsg] = useState('');
  const set = (p: Partial<StepReplayConfig>) => { setDraft({ ...draft, ...p }); setMsg(''); };
  const vars = scenario.variables ?? [];
  const secret = isSecretStep(step);
  const isFiles = step.value?.kind === 'files';
  const takesValue = step.kind === 'input' || step.kind === 'select';
  const takesSelector = !!step.target || ['click', 'input', 'select', 'check'].includes(step.kind);
  const errors = validateReplayConfig(draft);
  const dirty = !sameReplayConfig(step.replay, draft);
  const useTemplate = draft.valueTemplate !== undefined;
  const undef = undefinedTemplateVariables(draft.valueTemplate, vars);
  const tmplProblems = templateProblems(draft.valueTemplate);
  const sel = draft.selector;
  const selErr = sel && sel.selector ? validateSelectorText(sel.language, sel.selector) : null;

  const save = async () => {
    if (errors.length) return;
    const c = cleanReplayConfig(draft);
    await patchStep(step.id, (s) => { if (c) s.replay = c; else delete s.replay; });
    setMsg(t('sre.saved')); onSaved();
  };
  const addVariable = async (name: string) => {
    await patchScenario(scenario.id, (s) => { if (!(s.variables ?? []).some((v) => v.name === name)) s.variables = [...(s.variables ?? []), newVariable(name)]; });
    onSaved();
  };

  return (
    <div data-testid="replay-editor">
      <div className="small muted" style={{ marginBottom: 6 }}>{t('sre.intro')}</div>
      <label className="row" style={{ gap: 4 }}><input type="checkbox" data-testid="replay-skip" checked={!!draft.skip} onChange={(e) => { const on = e.target.checked; set({ skip: on }); }} />{t('sre.skip')}</label>
      <div className="small muted">{t('sre.skipNote')}</div>

      {takesValue && (
        <div className="f" style={{ marginTop: 10 }}>
          <span className="small muted">{t('sre.valueTitle')}</span>
          {secret ? (
            <div className="note info" data-testid="replay-secret-note">{t('sre.secretNote')}</div>
          ) : isFiles ? (
            <div className="note info" data-testid="replay-files-note">{t('sre.filesNote')}</div>
          ) : (<>
            <label className="row small" style={{ gap: 4 }}>
              <input type="checkbox" data-testid="replay-vt-use" checked={useTemplate} onChange={(e) => { const on = e.target.checked; if (on) set({ valueTemplate: step.value?.kind === 'text' ? step.value.text ?? '' : '' }); else { const { valueTemplate: _x, ...rest } = draft; setDraft(rest); setMsg(''); } }} />
              {t('sre.useTemplate')}
            </label>
            {!useTemplate && <div className="small muted">{t('sre.useRecorded', { v: valueLabel(step, getLang()) || t('sre.none') })}</div>}
            {useTemplate && (<>
              <div className="row" style={{ marginTop: 4 }}>
                <input data-testid="replay-vt" className="grow" value={draft.valueTemplate ?? ''} placeholder={t('sre.vtPh')} onChange={(e) => set({ valueTemplate: e.target.value })} />
                <select data-testid="replay-vt-insert" style={{ width: 130 }} value="" onChange={(e) => { if (e.target.value) set({ valueTemplate: `${draft.valueTemplate ?? ''}{{${e.target.value}}}` }); }} aria-label={t('sre.insertVar')}>
                  <option value="">{t('sre.insertVarOpt')}</option>
                  {vars.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
                </select>
              </div>
              <div className="small muted">{t('sre.vtNote')}</div>
              {tmplProblems.map((p, i) => <div key={i} className="note err" data-testid="replay-vt-problem">{trKnown(p)}</div>)}
              {undef.map((n) => (
                <div key={n} className="note warn" data-testid="replay-vt-undefined">{t('sre.undef', { n })}
                  <button className="link small" style={{ marginLeft: 6 }} data-testid="replay-vt-addvar" onClick={() => void addVariable(n)}>{t('sre.addVar')}</button></div>
              ))}
            </>)}
          </>)}
        </div>
      )}

      {takesSelector && (
        <div className="f" style={{ marginTop: 10 }}>
          <span className="small muted">{t('sre.selTitle')}</span>
          <div className="row">
            <select data-testid="replay-sel-lang" style={{ width: 80 }} value={sel?.language ?? 'css'} onChange={(e) => set({ selector: { language: e.target.value as 'css' | 'xpath', selector: sel?.selector ?? '' } })}>
              <option value="css">CSS</option><option value="xpath">XPath</option>
            </select>
            <input data-testid="replay-sel" className="grow" value={sel?.selector ?? ''} placeholder={t('sre.selPh')} onChange={(e) => set({ selector: { language: sel?.language ?? 'css', selector: e.target.value } })} />
            <button title={t('sre.selClearTitle')} disabled={!sel} onClick={() => { const { selector: _x, ...rest } = draft; setDraft(rest); setMsg(''); }}>{t('sre.selClear')}</button>
          </div>
          {step.target && step.target.selectors.length > 0 && (
            <select data-testid="replay-sel-cand" style={{ marginTop: 4 }} value="" onChange={(e) => { const c = step.target!.selectors[Number(e.target.value)]; if (c) set({ selector: { language: c.language, selector: c.selector } }); }} aria-label={t('sre.pickCand')}>
              <option value="">{t('sre.pickCandOpt')}</option>
              {step.target.selectors.map((c, i) => <option key={i} value={i}>{c.stability === 'suspect' ? '⚠ ' : ''}{t('sre.candOpt', { sel: c.selector, n: c.matchCount ?? t('det.unmeasurable') })}</option>)}
            </select>
          )}
          {selErr && <div className="note err" data-testid="replay-sel-error">{selErr}</div>}
          <div className="small muted">{t('sre.selNote')}</div>
        </div>
      )}

      <div className="f" style={{ marginTop: 10 }}>
        <span className="small muted">{t('sre.waitTitle')}</span>
        <WaitEditor value={draft.wait} onChange={(w) => { if (w) set({ wait: w }); else { const { wait: _x, ...rest } = draft; setDraft(rest); setMsg(''); } }} allowDefault={step.kind !== 'wait'} />
      </div>

      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <label className="row small" style={{ gap: 4 }}>{t('sre.onFail')}
          <select data-testid="replay-onfail" style={{ width: 'auto' }} value={draft.onFail ?? 'stop'} onChange={(e) => set({ onFail: e.target.value as 'stop' | 'continue' })}>
            <option value="stop">{t('sre.onFailStop')}</option><option value="continue">{t('sre.onFailContinue')}</option>
          </select>
        </label>
        <label className="row small" style={{ gap: 4 }}>{t('sre.timeout')}
          <input data-testid="replay-timeout" type="number" min={1} style={{ width: 100 }} value={draft.timeoutMs ?? ''} placeholder={String(DEFAULT_REPLAY_TIMEOUT_MS)} onChange={(e) => set({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })} /> ms
        </label>
      </div>
      <div className="small muted">{t('sre.failNote')}</div>

      {errors.length > 0 && <div className="note err" data-testid="replay-errors">{t('sre.cannotSave', { errs: errors.join(' / ') })}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" data-testid="replay-save" disabled={!dirty || errors.length > 0} onClick={() => void save()}>{t('sre.save')}</button>
        <button data-testid="replay-revert" disabled={!dirty} onClick={() => { setDraft(step.replay ?? {}); setMsg(''); }}>{t('sre.revert')}</button>
        {msg && <span className="small" style={{ color: 'var(--ok)' }} data-testid="replay-saved">{msg}</span>}
        {dirty && <span className="small muted">{t('sre.dirty')}</span>}
      </div>
    </div>
  );
}
