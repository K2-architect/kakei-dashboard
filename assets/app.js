(function () {
  'use strict';
  var CFG = window.APP_CONFIG || {};
  var DEMO = /[?&]demo=1(&|$)/.test(location.search);  // 見本データ（架空の数字）で画面だけ見る
  var D = null;          // サーバーから受け取ったデータ
  var txView = 'uncat';  // 取引タブ：uncat / recent
  var uncatLimit = 40;

  /* ---------- 共通 ---------- */
  var yen = function (n) { n = Math.round(n || 0); return (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP'); };
  var man = function (n) { var a = Math.abs(n); var s = a >= 10000 ? (Math.round(a / 1000) / 10) + '万' : a.toLocaleString('ja-JP'); return (n < 0 ? '−' : '') + s; };
  var md = function (s) { if (!s) return ''; var p = s.split('/'); return Number(p[1]) + '/' + Number(p[2]); };
  var wd = function (s) { var p = s.split('/'); return '日月火水木金土'.charAt(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay()); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var $ = function (id) { return document.getElementById(id); };
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(function () { t.style.display = 'none'; }, 3500); }
  function status(kind, label) {
    var c = { good: 'var(--good)', warning: 'var(--warning)', critical: 'var(--critical)' }[kind];
    var icon = { good: '✓', warning: '!', critical: '×' }[kind];
    return '<span class="status"><span class="dot" style="background:' + c + '"></span>' + icon + ' ' + esc(label) + '</span>';
  }

  /* ---------- ツールチップ ---------- */
  var tip = $('tip');
  document.addEventListener('pointermove', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el) { tip.style.display = 'none'; return; }
    tip.textContent = el.getAttribute('data-tip');
    tip.style.display = 'block';
    var x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    var y = e.clientY - tip.offsetHeight - 12; if (y < 8) y = e.clientY + 16;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
  document.addEventListener('pointerleave', function () { tip.style.display = 'none'; });

  /* ---------- ログインと通信 ---------- */
  var SESSION_KEY = 'kakeiSession', EMAIL_KEY = 'kakeiEmail', NONCE_KEY = 'kakeiNonce';
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var gisReady = false, gisDrawn = false, waiters = [];

  // API を1回呼ぶ。Content-Type は text/plain（事前確認を起こさないため）
  function post(action, payload) {
    return fetch(CFG.API_URL, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, session: store.get(SESSION_KEY) || '', payload: payload || {} })
    }).then(function (r) {
      if (!r.ok) throw { code: 'NETWORK', message: '通信に失敗しました（' + r.status + '）。しばらくしてからもう一度お試しください。' };
      return r.json();
    }, function () {
      throw { code: 'NETWORK', message: '通信できませんでした。電波の良い場所でもう一度お試しください。' };
    }).then(function (res) {
      if (!res || !res.ok) throw (res && res.error) || { code: 'INTERNAL', message: 'エラーが発生しました。' };
      return res.data;
    });
  }
  // API を呼ぶ。ログインが切れていたら、ログインし直してから1回だけやり直す
  function api(action, payload) {
    var first = store.get(SESSION_KEY) ? post(action, payload) : Promise.reject({ code: 'AUTH_REQUIRED' });
    return first.catch(function (err) {
      if (err.code !== 'AUTH_REQUIRED' && err.code !== 'AUTH_EXPIRED' && err.code !== 'FORBIDDEN') throw err;
      store.del(SESSION_KEY);
      return relogin(err.code === 'FORBIDDEN' ? err.message : '').then(function () { return post(action, payload); });
    });
  }

  function gateMsg(text, isErr) { var p = $('gateMsg'); p.textContent = text; p.className = isErr ? 'err' : ''; }
  function relogin(msg) {
    return new Promise(function (resolve) {
      waiters.push(resolve);
      gateMsg(msg || 'Googleアカウントでログインしてください。', !!msg);
      $('gateNote').hidden = !/Line\/|FBAN|FBAV|Instagram|GSA\//.test(navigator.userAgent);
      $('gate').hidden = false;
      drawGoogleButton();
    });
  }
  function drawGoogleButton() {
    if (!gisReady || gisDrawn || $('gate').hidden) return;
    google.accounts.id.renderButton($('gbtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
    gisDrawn = true;
  }
  // Google のログイン部品を読み込み終えたら呼ばれる
  window.appGisReady = function () {
    if (!(window.google && google.accounts && google.accounts.id)) return;
    google.accounts.id.initialize({ client_id: CFG.OAUTH_CLIENT_ID, callback: function (r) { onIdToken(r.credential); }, ux_mode: 'popup', auto_select: false });
    gisReady = true;
    drawGoogleButton();
  };
  function onIdToken(idToken) {
    gateMsg('ログインを確認中…');
    post('auth.login', { idToken: idToken }).then(function (d) {
      store.set(SESSION_KEY, d.session); store.set(EMAIL_KEY, d.email);
      $('gate').hidden = true;
      renderWho();
      var w = waiters; waiters = [];
      w.forEach(function (f) { f(); });
    }, function (err) { gateMsg(err.message, true); });
  }
  // 別の方法：小窓を使わず、ページごと Google に移動して戻ってくる
  $('altLogin').addEventListener('click', function () {
    var nonce = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(16)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    store.set(NONCE_KEY, nonce);
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=id_token&scope=openid%20email&prompt=select_account' +
      '&client_id=' + encodeURIComponent(CFG.OAUTH_CLIENT_ID) +
      '&redirect_uri=' + encodeURIComponent(location.origin + location.pathname) + '&nonce=' + nonce;
  });
  // Google から戻ってきたとき、URL の # 以降に結果が付いている
  function takeRedirectResult() {
    var h = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (!h.get('id_token') && !h.get('error')) return;
    history.replaceState(null, '', location.pathname + location.search);
    var nonce = store.get(NONCE_KEY); store.del(NONCE_KEY);
    if (h.get('error')) { gateMsg('ログインできませんでした。もう一度お試しください。', true); return; }
    var claims = {};
    try { claims = JSON.parse(atob(h.get('id_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) {}
    if (!nonce || claims.nonce !== nonce) { gateMsg('ログインできませんでした。もう一度お試しください。', true); return; }
    onIdToken(h.get('id_token'));
  }
  function renderWho() {
    var mail = store.get(EMAIL_KEY);
    $('whoText').textContent = DEMO ? '見本データ（架空の数字）を表示しています' : mail ? mail + ' でログイン中' : '';
    $('logout').hidden = DEMO || !store.get(SESSION_KEY);
    $('who').hidden = !DEMO && !store.get(SESSION_KEY);
  }
  $('logout').addEventListener('click', function () {
    store.del(SESSION_KEY); store.del(EMAIL_KEY);
    D = null;
    $('warnings').innerHTML = ''; $('asof').textContent = ''; $('badge').style.display = 'none';
    Array.prototype.forEach.call(document.querySelectorAll('section.tab'), function (s) { s.innerHTML = ''; });
    renderWho();
    load();
  });
  // 見本データ（assets/demo-data.js）を読み込む
  function loadDemo() {
    return new Promise(function (resolve, reject) {
      if (window.__MOCK__) { resolve(window.__MOCK__); return; }
      var s = document.createElement('script');
      s.src = 'assets/demo-data.js';
      s.onload = function () { resolve(window.__MOCK__); };
      s.onerror = function () { reject({ message: '見本データを読み込めませんでした。' }); };
      document.head.appendChild(s);
    });
  }

  /* ---------- 読み込み ---------- */
  function load() {
    $('asof').textContent = '更新中…';
    (DEMO ? loadDemo() : api('dashboard.get')).then(function (d) { D = d; render(); }, function (err) {
      var msg = err && err.message || err;
      if (D) { $('asof').textContent = md(D.asOf) + '（' + wd(D.asOf) + '）時点'; toast(msg); return; }
      $('tab-home').innerHTML = '<div class="warn"><b>読み込めませんでした</b>' + esc(msg) + '</div>'; $('asof').textContent = '';
    });
  }
  $('reload').addEventListener('click', load);
  Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-tab')); });
  });
  function show(name) {
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === name); });
    Array.prototype.forEach.call(document.querySelectorAll('section.tab'), function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
    window.scrollTo(0, 0);
  }

  function render() {
    $('asof').textContent = md(D.asOf) + '（' + wd(D.asOf) + '）時点';
    $('warnings').innerHTML = (D.warnings || []).length
      ? '<div class="warn"><b>データの確認が必要です</b>' + D.warnings.map(esc).join('<br>') + '</div>' : '';
    var b = $('badge');
    if (D.tx.uncategorizedCount) { b.style.display = ''; b.textContent = D.tx.uncategorizedCount > 99 ? '99+' : D.tx.uncategorizedCount; } else b.style.display = 'none';
    renderHome(); renderPlan(); renderFin(); renderTx();
  }

  /* ---------- ホーム ---------- */
  function renderHome() {
    var c = D.cycle, g = D.budget, k = D.cash;
    var over = g.remaining < 0;
    var ratio = g.variable > 0 ? Math.min(g.spent / g.variable, 1) : 1;
    var pace = g.variable > 0 ? Math.min(g.expected / g.variable, 1) : 0;
    var diff = g.spent - g.expected;
    var budgetStatus = over ? status('critical', '予算を' + yen(-g.remaining) + '超過')
      : diff > 0 ? status('warning', 'ペースより' + yen(diff) + '多い') : status('good', 'ペース内（' + yen(-diff) + '少ない）');
    var h = '';
    h += '<div class="card">';
    h += '<div class="hero-label">今期あと使える額（' + md(c.start) + '〜' + md(c.end) + '・残り' + c.left + '日）</div>';
    h += '<div class="hero num ' + (over ? 'neg' : '') + '">' + yen(g.remaining) + '</div>';
    h += '<div class="sub num">' + (over ? '1日あたり使える額はありません' : '1日あたり ' + yen(g.perDay) + '（今日を含め' + c.left + '日）') + '</div>';
    h += '<div class="bar" data-tip="使った額 ' + yen(g.spent) + ' ／ 予算 ' + yen(g.variable) + '\n今日までの目安 ' + yen(g.expected) + '">'
      + '<div class="fill' + (over ? ' over' : '') + '" style="width:' + (ratio * 100).toFixed(1) + '%"></div>'
      + '<div class="pace" style="left:calc(' + (pace * 100).toFixed(1) + '% - 1px)"></div></div>';
    h += '<div class="legend-row num"><span>使った額 ' + yen(g.spent) + '</span><span>予算 ' + yen(g.variable) + '</span></div>';
    h += '<div style="margin-top:10px">' + budgetStatus + '</div>';
    h += '<div class="tiles">'
      + tile('今日までの目安', yen(g.expected)) + tile('前期の変動費', yen(g.prevSpent)) + tile(c.card ? md(c.pay) + 'の引落' : '固定費（今期）', c.card ? cardDebit() : yen(g.fixedSpent))
      + '</div>';
    if (c.card) h += '<div class="sub muted" style="margin-top:10px">この期間の' + esc(c.card) + 'の利用は ' + md(c.pay) + ' に引き落とされます。</div>';
    h += '</div>';

    // 資金繰り
    var roomKind = k.room >= 0 ? 'good' : 'critical';
    h += '<div class="card"><h2>資金繰り（' + md(k.horizon) + 'まで）</h2>';
    h += '<div class="hero-label">口座残高から見て、まだ使える額</div>';
    h += '<div class="hero num ' + (k.room < 0 ? 'neg' : '') + '" style="font-size:30px">' + yen(k.room) + '</div>';
    h += '<div class="sub num">いちばん少ないのは ' + md(k.minDate) + ' の ' + yen(k.min) + '（最低限残す額 ' + yen(k.buffer) + '）</div>';
    h += '<div style="margin-top:10px">' + (k.room >= 0 ? status('good', '引落まで残高が足ります') : status('critical', yen(-k.room) + '足りません')) + '</div>';
    h += '<div class="tiles">' + tile('預金・現金', yen(k.now)) + tile('入金予定', yen(sumEv(1))) + tile('出金予定', yen(-sumEv(-1))) + '</div>';
    h += '<div class="sub muted" style="margin-top:10px">給与・家賃などの定期取引とカードの引落見込みで計算しています。予定タブで内訳を見られます。</div>';
    h += '</div>';

    // カテゴリ
    h += '<div class="card"><h2>今期の変動費（カテゴリ別）</h2>';
    if (!g.byCategory.length) h += '<div class="muted">まだ支出はありません</div>';
    var maxv = Math.max.apply(null, g.byCategory.map(function (x) { return Math.max(x.spent, x.prev, x.budget || 0); }).concat([1]));
    g.byCategory.forEach(function (x) {
      h += '<div class="cat" data-tip="' + esc(x.cat) + '\n今期 ' + yen(x.spent) + '\n前期 ' + yen(x.prev) + (x.budget ? '\n月予算 ' + yen(x.budget) : '') + '">'
        + '<div class="name">' + esc(x.cat) + '</div>'
        + '<div class="track"><div class="f" style="width:' + (x.spent / maxv * 100).toFixed(1) + '%"></div>'
        + (x.prev ? '<div class="p" style="left:' + (x.prev / maxv * 100).toFixed(1) + '%"></div>' : '') + '</div>'
        + '<div class="val num">' + yen(x.spent) + '</div></div>';
    });
    h += '<div class="sub muted" style="margin-top:6px">縦線は前期（' + md(g.prevStart) + '〜' + md(g.prevEnd) + '）の額</div>';
    h += '</div>';

    // 予算の内訳
    h += '<div class="card formula"><h2>予算の決め方（月）</h2><div class="rows">'
      + frow('手取り', yen(g.income), '')
      + frow('固定費の見込み', minus(g.fixed), g.fixedAuto ? '直近' + g.fixedMonths.length + 'か月のカテゴリ別中央値（' + (g.fixedCats || []).map(function (c) { return c.cat + ' ' + man(c.amount); }).join('・') + '）' : '設定値')
      + frow('返済', minus(g.repay), '')
      + frow('貯蓄目標', minus(g.saving), '')
      + '<div class="row"><div class="l"><b>変動費の予算</b>' + (g.variableAuto ? '' : '<div class="s">設定で手入力した額</div>') + '</div><div class="r num"><b>' + yen(g.variable) + '</b></div></div>'
      + '</div><div class="sub muted" style="margin-top:6px">金額はスプレッドシートの「アプリ設定」で変えられます。</div></div>';
    $('tab-home').innerHTML = h;
  }
  function minus(n) { return n ? '−' + yen(Math.abs(n)) : yen(0); }
  function tile(k, v) { return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v num">' + v + '</div></div>'; }
  function frow(l, v, s) { return '<div class="row"><div class="l">' + esc(l) + (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div><div class="r num">' + v + '</div></div>'; }
  function sumEv(sign) { return D.cash.events.reduce(function (a, e) { return a + ((sign > 0 ? e.amount > 0 : e.amount < 0) ? e.amount : 0); }, 0); }
  function cardDebit() {
    var e = D.cash.events.filter(function (x) { return x.type === 'card' && x.date === D.cycle.pay; })[0];
    return e ? yen(-e.amount) : '—';
  }

  /* ---------- 予定 ---------- */
  function renderPlan() {
    var k = D.cash, h = '';
    h += '<div class="card"><h2>預金・現金の見込み（' + md(D.asOf) + '〜' + md(k.horizon) + '）</h2>';
    h += lineChart();
    h += '<div class="legend"><span><i style="background:var(--series-1)"></i>残高の見込み</span><span><i style="background:var(--critical);height:2px;vertical-align:3px"></i>最低限残す額</span></div>';
    h += '</div>';
    h += '<div class="card"><h2>入出金の予定</h2><div class="rows">';
    h += '<div class="row"><div class="l"><div class="t">' + md(D.asOf) + '（' + wd(D.asOf) + '） 現在の残高</div></div><div class="r num"><b>' + yen(k.now) + '</b></div></div>';
    if (!k.events.length) h += '<div class="row muted">予定はありません</div>';
    k.events.forEach(function (e) {
      h += '<div class="row"><div class="l"><div class="t">' + md(e.date) + '（' + wd(e.date) + '） ' + esc(e.label) + '</div><div class="s">' + esc(e.note) + '</div></div>'
        + '<div class="r num"><div class="' + (e.amount > 0 ? 'pos' : '') + '">' + (e.amount > 0 ? '+' : '') + yen(e.amount) + '</div>'
        + '<div class="s ' + (e.balance < k.buffer ? 'neg' : 'muted') + '">残高 ' + yen(e.balance) + '</div></div></div>';
    });
    h += '</div><div class="sub muted" style="margin-top:8px">カードの引落額は「突合」シートに明細金額を入れるとその額、入れていなければ締め期間の利用額で見込みます（リボ・分割は反映されません）。</div></div>';
    $('tab-plan').innerHTML = h;
  }
  function lineChart() {
    var k = D.cash;
    var pts = [{ date: D.asOf, balance: k.now, label: '現在' }].concat(k.events.map(function (e) { return { date: e.date, balance: e.balance, label: e.label + ' ' + (e.amount > 0 ? '+' : '') + yen(e.amount) }; }));
    var toDay = function (s) { var p = s.split('/'); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 864e5; };
    var d0 = toDay(D.asOf), d1 = Math.max(toDay(k.horizon), d0 + 1);
    var vals = pts.map(function (p) { return p.balance; }).concat([k.buffer, 0]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo) * .08 || 10000; lo -= pad; hi += pad;
    var W = chartW(), H = 220, L = 50, R = 10, T = 10, B = 24;
    var x = function (d) { return L + (d - d0) / (d1 - d0) * (W - L - R); };
    var y = function (v) { return T + (hi - v) / (hi - lo) * (H - T - B); };
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="残高の見込み">';
    ticks(lo, hi).forEach(function (v) { s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + man(v) + '</text>'; });
    if (lo < 0 && hi > 0) s += '<line class="zero" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(k.buffer) + '" y2="' + y(k.buffer) + '" stroke="var(--critical)" stroke-width="1.5" stroke-dasharray="4 4"/>';
    // 階段状の線
    var dpath = 'M' + x(d0) + ' ' + y(pts[0].balance);
    for (var j = 1; j < pts.length; j++) { var xd = x(toDay(pts[j].date)); dpath += ' H' + xd + ' V' + y(pts[j].balance); }
    dpath += ' H' + x(d1);
    s += '<path d="' + dpath + '" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>';
    pts.forEach(function (p) {
      var cx = x(toDay(p.date)), cy = y(p.balance);
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="4.5" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>';
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="14" fill="transparent" data-tip="' + esc(md(p.date) + ' ' + p.label + '\n残高 ' + yen(p.balance)) + '"/>';
    });
    // 日付の目盛り（月初と最後）
    var t = new Date(d0 * 864e5); t = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1) / 864e5;
    s += '<text x="' + x(d0) + '" y="' + (H - 6) + '">' + md(D.asOf) + '</text>';
    for (; t < d1 - 3; t = Date.UTC(new Date(t * 864e5).getUTCFullYear(), new Date(t * 864e5).getUTCMonth() + 1, 1) / 864e5) {
      if (t - d0 < 4) continue;
      var dd = new Date(t * 864e5); s += '<text x="' + x(t) + '" y="' + (H - 6) + '" text-anchor="middle">' + (dd.getUTCMonth() + 1) + '/1</text>';
    }
    s += '<text x="' + x(d1) + '" y="' + (H - 6) + '" text-anchor="end">' + md(k.horizon) + '</text>';
    return s + '</svg>';
  }

  /* ---------- 財務 ---------- */
  function renderFin() {
    var f = D.finance, h = '';
    h += '<div class="card"><h2>現在の財務状況（' + md(D.asOf) + '）</h2>';
    h += '<div class="hero-label">純資産（資産 − 負債）</div><div class="hero num ' + (f.net < 0 ? 'neg' : '') + '">' + yen(f.net) + '</div>';
    h += '<div class="tiles">' + tile('資産', yen(f.assets)) + tile('負債（カード）', yen(f.liabilities)) + tile('うち預金・現金', yen(f.cash)) + '</div></div>';

    h += '<div class="card"><h2>口座ごとの残高</h2><div class="rows">';
    var groups = [['現預金', '預金・現金'], ['立替金', '立替・精算'], ['カード', 'カード（未払残高）'], ['投資', '投資'], ['ローン', 'ローン']];
    groups.forEach(function (g) {
      var list = f.accounts.filter(function (a) { return a.cls === g[0]; });
      if (!list.length) return;
      var sum = list.reduce(function (a, b) { return a + b.balance; }, 0);
      h += '<div class="row"><div class="l"><b>' + g[1] + '</b></div><div class="r num"><b>' + yen(sum) + '</b></div></div>';
      list.forEach(function (a) { h += '<div class="row"><div class="l"><div class="t" style="padding-left:12px">' + esc(a.name) + '</div></div><div class="r num ' + (a.cls === '現預金' && a.balance < 0 ? 'neg' : '') + '">' + yen(a.balance) + '</div></div>'; });
    });
    h += '</div></div>';

    h += '<div class="card"><h2>純資産の推移（月末）</h2>' + barChart(f.history.map(function (m) { return { label: monthLabel(m), values: [m.net], tips: ['純資産 ' + yen(m.net) + '\n資産 ' + yen(m.assets) + '\n負債 ' + yen(m.liabilities)] }; }), ['var(--series-1)']) + '</div>';

    h += '<div class="card"><h2>月ごとの収支</h2><div class="legend"><span><i style="background:var(--series-1)"></i>収入</span><span><i style="background:var(--series-2)"></i>支出（固定費＋変動費）</span></div>';
    h += barChart(f.history.map(function (m) { var ex = m.fixed + m.variable; return { label: monthLabel(m), values: [m.income, ex], tips: ['収入 ' + yen(m.income) + '\n収支 ' + yen(m.balance), '支出 ' + yen(ex) + '\n固定費 ' + yen(m.fixed) + '\n変動費 ' + yen(m.variable) + '\n収支 ' + yen(m.balance)] }; }), ['var(--series-1)', 'var(--series-2)']);
    h += '<details><summary>表で見る</summary><div class="scroll-x"><table class="tbl num"><tr><th>月</th><th>収入</th><th>固定費</th><th>変動費</th><th>収支</th><th>純資産</th></tr>';
    f.history.forEach(function (m) { h += '<tr><td>' + monthLabel(m) + '</td><td>' + yen(m.income) + '</td><td>' + yen(m.fixed) + '</td><td>' + yen(m.variable) + '</td><td class="' + (m.balance < 0 ? 'neg' : '') + '">' + yen(m.balance) + '</td><td>' + yen(m.net) + '</td></tr>'; });
    h += '</table></div></details></div>';
    $('tab-fin').innerHTML = h;
  }
  function chartW() { var m = document.querySelector('main'); return Math.max(280, Math.min((m ? m.clientWidth : 360) - 34, 690)); }
  function ticks(lo, hi) {
    var raw = (hi - lo) / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), st = p;
    [1, 2, 2.5, 5, 10].some(function (f) { st = f * p; return st >= raw; });
    var out = []; for (var v = Math.ceil(lo / st) * st; v <= hi + 1e-6; v += st) out.push(Math.round(v));
    return out;
  }
  function monthLabel(m) { return Number(m.month.slice(5)) + '月' + (m.partial ? '（途中）' : ''); }
  function barChart(items, colors) {
    var n = items.length, sN = colors.length;
    var vals = [0]; items.forEach(function (it) { vals = vals.concat(it.values); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo) * .06 || 1; if (hi > 0) hi += pad; if (lo < 0) lo -= pad;
    var W = chartW(), H = 210, L = 50, R = 6, T = 8, B = 24;
    var y = function (v) { return T + (hi - v) / (hi - lo) * (H - T - B); };
    var slot = (W - L - R) / Math.max(n, 1), bw = Math.min(28, (slot - 12) / sN - 2);
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img">';
    ticks(lo, hi).forEach(function (v) { s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + man(v) + '</text>'; });
    s += '<line class="zero" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    items.forEach(function (it, i) {
      var cx = L + slot * i + slot / 2, x0 = cx - (bw * sN + 2 * (sN - 1)) / 2;
      it.values.forEach(function (v, j) {
        var x = x0 + j * (bw + 2), y0 = y(0), y1 = y(v), top = Math.min(y0, y1), hgt = Math.max(Math.abs(y1 - y0), 1);
        var r = Math.min(4, bw / 2, hgt);
        // 基線から離れた側だけ角を丸める
        var d = v >= 0
          ? 'M' + x + ' ' + y0 + ' V' + (top + r) + ' Q' + x + ' ' + top + ' ' + (x + r) + ' ' + top + ' H' + (x + bw - r) + ' Q' + (x + bw) + ' ' + top + ' ' + (x + bw) + ' ' + (top + r) + ' V' + y0 + ' Z'
          : 'M' + x + ' ' + y0 + ' V' + (y1 - r) + ' Q' + x + ' ' + y1 + ' ' + (x + r) + ' ' + y1 + ' H' + (x + bw - r) + ' Q' + (x + bw) + ' ' + y1 + ' ' + (x + bw) + ' ' + (y1 - r) + ' V' + y0 + ' Z';
        s += '<path d="' + d + '" fill="' + colors[j] + '"/>';
      });
      s += '<rect x="' + (cx - slot / 2) + '" y="' + T + '" width="' + slot + '" height="' + (H - T - B) + '" fill="transparent" data-tip="' + esc(it.label + '\n' + it.tips.join('\n')) + '"/>';
      s += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(it.label.replace('（途中）', '*')) + '</text>';
    });
    return s + '</svg>';
  }

  /* ---------- 取引 ---------- */
  function renderTx() {
    var t = D.tx, h = '';
    h += '<div class="seg"><button type="button" data-v="uncat" class="' + (txView === 'uncat' ? 'on' : '') + '">未分類（' + t.uncategorizedCount + '）</button>'
      + '<button type="button" data-v="recent" class="' + (txView === 'recent' ? 'on' : '') + '">最近の取引</button></div>';
    if (txView === 'uncat') {
      h += '<div class="card">';
      if (!t.uncategorized.length) h += '<div class="muted">未分類はありません</div>';
      var opts = t.categories.filter(function (c) { return c !== '未分類'; }).map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
      t.uncategorized.slice(0, uncatLimit).forEach(function (x, i) {
        h += '<div class="tx-edit" data-i="' + i + '"><div class="l"><div class="t">' + esc(x.desc || '（摘要なし）') + '</div><div class="sub muted">' + md(x.date) + '・' + esc(x.from) + '</div></div>'
          + '<div class="r num">' + yen(x.amount) + '</div>'
          + '<div class="ctl"><select aria-label="カテゴリ"><option value="">カテゴリを選ぶ</option>' + opts + '</select>'
          + '<label class="chk"><input type="checkbox"' + (/海外利用分/.test(x.desc) ? '' : ' checked') + '>同じ利用先は次からこのカテゴリ</label>'
          + '<button class="btn" type="button" disabled>保存</button></div></div>';
      });
      if (t.uncategorized.length > uncatLimit) h += '<div style="text-align:center;padding-top:10px"><button class="icon" type="button" id="more">さらに表示（残り' + (t.uncategorized.length - uncatLimit) + '件）</button></div>';
      h += '</div>';
    } else {
      h += '<div class="card"><div class="rows">';
      t.recent.forEach(function (x) {
        var sign = x.kind === '収入' ? '+' : x.kind === '振替' ? '' : '';
        h += '<div class="row"><div class="l"><div class="t">' + esc(x.desc || x.cat) + '</div><div class="s">' + md(x.date) + '・' + esc(x.cat) + '・' + esc(x.kind === '振替' ? x.from + '→' + x.to : (x.from || x.to)) + '</div></div>'
          + '<div class="r num ' + (x.kind === '収入' ? 'pos' : x.kind === '振替' ? 'muted' : '') + '">' + sign + yen(x.amount) + '</div></div>';
      });
      h += '</div></div>';
    }
    var el = $('tab-tx'); el.innerHTML = h;
    Array.prototype.forEach.call(el.querySelectorAll('.seg button'), function (b) { b.addEventListener('click', function () { txView = b.getAttribute('data-v'); renderTx(); }); });
    var more = $('more'); if (more) more.addEventListener('click', function () { uncatLimit += 40; renderTx(); });
    Array.prototype.forEach.call(el.querySelectorAll('.tx-edit'), function (box) {
      var sel = box.querySelector('select'), btn = box.querySelector('button'), chk = box.querySelector('input');
      sel.addEventListener('change', function () { btn.disabled = !sel.value; });
      btn.addEventListener('click', function () {
        var x = t.uncategorized[Number(box.getAttribute('data-i'))];
        btn.disabled = true; btn.textContent = '保存中…';
        var payload = { row: x.row, id: x.id, desc: x.desc, amount: x.amount, cat: sel.value, addRule: chk.checked };
        if (DEMO) { toast('（見本のため保存しません）'); btn.disabled = false; btn.textContent = '保存'; return; }
        api('tx.setCategory', payload).then(function (r) {
          toast('「' + sel.value + '」にしました' + (r.auto > 1 ? '（同じ利用先 ' + r.auto + '件も）' : '') + (r.ruleAdded ? '。分類ルールに追加しました' : ''));
          load();
        }, function (err) { btn.disabled = false; btn.textContent = '保存'; toast('保存できませんでした：' + (err && err.message || err)); });
      });
    });
  }

  renderWho();
  load();
  takeRedirectResult();
})();
