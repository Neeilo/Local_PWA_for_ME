/**
 * ADR-018 PR-D（B-3）— 指令登記表、? 字典、打錯指令只回一行
 *
 * 盯的事（為什麼）：
 *   - 登記表跟真的路由對齊：任何路由前綴（ROUTE_TABLE、股票、查、分類、初始化、配對、驗證裝置、
 *     註冊、whoami）沒登記 → 紅燈；用法字串跟 ROUTE_TABLE 不一致 → 紅燈；群組開關（GROUP_CMD_BY_PREFIX）
 *     對不上 → 紅燈。字典會講錯的那天，就是有人加了指令忘了登記的那天
 *   - ?／指令：依身分（管理員、feat）與聊天室過濾——只列這個人在這裡真的能用的
 *   - 群組：沒啟用的群組不回（家族群組裡「?」常常只是聊天）；啟用的只列這個群組開放的
 *   - 打錯指令只回一行「看不懂這個指令，傳 ? 看字典」＋版本號尾行
 *   - PWA：commandDict 只有通過驗證的人拿得到，同樣照權限過濾；設定頁點開才抓
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const GROUP = 'Cfamily';
const TOK_MOM = 'tok-mom-device';
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at', 'created_at', 'updated_at'];

function env({ group = { is_active: 'TRUE', cmd_expense: '', cmd_tasks: 'TRUE', cmd_query: 'TRUE' } } = {}) {
  const replies = [];
  const g = Object.assign({ group_id: GROUP, name: '家族', joined_at: '', left_at: '', created_at: '', updated_at: '' }, group);
  const e = loadCodeGs({
    cache: true,
    extraFiles: ['line-router.gs'],
    tokens: { [TOK_MOM]: MOM },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense', 'feat_tasks', 'feat_notes', 'feat_stock'],
        [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
        [MOM, '媽媽', 'TRUE', '', '', 'TRUE', 'TRUE', '']
      ]),
      line_groups: new FakeSheet('line_groups', [GROUP_H, GROUP_H.map((h) => (g[h] === undefined ? '' : g[h]))]),
      tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id']]),
      logs: new FakeSheet('logs', [['id']])
    },
    overrides: { lineReply_: (_t, msg) => { replies.push(typeof msg === 'object' ? msg.text : String(msg)); } }
  });
  e.replies = replies;
  return e;
}
function say(e, userId, text, type = 'user') {
  const before = e.replies.length;
  const source = type === 'user' ? { type, userId } : { type, groupId: GROUP, userId };
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });
  return e.replies.length > before ? e.replies[e.replies.length - 1] : null;
}

/* ========================================================================== */
describe('登記表跟真的路由對齊（新增指令沒登記 → 紅燈）', () => {

  test('每一個路由前綴與特殊指令都登記了', () => {
    const e = env();
    const keys = e.read('COMMANDS.map(function (c) { return c.key; })');
    const routed = [].concat(
      e.read('Object.keys(ROUTE_TABLE)'),
      e.read('Object.keys(STOCK_PREFIXES)'),
      e.read('[QUERY_PREFIX, CATEGORY_COMMAND, INIT_COMMAND, PAIR_COMMAND, RENEW_COMMAND, REGISTER_PREFIX, "whoami"]'));
    for (const k of routed) assert.ok(keys.includes(k), '沒登記：' + k);
    assert.equal(new Set(keys).size, keys.length, 'key 不能重複');
  });

  test('ROUTE_TABLE 的用法字串跟登記表一字不差', () => {
    const e = env();
    for (const k of e.read('Object.keys(ROUTE_TABLE)')) {
      assert.equal(e.read('COMMANDS.filter(function (c) { return c.key === ' + JSON.stringify(k) + '; })[0].usage'),
        e.read('ROUTE_TABLE[' + JSON.stringify(k) + '].usage'), k);
    }
  });

  test('群組開關對齊：GROUP_CMD_BY_PREFIX 的每個前綴在登記表裡是 both、groupCmd 相同；股票只限一對一', () => {
    const e = env();
    const map = e.read('GROUP_CMD_BY_PREFIX');
    const cmds = e.read('COMMANDS');
    for (const [prefix, cmd] of Object.entries(map)) {
      const c = cmds.find((x) => x.key === prefix);
      assert.equal(c.scope, 'both', prefix);
      assert.equal(c.groupCmd, cmd, prefix);
    }
    // 反過來：登記成群組能用、又有 groupCmd 的，路由也真的放行（分類走 groupCommandOf_ 的特例）
    for (const c of cmds.filter((x) => x.groupCmd)) {
      const sample = c.key === '分類' ? '分類' : c.key + '/x';
      assert.equal(e.call('groupCommandOf_', sample), c.groupCmd, c.key);
    }
    for (const k of e.read('Object.keys(STOCK_PREFIXES)')) assert.equal(cmds.find((x) => x.key === k).scope, 'private');
  });

  test('每一筆都有分組（在 COMMAND_GROUPS 裡）與用法', () => {
    const e = env();
    const groups = e.read('COMMAND_GROUPS');
    for (const c of e.read('COMMANDS')) {
      assert.ok(groups.includes(c.group), c.key + ' 的分組');
      assert.ok(c.usage, c.key + ' 的用法');
      assert.ok(['private', 'group', 'both'].includes(c.scope), c.key + ' 的 scope');
    }
  });
});

/* ========================================================================== */
describe('一對一的 ?／指令', () => {

  test('管理員：全部（含初始化、股票）；分組、附例子', () => {
    const e = env();
    const r = say(e, ME, '?');
    assert.match(r, /^📖 指令字典（一對一，只列你能用的）/);
    for (const s of ['【任務】', '【記帳】', '【查詢】', '【股票】', '【管理】', '・初始化', '・買/代號', '例：記帳/120/飲食/午餐']) assert.ok(r.includes(s), s);
  });

  test('一般成員（沒有記帳、沒有股票）：看不到記帳、股票、初始化', () => {
    const e = env();
    const r = say(e, MOM, '指令');
    assert.ok(r.includes('・任務/內容'));
    for (const s of ['【記帳】', '【股票】', '初始化', '・分類']) assert.ok(!r.includes(s), '不該有：' + s);
  });

  test('全形？也收', () => {
    const e = env();
    assert.match(say(e, MOM, '？'), /📖 指令字典/);
  });

  test('打錯指令：只回一行＋版本號尾行', () => {
    const e = env();
    const lines = say(e, MOM, '亂打/123').split('\n');
    assert.equal(lines[0], '看不懂這個指令，傳 ? 看字典');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^目前版本：/);
  });

  test('字典不加「（由 XXX 彙整）」：它是程式產生的，不是 AI 回答', () => {
    const e = env();
    assert.doesNotMatch(say(e, ME, '?'), /彙整/);
  });
});

/* ========================================================================== */
describe('群組的 ?', () => {

  test('啟用的群組：只列這個群組開放的（這裡沒開記帳）、限一對一的不列', () => {
    const e = env();
    const r = say(e, ME, '?', 'group');
    assert.match(r, /^📖 指令字典（這個群組/);
    assert.ok(r.includes('・任務/內容') && r.includes('・查/'));
    for (const s of ['【記帳】', '・分類', '【股票】', '初始化', '配對']) assert.ok(!r.includes(s), '不該有：' + s);
    assert.ok(r.includes('whoami'), 'whoami 群組也能用');
  });

  test('沒啟用的群組：不回（不插嘴）', () => {
    const e = env({ group: { is_active: '', cmd_tasks: 'TRUE' } });
    assert.equal(say(e, ME, '?', 'group'), null);
  });

  test('不在名單上的人在群組打 ?：不回', () => {
    const e = env();
    assert.equal(say(e, 'Ustranger', '?', 'group'), null);
  });
});

/* ========================================================================== */
describe('PWA：📖 指令字典（commandDict）', () => {

  test('照權限過濾、標出能在哪裡用；不需要管理員', () => {
    const e = env();
    const out = JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify({ token: TOK_MOM, action: 'commandDict', trigger: 'manual' }) } }).body);
    assert.equal(out.success, true);
    const groups = out.groups.map((g) => g.group);
    assert.ok(groups.includes('任務') && !groups.includes('記帳') && !groups.includes('股票') && !groups.includes('管理'));
    const task = out.groups.find((g) => g.group === '任務').items[0];
    assert.deepEqual(Object.keys(task).sort(), ['example', 'note', 'scope', 'usage']);
    assert.equal(task.scope, '一對一、群組都可以');
  });

  test('沒有 token：拿不到', () => {
    const e = env();
    const out = JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify({ action: 'commandDict', trigger: 'manual' }) } }).body);
    assert.equal(out.error, 'no_token');
  });

  test('設定頁：點開才抓（帶 trigger），畫出分組與用法', async () => {
    const DICT = { success: true, groups: [{ group: '任務', items: [{ usage: '任務/內容[/H或M或L]', example: '任務/繳電話費/H', note: '建好會問到期日', scope: '一對一、群組都可以' }] }] };
    const fe = loadFrontend({ fetchImpl: ({ body }) => ({ json: () => Promise.resolve(body.action === 'commandDict' ? DICT : { success: true }) }) });
    fe.raw('myLineId = "' + MOM + '"; deviceToken = "tok"');
    const els = {};
    const doc = fe.context.document;
    const orig = doc.getElementById;
    fe.set('document', Object.assign({}, doc, { getElementById: (id) => els[id] || (els[id] = orig(id)) }));
    assert.equal(fe.calls.length, 0);
    fe.call('toggleFold', 'dict');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(fe.calls.map((c) => c.body.action + ':' + c.body.trigger), ['commandDict:manual']);
    const html = els.dictBody.innerHTML;
    assert.match(html, /<code>任務\/內容\[\/H或M或L\]<\/code>/);
    assert.match(html, /例：任務\/繳電話費\/H/);
    assert.match(html, /一對一、群組都可以/);
  });
});
