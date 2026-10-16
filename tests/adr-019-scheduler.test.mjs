/**
 * ADR-019 D-1／D-2（交棒 PR-3）— 排程總管
 *
 * 為什麼有這批測試：「初始化」原本裝 7 種時間觸發器，10/15 12:00 股票規則＋輪詢＋perfFlush 重疊
 * （170／351／150 秒）；GAS「每 N 分鐘」觸發器的起跑時間無法指定，錯開做不到。
 * D-1 改成只留一個每 5 分鐘的總管，依序派工，讓排程之間「不可能重疊」。
 *
 * 盯的事：
 *   - 「該不該跑」是純函式：每日 HH 點後第一輪、每小時、每 N 分、盤中、交易日時間窗＋拿到就停
 *   - 依序執行：股票規則 → 到期提醒 → Gmail → 其他 → 效能落地最後；上一輪沒跑完就直接結束
 *   - 時間預算：用超過約 4 分鐘就不再開始新工作，沒跑的下一輪優先
 *   - 一個工作丟例外，後面的照跑；錯誤寫 logs。超過 30 秒寫 logs。每天第一輪寫一筆心跳
 *   - 「初始化」移除所有舊時間觸發器、只裝總管；跑三次也只有一個；回覆列出登記的工作
 *   - 舊的各自安裝函式已刪（Neil 2026-10-16：只留「初始化」一個入口）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60000;
const HOUR = 3600000;
/** 台北時間 → epoch ms（台灣固定 UTC+8）。2026-10-19 是週一、10-17 是週六 */
const tpe = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
const MON = (h, mi) => tpe(2026, 10, 19, h, mi);

function env(opts = {}) {
  return loadCodeGs(Object.assign({ propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'] }, opts));
}
const due = (e, rule, now, st) => e.call('schedulerDue_', rule, now, st || {});

/* ========================================================================== */
describe('該不該跑（純函式）', () => {

  test('每日 9 點：9 點前不跑、9 點後第一輪跑、同一天不跑第二次、跨日 9 點前不跑', () => {
    const e = env();
    const daily = { kind: 'daily', hour: 9 };
    assert.equal(due(e, daily, MON(8, 59)), false, '8:59 還沒到');
    assert.equal(due(e, daily, MON(9, 0)), true, '9:00 第一輪');
    assert.equal(due(e, daily, MON(9, 5), { last: MON(9, 0) }), false, '同一天跑過了');
    assert.equal(due(e, daily, MON(15, 0), { last: tpe(2026, 10, 18, 9, 0) }), true, '總管停過、下午才回來：照樣補今天的');
    assert.equal(due(e, daily, tpe(2026, 10, 20, 0, 3), { last: MON(23, 58) }), false, '跨日但還沒到 9 點');
    assert.equal(due(e, daily, tpe(2026, 10, 20, 9, 1), { last: MON(9, 0) }), true, '隔天 9 點後');
  });

  test('盤中每輪：週一～五 9:00～13:30', () => {
    const e = env();
    const market = { kind: 'market' };
    assert.equal(due(e, market, MON(10, 0)), true);
    assert.equal(due(e, market, MON(13, 30)), true);
    assert.equal(due(e, market, MON(13, 35)), false);
    assert.equal(due(e, market, MON(8, 55)), false);
    assert.equal(due(e, market, tpe(2026, 10, 17, 10, 0)), false, '週六');
  });

  test('每小時：同一小時只跑一次', () => {
    const e = env();
    const hourly = { kind: 'hourly' };
    assert.equal(due(e, hourly, MON(10, 0)), true);
    assert.equal(due(e, hourly, MON(10, 55), { last: MON(10, 0) }), false);
    assert.equal(due(e, hourly, MON(11, 0), { last: MON(10, 55) }), true);
  });

  test('每 10 分鐘：5 分鐘一輪的總管，隔一輪跑一次（容許觸發器提早 1 分鐘）', () => {
    const e = env();
    const every = { kind: 'every', minutes: 10 };
    assert.equal(due(e, every, MON(10, 0)), true, '沒跑過');
    assert.equal(due(e, every, MON(10, 5), { last: MON(10, 0) }), false);
    assert.equal(due(e, every, MON(10, 0) + 9 * MIN + 30000, { last: MON(10, 0) }), true, '9 分半也算到了');
  });

  test('盤後收盤價：交易日 14～19 點每小時；非交易日、時間窗外、今天已拿到都不跑', () => {
    const e = env();
    const win = { kind: 'trading_hours', from: 14, to: 19 };
    assert.equal(due(e, win, MON(13, 59)), false);
    assert.equal(due(e, win, MON(14, 0)), true);
    assert.equal(due(e, win, MON(14, 30), { last: MON(14, 0) }), false, '同一小時');
    assert.equal(due(e, win, MON(15, 0), { last: MON(14, 0) }), true);
    assert.equal(due(e, win, MON(19, 55), { last: MON(18, 0) }), true, '19 點那次照跑（最後一試）');
    assert.equal(due(e, win, MON(20, 0), { last: MON(19, 0) }), false);
    assert.equal(due(e, win, tpe(2026, 10, 17, 15, 0)), false, '週六');
    assert.equal(due(e, win, MON(16, 0), { last: MON(15, 0), done_day: '2026-10-19' }), false, '今天收盤價已拿到');
    assert.equal(due(e, win, tpe(2026, 10, 20, 14, 0), { last: MON(15, 0), done_day: '2026-10-19' }), true, '隔天重新來');
  });
});

/* ========================================================================== */
describe('一輪怎麼跑', () => {

  /** 用假工作取代登記表；clock 由測試推進，模擬工作耗時 */
  function withJobs(specs, opts = {}) {
    const clock = { t: 0 };
    const ran = [];
    const jobs = specs.map((s) => ({
      name: s.name, label: s.name, when: 'test', rule: s.rule || { kind: 'every', minutes: 5 },
      run: () => { ran.push(s.name); clock.t += s.ms || 0; if (s.throws) throw new Error('模擬：' + s.name + ' 壞了'); return s.result; },
      done: s.done
    }));
    const e = env(Object.assign({ overrides: { schedulerJobs_: () => jobs, schedulerClock_: () => clock.t } }, opts));
    return { e, ran, clock };
  }

  test('依登記表順序執行；跑過的記下時間', () => {
    const { e, ran } = withJobs([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    const out = e.call('runScheduler', MON(10, 0));
    assert.deepEqual(ran, ['a', 'b', 'c']);
    assert.deepEqual(out.ran, ['a', 'b', 'c']);
    const st = JSON.parse(e.properties.sched_state);
    assert.equal(st.jobs.a.last, MON(10, 0));
  });

  test('一個工作丟例外：後面的照跑，錯誤寫 logs', () => {
    const { e, ran } = withJobs([{ name: 'a' }, { name: 'b', throws: true }, { name: 'c' }]);
    const out = e.call('runScheduler', MON(10, 0));
    assert.deepEqual(ran, ['a', 'b', 'c']);
    assert.deepEqual(out.failed, ['b']);
    const t = e.transactions.find((x) => x[0] === '排程' && x[1] === '失敗');
    assert.ok(t, '失敗要寫 logs');
    assert.match(String(t[2]), /b/);
    assert.match(String(t[3] + t[4]), /模擬：b 壞了/);
  });

  test('時間預算用完：剩下的不開始，下一輪優先跑', () => {
    const { e, ran } = withJobs([{ name: 'a', ms: 3 * MIN }, { name: 'b', ms: 2 * MIN }, { name: 'c' }, { name: 'd' }]);
    const out = e.call('runScheduler', MON(10, 0));
    assert.deepEqual(ran, ['a', 'b'], '已用 5 分鐘，超過預算');
    assert.deepEqual(out.skipped, ['c', 'd']);

    ran.length = 0;
    e.call('runScheduler', MON(10, 5));
    assert.deepEqual(ran.slice(0, 2), ['c', 'd'], '上一輪沒跑的先跑');
  });

  test('超過 30 秒的工作寫 logs（工作名、秒數）', () => {
    const { e } = withJobs([{ name: 'fast', ms: 5000 }, { name: 'slow', ms: 31000 }]);
    e.call('runScheduler', MON(10, 0));
    const slow = e.transactions.filter((x) => x[0] === '排程' && x[1] === '慢');
    assert.equal(slow.length, 1);
    assert.match(String(slow[0][2]), /slow/);
    assert.match(String(slow[0][3]), /31 秒/);
  });

  test('上一輪還沒跑完（拿不到鎖）：直接結束，不堆疊', () => {
    const { e, ran } = withJobs([{ name: 'a' }]);
    e.lock.userBusy = true;
    assert.deepEqual(e.call('runScheduler', MON(10, 0)), { skipped: 'busy' });
    assert.deepEqual(ran, []);
  });

  test('每日心跳：每天第一輪寫一筆（昨天幾輪、哪些工作、最慢的是誰）；同一天不再寫', () => {
    const { e } = withJobs([{ name: 'a', ms: 1000 }, { name: 'b', ms: 4000 }]);
    e.call('runScheduler', MON(22, 0));
    e.call('runScheduler', MON(22, 5));
    e.call('runScheduler', MON(22, 10));
    const before = e.transactions.filter((x) => x[0] === '排程' && x[1] === '心跳').length;
    e.call('runScheduler', tpe(2026, 10, 20, 0, 0));
    const beats = e.transactions.filter((x) => x[0] === '排程' && x[1] === '心跳');
    assert.equal(beats.length, before + 1);
    const text = String(beats.at(-1)[3]) + String(beats.at(-1)[4]);
    assert.match(text, /2026-10-19/);
    assert.match(text, /3 輪/);
    assert.match(text, /a×3/);
    assert.match(text, /最慢 b 4 秒/);
    e.call('runScheduler', tpe(2026, 10, 20, 0, 5));
    assert.equal(e.transactions.filter((x) => x[0] === '排程' && x[1] === '心跳').length, before + 1, '同一天只寫一筆');
  });

  test('「拿到就停」：工作回報完成後，今天不再跑', () => {
    const { e, ran } = withJobs([{ name: 'close', rule: { kind: 'trading_hours', from: 14, to: 19 },
      result: { reason: 'done' }, done: (r) => !!r && r.reason === 'done' }]);
    e.call('runScheduler', MON(14, 0));
    e.call('runScheduler', MON(15, 0));
    assert.deepEqual(ran, ['close']);
  });
});

/* ========================================================================== */
describe('登記表：既有的排程全部收進來、順序對', () => {

  test('順序：股票規則 → 到期提醒 → Gmail → 其他 → 效能落地最後', () => {
    const e = env();
    const names = e.read('schedulerJobs_().map(function (j) { return j.name; })');
    assert.equal(names[0], 'stockRules');
    assert.equal(names[1], 'dueCheck');
    assert.equal(names[2], 'gmail');
    assert.equal(names.at(-1), 'perfFlush');
    assert.deepEqual(names.slice().sort(), ['clips', 'dueCheck', 'gmail', 'guide', 'perfFlush', 'stockDaily', 'stockRules', 'unauthFlush']);
  });

  test('實際呼叫的是原本的那幾支函式（行為不變，只是誰叫它變了）', () => {
    const called = [];
    const spy = (name, ret) => (...args) => { called.push(name); return ret; };
    const e = env({ overrides: {
      checkStockRules: spy('checkStockRules'), checkDueReminders: spy('checkDueReminders'),
      runGmailController_: spy('runGmailController_'), refreshGuide: spy('refreshGuide'),
      flushUnauthPerf: spy('flushUnauthPerf'), fetchStockDaily: spy('fetchStockDaily', { reason: 'done' }),
      flushPerfQueue: spy('flushPerfQueue')
    } });
    e.call('runScheduler', MON(10, 0));
    assert.deepEqual(called, ['checkStockRules', 'checkDueReminders', 'runGmailController_', 'refreshGuide', 'flushUnauthPerf', 'flushPerfQueue'],
      '10 點：盤中、9 點後、6 點後；收盤價時間窗還沒開');
    called.length = 0;
    e.call('runScheduler', MON(14, 2));
    assert.deepEqual(called, ['flushUnauthPerf', 'fetchStockDaily', 'flushPerfQueue'], '14 點：收盤後，每日的今天都跑過了');
    called.length = 0;
    e.call('runScheduler', MON(15, 2));
    assert.ok(!called.includes('fetchStockDaily'), '今天的收盤價已拿到（reason=done），不再打證交所');
  });
});

/* ========================================================================== */
describe('「初始化」只裝總管', () => {

  test('移除所有舊時間觸發器、只留一個每 5 分鐘的 runScheduler；跑三次也只有一個', () => {
    const e = env();
    ['checkDueReminders', 'refreshGuide', 'flushUnauthPerf', 'flushPerfQueue', 'checkStockRules', 'fetchStockDaily', 'runGmailController']
      .forEach((fn) => e.read('ScriptApp.newTrigger("' + fn + '").timeBased().everyHours(1).create()'));
    e.call('installScheduler_');
    e.call('installScheduler_');
    const out = e.call('installScheduler_');
    assert.deepEqual(e.triggers.map((t) => t.handler), ['runScheduler']);
    assert.equal(e.triggers[0].everyMinutes, 5);
    assert.equal(out.removed, 1, '第三次只刪掉上一次裝的總管');
  });

  test('初始化的回覆列出登記的工作與總管排程', () => {
    const e = env();
    const step = e.read('initSteps_().filter(function (s) { return /排程總管/.test(s.label); })[0].label');
    assert.match(step, /ADR-019/);
    const text = e.read('initSteps_().filter(function (s) { return /排程總管/.test(s.label); })[0].run().text');
    for (const w of ['到期提醒', 'Gmail', '_guide', '股票提醒規則', '盤後收盤價', '未驗證彙總', '效能紀錄落地']) assert.match(text, new RegExp(w));
    assert.deepEqual(e.triggers.map((t) => t.handler), ['runScheduler']);
    assert.match(e.read('triggerSummary_().join("|")'), /runScheduler（每 5 分鐘/);
  });

  test('原始碼裡建時間觸發器的只有總管；舊的各自安裝函式已刪', () => {
    const files = readdirSync(join(ROOT, 'apps-script')).filter((f) => f.endsWith('.gs'));
    const src = files.map((f) => readFileSync(join(ROOT, 'apps-script', f), 'utf8')).join('\n');
    const creates = src.match(/newTrigger\(/g) || [];
    assert.equal(creates.length, 1, '只有 installScheduler_ 建觸發器');
    for (const gone of ['installAdr009Triggers', 'uninstallAdr009Triggers', 'installGuideTrigger', 'uninstallGuideTrigger',
      'installUnauthTrigger', 'installPerfQueueTrigger', 'installStockTriggers_', 'installGmailTrigger_', 'uninstallGmailController']) {
      assert.doesNotMatch(src, new RegExp('function ' + gone + '\\('), gone + ' 應已刪除');
    }
  });
});
