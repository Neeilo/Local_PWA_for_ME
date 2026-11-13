/**
 * ADR-028 PR-A — 圖書館週報（後端，apps-script/clip-report.gs）
 *
 * 為什麼有這批測試：每週五 19:00 由 AI 從未讀收藏挑 ⭐ 推薦、標 🗑️ 可略過，讓庫存能消化。
 * 盯的事（交棒頁 PR-A 驗收）：
 *   - 候選：已讀／只存連結／失敗／已刪除排除；別人的收藏排除；IG＋Threads 都在
 *   - 新收與舊庫存分組；舊庫存優先取還沒判斷過的、連續兩期不重複同一批
 *   - 手動產生不推進期間訖、不推 LINE；排程同一週不重跑（失敗也不自動重試、LINE 通知）
 *   - 提示詞：關注空白／有內容；每篇截斷生效
 *   - 解析：未知 id、推薦超過上限、漏判、完全壞掉的輸出
 *   - AI 失敗不存半份、不動任何收藏；**產生週報不會改任何 read_status**
 *   - 一鍵標已讀：只改本人的列、寫 logs；我的關注：只有本人、logs 不複製內容
 *
 * 測試只用合成資料。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const DAD = 'Udad';
const TOK_ME = 'tok-me';
const TOK_DAD = 'tok-dad';
const FEATS = ['feat_tasks', 'feat_notes', 'feat_clips'];
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS);
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const DAY = 86400000;
/** 2026-11-13（五）20:00 台北 */
const FRI = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));
const iso = (ms) => new Date(ms).toISOString();

function clip(id, extra = {}) {
  return Object.assign({ id, line_id: ME, url: 'https://www.instagram.com/p/' + id + '/', kind: 'post', status: 'done',
    caption: '標題 ' + id + '\n內文 ' + id, author: 'someone', collected_at: iso(FRI.getTime() - 30 * DAY), read_status: '', del: '' }, extra);
}

function env({ clips = [], ai = null, props = {}, push = null } = {}) {
  const H = ['id', 'line_id', 'url', 'kind', 'status', 'caption', 'author', 'collected_at', 'read_status', 'del', 'category',
    'note', 'ocr_output', 'updated_at', 'report_verdict', 'report_reason', 'report_id', 'report_at'];
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H, [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'], [DAD, '爸爸', 'TRUE', '', 'TRUE', 'TRUE', 'TRUE']]),
    logs: new FakeSheet('logs', [LOG_H]),
    clips: new FakeSheet('clips', [H].concat(clips.map((c) => H.map((h) => (c[h] == null ? '' : c[h])))))
  };
  const prompts = [];
  const e = loadCodeGs({
    cache: true, propsWritable: true, sheets, tokens: { [TOK_ME]: ME, [TOK_DAD]: DAD }, properties: props, extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    pushImpl: push || undefined,
    overrides: {
      callAiLong_: (prompt, feature) => { prompts.push({ prompt, feature }); return ai ? ai(prompt) : { ok: true, text: '{"items":[]}', label: 'Gemini' }; }
    }
  });
  e.prompts = prompts;
  return e;
}

/** AI 照提示詞裡的 id 回：recommend 給 rec 裡的、skip 給 skip 裡的、其餘 normal */
const aiBy = ({ rec = [], skip = [], drop = [] } = {}) => (prompt) => {
  const ids = [...prompt.matchAll(/- id: (\S+)｜/g)].map((m) => m[1]);
  const items = ids.filter((id) => !drop.includes(id)).map((id) => ({ id, verdict: rec.includes(id) ? 'recommend' : skip.includes(id) ? 'skip' : 'normal', reason: '理由 ' + id }));
  return { ok: true, text: '好的：\n```json\n' + JSON.stringify({ items }) + '\n```', label: 'Gemini' };
};
const rows = (e) => e.sheets.clips.toRecords();
const reports = (e) => (e.sheets.clip_reports ? e.sheets.clip_reports.toRecords() : []);
const post = (e, body, tok = TOK_ME) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
const gen = (e, type = 'manual', now = FRI, week = '') => e.call('clipReportGenerate_', ME, type, now, week);

/* ========================================================================== */
describe('時間：最近一個週五 19:00（台北）', () => {
  const slot = (d) => env().call('clipReportSlot_', d).key;
  test('週五 19:00 前算上週；之後算本週；週末、下週一都算本週五', () => {
    assert.equal(slot(new Date(Date.UTC(2026, 10, 13, 10, 59))), '2026-11-06', '週五 18:59');
    assert.equal(slot(new Date(Date.UTC(2026, 10, 13, 11, 0))), '2026-11-13', '週五 19:00');
    assert.equal(slot(new Date(Date.UTC(2026, 10, 15, 3, 0))), '2026-11-13', '週日');
    assert.equal(slot(new Date(Date.UTC(2026, 10, 16, 3, 0))), '2026-11-13', '下週一');
  });
});

/* ========================================================================== */
describe('候選與分組（純函式）', () => {
  test('已讀／只存連結／失敗／已刪除、別人的都排除；未讀、閱讀中、IG、Threads、partial 都在', () => {
    const e = env();
    const list = [
      clip('a'), clip('b', { read_status: 'reading' }), clip('c', { kind: 'threads', url: 'https://www.threads.com/t/X' }), clip('d', { status: 'partial' }),
      clip('x1', { read_status: 'read' }), clip('x2', { kind: 'link', status: 'link' }), clip('x3', { status: 'failed' }),
      clip('x4', { del: 'TRUE' }), clip('x5', { line_id: DAD }), clip('x6', { status: 'pending' })
    ];
    assert.deepEqual(e.call('clipReportCandidates_', list, ME).map((r) => r.id), ['a', 'b', 'c', 'd']);
  });

  test('新收＝期間內收藏的；舊庫存優先沒判過的、再來最久沒判的、同層最舊的；最多 20 篇', () => {
    const e = env();
    const since = FRI.getTime() - 7 * DAY;
    const list = [clip('new1', { collected_at: iso(since + DAY) })];
    for (let i = 0; i < 25; i++) list.push(clip('old' + String(i).padStart(2, '0'), { collected_at: iso(since - (30 - i) * DAY) }));
    list[1].report_at = iso(FRI.getTime() - 10 * DAY);      // old00 判過了（最舊但判過）
    const g = e.call('clipReportSplit_', list, since, FRI.getTime());
    assert.deepEqual(g.fresh.map((r) => r.id), ['new1']);
    assert.equal(g.old.length, 20);
    assert.equal(g.old[0].id, 'old01', '沒判過的先，同層最舊的先');
    assert.ok(!g.old.some((r) => r.id === 'old00'), '判過的排到後面，20 篇內輪不到');
  });
});

/* ========================================================================== */
describe('提示詞與解析（純函式）', () => {
  test('關注空白用通用標準；有內容就放進去；每篇截到 800 字、說明文字優先', () => {
    const e = env();
    const long = clip('a', { caption: '甲'.repeat(900), ocr_output: '乙乙', note: '丙' });
    const blank = e.call('clipReportPrompt_', { fresh: [long], old: [] }, '');
    assert.match(blank.prompt, /還沒設定關注/);
    assert.match(blank.prompt, /甲{800}…/);
    assert.doesNotMatch(blank.prompt, /乙乙|丙/, '說明文字用完 800 字，後面的不送');
    const withFocus = e.call('clipReportPrompt_', { fresh: [clip('b')], old: [clip('c')] }, '我關心 AI 工具');
    assert.match(withFocus.prompt, /使用者的關注（判斷標準）：\n我關心 AI 工具/);
    assert.match(withFocus.prompt, /【本週新收】[\s\S]*- id: b｜[\s\S]*【舊庫存】[\s\S]*- id: c｜/);
    assert.deepEqual(withFocus.sent, [{ id: 'b', group: 'new' }, { id: 'c', group: 'old' }]);
  });

  const sent = [{ id: 'n1', group: 'new' }, { id: 'n2', group: 'new' }, { id: 'n3', group: 'new' }, { id: 'n4', group: 'new' }, { id: 'o1', group: 'old' }];
  const parse = (text) => env().call('clipReportParse_', text, sent);

  test('未知 id 忽略；推薦超過上限降為普通；漏判的不寫；中文判斷也認得', () => {
    const out = parse(JSON.stringify({ items: [
      { id: 'ghost', verdict: 'recommend', reason: 'x' },
      { id: 'n1', verdict: 'recommend', reason: '好' }, { id: 'n2', verdict: '推薦', reason: '好' },
      { id: 'n3', verdict: 'recommend', reason: '好' }, { id: 'n4', verdict: 'recommend', reason: '第四篇' },
      { id: 'o1', verdict: '可略過', reason: '引流文' }
    ] }));
    assert.deepEqual(Object.keys(out.byId).sort(), ['n1', 'n2', 'n3', 'n4', 'o1']);
    assert.equal(out.byId.n4.verdict, 'normal', '新收推薦最多 3 篇');
    assert.equal(out.byId.o1.verdict, 'skip');
    assert.ok(!out.byId.ghost);
  });

  test('完全壞掉的輸出 → null（不存半份）', () => {
    assert.equal(parse('我覺得都不錯'), null);
    assert.equal(parse('{"items": "nope"}'), null);
    assert.equal(parse('{"items":[{"id":"ghost","verdict":"recommend"}]}'), null, '一篇都對不上也算失敗');
  });
});

/* ========================================================================== */
describe('產生一期', () => {
  test('成功：寫一期、推薦／可略過清單、各篇判斷寫回；不改任何 read_status', () => {
    const e = env({ clips: [clip('a', { read_status: 'reading' }), clip('b'), clip('c'), clip('r', { read_status: 'read' })], ai: aiBy({ rec: ['a'], skip: ['b'] }) });
    const before = rows(e).map((r) => r.read_status);
    const out = gen(e);
    assert.equal(out.ok, true);
    const rep = reports(e)[0];
    assert.equal(rep.type, 'manual');
    assert.equal(rep.status, 'ok');
    assert.deepEqual(JSON.parse(rep.recommended).map((x) => x.id), ['a']);
    assert.deepEqual(JSON.parse(rep.skippable).map((x) => x.id), ['b']);
    const byId = Object.fromEntries(rows(e).map((r) => [r.id, r]));
    assert.deepEqual([byId.a.report_verdict, byId.b.report_verdict, byId.c.report_verdict], ['recommend', 'skip', 'normal']);
    assert.equal(byId.a.report_id, rep.id);
    assert.equal(byId.r.report_verdict, '', '已讀的不送、不寫');
    assert.deepEqual(rows(e).map((r) => r.read_status), before, '產生週報不改任何 read_status');
    assert.equal(e.prompts[0].feature, 'clip_report');
  });

  test('數字總覽：新收分 IG／Threads、閱讀狀態、分類、上期推薦已讀 x／y', () => {
    const recent = iso(FRI.getTime() - DAY);
    const e = env({ clips: [clip('n1', { collected_at: recent }), clip('n2', { collected_at: recent, kind: 'threads', url: 'https://www.threads.com/t/Y', category: '投資' }),
      clip('o1', { read_status: 'read' }), clip('o2', { read_status: 'reading' })], ai: aiBy({ rec: ['n1'] }) });
    const s = JSON.parse(gen(e).report.summary);
    assert.deepEqual([s.new_total, s.new_ig, s.new_threads], [2, 1, 1]);
    assert.deepEqual([s.unread, s.reading, s.read], [2, 1, 1]);
    assert.equal(s.categories['投資'], 1);
    assert.equal(s.recommend, 1);
  });

  test('AI 失敗：記失敗＋原因、不存判斷、不動任何收藏', () => {
    const e = env({ clips: [clip('a')], ai: () => ({ ok: false, reason: 'HTTP 429', label: 'Gemini' }) });
    const out = gen(e);
    assert.equal(out.ok, false);
    const rep = reports(e)[0];
    assert.equal(rep.status, 'failed');
    assert.match(rep.error, /429/);
    assert.equal(rows(e)[0].report_verdict, '');
  });

  test('AI 回覆看不懂：失敗、不存半份', () => {
    const e = env({ clips: [clip('a'), clip('b')], ai: () => ({ ok: true, text: '都很好看！', label: 'Gemini' }) });
    assert.equal(gen(e).ok, false);
    assert.match(reports(e)[0].error, /看不懂/);
    assert.ok(rows(e).every((r) => r.report_verdict === ''));
  });

  test('候選 0 篇：不呼叫 AI，仍存一期（只有數字總覽）', () => {
    const e = env({ clips: [clip('r', { read_status: 'read' })] });
    const out = gen(e);
    assert.equal(out.ok, true);
    assert.equal(e.prompts.length, 0);
    assert.equal(reports(e).length, 1);
  });

  test('舊庫存連續兩期輪到不同一批', () => {
    const list = [];
    for (let i = 0; i < 30; i++) list.push(clip('o' + String(i).padStart(2, '0'), { collected_at: iso(FRI.getTime() - (60 - i) * DAY) }));
    const e = env({ clips: list, ai: aiBy() });
    gen(e, 'manual', FRI);
    const first = new Set(e.prompts[0].prompt.match(/- id: (\S+)｜/g));
    gen(e, 'manual', new Date(FRI.getTime() + 7 * DAY));
    const second = [...e.prompts[1].prompt.matchAll(/- id: (\S+)｜/g)].map((m) => m[0]);
    assert.ok(second.slice(0, 10).every((x) => !first.has(x)), '第二期先輪到沒判過的那一批');
  });
});

/* ========================================================================== */
describe('排程與手動', () => {
  test('手動不推進期間訖：之後的排程新收仍從上一份排程週報（或 7 天前）算；不推 LINE', () => {
    const recent = iso(FRI.getTime() - 2 * DAY);
    const e = env({ clips: [clip('n1', { collected_at: recent })], ai: aiBy() });
    post(e, { action: 'clipReportRun', trigger: 'manual' });
    assert.equal(e.pushes.length, 0, '手動不推 LINE');
    e.call('runClipReportJob_', new Date(FRI.getTime() + 3600000), { budgetLeft: () => 240000 });
    const sched = reports(e).find((r) => r.type === 'scheduled');
    assert.equal(JSON.parse(sched.summary).new_total, 1, '手動那一期沒有吃掉新收');
  });

  test('排程：週五 19:00 後替每位有 feat_clips 的人跑一次、推 LINE；同一週不重跑', () => {
    const e = env({ clips: [clip('a'), clip('b')], ai: aiBy({ rec: ['a'], skip: ['b'] }) });
    const r1 = e.call('runClipReportJob_', FRI, { budgetLeft: () => 240000 });
    assert.equal(r1.processed, 2, 'Neil 與爸爸各一份');
    const mine = e.pushes.find((p) => p.to === ME);
    assert.match(mine.text, /📊 本週圖書館週報\n⭐ 推薦：\n・標題 a\n🗑️ 可略過 1 篇\n到圖書館 📊 週報看完整內容/);
    e.call('runClipReportJob_', new Date(FRI.getTime() + 600000), { budgetLeft: () => 240000 });
    assert.equal(reports(e).filter((r) => r.type === 'scheduled').length, 2, '同一週不重跑');
  });

  test('排程失敗：LINE 通知、不自動重試', () => {
    const e = env({ clips: [clip('a')], ai: () => ({ ok: false, reason: 'HTTP 500', label: 'Gemini' }) });
    e.call('runClipReportJob_', FRI, { budgetLeft: () => 240000 });
    assert.match(e.pushes.find((p) => p.to === ME).text, /產生失敗（AI 呼叫失敗：HTTP 500）/);
    e.call('runClipReportJob_', new Date(FRI.getTime() + 600000), { budgetLeft: () => 240000 });
    assert.equal(reports(e).filter((r) => r.line_id === ME).length, 1);
  });

  test('週五 19:00 前不跑新的一週；預算不夠一個人就留給下一輪', () => {
    const e = env({ clips: [clip('a')], ai: aiBy() });
    e.call('runClipReportJob_', FRI, { budgetLeft: () => 240000 });
    const before = reports(e).length;
    e.call('runClipReportJob_', new Date(FRI.getTime() + 6 * DAY), { budgetLeft: () => 240000 });   // 下週四
    assert.equal(reports(e).length, before);
    const e2 = env({ clips: [clip('a')], ai: aiBy() });
    assert.equal(e2.call('runClipReportJob_', FRI, { budgetLeft: () => 1000 }).processed, 0);
  });
});

/* ========================================================================== */
describe('PWA 動作', () => {
  test('讀週報：最新一期＋歷史；只有自己的', () => {
    const e = env({ clips: [clip('a')], ai: aiBy({ rec: ['a'] }) });
    post(e, { action: 'clipReportRun', trigger: 'manual' });
    const r = post(e, { action: 'clipReport', trigger: 'manual' });
    assert.equal(r.success, true);
    assert.deepEqual(r.report.recommended.map((x) => x.id), ['a']);
    assert.equal(r.history.length, 1);
    assert.equal(post(e, { action: 'clipReport', trigger: 'manual' }, TOK_DAD).report, null, '爸爸看不到 Neil 的');
    assert.equal(post(e, { action: 'clipReport', id: r.report.id, trigger: 'manual' }, TOK_DAD).error, 'not_found');
  });

  test('一鍵標已讀：只改本人、未刪、還不是已讀的；寫 logs（筆數）', () => {
    const e = env({ clips: [clip('a'), clip('b', { read_status: 'reading' }), clip('c', { read_status: 'read' }), clip('d', { del: 'TRUE' }), clip('z', { line_id: DAD })] });
    const r = post(e, { action: 'clipMarkRead', ids: ['a', 'b', 'c', 'd', 'z'], trigger: 'write' });
    assert.equal(r.success, true);
    assert.deepEqual(r.ids, ['a', 'b']);
    const byId = Object.fromEntries(rows(e).map((x) => [x.id, x.read_status]));
    assert.deepEqual([byId.a, byId.b, byId.d, byId.z], ['read', 'read', '', '']);
    assert.ok(e.transactions.some((t) => /一鍵標已讀 2 篇/.test(String(t[3]))));
    assert.equal(post(e, { action: 'clipMarkRead', ids: [], trigger: 'write' }).error, 'invalid_ids');
  });

  test('我的關注：只有本人讀寫；上限 2,000 字；logs 不複製內容；用在提示詞', () => {
    const e = env({ clips: [clip('a')], ai: aiBy() });
    assert.equal(post(e, { action: 'clipFocus', trigger: 'manual' }).focus, '');
    assert.equal(post(e, { action: 'clipFocusSet', focus: 'x'.repeat(2001), trigger: 'write' }).error, 'too_long');
    assert.equal(post(e, { action: 'clipFocusSet', focus: '只想看 AI 自動化', trigger: 'write' }).success, true);
    assert.equal(post(e, { action: 'clipFocus', trigger: 'manual' }, TOK_DAD).focus, '', '各人各一份');
    assert.ok(!JSON.stringify(e.transactions).includes('只想看 AI 自動化'), 'logs 不複製內容');
    post(e, { action: 'clipReportRun', trigger: 'manual' });
    assert.match(e.prompts[0].prompt, /只想看 AI 自動化/);
    assert.equal(reports(e)[0].used_focus, 'TRUE');
  });

  test('沒有 feat_clips：一律拒絕', () => {
    const e = env();
    e.sheets.line_users.values[2][6] = '';
    assert.equal(post(e, { action: 'clipReport', trigger: 'manual' }, TOK_DAD).error, 'forbidden');
  });

  test('clip_reports 一般寫入／讀取都擋', () => {
    const e = env({ clips: [clip('a')], ai: aiBy() });
    post(e, { action: 'clipReportRun', trigger: 'manual' });
    assert.ok(e.read('NO_PWA_WRITE').includes('clip_reports'));
    assert.ok(e.read('NO_PWA_READ').includes('clip_reports'));
  });
});

/* ========================================================================== */
describe('AI 出口', () => {
  test('週報走長輸出（callAi_ 的 2048 tokens 不夠 45 篇的 JSON）；照設定頁那一家', () => {
    const seen = [];
    const e = loadCodeGs({ overrides: { aiCall_: (prompt, feature, opts) => { seen.push({ feature, opts }); return { ok: true, text: '' }; } } });
    e.call('callAiLong_', 'x', 'clip_report');
    assert.equal(seen[0].feature, 'clip_report');
    assert.ok(seen[0].opts.maxTokens >= 8192);
    assert.equal(seen[0].opts.images, undefined, '純文字，不送圖');
  });

  test('AI 回覆被截斷 → 失敗原因講明', () => {
    const e = env({ clips: [clip('a')], ai: () => ({ ok: true, truncated: true, text: '{"items":[{"id":"a","verd', label: 'Gemini' }) });
    assert.equal(gen(e).ok, false);
    assert.match(reports(e)[0].error, /被截斷/);
  });
});

describe('初始化與登記', () => {
  test('初始化建 clip_reports；clips 有 report_* 欄；排程登記；_guide 有說明', () => {
    const e = env();
    const out = e.call('installClipReports_');
    assert.equal(out.changed, true);
    assert.ok(e.sheets.clip_reports);
    assert.deepEqual(e.read('CLIPS_HEADERS').slice(-4), ['report_verdict', 'report_reason', 'report_id', 'report_at']);
    assert.ok(e.read('schedulerJobs_().some(function (j) { return j.name === "clipReport"; })'));
  });
});
