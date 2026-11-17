import type { WaitCondition } from '../shared/types';
import { t } from '../ui/i18n';
import { validateWaitCondition } from './logic';

const KIND_OPTIONS = [
  { value: 'none', label: 'wait.none' },
  { value: 'dom-quiet', label: 'wait.domQuiet' },
  { value: 'element-present', label: 'wait.elPresent' },
  { value: 'element-absent', label: 'wait.elAbsent' },
  { value: 'text-present', label: 'wait.textPresent' },
  { value: 'url-matches', label: 'wait.urlMatches' },
] as const satisfies readonly { value: WaitCondition['kind']; label: string }[];

/**
 * 待機条件の編集。undefined は「既定」（短い DOM 変化の静止）。
 * 記録時の操作間隔は待機時間に使わない。状態条件で待つ。
 */
export function WaitEditor({ value, onChange, allowDefault = true }: { value: WaitCondition | undefined; onChange: (w: WaitCondition | undefined) => void; allowDefault?: boolean }) {
  const kind = value?.kind;
  const errs = value ? validateWaitCondition(value) : [];
  const set = (p: Partial<WaitCondition>) => onChange({ kind: kind ?? 'none', ...value, ...p });
  return (
    <div data-testid="wait-editor">
      <select data-testid="wait-kind" value={kind ?? '__default'} onChange={(e) => {
        const v = e.target.value;
        if (v === '__default') onChange(undefined);
        else onChange({ kind: v as WaitCondition['kind'], ...(v === 'dom-quiet' ? { quietMs: 400 } : {}) });
      }}>
        {allowDefault && <option value="__default">{t('wait.default')}</option>}
        {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
      </select>
      {(kind === 'element-present' || kind === 'element-absent') && (
        <input data-testid="wait-value" style={{ marginTop: 4 }} value={value?.value ?? ''} placeholder={t('wait.cssPh')} onChange={(e) => set({ value: e.target.value })} />
      )}
      {(kind === 'text-present' || kind === 'url-matches') && (<>
        <input data-testid="wait-value" style={{ marginTop: 4 }} value={value?.value ?? ''} placeholder={kind === 'url-matches' ? t('wait.urlPh') : t('wait.textPh')} onChange={(e) => set({ value: e.target.value })} />
        <label className="row small" style={{ gap: 3, marginTop: 2 }}>
          <input type="checkbox" data-testid="wait-regex" checked={!!value?.isRegex} onChange={(e) => { const on = e.target.checked; set({ isRegex: on }); }} />{t('wait.regex')}
        </label>
      </>)}
      {kind === 'dom-quiet' && (
        <label className="row small" style={{ gap: 4, marginTop: 4 }}>{t('wait.quietLabel')}
          <input data-testid="wait-quiet" type="number" min={1} style={{ width: 90 }} value={value?.quietMs ?? ''} placeholder="400" onChange={(e) => set({ quietMs: e.target.value === '' ? undefined : Number(e.target.value) })} /> ms
        </label>
      )}
      {kind === 'dom-quiet' && <div className="small muted">{t('wait.quietNote')}</div>}
      {kind === undefined && <div className="small muted">{t('wait.defaultNote')}</div>}
      {errs.map((e, i) => <div key={i} className="note err" data-testid="wait-error">{e}</div>)}
    </div>
  );
}
