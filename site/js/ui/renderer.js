/* ============================================================
   陪读 · 章节渲染引擎
   ------------------------------------------------------------
   为什么是「整章渲染 → 量高度 → 切成页 → 再截断」：
   锚点加粗会改变字宽，任何基于平均字宽的预估都会算错行数，
   末页被裁掉是这类阅读器最常见的 bug。宁可多花一次布局，也不要预估。

   预计算 pct 的技巧：packPages 跑完之后，每页包含多少字是已知的，
   于是这页对应全书哪个百分比可以直接算出来（不依赖 DOM 滚动位置），
   切章时也就不会临时算一遍。
   ============================================================ */

import { measureBlocks, packPages } from '../core/paginate.js';
import { anchorTokens } from '../core/anchor.js';
import { availableHeight } from '../core/model.js';
import { el, nextFrame } from './dom.js';

/** 语义化标签映射：锚点用 <i> 不是 <b>（锚点是视觉落点，不是强调，别污染读屏） */
const QUOTE = 'blockquote';

/** 可用高度算不出来时的兜底下限（readonly：宁可少塞几行，也不要裁掉末行） */
const MIN_AVAILABLE = 120;

let _padY = null;
/** .page-body 的上下 padding 之和（px）。量不出来（display:none）时返回 0。 */
function pagePadY(body) {
  if (_padY !== null) return _padY;
  const cs = getComputedStyle(body);
  _padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return _padY;
}

export function makePara(para, strength) {
  const tag = para.type === 'quote' ? QUOTE : 'p';
  const node = document.createElement(tag);
  node.dataset.pi = String(para.pi);

  if (para.type === 'img') {
    if (para.src) {
      node.append(el('img', { src: para.src, alt: para.alt || '', loading: 'lazy', decoding: 'async' }));
    } else {
      // 解不出图（从书架重开时没有 zip 字节，或图太大）时**绝不能**留一个
      // 空的 src：空 src 会被浏览器解析成"当前页面地址"，于是去请求
      // /OEBPS/px.png 这种东西，控制台一片 404、正文里一个碎图标。
      node.classList.add('para-img--missing');
      node.append(el('span', { class: 'para-img__ph', text: para.alt || '（插图）' }));
    }
    return node;
  }
  if (para.type && /^h[1-4]$/.test(para.type)) node.dataset.head = para.type.slice(1);

  const text = para.text || '';
  if (!strength || !text) {
    node.textContent = text;
    return node;
  }
  const tokens = anchorTokens(text, strength);
  const frag = document.createDocumentFragment();
  for (const t of tokens) {
    if (t.t === 'head') frag.append(el('i', { class: 'anchor', text: t.v }));
    else frag.append(document.createTextNode(t.v));
  }
  node.append(frag);
  return node;
}

/** 该章正文总字数，用于算进度占比。优先用解析时存下的值。 */
export function chapterChars(chapter, paras) {
  if (chapter.charCount) return chapter.charCount;
  let n = 0;
  for (const p of paras) n += (p.text || '').length;
  chapter.charCount = n; // 顺手缓存回章节对象
  return n;
}

export class ChapterRenderer {
  /**
   * @param {{scroll:HTMLElement, body:HTMLElement, foot?:HTMLElement}} refs
   */
  constructor(refs) {
    this.scroll = refs.scroll;
    this.body = refs.body;
    this.foot = refs.foot || null;
    /** 段落文本缓存：chapterId -> Para[] */
    this.paras = new Map();
    /** 分页结果：chapterId -> {pageStarts, pageChars, available, at} */
    this.layouts = new Map();
    this.token = 0;
    /** 当前 DOM 里切片出来的是哪一章哪一页；用于跳过重复绘制 */
    this.slicedChapter = null;
    this.slicedPage = -1;
    /** 当前切片在整章 paragraphs 数组里的起始下标（全局 pi = slicedFrom + 局部下标） */
    this.slicedFrom = 0;
  }

  /**
   * 每页可用高度（内容盒，px）。
   *
   * 三处必须一起扣干净，任何一处漏掉都会「多塞一段 → 末页被裁」：
   *  1. `.page-scroll` 的 clientHeight —— 滚动容器；页脚条在它外面，不用再减。
   *  2. `.page-body` 的上下 padding —— offsetTop 相对 offsetParent 的 padding edge，
   *     这段 padding 量不出来（paginate.js 已知坑 #5），必须从可用高度里扣。
   *  3. 浮点容差 —— 由 packPages 的 EPS 负责，这里不重复扣。
   *
   * @returns {number} px；阅读视图尚未布局（隐藏/未挂载）时退回 MIN_AVAILABLE
   */
  available() {
    const h = this.scroll.clientHeight;
    if (!h) return MIN_AVAILABLE; // display:none 或还没布局
    try {
      return availableHeight(h, pagePadY(this.body));
    } catch (err) {
      // 容器太矮（还没布局完）。给下限而不是抛错：调用方在 nextFrame 之后才量，
      // 偶尔撞上一次不该让整次渲染失败。
      console.warn('[renderer] 可用高度不足，暂用下限', err.message);
      return MIN_AVAILABLE;
    }
  }

  /** 排版参数指纹：变了就必须重新测量 */
  fingerprint() {
    const s = document.querySelector('html');
    return [
      getComputedStyle(this.body).fontSize,
      getComputedStyle(this.body).lineHeight,
      getComputedStyle(this.body).fontFamily,
      getComputedStyle(this.body).getPropertyValue('--para-gap'),
      this.body.style.maxWidth || getComputedStyle(this.body).maxWidth,
      this.available().toFixed(0),
    ].join('|');
  }

  /**
   * 完整布局一章：渲染全章 → 测量 → 分页 → 截断到指定页。
   * @param {import('../core/model.js').Chapter} chapter
   * @param {import('../core/model.js').Para[]} paras
   * @param {number} strength
   * @param {{page?:number, targetPi?:number, toEnd?:boolean}} where
   * @returns {Promise<{pageStarts:number[], pageChars:number[], page:number}>}
   */
  async layout(chapter, paras, strength, where = {}) {
    const token = ++this.token;
    const cached = this.layouts.get(chapter.id);
    const fp = this.fingerprint();

    let page, pageStarts, pageChars;
    if (cached && cached.fp === fp) {
      // 分页结果可复用，但 DOM 里可能只剩上一页的内容，必须重绘全章再切
      pageStarts = cached.pageStarts;
      pageChars = cached.pageChars;
      page = this.resolvePage(pageStarts, where, pageChars);
      await this.paint(paras, strength);
      if (token !== this.token) return null;
      this.paintPage(chapter.id, page, pageStarts, strength);
      return { pageStarts, pageChars, page };
    }

    /* ---- 整章渲染 ---- */
    // 用 paint() 而不是自己拼一遍：它会顺手把 this.allNodes（整章节点）
    // 存下来，切页时靠它切片。两处各拼一遍迟早会漂移。
    await this.paint(paras, strength);
    if (token !== this.token) return null;

    /* ---- 测量 + 分页 ----
       ★ 这里必须防「容器还没量出来」的退化情形。
       症状：`.page-scroll` 的 clientHeight 是 0（阅读视图刚从 display:none
       变成可见的那一两帧就是这样，移动端 Safari 会把布局推迟一帧），
       于是 available 退回 MIN_AVAILABLE=120，而每个块的高度量出来都是 0
       （节点自己也没布局）—— 一整章被当成一页装得下，页脚永远是 1/1，
       然后整章内容全塞进 DOM 里靠滚动看。
       这个结果还会被缓存下来（指纹拿 0 和 120 拼出来的），之后不再重算。
       所以：量到 0 高度就不认，等真正可见了再量一次，最多重试 4 次。 */
    let blocks = [];
    let available = 0;
    let nodes = [];
    let degenerate = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      nodes = [...this.body.children];
      // host 必须给 .page-body 本身：offsetTop 是相对 offsetParent 的 padding edge 的，
      // 不给 host 就会拿 `p → .page-body` 这一跳的偏移去和 `.page-scroll` 的坐标系混用。
      blocks = measureBlocks(nodes, { host: this.body });
      available = this.available();
      const measured = blocks.reduce((a, b) => a + b, 0);
      // 两种退化都要重试：容器本身还没高度（clientHeight 0），
      // 或者容器有高度但块全量成 0（节点还没参与布局）。
      degenerate = nodes.length > 0 && (this.scroll.clientHeight <= 0 || measured < 1);
      if (!degenerate) break;
      console.warn(
        `[renderer] 第 ${attempt + 1} 次测量不可用（容器高 ${this.scroll.clientHeight}px、块高合计 ${Math.round(measured)}px），再等一帧`
      );
      await nextFrame();
      if (token !== this.token) return null;
    }

    // 重试完了还是量不出来：说明阅读视图此刻根本不可见（比如打开书的同时
    // 又切回了书架）。这种情况下**绝不能把结果缓存下来** —— 一缓存就会
    // 留下一份"整章一页"的错误分页，之后每次翻页都拿它，除非用户改设置。
    // 宁可这次先不切页（整章先铺出去，肉眼可见但它至少不是错的），
    // 等真正可见时由 relayout 重新量。
    if (degenerate) {
      console.warn('[renderer] 容器不可见，本次跳过分页（不缓存），等可见后重排');
      this.lastDiag = {
        chapterId: chapter.id, paras: paras.length, nodes: nodes.length,
        available: Math.round(available), scrollH: this.scroll.clientHeight,
        padY: pagePadY(this.body), measured: 0, blocks: [], pages: 1,
        pageStarts: [0], heights: [], fp, degenerate: true, at: Date.now(),
      };
      this.paintPage(chapter.id, 0, [0], strength);
      return { pageStarts: [0], pageChars: [paras.reduce((a, p) => a + (p.text || '').length, 0)], page: 0, degenerate: true };
    }

    const { pageStarts: starts, pageHeights } = packPages(blocks, available);

    // 留一份"这次布局量到了什么"的现场记录。
    // 「这一章明明很长，却只分出一页」这类问题，看返回值是看不出来的 ——
    // 必须知道可用高度、块数、块高合计分别是多少。tools/smoke.mjs 会读它。
    this.lastDiag = {
      chapterId: chapter.id,
      paras: paras.length,
      nodes: nodes.length,
      available: Math.round(available),
      scrollH: this.scroll.clientHeight,
      padY: pagePadY(this.body),
      measured: Math.round(blocks.reduce((a, b) => a + b, 0)),
      blocks: blocks.map((b) => Math.round(b)),
      pages: starts.length,
      pageStarts: starts,
      heights: pageHeights.map((h) => Math.round(h)),
      fp,
      at: Date.now(),
    };

    /* ---- 每页字数（用于算进度，不依赖滚动位置）----
       ⚠ 名字不能叫 pageChars：它是一个 let 变量，后面那个 const pageChars
       也在同一个函数作用域里 —— 同一作用域里 let + const 重名会直接
       抛 SyntaxError，整份 renderer.js 都加载不了（这个错连累到
       app.js / reader.js，因为它们是它的下游）。 */
    const charsPerPage = new Array(starts.length).fill(0);
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i];
      const to = i + 1 < starts.length ? starts[i + 1] : paras.length;
      for (let k = from; k < to; k++) charsPerPage[i] += (paras[k]?.text || '').length;
    }

    this.layouts.set(chapter.id, { pageStarts: starts, pageChars: charsPerPage, pageHeights, fp, at: Date.now() });

    page = this.resolvePage(starts, where, charsPerPage);
    this.paintPage(chapter.id, page, starts, strength);
    return { pageStarts: starts, pageChars: charsPerPage, page };
  }

  /** 把 where 描述解析成页下标 */
  resolvePage(pageStarts, where, pageChars) {
    const last = pageStarts.length - 1;
    if (where.toEnd) return last;
    if (typeof where.page === 'number') return Math.max(0, Math.min(last, where.page));
    if (where.targetPi != null) {
      if (where.targetPi >= 1e8) return last;
      for (let i = last; i >= 0; i--) if (pageStarts[i] <= where.targetPi) return i;
    }
    // 没指定就按字数百分比还原（用户上次读到 43%，就回到 43% 那一页）
    if (where.ratio > 0) {
      const total = pageChars.reduce((a, b) => a + b, 0) || 1;
      let acc = 0;
      for (let i = 0; i < pageChars.length; i++) {
        acc += pageChars[i];
        if (acc / total >= where.ratio) return i;
      }
      return last;
    }
    return 0;
  }

  /** 渲染全章（用于需要重新测量/重新分页时） */
  async paint(paras, strength) {
    const frag = document.createDocumentFragment();
    for (const p of paras) frag.append(makePara(p, strength));
    // ★ 必须留住整章的节点数组。切页是「从全章里取一段」，而 DOM 里
    //   平时只剩当前页那一段 —— 如果拿 `[...this.body.children]` 去切片，
    //   第二次切页就会在"已经被切过的 DOM"上再切一次，索引全都越界，
    //   结果是空白页（这个 bug 的表现就是翻到第 2 页之后整页没字）。
    this.allNodes = [...frag.children];
    this.body.replaceChildren(frag);
    this.body.dataset.strength = String(strength || 0);
    await nextFrame();
  }

  /**
   * 只留第 page 页的段落。
   * 关键优化：DOM 里如果已经是这一章这一页，什么都不做 ——
   * 没有这个判断的话，切到上一章的末尾页要把整章渲染两遍。
   */
  paintPage(chapterId, page, pageStarts, strength) {
    if (this.slicedChapter === chapterId && this.slicedPage === page && this.body.childElementCount) {
      this.scroll.scrollTop = 0;
      return;
    }
    // 全章节点优先取 paint() 存下的那份；没有（比如外部直接构造）才退回读 DOM
    const all = this.allNodes && this.allNodes.length ? this.allNodes : [...this.body.children];
    const from = pageStarts[page] ?? 0;
    const to = page + 1 < pageStarts.length ? pageStarts[page + 1] : all.length;
    this.body.replaceChildren(...all.slice(from, to));
    this.body.dataset.strength = String(strength || 0);
    this.scroll.scrollTop = 0;
    this.slicedChapter = chapterId;
    this.slicedPage = page;
    this.slicedFrom = from;
  }

  /**
   * 当前页渲染出来的段落节点，带**整章全局下标** pi。
   *
   * 为什么需要它：DOM 里只剩当前页的段落（局部下标从 0 开始），
   * 但批注/弹幕/阅读位置都按整章 pi 记账。这个映射是两者之间唯一的桥。
   *
   * @returns {Array<{pi:number, el:HTMLElement}>}
   */
  currentNodes() {
    const out = [];
    const kids = this.body.children;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      const local = Number(node.dataset && node.dataset.pi);
      out.push({ pi: Number.isFinite(local) ? local : this.slicedFrom + i, el: node });
    }
    return out;
  }

  /** 取整章第 pi 段的节点；不在当前页（已从 DOM 摘掉）时返回 null。 */
  nodeAt(pi) {
    const kids = this.body.children;
    const local = Number(pi) - this.slicedFrom;
    if (local < 0 || local >= kids.length) return null;
    return kids[local];
  }

  /** 分页结果的只读访问 */
  layoutOf(chapterId) {
    return this.layouts.get(chapterId);
  }

  invalidate() {
    this.layouts.clear();
    // padding 可能随设备档位（phone/tablet/desktop）变化，指纹量不出它，
    // 所以在这里一并清掉缓存，下次重新从 computed style 读。
    _padY = null;
    this.slicedChapter = null;
    this.slicedPage = -1;
    this.slicedFrom = 0;
    // 整章节点也要丢：换了字号/字体之后旧的锚点节点已经过时了
    this.allNodes = null;
  }
}
