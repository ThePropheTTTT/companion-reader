/* ============================================================
   陪读 · 全局状态
   单一 store，视图层订阅。刻意不做响应式代理：
   阅读器每次翻页都会改很多字段，响应式反而会把重绘放大。
   ============================================================ */

import { store } from './core/store.js';
import { DEFAULT_SETTINGS } from './core/model.js';

const SETTINGS_KEY = 'settings';
/**
 * @typedef {Object} State
 * @property {'library'|'reader'} view
 * @property {import('../core/model.js').BookDoc|null} book
 * @property {number} chapterIndex      当前章下标
 * @property {number} pageIndex         当前页下标（章内）
 * @property {number[]} pageStarts      当前章分页结果
 * @property {Object} settings
 * @property {boolean} railOpen         窄屏抽屉 / 宽屏侧栏
 * @property {'toc'|'notes'} railTab
 * @property {Object<string, import('../core/model.js').ChapterAI>} ai   chapterId -> 产物
 */

/** @type {State} */
export const state = {
  view: 'library',
  book: null,
  chapterIndex: 0,
  pageIndex: 0,
  pageStarts: [0],
  settings: { ...DEFAULT_SETTINGS },
  railOpen: false,
  railTab: 'toc',
  ai: {},
  // 运行时（不持久化）
  busy: false,
  device: 'phone',
};

/* ---------------------------- 订阅 ---------------------------- */

const listeners = new Set();

/** 订阅任意变更，返回取消订阅函数 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 通知变更。topic 是给人看的标签，方便调试。 */
export function emit(topic = 'change', detail) {
  for (const fn of listeners) {
    try {
      fn(topic, detail);
    } catch (err) {
      console.error('[state] listener failed on', topic, err);
    }
  }
}

/** 改设置并落盘。只传要改的字段。 */
export function patchSettings(patch, { persist = true } = {}) {
  Object.assign(state.settings, patch);
  if (persist) {
    // 不 await：设置要即时生效，落盘慢一点没关系
    store.set(SETTINGS_KEY, state.settings).catch((err) => console.warn('[state] 设置保存失败', err));
  }
  emit('settings', patch);
}

export async function loadSettings() {
  try {
    const saved = await store.get(SETTINGS_KEY, null);
    if (saved && typeof saved === 'object') {
      // 用默认值兜底：老版本存下来的设置可能缺字段
      state.settings = { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (err) {
    console.warn('[state] 设置读取失败，用默认值', err);
  }
  return state.settings;
}
