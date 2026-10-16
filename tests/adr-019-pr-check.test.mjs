/**
 * ADR-019 E-1：PR 跑測試
 *
 * 原本只有 push 到 main 才跑 npm test，PR 本身沒有燈號——壞 PR 一樣能 merge，
 * 要等進了 main 才在部署前被擋下。這裡盯 PR 檢查的 workflow 三件事：
 *   1. 開 PR／推新 commit 就會跑（目標 main），而且跑的是 npm ci、npm test、npm run scan
 *   2. 不部署、不碰任何 secret——clasp 憑證只留在 main 的 deploy workflow。
 *      PR 的程式碼是還沒審過的，讓它摸得到憑證，等於把部署權交給還沒 merge 的東西
 *   3. job 名稱固定為 pr-check：分支保護是用名稱選它的，改名就會讓保護默默失效
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = '.github/workflows/pr-check.yml';
const workflow = existsSync(join(ROOT, PATH)) ? readFileSync(join(ROOT, PATH), 'utf8') : '';

describe('ADR-019 E-1：PR 檢查 workflow', () => {
  test('workflow 檔存在', () => {
    assert.ok(workflow, `找不到 ${PATH}`);
  });

  test('觸發條件是 pull_request（目標 main），不是 push', () => {
    assert.match(workflow, /^on:\s*\n\s+pull_request:\s*\n\s+branches:\s*\[\s*main\s*\]/m);
    assert.doesNotMatch(workflow, /^\s+push:/m, 'push 到 main 由 deploy.yml 負責，這裡不重複');
  });

  test('job 名稱固定為 pr-check（分支保護靠這個名稱選它）', () => {
    // jobs: 底下第一個 job（中間允許註解行）
    assert.match(workflow, /^jobs:\s*\n(?:\s*#.*\n)*\s+pr-check:/m);
  });

  test('依序跑 npm ci → npm test → npm run scan', () => {
    const ci = workflow.indexOf('npm ci');
    const t = workflow.indexOf('npm test');
    const scan = workflow.indexOf('npm run scan');
    assert.ok(ci !== -1 && t !== -1 && scan !== -1, '三個指令都要有');
    assert.ok(ci < t, 'npm ci 要在 npm test 之前');
  });

  test('沿用 Pages 的白名單收集步驟（漏登記的檔案在 PR 就看得到）', () => {
    assert.match(workflow, /node scripts\/site-files\.mjs/);
  });

  test('不碰任何 secret、不部署', () => {
    assert.doesNotMatch(workflow, /secrets\./, 'PR 檢查不可讀 secret');
    assert.doesNotMatch(workflow, /clasp (push|deploy)|deploy-pages|upload-pages-artifact/, 'PR 檢查不可部署');
  });

  test('權限只到 contents: read', () => {
    assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
    assert.doesNotMatch(workflow, /:\s*write\b/, '不需要任何寫入權限');
  });
});
