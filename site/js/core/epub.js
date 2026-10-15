// core/epub.js —— EPUB / TXT 解析（零依赖、零网络）
//
// ZIP 用浏览器原生 DecompressionStream('deflate-raw') 解，不引任何 zip 库：
// 从文件尾部找 EOCD，再读 Central Directory（大小/偏移以 CD 为准，
// 因为带 data descriptor 的条目在 local header 里大小字段是 0）。
//
// XHTML 用 core/xml.js 的手写解析器（Node 没有 DOMParser）。
//
// 失败一律抛 Error，message 面向用户且是中文。

import { parseXML, findAll, findFirst, attr } from './xml.js';

// ---------------------------------------------------------------- 字节/编码

const utf8Decoder = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** 任意 ArrayBuffer / TypedArray / Buffer → Uint8Array（不拷贝原 buffer） */
function toU8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer) return new Uint8Array(buf);
  if (Array.isArray(buf)) return Uint8Array.from(buf);
  if (buf && typeof buf.byteLength === 'number') return new Uint8Array(buf);
  throw new Error('无法识别的文件数据：需要 ArrayBuffer 或 Uint8Array');
}

/**
 * 嗅探纯文本编码。
 * 顺序：BOM → UTF-8 严格解码 → GB18030（GBK 超集）→ Big5 → 兜底 utf-8
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {'utf-8'|'gbk'|'utf-16le'|'utf-16be'|'big5'}
 */
export function detectCharset(buf) {
  const bytes = toU8(buf);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  // 无 BOM：严格 UTF-8 能过就是 UTF-8
  try {
    utf8Strict.decode(bytes);
    return 'utf-8';
  } catch {
    /* 继续试中文编码 */
  }
  // GB18030 是 GBK 的超集，优先；解出 U+FFFD 说明也不匹配
  try {
    if (!new TextDecoder('gb18030').decode(bytes).includes('\ufffd')) return 'gbk';
  } catch {
    /* 环境不支持 gb18030 */
  }
  try {
    if (!new TextDecoder('big5').decode(bytes).includes('\ufffd')) return 'big5';
  } catch {
    /* 环境不支持 big5 */
  }
  return 'utf-8';
}

const CHARSET_LABEL = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  gbk: 'gb18030',
  big5: 'big5',
};

/** 按嗅探结果解码文本，并去掉 BOM */
function decodeText(bytes, charset) {
  const label = CHARSET_LABEL[charset] || 'utf-8';
  let out;
  try {
    out = new TextDecoder(label).decode(bytes);
  } catch {
    out = utf8Decoder.decode(bytes);
  }
  return out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
}

// ---------------------------------------------------------------- ZIP

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_EOCD64_LOC = 0x07064b50;

/** 分块 base64，避免 String.fromCharCode(...bigArray) 爆栈 */
function bytesToBase64(bytes, chunk = 0x8000) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const end = Math.min(i + chunk, bytes.length);
    bin += String.fromCharCode.apply(null, bytes.subarray(i, end));
  }
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64');
}

/** zip 里存文件名的解码：位 11 置位才算 UTF-8，否则非严格 UTF-8 就退 GB18030 */
function decodeZipName(bytes, utf8Flag) {
  if (utf8Flag) return utf8Decoder.decode(bytes);
  try {
    return utf8Strict.decode(bytes);
  } catch {
    try {
      const gbk = new TextDecoder('gb18030').decode(bytes);
      if (!gbk.includes('\ufffd')) return gbk;
    } catch {
      /* 不支持 gb18030 就退回 utf-8 */
    }
    return utf8Decoder.decode(bytes);
  }
}

/** 统一条目名：反斜杠转正斜杠、去掉 './' 前缀、折叠重复斜杠 */
function normalizeName(name) {
  let n = String(name).replace(/\\/g, '/');
  while (n.startsWith('./')) n = n.slice(2);
  return n.replace(/\/{2,}/g, '/');
}

/** 解压 deflate-raw；浏览器与 Node 24 都有 DecompressionStream */
async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('这个浏览器不支持 DecompressionStream，无法解压 EPUB');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error('EPUB 内某个文件解压失败：压缩数据已损坏');
  }
}

/** 最小 ZIP 读取器（只读，不支持 ZIP64 / 加密） */
class ZipReader {
  constructor(bytes) {
    this.bytes = bytes;
    /** @type {Map<string, object>} 小写规范化名 → 条目 */
    this.entries = new Map();
    this.readCentralDirectory();
  }

  /** 从尾部找 EOCD（comment 长度可变，所以是向前扫签名再验证） */
  findEOCD(dv) {
    const len = this.bytes.length;
    const minPos = Math.max(0, len - 22 - 0xffff);
    for (let p = len - 22; p >= minPos; p--) {
      if (dv.getUint32(p, true) !== SIG_EOCD) continue;
      const commentLen = dv.getUint16(p + 20, true);
      if (p + 22 + commentLen <= len) return p;
    }
    return -1;
  }

  readCentralDirectory() {
    const bytes = this.bytes;
    if (bytes.length < 22) throw new Error('这个文件不是有效的 EPUB：文件太小，连 ZIP 目录都没有');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = this.findEOCD(dv);
    if (eocd < 0) {
      throw new Error('这个文件不是有效的 EPUB：找不到 ZIP 结尾记录（可能不是 zip/epub，或已被截断）');
    }
    // EOCD64 定位符紧贴在 EOCD 之前 → 说明是 ZIP64
    if (eocd >= 20 && dv.getUint32(eocd - 20, true) === SIG_EOCD64_LOC) {
      throw new Error('EPUB 使用了 ZIP64，暂不支持');
    }
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error('EPUB 使用了 ZIP64，暂不支持');
    if (cdOffset + cdSize > bytes.length) {
      throw new Error('这个文件不是有效的 EPUB：ZIP 目录越界，文件可能已损坏');
    }

    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.length) break;
      if (dv.getUint32(p, true) !== SIG_CEN) break;
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const rawSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLength = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      if (flags & 0x1) throw new Error('EPUB 里的文件被加密了，暂不支持打开');
      if (compSize === 0xffffffff || rawSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('EPUB 使用了 ZIP64，暂不支持');
      }
      const entryName = normalizeName(decodeZipName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0));
      this.entries.set(entryName.toLowerCase(), { name: entryName, method, compSize, rawSize, localOffset, flags });
      p += 46 + nameLen + extraLen + commentLength;
    }
  }

  /** 大小写不敏感 + 容忍 './' 前缀地查找条目名 */
  resolveName(name) {
    const e = this.entries.get(normalizeName(name).toLowerCase());
    return e ? e.name : undefined;
  }

  has(name) {
    return this.entries.has(normalizeName(name).toLowerCase());
  }

  /** 读条目字节；不存在返回 undefined（可选条目用它） */
  async read(name) {
    const e = this.entries.get(normalizeName(name).toLowerCase());
    if (!e) return undefined;
    return this.readEntry(e);
  }

  /** 按中央目录记录的偏移切出数据并解压 */
  async readEntry(e) {
    const bytes = this.bytes;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const lo = e.localOffset;
    if (lo + 30 > bytes.length) throw new Error('这个 EPUB 已损坏：压缩数据的偏移越界');
    if (dv.getUint32(lo, true) !== SIG_LOC) throw new Error('这个 EPUB 已损坏：局部文件头签名不对');
    const nameLen = dv.getUint16(lo + 26, true);
    const extraLen = dv.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    if (start > bytes.length) throw new Error('这个 EPUB 已损坏：局部文件头越界');

    if (e.method === 0) {
      const end = e.compSize > 0 ? Math.min(start + e.compSize, bytes.length) : bytes.length;
      return bytes.subarray(start, end);
    }
    if (e.method === 8) {
      const end = e.compSize > 0 ? Math.min(start + e.compSize, bytes.length) : bytes.length;
      return inflateRaw(bytes.subarray(start, end));
    }
    throw new Error(`EPUB 里用了不支持的压缩方式（method=${e.method}）：只能处理 stored 与 deflate`);
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ---------------------------------------------------------------- 路径与文本

/** 把 `a/b/../c` 折叠成 `a/c` 形式 */
function normalizePath(p) {
  const out = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** 相对 baseDir 解析 href（自动剥离 fragment 与 query） */
function resolvePath(baseDir, href) {
  const clean = String(href || '').split('#')[0].split('?')[0];
  if (clean === '') return normalizePath(baseDir);
  if (clean.startsWith('/')) return normalizePath(clean);
  return normalizePath(baseDir ? `${baseDir}/${clean}` : clean);
}

/** URL 解码；失败原样返回 */
function decodeHref(h) {
  try {
    return decodeURIComponent(h);
  } catch {
    try {
      return decodeURI(h);
    } catch {
      return h;
    }
  }
}

/** 目录/图片用：href（去 fragment、URL 解码、基于 baseDir）→ EPUB 根路径 */
function hrefKey(baseDir, href) {
  return resolvePath(baseDir, decodeHref(String(href || '')));
}

/** 路径的 basename */
function shortName(p) {
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

/** 文件所在目录（'' 表示根） */
function dirOf(p) {
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

const NBSP_RE = /[\s\u00a0\u3000\ufeff]+/g;

/** 折叠所有连续空白（含 \n\t、全角空格、不换行空格）为单个空格并 trim */
function squash(s) {
  return String(s).replace(NBSP_RE, ' ').trim();
}

// ---------------------------------------------------------------- XHTML → Para[]

const TEXT_SKIP = new Set(['script', 'style', 'img', 'svg', 'head', 'title', 'template']);

/**
 * 元素内的文本：<br> 变空格，跳过 script/style/img/svg，按文档顺序拼接。
 * @param {object} el
 * @param {Uint8Array} [consumed] 与 el.children 同下标的标记数组；置 1 表示该子节点已被计入，
 *                                调用方据此避免重复输出（如 <p>图<img/></p> 里的 img）
 * @returns {string}
 */
function elementText(el, consumed) {
  let out = '';
  let pendingSpace = false;
  const stack = [{ el, phase: 0, pi: -1 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const cur = frame.el;
    if (frame.phase === 0) {
      frame.phase = 1;
      if (cur !== el) {
        if (cur.local === 'br') {
          pendingSpace = true;
          continue; // <br> 自身没有子节点，不必下降
        }
        if (TEXT_SKIP.has(cur.local)) {
          if (consumed && frame.pi >= 0) consumed[frame.pi] = 1;
          continue;
        }
      }
      const kids = cur.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i], phase: 0, pi: i });
    } else {
      stack.pop();
      if (cur.name === '') {
        // 文本节点
        if (consumed && frame.pi >= 0) consumed[frame.pi] = 1;
        if (pendingSpace) {
          if (out !== '' && !/\s$/.test(out)) out += ' ';
          pendingSpace = false;
        }
        out += cur.text;
      }
    }
  }
  return out;
}

const HEADING_RE = /^h[1-6]$/;
/** 会被「单独成段」的块级元素 */
const LEAF_BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li',
  'pre', 'figcaption', 'td', 'th', 'dt', 'dd', 'caption',
  'ul', 'ol', 'dl',
]);
/** 容器型块：本身不是段落，但会把内部块降级/升级类型 */
const CONTAINER_BLOCK = new Set(['blockquote', 'li']);
/**
 * 纯容器元素：自身绝不成段，只按顺序走子节点。
 * div/section 必须在这里 —— 否则 <div><img/></div> 会被当行内内容整段吞掉（图丢、文本和后面的段落粘一起）。
 */
const PURE_CONTAINER = new Set([
  'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav',
  'body', 'figure', 'form', 'fieldset', 'details', 'summary',
]);
/** 空段也要输出的块（图） */
const MEDIA_BLOCK = new Set(['img']);

/**
 * 向上找最近的「图必须由某个块自己发」的祖先（不含自己、不含 el）。
 *
 * 判据有两类，缺一不可：
 *  · LEAF_BLOCK（p/h/li/...）—— 图在段子里，归这段发（<p>文字<img/></p>）。
 *  · PURE_CONTAINER（div/figure/...）—— 图在纯容器里，归遍历到那个容器时发。
 *
 * 少了第二类会漏图：<div><img/></div> 这种「块里只有一张图」的写法，
 * 本来是靠 walkContainer 走到 img 才发的；如果只把 LEAF_BLOCK 当祖先，
 * 图会一路跳过 div 直到 body —— 而 emitBlockImages 从不会在 body 上被调用。
 */
function enclosingBlock(node, el) {
  let anc = node.parent;
  while (anc && anc !== el) {
    if (anc.name !== '' && (LEAF_BLOCK.has(anc.local) || PURE_CONTAINER.has(anc.local))) return anc;
    anc = anc.parent;
  }
  return undefined;
}

/**
 * XHTML → Para[]
 * 只在「不含块级子元素」的块上产出一条，避免 blockquote > p 重复输出。
 * @param {string} xhtml
 * @param {(href:string)=>string} resolve 相对 EPUB 根的路径解析
 */
function xhtmlToParas(xhtml, resolve) {
  const paras = [];
  if (!xhtml) return paras;
  const { nodes } = parseXML(xhtml);
  const root = { name: 'root', local: 'root', attrs: {}, children: nodes, text: '', allText: '', start: 0, parent: undefined };
  const body = findFirst(root, 'body') || nodes[0];
  if (!body) return paras;

  const push = (type, text, src, alt) => {
    if (type === 'img') {
      paras.push({ type: 'img', text: '', src, alt, pi: paras.length });
      return;
    }
    const t = squash(text);
    if (t === '') return;
    paras.push({ type, text: t, pi: paras.length });
  };

  const pushImg = (im) => {
    const raw = attr(im, 'src');
    if (!raw) return;
    if (/^(https?:|data:|mailto:)/i.test(raw)) return; // 远程 / 内联图不处理
    push('img', '', resolve(raw), attr(im, 'alt') || '');
  };

  /**
   * 块里的图：只发「不属于任何嵌套块」的那些。
   * 嵌套块内部的 img 由 walk() 走到内层块时发，这里再发一次就会重复。
   * 直接子的 img 不需要看 consumed —— elementText 已经把 img 当透明元素跳过，
   * 文本里绝不会带上它，所以它必然要单独成一段（<p>图文：<img/></p>）。
   */
  const emitBlockImages = (el) => {
    for (const im of findAll(el, 'img')) {
      if (enclosingBlock(im, el)) continue;
      pushImg(im);
    }
  };

  /** ctx：'plain' | 'quote' | 'li' —— 最近一层容器块决定段落类型 */
  const emitLeaf = (el, ctx) => {
    const local = el.local;
    const t = squash(elementText(el));
    if (t !== '') {
      if (ctx === 'quote') {
        // <blockquote> 里的 <p> 也算引文
        push('quote', t);
      } else if (ctx === 'li') {
        // 列表项：li 自己的直接文本与内层 p 都是条目
        push('p', /^[·•]/.test(t) ? t : `· ${t}`);
      } else if (HEADING_RE.test(local)) {
        push(`h${Math.min(4, Number(local[1]))}`, t); // h5/h6 归一为 h4
      } else if (local === 'blockquote') {
        push('quote', t);
      } else if (local === 'li') {
        push('p', /^[·•]/.test(t) ? t : `· ${t}`);
      } else {
        push('p', t);
      }
    }
    emitBlockImages(el);
  };

  /** 元素里是否含块级子元素（只看直接子元素，决定「整体成段」还是「下钻」） */
  const hasBlockChild = (el) => {
    for (const k of el.children) {
      if (k.name !== '' && LEAF_BLOCK.has(k.local)) return true;
    }
    return false;
  };

  /** <li> 的直接文本 / 行内内容：排掉嵌套列表与嵌套块，避免重复或把子列表并进父条目 */
  const listItemInline = (li) => {
    let out = '';
    for (const k of li.children) {
      if (k.name === '') out += k.text;
      else if (!LEAF_BLOCK.has(k.local)) out += elementText(k);
    }
    return out;
  };

  /** 列表容器：每个 li 都是一个条目；li 里嵌的子列表递归展开 */
  const walkList = (el) => {
    let sawItem = false;
    for (const k of el.children) {
      if (k.name === '' || k.local !== 'li') continue;
      sawItem = true;
      const own = squash(listItemInline(k));
      const hasBlock = hasBlockChild(k);
      if (own !== '') push('p', /^[·•]/.test(own) ? own : `· ${own}`);
      if (hasBlock) walkContainer(k, 'li');
      // li 里不是块的图（<li>文字<img/></li>）
      for (const im of findAll(k, 'img')) {
        if (enclosingBlock(im, k)) continue;
        pushImg(im);
      }
      // 子列表（li > ul/ol）继续展开
      for (const sub of k.children) {
        if (sub.name !== '' && (sub.local === 'ul' || sub.local === 'ol')) walkList(sub);
      }
    }
    if (!sawItem) {
      const t = squash(elementText(el));
      if (t !== '') push('p', t);
    }
  };

  /**
   * 容器元素：按文档顺序走，遇到块级子元素就下钻，
   * 中间夹着的行内元素 / 裸文本合并成一段——否则 <div>裸文字<span>x</span><p>段</p></div>
   * 里的裸文字会丢。
   */
  const walkContainer = (el, ctx) => {
    let buf = '';
    const flushInline = () => {
      const t = squash(buf);
      if (t !== '') push(ctx === 'quote' ? 'quote' : 'p', t);
      buf = '';
    };
    for (const k of el.children) {
      if (k.name === '') {
        buf += k.text;
        continue;
      }
      // 注意顺序：MEDIA_BLOCK 必须排在 TEXT_SKIP 前面。
      // TEXT_SKIP 里有 'img'（取文本时要跳过它），先判 skip 会把 <div><img/></div> 整块吞掉。
      if (MEDIA_BLOCK.has(k.local) || LEAF_BLOCK.has(k.local) || PURE_CONTAINER.has(k.local)) {
        flushInline();
        walk(k, ctx);
        continue;
      }
      if (TEXT_SKIP.has(k.local)) continue; // script/style 的文字绝不进正文
      buf += elementText(k);
    }
    flushInline();
  };

  /**
   * 块级元素。ctx 是外层容器上下文；容器块把 ctx 收紧后继续下钻，
   * 这样 <blockquote><div><p>x</p></div></blockquote> 里的 p 也仍是引文。
   */
  const walk = (el, ctx) => {
    const local = el.local;
    if (MEDIA_BLOCK.has(local)) {
      pushImg(el);
      return;
    }
    if (TEXT_SKIP.has(local)) return; // script/style（img 已在上面处理）
    if (local === 'ul' || local === 'ol') {
      walkList(el);
      return;
    }
    if (PURE_CONTAINER.has(local)) {
      // div/section 之类：自身不成段。
      //  · 里面有块级子元素 → 按子节点顺序下钻（walkContainer 会走到内层块）
      //  · 里面只有行内内容 + 图 → 走 emitLeaf：文字成段，图单独成段
      //    这一步不能省：少了它 <div><img/></div> 一张图都不会输出 ——
      //    下钻时 walkContainer 只把「裸 img 直接子」交给 walk(→pushImg)，
      //    而 emitBlockImages 又因为 enclosingBlock 在 div 处就停下而跳过它。
      if (hasBlockChild(el)) walkContainer(el, ctx);
      else emitLeaf(el, ctx);
      return;
    }
    if (LEAF_BLOCK.has(local)) {
      if (hasBlockChild(el)) {
        let next = ctx;
        if (local === 'blockquote') next = 'quote';
        else if (local === 'li') next = 'li';
        // li 自己的直接文本先输出（嵌套 ul/ol 的文字不算）
        if (local === 'li') {
          const own = squash(listItemInline(el));
          if (own !== '') push('p', /^[·•]/.test(own) ? own : `· ${own}`);
        }
        walkContainer(el, next);
      } else {
        emitLeaf(el, ctx);
      }
      return;
    }
    walkContainer(el, ctx);
  };

  walkContainer(body, 'plain'); // body 自身也算容器
  return paras;
}

// ---------------------------------------------------------------- 目录

/** 取第一个非空属性值（忽略命名空间前缀） */
function attrAny(el, names) {
  for (const n of names) {
    const v = attr(el, n);
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** 元素下所有文本（按文档顺序），用于目录标题 */
function navText(el) {
  let out = '';
  const stack = [{ el, phase: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const cur = frame.el;
    if (frame.phase === 0) {
      frame.phase = 1;
      const kids = cur.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i], phase: 0 });
    } else {
      stack.pop();
      if (cur.name === '') out += cur.text;
    }
  }
  return squash(out);
}

/** 找 li 自己的标签/链接：只看直接子元素与行内后代，绝不越界到嵌套的 ol/ul */
function findOwnLink(li) {
  const stack = [];
  for (let i = li.children.length - 1; i >= 0; i--) stack.push(li.children[i]);
  while (stack.length) {
    const cur = stack.pop();
    if (cur.name === '') continue;
    if (cur.local === 'ol' || cur.local === 'ul') continue; // 不越界
    if (cur.local === 'a' || cur.local === 'span') return cur;
    for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]);
  }
  return undefined;
}

/** 找 li 自己的嵌套列表（只看直接子元素） */
function ownLists(li) {
  const out = [];
  for (const k of li.children) {
    if (k.name === '') continue;
    if (k.local === 'ol' || k.local === 'ul') out.push(k);
  }
  return out;
}

/** 人造根节点，方便复用 findAll/findFirst */
function synthRoot(nodes) {
  return { name: 'root', local: 'root', attrs: {}, children: nodes, text: '', allText: '', start: 0, parent: undefined };
}

/**
 * EPUB3 nav.xhtml → [{href, title, depth}]（href 已解析成 EPUB 根路径）
 * @param {string} src
 * @param {string} navDir nav 文档所在目录
 */
function parseNav(src, navDir) {
  const out = [];
  const { nodes } = parseXML(src);
  const root = synthRoot(nodes);
  const navs = findAll(root, 'nav');
  let tocNav;
  for (const nav of navs) {
    const type = (attrAny(nav, ['epub:type', 'type', 'role']) || '').toLowerCase();
    if (type.split(/\s+/).includes('toc')) {
      tocNav = nav;
      break;
    }
  }
  // 没有明确标注就认第一个含 ol 的 nav
  if (!tocNav) tocNav = navs.find((n) => findFirst(n, 'ol')) || navs[0];
  if (!tocNav) return out;

  const navBase = normalizePath(navDir);

  const walkList = (ol, depth) => {
    for (const li of ol.children) {
      if (li.name === '' || li.local !== 'li') continue;
      const a = findOwnLink(li);
      const href = a ? attr(a, 'href') : undefined;
      const title = a ? navText(a) : navText(li);
      if (href || title) {
        out.push({ href: href ? hrefKey(navBase, href) : '', title: title || '', depth });
      }
      for (const child of ownLists(li)) walkList(child, depth + 1);
    }
  };

  const topOl = findFirst(tocNav, 'ol');
  if (topOl) walkList(topOl, 0);
  return out;
}

/**
 * EPUB2 toc.ncx → [{href, title, depth}]（href 已解析成 EPUB 根路径）
 * @param {string} src
 * @param {string} ncxDir ncx 文件所在目录
 */
function parseNcx(src, ncxDir) {
  const out = [];
  const { nodes } = parseXML(src);
  const root = synthRoot(nodes);
  const navMap = findFirst(root, 'navMap') || root;
  const ncxBase = normalizePath(ncxDir);

  const walkPoints = (parent, depth) => {
    for (const np of parent.children) {
      if (np.name === '' || np.local !== 'navpoint') continue;
      const label = findFirst(np, 'navLabel');
      const textEl = label ? findFirst(label, 'text') : undefined;
      const title = textEl ? navText(textEl) : '';
      const content = findFirst(np, 'content');
      const srcAttr = content ? attr(content, 'src') : undefined;
      const href = srcAttr ? hrefKey(ncxBase, srcAttr) : '';
      if (href || title) out.push({ href, title: title || '', depth });
      const nested = np.children.filter((c) => c.name !== '' && c.local === 'navpoint');
      if (nested.length) walkPoints({ children: nested }, depth + 1);
    }
  };
  walkPoints(navMap, 0);
  return out;
}

/** 从 container.xml 找 OPF 路径 */
function findOpfPath(containerXml) {
  const { nodes } = parseXML(containerXml);
  const root = synthRoot(nodes);
  for (const rf of findAll(root, 'rootfile')) {
    const full = attr(rf, 'full-path');
    if (full && full.trim() !== '') return normalizePath(decodeHref(full.trim()));
  }
  return undefined;
}

/** 媒体类型 → data URL 的 mime */
function imageMime(mediaType, href) {
  const mt = (mediaType || '').toLowerCase().trim();
  if (mt.startsWith('image/')) return mt;
  const ext = shortName(href).toLowerCase().split('.').pop();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
  };
  return map[ext] || 'image/jpeg';
}

// ---------------------------------------------------------------- EPUB

/**
 * 解析 EPUB。
 * @param {ArrayBuffer|Uint8Array} buf
 * @param {string} filename
 * @param {number} [lastModified] 文件最后修改时间（ms）。CONTRACT 的 id 形状需要它，
 *                                拿不到时传 0，由调用方（file input / 拖拽）补。
 * @returns {Promise<object>} BookDoc
 */
export async function parseEPUB(buf, filename, lastModified = 0) {
  const bytes = toU8(buf);
  const name = filename ? String(filename) : '未命名.epub';
  const zip = new ZipReader(bytes);

  const containerBytes = await zip.read('META-INF/container.xml');
  if (!containerBytes) throw new Error('这个文件不是有效的 EPUB：找不到 META-INF/container.xml');
  const opfPath = findOpfPath(stripBom(utf8Decoder.decode(containerBytes)));
  if (!opfPath) throw new Error('这个 EPUB 不完整：container.xml 里没有 rootfile 的 full-path');
  const opfBytes = await zip.read(opfPath);
  if (!opfBytes) throw new Error(`这个 EPUB 不完整：找不到 OPF 文件（${opfPath}）`);
  const opfXml = stripBom(utf8Decoder.decode(opfBytes));
  const opfDir = dirOf(opfPath);

  const { nodes: opfNodes } = parseXML(opfXml);
  const pkg = opfNodes[0];
  if (!pkg) throw new Error('这个 EPUB 的 OPF 文件是空的或无法解析');

  // ---- metadata
  const metaEl = findFirst(pkg, 'metadata');
  const dc = (localName) => {
    const el = metaEl ? findFirst(metaEl, localName) : undefined;
    return el ? squash(el.allText) : '';
  };
  const title = dc('title') || shortName(name).replace(/\.epub$/i, '') || '未命名';
  const author = dc('creator');

  // ---- manifest
  const manifestEl = findFirst(pkg, 'manifest');
  const items = new Map();
  /** @type {Array<{id:string,href:string,mediaType:string,properties:string,path:string}>} */
  const itemList = [];
  if (manifestEl) {
    for (const it of manifestEl.children) {
      if (it.name === '' || it.local !== 'item') continue;
      const id = attr(it, 'id') || '';
      const href = attr(it, 'href') || '';
      const mediaType = attr(it, 'media-type') || '';
      const properties = attr(it, 'properties') || '';
      const path = href ? hrefKey(opfDir, href) : '';
      const rec = { id, href, mediaType, properties, path };
      if (id) items.set(id, rec);
      itemList.push(rec);
    }
  }

  // ---- spine（顺序即章节顺序）
  const spineEl = findFirst(pkg, 'spine');
  const spineItems = [];
  if (spineEl) {
    for (const ir of spineEl.children) {
      if (ir.name === '' || ir.local !== 'itemref') continue;
      const idref = attr(ir, 'idref');
      if (!idref) continue;
      if ((attr(ir, 'linear') || '').toLowerCase() === 'no') continue;
      const item = items.get(idref);
      if (!item || !item.path) continue;
      spineItems.push({ id: idref, item });
    }
  }
  if (spineItems.length === 0) {
    // 没有可用 spine：退化为 manifest 里的 XHTML 顺序
    for (const it of itemList) {
      if (/xhtml|html/i.test(it.mediaType) || /\.x?html?$/i.test(it.path)) {
        spineItems.push({ id: it.id || it.path, item: it });
      }
    }
  }
  if (spineItems.length === 0) throw new Error('这个 EPUB 没有可读的正文：spine 是空的');

  // ---- 目录：EPUB3 nav 优先，其次 EPUB2 ncx
  let tocEntries = [];
  const navItem = itemList.find((it) => it.properties.split(/\s+/).includes('nav') && it.path);
  if (navItem) {
    const navBytes = await zip.read(navItem.path);
    if (navBytes) {
      try {
        tocEntries = parseNav(stripBom(utf8Decoder.decode(navBytes)), dirOf(navItem.path));
      } catch {
        tocEntries = [];
      }
    }
  }
  if (tocEntries.length === 0) {
    let ncxPath;
    const tocId = spineEl ? attr(spineEl, 'toc') : undefined;
    if (tocId && items.has(tocId)) ncxPath = items.get(tocId).path;
    if (!ncxPath) {
      const ncxItem = itemList.find((it) => /dtbncx/i.test(it.mediaType) || /\.ncx$/i.test(it.path));
      if (ncxItem) ncxPath = ncxItem.path;
    }
    if (ncxPath) {
      const ncxBytes = await zip.read(ncxPath);
      if (ncxBytes) {
        try {
          tocEntries = parseNcx(stripBom(utf8Decoder.decode(ncxBytes)), dirOf(ncxPath));
        } catch {
          tocEntries = [];
        }
      }
    }
  }

  // href → {title, depth}（同一路径多次出现时取第一条）
  const byPath = new Map();
  const byShort = new Map();
  for (const e of tocEntries) {
    if (!e.href) continue;
    if (!byPath.has(e.href)) byPath.set(e.href, e);
    const s = shortName(e.href);
    if (s && !byShort.has(s)) byShort.set(s, e);
  }

  // ---- 正文
  const chapters = [];
  let charCount = 0;
  for (let index = 0; index < spineItems.length; index++) {
    const { id, item } = spineItems[index];
    const chapterBase = dirOf(item.path);
    const resolve = (href) => hrefKey(chapterBase, href);
    let raw = '';
    try {
      const b = await zip.read(item.path);
      raw = b ? stripBom(utf8Decoder.decode(b)) : '';
    } catch {
      raw = '';
    }
    let paras = [];
    try {
      paras = xhtmlToParas(raw, resolve);
    } catch {
      paras = [];
    }
    const toc = byPath.get(item.path) || byShort.get(shortName(item.path));
    const text = paras.map((p) => p.text).join('\n');
    charCount += text.length;
    chapters.push({
      id: id || `c${index}`,
      title: (toc && toc.title) || `第 ${index + 1} 章`,
      index,
      depth: toc ? toc.depth : 0,
      href: item.path,
      text,
      paras,
      body: raw,
    });
  }

  // ---- 封面（取不到就留 undefined，不抛错）
  let cover;
  try {
    cover = await extractCover(zip, itemList, metaEl);
  } catch {
    cover = undefined;
  }

  const language = dc('language');
  const publisher = dc('publisher');
  const description = dc('description');

  const meta = {
    id: `${name}|${bytes.byteLength}|${Number(lastModified) || 0}`,
    title,
    author: author || '',
    format: 'epub',
    size: bytes.byteLength,
    addedAt: Date.now(),
    charCount,
    chapterCount: chapters.length,
  };
  if (language) meta.language = language;
  if (publisher) meta.publisher = publisher;
  if (description) meta.description = description;
  if (cover) meta.cover = cover;

  return { meta, chapters, rev: 1 };
}

/** 封面：properties 含 cover-image，或 <meta name="cover" content="id"> */
async function extractCover(zip, itemList, metaEl) {
  let target;
  for (const it of itemList) {
    if (it.properties.split(/\s+/).includes('cover-image') && it.path) {
      target = it;
      break;
    }
  }
  if (!target && metaEl) {
    for (const m of metaEl.children) {
      if (m.name === '' || m.local !== 'meta') continue;
      if ((attr(m, 'name') || '').toLowerCase() !== 'cover') continue;
      const id = attr(m, 'content');
      if (!id) continue;
      const it = itemList.find((x) => x.id === id);
      if (it && it.path) {
        target = it;
        break;
      }
    }
  }
  if (!target) return undefined;
  const data = await zip.read(target.path);
  if (!data || data.length === 0) return undefined;
  const mime = imageMime(target.mediaType, target.path);
  return `data:${mime};base64,${bytesToBase64(data)}`;
}

// ---------------------------------------------------------------- TXT

const CN_DIGITS = '零一二三四五六七八九〇两十百千';

// 主标题形式：第N章/节/回/卷/篇/部/集/话/幕（N 可为阿拉伯数字或中文数字）
const RE_CHAPTER_CN = new RegExp(`^[\\s\\u3000]*第\\s*[0-9０-９${CN_DIGITS}]{1,6}\\s*[章节回卷篇部集话幕]`);
// Chapter 1 / CHAPTER XII / Chapter 1.5 / Part 2
const ANUM = '(?:[0-9０-９]{1,4}|[IVXLCDMivxlcdm]{1,8})';
const RE_CHAPTER_EN = new RegExp(`^[\\s\\u3000]*(?:chapter|chap\\.?|part)\\s+${ANUM}(?:\\s*[:：.、]|\\s|$)`, 'i');

const SENT_END_RE = /[。！？!?…；;：:”"』」】]$/;

/** 一行是不是明确的章节标题（第N章 / Chapter N） */
function isChapterHeading(rawLine) {
  const line = String(rawLine).trim();
  if (line === '' || line.length > 40) return false;
  return RE_CHAPTER_CN.test(line) || RE_CHAPTER_EN.test(line);
}

/** 短行标题的兜底阈值：超过这个长度就算正文行 */
const LONG_LINE = 20;

/** 候选行后面有没有「正常长度的正文行」 */
function hasLongNeighbor(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === '') continue;
    return t.length >= LONG_LINE;
  }
  return false;
}

/**
 * 短行标题兜底：单独一行、很短、不含句末标点，且下一段是正常长度的正文。
 * 加「下一行够长」这条约束是因为短对话（「你来了。」）在中文 TXT 里遍地都是，
 * 光看长度会把整本书切碎。
 */
function isShortTitleLine(rawLine, rawLines, i) {
  const line = String(rawLine).trim();
  if (line === '' || line.length >= LONG_LINE) return false;
  if (SENT_END_RE.test(line)) return false;
  if (/[，,、]/.test(line)) return false;
  if (/[“”"'『」]/.test(line)) return false;
  return hasLongNeighbor(rawLines, i);
}

/**
 * 章内文本 → Para[]。
 * 单个换行仍属同一段（很多中文 TXT 每行都硬换行），连续空行才分段。
 * 标题行本身作为首段 h2 保留。
 */
function textToParas(text, title) {
  const paras = [];
  const push = (type, value) => {
    const t = squash(value);
    if (t === '') return;
    paras.push({ type, text: t, pi: paras.length });
  };
  if (title) push('h2', title);

  // 相邻两行都是 ASCII 字母/数字收尾与开头时补空格，避免英文 TXT 被粘成一个词
  const joinLines = (arr) => {
    let out = '';
    for (const l of arr) {
      if (out === '') {
        out = l;
        continue;
      }
      const needSpace = /[A-Za-z0-9,;:)\]}"']$/.test(out) && /^[A-Za-z0-9("'\-]/.test(l);
      out += needSpace ? ` ${l}` : l;
    }
    return out;
  };

  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let buf = [];
  const flush = () => {
    if (buf.length === 0) return;
    push('p', joinLines(buf));
    buf = [];
  };
  for (const raw of lines) {
    if (squash(raw) === '') {
      flush();
      continue;
    }
    buf.push(String(raw).trim());
  }
  flush();
  return paras;
}

/**
 * 解析 TXT：编码嗅探 + 章节切分。
 * @param {ArrayBuffer|Uint8Array} buf
 * @param {string} filename
 * @param {number} [lastModified]
 * @returns {object} BookDoc
 */
export function parseTXT(buf, filename, lastModified = 0) {
  const bytes = toU8(buf);
  const name = filename ? String(filename) : '未命名.txt';
  const text = decodeText(bytes, detectCharset(bytes)).replace(/\r\n?/g, '\n');

  const lines = text.split('\n');
  /** @type {Array<{title:string, body:string}>} */
  const groups = [];
  let cur = null;
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isChapterHeading(line) || isShortTitleLine(line, lines, i)) {
      if (cur) {
        cur.body = pending.slice(1).join('\n'); // 首行即标题，textToParas 会重建成 h2
        groups.push(cur);
      } else if (squash(pending.join('\n')) !== '') {
        // 章节标记之前的内容：单独一章，但它没有真实标题，正文里也不再重复一次「前言」
        groups.push({ title: '前言', body: pending.join('\n'), heading: false });
      }
      cur = { title: squash(line), body: '' };
      pending = [line];
    } else {
      pending.push(line);
    }
  }
  if (cur) {
    cur.body = pending.slice(1).join('\n');
    groups.push(cur);
  } else if (squash(pending.join('\n')) !== '') {
    // 整本都没有章节标记：整本一章，标题只是代号，不要在正文里再插一行
    groups.push({ title: '正文', body: pending.join('\n'), heading: false });
  }
  if (groups.length === 0) groups.push({ title: '正文', body: text, heading: false });

  const chapters = groups.map((g, index) => {
    const title = g.title === '' ? (index === 0 ? '正文' : `第 ${index + 1} 章`) : g.title;
    const paras = textToParas(g.body, g.heading === false ? '' : title);
    return {
      id: `c${index}`,
      title,
      index,
      depth: 0,
      text: paras.map((p) => p.text).join('\n'),
      paras,
      body: g.body,
    };
  });

  let charCount = 0;
  for (const c of chapters) charCount += c.text.length;

  const meta = {
    id: `${name}|${bytes.byteLength}|${Number(lastModified) || 0}`,
    title: shortName(name).replace(/\.txt$/i, '') || '未命名',
    author: '',
    format: 'txt',
    size: bytes.byteLength,
    addedAt: Date.now(),
    charCount,
    chapterCount: chapters.length,
  };
  return { meta, chapters, rev: 1 };
}
