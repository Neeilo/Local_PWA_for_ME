/**
 * ADR-015 PR-0：股票資料源探針 probeStockSources() 的測試
 *
 * 探針本身是給 Neil 在 GAS 編輯器手動跑的，真正的答案要等實測。這裡盯的是
 * 「探針會不會說錯話」——它的總結就是要不要往下做 PR-A 的依據：
 *   1. 富果的 key 讀指令碼屬性、放在 header，而且絕不出現在執行記錄裡
 *   2. 沒設 key 就不打富果，明講沒測（不是假裝測過）
 *   3. 一個來源連線失敗（被擋、DNS）不會中斷其他來源
 *   4. 判定：「不存在」那檔失敗是預期；上櫃失敗要點名；429 要點名
 *   5. MIS 一次多檔、上市用 tse_、上櫃用 otc_；z='-' 要標出來
 *   6. 盤中判斷用台北時間，不靠腳本時區
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs } from './fake-apps-script.mjs';

const KEY = 'fugle-key-should-never-be-logged';
/** 2026-10-08（週四）10:28 台北 */
const MARKET_OPEN = new Date(Date.UTC(2026, 9, 8, 2, 28, 0));

const FUGLE_OK = (code) => ({
  date: '2026-10-08', symbol: code, name: '名稱' + code, exchange: 'TWSE', market: 'TSE',
  previousClose: 40, lastPrice: 41.28, change: 1.28, changePercent: 3.2,
  lastTrade: { price: 41.28, time: 1759890495000000 }, lastUpdated: 1759890495000000
});

/**
 * 假 UrlFetchApp：依網址回應。responder 回 { status, body } 或丟例外（模擬被擋）。
 * 每個請求都記下來，測試才看得到 header 與網址。
 */
function fakeFetch(responder) {
  const calls = [];
  return {
    calls,
    UrlFetchApp: {
      fetch: (url, opts) => {
        calls.push({ url, opts });
        const r = responder(url, opts);
        return {
          getResponseCode: () => r.status,
          getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
        };
      }
    }
  };
}

/** 一切順利的世界：富果四檔都有、不存在的 404；MIS 回四檔；OpenAPI 各有自己的代號 */
function happy(url) {
  if (url.startsWith('https://api.fugle.tw/')) {
    const code = decodeURIComponent(url.split('/').pop());
    return code === '0063L' ? { status: 404, body: { statusCode: 404, message: 'Resource Not Found' } } : { status: 200, body: FUGLE_OK(code) };
  }
  if (url.startsWith('https://mis.twse.com.tw/')) {
    return { status: 200, body: { msgArray: [
      { c: '2330', n: '台積電', ex: 'tse', z: '1035.0000', y: '1030.0000', d: '20261008', t: '10:28:15' },
      { c: '0050', n: '元大台灣50', ex: 'tse', z: '-', y: '190.0000', b: '190.10_', a: '190.15_', d: '20261008', t: '10:28:15' },
      { c: '00631L', n: '元大台灣50正2', ex: 'tse', z: '41.2800', y: '40.0000', d: '20261008', t: '10:28:15' },
      { c: '6488', n: '環球晶', ex: 'otc', z: '400.0000', y: '398.0000', d: '20261008', t: '10:28:15' }
    ] } };
  }
  if (url.startsWith('https://openapi.twse.com.tw/')) {
    return { status: 200, body: [
      { Date: '1151007', Code: '2330', Name: '台積電', ClosingPrice: '1030.00' },
      { Date: '1151007', Code: '00631L', Name: '元大台灣50正2', ClosingPrice: '40.00' },
      { Date: '1151007', Code: '1101', Name: '台泥', ClosingPrice: '30.00' }
    ] };
  }
  if (url.startsWith('https://www.tpex.org.tw/')) {
    return { status: 200, body: [{ Date: '1151007', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', Close: '398.00' }] };
  }
  throw new Error('沒預期的網址 ' + url);
}

function run({ responder = happy, properties = { FUGLE_API_KEY: KEY }, now = MARKET_OPEN } = {}) {
  const net = fakeFetch(responder);
  const env = loadCodeGs({ properties, extraFiles: ['stock.gs'], overrides: { UrlFetchApp: net.UrlFetchApp } });
  const report = env.call('probeStockSources_', now);
  const bySource = Object.fromEntries(report.sources.map((s) => [s.source, s]));
  return { env, net, report, bySource };
}

describe('富果', () => {
  test('key 放在 X-API-KEY header，一檔一個請求，代號在網址最後一段', () => {
    const { net } = run();
    const fugle = net.calls.filter((c) => c.url.startsWith('https://api.fugle.tw/'));
    assert.deepEqual(fugle.map((c) => c.url.split('/').pop()), ['2330', '0050', '00631L', '6488', '0063L']);
    fugle.forEach((c) => {
      assert.equal(c.opts.headers['X-API-KEY'], KEY);
      assert.equal(c.opts.muteHttpExceptions, true, '要拿到 4xx 的內容，不能讓它丟例外');
    });
    assert.ok(fugle[0].url.startsWith('https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/'));
  });

  test('key 不會出現在執行記錄或回傳的報告裡（回貼時會整段公開）', () => {
    const { env, report } = run();
    assert.ok(env.logs.length > 0);
    env.logs.forEach((line) => assert.ok(!line.includes(KEY), '執行記錄洩漏 key：' + line));
    assert.ok(!JSON.stringify(report).includes(KEY));
  });

  test('沒設 FUGLE_API_KEY：不打富果、明講沒測，其他來源照跑', () => {
    const { net, bySource, env } = run({ properties: {} });
    assert.equal(net.calls.filter((c) => c.url.includes('fugle')).length, 0);
    assert.equal(bySource['富果'].ok, false);
    assert.match(bySource['富果'].verdict, /沒設 FUGLE_API_KEY/);
    assert.equal(bySource.MIS.ok, true);
    assert.ok(env.logs.some((l) => l.includes('FUGLE_API_KEY')));
  });

  test('四檔真的代號都 200 才算過；不存在那檔 404 是預期，不扣分', () => {
    const { bySource } = run();
    assert.equal(bySource['富果'].ok, true);
    assert.match(bySource['富果'].verdict, /^4\/4 檔/);
    const row = bySource['富果'].rows.find((r) => r.code === '00631L');
    assert.equal(row.sample.lastPrice, 41.28);
    assert.ok(row.fields.includes('previousClose'), '欄位清單要列出來，PR-A 才知道該讀哪個');
  });

  test('上櫃被拒要點名，不能只說 3/4', () => {
    const { bySource } = run({ responder: (url, o) => (url.endsWith('/6488') ? { status: 403, body: { message: 'Forbidden' } } : happy(url, o)) });
    assert.equal(bySource['富果'].ok, false);
    assert.match(bySource['富果'].verdict, /上櫃不支援或被擋/);
    assert.match(bySource['富果'].rows.find((r) => r.code === '6488').body, /Forbidden/);
  });

  test('429 限流要點名', () => {
    const { bySource, env } = run({ responder: (url, o) => (url.endsWith('/0050') ? { status: 429, body: 'Too Many Requests' } : happy(url, o)) });
    assert.equal(bySource['富果'].ok, false);
    assert.match(bySource['富果'].verdict, /有 429/);
    assert.ok(env.logs.some((l) => l.includes('0050') && l.includes('429')));
  });
});

describe('一個來源掛了不影響其他來源', () => {
  test('MIS 連線例外（被擋）→ MIS 判失敗並記下原因，富果與兩個 OpenAPI 照跑', () => {
    const { bySource } = run({ responder: (url, o) => { if (url.includes('mis.twse')) throw new Error('Address unavailable'); return happy(url, o); } });
    assert.equal(bySource.MIS.ok, false);
    assert.match(bySource.MIS.verdict, /Address unavailable/);
    assert.equal(bySource['富果'].ok, true);
    assert.equal(bySource['證交所 OpenAPI'].ok, true);
    assert.equal(bySource['櫃買 OpenAPI'].ok, true);
  });

  test('回的不是 JSON（例如被導去 HTML 錯誤頁）→ 判失敗，附上內容開頭', () => {
    const { bySource } = run({ responder: (url, o) => (url.includes('openapi.twse') ? { status: 200, body: '<html>維護中</html>' } : happy(url, o)) });
    assert.equal(bySource['證交所 OpenAPI'].ok, false);
    assert.match(bySource['證交所 OpenAPI'].verdict, /讀不到清單/);
  });
});

describe('MIS', () => {
  test('一次請求帶全部代號，上市 tse_、上櫃 otc_', () => {
    const { net } = run();
    const mis = net.calls.filter((c) => c.url.startsWith('https://mis.twse.com.tw/'));
    assert.equal(mis.length, 1);
    const exCh = decodeURIComponent(new URL(mis[0].url).searchParams.get('ex_ch'));
    assert.equal(exCh, 'tse_2330.tw|tse_0050.tw|tse_00631L.tw|otc_6488.tw|tse_0063L.tw');
  });

  test('z=- 要標出來；沒回的代號列名，只有「不存在」那檔沒回不算失敗', () => {
    const { bySource, env } = run();
    assert.equal(bySource.MIS.ok, true);
    assert.match(bySource.MIS.verdict, /有 z=-/);
    assert.match(bySource.MIS.verdict, /沒回：0063L（不存在）/);
    assert.ok(env.logs.some((l) => l.includes('0050') && l.includes('無成交')));
  });

  test('上櫃沒回 → 判失敗', () => {
    const { bySource } = run({ responder: (url, o) => {
      const r = happy(url, o);
      if (url.includes('mis.twse')) r.body.msgArray = r.body.msgArray.filter((it) => it.c !== '6488');
      return r;
    } });
    assert.equal(bySource.MIS.ok, false);
    assert.match(bySource.MIS.verdict, /6488（上櫃）/);
  });
});

describe('盤後 OpenAPI', () => {
  test('證交所找得到上市代號、櫃買找得到上櫃代號，並列出資料日期', () => {
    const { bySource } = run();
    assert.deepEqual(bySource['證交所 OpenAPI'].rows.map((r) => r.code), ['2330', '00631L']);
    assert.match(bySource['證交所 OpenAPI'].verdict, /資料日期 1151007/);
    assert.deepEqual(bySource['櫃買 OpenAPI'].rows.map((r) => r.code), ['6488']);
  });
});

describe('盤中判斷（台北時間）', () => {
  const at = (iso) => new Date(iso);
  const cases = [
    ['2026-10-08T01:00:00Z', true, '週四 9:00 開盤'],
    ['2026-10-08T05:30:00Z', true, '週四 13:30 收盤那一刻'],
    ['2026-10-08T05:31:00Z', false, '週四 13:31'],
    ['2026-10-08T00:59:00Z', false, '週四 8:59'],
    ['2026-10-10T02:00:00Z', false, '週六 10:00'],
    ['2026-10-09T23:00:00Z', false, 'UTC 週五 23:00＝台北週六 7:00']
  ];
  // 01:00Z＝台北 9:00：用 UTC 時數判斷的實作會在這裡判成不在盤中
  cases.forEach(([iso, want, label]) => {
    test(label, () => {
      const env = loadCodeGs({ extraFiles: ['stock.gs'] });
      assert.equal(env.call('isTwTradingTime_', at(iso)), want);
    });
  });

  test('不在盤中照樣跑完，但開頭提醒盤中再跑一次', () => {
    const { report, env } = run({ now: at('2026-10-10T02:00:00Z') });
    assert.equal(report.trading, false);
    assert.equal(report.sources.length, 4);
    assert.ok(env.logs.some((l) => l.includes('不是盤中')));
  });
});
