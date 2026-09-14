#!/usr/bin/env node
/**
 * 掃描 apps-script/ 有沒有把密鑰寫死在原始碼裡。
 *
 * 【為什麼需要這支】
 * clasp pull 是下載覆蓋。線上版曾經（也可能再度）把 CLOUD_SECRET 與 LINE
 * userId 白名單寫死在 .gs 裡，pull 一跑就會把 repo 裡的無密鑰版本蓋掉。
 * 這個 repo 是公開的，而 git history 洗不掉——所以危險的那一刻不是部署，
 * 是「pull 完順手 commit」。這支就掛在 pull 後面，在那一刻出聲。
 *
 * 【判斷方式】
 * 只看「賦值給看起來像密鑰的變數名，右邊是字串或陣列字面值」。
 * 讀指令碼屬性（PropertiesService.getScriptProperties()）不算，那正是我們要的寫法。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

const DIR = process.argv[2] || 'apps-script';
const SCANNABLE = /\.(gs|js|ts|html)$/;

/** 變數名看起來像密鑰，且右邊是非空字串字面值 */
const SECRETISH_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|_API_KEY|APIKEY|PRIVATE_KEY)/i;
const ASSIGN_STRING = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(['"])(.+?)\2\s*;?\s*$/;
/** 白名單陣列裡塞了真的 LINE userId（U + 32 位十六進位） */
const LINE_ID_ARRAY = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*\[\s*['"](U[0-9a-f]{32})['"]/i;

const mask = (s) => (s.length <= 4 ? '***' : s.slice(0, 2) + '***' + s.slice(-2));

if (!existsSync(DIR)) {
  console.error(`${RED}✖ 找不到目錄 ${DIR}${RESET}`);
  process.exit(1);
}

const findings = [];
for (const file of readdirSync(DIR).filter((f) => SCANNABLE.test(f))) {
  const path = join(DIR, file);
  readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    // 讀屬性是正解，不是問題
    if (/getProperty\s*\(/.test(line)) return;

    const str = line.match(ASSIGN_STRING);
    if (str && SECRETISH_NAME.test(str[1])) {
      findings.push({ path, line: i + 1, name: str[1], value: mask(str[3]), why: '密鑰寫死成字串' });
      return;
    }
    const id = line.match(LINE_ID_ARRAY);
    if (id) {
      findings.push({ path, line: i + 1, name: id[1], value: mask(id[2]), why: 'LINE userId 寫死在陣列裡' });
    }
  });
}

if (!findings.length) {
  console.log(`${GREEN}✔ ${DIR}/ 沒有寫死的密鑰${RESET}`);
  process.exit(0);
}

console.error(`${RED}✖ 在 ${DIR}/ 找到寫死的密鑰，請勿 commit${RESET}\n`);
for (const f of findings) {
  console.error(`  ${f.path}:${f.line}  ${f.name} = ${f.value}   ← ${f.why}`);
}
console.error(
  `\n${YELLOW}這個 repo 是公開的，commit 上去之後 git history 洗不掉。${RESET}\n\n` +
    '多半是 clasp pull 把線上版蓋回來了。正確做法：\n' +
    '  1. 保留 repo 裡讀指令碼屬性的版本（git checkout -- apps-script/）\n' +
    '  2. 線上那份也改成讀指令碼屬性，部署新版本\n' +
    '  3. 兩邊一致之後，pull 下來就不會再有這個警告\n'
);
process.exit(1);
