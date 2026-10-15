/* ============================================================
   陪读 · 自研 ZIP 读取器（零依赖）
   ------------------------------------------------------------
   为什么不用 JSZip：
   参考项目 bionic-reader 用三个 CDN 外链去加载 JSZip，结果断网就导不了书，
   而且跟它自己宣称的「纯本地、无网络请求」直接矛盾。对一个要往里填 API Key
   的阅读器来说，这是最不该有的失败点。
   浏览器原生 DecompressionStream('deflate-raw') 就能解 EPUB 里唯一用到的
   deflate 流（Safari 16.4+ 支持），于是整个依赖可以直接删掉。

   为什么**不能**顺着 local header 往下扫：
   ZIP 若用了 data descriptor（流式写入的标志，bit 3），local header 里的
   compressedSize / uncompressedSize 会写成 0，扫描到第二个条目就错位。
   Central Directory 的大小字段**永远是准的**，所以一律以它为准，
   local header 只用来取「文件数据从第几个字节开始」。

   不做的事（明确记录，避免以后有人以为是 bug）：
   - 不写 ZIP（导出功能用不到）
   - 不解加密（EPUB 里只有 fonts 会被 obfuscate，那是另一套算法，见 obfuscation）
   - 不支持 method 的其它取值（EPUB 规范只允许 stored 与 deflate）
   ============================================================ */

/* ---------------------------- 常量 ---------------------------- */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** EOCD 最小 22 字节，注释最长 65535 → 从尾部最多扫这么多字节能找到 */
const EOCD_MAX_SCAN = 22 + 0xffff;

/* ---------------------------- 小工具 ---------------------------- */

function u16(dv, p) {
  return dv.getUint16(p, true);
}
function u32(dv, p) {
  return dv.getUint32(p, true);
}
/** 读 64 位。JS 数字精度只到 2^53，ZIP64 的偏移不可能超过它（超过也没内存装下） */
function u64(dv, p) {
  return dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
}

function startsWith(bytes, off, sig) {
  if (off < 0 || off + 4 > bytes.length) return false;
  const b0 = sig & 0xff;
  const b1 = (sig >>> 8) & 0xff;
  const b2 = (sig >>> 16) & 0xff;
  const b3 = (sig >>> 24) & 0xff;
  return bytes[off] === b0 && bytes[off + 1] === b1 && bytes[off + 2] === b2 && bytes[off + 3] === b3;
}

/* ---- CRC32（ZIP 的完整性校验；用来抓「解压出来是坏数据」这种静默错误）---- */

let _crcTable = null;
function crcTable() {
  if (_crcTable) return _crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  _crcTable = t;
  return t;
}

/** @param {Uint8Array} bytes */
export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------- 解压 ---------------------------- */

/** deflate-raw 的 DecompressionStream 只建一次（探测一次，之后记结论） */
let _deflateOk = null;

/** 本环境能不能解 deflate。Node 18.11+/Safari 16.4+ 都可以；用于给出清楚的错误提示 */
export function canDecompress() {
  if (_deflateOk !== null) return _deflateOk;
  try {
    // eslint-disable-next-line no-new
    new DecompressionStream('deflate-raw');
    _deflateOk = true;
  } catch {
    _deflateOk = false;
  }
  return _deflateOk;
}

/**
 * @param {Uint8Array} raw 压缩数据
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(raw) {
  if (!canDecompress()) {
    throw new Error('这个浏览器不支持解压 EPUB（需要 Safari 16.4 或更新的版本）');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // 不 await 写入：大文件时先写满管道会死锁，必须边写边读
  const pump = writer.write(raw).then(() => writer.close());
  const chunks = [];
  let total = 0;
  const reader = ds.readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    await pump;
  } catch (err) {
    // 压缩流坏掉时 read() 会抛，这里换成用户能看懂的话
    throw new Error('书里的压缩数据坏了，没法解压：' + (err?.message || err));
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ---------------------------- 文本解码 ---------------------------- */

/**
 * 编码嗅探。EPUB 规范要求 UTF-8，但现实里中文 TXT/HTML 经常是 GBK，
 * 而 GBK 文件用 UTF-8 解出来是满屏「锟斤拷」—— 那比报错更糟，用户会以为是软件坏了。
 *
 * 顺序：BOM → UTF-8 严格解 → GBK → UTF-8 宽松解（兜底，宁可留替换符也不要抛）
 * @param {Uint8Array} bytes
 * @param {string} [hint] 来自 XML 声明 / meta charset 的提示，如 'gb2312'
 * @returns {string}
 */
export function decodeText(bytes, hint) {
  if (!bytes || !bytes.length) return '';

  // BOM 最可靠，先认
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  // 声明里写了的编码优先信它（但信不过就算了，见下面的 fallback）
  const declared = normalizeEncoding(hint);
  if (declared) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      /* 这个浏览器没实现该编码，继续往下试 */
    }
  }

  // UTF-8 严格模式：能过就是 UTF-8（多字节序列非法会抛）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* 不是 UTF-8 */
  }

  // 中文书剩下最可能的就是 GBK 系（GBK ⊃ GB2312，用 GBK 解 GB2312 更宽松）
  for (const enc of ['gbk', 'gb18030', 'big5']) {
    try {
      return new TextDecoder(enc).decode(bytes);
    } catch {
      /* 浏览器不支持这个编码标签 */
    }
  }

  // 全都试过了：宽松 UTF-8，非法字节变 U+FFFD。至少书还能看出来是什么
  return new TextDecoder('utf-8').decode(bytes);
}

/** 把 'gb2312' / 'GBK' / 'utf8' 之类统一成 TextDecoder 认的标签 */
export function normalizeEncoding(label) {
  if (!label) return '';
  const s = String(label).trim().toLowerCase().replace(/["']/g, '');
  if (!s) return '';
  if (s === 'utf8' || s === 'utf-8') return 'utf-8';
  if (s === 'utf16' || s === 'utf-16' || s === 'unicode') return 'utf-16le';
  if (s === 'gb2312' || s === 'gb_2312' || s === 'csgb2312') return 'gbk'; // GBK 是超集，更不容易炸
  if (s === 'gb18030') return 'gb18030';
  return s;
}

/** 从 HTML/XML 头部前 1KB 里嗅 charset 声明 */
export function sniffCharset(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length)));
  let m = /<\?xml[^>]*encoding\s*=\s*["']([\w.-]+)["']/i.exec(head);
  if (m) return m[1];
  m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.-]+)/i.exec(head);
  if (m) return m[1];
  return '';
}

/* ---------------------------- 读取器 ---------------------------- */

/**
 * 一个 ZIP 归档。构造时只读目录（不解压任何内容），条目按需解压并缓存。
 */
export class ZipArchive {
  /**
   * @param {ArrayBuffer|Uint8Array} buffer
   */
  constructor(buffer) {
    /** @type {Uint8Array} */
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    /** @type {Map<string, {name:string, method:number, compressedSize:number, size:number, crc:number, localOffset:number}>} */
    this.entries = new Map();
    /** 解压缓存：name -> Uint8Array（EPUB 会被反复取同一批文件，缓存掉很值） */
    this._cache = new Map();
    this._readDirectory();
  }

  get names() {
    return [...this.entries.keys()];
  }

  has(name) {
    return this.entries.has(name);
  }

  entry(name) {
    return this.entries.get(name) || null;
  }

  /* ---- 目录 ---- */

  _readDirectory() {
    const b = this.bytes;
    const eocd = this._findEOCD();

    let count = u16(this.dv, eocd + 10);
    let cdOffset = u32(this.dv, eocd + 16);

    // ZIP64：字段被写成 0xffffffff 时真值在 ZIP64 EOCD 里
    if (count === 0xffff || cdOffset === 0xffffffff) {
      const loc = this._findEOCD64Locator(eocd);
      if (loc >= 0) {
        const z64 = u64(this.dv, loc + 8);
        if (startsWith(b, z64, SIG_EOCD64)) {
          count = u64(this.dv, z64 + 32);
          cdOffset = u64(this.dv, z64 + 48);
        }
      }
    }

    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (!startsWith(b, p, SIG_CEN)) {
        // 目录走到一半坏了：已经读到的条目照常用，剩下的放弃。
        // 宁可少几章也不要整本书打不开。
        console.warn('[zip] central directory 在第', i, '条中断，已读到', this.entries.size, '个条目');
        break;
      }
      const method = u16(this.dv, p + 10);
      const crc = u32(this.dv, p + 16);
      let compressedSize = u32(this.dv, p + 20);
      let size = u32(this.dv, p + 24);
      const nameLen = u16(this.dv, p + 28);
      const extraLen = u16(this.dv, p + 30);
      const commentLen = u16(this.dv, p + 32);
      let localOffset = u32(this.dv, p + 42);

      const nameBytes = b.subarray(p + 46, p + 46 + nameLen);
      // 目录里的文件名按规范是 UTF-8（flag bit 11）或 CP437；中文 EPUB 基本都写 UTF-8
      const name = new TextDecoder('utf-8').decode(nameBytes);

      // ZIP64 扩展字段：0x0001，字段顺序按「哪些值被写成 0xffffffff」依次排列
      if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        const ex = this._readZip64Extra(p + 46 + nameLen, extraLen);
        if (ex.size != null) size = ex.size;
        if (ex.compressedSize != null) compressedSize = ex.compressedSize;
        if (ex.localOffset != null) localOffset = ex.localOffset;
      }

      this.entries.set(name, { name, method, compressedSize, size, crc, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    if (!this.entries.size) throw new Error('这个 zip 里没读到任何文件，可能不是 EPUB');
  }

  /** 从尾部往回找 EOCD */
  _findEOCD() {
    const b = this.bytes;
    const len = b.length;
    if (len < 22) throw new Error('文件太小，不像是一个 EPUB');
    const from = Math.max(0, len - EOCD_MAX_SCAN);
    for (let p = len - 22; p >= from; p--) {
      if (startsWith(b, p, SIG_EOCD)) return p;
    }
    throw new Error('这个文件不是 zip 格式（找不到 zip 结尾标记），可能不是 EPUB 或已经损坏');
  }

  _findEOCD64Locator(eocd) {
    // ZIP64 locator 紧贴在 EOCD 前面（中间可能有数字签名，罕见，这里按常见情况处理）
    const p = eocd - 20;
    if (p >= 0 && startsWith(this.bytes, p, SIG_EOCD64_LOC)) return p;
    return -1;
  }

  _readZip64Extra(off, len) {
    const out = { size: null, compressedSize: null, localOffset: null };
    const end = off + len;
    let p = off;
    while (p + 4 <= end) {
      const id = u16(this.dv, p);
      const sz = u16(this.dv, p + 2);
      let q = p + 4;
      if (id === 0x0001) {
        // 三个字段只有「在原记录里是 0xffffffff」的才会出现，顺序固定
        out.size = u64(this.dv, q);
        q += 8;
        out.compressedSize = u64(this.dv, q);
        q += 8;
        out.localOffset = u64(this.dv, q);
        return out;
      }
      p = q + sz;
    }
    return out;
  }

  /* ---- 取内容 ---- */

  /**
   * 解压并返回某个条目的字节。
   * @param {string} name
   * @returns {Promise<Uint8Array>}
   */
  async read(name) {
    const hit = this._cache.get(name);
    if (hit) return hit;
    const e = this.entries.get(name);
    if (!e) throw new Error(`书里找不到 ${name}`);

    const raw = this._rawBytes(e);
    let out;
    if (e.method === METHOD_STORE) {
      out = raw;
    } else if (e.method === METHOD_DEFLATE) {
      out = await inflateRaw(raw);
    } else {
      throw new Error(`书里有不支持的压缩方式（method ${e.method}）：${name}`);
    }

    // CRC 校验：解压出来的东西不对时必须在这里报错，
    // 否则一路传到渲染层会变成「正文乱码」这种没法归因的 bug。
    if (e.crc && out.length && crc32(out) !== e.crc) {
      throw new Error(`书里的 ${name} 数据损坏（校验不通过）`);
    }
    this._cache.set(name, out);
    return out;
  }

  /** 取该条目的原始（仍压缩的）字节。以 central directory 的大小为准。 */
  _rawBytes(e) {
    const b = this.bytes;
    const p = e.localOffset;
    if (!startsWith(b, p, SIG_LOC)) {
      throw new Error(`zip 条目定位失败：${e.name}`);
    }
    const nameLen = u16(this.dv, p + 26);
    const extraLen = u16(this.dv, p + 28);
    const dataStart = p + 30 + nameLen + extraLen;
    const end = dataStart + e.compressedSize;
    if (end > b.length) throw new Error(`zip 条目越界：${e.name}`);
    // subarray 不复制，交给上层决定是否复制；解压函数自己会产出新数组
    return b.subarray(dataStart, end);
  }

  /**
   * 解压并当文本读（自动嗅探编码）。
   * @param {string} name
   * @returns {Promise<string>}
   */
  async readText(name) {
    const bytes = await this.read(name);
    return decodeText(bytes, sniffCharset(bytes));
  }

  /** 释放缓存（导入大书完成后调用，避免把整本压缩数据留在内存里） */
  dispose() {
    this._cache.clear();
  }
}

/**
 * 打开一个 zip。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {ZipArchive}
 */
export function openZip(buffer) {
  return new ZipArchive(buffer);
}

/* ---------------------------- 路径 ---------------------------- */

/**
 * 按 zip 的路径语义解析相对路径。
 * 例：resolvePath('OEBPS/content.opf', '../Text/ch1.xhtml') → 'Text/ch1.xhtml'
 * @param {string} base 一个文件路径（不是目录，末尾斜杠会被忽略）
 * @param {string} rel
 * @returns {string}
 */
export function resolvePath(base, rel) {
  if (!rel) return base || '';
  // 绝对路径（以 / 开头）直接就是 zip 内的路径
  if (rel[0] === '/') return normalizePath(rel.slice(1));
  // 带 scheme 或已是绝对 URL 的不动（EPUB 里偶尔有 http 链接，交给上层丢弃）
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel;

  const baseDir = base && base.indexOf('/') >= 0 ? base.slice(0, base.lastIndexOf('/')) : '';
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function normalizePath(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** 取目录部分（不含末尾斜杠） */
export function dirname(p) {
  const i = String(p).lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** 取文件名 */
export function basename(p) {
  const i = String(p).lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** 扩展名（小写，不含点） */
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}
