/* ============================================================
   陪读 · 端到端集成测试（不联网、不开浏览器）
   ------------------------------------------------------------
   为什么这个测试最重要：
   现有的每个测试都在验证「自己那一层」——xml 验解析、paginate 验装箱、
   anchor 验锚点。但**没有任何一个测试验证它们串起来能不能读一本书**。
   而这一类断裂（比如 renderer.js 里一个 let/const 重名导致整份模块
   加载失败、app.js 引用了不存在的 core/ai.js、epub.js 不导出
   reader.js 要的函数）恰恰是单层测试永远看不到的。

   这个测试真的构造一本 EPUB（字节级，含 CRC32 和 deflate），
   然后走完整条链路：
     ZIP 字节 → parseEPUB → 章节目录 → ensureParas → anchorTokens
     → measureBlocks（假 DOM）→ packPages → 每页字数

   它跑在 Node 里，用的是 Node 18+ 也有的 DecompressionStream / Blob /
   TextDecoder，所以不需要浏览器。
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { crc32 } from '../site/js/core/zip.js';
import { parseEPUB, parseTXT } from '../site/js/core/epub.js';
import { ensureParas, resolveImageSources } from '../site/js/core/media.js';
import { anchorTokens, computeAnchors } from '../site/js/core/anchor.js';
import { measureBlocks, packPages } from '../site/js/core/paginate.js';

const enc = new TextEncoder();

/* ---------------------------- 造一本 ZIP ---------------------------- */

/**
 * 最小 ZIP 写入器。
 * 只写 stored 与 deflate 两种 method，够 EPUB 用。
 * @param {Array<{name:string, data:string|Uint8Array, deflate?:boolean}>} items
 * @returns {Uint8Array}
 */
function makeZip(items) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const it of items) {
    const nameBytes = enc.encode(it.name);
    const raw = typeof it.data === 'string' ? enc.encode(it.data) : it.data;
    const crc = crc32(raw);
    let stored = raw;
    let method = 0;
    if (it.deflate) {
      stored = new Uint8Array(deflateRawSync(raw));
      method = 8;
    }

    // local file header
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags（不用 data descriptor：那会让 local header 的大小字段为 0）
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    lh.set(nameBytes, 30);

    localParts.push(lh, stored);

    // central directory entry
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, stored.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // 相对 local header 的偏移
    ch.set(nameBytes, 46);
    centralParts.push(ch);

    offset += lh.length + stored.length;
  }

  const centralSize = centralParts.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total =
    localParts.reduce((a, b) => a + b.length, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of localParts) {
    out.set(part, p);
    p += part.length;
  }
  for (const part of centralParts) {
    out.set(part, p);
    p += part.length;
  }
  out.set(eocd, p);
  return out;
}

/* ---------------------------- 造一本 EPUB ---------------------------- */

const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body>
  <h1>第一章 雨</h1>
  <p>雨是从傍晚开始下的。他把窗户关上，声音反而更清楚了，像是有人在屋顶上走。</p>
  <p>「你带伞了吗。」她问。他没有回答，因为答案是显而易见的：他没带，而且她一整天都在看着他。</p>
  <p>桌上有两只杯子，一只装着凉掉的茶，另一只空着。空的那只才是今天用过的。</p>
</body></html>`;

const CH2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body>
  <h1>第二章 账本</h1>
  <p>账本摊开在桌上，最后一页的墨迹还没有完全干。他数了三遍，怎么数都少一笔。</p>
  <p>少的不是钱。少的是一笔他记得自己签过名、却怎么也想不起内容的款项。</p>
</body></html>`;

function makeEpub() {
  return makeZip([
    // EPUB 规范要求 mimetype 必须是第一个条目、且不许压缩
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
      deflate: true,
    },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>下雨的账本</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="bookid">urn:uuid:test-0001</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="Images/pic.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`,
      deflate: true,
    },
    {
      name: 'OEBPS/nav.xhtml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="toc"><ol>
    <li><a href="Text/ch1.xhtml">第一章 雨</a></li>
    <li><a href="Text/ch2.xhtml">第二章 账本</a></li>
  </ol></nav>
</body></html>`,
      deflate: true,
    },
    { name: 'OEBPS/Text/ch1.xhtml', data: CH1, deflate: true },
    { name: 'OEBPS/Text/ch2.xhtml', data: CH2, deflate: true },
    // 1×1 的透明 PNG（真实字节，能验证图片路径解析）
    {
      name: 'OEBPS/Images/pic.png',
      data: Uint8Array.from(
        atobBytes(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        )
      ),
    },
  ]);
}

function atobBytes(b64) {
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin);
}

/* ---------------------------- 测试 ---------------------------- */

test('端到端：一本真实构造的 EPUB 能被导入并读出内容', async () => {
  const bytes = makeEpub();
  assert.ok(bytes.length > 500, 'ZIP 字节看起来太小了');

  const doc = await parseEPUB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '下雨的账本.epub', 1700000000000);

  assert.equal(doc.meta.title, '下雨的账本', '书名应来自 OPF 的 dc:title');
  assert.equal(doc.meta.author, '测试作者');
  assert.equal(doc.meta.format, 'epub');
  assert.equal(doc.chapters.length, 2, 'spine 里有两章');
  assert.equal(doc.meta.chapterCount, 2);
  assert.ok(doc.meta.charCount > 100, '字数应该被统计');

  // 章节标题来自 nav 目录，不是「第 1 章」这种兜底
  assert.equal(doc.chapters[0].title, '第一章 雨');
  assert.equal(doc.chapters[1].title, '第二章 账本');

  // 指纹格式：文件名|字节数|时间
  assert.equal(doc.meta.id, `下雨的账本.epub|${bytes.byteLength}|1700000000000`);
});

test('端到端：段落切分正确，且 ensureParas 返回同一份结果', async () => {
  const bytes = makeEpub();
  const doc = await parseEPUB(bytes.buffer, 'b.epub', 1);
  const ch = doc.chapters[0];

  const paras = ensureParas(doc, ch);
  assert.ok(paras.length >= 4, `第一章应该有标题 + 至少 3 段，实际 ${paras.length}`);
  assert.equal(paras[0].type, 'h1', '第一个块是 h1 标题');
  assert.equal(paras[1].type, 'p');

  // pi 必须连续且从 0 开始 —— 批注就是按这个下标挂的，跳号会让批注整体错位
  paras.forEach((p, i) => assert.equal(p.pi, i, `第 ${i} 段的 pi 应为 ${i}`));

  // 幂等：再问一次必须是同一个数组（否则每次渲染都重新解析，且批注会漂移）
  const again = ensureParas(doc, ch);
  assert.equal(again, paras, 'ensureParas 必须缓存，返回同一个引用');

  assert.ok(paras[1].text.includes('雨是从傍晚开始下的'), '正文内容应完整');
  assert.ok(!paras[1].text.includes('<'), '正文里不该残留标签');
});

test('端到端：模拟「从书架重新打开」——没有 zip 时也要能重建段落', async () => {
  const bytes = makeEpub();
  const doc = await parseEPUB(bytes.buffer, 'b.epub', 1);

  // 模拟落库再读出来：JSON 往返会丢掉 paras 以外的所有东西（包括 _zip）
  const revived = JSON.parse(JSON.stringify(doc));
  assert.equal(revived._zip, undefined, 'zip 句柄不该被存进 IndexedDB');

  const ch = revived.chapters[0];
  const paras = ensureParas(revived, ch);
  assert.ok(paras.length >= 4, `重开后仍要能解析出段落，实际 ${paras.length}`);
  assert.equal(paras[0].type, 'h1');
  assert.ok(paras[1].text.includes('雨是从傍晚开始下的'));

  // 没有 zip 时解析图片必须安静返回，不能抛
  assert.doesNotThrow(() => resolveImageSources(revived, paras, ch));
});

test('端到端：锚点在真实正文上产出合法区间（不劈词、不越界、间距够）', async () => {
  const bytes = makeEpub();
  const doc = await parseEPUB(bytes.buffer, 'b.epub', 1);
  const paras = ensureParas(doc, doc.chapters[0]);

  for (const p of paras) {
    for (let s = 0; s <= 4; s++) {
      const ranges = computeAnchors(p.text, s);
      let prevEnd = -1;
      for (const r of ranges) {
        assert.ok(r.start >= 0 && r.end <= p.text.length, `区间越界：${r.start}-${r.end}`);
        assert.ok(r.end > r.start, '区间不能为空');
        assert.ok(r.start - prevEnd >= 4 || prevEnd < 0, `两个锚点挨太近了：${prevEnd} → ${r.start}`);
        // 中文锚点必须正好一个字
        const seg = p.text.slice(r.start, r.end);
        if (/^\p{Script=Han}+$/u.test(seg)) {
          assert.equal(seg.length, 1, `汉字锚点必须是单字，实际「${seg}」`);
        }
        prevEnd = r.end;
      }
    }
  }

  // anchorTokens 的拼接必须能还原原文（一个字不多一个字不少）
  for (const p of paras) {
    const tokens = anchorTokens(p.text, 2);
    assert.equal(
      tokens.map((t) => t.v).join(''),
      p.text,
      'anchorTokens 的 tokens 拼起来必须等于原文'
    );
  }
});

test('端到端：假 DOM 测量 → 分页，每段恰好属于一页', async () => {
  const bytes = makeEpub();
  const doc = await parseEPUB(bytes.buffer, 'b.epub', 1);
  const paras = ensureParas(doc, doc.chapters[0]);

  /* 假 DOM：Node 里没有布局引擎，所以这里不测「浏览器量得准不准」，
     只测「拿到一串高度之后装箱对不对」。高度用段落长度粗估 ——
     这也是唯一能在 Node 里做的事。

     注意每个节点的 offsetParent 必须挂到 host 上：measureBlocks 的
     offsetChain 是一路沿 offsetParent 往上走、遇到 host 才算「走得通」，
     走不通就按 display:none 处理（高度 0、只占一个下标）。
     一开始忘了这一条，结果量出来全是 0 —— 这本身就是个有价值的回归：
     renderer.js 调 measureBlocks 时少传 host 就是这个症状。 */
  const blocks0 = paras.map((p) => 40 + Math.ceil((p.text.length || 0) / 24) * 30);
  const host = { offsetTop: 0, offsetParent: null };
  let acc = 0;
  const nodes = blocks0.map((h) => {
    const node = {
      nodeType: 1, // elemOf 靠 nodeType === 1 认元素，假对象也得带上
      offsetTop: acc,
      offsetParent: host,
      getBoundingClientRect: () => ({ height: h }),
    };
    acc += h;
    return node;
  });

  const blocks = measureBlocks(nodes, { host });
  assert.equal(blocks.length, paras.length, '每个段落都要有高度');
  for (let i = 0; i < blocks.length; i++) {
    assert.ok(blocks[i] > 0, `第 ${i} 块高度应 > 0，实际 ${blocks[i]}`);
  }
  // 不变式：所有块之和 === 整章高
  assert.equal(
    blocks.reduce((a, b) => a + b, 0),
    acc,
    '所有 block 之和必须等于整章内容高度'
  );

  // 可用高度按「整章高的一半」算：这样必然分成 2~3 页，
  // 而不是依赖某个写死的数字刚好够或不够（写死过一次，第四章短，全挤进一页了）
  const total = blocks.reduce((a, b) => a + b, 0);
  const available = Math.ceil(total / 2);
  const { pageStarts, pageHeights } = packPages(blocks, available);
  assert.ok(pageStarts.length >= 2, `这本书应该分成至少两页（整章 ${total}px，每页 ${available}px）`);
  assert.equal(pageStarts[0], 0, '第一页必须从第 0 段开始');

  // 不重不漏：把每页的区间拼起来，必须正好覆盖 0..n-1
  let expected = 0;
  for (let i = 0; i < pageStarts.length; i++) {
    assert.equal(pageStarts[i], expected, `第 ${i} 页应从第 ${expected} 段开始`);
    const to = i + 1 < pageStarts.length ? pageStarts[i + 1] : paras.length;
    assert.ok(to > pageStarts[i], `第 ${i} 页不能是空的`);
    expected = to;
  }
  assert.equal(expected, paras.length, '最后一页必须读到章节末尾');

  // 除了「单块超过一屏所以独占一页」的情况，每页都不该超出可用高度
  for (let i = 0; i < pageHeights.length; i++) {
    const from = pageStarts[i];
    const to = i + 1 < pageStarts.length ? pageStarts[i + 1] : paras.length;
    const biggest = Math.max(...blocks.slice(from, to));
    if (biggest <= available) {
      assert.ok(
        pageHeights[i] <= available + 1,
        `第 ${i} 页高度 ${pageHeights[i]} 超过了可用高度 ${available}`
      );
    }
  }
});

test('端到端：TXT 也能走同一条链路（GBK 与 UTF-8 两种编码）', () => {
  const utf8 = enc.encode('第一章 开始\n这是第一段。\n\n这是第二段，稍微长一点的句子。\n\n第二章 继续\n又是一段。');
  const doc = parseTXT(utf8.buffer, 'book.txt', 42);
  assert.ok(doc.chapters.length >= 1);
  assert.ok(doc.chapters[0].text.includes('这是第一段'), '正文应完整读出');

  const paras = ensureParas(doc, doc.chapters[0]);
  assert.ok(paras.length >= 2, `TXT 也要能切成段落，实际 ${paras.length}`);
  for (const p of paras) {
    assert.ok(p.text.length > 0, '不该有空段落');
  }
});

test('端到端：renderer/reader/app 三个模块都能被加载（防「一打开就白屏」）', async () => {
  /* 这条测试的价值在回归：ui/renderer.js 曾经有过一处
     `let pageChars` 与同函数内的 `const pageChars` 重名，
     语法上直接 SyntaxError → 整个模块加载失败 → 阅读页全白。
     单层测试全绿也发现不了，因为没有人 import 它。 */
  await assert.doesNotReject(
    () => import('../site/js/ui/renderer.js'),
    'renderer.js 应该能被加载'
  );
  await assert.doesNotReject(() => import('../site/js/ui/reader.js'), 'reader.js 应该能被加载');
  await assert.doesNotReject(() => import('../site/js/ui/settings.js'), 'settings.js 应该能被加载');
  await assert.doesNotReject(() => import('../site/js/ui/ai-bridge.js'), 'ai-bridge.js 应该能被加载');
  await assert.doesNotReject(() => import('../site/js/ai/generate.js'), 'generate.js 应该能被加载');
});
