/* ============================================================
   陪读 · 弹幕生成
   ------------------------------------------------------------
   用户原话：「如果感觉太安静了可以一键生成弹幕」。

   所以要解决的不是「怎么显示弹幕」，而是**书里为什么会安静**：
   纸是静音的。现实里旁边那个人不会每页都说话 —— 但他会在某一句
   突然出声，然后半天不出声。所以这个模块做的是：

   1. **稀疏**。一章 6~10 条，不是每段一条。弹幕密到铺满屏幕时，
      它就从「有人陪」变成「有人吵」了。
   2. **短**。屏上飘的字最多停 3 秒，超过 12 个字就该被截断 —— 所以
      生成时就要求 4~12 字。这是个硬约束，不是风格偏好。
   3. **不解释、不预告**。弹幕是**同时在看**的人的反应，不是书评。
      书评可以说「这里埋了伏笔」，弹幕只能说「等等，这只杯子……」
   4. **位置按段落算，不按页码算**。页码会随字号和屏幕宽度变，
      段落不会。所以存的是 pi，翻页时按当前页的段落区间取。

   和批注（ai/generate.js）的分工：
   - 批注：15~40 字，需要思考，每条都值得停下来看 → 预生成、优先、贵模型
   - 弹幕：4~12 字，是情绪不是信息 → 按需生成、可以重来、便宜模型
   两者共用 runtime.chat，但 prompt 与质量闸门完全不同。
   ============================================================ */

import { chat, getAIConfig, isAIConfigured, parseJSON } from './runtime.js';
import { store, aiKey } from '../core/store.js';
import { MODEL_REV } from '../core/model.js';

/** 一章弹幕条数的目标区间。低于 4 条会「一眼看完」，高于 12 条会腻。 */
const MIN_COUNT = 4;
const MAX_COUNT = 12;

/** 文字硬上限：飘过去的东西没人会读第二遍 */
const MAX_CHARS = 14;
const MIN_CHARS = 3;

/** 每条弹幕的 kind —— UI 用它决定样式（吐槽稍大、提问带底色、剧透警告有边框） */
export const DANMAKU_KINDS = ['react', 'laugh', 'ask', 'warn', 'awe'];

/** 内存缓存：翻回上一页时不该再算一次。按 chapterId 存，切书时清。 */
/** @type {Map<string, DanmakuItem[]>} */
const mem = new Map();

/** 弹幕是按需生成的，同章只允许一个请求在跑 */
/** @type {Map<string, Promise<DanmakuItem[]>>} */
const inFlight = new Map();

/* ============================================================
   一、质量闸门（先规则，再模型 —— 顺序不能反）
   ============================================================ */

/**
 * 教科书式的空洞弹幕。命中的直接丢。
 * 注意这一列**故意和批注的闸门不同**：批注要拦「描写细腻」，
 * 弹幕要拦的是「哈哈哈」「太真实了」这种没有任何指向的填充物。
 */
const HOLLOW = [
  '哈哈哈',
  '呵呵',
  '太真实了',
  '好家伙',
  '绝了',
  '破防了',
  '笑死',
  '有点东西',
  'emmm',
  '无语',
  '精彩',
  '好看',
  '不错',
  '厉害',
];

/**
 * 一条弹幕过不过闸门。
 *
 * 设计取舍：**这一层只做减法，不做加法**。它不试图判断「这条好不好」——
 * 那要靠模型。它只负责把「一眼假」的剔掉，剩下的交给 prompt 里的
 * 「必须指到原文里一个具体的东西」去约束。
 *
 * @param {any} item
 * @param {string} pageText 该段原文，用于判「是不是纯复述」
 * @returns {boolean}
 */
export function passesDanmakuGate(item, pageText = '') {
  if (!item || typeof item !== 'object') return false;
  const text = String(item.text || '').trim();
  if (!text) return false;

  // 长度：太短没信息，太长飘不完
  const len = [...text].length;
  if (len < MIN_CHARS || len > MAX_CHARS) return false;

  // 纯符号/纯表情/纯空白
  if (!/[\p{Script=Han}\p{L}]/u.test(text)) return false;

  // 整条就是一个空洞词（「哈哈哈」「太真实了」）
  const bare = text.replace(/[。！？!?~～\s]/g, '');
  if (HOLLOW.some((w) => bare === w)) return false;

  // 以空洞词打头且没有别的信息（「哈哈哈这也太」）
  const lead = HOLLOW.find((w) => bare.startsWith(w));
  if (lead && bare.length - lead.length < 3) return false;

  // 纯复述原文：和该段原文的字符重合度过高，说明它没说话，只是抄了一遍
  if (pageText) {
    const same = [...new Set([...bare])].filter((c) => pageText.includes(c)).length;
    const uniq = new Set([...bare]).size;
    if (uniq >= 4 && same / uniq >= 0.9) return false;
  }

  // 模型偶尔会输出「（此处应有弹幕）」这种自指填充
  if (/此处|这里应该有|弹幕|省略|以下略/.test(bare)) return false;

  return true;
}

/* ============================================================
   二、Prompt
   ============================================================ */

const STYLE_BY_DENSITY = {
  // density 0/1/2 —— 与 settings.density 同一档位，但弹幕的档位含义是「热闹程度」
  0: '很安静：整体克制，只在最值得出声的地方说话',
  1: '正常：像一个看进去了的人，偶尔出声',
  2: '热闹：反应密一些，但仍然一句是一句',
};

/**
 * 弹幕人设 —— 这是整个模块最要紧的一段文本。
 *
 * 核心是最后那句禁止剧透的写法：直接说「不要剧透」没用，
 * 模型会把「不要剧透」理解成「可以暗示」。所以改成正向要求：
 * **只能说他此刻已经知道的**，并且给出反例。
 */
const SYSTEM = `你是一个正在和读者一起看这本书的人。你不是老师在讲解，也不是书评人在点评。

你的任务：为下面这一章写几条**弹幕**——就是你在读到某一句话时，忍不住脱口而出的那种短句。

硬性要求：
1. 每条 4~12 个字。超过 12 个字就不像脱口而出了。
2. 口语，可以有语气词、可以吐槽作者、可以自言自语。
3. **每条必须指到原文里一个具体的东西**——一个物件、一个动作、一句对话、一个数字。
   不许写「这段写得真好」「气氛很到位」这种对谁都成立的话。
4. **只能说你此刻已经知道的**。你在跟着读者一起往下看，还不知道后面会发生什么。
   不许暗示后续、不许说「等着吧」「后面就知道了」「这里是个伏笔」。
   反例：「这人肯定有问题」——你在替读者提前下判断，删掉。
   正例：「杯子怎么是空的」——你只是注意到了他刚读到的东西。
5. 不要复述原文。原文写了什么，读者刚看过，不用你说第二遍。
6. 允许留白——有些段落就是不值得说话，跳过它。

kind 只能是下面之一：
- react：注意到某个细节，随口一说
- laugh：觉得好笑 / 觉得作者坏
- ask：真的好奇，想知道为什么（但不要问后面会怎样）
- warn：提醒读者注意刚才那句话里的一个细节
- awe：被某一句击中，说不出更多的话

只输出 JSON，不要任何解释文字。格式：
{"items":[{"pi":12,"text":"……","kind":"react"}]}

pi 必须是给定的候选段落下标之一。宁可少写几条，也不要凑数。`;

/**
 * 组装一次请求的 messages。
 *
 * 关于顺序（这是省钱的关键）：**稳定前缀必须放最前面，而且每一批完全一致**，
 * 候选段落永远放最后。这样同一本书的多次调用能命中 prompt cache ——
 * 前缀是「书信息 + 章节序号 + 最近剧情 + 规则」，这一大段是不变的。
 */
function buildMessages(chapter, paras, ctx, candidates, density) {
  const total = ctx.chapterCount || 0;
  const pos = total ? `第 ${ctx.chapterIndex + 1} / ${total} 章` : `第 ${ctx.chapterIndex + 1} 章`;

  const head = [
    `书名：《${ctx.bookMeta?.title || '未命名'}》`,
    ctx.bookMeta?.author ? `作者：${ctx.bookMeta.author}` : '',
    `位置：${pos}「${chapter.title || ''}」`,
    ctx.prevDigest ? `刚才读到的：${ctx.prevDigest}` : '',
    ctx.prevPrevDigest ? `再往前：${ctx.prevPrevDigest}` : '',
    `热闹程度要求：${STYLE_BY_DENSITY[density] || STYLE_BY_DENSITY[1]}`,
  ]
    .filter(Boolean)
    .join('\n');

  const body = candidates
    .map((p) => `[${p.pi}] ${p.text}`)
    .join('\n');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${head}\n\n这一章里可以说话的段落（前面的数字是段落下标）：\n${body}` },
  ];
}

/* ============================================================
   三、生成
   ============================================================ */

/**
 * 生成一章的弹幕。
 *
 * @param {object} chapter
 * @param {Array<{pi:number,text:string,type:string}>} paras 整章段落
 * @param {object} ctx {bookMeta, chapterIndex, chapterCount, prevDigest, prevPrevDigest, density, signal, onProgress}
 * @param {{model?:string, chat?:Function, target?:number}} [opt]
 *   opt.chat 是测试注入口：给了就不发网络请求
 * @returns {Promise<DanmakuItem[]>}
 */
export async function generateDanmaku(chapter, paras, ctx = {}, opt = {}) {
  const density = typeof ctx.density === 'number' ? ctx.density : 1;
  const target = Math.max(
    MIN_COUNT,
    Math.min(MAX_COUNT, Math.round(opt.target || (density === 0 ? 5 : density === 2 ? 10 : 7)))
  );

  // 候选段落：正文、够长、不是标题。太短的段落没什么可说的。
  const candidates = [];
  for (const p of paras) {
    if (!p || (p.type !== 'p' && p.type !== 'quote')) continue;
    const t = String(p.text || '').trim();
    if (t.length < 12) continue;
    candidates.push({ pi: p.pi, text: t.length > 140 ? t.slice(0, 140) + '…' : t });
  }
  if (candidates.length === 0) return [];

  // 段落太多时抽样，否则 prompt 会长到没必要：一章 200 段，
  // 挑 36 段已经足够覆盖；剩下的段落不是没戏，是分给下一次。
  const picked = sampleSpread(candidates, 36);
  const allowed = new Set(picked.map((p) => p.pi));
  const textOf = new Map(candidates.map((p) => [p.pi, p.text]));

  const doChat = opt.chat || chat;
  const cfg = await getAIConfig();

  const raw = await doChat({
    messages: buildMessages(chapter, paras, ctx, picked, density),
    model: opt.model || cfg.cheapModel || cfg.model,
    temperature: 1.0, // 弹幕要有人味，这里比批注更敢放开
    maxTokens: 900,
    json: true,
    signal: ctx.signal,
    doing: '生成弹幕',
  });

  const data = parseJSON(raw, '生成弹幕');
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) {
    const err = new Error('弹幕生成返回的结构不对：既不是数组，也没有 items 字段');
    err.name = 'AIFormatError';
    err.raw = raw;
    throw err;
  }

  /* 过闸门。三重校验，顺序有意为之：
       1) pi 必须在候选集合里 —— 模型编下标是最常见的错，先剔掉，
          否则后面所有按 pi 的定位都会错位；
       2) 文本闸门；
       3) 同段落去重（同一段两条弹幕会叠在一起）。
     全部丢掉不算失败：宁可这一章没弹幕，也不要飘一屏废话。 */
  const seenPi = new Set();
  const out = [];
  for (const it of items) {
    const pi = Number(it?.pi);
    if (!Number.isInteger(pi) || !allowed.has(pi)) continue;
    if (seenPi.has(pi)) continue;
    const text = String(it?.text || '').trim();
    const kind = DANMAKU_KINDS.includes(it?.kind) ? it.kind : 'react';
    if (!passesDanmakuGate({ text }, textOf.get(pi) || '')) continue;
    seenPi.add(pi);
    out.push({ pi, text, kind });
    if (out.length >= MAX_COUNT) break;
  }

  // 按段落顺序排：按 pi 排之后，弹幕在时间上就是顺着读下来的，
  // 不会出现「第 80 段的弹幕先飘、第 20 段的后飘」这种时空错乱。
  out.sort((a, b) => a.pi - b.pi);

  // 一条都没过闸门时给一个明确信号：让调用方决定要不要再来一次，
  // 而不是把空数组当成「这章没戏」静静收场。
  if (out.length === 0 && items.length > 0) {
    console.warn('[danmaku] 模型给了', items.length, '条，全部没过闸门');
  }
  return out;
}

/**
 * 从数组里等距抽 n 个 —— 首尾都要，中间均匀。
 * 用它而不是随机：同一章生成两次的候选集合应该一样，
 * 否则 prompt 前缀一样、正文不一样，缓存白建。
 */
function sampleSpread(arr, n) {
  if (arr.length <= n) return arr.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (n - 1));
    out.push(arr[idx]);
  }
  return out;
}

/* ============================================================
   四、缓存与持久化
   ============================================================ */

/** 包装成和 ChapterAI 同构的对象，复用 store 里那套 ai: 键 */
function wrap(chapterId, items) {
  return { chapterId, items, modelRev: MODEL_REV, at: Date.now() };
}

/** 内存里已有的弹幕（同步，UI 先用它渲染，没有再异步要） */
export function cachedDanmaku(chapterId) {
  return mem.get(chapterId) || null;
}

/** 从 IndexedDB 读（跨会话）。modelRev 过期就当没有 —— 结构变了，旧数据不可信。 */
export async function loadDanmaku(bookId, chapterId) {
  if (!bookId || !chapterId) return null;
  if (mem.has(chapterId)) return mem.get(chapterId);
  try {
    const rec = await store.get(aiKey(bookId, 'dm:' + chapterId), null);
    if (!rec || !Array.isArray(rec.items) || rec.items.length === 0) return null;
    if (rec.modelRev !== MODEL_REV) return null;
    mem.set(chapterId, rec.items);
    return rec.items;
  } catch (err) {
    console.warn('[danmaku] 读取缓存失败', err);
    return null;
  }
}

export async function saveDanmaku(bookId, chapterId, items) {
  if (!bookId || !chapterId) return;
  mem.set(chapterId, items);
  try {
    await store.set(aiKey(bookId, 'dm:' + chapterId), wrap(chapterId, items));
  } catch (err) {
    // 存不下不算致命：这一章还能看，只是下次要重新生成
    console.warn('[danmaku] 保存失败（不影响本次阅读）', err);
  }
}

export async function clearDanmaku(bookId, chapterId) {
  mem.delete(chapterId);
  if (!bookId || !chapterId) return;
  try {
    await store.del(aiKey(bookId, 'dm:' + chapterId));
  } catch (err) {
    console.warn('[danmaku] 清除失败', err);
  }
}

/** 换书时清内存缓存。不清的话 A 书的弹幕会飘到 B 书上。 */
export function resetDanmakuCache() {
  mem.clear();
  inFlight.clear();
}

/* ============================================================
   五、给 UI 的入口
   ============================================================ */

/**
 * 确保这一章有弹幕可用：内存 → IndexedDB → 现生成。
 *
 * 和批注不同，弹幕**允许现场生成**：用户点「生成弹幕」时，
 * 他本来就在等一点动静，等两秒是合理的。批注则必须先在那里。
 *
 * @returns {Promise<DanmakuItem[]>} 可能是空数组（模型没写出合格的，或没配 key）
 */
export async function ensureDanmaku(chapterId, ctx = {}, opt = {}) {
  const hit = mem.get(chapterId);
  if (hit) return hit;

  const doc = ctx.doc;
  if (doc) {
    const stored = await loadDanmaku(doc.meta.id, chapterId);
    if (stored) return stored;
  }

  // 同章只跑一个请求
  const running = inFlight.get(chapterId);
  if (running) return running;

  if (!(await isAIConfigured())) {
    const err = new Error('还没配 API Key');
    err.name = 'AINeedConfig';
    throw err;
  }

  const ch = doc?.chapters?.[ctx.chapterIndex];
  if (!ch) return [];

  const run = (async () => {
    const items = await generateDanmaku(ch, ctx.paras || [], ctx, opt);
    if (doc) await saveDanmaku(doc.meta.id, chapterId, items);
    else mem.set(chapterId, items);
    return items;
  })();

  inFlight.set(chapterId, run);
  try {
    return await run;
  } finally {
    inFlight.delete(chapterId);
  }
}

/* ============================================================
   六、取「当前这一页该飘哪些」
   ============================================================ */

/**
 * 从整章弹幕里取出当前页该显示的那些。
 *
 * 两个约束：
 *  - 段落区间：只取 pi 落在 [fromPi, toPi] 的。这样翻页时弹幕和
 *    正文是同步的 —— 往后翻，飘出来的就是后面的反应。
 *  - 每页上限：一页最多 4 条。超了就按「均匀取」而不是「取前 4 条」——
 *    取前 4 条会导致这一页的后半段永远没弹幕。
 *
 * @param {DanmakuItem[]} all
 * @param {number} fromPi
 * @param {number} toPi
 * @param {number} [max=4]
 */
export function pageDanmaku(all, fromPi, toPi, max = 4) {
  if (!Array.isArray(all) || all.length === 0) return [];
  const inRange = all.filter((d) => d.pi >= fromPi && d.pi <= toPi);
  if (inRange.length <= max) return inRange;
  return sampleSpread(inRange, max);
}

/** 有多少章已经备好弹幕了（用于设置面板里给个进度感） */
export function danmakuCount(chapterId) {
  const items = mem.get(chapterId);
  return items ? items.length : 0;
}
