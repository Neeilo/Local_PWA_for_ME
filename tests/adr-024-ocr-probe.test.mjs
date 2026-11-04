/**
 * ADR-024 PR-0：Drive 文字辨識探針 probeClipOcr()（apps-script/lab-clip.gs）＋共用的 clipOcrImage_（clips.gs）
 *
 * 為什麼有這批測試：探針給 Neil 在 GAS 編輯器手動跑，真正的答案（繁中辨識品質、每張多久）要等實測。
 * 這裡盯的是探針與它共用的那一份辨識函式「不會做錯事」——PR-A 的 📝 文字辨識直接用同一支：
 *   1. 外部呼叫全走 callApi_('drive_ocr', …)（記帳不漏），授權只放 header、不印出來
 *   2. 做法：files.copy 轉成 Google 文件（帶 ocrLanguage）→ export 純文字 → **永久刪除**暫存文件
 *   3. 暫存文件不論成功失敗都要刪（export 失敗、回應壞掉也一樣）；刪不掉要明講殘留，不默默留著佔空間
 *   4. 讀不到字＝「（無文字）」，不是失敗
 *   5. 探針不寫 Sheet、不碰 LINE；沒設 CLIP_OCR_PROBE_ID 就講明、不亂跑
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const OAUTH = 'ya29.should-never-be-logged';
const FOLDER = '1JYKjruBpts_x_BG0-hKljnUlEar6lCFF';

/** 假雲端硬碟：檔案 id → { name, mime }；資料夾 id → 檔名清單 */
function fakeDrive(files, folders = {}) {
  const file = (id) => {
    const f = files[id];
    if (!f) throw new Error('找不到檔案 ' + id);
    return { getId: () => id, getName: () => f.name, getMimeType: () => f.mime || 'image/jpeg',
      getBlob: () => ({ getBytes: () => [1, 2, 3], getContentType: () => f.mime || 'image/jpeg' }) };
  };
  return {
    getRootFolder: () => ({}),
    getFileById: file,
    getFolderById: (id) => {
      if (!folders[id]) throw new Error('找不到資料夾 ' + id);
      const list = folders[id].map(file);
      let i = 0;
      return { getId: () => id, getFiles: () => ({ hasNext: () => i < list.length, next: () => list[i++] }) };
    }
  };
}

/**
 * 假 Drive API。texts：原檔 id → 辨識出的文字（null＝copy 失敗、'EXPORT_FAIL'＝export 失敗）。
 * 每次 copy 造一份暫存文件 doc_<原檔>，記在 live；DELETE 才移除
 */
function fakeDriveApi(texts, { deleteFails = false } = {}) {
  const calls = [];
  const live = new Set();
  const resp = (status, body) => ({ getResponseCode: () => status, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  return {
    calls, live,
    UrlFetchApp: {
      fetch: (url, opts = {}) => {
        calls.push({ url, opts });
        const copy = /\/drive\/v3\/files\/([^/?]+)\/copy\?/.exec(url);
        if (copy) {
          const src = decodeURIComponent(copy[1]);
          if (texts[src] === null) return resp(403, { error: { message: 'insufficientPermissions' } });
          live.add('doc_' + src);
          return resp(200, { id: 'doc_' + src });
        }
        const exp = /\/drive\/v3\/files\/([^/?]+)\/export\?/.exec(url);
        if (exp) {
          const src = decodeURIComponent(exp[1]).replace(/^doc_/, '');
          if (texts[src] === 'EXPORT_FAIL') return resp(500, 'backend error');
          return resp(200, '﻿' + texts[src]);
        }
        const del = /\/drive\/v3\/files\/([^/?]+)$/.exec(url);
        if (del && opts.method === 'delete') {
          if (deleteFails) return resp(500, 'nope');
          live.delete(decodeURIComponent(del[1]));
          return resp(204, '');
        }
        throw new Error('沒預期的請求：' + url);
      }
    }
  };
}

function env({ texts = {}, files = {}, folders = {}, clipsRows = [], props = {}, deleteFails = false } = {}) {
  const api = fakeDriveApi(texts, { deleteFails });
  const H = ['id', 'line_id', 'url', 'kind', 'status', 'drive_folder_id', 'image_ids', 'del'];
  const clips = new FakeSheet('clips', [H].concat(clipsRows.map((r) => H.map((h) => (r[h] == null ? '' : r[h])))));
  const e = loadCodeGs({
    cache: true, extraFiles: ['lab-clip.gs'], sheets: { clips }, properties: props,
    overrides: { UrlFetchApp: api.UrlFetchApp, DriveApp: fakeDrive(files, folders), clipOcrToken_: () => OAUTH }
  });
  e.api = api;
  return e;
}

const IMG = { f1: { name: '01.jpg' }, f2: { name: '02.jpg' }, f3: { name: '03.png', mime: 'image/png' } };

/* ========================================================================== */
describe('clipOcrImage_：一張圖 → 文字（PR-A 共用）', () => {
  test('copy 轉 Google 文件（帶 zh-TW）→ export 純文字 → 永久刪除；授權只在 header', () => {
    const e = env({ texts: { f2: '提示詞：請幫我寫\n第二行' }, files: IMG });
    const r = e.call('clipOcrImage_', 'f2', OAUTH);
    assert.equal(r.ok, true);
    assert.equal(r.text, '提示詞：請幫我寫\n第二行', 'BOM 與前後空白去掉');
    assert.equal(r.cleaned, true);
    const [copy, exp, del] = e.api.calls;
    assert.match(copy.url, /\/drive\/v3\/files\/f2\/copy\?ocrLanguage=zh-TW/);
    assert.equal(copy.opts.method, 'post');
    assert.equal(JSON.parse(copy.opts.payload).mimeType, 'application/vnd.google-apps.document');
    assert.match(exp.url, /\/files\/doc_f2\/export\?mimeType=text%2Fplain/);
    assert.equal(del.opts.method, 'delete', '永久刪除，不是丟垃圾桶');
    e.api.calls.forEach((c) => {
      assert.equal(c.opts.headers.Authorization, 'Bearer ' + OAUTH);
      assert.ok(!c.url.includes(OAUTH), 'token 不進網址');
    });
    assert.equal(e.api.live.size, 0, '暫存文件無殘留');
    assert.ok(!e.logs.join('\n').includes(OAUTH), 'token 不進執行記錄');
  });

  test('讀不到字＝「（無文字）」，算成功', () => {
    const e = env({ texts: { f1: '  \n ' }, files: IMG });
    const r = e.call('clipOcrImage_', 'f1', OAUTH);
    assert.equal(r.ok, true);
    assert.equal(r.text, '（無文字）');
  });

  test('export 失敗：回失敗＋原因，暫存文件照樣刪掉', () => {
    const e = env({ texts: { f1: 'EXPORT_FAIL' }, files: IMG });
    const r = e.call('clipOcrImage_', 'f1', OAUTH);
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
    assert.equal(r.cleaned, true);
    assert.equal(e.api.live.size, 0);
  });

  test('copy 就失敗：沒有暫存文件可刪，不多打 delete', () => {
    const e = env({ texts: { f1: null }, files: IMG });
    const r = e.call('clipOcrImage_', 'f1', OAUTH);
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 403/);
    assert.equal(e.api.calls.length, 1);
  });

  test('刪不掉：cleaned=false 並帶暫存文件 id，讓人知道要去清', () => {
    const e = env({ texts: { f1: '字' }, files: IMG, deleteFails: true });
    const r = e.call('clipOcrImage_', 'f1', OAUTH);
    assert.equal(r.ok, true);
    assert.equal(r.cleaned, false);
    assert.equal(r.leftover, 'doc_f1');
  });

  test('每個請求都走 callApi_ 記成 drive_ocr', () => {
    const e = env({ texts: { f1: '字' }, files: IMG });
    e.read('var __seen = []; var __real = callApi_; callApi_ = function (id, u, o, m) { __seen.push(id); return __real(id, u, o, m); }');
    e.call('clipOcrImage_', 'f1', OAUTH);
    assert.deepEqual(e.read('__seen'), ['drive_ocr', 'drive_ocr', 'drive_ocr']);
    assert.equal(e.read("apiCatalog_().drive_ocr.billing"), 'count', '只記次數');
  });
});

/* ========================================================================== */
describe('clipImageList_：要辨識哪些圖（PR-A 共用）', () => {
  test('image_ids 有值：照檔名排序', () => {
    const e = env({ files: IMG });
    const list = e.call('clipImageList_', { image_ids: JSON.stringify(['f3', 'f1', 'f2']) });
    assert.deepEqual(list.map((x) => x.name), ['01.jpg', '02.jpg', '03.png']);
  });

  test('image_ids 空：從資料夾列 NN.ext 圖片（raw.json、content.md、video.mp4 不算）', () => {
    const files = Object.assign({}, IMG, { raw: { name: 'raw.json', mime: 'application/json' }, md: { name: 'content.md', mime: 'text/markdown' },
      vid: { name: 'video.mp4', mime: 'video/mp4' } });
    const e = env({ files, folders: { [FOLDER]: ['raw', 'f2', 'md', 'vid', 'f1'] } });
    const list = e.call('clipImageList_', { image_ids: '', drive_folder_id: FOLDER });
    assert.deepEqual(list.map((x) => x.name), ['01.jpg', '02.jpg']);
  });

  test('圖片被刪了：略過那張，不讓整篇炸掉', () => {
    const e = env({ files: IMG });
    const list = e.call('clipImageList_', { image_ids: JSON.stringify(['f1', 'gone']) });
    assert.deepEqual(list.map((x) => x.name), ['01.jpg']);
  });
});

/* ========================================================================== */
describe('probeClipOcr：編輯器手動跑，只印執行記錄', () => {
  test('沒設 CLIP_OCR_PROBE_ID：講明怎麼設，不打任何 API', () => {
    const e = env({ files: IMG });
    const r = e.call('probeClipOcr');
    assert.equal(r.ok, false);
    assert.match(e.logs.join('\n'), /CLIP_OCR_PROBE_ID/);
    assert.equal(e.api.calls.length, 0);
  });

  test('收藏 id：每張印字數與耗時，暫存無殘留；Sheet 一格不動', () => {
    const e = env({ texts: { f1: '', f2: '提示詞全文在這裡' }, files: IMG, props: { CLIP_OCR_PROBE_ID: 'c1' },
      clipsRows: [{ id: 'c1', line_id: 'U1', kind: 'post', status: 'done', drive_folder_id: FOLDER, image_ids: JSON.stringify(['f2', 'f1']) }] });
    const before = JSON.stringify(e.sheets.clips.values);
    const r = e.call('probeClipOcr');
    assert.equal(r.ok, true);
    assert.deepEqual(r.images.map((x) => [x.name, x.chars, x.cleaned]), [['01.jpg', 0, true], ['02.jpg', 8, true]]);
    r.images.forEach((x) => assert.equal(typeof x.ms, 'number'));
    const log = e.logs.join('\n');
    assert.match(log, /01\.jpg.*（無文字）/);
    assert.match(log, /02\.jpg.*8 字/);
    assert.match(log, /暫存文件無殘留/);
    assert.ok(!log.includes(OAUTH));
    assert.equal(JSON.stringify(e.sheets.clips.values), before, '探針不寫 Sheet');
    assert.equal(e.api.live.size, 0);
  });

  test('也收 Drive 資料夾 id（交棒頁建議的 denghao.0304 那篇）', () => {
    const e = env({ texts: { f1: '封面', f2: '內頁' }, files: IMG, folders: { [FOLDER]: ['f1', 'f2'] }, props: { CLIP_OCR_PROBE_ID: FOLDER } });
    const r = e.call('probeClipOcr');
    assert.equal(r.ok, true);
    assert.equal(r.images.length, 2);
  });

  test('一張失敗不中斷其他張；有殘留要大聲講', () => {
    const e = env({ texts: { f1: 'EXPORT_FAIL', f2: '字' }, files: IMG, props: { CLIP_OCR_PROBE_ID: FOLDER },
      folders: { [FOLDER]: ['f1', 'f2'] }, deleteFails: true });
    const r = e.call('probeClipOcr');
    assert.equal(r.images.length, 2);
    assert.equal(r.images[0].ok, false);
    assert.equal(r.images[1].ok, true);
    assert.match(e.logs.join('\n'), /殘留/);
  });

  test('找不到圖：講明，不打 API', () => {
    const e = env({ files: IMG, props: { CLIP_OCR_PROBE_ID: 'nope' } });
    const r = e.call('probeClipOcr');
    assert.equal(r.ok, false);
    assert.equal(e.api.calls.length, 0);
  });
});
