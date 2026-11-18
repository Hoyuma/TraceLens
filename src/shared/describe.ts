// ステップの短い説明（UI と Markdown 出力で共用）
import { KIND_LABEL, type Step, type StepKind, type WaitCondition } from './types';

/**
 * 表示言語。既定は 'ja'（出力 ZIP の Markdown / JSON はこの既定のまま生成する）。
 * 'en' は拡張の UI（サイドパネル・レビュー画面）の表示専用で、出力には使わない。
 */
export type DescLang = 'ja' | 'en';

const WAIT_KIND_LABEL: Record<WaitCondition['kind'], string> = {
  none: '待機しない', 'element-present': '要素の出現', 'element-absent': '要素の消失', 'text-present': '文字列の表示', 'url-matches': 'URLの一致', 'dom-quiet': 'DOM変化の静止',
};
const WAIT_KIND_LABEL_EN: Record<WaitCondition['kind'], string> = {
  none: 'No wait', 'element-present': 'Element appears', 'element-absent': 'Element disappears', 'text-present': 'Text is shown', 'url-matches': 'URL matches', 'dom-quiet': 'DOM changes settle',
};
const KIND_LABEL_EN: Record<StepKind, string> = {
  'session-start': 'Recording started', click: 'Click', input: 'Input', select: 'Select', check: 'Check', key: 'Key',
  navigation: 'Navigation', reload: 'Reload', 'spa-navigation': 'URL change (SPA)', 'manual-capture': 'Screen capture',
  'element-note': 'Element note', 'session-end': 'Recording ended', notice: 'Notice', wait: 'Wait', prefill: 'Pre-filled value',
};

/** 手順の種別名（UI 用。既定は日本語で KIND_LABEL と同じ） */
export function kindLabel(kind: StepKind, lang: DescLang = 'ja'): string { return lang === 'en' ? KIND_LABEL_EN[kind] : KIND_LABEL[kind]; }

/** 待機条件の短い説明。DOM変化の静止は画面変化の観測であり、業務処理の完了ではない。 */
export function waitLabel(w: WaitCondition | undefined, lang: DescLang = 'ja'): string {
  const en = lang === 'en';
  if (!w) return en ? 'Default (short DOM quiet period)' : '既定（DOM変化の短い静止）';
  const kl = (en ? WAIT_KIND_LABEL_EN : WAIT_KIND_LABEL)[w.kind];
  const v = w.value ? (en ? `${w.isRegex ? 'regex ' : ''}"${w.value}"` : `${w.isRegex ? '正規表現 ' : ''}「${w.value}」`) : '';
  if (w.kind === 'dom-quiet') return `${kl}${w.quietMs ? (en ? ` (${w.quietMs}ms)` : `（${w.quietMs}ms）`) : ''}`;
  return `${kl}${v ? `: ${v}` : ''}`;
}

export function targetLabel(step: Step, lang: DescLang = 'ja'): string {
  const t = step.target;
  if (!t) return '';
  const name = t.nameCandidates[0]?.value || t.text || t.placeholder || t.name || t.id || '';
  const kind = t.tag === 'input' && t.type ? `input[${t.type}]` : t.tag;
  const nm = name.length > 40 ? name.slice(0, 40) + '…' : name;
  return name ? (lang === 'en' ? `${kind} "${nm}"` : `${kind}「${nm}」`) : kind;
}

export function valueLabel(step: Step, lang: DescLang = 'ja'): string {
  const en = lang === 'en';
  const v = step.value;
  if (!v) return '';
  if (v.redacted) return en ? '(sensitive field: value not stored)' : '（機密欄: 値は保存していない）';
  if (v.kind === 'select') return (v.selectedOptions || []).map((o) => `${o.label} (value=${o.value})`).join(', ') || (en ? '(nothing selected)' : '（選択なし）');
  if (v.kind === 'checked') return v.checked ? (en ? 'On' : 'オン') : (en ? 'Off' : 'オフ');
  return v.text ?? '';
}

export function stepSummary(step: Step, lang: DescLang = 'ja'): string {
  const en = lang === 'en';
  const tl = targetLabel(step, lang);
  switch (step.kind) {
    case 'input': return en ? `Input to ${tl}: ${quote(valueLabel(step, lang), lang)}` : `${tl} に入力: ${quote(valueLabel(step), lang)}`;
    case 'select': return en ? `Select in ${tl}: ${valueLabel(step, lang)}` : `${tl} で選択: ${valueLabel(step)}`;
    case 'check': return en ? `Set ${tl} ${step.value?.checked ? 'on' : 'off'}` : `${tl} を${step.value?.checked ? 'オン' : 'オフ'}`;
    case 'click': return en ? `Click ${tl}` : `${tl} をクリック`;
    case 'key': {
      const k = step.key!;
      const combo = [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.meta && 'Meta', k.key === ' ' ? 'Space' : k.key].filter(Boolean).join('+');
      return en ? `${combo} key${tl ? ` (${tl})` : ''}` : `${combo} キー${tl ? `（${tl}）` : ''}`;
    }
    case 'navigation': case 'reload': case 'spa-navigation': return `${kindLabel(step.kind, lang)}: ${step.navigation?.toUrl ?? step.page.url}`;
    case 'notice': return step.notice?.message ?? (en ? 'Notice' : '通知');
    case 'element-note': return en ? `Element selected: ${tl}` : `要素を選択: ${tl}`;
    case 'session-start': return en ? `Recording started: ${step.page.url}` : `記録開始: ${step.page.url}`;
    case 'session-end': return en ? 'State at end of recording' : '記録終了時の状態';
    case 'manual-capture': return en ? 'Screen saved manually' : '手動で画面を保存';
    case 'wait': return `${en ? 'Wait' : '待機'}: ${waitLabel(step.replay?.wait, lang)}`;
    case 'prefill': {
      const af = step.prefill?.autofill ? (en ? ' (browser autofill shown)' : '（ブラウザの自動入力の表示あり）') : '';
      return en ? `Value already in ${tl}: ${quote(valueLabel(step, lang), lang)}${af}` : `${tl} に入力済みの値: ${quote(valueLabel(step), lang)}${af}`;
    }
  }
}
function quote(s: string, lang: DescLang) {
  const cut = s.length > 60 ? s.slice(0, 60) + '…' : s;
  if (lang === 'en') return s.startsWith('(') ? s : `"${cut}"`;
  return s.startsWith('（') ? s : `「${cut}」`;
}

/**
 * 取得失敗・未取得があるか（一覧での警告表示用）。
 * includePending=false にすると「取得待ち」の項目を含めない（取得中は問題として扱わない一覧用）。
 * reason・notice の文言は記録データ由来のため、言語にかかわらずそのまま返す。
 */
export function captureProblems(step: Step, lang: DescLang = 'ja', includePending = true): string[] {
  const en = lang === 'en';
  const out: string[] = [];
  const bad = (label: string, c: { status: string; reason?: string }) => {
    if (c.status === 'pending' && !includePending) return;
    if (c.status === 'failed' || c.status === 'skipped' || c.status === 'pending') out.push(`${label}: ${c.status === 'pending' ? (en ? 'pending capture' : '取得待ち') : c.reason || c.status}`);
  };
  bad(en ? 'Screen' : '画面', step.screenshot); bad('DOM', step.dom); bad(en ? 'Element info' : '要素情報', step.elementCapture);
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
