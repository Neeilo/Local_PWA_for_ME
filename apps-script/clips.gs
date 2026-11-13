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
  'read_status', 'last_read_at',
  // ADR-021 D-10／D-11：筆記（一篇一份，存檔比對 note_revision）、AI 整理（另存，不覆蓋原文與筆記）。同樣加在最右邊
  'note', 'note_revision', 'note_updated_at', 'ai_output', 'ai_provider', 'ai_at',
  // ADR-024 D-4：📝 文字辨識結果（一篇留最新一份、可捨棄）。同樣加在最右邊
  'ocr_output', 'ocr_at',
  // ADR-024 D-4：🤖 AI 辨識結果（哪一家、什麼時候；一篇留最新一份、可捨棄）
  'vision_output', 'vision_provider', 'vision_at'];
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
/** 閱讀狀態（ADR-025 D-1）：空白＝未讀、reading＝📖 閱讀中、read＝✅ 已讀。沿用 read_status，不新增欄位 */
var CLIP_READ_STATES = ['', 'reading', 'read'];
/** 「初始化」一次性把閱讀狀態重設成未讀（D-7）：做過就記時間，之後不再重設 */
var CLIPS_READ_RESET_KEY = 'clips_read_reset';
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
/**
 * 只存連結（ADR-021 D-12）：IG 以外的網址（含 Threads／FB／X）不抓取、不抓標題，只記網址與收藏時間。
 * kind 與 status 都是 'link'：排程只挑 pending，所以不會送 Apify；網域由網址現算，不另開欄
 */
var CLIP_LINK = 'link';
var CLIP_LINK_MAX = 2000;
var CLIP_URL_RE = /https?:\/\/[^\s<>"'）)】」]+/g;
/** 筆記上限：一格 Sheet 最多 5 萬字，留餘裕；超過就擋下講明，不偷偷截斷 */
var CLIP_NOTE_MAX = 20000;
/** 送給 AI 的原文上限（筆記另計）：太長只會變貴，整理重點用不到 */
var CLIP_AI_INPUT_MAX = 20000;
/**
 * ADR-027：Threads 收藏。kind＝'threads'（status 照 IG：pending／done／partial／failed）；平台由 kind／網址推導，不新增欄位。
 * LINE 收到的一律是 /share/短碼：webhook 照原樣登記（shortcode 空白），排程輪到時才轉址取貼文代碼（webhook 不打外部）
 */
var CLIP_THREADS = 'threads';
/** 串文可能沒收完（被回覆上限截斷、或順序串不起來改照時間排）：寫在 error 欄當說明、status 仍是 done，不觸發重試（D-6） */
var CLIP_THREAD_INCOMPLETE_NOTE = '串文可能不完整';
/** 一次 Threads run 每篇最多扣多少（30 列回覆＋主文 ≈ US$0.076，留餘裕）；走 maxTotalChargeUsd */
var CLIP_THREADS_RUN_MAX_USD_PER_POST = 0.1;
/**
 * 圖書館設定（ADR-027，Neil 2026-11-13）：各平台存不存圖片／影片。存指令碼屬性 JSON，只有管理者在圖書館設定改。
 * IG 預設維持原本行為（都存）；Threads 預設不存影片。force_month＝「本月超過上限仍繼續抓」打開的月份（台北 YYYY-MM），換月自動失效
 */
var CLIPS_SETTINGS_KEY = 'clips_settings';
var CLIPS_SETTINGS_DEFAULTS = { ig_images: true, ig_videos: true, threads_images: true, threads_videos: false };
var CLIPS_SETTINGS_LABELS = { ig_images: 'IG 存圖片', ig_videos: 'IG 存影片（Reels）', threads_images: 'Threads 存圖片', threads_videos: 'Threads 存影片', force: '本月超過上限仍繼續抓' };
/** Threads 本月估算用量（列數×單價，因為 run 的 usageTotalUsd 不含按筆計費）：{ month, usd, posts } */
var CLIPS_THREADS_USAGE_KEY = 'clips_threads_usage';
/** 已經寫過「本月暫停」logs 的月份：一個月只寫一次，不每 5 分鐘洗版 */
var CLIPS_PAUSED_KEY = 'clips_paused_month';
/** 「初始化」一次性把只存連結的 Threads 列轉成等待抓取（D-3）：做過就記時間 */
var CLIPS_THREADS_BACKFILL_KEY = 'clips_threads_backfill';

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
    var res = callApi_(clipApiId_(url), url, o);
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
 * 選填（ADR-027 PR-0 起）：opt.input 取代預設的 { maxItems }（各 actor 的 input 不同）；
 * opt.maxUsd 帶 maxTotalChargeUsd（按事件計費的 actor 一次 run 最多扣多少）。不給就跟原本一樣。
 */
function clipApifyRun_(cfg, urls, opt) {
  opt = opt || {};
  var out = { stage: 'start', detail: '', ms: 0, usd: null, runStatus: '', timedOut: false, items: [], samples: 0, keys: [], kvs: '' };
  var headers = { Authorization: 'Bearer ' + cfg.token };
  var input = opt.input ? Object.assign({}, opt.input) : { maxItems: urls.length };
  input[cfg.field] = urls;
  var started = Date.now();
  var r = clipFetch_(CLIP_APIFY_BASE + '/acts/' + encodeURIComponent(cfg.actor) + '/runs?waitForFinish=' + opt.waitSec +
    (typeof opt.maxUsd === 'number' ? '&maxTotalChargeUsd=' + opt.maxUsd : ''),
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
  out.kvs = run.defaultKeyValueStoreId || '';
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
/* Threads（ADR-027）：網址、短網址轉址、作者串文（探針 lab-clip.gs 也用）            */
/* -------------------------------------------------------------------------- */

/*
 * 爬蟲：architekture~threads-replies-scraper（ADR-027 PR-0 探針 2026-11-13 實測：主文、圖片、作者串文 3／3）。
 * 一次回主文（recordType=post）與回覆；作者自己的接續標 replyType=author_thread、帶 parentCode。
 * 按筆計費（主文 US$0.001、回覆 US$0.0025），別人的留言也計費 → maxRepliesPerPost 一定要設上限。
 * ⚠️ run 物件的 usageTotalUsd 不含按筆計費（實測回 US$0.021，照列數算是 US$0.138），成本一律照列數×單價估。
 */
/** 短網址最多跟幾次轉址（share → /@帳號/post/代碼?xmt=… 通常一次就到） */
var CLIP_THREADS_MAX_HOPS = 3;
var CLIP_THREADS_ACTOR = 'architekture~threads-replies-scraper';
/** 每篇最多回幾列回覆（含別人的留言）；串文在這之內才收得到，探針會印出有沒有被截斷 */
var CLIP_THREADS_MAX_REPLIES = 30;
var CLIP_THREADS_USD_POST = 0.001;
var CLIP_THREADS_USD_REPLY = 0.0025;

/**
 * 一個網址 → { code, user, url }（單篇貼文）｜{ share, url }（分享短網址 /share/代碼，要先轉址）｜null。
 * 認得 threads.com／threads.net、有無 www、/@帳號/post/代碼、/t/代碼；代碼後面的路徑、參數、# 都去掉，
 * 網域統一成 www.threads.com
 */
function clipThreadsParse_(raw) {
  var s = String(raw || '').trim().replace(/^["'「『(（<]+|["'」』)）>]+$/g, '');
  var m = s.match(/^https?:\/\/(?:www\.)?threads\.(?:com|net)\/(?:@([A-Za-z0-9._]+)\/post|t)\/([A-Za-z0-9_-]+)/i);
  if (m) return { code: m[2], user: m[1] || '', url: 'https://www.threads.com/' + (m[1] ? '@' + m[1] + '/post/' : 't/') + m[2] };
  var sh = s.match(/^https?:\/\/(?:www\.)?threads\.(?:com|net)\/share\/([A-Za-z0-9_-]+)/i);
  if (sh) return { share: sh[1], url: 'https://www.threads.com/share/' + sh[1] };
  return null;
}

/**
 * 分享短網址 → 真正的貼文網址：不自動跟轉址，自己讀 Location（最多 CLIP_THREADS_MAX_HOPS 次），
 * 這樣才看得出 Google 機房打 threads.com 時是正常轉址、被擋，還是被導去登入頁。走 callApi_('web')。
 * 回 { ok, post（clipThreadsParse_ 的結果）, status, location, error }
 */
function clipThreadsResolveShare_(url) {
  var cur = url;
  var last = { status: 0, location: '' };
  for (var hop = 0; hop < CLIP_THREADS_MAX_HOPS; hop++) {
    var r = clipFetch_(cur, { followRedirects: false });
    var headers = r.res && r.res.getHeaders ? r.res.getHeaders() || {} : {};
    var loc = '';
    Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === 'location') loc = String(headers[k] || ''); });
    if (loc && loc.charAt(0) === '/') loc = 'https://www.threads.com' + loc;
    last = { status: r.status, location: loc };
    if (r.status === 0) return { ok: false, post: null, status: 0, location: '', error: clipHead_(r) };
    var post = loc ? clipThreadsParse_(loc) : null;
    if (post && post.code) return { ok: true, post: post, status: r.status, location: loc, error: '' };
    // 只有轉到的還是短網址才再跟；轉去登入頁之類的就停下來照實回報
    if (!loc || r.status < 300 || r.status >= 400 || !(post && post.share)) break;
    cur = loc;
  }
  var why = last.location ? '轉到的不是貼文（' + last.location.split('?')[0] + '）' : 'HTTP ' + last.status + (last.status === 200 ? '，沒有轉址（可能是登入頁或要跑 JavaScript 才轉）' : '');
  return { ok: false, post: null, status: last.status, location: last.location, error: why };
}

/**
 * 作者自己的接續串文（replyType=author_thread），從主文照 parentCode 一路串下去。
 * 串得完整 → method='parent'；串不起來（例如全掛在主文底下）→ 照時間排、method='time'、orderOk=false。
 * 純函式：PR-A 的串文合併會用同一份。
 */
function clipThreadsAuthorChain_(rootCode, rows) {
  var thread = (rows || []).filter(function (x) { return x && x.recordType !== 'status' && x.replyType === 'author_thread'; });
  var byParent = {};
  thread.forEach(function (x) { (byParent[x.parentCode] = byParent[x.parentCode] || []).push(x); });
  var chain = [];
  var seen = {};
  var cur = rootCode;
  while (byParent[cur] && byParent[cur].length === 1 && !seen[cur]) {
    seen[cur] = true;
    chain.push(byParent[cur][0]);
    cur = byParent[cur][0].code;
  }
  var ts = function (x) { return String(x.timestamp || ''); };
  if (chain.length === thread.length) {
    var timeOk = chain.every(function (x, i) { return i === 0 || !ts(x) || !ts(chain[i - 1]) || ts(chain[i - 1]) <= ts(x); });
    return { rows: chain, method: 'parent', orderOk: timeOk };
  }
  var sorted = thread.slice().sort(function (a, b) { return ts(a) < ts(b) ? -1 : ts(a) > ts(b) ? 1 : 0; });
  return { rows: sorted, method: 'time', orderOk: false };
}

/** 一列的圖片／影片網址（欄位可能是字串陣列或物件陣列） */
function clipThreadsMedia_(row, field) {
  var arr = row && row[field];
  if (!Array.isArray(arr)) return [];
  return arr.map(function (x) { return typeof x === 'string' ? x : String(clipPick_(x || {}, ['url', 'src', 'displayUrl', 'imageUrl', 'videoUrl'])); })
    .filter(function (u) { return !!u; });
}

/** RUN_SUMMARY.perPost（每篇有沒有被上限截斷）；讀不到就當沒有，不影響結論 */
function clipThreadsRunSummary_(token, kvs) {
  if (!kvs) return [];
  var r = clipFetch_(CLIP_APIFY_BASE + '/key-value-stores/' + encodeURIComponent(kvs) + '/records/RUN_SUMMARY', { headers: { Authorization: 'Bearer ' + token } });
  var j = r.status === 200 ? clipJson_(r) : null;
  return j && Array.isArray(j.perPost) ? j.perPost : [];
}

/** 網址 → 貼文代碼（不是單篇貼文或只是短網址就回空） */
function clipThreadsCodeOf_(url) {
  var p = clipThreadsParse_(url);
  return p && p.code ? p.code : '';
}

/**
 * 主文＋作者串文合併成一篇（content.md 與 clips.caption 共用，純函式）。主文放最前面不加標題
 * （列表、Reading Widget 拿第一行當標題）；之後每段加「── 串文 i／N ──」，N 含主文
 */
function clipThreadsMerge_(root, chain) {
  var parts = [String(root && root.text || '')].concat((chain || []).map(function (x) { return String(x && x.text || ''); }));
  if (parts.length === 1) return parts[0];
  return parts.map(function (t, i) { return i === 0 ? t : '── 串文 ' + (i + 1) + '／' + parts.length + ' ──\n' + t; }).join('\n\n');
}

/** 一次 run 的估算費用：主文列×US$0.001＋回覆列×US$0.0025（status 列免費） */
function clipThreadsRunUsd_(items) {
  var usd = 0;
  (items || []).forEach(function (x) {
    if (x && x.recordType === 'post') usd += CLIP_THREADS_USD_POST;
    else if (x && x.recordType === 'reply') usd += CLIP_THREADS_USD_REPLY;
  });
  return Math.round(usd * 10000) / 10000;
}

/** 排程用的 Threads run：要作者串文、每篇回覆有上限、整次有花費上限；成功就讀 RUN_SUMMARY（有沒有被截斷）並記估算用量 */
function clipThreadsRun_(token, urls, now) {
  var r = clipApifyRun_({ token: token, actor: CLIP_THREADS_ACTOR, field: 'postUrls' }, urls, {
    waitSec: CLIPS_APIFY_WAIT_SEC, maxPolls: CLIPS_APIFY_MAX_POLLS,
    maxUsd: Math.round(urls.length * CLIP_THREADS_RUN_MAX_USD_PER_POST * 100) / 100,
    input: { maxRepliesPerPost: CLIP_THREADS_MAX_REPLIES, includeAuthorThread: true, sortOrder: 'TOP' }
  });
  r.summary = [];
  if (r.stage === 'ok') {
    r.summary = clipThreadsRunSummary_(token, r.kvs);
    clipsThreadsUsageAdd_(clipThreadsRunUsd_(r.items), urls.length, now);
  }
  return r;
}

/* -------------------------------------------------------------------------- */
/* LINE 登記                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 從整則訊息抽要排隊抓的網址（不假設整則就是網址）。同一則重複的同一篇只算一筆，照出現順序。
 * IG：類型只分 post／reel（舊的 /tv/ 先當貼文收）。Threads（ADR-027）：kind＝threads；/share/ 短網址照原樣存、
 * shortcode 空白，等排程轉址（webhook 不打外部）；單篇貼文網址收成乾淨網址＋貼文代碼
 */
function clipExtractUrls_(text) {
  var out = [];
  var seen = {};
  (String(text || '').match(CLIP_URL_RE) || []).forEach(function (u) {
    var n = clipNormalizeUrl_(u);
    if (n) {
      if (seen[n.key]) return;
      seen[n.key] = true;
      out.push({ url: n.url, shortcode: n.key.slice(3), kind: n.kind === 'reel' ? 'reel' : 'post' });
      return;
    }
    var t = clipThreadsParse_(u);
    if (!t) return;
    var key = t.code ? 'th:' + t.code : 'ths:' + t.share;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ url: t.url, shortcode: t.code || '', kind: CLIP_THREADS });
  });
  return out;
}

/**
 * IG 貼文以外的網址（ADR-021 D-12：只存連結）。句尾標點不算網址；同一則重複只算一筆。
 * IG 貼文交給 clipExtractUrls_；IG 的個人頁之類不是貼文的，一樣當一般連結
 */
function clipLinkUrls_(text) {
  var out = [];
  var seen = {};
  (String(text || '').match(CLIP_URL_RE) || []).forEach(function (u) {
    if (clipNormalizeUrl_(u) || clipThreadsParse_(u)) return;      // IG 與 Threads 貼文排隊抓（ADR-027）
    u = u.replace(/[.,;:!?。，、；：！？]+$/, '');
    if (u.length > CLIP_LINK_MAX || seen[u]) return;
    seen[u] = true;
    out.push({ url: u, shortcode: '', kind: CLIP_LINK });
  });
  return out;
}

/** 一則訊息裡要收的：IG 貼文（排隊抓）在前、其他網址（只存連結）在後 */
function clipFoundIn_(text) {
  return clipExtractUrls_(text).concat(clipLinkUrls_(text));
}

/** https://www.example.com/a → example.com（只存連結的標題用；不抓網頁） */
function clipDomain_(url) {
  var m = String(url || '').match(/^https?:\/\/([^\/?#:]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

/**
 * 登記（LINE 與 PWA「＋ 加網址」共用）。IG 貼文一篇一列 pending，重複的交給排程合併（clipsPick_）；
 * 只存連結不會進排程，所以在這裡去重：同一人已有同網址的連結 → 只更新 last_collected_at。回最後寫入的列號
 */
function clipsRegister_(lineId, sourceText, found) {
  var sheet = ensureClipsSheet_().sheet;
  var now = new Date().toISOString();
  var rowNumber = '';
  var table = null;
  found.forEach(function (f, i) {
    if (f.kind === CLIP_LINK) {
      table = table || clipsTable_(sheet);
      var dup = table.rows.filter(function (x) {
        return !clipDeleted_(x.rec) && String(x.rec.line_id).trim() === lineId && x.rec.kind === CLIP_LINK && x.rec.url === f.url;
      })[0];
      if (dup) { clipsPatch_(sheet, dup.rec.id, { last_collected_at: now }); return; }
    }
    rowNumber = appendToSheet_(CLIPS_SHEET, {
      id: 'clip_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 1e6), line_id: lineId,
      source_text: String(sourceText || ''), url: f.url, shortcode: f.shortcode, kind: f.kind,
      status: f.kind === CLIP_LINK ? CLIP_LINK : 'pending', attempts: 0,
      next_try_at: '', error: '', category: '', collected_at: now, last_collected_at: now, del: '', created_at: now, updated_at: now
    });
  });
  return rowNumber;
}

/** logs 的結果欄：IG 等排程、連結只存 */
function clipRegisterResult_(found) {
  var links = found.filter(function (f) { return f.kind === CLIP_LINK; }).length;
  var posts = found.length - links;
  return [posts ? '登記 ' + posts + ' 篇，等排程收齊' : '', links ? links + ' 個只存連結' : ''].filter(String).join('；');
}

/**
 * 一對一聊天、「不屬於任何指令」的訊息（routeLineMessage_ 查不到前綴才會到這裡）。
 * 本人有 feat_clips：IG 貼文一篇寫一列 pending；其他網址（含 Threads／FB／X）只存連結（ADR-021 D-12）；回「收到 ✅」。
 * 沒有網址回 null，交回原本的「看不懂這個指令」。白名單已由 handleLineEvent_ 的 writeGate_ 把關。
 */
function clipLineReply_(text, userId) {
  if (!canUse_(lineUserById_(userId), CLIPS_FEATURE)) return null;
  var found = clipFoundIn_(text);
  if (!found.length) return null;
  try {
    var rowNumber = clipsRegister_(String(userId || '').trim(), text, found);
    logTransaction_(CLIPS_LOG_SOURCE, '成功', text, clipRegisterResult_(found),
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
    // patch 可以是函式：鎖內拿到剛重讀的那列再決定要改什麼（讀後改，不信任鎖外讀到的舊值）
    return clipsWriteRow_(sheet, t.headers, hit, typeof patch === 'function' ? patch(hit.rec) : patch);
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
    // ADR-027：Threads 短網址先轉址取貼文代碼，重複判斷才比得到同一篇。轉不出來算一次失敗（走既有重試）
    if (r.kind === CLIP_THREADS && !String(r.shortcode == null ? '' : r.shortcode).trim()) {
      var res = clipThreadsResolveShare_(String(r.url));
      if (!res.ok) {
        clipsRecordResult_(sheet, r, { ok: false, error: 'Threads 短網址轉不出貼文（' + res.error + '）' }, nowMs);
        return;
      }
      clipsPatch_(sheet, r.id, { url: res.post.url, shortcode: res.post.code });
      r.url = res.post.url;
      r.shortcode = res.post.code;
    }

    var older = t.rows.slice(0, idx).filter(function (o) {
      return !clipDeleted_(o.rec) && String(o.rec.line_id) === String(r.line_id) && clipSameClip_(o.rec, r);
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

/** 同一篇？Threads 兩邊都有貼文代碼就比代碼（同一篇可能有不同網址寫法），其餘比網址（IG 照舊） */
function clipSameClip_(a, b) {
  var ca = String(a.shortcode == null ? '' : a.shortcode), cb = String(b.shortcode == null ? '' : b.shortcode);
  if (a.kind === CLIP_THREADS && b.kind === CLIP_THREADS && ca && cb) return ca === cb;
  return a.url === b.url;
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
  var nowDate = now instanceof Date ? now : new Date();
  var nowMs = nowDate.getTime();
  // ADR-027 D-4（Neil 2026-11-13）：當月 Apify 合計達上限 → IG 與 Threads 都暫停；圖書館設定可「本月強制續抓」
  var gate = clipsCostGate_(nowDate);
  if (gate.paused) { clipsNotePause_(gate); return { processed: 0, reason: 'cost_cap' }; }
  var batch = clipsPick_(sheet, nowMs);
  if (!batch.length) return { processed: 0 };

  var settings = clipsSettings_();
  var cfg = clipApifyConfig_(PropertiesService.getScriptProperties());
  var urlsOf = function (list) { return list.map(function (r) { return r.url; }); };
  var ig = batch.filter(function (r) { return r.kind !== CLIP_THREADS; });
  var th = batch.filter(function (r) { return r.kind === CLIP_THREADS; });
  var apify = cfg.token && ig.length
    ? clipApifyRun_(cfg, urlsOf(ig), { waitSec: CLIPS_APIFY_WAIT_SEC, maxPolls: CLIPS_APIFY_MAX_POLLS })
    : null;
  var apifyTh = cfg.token && th.length ? clipThreadsRun_(cfg.token, urlsOf(th), nowDate) : null;
  var processed = 0;
  batch.forEach(function (rec) {
    if (budgetLeft() < CLIPS_POST_BUDGET_MS) return;          // 留給下一輪；不算一次失敗
    var result;
    try {
      result = clipCollectOne_(rec, rec.kind === CLIP_THREADS ? apifyTh : apify, nowMs, settings);
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
function clipCollectOne_(rec, apify, nowMs, settings) {
  settings = settings || clipsSettings_();
  if (rec.kind === CLIP_THREADS) return clipCollectThreads_(rec, apify, nowMs, settings);
  var apifyErr = clipApifyError_(apify);
  if (apifyErr) return { ok: false, error: apifyErr };
  var item = clipItemFor_({ id: String(rec.shortcode), key: 'ig:' + rec.shortcode }, apify.items);
  if (!item) return { ok: false, error: 'Apify 結果裡找不到這篇（可能是私人帳號、已刪除，或網址打錯）' };

  var info = clipInfo_(item);
  // 要存的圖：貼文＝每一張（輪播裡的影片存封面）；Reels＝封面（影片另存 video.mp4，見下面）
  var media = clipMediaOf_(item);
  // 圖書館設定關掉「IG 存圖片」：一張都不存，也不算失敗（ADR-027）
  var urls = !settings.ig_images ? [] : rec.kind === 'reel'
    ? (function () {
        var cover = media.filter(function (m) { return m.type === 'video'; }).map(function (m) { return m.cover_url; })[0] ||
          String(clipPick_(item, ['displayUrl', 'thumbnailUrl', 'imageUrl']));
        return cover ? [cover] : [];
      })()
    : media.map(function (m) { return m.type === 'video' ? m.cover_url : m.source_url; });
  var out = Object.assign({ ok: false, error: '', media_expected: urls.length, media_saved: 0, drive_folder_id: '', image_ids: '[]', video_saved: '' }, info);
  if (rec.kind !== 'reel' && settings.ig_images && !urls.length) { out.error = 'Apify 沒有回任何圖片'; return out; }

  var folder = clipsFolder_(rec, info.author);
  out.drive_folder_id = folder.getId();
  var old = folder.getFiles();
  while (old.hasNext()) old.next().setTrashed(true);

  var saved = clipSaveImages_(folder, urls);
  var errors = saved.errors;
  var names = saved.names;
  out.media_saved = saved.ids.length;
  out.image_ids = JSON.stringify(saved.ids);

  // Reels 要有 video.mp4 才算 done；太大不算失敗（done＋說明），下載失敗走既有重試。設定關掉「IG 存影片」就不存（ADR-027）
  var video = rec.kind === 'reel' && settings.ig_videos ? clipSaveVideo_(folder, clipVideoUrl_(item)) : null;
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

/**
 * 圖片依序下載存進資料夾：01.jpg、02.jpg…（IG 與 Threads 共用）。只有圖片檔開「知道連結的人可檢視」（E-2）。
 * 「拿到網址」不算「存下來」：要 200、要是圖片、要真的寫進 Drive。回 { ids, names, errors }
 */
function clipSaveImages_(folder, urls) {
  var out = { ids: [], names: [], errors: [] };
  var responses = clipFetchAll_(urls);
  urls.forEach(function (u, i) {
    var n = i + 1;
    var label = '第 ' + n + ' 張';
    if (!u) { out.errors.push(label + '沒有圖片網址'); return; }
    var r = responses[i];
    if (!r || r.status !== 200) { out.errors.push(label + '下載失敗（' + (r ? clipHead_(r) : '沒有回應') + '）'); return; }
    var blob = r.res.getBlob();
    var type = String(blob.getContentType() || '').split(';')[0];
    if (!/^image\//.test(type)) { out.errors.push(label + '回的不是圖片（' + (type || '未知') + '）'); return; }
    var name = (n < 10 ? '0' : '') + n + '.' + (CLIP_EXT[type] || 'jpg');
    try {
      var file = folder.createFile(blob.setName(name));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      out.ids.push(file.getId());
      out.names.push(name);
    } catch (err) {
      out.errors.push(label + '寫入 Drive 失敗（' + String(err && err.message || err) + '）');
    }
  });
  return out;
}

/**
 * 收一篇 Threads（ADR-027 D-1）：主文＋作者自己的接續串文（照 parentCode 排）合併成一篇；別人的留言不存
 * （raw.json 也只放主文與作者串文）。圖片照主文→串文的順序；影片看圖書館設定（預設不存）。
 * 串文被回覆上限截斷、或順序只能照時間排 → done＋「串文可能不完整」（D-6：不用 partial，那會重跑）
 */
function clipCollectThreads_(rec, apify, nowMs, settings) {
  var apifyErr = clipApifyError_(apify);
  if (apifyErr) return { ok: false, error: apifyErr };
  var code = String(rec.shortcode == null ? '' : rec.shortcode);
  var items = apify.items || [];
  var root = items.filter(function (x) { return x && x.recordType === 'post' && String(x.code) === code; })[0];
  if (!root) {
    var st = items.filter(function (x) { return x && x.recordType === 'status' && clipThreadsCodeOf_(x.url) === code; })[0];
    return { ok: false, error: st ? 'Threads 找不到這篇（' + st.status + '）' : 'Apify 結果裡找不到這篇（可能是私人帳號、已刪除，或網址打錯）' };
  }
  var replies = items.filter(function (x) { return x && x.recordType === 'reply' && String(x.rootPostCode) === code; });
  var chain = clipThreadsAuthorChain_(code, replies);
  var per = (apify.summary || []).filter(function (p) { return clipThreadsCodeOf_(p && p.url) === code; })[0];
  var incomplete = chain.method === 'time' || !!(per && per.capped && !per.exhausted);
  var info = { author: String(root.authorUsername || ''), posted_at: String(root.timestamp || ''), caption: clipThreadsMerge_(root, chain.rows) };
  var own = [root].concat(chain.rows);
  var urls = [];
  var videos = [];
  own.forEach(function (x) {
    if (settings.threads_images) urls = urls.concat(clipThreadsMedia_(x, 'images'));
    if (settings.threads_videos) videos = videos.concat(clipThreadsMedia_(x, 'videos'));
  });
  var out = Object.assign({ ok: false, error: '', media_expected: urls.length, media_saved: 0, drive_folder_id: '', image_ids: '[]', video_saved: '' }, info);

  var folder = clipsFolder_(rec, info.author);
  out.drive_folder_id = folder.getId();
  var old = folder.getFiles();
  while (old.hasNext()) old.next().setTrashed(true);

  var saved = clipSaveImages_(folder, urls);
  var errors = saved.errors;
  out.media_saved = saved.ids.length;
  out.image_ids = JSON.stringify(saved.ids);
  var notes = incomplete ? [CLIP_THREAD_INCOMPLETE_NOTE] : [];
  var vids = videos.map(function (u, i) { return clipSaveVideo_(folder, u, i === 0 ? 'video.mp4' : 'video_' + (i < 9 ? '0' : '') + (i + 1) + '.mp4'); });
  vids.forEach(function (v) { if (v.state === 'failed') errors.push(v.error); });
  if (vids.some(function (v) { return v.state === 'too_big'; })) notes.push(CLIP_VIDEO_TOO_BIG_NOTE);
  if (vids.length && vids.every(function (v) { return v.state === 'saved'; })) out.video_saved = 'TRUE';

  var rawOk = false;
  try {
    folder.createFile(Utilities.newBlob(JSON.stringify({ post: root, author_thread: chain.rows }, null, 2), 'application/json', 'raw.json'));
    rawOk = true;
  } catch (err) { errors.push('raw.json 寫入失敗（' + String(err && err.message || err) + '）'); }
  try {
    var md = Object.assign(clipMdInput_(rec, info, saved.names, '', null), { platform: 'Threads', thread: chain.rows.length, incomplete: incomplete });
    folder.createFile(clipContentBlob_(clipContentMd_(md)));
  } catch (err) { errors.push('content.md 寫入失敗（' + String(err && err.message || err) + '）'); }

  out.ok = rawOk && !errors.length && out.media_saved === out.media_expected;
  out.error = errors.length ? errors.join('；') : notes.join('；');
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
function clipSaveVideo_(folder, url, name) {
  if (!url) return { state: 'failed', error: '影片下載失敗（Apify 沒有回影片網址）' };
  var r = clipFetch_(url);
  if (r.error && CLIP_VIDEO_TOO_BIG.test(r.error)) return { state: 'too_big' };
  if (r.status !== 200) return { state: 'failed', error: '影片下載失敗（' + clipHead_(r) + '）' };
  try {
    folder.createFile(r.res.getBlob().setName(name || 'video.mp4'));
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

/** 這個網址算哪一個 API（ADR-022）：Apify 平台、Jina Reader，其餘是下載網頁／影片／圖片 */
function clipApiId_(url) {
  var u = String(url || '');
  if (u.indexOf(CLIP_APIFY_BASE) === 0) return 'apify';
  if (typeof CLIP_JINA_BASE !== 'undefined' && u.indexOf(CLIP_JINA_BASE) === 0) return 'jina';   // 在 lab-clip.gs
  return 'web';
}

/** 圖片並行下載（callApiAll_）；整批丟例外（例如網路層）就全部當失敗，回傳形狀跟 clipFetch_ 一樣 */
function clipFetchAll_(urls) {
  var reqs = [];
  var at = [];
  urls.forEach(function (u, i) { if (u) { reqs.push({ url: u, muteHttpExceptions: true }); at.push(i); } });
  var out = urls.map(function () { return null; });
  if (!reqs.length) return out;
  try {
    callApiAll_('web', reqs).forEach(function (res, k) { out[at[k]] = { status: res.getResponseCode(), res: res }; });
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
  if (r.kind === CLIP_THREADS) {
    return '貼文' + (r.thread ? '（含作者串文 ' + r.thread + ' 則）' : '') + (r.incomplete ? '，' + CLIP_THREAD_INCOMPLETE_NOTE : '');
  }
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
    '平台: ' + (r.platform || 'Instagram'),
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
 * action=clipRetry｜clipDelete｜clipRead。clipRead＝開閱讀頁（ADR-025 D-2）：未讀 → reading，閱讀中／已讀不動；
 * last_read_at 照舊每次更新。狀態在鎖內依剛重讀的列決定，不用前端傳來的舊值。只限擁有者；不是擁有者回 { error: 'forbidden', permanent: true }——
 * 這是永久性拒絕，前端收到不重送（ADR-018 實作差異 A-2 的教訓，ADR-019 B-5 同一套）。
 * 重跑：→ pending、attempts=0、清 next_try_at；刪除：del（Drive 不動）
 */
function clipPwaAction_(caller, action, id) {
  var own = clipOwnRow_(caller, action, id);
  if (own.error) return own;
  var sheet = own.sheet, rec = own.rec;
  var patch = action === 'clipDelete' ? { del: 'TRUE' }
    : action === 'clipRead' ? function (cur) {
      var p = { last_read_at: new Date().toISOString() };
      if (!String(cur.read_status == null ? '' : cur.read_status).trim()) p.read_status = 'reading';
      return p;
    }
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
 * action=clipReadState { id, state }（ADR-025 D-6）：手動設閱讀狀態，點一下就存。只限擁有者（clipOwnRow_）；
 * state 不在 CLIP_READ_STATES → 永久拒絕；拿不到鎖 → busy（可重試）。跟 clipRead 一樣不寫 logs（避免灌大）
 */
function clipReadStateSet_(caller, id, state) {
  var own = clipOwnRow_(caller, 'clipReadState', id);
  if (own.error) return own;
  var missing = clipColsMissing_(own.headers, ['read_status']);
  if (missing) return missing;
  var st = typeof state === 'string' ? state.trim() : null;
  if (st === null || CLIP_READ_STATES.indexOf(st) === -1) return { error: 'invalid_state', permanent: true };
  try {
    clipsPatch_(own.sheet, id, { read_status: st });
  } catch (err) {
    return { error: 'busy' };
  }
  return { success: true, state: st };
}

/** 擁有者才能動的那一列 → { sheet, headers, rec }；不是就回永久拒絕（clipPwaAction_、筆記、AI 共用） */
function clipOwnRow_(caller, action, id) {
  if (!canUse_(caller.user, CLIPS_FEATURE)) return { error: 'forbidden', permanent: true, reason: 'feature' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  if (!sheet || !id) return { error: 'not_found', permanent: true };
  var t = clipsTable_(sheet);
  var rec = t.rows.map(function (x) { return x.rec; }).filter(function (r) { return String(r.id) === String(id); })[0];
  if (!rec || clipDeleted_(rec)) return { error: 'not_found', permanent: true };
  if (String(rec.line_id).trim() !== String(caller.line_id).trim()) {
    logTransaction_(CLIPS_LOG_SOURCE, '失敗', action + ' ' + id, '不是擁有者，拒絕', '', '', caller.line_id);
    return { error: 'forbidden', permanent: true, reason: 'not_owner' };
  }
  return { sheet: sheet, headers: t.headers, rec: rec };
}

/* -------------------------------------------------------------------------- */
/* 圖片辨識的共用零件（ADR-024；探針 lab-clip.gs 的 probeClipOcr 與 📝 文字辨識同一份）     */
/* -------------------------------------------------------------------------- */

/*
 * 📝 文字辨識（D-5）：Drive API 把圖片複製成 Google 文件，Google 會順手做 OCR；export 成純文字讀出來，
 * 暫存文件**永久刪除**（丟垃圾桶會一直佔空間）。三步都走 callApi_('drive_ocr')：Drive API 不收費，只記次數。
 * 不用 DocumentApp 讀文件：那會多要一個「Google 文件」授權範圍（要重新授權）；export 只用現有 DriveApp 那一把
 */
var CLIP_DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files/';
var CLIP_OCR_LANG = 'zh-TW';
var CLIP_OCR_NO_TEXT = '（無文字）';
/** 收藏資料夾裡的圖片檔名（01.jpg…）；raw.json、content.md、video.mp4 都不是 */
var CLIP_IMAGE_NAME_RE = /^\d{2,}\.(jpe?g|png|webp|heic|gif)$/i;

/** 現在這支指令碼的 OAuth token（DriveApp 已授權的範圍）。獨立成函式，測試才換得掉 */
function clipOcrToken_() {
  return ScriptApp.getOAuthToken();
}

/**
 * 這篇要辨識的圖 → [{ id, name, mime }]，依檔名排序。image_ids 有就用（排程存的順序）；
 * 沒有就從 drive_folder_id 列 NN.ext。被刪掉、讀不到的那張略過（不讓整篇失敗）。Reels 只存了封面，自然只有一張（D-7）
 */
function clipImageList_(rec) {
  var ids = [];
  try { ids = JSON.parse(String(rec.image_ids || '[]')); } catch (err) { ids = []; }
  var out = [];
  if (Array.isArray(ids) && ids.length) {
    ids.forEach(function (id) {
      try {
        var f = DriveApp.getFileById(String(id));
        out.push({ id: String(id), name: String(f.getName()), mime: String(f.getMimeType() || '') });
      } catch (err) { console.log('收藏圖片讀不到（略過）：' + id + '｜' + (err && err.message || err)); }
    });
  } else if (rec.drive_folder_id) {
    try {
      var it = DriveApp.getFolderById(String(rec.drive_folder_id)).getFiles();
      while (it.hasNext()) {
        var g = it.next();
        var name = String(g.getName());
        if (CLIP_IMAGE_NAME_RE.test(name)) out.push({ id: String(g.getId()), name: name, mime: String(g.getMimeType() || '') });
      }
    } catch (err) { console.log('收藏資料夾讀不到：' + rec.drive_folder_id + '｜' + (err && err.message || err)); }
  }
  out = out.filter(function (x) { return !x.mime || /^image\//.test(x.mime); });
  return out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
}

/**
 * 一張圖 → { ok, text, ms, error, cleaned, leftover }。讀不到字＝ok＋「（無文字）」。
 * 暫存文件不論成功失敗都刪（finally）；刪不掉 cleaned=false＋leftover（暫存文件 id），呼叫端要講出來
 */
function clipOcrImage_(fileId, token) {
  var t0 = Date.now();
  var auth = { Authorization: 'Bearer ' + token };
  var out = { ok: false, text: '', ms: 0, error: '', cleaned: true, leftover: '' };
  var docId = '';
  try {
    var c = callApi_('drive_ocr', CLIP_DRIVE_FILES_API + encodeURIComponent(fileId) + '/copy?ocrLanguage=' + CLIP_OCR_LANG + '&fields=id', {
      method: 'post', contentType: 'application/json', headers: auth, muteHttpExceptions: true,
      payload: JSON.stringify({ mimeType: 'application/vnd.google-apps.document', name: 'tmp_ocr_' + fileId + '_' + t0 })
    });
    if (c.getResponseCode() !== 200) { out.error = 'HTTP ' + c.getResponseCode() + '（轉文件）' + clipApiBrief_(c); return out; }
    docId = String((JSON.parse(c.getContentText()) || {}).id || '');
    if (!docId) { out.error = '轉文件沒有回 id'; return out; }
    var x = callApi_('drive_ocr', CLIP_DRIVE_FILES_API + encodeURIComponent(docId) + '/export?mimeType=' + encodeURIComponent('text/plain'),
      { method: 'get', headers: auth, muteHttpExceptions: true });
    if (x.getResponseCode() !== 200) { out.error = 'HTTP ' + x.getResponseCode() + '（讀文字）' + clipApiBrief_(x); return out; }
    // 匯出的純文字裡，圖片的位置會變成一行 ________________（PR-0 實測每張開頭都有），不是圖上的字
    var text = String(x.getContentText() || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
      .replace(/^[ \t]*_{8,}[ \t]*$/gm, '').trim();
    out.ok = true;
    out.text = text || CLIP_OCR_NO_TEXT;
    return out;
  } catch (err) {
    out.error = String(err && err.message || err);
    return out;
  } finally {
    if (docId) {
      try {
        var d = callApi_('drive_ocr', CLIP_DRIVE_FILES_API + encodeURIComponent(docId), { method: 'delete', headers: auth, muteHttpExceptions: true });
        var dc = d.getResponseCode();
        if (dc !== 204 && dc !== 200 && dc !== 404) { out.cleaned = false; out.leftover = docId; }
      } catch (err) { out.cleaned = false; out.leftover = docId; }
    }
    out.ms = Date.now() - t0;
  }
}

/**
 * GAS 一次最多跑 6 分鐘：一張約幾秒（PR-0 探針實測回填），留 2 分鐘給讀表、寫回。
 * 時間到就停在那張，已辨識的照存，結果末尾講明幾張沒跑（再按一次從頭重跑）
 */
var CLIP_OCR_BUDGET_MS = 240000;
/** 一格 Sheet 最多 5 萬字；留餘裕給其他欄 */
var CLIP_OCR_OUTPUT_MAX = 40000;

/** 每張一段：「## 01.jpg」換行接文字；失敗那張寫原因；沒跑完的講明。純函式 */
function clipOcrFormat_(results, skipped) {
  var parts = results.map(function (r) {
    return '## ' + r.name + '\n' + (r.ok ? String(r.text || CLIP_OCR_NO_TEXT) : '（辨識失敗：' + String(r.error || '原因不明') + '）');
  });
  if (skipped > 0) parts.push('（時間不夠，後面 ' + skipped + ' 張沒有辨識，再按一次會從頭重跑）');
  var out = parts.join('\n\n');
  return out.length > CLIP_OCR_OUTPUT_MAX ? out.slice(0, CLIP_OCR_OUTPUT_MAX) + '\n\n（太長，後面截掉了）' : out;
}

/**
 * 一篇的圖逐張辨識（手動 📝 與排程共用）。budgetMs：從第二張起，超過就停在那張（已辨識的照算）。
 * 回 { images, results, leftovers, ms, ok, skipped }；不寫表、不寫 logs（呼叫端決定）
 */
function clipOcrRun_(images, budgetMs) {
  var token = clipOcrToken_();
  var t0 = Date.now();
  var results = [];
  var leftovers = [];
  for (var i = 0; i < images.length; i++) {
    if (i > 0 && Date.now() - t0 > budgetMs) break;
    var r = clipOcrImage_(images[i].id, token);
    if (!r.cleaned) leftovers.push(r.leftover);
    results.push({ name: images[i].name, ok: r.ok, text: r.text, error: r.error });
  }
  return {
    results: results, leftovers: leftovers, ms: Date.now() - t0,
    ok: results.filter(function (x) { return x.ok; }).length,
    skipped: images.length - results.length
  };
}

/** logs 的 detail：幾張、成功幾張、耗時、殘留的暫存文件、網址 */
function clipOcrDetail_(run, total, rec) {
  return run.results.length + '／' + total + ' 張｜成功 ' + run.ok + '｜' + run.ms + ' ms' +
    (run.leftovers.length ? '｜⚠️ 暫存文件殘留（到 Drive 搜 tmp_ocr_ 手動刪）：' + run.leftovers.join('、') : '') + '｜' + String(rec.url || '');
}

/**
 * action=clipOcr（ADR-024 D-1、D-5）：📝 文字辨識，按了才跑、一次一篇。比照 clipAi_：只限擁有者、缺欄 not_ready、
 * 結果另存 ocr_output／ocr_at（不動原文、筆記、AI 整理）、一篇留最新一份。
 * 單張失敗不讓整篇失敗；**全部失敗才算失敗**，那時不寫、舊結果留著。
 * discard＝捨棄（不打 API）：清掉 ocr_output，ocr_at 記捨棄的時間——排程看到 ocr_at 有值就不會再自動辨識回來
 */
function clipOcr_(caller, id, discard) {
  var own = clipOwnRow_(caller, discard ? 'clipOcrDiscard' : 'clipOcr', id);
  if (own.error) return own;
  var missing = clipColsMissing_(own.headers, ['ocr_output', 'ocr_at']);
  if (missing) return missing;
  var rec = own.rec;
  if (discard) {
    try { clipsPatch_(own.sheet, id, { ocr_output: '', ocr_at: new Date().toISOString() }); } catch (err) { return { error: 'busy' }; }
    logTransaction_(CLIPS_LOG_SOURCE, '成功', 'clipOcr ' + id, '捨棄文字辨識', String(rec.url || ''), '', caller.line_id);
    return { success: true };
  }
  var images = rec.kind === CLIP_LINK ? [] : clipImageList_(rec);
  if (!images.length) return { error: 'no_images', permanent: true };

  var run = clipOcrRun_(images, CLIP_OCR_BUDGET_MS);
  var detail = clipOcrDetail_(run, images.length, rec);
  if (!run.ok) {
    var reason = run.results.length ? String(run.results[0].error || '原因不明') : '原因不明';
    logTransaction_(CLIPS_LOG_SOURCE, '失敗', 'clipOcr ' + id, '文字辨識失敗：' + reason, detail, '', caller.line_id);
    return { error: 'ocr_failed', reason: reason };
  }
  var text = clipOcrFormat_(run.results, run.skipped);
  var at = new Date().toISOString();
  try {
    clipsPatch_(own.sheet, id, { ocr_output: text, ocr_at: at });
  } catch (err) {
    return { error: 'busy' };
  }
  var failed = run.results.length - run.ok;
  logTransaction_(CLIPS_LOG_SOURCE, '成功', 'clipOcr ' + id, '文字辨識' + (failed ? '（' + failed + ' 張失敗）' : '') +
    (run.skipped ? '（' + run.skipped + ' 張沒跑完）' : ''), detail, '', caller.line_id);
  return { success: true, ocr_output: text, ocr_at: at, failed: failed, skipped: run.skipped };
}

/* -------------------------------------------------------------------------- */
/* 📝 文字辨識・排程自動跑（Neil 2026-11-12：圖書館預設排程跑 Drive 文字辨識）              */
/* -------------------------------------------------------------------------- */

/*
 * 收齊的篇（done／partial、有圖、沒刪）而且 ocr_at 空白＝從沒辨識過、也沒被捨棄過 → 排程替你按 📝。
 *  - 新收的先跑（表的下面＝新的）；一次最多 CLIP_OCR_AUTO_PER_RUN 篇；這一輪剩的時間不夠一篇就留給下一輪
 *  - ocr_at 有值就不碰：手動跑過的、捨棄過的（捨棄會記 ocr_at）都不會被排程蓋掉或辨識回來
 *  - 寫回在鎖內再看一次 ocr_at：辨識途中你剛好手動按了或捨棄，以你的為準
 *  - 整篇失敗不寫、記一次失敗；同一篇失敗 CLIP_OCR_AUTO_MAX_FAILS 次就不再自動試（App 裡照樣可以手動按）
 *  - Drive API 不收費，只記次數（callApi_('drive_ocr')）；不呼叫 AI
 */
var CLIP_OCR_AUTO_PER_RUN = 3;
var CLIP_OCR_AUTO_MINUTES = 10;
var CLIP_OCR_AUTO_MIN_BUDGET_MS = 60000;      // 這一輪剩不到 1 分鐘：不開新的一篇
var CLIP_OCR_AUTO_RESERVE_MS = 30000;         // 一篇的辨識時間＝剩餘預算扣 30 秒（留給寫回、logs）
var CLIP_OCR_AUTO_MAX_FAILS = 3;
var CLIP_OCR_AUTO_FAILS_KEY = 'clip_ocr_auto_fails';
var CLIP_OCR_AUTO_INPUT = 'clipOcr（排程）';

function clipOcrAutoFails_() {
  var m = null;
  try { m = JSON.parse(PropertiesService.getScriptProperties().getProperty(CLIP_OCR_AUTO_FAILS_KEY) || 'null'); } catch (err) { m = null; }
  return m && typeof m === 'object' ? m : {};
}

function clipOcrAutoSaveFails_(m) {
  try { PropertiesService.getScriptProperties().setProperty(CLIP_OCR_AUTO_FAILS_KEY, JSON.stringify(m)); }
  catch (err) { console.log('存不了自動文字辨識的失敗次數：' + err); }
}

/** 這篇該不該由排程自動辨識。純函式（不看 Drive）：沒圖的在 clipImageList_ 那一步才知道 */
function clipOcrAutoWanted_(rec, fails) {
  if (!rec || !String(rec.id || '').trim() || clipDeleted_(rec)) return false;
  if (rec.kind === CLIP_LINK) return false;
  var st = String(rec.status || '').trim();
  if (st !== 'done' && st !== 'partial') return false;
  if (String(rec.ocr_output == null ? '' : rec.ocr_output).trim()) return false;
  if (String(rec.ocr_at == null ? '' : rec.ocr_at).trim()) return false;
  if ((fails[String(rec.id)] || 0) >= CLIP_OCR_AUTO_MAX_FAILS) return false;
  var ids = [];
  try { ids = JSON.parse(String(rec.image_ids || '[]')); } catch (err) { ids = []; }
  return (Array.isArray(ids) && ids.length > 0) || !!String(rec.drive_folder_id || '').trim();
}

/** 排程總管每 CLIP_OCR_AUTO_MINUTES 分鐘叫一次。回 { processed, ok, failed, skipped } */
function runClipOcrJob_(now, ctx) {
  var started = Date.now();
  var budgetLeft = (ctx && ctx.budgetLeft) || function () { return Infinity; };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { processed: 0 };
  var t = clipsTable_(sheet);
  if (clipColsMissing_(t.headers, ['ocr_output', 'ocr_at'])) return { processed: 0, reason: 'not_ready' };
  var fails = clipOcrAutoFails_();
  var queue = t.rows.map(function (x) { return x.rec; })
    .filter(function (r) { return clipOcrAutoWanted_(r, fails); })
    .reverse()                                              // 新收的先跑
    .slice(0, CLIP_OCR_AUTO_PER_RUN);
  var out = { processed: 0, ok: 0, failed: 0, skipped: 0 };
  var failsChanged = false;

  queue.forEach(function (rec) {
    var left = budgetLeft();
    if (left < CLIP_OCR_AUTO_MIN_BUDGET_MS) { out.skipped++; return; }
    var id = String(rec.id);
    out.processed++;
    var images = clipImageList_(rec);
    var run = images.length ? clipOcrRun_(images, Math.min(CLIP_OCR_BUDGET_MS, left - CLIP_OCR_AUTO_RESERVE_MS)) : null;
    if (!run || !run.ok) {
      var reason = !run ? '找不到圖片' : String((run.results[0] || {}).error || '原因不明');
      fails[id] = (fails[id] || 0) + 1;
      failsChanged = true;
      out.failed++;
      logTransaction_(CLIPS_LOG_SOURCE, '失敗', CLIP_OCR_AUTO_INPUT + ' ' + id, '自動文字辨識失敗（第 ' + fails[id] + ' 次）：' + reason,
        (run ? clipOcrDetail_(run, images.length, rec) : String(rec.url || '')) +
        (fails[id] >= CLIP_OCR_AUTO_MAX_FAILS ? '｜不再自動重試，要的話到 App 按 📝' : ''), '', String(rec.line_id || ''));
      return;
    }
    var text = clipOcrFormat_(run.results, run.skipped);
    var at = new Date().toISOString();
    var wrote = false;
    try {
      clipsPatch_(sheet, id, function (cur) {
        // 鎖內重看：辨識途中被手動跑過、捨棄、刪掉，以那個為準
        if (clipDeleted_(cur) || String(cur.ocr_at == null ? '' : cur.ocr_at).trim() || String(cur.ocr_output == null ? '' : cur.ocr_output).trim()) return {};
        wrote = true;
        return { ocr_output: text, ocr_at: at };
      });
    } catch (err) {
      out.failed++;
      logTransaction_(CLIPS_LOG_SOURCE, '失敗', CLIP_OCR_AUTO_INPUT + ' ' + id, '自動文字辨識寫不回去（clips 忙碌），下次再試', String(rec.url || ''), '', String(rec.line_id || ''));
      return;
    }
    if (fails[id]) { delete fails[id]; failsChanged = true; }
    if (!wrote) return;
    out.ok++;
    var failed = run.results.length - run.ok;
    logTransaction_(CLIPS_LOG_SOURCE, '成功', CLIP_OCR_AUTO_INPUT + ' ' + id, '自動文字辨識' + (failed ? '（' + failed + ' 張失敗）' : '') +
      (run.skipped ? '（' + run.skipped + ' 張沒跑完）' : ''), clipOcrDetail_(run, images.length, rec), '', String(rec.line_id || ''));
  });

  if (failsChanged) clipOcrAutoSaveFails_(fails);
  if (out.processed) recordSchedulePerf_('clipsOcr', out.processed, Date.now() - started);
  return out;
}

/** 🤖 AI 辨識（D-6）：單篇最多送幾張；三家都收的圖片格式（HEIC 只有 Gemini 收，一律略過講明）；單張上限（Claude 5MB，留餘裕） */
var CLIP_VISION_MAX = 10;
var CLIP_VISION_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
var CLIP_VISION_MAX_BYTES = 4500000;

/** 給 AI 看圖的提示詞：逐張、照順序、只講看得到的。純函式 */
function clipVisionPrompt_(names) {
  return [
    '你是我的圖片閱讀助手。依序附上一篇收藏的 ' + names.length + ' 張圖片：' + names.join('、') + '。',
    '用繁體中文逐張整理，每張用「## 檔名」開頭：',
    '1. 寫出圖上的文字（照原樣、依閱讀順序）；2. 再用一兩句說這張的重點。',
    '表格逐列轉成文字；圖表講出重點與數字；沒有文字的圖簡短描述內容。',
    '規則：只描述看得到的，不要推測、不要編造；看不清楚就寫「（看不清楚）」；不要開場白、不要結語。'
  ].join('\n');
}

/**
 * action=clipVision（ADR-024 D-1、D-6）：🤖 AI 辨識，按了才跑、一次一篇、會花錢。用目前選定的那一家（callAiVision_），
 * 失敗不換家。最多送 CLIP_VISION_MAX 張（超過取前面的、結果末尾註明）；格式不支援或太大的略過並註明。
 * 結果另存 vision_output／vision_provider／vision_at；失敗不寫半份、舊的留著。discard＝捨棄（清三欄，不呼叫 AI）
 */
function clipVision_(caller, id, discard) {
  var own = clipOwnRow_(caller, discard ? 'clipVisionDiscard' : 'clipVision', id);
  if (own.error) return own;
  var missing = clipColsMissing_(own.headers, ['vision_output', 'vision_provider', 'vision_at']);
  if (missing) return missing;
  var rec = own.rec;
  if (discard) {
    try { clipsPatch_(own.sheet, id, { vision_output: '', vision_provider: '', vision_at: '' }); } catch (err) { return { error: 'busy' }; }
    logTransaction_(CLIPS_LOG_SOURCE, '成功', 'clipVision ' + id, '捨棄 AI 辨識', String(rec.url || ''), '', caller.line_id);
    return { success: true };
  }
  var all = rec.kind === CLIP_LINK ? [] : clipImageList_(rec);
  var notes = [];
  var usable = [];
  all.forEach(function (img) {
    if (CLIP_VISION_MIMES.indexOf(String(img.mime).toLowerCase()) === -1) { notes.push(img.name + ' 格式不支援（' + (img.mime || '未知') + '），沒有送'); return; }
    usable.push(img);
  });
  var picked = usable.slice(0, CLIP_VISION_MAX);
  var images = [];
  picked.forEach(function (img) {
    try {
      var bytes = DriveApp.getFileById(img.id).getBlob().getBytes();
      if (bytes.length > CLIP_VISION_MAX_BYTES) { notes.push(img.name + ' 太大，沒有送'); return; }
      images.push({ mime: String(img.mime).toLowerCase(), base64: Utilities.base64Encode(bytes), name: img.name });
    } catch (err) { notes.push(img.name + ' 讀不到（' + String(err && err.message || err) + '）'); }
  });
  if (!images.length) return { error: 'no_images', permanent: true };
  if (usable.length > CLIP_VISION_MAX) notes.unshift('只看了前 ' + CLIP_VISION_MAX + ' 張（共 ' + usable.length + ' 張）');

  var res = callAiVision_(clipVisionPrompt_(images.map(function (x) { return x.name; })), images, 'clip_vision');
  var who = 'provider=' + res.provider + '｜model=' + res.model + '｜' + images.length + ' 張';
  if (!res.ok) {
    logTransaction_(CLIPS_LOG_SOURCE, '失敗', 'clipVision ' + id, 'AI 辨識失敗：' + (res.reason === 'no_key' ? res.missingKey + ' 未設定' : res.reason),
      who + '｜' + (res.detail || ''), '', caller.line_id);
    return { error: res.reason === 'no_key' ? 'no_key' : 'ai_failed', reason: res.reason, label: res.label, missingKey: res.missingKey };
  }
  var text = String(res.text || '') + (notes.length ? '\n\n（' + notes.join('；') + '）' : '');
  var at = new Date().toISOString();
  try {
    clipsPatch_(own.sheet, id, { vision_output: text, vision_provider: res.label, vision_at: at });
  } catch (err) {
    return { error: 'busy' };
  }
  logTransaction_(CLIPS_LOG_SOURCE, '成功', 'clipVision ' + id, 'AI 辨識' + (res.truncated ? '（被截斷）' : ''),
    who + '｜' + String(rec.url || ''), '', caller.line_id);
  return { success: true, vision_output: text, vision_provider: res.label, vision_at: at, truncated: !!res.truncated };
}

/** 錯誤回應的一小段（給 log 與結果看；不含 token——token 只在 header） */
function clipApiBrief_(res) {
  try {
    var body = String(res.getContentText() || '');
    var j = null;
    try { j = JSON.parse(body); } catch (e) { j = null; }
    var msg = j && j.error ? String(j.error.message || j.error.status || '') : body;
    return msg ? '：' + msg.slice(0, 120) : '';
  } catch (err) { return ''; }
}

/* -------------------------------------------------------------------------- */
/* 圖書館分類（ADR-023 D-7、D-8）                                                 */
/* -------------------------------------------------------------------------- */

var CLIP_CATEGORIES_HEADERS = ['name', 'icon', 'sort', 'is_active'];
/** 初始清單（D-8）。現有收藏不自動補分類，讀到再歸 */
var CLIP_CATEGORY_SEED = [['AI 提示詞', '🤖', 10], ['Claude／開發工具', '🛠', 20], ['副業與內容經營', '💼', 30],
                          ['成長與心態', '🌱', 40], ['投資', '📈', 50], ['吃喝玩樂', '🍜', 60]];

/**
 * 分類清單 [{ name, icon, sort, active }]，依 sort 排。停用的也回（已歸類的篇要照樣顯示原名），
 * 前端的按鈕只列 active。名稱空白的列不算；同名只取第一列
 */
function clipCategories_(ss) {
  var read = sheetRecords_(ss || SpreadsheetApp.getActiveSpreadsheet(), CLIP_CATEGORIES_SHEET, {});
  if (read.error) return [];
  var seen = {}, out = [];
  read.rows.forEach(function (r) {
    var name = String(r.name == null ? '' : r.name).trim();
    if (!name || seen[name]) return;
    seen[name] = true;
    var active = String(r.is_active == null ? '' : r.is_active).trim();
    out.push({ name: name, icon: String(r.icon == null ? '' : r.icon).trim(), sort: Number(r.sort) || 0,
               active: active === '' || truthy_(active) });
  });
  return out.sort(function (a, b) { return a.sort - b.sort; });
}

/**
 * action=clipCategory { id, category }（D-7）：單選，點一下就存；category='' 清掉（回未分類）。
 * 只限擁有者（clipOwnRow_）；只收啟用中的分類，其他一律永久拒絕（不讓人夾帶任意字串進表）。
 * 寫入走 clipsPatch_（同一把 script lock）
 */
function clipCategorySet_(caller, id, category) {
  var own = clipOwnRow_(caller, 'clipCategory', id);
  if (own.error) return own;
  var missing = clipColsMissing_(own.headers, ['category']);
  if (missing) return missing;
  var name = String(category == null ? '' : category).trim();
  if (name && !clipCategories_().some(function (c) { return c.active && c.name === name; })) {
    return { error: 'invalid_category', permanent: true };
  }
  try {
    clipsPatch_(own.sheet, id, { category: name });
  } catch (err) {
    return { error: 'busy' };
  }
  return { success: true, category: name };
}

/** 「初始化」：沒有就建表寫初始 6 個分類；已有就一格都不動（Neil 改過的、停用的都留著） */
function installClipCategories_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CLIP_CATEGORIES_SHEET);
  if (sheet && sheet.getLastRow() > 0) {
    var r = ensureColumnsOnSheet_(sheet, CLIP_CATEGORIES_HEADERS);
    return { level: r.reason ? 'warn' : 'ok', changed: (r.added || []).length > 0,
             text: CLIP_CATEGORIES_SHEET + ' 已存在（' + Math.max(sheet.getLastRow() - 1, 0) + ' 個分類）' +
               ((r.added || []).length ? '，補上：' + r.added.join('、') : '') };
  }
  if (!sheet) sheet = ss.insertSheet(CLIP_CATEGORIES_SHEET);
  var rows = [CLIP_CATEGORIES_HEADERS].concat(CLIP_CATEGORY_SEED.map(function (c) { return [c[0], c[1], c[2], 'TRUE']; }));
  sheet.getRange(1, 1, rows.length, CLIP_CATEGORIES_HEADERS.length).setValues(rows);
  return { level: 'ok', changed: true, text: '新建 ' + CLIP_CATEGORIES_SHEET + '（初始 ' + CLIP_CATEGORY_SEED.length + ' 個分類，可在 Sheet 上改名、排序、停用）' };
}

/** 「初始化」還沒補欄時，寫進去的欄位會被 clipsWriteRow_ 默默略過——先擋下講明（可重試：補完欄就好） */
function clipColsMissing_(headers, cols) {
  return cols.some(function (c) { return headers.indexOf(c) === -1; }) ? { error: 'not_ready' } : null;
}

/**
 * 筆記（ADR-021 D-10、EXP-03）：一篇一份，帶著手上的 revision 來存；鎖內重讀比對，不一致就拒絕並回新版
 * （前端顯示新版、使用者打的字留在框裡）。衝突不是永久拒絕：拿新版的 revision 再存就會過
 */
function clipNote_(caller, id, note, revision) {
  var own = clipOwnRow_(caller, 'clipNote', id);
  if (own.error) return own;
  var missing = clipColsMissing_(own.headers, ['note', 'note_revision', 'note_updated_at']);
  if (missing) return missing;
  var text = String(note == null ? '' : note);
  if (text.length > CLIP_NOTE_MAX) return { error: 'too_long', permanent: true, max: CLIP_NOTE_MAX };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { error: 'busy' };
  try {
    var t = clipsTable_(own.sheet);
    var hit = t.rows.filter(function (x) { return String(x.rec.id) === String(id); })[0];
    if (!hit || clipDeleted_(hit.rec)) return { error: 'not_found', permanent: true };
    var cur = Number(hit.rec.note_revision) || 0;
    if (Number(revision) !== cur) {
      logTransaction_(CLIPS_LOG_SOURCE, '失敗', 'clipNote ' + id, '筆記衝突：另一台已更新',
        '手上 ' + revision + '｜雲端 ' + cur, '', caller.line_id);
      return { error: 'conflict', note: String(hit.rec.note == null ? '' : hit.rec.note), revision: cur,
        note_updated_at: String(hit.rec.note_updated_at || '') };
    }
    var at = new Date().toISOString();
    clipsWriteRow_(own.sheet, t.headers, hit, { note: text, note_revision: cur + 1, note_updated_at: at });
    return { success: true, revision: cur + 1, note_updated_at: at };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 給 AI 的提示詞（D-11）：只送文字。原文後面依序接兩個圖片辨識結果（ADR-024 D-3，有就放、沒有就省略）。
 * 規則跟著變：兩個都沒有 → 要它標「圖片內容未辨識」、不編造；有任一個 → 圖片只能依辨識結果。
 * 總長仍受 CLIP_AI_INPUT_MAX 限制，截斷順序：原文優先、其次 AI 辨識、最後文字辨識（筆記另計）。
 * 只存連結的那篇沒有原文，講明只能讀筆記。純函式
 */
function clipAiPrompt_(rec) {
  var left = CLIP_AI_INPUT_MAX;
  var take = function (v) { var t = String(v || '').trim().slice(0, Math.max(0, left)); left -= t.length; return t; };
  var body = String(rec.caption || '').slice(0, left);
  left -= body.length;
  var vision = take(rec.vision_output);
  var ocr = take(rec.ocr_output);
  var note = String(rec.note || '').slice(0, CLIP_NOTE_MAX);
  var lines = [
    '你是我的閱讀整理助手。用繁體中文整理下面這篇收藏：',
    '1. 先列 3～5 點重點；2. 再列出我的筆記裡的想法或待辦（沒有就略過）。',
    ocr || vision
      ? '規則：只根據下面提供的文字，不要編造；原文附的圖片你沒有直接看到，圖片只依下面的辨識結果、不要編造辨識結果以外的內容；不要開場白。'
      : '規則：只根據下面提供的文字，不要編造；原文附的圖片沒有提供給你，內容提到圖片時標註「（圖片內容未辨識）」；不要開場白。'
  ];
  if (rec.kind === CLIP_LINK) lines.push('這篇只存了連結（' + String(rec.url || '') + '），沒有抓原文，只能根據我的筆記整理。');
  else lines.push('', '【原文】', body || '（沒有內文）');
  if (ocr) lines.push('', '【圖片文字（文字辨識）】', ocr);
  if (vision) lines.push('', '【圖片內容（AI 辨識）】', vision);
  lines.push('', '【我的筆記】', note || '（沒有筆記）');
  return lines.join('\n');
}

/**
 * AI 整理（D-11）：按了才跑；結果另存 ai_output／ai_provider／ai_at，**不動 caption 與 note**；一篇留最新一份。
 * discard＝捨棄（清空三欄，不呼叫 AI）。失敗不寫半份、舊的留著。沿用 ADR-017 的 callAi_（選定的那一家，失敗不換家）
 */
function clipAi_(caller, id, discard) {
  var own = clipOwnRow_(caller, discard ? 'clipAiDiscard' : 'clipAi', id);
  if (own.error) return own;
  var missing = clipColsMissing_(own.headers, ['ai_output', 'ai_provider', 'ai_at']);
  if (missing) return missing;
  var rec = own.rec;
  if (discard) {
    try { clipsPatch_(own.sheet, id, { ai_output: '', ai_provider: '', ai_at: '' }); } catch (err) { return { error: 'busy' }; }
    logTransaction_(CLIPS_LOG_SOURCE, '成功', 'clipAi ' + id, '捨棄 AI 整理', String(rec.url || ''), '', caller.line_id);
    return { success: true };
  }
  // ADR-024 D-3：只有圖的篇，跑過辨識就有東西可整理
  if (!['caption', 'note', 'ocr_output', 'vision_output'].some(function (k) { return String(rec[k] || '').trim(); })) return { error: 'empty', permanent: true };
  var res = callAi_(clipAiPrompt_(rec), 'clip_ai');
  var who = 'provider=' + res.provider + '｜model=' + res.model;
  if (!res.ok) {
    logTransaction_(CLIPS_LOG_SOURCE, '失敗', 'clipAi ' + id, res.reason === 'no_key' ? res.missingKey + ' 未設定' : res.reason,
      who + '｜' + (res.detail || ''), '', caller.line_id);
    return { error: res.reason === 'no_key' ? 'no_key' : 'ai_failed', reason: res.reason, label: res.label, missingKey: res.missingKey };
  }
  var at = new Date().toISOString();
  try {
    clipsPatch_(own.sheet, id, { ai_output: res.text, ai_provider: res.label, ai_at: at });
  } catch (err) {
    return { error: 'busy' };
  }
  logTransaction_(CLIPS_LOG_SOURCE, '成功', 'clipAi ' + id, (res.truncated ? 'AI 整理（被截斷）' : 'AI 整理'),
    who + '｜' + String(rec.url || ''), '', caller.line_id);
  return { success: true, ai_output: res.text, ai_provider: res.label, ai_at: at, truncated: !!res.truncated };
}

/** PWA「＋ 加網址」（D-12）：一次一個網址；IG 貼文照舊排隊，其他只存連結。不是 http(s) 網址＝永久拒絕 */
function clipAdd_(caller, url) {
  if (!canUse_(caller.user, CLIPS_FEATURE)) return { error: 'forbidden', permanent: true, reason: 'feature' };
  var u = String(url || '').trim();
  var found = /^https?:\/\/\S+$/i.test(u) && u.length <= CLIP_LINK_MAX ? clipFoundIn_(u).slice(0, 1) : [];
  if (!found.length) return { error: 'invalid_url', permanent: true };
  var lineId = String(caller.line_id || '').trim();
  try {
    var rowNumber = clipsRegister_(lineId, u, found);
    logTransaction_(CLIPS_LOG_SOURCE, '成功', u, 'PWA 加網址：' + clipRegisterResult_(found), found[0].url, rowNumber, lineId);
  } catch (err) {
    logTransaction_(CLIPS_LOG_SOURCE, '失敗', u, 'PWA 加網址失敗', String(err && err.stack || err), '', lineId);
    return { error: 'busy' };
  }
  return { success: true, kind: found[0].kind };
}

/**
 * Reading Widget 摘要（ADR-021 D-13）：「上次在讀」＝最後閱讀時間最新的一篇；「未讀」＝收齊（done／partial）或只存連結、
 * 且 read_status 空白的（ADR-025 D-3：📖 閱讀中不算未讀）。
 * 只看自己的、刪掉的不算。title 取內文第一行（沒有就作者、網址）
 */
function readingWidget_(ss, user) {
  var read = sheetRecords_(ss, CLIPS_SHEET, {});
  if (read.error) return { unread: 0, last: null, at: new Date().toISOString() };
  var mine = clipsVisibleTo_(read.rows, user).filter(function (r) { return !clipDeleted_(r); });
  var unread = mine.filter(function (r) {
    var st = String(r.status || '').trim();
    return (st === 'done' || st === 'partial' || st === CLIP_LINK) && !String(r.read_status || '').trim();
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
      title: String(last.caption || '').split('\n')[0].trim().slice(0, 60) || String(last.author || '') || clipDomain_(last.url) || String(last.url || ''),
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
  var warn = false, changed = !!c.created || c.added.length > 0;
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
      changed = true;
      lines.push(LINE_USERS_SHEET + ' 補上：' + CLIPS_FEATURE + '（預設只開管理者 ' + admins + ' 人）');
    }
  }
  if (!PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN')) {
    warn = true;
    lines.push('⚠️ 還沒設 APIFY_TOKEN（專案設定 → 指令碼屬性），收藏會一直失敗');
  }
  return { level: warn ? 'warn' : 'ok', changed: changed, text: lines.join('\n　') };
}

/* -------------------------------------------------------------------------- */
/* 圖書館設定與成本閘門（ADR-027，Neil 2026-11-13）                                   */
/* -------------------------------------------------------------------------- */

/** 讀設定：沒存過或壞掉的鍵用預設值（IG 都存、Threads 存圖不存影片）。回 { ig_images, ig_videos, threads_images, threads_videos, force_month } */
function clipsSettings_() {
  var raw = null;
  try { raw = JSON.parse(PropertiesService.getScriptProperties().getProperty(CLIPS_SETTINGS_KEY) || 'null'); } catch (err) { raw = null; }
  var s = {};
  Object.keys(CLIPS_SETTINGS_DEFAULTS).forEach(function (k) {
    s[k] = raw && typeof raw[k] === 'boolean' ? raw[k] : CLIPS_SETTINGS_DEFAULTS[k];
  });
  s.force_month = raw && typeof raw.force_month === 'string' ? raw.force_month : '';
  return s;
}

/** 台北的月份 YYYY-MM */
function clipsMonth_(d) {
  return taipeiDateKey_(d instanceof Date ? d : new Date(d)).slice(0, 7);
}

/** Threads 本月估算用量 { month, usd, posts }；換月就從 0 算 */
function clipsThreadsUsage_(now) {
  var month = clipsMonth_(now || new Date());
  var v = null;
  try { v = JSON.parse(PropertiesService.getScriptProperties().getProperty(CLIPS_THREADS_USAGE_KEY) || 'null'); } catch (err) { v = null; }
  if (!v || v.month !== month || typeof v.usd !== 'number') return { month: month, usd: 0, posts: 0 };
  return { month: month, usd: v.usd, posts: Number(v.posts) || 0 };
}

function clipsThreadsUsageAdd_(usd, posts, now) {
  var cur = clipsThreadsUsage_(now);
  var next = { month: cur.month, usd: Math.round((cur.usd + (Number(usd) || 0)) * 10000) / 10000, posts: cur.posts + (Number(posts) || 0) };
  try { PropertiesService.getScriptProperties().setProperty(CLIPS_THREADS_USAGE_KEY, JSON.stringify(next)); }
  catch (err) { console.log('Threads 用量存不了：' + err); }
  return next;
}

/**
 * 成本閘門（D-4，Neil 2026-11-13：達上限兩個都停，給開關強制續抓）。
 * 本月合計＝max(Apify 帳號本月用量（apifyUsage 每天更新）, Threads 估算)——帳號用量可能含也可能不含按筆計費（未實測），
 * 取大的才不會低估；IG 部分＝帳號用量－Threads 估算（不小於 0），只給畫面看。
 * 回 { month, usd, account_usd, threads_usd, ig_usd, cap, over, forced, paused }
 */
function clipsCostGate_(now) {
  now = now || new Date();
  var month = clipsMonth_(now);
  var usage = clipsUsage_();
  var acct = usage && typeof usage.usd === 'number' && usage.at && clipsMonth_(new Date(usage.at)) === month ? usage.usd : 0;
  var th = clipsThreadsUsage_(now).usd;
  var total = Math.max(acct, th);
  var forced = clipsSettings_().force_month === month;
  var over = total >= CLIPS_USAGE_RED_USD;
  return { month: month, usd: total, account_usd: acct, threads_usd: th, ig_usd: Math.max(0, Math.round((acct - th) * 10000) / 10000),
    cap: CLIPS_USAGE_RED_USD, over: over, forced: forced, paused: over && !forced };
}

/** 暫停時寫一筆 logs：一個月只寫一次 */
function clipsNotePause_(gate) {
  var props = PropertiesService.getScriptProperties();
  try { if (props.getProperty(CLIPS_PAUSED_KEY) === gate.month) return; props.setProperty(CLIPS_PAUSED_KEY, gate.month); } catch (err) { return; }
  logTransaction_(CLIPS_LOG_SOURCE, '失敗', 'clips', '本月 Apify 達上限，IG 與 Threads 收藏暫停抓取',
    'US$' + gate.usd.toFixed(2) + '／US$' + gate.cap + '；要續抓請到圖書館設定打開「' + CLIPS_SETTINGS_LABELS.force + '」（會付費）', '', '');
}

/** 管理者＋feat_clips 才能看／改圖書館設定 */
function clipsSettingsForbidden_(caller, action) {
  var forbidden = adminForbidden_(caller, action);
  if (forbidden) return forbidden;
  if (canUse_(caller.user, CLIPS_FEATURE)) return null;
  try { logTransaction_(SETTINGS_LOG_SOURCE, '失敗', action, '沒有「圖書館」功能的權限', '', '', caller.line_id); } catch (err) {}
  return { error: 'forbidden' };
}

/** action=clipSettings：設定＋本月成本閘門現況（含 IG／Threads 分開的用量與成功率） */
function clipSettingsView_(caller) {
  var forbidden = clipsSettingsForbidden_(caller, 'clipSettings');
  if (forbidden) return forbidden;
  return { success: true, settings: clipsSettings_(), gate: clipsCostGate_(new Date()), threads: clipsThreadsUsage_(new Date()) };
}

/**
 * action=clipSettingsSet：key＝ig_images｜ig_videos｜threads_images｜threads_videos｜force；value 布林。
 * force＝true 存「本月」（下個月自動失效），false 清掉。每次切換寫 logs（來源「設定」）
 */
function clipSettingsSet_(caller, key, value) {
  var forbidden = clipsSettingsForbidden_(caller, 'clipSettingsSet');
  if (forbidden) return forbidden;
  if (!Object.prototype.hasOwnProperty.call(CLIPS_SETTINGS_LABELS, key)) return { error: 'invalid_key' };
  if (typeof value !== 'boolean') return { error: 'invalid_value' };
  var s = clipsSettings_();
  var month = clipsMonth_(new Date());
  if (key === 'force') s.force_month = value ? month : '';
  else s[key] = value;
  try {
    PropertiesService.getScriptProperties().setProperty(CLIPS_SETTINGS_KEY, JSON.stringify(s));
  } catch (err) {
    try { logTransaction_(SETTINGS_LOG_SOURCE, '失敗', 'clipSettingsSet ' + key, '存不進指令碼屬性', String(err), '', caller.line_id); } catch (e) {}
    return { error: 'save_failed' };
  }
  settingsLog_(caller, 'clipSettingsSet ' + key, CLIPS_SETTINGS_LABELS[key] + '：' + (value ? '開' : '關'), key === 'force' ? '月份 ' + month : '');
  return { success: true, settings: s, gate: clipsCostGate_(new Date()), threads: clipsThreadsUsage_(new Date()) };
}

/**
 * D-3：只存連結、網址是 Threads 單篇貼文或分享短網址的列 → 等待抓取（kind＝threads、pending）。
 * 只改 kind／status／url／shortcode／attempts／next_try_at／error；閱讀狀態、筆記、分類、AI、收藏時間都保留。
 * 只跑一次（CLIPS_THREADS_BACKFILL_KEY）；先記旗標再改（比照閱讀狀態重設）。不拿鎖：初始化由 handleInitCommand_ 拿著。
 * 回 { already, count, flag_failed? }
 */
function clipsThreadsBackfill_() {
  var props = PropertiesService.getScriptProperties();
  var out = { already: false, count: 0 };
  if (props.getProperty(CLIPS_THREADS_BACKFILL_KEY)) { out.already = true; return out; }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  var t = sheet && sheet.getLastRow() >= 2 ? clipsTable_(sheet) : null;
  var todo = t ? t.rows.filter(function (x) { return !clipDeleted_(x.rec) && x.rec.kind === CLIP_LINK && clipThreadsParse_(x.rec.url); }) : [];
  try { props.setProperty(CLIPS_THREADS_BACKFILL_KEY, new Date().toISOString()); }
  catch (err) { if (todo.length) out.flag_failed = String(err && err.message || err); }
  if (out.flag_failed) return out;
  todo.forEach(function (x) {
    var p = clipThreadsParse_(x.rec.url);
    clipsWriteRow_(sheet, t.headers, x, { kind: CLIP_THREADS, status: 'pending', url: p.url, shortcode: p.code || '', attempts: 0, next_try_at: '', error: '' });
    out.count++;
  });
  return out;
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
    if (clipDeleted_(r) || r.status !== 'done' || r.kind === CLIP_THREADS) return;   // Threads 的 raw.json 形狀不同，且一開始就有 BOM
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

/**
 * ADR-025 D-7：未刪除的列 read_status 清空（全部回未讀）；last_read_at 保留（「上次在讀」不受影響）。
 * 只跑一次：CLIPS_READ_RESET_KEY 有值就略過。不拿鎖：初始化由 handleInitCommand_ 拿著 script lock。回 { already, reset, flag_failed? }
 */
function clipsResetReadState_() {
  var props = PropertiesService.getScriptProperties();
  var out = { already: false, reset: 0 };
  if (props.getProperty(CLIPS_READ_RESET_KEY)) { out.already = true; return out; }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  var t = sheet && sheet.getLastRow() >= 2 ? clipsTable_(sheet) : null;
  var todo = t && t.headers.indexOf('read_status') !== -1 ? t.rows.filter(function (x) {
    return !clipDeleted_(x.rec) && String(x.rec.read_status == null ? '' : x.rec.read_status).trim() !== '';
  }) : [];
  // 先記旗標再清：要清的時候旗標寫不進就一列都不動（回 flag_failed，下次初始化再試）；清到一半失敗也不會在
  // 下次初始化又清一次（蓋掉之後手動調的狀態）。沒有要清的：旗標盡量記，記不了也沒有東西會被蓋
  try { props.setProperty(CLIPS_READ_RESET_KEY, new Date().toISOString()); }
  catch (err) { if (todo.length) out.flag_failed = String(err && err.message || err); }
  if (out.flag_failed) return out;
  todo.forEach(function (x) {
    clipsWriteRow_(sheet, t.headers, x, { read_status: '' });
    out.reset++;
  });
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
function clipsSuccessRate_(rows, nowMs, kind) {
  var since = nowMs - CLIPS_RATE_DAYS * 86400000;
  var done = 0, total = 0;
  (rows || []).forEach(function (r) {
    if (clipDeleted_(r) || r.kind === CLIP_LINK) return;     // 只存連結不經過 Apify
    if (kind && r.kind !== kind) return;                      // ADR-027：Threads 另算一份
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
  var rateTh = { done: 0, total: 0, rate: null };
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
    var recs = sheet && sheet.getLastRow() >= 2 ? clipsTable_(sheet).rows.map(function (x) { return x.rec; }) : [];
    if (recs.length) {
      rate = clipsSuccessRate_(recs, nowDate.getTime());
      rateTh = clipsSuccessRate_(recs, nowDate.getTime(), CLIP_THREADS);
    }
  } catch (err) { error = (error ? error + '；' : '') + '讀不到 clips（' + String(err && err.message || err) + '）'; }
  var out = { usd: usd !== null ? usd : (typeof prev.usd === 'number' ? prev.usd : null), at: usd !== null ? at : (prev.at || ''),
    checked_at: at, error: error, done: rate.done, total: rate.total, rate: rate.rate,
    // ADR-027：Threads 的成功率另外記（連續 3 天低於 80% 管理頁提示，不自動停）
    threads_done: rateTh.done, threads_total: rateTh.total, threads_rate: rateTh.rate };
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
