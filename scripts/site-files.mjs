#!/usr/bin/env node
/**
 * GitHub Pages 發布白名單：只上傳 App 真的用得到的檔案。
 *
 * 為什麼是白名單：原本是「整包上傳 repo、只排除 apps-script/」的黑名單制，
 * 新增任何檔案都會預設公開——交接.md 就是這樣被公開了約 3 天（2026-09-26～29）。
 * 白名單反過來：新增的檔案預設不公開，要發布就得在這裡登記。
 *
 * 忘了登記會怎樣：tests/build-info.test.mjs 會交叉比對 sw.js、manifest.json、
 * index.html 實際引用的檔案，漏了就紅燈，CI 不會部署。
 *
 * 用法（CI 的 Pages job）：node scripts/site-files.mjs <輸出目錄>
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE_FILES = [
  'index.html',
  'sw.js',
  'manifest.json',
  'neilos-icon.svg',
  'neilos-icon-192.png',
  'neilos-icon-512.png',
  'neilos-icon-ios-180.png'
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('用法：node scripts/site-files.mjs <輸出目錄>');
    process.exit(1);
  }
  const missing = SITE_FILES.filter((f) => !existsSync(f));
  if (missing.length) {
    console.error('✖ 白名單裡的檔案不存在，停止發布：\n  ' + missing.join('\n  '));
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  for (const f of SITE_FILES) copyFileSync(f, join(outDir, f));
  console.log(`✔ 已複製 ${SITE_FILES.length} 個檔案到 ${outDir}：\n  ` + SITE_FILES.join('\n  '));
}
