/**
 * ADR-013 PR-B — 分期（交棒票 T4）
 *
 * 盯的事：
 *   - 拆期：整數、零頭放最後一期、下個月起每月 1 號、頭期在原日期（票面三組數字）
 *   - 原本那筆軟刪除並帶 plan_id；連按兩次只產生一套
 *   - planDelete：所有期軟刪除、原本那筆恢復（可以再轉一次）
 *   - planEnd：只刪今天之後的期數
 *   - 收入、已經是分期的列不能轉；沒記帳權限的不能動；PWA 不能直接 upsert 計畫表
 *   - plan_seq 不會被 Sheet 當成日期（全形斜線）
 *   - 前端：預覽走雲端 dry_run（拆期算法只有一份）、待送佇列有這筆時不准轉、計畫現況的計算
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const TOK_ME = 'tok-neil';
const TOK_MOM = 'tok-mom';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'];
const H = ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del', 'board',
  'subcategory', 'targets', 'plan_id', 'plan_seq'];

function roster(momExpense = 'TRUE') {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
    [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
    [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map((f) => (f === 'feat_expense' ? momExpense : 'TRUE')))
  ]);
}
const exp = (id, amount, over = {}) => {
  const r = Object.assign({ id, expense_date: '2026-10-15', type: 'expense', category: '其他', amount, note: '25hoon',
    created_at: '2026-10-15T00:00:00.000Z', line_id: ME, del: '', board: '', subcategory: '', targets: '姐姐', plan_id: '', plan_seq: '' }, over);
  return H.map((h) => r[h]);
};

function env({ rows = [exp('1', 23800)], users = roster(), headers = H } = {}) {
  return loadCodeGs({
    cache: true, extraFiles: ['line-router.gs'],
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    sheets: {
      line_users: users,
      expenses: new FakeSheet('expenses', [headers].concat(rows)),
      logs: new FakeSheet('logs', [['id']])
    }
  });
}
const post = (e, body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: TOK_ME }, body)) } }).body);
const create = (e, over = {}) => post(e, Object.assign({ action: 'planCreate', expense_id: '1', periods: 12 }, over));
const live = (e) => e.sheets.expenses.toRecords().filter((r) => r.del !== 'TRUE');
const periodsOf = (e, planId) => e.sheets.expenses.toRecords().filter((r) => r.plan_id === planId && r.plan_seq);

/* ========================================================================== */
describe('拆期（票面三組數字）', () => {

  test('27,000／12 期 → 12 筆各 2,250，下個月起每月 1 號', () => {
    const e = env({ rows: [exp('1', 27000)] });
    const out = create(e);
    assert.equal(out.success, true);
    const rows = periodsOf(e, out.plan_id);
    assert.equal(rows.length, 12);
    assert.ok(rows.every((r) => r.amount === 2250));
    assert.deepEqual(rows.map((r) => r.expense_date).slice(0, 4), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'], '跨年要接得上');
    assert.equal(rows[11].expense_date, '2027-10-01');
    assert.deepEqual(rows.map((r) => r.plan_seq).slice(0, 2), ['1／12', '2／12']);
  });

  test('23,800／12 期 → 前 11 期 1,983，零頭放最後一期 1,987，加起來剛好是總額', () => {
    const e = env();
    const rows = periodsOf(e, create(e).plan_id);
    assert.deepEqual(rows.slice(0, 11).map((r) => r.amount), Array(11).fill(1983));
    assert.equal(rows[11].amount, 1987);
    assert.equal(rows.reduce((s, r) => s + r.amount, 0), 23800);
  });

  test('頭期 9,000＋10 期（總額 27,000）→ 頭期在原日期，其餘 1,800×10', () => {
    const e = env({ rows: [exp('1', 27000)] });
    const rows = periodsOf(e, create(e, { periods: 10, down_payment: 9000 }).plan_id);
    assert.equal(rows.length, 11);
    assert.deepEqual([rows[0].plan_seq, rows[0].expense_date, rows[0].amount], ['頭期', '2026-10-15', 9000]);
    assert.ok(rows.slice(1).every((r) => r.amount === 1800));
    assert.equal(rows[1].expense_date, '2026-11-01');
  });

  test('各期帶著原本那筆的欄位（分類、細項、對象、備註、歸屬）；釘白板不跟著複製', () => {
    const e = env({ rows: [exp('1', 1200, { category: '教育', subcategory: '學費', board: 'TRUE' })] });
    const r = periodsOf(e, create(e, { periods: 3 }).plan_id)[0];
    assert.deepEqual([r.category, r.subcategory, r.targets, r.note, r.line_id, r.type], ['教育', '學費', '姐姐', '25hoon', ME, 'expense']);
    assert.equal(r.board, '');
    assert.notEqual(r.id, '1');
  });

  test('plan_seq 用全形斜線：「3／12」寫進 Sheet 不會被當成 3 月 12 日', () => {
    const e = env();
    const seqs = periodsOf(e, create(e).plan_id).map((r) => r.plan_seq);
    assert.ok(seqs.every((s) => /^\d+／\d+$/.test(s)), seqs.join(','));
  });
});

/* ========================================================================== */
describe('planCreate：寫計畫、軟刪除原本那筆、只產生一套', () => {

  test('計畫列寫進 installments；原本那筆 del=TRUE 並帶 plan_id；live 的總額不變', () => {
    const e = env();
    const out = create(e, { card: '國泰' });
    const plan = e.sheets.installments.toRecords()[0];
    assert.deepEqual([plan.plan_id, plan.source_expense_id, plan.total, plan.periods, plan.first_date, plan.card, plan.status, plan.line_id],
      [out.plan_id, '1', 23800, 12, '2026-11-01', '國泰', 'active', ME]);
    const src = e.sheets.expenses.toRecords().find((r) => r.id === '1');
    assert.deepEqual([src.del, src.plan_id, src.plan_seq], ['TRUE', out.plan_id, '']);
    assert.equal(live(e).reduce((s, r) => s + r.amount, 0), 23800, '轉分期不改變總花費，只改變落在哪個月');
    assert.ok(e.transactions.some((t) => t[0] === '記帳' && t[1] === '成功' && /已建立/.test(t[3])));
  });

  test('連按兩次只產生一套：第二次回「已經轉過」，一列都不多寫', () => {
    const e = env();
    assert.equal(create(e).success, true);
    const n = e.sheets.expenses.values.length;
    assert.equal(create(e).error, 'expense_not_found', '原本那筆已軟刪除，第二次找不到它');
    assert.equal(e.sheets.expenses.values.length, n);
    assert.equal(e.sheets.installments.toRecords().length, 1);
  });

  test('鎖被佔用（另一個分期正在跑）→ busy，什麼都不寫', () => {
    const e = env();
    e.lock.busy = true;
    assert.equal(create(e).error, 'busy');
    assert.equal(e.ss.getSheetByName('installments'), null);
  });

  test('dry_run：回傳拆期結果，一格都不寫', () => {
    const e = env();
    const before = JSON.stringify(e.sheets.expenses.values);
    const out = create(e, { dry_run: true });
    assert.equal(out.dry_run, true);
    assert.equal(out.schedule.length, 12);
    assert.equal(out.schedule[11].amount, 1987);
    assert.equal(JSON.stringify(e.sheets.expenses.values), before);
    assert.equal(e.ss.getSheetByName('installments'), null);
  });

  const rejects = {
    '收入不能轉': [{ rows: [exp('1', 5000, { type: 'income' })] }, {}, 'not_an_expense'],
    '已經是分期的列不能再轉': [{ rows: [exp('1', 2000, { plan_id: 'P1', plan_seq: '1／12' })] }, {}, 'already_planned'],
    '期數 1 不算分期': [{}, { periods: 1 }, 'invalid_periods'],
    '期數不是整數': [{}, { periods: 2.5 }, 'invalid_periods'],
    '期數超過上限': [{}, { periods: 121 }, 'invalid_periods'],
    '頭期款不小於總額': [{}, { down_payment: 23800 }, 'invalid_down_payment'],
    '頭期款負數': [{}, { down_payment: -1 }, 'invalid_down_payment'],
    '每期不到 1 元': [{ rows: [exp('1', 5)] }, { periods: 6 }, 'amount_too_small'],
    '找不到這筆': [{}, { expense_id: '999' }, 'expense_not_found'],
    '已刪除的那筆': [{ rows: [exp('1', 2000, { del: 'TRUE' })] }, {}, 'expense_not_found'],
    '還沒跑初始化（缺 plan 欄）': [{ headers: H.slice(0, 10), rows: [exp('1', 2000).slice(0, 10)] }, {}, 'columns_missing']
  };
  for (const [name, [opts, body, code]] of Object.entries(rejects)) {
    test(name + ' → ' + code + '，什麼都不寫', () => {
      const e = env(opts);
      const before = JSON.stringify(e.sheets.expenses.values);
      assert.equal(create(e, body).error, code);
      assert.equal(JSON.stringify(e.sheets.expenses.values), before);
      assert.equal(e.ss.getSheetByName('installments'), null);
    });
  }

  test('沒有記帳權限 → forbidden，寫 logs', () => {
    const e = env({ users: roster('') });
    assert.equal(create(e, { token: TOK_MOM }).error, 'forbidden');
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && /planCreate/.test(t[2])));
  });

  test('PWA 不能直接 upsert／讀 installments 以外的路改計畫表', () => {
    const e = env();
    create(e);
    assert.equal(post(e, { action: 'upsert', sheet: 'installments', record: { plan_id: 'x' } }).error, 'sheet_not_writable');
  });
});

/* ========================================================================== */
describe('planDelete／planEnd', () => {

  test('planDelete：所有期軟刪除、計畫標 deleted、原本那筆恢復（清掉 plan_id，可以再轉一次）', () => {
    const e = env();
    const { plan_id } = create(e, { down_payment: 800 });
    const out = post(e, { action: 'planDelete', plan_id });
    assert.deepEqual([out.success, out.deleted, out.restored], [true, 13, 1]);
    assert.ok(periodsOf(e, plan_id).every((r) => r.del === 'TRUE'));
    const src = e.sheets.expenses.toRecords().find((r) => r.id === '1');
    assert.deepEqual([src.del, src.plan_id], ['', '']);
    assert.deepEqual(live(e).map((r) => r.id), ['1'], '回到轉分期之前的樣子');
    assert.equal(e.sheets.installments.toRecords()[0].status, 'deleted');

    assert.equal(create(e).success, true, '恢復之後可以重新轉');
    assert.equal(post(e, { action: 'planDelete', plan_id }).error, 'plan_already_deleted');
  });

  test('planEnd：只刪今天之後的期數，已到期的保留；計畫標 ended；之後不能再結束一次', () => {
    const e = env();
    const { plan_id } = create(e);
    const out = post(e, { action: 'planEnd', plan_id, today: '2027-01-15' });
    assert.deepEqual([out.removed, out.kept], [9, 3], '11/1、12/1、1/1 已到期');
    const rows = periodsOf(e, plan_id);
    assert.deepEqual(rows.filter((r) => r.del !== 'TRUE').map((r) => r.expense_date), ['2026-11-01', '2026-12-01', '2027-01-01']);
    assert.equal(e.sheets.installments.toRecords()[0].status, 'ended');
    assert.equal(e.sheets.expenses.toRecords().find((r) => r.id === '1').del, 'TRUE', '原本那筆維持軟刪除');
    assert.equal(post(e, { action: 'planEnd', plan_id }).error, 'plan_not_active');
  });

  test('planEnd 的「今天」本身不算之後：當天那期保留', () => {
    const e = env();
    const { plan_id } = create(e);
    assert.equal(post(e, { action: 'planEnd', plan_id, today: '2026-11-01' }).kept, 1);
  });

  test('改某一期走一般 upsert，不影響計畫與其他期', () => {
    const e = env();
    const { plan_id } = create(e);
    const one = periodsOf(e, plan_id)[0];
    post(e, { action: 'upsert', sheet: 'expenses', record: Object.assign({}, one, { amount: 2000 }) });
    const after = periodsOf(e, plan_id);
    assert.equal(after[0].amount, 2000);
    assert.equal(after[0].plan_seq, '1／12', '前端整列帶回，plan_seq 不會被洗掉');
    assert.equal(after[1].amount, 1983);
    assert.equal(e.sheets.installments.toRecords()[0].total, 23800, '不回寫計畫（D-8）');
  });

  test('找不到計畫、沒有權限', () => {
    const e = env({ users: roster('') });
    assert.equal(post(e, { action: 'planEnd', plan_id: 'P0' }).error, 'plan_not_found');
    assert.equal(post(e, { action: 'planDelete', plan_id: 'P0', token: TOK_MOM }).error, 'forbidden');
  });
});

/* ========================================================================== */
describe('boot／readMany 帶計畫列', () => {

  test('有記帳權限 → installments（不含已刪除的計畫）；沒有權限 → 不帶', () => {
    const e = env();
    const a = create(e).plan_id;
    e.sheets.expenses.values.push(exp('2', 6000));
    const b = create(e, { expense_id: '2', periods: 3 }).plan_id;
    post(e, { action: 'planDelete', plan_id: b });
    const many = post(e, { action: 'readMany', sheets: ['expenses'] });
    assert.deepEqual(many.installments.map((p) => p.plan_id), [a]);
    const mom = env({ users: roster('') });
    assert.equal('installments' in post(mom, { action: 'readMany', token: TOK_MOM, sheets: ['expenses'] }), false);
  });

  test('installAdr013（「初始化」）會建好 installments 表頭', () => {
    const e = env();
    e.call('installAdr013');
    assert.deepEqual(e.sheets.installments ? e.sheets.installments.values[0] : e.ss.getSheetByName('installments').values[0],
      e.read('INSTALLMENTS_HEADERS'));
  });
});

/* ========================================================================== */
describe('前端', () => {

  function fe(fetchImpl) {
    const e = loadFrontend({ fetchImpl });
    const els = {};
    const orig = e.context.document.getElementById;
    const get = (id) => els[id] || (els[id] = orig(id));
    e.set('document', Object.assign({}, e.context.document, { getElementById: get }));
    e.set('scrollTo', () => {});
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; renderExpenseView = function(){}');
    return { e, els: new Proxy(els, { get: (_t, id) => get(id) }) };
  }
  const row = (o) => JSON.stringify(Object.assign({ type: 'expense', category: '其他', subcategory: '', targets: [], note: '',
    ts: 1, line_id: ME, plan_id: '', plan_seq: '' }, o));

  test('期數顯示：雲端的全形「3／12」→「第 3/12 期」；頭期照寫', () => {
    const { e } = fe();
    assert.equal(e.call('planSeqLabel', '3／12'), '第 3/12 期');
    assert.equal(e.call('planSeqLabel', '3/12'), '第 3/12 期');
    assert.equal(e.call('planSeqLabel', '頭期'), '頭期');
  });

  test('計畫現況：已到期 N 期、剩 M 期共 X 元、結束日（頭期不算一期）', () => {
    const { e } = fe();
    e.raw('todayKey = function(){ return "2027-01-15"; }');
    e.raw('installmentPlans = [{plan_id:"P1", total:23800, status:"active", card:"國泰"}]');
    const periods = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(2026, 10 + i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
      return row({ id: 100 + i, date: key, amount: i === 11 ? 1987 : 1983, plan_id: 'P1', plan_seq: (i + 1) + '／12' });
    });
    e.raw('state.expenses = [' + periods.join(',') + ',' + row({ id: 99, date: '2026-10-15', amount: 800, plan_id: 'P1', plan_seq: '頭期' }) + ']');
    const s = e.call('planSummary', 'P1');
    assert.deepEqual([s.due, s.left, s.leftAmount, s.end, s.total], [3, 9, 1983 * 8 + 1987, '2027-10-01', 23800]);
  });

  test('編輯：支出出現「轉成分期」；收入、分期列不出現；分期列顯示計畫現況與兩個按鈕', () => {
    const { e, els } = fe();
    e.raw('state.expenses = [' + [row({ id: 1, date: '2026-10-15', amount: 500 }), row({ id: 2, date: '2026-10-15', amount: 500, type: 'income' }),
      row({ id: 3, date: '2026-11-01', amount: 1983, plan_id: 'P1', plan_seq: '1／12' })].join(',') + ']');
    e.raw('installmentPlans = [{plan_id:"P1", total:23800, status:"active"}]');
    e.call('editExpense', 1);
    assert.match(els.expPlanBox.innerHTML, /轉成分期/);
    e.call('editExpense', 2);
    assert.equal(els.expPlanBox.innerHTML, '', '收入不能分期');
    e.call('editExpense', 3);
    assert.match(els.expPlanBox.innerHTML, /第 1\/12 期/);
    assert.match(els.expPlanBox.innerHTML, /結束計畫/);
    assert.match(els.expPlanBox.innerHTML, /刪除計畫/);
    assert.doesNotMatch(els.expPlanBox.innerHTML, /轉成分期/, '已經是分期的不能再轉');
  });

  test('預覽問雲端 dry_run（不自己算），確認才送正式的 planCreate', async () => {
    const sent = [];
    const { e, els } = fe(({ body }) => {
      sent.push(body);
      return { json: () => Promise.resolve(body.dry_run
        ? { success: true, dry_run: true, schedule: [{ seq: '1／2', date: '2026-11-01', amount: 250 }, { seq: '2／2', date: '2026-12-01', amount: 250 }] }
        : { success: true, plan_id: 'P9', schedule: [{}, {}] }) };
    });
    e.raw('syncFromCloud = function(){}');
    e.raw('state.expenses = [' + row({ id: 1, date: '2026-10-15', amount: 500 }) + ']');
    e.call('editExpense', 1);
    e.call('openPlanForm');
    els.planPeriods.value = '2';
    await e.callRaw('previewPlan');
    assert.deepEqual([sent[0].action, sent[0].dry_run, sent[0].periods, sent[0].expense_id], ['planCreate', true, 2, '1']);
    assert.match(els.expPlanBox.innerHTML, /第 2\/2 期/);
    assert.match(els.expPlanBox.innerHTML, /確認轉成分期/);
    await e.callRaw('confirmPlan');
    assert.equal(sent[1].dry_run, undefined, '正式送出不帶 dry_run');
    assert.equal(e.read('expEditingId'), null, '送出後表單收起');
  });

  test('預覽之後改了期數 → 確認被擋下，要求重新預覽（不送沒看過的拆法）', async () => {
    const sent = [];
    const { e, els } = fe(({ body }) => {
      sent.push(body);
      return { json: () => Promise.resolve({ success: true, dry_run: true, schedule: [{ seq: '1／2', date: '2026-11-01', amount: 250 }] }) };
    });
    e.raw('state.expenses = [' + row({ id: 1, date: '2026-10-15', amount: 500 }) + ']');
    e.call('editExpense', 1);
    e.call('openPlanForm');
    els.planPeriods.value = '2';
    await e.callRaw('previewPlan');
    els.planPeriods.value = '5';
    await e.callRaw('confirmPlan');
    assert.equal(sent.filter((b) => b.action === 'planCreate' && !b.dry_run).length, 0);
    assert.ok(e.toasts.some((t) => /再按一次「預覽」/.test(t)));
    assert.doesNotMatch(els.expPlanBox.innerHTML, /確認轉成分期/, '舊的預覽收掉');
  });

  test('這筆還有變更排在待送佇列 → 不准轉分期（晚到的 upsert 會把原本那筆救回來，錢算兩次）', async () => {
    const sent = [];
    const { e, els } = fe(({ body }) => { sent.push(body); return { json: () => Promise.resolve({ success: true }) }; });
    e.raw('state.expenses = [' + row({ id: 1, date: '2026-10-15', amount: 500 }) + ']');
    e.raw('outbox = [{sheet:"expenses", key_field:"id", seq:1, record:{id:"1"}}]');
    e.call('editExpense', 1);
    e.call('openPlanForm');
    els.planPeriods.value = '2';
    await e.callRaw('previewPlan');
    await e.callRaw('confirmPlan');
    assert.equal(sent.filter((b) => b.action === 'planCreate').length, 0);
    assert.ok(e.toasts.some((t) => /還有變更沒送上雲端/.test(t)));
  });

  test('雲端拒絕時講人話（例如還沒跑初始化）', async () => {
    const { e, els } = fe(() => ({ json: () => Promise.resolve({ error: 'columns_missing' }) }));
    e.raw('state.expenses = [' + row({ id: 1, date: '2026-10-15', amount: 500 }) + ']');
    e.call('editExpense', 1);
    e.call('openPlanForm');
    els.planPeriods.value = '2';
    await e.callRaw('previewPlan');
    assert.ok(e.toasts.some((t) => /初始化/.test(t)));
  });

  test('列表：分期列標「🧾 第 3/12 期」，未來月份的期數加 ⏳', () => {
    const e = loadFrontend();
    const els = {};
    const orig = e.context.document.getElementById;
    e.set('document', Object.assign({}, e.context.document, { getElementById: (id) => els[id] || (els[id] = orig(id)) }));
    e.raw('todayKey = function(){ return "2026-10-20"; }; expMonth = "2026-11"');
    e.raw('state.expenses = [' + row({ id: 5, date: '2026-11-01', amount: 1983, plan_id: 'P1', plan_seq: '1／12' }) + ']');
    e.call('renderExpenseView');
    assert.match(els.expList.innerHTML, /🧾 第 1\/12 期 ⏳/);
  });

  test('收到 boot／輪詢帶的計畫列；沒有記帳權限時清空', () => {
    const { e } = fe();
    e.raw('applyDenied = function(){}');   // 藏導覽列要真的 DOM；這裡只驗計畫列的去留
    const D = { tasks: [], reviews: [], moods: [], notes: [], expenses: [] };
    e.callRaw('applyCloudData', e.context.JSON.parse(JSON.stringify(D)), [], e.context.JSON.parse(JSON.stringify({ installments: [{ plan_id: 'P1' }] })));
    assert.deepEqual(e.read('installmentPlans').map((p) => p.plan_id), ['P1']);
    e.callRaw('applyCloudData', e.context.JSON.parse(JSON.stringify(D)), e.context.JSON.parse('["expenses"]'), {});
    assert.deepEqual(e.read('installmentPlans'), []);
  });
});
