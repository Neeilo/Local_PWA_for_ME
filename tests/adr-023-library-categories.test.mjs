/**
 * ADR-023 PR-E（後端）— 圖書館分類（D-7、D-8）
 *
 * 為什麼：圖書館已經 81 篇，只能依時間翻；Neil 要讀到的時候點一下歸類，之後依分類找。
 * 盯的事：
 *   - 分類清單放設定表 _clip_categories（比照 _expense_config）：初始化寫 6 個初始分類，已有就一格都不動
 *   - clipCategory 單選、點一下就存；只限擁有者；只收「啟用中」的分類，'' 清回未分類
 *   - 停用的分類：不能再選，但已歸類的篇照樣讀得到原名（清單照樣回、標 active=false）
 *   - 清單只在讀 clips 時附帶（點開圖書館那一次），不進冷開機；表本身 PWA 讀寫都擋
 *   - 現有收藏不自動補分類
 *   - 搜尋結果帶分類
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil', DAD = 'Udad';
const TOK_ME = 'tok-me', TOK_DAD = 'tok-dad';
const FEATS = ['feat_tasks', 'feat_notes', 'feat_clips'];
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS);
const CAT_H = ['name', 'icon', 'sort', 'is_active'];

function env({ cats = null, clipsRows = [] } = {}) {
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H,
      [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'], [DAD, '爸爸', 'TRUE', '', 'TRUE', 'TRUE', 'TRUE']]),
    logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
  };
  if (cats) sheets._clip_categories = new FakeSheet('_clip_categories', [CAT_H].concat(cats));
  const e = loadCodeGs({ cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], tokens: { [TOK_ME]: ME, [TOK_DAD]: DAD }, sheets,
    properties: { APIFY_TOKEN: 'x' } });
  e.call('ensureClipsSheet_');
  const H = e.read('CLIPS_HEADERS');
  clipsRows.forEach((r) => e.sheets.clips.values.push(H.map((h) => (r[h] == null ? '' : r[h]))));
  e.post = (body, tok = TOK_ME) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok, trigger: 'write' }, body)) } }).body);
  e.clip = (id) => e.sheets.clips.toRecords().find((r) => String(r.id) === id);
  e.init = () => e.read('initSteps_().filter(function (s) { return s.label === "圖書館分類"; })[0].run()');
  return e;
}
const clip = (id, owner = ME, extra = {}) => Object.assign({ id, line_id: owner, url: 'https://www.instagram.com/p/' + id + '/', kind: 'post', status: 'done',
  caption: '內文 ' + id, collected_at: '2026-10-19T01:00:00.000Z' }, extra);
const CATS = [['AI 提示詞', '🤖', 10, 'TRUE'], ['投資', '📈', 50, 'TRUE'], ['舊分類', '🗂', 5, 'FALSE']];

describe('初始化：設定表', () => {

  test('沒有表 → 建表寫 6 個初始分類（D-8）；現有收藏不自動補分類', () => {
    const e = env({ clipsRows: [clip('c1')] });
    const r = e.init();
    assert.equal(r.changed, true);
    const rows = e.sheets._clip_categories.toRecords();
    assert.deepEqual(rows.map((x) => x.icon + ' ' + x.name),
      ['🤖 AI 提示詞', '🛠 Claude／開發工具', '💼 副業與內容經營', '🌱 成長與心態', '📈 投資', '🍜 吃喝玩樂']);
    assert.ok(rows.every((x) => x.is_active === 'TRUE'));
    assert.equal(e.clip('c1').category, '');
  });

  test('已有表 → 一格都不動（Neil 改過名、停用的都留著）', () => {
    const e = env({ cats: CATS });
    const before = JSON.stringify(e.sheets._clip_categories.values);
    const r = e.init();
    assert.equal(r.changed, false);
    assert.equal(JSON.stringify(e.sheets._clip_categories.values), before);
  });

  test('PWA 讀寫都擋；_guide 有登記', () => {
    const e = env();
    assert.ok(e.read('NO_PWA_READ').includes('_clip_categories'));
    assert.ok(e.read('NO_PWA_WRITE').includes('_clip_categories'));
    assert.ok(e.read('guideRegistry_().map(function (g) { return g.sheet; })').includes('_clip_categories'));
  });
});

describe('清單：讀 clips 時附帶（不進冷開機）', () => {

  test('readMany clips → clip_categories 依 sort 排、停用的也回（active=false）', () => {
    const e = env({ cats: CATS, clipsRows: [clip('c1')] });
    const r = e.post({ action: 'readMany', sheets: ['clips'], trigger: 'manual' });
    assert.deepEqual(r.clip_categories.map((c) => [c.name, c.active]), [['舊分類', false], ['AI 提示詞', true], ['投資', true]]);
  });

  test('沒讀 clips 的 readMany、boot：不帶', () => {
    const e = env({ cats: CATS });
    assert.equal(e.post({ action: 'readMany', sheets: ['tasks'], trigger: 'poll' }).clip_categories, undefined);
    assert.equal(e.post({ action: 'boot', trigger: 'cold' }).clip_categories, undefined);
  });
});

describe('clipCategory：點一下就歸類（D-7）', () => {

  test('擁有者選啟用中的分類 → 寫進 clips.category；再送 "" 清回未分類', () => {
    const e = env({ cats: CATS, clipsRows: [clip('c1')] });
    assert.deepEqual(e.post({ action: 'clipCategory', id: 'c1', category: '投資' }), { success: true, category: '投資' });
    assert.equal(e.clip('c1').category, '投資');
    assert.equal(e.post({ action: 'clipCategory', id: 'c1', category: '' }).success, true);
    assert.equal(e.clip('c1').category, '');
  });

  test('單選：換分類是取代，不是累加', () => {
    const e = env({ cats: CATS, clipsRows: [clip('c1')] });
    e.post({ action: 'clipCategory', id: 'c1', category: '投資' });
    e.post({ action: 'clipCategory', id: 'c1', category: 'AI 提示詞' });
    assert.equal(e.clip('c1').category, 'AI 提示詞');
  });

  test('只能改自己的收藏：別人的 → forbidden（永久）、資料不動', () => {
    const e = env({ cats: CATS, clipsRows: [clip('c1', DAD)] });
    const r = e.post({ action: 'clipCategory', id: 'c1', category: '投資' });
    assert.equal(r.error, 'forbidden');
    assert.equal(r.permanent, true);
    assert.equal(e.clip('c1').category, '');
  });

  test('停用的分類、清單沒有的字串：invalid_category（永久）、資料不動', () => {
    const e = env({ cats: CATS, clipsRows: [clip('c1', ME, { category: '投資' })] });
    for (const bad of ['舊分類', '<script>', '隨便寫']) {
      const r = e.post({ action: 'clipCategory', id: 'c1', category: bad });
      assert.equal(r.error, 'invalid_category', bad);
      assert.equal(r.permanent, true);
    }
    assert.equal(e.clip('c1').category, '投資');
  });

  test('停用的分類：已歸類的篇讀出來仍是原名', () => {
    const e = env({ cats: CATS, clipsRows: [clip('c1', ME, { category: '舊分類' })] });
    const r = e.post({ action: 'readMany', sheets: ['clips'], trigger: 'manual' });
    assert.equal(r.data.clips[0].category, '舊分類');
  });

  test('拿不到鎖：busy（可重試）', () => {
    const e = env({ cats: CATS, clipsRows: [clip('c1')] });
    e.lock.busy = true;
    const r = e.post({ action: 'clipCategory', id: 'c1', category: '投資' });
    assert.equal(r.error, 'busy');
    assert.equal(r.permanent, undefined);
  });
});

describe('搜尋結果帶分類', () => {
  test('圖書館的命中帶 tag；沒分類的沒有 tag', () => {
    const e = env({ cats: CATS, clipsRows: [clip('c1', ME, { caption: '咖啡 筆記', category: '吃喝玩樂' }), clip('c2', ME, { caption: '咖啡 第二篇' })] });
    const r = e.post({ action: 'search', q: '咖啡', trigger: 'manual' });
    const g = r.groups.find((x) => x.key === 'clips');
    const by = Object.fromEntries(g.items.map((i) => [i.id, i.tag]));
    assert.equal(by.c1, '吃喝玩樂');
    assert.equal(by.c2, undefined);
  });
});
