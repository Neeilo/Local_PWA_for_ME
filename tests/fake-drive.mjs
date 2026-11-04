/**
 * ADR-024 圖片辨識測試共用的假雲端硬碟與假 Drive API（文字辨識探針、📝 文字辨識、🤖 AI 辨識都用）。
 * 只假到夠用：檔案有名字、類型、內容；Drive API 只認 copy／export／delete 三種請求，其餘一律丟例外
 * （測試沒預期到的請求不能默默過關）。
 */

/** 假雲端硬碟：檔案 id → { name, mime }；資料夾 id → 檔名清單 */
export function fakeDrive(files, folders = {}) {
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
export function fakeDriveApi(texts, { deleteFails = false } = {}) {
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

