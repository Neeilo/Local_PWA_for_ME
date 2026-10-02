/**
 * ADR-010 — 前端：配對、續期、認證失敗的去向
 *
 * 最危險的一件事跟 ADR-009 一樣：**讀取失敗不可以偽裝成空表**。ADR-010 多了一類
 * 失敗（過期、撤銷、停用），它們必須跟網路錯誤一樣往上拋、讓 pull 原地不動，
 * 然後把人帶去對的畫面——續期、重新配對、或「等管理者」。
 *
 * 其餘盯的事：
 *   - 身份只從 session／配對的回應來，localStorage 裡的舊 line_id 不算數
 *   - 每個請求都帶 token、都是 POST；CLOUD_SECRET 與「自稱的 line_id」不再出現
 *   - 停用＝暫停（D-7）：token 要留著，重新啟用後自動恢復
 *   - 開機時五張表一起回「過期」，續期碼只要一組
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const TOKEN = 'tok-test-device';

const json = (v) => ({ json: () => Promise.resolve(v) });
const TASK = (id, text) => ({ id, text, is_completed: '', created_at: '2026-09-16T00:00:00.000Z', priority: 'M', line_id: ME });

async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** 已配對、雲端照 handler 回應的環境。handler 收 body，回傳 null 代表「寫入成功、讀取空表」 */
function env(handler = () => null, { storage = {} } = {}) {
  const e = loadFrontend({
    storage,
    fetchImpl: ({ body }) => {
      const out = handler(body || {});
      if (out) return json(out);
      if (body && body.action === 'readMany') return null;   // 交給測試環境拿逐張 read 的回答拼（fake-browser.mjs）
      return json(body && body.action === 'read' ? { data: [] } : { success: true });
    }
  });
  e.raw('myLineId = "' + ME + '"; deviceToken = "' + TOKEN + '"; localOnly = false; outbox = []; gateMode = null');
  e.raw('state = EMPTY_STATE()');
  e.localStorage.setItem('personal-os-device-token', TOKEN);
  e.raw('applyIdentity = function(){}');     // 假 DOM 撐不起導覽列重排，與這裡要驗的無關
  return e;
}

const actions = (e, name) => e.calls.filter((c) => c.body && c.body.action === name);

/* ========================================================================== */
describe('⚠️ 認證失敗不可以偽裝成空表', () => {

  // 過期與停用是「暫時進不來」：畫面原地不動。
  // 撤銷與認不得的 token 是「這台不再屬於誰」：ADR-012 D-8 起 forgetDevice 會刻意清掉畫面與待送，
  // 那是明確的決定，不是把讀取失敗當成空表——見下一組測試。
  for (const code of ['token_expired', 'inactive']) {
    test(code + '：pull 原地不動，畫面上的資料不會被清掉', async () => {
      let fail = false;
      const e = env((b) => {
        if (b.action === 'read' && fail) return { error: code };
        if (b.action === 'read' && b.sheet === 'tasks') return { data: [TASK('1', '原有的')] };
        if (b.action === 'renewStart') return { success: true, code: '123456', oa_id: '', expires_in: 600 };
        return null;
      });
      await e.callRaw('pullFromCloud');
      assert.equal(e.read('state.tasks.length'), 1, '前提：正常時讀得到');

      fail = true;
      await e.callRaw('pullFromCloud');
      await settle();
      assert.equal(e.read('state.tasks.length'), 1, '被擋下來不等於雲端是空的');
      assert.equal(e.read('cloudOnline'), false);
    });
  }

  for (const code of ['revoked', 'unknown_token']) {
    test(code + '：這次讀取不算數；畫面與待送佇列由 forgetDevice 刻意清掉（ADR-012 D-8）', async () => {
      let fail = false;
      const e = env((b) => {
        if (b.action === 'read' && fail) return { error: code };
        if (b.action === 'read' && b.sheet === 'tasks') return { data: [TASK('1', '原有的')] };
        return null;
      });
      await e.callRaw('pullFromCloud');
      e.raw('outbox = [{sheet:"notes", key_field:"id", seq:1, record:{id:"9", text:"還沒送"}}]; persistOutbox()');

      fail = true;
      const ok = await e.callRaw('pullFromCloud');
      await settle();
      assert.equal(ok, false, '認證失敗不算一次成功的讀取');
      assert.equal(e.read('cloudOnline'), false);
      assert.equal(e.read('gateMode'), 'pair');
      assert.equal(e.read('state.tasks.length'), 0, '被撤銷的手機不該留著資料副本');
      assert.equal(e.call('pendingCount'), 0, '也不該替下一個配對的人補送前一個人的東西');
      assert.equal(e.localStorage.getItem('personal-os-outbox-v1'), '[]');
    });
  }

  test('LOG 頁：認證失敗算讀取失敗，不畫成「還沒有任何記錄」', async () => {
    const e = env((b) => (b.action === 'read' ? { error: 'token_expired' } : null));
    await e.callRaw('fetchLogs');
    assert.equal(e.read('logsFailed'), true);
    assert.equal(e.read('logsCache'), null);
  });
});

/* ========================================================================== */
describe('認證失敗的去向', () => {

  test('token_expired → 續期畫面；五張表一起回過期，續期碼只要一組；token 留著', async () => {
    const e = env((b) => {
      if (b.action === 'read') return { error: 'token_expired' };
      if (b.action === 'renewStart') return { success: true, code: '735102', oa_id: '@neilos', expires_in: 600 };
      return null;
    });
    await e.callRaw('pullFromCloud');
    await settle();

    assert.equal(e.read('gateMode'), 'renew');
    assert.equal(actions(e, 'renewStart').length, 1, '同時好幾個請求過期，只該開一次續期');
    assert.equal(e.read('renewCommand()'), '驗證裝置 735102');
    assert.equal(e.read('deviceToken'), TOKEN, '過期不是作廢：同一台要續回來');
    assert.equal(e.read('renewLineUrl()'),
      'https://line.me/R/oaMessage/%40neilos/?' + encodeURIComponent('驗證裝置 735102'));
  });

  test('續期：LINE 那邊確認之後，輪詢到 ok 就自己關掉並回到畫面', async () => {
    let renewed = false;
    const e = env((b) => {
      if (b.action === 'renewStart') return { success: true, code: '735102', oa_id: '', expires_in: 600 };
      if (b.action === 'session') return renewed ? { status: 'ok', line_id: ME, device_id: 'd1' } : { status: 'token_expired' };
      return null;
    });
    await e.callRaw('startRenewal');
    await e.callRaw('pollRenewal');
    assert.equal(e.read('gateMode'), 'renew', '還沒確認就繼續等');

    renewed = true;
    await e.callRaw('pollRenewal');
    await settle();
    assert.equal(e.read('gateMode'), null);
    assert.equal(e.read('renewLineUrl()'), '', '沒設官方帳號 ID 時不給「開啟 LINE」，只剩複製');
  });

  test('續期途中被撤銷 → 不再等，清掉 token 回配對', async () => {
    const e = env((b) => {
      if (b.action === 'renewStart') return { success: true, code: '735102', oa_id: '', expires_in: 600 };
      if (b.action === 'session') return { status: 'revoked' };
      return null;
    });
    await e.callRaw('startRenewal');
    await e.callRaw('pollRenewal');
    assert.equal(e.read('gateMode'), 'pair');
    assert.equal(e.read('deviceToken'), null);
  });

  test('renewStart 被拒（撤銷）→ 只能走 A：清掉 token 回配對畫面（D-6）', async () => {
    const e = env((b) => (b.action === 'renewStart' ? { error: 'revoked' } : null));
    await e.callRaw('startRenewal');
    assert.equal(e.read('gateMode'), 'pair');
    assert.equal(e.localStorage.getItem('personal-os-device-token'), null);
  });

  for (const code of ['revoked', 'unknown_token', 'no_token']) {
    test(code + ' → 清掉 token 與快取的身份，回配對畫面', async () => {
      const e = env((b) => (b.action === 'read' ? { error: code } : null));
      e.localStorage.setItem('personal-os-line-id', ME);
      await e.callRaw('pullFromCloud');
      assert.equal(e.read('gateMode'), 'pair');
      assert.equal(e.read('deviceToken'), null);
      assert.equal(e.read('myLineId'), null);
      assert.equal(e.localStorage.getItem('personal-os-device-token'), null);
      assert.equal(e.localStorage.getItem('personal-os-line-id'), null);
    });
  }

  test('inactive → 「等管理者」畫面，但 token 留著：停用＝暫停，重新啟用就自動恢復（D-7）', async () => {
    const e = env((b) => (b.action === 'read' ? { error: 'inactive' } : null));
    await e.callRaw('pullFromCloud');
    assert.equal(e.read('gateMode'), 'inactive');
    assert.equal(e.read('deviceToken'), TOKEN);
    assert.equal(e.localStorage.getItem('personal-os-device-token'), TOKEN);
  });

  test('系統錯誤（白名單讀不到）不是認證問題：不清 token、不開蓋版', async () => {
    const e = env((b) => (b.action === 'read' ? { error: 'whitelist_unavailable' } : null));
    await e.callRaw('pullFromCloud');
    assert.equal(e.read('gateMode'), null);
    assert.equal(e.read('deviceToken'), TOKEN);
    assert.equal(e.read('cloudOnline'), false);
  });

  test('蓋版開著時，待送佇列只排不送、pull 不發請求——logs 不會被一整排過期灌爆', async () => {
    const e = env();
    e.raw('gateMode = "renew"');
    await e.callRaw('queueUpsert', 'tasks', { id: '1', text: '續期中記的' }, 'id');
    await e.callRaw('syncFromCloud');
    assert.equal(e.calls.length, 0);
    assert.equal(e.call('pendingCount'), 1, '東西要留著，續期完會補送');
  });
});

/* ========================================================================== */
describe('身份只從雲端的回應來', () => {

  test('boot 說你是誰就是誰；localStorage 裡的舊 line_id 不算數', async () => {
    const e = env((b) => (b.action === 'boot'
      ? { session: { status: 'ok', line_id: ME, device_id: 'd9' }, line_users: [], data: { tasks: [], reviews: [], moods: [], notes: [], expenses: [] }, denied: [] }
      : null));
    e.raw('myLineId = "Usomeone_else"');
    const ok = await e.callRaw('startSession');
    assert.equal(ok, true);
    assert.equal(e.read('myLineId'), ME);
    assert.equal(e.read('myDeviceId'), 'd9');
    assert.equal(e.localStorage.getItem('personal-os-line-id'), ME);
  });

  test('沒有 token 時，快取的 line_id 一律不採用；舊的名單快取被清掉', () => {
    const e = loadFrontend({ storage: { 'personal-os-line-id': ME, 'personal-os-line-users': '[{"line_id":"x"}]' } });
    e.call('loadIdentity');
    assert.equal(e.read('myLineId'), null, '沒有配對過的裝置不能靠 localStorage 冒充任何人');
    assert.equal(e.localStorage.getItem('personal-os-line-users'), null);
  });

  test('有 token 時，開機先用快取的 line_id 把畫面畫上去（之後由 session 校正）', () => {
    const e = loadFrontend({ storage: { 'personal-os-line-id': ME, 'personal-os-device-token': TOKEN } });
    e.call('loadIdentity');
    assert.equal(e.read('deviceToken'), TOKEN);
    assert.equal(e.read('myLineId'), ME);
  });

  test('沒有 token 的冷啟動 → 配對畫面；按了「先在本機用」就不再催', async () => {
    const e = loadFrontend();
    e.raw('applyIdentity = function(){}');
    e.call('loadIdentity');
    await e.callRaw('startSession', 'cold');
    assert.equal(e.read('gateMode'), 'pair');
    assert.equal(e.calls.length, 0, '沒有 token 就不必問雲端');

    e.call('useLocalOnly');
    assert.equal(e.read('gateMode'), null);
    e.call('loadIdentity');
    await e.callRaw('startSession', 'cold');
    assert.equal(e.read('gateMode'), null);
  });
});

/* ========================================================================== */
describe('每個請求都帶 token、都走 POST', () => {

  test('讀、寫、封存、週期完成、名單、LOG：body 都有 token，沒有 secret，也沒有 GET', async () => {
    const e = env((b) => {
      if (b.action === 'archiveMail') return { success: true, total: 1, deleted: 1 };
      if (b.action === 'setMyEmail') return { success: true, email: b.email };
      if (b.action === 'completeRecurring') return { success: true, spawned: false };
      return null;
    });
    e.raw('roster = [{ line_id: "' + ME + '", is_active: "TRUE", is_admin: "TRUE" }]');   // 封存只給管理者
    await e.callRaw('pullFromCloud');
    await e.callRaw('refreshRoster');
    await e.callRaw('fetchLogs');
    await e.callRaw('queueUpsert', 'tasks', { id: '1', text: 'x' }, 'id');
    e.raw('roster = [{ line_id: "' + ME + '", is_active: "TRUE", is_admin: "TRUE" }]');   // refreshRoster 換掉了名單
    await e.callRaw('archiveTombstones');
    e.raw('renderMeCard = function(){}; renderEmailCard = function(){}');   // 畫面不是這裡要驗的
    e.set('document', Object.assign({}, e.context.document, { getElementById: () => ({ value: 'neil@example.com', hidden: false }) }));
    await e.callRaw('saveMyEmail');
    await e.callRaw('completeRecurringTask', { id: 2, txt: 'y', done: true, ts: 1, due: '2026-09-30', recurN: '1', recurUnit: '月' });
    await settle();

    // ADR-012 起五張表合成一個 readMany，請求數變少了；改成點名每一種都真的送出去
    const sent = new Set(e.calls.map((c) => c.body.action));
    for (const a of ['readMany', 'read', 'upsert', 'archiveMail', 'setMyEmail', 'completeRecurring']) {
      assert.ok(sent.has(a), '前提：' + a + ' 真的有送出去');
    }
    for (const c of e.calls) {
      assert.equal(c.options && c.options.method, 'POST', '不該再有 GET：' + c.url);
      assert.equal(c.url.includes('?'), false, '參數都在 body，不在網址');
      assert.equal(c.body.token, TOKEN, (c.body.action || '?') + ' 沒帶 token');
      assert.equal('secret' in c.body, false, 'CLOUD_SECRET 不該再出現');
      assert.equal('line_id' in c.body, false, '身份由後端從 token 換出，前端不自稱（' + c.body.action + '）');
    }
  });

  test('index.html 不再有 CLOUD_SECRET 的佔位字串', () => {
    const e = loadFrontend();
    assert.equal(e.read('typeof CLOUD_SECRET'), 'undefined');
  });
});

/* ========================================================================== */
describe('配對與解除', () => {

  test('配對碼錯了：講清楚原因、不存任何東西', async () => {
    const e = loadFrontend({ fetchImpl: ({ body }) => (body.action === 'pairClaim' ? json({ error: 'invalid_code' }) : null) });
    e.raw('applyIdentity = function(){}; deviceToken = null; myLineId = null');
    e.call('openAuthGate', 'pair');
    const ok = await e.callRaw('submitPairCode', '000000');
    assert.equal(ok, false);
    assert.match(e.read('gateNotice'), /不對或已過期/);
    assert.equal(e.read('gateMode'), 'pair', '錯了就留在配對畫面，不能被當成認證錯誤轉走');
    assert.equal(e.localStorage.getItem('personal-os-device-token'), null);
  });

  test('配對時帳號還沒被核准：留在配對畫面說明原因，不被當成「這台被停用」轉走', async () => {
    const e = loadFrontend({ fetchImpl: ({ body }) => (body.action === 'pairClaim' ? json({ error: 'inactive' }) : null) });
    e.raw('applyIdentity = function(){}; deviceToken = null; myLineId = null');
    e.call('openAuthGate', 'pair');
    await e.callRaw('submitPairCode', '123456');
    assert.equal(e.read('gateMode'), 'pair');
    assert.match(e.read('gateNotice'), /核准/);
  });

  test('配對碼不是 6 位數：不發請求', async () => {
    const e = loadFrontend();
    e.raw('applyIdentity = function(){}');
    e.call('openAuthGate', 'pair');
    assert.equal(await e.callRaw('submitPairCode', '12 34'), false);
    assert.equal(e.calls.length, 0);
  });

  test('配對請求帶上裝置名稱；token 原文只存這台的 localStorage，不進 state', async () => {
    const e = loadFrontend({
      fetchImpl: ({ body }) => (body.action === 'pairClaim'
        ? json({ success: true, token: 'tok-new', device_id: 'd1', line_id: ME, display_name: 'Neil' })
        : json(body.action === 'read' ? { data: [] } : { success: true }))
    });
    e.raw('applyIdentity = function(){}; state = EMPTY_STATE(); outbox = []');
    await e.callRaw('submitPairCode', '123456');
    const req = actions(e, 'pairClaim')[0].body;
    assert.equal(req.code, '123456');
    assert.match(req.device_label, /·/);
    assert.equal(e.localStorage.getItem('personal-os-device-token'), 'tok-new');
    assert.equal(JSON.stringify(e.read('state')).includes('tok-new'), false);
  });

  test('解除這台：雲端撤銷成功才清本機；連不上就什麼都不清', async () => {
    let online = false;
    const e = env((b) => (b.action === 'revokeDevice' ? (online ? { success: true, revoked: 1 } : { error: 'network' }) : null));
    e.raw('myDeviceId = "d1"');

    await e.callRaw('unpairThisDevice');
    assert.equal(e.read('deviceToken'), TOKEN, '雲端還沒撤銷，本機先丟掉 token 會留下一台沒人拿著的活裝置');

    online = true;
    await e.callRaw('unpairThisDevice');
    assert.equal(actions(e, 'revokeDevice').at(-1).body.device_id, 'd1');
    assert.equal(e.read('deviceToken'), null);
    assert.equal(e.read('gateMode'), 'pair');
  });
});
