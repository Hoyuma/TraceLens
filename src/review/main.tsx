import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/theme.css';
import { AnnotationEditor, Brand, useChanged } from '../ui/common';
import { getProject, getScenario, listArtifacts, listProjects, listScenarios, listSteps, patchArtifact, patchScenario, patchStep } from '../shared/db';
import { KIND_LABEL, PHASE_LABEL, hasAnnotation, newId, type Artifact, type Project, type Rect, type Scenario, type Step } from '../shared/types';
import { captureLevel, captureProblems, fmtTime, stepSummary } from '../shared/describe';
import { ExportDialog } from './ExportDialog';

const OP_KINDS = new Set(['click', 'input', 'select', 'check', 'key', 'manual-capture', 'element-note']);
const STATUS_LABEL: Record<string, string> = { captured: '取得済み', failed: '取得失敗', skipped: '未取得', pending: '取得待ち', 'not-applicable': '対象外' };

function useBlobUrl(blob?: Blob) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : ''), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function ShotView({ step, art, fallback, onChanged }: { step: Step; art?: Artifact; fallback?: { step: Step; art: Artifact }; onChanged: () => void }) {
  const url = useBlobUrl(art?.blob);
  const fbUrl = useBlobUrl(art ? undefined : fallback?.art.blob);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [masking, setMasking] = useState(false);
  const [draft, setDraft] = useState<Rect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => { setNat(null); setMasking(false); setDraft(null); }, [art?.id]);

  if (!art) {
    return (
      <div>
        <div className="note warn" data-testid="no-shot">この手順の画面はありません — {STATUS_LABEL[step.screenshot.status]}: {step.screenshot.reason ?? (step.screenshot.status === 'not-applicable' ? 'この種別では画面を取得しない' : '理由の記録なし')}</div>
        {fallback && (
          <div style={{ marginTop: 10 }}>
            <div className="small muted" data-testid="fallback-label"><b>直前の記録画面</b>（手順 {fallback.step.seq} の{PHASE_LABEL[fallback.art.phase]}、取得時刻 {fmtTime(fallback.art.capturedAt)}）— この手順の画面ではありません。操作位置は表示しません。</div>
            <div className="shot-wrap" style={{ marginTop: 4, opacity: .75 }}><img src={fbUrl} alt="直前の記録画面" /></div>
          </div>
        )}
      </div>
    );
  }
  const vp = art.meta?.viewport;
  const tr = art.meta?.targetRectAtCapture;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const pos = (e: React.MouseEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * nat!.w, y: ((e.clientY - r.top) / r.height) * nat!.h };
  };
  const down = (e: React.MouseEvent) => { if (!masking || !nat) return; e.preventDefault(); start.current = pos(e); setDraft({ ...start.current, width: 0, height: 0 }); };
  const move = (e: React.MouseEvent) => { if (!start.current || !nat) return; const p = pos(e); setDraft({ x: Math.min(p.x, start.current.x), y: Math.min(p.y, start.current.y), width: Math.abs(p.x - start.current.x), height: Math.abs(p.y - start.current.y) }); };
  const up = async () => {
    const d = draft; start.current = null; setDraft(null);
    if (!d || d.width < 4 || d.height < 4) return;
    const m = { x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) };
    await patchArtifact(art.id, (a) => { a.masks = [...(a.masks ?? []), m]; });
    onChanged();
  };
  const removeMask = async (i: number) => { await patchArtifact(art.id, (a) => { a.masks = (a.masks ?? []).filter((_, j) => j !== i); }); onChanged(); };
  return (
    <div>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="badge">{PHASE_LABEL[art.phase]}</span>
        <span className="small" data-testid="shot-time">画像の取得時刻 {fmtTime(art.capturedAt)}<span className="muted">（操作時刻 {fmtTime(step.operationAt)}）</span></span>
        <span style={{ flex: 1 }} />
        <button data-testid="btn-mask" className={masking ? 'on' : ''} onClick={() => setMasking(!masking)}>{masking ? '塗りつぶしを終了' : '塗りつぶしを追加'}</button>
        <label className="row small" style={{ gap: 3 }}><input type="checkbox" data-testid="shot-include" checked={art.includeInExport} onChange={async (e) => { const on = e.target.checked; await patchArtifact(art.id, (a) => { a.includeInExport = on; }); onChanged(); }} />出力に含める</label>
      </div>
      {masking && <div className="note info">画像上をドラッグして塗りつぶす範囲を指定します。塗りつぶしは出力画像そのものに適用されます（保存済みの原本は変更しません）。</div>}
      <div ref={wrap} className={`shot-wrap ${masking ? 'masking' : ''}`} data-testid="shot" onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={() => { if (start.current) void up(); }}>
        <img src={url} alt={`手順 ${step.seq} の画面`} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {tr && vp && <div className="hl" data-testid="highlight" style={{ left: pct(tr.x, vp.width), top: pct(tr.y, vp.height), width: pct(tr.width, vp.width), height: pct(tr.height, vp.height) }} />}
        {nat && (art.masks ?? []).map((m, i) => (
          <div key={i} className="mask" data-testid="mask" style={{ left: pct(m.x, nat.w), top: pct(m.y, nat.h), width: pct(m.width, nat.w), height: pct(m.height, nat.h) }}><button title="この塗りつぶしを削除" onMouseDown={(e) => e.stopPropagation()} onClick={() => removeMask(i)}>×</button></div>
        ))}
        {nat && draft && <div className="mask draft" style={{ left: pct(draft.x, nat.w), top: pct(draft.y, nat.h), width: pct(draft.width, nat.w), height: pct(draft.height, nat.h) }} />}
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {step.target ? (tr ? '橙色の枠: 画像取得の直前に再計測した操作対象の位置。' : `操作位置は表示していません — ${art.meta?.targetRectNote ?? '取得時点で対象要素との対応を確認できなかった'}`) : 'この手順には操作対象の要素がありません。'}
        {(art.masks?.length ?? 0) > 0 && ` / 塗りつぶし ${art.masks!.length} 箇所`} / 表示領域のみの画像です。
        {art.meta?.timingNote && <div className="note warn" data-testid="timing-note">{art.meta.timingNote}</div>}
      </div>
    </div>
  );
}

function Details({ step, dom, nextOpAt, shot, onChanged }: { step: Step; dom?: Artifact; shot?: Artifact; nextOpAt?: string; onChanged: () => void }) {
  const [showDom, setShowDom] = useState(false);
  useEffect(() => setShowDom(false), [step.id]);
  const t = step.target;
  const kv = (k: string, v: React.ReactNode) => <tr><th style={{ width: 110 }}>{k}</th><td>{v}</td></tr>;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="sec-title">技術情報</div>
      <details data-testid="d-element">
        <summary>要素情報</summary>
        {!t ? <div className="small muted">{step.elementCapture.status === 'failed' ? `取得失敗: ${step.elementCapture.reason}` : 'この手順には操作対象の要素がありません。'}</div> : (
          <table className="t"><tbody>
            {kv('タグ', `<${t.tag}>`)}{kv('id / name / type', `${t.id ?? '—'} / ${t.name ?? '—'} / ${t.type ?? '—'}`)}
            {kv('role', t.role.value ? `${t.role.value}（${t.role.source === 'attribute' ? 'role属性' : 'タグからの簡易推定'}）` : '—')}
            {kv('名前の候補', <>{t.nameCandidates.map((n, i) => <div key={i}>{n.source}: 「{n.value}」</div>)}{!t.nameCandidates.length && '—'}<div className="muted">{t.nameMethodNote}</div></>)}
            {kv('label', t.labels.join(' / ') || '—')}{kv('表示テキスト', t.text ?? '—')}{kv('placeholder', t.placeholder ?? '—')}
            {kv('状態', Object.entries(t.state).map(([k, v]) => `${k}=${v}`).join(', ') || '—')}
            {kv('位置とサイズ', `x=${t.rect.x}, y=${t.rect.y}, ${t.rect.width}×${t.rect.height}（操作時点・フレームのビューポート基準）`)}
            {kv('属性', Object.entries(t.attributes).map(([k, v]) => <div key={k}>{k}="{v}"</div>))}
            {kv('フレーム経路', step.frame.isTop ? 'トップフレーム' : step.frame.path.map((h) => `[${h.index}] ${h.crossOrigin ? 'クロスオリジン(セレクター取得不可)' : h.selector}`).join(' → '))}
            {kv('Shadow DOM経路', t.shadowPath.length ? t.shadowPath.map((h) => `${h.hostSelector} (open)`).join(' → ') : 'なし（open な Shadow DOM の外）')}
          </tbody></table>
        )}
      </details>
      <details data-testid="d-selectors">
        <summary>セレクター候補と一致件数</summary>
        {!t ? <div className="small muted">—</div> : (<>
          <table className="t"><thead><tr><th>候補</th><th style={{ width: 54 }}>一致件数</th><th style={{ width: 120 }}>安定性</th></tr></thead><tbody>
            {t.selectors.map((s, i) => <tr key={i}><td><code>{s.selector}</code><div className="muted">{s.kind} / {s.language}{s.scope === 'shadow-root' ? ' / Shadow root 内' : ''}</div></td><td>{s.matchCount ?? '計測不可'}</td><td>{s.stability === 'suspect' ? '⚠ ' : ''}{s.stabilityNote}</td></tr>)}
          </tbody></table>
          <div className="small muted">一致件数は記録時点の値です。どの候補も永続的に使えるとは限りません。</div>
        </>)}
      </details>
      <details data-testid="d-dom">
        <summary>DOM</summary>
        <div className="small">状態: {STATUS_LABEL[step.dom.status]}{step.dom.reason ? ` — ${step.dom.reason}` : ''}{dom ? ` / ${PHASE_LABEL[dom.phase]}・取得時刻 ${fmtTime(dom.capturedAt)}` : ''}</div>
        {dom && <label className="row small" style={{ gap: 3 }}><input type="checkbox" checked={dom.includeInExport} onChange={async (e) => { const on = e.target.checked; await patchArtifact(dom.id, (a) => { a.includeInExport = on; }); onChanged(); }} />このDOMを出力に含める</label>}
        {t && <><div className="small muted" style={{ marginTop: 4 }}>対象要素の周辺DOM{t.surroundingTruncated ? '（一部省略）' : ''}</div><pre>{t.surroundingHtml}</pre></>}
        {dom && <button className="link small" onClick={() => setShowDom(!showDom)}>{showDom ? 'DOM全体を閉じる' : `DOM全体を表示（${Math.round((dom.html?.length ?? 0) / 1024)} KB）`}</button>}
        {dom && showDom && (<>
          <pre>{(dom.html ?? '').slice(0, 200000)}</pre>
          <div className="small muted">フォームの現在値（HTMLに残らない状態）</div>
          <table className="t"><thead><tr><th>ref</th><th>要素</th><th>値 / 状態</th></tr></thead><tbody>
            {(dom.formState ?? []).map((f) => <tr key={f.ref}><td>{f.ref}</td><td>{f.tag}{f.type ? `[${f.type}]` : ''} {f.name ?? f.id ?? ''}</td><td>{f.redacted ? '（機密欄: 保存しない）' : f.checked !== undefined ? (f.checked ? 'checked' : 'unchecked') : f.value}</td></tr>)}
          </tbody></table>
        </>)}
      </details>
      <details data-testid="d-time">
        <summary>時間</summary>
        <table className="t"><tbody>
          {kv('操作の時刻', `${fmtTime(step.operationAt)}${step.operationEndAt ? ` 〜 最終編集 ${fmtTime(step.operationEndAt)}` : ''}`)}
          {kv('画面変化の観測', step.observations.length ? step.observations.map((o, i) => (
            <div key={i}>{o.type === 'dom-mutations' ? `DOM変化 ${o.count}件 (${fmtTime(o.firstAt)}〜${fmtTime(o.lastAt)})` : o.type === 'dom-quiet' ? `DOM変化の静止を観測 ${fmtTime(o.at)}（${o.quietMs}ms 変化なし）` : o.type === 'url-change' ? `URL変更 ${fmtTime(o.at)} → ${o.to}` : o.type === 'live-region' ? `通知表示(${o.role}) ${fmtTime(o.at)}「${o.text}」` : `観測終了 ${fmtTime(o.at)}（${o.reason}）`}</div>
          )) : '観測なし')}
          {kv('画像の取得', shot ? fmtTime(shot.capturedAt) : '—')}
          {kv('人間の完了確認', step.humanConfirmedAt ? fmtTime(step.humanConfirmedAt) : '未確認')}
          {kv('次の操作', nextOpAt ? fmtTime(nextOpAt) : '—')}
        </tbody></table>
        <div className="small muted">これらは別々の観測値です。操作の間隔はシステムの応答時間ではありません。DOM変化の静止は画面変化の観測であり、業務処理の完了を意味しません。</div>
      </details>
      <details data-testid="d-limits">
        <summary>取得範囲と制限</summary>
        <table className="t"><tbody>
          {kv('画面', `${STATUS_LABEL[step.screenshot.status]}${step.screenshot.reason ? ` — ${step.screenshot.reason}` : ''}`)}
          {kv('DOM', `${STATUS_LABEL[step.dom.status]}${step.dom.reason ? ` — ${step.dom.reason}` : ''}`)}
          {kv('要素情報', `${STATUS_LABEL[step.elementCapture.status]}${step.elementCapture.reason ? ` — ${step.elementCapture.reason}` : ''}`)}
          {kv('ページ', step.page.url)}
          {kv('制限', step.limitations.length ? step.limitations.map((l, i) => <div key={i}>{l.message}</div>) : 'この手順に固有の制限は記録されていません')}
        </tbody></table>
        <div className="small muted">共通の制限: 表示領域のみの画像 / 対象タブのみ / クロスオリジンiframe・closed Shadow DOM・canvas内部・ブラウザ内部ページは取得不可。</div>
      </details>
    </div>
  );
}

function ScenarioInfo({ scenario, onSaved }: { scenario: Scenario; onSaved: () => void }) {
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
      <div className="sec-title">シナリオ情報</div>
      <label className="f"><span>名前</span><input value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <label className="f"><span>調査目的</span><textarea data-testid="sc-purpose" value={f.purpose} onChange={(e) => set({ purpose: e.target.value })} /></label>
      <label className="f"><span>前提条件</span><textarea data-testid="sc-pre" value={f.preconditions} onChange={(e) => set({ preconditions: e.target.value })} /></label>
      <label className="f"><span>期待する最終結果</span><textarea data-testid="sc-expected" value={f.expectedResult} onChange={(e) => set({ expectedResult: e.target.value })} /></label>
      <label className="f"><span>未確認事項</span><textarea data-testid="sc-open" value={f.openQuestions} onChange={(e) => set({ openQuestions: e.target.value })} /></label>
      <div className="small muted" style={{ marginTop: 6 }}>
        記録: {scenario.sessions.length === 0 ? 'なし' : scenario.sessions.map((s) => `${new Date(s.startedAt).toLocaleString('ja-JP')}（${({ recording: '記録中', paused: '一時停止中', ended: '終了', interrupted: '中断' } as Record<string, string>)[s.status]}）`).join(' / ')}
        {scenario.sessions[0] && <div>環境: {(scenario.sessions.at(-1)!.environment.brands ?? []).map((b) => `${b.brand} ${b.version}`).join(', ') || scenario.sessions.at(-1)!.environment.userAgent} / {scenario.sessions.at(-1)!.environment.platform ?? ''}</div>}
      </div>
    </div>
  );
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState(new URLSearchParams(location.hash.slice(1)).get('scenario') ?? '');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [arts, setArts] = useState<Artifact[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [range, setRange] = useState({ from: '', to: '' });

  const load = async () => {
    const [ps, ss] = await Promise.all([listProjects(), listScenarios()]);
    setProjects(ps); setScenarios(ss);
    const id = ss.find((s) => s.id === scenarioId)?.id ?? ss.at(-1)?.id ?? '';
    if (id !== scenarioId) { setScenarioId(id); return; }
    if (!id) return;
    const sc = await getScenario(id);
    if (!sc) return;
    const [st, ar, pj] = await Promise.all([listSteps(id), listArtifacts(id), getProject(sc.projectId)]);
    setScenario(sc); setSteps(st); setArts(ar); setProject(pj ?? null);
  };
  useEffect(() => { void load(); history.replaceState(null, '', `#scenario=${scenarioId}`); /* eslint-disable-next-line */ }, [scenarioId]);
  useChanged(() => void load());

  const artById = useMemo(() => new Map(arts.map((a) => [a.id, a])), [arts]);
  const sel = steps.find((s) => s.id === selId) ?? steps[0] ?? null;
  const shotOf = (s: Step) => (s.screenshot.status === 'captured' && s.screenshot.artifactId ? artById.get(s.screenshot.artifactId) : undefined);
  const shot = sel ? shotOf(sel) : undefined;
  const dom = sel?.dom.artifactId ? artById.get(sel.dom.artifactId) : undefined;
  const fallback = useMemo(() => {
    if (!sel || shot) return undefined;
    const prev = [...steps].filter((s) => s.seq < sel.seq && s.sessionId === sel.sessionId).reverse().find((s) => shotOf(s));
    return prev ? { step: prev, art: shotOf(prev)! } : undefined; // eslint-disable-next-line
  }, [sel?.id, shot, steps, artById]);
  const nextOpAt = sel ? steps.find((s) => s.seq > sel.seq && s.sessionId === sel.sessionId && OP_KINDS.has(s.kind))?.operationAt : undefined;
  const groupName = new Map((scenario?.groups ?? []).map((g) => [g.id, g.name]));

  const setInclude = async (s: Step, on: boolean) => { await patchStep(s.id, (x) => { x.includeInExport = on; }); void load(); };
  const setGroup = async (value: string) => {
    if (!sel || !scenario) return;
    let gid: string | undefined = value || undefined;
    if (value === '__new') {
      const name = prompt('グループ名（例: 工数行の入力）');
      if (!name?.trim()) return;
      gid = newId('grp');
      await patchScenario(scenario.id, (s) => { s.groups.push({ id: gid!, name: name.trim() }); });
    }
    const from = Number(range.from) || sel.seq, to = Number(range.to) || sel.seq;
    for (const s of steps) if (s.seq >= Math.min(from, to) && s.seq <= Math.max(from, to)) await patchStep(s.id, (x) => { x.groupId = gid; });
    setRange({ from: '', to: '' });
    void load();
  };

  let lastGroup: string | undefined | null = null;
  return (
    <div className="rv">
      <div className="rv-top">
        <Brand />
        <span style={{ flex: 1 }} />
        <select data-testid="rv-scenario" value={scenarioId} onChange={(e) => { setSelId(null); setScenarioId(e.target.value); }} aria-label="シナリオ">
          {scenarios.length === 0 && <option value="">（記録なし）</option>}
          {scenarios.map((s) => <option key={s.id} value={s.id}>{projects.find((p) => p.id === s.projectId)?.name ?? '?'} / {s.name}</option>)}
        </select>
        <button data-testid="btn-info" className={showInfo ? 'on' : ''} onClick={() => setShowInfo(!showInfo)}>シナリオ情報</button>
        <button className="primary" data-testid="btn-export" disabled={!scenario || !project} onClick={() => setShowExport(true)}>AI向けZIPを出力…</button>
      </div>
      {!scenario ? <div className="empty">記録がありません。記録パネルからシナリオを作成し、記録を開始してください。</div> : (
        <div className="rv-body">
          <div className="col side">
            <div className="sec-title">操作一覧（{steps.length} 件 / 出力対象 {steps.filter((s) => s.includeInExport).length} 件）</div>
            <ul className="slist" data-testid="step-list">
              {steps.map((s) => {
                const head = s.groupId !== lastGroup && (s.groupId || lastGroup) ? <li className="g" key={`g-${s.id}`}>{s.groupId ? `▸ ${groupName.get(s.groupId) ?? 'グループ'}` : '—'}</li> : null;
                lastGroup = s.groupId;
                const probs = captureProblems(s).filter((p) => !p.includes('取得待ち'));
                return [head, (
                  <li key={s.id} className={`s ${sel?.id === s.id ? 'sel' : ''} ${s.includeInExport ? '' : 'excluded'}`} data-testid="step-row" data-step-id={s.id} data-kind={s.kind} onClick={() => setSelId(s.id)}>
                    <input type="checkbox" title="出力対象に含める" data-testid="step-include" checked={s.includeInExport} onClick={(e) => e.stopPropagation()} onChange={(e) => setInclude(s, e.target.checked)} />
                    <span className="n">{s.seq}</span>
                    <div className="body">
                      <div className="row" style={{ gap: 4 }}><span className="kind">{KIND_LABEL[s.kind]}</span>
                        {hasAnnotation(s.annotation) && <span className="flag memo" title="注記あり">✎ 注記</span>}
                        {captureLevel(s) === 'fail' && <span className="flag fail" title={probs.join('\n')} data-testid="flag-fail">⚠ 取得失敗</span>}
                        {captureLevel(s) === 'skip' && <span className="flag muted" title={probs.join('\n')} data-testid="flag-skip">画面なし</span>}
                        {!s.includeInExport && <span className="flag muted">出力対象外</span>}</div>
                      <div className="sum">{stepSummary(s)}</div>
                    </div>
                  </li>
                )];
              })}
            </ul>
            {steps.length === 0 && <div className="small muted">このシナリオにはまだ記録がありません。</div>}
          </div>
          <div className="col mid">
            {showInfo && <ScenarioInfo scenario={scenario} onSaved={() => void load()} />}
            {sel ? <ShotView step={sel} art={shot} fallback={fallback} onChanged={() => void load()} /> : <div className="empty">左の一覧から手順を選択してください。</div>}
          </div>
          <div className="col side">
            {sel && (<>
              <div className="sec-title">意図と条件</div>
              <div><b>手順 {sel.seq}</b> <span className="kind">{KIND_LABEL[sel.kind]}</span> <span className="small muted">{fmtTime(sel.operationAt)}</span></div>
              <div className="small" style={{ wordBreak: 'break-all' }}>{stepSummary(sel)}</div>
              {captureProblems(sel).map((p, i) => <div key={i} className="note warn">{p}</div>)}
              <AnnotationEditor step={sel} onSaved={() => void load()} />
              <div className="f" style={{ marginTop: 10 }}>
                <span className="small muted">グループ（元の順序は変わりません）</span>
                <div className="row">
                  <select data-testid="group-select" value={sel.groupId ?? ''} onChange={(e) => void setGroup(e.target.value)}>
                    <option value="">（なし）</option>
                    {scenario.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    <option value="__new">＋ 新しいグループ…</option>
                  </select>
                </div>
                <div className="row small muted" style={{ marginTop: 3 }}>範囲に適用: 手順 <input style={{ width: 48 }} value={range.from} placeholder={String(sel.seq)} onChange={(e) => setRange({ ...range, from: e.target.value })} />〜<input style={{ width: 48 }} value={range.to} placeholder={String(sel.seq)} onChange={(e) => setRange({ ...range, to: e.target.value })} />（指定してからグループを選択）</div>
              </div>
              <Details step={sel} dom={dom} shot={shot} nextOpAt={nextOpAt} onChanged={() => void load()} />
            </>)}
          </div>
        </div>
      )}
      {showExport && scenario && project && <ExportDialog project={project} scenario={scenario} steps={steps} artifacts={arts} onClose={() => setShowExport(false)} onGoStep={(id) => setSelId(id)} reload={load} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
