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
 *   APIFY_INPUT_FIELD  送網址清單用的欄位名，預設 postUrls（2026-10-16 查 actor Input 頁確認；換 actor 才要改）
 *   CLIP_PROBE_URLS    額外測試貼文，一行一篇：網址|預期張數|備註（後兩欄可省略）
 *
 * Apify 用「啟動＋輪詢」而不是 run-sync：UrlFetchApp 單一請求有逾時上限，同步端點最長要等 5 分鐘，
 * 會先被 GAS 砍掉。所有網址併成一次 run，花費除以篇數就是每篇成本。
 */

var CLIP_TEST_POST = 'https://www.instagram.com/p/DdsyziaiROW/';
/** 交棒頁指定的測試貼文：10 張輪播、重點在第 2～10 張 */
var CLIP_PROBE_POSTS = [{ url: CLIP_TEST_POST, expected: 10, note: '10 張輪播（交棒頁指定）' }];

// Apify 網址、預設 actor／欄位、網址正規化、clipFetch_、欄位解析：共用在 clips.gs（ADR-020 RD-1 搬過去，探針與排程同一份）
/** 每次請求請 Apify 最多等幾秒；留在 UrlFetchApp 逾時之下 */
var CLIP_APIFY_WAIT_SEC = 45;
/** 啟動後最多再輪詢幾次（加上啟動那次約 4 分鐘，整支探針還在 GAS 的 6 分鐘內） */
var CLIP_APIFY_MAX_POLLS = 4;
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
  report.posts = posts.map(function (p) { return clipPostRecord_(p, report.apify); });
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

/** Apify 跑一次（共用的 clipApifyRun_），探針這邊只負責印執行記錄與組 V1／V2 的結論 */
function clipApify_(props, posts) {
  var cfg = clipApifyConfig_(props);
  var out = { ok: false, verdict: '', ms: 0, usd: null, runStatus: '', items: [], keys: [] };
  if (!cfg.token) {
    out.verdict = '沒設 APIFY_TOKEN，未測（專案設定 → 指令碼屬性 補上後重跑）';
    console.log('[Apify] ❌ ' + out.verdict);
    return out;
  }
  if (cfg.fieldRejected) {
    console.log('⚠️ 指令碼屬性 APIFY_INPUT_FIELD 的值不像欄位名，先不採用、改用 ' + CLIP_APIFY_DEFAULT_FIELD + '（測試網址請放 CLIP_PROBE_URLS）');
  }
  console.log('[Apify] actor=' + cfg.actor + '｜input 欄位=' + cfg.field + '｜' + posts.length + ' 篇併成一次 run');
  var r = clipApifyRun_(cfg, posts.map(function (p) { return p.url; }), {
    waitSec: CLIP_APIFY_WAIT_SEC, maxPolls: CLIP_APIFY_MAX_POLLS,
    onPoll: function (status) { console.log('[Apify] 狀態 ' + status + '，再等 ' + CLIP_APIFY_WAIT_SEC + ' 秒…'); }
  });
  out.ms = r.ms;
  out.usd = r.usd;
  out.runStatus = r.runStatus;
  out.keys = r.keys;
  if (r.stage === 'start') out.verdict = '啟動失敗：' + r.detail;
  else if (r.stage === 'run') out.verdict = 'run 狀態 ' + r.runStatus + (r.timedOut ? '（等太久，探針先停；到 Apify 後台看結果）' : '');
  else if (r.stage === 'dataset') out.verdict = '讀 dataset 失敗：' + r.detail;
  if (r.stage !== 'ok') {
    console.log('[Apify] ❌ ' + out.verdict);
    return out;
  }
  out.items = r.items;
  out.ok = out.items.length > 0;
  out.verdict = out.items.length + ' 筆結果｜' + out.ms + 'ms' + (out.usd === null ? '' : '｜US$' + out.usd) +
    (r.samples ? '｜另有 ' + r.samples + ' 筆是 actor 的範例資料（input 沒被認得，檢查 APIFY_INPUT_FIELD），已排除' : '');
  console.log('[Apify] ' + (out.ok ? '✅ ' : '❌ ') + out.verdict);
  // 欄位對應是照常見格式寫的（actor 沒實測過）；這行回貼回來才知道要不要改 clipMediaOf_
  console.log('[Apify] 回傳欄位：' + out.keys.join(','));
  return out;
}

/** 照交棒頁的 PoC JSON 欄位約定（與 lab/clip-poc 的 Python 版同一份格式） */
function clipPostRecord_(post, apify) {
  var rec = {
    source: 'instagram', post_id: post.id, source_url: post.url, author: '', published_at: '', caption: '',
    media: [], media_count_expected: post.expected, media_count_saved: 0,
    extractor: 'apify', status: 'failed', errors: [], ms: 0
  };
  if (!apify.ok) { rec.errors.push('Apify 未取得：' + apify.verdict); return rec; }
  var item = clipItemFor_(post, apify.items);
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

/* ========================================================================== */
/* ADR-024 PR-0：Drive 文字辨識探針                                              */
/* ========================================================================== */

/*
 * probeClipOcr()：編輯器手動執行。回答「Drive 把圖片轉成 Google 文件順手做的 OCR，繁中讀得好不好、一張多久、
 * 暫存文件有沒有刪乾淨」——PR-A 的 📝 文字辨識用的是同一支 clipOcrImage_（clips.gs）。
 * 只對指令碼屬性 CLIP_OCR_PROBE_ID 指定的那一篇跑：收藏 id（clips 的 id 欄）或 Drive 資料夾 id 都可以。
 * 刻意不做：不寫 Sheet、不碰 LINE、不改任何現有函式。結果只印執行記錄（回貼到交棒頁執行日誌）。
 */
var CLIP_OCR_PROBE_PROP = 'CLIP_OCR_PROBE_ID';
var CLIP_OCR_PROBE_PREVIEW = 300;

function probeClipOcr() {
  return probeClipOcr_();
}

function probeClipOcr_() {
  var target = String(PropertiesService.getScriptProperties().getProperty(CLIP_OCR_PROBE_PROP) || '').trim();
  var report = { ok: false, target: target, images: [], totalMs: 0, leftovers: [] };
  if (!target) {
    console.log('❌ 沒設 ' + CLIP_OCR_PROBE_PROP + '：專案設定 → 指令碼屬性，填一篇收藏的 id（clips 的 id 欄）或它的 Drive 資料夾 id，再執行一次');
    return report;
  }
  var rec = clipOcrProbeRec_(target);
  var images = clipImageList_(rec);
  console.log('🔎 文字辨識探針｜' + target + (rec.id ? '（收藏 ' + rec.id + '）' : '（當成 Drive 資料夾）') + '｜' + images.length + ' 張圖');
  if (!images.length) {
    console.log('❌ 找不到圖片：確認 id 對不對、那篇是不是只存了連結、資料夾裡有沒有 01.jpg 這類檔案');
    return report;
  }
  var token = clipOcrToken_();
  images.forEach(function (img) {
    var r = clipOcrImage_(img.id, token);
    var chars = r.ok && r.text !== CLIP_OCR_NO_TEXT ? r.text.length : 0;
    report.images.push({ name: img.name, ok: r.ok, chars: chars, ms: r.ms, cleaned: r.cleaned, error: r.error });
    report.totalMs += r.ms;
    if (!r.cleaned) report.leftovers.push(r.leftover);
    console.log((r.ok ? '✅ ' : '❌ ') + img.name + '｜' + (r.ok ? (chars ? chars + ' 字' : CLIP_OCR_NO_TEXT) : r.error) + '｜' + r.ms + ' ms' +
      (r.cleaned ? '' : '｜⚠️ 暫存文件殘留 ' + r.leftover));
    if (r.ok && chars) console.log('   ' + r.text.slice(0, CLIP_OCR_PROBE_PREVIEW).replace(/\n/g, '\n   ') + (r.text.length > CLIP_OCR_PROBE_PREVIEW ? '…' : ''));
  });
  report.ok = report.images.some(function (x) { return x.ok; });
  var n = report.images.length;
  console.log('—— 總結（回貼到交棒頁執行日誌）——');
  console.log((report.ok ? '✅ ' : '❌ ') + '辨識成功 ' + report.images.filter(function (x) { return x.ok; }).length + '／' + n + ' 張｜讀得出字 ' +
    report.images.filter(function (x) { return x.chars > 0; }).length + ' 張｜共 ' + report.totalMs + ' ms，平均 ' + Math.round(report.totalMs / n) + ' ms／張');
  console.log(report.leftovers.length ? '⚠️ 暫存文件殘留 ' + report.leftovers.length + ' 份（到 Drive 搜 tmp_ocr_ 手動刪）：' + report.leftovers.join('、') : '✅ 暫存文件無殘留');
  console.log('繁中品質要 Neil 對照原圖看一次（探針只能數字數）');
  return report;
}

/** CLIP_OCR_PROBE_ID → 收藏那一列；找不到就當成 Drive 資料夾 id */
function clipOcrProbeRec_(target) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  if (sheet && sheet.getLastRow() >= 2) {
    var hit = clipsTable_(sheet).rows.filter(function (x) { return String(x.rec.id) === target; })[0];
    if (hit) return hit.rec;
  }
  return { id: '', drive_folder_id: target, image_ids: '' };
}

/* ========================================================================== */
/* ADR-027 PR-0：Threads 收藏可行性探針                                          */
/* ========================================================================== */

/*
 * probeClipThreads()：編輯器手動執行。回答「Apify 能不能把一篇 Threads 收齊」：主文、圖片（GAS 下載得到嗎）、
 * 影片有無、作者自己的接續串文（只要作者的、順序對不對）、混入多少別人的留言、耗時與費用。
 * 讀指令碼屬性 CLIP_THREADS_PROBE_URLS（逗號或換行分隔，最多 3 篇 Threads 單篇貼文網址），結果只印執行記錄。
 * 刻意不做：不寫 Sheet、不碰 LINE、不存 Drive、不改正式流程。結論只有三種：可行／只能抓主文／不可行。
 *
 * 爬蟲選擇（2026-11-12）：architekture~threads-replies-scraper——一次回主文（recordType=post）與回覆，
 * 作者自己的接續標 replyType=author_thread、帶 parentCode 可以串順序；按筆計費（主文 US$0.001、回覆 US$0.0025），
 * 別人的留言也會計費，所以 maxRepliesPerPost 一定要設上限。備案：automation-lab~threads-scraper（只抓主文，
 * 走 D-6 退回路線時用）。不可行就停下回報，不自行改用其他付費方案（ADR-027 D-4）。
 */
var CLIP_THREADS_PROBE_PROP = 'CLIP_THREADS_PROBE_URLS';
var CLIP_THREADS_PROBE_MAX = 3;
/** 一次探針最多扣多少（3 篇 × 30 列 × US$0.0025 ≈ US$0.23，留一點餘裕） */
var CLIP_THREADS_PROBE_MAX_USD = 0.5;
/** 每月推估用的 Threads 收藏篇數（目前全部只存連結的 Threads 才 11 筆，這個數字偏寬） */
var CLIP_THREADS_MONTHLY_POSTS = 20;

function probeClipThreads() {
  return probeClipThreads_();
}

function probeClipThreads_() {
  var props = PropertiesService.getScriptProperties();
  var input = clipThreadsProbeInputs_(props.getProperty(CLIP_THREADS_PROBE_PROP));
  var report = { verdict: 'not_run', posts: [], shares: [], bad: input.bad, apify: null, cost: null };
  input.bad.forEach(function (b) { console.log('⚠️ 不認得，略過：' + b + '（要是 Threads 的 /share/代碼、/@帳號/post/代碼 或 /t/代碼）'); });
  if (!input.items.length) {
    console.log('❌ ' + clipThreadsPropsHint_());
    return report;
  }
  var cfg = clipApifyConfig_(props);
  if (!cfg.token) {
    console.log('❌ 沒設 APIFY_TOKEN，未測（專案設定 → 指令碼屬性 補上後重跑）');
    return report;
  }
  var posts = clipThreadsProbePosts_(input.items, report);
  if (!posts.length) {
    report.verdict = 'fail';
    console.log('❌ 沒有任何一個網址轉得出貼文代碼，Apify 不跑（省錢）');
    clipThreadsConclude_(report);
    return report;
  }
  console.log('🔎 Threads 探針｜actor=' + CLIP_THREADS_ACTOR + '｜' + posts.length + ' 篇｜每篇最多 ' + CLIP_THREADS_MAX_REPLIES +
    ' 列回覆｜本次花費上限 US$' + CLIP_THREADS_PROBE_MAX_USD);
  posts.forEach(function (p) { console.log('  · ' + p.url); });

  var urls = posts.map(function (p) { return p.url; });
  var r = clipApifyRun_({ token: cfg.token, actor: CLIP_THREADS_ACTOR, field: 'postUrls' }, urls, {
    waitSec: CLIP_APIFY_WAIT_SEC, maxPolls: CLIP_APIFY_MAX_POLLS, maxUsd: CLIP_THREADS_PROBE_MAX_USD,
    input: { maxRepliesPerPost: CLIP_THREADS_MAX_REPLIES, includeAuthorThread: true, sortOrder: 'TOP' },
    onPoll: function (status) { console.log('[Apify] 狀態 ' + status + '，再等 ' + CLIP_APIFY_WAIT_SEC + ' 秒…'); }
  });
  report.apify = { stage: r.stage, ms: r.ms, usd: r.usd, rows: r.items.length, keys: r.keys };
  if (r.stage !== 'ok') {
    report.verdict = 'fail';
    console.log('[Apify] ❌ ' + (r.stage === 'run' ? 'run 狀態 ' + r.runStatus + (r.timedOut ? '（等太久，到 Apify 後台看結果）' : '') : r.detail));
    clipThreadsConclude_(report);
    return report;
  }
  console.log('[Apify] ✅ ' + r.items.length + ' 列｜' + r.ms + 'ms' + (r.usd === null ? '' : '｜Apify 回報 US$' + r.usd));
  console.log('[Apify] 回傳欄位：' + r.keys.join(','));
  var summary = clipThreadsRunSummary_(cfg.token, r.kvs);

  report.posts = posts.map(function (p) {
    var rec = clipThreadsPostRecord_(p, r.items, Math.round(r.ms / posts.length));
    var per = summary.filter(function (x) { var n = clipThreadsProbeList_(x && x.url)[0]; return n && n.code === p.code; })[0];
    rec.capped = !!(per && per.capped && !per.exhausted);
    clipThreadsLogPost_(rec);
    return rec;
  });
  report.cost = clipThreadsCost_(r, report.posts);
  clipThreadsConclude_(report);
  return report;
}

/** 網址之間用什麼隔都可以：半形／全形逗號、頓號、分號、空白、換行（中文輸入法常打出全形） */
var CLIP_THREADS_SPLIT_RE = /[\s,，、;；]+/;


/** 指令碼屬性的原文 → { items: [解析結果（照順序、同一個只留一次）], bad: [認不得的片段] } */
function clipThreadsProbeInputs_(raw) {
  var items = [];
  var bad = [];
  var seen = {};
  String(raw || '').split(CLIP_THREADS_SPLIT_RE).forEach(function (tok) {
    if (!tok) return;
    var p = clipThreadsParse_(tok);
    if (!p) { bad.push(tok); return; }
    var key = p.share ? 's:' + p.share : 'p:' + p.code;
    if (seen[key]) return;
    seen[key] = true;
    items.push(p);
  });
  return { items: items, bad: bad };
}

/** 只要已經是單篇貼文網址的（RUN_SUMMARY、status 列比對也用這支），最多 CLIP_THREADS_PROBE_MAX 篇 */
function clipThreadsProbeList_(raw) {
  return clipThreadsProbeInputs_(raw).items.filter(function (p) { return p.code; }).slice(0, CLIP_THREADS_PROBE_MAX);
}


function clipThreadsPropsHint_() {
  return '沒設 ' + CLIP_THREADS_PROBE_PROP + '（或裡面沒有認得的 Threads 網址）：專案設定 → 指令碼屬性，填最多 ' +
    CLIP_THREADS_PROBE_MAX + ' 個網址（逗號分隔，全形半形都可以；LINE 分享的 /share/ 短網址可以直接貼；至少 1 篇有圖、1 篇有串文），再執行一次';
}

/** 短網址先轉址（每個都印結果，是 PR-A 要不要另想辦法的依據）；轉完同一篇只留一次，最多 CLIP_THREADS_PROBE_MAX 篇 */
function clipThreadsProbePosts_(items, report) {
  var posts = [];
  var seen = {};
  items.forEach(function (p) {
    var post = p;
    if (p.share) {
      var r = clipThreadsResolveShare_(p.url);
      report.shares.push({ share: p.share, ok: r.ok, status: r.status, code: r.ok ? r.post.code : '', error: r.error });
      console.log('[短網址] ' + p.url + ' → ' + (r.ok ? '✅ ' + r.post.url + '（HTTP ' + r.status + '）' : '❌ ' + r.error));
      if (!r.ok) return;
      post = r.post;
    }
    if (seen[post.code] || posts.length >= CLIP_THREADS_PROBE_MAX) return;
    seen[post.code] = true;
    posts.push(post);
  });
  return posts;
}



function clipThreadsPostRecord_(post, items, ms) {
  var rec = { code: post.code, url: post.url, ok: false, error: '', textChars: 0, images: 0, imagesOk: 0, imageErrors: [],
    videos: 0, thread: 0, threadOrderOk: true, threadMethod: '', threadChars: 0, others: 0, authorOtherReplies: 0,
    rows: 0, replyRows: 0, ms: ms, capped: false };
  var status = items.filter(function (x) {
    if (!x || x.recordType !== 'status') return false;
    var n = clipThreadsProbeList_(x.url)[0];
    return n && n.code === post.code;
  })[0];
  var root = items.filter(function (x) { return x && x.recordType === 'post' && x.code === post.code; })[0];
  if (!root) {
    rec.error = status ? status.status + '（' + (status.reason || '') + '）' : 'Apify 結果裡找不到這篇的主文';
    return rec;
  }
  var replies = items.filter(function (x) { return x && x.recordType === 'reply' && x.rootPostCode === post.code; });
  var chain = clipThreadsAuthorChain_(post.code, replies);
  rec.rows = 1 + replies.length;
  rec.replyRows = replies.length;
  rec.textChars = String(root.text || '').length;
  rec.thread = chain.rows.length;
  rec.threadMethod = chain.method;
  rec.threadOrderOk = chain.orderOk;
  rec.threadChars = chain.rows.reduce(function (s, x) { return s + String(x.text || '').length; }, 0);
  rec.others = replies.filter(function (x) { return !x.isAuthor; }).length;
  rec.authorOtherReplies = replies.filter(function (x) { return x.isAuthor && x.replyType !== 'author_thread'; }).length;

  var own = [root].concat(chain.rows);
  var images = [];
  own.forEach(function (x) { images = images.concat(clipThreadsMedia_(x, 'images')); rec.videos += clipThreadsMedia_(x, 'videos').length; });
  rec.images = images.length;
  clipFetchAll_(images).forEach(function (res, i) {
    var type = res && res.res ? String(res.res.getBlob().getContentType() || '').split(';')[0] : '';
    if (res && res.status === 200 && /^image\//.test(type)) rec.imagesOk++;
    else rec.imageErrors.push('第 ' + (i + 1) + ' 張：' + (res ? (res.status === 200 ? '回的不是圖片（' + (type || '未知') + '）' : clipHead_(res)) : '沒有回應'));
  });
  rec.ok = (rec.textChars > 0 || rec.images > 0 || rec.videos > 0) && rec.imagesOk === rec.images;
  if (!rec.ok && !rec.error) rec.error = rec.imagesOk < rec.images ? '圖片下載不完整' : '沒有主文也沒有圖片';
  return rec;
}

function clipThreadsLogPost_(rec) {
  if (rec.error && !rec.rows) { console.log('[' + rec.code + '] ❌ ' + rec.error); return; }
  console.log('[' + rec.code + '] ' + (rec.ok ? '✅' : '❌') + '｜主文 ' + rec.textChars + ' 字｜圖片 ' + rec.imagesOk + '／' + rec.images +
    ' 張下載得到｜影片 ' + (rec.videos ? rec.videos + ' 支' : '無') +
    '｜作者串文 ' + rec.thread + ' 則（' + rec.threadChars + ' 字' + (rec.thread ? '，順序' + (rec.threadOrderOk ? '照 parentCode 串得起來' : '沒把握：照時間排') : '') + '）' +
    '｜混入別人留言 ' + rec.others + ' 則、作者回別人 ' + rec.authorOtherReplies + ' 則（都會濾掉，但有計費）' +
    '｜約 ' + rec.ms + 'ms' + (rec.capped ? '｜⚠️ 回覆被 ' + CLIP_THREADS_MAX_REPLIES + ' 列上限截斷，串文可能沒收完' : '') +
    (rec.error ? '｜' + rec.error : ''));
  rec.imageErrors.forEach(function (e) { console.log('    ' + e); });
}


/**
 * 費用：Apify 有回 usageTotalUsd 就用它，否則照列數×單價估。每月推估＝每篇 × CLIP_THREADS_MONTHLY_POSTS，
 * 再加上 IG 現況（apifyUsage 工作存的本月 Apify 用量），對 ADR-020 的每月 US$3 門檻
 */
function clipThreadsCost_(r, recs) {
  var rows = recs.reduce(function (s, x) { return s + x.replyRows; }, 0);
  var est = recs.length * CLIP_THREADS_USD_POST + rows * CLIP_THREADS_USD_REPLY;
  var runUsd = typeof r.usd === 'number' ? r.usd : est;
  var per = runUsd / Math.max(recs.length, 1);
  var usage = typeof clipsUsage_ === 'function' ? clipsUsage_() : null;
  var igUsd = usage && typeof usage.usd === 'number' ? usage.usd : 0;
  var monthly = per * CLIP_THREADS_MONTHLY_POSTS;
  var cap = typeof CLIPS_USAGE_RED_USD === 'number' ? CLIPS_USAGE_RED_USD : 3;
  return { runUsd: runUsd, estUsd: est, reported: typeof r.usd === 'number', perPostUsd: per, monthlyUsd: monthly, igUsd: igUsd,
    totalUsd: monthly + igUsd, cap: cap, withinCap: monthly + igUsd <= cap };
}

function clipThreadsConclude_(report) {
  var recs = report.posts;
  if (report.verdict !== 'fail') {
    if (!recs.length || recs.some(function (x) { return !x.ok; })) report.verdict = 'fail';
    else report.verdict = recs.some(function (x) { return x.thread > 0; }) ? 'ok' : 'main_only';
  }
  console.log('—— 總結（回貼到交棒頁執行日誌）——');
  if (recs.length) {
    var n = recs.length;
    console.log((recs.every(function (x) { return x.ok; }) ? '✅ ' : '❌ ') + '主文與圖片：' + recs.filter(function (x) { return x.ok; }).length + '／' + n + ' 篇收齊');
    var withThread = recs.filter(function (x) { return x.thread > 0; });
    console.log((withThread.length ? '✅ ' : '⚠️ ') + '作者串文：' + withThread.length + '／' + n + ' 篇抓得到' +
      (withThread.length ? '，順序' + (withThread.every(function (x) { return x.threadOrderOk; }) ? '都串得起來' : '有沒把握的（見上）') : '') +
      (recs.some(function (x) { return x.capped; }) ? '｜⚠️ 有篇被回覆上限截斷' : ''));
  }
  if (report.shares && report.shares.length) {
    var okN = report.shares.filter(function (x) { return x.ok; }).length;
    console.log((okN === report.shares.length ? '✅ ' : '❌ ') + '短網址轉址（GAS 打 threads.com）：' + okN + '／' + report.shares.length + ' 個成功' +
      (okN < report.shares.length ? '｜失敗原因見上面 [短網址]；PR-A 收 LINE 分享的網址要另想辦法' : ''));
  }
  var c = report.cost;
  if (c) {
    console.log((c.withinCap ? '✅ ' : '❌ ') + '費用：本次 US$' + c.runUsd.toFixed(4) + (c.reported ? '（Apify 回報）' : '（照列數估）') +
      '｜每篇約 US$' + c.perPostUsd.toFixed(4) + '｜每月 ' + CLIP_THREADS_MONTHLY_POSTS + ' 篇約 US$' + c.monthlyUsd.toFixed(3) +
      '＋IG 本月 US$' + c.igUsd.toFixed(3) + '＝US$' + c.totalUsd.toFixed(3) + (c.withinCap ? '，在 US$' + c.cap + ' 內' : '，超過 US$' + c.cap + '（D-4）'));
  }
  var line = { ok: '✅ 結論：可行（主文、圖片、作者串文都抓得到）→ 請 Neil 看完同意後開 PR-A',
    main_only: '⚠️ 結論：只能抓主文（沒有任何一篇抓到作者串文；若挑的那篇確實有串文，PR-A 走 D-6 退回路線）',
    fail: '❌ 結論：不可行 → 停在這裡回報 Neil，不要自行改用其他付費方案（D-4）',
    not_run: '❌ 結論：未測' }[report.verdict];
  console.log(line);
  if (c && !c.withinCap) console.log('⚠️ 推估費用超過 US$' + c.cap + '：即使可行，也要 Neil 決定要不要做');
}
