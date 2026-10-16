/**
 * ADR-020 RD-1 — 收藏搜集器：後端＋LINE（apps-script/clips.gs）
 *
 * 為什麼有這批測試：分享一個 IG 網址到 LINE，就要在幾分鐘內把全文＋每一張圖收進 Drive。
 * webhook 只登記（不能被 Apify＋下載的 20 幾秒卡住），排程總管每輪最多收 5 篇。
 * 盯的事（對照交棒頁 RD-1 驗收）：
 *   - 抽網址：前後夾文字、多個網址、?igsh=／?img_index=、m.、帳號前綴、reel；非 IG 不登記；Threads 回不支援
 *   - 群組貼 IG 網址不登記、不回覆；沒 feat_clips 不登記；既有指令不受影響
 *   - 合併兩種情況；重試間隔與最終 partial／failed；張數不符算失敗；無 caption 算成功
 *   - 每輪最多 5 篇、預算用完就停；content.md 產生器是純函式；只有圖片檔開分享
 *   - APIFY_TOKEN 不出現在任何 log 輸出
 *   - PWA：只讀得到自己的列；重跑／刪除只限擁有者；一般 upsert 寫不進 clips
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';      // 沒有 feat_clips
const DAD = 'Udad';      // 有 feat_clips，但不是擁有者
const TOK_ME = 'tok-me';
const TOK_DAD = 'tok-dad';
const TOKEN = 'apify_api_should-never-be-logged';
const FEATS = ['feat_tasks', 'feat_notes', 'feat_clips'];
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS);
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const CAPTION = '第一行重點\n\n第二行 很長的內文';
const MIN = 60000;

const P1 = 'https://www.instagram.com/p/AAA111/';
const P2 = 'https://www.instagram.com/p/BBB222/';

/* ---------------------------------------------------------------------------- */
/* 假的 Apify＋圖片 CDN＋Drive                                                    */
/* ---------------------------------------------------------------------------- */

function item(code, n = 3, extra = {}) {
  return Object.assign({
    shortCode: code, url: 'https://www.instagram.com/p/' + code + '/', caption: CAPTION, ownerUsername: 'someone',
    timestamp: '2026-10-01T03:04:05.000Z', type: 'Sidecar',
    childPosts: Array.from({ length: n }, (_, i) => ({ type: 'Image', displayUrl: 'https://cdn.example/' + code + '/' + (i + 1) + '.jpg?oe=X' }))
  }, extra);
}

/** items：shortcode → Apify 回的那一筆；fail：哪些圖片網址回 403 */
function net({ items = {}, fail = [] } = {}) {
  const calls = [];
  const res = (status, body, type = 'application/json') => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      getResponseCode: () => status, getContentText: () => text,
      getBlob: () => ({ name: '', getBytes: () => new Array(1000).fill(0), getContentType: () => type, setName(n) { this.name = n; return this; }, getName() { return this.name; } })
    };
  };
  let lastInput = null;
  const fetch = (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.startsWith('https://api.apify.com/v2/acts/')) {
      lastInput = JSON.parse(opts.payload);
      return res(201, { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.001 } });
    }
    if (url.startsWith('https://api.apify.com/v2/datasets/ds1/items')) {
      const want = (lastInput.postUrls || []).map((u) => u.split('/')[4]);
      return res(200, want.map((c) => items[c]).filter(Boolean));
    }
    if (url.startsWith('https://cdn.example/')) return fail.some((f) => url.includes(f)) ? res(403, 'nope', 'text/html') : res(200, 'img', 'image/jpeg');
    throw new Error('沒預期的網址 ' + url);
  };
  return {
    calls,
    fail,                                      // 測試可以中途清空：模擬「後來下載得到了」
    input: () => lastInput,
    UrlFetchApp: { fetch, fetchAll: (reqs) => reqs.map((r) => fetch(typeof r === 'string' ? r : r.url, r)) }
  };
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
        const file = { id: 'fi' + (++seq), name: blob.getName ? blob.getName() : blob.name, folder: f, shared: null, trashed: false, contentType: blob.contentType || (blob.getContentType && blob.getContentType()), data: blob.data,
          getId() { return this.id; }, getName() { return this.name; },
          setSharing(a, p) { this.shared = [a, p]; return this; }, setTrashed(t) { this.trashed = t; return this; } };
        f.files.push(file); files.push(file); byId[file.id] = file;
        return file;
      },
      getFiles: () => { const live = f.files.filter((x) => !x.trashed); let i = 0; return { hasNext: () => i < live.length, next: () => live[i++] }; }
    };
    byId[f.id] = f;
    return f;
  };
  const root = mkFolder('我的雲端硬碟', null);
  const path = (f) => (f.parent && f.parent !== root ? path(f.parent) + '/' : '') + f.name;
  return {
    files, root, path,
    DriveApp: {
      getRootFolder: () => root,
      getFolderById: (id) => { if (!byId[id] || !byId[id].children) throw new Error('找不到資料夾 ' + id); return byId[id]; },
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' }
    }
  };
}

function env({ items = {}, fail = [], users = null, clips = null, props = {} } = {}) {
  const n = net({ items, fail });
  const d = drive();
  const replies = [];
  const sheets = {
    line_users: new FakeSheet('line_users', users || [USER_H,
      [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
      [MOM, '媽媽', 'TRUE', '', 'TRUE', 'TRUE', ''],
      [DAD, '爸爸', 'TRUE', '', 'TRUE', 'TRUE', 'TRUE']]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'priority', 'is_completed', 'line_id', 'kind', 'due_date', 'created_at', 'origin_chat', 'del']]),
    logs: new FakeSheet('logs', [LOG_H])
  };
  if (clips) sheets.clips = clips;
  const e = loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs', 'lab-clip.gs'],
    tokens: { [TOK_ME]: ME, [TOK_DAD]: DAD }, sheets,
    properties: Object.assign({ APIFY_TOKEN: TOKEN }, props),
    overrides: { UrlFetchApp: n.UrlFetchApp, DriveApp: d.DriveApp, lineReply_: (_t, text) => replies.push(text) }
  });
  if (!clips) e.call('ensureClipsSheet_');
  e.net = n; e.drive = d; e.replies = replies;
  return e;
}

const DM = (userId = ME) => ({ type: 'user', userId });
const say = (e, text, source = DM()) => e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });
const rows = (e) => e.sheets.clips.toRecords();
const live = (e) => rows(e).filter((r) => String(r.del).toUpperCase() !== 'TRUE');
const run = (e, now = new Date(), budget = 240000) => e.call('runClipsJob_', now, { budgetLeft: () => budget });
const post = (e, body, tok = TOK_ME) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
const apifyCalls = (e) => e.net.calls.filter((c) => c.url.includes('api.apify.com/v2/acts/'));

/* ========================================================================== */
describe('抽網址（純函式）', () => {
  const ex = (text) => env().call('clipExtractUrls_', text);

  test('前後夾文字、帶 ?igsh=／?img_index=：收成乾淨網址', () => {
    assert.deepEqual(ex('看這篇 https://www.instagram.com/p/AAA111/?igsh=MWx0eXo%3D 很讚'),
      [{ url: P1, shortcode: 'AAA111', kind: 'post' }]);
    assert.deepEqual(ex('https://instagram.com/p/AAA111?img_index=3').map((x) => x.url), [P1]);
  });

  test('m.、帳號前綴、reel／reels／tv 都認得；類型分成 post／reel', () => {
    assert.equal(ex('https://m.instagram.com/someone/p/AAA111/')[0].url, P1);
    assert.deepEqual(ex('https://www.instagram.com/reel/Cabc_12-3/?utm_source=ig_web'), [{ url: 'https://www.instagram.com/reel/Cabc_12-3/', shortcode: 'Cabc_12-3', kind: 'reel' }]);
    assert.equal(ex('https://www.instagram.com/reels/Cabc/')[0].kind, 'reel');
    assert.equal(ex('https://www.instagram.com/tv/Ctv1/')[0].kind, 'post');
  });

  test('一則多個網址 → 多筆、照順序；同一篇在同一則重複只算一筆', () => {
    const out = ex('先看 ' + P1 + ' 再看\n' + P2 + '?igsh=x 還有 ' + P1);
    assert.deepEqual(out.map((x) => x.shortcode), ['AAA111', 'BBB222']);
  });

  test('不是 IG 貼文 → 空；Threads／FB／X 另外認得（回「目前只支援 Instagram」用）', () => {
    const e = env();
    assert.deepEqual(e.call('clipExtractUrls_', 'https://www.instagram.com/someone/ 跟 https://example.com/p/abc/'), []);
    for (const u of ['https://www.threads.net/@a/post/xyz', 'https://www.threads.com/@a/post/xyz', 'https://www.facebook.com/share/p/1', 'https://fb.watch/abc', 'https://x.com/a/status/1', 'https://twitter.com/a/status/1']) {
      assert.equal(e.call('clipOtherSocial_', '看 ' + u), true, u);
    }
    assert.equal(e.call('clipOtherSocial_', '看 https://example.com/'), false);
  });
});

/* ========================================================================== */
describe('LINE 登記（webhook 只登記、不抓取）', () => {

  test('一對一＋有 feat_clips：寫一列 pending、回「收到 ✅」；不呼叫 Apify', () => {
    const e = env();
    say(e, '這篇好 ' + P1 + '?igsh=abc');
    assert.equal(e.replies.at(-1), '收到 ✅');
    const r = rows(e);
    assert.equal(r.length, 1);
    assert.equal(r[0].status, 'pending');
    assert.equal(r[0].url, P1);
    assert.equal(r[0].shortcode, 'AAA111');
    assert.equal(r[0].kind, 'post');
    assert.equal(r[0].line_id, ME);
    assert.equal(r[0].source_text, '這篇好 ' + P1 + '?igsh=abc');
    assert.equal(Number(r[0].attempts), 0);
    assert.ok(r[0].collected_at && r[0].last_collected_at && r[0].created_at);
    assert.equal(r[0].category, '');
    assert.equal(e.net.calls.length, 0, 'webhook 不打任何外部網址');
  });

  test('一則兩個網址 → 兩列；回覆講幾篇', () => {
    const e = env();
    say(e, P1 + '\n' + P2);
    assert.equal(rows(e).length, 2);
    assert.match(e.replies.at(-1), /^收到 ✅（2 篇）$/);
  });

  test('不在 webhook 去重：同一篇分享兩次就兩列（合併交給排程）', () => {
    const e = env();
    say(e, P1);
    say(e, P1);
    assert.equal(rows(e).length, 2);
  });

  test('群組貼 IG 網址：不登記、不回覆', () => {
    const e = env();
    say(e, P1, { type: 'group', groupId: 'Cfam', userId: ME });
    assert.equal(rows(e).length, 0);
    assert.ok(!e.replies.some((t) => /收到 ✅/.test(String(t))));
  });

  test('沒有 feat_clips：不登記，照舊回「看不懂這個指令」', () => {
    const e = env();
    say(e, P1, DM(MOM));
    assert.equal(rows(e).length, 0);
    assert.match(e.replies.at(-1), /看不懂這個指令/);
  });

  test('Threads 網址：不登記，回「目前只支援 Instagram」', () => {
    const e = env();
    say(e, '看 https://www.threads.net/@a/post/xyz');
    assert.equal(rows(e).length, 0);
    assert.equal(e.replies.at(-1), '目前只支援 Instagram');
  });

  test('既有指令先走：「任務/」內容夾 IG 網址照樣建任務，不收藏', () => {
    const e = env();
    say(e, '任務/看完 ' + P1);
    assert.equal(rows(e).length, 0);
    assert.equal(e.sheets.tasks.toRecords().length, 1);
  });

  test('指令字典：有 feat_clips 的人看得到「（傳 IG 網址）」，沒有的看不到', () => {
    const e = env();
    say(e, '?');
    assert.match(e.replies.at(-1), /傳 IG 網址/);
    say(e, '?', DM(MOM));
    assert.doesNotMatch(e.replies.at(-1), /傳 IG 網址/);
  });
});

/* ========================================================================== */
describe('排程工作：抓取、存 Drive、判定', () => {

  test('成功：圖片照順序存成 01.jpg…、raw.json、content.md；只有圖片開分享；列寫成 done', () => {
    const e = env({ items: { AAA111: item('AAA111', 3) } });
    say(e, P1);
    const out = run(e, new Date());
    assert.equal(out.processed, 1);
    const r = rows(e)[0];
    assert.equal(r.status, 'done');
    assert.equal(Number(r.media_expected), 3);
    assert.equal(Number(r.media_saved), 3);
    assert.equal(r.author, 'someone');
    assert.equal(r.caption, CAPTION);
    assert.equal(r.posted_at, '2026-10-01T03:04:05.000Z');
    assert.equal(r.error, '');

    const day = new Date(Date.parse(r.collected_at) + 8 * 3600000).toISOString();
    const folderPath = 'Neil OS/收藏/' + day.slice(0, 7) + '/' + day.slice(0, 10).replace(/-/g, '') + '_someone_AAA111';
    const saved = e.drive.files.filter((f) => !f.trashed);
    assert.deepEqual(saved.map((f) => f.name), ['01.jpg', '02.jpg', '03.jpg', 'raw.json', 'content.md']);
    saved.forEach((f) => assert.equal(e.drive.path(f.folder), folderPath));
    assert.equal(r.drive_folder_id, saved[0].folder.getId());
    assert.deepEqual(JSON.parse(r.image_ids), saved.slice(0, 3).map((f) => f.id));
    saved.slice(0, 3).forEach((f) => assert.deepEqual(f.shared, ['ANYONE_WITH_LINK', 'VIEW']));
    saved.slice(3).forEach((f) => assert.equal(f.shared, null, f.name + ' 要維持私人'));
    assert.deepEqual(JSON.parse(saved[3].data).shortCode, 'AAA111', 'raw.json 是 Apify 的原始物件');
  });

  test('Apify：postUrls＋maxItems、token 只在 Authorization；任何 log 都看不到 token', () => {
    const e = env({ items: { AAA111: item('AAA111', 1) } });
    say(e, P1);
    run(e);
    assert.deepEqual(e.net.input(), { postUrls: [P1], maxItems: 1 });
    e.net.calls.filter((c) => c.url.includes('apify.com')).forEach((c) => {
      assert.ok(!c.url.includes(TOKEN));
      assert.equal(c.opts.headers.Authorization, 'Bearer ' + TOKEN);
    });
    const dump = JSON.stringify([e.logs, e.transactions, rows(e), e.drive.files.map((f) => f.data)]);
    assert.ok(!dump.includes(TOKEN), 'token 外洩到 log／Sheet／Drive');
  });

  test('沒有 caption 也算成功', () => {
    const e = env({ items: { AAA111: item('AAA111', 2, { caption: '' }) } });
    say(e, P1);
    run(e);
    assert.equal(rows(e)[0].status, 'done');
  });

  test('貼文 Apify 回 0 張：算失敗', () => {
    const e = env({ items: { AAA111: item('AAA111', 0) } });
    say(e, P1);
    run(e);
    const r = rows(e)[0];
    assert.equal(r.status, 'pending', '第 1 次失敗 → 下一輪重試');
    assert.equal(Number(r.attempts), 1);
    assert.match(r.error, /沒有回任何圖片/);
  });

  test('Reels：存封面 01.jpg＋raw.json＋content.md，不下載影片；算 done', () => {
    const reel = { shortCode: 'Rrr1', url: 'https://www.instagram.com/reel/Rrr1/', caption: '影片說明', ownerUsername: 'vlog', type: 'Video',
      videoUrl: 'https://cdn.example/Rrr1/v.mp4', displayUrl: 'https://cdn.example/Rrr1/cover.jpg' };
    const e = env({ items: { Rrr1: reel } });
    say(e, 'https://www.instagram.com/reel/Rrr1/');
    run(e);
    const r = rows(e)[0];
    assert.equal(r.status, 'done');
    assert.equal(r.kind, 'reel');
    assert.ok(!e.net.calls.some((c) => c.url.endsWith('v.mp4')), '影片不下載');
    const names = e.drive.files.map((f) => f.name);
    assert.deepEqual(names, ['01.jpg', 'raw.json', 'content.md']);
    assert.match(e.drive.files.find((f) => f.name === 'content.md').data, /類型: Reels，影片未保存/);
  });

  test('Apify 結果裡找不到這篇（只認代碼配對）：算失敗，不拿別篇充數', () => {
    const e = env({ items: { AAA111: item('ZZZ999', 3) } });
    say(e, P1);
    run(e);
    const r = rows(e)[0];
    assert.equal(Number(r.attempts), 1);
    assert.match(r.error, /找不到/);
    assert.equal(e.drive.files.length, 0);
  });
});

/* ========================================================================== */
describe('重試：下一輪 → 30 分鐘 → 2 小時 → partial／failed（不推播）', () => {

  test('少一張就失敗；四次都失敗、有存到部分 → partial', () => {
    const e = env({ items: { AAA111: item('AAA111', 3) }, fail: ['AAA111/2.jpg'] });
    say(e, P1);
    const t0 = Date.parse('2026-10-16T02:00:00Z');
    const at = (m) => new Date(t0 + m * MIN);

    run(e, at(0));
    let r = rows(e)[0];
    assert.equal(r.status, 'pending');
    assert.equal(Number(r.attempts), 1);
    assert.match(r.error, /第 2 張/);
    assert.ok(Date.parse(r.next_try_at) <= at(5).getTime(), '第 1 次失敗 → 下一輪');

    run(e, at(5));
    r = rows(e)[0];
    assert.equal(Number(r.attempts), 2);
    assert.equal(Date.parse(r.next_try_at), at(35).getTime(), '第 2 次失敗 → 30 分鐘後');

    run(e, at(20));
    assert.equal(Number(rows(e)[0].attempts), 2, '還沒到時間不抓');

    run(e, at(35));
    r = rows(e)[0];
    assert.equal(Number(r.attempts), 3);
    assert.equal(Date.parse(r.next_try_at), at(155).getTime(), '第 3 次失敗 → 2 小時後');

    run(e, at(155));
    r = rows(e)[0];
    assert.equal(r.status, 'partial');
    assert.equal(Number(r.media_saved), 2);
    assert.equal(Number(r.media_expected), 3);

    const before = apifyCalls(e).length;
    run(e, at(300));
    assert.equal(apifyCalls(e).length, before, 'partial 之後不會自己再抓');
    assert.equal(e.pushes.length, 0, '不推播');
  });

  test('一張都沒存到 → failed', () => {
    const e = env({ items: { AAA111: item('AAA111', 2) }, fail: ['AAA111/'] });
    say(e, P1);
    const t0 = Date.parse('2026-10-16T02:00:00Z');
    [0, 5, 35, 155].forEach((m) => run(e, new Date(t0 + m * MIN)));
    assert.equal(rows(e)[0].status, 'failed');
  });

  test('重跑整篇重抓：同一資料夾的舊檔丟垃圾桶（不永久刪），再重存', () => {
    const e = env({ items: { AAA111: item('AAA111', 2) } });
    say(e, P1);
    run(e);
    const first = e.drive.files.slice();
    post(e, { action: 'clipRetry', id: rows(e)[0].id, trigger: 'manual' });
    run(e);
    assert.ok(first.every((f) => f.trashed), '舊檔進垃圾桶');
    const alive = e.drive.files.filter((f) => !f.trashed);
    assert.deepEqual(alive.map((f) => f.name), ['01.jpg', '02.jpg', 'raw.json', 'content.md']);
    assert.equal(alive[0].folder, first[0].folder, '同一個資料夾');
    assert.equal(rows(e)[0].status, 'done');
  });
});

/* ========================================================================== */
describe('每輪的量與預算', () => {

  test('每輪最多 5 篇（一次 Apify run）；剩下的下一輪', () => {
    const codes = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
    const items = Object.fromEntries(codes.map((c) => [c, item(c, 1)]));
    const e = env({ items });
    codes.forEach((c) => say(e, 'https://www.instagram.com/p/' + c + '/'));
    const out = run(e);
    assert.equal(out.processed, 5);
    assert.equal(apifyCalls(e).length, 1);
    assert.equal(e.net.input().postUrls.length, 5);
    assert.equal(live(e).filter((r) => r.status === 'done').length, 5);
    run(e);
    assert.equal(live(e).filter((r) => r.status === 'done').length, 7);
  });

  test('總管預算不夠：一篇都不開始', () => {
    const e = env({ items: { AAA111: item('AAA111', 1) } });
    say(e, P1);
    const out = run(e, new Date(), 10000);
    assert.equal(out.processed, 0);
    assert.equal(apifyCalls(e).length, 0);
    assert.equal(rows(e)[0].status, 'pending');
  });

  test('擁有者後來沒有 feat_clips：不處理', () => {
    const e = env({ items: { AAA111: item('AAA111', 1) } });
    say(e, P1);
    e.sheets.line_users.values[1][6] = '';
    e.call('invalidateLineUsersCache_');
    run(e);
    assert.equal(apifyCalls(e).length, 0);
  });

  test('登記在排程總管：每輪都跑、排在效能落地之前', () => {
    const names = env().read('schedulerJobs_().map(function (j) { return j.name; })');
    assert.ok(names.includes('clips'));
    assert.equal(names.at(-1), 'perfFlush');
    assert.equal(env().read('schedulerJobs_().filter(function (j) { return j.name === "clips"; })[0].rule.kind'), 'always');
  });
});

/* ========================================================================== */
describe('合併（同一擁有者、同一網址）', () => {

  test('舊的已 done：更新舊列 last_collected_at，新列標 del，不抓', () => {
    const e = env({ items: { AAA111: item('AAA111', 1) } });
    say(e, P1);
    run(e);
    say(e, P1 + '?igsh=again');
    const before = apifyCalls(e).length;
    run(e);
    assert.equal(apifyCalls(e).length, before, '不重抓');
    const r = rows(e);
    assert.equal(r.length, 2);
    assert.equal(String(r[1].del).toUpperCase(), 'TRUE');
    assert.equal(r[0].last_collected_at, r[1].collected_at);
    assert.equal(r[0].status, 'done');
  });

  test('舊的 failed／partial：舊列重設成 pending 並在這一輪處理，新列標 del', () => {
    const e = env({ items: { AAA111: item('AAA111', 1) }, fail: ['AAA111/'] });
    say(e, P1);
    const t0 = Date.parse('2026-10-16T02:00:00Z');
    [0, 5, 35, 155].forEach((m) => run(e, new Date(t0 + m * MIN)));
    assert.equal(rows(e)[0].status, 'failed');

    e.net.fail.length = 0;                 // 圖片後來下載得到了
    say(e, P1);
    run(e, new Date(t0 + 400 * MIN));
    const r = rows(e);
    assert.equal(r[0].status, 'done', '舊列重跑成功');
    assert.equal(String(r[1].del).toUpperCase(), 'TRUE');
  });
});

/* ========================================================================== */
describe('content.md（純函式）', () => {

  test('上半部資料欄位、下半部全文；時間換成台北', () => {
    const md = env().call('clipContentMd_', {
      url: P1, kind: 'post', author: 'someone', posted_at: '2026-10-01T03:04:05.000Z',
      collected_at: '2026-10-16T02:00:00.000Z', caption: CAPTION, media_saved: 3
    });
    assert.equal(md, [
      '---',
      '來源: ' + P1,
      '平台: Instagram',
      '類型: 貼文',
      '作者: someone',
      '發文時間: 2026-10-01 11:04',
      '收藏時間: 2026-10-16 10:00',
      '圖片: 3 張（01.jpg … 03.jpg）',
      '---',
      '',
      CAPTION
    ].join('\n'));
  });

  test('Reels 與一張圖的寫法', () => {
    const md = env().call('clipContentMd_', { url: 'https://www.instagram.com/reel/R/', kind: 'reel', author: 'v', posted_at: '', collected_at: '2026-10-16T02:00:00.000Z', caption: '', media_saved: 1 });
    assert.match(md, /類型: Reels，影片未保存/);
    assert.match(md, /圖片: 1 張（01\.jpg）/);
    assert.match(md, /發文時間: \n/);
  });
});

/* ========================================================================== */
describe('PWA：讀只看自己的，寫只限擁有者', () => {

  function seeded() {
    const e = env();
    say(e, P1);
    say(e, P2, DM(DAD));
    return e;
  }

  test('readMany 只回請求者自己的、未刪除的列；沒 feat_clips 的人是 denied', () => {
    const e = seeded();
    const mine = post(e, { action: 'readMany', sheets: ['clips'], trigger: 'poll' });
    assert.deepEqual(mine.data.clips.map((r) => r.url), [P1]);
    const dad = post(e, { action: 'readMany', sheets: ['clips'], trigger: 'poll' }, TOK_DAD);
    assert.deepEqual(dad.data.clips.map((r) => r.url), [P2]);
  });

  test('一般 read 也只回自己的', () => {
    const e = seeded();
    const out = post(e, { action: 'read', sheet: 'clips', trigger: 'manual' });
    assert.deepEqual(out.data.map((r) => r.url), [P1]);
  });

  test('一般 upsert 寫不進 clips', () => {
    const e = seeded();
    const id = rows(e)[0].id;
    const out = post(e, { action: 'upsert', sheet: 'clips', key_field: 'id', record: { id, status: 'done' }, trigger: 'write' });
    assert.ok(out.error, JSON.stringify(out));
    assert.equal(rows(e)[0].status, 'pending');
  });

  test('重跑：擁有者 → pending、attempts=0；別人 → forbidden（永久拒絕），資料不變', () => {
    const e = env({ items: { AAA111: item('AAA111', 1) }, fail: ['AAA111/'] });
    say(e, P1);
    run(e);
    const id = rows(e)[0].id;
    const no = post(e, { action: 'clipRetry', id, trigger: 'write' }, TOK_DAD);
    assert.equal(no.error, 'forbidden');
    assert.equal(no.permanent, true);
    assert.equal(Number(rows(e)[0].attempts), 1);
    const ok = post(e, { action: 'clipRetry', id, trigger: 'write' });
    assert.equal(ok.success, true);
    assert.equal(rows(e)[0].status, 'pending');
    assert.equal(Number(rows(e)[0].attempts), 0);
    assert.equal(rows(e)[0].next_try_at, '');
  });

  test('刪除：擁有者 → del（Drive 不動）；別人 → forbidden', () => {
    const e = seeded();
    const id = rows(e)[0].id;
    assert.equal(post(e, { action: 'clipDelete', id, trigger: 'write' }, TOK_DAD).error, 'forbidden');
    assert.equal(post(e, { action: 'clipDelete', id, trigger: 'write' }).success, true);
    assert.equal(String(rows(e)[0].del).toUpperCase(), 'TRUE');
    assert.equal(post(e, { action: 'readMany', sheets: ['clips'], trigger: 'poll' }).data.clips.length, 0);
  });
});

/* ========================================================================== */
describe('「初始化」', () => {

  test('建 clips 分頁（可重複）、line_users 補 feat_clips 只替管理員打勾、登記 _guide', () => {
    const users = [['line_id', 'display_name', 'is_active', 'is_admin', 'feat_tasks'],
      [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE'], [MOM, '媽媽', 'TRUE', '', 'TRUE']];
    const e = loadCodeGs({ propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'],
      sheets: { line_users: new FakeSheet('line_users', users) } });
    const step = e.read('initSteps_().filter(function (s) { return /收藏/.test(s.label); })[0]');
    assert.ok(step, '初始化有收藏這一步');
    e.call('installClips_');
    e.call('installClips_');
    assert.deepEqual(e.sheets.clips.values[0], e.read('CLIPS_HEADERS'));
    assert.equal(e.sheets.clips.values.length, 1);
    const u = e.sheets.line_users.toRecords();
    assert.deepEqual(u.map((x) => x.feat_clips), ['TRUE', '']);
    e.sheets.line_users.values[2][5] = 'TRUE';          // 管理員後來替媽媽打勾：重跑不能蓋回去
    e.call('installClips_');
    assert.equal(e.sheets.line_users.toRecords()[1].feat_clips, 'TRUE');
    assert.ok(e.read('guideRegistry_().some(function (g) { return g.sheet === "clips"; })'));
  });
});
