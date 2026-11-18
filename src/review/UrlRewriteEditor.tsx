import { useEffect, useMemo, useState } from 'react';
import { patchScenario } from '../shared/db';
import { newUrlRewrite, rewriteUrl, validateUrlRewrite } from '../shared/urlRewrite';
import type { Scenario, Step, UrlRewrite } from '../shared/types';
import { t, trKnown } from '../ui/i18n';

/** 記録した URL の origin（置き換え元の候補） */
function recordedOrigins(steps: Step[]): string[] {
  const out = new Set<string>();
  for (const s of steps) for (const u of [s.page.url, s.navigation?.toUrl, s.frame.url]) {
    try { if (u) { const x = new URL(u); if (x.protocol === 'http:' || x.protocol === 'https:') out.add(x.origin); } } catch { /* 読めない URL */ }
  }
  return [...out];
}

/**
 * 再生時の URL の置き換え。記録した URL は書き換えず、再生の計画を作るときだけ置き換える。
 * 保存は「保存」ボタンで行い、検査に通らない規則は保存できない。
 */
export function UrlRewriteEditor({ scenario, steps, disabled, onSaved }: { scenario: Scenario; steps: Step[]; disabled?: boolean; onSaved?: () => void }) {
  const [rules, setRules] = useState<UrlRewrite[]>(scenario.urlRewrites ?? []);
  const [msg, setMsg] = useState('');
  useEffect(() => { setRules(scenario.urlRewrites ?? []); setMsg(''); }, [scenario.id, scenario.urlRewrites]);
  const origins = useMemo(() => recordedOrigins(steps), [steps]);
  const problems = rules.map((r) => validateUrlRewrite(r));
  const dirty = JSON.stringify(rules) !== JSON.stringify(scenario.urlRewrites ?? []);
  const set = (i: number, p: Partial<UrlRewrite>) => { setRules(rules.map((r, j) => (j === i ? { ...r, ...p } : r))); setMsg(''); };
  const affected = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of steps) for (const u of new Set([s.page.url, s.navigation?.toUrl].filter(Boolean) as string[])) { const r = rewriteUrl(u, rules).rule; if (r) n.set(r.id, (n.get(r.id) ?? 0) + 1); }
    return n;
  }, [steps, rules]);
  const save = async () => {
    if (problems.some((p) => p.length)) return;
    const next = rules.map((r) => ({ ...r, from: r.from.trim(), to: r.to.trim() }));
    await patchScenario(scenario.id, (s) => { s.urlRewrites = next; });
    setMsg(t('url.saved')); onSaved?.();
  };
  return (
    <div style={{ marginTop: 8 }} data-testid="url-rewrites">
      <div className="sec-title">{t('url.title')}</div>
      <div className="small muted">{t('url.intro')}</div>
      {rules.map((r, i) => (
        <div key={r.id} style={{ marginTop: 4 }} data-testid="url-rule">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <input type="checkbox" checked={r.enabled} disabled={disabled} aria-label={t('url.enabled')} onChange={(e) => { const on = e.target.checked; set(i, { enabled: on }); }} />
            <input data-testid="url-from" className="grow" list="tl-url-origins" value={r.from} disabled={disabled} placeholder={t('url.fromPh')} onChange={(e) => set(i, { from: e.target.value })} />
            <span>→</span>
            <input data-testid="url-to" className="grow" value={r.to} disabled={disabled} placeholder={t('url.toPh')} onChange={(e) => set(i, { to: e.target.value })} />
            <button className="link small" disabled={disabled} onClick={() => { setRules(rules.filter((_, j) => j !== i)); setMsg(''); }}>{t('common.delete')}</button>
          </div>
          {problems[i].map((p, k) => <div key={k} className="note err small" data-testid="url-problem">{trKnown(p)}</div>)}
          {!problems[i].length && <div className="small muted" data-testid="url-affected">{t('url.affected', { n: affected.get(r.id) ?? 0 })}</div>}
        </div>
      ))}
      <datalist id="tl-url-origins">{origins.map((o) => <option key={o} value={`${o}/`} />)}</datalist>
      <div className="row" style={{ marginTop: 6 }}>
        <button data-testid="url-add" disabled={disabled} onClick={() => { setRules([...rules, newUrlRewrite(origins[0] ? `${origins[0]}/` : '')]); setMsg(''); }}>{t('url.add')}</button>
        <button className="primary" data-testid="url-save" disabled={disabled || !dirty || problems.some((p) => p.length)} onClick={() => void save()}>{t('url.save')}</button>
        {msg && <span className="small" style={{ color: 'var(--ok)' }}>{msg}</span>}
      </div>
      <div className="small muted">{t('url.note')}</div>
    </div>
  );
}
