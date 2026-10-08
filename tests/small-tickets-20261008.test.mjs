/**
 * 2026-10-08 小票一次清（股票上線後覆核 R-1～R-3 以外的那幾張）
 *
 *   - 今日指南針被輪詢清空：reviews 表沒有 compass 欄，pull 一重建就把它洗掉 → 存本機
 *   - .sync-badge 空膠囊：hidden 被 display:inline-flex 蓋掉
 *   - 「只看我的」套到雜記與心情
 *   - 任務列「👥 群組名」：boot 帶回畫面上任務用到的群組名稱
 *   - reviews 重複列清理：管理員手動跑，先備份、寧可少刪
 *
 * 跑法：npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const ME = 'Uneil';
const MOM = 'Umom';
const json = (v) => ({ json: () => Promise.resolve(v) });

/** 同一個 id 每次拿到同一個假元素：表單填了什麼、畫面寫了什麼都查得到 */
function stableDom(e, values = {}) {
  e.raw('__els = {}; __vals = ' + JSON.stringify(values));
  e.raw(`document.getElementById = function(id){
    if (!__els[id]) __els[id] = { id, value: __vals[id] === undefined ? '' : __vals[id], addEventListener(){}, dataset:{},
      classList:{add(){},remove(){},toggle(){},contains:()=>false}, style:{},
      textContent:'', innerHTML:'', hidden:false, disabled:false,
      querySelectorAll:()=>[], querySelector:()=>null, appendChild(){}, setAttribute(){} };
    return __els[id];
  }`);
}

function frontend({ reviews = [], storage } = {}) {
  const cloud = { reviews };
  const e = loadFrontend({
    storage,
    fetchImpl: ({ body }) => {
      if (body && body.action === 'read') return json({ data: cloud[body.sheet] || [] });
      return null;
    }
  });
  e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
  e.raw('state = EMPTY_STATE()');
  e.cloud = cloud;
  return e;
}

/* ========================================================================== */
describe('今日指南針：輪詢不會把它洗掉', () => {

  test('存了指南針 → 雲端那列沒有 compass 欄 → pull 之後仍在', async () => {
    const e = frontend();
    stableDom(e, { rvCompass: '先把股票票收尾', rvGood: '跑步', rvStuck: '', rvNext: '' });
    e.call('saveReview');
    const k = e.call('myReviewKey');
    const date = k.split('|')[0];

    // 後端存好了，輪詢讀回來的那列沒有 compass（reviews 表沒這欄）
    e.cloud.reviews = [{ review_date: date, good: '跑步', stuck: '', most_important: '', line_id: ME }];
    e.raw('outbox = []');
    await e.callRaw('pullFromCloud');

    assert.equal(e.read('state.reviews["' + k + '"].compass'), '先把股票票收尾',
      '輪詢一次就清空，等於這欄從來沒存過');
    assert.equal(e.read('state.reviews["' + k + '"].good'), '跑步', '其他欄照雲端');
    e.call('loadTodayReview');
    assert.equal(e.read('__els.rvCompass.value'), '先把股票票收尾');
  });

  test('重新開 App（新的一份程式、同一個 localStorage）也還在', () => {
    const e1 = frontend();
    stableDom(e1, { rvCompass: '早點睡', rvGood: '', rvStuck: '', rvNext: '' });
    e1.call('saveReview');
    const k = e1.call('myReviewKey');
    const saved = e1.localStorage.getItem('personal-os-compass-v1');

    const e2 = frontend({ storage: { 'personal-os-compass-v1': saved } });
    assert.equal(e2.call('compassOf', k), '早點睡');
  });

  test('清空指南針會真的清掉，不會從本機復活', () => {
    const e = frontend();
    stableDom(e, { rvCompass: '要清掉的', rvGood: '有寫', rvStuck: '', rvNext: '' });
    e.call('saveReview');
    const k = e.call('myReviewKey');
    e.raw('__els.rvCompass.value = ""');
    e.call('saveReview');
    assert.equal(e.call('compassOf', k), '');
  });

  test('只留最近 60 天，不會無限長大', () => {
    const e = frontend();
    for (let i = 1; i <= 70; i++) e.call('saveCompass', '2026-01-' + String(i).padStart(3, '0') + '|' + ME, 'x' + i);
    const store = JSON.parse(e.localStorage.getItem('personal-os-compass-v1'));
    assert.equal(Object.keys(store).length, 60);
    assert.equal(store['2026-01-070|' + ME], 'x70', '留下的是最新的');
    assert.equal(store['2026-01-001|' + ME], undefined);
  });
});

/* ========================================================================== */
describe('.sync-badge 沒事時不留空膠囊', () => {
  test('[hidden] 要蓋得過 display:inline-flex', () => {
    assert.match(HTML, /\.sync-badge\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });
});

/* ========================================================================== */
describe('「只看我的」套到雜記與心情', () => {

  function scoped() {
    const e = frontend();
    stableDom(e);
    e.raw(`state.notes = [{id:1, txt:"我的雜記", ts:1, line_id:"${ME}"}, {id:2, txt:"媽媽的雜記", ts:2, line_id:"${MOM}"}]`);
    e.raw(`state.moods = [{id:1, level:3, note:"我的心情", ts:1, line_id:"${ME}"}, {id:2, level:4, note:"媽媽的心情", ts:2, line_id:"${MOM}"}]`);
    return e;
  }

  test('只看我的 → 雜記、心情都只剩自己的', () => {
    const e = scoped();
    e.raw('scopeMine = true');
    e.call('renderNotes'); e.call('renderMoods');
    const notes = e.read('__els.noteList.innerHTML');
    const moods = e.read('__els.moodList.innerHTML');
    assert.ok(notes.includes('我的雜記') && !notes.includes('媽媽的雜記'));
    assert.ok(moods.includes('我的心情') && !moods.includes('媽媽的心情'));
  });

  test('全部 → 兩個人的都在', () => {
    const e = scoped();
    e.raw('scopeMine = false');
    e.call('renderNotes'); e.call('renderMoods');
    assert.ok(e.read('__els.noteList.innerHTML').includes('媽媽的雜記'));
    assert.ok(e.read('__els.moodList.innerHTML').includes('媽媽的心情'));
  });

  test('雜記頁有自己的切換列，多人時才顯示', () => {
    assert.match(HTML, /class="scope-bar" id="scopeNotes" hidden/);
    const e = scoped();
    e.raw('activeUsers = function(){ return [1, 2]; }');
    e.call('renderScopeBars');
    assert.equal(e.read('__els.scopeNotes.hidden'), false);
    assert.ok(e.read('__els.scopeNotes.innerHTML').includes('只看我的'));
  });
});

/* ========================================================================== */
describe('任務列「👥 群組名」', () => {

  const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at', 'created_at', 'updated_at'];

  function backend() {
    return loadCodeGs({
      cache: true, extraFiles: ['line-router.gs'],
      tokens: { 'tok-me': ME },
      sheets: {
        line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'], [ME, 'Neil', 'TRUE', 'TRUE']]),
        line_groups: new FakeSheet('line_groups', [GROUP_H,
          ['Cfam', '家族', 'TRUE', 'TRUE', 'TRUE', 'TRUE', '', '', '', ''],
          ['Cwork', '公司群', 'TRUE', 'TRUE', 'TRUE', 'TRUE', '', '', '', ''],
          ['Cnoname', '', 'TRUE', 'TRUE', 'TRUE', 'TRUE', '', '', '', '']]),
        tasks: new FakeSheet('tasks', [
          ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'origin_chat'],
          ['1', '倒垃圾', '', '2026-10-01T00:00:00.000Z', 'M', ME, '', 'Cfam'],
          ['2', '沒名字的群', '', '2026-10-01T00:00:00.000Z', 'M', ME, '', 'Cnoname'],
          ['3', '自己建的', '', '2026-10-01T00:00:00.000Z', 'M', ME, '', '']]),
        reviews: new FakeSheet('reviews', [['review_date', 'good', 'line_id', 'del']]),
        moods: new FakeSheet('moods', [['id', 'mood_date', 'level', 'line_id', 'del']]),
        notes: new FakeSheet('notes', [['id', 'text', 'created_at', 'line_id', 'del']]),
        expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'amount', 'line_id', 'del']]),
        logs: new FakeSheet('logs', [['id']])
      }
    });
  }

  test('boot 只帶畫面上任務用到的群組，沒名字的給「群組」', () => {
    const e = backend();
    const out = JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify({ action: 'boot', token: 'tok-me' }) } }).body);
    assert.deepEqual(out.group_names, { Cfam: '家族', Cnoname: '群組' },
      '公司群沒有任務用到，不該送下去');
  });

  test('前端：開機帶回的名稱掛在任務上，自己建的沒有標籤', async () => {
    const e = loadFrontend({
      fetchImpl: ({ body }) => {
        if (body && body.action === 'boot') {
          return json({
            session: { status: 'ok', line_id: ME, device_id: 'd1' },
            line_users: [{ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE' }],
            data: {
              tasks: [
                { id: '1', text: '倒垃圾', is_completed: '', created_at: '2026-10-01T00:00:00.000Z', priority: 'M', line_id: ME, origin_chat: 'Cfam' },
                { id: '3', text: '自己建的', is_completed: '', created_at: '2026-10-01T00:00:00.000Z', priority: 'M', line_id: ME }
              ], reviews: [], moods: [], notes: [], expenses: []
            },
            denied: [], group_names: { Cfam: '家族' }
          });
        }
        return json({ success: true });
      }
    });
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; gateMode = null');
    e.raw('state = EMPTY_STATE()');
    e.raw('applyIdentity = function(){}; applyZone = function(){}');
    await e.callRaw('startSession', 'cold');
    stableDom(e);
    e.call('renderTasks');
    const html = e.read('__els.taskListOpen.innerHTML');
    assert.ok(html.includes('👥 家族'), html);
    assert.equal((html.match(/👥/g) || []).length, 1, '自己在 App 建的任務不掛群組標籤');
  });
});

/* ========================================================================== */
describe('reviews 重複列清理（管理員手動跑）', () => {

  const H = ['review_date', 'good', 'stuck', 'most_important', 'line_id', 'del'];

  function env(rows) {
    return loadCodeGs({ sheets: { reviews: new FakeSheet('reviews', [H].concat(rows)), logs: new FakeSheet('logs', [['id']]) } });
  }

  test('同一天：有 line_id 的那列留下，沒 line_id 的併進來再刪；先備份', () => {
    const e = env([
      ['2026-09-20', '', '', '', '', ''],                    // 殘骸，全空
      ['2026-09-20', '跑步', '', '', ME, ''],                 // 正本
      ['2026-09-20', '', '卡在報稅', '', '', ''],             // 殘骸，有正本沒有的內容
      ['2026-09-21', '一般的一天', '', '', ME, '']
    ]);
    const before = e.sheets.reviews.values.map((r) => r.slice());
    const out = e.call('dedupeReviews');

    assert.equal(out.deleted, 2);
    const rows = e.sheets.reviews.toRecords();
    assert.equal(rows.length, 2);
    const d20 = rows.find((r) => r.review_date === '2026-09-20');
    assert.equal(d20.line_id, ME);
    assert.equal(d20.good, '跑步');
    assert.equal(d20.stuck, '卡在報稅', '被刪的那列有內容，要補進留下的那列，不能丟字');

    const backup = e.sheets[out.backup];
    assert.ok(backup, '動手前要有備份分頁');
    assert.deepEqual(backup.values, before, '備份是動手前的整張表');
  });

  test('同一天兩個人：各留各的；沒 line_id 的看不出是誰的，原樣留著', () => {
    const e = env([
      ['2026-09-20', '我的', '', '', ME, ''],
      ['2026-09-20', '媽媽的', '', '', MOM, ''],
      ['2026-09-20', '誰的？', '', '', '', '']
    ]);
    const out = e.call('dedupeReviews');
    assert.equal(out.deleted, 0);
    assert.deepEqual(out.ambiguous_dates, ['2026-09-20']);
    assert.equal(e.sheets.reviews.toRecords().length, 3);
    assert.equal(out.backup, undefined, '沒東西要刪就不建備份分頁');
  });

  test('同一天同一個人兩列：留內容多的', () => {
    const e = env([
      ['2026-09-22', '少', '', '', ME, ''],
      ['2026-09-22', '多', '有卡', '有重點', ME, '']
    ]);
    e.call('dedupeReviews');
    const rows = e.sheets.reviews.toRecords();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].good, '多');
  });

  test('已標刪除的列不碰（交給封存）', () => {
    const e = env([
      ['2026-09-23', '刪掉的', '', '', ME, 'TRUE'],
      ['2026-09-23', '現在的', '', '', ME, '']
    ]);
    const out = e.call('dedupeReviews');
    assert.equal(out.deleted, 0);
    assert.equal(e.sheets.reviews.toRecords().length, 2);
  });

  test('Sheet 讀回來的日期是 Date 也認得同一天', () => {
    const e = env([
      [new Date(2026, 8, 24), '', '', '', '', ''],
      ['2026-09-24', '正本', '', '', ME, '']
    ]);
    assert.equal(e.call('dedupeReviews').deleted, 1);
  });

  test('預覽只算不動', () => {
    const e = env([
      ['2026-09-20', '', '', '', '', ''],
      ['2026-09-20', '跑步', '', '', ME, '']
    ]);
    const out = e.call('dedupeReviewsPreview');
    assert.equal(out.deleted, 1);
    assert.equal(out.dry_run, true);
    assert.equal(e.sheets.reviews.toRecords().length, 2);
    assert.equal(Object.keys(e.sheets).filter((n) => n.startsWith('_reviews_backup_')).length, 0);
  });
});

/* ========================================================================== */
describe('覆核補強（2026-10-08 code review）', () => {

  function memberEnv(extra = {}) {
    return loadCodeGs({
      tokens: { 'tok-me': ME, 'tok-mom': MOM },
      sheets: Object.assign({
        line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'],
          [ME, 'Neil', 'TRUE', 'TRUE'], [MOM, '媽媽', 'TRUE', '']]),
        reviews: new FakeSheet('reviews', [['review_date', 'good', 'line_id', 'del'], ['2026-09-20', '日誌', ME, '']]),
        logs: new FakeSheet('logs', [['id']])
      }, extra)
    });
  }
  const post = (e, body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);

  for (const action of ['upsert', 'completeRecurring']) {
    test('一般成員用 ' + action + ' 改不了名單（不能把自己升成管理者）', () => {
      const e = memberEnv();
      const before = JSON.stringify(e.sheets.line_users.values);
      const out = post(e, { action, token: 'tok-mom', sheet: 'line_users', key_field: 'line_id',
        record: { line_id: MOM, display_name: '媽媽', is_active: 'TRUE', is_admin: 'TRUE' } });
      assert.equal(out.error, 'forbidden');
      assert.equal(JSON.stringify(e.sheets.line_users.values), before);
    });
  }

  test('管理者照樣能改名單', () => {
    const e = memberEnv();
    const out = post(e, { action: 'upsert', token: 'tok-me', sheet: 'line_users', key_field: 'line_id',
      record: { line_id: MOM, display_name: '媽咪', is_active: 'TRUE', is_admin: '' } });
    assert.equal(out.success, true);
  });

  test('reviews 備份分頁：PWA 讀不到、寫不進', () => {
    const name = '_reviews_backup_20261008_120000';
    const e = memberEnv({ [name]: new FakeSheet(name, [['review_date', 'good', 'line_id'], ['2026-09-20', '全家的日誌', ME]]) });
    assert.equal(post(e, { action: 'read', token: 'tok-mom', sheet: name }).error, 'sheet_not_readable');
    const many = post(e, { action: 'readMany', token: 'tok-mom', sheets: [name] });
    assert.ok(!many.data || !many.data[name], JSON.stringify(many));
    const w = post(e, { action: 'upsert', token: 'tok-me', sheet: name, key_field: 'review_date', record: { review_date: 'x' } });
    assert.equal(w.error, 'sheet_not_writable');
  });

  test('dedupeReviews：同名備份分頁已存在就整個不動', () => {
    const H = ['review_date', 'good', 'stuck', 'most_important', 'line_id', 'del'];
    const e = loadCodeGs({ sheets: {
      reviews: new FakeSheet('reviews', [H, ['2026-09-20', '', '', '', '', ''], ['2026-09-20', '跑步', '', '', ME, '']]),
      logs: new FakeSheet('logs', [['id']])
    } });
    // 假環境的 formatDate 固定回同一個字串，等於「同一秒重跑」
    const first = e.call('dedupeReviews');
    assert.equal(first.deleted, 1);
    const backupBefore = JSON.stringify(e.sheets[first.backup].values);
    e.sheets.reviews.values.push(['2026-09-21', '', '', '', '', ''], ['2026-09-21', '又一天', '', '', ME, '']);
    const second = e.call('dedupeReviews');
    assert.equal(second.error, 'backup_exists');
    assert.equal(e.sheets.reviews.toRecords().length, 3, '沒有新備份就不刪');
    assert.equal(JSON.stringify(e.sheets[first.backup].values), backupBefore, '上一份備份不能被蓋掉');
  });
});
