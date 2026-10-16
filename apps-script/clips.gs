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
 *  - 圖片檔「知道連結的人可檢視」（PWA 直接顯示）；資料夾、raw.json、content.md 維持私人（E-2）
 *
 * APIFY_TOKEN 只從指令碼屬性讀、只放 Authorization header，任何 log、Sheet、Drive 都不寫它。
 * 共用的 Apify 呼叫與欄位解析也給階段 0 探針（lab-clip.gs）用，不複製兩份。
 */
var CLIPS_HEADERS = ['id', 'line_id', 'source_text', 'url', 'shortcode', 'kind', 'status', 'attempts', 'next_try_at', 'error',
  'author', 'posted_at', 'caption', 'media_expected', 'media_saved', 'drive_folder_id', 'image_ids', 'category',
  'collected_at', 'last_collected_at', 'del', 'created_at', 'updated_at'];
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
    if (!hit) return null;
    Object.keys(patch).forEach(function (k) { if (t.headers.indexOf(k) !== -1) hit.rec[k] = patch[k]; });
    hit.rec.updated_at = new Date().toISOString();
    sheet.getRange(hit.row, 1, 1, t.headers.length).setValues([t.headers.map(function (h) { return hit.rec[h] == null ? '' : hit.rec[h]; })]);
    return hit.rec;
  } finally {
    lock.releaseLock();
  }
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

  var info = {
    author: String(clipPick_(item, ['ownerUsername', 'username', 'owner.username', 'author'])),
    posted_at: String(clipPick_(item, ['timestamp', 'takenAt', 'taken_at', 'publishedAt', 'date'])),
    caption: String(clipPick_(item, ['caption', 'text', 'description']))
  };
  // 要存的圖：貼文＝每一張（輪播裡的影片存封面）；Reels＝只有封面（不下載影片，A-3）
  var media = clipMediaOf_(item);
  var urls = rec.kind === 'reel'
    ? (function () {
        var cover = media.filter(function (m) { return m.type === 'video'; }).map(function (m) { return m.cover_url; })[0] ||
          String(clipPick_(item, ['displayUrl', 'thumbnailUrl', 'imageUrl']));
        return cover ? [cover] : [];
      })()
    : media.map(function (m) { return m.type === 'video' ? m.cover_url : m.source_url; });
  var out = Object.assign({ ok: false, error: '', media_expected: urls.length, media_saved: 0, drive_folder_id: '', image_ids: '[]' }, info);
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

  var rawOk = false;
  try {
    folder.createFile(Utilities.newBlob(JSON.stringify(item, null, 2), 'application/json', 'raw.json'));
    rawOk = true;
  } catch (err) { errors.push('raw.json 寫入失敗（' + String(err && err.message || err) + '）'); }
  try {
    folder.createFile(Utilities.newBlob(clipContentMd_({ url: rec.url, kind: rec.kind, author: info.author, posted_at: info.posted_at,
      collected_at: rec.collected_at, caption: info.caption, media_saved: ids.length, media_names: names }), 'text/markdown', 'content.md'));
  } catch (err) { errors.push('content.md 寫入失敗（' + String(err && err.message || err) + '）'); }

  out.ok = rawOk && !errors.length && out.media_saved === out.media_expected;
  out.error = errors.join('；');
  return out;
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
    '類型: ' + (r.kind === 'reel' ? 'Reels，影片未保存' : '貼文'),
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
  var patch = { attempts: attempts, error: result.ok ? '' : (result.error || '失敗（原因不明）') };
  ['author', 'posted_at', 'caption', 'media_expected', 'media_saved', 'drive_folder_id', 'image_ids'].forEach(function (k) {
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
    status = (Number(result.media_saved) || 0) > 0 ? 'partial' : 'failed';
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
 * action=clipRetry｜clipDelete。只限擁有者；不是擁有者回 { error: 'forbidden', permanent: true }——
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
  var patch = action === 'clipDelete'
    ? { del: 'TRUE' }
    : { status: 'pending', attempts: 0, next_try_at: '', error: '' };
  try {
    clipsPatch_(sheet, id, patch);
  } catch (err) {
    return { error: 'busy' };                  // 可重試
  }
  logTransaction_(CLIPS_LOG_SOURCE, '成功', action + ' ' + id, action === 'clipDelete' ? '刪除（Drive 保留）' : '重跑', rec.url, '', caller.line_id);
  return { success: true };
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
