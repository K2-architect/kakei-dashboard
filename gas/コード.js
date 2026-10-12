/**
 * 家計簿 Apps Script
 * - JCBカードの利用通知メール（Gmail）を「取引」シートへ取り込む（毎朝自動）
 * - 定期取引（給与・家賃など）を毎月1回計上
 * - 突合シートに月次の行を追加
 *
 * 使い方：スプレッドシートの［拡張機能］→［Apps Script］に全文を貼り付けて保存し、
 * シートを再読み込み → メニュー［家計簿］→［初期設定（最初に1回）］を実行。
 */

const SHEET = {
  TX: '取引', SETTINGS: '設定', RULES: '分類ルール', RECURRING: '定期取引', RECON: '突合',
};
const TX_COLS = 12;                 // A:L（M:Nは自動計算列）
const COL = { DATE: 1, KIND: 2, CAT: 3, AMOUNT: 4, FROM: 5, TO: 6, DESC: 7, MEMO: 8, SOURCE: 9, CHECK: 10, ID: 11, CREATED: 12 };
const UNCATEGORIZED = '未分類';
const JCB_SENDER = 'mail@qa.jcb.co.jp';
const TRIGGER_HOUR = 7;

// ------------------------------------------------------------------ メニュー
function onOpen() {
  SpreadsheetApp.getUi().createMenu('家計簿')
    .addItem('初期設定（最初に1回）', 'setup')
    .addSeparator()
    .addItem('JCBメールを今すぐ取り込む', 'importJcbNow')
    .addItem('定期取引を計上する', 'postRecurring')
    .addItem('突合シートに月次行を追加', 'addReconRows')
    .addSeparator()
    .addItem('選択行の摘要を分類ルールに追加', 'addRuleFromSelection')
    .addItem('未分類に分類ルールを再適用', 'reapplyRules')
    .addToUi();
}

// ------------------------------------------------------------------ 初期設定
function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Asia/Tokyo');
  ss.setSpreadsheetLocale('ja_JP');

  // 取引シートの自動計算列（出金元・入金先の分類）
  const tx = ss.getSheetByName(SHEET.TX);
  const acc = "'設定'!$A$12:$C$21";
  tx.getRange('M1').setFormula(
    '={"出金元分類";ARRAYFORMULA(IF(LEN(E2:E),IFERROR(VLOOKUP(E2:E,' + acc + ',3,FALSE),"?"),))}');
  tx.getRange('N1').setFormula(
    '={"入金先分類";ARRAYFORMULA(IF(LEN(F2:F),IFERROR(VLOOKUP(F2:F,' + acc + ',3,FALSE),"?"),))}');
  tx.getRange('J2:J').clearDataValidations().insertCheckboxes();
  ss.getSheetByName(SHEET.RECURRING).getRange('H5:H100').clearDataValidations().insertCheckboxes();

  // 毎朝の自動実行
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyJob')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(TRIGGER_HOUR)
    .inTimezone('Asia/Tokyo').create();

  const r = importJcb_(true);
  SpreadsheetApp.getUi().alert(
    '初期設定が完了しました。\n' +
    '・毎朝' + TRIGGER_HOUR + '時台にJCBメールを自動で取り込みます\n' +
    '・今回の取り込み：' + r.count + '件' +
    (r.partial ? '\n・件数が多いため途中で止めました。［JCBメールを今すぐ取り込む］をもう一度実行すると続きから取り込みます' : ''));
}

// 時間主導トリガーから呼ばれる
function dailyJob() {
  importJcb_(false);
  postRecurring();
}

function importJcbNow() {
  const r = importJcb_(true);
  SpreadsheetApp.getActive().toast(r.count + '件を取り込みました' +
    (r.partial ? '（途中で停止。もう一度実行すると続きを取り込みます）' : ''), '家計簿', 10);
}

// ------------------------------------------------------------------ JCB取込
/**
 * @param {boolean} fullScan true: 取込開始日から全件確認 / false: 前回取込の10日前から
 * @return {{count:number, partial:boolean}} 追加件数と、時間切れで途中停止したか
 */
function importJcb_(fullScan) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return { count: 0, partial: false };
  const deadline = Date.now() + 4.5 * 60 * 1000;   // 実行上限6分の手前で止めて書き込む
  let partial = false;
  try {
    const ss = SpreadsheetApp.getActive();
    const tz = ss.getSpreadsheetTimeZone();
    const settings = readSettings_();
    const startDate = settings['取込開始日'];
    const card = settings['JCBカード口座名'];
    if (!(startDate instanceof Date) || !card) throw new Error('「設定」の取込開始日・JCBカード口座名を確認してください');

    let searchFrom = startDate;
    const last = settings['最終取込日時'];
    if (!fullScan && last instanceof Date) {
      const d = new Date(last.getTime() - 10 * 86400000);
      if (d > searchFrom) searchFrom = d;
    }
    const after = Utilities.formatDate(new Date(searchFrom.getTime() - 86400000), tz, 'yyyy/MM/dd');
    const query = 'from:' + JCB_SENDER + ' subject:ショッピングご利用のお知らせ after:' + after;

    const tx = ss.getSheetByName(SHEET.TX);
    const existing = new Set(readColumn_(tx, COL.ID).map(String).filter(String));
    const rules = readRules_();
    const startKey = Utilities.formatDate(startDate, tz, 'yyyy/MM/dd');
    const now = new Date();
    const rows = [];

    for (let offset = 0; ; offset += 100) {
      const threads = GmailApp.search(query, offset, 100);
      threads.forEach(th => th.getMessages().forEach(msg => {
        if (partial || Date.now() > deadline) { partial = true; return; }
        const id = msg.getId();
        if (existing.has(id) || existing.has(id + '-1')) return;
        if (!isJcbUsageMail_(msg.getFrom(), msg.getSubject())) return;
        const items = parseJcbMail(msg.getPlainBody());
        items.forEach((it, i) => {
          const rowId = items.length > 1 ? id + '-' + (i + 1) : id;
          if (existing.has(rowId) || it.date < startKey) return;
          const date = Utilities.parseDate(it.date, tz, 'yyyy/MM/dd');
          const yen = it.currency === '円';
          const memo = [it.time, yen ? '' : '外貨 ' + it.amountText + ' ' + it.currency + '：金額を明細で入力']
            .filter(String).join(' ');
          rows.push([date, '支出', yen ? classify(it.merchant, rules) : UNCATEGORIZED, yen ? it.amount : '',
            card, '', it.merchant, memo, 'JCBメール', false, rowId, now]);
          existing.add(rowId);
        });
      }));
      if (partial || threads.length < 100) break;
    }

    if (rows.length) {
      const start = lastDataRow_(tx) + 1;
      tx.getRange(start, 1, rows.length, TX_COLS).setValues(rows);
      sortTransactions_(tx);
    }
    const st = ss.getSheetByName(SHEET.SETTINGS);
    if (!partial) writeSetting_(st, '最終取込日時', now);   // 途中停止なら次回も開始日から確認する
    writeSetting_(st, '最終取込件数', rows.length);
    return { count: rows.length, partial: partial };
  } finally {
    lock.releaseLock();
  }
}

function isJcbUsageMail_(from, subject) {
  return String(from).indexOf('jcb.co.jp') >= 0 &&
    subject.indexOf('ショッピング') >= 0 && subject.indexOf('ご利用のお知らせ') >= 0;
}

/**
 * JCB利用通知の本文から利用明細を取り出す。
 * 2形式に対応：
 *  - 即時通知：【ご利用日時(日本時間)】2026/10/08 11:41 / 【ご利用金額】319円 / 【ご利用先】…
 *  - 売上到着分：◆ご利用１ 【ご利用日】2026/08/21 / 【ご利用金額】180円 / 【ご利用先】…（複数件）
 */
function parseJcbMail(body) {
  const re = /【ご利用日(?:時\(日本時間\))?】\s*(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ \t　]+(\d{1,2}:\d{2}))?\s*【ご利用金額】\s*([\d,\.]+)\s*(円|[A-Za-z]{3})?\s*【ご利用先】[ \t　]*([^\r\n]*)/g;
  const out = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const amountText = m[5];
    out.push({
      date: m[1] + '/' + ('0' + m[2]).slice(-2) + '/' + ('0' + m[3]).slice(-2),
      time: m[4] || '',
      amountText: amountText,
      amount: Number(amountText.replace(/,/g, '')),
      currency: m[6] || '円',
      merchant: m[7].replace(/[\s　]+$/, '').replace(/^[\s　]+/, ''),
    });
  }
  return out;
}

function normalize_(s) {
  return String(s).normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
}

/** 利用先を分類ルール（上から順・部分一致）でカテゴリに変換 */
function classify(merchant, rules) {
  const m = normalize_(merchant);
  for (const r of rules) {
    if (r.key && m.indexOf(r.key) >= 0) return r.cat;
  }
  return UNCATEGORIZED;
}

function readRules_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.RULES);
  const n = sh.getLastRow() - 4;
  if (n <= 0) return [];
  return sh.getRange(5, 1, n, 2).getValues()
    .filter(r => r[0] !== '' && r[1] !== '')
    .map(r => ({ key: normalize_(r[0]), cat: String(r[1]) }));
}

// ------------------------------------------------------------------ 定期取引
function postRecurring() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const sh = ss.getSheetByName(SHEET.RECURRING);
  const n = sh.getLastRow() - 4;
  if (n <= 0) return;
  const today = new Date();
  const ym = Utilities.formatDate(today, tz, 'yyyy-MM');
  const day = Number(Utilities.formatDate(today, tz, 'd'));
  const y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  const lastDay = new Date(y, mo, 0).getDate();
  const tx = ss.getSheetByName(SHEET.TX);
  const existing = new Set(readColumn_(tx, COL.ID).map(String));
  const data = sh.getRange(5, 1, n, 9).getValues();
  const rows = [];

  data.forEach((r, i) => {
    const [name, kind, cat, amount, from, to, postDay, enabled] = r;
    if (enabled !== true || !name || amount === '' || !postDay) return;
    const key = 'REC-' + ym + '-' + name;
    if (day < Math.min(postDay, lastDay) || existing.has(key)) return;
    const dateStr = ym.replace('-', '/') + '/' + ('0' + Math.min(postDay, lastDay)).slice(-2);
    rows.push([Utilities.parseDate(dateStr, tz, 'yyyy/MM/dd'), kind, cat, amount, from, to, name, '',
      '定期取引', false, key, today]);
    sh.getRange(5 + i, 9).setValue(ym);
  });
  if (rows.length) {
    tx.getRange(lastDataRow_(tx) + 1, 1, rows.length, TX_COLS).setValues(rows);
    sortTransactions_(tx);
  }
}

// ------------------------------------------------------------------ 突合
function addReconRows() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const ui = SpreadsheetApp.getUi();
  const sh = ss.getSheetByName(SHEET.RECON);
  const last = lastDataRow_(sh);
  if (last < 5) { ui.alert('突合シートの5行目（ひな形）が見つかりません'); return; }

  const months = sh.getRange(5, 1, last - 4, 1).getValues().map(r => r[0]).filter(d => d instanceof Date);
  const maxMonth = new Date(Math.max.apply(null, months));
  const next = new Date(maxMonth.getFullYear(), maxMonth.getMonth() + 1, 1);
  const res = ui.prompt('突合する月', 'yyyy/mm 形式で入力（空欄なら ' +
    Utilities.formatDate(next, tz, 'yyyy/MM') + '）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const text = res.getResponseText().trim() || Utilities.formatDate(next, tz, 'yyyy/MM');
  if (!/^\d{4}\/\d{1,2}$/.test(text)) { ui.alert('yyyy/mm 形式で入力してください'); return; }
  const month = Utilities.parseDate(text + '/01', tz, 'yyyy/MM/dd');

  const accounts = ss.getSheetByName(SHEET.SETTINGS).getRange('A12:A21').getValues()
    .map(r => r[0]).filter(String);
  const template = sh.getRange(5, 1, 1, 12).getFormulasR1C1()[0];
  const start = last + 1;
  const values = accounts.map(a => [month, a]);
  sh.getRange(start, 1, values.length, 2).setValues(values);
  const formulas = accounts.map(() => template.slice(2, 10));   // C:J
  // 明細金額（I列）は入力欄なので数式を入れない
  formulas.forEach(f => { f[6] = ''; });
  sh.getRange(start, 3, values.length, 8).setFormulasR1C1(formulas);
  sh.getRange(start, 11, values.length, 1).setValues(accounts.map(() => ['未確認']));
  sh.getRange(5, 1, 1, 12).copyTo(sh.getRange(start, 1, values.length, 12),
    SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  sh.setActiveRange(sh.getRange(start, 9));
}

// ------------------------------------------------------------------ 分類ルール
function addRuleFromSelection() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getActiveSheet();
  if (sh.getName() !== SHEET.TX) { SpreadsheetApp.getUi().alert('「取引」シートで行を選択してから実行してください'); return; }
  const range = sh.getActiveRange();
  const vals = sh.getRange(range.getRow(), 1, range.getNumRows(), TX_COLS).getValues();
  const rules = readRules_();
  const known = new Set(rules.map(r => r.key));
  const add = [];
  vals.forEach(r => {
    const desc = String(r[COL.DESC - 1]).trim(), cat = String(r[COL.CAT - 1]);
    if (!desc || !cat || cat === UNCATEGORIZED || known.has(normalize_(desc))) return;
    add.push([desc, cat, '取引から追加']);
    known.add(normalize_(desc));
  });
  if (add.length) {
    const rs = ss.getSheetByName(SHEET.RULES);
    rs.getRange(lastDataRow_(rs) + 1, 1, add.length, 3).setValues(add);
  }
  const n = reapplyRules_();
  ss.toast('ルール' + add.length + '件を追加、未分類' + n + '件を分類しました', '家計簿', 5);
}

function reapplyRules() {
  const n = reapplyRules_();
  SpreadsheetApp.getActive().toast('未分類' + n + '件を分類しました', '家計簿', 5);
}

function reapplyRules_() {
  const tx = SpreadsheetApp.getActive().getSheetByName(SHEET.TX);
  const last = lastDataRow_(tx);
  if (last < 2) return 0;
  const rules = readRules_();
  const range = tx.getRange(2, COL.CAT, last - 1, 1);
  const cats = range.getValues();
  const descs = tx.getRange(2, COL.DESC, last - 1, 1).getValues();
  let n = 0;
  cats.forEach((c, i) => {
    if (c[0] !== UNCATEGORIZED) return;
    const cat = classify(descs[i][0], rules);
    if (cat !== UNCATEGORIZED) { c[0] = cat; n++; }
  });
  if (n) range.setValues(cats);
  return n;
}

// ------------------------------------------------------------------ 共通
function readSettings_() {
  const vals = SpreadsheetApp.getActive().getSheetByName(SHEET.SETTINGS).getRange('A3:B8').getValues();
  const map = {};
  vals.forEach(r => { if (r[0]) map[String(r[0])] = r[1]; });
  return map;
}

function writeSetting_(sheet, key, value) {
  const keys = sheet.getRange('A3:A8').getValues();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) { sheet.getRange(3 + i, 2).setValue(value); return; }
  }
}

/** A列で最後に値が入っている行（ARRAYFORMULA列に影響されない） */
function lastDataRow_(sheet) {
  const vals = sheet.getRange(1, 1, sheet.getMaxRows(), 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i][0] !== '') return i + 1;
  return 1;
}

function readColumn_(sheet, col) {
  const last = lastDataRow_(sheet);
  if (last < 2) return [];
  return sheet.getRange(2, col, last - 1, 1).getValues().map(r => r[0]);
}

function sortTransactions_(tx) {
  const last = lastDataRow_(tx);
  if (last > 2) tx.getRange(2, 1, last - 1, TX_COLS).sort([{ column: COL.DATE, ascending: true }]);
}