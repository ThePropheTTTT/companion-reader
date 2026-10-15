/**
 * site/js/core/anchor.js 的测试。
 *
 * 覆盖 R1 只锚词首 / R2 小句起点 / R3 连词让位 / R4 密度补位 / R5 最小间距 /
 * R6 中文锚点长度恒为 1 / R7 中英混排，外加强度夹紧、性能、无 Intl.Segmenter
 * 的降级路径，以及一条给人看的可读性快照。
 *
 * 跑法：node --test test/anchor.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeAnchors, anchorTokens } from '../site/js/core/anchor.js';

const HAN = /\p{Script=Han}/u;
/** 分句标点 + 空白：锚点只允许出现在这些字符（或包装字符）之后 */
const BREAK_BEFORE = /[\s。！？；：，、…—「」『』（）《》〈〉“”‘’·]/u;
const STRENGTHS = [0, 1, 2, 3, 4];

/* ============================================================
   素材：一段真实中文长文（6 段，共 592 字）
   ============================================================ */
const PARAGRAPHS = [
  '注意力是一种稀缺资源。当一个人在嘈杂的车厢里翻开一本书，他首先要做的不是理解，而是把视线从周围的动静里收回来，重新落到纸面上。这个过程每次都要消耗一部分力气，于是读书变成了一件需要提前鼓劲的事。',
  '扫读与精读并不是两种对立的能力。眼睛在行间跳跃时，大脑仍在后台做着修补：它根据上下文补全被跳过的字，根据语法预测下一个词，只有当预测落空时才会回头重看。换句话说，落点越稳定，这种后台修补就越省力。',
  '因此，排版上的每一处强调都会改变阅读的节奏。加粗太多，读者会把注意力浪费在辨别强调本身上；加粗太少，视线又会在长句里迷路。理想的密度应当让读者几乎察觉不到标记的存在，只是觉得这一页读起来比上一页顺。',
  '这个道理对中文尤其重要。汉字没有词间空格，词的边界本来就模糊，读者的眼睛只能依靠标点和小句来切分句子。如果每个小句的开头都有一个明确的落点，视线就能沿着这些落点一路滑下去，而不必逐字确认自己走到哪里。',
  '有人担心这种标记会打断句子的完整性，其实恰恰相反。真正打断阅读的是那种需要反复回头的句子，而不是一个位置合理的加粗字。把落点交给排版去处理，读者才能把有限的注意力留给内容本身。',
  '当然，规则总会有例外。遇到人名、地名、外来语，分词器可能给出与直觉不同的结果；遇到诗歌、对话、列表，小句的边界也会变得模糊。此时更好的做法是承认不确定，宁可少标一处，也不要让读者在半途忽然被一个错误的落点绊住。',
];
const ESSAY = PARAGRAPHS.join('\n');

/** 可读性快照素材（206 字论述文）—— 第 11 条测试用 */
const SNAPSHOT =
  '中文语义锚点的难点不在于找到词，而在于决定哪一个词值得停一下。人的眼睛在扫读时并不逐字辨认，而是跳跃着寻找可以落脚的位置；如果每一行都挤满了同样密度的字，注意力很快就会失去抓点。因此，加粗的位置必须稀疏、稳定、可预期：太密，加粗本身就变成新的噪声；太疏，读者又会重新掉回逐字阅读的老路。另一个容易被忽略的问题是分词的边界，一旦把「浮士德」劈成两半，读者就会在潜意识里感到别扭，而这种别扭会直接变成放弃阅读的理由。';

/** 中英混排素材 */
const MIXED = '他打开了 Kindle 阅读器，屏幕上是 Project Gutenberg 的书。';

/* ============================================================
   工具
   ============================================================ */

/** 把锚点用【】标出来，只为肉眼检查 / 快照 */
function marked(text, strength) {
  let out = '';
  let cursor = 0;
  for (const r of computeAnchors(text, strength)) {
    out += `${text.slice(cursor, r.start)}【${text.slice(r.start, r.end)}】`;
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

/**
 * 一条不变量全家桶：区间合法、升序、不重叠、间距 ≥ 4、
 * anchorTokens 拼接无损且 head 与 computeAnchors 完全一致。
 * @param {{computeAnchors:Function, anchorTokens:Function}} api 允许换成降级模块
 */
function assertInvariants(api, text, strength, label = 'text') {
  const where = `${label} strength=${strength}`;
  const ranges = api.computeAnchors(text, strength);

  let prev = null;
  for (const r of ranges) {
    assert.ok(
      Number.isInteger(r.start) && Number.isInteger(r.end),
      `${where}: 区间必须是整数 ${JSON.stringify(r)}`,
    );
    assert.ok(
      r.start >= 0 && r.start < r.end && r.end <= text.length,
      `${where}: 区间越界 ${JSON.stringify(r)}`,
    );
    if (prev) {
      assert.ok(r.start >= prev.end, `${where}: 区间重叠或未按 start 升序`);
      assert.ok(
        r.start - prev.end >= 4,
        `${where}: 锚点间距 ${r.start - prev.end} < 4（R5），${JSON.stringify(prev)} → ${JSON.stringify(r)}`,
      );
    }
    prev = r;
  }

  const tokens = api.anchorTokens(text, strength);
  for (const t of tokens) {
    assert.ok(t.t === 'head' || t.t === 'text', `${where}: 未知 token 类型 ${t.t}`);
    assert.equal(typeof t.v, 'string', `${where}: token 值必须是字符串`);
    assert.ok(t.v.length > 0, `${where}: 不允许空 token`);
  }
  assert.equal(
    tokens.map((t) => t.v).join(''),
    text,
    `${where}: tokens 拼接后必须逐字等于原文`,
  );
  const heads = tokens
    .filter((t) => t.t === 'head')
    .map((t) => t.v)
    .join('');
  const covered = ranges.map((r) => text.slice(r.start, r.end)).join('');
  assert.equal(heads, covered, `${where}: head 拼接必须等于 computeAnchors 覆盖的字符`);

  return ranges;
}

/** 用分词器直接验证「没有锚点落在词的中间」（R1） */
function assertNoWordSplit(text, strength, label = 'text') {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  const words = [...segmenter.segment(text)].filter((p) => p.isWordLike);
  for (const r of computeAnchors(text, strength)) {
    if (!HAN.test(text[r.start])) continue; // 英文/数字锚点单独断言
    const host = words.find((p) => p.index <= r.start && r.start < p.index + p.segment.length);
    assert.ok(host, `${label} strength=${strength}: 锚点 ${r.start} 不在任何词里`);
    assert.equal(
      r.start,
      host.index,
      `${label} strength=${strength}: 锚点劈开了词「${host.segment}」（锚在「${text.slice(r.start, r.end)}」上）`,
    );
  }
}

/** 默认模块（降级路径的测试会换成另一个实例） */
const api = { computeAnchors, anchorTokens };

/* ============================================================
   1. 不变量（真实长文 × 每段 × 0..4 全跑）
   ============================================================ */
test('不变量：升序 / 不重叠 / 边界 / 间距 ≥ 4 / tokens 无损且与锚点严格一致', () => {
  for (const [i, paragraph] of PARAGRAPHS.entries()) {
    for (const strength of STRENGTHS) {
      const ranges = assertInvariants(api, paragraph, strength, `第 ${i + 1} 段`);
      assert.ok(ranges.length > 0, `第 ${i + 1} 段 strength=${strength} 不该一个落点都没有`);
    }
  }
  // 段落拼起来的整篇（含换行）同样成立
  for (const strength of STRENGTHS) assertInvariants(api, ESSAY, strength, '整篇');
  // 中英混排、带引号的短句也不能破坏不变量
  for (const strength of STRENGTHS) {
    assertInvariants(api, MIXED, strength, '混排');
    assertInvariants(api, '「你好，」他说，「再见。」', strength, '对话');
    assertInvariants(api, '他说完这句就走了\n她还在原地站着。', strength, '换行');
  }
});

/* ============================================================
   2. R1：绝不把词从中间劈开
   ============================================================ */
test('R1 只在词首落锚：不会把「浮士德」劈成两半', () => {
  const text = '浮士德博士把书放在桌上。';
  for (const strength of STRENGTHS) {
    const ranges = computeAnchors(text, strength);
    const inside = ranges.filter((r) => r.start > 0 && r.start < 3);
    assert.deepEqual(inside, [], `strength=${strength}: 锚点落进了「浮士德」内部`);
  }
  // 落在词上就必须落在词首
  assert.deepEqual(computeAnchors(text, 2)[0], { start: 0, end: 1 });

  // 同一个词出现在句中（引号里）时同样成立
  const quoted = '一旦把「浮士德」劈成两半，读者就会感到别扭。';
  const at = quoted.indexOf('浮士德');
  for (const strength of STRENGTHS) {
    for (const r of computeAnchors(quoted, strength)) {
      if (r.start > at && r.start < at + 3) {
        assert.fail(`strength=${strength}: 锚点劈开了「浮士德」（start=${r.start}）`);
      }
    }
  }
  assert.ok(
    computeAnchors(quoted, 2).some((r) => r.start === at),
    '「浮士德」值得锚，就应该锚在词首「浮」上',
  );
});

test('R1 用分词器逐词复核：长文里没有锚点落在词的中间', () => {
  for (const [i, paragraph] of PARAGRAPHS.entries()) {
    for (const strength of STRENGTHS) {
      assertNoWordSplit(paragraph, strength, `第 ${i + 1} 段`);
    }
  }
  assertNoWordSplit(SNAPSHOT, 2, '快照');
  assertNoWordSplit('但是他并不这么认为，因为所以都不成立。', 4, '连词句');
});

/* ============================================================
   3. R3：句首连词让位
   ============================================================ */
test('R3 多字连词整词跳过，单字实词自己顶上', () => {
  // 「但是」整词跳过 → 锚「我」
  assert.deepEqual(computeAnchors('但是我并不这么认为。', 2), [{ start: 2, end: 3 }]);
  // 「最后」是词，「最」不是连词 → 锚「最」
  assert.deepEqual(computeAnchors('最后一句是这样的。', 2), [{ start: 0, end: 1 }]);
  // 「这是那场」：「这」在虚词表里，但这里是主语 → 锚「这」
  assert.equal(computeAnchors('这是那场雨留下的痕迹。', 2)[0].start, 0);
  // 「因为所以」整句都是连词 → 本小句留白，只锚下一个实词「科」
  assert.deepEqual(computeAnchors('因为所以，科学道理。', 2), [{ start: 5, end: 6 }]);
  // 连锁让位：但是 → 因为 → 所以 → 我
  assert.deepEqual(computeAnchors('但是因为所以，我不同意。', 2), [{ start: 7, end: 8 }]);
  // 「而是」是整词连词 → 让到实词「跳」
  assert.deepEqual(computeAnchors('他并不逐字辨认，而是跳跃着寻找。', 2), [
    { start: 0, end: 1 },
    { start: 10, end: 11 },
  ]);
  // 「而在于」两个虚词让位到实词「决定」
  assert.deepEqual(computeAnchors('而在于决定哪一个词值得停一下。', 2), [{ start: 3, end: 4 }]);
});

/* ============================================================
   4. R4：密度
   ============================================================ */
test('R4 密度：strength 0 的锚点明显少于 strength 4', () => {
  const counts = STRENGTHS.map((s) => computeAnchors(ESSAY, s).length);
  const [lo, , , , hi] = counts;
  assert.ok(lo < hi, `strength 0 (${lo}) 必须严格少于 strength 4 (${hi})`);
  assert.ok(hi / lo >= 1.5, `密度比 ${(hi / lo).toFixed(2)} 太小，加粗档位没有拉开差距`);
  assert.ok(hi / lo <= 3, `密度比 ${(hi / lo).toFixed(2)} 太大，档位跨度不合理`);
  for (const [i, c] of counts.entries()) {
    assert.ok(c > 0, `strength ${i} 不该一个落点都没有`);
    assert.ok(c <= ESSAY.length / 4, `strength ${i} 锚点过密（${c} 个）`);
  }
  // 每一段单独看也要拉开
  for (const [i, paragraph] of PARAGRAPHS.entries()) {
    assert.ok(
      computeAnchors(paragraph, 0).length < computeAnchors(paragraph, 4).length,
      `第 ${i + 1} 段 strength 0/4 的锚点数没有拉开`,
    );
  }
});

/* ============================================================
   5. R6：中文锚点长度恒为 1
   ============================================================ */
test('R6 中文锚点区间长度恒为 1，永远不会连着两个字加粗', () => {
  const texts = [ESSAY, SNAPSHOT, MIXED, ...PARAGRAPHS, '「你好，」他说，「再见。」'];
  for (const text of texts) {
    for (const strength of STRENGTHS) {
      const ranges = computeAnchors(text, strength);
      for (const r of ranges) {
        if (!HAN.test(text[r.start])) continue;
        assert.equal(
          r.end - r.start,
          1,
          `中文锚点必须只覆盖一个字，得到「${text.slice(r.start, r.end)}」`,
        );
      }
      for (let i = 1; i < ranges.length; i++) {
        assert.notEqual(ranges[i].start, ranges[i - 1].end, '不允许两个锚点首尾相接');
      }
    }
  }
});

/* ============================================================
   6. 空 / 纯 ASCII / 纯标点
   ============================================================ */
test('空串、纯空白、纯标点、纯英文、纯数字 → 空数组', () => {
  const empties = [
    '',
    '   ',
    '\n\t \n',
    '。，！？；：、…—',
    '「」『』（）《》〈〉',
    '……——··',
    'Hello world!',
    'kindle',
    '12345',
    '3.14159',
    '100%',
    'abc 123 def',
  ];
  for (const text of empties) {
    for (const strength of STRENGTHS) {
      assert.deepEqual(computeAnchors(text, strength), [], `${JSON.stringify(text)} 应当没有锚点`);
    }
    const tokens = anchorTokens(text, 2);
    assert.equal(tokens.map((t) => t.v).join(''), text, 'tokens 仍必须无损');
    assert.ok(
      tokens.every((t) => t.t === 'text'),
      `${JSON.stringify(text)} 里不该有 head token`,
    );
  }
  assert.deepEqual(anchorTokens('', 2), []);
});

/* ============================================================
   7. R7：中英混排
   ============================================================ */
test('R7 中英混排：英文词整词当锚点，且不违反任何约束', () => {
  const kindleAt = MIXED.indexOf('Kindle');
  const gutenbergAt = MIXED.indexOf('Gutenberg');
  for (const strength of STRENGTHS) {
    const ranges = assertInvariants(api, MIXED, strength, '混排');
    assert.ok(ranges.length > 0, '中英混排不该没有锚点');
    for (const r of ranges) {
      if (HAN.test(MIXED[r.start])) continue;
      assert.ok(r.end - r.start >= 2, `英文/数字锚点必须整词，得到「${MIXED.slice(r.start, r.end)}」`);
    }
  }
  const ranges = computeAnchors(MIXED, 2);
  assert.ok(
    ranges.some((r) => r.start === kindleAt && r.end === kindleAt + 'Kindle'.length),
    '「Kindle」应当整词作为锚点',
  );
  assert.ok(
    ranges.some((r) => r.start === gutenbergAt && r.end === gutenbergAt + 'Gutenberg'.length),
    '「Gutenberg」应当整词作为锚点',
  );
  const heads = anchorTokens(MIXED, 2).filter((t) => t.t === 'head').map((t) => t.v);
  assert.ok(heads.includes('Kindle') && heads.includes('Gutenberg'), 'head token 里应有英文词');

  // 数字不单独当锚点（R7：纯数字不算落点），但混排文本整体合法
  assert.deepEqual(computeAnchors('价格是 100 元整。', 2), [
    { start: 0, end: 1 },
    { start: 8, end: 9 },
  ]);
});

/* ============================================================
   8. strength 越界 / 非法
   ============================================================ */
test('strength 越界或非法值时夹紧到 0..4，且不抛异常', () => {
  const base = SNAPSHOT;
  assert.deepEqual(computeAnchors(base, -1), computeAnchors(base, 0));
  assert.deepEqual(computeAnchors(base, -99), computeAnchors(base, 0));
  assert.deepEqual(computeAnchors(base, 99), computeAnchors(base, 4));
  assert.deepEqual(computeAnchors(base, 4.9), computeAnchors(base, 4));
  assert.deepEqual(computeAnchors(base, '3'), computeAnchors(base, 3));
  assert.deepEqual(computeAnchors(base, '1e9'), computeAnchors(base, 4));
  assert.deepEqual(computeAnchors(base, undefined), computeAnchors(base, 2));
  assert.deepEqual(computeAnchors(base), computeAnchors(base, 2)); // 缺省 = 2
  assert.deepEqual(computeAnchors(base, NaN), computeAnchors(base, 2));
  assert.deepEqual(computeAnchors(base, Infinity), computeAnchors(base, 2));
  assert.deepEqual(computeAnchors(base, {}), computeAnchors(base, 2));
  assert.deepEqual(computeAnchors(base, null), computeAnchors(base, 0));

  for (const weird of [-1, 99, 2.5, undefined, null, '2', 'abc', NaN, {}, [], true]) {
    assert.doesNotThrow(() => computeAnchors(base, weird), `computeAnchors 不该对 ${String(weird)} 抛错`);
    assert.doesNotThrow(() => anchorTokens(base, weird), `anchorTokens 不该对 ${String(weird)} 抛错`);
    assertInvariants(api, base, weird, '越界强度');
  }
});

/* ============================================================
   9. 性能
   ============================================================ */
test('性能：1000 字段落跑 100 次，总耗时 < 1000ms', () => {
  const long = ESSAY.repeat(3).slice(0, 1000);
  assert.ok(long.length >= 1000, `素材不够 1000 字：${long.length}`);
  computeAnchors(long, 2); // 预热（首次会构造并缓存 Segmenter）
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) computeAnchors(long, 2);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 1000, `1000 字 × 100 次用了 ${elapsed.toFixed(1)}ms，超过 1000ms 阈值`);
});

/* ============================================================
   10. 降级路径：没有 Intl.Segmenter
   ============================================================ */
test('降级路径：globalThis.Intl 没有 Segmenter 时仍产出合法锚点', async (t) => {
  const realIntl = globalThis.Intl;
  t.after(() => {
    globalThis.Intl = realIntl;
  });
  globalThis.Intl = {}; // 打桩：没有 Segmenter
  // 模块内部缓存了 Segmenter 实例，必须换一个全新的模块实例才会走降级分支
  const degraded = await import('../site/js/core/anchor.js?no-segmenter');

  for (const [i, paragraph] of PARAGRAPHS.entries()) {
    for (const strength of STRENGTHS) {
      const ranges = assertInvariants(degraded, paragraph, strength, `降级第 ${i + 1} 段`);
      assert.ok(ranges.length > 0, `降级路径第 ${i + 1} 段 strength=${strength} 没有落点`);
      for (const r of ranges) {
        if (HAN.test(paragraph[r.start])) {
          assert.equal(r.end - r.start, 1, '降级路径的中文锚点长度也必须为 1');
        }
        // 降级路径的落点同样只能出现在小句开头（标点/空白/包装字符之后）
        let j = r.start - 1;
        while (j >= 0 && /[「」『』（）《》〈〉“”‘’]/u.test(paragraph[j])) j--;
        assert.ok(
          j < 0 || BREAK_BEFORE.test(paragraph[j]),
          `降级路径的锚点 ${r.start} 不在小句开头（前一个字符是「${paragraph[j]}」）`,
        );
      }
    }
  }
  assert.deepEqual(degraded.computeAnchors('Hello world 42', 2), []);
  assert.deepEqual(degraded.computeAnchors('', 2), []);
  assert.deepEqual(degraded.computeAnchors('。，！', 2), []);
  assert.deepEqual(degraded.anchorTokens('Hello world', 2), [{ t: 'text', v: 'Hello world' }]);

  // 恢复之后主模块（以及新导入的模块）照常工作
  globalThis.Intl = realIntl;
  assert.ok(computeAnchors('浮士德博士把书放在桌上。', 2).length > 0);
  assert.equal(typeof globalThis.Intl.Segmenter, 'function');
});

/* ============================================================
   11. 可读性快照：给人看的
   ============================================================ */
test('可读性快照：206 字论述文在 strength 2 下的锚点位置', () => {
  assert.equal(
    marked(SNAPSHOT, 2),
    '【中】文语义锚点的难点不在于找到【词】，而在于【决】定哪一个词值得停一下。【人】的眼睛在扫读时并不逐字【辨】认，而是【跳】跃着寻找可以落脚的【位】置；如果【每】一行都挤满了同样密度的字，【注】意力很快就会失去抓点。因此，【加】粗的位置必须稀疏、【稳】定、可预期：太【密】，加粗本身就变成【新】的噪声；太【疏】，读者又会重新掉回逐字【阅】读的老路。【另】一个容易被忽略的问题是【分】词的边界，一旦把「【浮】士德」劈成两半，【读】者就会在潜意识里【感】到别扭，而【这】种别扭会直接变成放弃阅读的【理】由。',
  );
  // 快照的落点数量也应该随强度递增（同段文本上做一次抽查）
  const counts = STRENGTHS.map((s) => computeAnchors(SNAPSHOT, s).length);
  assert.deepEqual(counts, [16, 19, 22, 24, 27]);
});
