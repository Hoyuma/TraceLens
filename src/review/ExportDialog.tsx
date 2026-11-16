import { useEffect, useMemo, useRef, useState } from 'react';
import { buildExport, zipExport, type ExportResult } from '../shared/export';
import { patchArtifact, patchScenario } from '../shared/db';
import { newId, type Artifact, type Project, type ReplacementRule, type Scenario, type Step } from '../shared/types';
import { renderMasked } from '../ui/image';

interface Props { project: Project; scenario: Scenario; steps: Step[]; artifacts: Artifact[]; onClose: () => void; onGoStep: (id: string) => void; reload: () => Promise<void> }

function fmtBytes(n: number) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`; }

export function ExportDialog({ project, scenario, steps, artifacts, onClose, onGoStep, reload }: Props) {
  const [rules, setRules] = useState<ReplacementRule[]>(scenario.replacementRules);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [stale, setStale] = useState(true);
  const [selPath, setSelPath] = useState('scenario.md');
  const [err, setErr] = useState('');
  const urls = useRef<string[]>([]);

  const saveRules = (next: ReplacementRule[]) => { setRules(next); setStale(true); void patchScenario(scenario.id, (s) => { s.replacementRules = next; }); };

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
      const r = await buildExport({ project, scenario, steps, artifacts, rules, exportedAt: new Date().toISOString(), toolVersion: chrome.runtime.getManifest().version, renderImage: renderMasked });
      urls.current.forEach((u) => URL.revokeObjectURL(u)); urls.current = [];
      setResult(r); setStale(false);
      return r;
    } catch (e) { setErr(`出力の生成に失敗しました: ${String(e)}`); return null; } finally { setBuilding(false); }
  };
  useEffect(() => { void build(); return () => urls.current.forEach((u) => URL.revokeObjectURL(u)); /* eslint-disable-next-line */ }, [steps, artifacts]);

  const blobUrl = (bytes: Uint8Array) => { const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })); urls.current.push(u); return u; };
  const images = useMemo(() => (result?.files ?? []).filter((f) => f.bytes).map((f) => ({ path: f.path, url: blobUrl(f.bytes!), stepId: f.path.match(/step-\d{4}-(.+)\.png$/)?.[1] ?? '' })), [result]);
  const sel = result?.files.find((f) => f.path === selPath);
  const selImg = images.find((i) => i.path === selPath);

  const download = async () => {
    const r = await build(); // 常に最新の設定で作り直してから出力する
    if (!r) return;
    if (r.brokenReferences.length) { setErr('壊れた参照があるため出力を中止しました。'); return; }
    const zip = zipExport(r);
    const a = document.createElement('a');
    const u = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
    a.href = u; a.download = `tracelens-export_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  };
  const excludeImage = async (stepId: string) => { await patchArtifact(`shot_${stepId}`, (a) => { a.includeInExport = false; }); await reload(); };

  return (
    <div className="modal-bg" data-testid="export-dialog">
      <div className="modal">
        <header><h2 style={{ fontSize: 15 }}>AI向けZIPの出力 — 出力前の確認</h2><span className="grow" style={{ flex: 1 }} /><button onClick={onClose}>閉じる</button></header>
        <div className="content">
          <h3 style={{ fontSize: 13 }}>1. 入力値の置き換え</h3>
          <p className="small muted" style={{ margin: '4px 0' }}>指定した文字列を、手順書（Markdown）・JSON・DOM のすべてで同じ文字列に置き換えます。記録データ自体は変更しません。置換前の値はZIPに含めません。なお、手順を出力対象外にしても、同じ値が他の手順のDOMやフォーム状態に残ることがあります。値そのものを消したい場合は置換を使ってください。</p>
          <table className="t">
            <thead><tr><th style={{ width: 30 }}>有効</th><th>置き換える値（元の値）</th><th>置き換え後</th><th style={{ width: 30 }} /></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" checked={r.enabled} onChange={(e) => saveRules(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} /></td>
                  <td><input data-testid="rule-find" value={r.find} onChange={(e) => saveRules(rules.map((x) => (x.id === r.id ? { ...x, find: e.target.value } : x)))} />{r.find.length === 1 && <div className="small" style={{ color: 'var(--rec)' }}>1文字の置換は無関係な箇所も置き換えます</div>}</td>
                  <td><input data-testid="rule-with" value={r.replaceWith} onChange={(e) => saveRules(rules.map((x) => (x.id === r.id ? { ...x, replaceWith: e.target.value } : x)))} /></td>
                  <td><button onClick={() => saveRules(rules.filter((x) => x.id !== r.id))}>×</button></td>
                </tr>
              ))}
              {rules.length === 0 && <tr><td colSpan={4} className="muted">置換ルールはありません。</td></tr>}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <button data-testid="rule-add" onClick={() => saveRules([...rules, { id: newId('rul'), find: '', replaceWith: '', enabled: true }])}>＋ ルールを追加</button>
            {candidates.length > 0 && <span className="small muted">記録された入力値から追加:</span>}
            {candidates.map((c, i) => (
              <button key={i} className="small" title={`手順 ${c.seq} の入力値`} data-testid="rule-candidate" onClick={() => saveRules([...rules, { id: newId('rul'), find: c.value, replaceWith: c.name ? `{{${c.name}}}` : `{{値${rules.length + 1}}}`, enabled: true }])}>「{c.value.length > 16 ? c.value.slice(0, 16) + '…' : c.value}」</button>
            ))}
          </div>

          <h3 style={{ fontSize: 13, marginTop: 16 }}>2. 画像の確認</h3>
          <div className="note warn">画像内の文字は自動では処理されません。下の画像は実際に出力される内容（塗りつぶし適用済み）です。1枚ずつ確認し、必要なら「塗りつぶす」で編集するか、出力から除外してください。</div>
          <div className="thumbs" style={{ marginTop: 8 }}>
            {images.map((im) => (
              <figure key={im.path}>
                <img src={im.url} alt={im.path} onClick={() => setSelPath(im.path)} />
                <figcaption><div className="ellipsis" title={im.path}>{im.path.replace('screenshots/', '')}</div>
                  <div className="row"><button className="link small" onClick={() => { onGoStep(im.stepId); onClose(); }}>塗りつぶす</button><button className="link small" onClick={() => excludeImage(im.stepId)}>出力から除外</button></div></figcaption>
              </figure>
            ))}
            {result && images.length === 0 && <div className="muted">出力される画像はありません。</div>}
          </div>

          <h3 style={{ fontSize: 13, marginTop: 16 }}>3. 出力内容のプレビュー</h3>
          <div className="row" style={{ margin: '4px 0' }}>
            <button data-testid="preview-refresh" disabled={building} onClick={() => void build()}>{building ? '生成中…' : 'プレビューを更新'}</button>
            {stale && !building && <span className="small" style={{ color: 'var(--pause)' }}>設定が変更されています。更新してください。</span>}
            {result && !stale && <span className="small muted" data-testid="preview-summary">{result.files.length} ファイル / 合計 {fmtBytes(result.files.reduce((n, f) => n + (f.bytes?.length ?? new Blob([f.text!]).size), 0))}</span>}
          </div>
          {err && <div className="note err">{err}</div>}
          {result?.warnings.map((w, i) => <div key={i} className="note warn">{w}</div>)}
          {result && result.brokenReferences.length > 0 && <div className="note err" data-testid="broken-refs">壊れた参照: {result.brokenReferences.join(', ')}</div>}
          {result && result.residualValues.length > 0 && <div className="note err" data-testid="residual">置換対象の値が残っています: {result.residualValues.map((r) => `${r.path} (${r.count}件)`).join(', ')}</div>}
          {result && !stale && result.residualValues.length === 0 && rules.some((r) => r.enabled && r.find) && <div className="note info" data-testid="residual-ok">テキスト出力に置換前の値が残っていないことを確認しました（画像内の文字は対象外）。</div>}
          {result && (
            <div className="files">
              <ul data-testid="file-list">
                {[...result.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => (
                  <li key={f.path} className={f.path === selPath ? 'sel' : ''} onClick={() => setSelPath(f.path)}><span className="ellipsis">{f.path}</span><span className="muted">{fmtBytes(f.bytes?.length ?? new Blob([f.text!]).size)}</span></li>
                ))}
              </ul>
              <div style={{ minWidth: 0 }}>
                {selImg ? <img src={selImg.url} alt="" style={{ maxWidth: '100%', border: '1px solid var(--line)' }} /> : sel?.text !== undefined ? <pre data-testid="file-preview" style={{ maxHeight: 380, margin: 0 }}>{sel.text.length > 60000 ? sel.text.slice(0, 60000) + '\n…（プレビューは先頭のみ表示）' : sel.text}</pre> : <div className="muted">ファイルを選択してください。</div>}
              </div>
            </div>
          )}
        </div>
        <footer>
          <span className="small muted" style={{ marginRight: 'auto' }}>ZIPはこのPC上で生成され、外部へ送信されません。</span>
          <button onClick={onClose}>キャンセル</button>
          <button className="primary" data-testid="btn-download" disabled={building || !result} onClick={download}>ZIPを出力</button>
        </footer>
      </div>
    </div>
  );
}
