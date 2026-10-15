// test/paginate.test.js — 分页纯逻辑层 + 测量层的单元测试
//
// packPages 是纯函数，这里用多组随机数据把它的不变量钉死。
// measureBlocks 需要一个假 DOM：**不引入 jsdom**（零依赖约束），
// 自己写一个极简假元素对象，只提供 offsetTop / offsetParent /
// getBoundingClientRect / style 这几个真实代码用到的接口。
//
// ⚠ 假 DOM 的价值边界见文件末尾「measureBlocks 的假 DOM 测不到什么」一节注释。

import test from 'node:test';
import assert from 'node:assert/strict';
import { packPages, measureBlocks, paginate, pageRanges, needsRelayout } from '../site/js/core/paginate.js';
import { PAGINATION } from '../site/js/core/model.js';

// ─────────────────────────────────────────────────────────────────────────────
// 极简假 DOM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 造一个假元素。
 * @param {Object} [o]
 * @param {number} [o.offsetTop]   相对 offsetParent 的顶部（真实 DOM 里是整数）
 * @param {number} [o.height]      getBoundingClientRect().height
 * @param {Object} [o.offsetParent]
 */
function fakeEl(o) {
  const opt = o || {};
  return {
    nodeType: 1,
    offsetTop: opt.offsetTop === undefined ? 0 : opt.offsetTop,
    offsetParent: opt.offsetParent === undefined ? null : opt.offsetParent,
    isConnected: true,
    style: {},
    getBoundingClientRect() {
      return { top: this.offsetTop, left: 0, width: 300, height: opt.height === undefined ? 0 : opt.height };
    },
  };
}

/** 一列平级块：block 0 高 h0 / 与下一块间距 gap0，block 1 高 h1 …… 最后一个块给 rect 高度。 */
function flatBlocks(rows) {
  const host = fakeEl({ offsetTop: 0 });
  const nodes = [];
  const tops = [];
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    nodes.push(fakeEl({ offsetTop: y, height: rows[i].h, offsetParent: host }));
    tops.push(y);
    // 下一块的起点 = 这一块的高度 + 间距（间距由 CSS margin/line-height 产生，
    // 折叠后的结果就体现在这个差值上）
    y += rows[i].h + (rows[i].gap === undefined ? 0 : rows[i].gap);
  }
  return { host, nodes, tops };
}

/** 把「页下标区间」拼起来，得到一个长 n、每项是页号的数组；用于不变量检查。 */
function pageOfEach(n, pageStarts) {
  const ranges = pageRanges(pageStarts, n);
  const arr = new Array(n).fill(-1);
  for (let p = 0; p < ranges.length; p++) {
    for (let i = ranges[p].start; i < ranges[p].end; i++) {
      if (arr[i] !== -1) throw new Error('下标 ' + i + ' 被两页同时覆盖');
      arr[i] = p;
    }
  }
  for (let i = 0; i < n; i++) {
    if (arr[i] === -1) throw new Error('下标 ' + i + ' 没有任何页覆盖（被丢了）');
  }
  return arr;
}

/** 确定性伪随机（mulberry32），保证失败可复现——随机测试不能每次跑出不同结果。 */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// packPages
// ─────────────────────────────────────────────────────────────────────────────

test('packPages: 正常装箱（贪心，不跨页塞）', () => {
  const r = packPages([100, 100, 100], 250);
  assert.deepEqual(r.pageStarts, [0, 2]);
  assert.deepEqual(r.pageHeights, [200, 100]);

  // 恰好填满时不分页（边界：acc + h === available 应该放得下）
  const exact = packPages([100, 150], 250);
  assert.deepEqual(exact.pageStarts, [0]);
  assert.deepEqual(exact.pageHeights, [250]);
});

test('packPages: 单块超高独占一页，且计入 pageHeights（不切分段落）', () => {
  const r = packPages([50, 400, 50], 200);
  // 第 0 页：50；第 1 页：400（超高，独占）；第 2 页：50
  assert.deepEqual(r.pageStarts, [0, 1, 2]);
  assert.deepEqual(r.pageHeights, [50, 400, 50]);
  // 超高页的高度必须如实反映 > available，渲染层据此知道要允许页内滚动
  assert.ok(r.pageHeights[1] > 200);

  // 连续两个超高块：各自独占一页，不能挤到同一页
  const two = packPages([300, 300], 200);
  assert.deepEqual(two.pageStarts, [0, 1]);
  assert.deepEqual(two.pageHeights, [300, 300]);

  // 首块超高：单独判断不能死循环（i === start 时必须落进当前页）
  const first = packPages([500, 10, 10], 100);
  assert.deepEqual(first.pageStarts, [0, 1]);
  assert.deepEqual(first.pageHeights, [500, 20]);

  // 尾块超高
  const tail = packPages([10, 10, 500], 100);
  assert.deepEqual(tail.pageStarts, [0, 2]);
  assert.deepEqual(tail.pageHeights, [20, 500]);
});

test('packPages: 空块（高度 0）占下标但不占高度', () => {
  const r = packPages([0], 100);
  assert.deepEqual(r.pageStarts, [0]);
  assert.deepEqual(r.pageHeights, [0]);

  // 夹在中间的 0 高度块跟着当前页走，不会莫名开启新页
  const r2 = packPages([40, 0, 40, 0], 100);
  assert.deepEqual(r2.pageStarts, [0]);
  assert.deepEqual(r2.pageHeights, [80]);
  assert.equal(pageOfEach(4, r2.pageStarts).length, 4);

  // 全是 0 高度：仍然一页装下全部（且必须仍是一页）
  const r3 = packPages([0, 0, 0], 100);
  assert.deepEqual(r3.pageStarts, [0]);
  assert.deepEqual(r3.pageHeights, [0]);

  // 0 高度块紧跟在一个刚好填满的页之后：它应该并进当前页而不是新开页
  const r4 = packPages([100, 0], 100);
  assert.deepEqual(r4.pageStarts, [0]);
  assert.deepEqual(r4.pageHeights, [100]);
});

test('packPages: blocks 为空 → 永远至少一页', () => {
  assert.deepEqual(packPages([], 100), { pageStarts: [0], pageHeights: [0] });
  assert.deepEqual(packPages([], 1), { pageStarts: [0], pageHeights: [0] });
});

test('packPages: available <= 0 抛中文错误', () => {
  assert.throws(() => packPages([1], 0), /可用高度必须为正数/);
  assert.throws(() => packPages([1], -5), /可用高度必须为正数/);
  assert.throws(() => packPages([1], NaN), /可用高度必须为正数/);
  assert.throws(() => packPages([1], undefined), /可用高度必须为正数/);
  // 非数组入参也要明确报错，而不是静默返回空页
  assert.throws(() => packPages(null, 100), TypeError);
});

test('packPages: pageStarts[0] === 0 且严格递增；块数少的退化情况', () => {
  const cases = [[], [10], [0], [10, 10], [1e6]];
  for (let c = 0; c < cases.length; c++) {
    const r = packPages(cases[c], 100);
    assert.equal(r.pageStarts[0], 0, 'blocks=' + JSON.stringify(cases[c]));
    for (let i = 1; i < r.pageStarts.length; i++) {
      assert.ok(r.pageStarts[i] > r.pageStarts[i - 1], 'pageStarts 必须严格递增');
    }
    assert.equal(r.pageStarts.length, r.pageHeights.length, 'starts 与 heights 一一对应');
    if (cases[c].length > 0) {
      assert.ok(r.pageStarts[r.pageStarts.length - 1] < cases[c].length, '末页起点不能越过块数');
    }
  }
});

test('packPages: 不修改入参（纯函数）', () => {
  const blocks = [100, 100, 100];
  const snapshot = blocks.slice();
  packPages(blocks, 250);
  assert.deepEqual(blocks, snapshot);
});

test('packPages: 负高度来自坏测量时抛错，而不是静默算小', () => {
  assert.throws(() => packPages([100, -50], 200), /测量期间发生了布局变动/);
  assert.throws(() => packPages([100, NaN], 200), TypeError);
  // 子像素级的微小负差要容忍（lineHeight 小数 + 整数 offsetTop 会造出来）
  assert.doesNotThrow(() => packPages([100, -0.5], 200));
});

test('packPages: 页归属拼接后恰好覆盖全部下标，不重不漏（200 组随机数据）', () => {
  const rand = rng(20240613);
  for (let iter = 0; iter < 200; iter++) {
    const n = 1 + Math.floor(rand() * 120);            // 1..120 块
    const avail = 40 + Math.floor(rand() * 900);        // 40..940 px
    const blocks = new Array(n);
    for (let i = 0; i < n; i++) {
      const roll = rand();
      if (roll < 0.08) blocks[i] = 0;                                   // 空段落
      else if (roll < 0.16) blocks[i] = avail * (1 + rand() * 2);       // 超高块
      else blocks[i] = Math.round(rand() * avail * 0.9);                // 普通块
    }

    const r = packPages(blocks, avail);
    const tag = 'iter=' + iter + ' n=' + n + ' avail=' + avail;

    // 不变量 1：下标全覆盖、不重不漏
    const owner = pageOfEach(n, r.pageStarts);
    assert.equal(owner.length, n, tag);

    // 不变量 2：页号随下标单调不减
    for (let i = 1; i < n; i++) {
      assert.ok(owner[i] >= owner[i - 1], tag + ' 页号必须单调不减 @' + i);
    }

    // 不变量 3：每页高度 = 该页所有块高度之和
    const ranges = pageRanges(r.pageStarts, n);
    assert.equal(ranges.length, r.pageHeights.length, tag);
    for (let p = 0; p < ranges.length; p++) {
      let sum = 0;
      for (let i = ranges[p].start; i < ranges[p].end; i++) sum += blocks[i];
      assert.ok(Math.abs(sum - r.pageHeights[p]) < 1e-9, tag + ' 第 ' + p + ' 页高度应等于块高之和');
    }

    // 不变量 4（贪心不浪费空间）：第 p+1 页的第一块**必须**就是「加到第 p 页上会溢出」
    // 的那一块 —— 否则贪心还能再塞一块。这条同时钉死了「零高度块的行为」：
    // 零高度块永远不可能开新页（它加到当前页上不会溢出），所以 pageHeights 里
    // 不会出现「刚填满的页 + 空块」这种被拆开的短页。
    //
    // ⚠ 这里有两个看着有理、实际错误的写法，记下来免得再踩：
    //    a) 「页高 + 下一块 > available」——只对首块非零的页成立（本式取 sum = 0 时正确）；
    //    b) 「页内存在某块使其溢出」——错。首块超高独占一页时页内没有溢出块，
    //       用 b) 会把合法的超高页判成「没装满」。
    for (let p = 0; p + 1 < ranges.length; p++) {
      const next = blocks[ranges[p + 1].start];
      assert.ok(
        r.pageHeights[p] + next > avail + PAGINATION.epsilon,
        tag + ' 第 ' + p + ' 页高 ' + r.pageHeights[p] + ' + 下一块 ' + next +
          ' 仍装得下 ' + avail + '，贪心漏塞了'
      );
    }

    // 不变量 5：非末页必须是「紧凑」的——页内除首块外不能有超高块
    // （超高块一定会独占一页，因为 i===start 时直接被接住）
    for (let p = 0; p + 1 < ranges.length; p++) {
      for (let i = ranges[p].start + 1; i < ranges[p].end; i++) {
        assert.ok(blocks[i] <= avail + PAGINATION.epsilon, tag + ' 超标块没独占一页 @' + i);
      }
    }

    // 不变量 6：pageStarts 严格递增且首项为 0
    assert.equal(r.pageStarts[0], 0, tag);
    for (let i = 1; i < r.pageStarts.length; i++) {
      assert.ok(r.pageStarts[i] > r.pageStarts[i - 1], tag);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// measureBlocks（假 DOM）
// ─────────────────────────────────────────────────────────────────────────────

test('measureBlocks: 块间距必须用相邻 offsetTop 之差推算，不能用 rect.height 相加', () => {
  // 场景：第 0 块自身高 100，第 1 块的 offsetTop 是 130 —— 差的 30 就是
  // 第 0 块自己的 margin-bottom 折叠进来之后的真实间距。
  // 如果用 rect.height 相加会得到 100（漏 30），整章高度偏小 → 贪心多塞 → 末页被裁。
  const host = fakeEl({ offsetTop: 0 });
  const a = fakeEl({ offsetTop: 0, height: 100, offsetParent: host });
  const b = fakeEl({ offsetTop: 130, height: 200, offsetParent: host });
  const c = fakeEl({ offsetTop: 360, height: 50, offsetParent: host });

  const blocks = measureBlocks([a, b, c], { host });
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], 130, 'blocks[0] 必须是 130（差值），不是 100（自身高度）');
  assert.equal(blocks[1], 230, 'blocks[1] 必须是 230（差值），不是 200');
  assert.equal(blocks[2], 50, '最后一块没有下一块可比，用 rect 高度');

  // 反向断言：如果实现退化成「高度相加」，blocks[0] 会是 100。这里明确钉死差别。
  assert.notEqual(blocks[0], a.getBoundingClientRect().height);

  // 总高守恒：blocks 之和 === 最后一块底边 − 第一块顶边
  const total = blocks.reduce((s, x) => s + x, 0);
  assert.equal(total, 360 + 50 - 0);
});

test('measureBlocks: 内部 margin-top 折叠到父元素外面时，只有最后一块的 rect 高度能救回来', () => {
  // 这是真实的折叠方向：块内部第一个元素的 margin-top 会折叠到块**外面**，
  // 于是块的 offsetTop 反映不出这段 margin，只能在 rect.height 里看到。
  // 假 DOM 里我们直接把这个事实写成数据：a 的 offsetTop 是 0，但它 rect 高 130。
  const host = fakeEl({ offsetTop: 0 });
  const a = fakeEl({ offsetTop: 0, height: 130, offsetParent: host }); // 100 内容 + 30 塌陷出来的 margin
  const b = fakeEl({ offsetTop: 130, height: 50, offsetParent: host });

  const blocks = measureBlocks([a, b], { host });
  assert.equal(blocks[1], 50);
  // a 在非末尾位置时，它那 30px 已经被算进「与下一块的差值」里，不会被丢
  assert.equal(blocks[0], 130);

  // 但如果 a 是最后一块、且它的 margin-top 被折叠到 host 外面，
  // 那 rect.height 是**唯一**能取到这段 margin 的地方：
  const only = measureBlocks([a], { host });
  assert.equal(only[0], 130, '最后一块必须用 rect.height，否则丢掉折叠出来的 margin');
});

test('measureBlocks: 跨 offsetParent 的嵌套结构用「相对 host 的累计偏移」', () => {
  // host
  //   └ section.offsetTop = 20
  //       ├ p0.offsetTop = 10   （相对 host = 30）
  //       └ p1.offsetTop = 140  （相对 host = 160）
  // p0.offsetTop 与 p1.offsetTop 同属 section，可比；
  // 但如果写成「只读 el.offsetTop」的比较对象是 host，就会算错。
  const host = fakeEl({ offsetTop: 0 });
  const section = fakeEl({ offsetTop: 20, height: 300, offsetParent: host });
  const p0 = fakeEl({ offsetTop: 10, height: 100, offsetParent: section });
  const p1 = fakeEl({ offsetTop: 140, height: 160, offsetParent: section });

  const blocks = measureBlocks([p0, p1], { host });
  assert.equal(blocks[0], 130, 'section 那 20px 偏移必须被算进相对 host 的差里（不是 130−20）');
  assert.equal(blocks[1], 160);

  // 在嵌套链上给 host 明确传入时，节点 → host 的每一层 offsetTop 都要累加
  assert.equal(10 + 20, 30); // 相对 host 的 p0 顶部（这里只是把推导写清楚）
});

test('measureBlocks: display:none 的节点记 0 但占一个下标', () => {
  const host = fakeEl({ offsetTop: 0 });
  const a = fakeEl({ offsetTop: 0, height: 100, offsetParent: host });
  // display:none → 没有 offsetParent，链走不到 host
  const hidden = fakeEl({ offsetTop: 0, height: 0, offsetParent: null });
  // c 的 top = a 的高度 100 + 段间距 30（假 DOM 里手填；真实 DOM 中
  // display:none 不产生间距，所以这段距离全部属于 a 这个块）
  const c = fakeEl({ offsetTop: 130, height: 50, offsetParent: host });

  const blocks = measureBlocks([a, hidden, c], { host });
  assert.equal(blocks.length, 3, '隐藏节点也必须占一个下标，否则 pi 会错位');
  assert.equal(blocks[1], 0, '隐藏节点高度记 0');
  // 隐藏块在差值里「消失」：a 的段高 = c 的 top − a 的 top = 130
  // （= a 自身 100 + 它后面的段间距 30）。c 是最后一块，取 rect 高度 50。
  assert.deepEqual(blocks, [130, 0, 50]);

  // 隐藏块在末尾：它自己 rect 高 0，但**它前一块的高度必须被补回来**。
  // tailSpan（a.top → 末尾隐藏块的距离）和 a 的 rect 高度都是 100 —— 两个来源
  // 一致才敢下结论；如果这里只信其中一个，末页就会被裁。
  const tailHidden = fakeEl({ offsetTop: 100, height: 0, offsetParent: null });
  const blocks2 = measureBlocks([a, tailHidden], { host });
  assert.deepEqual(blocks2, [100, 0], '末尾隐藏时，最后一个可见块拿到自己的完整高度，而不是差值 0');

  // 首块就是隐藏的：没有上一个可见块可投影，记 0
  assert.deepEqual(measureBlocks([hidden, a], { host }), [0, 100]);
});

test('measureBlocks: 输入长度为 0 / 全是无效节点时不炸，且长度对齐', () => {
  assert.deepEqual(measureBlocks([], { host: fakeEl({}) }), []);
  const host = fakeEl({ offsetTop: 0 });
  const blocks = measureBlocks([null, undefined], { host });
  assert.deepEqual(blocks, [0, 0], '无效节点记 0 占位，保持与 paragraphs 一一对应');
});

test('measureBlocks: 不在 host 链上的节点按「隐藏」处理（高度 0），不抛错也不污染差值', () => {
  // 两种「走不到 host」的情况：另一个游离树的节点、以及 display:none 的节点。
  // 测量期渲染层常常还留着还没上屏的节点，为这个抛错会把整个分页搞崩，
  // 所以统一记 0 占位。代价是：把「传错 host」这种真 bug 也一起吞掉了 ——
  // 表现为分页结果偏小，所以 measureBlocks 要求 host 必须是节点的共同祖先。
  const host = fakeEl({ offsetTop: 0 });
  const other = fakeEl({ offsetTop: 0, height: 50, offsetParent: null });
  const stray = fakeEl({ offsetTop: 10, height: 50, offsetParent: other });
  assert.deepEqual(measureBlocks([stray], { host }), [0]);
  // ⚠ 这里断言的是 [0, 0] 而不是 [0, 50]：假 DOM 给游离节点编了个 height: 50，
  //    但**真实浏览器里游离节点（不在文档里）的 rect 全是 0**（DOMRect 0,0,0,0）。
  //    早期版本会拿这个造假的高度去兜底，从而断言出一个真实环境里不存在的值 ——
  //    这是假 DOM 最容易骗过测试的地方：它把「不可能的状态」变得可测量。
  //    真实语义：量不到布局的节点贡献 0，它的高度只会体现在相邻真实块的距离里。
  assert.deepEqual(measureBlocks([stray, stray], { host }), [0, 0], '游离节点不贡献高度（真实 rect 恒为 0）');

  // host 就是节点自己时，相对偏移按 0 算（不能因为 offsetTop 恰好为 0 而误判）
  assert.deepEqual(measureBlocks([host], { host }), [0]);
});

test('measureBlocks: 支持 {el} 包装（渲染层常用 {el, para} 记录）', () => {
  const host = fakeEl({ offsetTop: 0 });
  const a = fakeEl({ offsetTop: 0, height: 100, offsetParent: host });
  const b = fakeEl({ offsetTop: 120, height: 30, offsetParent: host });
  const blocks = measureBlocks([{ el: a, para: { pi: 0 } }, { el: b, para: { pi: 1 } }], { host });
  assert.equal(blocks[0], 120);
  assert.equal(blocks[1], 30);
});

// ─────────────────────────────────────────────────────────────────────────────
// paginate / pageRanges / needsRelayout
// ─────────────────────────────────────────────────────────────────────────────

test('paginate: 组合测量 + 装箱，返回 pages/heights', () => {
  const { host, nodes } = flatBlocks([
    { h: 100, gap: 30 },
    { h: 100, gap: 30 },
    { h: 100, gap: 0 },
  ]);
  const r = paginate([{}, {}, {}], { host, available: 300, nodes });
  // blocks = [130, 130, 100]，available 300 → 130+130=260 装得下，再加 100 超了
  assert.deepEqual(r.blocks, [130, 130, 100]);
  assert.deepEqual(r.pages, [0, 2]);
  assert.deepEqual(r.heights, [260, 100]);
  assert.equal(r.starts, r.pages);
});

test('paginate: 有段落却量不到节点时必须抛错，不能静默返回一页空内容', () => {
  // 这个用例是真实踩出来的：早期版本的 paginate 读的是 opt.paras 而不是 opt.nodes，
  // 于是「显式传 nodes」的调用全部静默退化成「一页空书」，测试却几乎全绿。
  // 静默的成功比失败更贵 —— 渲染层会照着一页空内容渲染，用户看到一本空书，
  // 而没有任何线索指向原因。
  const host = fakeEl({ offsetTop: 0 }); // 没有 children
  assert.throws(() => paginate([{}, {}], { host, available: 300 }), /没有可测量的节点/);
  // 真·空章（没有任何段落）仍然允许：一页空页是对的
  assert.deepEqual(paginate([], { host, available: 300 }).pages, [0]);
});

test('paginate: nodes 缺省时用 host.children', () => {
  const { host, nodes } = flatBlocks([{ h: 60, gap: 0 }, { h: 60, gap: 0 }]);
  host.children = nodes;
  const r = paginate([{}, {}], { host, available: 100 });
  assert.deepEqual(r.pages, [0, 1]);
});

test('paginate: 缺 host / 非法 available 都要抛错', () => {
  assert.throws(() => paginate([], {}), /需要一个 host 容器/);
  assert.throws(() => paginate([], { host: fakeEl({}), available: 0 }), /可用高度必须为正数/);
});

test('pageRanges: 区间拼接覆盖 0..n-1 且末页闭合到 n', () => {
  assert.deepEqual(pageRanges([0, 2, 5], 7), [
    { start: 0, end: 2 }, { start: 2, end: 5 }, { start: 5, end: 7 },
  ]);
  assert.deepEqual(pageRanges([0], 0), [{ start: 0, end: 0 }]);
});

test('needsRelayout: 小抖动（iOS 地址栏伸缩）不重排，超过阈值才重排', () => {
  assert.equal(needsRelayout(500, 500), false);
  assert.equal(needsRelayout(500, 510), false);
  assert.equal(needsRelayout(500, 500 + PAGINATION.relayoutThreshold - 1), false);
  assert.equal(needsRelayout(500, 500 + PAGINATION.relayoutThreshold), true);
  assert.equal(needsRelayout(500, 300), true, 'iPad 旋转（高度大变化）必须重排');
});

// ─────────────────────────────────────────────────────────────────────────────
// measureBlocks 的假 DOM 测不到什么（这是本测试文件的价值边界，必须写清楚）
// ─────────────────────────────────────────────────────────────────────────────
//
// 假 DOM 无法复现的、真机上才存在的东西：
//  1. **CSS 外边距折叠本身**。折叠是浏览器的布局算法，假 DOM 里没有 CSS 引擎，
//     我们只能把「折叠发生之后的 offsetTop / rect.height 数值」直接喂进去。
//     所以本文件验证的是「测量代码有没有用差值法」这个**实现选择**，
//     而不是「真实折叠场景下分页是对的」。两者的差距必须靠浏览器里的
//     e2e（真机/真 Chromium）补，不能靠这里的绿勾替代。
//  2. **亚像素与整数化**。真实 offsetTop 是四舍五入整数，lineHeight 1.75 × 19px
//     会算出 33.25px 的行高；多行累加后偏移量会漂移。假 DOM 里全是整数。
//     packPages 的 epsilon 容差就是为这个漂移准备的，但没有真机数据前只能靠猜。
//  3. **BFC / overflow:hidden / display:flow-root 的差别**。
//     容器有没有建立 BFC，决定了首块的 margin-top 会不会跑出去；
//     假 DOM 里不存在这个概念，所以那条 docstring 前提**没有被测试覆盖**。
//  4. **transform / 缩放 / 字体未加载完（FOUT）** 时的 rect 与 offsetTop 不一致。
//     `rect.height` 会被 transform 缩放而 `offsetTop` 不会，这对数值是矛盾的，
//     假 DOM 里无法构造。
//  5. **iOS 地址栏伸缩导致的 dvh 变化**：本文件只测了 needsRelayout 的阈值判断，
//     没有测「dvh 真的变了多少」。
//
// 结论：这个测试文件的职责是「把纯逻辑层和差值法钉死」，不是「证明 iOS 上分页正确」。
