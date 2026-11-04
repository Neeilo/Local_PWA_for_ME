/**
 * ADR-024 PR-C — 「AI 整理」讀兩個辨識結果（D-3）
 *
 * 為什麼有這批測試：
 *  - 有辨識結果就當作原文的一部分送進去：原文後面依序接「圖片文字（文字辨識）」「圖片內容（AI 辨識）」，沒有就省略
 *  - 規則要跟著變：兩個都沒有 → 照舊要它標「（圖片內容未辨識）」；有任一個 → 圖片只能依辨識結果、不准編造。
 *    講錯就是叫 AI 對著它沒看過的圖說話（CLAUDE.md 原則 5）
 *  - 總長仍受 CLIP_AI_INPUT_MAX 限制；截斷順序：原文優先、其次 AI 辨識、最後文字辨識
 *  - 只有圖、沒有原文與筆記的篇：有辨識結果就能整理，不再回 empty（那 6 篇只有圖的收藏就是為這個）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_clips'];
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];

function env(clipsRows = []) {
  const prompts = [];
  const e = loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], tokens: { tok: ME },
    sheets: { line_users: new FakeSheet('line_users', [USER_H, [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE']]), logs: new FakeSheet('logs', [LOG_H]) },
    properties: { APIFY_TOKEN: 'x' },
    overrides: { callAi_: (p) => { prompts.push(p); return { ok: true, text: '整理好了', label: 'Claude', provider: 'claude', model: 'm' }; } }
  });
  e.call('ensureClipsSheet_');
  const H = e.read('CLIPS_HEADERS');
  clipsRows.forEach((r) => e.sheets.clips.values.push(H.map((h) => (r[h] == null ? '' : r[h]))));
  e.prompts = prompts;
  return e;
}
const rec = (o = {}) => Object.assign({ id: 'c1', line_id: ME, kind: 'post', status: 'done', url: 'u', caption: '原文內容', note: '' }, o);
const post = (e, body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: 'tok', trigger: 'write' }, body)) } }).body);
const OCR_H = '【圖片文字（文字辨識）】';
const VIS_H = '【圖片內容（AI 辨識）】';

/* ========================================================================== */
describe('clipAiPrompt_：四種組合', () => {
  test('都沒有：照舊標「（圖片內容未辨識）」，沒有辨識段落', () => {
    const p = env().call('clipAiPrompt_', rec());
    assert.match(p, /圖片內容未辨識/);
    assert.ok(!p.includes(OCR_H) && !p.includes(VIS_H));
  });

  test('只有文字辨識：原文後面接圖片文字；改成「只依辨識結果、不要編造」', () => {
    const p = env().call('clipAiPrompt_', rec({ ocr_output: '## 01.jpg\n提示詞' }));
    assert.ok(p.indexOf('【原文】') < p.indexOf(OCR_H));
    assert.ok(p.indexOf(OCR_H) < p.indexOf('【我的筆記】'));
    assert.match(p, /## 01\.jpg\n提示詞/);
    assert.ok(!p.includes(VIS_H));
    assert.doesNotMatch(p, /圖片內容未辨識/);
    assert.match(p, /圖片只依下面的辨識結果/);
    assert.match(p, /不要編造/);
  });

  test('只有 AI 辨識', () => {
    const p = env().call('clipAiPrompt_', rec({ vision_output: '## 01.jpg\n表格' }));
    assert.ok(p.includes(VIS_H) && !p.includes(OCR_H));
    assert.match(p, /表格/);
    assert.doesNotMatch(p, /圖片內容未辨識/);
  });

  test('兩者都有：依序 原文 → 文字辨識 → AI 辨識 → 筆記', () => {
    const p = env().call('clipAiPrompt_', rec({ ocr_output: 'OCR字', vision_output: 'AI看圖', note: '我的想法' }));
    const order = ['【原文】', OCR_H, VIS_H, '【我的筆記】'].map((h) => p.indexOf(h));
    assert.ok(order.every((x) => x >= 0));
    assert.deepEqual(order, order.slice().sort((a, b) => a - b));
    assert.doesNotMatch(p, /圖片內容未辨識/);
  });
});

/* ========================================================================== */
describe('總長限制與截斷順序', () => {
  test('原文優先、其次 AI 辨識、最後文字辨識；三段加起來不超過 CLIP_AI_INPUT_MAX', () => {
    const e = env();
    const max = e.read('CLIP_AI_INPUT_MAX');
    const p = e.call('clipAiPrompt_', rec({ caption: 'C'.repeat(max - 100), vision_output: 'V'.repeat(300), ocr_output: 'O'.repeat(300) }));
    assert.equal((p.match(/C/g) || []).length, max - 100, '原文完整');
    assert.equal((p.match(/V/g) || []).length, 100, 'AI 辨識吃剩下的');
    assert.ok(!/O{2,}/.test(p), '文字辨識沒位置了');
    assert.ok(!p.includes(OCR_H), '被截到一個字都不剩就整段省略');
  });

  test('原文短：兩段辨識都放得下', () => {
    const p = env().call('clipAiPrompt_', rec({ vision_output: 'V'.repeat(50), ocr_output: 'O'.repeat(50) }));
    assert.equal((p.match(/V/g) || []).length, 50);
    assert.equal((p.match(/O/g) || []).length, 50);
  });
});

/* ========================================================================== */
describe('clipAi_：只有辨識結果的篇也能整理', () => {
  test('沒有原文、沒有筆記，但有文字辨識 → 會整理（不回 empty），提示詞帶著辨識結果', () => {
    const e = env([rec({ caption: '', ocr_output: '## 01.jpg\n提示詞全文' })]);
    const r = post(e, { action: 'clipAi', id: 'c1' });
    assert.equal(r.success, true);
    assert.match(e.prompts[0], /提示詞全文/);
  });

  test('只有 AI 辨識也行', () => {
    const e = env([rec({ caption: '', vision_output: '看圖結果' })]);
    assert.equal(post(e, { action: 'clipAi', id: 'c1' }).success, true);
  });

  test('四樣都沒有：照舊 empty、不呼叫 AI', () => {
    const e = env([rec({ caption: '' })]);
    assert.equal(post(e, { action: 'clipAi', id: 'c1' }).error, 'empty');
    assert.equal(e.prompts.length, 0);
  });
});
