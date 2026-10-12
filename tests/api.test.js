// API と認証のテスト（架空の値だけを使う）。実行： node tests/api.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const props = { OAUTH_CLIENT_ID: CLIENT_ID, SESSION_SECRET: 'test-secret-1', ALLOWED_EMAILS: 'taro@example.com, hanako@example.com' };
let tokeninfo = null; // 次の tokeninfo の返事 { code, body }

const signed = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const b64 = x => Buffer.from(typeof x === 'string' ? x : x.map(b => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const ctx = {
  console: { error() {}, log() {} },
  Utilities: {
    Charset: { UTF_8: 'UTF_8' },
    getUuid: () => crypto.randomUUID(),
    base64EncodeWebSafe: b64,
    base64DecodeWebSafe: s => signed(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes.map(b => b & 255)).toString('utf8') }),
    computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', k).update(v).digest())
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => tokeninfo.code, getContentText: () => JSON.stringify(tokeninfo.body) }) },
  ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) }
};
vm.createContext(ctx);
['app.js', 'app_api.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas', f), 'utf8'), ctx, { filename: f }));
// シートは読まず、架空のデータを返す
const FAKE = { today: '2026-01-10', left: 12345, list: [{ date: '2026-01-09', desc: 'テスト商店', amount: -1200 }] };
let lastSet = null;
ctx.appGetData = () => FAKE;
ctx.appSetCategory = ch => { lastSet = ch; if (ch.id === 'none') throw new Error('対象の行が見つかりません。画面を更新してからやり直してください。'); if (ch.id === 'boom') throw new Error('内部の詳しい情報'); return { ok: true, ruleAdded: false, auto: 0 }; };

let lastBulk = null;
ctx.appSetCategories = list => { lastBulk = list; return { ok: true, updated: 2, skipped: 0, rulesAdded: 1, autoApplied: 0 }; };

const post = body => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
const future = () => String(Math.floor(Date.now() / 1000) + 3000);
const goodInfo = over => ({ code: 200, body: Object.assign({ aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: future(), email_verified: 'true', email: 'Taro@example.com' }, over) });
const login = info => { tokeninfo = info; return post({ action: 'auth.login', payload: { idToken: 'x.y.z' } }); };

const tests = {
  '正しいログインでセッションが返り、データが読める'() {
    const r = login(goodInfo());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.email, 'taro@example.com');
    const p = post({ action: 'dashboard.get', session: r.data.session });
    assert.strictEqual(p.ok, true);
    assert.deepStrictEqual(p.data, FAKE);
  },
  'セッションなしは AUTH_REQUIRED'() {
    assert.strictEqual(post({ action: 'dashboard.get' }).error.code, 'AUTH_REQUIRED');
  },
  '書き換えたセッションは AUTH_EXPIRED'() {
    const s = login(goodInfo()).data.session;
    const forged = b64(JSON.stringify({ email: 'hanako@example.com', exp: Number(future()), ver: 1 })).replace(/=+$/, '') + '.' + s.split('.')[1];
    assert.strictEqual(post({ action: 'dashboard.get', session: forged }).error.code, 'AUTH_EXPIRED');
    assert.strictEqual(post({ action: 'dashboard.get', session: s.slice(0, -2) + 'AA' }).error.code, 'AUTH_EXPIRED');
    assert.strictEqual(post({ action: 'dashboard.get', session: 'abc' }).error.code, 'AUTH_EXPIRED');
  },
  '期限切れのセッションは AUTH_EXPIRED'() {
    const old = ctx.appApiSign_({ email: 'taro@example.com', exp: Math.floor(Date.now() / 1000) - 10, ver: 1 });
    assert.strictEqual(post({ action: 'dashboard.get', session: old }).error.code, 'AUTH_EXPIRED');
  },
  '許可していないメールは FORBIDDEN'() {
    assert.strictEqual(login(goodInfo({ email: 'other@example.com' })).error.code, 'FORBIDDEN');
  },
  '許可一覧から外すと、手元のセッションも FORBIDDEN'() {
    const s = login(goodInfo()).data.session;
    const keep = props.ALLOWED_EMAILS;
    props.ALLOWED_EMAILS = 'hanako@example.com';
    assert.strictEqual(post({ action: 'dashboard.get', session: s }).error.code, 'FORBIDDEN');
    props.ALLOWED_EMAILS = keep;
  },
  '鍵を作り直すと、前のセッションは AUTH_EXPIRED'() {
    const s = login(goodInfo()).data.session;
    ctx.appApiNewSecret();
    assert.strictEqual(post({ action: 'dashboard.get', session: s }).error.code, 'AUTH_EXPIRED');
  },
  'IDトークンの不備はどれも AUTH_EXPIRED'() {
    const bad = [
      goodInfo({ aud: 'someone-else.apps.googleusercontent.com' }),
      goodInfo({ iss: 'https://evil.example.com' }),
      goodInfo({ exp: String(Math.floor(Date.now() / 1000) - 1) }),
      goodInfo({ email_verified: 'false' }),
      { code: 400, body: { error: 'invalid_token' } }
    ];
    bad.forEach(info => assert.strictEqual(login(info).error.code, 'AUTH_EXPIRED'));
  },
  'クライアントID未設定ならログインできない'() {
    const keep = props.OAUTH_CLIENT_ID;
    props.OAUTH_CLIENT_ID = '';
    assert.strictEqual(login(goodInfo({ aud: '' })).ok, false);
    props.OAUTH_CLIENT_ID = keep;
  },
  '形のおかしいリクエストと知らない操作は BAD_REQUEST'() {
    assert.strictEqual(post('こんにちは').error.code, 'BAD_REQUEST');
    assert.strictEqual(post({}).error.code, 'BAD_REQUEST');
    const s = login(goodInfo()).data.session;
    assert.strictEqual(post({ action: 'toString', session: s }).error.code, 'BAD_REQUEST');
  },
  'ログインなしではカテゴリを変えられない'() {
    lastSet = null;
    assert.strictEqual(post({ action: 'tx.setCategory', payload: { id: 'a1', cat: '食費' } }).error.code, 'AUTH_REQUIRED');
    assert.strictEqual(lastSet, null);
  },
  'カテゴリの保存：値がそのまま渡り、エラーは決まった形で返る'() {
    const s = login(goodInfo()).data.session;
    const r = post({ action: 'tx.setCategory', session: s, payload: { row: 5, id: 'a1', desc: 'テスト商店', amount: -1200, cat: '食費', addRule: true } });
    assert.deepStrictEqual(r.data, { ok: true, ruleAdded: false, auto: 0 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(lastSet)), { row: 5, id: 'a1', desc: 'テスト商店', amount: -1200, cat: '食費', addRule: true });
    assert.strictEqual(post({ action: 'tx.setCategory', session: s, payload: { id: 'a1', cat: '' } }).error.code, 'BAD_REQUEST');
    assert.strictEqual(post({ action: 'tx.setCategory', session: s, payload: { id: 'none', cat: '食費' } }).error.code, 'CONFLICT');
    const boom = post({ action: 'tx.setCategory', session: s, payload: { id: 'boom', cat: '食費' } });
    assert.strictEqual(boom.error.code, 'INTERNAL');
    assert.ok(boom.error.message.indexOf('内部') < 0);
  },
  'まとめて保存：決まった形に直して渡す。おかしな形は BAD_REQUEST'() {
    lastBulk = null;
    const changes = [{ cat: '食費', addRule: true, desc: 'テスト商店', extra: 'x', items: [{ row: '5', id: 7, amount: '1200', desc: 'y' }] }, { cat: '外食', desc: null, items: [] }];
    assert.strictEqual(post({ action: 'tx.setCategories', payload: { changes: changes } }).error.code, 'AUTH_REQUIRED');
    assert.strictEqual(lastBulk, null);
    const s = login(goodInfo()).data.session;
    const r = post({ action: 'tx.setCategories', session: s, payload: { changes: changes } });
    assert.deepStrictEqual(r.data, { ok: true, updated: 2, skipped: 0, rulesAdded: 1, autoApplied: 0 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(lastBulk)), [
      { cat: '食費', addRule: true, desc: 'テスト商店', items: [{ row: 5, id: '7', amount: 1200 }] },
      { cat: '外食', addRule: false, desc: '', items: [] }
    ]);
    lastBulk = null;
    [{}, { changes: [] }, { changes: 'x' }, { changes: [null] }, { changes: [{ cat: '', items: [] }] }, { changes: [{ cat: '未分類', items: [] }] }, { changes: [{ cat: '食費' }] }]
      .forEach(p => assert.strictEqual(post({ action: 'tx.setCategories', session: s, payload: p }).error.code, 'BAD_REQUEST'));
    assert.strictEqual(lastBulk, null);
  },
  'doGet はデータを出さない'() {
    assert.strictEqual(ctx.doGet().text, 'このURLはアプリのデータ用です。');
  }
};

let failed = 0;
Object.keys(tests).forEach(name => {
  try { tests[name](); console.log('OK  ' + name); } catch (e) { failed++; console.log('NG  ' + name + '\n    ' + e.message); }
});
console.log(failed ? failed + ' 件失敗' : 'すべて成功（' + Object.keys(tests).length + ' 件）');
process.exit(failed ? 1 : 0);
