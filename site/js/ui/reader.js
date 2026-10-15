/* ============================================================
   陪读 · 阅读器交互层
   ------------------------------------------------------------
   分工：ui/renderer.js 管「一章怎么变成一页页」，本模块管
   「用户怎么翻、状态怎么记、别的东西怎么挂上来」。

   ⚠ 本文件曾经被一个子 agent 的自测桩整份覆盖（只留十几行假 goChapter），
     项目当时还没有 git，没有任何版本历史可回滚，只能靠重写恢复。
     为防再犯，约定写死在这里：

     · 导出面（别处在用，改签名要全仓搜）：
         initReader() / mountReader(doc) / goPage(delta) / goChapter(i, where)
         setRail(open) / overallPercent() / flushProgress() / getRenderer()
     · goChapter 两种签名都要支持：
         goChapter(3)               —— app.js / 目录 用
         goChapter(3, {page: 2})    —— notes-panel.js 跳页用
     · 每画完一页必须 emit('chapter-rendered', {chapterId, paras})：
       批注层（ui/notes-panel.js）与弹幕层（ui/danmaku.js）都挂在这个事件上，
       不 emit 的话它们全是死的。

   另一半约定是「什么触发什么」：
     · 翻页 / 切章   → 重排 DOM + emit('chapter-rendered')
     · 设置变了      → 先记下「当前页首段落」，再作废分页缓存重排
     · 视口变了      → 同上，但要等 iOS 的地址栏/旋转动画结束（320ms）
   ============================================================ */

import { state, emit, subscribe } from '../state.js';
import { throttleRaf } from './dom.js';
import { ChapterRenderer } from './renderer.js';
import { ensureParas, resolveImageSources, releaseImages } from '../core/media.js';
import { saveProgress } from './progress.js';

/* ---------------------------- DOM 引用 ---------------------------- */

const D = {};

function refs() {
  // 缓存，但页面结构被重建过（isConnected 为假）时重新抓
  if (D.scroll && D.scroll.isConnected) return D;
  D.view = document.getElementById('view-reader');
  D.reader = document.getElementById('reader');
  D.rail = document.getElementById('rail');
  D.railBody = document.getElementById('rail-body');
  D.pages = document.getElementById('pages');
  D.scroll = document.getElementById('page-scroll');
  D.body = document.getElementById('page-body');
  D.footChapter = document.getElementById('foot-chapter');
  D.footNum = document.getElementById('foot-num');
  D.tapPrev = document.getElementById('tap-prev');
  D.tapNext = document.getElementById('tap-next');
  D.pagerPrev = document.getElementById('pager-prev');
  D.pagerNext = document.getElementById('pager-next');
  D.btnRail = document.getElementById('btn-rail');
  D.btnRailClose = document.getElementById('btn-rail-close');
  D.title = document.getElementById('topbar-title');
  D.btnBack = document.getElementById('btn-back');
  D.btnSettings = document.getElementById('btn-read-settings');
  D.btnAI = document.getElementById('btn-ai');
  D.bottom = document.getElementById('bottombar');
  return D;
}

/* ---------------------------- 模块状态 ---------------------------- */

/** @type {ChapterRenderer|null} */
let R = null;
/** 当前书的文档（单独留一份是为了 unmount 时能放掉图片） */
let DOC = null;
/** 当前章的段落数组（整章，不是当前页） */
let CUR = null;
/** 当前页覆盖的整章 pi 区间 [from, toInclusive] */
let curRange = [0, 0];
let bound = false;
let saveTimer = null;
/** @type {WakeLockSentinel|null} */
let wakeLock = null;
let imgCleanup = null;
/** 阅读区可见性观察器（见 bindEvents 里那段注释）。换书时不用重建，只建一次。 */
let visObserver = null;

/* ---------------------------- 初始化 ---------------------------- */

/** 抓引用 + 绑事件。幂等，重复调用无害。 */
export function initReader() {
  const d = refs();
  if (!bound) {
    bound = true;
    bindEvents(d);
  }
  R = new ChapterRenderer({ scroll: d.scroll, body: d.body, foot: d.footNum });
  // 调试出口：把渲染器挂到 window.__peidu 上（app.js 建的那个只读把手）。
  // 「页码为什么是 1/1」这种问题只能靠看它每次布局量到的数才排得动，
  // 而它活在模块作用域里，控制台够不着。
  if (typeof window !== 'undefined' && window.__peidu) window.__peidu.renderer = R;
  return R;
}

/* ---------------------------- 挂载一本书 ---------------------------- */

/**
 * 打开一本书时调用。
 * @param {import('../core/model.js').BookDoc} doc
 */
export async function mountReader(doc) {
  const d = refs();
  if (!R) initReader();
  // 换书：把上一本的图片 blob URL 放掉，不然读十本书会一直占着内存
  if (DOC && DOC !== doc) releaseImages(DOC);
  DOC = doc;
  R.invalidate();
  CUR = null;
  curRange = [0, 0];

  if (d.title) d.title.textContent = doc.meta?.title || '陪读';
  if (d.btnBack) d.btnBack.hidden = false;
  if (d.btnRail) d.btnRail.hidden = false;
  if (d.btnSettings) d.btnSettings.hidden = false;
  if (d.btnAI) d.btnAI.hidden = false;
  if (d.bottom) d.bottom.hidden = false;
  setRail(defaultRailOpen());

  await buildToc();
  bindRelayout();

  const idx = Math.max(0, Math.min(doc.chapters.length - 1, state.chapterIndex || 0));
  const where = state.restoreWhere || { page: 0 };
  state.restoreWhere = null;
  await enterChapter(idx, where);
}

/* 宽屏（有常驻侧栏的空间）才默认把目录摊开 */
function defaultRailOpen() {
  return window.matchMedia?.('(min-width: 1000px) and (min-height: 620px)').matches ?? false;
}

/* ---------------------------- 目录 ---------------------------- */

async function buildToc() {
  const d = refs();
  if (!d.railBody) return;
  d.railBody.replaceChildren();
  const chapters = DOC?.chapters || [];
  const frag = document.createDocumentFragment();

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc__item';
    btn.dataset.index = String(i);
    // 深度缩进：不缩进就分不出「第一卷」和「第一章」
    btn.dataset.depth = String(Math.min(3, ch.depth || 0));
    btn.textContent = ch.title || `第 ${i + 1} 章`;
    if (i === state.chapterIndex) btn.classList.add('is-current');
    frag.append(btn);
  }

  if (chapters.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'toc__empty';
    empty.textContent = '这本书没解析出章节。';
    frag.append(empty);
  }
  d.railBody.append(frag);
}

function markTocActive() {
  const d = refs();
  if (!d.railBody) return;
  for (const item of d.railBody.querySelectorAll('.toc__item')) {
    const on = Number(item.dataset.index) === state.chapterIndex;
    item.classList.toggle('is-current', on);
    if (on) item.scrollIntoView({ block: 'nearest' });
  }
}

/* ---------------------------- 进章 ---------------------------- */

/**
 * 切到第 index 章。
 * @param {number} index
 * @param {{page?:number, targetPi?:number, toEnd?:boolean, ratio?:number}} [where]
 */
export async function goChapter(index, where = {}) {
  const chapters = DOC?.chapters || [];
  if (chapters.length === 0) return;
  const i = Math.max(0, Math.min(chapters.length - 1, Number(index) || 0));
  state.chapterIndex = i;
  await enterChapter(i, where);
}

async function enterChapter(index, where = {}) {
  const ch = DOC?.chapters?.[index];
  if (!ch) return;

  // ★ 章号必须在这里落定，不能只靠 goChapter 设。
  //   goPage 到章边界时是直接调 enterChapter 的（跨章翻页），如果这里不设，
  //   state.chapterIndex 会一直停在旧值：屏幕上是新一章的内容，而
  //   state 里还是旧章号 —— 于是"下一页"又走一遍跨章逻辑，
  //   表现为反复在「本章第 1 页 ↔ 本章最后一页」之间来回跳。
  state.chapterIndex = index;

  flushProgressNow(); // 换章前先把上一章的位置落盘

  const paras = ensureParas(DOC, ch);
  CUR = paras;

  // 图片要变成 blob URL 才能显示；没有 zip 句柄（从书架重开）时它会安静返回
  try {
    await resolveImageSources(DOC, paras, ch);
  } catch (err) {
    console.warn('[reader] 图片解析失败（正文不受影响）', err);
  }

  const strength = state.settings.anchorEnabled ? state.settings.strength : 0;
  const res = await R.layout(ch, paras, strength, where);
  if (!res) return; // 期间又切章了，本次作废

  state.pageStarts = res.pageStarts;
  state.pageIndex = res.page;
  R.lastParas = paras; // 弹幕层要用它算「这一页有哪些段」

  afterPaint(ch);
}

/** 翻页/换章之后的收尾：脚注、按钮可用性、目录高亮、广播、落盘 */
function afterPaint(ch) {
  const d = refs();
  const layout = R.layoutOf(ch.id);
  const total = layout ? layout.pageStarts.length : 1;

  if (d.footChapter) d.footChapter.textContent = ch.title || '';
  if (d.footNum) d.footNum.textContent = `${state.pageIndex + 1} / ${total}`;

  const first = state.pageIndex <= 0 && state.chapterIndex === 0;
  const lastChapter = state.chapterIndex >= (DOC?.chapters?.length || 1) - 1;
  const atEnd = state.pageIndex >= total - 1 && lastChapter;
  if (d.pagerPrev) d.pagerPrev.disabled = first;
  if (d.tapPrev) d.tapPrev.disabled = first;
  if (d.pagerNext) d.pagerNext.disabled = atEnd;
  if (d.tapNext) d.tapNext.disabled = atEnd;

  curRange = pageRange(layout, state.pageIndex);
  markTocActive();
  emit('chapter-rendered', { chapterId: ch.id, chapterIndex: state.chapterIndex, paras: CUR });
  // 弹幕层：翻页了，换一批（它自己判区间变没变，重复调用无害）
  import('./danmaku.js').then((m) => m.syncDanmakuPage?.()).catch(() => {});
  scheduleSaveProgress();
  wakeLockSync();
}

/** 当前页覆盖的整章 pi 区间（闭区间）。拿不到分页结果时退回整章。 */
function pageRange(layout, page) {
  const st = layout?.pageStarts;
  if (!st || st.length === 0) return [0, Math.max(0, (CUR?.length || 1) - 1)];
  const from = st[page] ?? 0;
  const to = page + 1 < st.length ? st[page + 1] - 1 : Math.max(from, (CUR?.length || 1) - 1);
  return [from, to];
}

/* ---------------------------- 翻页 ---------------------------- */

/**
 * 翻页。到章边界时自动跨章，跨章方向也要对：
 * 向前翻到下一章的第 0 页，向后翻到上一章的**最后一页**。
 */
export async function goPage(delta) {
  if (!DOC) return;
  const n = Number(delta) || 0;
  if (n === 0) return;

  const ch = DOC.chapters[state.chapterIndex];
  const layout = R.layoutOf(ch?.id);
  const total = layout ? layout.pageStarts.length : 1;
  const target = state.pageIndex + n;

  if (target >= 0 && target < total) {
    const strength = state.settings.anchorEnabled ? state.settings.strength : 0;
    R.paintPage(ch.id, target, layout.pageStarts, strength);
    state.pageIndex = target;
    R.lastParas = CUR;
    afterPaint(ch);
    return;
  }

  if (target < 0) {
    if (state.chapterIndex <= 0) return;
    // 上一章的最后一页 —— 必须用 toEnd，否则会回到上一章第一页
    await enterChapter(state.chapterIndex - 1, { toEnd: true });
    return;
  }

  if (state.chapterIndex >= DOC.chapters.length - 1) return;
  await enterChapter(state.chapterIndex + 1, { page: 0 });
}

/* ---------------------------- 侧栏 ---------------------------- */

export function setRail(open) {
  const d = refs();
  const on = !!open;
  state.railOpen = on;
  if (d.reader) d.reader.classList.toggle('has-rail', on);
  if (d.rail) d.rail.classList.toggle('is-open', on);
  if (d.btnRail) d.btnRail.setAttribute('aria-expanded', on ? 'true' : 'false');
}

/* ---------------------------- 进度 ---------------------------- */

/**
 * 全书百分比，**按字数加权**而不是「第几章 / 总章数」。
 * 理由：一本 12 章的书里第 1 章可能占 40% 篇幅，按章数算会让进度条
 * 读数完全失真（前 40% 的阅读量显示成 8%）。
 */
export function overallPercent() {
  const chapters = DOC?.chapters || [];
  if (chapters.length === 0) return 0;

  const sizeOf = (ch) => {
    if (typeof ch.charCount === 'number' && ch.charCount > 0) return ch.charCount;
    if (typeof ch.body === 'string' && ch.body.length) return ch.body.length;
    return 0;
  };
  let before = 0;
  let total = 0;
  for (let i = 0; i < chapters.length; i++) {
    const s = sizeOf(chapters[i]);
    total += s;
    if (i < state.chapterIndex) before += s;
  }
  if (total <= 0) return 0;

  // 章内进度同样按字数：读到当前页末尾为止，本章已经过了多少字
  const upto = Math.min(CUR?.length || 0, curRange[1] + 1);
  let within = 0;
  for (let i = 0; i < upto; i++) within += (CUR?.[i]?.text || '').length;

  const pct = ((before + within) / total) * 100;
  return Math.max(0, Math.min(100, pct));
}

function scheduleSaveProgress() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  // 翻页很快，等 600ms 安静下来再写；关页面时 flushProgress 会强制写
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    flushProgress();
  }, 600);
}

/** 把当前「读到哪」落盘。pi 记的是**页首段落的段落下标**，不是页码。 */
export async function flushProgress() {
  if (!DOC || !CUR) return;
  const ch = DOC.chapters[state.chapterIndex];
  if (!ch) return;
  const percent = overallPercent();
  try {
    await saveProgress(DOC.meta.id, { chapterId: ch.id, pi: curRange[0], percent });
    // 书架上的进度条靠这个事件更新（书架不需要知道页码）
    document.dispatchEvent(new CustomEvent('peidu:progress', { detail: { percent } }));
  } catch (err) {
    console.warn('[progress] 保存失败', err);
  }
}

function flushProgressNow() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  flushProgress();
}

/* ---------------------------- 屏幕常亮 ---------------------------- */

/** keepAwake 打开时申请 Wake Lock；切回前台要重新申请（系统会主动释放） */
async function wakeLockSync() {
  const want = !!state.settings.keepAwake && state.view === 'reader';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    // 低电量模式 / 非前台会直接拒绝，这是正常的，不打扰用户
    console.debug('[reader] 屏幕常亮不可用', err?.message || err);
    wakeLock = null;
  }
}

/* ---------------------------- 事件绑定 ---------------------------- */

function bindEvents(d) {
  /* ---- 点按热区 / 悬浮箭头 ---- */
  d.tapPrev?.addEventListener('click', () => goPage(-1));
  d.tapNext?.addEventListener('click', () => goPage(1));
  d.pagerPrev?.addEventListener('click', () => goPage(-1));
  d.pagerNext?.addEventListener('click', () => goPage(1));

  /* ---- 目录：委托一次，别给几百个章节各挂一个 ---- */
  d.railBody?.addEventListener('click', (e) => {
    const item = e.target instanceof Element ? e.target.closest('.toc__item') : null;
    if (!item) return;
    goChapter(Number(item.dataset.index), { page: 0 });
    // 窄屏是抽屉样式：选完要收起来，否则挡着正文
    if (window.matchMedia('(max-width: 999px)').matches) setRail(false);
  });
  d.btnRail?.addEventListener('click', () => setRail(!state.railOpen));
  d.btnRailClose?.addEventListener('click', () => setRail(false));

  /* ---- 键盘（桌面 / iPad 外接键盘）---- */
  window.addEventListener('keydown', (e) => {
    if (state.view !== 'reader') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    // 在输入框里打字时不要翻页
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

    switch (e.key) {
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        goPage(-1);
        break;
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        e.preventDefault();
        goPage(1);
        break;
      case 'Escape':
        if (state.railOpen) setRail(false);
        break;
      default:
        break;
    }
  });

  /* ---- 左右滑动翻页 ----
     阈值同时看「横向距离」和「方向比例」：
     正文本身可以上下滚（长段落/图片），只判 dx 会让纵向滚动误触翻页。 */
  let sx = 0;
  let sy = 0;
  let tracking = false;
  const SWIPE_MIN = 60;
  d.pages?.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      tracking = true;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    },
    { passive: true }
  );
  d.pages?.addEventListener(
    'touchend',
    (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches?.[0];
      if (!t) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (Math.abs(dx) < SWIPE_MIN) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.6) return; // 更像纵向滚动，放行
      goPage(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );

  /* ---- 视口变化：旋转 / iOS 地址栏伸缩 ----
     必须延迟：iOS 旋转过程中 clientHeight 会连着报好几个中间值，
     当场重排会按错误高度分页（末页被裁）；等布局稳定再量。 */
  let vpTimer = null;
  const onViewport = () => {
    if (vpTimer !== null) clearTimeout(vpTimer);
    vpTimer = window.setTimeout(() => {
      vpTimer = null;
      if (state.view === 'reader') relayout();
    }, 320);
  };
  window.addEventListener('orientationchange', onViewport);
  window.addEventListener('resize', onViewport);

  /* ---- 阅读区从「不可见」变成「可见」时必须重排 ----
     为什么必须有这条：分页依赖容器高度，而容器在 display:none 时高度是 0。
     打开一本书的过程中，如果视图还没真正可见（或者刚可见、浏览器尚未完成
     布局），量到的就是 0，于是整章被当成一页 —— 页脚永远 1/1，正文靠滚动看。
     renderer 会拒收这种结果（不缓存），但拒收之后必须有人再来量一次，
     这条监听就是那个人。
     IntersectionObserver 比"在 app 里切视图时通知一下"可靠：它不关心是谁
     让容器变可见的（切视图、旋转、键盘收起都算）。 */
  if (typeof IntersectionObserver === 'function') {
    let wasVisible = false;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.some((e) => e.isIntersecting && e.intersectionRect.height > 8);
        if (vis && !wasVisible && state.view === 'reader') {
          // 刚刚变得可见：先等一帧让高度定下来
          requestAnimationFrame(() => relayout());
        }
        wasVisible = vis;
      },
      { threshold: [0, 0.01] }
    );
    io.observe(d.scroll);
    visObserver = io;
  }

  /* ---- 切回前台：唤醒锁会被系统释放，重新申请；离开时补一次落盘 ---- */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wakeLockSync();
    else flushProgressNow();
  });

  /* ---- 图片解码完会改高度 → 分页要重算 ----
     一次捕获阶段监听全部 img 的 load，不用给每张图挂监听。 */
  d.body?.addEventListener(
    'load',
    (e) => {
      if (e.target instanceof HTMLImageElement) relayout();
    },
    true
  );
}

/* ---------------------------- 重排 ---------------------------- */

let boundRelayout = false;

/** 设置/视口变化 → 作废分页缓存并重排，但要把「读到哪」带过去 */
function bindRelayout() {
  if (boundRelayout) return;
  boundRelayout = true;

  /* 会改变分页的字段。亮度、弹幕速度这些改了不用重排，
     否则调一次亮度就闪一下。 */
  const RELAYOUT_KEYS = new Set([
    'fontSize',
    'lineHeight',
    'paraSpacing',
    'measure',
    'wideMeasure',
    'fontFamily',
    'theme',
    'strength',
    'anchorEnabled',
  ]);

  subscribe((topic, detail) => {
    if (topic === 'settings') {
      const keys = detail ? Object.keys(detail) : [];
      if (keys.some((k) => RELAYOUT_KEYS.has(k))) relayout();
      else if (keys.includes('keepAwake')) wakeLockSync();
      return;
    }
    if (topic === 'relayout') relayout();
  });
}

const relayout = throttleRaf(async () => {
  if (state.view !== 'reader' || !DOC || !R) return;
  const ch = DOC.chapters[state.chapterIndex];
  if (!ch) return;
  if (!CUR) CUR = ensureParas(DOC, ch);

  // 记下「当前页是从哪一段开始的」——重排后页码会变，段落下标不会
  const anchorPi = curRange[0];
  R.invalidate();
  const strength = state.settings.anchorEnabled ? state.settings.strength : 0;
  const res = await R.layout(ch, CUR, strength, { targetPi: anchorPi });
  if (!res) return;
  state.pageStarts = res.pageStarts;
  state.pageIndex = res.page;
  R.lastParas = CUR;
  afterPaint(ch);
});

/* ---------------------------- 给外部用的只读接口 ---------------------------- */

/** 批注层要用它读当前页渲染出了哪些段落（见 renderer.js 的 currentNodes） */
export function getRenderer() {
  return R;
}

void imgCleanup;
