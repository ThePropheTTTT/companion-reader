// 陪读 — IndexedDB 持久化（core/store.js）
//
// 零依赖 Promise 封装。单库 `peidu`，两个对象仓：
//   books   keyPath 'meta.id'  —— { meta, chapters, rev }，整本一条记录
//   kv      keyPath 'k'        —— 杂项：progress:<bookId>、ai:<bookId>:<chapterId>、settings
//
// ─────────────────────────────────────────────────────────────────────────────
// 键名设计（deleteBook 的正确性靠它）
// ─────────────────────────────────────────────────────────────────────────────
//   progress:<bookId>                 → Progress 对象
//   ai:<bookId>:<chapterId>           → ChapterAI
//   settings                          → 全局设置
//
// ⚠ 前缀陷阱：bookId 形如 `书名|12345|1700000000000`，用 `startsWith('ai:' + id + ':')`
// 做前缀匹配是**安全**的，因为 id 后面那个 ':' 是分隔符，`ai:x:y` 不会命中 `ai:x:yz` 之外
// 的东西；但 `progress:` 后面没有尾分隔符，`progress:` + id 会命中 `progress:<id>xxx`。
// 所以删除时不要手写字符串拼接，一律走下面的 matchesBookKeys() / bookKeyRe()——
// 它在 `${id}` 之后强制要求「键到此结束」或「后面紧跟分隔符」，
// 于是 `book1` 绝不会误删 `book10` 的条目。
//
// 实现约定：
//  - 只用 Safari 16.4 支持得住的语法（optional chaining `?.`、nullish `??` 可用；
//    不用 Array.at 之外的新东西，也不用 any 的新提案语法）。所有循环都是老式 for。
//  - 对浏览器全局的访问集中在 `const idb = globalThis.indexedDB`（下面），
//    只此一处。这样 Node 里 import 本模块不会炸（Node 24 没有 indexedDB），
//    真正调用时才抛中文错误；测试也能据此 skip。
//  - 所有「一个事务里做完」的多步操作（deleteBook）共用一个 transaction，
//    不要跨事务——IndexedDB 事务在事件循环里空闲就自动提交了。

/** 浏览器全局的集中访问点。Node / 无 IndexedDB 环境下是 undefined。 */
const idb = globalThis.indexedDB;

/** 库名与版本。改结构时必须 +1，并在 upgrade 里补迁移。 */
export const DB_NAME = 'peidu';
export const DB_VERSION = 1;
export const STORE_BOOKS = 'books';
export const STORE_KV = 'kv';

/** kv 里非书籍前缀的键。 */
export const KEY_SETTINGS = 'settings';

/** bookId 与 chapterId 之间、以及前缀与 bookId 之间的分隔符。 */
export const KEY_SEP = ':';

/** IndexedDB 没有可用时的中文提示。 */
const NO_IDB_MSG = '当前环境不支持 IndexedDB，无法保存阅读进度与书籍（请用 Safari / Chrome 打开，Node 环境下该功能不可用）';

// ─────────────────────────────────────────────────────────────────────────────
// 键名（纯函数，可单测；也是 deleteBook 前缀匹配的唯一依据）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} bookId
 * @returns {string} `progress:<bookId>`
 */
export function progressKey(bookId) {
  return 'progress' + KEY_SEP + String(bookId);
}

/**
 * @param {string} bookId
 * @param {string} chapterId
 * @returns {string} `ai:<bookId>:<chapterId>`
 */
export function aiKey(bookId, chapterId) {
  return 'ai' + KEY_SEP + String(bookId) + KEY_SEP + String(chapterId);
}

/**
 * 判断一个 kv 键是否属于某本书（deleteBook 用它，绝不手写字符串前缀）。
 * 规则：键以 `progress:` 开头则余下部分必须**恰好等于** bookId；
 *       键以 `ai:` 开头则第二段必须**恰好等于** bookId，且后面必须还有一段 chapterId。
 *
 * @param {string} k
 * @param {string} bookId
 * @returns {boolean}
 */
export function matchesBookKeys(k, bookId) {
  const key = String(k);
  const id = String(bookId);

  const pPrefix = 'progress' + KEY_SEP;
  if (key.indexOf(pPrefix) === 0) {
    // progress:<id>  —— 到键尾为止必须完全相等，`progress:<id>x` 不算
    return key.length === pPrefix.length + id.length && key.slice(pPrefix.length) === id;
  }

  const aPrefix = 'ai' + KEY_SEP;
  if (key.indexOf(aPrefix) === 0) {
    const rest = key.slice(aPrefix.length);
    const cut = rest.indexOf(KEY_SEP);
    // 必须存在 chapterId 段（cut > 0），且 bookId 整段相等。
    // 这一条同时挡住 `ai:book10:ch1` 命中 `book1`。
    return cut > 0 && rest.slice(0, cut) === id;
  }

  return false;
}

/**
 * 从 `ai:<bookId>:<chapterId>` 里取回 bookId / chapterId（是 aiKey 的逆）。
 * @param {string} k
 * @returns {{bookId:string, chapterId:string}|null}
 */
export function parseAiKey(k) {
  const key = String(k);
  const prefix = 'ai' + KEY_SEP;
  if (key.indexOf(prefix) !== 0) return null;
  const rest = key.slice(prefix.length);
  // chapterId 本身可能含 ':'（EPUB 的 href 派生 id 有时带），所以只切第一个分隔符。
  const cut = rest.indexOf(KEY_SEP);
  if (cut <= 0) return null;
  return { bookId: rest.slice(0, cut), chapterId: rest.slice(cut + 1) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 DOMException / Error 转成面向用户的中文错误。
 * QuotaExceededError 要告诉用户「删书」这个可执行的动作，而不是丢一个英文名词。
 *
 * @param {any} err
 * @param {string} [doing] 正在做什么，补进消息里
 * @returns {Error}
 */
export function toReadableError(err, doing) {
  const what = doing ? '（' + doing + '）' : '';
  if (!err) return new Error('操作失败' + what);
  // Safari 的配额错误 name 就是 'QuotaExceededError'；Firefox 曾经报 code 22/NamedError。
  const name = err.name || '';
  const isQuota = name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22;
  if (isQuota) {
    const e = new Error('存储空间已满' + what + '：浏览器给本站的配额用完了。请删除一些已导入的书，或清理浏览器数据后重试。');
    e.name = 'QuotaExceededError';
    e.cause = err;
    return e;
  }
  if (name === 'InvalidStateError') {
    const e = new Error('数据库连接已失效' + what + '：请刷新页面重试。');
    e.name = name;
    e.cause = err;
    return e;
  }
  const msg = err.message ? String(err.message) : String(err);
  const e = new Error('存储操作失败' + what + '：' + msg);
  e.name = name || 'Error';
  e.cause = err;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// 开库
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Promise<any>|null} openDB 的 promise 缓存（"每次操作开库" = 复用同一个连接 promise） */
let dbPromise = null;

/**
 * 打开（并按需升级）数据库。内部缓存 promise：同一个页面里只会真正 open 一次，
 * 但每次调用拿到的都是「已就绪的 db」，调用方不需要持有 db 句柄。
 *
 * @returns {Promise<any>}
 */
export function openDB() {
  if (dbPromise) return dbPromise;
  if (!idb) return Promise.reject(new Error(NO_IDB_MSG));

  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      dbPromise = null;
      reject(toReadableError(err, '打开数据库'));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: 'meta.id' });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 另一个标签页要升级 schema 时我们必须让路，否则它永远卡在 blocked。
      db.onversionchange = () => { try { db.close(); } catch { /* 已经关了 */ } dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(toReadableError(req.error, '打开数据库')); };
    req.onblocked = () => { /* 等别的标签页关掉旧连接，不 reject：onsuccess 还会来 */ };
  });
  return dbPromise;
}

/** 测试/调试用：丢掉连接缓存（下次调用重新开库）。 */
export function resetDB() {
  dbPromise = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 事务小工具
// ─────────────────────────────────────────────────────────────────────────────

/** 把 IDBRequest 包成 Promise（成功给 result，失败给中文错误）。 */
function req2promise(req, doing) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(toReadableError(req.error, doing));
  });
}

/**
 * 开一个事务。txDone 覆盖 commit/abort/error 三种收尾：
 * 写操作必须等 tx.oncomplete 才算真的落盘——只在 request.onsuccess 里 resolve
 * 会在配额超限（QuotaExceededError 常常在 commit 时才报）时给出假的成功。
 *
 * @param {string|string[]} stores
 * @param {'readonly'|'readwrite'} mode
 * @returns {Promise<{tx:any, done:Promise<void>}>}
 */
async function begin(stores, mode, doing) {
  const db = await openDB();
  let tx;
  try {
    tx = db.transaction(stores, mode);
  } catch (err) {
    throw toReadableError(err, doing);
  }
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(toReadableError(tx.error, doing));
    tx.onerror = () => reject(toReadableError(tx.error, doing));
  });
  return { tx, done };
}

/** 写事务的标准用法：跑完 body 再等 commit。 */
async function write(stores, doing, body) {
  const { tx, done } = await begin(stores, 'readwrite', doing);
  const out = await body(tx);
  await done;
  return out;
}

/** 读事务：结果从 request 里拿，不用等 commit（但也不主动 abort）。 */
async function read(stores, doing, body) {
  const { tx } = await begin(stores, 'readonly', doing);
  return body(tx);
}

// ─────────────────────────────────────────────────────────────────────────────
// store 接口（CONTRACT 第 5 节）
// ─────────────────────────────────────────────────────────────────────────────

export const store = {
  /** 一次性升级 schema（openDB 内部缓存 promise，这里只是把它跑热）。 */
  async ready() {
    await openDB();
    return true;
  },

  /** @returns {Promise<Array>} BookMeta[]，按 addedAt 降序 */
  async listBooks() {
    const rows = await read([STORE_BOOKS], '读取书库', (tx) =>
      req2promise(tx.objectStore(STORE_BOOKS).getAll(), '读取书库'));
    const list = [];
    for (let i = 0; i < rows.length; i++) {
      const meta = rows[i] && rows[i].meta;
      if (meta && meta.id) list.push(meta);
    }
    list.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
    return list;
  },

  /** @returns {Promise<Object|undefined>} BookDoc | undefined */
  async getBook(id) {
    if (id === undefined || id === null) return undefined;
    const row = await read([STORE_BOOKS], '读取书籍', (tx) =>
      req2promise(tx.objectStore(STORE_BOOKS).get(String(id)), '读取书籍'));
    return row || undefined;
  },

  /** @param {Object} doc BookDoc：{ meta:{id,...}, chapters, rev } */
  async putBook(doc) {
    if (!doc || !doc.meta || !doc.meta.id) throw new Error('putBook 需要带 meta.id 的 BookDoc');
    await write([STORE_BOOKS], '保存书籍', (tx) => {
      tx.objectStore(STORE_BOOKS).put(doc);
    });
    return doc.meta.id;
  },

  /**
   * 删书 + 连带清掉它的进度与 AI 产物。
   * books 与 kv 在**同一个事务**里做完，避免删了书留下孤儿 kv。
   * @param {string} id
   */
  async deleteBook(id) {
    if (id === undefined || id === null) return;
    const bookId = String(id);
    await write([STORE_BOOKS, STORE_KV], '删除书籍', async (tx) => {
      tx.objectStore(STORE_BOOKS).delete(bookId);
      const kv = tx.objectStore(STORE_KV);
      // getAllKeys() 拿主键列表（不需要反序列化整个 value，快得多）。
      const keys = await req2promise(kv.getAllKeys(), '清理书籍数据');
      for (let i = 0; i < keys.length; i++) {
        if (matchesBookKeys(keys[i], bookId)) kv.delete(keys[i]);
      }
    });
  },

  /**
   * 读任意 JSON。**键不存在时返回 fallback（默认 undefined），不抛错。**
   * @param {string} k
   * @param {any} [fallback]
   */
  async get(k, fallback) {
    const row = await read([STORE_KV], '读取数据', (tx) =>
      req2promise(tx.objectStore(STORE_KV).get(String(k)), '读取数据'));
    if (!row || row.v === undefined) return fallback;
    return row.v;
  },

  /** 写任意 JSON。undefined 会被 IndexedDB 拒收，这里统一存 null。 */
  async set(k, v) {
    if (k === undefined || k === null) throw new Error('set 需要键名');
    const value = v === undefined ? null : v;
    await write([STORE_KV], '保存数据', (tx) => {
      tx.objectStore(STORE_KV).put({ k: String(k), v: value });
    });
    return true;
  },

  /**
   * 列出键。不给前缀 → 全部。
   * @param {string} [prefix]
   * @returns {Promise<string[]>}
   */
  async keys(prefix) {
    const all = await read([STORE_KV], '列出数据', (tx) =>
      req2promise(tx.objectStore(STORE_KV).getAllKeys(), '列出数据'));
    const out = [];
    const p = prefix === undefined || prefix === null ? '' : String(prefix);
    for (let i = 0; i < all.length; i++) {
      const k = String(all[i]);
      if (!p || k.indexOf(p) === 0) out.push(k);
    }
    return out;
  },

  /** 删任意多个键。 */
  async del(...keys) {
    const flat = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === undefined || k === null) continue;
      if (Array.isArray(k)) { for (let j = 0; j < k.length; j++) flat.push(String(k[j])); }
      else flat.push(String(k));
    }
    if (flat.length === 0) return true;
    await write([STORE_KV], '删除数据', (tx) => {
      const kv = tx.objectStore(STORE_KV);
      for (let i = 0; i < flat.length; i++) kv.delete(flat[i]);
    });
    return true;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 便捷封装（业务层高频用法，避免各处再拼键名）
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<Object|undefined>} Progress */
export function getProgress(bookId) {
  return store.get(progressKey(bookId));
}

/** @param {Object} progress */
export function setProgress(bookId, progress) {
  return store.set(progressKey(bookId), progress);
}

/** @returns {Promise<Object|undefined>} ChapterAI */
export function getChapterAI(bookId, chapterId) {
  return store.get(aiKey(bookId, chapterId));
}

/** @param {Object} ai */
export function setChapterAI(bookId, chapterId, ai) {
  return store.set(aiKey(bookId, chapterId), ai);
}

/** 读设置；没有就返回空对象（调用方用 model.mergeSettings 补默认值）。 */
export function getSettings() {
  return store.get(KEY_SETTINGS, null);
}

/** 写设置。 */
export function setSettings(settings) {
  return store.set(KEY_SETTINGS, settings);
}
