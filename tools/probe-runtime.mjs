// 一次性能力探测：确认 core/ 模块能否在 Node 下直接单测。
// 结论会写进 CONTRACT.md，决定要不要给浏览器/Node 做 shim。
console.log('DOMParser        :', typeof DOMParser);
console.log('Intl.Segmenter   :', typeof Intl.Segmenter);
console.log('TextDecoder      :', typeof TextDecoder);
console.log('structuredClone  :', typeof structuredClone);
console.log('crypto.randomUUID:', typeof crypto?.randomUUID);

const xml = '<x xmlns:dc="http://purl.org/dc/elements/1.1/"><a href="../oebps/c1.xhtml">第一章</a><dc:title>浮士德</dc:title></x>';
const doc = new DOMParser().parseFromString(xml, 'application/xhtml+xml');
console.log('XML query        :', doc.querySelector('a')?.getAttribute('href'));
console.log('ns-prefixed query:', doc.getElementsByTagName('dc:title')[0]?.textContent);

const seg = new Intl.Segmenter('zh', { granularity: 'word' });
console.log('zh segmentation  :', [...seg.segment('但这时候浮士德说话了')].map((s) => s.segment).join('|'));
console.log('word-like flags  :', [...seg.segment('但这时候浮士德说话了')].map((s) => `${s.segment}:${s.isWordLike ? 'W' : '-'}`).join(' '));

// DecompressionStream('deflate-raw') 是替代 JSZip 的关键，必须确认三端一致
const raw = new TextEncoder().encode('压缩后的正文');
const cs = new CompressionStream('deflate-raw');
const writer = cs.writable.getWriter();
writer.write(raw);
writer.close();
const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
const ds = new DecompressionStream('deflate-raw');
const w2 = ds.writable.getWriter();
w2.write(compressed);
w2.close();
const back = new Uint8Array(await new Response(ds.readable).arrayBuffer());
console.log('deflate-raw 往返 :', new TextDecoder().decode(back), '| bytes', raw.length, '->', compressed.length);
