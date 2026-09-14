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
    const headers = sheet.getDataRange().getValues()[0];
    sheet.appendRow(headers.map(h => body.record[h] ?? ''));
    return jsonOut({ success: true });
  }

  if (body.action === 'replaceAll') {
    sheet.clearContents();
    sheet.appendRow(body.headers);
    body.records.forEach(r => sheet.appendRow(body.headers.map(h => r[h] ?? '')));
    return jsonOut({ success: true, count: body.records.length });
  }

  return jsonOut({ error: 'unknown_action' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
