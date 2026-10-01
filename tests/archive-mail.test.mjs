/**
 * 封存改寄信（2026-10-01 Neil 裁決）
 *
 * 流程：① 整理 JSON → ② 寄給管理者 → ③ 寄出成功才刪。任何一步失敗就停，回報階段與原因：
 *   ①② 失敗 → 雲端一列都沒動
 *   ③ 刪到一半失敗 → 已刪的補回去（信已寄出）
 *
 * 這裡最要守的是「沒寄成就不准刪」與「刪一半要補回」——前者守的是備份，後者守的是
 * 「全部成功或全部不動」。舊流程是前端逐張分頁各打一次請求，五張表各自成敗，做不到後者。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const ADMIN = { line_id: ME, user: { line_id: ME, is_active: 'TRUE', is_admin: 'TRUE' }, device: null };
const MEMBER = { line_id: MOM, user: { line_id: MOM, is_active: 'TRUE', is_admin: '' }, device: null };

const TASK_H = ['id', 'text', 'line_id', 'del'];
const MOOD_H = ['id', 'mood_date', 'level', 'line_id', 'del'];
const REVIEW_H = ['review_date', 'good', 'line_id', 'del'];

function roster({ myEmail = 'neil@example.com', momEmail = 'mom@example.com', momAdmin = '' } = {}) {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin', 'email'],
    [ME, 'Neil', 'TRUE', 'TRUE', myEmail],
    [MOM, '媽媽', 'TRUE', momAdmin, momEmail]
  ]);
}

function env({ users = roster(), mailImpl = null } = {}) {
  return loadCodeGs({
    mailImpl,
    sheets: {
      line_users: users,
      tasks: new FakeSheet('tasks', [TASK_H, ['1', '還在的', ME, ''], ['2', '刪掉的任務', ME, 'TRUE'], ['3', '也刪了', MOM, 'TRUE']]),
      moods: new FakeSheet('moods', [MOOD_H, ['10', new Date(2026, 8, 13), 3, ME, 'TRUE'], ['11', new Date(2026, 8, 14), 4, ME, '']]),
      reviews: new FakeSheet('reviews', [REVIEW_H, [new Date(2026, 8, 30), '刪掉的日誌', ME, 'TRUE']]),
      notes: new FakeSheet('notes', [['id', 'text', 'line_id', 'del'], ['20', '沒刪的雜記', ME, '']])
    }
  });
}

const ids = (e, sheet) => e.ss.getSheetByName(sheet).toRecords().map((r) => String(r.id || r.good));
const archive = (e, caller = ADMIN) => e.call('archiveByMail_', caller);

/* ========================================================================== */
describe('正常流程：整理 → 寄信 → 刪除', () => {

  test('一封信寄給管理者，附件 JSON 含全部墓碑；寄出後才刪，沒刪的列不動', () => {
    const e = env();
    const out = archive(e);

    assert.equal(out.success, true);
    assert.equal(out.total, 4);
    assert.equal(out.deleted, 4);
    assert.equal(e.mails.length, 1, '五張表一封信，不是一張表一封');
    assert.equal(e.mails[0].to, 'neil@example.com', '只寄給管理者，媽媽不是管理者');

    const att = e.mails[0].attachments[0];
    assert.equal(att.contentType, 'application/json');
    assert.match(att.name, /^neil-os-archive-\d{4}-\d{2}-\d{2}\.json$/);
    const payload = JSON.parse(att.data);
    assert.equal(payload.total, 4);
    assert.deepEqual(payload.sheets.map((s) => s.sheet), ['tasks', 'moods', 'reviews']);
    assert.deepEqual(payload.sheets[0].rows.map((r) => r.text), ['刪掉的任務', '也刪了']);

    assert.deepEqual(ids(e, 'tasks'), ['1']);
    assert.deepEqual(ids(e, 'moods'), ['11']);
    assert.equal(e.ss.getSheetByName('reviews').toRecords().length, 0);
    assert.deepEqual(ids(e, 'notes'), ['20'], '沒有墓碑的分頁一個字都不動');
    assert.equal(e.lock.held, false, '鎖要放掉，否則下一次封存永遠排不到');
    assert.ok(e.transactions.some((t) => t[1] === '成功' && String(t[2]).startsWith('封存寄信')));
  });

  test('沒有任何墓碑：不寄信、不刪，回 total 0', () => {
    const e = loadCodeGs({ sheets: { line_users: roster(), tasks: new FakeSheet('tasks', [TASK_H, ['1', 'a', ME, '']]) } });
    const out = archive(e);
    assert.deepEqual(out, { success: true, total: 0, deleted: 0, skipped: 0, recipients: 0 });
    assert.equal(e.mails.length, 0, '空信只會讓人以為出了什麼事');
  });

  test('多位管理者都收到；停用的管理者、沒填或填錯 email 的不寄', () => {
    const users = new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin', 'email'],
      [ME, 'Neil', 'TRUE', 'TRUE', 'neil@example.com'],
      [MOM, '媽媽', 'TRUE', 'TRUE', 'mom@example.com'],
      ['Uold', '前管理者', 'FALSE', 'TRUE', 'old@example.com'],
      ['Ubad', '打錯字', 'TRUE', 'TRUE', 'not-an-email']
    ]);
    const e = env({ users });
    archive(e);
    assert.equal(e.mails[0].to, 'neil@example.com,mom@example.com');
  });

  test('寄信那幾秒內有人取消刪除：那一列放過不刪（內容仍在信裡），計入 skipped', () => {
    let e;
    e = env({
      mailImpl: () => {
        const t = e.ss.getSheetByName('tasks');
        t.values[3][3] = '';                 // 「也刪了」被取消刪除
      }
    });
    const out = archive(e);
    assert.equal(out.success, true);
    assert.equal(out.skipped, 1);
    assert.deepEqual(ids(e, 'tasks'), ['1', '3']);
  });
});

/* ========================================================================== */
describe('⚠️ 失敗就停，而且講得出是哪一步', () => {

  test('寄信失敗（額度用完／沒授權）：一列都不刪，回報 mail 階段與原因，寫 logs', () => {
    const e = env({ mailImpl: () => { throw new Error('Service invoked too many times for one day: email.'); } });
    const before = JSON.stringify(['tasks', 'moods', 'reviews'].map((s) => e.ss.getSheetByName(s).values));

    const out = archive(e);
    assert.equal(out.error, 'archive_failed');
    assert.equal(out.stage, 'mail');
    assert.match(out.message, /too many times/);
    assert.equal(JSON.stringify(['tasks', 'moods', 'reviews'].map((s) => e.ss.getSheetByName(s).values)), before,
      '沒寄成就不准刪——這是整個流程唯一的備份');
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && String(t[3]).includes('mail')));
    assert.equal(e.lock.held, false);
  });

  test('沒有任何管理者填 email：停在 mail 階段，不刪', () => {
    const e = env({ users: roster({ myEmail: '' }) });
    const out = archive(e);
    assert.equal(out.stage, 'mail');
    assert.match(out.message, /email/);
    assert.equal(e.mails.length, 0);
    assert.deepEqual(ids(e, 'tasks'), ['1', '2', '3']);
  });

  test('刪到一半失敗：已刪的補回去，回報 delete 階段、已寄出、已補回', () => {
    const e = env();
    const moods = e.ss.getSheetByName('moods');
    moods.deleteRow = () => { throw new Error('Service Spreadsheets timed out'); };   // tasks 先刪成功，moods 卡住

    const out = archive(e);
    assert.equal(out.stage, 'delete');
    assert.equal(out.mailed, true, '要讓人知道信已經寄出');
    assert.equal(out.rolled_back, true);
    assert.equal(out.restored, 2);
    assert.deepEqual(ids(e, 'tasks').sort(), ['1', '2', '3'], 'tasks 已刪的兩列要補回來');
    assert.equal(e.ss.getSheetByName('tasks').toRecords().filter((r) => r.del === 'TRUE').length, 2,
      '補回來的仍是墓碑，下次封存還會再處理');
    assert.equal(e.ss.getSheetByName('reviews').toRecords().length, 1, '還沒輪到的分頁本來就沒動');
  });

  test('非管理者：permission 階段就擋下，不寄不刪', () => {
    const e = env();
    const out = archive(e, MEMBER);
    assert.equal(out.stage, 'permission');
    assert.equal(e.mails.length, 0);
    assert.deepEqual(ids(e, 'tasks'), ['1', '2', '3']);
  });

  test('另一個封存正在跑：lock 階段擋下，不寄不刪', () => {
    const e = env();
    e.lock.busy = true;
    const out = archive(e);
    assert.equal(out.stage, 'lock');
    assert.equal(e.mails.length, 0);
  });
});

/* ========================================================================== */
describe('setMyEmail：只改自己那一格', () => {

  test('寫進自己的 email，其他欄一格不動', () => {
    const e = env({ users: roster({ momEmail: '' }) });
    const before = e.ss.getSheetByName('line_users').values[2].slice();
    const out = e.call('setMyEmail_', MEMBER, '  mom@family.tw ');
    assert.deepEqual(out, { success: true, email: 'mom@family.tw' });
    const row = e.ss.getSheetByName('line_users').values[2];
    assert.equal(row[4], 'mom@family.tw');
    assert.deepEqual(row.slice(0, 4), before.slice(0, 4), '不碰 is_active／is_admin——前端那份名單可能是舊的');
    assert.equal(e.ss.getSheetByName('line_users').values[1][4], 'neil@example.com', '別人的 email 不動');
  });

  test('email 欄還不存在：補在表頭最右邊再寫', () => {
    const users = new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'], [ME, 'Neil', 'TRUE', 'TRUE']]);
    const e = env({ users });
    e.call('setMyEmail_', ADMIN, 'neil@example.com');
    assert.deepEqual(e.ss.getSheetByName('line_users').values[0], ['line_id', 'display_name', 'is_active', 'is_admin', 'email']);
    assert.equal(e.ss.getSheetByName('line_users').toRecords()[0].email, 'neil@example.com');
  });

  test('格式不對：拒絕，不寫', () => {
    const e = env();
    assert.equal(e.call('setMyEmail_', ADMIN, 'neil@').error, 'invalid_email');
    assert.equal(e.call('setMyEmail_', ADMIN, '').error, 'invalid_email');
    assert.equal(e.ss.getSheetByName('line_users').values[1][4], 'neil@example.com');
  });

  test('經 POST 進來時，身份由 token 決定，body 的 line_id 不算數', () => {
    const e = loadCodeGs({ cache: true, sheets: { line_users: roster({ momEmail: '' }) } });
    // 直接放一台裝置給媽媽，省掉 LINE 配對的流程（配對本身在 adr-010-auth 測過）
    const token = 'tok-mom';
    const hash = e.call('tokenHash_', token);
    e.ss.insertSheet('line_devices').values = [
      ['device_id', 'token_hash', 'line_id', 'device_label', 'created_at', 'last_used_at', 'revoked_at', 'revoked_by'],
      ['d1', hash, MOM, '手機', new Date().toISOString(), new Date().toISOString(), '', '']
    ];
    const post = (b) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(b) } }).body);

    assert.equal(post({ action: 'setMyEmail', token, line_id: ME, email: 'mom@family.tw' }).success, true);
    assert.equal(e.ss.getSheetByName('line_users').toRecords().find((r) => r.line_id === MOM).email, 'mom@family.tw');
    assert.equal(e.ss.getSheetByName('line_users').toRecords().find((r) => r.line_id === ME).email, 'neil@example.com');

    assert.equal(post({ action: 'archiveMail', token }).stage, 'permission', '媽媽不是管理者');
    assert.equal(post({ action: 'archiveMail', secret: 'x', line_id: ME }).error, 'no_token', '新動作不收舊密鑰');
  });
});
