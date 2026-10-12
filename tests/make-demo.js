// 見本データ（assets/demo-data.js）を作る。数字も名前もすべて架空。
// 本物と同じ計算（gas/app.js の appCompute_）に通すので、計算のテストも兼ねる。
// 実行： node tests/make-demo.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/app.js'), 'utf8'), ctx);

const TODAY = '2026/01/20';
const BANK = 'みらい銀行', WALLET = '財布', CARD = 'サンプルカード', FUND = 'つみたて口座';

// 決まった並びの乱数（毎回同じ見本になるように）
let seed = 20260120;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];
const ymd = (y, m, d) => y + '/' + ('0' + m).slice(-2) + '/' + ('0' + d).slice(-2);

const tx = [];
let n = 0;
// v = [日付, 種別, カテゴリ, 金額, 出金元, 入金先, 摘要, メモ, 取込元, '', 取込ID, '']
const add = (date, kind, cat, amt, from, to, desc) => tx.push({ row: tx.length + 2, v: [date, kind, cat, amt, from, to, desc, '', '見本', '', 'DEMO-' + (++n), ''] });

const shops = [
  ['食費', ['スーパーあおぞら', 'ベーカリーこむぎ', '定食のまるや', 'コンビニひまわり'], 600, 3800],
  ['日用品', ['ドラッグストアみどり', 'ホームセンターくるみ'], 500, 4200],
  ['交通費', ['みなと交通', 'タクシーほしぞら'], 300, 2600],
  ['交際費', ['居酒屋つきあかり', 'カフェやまびこ'], 1500, 7000],
  ['趣味・娯楽', ['ほんのもり書店', 'シネマぽらりす'], 900, 5200]
];
[[2025, 10], [2025, 11], [2025, 12], [2026, 1]].forEach(([y, m]) => {
  const lastDay = y === 2026 ? 20 : new Date(y, m, 0).getDate();
  for (let d = 1; d <= lastDay; d++) {
    const times = rnd() < 0.75 ? (rnd() < 0.3 ? 2 : 1) : 0;
    for (let k = 0; k < times; k++) {
      const s = pick(shops);
      const amt = Math.round((s[2] + rnd() * (s[3] - s[2])) / 10) * 10;
      const uncat = y === 2026 && rnd() < 0.2;
      add(ymd(y, m, d), '支出', uncat ? '未分類' : s[0], amt, rnd() < 0.85 ? CARD : WALLET, '', pick(s[1]));
    }
  }
  if (lastDay >= 5) add(ymd(y, m, 5), '支出', '通信費', 4980, CARD, '', 'そらモバイル');
  if (lastDay >= 8) add(ymd(y, m, 8), '支出', 'サブスク', 1480, CARD, '', 'おんがくストリーム');
  if (lastDay >= 10 && !(y === 2025 && m === 10)) {
    // 前の締め期間（前々月16日〜前月15日）のカード利用を口座から支払う
    const pe = new Date(y, m - 2, 15), ps = new Date(y, m - 3, 16);
    const sum = tx.reduce((a, t) => {
      const p = t.v[0].split('/').map(Number), dt = new Date(p[0], p[1] - 1, p[2]);
      return a + (t.v[4] === CARD && t.v[1] === '支出' && dt >= ps && dt <= pe ? t.v[3] : 0);
    }, 0);
    if (sum) add(ymd(y, m, 10), '振替', '', sum, BANK, CARD, CARD + ' 引落');
  }
  if (lastDay >= 25) {
    add(ymd(y, m, 25), '収入', '給与', 280000, '', BANK, 'サンプル商事 給与');
    add(ymd(y, m, 26), '振替', '', 20000, BANK, WALLET, '現金引き出し');
    add(ymd(y, m, 27), '支出', '住居費', 85000, BANK, '', '家賃');
    add(ymd(y, m, 28), '振替', '', 20000, BANK, FUND, 'つみたて');
  }
});
tx.sort((a, b) => (a.v[0] < b.v[0] ? -1 : a.v[0] > b.v[0] ? 1 : 0)).forEach((t, i) => { t.row = i + 2; });

const L = ctx.APP ? ctx.APP.LABEL : vm.runInContext('APP.LABEL', ctx);
const raw = {
  base: '2025/09/30',
  tx: tx,
  // [口座名, 資産/負債, 区分, 期首残高, 締日, 引落日, 引落口座, '']
  accounts: [
    [BANK, '資産', '現預金', 420000, '', '', '', ''],
    [WALLET, '資産', '現預金', 15000, '', '', '', ''],
    [FUND, '資産', '投資', 300000, '', '', '', ''],
    [CARD, '負債', 'カード', 0, 15, 10, BANK, '']
  ],
  // [カテゴリ, 収入/支出, 区分, 月予算]
  cats: [
    ['給与', '収入', '収入', ''],
    ['食費', '支出', '変動費', 45000], ['日用品', '支出', '変動費', 10000], ['交通費', '支出', '変動費', ''],
    ['交際費', '支出', '変動費', 20000], ['趣味・娯楽', '支出', '変動費', ''], ['未分類', '支出', '変動費', ''],
    ['住居費', '支出', '固定費', ''], ['通信費', '支出', '固定費', ''], ['サブスク', '支出', '固定費', '']
  ],
  conf: { [L.close]: 15, [L.payday]: 25, [L.income]: 280000, [L.fixed]: '', [L.repay]: 0, [L.saving]: 30000, [L.varOverride]: '', [L.cards]: CARD, [L.buffer]: 50000 },
  // [名前, 種別, カテゴリ, 金額, 出金元, 入金先, 日, 有効, 最終計上月]
  rec: [
    ['給与', '収入', '給与', 280000, '', BANK, 25, true, '2025/12'],
    ['家賃', '支出', '住居費', 85000, BANK, '', 27, true, '2025/12']
  ],
  recon: []
};

const out = vm.runInContext('appCompute_', ctx)(raw, TODAY);

// 計算の確認（架空データで、手で確かめられる範囲）
assert.strictEqual(out.asOf, TODAY);
assert.strictEqual(out.cycle.start, '2026/01/16'); // 締日15日なので、1/20 は 1/16〜2/15 の期
assert.strictEqual(out.cycle.end, '2026/02/15');
assert.strictEqual(out.cycle.left, 27);
assert.strictEqual(out.cycle.pay, '2026/03/10');
assert.strictEqual(out.budget.fixed, 85000 + 4980 + 1480);
assert.strictEqual(out.budget.variable, 280000 - out.budget.fixed - 0 - 30000);
assert.strictEqual(out.budget.remaining, out.budget.variable - out.budget.spent);
assert.strictEqual(out.finance.net, out.finance.assets - out.finance.liabilities);
assert.strictEqual(out.cash.room, out.cash.min - 50000);
assert.strictEqual(out.finance.history.length, 4);
assert.ok(out.tx.uncategorizedCount > 0 && out.tx.recent.length === 60);
assert.strictEqual(out.warnings.length, 0);

fs.writeFileSync(path.join(__dirname, '../assets/demo-data.js'),
  '// 見本データ。数字も名前もすべて架空（tests/make-demo.js で作成）\nwindow.__MOCK__ = ' + JSON.stringify(out) + ';\n');
console.log('見本データを書き出しました（取引 ' + tx.length + ' 件、未分類 ' + out.tx.uncategorizedCount + ' 件）');
