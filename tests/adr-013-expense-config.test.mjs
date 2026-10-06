/**
 * ADR-013 PR-A — 記帳分類設定 × 細項 × 對象（交棒票 T1／T2／T3）
 *
 * 盯的事：
 *   - 分類只有一份，在 _expense_config：不存在就建表寫初版，存在不覆蓋；前後端不再寫死清單
 *   - 讀不到設定 → 退回內建清單、寫 logs、記帳照常（fail-safe，跟白名單的 fail-closed 刻意相反）
 *   - 設定有問題的列跳過並標 ⚠️（細項重複、大類不存在、顏色重複），不讓整張設定失效
 *   - LINE：格式不變；第 3 段可打大類／別名／細項；第 4 段剛好是細項才算細項；斜線備註不被切壞
 *   - 「分類」關鍵字回傳設定分頁的內容；權限照 feat_expense
 *   - 「查/」兩層彙總（大類 → 細項）＋對象；舊資料歸「未細分」；餐飲併進飲食
 *   - 餐飲→飲食遷移可重複執行
 *   - 前端：細項、對象、分期欄位整列帶回雲端（upsert 是整列覆寫，漏帶就被清掉）
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
const TOK_ME = 'tok-neil-device';
const TOK_MOM = 'tok-mom-device';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'];
const CONFIG_HEADERS = ['kind', 'name', 'parent', 'targets', 'aliases', 'color', 'sort', 'is_active'];
const EXP_HEADERS = ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del',
  'subcategory', 'targets', 'plan_id', 'plan_seq'];
const today = () => new Date().toISOString().slice(0, 10);

function roster(momExpense = 'TRUE') {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
    [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
    [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map((f) => (f === 'feat_expense' ? momExpense : 'TRUE')))
  ]);
}

function env({ sheets = {}, users = roster(), properties = {}, overrides = {}, extraFiles = [] } = {}) {
  const replies = [];
  const e = loadCodeGs({
    cache: true,
    extraFiles: ['line-router.gs'].concat(extraFiles),
    properties,
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    sheets: Object.assign({
      line_users: users,
      expenses: new FakeSheet('expenses', [EXP_HEADERS]),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    }, sheets),
    overrides: Object.assign({ lineReply_: (_t, text) => { replies.push(String(text)); } }, overrides)
  });
  e.replies = replies;
  return e;
}

function line(e, userId, text) {
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: { type: 'user', userId }, message: { type: 'text', text } });
  return e.replies[e.replies.length - 1] || '';
}

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

/** 一張自訂的設定分頁 */
function configSheet(rows) {
  return new FakeSheet('_expense_config', [CONFIG_HEADERS].concat(rows));
}

const lastExpense = (e) => e.sheets.expenses.toRecords().slice(-1)[0];

/* ========================================================================== */
describe('設定分頁：建表、不覆蓋、快取', () => {

  test('分頁不存在 → 自動建表寫入初版（8 大類、細項、對象），並留一列 logs', () => {
    const e = env();
    assert.equal(e.ss.getSheetByName('_expense_config'), null, '前提：還沒有這張表');
    const cfg = e.call('expenseConfig_');
    const sheet = e.ss.getSheetByName('_expense_config');
    assert.ok(sheet, '要自動建出來');
    assert.deepEqual(sheet.values[0], CONFIG_HEADERS);
    assert.equal(cfg.source, 'sheet', '建好之後讀的就是那張表，不是內建清單');
    assert.deepEqual(cfg.categories.map((c) => c.name), ['飲食', '交通', '日常用品', '家庭', '醫療', '娛樂', '其他', '教育']);
    const food = cfg.categories[0];
    assert.deepEqual(food.subs, ['外食', '買菜', '冷凍', '常備食材']);
    assert.deepEqual(food.aliases, ['餐飲']);
    assert.deepEqual(cfg.categories[1].targets, ['汽車V', '汽車X', '機車G', '機車A'], '交通的對象是車輛');
    assert.deepEqual(cfg.categories[7].targets, ['姐姐', '妹妹', '爸爸', '媽媽', '共有', '其他人'], '教育的對象是家人');
    assert.equal(cfg.categories[6].targets.length, 10, '「其他」的對象群組是「全部」＝家人＋車輛');
    assert.deepEqual(cfg.warnings, [], '初版本身不該有任何 ⚠️');
    assert.ok(e.transactions.some((t) => String(t[2]).includes('_expense_config')), '建表要留 logs');
  });

  test('分頁已存在 → 不覆蓋，讀到的就是 Sheet 上的內容', () => {
    const custom = configSheet([['category', '吃的', '', '', '', 'c1', 1, '']]);
    const e = env({ sheets: { _expense_config: custom } });
    const cfg = e.call('expenseConfig_');
    assert.deepEqual(cfg.categories.map((c) => c.name), ['吃的']);
    assert.equal(custom.values.length, 2, '一列都沒被加進去');
  });

  test('有快取：5 分鐘內不重讀 Sheet；過期後讀到 Neil 改過的內容', () => {
    const sheet = configSheet([['category', '吃的', '', '', '', 'c1', 1, '']]);
    const e = env({ sheets: { _expense_config: sheet } });
    e.call('expenseConfig_');
    sheet.values.push(['category', '玩的', '', '', '', 'c2', 2, '']);
    assert.deepEqual(e.call('expenseConfig_').categories.map((c) => c.name), ['吃的'], '快取還沒過期');
    e.clock.advance(301);
    assert.deepEqual(e.call('expenseConfig_').categories.map((c) => c.name), ['吃的', '玩的']);
  });

  test('排序照 sort 欄；停用的不在選單但還認得（舊資料照常顯示）', () => {
    const e = env({ sheets: { _expense_config: configSheet([
      ['category', '乙', '', '', '', 'c2', 20, ''],
      ['category', '甲', '', '', '', 'c1', 10, 'TRUE'],
      ['category', '舊的', '', '', '', 'c3', 5, 'FALSE'],
      ['sub', '停用細項', '甲', '', '', '', 1, false]
    ]) } });
    const cfg = e.call('expenseConfig_');
    assert.deepEqual(cfg.categories.map((c) => [c.name, c.active]), [['舊的', false], ['甲', true], ['乙', true]]);
    assert.deepEqual(cfg.categories[1].subs, [], '停用的細項（取消勾選＝false）不出現');
    assert.equal(e.call('resolveExpenseCategory_', cfg, '舊的'), null, '停用的大類 LINE 打不進去');
    assert.equal(e.call('canonicalExpenseCategory_', cfg, '舊的'), '舊的', '但統計照樣認得');
  });

  test('PWA 寫不進 _expense_config（任何 action）', () => {
    const e = env();
    e.call('expenseConfig_');
    const out = post(e, { action: 'upsert', token: TOK_ME, sheet: '_expense_config', record: { kind: 'category', name: 'x' } });
    assert.equal(out.error, 'sheet_not_writable');
  });
});

/* ========================================================================== */
describe('設定讀不到 → 退回內建清單、寫 logs、記帳照常', () => {

  const broken = {
    '缺 kind 欄': () => new FakeSheet('_expense_config', [['名稱', '上層'], ['飲食', '']]),
    '讀取丟例外': () => { const s = configSheet([]); s.getDataRange = () => { throw new Error('Service unavailable'); }; return s; },
    '一個啟用中的大類都沒有': () => configSheet([['category', '飲食', '', '', '', 'c1', 1, 'FALSE']])
  };
  for (const [name, make] of Object.entries(broken)) {
    test(name, () => {
      const e = env({ sheets: { _expense_config: make() } });
      const cfg = e.call('expenseConfig_');
      assert.equal(cfg.source, 'builtin');
      assert.equal(cfg.categories[0].name, '飲食', '內建清單就是初版');
      assert.ok(e.transactions.some((t) => t[1] === '失敗' && /暫用內建清單/.test(t[3])), '要寫 logs，不可靜默');

      const reply = line(e, ME, '記帳/120/外食/午餐');
      assert.match(reply, /已記錄支出/, '記帳不能因為設定壞掉就停');
      assert.equal(lastExpense(e).subcategory, '外食');
    });
  }

  test('退回的內建清單不進快取：修好 Sheet 之後下一次就讀得到', () => {
    const sheet = new FakeSheet('_expense_config', [['名稱'], ['x']]);
    const e = env({ sheets: { _expense_config: sheet } });
    assert.equal(e.call('expenseConfig_').source, 'builtin');
    sheet.values = [CONFIG_HEADERS, ['category', '吃的', '', '', '', 'c1', 1, '']];
    assert.equal(e.call('expenseConfig_').source, 'sheet');
  });
});

/* ========================================================================== */
describe('自檢：有問題的列跳過並標 ⚠️，其他照常', () => {

  test('細項重複、細項的大類不存在、大類顏色重複', () => {
    const e = env();
    const parsed = e.call('parseExpenseConfig_', [
      { kind: 'category', name: '飲食', color: 'c1' },
      { kind: 'category', name: '交通', color: 'c1' },
      { kind: 'sub', name: '外食', parent: '飲食' },
      { kind: 'sub', name: '外食', parent: '交通' },
      { kind: 'sub', name: '機票', parent: '旅遊' }
    ]);
    assert.equal(parsed.ok, true, '一個打錯字的細項不該讓全家都不能記帳');
    const w = parsed.warnings.join('\n');
    assert.match(w, /細項「外食」重複/);
    assert.match(w, /細項「機票」的大類「旅遊」不存在/);
    assert.match(w, /顏色都是 c1/);
    assert.deepEqual(parsed.categories[0].subs, ['外食'], '重複的只認第一個');
    assert.deepEqual(parsed.categories[1].subs, []);
  });

  test('_guide 的狀態欄標出 ⚠️', () => {
    const e = env({
      extraFiles: ['sheet-guide.gs'],
      sheets: { _expense_config: configSheet([
        ['category', '飲食', '', '', '', 'c1', 1, ''],
        ['sub', '外食', '飲食', '', '', '', 1, ''],
        ['sub', '外食', '飲食', '', '', '', 2, '']
      ]) }
    });
    e.call('refreshGuide');
    const guide = e.ss.getSheetByName('_guide').values;
    const row = guide.find((r) => r[0] === '_expense_config');
    assert.ok(row, '_expense_config 有登記');
    assert.match(String(row[guide[1].indexOf('狀態')]), /^⚠️ .*細項「外食」重複/);
  });
});

/* ========================================================================== */
describe('不再有寫死的分類清單', () => {

  const src = (f) => readFileSync(join(ROOT, f), 'utf8');

  test('index.html 與 line-router.gs 沒有任何一個分類名的字串常值', () => {
    for (const f of ['index.html', 'apps-script/line-router.gs']) {
      const s = src(f);
      for (const name of ['日常用品', '常備食材', '汽車V']) {
        assert.equal(s.includes("'" + name + "'"), false, f + ' 裡還寫死了「' + name + '」');
      }
      assert.doesNotMatch(s, /EXPENSE_CATEGORIES\s*=/, f + ' 還有 EXPENSE_CATEGORIES');
      assert.doesNotMatch(s, /CATEGORY_COLOR\s*=/, f + ' 還有 CATEGORY_COLOR');
    }
  });

  test('Code.gs 裡只有初版那一份（同時是 fail-safe）', () => {
    const s = src('apps-script/Code.gs');
    assert.equal(s.split("'日常用品'").length - 1, 1);
    assert.ok(s.indexOf("'日常用品'") > s.indexOf('function expenseConfigSeed_'));
  });
});

/* ========================================================================== */
describe('LINE：格式不變，分類欄更好打（T3）', () => {

  const cases = [
    ['記帳/120/外食/午餐', '飲食', '外食', '午餐', '-$120　飲食＞外食\n📝 午餐'],
    ['記帳/120/飲食/外食/午餐', '飲食', '外食', '午餐', '-$120　飲食＞外食\n📝 午餐'],
    ['記帳/120/飲食/午餐', '飲食', '', '午餐', '-$120　飲食\n📝 午餐'],
    ['記帳/1048/加油', '交通', '加油', '', '-$1,048　交通＞加油'],
    ['收入/50000/其他/九月薪水', '其他', '', '九月薪水', '+$50,000　其他\n📝 九月薪水']
  ];
  for (const [text, cat, sub, note, shown] of cases) {
    test(text + ' → ' + cat + (sub ? '＞' + sub : '') + (note ? '，備註 ' + note : ''), () => {
      const e = env();
      const reply = line(e, ME, text);
      assert.ok(reply.includes(shown), '回覆：' + reply);
      const row = lastExpense(e);
      assert.equal(row.category, cat);
      assert.equal(row.subcategory, sub);
      assert.equal(row.note, note);
      assert.equal(row.targets, '', 'LINE 不填對象');
      assert.equal(row.line_id, ME);
    });
  }

  test('記帳/120/餐飲 → 記為飲食，並提示用到了別名', () => {
    const e = env();
    const reply = line(e, ME, '記帳/120/餐飲');
    assert.equal(lastExpense(e).category, '飲食');
    assert.match(reply, /（餐飲已記為 飲食）/);
  });

  test('第 4 段不是該大類的細項 → 整段是備註（別的大類的細項也不算）', () => {
    const e = env();
    line(e, ME, '記帳/120/飲食/加油');
    assert.deepEqual([lastExpense(e).subcategory, lastExpense(e).note], ['', '加油']);
  });

  test('備註含斜線不被切壞（第 3 段是大類、是細項兩種都驗）', () => {
    const e = env();
    line(e, ME, '記帳/120/飲食/買 A/B 兩份');
    assert.equal(lastExpense(e).note, '買 A/B 兩份');
    line(e, ME, '記帳/120/外食/買 A/B 兩份');
    assert.deepEqual([lastExpense(e).subcategory, lastExpense(e).note], ['外食', '買 A/B 兩份']);
    line(e, ME, '記帳/120/飲食/外食/A/B');
    assert.deepEqual([lastExpense(e).subcategory, lastExpense(e).note], ['外食', 'A/B']);
  });

  test('分類不認得 → 不寫入，回覆從設定產生的清單（大類＋細項）', () => {
    const e = env({ sheets: { _expense_config: configSheet([
      ['category', '吃的', '', '', '', 'c1', 1, ''],
      ['sub', '宵夜', '吃的', '', '', '', 1, '']
    ]) } });
    const reply = line(e, ME, '記帳/120/亂打');
    assert.match(reply, /沒有「亂打」這個分類/);
    assert.match(reply, /吃的/);
    assert.match(reply, /宵夜/);
    assert.equal(e.sheets.expenses.values.length, 1, '一列都沒寫');
  });
});

/* ========================================================================== */
describe('LINE「分類」關鍵字', () => {

  test('回傳的是設定分頁的內容（含細項與對象），改了 Sheet 就跟著變', () => {
    const sheet = configSheet([
      ['category', '吃的', '', '家人', '', 'c1', 1, ''],
      ['sub', '宵夜', '吃的', '', '', '', 1, ''],
      ['target', '阿嬤', '家人', '', '', '', 1, '']
    ]);
    const e = env({ sheets: { _expense_config: sheet } });
    const reply = line(e, ME, '分類');
    assert.match(reply, /吃的/);
    assert.match(reply, /細項：宵夜/);
    assert.match(reply, /對象：阿嬤/);
    assert.doesNotMatch(reply, /日常用品/, '不是內建清單');

    sheet.values.push(['sub', '早午餐', '吃的', '', '', '', 2, '']);
    e.clock.advance(301);
    assert.match(line(e, ME, '分類'), /宵夜、早午餐/);
  });

  test('權限照 feat_expense：關掉的人拿不到，並寫 logs', () => {
    const e = env({ users: roster('') });
    const reply = line(e, MOM, '分類');
    assert.match(reply, /沒有「記帳」功能的權限/);
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && t[2] === '分類' && t[6] === MOM));
  });

  test('出現在支援清單裡', () => {
    const e = env();
    assert.match(e.call('supportedPrefixesMessage_'), /・分類/);
  });
});

/* ========================================================================== */
describe('「查/」兩層彙總（D-5）', () => {

  function promptFor(rows, users = roster()) {
    let prompt = '';
    const e = env({
      users,
      properties: { GEMINI_API_KEY: 'k' },
      overrides: { callGemini_: (_k, p) => { prompt = p; return { ok: true, text: '好' }; } },
      sheets: { expenses: new FakeSheet('expenses', [EXP_HEADERS].concat(rows)) }
    });
    line(e, users === roster() ? ME : MOM, '查/這個月花多少');
    return prompt;
  }
  const row = (id, cat, amount, sub = '', targets = '') =>
    [id, today(), 'expense', cat, amount, '', '2026-10-01T00:00:00.000Z', ME, '', sub, targets, '', ''];

  test('大類底下列細項，沒填細項的歸「未細分」；遷移前的「餐飲」併進「飲食」', () => {
    const p = promptFor([
      row('1', '飲食', 300, '外食'),
      row('2', '餐飲', 100),            // 舊資料，還沒遷移、沒有細項
      row('3', '飲食', 50, '買菜'),
      row('4', '日常用品', 80)
    ]);
    assert.match(p, /・飲食 450 元（3 筆）/, '餐飲那 100 元要算進飲食');
    assert.match(p, /　－外食 300 元（1 筆）/);
    assert.match(p, /　－未細分 100 元（1 筆）/);
    assert.match(p, /　－買菜 50 元（1 筆）/);
    assert.match(p, /・日常用品 80 元（1 筆）/);
    assert.doesNotMatch(p, /・日常用品[^\n]*\n　－未細分/, '整類都沒細分時不展開，省版面');
    assert.doesNotMatch(p, /・餐飲/);
    assert.match(p, /記帳彙總分兩層/, '提示詞要說明兩層結構');
  });

  test('對象小計：多選的帳整筆計入每個對象，提示詞講明不可相加', () => {
    const p = promptFor([row('1', '教育', 3000, '才藝', '姐姐,妹妹'), row('2', '教育', 1000, '學費', '姐姐')]);
    assert.match(p, /【對象】姐姐 4,000 元（2 筆）；妹妹 3,000 元（1 筆）/);
    assert.match(p, /對象小計相加會大於總額，不可相加/);
    assert.match(p, /支出合計 4,000 元（2 筆）/, '總額不受對象影響');
  });

  test('feat_expense 關掉的人仍然拿不到任何記帳資料', () => {
    const p = promptFor([row('1', '飲食', 300, '外食')], roster(''));
    assert.ok(p, '前提：有送出 prompt');
    assert.doesNotMatch(p, /記帳彙總/);
    assert.doesNotMatch(p, /外食/);
  });

  test('回覆行數上限是常數，寫進提示詞', () => {
    const e = env();
    assert.equal(e.read('QUERY_REPLY_LINES'), 5);
    assert.match(promptFor([]), /回答控制在 5 行以內/);
  });
});

/* ========================================================================== */
describe('一次性遷移與安裝（installAdr013）', () => {

  test('餐飲→飲食：只改 category 那一格；可重複執行，第二次一列都不改', () => {
    const e = env({ sheets: { expenses: new FakeSheet('expenses', [
      ['id', 'expense_date', 'type', 'category', 'amount', 'note'],
      ['1', '2026-09-01', 'expense', '餐飲', 120, 'test'],
      ['2', '2026-09-02', 'expense', '交通', 50, ''],
      ['3', '2026-09-03', 'expense', ' 餐飲 ', 80, '午餐']
    ]) } });
    assert.equal(e.call('migrateExpenseDiningToFood').changed, 2);
    const recs = e.sheets.expenses.toRecords();
    assert.deepEqual(recs.map((r) => r.category), ['飲食', '交通', '飲食']);
    assert.deepEqual(recs.map((r) => r.note), ['test', '', '午餐'], '其他欄一格都沒動');
    assert.equal(e.call('migrateExpenseDiningToFood').changed, 0);
    assert.ok(e.transactions.some((t) => /餐飲→飲食：2 列/.test(t[3])), '有改要留 logs');
  });

  test('installAdr013：補欄位、建設定表、遷移；重跑不重複補欄', () => {
    const e = env({ sheets: { expenses: new FakeSheet('expenses', [
      ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'line_id'],
      ['1', '2026-09-01', 'expense', '餐飲', 120, '', ME]
    ]) } });
    const out = e.call('installAdr013');
    assert.deepEqual(out.columns.added, ['subcategory', 'targets', 'plan_id', 'plan_seq']);
    assert.equal(out.migrated, 1);
    assert.equal(out.config_ok, true);
    assert.ok(e.ss.getSheetByName('_expense_config'));
    // Neil 在 Sheet 上改過設定之後再跑一次 install：他改的東西不能被初版蓋回去
    const cfgSheet = e.ss.getSheetByName('_expense_config');
    cfgSheet.values = [CONFIG_HEADERS, ['category', '吃的', '', '', '', 'c1', 1, '']];
    e.call('installAdr013');
    assert.deepEqual(cfgSheet.values, [CONFIG_HEADERS, ['category', '吃的', '', '', '', 'c1', 1, '']]);
    assert.deepEqual(e.sheets.expenses.values[0],
      ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'line_id', 'subcategory', 'targets', 'plan_id', 'plan_seq']);
  });
});

/* ========================================================================== */
describe('boot 帶分類設定', () => {

  const BOOT_SHEETS = () => ({
    tasks: new FakeSheet('tasks', [['id', 'text', 'line_id', 'del']]),
    reviews: new FakeSheet('reviews', [['review_date', 'line_id', 'del']]),
    moods: new FakeSheet('moods', [['id', 'level', 'line_id', 'del']]),
    notes: new FakeSheet('notes', [['id', 'text', 'line_id', 'del']])
  });

  test('有記帳權限 → expense_config 跟著回來（不帶 warnings），試算表仍只開一次', () => {
    const e = env({ sheets: BOOT_SHEETS() });
    post(e, { action: 'session', token: TOK_MOM });          // 暖快取：裝置與名單（比照 ADR-012 的量法）
    e.counters.opens = 0;
    const out = post(e, { action: 'boot', token: TOK_MOM }); // 一般成員：不查效能筆數
    assert.equal(e.counters.opens, 1, '分類設定要用 boot 開好的那一個 ss');
    assert.equal(out.expense_config.categories[0].name, '飲食');
    assert.equal('warnings' in out.expense_config, false);
  });

  test('沒有記帳權限 → 不帶分類設定', () => {
    const e = loadCodeGs({
      cache: true, extraFiles: ['line-router.gs'], tokens: { 'tok-mom': MOM },
      sheets: Object.assign({ line_users: roster(''), expenses: new FakeSheet('expenses', [EXP_HEADERS]),
        logs: new FakeSheet('logs', [['id']]) }, BOOT_SHEETS())
    });
    const out = JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify({ action: 'boot', token: 'tok-mom' }) } }).body);
    assert.ok(out.denied.includes('expenses'));
    assert.equal('expense_config' in out, false);
  });
});

/* ========================================================================== */
describe('前端：細項、對象、分期欄位', () => {

  function seed() {
    const g = loadCodeGs();
    return { source: 'builtin', categories: g.call('parseExpenseConfig_', g.call('expenseConfigSeedRecords_')).categories };
  }
  function fe() {
    const e = loadFrontend();
    e.callRaw('applyExpenseConfig', e.context.JSON.parse(JSON.stringify(seed())));
    return e;
  }
  /** 讓同一個 id 每次拿到同一個假元素，表單的值才讀得回來 */
  function stableDom(e) {
    const els = {};
    const doc = e.context.document;
    const orig = doc.getElementById;
    const get = (id) => els[id] || (els[id] = orig(id));
    e.set('document', Object.assign({}, doc, { getElementById: get }));
    e.set('scrollTo', () => {});               // editExpense 會捲回頂端；假瀏覽器沒有這支
    return new Proxy(els, { get: (_t, id) => get(id) });
  }
  const cloudRow = (over = {}) => Object.assign({
    id: '1', expense_date: '2026-10-05', type: 'expense', category: '教育', amount: 3000, note: '鋼琴',
    created_at: '2026-10-05T00:00:00.000Z', line_id: ME, board: '',
    subcategory: '才藝', targets: '姐姐,妹妹', plan_id: 'P1', plan_seq: '3/12'
  }, over);

  test('雲端 → App → 雲端：四個新欄位原樣帶回（upsert 是整列覆寫，漏一個就被清掉）', () => {
    const e = fe();
    const local = e.call('expenseFromCloud', cloudRow());
    assert.equal(local.subcategory, '才藝');
    assert.deepEqual(local.targets, ['姐姐', '妹妹']);
    const back = e.call('expenseToCloud', local);
    assert.equal(back.subcategory, '才藝');
    assert.equal(back.targets, '姐姐,妹妹');
    assert.equal(back.plan_id, 'P1');
    assert.equal(back.plan_seq, '3/12');
  });

  test('舊資料（沒有新欄位）讀得進來：未細分、沒有對象；「餐飲」顯示成飲食', () => {
    const e = fe();
    const old = e.call('expenseFromCloud', { id: '2', expense_date: '2026-10-01', type: 'expense', category: '餐飲', amount: 120, note: '', created_at: '2026-10-01T00:00:00.000Z' });
    assert.equal(old.category, '飲食');
    assert.equal(old.subcategory, '');
    assert.deepEqual(old.targets, []);
    assert.equal(e.call('isUnsorted', old), true, '飲食有細項可選，這筆沒選');
    assert.equal(e.call('isUnsorted', Object.assign({}, old, { category: '日常用品' })), false, '沒有細項的大類無從細分');
  });

  test('設定還沒載入時，分類名原樣保留（不把每一筆都改成「其他」）', () => {
    const e = loadFrontend();
    assert.equal(e.call('expenseFromCloud', cloudRow({ category: '教育' })).category, '教育');
  });

  test('甜甜圈與月小計仍以大類計算：細項不同的帳併在同一個大類', () => {
    const e = fe();
    e.raw('state.expenses = [' +
      '{id:1,date:"2026-10-01",type:"expense",category:"飲食",subcategory:"外食",targets:[],amount:300,ts:1,line_id:""},' +
      '{id:2,date:"2026-10-02",type:"expense",category:"飲食",subcategory:"",targets:[],amount:100,ts:2,line_id:""},' +
      '{id:3,date:"2026-10-03",type:"expense",category:"教育",subcategory:"學費",targets:["姐姐"],amount:50,ts:3,line_id:""}]');
    assert.deepEqual(e.call('categoryBreakdown', '2026-10'), [{ cat: '飲食', amount: 400 }, { cat: '教育', amount: 50 }]);
    assert.equal(e.call('monthTotal', '2026-10', 'expense'), 450);
  });

  test('新增一筆：選的細項與對象跟著送上雲端', () => {
    const e = fe();
    const els = stableDom(e);
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; renderExpenseView = function(){}');
    e.call('pickExpCategory', '教育');
    e.call('pickExpSub', '才藝');
    e.call('toggleExpTarget', '姐姐');
    e.call('toggleExpTarget', '妹妹');
    els.expAmount.value = '3000';
    els.expDate.value = '2026-10-05';
    els.expNote.value = '鋼琴';
    e.call('submitExpense');
    const job = e.read('outbox').find((j) => j.sheet === 'expenses');
    assert.ok(job, '要有一筆待送');
    assert.equal(job.record.category, '教育');
    assert.equal(job.record.subcategory, '才藝');
    assert.equal(job.record.targets, '姐姐,妹妹');
  });

  test('換大類：細項清掉、對象只留新大類也能選的', () => {
    const e = fe();
    stableDom(e);
    e.call('pickExpCategory', '家庭');
    e.call('toggleExpTarget', '媽媽');
    e.call('pickExpCategory', '醫療');
    assert.deepEqual(e.read('expTargets'), ['媽媽'], '家庭→醫療都是家人，對象留著');
    e.call('pickExpCategory', '交通');
    e.call('pickExpSub', '加油');
    assert.deepEqual(e.read('expTargets'), [], '交通的對象是車輛，家人清掉');
    e.call('pickExpCategory', '飲食');
    assert.equal(e.read('expSub'), null, '細項屬於某個大類，換了就清');
  });

  test('編輯舊帳：停用的細項與分期欄位都保住，按儲存不會被清掉', () => {
    const e = fe();
    const els = stableDom(e);
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; renderExpenseView = function(){}');
    e.raw('state.expenses = [{id:7,date:"2026-10-01",type:"expense",category:"飲食",subcategory:"已停用的細項",targets:[],' +
      'plan_id:"P9",plan_seq:"2/6",amount:500,note:"",ts:1,line_id:"' + ME + '"}]');
    e.call('editExpense', 7);
    assert.equal(e.read('expSub'), '已停用的細項');
    els.expAmount.value = '600';
    e.call('submitExpense');
    const job = e.read('outbox').find((j) => j.sheet === 'expenses');
    assert.equal(job.record.amount, 600);
    assert.equal(job.record.subcategory, '已停用的細項');
    assert.equal(job.record.plan_id, 'P9');
    assert.equal(job.record.plan_seq, '2/6');
  });

  test('Sheet 上的名稱一律跳脫，不拼進 onclick 字串', () => {
    const e = loadFrontend();
    const els = stableDom(e);
    e.callRaw('applyExpenseConfig', e.context.JSON.parse(JSON.stringify({ categories: [
      { name: `x'"<b>`, color: 'c1', active: true, aliases: [], subs: [], targets: [], target_group: '' }] })));
    e.call('renderCatRow');
    assert.doesNotMatch(els.expCatRow.innerHTML, /<b>/);
    assert.match(els.expCatRow.innerHTML, /onclick="pickExpCategory\(this\.dataset\.val\)"/);
  });

  test('設定的形狀不對就不收，留著上一份', () => {
    const e = fe();
    assert.equal(e.call('applyExpenseConfig', { categories: [] }), false);
    assert.equal(e.call('applyExpenseConfig', null), false);
    assert.equal(e.call('expenseCategories').length, 8);
  });
});

/* ========================================================================== */
describe('前端接真的 Code.gs：boot 一趟，分類設定與資料一起到', () => {

  test('雲端的「餐飲」舊帳在 App 上是飲食，細項選單來自設定', async () => {
    const g = env({ sheets: {
      tasks: new FakeSheet('tasks', [['id', 'text', 'line_id', 'del']]),
      reviews: new FakeSheet('reviews', [['review_date', 'line_id', 'del']]),
      moods: new FakeSheet('moods', [['id', 'level', 'line_id', 'del']]),
      notes: new FakeSheet('notes', [['id', 'text', 'line_id', 'del']]),
      expenses: new FakeSheet('expenses', [EXP_HEADERS,
        ['5', '2026-10-01', 'expense', '餐飲', 120, '', '2026-10-01T00:00:00.000Z', ME, '', '', '', '', '']])
    } });
    const e = loadFrontend({
      fetchImpl: ({ body }) => {
        const out = g.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({}, body, { token: TOK_ME })) } }).body;
        return { json: () => Promise.resolve(JSON.parse(out)) };
      }
    });
    e.raw('deviceToken = "' + TOK_ME + '"; localOnly = false; applyIdentity = function(){}');
    await e.callRaw('startSession', 'cold');
    assert.equal(e.read('state.expenses[0].category'), '飲食');
    assert.deepEqual(e.read('expenseCategory("飲食").subs'), ['外食', '買菜', '冷凍', '常備食材']);
    assert.equal(e.call('catColor', '教育'), 'var(--c8)');
  });
});
