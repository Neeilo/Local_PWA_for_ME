/**
 * 股票（ADR-015）。
 *
 * PR-0 只有一支可行性探針 probeStockSources()：在 GAS 編輯器手動執行，實打
 * 富果／證交所 MIS／證交所 OpenAPI（＋櫃買中心 OpenAPI），把每個來源的 HTTP
 * 狀態、耗時、欄位範例寫進執行記錄。資料源是全案地基，先確認 Google 的機房
 * 打得到、欄位長得跟文件一樣，才開始寫報價層。之後留著當診斷工具。
 *
 * 富果的 key 讀指令碼屬性 FUGLE_API_KEY，不寫進這裡（repo 是公開的）；
 * 探針也不會把 key 印出來。
 */

/** 探針要測的代號：上市、ETF、槓桿 ETF、上櫃、不存在 */
var STOCK_PROBE_SYMBOLS = [
  { code: '2330', ex: 'tse', note: '上市' },
  { code: '0050', ex: 'tse', note: 'ETF' },
  { code: '00631L', ex: 'tse', note: '槓桿 ETF' },
  { code: '6488', ex: 'otc', note: '上櫃' },
  { code: '0063L', ex: 'tse', note: '不存在' }
];

var FUGLE_QUOTE_URL = 'https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/';
var TWSE_MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
var TWSE_DAY_ALL_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
/** 上櫃不在 STOCK_DAY_ALL 裡（T7），順手探櫃買中心的收盤行情 */
var TPEX_DAILY_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';

/** 範例值截短，執行記錄才不會被一整包 JSON 淹沒 */
var PROBE_SAMPLE_CHARS = 300;

/** 編輯器手動執行的入口 */
function probeStockSources() {
  return probeStockSources_(new Date());
}

function probeStockSources_(now) {
  var trading = isTwTradingTime_(now);
  var report = { at: taipeiStamp_(now), trading: trading, sources: [] };
  console.log('🔎 股票資料源探針｜台北時間 ' + report.at + (trading ? '（盤中）' : ''));
  if (!trading) {
    console.log('⚠️ 現在不是盤中（週一～五 9:00～13:30）。富果／MIS 的即時欄位可能是收盤值或空值，請盤中再跑一次再回貼');
  }

  probeFugle_(report);
  probeMis_(report);
  probeDayAll_(report, '證交所 OpenAPI', TWSE_DAY_ALL_URL, 'Code');
  probeDayAll_(report, '櫃買 OpenAPI', TPEX_DAILY_URL, 'SecuritiesCompanyCode');

  console.log('—— 總結 ——');
  report.sources.forEach(function (s) {
    console.log((s.ok ? '✅ ' : '❌ ') + s.source + '｜' + s.verdict);
  });
  return report;
}

/** 台灣不實施日光節約，固定 UTC+8；不靠腳本時區，測試才算得準 */
function taipeiParts_(now) {
  var t = new Date(now.getTime() + 8 * 3600 * 1000);
  return { day: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), t: t };
}

/** 週一～五 9:00～13:30（不含國定假日，那由收盤價資料判斷） */
function isTwTradingTime_(now) {
  var p = taipeiParts_(now);
  return p.day >= 1 && p.day <= 5 && p.minutes >= 9 * 60 && p.minutes <= 13 * 60 + 30;
}

function taipeiStamp_(now) {
  return taipeiParts_(now).t.toISOString().slice(0, 19).replace('T', ' ');
}

/** 一次請求：網路層例外（DNS、被擋、逾時）也收成結果，不讓一個來源中斷其他來源 */
function probeFetch_(url, headers) {
  var started = Date.now();
  try {
    var res = UrlFetchApp.fetch(url, { method: 'get', headers: headers || {}, muteHttpExceptions: true });
    return { status: res.getResponseCode(), ms: Date.now() - started, text: res.getContentText() };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, text: '', error: String(err && err.message || err) };
  }
}

function probeJson_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function probeSample_(value) {
  var s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > PROBE_SAMPLE_CHARS ? s.slice(0, PROBE_SAMPLE_CHARS) + '…' : s;
}

function probeHead_(r) {
  return r.error ? '連線失敗（' + r.error + '）｜' + r.ms + 'ms' : 'HTTP ' + r.status + '｜' + r.ms + 'ms';
}

/** 富果：一檔一個請求，key 放 header */
function probeFugle_(report) {
  var key = PropertiesService.getScriptProperties().getProperty('FUGLE_API_KEY');
  if (!key) {
    console.log('[富果] ❌ 指令碼屬性沒有 FUGLE_API_KEY，跳過（專案設定 → 指令碼屬性 補上後重跑）');
    report.sources.push({ source: '富果', ok: false, verdict: '沒設 FUGLE_API_KEY，未測', rows: [] });
    return;
  }
  var rows = STOCK_PROBE_SYMBOLS.map(function (sym) {
    var r = probeFetch_(FUGLE_QUOTE_URL + encodeURIComponent(sym.code), { 'X-API-KEY': key });
    var body = probeJson_(r.text);
    var row = { code: sym.code, note: sym.note, status: r.status, ms: r.ms, error: r.error || '' };
    var line = '[富果] ' + sym.code + '（' + sym.note + '）→ ' + probeHead_(r);
    if (r.status === 200 && body) {
      row.fields = Object.keys(body);
      row.sample = {
        name: body.name, exchange: body.exchange, market: body.market,
        lastPrice: body.lastPrice, previousClose: body.previousClose, closePrice: body.closePrice,
        change: body.change, changePercent: body.changePercent,
        lastTrade: body.lastTrade, lastUpdated: body.lastUpdated
      };
      line += '｜' + probeSample_(row.sample) + '｜欄位：' + row.fields.join(',');
    } else {
      row.body = probeSample_(r.text);
      line += '｜' + row.body;
    }
    if (r.status === 429) line += '｜⚠️ 被限流（429）';
    console.log(line);
    return row;
  });
  // 「不存在」那檔本來就該失敗；其他四檔都 200 才算過
  var real = rows.filter(function (row) { return row.note !== '不存在'; });
  var passed = real.filter(function (row) { return row.status === 200; }).length;
  var ok = passed === real.length;
  var otc = rows.filter(function (row) { return row.note === '上櫃'; })[0];
  var verdict = passed + '/' + real.length + ' 檔取得報價' +
    (otc && otc.status !== 200 ? '｜上櫃不支援或被擋' : '') +
    (rows.some(function (row) { return row.status === 429; }) ? '｜有 429' : '');
  report.sources.push({ source: '富果', ok: ok, verdict: verdict, rows: rows });
}

/** MIS：一次多檔。z 是「這 5 秒的成交價」，沒成交時是 '-'——要看清楚它實際長怎樣 */
function probeMis_(report) {
  var exCh = STOCK_PROBE_SYMBOLS.map(function (sym) { return sym.ex + '_' + sym.code + '.tw'; }).join('|');
  var r = probeFetch_(TWSE_MIS_URL + '?ex_ch=' + encodeURIComponent(exCh) + '&json=1&delay=0');
  var body = probeJson_(r.text);
  var list = body && Array.isArray(body.msgArray) ? body.msgArray : null;
  console.log('[MIS] ' + STOCK_PROBE_SYMBOLS.length + ' 檔一次請求 → ' + probeHead_(r) +
    (list ? '｜回來 ' + list.length + ' 檔' : '｜' + probeSample_(r.text)));
  var rows = (list || []).map(function (it) {
    var row = {
      code: it.c, name: it.n, ex: it.ex, z: it.z, y: it.y, b: it.b, a: it.a,
      tv: it.tv, d: it.d, t: it.t, hasTrade: 'trade' in it, fields: Object.keys(it)
    };
    console.log('[MIS] ' + it.c + ' ' + (it.n || '') + '｜z=' + it.z + (it.z === '-' ? '（這 5 秒無成交）' : '') +
      ' y=' + it.y + ' b=' + probeSample_(it.b || '') + ' a=' + probeSample_(it.a || '') +
      ' d=' + it.d + ' t=' + it.t + '｜' + (row.hasTrade ? 'trade=' + probeSample_(it.trade) : '沒有 trade 欄位') +
      '｜欄位：' + row.fields.join(','));
    return row;
  });
  var got = rows.map(function (row) { return row.code; });
  var missing = STOCK_PROBE_SYMBOLS.filter(function (sym) { return got.indexOf(sym.code) < 0; })
    .map(function (sym) { return sym.code + '（' + sym.note + '）'; });
  var realMissing = missing.filter(function (m) { return m.indexOf('不存在') < 0; });
  var ok = r.status === 200 && !!list && realMissing.length === 0;
  var verdict = (list ? '回來 ' + rows.length + ' 檔' : '沒有 msgArray（' + probeHead_(r) + '）') +
    (missing.length ? '｜沒回：' + missing.join('、') : '') +
    (rows.some(function (row) { return row.z === '-'; }) ? '｜有 z=-' : '');
  report.sources.push({ source: 'MIS', ok: ok, verdict: verdict, rows: rows });
}

/** 盤後整包：只找探針的代號，看欄位名稱與資料日期 */
function probeDayAll_(report, label, url, codeField) {
  var r = probeFetch_(url);
  var body = probeJson_(r.text);
  var list = Array.isArray(body) ? body : null;
  console.log('[' + label + '] → ' + probeHead_(r) +
    (list ? '｜' + list.length + ' 筆｜欄位：' + (list[0] ? Object.keys(list[0]).join(',') : '（空）') : '｜' + probeSample_(r.text)));
  var rows = [];
  (list || []).forEach(function (it) {
    var hit = STOCK_PROBE_SYMBOLS.filter(function (sym) { return String(it[codeField]).trim() === sym.code; })[0];
    if (!hit) return;
    rows.push({ code: hit.code, note: hit.note, sample: it });
    console.log('[' + label + '] ' + hit.code + '（' + hit.note + '）｜' + probeSample_(it));
  });
  var found = rows.map(function (row) { return row.code; });
  var ok = r.status === 200 && !!list && list.length > 0;
  var verdict = (list ? list.length + ' 筆，探針代號找到：' + (found.join('、') || '（無）') : '讀不到清單（' + probeHead_(r) + '）') +
    (list && list[0] && list[0].Date ? '｜資料日期 ' + list[0].Date : '');
  report.sources.push({ source: label, ok: ok, verdict: verdict, rows: rows });
}
