import { beforeEach, describe, expect, it } from 'vitest';
import { computeAccessibleName, computeRole } from '../../src/shared/accname';
import { describeElement } from '../../src/shared/elementInfo';

const $ = (id: string) => document.getElementById(id)!;
const name = (id: string) => computeAccessibleName($(id));
const SECRET = 'Hunter2!secret';

beforeEach(() => { document.body.innerHTML = ''; });
const html = (s: string) => { document.body.innerHTML = s; };

describe('accname: 優先順位と規則', () => {
  it('aria-labelledby が aria-label・ネイティブ・内容より優先される', () => {
    html('<span id="a">甲</span><span id="b">乙</span><button id="x" aria-labelledby="a b" aria-label="L" title="T">内容</button>');
    expect(name('x')).toMatchObject({ value: '甲 乙', rule: 'aria-labelledby' });
  });
  it('aria-label が内容より優先される', () => {
    html('<button id="x" aria-label="保存する">保存</button>');
    expect(name('x')).toMatchObject({ value: '保存する', rule: 'aria-label' });
  });
  it('存在しない参照だけの aria-labelledby は次の規則へ進む', () => {
    html('<button id="x" aria-labelledby="none" aria-label="L">内容</button>');
    expect(name('x')).toMatchObject({ value: 'L', rule: 'aria-label' });
  });
  it('label for と包含 label、複数 label', () => {
    html('<label for="u">社員番号</label><input id="u"><label>氏名 <input id="n"></label><label for="m">備考1</label><label>備考2 <input id="m"></label>');
    expect(name('u')).toMatchObject({ value: '社員番号', rule: 'native-label' });
    expect(name('n').value).toBe('氏名'); // 自分自身の値は含めない
    expect(name('m').value).toBe('備考1 備考2');
  });
  it('input の順位: label > title > placeholder', () => {
    html('<input id="a" title="T" placeholder="P"><input id="b" placeholder="P"><label for="c">L</label><input id="c" title="T" placeholder="P">');
    expect(name('a')).toMatchObject({ value: 'T', rule: 'native-title' });
    expect(name('b')).toMatchObject({ value: 'P', rule: 'native-placeholder' });
    expect(name('c').value).toBe('L');
  });
  it('alt: img と input[type=image]。alt が空なら title へ', () => {
    html('<img id="a" alt="ロゴ" title="T"><img id="b" alt="" title="T2"><img id="c"><input id="d" type="image" alt="送信" value="V">');
    expect(name('a')).toMatchObject({ value: 'ロゴ', rule: 'native-alt' });
    expect(name('b').value).toBe('T2');
    expect(name('c').value).toBe('');
    expect(name('d')).toMatchObject({ value: '送信', rule: 'native-alt' });
  });
  it('button 系 input は value、なければ label、title', () => {
    html('<input id="a" type="submit" value="登録"><input id="b" type="button" title="T"><input id="c" type="reset">');
    expect(name('a')).toMatchObject({ value: '登録', rule: 'native-value' });
    expect(name('b').value).toBe('T');
    expect(name('c').value).toBe('');
  });
  it('fieldset の legend、table の caption、figure の figcaption', () => {
    html('<fieldset id="f"><legend>住所</legend><input></fieldset><table id="t"><caption>一覧</caption><tr><td>x</td></tr></table><figure id="g"><img alt=""><figcaption>図1</figcaption></figure>');
    expect(name('f')).toMatchObject({ value: '住所', rule: 'native-legend' });
    expect(name('t')).toMatchObject({ value: '一覧', rule: 'native-caption' });
    expect(name('g')).toMatchObject({ value: '図1', rule: 'native-figcaption' });
  });
  it('option / optgroup の label 属性', () => {
    html('<select><optgroup id="g" label="グループ"><option id="o" label="表示名">内容</option></optgroup></select>');
    expect(name('g').value).toBe('グループ');
    expect(name('o').value).toBe('表示名');
  });
});

describe('accname: 内容からの名前', () => {
  it('name from content が許される role だけ内容から計算する', () => {
    html('<a id="a" href="#">リンク <b>強調</b></a><button id="b">ボタン<span> 続き</span></button><div id="d">テキスト</div><div id="r" role="button">div ボタン</div><h2 id="h">見出し</h2>');
    expect(name('a')).toMatchObject({ value: 'リンク 強調', rule: 'content' });
    expect(name('b').value).toBe('ボタン 続き');
    expect(name('d').value).toBe(''); // generic は内容から名前を作らない
    expect(name('r').value).toBe('div ボタン');
    expect(name('h').value).toBe('見出し');
  });
  it('子孫の aria-label・img の alt を再帰で使い、ブロック要素の間は空白で区切る', () => {
    html('<a id="a" href="#"><img alt="ホーム"><span aria-label="へ"></span><div>戻る</div><div>進む</div></a>');
    expect(name('a').value).toBe('ホームへ 戻る 進む');
  });
  it('aria-hidden・hidden・display:none の子孫は除外する', () => {
    html('<button id="a">表示<span aria-hidden="true">隠1</span><span hidden>隠2</span><span style="display:none">隠3</span><span style="visibility:hidden">隠4</span></button>');
    expect(name('a').value).toBe('表示');
  });
  it('aria-labelledby が直接参照した非表示要素は名前に含める', () => {
    html('<span id="h" hidden>隠れた名前</span><button id="b" aria-labelledby="h">x</button>');
    expect(name('b')).toMatchObject({ value: '隠れた名前', rule: 'aria-labelledby' });
  });
  it('script / style の中身は含めない', () => {
    html('<button id="a">OK<script>var a = "SCRIPT"</script><style>.x{}</style></button>');
    expect(name('a').value).toBe('OK');
  });
  it('title は内容が空のときの最後の手段', () => {
    html('<button id="a" title="閉じる"></button><a id="b" href="#" title="T">内容</a>');
    expect(name('a')).toMatchObject({ value: '閉じる', rule: 'native-title' });
    expect(name('b').value).toBe('内容');
  });
  it('開いた Shadow DOM の内容と slot を辿る', () => {
    html('<div id="h" role="button"><span slot="s">スロット内容</span></div>');
    const host = $('h');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<b>前</b> <slot name="s"></slot>';
    expect(name('h').value).toBe('前 スロット内容');
  });
});

describe('accname: 循環参照と埋め込みコントロール', () => {
  it('aria-labelledby の循環・自己参照で無限ループしない', () => {
    html('<div id="a" role="button" aria-labelledby="b">A内容</div><div id="b" aria-labelledby="a">B内容</div><button id="s" aria-labelledby="s" aria-label="自己">本文</button>');
    expect(name('a').value).toBe('B内容');
    expect(name('s').value).toBe('自己');
  });
  it('label 内の埋め込みコントロールの値を名前に含める（select・textbox・slider）', () => {
    html('<label for="q">数量 <select id="sel"><option>1</option><option selected>2</option></select> 個 <input id="t" value="abc"> <input id="r" type="range" value="7"></label><input id="q">');
    expect(name('q').value).toBe('数量 2 個 abc 7');
  });
  it('機密欄の値は、埋め込みコントロールとしても名前に含めない', () => {
    html(`<label for="q">名前 <input id="pw" type="password" value="${SECRET}"> <input id="o" autocomplete="one-time-code" value="${SECRET}2"></label><input id="q"><span id="ref">ラベル</span><button id="b" aria-labelledby="ref pw">B</button>`);
    expect(name('q').value).toBe('名前');
    expect(name('b').value).toBe('ラベル');
  });
  it('type を text に切り替えた後のパスワード欄・ボタン風の value も名前に使わない', () => {
    html(`<input id="pw" type="password" value="${SECRET}"><div id="d" role="button">押す <span id="x"></span></div>`);
    const pw = $('pw') as HTMLInputElement;
    computeAccessibleName(pw); // 機密として観測
    pw.setAttribute('type', 'button'); // 機密のまま value を名前にしない
    expect(name('pw').value).not.toContain(SECRET);
    expect(name('pw').value).toBe('');
  });
  it('describeElement の結果にも機密値が出ない', () => {
    html(`<label>パスワード <input id="pw" type="password" value="${SECRET}"></label><div id="d" role="button" aria-labelledby="pw"></div>`);
    const a = JSON.stringify(describeElement($('pw')));
    const b = JSON.stringify(describeElement($('d')));
    expect(a).not.toContain(SECRET);
    expect(b).not.toContain(SECRET);
  });
});

describe('role の計算', () => {
  it('暗黙 role の主要な対応', () => {
    html('<a id="a" href="#">a</a><a id="a2">a</a><button id="b"></button><input id="i1"><input id="i2" type="checkbox"><input id="i3" type="submit"><input id="i4" type="number"><input id="i5" type="search"><input id="i6" list="l"><input id="i7" type="date"><select id="s"></select><select id="s2" multiple></select><textarea id="t"></textarea><img id="m" alt="x"><img id="m2" alt=""><h3 id="h"></h3><nav id="n"></nav><main id="mn"></main><table id="tb"><thead id="th"><tr id="tr"><th id="c1" scope="col">a</th><th id="c2" scope="row">b</th></tr></thead><tbody><tr><td id="td">x</td></tr></tbody></table><ul id="u"><li id="li"></li></ul><div id="li2"></div>');
    const r = (id: string) => computeRole($(id)).value;
    expect([r('a'), r('a2'), r('b'), r('i1'), r('i2'), r('i3'), r('i4'), r('i5'), r('i6'), r('i7')]).toEqual(['link', 'generic', 'button', 'textbox', 'checkbox', 'button', 'spinbutton', 'searchbox', 'combobox', null]);
    expect([r('s'), r('s2'), r('t'), r('m'), r('m2'), r('h'), r('n'), r('mn')]).toEqual(['combobox', 'listbox', 'textbox', 'img', 'presentation', 'heading', 'navigation', 'main']);
    expect([r('tb'), r('th'), r('tr'), r('c1'), r('c2'), r('td'), r('u'), r('li'), r('li2')]).toEqual(['table', 'rowgroup', 'row', 'columnheader', 'rowheader', 'cell', 'list', 'listitem', 'generic']);
    expect(computeRole($('a')).source).toBe('implicit-html-aam');
    expect(computeRole($('i7')).source).toBe('none');
  });
  it('明示 role は先頭の有効なトークンを使い、無効なら暗黙 role に戻る', () => {
    html('<div id="a" role="foo button">x</div><div id="b" role="Tab">x</div><button id="c" role="bogus">x</button><div id="d" role="foo">x</div>');
    expect(computeRole($('a'))).toMatchObject({ value: 'button', source: 'explicit' });
    expect(computeRole($('b')).value).toBe('tab');
    expect(computeRole($('c'))).toMatchObject({ value: 'button', source: 'implicit-html-aam' });
    expect(computeRole($('d')).value).toBe('generic');
  });
  it('form / section は名前があるときだけ form / region', () => {
    html('<form id="f1"></form><form id="f2" aria-label="検索"></form><section id="s1"></section><section id="s2" aria-label="概要"></section><header id="h1"></header><article><header id="h2"></header></article>');
    expect([computeRole($('f1')).value, computeRole($('f2')).value, computeRole($('s1')).value, computeRole($('s2')).value]).toEqual(['generic', 'form', 'generic', 'region']);
    expect([computeRole($('h1')).value, computeRole($('h2')).value]).toEqual(['banner', 'generic']);
  });
});

describe('elementInfo との互換', () => {
  it('計算結果が先頭の候補に入り、既存の候補・role・note は残る', () => {
    html('<label for="u">社員番号</label><input id="u" placeholder="例"><button id="b" aria-label="保存">x</button>');
    const u = describeElement($('u'));
    expect(u.nameCandidates[0]).toEqual({ source: 'accname', value: '社員番号', rule: 'native-label' });
    expect(u.nameCandidates).toContainEqual({ source: 'label', value: '社員番号' });
    expect(u.nameCandidates).toContainEqual({ source: 'placeholder', value: '例' });
    expect(u.role).toEqual({ value: 'textbox', source: 'implicit-heuristic' });
    expect(u.nameMethodNote).toContain('完全な Accessible Name 計算の結果ではない');
    expect(u.computedName?.note).toContain('ブラウザの結果との一致は未検証');
    expect(u.computedRole).toMatchObject({ value: 'textbox', source: 'implicit-html-aam' });
    expect(u.computedRole?.note).toContain('一致は未検証');
    const b = describeElement($('b'));
    expect(b.nameCandidates.map((n) => n.source)).toEqual(['accname', 'aria-label', 'text']);
  });
  it('名前が計算できないときは候補を足さず、computedName は rule=none で理由を持つ', () => {
    html('<div id="d"></div>');
    const i = describeElement($('d'));
    expect(i.nameCandidates.some((n) => n.source === 'accname')).toBe(false);
    expect(i.computedName).toMatchObject({ value: '', rule: 'none' });
  });
});
