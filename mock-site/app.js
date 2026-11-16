// 模擬業務ページ（勤怠の工数登録を想定した動作確認用）。TraceLens 本体とは無関係の独立したアプリ。
const MASTER = {
  P001: { name: '基幹システム刷新', steps: [['1000', '要件定義'], ['2000', '設計'], ['3000', '実装']] },
  P002: { name: '保守サポート', steps: [['5000', '問合せ対応'], ['5100', '障害対応']] },
  P003: { name: '社内業務', steps: [['9000', '会議'], ['9100', '教育']] },
};
const KEY = 'mock-kintai-entries';
const load = () => JSON.parse(localStorage.getItem(KEY) || '{}');
const app = document.getElementById('app');
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// open Shadow DOM を持つ小さな部品
customElements.define('help-tip', class extends HTMLElement {
  connectedCallback() {
    const sr = this.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button id="help-btn" type="button" style="font:inherit">ヘルプ</button><span id="help-text" hidden style="margin-left:8px">工数は 0.25 時間単位で入力します。</span>';
    sr.getElementById('help-btn').addEventListener('click', () => { const t = sr.getElementById('help-text'); t.hidden = !t.hidden; });
  }
});

function loadSteps(row, pj, selected) {
  const sel = row.querySelector('select[name="step"]');
  sel.disabled = true;
  sel.innerHTML = '<option value="">読み込み中…</option>';
  // PJ に応じた工程候補が「遅れて」更新される
  setTimeout(() => {
    const opts = pj && MASTER[pj] ? MASTER[pj].steps : [];
    sel.innerHTML = '<option value="">（工程を選択）</option>' + opts.map(([c, n]) => `<option value="${c}">${c} ${n}</option>`).join('');
    sel.disabled = !opts.length;
    if (selected) sel.value = selected;
  }, 700);
}

function addRow(data) {
  const id = 'row-' + Date.now() + Math.floor(Math.random() * 1000); // 動的に生成されるID
  const row = h(`<tr id="${id}" class="entry-row">
    <td><select name="pj" aria-label="PJ"><option value="">（PJを選択）</option>${Object.entries(MASTER).map(([c, p]) => `<option value="${c}">${c} ${p.name}</option>`).join('')}</select></td>
    <td><select name="step" aria-label="工程" disabled><option value="">（先にPJを選択）</option></select></td>
    <td><input name="hours" aria-label="工数" inputmode="decimal" size="6" placeholder="例: 1.5"></td>
    <td><input name="memo" aria-label="作業メモ" size="28" placeholder="作業内容"></td>
    <td><button type="button" class="del">削除</button></td></tr>`);
  row.querySelector('[name="pj"]').addEventListener('change', (e) => loadSteps(row, e.target.value));
  row.querySelector('.del').addEventListener('click', () => row.remove());
  document.querySelector('#rows').appendChild(row);
  if (data) { row.querySelector('[name="pj"]').value = data.pj; loadSteps(row, data.pj, data.step); row.querySelector('[name="hours"]').value = data.hours; row.querySelector('[name="memo"]').value = data.memo || ''; }
  return row;
}

function showSaved(date) {
  document.querySelector('#rows').innerHTML = '';
  const rows = load()[date] || [];
  document.querySelector('#loaded').textContent = rows.length ? `登録済みデータ ${rows.length} 件を表示しています。` : '';
  if (rows.length) rows.forEach(addRow); else addRow();
}

function renderEntry() {
  document.title = '模擬勤怠 - 工数入力';
  app.innerHTML = `<h1 style="font-size:18px">工数入力</h1>
    <p><label for="workDate">対象日</label> <input type="date" id="workDate" name="workDate" data-testid="work-date"> <span id="loaded" style="color:#666"></span></p>
    <table><thead><tr><th>PJ</th><th>工程</th><th>工数(h)</th><th>作業メモ</th><th></th></tr></thead><tbody id="rows"></tbody></table>
    <p><button type="button" id="add-row">行追加</button> <button type="button" id="save" data-testid="save-button">保存</button></p>
    <div class="msg ok" id="status" role="status"></div><div class="msg err" id="errors" role="alert"></div>`;
  const date = document.querySelector('#workDate');
  date.addEventListener('change', () => { document.querySelector('#status').textContent = ''; setTimeout(() => showSaved(date.value), 300); });
  document.querySelector('#add-row').addEventListener('click', () => addRow());
  document.querySelector('#save').addEventListener('click', save);
  addRow();
}

function save() {
  const status = document.querySelector('#status'), errors = document.querySelector('#errors');
  status.textContent = ''; errors.innerHTML = '';
  const date = document.querySelector('#workDate').value;
  const errs = [];
  if (!date) errs.push('対象日は必須です。');
  const rows = [...document.querySelectorAll('.entry-row')].map((r, i) => {
    const d = { pj: r.querySelector('[name="pj"]').value, step: r.querySelector('[name="step"]').value, hours: r.querySelector('[name="hours"]').value.trim(), memo: r.querySelector('[name="memo"]').value };
    if (!d.pj) errs.push(`${i + 1}行目: PJは必須です。`);
    if (!d.step) errs.push(`${i + 1}行目: 工程は必須です。`);
    if (!d.hours || isNaN(Number(d.hours)) || Number(d.hours) <= 0) errs.push(`${i + 1}行目: 工数は正の数値で入力してください。`);
    return d;
  });
  if (!rows.length) errs.push('1行以上入力してください。');
  if (errs.length) { errors.innerHTML = errs.map((e) => `<div>${e}</div>`).join(''); return; }
  status.textContent = '保存中…';
  setTimeout(() => { const all = load(); all[date] = rows; localStorage.setItem(KEY, JSON.stringify(all)); status.textContent = `保存しました（${rows.length}件）`; }, 600);
}

function renderList() {
  document.title = '模擬勤怠 - 登録済み一覧';
  const all = load();
  const body = Object.keys(all).sort().flatMap((d) => all[d].map((r) => `<tr><td>${d}</td><td>${r.pj} ${MASTER[r.pj]?.name ?? ''}</td><td>${r.step}</td><td>${r.hours}</td><td>${r.memo || ''}</td></tr>`)).join('');
  app.innerHTML = `<h1 style="font-size:18px">登録済み一覧</h1><table id="list-table"><thead><tr><th>対象日</th><th>PJ</th><th>工程</th><th>工数(h)</th><th>作業メモ</th></tr></thead><tbody>${body || '<tr><td colspan="5">登録済みデータはありません。</td></tr>'}</tbody></table>
    <p><button type="button" id="clear-all">登録データをすべて消去</button></p>`;
  document.querySelector('#clear-all').addEventListener('click', () => { localStorage.removeItem(KEY); renderList(); });
}

// SPA 形式の画面切り替え（history.pushState）
function route() {
  const view = new URLSearchParams(location.search).get('view') || 'entry';
  document.querySelectorAll('header a').forEach((a) => a.classList.toggle('current', a.dataset.view === view));
  if (view === 'list') renderList(); else renderEntry();
}
document.querySelectorAll('header a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); route(); }));
window.addEventListener('popstate', route);
route();
