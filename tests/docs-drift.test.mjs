/**
 * 文件防漂移（Phase 1 PR 3）
 *
 * 為什麼有這批測試：
 *   docs/ 是給第一次接手的 Agent 用的地圖。地圖一旦跟程式對不上，比沒有地圖更危險——
 *   照著過期的 API 目錄或權限表改程式，會改壞看不見的地方。所以程式改了、文件沒跟上，
 *   這裡就紅燈，失敗訊息會說清楚「少了什麼、該補在哪個文件」。
 *
 *   只做靜態解析（讀原始碼文字），不執行任何 .gs 或前端程式；只用 Node 內建模組。
 *   七項檢查與它們「沒涵蓋到的地方」寫在 tests/README.md。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const GS_DIR = 'apps-script';
const gsFiles = readdirSync(join(ROOT, GS_DIR)).filter((f) => f.endsWith('.gs') && f !== 'build-info.gs').sort();
const gsSource = gsFiles.map((f) => read(join(GS_DIR, f))).join('\n');
const html = read('index.html');

/** `var NAME = '值';`（各 .gs 頂層常數）→ { NAME: 值 } */
const gsStringConsts = (() => {
  const out = {};
  for (const m of gsSource.matchAll(/^var ([A-Z][A-Z0-9_]*) = '([^']+)';/gm)) out[m[1]] = m[2];
  return out;
})();

/** 一個函式的本體（從 `function name(` 到下一個行首的 `}`） */
function functionBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, '找不到函式 ' + name + '：測試的解析方式需要跟著程式更新');
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

const missingFrom = (doc, items, wrap = (x) => '`' + x + '`') => items.filter((x) => !doc.includes(wrap(x)));

/* ========================================================================== */
describe('程式有的，文件都要有', () => {

  test('1. routePwaSync_ 的每個動作都在 docs/API.md', () => {
    const body = functionBody(read('apps-script/Code.gs'), 'routePwaSync_');
    const actions = [...new Set([...body.matchAll(/body\.action === '([A-Za-z0-9_]+)'/g)].map((m) => m[1]))].sort();
    assert.ok(actions.length >= 50, '應該解析得到所有動作（目前解析到 ' + actions.length + ' 個）');
    const missing = missingFrom(read('docs/API.md'), actions);
    assert.deepEqual(missing, [],
      'docs/API.md 少了這些 PWA 動作：' + missing.join('、') + '。請在 docs/API.md 對應的表格加一列（名稱、檔案與函式、參數、回應、權限、寫入、logs、效能）');
  });

  test('2. guideRegistry_() 登記的每張分頁都在 docs/DATA.md', () => {
    const body = functionBody(read('apps-script/sheet-guide.gs'), 'guideRegistry_');
    const sheets = [...body.matchAll(/\{ sheet: (?:'([^']+)'|([A-Z][A-Z0-9_]*))/g)].map((m) => {
      if (m[1]) return m[1];
      assert.ok(gsStringConsts[m[2]], 'guideRegistry_ 用到的常數 ' + m[2] + ' 解析不到值：測試的解析方式需要跟著程式更新');
      return gsStringConsts[m[2]];
    });
    assert.ok(sheets.length >= 25, '應該解析得到所有分頁（目前解析到 ' + sheets.length + ' 張）');
    const missing = missingFrom(read('docs/DATA.md'), sheets);
    assert.deepEqual(missing, [],
      'docs/DATA.md 少了這些分頁：' + missing.join('、') + '。請在 docs/DATA.md 的總表與「各分頁」各加一筆（用途、鍵欄、欄位、寫入者、讀取者、軟刪除、NO_PWA_*）');
  });

  test('3. 指令碼屬性鍵與 localStorage 鍵都在 docs/CONFIG.md（只寫名稱）', () => {
    const keys = new Set();
    // 字面字串：getProperty('KEY')
    for (const m of gsSource.matchAll(/(?:get|set|delete)Property\('([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
    // 經常數：getProperty(SOME_KEY) 或 getProperty(SOME_PREFIX + …)，常數要是 var NAME = '值'
    for (const m of gsSource.matchAll(/(?:get|set|delete)Property\(([A-Z][A-Z0-9_]*)\b/g)) {
      if (gsStringConsts[m[1]]) keys.add(gsStringConsts[m[1]]);
    }
    // AI 供應商表的 keyProp／modelProp（ai.gs）
    for (const m of gsSource.matchAll(/(?:keyProp|modelProp): '([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
    // 前端：*_KEY = '鍵'
    const lsKeys = [...html.matchAll(/\b[A-Z0-9_]+_KEY\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(keys.size >= 20, '應該解析得到所有指令碼屬性鍵（目前 ' + keys.size + ' 個）');
    assert.ok(lsKeys.length >= 10, '應該解析得到所有 localStorage 鍵（目前 ' + lsKeys.length + ' 個）');
    const doc = read('docs/CONFIG.md');
    // 前綴型的鍵（apid_、apiq_、perfq_）在文件裡寫成 `apid_<日期>`，所以只比對開頭
    const missingProps = [...keys].sort().filter((k) => !doc.includes('`' + k));
    const missingLs = lsKeys.filter((k) => !doc.includes('`' + k + '`'));
    assert.deepEqual(missingProps, [],
      'docs/CONFIG.md 少了這些指令碼屬性鍵：' + missingProps.join('、') + '。請加進「Apps Script 指令碼屬性」的表格（只寫名稱與用途，不寫值）');
    assert.deepEqual(missingLs, [],
      'docs/CONFIG.md 少了這些 localStorage 鍵：' + missingLs.join('、') + '。請加進「前端 localStorage」的表格');
  });

  test('4. 每個測試檔都在 tests/README.md', () => {
    const files = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
    const missing = missingFrom(read('tests/README.md'), files);
    assert.deepEqual(missing, [],
      'tests/README.md 少了這些測試檔：' + missing.join('、') + '。請在「測試檔對照」表加一列（測試檔、模組、測什麼）');
  });

  test('5. 程式引用到的每個 ADR 都在 docs/adr/README.md', () => {
    const refs = [...new Set([...(html + '\n' + gsSource).matchAll(/ADR-(\d{3})/g)].map((m) => 'ADR-' + m[1]))].sort();
    assert.ok(refs.length >= 15, '應該解析得到程式引用的 ADR（目前 ' + refs.length + ' 個）');
    const missing = missingFrom(read('docs/adr/README.md'), refs, (x) => '| ' + x + ' |');
    assert.deepEqual(missing, [],
      'docs/adr/README.md 的索引表少了：' + missing.join('、') + '。請在索引表加一列（ADR、主題、狀態與關係）');
  });

  test('6. 每支 apps-script/*.gs 都在 docs/MODULES.md', () => {
    assert.ok(gsFiles.length >= 10, '應該找得到所有 .gs（目前 ' + gsFiles.length + ' 支）');
    const missing = missingFrom(read('docs/MODULES.md'), gsFiles);
    assert.deepEqual(missing, [],
      'docs/MODULES.md 少了這些後端檔案：' + missing.join('、') + '。請加進「後端檔案一覽」並寫明屬於哪些模組');
  });
});

/* ========================================================================== */
describe('公開資訊基本防線', () => {

  /** AGENTS.md 與 docs/ 底下的所有檔案（相對路徑） */
  function publicDocs() {
    const out = ['AGENTS.md'];
    const walk = (dir) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const p = join(dir, name);
        if (statSync(join(ROOT, p)).isDirectory()) walk(p); else out.push(p);
      }
    };
    walk('docs');
    return out;
  }

  /*
   * 只用「形狀」判斷，刻意不放任何私人名單或關鍵字清單——
   * 名單本身寫進公開 repo，就等於把要保護的東西公開了。
   */
  const RULES = [
    { what: 'LINE userId／群組 ID 形狀的字串（U 或 C 開頭加 32 個十六進位字元）', re: /\b[UC][0-9a-f]{32}\b/g },
    { what: 'example.com／example.org 以外的 email', re: /[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9-]+\.)*example\.(?:com|org)\b)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g },
    { what: 'Apps Script 部署或專案網址的 ID', re: /script\.google\.com\/(?:a\/[^/\s]+\/)?(?:macros\/s|d|home\/projects)\/[A-Za-z0-9_-]{20,}/g },
    { what: '試算表／文件／雲端硬碟網址的 ID', re: /(?:docs|drive)\.google\.com\/[^\s)]*?\/(?:d|folders)\/[A-Za-z0-9_-]{20,}/g }
  ];

  test('7. AGENTS.md 與 docs/ 不出現私人識別碼的形狀', () => {
    const hits = [];
    for (const file of publicDocs()) {
      const text = read(file);
      for (const rule of RULES) {
        for (const m of text.matchAll(rule.re)) hits.push(relative(ROOT, join(ROOT, file)) + '：' + rule.what + '（第 ' + (text.slice(0, m.index).split('\n').length) + ' 行）');
      }
    }
    assert.deepEqual(hits, [],
      '公開文件裡出現了私人識別碼的形狀，請改成角色代稱或保留網域（example.com），值放到指令碼屬性或私人筆記：\n' + hits.join('\n'));
  });
});
