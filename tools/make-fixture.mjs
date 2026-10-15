/* ============================================================
   陪读 · 造测试用书
   ------------------------------------------------------------
   为什么要一个真的 .epub 文件落盘：
   之前所有测试都是"在内存里造字节"，能证明解析器对，但证明不了
   「用户把文件拖进来之后会发生什么」。要做这个验证就必须有一个
   真实文件，让浏览器自己的 File/DataTransfer 路径去读它。

   这个脚本刻意不引任何依赖 —— 它用 node:zlib 压缩、用 core/zip.js
   自己的 crc32 算校验和，跟产品代码走的是同一套 CRC 实现。

   用法：node tools/make-fixture.mjs
   产出：.fixtures/测试书.epub、.fixtures/测试书.txt
   ============================================================ */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { crc32 } from '../site/js/core/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.fixtures');

/* ---------------------------- 最小 ZIP 写入器 ---------------------------- */

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * @param {Array<{name:string, data:string|Buffer, store?:boolean}>} items
 */
function makeZip(items) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const it of items) {
    const nameBuf = Buffer.from(it.name, 'utf8');
    const raw = Buffer.isBuffer(it.data) ? it.data : Buffer.from(it.data, 'utf8');
    // 只有 mimetype 必须 stored（EPUB 规范要求它第一个出现且不压缩）
    const stored = it.store === true;
    const body = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;
    const crc = crc32(new Uint8Array(raw));

    const lh = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(method),
      u16(0), // time
      u16(0), // date
      u32(crc),
      u32(body.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0), // extra len
      nameBuf,
    ]);

    locals.push(lh, body);

    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed
        u16(0),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(body.length),
        u32(raw.length),
        u16(nameBuf.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset),
        nameBuf,
      ])
    );

    offset += lh.length + body.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(items.length),
    u16(items.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);

  return Buffer.concat([...locals, central, eocd]);
}

/* ---------------------------- 内容 ---------------------------- */

// 每章段落写得足够多（12 段以上），否则在 800×600 的窗口里整章一页就装完了，
// 「翻页」这条路径根本没被走到 —— 自检脚本要能看见分页真的在分。
const CHAPTERS = [
  {
    file: 'ch1.xhtml',
    title: '第一章 雨夜',
    body: `
      <h1>第一章 雨夜</h1>
      <p>雨从傍晚就开始下，一直没停。他把伞留在了门口的鞋柜上，自己却站在屋檐下等。</p>
      <p>街对面的灯牌闪了两下，灭了。他数着自己的呼吸，数到四十七的时候，终于有人从楼里出来。</p>
      <p>「你怎么还在这儿。」那人说，语气里没有惊讶，像是早就知道他会站在这里。</p>
      <p>他没有回答。雨水顺着屋檐的边缘连成一条线，落在两个人中间的水泥地上，砸出一小片深色。</p>
      <p>「伞呢？」</p>
      <p>「忘带了。」他说。这是今天第一句谎话，他自己听得出来，对方大概也听得出来。</p>
      <p>两个人就这么站着，谁也没提要走。楼道的声控灯亮了又灭，灭了又亮。</p>
      <p>最后还是那人先转身，往巷子口走。他跟上去，保持着两步的距离，不远也不近。</p>
      <p>巷子很窄，两边的墙把雨声关在里面，听起来像是有人在很远的地方拍手。</p>
      <p>走到一半，前面的人停下来，回过头看他一眼，什么也没说，又继续走。</p>
      <p>巷子尽头是一家还开着的小卖部，卷闸门拉下来一半，里面亮着一盏日光灯，白得发青。</p>
      <p>「买包烟。」那人说。他站在门口没进去，看着柜台后面那个打瞌睡的老头慢慢直起身子。</p>
      <p>老头把烟推过来，找零的时候多给了一块。那人没作声，把钱揣进兜里，转身就走。</p>
      <p>他跟出去，雨比刚才小了。两个人走在同一条窄路上，影子被路灯拉长又缩短，缩短又拉长。</p>
      <p>「你跟着我干什么。」那人头也不回地问。</p>
      <p>「没跟着你。」他说，「我也往这边走。」</p>
      <p>这话是真的。他确实住这边。可他今天本来不用走这条路，绕一下能多花十分钟。</p>`,
  },
  {
    file: 'ch2.xhtml',
    title: '第二章 账本',
    body: `
      <h1>第二章 账本</h1>
      <p>账本放在抽屉最底下，压着一沓过期的水电费单子。</p>
      <p>翻开第一页，字迹是父亲的，横平竖直，每一笔都像是用尺子量过。</p>
      <p>收：三月十七，卖旧铜锁一把，八毛。</p>
      <p>支：三月十八，买盐，一毛二。</p>
      <p>这样的账记了整整十一年，没有一天断过。他一行一行往下看，看到第七页的时候停住了。</p>
      <p>三月十七这一天，除了卖铜锁，还有一笔支出：二块四，理发。</p>
      <p>父亲一辈子没进过理发店。头发都是母亲拿剪子铰的，铰得参差不齐，他也不在乎。</p>
      <p>他把这一页举起来对着灯看，纸的纤维里透出淡淡的黄。那一行字压得很重，笔尖在纸上顿了一下才划过去。</p>
      <p>窗外雨还在下。他忽然想起来，三月十七是他的生日。</p>
      <p>他把账本合上，又打开，翻回那一页。数字没变，还是二块四。</p>
      <p>抽屉里还有些别的东西：一枚生了锈的钥匙，一张折成四折的车票，半个用完的橡皮。</p>
      <p>车票的日期比账本上的那笔支出晚了三天，起点是本市，终点是一个他没听说过的县城。</p>
      <p>他打开手机查那个地名。地图上只有一个小点，标注着「已撤销」。</p>
      <p>楼下传来关门的声音，很轻，但他听见了。他把账本塞回抽屉，压上那沓单子，动作太快，一张单子飘到了地上。</p>
      <p>他弯腰去捡，看见单子的背面有字，是铅笔写的，已经模糊了，只认得出两个字：别找。</p>`,
  },
  {
    file: 'ch3.xhtml',
    title: '第三章 白天',
    body: `
      <h1>第三章 白天</h1>
      <p>第二天早上雨停了，路面还是湿的。他出门的时候特意绕开了昨天晚上走过的那条巷子。</p>
      <p>公司在十七楼，电梯里挤满了人，每个人都在看手机。他也在看，屏幕上是一张地图。</p>
      <p>那个县城在省界边上，坐大巴要四个小时。他查了班次，早上八点一班，下午两点一班。</p>
      <p>一整个上午他都在开会。会议内容是下季度的预算，他一句也没听进去，笔记上画满了毫无意义的圆圈。</p>
      <p>中午他在楼下吃面，旁边桌两个人在争论一部电影。他听着听着，忽然想起父亲从来没带他看过电影。</p>
      <p>回到工位，他给母亲打了个电话。响了很久才接，那边在打麻将，哗啦哗啦的声音盖过人声。</p>
      <p>「你爸的东西？早扔了。」母亲说，「留着干什么。」</p>
      <p>他嗯了一声，没说自己找到了什么。挂电话之前，母亲问他要不要回家吃饭，他说下周吧。</p>
      <p>下午三点，他把那个县城的地名又输进搜索框，加了一个词：理发店。</p>
      <p>结果只有三条，最新的一条是九年前的，说镇上最后一家理发店关门了，老板去了南方。</p>
      <p>他盯着那行字看了很久，然后关掉页面，把手机扣在桌上。</p>
      <p>下班的时候，他没有走平时那条路，而是拐进了一家还开着的文具店。</p>
      <p>「有没有账本？」他问。老板从柜台底下拖出一摞，蓝皮的、黑皮的、硬壳的。</p>
      <p>他挑了一本和家里那本一样的，蓝皮，横格，二块五。走出店门的时候天已经黑了。</p>`,
  },
];

function makeEpub({ title = '雨夜账本', author = '测试作者' } = {}) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:peidu-fixture-0001</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${CHAPTERS.map((c, i) => `<item id="c${i + 1}" href="${c.file}" media-type="application/xhtml+xml"/>`).join('\n    ')}
    <item id="px" href="px.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    ${CHAPTERS.map((c, i) => `<itemref idref="c${i + 1}"/>`).join('\n    ')}
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc"><ol>
    ${CHAPTERS.map((c) => `<li><a href="${c.file}">${c.title}</a></li>`).join('\n    ')}
  </ol></nav>
</body>
</html>`;

  const xhtml = (c) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${c.title}</title></head>
<body>${c.body}
<img src="px.png" alt=""/>
</body>
</html>`;

  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    ...CHAPTERS.map((c) => ({ name: `OEBPS/${c.file}`, data: xhtml(c) })),
    { name: 'OEBPS/px.png', data: png },
  ]);
}

function makeTxt() {
  const out = ['雨夜账本', '测试作者', ''];
  for (const c of CHAPTERS) {
    out.push(c.title, '');
    // 从 XHTML body 里把 <p> 的文字抽出来（这里只用最简单的正则，
    // 因为 body 是自己写的、格式完全可控；第一版我写的 `/^<[^>]+>$/`
    // 只匹配"整行就是一个标签"的情况，结果把正文全滤掉了，产出 62 字节的空书）
    for (const m of c.body.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
      out.push(m[1].trim(), '');
    }
  }
  return out.join('\n');
}

/* ---------------------------- 落盘 ---------------------------- */

mkdirSync(OUT, { recursive: true });
const epubPath = path.join(OUT, '测试书.epub');
const txtPath = path.join(OUT, '测试书.txt');
writeFileSync(epubPath, makeEpub());
writeFileSync(txtPath, makeTxt(), 'utf8');

console.log(`✓ ${epubPath}  ${(await import('node:fs')).statSync(epubPath).size} 字节`);
console.log(`✓ ${txtPath}  ${(await import('node:fs')).statSync(txtPath).size} 字节`);
