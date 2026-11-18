import { useEffect, useMemo, useRef, useState } from 'react';
import { listArtifacts } from '../shared/db';
import { buildSelectorCandidates } from '../shared/selectors';
import { fmtTime } from '../shared/describe';
import type { Artifact, Rect, SelectorCandidate, Step } from '../shared/types';
import { Modal } from '../ui/common';
import { phaseLabel, t } from '../ui/i18n';
import { maskKindOf, targetRectInImage } from '../ui/image';
import { useBlobUrl } from './ShotView';
import { HIT_ATTR, HOVER_ATTR, INDEX_ATTR, boxOf, matchSelector, overlayCheck, prepareSnapshot } from './preview';

export interface PreviewSelector { language: 'css' | 'xpath'; selector: string }
const MAX_BOXES = 50;

/**
 * 画面プレビュー（子画面）。記録した DOM を、外部へ通信せず・スクリプトを動かさずに表示し、
 * セレクターに一致した要素を DOM と画像の両方に示す。DOM の要素をクリックしてセレクター候補を作れる。
 */
export function DomPreviewDialog({ steps, initialStepId, initialSelector, onPick, onClose }: {
  steps: Step[]; initialStepId: string | null; initialSelector?: PreviewSelector | null;
  /** 指定すると、候補を「使う」ボタンで呼び出し元へ返せる */
  onPick?: (s: PreviewSelector) => void; onClose: () => void;
}) {
  const scenarioId = steps[0]?.scenarioId ?? '';
  const [arts, setArts] = useState<Artifact[] | null>(null);
  useEffect(() => { if (scenarioId) void listArtifacts(scenarioId).then(setArts); }, [scenarioId]);
  const artById = useMemo(() => new Map((arts ?? []).map((a) => [a.id, a])), [arts]);
  const withDom = useMemo(() => [...steps].sort((a, b) => a.seq - b.seq).filter((s) => s.dom.status === 'captured' && s.dom.artifactId), [steps]);
  const pickDefault = () => {
    if (!initialStepId) return withDom.at(-1)?.id ?? '';
    const base = steps.find((s) => s.id === initialStepId);
    if (base && withDom.some((s) => s.id === base.id)) return base.id;
    // DOM がない手順（人が追加した手順など）は、それより前で DOM のある直近の手順
    return [...withDom].reverse().find((s) => !base || s.seq <= base.seq)?.id ?? withDom[0]?.id ?? '';
  };
  const [stepId, setStepId] = useState(pickDefault);
  const step = steps.find((s) => s.id === stepId);
  const dom = step?.dom.artifactId ? artById.get(step.dom.artifactId) : undefined;
  const pressArt = step?.pressScreenshot?.status === 'captured' && step.pressScreenshot.artifactId ? artById.get(step.pressScreenshot.artifactId) : undefined;
  const afterArt = step?.screenshot.status === 'captured' && step.screenshot.artifactId ? artById.get(step.screenshot.artifactId) : undefined;
  const [shotKind, setShotKind] = useState<'press' | 'after'>('press');
  const shot = shotKind === 'press' ? pressArt ?? afterArt : afterArt ?? pressArt;

  const [lang, setLang] = useState<'css' | 'xpath'>(initialSelector?.language ?? 'css');
  const [sel, setSel] = useState(initialSelector?.selector ?? '');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<{ index: string; tag: string; cands: SelectorCandidate[] } | null>(null);
  const [hover, setHover] = useState<Element | null>(null);

  const prepared = useMemo(() => (dom?.html !== undefined ? prepareSnapshot(dom.html, dom.formState) : null), [dom]);
  const match = useMemo(() => (prepared ? matchSelector(prepared.doc, lang, sel) : null), [prepared, lang, sel]);
  const hits = match?.ok ? match.elements : [];

  // 表示用の iframe に、一致した要素の強調を反映する
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(0);
  useEffect(() => { setPicked(null); setHover(null); }, [stepId]);
  useEffect(() => {
    const d = frame.current?.contentDocument;
    if (!d || !frameReady) return;
    d.querySelectorAll(`[${HIT_ATTR}]`).forEach((e) => e.removeAttribute(HIT_ATTR));
    const idx = new Set(hits.map((e) => e.getAttribute(INDEX_ATTR)));
    let first: Element | null = null;
    for (const i of idx) { const e = d.querySelector(`[${INDEX_ATTR}="${i}"]`); if (e) { e.setAttribute(HIT_ATTR, ''); first ??= e; } }
    first?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [hits, frameReady]);
  useEffect(() => {
    const d = frame.current?.contentDocument;
    if (!d || !frameReady) return;
    d.querySelectorAll(`[${HOVER_ATTR}]`).forEach((e) => e.removeAttribute(HOVER_ATTR));
    const i = hover?.getAttribute(INDEX_ATTR);
    if (i) d.querySelector(`[${INDEX_ATTR}="${i}"]`)?.setAttribute(HOVER_ATTR, '');
  }, [hover, frameReady]);

  /** iframe 上の位置にある要素（判定用の文書側の要素）。iframe は操作を受け付けない（リンクで移動させないため）ので、上に重ねた層で座標から引く */
  const elementAt = (e: React.MouseEvent): Element | null => {
    const f = frame.current, d = f?.contentDocument;
    if (!f || !d || !prepared) return null;
    const r = f.getBoundingClientRect();
    const el = d.elementFromPoint(e.clientX - r.left, e.clientY - r.top);
    const i = el?.getAttribute(INDEX_ATTR) ?? el?.closest(`[${INDEX_ATTR}]`)?.getAttribute(INDEX_ATTR);
    return i ? prepared.doc.querySelector(`[${INDEX_ATTR}="${i}"]`) : null;
  };
  const doPick = (el: Element) => {
    const cands = buildSelectorCandidates(el).filter((c) => c.scope === 'document');
    setPicked({ index: el.getAttribute(INDEX_ATTR) ?? '', tag: el.tagName.toLowerCase(), cands });
    setPicking(false);
    const best = cands.find((c) => c.matchCount === 1 && c.stability !== 'suspect') ?? cands[0];
    if (best) { setLang(best.language); setSel(best.selector); }
  };

  // 画像に重ねる位置
  const imgUrl = useBlobUrl(shot?.blob);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => setNat(null), [shot?.id]);
  const ov = overlayCheck(dom?.boxViewport, shot?.meta);
  const vp = shot?.meta?.viewport;
  const toImg = (r: Rect | null) => (r && vp && nat ? targetRectInImage(r, vp, { width: nat.w, height: nat.h }) : null);
  const hitBoxes = ov.ok ? hits.slice(0, MAX_BOXES).map(boxOf).map(toImg).filter((x): x is Rect => !!x) : [];
  const hoverBox = ov.ok && hover ? toImg(boxOf(hover)) : null;
  const noBoxCount = ov.ok ? hits.filter((h) => !boxOf(h)).length : 0;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  const recorded = step?.target?.selectors ?? [];
  const countOf = (c: PreviewSelector) => { if (!prepared) return null; const m = matchSelector(prepared.doc, c.language, c.selector); return m.ok ? m.elements.length : null; };

  return (
    <Modal title={t('pv.title')} onClose={onClose} width={1280} testId="dom-preview">
      <div className="small muted">{t('pv.intro')}</div>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
        <label className="row small" style={{ gap: 4 }}>{t('pv.step')}
          <select data-testid="pv-step" style={{ width: 'auto', maxWidth: 380 }} value={stepId} onChange={(e) => setStepId(e.target.value)}>
            {withDom.length === 0 && <option value="">{t('pv.noDomSteps')}</option>}
            {withDom.map((s) => <option key={s.id} value={s.id}>#{s.seq} {s.kind} {fmtTime(s.operationAt)}{s.target?.text ? ` — ${s.target.text.slice(0, 30)}` : ''}</option>)}
          </select>
        </label>
        <select data-testid="pv-lang" style={{ width: 80 }} value={lang} onChange={(e) => setLang(e.target.value as 'css' | 'xpath')}><option value="css">CSS</option><option value="xpath">XPath</option></select>
        <input data-testid="pv-selector" className="grow" style={{ minWidth: 240 }} value={sel} placeholder={t('pv.selPh')} onChange={(e) => setSel(e.target.value)} />
        <button data-testid="pv-pick" className={picking ? 'on' : ''} disabled={!prepared} onClick={() => setPicking(!picking)}>{picking ? t('pv.pickEnd') : t('pv.pick')}</button>
        {onPick && <button className="primary" data-testid="pv-use" disabled={!sel.trim() || !match?.ok} onClick={() => onPick({ language: lang, selector: sel.trim() })}>{t('pv.use')}</button>}
      </div>
      <div className="small" style={{ marginTop: 4 }} data-testid="pv-count">
        {!prepared ? <span className="muted">{arts === null ? t('pv.loading') : t('pv.noDom')}</span>
          : !match?.ok ? <span style={{ color: 'var(--err)' }}>{t('pv.selError', { err: match?.ok === false ? match.error : '' })}</span>
            : sel.trim() ? t('pv.matches', { n: hits.length }) : <span className="muted">{t('pv.enterSel')}</span>}
        {hover && <span className="muted" data-testid="pv-hover">{' '}{t('pv.hover', { tag: hover.tagName.toLowerCase() })}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10, marginTop: 8 }}>
        <div>
          <div className="row small" style={{ flexWrap: 'wrap', marginBottom: 4 }}>
            <b>{t('pv.shotTitle')}</b>
            {pressArt && afterArt && (<>
              <button className={shot === pressArt ? 'on' : ''} data-testid="pv-shot-press" onClick={() => setShotKind('press')}>{t('rv.shotPress')}</button>
              <button className={shot === afterArt ? 'on' : ''} data-testid="pv-shot-after" onClick={() => setShotKind('after')}>{t('rv.shotAfter')}</button>
            </>)}
          </div>
          {!shot ? <div className="note warn small">{t('pv.noShot')}</div> : (<>
            <div className="shot-wrap" style={{ position: 'relative' }} data-testid="pv-shot">
              <img src={imgUrl} alt="" onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
              {nat && (shot.masks ?? []).map((m, i) => <div key={`m${i}`} className={`mask ${maskKindOf(m) === 'blur' ? 'blur' : ''}`} style={{ left: pct(m.x, nat.w), top: pct(m.y, nat.h), width: pct(m.width, nat.w), height: pct(m.height, nat.h), pointerEvents: 'none' }} />)}
              {nat && hitBoxes.map((r, i) => <div key={i} className="hl" data-testid="pv-box" style={{ left: pct(r.x, nat.w), top: pct(r.y, nat.h), width: pct(r.width, nat.w), height: pct(r.height, nat.h) }} />)}
              {nat && hoverBox && <div className="hl" style={{ left: pct(hoverBox.x, nat.w), top: pct(hoverBox.y, nat.h), width: pct(hoverBox.width, nat.w), height: pct(hoverBox.height, nat.h), borderStyle: 'dashed', borderColor: '#2f6f8f', background: 'transparent' }} />}
            </div>
            <div className="small muted" style={{ marginTop: 4 }} data-testid="pv-shot-note">
              {t('pv.shotTimes', { phase: phaseLabel(shot.phase), shot: fmtTime(shot.capturedAt), dom: dom ? fmtTime(dom.capturedAt) : '—' })}
              {ov.ok ? ` ${t('pv.overlayNote')}` : <div className="note warn small" data-testid="pv-no-overlay">{t('pv.noOverlay', { reason: ov.reason })}</div>}
              {hits.length > MAX_BOXES && ` ${t('pv.tooMany', { n: MAX_BOXES })}`}
              {noBoxCount > 0 && ` ${t('pv.noBox', { n: noBoxCount })}`}
            </div>
          </>)}
        </div>
        <div>
          <div className="small" style={{ marginBottom: 4 }}><b>{t('pv.domTitle')}</b>{dom && <span className="muted">{' '}{t('pv.domTime', { time: fmtTime(dom.capturedAt) })}</span>}</div>
          {prepared && (
            <div style={{ position: 'relative', height: '58vh', border: '1px solid var(--line)', borderRadius: 4, overflow: 'hidden', background: '#fff' }}>
              <iframe ref={frame} key={dom?.id} title={t('pv.domTitle')} data-testid="pv-frame" sandbox="allow-same-origin" srcDoc={prepared.srcdoc} onLoad={() => setFrameReady((n) => n + 1)} style={{ width: '100%', height: '100%', border: 0 }} />
              <div data-testid="pv-layer" style={{ position: 'absolute', inset: 0, cursor: picking ? 'crosshair' : 'default' }}
                onMouseMove={(e) => setHover(elementAt(e))} onMouseLeave={() => setHover(null)}
                onWheel={(e) => frame.current?.contentWindow?.scrollBy(e.deltaX, e.deltaY)}
                onClick={(e) => { if (!picking) return; const el = elementAt(e); if (el) doPick(el); }} />
            </div>
          )}
          <div className="small muted" style={{ marginTop: 4 }}>{t('pv.domNote')}</div>
        </div>
      </div>

      {picked && (
        <div style={{ marginTop: 8 }} data-testid="pv-picked">
          <div className="sec-title">{t('pv.pickedTitle', { tag: picked.tag })}</div>
          <CandTable cands={picked.cands} onShow={(c) => { setLang(c.language); setSel(c.selector); }} onUse={onPick} note={t('pv.pickedNote')} />
        </div>
      )}
      {recorded.length > 0 && (
        <div style={{ marginTop: 8 }} data-testid="pv-recorded">
          <div className="sec-title">{t('pv.recordedTitle', { seq: step?.seq ?? '?' })}</div>
          <CandTable cands={recorded.map((c) => ({ ...c, matchCount: countOf(c) }))} onShow={(c) => { setLang(c.language); setSel(c.selector); }} onUse={onPick} note={t('pv.recordedNote')} />
        </div>
      )}
    </Modal>
  );
}

function CandTable({ cands, onShow, onUse, note }: { cands: SelectorCandidate[]; onShow: (c: PreviewSelector) => void; onUse?: (c: PreviewSelector) => void; note: string }) {
  return (<>
    <table className="t"><thead><tr><th>{t('det.cand')}</th><th style={{ width: 90 }}>{t('pv.inSnapshot')}</th><th style={{ width: 150 }} /></tr></thead><tbody>
      {cands.map((c, i) => (
        <tr key={i}>
          <td><code>{c.selector}</code><div className="muted">{c.kind} / {c.language}{c.stability === 'suspect' ? ` / ⚠ ${c.stabilityNote}` : ''}{c.scope === 'shadow-root' ? ` / ${t('pv.shadow')}` : ''}</div></td>
          <td>{c.matchCount ?? t('det.unmeasurable')}</td>
          <td><button className="link small" data-testid="pv-cand-show" onClick={() => onShow(c)}>{t('pv.show')}</button>{onUse && <button className="link small" data-testid="pv-cand-use" style={{ marginLeft: 8 }} onClick={() => onUse(c)}>{t('pv.use')}</button>}</td>
        </tr>
      ))}
    </tbody></table>
    <div className="small muted">{note}</div>
  </>);
}
