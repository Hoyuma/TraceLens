// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { addStep, getScenario, listArtifacts, listSteps, putArtifact, putScenario } from '../../src/shared/db';
import { buildExport, zipExport } from '../../src/shared/export';
import { importParsedExport, importStepsFromScenario, parseExportZip, planStepCopy, scenarioFromDraft } from '../../src/shared/importScenario';
import { groupPathNames } from '../../src/shared/groups';
import { emptyAnnotation, type Artifact, type StepGroup } from '../../src/shared/types';
import { element, mkArtifacts, mkProject, mkScenario, mkStep, renderStub } from './fixtures';

const NOW = '2026-11-17T09:00:00.000Z';

async function seedSource() {
  const groups: StepGroup[] = [{ id: 'gA', name: '親', parentId: null }, { id: 'gB', name: '子', parentId: 'gA' }];
  await putScenario(mkScenario('src', { name: '元シナリオ', groups, variables: [{ id: 'v1', name: '氏名', defaultValue: '佐藤' }] }));
  const steps = [
    mkStep(1, { groupId: 'gB', kind: 'input', value: { kind: 'text', text: 'x' }, replay: { valueTemplate: '{{氏名}}' }, humanConfirmedAt: '2026-11-16T10:00:09.000Z' }, 'src'),
    mkStep(2, { groupId: 'gA' }, 'src'),
    mkStep(3, {}, 'src'),
  ];
  for (const s of steps) { await addStep(s); for (const a of mkArtifacts(s)) await putArtifact(a); }
  return steps;
}

describe('取り込み (a): シナリオ間のコピー', () => {
  it('ID を再採番し、seq は取り込み先の最大 + 1 から、成果物 ID は shot_/dom_<新ID>、グループ階層もコピーする', async () => {
    const src = await seedSource();
    await putScenario(mkScenario('dst', { groups: [{ id: 'gX', name: '既存', parentId: null }] }));
    for (const s of [mkStep(1, {}, 'dst'), mkStep(5, {}, 'dst')]) await addStep(s);

    const plan = await importStepsFromScenario({ sourceScenarioId: 'src', targetScenarioId: 'dst', stepIds: [src[0].id, src[1].id], newGroupName: '取り込み', newGroupParentId: 'gX', copyArtifacts: true, now: NOW });
    const dst = await listSteps('dst');
    const imported = dst.filter((s) => s.origin === 'imported');
    expect(imported.map((s) => s.seq)).toEqual([6, 7]);
    expect(dst.filter((s) => s.origin === 'recorded').map((s) => s.seq)).toEqual([1, 5]); // 既存の seq は変えない
    for (const s of imported) {
      expect(src.some((x) => x.id === s.id)).toBe(false);
      expect(s.scenarioId).toBe('dst');
      expect(s.operationAt).toBe(NOW);
      expect(s.humanConfirmedAt).toBeUndefined();
      expect(s.screenshot).toEqual({ status: 'captured', artifactId: `shot_${s.id}` });
      expect(s.dom).toEqual({ status: 'captured', artifactId: `dom_${s.id}` });
    }
    expect(imported[0].importedFrom).toMatchObject({ source: 'scenario', scenarioId: 'src', scenarioName: '元シナリオ', stepId: src[0].id, seq: 1, operationAt: src[0].operationAt, humanConfirmedAt: '2026-11-16T10:00:09.000Z' });
    const arts = await listArtifacts('dst');
    expect(arts.map((a) => a.id).sort()).toEqual(imported.flatMap((s) => [`dom_${s.id}`, `shot_${s.id}`]).sort());
    expect(arts.every((a) => a.stepId === a.id.replace(/^(shot|dom)_/, ''))).toBe(true);
    const sc = (await getScenario('dst'))!;
    expect(groupPathNames(sc.groups, imported[0].groupId)).toEqual(['既存', '取り込み', '親', '子']);
    expect(groupPathNames(sc.groups, imported[1].groupId)).toEqual(['既存', '取り込み', '親']);
    expect(sc.variables!.map((v) => v.name)).toEqual(['氏名']);
    expect(plan.warnings[0]).toContain('調査データ');
    // 取り込み元は変わらない
    expect((await listSteps('src')).map((s) => [s.id, s.seq, s.scenarioId])).toEqual(src.map((s) => [s.id, s.seq, 'src']));
  });

  it('成果物をコピーしない場合は、未取得として理由を残す。同じシナリオへの複製もできる', async () => {
    const src = await listSteps('src');
    await importStepsFromScenario({ sourceScenarioId: 'src', targetScenarioId: 'src', stepIds: [src[2].id], copyArtifacts: false, now: NOW });
    const after = await listSteps('src');
    const dup = after.find((s) => s.origin === 'imported')!;
    expect(dup.seq).toBe(4);
    expect(dup.screenshot).toMatchObject({ status: 'skipped', reasonCode: 'not-imported' });
    expect(dup.dom.reason).toBeTruthy();
    expect((await listArtifacts('src')).some((a) => a.stepId === dup.id)).toBe(false);
  });

  it('planStepCopy は取り込み元に無い手順 ID を拒否する', () => {
    expect(() => planStepCopy({ kind: 'scenario', scenario: { id: 's', name: 's', groups: [] }, steps: [], artifacts: [] }, { scenario: mkScenario('t'), steps: [] }, { stepIds: ['nope'], copyArtifacts: false, now: NOW })).toThrow('見つからない');
  });
});

describe('取り込み (b): 出力 ZIP', () => {
  const SECRET = '山田 太郎';
  async function makeZip() {
    const groups: StepGroup[] = [{ id: 'g1', name: '登録', parentId: null }, { id: 'g2', name: '明細', parentId: 'g1' }];
    const s1 = mkStep(1, { kind: 'input', groupId: 'g2', value: { kind: 'text', text: SECRET }, annotation: { ...emptyAnnotation(), note: `入力 ${SECRET}` },
      target: element([{ selector: '#name', matchCount: 1 }, { selector: '//input', language: 'xpath', matchCount: 2 }], { shadowPath: [{ hostSelector: 'x-form', mode: 'open' }] }),
      frame: { isTop: false, path: [{ index: 0, selector: 'iframe#f', crossOrigin: false }], url: 'https://example.test/frame' } });
    const s2 = mkStep(2, { kind: 'input', value: { kind: 'redacted', redacted: true, redactionReason: '機密欄' } });
    const s3 = mkStep(3, { kind: 'click', replay: { wait: { kind: 'text-present', value: '保存しました' } } });
    const s4 = mkStep(4, { includeInExport: false });
    const steps = [s1, s2, s3, s4];
    const arts: Artifact[] = steps.flatMap((s) => mkArtifacts(s, `<p>${SECRET}</p>`));
    arts.find((a) => a.id === `shot_${s3.id}`)!.includeInExport = false; // 成果物の除外 → path null
    const r = await buildExport({ project: mkProject(), scenario: mkScenario('scn_1', { groups, name: '元', purpose: '調査目的' }), steps, artifacts: arts, rules: [{ id: 'r', find: SECRET, replaceWith: '{{氏名}}', enabled: true }], exportedAt: NOW, toolVersion: '0.2.0', renderImage: renderStub });
    expect(r.residualValues).toEqual([]);
    return { zip: zipExport(r), steps };
  }

  it('出力 → 取り込みの往復で、セレクター・フレーム・Shadow DOM 経路・値・グループを復元し、置換前の値は混入しない', async () => {
    const { zip, steps } = await makeZip();
    const p = parseExportZip(zip);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.steps.map((s) => s.seq)).toEqual([1, 2, 3]); // 除外した手順は含まれない
    const [a, b, c] = p.steps;
    expect(a.target!.selectors.map((x) => x.selector)).toEqual(['#name', '//input']);
    expect(a.target!.shadowPath).toEqual([{ hostSelector: 'x-form', mode: 'open' }]);
    expect(a.frame.path).toEqual([{ index: 0, selector: 'iframe#f', crossOrigin: false }]);
    expect(a.value).toEqual({ kind: 'text', text: '{{氏名}}' });
    expect(a.replay!.valueTemplate).toBe('{{氏名}}');
    expect(p.scenarioDraft.variables.map((v) => v.name)).toEqual(['氏名']);
    expect(groupPathNames(p.scenarioDraft.groups, a.groupId)).toEqual(['登録', '明細']);
    expect(b.value).toMatchObject({ kind: 'redacted' });
    expect(b.replay?.valueTemplate).toBeUndefined();
    expect(c.replay!.wait).toEqual({ kind: 'text-present', value: '保存しました' });
    expect(c.screenshot).toMatchObject({ status: 'skipped', reasonCode: 'excluded-from-export' });
    expect(c.dom.status).toBe('captured');
    expect(p.scenarioDraft).toMatchObject({ name: '元', purpose: '調査目的', schemaVersion: 2 });
    expect(p.warnings.join('\n')).toContain('調査データ');
    expect(p.warnings.join('\n')).toContain('出力時に対象外だった手順（4）');
    // 画像は再エンコード済みの出力そのもの（原本は ZIP に無い）
    expect(await p.images[0].blob!.text()).toBe('RENDERED:0');
    expect(p.doms[0].html).toBe('<p>{{氏名}}</p>');
    const dump = JSON.stringify([p.steps, p.doms.map((d) => ({ ...d, blob: undefined })), p.scenarioDraft]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('山田');
    expect(dump).not.toContain('ORIGINAL-IMAGE');

    // DB へ取り込み: ID 再採番・成果物 ID 規則・origin
    const sc = scenarioFromDraft('prj_1', p.scenarioDraft, NOW);
    await putScenario(sc);
    await importParsedExport(sc.id, p, { copyArtifacts: true, now: NOW });
    const saved = await listSteps(sc.id);
    expect(saved.map((s) => s.seq)).toEqual([1, 2, 3]);
    for (const s of saved) {
      expect(steps.some((x) => x.id === s.id)).toBe(false);
      expect(s.origin).toBe('imported');
      expect(s.importedFrom!.source).toBe('export-zip');
      if (s.screenshot.status === 'captured') expect(s.screenshot.artifactId).toBe(`shot_${s.id}`);
      if (s.dom.status === 'captured') expect(s.dom.artifactId).toBe(`dom_${s.id}`);
    }
    const arts = await listArtifacts(sc.id);
    expect(arts.length).toBe(5); // 画面 2（1 件は除外）+ DOM 3
    const savedSc = (await getScenario(sc.id))!;
    expect(savedSc.variables!.map((v) => v.name)).toEqual(['氏名']);
    expect(groupPathNames(savedSc.groups, saved[0].groupId)).toEqual(['登録', '明細']);
  });

  it('未知の schemaVersion・ZIP でないデータ・steps.json の無い ZIP を理由つきで拒否する', () => {
    const z = zipSync({ 'tracelens-export/steps.json': strToU8(JSON.stringify({ schemaVersion: 99, steps: [] })) });
    const r = parseExportZip(z);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('schemaVersion: 99') });
    expect(parseExportZip(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(parseExportZip(zipSync({ 'a.txt': strToU8('x') }))).toMatchObject({ ok: false, reason: expect.stringContaining('steps.json') });
  });

  it('schemaVersion 1 の出力も読み、グループは名前から作る', () => {
    const rec = { id: 'stp_old', seq: 1, kind: 'click', group: 'G', sessionId: 's', time: { operationAt: 't', screenChangeObservations: [] }, page: { url: 'u', title: '' }, frame: { isTop: true, path: [], url: 'u' }, target: null, value: null, annotation: emptyAnnotation(), artifacts: { screenshot: { path: null, status: 'failed', reason: '非アクティブ' }, dom: { path: null, status: 'excluded-from-export', reason: '対象外' }, element: { path: null, status: 'not-applicable' } }, limitations: [] };
    const z = zipSync({ 'tracelens-export/steps.json': strToU8(JSON.stringify({ schemaVersion: 1, scenarioId: 'scn_x', steps: [rec] })) });
    const r = parseExportZip(z);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenarioDraft.groups.map((g) => g.name)).toEqual(['G']);
    expect(r.steps[0].groupId).toBe(r.scenarioDraft.groups[0].id);
    expect(r.steps[0].screenshot).toEqual({ status: 'failed', reason: '非アクティブ' });
    expect(r.steps[0].dom).toMatchObject({ status: 'skipped', reasonCode: 'excluded-from-export' });
    expect(r.warnings.join('\n')).toContain('schemaVersion 1');
  });
});

