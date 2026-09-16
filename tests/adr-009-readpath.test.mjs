/**
 * ADR-009 Phase 2-d — 讀取路徑的測試
 *
 * 這一批只有一個真正危險的主題：**讀取失敗不可以被當成「雲端是空的」**。
 *
 * 改版前 cloudGet 把任何失敗都吞掉回傳空陣列，那時無所謂——合併規則是「只補不刪」。
 * 現在 pull 是覆蓋式的，同一個空陣列的意思變成「這張表本來就沒東西」，一次網路
 * 抖動就會清光五張表。下面第一組測試就是釘住這件事。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';

/** 依分頁餵資料的假雲端。sheets 沒列到的分頁回空陣列 */
function cloudWith(sheets, { failOn = null } = {}) {
  return ({ url }) => {
    const m = /[?&]sheet=([^&]+)/.exec(url);
    if (!m) return null;                       // 不是 GET，交給預設（寫入一律成功）
    const sheet = decodeURIComponent(m[1]);
    if (failOn && (failOn === true || failOn === sheet)) {
      return { json: () => Promise.reject(new Error('network down')) };
    }
    return { json: () => Promise.resolve({ data: sheets[sheet] || [] }) };
  };
}

function env(fetchImpl) {
  const e = loadFrontend({ fetchImpl });
  e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
  e.raw('state = EMPTY_STATE()');
  return e;
}

const TASK = (id, text) => ({ id, text, is_completed: '', created_at: '2026-09-16T00:00:00.000Z', priority: 'M', line_id: ME });

/* ========================================================================== */
describe('⚠️ 讀取失敗不可以偽裝成空表', () => {

  test('整批讀取失敗時原地不動，不會把資料清光', async () => {
    const e = env(cloudWith({ tasks: [TASK('1', '原有的')] }));
    await e.callRaw('pullFromCloud');
    assert.equal(e.read('state.tasks.length'), 1, '先確認正常時讀得到');

    // 現在斷線
    e.raw('cloudGet = function(){ return Promise.reject(new Error("offline")); }');
    await e.callRaw('pullFromCloud');

    assert.equal(e.read('state.tasks.length'), 1, '讀不到就原地不動——這是最貴的那個錯');
    assert.equal(e.read('cloudOnline'), false);
  });

  test('只要有一張表讀失敗，整次 pull 就不算數', async () => {
    const e = env(cloudWith({ tasks: [TASK('1', '原有的')] }));
    await e.callRaw('pullFromCloud');

    // notes 掛掉，其餘正常——不可以只更新一半
    const half = cloudWith({ tasks: [] }, { failOn: 'notes' });
    e.set('fetch', (url, options) => {
      const r = half({ url: String(url), options });
      return Promise.resolve(r || { json: () => Promise.resolve({ success: true }) });
    });
    await e.callRaw('pullFromCloud');

    assert.equal(e.read('state.tasks.length'), 1, 'tasks 回了空陣列，但整次不算數，所以不該被清掉');
    assert.equal(e.read('cloudOnline'), false);
  });

  test('sheet_not_found 是「真的空」，不是失敗', async () => {
    const e = env(({ url }) => {
      if (!/sheet=/.test(url)) return null;
      return { json: () => Promise.resolve({ error: 'sheet_not_found', sheet: 'x' }) };
    });

    await e.callRaw('pullFromCloud');

    assert.equal(e.read('cloudOnline'), true, '分頁還沒建出來，這不是連線問題');
    assert.equal(e.read('state.tasks.length'), 0);
  });

  test('後端回其他錯誤時算失敗，不算空表', async () => {
    const e = env(cloudWith({ tasks: [TASK('1', '原有的')] }));
    await e.callRaw('pullFromCloud');

    e.set('fetch', (url) => Promise.resolve(
      /sheet=/.test(String(url))
        ? { json: () => Promise.resolve({ error: 'server_misconfigured' }) }
        : { json: () => Promise.resolve({ success: true }) }
    ));
    await e.callRaw('pullFromCloud');

    assert.equal(e.read('state.tasks.length'), 1);
    assert.equal(e.read('cloudOnline'), false);
  });
});

/* ========================================================================== */
describe('雲端是真相：pull 是覆蓋不是合併', () => {

  test('別人刪掉的東西會消失——這是改版前做不到的', async () => {
    const e = env(cloudWith({ tasks: [TASK('1', '甲'), TASK('2', '乙')] }));
    await e.callRaw('pullFromCloud');
    assert.equal(e.read('state.tasks.length'), 2);

    // 另一支手機把「乙」軟刪除了，後端 doGet 從此不再回傳它
    e.set('fetch', (url) => Promise.resolve(
      /sheet=tasks/.test(String(url))
        ? { json: () => Promise.resolve({ data: [TASK('1', '甲')] }) }
        : { json: () => Promise.resolve({ data: [] }) }
    ));
    await e.callRaw('pullFromCloud');

    assert.deepEqual(e.read('state.tasks').map(t => t.txt), ['甲'],
      '合併式的舊規則「只補不刪」會讓它永遠留著');
  });

  test('雲端的內容會覆蓋本機的舊版本', async () => {
    const e = env(cloudWith({ tasks: [TASK('1', '雲端版')] }));
    e.raw('state.tasks = [{id:1, txt:"本機的舊版", done:false, ts:1, priority:"M", line_id:"' + ME + '"}]');

    await e.callRaw('pullFromCloud');

    assert.deepEqual(e.read('state.tasks').map(t => t.txt), ['雲端版']);
  });
});

/* ========================================================================== */
describe('還沒送出去的那幾筆要留在畫面上', () => {

  test('待送的新增在覆蓋式 pull 之後仍然看得到', async () => {
    const e = env(cloudWith({ tasks: [TASK('1', '雲端有的')] }));
    // 模擬一筆卡在佇列裡的新增
    e.raw('outbox = [{sheet:"tasks", key_field:"id", seq:1, record:' +
      JSON.stringify({ id: '99', text: '剛打的，還沒送出去', is_completed: '', created_at: '2026-09-16T00:00:00.000Z', priority: 'M', line_id: ME }) + '}]');

    await e.callRaw('pullFromCloud');

    const texts = e.read('state.tasks').map(t => t.txt);
    assert.ok(texts.includes('剛打的，還沒送出去'),
      '東西好好躺在佇列裡，但那不是使用者看得到的地方');
    assert.ok(texts.includes('雲端有的'));
  });

  test('待送的刪除不會因為 pull 又冒出來', async () => {
    const e = env(cloudWith({ tasks: [TASK('1', '要刪的')] }));
    e.raw('outbox = [{sheet:"tasks", key_field:"id", seq:1, record:' +
      JSON.stringify({ id: '1', text: '要刪的', line_id: ME, del: 'TRUE' }) + '}]');

    await e.callRaw('pullFromCloud');

    assert.equal(e.read('state.tasks.length'), 0,
      '刪除還沒送成，雲端當然還有——但畫面上不該讓它復活');
  });

  test('開機時不拿 localStorage 當畫面來源，但待送的仍要看得見', () => {
    const e = loadFrontend({
      storage: {
        'personal-os-state-v1': JSON.stringify({ tasks: [{ id: 5, txt: '上次留在本機的', ts: 1, priority: 'M' }], reviews: {}, moods: [], notes: [], expenses: [] }),
        'personal-os-outbox-v1': JSON.stringify([{ sheet: 'notes', key_field: 'id', seq: 1, record: { id: '7', text: '還沒送出去的雜記', created_at: '2026-09-16T00:00:00.000Z', line_id: ME } }])
      }
    });
    e.raw('myLineId = "' + ME + '"; localOnly = false');
    e.raw('outbox = loadOutbox()');

    e.call('load');

    assert.equal(e.read('state.tasks.length'), 0, 'localStorage 不再是畫面的權威來源');
    assert.deepEqual(e.read('state.notes').map(n => n.txt), ['還沒送出去的雜記']);
  });
});

/* ========================================================================== */
describe('連線狀態與輪詢', () => {

  test('開機還沒連上時是「連線中」，不是「異常」', () => {
    const e = env(cloudWith({}));
    assert.equal(e.read('cloudOnline'), null, '還沒試過就不該說人家壞了');
  });

  test('成功一次之後轉為正常', async () => {
    const e = env(cloudWith({ tasks: [] }));
    await e.callRaw('pullFromCloud');
    assert.equal(e.read('cloudOnline'), true);
  });

  test('輪詢間隔是 15 秒（ADR-009 §二）', () => {
    const e = env(cloudWith({}));
    assert.equal(e.read('POLL_INTERVAL'), 15000);
  });

  test('背景時不送請求', () => {
    const e = env(cloudWith({}));
    let ticks = 0;
    e.set('setInterval', (fn) => { ticks++; e.set('__tick', fn); return 1; });
    e.call('startPolling');

    e.raw('document.visibilityState = "hidden"');
    const before = e.calls.length;
    e.raw('__tick()');

    assert.equal(e.calls.length, before, '鎖著螢幕還打雲端，只會燒配額與電力');
  });
});
