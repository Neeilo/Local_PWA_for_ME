/**
 * 顯示設定（亮／暗／自動）與新 icon 的測試（2026-09-24 晨曦配色票 ①③）
 *
 * 盯四件事：
 *   1. 主題選擇只存在這支手機——存獨立的 localStorage key，不進 state，也不會
 *      觸發任何雲端寫入。進了 state 就會被同步到 Sheet，別人的手機跟著變色。
 *   2. 「自動」＝移除 data-theme 屬性，交給 CSS 的 prefers-color-scheme。
 *      存壞的值一律當自動，不能留下一個切不回來的主題。
 *   3. <head> 的防閃白腳本與主程式對同一個儲存值做出同一個判斷——兩邊不一致，
 *      重開 App 會先是一種顏色、init 跑完再跳成另一種，正好就是要防的閃爍。
 *   4. 記帳分類色指向 :root 的 --c1…--c7，而不是 JS 裡的色碼快照：
 *      自動模式沒有 JS 監聽，手機切深色時只有 CSS 變數會跟著換。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFrontend } from './fake-browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const THEME_KEY = 'personal-os-theme';

/** 夠用的 <html> 與兩條 theme-color：只記屬性，不渲染 */
function makeRoot() {
  const attrs = {};
  return {
    attrs,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null)
  };
}
function makeMeta(content) {
  const m = makeRoot();
  m.dataset = {};
  m.setAttribute('content', content);
  return m;
}

/** 載入主程式，並接上主題相關會碰到的 DOM：<html>、theme-color、getComputedStyle */
function loadWithTheme(storage = {}, bgByTheme = { light: '#FBF3E8', dark: '#0F1C18' }) {
  const e = loadFrontend({ storage });
  const root = makeRoot();
  const metas = [makeMeta('#FBF3E8'), makeMeta('#0F1C18')];
  const doc = e.context.document;
  doc.documentElement = root;
  const origQSA = doc.querySelectorAll;
  doc.querySelectorAll = (sel) => (sel === 'meta[name="theme-color"]' ? metas : origQSA(sel));
  // 假的 getComputedStyle：依 data-theme 回對應的 --bg（沒有屬性時當亮色，測試裡手機是亮的）
  e.set('getComputedStyle', () => ({
    getPropertyValue: (name) => (name === '--bg' ? ' ' + bgByTheme[root.attrs['data-theme'] || 'light'] : '')
  }));
  return { e, root, metas };
}

/* ========================================================================== */
describe('loadTheme — 讀回儲存的選擇', () => {

  test('沒存過：預設自動', () => {
    const { e } = loadWithTheme();
    assert.equal(e.call('loadTheme'), 'auto');
  });

  test('存了亮／暗／自動：原樣讀回', () => {
    for (const t of ['light', 'dark', 'auto']) {
      const { e } = loadWithTheme({ [THEME_KEY]: t });
      assert.equal(e.call('loadTheme'), t);
    }
  });

  test('存壞的值：退回自動，不留下切不回來的主題', () => {
    for (const bad of ['Dark', 'black', '', '{"x":1}']) {
      const { e } = loadWithTheme({ [THEME_KEY]: bad });
      assert.equal(e.call('loadTheme'), 'auto', '值：' + JSON.stringify(bad));
    }
  });
});

/* ========================================================================== */
describe('setTheme — 套用與儲存', () => {

  test('暗 → data-theme="dark"；亮 → "light"；自動 → 移除屬性', () => {
    const { e, root } = loadWithTheme();
    e.call('setTheme', 'dark');
    assert.equal(root.attrs['data-theme'], 'dark');
    e.call('setTheme', 'light');
    assert.equal(root.attrs['data-theme'], 'light');
    e.call('setTheme', 'auto');
    assert.equal('data-theme' in root.attrs, false, '自動要交給 CSS，不可以留一個 data-theme="auto"');
  });

  test('選擇存在 personal-os-theme，值就是 light／dark／auto', () => {
    const { e } = loadWithTheme();
    e.call('setTheme', 'dark');
    assert.equal(e.localStorage.getItem(THEME_KEY), 'dark');
    e.call('setTheme', 'auto');
    assert.equal(e.localStorage.getItem(THEME_KEY), 'auto');
  });

  test('只存這支手機：不進 state、不打任何雲端請求', () => {
    const { e } = loadWithTheme();
    const before = e.calls.length;
    const stateKeysBefore = Object.keys(e.localStorage._dump()).filter(k => k !== THEME_KEY);
    const stateBefore = stateKeysBefore.map(k => e.localStorage.getItem(k));

    e.call('setTheme', 'dark');
    e.call('setTheme', 'light');

    assert.equal(e.calls.length, before, '切主題不應該送出任何 fetch');
    const after = Object.keys(e.localStorage._dump()).filter(k => k !== THEME_KEY);
    assert.deepEqual(after, stateKeysBefore, '除了主題 key，localStorage 不應該多出或少掉東西');
    assert.deepEqual(after.map(k => e.localStorage.getItem(k)), stateBefore, '其他 key 的內容也不能被動到');
    assert.doesNotMatch(JSON.stringify(e.read('state')), /theme/i, '主題不可以出現在 state（會被同步上雲端）');
  });

  test('不認得的值：什麼都不做', () => {
    const { e, root } = loadWithTheme({ [THEME_KEY]: 'dark' });
    root.setAttribute('data-theme', 'dark');
    e.call('setTheme', 'purple');
    assert.equal(root.attrs['data-theme'], 'dark');
    assert.equal(e.localStorage.getItem(THEME_KEY), 'dark');
  });
});

/* ========================================================================== */
describe('applyTheme — 狀態列 theme-color', () => {

  test('手動暗色：兩條 theme-color 都換成目前主題的 --bg', () => {
    const { e, metas } = loadWithTheme();
    e.call('setTheme', 'dark');
    assert.deepEqual(metas.map(m => m.getAttribute('content')), ['#0F1C18', '#0F1C18']);
  });

  test('手動亮色：兩條都是亮色 --bg（手機是深色也一樣）', () => {
    const { e, metas } = loadWithTheme();
    e.call('setTheme', 'light');
    assert.deepEqual(metas.map(m => m.getAttribute('content')), ['#FBF3E8', '#FBF3E8']);
  });

  test('切回自動：兩條各自還原成 <head> 裡原本的值，由 media 決定', () => {
    const { e, metas } = loadWithTheme();
    e.call('setTheme', 'dark');
    e.call('setTheme', 'light');
    e.call('setTheme', 'auto');
    assert.deepEqual(metas.map(m => m.getAttribute('content')), ['#FBF3E8', '#0F1C18']);
  });
});

/* ========================================================================== */
describe('<head> 防閃白腳本', () => {
  // 取出 <head> 裡那一行 inline script（主程式的 <script> 是獨立一行，不會被抓到）
  const m = HTML.match(/<script>(\(function\(\)\{try\{[^\n]*?)<\/script>/);

  function runHead(storage) {
    const root = makeRoot();
    const ctx = createContext({
      document: { documentElement: root },
      localStorage: { getItem: (k) => (k in storage ? storage[k] : null) }
    });
    runInContext(m[1], ctx);
    return root.attrs['data-theme'];
  }

  test('存在，而且排在所有 <style> 之前', () => {
    assert.ok(m, '<head> 裡找不到防閃白腳本');
    assert.ok(HTML.indexOf(m[0]) < HTML.indexOf('<style>'), '要在 CSS 之前執行才防得了閃白');
  });

  test('跟主程式對同一個值做出同一個判斷', () => {
    for (const stored of [undefined, 'light', 'dark', 'auto', 'garbage']) {
      const storage = stored === undefined ? {} : { [THEME_KEY]: stored };
      const { e, root } = loadWithTheme(storage);
      e.call('applyTheme', e.call('loadTheme'));
      assert.equal(runHead(storage), root.attrs['data-theme'], '儲存值：' + stored);
    }
  });

  test('不在全域留下變數（主程式日後若在頂層宣告同名 let／const，整支腳本會語法錯誤）', () => {
    const ctx = createContext({ document: { documentElement: makeRoot() }, localStorage: { getItem: () => 'dark' } });
    runInContext(m[1], ctx);
    assert.equal('t' in ctx, false);
  });

  test('localStorage 讀不到（私密瀏覽）：不丟例外，維持自動', () => {
    const root = makeRoot();
    const ctx = createContext({
      document: { documentElement: root },
      localStorage: { getItem: () => { throw new Error('SecurityError'); } }
    });
    assert.doesNotThrow(() => runInContext(m[1], ctx));
    assert.equal('data-theme' in root.attrs, false);
  });
});

/* ========================================================================== */
describe('記帳分類色跟著主題走', () => {

  test('每個分類都指向 :root 裡存在的 --c1…--c7，沒有寫死色碼', () => {
    const e = loadFrontend();
    const colors = e.read('CATEGORY_COLOR');
    const cats = e.read('EXPENSE_CATEGORIES');
    const rootBlock = HTML.match(/:root\{([\s\S]*?)\}/)[1];
    cats.forEach((c, i) => {
      assert.equal(colors[c], 'var(--c' + (i + 1) + ')', c + ' 的顏色要照分類固定順序對應');
      assert.match(rootBlock, new RegExp('--c' + (i + 1) + ':#'), '--c' + (i + 1) + ' 要在 :root 定義');
    });
  });

  test('甜甜圈各分類的 stroke 寫在 style 裡（CSS 屬性，每個引擎都認得 var()）', () => {
    const e = loadFrontend();
    const svg = e.call('donutSVG', [{ cat: '餐飲', amount: 60 }, { cat: '交通', amount: 40 }], 100);
    assert.match(svg, /style="stroke:var\(--c1\)"/);
    assert.match(svg, /style="stroke:var\(--c2\)"/);
    assert.doesNotMatch(svg, /#[0-9a-f]{6}/i, '不可以再出現寫死的色碼');
  });
});

/* ========================================================================== */
describe('新 icon（票 ③）', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');

  test('manifest：192 與 512 都在，512 標 maskable，檔案真的存在', () => {
    const bySize = Object.fromEntries(manifest.icons.map(i => [i.sizes, i]));
    assert.equal(bySize['192x192'].src, 'neilos-icon-192.png');
    assert.equal(bySize['512x512'].src, 'neilos-icon-512.png');
    assert.match(bySize['512x512'].purpose, /maskable/);
    for (const i of manifest.icons) readFileSync(join(ROOT, i.src));   // 不存在會丟例外
  });

  test('iOS 用 180，瀏覽器分頁用 SVG 母稿', () => {
    assert.match(HTML, /<link rel="apple-touch-icon" href="neilos-icon-180\.png">/);
    assert.match(HTML, /<link rel="icon" type="image\/svg\+xml" href="neilos-icon\.svg">/);
    readFileSync(join(ROOT, 'neilos-icon-180.png'));
  });

  test('Service Worker 預先快取的每個檔案都存在（少一個整個 install 就失敗）', () => {
    const assets = JSON.parse(sw.match(/const ASSETS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
    for (const a of assets) {
      if (a === './') continue;
      readFileSync(join(ROOT, a));
    }
    assert.ok(assets.includes('./neilos-icon-192.png') && assets.includes('./neilos-icon-512.png'));
    assert.ok(!assets.includes('./icon-192.png'), '舊 icon 不再預先快取');
  });
});

/* ========================================================================== */
describe('晨曦配色：舊的寫死色碼不能回來', () => {
  // 只看 <style>：規格的驗收是「CSS 裡不再寫死」，註解與腳本裡提到色碼不算
  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));

  test('規格點名的舊綠色系全部消失', () => {
    for (const old of ['#FBFCFB', '#BCD8CC', '#F4F6F5']) {
      assert.equal(css.toLowerCase().includes(old.toLowerCase()), false, old + ' 還在');
    }
    assert.doesNotMatch(css, /rgba\(\s*47\s*,\s*109\s*,\s*95/, '舊品牌綠的陰影還在');
  });

  test('不再用 #fff 當底色或文字；燒橘底上的字一律 on-accent', () => {
    assert.doesNotMatch(css, /background:\s*#fff\b/i);
    assert.doesNotMatch(css, /[^-]color:\s*#fff\b/i, '文字也不能寫死白色（提示框亮色用 --bg，Neil 2026-09-24 選 B）');
    assert.match(css, /\.btn\{[^}]*color:var\(--on-accent\)/);
    assert.match(css, /nav \.home-btn\.active\{color:var\(--on-accent\);\}/);
  });

  test('暗色有手動與自動兩條路，而且自動只在沒有 data-theme 時生效', () => {
    assert.match(css, /:root\[data-theme="dark"\]\{[^}]*--bg:#0f1c18/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)\{\s*:root:not\(\[data-theme\]\)\{[^}]*--bg:#0f1c18/);
    assert.match(css, /:root\[data-theme="light"\]\{ color-scheme:light; \}/, '強制亮色要把原生控制項也鎖成亮的');
  });

  test('舊的兩條 prefers-color-scheme 規則已刪（它們在「強制亮」時仍會跟著手機變暗）', () => {
    assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\)\{\s*\.conn-banner/);
    assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\)\{\s*\.sync-badge/);
  });
});
