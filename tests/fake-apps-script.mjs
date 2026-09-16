/**
 * 讓 Apps Script 的函式能在 Node 裡被測到。
 *
 * 【為什麼需要這個】
 * Apps Script 沒有 module.exports，函式靠全域範圍互相看見；而 SpreadsheetApp、
 * CacheService 這些東西只存在於 Google 的執行環境裡。要在 CI 上驗證邏輯，只有
 * 兩條路：把邏輯抄一份出來測（兩份實作遲早漂移，測的就不是上線那份了），或是
 * 把原始碼整份載進一個假環境裡測。這裡走第二條——測的就是 apps-script/Code.gs
 * 本人，一個字都沒有改寫。
 *
 * 【假到什麼程度】
 * 只假到夠用：Sheet 是一個二維陣列，getRange/setValues/appendRow/deleteRow 的
 * 列號語意與真的一致（1-based、含表頭偏移、刪列會位移）。那正是這次要驗的東西。
 * 樣式、公式、權限一概沒有——用不到的東西假得愈少，愈不會假出一個假的通過。
 */

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 空字串代表這一格沒東西，與 Sheet 讀回來的行為一致 */
const EMPTY = '';

/**
 * 把 vm 裡造出來的值搬回主程式這一側。
 *
 * vm.createContext 開的是另一個 realm：裡面的 [] 用的是那邊的 Array.prototype，
 * 跟這邊的不是同一個物件。結構一模一樣的兩個陣列，assert.deepStrictEqual 仍然會
 * 判定不相等（訊息長這樣：「Values have same structure but are not reference-equal」）。
 *
 * 所以在邊界上做一次結構複製。複製的是形狀與值，不改任何內容——測到的仍然是
 * Code.gs 真正回傳的東西，只是換了一副這邊認得的骨架。
 */
function toHost(v) {
  // 用這一側的 Array.from：對面陣列的 .map() 依 species 仍會造出對面的陣列
  if (Array.isArray(v)) return Array.from(v, toHost);            // Array.isArray 跨 realm 也準
  if (v === null || typeof v !== 'object') return v;
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object Date]') return new Date(v.getTime());
  if (tag !== '[object Object]') return v;
  const out = {};
  Object.keys(v).forEach((k) => { out[k] = toHost(v[k]); });
  return out;
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const source = this.sheet.values[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = source[this.col - 1 + c];
        line.push(v === undefined ? EMPTY : v);
      }
      out.push(line);
    }
    return out;
  }

  setValues(rows) {
    rows.forEach((line, r) => {
      const target = this.row - 1 + r;
      while (this.sheet.values.length <= target) this.sheet.values.push([]);
      const dest = this.sheet.values[target];
      line.forEach((v, c) => {
        const at = this.col - 1 + c;
        while (dest.length < at) dest.push(EMPTY);
        dest[at] = v;
      });
    });
    return this;
  }
}

export class FakeSheet {
  constructor(name, values = []) {
    this.name = name;
    this.values = values.map((r) => r.slice());
    this.deletedRows = [];
  }

  getName() {
    return this.name;
  }

  /** 最後一列「有東西」的列號。尾端空列不算，與真的 Sheet 一致 */
  getLastRow() {
    for (let r = this.values.length - 1; r >= 0; r--) {
      if ((this.values[r] || []).some((v) => v !== EMPTY && v !== undefined && v !== null)) return r + 1;
    }
    return 0;
  }

  getLastColumn() {
    let last = 0;
    this.values.forEach((row) => {
      (row || []).forEach((v, c) => {
        if (v !== EMPTY && v !== undefined && v !== null) last = Math.max(last, c + 1);
      });
    });
    return last;
  }

  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }

  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }

  appendRow(row) {
    this.values.length = this.getLastRow();
    this.values.push(Array.from(row));
    return this;
  }

  deleteRow(r) {
    this.deletedRows.push(r);
    this.values.splice(r - 1, 1);
  }

  clearContents() {
    this.values = [];
  }

  /** 測試用：把整張表讀成物件陣列，斷言時比對這個比比對二維陣列好讀 */
  toRecords() {
    const [headers, ...rows] = this.values;
    if (!headers) return [];
    return rows.map((row) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = row[i] === undefined ? EMPTY : row[i]; });
      return o;
    });
  }
}

class FakeSpreadsheet {
  constructor(sheets) {
    this.sheets = sheets;
  }

  getSheetByName(name) {
    return this.sheets[name] || null;
  }

  insertSheet(name) {
    this.sheets[name] = new FakeSheet(name);
    return this.sheets[name];
  }
}

/**
 * 把 Code.gs 整份載進假環境。
 *
 * 回傳的 call() 直接呼叫原始碼裡的函式，read() 讀得到頂層的 const
 * （vm 的頂層 const 不會變成全域屬性，但同一個 context 裡的後續運算看得見）。
 */
export function loadCodeGs({ sheets = {}, properties = {} } = {}) {
  const logs = [];              // console.log 的內容
  const transactions = [];      // logTransaction_ 收到的參數
  const ss = new FakeSpreadsheet(sheets);

  const context = createContext({
    console: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' '))
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k in properties ? properties[k] : null) })
    },
    CacheService: {
      getScriptCache: () => { throw new Error('測試不碰快取'); }
    },
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => ({ body: s }) }),
      MimeType: { JSON: 'application/json' }
    },
    UrlFetchApp: { fetch: () => { throw new Error('測試不發網路請求'); } },
    // line-router.gs 裡的函式，Code.gs 靠全域範圍看見它
    logTransaction_: (...args) => transactions.push(args),
    Date,
    Array,
    Object,
    Math,
    String,
    Number,
    JSON
  });

  runInContext(readFileSync(join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), context, { filename: 'Code.gs' });

  return {
    ss,
    sheets,
    logs,
    transactions,
    /** 呼叫 Code.gs 裡的函式，回傳值搬回這一側的 realm */
    call: (name, ...args) => toHost(context[name].apply(null, args)),
    /** 讀 Code.gs 裡的頂層宣告（含 const） */
    read: (expr) => toHost(runInContext(expr, context))
  };
}
