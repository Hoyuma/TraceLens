// 単体テスト用の模擬データ（実在の業務データは使わない）
import { SCHEMA_VERSION, emptyAnnotation, type Artifact, type ElementInfo, type Project, type Scenario, type SelectorCandidate, type Step } from '../../src/shared/types';

export function element(selectors: Partial<SelectorCandidate>[] = [], over: Partial<ElementInfo> = {}): ElementInfo {
  return {
    tag: 'input', role: { value: 'textbox', source: 'implicit-heuristic' }, nameCandidates: [{ source: 'label', value: '氏名' }], nameMethodNote: '簡易推定', labels: ['氏名'], state: {},
    rect: { x: 1, y: 2, width: 3, height: 4 }, attributes: {}, surroundingHtml: '<input>', surroundingTruncated: false, shadowPath: [], hints: [],
    selectors: selectors.map((s, i) => ({ kind: 'css-path', selector: `#s${i}`, language: 'css', matchCount: 1, scope: 'document', stability: 'unverified', stabilityNote: '', ...s })),
    ...over,
  };
}

export function mkStep(seq: number, over: Partial<Step> = {}, scenarioId = 'scn_1'): Step {
  const id = over.id ?? `stp_${scenarioId}_${String(seq).padStart(3, '0')}`;
  return {
    schemaVersion: SCHEMA_VERSION, id, scenarioId, sessionId: 'ses_1', seq, kind: 'click',
    operationAt: `2026-11-16T10:00:${String(seq % 60).padStart(2, '0')}.000Z`, page: { url: 'https://example.test/app', title: 'app' },
    frame: { isTop: true, path: [], url: 'https://example.test/app' }, observations: [],
    screenshot: { status: 'captured', artifactId: `shot_${id}` }, dom: { status: 'captured', artifactId: `dom_${id}` },
    elementCapture: { status: 'captured' }, limitations: [], annotation: emptyAnnotation(), includeInExport: true,
    target: element([{ selector: `#el${seq}` }]),
    ...over,
  };
}

export function mkArtifacts(s: Step, html = '<html><body>ok</body></html>'): Artifact[] {
  return [
    { id: `shot_${s.id}`, scenarioId: s.scenarioId, stepId: s.id, type: 'screenshot', capturedAt: '2026-11-16T10:00:59.500Z', phase: 'after-operation', includeInExport: true, blob: new Blob(['ORIGINAL-IMAGE' + s.id]), masks: [], meta: { targetRectAtCapture: null } },
    { id: `dom_${s.id}`, scenarioId: s.scenarioId, stepId: s.id, type: 'dom', capturedAt: s.operationAt, phase: 'at-operation', includeInExport: true, html, formState: [], frameUrl: 'https://example.test/app' },
  ];
}

export function mkScenario(id = 'scn_1', over: Partial<Scenario> = {}): Scenario {
  return { schemaVersion: SCHEMA_VERSION, id, projectId: 'prj_1', name: '登録', purpose: '', preconditions: '', expectedResult: '', openQuestions: '', createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z', sessions: [], groups: [], replacementRules: [], ...over };
}

export function mkProject(id = 'prj_1'): Project {
  return { schemaVersion: SCHEMA_VERSION, id, name: '調査', description: '', createdAt: '2026-11-16T00:00:00.000Z' };
}

export const renderStub = async (_b: Blob, masks: unknown[]) => new TextEncoder().encode(`RENDERED:${masks.length}`);
