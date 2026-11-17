import { useEffect, useMemo, useRef, useState } from 'react';
import { REGEX_RULE_LIMITS, buildExport, validateReplacementRule, zipExport, type ExportResult } from '../shared/export';
import type { ReplayRun } from '../shared/replay';
import { getLang, runStatusLabel, t, trKnown } from '../ui/i18n';
import { patchArtifact, patchScenario } from '../shared/db';
import { newId, type Artifact, type Project, type ReplacementRule, type Scenario, type Step } from '../shared/types';
import { renderMasked } from '../ui/image';
import { fmtDateTime } from './ResultViews';

interface Props {
  project: Project; scenario: Scenario; steps: Step[]; artifacts: Artifact[];
  /** 直近の再生結果（任意）。含めるかどうかはダイアログで選ぶ。 */
  replayRun?: ReplayRun | null;
  onClose: () => void; onGoStep: (id: string) => void; reload: () => Promise<void>;
}

function fmtBytes(n: number) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`; }

const FLAG_ORDER = ['i', 'm', 's', 'u'] as const;
const FLAG_LABEL = { i: 'ex.flagI', m: 'ex.flagM', s: 'ex.flagS', u: 'ex.flagU' } as const;

export function ExportDialog({ project, scenario, steps, artifacts, replayRun, onClose, onGoStep, reload }: Props) {
  const [rules, setRules] = useState<ReplacementRule[]>(scenario.replacementRules);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [stale, setStale] = useState(true);
  const [selPath, setSelPath] = useState('scenario.md');
  const [err, setErr] = useState('');
  const [withRun, setWithRun] = useState(false);
  const urls = useRef<string[]>([]);

  const saveRules = (next: ReplacementRule[]) => { setRules(next); setStale(true); void patchScenario(scenario.id, (s) => { s.replacementRules = next; }); };
  const patchRule = (id: string, p: Partial<ReplacementRule>) => saveRules(rules.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const toggleFlag = (r: ReplacementRule, f: string, on: boolean) => {
    const set = new Set((r.flags ?? '').split(''));
    if (on) set.add(f); else set.delete(f);
    patchRule(r.id, { flags: FLAG_ORDER.filter((x) => set.has(x)).join('') });
  };

  const candidates = useMemo(() => {
    const seen = new Set(rules.map((r) => r.find));
    const out: { value: string; seq: number; name: string }[] = [];
    for (const s of steps) {
      if (!s.includeInExport || !s.value || s.value.redacted) continue;
      const vals = s.value.kind === 'select' ? (s.value.selectedOptions ?? []).map((o) => o.label) : s.value.kind === 'text' ? [s.value.text ?? ''] : [];
      for (const v of vals) { if (v.trim().length < 2 || seen.has(v)) continue; seen.add(v); out.push({ value: v, seq: s.seq, name: s.annotation.variableName }); }
    }
    return out.slice(0, 40);
  }, [steps, rules]);

  const build = async (): Promise<ExportResult | null> => {
    setBuilding(true); setErr('');
    try {
      const r = await buildExport({ project, scenario, steps, artifacts, rules, replayRun: withRun ? replayRun ?? null : null, exportedAt: new Date().toISOString(), toolVersion: chrome.runtime.getManifest().version, renderImage: renderMasked });
      urls.current.forEach((u) => URL.revokeObjectURL(u)); urls.current = [];
      setResult(r); setStale(false);
      return r;
    } catch (e) { setErr(t('ex.buildFail', { err: String(e) })); return null; } finally { setBuilding(false); }
  };
  useEffect(() => { void build(); return () => urls.current.forEach((u) => URL.revokeObjectURL(u)); /* eslint-disable-next-line */ }, [steps, artifacts, withRun]);

  const blobUrl = (bytes: Uint8Array) => { const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })); urls.current.push(u); return u; };
  const images = useMemo(() => (result?.files ?? []).filter((f) => f.bytes).map((f) => ({ path: f.path, url: blobUrl(f.bytes!), stepId: f.path.match(/step-\d{4}-(.+)\.png$/)?.[1] ?? '' })), [result]);
  const sel = result?.files.find((f) => f.path === selPath);
  const selImg = images.find((i) => i.path === selPath);

  const download = async () => {
    const r = await build(); // 常に最新の設定で作り直してから出力する
    if (!r) return;
    if (r.brokenReferences.length) { setErr(t('ex.brokenAbort')); return; }
    const zip = zipExport(r);
    const a = document.createElement('a');
    const u = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
    a.href = u; a.download = `tracelens-export_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  };
  const excludeImage = async (stepId: string) => { await patchArtifact(`shot_${stepId}`, (a) => { a.includeInExport = false; }); await reload(); };
  const problemOf = (id: string) => (stale ? undefined : result?.ruleProblems.find((p) => p.ruleId === id)?.reason);

  return (
    <div className="modal-bg" data-testid="export-dialog">
      <div className="modal">
        <header><h2 style={{ fontSize: 15 }}>{t('ex.title')}</h2><span className="grow" style={{ flex: 1 }} /><button onClick={onClose}>{t('common.close')}</button></header>
        <div className="content">
          <h3 style={{ fontSize: 13 }}>{t('ex.s1')}</h3>
          <p className="small muted" style={{ margin: '4px 0' }}>{t('ex.s1note')}</p>
          <table className="t">
            <thead><tr><th style={{ width: 30 }}>{t('ex.thEnabled')}</th><th>{t('ex.thFind')}</th><th>{t('ex.thWith')}</th><th style={{ width: 64 }}>{t('ex.thRegex')}</th><th style={{ width: 30 }} /></tr></thead>
            <tbody>
              {rules.map((r) => {
                const v = r.find || r.isRegex ? validateReplacementRule(r) : { ok: true as const };
                const prob = problemOf(r.id);
                return (
                  <tr key={r.id} data-testid="rule-row">
                    <td><input type="checkbox" checked={r.enabled} onChange={(e) => { const on = e.target.checked; patchRule(r.id, { enabled: on }); }} /></td>
                    <td>
                      <input data-testid="rule-find" value={r.find} onChange={(e) => patchRule(r.id, { find: e.target.value })} />
                      {!r.isRegex && r.find.length === 1 && <div className="small" style={{ color: 'var(--rec)' }}>{t('ex.oneChar')}</div>}
                      {r.isRegex && (
                        <div className="small" style={{ marginTop: 3 }}>
                          {FLAG_ORDER.map((f) => (
                            <label key={f} className="row" style={{ gap: 3, display: 'inline-flex', marginRight: 10 }}>
                              <input type="checkbox" data-testid={`rule-flag-${f}`} checked={(r.flags ?? '').includes(f)} onChange={(e) => { const on = e.target.checked; toggleFlag(r, f, on); }} />{t(FLAG_LABEL[f])}
                            </label>
                          ))}
                        </div>
                      )}
                      {!v.ok && <div className="note err" data-testid="rule-error">{trKnown(v.reason)}</div>}
                      {v.ok && prob && <div className="note warn" data-testid="rule-problem">{t('ex.notApplied', { reason: prob })}</div>}
                    </td>
                    <td><input data-testid="rule-with" value={r.replaceWith} onChange={(e) => patchRule(r.id, { replaceWith: e.target.value })} /></td>
                    <td><input type="checkbox" data-testid="rule-regex" aria-label={t('ex.thRegex')} checked={!!r.isRegex} onChange={(e) => { const on = e.target.checked; patchRule(r.id, { isRegex: on, flags: on ? r.flags ?? '' : undefined }); }} /></td>
                    <td><button onClick={() => saveRules(rules.filter((x) => x.id !== r.id))}>×</button></td>
                  </tr>
                );
              })}
              {rules.length === 0 && <tr><td colSpan={5} className="muted">{t('ex.noRules')}</td></tr>}
            </tbody>
          </table>
          {rules.some((r) => r.isRegex) && (
            <div className="note info" data-testid="regex-limits">
              <b>{t('ex.rlTitle')}</b>
              <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                <li>{t('ex.rl1').split('{code}')[0]}<code>$1</code>{t('ex.rl1').split('{code}')[1]}</li>
                <li>{t('ex.rl2', { max: REGEX_RULE_LIMITS.patternMax })}</li>
                <li>{t('ex.rl3', { matchMax: REGEX_RULE_LIMITS.matchMax, distinct: REGEX_RULE_LIMITS.distinctMax, input: REGEX_RULE_LIMITS.inputMax.toLocaleString(getLang() === 'en' ? 'en-US' : 'ja-JP') })}</li>
              </ul>
            </div>
          )}
          {result && !stale && result.ruleProblems.length > 0 && (
            <div className="note warn" data-testid="rule-problems">{t('ex.problemsList', { list: result.ruleProblems.map((p) => t('ex.problemItem', { name: rules.find((r) => r.id === p.ruleId)?.find || p.ruleId, reason: trKnown(p.reason) })).join(' / ') })}</div>
          )}
          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <button data-testid="rule-add" onClick={() => saveRules([...rules, { id: newId('rul'), find: '', replaceWith: '', enabled: true }])}>{t('ex.addRule')}</button>
            <button data-testid="rule-add-regex" onClick={() => saveRules([...rules, { id: newId('rul'), find: '', replaceWith: '', enabled: true, isRegex: true, flags: '' }])}>{t('ex.addRegex')}</button>
            {candidates.length > 0 && <span className="small muted">{t('ex.fromRecorded')}</span>}
            {candidates.map((c, i) => (
              <button key={i} className="small" title={t('ex.candTitle', { seq: c.seq })} data-testid="rule-candidate" onClick={() => saveRules([...rules, { id: newId('rul'), find: c.value, replaceWith: c.name ? `{{${c.name}}}` : `{{値${rules.length + 1}}}`, enabled: true }])}>{t('ann.quote', { v: c.value.length > 16 ? c.value.slice(0, 16) + '…' : c.value })}</button>
            ))}
          </div>

          <h3 style={{ fontSize: 13, marginTop: 16 }}>{t('ex.s2')}</h3>
          <div className="note warn">{t('ex.imgWarn')}</div>
          <div className="thumbs" style={{ marginTop: 8 }}>
            {images.map((im) => (
              <figure key={im.path}>
                <img src={im.url} alt={im.path} onClick={() => setSelPath(im.path)} />
                <figcaption><div className="ellipsis" title={im.path}>{im.path.replace('screenshots/', '')}</div>
                  <div className="row"><button className="link small" onClick={() => { onGoStep(im.stepId); onClose(); }}>{t('ex.fillBtn')}</button><button className="link small" onClick={() => excludeImage(im.stepId)}>{t('ex.excludeImg')}</button></div></figcaption>
              </figure>
            ))}
            {result && images.length === 0 && <div className="muted">{t('ex.noImages')}</div>}
          </div>

          <h3 style={{ fontSize: 13, marginTop: 16 }}>{t('ex.s3')}</h3>
          {replayRun ? (
            <label className="row" style={{ gap: 6, marginTop: 4 }}>
              <input type="checkbox" data-testid="export-with-run" checked={withRun} onChange={(e) => { const on = e.target.checked; setWithRun(on); setStale(true); }} />
              {t('ex.withRun', { time: fmtDateTime(replayRun.startedAt), status: runStatusLabel(replayRun.status) })}
            </label>
          ) : <div className="small muted" data-testid="export-no-run">{t('ex.noRun')}</div>}
          <div className="small muted">{t('ex.runNote')}</div>

          <h3 style={{ fontSize: 13, marginTop: 16 }}>{t('ex.s4')}</h3>
          <div className="row" style={{ margin: '4px 0' }}>
            <button data-testid="preview-refresh" disabled={building} onClick={() => void build()}>{building ? t('ex.building') : t('ex.refresh')}</button>
            {stale && !building && <span className="small" style={{ color: 'var(--pause)' }}>{t('ex.stale')}</span>}
            {result && !stale && <span className="small muted" data-testid="preview-summary">{t('ex.summary', { n: result.files.length, size: fmtBytes(result.files.reduce((n, f) => n + (f.bytes?.length ?? new Blob([f.text!]).size), 0)) })}</span>}
          </div>
          {err && <div className="note err">{err}</div>}
          {result?.warnings.map((w, i) => <div key={i} className="note warn">{w}</div>)}
          {result && result.brokenReferences.length > 0 && <div className="note err" data-testid="broken-refs">{t('ex.broken', { list: result.brokenReferences.join(', ') })}</div>}
          {result && result.residualValues.length > 0 && <div className="note err" data-testid="residual">{t('ex.residual', { list: result.residualValues.map((r) => t('ex.residualItem', { path: r.path, n: r.count })).join(', ') })}</div>}
          {result && !stale && result.residualValues.length === 0 && rules.some((r) => r.enabled && r.find) && <div className="note info" data-testid="residual-ok">{t('ex.residualOk')}</div>}
          {result && (
            <div className="files">
              <ul data-testid="file-list">
                {[...result.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => (
                  <li key={f.path} className={f.path === selPath ? 'sel' : ''} onClick={() => setSelPath(f.path)}><span className="ellipsis">{f.path}</span><span className="muted">{fmtBytes(f.bytes?.length ?? new Blob([f.text!]).size)}</span></li>
                ))}
              </ul>
              <div style={{ minWidth: 0 }}>
                {selImg ? <img src={selImg.url} alt="" style={{ maxWidth: '100%', border: '1px solid var(--line)' }} /> : sel?.text !== undefined ? <pre data-testid="file-preview" style={{ maxHeight: 380, margin: 0 }}>{sel.text.length > 60000 ? sel.text.slice(0, 60000) + '\n' + t('ex.truncated') : sel.text}</pre> : <div className="muted">{t('ex.pickFile')}</div>}
              </div>
            </div>
          )}
        </div>
        <footer>
          <span className="small muted" style={{ marginRight: 'auto' }}>{t('ex.local')}</span>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" data-testid="btn-download" disabled={building || !result} onClick={download}>{t('ex.download')}</button>
        </footer>
      </div>
    </div>
  );
}
