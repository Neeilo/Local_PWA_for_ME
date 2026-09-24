/**
 * 從 icon 母稿 neilos-icon.svg 產生所有 PNG。改 icon 一律改母稿，再跑這支。
 *
 * 跑法（resvg 不列進 devDependencies，用的時候才裝）：
 *   npm i --no-save @resvg/resvg-js && node scripts/render-icons.mjs
 *
 * 【為什麼 iOS 要另外裁】
 * 母稿是為 Android maskable 設計的：拼塊只佔中間 288×288（56%），四周是暖米底——
 * 288 正好是能完整放進 80% 安全圓的最大正方形（409.6 ÷ √2 ≈ 289.6）。
 * 但 iOS 不裁切，而是把整張正方形直接套上自己的圓角，於是主畫面會出現
 * 「暖米外框裡又一個圓角方塊」（2026-09-24 Neil 實機回報）。
 * 所以 iOS 那張只取拼塊那 288×288、並拿掉拼塊自己的圓角（iOS 會自己加）。
 * 裁切在這裡做，不另存一份 SVG：母稿永遠只有一份。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { Resvg } = require('@resvg/resvg-js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const master = readFileSync(join(ROOT, 'neilos-icon.svg'), 'utf8');

/** 取代且必須剛好命中一次——母稿結構一變就大聲失敗，不要安靜地產出錯圖 */
function replaceOnce(src, from, to) {
  if (src.split(from).length !== 2) throw new Error('母稿結構變了，找不到（或不只一處）：' + from);
  return src.replace(from, to);
}

const iosFullBleed = replaceOnce(
  replaceOnce(master,
    'viewBox="0 0 512 512" width="512" height="512"',
    'viewBox="112 112 288 288" width="288" height="288"'),
  '<rect x="112" y="112" width="288" height="288" rx="52"/>',
  '<rect x="112" y="112" width="288" height="288"/>');

const outputs = [
  ['neilos-icon-512.png', master, 512],        // manifest，maskable
  ['neilos-icon-192.png', master, 192],        // manifest，any
  ['neilos-icon-ios-180.png', iosFullBleed, 180]   // apple-touch-icon，滿版
];
for (const [file, svg, width] of outputs) {
  writeFileSync(join(ROOT, file), new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());
  console.log('ok', file);
}
