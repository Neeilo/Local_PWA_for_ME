/**
 * ADR-027 PR-0：Threads 收藏可行性探針 probeClipThreads()（apps-script/lab-clip.gs）
 *
 * 為什麼有這批測試：探針給專案擁有者在 GAS 編輯器手動跑，真正的答案（Apify 抓不抓得到串文、
 * Threads 的圖片 Google 機房下不下載得到、一篇多少錢）要等實測。探針的總結就是「開不開 PR-A」的依據，
 * 所以這裡盯的是「探針不會說錯話、不會做錯事」：
 *   1. 外部呼叫全走 callApi_（apify／web），APIFY_TOKEN 只放 Authorization header，不進網址與執行記錄
 *   2. 只認 Threads 單篇貼文網址（threads.com／threads.net、有無 www、/@帳號/post/代碼 或 /t/代碼），最多 3 篇
 *   3. 串文只留作者自己的接續（replyType=author_thread），別人的留言、作者回別人的留言都不算；順序照 parentCode 串
 *   4. 串不起來就照時間排、明講「順序沒把握」；沒有串文 → 結論「只能抓主文」（PR-A 走 D-6 退回路線）
 *   5. 圖片要真的下載得到（200 且是圖片）才算；主文抓不到或圖片下載失敗 → 不可行
 *   6. 成本：本次估算＋每月推估＋IG 現況，合計超過 US$3 要明講；跑一次有花費上限
 *   7. 探針不寫 Sheet、不碰 LINE、不存 Drive；沒設 CLIP_THREADS_PROBE_URLS 就講明、不打 Apify
 *
 * 測試只用合成資料（假帳號、假代碼、cdn.example 網址），不放任何真實收藏（公開 repo）。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs } from './fake-apps-script.mjs';

const TOKEN = 'apify_api_should-never-be-logged';
const P1 = 'https://www.threads.com/@demo.user/post/AAA111';
const P2 = 'https://threads.net/t/BBB222?xmt=abc';
const P3 = 'https://www.threads.net/@other_demo/post/CCC333/';

/* ---------- 合成的 Apify 結果 ---------- */

const rootRow = (code, user, extra = {}) => ({
  recordType: 'post', code, url: 'https://www.threads.com/@' + user + '/post/' + code,
  authorUsername: user, text: '主文 ' + code, timestamp: '2026-11-01T01:00:00Z', ...extra
});
const replyRow = (code, root, parent, user, type, isAuthor, ts, extra = {}) => ({
  recordType: 'reply', code, rootPostCode: root, parentCode: parent, authorUsername: user,
  replyType: type, isAuthor, depth: 1, text: '回覆 ' + code, timestamp: ts, ...extra
});

/** P1：有兩張圖、作者串文 2 則（故意倒序給）＋別人留言 1 則＋作者回別人 1 則；P2：純文字無串文 */
function happyItems() {
  return [
    rootRow('AAA111', 'demo.user', { images: ['https://cdn.example/a1.jpg?sig=1', 'https://cdn.example/a2.jpg?sig=2'] }),
    replyRow('T2', 'AAA111', 'T1', 'demo.user', 'author_thread', true, '2026-11-01T01:02:00Z', { images: ['https://cdn.example/t2.jpg'] }),
    replyRow('X1', 'AAA111', 'AAA111', 'stranger', 'reply', false, '2026-11-01T01:05:00Z'),
    replyRow('T1', 'AAA111', 'AAA111', 'demo.user', 'author_thread', true, '2026-11-01T01:01:00Z'),
    replyRow('R1', 'AAA111', 'X1', 'demo.user', 'reply', true, '2026-11-01T01:06:00Z'),
    rootRow('BBB222', 'demo.user')
  ];
}

function fakeFetch(responder) {
  const calls = [];
  const make = (url, opts) => {
    calls.push({ url, opts: opts || {} });
    const r = responder(url, opts || {});
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '');
    return {
      getResponseCode: () => r.status,
      getContentText: () => body,
      getHeaders: () => ({ 'Content-Type': r.type || 'application/json' }),
      getBlob: () => ({ getBytes: () => new Array(r.bytes || body.length).fill(0), getContentType: () => r.type || 'application/json' })
    };
  };
  return {
    calls,
    UrlFetchApp: {
      fetch: (url, opts) => make(url, opts),
      fetchAll: (reqs) => reqs.map((q) => make(q.url, q))
    }
  };
}

function happy({ items = happyItems(), usd = 0.012, imageStatus = 200 } = {}) {
  return (url) => {
    if (url.startsWith('https://api.apify.com/v2/acts/')) {
      return { status: 201, body: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', defaultKeyValueStoreId: 'kv1', usageTotalUsd: usd } } };
    }
    if (url.startsWith('https://api.apify.com/v2/datasets/ds1/items')) return { status: 200, body: items };
    if (url.startsWith('https://api.apify.com/v2/key-value-stores/kv1/records/RUN_SUMMARY')) {
      return { status: 200, body: { status: 'COMPLETE', perPost: [{ url: P1, capped: false, exhausted: true, coverage: 1 }] } };
    }
    if (url.startsWith('https://cdn.example/')) return imageStatus === 200 ? { status: 200, type: 'image/jpeg', bytes: 120000 } : { status: imageStatus, type: 'text/html' };
    throw new Error('沒預期的網址 ' + url);
  };
}

function run({ responder = happy(), properties = { APIFY_TOKEN: TOKEN, CLIP_THREADS_PROBE_URLS: P1 + ',' + P2 } } = {}) {
  const net = fakeFetch(responder);
  const env = loadCodeGs({ properties, extraFiles: ['lab-clip.gs'], overrides: { UrlFetchApp: net.UrlFetchApp } });
  const report = env.call('probeClipThreads_');
  return { env, net, report, log: env.logs.join('\n') };
}

/* ========================================================================== */
describe('網址：只認 Threads 單篇貼文', () => {
  const list = (s) => loadCodeGs({ extraFiles: ['lab-clip.gs'] }).call('clipThreadsProbeList_', s);

  test('threads.com／threads.net、有無 www、/t/ 短網址、帶參數與結尾斜線都認得；送出去的是乾淨網址', () => {
    const out = list(P1 + ', ' + P2 + '\n' + P3);
    assert.deepEqual(out.map((p) => p.code), ['AAA111', 'BBB222', 'CCC333']);
    assert.equal(out[0].url, 'https://www.threads.com/@demo.user/post/AAA111');
    assert.equal(out[1].url, 'https://www.threads.com/t/BBB222');
    assert.equal(out[2].url, 'https://www.threads.com/@other_demo/post/CCC333');
  });

  test('個人頁、搜尋頁、其他網域都不收；同一篇只留一次；最多 3 篇', () => {
    const out = list([
      'https://www.threads.com/@demo.user', 'https://www.threads.com/search?q=x', 'https://example.com/@a/post/ZZZ',
      P1, 'https://threads.net/@demo.user/post/AAA111?igshid=1', P2, P3, 'https://www.threads.com/t/DDD444'
    ].join(','));
    assert.deepEqual(out.map((p) => p.code), ['AAA111', 'BBB222', 'CCC333']);
  });
});

/* ========================================================================== */
describe('串文：只留作者自己的接續，照順序', () => {
  const chain = (rows) => loadCodeGs({ extraFiles: ['lab-clip.gs'] }).call('clipThreadsAuthorChain_', 'AAA111', rows);

  test('照 parentCode 從主文一路串下去；別人的留言、作者回別人的都不算', () => {
    const c = chain(happyItems());
    assert.deepEqual(c.rows.map((r) => r.code), ['T1', 'T2']);
    assert.equal(c.method, 'parent');
    assert.equal(c.orderOk, true);
  });

  test('串不起來（例如全掛在主文底下）→ 照時間排，並標明順序沒把握', () => {
    const rows = [
      replyRow('T2', 'AAA111', 'AAA111', 'demo.user', 'author_thread', true, '2026-11-01T01:02:00Z'),
      replyRow('T1', 'AAA111', 'AAA111', 'demo.user', 'author_thread', true, '2026-11-01T01:01:00Z')
    ];
    const c = chain(rows);
    assert.deepEqual(c.rows.map((r) => r.code), ['T1', 'T2']);
    assert.equal(c.method, 'time');
    assert.equal(c.orderOk, false);
  });

  test('沒有串文 → 空清單', () => {
    assert.deepEqual(chain([rootRow('AAA111', 'demo.user')]).rows, []);
  });
});

/* ========================================================================== */
describe('探針整體', () => {
  test('呼叫走 callApi_、token 只在 header；送 Apify 的是乾淨網址＋要作者串文＋花費上限', () => {
    const { net, log, report } = run();
    const start = net.calls.find((c) => c.url.startsWith('https://api.apify.com/v2/acts/'));
    assert.match(start.url, /acts\/architekture~threads-replies-scraper\/runs\?/);
    assert.match(start.url, /maxTotalChargeUsd=/);
    const input = JSON.parse(start.opts.payload);
    assert.deepEqual(input.postUrls, ['https://www.threads.com/@demo.user/post/AAA111', 'https://www.threads.com/t/BBB222']);
    assert.equal(input.includeAuthorThread, true);
    assert.ok(input.maxRepliesPerPost > 0, '要設上限，不能 0（0＝全部留言，會很貴）');
    net.calls.filter((c) => c.url.startsWith('https://api.apify.com/')).forEach((c) => {
      assert.ok(!c.url.includes(TOKEN));
      assert.equal(c.opts.headers.Authorization, 'Bearer ' + TOKEN);
    });
    assert.ok(!log.includes(TOKEN), 'token 不進執行記錄');
    assert.ok(!JSON.stringify(report).includes(TOKEN), 'token 不進報告');
  });

  test('每篇印出主文字數、圖片下載、串文幾則與順序、混入別人留言幾則；有串文 → 可行', () => {
    const { report, log } = run();
    const [a, b] = report.posts;
    assert.equal(a.textChars, '主文 AAA111'.length);
    assert.equal(a.images, 3, '主文 2 張＋串文 1 張');
    assert.equal(a.imagesOk, 3);
    assert.equal(a.thread, 2);
    assert.equal(a.threadOrderOk, true);
    assert.equal(a.others, 1, '別人的留言');
    assert.equal(a.authorOtherReplies, 1, '作者回別人的留言不算串文');
    assert.equal(b.thread, 0);
    assert.equal(report.verdict, 'ok');
    assert.match(log, /可行/);
    assert.match(log, /AAA111/);
  });

  test('沒有任何一篇抓到串文 → 只能抓主文（D-6 退回路線）', () => {
    const items = [rootRow('AAA111', 'demo.user'), rootRow('BBB222', 'demo.user')];
    const { report, log } = run({ responder: happy({ items }) });
    assert.equal(report.verdict, 'main_only');
    assert.match(log, /只能抓主文/);
  });

  test('有一篇主文沒回來（status 列）→ 不可行，並寫明不要自行改用其他付費方案', () => {
    const items = [rootRow('AAA111', 'demo.user'), { recordType: 'status', url: 'https://www.threads.com/t/BBB222', status: 'NOT_FOUND', reason: 'gone' }];
    const { report, log } = run({ responder: happy({ items }) });
    assert.equal(report.verdict, 'fail');
    assert.match(report.posts[1].error, /NOT_FOUND/);
    assert.match(log, /不可行/);
    assert.match(log, /不要自行改用其他付費方案/);
  });

  test('圖片下載不到 → 不可行', () => {
    const { report } = run({ responder: happy({ imageStatus: 403 }) });
    assert.equal(report.posts[0].imagesOk, 0);
    assert.equal(report.verdict, 'fail');
  });

  test('成本：印每篇估算與每月推估（含 IG 現況）；超過 US$3 要明講', () => {
    const { report, log } = run();
    assert.ok(report.cost.perPostUsd > 0);
    assert.ok(report.cost.monthlyUsd >= report.cost.perPostUsd);
    assert.equal(report.cost.withinCap, true);
    assert.match(log, /每月/);
    const pricey = run({ responder: happy({ usd: 1.2 }) });
    assert.equal(pricey.report.cost.withinCap, false);
    assert.match(pricey.log, /超過 US\$3/);
  });

  test('沒設 CLIP_THREADS_PROBE_URLS → 講明怎麼設，不打 Apify', () => {
    const { net, report, log } = run({ properties: { APIFY_TOKEN: TOKEN } });
    assert.equal(net.calls.length, 0);
    assert.equal(report.verdict, 'not_run');
    assert.match(log, /CLIP_THREADS_PROBE_URLS/);
  });

  test('沒設 APIFY_TOKEN → 不打 Apify、明講未測', () => {
    const { net, report } = run({ properties: { CLIP_THREADS_PROBE_URLS: P1 } });
    assert.equal(net.calls.length, 0);
    assert.equal(report.verdict, 'not_run');
  });

  test('不寫 Sheet、不碰 LINE', () => {
    const { env } = run();
    assert.equal(env.pushes.length, 0);
    assert.equal(env.transactions.length, 0);
  });
});
