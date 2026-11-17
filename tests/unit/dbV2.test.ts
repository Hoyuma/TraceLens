// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import {
  DB_VERSION, addStep, db, deleteGroup, deleteProject, deleteScenario, deleteStep, getArtifact, getProject, getScenario, getStep, latestReplayRun, listArtifacts,
  listReplayRuns, listScenarios, listSteps, patchReplayRun, patchScenario, putArtifact, putProject, putReplayRun, putScenario, renameProject,
} from '../../src/shared/db';
import type { ReplayRun } from '../../src/shared/replay';
import { mkArtifacts, mkProject, mkScenario, mkStep } from './fixtures';

// v1 の形式のレコード（v2 の項目を持たない）
const V1_SCENARIO = { schemaVersion: 1, id: 'scn_v1', projectId: 'prj_v1', name: '旧', purpose: '', preconditions: '', expectedResult: '', openQuestions: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessions: [], groups: [{ id: 'g1', name: 'G' }], replacementRules: [{ id: 'r1', find: 'a', replaceWith: 'b', enabled: true }] };
const V1_STEP = { ...mkStep(1, {}, 'scn_v1'), schemaVersion: 1 } as Record<string, unknown>;
delete V1_STEP.origin; delete V1_STEP.order; delete V1_STEP.replay;

beforeAll(async () => {
  // DB_VERSION 1 の DB を作ってから、v2 の db() で開く（移行）
  const d1 = await openDB('tracelens', 1, {
    upgrade(d) {
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('scenarios', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      d.createObjectStore('steps', { keyPath: 'id' }).createIndex('scenarioId', 'scenarioId');
      const a = d.createObjectStore('artifacts', { keyPath: 'id' });
      a.createIndex('scenarioId', 'scenarioId');
      a.createIndex('stepId', 'stepId');
    },
  });
  await d1.put('projects', { schemaVersion: 1, id: 'prj_v1', name: '旧プロジェクト', description: '', createdAt: '2026-01-01T00:00:00.000Z' });
  await d1.put('scenarios', V1_SCENARIO);
  await d1.put('steps', V1_STEP);
  d1.close();
});

const run = (id: string, scenarioId: string, startedAt: string): ReplayRun => ({ schemaVersion: 2, id, scenarioId, startedAt, status: 'completed', mode: 'all', planStepIds: [], results: [], variableValues: {} });

describe('v1 データの読み込みと移行', () => {
  it('DB を v2 に上げ、replayRuns ストアを追加し、既存レコードはそのまま読める（既定値を補う）', async () => {
    const d = await db();
    expect(d.version).toBe(DB_VERSION);
    expect([...d.objectStoreNames]).toContain('replayRuns');
    const s = (await getScenario('scn_v1'))!;
    expect(s.schemaVersion).toBe(1); // 書き込まれた時点の版を残す
    expect(s.variables).toEqual([]);
    expect(s.groups).toEqual([{ id: 'g1', name: 'G', parentId: null }]);
    expect(s.replacementRules[0].isRegex).toBe(false);
    const st = (await listSteps('scn_v1'))[0];
    expect(st.origin).toBe('recorded');
    expect(st.seq).toBe(1);
    expect(st.order).toBeUndefined();
    expect((await getStep(st.id))!.origin).toBe('recorded');
    expect((await listScenarios('prj_v1')).map((x) => x.id)).toEqual(['scn_v1']);
  });
});

describe('保存 API の機密の扱い', () => {
  it('secret の変数の既定値は putScenario / patchScenario で保存しない', async () => {
    await putScenario(mkScenario('scn_sec', { variables: [{ id: 'v', name: 'pw', secret: true, defaultValue: 'SECRET1' }] }));
    const raw1 = await (await db()).get('scenarios', 'scn_sec');
    expect(JSON.stringify(raw1)).not.toContain('SECRET1');
    await patchScenario('scn_sec', (s) => { s.variables!.push({ id: 'w', name: 'pw2', secret: true, defaultValue: 'SECRET2' }); });
    expect(JSON.stringify(await (await db()).get('scenarios', 'scn_sec'))).not.toContain('SECRET2');
  });

  it('再生結果は secret の値を保存せず、シナリオ単位で開始時刻順に読める', async () => {
    await putReplayRun({ ...run('run_b', 'scn_sec', '2026-11-17T02:00:00.000Z'), variableValues: { pw: { provided: true, secret: true, value: 'SECRET3' } } });
    await putReplayRun(run('run_a', 'scn_sec', '2026-11-17T01:00:00.000Z'));
    expect((await listReplayRuns('scn_sec')).map((r) => r.id)).toEqual(['run_a', 'run_b']);
    expect((await latestReplayRun('scn_sec'))!.id).toBe('run_b');
    expect(JSON.stringify(await (await db()).get('replayRuns', 'run_b'))).not.toContain('SECRET3');
    await patchReplayRun('run_a', (r) => { r.status = 'failed'; r.reason = '停止'; r.variableValues = { pw: { provided: true, secret: true, value: 'SECRET4' } }; });
    const a = await (await db()).get('replayRuns', 'run_a');
    expect(a.status).toBe('failed');
    expect(JSON.stringify(a)).not.toContain('SECRET4');
  });
});

describe('削除と名前変更', () => {
  async function seed(prefix: string) {
    const p = mkProject(`prj_${prefix}`);
    await putProject(p);
    const s1 = mkScenario(`scn_${prefix}1`, { projectId: p.id });
    const s2 = mkScenario(`scn_${prefix}2`, { projectId: p.id });
    await putScenario(s1); await putScenario(s2);
    const steps = [mkStep(1, {}, s1.id), mkStep(2, {}, s1.id), mkStep(3, {}, s1.id), mkStep(1, {}, s2.id)];
    for (const st of steps) { await addStep(st); for (const a of mkArtifacts(st)) await putArtifact(a); }
    await putReplayRun(run(`run_${prefix}`, s1.id, '2026-11-17T00:00:00.000Z'));
    return { p, s1, s2, steps };
  }

  it('deleteStep は手順と成果物を消し、残りの手順の seq を変えない', async () => {
    const { s1, steps } = await seed('a');
    expect(await deleteStep(steps[1].id)).toBe(true);
    expect((await listSteps(s1.id)).map((s) => s.seq)).toEqual([1, 3]);
    expect(await getArtifact(`shot_${steps[1].id}`)).toBeUndefined();
    expect(await getArtifact(`dom_${steps[1].id}`)).toBeUndefined();
    expect(await getArtifact(`shot_${steps[0].id}`)).toBeDefined();
    expect(await deleteStep('nope')).toBe(false);
  });

  it('deleteScenario は手順・成果物・再生結果を消し、他のシナリオに触れない', async () => {
    const { s1, s2 } = await seed('b');
    expect(await deleteScenario(s1.id)).toBe(true);
    expect(await getScenario(s1.id)).toBeUndefined();
    expect(await listSteps(s1.id)).toEqual([]);
    expect(await listArtifacts(s1.id)).toEqual([]);
    expect(await listReplayRuns(s1.id)).toEqual([]);
    expect((await listSteps(s2.id)).length).toBe(1);
    expect((await listArtifacts(s2.id)).length).toBe(2);
  });

  it('deleteProject は配下のすべてを消す。renameProject は空の名前を拒否する', async () => {
    const { p, s1, s2 } = await seed('c');
    expect(await renameProject(p.id, '  ')).toBeUndefined();
    expect((await renameProject(p.id, ' 新しい名前 '))!.name).toBe('新しい名前');
    expect((await getProject(p.id))!.name).toBe('新しい名前');
    expect(await deleteProject(p.id)).toBe(true);
    expect(await getProject(p.id)).toBeUndefined();
    for (const id of [s1.id, s2.id]) { expect(await getScenario(id)).toBeUndefined(); expect(await listSteps(id)).toEqual([]); expect(await listArtifacts(id)).toEqual([]); expect(await listReplayRuns(id)).toEqual([]); }
    expect(await getScenario('scn_v1')).toBeDefined(); // 他のプロジェクトは残る
  });

  it('deleteGroup は子グループと手順を親へ繰り上げる（1 トランザクション）', async () => {
    await putScenario(mkScenario('scn_g', { groups: [{ id: 'a', name: 'A', parentId: null }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'b' }] }));
    const s = mkStep(1, { groupId: 'b' }, 'scn_g');
    await addStep(s);
    expect(await deleteGroup('scn_g', 'b')).toEqual({ ok: true });
    const sc = (await getScenario('scn_g'))!;
    expect(sc.groups.map((g) => [g.id, g.parentId])).toEqual([['a', null], ['c', 'a']]);
    expect((await getStep(s.id))!.groupId).toBe('a');
    expect((await getStep(s.id))!.seq).toBe(1);
    expect((await deleteGroup('scn_g', 'zz')).ok).toBe(false);
  });
});
