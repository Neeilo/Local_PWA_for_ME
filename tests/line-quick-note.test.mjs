/**
 * 2026-11-12 LINE「幫我記/內容」＋ App 雜記事後分類（🏷️）
 *
 * 盯的事（為什麼）：
 *   - LINE 隨手記一筆雜記，**不帶分類**：寫進 notes 的 text 就是原文，不能被自動塞 [類別]，
 *     否則「之後進 App 再分」就變成要先把錯的類別拿掉
 *   - 內容含「/」不切（網址、A/B 這種字很常見），前後空白去掉（「幫我記/ 內容」也收）
 *   - 跟其他前綴一樣過三道門：模組總開關、feat_notes、內容不可空；擋下來也要留 logs
 *   - logs 的 source 寫「雜記」，App 的 LOG 頁「雜記」鈕才篩得到；任務／記帳的 source 不受影響
 *   - 群組不收（雜記是私人的）：群組裡打了也不回、不寫，避免家族群組的閒聊被存進誰的雜記
 *   - App 端事後分類：只改開頭的 [類別]、內文一字不動；換類別是取代不是疊加；
 *     走既有 pushNote（upsert＋待送佇列），別人的白板雜記不能分
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';                   // 沒有 feat_notes
const GROUP = 'Cfamily';
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_tasks', 'feat_notes'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at', 'created_at', 'updated_at'];
const NOTE_H = ['id', 'text', 'created_at', 'line_id', 'del', 'archive', 'board'];
const REG_H = ['module_id', 'name', 'category', 'icon', 'enabled', 'permission', 'load_policy', 'sort'];

function env({ notesOff = false } = {}) {
  const replies = [];
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H, [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE'], [MOM, '媽媽', 'TRUE', '', 'TRUE', '']]),
    notes: new FakeSheet('notes', [NOTE_H]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'kind', 'origin_chat']]),
    line_groups: new FakeSheet('line_groups', [GROUP_H, [GROUP, '家族', 'TRUE', 'TRUE', 'TRUE', 'TRUE', '', '', '', '']]),
    logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
  };
  if (notesOff) sheets._module_registry = new FakeSheet('_module_registry', [REG_H, ['notes', '雜記', '', '', 'FALSE', '', 'lazy', 10]]);
  const e = loadCodeGs({
    cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], sheets,
    overrides: { lineReply_: (_t, msg) => { replies.push(msg); } }
  });
  e.replies = replies;
  return e;
}
const textOf = (m) => (m && typeof m === 'object' ? m.text : String(m || ''));
function say(e, userId, text, type = 'user') {
  const before = e.replies.length;
  const source = type === 'user' ? { type, userId } : { type, groupId: GROUP, userId };
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });
  return e.replies.length > before ? textOf(e.replies[e.replies.length - 1]) : null;
}
const notesOf = (e) => e.sheets.notes.toRecords();
const logsOf = (e) => e.transactions.map((t) => ({ source: t[0], status: t[1], input: t[2], result: t[3] }));

/* ========================================================================== */
describe('LINE「幫我記/」：寫進雜記、不給分類', () => {

  test('原文照存（沒有 [類別]）、歸屬發話者、id 是數字；回覆講明「未分類，進 App 分」', () => {
    const e = env();
    const reply = say(e, ME, '幫我記/週末去看那家書店');
    const rows = notesOf(e);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '週末去看那家書店');
    assert.equal(rows[0].line_id, ME);
    assert.ok(Number(rows[0].id) > 0, 'id 要是 Date.now() 數字：App 的 noteFromCloud 用 Number(id)');
    assert.ok(rows[0].created_at);
    assert.match(reply, /記下來了/);
    assert.match(reply, /未分類/);
  });

  test('「幫我記/ 內容」前後空白去掉；內容裡的「/」不切', () => {
    const e = env();
    say(e, ME, '幫我記/  看 https://example.com/a/b 跟 A/B 測試  ');
    assert.equal(notesOf(e)[0].text, '看 https://example.com/a/b 跟 A/B 測試');
  });

  test('logs 的 source 是「雜記」（App LOG 頁篩得到），成功一列', () => {
    const e = env();
    say(e, ME, '幫我記/買燈泡');
    const logs = logsOf(e).filter((l) => l.input === '幫我記/買燈泡');
    assert.deepEqual(logs.map((l) => [l.source, l.status]), [['雜記', '成功']]);
  });

  test('任務的 logs source 照舊是「任務」（logSource 是選填，沒給就用前綴）', () => {
    const e = env();
    say(e, ME, '任務/買牛奶');
    assert.ok(logsOf(e).some((l) => l.source === '任務' && l.status === '成功'));
  });

  test('沒有內容：不寫、回用法、logs 記失敗（source 一樣是雜記）', () => {
    const e = env();
    for (const t of ['幫我記', '幫我記/', '幫我記/   ']) {
      const reply = say(e, ME, t);
      assert.match(reply, /幫我記\/內容/, t);
    }
    assert.equal(notesOf(e).length, 0);
    assert.ok(logsOf(e).every((l) => l.source === '雜記' && l.status === '失敗'));
    assert.equal(logsOf(e).length, 3);
  });

  test('沒有 feat_notes：拒絕、不寫、logs 記 forbidden', () => {
    const e = env();
    const reply = say(e, MOM, '幫我記/偷偷記一筆');
    assert.match(reply, /沒有「雜記」功能的權限/);
    assert.equal(notesOf(e).length, 0);
    assert.ok(logsOf(e).some((l) => l.source === '雜記' && l.status === '失敗'));
  });

  test('雜記模組總開關關掉：講模組停用（不是叫人去開權限）、不寫', () => {
    const e = env({ notesOff: true });
    const reply = say(e, ME, '幫我記/模組關了還記得進去嗎');
    assert.match(reply, /停用/);
    assert.equal(notesOf(e).length, 0);
  });

  test('群組裡不收：不回、不寫（雜記是私人的，群組閒聊不能被存進誰的雜記）', () => {
    const e = env();
    assert.equal(say(e, ME, '幫我記/群組裡講的話', 'group'), null);
    assert.equal(notesOf(e).length, 0);
  });

  test('_guide 的 notes 說明列出 LINE「幫我記/」這個寫入者（不然查「這筆雜記從哪來」會找錯地方）', () => {
    const notes = env().call('guideRegistry_').find((g) => g.sheet === 'notes');
    assert.match(notes.writers, /幫我記/);
    assert.match(notes.writers, /PWA/);
  });

  test('指令字典：一對一列得到、群組列不到；沒有 feat_notes 的人看不到', () => {
    const e = env();
    assert.match(say(e, ME, '?'), /幫我記\/內容/);
    assert.doesNotMatch(say(e, MOM, '?'), /幫我記/);
    const groupCmds = e.read('commandsFor_(lineUserById_("' + ME + '"), "group", { cmd_tasks: "TRUE", cmd_expense: "TRUE", cmd_query: "TRUE" }).map(function (c) { return c.key; })');
    assert.ok(!groupCmds.includes('幫我記'));
  });
});

/* ========================================================================== */
describe('App 雜記：🏷️ 事後分類', () => {

  function app(notes) {
    const e = loadFrontend({ fetchImpl: () => null });
    e.raw('__els = {}');
    e.raw(`document.getElementById = function(id){
      if (!__els[id]) __els[id] = { id, value:'', addEventListener(){}, dataset:{}, classList:{add(){},remove(){},toggle(){},contains:()=>false},
        style:{}, textContent:'', innerHTML:'', hidden:false, disabled:false, querySelectorAll:()=>[], querySelector:()=>null, appendChild(){}, setAttribute(){} };
      return __els[id];
    }`);
    e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []; state = EMPTY_STATE()');
    e.raw('state.notes = ' + JSON.stringify(notes));
    return e;
  }
  const upserts = (e) => e.read('outbox').filter((j) => j.sheet === 'notes').map((j) => j.record);

  test('未分類的雜記顯示「🏷️ 未分類」，點開出現類別按鈕', () => {
    const e = app([{ id: 1, txt: 'LINE 來的', ts: 1, line_id: ME }]);
    e.call('renderNotes');
    assert.match(e.read('__els.noteList.innerHTML'), /🏷️ 未分類/);
    e.call('openNoteTag', 1);
    const html = e.read('__els.noteList.innerHTML');
    for (const t of e.read('NOTE_TAGS')) assert.ok(html.includes("setNoteTag(1,'" + t + "')"), t);
  });

  test('選類別：只在開頭加 [類別]、內文不動；走 upsert 送雲端（同一個 id）', () => {
    const e = app([{ id: 1, txt: '看 A/B 測試', ts: 1, line_id: ME }]);
    e.call('setNoteTag', 1, '文章');
    assert.equal(e.read('state.notes[0].txt'), '[文章] 看 A/B 測試');
    const u = upserts(e);
    assert.equal(u.length, 1);
    assert.equal(u[0].id, '1');
    assert.equal(u[0].text, '[文章] 看 A/B 測試');
  });

  test('換類別是取代、不是疊成兩個 [ ]；同一個類別再按一次＝拿掉', () => {
    const e = app([{ id: 1, txt: '[文章] 內容', ts: 1, line_id: ME }]);
    e.call('setNoteTag', 1, '作品');
    assert.equal(e.read('state.notes[0].txt'), '[作品] 內容');
    e.call('setNoteTag', 1, '作品');
    assert.equal(e.read('state.notes[0].txt'), '內容');
  });

  test('沒變就不送（避免重複寫入）', () => {
    const e = app([{ id: 1, txt: '內容', ts: 1, line_id: ME }]);
    e.call('setNoteTag', 1, '');
    assert.equal(upserts(e).length, 0);
  });

  test('別人釘在白板的雜記：沒有 🏷️、setNoteTag 也不改', () => {
    const e = app([{ id: 2, txt: '媽媽的', ts: 1, line_id: MOM, board: true }]);
    e.call('renderNotes');
    assert.doesNotMatch(e.read('__els.noteList.innerHTML'), /openNoteTag/);
    e.call('setNoteTag', 2, '文章');
    assert.equal(e.read('state.notes[0].txt'), '媽媽的');
    assert.equal(upserts(e).length, 0);
  });
});
