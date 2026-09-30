/**
 * 版本發行號與 Pages 發布清單的測試
 *
 * 盯兩件事：
 *   1. LINE 回「沒有這個前綴」時，最後一行要帶上線上後端的發行號。
 *      發行號由 CI 在 clasp push 前產生 apps-script/build-info.gs（不進 git）；
 *      讀不到時要明講「未知」，而不是安靜地什麼都不印——在編輯器手改過、
 *      或不是 CI 部署的版本，本身就是要被看見的警訊。
 *   2. GitHub Pages 改成白名單發布：只上傳 App 真的用得到的檔案。
 *      交接.md 就是在「整包上傳、只排除 apps-script/」的黑名單制下被公開的。
 *      白名單的風險反過來：新增資產卻忘了登記，線上就少一個檔。
 *      所以這裡交叉比對 sw.js、manifest.json、index.html 實際引用的檔案。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// 白名單模組還不存在時不要讓整個檔案載入失敗——那樣上面 LINE 的測試也看不到結果
let SITE_FILES = null;
try { ({ SITE_FILES } = await import('../scripts/site-files.mjs')); } catch { /* 由下方測試報紅 */ }

function loadLineRouter(buildInfo) {
  const context = createContext({
    console: { log: () => {}, error: () => {} },
    Date, Array, Object, Math, String, Number, JSON
  });
  // 模擬 GAS 的共用全域：build-info.gs 存在時，BUILD_INFO 就是一個頂層變數
  if (buildInfo !== undefined) context.BUILD_INFO = buildInfo;
  runInContext(read('apps-script/line-router.gs'), context, { filename: 'line-router.gs' });
  context.logTransaction_ = () => {};
  return (name, ...args) => context[name].apply(null, args);
}

/* ========================================================================== */
describe('LINE：沒有這個前綴時附上發行號', () => {

  test('有 BUILD_INFO：最後一行是「目前版本：#run · main@sha（時間）」', () => {
    const call = loadLineRouter({ run: '33', sha: 'abc1234', builtAt: '09-30 10:49' });
    const lines = call('routeLineMessage_', '亂打/123', 'U1').split('\n');
    assert.equal(lines[0], '沒有這個前綴喔。');
    assert.equal(lines[lines.length - 1], '目前版本：#33 · main@abc1234（09-30 10:49）');
  });

  test('沒有 BUILD_INFO（編輯器手改、非 CI 部署）：明講未知，不靜默', () => {
    const call = loadLineRouter();
    const lines = call('routeLineMessage_', '亂打/123', 'U1').split('\n');
    assert.match(lines[lines.length - 1], /^目前版本：未知/);
  });

  test('支援清單本身一字不改，版本只多一行在最後', () => {
    const call = loadLineRouter({ run: '33', sha: 'abc1234', builtAt: '09-30 10:49' });
    const reply = call('routeLineMessage_', '亂打/123', 'U1');
    assert.equal(reply, '沒有這個前綴喔。\n' + call('supportedPrefixesMessage_') +
      '\n目前版本：#33 · main@abc1234（09-30 10:49）');
  });

  test('只加在「沒有這個前綴」：空訊息的回覆不變', () => {
    const call = loadLineRouter({ run: '33', sha: 'abc1234', builtAt: '09-30 10:49' });
    assert.doesNotMatch(call('routeLineMessage_', '', 'U1'), /目前版本/);
  });
});

/* ========================================================================== */
describe('CI：build-info.gs 的產生與隔離', () => {
  const workflow = read('.github/workflows/deploy.yml');

  test('在 clasp push 之前產生 build-info.gs', () => {
    const gen = workflow.indexOf('apps-script/build-info.gs');
    const push = workflow.indexOf('npx clasp push');
    assert.ok(gen !== -1, 'workflow 要產生 apps-script/build-info.gs');
    assert.ok(gen < push, '要在 clasp push 之前產生，否則送上去的沒有它');
  });

  test('build-info.gs 不進 git（它是每次部署產生的，npm run pull 也會帶回來）', () => {
    assert.match(read('.gitignore'), /^apps-script\/build-info\.gs$/m);
  });
});

/* ========================================================================== */
describe('Pages：白名單發布', () => {

  test('白名單裡的每個檔案都真的存在', () => {
    assert.ok(Array.isArray(SITE_FILES) && SITE_FILES.length, 'scripts/site-files.mjs 要匯出 SITE_FILES');
    for (const f of SITE_FILES) assert.ok(existsSync(join(ROOT, f)), `找不到 ${f}`);
  });

  test('sw.js 預快取的每個資產都在白名單裡', () => {
    const assets = JSON.parse(read('sw.js').match(/const ASSETS = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
      .map((a) => a.replace(/^\.\//, '')).filter((a) => a);
    for (const a of assets) assert.ok(SITE_FILES.includes(a), `sw.js 會快取 ${a}，但它不會被發布`);
  });

  test('manifest.json 的 icon 都在白名單裡', () => {
    for (const { src } of JSON.parse(read('manifest.json')).icons) {
      assert.ok(SITE_FILES.includes(src), `manifest 引用 ${src}，但它不會被發布`);
    }
  });

  test('index.html 引用的本機檔案都在白名單裡', () => {
    const refs = [...read('index.html').matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0);
    for (const r of refs) assert.ok(SITE_FILES.includes(r), `index.html 引用 ${r}，但它不會被發布`);
  });

  test('不發布原始碼、文件與設定', () => {
    for (const f of SITE_FILES) {
      assert.doesNotMatch(f, /^(apps-script|tests|scripts|\.github)\//, `${f} 不該公開`);
      assert.doesNotMatch(f, /\.md$|^package|^\.clasp/, `${f} 不該公開`);
    }
  });

  test('workflow 上傳的是白名單產出的目錄，不是整個 repo', () => {
    const workflow = read('.github/workflows/deploy.yml');
    assert.match(workflow, /node scripts\/site-files\.mjs/);
    assert.doesNotMatch(workflow, /path:\s*\.\s*$/m, '還在整包上傳 repo 根目錄');
  });
});
