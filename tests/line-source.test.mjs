/**
 * LINE 訊息來源（一對一／群組／多人聊天室）的測試
 *
 * 盯三件事：
 *   1. 一對一的 whoami 回覆一字不改——註冊流程教人把那串 ID 整串貼回來，
 *      格式一變，照舊說明操作的人就會貼錯。
 *   2. 群組裡的 whoami 要同時給出 groupId 與發話者 userId；取不到 userId 時
 *      要講清楚原因，而不是讓人以為群組一律沒有。
 *   3. bot 被邀進群組（join）時要留下 logs 並回報 ID——之後依群組開功能、
 *      推播到群組，都得先有這個 ID。
 *
 * 測的是 apps-script/line-router.gs 本人：整份載進 vm，只把會碰網路與 Sheet
 * 的兩個出口（lineReply_、logTransaction_）換成記錄器。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadLineRouter() {
  const replies = [];
  const transactions = [];
  const context = createContext({
    console: { log: () => {}, error: () => {} },
    Date, Array, Object, Math, String, Number, JSON
  });
  runInContext(readFileSync(join(ROOT, 'apps-script', 'line-router.gs'), 'utf8'), context,
    { filename: 'line-router.gs' });

  // 載入後才換掉出口：函式呼叫在執行時才查全域，換掉的就是實際被呼叫的那個
  context.lineReply_ = (token, text) => { replies.push({ token, text: String(text) }); };
  context.logTransaction_ = (...args) => { transactions.push(args.map(String)); };
  // 白名單閘門一律擋下：這批測試只驗白名單「之前」的路徑，不可以走到寫入
  context.writeGate_ = () => ({ allowed: false, error: 'not_on_whitelist' });

  return {
    replies,
    transactions,
    call: (name, ...args) => context[name].apply(null, args)
  };
}

const ME = 'Uc66ce06ca71c3c7f79b2579882f9f8e8';
const GROUP = 'Cabc123';
const ROOM = 'Rxyz789';

function textEvent(source, text) {
  return { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } };
}

/* ========================================================================== */
describe('whoamiMessage_ — 回覆內容', () => {

  test('一對一：格式與改版前一字不差', () => {
    const { call } = loadLineRouter();
    assert.equal(call('whoamiMessage_', { type: 'user', userId: ME }), '你的 userId：\n' + ME);
  });

  test('群組：同時給 groupId 與發話者 userId，各自獨立一行方便複製', () => {
    const { call } = loadLineRouter();
    const msg = call('whoamiMessage_', { type: 'group', groupId: GROUP, userId: ME });
    const lines = msg.split('\n');
    assert.ok(lines.includes(GROUP), 'groupId 要自己一行，才能整行複製');
    assert.ok(lines.includes(ME), 'userId 要自己一行，才能整行複製');
    assert.match(msg, /群組（group）/);
  });

  test('群組但沒有 userId（例如電腦版 LINE）：說明原因，不假裝有值', () => {
    const { call } = loadLineRouter();
    const msg = call('whoamiMessage_', { type: 'group', groupId: GROUP });
    assert.ok(msg.split('\n').includes(GROUP), '取不到 userId 不影響 groupId');
    assert.match(msg, /取不到.*電腦版/);
    assert.doesNotMatch(msg, /undefined/);
  });

  test('多人聊天室：給的是 roomId', () => {
    const { call } = loadLineRouter();
    const msg = call('whoamiMessage_', { type: 'room', roomId: ROOM, userId: ME });
    assert.match(msg, /roomId/);
    assert.ok(msg.split('\n').includes(ROOM));
  });

  test('source 缺漏時不會丟例外', () => {
    const { call } = loadLineRouter();
    assert.equal(call('whoamiMessage_', undefined), '你的 userId：\n(取不到，訊息可能來自群組)');
  });
});

/* ========================================================================== */
describe('handleLineEvent_ — whoami 走在白名單之前', () => {

  test('不在白名單的人在群組裡傳 whoami，照樣拿得到 ID', () => {
    const { call, replies } = loadLineRouter();
    call('handleLineEvent_', textEvent({ type: 'group', groupId: GROUP, userId: 'Ustranger' }, 'WhoAmI'));
    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.split('\n').includes(GROUP));
    assert.ok(replies[0].text.split('\n').includes('Ustranger'));
  });

  test('一般訊息仍然被白名單擋下（沒有因為這次修改被放行）', () => {
    const { call, replies, transactions } = loadLineRouter();
    call('handleLineEvent_', textEvent({ type: 'group', groupId: GROUP, userId: 'Ustranger' }, '記帳/100/餐飲'));
    assert.equal(replies.length, 1);
    assert.doesNotMatch(replies[0].text, /支出/, '被擋下就不可能出現記帳成功的回覆');
    assert.equal(transactions.length, 0);
  });
});

/* ========================================================================== */
describe('handleLineEvent_ — join 事件', () => {

  test('被邀進群組：寫 logs 並在群組裡回報 groupId', () => {
    const { call, replies, transactions } = loadLineRouter();
    call('handleLineEvent_', { type: 'join', replyToken: 'rt', source: { type: 'group', groupId: GROUP } });

    assert.equal(transactions.length, 1);
    const [source, status, input, , detail, , userId] = transactions[0];
    assert.equal(source, '加入群組');
    assert.equal(status, '成功');
    assert.equal(input, 'group/' + GROUP);
    assert.equal(detail, GROUP, 'detail 放完整 ID，之後從 logs 查得到');
    assert.equal(userId, '', 'join 沒有發話者，不可以亂填');

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.split('\n').includes(GROUP));
  });

  test('被邀進多人聊天室：記的是 roomId', () => {
    const { call, replies, transactions } = loadLineRouter();
    call('handleLineEvent_', { type: 'join', replyToken: 'rt', source: { type: 'room', roomId: ROOM } });
    assert.equal(transactions[0][2], 'room/' + ROOM);
    assert.match(replies[0].text, /roomId/);
  });

  test('join 沒帶 ID：記一筆失敗、不回覆（沒東西可報）', () => {
    const { call, replies, transactions } = loadLineRouter();
    call('handleLineEvent_', { type: 'join', replyToken: 'rt', source: { type: 'group' } });
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0][1], '失敗');
    assert.equal(replies.length, 0);
  });

  test('其他事件（follow、非文字訊息）照舊忽略', () => {
    const { call, replies, transactions } = loadLineRouter();
    call('handleLineEvent_', { type: 'follow', replyToken: 'rt', source: { type: 'user', userId: ME } });
    call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: { type: 'user', userId: ME },
                               message: { type: 'sticker' } });
    call('handleLineEvent_', null);
    assert.equal(replies.length, 0);
    assert.equal(transactions.length, 0);
  });
});
