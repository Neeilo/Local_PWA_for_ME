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

/**
 * 開頭的 UTF-8 BOM（\uFEFF）在執行記錄裡看不見，JSON.parse 卻會因它失敗——
 * 2026-10-08 實測櫃買 OpenAPI「HTTP 200、內容看起來是 JSON、卻讀不到清單」，先排除這個
 */
function probeJsonText_(text) {
  return String(text).replace(/^\uFEFF/, '');
}

function probeJson_(text) {
  try { return JSON.parse(probeJsonText_(text)); } catch (e) { return null; }
}

/** 讀不出 JSON 時說清楚為什麼：錯誤訊息＋開頭字元碼（看不見的字元才查得到） */
function probeJsonError_(text) {
  try { JSON.parse(probeJsonText_(text)); return ''; } catch (e) {
    return '不是合法 JSON（' + String(e && e.message || e) + '｜開頭字元碼 ' + String(text).charCodeAt(0) + '）';
  }
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
    (list ? '｜' + list.length + ' 筆｜欄位：' + (list[0] ? Object.keys(list[0]).join(',') : '（空）')
      : '｜' + (body ? '回的不是陣列' : probeJsonError_(r.text)) + '｜' + probeSample_(r.text)));
  var rows = [];
  (list || []).forEach(function (it) {
    var hit = STOCK_PROBE_SYMBOLS.filter(function (sym) { return String(it[codeField]).trim() === sym.code; })[0];
    if (!hit) return;
    rows.push({ code: hit.code, note: hit.note, sample: it });
    console.log('[' + label + '] ' + hit.code + '（' + hit.note + '）｜' + probeSample_(it));
  });
  var found = rows.map(function (row) { return row.code; });
  var ok = r.status === 200 && !!list && list.length > 0;
  var verdict = (list ? list.length + ' 筆，探針代號找到：' + (found.join('、') || '（無）')
    : '讀不到清單（' + probeHead_(r) + (r.status === 200 && !body ? '｜' + probeJsonError_(r.text) : '') + '）') +
    (list && list[0] && list[0].Date ? '｜資料日期 ' + list[0].Date : '');
  report.sources.push({ source: label, ok: ok, verdict: verdict, rows: rows });
}

/* ========================================================================== */
/* 代號與數字（ADR-015 D-14）                                                    */
/* ========================================================================== */

/** 黃金：只記錄、不抓價（明確不做金價自動抓取），單位公克 */
var STOCK_GOLD = 'GOLD';
/** 上市上櫃代號：4～6 位數字，ETF 可能帶一個英文字尾（00631L） */
var STOCK_SYMBOL_RE = /^[0-9]{4,6}[A-Z]?$/;

/** 全形英數與標點換成半形（LINE 上用注音輸入法很容易打出全形） */
function toHalfWidth_(raw) {
  return String(raw == null ? '' : raw).replace(/[\uFF01-\uFF5E]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).replace(/\u3000/g, ' ');
}

/** 代號一律存大寫半形；GOLD 不分大小寫 */
function normalizeSymbol_(raw) {
  return toHalfWidth_(raw).trim().toUpperCase();
}

/** 數量、價格：接受全形數字與千分位逗號。不是正數回 NaN */
function parseStockNumber_(raw) {
  var t = toHalfWidth_(raw).replace(/[,，、]/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  var n = Number(t);
  return n > 0 ? n : NaN;
}

function isGold_(symbol) {
  return normalizeSymbol_(symbol) === STOCK_GOLD;
}

/** 黃金公克取到小數 2 位；股票是整數股 */
function roundQty_(symbol, qty) {
  return isGold_(symbol) ? Math.round(qty * 100) / 100 : Math.round(qty);
}

/* ========================================================================== */
/* 持股：移動平均成本（ADR-015 T4）                                              */
/* ========================================================================== */

/**
 * 交易 → 每位持有者每檔的持有量與平均成本。純函式。
 *
 * 移動平均：買進把（股數×價格＋手續費）加進成本；賣出依當下均價扣掉成本，
 * 剩下的均價不變。賣出的手續費不進成本（那是已實現損益的事，這一輪不算）。
 * 依交易日 → 建立時間 → id 排序重播；任何一個時間點賣超過持有量就回 oversold，
 * 寫入前用它把關（LINE 賣超、PWA 改小一筆買進、刪掉一筆買進都擋得住）。
 * 已刪除（del）的交易不算。
 */
function computeHoldings_(trades) {
  var list = (trades || []).filter(function (t) { return t && !isTombstone_(t); }).slice();
  var at = function (t) { return [keyValue_(t.trade_date), String(t.created_at == null ? '' : t.created_at), String(t.id == null ? '' : t.id)]; };
  list.sort(function (a, b) {
    var x = at(a), y = at(b);
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
  var book = {}, order = [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var symbol = normalizeSymbol_(t.symbol);
    var owner = String(t.owner == null ? '' : t.owner).trim();
    var qty = Number(t.qty), price = Number(t.price), fee = Number(t.fee) || 0;
    if (!symbol || !isFinite(qty) || qty <= 0 || !isFinite(price) || price < 0) continue;
    var key = owner + '|' + symbol;
    var h = book[key];
    if (!h) { h = book[key] = { owner: owner, symbol: symbol, qty: 0, cost: 0 }; order.push(key); }
    var side = String(t.side == null ? '' : t.side).trim().toLowerCase();
    if (side === 'buy') {
      h.qty = roundQty_(symbol, h.qty + qty);
      h.cost += qty * price + fee;
    } else if (side === 'sell') {
      if (qty > h.qty + 1e-9) {
        return { ok: false, error: 'oversold', owner: owner, symbol: symbol, held: h.qty, id: String(t.id == null ? '' : t.id) };
      }
      var avg = h.qty ? h.cost / h.qty : 0;
      h.qty = roundQty_(symbol, h.qty - qty);
      h.cost = h.qty ? h.cost - avg * qty : 0;
    }
  }
  return {
    ok: true,
    holdings: order.map(function (k) { return book[k]; }).filter(function (h) { return h.qty > 0; }).map(function (h) {
      return { owner: h.owner, symbol: h.symbol, qty: h.qty, cost: Math.round(h.cost * 100) / 100,
               avg_cost: Math.round((h.cost / h.qty) * 10000) / 10000 };
    })
  };
}

function holdingOf_(holdings, owner, symbol) {
  var hit = (holdings || []).filter(function (h) { return h.owner === owner && h.symbol === symbol; })[0];
  return hit || null;
}

/* ========================================================================== */
/* 報價層（ADR-015 T1：D-2、D-3）                                               */
/*                                                                            */
/* 富果 → MIS → GOOGLEFINANCE；非交易時段讀 stock_daily 的收盤價，不打外部。      */
/* 每檔快取 60 秒（全家共用一份），只有沒命中的才打外部，多檔用 fetchAll 並行。   */
/* ========================================================================== */

var QUOTE_CACHE_PREFIX = 'adr015_q_';
var QUOTE_CACHE_TTL = 60;
/** 富果 429 的 logs 十分鐘最多一列：15 秒輪詢遇到限流，不能每次都寫 */
var FUGLE_429_KEY = 'adr015_fugle429';
var FUGLE_429_TTL = 600;
var STOCK_LOG_SOURCE = '股票';

function quoteRound_(n) {
  return Math.round(n * 10000) / 10000;
}

/** 一檔報價的統一形狀。price 或 prevClose 不是數字就算這個來源沒拿到 */
function makeQuote_(price, prevClose, time, source, name) {
  price = Number(price); prevClose = Number(prevClose);
  if (!isFinite(price) || price <= 0) return null;
  var hasPrev = isFinite(prevClose) && prevClose > 0;
  return {
    price: price,
    prevClose: hasPrev ? prevClose : '',
    change: hasPrev ? quoteRound_(price - prevClose) : '',
    changePct: hasPrev ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : '',
    time: time || '',
    source: source,
    name: name || ''
  };
}

/** 富果：lastPrice、previousClose；lastUpdated 是微秒 */
function fugleQuote_(body) {
  if (!body) return null;
  var us = Number(body.lastUpdated);
  return makeQuote_(body.lastPrice != null ? body.lastPrice : body.closePrice, body.previousClose,
    isFinite(us) && us > 0 ? new Date(Math.floor(us / 1000)).toISOString() : '', 'fugle', body.name);
}

/**
 * MIS：z 是「這 5 秒的成交價」，沒成交是 '-'（2026-10-08 實測盤中五檔全是 '-'）。
 * 依序讀 z → trade.z（最近一筆成交）→ 最佳買價 → 昨收 y。
 * 不存在的代號 MIS 會回一筆只有 tv,s,c,z 的空殼（c 是空的），一律當沒拿到。
 */
function misQuote_(it) {
  if (!it || !String(it.c || '').trim() || it.y == null) return null;
  var num = function (v) { var n = Number(String(v == null ? '' : v).split('_')[0]); return isFinite(n) && n > 0 ? n : null; };
  var price = num(it.z) || num(it.trade && it.trade.z) || num(it.b) || num(it.y);
  var d = String(it.d || ''), t = String(it.t || '');
  var time = /^\d{8}$/.test(d) && /^\d\d:\d\d:\d\d$/.test(t)
    ? new Date(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + 'T' + t + '+08:00').toISOString() : '';
  return makeQuote_(price, it.y, time, 'mis', it.n);
}

function fetchFugle_(symbols) {
  var key = PropertiesService.getScriptProperties().getProperty('FUGLE_API_KEY');
  if (!key || !symbols.length) return { quotes: {}, limited: false };
  var responses = UrlFetchApp.fetchAll(symbols.map(function (s) {
    return { url: FUGLE_QUOTE_URL + encodeURIComponent(s), method: 'get', headers: { 'X-API-KEY': key }, muteHttpExceptions: true };
  }));
  var quotes = {}, limited = false;
  responses.forEach(function (res, i) {
    var code = res.getResponseCode();
    if (code === 429) limited = true;
    if (code !== 200) return;
    var q = fugleQuote_(probeJson_(res.getContentText()));
    if (q) quotes[symbols[i]] = q;
  });
  return { quotes: quotes, limited: limited };
}

/** MIS 不知道代號是上市還是上櫃：兩種都問，回來哪個有資料就用哪個 */
function fetchMis_(symbols) {
  if (!symbols.length) return {};
  var exCh = [];
  symbols.forEach(function (s) { exCh.push('tse_' + s + '.tw'); exCh.push('otc_' + s + '.tw'); });
  var res = UrlFetchApp.fetch(TWSE_MIS_URL + '?ex_ch=' + encodeURIComponent(exCh.join('|')) + '&json=1&delay=0',
    { method: 'get', muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return {};
  var body = probeJson_(res.getContentText());
  var quotes = {};
  ((body && body.msgArray) || []).forEach(function (it) {
    var code = String(it.c || '').trim().toUpperCase();
    if (symbols.indexOf(code) === -1 || quotes[code]) return;
    var q = misQuote_(it);
    if (q) quotes[code] = q;
  });
  return quotes;
}

/**
 * GOOGLEFINANCE 只能在 Sheet 公式裡算：寫進 _stock_gf、flush、讀值。
 * ⚠️ 未實測：上市用 TPE:，上櫃代號在 Google 上的交易所前綴沒有把握，查不到就當沒拿到。
 * 延遲約 20 分鐘，畫面會標出來。
 */
function googleFinanceValues_(symbols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STOCK_GF_SHEET) || ss.insertSheet(STOCK_GF_SHEET);
  var rows = [['symbol', 'price', 'prev_close']].concat(symbols.map(function (s, i) {
    var r = i + 2;
    return [s, '=IFERROR(GOOGLEFINANCE("TPE:"&A' + r + ',"price"),"")', '=IFERROR(GOOGLEFINANCE("TPE:"&A' + r + ',"closeyest"),"")'];
  }));
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  SpreadsheetApp.flush();
  var values = sheet.getRange(2, 1, symbols.length, 3).getValues();
  var out = {};
  values.forEach(function (v) { out[String(v[0]).trim().toUpperCase()] = { price: v[1], prevClose: v[2] }; });
  return out;
}

function fetchGoogle_(symbols) {
  if (!symbols.length) return {};
  var values = googleFinanceValues_(symbols);
  var quotes = {};
  symbols.forEach(function (s) {
    var v = values[s];
    var q = v ? makeQuote_(v.price, v.prevClose, new Date().toISOString(), 'google', '') : null;
    if (q) quotes[s] = q;
  });
  return quotes;
}

/**
 * 最近一個應該有收盤價的交易日（台北）：平日 13:30 以後是今天，其餘往前找最近的平日。
 * 不知道國定假日——假日那天算出來的日子會比實際資料新，結果就是退回打外部，不會拿錯價。
 */
function lastTradingDayKey_(now) {
  var p = taipeiParts_(now);
  var t = p.t;
  var closed = p.day >= 1 && p.day <= 5 && p.minutes >= 13 * 60 + 30;
  var d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  if (!closed) d = new Date(d.getTime() - 86400000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * 盤後：stock_daily 每檔最新的一天，而且要不早於最近一個交易日（PR-B）——
 * 盤後排程拿到的若還是前一天的資料，晚上就不該拿那個當「現價」，退回打外部。
 */
function dailyCloses_(symbols, now) {
  var fresh = lastTradingDayKey_(now || new Date());
  var out = {};
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_DAILY_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return out;
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var col = function (n) { return headers.indexOf(n); };
  values.slice(1).forEach(function (row) {
    var sym = normalizeSymbol_(row[col('symbol')]);
    if (symbols.indexOf(sym) === -1) return;
    var date = keyValue_(row[col('date')]);
    if (out[sym] && out[sym].date >= date) return;
    var q = makeQuote_(row[col('close')], row[col('prev_close')], date, 'close', '');
    if (q) { q.date = date; out[sym] = q; }
  });
  Object.keys(out).forEach(function (sym) { if (out[sym].date < fresh) delete out[sym]; });
  return out;
}

/** 報價的效能紀錄：action=quote，sheets 欄寫「來源×檔數」（ADR-015 T1） */
function recordQuotePerf_(source, count, ms, ctx) {
  try {
    var c = ctx || {};
    var sheet = ensurePerformanceSheet_();
    var headers = perfHeaders_(sheet);
    var now = Date.now();
    var trigger = PERF_TRIGGERS.indexOf(c.trigger) !== -1 ? c.trigger : '';
    var r = { id: String(now) + source, ts: new Date(now).toISOString(), action: 'quote', trigger: trigger,
              server_ms: ms, sheets: source + '×' + count, rows: count,
              line_id: c.line_id || '', device_id: c.device_id || '' };
    sheet.appendRow(headers.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }));
  } catch (err) {
    console.log('寫報價效能紀錄失敗（主流程不受影響）：' + err);
  }
}

function noteFugleLimited_(cache, count) {
  try {
    if (cache && cache.get(FUGLE_429_KEY)) return;
    if (cache) cache.put(FUGLE_429_KEY, '1', FUGLE_429_TTL);
  } catch (err) {}
  try {
    logTransaction_(STOCK_LOG_SOURCE, '失敗', 'quote', '⚠️ 富果限流（429），改用備援來源',
      '這次 ' + count + ' 檔；十分鐘內同樣的情況不再重複記錄', '', '');
  } catch (err) {}
}

/**
 * 報價。回 { quotes: { 代號: {price, prevClose, change, changePct, time, source, name} }, missing: [] }。
 * GOLD 不報價。ctx = { trigger, line_id, device_id, now }（效能紀錄與測試用）。
 * 任何一個來源丟例外（被擋、逾時）都只是這一層沒拿到，往下一層走。
 */
function quote_(symbols, ctx) {
  ctx = ctx || {};
  var now = ctx.now || new Date();
  var wanted = [];
  (symbols || []).forEach(function (s) {
    var sym = normalizeSymbol_(s);
    if (sym && sym !== STOCK_GOLD && STOCK_SYMBOL_RE.test(sym) && wanted.indexOf(sym) === -1) wanted.push(sym);
  });
  var quotes = {};
  var cache = scriptCache_();
  var need = wanted.filter(function (s) {
    var hit = cache ? cacheGetJson_(cache, QUOTE_CACHE_PREFIX + s) : null;
    if (hit) quotes[s] = hit;
    return !hit;
  });

  var fetched = {};
  var tryLayer = function (source, fn) {
    if (!need.length) return;
    var started = Date.now();
    var got = {};
    try { got = fn(need) || {}; } catch (err) { console.log('報價來源 ' + source + ' 失敗：' + err); got = {}; }
    if (source !== 'close') recordQuotePerf_(source, need.length, Date.now() - started, ctx);
    Object.keys(got).forEach(function (s) { fetched[s] = got[s]; });
    need = need.filter(function (s) { return !got[s]; });
  };

  if (!isTwTradingTime_(now)) tryLayer('close', function (list) { return dailyCloses_(list, now); });
  tryLayer('fugle', function (list) {
    var r = fetchFugle_(list);
    if (r.limited) noteFugleLimited_(cache, list.length);
    return r.quotes;
  });
  tryLayer('mis', fetchMis_);
  tryLayer('google', fetchGoogle_);

  Object.keys(fetched).forEach(function (s) {
    quotes[s] = fetched[s];
    if (cache) { try { cache.put(QUOTE_CACHE_PREFIX + s, JSON.stringify(fetched[s]), QUOTE_CACHE_TTL); } catch (err) {} }
  });
  return { quotes: quotes, missing: need };
}

/** D-14：GOLD 直接通過；其餘格式對、而且查得到報價才算有效 */
function isValidSymbol_(raw, ctx) {
  var sym = normalizeSymbol_(raw);
  if (sym === STOCK_GOLD) return true;
  if (!STOCK_SYMBOL_RE.test(sym)) return false;
  return !!quote_([sym], ctx).quotes[sym];
}

/* ========================================================================== */
/* 資料表（ADR-015 T2：D-4、D-5、D-8、D-9）                                      */
/* ========================================================================== */

var STOCK_TRADES_HEADERS = ['id', 'trade_date', 'symbol', 'side', 'qty', 'price', 'fee', 'owner', 'note',
                            'line_id', 'created_at', 'del', 'archive'];
var STOCK_WATCH_HEADERS = ['symbol', 'name', 'sort', 'is_active', 'added_by', 'created_at'];
var STOCK_RULES_HEADERS = ['id', 'symbol', 'type', 'params', 'enabled', 'auto_push', 'cooldown_days',
                           'last_fired_at', 'line_id', 'created_at', 'del'];
var STOCK_DAILY_HEADERS = ['date', 'symbol', 'close', 'prev_close', 'source'];
var STOCK_CONFIG_HEADERS = ['key', 'value'];
/** _stock_config 初版（D-10）。rebalance_owner 留白＝管理者自己的 member；cash 要管理者自己填 */
var STOCK_CONFIG_SEED = [['rebalance_symbol', '00631L'], ['rebalance_owner', ''], ['cash', ''],
                         ['cash_updated_at', ''], ['target_pct', 50], ['threshold_rel_pct', 25]];
/** 全家共用的自選清單，啟用中最多 15 檔（後端擋） */
var STOCK_WATCH_MAX = 15;
var STOCK_MEMBER_GROUP = '家人';
var STOCK_MEMBERS_CACHE_KEY = 'adr015_members_v1';
var STOCK_MEMBERS_CACHE_TTL = 300;

function stockSheetSpecs_() {
  return [
    { name: STOCK_TRADES_SHEET, headers: STOCK_TRADES_HEADERS },
    { name: STOCK_WATCH_SHEET, headers: STOCK_WATCH_HEADERS },
    { name: STOCK_RULES_SHEET, headers: STOCK_RULES_HEADERS },
    { name: STOCK_DAILY_SHEET, headers: STOCK_DAILY_HEADERS },
    { name: STOCK_CONFIG_SHEET, headers: STOCK_CONFIG_HEADERS, seed: STOCK_CONFIG_SEED }
  ];
}

/**
 * 「初始化」的股票那一步：建五張表（已存在只補缺的欄，不動資料）、line_users 補 feat_stock 與 member。
 * feat_stock 欄**這一次才新增**時，替管理者打勾（D-5：只有 Neil 預設開）；之後誰關掉都不會被蓋回來。
 */
function installStock_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lines = [], warn = false;
  stockSheetSpecs_().forEach(function (spec) {
    var sheet = ss.getSheetByName(spec.name);
    if (!sheet || sheet.getLastRow() === 0) {
      sheet = sheet || ss.insertSheet(spec.name);
      var rows = [spec.headers].concat(spec.seed || []);
      sheet.getRange(1, 1, rows.length, spec.headers.length).setValues(rows);
      keepSymbolsText_(sheet);
      lines.push('建立 ' + spec.name);
      return;
    }
    var r = ensureColumnsOnSheet_(sheet, spec.headers);
    if (r.added.length) lines.push(spec.name + ' 補上：' + r.added.join('、'));
    keepSymbolsText_(sheet);
    var broken = numericSymbolRows_(sheet);
    if (broken.length) {
      warn = true;
      lines.push('⚠️ ' + spec.name + ' 有 ' + broken.length + ' 列代號被 Sheet 轉成數字（' + broken.join('、') +
        '）——開頭的 0 不見了，請在 Sheet 上改回原本的代號（例如 0056），或刪掉重新加');
    }
  });

  var users = ss.getSheetByName(LINE_USERS_SHEET);
  if (!users) {
    warn = true;
    lines.push('⚠️ 找不到 ' + LINE_USERS_SHEET + '，沒有補 feat_stock／member');
  } else {
    var u = ensureColumnsOnSheet_(users, ['feat_stock', 'member']);
    if (u.reason) {
      warn = true;
      lines.push('⚠️ ' + LINE_USERS_SHEET + ' 沒有表頭，沒有補欄位');
    } else if (u.added.length) {
      lines.push(LINE_USERS_SHEET + ' 補上：' + u.added.join('、'));
      if (u.added.indexOf('feat_stock') !== -1) {
        var headers = sheetHeaders_(users);
        var admins = 0;
        if (users.getLastRow() >= 2) {
          var values = users.getRange(2, 1, users.getLastRow() - 1, headers.length).getValues();
          values.forEach(function (row, i) {
            if (truthy_(row[headers.indexOf('is_admin')])) {
              users.getRange(i + 2, headers.indexOf('feat_stock') + 1, 1, 1).setValues([['TRUE']]);
              admins++;
            }
          });
        }
        lines.push('feat_stock 預設只開管理者（' + admins + ' 人）');
        invalidateLineUsersCache_();
      }
    }
  }
  return { level: warn ? 'warn' : 'ok', text: lines.length ? lines.join('\n　') : '股票分頁與欄位已齊備' };
}

/**
 * 代號欄設成純文字（2026-10-08 實機回報：自選三筆只有第一筆有報價）。
 * Sheet 會把「全是數字」的字串轉成數字：0050 存成 50、00878 存成 878，讀回來不符合代號格式就不報價，
 * 交易與持股也對不起來。00631L 帶英文字不受影響，所以只有它有報價。
 * 「初始化」整欄設一次；每個寫入點寫之前再設一次（有人在 Sheet 上改了格式也救得回來）。
 */
function keepSymbolsText_(sheet) {
  if (!sheet) return;
  var col = sheetHeaders_(sheet).indexOf('symbol') + 1;
  if (col) sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
}

/** 已經被轉成數字的舊代號：只回報、不猜（56 原本是 0056 還是 00056，程式不知道） */
function numericSymbolRows_(sheet) {
  var headers = sheetHeaders_(sheet);
  var col = headers.indexOf('symbol');
  if (col === -1 || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    .map(function (row) { return row[col]; })
    .filter(function (v) { return typeof v === 'number'; });
}

/** 家人名單（_expense_config：kind=target、parent=家人、啟用中），依 sort 排。快取 5 分鐘 */
function stockMembers_() {
  var cache = scriptCache_();
  var hit = cache ? cacheGetJson_(cache, STOCK_MEMBERS_CACHE_KEY) : null;
  if (hit) return hit;
  var names = [];
  try {
    var cfg = configRows_(SpreadsheetApp.getActiveSpreadsheet());
    names = cfg.rows.map(function (r) { return r.record; }).filter(function (rec) {
      return String(rec.kind).trim().toLowerCase() === 'target' && String(rec.parent).trim() === STOCK_MEMBER_GROUP &&
        configActive_(rec.is_active);
    }).sort(function (a, b) { return configSort_(a.sort) - configSort_(b.sort); })
      .map(function (rec) { return String(rec.name).trim(); });
  } catch (err) {
    console.log('讀家人名單失敗：' + err);
    return [];
  }
  if (cache) { try { cache.put(STOCK_MEMBERS_CACHE_KEY, JSON.stringify(names), STOCK_MEMBERS_CACHE_TTL); } catch (err) {} }
  return names;
}

function memberOf_(user) {
  return String((user && user.member) == null ? '' : user.member).trim();
}

/**
 * 寫入時的持有者（D-8，後端強制）：
 *  - 管理者：可指定任何家人；沒指定＝自己的 member
 *  - 非管理者：一律是自己的 member（指定別人會被覆寫，overridden=true 讓呼叫端提示）
 *  - 沒設 member 的非管理者：拒絕
 */
function resolveOwner_(user, wanted) {
  var mine = memberOf_(user);
  var want = String(wanted == null ? '' : wanted).trim();
  if (truthy_((user || {}).is_admin)) {
    var owner = want || mine;
    if (!owner) return { error: 'owner_required' };
    if (stockMembers_().indexOf(owner) === -1) return { error: 'owner_not_member', owner: owner };
    return { owner: owner, overridden: false };
  }
  if (!mine) return { error: 'no_member' };
  return { owner: mine, overridden: !!want && want !== mine };
}

function stockSheetRecords_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) return { error: 'sheet_not_found', rows: [] };
  var read = sheetRecords_(SpreadsheetApp.getActiveSpreadsheet(), name, {});
  return { sheet: sheet, rows: read.rows || [] };
}

/**
 * PWA 對 stock_trades 的 upsert：把送上來的那一筆整理好再交給 upsertRow_（跟 keepOriginChat_ 同一個位置）。
 * 回 { record } 或 { error, ... }。
 *  - 代號大寫、side 只收 buy／sell、數量與價格要是正數（股票整數股、GOLD 小數 2 位）
 *  - 非管理者只能改自己記的那幾筆（line_id 對不上就擋）；line_id、created_at 一律沿用雲端那一列
 *  - owner 照 resolveOwner_
 *  - 寫完以後的整本帳不能有任何一刻賣超（含刪掉一筆買進、改小一筆買進）
 *  - 沒出現過的代號查一次報價確認有效（D-14）
 */
function guardStockTrade_(caller, record) {
  var rec = Object.assign({}, record || {});
  var id = keyValue_(rec.id);
  if (!id) return { error: 'invalid_trade', field: 'id' };
  var all = stockSheetRecords_(STOCK_TRADES_SHEET);
  if (all.error) return { error: all.error };
  var existing = all.rows.filter(function (r) { return keyValue_(r.id) === id; })[0] || null;
  var isAdmin = truthy_((caller.user || {}).is_admin);
  if (existing && !isAdmin && String(existing.line_id).trim() !== caller.line_id) return { error: 'not_your_trade' };

  rec.id = id;
  rec.line_id = existing ? String(existing.line_id).trim() : caller.line_id;
  rec.created_at = existing && existing.created_at ? existing.created_at : new Date().toISOString();

  var deleting = isTombstone_(rec);
  if (!deleting) {
    rec.symbol = normalizeSymbol_(rec.symbol);
    rec.side = String(rec.side == null ? '' : rec.side).trim().toLowerCase();
    var qty = parseStockNumber_(rec.qty), price = parseStockNumber_(rec.price);
    var fee = rec.fee === '' || rec.fee == null ? 0 : Number(toHalfWidth_(rec.fee).replace(/,/g, ''));
    if (['buy', 'sell'].indexOf(rec.side) === -1) return { error: 'invalid_trade', field: 'side' };
    if (!isFinite(qty) || (!isGold_(rec.symbol) && Math.round(qty) !== qty)) return { error: 'invalid_trade', field: 'qty' };
    if (!isFinite(price)) return { error: 'invalid_trade', field: 'price' };
    if (!isFinite(fee) || fee < 0) return { error: 'invalid_trade', field: 'fee' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(keyValue_(rec.trade_date))) return { error: 'invalid_trade', field: 'trade_date' };
    rec.qty = roundQty_(rec.symbol, qty);
    rec.price = price;
    rec.fee = fee || '';
    rec.trade_date = keyValue_(rec.trade_date);
    var known = all.rows.some(function (r) { return normalizeSymbol_(r.symbol) === rec.symbol; });
    if (!known && !isValidSymbol_(rec.symbol, { trigger: 'write', line_id: caller.line_id })) {
      return { error: 'invalid_symbol', symbol: rec.symbol };
    }
  } else if (existing) {
    // 軟刪除：其他欄位沿用雲端那一列，只換 del
    var del = rec.del;
    rec = Object.assign({}, existing, { del: del });
  } else {
    return { error: 'trade_not_found' };
  }

  // 刪除沿用原持有者；新增與修改照 D-8 決定
  var owner = deleting ? { owner: String(rec.owner == null ? '' : rec.owner).trim(), overridden: false }
    : resolveOwner_(caller.user, rec.owner);
  if (owner.error) return owner;
  rec.owner = owner.owner;

  var after = all.rows.filter(function (r) { return keyValue_(r.id) !== id; }).concat([rec]);
  var book = computeHoldings_(after);
  if (!book.ok) return { error: 'oversold', owner: book.owner, symbol: book.symbol, held: book.held };
  return { record: rec, overridden: owner.overridden };
}

/** 自選清單：只有管理者能寫（D-9）；啟用中最多 15 檔；名稱跟著報價自動帶 */
function guardStockWatch_(caller, record) {
  if (!truthy_((caller.user || {}).is_admin)) return { error: 'forbidden' };
  var rec = Object.assign({}, record || {});
  rec.symbol = normalizeSymbol_(rec.symbol);
  if (!rec.symbol || rec.symbol === STOCK_GOLD) return { error: 'invalid_symbol', symbol: rec.symbol };
  var all = stockSheetRecords_(STOCK_WATCH_SHEET);
  if (all.error) return { error: all.error };
  var existing = all.rows.filter(function (r) { return normalizeSymbol_(r.symbol) === rec.symbol; })[0] || null;
  var active = rec.is_active === undefined ? (existing ? existing.is_active : 'TRUE') : rec.is_active;
  rec.is_active = truthy_(active) ? 'TRUE' : 'FALSE';
  if (rec.is_active === 'TRUE') {
    var others = all.rows.filter(function (r) { return normalizeSymbol_(r.symbol) !== rec.symbol && truthy_(r.is_active); }).length;
    if (others >= STOCK_WATCH_MAX) return { error: 'watch_full', max: STOCK_WATCH_MAX };
  }
  if (!existing) {
    var q = quote_([rec.symbol], { trigger: 'write', line_id: caller.line_id }).quotes[rec.symbol];
    if (!q) return { error: 'invalid_symbol', symbol: rec.symbol };
    rec.name = rec.name || q.name || '';
    var maxSort = 0;
    all.rows.forEach(function (r) { var n = Number(r.sort); if (isFinite(n) && n > maxSort) maxSort = n; });
    rec.sort = rec.sort === undefined || rec.sort === '' ? maxSort + 10 : rec.sort;
  }
  rec.name = rec.name !== undefined ? rec.name : existing.name;
  rec.sort = rec.sort !== undefined ? rec.sort : existing.sort;
  rec.added_by = existing ? existing.added_by : caller.line_id;
  rec.created_at = existing && existing.created_at ? existing.created_at : new Date().toISOString();
  return { record: rec };
}

/**
 * readMany／boot 附帶的股票資料（只給有 feat_stock、而且前端說「我在財務區」的請求，T4）。
 * 交易全家都看得到（有 feat_stock 就不套用「只看我的」，D-5）。報價失敗不影響其他資料。
 */
function stockPayload_(caller, trigger) {
  var trades = stockSheetRecords_(STOCK_TRADES_SHEET);
  var watch = stockSheetRecords_(STOCK_WATCH_SHEET);
  var tradeRows = withoutTombstones_(trades.rows || []);
  var watchRows = (watch.rows || []).filter(function (r) { return truthy_(r.is_active); })
    .sort(function (a, b) { return configSort_(a.sort) - configSort_(b.sort); });
  var book = computeHoldings_(tradeRows);
  var holdings = book.ok ? book.holdings : [];
  var isAdmin = truthy_((caller.user || {}).is_admin);
  // 提醒規則是個人的：只回自己的（PR-B）
  var rules = withoutTombstones_(stockSheetRecords_(STOCK_RULES_SHEET).rows || [])
    .filter(function (r) { return String(r.line_id).trim() === caller.line_id; });
  var cfg = isAdmin ? stockConfig_() : null;
  var symbols = watchRows.map(function (r) { return normalizeSymbol_(r.symbol); })
    .concat(holdings.map(function (h) { return h.symbol; }))
    .concat(rules.map(function (r) { return normalizeSymbol_(r.symbol); }))
    .concat(cfg ? [normalizeSymbol_(cfg.rebalance_symbol || '00631L')] : []);
  var q = { quotes: {}, missing: [] };
  try {
    q = quote_(symbols, { trigger: trigger, line_id: caller.line_id, device_id: caller.device ? caller.device.device_id : '' });
  } catch (err) {
    console.log('報價失敗（其他資料照常回）：' + err);
  }
  var out = {
    ready: !trades.error && !watch.error,
    trading: isTwTradingTime_(new Date()),
    trades: tradeRows.map(function (r) { return plainRecord_(r, STOCK_TRADES_HEADERS); }),
    watch: watchRows.map(function (r) { return plainRecord_(r, STOCK_WATCH_HEADERS); }),
    holdings: holdings,
    book_error: book.ok ? '' : book.error,
    quotes: q.quotes,
    missing: q.missing,
    members: stockMembers_(),
    my_member: memberOf_(caller.user),
    rules: rules.map(function (r) { return plainRecord_(r, STOCK_RULES_HEADERS); }),
    hits: ruleHits_(rules, q.quotes, holdings)
  };
  // 再平衡與現金只給管理者（D-10）：非管理者的回應裡連這兩個鍵都沒有
  if (cfg) {
    out.config = { rebalance_symbol: cfg.rebalance_symbol || '', rebalance_owner: cfg.rebalance_owner || '',
                   cash: cfg.cash === undefined ? '' : cfg.cash, cash_updated_at: cfg.cash_updated_at || '',
                   target_pct: cfg.target_pct === undefined ? '' : cfg.target_pct,
                   threshold_rel_pct: cfg.threshold_rel_pct === undefined ? '' : cfg.threshold_rel_pct };
    out.rebalance = computeRebalance_(cfg, holdings, q.quotes, memberOf_(caller.user), taipeiDateKey_(new Date()));
  }
  return out;
}

function withStock_(out, caller, body) {
  if (!body || body.stock !== true || !canUse_(caller.user, 'feat_stock')) return out;
  try {
    out.stock = stockPayload_(caller, body.trigger);
  } catch (err) {
    console.log('股票資料讀取失敗：' + err);
    out.stock = { error: 'stock_failed' };
  }
  return out;
}

/* ========================================================================== */
/* LINE「買/」「賣/」「股/」（ADR-015 T3：D-6、D-7、D-8）                          */
/*                                                                            */
/* 只接受一對一聊天（群組在 groupCommandOf_ 就被擋，D-8：持股資訊私密）。          */
/* ========================================================================== */

/* 前綴表 STOCK_PREFIXES 與用法字串在 line-router.gs（路由的地方），這裡只放處理邏輯 */
var STOCK_SOURCE_LABEL = { fugle: '富果', mis: '證交所', google: 'Google（延遲約 20 分）', close: '收盤' };
var STOCK_NO_MEMBER_TEXT = '請管理者先設定你是家人名單裡的哪一位（App ▸ 成員與權限 ▸ 家人）。';

/** 千分位＋最多 dec 位小數（不補零）。formatAmount_ 會把小數部分也加上逗號，這裡不能用 */
function fmtStock_(n, dec) {
  var x = Number(n);
  if (!isFinite(x)) return '';
  var p = Math.pow(10, dec == null ? 2 : dec);
  var s = String(Math.round(Math.abs(x) * p) / p);
  var parts = s.split('.');
  return (x < 0 ? '-' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (parts[1] ? '.' + parts[1] : '');
}

function signed_(n, dec) {
  return (Number(n) > 0 ? '+' : '') + fmtStock_(n, dec);
}

function stockUnit_(symbol) {
  return isGold_(symbol) ? '公克' : '股';
}

/** 台北的今天（YYYY-MM-DD）。不用 dateKey_：要可以在測試裡用固定時間算 */
function taipeiDateKey_(now) {
  return taipeiParts_(now || new Date()).t.toISOString().slice(0, 10);
}

/** 報價的來源與時間：富果 · 10:28:15／收盤 · 10/8 */
function quoteStamp_(q) {
  var label = STOCK_SOURCE_LABEL[q.source] || q.source;
  if (q.source === 'close') {
    var d = String(q.date || q.time || '');
    return label + (d ? ' · ' + Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)) : '');
  }
  var t = q.time ? taipeiStamp_(new Date(q.time)).slice(11) : '';
  return label + (t ? ' · ' + t : '');
}

/** 持有一行：爸爸持有 3,000 股｜均價 39.85［｜損益 +3,450（+2.9%）］ */
function holdingLine_(h, price) {
  var line = h.owner + '持有 ' + fmtStock_(h.qty, 2) + ' ' + stockUnit_(h.symbol) + '｜均價 ' + fmtStock_(h.avg_cost, 2);
  if (isFinite(Number(price)) && Number(price) > 0 && !isGold_(h.symbol)) {
    var pnl = Number(price) * h.qty - h.cost;
    line += '｜損益 ' + signed_(pnl, 0) + '（' + signed_(h.cost ? (pnl / h.cost) * 100 : 0, 2) + '%）';
  }
  return line;
}

/** 回 null＝不是股票前綴，交給一般路由 */
function handleStockCommand_(prefix, rest, text, userId, now) {
  var kind = STOCK_PREFIXES[prefix];
  if (!kind) return null;
  var user = lineUserById_(userId);
  if (!canUse_(user, 'feat_stock')) {
    logTransaction_(STOCK_LOG_SOURCE, '失敗', text, '沒有「股票」功能的權限', 'code=forbidden｜feat_stock', '', userId);
    return '你沒有「股票」功能的權限。\n需要的話請管理者到 App 的「成員與權限」打開。';
  }
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_TRADES_SHEET)) {
    logTransaction_(STOCK_LOG_SOURCE, '失敗', text, '股票分頁還沒建', '', '', userId);
    return '股票功能還沒初始化，請管理者傳「初始化」。';
  }
  var ctx = { trigger: 'line', line_id: userId, now: now };
  return kind === 'quote' ? stockQuoteReply_(rest, text, user, userId, ctx)
    : stockTradeReply_(kind, prefix, rest, text, user, userId, ctx);
}

function stockFail_(text, userId, result, reply) {
  logTransaction_(STOCK_LOG_SOURCE, '失敗', text, result, '', '', userId);
  return reply;
}

function stockTradeReply_(side, prefix, rest, text, user, userId, ctx) {
  var usage = '格式：' + STOCK_TRADE_USAGE.replace(/^買/, prefix);
  var parts = toHalfWidth_(rest).split('/').map(function (p) { return p.trim(); });
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return stockFail_(text, userId, '缺少欄位', '少了欄位喔。\n' + usage);
  var symbol = normalizeSymbol_(parts[0]);
  var qty = parseStockNumber_(parts[1]);
  var price = parseStockNumber_(parts[2]);
  if (!isFinite(qty) || (!isGold_(symbol) && Math.round(qty) !== qty)) {
    return stockFail_(text, userId, '數量不對', '數量要是正數' + (isGold_(symbol) ? '' : '（股票是整數股）') + '，你打的是「' + parts[1] + '」。\n' + usage);
  }
  if (!isFinite(price)) return stockFail_(text, userId, '價格不對', '價格要是正數，你打的是「' + parts[2] + '」。\n' + usage);
  if (!isValidSymbol_(symbol, ctx)) return stockFail_(text, userId, '代號無效：' + symbol, '查不到「' + symbol + '」這個代號，沒有記下來。');

  var owner = resolveOwner_(user, parts[3]);
  if (owner.error === 'owner_not_member') {
    return stockFail_(text, userId, '持有者不在家人名單：' + owner.owner,
      '「' + owner.owner + '」不在家人名單裡。\n可以用：' + stockMembers_().join('、'));
  }
  if (owner.error) return stockFail_(text, userId, '沒有設定 member', STOCK_NO_MEMBER_TEXT);

  var trades = withoutTombstones_(stockSheetRecords_(STOCK_TRADES_SHEET).rows);
  var record = {
    id: String(Date.now()), trade_date: taipeiDateKey_(ctx.now), symbol: symbol, side: side,
    qty: roundQty_(symbol, qty), price: price, fee: '', owner: owner.owner, note: '',
    line_id: userId, created_at: new Date().toISOString(), del: '', archive: ''
  };
  var book = computeHoldings_(trades.concat([record]));
  if (!book.ok) {
    var held = holdingOf_(computeHoldings_(trades).holdings, owner.owner, symbol);
    return stockFail_(text, userId, '賣超過持有量',
      '賣不了：' + owner.owner + '目前持有 ' + symbol + ' ' + fmtStock_(held ? held.qty : 0, 2) + ' ' + stockUnit_(symbol) + '。');
  }

  keepSymbolsText_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_TRADES_SHEET));
  var row = appendToSheet_(STOCK_TRADES_SHEET, record);
  var name = isGold_(symbol) ? '黃金' : ((quote_([symbol], ctx).quotes[symbol] || {}).name || '');
  var after = holdingOf_(book.holdings, owner.owner, symbol);
  var lines = [
    '✅ ' + (side === 'buy' ? '買進' : '賣出') + ' ' + symbol + (name ? ' ' + name : ''),
    fmtStock_(record.qty, 2) + ' ' + stockUnit_(symbol) + ' × ' + fmtStock_(price, 4) + ' = ' + fmtStock_(record.qty * price, 0),
    after ? holdingLine_(after) : owner.owner + '已無持有 ' + symbol
  ];
  if (owner.overridden) lines.push('（持有者只能是你自己，已記在' + owner.owner + '名下）');
  logTransaction_(STOCK_LOG_SOURCE, '成功', text,
    (side === 'buy' ? '買進 ' : '賣出 ') + symbol + ' ' + record.qty + '@' + price + '／' + owner.owner, '', row, userId);
  return lines.join('\n');
}

function stockQuoteReply_(rest, text, user, userId, ctx) {
  var symbol = normalizeSymbol_(rest);
  if (!symbol) return stockFail_(text, userId, '缺少代號', '格式：' + STOCK_QUOTE_USAGE);
  var mine = memberOf_(user);
  var trades = withoutTombstones_(stockSheetRecords_(STOCK_TRADES_SHEET).rows);
  var held = mine ? holdingOf_(computeHoldings_(trades).holdings, mine, symbol) : null;
  if (isGold_(symbol)) {
    logTransaction_(STOCK_LOG_SOURCE, '成功', text, '查詢 GOLD', '', '', userId);
    return '🥇 黃金只記錄、不抓價。' + (held ? '\n' + holdingLine_(held) : '');
  }
  var q = STOCK_SYMBOL_RE.test(symbol) ? quote_([symbol], ctx).quotes[symbol] : null;
  if (!q) return stockFail_(text, userId, '代號無效：' + symbol, '查不到「' + symbol + '」這個代號。');
  var lines = [
    '📈 ' + symbol + (q.name ? ' ' + q.name : ''),
    fmtStock_(q.price, 4) + (q.change === '' ? '' : '（' + signed_(q.change, 4) + '｜' + signed_(q.changePct, 2) + '%）'),
    quoteStamp_(q)
  ];
  if (held) lines.push(holdingLine_(held, q.price));
  logTransaction_(STOCK_LOG_SOURCE, '成功', text, '查詢 ' + symbol + ' ' + q.price + '（' + q.source + '）', '', '', userId);
  return lines.join('\n');
}

/* ========================================================================== */
/* T5：00631L 再平衡（ADR-015 D-10）。只有管理者看得到、改得到                  */
/* ========================================================================== */

var STOCK_CONFIG_KEYS = ['rebalance_symbol', 'rebalance_owner', 'cash', 'target_pct', 'threshold_rel_pct'];
var STOCK_CASH_STALE_DAYS = 30;

/** _stock_config → { key: value }。分頁不存在回空物件 */
function stockConfig_() {
  var read = stockSheetRecords_(STOCK_CONFIG_SHEET);
  var cfg = {};
  (read.rows || []).forEach(function (r) {
    var k = String(r.key == null ? '' : r.key).trim();
    if (k) cfg[k] = r.value instanceof Date ? keyValue_(r.value) : (r.value == null ? '' : r.value);
  });
  return cfg;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 再平衡試算。純函式。
 *   ratio ＝ V ÷ (V ＋ 現金)，V ＝ 持有者名下該檔股數 × 現價
 *   區間 ＝ 目標 × (1 ± 相對門檻)；區間外亮燈，建議金額 ＝ (V ＋ 現金) × 目標 − V（正＝買、負＝賣）
 * status 不是 ok 時卡片不出現：no_holding（沒持股）、no_cash（沒填現金，設定頁提示）、no_quote（沒報價）
 */
function computeRebalance_(cfg, holdings, quotes, myMember, todayKey) {
  var symbol = normalizeSymbol_(cfg.rebalance_symbol || '00631L');
  var owner = String(cfg.rebalance_owner == null ? '' : cfg.rebalance_owner).trim() || myMember || '';
  var target = Number(cfg.target_pct), thr = Number(cfg.threshold_rel_pct);
  var base = { symbol: symbol, owner: owner, target_pct: isFinite(target) ? target : '', threshold_rel_pct: isFinite(thr) ? thr : '',
               cash_updated_at: cfg.cash_updated_at || '' };
  var h = holdingOf_(holdings, owner, symbol);
  if (!h) return Object.assign(base, { status: 'no_holding' });
  var cashRaw = cfg.cash;
  var cash = Number(cashRaw);
  if (cashRaw === '' || cashRaw == null || !isFinite(cash) || cash < 0) return Object.assign(base, { status: 'no_cash' });
  if (!isFinite(target) || target <= 0 || target >= 100 || !isFinite(thr) || thr <= 0) return Object.assign(base, { status: 'no_target' });
  var q = (quotes || {})[symbol];
  if (!q) return Object.assign(base, { status: 'no_quote' });

  var value = h.qty * q.price, total = value + cash;
  var ratio = total ? value / total : 0;
  var t = target / 100, r = thr / 100;
  var low = t * (1 - r), high = t * (1 + r);
  var alert = ratio < low || ratio > high;
  var suggest = total * t - value;
  var updated = String(cfg.cash_updated_at || '');
  var stale = !updated || (Date.parse(todayKey) - Date.parse(updated.slice(0, 10))) / 86400000 > STOCK_CASH_STALE_DAYS;
  return Object.assign(base, {
    status: 'ok', shares: h.qty, price: q.price, value: Math.round(value), cash: cash,
    ratio_pct: round2_(ratio * 100), low_pct: round2_(low * 100), high_pct: round2_(high * 100), alert: alert,
    suggest_amount: alert ? Math.round(suggest) : 0, suggest_shares: alert ? Math.round(suggest / q.price) : 0,
    cash_stale: stale
  });
}

/** 管理者改 _stock_config 的一格（比照 ADR-013 configSet：只收白名單裡的 key、驗過值才寫） */
function stockConfigSet_(caller, key, value) {
  var forbidden = adminForbidden_(caller, 'stockConfigSet');
  if (forbidden) return forbidden;
  if (STOCK_CONFIG_KEYS.indexOf(key) === -1) return { error: 'invalid_key' };
  var v = value == null ? '' : value;
  if (key === 'cash') {
    v = String(toHalfWidth_(v)).replace(/,/g, '').trim();
    if (v !== '' && (!isFinite(Number(v)) || Number(v) < 0)) return { error: 'invalid_value', key: key };
    v = v === '' ? '' : Number(v);
  } else if (key === 'target_pct' || key === 'threshold_rel_pct') {
    v = Number(v);
    if (!isFinite(v) || v <= 0 || v >= 100) return { error: 'invalid_value', key: key };
  } else if (key === 'rebalance_symbol') {
    v = normalizeSymbol_(v);
    if (!isValidSymbol_(v, { trigger: 'write', line_id: caller.line_id }) || v === STOCK_GOLD) return { error: 'invalid_symbol', symbol: v };
  } else if (key === 'rebalance_owner') {
    v = String(v).trim();
    if (v && stockMembers_().indexOf(v) === -1) return { error: 'owner_not_member', owner: v };
  }
  var read = stockSheetRecords_(STOCK_CONFIG_SHEET);
  if (read.error) return { error: read.error };
  var patch = {};
  patch[key] = v;
  if (key === 'cash') patch.cash_updated_at = taipeiDateKey_(new Date());
  var headers = sheetHeaders_(read.sheet);
  Object.keys(patch).forEach(function (k) {
    // value 欄數字文字混放（現金是數字），不能整欄設純文字：代號前面加 ' 強制存成文字，讀回來不會有那個 '
    var value = k === 'rebalance_symbol' ? "'" + patch[k] : patch[k];
    upsertRow_(read.sheet, headers, { key: k, value: value }, STOCK_CONFIG_SHEET, 'key');
  });
  settingsLog_(caller, 'stockConfigSet ' + key, '→ ' + (v === '' ? '（空白）' : v));
  return { success: true, key: key, value: v, cash_updated_at: patch.cash_updated_at || '' };
}

/* ========================================================================== */
/* T6：提醒規則（ADR-015 D-11、D-12）                                           */
/*                                                                            */
/* 判斷邏輯只有這一份：儀表板亮燈（readMany 帶回 hits）與自動推播都用 evaluateRule_。 */
/* 新增一種規則＝在 STOCK_RULE_TYPES 加一筆，其他地方不用動。                      */
/* ========================================================================== */

var STOCK_RULE_UNKNOWN_PREFIX = 'adr015_unk_';
var STOCK_RULE_UNKNOWN_TTL = 21600;   // CacheService 上限 6 小時：同一條不認得的規則最多每 6 小時記一次
var STOCK_RULES_FUNCTION = 'checkStockRules';
var STOCK_RULES_MINUTES = 5;
var STOCK_DAILY_FUNCTION = 'fetchStockDaily';
var STOCK_DAILY_HOUR = 14;
var STOCK_DAILY_MINUTE = 30;
var STOCK_PUSH_SOURCE = '股票提醒';

function ruleNum_(v) {
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/** 類型 → { label, check(params, quote, holdings) → null（不判斷）或 { hit, reason } } */
var STOCK_RULE_TYPES = {
  price_above: {
    label: '價格高於',
    valid: function (p) { return ruleNum_(p.price) > 0; },
    check: function (p, q) {
      return { hit: q.price >= Number(p.price), reason: '現價 ' + fmtStock_(q.price, 4) + ' ≥ ' + fmtStock_(p.price, 4) };
    }
  },
  price_below: {
    label: '價格低於',
    valid: function (p) { return ruleNum_(p.price) > 0; },
    check: function (p, q) {
      return { hit: q.price <= Number(p.price), reason: '現價 ' + fmtStock_(q.price, 4) + ' ≤ ' + fmtStock_(p.price, 4) };
    }
  },
  change_pct: {
    label: '當日漲跌超過',
    valid: function (p) { return ruleNum_(p.pct) > 0; },
    check: function (p, q) {
      if (q.changePct === '' || q.changePct == null) return null;
      return { hit: Math.abs(Number(q.changePct)) >= Number(p.pct),
               reason: '漲跌 ' + signed_(q.changePct, 2) + '%（超過 ±' + fmtStock_(p.pct, 2) + '%）' };
    }
  },
  cost_pct: {
    label: '相對成本',
    valid: function (p) { return ruleNum_(p.pct) !== null && Number(p.pct) !== 0 && !!String(p.owner || '').trim(); },
    check: function (p, q, holdings, symbol) {
      var h = holdingOf_(holdings, String(p.owner).trim(), symbol);
      if (!h || !h.avg_cost) return null;                      // 沒持股不判斷
      var ret = (q.price - h.avg_cost) / h.avg_cost * 100;
      var pct = Number(p.pct);
      return { hit: pct < 0 ? ret <= pct : ret >= pct,
               reason: h.owner + ' 報酬 ' + signed_(ret, 2) + '%（' + (pct < 0 ? '跌破 ' : '漲過 ') + signed_(pct, 2) + '%）' };
    }
  }
};

function ruleParams_(rule) {
  var p = rule && rule.params;
  if (p && typeof p === 'object') return p;
  try { return JSON.parse(String(p || '{}')) || {}; } catch (err) { return null; }
}

/**
 * 一條規則對一檔報價。回 { status: 'hit'|'miss'|'skip'|'unknown'|'invalid', reason }。
 * 不認得的 type 回 unknown（呼叫端記 logs、略過，不中斷其他規則）。
 */
function evaluateRule_(rule, quote, holdings) {
  var type = STOCK_RULE_TYPES[String(rule && rule.type || '').trim()];
  if (!type) return { status: 'unknown', reason: '不認得的規則類型「' + (rule && rule.type) + '」' };
  var params = ruleParams_(rule);
  if (!params || !type.valid(params)) return { status: 'invalid', reason: '規則參數不對' };
  if (!quote) return { status: 'skip', reason: '沒有報價' };
  var r = type.check(params, quote, holdings || [], normalizeSymbol_(rule.symbol));
  if (!r) return { status: 'skip', reason: '' };
  return { status: r.hit ? 'hit' : 'miss', reason: r.reason };
}

function noteUnknownRule_(rule) {
  var cache = scriptCache_();
  var key = STOCK_RULE_UNKNOWN_PREFIX + String(rule.id);
  try { if (cache && cache.get(key)) return; if (cache) cache.put(key, '1', STOCK_RULE_UNKNOWN_TTL); } catch (err) {}
  try {
    logTransaction_(STOCK_LOG_SOURCE, '失敗', 'rule ' + rule.id, '⚠️ 不認得的規則類型「' + rule.type + '」，略過',
      '其他規則照常判斷；這條每 6 小時最多記一次', '', String(rule.line_id || ''));
  } catch (err) {}
}

/** 規則 → 每檔命中的原因 { 代號: [{ id, type, reason }] }。只看啟用中、沒刪的 */
function ruleHits_(rules, quotes, holdings) {
  var hits = {};
  (rules || []).forEach(function (rule) {
    if (isTombstone_(rule) || !truthy_(rule.enabled)) return;
    var sym = normalizeSymbol_(rule.symbol);
    var r = evaluateRule_(rule, (quotes || {})[sym], holdings);
    if (r.status === 'unknown') { noteUnknownRule_(rule); return; }
    if (r.status !== 'hit') return;
    (hits[sym] = hits[sym] || []).push({ id: String(rule.id), type: String(rule.type), reason: r.reason });
  });
  return hits;
}

/**
 * PWA 對 stock_rules 的 upsert。規則是個人的：只能改自己的（管理者也一樣），line_id 一律是本人；
 * last_fired_at 只有排程會寫；PWA 只收認得的類型（不認得的 type 只可能是手改 Sheet 來的）。
 */
function guardStockRule_(caller, record) {
  var rec = Object.assign({}, record || {});
  var id = keyValue_(rec.id);
  if (!id) return { error: 'invalid_rule', field: 'id' };
  var all = stockSheetRecords_(STOCK_RULES_SHEET);
  if (all.error) return { error: all.error };
  var existing = all.rows.filter(function (r) { return keyValue_(r.id) === id; })[0] || null;
  if (existing && String(existing.line_id).trim() !== caller.line_id) return { error: 'not_your_rule' };
  if (isTombstone_(rec)) {
    if (!existing) return { error: 'rule_not_found' };
    return { record: Object.assign({}, existing, { del: 'TRUE' }) };
  }
  rec.id = id;
  rec.symbol = normalizeSymbol_(rec.symbol);
  rec.type = String(rec.type == null ? '' : rec.type).trim();
  var type = STOCK_RULE_TYPES[rec.type];
  if (!type) return { error: 'invalid_rule', field: 'type' };
  var params = ruleParams_(rec);
  if (!params || !type.valid(params)) return { error: 'invalid_rule', field: 'params' };
  if (rec.type === 'cost_pct' && stockMembers_().indexOf(String(params.owner).trim()) === -1) {
    return { error: 'owner_not_member', owner: params.owner };
  }
  var cooldown = rec.cooldown_days === '' || rec.cooldown_days == null ? 1 : Number(rec.cooldown_days);
  if (!isFinite(cooldown) || cooldown < 1 || Math.round(cooldown) !== cooldown) return { error: 'invalid_rule', field: 'cooldown_days' };
  if (rec.symbol === STOCK_GOLD || !isValidSymbol_(rec.symbol, { trigger: 'write', line_id: caller.line_id })) {
    return { error: 'invalid_symbol', symbol: rec.symbol };
  }
  rec.params = JSON.stringify(params);
  rec.enabled = truthy_(rec.enabled) ? 'TRUE' : '';
  rec.auto_push = truthy_(rec.auto_push) ? 'TRUE' : '';
  rec.cooldown_days = cooldown;
  rec.last_fired_at = existing ? existing.last_fired_at : '';
  rec.line_id = caller.line_id;
  rec.created_at = existing && existing.created_at ? existing.created_at : new Date().toISOString();
  rec.del = '';
  return { record: rec };
}

function pushQuoteText_(symbol, q, reasons) {
  return ['📈 股票提醒：' + symbol + (q && q.name ? ' ' + q.name : '')].concat(reasons)
    .concat(q ? [quoteStamp_(q)] : []).join('\n');
}

/**
 * 自動推播（排程每 5 分鐘）。非交易時段直接結束；沒有 enabled && auto_push 的規則就不打報價。
 * 命中且過了冷卻（cooldown_days）→ 推給規則建立者、寫 last_fired_at。有推播才寫 logs（不然每 5 分鐘一列）。
 * 交易時段的每一次執行都寫一列 performance（trigger=schedule）。
 */
function checkStockRules(nowArg) {
  var started = Date.now();
  var now = nowArg instanceof Date ? nowArg : new Date();
  if (!isTwTradingTime_(now)) return { skipped: 'closed' };
  var read = stockSheetRecords_(STOCK_RULES_SHEET);
  var sheet = read.sheet;
  var candidates = (read.rows || []).map(function (r, i) { return { rule: r, row: i + 2 }; }).filter(function (x) {
    return !isTombstone_(x.rule) && truthy_(x.rule.enabled) && truthy_(x.rule.auto_push);
  });
  if (!candidates.length) {
    recordSchedulePerf_('stockRules', 0, Date.now() - started);
    return { candidates: 0, pushed: 0 };
  }
  var symbols = candidates.map(function (x) { return normalizeSymbol_(x.rule.symbol); });
  var quotes = quote_(symbols, { trigger: 'schedule', now: now }).quotes;
  var needBook = candidates.some(function (x) { return String(x.rule.type).trim() === 'cost_pct'; });
  var holdings = needBook ? (computeHoldings_(withoutTombstones_(stockSheetRecords_(STOCK_TRADES_SHEET).rows)).holdings || []) : [];
  var headers = sheet ? sheetHeaders_(sheet) : [];
  var firedCol = headers.indexOf('last_fired_at') + 1;
  var pushed = 0;
  candidates.forEach(function (x) {
    var rule = x.rule;
    var sym = normalizeSymbol_(rule.symbol);
    var r = evaluateRule_(rule, quotes[sym], holdings);
    if (r.status === 'unknown') { noteUnknownRule_(rule); return; }
    if (r.status !== 'hit') return;
    var last = Date.parse(String(rule.last_fired_at || ''));
    var cooldownMs = (Number(rule.cooldown_days) || 1) * 86400000;
    if (isFinite(last) && now.getTime() - last < cooldownMs) return;
    var to = String(rule.line_id || '').trim();
    if (!to) return;
    var res = linePush_(to, pushQuoteText_(sym, quotes[sym], [r.reason]));
    var ok = !!(res && res.ok);
    if (ok && firedCol) {
      sheet.getRange(x.row, firedCol, 1, 1).setValues([[now.toISOString()]]);
      pushed++;
    }
    logTransaction_(STOCK_PUSH_SOURCE, ok ? '成功' : '失敗', 'rule ' + rule.id + ' ' + sym + ' ' + rule.type,
      ok ? '已推播：' + r.reason : '推播失敗', ok ? '' : String((res && res.reason) || ''), '', to);
  });
  recordSchedulePerf_('stockRules', pushed, Date.now() - started);
  return { candidates: candidates.length, pushed: pushed };
}

/** 自選頁的「推給我」：把這一檔對我命中的原因推給我自己（不提供推到群組：持股資訊私密） */
function stockPushMe_(caller, rawSymbol) {
  if (!canUse_(caller.user, 'feat_stock')) return { error: 'forbidden' };
  var sym = normalizeSymbol_(rawSymbol);
  var rules = withoutTombstones_(stockSheetRecords_(STOCK_RULES_SHEET).rows).filter(function (r) {
    return String(r.line_id).trim() === caller.line_id && normalizeSymbol_(r.symbol) === sym;
  });
  if (!rules.length) return { error: 'no_hit' };
  var q = quote_([sym], { trigger: 'manual', line_id: caller.line_id }).quotes[sym];
  var holdings = computeHoldings_(withoutTombstones_(stockSheetRecords_(STOCK_TRADES_SHEET).rows)).holdings || [];
  var hits = (ruleHits_(rules, q ? (function () { var o = {}; o[sym] = q; return o; })() : {}, holdings)[sym]) || [];
  if (!hits.length) return { error: 'no_hit' };
  var res = linePush_(caller.line_id, pushQuoteText_(sym, q, hits.map(function (h) { return h.reason; })));
  var ok = !!(res && res.ok);
  logTransaction_(STOCK_PUSH_SOURCE, ok ? '成功' : '失敗', '推給我 ' + sym, ok ? '已推播 ' + hits.length + ' 條' : '推播失敗',
    ok ? '' : String((res && res.reason) || ''), '', caller.line_id);
  return ok ? { success: true, pushed: hits.length } : { error: 'push_failed', reason: (res && res.reason) || '' };
}

/* ========================================================================== */
/* T7：盤後收盤價（ADR-015 D-2）                                                */
/*                                                                            */
/* 交易日約 14:30 排程跑一次：證交所 STOCK_DAY_ALL（上市）＋櫃買收盤行情（上櫃）。 */
/* 只寫「自選＋有持股」的代號；日期用資料本身的日期（民國年換西元），所以同一天    */
/* 重跑不會重複寫，14:30 拿到的若還是前一天的資料，也只會補前一天、不會冒充今天。  */
/* ========================================================================== */

/** 民國年日期 1151007 → 2026-10-07 */
function rocDateKey_(raw) {
  var t = String(raw == null ? '' : raw).trim();
  var m = /^(\d{2,3})(\d{2})(\d{2})$/.exec(t);
  if (!m) return '';
  return (Number(m[1]) + 1911) + '-' + m[2] + '-' + m[3];
}

/** 一整包盤後資料 → { 代號: { date, close, prev_close } } */
function parseDayAll_(list, codeField, closeField, changeField) {
  var out = {};
  (Array.isArray(list) ? list : []).forEach(function (it) {
    var code = normalizeSymbol_(it[codeField]);
    var close = Number(String(it[closeField] == null ? '' : it[closeField]).replace(/,/g, ''));
    var date = rocDateKey_(it.Date);
    if (!code || !date || !isFinite(close) || close <= 0) return;
    var change = Number(String(it[changeField] == null ? '' : it[changeField]).replace(/[,+\s]/g, ''));
    out[code] = { date: date, close: close, prev_close: isFinite(change) ? quoteRound_(close - change) : '' };
  });
  return out;
}

function fetchDayAllJson_(url) {
  var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(url + ' HTTP ' + res.getResponseCode());
  var body = probeJson_(res.getContentText());
  if (!Array.isArray(body)) throw new Error(url + ' ' + (probeJsonError_(res.getContentText()) || '回的不是陣列'));
  return body;
}

/** 要收盤價的代號：啟用中的自選＋有持股的（黃金除外） */
function stockTrackedSymbols_() {
  var out = [];
  stockSheetRecords_(STOCK_WATCH_SHEET).rows.filter(function (r) { return truthy_(r.is_active); })
    .forEach(function (r) { var s = normalizeSymbol_(r.symbol); if (out.indexOf(s) === -1) out.push(s); });
  (computeHoldings_(withoutTombstones_(stockSheetRecords_(STOCK_TRADES_SHEET).rows)).holdings || [])
    .forEach(function (h) { if (h.symbol !== STOCK_GOLD && out.indexOf(h.symbol) === -1) out.push(h.symbol); });
  return out;
}

function fetchStockDaily() {
  var started = Date.now();
  var read = stockSheetRecords_(STOCK_DAILY_SHEET);
  if (read.error) {
    logCleanup_('盤後收盤價', '找不到 ' + STOCK_DAILY_SHEET + '，沒有寫', '請管理者傳「初始化」');
    recordSchedulePerf_('stockDaily', 0, Date.now() - started);
    return { written: 0, reason: 'sheet_missing' };
  }
  var symbols = stockTrackedSymbols_();
  if (!symbols.length) {
    recordSchedulePerf_('stockDaily', 0, Date.now() - started);
    return { written: 0, reason: 'no_symbols' };
  }
  var found = {}, errors = [];
  try {
    var twse = parseDayAll_(fetchDayAllJson_(TWSE_DAY_ALL_URL), 'Code', 'ClosingPrice', 'Change');
    symbols.forEach(function (s) { if (twse[s]) found[s] = Object.assign({ source: 'twse' }, twse[s]); });
  } catch (err) { errors.push(String(err && err.message || err)); }
  var otc = symbols.filter(function (s) { return !found[s]; });
  if (otc.length) {
    try {
      var tpex = parseDayAll_(fetchDayAllJson_(TPEX_DAILY_URL), 'SecuritiesCompanyCode', 'Close', 'Change');
      otc.forEach(function (s) { if (tpex[s]) found[s] = Object.assign({ source: 'tpex' }, tpex[s]); });
    } catch (err) { errors.push(String(err && err.message || err)); }
  }

  var have = {};
  read.rows.forEach(function (r) { have[keyValue_(r.date) + '|' + normalizeSymbol_(r.symbol)] = true; });
  var headers = sheetHeaders_(read.sheet);
  var rows = [];
  Object.keys(found).forEach(function (s) {
    var f = found[s];
    if (have[f.date + '|' + s]) return;
    var rec = { date: f.date, symbol: s, close: f.close, prev_close: f.prev_close, source: f.source };
    rows.push(headers.map(function (h) { return rec[h] === undefined ? '' : rec[h]; }));
  });
  if (rows.length) {
    keepSymbolsText_(read.sheet);
    read.sheet.getRange(read.sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  }
  var missing = symbols.filter(function (s) { return !found[s]; });
  if (!rows.length || missing.length || errors.length) {
    var dates = Object.keys(found).map(function (s) { return found[s].date; }).filter(function (d, i, a) { return a.indexOf(d) === i; });
    logCleanup_('盤後收盤價',
      rows.length ? '寫入 ' + rows.length + ' 檔，但有缺' : '沒有新的收盤價（假日或資料還沒更新）',
      (dates.length ? '資料日期 ' + dates.join('、') + '｜' : '') + (missing.length ? '找不到：' + missing.join('、') + '｜' : '') + errors.join('；'));
  }
  recordSchedulePerf_('stockDaily', rows.length, Date.now() - started);
  return { written: rows.length, missing: missing, errors: errors };
}

/** 兩個排程。先刪同名的再建，重跑不累積（比照 installAdr009Triggers） */
function installStockTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === STOCK_RULES_FUNCTION || fn === STOCK_DAILY_FUNCTION) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(STOCK_RULES_FUNCTION).timeBased().everyMinutes(STOCK_RULES_MINUTES).create();
  ScriptApp.newTrigger(STOCK_DAILY_FUNCTION).timeBased().atHour(STOCK_DAILY_HOUR).nearMinute(STOCK_DAILY_MINUTE).everyDays(1).create();
}
