// 言語切り替え: 既存の reviewRender と同じ方式で、実際のレビュー画面を描画し、主要な見出し・ボタンが英語になることを確かめる。
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { addStep, putProject, putScenario } from '../../src/shared/db';
import { SETTINGS_KEY } from '../../src/shared/messages';
import { mkProject, mkScenario, mkStep } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const store: Record<string, unknown> = {};
const changeListeners: ((ch: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
(globalThis as { chrome?: unknown }).chrome = {
  runtime: { onMessage: { addListener: () => undefined, removeListener: () => undefined }, sendMessage: vi.fn(async () => undefined), getManifest: () => ({ version: '0.1.0' }) },
  storage: {
    session: { get: async () => ({}) },
    local: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
    },
    onChanged: { addListener: (f: (typeof changeListeners)[number]) => changeListeners.push(f), removeListener: () => undefined },
  },
  permissions: { request: vi.fn(async () => true) },
};

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };

describe('レビュー画面の言語切り替え', () => {
  beforeAll(async () => {
    await putProject(mkProject());
    await putScenario(mkScenario('scn_1', { groups: [], variables: [] }));
    await addStep(mkStep(1, { kind: 'click' }));
    await addStep(mkStep(2, { kind: 'input', value: { kind: 'text', text: 'abc' } }));
    document.body.innerHTML = '<div id="root"></div>';
    location.hash = '#scenario=scn_1';
    await import('../../src/review/main');
    await flush();
  });
  afterAll(() => { document.body.innerHTML = ''; });

  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const text = (id: string) => q(id)?.textContent ?? '';

  it('既定は日本語で、言語選択がある（英語向けの注記は出ない）', () => {
    expect(text('btn-replay')).toBe('再生');
    expect(text('btn-export')).toBe('AI向けZIPを出力…');
    expect(q('lang-select')).not.toBeNull();
    expect((q('lang-select') as HTMLSelectElement).value).toBe('ja');
    expect(q('lang-note')).toBeNull();
  });

  it('英語に切り替えると主要な見出し・ボタンが英語になり、データ由来の日本語は注記される。設定に保存される', async () => {
    const sel = q('lang-select') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(sel, 'en');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(text('btn-replay')).toBe('Replay');
    expect(text('btn-export')).toBe('Export ZIP for AI…');
    expect(text('btn-info')).toBe('Scenario info');
    expect(text('step-list-wrap')).toContain('Operations (total: 2 / to export: 2)');
    expect(text('btn-add-step')).toBe('+ Add step…');
    expect(q('lang-note')?.textContent).toMatch(/stay in Japanese/);
    expect((store[SETTINGS_KEY] as { lang?: string }).lang).toBe('en');
  });

  it('英語の再生パネルは「ok」を業務処理の完了と書かない', async () => {
    await act(async () => { q('btn-replay')!.click(); });
    await flush();
    expect(text('replay-limits')).toMatch(/does not confirm|means "the operation was performed/);
    expect(text('replay-limits')).toContain('isTrusted=false');
  });

  it('別のページでの切り替え（storage の変更）が反映され、日本語に戻る', async () => {
    await act(async () => { changeListeners.forEach((f) => f({ [SETTINGS_KEY]: { newValue: { lang: 'ja' } } }, 'local')); });
    await flush();
    expect(text('btn-replay')).toBe('再生');
    expect(q('lang-note')).toBeNull();
  });
});
