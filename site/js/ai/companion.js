/* ============================================================
   陪读 · 书搭子（对话编排层）
   ------------------------------------------------------------
   这一层要解决的问题是**上下文怎么给**，不是「怎么调模型」。

   一本书几十万字，每次对话都整本塞进去既贵又慢，模型还会开始胡编。
   所以这里把「已经读过的内容」压成三级不同的东西：

     更早的章  → 一句 60 字左右的梗概（首次进这一章时后台生成并缓存）
     本章前文  → 原文，但从章首截到「你已经读到的那一段」
     当前页    → 原文全文，一格不少

   ★ 剧透线（spoilerPi）是这一层最要紧的概念。
   AI 只被允许知道 spoilerPi 之前的内容 —— 而它不是「当前页末尾」，
   是**用户实际翻到过的最远那一段**。用户往回翻着看时，AI 不该忘掉后面；
   用户刚打开书时，AI 也不该知道第三章发生了什么。
   spoilerPi 只增不减，跟着用户走。

   同一条纪律也写进了 prompt：禁止提及 spoilerPi 之后的任何情节，
   而且要正向表述（「只能说你此刻已经知道的」），
   因为「不要剧透」会被模型理解成「可以暗示」。
   ============================================================ */

import { store } from '../core/store.js';
import { getAIConfig, chat, isAIConfigured } from './runtime.js';

/* ---------------------------- 常量 ---------------------------- */

const THREAD_PREFIX = 'cp:'; // 与 store 的 'ai:' 前缀并列，删书时一并清掉
const THREAD_INDEX = 'cp:index'; // 每条线程一条记录，这本书记它们的 id
const RECAP_VERSION = 1;

/** 送给模型的最近消息条数。再多的话，前面的早被 recap 摘要覆盖了。 */
const KEEP_MESSAGES = 12;

/** 本书里最多同时保留几条线程（按最近活跃排序） */
const MAX_THREADS = 30;

export const QUICK_ASKS = Object.freeze([
  { id: 'who', label: '这人是谁', text: '这人是前面出现过的吗？是的话提醒我一下。' },
  { id: 'lost', label: '我是不是漏了什么', text: '读到这儿我有点跟不上了，是不是漏了什么？' },
  { id: 'guess', label: '你猜后面会怎样', text: '你猜后面会怎样？只说猜测，别说你知道的。' },
  { id: 'like', label: '你觉得这段好在哪', text: '这一段你觉得好在哪？说得具体点。' },
  { id: 'bored', label: '这段有点无聊', text: '这段我有点读不下去，值得硬读吗？' },
]);

/* ---------------------------- 工具 ---------------------------- */

function now() {
  return Date.now();
}

function uid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().slice(0, 8);
  // 没有 crypto.randomUUID 的老 WebView / 非安全上下文（局域网 http 就是）
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** 线程记录键。刻意复用 store.aiKey 的 'ai:' 前缀，deleteBook 才会连带清掉。 */
function threadKey(bookId, id) {
  return `ai:${bookId}:${THREAD_PREFIX}${id}`;
}

function indexKey(bookId) {
  return `ai:${bookId}:${THREAD_INDEX}`;
}

/** 章梗概的缓存键（与批注产物同前缀，同样会被 deleteBook 清掉） */
function recapKey(bookId, chapterId) {
  return `ai:${bookId}:rc:${chapterId}`;
}

/** 把段落数组拼成给模型看的正文 */
function parasToText(paras, from = 0, to = Infinity) {
  const out = [];
  for (let i = Math.max(0, from); i < paras.length && i < to; i++) {
    const p = paras[i];
    if (!p) continue;
    // 图片段落在文字里标出来 —— 模型看不到图，但要知道「这里有一张图」，
    // 否则它会以为中间少了一段内容。
    // ★ 这一支必须在下面的 `!p.text` 之前：图片段落的 text 本来就是空串，
    //   先判断文字会把插图整段吃掉（曾经如此）。
    if (p.type === 'img') {
      out.push('（这里有一张插图）');
      continue;
    }
    if (!p.text) continue;
    out.push(p.text);
  }
  return out.join('\n');
}

/** 中文数字：第 3 章 → 第三章 */
const CN = '零一二三四五六七八九十';
function cnNum(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v <= 10) return CN[v] || String(v);
  if (v < 20) return '十' + CN[v - 10];
  if (v < 100) return CN[Math.floor(v / 10)] + '十' + (v % 10 ? CN[v % 10] : '');
  return String(v);
}

/* ---------------------------- 线程持久化 ---------------------------- */

/**
 * @typedef {Object} ThreadMsg
 * @property {'user'|'ai'} role
 * @property {string} text
 * @property {number} at
 */

/**
 * @typedef {Object} Thread
 * @property {string} id
 * @property {string} bookId
 * @property {string} chapterId
 * @property {string} title
 * @property {number} spoilerPi      读过的最远段落下标（剧透线）
 * @property {ThreadMsg[]} messages
 * @property {string} recap          更早消息的压缩摘要（超出 KEEP_MESSAGES 时生成）
 * @property {number} at
 */

/** 读线程索引（id 列表，最近活跃在前） */
async function loadIndex(bookId) {
  const v = await store.get(indexKey(bookId), null);
  if (!v || !Array.isArray(v.ids)) return [];
  return v.ids.filter((x) => typeof x === 'string' && x);
}

async function saveIndex(bookId, ids) {
  await store.set(indexKey(bookId), { ids: ids.slice(0, MAX_THREADS), at: now() });
}

/** @returns {Promise<Thread[]>} 最近活跃在前 */
export async function listThreads(bookId) {
  if (!bookId) return [];
  const ids = await loadIndex(bookId);
  const out = [];
  for (const id of ids) {
    const t = await store.get(threadKey(bookId, id), null);
    if (t && t.id) out.push(t);
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

export async function loadThread(bookId, id) {
  if (!bookId || !id) return null;
  const t = await store.get(threadKey(bookId, id), null);
  return t && t.id ? t : null;
}

export async function saveThread(thread) {
  if (!thread?.bookId || !thread.id) return;
  thread.at = now();
  await store.set(threadKey(thread.bookId, thread.id), thread);
  const ids = await loadIndex(thread.bookId);
  const next = [thread.id, ...ids.filter((x) => x !== thread.id)];
  await saveIndex(thread.bookId, next);
}

export async function deleteThread(bookId, id) {
  await store.del(threadKey(bookId, id));
  const ids = await loadIndex(bookId);
  await saveIndex(bookId, ids.filter((x) => x !== id));
}

/** 新开一条线程。标题先留空，由第一次提问的内容补上（像聊天软件的会话名）。 */
export async function createThread({ bookId, chapterId, title = '', spoilerPi = 0 } = {}) {
  const t = {
    id: uid(),
    bookId,
    chapterId,
    title,
    spoilerPi: Math.max(0, Number(spoilerPi) || 0),
    messages: [],
    recap: '',
    at: now(),
  };
  await saveThread(t);
  return t;
}

/** 剧透线只增不减。 */
export function pushSpoiler(thread, pi) {
  const v = Math.max(0, Number(pi) || 0);
  if (!thread) return;
  if (v > (thread.spoilerPi || 0)) thread.spoilerPi = v;
}

/* ---------------------------- 章梗概 ---------------------------- */

/**
 * 取一章的「一句话梗概」，没有就生成并缓存。
 * 用便宜模型：它只是给后面的对话当背景，不给人看。
 * @param {object} p
 * @param {object} p.bookMeta
 * @param {object} p.chapter
 * @param {string} p.text            该章正文
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>} 失败或没配 Key 时返回 ''（调用方不该因此报错）
 */
export async function ensureRecap({ bookMeta, chapter, text, signal } = {}) {
  if (!bookMeta?.id || !chapter?.id) return '';
  const cached = await store.get(recapKey(bookMeta.id, chapter.id), null);
  if (cached && cached.v === RECAP_VERSION && cached.text) return cached.text;
  if (!(await isConfigured())) return '';

  // 太长的章只送头尾：梗概里「开始发生了什么 + 最后停在哪」比中间细节有用。
  const body = String(text || '');
  const trimmed = body.length > 6000 ? `${body.slice(0, 4000)}\n……\n${body.slice(-1600)}` : body;
  if (trimmed.trim().length < 40) return '';

  const cfg = await getAIConfig();
  const out = await chat({
    model: cfg.cheapModel || cfg.model,
    temperature: 0.3,
    maxTokens: 220,
    signal,
    doing: `概括第${cnNum((chapter.index ?? 0) + 1)}章`,
    messages: [
      {
        role: 'system',
        content:
          '你在为一本小说做「读过的人自己看的备忘录」。用 2 句话、总共 60 字以内，' +
          '写清这一章发生了什么事、谁在场、最后停在哪里。' +
          '只写事实，不评价、不抒情、不猜测后文。直接输出那两句话，不要任何前缀。',
      },
      {
        role: 'user',
        content: `书名：${bookMeta.title || '（未命名）'}\n第${cnNum((chapter.index ?? 0) + 1)}章 ${chapter.title || ''}\n\n${trimmed}`,
      },
    ],
  });

  const text2 = String(out || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (text2) {
    await store.set(recapKey(bookMeta.id, chapter.id), { v: RECAP_VERSION, text: text2, at: now() });
  }
  return text2;
}

export async function clearRecaps(bookId) {
  if (!bookId) return;
  const keys = await store.keys(`ai:${bookId}:rc:`);
  if (keys.length) await store.del(...keys);
}

async function isConfigured() {
  try {
    return await isAIConfigured();
  } catch {
    return false;
  }
}

/* ---------------------------- 上下文组装 ---------------------------- */

/**
 * 组装「更早的章」部分：优先用缓存过的梗概，没有的章只留标题。
 * ★ 这里刻意**不现场生成**梗概 —— 用户按下发送键时不该等三个模型请求。
 *   没梗概的章会由 UI 侧在后台慢慢补（prefetchRecaps）。
 */
async function earlierChapters({ doc, chapterIndex, recaps }) {
  const lines = [];
  for (let i = 0; i < chapterIndex; i++) {
    const ch = doc.chapters[i];
    if (!ch) continue;
    const title = `第${cnNum(i + 1)}章${ch.title ? ` ${ch.title}` : ''}`;
    const r = recaps?.[ch.id];
    lines.push(r ? `${title}：${r}` : `${title}：（读者读过了，但没有留下摘要）`);
  }
  return lines.join('\n');
}

/**
 * 拼出一次请求要送的 messages。
 * ★ 顺序是「稳定前缀在前、变动内容在后」，这是为了命中 prompt cache：
 *   同一条线程里前几轮的内容一字不变，服务商就能复用 KV cache。
 *   ★ 剧透线之后的内容一个字都不能出现（包括"下一章"的标题）。
 * @param {object} p
 * @param {object} p.doc
 * @param {number} p.chapterIndex
 * @param {import('../core/model.js').Para[]} p.paras
 * @param {number} p.pageFrom        当前页起始段落下标
 * @param {number} p.pageTo          当前页结束段落下标（开区间）
 * @param {Thread} p.thread
 * @param {Object<string,string>} [p.recaps]
 * @returns {Promise<Array<{role:string,content:string}>>}
 */
export async function buildMessages({ doc, chapterIndex, paras, pageFrom, pageTo, thread, recaps }) {
  const meta = doc.meta || {};
  const ch = doc.chapters[chapterIndex] || {};
  const n = doc.chapters.length;
  const spoiler = Math.max(0, Math.min(thread?.spoilerPi ?? pageTo, paras.length));

  const system = [
    `你在陪一个人读《${meta.title || '这本书'}》${meta.author ? `（${meta.author}）` : ''}。`,
    `全书 ${n} 章，现在读的是第${cnNum(chapterIndex + 1)}章${ch.title ? `「${ch.title}」` : ''}。`,
    '',
    '规矩：',
    `1. 你和这个人**读到的进度完全一样**：只到第${cnNum(chapterIndex + 1)}章的上面那一段为止。`,
    '   后面发生了什么你不知道，也绝对不许提 —— 包括"你会知道的""等着看吧"这种暗示。',
    '   如果他问后面的剧情，就说你也还没读到，然后说你现在猜什么。',
    '2. 说话像一个刚读完这几页、正靠在沙发上跟你聊天的人。两三句话，口语，可以吐槽作者、',
    '   可以说"这段我看得有点烦"。不要总结中心思想，不要夸"描写细腻""文笔优美"这种空话。',
    '3. 说到具体的东西：是哪句话、哪个人、哪个动作让你这么想。',
    '4. 允许说"我也不知道""这里我没看懂"。不知道就承认，别编。',
    '5. 不要每句都反问。想问的时候一次只问一个，而且要是真的想问。',
  ].join('\n');

  const earlier = await earlierChapters({ doc, chapterIndex, recaps });
  const readSoFar = parasToText(paras, 0, spoiler);
  const pageText = parasToText(paras, pageFrom, Math.min(pageTo, paras.length));

  const context = [
    earlier ? `【这本书你已经读过、他也读过】\n${earlier}` : '【这本书你们都是从开头读起的】',
    '',
    `【第${cnNum(chapterIndex + 1)}章读到这里为止】`,
    readSoFar || '（还没读多少）',
    '',
    '【他此刻正在看的这一页】',
    pageText || '（这一页没有正文）',
  ].join('\n');

  const history = [];
  if (thread?.recap) {
    history.push({ role: 'user', content: `（之前聊过的内容，摘要）\n${thread.recap}` });
    history.push({ role: 'ai', content: '嗯，我记得。' });
  }
  for (const m of (thread?.messages || []).slice(-KEEP_MESSAGES)) {
    if (!m?.text) continue;
    history.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  }

  // 上下文放在历史之前、system 之后：它每轮都会更新（进度在走），
  // 所以不能放进 system —— 放进去会让稳定前缀每轮都失效，prompt cache 全废。
  const sysWithContext = `${system}\n\n${context}`;
  return [{ role: 'system', content: sysWithContext }, ...history];
}

/* ---------------------------- 主入口 ---------------------------- */

/**
 * 问一次书搭子。返回完整回复（非流式）。
 * UI 想流式就自己组装 messages 后调 runtime.chat({onDelta})；
 * 这里保留非流式版本，是为了让「快速反应」这种一次性调用有个简单入口。
 *
 * @param {object} p
 * @param {object} p.doc
 * @param {number} p.chapterIndex
 * @param {import('../core/model.js').Para[]} p.paras
 * @param {number} p.pageFrom
 * @param {number} p.pageTo
 * @param {Thread} p.thread
 * @param {Object<string,string>} [p.recaps]
 * @param {AbortSignal} [p.signal]
 * @param {(d:string)=>void} [p.onDelta]
 * @returns {Promise<string>}
 */
export async function askCompanion({ doc, chapterIndex, paras, pageFrom, pageTo, thread, recaps, signal, onDelta }) {
  const messages = await buildMessages({ doc, chapterIndex, paras, pageFrom, pageTo, thread, recaps });
  const text = await chat({
    messages,
    signal,
    onDelta,
    temperature: 0.9,
    maxTokens: 700,
    // 不用 json 模式：这是聊天，不是结构化抽取。
    doing: '书搭子回话',
  });
  return String(text || '').trim();
}

/**
 * 「就这段说点什么」—— 让 AI 主动起话头，供弹幕式快速反应或空线程时用。
 * 输入只有当前页，输出 2~3 句可以被接话的话，不是提问列表。
 */
export async function sparkFor({ doc, chapterIndex, paras, pageFrom, pageTo, thread, recaps, signal }) {
  const messages = await buildMessages({ doc, chapterIndex, paras, pageFrom, pageTo, thread, recaps });
  messages[0] = {
    role: 'system',
    content:
      `${messages[0].content}\n\n` +
      '这一次不要回答问题：他在读这一页，你先开口。用两三句话说说你刚看这几页在想什么，' +
      '落在一处具体的细节上，最后可以留一个真想知道的问题。不要客套，不要"哇"。',
  };
  const cfg = await getAIConfig();
  const text = await chat({
    messages,
    signal,
    temperature: 1.0,
    maxTokens: 420,
    model: cfg.model,
    doing: '书搭子起话头',
  });
  return String(text || '').trim();
}
/** 线程消息过多时，把最早的几条压成一段摘要（省 token，又不丢上下文）。 */
export async function maybeCondense(thread, { signal } = {}) {
  if (!thread) return thread;
  const msgs = thread.messages || [];
  if (msgs.length <= KEEP_MESSAGES + 6) return thread;
  const drop = msgs.slice(0, msgs.length - KEEP_MESSAGES);
  const keep = msgs.slice(msgs.length - KEEP_MESSAGES);
  const transcript = drop.map((m) => `${m.role === 'user' ? '他' : '我'}：${m.text}`).join('\n');
  const cfg = await getAIConfig();
  let summary = '';
  try {
    summary = await chat({
      model: cfg.cheapModel || cfg.model,
      temperature: 0.2,
      maxTokens: 260,
      signal,
      doing: '整理聊天记录',
      messages: [
        {
          role: 'system',
          content:
            '把下面这段读书讨论压成 100 字以内的备忘录：他关心什么、你们聊到了哪些具体细节、' +
            '有没有悬而未决的问题。只写内容，不要评价这次对话。',
        },
        { role: 'user', content: transcript },
      ],
    });
  } catch (err) {
    // 压缩失败不能把这次对话也带走 —— 退化成「只保留最近的」。
    if (err?.name === 'AbortError') throw err;
    console.warn('[companion] 聊天记录压缩失败，只保留最近几条', err);
    thread.messages = keep;
    return thread;
  }
  thread.recap = [thread.recap, String(summary || '').trim()].filter(Boolean).join(' ').slice(0, 800);
  thread.messages = keep;
  return thread;
}

/* ---------------------------- 后台补梗概 ---------------------------- */

/**
 * 后台把已读章节的梗概补齐，好让下一次提问的上下文立刻可用。
 * 从当前章往前补 —— 用户更可能问「刚才发生了什么」。
 * 单飞：同时只跑一个，避免和批注生成抢速率限制。
 * @returns {Promise<Object<string,string>>} chapterId -> 梗概
 */
export async function prefetchRecaps({ doc, uptoChapter, limit = 6, signal, onOne } = {}) {
  const out = {};
  if (!doc?.chapters || !(await isConfigured())) return out;
  let done = 0;
  for (let i = Math.min(uptoChapter, doc.chapters.length - 1); i >= 0 && done < limit; i--) {
    if (signal?.aborted) break;
    const ch = doc.chapters[i];
    if (!ch) continue;
    const cached = await store.get(recapKey(doc.meta.id, ch.id), null);
    if (cached?.text) {
      out[ch.id] = cached.text;
      continue;
    }
    const text = ch.text || parasToText(ch.paras || []);
    if (String(text).trim().length < 80) continue;
    try {
      const r = await ensureRecap({ bookMeta: doc.meta, chapter: ch, text, signal });
      if (r) {
        out[ch.id] = r;
        done++;
        onOne?.(ch.id, r);
      }
    } catch (err) {
      if (err?.name === 'AbortError') break;
      console.warn('[companion] 梗概生成失败，跳过这一章', err);
    }
  }
  return out;
}

/** 读一次全部已缓存的梗概（同步给 buildMessages 用，不触发任何请求） */
export async function loadRecaps(bookId, chapters = []) {
  const out = {};
  if (!bookId) return out;
  const keys = await store.keys(`ai:${bookId}:rc:`);
  if (!keys.length) return out;
  const prefix = `ai:${bookId}:rc:`;
  const wanted = new Set(chapters.map((c) => c.id));
  for (const k of keys) {
    const chId = k.slice(prefix.length);
    if (wanted.size && !wanted.has(chId)) continue;
    const v = await store.get(k, null);
    if (v?.text && v.v === RECAP_VERSION) out[chId] = v.text;
  }
  return out;
}

export { cnNum, parasToText };
