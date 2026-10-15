/* ============================================================
   陪读 · 书架
   刻意做成列表而不是封面网格：
   EPUB 封面经常缺失/畸形，格子会参差不齐；列表在竖屏一屏能放更多本。
   ============================================================ */

import { el, clear, fmtBytes, fmtChars, fmtRelative, cnNum } from './dom.js';

/** 给每本书算一个稳定的「封面色」，用书名的码点和取模，避免整片灰 */
const COVER_COLORS = [
  ['#f3e2da', '#a4472f'],
  ['#e2ece6', '#3f6a63'],
  ['#e6e4f2', '#5a4d8a'],
  ['#f4ead6', '#8a6a24'],
  ['#e3e9f2', '#39557f'],
  ['#f2e3ea', '#8a3d63'],
  ['#e9efe0', '#4f6c2f'],
  ['#ece7e0', '#6b5a46'],
];

function coverColor(title) {
  let h = 0;
  for (const ch of title || '') h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COVER_COLORS[h % COVER_COLORS.length];
}

function coverNode(meta) {
  const [bg, fg] = coverColor(meta.title);
  if (meta.cover) {
    return el(
      'div',
      { class: 'bookcard__cover', style: { background: bg } },
      el('img', { src: meta.cover, alt: '', loading: 'lazy', decoding: 'async' })
    );
  }
  return el('div', {
    class: 'bookcard__cover bookcard__cover--text',
    style: { background: bg, color: fg },
    // 无封面时用书名前几个字当「字面封面」，比灰色占位好认
    text: (meta.title || '?').slice(0, 4),
  });
}

function bookRow(meta, { onOpen, onDelete }) {
  const readPct = Math.round(meta.percent || 0);
  return el(
    'li',
    { class: 'bookcard' },
    el(
      'button',
      {
        class: 'bookcard__main',
        type: 'button',
        onclick: () => onOpen(meta),
        'aria-label': `打开《${meta.title}》`,
      },
      coverNode(meta),
      el(
        'div',
        { class: 'bookcard__info' },
        el('div', { class: 'bookcard__title', text: meta.title || '未命名' }),
        el('div', { class: 'bookcard__author', text: meta.author || '佚名' }),
        el('div', {
          class: 'bookcard__meta',
          text: [
            meta.format ? meta.format.toUpperCase() : '',
            meta.chapterCount ? `${meta.chapterCount} 章` : '',
            fmtChars(meta.charCount),
            fmtBytes(meta.size),
          ]
            .filter(Boolean)
            .join(' · '),
        }),
        readPct > 0
          ? el(
              'div',
              { class: 'bookcard__progress' },
              el('div', { class: 'bookcard__bar' }, el('i', { style: { width: `${readPct}%` } })),
              el('span', { class: 'bookcard__pct', text: `${readPct}%` })
            )
          : null
      )
    ),
    el(
      'button',
      {
        class: 'bookcard__more',
        type: 'button',
        'aria-label': `删除《${meta.title}》`,
        onclick: (e) => {
          e.stopPropagation();
          onDelete(meta);
        },
      },
      '⋯'
    )
  );
}

function emptyState({ onImport }) {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'empty__mark', text: '📖' }),
    el('p', { class: 'empty__title', text: '书架是空的' }),
    el('p', {
      class: 'empty__body',
      text: '丢一本 EPUB 进来吧。我会先粗读一遍，在你可能想停下来聊两句的地方写好批注，读到那儿就冒出来。',
    }),
    el('button', {
      class: 'btn',
      type: 'button',
      text: '选一本书',
      onclick: onImport,
    }),
    el('p', {
      class: 'empty__hint',
      text: '支持 .epub 和 .txt，全部在本地解析，书不会上传到任何地方。',
    })
  );
}

/**
 * @param {HTMLElement} host
 * @param {import('../core/model.js').BookMeta[]} books
 * @param {{onOpen:(m:any)=>void, onDelete:(m:any)=>void}} handlers
 */
export function mountLibrary(host, books, handlers) {
  clear(host);
  if (!books.length) {
    host.append(emptyState({ onImport: () => document.getElementById('file-input').click() }));
    return;
  }

  const total = books.length;
  host.append(
    el(
      'div',
      { class: 'library__head' },
      el('h1', { class: 'library__title', text: '我的书架' }),
      el('span', { class: 'library__count', text: `${total} 本` }),
      el('button', {
        class: 'btn btn--ghost library__add',
        type: 'button',
        text: '＋ 导入',
        onclick: () => document.getElementById('file-input').click(),
      })
    ),
    el(
      'ul',
      { class: 'booklist' },
      ...books.map((m) => bookRow(m, handlers))
    ),
    el('p', {
      class: 'library__foot',
      text: '书只存在这台设备的浏览器里。换设备或清空网站数据就没了，记得留个原文件。',
    })
  );
}
