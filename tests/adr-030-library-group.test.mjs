/**
 * ADR-030 — 圖書館群組：收藏與週報搬進專屬 LINE 群組（後端）
 *
 * 為什麼有這批測試：功能開始分聊天室。圖書館收藏原本寫死只在一對一（ADR-020 B-1）、週報寫死推一對一（ADR-028 D-6），
 * 改成走 line_groups 的 cmd_clips／notify_clips（比照 Mail 的 cmd_gmail／notify_gmail）。
 * 盯的事（交棒票驗收）：
 *   - 群組開 cmd_clips：丟 IG／Threads／一般網址 → 登記在發話者名下、回「收到 ✅」；logs 只露群組 id 前 3 碼
 *   - 群組沒開 cmd_clips／未啟用／已離開／發話者沒 feat_clips／不在白名單：不收、不回、不寫 logs（家族群組丟連結不會被收）
 *   - 一對一丟網址：不登記、不寫 logs、回「📚 收藏請丟到圖書館群組」；一對一既有指令不受影響
 *   - 週報只推 notify_clips 群組、不推一對一；只推管理者的週報；沒有群組時照常存＋寫 logs；每個群組各一筆 logs
 *   - 「週報」：有成功期／只有失敗期／完全沒有；只讀發話者本人的；手動預覽標「（預覽）」；不呼叫 AI、不 push
 *   - 初始化補欄後既有群組兩欄都是關；新加入的群組兩欄也是關；Mail 群組推播不變
 *
 * 測試只用合成資料（假 group_id／line_id、example.com）。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uadmin';                   // 管理者，有 feat_clips
const DAD = 'Umember';                 // 一般成員，有 feat_clips
const MOM = 'Unoclip';                 // 沒有 feat_clips
const STRANGER = 'Ustranger';          // 不在白名單
const LIB = 'Clib0001';                // 圖書館群組
const FAM = 'Cfam0002';                // 家族群組（沒開 cmd_clips）
const FEATS = ['feat_tasks', 'feat_expense', 'feat_clips'];
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS);
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at',
  'created_at', 'updated_at', 'notify_due', 'cmd_gmail', 'notify_gmail', 'cmd_clips', 'notify_clips'];
const P1 = 'https://www.instagram.com/p/AAA111/';
const TH = 'https://www.threads.com/@demo.user/post/TAAA111';
const DAY = 86400000;
/** 2026-11-13（五）20:00 台北 */
const FRI = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));

const LIB_ROW = { group_id: LIB, name: '圖書館', is_active: 'TRUE', cmd_clips: 'TRUE', notify_clips: 'TRUE' };
const FAM_ROW = { group_id: FAM, name: '家族', is_active: 'TRUE', cmd_expense: 'TRUE', cmd_tasks: 'TRUE', cmd_query: 'TRUE', notify_gmail: 'TRUE' };

function env({ groups = [LIB_ROW, FAM_ROW], groupHeaders = GROUP_H, ai = null, push = null } = {}) {
  const replies = [];
  const prompts = [];
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H,
      [ME, '管理者', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
      [DAD, '成員 A', 'TRUE', '', 'TRUE', 'TRUE', 'TRUE'],
      [MOM, '成員 B', 'TRUE', '', 'TRUE', 'TRUE', '']]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'priority', 'is_completed', 'line_id', 'kind', 'due_date', 'created_at', 'origin_chat', 'del']]),
    logs: new FakeSheet('logs', [LOG_H]),
    line_groups: new FakeSheet('line_groups', [groupHeaders].concat(groups.map((o) => groupHeaders.map((h) => (o[h] === undefined ? '' : o[h])))))
  };
  const e = loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], sheets,
    properties: { APIFY_TOKEN: 'x' }, pushImpl: push || undefined,
    overrides: {
      lineReply_: (_t, text) => replies.push(text),
      callAiLong_: (prompt) => { prompts.push(prompt); return ai ? ai(prompt) : { ok: true, text: '{"items":[]}', label: 'Gemini' }; }
    }
  });
  e.call('ensureClipsSheet_');
  e.replies = replies;
  e.prompts = prompts;
  return e;
}

const DM = (userId = ME) => ({ type: 'user', userId });
const IN = (groupId, userId = ME) => ({ type: 'group', groupId, userId });
/** 送一則訊息；有回覆回那句（字串），沒回覆回 null */
function say(e, text, source = IN(LIB)) {
  const before = e.replies.length;
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });
  if (e.replies.length === before) return null;
  const m = e.replies.at(-1);
  return m && typeof m === 'object' ? String(m.text) : String(m);
}
const clips = (e) => e.sheets.clips.toRecords();
const reports = (e) => (e.sheets.clip_reports ? e.sheets.clip_reports.toRecords() : []);
const logs = (e) => e.transactions;

/** 收齊的收藏，給週報當候選 */
function seedDone(e, id, owner = ME) {
  const H = e.read('CLIPS_HEADERS');
  const r = { id, line_id: owner, url: 'https://www.instagram.com/p/' + id + '/', kind: 'post', status: 'done',
    caption: '標題 ' + id + '\n內文', collected_at: new Date(FRI.getTime() - 30 * DAY).toISOString(), del: '' };
  e.sheets.clips.values.push(H.map((h) => (r[h] == null ? '' : r[h])));
}
const aiRec = (ids) => (prompt) => {
  const all = [...prompt.matchAll(/- id: (\S+)｜/g)].map((m) => m[1]);
  return { ok: true, label: 'Gemini', text: JSON.stringify({ items: all.map((id) => ({ id, verdict: ids.includes(id) ? 'recommend' : 'normal', reason: 'r' })) }) };
};

/* ========================================================================== */
describe('群組收藏（D-1、D-4）', () => {

  test('圖書館群組開 cmd_clips：IG／Threads／一般網址都登記在發話者名下、回「收到 ✅」', () => {
    const e = env();
    assert.equal(say(e, '看這篇 ' + P1), '收到 ✅');
    assert.equal(say(e, TH + ' 跟 https://example.com/a', IN(LIB, DAD)), '收到 ✅（2 篇）');
    assert.deepEqual(clips(e).map((r) => [r.line_id, r.kind, r.status]),
      [[ME, 'post', 'pending'], [DAD, 'threads', 'pending'], [DAD, 'link', 'link']]);
  });

  test('logs：成功同一對一的收藏紀錄，另記群組 id 前 3 碼（不露完整 id）', () => {
    const e = env();
    say(e, P1);
    const row = logs(e).find((t) => t[0] === '收藏' && t[1] === '成功');
    assert.ok(row, '有收藏成功紀錄');
    assert.match(String(row[4]), /group=Cli…/);
    assert.ok(!JSON.stringify(logs(e)).includes(LIB), '完整群組 id 不進 logs');
  });

  test('任一門不過：不收、不回、不寫 logs', () => {
    const cases = [
      ['家族群組沒開 cmd_clips', env(), IN(FAM)],
      ['圖書館群組未啟用', env({ groups: [Object.assign({}, LIB_ROW, { is_active: '' })] }), IN(LIB)],
      ['bot 已離開', env({ groups: [Object.assign({}, LIB_ROW, { left_at: '2026-11-01' })] }), IN(LIB)],
      ['不在 line_groups 的群組', env(), IN('Cunknown')],
      ['發話者沒 feat_clips', env(), IN(LIB, MOM)],
      ['發話者不在白名單', env(), IN(LIB, STRANGER)],
      ['取不到 userId', env(), { type: 'group', groupId: LIB }]
    ];
    for (const [why, e, source] of cases) {
      assert.equal(say(e, P1, source), null, why + '：不回');
      assert.equal(clips(e).length, 0, why + '：不收');
      assert.equal(logs(e).length, 0, why + '：不寫 logs');
    }
  });

  test('群組裡非網址的閒聊照舊不回；既有指令照舊（任務夾網址不收藏）', () => {
    const e = env({ groups: [Object.assign({}, LIB_ROW, { cmd_tasks: 'TRUE' })] });
    assert.equal(say(e, '今天天氣不錯'), null);
    assert.match(say(e, '任務/讀 ' + P1), /任務/);
    assert.equal(clips(e).length, 0);
    assert.equal(e.sheets.tasks.toRecords().length, 1);
  });
});

/* ========================================================================== */
describe('一對一不再收（D-1、D-2）', () => {

  test('一對一丟 IG／Threads／一般網址：不登記、不寫 logs、回提醒', () => {
    const e = env();
    for (const t of [P1, TH, '看 https://example.com/x']) {
      assert.equal(say(e, t, DM()), '📚 收藏請丟到圖書館群組');
    }
    assert.equal(clips(e).length, 0);
    assert.ok(!logs(e).some((t) => t[0] === '收藏'), '不寫收藏 logs');
  });

  test('沒有 feat_clips 的人一對一丟網址：照舊回看不懂（不提圖書館）', () => {
    const e = env();
    assert.match(say(e, P1, DM(MOM)), /看不懂這個指令/);
  });

  test('一對一既有指令不受影響', () => {
    const e = env();
    assert.match(say(e, '任務/讀 ' + P1, DM()), /任務/);
    assert.equal(e.sheets.tasks.toRecords().length, 1);
    assert.equal(clips(e).length, 0);
  });

});

/* ========================================================================== */
describe('週報推群組（D-3）', () => {

  test('排程週報只推 notify_clips 群組、不推一對一；成員的週報不推；每個群組各一筆 logs', () => {
    const e = env({ ai: aiRec(['a']) });
    seedDone(e, 'a');
    seedDone(e, 'b', DAD);
    e.call('runClipReportJob_', FRI, { budgetLeft: () => 240000 });
    assert.equal(reports(e).length, 2, '兩個人的週報都照常產生、存檔');
    assert.deepEqual(e.pushes.map((p) => p.to), [LIB], '只推圖書館群組一次（管理者的）');
    assert.match(e.pushes[0].text, /📊 本週圖書館週報\n⭐ 推薦：\n・標題 a/);
    assert.ok(!e.pushes.some((p) => p.to === ME || p.to === DAD), '不推一對一');
    const pushLogs = logs(e).filter((t) => t[0] === '推播' && t[2] === 'clipReport');
    assert.equal(pushLogs.filter((t) => t[1] === '成功').length, 1);
    assert.match(String(pushLogs.find((t) => t[1] === '成功')[3]), /Cli…/);
    assert.ok(pushLogs.some((t) => t[6] === DAD && /不是管理者/.test(t[3])), '成員的週報寫 logs 說明沒推');
    assert.ok(!JSON.stringify(pushLogs).includes('標題 a'), '不存訊息內容');
  });

  test('沒有開 notify_clips 的群組：週報照常存，logs 記沒有推', () => {
    const e = env({ groups: [Object.assign({}, LIB_ROW, { notify_clips: '' }), FAM_ROW] });
    seedDone(e, 'a');
    e.call('runClipReportJob_', FRI, { budgetLeft: () => 240000 });
    assert.equal(reports(e).filter((r) => r.line_id === ME).length, 1);
    assert.equal(e.pushes.length, 0);
    assert.ok(logs(e).some((t) => t[0] === '推播' && /沒有開 notify_clips 的群組，沒有推/.test(t[3])));
  });

  test('停用、已離開的群組不推；失敗通知也走同一組群組', () => {
    const e = env({
      groups: [LIB_ROW, Object.assign({}, LIB_ROW, { group_id: 'Coff', is_active: '' }), Object.assign({}, LIB_ROW, { group_id: 'Cleft', left_at: '2026-11-01' })],
      ai: () => ({ ok: false, reason: 'HTTP 500', label: 'Gemini' })
    });
    seedDone(e, 'a');
    e.call('runClipReportJob_', FRI, { budgetLeft: () => 240000 });
    assert.deepEqual(e.pushes.map((p) => p.to), [LIB]);
    assert.match(e.pushes[0].text, /產生失敗（AI 呼叫失敗：HTTP 500）/);
  });

  test('群組推播失敗：寫失敗 logs，不影響週報存檔', () => {
    const e = env({ push: () => ({ ok: false, code: 400, reason: 'HTTP 400' }) });
    seedDone(e, 'a');
    e.call('runClipReportJob_', FRI, { budgetLeft: () => 240000 });
    assert.equal(reports(e).filter((r) => r.line_id === ME).length, 1);
    assert.ok(logs(e).some((t) => t[0] === '推播' && t[1] === '失敗' && /HTTP 400/.test(t[3])));
  });
});

/* ========================================================================== */
describe('「週報」關鍵字（D-5）', () => {

  test('有成功期：回最近一期成功週報的短版；用 reply、不 push、不呼叫 AI；寫 logs', () => {
    const e = env({ ai: aiRec(['a']) });
    seedDone(e, 'a');
    e.call('runClipReportJob_', FRI, { budgetLeft: () => 240000 });
    const aiCalls = e.prompts.length;
    const pushes = e.pushes.length;
    const reply = say(e, ' 週報 ');
    assert.match(reply, /^📊 本週圖書館週報\n⭐ 推薦：\n・標題 a/);
    assert.equal(e.prompts.length, aiCalls, '不呼叫 AI');
    assert.equal(e.pushes.length, pushes, '不 push');
    assert.ok(logs(e).some((t) => t[0] === '收藏' && t[2] === '週報' && t[1] === '成功'));
  });

  test('最新一期失敗：回上一期成功的；手動預覽標「（預覽）」', () => {
    let fail = false;
    const e = env({ ai: (p) => (fail ? { ok: false, reason: 'HTTP 500', label: 'Gemini' } : aiRec(['a'])(p)) });
    seedDone(e, 'a');
    e.call('clipReportGenerate_', ME, 'manual', FRI, '');
    fail = true;
    e.call('clipReportGenerate_', ME, 'manual', new Date(FRI.getTime() + 60000), '');
    assert.deepEqual(reports(e).map((r) => r.status), ['ok', 'failed']);
    assert.match(say(e, '週報'), /^📊 本週圖書館週報（預覽）\n⭐ 推薦：\n・標題 a/);
  });

  test('只有失敗期／完全沒有：「還沒有週報，週五 19:00 見 📊」', () => {
    const e = env();
    assert.equal(say(e, '週報'), '還沒有週報，週五 19:00 見 📊');
    const e2 = env({ ai: () => ({ ok: false, reason: 'HTTP 500', label: 'Gemini' }) });
    seedDone(e2, 'a');
    e2.call('clipReportGenerate_', ME, 'manual', FRI, '');
    assert.equal(say(e2, '週報'), '還沒有週報，週五 19:00 見 📊');
  });

  test('只讀發話者本人的：成員 A 問，看不到管理者的週報', () => {
    const e = env({ ai: aiRec(['a']) });
    seedDone(e, 'a');
    e.call('clipReportGenerate_', ME, 'manual', FRI, '');
    assert.equal(say(e, '週報', IN(LIB, DAD)), '還沒有週報，週五 19:00 見 📊');
  });

  test('群組受 cmd_clips 管；發話者要 feat_clips；一對一回「請到圖書館群組查看」', () => {
    const e = env();
    assert.match(say(e, '週報', IN(FAM)), /這個群組沒有開放「圖書館」/);
    assert.match(say(e, '週報', IN(LIB, MOM)), /沒有「收藏」功能的權限/);
    assert.equal(say(e, '週報', DM()), '📚 請到圖書館群組查看');
    assert.match(say(e, '週報', DM(MOM)), /看不懂這個指令/);
  });

  test('指令字典：圖書館群組看得到收藏與週報；家族群組、一對一看不到', () => {
    const e = env();
    const lib = say(e, '?');
    assert.match(lib, /傳 IG 網址/);
    assert.match(lib, /週報/);
    const fam = say(e, '?', IN(FAM));
    assert.doesNotMatch(fam, /傳 IG 網址|週報/);
    assert.doesNotMatch(say(e, '?', DM()), /傳 IG 網址/);
  });
});

/* ========================================================================== */
describe('群組欄位（D-6）', () => {

  test('LINE_GROUPS_HEADERS 有 cmd_clips、notify_clips；groupSet 允許這兩欄', () => {
    const e = env();
    const H = e.read('LINE_GROUPS_HEADERS');
    assert.ok(H.includes('cmd_clips') && H.includes('notify_clips'));
    const F = e.read('GROUP_SET_FIELDS');
    assert.ok(F.includes('cmd_clips') && F.includes('notify_clips'));
  });

  test('初始化補欄：既有群組兩欄都是關；Mail 群組推播不變', () => {
    const e = env({ groupHeaders: GROUP_H.slice(0, -2), groups: [FAM_ROW] });
    const r = e.call('installClipGroupColumns_');
    assert.equal(r.level, 'ok');
    assert.match(r.text, /line_groups 補上：cmd_clips、notify_clips/);
    const g = e.sheets.line_groups.toRecords()[0];
    assert.deepEqual([g.cmd_clips, g.notify_clips], ['', '']);
    const again = e.call('installClipGroupColumns_');
    assert.equal(again.changed, false, '可重複執行');
    const notes = [];
    e.call('gmailPushDigest_', 'digest', notes);
    assert.deepEqual(e.pushes.map((p) => p.to), [FAM], 'Mail 群組推播照舊');
  });

  test('新加入的群組：cmd_clips／notify_clips 預設關（不套用 cmd_* 新列全開）', () => {
    const e = env({ groups: [] });
    e.call('registerGroup_', { type: 'group', groupId: 'Cnew' }, 'Cnew');
    const g = e.sheets.line_groups.toRecords()[0];
    assert.equal(g.cmd_expense, 'TRUE');
    assert.deepEqual([g.cmd_clips, g.notify_clips], ['', '']);
  });
});
