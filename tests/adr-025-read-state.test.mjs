/**
 * ADR-025（後端）— 圖書館閱讀狀態三態：空白＝未讀／reading＝📖 閱讀中／read＝✅ 已讀
 *
 * 為什麼有這批測試：
 *  - D-2：「點開看過 ≠ 讀完」。開閱讀頁只能把未讀推進成閱讀中；已讀的篇再打開一次**不能被改回閱讀中**
 *    （不然 Neil 標好的已讀每看一次就被洗掉）。判斷要在鎖內依剛重讀的列決定，不能用鎖外讀到的舊值
 *  - D-6：手動設狀態只限擁有者、只收三種值；非法值永久拒絕，拿不到鎖回 busy（前端還原並提示）
 *  - D-3：Reading Widget 未讀數只算空白；閱讀中不算未讀。「上次在讀」照 last_read_at 不變
 *  - D-7：更版後初始化一次性全部回未讀，只跑一次（之後手動調的狀態不能被下次初始化洗掉）、
 *    保留 last_read_at、不碰已刪除的列
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const FEATS = ['feat_tasks', 'feat_notes', 'feat_clips'];
const CLIP_H = ['id', 'line_id', 'url', 'status', 'author', 'caption', 'del', 'updated_at', 'read_status', 'last_read_at'];
const OLD_AT = '2026-10-01T00:00:00.000Z';

const clipRow = (id, o = {}) => {
  const r = Object.assign({ id, line_id: ME, url: 'u' + id, status: 'done', author: 'a', caption: '內文' + id, del: '', updated_at: '', read_status: '', last_read_at: '' }, o);
  return CLIP_H.map((h) => r[h]);
};

function env(clipRows = [], { feats = FEATS, propsWritable = true, properties = {}, init = false } = {}) {
  const sheets = {
    line_users: new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
      [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map((f) => (feats.includes(f) ? 'TRUE' : ''))),
      [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
    ]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'line_id', 'del', 'archive', 'board', 'kind']]),
    notes: new FakeSheet('notes', [['id', 'text', 'line_id', 'del', 'archive', 'board']]),
    expenses: new FakeSheet('expenses', [['id', 'amount', 'line_id', 'del', 'archive', 'board']]),
    logs: new FakeSheet('logs', [['id']]),
    clips: new FakeSheet('clips', [CLIP_H, ...clipRows])
  };
  return loadCodeGs({ tokens: { 'tok-me': ME, 'tok-mom': MOM }, sheets, propsWritable, properties,
    extraFiles: init ? ['line-router.gs', 'sheet-guide.gs'] : [] });
}
const post = (e, body, tok = 'tok-me') =>
  JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
const clips = (e) => e.sheets.clips.toRecords();
const byId = (e, id) => clips(e).find((r) => String(r.id) === id);
const open = (e, id, tok) => post(e, { action: 'clipRead', id, trigger: 'write' }, tok);
const setState = (e, id, state, tok) => post(e, { action: 'clipReadState', id, state, trigger: 'write' }, tok);

/* ========================================================================== */
describe('開閱讀頁（clipRead，D-2）', () => {

  test('未讀 → 閱讀中；閱讀中不變；已讀不會被改回閱讀中；三種都更新 last_read_at', () => {
    const e = env([clipRow('u'), clipRow('r', { read_status: 'reading', last_read_at: OLD_AT }), clipRow('d', { read_status: 'read', last_read_at: OLD_AT })]);
    ['u', 'r', 'd'].forEach((id) => assert.equal(open(e, id).success, true));
    assert.equal(byId(e, 'u').read_status, 'reading');
    assert.equal(byId(e, 'r').read_status, 'reading');
    assert.equal(byId(e, 'd').read_status, 'read', '已讀再打開仍是已讀');
    ['u', 'r', 'd'].forEach((id) => {
      assert.match(String(byId(e, id).last_read_at), /^\d{4}-\d{2}-\d{2}T/);
      assert.notEqual(byId(e, id).last_read_at, OLD_AT);
    });
  });

  test('讀後改在鎖內：鎖外讀到未讀、進鎖前另一台已標已讀 → 照雲端的已讀，不改回閱讀中', () => {
    const e = env([clipRow('c1')]);
    const sh = e.sheets.clips;
    const orig = sh.getDataRange.bind(sh);
    let n = 0;
    sh.getDataRange = () => {
      n++;
      if (n === 2) sh.values[1][CLIP_H.indexOf('read_status')] = 'read';   // 擁有者檢查之後、鎖內重讀之前
      return orig();
    };
    assert.equal(open(e, 'c1').success, true);
    assert.equal(byId(e, 'c1').read_status, 'read');
  });

  test('不寫 logs（每開一篇一列會把 logs 灌大）', () => {
    const e = env([clipRow('c1')]);
    open(e, 'c1');
    assert.equal(e.transactions.length, 0);
  });
});

/* ========================================================================== */
describe('手動設狀態（clipReadState，D-6）', () => {

  test('三種值都寫得進（含改回未讀）；回傳寫進去的值；不寫 logs、不動 last_read_at', () => {
    const e = env([clipRow('c1', { last_read_at: OLD_AT })]);
    for (const st of ['reading', 'read', '']) {
      const r = setState(e, 'c1', st);
      assert.deepEqual([r.success, r.state], [true, st]);
      assert.equal(byId(e, 'c1').read_status, st);
    }
    assert.equal(byId(e, 'c1').last_read_at, OLD_AT);
    assert.equal(e.transactions.length, 0);
  });

  test('非法值（亂打、大小寫不對、沒帶、不是字串）→ invalid_state 永久拒絕、不動', () => {
    const e = env([clipRow('c1', { read_status: 'reading' })]);
    for (const st of ['done', 'READ', undefined, null, 1]) {
      const r = setState(e, 'c1', st);
      assert.deepEqual([r.error, r.permanent], ['invalid_state', true], 'state=' + st);
    }
    assert.equal(byId(e, 'c1').read_status, 'reading');
  });

  test('不是擁有者 → forbidden 永久拒絕、不動；找不到／已刪除 → not_found', () => {
    const e = env([clipRow('c1', { line_id: MOM }), clipRow('c2', { del: 'TRUE' })]);
    const r = setState(e, 'c1', 'read');
    assert.deepEqual([r.error, r.permanent, r.reason], ['forbidden', true, 'not_owner']);
    assert.equal(byId(e, 'c1').read_status, '');
    assert.equal(setState(e, 'c2', 'read').error, 'not_found');
    assert.equal(setState(e, 'nope', 'read').error, 'not_found');
  });

  test('沒有收藏權限 → forbidden', () => {
    const e = env([clipRow('c1')], { feats: ['feat_tasks'] });
    assert.equal(setState(e, 'c1', 'read').error, 'forbidden');
  });

  test('拿不到鎖 → busy（可重試，不是永久拒絕）', () => {
    const e = env([clipRow('c1')]);
    e.lock.busy = true;
    const r = setState(e, 'c1', 'read');
    assert.equal(r.error, 'busy');
    assert.equal(r.permanent, undefined);
    assert.equal(byId(e, 'c1').read_status, '');
  });
});

/* ========================================================================== */
describe('Reading Widget（D-3）', () => {

  test('未讀只算空白：閱讀中、已讀都不算；「上次在讀」照 last_read_at', () => {
    const e = env([
      clipRow('a'), clipRow('b', { status: 'link' }),
      clipRow('r', { read_status: 'reading', last_read_at: '2026-11-04T00:00:00.000Z' }),
      clipRow('d', { read_status: 'read', last_read_at: '2026-11-01T00:00:00.000Z' }),
      clipRow('p', { status: 'pending' })
    ]);
    const w = post(e, { action: 'widgets', trigger: 'poll' }).widgets.reading;
    assert.equal(w.unread, 2);
    assert.equal(w.last.id, 'r');
  });
});

/* ========================================================================== */
describe('一次性重設（D-7）', () => {

  test('未刪除的列清回未讀；last_read_at 保留；已刪除的列不碰；記旗標', () => {
    const e = env([
      clipRow('a', { read_status: 'read', last_read_at: OLD_AT }),
      clipRow('b', { read_status: 'reading' }),
      clipRow('c'),
      clipRow('x', { read_status: 'read', del: 'TRUE' })
    ]);
    const r = e.call('clipsResetReadState_');
    assert.deepEqual([r.already, r.reset], [false, 2]);
    assert.deepEqual(['a', 'b', 'c'].map((id) => byId(e, id).read_status), ['', '', '']);
    assert.equal(byId(e, 'a').last_read_at, OLD_AT);
    assert.equal(byId(e, 'x').read_status, 'read', '刪掉的列一格都不動');
    assert.ok(e.properties.clips_read_reset);
  });

  test('只跑一次：之後手動調的狀態，下次初始化不會被洗掉', () => {
    const e = env([clipRow('a', { read_status: 'read' })]);
    e.call('clipsResetReadState_');
    setState(e, 'a', 'read');
    const again = e.call('clipsResetReadState_');
    assert.equal(again.already, true);
    assert.equal(byId(e, 'a').read_status, 'read');
  });

  test('旗標寫不進：有要清的就一列都不動（回 flag_failed，下次再試）', () => {
    const e = env([clipRow('a', { read_status: 'read' })], { propsWritable: false });
    const r = e.call('clipsResetReadState_');
    assert.ok(r.flag_failed);
    assert.equal(r.reset, 0);
    assert.equal(byId(e, 'a').read_status, 'read');
  });

  test('初始化有這一步：第一次回「閱讀狀態重設 N 篇」，第二次回「已重設過」', () => {
    const e = env([clipRow('a', { read_status: 'read' }), clipRow('b', { read_status: 'reading' })], { init: true });
    const step = e.read('initSteps_().filter(function (s) { return s.label === "收藏閱讀狀態重設"; })[0]');
    assert.ok(step);
    const first = step.run();
    assert.match(first.text, /閱讀狀態重設 2 篇/);
    assert.equal(first.changed, true);
    assert.match(step.run().text, /已重設過/);
  });

  test('_guide：clips 說明三態、writers 有 clipReadState', () => {
    const e = env([], { init: true });
    const g = e.read('guideRegistry_().filter(function (g) { return g.sheet === "clips"; })[0]');
    assert.match(g.purpose, /reading/);
    assert.match(g.purpose, /ADR-025/);
    assert.match(g.writers, /clipReadState/);
  });
});
