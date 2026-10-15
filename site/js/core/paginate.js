// 陪读 — 测量式分页（core/paginate.js）
//
// ─────────────────────────────────────────────────────────────────────────────
// 为什么不用 CSS multi-column
// ─────────────────────────────────────────────────────────────────────────────
// 我们本来想用 `column-width` + `translateX` 做翻页。放弃了：Safari 在 `100dvh`
// 容器里的分栏高度、滚动条预留、`column-fill` 行为都不可靠，会在 iOS 上崩版
// （分栏高度按 vh 算而不是容器高度算，最后一栏被裁掉且拿不到任何回调）。
// 改用测量式分页：**整章先完整渲染 → 量出每段真实高度和段间距 → 贪心装箱切成页 →
// 只渲染当前页**。
//
// ─────────────────────────────────────────────────────────────────────────────
// 两层结构（这是关键设计）
// ─────────────────────────────────────────────────────────────────────────────
//   packPages(blocks, available)   纯数学层。不碰 DOM，Node 里可完整单测。
//   measureBlocks(nodes, {host})   DOM 测量层。把节点量成 blocks。
//   paginate(paras, {host, available})  便捷组合 = measureBlocks + packPages。
// 分开的理由：分页的**规则**（贪心、超高独占、空块占位）最容易错，而它跟 DOM 无关；
// 把规则留在一个纯函数里，就能用几百组随机数据把不变量钉死，不需要浏览器。
//
// ─────────────────────────────────────────────────────────────────────────────
// 分页层的已知坑（踩过，别再踩）
// ─────────────────────────────────────────────────────────────────────────────
//  1. **必须在最终排版样式下测量**。锚点加粗会改变字宽 → 行数变 → 高度变。
//     正确的顺序是：渲染整章 → 套用锚点（font-weight）→ 再测量 → 再分页。
//     先测量后套锚点，翻页后行数变化会直接溢出，末页被裁。
//  2. **任何排版参数变化都必须重新测量并重新分页**，不能复用旧结果：
//     字号 / 行高 / 段距 / 行宽(measure) / 字体 / 锚点强度 / 主题换字体时。
//     `blocks` 与分页结果都不缓存跨参数的副本。
//  3. **视口高度变化也要重算**：iOS 地址栏伸缩、iPad 旋转、分屏。
//     容器高度必须用 `100dvh`（不是 `100vh`）算，且用 PAGINATION.relayoutThreshold
//     过滤掉地址栏伸缩时的抖动重排。重算时要重新渲染整章再测量——
//     只有当前页在 DOM 里的时候是量不出整章的。
//  4. **外边距折叠会让 offsetTop 取不到块间距**：段落用 `margin-bottom` 定段距时，
//     相邻两个 offsetTop 的差里并不包含被折叠掉的那部分。所以 `blocks` 是
//     「这一块 + 它与下一块之间的间距」，由相邻 offsetTop 相减得到，
//     **绝不能**用各自的 `rect.height` 相加——那样算出来的总高比真实排版矮，
//     贪心装箱就会多塞，最后一页被裁掉。measureBlocks 用的就是这个差值法。
//  5. **容器的 padding 量不出来**：offsetTop 相对 offsetParent 的 padding edge，
//     所以容器自身的上下 padding 必须从 available 里扣掉（用 model.availableHeight）。
//     另外容器要建立 BFC（`overflow:hidden` 或 `display:flow-root`）阻止外边距外泄，
//     否则首块 margin-top 会跑到容器外面，`blocks[0]` 不是块的完整高度。
//
// 模块约定：本文件是 core 里**唯一允许碰 DOM 度量**的模块（CONTRACT 第 0 节）。
// 除了 offsetTop / offsetParent / getBoundingClientRect / getComputedStyle，
// 不做任何别的事；packPages 完全不碰 DOM。

import { PAGINATION } from './model.js';

/** 每页实际内容高度允许超出 available 的浮点容差（px）。 */
const EPS = PAGINATION.epsilon;

/**
 * 纯数学层：贪心装箱。不碰 DOM，无副作用，输入不被修改。
 *
 * 规则：
 *  - 从 `pageStarts` 当前位置开始累加 `blocks[i]`，加到放不下为止；下一块作为新页起点。
 *  - **单块高度 > available 时该块独占一页**（不切分段落，宁可让用户滚动；
 *    同样计入 pageHeights，且 pageHeights 里它就是那个 > available 的值）。
 *  - **空段落（高度 0）也要占一个下标**：它会被并入当前页，pi 的下标稳定性由
 *    调用方按「blocks 与 paras 一一对应」保证。
 *  - `blocks` 为空 → `{pageStarts:[0], pageHeights:[0]}`（永远至少一页）。
 *  - `pageStarts` 严格递增且 `pageStarts[0] === 0`。
 *  - 不变式：把所有页的「下标区间」按顺序拼起来，恰好覆盖 `0..blocks.length-1`，
 *    不重不漏（`pageHeights` 是每页内容高，与区间一一对应）。
 *
 * 复杂度 O(n)，一次遍历。
 *
 * @param {number[]} blocks   每个块的高度 px（已含它与下一块之间的间距，见 measureBlocks）
 * @param {number} available  每页可用高度 px，必须 > 0
 * @returns {{pageStarts:number[], pageHeights:number[]}}
 */
export function packPages(blocks, available) {
  if (!Array.isArray(blocks)) throw new TypeError('blocks 必须是数组');
  const avail = Number(available);
  if (!(avail > 0)) throw new Error('可用高度必须为正数');

  const pageStarts = [0];
  const pageHeights = [];
  if (blocks.length === 0) {
    // 永远至少一页：调用方据此渲染空页，不至于把 reader 搞成空白。
    pageHeights.push(0);
    return { pageStarts, pageHeights };
  }

  let start = 0;
  let acc = 0;

  for (let i = 0; i < blocks.length; i++) {
    const h = Number(blocks[i]);
    if (!Number.isFinite(h)) throw new TypeError('blocks[' + i + '] 不是有限数');
    if (h < PAGINATION.negativeSlack) {
      // 负高度只可能来自坏测量（offsetTop 不单调 / 在 transform 或动画中途测的）。
      // 静默吞掉会让分页结果永远偏小，不如直接炸出来。
      throw new Error('blocks[' + i + '] 为负（' + h + '）：测量期间发生了布局变动，请重新渲染后再测');
    }
    // 贪心：放不下就另起一页。超高块单独判断——
    // i === start 时无论多高都必须落进这一页，否则死循环（也是「超高独占一页」）。
    if (i > start && acc + h > avail + EPS) {
      pageHeights.push(acc);
      pageStarts.push(i);
      start = i;
      acc = 0;
    }
    acc += h;
  }
  pageHeights.push(acc);
  return { pageStarts, pageHeights };
}

/**
 * 把 `measureBlocks` 的结果按 packPages 的区间规则还原成「每页覆盖的下标区间」。
 * 纯函数，给渲染层和测试用；页归属拼接后必须恰好覆盖 0..n-1。
 *
 * @param {number[]} pageStarts
 * @param {number} n 块总数
 * @returns {Array<{start:number, end:number}>} end 为**开区间**上界
 */
export function pageRanges(pageStarts, n) {
  const out = [];
  for (let p = 0; p < pageStarts.length; p++) {
    const start = pageStarts[p];
    const end = p + 1 < pageStarts.length ? pageStarts[p + 1] : n;
    out.push({ start, end });
  }
  return out;
}

/** 取出节点元素。允许直接传 Element，也允许传 `{el}` 包装（如 {el, para} 的渲染记录）。 */
function elemOf(node) {
  if (!node) return null;
  if (node.nodeType === 1) return node;
  if (node.el && node.el.nodeType === 1) return node.el;
  return null;
}

/**
 * 算一个节点相对 host 的累计偏移。
 *
 * ★ 这里有一条踩过坑的规则：**优先走 offsetParent 链，走不到 host 就退回
 *   逐层跟 parentElement 累加 offsetTop。**
 *
 *   为什么必须留这个退路：`.page-body` 默认是 `position: static`，
 *   而 static 元素**不是 offsetParent** —— 段落的 offsetParent 会直接跳到
 *   `#paper`（relative），于是 offsetParent 链里根本不会出现 host，
 *   `reached` 永远是 false，所有节点被当成 display:none 记 0 高度，
 *   整章量出来 0px，被当成「一页装得下」，页脚永远显示 1/1、正文靠滚动看。
 *   这个失败是**静默**的：没有报错，只有一页。
 *   （发现它的方式是 tools/smoke.mjs 把真 DOM 的 offsetParent 链打印出来：
 *    `p → div#paper → div#pages → main#main → body`，中间的 .page-body 不见了。）
 *
 *   parentElement 链是 DOM 结构而不是布局结构，host 一定在里面，所以退路一定
 *   能走到；累加的 offsetTop 也是布局值，与 offsetParent 无关，所以数值是对的。
 *   只有两条路都走不到（真正的 display:none / 游离节点）才判定「不参与布局」。
 *
 * `reached` 的语义是「链走到了 host 本身」。节点**就是** host 时也算 reached
 * （offsetTop 相对它自己是 0）。`offsetTop !== 0` 的节点即使偏移为 0 也不能提前返回，
 * 所以这里用显式的 reached 标志，不靠数值判断。
 *
 * @returns {{top:number, reached:boolean, via:'offsetParent'|'parentElement'|'root'|'none'}}
 */
function offsetChain(node, host) {
  if (!host) {
    // 没给 host：走到链顶端即可，调用方自己负责基准
    let top = 0;
    let cur = node;
    for (let guard = 0; cur && guard < 256; guard++) {
      top += Number(cur.offsetTop) || 0;
      cur = cur.offsetParent;
    }
    return { top, reached: true, via: 'root' };
  }

  // 第一选择：offsetParent 链（布局树的真实偏移）
  let top = 0;
  let cur = node;
  // 上限 64 层：真实的正文嵌套不会这么深，超了说明 offsetParent 有环（病态 DOM），
  // 宁可停下来也不要卡死主线程。
  for (let guard = 0; cur && guard < 64; guard++) {
    if (cur === host) return { top, reached: true, via: 'offsetParent' };
    top += Number(cur.offsetTop) || 0;
    cur = cur.offsetParent;
  }

  // 退路：DOM 父子链（host 是 static 时只能走这条）
  top = 0;
  cur = node;
  for (let guard = 0; cur && guard < 256; guard++) {
    if (cur === host) return { top, reached: true, via: 'parentElement' };
    top += Number(cur.offsetTop) || 0;
    cur = cur.parentElement;
  }
  return { top: 0, reached: false, via: 'none' };
}

/**
 * DOM 测量层：把已渲染的节点量成 `blocks`。
 *
 * **blocks[i] = top[i+1] - top[i]，最后一块用 `getBoundingClientRect().height`。**
 * 差值法把「块自身高度」和「它与下一块之间的间距（含塌陷后的外边距）」合成一个数，
 * 正好是贪心装箱需要的量；用 `rect.height` 逐个相加会漏掉折叠掉的间距，
 * 结果整体偏小，分页会多塞段落、末页被裁。
 *
 * 前提（调用方负责）：
 *  - host 已按**最终排版样式**渲染（字号/行高/行宽/锚点都套用完毕），见文件头「已知坑 #1」。
 *  - host 建立了 BFC（`overflow:hidden` 或 `display:flow-root`）。
 *    否则第一个块的内侧 `margin-top` 会折叠到 host 外面，`offsetTop` 反映不出这段 margin，
 *    `blocks[0]` 会少算一块高度 → 第一页多塞 → 末页被裁。
 *  - host 不在 transform / 动画 / 缩放中途（`rect.height` 会被 transform 一起缩放，
 *    而 `offsetTop` 是布局值不会被缩放，两者混用会得到自相矛盾的结果）。
 *  - 测量期间布局稳定：不要在测量和下一次读取之间改 DOM，否则 offsetTop 会不一致
 *    （packPages 检测到负高度会抛错，而不是静默给出偏小的结果）。
 *
 * 行为：
 *  - `display:none` 的节点高度记 0，但**仍占一个下标**（保持 pi 稳定）；
 *    它不参与差值，所以在它位置上「消失」的间距会算进上一个可见块。
 *  - 返回数组长度恒等于输入节点数（含 null / 非法节点，记 0 占位）。
 *  - 所有返回值之和 === host 的内容高度（含末尾 margin），也就是「整章高」。
 *
 * @param {Array<HTMLElement|{el:HTMLElement}>} nodes 顺序 = 段落顺序
 * @param {{host?: HTMLElement}} [opt] host：测量基准容器。给了就要求节点在它内部
 * @returns {number[]} 每个节点的高度 px（最后一个块是自身 rect 高度）
 */
export function measureBlocks(nodes, opt) {
  if (!Array.isArray(nodes)) throw new TypeError('nodes 必须是数组');
  if (nodes.length === 0) return [];
  const host = (opt && opt.host) || null;

  const tops = new Array(nodes.length);
  const els = new Array(nodes.length);
  /** @type {boolean[]} 不参与布局（display:none / 游离节点 / 非法输入） */
  const hidden = new Array(nodes.length).fill(true);

  // 第一遍：算每个节点相对 host 的累计 offsetTop，同时判定它是否可见。
  for (let i = 0; i < nodes.length; i++) {
    const wrap = nodes[i];
    const el = elemOf(wrap);
    els[i] = el;
    if (!el) { tops[i] = 0; continue; }

    const walked = offsetChain(el, host);
    // 走不到 host 的只有两种：display:none（offsetParent === null），
    // 或者本来就没连进文档。两者都按「不参与布局」处理（高度 0、占一个下标），
    // 而不是抛错——测量期渲染层经常留着还没上屏的节点。
    // 同一棵游离树里的节点也因此不会被误判成「在 host 里」：它们连不到 host。
    if (walked.reached) {
      tops[i] = walked.top;
      hidden[i] = false;
    } else {
      tops[i] = null;
    }
  }

  // 第二遍：只在**相邻的可见块之间**取差。
  //
  // ⚠ 两个真实踩过的坑，记下来免得再踩：
  //  1) 不能先把隐藏块的 top「投影」到上一个可见块，再统一做差。
  //     投影后可见块 B 的差值变成 `topNext - topB`，而 topB 是 B 自己的顶边，
  //     于是 B **丢掉了它后面那段间距**：
  //       B(高 100) + 段间距 30 + 隐藏块 + C  →  投影法给 blocks[B] = 100（应为 130）。
  //     一个隐藏块会让它后面每个块的归属高度连锁错位，整章总高偏小 → 末页被裁。
  //  2) 也不能「把锚点初始化成第一个可见块的 top」——那样 blocks[0] = top0 - top0 = 0，
  //     首段高度被吃掉，第一页会多塞一段、末页被裁（同一个 bug 的另一种写法）。
  //
  // 正确形式是**前向差值**：每个可见块的高度 = 下一个可见块的 top − 自己的 top。
  // 隐藏块在差值里自然「消失」，它前后的间距留在**上一个块**头上。
  // 最后一个可见块没有「下一个」可比，用 rect 高度，并且取
  // `max(rect, 到末尾隐藏块的距离)`，兜住末尾 margin 折叠到 host 外面的情况。
  // 不变式：所有 block 之和 === host 的内容高度。
  const blocks = new Array(nodes.length).fill(0);
  let lastVisible = -1;
  let prevIdx = -1; // 上一个可见块
  for (let i = 0; i < nodes.length; i++) {
    if (hidden[i]) continue; // 高度保持 0，且不覆盖任何差值
    if (prevIdx >= 0) blocks[prevIdx] = tops[i] - tops[prevIdx];
    prevIdx = i;
    lastVisible = i;
  }

  if (lastVisible >= 0) {
    const el = els[lastVisible];
    // 到末尾隐藏块的距离（没有隐藏尾块时就是 0）
    let tailSpan = 0;
    for (let i = lastVisible + 1; i < nodes.length; i++) {
      if (!hidden[i]) { tailSpan = tops[i] - tops[lastVisible]; break; }
    }
    let h = tailSpan;
    if (el && el.getBoundingClientRect) {
      const rect = el.getBoundingClientRect();
      const rectH = Number(rect && rect.height) || 0;
      // rectH 更大：说明这段的末尾 margin 折叠到 host 外面了，差值量不到它；
      // tailSpan 更大：末尾还有隐藏块，它们与最后一块之间的间距差值量得到。
      if (rectH > h) h = rectH;
    }
    blocks[lastVisible] = h;
  }
  return blocks;
}

/**
 * 便捷组合：测量 + 装箱。
 *
 * ⚠ `measureBlocks` 只看不改——本函数不会改动 host 的内容。
 * 调用方要保证 host 里此刻**渲染的是整章**（这是测量的前提），分页完成后再切成单页渲染。
 *
 * @param {Array} paras 本章段落（只用长度，内容由调用方渲染）
 * @param {{host:HTMLElement, available:number, nodes?:Array}} opt
 *        host      已渲染整章的容器
 *        available 每页可用高度 px（用 model.availableHeight 从 clientHeight 算，别手拍）
 *        nodes     实际渲染出来的节点数组；缺省时取 host.children
 * @returns {{pages:number[], heights:number[], blocks:number[], starts:number[]}}
 *          pages   = 每页起始段落下标（= packPages 的 pageStarts，CONTRACT 第 4 节）
 *          heights = 每页实际内容高度
 *          blocks  = 本次测量结果（调试/测试用，**不要跨排版参数复用**）
 *          starts  = pageStarts 的别名，方便与 packPages 的输出直接对照
 */
export function paginate(paras, opt) {
  const o = opt || {};
  const host = o.host;
  if (!host) throw new Error('paginate 需要一个 host 容器');
  // host.children 是 HTMLCollection（有 length、可下标取值，但不是数组），
  // 必须显式转成数组 —— measureBlocks 只收数组，直接透传会抛 TypeError。
  // 两种调用形态都支持：显式传 nodes，或让本函数从 host 里自己取。
  const nodes = o.nodes || Array.prototype.slice.call(host.children || []);
  // 有段落却量到 0 个节点，说明调用方还没把整章渲染进 host（或 host 传错了）。
  // ⚠ 这里必须抛错而不是返回「只有一页空页」：静默的成功比失败更贵 ——
  //   渲染层会照着一页空内容渲染，用户看到一本空书，而没有任何线索指向原因。
  if (nodes.length === 0 && paras && paras.length > 0) {
    throw new Error('paginate: host 里没有可测量的节点，请先把整章渲染进 host');
  }
  // available 先校验：它是调用方最容易搞错的一个（忘了扣 padding、传了 undefined），
  // 而且校验放在测量之前就不必白渲染一次。错误文案与 packPages 保持一致。
  if (!(Number(o.available) > 0)) throw new Error('可用高度必须为正数');
  // 只测一次：measureBlocks 会读 offsetTop，而读操作可能触发一次布局，
  // 调两次除了白花钱，还可能拿到两次不一致的结果（中间夹着别处的 DOM 改动）。
  const blocks = measureBlocks(nodes, { host });
  const { pageStarts, pageHeights } = packPages(blocks, o.available);
  return { pages: pageStarts, heights: pageHeights, blocks, starts: pageStarts };
}

/**
 * 视口/容器高度变化是否值得重排。iOS 地址栏伸缩会把 dvh 抖 ±几十 px，
 * 每次都重排会闪；超过 relayoutThreshold 才认为是真的换了布局。
 * 纯函数，UI 层在 resize / visualViewport 回调里用它挡抖动。
 *
 * @param {number} prevH 上次测量时的可用高度
 * @param {number} nextH 这次的可用高度
 * @returns {boolean}
 */
export function needsRelayout(prevH, nextH) {
  return Math.abs((Number(nextH) || 0) - (Number(prevH) || 0)) >= PAGINATION.relayoutThreshold;
}
