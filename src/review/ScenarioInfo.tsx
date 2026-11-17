import { useEffect, useRef, useState } from 'react';
import { patchScenario } from '../shared/db';
import type { Scenario } from '../shared/types';
import { getLang, t } from '../ui/i18n';

export function ScenarioInfo({ scenario, onSaved }: { scenario: Scenario; onSaved: () => void }) {
  const [f, setF] = useState(scenario);
  useEffect(() => setF(scenario), [scenario.id]);
  const timer = useRef<number>();
  const set = (p: Partial<Scenario>) => {
    const next = { ...f, ...p }; setF(next);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void patchScenario(scenario.id, (s) => Object.assign(s, { name: next.name, purpose: next.purpose, preconditions: next.preconditions, expectedResult: next.expectedResult, openQuestions: next.openQuestions })).then(onSaved), 300);
  };
  return (
    <div className="card" style={{ marginBottom: 10 }} data-testid="scenario-info">
      <div className="sec-title">{t('rv.info')}</div>
      <label className="f"><span>{t('scn.name')}</span><input value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <label className="f"><span>{t('scn.purpose')}</span><textarea data-testid="sc-purpose" value={f.purpose} onChange={(e) => set({ purpose: e.target.value })} /></label>
      <label className="f"><span>{t('scn.pre')}</span><textarea data-testid="sc-pre" value={f.preconditions} onChange={(e) => set({ preconditions: e.target.value })} /></label>
      <label className="f"><span>{t('scn.expected')}</span><textarea data-testid="sc-expected" value={f.expectedResult} onChange={(e) => set({ expectedResult: e.target.value })} /></label>
      <label className="f"><span>{t('ann.open')}</span><textarea data-testid="sc-open" value={f.openQuestions} onChange={(e) => set({ openQuestions: e.target.value })} /></label>
      <div className="small muted" style={{ marginTop: 6 }}>
        {t('scn.recordsLabel')} {scenario.sessions.length === 0 ? t('scn.none') : scenario.sessions.map((s) => t('scn.sessionLine', { time: new Date(s.startedAt).toLocaleString(getLang() === 'en' ? 'en-US' : 'ja-JP'), status: ({ recording: t('sp.statusRec'), paused: t('sp.statusPause'), ended: t('scn.ended'), interrupted: t('run.interrupted') } as Record<string, string>)[s.status] })).join(' / ')}
        {scenario.sessions[0] && <div>{t('scn.env')} {(scenario.sessions.at(-1)!.environment.brands ?? []).map((b) => `${b.brand} ${b.version}`).join(', ') || scenario.sessions.at(-1)!.environment.userAgent} / {scenario.sessions.at(-1)!.environment.platform ?? ''}</div>}
      </div>
    </div>
  );
}
