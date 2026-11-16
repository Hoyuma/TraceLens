// ステップの短い説明（UI と Markdown 出力で共用）
import { KIND_LABEL, type Step } from './types';

export function targetLabel(step: Step): string {
  const t = step.target;
  if (!t) return '';
  const name = t.nameCandidates[0]?.value || t.text || t.placeholder || t.name || t.id || '';
  const kind = t.tag === 'input' && t.type ? `input[${t.type}]` : t.tag;
  return name ? `${kind}「${name.length > 40 ? name.slice(0, 40) + '…' : name}」` : kind;
}

export function valueLabel(step: Step): string {
  const v = step.value;
  if (!v) return '';
  if (v.redacted) return '（機密欄: 値は保存していない）';
  if (v.kind === 'select') return (v.selectedOptions || []).map((o) => `${o.label} (value=${o.value})`).join(', ') || '（選択なし）';
  if (v.kind === 'checked') return v.checked ? 'オン' : 'オフ';
  return v.text ?? '';
}

export function stepSummary(step: Step): string {
  const tl = targetLabel(step);
  switch (step.kind) {
    case 'input': return `${tl} に入力: ${quote(valueLabel(step))}`;
    case 'select': return `${tl} で選択: ${valueLabel(step)}`;
    case 'check': return `${tl} を${step.value?.checked ? 'オン' : 'オフ'}`;
    case 'click': return `${tl} をクリック`;
    case 'key': {
      const k = step.key!;
      const combo = [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.meta && 'Meta', k.key === ' ' ? 'Space' : k.key].filter(Boolean).join('+');
      return `${combo} キー${tl ? `（${tl}）` : ''}`;
    }
    case 'navigation': case 'reload': case 'spa-navigation': return `${KIND_LABEL[step.kind]}: ${step.navigation?.toUrl ?? step.page.url}`;
    case 'notice': return step.notice?.message ?? '通知';
    case 'element-note': return `要素を選択: ${tl}`;
    case 'session-start': return `記録開始: ${step.page.url}`;
    case 'session-end': return '記録終了時の状態';
    case 'manual-capture': return '手動で画面を保存';
  }
}
function quote(s: string) { return s.startsWith('（') ? s : `「${s.length > 60 ? s.slice(0, 60) + '…' : s}」`; }

/** 取得失敗・未取得があるか（一覧での警告表示用） */
export function captureProblems(step: Step): string[] {
  const out: string[] = [];
  const bad = (label: string, c: { status: string; reason?: string }) => { if (c.status === 'failed' || c.status === 'skipped' || c.status === 'pending') out.push(`${label}: ${c.status === 'pending' ? '取得待ち' : c.reason || c.status}`); };
  bad('画面', step.screenshot); bad('DOM', step.dom); bad('要素情報', step.elementCapture);
  if (step.kind === 'notice' && step.notice) out.push(step.notice.message);
  return out;
}

export function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 一覧表示用: fail=取得失敗・通知あり / skip=画面などを意図的に取得していない / null=問題なし */
export function captureLevel(step: Step): 'fail' | 'skip' | null {
  const all = [step.screenshot, step.dom, step.elementCapture];
  if (step.kind === 'notice' || all.some((c) => c.status === 'failed')) return 'fail';
  if (all.some((c) => c.status === 'skipped')) return 'skip';
  return null;
}
