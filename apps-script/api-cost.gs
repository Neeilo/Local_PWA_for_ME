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
    litellm: { label: 'LiteLLM 價目（查價）', billing: 'count' },
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
 * **平常唯一寫 api_* 分頁的地方**（例外：初始化建表、管理者確認改價 apiPriceApply_，都拿同一把鎖）。每 10 分鐘一次，拿不到鎖就跳過。
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
    try { apiQuotaAlerts_(props, rows); }                       // PR-C：提醒失敗不擋每日列與月結
    catch (err) { console.log('額度提醒失敗：' + (err && err.stack || err)); }
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

/* -------------------------------------------------------------------------- */
/* 查價（ADR-022 PR-B，D-9）：查只回差異、確認才寫                                 */
/* -------------------------------------------------------------------------- */

/*
 * 各家都沒有查價 API，AI 單價取自 LiteLLM 社群價目 JSON。社群資料可能晚幾天、可能錯，
 * 所以分兩步：apiPriceCheck 只回差異（Sheet 一格都不動），Neil 看過按確認才 apiPriceApply 新增列。
 * 只看價目表裡 active、per_token 的 model（不把整份 JSON 存進 Sheet）。
 */
var API_BIG_CHANGE = 0.5;                                   // 變動超過 50% 標黃
var API_LITELLM_PREFIX = { gemini: ['gemini/'], openai: ['openai/'], claude: ['anthropic/'] };
var API_QUOTA_PERIODS = ['', 'day', 'month', 'minute', 'once'];

/** 管理者＋「💸 成本」模組開著才放行；回 null＝放行，否則回拒絕的回應 */
function apiAdminGate_(caller, action) {
  if (!truthy_((caller.user || {}).is_admin)) return apiForbidden_(caller, action);
  if (!moduleOn_('costs')) return moduleOffDenied_('costs', action, '成本', caller.line_id);
  return null;
}

function apiForbidden_(caller, action) {
  logTransaction_(API_LOG_SOURCE, '失敗', 'PWA ' + action, '只有管理者可以查價、改價', 'code=forbidden', '', caller.line_id);
  return { error: 'forbidden', permanent: true };
}

/** LiteLLM 的 key：先照 price_key，再試各家前綴（Gemini 在 LiteLLM 是 gemini/xxx） */
function apiLitellmLookup_(json, apiId, key) {
  var tries = [key].concat((API_LITELLM_PREFIX[apiId] || []).map(function (p) { return p + key; }));
  for (var i = 0; i < tries.length; i++) {
    var x = json[tries[i]];
    if (x && typeof x.input_cost_per_token === 'number' && typeof x.output_cost_per_token === 'number') {
      return { key: tries[i], price: { input: x.input_cost_per_token, output: x.output_cost_per_token,
        cacheRead: typeof x.cache_read_input_token_cost === 'number' ? x.cache_read_input_token_cost : '',
        cacheWrite: typeof x.cache_creation_input_token_cost === 'number' ? x.cache_creation_input_token_cost : '' } };
    }
  }
  return null;
}

/** 這個 model 目前生效的那一列（原始欄位，快取單價空白就是空白）；沒有回 null */
function apiCurrentRow_(rows, apiId, model, today) {
  var best = null;
  rows.forEach(function (r) {
    if (r.api_id !== apiId || r.model !== model || r.billing_mode !== 'per_token' || !truthy_(r.active)) return;
    if (r.input_per_token === '' || r.output_per_token === '') return;
    var from = String(r.effective_from || '');
    if (from && from > today) return;
    if (best && from < String(best.effective_from || '')) return;
    best = r;
  });
  return best ? { input: Number(best.input_per_token), output: Number(best.output_per_token),
    cacheRead: best.cache_read_per_token === '' ? '' : Number(best.cache_read_per_token),
    cacheWrite: best.cache_write_per_token === '' ? '' : Number(best.cache_write_per_token) } : null;
}

/** 四個單價裡變動最大的比例（舊值 0 或空白的不算比例） */
function apiMaxChange_(a, b) {
  var max = 0;
  ['input', 'output', 'cacheRead', 'cacheWrite'].forEach(function (k) {
    var x = a[k], y = b[k];
    if (x === '' || y === '' || x === y) return;
    max = Math.max(max, x > 0 ? Math.abs(y - x) / x : 1);
  });
  return max;
}

function apiSamePrice_(a, b) {
  return ['input', 'output', 'cacheRead', 'cacheWrite'].every(function (k) {
    return a[k] === b[k] || (a[k] !== '' && b[k] !== '' && Math.abs(a[k] - b[k]) < 1e-15);
  });
}

/**
 * 管理者按「🔄 重新查價」→ 每個 model 一筆：same（沒變）／changed（big＝>50%）／new（第一次有價）／missing（⚠️ 未定價）。
 * 另附額度型的目前值，給畫面手動改。**不寫 Sheet**
 */
function apiPriceCheck_(caller) {
  var gate = apiAdminGate_(caller, 'apiPriceCheck');
  if (gate) return gate;
  var res;
  try { res = callApi_('litellm', API_LITELLM_URL, { method: 'get', muteHttpExceptions: true }, { feature: 'price_check' }); }
  catch (err) { return { error: 'fetch_failed', detail: String(err && err.message || err) }; }
  if (res.getResponseCode() !== 200) return { error: 'fetch_failed', detail: 'HTTP ' + res.getResponseCode() };
  var json;
  try { json = JSON.parse(res.getContentText()); } catch (err) { return { error: 'bad_json' }; }

  apiClearPriceCache_();                                  // 用表上最新的比，不用 10 分鐘前的快取
  var rows = apiRegistryRows_();
  var today = taipeiDateKey_(apiNow_());
  var seen = {}, items = [];
  rows.forEach(function (r) {
    if (r.billing_mode !== 'per_token' || !truthy_(r.active) || !r.model) return;
    var id = r.api_id + '|' + r.model;
    if (seen[id]) return;
    seen[id] = true;
    var old = apiCurrentRow_(rows, r.api_id, r.model, today);
    var found = apiLitellmLookup_(json, r.api_id, String(r.price_key || r.model));
    var it = { api_id: r.api_id, model: r.model, price_key: String(r.price_key || r.model), old: old, checked_at: String(r.checked_at || '') };
    if (!found) it.status = 'missing';
    else {
      it.key = found.key;
      it.new = found.price;
      it.status = !old ? 'new' : apiSamePrice_(old, found.price) ? 'same' : 'changed';
      it.big = it.status === 'changed' && apiMaxChange_(old, found.price) > API_BIG_CHANGE;
    }
    items.push(it);
  });
  var quotas = [], qSeen = {};
  for (var i = rows.length - 1; i >= 0; i--) {
    var q = rows[i];
    if (q.billing_mode === 'per_token' || !truthy_(q.active) || qSeen[q.api_id]) continue;
    qSeen[q.api_id] = true;
    var cur = apiQuotaOf_(rows, q.api_id, today);
    quotas.push({ api_id: q.api_id, quota: cur.quota, quota_period: cur.period, quota_unit: String(q.quota_unit || ''),
      checked_at: String(q.checked_at || '') });
  }
  quotas.sort(function (a, b) { return a.api_id < b.api_id ? -1 : 1; });
  logTransaction_(API_LOG_SOURCE, '成功', 'PWA apiPriceCheck', '查價：' + items.length + ' 個 model',
    items.map(function (x) { return x.model + '=' + x.status; }).join('｜'), '', caller.line_id);
  return { success: true, today: today, source_url: API_LITELLM_URL, items: items, quotas: quotas };
}

function apiPriceNum_(v, optional) {
  if (optional && (v === '' || v == null)) return '';
  var x = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return isFinite(x) && x >= 0 ? x : null;
}

/**
 * 確認寫入：prices（改價／補價，每 token 的 USD）、quotas（額度手動改）各新增一列，effective_from＝台北今天；
 * checked（沒變的）只更新 checked_at。**整批先驗證，有一筆不合理就一列都不寫**。
 * 寫完清單價快取，再把排隊中的用量先落地，回填這次補到價的 priced=N 列（已有費用的列不動）
 */
function apiPriceApply_(caller, body) {
  var gate = apiAdminGate_(caller, 'apiPriceApply');
  if (gate) return gate;
  var catalog = apiCatalog_();
  apiClearPriceCache_();
  var rows = apiRegistryRows_();
  var today = taipeiDateKey_(apiNow_());
  var known = {};
  rows.forEach(function (r) { if (r.billing_mode === 'per_token' && truthy_(r.active)) known[r.api_id + '|' + r.model] = r; });

  var prices = [], quotas = [], checked = [];
  var bad = null;
  (Array.isArray(body.prices) ? body.prices : []).forEach(function (p) {
    var k = String(p && p.api_id) + '|' + String(p && p.model);
    var nums = [apiPriceNum_(p && p.input), apiPriceNum_(p && p.output), apiPriceNum_(p && p.cache_read, true), apiPriceNum_(p && p.cache_write, true)];
    if (!known[k] || nums.indexOf(null) !== -1) { bad = bad || k; return; }
    prices.push({ api_id: known[k].api_id, model: known[k].model, price_key: known[k].price_key || known[k].model, billing_mode: 'per_token',
      input_per_token: nums[0], output_per_token: nums[1], cache_read_per_token: nums[2], cache_write_per_token: nums[3],
      effective_from: today, source_url: p.source === 'manual' ? 'manual' : API_LITELLM_URL, checked_at: today, active: 'TRUE' });
  });
  (Array.isArray(body.quotas) ? body.quotas : []).forEach(function (q) {
    var id = String(q && q.api_id);
    var c = catalog[id];
    var n = apiPriceNum_(q && q.quota, true);
    var period = String((q && q.quota_period) || '');
    if (!c || c.billing === 'per_token' || n === null || API_QUOTA_PERIODS.indexOf(period) === -1) { bad = bad || id; return; }
    quotas.push({ api_id: id, model: '', price_key: '', billing_mode: c.billing === 'count' ? 'free_quota' : c.billing,
      quota: n, quota_period: period, quota_unit: String((q && q.quota_unit) || ''),
      effective_from: today, source_url: 'manual', checked_at: today, active: 'TRUE' });
  });
  (Array.isArray(body.checked) ? body.checked : []).forEach(function (c) {
    var k = String(c && c.api_id) + '|' + String(c && c.model);
    if (!known[k]) { bad = bad || k; return; }
    checked.push(k);
  });
  if (bad) return { error: 'invalid', item: bad };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(API_LOCK_MS)) return { error: 'busy' };
  var backfilled = 0;
  try {
    var sheet = apiEnsureSheet_(API_REGISTRY_SHEET, API_REGISTRY_HEADERS);
    if (checked.length && sheet.getLastRow() >= 2) {
      var h = sheetHeaders_(sheet);
      var iA = h.indexOf('api_id'), iM = h.indexOf('model'), iC = h.indexOf('checked_at'), iT = h.indexOf('active');
      sheet.getRange(2, 1, sheet.getLastRow() - 1, h.length).getValues().forEach(function (v, i) {
        if (checked.indexOf(String(v[iA]) + '|' + String(v[iM])) !== -1 && truthy_(v[iT])) sheet.getRange(i + 2, iC + 1, 1, 1).setValues([[today]]);
      });
    }
    if (prices.length || quotas.length) apiAppendRows_(sheet, prices.concat(quotas));
    apiClearPriceCache_();
    if (prices.length) {
      apiWriteQueued_(PropertiesService.getScriptProperties());
      backfilled = apiBackfill_(prices);
    }
  } finally {
    lock.releaseLock();
  }
  logTransaction_(API_LOG_SOURCE, '成功', 'PWA apiPriceApply',
    '價目表新增 ' + (prices.length + quotas.length) + ' 列、核價 ' + checked.length + ' 個、回填 ' + backfilled + ' 筆',
    prices.map(function (p) { return p.model + '=' + p.input_per_token + '/' + p.output_per_token + '(' + p.source_url + ')'; })
      .concat(quotas.map(function (q) { return q.api_id + ' 額度=' + q.quota + '/' + q.quota_period; })).join('｜'), '', caller.line_id);
  return { success: true, added: prices.length + quotas.length, checked: checked.length, backfilled: backfilled, today: today };
}

/** 只回填 priced=N（當時查不到價）的列；已有費用的列一格都不動（D-8） */
function apiBackfill_(prices) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(API_USAGE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var by = {};
  prices.forEach(function (p) {
    by[p.api_id + '|' + p.model] = { input: p.input_per_token, output: p.output_per_token,
      cacheRead: p.cache_read_per_token === '' ? p.input_per_token : p.cache_read_per_token,
      cacheWrite: p.cache_write_per_token === '' ? p.input_per_token : p.cache_write_per_token };
  });
  var h = sheetHeaders_(sheet);
  var col = function (n) { return h.indexOf(n); };
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, h.length).getValues();
  var n = 0;
  values.forEach(function (v, i) {
    if (String(v[col('priced')]) !== 'N') return;
    var p = by[String(v[col('api_id')]) + '|' + String(v[col('model')])];
    if (!p) return;
    var t = { input: apiNum_(v[col('input_tokens')]), output: apiNum_(v[col('output_tokens')]),
      cacheRead: apiNum_(v[col('cache_read_tokens')]), cacheWrite: apiNum_(v[col('cache_write_tokens')]) };
    v[col('unit_price_in')] = p.input;
    v[col('unit_price_out')] = p.output;
    v[col('unit_price_other')] = JSON.stringify({ cache_read: p.cacheRead, cache_write: p.cacheWrite });
    v[col('cost_usd')] = apiCost_(t, p);
    v[col('priced')] = 'Y';
    sheet.getRange(i + 2, 1, 1, h.length).setValues([v]);
    n++;
  });
  return n;
}

/* -------------------------------------------------------------------------- */
/* 用量與成本卡＋額度提醒（ADR-022 PR-C，D-2、D-3、D-5、D-7）                       */
/* -------------------------------------------------------------------------- */

var API_ALERTS_KEY = 'api_alerts';             // 指令碼屬性：用到 100% 的 API（boot 帶給管理者，2.0 紅色警示）
var API_ALERT_STATE_KEY = 'api_alert_state';   // 指令碼屬性：{ api_id: 已推過 80% 的週期 }
var API_ALERT_PCT = 80;
var API_STALE_DAYS = 90;

/** 這一列的額度週期是哪一段：day＝那天、month＝那個月、once＝一次性；速率型（minute）沒有週期，不提醒 */
function apiPeriodKey_(period, date) {
  if (period === 'day') return date;
  if (period === 'month') return date.slice(0, 7);
  if (period === 'once') return 'once';
  return '';
}

/**
 * 每日收尾寫完那天的列之後：跨過 80% 推 LINE 給管理者（同一週期只推一次，週期換了可再推）；
 * 100% 的存進屬性，boot 帶給管理者——LINE 本身的額度用完時推播發不出去，所以要 PWA 備援（D-5）。
 * 每次收尾都重算 100% 清單：下一天沒有用滿就清掉
 */
function apiQuotaAlerts_(props, rows) {
  var state = {};
  try { state = JSON.parse(props.getProperty(API_ALERT_STATE_KEY) || '{}') || {}; } catch (err) { state = {}; }
  var catalog = apiCatalog_();
  var full = [];
  rows.forEach(function (r) {
    if (typeof r.pct !== 'number') return;
    var key = apiPeriodKey_(r.quota_period, r.date);
    if (!key) return;
    var label = (catalog[r.api_id] || {}).label || r.api_id;
    if (r.pct >= 100) full.push({ api_id: r.api_id, label: label, pct: r.pct, date: r.date, period: r.quota_period });
    if (r.pct < API_ALERT_PCT || state[r.api_id] === key) return;
    apiPushAdmins_('⚠️ ' + label + ' 免費額度已用 ' + r.pct + '%（' + r.used_in_period + '／' + r.quota + '，' +
      (r.quota_period === 'day' ? r.date : r.quota_period === 'month' ? r.date.slice(0, 7) + ' 整月' : '一次性額度') + '）' +
      (r.pct >= 100 ? '\n已經用完，App 管理區有紅色警示' : ''));
    state[r.api_id] = key;
  });
  props.setProperty(API_ALERT_STATE_KEY, JSON.stringify(state));
  props.setProperty(API_ALERTS_KEY, JSON.stringify(full));
}

/** 推給每個啟用中的管理者；推不出去寫 logs（不可無聲） */
function apiPushAdmins_(text) {
  var roster = readLineUsers_();
  if (!roster.ok) { logTransaction_(API_LOG_SOURCE, '失敗', 'apiQuotaAlert', '讀不到名單，額度提醒沒推', text, '', ''); return; }
  Object.keys(roster.users).forEach(function (id) {
    var u = roster.users[id];
    if (!truthy_(u.is_active) || !truthy_(u.is_admin)) return;
    var r = linePush_(id, text) || {};
    logTransaction_(API_LOG_SOURCE, r.ok ? '成功' : '失敗', 'apiQuotaAlert', r.ok ? '額度提醒已推' : '額度提醒推不出去（' + r.reason + '）', text, '', id);
  });
}

/** boot 帶給管理者的 100% 清單（讀一個屬性，不讀 Sheet） */
function apiAlerts_() {
  try {
    var v = JSON.parse(PropertiesService.getScriptProperties().getProperty(API_ALERTS_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (err) { return []; }
}

function apiSheetRecords_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var h = sheetHeaders_(sheet);
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, h.length).getValues().map(function (v) {
    var o = {};
    h.forEach(function (k, j) { o[k] = v[j] instanceof Date ? (k === 'ts' ? v[j].toISOString() : taipeiDateKey_(v[j])) : v[j]; });
    return o;
  });
}

function apiRound_(x) { return Math.round(x * 1e6) / 1e6; }

/**
 * 「💸 用量與成本」卡的資料（只有管理者，按需載入，不進冷開機）。金額一律 USD（D-3）：
 * 本月估算總額＝AI 各家 api_usage.cost_usd＋Apify 自己回報的本月實際值；各 API／各功能占比；
 * 額度＝每個 API 最新一天的每日列；未定價清單；核價超過 90 天或從沒核過；月結有填實際金額才算差額（D-2）
 */
function apiCostSummary_(caller) {
  var gate = apiAdminGate_(caller, 'apiCostSummary');
  if (gate) return gate;
  var now = apiNow_();
  var today = taipeiDateKey_(now);
  var month = today.slice(0, 7);
  var byApi = {}, byFeature = {}, unpriced = {};
  apiSheetRecords_(API_USAGE_SHEET).forEach(function (r) {
    if (taipeiDateKey_(new Date(String(r.ts))).slice(0, 7) !== month) return;
    if (String(r.priced) === 'N') {
      var k = r.api_id + '|' + r.model;
      unpriced[k] = unpriced[k] || { api_id: String(r.api_id), model: String(r.model), count: 0 };
      unpriced[k].count++;
      return;
    }
    var c = Number(r.cost_usd);
    if (r.cost_usd === '' || !isFinite(c)) return;
    byApi[r.api_id] = (byApi[r.api_id] || 0) + c;
    var f = String(r.feature || '（未標）');
    byFeature[f] = (byFeature[f] || 0) + c;
  });
  var apify = typeof clipsUsage_ === 'function' ? clipsUsage_() : null;
  if (apify && typeof apify.usd === 'number' && apify.at && taipeiDateKey_(new Date(apify.at)).slice(0, 7) === month) byApi.apify = apify.usd;
  var list = function (map, key) {
    return Object.keys(map).map(function (k) { var o = {}; o[key] = k; o.usd = apiRound_(map[k]); return o; })
      .sort(function (a, b) { return b.usd - a.usd || (a[key] < b[key] ? -1 : 1); });
  };
  var apis = list(byApi, 'api_id');
  var total = apiRound_(apis.reduce(function (s, x) { return s + x.usd; }, 0));

  var latest = {};
  apiSheetRecords_(API_DAILY_SHEET).forEach(function (r) {
    if (!latest[r.api_id] || String(r.date) >= String(latest[r.api_id].date)) latest[r.api_id] = r;
  });
  var quotas = Object.keys(latest).sort().filter(function (id) { return typeof latest[id].pct === 'number' || Number(latest[id].rate_limited) > 0; })
    .map(function (id) {
      var r = latest[id];
      return { api_id: id, date: String(r.date), used: r.used_in_period === '' ? null : Number(r.used_in_period),
        quota: r.quota === '' ? null : Number(r.quota), period: String(r.quota_period || ''), pct: typeof r.pct === 'number' ? r.pct : null,
        rate_limited: Number(r.rate_limited) || 0 };
    });

  var staleBefore = taipeiDateKey_(new Date(now.getTime() - API_STALE_DAYS * 86400000));
  var newest = {};
  apiRegistryRows_().forEach(function (r) {
    if (r.billing_mode !== 'per_token' || !truthy_(r.active) || !r.model) return;
    var k = r.api_id + '|' + r.model;
    var at = String(r.checked_at || '');
    if (!(k in newest) || at > newest[k].checked_at) newest[k] = { api_id: r.api_id, model: r.model, checked_at: at };
  });
  var stale = Object.keys(newest).map(function (k) { return newest[k]; })
    .filter(function (x) { return !x.checked_at || x.checked_at < staleBefore; })
    .sort(function (a, b) { return a.model < b.model ? -1 : 1; });

  var actuals = apiSheetRecords_(API_MONTHLY_SHEET).filter(function (r) {
    return String(r.month) === month && r.actual_amount !== '' && isFinite(Number(r.actual_amount));
  }).map(function (r) {
    var cur = String(r.actual_currency || 'USD').toUpperCase();
    var est = Number(r.est_cost_usd) || 0;
    return { api_id: String(r.api_id), est_usd: est, actual: Number(r.actual_amount), currency: cur,
      diff_usd: cur === 'USD' ? apiRound_(Number(r.actual_amount) - est) : null };
  });

  return { success: true, currency: 'USD', month: month, today: today, total_usd: total, by_api: apis, by_feature: list(byFeature, 'feature'),
    unpriced: Object.keys(unpriced).sort().map(function (k) { return unpriced[k]; }),
    quotas: quotas, stale: stale, actuals: actuals, alerts: apiAlerts_(), labels: (function () {
      var c = apiCatalog_(), o = {};
      Object.keys(c).forEach(function (k) { o[k] = c[k].label; });
      return o;
    })() };
}
