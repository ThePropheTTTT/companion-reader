// test/store.test.js — 存储层测试
//
// 分两部分：
//  A. **键名与错误映射的纯逻辑**（必须真跑，不能 skip）。这些是 deleteBook 正确性的
//     全部依据，跟 IndexedDB 在不在没关系。
//  B. **IndexedDB 真操作**。Node 24 没有 indexedDB（`typeof globalThis.indexedDB`
//     === 'undefined'），这一部分会 `skip` 并打印说明——**这不算失败**。
//     测试里若运行在带 IndexedDB 的环境（比如将来换成 happy-dom / 真浏览器跑），
//     同一份用例会自动真跑，覆盖 CRUD + 前缀删除 + fallback。
//
// 为什么不注入 fake-indexeddb：那会把 store.js 的实现复杂化（要抽出可替换的
// 全局句柄、处理假实现的边角差异），而 store.js 的复杂度预算应该留给真机行为。
// store.js 只把浏览器全局集中在 `const idb = globalThis.indexedDB` 一处，
// 无 IndexedDB 时 import 不炸、调用才抛中文错误——这就是那处设计换来的可测性。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  store, openDB, resetDB,
  progressKey, aiKey, matchesBookKeys, parseAiKey, toReadableError,
  DB_NAME, DB_VERSION, STORE_BOOKS, STORE_KV, KEY_SETTINGS, KEY_SEP,
} from '../site/js/core/store.js';

const HAS_IDB = typeof globalThis.indexedDB !== 'undefined';
const SKIP_REASON = 'Node 24 没有 IndexedDB（typeof globalThis.indexedDB === "undefined"）：'
  + '这一段需要真浏览器环境才会跑；纯逻辑部分不受影响。';

// ─────────────────────────────────────────────────────────────────────────────
// A. 纯逻辑：键名（必须真跑）
// ─────────────────────────────────────────────────────────────────────────────

test('键名常量与构造：progress:<bookId> / ai:<bookId>:<chapterId>', () => {
  assert.equal(DB_NAME, 'peidu');
  assert.equal(DB_VERSION, 1);
  assert.equal(STORE_BOOKS, 'books');
  assert.equal(STORE_KV, 'kv');
  assert.equal(KEY_SETTINGS, 'settings');

  const id = '三体|1048576|1700000000000';
  assert.equal(progressKey(id), 'progress:三体|1048576|1700000000000');
  assert.equal(aiKey(id, 'c3'), 'ai:三体|1048576|1700000000000:c3');

  // chapterId 自身含 ':'（EPUB href 派生 id 可能带）也要能原样取回
  assert.deepEqual(parseAiKey(aiKey('b|1|2', 'a:b')), { bookId: 'b|1|2', chapterId: 'a:b' });
  assert.equal(parseAiKey('progress:b|1|2'), null);
  assert.equal(parseAiKey('ai:只有书id没有章节'), null);
  assert.equal(parseAiKey(''), null);
});

test('已知限制（非 bug）：bookId 自身含 ":" 时 ai: 键不可逆，且 deleteBook 删不掉它的 ai 条目', () => {
  // CONTRACT 把键格式定死成 `ai:<bookId>:<chapterId>`，而 bookId 是
  // `${filename}|${bytes}|${lastModified}`。分隔符与 id 的字符集有重叠：
  // 文件名里若含 ':'（macOS/Linux 允许，Windows 文件名不允许），
  // 第一个 ':' 就不再是 bookId 与 chapterId 的边界。
  const weird = 'my:book|123|456';
  const k = aiKey(weird, 'ch1');            // 'ai:my:book|123|456:ch1'
  assert.equal(k, 'ai:my:book|123|456:ch1');
  // 解析拿到的是错的（把 'my' 当成 bookId）
  assert.deepEqual(parseAiKey(k), { bookId: 'my', chapterId: 'book|123|456:ch1' });
  // 于是这幅键既匹配不上它自己的书……
  assert.equal(matchesBookKeys(k, weird), false);
  // ……也**不会误删别的书**：它会被判给 bookId 'my'，但 'my' 只有在真的存在
  // 一本 id 恰好是 'my' 的书时才会轮到它。安全属性（不误删别人的键）成立，
  // 代价只是「删 A 书时留下一条孤儿 ai 记录」，用户看不见，比误删安全。
  assert.equal(matchesBookKeys(k, 'my'), true, '键格式决定了它归属 my —— 这是格式歧义，不是误删');
  assert.equal(matchesBookKeys(aiKey('b|1|2', 'ch1'), 'b'), false, '正常的 bookId 不会掉进这个歧义');

  // progress: 键不受影响（它只拼一个 id，不切分）
  assert.equal(matchesBookKeys(progressKey(weird), weird), true, 'progress 键没有这个限制');

  // 真实场景里 bookId 的第一个字段是**文件名**：Windows 文件名不允许 ':'
  // （NTFS 用它表示数据流），iOS/macOS 的文件名允许但阅读器里几乎不会遇到。
  // 结论：接受这个限制，理由是改键格式会让已经存进用户浏览器里的书全部失联。
});

test('matchesBookKeys: ai:book1:ch1 与 ai:book10:ch1 的前缀陷阱不能误伤', () => {
  // 这是 deleteBook 最容易写错的地方：用 startsWith('ai:' + 'book1') 会把 book10 也删掉。
  const b1 = 'book1';
  const b10 = 'book10';

  // 属于 book1 的键
  assert.equal(matchesBookKeys(aiKey(b1, 'ch1'), b1), true, 'ai:book1:ch1 属于 book1');
  assert.equal(matchesBookKeys(progressKey(b1), b1), true, 'progress:book1 属于 book1');
  // 属于 book10 的键 —— 绝不能命中 book1
  assert.equal(matchesBookKeys(aiKey(b10, 'ch1'), b1), false, 'ai:book10:ch1 绝不能命中 book1');
  assert.equal(matchesBookKeys(progressKey(b10), b1), false, 'progress:book10 绝不能命中 book1');
  // 反向：book10 的匹配不能因为 book1 存在而漏
  assert.equal(matchesBookKeys(aiKey(b10, 'ch1'), b10), true);
  assert.equal(matchesBookKeys(aiKey(b1, 'ch1'), b10), false);

  // progress: 后面没有尾分隔符 → 必须靠「键到此结束」兜住
  assert.equal(matchesBookKeys('progress:' + b1 + 'x', b1), false, 'progress:book1x 不是 book1 的键');
  assert.equal(matchesBookKeys('progress:' + b1 + ':extra', b1), false);
  // ai: 后面必须有 chapterId 段
  assert.equal(matchesBookKeys('ai:' + b1, b1), false, '没有 chapterId 段不算');
  assert.equal(matchesBookKeys('ai:' + b1 + ':', b1), true, '空 chapterId 段仍然属于这本书');

  // 真实的 bookId 里带 '|' 也要成立
  const real1 = '书|100|1';
  const real10 = '书|100|10';
  assert.equal(matchesBookKeys(aiKey(real1, 'c0'), real1), true);
  assert.equal(matchesBookKeys(aiKey(real10, 'c0'), real1), false);

  // 无关键一律不匹配
  assert.equal(matchesBookKeys(KEY_SETTINGS, b1), false);
  assert.equal(matchesBookKeys('progressX:book1', b1), false);
  assert.equal(matchesBookKeys('', b1), false);
  assert.equal(matchesBookKeys('ai:other:ch1', b1), false);
});

test('matchesBookKeys: 前缀陷阱穷举（构造一批相似 id 交叉验证）', () => {
  // 只用**分隔符干净**的 id —— 含 ':' 的 id 是上面那条已知限制，不属于本用例。
  const ids = ['book1', 'book10', 'book100', 'book1x', 'book', 'book01', 'book1 ', ' book1',
    '书|100|1', '书|100|10', '书|100|100', '书|1000|1'];
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      const owner = ids[i];
      const other = ids[j];
      const keys = [progressKey(owner), aiKey(owner, 'ch1'), aiKey(owner, 'ch2:x')];
      for (let k = 0; k < keys.length; k++) {
        const expect = owner === other; // 只有完全相同的 id 才算命中
        assert.equal(
          matchesBookKeys(keys[k], other), expect,
          '键 ' + keys[k] + ' 对 bookId ' + other + ' 的判定应为 ' + expect
        );
      }
    }
  }
});

test('toReadableError: QuotaExceededError 转成可读中文并提示删书', () => {
  const quota = new Error('The quota has been exceeded.');
  quota.name = 'QuotaExceededError';
  const e = toReadableError(quota, '保存书籍');
  assert.match(e.message, /存储空间已满/);
  assert.match(e.message, /删除/);          // 必须给出可执行的动作
  assert.match(e.message, /保存书籍/);       // 带上正在做的事，便于定位
  assert.equal(e.name, 'QuotaExceededError'); // 保留 name，调用方可据此分支
  assert.equal(e.cause, quota);

  // 老 Firefox 的别名
  const ff = new Error('quota');
  ff.name = 'NS_ERROR_DOM_QUOTA_REACHED';
  assert.match(toReadableError(ff).message, /存储空间已满/);

  // 普通错误不能被误判成配额错误
  const other = new Error('boom');
  other.name = 'AbortError';
  const e2 = toReadableError(other, '读取书籍');
  assert.match(e2.message, /存储操作失败/);
  assert.match(e2.message, /boom/);
  assert.doesNotMatch(e2.message, /存储空间已满/);

  // null / undefined 也要给中文，不能抛 TypeError
  assert.match(toReadableError(null).message, /操作失败/);
  assert.match(toReadableError(undefined, '删除').message, /操作失败/);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. IndexedDB 真操作（Node 里 skip）
// ─────────────────────────────────────────────────────────────────────────────

test('store.ready / listBooks / getBook / putBook / deleteBook', { skip: HAS_IDB ? false : SKIP_REASON }, async () => {
  resetDB();
  await store.ready();

  const idA = 'A书|100|1';
  const idB = 'A书|100|10'; // 前缀陷阱：idB 以 idA 的前缀开头
  const mkDoc = (id, addedAt) => ({
    meta: { id, title: id, author: '佚名', format: 'txt', size: 100, addedAt, charCount: 0, chapterCount: 1 },
    chapters: [{ id: 'c0', title: '第 1 章', index: 0, depth: 0, body: '正文' }],
    rev: 1,
  });

  await store.putBook(mkDoc(idA, 1000));
  await store.putBook(mkDoc(idB, 2000));

  const list = await store.listBooks();
  assert.ok(list.length >= 2);
  // 按 addedAt 降序
  const mine = list.filter((m) => m.id === idA || m.id === idB);
  assert.deepEqual(mine.map((m) => m.id), [idB, idA]);

  const doc = await store.getBook(idA);
  assert.equal(doc.meta.title, idA);
  assert.equal(doc.chapters[0].body, '正文');
  assert.equal(await store.getBook('不存在的书|0|0'), undefined, 'getBook 未命中返回 undefined 而不是抛错');

  // 删 idA 必须连带删掉它的 progress / ai，且**不能**碰 idB 的
  await store.set(progressKey(idA), { chapterId: 'c0', pi: 3, scrollRatio: 0, at: 1, percent: 1 });
  await store.set(aiKey(idA, 'c0'), { chapterId: 'c0', notes: [], modelRev: 1, at: 1 });
  await store.set(progressKey(idB), { chapterId: 'c0', pi: 9, scrollRatio: 0, at: 1, percent: 9 });
  await store.set(aiKey(idB, 'c0'), { chapterId: 'c0', notes: [], modelRev: 1, at: 1 });

  await store.deleteBook(idA);
  assert.equal(await store.getBook(idA), undefined, '书本体已删');
  assert.equal(await store.get(progressKey(idA)), undefined, 'progress 连带删除');
  assert.equal(await store.get(aiKey(idA, 'c0')), undefined, 'ai 产物连带删除');
  assert.ok(await store.get(progressKey(idB)), '前缀相似的 idB 进度必须留着');
  assert.ok(await store.get(aiKey(idB, 'c0')), '前缀相似的 idB AI 产物必须留着');

  // 清理
  await store.deleteBook(idB);
  await store.del(KEY_SETTINGS);
});

test('store.get/set/keys/del 与 fallback 语义', { skip: HAS_IDB ? false : SKIP_REASON }, async () => {
  await store.ready();

  assert.equal(await store.get('从未写过的键'), undefined, '默认 fallback 是 undefined，不抛错');
  assert.equal(await store.get('从未写过的键', '兜底'), '兜底');
  assert.equal(await store.get('从未写过的键', null), null);

  await store.set('t:number', 0);
  assert.equal(await store.get('t:number', '兜底'), 0, '0 是合法值，不能被当成「没存过」');
  await store.set('t:false', false);
  assert.equal(await store.get('t:false', true), false, 'false 同理');
  await store.set('t:null', null);
  assert.equal(await store.get('t:null', '兜底'), null);
  await store.set('t:obj', { a: [1, 2], b: '中文' });
  assert.deepEqual(await store.get('t:obj'), { a: [1, 2], b: '中文' });

  const keys = await store.keys('t:');
  assert.deepEqual(keys.slice().sort(), ['t:false', 't:null', 't:number', 't:obj']);
  assert.ok((await store.keys()).length >= 4, '不给前缀时列出全部');
  assert.deepEqual(await store.keys('没有任何键以此开头:'), []);

  await store.del('t:number', 't:false');
  assert.equal(await store.get('t:number'), undefined);
  assert.equal(await store.get('t:false'), undefined);
  await store.del(['t:obj', 't:null']);
  assert.deepEqual(await store.keys('t:'), []);
});

test('openDB: 同一页面只真正 open 一次（promise 缓存）', { skip: HAS_IDB ? false : SKIP_REASON }, async () => {
  const a = openDB();
  const b = openDB();
  assert.equal(a, b, 'openDB 必须复用同一个 promise');
  await a;
});

test('无 IndexedDB 时 store 调用抛可读中文而不是 ReferenceError', { skip: HAS_IDB ? '当前环境有 IndexedDB，这条反向断言不适用' : false }, async () => {
  resetDB();
  await assert.rejects(() => store.ready(), /不支持 IndexedDB/);
  await assert.rejects(() => store.get('k'), /不支持 IndexedDB/);
});
