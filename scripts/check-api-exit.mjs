#!/usr/bin/env node
/**
 * ADR-022 D-10：外部呼叫只准走 callApi_／callApiAll_（apps-script/api-cost.gs）。
 *
 * 為什麼要擋：記帳靠唯一出口。有人在別的地方直接 UrlFetchApp.fetch，那個 API 的次數與費用就
 * 默默不見了——「💸 用量與成本」看起來正常，其實少算。靠記性擋不住，交給 PR 檢查。
 *
 * 規則：.gs 裡任何一行程式（不是註解行）出現 UrlFetchApp，所在的頂層函式必須是 callApi_ 或 callApiAll_。
 * 連「存到變數」（var f = UrlFetchApp）也算，不然換個名字就繞過去了。
 * 判斷所在函式：往上找最近一個從行首開始的「function 名稱(」——GAS 的函式都寫在頂層。
 *
 * 用法：node scripts/check-api-exit.mjs apps-script
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = ['callApi_', 'callApiAll_'];
const dir = process.argv[2] || 'apps-script';
const bad = [];

for (const name of readdirSync(dir).filter((n) => n.endsWith('.gs')).sort()) {
  const lines = readFileSync(join(dir, name), 'utf8').split('\n');
  let fn = '';
  let inBlock = false;
  lines.forEach((line, i) => {
    const head = /^function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (head) fn = head[1];
    const t = line.trim();
    const comment = inBlock || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
    if (t.startsWith('/*') && !t.includes('*/')) inBlock = true;
    if (inBlock && t.includes('*/')) inBlock = false;
    if (comment) return;
    const code = line.replace(/\/\/.*$/, '');          // 行尾註解（網址的 // 在字串裡，但那行不會同時有 UrlFetchApp）
    if (!/\bUrlFetchApp\b/.test(code)) return;
    if (ALLOWED.includes(fn)) return;
    bad.push(`${name}:${i + 1}（${fn || '頂層'}）：${t}`);
  });
}

if (bad.length) {
  console.error('✖ UrlFetchApp 只准出現在 callApi_／callApiAll_（apps-script/api-cost.gs）。下面這些請改成 callApi_(\'<api_id>\', url, options, meta)：\n');
  bad.forEach((b) => console.error('  ' + b));
  console.error('\n新的 API 記得也登記到 apiCatalog_()，有額度或單價就在初始化的價目表補一列。');
  process.exit(1);
}
console.log('✔ 外部呼叫都走 callApi_');
