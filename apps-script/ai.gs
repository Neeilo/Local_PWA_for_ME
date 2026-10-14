/**
 * ADR-017 AI 供應商切換：Gemini／OpenAI／Claude
 *
 * 「查/」原本寫死 Gemini（line-router.gs 的 callGemini_）。這裡把出口收成一個 callAi_(prompt)：
 *   - 目前用哪一家存指令碼屬性 AI_PROVIDER（不建新分頁：開機、「初始化」都不受影響）；
 *     空白或不認得 → gemini，跟改版前一樣
 *   - key 由 Neil 設在指令碼屬性（D-2），**永遠不傳到前端**；前端只知道「有沒有」
 *   - 失敗直接回報、**不自動換家**（D-4）：錢包的掌控權留在 Neil 手上
 *   - 最後一次失敗記在指令碼屬性 AI_LAST_ERROR（只留一筆），設定頁看得到
 *
 * 模型都可以用指令碼屬性覆寫（GEMINI_MODEL／OPENAI_MODEL／CLAUDE_MODEL）——各家改版比我們快，
 * 不必回頭改程式。不確定 key 或模型對不對，在編輯器跑 diagnoseAi()。
 *
 * 各家實際採用的端點與預設模型（2026-10-14 依官方文件）：
 *   - Gemini：沿用 line-router.gs 的 callGemini_（generateContent），行為不變
 *   - OpenAI：Chat Completions（v1/chat/completions），預設 gpt-6-luna（便宜快速級）
 *   - Claude：Messages API（v1/messages，anthropic-version 2023-06-01），預設 claude-haiku-5-5
 * 三家輸出上限都沿用 GEMINI_MAX_OUTPUT_TOKENS（2048）。OpenAI、Claude 的這兩個模型不收非預設的
 * temperature（Claude Haiku 5.5 會回 400），所以不送；改用推理強度 low——「查/」只要 5 行回覆，
 * 思考吃掉的 token 也算在上限裡，給太深只會把答案擠到被截斷。
 */

var AI_PROVIDER_PROP = 'AI_PROVIDER';
var AI_LAST_ERROR_PROP = 'AI_LAST_ERROR';
var AI_DEFAULT_PROVIDER = 'gemini';
var AI_LOG_SOURCE = 'AI';

var OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
var OPENAI_MODEL_DEFAULT = 'gpt-6-luna';
var CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_API_VERSION = '2023-06-01';
var CLAUDE_MODEL_DEFAULT = 'claude-haiku-5-5';

/** 被截斷時接在答案後面的那一句（三家同一句；Gemini 那條在 callGemini_ 裡，字一樣） */
var AI_TRUNCATED_NOTE = '\n\n⚠️ 回應太長被截斷了，問得更具體一點會比較完整。';

/**
 * 對照表。用函式現組，不寫成頂層物件：GEMINI_MODEL_DEFAULT 在 line-router.gs，
 * Apps Script 各檔的載入順序不保證，頂層就引用別檔的常數可能拿到 undefined。
 * call 也在呼叫當下才查全域（測試可以換掉 callGemini_）。
 */
function aiProviders_() {
  return {
    gemini: { label: 'Gemini', keyProp: 'GEMINI_API_KEY', modelProp: 'GEMINI_MODEL', defaultModel: GEMINI_MODEL_DEFAULT,
              call: function (key, model, prompt) { return callGemini_(key, prompt, model); } },
    openai: { label: 'OpenAI', keyProp: 'OPENAI_API_KEY', modelProp: 'OPENAI_MODEL', defaultModel: OPENAI_MODEL_DEFAULT,
              call: function (key, model, prompt) { return callOpenAi_(key, model, prompt); } },
    claude: { label: 'Claude', keyProp: 'ANTHROPIC_API_KEY', modelProp: 'CLAUDE_MODEL', defaultModel: CLAUDE_MODEL_DEFAULT,
              call: function (key, model, prompt) { return callClaude_(key, model, prompt); } }
  };
}
var AI_PROVIDER_IDS = ['gemini', 'openai', 'claude'];

function aiProp_(name) {
  var raw = PropertiesService.getScriptProperties().getProperty(name);
  return raw ? String(raw).trim() : '';      // 從網頁複製常帶到換行或空白
}

/** 目前用哪一家。空白或不認得 → gemini（跟改版前一樣） */
function aiProviderId_() {
  var id = aiProp_(AI_PROVIDER_PROP).toLowerCase();
  return AI_PROVIDER_IDS.indexOf(id) === -1 ? AI_DEFAULT_PROVIDER : id;
}

function aiModelOf_(p) {
  return aiProp_(p.modelProp) || p.defaultModel;
}

/**
 * 統一出口 → { ok, text, truncated, reason, detail, provider, model, label, missingKey }
 * 只打目前選定的那一家；失敗也不換家（D-4）。
 */
function callAi_(prompt) {
  var id = aiProviderId_();
  var p = aiProviders_()[id];
  var model = aiModelOf_(p);
  var base = { provider: id, model: model, label: p.label };
  var key = aiProp_(p.keyProp);
  if (!key) return Object.assign({ ok: false, reason: 'no_key', missingKey: p.keyProp, detail: '' }, base);

  var res;
  try {
    res = p.call(key, model, prompt) || {};
  } catch (err) {
    res = { ok: false, reason: '程式錯誤', detail: String(err && err.stack || err) };
  }
  var out = Object.assign({}, res, base);
  if (!out.ok) aiNoteError_(id, out.reason);
  return out;
}

/** 最後一次失敗（只留一筆）。寫不進去不影響回覆——這是給人回頭看的 */
function aiNoteError_(id, reason) {
  try {
    PropertiesService.getScriptProperties().setProperty(AI_LAST_ERROR_PROP,
      JSON.stringify({ at: new Date().toISOString(), provider: id, reason: String(reason || '').slice(0, 200) }));
  } catch (err) {
    console.log('記不下 AI 最後一次失敗：' + err);
  }
}

function aiLastError_() {
  var raw = aiProp_(AI_LAST_ERROR_PROP);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

/* -------------------------------------------------------------------------- */
/* OpenAI（Chat Completions）                                                  */
/* -------------------------------------------------------------------------- */
function callOpenAi_(key, model, prompt) {
  var res;
  try {
    res = UrlFetchApp.fetch(OPENAI_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: GEMINI_MAX_OUTPUT_TOKENS,
        reasoning_effort: 'low'
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.log('OpenAI 連線失敗（model=' + model + '）：' + err);
    return { ok: false, reason: '連線失敗', detail: String(err && err.stack || err) };
  }
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) {
    console.log('OpenAI HTTP ' + code + '（model=' + model + '）：' + body);
    return { ok: false, reason: 'HTTP ' + code + (code === 404 ? '（模型「' + model + '」可能不存在，跑 diagnoseAi）' : ''),
             detail: truncate_(body, 800) };
  }
  var parsed;
  try { parsed = JSON.parse(body); } catch (err) {
    return { ok: false, reason: '回應格式錯誤', detail: truncate_(body, 800) };
  }
  var choice = (parsed && parsed.choices && parsed.choices[0]) || {};
  var msg = choice.message || {};
  var text = typeof msg.content === 'string' ? msg.content.trim() : '';
  var hitCap = choice.finish_reason === 'length';
  if (!text) {
    return { ok: false, reason: msg.refusal ? '拒絕回答' : (hitCap ? '回應被 token 上限截斷且無內容' : '回應沒有內容'),
             detail: truncate_(body, 800) };
  }
  if (hitCap) return { ok: true, text: text + AI_TRUNCATED_NOTE, truncated: true };
  return { ok: true, text: text };
}

/* -------------------------------------------------------------------------- */
/* Claude（Messages API）                                                      */
/* -------------------------------------------------------------------------- */
function callClaude_(key, model, prompt) {
  var res;
  try {
    res = UrlFetchApp.fetch(CLAUDE_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': CLAUDE_API_VERSION },
      payload: JSON.stringify({
        model: model,
        max_tokens: GEMINI_MAX_OUTPUT_TOKENS,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.log('Claude 連線失敗（model=' + model + '）：' + err);
    return { ok: false, reason: '連線失敗', detail: String(err && err.stack || err) };
  }
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) {
    console.log('Claude HTTP ' + code + '（model=' + model + '）：' + body);
    return { ok: false, reason: 'HTTP ' + code + (code === 404 ? '（模型「' + model + '」可能不存在，跑 diagnoseAi）' : ''),
             detail: truncate_(body, 800) };
  }
  var parsed;
  try { parsed = JSON.parse(body); } catch (err) {
    return { ok: false, reason: '回應格式錯誤', detail: truncate_(body, 800) };
  }
  // 先看 stop_reason 再讀內容：拒答時 content 可能是空的或不完整
  if (parsed.stop_reason === 'refusal') return { ok: false, reason: '拒絕回答', detail: truncate_(body, 800) };
  var text = ((parsed && parsed.content) || [])
    .filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; })
    .map(function (b) { return b.text; }).join('').trim();
  var hitCap = parsed.stop_reason === 'max_tokens';
  if (!text) {
    return { ok: false, reason: hitCap ? '回應被 token 上限截斷且無內容' : '回應沒有內容', detail: truncate_(body, 800) };
  }
  if (hitCap) return { ok: true, text: text + AI_TRUNCATED_NOTE, truncated: true };
  return { ok: true, text: text };
}

/* -------------------------------------------------------------------------- */
/* 管理員 action（PWA 設定頁「🤖 AI 供應商」）                                    */
/* -------------------------------------------------------------------------- */
function aiForbidden_(caller, action) {
  logTransaction_(AI_LOG_SOURCE, '失敗', 'PWA ' + action, '不是管理者，拒絕', 'code=forbidden', '', caller.line_id);
  return { error: 'forbidden' };
}

/** aiConfigGet：目前用哪家、各家有沒有 key（**只回有沒有，絕不回 key**）與模型、最後一次失敗 */
function aiConfigGet_(caller) {
  if (!truthy_((caller.user || {}).is_admin)) return aiForbidden_(caller, 'aiConfigGet');
  var table = aiProviders_();
  return {
    success: true,
    provider: aiProviderId_(),
    providers: AI_PROVIDER_IDS.map(function (id) {
      var p = table[id];
      return { id: id, label: p.label, hasKey: !!aiProp_(p.keyProp), model: aiModelOf_(p) };
    }),
    lastError: aiLastError_()
  };
}

/** aiConfigSet：只收三家之一；沒有 key 的那一家不能選；寫 logs（誰、從哪家到哪家） */
function aiConfigSet_(caller, provider) {
  if (!truthy_((caller.user || {}).is_admin)) return aiForbidden_(caller, 'aiConfigSet');
  var id = String(provider == null ? '' : provider).trim().toLowerCase();
  if (AI_PROVIDER_IDS.indexOf(id) === -1) return { error: 'unknown_provider' };
  var p = aiProviders_()[id];
  if (!aiProp_(p.keyProp)) return { error: 'no_key', key: p.keyProp };
  var from = aiProviderId_();
  PropertiesService.getScriptProperties().setProperty(AI_PROVIDER_PROP, id);
  logTransaction_(AI_LOG_SOURCE, '成功', 'PWA aiConfigSet', 'AI 供應商：' + aiProviders_()[from].label + ' → ' + p.label,
    'from=' + from + '｜to=' + id, '', caller.line_id);
  return { success: true, provider: id };
}

/* -------------------------------------------------------------------------- */
/* 診斷（編輯器執行）                                                          */
/* -------------------------------------------------------------------------- */
/**
 * 三家各打一次極短的請求，列出 key 有無、HTTP 結果、耗時、模型。不改目前的選擇、不記最後一次失敗。
 * diagnoseGemini 保留（它會列出 Gemini 這把 key 能用哪些模型）。
 */
function diagnoseAi() {
  var table = aiProviders_();
  var current = aiProviderId_();
  var out = AI_PROVIDER_IDS.map(function (id) {
    var p = table[id];
    var key = aiProp_(p.keyProp);
    var model = aiModelOf_(p);
    var line = { id: id, label: p.label, model: model, hasKey: !!key, ok: false, ms: 0, reason: '' };
    if (!key) { line.reason = '缺 ' + p.keyProp; return line; }
    var t = Date.now();
    var res;
    try { res = p.call(key, model, '只回覆「OK」兩個字。') || {}; } catch (err) { res = { ok: false, reason: String(err) }; }
    line.ms = Date.now() - t;
    line.ok = !!res.ok;
    line.reason = res.ok ? '' : String(res.reason || '');
    return line;
  });
  console.log('目前使用：' + table[current].label + '（' + current + '）');
  out.forEach(function (l) {
    console.log((l.ok ? '✅ ' : '❌ ') + l.label + '｜model=' + l.model + '｜' +
      (l.hasKey ? (l.ok ? l.ms + ' ms' : l.reason + '（' + l.ms + ' ms）') : l.reason));
  });
  return out;
}
