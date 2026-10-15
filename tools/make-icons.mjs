/* ============================================================
   陪读 · 生成 PWA 图标
   ------------------------------------------------------------
   为什么自己手写 PNG 编码器而不是引入 sharp/canvas：
   这个项目是零依赖的，为一个 192×192 的图标装一个几十 MB 的
   原生依赖，会让「clone 下来就能跑」这件事不再成立。
   PNG 的最小可用子集（8 位 RGBA + zlib deflate + CRC32）
   其实只有几十行，而且完全没有二进制兼容问题。

   用法：node tools/make-icons.mjs
   ============================================================ */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'site', 'icons');

/* ---------------------------- PNG 最小实现 ---------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/** @param {number} w @param {number} h @param {Buffer} rgba 长度 w*h*4 */
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前加一个 filter 字节（0 = None）。用 0 是因为图标是纯色块，
  // 上滤波/帕斯滤波的收益极小，而 filter 类型写错是 PNG 最常见的损坏原因。
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------- 画图标 ---------------------------- */

const BG = [0xf6, 0xf4, 0xef]; // --paper，跟 manifest 的 background_color 一致
const INK = [0x2b, 0x2a, 0x27]; // 墨色
const ACCENT = [0xb4, 0x53, 0x1f]; // --accent，跟锚点同一个颜色

/**
 * 画「一本书 + 一个批注点」：
 * 左边一条竖线是书脊，右边三条横线是文字，
 * 其中一条用一个 accent 色的短横代替 —— 那就是批注。
 */
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // 简单 alpha 合成（图标只需要「盖上去」，不做复杂混合）
    const k = a / 255;
    buf[i] = Math.round(buf[i] * (1 - k) + r * k);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - k) + g * k);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - k) + b * k);
    buf[i + 3] = 255;
  };
  const rect = (x, y, w, h, color, r = 0) => {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (r) {
          // 圆角：四个角上超出圆弧范围的像素丢掉
          const cx = xx < x + r ? x + r : xx >= x + w - r ? x + w - r - 1 : xx;
          const cy = yy < y + r ? y + r : yy >= y + h - r ? y + h - r - 1 : yy;
          const dx = xx - cx;
          const dy = yy - cy;
          if (dx * dx + dy * dy > r * r) continue;
        }
        put(xx, yy, color);
      }
    }
  };

  // 底：整块纸色 + 圆角
  rect(0, 0, size, size, BG);
  const pad = Math.round(size * 0.18);
  const card = size - pad * 2;
  rect(pad, pad, card, card, INK, Math.round(size * 0.06));

  // 书脊
  const spineW = Math.max(2, Math.round(size * 0.035));
  const lineX = pad + Math.round(card * 0.16);
  rect(lineX, pad + Math.round(card * 0.18), spineW, Math.round(card * 0.64), BG);

  // 三行「文字」，中间那行用 accent 色且短一截 —— 那就是一条批注。
  // 起点压到 0.38 以下：右上角要留给那个批注点，压太高会被圆点吃掉半行。
  const textX = lineX + spineW + Math.round(card * 0.1);
  const textW = Math.round(card * 0.46);
  const th = Math.max(2, Math.round(size * 0.045));
  const gaps = [0.38, 0.53, 0.68];
  for (let i = 0; i < 3; i++) {
    const y = pad + Math.round(card * gaps[i]);
    const isNote = i === 1;
    const w = isNote ? Math.round(textW * 0.62) : textW;
    rect(textX, y, w, th, isNote ? ACCENT : BG);
  }

  // 批注点：右上角一个小圆，暗示「有人在这一页说了句话」。
  // 位置贴着卡片内边缘留 6% 的余量 —— 一开始让它骑在卡片边缘上，
  // 缩到 48px 的 favicon 尺寸就完全看不出是「书上的一个点」了。
  const dotR = Math.max(3, Math.round(size * 0.075));
  const cx = pad + card - Math.round(card * 0.2);
  const cy = pad + Math.round(card * 0.2);
  for (let y = cy - dotR; y <= cy + dotR; y++) {
    for (let x = cx - dotR; x <= cx + dotR; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= dotR * dotR) put(x, y, ACCENT);
    }
  }

  return buf;
}

/* ---------------------------- 输出 ---------------------------- */

mkdirSync(OUT_DIR, { recursive: true });
const sizes = [192, 512];
for (const s of sizes) {
  const png = encodePNG(s, s, draw(s));
  const file = join(OUT_DIR, `icon-${s}.png`);
  writeFileSync(file, png);
  console.log(`✓ ${file}  ${s}×${s}  ${png.length} 字节`);
}

// iOS 加主屏幕用 apple-touch-icon，尺寸不必严格 180，但给一个正好的更稳
const png180 = encodePNG(180, 180, draw(180));
const file180 = join(OUT_DIR, 'icon-180.png');
writeFileSync(file180, png180);
console.log(`✓ ${file180}  180×180  ${png180.length} 字节`);
