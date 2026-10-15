// core/xml.js —— 极小 XML/XHTML 解析器
//
// 为什么手写：Node 里没有 DOMParser（tools/probe-runtime.mjs 已实测），
// 而 core/ 层要求「浏览器与 Node 都能直接跑」。这里不碰任何 DOM API，
// 只用字符串扫描 + 显式栈，因此 5MB 的 XHTML 也不会爆栈。
//
// 设计约束（来自 CONTRACT.md 与任务书）：
//  - 命名空间前缀完全任意：只用 local name 做匹配（`dc:title` → `title`）
//  - 容错优先：未闭合、错配、非法属性一律不抛异常
//  - 兄弟节点用显式栈处理，不做递归下降

/** @typedef {Object} XmlNode
 *  @property {string} name        元素名，保留原样（含命名空间前缀，如 'dc:title'）；文本节点为 ''
 *  @property {string} local       去掉前缀后的名字，小写；文本节点为 ''
 *  @property {Object<string,string>} attrs   属性名原样 → 值（实体已解码）
 *  @property {XmlNode[]} children
 *  @property {string} text        该元素下所有直接文本拼接（实体已解码，不递归进子元素）
 *  @property {string} allText     该元素下递归所有文本拼接
 *  @property {number} start       'text' 时为 1，元素为 0
 */

// ---------------------------------------------------------------- 实体解码

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  // 中文排版常见实体（XHTML 里很常见，且不是 XML 预定义的 5 个之一）
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  middot: '\u00b7',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  times: '\u00d7',
  divide: '\u00f7',
  laquo: '\u00ab',
  raquo: '\u00bb',
  sect: '\u00a7',
  para: '\u00b6',
  dagger: '\u2020',
  permil: '\u2030',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  shy: '\u00ad',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  lrm: '\u200e',
  rlm: '\u200f',
};

/** 数字字符引用 → 字符串（不做 XML 合法性校验，宽容优先） */
function fromCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  if (cp >= 0xd800 && cp <= 0xdfff) return '\ufffd';
  return String.fromCodePoint(cp);
}

/**
 * 解码 XML/HTML 实体：&amp; &lt; &gt; &quot; &apos; &nbsp; &#123; &#x1F600;
 * 以及中文排版常见 &mdash; &hellip; &ldquo; 等。
 * 不认识的实体保持原样（不要吞掉内容）。
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  if (typeof s !== 'string' || s.indexOf('&') < 0) return typeof s === 'string' ? s : '';
  return s.replace(/&(#[xX]?[0-9a-fA-F]*|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      if (digits === '') return m;
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(cp)) return m;
      return fromCodePoint(cp);
    }
    const lower = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) {
      // 命名实体大小写敏感：&AMP; 合法，&Amp; 不合法 → 后者原样返回
      if (body !== lower && body !== 'AMP' && body !== 'LT' && body !== 'GT' && body !== 'QUOT' && body !== 'APOS') {
        return m;
      }
      return NAMED_ENTITIES[lower];
    }
    return m;
  });
}

// ---------------------------------------------------------------- 名字工具

/** 本地名：第一个冒号之后的部分，小写 */
function localOf(name) {
  const i = name.indexOf(':');
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

/** 建节点 */
function node(name, attrs) {
  return {
    name,
    local: name === '' ? '' : localOf(name),
    attrs: attrs || {},
    children: [],
    text: '',
    allText: '',
    // 内部字段：有没有「文本子节点」——用来区分 <p></p> 与 <p> </p>
    hasText: false,
    start: name === '' ? 1 : 0,
  };
}

const isElem = (n) => n.name !== '';

/** 建文本节点并挂到父节点上 */
function textNode(value) {
  const n = node('');
  n.text = value;
  n.allText = value;
  n.hasText = true;
  return n;
}

// ---------------------------------------------------------------- 解析器

// 允许出现在属性名/标签名里的字符（比 XML 规范宽一点，宽容优先）
// 注意：空白必须全在集合里。早期版本漏了 '\n'，于是 "<a\n>" 被解析成名字 "a\n"，
// 后续 </a> 匹配不上，整个文档的标签全部挂在栈上不闭合。
const WS = '\t\n\r\f ';
const NAME_STOP = new Set([' ', '\t', '\n', '\r', '\f', '/', '>', '=', '<', '"', "'"]);

const SKIP_TEXT_TAGS = new Set(['script', 'style', 'head', 'title', 'template']);

/**
 * 在整棵树里找全部后代元素（不递归，显式栈；跳过 script/style 等）
 * @param {XmlNode} node
 * @param {string} localName 不含前缀，大小写不敏感
 * @returns {XmlNode[]}
 */
export function findAll(node, localName) {
  const want = String(localName || '').toLowerCase();
  const out = [];
  if (!node) return out;
  const stack = [];
  for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  while (stack.length) {
    const el = stack.pop();
    if (!isElem(el)) continue;
    if (el.local === want) out.push(el);
    if (SKIP_TEXT_TAGS.has(el.local)) continue;
    for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
  }
  return out;
}

/**
 * 在整棵树里找第一个匹配的后代元素（深度优先，文档顺序）
 * @param {XmlNode} node
 * @param {string} localName
 * @returns {XmlNode|undefined}
 */
export function findFirst(node, localName) {
  const want = String(localName || '').toLowerCase();
  if (!node) return undefined;
  const stack = [];
  for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  while (stack.length) {
    const el = stack.pop();
    if (!isElem(el)) continue;
    if (el.local === want) return el;
    if (SKIP_TEXT_TAGS.has(el.local)) continue;
    for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
  }
  return undefined;
}

/**
 * 取属性值，忽略命名空间前缀差异，属性名大小写不敏感。
 *   attr(el, 'href')      ← 匹配 href / xlink:href / HREF
 *   attr(el, 'lang')      ← 优先精确的 lang，其次 xml:lang
 *   attr(el, 'epub:type') ← 精确匹配 'epub:type'（大小写不敏感）
 *
 * 两轮查找：先全名精确（大小写不敏感），再退化为「去前缀后等于查询名」。
 * 这样 `<p xml:lang="zh-CN" lang="zh">` 上 attr(p,'lang') === 'zh'（精确优先），
 * 而只有 xml:lang 时也能取到。
 * @param {XmlNode} node
 * @param {string} name
 * @returns {string|undefined}
 */
export function attr(node, name) {
  if (!node || !node.attrs) return undefined;
  const attrs = node.attrs;
  const lower = String(name).toLowerCase();
  for (const key in attrs) {
    if (key.toLowerCase() === lower) return attrs[key];
  }
  for (const key in attrs) {
    const k = key.toLowerCase();
    const ci = k.indexOf(':');
    if (ci >= 0 && k.slice(ci + 1) === lower) return attrs[key];
  }
  return undefined;
}

class XmlParser {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.n = src.length;
    // 合成 root：名字为空（不是节点），start 固定 0（只有文本节点才是 1）
    this.root = node('');
    this.root.start = 0;
    this.stack = [this.root];
    this.top = this.root;
    /** 顶部未 flush 的原始文本 */
    this.pending = '';
    this.hasPending = false;
  }

  /** 收下一段原始文本（实体留到 flush 时统一解码） */
  appendText(s) {
    if (s === '') return;
    this.hasPending = true;
    this.pending += s;
  }

  /**
   * 把缓冲文本作为「文本子节点」交给当前元素。
   *
   * 为什么必须是子节点而不是只写进 el.text：
   * <p>甲<em>乙</em>丙</p> 里 "甲"、"丙" 都在 p 上，只累加字符串会丢掉
   * 「甲 在 em 前、丙 在 em 后」这个顺序信息，allText 就会变成 "甲丙乙"。
   * 所以文本一律物化成 name === '' 的节点，顺序由 children 数组保证。
   */
  flush() {
    if (this.pending === '') return;
    const value = decodeEntities(this.pending);
    this.pending = '';
    this.hasPending = false;
    this.top.hasText = true;
    this.top.children.push(textNode(value));
  }

  /** 属性名/值扫描，返回新的下标 */
  parseAttrs(el, i) {
    const s = this.s;
    while (i < this.n) {
      while (i < this.n && WS.indexOf(s[i]) >= 0) i++;
      if (i >= this.n) break;
      const c = s[i];
      if (c === '>' || c === '/') break;
      // 属性名读到空白 / '/' / '>' / '=' 为止。注意 '=' 必须也算终止符，
      // 否则 `href=x`（无引号）会把名字读成 "href=x"。
      const nameStart = i;
      while (i < this.n) {
        const ch = s[i];
        if (WS.indexOf(ch) >= 0 || ch === '=' || ch === '/' || ch === '>' || ch === '<') break;
        i++;
      }
      // 属性名保留原样（XML 区分大小写），容错匹配交给 attr()
      const name = s.slice(nameStart, i);
      while (i < this.n && WS.indexOf(s[i]) >= 0) i++;
      if (s[i] !== '=') {
        // 无值属性（XHTML 里非法，但宽容处理）
        if (name !== '') el.attrs[name] = '';
        continue;
      }
      i++; // '='
      while (i < this.n && WS.indexOf(s[i]) >= 0) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        i++;
        const end = s.indexOf(q, i);
        const stop = end < 0 ? this.n : end;
        if (name !== '') el.attrs[name] = decodeEntities(s.slice(i, stop));
        i = end < 0 ? this.n : end + 1;
      } else {
        const vStart = i;
        while (i < this.n && !NAME_STOP.has(s[i])) i++;
        if (name !== '') el.attrs[name] = decodeEntities(s.slice(vStart, i));
      }
    }
    return i;
  }

  /** 扫描到 tag 的结束位置（跳过引号内的 '>'），返回 '>' 的下标，找不到返回 n */
  scanTagEnd(i) {
    const s = this.s;
    while (i < this.n) {
      const q = s[i];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, i + 1);
        i = end < 0 ? this.n : end + 1;
        continue;
      }
      if (q === '>') return i;
      i++;
    }
    return this.n;
  }

  /** `<!` 开头：注释 / CDATA / DOCTYPE，返回新下标 */
  parseBang(i) {
    const s = this.s;
    if (s.startsWith('!--', i)) {
      let end = s.indexOf('-->', i + 3);
      if (end < 0) end = this.n;
      else end += 3;
      return end;
    }
    if (s.startsWith('[CDATA[', i)) {
      // CDATA 内容视为文本（不做实体解码）
      let end = s.indexOf(']]>', i + 7);
      if (end < 0) end = this.n;
      const value = s.slice(i + 7, end);
      if (value !== '') {
        this.pending += value;
        this.hasPending = true;
      }
      return end < this.n ? end + 3 : end;
    }
    // DOCTYPE 或其它声明：内部 DTD 可能带 [ ... ]，方括号内不能靠 '>' 收尾
    let p = i;
    let depth = 0;
    while (p < this.n) {
      const c = s[p];
      if (c === '[') depth++;
      else if (c === ']') {
        if (depth > 0) depth--;
      } else if (c === '>' && depth === 0) return p + 1;
      p++;
    }
    return this.n;
  }

  /** `<` 之后的处理；返回新下标 */
  parseTag(i) {
    const s = this.s;
    const c = s[i];
    if (c === '!') return this.parseBang(i + 1);
    if (c === '?') {
      // <?xml ...?> / <?php ... ?> / 无收尾的 <?xml（IE 里的 XHTML 会这么写）
      let end = s.indexOf('?>', i + 1);
      if (end < 0) {
        end = s.indexOf('>', i + 1);
        return end < 0 ? this.n : end + 1;
      }
      return end + 2;
    }
    if (c === '/') {
      let j = i + 1;
      const nameStart = j;
      while (j < this.n && !NAME_STOP.has(s[j])) j++;
      const name = s.slice(nameStart, j);
      const gt = s.indexOf('>', j);
      const next = gt < 0 ? this.n : gt + 1;
      this.closeTag(name);
      return next;
    }
    // 开标签
    const nameStart = i;
    let j = i;
    while (j < this.n && !NAME_STOP.has(s[j])) j++;
    const rawName = s.slice(nameStart, j);
    if (rawName === '') {
      // 裸 '<'，当普通文本
      this.appendText('<');
      return i;
    }
    const el = node(rawName, {});
    j = this.parseAttrs(el, j);
    if (j >= this.n) {
      // 标签没闭合就 EOF：宽容地当成一个完整元素
      this.flush();
      this.top.children.push(el);
      this.top = el;
      this.stack.push(el);
      return this.n;
    }
    let selfClose = false;
    if (s[j] === '/') {
      selfClose = true;
      j++;
    }
    const gt = this.scanTagEnd(j);
    const next = gt < this.n ? gt + 1 : this.n;
    this.flush();
    this.top.children.push(el);
    if (!selfClose) {
      this.stack.push(el);
      this.top = el;
    }
    return next;
  }

  /** 遇到闭合标签：容错弹栈，不抛异常 */
  closeTag(name) {
    const want = name.toLowerCase();
    this.flush();
    // 从栈顶往下找同名元素；找到就弹到它（含），找不到就忽略这个闭合标签
    for (let d = this.stack.length - 1; d >= 1; d--) {
      if (this.stack[d].name.toLowerCase() === want) {
        this.stack.length = d;
        this.top = this.stack[this.stack.length - 1];
        return;
      }
    }
  }

  run() {
    const s = this.s;
    let i = 0;
    while (i < this.n) {
      const lt = s.indexOf('<', i);
      if (lt < 0) {
        this.appendText(s.slice(i));
        break;
      }
      if (lt > i) this.appendText(s.slice(i, lt));
      i = this.parseTag(lt + 1);
      if (i <= lt) i = lt + 1; // 保险：绝不原地踏步
    }
    this.flush();
    return this.root;
  }
}

/**
 * 一次性回填 text / allText（自底向上，显式栈 + phase 状态机，避免深树递归爆栈）。
 *
 * text    = 直接文本子节点拼接（不递归进子元素）
 * allText = children 顺序递归拼接，因此 <p>甲<em>乙</em>丙</p> → "甲乙丙"
 *
 * 曾经的 bug：用 `el.__done` 当「已处理」标记，处理完又 delete 掉，
 * 于是父节点下一轮扫描时发现标记没了 → 再次入栈 → 死循环（整个进程挂住）。
 * 正确做法是每个栈帧只被访问两次（下降 / 回填），不需要任何标记。
 */
function computeAllText(root) {
  const stack = [{ el: root, phase: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const el = frame.el;
    const kids = el.children;
    if (frame.phase === 0) {
      frame.phase = 1;
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k.name !== '') stack.push({ el: k, phase: 0 });
      }
    } else {
      stack.pop();
      let direct = '';
      let all = '';
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.name === '') {
          direct += k.text;
          all += k.text;
        } else {
          all += k.allText;
        }
      }
      el.text = direct;
      el.allText = all;
    }
  }
}

/**
 * 解析 XML 片段。
 * @param {string} src
 * @returns {{root: XmlNode, nodes: XmlNode[]}} nodes 为顶层**元素**节点数组
 *          （顶层裸文本挂在 root.text 上，不混进 nodes）
 */
export function parseXML(src) {
  const parser = new XmlParser(typeof src === 'string' ? src : String(src == null ? '' : src));
  const root = parser.run();
  computeAllText(root);
  return { root, nodes: root.children.filter(isElem) };
}
