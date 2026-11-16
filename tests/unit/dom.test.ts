import { beforeEach, describe, expect, it } from 'vitest';
import { serializeDom } from '../../src/shared/domSerialize';
import { describeElement, readValue } from '../../src/shared/elementInfo';
import { isSensitiveField } from '../../src/shared/sensitive';
import { buildSelectorCandidates, dynamicIdSuspicion, idSelector } from '../../src/shared/selectors';

const SECRET = 'Hunter2!secret';

beforeEach(() => {
  document.body.innerHTML = `
    <form id="f">
      <label for="user">社員番号</label><input id="user" name="user" value="init">
      <label>パスワード <input id="pw" type="password" name="pw" value="${SECRET}"></label>
      <input id="otp" autocomplete="one-time-code">
      <textarea id="memo" name="memo">初期メモ</textarea>
      <select id="pj" name="pj" aria-label="PJ"><option value="">選択</option><option value="P1">P1 開発</option><option value="P2">P2 保守</option></select>
      <input type="checkbox" id="agree" name="agree">
      <button type="submit" data-testid="save">保存</button>
      <button type="button" id="row-1700000012345">削除</button>
      <button type="button">削除</button>
    </form>
    <script>var token = "SCRIPT_SECRET";</script>
    <style>.x { color: red }</style>
    <canvas id="c"></canvas>`;
});

describe('機密欄の除外', () => {
  it('パスワード欄・ワンタイムコード欄を機密と判定し、type を切り替えた後も機密のまま扱う', () => {
    const pw = document.getElementById('pw') as HTMLInputElement;
    expect(isSensitiveField(pw)).toBe(true);
    expect(isSensitiveField(document.getElementById('otp'))).toBe(true);
    expect(isSensitiveField(document.getElementById('user'))).toBe(false);
    pw.type = 'text'; // 「パスワードを表示」
    expect(isSensitiveField(pw)).toBe(true);
    expect(readValue(pw)).toEqual({ kind: 'redacted', redacted: true, redactionReason: expect.any(String) });
  });

  it('DOM・フォーム状態・要素情報のいずれにもパスワード値が出ない', () => {
    const pw = document.getElementById('pw') as HTMLInputElement;
    pw.value = SECRET + '-typed';
    const r = serializeDom(document);
    const info = describeElement(pw);
    const all = JSON.stringify([r, info, readValue(pw)]);
    expect(all).not.toContain(SECRET);
    const entry = r.formState.find((f) => f.id === 'pw')!;
    expect(entry.redacted).toBe(true);
    expect(entry.value).toBeUndefined();
    // 周辺DOM（親 form を含む）にも value 属性が出ない
    expect(describeElement(document.getElementById('user')!).surroundingHtml).not.toContain(SECRET);
  });
});

describe('DOM の直列化', () => {
  it('script/style の中身を保存せず、HTMLに残らない現在値を formState に保存する', () => {
    (document.getElementById('user') as HTMLInputElement).value = 'E12345';
    (document.getElementById('pj') as HTMLSelectElement).value = 'P2';
    (document.getElementById('agree') as HTMLInputElement).checked = true;
    (document.getElementById('memo') as HTMLTextAreaElement).value = '現在のメモ';
    const r = serializeDom(document);
    expect(r.html).not.toContain('SCRIPT_SECRET');
    expect(r.html).not.toContain('color: red');
    expect(r.html).toContain('value="init"'); // 属性は初期値のまま
    const by = (id: string) => r.formState.find((f) => f.id === id)!;
    expect(by('user').value).toBe('E12345');
    expect(by('pj').selectedValues).toEqual(['P2']);
    expect(by('agree').checked).toBe(true);
    expect(by('memo').value).toBe('現在のメモ');
    // formState の ref が DOM 内の属性と対応する
    expect(r.html).toContain(`id="user" name="user" value="init" data-tracelens-ref="${by('user').ref}"`);
    expect(r.html).toContain('data-tracelens-note="canvas-content-not-captured"');
  });

  it('open Shadow DOM を展開し、TraceLens 自身のオーバーレイは含めない', () => {
    const host = document.createElement('x-tip');
    host.attachShadow({ mode: 'open' }).innerHTML = '<button id="in-shadow">ヘルプ</button>';
    document.body.appendChild(host);
    document.body.appendChild(document.createElement('tracelens-overlay'));
    const r = serializeDom(document);
    expect(r.html).toContain('<template shadowrootmode="open"><button id="in-shadow">ヘルプ</button></template>');
    expect(r.html).not.toContain('tracelens-overlay');
  });

  it('サイズ上限を超えたら省略し、truncated を立てる（成功を装わない）', () => {
    const r = serializeDom(document, 200);
    expect(r.truncated).toBe(true);
    expect(r.html).toContain('サイズ上限のため以降を省略');
  });
});

describe('セレクター候補', () => {
  it('各候補に記録時点の一致件数が付く', () => {
    const save = document.querySelector('[data-testid="save"]')!;
    const c = buildSelectorCandidates(save);
    expect(c.find((x) => x.kind === 'test-attribute')).toMatchObject({ selector: '[data-testid="save"]', matchCount: 1 });
    const del = document.querySelectorAll('button[type="button"]')[1];
    const xp = buildSelectorCandidates(del).find((x) => x.kind === 'text-xpath')!;
    expect(xp.matchCount).toBe(2); // 「削除」は2件ある → 一意でないことが分かる
    for (const x of c) expect(document.querySelectorAll(x.language === 'css' ? x.selector : 'html').length).toBeGreaterThan(0);
  });

  it('動的に見えるIDと位置依存のパスは suspect とし、安定と断定しない', () => {
    expect(dynamicIdSuspicion('row-1700000012345')).toBeTruthy();
    expect(dynamicIdSuspicion(':r1a:')).toBeTruthy();
    expect(dynamicIdSuspicion('save')).toBeNull();
    const c = buildSelectorCandidates(document.getElementById('row-1700000012345')!);
    expect(c.find((x) => x.kind === 'id')).toMatchObject({ stability: 'suspect', matchCount: 1 });
    expect(c.find((x) => x.kind === 'css-path')!.stability).toBe('suspect');
    expect(c.every((x) => x.stability === 'suspect' || x.stability === 'unverified')).toBe(true);
    expect(c.every((x) => x.stabilityNote.length > 0)).toBe(true);
  });

  it('特殊文字を含むIDをエスケープし、そのセレクターで要素を引ける', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="a:b.c">x</div><div id="1st">y</div><div id="日本語">z</div><div id="plain-id">p</div>');
    document.body.appendChild(Object.assign(document.createElement('div'), { id: 'q"uote' }));
    for (const id of ['a:b.c', '1st', '日本語', 'plain-id', 'q"uote']) expect(document.querySelector(idSelector(id))?.id).toBe(id);
  });
});

describe('要素情報', () => {
  it('role は由来を区別し、名前は「候補」として由来つきで列挙する', () => {
    const pj = describeElement(document.getElementById('pj')!);
    expect(pj.role).toEqual({ value: 'combobox', source: 'implicit-heuristic' });
    expect(pj.nameCandidates[0]).toEqual({ source: 'aria-label', value: 'PJ' });
    expect(pj.nameMethodNote).toContain('完全な Accessible Name 計算の結果ではない');
    const user = describeElement(document.getElementById('user')!);
    expect(user.labels).toEqual(['社員番号']);
    expect(user.nameCandidates).toContainEqual({ source: 'label', value: '社員番号' });
    expect(describeElement(document.getElementById('c')!).hints.join()).toContain('canvas');
  });

  it('select は選択値・ラベルと、その時点の候補一覧を記録する', () => {
    const pj = document.getElementById('pj') as HTMLSelectElement;
    pj.value = 'P1';
    const v = readValue(pj)!;
    expect(v.selectedOptions).toEqual([{ value: 'P1', label: 'P1 開発', index: 1 }]);
    expect(v.availableOptions!.map((o) => o.value)).toEqual(['', 'P1', 'P2']);
  });
});
