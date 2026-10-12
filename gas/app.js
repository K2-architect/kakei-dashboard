/**
 * 家計ダッシュボード（Webアプリ）
 *
 * 個人家計簿の Apps Script プロジェクトに、このファイル（app.gs）と index.html（app.html の中身）を追加して使います。
 * 関数名はすべて app で始まり、kakeibo.gs・kyodo_sync.gs とは重なりません。
 *
 * 公開：［デプロイ］→［新しいデプロイ］→ 種類「ウェブアプリ」、
 *       次のユーザーとして実行「自分」、アクセスできるユーザー「自分のみ」。
 *
 * 画面
 *   ホーム … 今期（締日の翌日〜次の締日）にあと使える額（予算方式）と、資金繰りの余裕
 *   予定   … 次の引落までの入出金予定と残高の見込み
 *   財務   … 現在の残高・純資産、月ごとの推移と収支
 *   取引   … 未分類のカテゴリ付け（利用先ごとにまとめて一括保存。分類ルールへの追加も）、最近の取引
 *
 * 設定は「アプリ設定」シート（初回アクセス時に自動で作成）。
 */

const APP = {
  TX: '取引', SET: '設定', RULES: '分類ルール', REC: '定期取引', RECON: '突合', CONF: 'アプリ設定',
  ACCT_RANGE: 'A12:H21',   // 設定：口座マスタ
  CAT_RANGE: 'J12:M51',    // 設定：カテゴリマスタ
  BASE_CELL: 'B3',         // 設定：期首基準日
  RECENT: 60,
  LABEL: {
    close: '予算の締日',
    payday: '給料日',
    income: '手取り（月）',
    fixed: '毎月の固定費（見込み）',
    repay: '毎月の返済',
    saving: '貯蓄目標（月）',
    varOverride: '変動費の枠（手入力）',
    cards: '請求を見込むカード',
    buffer: '口座に最低限残す額',
  },
};

/* ───────── 画面 ───────── */

// 画面は GitHub Pages に移した。doGet と doPost は app_api.gs にある

/** 画面に出す数字をまとめて返す（app_api.gs の dashboard.get から呼ぶ） */
function appGetData() {
  const ss = SpreadsheetApp.getActive();
  appEnsureConf_(ss);
  const raw = appReadRaw_(ss);
  return appCompute_(raw, appFmt_(new Date(), ss.getSpreadsheetTimeZone()));
}

/**
 * カテゴリの付け直し（google.script.run から呼ぶ）
 * @param {{row:number,id:string,desc:string,amount:number,cat:string,addRule:boolean}} ch
 */
function appSetCategory(ch) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActive();
    const tx = ss.getSheetByName(APP.TX);
    const last = appLastRow_(tx);
    let row = 0;
    if (ch.row >= 2 && ch.row <= last) {
      const v = tx.getRange(ch.row, 1, 1, 12).getValues()[0];
      const sameId = ch.id && String(v[10]) === String(ch.id);
      const sameDesc = !ch.id && String(v[6]) === String(ch.desc) && Number(v[3]) === Number(ch.amount);
      if (sameId || sameDesc) row = ch.row;
    }
    if (!row && ch.id) {
      const ids = tx.getRange(2, 11, Math.max(last - 1, 1), 1).getValues();
      const i = ids.findIndex(function (r) { return String(r[0]) === String(ch.id); });
      if (i >= 0) row = i + 2;
    }
    if (!row) throw new Error('対象の行が見つかりません。画面を更新してからやり直してください。');
    tx.getRange(row, 3).setValue(ch.cat);

    let ruleAdded = false, auto = 0;
    const key = String(ch.desc || '').trim();
    if (ch.addRule && key) {
      const rs = ss.getSheetByName(APP.RULES);
      const rLast = appLastRow_(rs);
      const rules = rLast >= 5 ? rs.getRange(5, 1, rLast - 4, 2).getValues() : [];
      const nk = appNorm_(key);
      if (!rules.some(function (r) { return appNorm_(r[0]) === nk; })) {
        rs.getRange(Math.max(rLast, 4) + 1, 1, 1, 3).setValues([[key, ch.cat, 'アプリから追加']]);
        ruleAdded = true;
      }
      // 同じ利用先の未分類もまとめて付け直す
      const n = last - 1;
      const cats = tx.getRange(2, 3, n, 1).getValues();
      const descs = tx.getRange(2, 7, n, 1).getValues();
      cats.forEach(function (c, i) {
        if (c[0] === '未分類' && appNorm_(descs[i][0]).indexOf(nk) >= 0) { c[0] = ch.cat; auto++; }
      });
      if (auto) tx.getRange(2, 3, n, 1).setValues(cats);
    }
    return { ok: true, ruleAdded: ruleAdded, auto: auto };
  } finally {
    lock.releaseLock();
  }
}

/**
 * カテゴリの一括付け直し（app_api.gs の tx.setCategories から呼ぶ）。1グループ＝1要素
 * @param {Array<{cat:string,addRule:boolean,desc:string,items:Array<{row:number,id:string,amount:number}>}>} changes
 */
function appSetCategories(changes) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActive();
    const tx = ss.getSheetByName(APP.TX);
    const n = appLastRow_(tx) - 1;
    const rows = n >= 1 ? tx.getRange(2, 1, n, 11).getValues() : [];
    const rs = ss.getSheetByName(APP.RULES);
    const rLast = appLastRow_(rs);
    const ruleKeys = rLast >= 5 ? rs.getRange(5, 1, rLast - 4, 1).getValues().map(function (r) { return r[0]; }) : [];
    const plan = appPlanCategories_(changes, rows, ruleKeys);
    if (plan.updated + plan.autoApplied) tx.getRange(2, 3, n, 1).setValues(plan.cats);
    if (plan.newRules.length) rs.getRange(Math.max(rLast, 4) + 1, 1, plan.newRules.length, 3).setValues(plan.newRules);
    return { ok: true, updated: plan.updated, skipped: plan.skipped, rulesAdded: plan.newRules.length, autoApplied: plan.autoApplied };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 一括付け直しの中身を決める（シートに触らない純粋な関数）
 * @param {Array} changes appSetCategories と同じ
 * @param {Array<Array>} rows 取引シートの2行目から下（A〜K列）
 * @param {Array} ruleKeys 分類ルールのキーワード（A列）
 * @return {{cats:Array<Array>,updated:number,skipped:number,autoApplied:number,newRules:Array<Array>}} cats は書き戻すC列
 */
function appPlanCategories_(changes, rows, ruleKeys) {
  const cats = rows.map(function (r) { return [r[2]]; });
  const byId = new Map();
  rows.forEach(function (r, i) { const id = String(r[10]); if (id && !byId.has(id)) byId.set(id, i); });
  const known = new Set(ruleKeys.map(appNorm_));
  const newRules = [], autoKeys = [];
  let updated = 0, skipped = 0, autoApplied = 0;
  changes.forEach(function (ch) {
    const nd = appNorm_(ch.desc);
    ch.items.forEach(function (it) {
      // まず行番号を見て、取込ID（なければ利用先＋金額）が合うか確かめる。ずれていたら取込IDで探し直す
      const id = it.id ? String(it.id) : '', r = rows[it.row - 2];
      let i = -1;
      if (r && (id ? String(r[10]) === id : appNorm_(r[6]) === nd && Number(r[3]) === Number(it.amount))) i = it.row - 2;
      if (i < 0 && id && byId.has(id)) i = byId.get(id);
      // 見つからない行と、ほかで先に分類された行は飛ばす
      if (i < 0 || cats[i][0] !== '未分類') { skipped++; return; }
      cats[i][0] = ch.cat; updated++;
    });
    if (!ch.addRule || appNoMerchant_(nd)) return;
    autoKeys.push({ key: nd, cat: ch.cat });
    if (!known.has(nd)) { known.add(nd); newRules.push([String(ch.desc).trim(), ch.cat, 'アプリから追加（一括）']); }
  });
  // 同じ利用先を含む残りの未分類もまとめて付け直す
  if (autoKeys.length) cats.forEach(function (c, i) {
    if (c[0] !== '未分類') return;
    const d = appNorm_(rows[i][6]);
    const hit = autoKeys.filter(function (k) { return d.indexOf(k.key) >= 0; })[0];
    if (hit) { c[0] = hit.cat; autoApplied++; }
  });
  return { cats: cats, updated: updated, skipped: skipped, autoApplied: autoApplied, newRules: newRules };
}

/* ───────── シートを読む ───────── */

function appEnsureConf_(ss) {
  if (ss.getSheetByName(APP.CONF)) return;
  const sh = ss.insertSheet(APP.CONF);
  const L = APP.LABEL;
  sh.getRange('A1').setValue('アプリ設定').setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue('家計ダッシュボード（Webアプリ）の計算に使う値です。黄色のセルを確認してください。').setFontColor('#666666');
  sh.getRange('A4:C4').setValues([['項目', '値', '説明']]).setFontWeight('bold').setBackground('#e8eaed');
  sh.getRange('A5:C13').setValues([
    [L.close, 15, '予算の区切り。締日の翌日〜次の締日を1期とします（JCBに合わせて16日〜15日）。0は月末'],
    [L.payday, 25, '資金繰りの予定に使います'],
    [L.income, '', '定期取引の「収入」から自動。直接入力しても可'],
    [L.fixed, '', '空欄なら直近3か月の固定費をカテゴリ別に中央値をとって合計（引落が1か月ずれても影響しない）。新居に移った直後など、上書きしたい時だけ入力'],
    [L.repay, '', '定期取引のカテゴリ「借入・返済」から自動。直接入力しても可'],
    [L.saving, 0, '毎月残したい額'],
    [L.varOverride, '', '空欄なら 手取り − 固定費 − 返済 − 貯蓄目標'],
    [L.cards, 'JCBプラチナNL', '資金繰りで引落額を見込むカード（カンマ区切り）。「突合」に明細金額を入れるとその額を使います'],
    [L.buffer, 50000, '資金繰りで、口座の合計がこれを下回らないように計算します'],
  ]);
  sh.getRange('B7').setFormula('=IFERROR(SUMIFS(\'定期取引\'!$D:$D,\'定期取引\'!$B:$B,"収入",\'定期取引\'!$H:$H,TRUE),0)');
  sh.getRange('B9').setFormula('=IFERROR(SUMIFS(\'定期取引\'!$D:$D,\'定期取引\'!$C:$C,"借入・返済",\'定期取引\'!$H:$H,TRUE),0)');
  sh.getRange('B5:B13').setBackground('#fff2cc').setFontColor('#1a56b4');
  sh.getRange('B7:B11').setNumberFormat('#,##0');
  sh.getRange('B13').setNumberFormat('#,##0');
  sh.setColumnWidth(1, 190); sh.setColumnWidth(2, 140); sh.setColumnWidth(3, 560);
}

function appReadRaw_(ss) {
  const tz = ss.getSpreadsheetTimeZone();
  const f = function (v) { return v instanceof Date ? appFmt_(v, tz) : v; };
  const tx = ss.getSheetByName(APP.TX);
  const last = appLastRow_(tx);
  const txv = last >= 2 ? tx.getRange(2, 1, last - 1, 12).getValues() : [];
  const set = ss.getSheetByName(APP.SET);
  const conf = {};
  const cs = ss.getSheetByName(APP.CONF);
  cs.getRange('A5:B20').getValues().forEach(function (r) { if (r[0]) conf[String(r[0])] = r[1]; });
  const rec = ss.getSheetByName(APP.REC);
  const recLast = rec ? appLastRow_(rec) : 0;
  const recon = ss.getSheetByName(APP.RECON);
  const reconLast = recon ? appLastRow_(recon) : 0;
  return {
    base: f(set.getRange(APP.BASE_CELL).getValue()),
    tx: txv.map(function (r, i) { return { row: i + 2, v: r.map(f) }; }),
    accounts: set.getRange(APP.ACCT_RANGE).getValues().filter(function (r) { return r[0]; }),
    cats: set.getRange(APP.CAT_RANGE).getValues().filter(function (r) { return r[0]; }),
    conf: conf,
    rec: recLast >= 5 ? rec.getRange(5, 1, recLast - 4, 9).getValues().map(function (r) { return r.map(f); }) : [],
    recon: reconLast >= 5 ? recon.getRange(5, 1, reconLast - 4, 12).getValues().map(function (r) { return r.map(f); }) : [],
  };
}

/* ───────── 計算（シートに触らない純粋な関数。テストしやすいように分けている） ───────── */

function appCompute_(raw, todayStr) {
  const L = APP.LABEL;
  const today = appDay_(todayStr);
  const base = appDay_(raw.base) || appDay_('2000/01/01');
  const warnings = [];

  // マスタ
  const acct = {};
  raw.accounts.forEach(function (r) {
    acct[String(r[0])] = { name: String(r[0]), side: String(r[1]), cls: String(r[2]), open: appNum_(r[3]),
      close: r[4] === '' ? null : appNum_(r[4]), pay: r[5] === '' ? null : appNum_(r[5]), payFrom: String(r[6] || '') };
  });
  const catInfo = {};
  raw.cats.forEach(function (r) {
    catInfo[String(r[0])] = { kind: String(r[1]), pl: String(r[2]), budget: r[3] === '' ? null : appNum_(r[3]) };
  });
  const plOf = function (c) { return (catInfo[c] && catInfo[c].pl) || '変動費'; };

  // 取引
  const tx = raw.tx.map(function (t) {
    const v = t.v;
    return { row: t.row, date: String(v[0] || ''), d: appDay_(v[0]), kind: String(v[1] || ''), cat: String(v[2] || ''),
      amt: appNum_(v[3]), from: String(v[4] || ''), to: String(v[5] || ''), desc: String(v[6] || ''),
      memo: String(v[7] || ''), src: String(v[8] || ''), id: String(v[10] || '') };
  }).filter(function (t) { return t.d !== null; });

  // ある日の終わり時点の残高
  function balancesAt(day) {
    const b = {};
    Object.keys(acct).forEach(function (k) { b[k] = acct[k].open; });
    tx.forEach(function (t) {
      if (t.d <= base || t.d > day) return;
      if (acct[t.to]) b[t.to] += (acct[t.to].side === '負債' ? -1 : 1) * t.amt;
      if (acct[t.from]) b[t.from] -= (acct[t.from].side === '負債' ? -1 : 1) * t.amt;
    });
    return b;
  }
  function summarize(b) {
    let assets = 0, liab = 0, cash = 0, card = 0;
    Object.keys(b).forEach(function (k) {
      const a = acct[k];
      if (a.side === '負債') liab += b[k]; else assets += b[k];
      if (a.cls === '現預金') cash += b[k];
      if (a.cls === 'カード') card += b[k];
    });
    return { assets: assets, liabilities: liab, net: assets - liab, cash: cash, card: card };
  }

  // 期（予算の区切り）
  const closeDay = appNum_(raw.conf[L.close]) || 0;
  const cyc = appCycle_(today, closeDay);
  const prevCyc = appCycle_(cyc.start - 1, closeDay);

  // 予算方式
  const income = appNum_(raw.conf[L.income]);
  const repay = appNum_(raw.conf[L.repay]);
  const saving = appNum_(raw.conf[L.saving]);
  const t0 = appYmd_(today);
  // 固定費の見込み：直近3か月（暦月）のカテゴリ別「中央値」の合計。
  // 引落の遅れなどで1か月抜けても、中央値なら他の月の額が採用される。
  const fixedMonths = [], fixedByCat = {};
  for (let k = 3; k >= 1; k--) {
    const ms = appMake_(t0.y, t0.m - k, 1), me = appMake_(t0.y, t0.m - k + 1, 1) - 1;
    if (ms <= base) continue;
    const per = {};
    let s = 0;
    tx.forEach(function (t) {
      if (t.kind !== '支出' || t.d < ms || t.d > me || plOf(t.cat) !== '固定費') return;
      s += t.amt; per[t.cat] = (per[t.cat] || 0) + t.amt; fixedByCat[t.cat] = true;
    });
    fixedMonths.push({ month: appFmt2_(ms).slice(0, 7), amount: s, per: per });
  }
  function median(a) {
    if (!a.length) return 0;
    const v = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  const fixedCats = Object.keys(fixedByCat).map(function (c) {
    return { cat: c, amount: Math.round(median(fixedMonths.map(function (m) { return m.per[c] || 0; }))) };
  }).filter(function (c) { return c.amount > 0; }).sort(function (a, b) { return b.amount - a.amount; });
  fixedMonths.forEach(function (m) { delete m.per; });
  const fixedAvg = fixedCats.reduce(function (a, c) { return a + c.amount; }, 0);
  const fixedInput = raw.conf[L.fixed];
  const fixed = fixedInput === '' || fixedInput === null || fixedInput === undefined ? fixedAvg : appNum_(fixedInput);
  const ov = raw.conf[L.varOverride];
  const varAuto = income - fixed - repay - saving;
  const varBudget = ov === '' || ov === null || ov === undefined ? varAuto : appNum_(ov);

  function spendIn(s, e) {
    const byCat = {};
    let vSum = 0, fSum = 0;
    tx.forEach(function (t) {
      if (t.kind !== '支出' || t.d < s || t.d > e) return;
      const pl = plOf(t.cat);
      if (pl === '固定費') { fSum += t.amt; return; }
      if (pl !== '変動費') return;
      vSum += t.amt;
      byCat[t.cat] = (byCat[t.cat] || 0) + t.amt;
    });
    return { variable: vSum, fixed: fSum, byCat: byCat };
  }
  const cur = spendIn(cyc.start, today);
  const prev = spendIn(prevCyc.start, prevCyc.end);
  const total = cyc.end - cyc.start + 1, elapsed = today - cyc.start + 1, left = cyc.end - today + 1;
  const remaining = varBudget - cur.variable;
  const expected = Math.round(varBudget * elapsed / total);
  const byCategory = Object.keys(cur.byCat).map(function (c) {
    return { cat: c, spent: cur.byCat[c], prev: prev.byCat[c] || 0, budget: catInfo[c] ? catInfo[c].budget : null };
  }).sort(function (a, b) { return b.spent - a.spent; });

  // 現在の残高
  const nowBal = balancesAt(today);
  const nowSum = summarize(nowBal);
  const accounts = Object.keys(nowBal).map(function (k) {
    return { name: k, side: acct[k].side, cls: acct[k].cls, balance: Math.round(nowBal[k]) };
  });
  accounts.forEach(function (a) {
    if (a.cls === '現預金' && a.balance < 0) {
      warnings.push(a.name + 'の残高がマイナス（' + appYen_(a.balance) + '）です。明細の入力漏れか、期首残高の未入力の可能性があります。');
    }
  });

  // 資金繰り（今日の翌日〜今期の引落日まで）
  const cards = String(raw.conf[L.cards] || '').split(/[,、，]/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s && acct[s] && acct[s].close !== null && acct[s].pay; });
  const mainCard = cards[0] ? acct[cards[0]] : null;
  const cycPay = mainCard ? appNextDebit_(cyc.end, mainCard.pay) : cyc.end + 30;
  const horizon = Math.max(cycPay, today + 35);
  const cashSet = {};
  Object.keys(acct).forEach(function (k) { if (acct[k].cls === '現預金') cashSet[k] = true; });
  const ids = {};
  tx.forEach(function (t) { if (t.id) ids[t.id] = true; });
  const events = [];

  raw.rec.forEach(function (r) {
    const name = String(r[0] || ''), kind = String(r[1] || ''), amt = appNum_(r[3]);
    const from = String(r[4] || ''), to = String(r[5] || ''), day = appNum_(r[6]), on = r[7] === true || r[7] === 'TRUE';
    const lastYm = String(r[8] || '').replace('/', '-');
    if (!on || !name || !amt || !day) return;
    let sign = 0;
    if (kind === '収入' && cashSet[to]) sign = 1;
    else if (kind === '支出' && cashSet[from]) sign = -1;
    else if (kind === '振替') sign = (cashSet[to] ? 1 : 0) - (cashSet[from] ? 1 : 0);
    if (!sign) return;
    for (let k = 0; k < 4; k++) {
      const dd = appMake_(t0.y, t0.m + k, Math.min(day, appDim_(t0.y, t0.m + k)));
      if (dd < today || dd > horizon) continue;
      const ym = appFmt2_(dd).slice(0, 7).replace('/', '-');
      if (lastYm === ym || ids['REC-' + ym + '-' + name]) continue;
      events.push({ d: dd, label: name, amount: sign * amt, type: sign > 0 ? 'in' : 'out', note: '定期取引' });
    }
  });

  cards.forEach(function (name) {
    const a = acct[name];
    for (let k = 0; k < 4; k++) {
      const dd = appMake_(t0.y, t0.m + k, Math.min(a.pay, appDim_(t0.y, t0.m + k)));
      if (dd < today || dd > horizon) continue;
      const pe = appCloseOf_(t0.y, t0.m + k - 1, a.close);
      const ps = appCloseOf_(t0.y, t0.m + k - 2, a.close) + 1;
      // すでに引き落とされていれば除く
      const paid = tx.some(function (t) { return t.kind === '振替' && t.to === name && Math.abs(t.d - dd) <= 3 && t.d <= today; });
      if (paid) continue;
      let amount = 0, basis = '利用額から見込み';
      const st = raw.recon.filter(function (r) { return String(r[1]) === name && appDay_(r[6]) === pe && r[8] !== '' && !isNaN(Number(r[8])); });
      if (st.length) { amount = appNum_(st[0][8]); basis = '明細金額'; }
      else {
        tx.forEach(function (t) { if (t.from === name && t.d >= ps && t.d <= pe && (t.kind === '支出' || t.kind === '振替')) amount += t.amt; });
        if (pe >= today) basis = '利用中（' + appFmt2_(ps).slice(5) + '〜' + appFmt2_(pe).slice(5) + '）';
        else basis = '利用額から見込み（' + appFmt2_(ps).slice(5) + '〜' + appFmt2_(pe).slice(5) + '）';
      }
      events.push({ d: dd, label: name + ' 引落', amount: -Math.round(amount), type: 'card', note: basis, open: pe >= today });
    }
  });

  events.sort(function (a, b) { return a.d - b.d || b.amount - a.amount; });
  let run = nowSum.cash, minBal = nowSum.cash, minDay = today;
  events.forEach(function (e) {
    run += e.amount;
    e.balance = Math.round(run);
    if (run < minBal) { minBal = run; minDay = e.d; }
  });
  const buffer = appNum_(raw.conf[L.buffer]);
  const cashRoom = Math.round(minBal - buffer);

  // 月ごとの推移（月末残高・収支）
  const history = [];
  const startM = appYmd_(base + 1);
  for (let k = 0; ; k++) {
    const ms = appMake_(startM.y, startM.m + k, 1);
    if (ms > today) break;
    const me = Math.min(appMake_(startM.y, startM.m + k + 1, 1) - 1, today);
    const s = summarize(balancesAt(me));
    let inc = 0, fx = 0, vr = 0;
    tx.forEach(function (t) {
      if (t.d < ms || t.d > me) return;
      if (t.kind === '収入') inc += t.amt;
      else if (t.kind === '支出') { if (plOf(t.cat) === '固定費') fx += t.amt; else if (plOf(t.cat) === '変動費') vr += t.amt; }
    });
    history.push({ month: appFmt2_(ms).slice(0, 7), partial: me === today && today < appMake_(startM.y, startM.m + k + 1, 1) - 1,
      assets: Math.round(s.assets), liabilities: Math.round(s.liabilities), net: Math.round(s.net), cash: Math.round(s.cash), card: Math.round(s.card),
      income: Math.round(inc), fixed: Math.round(fx), variable: Math.round(vr), balance: Math.round(inc - fx - vr) });
  }

  // 取引の一覧
  const sorted = tx.slice().sort(function (a, b) { return b.d - a.d || b.row - a.row; });
  const pick = function (t) { return { row: t.row, id: t.id, date: t.date, kind: t.kind, cat: t.cat, amount: t.amt, from: t.from, to: t.to, desc: t.desc, src: t.src }; };
  const uncats = sorted.filter(function (t) { return t.cat === '未分類'; });
  const expCats = raw.cats.filter(function (r) { return String(r[1]) === '支出'; }).map(function (r) { return String(r[0]); });

  return {
    asOf: todayStr,
    cycle: { start: appFmt2_(cyc.start), end: appFmt2_(cyc.end), pay: mainCard ? appFmt2_(cycPay) : '', card: cards[0] || '',
      total: total, elapsed: elapsed, left: left },
    budget: { income: income, fixed: fixed, fixedAuto: fixedInput === '' || fixedInput === null || fixedInput === undefined,
      fixedMonths: fixedMonths, fixedCats: fixedCats, repay: repay, saving: saving, variable: varBudget, variableAuto: varBudget === varAuto,
      spent: cur.variable, fixedSpent: cur.fixed, remaining: remaining, perDay: left > 0 ? Math.floor(remaining / left) : remaining,
      expected: expected, prevSpent: prev.variable, prevStart: appFmt2_(prevCyc.start), prevEnd: appFmt2_(prevCyc.end), byCategory: byCategory },
    cash: { now: Math.round(nowSum.cash), buffer: buffer, min: Math.round(minBal), minDate: appFmt2_(minDay), room: cashRoom,
      horizon: appFmt2_(horizon),
      events: events.map(function (e) { return { date: appFmt2_(e.d), label: e.label, amount: e.amount, type: e.type, note: e.note, balance: e.balance }; }) },
    finance: { assets: Math.round(nowSum.assets), liabilities: Math.round(nowSum.liabilities), net: Math.round(nowSum.net),
      cash: Math.round(nowSum.cash), card: Math.round(nowSum.card), accounts: accounts, history: history },
    tx: { uncategorized: uncats.slice(0, 300).map(pick), uncategorizedCount: uncats.length, recent: sorted.slice(0, APP.RECENT).map(pick),
      categories: expCats, uncatGroups: appUncatGroups_(tx, uncats, expCats) },
    warnings: warnings,
  };
}

/* ───────── 未分類のまとめと、カテゴリの推定（シートに触らない） ───────── */

// 店名が入らない利用先。まとめずに1件ずつ出し、分類ルールにも追加しない
const APP_NO_MERCHANT = ['海外利用分'];
// 店名からカテゴリを推定する手がかり（上から順に見る。足すときはここに足す）
const APP_SUGGEST = [
  { cat: '外食', keys: ['エア-', 'スクエア', 'カフエ', 'コ-ヒ-', 'バ-ガ-', 'ラ-メン', 'スシ', 'ヤキトリ', 'イザカヤ', 'シヨクドウ',
    'レストラン', 'ダイニング', 'バル', 'ビストロ', 'ピツツエリア', 'サカバ', 'ベ-カリ-'] },
  { cat: '食費', keys: ['自販機'] },
  { cat: '特別費', keys: ['ホテル', 'ホステル'] },
  { cat: 'サブスク', keys: ['海外利用分'] },
];
// 外食でも1件あたりこの額以上なら、飲み会・会食とみて交際費を候補にする
const APP_SUGGEST_PARTY = { from: '外食', to: '交際費', min: 10000 };

function appNoMerchant_(descNorm) {
  return !descNorm || APP_NO_MERCHANT.some(function (k) { return descNorm.indexOf(appNorm_(k)) >= 0; });
}
/** 推定で比べるときの表記（長音とハイフン、小さいカナと大きいカナを同じとみなす） */
function appLoose_(s) {
  const small = 'ァィゥェォッャュョヮ', big = 'アイウエオツヤユヨワ';
  return appNorm_(s).replace(/[ー‐‑–—―−]/g, '-').replace(/[ァィゥェォッャュョヮ]/g, function (c) { return big.charAt(small.indexOf(c)); });
}
/**
 * 推定カテゴリ。known は「正規化した利用先 → 過去にいちばん多く付けたカテゴリ」
 * @return {{cat:string,reason:string}} 候補がなければ cat は空
 */
function appSuggest_(descNorm, amount, known) {
  let cat = (known && known[descNorm]) || '', reason = cat ? '前にも「' + cat + '」に分類' : '';
  if (!cat) {
    const d = appLoose_(descNorm);
    APP_SUGGEST.some(function (g) {
      const hit = g.keys.filter(function (k) { return d.indexOf(appLoose_(k)) >= 0; })[0];
      if (hit) { cat = g.cat; reason = '店名に「' + hit + '」を含む'; }
      return !!hit;
    });
  }
  const p = APP_SUGGEST_PARTY;
  if (cat === p.from && amount >= p.min) { cat = p.to; reason = '1件あたり' + appYen_(p.min) + '以上の' + p.from; }
  return { cat: cat, reason: reason };
}
/** 未分類を利用先ごとにまとめる。uncats は新しい順、categories は支出のカテゴリ */
function appUncatGroups_(tx, uncats, categories) {
  const seen = {}, known = {};
  tx.forEach(function (t) {
    if (!t.desc || t.cat === '未分類' || categories.indexOf(t.cat) < 0) return;
    const k = appNorm_(t.desc);
    if (!seen[k]) seen[k] = {};
    seen[k][t.cat] = (seen[k][t.cat] || 0) + 1;
  });
  Object.keys(seen).forEach(function (k) {
    known[k] = Object.keys(seen[k]).sort(function (a, b) { return seen[k][b] - seen[k][a]; })[0];
  });
  const byKey = {}, groups = [];
  uncats.forEach(function (t) {
    const key = appNorm_(t.desc), solo = appNoMerchant_(key);
    let g = solo ? null : byKey[key];
    if (!g) {
      g = { key: key, desc: t.desc, count: 0, total: 0, first: t.date, last: t.date, items: [], suggest: '', suggestReason: '', noMerchant: solo };
      groups.push(g);
      if (!solo) byKey[key] = g;
    }
    g.count++; g.total += t.amt; g.first = t.date;
    g.items.push({ row: t.row, id: t.id, date: t.date, amount: t.amt });
  });
  groups.forEach(function (g) {
    const s = appSuggest_(g.key, g.total / g.count, known);
    if (s.cat && s.cat !== '未分類' && categories.indexOf(s.cat) >= 0) { g.suggest = s.cat; g.suggestReason = s.reason; }
  });
  return groups.sort(function (a, b) { return b.total - a.total; });
}

/* ───────── 日付・数値の小物（日付は「1970/1/1からの日数」で扱う） ───────── */

function appDay_(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return s;
  const m = String(s).match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 864e5) : null;
}
function appMake_(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 864e5); }
function appYmd_(n) { const t = new Date(n * 864e5); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
function appDim_(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function appFmt2_(n) { const t = appYmd_(n); return t.y + '/' + ('0' + t.m).slice(-2) + '/' + ('0' + t.d).slice(-2); }
function appFmt_(d, tz) { return Utilities.formatDate(d, tz || 'Asia/Tokyo', 'yyyy/MM/dd'); }
/** (y, m) 月の締め日（0や月末を超える値は月末） */
function appCloseOf_(y, m, c) {
  const nm = appMake_(y, m, 1), t = appYmd_(nm);
  const dim = appDim_(t.y, t.m);
  return appMake_(t.y, t.m, !c || c >= dim ? dim : c);
}
/** 今日を含む期（締日の翌日〜締日） */
function appCycle_(day, c) {
  const t = appYmd_(day);
  let end = appCloseOf_(t.y, t.m, c);
  if (end < day) end = appCloseOf_(t.y, t.m + 1, c);
  const e = appYmd_(end);
  const start = appCloseOf_(e.y, e.m - 1, c) + 1;
  return { start: start, end: end };
}
/** 締め日 end の利用分が引き落とされる日（翌月の引落日） */
function appNextDebit_(end, pay) {
  const e = appYmd_(end);
  const t = appYmd_(appMake_(e.y, e.m + 1, 1));
  return appMake_(t.y, t.m, Math.min(pay, appDim_(t.y, t.m)));
}
function appNum_(v) {
  if (typeof v === 'number') return v;
  const s = String(v === null || v === undefined ? '' : v).replace(/[,¥円\s]/g, '');
  if (!s || s === '-') return 0;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ''));
  return isNaN(n) ? 0 : (neg ? -n : n);
}
function appYen_(n) { return (n < 0 ? '−' : '') + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP'); }
function appNorm_(s) { return String(s || '').normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim(); }
function appLastRow_(sh) {
  const v = sh.getRange(1, 1, sh.getMaxRows(), 1).getValues();
  for (let i = v.length - 1; i >= 0; i--) if (v[i][0] !== '' && v[i][0] !== null) return i + 1;
  return 1;
}
