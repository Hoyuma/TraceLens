// ローカル永続化 (IndexedDB)。拡張のページと Service Worker が同じ DB を共有する。
// 外部送信は一切行わない。
import { openDB, type IDBPDatabase } from 'idb';
import type { Artifact, Project, Scenario, Step } from './types';

const DB_NAME = 'tracelens';
const DB_VERSION = 1;
let dbp: Promise<IDBPDatabase> | null = null;

export function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('scenarios', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        d.createObjectStore('steps', { keyPath: 'id' }).createIndex('scenarioId', 'scenarioId');
        const a = d.createObjectStore('artifacts', { keyPath: 'id' });
        a.createIndex('scenarioId', 'scenarioId');
        a.createIndex('stepId', 'stepId');
      },
    });
  }
  return dbp;
}
export function resetDbHandleForTests(): void { dbp = null; }

export async function listProjects(): Promise<Project[]> { return (await (await db()).getAll('projects')).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
export async function putProject(p: Project): Promise<void> { await (await db()).put('projects', p); }
export async function getProject(id: string): Promise<Project | undefined> { return (await db()).get('projects', id); }

export async function listScenarios(projectId?: string): Promise<Scenario[]> {
  const d = await db();
  const all: Scenario[] = projectId ? await d.getAllFromIndex('scenarios', 'projectId', projectId) : await d.getAll('scenarios');
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function getScenario(id: string): Promise<Scenario | undefined> { return (await db()).get('scenarios', id); }
export async function putScenario(s: Scenario): Promise<void> { await (await db()).put('scenarios', s); }

/** 読み取りと書き込みを1トランザクションで行う（複数コンテキストからの同時更新で上書きしない） */
export async function patchScenario(id: string, fn: (s: Scenario) => void): Promise<Scenario | undefined> {
  const tx = (await db()).transaction('scenarios', 'readwrite');
  const s: Scenario | undefined = await tx.store.get(id);
  if (s) { fn(s); s.updatedAt = new Date().toISOString(); await tx.store.put(s); }
  await tx.done;
  return s;
}

export async function listSteps(scenarioId: string): Promise<Step[]> {
  const all: Step[] = await (await db()).getAllFromIndex('steps', 'scenarioId', scenarioId);
  return all.sort((a, b) => a.seq - b.seq);
}
export async function getStep(id: string): Promise<Step | undefined> { return (await db()).get('steps', id); }
export async function addStep(s: Step): Promise<void> { await (await db()).add('steps', s); }
export async function patchStep(id: string, fn: (s: Step) => void): Promise<Step | undefined> {
  const tx = (await db()).transaction('steps', 'readwrite');
  const s: Step | undefined = await tx.store.get(id);
  if (s) { fn(s); await tx.store.put(s); }
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
