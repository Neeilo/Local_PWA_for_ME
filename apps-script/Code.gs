/**
 * Neil OS — PWA ↔ Google Sheets 同步（Apps Script 端）
 * ---------------------------------------------------------------------------
 * doGet  : 讀取一張分頁
 * doPost : 由 line-router.gs 依 payload 形狀分流後呼叫 handlePwaSync_
 */

/**
 * 同步密鑰改讀指令碼屬性，不寫在原始碼裡。
 *
 * 這份程式碼鏡像進公開的 GitHub repo，寫死等於把鑰匙貼在大門上，而且 git
 * history 洗不掉。比照 LINE_CHANNEL_ACCESS_TOKEN 與 GEMINI_API_KEY 的既有
 * 慣例：伺服器端用得到的密鑰，一律放指令碼屬性。
 *
 * 設定：專案設定 → 指令碼屬性 → CLOUD_SECRET = 與 GitHub Secret 同一個值
 * （從網頁複製常會帶到換行或空白，前後修掉，比照 LINE 權杖的處理）
 */
function cloudSecret_() {
  const raw = PropertiesService.getScriptProperties().getProperty('CLOUD_SECRET');
  return raw ? String(raw).trim() : '';
}

// ===== 讀取：GET /exec?sheet=tasks =====
function doGet(e) {
  const sheetName = e.parameter.sheet;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return jsonOut({ error: 'sheet_not_found', sheet: sheetName });

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return jsonOut({ data: [] });

  const headers = values[0];
  const rows = values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return jsonOut({ data: rows });
}

// ===== 寫入：POST body = { secret, sheet, action, ... } =====
function handlePwaSync_(e) {
  const body = JSON.parse(e.postData.contents);

  const secret = cloudSecret_();
  if (!secret) {
    // 讀不到就一律拒絕。fail-open 等於把門直接拆掉——寧可同步壞掉讓人發現，
    // 也不能安靜地變成「誰都能寫」。
    console.log('❌ 指令碼屬性 CLOUD_SECRET 不存在或是空字串，所有寫入一律拒絕');
    return jsonOut({ error: 'server_misconfigured' });
  }
  if (body.secret !== secret) return jsonOut({ error: 'unauthorized' });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(body.sheet);
  if (!sheet) return jsonOut({ error: 'sheet_not_found' });

  if (body.action === 'append') {
    const headers = sheetHeaders_(sheet);
    return jsonOut(upsertRow_(sheet, headers, body.record || {}, body.sheet));
  }

  if (body.action === 'replaceAll') {
    const records = body.records || [];
    const deduped = dedupeById_(records);

    sheet.clearContents();
    sheet.appendRow(body.headers);
    deduped.kept.forEach(r => sheet.appendRow(body.headers.map(h => r[h] ?? '')));

    if (deduped.dropped.length) {
      logCleanup_(
        'replaceAll ' + body.sheet,
        '去重：' + records.length + ' 筆收斂為 ' + deduped.kept.length + ' 筆',
        '丟棄的重複 id：' + summarizeIds_(deduped.dropped)
      );
    }
    return jsonOut({
      success: true,
      count: deduped.kept.length,
      dropped: deduped.dropped.length
    });
  }

  return jsonOut({ error: 'unknown_action' });
}

/* ========================================================================== */
/* 同 id 去重閘門（ADR-007 票 A，位置依 Part G-2 修正）                        */
/* ========================================================================== */

/**
 * ADR 原本把閘門設計在「更新流程的無條件 append」上，但實讀程式碼後發現前端
 * 從未使用 append —— 它只送 replaceAll，而 replaceAll 是整張表砍掉重寫。
 * 所以後端並沒有製造重複，它只是忠實地把 state 裡的重複寫出來。閘門因此改放
 * 在 replaceAll：寫入前收斂，髒資料在下次同步時自動消失。
 *
 * ⚠️ 這仍然不是根治。「本機為何先生出兩筆同 id」未解（ADR-007 Part F 未來票），
 * 前端的 dedupeState() 與這裡都是在攔截症狀，只是攔在不同層。
 *
 * 規則與前端 dedupeById() 一字不差：同 id 留「後者」（視為較新的編輯）、位置
 * 維持、沒有 id 的資料原樣保留——把它們當成同一筆併掉會是真正的資料遺失。
 * 兩邊規則若不一致，同一批資料在前後端會收斂成不同結果，那種 bug 最難查。
 */
function dedupeById_(records) {
  const lastIndexById = {};
  const idOf = r => (r && r.id != null && r.id !== '') ? String(r.id) : '';

  records.forEach((r, i) => {
    const id = idOf(r);
    if (id) lastIndexById[id] = i;
  });

  const kept = [], dropped = [];
  records.forEach((r, i) => {
    const id = idOf(r);
    if (!id || lastIndexById[id] === i) kept.push(r);
    else dropped.push(id);
  });
  return { kept: kept, dropped: dropped };
}

/**
 * 以 id 定位既有列 → 覆蓋；找不到才 append（ADR-007 票 A）。
 * 遇到多筆同 id：覆蓋第一筆、刪除其餘，並寫進 logs——讓系統自帶清理能力。
 *
 * 比對方式是「id 欄整欄一次撈進記憶體再線性搜尋」。不建索引、不維護對照表：
 * 資料量以百為單位，簡單優先。
 *
 * 找不到 id 欄、或這筆記錄沒有 id 時，退回單純 append 但**留一行 console**。
 * 靜默失敗在這個專案已經貴過三次了。
 */
function upsertRow_(sheet, headers, record, sheetName) {
  const row = headers.map(h => record[h] ?? '');
  const idCol = headers.indexOf('id') + 1;               // 1-based；0 代表找不到
  const recId = (record.id != null && record.id !== '') ? String(record.id) : '';

  if (idCol === 0 || !recId) {
    console.log('upsert 退回 append（' +
      (idCol === 0 ? '分頁「' + sheetName + '」沒有 id 欄' : '這筆記錄沒有 id') + '）');
    sheet.appendRow(row);
    return { success: true, row: sheet.getLastRow(), updated: false, cleaned: 0 };
  }

  const matches = findRowsById_(sheet, idCol, recId);
  if (!matches.length) {
    sheet.appendRow(row);
    return { success: true, row: sheet.getLastRow(), updated: false, cleaned: 0 };
  }

  const target = matches[0];
  sheet.getRange(target, 1, 1, headers.length).setValues([row]);

  // 由下往上刪，否則刪掉一列之後下面的列號會整個位移，刪錯人
  const extras = matches.slice(1).sort((a, b) => b - a);
  extras.forEach(r => sheet.deleteRow(r));

  if (extras.length) {
    logCleanup_(
      'upsert ' + sheetName + ' id=' + recId,
      '覆蓋第 ' + target + ' 列，刪除重複 ' + extras.length + ' 列',
      '刪除的列號：' + extras.slice().sort((a, b) => a - b).join(', ')
    );
  }
  return { success: true, row: target, updated: true, cleaned: extras.length };
}

/** 回傳 id 欄等於 recId 的所有列號（1-based，含表頭偏移） */
function findRowsById_(sheet, idCol, recId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  const matches = [];
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === recId) matches.push(i + 2);
  }
  return matches;
}

/** 表頭列。欄序不寫死，日後在 Sheet 調整欄位順序也不必回頭改程式 */
function sheetHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
}

/**
 * 自動清理必須留下記錄，不可靜默刪列（ADR-007 E-3 §3）。
 *
 * 借用 line-router.gs 的 logTransaction_（同一個 Apps Script 專案共用全域範圍）。
 * 整支包在 try/catch 裡：log 是事後回頭查的東西，不是交易本身——寫 log 失敗
 * 不該讓一次已經成功的同步變成失敗。
 *
 * source 寫「同步」：前端 LOG 頁的來源篩選鈕只有任務／記帳／收入／查詢四種，
 * 這一類會出現在「全部」底下而沒有專屬按鈕。這是刻意的——它不是使用者輸入的
 * 交易，不該跟那四種混在同一排篩選鈕裡。
 */
function logCleanup_(input, result, detail) {
  try {
    logTransaction_('同步', '成功', input, result, detail, '', '');
  } catch (err) {
    console.log('寫 logs 失敗（主流程不受影響）：' + err);
  }
}

/** id 太多時只列前幾個，避免 logs 的 detail 欄爆掉 */
function summarizeIds_(ids) {
  const MAX = 10;
  return ids.length <= MAX
    ? ids.join(', ')
    : ids.slice(0, MAX).join(', ') + ' …（共 ' + ids.length + ' 筆）';
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
