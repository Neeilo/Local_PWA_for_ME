/**
 * ADR-021 PR-E（後端）— 圖書館：筆記、AI 整理、非 IG 連結、閱讀狀態（D-10～D-13）
 *
 * 為什麼有這批測試：
 *  - 筆記一篇一份，存檔比對 revision：兩台同時改，先存的成功、後存的被拒且 Sheet 不變，回新版給前端（EXP-03）
 *  - 只有收藏擁有者能寫筆記、跑 AI；「初始化」還沒補欄就講清楚，不默默丟掉
 *  - AI 整理另存，永不動原文（caption）與筆記；重做取代、捨棄清空；失敗不寫半份
 *  - 非 IG 網址（含 Threads／FB／X）只存連結：不進 Apify 佇列、不算進 Apify 成功率；「記帳/…」含網址仍走記帳
 *  - Reading Widget 的未讀把只存連結的算進去
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const DAD = 'Udad';
const MOM = 'Umom';                     // 沒有 feat_clips
const TOK_ME = 'tok-me';
const TOK_DAD = 'tok-dad';
const FEATS = ['feat_tasks', 'feat_notes', 'feat_clips', 'feat_expense'];
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS);
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const P1 = 'https://www.instagram.com/p/AAA111/';

function env({ ai = null, clipsRows = null, headers = null } = {}) {
  const replies = [];
  const prompts = [];
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H,
      [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
      [DAD, '爸爸', 'TRUE', '', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
      [MOM, '媽媽', 'TRUE', '', 'TRUE', 'TRUE', '', 'TRUE']]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'priority', 'is_completed', 'line_id', 'kind', 'due_date', 'created_at', 'origin_chat', 'del']]),
    logs: new FakeSheet('logs', [LOG_H])
  };
  if (headers) sheets.clips = new FakeSheet('clips', [headers]);
  const e = loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    tokens: { [TOK_ME]: ME, [TOK_DAD]: DAD }, sheets,
    properties: { APIFY_TOKEN: 'x' },
    overrides: {
      lineReply_: (_t, text) => replies.push(text),
      callAi_: (prompt) => { prompts.push(prompt); return ai ? ai(prompt) : { ok: true, text: '重點一\n重點二', label: 'Claude', provider: 'claude', model: 'claude-haiku-5-5' }; }
    }
  });
  if (!headers) e.call('ensureClipsSheet_');
  const H = headers || e.read('CLIPS_HEADERS');
  (clipsRows || []).forEach((r) => e.sheets.clips.values.push(H.map((h) => (r[h] == null ? '' : r[h]))));
  e.replies = replies; e.prompts = prompts;
  return e;
}

const clip = (extra = {}) => Object.assign({ id: 'c1', line_id: ME, url: P1, shortcode: 'AAA111', kind: 'post', status: 'done',
  caption: '原文第一行\n原文第二行', author: 'someone', media_saved: 2, collected_at: '2026-10-19T01:00:00.000Z', note: '', note_revision: '' }, extra);
const rows = (e) => e.sheets.clips.toRecords();
const post = (e, body, tok = TOK_ME) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok, trigger: 'write' }, body)) } }).body);
const DM = (userId = ME) => ({ type: 'user', userId });
const say = (e, text, source = DM()) => e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });

/* ========================================================================== */
describe('筆記（D-10）：一篇一份、revision 比對', () => {
  test('EXP-03：同一篇 revision 12 兩邊編輯 → 先存成功變 13；後存被拒、Sheet 不變、回新版', () => {
    const e = env({ clipsRows: [clip({ note: '舊筆記', note_revision: 12 })] });
    const a = post(e, { action: 'clipNote', id: 'c1', note: '手機寫的', revision: 12 });
    assert.equal(a.success, true);
    assert.equal(a.revision, 13);
    assert.ok(a.note_updated_at);
    const before = JSON.stringify(rows(e));
    const b = post(e, { action: 'clipNote', id: 'c1', note: 'PC 寫的', revision: 12 });
    assert.equal(b.error, 'conflict');
    assert.equal(b.permanent, undefined, '衝突不是永久拒絕：拿到新版就能再存');
    assert.equal(b.note, '手機寫的');
    assert.equal(b.revision, 13);
    assert.equal(JSON.stringify(rows(e)), before, 'Sheet 一格都沒動');
    assert.equal(rows(e)[0].note, '手機寫的');
  });

  test('第一次寫（revision 空白＝0）；寫筆記不動原文', () => {
    const e = env({ clipsRows: [clip()] });
    assert.equal(post(e, { action: 'clipNote', id: 'c1', note: '第一則', revision: 0 }).revision, 1);
    assert.equal(rows(e)[0].caption, '原文第一行\n原文第二行');
    assert.equal(Number(rows(e)[0].note_revision), 1);
  });

  test('不是擁有者：永久拒絕、不寫；沒有 feat_clips：永久拒絕', () => {
    const e = env({ clipsRows: [clip()] });
    const r = post(e, { action: 'clipNote', id: 'c1', note: 'x', revision: 0 }, TOK_DAD);
    assert.equal(r.error, 'forbidden');
    assert.equal(r.permanent, true);
    assert.equal(rows(e)[0].note, '');
  });

  test('太長：擋下並講清楚（不截斷）', () => {
    const e = env({ clipsRows: [clip()] });
    const r = post(e, { action: 'clipNote', id: 'c1', note: 'x'.repeat(20001), revision: 0 });
    assert.equal(r.error, 'too_long');
    assert.equal(rows(e)[0].note, '');
  });

  test('「初始化」還沒補筆記欄：講 not_ready，不默默丟掉', () => {
    const old = ['id', 'line_id', 'url', 'kind', 'status', 'caption', 'del'];
    const e = env({ headers: old, clipsRows: [clip()] });
    assert.equal(post(e, { action: 'clipNote', id: 'c1', note: 'x', revision: 0 }).error, 'not_ready');
    assert.equal(post(e, { action: 'clipAi', id: 'c1' }).error, 'not_ready');
    assert.equal(e.prompts.length, 0, '欄位不在就不花 AI 的錢');
  });
});

/* ========================================================================== */
describe('AI 整理（D-11）：另存、不覆蓋', () => {
  test('輸入＝原文＋筆記（只文字），要求標「圖片內容未辨識」、不編造；結果另存，原文與筆記不動', () => {
    const e = env({ clipsRows: [clip({ note: '我覺得第二點最重要', note_revision: 3 })] });
    const r = post(e, { action: 'clipAi', id: 'c1' });
    assert.equal(r.success, true);
    assert.equal(r.ai_output, '重點一\n重點二');
    assert.equal(r.ai_provider, 'Claude');
    const p = e.prompts[0];
    assert.match(p, /原文第一行/);
    assert.match(p, /我覺得第二點最重要/);
    assert.match(p, /圖片內容未辨識/);
    assert.match(p, /不要編造/);
    const row = rows(e)[0];
    assert.equal(row.caption, '原文第一行\n原文第二行');
    assert.equal(row.note, '我覺得第二點最重要');
    assert.equal(Number(row.note_revision), 3);
    assert.equal(row.ai_output, '重點一\n重點二');
    assert.equal(row.ai_provider, 'Claude');
    assert.ok(row.ai_at);
    assert.ok(e.transactions.some((t) => t[1] === '成功' && /AI 整理/.test(t[3]) && /provider=claude/.test(t[4])));
  });

  test('重做＝取代；捨棄＝清空（不呼叫 AI）', () => {
    let n = 0;
    const e = env({ clipsRows: [clip()], ai: () => ({ ok: true, text: '第 ' + (++n) + ' 份', label: 'Gemini', provider: 'gemini', model: 'm' }) });
    post(e, { action: 'clipAi', id: 'c1' });
    post(e, { action: 'clipAi', id: 'c1' });
    assert.equal(rows(e)[0].ai_output, '第 2 份');
    const d = post(e, { action: 'clipAi', id: 'c1', discard: true });
    assert.equal(d.success, true);
    assert.equal(n, 2);
    assert.equal(rows(e)[0].ai_output, '');
    assert.equal(rows(e)[0].ai_provider, '');
    assert.equal(rows(e)[0].ai_at, '');
  });

  test('AI 失敗：不寫半份、舊的結果留著；講是哪一家失敗、寫 logs', () => {
    const e = env({ clipsRows: [clip({ ai_output: '上一份', ai_provider: 'Claude' })],
      ai: () => ({ ok: false, reason: 'HTTP 429・額度用完', label: 'Claude', provider: 'claude', model: 'm' }) });
    const r = post(e, { action: 'clipAi', id: 'c1' });
    assert.equal(r.error, 'ai_failed');
    assert.equal(r.label, 'Claude');
    assert.match(r.reason, /429/);
    assert.equal(rows(e)[0].ai_output, '上一份');
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && /429/.test(t[3])));
  });

  test('只存連結的那篇：AI 只讀筆記（提示詞講明沒有原文）；連筆記都空就不呼叫', () => {
    const link = clip({ id: 'k1', kind: 'link', status: 'link', url: 'https://example.com/a', shortcode: '', caption: '' });
    const e = env({ clipsRows: [link] });
    assert.equal(post(e, { action: 'clipAi', id: 'k1' }).error, 'empty');
    assert.equal(e.prompts.length, 0);
    post(e, { action: 'clipNote', id: 'k1', note: '這篇在講番茄鐘', revision: 0 });
    assert.equal(post(e, { action: 'clipAi', id: 'k1' }).success, true);
    assert.match(e.prompts[0], /只存了連結/);
    assert.match(e.prompts[0], /番茄鐘/);
  });

  test('不是擁有者不能跑（也不花錢）', () => {
    const e = env({ clipsRows: [clip()] });
    assert.equal(post(e, { action: 'clipAi', id: 'c1' }, TOK_DAD).error, 'forbidden');
    assert.equal(e.prompts.length, 0);
  });
});

/* ========================================================================== */
describe('非 IG 網址：只存連結（D-12）', () => {
  test('LINE 一對一貼一般網址：登記成「只存連結」、回「收到 ✅」、不進 Apify 佇列', () => {
    const e = env();
    say(e, '這篇不錯 https://example.com/post/1?a=b。');
    assert.equal(e.replies.at(-1), '收到 ✅');
    const r = rows(e);
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'link');
    assert.equal(r[0].status, 'link');
    assert.equal(r[0].url, 'https://example.com/post/1?a=b', '句尾標點不算網址');
    assert.equal(e.call('clipsPick_', e.sheets.clips, Date.now()).length, 0, '排程不會挑到它');
  });

  test('Threads／FB／X 也只存連結（取代 ADR-020 A-3 的「目前只支援 Instagram」）', () => {
    const e = env();
    say(e, '看 https://www.threads.net/@a/post/xyz');
    assert.equal(e.replies.at(-1), '收到 ✅');
    assert.equal(rows(e)[0].kind, 'link');
  });

  test('IG＋一般網址同一則：IG 照舊排隊、一般網址只存連結', () => {
    const e = env();
    say(e, P1 + ' 跟 https://example.com/x');
    assert.equal(e.replies.at(-1), '收到 ✅（2 篇）');
    assert.deepEqual(rows(e).map((r) => [r.kind, r.status]), [['post', 'pending'], ['link', 'link']]);
  });

  test('同一個人再貼同一個連結：不重複登記', () => {
    const e = env();
    say(e, 'https://example.com/x');
    say(e, 'https://example.com/x');
    assert.equal(rows(e).length, 1);
  });

  test('「記帳/…」內容含網址：照舊走記帳，不收藏；沒有 feat_clips：照舊回看不懂', () => {
    const e = env();
    say(e, '任務/讀 https://example.com/x');
    assert.equal(rows(e).length, 0);
    assert.equal(e.sheets.tasks.toRecords().length, 1);
    say(e, 'https://example.com/x', DM(MOM));
    assert.equal(rows(e).length, 0);
    assert.match(e.replies.at(-1), /看不懂這個指令/);
  });

  test('PWA「＋ 加網址」：一般網址→只存連結；IG→排隊；不是網址→invalid_url（永久）', () => {
    const e = env();
    assert.deepEqual(post(e, { action: 'clipAdd', url: 'https://example.com/y' }), { success: true, kind: 'link' });
    assert.equal(post(e, { action: 'clipAdd', url: P1 + '?igsh=z' }).kind, 'post');
    const bad = post(e, { action: 'clipAdd', url: 'javascript:alert(1)' });
    assert.equal(bad.error, 'invalid_url');
    assert.equal(bad.permanent, true);
    assert.deepEqual(rows(e).map((r) => [r.line_id, r.kind, r.status]), [[ME, 'link', 'link'], [ME, 'post', 'pending']]);
  });

  test('只存連結不算進 Apify 收藏成功率', () => {
    const e = env();
    const now = Date.parse('2026-10-20T00:00:00Z');
    const r = e.call('clipsSuccessRate_', [
      { status: 'done', kind: 'post', collected_at: '2026-10-19T00:00:00Z' },
      { status: 'link', kind: 'link', collected_at: '2026-10-19T00:00:00Z' }], now);
    assert.deepEqual([r.done, r.total], [1, 1]);
  });
});

/* ========================================================================== */
describe('Reading Widget：只存連結也算未讀（D-13）', () => {
  test('未讀＝收齊或只存連結、沒讀過；上次在讀的連結用網域當標題', () => {
    const e = env({ clipsRows: [
      clip({ id: 'a' }),
      clip({ id: 'b', kind: 'link', status: 'link', url: 'https://www.example.com/x', caption: '', author: '' }),
      clip({ id: 'c', status: 'pending' }),
      clip({ id: 'd', kind: 'link', status: 'link', url: 'https://news.site.tw/1', caption: '', author: '', read_status: 'read', last_read_at: '2026-10-19T05:00:00.000Z' })
    ] });
    const w = e.read('readingWidget_(SpreadsheetApp.getActiveSpreadsheet(), { line_id: "' + ME + '" })');
    assert.equal(w.unread, 2);
    assert.equal(w.last.id, 'd');
    assert.equal(w.last.title, 'news.site.tw');
  });
});
