/**
 * 首頁的 Email 設定（2026-10-01）
 *
 * 守兩件事：
 *   - 送出去的是專用的 setMyEmail，只帶 email——不是把整列名單送回去（手上那份可能是舊的，
 *     會把管理者剛改的權限蓋回去），也不自稱是誰（身份由 token 決定）
 *   - 格式不對、名單還沒讀到時不亂送、不亂催
 *
 * 跑法：npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';

function env(inputValue, reply = (b) => ({ success: true, email: b.email.trim() })) {
  const els = {};
  const e = loadFrontend({
    fetchImpl: ({ body }) => (body && body.action === 'setMyEmail' ? { json: () => Promise.resolve(reply(body)) } : null)
  });
  e.raw('myLineId = "' + ME + '"; deviceToken = "t"; roster = [{ line_id: "' + ME + '", is_active: "TRUE", email: "" }]');
  e.raw('renderMeCard = function(){}');
  e.set('document', Object.assign({}, e.context.document, {
    getElementById: (id) => (els[id] = els[id] || { value: id === 'emailInput' ? inputValue : '', hidden: true })
  }));
  e.els = els;
  return e;
}
const sent = (e) => e.calls.filter((c) => c.body && c.body.action === 'setMyEmail');

describe('Email 設定', () => {

  test('還沒填 email、名單已讀到 → 首頁顯示這張卡', () => {
    const e = env('');
    e.call('renderEmailCard');
    assert.equal(e.els.emailCard.hidden, false);
  });

  test('已經填了 → 收起來；按「修改 Email」才再打開', () => {
    const e = env('');
    e.raw('roster[0].email = "neil@example.com"');
    e.call('renderEmailCard');
    assert.equal(e.els.emailCard.hidden, true);
    e.call('editMyEmail');
    assert.equal(e.els.emailCard.hidden, false);
  });

  test('名單還沒讀到（離線、剛開機）不催——那時看不出他到底填了沒', () => {
    const e = env('');
    e.raw('roster = []');
    e.call('renderEmailCard');
    assert.equal(e.els.emailCard.hidden, true);
  });

  test('只送 email：不送整列、不自稱是誰；成功後本機名單跟著更新、卡片收起', async () => {
    const e = env(' neil@example.com ');
    assert.equal(await e.callRaw('saveMyEmail'), true);
    assert.equal(sent(e).length, 1);
    assert.deepEqual(Object.keys(sent(e)[0].body).sort(), ['action', 'email', 'token']);
    assert.equal(sent(e)[0].body.email, 'neil@example.com');
    assert.equal(e.read('roster[0].email'), 'neil@example.com');
    assert.equal(e.els.emailCard.hidden, true);
  });

  test('格式不對：不送', async () => {
    const e = env('neil@');
    assert.equal(await e.callRaw('saveMyEmail'), false);
    assert.equal(sent(e).length, 0);
    assert.ok(e.toasts.some((t) => t.includes('格式')));
  });

  test('雲端拒絕：講出原因，本機名單不改', async () => {
    const e = env('neil@example.com', () => ({ error: 'invalid_email' }));
    assert.equal(await e.callRaw('saveMyEmail'), false);
    assert.equal(e.read('roster[0].email'), '');
    assert.ok(e.toasts.some((t) => t.includes('invalid_email')));
  });
});
