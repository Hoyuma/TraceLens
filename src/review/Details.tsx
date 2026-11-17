import { useEffect, useState } from 'react';
import { patchArtifact } from '../shared/db';
import type { Artifact, Step } from '../shared/types';
import { fmtTime } from '../shared/describe';
import { phaseLabel, statusLabel, t as tr } from '../ui/i18n';

export function Details({ step, dom, nextOpAt, shot, onChanged }: { step: Step; dom?: Artifact; shot?: Artifact; nextOpAt?: string; onChanged: () => void }) {
  const [showDom, setShowDom] = useState(false);
  useEffect(() => setShowDom(false), [step.id]);
  const t = step.target;
  const kv = (k: string, v: React.ReactNode) => <tr><th style={{ width: 110 }}>{k}</th><td>{v}</td></tr>;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="sec-title">{tr('det.title')}</div>
      <details data-testid="d-element">
        <summary>{tr('det.element')}</summary>
        {!t ? <div className="small muted">{step.elementCapture.status === 'failed' ? tr('det.captureFailed', { reason: step.elementCapture.reason ?? '' }) : tr('det.noElement')}</div> : (
          <table className="t"><tbody>
            {kv(tr('det.tag'), `<${t.tag}>`)}{kv('id / name / type', `${t.id ?? '—'} / ${t.name ?? '—'} / ${t.type ?? '—'}`)}
            {kv('role', t.role.value ? tr('det.roleLine', { role: t.role.value, src: t.role.source === 'attribute' ? tr('det.roleAttr') : tr('det.roleInferred') }) : '—')}
            {kv(tr('det.nameCand'), <>{t.nameCandidates.map((n, i) => <div key={i}>{n.source}: {tr('ann.quote', { v: n.value })}</div>)}{!t.nameCandidates.length && '—'}<div className="muted">{t.nameMethodNote}</div></>)}
            {kv('label', t.labels.join(' / ') || '—')}{kv(tr('det.text'), t.text ?? '—')}{kv('placeholder', t.placeholder ?? '—')}
            {kv(tr('det.state'), Object.entries(t.state).map(([k, v]) => `${k}=${v}`).join(', ') || '—')}
            {kv(tr('det.rect'), tr('det.rectLine', { x: t.rect.x, y: t.rect.y, w: t.rect.width, h: t.rect.height }))}
            {kv(tr('det.attrs'), Object.entries(t.attributes).map(([k, v]) => <div key={k}>{k}="{v}"</div>))}
            {kv(tr('det.framePath'), step.frame.isTop ? tr('det.topFrame') : step.frame.path.map((h) => `[${h.index}] ${h.crossOrigin ? tr('det.crossOrigin') : h.selector}`).join(' → '))}
            {kv(tr('det.shadowPath'), t.shadowPath.length ? t.shadowPath.map((h) => `${h.hostSelector} (open)`).join(' → ') : tr('det.noShadow'))}
          </tbody></table>
        )}
      </details>
      <details data-testid="d-selectors">
        <summary>{tr('det.selectors')}</summary>
        {!t ? <div className="small muted">—</div> : (<>
          <table className="t"><thead><tr><th>{tr('det.cand')}</th><th style={{ width: 54 }}>{tr('det.matches')}</th><th style={{ width: 120 }}>{tr('det.stability')}</th></tr></thead><tbody>
            {t.selectors.map((s, i) => <tr key={i}><td><code>{s.selector}</code><div className="muted">{s.kind} / {s.language}{s.scope === 'shadow-root' ? ` / ${tr('det.inShadow')}` : ''}</div></td><td>{s.matchCount ?? tr('det.unmeasurable')}</td><td>{s.stability === 'suspect' ? '⚠ ' : ''}{s.stabilityNote}</td></tr>)}
          </tbody></table>
          <div className="small muted">{tr('det.matchNote')}</div>
        </>)}
      </details>
      <details data-testid="d-dom">
        <summary>DOM</summary>
        <div className="small">{tr('det.domState', { status: statusLabel(step.dom.status) })}{step.dom.reason ? ` — ${step.dom.reason}` : ''}{dom ? ` / ${tr('det.phaseCaptured', { phase: phaseLabel(dom.phase), time: fmtTime(dom.capturedAt) })}` : ''}</div>
        {dom && <label className="row small" style={{ gap: 3 }}><input type="checkbox" checked={dom.includeInExport} onChange={async (e) => { const on = e.target.checked; await patchArtifact(dom.id, (a) => { a.includeInExport = on; }); onChanged(); }} />{tr('det.domInclude')}</label>}
        {t && <><div className="small muted" style={{ marginTop: 4 }}>{t.surroundingTruncated ? tr('det.surroundTrunc') : tr('det.surround')}</div><pre>{t.surroundingHtml}</pre></>}
        {dom && <button className="link small" onClick={() => setShowDom(!showDom)}>{showDom ? tr('det.domClose') : tr('det.domShow', { kb: Math.round((dom.html?.length ?? 0) / 1024) })}</button>}
        {dom && showDom && (<>
          <pre>{(dom.html ?? '').slice(0, 200000)}</pre>
          <div className="small muted">{tr('det.formState')}</div>
          <table className="t"><thead><tr><th>ref</th><th>{tr('det.formEl')}</th><th>{tr('det.formVal')}</th></tr></thead><tbody>
            {(dom.formState ?? []).map((f) => <tr key={f.ref}><td>{f.ref}</td><td>{f.tag}{f.type ? `[${f.type}]` : ''} {f.name ?? f.id ?? ''}</td><td>{f.redacted ? tr('det.redacted') : f.checked !== undefined ? (f.checked ? 'checked' : 'unchecked') : f.value}</td></tr>)}
          </tbody></table>
        </>)}
      </details>
      <details data-testid="d-time">
        <summary>{tr('det.time')}</summary>
        <table className="t"><tbody>
          {kv(tr('det.opTime'), step.operationEndAt ? tr('det.opTimeEnd', { start: fmtTime(step.operationAt), end: fmtTime(step.operationEndAt) }) : fmtTime(step.operationAt))}
          {kv(tr('det.obs'), step.observations.length ? step.observations.map((o, i) => (
            <div key={i}>{o.type === 'dom-mutations' ? tr('det.obsMut', { n: o.count, a: fmtTime(o.firstAt), b: fmtTime(o.lastAt) }) : o.type === 'dom-quiet' ? tr('det.obsQuiet', { time: fmtTime(o.at), ms: o.quietMs }) : o.type === 'url-change' ? tr('det.obsUrl', { time: fmtTime(o.at), to: o.to }) : o.type === 'live-region' ? tr('det.obsLive', { role: o.role, time: fmtTime(o.at), text: o.text }) : tr('det.obsEnd', { time: fmtTime(o.at), reason: o.reason })}</div>
          )) : tr('det.obsNone'))}
          {kv(tr('det.imgCaptured'), shot ? fmtTime(shot.capturedAt) : '—')}
          {kv(tr('det.humanConfirm'), step.humanConfirmedAt ? fmtTime(step.humanConfirmedAt) : tr('common.unverified'))}
          {kv(tr('det.nextOp'), nextOpAt ? fmtTime(nextOpAt) : '—')}
        </tbody></table>
        <div className="small muted">{tr('det.timeNote')}</div>
      </details>
      <details data-testid="d-limits">
        <summary>{tr('det.limits')}</summary>
        <table className="t"><tbody>
          {kv(tr('det.screen'), `${statusLabel(step.screenshot.status)}${step.screenshot.reason ? ` — ${step.screenshot.reason}` : ''}`)}
          {shot?.captureInfo && kv(tr('det.capMethod'), <div data-testid="d-capture-info">{{ visible: tr('det.mVisible'), element: tr('det.mElement'), 'full-page': tr('det.mFull') }[shot.captureInfo.method]}{shot.captureInfo.frameCount ? ` / ${tr('det.frames', { n: shot.captureInfo.frameCount })}` : ''}{shot.captureInfo.partial ? ` / ${tr('det.partialCap', { reason: shot.captureInfo.partialReason ?? '' })}` : ''}{shot.captureInfo.notes.map((n, i) => <div key={i} className="muted">{n}</div>)}</div>)}
          {step.beforeScreenshot && kv(tr('det.before'), <span data-testid="d-before-shot">{step.beforeScreenshot.status === 'captured' ? tr('det.beforeRef', { ref: step.beforeScreenshot.refStepId ?? '?', time: fmtTime(step.beforeScreenshot.capturedAt ?? '') }) : tr('det.beforeNone', { reason: step.beforeScreenshot.reason ?? tr('shot.noReason') })}</span>)}
          {kv('DOM', `${statusLabel(step.dom.status)}${step.dom.reason ? ` — ${step.dom.reason}` : ''}`)}
          {kv(tr('det.element'), `${statusLabel(step.elementCapture.status)}${step.elementCapture.reason ? ` — ${step.elementCapture.reason}` : ''}`)}
          {kv(tr('det.page'), step.page.url)}
          {kv(tr('det.limitsRow'), step.limitations.length ? step.limitations.map((l, i) => <div key={i}>{l.message}</div>) : tr('det.noLimits'))}
        </tbody></table>
        <div className="small muted">{tr('det.commonLimits')}</div>
      </details>
    </div>
  );
}
