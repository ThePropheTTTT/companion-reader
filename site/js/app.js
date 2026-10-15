/* ============================================================
   陪读 · 启动与编排
   ============================================================ */

import { state, emit, subscribe, loadSettings } from './state.js';
import { store } from './core/store.js';
import { parseEPUB, parseTXT } from './core/epub.js';
import { bookIdOf } from './core/model.js';
import { $, el, toast, debounce, confirmDialog } from './ui/dom.js';
import { mountLibrary } from './ui/library.js';
import { mountReader } from './ui/reader.js';

window.__peiduBooted = true;

/*
 * 调试出口。
 *
 * 为什么要有：这个应用的绝大部分状态（当前章、分页表、设置）都活在模块作用域里，
 * 浏览器控制台看不见 —— 于是"页码为什么是 1/1""为什么这一章分成了三页"
 * 这类问题只能靠猜。留一个只读的把手，排查时能直接把 state 打出来。
 *
 * 它是**只读约定**（虽然对象本身是可变的）：不要在应用代码里用它，
 * 应用代码该走 import；这个出口只给控制台和 tools/smoke.mjs 用。
 */
window.__peidu = {
  state,
  store,
  version: '0.1.0',
};

/* ---------------------------- 设备档位 ---------------------------- */

/**
 * 判定排版档位。不能只看宽度：
 * iPad 分屏后可能只有 500px 宽，但依然是平板（字号、行宽、目录侧栏都该按平板走）。
 * 所以先看指针能力 + 最短边。
 */
function detectDevice() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const minSide = Math.min(w, h);
  // iPad 最短边 744（mini 竖屏）起；iPhone 最长边也不超过 ~932
  const coarse = matchMedia('(pointer: coarse)').matches;
  const isTabletish = minSide >= 700 || (!coarse && w >= 1024);
  const device = isTabletish ? 'tablet' : 'phone';
  document.documentElement.dataset.device = device;
  state.device = device;
  return device;
}

/** 按档位给出每行字数，用户手动调过就尊重用户的值 */
function applyMeasure() {
  const s = state.settings;
  if (s.measureByDevice === false) {
    document.documentElement.style.setProperty('--measure', String(s.measure || 24));
    return;
  }
  const base = state.device === 'tablet' ? s.wideMeasure || 34 : s.measure || 22;
  // 窄屏再收一点，避免一行挤太多字导致换行太快
  const w = window.innerWidth;
  const tuned = w < 380 ? base - 2 : w < 430 ? base - 1 : base;
  document.documentElement.style.setProperty('--measure', String(tuned));
}

function applySettingsToDom() {
  const s = state.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme || 'paper';

  // 字体：model 里存的是 FONT_STACKS 的 key（serif/sans/kai），
  // 而 CSS 用的是 data-font（song/hei/kai）——这里做唯一一次翻译。
  // ⚠ 别把 'serif' 直接写进 data-font，CSS 里没有 [data-font='serif'] 这条规则，
  //   会静默退回 tokens.css 的默认字体，换了字体却没反应。
  const FONT_ATTR = { serif: 'song', sans: 'hei', kai: 'kai' };
  root.dataset.font = FONT_ATTR[s.fontFamily] || 'song';

  root.style.setProperty('--fs-read', `${s.fontSize}px`);
  root.style.setProperty('--lh-read', String(s.lineHeight));
  root.style.setProperty('--para-gap', `${s.paraSpacing}em`);
  root.style.setProperty(
    '--anchor-ls-comp',
    s.anchorColor === 'inherit' ? '-0.01em' : '-0.01em'
  );

  // 外壳明暗：'auto' 跟随系统
  const wantDark =
    s.chrome === 'dark' ||
    (s.chrome === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.chrome = wantDark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', wantDark ? '#1a1c20' : '#f6f4ef');
}

/* ---------------------------- 视图切换 ---------------------------- */

export function showView(name) {
  state.view = name;
  $('#view-library').hidden = name !== 'library';
  $('#view-reader').hidden = name !== 'reader';
  $('#bottombar').hidden = name !== 'reader';
  $('#btn-back').hidden = name !== 'reader';
  $('#btn-import').hidden = name === 'reader';
  $('#btn-rail').hidden = name !== 'reader';
  $('#btn-read-settings').hidden = name !== 'reader';
  $('#btn-ai').hidden = name !== 'reader';
  const t = $('#topbar-title');
  if (name === 'reader' && state.book) {
    t.replaceChildren(
      document.createTextNode(state.book.meta.title || '未命名'),
      el('span', {
        class: 'topbar__sub',
        text: state.book.meta.author ? state.book.meta.author : '佚名',
      })
    );
  } else {
    t.textContent = '陪读';
  }
  emit('view', name);
}

/* ---------------------------- 导入 ---------------------------- */

let importing = false;

export async function importFiles(files) {
  if (importing) return;
  importing = true;
  const list = [...files].filter((f) => /\.(epub|txt)$/i.test(f.name) || f.type === 'application/epub+zip');
  if (!list.length) {
    toast('只认 .epub 和 .txt', { error: true });
    importing = false;
    return;
  }

  for (const file of list) {
    const toastEl = showLoadingToast(`正在解析《${file.name}》…`);
    try {
      const buf = await file.arrayBuffer();
      const id = bookIdOf(file.name, buf.byteLength, file.lastModified || Date.now());
      // 已经有这本书就直接打开，不重复解析
      const existing = await store.getBook(id);
      if (existing) {
        toastEl.replaceWith(el('div', { class: 'toast', text: '这本书已经在书架上了' }));
        await openBook(existing);
        break;
      }

      const isEpub = /\.epub$/i.test(file.name);
      const doc = isEpub
        ? await parseEPUB(buf, file.name, file.lastModified || Date.now())
        : parseTXT(buf, file.name, file.lastModified || Date.now());

      if (!doc.chapters.length) throw new Error('这本书里没找到任何正文');

      await store.putBook(doc);
      toastEl.replaceWith(el('div', { class: 'toast', text: `《${doc.meta.title}》导入好了` }));
      await refreshLibrary();
      await openBook(doc);
      break; // 一次只开一本，多选时先导入第一本
    } catch (err) {
      console.error('[import]', err);
      toastEl.className = 'toast toast--err';
      toastEl.textContent = err?.message || '导入失败';
      setTimeout(() => toastEl.remove(), 4000);
    }
  }
  importing = false;
}

function showLoadingToast(text) {
  const host = $('#toasts');
  const node = el('div', { class: 'toast', text });
  host.append(node);
  return node;
}

/* ---------------------------- 打开书 ---------------------------- */

export async function openBook(doc) {
  state.book = doc;
  state.chapterIndex = 0;
  state.pageIndex = 0;
  state.pageStarts = [0];
  state.ai = {};

  // 恢复进度：记的是「章 + 章内段落下标」，不是页码 ——
  // 因为用户可能换了字号/设备，页码会变，段落下标不会。
  try {
    const { loadProgress } = await import('./ui/progress.js');
    const p = await loadProgress(doc.meta.id);
    if (p?.chapterId) {
      const idx = doc.chapters.findIndex((c) => c.id === p.chapterId);
      if (idx >= 0) {
        state.chapterIndex = idx;
        state.restoreWhere = { targetPi: Math.max(0, Number(p.pi) || 0) };
      }
    }
  } catch (err) {
    console.warn('[openBook] 进度恢复失败', err);
  }

  // 载入该书的 AI 产物（批注 / 摘要）。
  // ⚠ 路径是 ai/generate.js —— 不是 core/ai.js：AI 相关的一切（调用、提示词、产出）
  //   都归 ai/ 目录，core/ 只放「不懂 AI 也不联网」的纯逻辑。
  try {
    const { loadBookAI } = await import('./ai/generate.js');
    state.ai = await loadBookAI(doc.meta.id);
  } catch (err) {
    console.debug('[openBook] AI 产物未载入', err);
  }

  await mountReader(doc);
  showView('reader');
  emit('book', doc);
}

async function closeBook() {
  try {
    const { flushProgress } = await import('./ui/reader.js');
    await flushProgress();
  } catch {
    /* 忽略 */
  }
  state.book = null;
  state.ai = {};
  showView('library');
  await refreshLibrary();
}

/* ---------------------------- 书架 ---------------------------- */

export async function refreshLibrary() {
  let books = [];
  try {
    books = await store.listBooks();
  } catch (err) {
    console.error('[library]', err);
    toast('读不出书架：' + (err?.message || err), { error: true });
  }
  mountLibrary($('#library'), books, {
    onOpen: async (meta) => {
      const doc = await store.getBook(meta.id);
      if (!doc) return toast('这本书的数据丢了，需要重新导入', { error: true });
      await openBook(doc);
    },
    onDelete: async (meta) => {
      const ok = await confirmDialog(`删除《${meta.title}》？阅读进度和批注会一起删掉。`, {
        ok: '删除',
        danger: true,
      });
      if (!ok) return;
      await store.deleteBook(meta.id);
      await refreshLibrary();
      toast('删掉了');
    },
  });
}

/* ---------------------------- 事件绑定 ---------------------------- */

function bindShell() {
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    if (e.target.files?.length) importFiles(e.target.files);
    e.target.value = ''; // 允许重复选同一个文件
  });
  $('#btn-back').addEventListener('click', closeBook);

  // 拖放导入（桌面 + iPad 支持拖拽）
  let dragDepth = 0;
  const dz = $('#dropzone');
  const looksLikeFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!looksLikeFiles(e)) return;
    e.preventDefault();
    if (++dragDepth === 1) dz.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!looksLikeFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!looksLikeFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dz.hidden = true;
    }
  });
  window.addEventListener('drop', (e) => {
    if (!looksLikeFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dz.hidden = true;
    if (e.dataTransfer.files?.length) importFiles(e.dataTransfer.files);
  });

  // iPad 分屏 / 旋转 → 重判档位并重排
  const onResize = debounce(() => {
    const before = state.device;
    detectDevice();
    applyMeasure();
    if (before !== state.device || state.view === 'reader') emit('relayout');
  }, 180);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 260));

  // 系统主题变化（chrome: auto 时要跟着切）
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettingsToDom);

  // 顶栏阴影：滚动时才有分隔线
  const onScroll = () => {
    $('#topbar').classList.toggle('is-scrolled', window.scrollY > 2);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // 全局设置变更 → 立刻反映到 DOM
  subscribe((topic, detail) => {
    if (topic === 'settings') {
      applySettingsToDom();
      applyMeasure();
    }
  });

  /* ---------------------------- 阅读器功能按钮 ---------------------------- */

  // 排版设置
  $('#btn-read-settings').addEventListener('click', () => {
    import('./ui/settings.js')
      .then((m) => m.openReadSettings())
      .catch((err) => toast('设置面板打不开：' + (err?.message || err), { error: true }));
  });

  // AI 设置
  $('#btn-ai').addEventListener('click', () => {
    import('./ui/ai-config.js')
      .then((m) => m.openAISettings())
      .catch((err) => toast('AI 设置打不开：' + (err?.message || err), { error: true }));
  });

  // 批注面板。这里用动态 import 是因为批注 UI 依赖运行时才知道的东西：
  // 书架页永远用不到它，静态 import 会让首屏多加载 20KB。
  $('#btn-notes').addEventListener('click', () => {
    import('./ui/notes-panel.js')
      .then((m) => (m.initNotes(), m.openNotesPanel()))
      .catch((err) => toast('批注面板打不开：' + (err?.message || err), { error: true }));
  });

  // 目录（手机上）
  $('#btn-toc-mobile')?.addEventListener('click', () => {
    import('./ui/reader.js').then((m) => m.setRail(true));
  });

  /* 弹幕开关。
     这里刻意**不做成开关**（按下去停在"开"上），而是一次点击 = 放一波。
     理由：书是静音的，但用户想要的不是"永远有字飘过"，而是"太安静了，来点动静"。
     看完这一波安静下来，比一直飘着更接近有人在旁边的感觉。 */
  $('#btn-danmaku')?.addEventListener('click', () => {
    import('./ui/danmaku.js')
      .then((m) => {
        m.initDanmaku();
        m.burst();
        syncDanmakuPressed(true);
      })
      .catch((err) => toast('弹幕放不出来：' + (err?.message || err), { error: true }));
  });

  // 书搭子
  $('#btn-companion')?.addEventListener('click', () => {
    import('./ui/chat.js')
      .then((m) => m.openCompanion())
      .catch((err) => toast('书搭子打不开：' + (err?.message || err), { error: true }));
  });

  /* 批注的状态机：
     渲染完一章 → 排预取 + 把已有批注画到页上
     生成完一章 → 重新画一次（如果正是当前章）
     没配 key   → 给 AI 按钮挂一个提示点，不弹窗 */
  subscribe((topic, detail) => {
    if (topic === 'chapter-rendered') {
      import('./ui/ai-bridge.js')
        .then((m) => m.prefetchFrom(state.chapterIndex))
        .catch(() => {});
      paintNotes();
      // 弹幕按「翻到新的一页」重播一批。initDanmaku 是幂等的，
      // 没开过弹幕的用户这里只会初始化一个空层，不会有任何请求。
      import('./ui/danmaku.js')
        .then((m) => {
          m.mountDanmaku(state.book);
          m.syncDanmakuPage();
        })
        .catch(() => {});
      return;
    }
    if (topic === 'ai-ready') {
      paintNotes();
      // 用户正看着的那一章生成好了 → 给一句很轻的反馈，别打断
      if (detail?.chapterId === state.book?.chapters[state.chapterIndex]?.id) {
        const n = detail.notes?.length || 0;
        if (n) toast(`这一章陪你写了 ${n} 条`, { ms: 2200 });
      }
      return;
    }
    if (topic === 'ai-need-config' || topic === 'ai-error') {
      $('#btn-ai').classList.add('has-dot');
    }
  });

  /* 进度回写书架的百分比。
     阅读器只负责算，落盘到书架上由这里统一做，
     否则书架列表要自己遍历一遍所有书去查 progress。 */
  let lastPct = -1;
  document.addEventListener('peidu:progress', (e) => {
    const pct = Math.round(e.detail?.percent || 0);
    if (pct === lastPct) return;
    lastPct = pct;
    const doc = state.book;
    if (!doc || pct <= 0) return;
    doc.meta.percent = pct;
    doc.meta.lastReadAt = Date.now();
    import('./core/store.js').then(({ store }) =>
      store.putBook(doc).catch((err) => console.warn('[progress] 书架回写失败', err))
    );
  });
}

/**
 * 弹幕按钮的「按下」外观。
 * 按钮不是开关，但用户还是要能从按钮上看出"现在有没有弹幕"，
 * 所以按下的瞬间点亮，安静下来（没人再飘）就自己灭掉。
 */
let _dmPressedTimer = 0;
function syncDanmakuPressed(on) {
  const btn = $('#btn-danmaku');
  if (!btn) return;
  clearTimeout(_dmPressedTimer);
  if (!on) {
    btn.setAttribute('aria-pressed', 'false');
    return;
  }
  btn.setAttribute('aria-pressed', 'true');
  // 一波弹幕大约 20 秒放完（与 ui/danmaku.js 的 BURST_MS 一致），
  // 这里多给 3 秒，免得按钮先灭、字还在飘。
  _dmPressedTimer = setTimeout(() => btn.setAttribute('aria-pressed', 'false'), 23000);
}

/**
 * 把当前章的批注画到页上。批注层是可选的 UI，
 * 它坏了不该影响「读书」这件正事，所以整个调用包在 try 里。
 */
function paintNotes() {
  if (state.view !== 'reader' || !state.book) return;
  const ch = state.book.chapters[state.chapterIndex];
  if (!ch) return;
  import('./ui/notes-panel.js')
    .then(async (m) => {
      const { getRenderer } = await import('./ui/reader.js');
      m.initNotes();
      m.applyNotesToPage(getRenderer(), state.ai?.[ch.id] || null);
    })
    .catch((err) => console.debug('[notes] 跳过', err));
}

/* ---------------------------- 启动 ---------------------------- */

async function boot() {
  detectDevice();
  await loadSettings();
  applySettingsToDom();
  applyMeasure();
  bindShell();
  await refreshLibrary();
  showView('library');

  // Service Worker：只在 HTTPS/localhost 下注册（局域网 http 真机调试会静默失败，属正常）
  // Service Worker 需要「安全上下文」。https 算，**localhost / 127.0.0.1 也算**
  // （规范把 loopback 视为可信来源）—— 一开始我只判了 https，结果本机开发时
  // 离线能力永远不生效，而部署后才会生效，等于这条代码路径平时根本没被跑过。
  // 局域网 IP（真机调试用的 http://192.168.x.x）不算安全上下文，
  // 那里注册会静默失败，属预期。
  const swOk =
    location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '[::1]';
  if ('serviceWorker' in navigator && swOk) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[sw] 注册失败（离线能力不可用）', err);
    });
  }
}

boot().catch((err) => {
  console.error('[boot]', err);
  toast('启动出错了：' + (err?.message || err), { error: true, ms: 6000 });
});
