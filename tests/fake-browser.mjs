/**
 * 讓 index.html 裡的前端函式能在 Node 裡被測到。
 *
 * 【為什麼需要這個】
 * 理由與 fake-apps-script.mjs 一字不差：測抄出來的副本，兩份實作遲早漂移，
 * 到時候測到的就不是上線那份。所以這裡把 index.html 的 <script> 內容整段
 * 載進假環境，測的是使用者手機上真正會跑的那些函式。
 *
 * 【為什麼載得進去】
 * 那段腳本只有結尾的 `(function init(){ … })();` 是 IIFE，其餘全是頂層宣告。
 * 頂層的 function 在 vm 裡會變成全域屬性，拿得到；const 則靠同一個 context
 * 裡的後續運算讀。init() 會去碰真正的 DOM，所以載入前先把它切掉——那一段是
 * 開機流程，不是邏輯。
 *
 * 【假到什麼程度】
 * DOM 只假到「呼叫不會爆」的程度，不模擬渲染：這裡要驗的是資料與同步的決策
 * （送什麼上雲端、失敗怎麼辦、刪除怎麼記），不是畫面長相。畫面要靠真的開來看。
 */

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 跨 realm 正規化，理由同 fake-apps-script.mjs 的 toHost */
function toHost(v) {
  if (Array.isArray(v)) return Array.from(v, toHost);
  if (v === null || typeof v !== 'object') return v;
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object Date]') return new Date(v.getTime());
  if (tag !== '[object Object]') return v;
  const out = {};
  Object.keys(v).forEach((k) => { out[k] = toHost(v[k]); });
  return out;
}

/** 夠用就好的 localStorage：真的會存、真的讀得回來、清得掉 */
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map)
  };
}

/** 任何元素都回同一種空殼。它不渲染，只負責讓呼叫鏈不要斷掉 */
function makeElement() {
  const el = {
    value: '', textContent: '', innerHTML: '', hidden: false, checked: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, focus() {}, blur() {}, click() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    querySelector: () => makeElement(), querySelectorAll: () => []
  };
  return el;
}

/**
 * 把 index.html 的腳本載進假瀏覽器。
 *
 * fetchImpl 收到 (url, options)，回傳的東西會被當成 fetch 的結果。
 * 預設一律成功且回 {success:true}，個別測試再覆寫成失敗或慢回應。
 */
export function loadFrontend({ storage = {}, fetchImpl = null, now = null } = {}) {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const lines = html.split('\n');

  // <script> 在 675 行、init() 從 2074 行開始（1-based）。不寫死行號：找標記。
  const start = lines.findIndex((l) => l.trim() === '<script>');
  const initAt = lines.findIndex((l) => l.startsWith('(function init(){'));
  if (start < 0 || initAt < 0) throw new Error('找不到 <script> 或 init()，index.html 的結構變了');
  const source = lines.slice(start + 1, initAt).join('\n');

  const localStorage = makeStorage(storage);
  const calls = [];                 // 每一次 fetch 的記錄，斷言用
  const toasts = [];

  const doFetch = (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body, options });
    const custom = fetchImpl && fetchImpl({ url: String(url), body, options, calls });
    if (custom) return Promise.resolve(custom);
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) });
  };

  const documentStub = {
    getElementById: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    addEventListener() {},
    body: makeElement(),
    visibilityState: 'visible'
  };

  const context = createContext({
    console: { log() {}, warn() {}, error() {} },
    document: documentStub,
    localStorage,
    fetch: doFetch,
    navigator: { serviceWorker: undefined, onLine: true },
    location: { reload() {}, href: 'https://example.test/' },
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },   // 測試裡不等 debounce
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    alert() {}, confirm: () => true, prompt: () => null,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    Blob: class { constructor(parts) { this.parts = parts; } },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Map, Set, RegExp, Error, isNaN, isFinite, parseInt, parseFloat
  });
  context.window = context;
  context.globalThis = context;

  runInContext(source, context, { filename: 'index.html<script>' });

  // toast 會被大量呼叫，接起來讓測試看得到訊息，也避免它去碰 DOM
  context.toast = (msg) => { toasts.push(String(msg)); };

  if (now) context.__now = now;

  return {
    localStorage,
    calls,
    toasts,
    /** 呼叫腳本裡的函式 */
    call: (name, ...args) => {
      if (typeof context[name] !== 'function') throw new Error('找不到函式：' + name);
      return toHost(context[name].apply(context, args));
    },
    /** 呼叫後回傳原始值（需要 Promise 時用這個，Promise 不能跨 realm 複製） */
    callRaw: (name, ...args) => context[name].apply(context, args),
    /** 讀／寫腳本裡的頂層宣告 */
    read: (expr) => toHost(runInContext(expr, context)),
    raw: (expr) => runInContext(expr, context),
    set: (name, value) => { context[name] = value; },
    context
  };
}
