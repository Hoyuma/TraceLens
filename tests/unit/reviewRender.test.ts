// レビュー画面の描画スモーク: 実際の画面コンポーネントを jsdom + fake-indexeddb で描画し、例外なく表示・操作できることを確かめる。
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { addStep, getStep, putProject, putScenario, putReplayRun } from '../../src/shared/db';
import { mkProject, mkScenario, mkStep } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const listeners: unknown[] = [];
(globalThis as { chrome?: unknown }).chrome = {
  runtime: { onMessage: { addListener: (f: unknown) => listeners.push(f), removeListener: () => undefined }, sendMessage: vi.fn(async () => undefined), getManifest: () => ({ version: '0.1.0' }) },
  storage: { session: { get: async () => ({}) }, onChanged: { addListener: () => undefined, removeListener: () => undefined } },
  permissions: { request: vi.fn(async () => true) },
};

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };

describe('レビュー画面の描画', () => {
  beforeAll(async () => {
    await putProject(mkProject());
    await putScenario(mkScenario('scn_1', { groups: [{ id: 'g1', name: '行の入力', parentId: null }], variables: [{ id: 'v1', name: '工程コード', defaultValue: 'A' }, { id: 's1', name: 'パスワード', secret: true }] }));
    await addStep(mkStep(1, { kind: 'click' }));
    await addStep(mkStep(2, { kind: 'input', groupId: 'g1', value: { kind: 'text', text: 'abc' }, replay: { valueTemplate: '{{工程コード}}' } }));
    await addStep(mkStep(3, { kind: 'input', value: { kind: 'redacted', redacted: true } }));
    await putReplayRun({ schemaVersion: 2, id: 'run_1', scenarioId: 'scn_1', startedAt: '2026-11-16T11:00:00.000Z', status: 'completed', mode: 'all', planStepIds: [], variableValues: {}, results: [{ stepId: mkStep(1).id, status: 'failed', reason: '要素が見つからない', startedAt: '2026-11-16T11:00:01.000Z' }] });
    document.body.innerHTML = '<div id="root"></div>';
    location.hash = '#scenario=scn_1';
    await import('../../src/review/main');
    await flush();
  });
  afterAll(() => { document.body.innerHTML = ''; });

  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const all = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
  const click = async (el: HTMLElement | null) => { expect(el).not.toBeNull(); await act(async () => { el!.click(); }); await flush(); };

  it('手順一覧・グループ・結果バッジを表示する', () => {
    expect(all('step-row')).toHaveLength(3);
    expect(all('group-row')).toHaveLength(1);
    expect(q('result-badge')?.dataset.status).toBe('failed');
    expect(q('btn-add-step')).not.toBeNull();
  });

  it('再生パネル: 機密欄の手順は人が操作として一覧に出し、変数の入力欄を出す', async () => {
    await click(q('btn-replay'));
    expect(q('replay-panel')).not.toBeNull();
    expect(q('replay-limits')?.textContent).toContain('isTrusted=false');
    expect(q('replay-manual-list')?.textContent).toContain('手順 3');
    expect(q('replay-var-工程コード')).not.toBeNull();
    expect((q('replay-start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('再生を開始すると、応答が無くても理由を表示する（権限は同期的に要求）', async () => {
    await click(q('replay-start'));
    await flush(3);
    expect((chrome.permissions.request as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(q('replay-error')?.textContent).toContain('応答がありません');
  });

  it('手順の削除は確認ダイアログを出し、元に戻せない旨を表示する', async () => {
    await click(all('step-row')[0]);
    await click(q('btn-delete-step'));
    expect(q('delete-note')?.textContent).toContain('元に戻せません');
    await click(q('confirm-cancel'));
    expect(q('confirm-dialog')).toBeNull();
    expect(await getStep(mkStep(1).id)).toBeDefined();
  });

  it('再生設定: 機密欄の手順は値の入力欄を出さず、通常の入力は値テンプレートを編集できる', async () => {
    await click(all('step-row')[2]);
    await click(q('tab-replay'));
    expect(q('replay-secret-note')?.textContent).toContain('再生時に人が入力');
    expect(q('replay-vt')).toBeNull();
    await click(all('step-row')[1]);
    expect(q('replay-vt')).not.toBeNull();
    expect((q('replay-vt') as HTMLInputElement).value).toBe('{{工程コード}}');
    expect((q('replay-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('変数ダイアログ: secret の既定値欄は無効で、保存しない旨を表示する', async () => {
    await click(q('btn-vars'));
    expect(q('variables-dialog')).not.toBeNull();
    expect(q('var-secret-note')?.textContent).toContain('保存しません');
    expect((all('var-default')[1] as HTMLInputElement).disabled).toBe(true);
    await click(q('modal-close'));
  });

  it('出力ダイアログに正規表現ルールの追加とフラグが表示される', async () => {
    await click(q('btn-export'));
    await flush(10);
    await click(q('rule-add-regex'));
    expect(q('rule-regex')).not.toBeNull();
    expect(q('rule-flag-i')).not.toBeNull();
    expect(q('rule-error')?.textContent).toContain('空');
    expect(q('regex-limits')?.textContent).toContain('$1');
    expect(q('export-with-run')).not.toBeNull();
  });
});
