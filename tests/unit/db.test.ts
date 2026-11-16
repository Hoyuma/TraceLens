// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { addStep, getStep, listSteps, patchStep } from '../../src/shared/db';
import { SCHEMA_VERSION, emptyAnnotation, hasAnnotation, type Step } from '../../src/shared/types';

const mk = (id: string, seq: number): Step => ({
  schemaVersion: SCHEMA_VERSION, id, scenarioId: 'scn', sessionId: 'ses', seq, kind: 'click', operationAt: '2026-11-16T10:00:00.000Z',
  page: { url: 'u', title: 't' }, frame: { isTop: true, path: [], url: 'u' }, observations: [], screenshot: { status: 'pending' }, dom: { status: 'pending' },
  elementCapture: { status: 'not-applicable' }, limitations: [], annotation: emptyAnnotation(), includeInExport: true,
});

describe('保存（IndexedDB）', () => {
  it('ステップは seq 順に読み出される', async () => {
    await addStep(mk('b', 2)); await addStep(mk('a', 1)); await addStep(mk('c', 3));
    expect((await listSteps('scn')).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('同時に走る複数の更新（記録側の観測追記と、人間の注記編集）が互いを上書きしない', async () => {
    await Promise.all([
      patchStep('a', (s) => { s.observations.push({ type: 'dom-quiet', at: 'x', quietMs: 400 }); }),
      patchStep('a', (s) => { s.annotation = { ...s.annotation, purpose: '目的', valueKind: 'variable', variableName: '工程コード' }; }),
      patchStep('a', (s) => { s.screenshot = { status: 'captured', artifactId: 'shot_a' }; }),
      patchStep('a', (s) => { s.includeInExport = false; }),
    ]);
    const s = (await getStep('a'))!;
    expect(s.observations).toHaveLength(1);
    expect(s.annotation).toMatchObject({ purpose: '目的', variableName: '工程コード' });
    expect(s.screenshot.status).toBe('captured');
    expect(s.includeInExport).toBe(false);
    expect(s.seq).toBe(1);
    expect(s.operationAt).toBe('2026-11-16T10:00:00.000Z');
    expect(hasAnnotation(s.annotation)).toBe(true);
  });

  it('存在しないステップへの更新は何も作らない', async () => {
    expect(await patchStep('zzz', (s) => { s.seq = 9; })).toBeUndefined();
    expect(await getStep('zzz')).toBeUndefined();
  });
});
