/**
 * ADR-010 — 讀取驗證：LINE 配對 × 裝置 token（後端）
 *
 * 這批測試盯的是「鑰匙只會落在本人手上」這件事的每一個環節：
 *   - 配對碼只從本人的一對一 LINE 拿得到、只能用一次、會過期
 *   - token 原文不落地，Sheet 上只有雜湊
 *   - 過期要本人在 LINE 上確認才續得回來；撤銷、停用的不能自己續
 *   - 身份一律由 token 換出來，body 裡自稱的 line_id 不算數
 *   - 過渡期開關 AUTH_MODE 的兩種狀態，以及它缺值時的預設
 *
 * 測的是 apps-script/Code.gs 與 line-router.gs 本人，整份載進同一個假環境
 * （線上兩個檔案共用全域），只把回覆 LINE 的出口換成記錄器。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-cloud-secret';
const ME = 'Uneil';
const MOM = 'Umom';
const PENDING = 'Upending';
const DAY = 86400000;

const TASK_HEADERS = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive'];

function roster() {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'],
    [ME, 'Neil', 'TRUE', 'TRUE'],
    [MOM, '媽媽', 'TRUE', ''],
    [PENDING, '新來的', '', '']
  ]);
}

function env({ properties = {}, sheets = {} } = {}) {
  const replies = [];
  const e = loadCodeGs({
    cache: true,
    extraFiles: ['line-router.gs'],
    properties: Object.assign({ CLOUD_SECRET: SECRET }, properties),
    sheets: Object.assign({
      line_users: roster(),
      tasks: new FakeSheet('tasks', [TASK_HEADERS.slice(), ['1', '買菜', '', '', 'M', ME, '', '']])
    }, sheets),
    overrides: { lineReply_: (_token, text) => { replies.push(String(text)); } }
  });
  e.replies = replies;
  return e;
}

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

function get(e, params) {
  return JSON.parse(e.call('doGet', { parameter: params }).body);
}

function line(e, userId, text, type = 'user') {
  const source = type === 'user' ? { type, userId } : { type, groupId: 'Cgroup', userId };
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });
  return e.replies[e.replies.length - 1] || '';
}

/** 走完整條流程 A：LINE 傳「配對」→ 拿碼 → PWA pairClaim */
function pair(e, userId = ME, label = 'iPhone · Safari') {
  const reply = line(e, userId, '配對');
  const m = /(\d{6})/.exec(reply);
  assert.ok(m, '「配對」要回一個六位數碼，實際回：' + reply);
  const out = post(e, { action: 'pairClaim', code: m[1], device_label: label });
  assert.equal(out.success, true, 'pairClaim 要成功：' + JSON.stringify(out));
  return out;
}

function devices(e) {
  return e.ss.getSheetByName('line_devices').toRecords();
}

/** 直接改 Sheet（等同 Neil 手動改），並把裝置快取踢掉（等同等 5 分鐘） */
function setDevice(e, deviceId, patch) {
  const sheet = e.ss.getSheetByName('line_devices');
  const headers = sheet.values[0];
  const row = sheet.values.findIndex((r, i) => i > 0 && r[headers.indexOf('device_id')] === deviceId);
  assert.ok(row > 0, '找不到裝置 ' + deviceId);
  Object.keys(patch).forEach((k) => { sheet.values[row][headers.indexOf(k)] = patch[k]; });
  e.cache.evict('adr010_dev_');
}

function setUser(e, lineId, patch) {
  const sheet = e.ss.getSheetByName('line_users');
  const headers = sheet.values[0];
  const row = sheet.values.findIndex((r, i) => i > 0 && r[0] === lineId);
  Object.keys(patch).forEach((k) => { sheet.values[row][headers.indexOf(k)] = patch[k]; });
  e.call('invalidateLineUsersCache_');       // 管理頁 upsert line_users 時就是這樣讓它立刻生效
}

const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

/* ========================================================================== */
describe('流程 A：配對', () => {

  test('碼正確 → 拿到 token，身份是發碼的那個人', () => {
    const e = env();
    const out = pair(e);
    assert.equal(out.line_id, ME);
    assert.equal(out.display_name, 'Neil');
    assert.ok(out.token.length >= 32, 'token 要夠長，猜不到');

    const s = post(e, { action: 'session', token: out.token });
    assert.equal(s.status, 'ok');
    assert.equal(s.line_id, ME);
    assert.equal(s.device_id, out.device_id);
  });

  test('同一個碼第二次用 → invalid_code（用過即刪）', () => {
    const e = env();
    const code = /(\d{6})/.exec(line(e, ME, '配對'))[1];
    assert.equal(post(e, { action: 'pairClaim', code, device_label: 'A' }).success, true);
    assert.equal(post(e, { action: 'pairClaim', code, device_label: 'B' }).error, 'invalid_code');
    assert.equal(devices(e).length, 1, '一個碼只換得到一把鑰匙');
  });

  test('10 分鐘後 → invalid_code', () => {
    const e = env();
    const code = /(\d{6})/.exec(line(e, ME, '配對'))[1];
    e.clock.advance(601);
    assert.equal(post(e, { action: 'pairClaim', code, device_label: 'A' }).error, 'invalid_code');
  });

  test('快取提早逐出（ADR 的 Assumption）→ invalid_code，不會變成別的東西', () => {
    const e = env();
    const code = /(\d{6})/.exec(line(e, ME, '配對'))[1];
    e.cache.evict('adr010_pair_');
    assert.equal(post(e, { action: 'pairClaim', code, device_label: 'A' }).error, 'invalid_code');
  });

  test('⚠️ 群組裡傳「配對」→ 不發碼，並寫 logs', () => {
    const e = env();
    const reply = line(e, ME, '配對', 'group');
    assert.doesNotMatch(reply, /\d{6}/, '群組裡回碼，全群都看得到');
    assert.match(reply, /一對一/);
    assert.equal(e.cache.keys('adr010_pair_').length, 0);
    assert.ok(e.transactions.some((t) => t[0] === '配對' && t[1] === '失敗'));
  });

  test('非 active 成員傳「配對」→ 被 writeGate_ 擋下，拿不到碼', () => {
    const e = env();
    const reply = line(e, PENDING, '配對');
    assert.doesNotMatch(reply, /\d{6}/);
    assert.equal(e.cache.keys('adr010_pair_').length, 0);
    assert.ok(e.transactions.some((t) => String(t[6] || '').includes('inactive') || String(t[4]).includes('inactive')),
      '被擋要留 logs（denyWrite_）');
  });

  test('發碼後 10 分鐘內被停用 → pairClaim 拒絕', () => {
    const e = env();
    const code = /(\d{6})/.exec(line(e, MOM, '配對'))[1];
    setUser(e, MOM, { is_active: 'FALSE' });
    assert.equal(post(e, { action: 'pairClaim', code, device_label: 'A' }).error, 'inactive');
    assert.equal(e.ss.getSheetByName('line_devices'), null, '沒有發出任何裝置');
  });

  test('line_devices 裡找不到 token 原文，只有它的 SHA-256', () => {
    const e = env();
    const out = pair(e);
    const sheetText = JSON.stringify(e.ss.getSheetByName('line_devices').values);
    assert.equal(sheetText.includes(out.token), false, 'token 原文不可以落地');
    const hash = createHash('sha256').update(out.token, 'utf8').digest('hex');
    assert.equal(devices(e)[0].token_hash, hash);
    assert.deepEqual(e.ss.getSheetByName('line_devices').values[0],
      ['device_id', 'token_hash', 'line_id', 'device_label', 'created_at', 'last_used_at', 'revoked_at', 'revoked_by']);
  });

  test('tokenHash_ 與標準 SHA-256 一致（有號位元組要轉回 0～255）', () => {
    const e = env();
    assert.equal(e.call('tokenHash_', 'abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('連續猜錯 30 次 → 暫停配對，連對的碼也不收，並寫一列 logs', () => {
    const e = env();
    const good = /(\d{6})/.exec(line(e, ME, '配對'))[1];
    for (let i = 0; i < 30; i++) {
      const wrong = String((Number(good) + 1 + i) % 1000000).padStart(6, '0');
      post(e, { action: 'pairClaim', code: wrong, device_label: 'x' });
    }
    assert.equal(post(e, { action: 'pairClaim', code: good, device_label: 'x' }).error, 'too_many_attempts');
    assert.equal(e.transactions.filter((t) => String(t[3]).includes('猜錯太多次')).length, 1,
      '只在鎖上的那一刻寫一列，不是每次猜錯都寫');
    e.clock.advance(601);
    const again = /(\d{6})/.exec(line(e, ME, '配對'))[1];
    assert.equal(post(e, { action: 'pairClaim', code: again, device_label: 'x' }).success, true, '10 分鐘後恢復');
  });
});

/* ========================================================================== */
describe('流程 B：滑動效期', () => {

  test('179 天前用過 → ok；181 天 → token_expired', () => {
    const e = env();
    const out = pair(e);
    const now = Date.now();
    setDevice(e, out.device_id, { last_used_at: new Date(now - 179 * DAY).toISOString() });
    assert.equal(e.call('authDevice_', out.token, '', now).ok, true);

    setDevice(e, out.device_id, { last_used_at: new Date(now - 181 * DAY).toISOString() });
    assert.equal(e.call('authDevice_', out.token, '', now).reason, 'token_expired');
  });

  test('Sheet 把時間讀成 Date 物件也算得對', () => {
    const e = env();
    const out = pair(e);
    setDevice(e, out.device_id, { last_used_at: new Date(Date.now() - 181 * DAY) });
    assert.equal(post(e, { action: 'session', token: out.token }).status, 'token_expired');
  });

  test('last_used_at 一天內已寫過就不再寫；超過一天才更新', () => {
    const e = env();
    const out = pair(e);
    const fresh = new Date(Date.now() - 2 * 3600000).toISOString();
    setDevice(e, out.device_id, { last_used_at: fresh });
    post(e, { action: 'read', token: out.token, sheet: 'tasks' });
    assert.equal(devices(e)[0].last_used_at, fresh, '兩小時前寫過，這次不該再寫');

    const stale = daysAgo(3);
    setDevice(e, out.device_id, { last_used_at: stale });
    post(e, { action: 'read', token: out.token, sheet: 'tasks' });
    assert.notEqual(devices(e)[0].last_used_at, stale, '三天前的要被續期');
    assert.ok(Date.now() - new Date(devices(e)[0].last_used_at).getTime() < 60000);
  });

  test('過期的 token 讀資料 → token_expired，不會回空陣列', () => {
    const e = env();
    const out = pair(e);
    setDevice(e, out.device_id, { last_used_at: daysAgo(200) });
    const res = post(e, { action: 'read', token: out.token, sheet: 'tasks' });
    assert.equal(res.error, 'token_expired');
    assert.equal(res.data, undefined);
  });
});

/* ========================================================================== */
describe('流程 C：過期續期', () => {

  function expiredDevice(e, who = ME) {
    const out = pair(e, who);
    setDevice(e, out.device_id, { last_used_at: daysAgo(200) });
    return out;
  }

  test('原主人在 LINE 傳「驗證裝置 碼」→ 同一台續期成功', () => {
    const e = env();
    const out = expiredDevice(e);
    const start = post(e, { action: 'renewStart', token: out.token });
    assert.equal(start.success, true);
    assert.match(start.code, /^\d{6}$/);

    const reply = line(e, ME, '驗證裝置 ' + start.code);
    assert.match(reply, /已續期/);
    assert.equal(post(e, { action: 'session', token: out.token }).status, 'ok', '同一把 token 又能用了');
    assert.equal(devices(e).length, 1, '是同一台續期，不是新增一台');
  });

  test('⚠️ 別人傳同一個碼 → 拒絕，裝置仍然過期，而且碼沒被作廢', () => {
    const e = env();
    const out = expiredDevice(e);
    const { code } = post(e, { action: 'renewStart', token: out.token });

    const reply = line(e, MOM, '驗證裝置 ' + code);
    assert.doesNotMatch(reply, /已續期/);
    assert.equal(post(e, { action: 'session', token: out.token }).status, 'token_expired');
    assert.ok(e.transactions.some((t) => t[0] === '配對' && t[1] === '失敗' && String(t[4]).includes('not_owner')));

    assert.match(line(e, ME, '驗證裝置 ' + code), /已續期/, '旁人亂傳不該讓原主人的碼失效');
  });

  test('續期碼也只收一對一聊天', () => {
    const e = env();
    const out = expiredDevice(e);
    const { code } = post(e, { action: 'renewStart', token: out.token });
    assert.doesNotMatch(line(e, ME, '驗證裝置 ' + code, 'group'), /已續期/);
    assert.equal(post(e, { action: 'session', token: out.token }).status, 'token_expired');
  });

  test('被撤銷的裝置 → renewStart 拒絕（D-6）', () => {
    const e = env();
    const out = expiredDevice(e);
    setDevice(e, out.device_id, { revoked_at: new Date().toISOString(), revoked_by: ME });
    const start = post(e, { action: 'renewStart', token: out.token });
    assert.equal(start.error, 'revoked');
    assert.equal(start.code, undefined);
  });

  test('主人被停用 → renewStart 拒絕（D-6）', () => {
    const e = env();
    const out = expiredDevice(e, MOM);
    setUser(e, MOM, { is_active: 'FALSE' });
    const start = post(e, { action: 'renewStart', token: out.token });
    assert.equal(start.error, 'inactive');
    assert.equal(e.cache.keys('adr010_renew_').length, 0);
  });

  test('發碼之後才被撤銷 → LINE 端也不續', () => {
    const e = env();
    const out = expiredDevice(e);
    const { code } = post(e, { action: 'renewStart', token: out.token });
    setDevice(e, out.device_id, { revoked_at: new Date().toISOString(), revoked_by: ME });
    assert.match(line(e, ME, '驗證裝置 ' + code), /撤銷/);
    assert.equal(post(e, { action: 'session', token: out.token }).status, 'revoked');
  });

  test('沒過期就不發碼', () => {
    const e = env();
    const out = pair(e);
    assert.equal(post(e, { action: 'renewStart', token: out.token }).error, 'not_expired');
  });

  test('續期碼 10 分鐘後失效', () => {
    const e = env();
    const out = expiredDevice(e);
    const { code } = post(e, { action: 'renewStart', token: out.token });
    e.clock.advance(601);
    assert.doesNotMatch(line(e, ME, '驗證裝置 ' + code), /已續期/);
  });
});

/* ========================================================================== */
describe('停用＝暫停（D-7）、撤銷、一人多台', () => {

  test('停用 → 所有裝置 inactive；重新啟用 → 沒撤銷的自動恢復', () => {
    const e = env();
    const a = pair(e, MOM, '手機');
    const b = pair(e, MOM, '平板');

    setUser(e, MOM, { is_active: 'FALSE' });
    assert.equal(post(e, { action: 'session', token: a.token }).status, 'inactive');
    assert.equal(post(e, { action: 'read', token: b.token, sheet: 'tasks' }).error, 'inactive');

    setUser(e, MOM, { is_active: 'TRUE' });
    assert.equal(post(e, { action: 'session', token: a.token }).status, 'ok');
    assert.equal(post(e, { action: 'session', token: b.token }).status, 'ok');
  });

  test('一人多台：撤銷其中一台，其他台不受影響', () => {
    const e = env();
    const phone = pair(e, ME, '手機');
    const pc = pair(e, ME, '電腦');
    // 先讓電腦那台進快取：撤銷若沒讓快取失效，接下來 5 分鐘它還會被放行
    assert.equal(post(e, { action: 'session', token: pc.token }).status, 'ok');

    const res = post(e, { action: 'revokeDevice', token: phone.token, device_id: pc.device_id });
    assert.equal(res.success, true);
    assert.equal(res.revoked, 1);
    assert.equal(post(e, { action: 'session', token: pc.token }).status, 'revoked', '撤銷要立刻生效，不等快取');
    assert.equal(post(e, { action: 'session', token: phone.token }).status, 'ok');
  });

  test('非管理者不能撤銷別人的裝置，也不能列別人的裝置', () => {
    const e = env();
    const mine = pair(e, ME, '手機');
    const mom = pair(e, MOM, '媽媽手機');

    assert.equal(post(e, { action: 'revokeDevice', token: mom.token, device_id: mine.device_id }).error, 'forbidden');
    assert.equal(post(e, { action: 'session', token: mine.token }).status, 'ok');
    assert.equal(post(e, { action: 'listDevices', token: mom.token, line_id: ME }).error, 'forbidden');
  });

  test('管理者可以列、可以全部撤銷別人的裝置；清單不帶 token_hash', () => {
    const e = env();
    const admin = pair(e, ME, '手機');
    const m1 = pair(e, MOM, '媽媽手機');
    pair(e, MOM, '媽媽平板');

    assert.equal(post(e, { action: 'session', token: m1.token }).status, 'ok');   // 暖快取，理由同上

    const list = post(e, { action: 'listDevices', token: admin.token, line_id: MOM });
    assert.equal(list.devices.length, 2);
    assert.equal(JSON.stringify(list).includes('token_hash'), false);
    assert.ok(list.devices.every((d) => d.status === 'active' && d.current === false));

    const res = post(e, { action: 'revokeDevice', token: admin.token, all_of: MOM });
    assert.equal(res.revoked, 2);
    assert.equal(post(e, { action: 'session', token: m1.token }).status, 'revoked');
    assert.equal(post(e, { action: 'session', token: admin.token }).status, 'ok');
    assert.ok(devices(e).filter((d) => d.line_id === MOM).every((d) => d.revoked_by === ME));
  });

  test('自己的清單會標出「就是這一台」', () => {
    const e = env();
    const phone = pair(e, ME, '手機');
    pair(e, ME, '電腦');
    const list = post(e, { action: 'listDevices', token: phone.token });
    assert.deepEqual(list.devices.filter((d) => d.current).map((d) => d.device_id), [phone.device_id]);
  });

  test('已撤銷的再撤一次：不重寫撤銷時間與撤銷者', () => {
    const e = env();
    const admin = pair(e, ME);
    const mom = pair(e, MOM);
    post(e, { action: 'revokeDevice', token: mom.token, device_id: mom.device_id });
    const before = devices(e).find((d) => d.device_id === mom.device_id);
    const res = post(e, { action: 'revokeDevice', token: admin.token, all_of: MOM });
    assert.equal(res.revoked, 0);
    assert.deepEqual(devices(e).find((d) => d.device_id === mom.device_id), before);
  });
});

/* ========================================================================== */
describe('身份只從 token 來', () => {

  test('body 帶了別人的 line_id → 後端仍以 token 換出的身份為準', () => {
    const e = env();
    const mom = pair(e, MOM);

    // 自稱是管理者：也列不了別人的裝置——身份沒有跟著 body 走
    assert.equal(post(e, { action: 'listDevices', token: mom.token, line_id: ME }).error, 'forbidden');

    // 自稱是被停用的人：寫入照樣以媽媽的身份放行
    const ok = post(e, { action: 'upsert', token: mom.token, line_id: PENDING, sheet: 'tasks', key_field: 'id',
      record: { id: '9', text: '媽媽記的', line_id: MOM } });
    assert.equal(ok.success, true);

    // 反過來：token 的主人被停用，body 自稱管理者也沒用
    setUser(e, MOM, { is_active: 'FALSE' });
    const denied = post(e, { action: 'upsert', token: mom.token, line_id: ME, sheet: 'tasks', key_field: 'id',
      record: { id: '10', text: 'x', line_id: ME } });
    assert.equal(denied.error, 'inactive');
    assert.equal(e.ss.getSheetByName('tasks').toRecords().some((r) => r.id === '10'), false);
  });

  test('read 回的形狀與舊 doGet 一模一樣，墓碑照樣擋在後端', () => {
    const e = env();
    e.ss.getSheetByName('tasks').appendRow(['2', '已刪', '', '', 'M', ME, 'TRUE', '']);
    const out = pair(e);
    const viaPost = post(e, { action: 'read', token: out.token, sheet: 'tasks' });
    assert.deepEqual(viaPost, get(e, { sheet: 'tasks' }));
    assert.deepEqual(viaPost.data.map((r) => r.id), ['1']);

    const tombs = post(e, { action: 'readTombstones', token: out.token, sheet: 'tasks', key_field: ['id'] });
    assert.deepEqual(tombs, get(e, { sheet: 'tasks', only: 'tombstones', key_field: 'id' }));
    assert.deepEqual(tombs.keys, ['2']);
  });

  test('沒帶 token 的 read → no_token；帶亂填的 → unknown_token（都寫 logs）', () => {
    const e = env();
    assert.equal(post(e, { action: 'read', sheet: 'tasks', secret: SECRET, line_id: ME }).error, 'no_token',
      '新開的讀取門不收舊密鑰');
    assert.equal(post(e, { action: 'read', sheet: 'tasks', token: 'x'.repeat(64) }).error, 'unknown_token');
    assert.equal(e.transactions.filter((t) => t[0] === '同步' && t[1] === '失敗').length, 2);
  });

  test('line_devices：read、readTombstones、upsert、archivePurge、doGet 一律擋下', () => {
    const e = env();
    const out = pair(e);
    const before = JSON.stringify(e.ss.getSheetByName('line_devices').values);

    assert.equal(post(e, { action: 'read', token: out.token, sheet: 'line_devices' }).error, 'sheet_not_readable');
    assert.equal(post(e, { action: 'readTombstones', token: out.token, sheet: 'line_devices' }).error, 'sheet_not_readable');
    assert.equal(get(e, { sheet: 'line_devices' }).error, 'sheet_not_readable', 'dual 期間的舊門也不能讀走它');
    assert.equal(post(e, { action: 'upsert', token: out.token, sheet: 'line_devices', key_field: 'device_id',
      record: { device_id: out.device_id, revoked_at: '' } }).error, 'sheet_not_writable');
    assert.equal(post(e, { action: 'archivePurge', token: out.token, sheet: 'line_devices', keys: [out.device_id] }).error,
      'sheet_not_writable');
    assert.equal(post(e, { action: 'upsert', secret: SECRET, line_id: ME, sheet: 'line_devices',
      record: { device_id: 'x' } }).error, 'sheet_not_writable', '舊寫法也一樣');
    assert.equal(JSON.stringify(e.ss.getSheetByName('line_devices').values), before);
  });
});

/* ========================================================================== */
describe('AUTH_MODE 過渡期開關', () => {

  const legacyUpsert = { action: 'upsert', secret: SECRET, line_id: ME, sheet: 'tasks', key_field: 'id',
    record: { id: '5', text: '舊版 App 寫的', line_id: ME } };

  test('屬性缺漏 → 當 dual：舊寫法、token、doGet 都通', () => {
    const e = env();
    const out = pair(e);
    assert.equal(post(e, legacyUpsert).success, true);
    assert.equal(post(e, { action: 'upsert', token: out.token, sheet: 'tasks', key_field: 'id',
      record: { id: '6', text: '新版', line_id: ME } }).success, true);
    assert.ok(Array.isArray(get(e, { sheet: 'tasks' }).data));
  });

  test('值不認得（打錯字）→ 也當 dual，不會把還沒配對的人鎖在外面', () => {
    const e = env({ properties: { AUTH_MODE: 'token-only ' } });
    assert.equal(post(e, legacyUpsert).success, true);
    assert.ok(Array.isArray(get(e, { sheet: 'tasks' }).data));
  });

  test('dual 時舊寫法仍然要過密鑰與白名單', () => {
    const e = env();
    assert.equal(post(e, Object.assign({}, legacyUpsert, { secret: 'wrong' })).error, 'unauthorized');
    assert.equal(post(e, Object.assign({}, legacyUpsert, { line_id: PENDING })).error, 'inactive');
  });

  test('token_only：doGet 回 gone；舊寫法被擋而且寫 logs；token 照常', () => {
    const e = env({ properties: { AUTH_MODE: ' TOKEN_ONLY ' } });
    const out = pair(e);

    assert.deepEqual(get(e, { sheet: 'tasks' }), { error: 'gone' });
    const before = e.ss.getSheetByName('tasks').toRecords().length;
    assert.equal(post(e, legacyUpsert).error, 'token_required');
    assert.equal(e.ss.getSheetByName('tasks').toRecords().length, before, '被擋的寫入一筆都不能落地');
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && String(t[3]).includes('舊版寫法')),
      '要看得出還有舊版 App 在跑');

    assert.equal(post(e, { action: 'read', token: out.token, sheet: 'tasks' }).data.length, 1);
    assert.equal(post(e, { action: 'upsert', token: out.token, sheet: 'tasks', key_field: 'id',
      record: { id: '7', text: '新版', line_id: ME } }).success, true);
  });
});

/* ========================================================================== */
describe('GAS 各檔共用全域：新名稱不能撞名', () => {

  test('apps-script/*.gs 的頂層 function／var 沒有重複宣告', () => {
    const dir = join(ROOT, 'apps-script');
    const seen = new Map();
    const dup = [];
    readdirSync(dir).filter((f) => f.endsWith('.gs')).forEach((f) => {
      const src = readFileSync(join(dir, f), 'utf8');
      const re = /^(?:function\s+([A-Za-z0-9_$]+)\s*\(|(?:var|let|const)\s+([A-Za-z0-9_$]+)\s*=)/gm;
      let m;
      while ((m = re.exec(src))) {
        const name = m[1] || m[2];
        if (seen.has(name)) dup.push(name + '（' + seen.get(name) + '、' + f + '）');
        else seen.set(name, f);
      }
    });
    assert.deepEqual(dup, [], '撞名不會報錯，只會安靜地被後載入的那份蓋掉');
  });
});
