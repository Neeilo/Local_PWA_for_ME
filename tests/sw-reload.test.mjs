/**
 * Service Worker 換版不再讓剛開的 App 重新載入（2026-10-07 效能調查）
 *
 * 盯的事：部署後第一次開 App，新 SW 在開機請求還沒回來時就接管頁面——
 * 以前一律 location.reload()，開機白跑一次、兩個請求搶同一份試算表（實測 14 秒）。
 * 頁面剛載入的 30 秒內不重新載入（HTML 是 network-first，剛拿到的就是新版）；
 * 之後才換版的（App 掛在背景好幾天）照舊重新載入。
 *
 * 跑法：npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFrontend } from './fake-browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const SW = readFileSync(join(ROOT, 'sw.js'), 'utf8');

describe('SW 換版的重新載入', () => {
  test('剛載入 30 秒內不重新載入；之後照舊', () => {
    const e = loadFrontend();
    const t0 = e.read('PAGE_LOADED_AT');
    assert.equal(e.call('swReloadNeeded', t0 + 1000), false, '部署後第一次開：開機還在跑，不要白跑一次');
    assert.equal(e.call('swReloadNeeded', t0 + 29999), false);
    assert.equal(e.call('swReloadNeeded', t0 + 30000), true, '掛在背景很久之後換版：還是要換到新版');
  });

  test('controllerchange 經過 swReloadNeeded 才重新載入（不是無條件 reload）', () => {
    assert.match(HTML, /addEventListener\('controllerchange',\(\)=>\{\s*if\(swReloadNeeded\(\)\) location\.reload\(\);\s*\}\)/);
  });

  test('前提：HTML 是 network-first（剛載入的就是新版，這個判斷才成立）', () => {
    assert.match(SW, /const isHTML = req\.mode === 'navigate'/);
    assert.match(SW, /fetch\(req\)\s*\.then\(res => \{ caches\.open\(CACHE\)/);
  });
});
