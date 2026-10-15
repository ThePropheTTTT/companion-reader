// test/xml.test.js —— core/xml.js 的行为契约
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXML, findAll, findFirst, attr, decodeEntities } from '../site/js/core/xml.js';

const text = (n) => n.text;
const kids = (n) => n.children.filter((c) => c.name !== '');

test('parseXML: 基本元素 / children / text / start', () => {
  const { root, nodes } = parseXML('<a>hello</a>');
  assert.equal(nodes.length, 1);
  const a = nodes[0];
  assert.equal(a.name, 'a');
  assert.equal(a.local, 'a');
  assert.equal(a.text, 'hello');
  assert.equal(a.allText, 'hello');
  assert.equal(a.start, 0);
  // children 里含文本节点（name === ''），但元素子节点为 0
  assert.equal(a.children.filter((c) => c.name !== '').length, 0);
  assert.equal(a.children.length, 1);
  assert.equal(a.children[0].start, 1);
  assert.deepEqual(a.attrs, {});
  // 合成 root：name === ''
  assert.equal(root.name, '');
  assert.equal(root.start, 0);
  assert.equal(root.children.length, 1);
  // 文本节点的 start === 1
  const { nodes: ns2 } = parseXML('<a>x<b>y</b>z</a>');
  const mixed = ns2[0].children;
  assert.equal(mixed.length, 3);
  assert.equal(mixed[0].name, '');
  assert.equal(mixed[0].start, 1);
  assert.equal(mixed[0].text, 'x');
  assert.equal(mixed[1].name, 'b');
  assert.equal(mixed[2].text, 'z');
});

test('parseXML: 直接文本不递归进子元素，allText 递归且顺序正确', () => {
  const { nodes } = parseXML('<p>甲<em>乙</em>丙</p>');
  const p = nodes[0];
  assert.equal(p.text, '甲丙');
  assert.equal(p.allText, '甲乙丙');
});

test('parseXML: 自闭合标签', () => {
  const { nodes } = parseXML('<p>a<br/>b<img src="x.png"/></p>');
  const p = nodes[0];
  assert.equal(p.children.length, 4);
  assert.equal(p.children[1].name, 'br');
  assert.equal(p.children[1].children.length, 0);
  assert.equal(p.children[3].name, 'img');
  assert.equal(p.children[3].attrs.src, 'x.png');
  assert.equal(p.text, 'ab');
  // 带空格的 `<br />`
  const { nodes: ns } = parseXML('<p>a<br />b</p>');
  assert.equal(ns[0].text, 'ab');
  assert.equal(ns[0].children[1].name, 'br');
});

test('parseXML: 属性含 > / 空格 / 单引号 / 无引号', () => {
  const { nodes } = parseXML(`<a title="a > b" href="x/y.html">t</a>`);
  assert.equal(nodes[0].attrs.title, 'a > b');
  assert.equal(nodes[0].attrs.href, 'x/y.html');
  assert.equal(nodes[0].text, 't');

  const { nodes: n2 } = parseXML(`<a title='it&apos;s' data-x="1 2">t</a>`);
  assert.equal(n2[0].attrs.title, "it's");
  assert.equal(n2[0].attrs['data-x'], '1 2');

  const { nodes: n3 } = parseXML('<a href=page1.xhtml class=cls>t</a>');
  assert.equal(n3[0].attrs.href, 'page1.xhtml');
  assert.equal(n3[0].attrs.class, 'cls');
  assert.equal(n3[0].text, 't');

  // 属性值里的实体已解码
  const { nodes: n4 } = parseXML('<a href="a&amp;b.xhtml">t</a>');
  assert.equal(n4[0].attrs.href, 'a&b.xhtml');

  // 属性值里带 '/' 不会被当成自闭合
  const { nodes: n5 } = parseXML('<a href="http://e.com/x/"><b>y</b></a>');
  assert.equal(n5.length, 1);
  assert.equal(n5[0].attrs.href, 'http://e.com/x/');
  assert.equal(findFirst(n5[0], 'b').text, 'y');
});

test('parseXML: 注释 / 声明 / DOCTYPE（含内部 DTD）/ CDATA', () => {
  const src = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd" [',
    '  <!ENTITY nbsp "&#160;">',
    '  <!ELEMENT p (#PCDATA)>',
    ']>',
    '<!-- 注释里可以有 -- 之外的一切，比如 <tag> 与 &amp; -->',
    '<html><body><!-- 内部注释 --><p>正文</p><s><![CDATA[ a<b & c ]]></s></body></html>',
  ].join('\n');
  const { nodes } = parseXML(src);
  // 注释、声明、DOCTYPE 都被丢弃；顶层只剩 html
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'html');
  const body = findFirst(nodes[0], 'body');
  assert.equal(findFirst(body, 'p').text, '正文');
  // 注释不出现在 children 里
  assert.equal(body.children.filter((c) => c.name !== '').length, 2);
  // CDATA 视为文本，且不做实体解码
  assert.equal(findFirst(body, 's').text, ' a<b & c ');
  // DOCTYPE 里的 [ ] 不会提前结束声明
  assert.equal(findFirst(nodes[0], 'entity'), undefined);
});

test('parseXML: 命名空间前缀任意，按 local 匹配', () => {
  const src =
    '<opf:package xmlns:opf="x" xmlns:dc="y">' +
    '<opf:metadata><dc:title>浮士德</dc:title><dc:creator opf:role="aut">歌德</dc:creator></opf:metadata>' +
    '<opf:manifest><opf:item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></opf:manifest>' +
    '</opf:package>';
  const { nodes } = parseXML(src);
  const pkg = nodes[0];
  assert.equal(pkg.name, 'opf:package');
  assert.equal(pkg.local, 'package');
  assert.equal(findAll(pkg, 'item').length, 1);
  assert.equal(findFirst(pkg, 'title').text, '浮士德');
  assert.equal(findFirst(pkg, 'creator').allText, '歌德');
  // 属性前缀差异
  assert.equal(attr(findFirst(pkg, 'creator'), 'role'), 'aut');
  assert.equal(attr(findFirst(pkg, 'item'), 'href'), 'c1.xhtml');
  assert.equal(attr(findFirst(pkg, 'item'), 'media-type'), 'application/xhtml+xml');
  assert.equal(attr(findFirst(pkg, 'item'), 'nope'), undefined);
  // 大小写不敏感
  assert.equal(attr(findFirst(pkg, 'item'), 'HREF'), 'c1.xhtml');
  assert.equal(attr(findFirst(pkg, 'item'), 'Media-Type'), 'application/xhtml+xml');
  // 完整名匹配
  assert.equal(attr(findFirst(pkg, 'item'), 'opf:item') === undefined, true);

  // ncx 变体
  const ncx = parseXML(
    '<ncx:navMap><ncx:navPoint id="n1"><ncx:navLabel><ncx:text>第一章</ncx:text></ncx:navLabel>' +
      '<ncx:content src="c1.xhtml#top"/></ncx:navPoint></ncx:navMap>'
  );
  assert.equal(findFirst(ncx.nodes[0], 'text').allText, '第一章');
  assert.equal(attr(findFirst(ncx.nodes[0], 'content'), 'src'), 'c1.xhtml#top');

  // xml:lang 与 lang 都要能取到
  const lang = parseXML('<p xml:lang="zh-CN" lang="zh">x</p>').nodes[0];
  assert.equal(attr(lang, 'lang'), 'zh');
  const lang2 = parseXML('<p xml:lang="zh-CN">x</p>').nodes[0];
  assert.equal(attr(lang2, 'lang'), 'zh-CN');
  assert.equal(attr(lang2, 'xml:lang'), 'zh-CN');

  // 无前缀变体
  const plain = parseXML('<package><metadata><title>书</title></metadata></package>').nodes[0];
  assert.equal(findFirst(plain, 'title').text, '书');
  assert.equal(attr(findFirst(plain, 'title'), 'id'), undefined);
});

test('parseXML: 未闭合 / 错配标签容错，不抛异常', () => {
  // 未闭合的兄弟
  const a = parseXML('<div><p>一<p>二</div>').nodes[0];
  const ps = findAll(a, 'p');
  assert.equal(ps.length, 2);
  assert.equal(ps[0].text, '一');
  assert.equal(ps[1].text, '二');

  // 错配闭合：弹出到不匹配处，不抛
  const b = parseXML('<div><a>x</b>y</div>');
  assert.equal(b.nodes.length, 1);

  // 闭合标签完全找不到匹配：忽略
  const c = parseXML('<a>x</zzz>y</a>');
  assert.equal(c.nodes[0].text, 'xy');

  // 裸 '<'
  const d = parseXML('<p>1 < 2</p>');
  assert.equal(d.nodes[0].text, '1 < 2');

  // 空输入
  assert.equal(parseXML('').nodes.length, 0);
  assert.equal(parseXML('<!-- only comment -->').nodes.length, 0);
  // 纯文本：顶层裸文本挂在 root.text 上，nodes 只收元素
  const e = parseXML('hello');
  assert.equal(e.nodes.length, 0);
  assert.equal(e.root.text, 'hello');
  const e2 = parseXML('lead<a>x</a>trail');
  assert.equal(e2.nodes.length, 1);
  assert.equal(e2.root.text, 'lead' + 'trail');
});

test('parseXML: 大文件（约 2MB、两万个平级兄弟）不爆栈', () => {
  const parts = ['<html><body>'];
  for (let i = 0; i < 20000; i++) {
    parts.push(`<p id="p${i}">第${i}段的正文内容，用来把文件撑大。</p>`);
  }
  parts.push('</body></html>');
  const src = parts.join('\n');
  assert.ok(src.length > 700 * 1024, `样本应足够大，实际 ${src.length}`);
  const { nodes } = parseXML(src);
  const body = findFirst(nodes[0], 'body');
  const ps = findAll(body, 'p');
  assert.equal(ps.length, 20000);
  assert.equal(ps[0].text, '第0段的正文内容，用来把文件撑大。');
  assert.equal(ps[19999].text, '第19999段的正文内容，用来把文件撑大。');
  assert.equal(attr(ps[12345], 'id'), 'p12345');
});

test('findAll / findFirst: 顺序、未命中、缺参', () => {
  const { nodes } = parseXML('<r><x>1</x><y><x>2</x></y><x>3</x></r>');
  const r = nodes[0];
  assert.deepEqual(
    findAll(r, 'x').map((n) => n.allText),
    ['1', '2', '3']
  );
  assert.equal(findFirst(r, 'x').allText, '1');
  assert.equal(findFirst(r, 'zzz'), undefined);
  assert.deepEqual(findAll(r, 'zzz'), []);
  assert.deepEqual(findAll(undefined, 'x'), []);
  assert.equal(findFirst(null, 'x'), undefined);
  // 自身不算「后代」
  assert.equal(findFirst(r, 'r'), undefined);
  // 不区分大小写
  assert.equal(findAll(r, 'X').length, 3);
});

test('decodeEntities: 预定义实体 / 数字实体 / 中文排版实体 / 未知实体', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), `a & b <c> "d" 'e'`);
  assert.equal(decodeEntities('甲&nbsp;乙'), '甲\u00a0乙');
  assert.equal(decodeEntities('&#123;'), '{');
  assert.equal(decodeEntities('&#x1F600;'), '\u{1F600}');
  assert.equal(decodeEntities('&#X41;'), 'A');
  assert.equal(decodeEntities('&mdash;&hellip;&ldquo;引&rdquo;&lsquo;x&rsquo;&middot;'), '\u2014\u2026\u201c引\u201d\u2018x\u2019\u00b7');
  // 未知实体原样保留（不吞内容）
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;');
  assert.equal(decodeEntities('a & b'), 'a & b');
  assert.equal(decodeEntities('100% &plus; 5'), '100% &plus; 5');
  // 非字符串
  assert.equal(decodeEntities(undefined), '');
  assert.equal(decodeEntities(''), '');
  // 代理区码位不产生非法字符串
  assert.equal(decodeEntities('&#xD800;'), '\ufffd');
});

test('parseXML + 实体：中文 XHTML 常见形态', () => {
  const src =
    '<p>他说：&ldquo;你好&nbsp;世界&rdquo;&mdash;&mdash;然后&#x2026;&#8230;</p>';
  const p = parseXML(src).nodes[0];
  assert.equal(p.text, '他说：\u201c你好\u00a0世界\u201d\u2014\u2014然后\u2026\u2026');
});
