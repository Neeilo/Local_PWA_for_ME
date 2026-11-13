/**
 * ADR-027 PR-A — 圖書館 Threads 收藏（apps-script/clips.gs、line-router.gs 的「初始化」）
 *
 * 為什麼有這批測試：Threads 收藏比照 IG 收齊（主文、圖片、作者自己的接續串文合併），
 * 但入口一律是 LINE／App 分享的 /share/ 短網址，費用按筆計（別人的留言也算錢）。盯的事（交棒頁 PR-A 驗收＋Neil 2026-11-13 追加）：
 *   - 網址：threads.com／threads.net、有無 www、帶參數、結尾斜線、/share/ 短網址；個人頁不收；群組不收
 *   - webhook 不打外部；排程才轉址取貼文代碼；重複判斷用貼文代碼（不是短碼）
 *   - 串文合併只含作者自己的、順序正確；被截斷或順序沒把握 → done＋「串文可能不完整」、不重試
 *   - 別人的留言不進 caption、content.md、raw.json
 *   - 圖書館設定：IG／Threads 各自存不存圖片、影片（Threads 預設不存影片）
 *   - D-4（Neil 2026-11-13）：當月合計達 US$3 → IG 與 Threads 都暫停；「本月強制續抓」只對當月有效
 *   - 補抓（初始化）：只存連結的 Threads 轉成等待抓取，閱讀狀態、筆記、分類、AI、收藏時間都保留；只跑一次
 *   - 每輪 IG＋Threads 合計 ≤ 5 篇；自動 📝 文字辨識會挑到 Threads
 *
 * 測試只用合成資料（假帳號、假代碼、cdn.example），不放任何真實收藏（公開 repo）。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const DAD = 'Udad';      // 有 feat_clips，不是管理者
const TOK_ME = 'tok-me';
const TOK_DAD = 'tok-dad';
const TOKEN = 'apify_api_should-never-be-logged';
const FEATS = ['feat_tasks', 'feat_notes', 'feat_clips'];
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS);
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const MIN = 60000;

const SHARE_A = 'https://www.threads.com/share/ShrAAA01';
const SHARE_A2 = 'https://www.threads.com/share/ShrAAA02';   // 同一篇、再分享一次的另一個短碼
const SHARE_B = 'https://www.threads.com/share/ShrBBB01';
const POST_A = 'https://www.threads.com/@demo.user/post/TAAA111';
const POST_B = 'https://www.threads.com/@demo.user/post/TBBB222';
const IG = 'https://www.instagram.com/p/IGP111/';
const SHARES = {
  ShrAAA01: POST_A + '?xmt=AQF0demo', ShrAAA02: POST_A + '?xmt=AQF0other', ShrBBB01: '/@demo.user/post/TBBB222?xmt=AQF0demo'
};

/* ---------------------------------------------------------------------------- */
/* 合成的 Threads 爬蟲結果                                                         */
/* ---------------------------------------------------------------------------- */

const rootRow = (code, extra = {}) => ({
  recordType: 'post', code, url: 'https://www.threads.com/@demo.user/post/' + code, authorUsername: 'demo.user',
  text: '主文 ' + code + '\n第二行', timestamp: '2026-11-01T01:00:00Z', ...extra
});
const reply = (code, root, parent, opts = {}) => ({
  recordType: 'reply', code, rootPostCode: root, parentCode: parent, authorUsername: opts.user || 'demo.user',
  replyType: opts.type || 'author_thread', isAuthor: opts.isAuthor ?? true, text: opts.text || '串文 ' + code,
  timestamp: opts.ts || '2026-11-01T01:01:00Z', ...(opts.extra || {})
});

/** A：主文 2 張圖＋1 支影片、作者串文 2 則（第 2 則 1 張圖，故意倒序給）、陌生人留言 1 則、作者回陌生人 1 則 */
function threadA() {
  return [
    rootRow('TAAA111', { images: ['https://cdn.example/a1.jpg', 'https://cdn.example/a2.jpg'], videos: ['https://cdn.example/a.mp4'] }),
    reply('T2', 'TAAA111', 'T1', { ts: '2026-11-01T01:02:00Z', text: '第三段', extra: { images: ['https://cdn.example/t2.jpg'] } }),
    reply('X1', 'TAAA111', 'TAAA111', { user: 'stranger', type: 'reply', isAuthor: false, text: '陌生人的留言 SECRET' }),
    reply('T1', 'TAAA111', 'TAAA111', { ts: '2026-11-01T01:01:00Z', text: '第二段' }),
    reply('R1', 'TAAA111', 'X1', { type: 'reply', text: '作者回陌生人 SECRET2' })
  ];
}

function net({ threads = {}, igItems = {}, summary = {}, shareFail = false, limits = null } = {}) {
  const calls = [];
  const res = (status, body, type = 'application/json', headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      getResponseCode: () => status, getContentText: () => text, getHeaders: () => Object.assign({ 'Content-Type': type }, headers),
      getBlob: () => ({ name: '', getBytes: () => new Array(1000).fill(0), getContentType: () => type, setName(n) { this.name = n; return this; }, getName() { return this.name; } })
    };
  };
  const inputs = {};
  const fetch = (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.startsWith('https://api.apify.com/v2/acts/architekture~threads-replies-scraper/runs')) {
      inputs.threads = JSON.parse(opts.payload);
      return res(201, { data: { id: 'runT', status: 'SUCCEEDED', defaultDatasetId: 'dsT', defaultKeyValueStoreId: 'kvT', usageTotalUsd: 0.001 } });
    }
    if (url.startsWith('https://api.apify.com/v2/acts/')) {
      inputs.ig = JSON.parse(opts.payload);
      return res(201, { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.001 } });
    }
    if (url.startsWith('https://api.apify.com/v2/datasets/dsT/items')) {
      const codes = inputs.threads.postUrls.map((u) => u.split('/').pop());
      return res(200, codes.flatMap((c) => threads[c] || [{ recordType: 'status', url: 'https://www.threads.com/t/' + c, status: 'NOT_FOUND', reason: 'gone' }]));
    }
    if (url.startsWith('https://api.apify.com/v2/datasets/ds1/items')) {
      return res(200, inputs.ig.postUrls.map((u) => igItems[u.split('/')[4]]).filter(Boolean));
    }
    if (url.startsWith('https://api.apify.com/v2/key-value-stores/kvT/records/RUN_SUMMARY')) {
      return res(200, { status: 'COMPLETE', perPost: Object.keys(summary).map((c) => Object.assign({ url: 'https://www.threads.com/@demo.user/post/' + c }, summary[c])) });
    }
    if (url.startsWith('https://api.apify.com/v2/users/me/limits')) return limits ? res(200, limits) : res(500, 'boom', 'text/plain');
    if (url.startsWith('https://www.threads.com/share/')) {
      if (shareFail) return res(200, '<html>login</html>', 'text/html');
      const loc = SHARES[url.split('/share/')[1]];
      return loc ? res(302, '', 'text/html', { Location: loc }) : res(200, '<html>login</html>', 'text/html');
    }
    if (url.startsWith('https://cdn.example/')) return /\.mp4/.test(url) ? res(200, 'mp4', 'video/mp4') : res(200, 'img', 'image/jpeg');
    throw new Error('沒預期的網址 ' + url);
  };
  return { calls, inputs, UrlFetchApp: { fetch, fetchAll: (reqs) => reqs.map((r) => fetch(typeof r === 'string' ? r : r.url, r)) } };
}

function drive() {
  let seq = 0;
  const byId = {};
  const files = [];
  const mkFolder = (name, parent) => {
    const f = {
      id: 'fd' + (++seq), name, parent, children: [], files: [],
      getId: () => f.id, getName: () => f.name,
      getFoldersByName: (n) => { const hit = f.children.filter((c) => c.name === n); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
      createFolder: (n) => { const c = mkFolder(n, f); f.children.push(c); return c; },
      createFile: (blob) => {
        const file = { id: 'fi' + (++seq), name: blob.getName ? blob.getName() : blob.name, folder: f, trashed: false, data: blob.data,
          getId() { return this.id; }, getName() { return this.name; },
          setSharing() { return this; }, setTrashed(t) { this.trashed = t; return this; } };
        f.files.push(file); files.push(file); byId[file.id] = file;
        return file;
      },
      getFiles: () => { const live = f.files.filter((x) => !x.trashed); let i = 0; return { hasNext: () => i < live.length, next: () => live[i++] }; }
    };
    byId[f.id] = f;
    return f;
  };
  const root = mkFolder('我的雲端硬碟', null);
  return {
    files,
    DriveApp: {
      getRootFolder: () => root,
      getFolderById: (id) => { if (!byId[id] || !byId[id].children) throw new Error('找不到資料夾 ' + id); return byId[id]; },
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' }
    }
  };
}

function env(opts = {}) {
  const n = net(opts);
  const d = drive();
  const replies = [];
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H,
      [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
      [DAD, '爸爸', 'TRUE', '', 'TRUE', 'TRUE', 'TRUE']]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'priority', 'is_completed', 'line_id', 'kind', 'due_date', 'created_at', 'origin_chat', 'del']]),
    logs: new FakeSheet('logs', [LOG_H])
  };
  const e = loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs', 'lab-clip.gs'],
    tokens: { [TOK_ME]: ME, [TOK_DAD]: DAD }, sheets,
    properties: Object.assign({ APIFY_TOKEN: TOKEN }, opts.props || {}),
    overrides: { UrlFetchApp: n.UrlFetchApp, DriveApp: d.DriveApp, lineReply_: (_t, text) => replies.push(text) }
  });
  e.call('ensureClipsSheet_');
  e.net = n; e.drive = d; e.replies = replies;
  return e;
}

const DM = (userId = ME) => ({ type: 'user', userId });
const say = (e, text, source = DM()) => e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });
const rows = (e) => e.sheets.clips.toRecords();
const live = (e) => rows(e).filter((r) => String(r.del).toUpperCase() !== 'TRUE');
const NOW = new Date(Date.UTC(2026, 10, 13, 4, 0, 0));
const run = (e, now = NOW, budget = 240000) => e.call('runClipsJob_', now, { budgetLeft: () => budget });
const post = (e, body, tok = TOK_ME) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
const threadRuns = (e) => e.net.calls.filter((c) => c.url.includes('/acts/architekture~threads-replies-scraper/runs'));
const igRuns = (e) => e.net.calls.filter((c) => c.url.includes('/acts/') && !c.url.includes('threads-replies'));
const liveFiles = (e, rec) => e.drive.files.filter((f) => !f.trashed && f.folder.getId() === rec.drive_folder_id);

/* ========================================================================== */
describe('網址辨識與登記（webhook 只登記、不打外部）', () => {
  const ex = (text) => env().call('clipExtractUrls_', text);

  test('threads.com／threads.net、有無 www、帶參數、結尾斜線 → 同一篇；/share/ 短網址照原樣排隊', () => {
    const out = ex(['https://threads.net/@demo.user/post/TAAA111?xmt=1', 'https://www.threads.com/@demo.user/post/TAAA111/', SHARE_A + '?x=1'].join(' '));
    assert.deepEqual(out, [
      { url: POST_A, shortcode: 'TAAA111', kind: 'threads' },
      { url: SHARE_A, shortcode: '', kind: 'threads' }
    ]);
  });

  test('個人頁、搜尋頁不是貼文 → 只存連結', () => {
    const e = env();
    say(e, 'https://www.threads.com/@demo.user 跟 https://www.threads.com/search?q=x');
    assert.deepEqual(rows(e).map((r) => r.kind), ['link', 'link']);
  });

  test('LINE 一對一貼短網址：一列 pending、回「收到 ✅」、不打外部；群組貼不收', () => {
    const e = env();
    say(e, '這篇 ' + SHARE_A);
    assert.equal(e.replies.at(-1), '收到 ✅');
    const r = rows(e);
    assert.deepEqual([r[0].kind, r[0].status, r[0].url, r[0].shortcode], ['threads', 'pending', SHARE_A, '']);
    assert.equal(e.net.calls.length, 0);
    say(e, SHARE_B, { type: 'group', groupId: 'Cfam', userId: ME });
    assert.equal(rows(e).length, 1);
  });

  test('PWA「＋ 加網址」接受 Threads', () => {
    const e = env();
    const r = post(e, { action: 'clipAdd', url: SHARE_A, trigger: 'write' });
    assert.equal(r.success, true);
    assert.equal(r.kind, 'threads');
  });
});

/* ========================================================================== */
describe('排程：轉址、收齊、串文合併', () => {

  test('短網址轉址 → 貼文網址與代碼寫回；主文＋作者串文依序合併；別人的留言哪裡都沒有', () => {
    const e = env({ threads: { TAAA111: threadA() } });
    say(e, SHARE_A);
    run(e);
    const r = rows(e)[0];
    assert.equal(r.status, 'done');
    assert.equal(r.url, POST_A);
    assert.equal(r.shortcode, 'TAAA111');
    assert.equal(r.author, 'demo.user');
    assert.equal(r.caption, '主文 TAAA111\n第二行\n\n── 串文 2／3 ──\n第二段\n\n── 串文 3／3 ──\n第三段');
    assert.equal(r.error, '');
    const input = e.net.inputs.threads;
    assert.deepEqual(input.postUrls, [POST_A]);
    assert.equal(input.includeAuthorThread, true);
    assert.ok(input.maxRepliesPerPost > 0);
    assert.match(threadRuns(e)[0].url, /maxTotalChargeUsd=/);
    const files = liveFiles(e, r);
    const raw = files.find((f) => f.name === 'raw.json').data;
    const md = files.find((f) => f.name === 'content.md').data;
    for (const text of [r.caption, raw, md]) {
      assert.doesNotMatch(String(text), /SECRET/, '陌生人的留言、作者回陌生人的都不存');
    }
    assert.match(md, /平台: Threads/);
    assert.match(md, /含作者串文 2 則/);
  });

  test('圖片照主文→串文的順序存；預設不存影片', () => {
    const e = env({ threads: { TAAA111: threadA() } });
    say(e, SHARE_A);
    run(e);
    const r = rows(e)[0];
    assert.equal(Number(r.media_expected), 3);
    assert.equal(Number(r.media_saved), 3);
    assert.equal(JSON.parse(r.image_ids).length, 3);
    assert.deepEqual(liveFiles(e, r).map((f) => f.name), ['01.jpg', '02.jpg', '03.jpg', 'raw.json', 'content.md']);
    assert.ok(!e.net.calls.some((c) => c.url.endsWith('.mp4')), '影片連下載都不下載');
    assert.equal(r.video_saved, '');
  });

  test('沒有串文 → 只有主文、沒有分隔標題', () => {
    const e = env({ threads: { TBBB222: [rootRow('TBBB222')] } });
    say(e, POST_B);
    run(e);
    assert.equal(rows(e)[0].caption, '主文 TBBB222\n第二行');
    assert.equal(rows(e)[0].status, 'done');
  });

  test('回覆被上限截斷 → done＋「串文可能不完整」，不重試', () => {
    const e = env({ threads: { TAAA111: threadA() }, summary: { TAAA111: { capped: true, exhausted: false } } });
    say(e, POST_A);
    run(e);
    const r = rows(e)[0];
    assert.equal(r.status, 'done');
    assert.equal(r.error, '串文可能不完整');
    run(e, new Date(NOW.getTime() + 3 * 3600000));
    assert.equal(threadRuns(e).length, 1, '不會重跑');
  });

  test('串文順序串不起來（全掛在主文底下）→ 照時間排＋「串文可能不完整」', () => {
    const rowsT = [rootRow('TAAA111'),
      reply('T2', 'TAAA111', 'TAAA111', { ts: '2026-11-01T01:02:00Z', text: '後' }),
      reply('T1', 'TAAA111', 'TAAA111', { ts: '2026-11-01T01:01:00Z', text: '前' })];
    const e = env({ threads: { TAAA111: rowsT } });
    say(e, POST_A);
    run(e);
    const r = rows(e)[0];
    assert.match(r.caption, /串文 2／3 ──\n前\n\n── 串文 3／3 ──\n後/);
    assert.equal(r.error, '串文可能不完整');
  });

  test('短網址轉不出來（被導去登入頁）→ 算一次失敗、排重試；不打 Apify', () => {
    const e = env({ shareFail: true });
    say(e, SHARE_A);
    run(e);
    const r = rows(e)[0];
    assert.equal(r.status, 'pending');
    assert.equal(Number(r.attempts), 1);
    assert.match(r.error, /短網址轉不出貼文/);
    assert.equal(threadRuns(e).length, 0);
  });

  test('Threads 找不到這篇（status 列）→ 失敗走既有重試', () => {
    const e = env({ threads: {} });
    say(e, POST_A);
    run(e);
    const r = rows(e)[0];
    assert.equal(r.status, 'pending');
    assert.match(r.error, /NOT_FOUND/);
  });

  test('費用照列數×單價估、記進本月 Threads 用量（run 的 usageTotalUsd 不含按筆計費）', () => {
    const e = env({ threads: { TAAA111: threadA() } });
    say(e, POST_A);
    run(e);
    const u = JSON.parse(e.properties.clips_threads_usage);
    assert.equal(u.month, '2026-11');
    assert.equal(u.posts, 1);
    assert.equal(u.usd, 0.011, '1 列主文 US$0.001＋4 列回覆 US$0.0025×4');
  });
});

/* ========================================================================== */
describe('再分享、合併、每輪上限', () => {

  test('同一篇用兩個不同短碼分享 → 轉址後用貼文代碼判重：只抓一次', () => {
    const e = env({ threads: { TAAA111: threadA() } });
    say(e, SHARE_A);
    say(e, SHARE_A2);
    run(e);
    assert.equal(live(e).length, 1);
    assert.equal(live(e)[0].status, 'done');
    assert.equal(e.net.inputs.threads.postUrls.length, 1);
  });

  test('先失敗、再分享一次 → 重跑原本那列', () => {
    const threads = {};
    const e = env({ threads });
    say(e, POST_A);
    for (let i = 0; i < 4; i++) run(e, new Date(NOW.getTime() + i * 3 * 3600000));
    const first = rows(e)[0];
    assert.equal(first.status, 'failed');
    threads.TAAA111 = threadA();                            // 後來抓得到了
    say(e, SHARE_A);
    run(e, new Date(NOW.getTime() + 20 * 3600000));
    assert.equal(live(e).length, 1, '新列合併掉');
    assert.equal(live(e)[0].id, first.id);
    assert.equal(live(e)[0].status, 'done');
  });

  test('IG＋Threads 同一輪 → 兩次 Apify run，合計 ≤ 5 篇', () => {
    const threads = {};
    const igItems = {};
    const texts = [];
    for (let i = 1; i <= 4; i++) { threads['TH' + i] = [rootRow('TH' + i)]; texts.push('https://www.threads.com/t/TH' + i); }
    for (let i = 1; i <= 4; i++) {
      igItems['IG' + i] = { shortCode: 'IG' + i, caption: 'x', ownerUsername: 'someone', childPosts: [{ type: 'Image', displayUrl: 'https://cdn.example/ig' + i + '.jpg' }] };
      texts.push('https://www.instagram.com/p/IG' + i + '/');
    }
    const e = env({ threads, igItems });
    say(e, texts.join('\n'));
    run(e);
    assert.equal(threadRuns(e).length, 1);
    assert.equal(igRuns(e).length, 1);
    assert.equal(e.net.inputs.threads.postUrls.length + e.net.inputs.ig.postUrls.length, 5);
    assert.equal(rows(e).filter((r) => r.status === 'done').length, 5);
  });

  test('自動 📝 文字辨識會挑到收齊且有圖的 Threads', () => {
    const e = env({ threads: { TAAA111: threadA() } });
    say(e, POST_A);
    run(e);
    assert.equal(e.call('clipOcrAutoWanted_', rows(e)[0], {}), true);
  });
});

/* ========================================================================== */
describe('圖書館設定：存不存圖片／影片（管理者）', () => {

  test('預設：IG 都存、Threads 存圖不存影片；非管理者看不到也改不了', () => {
    const e = env();
    const r = post(e, { action: 'clipSettings', trigger: 'manual' });
    assert.equal(r.success, true);
    assert.deepEqual(r.settings, { ig_images: true, ig_videos: true, threads_images: true, threads_videos: false, force_month: '' });
    assert.equal(post(e, { action: 'clipSettings', trigger: 'manual' }, TOK_DAD).error, 'forbidden');
    assert.equal(post(e, { action: 'clipSettingsSet', key: 'threads_videos', value: true, trigger: 'write' }, TOK_DAD).error, 'forbidden');
  });

  test('改設定：寫指令碼屬性與 logs；不認得的鍵、不是布林都擋下', () => {
    const e = env();
    const r = post(e, { action: 'clipSettingsSet', key: 'threads_videos', value: true, trigger: 'write' });
    assert.equal(r.success, true);
    assert.equal(JSON.parse(e.properties.clips_settings).threads_videos, true);
    assert.ok(e.transactions.some((t) => /Threads 存影片：開/.test(String(t[3]))));
    assert.equal(post(e, { action: 'clipSettingsSet', key: 'evil', value: true, trigger: 'write' }).error, 'invalid_key');
    assert.equal(post(e, { action: 'clipSettingsSet', key: 'ig_images', value: 'yes', trigger: 'write' }).error, 'invalid_value');
  });

  test('Threads 存影片打開 → 存 video.mp4', () => {
    const e = env({ threads: { TAAA111: threadA() } });
    post(e, { action: 'clipSettingsSet', key: 'threads_videos', value: true, trigger: 'write' });
    say(e, POST_A);
    run(e);
    const r = rows(e)[0];
    assert.equal(r.video_saved, 'TRUE');
    assert.ok(liveFiles(e, r).some((f) => f.name === 'video.mp4'));
  });

  test('Threads 存圖片關掉 → 一張都不存、仍算收齊', () => {
    const e = env({ threads: { TAAA111: threadA() } });
    post(e, { action: 'clipSettingsSet', key: 'threads_images', value: false, trigger: 'write' });
    say(e, POST_A);
    run(e);
    const r = rows(e)[0];
    assert.equal(r.status, 'done');
    assert.equal(Number(r.media_saved), 0);
    assert.ok(!e.net.calls.some((c) => c.url.startsWith('https://cdn.example/')));
  });

  test('IG 存圖片關掉 → 貼文一張都不存、仍算收齊；IG 存影片關掉 → Reels 不存 video.mp4', () => {
    const igItems = {
      IGP111: { shortCode: 'IGP111', caption: 'x', ownerUsername: 'someone', childPosts: [{ type: 'Image', displayUrl: 'https://cdn.example/p.jpg' }] },
      Rrr1: { shortCode: 'Rrr1', caption: 'r', ownerUsername: 'someone', type: 'Video', displayUrl: 'https://cdn.example/cover.jpg', videoUrl: 'https://cdn.example/r.mp4' }
    };
    const e = env({ igItems });
    post(e, { action: 'clipSettingsSet', key: 'ig_images', value: false, trigger: 'write' });
    post(e, { action: 'clipSettingsSet', key: 'ig_videos', value: false, trigger: 'write' });
    say(e, IG + '\nhttps://www.instagram.com/reel/Rrr1/');
    run(e);
    const [p, reel] = rows(e);
    assert.equal(p.status, 'done');
    assert.equal(Number(p.media_saved), 0);
    assert.equal(reel.status, 'done');
    assert.equal(reel.video_saved, '');
    assert.ok(!e.net.calls.some((c) => c.url.startsWith('https://cdn.example/')));
  });
});

/* ========================================================================== */
describe('D-4：當月合計達 US$3 → IG 與 Threads 都暫停；本月強制續抓', () => {
  const usage = (usd, at = NOW.toISOString()) => JSON.stringify({ usd, at, checked_at: at, error: '', done: 0, total: 0, rate: null });

  test('達上限：IG 與 Threads 都不抓、不打 Apify；logs 一個月只寫一次', () => {
    const e = env({ props: { clips_usage: usage(3.1) }, threads: { TAAA111: threadA() } });
    say(e, POST_A + '\n' + IG);
    const out = run(e);
    assert.equal(out.reason, 'cost_cap');
    assert.equal(e.net.calls.length, 0);
    assert.ok(rows(e).every((r) => r.status === 'pending'));
    run(e, new Date(NOW.getTime() + 5 * MIN));
    assert.equal(e.transactions.filter((t) => /達上限/.test(String(t[3]))).length, 1);
  });

  test('Threads 估算用量自己就達上限也算（帳號用量可能還沒更新）', () => {
    const e = env({ props: { clips_threads_usage: JSON.stringify({ month: '2026-11', usd: 3, posts: 60 }) } });
    say(e, POST_A);
    assert.equal(run(e).reason, 'cost_cap');
  });

  test('本月強制續抓 → 照抓；上個月開的不算', () => {
    const e = env({ props: { clips_usage: usage(3.1) }, threads: { TAAA111: threadA() } });
    say(e, POST_A);
    const set = post(e, { action: 'clipSettingsSet', key: 'force', value: true, trigger: 'write' });
    assert.equal(set.success, true);
    assert.equal(set.gate.forced, true);
    assert.equal(set.gate.paused, false);
    const stale = env({ props: { clips_usage: usage(3.1), clips_settings: JSON.stringify({ force_month: '2026-10' }) } });
    say(stale, POST_A);
    assert.equal(run(stale).reason, 'cost_cap');
  });

  test('上個月的帳號用量不算進本月', () => {
    const e = env({ props: { clips_usage: usage(5, '2026-10-30T00:00:00Z') }, threads: { TAAA111: threadA() } });
    say(e, POST_A);
    run(e);
    assert.equal(rows(e)[0].status, 'done');
  });

  test('閘門現況分開給 IG 與 Threads 的用量', () => {
    const e = env({ props: { clips_usage: usage(1.2), clips_threads_usage: JSON.stringify({ month: '2026-11', usd: 0.5, posts: 10 }) } });
    const g = e.call('clipsCostGate_', NOW);
    assert.deepEqual([g.usd, g.threads_usd, g.ig_usd, g.paused], [1.2, 0.5, 0.7, false]);
  });

  test('開機：管理者的 clips_usage 帶閘門現況', () => {
    const e = env({ props: { clips_usage: usage(3.1) } });
    const boot = post(e, { action: 'boot', core: true, trigger: 'cold' });
    assert.equal(boot.clips_usage.gate.paused, true);
  });
});

/* ========================================================================== */
describe('D-3：「初始化」補抓只存連結的 Threads', () => {
  function seeded() {
    const e = env();
    say(e, 'https://www.facebook.com/a/posts/1');
    // 舊資料：ADR-027 以前 Threads 只存連結（kind／status＝link）
    const H = e.sheets.clips.values[0];
    const add = (vals) => e.sheets.clips.values.push(H.map((h) => (vals[h] == null ? '' : vals[h])));
    add({ id: 'old1', line_id: ME, url: SHARE_A, kind: 'link', status: 'link', read_status: 'read', last_read_at: '2026-11-01T00:00:00Z',
      note: '我的筆記', note_revision: 2, category: '投資', ai_output: 'AI 摘要', created_at: '2026-10-20T00:00:00Z', collected_at: '2026-10-20T00:00:00Z' });
    add({ id: 'old2', line_id: ME, url: 'https://www.threads.net/@demo.user/post/TBBB222?xmt=1', kind: 'link', status: 'link' });
    add({ id: 'old3', line_id: ME, url: 'https://www.threads.com/@demo.user', kind: 'link', status: 'link' });
    add({ id: 'old4', line_id: ME, url: 'https://www.instagram.com/someone/', kind: 'link', status: 'link' });
    add({ id: 'old5', line_id: ME, url: POST_A, kind: 'link', status: 'link', del: 'TRUE' });
    return e;
  }
  const byId = (e, id) => rows(e).find((r) => r.id === id);

  test('Threads 貼文與短網址 → pending；欄位都保留；個人頁、IG、其他網域、刪掉的不動', () => {
    const e = seeded();
    const out = e.call('clipsThreadsBackfill_');
    assert.equal(out.count, 2);
    const a = byId(e, 'old1');
    assert.deepEqual([a.kind, a.status, a.url, a.shortcode], ['threads', 'pending', SHARE_A, '']);
    assert.deepEqual([a.read_status, a.last_read_at, a.note, String(a.note_revision), a.category, a.ai_output, a.created_at, a.collected_at],
      ['read', '2026-11-01T00:00:00Z', '我的筆記', '2', '投資', 'AI 摘要', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z']);
    const b = byId(e, 'old2');
    assert.deepEqual([b.kind, b.url, b.shortcode], ['threads', POST_B, 'TBBB222']);
    for (const id of ['old3', 'old4', 'old5']) assert.equal(byId(e, id).kind, 'link', id + ' 不動');
    assert.equal(rows(e)[0].kind, 'link', 'FB 不動');
  });

  test('只跑一次：再跑回「已補過」', () => {
    const e = seeded();
    e.call('clipsThreadsBackfill_');
    assert.equal(e.call('clipsThreadsBackfill_').already, true);
  });

  test('初始化有這一步，回覆寫明補了幾篇', () => {
    const e = seeded();
    const step = e.read('initSteps_().filter(function (s) { return /Threads 補抓/.test(s.label); })[0]');
    assert.ok(step);
    const r = e.read('initSteps_().filter(function (s) { return /Threads 補抓/.test(s.label); })[0].run()');
    assert.match(r.text, /補抓 2 篇/);
  });
});

/* ========================================================================== */
describe('成功率：Threads 另算', () => {
  test('clipsSuccessRate_ 可以只算 Threads', () => {
    const e = env();
    const at = NOW.toISOString();
    const recs = [
      { kind: 'threads', status: 'done', collected_at: at }, { kind: 'threads', status: 'failed', collected_at: at },
      { kind: 'post', status: 'done', collected_at: at }
    ];
    assert.deepEqual(e.call('clipsSuccessRate_', recs, NOW.getTime(), 'threads'), { done: 1, total: 2, rate: 0.5 });
    assert.equal(e.call('clipsSuccessRate_', recs, NOW.getTime()).total, 3);
  });
});

/* ========================================================================== */
describe('安全', () => {
  test('APIFY_TOKEN 不出現在網址、logs、Sheet、Drive', () => {
    const e = env({ threads: { TAAA111: threadA() } });
    say(e, SHARE_A);
    run(e);
    e.net.calls.forEach((c) => assert.ok(!c.url.includes(TOKEN)));
    const dump = JSON.stringify([e.logs, e.transactions, rows(e), e.drive.files.map((f) => f.data)]);
    assert.ok(!dump.includes(TOKEN));
  });
});
