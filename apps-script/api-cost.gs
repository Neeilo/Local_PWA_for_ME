/* ========================================================================== */
/* API 成本會計室（ADR-022 PR-A）：唯一出口 callApi_ × 流水帳 × 每日彙總          */
/* ========================================================================== */

/*
 * 為什麼要唯一出口：外部 API 散在 7 個檔案、17 個地方（10/20 盤點）。靠記性在每個地方加記帳，
 * 下一個新 API 一定會漏。所以 **整份原始碼只有 callApi_／callApiAll_ 可以呼叫 UrlFetchApp**，
 * PR 檢查（scripts/check-api-exit.mjs）在別的地方看到就紅燈（D-10）。
 *
 * 記帳兩種粒度（D-6）：
 *  - 付費型（AI 三家）：每一次成功回應記一列 api_usage——model、token 數、**當下的單價**、費用。
 *    單價寫進那一列，之後價目表改價只影響新呼叫，舊帳永遠不變（D-8）。查不到單價 → tokens 照記、
 *    cost_usd 空、priced=N（PR-B 補價後只回填這種列）
 *  - 計次型（其餘）：只在 CacheService 依「台北小時」累加次數，排程總管收尾（flushApiUsage）
 *    把過完的小時搬進指令碼屬性的當日小計，跨日後寫一列 api_usage_daily
 *
 * 記帳**絕不影響主流程**：記帳的任何錯誤都吞掉（console 留底），呼叫的回應／例外原樣交回呼叫者。
 * 寫 Sheet 只有 flushApiUsage 一個人（比照 performance 的單一寫入者），呼叫當下只碰快取與排隊鍵。
 */

var API_REGISTRY_HEADERS = ['api_id', 'model', 'price_key', 'billing_mode', 'input_per_token', 'output_per_token',
  'cache_read_per_token', 'cache_write_per_token', 'unit_price', 'quota', 'quota_period', 'quota_unit', 'effective_from',
  'source_url', 'checked_at', 'active'];
var API_USAGE_HEADERS = ['ts', 'request_id', 'api_id', 'model', 'feature', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'units', 'unit_price_in', 'unit_price_out', 'unit_price_other', 'cost_usd', 'priced'];
// rate_limited：被擋（HTTP 429）的次數。Fugle 的額度是「每分鐘 60 次」的速率、不是每日總量，pct 算不出來，看這欄
var API_DAILY_HEADERS = ['date', 'api_id', 'calls', 'rate_limited', 'quota', 'quota_period', 'used_in_period', 'pct'];
var API_MONTHLY_HEADERS = ['month', 'api_id', 'est_cost_usd', 'actual_amount', 'actual_currency', 'note'];

var API_QUEUE_PREFIX = 'apiq_';          // 指令碼屬性：付費型一列一個鍵，等 flush 寫進 api_usage
var API_DAY_PREFIX = 'apid_';            // 指令碼屬性：apid_YYYY-MM-DD＝當天已搬進來的次數小計
var API_DRAINED_KEY = 'apid_drained';    // 指令碼屬性：已經搬到哪一個小時（YYYY-MM-DDTHH）
var API_COUNT_PREFIX = 'apic_';          // 快取：apic_<小時>_<api_id>＝那一小時的呼叫次數
var API_LIMITED_PREFIX = 'apir_';        // 快取：apir_<小時>_<api_id>＝那一小時被擋（HTTP 429）的次數
var API_COUNT_TTL = 21600;               // 快取上限 6 小時；flush 每 10 分鐘一次，來得及搬
var API_PRICE_CACHE_KEY = 'api_prices';
var API_PRICE_TTL = 600;
var API_FLUSH_MINUTES = 10;
var API_LOCK_MS = 10000;
var API_LOG_SOURCE = '用量';
var API_LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * 程式裡用到的 api_id（callApi_ 的第一個參數只能是這些，測試守門）。
 * per_token：AI，逐筆記費用；其他：只計次（每日一列）。gas_urlfetch 不是真的 API，是「所有呼叫」的總數
 * （GAS 每天 UrlFetch 有上限），每次 callApi_ 都會順便算一次。
 * 寫成函式：GAS 各檔載入順序不保證，頂層常數別的檔案先跑時可能還沒定義
 */
function apiCatalog_() {
  return {
    gemini: { label: 'Gemini', billing: 'per_token' },
    openai: { label: 'OpenAI', billing: 'per_token' },
    claude: { label: 'Claude', billing: 'per_token' },
    apify: { label: 'Apify', billing: 'actual' },
    line_push: { label: 'LINE 推播', billing: 'free_quota' },
    line_reply: { label: 'LINE 回覆', billing: 'count' },
    line_api: { label: 'LINE 查詢', billing: 'count' },
    fugle: { label: 'Fugle 行情', billing: 'free_quota' },
    twse: { label: '證交所', billing: 'count' },
    tpex: { label: '櫃買中心', billing: 'count' },
    cwa: { label: '氣象署', billing: 'free_quota' },
    jina: { label: 'Jina Reader', billing: 'free_quota' },
    web: { label: '網頁／圖片下載', billing: 'count' },
    gas_urlfetch: { label: 'GAS UrlFetch（全部呼叫）', billing: 'free_quota' }
  };
}

/* -------------------------------------------------------------------------- */
/* 唯一出口                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 取代 UrlFetchApp.fetch(url, options)：多一個 apiId 在前、meta（{ feature, model }）在後。
 * 回傳與例外都跟 UrlFetchApp.fetch 一樣，呼叫端其餘程式不用改。
 */
function callApi_(apiId, url, options, meta) {
  var res = null;
  try {
    res = UrlFetchApp.fetch(url, options || {});
    return res;
  } finally {
    apiAccount_(apiId, res ? [res] : [null], meta);
  }
}

/** 取代 UrlFetchApp.fetchAll(requests)：每個 request 自帶 url（跟 fetchAll 一樣）。一個請求算一次 */
function callApiAll_(apiId, requests, meta) {
  var list = null;
  try {
    list = UrlFetchApp.fetchAll(requests);
    return list;
  } finally {
    apiAccount_(apiId, list || requests.map(function () { return null; }), meta);
  }
}

/**
 * 記帳本體。responses：每次請求一個（丟例外的請求是 null——一樣算一次，配額照扣）。
 * 只碰快取與排隊鍵，不碰 Sheet。任何錯誤都吞掉：帳記不到不可以讓 LINE 回不了話
 */
function apiAccount_(apiId, responses, meta) {
  try {
    var now = apiNow_();
    var n = responses.length;
    var limited = responses.filter(function (r) { return r && apiStatus_(r) === 429; }).length;
    apiCount_(apiId, n, limited, now);
    if ((apiCatalog_()[apiId] || {}).billing === 'per_token') {
      responses.forEach(function (r) {
        var code = r ? apiStatus_(r) : 0;
        if (code >= 200 && code < 300) apiQueueUsage_(apiTokenRow_(apiId, r, meta || {}, now));
      });
    }
  } catch (err) {
    console.log('API 記帳失敗（' + apiId + '，主流程不受影響）：' + (err && err.stack || err));
  }
}

/** 現在時間。獨立成函式，測試才能演「過了一小時」「隔天」 */
function apiNow_() {
  return new Date();
}

function apiStatus_(res) {
  try { return Number(res.getResponseCode()) || 0; } catch (err) { return 0; }
}

/* -------------------------------------------------------------------------- */
/* 計次（快取，依台北小時分桶）                                                   */
/* -------------------------------------------------------------------------- */

/** 台北的「YYYY-MM-DDTHH」。分桶用：只搬已經過完的小時，正在累加的桶不碰，沒有讀寫互搶 */
function apiHourKey_(now) {
  return taipeiParts_(now).t.toISOString().slice(0, 13);
}

/**
 * 自己＋gas_urlfetch 各加 n。讀＋寫不是原子的，同一瞬間兩個呼叫可能少算一次——
 * ADR-022 Assumption 接受（計次只用來看額度，不是帳單）
 */
function apiCount_(apiId, n, limited, now) {
  var cache = CacheService.getScriptCache();
  var hour = apiHourKey_(now);
  var ids = apiId === 'gas_urlfetch' ? [apiId] : [apiId, 'gas_urlfetch'];
  var keys = ids.map(function (id) { return API_COUNT_PREFIX + hour + '_' + id; });
  if (limited) keys.push(API_LIMITED_PREFIX + hour + '_' + apiId);
  var have = cache.getAll(keys) || {};
  var out = {};
  ids.forEach(function (id, i) { out[keys[i]] = String((Number(have[keys[i]]) || 0) + n); });
  if (limited) out[keys[keys.length - 1]] = String((Number(have[keys[keys.length - 1]]) || 0) + limited);
  cache.putAll(out, API_COUNT_TTL);
}

/* -------------------------------------------------------------------------- */
/* 付費型：token 解析＋當下單價                                                  */
/* -------------------------------------------------------------------------- */

function apiNum_(v) {
  var x = Number(v);
  return isFinite(x) && x > 0 ? x : 0;
}

/**
 * 三家的 token 欄位不一樣，換成同一套：input＝**沒有吃到快取**的輸入、output（含思考）、
 * cacheRead、cacheWrite。OpenAI 的 prompt_tokens、Gemini 的 promptTokenCount 都已經含快取那段，要扣掉；
 * Claude 的 input_tokens 本來就不含。回應不是 JSON 或沒有 usage → 全部 0（照樣記一列，看得出有呼叫）
 */
function apiTokens_(apiId, res) {
  var body = {};
  try { body = JSON.parse(res.getContentText()) || {}; } catch (err) { body = {}; }
  var u;
  if (apiId === 'claude') {
    u = body.usage || {};
    return { input: apiNum_(u.input_tokens), output: apiNum_(u.output_tokens),
             cacheRead: apiNum_(u.cache_read_input_tokens), cacheWrite: apiNum_(u.cache_creation_input_tokens) };
  }
  if (apiId === 'openai') {
    u = body.usage || {};
    var cached = apiNum_((u.prompt_tokens_details || {}).cached_tokens);
    return { input: Math.max(0, apiNum_(u.prompt_tokens) - cached), output: apiNum_(u.completion_tokens),
             cacheRead: cached, cacheWrite: 0 };
  }
  u = body.usageMetadata || {};                     // gemini
  var c = apiNum_(u.cachedContentTokenCount);
  return { input: Math.max(0, apiNum_(u.promptTokenCount) - c),
           output: apiNum_(u.candidatesTokenCount) + apiNum_(u.thoughtsTokenCount), cacheRead: c, cacheWrite: 0 };
}

function apiRequestId_(now) {
  return now.getTime() + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

/** 一列 api_usage。單價寫進這一列（D-8）；查不到單價 → cost_usd 空、priced=N */
function apiTokenRow_(apiId, res, meta, now) {
  var t = apiTokens_(apiId, res);
  var model = String(meta.model || '');
  var p = apiPrice_(apiId, model, now);
  var row = { ts: now.toISOString(), request_id: meta.request_id || apiRequestId_(now), api_id: apiId, model: model,
    feature: String(meta.feature || ''), input_tokens: t.input, output_tokens: t.output,
    cache_read_tokens: t.cacheRead, cache_write_tokens: t.cacheWrite, units: '',
    unit_price_in: '', unit_price_out: '', unit_price_other: '', cost_usd: '', priced: 'N' };
  if (!p) return row;
  row.unit_price_in = p.input;
  row.unit_price_out = p.output;
  row.unit_price_other = JSON.stringify({ cache_read: p.cacheRead, cache_write: p.cacheWrite });
  row.cost_usd = apiCost_(t, p);
  row.priced = 'Y';
  return row;
}

/** 美元，四捨五入到 1e-8（單價是「每 token」，小數很長） */
function apiCost_(t, p) {
  var usd = t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite;
  return Math.round(usd * 1e8) / 1e8;
}

/**
 * 這個 model 現在的單價 → { input, output, cacheRead, cacheWrite }（每 token，USD）；沒有就 null。
 * 規則：同 api_id＋model、active、per_token、輸入輸出單價都有填、effective_from ≤ 台北今天（空白＝一直有效），
 * 取 effective_from 最新的；同一天的取表上較後面那列（改價＝新增一列，D-8）。
 * 快取單價沒填 → 用輸入單價（三家快取讀都比輸入便宜，最多高估，不會少算）
 */
function apiPrice_(apiId, model, now) {
  var today = taipeiDateKey_(now);
  var best = null;
  apiRegistryRows_().forEach(function (r, i) {
    if (r.api_id !== apiId || r.model !== model || r.billing_mode !== 'per_token' || !truthy_(r.active)) return;
    var inP = Number(r.input_per_token), outP = Number(r.output_per_token);
    if (r.input_per_token === '' || r.output_per_token === '' || !isFinite(inP) || !isFinite(outP)) return;
    var from = String(r.effective_from || '');
    if (from && from > today) return;
    if (best && from < best.from) return;
    var cr = r.cache_read_per_token === '' ? inP : Number(r.cache_read_per_token);
    var cw = r.cache_write_per_token === '' ? inP : Number(r.cache_write_per_token);
    best = { from: from, input: inP, output: outP, cacheRead: isFinite(cr) ? cr : inP, cacheWrite: isFinite(cw) ? cw : inP };
  });
  if (!best) return null;
  return { input: best.input, output: best.output, cacheRead: best.cacheRead, cacheWrite: best.cacheWrite };
}

/**
 * 價目表（快取 10 分鐘）。每次 AI 呼叫都要查價，不能每次開表。
 * 日期欄 Sheet 可能自動轉成 Date，一律換成 YYYY-MM-DD 字串
 */
function apiRegistryRows_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (err) { cache = null; }
  if (cache) {
    var hit = cache.get(API_PRICE_CACHE_KEY);
    if (hit) { try { return JSON.parse(hit); } catch (err) { /* 壞掉就重讀 */ } }
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(API_REGISTRY_SHEET);
  var rows = [];
  if (sheet && sheet.getLastRow() >= 2) {
    var headers = sheetHeaders_(sheet);
    rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().map(function (v) {
      var o = {};
      headers.forEach(function (h, j) {
        var x = v[j];
        o[h] = x instanceof Date ? taipeiDateKey_(x) : (x === null || x === undefined ? '' : (typeof x === 'number' ? x : String(x).trim()));
      });
      return o;
    });
  }
  if (cache) { try { cache.put(API_PRICE_CACHE_KEY, JSON.stringify(rows), API_PRICE_TTL); } catch (err) { /* 太大就不快取 */ } }
  return rows;
}

/** 改了價目表（PR-B 確認寫入、初始化補列）後清快取，下一次呼叫就用新價 */
function apiClearPriceCache_() {
  try { CacheService.getScriptCache().remove(API_PRICE_CACHE_KEY); } catch (err) { /* 沒快取可清 */ }
}

/** 一列一個鍵（比照 perfq_）：並行不互蓋。放不進去（屬性容量滿）就丟棄並寫 logs，不可無聲 */
function apiQueueUsage_(row) {
  var key = API_QUEUE_PREFIX + row.ts.replace(/\D/g, '') + '_' + Math.floor(Math.random() * 1e9);
  try {
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(row));
  } catch (err) {
    try { logTransaction_(API_LOG_SOURCE, '失敗', 'apiUsage', '排隊區放不進去，丟棄一筆 ' + row.api_id + ' 用量', String(err), '', ''); }
    catch (e2) { console.log('API 用量丟棄（' + row.api_id + '）：' + err); }
  }
}

/* -------------------------------------------------------------------------- */
/* 排程總管收尾：寫 api_usage、搬計次、跨日寫 api_usage_daily、月結估算           */
/* -------------------------------------------------------------------------- */

/**
 * **整個專案唯一寫 api_* 分頁的地方**（初始化建表除外）。每 10 分鐘一次，拿不到鎖就跳過。
 * 先寫、寫成功才刪鍵——寫失敗一個鍵都不刪，下一輪重寫，不掉也不重複。
 */
function flushApiUsage(now) {
  var started = Date.now();
  now = now && typeof now.getTime === 'function' ? now : apiNow_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(API_LOCK_MS)) return { written: 0, reason: 'busy' };
  var out = { written: 0, drained: 0, closed: [] };
  try {
    var props = PropertiesService.getScriptProperties();
    out.drained = apiDrainCounts_(props, now);
    out.written = apiWriteQueued_(props);
    out.closed = apiCloseDays_(props, now);
  } catch (err) {
    out.error = String(err && err.message || err);
    try { logTransaction_(API_LOG_SOURCE, '失敗', 'apiFlush', 'API 用量落地失敗，留在排隊區下一輪重來', String(err && err.stack || err), '', ''); }
    catch (e2) { console.log('API 用量落地失敗：' + err); }
  } finally {
    lock.releaseLock();
  }
  if (out.written || out.closed.length) recordSchedulePerf_('apiFlush', out.written, Date.now() - started);
  return out;
}

/** 前一個小時（字串運算，不碰時區） */
function apiNextHour_(hourKey, delta) {
  var t = new Date(hourKey + ':00:00Z').getTime() + (delta || 1) * 3600000;
  return new Date(t).toISOString().slice(0, 13);
}

/**
 * 把「已經過完」的小時桶搬進當日小計（屬性）。第一次（沒有搬過的紀錄）往回看 6 小時（快取上限）。
 * 每個桶讀一次就刪，同一個桶不會被算兩次；當日小計寫成功才更新「搬到哪裡」
 */
function apiDrainCounts_(props, now) {
  var cache = CacheService.getScriptCache();
  var current = apiHourKey_(now);
  var floor = apiNextHour_(current, -7);              // 再早的桶快取早就過期了，不用一小時一小時空轉
  var last = props.getProperty(API_DRAINED_KEY) || floor;
  if (last < floor) last = floor;
  var ids = Object.keys(apiCatalog_());
  var moved = 0;
  for (var h = apiNextHour_(last, 1); h < current; h = apiNextHour_(h, 1)) {
    var keys = [];
    ids.forEach(function (id) { keys.push(API_COUNT_PREFIX + h + '_' + id, API_LIMITED_PREFIX + h + '_' + id); });
    var got = cache.getAll(keys) || {};
    var date = h.slice(0, 10);
    var dayKey = API_DAY_PREFIX + date;
    var day = {};
    try { day = JSON.parse(props.getProperty(dayKey) || '{}') || {}; } catch (err) { day = {}; }
    var any = false;
    ids.forEach(function (id) {
      var calls = Number(got[API_COUNT_PREFIX + h + '_' + id]) || 0;
      var lim = Number(got[API_LIMITED_PREFIX + h + '_' + id]) || 0;
      if (!calls && !lim) return;
      any = true;
      var d = day[id] = day[id] || { calls: 0, rate_limited: 0 };
      d.calls += calls;
      d.rate_limited += lim;
      moved += calls;
    });
    if (any) props.setProperty(dayKey, JSON.stringify(day));
    props.setProperty(API_DRAINED_KEY, h);
    cache.removeAll(keys);
  }
  return moved;
}

/** 排隊的付費型列 → api_usage（一次 setValues），依時間排序 */
function apiWriteQueued_(props) {
  var all = props.getProperties();
  var keys = Object.keys(all).filter(function (k) { return k.indexOf(API_QUEUE_PREFIX) === 0; });
  if (!keys.length) return 0;
  var rows = [];
  keys.forEach(function (k) { try { rows.push(JSON.parse(all[k])); } catch (err) { /* 壞掉的鍵照刪 */ } });
  rows.sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });
  if (rows.length) apiAppendRows_(apiEnsureSheet_(API_USAGE_SHEET, API_USAGE_HEADERS), rows);
  keys.forEach(function (k) { props.deleteProperty(k); });
  return rows.length;
}

/**
 * 台北今天以前的當日小計 → api_usage_daily，每個 api 一列（付費型不寫：它們逐筆記在 api_usage）。
 * 寫完更新該月的月結估算，再刪掉小計
 */
function apiCloseDays_(props, now) {
  var today = taipeiDateKey_(now);
  var all = props.getProperties();
  var days = Object.keys(all).filter(function (k) { return k.indexOf(API_DAY_PREFIX) === 0 && k !== API_DRAINED_KEY; })
    .map(function (k) { return k.slice(API_DAY_PREFIX.length); })
    .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today; }).sort();
  if (!days.length) return [];
  var catalog = apiCatalog_();
  var registry = apiRegistryRows_();
  var lineQuota = null, lineQuotaRead = false;
  var sheet = apiEnsureSheet_(API_DAILY_SHEET, API_DAILY_HEADERS);
  days.forEach(function (date) {
    var day = {};
    try { day = JSON.parse(all[API_DAY_PREFIX + date] || '{}') || {}; } catch (err) { day = {}; }
    var rows = Object.keys(day).filter(function (id) { return catalog[id] && catalog[id].billing !== 'per_token'; }).sort()
      .map(function (id) {
        var q = apiQuotaOf_(registry, id, date);
        var used = q.period === 'day' ? day[id].calls : '';
        if (id === 'line_push') {
          // LINE 的額度與本月已用量以 API 即時值為準（初始價目）；一天只問一次
          if (!lineQuotaRead) { lineQuotaRead = true; try { lineQuota = pushQuota_(); } catch (err) { lineQuota = null; } }
          if (lineQuota) { q.quota = lineQuota.limit == null ? '' : lineQuota.limit; used = lineQuota.used == null ? '' : lineQuota.used; }
        }
        var pct = typeof used === 'number' && typeof q.quota === 'number' && q.quota > 0 ? Math.round(used / q.quota * 1000) / 10 : '';
        return { date: date, api_id: id, calls: day[id].calls, rate_limited: day[id].rate_limited,
                 quota: q.quota, quota_period: q.period, used_in_period: used, pct: pct };
      });
    if (rows.length) apiAppendRows_(sheet, rows);
    apiUpdateMonthly_(date.slice(0, 7));
    props.deleteProperty(API_DAY_PREFIX + date);
  });
  return days;
}

/** 額度：該 api 現在有效的那一列（effective_from ≤ 那天，取最新）；quota 空白或非數字 → '' */
function apiQuotaOf_(registry, apiId, date) {
  var best = null;
  registry.forEach(function (r) {
    if (r.api_id !== apiId || !truthy_(r.active)) return;
    var from = String(r.effective_from || '');
    if (from && from > date) return;
    if (best && from < String(best.effective_from || '')) return;
    best = r;
  });
  if (!best) return { quota: '', period: '' };
  var q = Number(best.quota);
  return { quota: best.quota !== '' && isFinite(q) ? q : '', period: String(best.quota_period || '') };
}

/**
 * 月結估算（api_cost_monthly）：AI 各家＝該月 api_usage 的 cost_usd 加總；Apify＝clips_usage 的本月實際值
 * （Apify 自己回報的 monthlyUsageUsd，不估）。只更新 est_cost_usd，actual_amount／actual_currency／note
 * 是 Neil 對帳填的，永遠不動（D-2）
 */
function apiUpdateMonthly_(month) {
  var est = {};
  var usage = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(API_USAGE_SHEET);
  if (usage && usage.getLastRow() >= 2) {
    var h = sheetHeaders_(usage);
    var iTs = h.indexOf('ts'), iApi = h.indexOf('api_id'), iCost = h.indexOf('cost_usd');
    usage.getRange(2, 1, usage.getLastRow() - 1, h.length).getValues().forEach(function (v) {
      var ts = v[iTs] instanceof Date ? taipeiDateKey_(v[iTs]) : taipeiDateKey_(new Date(String(v[iTs])));
      if (ts.slice(0, 7) !== month) return;
      var c = Number(v[iCost]);
      if (v[iCost] === '' || !isFinite(c)) return;
      est[v[iApi]] = Math.round(((est[v[iApi]] || 0) + c) * 1e8) / 1e8;
    });
  }
  var apify = typeof clipsUsage_ === 'function' ? clipsUsage_() : null;
  if (apify && typeof apify.usd === 'number' && apify.at && taipeiDateKey_(new Date(apify.at)).slice(0, 7) === month) est.apify = apify.usd;
  var ids = Object.keys(est);
  if (!ids.length) return;

  var sheet = apiEnsureSheet_(API_MONTHLY_SHEET, API_MONTHLY_HEADERS);
  var headers = sheetHeaders_(sheet);
  var iM = headers.indexOf('month'), iA = headers.indexOf('api_id'), iE = headers.indexOf('est_cost_usd');
  var existing = sheet.getLastRow() >= 2 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : [];
  var fresh = [];
  ids.sort().forEach(function (id) {
    var at = -1;
    existing.forEach(function (v, i) { if (String(v[iM]) === month && String(v[iA]) === id) at = i; });
    if (at === -1) fresh.push({ month: month, api_id: id, est_cost_usd: est[id], actual_amount: '', actual_currency: '', note: '' });
    else sheet.getRange(at + 2, iE + 1, 1, 1).setValues([[est[id]]]);
  });
  if (fresh.length) apiAppendRows_(sheet, fresh);
}

/** 依表頭順序一次寫進去；列數不夠先補（比照 writePerfRows_） */
function apiAppendRows_(sheet, rows) {
  var headers = sheetHeaders_(sheet);
  var matrix = rows.map(function (r) { return headers.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }); });
  var start = sheet.getLastRow() + 1;
  var overflow = start + matrix.length - 1 - sheet.getMaxRows();
  if (overflow > 0) sheet.insertRowsAfter(sheet.getMaxRows(), overflow);
  sheet.getRange(start, 1, matrix.length, headers.length).setValues(matrix);
}

/** 沒有就建（只有表頭）；有就補缺的欄。回 sheet。flush 也會叫：初始化還沒跑時用量不能因此丟掉 */
function apiEnsureSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  else ensureColumnsOnSheet_(sheet, headers);
  return sheet;
}

/* -------------------------------------------------------------------------- */
/* 初始化：四張表＋初始價目                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 初始價目（交棒頁「初始價目」段，2026-10-20 Claude.ai 查證）。AI 只登記 model、不填價：
 * 單價由 PR-B「🔄 重新查價」從 LiteLLM 帶入，之前一律 priced=N。
 * line_push 的額度以 LINE API 即時值為準（不填）；cwa 還沒查到（不填，Neil 之後補）
 */
function apiSeedRows_() {
  var checked = '2026-10-20';
  var rows = [];
  AI_PROVIDER_IDS.forEach(function (id) {
    (AI_MODELS[id] || []).forEach(function (m) {
      rows.push({ api_id: id, model: m.id, price_key: m.id, billing_mode: 'per_token', effective_from: '',
        source_url: API_LITELLM_URL, checked_at: '', active: 'TRUE' });
    });
  });
  var quota = function (api, mode, q, period, unit, url) {
    rows.push({ api_id: api, model: '', price_key: '', billing_mode: mode, quota: q, quota_period: period, quota_unit: unit,
      effective_from: checked, source_url: url, checked_at: checked, active: 'TRUE' });
  };
  quota('apify', 'actual', 5, 'month', 'usd', 'https://apify.com/pricing');
  quota('line_push', 'free_quota', '', 'month', 'message', 'https://developers.line.biz/en/reference/messaging-api/#get-quota');
  quota('fugle', 'free_quota', 60, 'minute', 'call', 'https://developer.fugle.tw/docs/pricing/');
  quota('cwa', 'free_quota', '', '', 'call', 'https://opendata.cwa.gov.tw/devManual/insrtuction');
  quota('gas_urlfetch', 'free_quota', 20000, 'day', 'call', 'https://developers.google.com/apps-script/guides/services/quotas');
  quota('jina', 'free_quota', 10000000, 'once', 'token', 'https://jina.ai/reader');
  return rows;
}

/**
 * 「初始化」的一步：建四張表（缺欄補欄）、價目表補「還沒登記過」的 api_id＋model（已有的一格都不動，
 * 包括 Neil 停用或改過價的）。可重複執行
 */
function installApiCost_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lines = [], changed = false;
  [[API_REGISTRY_SHEET, API_REGISTRY_HEADERS], [API_USAGE_SHEET, API_USAGE_HEADERS],
   [API_DAILY_SHEET, API_DAILY_HEADERS], [API_MONTHLY_SHEET, API_MONTHLY_HEADERS]].forEach(function (spec) {
    var existed = !!ss.getSheetByName(spec[0]) && ss.getSheetByName(spec[0]).getLastRow() > 0;
    var before = existed ? sheetHeaders_(ss.getSheetByName(spec[0])).length : 0;
    var sheet = apiEnsureSheet_(spec[0], spec[1]);
    if (!existed) { changed = true; lines.push('新建 ' + spec[0]); }
    else if (sheetHeaders_(sheet).length > before) { changed = true; lines.push(spec[0] + ' 補上欄位'); }
  });
  var reg = ss.getSheetByName(API_REGISTRY_SHEET);
  var have = {};
  if (reg.getLastRow() >= 2) {
    var h = sheetHeaders_(reg);
    reg.getRange(2, 1, reg.getLastRow() - 1, h.length).getValues().forEach(function (v) {
      have[String(v[h.indexOf('api_id')]) + '|' + String(v[h.indexOf('model')])] = true;
    });
  }
  var add = apiSeedRows_().filter(function (r) { return !have[r.api_id + '|' + r.model]; });
  if (add.length) {
    apiAppendRows_(reg, add);
    apiClearPriceCache_();
    changed = true;
    lines.push('價目表登記 ' + add.length + ' 列（AI 單價等「重新查價」帶入，之前費用記為未定價）');
  }
  return { level: 'ok', changed: changed, text: lines.length ? lines.join('\n　') : '四張表與價目表已齊備' };
}
