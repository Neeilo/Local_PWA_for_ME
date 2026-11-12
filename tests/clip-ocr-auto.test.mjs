/**
 * 2026-11-12 圖書館：排程自動跑 📝 文字辨識（Drive OCR，免費）
 *
 * 盯的事（為什麼）：
 *   - 只挑「收齊、有圖、沒刪、ocr_at 空白」的篇：只存連結、還在排隊、失敗的、刪掉的都不碰（不白打 API）
 *   - ocr_at 有值就不碰：手動跑過的不被蓋掉；**捨棄過的不會被辨識回來**（捨棄會在 ocr_at 記時間）
 *   - 新收的先跑、一次最多 CLIP_OCR_AUTO_PER_RUN 篇；這一輪剩的時間不夠就留給下一輪（GAS 6 分鐘上限）
 *   - 辨識途中你手動按了或捨棄：寫回時在鎖內重看，以你的為準
 *   - 整篇失敗不寫半份、記失敗次數；同一篇失敗滿 3 次就不再自動試（不會每 10 分鐘打一次壞掉的篇）
 *   - 掛在圖書館模組底下：模組關掉，排程不跑；排在收藏搜集後面
 *   - 暫存文件照樣刪乾淨；成功、失敗都寫 logs（歸屬收藏擁有者）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { fakeDrive, fakeDriveApi } from './fake-drive.mjs';

const ME = 'Uneil';
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_clips'];
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const IMG = { f1: { name: '01.jpg' }, f2: { name: '02.jpg' }, g1: { name: '01.jpg' }, h1: { name: '01.jpg' }, k1: { name: '01.jpg' } };
const TEXTS = { f1: '封面字', f2: '內文', g1: 'G 的字', h1: 'H 的字', k1: 'K 的字' };

function env({ texts = TEXTS, clipsRows = [], properties = {}, overrides = {} } = {}) {
  const api = fakeDriveApi(texts);
  const e = loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs', 'scheduler.gs'], tokens: { tok: ME },
    sheets: {
      line_users: new FakeSheet('line_users', [USER_H, [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE']]),
      logs: new FakeSheet('logs', [LOG_H])
    },
    properties: Object.assign({ APIFY_TOKEN: 'x' }, properties),
    overrides: Object.assign({ UrlFetchApp: api.UrlFetchApp, DriveApp: fakeDrive(IMG), clipOcrToken_: () => 'oauth' }, overrides)
  });
  e.call('ensureClipsSheet_');
  const H = e.read('CLIPS_HEADERS');
  clipsRows.forEach((r) => e.sheets.clips.values.push(H.map((h) => (r[h] == null ? '' : r[h]))));
  e.api = api;
  return e;
}
const clip = (id, extra = {}) => Object.assign({ id, line_id: ME, url: 'https://www.instagram.com/p/' + id + '/', shortcode: id, kind: 'post',
  status: 'done', caption: '原文', note: '我的筆記', media_saved: 1, image_ids: JSON.stringify([id === 'c1' ? 'f1' : id[0] + '1']) }, extra);
const rows = (e) => e.sheets.clips.toRecords();
const row = (e, id) => rows(e).find((r) => String(r.id) === id);
const run = (e, budget = 1e9) => e.call('runClipOcrJob_', new Date(), { budgetLeft: () => budget });
const copies = (e) => e.api.calls.filter((c) => /\/copy\?/.test(c.url)).map((c) => /files\/([^/]+)\/copy/.exec(c.url)[1]);

/* ========================================================================== */
describe('挑哪幾篇', () => {

  test('收齊、有圖、ocr_at 空白 → 自動辨識並寫回；原文、筆記不動；暫存無殘留', () => {
    const e = env({ clipsRows: [clip('c1', { image_ids: JSON.stringify(['f2', 'f1']), media_saved: 2 })] });
    const r = run(e);
    assert.deepEqual([r.processed, r.ok, r.failed], [1, 1, 0]);
    const x = row(e, 'c1');
    assert.equal(x.ocr_output, '## 01.jpg\n封面字\n\n## 02.jpg\n內文');
    assert.ok(x.ocr_at);
    assert.deepEqual([x.caption, x.note], ['原文', '我的筆記']);
    assert.equal(e.api.live.size, 0);
    assert.ok(e.transactions.some((t) => t[1] === '成功' && /自動文字辨識/.test(t[3]) && t[6] === ME), 'logs 歸屬收藏擁有者');
  });

  test('不碰：只存連結、排隊中、失敗、刪掉、已有結果、捨棄過（ocr_at 有值）、沒有圖', () => {
    const e = env({ clipsRows: [
      clip('k1', { kind: 'link', status: 'link' }),
      clip('g1', { status: 'pending' }),
      clip('h1', { status: 'failed' }),
      clip('c1', { del: 'TRUE' }),
      clip('f2', { ocr_output: '手動跑過', ocr_at: '2026-11-01T00:00:00.000Z', image_ids: JSON.stringify(['f2']) }),
      clip('x1', { ocr_output: '', ocr_at: '2026-11-02T00:00:00.000Z' }),        // 捨棄過
      clip('y1', { image_ids: '[]', drive_folder_id: '' })
    ] });
    const r = run(e);
    assert.equal(r.processed, 0);
    assert.equal(e.api.calls.length, 0, '一個 API 都不打');
    assert.equal(row(e, 'f2').ocr_output, '手動跑過');
    assert.equal(row(e, 'x1').ocr_output, '', '捨棄過的不會被辨識回來');
  });

  test('partial（部分圖存到）也算收齊', () => {
    const e = env({ clipsRows: [clip('g1', { status: 'partial' })] });
    assert.equal(run(e).ok, 1);
    assert.match(row(e, 'g1').ocr_output, /G 的字/);
  });

  test('新收的先跑（表的下面＝新的），一次最多 CLIP_OCR_AUTO_PER_RUN 篇，剩的下一次', () => {
    const e = env({ clipsRows: [clip('c1'), clip('g1'), clip('h1'), clip('k1')] });
    assert.equal(e.read('CLIP_OCR_AUTO_PER_RUN'), 3);
    run(e);
    assert.deepEqual(copies(e), ['k1', 'h1', 'g1']);
    assert.equal(row(e, 'c1').ocr_output, '');
    run(e);
    assert.match(row(e, 'c1').ocr_output, /封面字/);
  });

  test('這一輪剩不到 1 分鐘：一篇都不開（留給下一輪），也不算失敗', () => {
    const e = env({ clipsRows: [clip('c1')] });
    const r = run(e, 59000);
    assert.deepEqual([r.processed, r.skipped], [0, 1]);
    assert.equal(e.api.calls.length, 0);
    assert.deepEqual(e.read('clipOcrAutoFails_()'), {});
  });

  test('clips 還沒補 ocr 欄（還沒初始化）：not_ready，不打 API', () => {
    const e = env();
    e.sheets.clips.values = [['id', 'line_id', 'url', 'kind', 'status', 'image_ids', 'del'], ['c1', ME, 'u', 'post', 'done', '["f1"]', '']];
    assert.equal(run(e).reason, 'not_ready');
    assert.equal(e.api.calls.length, 0);
  });
});

/* ========================================================================== */
describe('失敗與併發', () => {

  test('整篇失敗：不寫半份、記一次失敗；滿 3 次就不再自動試；成功後清掉失敗紀錄', () => {
    const e = env({ texts: { f1: null }, clipsRows: [clip('c1')] });
    for (let i = 1; i <= 3; i++) {
      assert.equal(run(e).failed, 1, '第 ' + i + ' 次');
      assert.equal(row(e, 'c1').ocr_output, '');
      assert.equal(row(e, 'c1').ocr_at, '', '失敗不記 ocr_at：之後手動按 📝 照樣可以');
    }
    assert.equal(e.read('clipOcrAutoFails_()').c1, 3);
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && /不再自動重試/.test(t[4])));
    const n = e.api.calls.length;
    assert.equal(run(e).processed, 0, '第 4 次不再試');
    assert.equal(e.api.calls.length, n);
    assert.equal(e.api.live.size, 0, '失敗也刪暫存');
  });

  test('失敗兩次後成功：寫回，失敗紀錄清掉', () => {
    const e = env({ clipsRows: [clip('c1')], properties: { clip_ocr_auto_fails: JSON.stringify({ c1: 2 }) } });
    assert.equal(run(e).ok, 1);
    assert.equal(e.read('clipOcrAutoFails_()').c1, undefined);
  });

  test('辨識途中被手動跑過（ocr_at 已有值）：以手動那份為準，不蓋掉', () => {
    let e;
    const real = fakeDriveApi(TEXTS);
    e = env({ clipsRows: [clip('c1')], overrides: { UrlFetchApp: { fetch: (url, opts) => {
      // 第一張的 export 回來前，模擬使用者在 App 按了 📝 並寫好結果
      if (/\/export\?/.test(url) && !row(e, 'c1').ocr_at) {
        const H = e.read('CLIPS_HEADERS');
        const r = e.sheets.clips.values.find((v) => v[0] === 'c1');
        r[H.indexOf('ocr_output')] = '手動那份';
        r[H.indexOf('ocr_at')] = '2026-11-12T01:00:00.000Z';
      }
      return real.UrlFetchApp.fetch(url, opts);
    } } } });
    const r = run(e);
    assert.equal(r.ok, 0);
    assert.equal(row(e, 'c1').ocr_output, '手動那份');
    assert.equal(row(e, 'c1').ocr_at, '2026-11-12T01:00:00.000Z');
  });

  test('捨棄後排程不會辨識回來（捨棄在 ocr_at 記時間）', () => {
    const e = env({ clipsRows: [clip('c1')] });
    run(e);
    assert.ok(row(e, 'c1').ocr_output);
    const post = (body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: 'tok', trigger: 'write' }, body)) } }).body);
    const d = post({ action: 'clipOcr', id: 'c1', discard: true });
    assert.equal(d.success, true, JSON.stringify(d));
    assert.equal(row(e, 'c1').ocr_output, '');
    assert.ok(row(e, 'c1').ocr_at);
    const n = e.api.calls.length;
    assert.equal(run(e).processed, 0);
    assert.equal(e.api.calls.length, n);
  });
});

/* ========================================================================== */
describe('排程登記', () => {

  test('掛在圖書館模組、排在收藏搜集後面、每 10 分鐘', () => {
    const e = env();
    const jobs = e.read('schedulerJobs_().map(function (j) { return { name: j.name, module: j.module || "", rule: j.rule }; })');
    const i = jobs.findIndex((j) => j.name === 'clipsOcr');
    assert.ok(i > jobs.findIndex((j) => j.name === 'clips'), '收藏搜集先跑，剛收好的這一輪或下一輪就辨識');
    assert.equal(jobs[i].module, 'library');
    assert.deepEqual(jobs[i].rule, { kind: 'every', minutes: 10 });
  });

  test('圖書館模組關掉：總管不派這個工作', () => {
    const e = env({ clipsRows: [clip('c1')], overrides: { moduleOn_: (id) => id !== 'library' } });
    const r = e.call('runScheduler', Date.UTC(2026, 10, 12, 3, 0));
    assert.ok(!r.ran.includes('clipsOcr'));
    assert.equal(copies(e).length, 0);
  });
});
