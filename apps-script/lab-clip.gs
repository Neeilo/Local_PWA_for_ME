/**
 * RD 收藏搜集器 MVP 階段 0：可行性探針（2026-10-15 交棒頁 V1～V7）。
 *
 * 只有一支入口 probeClipSources()：在 GAS 編輯器手動執行（同 probeStockSources／diagnoseAi），
 * 回答「LINE 丟 IG 網址 → 完整取得全文與每一張圖 → 存 Drive」這條路走不走得通。
 *   V1 Apify 回不回得了全部圖片＋全文　V2 GAS 呼叫 Apify 要多久　V3 Google 機房下載得到 IG 圖片嗎
 *   V4 Jina 退路　V5 成本　V6 網址正規化　V7 Reels 回什麼
 *
 * 刻意不做：不接 LINE 路由、不建分頁、不寫 Sheet、不改任何現有函式、不做 AI。
 * 只寫執行記錄，以及 Drive 的一個獨立測試資料夾（驗完可整個刪）。
 *
 * 金鑰一律讀指令碼屬性，只放 Authorization header，不進網址、不印出來：
 *   APIFY_TOKEN（必填，沒有就跳過 Apify）／JINA_API_KEY（選填）
 * 選填設定（也是指令碼屬性，免改程式重部署）：
 *   APIFY_ACTOR        預設 dami_studio~instagram-post-scraper（交棒頁指定的那支；actor 代號未實測）
 *   APIFY_INPUT_FIELD  送網址清單用的欄位名，預設 urls（actor 若回 input 錯誤，照它的 Input 頁改這裡）
 *   CLIP_PROBE_URLS    額外測試貼文，一行一篇：網址|預期張數|備註（後兩欄可省略）
 *
 * Apify 用「啟動＋輪詢」而不是 run-sync：UrlFetchApp 單一請求有逾時上限，同步端點最長要等 5 分鐘，
 * 會先被 GAS 砍掉。所有網址併成一次 run，花費除以篇數就是每篇成本。
 */

var CLIP_TEST_POST = 'https://www.instagram.com/p/DdsyziaiROW/';
/** 交棒頁指定的測試貼文：10 張輪播、重點在第 2～10 張 */
var CLIP_PROBE_POSTS = [{ url: CLIP_TEST_POST, expected: 10, note: '10 張輪播（交棒頁指定）' }];

var CLIP_APIFY_BASE = 'https://api.apify.com/v2';
var CLIP_APIFY_DEFAULT_ACTOR = 'dami_studio~instagram-post-scraper';
/** 每次請求請 Apify 最多等幾秒；留在 UrlFetchApp 逾時之下 */
var CLIP_APIFY_WAIT_SEC = 45;
/** 啟動後最多再輪詢幾次（加上啟動那次約 4 分鐘，整支探針還在 GAS 的 6 分鐘內） */
var CLIP_APIFY_MAX_POLLS = 4;
var CLIP_APIFY_DONE = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];
var CLIP_JINA_BASE = 'https://r.jina.ai/';
var CLIP_DRIVE_FOLDER = 'Neil OS 探針｜收藏 MVP（驗完可整個刪）';
var CLIP_MONTHLY_POSTS = 300;

/** 編輯器手動執行的入口 */
function probeClipSources() {
  return probeClipSources_(new Date());
}

function probeClipSources_(now) {
  var props = PropertiesService.getScriptProperties();
  var posts = clipProbeList_(props.getProperty('CLIP_PROBE_URLS'));
  var report = { at: now.toISOString(), posts: [], apify: null, jina: null, verdicts: {} };
  console.log('🔎 收藏搜集器探針｜' + report.at + '｜' + posts.length + ' 篇');
  posts.forEach(function (p) { console.log('  · ' + p.url + '（' + (p.note || '') + (p.expected ? '，預期 ' + p.expected + ' 張' : '，沒給預期張數') + '）'); });

  report.apify = clipApify_(props, posts);
  report.posts = posts.map(function (p) { return clipPostRecord_(p, report.apify, posts.length); });
  var folder = null;
  if (report.posts.some(function (r) { return r.media.length; })) folder = clipFolder_();
  report.posts.forEach(function (r) { clipSaveMedia_(r, folder); clipFinish_(r); });
  report.jina = clipJina_(props.getProperty('JINA_API_KEY'), report.posts);
  report.verdicts = clipVerdicts_(posts, report);

  console.log('—— 總結（回貼到交棒頁執行日誌）——');
  ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7'].forEach(function (k) {
    var v = report.verdicts[k];
    console.log((v.ok ? '✅ ' : '❌ ') + k + '｜' + v.verdict);
  });
  console.log('caption 是否與 IG 頁面逐字一致，仍要 Neil 打開 IG 對一次（探針只能比 Apify 與 Jina 兩邊）');
  return report;
}

/* -------------------------------------------------------------------------- */
/* V6 網址正規化                                                               */
/* -------------------------------------------------------------------------- */

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

/** 預設測試貼文＋指令碼屬性 CLIP_PROBE_URLS；同一篇（不同參數）只留第一筆 */
function clipProbeList_(extra) {
  var lines = CLIP_PROBE_POSTS.map(function (p) { return [p.url, String(p.expected), p.note].join('|'); });
  String(extra || '').split(/\r?\n/).forEach(function (l) { if (l.trim()) lines.push(l.trim()); });
  var seen = {};
  var out = [];
  lines.forEach(function (line) {
    var parts = line.split('|').map(function (s) { return s.trim(); });
    var n = clipNormalizeUrl_(parts[0]);
    if (!n) { console.log('⚠️ 不是 IG 貼文網址，略過：' + parts[0]); return; }
    if (seen[n.key]) return;
    seen[n.key] = true;
    var expected = null;
    var note = '';
    parts.slice(1).forEach(function (s) { if (/^\d+$/.test(s)) expected = Number(s); else if (s) note = s; });
    out.push({ key: n.key, id: n.key.slice(3), url: n.url, kind: n.kind, raw: parts[0], expected: expected, note: note });
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* V1／V2／V5 Apify                                                            */
/* -------------------------------------------------------------------------- */

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

function clipApify_(props, posts) {
  var token = props.getProperty('APIFY_TOKEN');
  var out = { ok: false, verdict: '', ms: 0, usd: null, runStatus: '', items: [], keys: [] };
  if (!token) {
    out.verdict = '沒設 APIFY_TOKEN，未測（專案設定 → 指令碼屬性 補上後重跑）';
    console.log('[Apify] ❌ ' + out.verdict);
    return out;
  }
  var actor = props.getProperty('APIFY_ACTOR') || CLIP_APIFY_DEFAULT_ACTOR;
  var field = props.getProperty('APIFY_INPUT_FIELD') || 'urls';
  var headers = { Authorization: 'Bearer ' + token };
  var input = {};
  input[field] = posts.map(function (p) { return p.url; });
  var started = Date.now();
  console.log('[Apify] actor=' + actor + '｜input 欄位=' + field + '｜' + posts.length + ' 篇併成一次 run');

  var r = clipFetch_(CLIP_APIFY_BASE + '/acts/' + encodeURIComponent(actor) + '/runs?waitForFinish=' + CLIP_APIFY_WAIT_SEC,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify(input), headers: headers });
  var run = (clipJson_(r) || {}).data;
  for (var i = 0; run && run.id && CLIP_APIFY_DONE.indexOf(run.status) === -1 && i < CLIP_APIFY_MAX_POLLS; i++) {
    console.log('[Apify] 狀態 ' + run.status + '，再等 ' + CLIP_APIFY_WAIT_SEC + ' 秒…');
    r = clipFetch_(CLIP_APIFY_BASE + '/actor-runs/' + encodeURIComponent(run.id) + '?waitForFinish=' + CLIP_APIFY_WAIT_SEC, { headers: headers });
    run = (clipJson_(r) || {}).data || run;
  }
  if (!run || !run.id) {
    out.ms = Date.now() - started;
    out.verdict = '啟動失敗：' + clipHead_(r) + '｜' + clipText_(r, 300);
    console.log('[Apify] ❌ ' + out.verdict);
    return out;
  }
  out.runStatus = run.status;
  out.usd = typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : null;
  if (run.status !== 'SUCCEEDED') {
    out.ms = Date.now() - started;
    out.verdict = 'run 狀態 ' + run.status + (CLIP_APIFY_DONE.indexOf(run.status) === -1 ? '（等太久，探針先停；到 Apify 後台看結果）' : '');
    console.log('[Apify] ❌ ' + out.verdict);
    return out;
  }
  var d = clipFetch_(CLIP_APIFY_BASE + '/datasets/' + encodeURIComponent(run.defaultDatasetId) + '/items?clean=true&format=json', { headers: headers });
  out.ms = Date.now() - started;
  var items = clipJson_(d);
  if (!Array.isArray(items)) {
    out.verdict = '讀 dataset 失敗：' + clipHead_(d) + '｜' + clipText_(d, 300);
    console.log('[Apify] ❌ ' + out.verdict);
    return out;
  }
  out.items = items;
  items.forEach(function (it) { Object.keys(it || {}).forEach(function (k) { if (out.keys.indexOf(k) === -1) out.keys.push(k); }); });
  out.ok = true;
  out.verdict = items.length + ' 筆結果｜' + out.ms + 'ms' + (out.usd === null ? '' : '｜US$' + out.usd);
  console.log('[Apify] ✅ ' + out.verdict);
  // 欄位對應是照常見格式寫的（actor 沒實測過）；這行回貼回來才知道要不要改 clipMediaOf_
  console.log('[Apify] 回傳欄位：' + out.keys.join(','));
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
  return single.source_url ? [single] : [];
}

function clipItemFor_(post, items, total) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var code = clipPick_(it, ['shortCode', 'shortcode', 'code']);
    if (code === post.id) return it;
    var n = clipNormalizeUrl_(clipPick_(it, ['url', 'inputUrl', 'postUrl']));
    if (n && n.key === post.key) return it;
  }
  return total === 1 && items.length === 1 ? items[0] : null;
}

/** 照交棒頁的 PoC JSON 欄位約定（與 lab/clip-poc 的 Python 版同一份格式） */
function clipPostRecord_(post, apify, total) {
  var rec = {
    source: 'instagram', post_id: post.id, source_url: post.url, author: '', published_at: '', caption: '',
    media: [], media_count_expected: post.expected, media_count_saved: 0,
    extractor: 'apify', status: 'failed', errors: [], ms: 0
  };
  if (!apify.ok) { rec.errors.push('Apify 未取得：' + apify.verdict); return rec; }
  var item = clipItemFor_(post, apify.items, total);
  if (!item) { rec.errors.push('Apify 結果裡找不到這篇'); return rec; }
  rec.author = String(clipPick_(item, ['ownerUsername', 'username', 'owner.username', 'author']));
  rec.published_at = String(clipPick_(item, ['timestamp', 'takenAt', 'taken_at', 'publishedAt', 'date']));
  rec.caption = String(clipPick_(item, ['caption', 'text', 'description']));
  rec.ms = Math.round(apify.ms / Math.max(apify.items.length, 1));
  rec.media = clipMediaOf_(item).map(function (m, i) {
    return { order: i + 1, type: m.type, source_url: m.source_url, cover_url: m.cover_url, saved_path: '', bytes: 0, error: '' };
  });
  return rec;
}

/* -------------------------------------------------------------------------- */
/* V3 下載進 Drive                                                             */
/* -------------------------------------------------------------------------- */

function clipFolder_() {
  var root = DriveApp.getRootFolder();
  var it = root.getFoldersByName(CLIP_DRIVE_FOLDER);
  return it.hasNext() ? it.next() : root.createFolder(CLIP_DRIVE_FOLDER);
}

var CLIP_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' };

/**
 * IG 圖片網址帶 oe= 過期簽章，取得當下就要下載。影片不下載（V7 只看回了什麼，收不收由 grill-me 決定）。
 * 「拿到網址」不算「存下來」：要 200、要是圖片、要真的寫進 Drive 才算。
 */
function clipSaveMedia_(rec, folder) {
  rec.media.forEach(function (m) {
    if (m.type === 'video') { m.error = '影片未下載（V7 只記錄）'; return; }
    if (!m.source_url) { m.error = '沒有網址'; return; }
    var r = clipFetch_(m.source_url, {});
    if (r.status !== 200) { m.error = clipHead_(r); return; }
    var blob = r.res.getBlob();
    var type = String(blob.getContentType() || '').split(';')[0];
    if (!/^image\//.test(type)) { m.error = '回的不是圖片（' + (type || '未知') + '）'; return; }
    var name = rec.post_id + '_' + (m.order < 10 ? '0' : '') + m.order + '.' + (CLIP_EXT[type] || 'img');
    try {
      folder.createFile(blob.setName(name));
      m.bytes = blob.getBytes().length;
      m.saved_path = CLIP_DRIVE_FOLDER + '/' + name;
    } catch (err) {
      m.error = '寫入 Drive 失敗（' + String(err && err.message || err) + '）';
    }
  });
}

function clipFinish_(rec) {
  rec.media_count_saved = rec.media.filter(function (m) { return m.saved_path; }).length;
  if (!rec.media.length) {
    if (!rec.errors.length) rec.errors.push('沒有任何圖片／影片');
  } else {
    if (rec.media_count_expected !== null && rec.media.length !== rec.media_count_expected) {
      rec.errors.push('取得 ' + rec.media.length + '/' + rec.media_count_expected + ' 張');
    }
    rec.media.forEach(function (m) { if (m.error) rec.errors.push('第 ' + m.order + ' 張：' + m.error); });
    if (!rec.caption) rec.errors.push('沒有 caption');
  }
  if (!rec.media.length && !rec.caption) rec.status = 'failed';
  else if (rec.errors.length) rec.status = 'partial';
  else rec.status = rec.media_count_expected === null ? 'unverified' : 'ok';

  var total = rec.media.reduce(function (s, m) { return s + m.bytes; }, 0);
  console.log('[' + rec.post_id + '] ' + rec.status + '｜取得 ' + rec.media.length + ' 張、存 ' + rec.media_count_saved +
    ' 張（' + Math.round(total / 1024) + ' KB）｜caption ' + rec.caption.length + ' 字｜作者 ' + (rec.author || '—') +
    '｜發文 ' + (rec.published_at || '—') + (rec.errors.length ? '｜' + rec.errors.join('；') : ''));
  rec.media.forEach(function (m) {
    console.log('    #' + m.order + ' ' + m.type + ' ' + (m.saved_path ? '✅ ' + Math.round(m.bytes / 1024) + ' KB' : '❌ ' + m.error));
  });
}

/* -------------------------------------------------------------------------- */
/* V4 Jina 退路                                                                */
/* -------------------------------------------------------------------------- */

function clipSquash_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function clipJina_(key, recs) {
  var headers = key ? { Authorization: 'Bearer ' + key } : {};
  var rows = recs.map(function (rec) {
    var url = CLIP_JINA_BASE + rec.source_url;
    var r = clipFetch_(url, { headers: headers });
    var text = r.status === 200 ? clipText_(r) : '';
    var row = {
      post_id: rec.post_id, url: url, status: r.status, ms: r.ms, chars: text.length,
      images: (text.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length,
      captionMatch: rec.caption && text ? text.replace(/\\/g, '').replace(/\s+/g, ' ').indexOf(clipSquash_(rec.caption)) !== -1 : null,
      error: r.status === 200 ? '' : clipHead_(r) + '｜' + clipText_(r, 200)
    };
    console.log('[Jina] ' + rec.post_id + ' → ' + clipHead_(r) + '｜' + r.ms + 'ms｜' + row.chars + ' 字｜圖 ' + row.images + ' 張' +
      (row.captionMatch === null ? '' : row.captionMatch ? '｜caption 與 Apify 一致' : '｜caption 與 Apify 不一致') +
      (r.status === 429 ? '｜⚠️ 被限流（429）' : '') + (row.error ? '｜' + row.error : ''));
    return row;
  });
  return { keyed: !!key, rows: rows };
}

/* -------------------------------------------------------------------------- */
/* 總結                                                                        */
/* -------------------------------------------------------------------------- */

function clipVerdicts_(posts, report) {
  var recs = report.posts;
  var apify = report.apify;
  var v = {};

  var known = recs.filter(function (r) { return r.media_count_expected !== null; });
  v.V1 = {
    ok: apify.ok && known.length > 0 && known.every(function (r) { return r.caption && r.media.length === r.media_count_expected; }),
    verdict: !apify.ok ? 'Apify 未取得（' + apify.verdict + '）' : recs.map(function (r) {
      return r.post_id + ' ' + r.media.length + '/' + (r.media_count_expected === null ? '?' : r.media_count_expected) + ' 張、caption ' + r.caption.length + ' 字';
    }).join('；')
  };

  v.V2 = {
    ok: apify.ok,
    verdict: apify.ok ? '一次 run ' + recs.length + ' 篇共 ' + apify.ms + 'ms，平均每篇約 ' + Math.round(apify.ms / Math.max(recs.length, 1)) + 'ms（啟動＋輪詢，見檔頭說明）' : apify.verdict
  };

  var images = [];
  recs.forEach(function (r) { r.media.forEach(function (m) { if (m.type === 'image') images.push(m); }); });
  var saved = images.filter(function (m) { return m.saved_path; });
  var bytes = saved.reduce(function (s, m) { return s + m.bytes; }, 0);
  v.V3 = {
    ok: images.length > 0 && saved.length === images.length,
    verdict: images.length ? '圖片存進 Drive ' + saved.length + '/' + images.length + ' 張，共 ' + Math.round(bytes / 1024) + ' KB' +
      (saved.length ? '（平均每張 ' + Math.round(bytes / saved.length / 1024) + ' KB）' : '') + '｜資料夾「' + CLIP_DRIVE_FOLDER + '」' : '沒有圖片可下載（先過 V1）'
  };

  var jr = report.jina.rows;
  v.V4 = {
    ok: jr.length > 0 && jr.every(function (r) { return r.status === 200 && r.chars > 0; }),
    verdict: (report.jina.keyed ? '帶 JINA_API_KEY' : '不帶 key') + '｜' + jr.map(function (r) {
      return r.post_id + ' ' + (r.status === 200 ? r.chars + ' 字、圖 ' + r.images + ' 張' : (r.status === 429 ? '429 被限流' : r.error));
    }).join('；')
  };

  if (apify.usd === null) {
    v.V5 = { ok: false, verdict: apify.ok ? 'Apify 沒回 usageTotalUsd，請到 Apify 後台 Billing 看本次 run 扣多少' : '沒跑成 Apify，無法估' };
  } else {
    var per = apify.usd / Math.max(recs.length, 1);
    v.V5 = { ok: true, verdict: '本次 US$' + apify.usd + '／' + recs.length + ' 篇 → 每篇約 US$' + per.toFixed(5) + '，每月 ' + CLIP_MONTHLY_POSTS + ' 篇約 US$' + (per * CLIP_MONTHLY_POSTS).toFixed(3) + '（以後台實扣為準）' };
  }

  v.V6 = {
    ok: apify.ok,
    verdict: posts.map(function (p) { return p.raw === p.url ? p.url : p.raw + ' → ' + p.url; }).join('；') + '｜送 Apify 的都是正規化後的網址' + (apify.ok ? '，可用' : '，Apify 未跑成，還不能下結論')
  };

  var reels = recs.filter(function (r) { return r.media.some(function (m) { return m.type === 'video'; }); });
  v.V7 = {
    ok: reels.length > 0,
    verdict: reels.length ? reels.map(function (r) {
      return r.post_id + '：' + r.media.map(function (m) { return m.type + '（網址' + (m.source_url ? '有' : '無') + '、封面' + (m.cover_url ? '有' : '無') + '）'; }).join('、');
    }).join('；') + '｜逐字稿欄位請看上面「回傳欄位」' : '沒有影片結果（CLIP_PROBE_URLS 補一篇 Reels 再跑）'
  };
  return v;
}
