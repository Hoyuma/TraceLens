import { useState } from 'react';
import { addStep } from '../shared/db';
import { createAuthoredStep } from '../shared/steps';
import { flattenGroupTree } from '../shared/groups';
import { type ElementInfo, type Scenario, type Step, type StepKind, type WaitCondition } from '../shared/types';
import { Modal } from '../ui/common';
import { kindLabel } from '../shared/describe';
import { getLang, t } from '../ui/i18n';
import { validateSelectorText, validateWaitCondition } from './logic';
import { WaitEditor } from './WaitEditor';

type AddKind = Extract<StepKind, 'wait' | 'click' | 'input' | 'select' | 'check' | 'navigation'>;
const KINDS: AddKind[] = ['wait', 'click', 'input', 'select', 'check', 'navigation'];

/** 人が指定したセレクターだけを持つ、最小の要素情報（記録した情報ではない） */
function authoredTarget(): ElementInfo {
  return {
    tag: 'element', role: { value: null, source: 'none' }, nameCandidates: [], nameMethodNote: '人が追加した手順のため要素情報は記録していない', labels: [],
    state: {}, rect: { x: 0, y: 0, width: 0, height: 0 }, attributes: {}, selectors: [], surroundingHtml: '', surroundingTruncated: false, shadowPath: [], hints: ['人が指定したセレクターで操作する'],
  };
}

export function AddStepDialog({ scenario, steps, afterStepId, groupId, onClose, onAdded }: {
  scenario: Scenario; steps: Step[]; afterStepId: string | null; groupId?: string; onClose: () => void; onAdded: (id: string) => void;
}) {
  const [kind, setKind] = useState<AddKind>('wait');
  const [lang, setLang] = useState<'css' | 'xpath'>('css');
  const [selector, setSelector] = useState('');
  const [valueText, setValueText] = useState('');
  const [checked, setChecked] = useState(true);
  const [url, setUrl] = useState('');
  const [wait, setWait] = useState<WaitCondition | undefined>({ kind: 'element-present', value: '' });
  const [gid, setGid] = useState(groupId ?? '');
  const [purpose, setPurpose] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const flat = flattenGroupTree(scenario.groups);
  const needsSelector = kind === 'click' || kind === 'input' || kind === 'select' || kind === 'check';

  const problems: string[] = [];
  if (needsSelector) { const e = validateSelectorText(lang, selector); if (e) problems.push(e); }
  if (kind === 'navigation') { try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') problems.push(t('add.errHttp')); } catch { problems.push(t('add.errUrl')); } }
  if (kind === 'wait') { if (!wait) problems.push(t('add.errWait')); else problems.push(...validateWaitCondition(wait)); }
  else if (wait) problems.push(...validateWaitCondition(wait));

  const submit = async () => {
    if (problems.length) return;
    setBusy(true); setErr('');
    try {
      const now = new Date().toISOString();
      const st = createAuthoredStep({
        scenarioId: scenario.id, existing: steps, kind: 'wait', wait: wait ?? { kind: 'none' }, afterStepId, groupId: gid || undefined, now,
        pageUrl: kind === 'navigation' ? url : undefined,
      });
      st.kind = kind;
      st.limitations = [{ code: 'authored', message: '人が追加した手順。操作・画面・要素情報は記録していない（operationAt は追加した時刻）' }];
      if (purpose.trim()) st.annotation = { ...st.annotation, purpose: purpose.trim() };
      if (!wait && st.replay) delete st.replay.wait;
      if (needsSelector) {
        st.target = authoredTarget();
        st.replay = { ...(st.replay ?? {}), selector: { language: lang, selector: selector.trim() } };
      }
      if (kind === 'input') { st.value = { kind: 'text', text: '' }; st.replay = { ...(st.replay ?? {}), valueTemplate: valueText }; }
      if (kind === 'select') { st.value = { kind: 'select', selectedOptions: [] }; st.replay = { ...(st.replay ?? {}), valueTemplate: valueText }; }
      if (kind === 'check') st.value = { kind: 'checked', checked };
      if (kind === 'navigation') st.navigation = { toUrl: url.trim() };
      if (kind === 'navigation') st.page = { url: url.trim(), title: '' };
      if (st.replay && !Object.keys(st.replay).length) delete st.replay;
      await addStep(st);
      onAdded(st.id);
    } catch (e) { setErr(t('add.fail', { err: String(e) })); } finally { setBusy(false); }
  };

  return (
    <Modal title={t('add.title')} onClose={onClose} width={560} testId="add-step-dialog" footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" data-testid="add-step-ok" disabled={busy || problems.length > 0} onClick={() => void submit()}>{t('add.ok')}</button>
    </>}>
      <div className="small muted">{t('add.intro', { where: afterStepId ? t('add.whereAfter') : t('add.whereEnd') })}</div>
      <label className="f"><span>{t('add.kind')}</span>
        <select data-testid="add-step-kind" value={kind} onChange={(e) => { const k = e.target.value as AddKind; setKind(k); setWait(k === 'wait' ? { kind: 'element-present', value: '' } : undefined); }}>
          {KINDS.map((k) => <option key={k} value={k}>{k === 'navigation' ? t('add.kindNav', { kind: kindLabel(k, getLang()) }) : kindLabel(k, getLang())}</option>)}
        </select>
      </label>
      {needsSelector && (
        <div className="f" style={{ marginTop: 8 }}>
          <span className="small muted">{t('add.selTitle')}</span>
          <div className="row">
            <select data-testid="add-step-lang" style={{ width: 80 }} value={lang} onChange={(e) => setLang(e.target.value as 'css' | 'xpath')}><option value="css">CSS</option><option value="xpath">XPath</option></select>
            <input data-testid="add-step-selector" className="grow" value={selector} placeholder={lang === 'css' ? t('add.cssPh') : t('add.xpathPh')} onChange={(e) => setSelector(e.target.value)} />
          </div>
          <div className="small muted">{t('add.selNote')}</div>
        </div>
      )}
      {(kind === 'input' || kind === 'select') && (
        <label className="f"><span>{kind === 'input' ? t('add.valueInput') : t('add.valueSelect')}</span>
          <input data-testid="add-step-value" value={valueText} onChange={(e) => setValueText(e.target.value)} placeholder={t('sre.vtPh')} /></label>
      )}
      {kind === 'check' && <label className="row" style={{ marginTop: 8, gap: 4 }}><input type="checkbox" data-testid="add-step-checked" checked={checked} onChange={(e) => { const on = e.target.checked; setChecked(on); }} />{t('add.checked')}</label>}
      {kind === 'navigation' && <label className="f"><span>{t('add.url')}</span><input data-testid="add-step-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>}
      <div className="f" style={{ marginTop: 8 }}>
        <span className="small muted">{kind === 'wait' ? t('add.waitRequired') : t('sre.waitTitle')}</span>
        <WaitEditor value={wait} onChange={setWait} allowDefault={kind !== 'wait'} />
      </div>
      <label className="f"><span>{t('add.purpose')}</span><input data-testid="add-step-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} /></label>
      <label className="f"><span>{t('add.group')}</span>
        <select data-testid="add-step-group" value={gid} onChange={(e) => setGid(e.target.value)}>
          <option value="">{t('rv.none')}</option>
          {flat.map(({ group, depth }) => <option key={group.id} value={group.id}>{'　'.repeat(depth)}{group.name}</option>)}
        </select></label>
      {problems.length > 0 && <div className="note warn" data-testid="add-step-problems">{t('add.cannot', { list: problems.join(' / ') })}</div>}
      {err && <div className="note err">{err}</div>}
    </Modal>
  );
}
