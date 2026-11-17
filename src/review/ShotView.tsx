import { useEffect, useMemo, useRef, useState } from 'react';
import { patchArtifact } from '../shared/db';
import type { Artifact, ImageMask, Rect, Step } from '../shared/types';
import { fmtTime } from '../shared/describe';
import { phaseLabel, statusLabel, t } from '../ui/i18n';
import { maskKindOf, normalizeCrop, targetRectInImage, toCropSpace } from '../ui/image';

type EditMode = 'fill' | 'blur' | 'crop' | null;
const MODE_HELP = { fill: 'shot.helpFill', blur: 'shot.helpBlur', crop: 'shot.helpCrop' } as const;

export function useBlobUrl(blob?: Blob) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : ''), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

export function ShotView({ step, art, fallback, onChanged }: { step: Step; art?: Artifact; fallback?: { step: Step; art: Artifact }; onChanged: () => void }) {
  const url = useBlobUrl(art?.blob);
  const fbUrl = useBlobUrl(art ? undefined : fallback?.art.blob);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<EditMode>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => { setNat(null); setMode(null); setDraft(null); }, [art?.id]);

  if (!art) {
    return (
      <div>
        <div className="note warn" data-testid="no-shot">{t('shot.noShot', { status: statusLabel(step.screenshot.status), reason: step.screenshot.reason ?? (step.screenshot.status === 'not-applicable' ? t('shot.naReason') : t('shot.noReason')) })}</div>
        {fallback && (
          <div style={{ marginTop: 10 }}>
            <div className="small muted" data-testid="fallback-label"><b>{t('shot.fbTitle')}</b>{t('shot.fbRest', { seq: fallback.step.seq, phase: phaseLabel(fallback.art.phase), time: fmtTime(fallback.art.capturedAt) })}</div>
            <div className="shot-wrap" style={{ marginTop: 4, opacity: .75 }}><img src={fbUrl} alt={t('shot.fbTitle')} /></div>
          </div>
        )}
      </div>
    );
  }
  const vp = art.meta?.viewport;
  const tr = art.meta?.targetRectAtCapture;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  // 切り抜きの範囲指定中は全体を見せる。それ以外は切り抜き済みなら切り抜き範囲だけを見せる。
  const crop = nat ? normalizeCrop(art.crop, nat.w, nat.h) : null;
  const viewCrop = mode === 'crop' ? null : crop;
  const vb = nat ? (viewCrop ?? { x: 0, y: 0, width: nat.w, height: nat.h }) : null;
  const hl = tr && vp && nat ? targetRectInImage(tr, vp, { width: nat.w, height: nat.h }, viewCrop) : null;
  const pos = (e: React.MouseEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: vb!.x + ((e.clientX - r.left) / r.width) * vb!.width, y: vb!.y + ((e.clientY - r.top) / r.height) * vb!.height };
  };
  const down = (e: React.MouseEvent) => { if (!mode || !nat) return; e.preventDefault(); start.current = pos(e); setDraft({ ...start.current, width: 0, height: 0 }); };
  const move = (e: React.MouseEvent) => { if (!start.current || !nat) return; const p = pos(e); setDraft({ x: Math.min(p.x, start.current.x), y: Math.min(p.y, start.current.y), width: Math.abs(p.x - start.current.x), height: Math.abs(p.y - start.current.y) }); };
  const up = async () => {
    const d = draft; start.current = null; setDraft(null);
    if (!d || d.width < 4 || d.height < 4) return;
    const m = { x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) };
    if (mode === 'crop') {
      const c = nat ? normalizeCrop(m, nat.w, nat.h) : null;
      if (!c || !nat) return;
      await patchArtifact(art.id, (a) => { a.crop = c; a.cropSourceSize = { width: nat.w, height: nat.h }; });
      setMode(null);
    } else if (mode) {
      const mk: ImageMask = { ...m, kind: mode };
      await patchArtifact(art.id, (a) => { a.masks = [...(a.masks ?? []), mk]; });
    }
    onChanged();
  };
  const resetCrop = async () => { await patchArtifact(art.id, (a) => { delete a.crop; delete a.cropSourceSize; }); onChanged(); };
  const removeMask = async (i: number) => { await patchArtifact(art.id, (a) => { a.masks = (a.masks ?? []).filter((_, j) => j !== i); }); onChanged(); };
  return (
    <div>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="badge">{phaseLabel(art.phase)}</span>
        <span className="small" data-testid="shot-time">{t('shot.capturedAt', { time: fmtTime(art.capturedAt) })}<span className="muted">{t('shot.opTime', { time: fmtTime(step.operationAt) })}</span></span>
        <span style={{ flex: 1 }} />
        <button data-testid="btn-mask" className={mode === 'fill' ? 'on' : ''} onClick={() => setMode(mode === 'fill' ? null : 'fill')}>{mode === 'fill' ? t('shot.fillEnd') : t('shot.fillAdd')}</button>
        <button data-testid="btn-blur" className={mode === 'blur' ? 'on' : ''} onClick={() => setMode(mode === 'blur' ? null : 'blur')}>{mode === 'blur' ? t('shot.blurEnd') : t('shot.blurAdd')}</button>
        <button data-testid="btn-crop" className={mode === 'crop' ? 'on' : ''} onClick={() => setMode(mode === 'crop' ? null : 'crop')}>{mode === 'crop' ? t('shot.cropEnd') : t('shot.cropAdd')}</button>
        {art.crop && <button data-testid="btn-crop-reset" onClick={resetCrop}>{t('shot.cropReset')}</button>}
        <label className="row small" style={{ gap: 3 }}><input type="checkbox" data-testid="shot-include" checked={art.includeInExport} onChange={async (e) => { const on = e.target.checked; await patchArtifact(art.id, (a) => { a.includeInExport = on; }); onChanged(); }} />{t('shot.include')}</label>
      </div>
      {mode && <div className="note info">{t(MODE_HELP[mode])}</div>}
      <div className="note warn small" data-testid="shot-ocr-note">{t('shot.ocr')}</div>
      <div ref={wrap} className={`shot-wrap ${mode ? 'masking' : ''} ${viewCrop ? 'cropped' : ''}`} data-testid="shot" style={viewCrop && vb ? { width: `min(100%, ${vb.width}px)`, aspectRatio: `${vb.width} / ${vb.height}` } : undefined} onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={() => { if (start.current) void up(); }}>
        <img src={url} alt={t('shot.alt', { seq: step.seq })} style={viewCrop && nat ? { position: 'absolute', maxWidth: 'none', width: pct(nat.w, viewCrop.width), left: pct(-viewCrop.x, viewCrop.width), top: pct(-viewCrop.y, viewCrop.height) } : undefined} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {hl && vb && <div className="hl" data-testid="highlight" style={{ left: pct(hl.x, vb.width), top: pct(hl.y, vb.height), width: pct(hl.width, vb.width), height: pct(hl.height, vb.height) }} />}
        {nat && vb && mode === 'crop' && crop && <div className="crop-frame" data-testid="crop-frame" style={{ left: pct(crop.x, nat.w), top: pct(crop.y, nat.h), width: pct(crop.width, nat.w), height: pct(crop.height, nat.h) }} />}
        {nat && vb && (art.masks ?? []).map((m, i) => {
          const r = viewCrop ? toCropSpace(m, viewCrop) : m;
          if (!r) return null;
          const kind = maskKindOf(m);
          return (
            <div key={i} className={`mask ${kind === 'blur' ? 'blur' : ''}`} data-testid="mask" data-kind={kind} style={{ left: pct(r.x, vb.width), top: pct(r.y, vb.height), width: pct(r.width, vb.width), height: pct(r.height, vb.height) }}><button title={kind === 'blur' ? t('shot.delBlur') : t('shot.delFill')} onMouseDown={(e) => e.stopPropagation()} onClick={() => removeMask(i)}>×</button></div>
          );
        })}
        {nat && vb && draft && <div className={`mask draft ${mode === 'crop' ? 'crop' : ''}`} style={{ left: pct(draft.x - vb.x, vb.width), top: pct(draft.y - vb.y, vb.height), width: pct(draft.width, vb.width), height: pct(draft.height, vb.height) }} />}
      </div>
      {((art.masks?.length ?? 0) > 0 || art.crop) && (
        <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }} data-testid="edit-list">
          {art.crop && <li data-testid="edit-crop">{t('shot.editCrop', { w: Math.round(art.crop.width), h: Math.round(art.crop.height), x: Math.round(art.crop.x), y: Math.round(art.crop.y) })}{nat && !crop && <span className="muted">{' '}{t('shot.cropInvalid')}</span>}</li>}
          {(art.masks ?? []).map((m, i) => (
            <li key={i} data-testid="edit-mask">{t('shot.maskLine', { kind: maskKindOf(m) === 'blur' ? t('shot.kBlur') : t('shot.kFill'), w: m.width, h: m.height, x: m.x, y: m.y })}{viewCrop && !toCropSpace(m, viewCrop) && <span className="muted">{t('shot.outsideCrop')}{' '}</span>}<button className="link small" onClick={() => removeMask(i)}>{t('common.delete')}</button></li>
          ))}
        </ul>
      )}
      <div className="small muted" style={{ marginTop: 4 }}>
        {step.target ? (tr ? t('shot.orange') : t('shot.noPos', { note: art.meta?.targetRectNote ?? t('shot.noPosDefault') })) : t('shot.noTarget')}
        {(art.masks ?? []).some((m) => maskKindOf(m) === 'fill') && ` / ${t('shot.fillCount', { n: art.masks!.filter((m) => maskKindOf(m) === 'fill').length })}`}
        {(art.masks ?? []).some((m) => maskKindOf(m) === 'blur') && ` / ${t('shot.blurCount', { n: art.masks!.filter((m) => maskKindOf(m) === 'blur').length })}`}
        {crop && ` / ${t('shot.cropped')}`} / {t('shot.visibleOnly')}{viewCrop && tr && !hl && ` ${t('shot.outCropPos')}`}
        {art.meta?.timingNote && <div className="note warn" data-testid="timing-note">{art.meta.timingNote}</div>}
      </div>
    </div>
  );
}
