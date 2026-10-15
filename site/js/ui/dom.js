/* ============================================================
   陪读 · DOM / 格式化小工具
   刻意不用任何框架：阅读器每章要重建上千个节点，
   虚拟 DOM 的 diff 在这里是纯开销。
   ============================================================ */

/** 创建元素。props 里的 `class`/`text`/`html` 特殊处理，其余走 setAttribute。 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    // ★ 函数值必须当事件处理器挂上去，不能走 setAttribute。
    //   走 setAttribute(node, '() => onOpen(meta)') 只会写成一个**字符串属性**，
    //   点击时浏览器既不报错也什么都不做 —— library.js 的书卡就是这么写的，
    //   结果是"书架上的书点不开"，而且控制台一声不响。
    else if (typeof v === 'function') node[k] = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

export function svg(path, { size = 20, width = 1.7 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', width);
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}

export function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * 稳定排序：按 key 数值升序，key 相同保持原插入顺序。
 * 目录、批注列表都依赖这个——不稳定排序会让每次渲染顺序抖动。
 */
export function sortBy(list, getKey) {
  return list
    .map((v, i) => [v, getKey(v), i])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([v]) => v);
}

/* ---------------------------- 格式化 ---------------------------- */

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtChars(n) {
  if (!Number.isFinite(n)) return '';
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}

export function fmtRelative(ms) {
  const d = Date.now() - ms;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  const t = new Date(ms);
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
}

/** 中文序数：1 → 第一章 */
export function cnNum(n) {
  const d = '零一二三四五六七八九';
  if (n <= 10) return n === 10 ? '十' : d[n];
  if (n < 20) return `十${d[n % 10]}`;
  if (n < 100) return `${d[Math.floor(n / 10)]}十${n % 10 ? d[n % 10] : ''}`;
  return String(n);
}

/* ---------------------------- 交互 ---------------------------- */

export const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * 等一帧，但至少等 `minMs` 毫秒。
 *
 * 为什么需要它：只等 rAF 在本机上完全够用，可真实设备上「阅读视图刚从
 * display:none 变成可见」的那一两帧里，容器高度可能还是 0 —— 移动端
 * Safari 尤其如此（它会把布局推迟到滚动/动画这一帧处理完之后）。
 * 量到 0 就会把整章当成一页，末页被裁，而且会被缓存下来。
 * tools/smoke.mjs 正是靠这条发现「导入后整章挤在一页」的。
 */
export const settleFrame = (minMs = 90) =>
  new Promise((r) => {
    const t0 = Date.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const left = minMs - (Date.now() - t0);
      if (left > 0) setTimeout(r, left);
      else r();
    }));
  });

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttleRaf(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

/**
 * 长按检测（用于段落上「对这段说点什么」）。
 * 因为要容忍滑动，阈值给得比较宽：600ms 内移动不超过 10px 才算长按。
 */
export function onLongPress(node, handler, { ms = 520, move = 12 } = {}) {
  let timer = 0;
  let sx = 0;
  let sy = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };
  node.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      sx = e.clientX;
      sy = e.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = 0;
        handler(e);
      }, ms);
    },
    { passive: true }
  );
  node.addEventListener(
    'pointermove',
    (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - sx) > move || Math.abs(e.clientY - sy) > move) cancel();
    },
    { passive: true }
  );
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) {
    node.addEventListener(ev, cancel, { passive: true });
  }
  return cancel;
}

/* ---------------------------- 吐司 ---------------------------- */

let toastHost = null;

/** 同时最多留几条。超了从最旧的开始丢。 */
const TOAST_MAX = 3;
/** 同一句话重复出现时，刷新那一条的计时而不是再叠一条 */
const liveToasts = new Map();

export function toast(message, { error = false, ms = 2600 } = {}) {
  toastHost ||= document.getElementById('toasts');
  if (!toastHost) return;
  const text = String(message ?? '');

  /* 同一句话已经在屏幕上：只把它的倒计时重新开始，不再叠一条。
     为什么必须去重 —— 用户连点几次按钮，或者一节里有几处都报同一个原因，
     屏幕上就会立起一堵同样的提示墙（截图里出现过 13 条一模一样的
     「先去 AI 设置里填一个 API Key」）。提示墙比不提示更糟：它挡住正文，
     而且把"我点了没反应"变成"我看不见任何东西"。 */
  const dup = liveToasts.get(text);
  if (dup && dup.node.isConnected) {
    clearTimeout(dup.timer);
    dup.node.classList.remove('toast--pop');
    void dup.node.offsetWidth; // 强制重排，让动画能重放
    dup.node.classList.add('toast--pop');
    dup.timer = scheduleDismiss(dup.node, ms, text);
    return dup.node;
  }

  const node = el('div', { class: error ? 'toast toast--err' : 'toast', text });
  node.classList.add('toast--pop');
  toastHost.append(node);

  // 上限：丢最旧的（它可能正在退场动画里，直接从表里清掉即可）
  const alive = [...toastHost.children];
  if (alive.length > TOAST_MAX) {
    for (const old of alive.slice(0, alive.length - TOAST_MAX)) {
      const t = old.textContent;
      const rec = liveToasts.get(t);
      if (rec) {
        clearTimeout(rec.timer);
        liveToasts.delete(t);
      }
      old.remove();
    }
  }

  const timer = scheduleDismiss(node, ms, text);
  liveToasts.set(text, { node, timer });
  return node;
}

function scheduleDismiss(node, ms, text) {
  return setTimeout(() => {
    liveToasts.delete(text);
    node.style.transition = 'opacity 200ms, transform 200ms';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ---------------------------- 浮层 ---------------------------- */

/**
 * 通用抽屉/面板。返回 { root, close }。
 * 焦点陷阱只做最必要的一件事：打开时记录并聚焦，关闭时归还焦点。
 * iOS 上还要处理「键盘弹出把面板顶上去」——用 visualViewport 兜。
 */
export function sheet({
  title,
  side = 'bottom',
  className = '',
  onClose,
  dismissible = true,
} = {}) {
  const host = document.getElementById('overlay-root');
  const backdrop = el('div', { class: 'sheet-backdrop' });
  const root = el('div', {
    class: `sheet sheet--${side} ${className}`.trim(),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || '面板',
  });
  const body = el('div', { class: 'sheet__body' });
  root.append(body);

  const prevFocus = document.activeElement;
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    root.classList.add('is-closing');
    backdrop.classList.add('is-closing');
    const done = () => {
      root.remove();
      backdrop.remove();
      if (prevFocus instanceof HTMLElement && prevFocus.isConnected) prevFocus.focus();
      onClose?.(result);
    };
    setTimeout(done, 240);
  };

  if (dismissible) {
    backdrop.addEventListener('click', () => close());
    // 下滑关闭（只在 bottom sheet 且内容未滚动时生效）
    let sy = 0;
    let dragging = false;
    root.addEventListener(
      'pointerdown',
      (e) => {
        if (side !== 'bottom') return;
        const head = e.target instanceof Element && e.target.closest('.sheet__grip,.sheet__head');
        if (!head) return;
        dragging = true;
        sy = e.clientY;
        root.style.transition = 'none';
      },
      { passive: true }
    );
    root.addEventListener(
      'pointermove',
      (e) => {
        if (!dragging) return;
        const dy = Math.max(0, e.clientY - sy);
        root.style.transform = `translateY(${dy}px)`;
      },
      { passive: true }
    );
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      root.style.transition = '';
      const dy = Math.max(0, (e.clientY || 0) - sy);
      if (dy > 96) close();
      else root.style.transform = '';
    };
    root.addEventListener('pointerup', endDrag, { passive: true });
    root.addEventListener('pointercancel', endDrag, { passive: true });
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) close();
  };
  document.addEventListener('keydown', onKey);
  const origClose = close;
  const wrappedClose = (r) => {
    document.removeEventListener('keydown', onKey);
    origClose(r);
  };

  host.append(backdrop, root);
  requestAnimationFrame(() => {
    backdrop.classList.add('is-open');
    root.classList.add('is-open');
  });
  return { root, body, close: wrappedClose, backdrop };
}

/** 简易确认框，返回 Promise<boolean> */
export function confirmDialog(message, { ok = '确定', cancel = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet({
      title: '确认',
      className: 'sheet--confirm',
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    s.body.append(
      el('p', { class: 'confirm__msg', text: message }),
      el(
        'div',
        { class: 'confirm__actions' },
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: cancel,
          onclick: () => {
            answered = true;
            resolve(false);
            s.close();
          },
        }),
        el('button', {
          class: `btn${danger ? ' btn--danger' : ''}`,
          type: 'button',
          text: ok,
          onclick: () => {
            answered = true;
            resolve(true);
            s.close();
          },
        })
      )
    );
  });
}
