// 手順の取り込み（同じ DB 内のシナリオから / TraceLens の出力 ZIP から）
// 純粋な計画（planStepCopy / parseExportZip）と、IndexedDB への書き込み（1 トランザクション）に分ける。
//
// 方針:
//  - 取り込んだ内容は調査データであり、TraceLens は内容を検証しない（warnings で必ず伝える）。
//  - ID は再採番する。成果物の ID は `shot_<stepId>` / `dom_<stepId>` の規則に揃える。
//  - seq は取り込み先の最大 seq + 1 から振り、origin は imported、operationAt は取り込んだ時刻。
//    取り込み元の番号・時刻は importedFrom に残す（記録された時刻と取り込んだ時刻を混ぜない）。
//  - 出力 ZIP には置換済みの値しか入っていない。置換前の値を復元しようとしない。
import { unzipSync, strFromU8 } from 'fflate';
import {
  KIND_LABEL, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, emptyAnnotation, newId,
  type Artifact, type ArtifactPhase, type BeforeScreenshot, type ArtifactRef, type CaptureStatus, type ElementInfo, type FormStateEntry, type ISO, type Rect, type Scenario, type ScenarioVariable, type Step, type StepGroup, type StepKind,
} from './types';
import { childGroups, groupPath, validateGroups } from './groups';
import { nextOrderOf, nextSeqOf, orderedSteps } from './steps';
import { extractVariableNames, sanitizeScenarioForSave, sanitizeVariables, validateVariableName } from './variables';
import { db } from './db';

export const IMPORT_RESEARCH_DATA_WARNING = '取り込んだ内容は調査データです。TraceLens は内容（セレクター・値・待機条件など）の正しさを検証していません。再生する前に確認してください。';

// ---- (a) シナリオ間のコピー（純粋な計画） ----------------------------------------------

export interface CopySource {
  kind: 'scenario' | 'export-zip';
  scenario: Pick<Scenario, 'id' | 'name' | 'groups'> & { variables?: ScenarioVariable[] };
  steps: readonly Step[];
  artifacts: readonly Artifact[];
}
export interface CopyTarget { scenario: Scenario; steps: readonly Step[] }
export interface CopyOptions {
  /** 取り込む手順（未指定はすべて）。表示・再生順で取り込む。 */
  stepIds?: string[];
  /** 指定すると、この名前の新しいグループを作り、その下に取り込む */
  newGroupName?: string;
  /** 新しいグループの親（取り込み先の既存グループ）。未指定は最上位 */
  newGroupParentId?: string | null;
  /** 画面・DOM の成果物もコピーするか */
  copyArtifacts: boolean;
  now: ISO;
}
export interface CopyPlan {
  steps: Step[];
  artifacts: Artifact[];
  /** 取り込み先シナリオの新しい groups（既存 + 追加分） */
  groups: StepGroup[];
  /** 取り込み先シナリオの新しい variables（既存 + 追加分。secret の既定値は持たない） */
  variables: ScenarioVariable[];
  /** 元のステップ ID → 新しいステップ ID */
  idMap: Record<string, string>;
  warnings: string[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function notImported(ref: ArtifactRef, label: string): ArtifactRef {
  if (ref.status !== 'captured') return { status: ref.status, reasonCode: ref.reasonCode, reason: ref.reason };
  return { status: 'skipped', reasonCode: 'not-imported', reason: `取り込み時に${label}をコピーしなかった` };
}

/** 取り込んだ手順の beforeScreenshot を付け替える（参照できなければ理由つきの未取得。取り込み元の ID を残さない） */
export function remapBeforeScreenshot(
  b: BeforeScreenshot,
  c: { idMap: Readonly<Record<string, string>>; copyArtifacts: boolean; srcById: ReadonlyMap<string, Step>; stepById: ReadonlyMap<string, Step> },
): BeforeScreenshot {
  const unavailable = (status: 'skipped' | 'failed', reasonCode: string, reason: string): BeforeScreenshot => ({ status, reasonCode, reason, basis: b.basis });
  if (b.status !== 'captured') return { status: b.status, reasonCode: b.reasonCode, reason: b.reason, basis: b.basis };
  if (!c.copyArtifacts) return unavailable('skipped', 'not-imported', '取り込み時に画面をコピーしなかったため、操作前の画面の参照先がない');
  const newRef = b.refStepId ? c.idMap[b.refStepId] : undefined;
  if (!b.refStepId || !newRef) return unavailable('skipped', 'ref-not-imported', '操作前の画面の参照先の手順を取り込んでいないため、参照しない');
  const srcRef = c.srcById.get(b.refStepId);
  const ref = c.stepById.get(newRef);
  if (!srcRef || srcRef.screenshot.artifactId !== b.artifactId || ref?.screenshot.status !== 'captured' || !ref.screenshot.artifactId) {
    return unavailable('failed', 'artifact-missing', '操作前の画面の参照先の画像を取り込めなかった');
  }
  return { status: 'captured', artifactId: ref.screenshot.artifactId, capturedAt: b.capturedAt, refStepId: newRef, basis: b.basis };
}

/** 手順のコピー計画を作る（保存はしない）。範囲外のエラーは Error を投げる。 */
export function planStepCopy(source: CopySource, target: CopyTarget, opts: CopyOptions): CopyPlan {
  const warnings: string[] = [IMPORT_RESEARCH_DATA_WARNING];
  const srcOrdered = orderedSteps(source.steps);
  let picked = srcOrdered;
  if (opts.stepIds) {
    const want = new Set(opts.stepIds);
    for (const id of want) if (!srcOrdered.some((s) => s.id === id)) throw new Error(`取り込み元に手順が見つからない: ${id}`);
    picked = srcOrdered.filter((s) => want.has(s.id));
  }
  const tgtGroups: StepGroup[] = [...(target.scenario.groups ?? [])].map((g) => ({ ...g }));
  if (opts.newGroupParentId && !tgtGroups.some((g) => g.id === opts.newGroupParentId)) throw new Error('取り込み先の親グループが見つからない');

  // グループ: 取り込む手順が属するグループとその祖先をコピーする
  let rootParent: string | null = opts.newGroupParentId ?? null;
  const appendGroup = (name: string, parentId: string | null): StepGroup => {
    const order = childGroups(tgtGroups, parentId).reduce((m, g, i) => Math.max(m, g.order ?? i), -1) + 1;
    const g: StepGroup = { id: newId('grp'), name, parentId, order };
    tgtGroups.push(g);
    return g;
  };
  if (opts.newGroupName?.trim()) rootParent = appendGroup(opts.newGroupName.trim(), rootParent).id;
  const groupMap = new Map<string, string>();
  const srcGroups = source.scenario.groups ?? [];
  if (validateGroups(srcGroups).length) warnings.push('取り込み元のグループ構成に問題があるため、一部のグループは最上位として取り込んだ');
  for (const s of picked) {
    for (const g of groupPath(srcGroups, s.groupId)) {
      if (groupMap.has(g.id)) continue;
      const parent = g.parentId && groupMap.has(g.parentId) ? groupMap.get(g.parentId)! : rootParent;
      groupMap.set(g.id, appendGroup(g.name, parent).id);
    }
  }

  const batch = newId('imp');
  const seq0 = nextSeqOf(target.steps);
  const order0 = nextOrderOf(target.steps);
  const artById = new Map(source.artifacts.map((a) => [a.id, a]));
  const idMap: Record<string, string> = {};
  const steps: Step[] = [];
  const artifacts: Artifact[] = [];
  picked.forEach((src, i) => {
    const id = newId('stp');
    idMap[src.id] = id;
    const st = clone(src);
    st.schemaVersion = SCHEMA_VERSION;
    st.id = id;
    st.scenarioId = target.scenario.id;
    st.sessionId = batch;
    st.seq = seq0 + i;
    st.order = order0 + i;
    st.origin = 'imported';
    st.operationAt = opts.now;
    delete st.operationEndAt;
    delete st.humanConfirmedAt;
    st.importedFrom = {
      source: source.kind, scenarioId: source.scenario.id, scenarioName: source.scenario.name, stepId: src.id, seq: src.seq,
      operationAt: src.operationAt, operationEndAt: src.operationEndAt, humanConfirmedAt: src.humanConfirmedAt, importedAt: opts.now,
    };
    st.limitations = [...(st.limitations ?? []), { code: 'imported', message: '取り込んだ手順。画面変化の観測・画像・DOM の時刻は取り込み元の記録時のもの（operationAt は取り込んだ時刻）' }];
    if (src.groupId && groupMap.has(src.groupId)) st.groupId = groupMap.get(src.groupId);
    else if (rootParent) st.groupId = rootParent;
    else delete st.groupId;

    for (const [field, type, label] of [['screenshot', 'screenshot', '画面'], ['dom', 'dom', 'DOM']] as const) {
      const ref = src[field];
      if (!opts.copyArtifacts) { st[field] = notImported(ref, label); continue; }
      if (ref.status !== 'captured') continue;
      const a = ref.artifactId ? artById.get(ref.artifactId) : undefined;
      if (!a) { st[field] = { status: 'failed', reasonCode: 'artifact-missing', reason: `取り込み元に${label}のデータが見つからない` }; continue; }
      const nid = `${type === 'screenshot' ? 'shot' : 'dom'}_${id}`;
      artifacts.push({ ...a, id: nid, scenarioId: target.scenario.id, stepId: id, masks: a.masks ? a.masks.map((m) => ({ ...m })) : a.masks, formState: a.formState ? clone(a.formState) : a.formState, meta: a.meta ? clone(a.meta) : a.meta });
      st[field] = { status: 'captured', artifactId: nid };
    }
    // 押下時の画面（任意）。コピーしない・見つからない場合は、取り込み元を指したまま残さず理由つきの未取得にする
    const ps = src.pressScreenshot;
    if (ps?.status === 'captured') {
      const a = ps.artifactId ? artById.get(ps.artifactId) : undefined;
      if (!opts.copyArtifacts) st.pressScreenshot = { ...ps, status: 'skipped', artifactId: undefined, reasonCode: 'not-imported', reason: '取り込み時に押下時の画面をコピーしなかった' };
      else if (!a) st.pressScreenshot = { ...ps, status: 'failed', artifactId: undefined, reasonCode: 'artifact-missing', reason: '取り込み元に押下時の画面のデータが見つからない' };
      else {
        const nid = `press_${id}`;
        artifacts.push({ ...a, id: nid, scenarioId: target.scenario.id, stepId: id, masks: a.masks ? a.masks.map((m) => ({ ...m })) : a.masks, meta: a.meta ? clone(a.meta) : a.meta });
        st.pressScreenshot = { ...ps, artifactId: nid, notes: ps.notes ? [...ps.notes] : ps.notes };
      }
    } else if (ps?.status === 'pending') st.pressScreenshot = { ...ps, status: 'skipped', reasonCode: 'not-captured', reason: '取り込み元で取得が完了していなかった' };
    steps.push(st);
  });

  // 操作前の画面の参照（beforeScreenshot）を、取り込んだ手順・成果物に付け替える。
  // 参照先が取り込み対象にない・画像をコピーしない場合は、取り込み元を指したまま残さず理由つきの未取得にする。
  const srcById = new Map(source.steps.map((s) => [s.id, s]));
  const stepById = new Map(steps.map((s) => [s.id, s]));
  for (const st of steps) {
    const b = st.beforeScreenshot;
    if (!b) continue;
    st.beforeScreenshot = remapBeforeScreenshot(b, { idMap, copyArtifacts: opts.copyArtifacts, srcById, stepById });
  }

  // 変数: コピーした値テンプレートで使う変数を、取り込み先に無ければ追加する
  const variables = [...(target.scenario.variables ?? [])];
  const srcVars = new Map((source.scenario.variables ?? []).map((v) => [v.name, v]));
  const undefinedNames: string[] = [];
  for (const s of steps) for (const n of extractVariableNames(s.replay?.valueTemplate)) {
    if (variables.some((v) => v.name === n)) continue;
    const sv = srcVars.get(n);
    if (sv) variables.push({ ...sv, id: newId('var') });
    else if (!undefinedNames.includes(n)) undefinedNames.push(n);
  }
  if (undefinedNames.length) warnings.push(`値テンプレートで使われているが定義のない変数: ${undefinedNames.join(', ')}`);
  return { steps, artifacts, groups: tgtGroups, variables: sanitizeVariables(variables), idMap, warnings };
}

async function writePlan(scenarioId: string, build: (scenario: Scenario, steps: Step[]) => CopyPlan): Promise<CopyPlan> {
  const tx = (await db()).transaction(['scenarios', 'steps', 'artifacts'], 'readwrite');
  const scenario: Scenario | undefined = await tx.objectStore('scenarios').get(scenarioId);
  if (!scenario) { await tx.done; throw new Error('取り込み先のシナリオが見つからない'); }
  const existing: Step[] = await tx.objectStore('steps').index('scenarioId').getAll(IDBKeyRange.only(scenarioId));
  let plan: CopyPlan;
  try { plan = build({ ...scenario, groups: scenario.groups ?? [], variables: scenario.variables ?? [] }, existing); } catch (e) { tx.abort(); await tx.done.catch(() => undefined); throw e; }
  for (const s of plan.steps) await tx.objectStore('steps').add(s);
  for (const a of plan.artifacts) await tx.objectStore('artifacts').put(a);
  await tx.objectStore('scenarios').put(sanitizeScenarioForSave({ ...scenario, groups: plan.groups, variables: plan.variables, updatedAt: new Date().toISOString() }));
  await tx.done;
  return plan;
}

/**
 * 同じ DB 内のシナリオ（同じシナリオでもよい）から手順をコピーする。1 トランザクションで書き込む。
 * 記録中・再生中のシナリオへは取り込まない前提（seq の採番が衝突するため。呼び出し側で防ぐ）。
 */
export async function importStepsFromScenario(args: { sourceScenarioId: string; targetScenarioId: string } & Omit<CopyOptions, 'now'> & { now?: ISO }): Promise<CopyPlan> {
  const d = await db();
  const src: Scenario | undefined = await d.get('scenarios', args.sourceScenarioId);
  if (!src) throw new Error('取り込み元のシナリオが見つからない');
  const srcSteps: Step[] = await d.getAllFromIndex('steps', 'scenarioId', args.sourceScenarioId);
  const srcArts: Artifact[] = args.copyArtifacts ? await d.getAllFromIndex('artifacts', 'scenarioId', args.sourceScenarioId) : [];
  const now = args.now ?? new Date().toISOString();
  return writePlan(args.targetScenarioId, (scenario, steps) => planStepCopy(
    { kind: 'scenario', scenario: { id: src.id, name: src.name, groups: src.groups ?? [], variables: src.variables ?? [] }, steps: srcSteps, artifacts: srcArts },
    { scenario, steps }, { ...args, now },
  ));
}

// ---- (b) 出力 ZIP の取り込み --------------------------------------------------------

export const ZIP_IMPORT_LIMITS = Object.freeze({ maxFiles: 20_000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 });

export interface ScenarioDraft {
  sourceScenarioId: string;
  name: string;
  purpose: string;
  preconditions: string;
  expectedResult: string;
  openQuestions: string;
  groups: StepGroup[];
  variables: ScenarioVariable[];
  schemaVersion: number;
  exportedAt?: string;
  toolVersion?: string;
}

export type ParsedExport =
  | { ok: true; scenarioDraft: ScenarioDraft; steps: Step[]; images: Artifact[]; doms: Artifact[]; warnings: string[] }
  | { ok: false; reason: string };

const KINDS = new Set(Object.keys(KIND_LABEL) as StepKind[]);
const PHASES = new Set<ArtifactPhase>(['session-start', 'at-operation', 'after-operation', 'after-load', 'manual', 'session-end']);
const DOM_HEADER = /^<!-- TraceLens DOM snapshot[^\n]*-->\n/;
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined);
const arr = <T = any>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function captureFrom(info: Record<string, any> | undefined, label: string): CaptureStatus {
  const status = str(info?.status);
  const reason = str(info?.reason) || undefined;
  if (status === 'excluded-from-export') return { status: 'skipped', reasonCode: 'excluded-from-export', reason: reason ?? `出力時に${label}を対象外にしていた` };
  if (status === 'failed' || status === 'skipped') return { status, reason: reason ?? '理由の記載なし（出力ZIPに記載がない）' };
  if (status === 'not-applicable') return { status: 'not-applicable', reason };
  if (status === 'pending') return { status: 'failed', reasonCode: 'pending-at-export', reason: '出力時点で取得待ちだった' };
  return { status: 'failed', reasonCode: 'missing-in-zip', reason: `出力ZIPに${label}のファイルがない` };
}

function elementFrom(rec: Record<string, any>, full: Record<string, any> | undefined): ElementInfo | undefined {
  if (full) return full as unknown as ElementInfo;
  const t = obj(rec.target);
  if (!t) return undefined;
  return {
    tag: str(t.tag), id: t.id ?? undefined, name: t.name ?? undefined, type: t.type ?? undefined,
    role: obj(t.role) ? (t.role as ElementInfo['role']) : { value: null, source: 'none' },
    nameCandidates: arr(t.nameCandidates), nameMethodNote: str(t.nameMethodNote), labels: [], state: {},
    rect: obj(t.rectAtOperation) ? (t.rectAtOperation as ElementInfo['rect']) : { x: 0, y: 0, width: 0, height: 0 },
    attributes: {}, selectors: arr(t.selectorCandidates), surroundingHtml: '', surroundingTruncated: false,
    shadowPath: arr(t.shadowPath), hints: [],
  };
}

/**
 * TraceLens の出力 ZIP を読む（保存はしない）。schemaVersion が未知なら理由つきで拒否する。
 * 出力時に除外・取得失敗だった成果物（path が null）は未取得として扱う。
 * 値に {{名前}} が含まれる手順は replay.valueTemplate に設定し、変数として登録する。
 */
export function parseExportZip(bytes: Uint8Array): ParsedExport {
  let files: Record<string, Uint8Array>;
  let count = 0, total = 0, tooBig = '';
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        count++; total += f.originalSize;
        if (f.originalSize > ZIP_IMPORT_LIMITS.maxFileBytes) { tooBig = `ファイルが大きすぎる: ${f.name}`; return false; }
        if (count > ZIP_IMPORT_LIMITS.maxFiles) { tooBig = 'ファイル数が多すぎる'; return false; }
        if (total > ZIP_IMPORT_LIMITS.maxTotalBytes) { tooBig = '展開後の合計サイズが大きすぎる'; return false; }
        return true;
      },
    });
  } catch (e) { return { ok: false, reason: `ZIP として読めない: ${(e as Error).message}` }; }
  if (tooBig) return { ok: false, reason: `取り込めない ZIP: ${tooBig}` };

  const stepsPath = Object.keys(files).filter((p) => p === 'steps.json' || /^[^/]+\/steps\.json$/.test(p)).sort((a, b) => a.length - b.length)[0];
  if (!stepsPath) return { ok: false, reason: 'steps.json が見つからない（TraceLens の出力 ZIP ではない可能性がある）' };
  const root = stepsPath.slice(0, -'steps.json'.length);
  const read = (p: string | null | undefined): Uint8Array | undefined => (p && !p.includes('..') ? files[root + p] : undefined);
  const readJson = (p: string | null | undefined): any => { const b = read(p); if (!b) return undefined; try { return JSON.parse(strFromU8(b)); } catch { return undefined; } };

  const sj = readJson('steps.json');
  if (!obj(sj)) return { ok: false, reason: 'steps.json を JSON として読めない' };
  const ver = sj.schemaVersion;
  if (typeof ver !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.includes(ver)) return { ok: false, reason: `未対応の schemaVersion: ${String(ver)}（このバージョンの TraceLens が読めるのは ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}）` };
  const manifest = obj(readJson('manifest.json'));

  const warnings: string[] = [IMPORT_RESEARCH_DATA_WARNING];
  if (ver < SCHEMA_VERSION) warnings.push(`schemaVersion ${ver} の出力のため、グループの入れ子・変数・再生設定は含まれていない`);
  warnings.push('置換ルールで置き換えた値は置き換え後の表記（{{名前}} など）のまま取り込む。置換前の値は ZIP に含まれていないため復元しない。');

  // グループ
  const groups: StepGroup[] = [];
  const groupIdSet = new Set<string>();
  for (const g of arr(sj.groups)) {
    const o = obj(g);
    if (!o || typeof o.id !== 'string' || groupIdSet.has(o.id)) continue;
    groupIdSet.add(o.id);
    groups.push({ id: o.id, name: str(o.name, '(名称なし)') || '(名称なし)', parentId: typeof o.parentId === 'string' ? o.parentId : null, order: typeof o.order === 'number' ? o.order : undefined });
  }
  for (const g of groups) if (g.parentId && !groupIdSet.has(g.parentId)) g.parentId = null;
  if (validateGroups(groups).some((e) => e.includes('循環'))) { warnings.push('グループの親子関係が循環していたため、入れ子を解除した'); for (const g of groups) g.parentId = null; }
  const groupByName = new Map<string, string>();

  // 変数
  const variables: ScenarioVariable[] = [];
  for (const v of arr(sj.variables)) {
    const o = obj(v);
    if (!o || typeof o.name !== 'string' || !validateVariableName(o.name).ok || variables.some((x) => x.name === o.name)) continue;
    variables.push({ id: newId('var'), name: o.name, description: str(o.description) || undefined, secret: !!o.secret, defaultValue: !o.secret && typeof o.defaultValue === 'string' ? o.defaultValue : undefined });
  }

  const steps: Step[] = [];
  const images: Artifact[] = [];
  const doms: Artifact[] = [];
  let skippedKinds = 0;
  const templated: number[] = [];
  for (const raw of arr(sj.steps)) {
    const rec = obj(raw);
    if (!rec || typeof rec.id !== 'string' || typeof rec.seq !== 'number') { skippedKinds++; continue; }
    if (!KINDS.has(rec.kind)) { skippedKinds++; continue; }
    const time = obj(rec.time) ?? {};
    const arts = obj(rec.artifacts) ?? {};
    const sh = obj(arts.screenshot), dm = obj(arts.dom), el = obj(arts.element);
    const elementFile = obj(readJson(el?.path));
    const page = obj(rec.page) ?? {};
    const frame = obj(rec.frame) ?? {};
    const step: Step = {
      schemaVersion: SCHEMA_VERSION, id: rec.id, scenarioId: str(sj.scenarioId), sessionId: str(rec.sessionId, 'imported'), seq: rec.seq, kind: rec.kind,
      operationAt: str(time.operationAt), operationEndAt: str(time.operationEndAt) || undefined,
      page: { url: str(page.url), title: str(page.title), viewport: page.viewport ?? undefined },
      frame: { isTop: frame.isTop !== false, path: arr(frame.path), url: str(frame.url), browserFrameId: frame.browserFrameId ?? undefined },
      target: elementFrom(rec, obj(elementFile?.element)),
      value: obj(rec.value) as Step['value'], key: obj(rec.key) as Step['key'], navigation: obj(rec.navigation) as Step['navigation'], notice: obj(rec.notice) as Step['notice'],
      observations: arr(time.screenChangeObservations),
      screenshot: { status: 'pending' }, dom: { status: 'pending' },
      elementCapture: elementFile ? { status: 'captured' }
        : rec.target ? { status: 'failed', reasonCode: 'partial-element', reason: '要素の詳細ファイルが ZIP になく、steps.json の要約だけを取り込んだ' }
        : el?.path ? { status: 'failed', reasonCode: 'missing-in-zip', reason: '出力ZIPに要素情報のファイルがない' }
        : el?.status === 'failed' || el?.status === 'skipped' ? captureFrom(el, '要素情報') : { status: 'not-applicable' },
      limitations: arr(rec.limitations),
      humanConfirmedAt: str(time.humanConfirmedAt) || undefined,
      annotation: { ...emptyAnnotation(), ...(obj(rec.annotation) ?? {}), conditions: arr(obj(rec.annotation)?.conditions) },
      includeInExport: true,
      replay: obj(rec.replay) ? clone(rec.replay) : undefined,
      order: typeof rec.order === 'number' ? rec.order : undefined,
      ...(obj(rec.prefill) ? { prefill: { autofill: obj(rec.prefill)!.autofill === true } } : {}),
    };

    // グループ
    if (typeof rec.groupId === 'string' && groupIdSet.has(rec.groupId)) step.groupId = rec.groupId;
    else if (typeof rec.group === 'string' && rec.group) {
      let gid = groupByName.get(rec.group) ?? groups.find((g) => g.name === rec.group && !g.parentId)?.id;
      if (!gid) { gid = newId('grp'); groups.push({ id: gid, name: rec.group, parentId: null }); groupIdSet.add(gid); }
      groupByName.set(rec.group, gid);
      step.groupId = gid;
    }

    // 画面
    const shotBytes = read(sh?.path);
    if (sh?.path && shotBytes) {
      const aid = `shot_${rec.id}`;
      images.push({
        id: aid, scenarioId: step.scenarioId, stepId: rec.id, type: 'screenshot', capturedAt: str(sh.capturedAt), phase: PHASES.has(sh.phase) ? sh.phase : 'after-operation', includeInExport: true,
        blob: new Blob([shotBytes as BlobPart], { type: 'image/png' }),
        // 塗りつぶしは出力時に画素へ焼き込み済み。再度の塗りつぶし指定はない
        masks: [], meta: { viewport: sh.viewport ?? undefined, targetRectAtCapture: obj(sh.targetRectAtCapture) ? (sh.targetRectAtCapture as Rect) : null, targetRectNote: str(sh.targetRectNote) || undefined, timingNote: str(sh.timingNote) || undefined },
      });
      step.screenshot = { status: 'captured', artifactId: aid };
    } else step.screenshot = sh?.path ? { status: 'failed', reasonCode: 'missing-in-zip', reason: '出力ZIPに画面のファイルがない' } : captureFrom(sh, '画面');

    // 押下時の画面（任意）
    const pr = obj(arts.pressScreenshot);
    if (pr) {
      const times = { pressAt: str(pr.pressAt) || undefined, captureStartedAt: str(pr.captureStartedAt) || undefined, capturedAt: str(pr.capturedAt) || undefined };
      const prBytes = read(pr.path);
      if (pr.path && prBytes) {
        const aid = `press_${rec.id}`;
        images.push({
          id: aid, scenarioId: step.scenarioId, stepId: rec.id, type: 'screenshot', capturedAt: str(pr.capturedAt), phase: 'at-press', includeInExport: true,
          blob: new Blob([prBytes as BlobPart], { type: 'image/png' }), masks: [],
          meta: { viewport: pr.viewport ?? undefined, targetRectAtCapture: obj(pr.targetRectAtCapture) ? (pr.targetRectAtCapture as Rect) : null, targetRectNote: str(pr.targetRectNote) || undefined, timingNote: arr<string>(pr.notes).join(' / ') || undefined },
        });
        step.pressScreenshot = { status: 'captured', artifactId: aid, ...times, notes: arr<string>(pr.notes) };
      } else step.pressScreenshot = pr.path ? { status: 'failed', reasonCode: 'missing-in-zip', reason: '出力ZIPに押下時の画面のファイルがない', ...times } : { ...captureFrom(pr, '押下時の画面'), ...times };
    }

    // DOM
    const domBytes = read(dm?.path);
    if (dm?.path && domBytes) {
      const aid = `dom_${rec.id}`;
      const fs = obj(readJson(dm.formStatePath));
      doms.push({
        id: aid, scenarioId: step.scenarioId, stepId: rec.id, type: 'dom', capturedAt: str(dm.capturedAt), phase: PHASES.has(dm.phase) ? dm.phase : 'at-operation', includeInExport: true,
        html: strFromU8(domBytes).replace(DOM_HEADER, ''), formState: arr<FormStateEntry>(fs?.controls), truncated: !!dm.truncated, frameUrl: str(fs?.frameUrl) || undefined,
        ...(obj(dm.boxViewport) ? { boxViewport: clone(dm.boxViewport) } : {}),
      });
      step.dom = { status: 'captured', artifactId: aid };
    } else step.dom = dm?.path ? { status: 'failed', reasonCode: 'missing-in-zip', reason: '出力ZIPに DOM のファイルがない' } : captureFrom(dm, 'DOM');

    // {{名前}} を含む値は値テンプレートにする
    const v = step.value;
    const candidate = v?.kind === 'text' ? v.text : v?.kind === 'select' ? v.selectedOptions?.[0]?.value : undefined;
    if (candidate && extractVariableNames(candidate).length && step.replay?.valueTemplate === undefined && !v?.redacted) {
      step.replay = { ...(step.replay ?? {}), valueTemplate: candidate };
      templated.push(step.seq);
    }
    for (const n of extractVariableNames(step.replay?.valueTemplate)) if (!variables.some((x) => x.name === n)) variables.push({ id: newId('var'), name: n });
    steps.push(step);
  }
  if (!steps.length) return { ok: false, reason: '取り込める手順がない' };
  if (skippedKinds) warnings.push(`読めない手順 ${skippedKinds} 件を取り込まなかった`);
  if (templated.length) warnings.push(`値に {{名前}} を含む手順（${templated.join(', ')}）は値テンプレートとして設定し、変数を登録した`);
  const excludedSeqs = arr<number>(manifest?.excludedStepSeqs);
  if (excludedSeqs.length) warnings.push(`出力時に対象外だった手順（${excludedSeqs.join(', ')}）は ZIP に含まれていない`);

  const sc = obj(sj.scenario) ?? {};
  const scenarioDraft: ScenarioDraft = {
    sourceScenarioId: str(sj.scenarioId), name: str(sc.name) || str(obj(manifest?.scenario)?.name) || '取り込んだシナリオ',
    purpose: str(sc.purpose), preconditions: str(sc.preconditions), expectedResult: str(sc.expectedResult), openQuestions: str(sc.openQuestions),
    groups, variables: sanitizeVariables(variables), schemaVersion: ver, exportedAt: str(manifest?.exportedAt) || undefined, toolVersion: str(manifest?.toolVersion) || undefined,
  };
  return { ok: true, scenarioDraft, steps, images, doms, warnings };
}

/** 取り込んだ ZIP から新しいシナリオを作る（保存は呼び出し側。手順は importParsedExport で入れる） */
export function scenarioFromDraft(projectId: string, draft: ScenarioDraft, now: ISO): Scenario {
  return {
    schemaVersion: SCHEMA_VERSION, id: newId('scn'), projectId, name: draft.name, purpose: draft.purpose, preconditions: draft.preconditions, expectedResult: draft.expectedResult, openQuestions: draft.openQuestions,
    createdAt: now, updatedAt: now, sessions: [], groups: [], replacementRules: [], variables: [],
  };
}

/** 出力 ZIP の取り込みの計画（純粋）。planStepCopy と同じ規則で再採番する。 */
export function planExportImport(parsed: Extract<ParsedExport, { ok: true }>, target: CopyTarget, opts: Omit<CopyOptions, 'stepIds'>): CopyPlan {
  const d = parsed.scenarioDraft;
  const plan = planStepCopy({ kind: 'export-zip', scenario: { id: d.sourceScenarioId, name: d.name, groups: d.groups, variables: d.variables }, steps: parsed.steps, artifacts: [...parsed.images, ...parsed.doms] }, target, opts);
  // ZIP 側で定義されていた変数は、使われていなくても取り込む
  const vars = [...plan.variables];
  for (const v of d.variables) if (!vars.some((x) => x.name === v.name)) vars.push({ ...v, id: newId('var') });
  plan.variables = sanitizeVariables(vars);
  plan.warnings = [...new Set([...parsed.warnings, ...plan.warnings])];
  return plan;
}

/** 出力 ZIP から読んだ手順を、指定したシナリオへ取り込む（1 トランザクション） */
export async function importParsedExport(targetScenarioId: string, parsed: Extract<ParsedExport, { ok: true }>, opts: Omit<CopyOptions, 'stepIds' | 'now'> & { now?: ISO }): Promise<CopyPlan> {
  const now = opts.now ?? new Date().toISOString();
  return writePlan(targetScenarioId, (scenario, steps) => planExportImport(parsed, { scenario, steps }, { ...opts, now }));
}
