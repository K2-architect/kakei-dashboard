// 取引タブ（利用先ごとのまとめ・カテゴリの推定・一括保存）のテスト。値はすべて架空。実行： node tests/tx.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/app.js'), 'utf8'), ctx);
const plain = x => JSON.parse(JSON.stringify(x));

const OVERSEAS = 'サンプルカードご利用分（海外利用分）';
const CATS = ['食費', '外食', '交際費', '特別費', 'サブスク', '日用品', '未分類'];
// 取引シートの1行（A〜K列）： [日付, 種別, カテゴリ, 金額, 出金元, 入金先, 利用先, メモ, 取込元, '', 取込ID]
const line = (date, cat, amt, desc, id) => [date, '支出', cat, amt, 'サンプルカード', '', desc, '', '見本', '', id];
const sheet = () => [
  line('2026/01/05', '日用品', 800, 'ドラッグストアみどり', 'A1'),      // 2行目
  line('2026/01/06', '未分類', 780, 'カフエ　ヤマビコ', 'A2'),           // 3
  line('2026/01/07', '未分類', 640, 'ｶﾌｴ ﾔﾏﾋﾞｺ', 'A3'),                  // 4（半角。正規化すると上と同じ）
  line('2026/01/08', '未分類', 12800, 'エア－ペイ／ツキアカリ', 'A4'),   // 5
  line('2026/01/09', '未分類', 1650, OVERSEAS, 'A5'),                    // 6
  line('2026/01/10', '未分類', 2980, OVERSEAS, 'A6'),                    // 7
  line('2026/01/11', '未分類', 900, 'ドラッグストアみどり', 'A7'),       // 8
  line('2026/01/12', '未分類', 520, 'ミナトユ', ''),                     // 9（取込IDなし）
  line('2026/01/13', '未分類', 450, 'カフエ　ヤマビコ　エキマエ', 'A9'), // 10
  line('2026/01/14', '未分類', 300, '', 'A10')                           // 11（利用先なし）
];
const groups = () => {
  const raw = {
    base: '2025/12/31', tx: sheet().map((v, i) => ({ row: i + 2, v: v.concat(['']) })),
    accounts: [['みらい銀行', '資産', '現預金', 100000, '', '', '', ''], ['サンプルカード', '負債', 'カード', 0, 15, 10, 'みらい銀行', '']],
    cats: CATS.map(c => [c, '支出', '変動費', '']), conf: {}, rec: [], recon: []
  };
  return plain(ctx.appCompute_(raw, '2026/01/20').tx.uncatGroups);
};
const find = (gs, desc) => gs.filter(g => g.desc === desc);
const plan = (changes, rows, rules) => plain(ctx.appPlanCategories_(changes, rows || sheet(), rules || []));
const col = p => p.cats.map(c => c[0]);

const tests = {
  '同じ利用先は1つにまとまり、件数・合計・期間が出る'() {
    const g = find(groups(), 'ｶﾌｴ ﾔﾏﾋﾞｺ')[0]; // 代表の表記はいちばん新しいもの
    assert.strictEqual(g.key, 'カフエ ヤマビコ');
    assert.deepStrictEqual([g.count, g.total, g.first, g.last], [2, 1420, '2026/01/06', '2026/01/07']);
    assert.deepStrictEqual(g.items, [{ row: 4, id: 'A3', date: '2026/01/07', amount: 640 }, { row: 3, id: 'A2', date: '2026/01/06', amount: 780 }]);
  },
  '並び順は合計額の大きい順'() {
    const totals = groups().map(g => g.total);
    assert.deepStrictEqual(totals, totals.slice().sort((a, b) => b - a));
  },
  '店名なし（海外利用分・利用先なし）はまとめず、1件ずつになる'() {
    const gs = groups(), o = find(gs, OVERSEAS);
    assert.strictEqual(o.length, 2);
    o.forEach(g => assert.deepStrictEqual([g.count, g.noMerchant, g.suggest], [1, true, 'サブスク']));
    assert.deepStrictEqual([find(gs, '')[0].noMerchant, find(gs, 'ミナトユ')[0].noMerchant], [true, false]);
  },
  '推定：過去の分類 → キーワード → なし の順'() {
    const gs = groups();
    const past = find(gs, 'ドラッグストアみどり')[0];
    assert.deepStrictEqual([past.suggest, past.suggestReason], ['日用品', '前にも「日用品」に分類']);
    assert.strictEqual(find(gs, 'ｶﾌｴ ﾔﾏﾋﾞｺ')[0].suggest, '外食');
    assert.deepStrictEqual([find(gs, 'ミナトユ')[0].suggest, find(gs, 'ミナトユ')[0].suggestReason], ['', '']);
  },
  '推定：外食で1件あたり1万円以上なら交際費'() {
    assert.strictEqual(find(groups(), 'エア－ペイ／ツキアカリ')[0].suggest, '交際費');
    const s = (d, a, known) => plain(ctx.appSuggest_(ctx.appNorm_(d), a, known || {})).cat;
    assert.strictEqual(s('レストラン　ホシゾラ', 9999), '外食');
    assert.strictEqual(s('レストラン　ホシゾラ', 10000), '交際費');
    assert.strictEqual(s('なじみの店', 15000, { 'なじみの店': '外食' }), '交際費'); // 過去の分類が外食でも同じ
    assert.strictEqual(s('ホテル　ポラリス', 30000), '特別費');
  },
  '推定：長音・小さいカナの表記ゆれでも当たる'() {
    const s = d => plain(ctx.appSuggest_(ctx.appNorm_(d), 800, {})).cat;
    ['コ－ヒ－ヤ', 'コーヒーヤ', 'ｺｰﾋｰﾔ', 'カフェ　ヤマビコ', 'ベ－カリ－コムギ', '自販機 ソラ'].forEach(d => assert.ok(s(d), d));
    assert.strictEqual(s('自販機 ソラ'), '食費');
  },
  'マスタにないカテゴリは候補にしない'() {
    const raw = { base: '2025/12/31', tx: [{ row: 2, v: line('2026/01/06', '未分類', 780, 'カフエ　ヤマビコ', 'A2').concat(['']) }],
      accounts: [], cats: [['食費', '支出', '変動費', ''], ['未分類', '支出', '変動費', '']], conf: {}, rec: [], recon: [] };
    assert.strictEqual(ctx.appCompute_(raw, '2026/01/20').tx.uncatGroups[0].suggest, '');
  },

  '一括保存：未分類の行だけを書き換え、ほかの行はそのまま'() {
    const p = plan([{ cat: '外食', addRule: false, desc: 'カフエ　ヤマビコ', items: [{ row: 3, id: 'A2', amount: 780 }, { row: 4, id: 'A3', amount: 640 }] }]);
    assert.deepStrictEqual([p.updated, p.skipped, p.autoApplied, p.newRules.length], [2, 0, 0, 0]);
    const before = sheet().map(r => r[2]);
    before[1] = before[2] = '外食';
    assert.deepStrictEqual(col(p), before);
  },
  '一括保存：先に分類された行は上書きせず、件数を返す'() {
    const rows = sheet();
    rows[1][2] = '食費'; // ほかの端末で先に分類された
    const p = plan([{ cat: '外食', addRule: false, desc: 'カフエ　ヤマビコ', items: [{ row: 3, id: 'A2', amount: 780 }, { row: 4, id: 'A3', amount: 640 }] }], rows);
    assert.deepStrictEqual([p.updated, p.skipped, col(p)[1], col(p)[2]], [1, 1, '食費', '外食']);
  },
  '一括保存：行がずれていたら取込IDで探し直す。見つからなければ飛ばす'() {
    const rows = sheet();
    rows.unshift(line('2026/01/04', '食費', 500, 'スーパーあおぞら', 'A0')); // 上に1行入って、全体が1行ずれた
    const p = plan([{ cat: '外食', addRule: false, desc: 'カフエ　ヤマビコ', items: [{ row: 3, id: 'A2', amount: 780 }, { row: 99, id: 'ZZ', amount: 1 }] }], rows);
    assert.deepStrictEqual([p.updated, p.skipped, col(p)[2], col(p)[1]], [1, 1, '外食', '日用品']);
  },
  '一括保存：取込IDがない行は、利用先と金額が合うときだけ書き換える'() {
    const ok = plan([{ cat: '特別費', addRule: false, desc: 'ミナトユ', items: [{ row: 9, id: '', amount: 520 }] }]);
    assert.deepStrictEqual([ok.updated, col(ok)[7]], [1, '特別費']);
    const ng = plan([{ cat: '特別費', addRule: false, desc: 'ミナトユ', items: [{ row: 9, id: '', amount: 999 }, { row: 8, id: '', amount: 520 }] }]);
    assert.deepStrictEqual([ng.updated, ng.skipped], [0, 2]);
  },
  '一括保存：ルールは重複して追加しない（シートにある分も、同じ回の分も）'() {
    const ch = (desc, cat) => ({ cat: cat, addRule: true, desc: desc, items: [] });
    const p = plan([ch('ミナトユ', '特別費'), ch('ﾐﾅﾄﾕ', '特別費'), ch('ドラッグストアみどり', '日用品')], sheet(), ['どらっぐすとあ', 'ドラッグストアみどり']);
    assert.deepStrictEqual(p.newRules, [['ミナトユ', '特別費', 'アプリから追加（一括）']]);
  },
  '一括保存：店名なしはルールを追加せず、ほかの行にも広げない'() {
    const p = plan([{ cat: 'サブスク', addRule: true, desc: OVERSEAS, items: [{ row: 6, id: 'A5', amount: 1650 }] },
      { cat: '食費', addRule: true, desc: '', items: [{ row: 11, id: 'A10', amount: 300 }] }]);
    assert.deepStrictEqual([p.updated, p.newRules.length, p.autoApplied], [2, 0, 0]);
    assert.strictEqual(col(p)[5], '未分類'); // もう1件の海外利用分はそのまま
  },
  '一括保存：ルールを追加した利用先を含む、残りの未分類も付け直す'() {
    const p = plan([{ cat: '外食', addRule: true, desc: 'カフエ　ヤマビコ', items: [{ row: 3, id: 'A2', amount: 780 }, { row: 4, id: 'A3', amount: 640 }] }]);
    assert.deepStrictEqual([p.updated, p.autoApplied, col(p)[8]], [2, 1, '外食']); // 「カフエ ヤマビコ エキマエ」も
    // 自分で選んだ行は、ほかのグループのルールより優先する
    const q = plan([{ cat: '外食', addRule: true, desc: 'カフエ　ヤマビコ', items: [{ row: 3, id: 'A2', amount: 780 }] },
      { cat: '交際費', addRule: true, desc: 'カフエ　ヤマビコ　エキマエ', items: [{ row: 10, id: 'A9', amount: 450 }] }]);
    assert.deepStrictEqual([col(q)[8], col(q)[2], q.autoApplied, q.newRules.length], ['交際費', '外食', 1, 2]);
  },
  'シートへの書き込みは、取引に1回・分類ルールに1回だけ'() {
    const writes = [];
    let locks = 0;
    const fake = (name, data, firstRow) => ({
      getMaxRows: () => firstRow - 1 + data.length,
      getRange: (r, c, n, w) => ({
        getValues: () => Array.from({ length: n }, (_, i) => Array.from({ length: w }, (_, j) => { const row = data[r - firstRow + i]; return row ? (row[c - 1 + j] === undefined ? '' : row[c - 1 + j]) : ''; })),
        setValues: v => writes.push({ sheet: name, row: r, col: c, values: v })
      })
    });
    const txData = [['日付']].concat(sheet());
    const ruleData = [['分類ルール'], [''], [''], ['キーワード', 'カテゴリ', 'メモ'], ['ドラッグストアみどり', '日用品', '']];
    ctx.LockService = { getDocumentLock: () => ({ waitLock() { locks++; }, releaseLock() { locks--; } }) };
    ctx.SpreadsheetApp = { getActive: () => ({ getSheetByName: n => (n === '取引' ? fake(n, txData, 1) : fake(n, ruleData, 1)) }) };
    const r = plain(ctx.appSetCategories([
      { cat: '外食', addRule: true, desc: 'カフエ　ヤマビコ', items: [{ row: 3, id: 'A2', amount: 780 }, { row: 4, id: 'A3', amount: 640 }] },
      { cat: '特別費', addRule: true, desc: 'ミナトユ', items: [{ row: 9, id: '', amount: 520 }] },
      { cat: '日用品', addRule: true, desc: 'ドラッグストアみどり', items: [{ row: 8, id: 'A7', amount: 900 }] }
    ]));
    assert.deepStrictEqual(r, { ok: true, updated: 4, skipped: 0, rulesAdded: 2, autoApplied: 1 });
    assert.strictEqual(locks, 0);
    assert.deepStrictEqual(writes.map(w => [w.sheet, w.row, w.col, w.values.length, w.values[0].length]), [['取引', 2, 3, 10, 1], ['分類ルール', 6, 1, 2, 3]]);
    // 何も変わらないときは、どこにも書かない
    writes.length = 0;
    ctx.appSetCategories([{ cat: '外食', addRule: false, desc: 'x', items: [{ row: 2, id: 'A1', amount: 800 }] }]);
    assert.strictEqual(writes.length, 0);
  }
};

let failed = 0;
Object.keys(tests).forEach(name => {
  try { tests[name](); console.log('OK  ' + name); } catch (e) { failed++; console.log('NG  ' + name + '\n    ' + e.message); }
});
console.log(failed ? failed + ' 件失敗' : 'すべて成功（' + Object.keys(tests).length + ' 件）');
process.exit(failed ? 1 : 0);
