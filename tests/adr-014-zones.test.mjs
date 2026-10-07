/**
 * ADR-014 PR-B — 兩區版面（T5）× 首頁重組（T6）× 設定頁（T7）
 *
 * 盯的事：
 *   - 首頁鈕三層：別頁 → 回首頁；首頁已往下捲 → 捲回頂端；首頁頂端 → 切區。「⇄」只在首頁頂端出現
 *   - 切區不發任何請求；動畫中再點，停在最後一次的區
 *   - 任務在兩區的導覽是同一格；兩區的任務卡是同一張（不在主題卡裡）
 *   - 只有一區功能的人看不到「⇄」，點了也不切
 *   - 非管理員看不到「管理」；管理卡沒點開不發請求
 *   - 舊的導覽配置 localStorage 不會讓畫面壞掉
 *   - 主色：亮／暗、兩區四組對比都 ≥ 4.5:1（從 CSS 讀出色碼實算）
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
const ME = 'Uneil';
const ALL_FEATS = { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_review: 'TRUE', feat_notes: 'TRUE', feat_mood: 'TRUE', feat_log: 'TRUE' };

/** 夠用的 DOM：元素依 id 固定、classList 真的會記、.view 的 active 查得到 */
function withDom(e) {
  const els = {};
  const mk = (id) => {
    const cls = new Set();
    return { id, value: '', innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)) },
      setAttribute() {}, addEventListener() {} };
  };
  const get = (id) => els[id] || (els[id] = mk(id));
  const views = ['home', 'plans', 'expenses', 'tasks', 'review', 'notes'].map((v) => get('view-' + v));
  views[0].classList.add('active');
  const attrs = {};
  const root = { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] };
  e.set('document', Object.assign({}, e.context.document, {
    getElementById: get,
    documentElement: root,
    querySelector: (sel) => (sel === '.view.active' ? views.find((v) => v.classList.contains('active')) || null : get('_q')),
    querySelectorAll: (sel) => (sel === '.view' ? views : [])
  }));
  e.context.scrollY = 0;
  e.context.scrollTo = (o) => { e.scrolls.push(o); e.context.scrollY = 0; };
  e.context.requestAnimationFrame = (fn) => fn();
  e.scrolls = [];
  e.els = new Proxy(els, { get: (_t, id) => get(id) });
  e.attrs = attrs;
  return e;
}

function env({ feats = ALL_FEATS, admin = false, extra = '' } = {}) {
  const e = withDom(loadFrontend({}));
  const u = Object.assign({ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: admin ? 'TRUE' : '' }, feats);
  e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; state = EMPTY_STATE(); firstLoadDone = true');
  e.raw('roster = ' + JSON.stringify([u]) + '; rosterStatus = "ok"; cloudDenied = []');
  if (extra) e.raw(extra);
  return e;
}
const active = (e) => e.call('currentView');
const requests = (e) => e.calls.filter((c) => c.body && c.body.action).length;

/* ========================================================================== */
describe('T5 首頁鈕分層觸發（D-3）', () => {

  test('別頁點 🧭 → 回首頁（不切區）', () => {
    const e = env();
    e.call('goView', 'tasks');
    assert.equal(active(e), 'tasks');
    e.call('homeTap');
    assert.equal(active(e), 'home');
    assert.equal(e.read('zone'), 'finance');
  });

  test('首頁已往下捲 → 捲回頂端（不切區）', () => {
    const e = env();
    e.context.scrollY = 600;
    e.call('homeTap');
    assert.equal(e.scrolls.length, 1);
    assert.equal(e.scrolls[0].top, 0);
    assert.equal(e.read('zone'), 'finance');
  });

  test('首頁頂端 → 切區，再點切回來', () => {
    const e = env();
    e.call('homeTap');
    assert.equal(e.read('zone'), 'productivity');
    assert.equal(e.attrs['data-zone'], 'productivity');
    e.call('homeTap');
    assert.equal(e.read('zone'), 'finance');
  });

  test('「⇄」只在首頁頂端出現', () => {
    const e = env();
    assert.equal(e.call('homeLabel'), '財務 ⇄');
    e.context.scrollY = 300;
    assert.equal(e.call('homeLabel'), '財務');
    e.context.scrollY = 0;
    e.call('goView', 'expenses');
    assert.equal(e.call('homeLabel'), '財務');
  });

  test('每支手機記住上次的區；第一次預設財務；存壞了也是財務', () => {
    const e = env();
    assert.equal(e.call('loadZone'), 'finance');
    e.call('setZone', 'productivity');
    assert.equal(e.localStorage.getItem('personal-os-zone'), 'productivity');
    assert.equal(e.call('loadZone'), 'productivity');
    e.localStorage.setItem('personal-os-zone', 'stocks???');
    assert.equal(e.call('loadZone'), 'finance');
  });
});

/* ========================================================================== */
describe('T5 切區（D-8）', () => {

  test('⚠️ 切區不發任何雲端請求', () => {
    const e = env();
    const before = requests(e);
    for (let i = 0; i < 5; i++) e.call('switchZone');
    assert.equal(requests(e), before);
  });

  test('有 View Transitions：動畫中再點 → 跳過上一段，停在最後一次的區', () => {
    const e = env();
    const pending = [];
    e.context.document.startViewTransition = (cb) => {
      const t = { cb, skipped: false, finished: new Promise(() => {}), skipTransition() { if (!this.skipped) { this.skipped = true; cb(); } } };
      pending.push(t);
      return t;
    };
    e.call('switchZone');          // → 生產力（動畫還沒跑完）
    e.call('switchZone');          // → 財務：上一段被跳過
    e.call('switchZone');          // → 生產力
    assert.equal(pending.length, 3);
    assert.ok(pending[0].skipped && pending[1].skipped && !pending[2].skipped);
    pending[2].cb();               // 最後一段動畫跑完
    assert.equal(e.read('zone'), 'productivity');
    assert.equal(e.attrs['data-zone'], 'productivity');
    assert.equal(e.attrs['data-zone-dir'], 'from-right', '生產力從右進');
  });

  test('不支援 View Transitions → 直接切換', () => {
    const e = env();
    e.call('switchZone');
    assert.equal(e.attrs['data-zone'], 'productivity');
    assert.equal(e.els.zoneProductivity.hidden, false);
    assert.equal(e.els.zoneFinance.hidden, true);
  });
});

/* ========================================================================== */
describe('T5 導覽（D-4）', () => {

  test('財務：記帳｜分期｜🧭｜任務｜（股票隱藏）；生產力：雜記｜日誌｜🧭｜任務｜—', () => {
    const e = env();
    e.call('renderNav');
    const fin = e.els.nav.innerHTML;
    e.call('setZone', 'productivity');
    const pro = e.els.nav.innerHTML;
    const slots = (h) => h.split(/(?=<button|<span class="nav-slot")/).map((x) =>
      (x.match(/data-view="(\w+)"/) || [null, '·'])[1]);
    assert.deepEqual(slots(fin), ['expenses', 'plans', 'home', 'tasks', '·']);
    assert.deepEqual(slots(pro), ['notes', 'review', 'home', 'tasks', '·']);
    assert.doesNotMatch(fin, /股票/);
  });

  test('任務在兩區同一格（第 4 格）', () => {
    const e = env();
    const z = e.read('ZONES');
    assert.equal(z.finance.nav.indexOf('tasks'), 3);
    assert.equal(z.productivity.nav.indexOf('tasks'), 3);
  });

  test('沒開的功能留空格，不往前補位（任務仍在第 4 格）', () => {
    const e = env({ feats: Object.assign({}, ALL_FEATS, { feat_notes: '' }) });
    e.call('setZone', 'productivity');
    const h = e.els.nav.innerHTML;
    assert.doesNotMatch(h, /data-view="notes"/);
    const order = h.split(/(?=<button|<span class="nav-slot")/).map((x) => (x.match(/data-view="(\w+)"/) || [null, '·'])[1]);
    assert.equal(order.indexOf('tasks'), 3);
  });

  test('只有一區功能的人（麗英：記帳＋任務）：沒有「⇄」，頂端點了也不切', () => {
    const e = env({ feats: { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_review: '', feat_notes: '', feat_mood: '', feat_log: '' } });
    assert.equal(e.call('canSwitchZone'), false);
    assert.equal(e.call('homeLabel'), '財務');
    e.call('homeTap');
    assert.equal(e.call('effectiveZone'), 'finance');
  });

  test('只有生產力功能的人：固定在生產力，就算手機記的是財務', () => {
    const e = env({ feats: { feat_expense: '', feat_tasks: 'TRUE', feat_review: 'TRUE', feat_notes: '', feat_mood: '', feat_log: '' } });
    e.raw('zone = "finance"');
    assert.equal(e.call('effectiveZone'), 'productivity');
    e.call('renderNav');
    assert.equal(e.attrs['data-zone'], 'productivity');
  });

  test('日誌頁也放心情：只開心情也進得去；兩個都關才藏整頁', () => {
    const only = (f) => env({ feats: Object.assign({}, ALL_FEATS, f) });
    assert.equal(only({ feat_review: '' }).call('viewAllowed', 'review'), true);
    assert.equal(only({ feat_mood: '' }).call('viewAllowed', 'review'), true);
    assert.equal(only({ feat_review: '', feat_mood: '' }).call('viewAllowed', 'review'), false);
    const e = only({ feat_review: '' });
    e.call('renderReviewView');
    assert.equal(e.els.reviewBlock.hidden, true);
    assert.equal(e.els.moodBlock.hidden, false);
  });

  test('分期頁跟著記帳權限；股票永遠進不去', () => {
    assert.equal(env().call('viewAllowed', 'plans'), true);
    assert.equal(env({ feats: Object.assign({}, ALL_FEATS, { feat_expense: '' }) }).call('viewAllowed', 'plans'), false);
    assert.equal(env().call('viewAllowed', 'stocks'), false);
  });

  test('⚠️ 舊的導覽配置 localStorage 不會讓畫面壞掉，也沒有程式再讀它', () => {
    const e = withDom(loadFrontend({ storage: { 'personal-os-nav-placement': '{"expenses":"left","mood":"right"}',
      'personal-os-nav-slot': 'mood', 'personal-os-zone': 'productivity' } }));
    e.raw('myLineId = "' + ME + '"; roster = [{line_id:"' + ME + '", is_active:"TRUE"}]; state = EMPTY_STATE()');
    e.raw('zone = loadZone()');
    e.call('applyZone');
    assert.equal(e.attrs['data-zone'], 'productivity');
    assert.doesNotMatch(HTML, /getItem\([^)]*nav-(placement|slot)/);
    assert.match(HTML, /LEGACY_NAV_KEYS\.forEach\(k=>\{ try\{ localStorage\.removeItem\(k\)/, '開機時清掉');
  });

  test('心情脈搏只在日誌頁出現；開機停在首頁時也是藏起來的', () => {
    const e = env();
    e.call('applyZone');
    assert.equal(e.els.pulse.style.display, 'none');
    e.call('goView', 'review');
    assert.equal(e.els.pulse.style.display, 'flex');
    e.call('goView', 'tasks');
    assert.equal(e.els.pulse.style.display, 'none');
  });

  test('第一次有兩區可切 → 提示一次，之後不再提示', () => {
    const e = env();
    e.call('maybeZoneHint');
    e.call('maybeZoneHint');
    assert.equal(e.toasts.filter((t) => t.includes('切換財務／生產力')).length, 1);
  });
});

/* ========================================================================== */
describe('T6 首頁重組', () => {

  const zoneCardHtml = HTML.slice(HTML.indexOf('id="zoneCard"'), HTML.indexOf('<!-- ────── 共用帶'));

  test('任務、白板、Email 在共用帶（不在主題卡裡），兩區看到的是同一張', () => {
    for (const id of ['dashTasksCard', 'dashBoardCard', 'emailCard']) {
      assert.doesNotMatch(zoneCardHtml, new RegExp('id="' + id + '"'), id);
      assert.match(HTML, new RegExp('id="' + id + '"'));
    }
  });

  test('首頁不再有身份卡、導覽配置、顯示設定、成員、效能、系統設定、效能提醒卡', () => {
    const home = HTML.slice(HTML.indexOf('id="view-home"'), HTML.indexOf('id="view-plans"'));
    for (const id of ['meCard', 'perfAlert', 'placeRows', 'themeBtns', 'adminCard', 'perfCard', 'sysCard']) {
      assert.doesNotMatch(home, new RegExp('id="' + id + '"'), id);
    }
  });

  test('財務主題卡的分期：本月應付＝這個月的各期；剩餘＝今天之後的各期', () => {
    const e = env();
    const mk = e.call('monthKey');
    const today = e.call('todayKey');
    const far = (Number(mk.slice(0, 4)) + 1) + '-01-15';
    e.raw('installmentPlans = [{plan_id:"p1", status:"active"}, {plan_id:"p2", status:"ended"}]');
    e.raw('state.expenses = ' + JSON.stringify([
      { id: 1, date: today, type: 'expense', amount: 1000, plan_id: 'p1', plan_seq: '1／3', line_id: ME },
      { id: 2, date: far, type: 'expense', amount: 1000, plan_id: 'p1', plan_seq: '3／3', line_id: ME },
      { id: 3, date: today, type: 'expense', amount: 999, line_id: ME }
    ]));
    const f = e.call('dashPlanFigures');
    assert.equal(f.month, 1000);
    assert.equal(f.left, 1000);
    assert.equal(f.plans, 1);
  });

  test('生產力主題卡：點心情就記一筆（送 moods），最近雜記只列 2 筆', () => {
    const e = env();
    e.raw('state.notes = [{id:1,txt:"a",ts:3},{id:2,txt:"b",ts:2},{id:3,txt:"c",ts:1}]');
    e.call('renderDashNotes');
    assert.equal((e.els.dashNotes.innerHTML.match(/dash-note/g) || []).length, 2);
    e.call('quickMood', 4);
    const w = e.calls.filter((c) => c.body && c.body.sheet === 'moods');
    assert.equal(w.length, 1);
    assert.equal(w[0].body.record.level, 4);
  });

  test('主題卡各塊依 feat_* 收起', () => {
    const e = env({ feats: Object.assign({}, ALL_FEATS, { feat_mood: '', feat_notes: '' }) });
    e.call('renderZoneCard');
    assert.equal(e.els.dashMoodBtns.hidden, true);
    assert.equal(e.els.dashReview.hidden, false);
    assert.equal(e.els.dashNotesCard.hidden, true);
  });

  test('分期頁只列進行中的計畫', () => {
    const e = env();
    e.raw('installmentPlans = [{plan_id:"p1", status:"active", total:3000, periods:3, category:"購物"}, {plan_id:"p2", status:"ended", total:1, periods:1}]');
    e.call('renderPlansView');
    assert.match(e.els.planList.innerHTML, /p1/);
    assert.doesNotMatch(e.els.planList.innerHTML, /p2/);
    assert.match(e.els.planList.innerHTML, /結束計畫/);
  });
});

/* ========================================================================== */
describe('T7 設定頁', () => {

  test('非管理員：沒有「管理」分段鈕，硬切也回到個人', () => {
    const e = env();
    e.call('openSettings');
    assert.equal(e.els.setSeg.hidden, true);
    e.call('setSettingsTab', 'admin');
    assert.equal(e.read('settingsTab'), 'personal');
    assert.equal(e.els.setAdmin.hidden, true);
    assert.equal(e.els.setPersonal.hidden, false);
  });

  test('管理員：有分段鈕；打開設定、切到管理都不發請求；管理卡預設全收', () => {
    const e = env({ admin: true });
    const before = requests(e);
    e.call('openSettings');
    e.call('setSettingsTab', 'admin');
    assert.equal(e.els.setSeg.hidden, false);
    assert.equal(requests(e), before, '摘要只用 boot 已有的資料');
    for (const k of ['members', 'sys', 'perf', 'logs', 'archive']) assert.equal(e.els['fold-' + k].hidden, true, k);
  });

  test('點開才抓：效能 → perfSummary；系統設定 → adminView；LOG → read logs；收起再開不重抓效能', async () => {
    const e = env({ admin: true });
    const reply = { perfSummary: { success: true, total: 0 }, adminView: { success: true, rows: [] }, read: { success: true, data: [] } };
    e.set('fetch', (_u, o) => {
      const body = JSON.parse(o.body);
      e.calls.push({ body });
      return Promise.resolve({ json: () => Promise.resolve(reply[body.action] || { success: true }) });
    });
    e.call('openSettings');
    for (const k of ['perf', 'sys', 'logs']) e.call('toggleFold', k);
    await new Promise((r) => setImmediate(r));
    const acts = () => e.calls.filter((c) => c.body && c.body.action).map((c) => c.body.action + (c.body.sheet ? ':' + c.body.sheet : ''));
    assert.ok(acts().includes('perfSummary'));
    assert.ok(acts().includes('adminView'));
    assert.ok(acts().includes('read:logs'));
    e.call('toggleFold', 'perf');                 // 收起
    e.call('toggleFold', 'perf');                 // 再開
    await new Promise((r) => setImmediate(r));
    assert.equal(acts().filter((a) => a === 'perfSummary').length, 1, '已經抓過的摘要不重抓（要更新按「重新整理最近 7 天」）');
  });

  test('大頭貼：顯示名稱首字；管理員有待審成員 → 小紅點；一般成員沒有', () => {
    const e = env({ admin: true, extra: 'roster.push({line_id:"Unew", is_active:""})' });
    e.call('renderAvatar');
    assert.equal(e.els.avatarChar.textContent, 'N');
    assert.equal(e.els.avatarDot.hidden, false);
    const m = env({ extra: 'roster.push({line_id:"Unew", is_active:""})' });
    m.call('renderAvatar');
    assert.equal(m.els.avatarDot.hidden, true);
  });

  test('效能紀錄超過門檻 → 紅點（取代首頁的提醒卡）', () => {
    const e = env({ admin: true, extra: 'perfRows = 999999' });
    e.call('renderAvatar');
    assert.equal(e.els.avatarDot.hidden, false);
  });

  test('LOG 只給管理員，跟 feat_log 無關（feat_log 退場）；權限矩陣不再有 LOG 開關', () => {
    const a = env({ admin: true, feats: Object.assign({}, ALL_FEATS, { feat_log: '' }) });
    a.call('renderLogCard');
    assert.equal(a.els.logCard.hidden, false);
    const c = env({ feats: Object.assign({}, ALL_FEATS, { feat_log: 'TRUE' }) });
    c.call('renderLogCard');
    assert.equal(c.els.logCard.hidden, true);
    assert.equal(a.read('FEATURE_KEYS').includes('feat_log'), false);
  });

  test('我的裝置：按了才抓，抓的是自己（不帶別人的 line_id）', async () => {
    const e = env();
    e.call('openSettings');
    assert.equal(e.calls.filter((c) => c.body && c.body.action === 'listDevices').length, 0);
    await e.callRaw('loadMyDevices');
    const c = e.calls.filter((x) => x.body && x.body.action === 'listDevices');
    assert.equal(c.length, 1);
    assert.equal(c[0].body.line_id, '');
  });

  test('設定頁的 Email：一直改得到，存的是 setEmailInput 的值', async () => {
    const e = env();
    e.call('renderSetEmail');
    assert.match(e.els.setEmail.innerHTML, /id="setEmailInput"/);
    e.els.setEmailInput.value = 'neil@example.com';
    e.set('fetch', (_u, o) => { e.calls.push({ body: JSON.parse(o.body) }); return Promise.resolve({ json: () => Promise.resolve({ success: true, email: 'neil@example.com' }) }); });
    assert.equal(await e.callRaw('saveMyEmail', 'setEmailInput'), true);
    assert.equal(e.calls.find((c) => c.body.action === 'setMyEmail').body.email, 'neil@example.com');
  });
});

/* ========================================================================== */
describe('主色對比（D-1）：亮／暗 × 兩區，四組都 ≥ 4.5:1', () => {
  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  const block = (re) => { const m = css.match(re); assert.ok(m, String(re)); return m[1]; };
  const tok = (b, name) => { const m = b.match(new RegExp('--' + name + ':(#[0-9a-f]{6})')); return m && m[1]; };
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const base = { light: block(/:root\{([\s\S]*?)\}/), dark: block(/:root\[data-theme="dark"\]\{([\s\S]*?)\}/) };
  const zones = {
    'light finance': [base.light, block(/:root\[data-zone="finance"\]\{([^}]*)\}/)],
    'light productivity': [base.light, block(/:root\[data-zone="productivity"\]\{([^}]*)\}/)],
    'dark finance': [base.dark, block(/:root\[data-theme="dark"\]\[data-zone="finance"\]\{([^}]*)\}/)],
    'dark productivity': [base.dark, block(/:root\[data-theme="dark"\]\[data-zone="productivity"\]\{([^}]*)\}/)]
  };
  for (const [name, [b, z]] of Object.entries(zones)) {
    test(name, () => {
      const accent = tok(z, 'accent'), soft = tok(z, 'accent-soft'), on = tok(z, 'on-accent');
      for (const [label, a, c] of [['accent／卡片', accent, tok(b, 'card')], ['accent／頁面', accent, tok(b, 'bg')],
        ['accent／accent-soft', accent, soft], ['on-accent／accent', on, accent]]) {
        assert.ok(ratio(a, c) >= 4.5, name + ' ' + label + ' = ' + ratio(a, c).toFixed(2));
      }
    });
  }

  test('自動暗色那組跟手動暗色一模一樣（不會一邊改了另一邊忘了）', () => {
    for (const z of ['finance', 'productivity']) {
      const manual = block(new RegExp(':root\\[data-theme="dark"\\]\\[data-zone="' + z + '"\\]\\{([^}]*)\\}'));
      const auto = block(new RegExp(':root:not\\(\\[data-theme\\]\\)\\[data-zone="' + z + '"\\]\\{([^}]*)\\}'));
      for (const t of ['accent', 'accent-soft', 'on-accent']) assert.equal(tok(auto, t), tok(manual, t), z + ' ' + t);
    }
  });

  test('只翻主題卡：view-transition-name 只掛在 #zoneCard；動畫 ≤ 250ms；動畫層不吃點擊', () => {
    assert.equal((css.match(/view-transition-name:/g) || []).length, 1);
    assert.match(css, /#zoneCard\{view-transition-name:zone-card;\}/);
    const d = css.match(/::view-transition-new\(zone-card\)\{animation-duration:\.(\d+)s/);
    assert.ok(d && Number('0.' + d[1]) <= 0.25);
    assert.match(css, /::view-transition\{pointer-events:none;\}/);
    assert.match(css, /prefers-reduced-motion: reduce\)\{\s*:root\[data-zone-dir\]::view-transition-new\(zone-card\)\{animation:zone-fade-in/);
  });
});
