// test/epub.test.js —— EPUB / TXT 解析测试
//
// 不依赖任何外部 epub 文件：用 buildZip() 现造真实的 zip 字节
// （local header + 数据 + central directory + EOCD），deflate 走 CompressionStream('deflate-raw')。
// 运行：node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEPUB, parseTXT, detectCharset } from '../site/js/core/epub.js';

// ================================================================ zip 构造

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(u8) {
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function deflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
const u32 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

/**
 * 打一个真实的 zip。
 * @param {Array<{name:string, data:string|Uint8Array, method?:number, prefix?:string}>} entries
 *        method: 0 = stored, 8 = deflate（默认，第一个条目强制 stored）
 *        prefix: 条目名前缀，用来测 './' 与子目录
 * @returns {Promise<Uint8Array>}
 */
async function buildZip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nameBytes = enc.encode(`${e.prefix || ''}${e.name}`);
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    // mimetype 必须 stored 且排第一，其余默认 deflate
    const method = e.method !== undefined ? e.method : i === 0 ? 0 : 8;
    const payload = method === 0 ? raw : await deflateRaw(raw);
    const crc = crc32(raw);

    const local = concatBytes([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0x0800), // flag: 文件名为 UTF-8
      u16(method),
      u16(0), // time
      u16(0), // date
      u32(crc),
      u32(payload.length),
      u32(raw.length),
      u16(nameBytes.length),
      u16(0), // extra
      nameBytes,
      payload,
    ]);
    locals.push(local);

    centrals.push(
      concatBytes([
        u32(0x02014b50),
        u16(0x031e), // version made by (unix, 3.0)
        u16(20),
        u16(0x0800),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(payload.length),
        u32(raw.length),
        u16(nameBytes.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header 偏移
        nameBytes,
      ]),
    );

    offset += local.length;
  }

  const cd = concatBytes(centrals);
  const eocd = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
  return concatBytes([...locals, cd, eocd]);
}

// ================================================================ EPUB 素材

const MIMETYPE = 'application/epub+zip';

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

/** XHTML 外壳 */
const xhtml = (body, lang = 'zh') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}">
<head><title>t</title><meta charset="utf-8"/></head>
<body>
${body}
</body>
</html>`;

/** OPF2（无命名空间前缀 + ncx 目录） */
function opf2({ title = '测试书', creator = '作者甲', language = 'zh-CN', publisher = '某社', description = '简介', items, spine, ncxId = 'ncx', coverMeta = '' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${title}</dc:title>
    <dc:creator opf:role="aut">${creator}</dc:creator>
    <dc:language>${language}</dc:language>
    <dc:publisher>${publisher}</dc:publisher>
    <dc:description>${description}</dc:description>
    ${coverMeta}
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${items}
  </manifest>
  <spine toc="${ncxId}">
${spine}
  </spine>
</package>`;
}

/** NCX 目录 */
function ncx(points) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="x"/></head>
  <docTitle><text>测试书</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>`;
}

const navPoint = (id, play, title, src, nested = '') => `    <navPoint id="${id}" playOrder="${play}">
      <navLabel><text>${title}</text></navLabel>
      <content src="${src}"/>
${nested}
    </navPoint>`;

/** 最小 EPUB2 素材（带 ncx） */
async function miniEpub2() {
  const opf = opf2({
    items: `    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>`,
    spine: `    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>`,
  });
  const c1 = xhtml(`<h1>第一章 起点</h1>
<p>第一段。</p>
<p>第二段，<em>强调</em>与<strong>加粗</strong>。</p>
<p>换行<br/>之后。</p>`);
  const c2 = xhtml(`<h1>第二章 中段</h1>
<p>只有一段。</p>`);
  const c3 = xhtml(`<h1>第三章 终点</h1><p>收尾。</p>`);
  return buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx([navPoint('n1', '1', '第一章 起点', 'c1.xhtml'), navPoint('n2', '2', '第二章 中段', 'c2.xhtml'), navPoint('n3', '3', '第三章 终点', 'c3.xhtml')].join('\n')) },
    { name: 'OEBPS/c1.xhtml', data: c1 },
    { name: 'OEBPS/c2.xhtml', data: c2 },
    { name: 'OEBPS/c3.xhtml', data: c3 },
  ]);
}

// ================================================================ 测试：EPUB2

test('EPUB2：最小书，书名/作者/spine 顺序/章节标题/段落切分', async () => {
  const buf = await miniEpub2();
  const doc = await parseEPUB(buf, '测试书.epub', 1700000000000);

  assert.equal(doc.meta.title, '测试书');
  assert.equal(doc.meta.author, '作者甲');
  assert.equal(doc.meta.format, 'epub');
  assert.equal(doc.meta.language, 'zh-CN');
  assert.equal(doc.meta.publisher, '某社');
  assert.equal(doc.meta.description, '简介');
  assert.equal(doc.meta.size, buf.byteLength);
  assert.equal(doc.meta.chapterCount, 3);
  assert.equal(doc.chapters.length, 3);
  // id 形状：filename|byteLength|lastModified
  assert.equal(doc.meta.id, `测试书.epub|${buf.byteLength}|1700000000000`);
  assert.equal(doc.meta.id.split('|').length, 3);

  // spine 顺序 = 文件顺序
  assert.deepEqual(
    doc.chapters.map((c) => c.href),
    ['OEBPS/c1.xhtml', 'OEBPS/c2.xhtml', 'OEBPS/c3.xhtml'],
  );
  assert.deepEqual(doc.chapters.map((c) => c.index), [0, 1, 2]);
  // ncx 标题
  assert.deepEqual(
    doc.chapters.map((c) => c.title),
    ['第一章 起点', '第二章 中段', '第三章 终点'],
  );

  const ch0 = doc.chapters[0];
  assert.ok(ch0.paras.length >= 4, `段落数应当 >= 4，实际 ${ch0.paras.length}`);
  assert.deepEqual(ch0.paras.map((p) => p.type), ['h1', 'p', 'p', 'p']);
  assert.equal(ch0.paras[0].text, '第一章 起点');
  assert.equal(ch0.paras[1].text, '第一段。');
  assert.equal(ch0.paras[2].text, '第二段，强调与加粗。');
  assert.equal(ch0.paras[3].text, '换行 之后。'); // <br/> 变空格
  // pi 连续、text 与 paras 对应
  assert.deepEqual(ch0.paras.map((p) => p.pi), [0, 1, 2, 3]);
  assert.equal(ch0.text, ch0.paras.map((p) => p.text).join('\n'));

  // charCount = 各章 text 长度之和
  const sum = doc.chapters.reduce((n, c) => n + c.text.length, 0);
  assert.equal(doc.meta.charCount, sum);
  assert.equal(doc.rev, 1);
});

test('EPUB2：正文里的 h5/h6 归一成 h4，blockquote/li/img 正确映射', async () => {
  const opf = opf2({
    items: `    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="pic/a.png" media-type="image/png"/>`,
    spine: `    <itemref idref="c1"/>`,
  });
  const c1 = xhtml(`<h5>五级标题</h5>
<h6>六级标题</h6>
<blockquote><p>引文一</p><p>引文二</p></blockquote>
<ul><li>条目一</li><li>条目二</li></ul>
<p>图文混排：<img src="pic/a.png" alt="插图"/></p>
<div><img src="pic/b.png" alt="块级图"/></div>`);
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '第一章', 'c1.xhtml')) },
    { name: 'OEBPS/c1.xhtml', data: c1 },
  ]);
  const doc = await parseEPUB(buf, 'a.epub');
  const p = doc.chapters[0].paras;

  assert.equal(p[0].type, 'h4');
  assert.equal(p[0].text, '五级标题');
  assert.equal(p[1].type, 'h4');

  const quotes = p.filter((x) => x.type === 'quote');
  assert.deepEqual(quotes.map((x) => x.text), ['引文一', '引文二']); // 嵌套 p 不重复输出

  const lis = p.filter((x) => x.type === 'p' && x.text.startsWith('· '));
  assert.deepEqual(lis.map((x) => x.text), ['· 条目一', '· 条目二']);

  const imgs = p.filter((x) => x.type === 'img');
  // 段落内联图（<p>文字<img/></p>）与块里只有一张图（<div><img/></div>）都要出，
  // 且各出一次 —— 这里曾经漏掉 div 里那张，修法是让 walk 对「无块级子元素的
  // 纯容器」走 emitLeaf（见 core/epub.js 的 PURE_CONTAINER 分支注释）。
  assert.deepEqual(imgs.map((x) => x.src), ['OEBPS/pic/a.png', 'OEBPS/pic/b.png']);
  assert.equal(imgs[0].alt, '插图');
  assert.equal(imgs.length, 2, '同一张图不能重复输出');
  // 内联图的宿主段落文字要保住（图不能把段落文字吃掉）
  assert.equal(p.find((x) => x.type === 'p' && x.text.startsWith('图文混排'))?.text, '图文混排：');
});

test('EPUB2：linear="no" 的 spine 项要跳过', async () => {
  const opf = opf2({
    items: `    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>`,
    spine: `    <itemref idref="c1"/>
    <itemref idref="cover" linear="no"/>
    <itemref idref="c2"/>`,
  });
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '一', 'c1.xhtml')) },
    { name: 'OEBPS/c1.xhtml', data: xhtml('<p>一</p>') },
    { name: 'OEBPS/cover.xhtml', data: xhtml('<p>封面</p>') },
    { name: 'OEBPS/c2.xhtml', data: xhtml('<p>二</p>') },
  ]);
  const doc = await parseEPUB(buf, 'a.epub');
  assert.equal(doc.chapters.length, 2);
  assert.deepEqual(doc.chapters.map((c) => c.href), ['OEBPS/c1.xhtml', 'OEBPS/c2.xhtml']);
});

// ================================================================ 测试：EPUB3

test('EPUB3：nav.xhtml 目录（多级嵌套）+ depth 正确', async () => {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>三级目录书</dc:title>
    <dc:creator>乙</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
    <item id="c4" href="c4.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
    <itemref idref="c4"/>
  </spine>
</package>`;
  const nav = xhtml(`<nav epub:type="toc" id="toc">
  <h1>目录</h1>
  <ol>
    <li><a href="c1.xhtml">第一部</a>
      <ol>
        <li><a href="c2.xhtml">第一章</a>
          <ol>
            <li><a href="c3.xhtml">第一节</a></li>
          </ol>
        </li>
      </ol>
    </li>
    <li><a href="c4.xhtml">附录</a></li>
  </ol>
</nav>
<nav epub:type="landmarks"><ol><li><a href="c1.xhtml">正文</a></li></ol></nav>`);
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/c1.xhtml', data: xhtml('<h1>第一部</h1><p>甲</p>') },
    { name: 'OEBPS/c2.xhtml', data: xhtml('<h2>第一章</h2><p>乙</p>') },
    { name: 'OEBPS/c3.xhtml', data: xhtml('<h3>第一节</h3><p>丙</p>') },
    { name: 'OEBPS/c4.xhtml', data: xhtml('<h1>附录</h1><p>丁</p>') },
  ]);
  const doc = await parseEPUB(buf, 'nav.epub');

  assert.equal(doc.meta.title, '三级目录书');
  assert.equal(doc.meta.author, '乙');
  assert.deepEqual(doc.chapters.map((c) => c.title), ['第一部', '第一章', '第一节', '附录']);
  assert.deepEqual(doc.chapters.map((c) => c.depth), [0, 1, 2, 0]);
});

test('EPUB3：nav 用 type / role 属性也能识别；href 带 fragment 与 %20', async () => {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:identifier id="bookid">x</dc:identifier></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter%201.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  const nav = xhtml(`<nav role="doc-toc"><ol><li><a href="chapter%201.xhtml#start">带空格的章节</a></li></ol></nav>`);
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/chapter 1.xhtml', data: xhtml('<p>正文</p>') },
  ]);
  const doc = await parseEPUB(buf, 'n.epub');
  assert.equal(doc.chapters.length, 1);
  assert.equal(doc.chapters[0].title, '带空格的章节'); // fragment 去掉 + %20 解码后仍能匹配
});

// ================================================================ 命名空间前缀

test('命名空间变体：opf:/dc:/ncx: 前缀与完全无前缀两种都要过', async () => {
  const body = xhtml('<h1>章节</h1><p>内容</p>');

  // ---- 全前缀版
  const opfPrefix = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <opf:metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>前缀书</dc:title><dc:creator>前缀作者</dc:creator><dc:language>zh</dc:language>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <opf:item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </opf:manifest>
  <opf:spine toc="ncx"><opf:itemref idref="c1"/></opf:spine>
</opf:package>`;
  const ncxPrefix = `<?xml version="1.0"?>
<ncx:ncx xmlns:ncx="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <ncx:navMap>
    <ncx:navPoint id="a" playOrder="1">
      <ncx:navLabel><ncx:text>前缀章</ncx:text></ncx:navLabel>
      <ncx:content src="c1.xhtml"/>
    </ncx:navPoint>
  </ncx:navMap>
</ncx:ncx>`;
  const zip1 = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: './META-INF/container.xml', data: CONTAINER }, // 带 ./ 前缀
    { name: 'OEBPS/content.opf', data: opfPrefix },
    { name: 'OEBPS/toc.ncx', data: ncxPrefix },
    { name: 'OEBPS/c1.xhtml', data: body },
  ]);
  const d1 = await parseEPUB(zip1, 'p.epub');
  assert.equal(d1.meta.title, '前缀书');
  assert.equal(d1.meta.author, '前缀作者');
  assert.equal(d1.chapters[0].title, '前缀章');
  assert.equal(d1.chapters[0].paras[0].text, '章节');

  // ---- 完全无前缀版
  const opfPlain = `<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" unique-identifier="bookid">
  <metadata><title>无前缀书</title><creator>无名</creator><language>zh</language></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>`;
  const ncxPlain = `<?xml version="1.0"?>
<ncx version="2005-1"><navMap><navPoint id="a" playOrder="1">
  <navLabel><text>无前缀章</text></navLabel><content src="c1.xhtml"/>
</navPoint></navMap></ncx>`;
  const zip2 = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opfPlain },
    { name: 'OEBPS/toc.ncx', data: ncxPlain },
    { name: 'OEBPS/c1.xhtml', data: xhtml('<p>无前缀内容</p>', 'en') },
  ]);
  const d2 = await parseEPUB(zip2, 'q.epub');
  assert.equal(d2.meta.title, '无前缀书');
  assert.equal(d2.meta.author, '无名');
  assert.equal(d2.chapters[0].title, '无前缀章');
  assert.equal(d2.chapters[0].paras[0].text, '无前缀内容');
});

// ================================================================ 子目录 / 相对路径

test('子目录：OPF 与正文都在 OEBPS/，图片相对路径按各自文件解析', async () => {
  const opf = opf2({
    items: `    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="images/../images/p.png" media-type="image/png"/>`,
    spine: `    <itemref idref="c1"/>`,
  });
  const c1 = xhtml('<h1>子目录章</h1><p>正文</p><p><img src="../images/p.png" alt="p"/></p>');
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '子目录章', 'text/c1.xhtml')) },
    { name: 'OEBPS/text/c1.xhtml', data: c1 },
  ]);
  const doc = await parseEPUB(buf, 'sub.epub');
  assert.equal(doc.chapters.length, 1);
  assert.equal(doc.chapters[0].href, 'OEBPS/text/c1.xhtml');
  assert.equal(doc.chapters[0].title, '子目录章'); // ncx 在子目录里，相对 href 也解析成 EPUB 根路径
  const img = doc.chapters[0].paras.find((p) => p.type === 'img');
  assert.ok(img, '应当解析出图片');
  assert.equal(img.src, 'OEBPS/images/p.png'); // ../ 折叠后仍以 EPUB 根为基准
});

test('container.xml 里 rootfile 有多个时取第一个', async () => {
  const container2 = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/a.opf" media-type="application/oebps-package+xml"/>
    <rootfile full-path="OEBPS/b.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  const opfA = opf2({ title: '第一本', items: '    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', spine: '    <itemref idref="c1"/>' });
  const opfB = opf2({ title: '第二本', items: '    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', spine: '    <itemref idref="c1"/>' });
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: container2 },
    { name: 'OEBPS/a.opf', data: opfA },
    { name: 'OEBPS/b.opf', data: opfB },
    { name: 'OEBPS/c1.xhtml', data: xhtml('<p>x</p>') },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '一', 'c1.xhtml')) },
    { name: 'OEBPS/../OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '一', 'c1.xhtml')) },
  ]);
  const doc = await parseEPUB(buf, 'multi.epub');
  assert.equal(doc.meta.title, '第一本');
});

// ================================================================ 文本细节

test('内联标签混排：em/strong 顺序正确，br 变空格，script/style 不混进正文', async () => {
  const opf = opf2({ items: '    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', spine: '    <itemref idref="c1"/>' });
  const c1 = xhtml(`<h1>混排</h1>
<p>前<em>中</em>后</p>
<p><strong>全粗</strong>尾</p>
<p>甲<br/>乙<br/>丙</p>
<p>折行
   与空白</p>
<style>p { color: red; }</style>
<script>var a = 1 &amp;&amp; 2;</script>
<p>尾段</p>`);
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '混排', 'c1.xhtml')) },
    { name: 'OEBPS/c1.xhtml', data: c1 },
  ]);
  const doc = await parseEPUB(buf, 'mix.epub');
  const texts = doc.chapters[0].paras.map((p) => p.text);
  assert.deepEqual(texts, ['混排', '前中后', '全粗尾', '甲 乙 丙', '折行 与空白', '尾段']);
});

test('实体解码：&amp;/&lt;/&nbsp;/&mdash;/&hellip;/&ldquo; 与 &#xxx; 数字实体', async () => {
  const opf = opf2({ items: '    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', spine: '    <itemref idref="c1"/>' });
  const c1 = xhtml(`<h1>实体</h1>
<p>A&amp;B &lt;标签&gt; &quot;引号&quot; &apos;单引号&apos; &nbsp;窄空格</p>
<p>破折&mdash;号 省略&hellip;号</p>
<p>&ldquo;双引&rdquo;&lsquo;单引&rsquo;&middot;间隔</p>
<p>数字：&#20013;&#25991; &#x4E2D;&#x6587; &#x1F600;</p>`);
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '实体', 'c1.xhtml')) },
    { name: 'OEBPS/c1.xhtml', data: c1 },
  ]);
  const doc = await parseEPUB(buf, 'ent.epub');
  const texts = doc.chapters[0].paras.map((p) => p.text);
  assert.equal(texts[1], 'A&B <标签> "引号" \'单引号\' 窄空格'); // &nbsp; 折叠成普通空格
  assert.equal(texts[2], '破折—号 省略…号');
  assert.equal(texts[3], '“双引”‘单引’·间隔'); // &ldquo; 等弯引号实体必须解成弯引号本身，不是直角引号
  assert.equal(texts[4], '数字：中文 中文 😀');
});

test('块级嵌套不重复输出：blockquote>p、div>p、裸文本段落', async () => {
  const opf = opf2({ items: '    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', spine: '    <itemref idref="c1"/>' });
  const c1 = xhtml(`<div>
  <p>第一段</p>
  <div><p>第二段</p></div>
  <blockquote>
    <p>引文</p>
    <p>引文二</p>
    <div><p>引文三</p></div>
  </blockquote>
</div>
<div>裸文本<span>带内联</span></div>
<p></p>
<h2>   </h2>
<p>   &nbsp;  </p>`);
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '嵌套', 'c1.xhtml')) },
    { name: 'OEBPS/c1.xhtml', data: c1 },
  ]);
  const doc = await parseEPUB(buf, 'nest.epub');
  const paras = doc.chapters[0].paras;
  assert.deepEqual(paras.map((p) => p.text), ['第一段', '第二段', '引文', '引文二', '引文三', '裸文本带内联']);
  // 空段落（含纯空白 / 纯 &nbsp;）必须丢弃
  assert.equal(paras.length, 6);
  assert.ok(paras.every((p) => p.text.trim() !== ''));
});

// ================================================================ 封面

test('封面：properties="cover-image" 与 <meta name="cover"> 两种都要认', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const mk = (manifestItem, coverMeta) => {
    const opf = opf2({
      coverMeta,
      items: `    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
${manifestItem}`,
      spine: '    <itemref idref="c1"/>',
    });
    return buildZip([
      { name: 'mimetype', data: MIMETYPE },
      { name: 'META-INF/container.xml', data: CONTAINER },
      { name: 'OEBPS/content.opf', data: opf },
      { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '一', 'c1.xhtml')) },
      { name: 'OEBPS/c1.xhtml', data: xhtml('<p>x</p>') },
      { name: 'OEBPS/cover.png', data: png },
    ]);
  };

  const d1 = await parseEPUB(await mk('    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>', ''), 'c1.epub');
  assert.equal(d1.meta.cover, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);

  const d2 = await parseEPUB(await mk('    <item id="cover" href="cover.png" media-type="image/png"/>', '<meta name="cover" content="cover"/>'), 'c2.epub');
  assert.equal(d2.meta.cover, d1.meta.cover);

  // 没有封面时必须留 undefined，不能抛错
  const d3 = await parseEPUB(await mk('    <item id="other" href="x.png" media-type="image/png"/>', ''), 'c3.epub');
  assert.equal(d3.meta.cover, undefined);
  assert.ok(!('cover' in d3.meta));
});

// ================================================================ 错误路径

test('错误路径：非 zip / 缺 container.xml / ZIP64 / 缺 OPF 都要抛中文错误', async () => {
  // 1. 完全不是 zip
  const junk = new Uint8Array(2048).fill(0x41);
  await assert.rejects(() => parseEPUB(junk, 'bad.epub'), (e) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /不是有效的 EPUB/);
    assert.match(e.message, /[\u4e00-\u9fa5]/, '必须是中文提示');
    return true;
  });

  // 2. 是 zip 但没有 META-INF/container.xml
  const noContainer = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'OEBPS/content.opf', data: opf2({ items: '', spine: '' }) },
  ]);
  await assert.rejects(() => parseEPUB(noContainer, 'nc.epub'), /找不到 META-INF\/container\.xml/);

  // 3. container.xml 在但 OPF 不存在
  const noOpf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
  ]);
  await assert.rejects(() => parseEPUB(noOpf, 'no.epub'), /找不到 OPF 文件/);

  // 4. OPF 在但 spine 全空 → 没有可读正文
  const emptySpine = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf2({ items: '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>', spine: '' }) },
  ]);
  await assert.rejects(() => parseEPUB(emptySpine, 'es.epub'), /spine 是空的/);

  // 5. 压缩数据被破坏（CRC 无所谓，我们不做校验，但要能报错而不是静默）
  const good = await miniEpub2();
  const broken = good.slice();
  for (let i = 60; i < 120; i++) broken[i] = 0x00; // 打烂第一个 deflate 数据块
  await assert.rejects(() => parseEPUB(broken, 'broken.epub'), (e) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /[\u4e00-\u9fa5]/);
    return true;
  });

  // 6. ZIP64：EOCD 前塞一个 ZIP64 EOCD locator
  const zip = await miniEpub2();
  const withZip64 = new Uint8Array(zip.length + 20);
  withZip64.set(zip.subarray(0, zip.length - 22), 0);
  const dv = new DataView(withZip64.buffer);
  const locPos = zip.length - 22;
  dv.setUint32(locPos, 0x07064b50, true); // zip64 EOCD locator 签名
  dv.setUint32(locPos + 4, 0, true);
  dv.setBigUint64(locPos + 8, BigInt(zip.length - 22), true);
  dv.setUint32(locPos + 16, 1, true);
  withZip64.set(zip.subarray(zip.length - 22), locPos + 20);
  await assert.rejects(() => parseEPUB(withZip64, 'z64.epub'), /ZIP64/);
});

test('容错：未闭合标签 / 脏 XHTML 不抛错，能读到能读的内容', async () => {
  const opf = opf2({ items: '    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', spine: '    <itemref idref="c1"/>' });
  const c1 = xhtml('<p>第一段<p>第二段</div></span><p>第三段');
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '脏', 'c1.xhtml')) },
    { name: 'OEBPS/c1.xhtml', data: c1 },
  ]);
  const doc = await parseEPUB(buf, 'dirty.epub');
  assert.equal(doc.chapters.length, 1);
  const texts = doc.chapters[0].paras.map((p) => p.text);
  assert.ok(texts.includes('第一段'));
  assert.ok(texts.includes('第三段'));
});

// ================================================================ 大文件

test('大文件不爆栈：约 2MB 的章节正文能解析完', async () => {
  const opf = opf2({ items: '    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', spine: '    <itemref idref="c1"/>' });
  // 一个汉字在 UTF-8 里是 3 字节，每段约 79 字符 ≈ 205 字节，
  // 20000 段才稳稳超过 1.5MB（原来写 12000 段实际只有 937KB，
  // 断言先于解析失败，这条测试等于一直没在测它想测的东西）
  const N = 20000;
  let body = '<h1>大章</h1>\n';
  for (let i = 0; i < N; i++) body += `<p>第 ${i} 段，${'字'.repeat(60)}。</p>\n`;
  const c1 = xhtml(body);
  assert.ok(c1.length > 1_500_000, `素材应当 > 1.5MB，实际 ${c1.length}`);
  const buf = await buildZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx(navPoint('n1', '1', '大章', 'c1.xhtml')) },
    { name: 'OEBPS/c1.xhtml', data: c1 },
  ]);
  const doc = await parseEPUB(buf, 'big.epub');
  assert.equal(doc.chapters.length, 1);
  assert.equal(doc.chapters[0].paras.length, N + 1);
  assert.equal(doc.chapters[0].paras[1].text, `第 0 段，${'字'.repeat(60)}。`);
  assert.equal(doc.chapters[0].paras[N].text, `第 ${N - 1} 段，${'字'.repeat(60)}。`);

  // 平级兄弟节点很多的 TXT 也不能爆栈
  const lines = [];
  for (let i = 0; i < 60000; i++) lines.push(`第${i}行的内容`);
  const txt = lines.join('\n\n');
  const tdoc = parseTXT(new TextEncoder().encode(txt), 'big.txt');
  assert.equal(tdoc.chapters.length, 1);
  assert.equal(tdoc.chapters[0].paras.length, 60000);
});

// ================================================================ TXT

test('TXT：硬换行 + 空行分段（中文 TXT 最常见形态）', () => {
  // 每一行都硬换行，段与段之间空一行
  const src = [
    '第一章 起风了',
    '',
    '第一段的头一行',
    '第一段的第二行',
    '第一段的第三行',
    '',
    '第二段只有一行',
    '',
    '第二章 落雨了',
    '',
    '另一段的内容',
  ].join('\n');
  const doc = parseTXT(new TextEncoder().encode(src), '小说.txt', 12345);

  assert.equal(doc.meta.format, 'txt');
  assert.equal(doc.meta.title, '小说');
  assert.equal(doc.meta.author, '');
  assert.equal(doc.meta.id, `小说.txt|${new TextEncoder().encode(src).byteLength}|12345`);
  assert.equal(doc.chapters.length, 2);
  assert.equal(doc.meta.chapterCount, 2);

  const [c0, c1] = doc.chapters;
  assert.equal(c0.title, '第一章 起风了');
  assert.equal(c1.title, '第二章 落雨了');

  // 标题行保留为章内第一个 h2 段落
  assert.equal(c0.paras[0].type, 'h2');
  assert.equal(c0.paras[0].text, '第一章 起风了');
  // 硬换行的三行 = 一段（不是三段）
  assert.deepEqual(c0.paras.map((p) => p.text), [
    '第一章 起风了',
    '第一段的头一行第一段的第二行第一段的第三行',
    '第二段只有一行',
  ]);
  assert.deepEqual(c1.paras.map((p) => p.text), ['第二章 落雨了', '另一段的内容']);

  const sum = doc.chapters.reduce((n, c) => n + c.text.length, 0);
  assert.equal(doc.meta.charCount, sum);
});

test('TXT：Chapter N / CHAPTER N / 第N节 / 第N回 都要认', () => {
  const src = ['Chapter 1', 'alpha', '', 'CHAPTER 2', 'beta', '', '第三节', 'gamma', '', '第四回', 'delta'].join('\n');
  const doc = parseTXT(new TextEncoder().encode(src), 'en.txt');
  assert.deepEqual(doc.chapters.map((c) => c.title), ['Chapter 1', 'CHAPTER 2', '第三节', '第四回']);
  assert.deepEqual(doc.chapters.map((c) => c.paras[0].type), ['h2', 'h2', 'h2', 'h2']);
});

test('TXT：短行标题兜底（下一段是长正文才认），短对话不被误切', () => {
  const src = ['觉醒', '', `${'这是很长的正文。'.repeat(5)}`, '', '启程', '', `${'又一段长正文。'.repeat(5)}`].join('\n');
  const doc = parseTXT(new TextEncoder().encode(src), 's.txt');
  assert.deepEqual(doc.chapters.map((c) => c.title), ['觉醒', '启程']);

  // 短对话行后面跟的也是短行 → 不当标题，整本一章
  const novel = ['“你来了。”', '', '“嗯。”', '', '“走吧。”'].join('\n');
  const d2 = parseTXT(new TextEncoder().encode(novel), 'n.txt');
  assert.equal(d2.chapters.length, 1);
  assert.equal(d2.chapters[0].title, '正文');
});

test('TXT：没有章节标记时整本作为一章「正文」', () => {
  const src = ['很久很久以前。', '', '有一座山。'].join('\n');
  const doc = parseTXT(new TextEncoder().encode(src), 'x.txt');
  assert.equal(doc.chapters.length, 1);
  assert.equal(doc.chapters[0].title, '正文');
  assert.equal(doc.chapters[0].paras.length, 2);
  assert.equal(doc.chapters[0].index, 0);
  assert.equal(doc.chapters[0].depth, 0);
});

test('TXT：章节标记之前的内容作为「前言」保留', () => {
  const src = ['这是版权信息。', '', '第一章 开始', '', '正文内容。'].join('\n');
  const doc = parseTXT(new TextEncoder().encode(src), 'p.txt');
  assert.deepEqual(doc.chapters.map((c) => c.title), ['前言', '第一章 开始']);
  assert.equal(doc.chapters[0].paras[0].text, '这是版权信息。');
});

test('TXT：CRLF 与英文硬换行', () => {
  const src = 'Chapter 1\r\n\r\nThe quick brown\r\nfox jumps over\r\n\r\nthe lazy dog.';
  const doc = parseTXT(new TextEncoder().encode(src), 'e.txt');
  assert.equal(doc.chapters.length, 1);
  assert.deepEqual(doc.chapters[0].paras.map((p) => p.text), [
    'Chapter 1',
    'The quick brown fox jumps over', // 英文硬换行补空格，不粘成一个词
    'the lazy dog.',
  ]);
});

// ================================================================ 编码嗅探

test('detectCharset：BOM 优先，其次 UTF-8 / GB18030 / Big5', () => {
  const te = new TextEncoder();
  // UTF-8 BOM
  assert.equal(detectCharset(concatBytes([new Uint8Array([0xef, 0xbb, 0xbf]), te.encode('中文')])), 'utf-8');
  // UTF-16LE BOM
  assert.equal(detectCharset(concatBytes([new Uint8Array([0xff, 0xfe]), te.encode('a')])), 'utf-16le');
  // UTF-16BE BOM
  assert.equal(detectCharset(concatBytes([new Uint8Array([0xfe, 0xff]), te.encode('a')])), 'utf-16be');
  // 无 BOM 的 UTF-8
  assert.equal(detectCharset(te.encode('中文 UTF-8 没有 BOM')), 'utf-8');
  // ASCII 也算 UTF-8
  assert.equal(detectCharset(te.encode('hello world')), 'utf-8');
  // GB18030：手工构造「中文」两字的 GBK 字节（D6 D0 CE C4），不是合法 UTF-8
  const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xa1, 0xa3]);
  assert.equal(detectCharset(gbkBytes), 'gbk');

  // GBK 文本能被 parseTXT 正确解码
  const gbkSrc = concatBytes([gbkBytes, new Uint8Array([0x0a, 0x0a]), new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])]);
  const doc = parseTXT(gbkSrc, 'gbk.txt');
  assert.equal(doc.chapters[0].paras.length, 2);
  assert.equal(doc.chapters[0].paras[0].text, '中文。');
  assert.equal(doc.chapters[0].paras[1].text, '中文');
});

test('parseTXT：UTF-16LE BOM 的文本能解出中文', () => {
  const s = '第一章 你好\n\n正文内容。';
  const le = new Uint8Array(2 + s.length * 2);
  le[0] = 0xff;
  le[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    le[2 + i * 2] = c & 0xff;
    le[3 + i * 2] = (c >> 8) & 0xff;
  }
  const doc = parseTXT(le, 'u16.txt');
  assert.equal(doc.chapters.length, 1);
  assert.equal(doc.chapters[0].title, '第一章 你好');
  assert.equal(doc.chapters[0].paras[1].text, '正文内容。');
});
