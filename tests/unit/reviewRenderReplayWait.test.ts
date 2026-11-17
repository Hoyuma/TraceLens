// 再生パネル: 失敗で止まっている再生の操作。操作済み（の可能性がある）手順を、確認なしにやり直せる経路が無いことを確かめる。
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { addStep, putProject, putScenario } from '../../src/shared/db';
import { REPLAY_STATE_KEY, type ActiveReplay } from '../../src/shared/messages';
import { buildReplayPlan } from '../../src/shared/replay';
import { mkProject, mkScenario, mkStep } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const steps = [mkStep(1, { kind: 'click' }), mkStep(2, { kind: 'click' })];
const replay: ActiveReplay = {
  runId: 'run_w', scenarioId: 'scn_1', tabId: 1, mode: 'all', status: 'paused',
  plan: buildReplayPlan({ id: 'scn_1' }, steps), position: 1, stepMode: false,
  waitReason: { code: 'failed-step', stepId: steps[1].id, message: '待機条件を観測できなかった', acted: 'yes' },
  variableValues: {}, secretVariableNames: [], startedAt: 0, docEpoch: 0,
};
const sendMessage = vi.fn(async () => ({ ok: true }));
(globalThis as { chrome?: unknown }).chrome = {
  runtime: { onMessage: { addListener: () => undefined, removeListener: () => undefined }, sendMessage, getManifest: () => ({ version: '0.1.0' }) },
  storage: { session: { get: async () => ({ [REPLAY_STATE_KEY]: replay }) }, onChanged: { addListener: () => undefined, removeListener: () => undefined } },
  permissions: { request: vi.fn(async () => true) },
};

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const sentTypes = () => sendMessage.mock.calls.map((c) => (c as unknown[])[0] as { t: string }).map((m) => m.t);

describe('再生パネル（失敗で停止中）', () => {
  beforeAll(async () => {
    await putProject(mkProject());
    await putScenario(mkScenario('scn_1'));
    for (const s of steps) await addStep(s);
    document.body.innerHTML = '<div id="root"></div>';
    location.hash = '#scenario=scn_1';
    await import('../../src/review/main');
    await flush();
  });
  afterAll(() => { document.body.innerHTML = ''; });

  it('汎用の「再開」は無効で、確認つきの再試行だけが操作をやり直す', async () => {
    expect(q('replay-wait')?.dataset.code).toBe('failed-step');
    expect(q('replay-resume')?.disabled).toBe(true);
    expect(q('replay-step')?.disabled).toBe(true);
    expect(q('replay-retry-warning')).not.toBeNull();

    sendMessage.mockClear();
    await act(async () => { q('replay-retry')!.click(); });
    await flush(2);
    expect(sentTypes()).not.toContain('ui:replay-resume');
    expect(q('replay-retry-confirm')).not.toBeNull();

    await act(async () => { q('replay-retry-confirm')!.click(); });
    await flush(2);
    expect(sentTypes()).toContain('ui:replay-resume');
  });
});
