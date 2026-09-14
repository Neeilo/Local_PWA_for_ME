#!/usr/bin/env node
/**
 * clasp push 前置閘門 —— 防止「半套 repo 覆蓋掉完整線上專案」。
 *
 * 【誰會跑到這裡】
 * GitHub Actions 的 apps-script job（唯一的部署管道，ADR-007 D1）。
 * 本機也可以 `npm run preflight` 當乾跑，看這次會送出哪些檔案——但本機
 * 不 push：工作目錄可能有沒 commit 的東西，從那裡送出等於讓線上跑著
 * repo 裡沒有的程式，正是這套管道要消滅的問題本身。
 *
 * 【為什麼需要這支】
 * clasp push 是整個專案覆蓋，不是增量合併：rootDir 裡沒有的檔案，
 * 線上就會被刪掉。本 repo 一開始只鏡像了 line-router.gs，而線上還有
 * Code.gs（PWA 同步）。直接 push 會刪掉 Code.gs，讓 line-router.gs
 * 呼叫的 handlePwaSync_() 變成 undefined，兩套功能一起死。
 *
 * 【防線設計】
 * appsscript.json 只可能由一次成功的 clasp pull／clone 產生，而那次拉取
 * 必然同時把線上所有 .gs 抓下來。所以「appsscript.json 存在」就是
 * 「本地已是線上完整鏡像」的充分證據。用它當閘門，零誤判。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

function die(msg) {
  console.error(`${RED}✖ clasp preflight 擋下這次 push${RESET}\n\n${msg}\n`);
  process.exit(1);
}

// 1. 專案設定必須存在
if (!existsSync('.clasp.json')) {
  die(
    '找不到 .clasp.json。\n\n' +
      '本機：cp .clasp.json.example .clasp.json 後填入 Script ID\n' +
      '      （Apps Script 編輯器 → 專案設定 → 「指令碼 ID」）\n' +
      'CI  ：由 Secret CLASP_JSON 還原，跑到這裡代表該 Secret 是空的或不是合法 JSON。'
  );
}

let rootDir;
try {
  ({ rootDir } = JSON.parse(readFileSync('.clasp.json', 'utf8')));
} catch (err) {
  die(`.clasp.json 不是合法的 JSON：${err.message}`);
}

if (!rootDir) die('.clasp.json 缺少 rootDir 欄位（應為 "apps-script"）。');
if (!existsSync(rootDir)) die(`.clasp.json 的 rootDir 指向 "${rootDir}"，但該目錄不存在。`);

// 2. 核心防線：appsscript.json 必須存在，代表已經 pull 過完整專案
const manifest = join(rootDir, 'appsscript.json');
if (!existsSync(manifest)) {
  die(
    `${rootDir}/appsscript.json 不存在，代表本地「還不是」線上專案的完整鏡像。\n\n` +
      `${YELLOW}此時 push 會刪掉線上未被鏡像的檔案（例如 Code.gs），\n` +
      `連帶讓 line-router.gs 呼叫的 handlePwaSync_() 變成 undefined。${RESET}\n\n` +
      '這代表 ADR-007 的「基準對齊」還沒完成。請先把線上專案完整抓下來：\n' +
      '  npm run pull\n\n' +
      '確認 Code.gs 與 appsscript.json 都出現、git diff 看起來合理之後，commit 進 main。\n' +
      '管道會在那之後自己啟用，不需要再做別的事。'
  );
}

// 3. 資訊性輸出：這次會送出哪些檔案
const PUSHABLE = /\.(gs|js|ts|html)$|^appsscript\.json$/;
const files = readdirSync(rootDir).filter((f) => PUSHABLE.test(f));

console.log(`${GREEN}✔ clasp preflight 通過${RESET}`);
console.log(`  rootDir: ${rootDir}`);
console.log(`  將覆蓋線上專案為以下 ${files.length} 個檔案：`);
for (const f of files.sort()) console.log(`    - ${f}`);
console.log(`\n  ${YELLOW}提醒：push 是整包覆蓋，不在上面清單裡的線上檔案會被刪除。${RESET}\n`);
