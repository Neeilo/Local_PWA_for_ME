/**
 * ADR-024 PR-A（後端）— 📝 文字辨識 action=clipOcr（D-1、D-4、D-5、D-7、D-8）
 *
 * 為什麼有這批測試：
 *  - 只有收藏擁有者能辨識（D-8）；別人的、沒有 feat_clips 的都是永久拒絕，而且**一張圖都不送**
 *  - 「初始化」還沒補 ocr_* 欄就講 not_ready，不默默丟掉結果
 *  - 部分圖失敗：成功的照存、失敗的那張寫「（辨識失敗：原因）」；**全部失敗才算失敗**，舊結果留著（D-4）
 *  - 暫存文件不論成功失敗都刪（佔空間又看不見）
 *  - 結果另存 ocr_output／ocr_at，不動原文、筆記、AI 整理；捨棄只動這兩欄（2026-11-12 起 ocr_at 記捨棄時間，排程不再自動辨識它）
 *  - 只存連結、沒有圖的篇：講 no_images，不打 API
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { fakeDrive, fakeDriveApi } from './fake-drive.mjs';

const ME = 'Uneil';
const DAD = 'Udad';
const MOM = 'Umom';                     // 沒有 feat_clips
const TOK = { me: 'tok-me', dad: 'tok-dad', mom: 'tok-mom' };
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_clips'];
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const IMG = { f1: { name: '01.jpg' }, f2: { name: '02.jpg' }, f3: { name: '03.jpg' } };

function env({ texts = { f1: '封面字', f2: '提示詞內文' }, clipsRows = [], headers = null, deleteFails = false } = {}) {
  const api = fakeDriveApi(texts, { deleteFails });
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H, [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE'], [DAD, '爸爸', 'TRUE', '', 'TRUE'], [MOM, '媽媽', 'TRUE', '', '']]),
    logs: new FakeSheet('logs', [LOG_H])
  };
  if (headers) sheets.clips = new FakeSheet('clips', [headers]);
  const e = loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    tokens: { [TOK.me]: ME, [TOK.dad]: DAD, [TOK.mom]: MOM }, sheets, properties: { APIFY_TOKEN: 'x' },
    overrides: { UrlFetchApp: api.UrlFetchApp, DriveApp: fakeDrive(IMG), clipOcrToken_: () => 'oauth' }
  });
  if (!headers) e.call('ensureClipsSheet_');
  const H = headers || e.read('CLIPS_HEADERS');
  clipsRows.forEach((r) => e.sheets.clips.values.push(H.map((h) => (r[h] == null ? '' : r[h]))));
  e.api = api;
  return e;
}

const clip = (extra = {}) => Object.assign({ id: 'c1', line_id: ME, url: 'https://www.instagram.com/p/AAA111/', shortcode: 'AAA111', kind: 'post',
  status: 'done', caption: '原文', note: '我的筆記', note_revision: 2, ai_output: '舊 AI 整理', ai_provider: 'Claude', ai_at: '2026-10-20T00:00:00.000Z',
  media_saved: 2, image_ids: JSON.stringify(['f2', 'f1']) }, extra);
const rows = (e) => e.sheets.clips.toRecords();
const post = (e, body, tok = TOK.me) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok, trigger: 'write' }, body)) } }).body);

/* ========================================================================== */
describe('欄位與登記（D-4）', () => {
  test('clips 最右邊加 ocr_output、ocr_at；舊表「初始化」補在最右邊；_guide 說明同步', () => {
    const e = env();
    const H = e.read('CLIPS_HEADERS');
    assert.deepEqual(H.slice(H.indexOf('ocr_output'), H.indexOf('ocr_output') + 2), ['ocr_output', 'ocr_at']);
    assert.ok(H.indexOf('ocr_output') > H.indexOf('ai_at'), '接在 AI 整理欄後面（最右邊）');
    const old = ['id', 'line_id', 'url', 'kind', 'status', 'caption', 'del'];
    const e2 = env({ headers: old });
    e2.call('ensureClipsSheet_');
    assert.ok(e2.sheets.clips.values[0].includes('ocr_output') && e2.sheets.clips.values[0].includes('ocr_at'));
    assert.deepEqual(e2.sheets.clips.values[0].slice(0, old.length), old, '既有欄位不動（1.0 照常讀）');
    const guide = JSON.stringify(e.call('guideRegistry_'));
    assert.match(guide, /ocr_output/);
    assert.match(guide, /clipOcr/);
  });
});

/* ========================================================================== */
describe('📝 文字辨識：clipOcr', () => {
  test('依檔名排序、每張一段；結果另存，原文、筆記、AI 整理都不動；暫存文件無殘留', () => {
    const e = env({ clipsRows: [clip()] });
    const r = post(e, { action: 'clipOcr', id: 'c1' });
    assert.equal(r.success, true);
    assert.equal(r.ocr_output, '## 01.jpg\n封面字\n\n## 02.jpg\n提示詞內文');
    assert.ok(r.ocr_at);
    const row = rows(e)[0];
    assert.equal(row.ocr_output, r.ocr_output);
    assert.equal(row.ocr_at, r.ocr_at);
    assert.deepEqual([row.caption, row.note, Number(row.note_revision), row.ai_output], ['原文', '我的筆記', 2, '舊 AI 整理']);
    assert.equal(e.api.live.size, 0);
    assert.ok(e.transactions.some((t) => t[1] === '成功' && /文字辨識/.test(t[3])));
  });

  test('Google 文件匯出時圖片位置留下的分隔線（________________）濾掉（PR-0 實測每張開頭都有）', () => {
    const e = env({ texts: { f1: '________________\n\n1. 看懂市場\n提示詞：', f2: '________________\n\n' }, clipsRows: [clip()] });
    const out = post(e, { action: 'clipOcr', id: 'c1' }).ocr_output;
    assert.equal(out, '## 01.jpg\n1. 看懂市場\n提示詞：\n\n## 02.jpg\n（無文字）');
  });

  test('讀不到字的那張寫「（無文字）」', () => {
    const e = env({ texts: { f1: '', f2: '內文' }, clipsRows: [clip()] });
    assert.match(post(e, { action: 'clipOcr', id: 'c1' }).ocr_output, /## 01\.jpg\n（無文字）/);
  });

  test('部分失敗：成功的照存，失敗那張寫原因；暫存文件照樣刪', () => {
    const e = env({ texts: { f1: 'EXPORT_FAIL', f2: '內文' }, clipsRows: [clip()] });
    const r = post(e, { action: 'clipOcr', id: 'c1' });
    assert.equal(r.success, true);
    assert.equal(r.failed, 1);
    assert.match(r.ocr_output, /## 01\.jpg\n（辨識失敗：HTTP 500/);
    assert.match(r.ocr_output, /## 02\.jpg\n內文/);
    assert.equal(e.api.live.size, 0);
  });

  test('全部失敗：回 ocr_failed，舊結果留著（不寫半份）', () => {
    const e = env({ texts: { f1: null, f2: 'EXPORT_FAIL' }, clipsRows: [clip({ ocr_output: '上一次的結果', ocr_at: '2026-11-01T00:00:00.000Z' })] });
    const r = post(e, { action: 'clipOcr', id: 'c1' });
    assert.equal(r.error, 'ocr_failed');
    assert.ok(r.reason);
    assert.equal(rows(e)[0].ocr_output, '上一次的結果');
    assert.equal(rows(e)[0].ocr_at, '2026-11-01T00:00:00.000Z');
    assert.equal(e.api.live.size, 0, '失敗也要刪暫存');
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && /文字辨識/.test(t[3])));
  });

  // 2026-11-12 起捨棄會在 ocr_at 記捨棄時間：排程自動辨識看到 ocr_at 有值就不碰，捨棄掉的不會被辨識回來
  test('重跑＝取代；捨棄清掉圖片文字、ocr_at 記捨棄時間，不打 API', () => {
    const e = env({ clipsRows: [clip({ ocr_output: '舊的', ocr_at: '2026-11-01T00:00:00.000Z' })] });
    post(e, { action: 'clipOcr', id: 'c1' });
    assert.match(rows(e)[0].ocr_output, /封面字/);
    const n = e.api.calls.length;
    assert.equal(post(e, { action: 'clipOcr', id: 'c1', discard: true }).success, true);
    assert.equal(e.api.calls.length, n);
    const row = rows(e)[0];
    assert.deepEqual([row.ocr_output, row.ai_output, row.note], ['', '舊 AI 整理', '我的筆記']);
    assert.ok(row.ocr_at && row.ocr_at !== '2026-11-01T00:00:00.000Z', 'ocr_at 記的是捨棄的時間');
  });

  test('暫存刪不掉：結果照存，logs 記下殘留的暫存文件 id', () => {
    const e = env({ clipsRows: [clip()], deleteFails: true });
    assert.equal(post(e, { action: 'clipOcr', id: 'c1' }).success, true);
    assert.ok(e.transactions.some((t) => /殘留/.test(t[4]) && /doc_f1/.test(t[4])));
  });

  test('Reels 只辨識封面（image_ids 只有封面，video.mp4 不在清單）', () => {
    const e = env({ clipsRows: [clip({ kind: 'reel', image_ids: JSON.stringify(['f1']), video_saved: 'TRUE' })] });
    assert.equal(post(e, { action: 'clipOcr', id: 'c1' }).ocr_output, '## 01.jpg\n封面字');
  });

  test('只存連結／沒有圖：no_images（永久），不打 API', () => {
    const e = env({ clipsRows: [clip({ id: 'k1', kind: 'link', status: 'link', image_ids: '' }), clip({ id: 'c2', image_ids: '[]', drive_folder_id: '' })] });
    for (const id of ['k1', 'c2']) {
      const r = post(e, { action: 'clipOcr', id });
      assert.equal(r.error, 'no_images');
      assert.equal(r.permanent, true);
    }
    assert.equal(e.api.calls.length, 0);
  });
});

/* ========================================================================== */
describe('權限（D-8）與準備（not_ready）', () => {
  test('不是擁有者：永久拒絕、一張圖都不送、不寫', () => {
    const e = env({ clipsRows: [clip()] });
    const r = post(e, { action: 'clipOcr', id: 'c1' }, TOK.dad);
    assert.equal(r.error, 'forbidden');
    assert.equal(r.permanent, true);
    assert.equal(e.api.calls.length, 0);
    assert.equal(rows(e)[0].ocr_output, '');
    const d = post(e, { action: 'clipOcr', id: 'c1', discard: true }, TOK.dad);
    assert.equal(d.error, 'forbidden');
  });

  test('沒有 feat_clips：永久拒絕', () => {
    const e = env({ clipsRows: [clip({ line_id: MOM })] });
    const r = post(e, { action: 'clipOcr', id: 'c1' }, TOK.mom);
    assert.equal(r.error, 'forbidden');
    assert.equal(e.api.calls.length, 0);
  });

  test('找不到、已刪除：not_found', () => {
    const e = env({ clipsRows: [clip({ del: 'TRUE' })] });
    assert.equal(post(e, { action: 'clipOcr', id: 'c1' }).error, 'not_found');
    assert.equal(post(e, { action: 'clipOcr', id: 'nope' }).error, 'not_found');
  });

  test('「初始化」還沒補 ocr 欄：not_ready，不打 API', () => {
    const old = ['id', 'line_id', 'url', 'kind', 'status', 'caption', 'image_ids', 'del'];
    const e = env({ headers: old, clipsRows: [clip()] });
    assert.equal(post(e, { action: 'clipOcr', id: 'c1' }).error, 'not_ready');
    assert.equal(e.api.calls.length, 0);
  });
});

/* ========================================================================== */
describe('輸出格式（純函式）', () => {
  test('clipOcrFormat_：每張一段；時間不夠沒跑完的講明幾張', () => {
    const e = env();
    const out = e.call('clipOcrFormat_', [{ name: '01.jpg', ok: true, text: 'A' }, { name: '02.jpg', ok: false, error: 'HTTP 500' }], 3);
    assert.equal(out, '## 01.jpg\nA\n\n## 02.jpg\n（辨識失敗：HTTP 500）\n\n（時間不夠，後面 3 張沒有辨識，再按一次會從頭重跑）');
  });

  test('超過一格的上限：截斷並講明，不讓寫入失敗', () => {
    const e = env();
    const max = e.read('CLIP_OCR_OUTPUT_MAX');
    const out = e.call('clipOcrFormat_', [{ name: '01.jpg', ok: true, text: 'x'.repeat(max + 100) }], 0);
    assert.ok(out.length <= max + 40);
    assert.match(out, /太長，後面截掉了/);
  });
});
