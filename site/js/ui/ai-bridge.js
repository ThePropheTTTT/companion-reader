/* ============================================================
   陪读 · 批注生成编排
   ------------------------------------------------------------
   这一层只做一件事：**决定什么时候去要批注，以及同时要几条**。
   具体的「选哪几段、怎么写、怎么验」在 ai/generate.js 里。

   三个约束决定了这里的形状：

   1. **批注必须在读到的那一刻就已经在那里**。陪伴感来自「我还没说，
      你已经在那儿了」。所以不能等用户翻到某章再开始生成 ——
      那会变成「加载中…」，而加载中的朋友不是朋友。
      于是：当前章优先，然后往下预取几章。

   2. **同一时刻只有一个请求在跑**。批注请求不便宜，并发三个
      既容易撞上速率限制，又会让失败重试的逻辑变得没法推理。
      串行队列 + 一章一请求，是最简单且能用的方案。

   3. **用户翻得比生成快时，不能卡住阅读**。生成永远在后台，
      失败只写 console 和一条轻提示，绝不弹窗、绝不阻塞翻页。
   ============================================================ */

import { state, emit } from '../state.js';
import { generateChapterAI, chapterDigest, loadChapterAI, saveChapterAI } from '../ai/generate.js';
import { getAIConfig, isAIConfigured } from '../ai/runtime.js';
import { ensureParas } from '../core/media.js';
import { toast } from './dom.js';

/** 预取窗口：当前章往后几章。3 章大约够用户翻十分钟，也够发现「这书不适合生成」。 */
const PREFETCH_AHEAD = 3;

/** 正在生成 / 已排队 的章节 id，防止同一章被要两次 */
const inFlight = new Set();
/** @type {Array<{chapterIndex:number, reason:string}>} */
const queue = [];
let draining = false;
/** 用户点了「停」 */
let paused = false;

/* ---------------------------- 查询 ---------------------------- */

/** 某章已有批注吗（内存里） */
export function chapterAIOk(chapterId) {
  const ai = state.ai?.[chapterId];
  if (!ai) return false;
  return Array.isArray(ai.notes) && ai.notes.length > 0;
}

/** 本章批注条数 */
export function noteCountOf(chapterId) {
  const ai = state.ai?.[chapterId];
  return ai && Array.isArray(ai.notes) ? ai.notes.length : 0;
}

/* ---------------------------- 入队 / 出队 ---------------------------- */

/**
 * 排一章进生成队列。
 * @param {number} chapterIndex
 * @param {{reason?:string, front?:boolean}} [opt]
 */
export function queueChapter(chapterIndex, opt = {}) {
  const doc = state.book;
  if (!doc) return;
  const ch = doc.chapters[chapterIndex];
  if (!ch) return;
  if (chapterAIOk(ch.id)) return;
  if (inFlight.has(ch.id)) return;
  if (queue.some((q) => q.chapterIndex === chapterIndex)) return;

  const item = { chapterIndex, reason: opt.reason || 'prefetch' };
  if (opt.front) queue.unshift(item);
  else queue.push(item);
  emit('ai-queue', { size: queue.length });
  drain();
}

/** 把「当前章 + 后面几章」排进队列。切章时调用。 */
export function prefetchFrom(chapterIndex) {
  if (paused) return;
  const total = state.book?.chapters.length || 0;
  for (let i = chapterIndex; i < Math.min(total, chapterIndex + 1 + PREFETCH_AHEAD); i++) {
    queueChapter(i, { reason: i === chapterIndex ? 'current' : 'prefetch' });
  }
}

/** 停掉当前这一轮（不清已经生成好的） */
export function pauseGeneration() {
  paused = true;
  queue.length = 0;
  emit('ai-queue', { size: 0, paused: true });
}

export function resumeGeneration() {
  paused = false;
}

export function isGenerating() {
  return draining || inFlight.size > 0;
}

/* ---------------------------- 队列驱动 ---------------------------- */

async function drain() {
  if (draining || paused) return;
  const doc = state.book;
  if (!doc) {
    queue.length = 0;
    return;
  }

  if (!(await isAIConfigured())) {
    // 没配 key：不要在后台静默失败，也不要弹窗骚扰。
    // 把队列清空并广播一个状态，UI 决定怎么提示（现在是：书搭子按钮上挂一个点）。
    queue.length = 0;
    emit('ai-need-config');
    return;
  }

  draining = true;
  try {
    while (queue.length && !paused) {
      const job = queue.shift();
      const ch = doc.chapters[job.chapterIndex];
      if (!ch || chapterAIOk(ch.id)) continue;
      inFlight.add(ch.id);
      emit('ai-progress', { chapterIndex: job.chapterIndex, phase: 'start' });
      try {
        await generateOne(doc, job.chapterIndex);
      } catch (err) {
        if (err?.name === 'AbortError') {
          // 用户主动取消：不是错误，安静收场
        } else {
          console.warn('[ai] 第', job.chapterIndex + 1, '章生成失败', err);
          emit('ai-error', { chapterIndex: job.chapterIndex, error: err });
        }
      } finally {
        inFlight.delete(ch.id);
        emit('ai-progress', { chapterIndex: job.chapterIndex, phase: 'end' });
      }
    }
  } finally {
    draining = false;
    emit('ai-queue', { size: queue.length });
  }
}

/** 生成单章并落库 */
async function generateOne(doc, chapterIndex) {
  const ch = doc.chapters[chapterIndex];
  const paras = ensureParas(doc, ch);

  // 先试缓存（换设备/重开书时会走到这里）
  const cached = await loadChapterAI(doc.meta.id, ch.id);
  if (cached && cached.notes?.length) {
    state.ai[ch.id] = cached;
    emit('ai-ready', { chapterId: ch.id, notes: cached.notes });
    return cached;
  }

  const cfg = await getAIConfig();
  const prev = doc.chapters[chapterIndex - 1];
  const prevPrev = doc.chapters[chapterIndex - 2];

  const ai = await generateChapterAI(ch, paras, {
    bookMeta: doc.meta,
    chapterIndex,
    chapterCount: doc.chapters.length,
    // 前情提要只给两章：再多也不便宜，而且模型会开始复述梗概本身
    prevDigest: prev ? chapterDigest(state.ai?.[prev.id]) : '',
    prevPrevDigest: prevPrev ? chapterDigest(state.ai?.[prevPrev.id]) : '',
    signal: undefined,
    onProgress: (p) => emit('ai-progress', { chapterIndex, ...p }),
    density: state.settings.density,
  }, {
    density: state.settings.density,
    model: cfg.model,
  });

  state.ai[ch.id] = ai;
  await saveChapterAI(doc.meta.id, ch.id, ai);
  emit('ai-ready', { chapterId: ch.id, notes: ai.notes, summary: ai.summary });
  return ai;
}

/* ---------------------------- 给 UI 用的入口 ---------------------------- */

/**
 * 用户点「要批注」时走这里：确保当前章有批注，没有就当场生成并给出进度提示。
 * 返回生成好的 ChapterAI，或 null（没配 key / 取消）。
 */
export async function ensureCurrentChapterAI({ announce = true } = {}) {
  const doc = state.book;
  if (!doc) return null;
  const idx = state.chapterIndex;
  const ch = doc.chapters[idx];
  if (!ch) return null;

  if (chapterAIOk(ch.id)) return state.ai[ch.id];

  if (!(await isAIConfigured())) {
    emit('ai-need-config');
    if (announce) toast('先去 AI 设置里填一个 API Key', { error: true, ms: 3600 });
    return null;
  }

  // 插到队首：用户明确要的那一章优先
  queueChapter(idx, { reason: 'user', front: true });
  await drain();
  return state.ai[ch.id] || null;
}

/**
 * 一次性把整本书的批注都排上队（用户可能想要「导入完就写满」）。
 * 顺序执行，中间可以 pauseGeneration() 停。
 */
export function queueWholeBook() {
  const total = state.book?.chapters.length || 0;
  for (let i = 0; i < total; i++) queueChapter(i, { reason: 'whole-book' });
  toast(`排好了 ${total} 章，会一章一章来`, { ms: 3000 });
  drain();
}
