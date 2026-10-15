/* ============================================================
   陪读 · 阅读进度
   ------------------------------------------------------------
   键名由 core/store.js 的 progressKey 定义（只有那一处拼字符串），
   本模块只负责「读写 + 结构校验」。

   ⚠ 存的是 **章内段落下标 pi**，不是页码。
     页码会随字号/行宽/设备变化，段落下标不会。
   ============================================================ */

import { store, progressKey } from '../core/store.js';

export { progressKey };

/**
 * @param {string} bookId
 * @returns {Promise<import('../core/model.js').Progress|null>}
 */
export async function loadProgress(bookId) {
  const v = await store.get(progressKey(bookId), null);
  if (!v || typeof v !== 'object' || !v.chapterId) return null;
  v.pi = Math.max(0, Math.round(Number(v.pi) || 0));
  v.percent = Math.min(100, Math.max(0, Number(v.percent) || 0));
  return v;
}

export async function saveProgress(bookId, progress) {
  const value = {
    chapterId: String(progress.chapterId || ''),
    pi: Math.max(0, Math.round(Number(progress.pi) || 0)),
    percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)),
    at: Date.now(),
  };
  return store.set(progressKey(bookId), value);
}

export async function clearProgress(bookId) {
  return store.del(progressKey(bookId));
}
