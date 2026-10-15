/**
 * RD 收藏搜集器 MVP 階段 0：探針 probeClipSources() 的測試（apps-script/lab-clip.gs）
 *
 * 探針給 Neil 在 GAS 編輯器手動跑，真正的答案（Apify 回不回得了 10 張、IG 的 CDN
 * 擋不擋 Google 機房）要等實測。這裡盯的是「探針會不會說錯話」——它的總結就是下一場
 * grill-me 的輸入：
 *   1. APIFY_TOKEN 只放 Authorization header，網址、執行記錄、報告都看不到
 *   2. 沒設 token 不打 Apify，明講沒測；Jina 退路照跑
 *   3. 網址正規化（V6）：?igsh=、?img_index=、帳號前綴路徑都收成同一篇
 *   4. 「拿到圖片網址」不等於「存下圖片」（V1 vs V3 分開算）；少一張就不算過
 *   5. 影片不下載，但要列出回了什麼（V7）
 *   6. 一個環節失敗（Apify 跑失敗、某張圖被擋）不會中斷其他環節
 *   7. 探針不寫 Sheet、不碰 LINE
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs } from './fake-apps-script.mjs';

const TOKEN = 'apify_api_should-never-be-logged';
const JINA_KEY = 'jina-key-should-never-be-logged';
const TEST_POST = 'https://www.instagram.com/p/DdsyziaiROW/';
const CAPTION = '第一行重點\n\n第二行 #標籤 很長的內文';

/** 十張輪播的假 Apify 結果；欄位形狀刻意用 childPosts（常見格式之一） */
function carouselItem(n = 10) {
  return {
    shortCode: 'DdsyziaiROW',
    url: TEST_POST,
    caption: CAPTION,
    ownerUsername: 'someone',
    timestamp: '2026-10-01T03:04:05.000Z',
    type: 'Sidecar',
    childPosts: Array.from({ length: n }, (_, i) => ({ type: 'Image', displayUrl: 'https://cdn.example/img' + (i + 1) + '.jpg?oe=ABC' }))
  };
}

function fakeFetch(responder) {
  const calls = [];
  return {
    calls,
    UrlFetchApp: {
      fetch: (url, opts) => {
        calls.push({ url, opts: opts || {} });
        const r = responder(url, opts || {});
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return {
          getResponseCode: () => r.status,
          getContentText: () => body,
          getHeaders: () => ({ 'Content-Type': r.type || 'application/json' }),
          getBlob: () => ({
            getBytes: () => new Array(r.bytes || body.length).fill(0),
            getContentType: () => r.type || 'application/json',
            setName() { return this; }
          })
        };
      }
    }
  };
}

/** 一切順利：Apify 一啟動就跑完；圖片 200；Jina 有全文但只有第一張圖 */
function happy(items = [carouselItem()]) {
  return (url) => {
    if (url.startsWith('https://api.apify.com/v2/acts/')) {
      return { status: 201, body: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.0018 } } };
    }
    if (url.startsWith('https://api.apify.com/v2/datasets/ds1/items')) return { status: 200, body: items };
    if (url.startsWith('https://cdn.example/')) return { status: 200, type: 'image/jpeg', bytes: 150000 };
    if (url.startsWith('https://r.jina.ai/')) {
      return { status: 200, type: 'text/plain', body: 'Title: x\n\n' + CAPTION + '\n\n![img](https://cdn.example/img1.jpg)' };
    }
    throw new Error('沒預期的網址 ' + url);
  };
}

function fakeDrive() {
  const saved = [];
  const folder = (name) => ({
    name,
    getName: () => name,
    getUrl: () => 'https://drive.example/' + encodeURIComponent(name),
    getFoldersByName: () => ({ hasNext: () => false }),
    createFolder: (n) => folder(n),
    createFile: (blob) => { saved.push({ folder: name, blob }); return { getSize: () => blob.getBytes().length }; }
  });
  return { saved, DriveApp: { getRootFolder: () => folder('我的雲端硬碟') } };
}

function run({ responder = happy(), properties = { APIFY_TOKEN: TOKEN } } = {}) {
  const net = fakeFetch(responder);
  const drive = fakeDrive();
  const env = loadCodeGs({
    properties,
    extraFiles: ['lab-clip.gs'],
    overrides: { UrlFetchApp: net.UrlFetchApp, DriveApp: drive.DriveApp }
  });
  const report = env.call('probeClipSources_', new Date(Date.UTC(2026, 9, 15, 2, 0, 0)));
  return { env, net, drive, report };
}

describe('V6 網址正規化', () => {
  const norm = (u) => {
    const env = loadCodeGs({ extraFiles: ['lab-clip.gs'] });
    return env.call('clipNormalizeUrl_', u);
  };

  test('分享網址帶的 ?igsh=、?img_index=、#片段 都去掉，同一篇只有一個 key', () => {
    const a = norm('https://www.instagram.com/p/DdsyziaiROW/?igsh=MWx0eXo%3D');
    const b = norm('https://instagram.com/p/DdsyziaiROW?img_index=3');
    const c = norm('https://m.instagram.com/someone/p/DdsyziaiROW/#x');
    assert.equal(a.url, TEST_POST);
    assert.equal(a.key, 'ig:DdsyziaiROW');
    assert.equal(b.key, a.key);
    assert.equal(c.key, a.key);
    assert.equal(c.url, TEST_POST);
  });

  test('Reels 與舊的 /tv/ 保留類型，網址仍是乾淨的', () => {
    assert.deepEqual(norm('https://www.instagram.com/reel/Cabc_12-3/?utm_source=ig_web'), { key: 'ig:Cabc_12-3', url: 'https://www.instagram.com/reel/Cabc_12-3/', kind: 'reel' });
    assert.equal(norm('https://www.instagram.com/tv/Ctv1/').kind, 'tv');
  });

  test('不是 IG 貼文網址 → null（不猜）', () => {
    assert.equal(norm('https://www.instagram.com/someone/'), null);
    assert.equal(norm('https://example.com/p/abc/'), null);
    assert.equal(norm('不是網址'), null);
  });
});

describe('token 安全', () => {
  test('APIFY_TOKEN 只放 Authorization header，不在網址、執行記錄與報告裡', () => {
    const { env, net, report } = run();
    const apify = net.calls.filter((c) => c.url.startsWith('https://api.apify.com/'));
    assert.ok(apify.length >= 2);
    apify.forEach((c) => {
      assert.ok(!c.url.includes(TOKEN), '網址帶了 token：' + c.url);
      assert.equal(c.opts.headers.Authorization, 'Bearer ' + TOKEN);
      assert.equal(c.opts.muteHttpExceptions, true);
    });
    env.logs.forEach((l) => assert.ok(!l.includes(TOKEN), '執行記錄洩漏 token：' + l));
    assert.ok(!JSON.stringify(report).includes(TOKEN));
  });

  test('JINA_API_KEY 有設才帶，也不外洩；圖片下載請求不帶任何金鑰', () => {
    const { env, net, report } = run({ properties: { APIFY_TOKEN: TOKEN, JINA_API_KEY: JINA_KEY } });
    const jina = net.calls.find((c) => c.url.startsWith('https://r.jina.ai/'));
    assert.equal(jina.opts.headers.Authorization, 'Bearer ' + JINA_KEY);
    net.calls.filter((c) => c.url.startsWith('https://cdn.example/')).forEach((c) => {
      assert.ok(!JSON.stringify(c.opts).includes(TOKEN) && !JSON.stringify(c.opts).includes(JINA_KEY));
    });
    env.logs.forEach((l) => assert.ok(!l.includes(JINA_KEY)));
    assert.ok(!JSON.stringify(report).includes(JINA_KEY));
  });

  test('沒設 APIFY_TOKEN：不打 Apify、明講沒測，Jina 退路照跑', () => {
    const { net, report, env } = run({ properties: {} });
    assert.equal(net.calls.filter((c) => c.url.includes('apify')).length, 0);
    assert.equal(report.apify.ok, false);
    assert.match(report.apify.verdict, /沒設 APIFY_TOKEN/);
    assert.equal(report.jina.rows[0].status, 200);
    assert.ok(env.logs.some((l) => l.includes('APIFY_TOKEN')));
  });
});

describe('V1／V3：取得 vs 保存要分開算', () => {
  test('一切順利：10/10 張取得、10/10 張存進 Drive，依序命名；整篇判 ok', () => {
    const { report, drive } = run();
    const p = report.posts[0];
    assert.equal(p.post_id, 'DdsyziaiROW');
    assert.equal(p.source_url, TEST_POST);
    assert.equal(p.author, 'someone');
    assert.equal(p.published_at, '2026-10-01T03:04:05.000Z');
    assert.equal(p.caption, CAPTION);
    assert.equal(p.media_count_expected, 10);
    assert.equal(p.media.length, 10);
    assert.equal(p.media_count_saved, 10);
    assert.deepEqual(p.media.map((m) => m.order), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(p.status, 'ok');
    assert.equal(drive.saved.length, 10);
    assert.equal(drive.saved[0].blob.getBytes().length, 150000);
    assert.match(drive.saved[0].folder, /驗完可整個刪/);
  });

  test('Apify 只回 1 張（跟 Jina 一樣）→ V1 不過，status 標 partial，總結點名', () => {
    const { report } = run({ responder: happy([carouselItem(1)]) });
    const p = report.posts[0];
    assert.equal(p.media.length, 1);
    assert.equal(p.status, 'partial');
    assert.ok(p.errors.some((e) => /1\/10/.test(e)));
    assert.equal(report.verdicts.V1.ok, false);
  });

  test('第 7 張被 CDN 擋（403）→ 取得 10 張、只存 9 張，V3 不過，原因寫在那一張', () => {
    const base = happy();
    const { report, drive } = run({ responder: (url, o) => (url.includes('img7.jpg') ? { status: 403, type: 'text/html', body: 'denied' } : base(url, o)) });
    const p = report.posts[0];
    assert.equal(p.media.length, 10);
    assert.equal(p.media_count_saved, 9);
    assert.equal(p.status, 'partial');
    assert.match(p.media[6].error, /HTTP 403/);
    assert.equal(p.media[6].saved_path, '');
    assert.equal(drive.saved.length, 9);
    assert.equal(report.verdicts.V3.ok, false);
  });

  test('CDN 回 200 但不是圖片（被導去登入頁）也不能算存成功', () => {
    const base = happy();
    const { report } = run({ responder: (url, o) => (url.includes('img2.jpg') ? { status: 200, type: 'text/html', body: '<html>login</html>' } : base(url, o)) });
    assert.match(report.posts[0].media[1].error, /不是圖片/);
    assert.equal(report.posts[0].media_count_saved, 9);
  });

  test('沒有 caption → 不算 ok（全文是硬門檻）', () => {
    const item = carouselItem();
    delete item.caption;
    const { report } = run({ responder: happy([item]) });
    assert.notEqual(report.posts[0].status, 'ok');
    assert.ok(report.posts[0].errors.some((e) => /caption/.test(e)));
  });

  test('欄位形狀不同（images 字串陣列）也讀得到，並列出原始欄位名給回貼用', () => {
    const item = { shortcode: 'DdsyziaiROW', caption: CAPTION, ownerUsername: 'someone', images: Array.from({ length: 10 }, (_, i) => 'https://cdn.example/img' + (i + 1) + '.jpg') };
    const { report, env } = run({ responder: happy([item]) });
    assert.equal(report.posts[0].media.length, 10);
    assert.equal(report.posts[0].media_count_saved, 10);
    assert.ok(env.logs.some((l) => l.includes('欄位') && l.includes('images')));
  });
});

describe('Apify 流程（V2／V5）', () => {
  test('啟動沒等到結束 → 用 run id 輪詢到 SUCCEEDED 再讀 dataset；耗時與花費寫進報告', () => {
    const base = happy();
    let polled = 0;
    const { report, net } = run({ responder: (url, o) => {
      if (url.startsWith('https://api.apify.com/v2/acts/')) return { status: 201, body: { data: { id: 'run1', status: 'RUNNING' } } };
      if (url.startsWith('https://api.apify.com/v2/actor-runs/run1')) {
        polled++;
        return { status: 200, body: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.002 } } };
      }
      return base(url, o);
    } });
    assert.equal(polled, 1);
    assert.equal(report.apify.ok, true);
    assert.equal(typeof report.apify.ms, 'number');
    assert.equal(report.apify.usd, 0.002);
    assert.match(report.verdicts.V5.verdict, /300 篇/);
    const start = net.calls.find((c) => c.url.startsWith('https://api.apify.com/v2/acts/'));
    assert.equal(start.opts.method, 'post');
    assert.ok(JSON.parse(start.opts.payload).urls.includes(TEST_POST), '送給 Apify 的是正規化後的網址');
  });

  test('Apify 跑失敗（FAILED）→ 判失敗並附狀態，Jina 照跑、不打 CDN', () => {
    const base = happy();
    const { report, net } = run({ responder: (url, o) => (url.startsWith('https://api.apify.com/v2/acts/')
      ? { status: 201, body: { data: { id: 'run1', status: 'FAILED' } } } : base(url, o)) });
    assert.equal(report.apify.ok, false);
    assert.match(report.apify.verdict, /FAILED/);
    assert.equal(net.calls.filter((c) => c.url.startsWith('https://cdn.example/')).length, 0);
    assert.equal(report.jina.rows[0].status, 200);
    assert.equal(report.posts[0].status, 'failed');
  });

  test('Apify 連線例外不會讓探針整個掛掉', () => {
    const base = happy();
    const { report } = run({ responder: (url, o) => { if (url.includes('apify')) throw new Error('Address unavailable'); return base(url, o); } });
    assert.equal(report.apify.ok, false);
    assert.match(report.apify.verdict, /Address unavailable/);
  });

  test('沒回 usageTotalUsd → V5 明講要去後台看，不虛填', () => {
    const base = happy();
    const { report } = run({ responder: (url, o) => (url.startsWith('https://api.apify.com/v2/acts/')
      ? { status: 201, body: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } } } : base(url, o)) });
    assert.equal(report.verdicts.V5.ok, false);
    assert.match(report.verdicts.V5.verdict, /後台/);
  });
});

describe('V4 Jina 與 caption 對照', () => {
  test('Jina 全文裡找得到 Apify 的 caption → 標「兩邊一致」；並數 Jina 給了幾張圖', () => {
    const { report } = run();
    const row = report.jina.rows[0];
    assert.equal(row.captionMatch, true);
    assert.equal(row.images, 1);
    assert.ok(row.url.startsWith('https://r.jina.ai/' + TEST_POST));
  });

  test('Jina 429 → 點名限流', () => {
    const base = happy();
    const { report } = run({ responder: (url, o) => (url.startsWith('https://r.jina.ai/') ? { status: 429, body: 'Too Many Requests' } : base(url, o)) });
    assert.match(report.verdicts.V4.verdict, /429/);
  });
});

describe('V7 影片', () => {
  test('Reels 回影片：不下載，列出影片網址與封面，status 不冒充成功', () => {
    const reel = { shortCode: 'Creel1', url: 'https://www.instagram.com/reel/Creel1/', caption: 'reel 文字', type: 'Video', videoUrl: 'https://cdn.example/v.mp4', displayUrl: 'https://cdn.example/cover.jpg' };
    const { report, net } = run({
      responder: happy([carouselItem(), reel]),
      properties: { APIFY_TOKEN: TOKEN, CLIP_PROBE_URLS: 'https://www.instagram.com/reel/Creel1/?igsh=zz|Reels' }
    });
    const p = report.posts.find((x) => x.post_id === 'Creel1');
    assert.equal(p.media[0].type, 'video');
    assert.match(p.media[0].error, /影片未下載/);
    assert.equal(net.calls.filter((c) => c.url.includes('v.mp4')).length, 0);
    assert.notEqual(p.status, 'ok');
    assert.match(report.verdicts.V7.verdict, /video/);
  });
});

describe('邊界', () => {
  test('CLIP_PROBE_URLS 有重複（同一篇不同參數）只測一次', () => {
    const { report } = run({ properties: { APIFY_TOKEN: TOKEN, CLIP_PROBE_URLS: TEST_POST + '?img_index=2\nhttps://instagram.com/p/DdsyziaiROW' } });
    assert.equal(report.posts.length, 1);
  });

  test('兩篇只回一筆、對不上代碼 → 另一篇判 failed，不會把同一筆套到兩篇', () => {
    const { report } = run({
      responder: happy([carouselItem()]),
      properties: { APIFY_TOKEN: TOKEN, CLIP_PROBE_URLS: 'https://www.instagram.com/p/Cother1/|1|長文單圖' }
    });
    const other = report.posts.find((x) => x.post_id === 'Cother1');
    assert.equal(other.status, 'failed');
    assert.match(other.errors[0], /找不到這篇/);
    assert.equal(other.media_count_expected, 1);
  });

  test('探針不寫 Sheet、不推 LINE', () => {
    const { env } = run();
    assert.equal(env.pushes.length, 0);
    assert.equal(env.transactions.length, 0);
  });
});
