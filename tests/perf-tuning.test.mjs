/**
 * 2026-10-06 效能調整（Neil：「設定更新有點延遲、LINE 按鈕反應更慢」）
 *
 * 盯的事：
 *   - LINE 也寫效能紀錄（trigger=line；reply_ms＝使用者等了多久）；只記名單上的人
 *   - 先回覆、後寫 logs；排隊的 logs 一次寫完、內容不變
 *   - 群組設定有快取：第二則群組訊息不再讀 line_groups；App 改開關、join、leave 立刻清快取
 *   - 改設定直接回傳新清單並預熱快取：下一則 LINE 不必重讀 _expense_config
 *   - 碰 Sheet 的次數：群組記帳回覆前、按鈕中間兩步，都比調整前少（數得出來）
 *   - 前端：開關先變、失敗變回來；改設定不再多發一個 adminView
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at', 'created_at', 'updated_at'];
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const G = { type: 'group', groupId: 'Cfam', userId: ME };

/** order：Sheet 的讀寫與「LINE 回覆送出」照發生順序記下來 */
function env({ realLogs = true } = {}) {
  const order = [];
  const replies = [];
  const sheets = {
    line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
      [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE'))]),
    line_groups: new FakeSheet('line_groups', [GROUP_H, ['Cfam', '家族', 'TRUE', 'TRUE', 'TRUE', 'TRUE', '2026-10-01T00:00:00Z', '', '', '']]),
    expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'subcategory', 'targets', 'amount', 'note', 'created_at', 'line_id', 'del']]),
    logs: new FakeSheet('logs', [LOG_H])
  };
  // 用真的 lineReply_（它會記下「回覆送出」的時間點），只把打到 LINE 的網路請求換成記錄器
  const e = loadCodeGs({
    cache: true, realLogs, extraFiles: ['line-router.gs'], tokens: { tok: ME }, sheets,
    properties: { LINE_CHANNEL_ACCESS_TOKEN: 'test-token' },
    overrides: { UrlFetchApp: { fetch: (url, opt) => {
      if (/\/reply$/.test(url)) { order.push('reply'); replies.push(JSON.parse(opt.payload).messages[0]); }
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    } } }
  });
  const wrap = (s) => {
    for (const k of ['getRange', 'getDataRange', 'getLastRow', 'getLastColumn', 'appendRow']) {
      const o = s[k].bind(s);
      s[k] = (...a) => {
        const r = o(...a);
        if (r && r.getValues) {
          const gv = r.getValues.bind(r), sv = r.setValues.bind(r);
          r.getValues = () => { order.push(s.name + ':read'); return gv(); };
          r.setValues = (v) => { order.push(s.name + ':write'); return sv(v); };
        } else order.push(s.name + ':' + (k === 'appendRow' ? 'write' : 'meta'));
        return r;
      };
    }
  };
  Object.values(e.sheets).forEach(wrap);
  const ins = e.ss.insertSheet.bind(e.ss);
  e.ss.insertSheet = (n) => { const s = ins(n); wrap(s); return s; };
  e.order = order;
  e.replies = replies;
  return e;
}
const say = (e, text, source = G) => e.call('handleLineWebhook_', { events: [{ type: 'message', replyToken: 'rt', source, message: { type: 'text', text } }] });
const tap = (e, data, source = G) => e.call('handleLineWebhook_', { events: [{ type: 'postback', replyToken: 'rt', source, postback: { data } }] });
const post = (e, body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: 'tok' }, body)) } }).body);
const before = (e) => { const i = e.order.indexOf('reply'); return e.order.slice(0, i); };
const sheetCalls = (list) => list.filter((x) => x !== 'reply');

/* ========================================================================== */
describe('先回覆、後寫 logs', () => {

  test('LINE 記帳：logs 分頁在回覆送出之後才寫；資料列在回覆之前就寫好', () => {
    const e = env();
    say(e, '記帳/120/外食');
    const i = e.order.indexOf('reply');
    assert.ok(i > 0, '有回覆');
    assert.ok(!e.order.slice(0, i).some((x) => x.startsWith('logs:')), 'logs 不在回覆之前：' + e.order.slice(0, i).join(','));
    assert.ok(e.order.slice(i).includes('logs:write'), 'logs 在回覆之後寫');
    assert.ok(e.order.slice(0, i).includes('expenses:write'), '帳本身在回覆之前就寫好了');
    const log = e.sheets.logs.toRecords().find((r) => r.source === '記帳');
    assert.deepEqual([log.source, log.status, log.input, log.user_id], ['記帳', '成功', '記帳/120/外食', ME], 'log 內容不變');
  });

  test('一個事件有好幾筆 logs：一次寫完（一個 setValues），每筆都在', () => {
    const e = env();
    say(e, '記帳/120/亂打');                // 失敗：一筆 log（第一次用會先建設定表，另有一筆「建立」）
    say(e, '分類');                          // 成功：一筆 log
    assert.deepEqual(e.sheets.logs.toRecords().filter((r) => r.source !== '同步').map((r) => [r.source, r.status]),
      [['記帳', '失敗'], ['查詢', '成功']]);
    const e2 = env();
    e2.sheets.line_groups.values[1][2] = '';   // 群組沒啟用 → 擋下時寫 log
    e2.order.length = 0;
    say(e2, '記帳/120/外食');
    assert.equal(e2.order.filter((x) => x === 'logs:write').length, 1);
  });

  test('事件中途丟例外：已經排隊的 logs 照樣寫進去（不可靜默）', () => {
    const e = env();
    e.sheets.expenses.appendRow = () => { throw new Error('Sheet 壞了'); };
    say(e, '記帳/120/外食');
    assert.ok(e.sheets.logs.toRecords().some((r) => r.status === '失敗' && r.result === '寫入失敗'));
  });

  test('不在 LINE 事件裡（例如 PWA）寫 logs：照舊立刻寫', () => {
    const e = env();
    post(e, { action: 'configAdd', record: { kind: 'category', name: '寵物' } });
    assert.ok(e.sheets.logs.toRecords().some((r) => r.source === '設定'));
  });
});

/* ========================================================================== */
describe('LINE 效能紀錄', () => {

  test('打字與按鈕各寫一列：trigger=line、reply_ms ≤ server_ms、記發話者', () => {
    const e = env();
    say(e, '記帳/300');
    const data = e.replies.at(-1).quickReply.items.find((i) => i.action.label === '日常用品').action.data;
    tap(e, data);
    const rows = e.ss.getSheetByName('performance').toRecords();
    assert.deepEqual(rows.map((r) => [r.action, r.trigger, r.line_id]), [['lineMessage', 'line', ME], ['linePostback', 'line', ME]]);
    for (const r of rows) assert.ok(typeof r.reply_ms === 'number' && r.reply_ms <= r.server_ms);
  });

  test('陌生人（不在名單上）不寫效能紀錄：免得被灌爆', () => {
    const e = env();
    say(e, '記帳/120/外食', { type: 'user', userId: 'Ustranger' });
    assert.equal(e.ss.getSheetByName('performance'), null);
  });

  test('perfSummary 多一組 LINE：一般／慢的時候用 reply_ms；不混進雲端那張表', () => {
    const e = env();
    say(e, '記帳/120/外食');
    say(e, '記帳/50/外食');
    const s = post(e, { action: 'perfSummary' });
    const line = s.line.find((g) => g.action === 'lineMessage');
    assert.equal(line.count, 2);
    assert.ok(line.reply_p50 !== null);
    assert.ok(!s.server.some((g) => /^line/.test(g.action)));
  });

  test('舊的 performance 表沒有 reply_ms 欄：自動補在最右邊', () => {
    const e = env();
    e.sheets.performance = new FakeSheet('performance', [['id', 'ts', 'action', 'trigger', 'client_ms', 'server_ms', 'auth_ms', 'open_ms', 'read_ms', 'sheets', 'rows', 'device_id', 'line_id']]);
    say(e, '記帳/120/外食');
    assert.equal(e.sheets.performance.values[0].at(-1), 'reply_ms');
    assert.ok(e.sheets.performance.toRecords()[0].reply_ms >= 0);
  });
});

/* ========================================================================== */
describe('群組設定快取', () => {

  test('第二則群組訊息不再讀 line_groups', () => {
    const e = env();
    say(e, '記帳/120/外食');
    e.order.length = 0;
    say(e, '記帳/80/外食');
    assert.ok(!e.order.some((x) => x.startsWith('line_groups:')), e.order.join(','));
  });

  test('App 關掉記帳開關 → 下一則立刻被擋（不等 5 分鐘）', () => {
    const e = env();
    say(e, '記帳/120/外食');
    post(e, { action: 'groupSet', group_id: 'Cfam', field: 'cmd_expense', value: false });
    say(e, '記帳/80/外食');
    assert.match(e.replies.at(-1).text, /沒有開放「記帳」/);
  });

  test('leave 之後立刻停用；重新 join 立刻恢復', () => {
    const e = env();
    say(e, '記帳/120/外食');
    e.call('handleLineWebhook_', { events: [{ type: 'leave', source: { type: 'group', groupId: 'Cfam' } }] });
    say(e, '記帳/80/外食');
    assert.match(e.replies.at(-1).text, /還沒啟用/);
    e.call('handleLineWebhook_', { events: [{ type: 'join', replyToken: 'rt', source: { type: 'group', groupId: 'Cfam' } }] });
    say(e, '記帳/80/外食');
    assert.match(e.replies.at(-1).text, /已記錄支出/);
  });
});

/* ========================================================================== */
describe('改設定：直接回傳新清單、預熱快取', () => {

  test('configSet 回傳最新的列與自檢；之後 LINE 用到新設定，不必重讀 _expense_config', () => {
    const e = env();
    say(e, '分類');                                                     // 建表＋進快取
    const out = post(e, { action: 'configSet', key: { kind: 'sub', name: '冷凍' }, field: 'is_active', value: false });
    assert.equal(out.rows.find((r) => r.name === '冷凍').is_active, 'FALSE');
    assert.deepEqual(out.warnings, []);
    e.order.length = 0;
    say(e, '記帳/120/冷凍');
    assert.match(e.replies.at(-1).text, /沒有「冷凍」這個分類/, '新設定已生效');
    assert.ok(!e.order.some((x) => x.startsWith('_expense_config:')), '沒有重讀設定表：' + e.order.join(','));
  });

  test('configAdd 也是：回傳的列包含新的那一筆，新細項 LINE 立刻能用', () => {
    const e = env();
    say(e, '分類');
    const out = post(e, { action: 'configAdd', record: { kind: 'sub', name: '宵夜', parent: '飲食' } });
    assert.ok(out.rows.some((r) => r.name === '宵夜' && r.parent === '飲食'));
    say(e, '記帳/80/宵夜');
    assert.match(e.replies.at(-1).text, /飲食＞宵夜/);
  });

  test('改到一個啟用中的大類都不剩：不放進快取（讓下一次讀取走內建清單那條路）', () => {
    const e = env();
    say(e, '分類');
    for (const n of ['飲食', '交通', '日常用品', '家庭', '醫療', '娛樂', '其他', '教育']) {
      post(e, { action: 'configSet', key: { kind: 'category', name: n }, field: 'is_active', value: false });
    }
    assert.equal(e.call('expenseConfig_').source, 'builtin');
  });
});

/* ========================================================================== */
describe('碰 Sheet 的次數（調整前的數字寫在註解裡）', () => {

  test('群組按鈕的中間兩步（叫出按鈕、按大類）：0 次（調整前各 4 次）', () => {
    const e = env();
    say(e, '分類');                                                     // 暖快取（名單、設定、群組）
    e.order.length = 0;
    say(e, '記帳/300');
    assert.deepEqual(sheetCalls(before(e)), [], '叫出按鈕');
    const food = e.replies.at(-1).quickReply.items.find((i) => i.action.label === '飲食').action.data;
    e.order.length = 0;
    tap(e, food);
    assert.deepEqual(sheetCalls(before(e)), [], '按大類');
  });

  test('群組打字記帳：回覆前 ≤ 6 次（調整前約 15 次：群組設定 4＋寫入 6＋logs 5）', () => {
    const e = env();
    say(e, '分類');
    e.order.length = 0;
    say(e, '記帳/120/外食');
    const n = sheetCalls(before(e)).length;
    assert.ok(n <= 6, '回覆前碰了 ' + n + ' 次：' + before(e).join(','));
  });
});

/* ========================================================================== */
describe('前端：不用等雲端來回', () => {

  function fe(respond) {
    const sent = [];
    const e = loadFrontend({ fetchImpl: ({ body }) => { sent.push(body); return { json: () => respond(body) }; } });
    const made = {};
    const orig = e.context.document.getElementById;
    const get = (id) => made[id] || (made[id] = orig(id));
    e.set('document', Object.assign({}, e.context.document, { getElementById: get }));
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; syncFromCloud = function(){}');
    e.raw('roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:"TRUE"}]; rosterStatus = "ok"');
    return { e, sent, els: new Proxy(made, { get: (_t, id) => get(id) }) };
  }

  test('群組開關：按下去畫面立刻變（雲端還沒回）；雲端失敗就變回來並講明', async () => {
    let release;
    const { e, els } = fe(() => new Promise((r) => { release = () => r({ error: 'read_failed' }); }));
    e.raw('sysTab = "groups"; sysData = {groups:{success:true, rows:[{group_id:"Cfam", name:"家族", is_active:"", cmd_expense:"TRUE", cmd_tasks:"", cmd_query:"", left_at:""}]}}');
    const p = e.callRaw('setGroupFlag', 0, 'is_active');
    assert.match(els.sysBody.innerHTML, /啟用中/, '雲端還沒回，畫面已經變了');
    for (let i = 0; i < 5 && !release; i++) await new Promise((r) => setImmediate(r));
    release();
    await p;
    assert.match(els.sysBody.innerHTML, /待審/, '失敗就變回來');
    assert.ok(e.toasts.some((t) => /已改回來/.test(t)));
  });

  test('改分類：用回應帶的新清單重畫，不再多發一個 adminView', async () => {
    const { e, sent, els } = fe((b) => Promise.resolve(b.action === 'configSet'
      ? { success: true, warnings: [], rows: [{ kind: 'category', name: '飲食', parent: '', color: 'c8', targets: '', aliases: '', sort: 10, is_active: '' }] }
      : { success: true }));
    e.raw('sysTab = "config"; sysData = {config:{success:true, warnings:[], rows:[{kind:"category", name:"飲食", parent:"", color:"c1", targets:"", aliases:"", sort:10, is_active:""}]}}');
    await e.callRaw('setConfigField', 0, 'color', 'c8');
    assert.deepEqual(sent.map((b) => b.action), ['configSet']);
    assert.match(els.sysBody.innerHTML, /var\(--c8\)/);
  });

  test('效能卡片多一張「LINE 多久回覆你」；還沒資料顯示「—」不是 0 ms', () => {
    const { e } = fe(() => Promise.resolve({}));
    const html = e.call('perfSummaryHtml', { success: true, total: 3, days: 7, client: [], server: [],
      line: [{ action: 'linePostback', count: 3, reply_p50: 850, reply_p90: 2100, total_p50: 1900 }, { action: 'lineMessage', count: 0, reply_p50: null, reply_p90: null }] });
    assert.match(html, /LINE 多久回覆你/);
    assert.match(html, /按按鈕<\/td>\s*<td>3<\/td><td>850 ms<\/td><td>2\.1 秒/);
    assert.match(html, /<td>—<\/td>/);
  });
});
