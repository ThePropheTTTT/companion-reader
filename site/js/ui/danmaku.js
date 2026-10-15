/* ============================================================
   陪读 · 弹幕层（显示）
   ------------------------------------------------------------
   这一层只负责「让字飘过去」，一行生成逻辑都没有（那是 ai/danmaku.js）。

   三个必须守住的边界：

   1. **绝对不能影响分页测量。**
      这个层挂在 #paper 里、盖在正文上方，而 #paper 是 .page-scroll 的
      父级 —— 也就是说它是测量容器的**外部**，任何绝对定位的子元素都不会
      进入 offsetTop 的差值计算。这不是巧合，是刻意选的挂载点：
      早先如果把弹幕挂在 .page-body 里，每次飘过一条都会改动被测容器的
      内容高度，分页会随弹幕闪烁而重算。
      另外整个层 pointer-events:none，内部也不能有可点元素。

   2. **轨道数按真实高度算，不能写死。**
      手机竖屏的纸面只有四五百 px 高，iPad 横屏有八九百。写死轨道数会导致
      手机上弹幕堆成一坨、iPad 上大片空白。轨道高度由 CSS 变量 --dm-lane
      给出，JS 只负责除法。

   3. **一页最多几条要有上限。**
      弹幕的用处是「不那么安静」，不是「盖住正文」。一眼能同时看到的
      最多 4 条，超过就排队 —— 而不是同时放出去。
   ============================================================ */

import { state, subscribe } from '../state.js';
import { el, toast } from './dom.js';
import { getRenderer, goChapter } from './reader.js';
import {
  ensureDanmaku,
  pageDanmaku,
  cachedDanmaku,
  resetDanmakuCache,
} from '../ai/danmaku.js';
import { ensureParas } from '../core/media.js';

/* ---------------------------- 速度档位 ---------------------------- */

/** settings.danmakuSpeed 1..3 → 每秒横向移动多少像素（按纸宽归一化） */
const SPEED_PPS = { 1: 52, 2: 78, 3: 110 };

/** 安静模式：隔多久出一条。这个区间是「偶尔出声」的节奏感来源。 */
const CALM_GAP = [7000, 15000];

/** 一键刷屏：一次性把余量放完，20 秒内结束 */
const BURST_MS = 20000;
const BURST_GAP = [900, 1800];

/* ---------------------------- 模块状态 ---------------------------- */

const L = {}; // 层引用
let laneCount = 3;
/** @type {Array<{el:HTMLElement, until:number}>} 每个轨道上一条的结束时间 */
let lanes = [];
/** 当前页待发的弹幕队列 */
let pending = [];
/** @type {number|null} */ let pumpTimer = null;
/** @type {number|null} */ let burstUntil = null;
let enabled = false;
let inited = false;
/** 当前页区间，用于判断「翻页了，换一批」 */
let pageKey = '';
/** 这一章弹幕是否正在生成中，防重复请求 */
let loading = false;
/** @type {number|null} 记录本次页面区间的起止，供队列填充用 */
let range = { from: 0, to: 0 };
/** 已经飘过的弹幕（身份 = pi|text）。翻回来时不重播同一批。 */
let shown = new Set();

/* ---------------------------- 初始化 ---------------------------- */

/** 抓引用，幂等。任何导出函数都可以先调它。 */
export function initDanmaku() {
  if (inited) return;
  L.layer = document.getElementById('danmaku-layer');
  L.paper = document.getElementById('paper');

  // 每一条的动画结束都要回收 DOM —— 不看这个的话长章节读一小时会攒几百个节点
  if (L.layer) {
    L.layer.addEventListener('animationend', onAnimEnd);
    L.layer.addEventListener('transitionend', onAnimEnd);
  }

  // 排版变化后轨道数要跟着变（旋转屏幕、改字号都会变）
  const ro = new ResizeObserver(() => measureLanes());
  if (L.paper) ro.observe(L.paper);
  L.ro = ro;

  // 翻页 / 切章后重新取一批
  subscribe((topic, detail) => {
    if (topic === 'chapter-rendered') {
      pageKey = '';
      scheduleFill(0);
    } else if (topic === 'settings' && detail && 'danmaku' in detail) {
      setDanmakuEnabled(!!detail.danmaku);
    } else if (topic === 'relayout') {
      measureLanes();
    }
  });

  measureLanes();
  inited = true;
}

function onAnimEnd(ev) {
  const node = ev.target;
  if (node && node.parentNode === L.layer) node.remove();
}

/** 按纸面真实高度算轨道数，并给 CSS 一个统一的行高 */
function measureLanes() {
  if (!L || !L.layer || !L.paper) return;
  const h = L.paper.clientHeight || 0;
  if (!h) return;

  // 轨道高 30px 是「看得清 + 不挤」的平衡点；两端各留 8px 余量，
  // 底部多留一点：页脚正上方那一条最容易被误读成正文
  const laneH = h < 520 ? 26 : 30;
  const usable = h - 16 - laneH;
  laneCount = Math.max(2, Math.min(5, Math.floor(usable / laneH)));
  L.layer.style.setProperty('--dm-lane', laneH + 'px');
  L.layer.style.setProperty('--dm-top', '8px');
  if (lanes.length !== laneCount) {
    lanes = Array.from({ length: laneCount }, (_, i) => lanes[i] || { el: null, until: 0 });
  }
}

/* ---------------------------- 开关 ---------------------------- */

export function isDanmakuEnabled() {
  return enabled;
}

/**
 * 开关弹幕。用户按的是底部那颗按钮，所以这里也要同步 aria-pressed，
 * 否则读屏用户完全不知道它现在是开还是关。
 */
export function setDanmakuEnabled(on) {
  initDanmaku();
  if (!L.layer) return;
  enabled = !!on;
  L.layer.classList.toggle('is-on', enabled);
  const btn = document.getElementById('btn-danmaku');
  if (btn) btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');

  if (!enabled) {
    clearPump();
    pending = [];
    L.layer.replaceChildren();
    return;
  }
  measureLanes();
  fillQueue();
  scheduleFill(400);
}

/** 点一下按钮：关着就打开（并立刻给一批），开着就放一次「一键刷屏」 */
export async function toggleDanmaku() {
  initDanmaku();
  if (!enabled) {
    setDanmakuEnabled(true);
    if (pending.length === 0 && !loading) await requestDanmaku();
    return;
  }
  burst();
}

/** 一键刷屏：20 秒内把手上的弹幕全放完 */
export function burst() {
  initDanmaku();
  if (!enabled || !L.layer) return;
  measureLanes();
  burstUntil = Date.now() + BURST_MS;
  fillQueue();

  if (pending.length === 0) {
    // 手上没有存量（本章弹幕还没生成）→ 现场要一次，回来再放
    requestDanmaku().then(() => {
      burstUntil = Date.now() + BURST_MS;
      fillQueue();
      scheduleFill(0);
    });
    return;
  }
  // 先立刻放三条，让「一键」有即时反馈；剩下的按节奏走
  for (let i = 0; i < 3; i++) emitOne();
  scheduleFill(0);
}

/* ---------------------------- 取数据 ---------------------------- */

/** 当前页的段落区间。拿不到就退回整章。 */
function currentRange() {
  const r = getRenderer();
  const paras = r?.lastParas;
  if (!r || !Array.isArray(paras) || paras.length === 0) return { from: 0, to: 0 };

  const from = Number.isInteger(r.slicedFrom) ? r.slicedFrom : 0;
  const count = r.body ? r.body.children.length : 0;
  const to = count > 0 ? from + count - 1 : paras.length - 1;
  return { from, to: Math.min(to, paras.length - 1) };
}

async function requestDanmaku() {
  const doc = state.book;
  if (!doc || loading) return;
  const idx = state.chapterIndex;
  const ch = doc.chapters[idx];
  if (!ch) return;

  loading = true;
  try {
    const paras = ensureParas(doc, ch);
    const items = await ensureDanmaku(
      ch.id,
      {
        doc,
        paras,
        chapterIndex: idx,
        chapterCount: doc.chapters.length,
        bookMeta: doc.meta,
        prevDigest: digestOf(doc.chapters[idx - 1]),
        prevPrevDigest: digestOf(doc.chapters[idx - 2]),
        density: state.settings.density,
      },
      { model: undefined }
    );
    if (!items || items.length === 0) {
      toast('这一章没找到值得插嘴的地方', { ms: 2600 });
    }
    fillQueue();
    scheduleFill(300);
  } catch (err) {
    if (err?.name === 'AINeedConfig') {
      toast('先去 AI 设置里填一个 API Key', { error: true, ms: 3600 });
      setDanmakuEnabled(false);
    } else if (err?.name === 'AbortError') {
      /* 用户主动取消，安静收场 */
    } else {
      console.warn('[danmaku] 生成失败', err);
      toast(err?.message || '弹幕生成失败', { error: true, ms: 3600 });
    }
  } finally {
    loading = false;
  }
}

/** 前情提要：优先用批注层生成的摘要（已经算过了，不重复花钱） */
function digestOf(ch) {
  if (!ch) return '';
  const ai = state.ai?.[ch.id];
  if (ai?.summary) return String(ai.summary).slice(0, 120);
  return '';
}

/* ---------------------------- 队列与节奏 ---------------------------- */

/** 用当前页区间的弹幕填满队列（队列空的时候才填，避免打断正在放的） */
function fillQueue() {
  const doc = state.book;
  if (!doc) return;
  const ch = doc.chapters[state.chapterIndex];
  if (!ch) return;

  const all = cachedDanmaku(ch.id);
  if (!all || all.length === 0) return;

  const key = `${ch.id}:${range.from}-${range.to}`;
  if (key === pageKey && pending.length > 0) return;

  const pick = pageDanmaku(all, range.from, range.to, 6);
  // 过滤掉这一页已经飘过的：翻回来时不该重播同一批
  const fresh = pick.filter((d) => !shown.has(key0(d)));
  pageKey = key;
  if (fresh.length === 0) return;

  // 打散顺序：按 pi 顺序飘会显得像「有剧本」，真实弹幕是乱的。
  // 但只在同一条弹幕内部乱序，段落先后仍然大致单调。
  pending = shuffle(fresh);
  for (const d of pending) shown.add(key0(d));
  // shown 无限增长会吃内存；保留最近 400 条足够跨章节去重
  if (shown.size > 400) shown = new Set([...shown].slice(-200));
}

/** 一条弹幕的身份：同一段的两条不同弹幕也要能区分 */
function key0(d) {
  return `${d.pi}|${d.text}`;
}

/**
 * 把书搭子说的一句话当成一条弹幕插进来。
 *
 * 为什么要有这个：用户跟 AI 聊了一句，然后关掉面板继续读书 ——
 * 那句话应该还在这一页上飘一下，而不是随着面板一起消失。
 * 这是「陪伴」这条主线里最便宜也最有效的一环。
 *
 * ★ 只在弹幕开着的时候插。不开弹幕的用户不该被 AI 的话偷袭 ——
 *   他们关了面板就是不想看了，想再看会自己点开。
 * @param {string} text
 * @param {number} [pi] 挂在哪一段上，默认当前页起始段
 */
export function injectCompanionLine(text, pi) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  initDanmaku();
  if (!enabled || !L.layer) return;
  // 弹幕飘过去只有几秒，太长没人读得完第二遍 —— 和 ai/danmaku.js 一样卡在 14 字上限的两倍内
  const short = t.length > 30 ? t.slice(0, 30) + '…' : t;
  const item = {
    pi: Number.isInteger(pi) ? pi : range.from || 0,
    text: short,
    kind: 'note',
    fromCompanion: true,
  };
  // 插到队首：用户刚说完话，应该马上看到回应，而不是排在十条存量弹幕后面
  pending.unshift(item);
  shown.add(key0(item));
  if (!pumpTimer) scheduleFill(200);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clearPump() {
  if (pumpTimer !== null) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
}

/** 安排下一条。这条函数是整个层的「心跳」。 */
function scheduleFill(delay) {
  clearPump();
  if (!enabled) return;
  const bursting = burstUntil !== null && Date.now() < burstUntil;
  const gap = bursting ? rand(BURST_GAP) : rand(CALM_GAP);
  pumpTimer = window.setTimeout(() => {
    pumpTimer = null;
    if (burstUntil !== null && Date.now() >= burstUntil) burstUntil = null;
    if (pending.length === 0) {
      // 队列空了：如果这一章弹幕还没生成，去要一次；否则安静等着翻页
      const doc = state.book;
      const ch = doc?.chapters?.[state.chapterIndex];
      const has = ch ? cachedDanmaku(ch.id) : null;
      if (!has && !loading) {
        requestDanmaku();
        return; // 生成完会自己 scheduleFill
      }
      // 有存量但这一页放完了 —— 让心跳继续，翻页时 fillQueue 会重新填
      scheduleFill(rand(CALM_GAP));
      return;
    }
    range = currentRange(); // 翻页了就换成新页的区间
    emitOne();
    scheduleFill(0);
  }, delay);
}

function rand([a, b]) {
  return a + Math.random() * (b - a);
}

/* ---------------------------- 真的放一条 ---------------------------- */

/** 找一条当前没被占用的轨道；全都占用就返回 null（把这条丢弃） */
function freeLane() {
  const now = performance.now();
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i].until <= now) return i;
  }
  return -1;
}

/** 这一页该不该放。翻页过程中（纸面不可见）不放。 */
function canEmit() {
  if (!enabled || !L.layer || !L.paper) return false;
  if (!L.paper.isConnected) return false;
  if (L.paper.clientWidth === 0) return false;
  return true;
}

function emitOne() {
  if (!canEmit()) return;
  if (pending.length === 0) return;

  const lane = freeLane();
  if (lane < 0) return; // 轨道满了：直接丢这一条，不排队堆积

  const item = pending.shift();
  const node = el('span', { class: `dm dm--${item.kind}` }, item.text);

  const laneH = parseFloat(getComputedStyle(L.layer).getPropertyValue('--dm-lane')) || 30;
  node.style.top = `${8 + lane * laneH}px`;

  // 起点在纸面右侧外面一点，终点是「整条完全走完左侧」
  const layerW = L.layer.clientWidth || L.paper.clientWidth || 320;
  node.style.setProperty('--dm-from', `${layerW}px`);

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  L.layer.appendChild(node);

  if (reduced) {
    /* 减少动态：不走横向滚动，改成原地淡入淡出。
       这不是「简化版」，而是必须的 —— 前庭敏感的用户看横向移动的字会不适。 */
    node.classList.add('dm--static');
    const life = 3200;
    lanes[lane].until = performance.now() + life;
    window.setTimeout(() => node.remove(), life);
    return;
  }

  const w = node.getBoundingClientRect().width || 120;
  const speed = SPEED_PPS[state.settings.danmakuSpeed] || SPEED_PPS[2];
  const dist = layerW + w;
  const dur = Math.max(4200, Math.min(14000, (dist / speed) * 1000));
  node.style.setProperty('--dm-to', `${-(w + 12)}px`);
  node.style.setProperty('--dm-dur', `${Math.round(dur)}ms`);
  node.classList.add('dm--run');

  // 轨道占用的时间 = 这条字尾离开右边缘的时间（约 22%）+ 全长
  lanes[lane].until = performance.now() + dur * 0.22 + 300;

  // 兜底：万一 animationend 因为标签页切走没触发（浏览器会暂停动画），
  // 也要把节点收掉，不然回到页面时右边堆着一排看不见的字
  window.setTimeout(() => node.remove(), dur + 1200);
}

/* ---------------------------- 换书 ---------------------------- */

/** 打开新书时调用：清空状态，否则上一本的弹幕会飘到这一本上 */
export function mountDanmaku(doc) {
  initDanmaku();
  resetDanmakuCache();
  shown = new Set();
  pending = [];
  pageKey = '';
  clearPump();
  burstUntil = null;
  if (L.layer) L.layer.replaceChildren();
  enabled = !!state.settings.danmaku;
  if (L.layer) L.layer.classList.toggle('is-on', enabled);
  range = { from: 0, to: 0 };
  measureLanes();
}

/** 每次翻页后由 reader 的订阅链调用（目前是 chapter-rendered + 心跳里自查） */
export function syncDanmakuPage() {
  if (!enabled) return;
  const r = currentRange();
  if (r.from === range.from && r.to === range.to) return;
  range = r;
  fillQueue();
  scheduleFill(120);
}
