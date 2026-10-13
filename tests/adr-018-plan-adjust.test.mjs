/**
 * ADR-018 PR-E（E-1～E-3）— 分期調整
 *
 * 盯的事（為什麼）：
 *   - 以「今天」為界：expense_date ≤ 今天的各期一個字都不動；未到期的軟刪除後重建（每月 1 號、取整、零頭最後、
 *     plan_seq 接著已到期的編號）
 *   - 每期金額留白＝原本的剩餘總額均分；有填＝每期都是這個數、剩餘總額＝每期 × 期數（Neil 2026-10-13）
 *   - 計畫總額＝已到期＋新剩餘；periods、card、per_amount 跟著更新；寫 logs
 *   - 預覽（dry_run）與真的寫入走同一份純函式：預覽說 1,586、存進去就是 1,586
 *   - 手動改過的未到期期會被覆蓋——預覽要講「有 N 期手動改過」（per_amount 欄記著每期應該是多少，Neil 2026-10-13）
 *   - 只改卡片（剩餘期數留白）不重建各期
 *   - 重複送出同一份不會多建一套；只有管理者或計畫建立者能調
 *   - 前端：分期列「第 N／M 期・剩 K 期 NT$ …・卡片」；確認前要先預覽、改了數字要重新預覽
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const KID = 'Ukid';
const TOK = { [ME]: 'tok-neil', [MOM]: 'tok-mom', [KID]: 'tok-kid' };
const TODAY = '2026-10-13';
const H = ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del', 'board',
  'subcategory', 'targets', 'plan_id', 'plan_seq'];
const FEATS = ['feat_expense', 'feat_tasks', 'feat_notes'];

const exp = (id, amount, over = {}) => {
  const r = Object.assign({ id, expense_date: '2026-06-15', type: 'expense', category: '購物', amount, note: '筆電',
    created_at: '2026-06-15T00:00:00.000Z', line_id: ME, del: '', board: '', subcategory: '', targets: '', plan_id: '', plan_seq: '' }, over);
  return H.map((h) => r[h]);
};

function env({ rows = [exp('1', 23800)] } = {}) {
  return loadCodeGs({
    cache: true, extraFiles: ['line-router.gs'],
    tokens: { [TOK[ME]]: ME, [TOK[MOM]]: MOM, [TOK[KID]]: KID },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
        [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
        [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map(() => 'TRUE')),
        [KID, '小孩', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
      ]),
      expenses: new FakeSheet('expenses', [H].concat(rows)),
      logs: new FakeSheet('logs', [['id']])
    }
  });
}
const post = (e, body, who = ME) =>
  JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: TOK[who] }, body)) } }).body);
const create = (e, over = {}, who = ME) => post(e, Object.assign({ action: 'planCreate', expense_id: '1', periods: 12 }, over), who);
const adjust = (e, planId, over = {}, who = ME) =>
  post(e, Object.assign({ action: 'planAdjust', plan_id: planId, today: TODAY, trigger: 'write' }, over), who);
const periodsOf = (e, planId) => e.sheets.expenses.toRecords().filter((r) => r.plan_id === planId && r.plan_seq);
const live = (e, planId) => periodsOf(e, planId).filter((r) => r.del !== 'TRUE');
const plan = (e, planId) => e.sheets.installments.toRecords().find((p) => p.plan_id === planId);

/** 23,800／12 期，6/15 建 → 7/1 起每月 1 號；今天 10/13 → 已到期 4 期（7/1～10/1）、未到期 8 期共 15,868 */
function setup() {
  const e = env();
  const id = create(e).plan_id;
  return { e, id };
}

/* ========================================================================== */
describe('預覽（dry_run）：什麼都不寫', () => {

  test('剩 10 期、每期留白 → 均分原本的剩餘 15,868：1,586 × 9＋最後 1,594；從下個月 1 號起', () => {
    const { e, id } = setup();
    const before = JSON.stringify(e.sheets.expenses.values);
    const r = adjust(e, id, { remaining_periods: 10, dry_run: true });
    assert.equal(r.success, true);
    assert.equal(r.dry_run, true);
    assert.equal(r.remaining_total, 15868);
    assert.equal(r.paid, 4 * 1983);
    assert.equal(r.schedule.length, 10);
    assert.deepEqual(r.schedule.slice(0, 9).map((s) => s.amount), Array(9).fill(1586));
    assert.equal(r.schedule[9].amount, 1594);
    assert.deepEqual([r.schedule[0].date, r.schedule[9].date], ['2026-11-01', '2027-08-01']);
    assert.deepEqual([r.schedule[0].seq, r.schedule[9].seq], ['5／14', '14／14'], '接著已到期的第 4 期編號');
    assert.equal(r.overwritten, 0);
    assert.equal(JSON.stringify(e.sheets.expenses.values), before, 'dry_run 不寫');
  });

  test('未到期有一期被手動改過 → overwritten 1；原本最後一期的零頭不算手動改', () => {
    const { e, id } = setup();
    const rows = e.sheets.expenses.values;
    const nov = rows.findIndex((r) => r[H.indexOf('plan_id')] === id && r[H.indexOf('expense_date')] === '2026-11-01');
    rows[nov][H.indexOf('amount')] = 1500;
    const r = adjust(e, id, { remaining_periods: 8, dry_run: true });
    assert.equal(r.overwritten, 1);
    assert.equal(r.remaining_total, 15868 - 483, '剩餘總額以現在各期的實際金額為準');
  });
});

/* ========================================================================== */
describe('真的調整', () => {

  test('期數增加：已到期 4 期原封不動；未到期 8 期軟刪除、新 10 期；計畫列更新、寫 logs', () => {
    const { e, id } = setup();
    const keptBefore = live(e, id).filter((r) => r.expense_date <= TODAY).map((r) => [r.id, r.amount, r.plan_seq]);
    const r = adjust(e, id, { remaining_periods: 10 });
    assert.equal(r.success, true);
    const now = live(e, id);
    assert.deepEqual(now.filter((r) => r.expense_date <= TODAY).map((r) => [r.id, r.amount, r.plan_seq]), keptBefore);
    const future = now.filter((r) => r.expense_date > TODAY);
    assert.equal(future.length, 10);
    assert.equal(periodsOf(e, id).filter((r) => r.del === 'TRUE').length, 8, '舊的未到期 8 期軟刪除');
    assert.equal(future.reduce((s, r) => s + r.amount, 0), 15868);
    assert.ok(future.every((r) => r.category === '購物' && r.note === '筆電' && r.line_id === ME), '欄位照計畫帶');
    const p = plan(e, id);
    assert.equal(p.total, 23800);
    assert.equal(p.periods, 14);
    assert.equal(p.per_amount, 1586);
    assert.ok(e.transactions.some((t) => t[1] === '成功' && /調整分期/.test(t[2])));
  });

  test('期數減少：剩 4 期 → 3,967 × 4，總額不變', () => {
    const { e, id } = setup();
    adjust(e, id, { remaining_periods: 4 });
    const future = live(e, id).filter((r) => r.expense_date > TODAY);
    assert.deepEqual(future.map((r) => r.amount), [3967, 3967, 3967, 3967]);
    assert.equal(plan(e, id).periods, 8);
  });

  test('有填每期金額：每期都是 2,000、剩餘 12,000、總額＝已繳＋12,000', () => {
    const { e, id } = setup();
    const r = adjust(e, id, { remaining_periods: 6, per_amount: 2000 });
    assert.equal(r.remaining_total, 12000);
    assert.deepEqual(live(e, id).filter((x) => x.expense_date > TODAY).map((x) => x.amount), Array(6).fill(2000));
    assert.equal(plan(e, id).total, 4 * 1983 + 12000);
    assert.equal(plan(e, id).per_amount, 2000);
  });

  test('調整過一次之後再預覽：剛建的那一批不算手動改過（靠 per_amount 判斷）', () => {
    const { e, id } = setup();
    adjust(e, id, { remaining_periods: 10 });
    assert.equal(adjust(e, id, { remaining_periods: 10, dry_run: true }).overwritten, 0);
  });

  test('重複送出同一份：不會多建一套（第二次回 unchanged）', () => {
    const { e, id } = setup();
    adjust(e, id, { remaining_periods: 10 });
    const n = periodsOf(e, id).length;
    const again = adjust(e, id, { remaining_periods: 10 });
    assert.equal(again.success, true);
    assert.equal(again.unchanged, true);
    assert.equal(periodsOf(e, id).length, n, '沒有新增任何列');
    assert.equal(live(e, id).filter((r) => r.expense_date > TODAY).length, 10);
  });

  test('只改卡片（剩餘期數留白）：各期一列都不動', () => {
    const { e, id } = setup();
    const before = JSON.stringify(e.sheets.expenses.values);
    const r = adjust(e, id, { card: '玉山 Pi 卡' });
    assert.equal(r.success, true);
    assert.equal(plan(e, id).card, '玉山 Pi 卡');
    assert.equal(JSON.stringify(e.sheets.expenses.values), before);
  });
});

/* ========================================================================== */
describe('擋下來的情況', () => {

  test('期數不合法、每期金額不合法、全部到期又沒填每期金額', () => {
    const { e, id } = setup();
    assert.equal(adjust(e, id, { remaining_periods: 0, dry_run: true }).error, 'invalid_periods');
    assert.equal(adjust(e, id, { remaining_periods: 121, dry_run: true }).error, 'invalid_periods');
    assert.equal(adjust(e, id, { remaining_periods: 2.5, dry_run: true }).error, 'invalid_periods');
    assert.equal(adjust(e, id, { remaining_periods: 3, per_amount: -1, dry_run: true }).error, 'invalid_per_amount');
    assert.equal(adjust(e, id, { remaining_periods: 3, today: '2027-12-31', dry_run: true }).error, 'nothing_to_split');
    assert.equal(adjust(e, id, { remaining_periods: 20000, dry_run: true }).error, 'invalid_periods');
  });

  test('剩餘金額不夠分（每期至少 1 元）', () => {
    const e = env({ rows: [exp('1', 24)] });
    const id = create(e).plan_id;
    // 10/13 時已到期 4 期（各 2），剩 16 元
    assert.equal(adjust(e, id, { remaining_periods: 17, dry_run: true }).error, 'amount_too_small');
  });

  test('已結束的計畫不能調；找不到計畫', () => {
    const { e, id } = setup();
    post(e, { action: 'planEnd', plan_id: id, today: TODAY, trigger: 'write' });
    assert.equal(adjust(e, id, { remaining_periods: 3 }).error, 'plan_not_active');
    assert.equal(adjust(e, 'P0', { remaining_periods: 3 }).error, 'plan_not_found');
  });

  test('只有管理者或計畫建立者：媽媽建的計畫媽媽能調，小孩不行（連預覽也不行）', () => {
    const e = env({ rows: [exp('1', 23800, { line_id: MOM })] });
    const id = create(e, {}, MOM).plan_id;
    assert.equal(adjust(e, id, { remaining_periods: 10 }, MOM).success, true);
    assert.equal(adjust(e, id, { remaining_periods: 10, dry_run: true }, KID).error, 'forbidden');
    assert.equal(adjust(e, id, { card: 'x' }, KID).error, 'forbidden');
  });
});

/* ========================================================================== */
describe('per_amount 欄', () => {

  test('planCreate 記下每期應付（23,800／12 → 1,983）；「初始化」幫舊表補欄', () => {
    const { e, id } = setup();
    assert.equal(plan(e, id).per_amount, 1983);
    const old = new FakeSheet('installments', [['plan_id', 'source_expense_id', 'total', 'down_payment', 'periods', 'first_date',
      'category', 'subcategory', 'targets', 'note', 'card', 'line_id', 'status', 'created_at', 'ended_at']]);
    const e2 = loadCodeGs({ sheets: { installments: old } });
    e2.call('ensureInstallmentsSheet_');
    assert.equal(old.values[0].at(-1), 'per_amount');
  });

  test('舊計畫沒有 per_amount：照原計畫反推（不會把整批當成手動改過）', () => {
    const { e, id } = setup();
    const v = e.sheets.installments.values;
    v[1][v[0].indexOf('per_amount')] = '';
    assert.equal(adjust(e, id, { remaining_periods: 8, dry_run: true }).overwritten, 0);
  });
});

/* ========================================================================== */
/* 前端                                                                        */
/* ========================================================================== */

function front(handler) {
  const json = (v) => ({ json: () => Promise.resolve(v) });
  const e = loadFrontend({ fetchImpl: ({ body }) => json(handler(body || {}) || { success: true }) });
  e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []; state = EMPTY_STATE()');
  e.raw('roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:"TRUE"}]');
  e.raw('__els = {}');
  e.raw(`document.getElementById = function(id){
    if (!__els[id]) __els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, dataset:{}, style:{},
      classList:{add(){},remove(){},toggle(){},contains:()=>false} };
    return __els[id];
  }`);
  return e;
}
const dkey = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n, 1); const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-01'; };

describe('前端：分期列與調整表單', () => {

  function seeded(e) {
    e.raw('installmentPlans = [{plan_id:"P1", status:"active", total:23800, periods:12, card:"玉山卡", category:"購物", line_id:"' + ME + '"}]');
    const rows = [];
    for (let i = -3; i <= 8; i++) rows.push({ id: 100 + i, date: dkey(i), type: 'expense', category: '購物', amount: 1983,
      plan_id: 'P1', plan_seq: (i + 4) + '／12', line_id: ME, ts: 1 });
    e.raw('state.expenses = ' + JSON.stringify(rows));
  }

  test('分期列：第 N／M 期・剩 K 期 NT$ …・卡片', () => {
    const e = front(() => null);
    seeded(e);
    const html = e.call('planRowsHtml', e.read('installmentPlans'), '');
    assert.match(html, /第 4／12 期・剩 8 期 NT\$ 15,864・玉山卡/);
    assert.match(html, /調整計畫/);
  });

  test('不是管理者也不是建立者：看得到，沒有「調整計畫」', () => {
    const e = front(() => null);
    seeded(e);
    e.raw('roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:""}]; installmentPlans[0].line_id = "' + MOM + '"');
    assert.doesNotMatch(e.call('planRowsHtml', e.read('installmentPlans'), ''), /調整計畫/);
  });

  test('預覽走雲端 dry_run（帶 trigger）；畫出各期、剩餘總額、手動改過的提示；改了數字要重新預覽', async () => {
    const e = front((b) => (b.action === 'planAdjust' && b.dry_run
      ? { success: true, dry_run: true, remaining_total: 15864, paid: 7932, overwritten: 2,
          schedule: [{ seq: '5／14', date: '2026-11-01', amount: 1586 }] }
      : b.action === 'planAdjust' ? { success: true, created: 10, deleted: 8 } : null));
    seeded(e);
    e.call('openPlanAdjust', 'P1');
    e.raw('document.getElementById("adjPeriods").value = "10"; document.getElementById("adjPer").value = ""; document.getElementById("adjCard").value = "玉山卡"');
    await e.callRaw('previewPlanAdjust');
    const sent = e.calls.map((c) => c.body).filter((b) => b && b.action === 'planAdjust');
    assert.equal(sent[0].dry_run, true);
    assert.equal(sent[0].trigger, 'manual');
    assert.equal(sent[0].remaining_periods, 10);
    const box = e.call('planRowsHtml', e.read('installmentPlans'), '');
    assert.match(box, /剩餘總額 NT\$ 15,864/);
    assert.match(box, /有 2 期手動改過，會被覆蓋/);
    assert.match(box, /確認調整/);

    e.raw('document.getElementById("adjPeriods").value = "9"');
    await e.callRaw('confirmPlanAdjust');
    assert.equal(e.calls.map((c) => c.body).filter((b) => b && b.action === 'planAdjust' && !b.dry_run).length, 0);
    assert.ok(e.toasts.some((t) => /重新預覽|再按一次「預覽」/.test(t)));

    e.raw('document.getElementById("adjPeriods").value = "10"');
    await e.callRaw('previewPlanAdjust');
    await e.callRaw('confirmPlanAdjust');
    const real = e.calls.map((c) => c.body).filter((b) => b && b.action === 'planAdjust' && !b.dry_run);
    assert.equal(real.length, 1);
    assert.equal(real[0].trigger, 'write');
  });

  test('只改卡片：剩餘期數留白就直接送（不用預覽，各期不動）', async () => {
    const e = front(() => null);
    seeded(e);
    e.call('openPlanAdjust', 'P1');
    e.raw('document.getElementById("adjPeriods").value = ""; document.getElementById("adjPer").value = ""; document.getElementById("adjCard").value = "國泰 CUBE"');
    await e.callRaw('confirmPlanAdjust');
    const real = e.calls.map((c) => c.body).filter((b) => b && b.action === 'planAdjust');
    assert.equal(real.length, 1);
    assert.equal(real[0].card, '國泰 CUBE');
    assert.equal('remaining_periods' in real[0], false);
  });
});
