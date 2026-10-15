/* ============================================================
   zip.js 的测试。
   ------------------------------------------------------------
   关键原则：**不引入任何 zip 库**，测试用的 zip 字节全部由本文件手工构造。
   如果用一个第三方库来造测试数据、再用自己写的代码去读，那就等于在测
   「我猜的格式」和「它猜的格式」是否一致，而不是在测规范 —— 这种测试
   在真实 EPUB 上照样会挂。手工构造的字节（含 CRC32、含 data descriptor）
   才是对照 ZIP 规范（APPNOTE 4.3.16）的真凭证。
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import {
  ZipArchive,
  openZip,
  crc32,
  decodeText,
  normalizeEncoding,
  sniffCharset,
  resolvePath,
  dirname,
  basename,
  extname,
  canDecompress,
} from '../site/js/core/zip.js';

/* ---------------------------- 手工造 zip ---------------------------- */

function str(s) {
  return new TextEncoder().encode(s);
}

/**
 * 把若干条目打包成一个 zip 的字节。
 * @param {Array<{name:string, data:Uint8Array|string, deflate?:boolean,
 *               descriptor?:boolean, zip64?:boolean}>} items
 */
function makeZip(items) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const it of items) {
    const nameBytes = str(it.name);
    const data = typeof it.data === 'string' ? str(it.data) : it.data;
    const useDeflate = !!it.deflate;
    const body = useDeflate ? new Uint8Array(deflateRawSync(Buffer.from(data))) : data;
    const crc = crc32(data);
    const flag = it.descriptor ? 0x0008 : 0; // bit 3 = data descriptor
    const method = useDeflate ? 8 : 0;

    // local header 40 字节 = 30 固定 + 10 extra
    const localHead = new Uint8Array(30 + nameBytes.length + 10);
    const lv = new DataView(localHead.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, flag, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0x21, true); // date（1980-01-01）
    lv.setUint32(14, crc, true);
    // ★ data descriptor 的核心坑：local header 里这两个字段是 0，
    //   顺扫 local header 的实现到这里就会把「文件数据长度」当成 0。
    lv.setUint32(18, it.descriptor ? 0 : body.length, true);
    lv.setUint32(22, it.descriptor ? 0 : data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 10, true); // extra len（造一段无用的 extra，验证会被跳过）
    localHead.set(nameBytes, 30);

    locals.push(localHead, body);
    if (it.descriptor) {
      const dd = new Uint8Array(16);
      const dv = new DataView(dd.buffer);
      dd[0] = 0x50;
      dd[1] = 0x4b;
      dd[2] = 0x07;
      dd[3] = 0x08;
      dv.setUint32(4, crc, true);
      dv.setUint32(8, body.length, true);
      dv.setUint32(12, data.length, true);
      locals.push(dd);
    }

    const cenHead = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cenHead.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flag, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    // ★ 目录里的大小**永远是真的**，哪怕用了 data descriptor
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header 相对偏移
    cenHead.set(nameBytes, 46);
    centrals.push(cenHead);

    offset += localHead.length + body.length + (it.descriptor ? 16 : 0);
  }

  const cenSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const all = [...locals, ...centrals, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 造一个最小的合法 EPUB（含未压缩的 mimetype，规范要求它必须是第一个条目） */
function makeEpub() {
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' }, // ★ 必须 stored
    { name: 'META-INF/container.xml', data: '<container/>', deflate: true },
    { name: 'OEBPS/content.opf', data: '<package/>', deflate: true },
    { name: 'OEBPS/Text/ch1.xhtml', data: '<html>第一章</html>', deflate: true },
  ]);
}

/* ---------------------------- 测试 ---------------------------- */

test('crc32 对已知向量正确', () => {
  // "123456789" 的 CRC32 = 0xCBF43926，这是 CRC32 的标准测试向量
  assert.equal(crc32(str('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('读 uncompressed（stored）条目', async () => {
  const zip = openZip(makeEpub());
  assert.equal(await zip.readText('mimetype'), 'application/epub+zip');
});

test('读 deflate 条目', async () => {
  const zip = openZip(makeEpub());
  assert.equal(await zip.readText('OEBPS/Text/ch1.xhtml'), '<html>第一章</html>');
});

test('中文内容 deflate 往返不乱码', async () => {
  const text = '这是一段中文正文，包含标点：「引号」、破折号——以及省略号……'.repeat(40);
  const zip = openZip(makeZip([{ name: 'a.txt', data: text, deflate: true }]));
  assert.equal(await zip.readText('a.txt'), text);
});

test('data descriptor 的条目也能读（local header 大小字段是 0）', async () => {
  // 这是「顺扫 local header」实现的经典翻车场景
  const zip = openZip(
    makeZip([
      { name: 'first.txt', data: '第一个文件的内容', deflate: true, descriptor: true },
      { name: 'second.txt', data: '第二个文件的内容', deflate: true, descriptor: true },
    ])
  );
  assert.equal(await zip.readText('first.txt'), '第一个文件的内容');
  assert.equal(await zip.readText('second.txt'), '第二个文件的内容');
});

test('条目名含子目录与中文也能取到', async () => {
  const zip = openZip(
    makeZip([{ name: 'OEBPS/Text/第 1 章.xhtml', data: '<p>hi</p>', deflate: true }])
  );
  assert.ok(zip.has('OEBPS/Text/第 1 章.xhtml'));
  assert.equal(await zip.readText('OEBPS/Text/第 1 章.xhtml'), '<p>hi</p>');
  assert.deepEqual(zip.names, ['OEBPS/Text/第 1 章.xhtml']);
});

test('EOCD 后面跟着注释也能找到目录', async () => {
  const base = makeEpub();
  const comment = str('zip comment'); // 10 字节，注释长度字段必须与它一致
  const withComment = new Uint8Array(base.length + comment.length);
  withComment.set(base, 0);
  // 把注释长度字段改成实际长度，并填上注释内容
  new DataView(withComment.buffer).setUint16(base.length - 2, comment.length, true);
  withComment.set(comment, base.length);
  const zip = openZip(withComment);
  assert.equal(await zip.readText('mimetype'), 'application/epub+zip');
});

test('解压结果 CRC 不对时报错（而不是把坏数据当正文）', async () => {
  const bytes = makeEpub();
  // 篡改 ch1 的压缩数据：定位到它 local header 之后改写一个字节
  const zip0 = openZip(bytes);
  const e = zip0.entry('OEBPS/Text/ch1.xhtml');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = dv.getUint16(e.localOffset + 26, true);
  const extraLen = dv.getUint16(e.localOffset + 28, true);
  bytes[e.localOffset + 30 + nameLen + extraLen + 1] ^= 0xff;

  const zip = openZip(bytes);
  await assert.rejects(() => zip.read('OEBPS/Text/ch1.xhtml'), /损坏|校验/);
});

test('不是 zip 的文件给出面向用户的错误', () => {
  assert.throws(() => openZip(str('这只是一段普通文本，根本不是 zip 文件的内容'.repeat(4))), /不是 zip|不像是一个 EPUB/);
});

test('截断的文件（EOCD 丢了）给出清楚错误', () => {
  const bytes = makeEpub();
  const cut = bytes.subarray(0, 60);
  assert.throws(() => openZip(cut), /不是 zip|太小/);
});

test('取不存在的条目抛错', async () => {
  const zip = openZip(makeEpub());
  await assert.rejects(() => zip.read('nope.txt'), /找不到/);
});

test('重复读取命中缓存且结果一致', async () => {
  const zip = openZip(makeEpub());
  const a = await zip.read('OEBPS/content.opf');
  const b = await zip.read('OEBPS/content.opf');
  assert.equal(a, b); // 同一个对象引用 = 走了缓存
  zip.dispose();
  const c = await zip.read('OEBPS/content.opf');
  assert.notEqual(a, c); // dispose 后重新解压
  assert.deepEqual([...c], [...a]);
});

test('大文件不炸栈（1.5MB 文本，deflate）', async () => {
  const big = '这是一行比较长的中文正文，用来把压缩后的数据撑到一定体积。\n'.repeat(30000);
  const zip = openZip(makeZip([{ name: 'big.txt', data: big, deflate: true }]));
  const out = await zip.readText('big.txt');
  assert.equal(out.length, big.length);
  assert.equal(out.slice(0, 20), big.slice(0, 20));
});

test('中央目录在半路中断时保留已读条目', async () => {
  const items = [
    { name: 'a.txt', data: 'AAA', deflate: true },
    { name: 'b.txt', data: 'BBB', deflate: true },
    { name: 'c.txt', data: 'CCC', deflate: true },
  ];
  const bytes = makeZip(items);
  const zip0 = openZip(bytes);
  // 把 b 条目的目录项签名破坏掉，模拟目录损坏
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cenOff = dv.getUint32(bytes.length - 22 + 16, true);
  const bLen = 46 + str('a.txt').length;
  // 第三个条目（c）的签名改成垃圾
  dv.setUint32(cenOff + bLen * 2, 0xdeadbeef, true);

  const zip = openZip(bytes);
  assert.ok(zip.has('a.txt'));
  assert.ok(zip.has('b.txt'));
  assert.equal(zip.has('c.txt'), false);
  assert.equal(await zip0.readText('a.txt'), 'AAA');
});

/* ---- 文本解码 ---- */

test('decodeText：UTF-8 BOM', () => {
  const body = str('第一章 起风了');
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf], 0);
  withBom.set(body, 3);
  assert.equal(decodeText(withBom), '第一章 起风了');
});

test('decodeText：UTF-16LE BOM', () => {
  // 「第一章」的 UTF-16LE 码元：第 U+7B2C / 一 U+4E00 / 章 U+7AE0
  const buf = new Uint8Array([0xff, 0xfe, 0x2c, 0x7b, 0x00, 0x4e, 0xe0, 0x7a]);
  assert.equal(decodeText(buf), '第一章');
});

test('decodeText：GBK 的中文不变成乱码', () => {
  // 「中文」的 GBK 编码：D6 D0 CE C4
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
  if (normalizeEncoding('gbk') && canDecodeGbk()) {
    assert.equal(decodeText(gbk, 'gbk'), '中文');
  } else {
    // 浏览器没实现 GBK 时只能退化：至少不能抛异常
    assert.equal(typeof decodeText(gbk, 'gbk'), 'string');
  }
});

function canDecodeGbk() {
  try {
    new TextDecoder('gbk');
    return true;
  } catch {
    return false;
  }
}

test('decodeText：非法 UTF-8 走宽松兜底而不是抛错', () => {
  const bad = new Uint8Array([0x41, 0xff, 0xfe, 0x42]);
  const out = decodeText(bad);
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('A'));
});

test('normalizeEncoding 把常见别名归一', () => {
  assert.equal(normalizeEncoding('UTF8'), 'utf-8');
  assert.equal(normalizeEncoding('"gb2312"'), 'gbk');
  assert.equal(normalizeEncoding('GB18030'), 'gb18030');
  assert.equal(normalizeEncoding(''), '');
});

test('sniffCharset 认 XML 声明与 meta', () => {
  assert.equal(sniffCharset(str('<?xml version="1.0" encoding="GBK"?><html/>')), 'GBK');
  assert.equal(sniffCharset(str('<html><head><meta charset="utf-8">')), 'utf-8');
  assert.equal(sniffCharset(str('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312">')), 'gb2312');
  assert.equal(sniffCharset(str('<html><head></head>')), '');
});

/* ---- 路径 ---- */

test('resolvePath：同级 / 上级 / 下级 / 绝对 / 多余斜杠', () => {
  assert.equal(resolvePath('OEBPS/content.opf', 'Text/ch1.xhtml'), 'OEBPS/Text/ch1.xhtml');
  assert.equal(resolvePath('OEBPS/content.opf', '../Text/ch1.xhtml'), 'Text/ch1.xhtml');
  assert.equal(resolvePath('OEBPS/Text/ch1.xhtml', 'ch2.xhtml'), 'OEBPS/Text/ch2.xhtml');
  assert.equal(resolvePath('OEBPS/content.opf', '/Text/ch1.xhtml'), 'Text/ch1.xhtml');
  assert.equal(resolvePath('content.opf', 'Text/ch1.xhtml'), 'Text/ch1.xhtml');
  assert.equal(resolvePath('a/b/c.opf', './x/../y/z.xhtml'), 'a/b/y/z.xhtml');
  assert.equal(resolvePath('a/b/c.opf', ''), 'a/b/c.opf');
});

test('resolvePath：不会穿出根目录', () => {
  assert.equal(resolvePath('content.opf', '../../etc/passwd'), 'etc/passwd');
});

test('resolvePath：绝对 URL 原样返回（交给上层丢弃）', () => {
  assert.equal(resolvePath('a/b.opf', 'https://x.com/y.png'), 'https://x.com/y.png');
});

test('dirname / basename / extname', () => {
  assert.equal(dirname('a/b/c.xhtml'), 'a/b');
  assert.equal(dirname('c.xhtml'), '');
  assert.equal(basename('a/b/c.xhtml'), 'c.xhtml');
  assert.equal(basename('c.xhtml'), 'c.xhtml');
  assert.equal(extname('a/b/C.XHTML'), 'xhtml');
  assert.equal(extname('a/b/noext'), '');
  assert.equal(extname('a/b/.hidden'), '');
});

/* ---- 能力 ---- */

test('当前运行环境支持 deflate-raw（Node 18.11+ / Safari 16.4+ 都支持）', () => {
  assert.equal(canDecompress(), true);
});
