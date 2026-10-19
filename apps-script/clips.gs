/* ========================================================================== */
/* 閱讀收藏搜集器（ADR-020 RD-1）                                               */
/* ========================================================================== */

/*
 * LINE 私訊分享 IG 網址 → webhook 只登記一列 pending、回「收到 ✅」→ 排程總管的 clips 工作
 * 每輪最多收 5 篇：Apify 拿全文＋每一張圖 → 存 Drive（圖片、raw.json、content.md）→ 列寫成 done。
 *
 *  - webhook 不呼叫 Apify、不去重：抓一篇含下載約 23 秒，LINE 的回覆不能等它（B-1）
 *  - 成功＝Apify 回的每一張圖都存進 Drive＋raw.json 存好；少一張就是失敗；沒有 caption 不算失敗（C-2）
 *  - 失敗重試：下一輪 → 30 分鐘後 → 2 小時後；再失敗：有存到部分 → partial，否則 failed。不推播（B-4、C-3）
 *  - 同一擁有者、同一網址：不重抓、合併；原本 failed／partial 的，再分享一次＝重跑（D-4）
 *  - 圖片檔「知道連結的人可檢視」（PWA 直接顯示）；資料夾、raw.json、content.md、video.mp4 維持私人（E-2）
 *  - Reels 也存影片 video.mp4（RD-HF1 修訂 A-3：IG 影片網址帶 oe= 到期參數，過幾天就抓不到）；太大不算失敗
 *
 * APIFY_TOKEN 只從指令碼屬性讀、只放 Authorization header，任何 log、Sheet、Drive 都不寫它。
 * 共用的 Apify 呼叫與欄位解析也給階段 0 探針（lab-clip.gs）用，不複製兩份。
 */
var CLIPS_HEADERS = ['id', 'line_id', 'source_text', 'url', 'shortcode', 'kind', 'status', 'attempts', 'next_try_at', 'error',
  'author', 'posted_at', 'caption', 'media_expected', 'media_saved', 'drive_folder_id', 'image_ids', 'category',
  'collected_at', 'last_collected_at', 'del', 'created_at', 'updated_at', 'video_saved',
  // ADR-021 D-13：閱讀狀態（未讀／已讀兩態；開閱讀頁即已讀＋時間）。加在最右邊，1.0 讀到陌生欄位照常
  'read_status', 'last_read_at'];
var CLIPS_FEATURE = 'feat_clips';
var CLIPS_LOG_SOURCE = '收藏';
var CLIPS_PER_ROUND = 5;
/** 一篇含下載約 23 秒（階段 0 實測）；總管剩下的時間不到這麼多就不開始 */
var CLIPS_MIN_BUDGET_MS = 60000;
var CLIPS_POST_BUDGET_MS = 25000;
/** 第 1／2／3 次失敗後隔多久再試；第 4 次失敗就定案 */
var CLIPS_RETRY_DELAYS_MS = [0, 30 * 60000, 2 * 3600000];
var CLIPS_DRIVE_ROOT = ['Neil OS', '收藏'];
/** 排程裡的 Apify 等待：總管一輪 4 分鐘，不能像探針那樣等 4 分鐘 */
var CLIPS_APIFY_WAIT_SEC = 30;
var CLIPS_APIFY_MAX_POLLS = 2;
/**
 * content.md 開頭的 UTF-8 BOM（RD-HF1 HF-A）。2026-10-16 實查：Drive 裡的檔案位元組本來就是正確的 UTF-8，
 * 是預覽把沒標字元集的 text/markdown 當成 Latin-1 顯示，4 位元組 emoji 變亂碼、結尾少幾個字。BOM 讓檢視器認得是 UTF-8
 */
var CLIP_MD_BOM = '\uFEFF';
/** 補救舊 content.md 做完的記號（指令碼屬性）；有失敗就不記，下次初始化再試 */
var CLIPS_MD_FIX_KEY = 'clips_md_bom';
/**
 * 影片太大：UrlFetchApp 回應上限約 50MB、Drive createFile 也有上限，超過會丟例外。
 * ⚠️ 例外訊息的確切文字未實測，先認這幾個字；認不得就當一般下載失敗（走重試，最後 partial）
 */
var CLIP_VIDEO_TOO_BIG = /too large|exceed|size|limit|過大|上限|大小/i;
var CLIP_VIDEO_TOO_BIG_NOTE = '影片過大未保存';
/** Apify 用量（RD-HF1 HF-C，ADR-020 的備案條件）：每天一次，結果存指令碼屬性給管理員頁看 */
var CLIPS_USAGE_KEY = 'clips_usage';
var CLIPS_USAGE_HOUR = 8;
var CLIPS_USAGE_RED_USD = 3;
var CLIPS_RATE_RED = 0.8;
var CLIPS_RATE_DAYS = 3;

/* -------------------------------------------------------------------------- */
/* 共用：網址、Apify、欄位解析（探針 lab-clip.gs 也用）                             */
/* -------------------------------------------------------------------------- */

var CLIP_APIFY_BASE = 'https://api.apify.com/v2';
var CLIP_APIFY_DEFAULT_ACTOR = 'dami_studio~instagram-post-scraper';
var CLIP_APIFY_DEFAULT_FIELD = 'postUrls';
var CLIP_APIFY_DONE = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];
var CLIP_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' };

/**
 * IG 分享出來的網址常帶 ?igsh=、?img_index=，也可能是 m.、沒有 www.、帶帳號前綴（/帳號/p/代碼/）。
 * 收成 https://www.instagram.com/{p|reel|tv}/{代碼}/，key 用代碼（同一篇不會存兩次）。認不得就回 null，不猜。
 */
function clipNormalizeUrl_(raw) {
  var m = String(raw || '').trim().match(/^https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  var kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
  return { key: 'ig:' + m[2], url: 'https://www.instagram.com/' + kind + '/' + m[2] + '/', kind: kind };
}

/** 一次請求：網路層例外也收成結果，不讓一個環節中斷其他環節 */
function clipFetch_(url, opts) {
  var started = Date.now();
  try {
    var o = Object.assign({ muteHttpExceptions: true }, opts || {});
    var res = UrlFetchApp.fetch(url, o);
    return { status: res.getResponseCode(), ms: Date.now() - started, res: res };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, res: null, error: String(err && err.message || err) };
  }
}

function clipJson_(r) {
  if (!r.res) return null;
  try { return JSON.parse(r.res.getContentText()); } catch (e) { return null; }
}

function clipText_(r, max) {
  var s = r.res ? String(r.res.getContentText()) : '';
  return max && s.length > max ? s.slice(0, max) + '…' : s;
}

function clipHead_(r) {
  return r.error ? '連線失敗（' + r.error + '）' : 'HTTP ' + r.status;
}

/**
 * Apify 設定一律讀指令碼屬性（免改程式重部署）：APIFY_TOKEN（必填）、APIFY_ACTOR、APIFY_INPUT_FIELD。
 * 2026-10-16 實測：INPUT_FIELD 被填成貼文網址，actor 不認得 input 就回範例資料——欄位名不會有 / 或 :，不像就不採用
 */
function clipApifyConfig_(props) {
  var field = props.getProperty('APIFY_INPUT_FIELD') || CLIP_APIFY_DEFAULT_FIELD;
  var rejected = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field);
  return {
    token: props.getProperty('APIFY_TOKEN') || '',
    actor: props.getProperty('APIFY_ACTOR') || CLIP_APIFY_DEFAULT_ACTOR,
    field: rejected ? CLIP_APIFY_DEFAULT_FIELD : field,
    fieldRejected: rejected
  };
}

/**
 * 一次 Apify run（啟動＋輪詢，不用 run-sync：同步端點最長要等 5 分鐘，會先被 GAS 砍掉）。按篇計費：maxItems＝篇數。
 * 回 { stage, ... }：stage＝'start'（啟動失敗）｜'run'（狀態不是 SUCCEEDED）｜'dataset'（讀結果失敗）｜'ok'。
 * actor 沒認得 input 時會回帶 _sample 的範例資料（2026-10-16 實測），一律排除，只算 samples 筆數。
 */
function clipApifyRun_(cfg, urls, opt) {
  opt = opt || {};
  var out = { stage: 'start', detail: '', ms: 0, usd: null, runStatus: '', timedOut: false, items: [], samples: 0, keys: [] };
  var headers = { Authorization: 'Bearer ' + cfg.token };
  var input = { maxItems: urls.length };
  input[cfg.field] = urls;
  var started = Date.now();
  var r = clipFetch_(CLIP_APIFY_BASE + '/acts/' + encodeURIComponent(cfg.actor) + '/runs?waitForFinish=' + opt.waitSec,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify(input), headers: headers });
  var run = (clipJson_(r) || {}).data;
  for (var i = 0; run && run.id && CLIP_APIFY_DONE.indexOf(run.status) === -1 && i < opt.maxPolls; i++) {
    if (opt.onPoll) opt.onPoll(run.status);
    r = clipFetch_(CLIP_APIFY_BASE + '/actor-runs/' + encodeURIComponent(run.id) + '?waitForFinish=' + opt.waitSec, { headers: headers });
    run = (clipJson_(r) || {}).data || run;
  }
  if (!run || !run.id) {
    out.ms = Date.now() - started;
    out.detail = clipHead_(r) + '｜' + clipText_(r, 300);
    return out;
  }
  out.runStatus = run.status;
  out.usd = typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : null;
  if (run.status !== 'SUCCEEDED') {
    out.stage = 'run';
    out.timedOut = CLIP_APIFY_DONE.indexOf(run.status) === -1;
    out.ms = Date.now() - started;
    return out;
  }
  var d = clipFetch_(CLIP_APIFY_BASE + '/datasets/' + encodeURIComponent(run.defaultDatasetId) + '/items?clean=true&format=json', { headers: headers });
  out.ms = Date.now() - started;
  var items = clipJson_(d);
  if (!Array.isArray(items)) {
    out.stage = 'dataset';
    out.detail = clipHead_(d) + '｜' + clipText_(d, 300);
    return out;
  }
  items.forEach(function (it) { Object.keys(it || {}).forEach(function (k) { if (out.keys.indexOf(k) === -1) out.keys.push(k); }); });
  out.samples = items.filter(function (it) { return it && it._sample; }).length;
  out.items = items.filter(function (it) { return it && !it._sample; });
  out.stage = 'ok';
  return out;
}

function clipPick_(obj, names) {
  for (var i = 0; i < names.length; i++) {
    var v = names[i].split('.').reduce(function (o, k) { return o && o[k]; }, obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

/** 一張圖／一段影片 → { type, source_url, cover_url } */
function clipMediaEntry_(x) {
  if (typeof x === 'string') return { type: 'image', source_url: x, cover_url: '' };
  var video = /video/i.test(String(clipPick_(x, ['type', 'mediaType', 'media_type']))) || !!clipPick_(x, ['videoUrl', 'video_url']);
  return video
    ? { type: 'video', source_url: String(clipPick_(x, ['videoUrl', 'video_url', 'url'])), cover_url: String(clipPick_(x, ['displayUrl', 'imageUrl', 'image_url', 'thumbnailUrl'])) }
    : { type: 'image', source_url: String(clipPick_(x, ['displayUrl', 'imageUrl', 'image_url', 'url', 'src'])), cover_url: '' };
}

/** 輪播優先讀子項目；沒有才當單張／單支影片 */
function clipMediaOf_(item) {
  var lists = ['childPosts', 'carouselMedia', 'carousel_media', 'sidecarMedia', 'media', 'mediaItems', 'images', 'imageUrls'];
  for (var i = 0; i < lists.length; i++) {
    var arr = item[lists[i]];
    if (Array.isArray(arr) && arr.length) return arr.map(clipMediaEntry_);
  }
  var single = clipMediaEntry_(item);
  // 單張的 url 欄常常是貼文本身的網址（輪播是空的時候就會退到這裡）——那不是圖片
  if (clipNormalizeUrl_(single.source_url)) return [];
  return single.source_url ? [single] : [];
}

/** 只認代碼或網址對得上的那筆；不因「剛好只回一筆」就硬配（2026-10-16 就是這樣把範例資料當成測試貼文） */
function clipItemFor_(post, items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var code = clipPick_(it, ['shortCode', 'shortcode', 'code']);
    if (code === post.id) return it;
    var n = clipNormalizeUrl_(clipPick_(it, ['url', 'inputUrl', 'postUrl']));
    if (n && n.key === post.key) return it;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* LINE 登記                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 從整則訊息抽 IG 貼文網址（不假設整則就是網址）。同一則重複的同一篇只算一筆，照出現順序。
 * 類型只分 post／reel：舊的 /tv/ 也是影片，但 Apify 對它回的形狀未實測，先當貼文收（有圖就存）。
 */
function clipExtractUrls_(text) {
  var out = [];
  var seen = {};
  (String(text || '').match(/https?:\/\/[^\s<>"'）)】」]+/g) || []).forEach(function (u) {
    var n = clipNormalizeUrl_(u);
    if (!n || seen[n.key]) return;
    seen[n.key] = true;
    out.push({ url: n.url, shortcode: n.key.slice(3), kind: n.kind === 'reel' ? 'reel' : 'post' });
  });
  return out;
}

/** Threads／FB／X：不收（A-3），但要回一句話，不然分享了沒反應會以為壞了 */
function clipOtherSocial_(text) {
  return /https?:\/\/(?:[a-z0-9-]+\.)*(?:threads\.net|threads\.com|facebook\.com|fb\.watch|fb\.com|x\.com|twitter\.com)\//i.test(String(text || ''));
}

/**
 * 一對一聊天、「不屬於任何指令」的訊息（routeLineMessage_ 查不到前綴才會到這裡）。
 * 有 IG 網址＋本人有 feat_clips → 一篇寫一列 pending、回「收到 ✅」；只有 Threads／FB／X → 回不支援。
 * 不是收藏的事回 null，交回原本的「看不懂這個指令」。白名單已由 handleLineEvent_ 的 writeGate_ 把關。
 */
function clipLineReply_(text, userId) {
  if (!canUse_(lineUserById_(userId), CLIPS_FEATURE)) return null;
  var found = clipExtractUrls_(text);
  if (!found.length) return clipOtherSocial_(text) ? '目前只支援 Instagram' : null;
  try {
    ensureClipsSheet_();
    var now = new Date().toISOString();
    var rowNumber = '';
    found.forEach(function (f, i) {
      rowNumber = appendToSheet_(CLIPS_SHEET, {
        id: 'clip_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 1e6), line_id: String(userId || '').trim(),
        source_text: String(text || ''), url: f.url, shortcode: f.shortcode, kind: f.kind, status: 'pending', attempts: 0,
        next_try_at: '', error: '', category: '', collected_at: now, last_collected_at: now, del: '', created_at: now, updated_at: now
      });
    });
    logTransaction_(CLIPS_LOG_SOURCE, '成功', text, '登記 ' + found.length + ' 篇，等排程收齊',
      found.map(function (f) { return f.url; }).join('、'), rowNumber, userId);
    return found.length === 1 ? '收到 ✅' : '收到 ✅（' + found.length + ' 篇）';
  } catch (err) {
    console.log('收藏登記失敗：' + err);
    logTransaction_(CLIPS_LOG_SOURCE, '失敗', text, '登記失敗', String(err && err.stack || err), '', userId);
    return '收藏登記失敗了：' + (err && err.message || err);
  }
}

/* -------------------------------------------------------------------------- */
/* 分頁                                                                         */
/* -------------------------------------------------------------------------- */

/** 建表（只建表頭）。可重複執行；已存在的表缺欄就補在最右邊 */
function ensureClipsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CLIPS_SHEET);
  var created = false;
  if (!sheet) { sheet = ss.insertSheet(CLIPS_SHEET); created = true; }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, CLIPS_HEADERS.length).setValues([CLIPS_HEADERS]);
    return { sheet: sheet, created: created, added: [] };
  }
  var r = ensureColumnsOnSheet_(sheet, CLIPS_HEADERS);
  return { sheet: sheet, created: created, added: r.added || [] };
}

/** 整張讀進來，一列一個 { row（Sheet 列號）, rec }。clips 一篇一列，一個月約 300 列，整張讀沒問題 */
function clipsTable_(sheet) {
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  return {
    headers: headers,
    rows: values.slice(1).map(function (row, i) {
      var rec = {};
      headers.forEach(function (h, j) { rec[h] = row[j]; });
      return { row: i + 2, rec: rec };
    })
  };
}

/**
 * 改一列的幾個欄位。先用 id 重新找列號（不信任讀進來時的列號），整列一次 setValues；包在 script lock 裡，
 * PWA 的重跑／刪除跟排程同時改同一列也不會互蓋。拿不到鎖就丟例外，呼叫端決定怎麼處理
 */
function clipsPatch_(sheet, id, patch) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('clips 忙碌中（拿不到鎖）');
  try {
    var t = clipsTable_(sheet);
    var hit = t.rows.filter(function (x) { return String(x.rec.id) === String(id); })[0];
    return hit ? clipsWriteRow_(sheet, t.headers, hit, patch) : null;
  } finally {
    lock.releaseLock();
  }
}

/** 把 patch 套到一列並整列寫回。不拿鎖：呼叫端負責（clipsPatch_ 自己拿；初始化由 handleInitCommand_ 拿著 script lock） */
function clipsWriteRow_(sheet, headers, hit, patch) {
  Object.keys(patch).forEach(function (k) { if (headers.indexOf(k) !== -1) hit.rec[k] = patch[k]; });
  hit.rec.updated_at = new Date().toISOString();
  sheet.getRange(hit.row, 1, 1, headers.length).setValues([headers.map(function (h) { return hit.rec[h] == null ? '' : hit.rec[h]; })]);
  return hit.rec;
}

function clipDeleted_(rec) {
  return String(rec.del == null ? '' : rec.del).trim().toUpperCase() === 'TRUE';
}

/* -------------------------------------------------------------------------- */
/* 排程工作（ADR-019 總管每輪呼叫）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 這一輪要處理哪些篇：pending、未刪、到了 next_try_at、擁有者仍有 feat_clips；最多 5 篇。
 * 先做合併（D-4）：同一擁有者已有同網址的未刪除列（比它早登記的）→
 *   ① 舊列 done：更新舊列 last_collected_at，新列標 del，不抓
 *   ② 舊列 failed／partial：舊列重設成 pending（attempts=0）並在這一輪處理，新列標 del
 *   ③ 舊列也還在 pending（還沒輪到就又分享一次）：同 ①，交給舊列處理
 */
function clipsPick_(sheet, nowMs) {
  var t = clipsTable_(sheet);
  var batch = [];
  var inBatch = {};
  var ownerOk = {};
  var canOwner = function (lineId) {
    if (!(lineId in ownerOk)) ownerOk[lineId] = canUse_(lineUserById_(lineId), CLIPS_FEATURE);
    return ownerOk[lineId];
  };
  t.rows.forEach(function (x, idx) {
    var r = x.rec;
    if (batch.length >= CLIPS_PER_ROUND) return;
    if (clipDeleted_(r) || r.status !== 'pending') return;
    var next = Date.parse(r.next_try_at);
    if (!isNaN(next) && next > nowMs) return;
    if (!canOwner(String(r.line_id))) return;

    var older = t.rows.slice(0, idx).filter(function (o) {
      return !clipDeleted_(o.rec) && String(o.rec.line_id) === String(r.line_id) && o.rec.url === r.url;
    })[0];
    if (older) {
      var o = older.rec;
      clipsPatch_(sheet, r.id, { del: 'TRUE' });
      if (o.status === 'failed' || o.status === 'partial') {
        var reset = clipsPatch_(sheet, o.id, { status: 'pending', attempts: 0, next_try_at: '', error: '', last_collected_at: r.collected_at });
        if (reset && !inBatch[o.id]) { batch.push(reset); inBatch[o.id] = true; }
      } else {
        clipsPatch_(sheet, o.id, { last_collected_at: r.collected_at });
      }
      return;
    }
    if (!inBatch[r.id]) { batch.push(r); inBatch[r.id] = true; }
  });
  return batch;
}

/**
 * 排程總管的 clips 工作。ctx.budgetLeft()：總管這一輪還剩多少毫秒（不夠一篇就不開始，留給下一輪）。
 * 回 { processed }。每篇寫 logs；效能紀錄走 ADR-019 的排隊（recordSchedulePerf_），不直接寫 performance。
 */
function runClipsJob_(now, ctx) {
  var started = Date.now();
  var budgetLeft = (ctx && ctx.budgetLeft) || function () { return Infinity; };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { processed: 0 };
  if (budgetLeft() < CLIPS_MIN_BUDGET_MS) return { processed: 0, reason: 'budget' };
  var nowMs = (now instanceof Date ? now : new Date()).getTime();
  var batch = clipsPick_(sheet, nowMs);
  if (!batch.length) return { processed: 0 };

  var cfg = clipApifyConfig_(PropertiesService.getScriptProperties());
  var apify = cfg.token
    ? clipApifyRun_(cfg, batch.map(function (r) { return r.url; }), { waitSec: CLIPS_APIFY_WAIT_SEC, maxPolls: CLIPS_APIFY_MAX_POLLS })
    : null;
  var processed = 0;
  batch.forEach(function (rec) {
    if (budgetLeft() < CLIPS_POST_BUDGET_MS) return;          // 留給下一輪；不算一次失敗
    var result;
    try {
      result = clipCollectOne_(rec, apify, nowMs);
    } catch (err) {
      result = { ok: false, error: '處理時出錯：' + String(err && err.message || err) };
    }
    clipsRecordResult_(sheet, rec, result, nowMs);
    processed++;
  });
  recordSchedulePerf_('clips', processed, Date.now() - started);
  return { processed: processed };
}

/** Apify 這一步失敗時給人看的一句話 */
function clipApifyError_(apify) {
  if (!apify) return '沒設 APIFY_TOKEN（專案設定 → 指令碼屬性）';
  if (apify.stage === 'start') return 'Apify 啟動失敗（' + apify.detail.split('｜')[0] + '）';
  if (apify.stage === 'run') return apify.timedOut ? 'Apify 跑太久，這一輪先放棄' : 'Apify 跑失敗（' + apify.runStatus + '）';
  if (apify.stage === 'dataset') return '讀不到 Apify 的結果（' + apify.detail.split('｜')[0] + '）';
  return '';
}

/**
 * 收一篇：Apify 的那一筆 → Drive。回 { ok, error, ...要寫回列的欄位 }。
 * 重跑整篇重抓：同一資料夾內的舊檔丟垃圾桶（setTrashed，不永久刪除）再重存。
 */
function clipCollectOne_(rec, apify, nowMs) {
  var apifyErr = clipApifyError_(apify);
  if (apifyErr) return { ok: false, error: apifyErr };
  var item = clipItemFor_({ id: String(rec.shortcode), key: 'ig:' + rec.shortcode }, apify.items);
  if (!item) return { ok: false, error: 'Apify 結果裡找不到這篇（可能是私人帳號、已刪除，或網址打錯）' };

  var info = clipInfo_(item);
  // 要存的圖：貼文＝每一張（輪播裡的影片存封面）；Reels＝封面（影片另存 video.mp4，見下面）
  var media = clipMediaOf_(item);
  var urls = rec.kind === 'reel'
    ? (function () {
        var cover = media.filter(function (m) { return m.type === 'video'; }).map(function (m) { return m.cover_url; })[0] ||
          String(clipPick_(item, ['displayUrl', 'thumbnailUrl', 'imageUrl']));
        return cover ? [cover] : [];
      })()
    : media.map(function (m) { return m.type === 'video' ? m.cover_url : m.source_url; });
  var out = Object.assign({ ok: false, error: '', media_expected: urls.length, media_saved: 0, drive_folder_id: '', image_ids: '[]', video_saved: '' }, info);
  if (rec.kind !== 'reel' && !urls.length) { out.error = 'Apify 沒有回任何圖片'; return out; }

  var folder = clipsFolder_(rec, info.author);
  out.drive_folder_id = folder.getId();
  var old = folder.getFiles();
  while (old.hasNext()) old.next().setTrashed(true);

  var errors = [];
  var ids = [];
  var names = [];
  var responses = clipFetchAll_(urls);
  urls.forEach(function (u, i) {
    var n = i + 1;
    var label = '第 ' + n + ' 張';
    if (!u) { errors.push(label + '沒有圖片網址'); return; }
    var r = responses[i];
    if (!r || r.status !== 200) { errors.push(label + '下載失敗（' + (r ? clipHead_(r) : '沒有回應') + '）'); return; }
    var blob = r.res.getBlob();
    var type = String(blob.getContentType() || '').split(';')[0];
    if (!/^image\//.test(type)) { errors.push(label + '回的不是圖片（' + (type || '未知') + '）'); return; }
    var name = (n < 10 ? '0' : '') + n + '.' + (CLIP_EXT[type] || 'jpg');
    try {
      var file = folder.createFile(blob.setName(name));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      ids.push(file.getId());
      names.push(name);
    } catch (err) {
      errors.push(label + '寫入 Drive 失敗（' + String(err && err.message || err) + '）');
    }
  });
  out.media_saved = ids.length;
  out.image_ids = JSON.stringify(ids);

  // Reels 要有 video.mp4 才算 done；太大不算失敗（done＋說明），下載失敗走既有重試
  var video = rec.kind === 'reel' ? clipSaveVideo_(folder, clipVideoUrl_(item)) : null;
  if (video && video.state === 'saved') out.video_saved = 'TRUE';
  if (video && video.state === 'failed') errors.push(video.error);

  var rawOk = false;
  try {
    folder.createFile(Utilities.newBlob(JSON.stringify(item, null, 2), 'application/json', 'raw.json'));
    rawOk = true;
  } catch (err) { errors.push('raw.json 寫入失敗（' + String(err && err.message || err) + '）'); }
  try {
    folder.createFile(clipContentBlob_(clipContentMd_(clipMdInput_(rec, info, names, video ? video.state : '', item))));
  } catch (err) { errors.push('content.md 寫入失敗（' + String(err && err.message || err) + '）'); }

  out.ok = rawOk && !errors.length && out.media_saved === out.media_expected;
  out.error = errors.length ? errors.join('；') : video && video.state === 'too_big' ? CLIP_VIDEO_TOO_BIG_NOTE : '';
  return out;
}

/** Apify 那一筆 → 作者、發文時間、全文（收藏與重產 content.md 共用） */
function clipInfo_(item) {
  return {
    author: String(clipPick_(item, ['ownerUsername', 'username', 'owner.username', 'author'])),
    posted_at: String(clipPick_(item, ['timestamp', 'takenAt', 'taken_at', 'publishedAt', 'date'])),
    caption: String(clipPick_(item, ['caption', 'text', 'description']))
  };
}

/** Reels 的影片網址：videoUrl，沒有就 videos[] 第一個（2026-10-16 實際回傳兩個都有） */
function clipVideoUrl_(item) {
  var v = clipPick_(item, ['videoUrl', 'video_url']);
  var list = item && item.videos;
  if (!v && Array.isArray(list) && list.length) v = typeof list[0] === 'string' ? list[0] : clipPick_(list[0] || {}, ['url', 'videoUrl']);
  return String(v || '');
}

/** 下載影片存成 video.mp4（私人，不開分享）。回 { state: 'saved'｜'too_big'｜'failed', error } */
function clipSaveVideo_(folder, url) {
  if (!url) return { state: 'failed', error: '影片下載失敗（Apify 沒有回影片網址）' };
  var r = clipFetch_(url);
  if (r.error && CLIP_VIDEO_TOO_BIG.test(r.error)) return { state: 'too_big' };
  if (r.status !== 200) return { state: 'failed', error: '影片下載失敗（' + clipHead_(r) + '）' };
  try {
    folder.createFile(r.res.getBlob().setName('video.mp4'));
    return { state: 'saved' };
  } catch (err) {
    var m = String(err && err.message || err);
    return CLIP_VIDEO_TOO_BIG.test(m) ? { state: 'too_big' } : { state: 'failed', error: '影片寫入 Drive 失敗（' + m + '）' };
  }
}

/** clipContentMd_ 的輸入（收藏與重產共用）。video：'saved'｜'too_big'｜''（沒存到） */
function clipMdInput_(rec, info, names, video, item) {
  return { url: rec.url, kind: rec.kind, author: info.author, posted_at: info.posted_at, collected_at: rec.collected_at,
    caption: info.caption, media_saved: names.length, media_names: names, video: video || '', video_sec: Number((item || {}).videoDuration) || 0 };
}

/** content.md 檔案本身：BOM＋產生器的輸出（產生器維持純函式、不含 BOM） */
function clipContentBlob_(md) {
  return Utilities.newBlob(CLIP_MD_BOM + md, 'text/markdown', 'content.md');
}

/** 圖片並行下載（UrlFetchApp.fetchAll）；整批丟例外（例如網路層）就全部當失敗，回傳形狀跟 clipFetch_ 一樣 */
function clipFetchAll_(urls) {
  var reqs = [];
  var at = [];
  urls.forEach(function (u, i) { if (u) { reqs.push({ url: u, muteHttpExceptions: true }); at.push(i); } });
  var out = urls.map(function () { return null; });
  if (!reqs.length) return out;
  try {
    UrlFetchApp.fetchAll(reqs).forEach(function (res, k) { out[at[k]] = { status: res.getResponseCode(), res: res }; });
  } catch (err) {
    at.forEach(function (i) { out[i] = { status: 0, res: null, error: String(err && err.message || err) }; });
  }
  return out;
}

/**
 * Neil OS／收藏／YYYY-MM／YYYYMMDD_作者_代碼／（收藏日、台北時區）。
 * 重跑時優先用列上記的資料夾（作者名之後若改了也還是同一個）；資料夾被刪了才照路徑找或建
 */
function clipsFolder_(rec, author) {
  if (rec.drive_folder_id) {
    try { return DriveApp.getFolderById(String(rec.drive_folder_id)); } catch (err) { /* 被刪了：照路徑重建 */ }
  }
  var day = clipTpe_(rec.collected_at) || clipTpe_(new Date().toISOString());
  var safeAuthor = String(author || 'unknown').replace(/[\\/:*?"<>|\s]+/g, '_');
  var name = day.slice(0, 10).replace(/-/g, '') + '_' + safeAuthor + '_' + rec.shortcode;
  // gmailFolder_：照路徑一層層找或建（gmail.gs，ADR-016）
  return gmailFolder_(CLIPS_DRIVE_ROOT.concat([day.slice(0, 7), name])).folder;
}

/** ISO 時間（或毫秒／秒數）→ 台北的 'YYYY-MM-DD HH:mm'；讀不懂回原字串（空就空） */
function clipTpe_(v) {
  if (v === '' || v == null) return '';
  var t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  if (isNaN(t)) return String(v);
  return new Date(t + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

function clipKindLine_(r) {
  if (r.kind !== 'reel') return '貼文';
  if (r.video === 'saved') return 'Reels，影片已保存（video.mp4' + (r.video_sec ? '，' + Math.round(r.video_sec) + ' 秒' : '') + '）';
  return r.video === 'too_big' ? 'Reels，' + CLIP_VIDEO_TOO_BIG_NOTE : 'Reels，影片未保存';
}

/** content.md（D-2）：上半部資料欄位、下半部全文。給 AI 讀的原料。純函式 */
function clipContentMd_(r) {
  var n = Number(r.media_saved) || 0;
  var names = Array.isArray(r.media_names) && r.media_names.length === n ? r.media_names : null;
  var first = names ? names[0] : '01.jpg';
  var last = names ? names[n - 1] : (n < 10 ? '0' : '') + n + '.jpg';
  var images = n === 0 ? '0 張' : n === 1 ? '1 張（' + first + '）' : n + ' 張（' + first + ' … ' + last + '）';
  return [
    '---',
    '來源: ' + r.url,
    '平台: Instagram',
    '類型: ' + clipKindLine_(r),
    '作者: ' + (r.author || ''),
    '發文時間: ' + clipTpe_(r.posted_at),
    '收藏時間: ' + clipTpe_(r.collected_at),
    '圖片: ' + images,
    '---',
    '',
    String(r.caption || '')
  ].join('\n');
}

/**
 * 結果寫回列。成功 → done；失敗 → attempts+1：第 1～3 次排下一次（下一輪／30 分／2 小時），
 * 第 4 次定案：有存到部分 → partial，一張都沒有 → failed。不推播（B-4），只寫 logs
 */
function clipsRecordResult_(sheet, rec, result, nowMs) {
  var attempts = (Number(rec.attempts) || 0) + 1;
  // 成功也可能有一句說明（Reels 影片過大未保存）
  var patch = { attempts: attempts, error: result.ok ? (result.error || '') : (result.error || '失敗（原因不明）') };
  ['author', 'posted_at', 'caption', 'media_expected', 'media_saved', 'drive_folder_id', 'image_ids', 'video_saved'].forEach(function (k) {
    if (result[k] !== undefined) patch[k] = result[k];
  });
  var status;
  if (result.ok) {
    status = 'done';
    patch.next_try_at = '';
  } else if (attempts <= CLIPS_RETRY_DELAYS_MS.length) {
    status = 'pending';
    patch.next_try_at = new Date(nowMs + CLIPS_RETRY_DELAYS_MS[attempts - 1]).toISOString();
  } else {
    status = (Number(result.media_saved) || 0) > 0 || result.video_saved === 'TRUE' ? 'partial' : 'failed';
    patch.next_try_at = '';
  }
  patch.status = status;
  try {
    clipsPatch_(sheet, rec.id, patch);
  } catch (err) {
    console.log('收藏結果寫回失敗（下一輪會重做）：' + err);
  }
  var head = status === 'done' ? '收齊 ' + patch.media_saved + ' 張' : status === 'pending' ? '第 ' + attempts + ' 次失敗，' + (attempts === 1 ? '下一輪' : '稍後') + '重試' : '定案 ' + status;
  logTransaction_(CLIPS_LOG_SOURCE, status === 'done' ? '成功' : '失敗', rec.url, head,
    patch.error || '', '', String(rec.line_id || ''));
}

/* -------------------------------------------------------------------------- */
/* PWA：重跑、刪除（只限擁有者）                                                   */
/* -------------------------------------------------------------------------- */

/**
 * action=clipRetry｜clipDelete｜clipRead（ADR-021：開閱讀頁即已讀）。只限擁有者；不是擁有者回 { error: 'forbidden', permanent: true }——
 * 這是永久性拒絕，前端收到不重送（ADR-018 實作差異 A-2 的教訓，ADR-019 B-5 同一套）。
 * 重跑：→ pending、attempts=0、清 next_try_at；刪除：del（Drive 不動）
 */
function clipPwaAction_(caller, action, id) {
  if (!canUse_(caller.user, CLIPS_FEATURE)) return { error: 'forbidden', permanent: true, reason: 'feature' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  if (!sheet || !id) return { error: 'not_found', permanent: true };
  var rec = clipsTable_(sheet).rows.map(function (x) { return x.rec; }).filter(function (r) { return String(r.id) === String(id); })[0];
  if (!rec || clipDeleted_(rec)) return { error: 'not_found', permanent: true };
  if (String(rec.line_id).trim() !== String(caller.line_id).trim()) {
    logTransaction_(CLIPS_LOG_SOURCE, '失敗', action + ' ' + id, '不是擁有者，拒絕', '', '', caller.line_id);
    return { error: 'forbidden', permanent: true, reason: 'not_owner' };
  }
  var patch = action === 'clipDelete' ? { del: 'TRUE' }
    : action === 'clipRead' ? { read_status: 'read', last_read_at: new Date().toISOString() }
    : { status: 'pending', attempts: 0, next_try_at: '', error: '' };
  try {
    clipsPatch_(sheet, id, patch);
  } catch (err) {
    return { error: 'busy' };                  // 可重試
  }
  // 已讀只是閱讀狀態，每開一篇都寫一列 logs 只會把 logs 灌大
  if (action !== 'clipRead') logTransaction_(CLIPS_LOG_SOURCE, '成功', action + ' ' + id, action === 'clipDelete' ? '刪除（Drive 保留）' : '重跑', rec.url, '', caller.line_id);
  return { success: true };
}

/**
 * Reading Widget 摘要（ADR-021 D-13）：「上次在讀」＝最後閱讀時間最新的一篇；「未讀」＝收齊（done／partial）且沒讀過的。
 * 只看自己的、刪掉的不算。title 取內文第一行（沒有就作者、網址）
 */
function readingWidget_(ss, user) {
  var read = sheetRecords_(ss, CLIPS_SHEET, {});
  if (read.error) return { unread: 0, last: null, at: new Date().toISOString() };
  var mine = clipsVisibleTo_(read.rows, user).filter(function (r) { return !clipDeleted_(r); });
  var unread = mine.filter(function (r) {
    var st = String(r.status || '').trim();
    return (st === 'done' || st === 'partial') && String(r.read_status || '').trim() !== 'read';
  }).length;
  var last = null, lastMs = 0;
  mine.forEach(function (r) {
    var ms = r.last_read_at ? new Date(r.last_read_at).getTime() : NaN;
    if (isFinite(ms) && ms > lastMs) { lastMs = ms; last = r; }
  });
  return {
    unread: unread,
    last: last ? {
      id: String(last.id), author: String(last.author || ''),
      title: String(last.caption || '').split('\n')[0].trim().slice(0, 60) || String(last.author || '') || String(last.url || ''),
      last_read_at: new Date(lastMs).toISOString()
    } : null,
    at: new Date().toISOString()
  };
}

/** PWA 讀 clips：只回請求者自己的列（readMany 與 read 共用） */
function clipsVisibleTo_(rows, user) {
  var me = String((user || {}).line_id || '').trim();
  return rows.filter(function (r) { return String(r.line_id || '').trim() === me; });
}

/* -------------------------------------------------------------------------- */
/* 「初始化」                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 建 clips 分頁、line_users 補 feat_clips（**這一次才新增**時只替管理員打勾，之後誰的勾都不動；比照 installGmailFeature_）。
 * 可重複執行。回 { level, text } 給「初始化」的回覆
 */
function installClips_() {
  var c = ensureClipsSheet_();
  var lines = [c.created ? '新建 ' + CLIPS_SHEET : CLIPS_SHEET + ' 已存在' + (c.added.length ? '（補上欄位：' + c.added.join('、') + '）' : '')];
  var warn = false;
  var users = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINE_USERS_SHEET);
  if (!users) {
    warn = true;
    lines.push('⚠️ 找不到 ' + LINE_USERS_SHEET + '，沒有補 ' + CLIPS_FEATURE);
  } else {
    var u = ensureColumnsOnSheet_(users, [CLIPS_FEATURE]);
    if (u.reason) {
      warn = true;
      lines.push('⚠️ ' + LINE_USERS_SHEET + ' 沒有表頭，沒有補 ' + CLIPS_FEATURE);
    } else if (!u.added.length) {
      lines.push(LINE_USERS_SHEET + ' 已有 ' + CLIPS_FEATURE);
    } else {
      var headers = sheetHeaders_(users);
      var admins = 0;
      if (users.getLastRow() >= 2) {
        users.getRange(2, 1, users.getLastRow() - 1, headers.length).getValues().forEach(function (row, i) {
          if (truthy_(row[headers.indexOf('is_admin')])) {
            users.getRange(i + 2, headers.indexOf(CLIPS_FEATURE) + 1, 1, 1).setValues([['TRUE']]);
            admins++;
          }
        });
      }
      invalidateLineUsersCache_();
      lines.push(LINE_USERS_SHEET + ' 補上：' + CLIPS_FEATURE + '（預設只開管理者 ' + admins + ' 人）');
    }
  }
  if (!PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN')) {
    warn = true;
    lines.push('⚠️ 還沒設 APIFY_TOKEN（專案設定 → 指令碼屬性），收藏會一直失敗');
  }
  return { level: warn ? 'warn' : 'ok', text: lines.join('\n　') };
}

/* -------------------------------------------------------------------------- */
/* RD-HF1 補救（「初始化」的兩步，可重複執行）                                         */
/* -------------------------------------------------------------------------- */

/**
 * HF-A：done 的列用 Drive 裡的 raw.json 重產 content.md（加 BOM），舊檔丟垃圾桶。不重抓 Apify、不改 Sheet。
 * 全部成功才記 CLIPS_MD_FIX_KEY，之後不再做；有一篇失敗就不記，下次初始化整批再試（已修好的重做一次也一樣）。
 * 回 { already, fixed, failed: ['代碼：原因'] }
 */
function clipsRebuildContentMd_() {
  var props = PropertiesService.getScriptProperties();
  var out = { already: false, fixed: 0, failed: [] };
  if (props.getProperty(CLIPS_MD_FIX_KEY)) { out.already = true; return out; }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return out;           // 還沒有收藏：之後收的都已經有 BOM，不用記
  clipsTable_(sheet).rows.forEach(function (x) {
    var r = x.rec;
    if (clipDeleted_(r) || r.status !== 'done') return;
    try {
      clipsRewriteMd_(r);
      out.fixed++;
    } catch (err) {
      out.failed.push(r.shortcode + '：' + String(err && err.message || err));
    }
  });
  if (!out.failed.length) {
    try { props.setProperty(CLIPS_MD_FIX_KEY, new Date().toISOString()); }
    catch (err) { out.failed.push('記不了「已做完」（下次初始化會再重產一次）：' + String(err && err.message || err)); }
  }
  return out;
}

/** 一篇：讀 raw.json → 照資料夾裡現有的圖片檔名與 video.mp4 重產 → 舊 content.md 丟垃圾桶 → 寫新的 */
function clipsRewriteMd_(rec) {
  if (!rec.drive_folder_id) throw new Error('沒有記資料夾');
  var folder = DriveApp.getFolderById(String(rec.drive_folder_id));
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  var named = function (n) { return files.filter(function (f) { return f.getName() === n; }); };
  var raw = named('raw.json')[0];
  if (!raw) throw new Error('找不到 raw.json');
  var item = JSON.parse(raw.getBlob().getDataAsString('UTF-8'));
  var names = files.map(function (f) { return f.getName(); }).filter(function (n) { return /^\d{2}\.[a-z0-9]+$/i.test(n); }).sort();
  var video = named('video.mp4').length ? 'saved' : String(rec.error) === CLIP_VIDEO_TOO_BIG_NOTE ? 'too_big' : '';
  var md = clipContentMd_(clipMdInput_(rec, clipInfo_(item), names, video, item));
  named('content.md').forEach(function (f) { f.setTrashed(true); });
  folder.createFile(clipContentBlob_(md));
}

/**
 * HF-B：kind=reel、done、沒有影片（不含「影片過大未保存」）、未刪除的列 → pending、attempts=0，總管整篇重抓
 * （舊影片網址可能已過期，所以重打 Apify）。已經在排隊的不是 done，不會再排一次。回 { requeued }
 */
function clipsRequeueReels_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  var out = { requeued: 0 };
  if (!sheet || sheet.getLastRow() < 2) return out;
  var t = clipsTable_(sheet);
  t.rows.forEach(function (x) {
    var r = x.rec;
    if (clipDeleted_(r) || r.kind !== 'reel' || r.status !== 'done' || truthy_(r.video_saved) || String(r.error) === CLIP_VIDEO_TOO_BIG_NOTE) return;
    clipsWriteRow_(sheet, t.headers, x, { status: 'pending', attempts: 0, next_try_at: '', error: '' });
    out.requeued++;
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* RD-HF1 HF-C：Apify 用量（總管每天一次）                                           */
/* -------------------------------------------------------------------------- */

/** GET /users/me/limits 的本月已用金額；沒有這欄回 null（不猜別的欄位） */
function clipApifyUsd_(json) {
  var v = json && json.data && json.data.current && json.data.current.monthlyUsageUsd;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 近 CLIPS_RATE_DAYS 天（照收藏時間）done ÷ 全部，排除刪除。純函式；沒有收藏 rate＝null */
function clipsSuccessRate_(rows, nowMs) {
  var since = nowMs - CLIPS_RATE_DAYS * 86400000;
  var done = 0, total = 0;
  (rows || []).forEach(function (r) {
    if (clipDeleted_(r)) return;
    var t = r.collected_at instanceof Date ? r.collected_at.getTime() : Date.parse(String(r.collected_at));
    if (isNaN(t) || t < since) return;
    total++;
    if (r.status === 'done') done++;
  });
  return { done: done, total: total, rate: total ? Math.round(done / total * 1000) / 1000 : null };
}

/**
 * 排程總管的 apifyUsage 工作。結果存指令碼屬性 CLIPS_USAGE_KEY：
 * { usd, at（金額的時間）, checked_at, error, done, total, rate }。API 失敗保留上次的金額、記下錯誤，不丟例外。
 * token 只放 Authorization header；log 只寫 HTTP 狀態，不寫回應本文。效能紀錄走排隊（recordSchedulePerf_）
 */
function runApifyUsageJob_(now) {
  var started = Date.now();
  var nowDate = now instanceof Date ? now : new Date();
  var at = nowDate.toISOString();
  var props = PropertiesService.getScriptProperties();
  var prev = clipsUsage_() || {};
  var cfg = clipApifyConfig_(props);
  var usd = null, error = '';
  if (!cfg.token) {
    error = '沒設 APIFY_TOKEN';
  } else {
    var r = clipFetch_(CLIP_APIFY_BASE + '/users/me/limits', { headers: { Authorization: 'Bearer ' + cfg.token } });
    usd = r.status === 200 ? clipApifyUsd_(clipJson_(r)) : null;
    if (usd === null) error = r.status === 200 ? '回傳裡找不到 current.monthlyUsageUsd' : clipHead_(r);
  }
  var rate = { done: 0, total: 0, rate: null };
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
    if (sheet && sheet.getLastRow() >= 2) rate = clipsSuccessRate_(clipsTable_(sheet).rows.map(function (x) { return x.rec; }), nowDate.getTime());
  } catch (err) { error = (error ? error + '；' : '') + '讀不到 clips（' + String(err && err.message || err) + '）'; }
  var out = { usd: usd !== null ? usd : (typeof prev.usd === 'number' ? prev.usd : null), at: usd !== null ? at : (prev.at || ''),
    checked_at: at, error: error, done: rate.done, total: rate.total, rate: rate.rate };
  try { props.setProperty(CLIPS_USAGE_KEY, JSON.stringify(out)); } catch (err) { console.log('Apify 用量存不了：' + err); }
  logTransaction_(CLIPS_LOG_SOURCE, error ? '失敗' : '成功', 'apifyUsage',
    usd !== null ? 'Apify 本月 US$' + usd.toFixed(2) : 'Apify 本月用量讀不到',
    (error ? error + '｜' : '') + '近 ' + CLIPS_RATE_DAYS + ' 天收藏成功 ' + rate.done + '／' + rate.total, '', '');
  recordSchedulePerf_('apifyUsage', 1, Date.now() - started);
  return { ok: !error, usd: usd, rate: rate.rate };
}

/** 上次存的用量（開機帶給管理員）；沒有或壞掉回 null */
function clipsUsage_() {
  try {
    var v = JSON.parse(PropertiesService.getScriptProperties().getProperty(CLIPS_USAGE_KEY) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch (err) { return null; }
}
