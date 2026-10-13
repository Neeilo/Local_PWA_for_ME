/**
 * ADR-018 PR-C（C-1～C-6、F）— 首頁三層＋覺察退場
 *
 * 盯的事（為什麼）：
 *   - 最急兩件（C-2）：門檻＝已逾期或 3 天內；排序 逾期越久越前 → 剩餘天數 → 同天待辦先於提醒 → 優先度；
 *     多的講「還有 N 件」；空的講「✓ 3 天內沒有急事」；沒日期的待辦、已完成的不上榜；帳單不計入（Neil 2026-10-13）
 *   - 數字磚：待辦到期（逾期＋今天）、3 天內提醒、新帳單（最近 3 天收到的帳單；只有看得到郵件的人有）
 *   - 給自己的一段話（C-4）：只有本人讀得到——self_notes 不給 PWA 一般讀寫、boot 只帶自己那一列、
 *     寫入只寫自己（line_id 由 token 換，不收 body 的）；存失敗不假裝存好
 *   - 郵件摘要：received_at 是 UTC，台北早上 8 點前收的信要算今天；只給管理者＋feat_gmail
 *   - 覺察退場（C-3）：boot 不再讀 reviews／moods（資料還在）、「查/」不再放複盤與心情
 *   - 「今天」層在 #zoneCard 外面：切區不重畫；manifest theme_color＝暖米 #FBF3E8（F）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ME = 'Uneil';
const MOM = 'Umom';
const TOK_ME = 'tok-neil';
const TOK_MOM = 'tok-mom';
const TODAY = '2026-10-13';

/* ========================================================================== */
/* 前端：純函式                                                                 */
/* ========================================================================== */

const t = (o) => Object.assign({ id: Math.random(), txt: 'x', done: false, priority: 'M', due: '' }, o);

describe('最急兩件 urgentItems', () => {
  const e = loadFrontend();
  const run = (todos, rems) => e.call('urgentItems', todos, rems, TODAY);
  const names = (u) => u.top.map((x) => x.item.txt);

  test('逾期越久越前 → 剩餘天數；只取兩件，其餘算「還有 N 件」', () => {
    const u = run([t({ txt: '三天後', due: '2026-10-16' }), t({ txt: '逾期 1 天', due: '2026-10-12' }),
      t({ txt: '逾期 5 天', due: '2026-10-08' }), t({ txt: '今天', due: TODAY })], []);
    assert.deepEqual(names(u), ['逾期 5 天', '逾期 1 天']);
    assert.equal(u.more, 2);
    assert.equal(u.total, 4);
  });

  test('同一天：待辦先於提醒；同類同天再比優先度', () => {
    const u = run([t({ txt: '低', due: TODAY, priority: 'L' }), t({ txt: '高', due: TODAY, priority: 'H' })],
      [t({ txt: '提醒', due: TODAY })]);
    assert.deepEqual(u.top.map((x) => x.item.txt), ['高', '低']);
    const v = run([t({ txt: '待辦', due: TODAY, priority: 'L' })], [t({ txt: '提醒', due: TODAY })]);
    assert.deepEqual(names(v), ['待辦', '提醒']);
  });

  test('門檻：3 天內上榜、第 4 天不上；沒日期、已完成、已刪的都不上', () => {
    const u = run([t({ txt: '第 3 天', due: '2026-10-16' }), t({ txt: '第 4 天', due: '2026-10-17' }),
      t({ txt: '沒日期' }), t({ txt: '做完了', due: TODAY, done: true }), t({ txt: '刪了', due: TODAY, del: true })], []);
    assert.deepEqual(names(u), ['第 3 天']);
    assert.equal(u.more, 0);
  });

  test('空的：total 0（畫面講「✓ 3 天內沒有急事」）', () => {
    assert.equal(run([], []).total, 0);
  });
});

describe('「今天」三個數字 todayCounts', () => {
  const e = loadFrontend();

  test('待辦到期＝逾期＋今天；3 天內提醒含逾期；新帳單＝雲端算好的最近 3 天', () => {
    const n = e.call('todayCounts',
      [t({ due: '2026-10-10' }), t({ due: TODAY }), t({ due: '2026-10-14' }), t({ due: TODAY, done: true })],
      [t({ due: '2026-10-12' }), t({ due: '2026-10-16' }), t({ due: '2026-10-17' })],
      TODAY, { bills_3d: 2 });
    assert.deepEqual({ ...n }, { todo: 2, reminder: 2, bills: 2 });
  });

  test('看不到郵件的人：沒有新帳單那一格（null，不是 0）', () => {
    assert.equal(e.call('todayCounts', [], [], TODAY, null).bills, null);
  });
});

/* ========================================================================== */
/* 前端：畫面與互動                                                              */
/* ========================================================================== */

function stableDom(e) {
  e.raw('__els = {}');
  e.raw(`document.getElementById = function(id){
    if (!__els[id]) __els[id] = { id, value:'', textContent:'', innerHTML:'', hidden:false, dataset:{}, style:{},
      classList:{add(){},remove(){},toggle(){},contains:()=>false}, focus(){}, setAttribute(){} };
    return __els[id];
  }`);
}
const json = (v) => ({ json: () => Promise.resolve(v) });

describe('首頁「今天」層', () => {

  function home(fetchImpl) {
    const e = loadFrontend(fetchImpl ? { fetchImpl } : {});
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; state = EMPTY_STATE(); firstLoadDone = true');
    stableDom(e);
    return e;
  }

  test('空的時候講「✓ 3 天內沒有急事」；有的時候列兩件＋「還有 N 件」，提醒標「提醒」', () => {
    const e = home();
    e.call('renderToday');
    assert.match(e.read('__els.urgentList.innerHTML'), /3 天內沒有急事/);
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return e.call('todayKey', x); };
    e.raw('state.tasks = ' + JSON.stringify([
      { id: 1, txt: '衣櫃', done: false, ts: 1, priority: 'H', kind: 'todo', due: d(0), line_id: ME },
      { id: 2, txt: '結帳日', done: false, ts: 2, priority: 'M', kind: 'reminder', due: d(3), line_id: ME },
      { id: 3, txt: '報表', done: false, ts: 3, priority: 'M', kind: 'todo', due: d(1), line_id: ME }
    ]));
    e.call('renderToday');
    const h = e.read('__els.urgentList.innerHTML');
    assert.ok(h.indexOf('衣櫃') < h.indexOf('報表'));
    assert.match(h, /今天到期/);
    assert.match(h, /還有 1 件/);
    assert.doesNotMatch(h, /結帳日/);
  });

  test('看不到郵件的人只有兩個數字磚（沒有「新帳單」）', () => {
    const e = home();
    e.call('renderToday');
    assert.doesNotMatch(e.read('__els.todayTiles.innerHTML'), /新帳單/);
    e.raw('mailSummary = {today:1, bill:1, newsletter:0, etag:0, bills_3d:3}');
    e.call('renderToday');
    assert.match(e.read('__els.todayTiles.innerHTML'), /<b class="">3<\/b><span>新帳單/);
  });

  test('給自己的一段話：點一下就地編輯，存成功才換字；存失敗不假裝存好', async () => {
    let reply = { success: true, text: '慢一點' };
    const e = home(({ body }) => (body && body.action === 'selfNoteSet' ? json(reply) : json({ success: true })));
    e.call('editSelfNote');
    assert.equal(e.read('__els.selfNoteEdit.hidden'), false);
    assert.equal(e.read('__els.selfNote.hidden'), true);
    e.raw('__els.selfNoteInput.value = "  慢一點  "');
    await e.callRaw('saveSelfNote');
    const sent = e.calls.filter((c) => c.body && c.body.action === 'selfNoteSet');
    assert.equal(sent[0].body.text, '慢一點');
    assert.equal(sent[0].body.trigger, 'write', '新增的雲端動作要帶 trigger（ADR-014 D-12）');
    assert.equal(e.read('selfNote'), '慢一點');
    assert.equal(e.read('__els.selfNoteEdit.hidden'), true);

    reply = { error: 'busy' };
    e.call('editSelfNote');
    e.raw('__els.selfNoteInput.value = "改掉"');
    await e.callRaw('saveSelfNote');
    assert.equal(e.read('selfNote'), '慢一點', '沒存到雲端就不改畫面');
    assert.ok(e.toasts.some((x) => /沒有存到雲端/.test(x)));
  });

  test('沒配對（本機模式）：點了講清楚要配對，不打開編輯', () => {
    const e = home();
    e.raw('deviceToken = null; localOnly = true');
    e.call('editSelfNote');
    assert.equal(e.read('selfNoteEditing'), false);
    assert.ok(e.toasts.some((x) => /配對/.test(x)));
  });

  test('boot 帶回自己的一段話與郵件摘要；輪詢（readMany）不會把一段話洗掉', async () => {
    const BOOT = { session: { status: 'ok', line_id: ME, device_id: 'd' }, line_users: [{ line_id: ME, is_active: 'TRUE' }],
      data: { tasks: [], notes: [], expenses: [] }, denied: [], self_note: '早點睡', mail_summary: { today: 2, bill: 1, newsletter: 1, etag: 0, bills_3d: 1 } };
    const e = loadFrontend({ fetchImpl: ({ body }) => json(body.action === 'boot' ? BOOT
      : body.action === 'readMany' ? { data: { tasks: [], notes: [], expenses: [] }, denied: [] } : { success: true }) });
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; gateMode = null; state = EMPTY_STATE()');
    e.raw('applyIdentity = function(){}; applyZone = function(){}');
    await e.callRaw('startSession', 'cold');
    assert.equal(e.read('selfNote'), '早點睡');
    assert.equal(e.read('mailSummary.today'), 2);
    await e.callRaw('pullFromCloud', 'poll');
    assert.equal(e.read('selfNote'), '早點睡');
  });
});

describe('深入卡：分段與左右滑同步', () => {

  test('點分段 → 捲到那一頁；滑到第三頁 → 分段跟著亮「白板」', () => {
    const e = loadFrontend();
    e.raw('state = EMPTY_STATE(); firstLoadDone = true');
    stableDom(e);
    e.raw('__scrolls = []; __els.paneScroll = { clientWidth: 300, scrollLeft: 0, scrollTo(o){ __scrolls.push(o); } }');
    e.call('goDeep', 1);
    assert.equal(e.read('__scrolls[0].left'), 300);
    assert.match(e.read('__els.deepSeg.innerHTML'), /class="sel"[^>]*>提醒/);
    e.raw('__els.paneScroll.scrollLeft = 600');
    e.call('syncDeepSeg');
    assert.equal(e.read('deepPane'), 2);
  });
});

/* ========================================================================== */
/* 後端                                                                        */
/* ========================================================================== */

const LOG_H = ['msg_id', 'received_at', 'rule_id', 'mail_type', 'source_name', 'subject', 'amount', 'due_date', 'status',
  'attachment_url', 'gmail_link', 'processed_at'];

function backend({ selfNotes = true, gmail = [], momGmail = '' } = {}) {
  const sheets = {
    line_users: new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_tasks', 'feat_notes', 'feat_expense', 'feat_gmail', 'feat_review', 'feat_mood'],
      [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
      [MOM, '媽媽', 'TRUE', '', 'TRUE', 'TRUE', 'TRUE', momGmail, 'TRUE', 'TRUE']
    ]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del']]),
    notes: new FakeSheet('notes', [['id', 'text', 'created_at', 'line_id', 'del']]),
    expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del']]),
    reviews: new FakeSheet('reviews', [['review_date', 'good', 'stuck', 'most_important', 'line_id', 'del'], ['2026-10-12', '有運動', '', '', ME, '']]),
    moods: new FakeSheet('moods', [['id', 'mood_date', 'level', 'note', 'line_id', 'del'], ['1', '2026-10-12', 4, '', ME, '']]),
    gmail_log: new FakeSheet('gmail_log', [LOG_H].concat(gmail.map((g) => LOG_H.map((h) => (g[h] === undefined ? '' : g[h]))))),
    logs: new FakeSheet('logs', [['id']])
  };
  if (selfNotes) sheets.self_notes = new FakeSheet('self_notes', [['line_id', 'text', 'updated_at'], [MOM, '媽媽的私房話', '']]);
  return loadCodeGs({ cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM }, sheets });
}
function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

describe('給自己的一段話：只有本人讀得到', () => {

  test('boot 只帶自己那一列；別人的一個字都不在回應裡', () => {
    const e = backend();
    const mine = post(e, { action: 'boot', token: TOK_ME });
    assert.equal(mine.self_note, '');
    assert.doesNotMatch(JSON.stringify(mine), /媽媽的私房話/);
    assert.equal(post(e, { action: 'boot', token: TOK_MOM }).self_note, '媽媽的私房話');
  });

  test('PWA 一般的 read／readMany／upsert 都碰不到 self_notes', () => {
    const e = backend();
    assert.equal(post(e, { action: 'read', token: TOK_ME, sheet: 'self_notes' }).error, 'sheet_not_readable');
    assert.deepEqual(post(e, { action: 'readMany', token: TOK_ME, sheets: ['self_notes'] }).denied, ['self_notes']);
    const w = post(e, { action: 'upsert', token: TOK_ME, sheet: 'self_notes', key_field: 'line_id', record: { line_id: MOM, text: '竄改' } });
    assert.equal(w.error, 'sheet_not_writable');
    assert.equal(e.sheets.self_notes.toRecords()[0].text, '媽媽的私房話');
  });

  test('selfNoteSet 只寫自己：body 帶別人的 line_id 也沒用；再存一次是覆蓋不是新增', () => {
    const e = backend();
    assert.equal(post(e, { action: 'selfNoteSet', token: TOK_ME, text: '  慢一點  ', line_id: MOM, trigger: 'write' }).text, '慢一點');
    post(e, { action: 'selfNoteSet', token: TOK_ME, text: '早點睡', trigger: 'write' });
    const rows = e.sheets.self_notes.toRecords();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.line_id === ME).text, '早點睡');
    assert.equal(rows.find((r) => r.line_id === MOM).text, '媽媽的私房話');
  });

  test('太長 → too_long；表還沒建（沒跑初始化）→ sheet_not_found，boot 照常開機', () => {
    const e = backend();
    assert.equal(post(e, { action: 'selfNoteSet', token: TOK_ME, text: 'x'.repeat(301) }).error, 'too_long');
    const bare = backend({ selfNotes: false });
    assert.equal(post(bare, { action: 'selfNoteSet', token: TOK_ME, text: 'a' }).error, 'sheet_not_found');
    assert.equal(post(bare, { action: 'boot', token: TOK_ME }).session.status, 'ok');
  });

  test('「初始化」建 self_notes，重跑不重建', () => {
    const e = backend({ selfNotes: false });
    e.call('ensureSelfNotesSheet_');
    assert.deepEqual(e.ss.getSheetByName('self_notes').values[0], ['line_id', 'text', 'updated_at']);
    assert.equal(e.call('ensureSelfNotesSheet_').created, false);
  });
});

describe('郵件摘要（郵件磚＋新帳單）', () => {

  const at = (iso, type) => ({ msg_id: iso + type, received_at: iso, mail_type: type });

  test('今天依信種計數；新帳單＝最近 3 天收到的帳單；台北 07:30（UTC 前一天 23:30）算今天', () => {
    const e = backend({ gmail: [
      at('2026-10-12T23:30:00.000Z', 'bill'),        // 台北 10/13 07:30
      at('2026-10-13T02:00:00.000Z', 'newsletter'),
      at('2026-10-11T02:00:00.000Z', 'bill'),        // 3 天內（含今天）
      at('2026-10-10T02:00:00.000Z', 'bill'),        // 第 4 天，不算
      at('2026-10-13T03:00:00.000Z', 'etag')
    ] });
    const m = e.call('mailSummary_', e.ss, TODAY);
    assert.deepEqual({ ...m }, { today: 3, bill: 1, newsletter: 1, etag: 1, bills_3d: 2 });
  });

  test('boot：管理者＋feat_gmail 才帶；一般成員就算被勾了也沒有', () => {
    const e = backend({ momGmail: 'TRUE' });
    assert.ok(post(e, { action: 'boot', token: TOK_ME }).mail_summary);
    assert.equal('mail_summary' in post(e, { action: 'boot', token: TOK_MOM }), false);
  });
});

describe('覺察退場（C-3）：資料留著，不再讀', () => {

  test('boot 不讀 reviews／moods（表上還有資料）', () => {
    const e = backend();
    const out = post(e, { action: 'boot', token: TOK_ME });
    assert.deepEqual(Object.keys(out.data).sort(), ['expenses', 'notes', 'tasks']);
    assert.equal(e.sheets.reviews.toRecords().length, 1, '資料沒被動');
  });

  test('「查/」的 prompt 不再有複盤與心情', () => {
    const e = backend();
    const ctx = e.call('buildQueryContext_', ME);
    assert.equal('reviews' in ctx, false);
    assert.equal('moods' in ctx, false);
    const prompt = e.call('buildQueryPrompt_', ctx, '最近怎麼樣');
    assert.doesNotMatch(prompt, /複盤|心情/);
  });
});

/* ========================================================================== */
describe('其他（F）', () => {

  test('manifest theme_color＝暖米 #FBF3E8', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    assert.equal(m.theme_color.toUpperCase(), '#FBF3E8');
  });

  test('新雲端動作 selfNoteSet 帶 trigger（ADR-014 D-12 守門之外再釘一次）', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /cloudPost\(\{action:'selfNoteSet', text, trigger:'write'\}\)/);
  });
});
