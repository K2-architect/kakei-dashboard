/**
 * 共同家計簿 → 個人家計簿 一方向連携
 *
 * 個人家計簿の［拡張機能］→［Apps Script］で、左の「ファイル」の＋から「スクリプト」を追加し、
 * このファイルの全文を貼って保存してください（既存の kakeibo.gs はそのまま）。
 * 関数名はすべて kyodo で始まり、kakeibo.gs とは重なりません。onOpen も使いません。
 *
 * 初回だけ：エディタ上部の関数選択で kyodoSetup を選んで［実行］→ 権限を許可。
 *
 * 連携の考え方（個人家計簿の中）
 *   口座「共同生活（精算）」（分類＝立替金）を経由させます。残高がプラス＝パートナーから受け取る額、マイナス＝払う額。
 *   ・自分の負担分 … 支出（出金元＝共同生活）。金額は共同家計簿の「1人目の負担」列（L列）、カテゴリは共同家計簿のカテゴリ
 *   ・自分が払った共通費 … 振替（自分の口座 → 共同生活）で全額
 *       共同家計簿の「支払方法」（クレジットカード・現金など2人共通の分類）を、「共同連携」シートの対応表で自分の口座に変換します
 *       JCBなどメールで自動取込されるカードは、取込済みの利用行を探して振替に書き換えます（二重計上を防ぐため）
 *   ・精算 … 振替（共同生活 ⇄ 口座）。「渡し方」を対応表で口座に変換（空欄は既定の口座）
 *   共同家計簿から作った行は 取込ID が「KY-」で始まります。共同家計簿を直せば次の連携で個人家計簿も直ります
 *   （個人家計簿側で直接直しても、次の連携で共同家計簿の内容に戻ります）。
 *
 * 前提：共同家計簿の「設定」B5（1人目）が自分。入力のL列＝1人目の負担額。
 */

const KYODO = {
  CONF: '共同連携',
  TX: '取引',
  SET: '設定',
  SRC: '共同家計簿',
  PFX: 'KY-',
  TAG: '共同:',
  S_INPUT: '入力',
  S_PAID: '精算記録',
  S_CONF: '設定',
  ACCT_ROW0: 12,      // 個人家計簿「設定」口座マスタの先頭行（A12:A21）
  ACCT_ROWS: 10,
  CAT_RANGE: 'J12:K51',
  MAP_HEAD: 'J4',     // 支払方法の対応表（J4:L20）
  MAP_ROWS: 'J5:K20',
  BLANK: '（空欄）',
  LABEL: {
    url: '共同家計簿のURL',
    clearing: '精算用の口座',
    defAcct: '精算でお金が出入りする口座（既定）',
    email: 'メールで自動取込されるカード',
    tol: 'カード明細と照合する日数（±）',
    start: '連携開始日',
    last: '最終連携日時',
    result: '最終結果',
  },
  // 対応表の初期値（共同家計簿の支払方法 → この家計簿の口座）
  MAP_DEFAULT: [
    ['（空欄）', 'JCBプラチナNL', '支払方法が空欄のとき'],
    ['クレジットカード', 'JCBプラチナNL', '別のカードで払ったら、共同家計簿のメモに書いて個人側で直す'],
    ['現金', '現金', ''],
    ['口座引落・振込', '住信ドコモネット銀行', ''],
    ['電子マネー・QR', '現金', 'PayPayなどは個人家計簿では現金扱い'],
    ['その他', '現金', ''],
  ],
};

/* ───────── 初期設定（初回だけ実行。再実行しても入力済みの値は消えません） ───────── */

function kyodoSetup() {
  const ss = SpreadsheetApp.getActive();
  const L = KYODO.LABEL;

  // 1) 共同連携シート
  let sh = ss.getSheetByName(KYODO.CONF);
  if (!sh) {
    sh = ss.insertSheet(KYODO.CONF);
    sh.getRange('A1').setValue('共同家計簿との連携').setFontSize(14).setFontWeight('bold');
    sh.getRange('A2').setValue('共同家計簿 → この家計簿 の一方向です。黄色のセルを入れてから、メニュー［共同家計簿連携］→［今すぐ連携］。毎朝8時台にも自動で連携します。')
      .setFontColor('#666666');
    sh.getRange('A4:C4').setValues([['項目', '値', '説明']]).setFontWeight('bold').setBackground('#e8eaed');
    sh.getRange('A5:C13').setValues([
      [L.url, '', '共同家計簿のスプレッドシートのURL'],
      [L.clearing, '共同生活（精算）', '「設定」の口座マスタに同じ名前の口座が必要（初期設定で追加済み）'],
      [L.defAcct, '住信ドコモネット銀行', '精算記録の「渡し方」が空欄のときに使う口座'],
      [L.email, 'JCBプラチナNL', 'この口座で払った共通費は、取込済みの利用行を探して書き換えます（複数はカンマ区切り）'],
      [L.tol, 3, '利用日が何日ずれていても同じ利用とみなすか'],
      [L.start, '', '空欄＝すべて。この日より前の共通費は連携しません'],
      [L.last, '', '自動'],
      [L.result, '', '自動'],
      ['', '', ''],
    ]);
    sh.getRange('B5:B10').setBackground('#fff2cc').setFontColor('#1a56b4');
    sh.getRange('B10').setNumberFormat('yyyy/mm/dd');
    sh.getRange('B11').setNumberFormat('yyyy/mm/dd hh:mm');
    sh.setColumnWidth(1, 250); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 520);
    sh.getRange('A15').setValue('照合待ち（自分がカードで払った共通費のうち、カードの利用行がまだ見つからないもの）').setFontWeight('bold');
    sh.getRange('A16:F16').setValues([['日付', '金額', '口座', '内容', 'ID', '経過日数']]).setFontWeight('bold').setBackground('#e8eaed');
    sh.getRange('H15').setValue('注意').setFontWeight('bold');
    sh.getRange('A40').setValue('照合待ちが続くときは、取引シートの該当するカード利用行の「メモ」に「共同:ID」（例 共同:3f9a1c2b7d）と書くと手動で結び付けられます。金額が違う（海外利用など）ときに使ってください。')
      .setFontColor('#666666');
  }
  sh.getRange('C7').setValue('精算記録の「渡し方」が空欄のときに使う口座');
  sh.getRange('C16').setValue('口座');

  // 1-2) 支払方法の対応表（J4:L20）。すでに入っていれば触らない
  if (sh.getRange(KYODO.MAP_HEAD).getValue() === '') {
    sh.getRange('J3').setValue('支払方法の対応（自分が払ったとき・精算の渡し方）').setFontWeight('bold');
    sh.getRange('J4:L4').setValues([['共同家計簿の支払方法', 'この家計簿の口座', 'メモ']]).setFontWeight('bold').setBackground('#e8eaed');
    sh.getRange(5, 10, KYODO.MAP_DEFAULT.length, 3).setValues(KYODO.MAP_DEFAULT);
    sh.getRange(5, 11, 16, 1).setBackground('#fff2cc').setFontColor('#1a56b4');
    sh.getRange('J21').setValue('口座は「設定」の口座マスタと同じ名前にしてください。対応がない支払方法の行は連携せず「注意」に出ます。').setFontColor('#666666');
    sh.setColumnWidth(10, 170); sh.setColumnWidth(11, 200); sh.setColumnWidth(12, 320);
  }
  const set0 = ss.getSheetByName(KYODO.SET);
  sh.getRange(5, 11, 16, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(set0.getRange(KYODO.ACCT_ROW0, 1, KYODO.ACCT_ROWS, 1), true).setAllowInvalid(false).build());

  // 2) 口座マスタに精算用口座を追加
  const conf = kyodoReadConfig_(ss);
  const set = ss.getSheetByName(KYODO.SET);
  const acct = set.getRange(KYODO.ACCT_ROW0, 1, KYODO.ACCT_ROWS, 8).getValues();
  const has = acct.some(function (r) { return r[0] === conf.clearing; });
  let added = '';
  if (!has) {
    const i = acct.findIndex(function (r) { return r[0] === '' || r[0] === null; });
    if (i < 0) throw new Error('「設定」の口座マスタ（A12:A21）に空きがありません。1行空けてから再実行してください。');
    set.getRange(KYODO.ACCT_ROW0 + i, 1, 1, 8).setValues([[conf.clearing, '資産', '立替金', 0, '', '', '',
      'パートナーとの共通費の精算。プラス＝受け取る額、マイナス＝払う額']]);
    added = '「設定」の口座マスタに「' + conf.clearing + '」を追加しました。';
  }

  // 3) トリガー（毎朝の連携・メニュー）
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'kyodoSync' || f === 'kyodoOnOpen') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('kyodoSync').timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger('kyodoOnOpen').forSpreadsheet(ss).onOpen().create();
  kyodoOnOpen();

  ss.setActiveSheet(sh);
  const done = '初期設定が完了しました。' + added + (conf.url ? 'メニュー［共同家計簿連携］→［今すぐ連携］で動作を確認してください。'
    : '「共同連携」シートのB5に共同家計簿のURLを貼り、メニュー［共同家計簿連携］→［今すぐ連携］を実行してください。');
  sh.getRange('B12').setValue(done);
  kyodoAlert_(done);
}

function kyodoOnOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('共同家計簿連携')
      .addItem('今すぐ連携', 'kyodoSyncManual')
      .addItem('連携の状況を見る', 'kyodoShowConf')
      .addSeparator()
      .addItem('初期設定をやり直す', 'kyodoSetup')
      .addToUi();
  } catch (e) { /* UIがない実行（トリガー）では何もしない */ }
}

function kyodoShowConf() {
  const ss = SpreadsheetApp.getActive();
  ss.setActiveSheet(ss.getSheetByName(KYODO.CONF));
}

/* ───────── 連携 ───────── */

function kyodoSync() { kyodoRun_(false); }
function kyodoSyncManual() { kyodoRun_(true); }

function kyodoRun_(interactive) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(60 * 1000)) {
    if (interactive) kyodoAlert_('ほかの処理（JCBメールの取込など）が実行中です。少し待ってからもう一度実行してください。');
    return;
  }
  const ss = SpreadsheetApp.getActive();
  try {
    const conf = kyodoReadConfig_(ss);
    if (!conf.url) throw new Error('「共同連携」シートに共同家計簿のURLを入れてください。');
    const shared = kyodoReadShared_(conf);
    const personal = kyodoReadPersonal_(ss);
    const plan = kyodoPlan_({
      me: shared.me,
      partner: shared.partner,
      clearing: conf.clearing,
      defAcct: conf.defAcct,
      meansMap: conf.meansMap,
      accts: personal.accts,
      emailAccts: conf.emailAccts,
      tolDays: conf.tolDays,
      startDay: conf.startDate ? kyodoDay_(conf.startDate) : null,
      todayDay: kyodoDay_(new Date()),
      cats: personal.cats,
      inputs: shared.inputs,
      paids: shared.paids,
      tx: personal.tx,
      now: new Date(),
    });
    plan.warnings = shared.warnings.concat(plan.warnings);
    kyodoApply_(ss, plan);
    const s = plan.stats;
    const msg = '追加' + s.add + '・更新' + s.upd + '・削除' + s.del + '・カード行の書き換え' + s.link +
      '・元に戻し' + s.unlink + '／照合待ち' + plan.pending.length + '件' + (plan.warnings.length ? '／注意' + plan.warnings.length + '件' : '');
    kyodoWriteStatus_(ss, msg, plan);
    if (interactive) ss.toast(msg, '共同家計簿連携', 8);
  } catch (err) {
    kyodoWriteStatus_(ss, 'エラー：' + err.message, null);
    if (interactive) kyodoAlert_('連携できませんでした。\n' + err.message);
    else throw err;
  } finally {
    lock.releaseLock();
  }
}

/* 個人家計簿の設定を読む */
function kyodoReadConfig_(ss) {
  const sh = ss.getSheetByName(KYODO.CONF);
  const map = {};
  if (sh) sh.getRange('A5:B13').getValues().forEach(function (r) { if (r[0]) map[r[0]] = r[1]; });
  const L = KYODO.LABEL;
  const email = String(map[L.email] || 'JCBプラチナNL').split(/[,、，]/).map(function (s) { return s.trim(); }).filter(String);
  // 支払方法 → 口座 の対応表
  const meansMap = {};
  const rows = sh ? sh.getRange(KYODO.MAP_ROWS).getValues() : [];
  rows.forEach(function (r) {
    const k = String(r[0] || '').trim(), v = String(r[1] || '').trim();
    if (!k || !v) return;
    meansMap[k === KYODO.BLANK ? '' : k] = v;
  });
  if (!rows.some(function (r) { return r[0] !== '' && r[0] !== null; })) {
    KYODO.MAP_DEFAULT.forEach(function (r) { meansMap[r[0] === KYODO.BLANK ? '' : r[0]] = r[1]; });
  }
  return {
    url: String(map[L.url] || '').trim(),
    clearing: String(map[L.clearing] || '共同生活（精算）').trim(),
    defAcct: String(map[L.defAcct] || '住信ドコモネット銀行').trim(),
    emailAccts: email,
    meansMap: meansMap,
    tolDays: Number(map[L.tol]) >= 0 && map[L.tol] !== '' ? Number(map[L.tol]) : 3,
    startDate: kyodoIsDate_(map[L.start]) ? map[L.start] : null,
  };
}

/* 共同家計簿を読む（IDが抜けている行にだけIDを書き込む） */
function kyodoReadShared_(conf) {
  const m = conf.url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const sss = m ? SpreadsheetApp.openById(m[1]) : SpreadsheetApp.openById(conf.url);
  const warnings = [];
  const sc = sss.getSheetByName(KYODO.S_CONF);
  const inp = sss.getSheetByName(KYODO.S_INPUT);
  const paid = sss.getSheetByName(KYODO.S_PAID);
  if (!sc || !inp || !paid) throw new Error('共同家計簿に「入力」「精算記録」「設定」シートが見つかりません。共同家計簿で［初期設定］を実行してください。');
  const cv = sc.getRange('A5:B6').getValues();
  if (/基本負担率|既定の支払手段/.test(String(sc.getRange('A7').getValue()) + String(sc.getRange('A9').getValue()))) {
    throw new Error('共同家計簿が旧版のままです。共同家計簿のスクリプトを新しい版に差し替えて［初期設定］を実行してください。');
  }
  const me = String(cv[0][1] || '').trim();
  const partner = String(cv[1][1] || '').trim();
  if (!me) throw new Error('共同家計簿の「設定」で1人目の名前（B5）が空です。');

  const now = new Date();
  // 入力 A〜M（L＝1人目の負担）
  const inputs = [];
  const lastI = kyodoLastRow_(inp, 8);
  if (lastI >= 2) {
    const v = inp.getRange(2, 1, lastI - 1, 13).getValues();
    let fixed = false;
    v.forEach(function (r, i) {
      const has = r.slice(0, 8).some(function (x) { return x !== '' && x !== null; });
      if (!has) return;
      if (!r[8]) { r[8] = kyodoNewId_(); r[9] = now; fixed = true; }
      if (!kyodoIsDate_(r[0]) || typeof r[2] !== 'number' || !r[1]) {
        warnings.push('共同家計簿「入力」' + (i + 2) + '行目：日付・払った人・金額のどれかが空か形式違いのため連携していません');
        return;
      }
      inputs.push({ id: String(r[8]), date: r[0], payer: String(r[1]).trim(), amount: r[2], cat: String(r[3] || '').trim(),
        desc: String(r[4] || '').trim(), share: r[5], means: String(r[6] || '').trim(), memo: String(r[7] || ''),
        share1: r[11], row: i + 2 });
    });
    if (fixed) inp.getRange(2, 9, v.length, 2).setValues(v.map(function (r) { return [r[8], r[9]]; }));
  }
  // 精算記録 A〜I（F＝渡し方）
  const paids = [];
  const lastP = kyodoLastRow_(paid, 3);
  if (lastP >= 2) {
    const v = paid.getRange(2, 1, lastP - 1, 9).getValues();
    const disp = paid.getRange(2, 2, lastP - 1, 1).getDisplayValues();
    let fixed = false;
    v.forEach(function (r, i) {
      const has = [0, 1, 2, 4, 5, 6].some(function (j) { return r[j] !== '' && r[j] !== null; });
      if (!has) return;
      if (!r[7]) { r[7] = kyodoNewId_(); r[8] = now; fixed = true; }
      if (!kyodoIsDate_(r[0]) || typeof r[4] !== 'number' || !r[2]) {
        warnings.push('共同家計簿「精算記録」' + (i + 2) + '行目：日付・払った人・金額のどれかが空か形式違いのため連携していません');
        return;
      }
      paids.push({ id: String(r[7]), date: r[0], month: disp[i][0], payer: String(r[2]).trim(), amount: r[4],
        means: String(r[5] || '').trim(), memo: String(r[6] || ''), row: i + 2 });
    });
    if (fixed) paid.getRange(2, 8, v.length, 2).setValues(v.map(function (r) { return [r[7], r[8]]; }));
  }
  return { me: me, partner: partner, inputs: inputs, paids: paids, warnings: warnings };
}

/* 個人家計簿の取引・カテゴリ・口座を読む */
function kyodoReadPersonal_(ss) {
  const tx = ss.getSheetByName(KYODO.TX);
  const last = kyodoLastRow_(tx, 1);
  const rows = [];
  if (last >= 2) {
    const v = tx.getRange(2, 1, last - 1, 12).getValues();
    const memo = tx.getRange(2, 8, last - 1, 1).getDisplayValues();
    v.forEach(function (r, i) { rows.push({ row: i + 2, v: r, memo: memo[i][0] }); });
  }
  const set = ss.getSheetByName(KYODO.SET);
  const cats = set.getRange(KYODO.CAT_RANGE).getValues()
    .filter(function (r) { return r[0] && r[1] === '支出'; }).map(function (r) { return String(r[0]); });
  const accts = set.getRange(KYODO.ACCT_ROW0, 1, KYODO.ACCT_ROWS, 1).getValues()
    .map(function (r) { return String(r[0] || '').trim(); }).filter(String);
  return { tx: rows, cats: cats, accts: accts };
}

/* ───────── 差分の計算（シートに触らない純粋な関数） ───────── */

/** 負担の文字から1人目の割合を出す（共同家計簿のL列が読めないときの予備） */
function kyodoShareRate_(share, me, partner) {
  if (share === '' || share === null || share === undefined) return 0.5;
  if (typeof share === 'number') return share > 1 ? share / 100 : share;
  const s = String(share).normalize('NFKC').trim();
  if (s === '' || s === '折半') return 0.5;
  if (s === me + 'だけ') return 1;
  if (partner && s === partner + 'だけ') return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (m && Number(m[1]) + Number(m[2]) > 0) return Number(m[1]) / (Number(m[1]) + Number(m[2]));
  return null;
}

/** 支払方法・渡し方を自分の口座に変える。対応表 → 口座名そのもの の順。見つからなければ null */
function kyodoAccount_(means, d) {
  const k = String(means || '').trim();
  if (Object.prototype.hasOwnProperty.call(d.meansMap, k)) return d.meansMap[k];
  if (k && d.accts.indexOf(k) >= 0) return k;
  return null;
}

function kyodoPlan_(d) {
  const P = KYODO.PFX, TAG = KYODO.TAG;
  const catSet = {};
  d.cats.forEach(function (c) { catSet[c] = true; });
  const emailSet = {};
  d.emailAccts.forEach(function (a) { emailSet[a] = true; });
  const warnings = [], pending = [];
  const desired = {}; // 取込ID → A〜I の9列
  const order = [];
  const keepLink = {}; // 取引の行番号 → { id, ...書き換え後 }
  const stats = { add: 0, upd: 0, del: 0, link: 0, unlink: 0 };

  // 個人家計簿の索引
  const kyRows = {}; // 取込ID → [行]
  const linked = {}; // 共同ID → [行]
  d.tx.forEach(function (t) {
    const kid = String(t.v[10] || '');
    if (kid.indexOf(P) === 0) {
      (kyRows[kid] = kyRows[kid] || []).push(t);
      return;
    }
    const lk = kyodoParseLink_(t.memo);
    if (lk) (linked[lk.id] = linked[lk.id] || []).push(t);
  });
  const used = {}; // 照合に使った行

  function want(kid, vals) {
    if (!desired[kid]) order.push(kid);
    desired[kid] = vals;
  }

  d.inputs.forEach(function (it) {
    const day = kyodoDay_(it.date);
    if (d.startDay !== null && day < d.startDay) return;
    const F = Math.round(Number(it.amount));
    let S;
    if (typeof it.share1 === 'number' && !isNaN(it.share1)) {
      S = Math.round(it.share1);
    } else {
      const rate = kyodoShareRate_(it.share, d.me, d.partner);
      if (rate === null) {
        warnings.push('共同家計簿「入力」' + it.row + '行目：負担「' + it.share + '」が読めないため連携していません');
        return;
      }
      S = Math.round(F * rate);
    }
    const pct = F ? Math.round(S / F * 100) : 0;
    const cat = catSet[it.cat] ? it.cat : '未分類';
    const desc = '【共同】' + (it.desc || it.cat || '共通費');
    const isMe = it.payer === d.me;
    const shareMemo = (isMe ? '自分が支払' : it.payer + 'が支払') + '／負担' + pct + '%（総額' + F.toLocaleString('ja-JP') + '円）';
    let ready = true;

    if (isMe) {
      const acct = kyodoAccount_(it.means, d);
      if (!acct) {
        warnings.push('共同家計簿「入力」' + it.row + '行目：支払方法「' + (it.means || KYODO.BLANK) + '」に対応する口座が「共同連携」の対応表にありません');
        ready = false;
      } else if (emailSet[acct]) {
        // 取込済みのカード利用行と結び付ける
        const mine = (linked[it.id] || []).filter(function (t) { return t.v[4] === acct; });
        let target = mine[0] || null;
        if (!target) {
          let best = null, bestDiff = 1e9;
          d.tx.forEach(function (t) {
            if (used[t.row] || String(t.v[10] || '').indexOf(P) === 0) return;
            if (kyodoParseLink_(t.memo)) return;
            if (t.v[1] !== '支出' || t.v[4] !== acct || (t.v[5] !== '' && t.v[5] !== null)) return;
            if (Math.round(Number(t.v[3])) !== F || !kyodoIsDate_(t.v[0])) return;
            const diff = Math.abs(kyodoDay_(t.v[0]) - day);
            if (diff <= d.tolDays && diff < bestDiff) { best = t; bestDiff = diff; }
          });
          target = best;
        }
        if (target) {
          used[target.row] = true;
          const lk = kyodoParseLink_(target.memo);
          const orig = lk && lk.orig ? lk.orig : (target.v[2] && target.v[2] !== '立替' ? target.v[2] : '未分類');
          const base = kyodoStripLink_(target.memo);
          const memo = (base ? base + ' ' : '') + TAG + it.id + '|元:' + orig;
          keepLink[target.row] = { t: target, B: '振替', C: '立替', F: d.clearing, H: memo, isNew: !lk };
          if (Math.round(Number(target.v[3])) !== F) {
            warnings.push('「' + (it.desc || it.cat) + '」：共同家計簿は' + F + '円、カード利用行は' + target.v[3] + '円です（差額は精算用口座の残高に残ります）');
          }
        } else {
          ready = false;
          pending.push({ date: it.date, amount: F, means: acct, desc: it.desc || it.cat, id: it.id, days: d.todayDay - day });
        }
      } else {
        want(P + it.id + '-P', [it.date, '振替', '立替', F, acct, d.clearing, desc, '共通費を立替（全額）', KYODO.SRC]);
      }
    }
    if (ready && S !== 0) {
      want(P + it.id + '-S', [it.date, '支出', cat, S, d.clearing, '', desc, shareMemo, KYODO.SRC]);
    }
  });

  d.paids.forEach(function (p) {
    if (d.startDay !== null && kyodoDay_(p.date) < d.startDay) return;
    const acct = p.means ? kyodoAccount_(p.means, d) : d.defAcct;
    if (!acct) {
      warnings.push('共同家計簿「精算記録」' + p.row + '行目：渡し方「' + p.means + '」に対応する口座が「共同連携」の対応表にありません');
      return;
    }
    const A = Math.round(Number(p.amount));
    const m = p.month ? p.month + '分' : '';
    if (p.payer === d.me) {
      want(P + p.id + '-T', [p.date, '振替', '立替', A, acct, d.clearing, '【共同】精算 ' + m + '（支払）', p.memo, KYODO.SRC]);
    } else {
      want(P + p.id + '-T', [p.date, '振替', '立替', A, d.clearing, acct, '【共同】精算 ' + m + '（受取）', p.memo, KYODO.SRC]);
    }
  });

  // KY-行の追加・更新・削除
  const appends = [], updates = [], deletes = [];
  order.forEach(function (kid) {
    const want9 = desired[kid];
    const have = kyRows[kid] || [];
    if (!have.length) {
      appends.push(want9.concat([false, kid, d.now]));
      stats.add++;
      return;
    }
    if (!kyodoSame_(have[0].v, want9)) { updates.push({ row: have[0].row, v: want9 }); stats.upd++; }
    have.slice(1).forEach(function (t) { deletes.push(t.row); stats.del++; });
  });
  Object.keys(kyRows).forEach(function (kid) {
    if (!desired[kid]) kyRows[kid].forEach(function (t) { deletes.push(t.row); stats.del++; });
  });

  // カード利用行の書き換え・元に戻す
  const linkUpdates = [];
  Object.keys(keepLink).forEach(function (row) {
    const k = keepLink[row], v = k.t.v;
    if (v[1] !== k.B || v[2] !== k.C || v[5] !== k.F || k.t.memo !== k.H) {
      linkUpdates.push({ row: Number(row), B: k.B, C: k.C, F: k.F, H: k.H });
      stats.link++;
    }
  });
  Object.keys(linked).forEach(function (id) {
    linked[id].forEach(function (t) {
      if (keepLink[t.row]) return;
      const lk = kyodoParseLink_(t.memo);
      linkUpdates.push({ row: t.row, B: '支出', C: (lk && lk.orig) || '未分類', F: '', H: kyodoStripLink_(t.memo) });
      stats.unlink++;
    });
  });

  return { appends: appends, updates: updates, deletes: deletes, linkUpdates: linkUpdates,
    pending: pending, warnings: warnings, stats: stats };
}

function kyodoSame_(have, want9) {
  for (let i = 0; i < 9; i++) {
    const a = have[i], b = want9[i];
    if (i === 0) { if (!kyodoIsDate_(a) || kyodoDay_(a) !== kyodoDay_(b)) return false; continue; }
    if (i === 3) { if (Math.round(Number(a)) !== Math.round(Number(b))) return false; continue; }
    if (String(a === null || a === undefined ? '' : a) !== String(b === null || b === undefined ? '' : b)) return false;
  }
  return true;
}

function kyodoParseLink_(memo) {
  const m = String(memo || '').match(/共同:([A-Za-z0-9]+)(?:\|元:([^\s]+))?/);
  return m ? { id: m[1], orig: m[2] || '' } : null;
}

function kyodoStripLink_(memo) {
  return String(memo || '').replace(/\s*共同:[A-Za-z0-9]+(?:\|元:[^\s]+)?/, '').trim();
}

function kyodoIsDate_(x) {
  return Object.prototype.toString.call(x) === '[object Date]' && !isNaN(x.getTime());
}

/* 日本時間の日付番号 */
function kyodoDay_(d) {
  return Math.floor((d.getTime() + 9 * 3600 * 1000) / 86400000);
}

/* ───────── シートへの反映 ───────── */

function kyodoApply_(ss, plan) {
  const sh = ss.getSheetByName(KYODO.TX);
  plan.updates.forEach(function (u) { sh.getRange(u.row, 1, 1, 9).setValues([u.v]); });
  plan.linkUpdates.forEach(function (u) {
    sh.getRange(u.row, 2, 1, 2).setValues([[u.B, u.C]]);
    sh.getRange(u.row, 6).setValue(u.F);
    sh.getRange(u.row, 8).setValue(u.H);
  });
  plan.deletes.slice().sort(function (a, b) { return b - a; })
    .filter(function (r, i, arr) { return i === 0 || arr[i - 1] !== r; })
    .forEach(function (r) { sh.deleteRow(r); });
  if (plan.appends.length) {
    const start = kyodoLastRow_(sh, 1) + 1;
    const need = start + plan.appends.length - 1;
    if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    const n = plan.appends.length;
    sh.getRange(start, 1, n, 12).setValues(plan.appends);
    sh.getRange(start, 1, n, 1).setNumberFormat('yyyy/mm/dd');
    sh.getRange(start, 4, n, 1).setNumberFormat('#,##0');
    sh.getRange(start, 10, n, 1).insertCheckboxes();
    sh.getRange(start, 12, n, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  }
}

function kyodoWriteStatus_(ss, msg, plan) {
  const sh = ss.getSheetByName(KYODO.CONF);
  if (!sh) return;
  sh.getRange('B11').setValue(new Date());
  sh.getRange('B12').setValue(msg);
  if (!plan) return;
  sh.getRange('A17:F38').clearContent();
  if (plan.pending.length) {
    sh.getRange(17, 1, Math.min(plan.pending.length, 22), 6).setValues(plan.pending.slice(0, 22).map(function (p) {
      return [p.date, p.amount, p.means, p.desc, p.id, p.days];
    }));
    sh.getRange('A17:A38').setNumberFormat('yyyy/mm/dd');
    sh.getRange('B17:B38').setNumberFormat('#,##0');
  }
  sh.getRange('H16:H60').clearContent();
  if (plan.warnings.length) {
    sh.getRange(16, 8, Math.min(plan.warnings.length, 45), 1)
      .setValues(plan.warnings.slice(0, 45).map(function (w) { return [w]; }));
  }
}

/* ───────── 小物 ───────── */

function kyodoLastRow_(sh, cols) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const v = sh.getRange(2, 1, last - 1, cols).getValues();
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i].some(function (x) { return x !== '' && x !== null; })) return i + 2;
  }
  return 1;
}

function kyodoNewId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

// ダイアログ（alert）は使わない。エディタから実行するとスプレッドシート側でOK待ちになり、
// 誰も押さないまま6分でタイムアウトするため。右下の通知（toast）と実行ログに出すだけにする。
function kyodoAlert_(msg) {
  console.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, '共同家計簿連携', 20); } catch (e) { /* 何もしない */ }
}
