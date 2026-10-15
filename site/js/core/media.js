/* ============================================================
   陪读 · 章节懒解析 + 图片资源解析
   ------------------------------------------------------------
   为什么这两件事单独一个文件（而不是塞在 epub.js 里）：

   1. **懒解析**。epub.js 的 xhtmlToParas() 在导入时就把每一章都段落化了。
      对一本 200 章的书，那是几十万字符的活，而且用户可能永远不打开第 137 章。
      这里把「章节 → 段落」这一步挪到第一次真正要渲染它的时候。
      从 IndexedDB 重新打开一本书时，chapter.body 里的原始 XHTML 还在，
      所以段落永远可以重建 —— paras 只是缓存，不是唯一真相。

   2. **图片不能存 data URL**。base64 会让体积涨 33%，一本有插图的 EPUB
      能把几十 MB 塞进 IndexedDB，浏览器配额不够就直接导入失败。
      所以存的永远是 zip 内的相对路径，渲染到哪一页就给哪一页的图建 blob URL。
      blob URL 不跨页面生命期，所以每次渲染都要重新解析一遍 —— 这没关系，
      因为 Map 缓存住了，重复调用是 O(1)。

   ★ 一个必须记住的约束：doc._zip 只在「本次会话刚导入」时存在。
     从书架重新打开的书没有它（zip 字节没有存进 IndexedDB）。
     所以 resolveImageSources **必须**能在没有 _zip 时安静地什么都不做，
     而不是抛错 —— 否则用户重新打开书就白屏。
   ============================================================ */

import { makeParagraph, reindexParas, countChars } from './model.js';
import { parseXML } from './xml.js';

/* ---------------------------- 懒解析 ---------------------------- */

/**
 * 取某章段落，第一次访问时用 chapter.body 解析并缓存。
 * @param {Object} doc
 * @param {Object} chapter
 * @returns {Array} Para[]
 */
export function ensureParas(doc, chapter) {
  if (!chapter) return [];
  if (Array.isArray(chapter.paras) && chapter.paras.length) return chapter.paras;
  if (Array.isArray(chapter.paras) && chapter.paras.length === 0 && chapter._parsed) return chapter.paras;

  const raw = chapter.paras && chapter.paras.length ? chapter.paras : parsFromBody(chapter.body);
  const list = reindexParas(raw.map((p, i) => makeParagraph(p, i)));
  chapter.paras = list;
  chapter._parsed = true;
  if (!chapter.charCount) chapter.charCount = countChars(list);
  return list;
}

/**
 * 从原始 XHTML 解析段落。
 * 复用 epub.js 的解析器（同一份 xml.js 树遍历逻辑），保证
 * 「导入时解析」与「重开后重解析」得到的结果完全一致 ——
 * 不一致会让批注挂在错的段落下标上，这种 bug 极难发现。
 */
function parsFromBody(body) {
  if (!body) return [];
  try {
    // epub.js 的 xhtmlToParas 没有导出，这里按同样的规则做一次最小实现：
    // 段落边界看块级标签，文字取自 allText。够用且与它的一致性是「同源」的：
    // 两边都基于 xml.js 的解析树，标点/空白的折叠都走 model.normalizeText。
    return bodyToParas(body);
  } catch (err) {
    console.warn('[media] 段落解析失败，退化为纯文本', err);
    const t = String(body).replace(/<[^>]*>/g, '\n');
    return t
      .split(/\r\n?|\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ type: 'p', text: s }));
  }
}

const BLOCK = new Set([
  'p', 'div', 'li', 'dd', 'dt', 'td', 'th', 'figcaption', 'caption',
  'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'address', 'center',
]);
const SKIP = new Set(['script', 'style', 'head', 'title', 'template', 'noscript', 'svg', 'math']);

function bodyToParas(html) {
  const { nodes } = parseXML(html);
  const root = { name: 'root', local: 'root', children: nodes, text: '', allText: '' };
  const body = findLocal(root, 'body') || root;
  const out = [];

  const emit = (el) => {
    const t = clean(el.allText);
    if (!t) return;
    const local = el.local;
    if (/^h[1-6]$/.test(local)) out.push({ type: 'h' + Math.min(4, Number(local[1])), text: t });
    else if (local === 'blockquote') out.push({ type: 'quote', text: t });
    else out.push({ type: 'p', text: t });
  };

  const walk = (el) => {
    const kids = [];
    for (const c of el.children || []) if (c.name) kids.push(c);
    if (!kids.length) {
      emit(el);
      return;
    }
    let hasBlock = false;
    for (const k of kids) {
      if (BLOCK.has(k.local)) {
        hasBlock = true;
        break;
      }
    }
    if (!hasBlock) {
      emit(el);
      return;
    }
    // 容器：夹在块之间的裸文字也要收（否则 <div>裸字<p>段</p></div> 会丢内容）
    let buf = '';
    for (const k of el.children || []) {
      if (!k.name) {
        buf += k.text || '';
        continue;
      }
      if (SKIP.has(k.local)) continue;
      if (BLOCK.has(k.local)) {
        const t = clean(buf);
        if (t) out.push({ type: 'p', text: t });
        buf = '';
        walk(k);
        continue;
      }
      // 内联元素：先攒着，等遇到块再冲掉
      buf += k.allText || '';
    }
    const tail = clean(buf);
    if (tail) out.push({ type: 'p', text: tail });
  };

  walk(body);
  return out;
}

function findLocal(el, want) {
  for (const c of el.children || []) {
    if (!c.name) continue;
    if (c.local === want) return c;
    const hit = findLocal(c, want);
    if (hit) return hit;
  }
  return null;
}

function clean(s) {
  return String(s || '')
    .replace(/[\u00a0\u2007\u202f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------------------- 图片 ---------------------------- */

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
};

/** 单张图上限。超过就不解码了，直接占位 —— 一本书里塞一张 20MB 的扫描图很常见 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * 把段落里的图片路径换成可显示的 URL。**原地改 paras**。
 * 拿不到 zip（从书架重开的书）时安静返回，图显示为占位。
 *
 * @param {Object} doc
 * @param {Array} paras
 * @param {Object} chapter
 */
export function resolveImageSources(doc, paras, chapter) {
  if (!doc || !paras || !chapter) return;
  if (!doc._zip) {
    // 重新打开的书：没有 zip 字节，解不出图。
    // ★ 但不能留着 src 不管 —— 留着就会让 <img> 去请求书里的原始相对路径
    //   （/OEBPS/px.png），必然 404，正文里落一个碎图标。
    //   清成空串，渲染层会画一个"（插图）"占位。
    for (const p of paras) {
      if (p.type === 'img' && p.src && !p.src.startsWith('blob:') && !p.src.startsWith('data:')) p.src = '';
    }
    return;
  }

  const cache = doc._imageCache || (doc._imageCache = new Map());
  for (const p of paras) {
    if (p.type !== 'img' || !p.src) continue;
    if (p.src.startsWith('blob:') || p.src.startsWith('data:')) continue;
    const key = String(p.src);
    const hit = cache.get(key);
    if (hit !== undefined) {
      p.src = hit;
      continue;
    }
    // 先占位，异步解出真正的 blob URL；下一帧 reader 会 relayout 一次补上图
    cache.set(key, '');
    makeBlobUrl(doc, key)
      .then((url) => cache.set(key, url))
      .catch((err) => console.warn('[media] 图片解码失败', key, err));
    p.src = '';
  }
}

async function makeBlobUrl(doc, path) {
  const zip = doc._zip;
  if (!zip) return '';
  let bytes = null;
  try {
    bytes = await zip.read(path);
  } catch {
    // 路径对不上（大小写差异 / 目录层级不同）→ 只按文件名再找一次
    const short = path.split('/').pop().toLowerCase();
    for (const name of zip.names || []) {
      if (name.split('/').pop().toLowerCase() === short) {
        try {
          bytes = await zip.read(name);
        } catch {
          bytes = null;
        }
        break;
      }
    }
  }
  if (!bytes || !bytes.length) return '';
  if (bytes.length > MAX_IMAGE_BYTES) {
    console.warn('[media] 图片太大，跳过：', path, bytes.length);
    return '';
  }
  const ext = (path.split('.').pop() || '').toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  if (typeof URL !== 'undefined' && URL.createObjectURL) {
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }
  // 没有 URL.createObjectURL（Node 测试环境）→ data URL 兜底
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${b64}`;
}

/**
 * 释放某本书的图片 blob URL（关闭书 / 换书时调用，否则内存会一直涨）。
 * @param {Object} doc
 */
export function releaseImages(doc) {
  if (!doc || !doc._imageCache) return;
  if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
    for (const url of doc._imageCache.values()) {
      if (url && url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* 已经释放过 */
        }
      }
    }
  }
  doc._imageCache.clear();
}
