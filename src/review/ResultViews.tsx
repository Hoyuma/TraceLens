import { useState } from 'react';
import type { ReplayDiagnostics, ReplayRun, ReplayStepResult } from '../shared/replay';
import { fmtTime } from '../shared/describe';
import { getLang, replayStatusLabel, t } from '../ui/i18n';

const actedLabel = (a: NonNullable<ReplayStepResult['acted']>) => t(a === 'yes' ? 'res.actedYes' : a === 'possibly' ? 'res.actedPossibly' : 'res.actedNo');

const SHORT ={ ok: 'res.shortOk', failed: 'res.shortFailed', skipped: 'res.shortSkipped', manual: 'res.shortManual', pending: 'res.shortPending' } as const;

export function resultTitle(r: ReplayStepResult): string {
  const lines = [replayStatusLabel(r.status)];
  if (r.stoppedWhileRunning) lines.push(t('res.stoppedWhileRunning'));
  if (r.reason) lines.push(r.reason);
  if (r.acted) lines.push(`${t('res.actedLabel')}: ${actedLabel(r.acted)}`);
  if (r.selectorUsed) lines.push(t('res.selTitle', { src: r.selectorUsed.source === 'human' ? t('res.srcHuman') : t('res.srcRecord'), lang: r.selectorUsed.language, sel: r.selectorUsed.selector }));
  if (r.matchCount !== undefined) lines.push(t('res.matchTitle', { n: r.matchCount }));
  return lines.join('\n');
}

/** 一覧の各行に出す、直近の再生結果 */
export function ResultBadge({ result }: { result?: ReplayStepResult }) {
  if (!result) return null;
  const cls = result.status === 'failed' ? 'flag fail' : result.status === 'ok' ? 'flag memo' : 'flag muted';
  return <span className={cls} title={resultTitle(result)} data-testid="result-badge" data-status={result.status} data-stopped={result.stoppedWhileRunning ? 'true' : undefined}>{result.stoppedWhileRunning ? t('res.stoppedWhileRunning') : t(SHORT[result.status])}</span>;
}

/** 選択中の手順の再生結果。ok は「操作を実行し待機条件を観測できた」の意味で、業務処理の完了ではない。 */
export function StepResultView({ result, run, onEdit }: { result?: ReplayStepResult; run?: ReplayRun; onEdit?: () => void }) {
  if (!run) return <div className="small muted" data-testid="step-result-none">{t('res.none')}</div>;
  if (!result) return <div className="small muted" data-testid="step-result-none">{t('res.notInRun', { time: fmtDateTime(run.startedAt) })}</div>;
  return (
    <div data-testid="step-result" data-status={result.status}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <b>{replayStatusLabel(result.status)}</b>
        <span className="small muted">{t('res.runAt', { time: fmtDateTime(run.startedAt) })}</span>
      </div>
      {result.stoppedWhileRunning && <div className="note warn" data-testid="step-result-stopped">{t('res.stoppedNote')}</div>}
      {result.reason && <div className={`note ${result.status === 'failed' ? 'err' : 'info'}`} data-testid="step-result-reason">{result.reason}</div>}
      {result.detail && <div className="small muted">{result.detail}</div>}
      <table className="t" style={{ marginTop: 4 }}><tbody>
        <tr><th style={{ width: 110 }}>{t('res.selUsed')}</th><td>{result.selectorUsed ? <><code>{result.selectorUsed.selector}</code><div className="muted">{result.selectorUsed.language} / {result.selectorUsed.source === 'human' ? t('res.srcHuman') : t('res.srcRecordedCand')}</div></> : '—'}</td></tr>
        <tr><th>{t('res.matchLabel')}</th><td>{result.matchCount ?? '—'}</td></tr>
        {result.acted && <tr data-testid="step-result-acted" data-acted={result.acted}><th>{t('res.actedLabel')}</th><td>{actedLabel(result.acted)}</td></tr>}
        <tr><th>{t('res.waitLabel')}</th><td>{result.waitOutcome ? `${result.waitOutcome.kind}: ${({ observed: t('res.woObserved'), timeout: t('res.woTimeout'), 'not-applicable': t('res.woNa'), failed: t('res.woFailed') } as Record<string, string>)[result.waitOutcome.status]}${result.waitOutcome.detail ? ` — ${result.waitOutcome.detail}` : ''}` : '—'}</td></tr>
        <tr><th>{t('res.timeLabel')}</th><td>{fmtTime(result.startedAt)}{result.endedAt ? ` 〜 ${fmtTime(result.endedAt)}` : ''}</td></tr>
      </tbody></table>
      {result.status === 'ok' && <div className="small muted">{t('res.okNote')}</div>}
      {result.status === 'failed' && onEdit && <button className="link small" data-testid="goto-replay-edit" onClick={onEdit}>{t('res.editFailed')}</button>}
      {result.diag && <DiagView diag={result.diag} open={result.status === 'failed'} />}
    </div>
  );
}

const pathText = (p: readonly { index: number; selector?: string }[]) => (p.length ? p.map((h) => `${h.selector ?? '?'}[${h.index}]`).join(' > ') : t('res.diagTop'));

/** 再生の診断ログ（フレーム・セレクター・文書の切り替わり）。失敗した手順では開いた状態で出す */
export function DiagView({ diag, open }: { diag: ReplayDiagnostics; open?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(JSON.stringify(diag, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {}); };
  return (
    <details data-testid="step-result-diag" open={open} style={{ marginTop: 6 }}>
      <summary className="small">{t('res.diagTitle')}</summary>
      <div className="small muted">{t('res.diagNote')}</div>
      <button className="link small" data-testid="diag-copy" onClick={copy}>{copied ? t('res.diagCopied') : t('res.diagCopy')}</button>
      <div className="small" style={{ marginTop: 4 }}><b>{t('res.diagLog')}</b></div>
      <ol className="small" data-testid="diag-log" style={{ margin: 0, paddingLeft: 18, wordBreak: 'break-all' }}>
        {diag.log.map((x, i) => <li key={i}><span className="muted">{fmtTime(x.at)}</span> {x.text}{x.repeat ? t('res.diagRepeat', { n: x.repeat }) : ''}</li>)}
      </ol>
      {diag.truncated ? <div className="small muted">{t('res.diagTruncated', { n: diag.truncated })}</div> : null}
      <table className="t small" style={{ marginTop: 4, wordBreak: 'break-all' }}><tbody>
        {diag.recordedFrame && <tr><th style={{ width: 110 }}>{t('res.diagRecordedFrame')}</th><td><code>{pathText(diag.recordedFrame.path)}</code><div className="muted">{diag.recordedFrame.url}</div></td></tr>}
        {diag.frameId !== undefined && <tr><th>{t('res.diagChosen')}</th><td>frameId={diag.frameId}</td></tr>}
        {diag.attempts && diag.attempts.length > 0 && <tr><th>{t('res.diagAttempts')}</th><td><ul style={{ margin: 0, paddingLeft: 16 }}>{diag.attempts.map((a, i) => <li key={i}><code>{a.selector}</code> — {a.error ?? a.count}</li>)}</ul></td></tr>}
        {diag.probe && diag.probe.length > 0 && <tr data-testid="diag-probe"><th>{t('res.diagProbe')}</th><td><ul style={{ margin: 0, paddingLeft: 16 }}>{diag.probe.map((p) => <li key={p.frameId}>frameId={p.frameId} <code>{pathText(p.path)}</code> <span className="muted">{p.url}</span> — {p.counts.map((c) => `${c.selector}: ${c.count ?? '?'}`).join(' / ')}</li>)}</ul></td></tr>}
        {diag.frames && <tr data-testid="diag-frames"><th>{t('res.diagFrames', { n: diag.frames.length })}</th><td><ul style={{ margin: 0, paddingLeft: 16 }}>{diag.frames.map((f) => <li key={`${f.frameId}-${f.documentId ?? ''}`}>frameId={f.frameId} <code>{pathText(f.path)}</code> <span className="muted">{f.url}{f.readyState ? ` (${f.readyState})` : ''}{f.iframeCount ? ` iframe×${f.iframeCount}` : ''}</span></li>)}</ul></td></tr>}
      </tbody></table>
    </details>
  );
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(getLang() === 'en' ? 'en-US' : 'ja-JP');
}
