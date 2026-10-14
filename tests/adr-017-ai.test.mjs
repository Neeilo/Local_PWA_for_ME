/**
 * ADR-017 AI 供應商切換：Gemini／OpenAI／Claude
 *
 * 盯的事（為什麼）：
 *   - 沒設 AI_PROVIDER → 走 Gemini，跟改版前一樣（既有「查/」測試全綠也是這條的證據）
 *   - 三家各自：正常、HTTP 4xx／5xx、空回應、被截斷 → 都轉成同一個形狀；請求長得對（端點、header、模型）
 *   - 成功回覆結尾「（由 Claude 彙整）」（D-5）；失敗訊息帶供應商名（D-4）
 *   - 選定的一家失敗時**不呼叫其他家**（fetch 只有 1 次）——不自動換家，錢包的掌控權留在 Neil 手上
 *   - aiConfigSet：非管理員、沒 key 的一家、不認得的值都拒絕；成功寫 logs（從哪家到哪家）
 *   - aiConfigGet 的回應裡**找不到任何 key 字串**（D-3）
 *   - 效能紀錄：「查/」那一列的 stages 有 query／query.context／query.ai；provider／model 記在 logs detail，不塞進 performance
 *   - PWA：設定頁「🤖 AI 供應商」只有管理員看得到、點開才抓（不進開機）、沒 key 的選項按不了、送出中不重送
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const TOK_ME = 'tok-neil-device';
const TOK_MOM = 'tok-mom-device';
const KEYS = { GEMINI_API_KEY: 'gem-SECRET-1', OPENAI_API_KEY: 'oai-SECRET-2', ANTHROPIC_API_KEY: 'ant-SECRET-3' };

/** 假網路：依網址回各家的回應；calls 記下每一次請求 */
function network(answers = {}) {
  const calls = [];
  const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const ok = {
    gemini: reply(200, { candidates: [{ content: { parts: [{ text: 'Gemini 的答案' }] }, finishReason: 'STOP' }] }),
    openai: reply(200, { choices: [{ message: { content: 'OpenAI 的答案' }, finish_reason: 'stop' }] }),
    claude: reply(200, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Claude 的答案' }], stop_reason: 'end_turn' })
  };
  const which = (url) => (/generativelanguage/.test(url) ? 'gemini' : /openai/.test(url) ? 'openai' : /anthropic/.test(url) ? 'claude' : '?');
  return {
    calls,
    reply,
    UrlFetchApp: {
      fetch: (url, opts) => {
        const who = which(url);
        calls.push({ who, url, opts, body: opts && opts.payload ? JSON.parse(opts.payload) : null });
        const a = answers[who];
        if (a instanceof Error) throw a;
        return a || ok[who];
      }
    }
  };
}

function env({ properties = {}, net = network(), propsWritable = true } = {}) {
  const replies = [];
  const e = loadCodeGs({
    cache: true,
    propsWritable,
    extraFiles: ['line-router.gs'],
    properties: Object.assign({}, properties),
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense', 'feat_tasks', 'feat_notes'],
        [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
        [MOM, '媽媽', 'TRUE', '', 'TRUE', 'TRUE', 'TRUE']
      ]),
      tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del']]),
      expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del']]),
      notes: new FakeSheet('notes', [['id', 'text', 'created_at', 'line_id', 'del']]),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    },
    overrides: { UrlFetchApp: net.UrlFetchApp, lineReply_: (_t, text) => { replies.push(String(text)); } }
  });
  e.replies = replies;
  e.net = net;
  return e;
}
function ask(e, userId = ME, text = '查/這個月花多少') {
  e.call('runLineEvent_', { type: 'message', replyToken: 'rt', source: { type: 'user', userId }, message: { type: 'text', text } });
  return e.replies[e.replies.length - 1] || '';
}
function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

/* ========================================================================== */
describe('出口：依設定選一家（D-1）', () => {

  test('沒設 AI_PROVIDER → Gemini，結尾「（由 Gemini 彙整）」', () => {
    const e = env({ properties: KEYS });
    const r = ask(e);
    assert.equal(r, 'Gemini 的答案\n\n（由 Gemini 彙整）');
    assert.deepEqual(e.net.calls.map((c) => c.who), ['gemini']);
  });

  test('亂填的 AI_PROVIDER → 當作 Gemini', () => {
    const e = env({ properties: Object.assign({ AI_PROVIDER: 'grok' }, KEYS) });
    assert.match(ask(e), /由 Gemini 彙整/);
  });

  test('OpenAI：Chat Completions、Bearer、預設 gpt-6-luna、不送 temperature；結尾「（由 OpenAI 彙整）」', () => {
    const e = env({ properties: Object.assign({ AI_PROVIDER: 'openai' }, KEYS) });
    assert.equal(ask(e), 'OpenAI 的答案\n\n（由 OpenAI 彙整）');
    const c = e.net.calls[0];
    assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(c.opts.headers.Authorization, 'Bearer ' + KEYS.OPENAI_API_KEY);
    assert.equal(c.body.model, 'gpt-6-luna');
    assert.equal(c.body.max_completion_tokens, 2048);
    assert.equal('temperature' in c.body, false);
  });

  test('Claude：Messages API、x-api-key＋anthropic-version、預設 claude-haiku-5-5、不送 temperature；只取 text 區塊', () => {
    const e = env({ properties: Object.assign({ AI_PROVIDER: 'claude' }, KEYS) });
    assert.equal(ask(e), 'Claude 的答案\n\n（由 Claude 彙整）');
    const c = e.net.calls[0];
    assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(c.opts.headers['x-api-key'], KEYS.ANTHROPIC_API_KEY);
    assert.equal(c.opts.headers['anthropic-version'], '2023-06-01');
    assert.equal(c.body.model, 'claude-haiku-5-5');
    assert.equal(c.body.max_tokens, 2048);
    assert.equal('temperature' in c.body, false);
  });

  test('模型可用指令碼屬性覆寫（OPENAI_MODEL／CLAUDE_MODEL）', () => {
    const e = env({ properties: Object.assign({ AI_PROVIDER: 'claude', CLAUDE_MODEL: ' claude-sonnet-5-5 ' }, KEYS) });
    ask(e);
    assert.equal(e.net.calls[0].body.model, 'claude-sonnet-5-5');
  });

  test('選定的那一家沒有 key：講清楚缺哪個屬性，不打任何一家', () => {
    const e = env({ properties: { AI_PROVIDER: 'claude', GEMINI_API_KEY: 'k' } });
    assert.equal(ask(e), 'AI 查詢還沒設定完成（缺 ANTHROPIC_API_KEY）。');
    assert.equal(e.net.calls.length, 0);
  });
});

/* ========================================================================== */
describe('失敗與截斷：三家同一個形狀，不自動換家（D-4）', () => {

  const bad = (net) => ({
    'HTTP 401': net.reply(401, { error: { message: 'bad key' } }),
    'HTTP 503': net.reply(503, 'overloaded'),
    '連線失敗': new Error('timeout')
  });
  for (const who of ['gemini', 'openai', 'claude']) {
    const label = { gemini: 'Gemini', openai: 'OpenAI', claude: 'Claude' }[who];
    for (const name of ['HTTP 401', 'HTTP 503', '連線失敗']) {
      test(label + '：' + name + ' → 「' + label + ' 暫時無法回應」、只打一次、記最後一次失敗', () => {
        const net = network();
        net.UrlFetchApp.fetch = ((orig) => (url, opts) => {
          const r = orig(url, opts);
          const a = bad(net)[name];
          if (a instanceof Error) throw a;
          return a;
        })(net.UrlFetchApp.fetch);
        const e = env({ net, properties: Object.assign({ AI_PROVIDER: who }, KEYS) });
        assert.equal(ask(e), label + ' 暫時無法回應，請稍後再試');
        assert.equal(net.calls.length, 1, '不換家');
        const last = JSON.parse(e.properties.AI_LAST_ERROR);
        assert.equal(last.provider, who);
        assert.ok(last.reason);
        const log = e.transactions.find((t) => t[0] === '查詢' && t[1] === '失敗');
        assert.match(log[4], new RegExp('provider=' + who + '｜model='));
      });
    }
  }

  test('空回應 → 失敗（不把空字串當答案）', () => {
    const net = network();
    const answers = {
      openai: net.reply(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
      claude: net.reply(200, { content: [], stop_reason: 'end_turn' })
    };
    for (const who of ['openai', 'claude']) {
      const e = env({ net: network(answers), properties: Object.assign({ AI_PROVIDER: who }, KEYS) });
      assert.match(ask(e), /暫時無法回應/);
    }
  });

  test('被截斷 → 有內容就回、標出「被截斷」；logs 記被截斷', () => {
    const net = network();
    const answers = {
      openai: net.reply(200, { choices: [{ message: { content: '半句' }, finish_reason: 'length' }] }),
      claude: net.reply(200, { content: [{ type: 'text', text: '半句' }], stop_reason: 'max_tokens' })
    };
    for (const who of ['openai', 'claude']) {
      const e = env({ net: network(answers), properties: Object.assign({ AI_PROVIDER: who }, KEYS) });
      const r = ask(e);
      assert.match(r, /^半句\n\n⚠️ 回應太長被截斷了/);
      assert.match(r, /（由 (OpenAI|Claude) 彙整）$/);
      assert.ok(e.transactions.some((t) => /被截斷/.test(t[3])));
    }
  });

  test('Claude 拒答（stop_reason=refusal）→ 失敗，不送半截內容', () => {
    const net = network();
    const e = env({ net: network({ claude: net.reply(200, { content: [{ type: 'text', text: '部分' }], stop_reason: 'refusal' }) }),
      properties: Object.assign({ AI_PROVIDER: 'claude' }, KEYS) });
    assert.equal(ask(e), 'Claude 暫時無法回應，請稍後再試');
  });
});

/* ========================================================================== */
describe('效能紀錄（ADR-017 × PR-0）', () => {

  test('「查/」那一列的 stages：query／query.context／query.ai；只有段名與毫秒', () => {
    const e = env({ properties: Object.assign({ AI_PROVIDER: 'claude' }, KEYS) });
    ask(e);
    const row = e.sheets.performance.toRecords().find((r) => r.action === 'lineMessage');
    const st = JSON.parse(row.stages);
    for (const k of ['query', 'query.context', 'query.ai']) assert.equal(typeof st[k], 'number', k);
    assert.doesNotMatch(row.stages, /claude|haiku/i, 'provider／model 記在 logs，不進 performance');
  });

  test('不是「查/」的訊息：stages 空白', () => {
    const e = env({ properties: KEYS });
    ask(e, ME, '任務/買菜');
    const row = e.sheets.performance.toRecords().find((r) => r.action === 'lineMessage');
    assert.equal(row.stages, '');
  });
});

/* ========================================================================== */
describe('管理員 action：aiConfigGet／aiConfigSet（D-1～D-3）', () => {

  test('aiConfigGet：目前的、三家 hasKey 與模型、最後一次失敗；回應裡找不到任何 key', () => {
    const e = env({ properties: Object.assign({ AI_PROVIDER: 'openai', AI_LAST_ERROR: JSON.stringify({ at: '2026-10-14T01:00:00Z', provider: 'openai', reason: 'HTTP 429' }) },
      { GEMINI_API_KEY: KEYS.GEMINI_API_KEY, OPENAI_API_KEY: KEYS.OPENAI_API_KEY }) });
    const out = post(e, { token: TOK_ME, action: 'aiConfigGet', trigger: 'manual' });
    assert.equal(out.provider, 'openai');
    assert.deepEqual(out.providers.map((p) => p.id + ':' + p.hasKey), ['gemini:true', 'openai:true', 'claude:false']);
    assert.equal(out.providers.find((p) => p.id === 'claude').model, 'claude-haiku-5-5');
    assert.equal(out.lastError.reason, 'HTTP 429');
    const raw = JSON.stringify(out);
    for (const k of Object.values(KEYS)) assert.ok(!raw.includes(k), '不能有 key：' + k);
    assert.ok(!/SECRET/.test(raw));
  });

  test('aiConfigSet：換到有 key 的一家 → 寫屬性、寫 logs（從哪家到哪家）', () => {
    const e = env({ properties: KEYS });
    const out = post(e, { token: TOK_ME, action: 'aiConfigSet', provider: 'claude', trigger: 'write' });
    assert.deepEqual(out, { success: true, provider: 'claude' });
    assert.equal(e.properties.AI_PROVIDER, 'claude');
    const log = e.transactions.find((t) => t[0] === 'AI');
    assert.match(log[3], /Gemini → Claude/);
    assert.equal(log[6], ME);
    assert.match(ask(e), /由 Claude 彙整/, '立即生效');
  });

  test('aiConfigSet：沒 key 的一家、不認得的值都拒絕，設定不動', () => {
    const e = env({ properties: { GEMINI_API_KEY: 'k' } });
    assert.equal(post(e, { token: TOK_ME, action: 'aiConfigSet', provider: 'openai', trigger: 'write' }).error, 'no_key');
    assert.equal(post(e, { token: TOK_ME, action: 'aiConfigSet', provider: 'grok', trigger: 'write' }).error, 'unknown_provider');
    assert.equal(e.properties.AI_PROVIDER, undefined);
  });

  test('非管理員：兩個 action 都拒絕並記一筆', () => {
    const e = env({ properties: KEYS });
    assert.equal(post(e, { token: TOK_MOM, action: 'aiConfigGet', trigger: 'manual' }).error, 'forbidden');
    assert.equal(post(e, { token: TOK_MOM, action: 'aiConfigSet', provider: 'claude', trigger: 'write' }).error, 'forbidden');
    assert.equal(e.properties.AI_PROVIDER, undefined);
    assert.equal(e.transactions.filter((t) => t[0] === 'AI' && t[1] === '失敗').length, 2);
  });

  test('diagnoseAi：三家各打一次、列出 key 有無與結果，不改目前的選擇', () => {
    const e = env({ properties: { AI_PROVIDER: 'openai', GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' } });
    const out = e.call('diagnoseAi');
    assert.deepEqual(out.map((l) => l.id + ':' + l.ok), ['gemini:true', 'openai:true', 'claude:false']);
    assert.match(out[2].reason, /缺 ANTHROPIC_API_KEY/);
    assert.equal(e.net.calls.length, 2);
    assert.equal(e.properties.AI_PROVIDER, 'openai');
  });
});

/* ========================================================================== */
describe('PWA：設定頁「🤖 AI 供應商」（D-1、D-3）', () => {

  const CFG = { success: true, provider: 'gemini', lastError: { at: '2026-10-14T01:00:00Z', provider: 'gemini', reason: 'HTTP 429' },
    providers: [{ id: 'gemini', label: 'Gemini', hasKey: true, model: 'gemini-3.5-flash' },
      { id: 'openai', label: 'OpenAI', hasKey: false, model: 'gpt-6-luna' },
      { id: 'claude', label: 'Claude', hasKey: true, model: 'claude-haiku-5-5' }] };

  function fe(admin = true, handler = () => null) {
    const e = loadFrontend({ fetchImpl: ({ body }) => ({ json: () => Promise.resolve(handler(body) || { success: true }) }) });
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:"' + (admin ? 'TRUE' : '') + '"}]');
    const els = {};
    const doc = e.context.document;
    const orig = doc.getElementById;
    e.set('document', Object.assign({}, doc, { getElementById: (id) => els[id] || (els[id] = orig(id)) }));
    return { e, els };
  }

  test('非管理員看不到整塊', () => {
    const { e, els } = fe(false);
    e.call('renderAiCard');
    assert.equal(els.aiCard.hidden, true);
  });

  test('點開才抓（aiConfigGet），開機不帶；沒 key 的選項按不了、使用中的也按不了；顯示最後一次失敗', async () => {
    const { e, els } = fe(true, (b) => (b.action === 'aiConfigGet' ? CFG : null));
    assert.equal(e.calls.length, 0);
    e.call('toggleFold', 'ai');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(e.calls.map((c) => c.body.action + ':' + c.body.trigger), ['aiConfigGet:manual']);
    const html = els.aiBody.innerHTML;
    assert.match(html, /❌ 未設定 key・gpt-6-luna/);
    assert.match(html, /<button class="" disabled onclick="pickAiProvider\('openai'\)">切換<\/button>/);
    assert.match(html, /<button class="sel" disabled onclick="pickAiProvider\('gemini'\)">使用中<\/button>/);
    assert.match(html, /<button class="" {2}onclick="pickAiProvider\('claude'\)">切換<\/button>/);
    assert.match(html, /最後一次失敗：2026-10-14 01:00（UTC）・Gemini・HTTP 429/);
    assert.equal(els.aiCount.textContent, 'Gemini');
  });

  test('切換：送 aiConfigSet（trigger write）；送出中再按不重送', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const e = loadFrontend({ fetchImpl: ({ body }) => ({ json: () => (body.action === 'aiConfigSet' ? gate.then(() => ({ success: true, provider: 'claude' })) : Promise.resolve(CFG)) }) });
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:"TRUE"}]');
    e.raw('aiState.cfg = ' + JSON.stringify(CFG));
    const a = e.callRaw('pickAiProvider', 'claude');
    e.callRaw('pickAiProvider', 'claude');
    release();
    await a;
    const sets = e.calls.filter((c) => c.body.action === 'aiConfigSet');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].body.trigger, 'write');
    assert.equal(sets[0].body.provider, 'claude');
    assert.equal(e.read('aiState.cfg.provider'), 'claude');
    assert.ok(e.toasts.some((t) => /改用 Claude/.test(t)));
  });
});

/* ========================================================================== */
describe('錯誤代碼說明（Neil 2026-10-14：「HTTP 429」看不出是額度用完還是打太快）', () => {

  const cases = [
    ['openai', 429, { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'You have no credits remaining.' } }, /^HTTP 429・額度用完或超過用量上限，請到 OpenAI 帳戶加值/],
    ['openai', 429, { error: { type: 'requests', message: 'Rate limit reached' } }, /^HTTP 429・呼叫太頻繁/],
    ['openai', 401, { error: { code: 'invalid_api_key' } }, /^HTTP 401・API key 錯誤或已失效/],
    ['claude', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, /^HTTP 400・額度用完或超過用量上限，請到 Claude 帳戶/],
    ['claude', 529, { type: 'error', error: { type: 'overloaded_error' } }, /^HTTP 529・Claude 服務暫時忙碌或故障/],
    ['gemini', 429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, /^HTTP 429・額度用完或超過用量上限，請到 Gemini 帳戶/],
    ['gemini', 403, { error: { status: 'PERMISSION_DENIED' } }, /^HTTP 403・這把 key 沒有使用這個模型的權限/],
    ['claude', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature is not supported' } }, /^HTTP 400・請求格式不被接受/]
  ];
  for (const [who, code, body, want] of cases) {
    test(who + ' HTTP ' + code + ' → ' + want.source.slice(1, 40), () => {
      const net = network();
      const e = env({ net: network({ [who]: net.reply(code, body) }), properties: Object.assign({ AI_PROVIDER: who }, KEYS) });
      ask(e);
      assert.match(JSON.parse(e.properties.AI_LAST_ERROR).reason, want);
      assert.ok(e.transactions.some((t) => t[0] === '查詢' && t[1] === '失敗' && want.test(t[3])), 'logs 的 result 也是同一句');
    });
  }

  test('404 已經有「跑 diagnoseAi」的提示：不重複加說明', () => {
    const net = network();
    const e = env({ net: network({ claude: net.reply(404, { error: { type: 'not_found_error' } }) }), properties: Object.assign({ AI_PROVIDER: 'claude' }, KEYS) });
    ask(e);
    const reason = JSON.parse(e.properties.AI_LAST_ERROR).reason;
    assert.match(reason, /^HTTP 404（模型「claude-haiku-5-5」可能不存在，跑 diagnoseAi）$/);
  });

  test('連線失敗（不是 HTTP 錯誤）：原樣', () => {
    const e = env({ net: network({ openai: new Error('timeout') }), properties: Object.assign({ AI_PROVIDER: 'openai' }, KEYS) });
    ask(e);
    assert.equal(JSON.parse(e.properties.AI_LAST_ERROR).reason, '連線失敗');
  });

  test('diagnoseAi 也用同一套說明', () => {
    const net = network();
    const e = env({ net: network({ openai: net.reply(429, { error: { code: 'credit_balance_exhausted' } }) }),
      properties: { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' } });
    const out = e.call('diagnoseAi');
    assert.match(out[1].reason, /^HTTP 429・額度用完/);
  });
});

/* ========================================================================== */
describe('T5｜模型選擇開到設定頁（ADR-017 D-6，2026-10-14）', () => {

  const TIERS = ['輕量', '標準', '進階'];
  const LIST = {
    gemini: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-pro-preview'],
    openai: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
    claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']
  };
  const get = (e, tok = TOK_ME) => post(e, { token: tok, action: 'aiConfigGet', trigger: 'manual' });
  const set = (e, body, tok = TOK_ME) => post(e, Object.assign({ token: tok, action: 'aiConfigSet', trigger: 'write' }, body));

  test('屬性空白 → 三家都走輕量級（Gemini 從 3.5 Flash 換成 3.5 Flash-Lite）', () => {
    for (const id of ['gemini', 'openai', 'claude']) {
      const e = env({ properties: Object.assign({ AI_PROVIDER: id }, KEYS) });
      ask(e);
      const c = e.net.calls[0];
      const model = id === 'gemini' ? decodeURIComponent(c.url.split('/models/')[1].split(':')[0]) : c.body.model;
      assert.equal(model, LIST[id][0], id);
    }
  });

  test('aiConfigGet：每家多回 models（輕量／標準／進階＋型號名）、目前生效的 model、custom；仍不回 key', () => {
    const e = env({ properties: Object.assign({ CLAUDE_MODEL: 'claude-sonnet-5-5' }, KEYS) });
    const out = get(e);
    for (const p of out.providers) {
      assert.deepEqual(p.models.map((m) => m.id), LIST[p.id], p.id);
      assert.deepEqual(p.models.map((m) => m.tier), TIERS, p.id);
      assert.ok(p.models.every((m) => m.label && !/\$/.test(m.label)), '有型號名、不顯示價格');
    }
    const claude = out.providers.find((p) => p.id === 'claude');
    assert.equal(claude.model, 'claude-sonnet-5-5');
    assert.equal(claude.custom, false);
    const raw = JSON.stringify(out);
    for (const k of Object.values(KEYS)) assert.ok(!raw.includes(k), '不能有 key：' + k);
  });

  test('清單外的值（Neil 在編輯器手動設的）照用、custom:true', () => {
    const e = env({ properties: Object.assign({ GEMINI_MODEL: 'gemini-2.5-pro' }, KEYS) });
    const g = get(e).providers.find((p) => p.id === 'gemini');
    assert.equal(g.model, 'gemini-2.5-pro');
    assert.equal(g.custom, true);
    ask(e);
    assert.match(e.net.calls[0].url, /models\/gemini-2\.5-pro:generateContent/);
  });

  test('aiConfigSet 只改模型、不改供應商：寫該家的 *_MODEL、寫 logs（哪家、從哪個到哪個）', () => {
    const e = env({ properties: KEYS });
    const out = set(e, { provider: 'claude', model: 'claude-sonnet-5-5' });
    assert.deepEqual(out, { success: true, provider: 'gemini', target: 'claude', model: 'claude-sonnet-5-5' });
    assert.equal(e.properties.CLAUDE_MODEL, 'claude-sonnet-5-5');
    assert.equal(e.properties.AI_PROVIDER, undefined, '供應商不動');
    const log = e.transactions.find((t) => t[0] === 'AI');
    assert.match(log[3], /Claude 模型：Haiku 5\.5 → Sonnet 5\.5/);
    assert.equal(log[6], ME);
    assert.match(ask(e), /由 Gemini 彙整/, '回覆標示不變、仍用 Gemini');
  });

  test('aiConfigSet：清單外的 model、他家的 model id、沒 key 的那家、非管理員都拒絕，設定不動', () => {
    const e = env({ properties: { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' } });
    assert.equal(set(e, { provider: 'openai', model: 'gpt-5' }).error, 'unknown_model');
    assert.equal(set(e, { provider: 'openai', model: 'claude-haiku-5-5' }).error, 'unknown_model');
    assert.equal(set(e, { provider: 'claude', model: 'claude-opus-5-5' }).error, 'no_key');
    assert.equal(set(e, { provider: 'grok', model: 'x' }).error, 'unknown_provider');
    assert.equal(set(e, { provider: 'openai', model: 'gpt-6-astra' }, TOK_MOM).error, 'forbidden');
    assert.equal(e.properties.OPENAI_MODEL, undefined);
    assert.equal(e.properties.CLAUDE_MODEL, undefined);
  });

  test('Gemini 3 系列：推理強度 low（thinkingLevel）、不送 temperature（官方建議維持預設）；舊型號照舊 0.2', () => {
    const e = env({ properties: KEYS });
    ask(e);
    const g = e.net.calls[0].body.generationConfig;
    assert.deepEqual(g, { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
    const old = env({ properties: Object.assign({ GEMINI_MODEL: 'gemini-2.5-flash' }, KEYS) });
    ask(old);
    assert.deepEqual(old.net.calls[0].body.generationConfig, { temperature: 0.2, maxOutputTokens: 2048 });
  });

  test('OpenAI／Claude 標準與進階級：同一組參數（官方文件三級都收 low）', () => {
    for (const [id, prop, model] of [['openai', 'OPENAI_MODEL', 'gpt-6-astra'], ['claude', 'CLAUDE_MODEL', 'claude-opus-5-5']]) {
      const e = env({ properties: Object.assign({ AI_PROVIDER: id, [prop]: model }, KEYS) });
      ask(e);
      const b = e.net.calls[0].body;
      assert.equal(b.model, model);
      if (id === 'openai') assert.equal(b.reasoning_effort, 'low');
      else assert.deepEqual(b.output_config, { effort: 'low' });
      assert.equal('temperature' in b, false);
    }
  });

  test('diagnoseAi：測各家目前生效的模型', () => {
    const e = env({ properties: Object.assign({ CLAUDE_MODEL: 'claude-opus-5-5' }, KEYS) });
    const out = e.call('diagnoseAi');
    assert.deepEqual(out.map((l) => l.model), ['gemini-3.5-flash-lite', 'gpt-6-luna', 'claude-opus-5-5']);
    assert.equal(e.net.calls.find((c) => c.who === 'claude').body.model, 'claude-opus-5-5');
  });

  /* ---------- PWA ---------- */
  const models = (id) => LIST[id].map((m, i) => ({ id: m, tier: TIERS[i], label: m.toUpperCase() }));
  const CFG = () => ({ success: true, provider: 'gemini', lastError: null, providers: [
    { id: 'gemini', label: 'Gemini', hasKey: true, model: 'gemini-2.5-pro', custom: true, models: models('gemini') },
    { id: 'openai', label: 'OpenAI', hasKey: false, model: 'gpt-6-luna', custom: false, models: models('openai') },
    { id: 'claude', label: 'Claude', hasKey: true, model: 'claude-sonnet-5-5', custom: false, models: models('claude') }] });
  function fe(handler) {
    const e = loadFrontend({ fetchImpl: ({ body }) => ({ json: () => Promise.resolve(handler(body)) }) });
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:"TRUE"}]');
    const els = {};
    const doc = e.context.document;
    const orig = doc.getElementById;
    e.set('document', Object.assign({}, doc, { getElementById: (id) => els[id] || (els[id] = orig(id)) }));
    return { e, els };
  }

  test('設定頁：每家一個模型下拉（等級＋型號名），選中目前的；自訂的顯示「自訂：xxx」；沒 key 的整列 disabled', () => {
    const { e, els } = fe(() => CFG());
    e.raw('aiState.cfg = ' + JSON.stringify(CFG()));
    e.call('renderAiCard');
    const html = els.aiBody.innerHTML;
    assert.match(html, /<select [^>]*onchange="pickAiModel\('claude', this\.value\)"[^>]*>/);
    assert.match(html, /<option value="claude-sonnet-5-5" selected>標準・CLAUDE-SONNET-5-5<\/option>/);
    assert.match(html, /<option value="gemini-2\.5-pro" selected disabled>自訂：gemini-2\.5-pro<\/option>/);
    assert.match(html, /<option value="gemini-3\.5-flash-lite">輕量・GEMINI-3\.5-FLASH-LITE<\/option>/);
    assert.match(html, /<select disabled [^>]*onchange="pickAiModel\('openai', this\.value\)"/);
  });

  test('改模型：送 aiConfigSet（provider＋model、trigger write），送出中再改不重送；成功後畫面跟著換', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const e = loadFrontend({ fetchImpl: ({ body }) => ({ json: () => (body.action === 'aiConfigSet'
      ? gate.then(() => ({ success: true, provider: 'gemini', target: 'gemini', model: 'gemini-3.8-flash' })) : Promise.resolve(CFG())) }) });
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:"TRUE"}]');
    e.raw('aiState.cfg = ' + JSON.stringify(CFG()));
    const a = e.callRaw('pickAiModel', 'gemini', 'gemini-3.8-flash');
    e.callRaw('pickAiModel', 'gemini', 'gemini-3.1-pro-preview');
    release();
    await a;
    const sets = e.calls.filter((c) => c.body.action === 'aiConfigSet');
    assert.equal(sets.length, 1);
    assert.deepEqual([sets[0].body.provider, sets[0].body.model, sets[0].body.trigger], ['gemini', 'gemini-3.8-flash', 'write']);
    assert.equal(e.read('aiState.cfg.providers[0].model'), 'gemini-3.8-flash');
    assert.equal(e.read('aiState.cfg.providers[0].custom'), false);
    assert.equal(e.read('aiState.cfg.provider'), 'gemini', '供應商不動');
    assert.ok(e.toasts.some((t) => /Gemini 改用 GEMINI-3\.8-FLASH/.test(t)));
  });
});
