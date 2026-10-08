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
import { createHash, randomUUID } from 'node:crypto';

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
        dest[at] = this.sheet.coerce(v, at + 1);
      });
    });
    return this;
  }

  /** 只認 '@'（純文字）：那幾欄寫進去的字串不再被轉成數字 */
  setNumberFormat(fmt) {
    if (fmt === '@') for (let c = 0; c < this.numCols; c++) this.sheet.textCols.add(this.col + c);
    return this;
  }
}

export class FakeSheet {
  constructor(name, values = [], { autoNumber = false } = {}) {
    this.name = name;
    this.values = values.map((r) => r.slice());
    this.deletedRows = [];
    // autoNumber：模擬真的 Sheet 把「全是數字的字串」自動轉成數字（'0050' 會變成 50）。
    // 預設關著，既有測試的行為不變；要驗「開頭的 0 會不會被吃掉」的測試才打開
    this.autoNumber = autoNumber;
    this.textCols = new Set();
  }

  /**
   * 寫進一格時真的 Sheet 會做的轉換（2026-10-08 實機踩到，對照 SO 56588933）：
   *  - 純文字欄（setNumberFormat('@')）＋ setValues：原樣存文字；開頭的 ' 會**照字面留下來**
   *  - 一般欄：開頭的 ' 代表強制文字（不會留在值裡）；全是數字的字串變成數字
   *  - appendRow **不管欄位格式**：純文字欄照樣被轉成數字（viaAppend）
   */
  coerce(v, col, viaAppend = false) {
    if (!this.autoNumber || typeof v !== 'string') return v;
    if (this.textCols.has(col) && !viaAppend) return v;
    if (v.startsWith("'")) return v.slice(1);
    return /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
  }

  getMaxRows() {
    return Math.max(this.values.length, this.maxRows || 1000);
  }

  insertRowsAfter(_after, n) {
    this.maxRows = this.getMaxRows() + n;
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
    this.values.push(Array.from(row, (v, i) => this.coerce(v, i + 1, true)));
    return this;
  }

  deleteRow(r) {
    this.deletedRows.push(r);
    this.values.splice(r - 1, 1);
  }

  /** 一次刪連續 n 列，列號語意同 deleteRow（刪完下面的列往上補） */
  deleteRows(r, n) {
    for (let i = 0; i < n; i++) this.deletedRows.push(r + i);
    this.values.splice(r - 1, n);
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

/**
 * CacheService 的假物件（ADR-010）。
 *
 * 配對碼只活在快取裡，所以這裡要假得比「呼叫不會爆」多一點：TTL 真的會到期
 * （時鐘由測試推進，不綁系統時間），而且可以把任何一個鍵**提早踢掉**——
 * 真的 CacheService 不保證存到 TTL，ADR-010 把「提早逐出」列為 Assumption，
 * 測試要能演出那個情境。
 */
export class FakeCache {
  constructor(clock) {
    this.clock = clock;
    this.map = new Map();
  }

  get(k) {
    const hit = this.map.get(k);
    if (!hit) return null;
    if (hit.until <= this.clock.now()) { this.map.delete(k); return null; }
    return hit.v;
  }

  put(k, v, ttl = 600) {
    this.map.set(k, { v: String(v), until: this.clock.now() + ttl * 1000 });
  }

  remove(k) {
    this.map.delete(k);
  }

  /** 測試用：模擬 Google 提早逐出（不等 TTL） */
  evict(prefix = '') {
    [...this.map.keys()].filter((k) => k.startsWith(prefix)).forEach((k) => this.map.delete(k));
  }

  /** 測試用：列出目前還活著的鍵 */
  keys(prefix = '') {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix) && this.get(k) !== null);
  }
}

class FakeSpreadsheet {
  constructor(sheets, autoNumber = false) {
    this.sheets = sheets;
    this.autoNumber = autoNumber;
  }

  getSheetByName(name) {
    return this.sheets[name] || null;
  }

  /** 依建立順序回傳所有分頁，與真的 Sheet 分頁列的順序一致 */
  getSheets() {
    return Object.values(this.sheets);
  }

  insertSheet(name) {
    this.sheets[name] = new FakeSheet(name, [], { autoNumber: this.autoNumber });
    return this.sheets[name];
  }
}

/**
 * 把 Code.gs 整份載進假環境。
 *
 * 回傳的 call() 直接呼叫原始碼裡的函式，read() 讀得到頂層的 const
 * （vm 的頂層 const 不會變成全域屬性，但同一個 context 裡的後續運算看得見）。
 */
export function loadCodeGs({ sheets = {}, properties = {}, pushImpl = null, extraFiles = [], cache = false, overrides = {}, mailImpl = null, tokens = {}, realLogs = false, autoNumber = false } = {}) {
  const logs = [];              // console.log 的內容
  const transactions = [];      // logTransaction_ 收到的參數
  const pushes = [];            // linePush_ 收到的 (userId, text)
  const mails = [];             // MailApp.sendEmail 收到的參數
  const lock = { held: false, busy: false };   // busy=true 模擬「另一個封存正在跑」
  const triggers = [];          // ScriptApp 建出來的觸發器
  const counters = { opens: 0 }; // getActiveSpreadsheet 被呼叫的次數
  // 預先發好的裝置 token：{ 'tok-neil': 'Uneil' }。ADR-010 關門後每個 PWA 請求都要帶 token，
  // 不在這裡發的話，每支測試都得先走一遍 LINE 配對。只存雜湊，跟正式的 pairClaim_ 一樣。
  const tokenIds = Object.keys(tokens);
  if (tokenIds.length && !sheets.line_devices) {
    const now = new Date().toISOString();
    sheets.line_devices = new FakeSheet('line_devices', [
      ['device_id', 'token_hash', 'line_id', 'device_label', 'created_at', 'last_used_at', 'revoked_at', 'revoked_by'],
      ...tokenIds.map((t, i) => ['dev-' + i, createHash('sha256').update(t, 'utf8').digest('hex'), tokens[t], '測試裝置', now, now, '', ''])
    ]);
  }
  // autoNumber：所有分頁都照真的 Sheet 把數字字串轉成數字（含之後 insertSheet 建的）
  if (autoNumber) Object.values(sheets).forEach((sh) => { sh.autoNumber = true; });
  const ss = new FakeSpreadsheet(sheets, autoNumber);

  // 快取預設關著（getScriptCache 丟例外），既有測試的行為一個字都不變。
  // 要測配對的才打開：配對碼只存在快取裡，沒有快取就沒有配對。
  const clock = { t: Date.UTC(2026, 8, 30, 1, 0, 0), now() { return this.t; }, advance(sec) { this.t += sec * 1000; } };
  const fakeCache = cache ? new FakeCache(clock) : null;

  /** line-router.gs 裡的推播函式。Code.gs 靠全域範圍看見它，這裡假一個 */
  const linePush_ = (to, text) => {
    pushes.push({ to, text });
    return pushImpl ? pushImpl({ to, text, pushes }) : { ok: true, code: 200, reason: '' };
  };

  /** 觸發器只記不真的排程——要驗的是「重複執行不會累積」這件事 */
  const makeTriggerBuilder = (fn) => {
    const spec = { handler: fn, hour: null, days: null };
    const builder = {
      timeBased: () => builder,
      atHour: (h) => { spec.hour = h; return builder; },
      everyDays: (d) => { spec.days = d; return builder; },
      everyHours: (h) => { spec.everyHours = h; return builder; },
      everyMinutes: (m) => { spec.everyMinutes = m; return builder; },
      nearMinute: (m) => { spec.minute = m; return builder; },
      create: () => { triggers.push(spec); return spec; }
    };
    return builder;
  };
  const ScriptApp = {
    getProjectTriggers: () => triggers.map((t) => ({
      getHandlerFunction: () => t.handler,
      __spec: t
    })),
    deleteTrigger: (t) => {
      const i = triggers.indexOf(t.__spec);
      if (i >= 0) triggers.splice(i, 1);
    },
    newTrigger: makeTriggerBuilder
  };

  const context = createContext({
    console: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' '))
    },
    // 開了幾次試算表（ADR-012：boot 要「只開一次」，這裡數得出來）
    SpreadsheetApp: { getActiveSpreadsheet: () => { counters.opens++; return ss; }, flush: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k in properties ? properties[k] : null) })
    },
    CacheService: {
      getScriptCache: () => { if (fakeCache) return fakeCache; throw new Error('測試不碰快取'); }
    },
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => ({ body: s }) }),
      MimeType: { JSON: 'application/json' }
    },
    UrlFetchApp: { fetch: () => { throw new Error('測試不發網路請求'); } },
    // 寄信只記錄、不真的寄；mailImpl 可以丟例外，模擬額度用完或沒授權
    MailApp: {
      sendEmail: (opts) => {
        if (mailImpl) mailImpl(opts);
        mails.push(opts);
      },
      getRemainingDailyQuota: () => 100
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (lock.busy) return false; lock.held = true; return true; },
        releaseLock: () => { lock.held = false; }
      })
    },
    // line-router.gs 裡的函式，Code.gs 靠全域範圍看見它們
    logTransaction_: (...args) => transactions.push(args),
    linePush_,
    ScriptApp,
    // 時間戳只要固定格式就好：要驗的是「有寫」，不是 Google 的時區換算
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    Utilities: {
      formatDate: () => '2026-09-23 06:00',
      getUuid: () => randomUUID(),
      // 真的 computeDigest 回的是 Java 的有號位元組（-128～127），照樣假，
      // 否則 tokenHash_ 裡「轉回 0～255」那一步就測不到
      computeDigest: (_alg, text) => Array.from(createHash('sha256').update(String(text), 'utf8').digest(),
        (b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      newBlob: (data, contentType, name) => ({ data: String(data), contentType, name }),
      Charset: { UTF_8: 'UTF_8' }
    },
    Date,
    Array,
    Object,
    Math,
    String,
    Number,
    JSON
  });

  runInContext(readFileSync(join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), context, { filename: 'Code.gs' });
  // 同一個 Apps Script 專案的其他檔案：線上是共用全域，這裡就載進同一個 context。
  // stock.gs 一律載入：Code.gs 的 boot／readMany／upsert 會呼叫它（ADR-015），線上它永遠在
  const files = ['stock.gs'].concat(extraFiles.filter((name) => name !== 'stock.gs'));
  files.forEach((name) => {
    runInContext(readFileSync(join(ROOT, 'apps-script', name), 'utf8'), context, { filename: name });
  });
  // line-router.gs 被載進來時會用真的 logTransaction_／linePush_ 蓋掉上面的記錄器。
  // 裝回去：測試要看的是「有沒有記」，不是記進 Sheet 的格式。其餘出口（例如
  // lineReply_）由 overrides 換成記錄器——函式呼叫在執行時才查全域，換掉的就是實際被呼叫的那個。
  // realLogs：保留 line-router.gs 真的 logTransaction_（寫進 logs 分頁），測「什麼時候寫」的時候用
  if (!realLogs) context.logTransaction_ = (...args) => transactions.push(args);
  context.linePush_ = linePush_;
  Object.assign(context, overrides);

  return {
    ss,
    sheets,
    logs,
    transactions,
    pushes,
    triggers,
    cache: fakeCache,
    mails,
    lock,
    clock,
    counters,
    /** 呼叫 Code.gs 裡的函式，回傳值搬回這一側的 realm */
    call: (name, ...args) => toHost(context[name].apply(null, args)),
    /** 讀 Code.gs 裡的頂層宣告（含 const） */
    read: (expr) => toHost(runInContext(expr, context))
  };
}
