/* ============================================================
   陪读 · 书搭子面板
   ------------------------------------------------------------
   这个面板和别的面板不一样的地方在**入口**。

   批注是「AI 先写，我读」；书搭子是「我说话，AI 接」。
   但用户真正会卡住的地方不是「怎么问」，而是「问什么」——
   盯着一页书想不出问题，然后就把面板关了。
   所以面板一打开就必须有话说：顶部给三个「他刚读完这页在想什么」的
   话头（spark），下面才是输入框。快速提问只是备用。

   语音：识别用 Web Speech API（iOS 15+ / 桌面 Chrome 都有），
   朗读用 speechSynthesis（完全本地，不花钱、不联网）。
   两者都做了能力探测 —— 没有就不显示按钮，而不是显示一个点了没反应的按钮。
   ============================================================ */

import { el, clear, toast, nextFrame } from './dom.js';
import { state, subscribe } from '../state.js';
import * as C from '../ai/companion.js';

/* ---------------------------- 模块状态 ---------------------------- */

let PANEL = null; // { sheet, listEl, inputEl, ... }
let THREAD = null; // 当前线程
let RECAPS = {}; // chapterId -> 梗概
let RECAP_LOADED_FOR = null; // 已为哪本书加载过梗概
let ABORT = null; // 正在进行的请求

const LS_LAST = 'companion.lastThread'; // 记住上次聊的是哪条，重开面板接着聊

/* ---------------------------- TTS ---------------------------- */

const canSpeak = () => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

/** 设置里没有 tts 字段时默认关：会突然出声的东西必须默认关。 */
function ttsOn() {
  return state.settings?.companionSpeak === true;
}

function pickChineseVoice() {
  if (!canSpeak()) return null;
  const vs = speechSynthesis.getVoices() || [];
  return (
    vs.find((v) => /^zh[-_]CN/i.test(v.lang) && /Ting|婷婷|Mei|美/i.test(v.name)) ||
    vs.find((v) => /^zh/i.test(v.lang)) ||
    null
  );
}

/** 朗读一段。会打断上一段朗读 —— 连点两条消息时不该排队念旧内容。 */
function speak(text) {
  if (!canSpeak() || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
    u.lang = 'zh-CN';
    u.rate = 1.02;
    u.pitch = 1;
    const v = pickChineseVoice();
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (err) {
    console.warn('[companion] 朗读失败', err);
  }
}

function stopSpeak() {
  try {
    if (canSpeak()) speechSynthesis.cancel();
  } catch {
    /* 没有 speechSynthesis 的平台，本来也没在念 */
  }
}

/* ---------------------------- 语音输入 ---------------------------- */

function getSR() {
  const W = globalThis;
  return W.SpeechRecognition || W.webkitSpeechRecognition || null;
}

/** 开始一次听写。返回停止函数；不支持的平台返回 null。 */
function startDictation(onText, onEnd) {
  const SR = getSR();
  if (!SR) return null;
  let rec;
  try {
    rec = new SR();
  } catch {
    return null;
  }
  rec.lang = 'zh-CN';
  rec.continuous = false;
  rec.interimResults = true;
  let finalText = '';
  let stopped = false;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onText(finalText + interim);
  };
  rec.onerror = (e) => {
    // 'not-allowed'（用户拒了麦克风）和 'no-speech'（没说话）都不是错误，
    // 只是这次没听成。报错会吓到人，静默结束就好。
    if (e?.error && !['not-allowed', 'no-speech', 'aborted'].includes(e.error)) {
      console.warn('[companion] 语音识别出错', e.error);
    }
  };
  rec.onend = () => {
    if (!stopped) {
      stopped = true;
      onEnd?.(finalText);
    }
  };
  try {
    rec.start();
  } catch (err) {
    console.warn('[companion] 语音识别起不来', err);
    return null;
  }
  return () => {
    stopped = true;
    try {
      rec.stop();
    } catch {
      /* 已经停了 */
    }
  };
}

/* ---------------------------- 上下文 ---------------------------- */

/** 当前页在整章里的段落下标区间 */
function pageRange() {
  const starts = state.pageStarts || [0];
  const i = Math.max(0, Math.min(state.pageIndex || 0, starts.length - 1));
  const from = starts[i] ?? 0;
  const to = starts[i + 1] ?? Infinity;
  return { from, to };
}

/** 当前章的段落（确保已解析），失败返回 [] */
async function currentParas() {
  const doc = state.book;
  const ch = doc?.chapters?.[state.chapterIndex];
  if (!doc || !ch) return [];
  if (ch.paras?.length) return ch.paras;
  const { ensureParas } = await import('../core/media.js');
  return ensureParas(doc, ch) || [];
}

/**
 * 确保「更早的章」有梗概可用。
 * ★ 不 await：用户按下发送键时不该等模型把前面几章读完。
 *   这一次先拿有多少用多少，后台补完下一次就齐了。
 */
function kickRecaps() {
  const doc = state.book;
  if (!doc || RECAP_LOADED_FOR === doc.meta.id) return;
  RECAP_LOADED_FOR = doc.meta.id;
  C.loadRecaps(doc.meta.id, doc.chapters)
    .then((r) => {
      RECAPS = r || {};
    })
    .catch(() => {});
  C.prefetchRecaps({ doc, uptoChapter: state.chapterIndex, limit: 6, onOne: (id, text) => (RECAPS[id] = text) }).catch(
    () => {}
  );
}

/* ---------------------------- 线程 ---------------------------- */

async function currentThread({ create = true } = {}) {
  const doc = state.book;
  if (!doc) return null;
  const ch = doc.chapters[state.chapterIndex];
  if (!ch) return null;

  if (THREAD && THREAD.bookId === doc.meta.id) {
    // 换章了：**不新建线程**，只是把这条线程的「第几章」推到现在。
    // 书搭子应该记得你们从第三章聊到第五章，而不是每章失忆一次。
    if (THREAD.chapterId !== ch.id) THREAD.chapterId = ch.id;
    return THREAD;
  }

  const lastId = await import('../core/store.js').then(({ store }) => store.get(LS_LAST, null));
  const threads = await C.listThreads(doc.meta.id);
  const pick = threads.find((t) => t.id === lastId) || threads[0];
  if (pick) {
    THREAD = pick;
    return THREAD;
  }
  if (!create) return null;
  THREAD = await C.createThread({
    bookId: doc.meta.id,
    chapterId: ch.id,
    title: '',
    spoilerPi: pageRange().to === Infinity ? 1e9 : pageRange().to - 1,
  });
  return THREAD;
}

async function rememberThread(t) {
  if (!t) return;
  try {
    const { store } = await import('../core/store.js');
    await store.set(LS_LAST, t.id);
  } catch {
    /* 记不住就记不住，下次新开一条线程而已 */
  }
}

/** 用第一句话给线程起名（像聊天软件那样），只做一次 */
function maybeTitle(thread, text) {
  if (!thread || thread.title) return;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  thread.title = t.length > 14 ? t.slice(0, 14) + '…' : t;
}

/* ---------------------------- 渲染 ---------------------------- */

function bubble(m) {
  const mine = m.role === 'user';
  return el(
    'div',
    { class: mine ? 'cm cm--me' : 'cm cm--ai' },
    el('div', { class: 'cm__text', text: m.text }),
    !mine && canSpeak()
      ? el('button', {
          class: 'cm__say',
          type: 'button',
          'aria-label': '朗读这一条',
          text: '朗读',
          onclick: () => speak(m.text),
        })
      : null
  );
}

function emptyHint() {
  return el(
    'div',
    { class: 'cm-empty' },
    el('p', { text: '你们读到哪里，它就知道到哪里。' }),
    el('p', { class: 'cm-empty__sub', text: '问它这一页、这一章，或者前面的人是谁都行。它不会剧透 —— 因为它也还没读到。' })
  );
}

function renderList() {
  const { listEl } = PANEL || {};
  if (!listEl) return;
  const msgs = THREAD?.messages || [];
  clear(listEl);
  if (!msgs.length) {
    listEl.append(emptyHint());
    return;
  }
  for (const m of msgs) listEl.append(bubble(m));
  scrollToEnd();
}

function scrollToEnd() {
  const { listEl } = PANEL || {};
  if (!listEl) return;
  nextFrame().then(() => {
    listEl.scrollTop = listEl.scrollHeight;
  });
}

/** 一条「AI 正在说话」的占位，流式文本往里写 */
function streamingBubble() {
  const { listEl } = PANEL || {};
  const node = el('div', { class: 'cm cm--ai cm--live' }, el('div', { class: 'cm__text', text: '…' }));
  listEl?.append(node);
  scrollToEnd();
  return (text) => {
    const t = node.querySelector('.cm__text');
    if (t) t.textContent = text || '…';
    scrollToEnd();
  };
}

/* ---------------------------- 发送 ---------------------------- */

/** 把 AI 回的话同步到弹幕缓冲，用户关掉面板后还能在页面上看到它飘过去 */
async function mirrorToDanmaku(text) {
  try {
    const m = await import('./danmaku.js');
    m.injectCompanionLine?.(text);
  } catch {
    /* 弹幕层不在（没开过弹幕），静默跳过 */
  }
}

async function send(text) {
  const doc = state.book;
  if (!doc) return;
  const t = String(text || '').trim();
  if (!t) return;
  if (ABORT) return; // 上一条还在路上

  const thread = await currentThread();
  if (!thread) return;

  const paras = await currentParas();
  const { from, to } = pageRange();
  C.pushSpoiler(thread, to === Infinity ? paras.length : to);
  maybeTitle(thread, t);
  thread.messages.push({ role: 'user', text: t, at: Date.now() });
  renderList();

  const write = streamingBubble();
  const ctrl = new AbortController();
  ABORT = ctrl;
  let acc = '';
  try {
    const out = await C.askCompanion({
      doc,
      chapterIndex: state.chapterIndex,
      paras,
      pageFrom: from,
      pageTo: to === Infinity ? paras.length : to,
      thread,
      recaps: RECAPS,
      signal: ctrl.signal,
      onDelta: (d) => {
        acc += d;
        write(acc);
      },
    });
    const final = String(out || acc || '').trim();
    if (!final) throw new Error('它这次没说话（返回了空内容），再问一次试试。');
    thread.messages.push({ role: 'ai', text: final, at: Date.now() });
    await C.maybeCondense(thread);
    await C.saveThread(thread);
    if (ttsOn()) speak(final);
    mirrorToDanmaku(final);
  } catch (err) {
    if (err?.name === 'AbortError') {
      // 用户自己停的，别报错；把已经流出来的半截留在对话里，
      // 否则「我明明看到它说了半句」会让人以为程序丢了数据。
      if (acc.trim()) thread.messages.push({ role: 'ai', text: acc.trim() + '……', at: Date.now() });
      renderList();
      return;
    }
    thread.messages.push({ role: 'ai', text: '（没接上话）' + (err?.message || err), at: Date.now() });
    await C.saveThread(thread).catch(() => {});
    toast(err?.message || String(err), { error: true, ms: 5200 });
  } finally {
    ABORT = null;
    renderList();
  }
}

/** 让 AI 主动起话头。这是面板里最容易被忽略、但最有用的一个按钮。 */
async function spark() {
  const doc = state.book;
  if (!doc || ABORT) return;
  const thread = await currentThread();
  if (!thread) return;
  const paras = await currentParas();
  const { from, to } = pageRange();
  C.pushSpoiler(thread, to === Infinity ? paras.length : to);

  const write = streamingBubble();
  const ctrl = new AbortController();
  ABORT = ctrl;
  let acc = '';
  try {
    const out = await C.sparkFor({
      doc,
      chapterIndex: state.chapterIndex,
      paras,
      pageFrom: from,
      pageTo: to === Infinity ? paras.length : to,
      thread,
      recaps: RECAPS,
      signal: ctrl.signal,
    });
    acc = String(out || '').trim();
    write(acc);
    if (!acc) throw new Error('它这次没说话，再点一次试试。');
    thread.messages.push({ role: 'ai', text: acc, at: Date.now() });
    if (!thread.sparks) thread.sparks = 0;
    thread.sparks++;
    await C.saveThread(thread);
    if (ttsOn()) speak(acc);
    mirrorToDanmaku(acc);
  } catch (err) {
    if (err?.name !== 'AbortError') toast(err?.message || String(err), { error: true });
  } finally {
    ABORT = null;
    renderList();
  }
}

/* ---------------------------- 面板 ---------------------------- */

function buildPanel(sheet) {
  const { body } = sheet;

  const head = el(
    'div',
    { class: 'chat__head' },
    el('div', { class: 'chat__who' },
      el('strong', { text: '书搭子' }),
      el('span', { class: 'chat__where', text: where() })
    ),
    el('div', { class: 'chat__acts' },
      canSpeak()
        ? el('button', {
            class: 'iconbtn',
            type: 'button',
            'aria-pressed': ttsOn() ? 'true' : 'false',
            title: '朗读它的回复',
            text: '念',
            onclick: (e) => {
              const on = !ttsOn();
              import('../state.js').then(({ patchSettings }) => patchSettings({ companionSpeak: on }));
              e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
              if (!on) stopSpeak();
            },
          })
        : null,
      el('button', {
        class: 'iconbtn',
        type: 'button',
        title: '让它先开口',
        text: '起话头',
        onclick: () => spark(),
      })
    )
  );

  const listEl = el('div', { class: 'chat__list', role: 'log', 'aria-live': 'polite' });

  const quick = el('div', { class: 'chat__quick' });
  for (const q of C.QUICK_ASKS) {
    quick.append(
      el('button', {
        class: 'chip',
        type: 'button',
        text: q.label,
        onclick: () => send(q.text),
      })
    );
  }

  const inputEl = el('textarea', {
    class: 'chat__input',
    rows: '1',
    placeholder: '跟它说点什么…',
    'aria-label': '对书搭子说',
  });
  // 回车发送、Shift+回车换行。iOS 上回车是换行键，这个行为只在有实体键盘时才有用，
  // 所以不依赖它 —— 发送按钮必须一直在。
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = inputEl.value;
      inputEl.value = '';
      autosize();
      send(v);
    }
  });
  const autosize = () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
  };
  inputEl.addEventListener('input', autosize);

  let stopDict = null;
  const micBtn = getSR()
    ? el('button', {
        class: 'iconbtn iconbtn--mic',
        type: 'button',
        title: '按住说话',
        'aria-pressed': 'false',
        text: '说',
        onclick: (e) => {
          const btn = e.currentTarget;
          if (stopDict) {
            stopDict();
            stopDict = null;
            btn.setAttribute('aria-pressed', 'false');
            return;
          }
          btn.setAttribute('aria-pressed', 'true');
          stopDict = startDictation(
            (text) => {
              inputEl.value = text;
              autosize();
            },
            () => {
              stopDict = null;
              btn.setAttribute('aria-pressed', 'false');
            }
          );
          if (!stopDict) btn.setAttribute('aria-pressed', 'false');
        },
      })
    : null;

  const sendBtn = el('button', {
    class: 'btn btn--primary chat__send',
    type: 'button',
    text: '说',
    onclick: () => {
      const v = inputEl.value;
      inputEl.value = '';
      autosize();
      send(v);
    },
  });

  const composer = el('div', { class: 'chat__composer' }, inputEl, micBtn, sendBtn);

  body.append(head, listEl, quick, composer);
  return { listEl, inputEl };
}

function where() {
  const doc = state.book;
  if (!doc) return '';
  const ch = doc.chapters[state.chapterIndex];
  const n = (state.pageIndex || 0) + 1;
  const total = (state.pageStarts || [1]).length;
  return `第${C.cnNum(state.chapterIndex + 1)}章${ch?.title ? ` · ${ch.title}` : ''} · ${n}/${total} 页`;
}

/** 换页/换章时更新位置提示（面板开着的时候才需要） */
export function refreshCompanion() {
  const w = PANEL?.sheet?.root?.querySelector('.chat__where');
  if (w) w.textContent = where();
}

/* ---------------------------- 入口 ---------------------------- */

export async function openCompanion() {
  if (PANEL) return; // 已经开着
  if (!state.book) {
    toast('先打开一本书', { ms: 1800 });
    return;
  }

  const { sheet } = await import('./dom.js');
  const s = sheet({ title: '书搭子', side: 'bottom', className: 'sheet--chat' });
  const parts = buildPanel(s);
  PANEL = { sheet: s, ...parts };

  // 关面板时把正在进行的请求停掉：用户关了它就说明不想等了，
  // 让请求继续跑会白白花钱。dev 里 sheet 的 close 是可调用的，
  // 这里包一层而不是改 dom.js —— 别的面板没有这个需求。
  const origClose = s.close;
  s.close = (...a) => {
    ABORT?.abort();
    stopSpeak();
    PANEL = null;
    return origClose(...a);
  };

  kickRecaps();
  await currentThread();
  renderList();
  await nextFrame();
  // 手机上调起键盘会顶乱布局，所以**不自动聚焦** —— 用户想打字自己点输入框。
  // 桌面宽屏上自动聚焦省一次点击，值得。
  if (window.matchMedia('(min-width: 768px)').matches) PANEL.inputEl?.focus();
}

export function closeCompanion() {
  PANEL?.sheet?.close?.();
}

export function isCompanionOpen() {
  return !!PANEL;
}

/** 换书时清掉上一条线程的记忆，否则会接着上一本书聊 */
export function resetCompanion() {
  THREAD = null;
  RECAPS = {};
  RECAP_LOADED_FOR = null;
}

/* ---------------------------- 跟随翻页 ---------------------------- */

subscribe((topic) => {
  if (topic === 'chapter-rendered') {
    // 用户往前翻（回到已读过的更远处）不改剧透线；往后翻才推。
    const { to } = pageRange();
    if (THREAD && to !== Infinity) C.pushSpoiler(THREAD, to);
    if (PANEL) refreshCompanion();
  }
});
