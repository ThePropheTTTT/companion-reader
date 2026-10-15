/* ============================================================
   陪读 · 批注层（页边标记 + 本章批注面板）
   ------------------------------------------------------------
   数据：state.ai[chapterId] = ChapterAI（见 core/model.js）
   批注按**全章段落下标 pi** 记账，而 DOM 里只有当前页的段落，
   两者之间的桥是 renderer.currentNodes() / nodeAt(pi)。

   ★★ 锚定方案：为什么段落里的批注标记绝对不能是一段内联文本 ★★
   试过的三条路，全都会被否掉：
     a) 段内插 <button> / <span>（哪怕 display:inline）
        —— 多出来一个字形就有宽度。中文正文没有「词」的概念，
           一个额外的字形会把这一行的断行点整体挪位，段落高度随之变化，
           分页结果当场作废（renderer.js 只测一次，不会因为你插了节点就重测）。
     b) 插零宽字符（U+200B / U+FEFF）
        —— 零宽的只有字形，不是断行机会。CJK 本来就可以在任意字之间断行，
           一个零宽空格会实打实多出一个断行点；而且文字被复制出去时带着脏字符。
     c) 在段落上挂 ::after 生成内容
        —— 有字形的照样有宽度（同 a）；content:'' 这种无字形生成盒在
           Safari 上会被直接折叠掉，画不出东西，白白骗自己。
   所以这里走「旁路」：
     · 段落本身**只加 class / data-***，不动一个字符、不加一个子节点
       （CSS 只用 margin / border / color 表达「这段有批注」，这些都在
        .page-body 已经预留好的 padding 里，不改变行盒宽度 → 高度不变）。
     · 可点的标记不放在段落里，放进一个独立的浮层 #note-layer：
       它挂在 .paper 下、和 .page-scroll 平级，position:absolute + inset:0，
       所以**不进入任何测量路径**：
         - 它不属于 .page-body，measureBlocks 读的是 body.children，看不见它；
         - 它不会成为正文的 offsetParent（body 和段落都还是静态定位），
           offsetTop 的坐标系保持原样；
         - 它不参与 .page-body 的行盒布局，正文排法与没有它时逐像素相同。
       位置用「段落的 offsetTop / 行高」换算成首行基线，画在正文两侧的页边里 ——
       正文 .page-body 有 --page-pad-x 与 --measure 双重约束，页边一定有空间。
     · 段落本体保留长按（520ms）作为第二入口，照顾没注意到页边圆点的人。

   ⚠ 记牢：只要给 .page-body 或它的任何祖先加 position:relative，
     段落的 offsetParent 就会变，measureBlocks 的 offsetChain 会走不到 host、
     拿到一堆非单调的 top，packPages 直接抛「blocks[i] 为负」。
     这个浮层能成立的前提就是 .paper 本身已经是定位上下文（reader.css）。
   ============================================================ */

import { state } from '../state.js';
import { el, clear, sheet, onLongPress } from './dom.js';

/* ⚠ reader.js 只走**动态** import，不写成顶部的静态 import。
   理由：本模块的绝大多数功能（列出批注、页边气泡、长按卡片）都不需要跳页，
   真正要跳页的只有「点某条批注」这一个动作。静态引入会把 reader.js 及其
   依赖链（renderer / core/media / core/epub）一起拖进批注层的加载路径，
   那条链上任何一处出问题都会连带让批注面板整块打不开。
   动态 import 让失败只影响「跳页」这一个动作。 */
function loadReader() {
  return import('./reader.js');
}

/* ------------------------------------------------------------------
   类型标签。kind 取值来自 core/model.js 的 makeNote，
   多出来的键留着兜底（数据比 UI 新的时候不至于显示成空白）。
   ------------------------------------------------------------------ */
const KINDS = {
  quip: { label: '吐槽', cls: 'quip' },
  note: { label: '笔记', cls: 'note' },
  ask: { label: '问题', cls: 'ask' },
  'spoiler-free-summary': { label: '无剧透梗概', cls: 'sum' },
};

const LAYER_ENABLED_KEY = 'note-layer-on';

/* ---------------------------- 模块内状态 ---------------------------- */
/* 只放「随会话/随DOM存在」的东西，能被重新推导出来；
   需要跨启动记住的只有页边气泡的开关，落在 localStorage 而不是 state.js。 */
let bound = false;
let layer = null; // #note-layer
let lastRenderer = null; // 最近一次 applyNotesToPage 拿到的渲染器
let observer = null; // 监听 .page-body 被换页重绘
let openCard = null; // 当前展开的批注小卡 { node, onDoc, onEsc }
let sheetOpen = false;
let enabled = readLayerPref();

function readLayerPref() {
  try {
    return localStorage.getItem(LAYER_ENABLED_KEY) === '1';
  } catch (err) {
    return false; // 隐私模式 / 无 storage：默认关闭
  }
}

function writeLayerPref(on) {
  try {
    localStorage.setItem(LAYER_ENABLED_KEY, on ? '1' : '0');
  } catch (err) {
    /* 存不下就算了，本次会话仍然生效 */
  }
}

/* ---------------------------- DOM 引用 ---------------------------- */

const D = {};
/** 抓引用，幂等。任何导出函数都可以先调它，避免「没 initNotes 就调用」炸掉。 */
function refs() {
  if (D.paper && D.paper.isConnected) return D;
  D.paper = document.getElementById('paper');
  D.scroll = document.getElementById('page-scroll');
  D.body = document.getElementById('page-body');
  // 找不到 #paper 时退回 body：没测量的场景下浮层放哪都不会错，
  // 而 ensureLayer 会自己判断「绝不能挂在 .page-body 里面」。
  D.host = D.paper || D.body || document.body;
  D.btn = document.getElementById('btn-notes');
  return D;
}

/**
 * 页边气泡层。只创建一次；被别处删掉（重新挂载视图）时自动重建。
 * 返回 null 表示现在还建不出来（DOM 骨架没就绪）。
 */
function ensureLayer() {
  const r = refs();
  if (!r.host) return null;
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.id = 'note-layer';
  layer.className = 'note-layer';
  layer.setAttribute('aria-hidden', layerHidden());
  r.host.append(layer);
  return layer;
}

/** 关掉时用 aria-hidden + class 一起表达，读屏和视觉不会打架 */
function layerHidden() {
  return enabled ? 'false' : 'true';
}

/* ---------------------------- 初始化 ---------------------------- */

/**
 * 抓 DOM 引用 + 绑定。重复调用无害。
 * 顶层刻意不碰 document（Node 下 import 本模块必须不炸），所以没写模块级自动 init。
 */
export function initNotes() {
  const r = refs();
  if (bound) return;
  bound = true;

  // 底部「批注」按钮 → 本章批注面板
  if (r.btn) {
    r.btn.addEventListener('click', () => {
      openNotesPanel().catch((err) => console.error('[notes] 面板打开失败', err));
    });
  }

  // 页边圆点：一次委托，别每条批注都挂监听
  if (layer) {
    layer.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('.note-pin') : null;
      if (btn) onPinClick(btn);
    });
  }

  // 段落长按 → 这一段的批注（第二入口，见文件头 c) 的取舍说明）
  if (r.body) {
    onLongPress(r.body, (e) => {
      // 用户正在选字时不要抢：选字本身就是长按手势
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length > 0) return;
      const p = e.target instanceof Element ? e.target.closest('[data-note-count]') : null;
      if (!p) return;
      const pi = Number(p.dataset.pi);
      const list = notesAt(pi);
      if (!list.length) return;
      const rect = p.getBoundingClientRect();
      showNoteCard(list[0], { x: rect.left + rect.width / 2, y: rect.bottom + 6 });
    });

    /* 翻页/换章都是 renderer 直接 replaceChildren，不发事件。
       监听子节点变化是唯一不漏的钩子：**只挂属性**（attributeFilter），
       我们自己往段落上加 class/dataset 时不会把回调再叫一遍。 */
    observer = new MutationObserver(() => refreshNotes());
    observer.observe(r.body, { childList: true });
  }

  applyLayerState();
}

/* ---------------------------- 数据 ---------------------------- */

function currentAI() {
  const doc = state.book;
  const ch = doc && doc.chapters ? doc.chapters[state.chapterIndex] : null;
  if (!ch || !state.ai) return null;
  return state.ai[ch.id] || null;
}

/** 本章批注：按 pi 升序，位置一样的按 likes 降序（好看的那个在前） */
function sortedNotes(ai) {
  const list = ai && Array.isArray(ai.notes) ? ai.notes.slice() : [];
  list.sort((a, b) => (a.pi || 0) - (b.pi || 0) || (b.likes || 0) - (a.likes || 0));
  return list;
}

/** pi → 本章批注数组 */
function notesAt(pi) {
  const ai = currentAI();
  const list = sortedNotes(ai);
  const out = [];
  for (let i = 0; i < list.length; i++) if (list[i].pi === pi) out.push(list[i]);
  return out;
}

const { pageStarts } = state;

/**
 * pi → 页下标：pageStarts 里最后一个 <= pi 的下标。
 * 注意 pageStarts 是**全章段落下标**，pi 也是章内下标，量纲一致，可以直接比。
 */
export function pageOfPi(pi) {
  const starts = state.pageStarts || [0];
  let page = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= pi) page = i;
    else break;
  }
  return page;
}

/** 原文摘录：取该段前 n 字，截断时补省略号。段落还没解析出来就返回空串。 */
function excerptOf(pi, n) {
  const doc = state.book;
  const ch = doc && doc.chapters ? doc.chapters[state.chapterIndex] : null;
  if (!ch) return '';
  if (!ch.body && !(ch.paras && ch.paras.length)) return ''; // 懒解析还没落盘
  const paras = Array.isArray(ch.paras) ? ch.paras : [];
  const para = paras[pi];
  if (!para) return '';
  const text = String(para.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const limit = n || 30;
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

/* ---------------------------- 1. 段落锚定 ---------------------------- */

/**
 * 给当前页段落打标记，并重画页边圆点。
 * @param {import('./renderer.js').ChapterRenderer|null} renderer  传 null = 清除本页标记
 * @param {import('../core/model.js').ChapterAI|null} chapterAI
 */
export function applyNotesToPage(renderer, chapterAI) {
  // 先收旧标记（上一页 / 上一章的），再决定这一页要不要打新的
  const stale = lastRenderer && typeof lastRenderer.currentNodes === 'function' ? lastRenderer.currentNodes() : null;
  unmark(stale);
  lastRenderer = renderer || null;

  if (!renderer || typeof renderer.currentNodes !== 'function') return;

  /* 取哪一份批注：
     - 传了对象 → 用传进来的（调用方刚拿到新数据，比 state 里的旧值可信）；
     - 传了 null → **理解为「没有批注」**，也就是清除口令 applyNotesToPage(renderer, null)。
       app.js 的 paintNotes() 正是这么调的（state.ai?.[ch.id] || null），
       它要表达的语义就是「这一章没批注就别画」——如果这里退回读 state.ai，
       本页刚被 unmark() 撤掉的类会被立刻加回来，清除就失效了（自测里就是这么炸的）。 */
  const ai = chapterAI || null;
  if (!ai) return;

  // pi -> 本段批注条数
  const byPi = new Map();
  const notes = sortedNotes(ai);
  for (let i = 0; i < notes.length; i++) {
    const pi = Number(notes[i].pi) || 0;
    byPi.set(pi, (byPi.get(pi) || 0) + 1);
  }
  if (!byPi.size) return;

  // currentNodes() 给的是**整章全局 pi**，而 DOM 里只有当前页 —— 这里不带任何局部下标换算
  const nodes = renderer.currentNodes();
  for (let i = 0; i < nodes.length; i++) {
    const item = nodes[i];
    const count = byPi.get(item.pi);
    if (!count || !item.el) continue;
    const node = item.el;
    node.classList.add('has-note');
    node.dataset.noteCount = String(count);
    // aria 也要说清楚，否则读屏用户完全不知道这段有批注
    node.setAttribute('aria-describedby', 'note-layer');
  }

  drawPins(nodes, byPi);
}

/**
 * 清除标记：只撤 class / dataset / aria，段落内容一个字符都没被改过。
 * 优先按「上一帧自己记下的段落元素」清 —— 元素引用比选择器可靠，
 * 而且不会误伤别处同样叫 .has-note 的东西（正文里可能有别的模块加的同名类）。
 * 没有 records 时（首次调用、或页面被整体重建过）才退回扫 DOM。
 */
function unmark(records) {
  closeNoteCard();
  const touched = [];
  if (records) {
    for (let i = 0; i < records.length; i++) {
      const n = records[i] && records[i].el;
      if (n) touched.push(n);
    }
  }
  if (!touched.length) {
    const r = refs();
    if (r.body) {
      const found = r.body.querySelectorAll('.has-note');
      for (let i = 0; i < found.length; i++) touched.push(found[i]);
    }
  }
  for (let i = 0; i < touched.length; i++) {
    touched[i].classList.remove('has-note');
    delete touched[i].dataset.noteCount;
    touched[i].removeAttribute('aria-describedby');
  }
  if (layer) clear(layer);
}

/** 把有批注的段落画成页边小圆点 */
function drawPins(nodes, byPi) {
  if (!enabled) return;
  const host = ensureLayer();
  if (!host) return;
  if (!host.clientWidth) return; // 正文还没布局出来（0 宽），这次不画，等下一次 refresh
  const hostRect = host.getBoundingClientRect();

  for (let i = 0; i < nodes.length; i++) {
    const item = nodes[i];
    const count = byPi.get(item.pi);
    if (!count || !item.el) continue;

    const pin = el('button', {
      class: 'note-pin',
      type: 'button',
      dataset: { pi: String(item.pi) },
      'aria-label': count > 1 ? `这一段有 ${count} 条批注` : '这一段有批注',
      title: count > 1 ? `${count} 条批注` : '看批注',
    });
    // 多一条批注给个数字，免得堆一摞点看不出来有几条
    if (count > 1) pin.append(el('span', { class: 'note-pin__num', text: count > 9 ? '9+' : String(count) }));

    /* 摆位只用**一次** getBoundingClientRect 量两件事（读布局，不写布局，绝不会反过来改分页）：
         · 纵向：段落框顶 + 半行高 = 首行中线（圆心对齐首行）
         · 横向：段落框右缘 - 浮层左缘 = 正文框右边界在浮层里的坐标
       然后用 CSS 里的 --note-pin-lift 把这个坐标当作「圆心」再回推外层热区的位置。
       之所以横向也量 rect 而不是拿 CSS 里的 --measure 算：正文框是被
       padding + max-width 夹出来的，口径不止一处，量出来最稳。 */
    const nodeRect = item.el.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(item.el).lineHeight);
    const halfLine = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight / 2 : 18;

    pin.style.top = `${Math.round(nodeRect.top - hostRect.top + halfLine)}px`;
    pin.style.left = `${Math.round(nodeRect.right - hostRect.left)}px`;
    host.append(pin);
  }
}

/* ---------------------------- 2. 页边气泡开关 ---------------------------- */

/** 页边小气泡开关。默认关闭。 */
export function setNotesLayerEnabled(on) {
  enabled = !!on;
  writeLayerPref(enabled);
  applyLayerState();
  refreshNotes();
}

function applyLayerState() {
  if (!layer) return;
  layer.classList.toggle('is-on', enabled);
  layer.setAttribute('aria-hidden', layerHidden());
  const r = refs();
  if (r.btn) r.btn.setAttribute('aria-pressed', String(!!enabled));
  if (!enabled) closeNoteCard();
}

/* ---------------------------- 3. 批注小卡 ---------------------------- */

function onPinClick(btn) {
  const pi = Number(btn.dataset.pi);
  const list = notesAt(pi);
  if (!list.length) return;
  const rect = btn.getBoundingClientRect();
  // 锚在圆点左侧展开，不盖住正文
  showNoteCard(list[0], { x: rect.left - 8, y: rect.top + rect.height / 2 });
}

/** 单条批注的浮出小卡。点别处 / 滚动 / Esc 关掉。 */
export function showNoteCard(note, at) {
  closeNoteCard();
  const host = ensureLayer();
  if (!host || !note) return;

  const kind = KINDS[note.kind] || KINDS.quip;
  const card = el(
    'div',
    { class: `note-card note-card--${kind.cls}`, role: 'note' },
    el(
      'div',
      { class: 'note-card__head' },
      el('span', { class: `note-kind note-kind--${kind.cls}`, text: kind.label }),
      note.likes ? el('span', { class: 'note-card__likes', text: `赞 ${note.likes}` }) : null
    ),
    el('p', { class: 'note-card__text', text: note.text || '（这条批注是空的）' })
  );
  host.append(card);

  // 摆位：只读测量，不写任何布局属性 → 不会反过来影响分页
  const r = refs();
  const W = r.scroll ? r.scroll.clientWidth : 320;
  const w = card.offsetWidth || 240;
  const h = card.offsetHeight || 80;
  let x = (at && at.x != null ? at.x : W / 2) - w;
  let y = (at && at.y != null ? at.y : 40) - h / 2;
  const min = 6;
  if (x < min) x = min; // 页边放不下就压回正文上方，别顶出视口
  if (x + w > W - min) x = Math.max(min, W - min - w);
  if (y < min) y = min;
  const maxY = (r.scroll ? r.scroll.clientHeight : 480) - h - min;
  if (y > maxY) y = Math.max(min, maxY);
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;

  requestAnimationFrame(() => card.classList.add('is-open'));

  const onDoc = (e) => {
    if (e.target === card || card.contains(e.target)) return;
    closeNoteCard();
  };
  const onEsc = (e) => {
    if (e.key === 'Escape') closeNoteCard();
  };
  const onScroll = () => closeNoteCard();
  // 用 capture：不等冒泡走完，翻页热区也会先关掉卡片
  document.addEventListener('pointerdown', onDoc, true);
  document.addEventListener('keydown', onEsc);
  if (r.scroll) r.scroll.addEventListener('scroll', onScroll, { passive: true });

  openCard = {
    node: card,
    off() {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onEsc);
      if (r.scroll) r.scroll.removeEventListener('scroll', onScroll);
    },
  };
}

export function closeNoteCard() {
  if (!openCard) return;
  const { node, off } = openCard;
  openCard = null;
  off();
  node.classList.remove('is-open');
  setTimeout(() => node.remove(), 160);
}

/* ---------------------------- 4. 本章批注面板 ---------------------------- */

function noteCountOf(ai) {
  return ai && Array.isArray(ai.notes) ? ai.notes.length : 0;
}

/** 打开「本章批注」面板。用 dom.js 的 sheet()，跟其它浮层保持同一套观感。 */
export async function openNotesPanel() {
  initNotes();
  if (sheetOpen) return;
  sheetOpen = true;

  const ai = currentAI();
  const doc = state.book;
  const chapter = doc && doc.chapters ? doc.chapters[state.chapterIndex] : null;
  const list = sortedNotes(ai);

  const s = sheet({
    title: '本章批注',
    side: outerWidth() >= 768 ? 'right' : 'bottom', // 宽屏做侧栏，别糊满全屏
    className: 'notes-sheet',
    onClose: () => {
      sheetOpen = false;
      closeNoteCard();
    },
  });

  const panel = el('div', { class: 'panel notes-panel' });
  s.body.append(panel);

  /* ---- 头部：章名 + 条数 ---- */
  panel.append(
    el(
      'header',
      { class: 'notes-head' },
      el('h2', {
        class: 'notes-head__title',
        text: (chapter && (chapter.title || `第 ${chapter.index + 1} 章`)) || '还没有打开书',
      }),
      el('p', {
        class: 'notes-head__meta',
        text: chapter ? `本章 ${list.length} 条批注` : '先打开一本书吧',
      })
    )
  );

  /* ---- 摘要 ---- */
  if (ai && ai.summary) {
    panel.append(
      el(
        'section',
        { class: 'notes-summary' },
        el('h3', { class: 'notes-h', text: '本章讲了什么' }),
        el('p', { class: 'notes-summary__text', text: ai.summary })
      )
    );
  }

  /* ---- 人物 ---- */
  if (ai && Array.isArray(ai.characters) && ai.characters.length) {
    const wrap = el('section', { class: 'notes-chars' }, el('h3', { class: 'notes-h', text: '出现的人物' }));
    const tags = el('div', { class: 'notes-chars__tags' });
    for (let i = 0; i < ai.characters.length; i++) {
      tags.append(el('span', { class: 'notes-char', text: String(ai.characters[i]) }));
    }
    wrap.append(tags);
    panel.append(wrap);
  }

  /* ---- 列表 ---- */
  if (!list.length) {
    // 空态要给「下一步做什么」，不能只留一片白
    panel.append(emptyState(chapter, ai));
  } else {
    panel.append(el('h3', { class: 'notes-h', text: '批注' }));
    const ul = el('ul', { class: 'notes-list' });
    for (let i = 0; i < list.length; i++) ul.append(noteRow(list[i], i));
    panel.append(ul);
    panel.append(el('p', { class: 'notes-hint', text: '点一条就跳到原文那一段。' }));
  }

  return s;
}

function noteRow(note, i) {
  const kind = KINDS[note.kind] || KINDS.quip;
  const excerpt = excerptOf(note.pi, 30);
  const page = pageOfPi(Number(note.pi) || 0);

  const row = el('button', {
    class: `note-item note-item--${kind.cls}`,
    type: 'button',
    dataset: { pi: String(note.pi || 0), index: String(i) },
    'aria-label': `第 ${note.pi + 1} 段，${kind.label}，跳到这一页`,
  });

  row.append(
    el(
      'div',
      { class: 'note-item__meta' },
      el('span', { class: `note-kind note-kind--${kind.cls}`, text: kind.label }),
      // 段落序号用 1 起，跟用户看到的「第几段」一致
      el('span', { class: 'note-item__pi', text: `第 ${(Number(note.pi) || 0) + 1} 段` }),
      el('span', { class: 'note-item__page', text: `第 ${page + 1} 页` })
    )
  );

  if (excerpt) {
    row.append(el('blockquote', { class: 'note-item__quote', text: excerpt }));
  } else {
    // 段落文本还没解析出来 / 是图片段：说明白，别让用户以为摘录丢了
    row.append(el('p', { class: 'note-item__quote note-item__quote--none', text: '（这一段没有可摘录的文字）' }));
  }

  row.append(el('p', { class: 'note-item__text', text: note.text || '（这条批注是空的）' }));

  if (note.likes) row.append(el('span', { class: 'note-item__likes', text: `赞 ${note.likes}` }));

  row.addEventListener('click', () => gotoNote(note, row));
  return row;
}

/** 点击一条批注：算页 → 跳转 → 关面板 */
async function gotoNote(note, row) {
  const pi = Number(note.pi) || 0;
  const page = pageOfPi(pi);
  const ai = currentAI();

  // 先把面板关掉：sheet 有自己的退场动画（240ms），不用等它，
  // 否则跳页会被动画拖出「点了没反应」的观感
  const host = row && row.closest ? row.closest('.sheet') : null;
  if (host && host.parentNode) {
    const backdrop = document.querySelector('.sheet-backdrop');
    if (backdrop) backdrop.remove();
    host.remove();
    sheetOpen = false;
  }

  if (!state.book) return;
  try {
    const { goChapter } = await loadReader();
    await goChapter(state.chapterIndex, { page });
  } catch (err) {
    console.error('[notes] 跳转失败', err);
    return;
  }
  // 跳完立刻把这一页的标记打上，不等下一帧的 MutationObserver
  if (lastRenderer) applyNotesToPage(lastRenderer, ai);
}

function emptyState(chapter, ai) {
  const hasSummary = !!(ai && ai.summary);
  return el(
    'div',
    { class: 'notes-empty' },
    el('p', { class: 'notes-empty__title', text: hasSummary ? '这一章还没有逐段批注' : '这一章还没有批注' }),
    el('p', {
      class: 'notes-empty__body',
      text: hasSummary
        ? '上面的摘要能先垫一垫。想要有段落的吐槽和笔记，去生成一下吧。'
        : chapter
          ? '点底部的「书搭子」生成这一章的批注，边看边有人搭话。'
          : '先回到书架挑一本书。',
    })
  );
}

/* ---------------------------- 重画 ---------------------------- */

/** 数据变了（刚生成完一章批注 / 换了设置）→ 重画当前页标记 */
export function refreshNotes() {
  const ai = currentAI();
  if (lastRenderer) {
    applyNotesToPage(lastRenderer, ai);
    return;
  }
  // 还没人递过 renderer：至少把旧的清掉，别留下上一章的圆点
  unmark(null);
}

/* ---------------------------- 小工具 ---------------------------- */

/** 视口宽度。用 window.innerWidth（不是 outerWidth，那个是整个浏览器窗口） */
function outerWidth() {
  return window.innerWidth || document.documentElement.clientWidth || 375;
}

/** 便于别处（调试/测试）问一句「现在这层开着吗」 */
export function notesLayerEnabled() {
  return enabled;
}
