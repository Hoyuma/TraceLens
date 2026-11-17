// ローカル永続化 (IndexedDB)。拡張のページと Service Worker が同じ DB を共有する。
// 外部送信は一切行わない。
// v2: replayRuns ストアを追加。既存レコードは書き換えず、読み込み時に normalize* で既定値を補う。
import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { normalizeProject, normalizeScenario, normalizeStep, type Artifact, type Project, type Scenario, type Step } from './types';
import { sanitizeScenarioForSave } from './variables';
import { removeGroup } from './groups';
import { sanitizeReplayRun, type ReplayRun } from './replay';

const DB_NAME = 'tracelens';
export const DB_VERSION = 2;
let dbp: Promise<IDBPDatabase> | null = null;

const ALL_STORES = ['projects', 'scenarios', 'steps', 'artifacts', 'replayRuns'] as const;

export function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore('projects', { keyPath: 'id' });
          d.createObjectStore('scenarios', { keyPath: 'id' }).createIndex('projectId', 'projectId');
          d.createObjectStore('steps', { keyPath: 'id' }).createIndex('scenarioId', 'scenarioId');
          const a = d.createObjectStore('artifacts', { keyPath: 'id' });
          a.createIndex('scenarioId', 'scenarioId');
          a.createIndex('stepId', 'stepId');
        }
        if (oldVersion < 2) {
          // v1 → v2: 再生結果のストアを追加するだけ。既存のレコードは読み込み時に正規化する。
          d.createObjectStore('replayRuns', { keyPath: 'id' }).createIndex('scenarioId', 'scenarioId');
        }
      },
    });
  }
  return dbp;
}
export function resetDbHandleForTests(): void { dbp = null; }

export async function listProjects(): Promise<Project[]> { return ((await (await db()).getAll('projects')) as Project[]).map(normalizeProject).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
export async function putProject(p: Project): Promise<void> { await (await db()).put('projects', p); }
export async function getProject(id: string): Promise<Project | undefined> { const p = await (await db()).get('projects', id); return p ? normalizeProject(p) : undefined; }

/** プロジェクト名の変更。空の名前は拒否（undefined を返す）。 */
export async function renameProject(id: string, name: string): Promise<Project | undefined> {
  const n = name.trim();
  if (!n) return undefined;
  const tx = (await db()).transaction('projects', 'readwrite');
  const p: Project | undefined = await tx.store.get(id);
  if (p) { p.name = n; await tx.store.put(p); }
  await tx.done;
  return p ? normalizeProject(p) : undefined;
}

export async function listScenarios(projectId?: string): Promise<Scenario[]> {
  const d = await db();
  const all: Scenario[] = projectId ? await d.getAllFromIndex('scenarios', 'projectId', projectId) : await d.getAll('scenarios');
  return all.map(normalizeScenario).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function getScenario(id: string): Promise<Scenario | undefined> { const s = await (await db()).get('scenarios', id); return s ? normalizeScenario(s) : undefined; }
/** 保存時に機密の変数の既定値を落とす */
export async function putScenario(s: Scenario): Promise<void> { await (await db()).put('scenarios', sanitizeScenarioForSave(s)); }

/** 読み取りと書き込みを1トランザクションで行う（複数コンテキストからの同時更新で上書きしない） */
export async function patchScenario(id: string, fn: (s: Scenario) => void): Promise<Scenario | undefined> {
  const tx = (await db()).transaction('scenarios', 'readwrite');
  const raw: Scenario | undefined = await tx.store.get(id);
  let s: Scenario | undefined;
  if (raw) { s = normalizeScenario(raw); fn(s); s.updatedAt = new Date().toISOString(); s = sanitizeScenarioForSave(s); await tx.store.put(s); }
  await tx.done;
  return s;
}

/** seq の昇順（元の操作順）。表示・再生順が必要なら steps.ts の orderedSteps を使う。 */
export async function listSteps(scenarioId: string): Promise<Step[]> {
  const all: Step[] = await (await db()).getAllFromIndex('steps', 'scenarioId', scenarioId);
  return all.map(normalizeStep).sort((a, b) => a.seq - b.seq);
}
export async function getStep(id: string): Promise<Step | undefined> { const s = await (await db()).get('steps', id); return s ? normalizeStep(s) : undefined; }
export async function addStep(s: Step): Promise<void> { await (await db()).add('steps', s); }
export async function patchStep(id: string, fn: (s: Step) => void): Promise<Step | undefined> {
  const tx = (await db()).transaction('steps', 'readwrite');
  const raw: Step | undefined = await tx.store.get(id);
  let s: Step | undefined;
  if (raw) { s = normalizeStep(raw); fn(s); await tx.store.put(s); }
  await tx.done;
  return s;
}

export async function putArtifact(a: Artifact): Promise<void> { await (await db()).put('artifacts', a); }
export async function getArtifact(id: string): Promise<Artifact | undefined> { return (await db()).get('artifacts', id); }
export async function listArtifacts(scenarioId: string): Promise<Artifact[]> { return (await db()).getAllFromIndex('artifacts', 'scenarioId', scenarioId); }
export async function patchArtifact(id: string, fn: (a: Artifact) => void): Promise<Artifact | undefined> {
  const tx = (await db()).transaction('artifacts', 'readwrite');
  const a: Artifact | undefined = await tx.store.get(id);
  if (a) { fn(a); await tx.store.put(a); }
  await tx.done;
  return a;
}

// ---- 削除（いずれも 1 トランザクション。残りの手順の seq は変えない） ----------------------

type Tx = IDBPTransaction<unknown, string[], 'readwrite'>;

async function deleteByIndex(tx: Tx, store: string, index: string, key: string): Promise<number> {
  let n = 0;
  let cur = await tx.objectStore(store).index(index).openCursor(IDBKeyRange.only(key));
  while (cur) { await cur.delete(); n++; cur = await cur.continue(); }
  return n;
}

async function deleteScenarioIn(tx: Tx, scenarioId: string): Promise<void> {
  await deleteByIndex(tx, 'steps', 'scenarioId', scenarioId);
  await deleteByIndex(tx, 'artifacts', 'scenarioId', scenarioId);
  await deleteByIndex(tx, 'replayRuns', 'scenarioId', scenarioId);
  await tx.objectStore('scenarios').delete(scenarioId);
}

/** 手順と、その成果物（画面・DOM）を削除する。過去の再生結果は履歴として残す（stepId は参照先なしになる）。 */
export async function deleteStep(id: string): Promise<boolean> {
  const tx = (await db()).transaction(['steps', 'artifacts'], 'readwrite') as unknown as Tx;
  const s = await tx.objectStore('steps').get(id);
  if (s) { await deleteByIndex(tx, 'artifacts', 'stepId', id); await tx.objectStore('steps').delete(id); }
  await tx.done;
  return !!s;
}

/** シナリオと、その手順・成果物・再生結果を削除する */
export async function deleteScenario(id: string): Promise<boolean> {
  const tx = (await db()).transaction(['scenarios', 'steps', 'artifacts', 'replayRuns'], 'readwrite') as unknown as Tx;
  const s = await tx.objectStore('scenarios').get(id);
  if (s) await deleteScenarioIn(tx, id);
  await tx.done;
  return !!s;
}

/** プロジェクトと配下のすべて（シナリオ・手順・成果物・再生結果）を削除する */
export async function deleteProject(id: string): Promise<boolean> {
  const tx = (await db()).transaction([...ALL_STORES], 'readwrite') as unknown as Tx;
  const p = await tx.objectStore('projects').get(id);
  if (p) {
    const ids: string[] = (await tx.objectStore('scenarios').index('projectId').getAllKeys(IDBKeyRange.only(id))) as string[];
    for (const sid of ids) await deleteScenarioIn(tx, sid);
    await tx.objectStore('projects').delete(id);
  }
  await tx.done;
  return !!p;
}

/** グループを削除し、子グループと手順を親へ繰り上げる（groups.ts の removeGroup を 1 トランザクションで適用） */
export async function deleteGroup(scenarioId: string, groupId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tx = (await db()).transaction(['scenarios', 'steps'], 'readwrite') as unknown as Tx;
  const raw: Scenario | undefined = await tx.objectStore('scenarios').get(scenarioId);
  if (!raw) { await tx.done; return { ok: false, reason: 'シナリオが見つからない' }; }
  const sc = normalizeScenario(raw);
  const steps: Step[] = await tx.objectStore('steps').index('scenarioId').getAll(IDBKeyRange.only(scenarioId));
  const r = removeGroup(sc.groups, steps, groupId);
  if (!r.ok) { await tx.done; return r; }
  for (const m of r.stepMoves) {
    const st = steps.find((x) => x.id === m.stepId)!;
    if (m.groupId) st.groupId = m.groupId; else delete st.groupId;
    await tx.objectStore('steps').put(st);
  }
  await tx.objectStore('scenarios').put(sanitizeScenarioForSave({ ...sc, groups: r.groups, updatedAt: new Date().toISOString() }));
  await tx.done;
  return { ok: true };
}

// ---- 再生結果 -----------------------------------------------------------------

/** 保存時に secret の変数の値を落とす */
export async function putReplayRun(r: ReplayRun): Promise<void> { await (await db()).put('replayRuns', sanitizeReplayRun(r)); }
export async function getReplayRun(id: string): Promise<ReplayRun | undefined> { return (await db()).get('replayRuns', id); }
/** 開始時刻の昇順 */
export async function listReplayRuns(scenarioId: string): Promise<ReplayRun[]> {
  const all: ReplayRun[] = await (await db()).getAllFromIndex('replayRuns', 'scenarioId', scenarioId);
  return all.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
export async function latestReplayRun(scenarioId: string): Promise<ReplayRun | undefined> { return (await listReplayRuns(scenarioId)).at(-1); }
export async function patchReplayRun(id: string, fn: (r: ReplayRun) => void): Promise<ReplayRun | undefined> {
  const tx = (await db()).transaction('replayRuns', 'readwrite');
  const raw: ReplayRun | undefined = await tx.store.get(id);
  let r: ReplayRun | undefined;
  if (raw) { fn(raw); r = sanitizeReplayRun(raw); await tx.store.put(r); }
  await tx.done;
  return r;
}
