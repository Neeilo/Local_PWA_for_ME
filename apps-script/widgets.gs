/**
 * 總覽 Widget 的個人設定與天氣（ADR-021 D-8、D-15｜PR-C）
 *
 * WidgetConfig（widget_config 分頁）：一人一列，line_id 為鍵。存 Widget 順序／隱藏／釘選、Apps 常用／隱藏、天氣地點。
 * 只走 boot（帶自己那一列）與 widgetConfigSet（鍵用驗證出來的 line_id，不信 body）——別人改不到我的。
 * 清單欄位存成逗號分隔、只收認得的值：表在 Sheet 上看得懂，也不會有人夾帶內容進來。
 *
 * 天氣：中央氣象署鄉鎮預報（F-D0047，未來 3 天、逐 3 小時；欄位照官方說明文件）。
 * 授權碼放指令碼屬性 WEATHER_API。排程總管每小時依縣市抓一次（同一縣市只打一次），
 * 摘要存指令碼屬性 weather_cache；Widget 只讀存好的，不在請求裡打氣象署。
 * 換了地點的人當場抓一次那個縣市，不用等下一輪。
 */
var WIDGET_IDS = ['tasks', 'finance', 'mail', 'stocks', 'reading', 'weather'];
var WIDGET_DEFAULT_ORDER = ['tasks', 'finance', 'mail', 'stocks', 'reading', 'weather'];
/** 開機就帶的（快的）；finance 要讀 expenses、stocks 要打報價，開機後另外要（不拖慢冷開機） */
var WIDGET_FAST = ['tasks', 'reading', 'mail', 'weather'];
var WIDGET_CONFIG_HEADERS = ['line_id', 'widget_order', 'widget_hidden', 'widget_pinned', 'apps_pinned', 'apps_hidden',
  'weather_county', 'weather_district', 'updated_at'];

/** 3 天預報的資料集代碼（F-D0047-xxx），依官方清單；1 週預報是下一個號碼，用不到 */
var WEATHER_DATASETS = {
  '宜蘭縣': '001', '桃園市': '005', '新竹縣': '009', '苗栗縣': '013', '彰化縣': '017', '南投縣': '021',
  '雲林縣': '025', '嘉義縣': '029', '屏東縣': '033', '臺東縣': '037', '花蓮縣': '041', '澎湖縣': '045',
  '基隆市': '049', '新竹市': '053', '嘉義市': '057', '臺北市': '061', '高雄市': '065', '新北市': '069',
  '臺中市': '073', '臺南市': '077', '連江縣': '081', '金門縣': '085'
};
var WEATHER_DEFAULT = { county: '臺北市', district: '中正區' };
var WEATHER_KEY_PROP = 'WEATHER_API';
var WEATHER_CACHE_KEY = 'weather_cache';
var WEATHER_URL = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-';
var WEATHER_LOG_SOURCE = '天氣';
var WEATHER_UMBRELLA_POP = 50;
var WEATHER_DISTRICT_RE = /^[㐀-鿿]{1,10}$/;

/* ---------- WidgetConfig ---------- */

function widgetListOf_(v, allowed) {
  var out = [];
  String(v == null ? '' : v).split(',').forEach(function (x) {
    var s = x.trim();
    if (allowed.indexOf(s) !== -1 && out.indexOf(s) === -1) out.push(s);
  });
  return out;
}

function widgetModuleIds_() {
  return MODULE_DEFAULTS.map(function (m) { return m.module_id; });
}

/** 一列 → 設定物件。沒存過、欄位空白都補預設；順序裡漏掉的 Widget 依預設順序接在後面 */
function widgetConfigFromRow_(row) {
  var r = row || {};
  var order = widgetListOf_(r.widget_order, WIDGET_IDS);
  WIDGET_DEFAULT_ORDER.forEach(function (id) { if (order.indexOf(id) === -1) order.push(id); });
  var county = String(r.weather_county == null ? '' : r.weather_county).trim();
  var district = String(r.weather_district == null ? '' : r.weather_district).trim();
  var validLoc = !!WEATHER_DATASETS[county] && WEATHER_DISTRICT_RE.test(district);
  return {
    order: order,
    hidden: widgetListOf_(r.widget_hidden, WIDGET_IDS),
    pinned: widgetListOf_(r.widget_pinned, WIDGET_IDS),
    apps_pinned: widgetListOf_(r.apps_pinned, widgetModuleIds_()),
    apps_hidden: widgetListOf_(r.apps_hidden, widgetModuleIds_()),
    weather_county: validLoc ? county : WEATHER_DEFAULT.county,
    weather_district: validLoc ? district : WEATHER_DEFAULT.district
  };
}

function widgetConfigOf_(ss, lineId) {
  var read = sheetRecords_(ss, WIDGET_CONFIG_SHEET, {});
  if (read.error) return widgetConfigFromRow_(null);
  var id = keyValue_(lineId);
  return widgetConfigFromRow_(read.rows.filter(function (r) { return keyValue_(r.line_id) === id; })[0]);
}

function ensureWidgetConfigSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WIDGET_CONFIG_SHEET);
  var created = false;
  if (!sheet) { sheet = ss.insertSheet(WIDGET_CONFIG_SHEET); created = true; }
  if (sheet.getLastRow() === 0) sheet.appendRow(WIDGET_CONFIG_HEADERS);
  ensureColumnsOnSheet_(sheet, WIDGET_CONFIG_HEADERS);
  return { sheet: sheet, created: created };
}

/**
 * action=widgetConfigSet { config }。只改自己那一列（caller.line_id）；只收認得的值。
 * 地點不在清單（縣市）或不像鄉鎮名 → invalid_location，什麼都不寫。換了地點就當場抓一次天氣
 */
function widgetConfigSet_(caller, cfg) {
  var c = cfg && typeof cfg === 'object' ? cfg : {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cur = widgetConfigOf_(ss, caller.line_id);
  var join = function (list) { return Array.isArray(list) ? list.join(',') : null; };
  var next = {
    widget_order: join(c.order), widget_hidden: join(c.hidden), widget_pinned: join(c.pinned),
    apps_pinned: join(c.apps_pinned), apps_hidden: join(c.apps_hidden)
  };
  var locChanged = false;
  if (c.weather_county !== undefined || c.weather_district !== undefined) {
    var county = String(c.weather_county == null ? cur.weather_county : c.weather_county).trim();
    var district = String(c.weather_district == null ? cur.weather_district : c.weather_district).trim();
    if (!WEATHER_DATASETS[county] || !WEATHER_DISTRICT_RE.test(district)) return { error: 'invalid_location' };
    locChanged = county !== cur.weather_county || district !== cur.weather_district;
    next.weather_county = county;
    next.weather_district = district;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(UPSERT_LOCK_MS)) return { error: 'busy' };
  try {
    var sheet = ensureWidgetConfigSheet_().sheet;
    var headers = sheetHeaders_(sheet);
    var rows = findRowsByKey_(sheet, [headers.indexOf('line_id') + 1], keyValue_(caller.line_id));
    var rec = {};
    if (rows.length) {
      var line = sheet.getRange(rows[0], 1, 1, headers.length).getValues()[0];
      headers.forEach(function (h, i) { rec[h] = line[i]; });
    }
    // 清單先過一次白名單再存（不認得的直接丟掉，不是整筆拒絕）
    var clean = widgetConfigFromRow_(Object.assign({}, rec, Object.keys(next).reduce(function (o, k) {
      if (next[k] !== null && next[k] !== undefined) o[k] = next[k];
      return o;
    }, {})));
    rec.line_id = keyValue_(caller.line_id);
    rec.widget_order = clean.order.join(',');
    rec.widget_hidden = clean.hidden.join(',');
    rec.widget_pinned = clean.pinned.join(',');
    rec.apps_pinned = clean.apps_pinned.join(',');
    rec.apps_hidden = clean.apps_hidden.join(',');
    rec.weather_county = clean.weather_county;
    rec.weather_district = clean.weather_district;
    rec.updated_at = new Date().toISOString();
    var values = [headers.map(function (h) { return rec[h] == null ? '' : rec[h]; })];
    if (rows.length) sheet.getRange(rows[0], 1, 1, headers.length).setValues(values);
    else sheet.appendRow(values[0]);
  } finally {
    lock.releaseLock();
  }
  if (locChanged) {
    try { runWeatherJob_(new Date(), { county: next.weather_county, district: next.weather_district }); }
    catch (err) { console.log('換地點當場抓天氣失敗（下一輪排程會再抓）：' + err); }
  }
  return { success: true, config: widgetConfigOf_(ss, caller.line_id) };
}

/* ---------- 天氣 ---------- */

function weatherKey_(county, district) { return county + '|' + district; }

function weatherCache_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(WEATHER_CACHE_KEY) || '{}') || {}; }
  catch (err) { return {}; }
}

/** Widget：這個人地點的那一份。還沒抓過＝pending（前端講「下一輪更新」），抓失敗＝error（那一格連不上） */
function weatherWidget_(cfg) {
  var hit = weatherCache_()[weatherKey_(cfg.weather_county, cfg.weather_district)];
  if (!hit) return { pending: true, county: cfg.weather_county, district: cfg.weather_district };
  return Object.assign({ county: cfg.weather_county }, hit);
}

/** 要抓哪些地點：每個人設定的（不合法的當預設）＋預設地點 */
function weatherWanted_() {
  var out = {};
  out[weatherKey_(WEATHER_DEFAULT.county, WEATHER_DEFAULT.district)] = WEATHER_DEFAULT;
  var read = sheetRecords_(SpreadsheetApp.getActiveSpreadsheet(), WIDGET_CONFIG_SHEET, {});
  if (!read.error) read.rows.forEach(function (r) {
    var c = widgetConfigFromRow_(r);
    out[weatherKey_(c.weather_county, c.weather_district)] = { county: c.weather_county, district: c.weather_district };
  });
  return Object.keys(out).map(function (k) { return out[k]; });
}

function weatherFetchCounty_(county, key) {
  var url = WEATHER_URL + WEATHER_DATASETS[county] + '?Authorization=' + encodeURIComponent(key) + '&format=JSON';
  var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('HTTP ' + code);
  return JSON.parse(res.getContentText());
}

/**
 * 排程（每小時）：依縣市抓、整理成摘要存起來。only＝只抓這一個地點（換地點時當場抓，結果併進既有的）。
 * 一個縣市失敗：那個縣市的地點記 error、寫 logs，其他照常。沒設授權碼：寫 logs、不打網路
 */
function runWeatherJob_(now, only) {
  var key = String(PropertiesService.getScriptProperties().getProperty(WEATHER_KEY_PROP) || '').trim();
  if (!key) {
    try { logTransaction_(WEATHER_LOG_SOURCE, '失敗', '天氣排程', '沒設授權碼，沒有抓', '專案設定 → 指令碼屬性 → WEATHER_API', '', ''); } catch (err) {}
    return { skipped: 'no_key' };
  }
  var nowMs = (now || new Date()).getTime();
  var wanted = only ? [only] : weatherWanted_();
  var byCounty = {};
  wanted.forEach(function (w) { (byCounty[w.county] = byCounty[w.county] || []).push(w.district); });
  var cache = only ? weatherCache_() : {};
  var failed = 0;
  Object.keys(byCounty).forEach(function (county) {
    var json = null;
    try {
      json = weatherFetchCounty_(county, key);
    } catch (err) {
      failed++;
      // GAS 的網路例外訊息可能帶整串網址（含 ?Authorization=授權碼）：寫進 logs 前把授權碼遮掉
      var msg = String(err && err.message || err).split(key).join('***');
      try { logTransaction_(WEATHER_LOG_SOURCE, '失敗', '抓 ' + county, '氣象署讀不到，這一輪沒有更新', msg, '', ''); } catch (e2) {}
    }
    byCounty[county].forEach(function (district) {
      cache[weatherKey_(county, district)] = json
        ? weatherSummaryOf_(json, district, nowMs)
        : { error: 'fetch_failed', district: district, at: new Date(nowMs).toISOString() };
    });
  });
  PropertiesService.getScriptProperties().setProperty(WEATHER_CACHE_KEY, JSON.stringify(cache));
  return { counties: Object.keys(byCounty).length, failed: failed };
}

/** 大小寫兩種都認（官方 2024 年改過一次欄位名的大小寫） */
function weatherPick_(o, name) {
  if (!o) return undefined;
  return o[name] !== undefined ? o[name] : o[name.charAt(0).toLowerCase() + name.slice(1)];
}

/**
 * 一個鄉鎮的摘要。照官方文件：Locations → Location（LocationName）→ WeatherElement → Time（DataTime 或 StartTime／EndTime）→ ElementValue。
 * 不靠中文的 ElementName 認因子，靠值的欄位名（Temperature／ProbabilityOfPrecipitation／Weather）——中文名改字也不會壞。
 * 今天還有時段就報今天剩下的（高低溫、最高降雨機率、現在或下一段的天氣），沒有了（深夜）就報明天
 */
function weatherSummaryOf_(json, district, nowMs) {
  var records = weatherPick_(json, 'records') || {};
  var locs = [];
  (weatherPick_(records, 'Locations') || []).forEach(function (l) { locs = locs.concat(weatherPick_(l, 'Location') || []); });
  var loc = locs.filter(function (l) { return String(weatherPick_(l, 'LocationName') || '').trim() === district; })[0];
  if (!loc) return { error: 'district_not_found', district: district, at: new Date(nowMs).toISOString() };
  var elements = weatherPick_(loc, 'WeatherElement') || [];
  var series = function (field) {
    var el = elements.filter(function (e) {
      var t = (weatherPick_(e, 'Time') || [])[0];
      var v = t ? (weatherPick_(t, 'ElementValue') || [])[0] : null;
      return v && v[field] !== undefined;
    })[0];
    return (el ? weatherPick_(el, 'Time') || [] : []).map(function (t) {
      var start = String(weatherPick_(t, 'DataTime') || weatherPick_(t, 'StartTime') || '');
      var end = weatherPick_(t, 'EndTime');
      return { day: start.slice(0, 10), start: Date.parse(start), end: end ? Date.parse(end) : NaN,
               v: ((weatherPick_(t, 'ElementValue') || [])[0] || {})[field] };
    });
  };
  var T = series('Temperature'), P = series('ProbabilityOfPrecipitation'), W = series('Weather');
  var today = taipeiDateKey_(new Date(nowMs));
  var tomorrow = taipeiDateKey_(new Date(nowMs + 86400000));
  var upcoming = function (x) { return isNaN(x.end) ? x.start >= nowMs - 3600000 : x.end > nowMs; };
  var day = T.some(function (x) { return x.day === today && upcoming(x); }) ? today : tomorrow;
  var inDay = function (list) { return list.filter(function (x) { return x.day === day && (day !== today || upcoming(x)); }); };
  var nums = function (list) { return inDay(list).map(function (x) { return Number(x.v); }).filter(function (n) { return isFinite(n); }); };
  var temps = nums(T), pops = nums(P);
  var wx = inDay(W)[0];
  var pop = pops.length ? Math.max.apply(null, pops) : null;
  return {
    district: district,
    period: day === today ? '今天' : '明天',
    wx: wx ? String(wx.v || '') : '',
    max: temps.length ? Math.max.apply(null, temps) : null,
    min: temps.length ? Math.min.apply(null, temps) : null,
    pop: pop,
    umbrella: pop !== null && pop >= WEATHER_UMBRELLA_POP,
    at: new Date(nowMs).toISOString()
  };
}

/** 在編輯器手動執行：抓預設地點一次，看授權碼與格式對不對（不寫快取） */
function probeWeather() {
  var key = String(PropertiesService.getScriptProperties().getProperty(WEATHER_KEY_PROP) || '').trim();
  if (!key) { console.log('❌ 沒設 WEATHER_API'); return null; }
  var json = weatherFetchCounty_(WEATHER_DEFAULT.county, key);
  var s = weatherSummaryOf_(json, WEATHER_DEFAULT.district, Date.now());
  console.log(JSON.stringify(s));
  return s;
}
