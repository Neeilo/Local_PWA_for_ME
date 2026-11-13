/**
 * ADR-024 PR-B（後端）— 🤖 AI 辨識：callAiVision_（ai.gs）＋ action=clipVision（clips.gs）（D-1、D-4、D-6、D-7、D-8）
 *
 * 為什麼有這批測試：
 *  - 三家各自的送圖格式不同（Gemini inline_data、OpenAI image_url data URL、Claude image base64 區塊），
 *    格式錯了就是 400、錢照花（Gemini）或白跑——每家一組，盯端點、圖片順序、提示詞
 *  - 用目前選定的那一家；沒 key 講 no_key 且不打 API；失敗**不換家**（ADR-017，fetch 只有 1 次）
 *  - **callAi_ 既有行為不變**：純文字請求的 payload 一個字都不能多（「查/」、AI 整理都靠它）
 *  - 單篇最多 10 張：超過只送前 10 張，結果末尾註明（D-6）；不支援的格式略過並註明
 *  - 只限擁有者（D-8）：別人的收藏一張圖都不送、一毛錢都不花
 *  - 照 ADR-022 per-token 記帳，feature＝clip_vision（圖片 token 由各家算在 input 裡，照回應記）
 *  - 結果另存 vision_*，不動原文、筆記、AI 整理、文字辨識；失敗不寫半份
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { fakeDrive } from './fake-drive.mjs';

const ME = 'Uneil';
const DAD = 'Udad';
const TOK = { me: 'tok-me', dad: 'tok-dad' };
const KEYS = { GEMINI_API_KEY: 'gem-SECRET', OPENAI_API_KEY: 'oai-SECRET', ANTHROPIC_API_KEY: 'ant-SECRET' };
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_clips'];
const LOG_H = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
const B64 = Buffer.from([1, 2, 3]).toString('base64');

/** 假網路：依網址回各家的回應（附 usage，記帳才算得出 token） */
function network(answers = {}) {
  const calls = [];
  const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const ok = {
    gemini: reply(200, { candidates: [{ content: { parts: [{ text: '## 01.jpg\nGemini 看到的' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1300, candidatesTokenCount: 80 } }),
    openai: reply(200, { choices: [{ message: { content: '## 01.jpg\nOpenAI 看到的' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1300, completion_tokens: 80 } }),
    claude: reply(200, { content: [{ type: 'text', text: '## 01.jpg\nClaude 看到的' }], stop_reason: 'end_turn', usage: { input_tokens: 1300, output_tokens: 80 } })
  };
  const which = (url) => (/generativelanguage/.test(url) ? 'gemini' : /openai/.test(url) ? 'openai' : /anthropic/.test(url) ? 'claude' : '?');
  return {
    calls, reply,
    UrlFetchApp: {
      fetch: (url, opts) => {
        const who = which(url);
        calls.push({ who, url, opts, body: opts && opts.payload ? JSON.parse(opts.payload) : null });
        return answers[who] || ok[who];
      }
    }
  };
}

const files = (n, extra = {}) => {
  const out = {};
  for (let i = 1; i <= n; i++) out['f' + i] = { name: (i < 10 ? '0' : '') + i + '.jpg' };
  return Object.assign(out, extra);
};

function env({ provider = 'claude', keys = KEYS, net = network(), drive = files(3), clipsRows = [], headers = null } = {}) {
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H, [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE'], [DAD, '爸爸', 'TRUE', '', 'TRUE']]),
    logs: new FakeSheet('logs', [LOG_H])
  };
  if (headers) sheets.clips = new FakeSheet('clips', [headers]);
  const e = loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    tokens: { [TOK.me]: ME, [TOK.dad]: DAD }, sheets,
    properties: Object.assign({ APIFY_TOKEN: 'x', AI_PROVIDER: provider }, keys),
    overrides: { UrlFetchApp: net.UrlFetchApp, DriveApp: fakeDrive(drive) }
  });
  if (!headers) e.call('ensureClipsSheet_');
  const H = headers || e.read('CLIPS_HEADERS');
  clipsRows.forEach((r) => e.sheets.clips.values.push(H.map((h) => (r[h] == null ? '' : r[h]))));
  e.net = net;
  return e;
}

const ids = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => 'f' + (i + 1)).reverse());
const clip = (extra = {}) => Object.assign({ id: 'c1', line_id: ME, url: 'https://www.instagram.com/p/AAA111/', kind: 'post', status: 'done',
  caption: '原文', note: '筆記', ai_output: '舊 AI 整理', ocr_output: '舊文字辨識', media_saved: 3, image_ids: ids(3) }, extra);
const rows = (e) => e.sheets.clips.toRecords();
const post = (e, body, tok = TOK.me) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok, trigger: 'write' }, body)) } }).body);
const IMGS = [{ mime: 'image/jpeg', base64: 'AAA', name: '01.jpg' }, { mime: 'image/png', base64: 'BBB', name: '02.png' }];

/* ========================================================================== */
describe('callAiVision_：三家的送圖格式', () => {
  test('Claude：image base64 區塊依序在前、文字在後；用選定的模型', () => {
    const e = env({ provider: 'claude' });
    const r = e.call('callAiVision_', '看圖', IMGS, 'clip_vision');
    assert.equal(r.ok, true);
    assert.equal(r.label, 'Claude');
    const [c] = e.net.calls;
    assert.equal(c.who, 'claude');
    const content = c.body.messages[0].content;
    assert.deepEqual(content.map((x) => x.type), ['image', 'image', 'text']);
    assert.deepEqual(content[0].source, { type: 'base64', media_type: 'image/jpeg', data: 'AAA' });
    assert.deepEqual(content[1].source, { type: 'base64', media_type: 'image/png', data: 'BBB' });
    assert.equal(content[2].text, '看圖');
    assert.ok(c.body.max_tokens > e.read('GEMINI_MAX_OUTPUT_TOKENS'), '十張圖的逐張整理比「查/」長，輸出上限放寬');
  });

  test('OpenAI：content 陣列，文字＋image_url data URL', () => {
    const e = env({ provider: 'openai' });
    assert.equal(e.call('callAiVision_', '看圖', IMGS, 'clip_vision').ok, true);
    const content = e.net.calls[0].body.messages[0].content;
    assert.deepEqual(content[0], { type: 'text', text: '看圖' });
    assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } });
    assert.deepEqual(content[2], { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } });
  });

  test('Gemini：parts＝文字＋inline_data', () => {
    const e = env({ provider: 'gemini' });
    assert.equal(e.call('callAiVision_', '看圖', IMGS, 'clip_vision').ok, true);
    const c = e.net.calls[0];
    const parts = c.body.contents[0].parts;
    assert.deepEqual(parts[0], { text: '看圖' });
    assert.deepEqual(parts[1], { inline_data: { mime_type: 'image/jpeg', data: 'AAA' } });
    assert.deepEqual(parts[2], { inline_data: { mime_type: 'image/png', data: 'BBB' } });
    assert.ok(c.body.generationConfig.maxOutputTokens > e.read('GEMINI_MAX_OUTPUT_TOKENS'));
  });

  test('缺 key → no_key，不打 API', () => {
    const e = env({ provider: 'openai', keys: { ANTHROPIC_API_KEY: 'x' } });
    const r = e.call('callAiVision_', '看圖', IMGS, 'clip_vision');
    assert.equal(r.reason, 'no_key');
    assert.equal(r.missingKey, 'OPENAI_API_KEY');
    assert.equal(e.net.calls.length, 0);
  });

  test('失敗不換家：只打 1 次，錯誤翻成人話', () => {
    const net = network();
    net.UrlFetchApp.fetch = ((orig) => (url, opts) => { orig(url, opts); return net.reply(429, { error: { type: 'rate_limit_error' } }); })(net.UrlFetchApp.fetch);
    const e = env({ provider: 'claude', net });
    const r = e.call('callAiVision_', '看圖', IMGS, 'clip_vision');
    assert.equal(r.ok, false);
    assert.match(r.reason, /HTTP 429/);
    assert.equal(net.calls.length, 1);
  });
});

/* ========================================================================== */
describe('callAi_ 既有行為不變（純文字）', () => {
  test('三家的純文字 payload 跟改版前一樣：content 是字串、Gemini 只有一個 text part、輸出上限照舊', () => {
    for (const provider of ['claude', 'openai', 'gemini']) {
      const e = env({ provider });
      assert.equal(e.call('callAi_', '只有文字', 'query').ok, true);
      const b = e.net.calls[0].body;
      if (provider === 'claude') {
        assert.deepEqual(b.messages, [{ role: 'user', content: '只有文字' }]);
        assert.equal(b.max_tokens, e.read('GEMINI_MAX_OUTPUT_TOKENS'));
      } else if (provider === 'openai') {
        assert.deepEqual(b.messages, [{ role: 'user', content: '只有文字' }]);
        assert.equal(b.max_completion_tokens, e.read('GEMINI_MAX_OUTPUT_TOKENS'));
      } else {
        assert.deepEqual(b.contents, [{ parts: [{ text: '只有文字' }] }]);
        assert.equal(b.generationConfig.maxOutputTokens, e.read('GEMINI_MAX_OUTPUT_TOKENS'));
      }
    }
  });
});

/* ========================================================================== */
describe('🤖 AI 辨識：clipVision', () => {
  test('欄位：vision_output／vision_provider／vision_at 接在最右邊；_guide 同步', () => {
    const e = env();
    // ADR-028 起 report_* 接在 vision_* 後面：這裡只盯 vision 三欄連在一起、在 ocr 之後
    const H = e.read('CLIPS_HEADERS');
    const at = H.indexOf('vision_output');
    assert.deepEqual(H.slice(at, at + 3), ['vision_output', 'vision_provider', 'vision_at']);
    assert.ok(at > H.indexOf('ocr_at'));
    const guide = JSON.stringify(e.call('guideRegistry_'));
    assert.match(guide, /vision_output/);
    assert.match(guide, /clipVision/);
  });

  test('依檔名順序送圖＋逐張整理的提示詞；結果另存，其他欄不動；記 clip_vision 的 token', () => {
    const e = env({ clipsRows: [clip()] });
    const r = post(e, { action: 'clipVision', id: 'c1' });
    assert.equal(r.success, true);
    assert.equal(r.vision_output, '## 01.jpg\nClaude 看到的');
    assert.equal(r.vision_provider, 'Claude');
    const body = e.net.calls[0].body;
    const content = body.messages[0].content;
    assert.equal(content.filter((x) => x.type === 'image').length, 3);
    assert.equal(content[0].source.data, B64);
    const prompt = content[content.length - 1].text;
    assert.match(prompt, /繁體中文/);
    assert.match(prompt, /01\.jpg、02\.jpg、03\.jpg/);
    assert.match(prompt, /不要編造/);
    assert.match(prompt, /表格/);
    assert.match(prompt, /不要開場白/);
    const row = rows(e)[0];
    assert.deepEqual([row.vision_output, row.vision_provider], [r.vision_output, 'Claude']);
    assert.ok(row.vision_at);
    assert.deepEqual([row.caption, row.note, row.ai_output, row.ocr_output], ['原文', '筆記', '舊 AI 整理', '舊文字辨識']);
    const queued = Object.keys(e.properties).filter((k) => k.indexOf('apiq_') === 0).map((k) => JSON.parse(e.properties[k]));
    assert.ok(queued.some((q) => q.feature === 'clip_vision' && q.input_tokens === 1300), 'per-token 記帳，圖片 token 算在 input');
  });

  test('超過 10 張：只送前 10 張，結果末尾註明', () => {
    const e = env({ drive: files(12), clipsRows: [clip({ image_ids: ids(12), media_saved: 12 })] });
    const r = post(e, { action: 'clipVision', id: 'c1' });
    assert.equal(e.net.calls[0].body.messages[0].content.filter((x) => x.type === 'image').length, 10);
    assert.match(r.vision_output, /只看了前 10 張（共 12 張）/);
    assert.doesNotMatch(e.net.calls[0].body.messages[0].content.slice(-1)[0].text, /11\.jpg/);
  });

  test('不支援的格式（HEIC）略過並註明；全部都不支援＝no_images、不打 API', () => {
    const drive = files(2, { h1: { name: '03.heic', mime: 'image/heic' } });
    const e = env({ drive, clipsRows: [clip({ image_ids: JSON.stringify(['f1', 'f2', 'h1']) }), clip({ id: 'c2', image_ids: JSON.stringify(['h1']) })] });
    const r = post(e, { action: 'clipVision', id: 'c1' });
    assert.equal(e.net.calls[0].body.messages[0].content.filter((x) => x.type === 'image').length, 2);
    assert.match(r.vision_output, /03\.heic.*格式不支援/);
    const n = e.net.calls.length;
    assert.equal(post(e, { action: 'clipVision', id: 'c2' }).error, 'no_images');
    assert.equal(e.net.calls.length, n);
  });

  test('失敗：回 ai_failed＋哪一家，舊結果留著、不換家', () => {
    const net = network({ claude: { getResponseCode: () => 500, getContentText: () => 'oops' } });
    const e = env({ net, clipsRows: [clip({ vision_output: '上次的', vision_provider: 'Gemini', vision_at: '2026-11-01T00:00:00.000Z' })] });
    const r = post(e, { action: 'clipVision', id: 'c1' });
    assert.equal(r.error, 'ai_failed');
    assert.equal(r.label, 'Claude');
    assert.equal(net.calls.length, 1);
    assert.deepEqual([rows(e)[0].vision_output, rows(e)[0].vision_provider], ['上次的', 'Gemini']);
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && /AI 辨識/.test(t[3])));
  });

  test('沒 key：no_key＋缺哪一把，不打 API', () => {
    const e = env({ keys: {}, clipsRows: [clip()] });
    const r = post(e, { action: 'clipVision', id: 'c1' });
    assert.equal(r.error, 'no_key');
    assert.equal(r.missingKey, 'ANTHROPIC_API_KEY');
    assert.equal(e.net.calls.length, 0);
  });

  test('捨棄只清 vision 三欄、不打 API；重跑＝取代', () => {
    const e = env({ clipsRows: [clip({ vision_output: '舊的', vision_provider: 'Gemini', vision_at: 'x' })] });
    assert.equal(post(e, { action: 'clipVision', id: 'c1', discard: true }).success, true);
    assert.equal(e.net.calls.length, 0);
    const row = rows(e)[0];
    assert.deepEqual([row.vision_output, row.vision_provider, row.vision_at, row.ocr_output], ['', '', '', '舊文字辨識']);
    post(e, { action: 'clipVision', id: 'c1' });
    assert.match(rows(e)[0].vision_output, /Claude 看到的/);
  });

  test('不是擁有者：永久拒絕，一張圖都不送；只存連結：no_images', () => {
    const e = env({ clipsRows: [clip(), clip({ id: 'k1', kind: 'link', status: 'link', image_ids: '' })] });
    const r = post(e, { action: 'clipVision', id: 'c1' }, TOK.dad);
    assert.deepEqual([r.error, r.permanent], ['forbidden', true]);
    assert.equal(post(e, { action: 'clipVision', id: 'k1' }).error, 'no_images');
    assert.equal(e.net.calls.length, 0);
  });

  test('「初始化」還沒補 vision 欄：not_ready，不花錢', () => {
    const old = ['id', 'line_id', 'url', 'kind', 'status', 'caption', 'image_ids', 'ocr_output', 'ocr_at', 'del'];
    const e = env({ headers: old, clipsRows: [clip()] });
    assert.equal(post(e, { action: 'clipVision', id: 'c1' }).error, 'not_ready');
    assert.equal(e.net.calls.length, 0);
  });
});
