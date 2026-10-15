/* ============================================================
   陪读 · 真机自检（真的开一个浏览器把书读一遍）
   ------------------------------------------------------------
   为什么需要这个：
   到这一步为止，所有测试都是"在 Node 里喂数据、看返回值"。它们能证明
   解析器对、分页数学对、锚点算法对，但证明不了最要紧的一件事 ——
   把一本真书拖进去，屏幕上到底有没有出现字。

   中间已经栽过三次跟头，全都是单层测试看不见的：
     · renderer.js 里 `let pageChars` 与 `const pageChars` 重名 → 阅读页全白
     · reader.js 被子 agent 的自测桩覆盖成 12 行 → 翻页完全不工作
     · 模块 import 了不存在的函数 → 整页起不来
   所以这里不看返回值，看**渲染出来的 DOM**。

   用法：node tools/smoke.mjs [--headful] [--keep]
   前提：dev server 在 5178 跑着（node tools/dev-server.mjs）
   ★ Edge 需要一个非沙箱的环境才能起（它的 IPC 走命名管道）。
     普通沙箱会话里会以 `platform_channel.cc:187 Check failed: 拒绝访问` 死掉。
   ============================================================ */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5178);
const APP = `http://127.0.0.1:${PORT}/`;
const DBG_PORT = 9333;
const HEADFUL = process.argv.includes('--headful');
const KEEP = process.argv.includes('--keep');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/* ---------------------------- 迷你 CDP 客户端 ---------------------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  /** 在页面里跑一段表达式并取回值。
   *  表达式体包在 async 箭头函数里 —— 页面代码里经常需要 await（等重排、等落库），
   *  而 Runtime.evaluate 的默认上下文不是模块，顶层 await 会直接报
   *  「await is only valid in async functions」。 */
  async eval(sessionId, expr) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面里报错：${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }
}

/* ---------------------------- 启动 ---------------------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error(`等不到调试端口：${url}`);
}

async function launch() {
  const exe = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 Edge / Chrome');

  const profile = mkdtempSync(path.join(tmpdir(), 'peidu-smoke-'));
  const args = [
    HEADFUL ? '--headless=false' : '--headless=new',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=420,860',
    'about:blank',
  ];

  // stderr 一定要收着：Edge 起不来时唯一的原因就在里面
  // （第一版用 stdio:'ignore'，结果只看到"等不到调试端口"，完全不知道它为什么死）
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n浏览器进程退出了（code=${code}）：\n${stderr.split('\n').slice(-8).join('\n')}`);
    }
  });

  let version;
  try {
    version = await fetchJSON(`http://127.0.0.1:${DBG_PORT}/json/version`, 60);
  } catch (err) {
    throw new Error(`${err.message}\n浏览器 stderr：\n${stderr.split('\n').slice(-10).join('\n')}`);
  }
  const targets = await fetchJSON(`http://127.0.0.1:${DBG_PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('浏览器里没有 page 目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连不上调试端口')), { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  // 页面自己抛出来的错、以及加载失败的资源都要收集起来 ——
  // 用户看到的是白屏，日志里才是原因
  const pageErrors = [];
  const failedUrls = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || '未知异常');
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      pageErrors.push(msg.params.entry.text);
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      failedUrls.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
  });

  return { child, cdp, profile, version, pageErrors, failedUrls };
}

/** 等页面启动完成（app.js 会设 window.__peiduBooted） */
async function waitBooted(cdp, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await cdp.eval(null, 'return !!window.__peiduBooted;');
    if (ok) return Date.now() - t0;
    await sleep(150);
  }
  return -1;
}

/* ---------------------------- 断言 ---------------------------- */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ''}`);
}
function info(msg) {
  console.log(`    · ${msg}`);
}

/* ---------------------------- 主流程 ---------------------------- */

const shotDir = path.join(ROOT, '.shots');
mkdirSync(shotDir, { recursive: true });

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(shotDir, `${name}.png`);
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

/** 关掉所有还开着的浮层。截图前必须调用：不然截到的是"上一个面板 + 新面板"叠在一起。
 *
 * ★ 不能靠找"关闭按钮"来关：`sheet()` 本身**不生成**关闭按钮，面板头部是各个
 *   调用方自己拼的，里面塞满了分段控件、图标按钮之类的东西。早先那版
 *   `querySelector('.sheet .iconbtn')` 于是点到了面板里的**随机一个控件**
 *   （比如字体选择器），面板根本没关，截图里一路叠着上一个面板。
 *   可靠的关法是点它自己的 backdrop —— 那是 `sheet()` 注册的关闭路径。 */
async function closeAllSheets(cdp) {
  return cdp.eval(
    null,
    `const host = document.getElementById('overlay-root');
     const backdrops = [...host.querySelectorAll('.sheet-backdrop')];
     for (const b of backdrops) b.click();
     await new Promise(r => setTimeout(r, 420));
     const left = host.querySelectorAll('.sheet').length;
     if (left) {
       // 兜底：backdrop 点不掉（比如 dismissible:false），走 Escape
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       await new Promise(r => setTimeout(r, 420));
     }
     return host.querySelectorAll('.sheet').length;`
  );
}

/** 等所有 toast 自己消失（截图里飘着三条提示会挡住正文，看不清排版） */
async function waitToasts(cdp, ms = 3400) {
  await sleep(ms);
  await cdp.eval(null, `document.getElementById('toasts').replaceChildren(); return true;`);
}

let browser;
try {
  console.log('\n== 启动浏览器 ==');
  browser = await launch();
  const { cdp, pageErrors, failedUrls } = browser;
  info(browser.version.Browser);

  console.log('\n== 打开应用 ==');
  await cdp.send('Page.navigate', { url: APP });
  const bootMs = await waitBooted(cdp);
  check('app.js 启动完成（window.__peiduBooted）', bootMs >= 0, bootMs >= 0 ? `${bootMs}ms` : '超时');
  check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await sleep(600); // 让书架渲染完
  const shell = await cdp.eval(
    null,
    `const de = document.documentElement;
     const view = document.getElementById('view-library');
     return {
       device: de.dataset.device, theme: de.dataset.theme, font: de.dataset.font,
       libVisible: !view.hidden,
       libText: (document.getElementById('library').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
     };`
  );
  check('书架是默认视图', shell.libVisible, shell.libText);
  check('空书架有引导文案', /空/.test(shell.libText), shell.libText);
  info(`data-device=${shell.device} theme=${shell.theme} font=${shell.font}`);

  console.log('\n== 导入 EPUB ==');
  const epub = readFileSync(path.join(ROOT, '.fixtures', '测试书.epub'));
  const b64 = epub.toString('base64');
  // 先塞进页面（分块，避免一次超长的 evaluate 表达式）
  await cdp.eval(
    null,
    `window.__fxChunks = []; return true;`
  );
  const CH = 64 * 1024;
  for (let i = 0; i < b64.length; i += CH) {
    await cdp.eval(null, `window.__fxChunks.push(${JSON.stringify(b64.slice(i, i + CH))}); return true;`);
  }
  const importRes = await cdp.eval(
    null,
    `const bin = atob(window.__fxChunks.join(''));
     const u8 = new Uint8Array(bin.length);
     for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
     const file = new File([u8], '测试书.epub', { type: 'application/epub+zip' });
     const dt = new DataTransfer();
     dt.items.add(file);
     const input = document.getElementById('file-input');
     input.files = dt.files;
     input.dispatchEvent(new Event('change', { bubbles: true }));
     return { size: u8.length, name: file.name };`
  );
  info(`造出 File ${importRes.name} ${importRes.size} 字节，已派发 change`);

  // 解析 + 落库 + 打开是要花点时间的，轮询等阅读视图出现
  let opened = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    opened = await cdp.eval(
      null,
      `const view = document.getElementById('view-reader');
       const body = document.getElementById('page-body');
       return {
         reading: !view.hidden,
         chars: (body.textContent || '').length,
         title: document.getElementById('topbar-title').textContent,
       };`
    );
    if (opened.reading && opened.chars > 0) break;
    await sleep(200);
  }
  check('EPUB 导入后进入阅读视图', opened?.reading, `${Date.now() - t0}ms`);
  check('正文真的渲染出了字', (opened?.chars || 0) > 0, `当前页 ${opened?.chars} 字`);

  const readState = await cdp.eval(
    null,
    `const body = document.getElementById('page-body');
     const kids = [...body.children];
     const head = kids.filter(n => n.querySelector('.anchor'));
     const anchors = body.querySelectorAll('.anchor').length;
     const cs = getComputedStyle(body);
     return {
       title: document.getElementById('topbar-title').textContent,
       blocks: kids.length,
       anchors,
       anchorBold: head.length ? getComputedStyle(head[0].querySelector('.anchor')).fontWeight : '',
       fontSize: cs.fontSize,
       lineHeight: cs.lineHeight,
       measure: cs.maxWidth,
       footChapter: document.getElementById('foot-chapter').textContent,
       footNum: document.getElementById('foot-num').textContent,
       // 关键：锚点元素绝不能是原子盒，否则中文整段会被排乱
       anchorDisplay: anchors ? getComputedStyle(body.querySelector('.anchor')).display : '',
       firstText: (body.textContent || '').slice(0, 30),
     };`
  );
  info(`书名「${readState.title}」 当前页 ${readState.blocks} 个块 / ${readState.anchors} 个锚点`);
  info(`字号 ${readState.fontSize} 行高 ${readState.lineHeight} 行宽 ${readState.measure}`);
  info(`页脚：${readState.footChapter} · ${readState.footNum}`);
  info(`正文开头：${readState.firstText}`);

  check('书名来自 EPUB 元数据', readState.title.includes('雨夜账本'), readState.title);
  check('锚点渲染出来了', readState.anchors > 0, `${readState.anchors} 个`);
  check('锚点是加粗的', readState.anchorBold === '700' || readState.anchorBold === 'bold', readState.anchorBold);
  check('锚点不是原子盒（display 必须是 inline）', readState.anchorDisplay === 'inline', readState.anchorDisplay);
  check('页脚显示了章号和页码', readState.footChapter.length > 0 && readState.footNum.length > 0, `${readState.footChapter} ${readState.footNum}`);

  const shot1 = await shot(cdp, '01-reader-phone');
  info(`截图 → ${path.relative(ROOT, shot1)}`);
  await closeAllSheets(cdp); // 桌面上「书搭子」是常驻面板；截图前不关会盖住正文
  await waitToasts(cdp);

  // 分页到底有没有真的在分？这一组数字是排查分页问题的唯一线索：
  // 「可用高度」和「整章内容高度」必须彼此可比，否则要么一页塞整章（末页被裁），
  // 要么每页只放得下一段。
  const geom = await cdp.eval(
    null,
    `const scroll = document.getElementById('page-scroll');
     const body = document.getElementById('page-body');
     const cs = getComputedStyle(body);
     const kids = [...body.children];
     let content = 0;
     for (let i = 0; i < kids.length; i++) {
       const r = kids[i].getBoundingClientRect();
       content += r.height + parseFloat(getComputedStyle(kids[i]).marginBottom);
     }
     const app = window.__peidu || null;
     const S = app && app.state ? app.state : null;
     return {
       scrollH: scroll.clientHeight,
       bodyPad: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
       blocks: kids.length,
       contentH: Math.round(content),
       // 一页里理论上能放多少字：可用高度 / 行高 × 每行字数
       lineH: parseFloat(cs.lineHeight),
       pageStartsLen: S && Array.isArray(S.pageStarts) ? S.pageStarts.length : -1,
       chapterIndex: S ? S.chapterIndex : -1,
       pageIndex: S ? S.pageIndex : -1,
       chapterCount: S && S.book ? S.book.chapters.length : -1,
       chapterTitles: S && S.book ? S.book.chapters.map(c => c.title) : [],
       hasAppState: !!S,
     };`
  );
  info(`可用高度 ${geom.scrollH}px（正文内边距 ${geom.bodyPad}px）· 当前页 ${geom.blocks} 块 / ${geom.contentH}px 内容`);
  info(`行高 ${geom.lineH}px → 一页约 ${Math.floor((geom.scrollH - geom.bodyPad) / geom.lineH)} 行`);
  info(`state: 第 ${geom.chapterIndex + 1}/${geom.chapterCount} 章，页下标 ${geom.pageIndex}，pageStarts ${geom.pageStartsLen} 个`);
  info(`章节标题：${geom.chapterTitles.join(' | ')}`);
  if (!geom.hasAppState) info('⚠ 拿不到 window.__peidu.state —— 分页相关的判断只能看页脚');

  // 分页这条链路的现场复算：把整章铺进一个屏幕外的容器，量一遍、再跑一次 packPages。
  // 这样能直接看到「测出来的是什么、装箱成几页」，而不是从页脚倒推。
  const replay = await cdp.eval(
    null,
    `const model = await import('./js/core/model.js');
     const pag = await import('./js/core/paginate.js');
     const ren = await import('./js/ui/renderer.js');
     const S = window.__peidu.state;
     const ch = S.book.chapters[S.chapterIndex];
     const paras = ch.paras;
     const host = document.getElementById('page-body');
     const scroll = document.getElementById('page-scroll');

     const probe = document.createElement('div');
     probe.className = 'page-body';
     probe.style.position = 'absolute';
     probe.style.visibility = 'hidden';
     probe.style.left = '-99999px';
     probe.style.top = '0';
     probe.style.maxWidth = getComputedStyle(host).maxWidth;
     probe.style.padding = '0';
     document.getElementById('paper').append(probe);
     const frag = document.createDocumentFragment();
     for (const p of paras) frag.append(ren.makePara(p, S.settings.strength));
     probe.append(frag);
     await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

     const nodes = [...probe.children];
     const blocks = pag.measureBlocks(nodes, { host: probe });
     const cs = getComputedStyle(host);
     const avail = Math.max(1, scroll.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
     const packed = pag.packPages(blocks, avail);
     const out = {
       paras: paras.length,
       blockCount: blocks.length,
       blocks: blocks.map(b => Math.round(b)),
       blockSum: Math.round(blocks.reduce((a, b) => a + b, 0)),
       avail: Math.round(avail),
       pages: packed.pageStarts.length,
       pageStarts: packed.pageStarts,
       heights: packed.pageHeights.map(h => Math.round(h)),
       containerW: Math.round(probe.getBoundingClientRect().width),
       hostW: Math.round(host.getBoundingClientRect().width),
     };
     probe.remove();
     return out;`
  );
  info(`复算：${replay.paras} 段 → ${replay.blockCount} 块，块高合计 ${replay.blockSum}px（探针宽 ${replay.containerW} / 正文宽 ${replay.hostW}）`);
  info(`复算：可用 ${replay.avail}px → ${replay.pages} 页，pageStarts=[${replay.pageStarts.slice(0, 24).join(',')}]`);
  info(`复算：块高 [${replay.blocks.slice(0, 12).join(',')}${replay.blocks.length > 12 ? ',…' : ''}]`);
  check('分页数学本身能把这一章分成多页', replay.pages > 1, `${replay.pages} 页 / 可用 ${replay.avail}px / 内容 ${replay.blockSum}px`);

  // 数学层没问题，那就一定是"布局那一刻量到的可用高度"不对。把渲染器
  // 此刻的 available() 和缓存指纹都问出来。
  const live = await cdp.eval(
    null,
    `const grep = (id) => null;
     const scroll = document.getElementById('page-scroll');
     const body = document.getElementById('page-body');
     const cs = getComputedStyle(body);
     const S = window.__peidu.state;
     // 直接问渲染器（它挂在 reader.js 的模块作用域里，只能通过 DOM 反推 +
     // 自己按同样的公式算一遍）
     const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
     return {
       scrollClientH: scroll.clientHeight,
       scrollOffsetH: scroll.offsetHeight,
       scrollRectH: Math.round(scroll.getBoundingClientRect().height),
       bodyPadY: padY,
       computedAvail: Math.max(0, scroll.clientHeight - padY),
       paperH: Math.round(document.getElementById('paper').getBoundingClientRect().height),
       viewHidden: document.getElementById('view-reader').hidden,
       pageStarts: S.pageStarts,
       pageIndex: S.pageIndex,
     };`
  );
  info(`实时：page-scroll clientHeight=${live.scrollClientH} offsetHeight=${live.scrollOffsetH} rect=${live.scrollRectH}，内边距 ${live.bodyPadY} → 可用 ${live.computedAvail}`);
  info(`实时：state.pageStarts=[${live.pageStarts.join(',')}] pageIndex=${live.pageIndex} paper 高 ${live.paperH}`);

  // 渲染器自己记录的"这次布局量到了什么"
  const diag = await cdp.eval(
    null,
    `const R = window.__peidu.renderer;
     if (!R) return null;
     const d = R.lastDiag;
     const cached = R.layouts ? [...R.layouts.entries()].map(([k, v]) => ({
       id: k, fp: v.fp, pages: v.pageStarts.length,
     })) : [];
     return { diag: d || null, cached,
              nowFp: R.fingerprint ? R.fingerprint() : '',
              availNow: R.available ? R.available() : -1 };`
  );
  if (diag?.diag) {
    const d = diag.diag;
    info(`渲染器记录：可用 ${d.available}px（clientHeight ${d.scrollH} − 内边距 ${d.padY}）· ${d.nodes} 个节点 · 量得高度合计 ${d.measured}px → ${d.pages} 页`);
    info(`渲染器记录：块高 [${d.blocks.slice(0, 12).join(',')}${d.blocks.length > 12 ? ',…' : ''}]`);
    check('渲染器量到的内容高度与真实排版相符', d.measured > d.available * 2, `${d.measured}px vs 可用 ${d.available}px`);
    check('渲染器把这一章分成了多页', d.pages > 1, `${d.pages} 页`);
    info(`缓存里的指纹：${diag.cached.map((c) => `${c.id}→${c.pages}页`).join(' ')}`);
    info(`现在的指纹：${diag.nowFp}（可用 ${Math.round(diag.availNow)}px）`);
  } else {
    info('⚠ 拿不到渲染器的 lastDiag（window.__peidu.renderer 不存在）');
  }


  // 容器在测量那一刻到底可不可见？沿着 .page-scroll 的祖先链把 display
  // 和高度都打出来 —— 「量到 0 高度」只可能是这条链上某一段还没布局。
  const chain = await cdp.eval(
    null,
    `const out = [];
     let n = document.getElementById('page-scroll');
     while (n && n !== document.documentElement) {
       const cs = getComputedStyle(n);
       const r = n.getBoundingClientRect();
       out.push({
         tag: n.tagName.toLowerCase() + (n.id ? '#' + n.id : (n.className ? '.' + String(n.className).split(' ')[0] : '')),
         display: cs.display, visibility: cs.visibility,
         h: Math.round(r.height), ch: n.clientHeight,
         hidden: n.hasAttribute && n.hasAttribute('hidden'),
       });
       n = n.parentElement;
     }
     return out;`
  );
  for (const c of chain) info(`祖先链 ${c.tag} display=${c.display} rect=${c.h}px client=${c.ch}px${c.hidden ? ' [hidden]' : ''}`);

  // 直接量当前 DOM 里的段落，绕开 measureBlocks 那层封装 ——
  // 如果这里量出来是正常高度，那问题就在 measureBlocks 内部；
  // 如果这里也是 0，那就是这些节点真的没被布局。
  const raw = await cdp.eval(
    null,
    `const nodes = [...document.querySelectorAll('#page-body > *')];
     const rows = nodes.slice(0, 5).map((n, i) => {
       const r = n.getBoundingClientRect();
       return { i, tag: n.tagName, h: Math.round(r.height), w: Math.round(r.width),
                top: Math.round(r.top), offsetTop: n.offsetTop, offsetParent: n.offsetParent ? (n.offsetParent.id || n.offsetParent.className) : null,
                display: getComputedStyle(n).display, text: (n.textContent || '').slice(0, 12) };
     });
     const b = document.getElementById('page-body');
     return { count: nodes.length, rows,
              bodyRect: Math.round(b.getBoundingClientRect().height),
              bodyOffsetTop: b.offsetTop,
              bodyOffsetParent: b.offsetParent ? (b.offsetParent.id || b.offsetParent.className) : null,
              bodyPos: getComputedStyle(b).position };`
  );
  info(`当前 DOM 里 ${raw.count} 个段落，正文容器 rect=${raw.bodyRect}px offsetTop=${raw.bodyOffsetTop} offsetParent=${raw.bodyOffsetParent} position=${raw.bodyPos}`);
  for (const r of raw.rows) {
    info(`  段 ${r.i} <${r.tag}> rect=${r.h}px×${r.w} top=${r.top} offsetTop=${r.offsetTop} offsetParent=${r.offsetParent} display=${r.display} 「${r.text}」`);
  }

  // 用应用此刻的真实 DOM 直接调 measureBlocks（不是探针副本），
  // 把每个节点的 offsetParent 链也打出来 —— 如果链走不到 host，
  // measureBlocks 会按 display:none 处理，全部记 0，整章变成一页。
  const mraw = await cdp.eval(
    null,
    `const pag = await import('./js/core/paginate.js');
     const body = document.getElementById('page-body');
     const nodes = [...body.children];
     const blocks = pag.measureBlocks(nodes, { host: body });
     const chains = nodes.slice(0, 3).map((n) => {
       const chain = [];
       let cur = n;
       for (let g = 0; cur && g < 12; g++) { chain.push(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : (cur.className ? '.' + String(cur.className).split(' ')[0] : ''))); cur = cur.offsetParent; }
       return chain.join(' → ');
     });
     return { blocks: blocks.map(b => Math.round(b)), sum: Math.round(blocks.reduce((a,b)=>a+b,0)), chains,
              sameAsBody: nodes[0] && nodes[0].parentElement === body };`
  );
  info(`用当前 DOM 量：${mraw.blocks.length} 块，合计 ${mraw.sum}px，块高 [${mraw.blocks.slice(0, 8).join(',')}…]`);
  info(`第一个节点在 body 里：${mraw.sameAsBody}`);
  for (const c of mraw.chains) info(`  offsetParent 链：${c}`);

  console.log('\n== 翻页 ==');
  const before = readState.footNum;

  await cdp.eval(null, `document.getElementById('pager-next').click(); return true;`);
  await sleep(500);
  const after = await cdp.eval(
    null,
    `const S = window.__peidu.state;
     const R = window.__peidu.renderer;
     const ch = S.book.chapters[S.chapterIndex];
     const l = R.layouts.get(ch.id);
     return { num: document.getElementById('foot-num').textContent,
              chars: document.getElementById('page-body').textContent.length,
              scrollTop: document.getElementById('page-scroll').scrollTop,
              pageIndex: S.pageIndex,
              chapterIndex: S.chapterIndex,
              statePageStarts: S.pageStarts,
              childCount: document.getElementById('page-body').childElementCount,
              slicedPage: R.slicedPage,
              slicedFrom: R.slicedFrom,
              layoutPages: l ? l.pageStarts : null,
              pagerDisabled: document.getElementById('pager-next').disabled };`
  );
  info(`翻页后：章 ${after.chapterIndex} 页下标 ${after.pageIndex} / state.pageStarts=[${after.statePageStarts.join(',')}]`);
  info(`渲染器：slicedPage=${after.slicedPage} slicedFrom=${after.slicedFrom} 缓存分页表=[${(after.layoutPages || []).join(',')}]`);
  info(`DOM：子节点 ${after.childCount} 个，${after.chars} 字；按钮禁用=${after.pagerDisabled}`);
  check('点下一页之后页码变了', after.num !== before, `${before} → ${after.num}`);
  check('新的一页有正文', after.chars > 0, `${after.chars} 字`);
  check('翻页后滚动位置回到顶部', after.scrollTop === 0, String(after.scrollTop));

  // 连续翻到底，验证不会白页 / 不会卡死
  let whitePages = 0;
  const trace = [];
  for (let i = 0; i < 24; i++) {
    const clicked = await cdp.eval(
      null,
      `const b = document.getElementById('pager-next');
       if (!b || b.disabled) return false;
       b.click();
       return true;`
    );
    await sleep(150);
    const st = await cdp.eval(
      null,
      `const S = window.__peidu.state;
       const R = window.__peidu.renderer;
       const ch = S.book.chapters[S.chapterIndex];
       const l = R.layouts.get(ch.id);
       const body = document.getElementById('page-body');
       return { chars: body.textContent.length,
                num: document.getElementById('foot-num').textContent,
                ch: document.getElementById('foot-chapter').textContent,
                pageIndex: S.pageIndex, chapterIndex: S.chapterIndex,
                sliceFrom: R.slicedFrom, slicePage: R.slicedPage,
                kids: body.childElementCount, total: l ? l.pageStarts.length : -1,
                allNodesLen: R.allNodes ? R.allNodes.length : -1,
                text: (body.textContent || '').slice(0, 26),
                disabled: document.getElementById('pager-next').disabled };`
    );
    trace.push(`#${i}${clicked ? '' : '×'} 章${st.chapterIndex} 页${st.pageIndex}/${st.total} 节点${st.kids}(全章${st.allNodesLen}) slice=${st.sliceFrom}/${st.slicePage} ${st.chars}字「${st.text}」`);
    if (st.chars === 0) whitePages++;
    if (!clicked) break; // 已经翻不动了（章末或全书末）
  }
  info(`翻页轨迹：${trace.join(' | ')}`);
  const endState = await cdp.eval(
    null,
    `const S = window.__peidu.state;
     return { ch: document.getElementById('foot-chapter').textContent,
              num: document.getElementById('foot-num').textContent,
              chars: document.getElementById('page-body').textContent.length,
              chapterIndex: S.chapterIndex, chapterCount: S.book.chapters.length };`
  );
  check('连翻到底没有出现白页', whitePages === 0, `白页 ${whitePages} 张`);
  if (whitePages > 0) info(`白页出现在：${trace.filter((t) => t.endsWith('0字')).join(' | ')}`);
  // 页码只能前进，除非跨章时归零。这条断言防的是「页码不涨、章号也不涨，
  // 于是在最后一页和第一页之间反复横跳」那种病（state 章号没跟着 enterChapter 更新）。
  const steps = trace.map((t) => {
    const m = t.match(/章(\d+) 页(\d+)\//);
    return m ? { ch: Number(m[1]), page: Number(m[2]) } : null;
  }).filter(Boolean);
  let monotonic = true;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const cur = steps[i];
    // 同章内必须递增，**除非**上一步已经是最后一页（那是"翻不动了"，正常）
    const lastStep = i === steps.length - 1;
    if (cur.ch === prev.ch && cur.page <= prev.page && !lastStep) monotonic = false;
    if (cur.ch === prev.ch && cur.page < prev.page && lastStep) monotonic = false;
    if (cur.ch < prev.ch) monotonic = false; // 章号不能倒退
  }
  check('页码严格递增、跨章后归零（没有在首末页之间横跳）', monotonic, `${steps.length} 步`);
  check('能一路翻到最后一章', endState.ch.includes('三'), `${endState.ch} ${endState.num}（第 ${endState.chapterIndex + 1}/${endState.chapterCount} 章）`);
  info(`终点：${endState.ch} · ${endState.num}（${endState.chars} 字）`);

  console.log('\n== 目录 ==');
  const toc = await cdp.eval(
    null,
    `const items = [...document.querySelectorAll('#rail-body .toc__item, #rail-body button, #rail-body a')];
     return { count: items.length, labels: items.slice(0, 6).map(n => n.textContent.trim().slice(0, 20)),
              railText: (document.getElementById('rail-body').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) };`
  );
  check('目录里有章节条目', toc.count >= 3, `${toc.count} 条：${toc.labels.join(' / ')}`);
  if (toc.count < 3) info(`目录全文：${toc.railText}`);

  console.log('\n== 面板 ==');
  await cdp.eval(null, `document.getElementById('btn-read-settings').click(); return true;`);
  await sleep(450);
  const settingsSheet = await cdp.eval(
    null,
    `const s = document.querySelector('.sheet');
     if (!s) return { open: false };
     return {
       open: true,
       title: (s.querySelector('.sheet__title, h2, .panel__label')?.textContent || '').trim().slice(0, 20),
       ranges: s.querySelectorAll('input[type=range]').length,
       segs: s.querySelectorAll('.segmented button').length,
       switches: s.querySelectorAll('.switch').length,
       text: (s.textContent || '').replace(/\\s+/g, ' ').slice(0, 60),
     };`
  );
  check('排版面板打得开', settingsSheet.open, settingsSheet.text || '');
  check('排版面板里有控件', (settingsSheet.ranges || 0) > 0 && (settingsSheet.segs || 0) > 0, `range ${settingsSheet.ranges} / 分段 ${settingsSheet.segs} / 开关 ${settingsSheet.switches}`);
  const shot2 = await shot(cdp, '02-settings-phone');
  info(`截图 → ${path.relative(ROOT, shot2)}`);

  // 改字号，看正文是不是真的变了（这一条防的正是"写进没人读的 CSS 变量"）
  const fontChanged = await cdp.eval(
    null,
    `const before = getComputedStyle(document.getElementById('page-body')).fontSize;
     const sliders = [...document.querySelectorAll('.sheet input[type=range]')];
     const first = sliders[0];
     first.value = String(Number(first.value) + 2);
     first.dispatchEvent(new Event('input', { bubbles: true }));
     first.dispatchEvent(new Event('change', { bubbles: true }));
     await new Promise(r => setTimeout(r, 400));
     const after = getComputedStyle(document.getElementById('page-body')).fontSize;
     return { before, after, setting: Number(first.value) };`
  );
  check('拖动字号滑块正文真的变了', fontChanged.before !== fontChanged.after, `${fontChanged.before} → ${fontChanged.after}`);

  // 关掉面板
  await closeAllSheets(cdp);
  await sleep(400);

  await cdp.eval(null, `document.getElementById('btn-ai').click(); return true;`);
  await sleep(450);
  const aiSheet = await cdp.eval(
    null,
    `const s = [...document.querySelectorAll('.sheet')].pop();
     if (!s) return { open: false };
     const text = (s.textContent || '').replace(/\\s+/g, ' ');
     return {
       open: true,
       hasPassword: !!s.querySelector('input[type=password]'),
       hasTest: /测一下能不能连上|测试连接|测一下/.test(text),
       // 「密钥只存在本机」这句话必须在界面上 —— 往网页里粘 key 是需要信任的动作
       privacy: /本机|不会上传|只存在/.test(text),
       text: text.slice(0, 70),
     };`
  );
  check('AI 设置面板打得开', aiSheet.open, aiSheet.text || '');
  check('有 API Key 输入框（password 型）', aiSheet.hasPassword);
  check('有「测一下能不能连上」按钮', aiSheet.hasTest);
  check('界面上写明了密钥只存在本机', aiSheet.privacy);
  const shot3 = await shot(cdp, '03-ai-settings-phone');
  info(`截图 → ${path.relative(ROOT, shot3)}`);
  await closeAllSheets(cdp);
  await sleep(400);

  console.log('\n== 批注 / 弹幕（未配密钥时不能崩） ==');
  await cdp.eval(null, `document.getElementById('btn-notes').click(); return true;`);
  await sleep(600);
  const notesRes = await cdp.eval(
    null,
    `return {
       sheets: document.querySelectorAll('.sheet').length,
       toasts: (document.getElementById('toasts').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
       marks: document.querySelectorAll('.has-note, .note-mark, [data-note]').length,
     };`
  );
  check('点批注不会崩（无密钥时给出提示或空面板）', notesRes.sheets > 0 || notesRes.toasts.length > 0, notesRes.toasts || `面板 ${notesRes.sheets} 个`);

  // 提示墙：如果每条 toast 都只 append 不回收，屏幕上会立起一堵同样的字把正文全挡住
  // （截图里出现过 13 条一模一样的「先去 AI 设置里填一个 API Key」）。
  // 直接调模块导出的 toast，才能控制"同一句话刷八次"这个确切场景。
  const wall = await cdp.eval(
    null,
    `const dom = await import('./js/ui/dom.js');
     const host = document.getElementById('toasts');
     host.replaceChildren();
     for (let i = 0; i < 8; i++) dom.toast('同一句话');
     await new Promise(r => setTimeout(r, 60));
     const afterDup = [...host.children].map(n => n.textContent);
     for (let i = 0; i < 5; i++) dom.toast('第' + i + '句不同的话');
     await new Promise(r => setTimeout(r, 60));
     const afterMany = [...host.children].map(n => n.textContent);
     host.replaceChildren();
     return { afterDup, afterMany };`
  );
  check('同一句话刷八次只留一条（去重）', wall.afterDup.length === 1, JSON.stringify(wall.afterDup));
  check('不同的话连来五条时最多留 3 条（不会立起提示墙）', wall.afterMany.length <= 3, `${wall.afterMany.length} 条：${JSON.stringify(wall.afterMany)}`);
  await closeAllSheets(cdp);
  await sleep(400);

  await cdp.eval(null, `document.getElementById('btn-danmaku').click(); return true;`);
  await sleep(700);
  const dm = await cdp.eval(
    null,
    `const layer = document.getElementById('danmaku-layer');
     const ls = getComputedStyle(layer);
     return {
       pressed: document.getElementById('btn-danmaku').getAttribute('aria-pressed'),
       pe: ls.pointerEvents,
       zIndex: ls.zIndex,
       nodes: layer.children.length,
       // 弹幕层绝不能进分页测量：它必须完全在 .page-body 之外
       insideBody: !!document.getElementById('page-body').querySelector('.dm, .danmaku, [class^=dm-]'),
     };`
  );
  check('弹幕按钮能切换状态', dm.pressed === 'true', `aria-pressed=${dm.pressed}`);
  check('弹幕层不吃点击（pointer-events:none）', dm.pe === 'none', dm.pe);
  check('弹幕在测量容器之外', !dm.insideBody);

  console.log('\n== 书搭子 ==');
  await cdp.eval(null, `document.getElementById('btn-companion').click(); return true;`);
  await sleep(700);
  const chat = await cdp.eval(
    null,
    `const s = [...document.querySelectorAll('.sheet')].pop();
     if (!s) return { open: false };
     const text = (s.textContent || '').replace(/\\s+/g, ' ');
     return {
       open: true,
       hasInput: !!s.querySelector('textarea, input[type=text]'),
       inputFont: s.querySelector('textarea') ? getComputedStyle(s.querySelector('textarea')).fontSize : '',
       quick: s.querySelectorAll('.chip').length,
       text: text.slice(0, 80),
     };`
  );
  check('书搭子面板打得开', chat.open, chat.text || '');
  check('有输入框', chat.hasInput);
  check('输入框字号 ≥16px（否则 iOS 上一点就整页放大）', parseFloat(chat.inputFont) >= 16, chat.inputFont);
  check('有快速提问按钮', chat.quick >= 3, `${chat.quick} 个`);
  // 面板内部三个区（列表 / 快速提问 / 输入）不能互相压住 ——
  // 在屏幕上表现为"chip 被输入框盖掉一半"，但纯看截图容易以为是别的毛病。
  const chatGeom = await cdp.eval(
    null,
    `const s = [...document.querySelectorAll('.sheet')].pop();
     const pick = (sel) => { const n = s.querySelector(sel); if (!n) return null;
       const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
     const sheet = s.getBoundingClientRect();
     const list = pick('.chat__list'), quick = pick('.chat__quick'), comp = pick('.chat__composer');
     const input = pick('.chat__input');
     return { sheet: { top: Math.round(sheet.top), bottom: Math.round(sheet.bottom), h: Math.round(sheet.height) },
              list, quick, comp, input,
              vh: window.innerHeight,
              overlapQuickComp: quick && comp ? Math.round(quick.bottom - comp.top) : null };`
  );
  if (chatGeom.quick && chatGeom.comp) {
    info(`面板几何：sheet ${chatGeom.sheet.top}→${chatGeom.sheet.bottom}（高 ${chatGeom.sheet.h}，视口 ${chatGeom.vh}）`);
    info(`  列表 ${chatGeom.list ? `${chatGeom.list.top}→${chatGeom.list.bottom}` : '无'}｜快速提问 ${chatGeom.quick.top}→${chatGeom.quick.bottom}｜输入区 ${chatGeom.comp.top}→${chatGeom.comp.bottom}`);
    check('快速提问条没有被输入区压住', chatGeom.overlapQuickComp <= 0, `重叠 ${chatGeom.overlapQuickComp}px`);
    check('输入区和快速提问条都在视口内', chatGeom.comp.bottom <= chatGeom.vh + 1 && chatGeom.quick.top >= -1, `输入区底 ${chatGeom.comp.bottom} / 视口 ${chatGeom.vh}`);
  }
  const shot4 = await shot(cdp, '04-companion-phone');
  info(`截图 → ${path.relative(ROOT, shot4)}`);
  await closeAllSheets(cdp);
  await sleep(400);

  console.log('\n== iPad 竖屏排版 ==');
  await closeAllSheets(cdp); // 手机段留下的「书搭子」浮层会一路叠到 iPad 截图里
  await waitToasts(cdp, 800);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(900); // 等 orientationchange/resize 的防抖走完
  const ipad = await cdp.eval(
    null,
    `const body = document.getElementById('page-body');
     const cs = getComputedStyle(body);
     const de = document.documentElement;
     return {
       device: de.dataset.device,
       fontSize: cs.fontSize,
       maxWidth: cs.maxWidth,
       pagePad: cs.paddingLeft,
       chars: body.textContent.length,
       railWidth: (() => { const r = document.getElementById('rail'); return r ? getComputedStyle(r).width : ''; })(),
       hasRail: document.getElementById('reader').classList.contains('has-rail'),
     };`
  );
  info(`data-device=${ipad.device} 字号 ${ipad.fontSize} 行宽 ${ipad.maxWidth} 内边距 ${ipad.pagePad}`);
  check('iPad 宽度下设备档位识别为平板或桌面', ipad.device !== 'phone', ipad.device);
  check('iPad 上正文仍渲染', ipad.chars > 0, `${ipad.chars} 字`);
  check('iPad 上行宽比手机宽', parseFloat(ipad.maxWidth) > 420, ipad.maxWidth);
  const shot5 = await shot(cdp, '05-reader-ipad');
  info(`截图 → ${path.relative(ROOT, shot5)}`);

  // iPad 上排版面板能不能滚到最底下那几组（字体/主题/锚点/行为）？
  // 面板内容比屏幕高，如果 sheet__body 不能滚，底下的选项就是点不到的。
  await cdp.eval(null, `document.getElementById('btn-read-settings').click(); return true;`);
  await sleep(500);
  const scrollable = await cdp.eval(
    null,
    `const s = [...document.querySelectorAll('.sheet')].pop();
     const body = s.querySelector('.sheet__body');
     const before = body.scrollTop;
     body.scrollTop = 99999;
     await new Promise(r => requestAnimationFrame(r));
     return { clientH: body.clientHeight, scrollH: body.scrollHeight,
              canScroll: body.scrollTop > before || body.scrollHeight <= body.clientHeight + 2,
              moved: body.scrollTop, sheetH: Math.round(s.getBoundingClientRect().height), vh: window.innerHeight };`
  );
  check('iPad 上排版面板能滚到底部选项', scrollable.canScroll,
    `body ${scrollable.clientH}/${scrollable.scrollH}px，面板高 ${scrollable.sheetH}，视口 ${scrollable.vh}`);
  await closeAllSheets(cdp);
  await sleep(300);

  console.log('\n== 刷新后进度还在 ==');
  const beforeReload = await cdp.eval(
    null,
    `return { ch: document.getElementById('foot-chapter').textContent,
              num: document.getElementById('foot-num').textContent };`
  );
  // 先翻几页离开开头，否则"恢复了开头"证明不了任何事
  for (let i = 0; i < 3; i++) {
    await cdp.eval(null, `document.getElementById('pager-next').click(); return true;`);
    await sleep(200);
  }
  const moved = await cdp.eval(null, `return document.getElementById('foot-num').textContent;`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Page.navigate', { url: APP });
  const boot2 = await waitBooted(cdp);
  check('刷新后仍能启动', boot2 >= 0, `${boot2}ms`);
  await sleep(800);
  const libAfter = await cdp.eval(
    null,
    `const cards = document.querySelectorAll('.bookcard');
     return {
       cards: cards.length,
       text: (document.getElementById('library').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
       pct: document.querySelector('.bookcard__pct')?.textContent || '',
     };`
  );
  check('刷新后书架上有这本书（落库成功）', libAfter.cards >= 1, `${libAfter.cards} 本：${libAfter.text}`);
  check('书架显示阅读进度', /\d+%/.test(libAfter.pct), libAfter.pct);

  // 点开它，看是不是回到了读过的地方
  const clickRes = await cdp.eval(
    null,
    `const btn = document.querySelector('.bookcard__main');
     if (!btn) return { clicked: false, why: '没有 .bookcard__main' };
     btn.click();
     return { clicked: true, label: btn.getAttribute('aria-label') || '' };`
  );
  info(`点了书卡：${clickRes.clicked ? clickRes.label : clickRes.why}`);
  await sleep(2500);
  const reopened = await cdp.eval(
    null,
    `return { reading: !document.getElementById('view-reader').hidden,
              ch: document.getElementById('foot-chapter').textContent,
              num: document.getElementById('foot-num').textContent,
              chars: document.getElementById('page-body').textContent.length,
              toast: (document.getElementById('toasts').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
              view: window.__peidu.state.view };`
  );
  check('能从书架重新打开', reopened.reading && reopened.chars > 0, `${reopened.ch} ${reopened.num}｜view=${reopened.view}｜${reopened.toast}`);
  check('记住了上次读到哪（换了字号/设备后仍按段落定位）', reopened.num !== beforeReload.num || reopened.ch !== beforeReload.ch, `刷新前 ${beforeReload.ch}${beforeReload.num} → 翻到 ${moved} → 重开后 ${reopened.ch}${reopened.num}`);
  const shot6 = await shot(cdp, '06-reopened');
  info(`截图 → ${path.relative(ROOT, shot6)}`);

  console.log('\n== 配 AI（假模型服务）==');
  /* 这一段的用意：
     产品一半的价值在 AI 层，而那一层的风险不在"模型答得好不好"，在于**我们
     这半边的管道**：请求发出去没有、JSON 解不解得开、pi 有没有对上段落、
     批注有没有画到页上、流式是不是一个字一个字出来的，以及最要紧的 ——
     **送出去的上下文里有没有剧透**。
     用真 API 测不了这些（每次回答都不一样，断言写不死），所以用
     tools/fake-ai.mjs：确定性回答 + 把每个请求原文录下来供断言。 */
  const fakeUp = await (async () => {
    try {
      const r = await fetch(`http://127.0.0.1:8787/v1/models`);
      return r.ok;
    } catch {
      return false;
    }
  })();

  if (!fakeUp) {
    info('跳过 AI 段：没起假模型服务。先跑 `node tools/fake-ai.mjs` 再执行本脚本。');
  } else {
    await fetch('http://127.0.0.1:8787/__reset', { method: 'POST' });
    const FAKE = 'http://127.0.0.1:8787/v1';

    // 走真实 UI 路径填配置（而不是直接写库），这样表单本身也被测到
    await cdp.eval(null, `document.getElementById('btn-ai').click(); return true;`);
    await sleep(600);
    const filled = await cdp.eval(
      null,
      `const s = [...document.querySelectorAll('.sheet')].pop();
       // 先切到「自定义」，否则服务商默认值会把我们填的地址覆盖掉
       const custom = [...s.querySelectorAll('.segmented button')].find(b => /自定义/.test(b.textContent));
       if (custom) custom.click();
       await new Promise(r => setTimeout(r, 120));
       const put = (key, val) => {
         const input = s.querySelector('input[data-key="' + key + '"]');
         if (!input) return false;
         input.value = val;
         input.dispatchEvent(new Event('blur', { bubbles: false }));
         input.blur();
         return true;
       };
       const okKey = put('apiKey', 'sk-fake-for-smoke');
       const okBase = put('baseURL', ${JSON.stringify(FAKE)});
       const okModel = put('model', 'fake-peidu');
       put('cheapModel', 'fake-peidu');
       await new Promise(r => setTimeout(r, 500));
       const status = (s.querySelector('.set__hint--block') || {}).textContent || '';
       return { okKey, okBase, okModel, status };`
    );
    check('AI 设置里能填进 Key / 地址 / 模型', filled.okKey && filled.okBase && filled.okModel, filled.status);

    await cdp.eval(
      null,
      `const s = [...document.querySelectorAll('.sheet')].pop();
       const btn = [...s.querySelectorAll('button')].find(b => /测一下能不能连上/.test(b.textContent));
       btn.click();
       return true;`
    );
    await sleep(1200);
    const probe = await cdp.eval(null, `return (document.getElementById('toasts').textContent || '').trim().slice(0, 60);`);
    check('「测一下能不能连上」连到假服务并报成功', /连上了/.test(probe), probe);
    await closeAllSheets(cdp);
    await sleep(300);

    // 回到第一章，等批注自己长出来（这是产品最核心的一条路径：
    // 打开书 → 后台生成 → 读到的时候它已经在那里）
    await cdp.eval(
      null,
      `const items = [...document.querySelectorAll('#rail-body button')];
       const first = items.find(b => /第一章/.test(b.textContent));
       if (first) first.click();
       return true;`
    );
    await sleep(600);
    let notes = { has: 0, pins: 0 };
    const tNotes = Date.now();
    while (Date.now() - tNotes < 25000) {
      notes = await cdp.eval(
        null,
        `return { has: document.querySelectorAll('#page-body .has-note').length,
                  pins: document.querySelectorAll('.note-pin, #note-layer > *').length,
                  toast: (document.getElementById('toasts').textContent || '').trim().slice(0, 40) };`
      );
      if (notes.has > 0) break;
      await sleep(400);
    }
    check('打开第一章之后批注被生成并画到了页上', notes.has > 0, `带批注的段落 ${notes.has} 个、页边标记 ${notes.pins} 个（${Date.now() - tNotes}ms）`);

    await cdp.eval(null, `document.getElementById('btn-notes').click(); return true;`);
    await sleep(800);
    const panel = await cdp.eval(
      null,
      `const items = [...document.querySelectorAll('.note-item__text')].map(n => n.textContent.trim());
       return {
         count: items.length,
         items,
         summary: (document.querySelector('.notes-summary__text') || {}).textContent || '',
         chars: [...document.querySelectorAll('.notes-char')].map(n => n.textContent),
         firstPage: (document.querySelector('.note-item__page') || {}).textContent || '',
       };`
    );
    check('批注面板列出了批注', panel.count > 0, `${panel.count} 条：${panel.items.slice(0, 2).join(' / ')}`);
    // 假模型给几条，应用就该留下几条（除非真的没过质量闸门）。
    // 差值大 = 闸门太严或者解析丢东西，而页面上只表现为"批注有点少"，看不出来。
    const kept = await cdp.eval(
      null,
      `const S = window.__peidu.state;
       const ch = S.book.chapters[S.chapterIndex];
       const ai = (S.ai && S.ai[ch.id]) || null;
       return { notes: ai ? (ai.notes || []).length : -1, summary: ai ? !!ai.summary : false };`
    );
    const log1 = await (await fetch('http://127.0.0.1:8787/__log')).json();
    // ★ 必须按章比对：应用会往后预取（第一章在读的时候，第二、三章的批注
    //   已经在生成了，那是设计如此）。第一版把"所有 JSON 请求给出的条数"
    //   和"当前章的条数"相比，于是永远差一截 —— 是断言写错了，不是应用丢数据。
    const chapterKey = '第 1 章';
    const gave = log1
      .filter((e) => e.json && /"notes"/.test(e.answer || '') && (e.messages || []).some((m) => (m.content || '').includes(chapterKey)))
      .map((e) => {
        try {
          return (JSON.parse(e.answer).notes || []).length;
        } catch {
          return 0;
        }
      })
      .reduce((a, b) => a + b, 0);
    check('模型给的批注基本都被留下了（闸门没吃掉大半）', kept.notes > 0 && kept.notes >= Math.ceil(gave * 0.5),
      `第一章：模型给 ${gave} 条，应用留下 ${kept.notes} 条`);
    const paraCount = await cdp.eval(
      null,
      `const S = window.__peidu.state;
       const ch = S.book.chapters[S.chapterIndex];
       return { paras: (ch.paras || []).length, allChapters: S.book.chapters.length };`
    );
    info(`第一章 ${paraCount.paras} 段 → 默认密度下只挑了几段去问模型（宁少勿滥），共留 ${kept.notes} 条批注`);
    check('批注正文具体、不是空洞废话',
      panel.items.every((t) => t.length >= 6 && !/细腻|生动|精彩|优美|深刻/.test(t)),
      panel.items[0] || '（空）');
    check('面板显示本章梗概与人物', panel.summary.length > 0 && panel.chars.length > 0, `${panel.summary.slice(0, 24)}｜${panel.chars.join('、')}`);

    // 点一条批注 → 跳到原文那一段所在页
    const jumped = await cdp.eval(
      null,
      `const row = document.querySelector('.note-item') || document.querySelector('.notes-list li');
       if (!row) return { ok: false };
       const pi = (row.querySelector('.note-item__pi') || {}).textContent || '';
       row.click();
       await new Promise(r => setTimeout(r, 700));
       const S = window.__peidu.state;
       const text = document.getElementById('page-body').textContent || '';
       return { ok: true, pi, pageIndex: S.pageIndex, chars: text.length,
                text: text.slice(0, 30), sheets: document.querySelectorAll('.sheet').length };`
    );
    check('点一条批注能跳到原文', jumped.ok && jumped.chars > 0, `${jumped.pi} → 第 ${(jumped.pageIndex ?? 0) + 1} 页「${jumped.text}」`);

    // 弹幕：配了 AI 之后点一次应该真的飘出字来
    await closeAllSheets(cdp);
    await cdp.eval(null, `document.getElementById('btn-danmaku').click(); return true;`);
    let dmNodes = [];
    const tDm = Date.now();
    while (Date.now() - tDm < 20000) {
      dmNodes = await cdp.eval(
        null,
        `return [...document.querySelectorAll('#danmaku-layer .dm')].map(n => n.textContent.trim());`
      );
      if (dmNodes.length > 0) break;
      await sleep(400);
    }
    check('一键弹幕真的飘出了字', dmNodes.length > 0, `${Date.now() - tDm}ms 后屏上 ${dmNodes.length} 条：${dmNodes.slice(0, 3).join(' / ')}`);
    check('弹幕都很短（飘过去的东西没人读第二遍）', dmNodes.every((t) => t.length <= 14), `最长 ${Math.max(0, ...dmNodes.map((t) => t.length))} 字`);

    // 轨道有没有真的分开：同一时刻几条弹幕如果都挤在同一个 top 上，就是「叠字」，
    // 看着像弹幕但其实读不清 —— 轨道算法（lanes[lane].until）出问题时就是这样。
    const lanes = await cdp.eval(
      null,
      `const paper = document.getElementById('paper');
       const nodes = [...document.querySelectorAll('#danmaku-layer .dm')];
       return { paperH: paper ? paper.clientHeight : 0,
                tops: nodes.map(n => Math.round(n.getBoundingClientRect().top)),
                vars: nodes.map(n => n.style.getPropertyValue('--dm-top') + '/' + n.style.getPropertyValue('--dm-lane')) };`
    );
    const distinct = new Set(lanes.tops).size;
    info(`弹幕轨道：paper 高 ${lanes.paperH}px，${lanes.tops.length} 条的字顶位置 [${lanes.tops.join(',')}]，不同位置 ${distinct} 个`);
    if (lanes.tops.length >= 3) {
      check('多条弹幕占不同轨道（不是叠在同一行）', distinct >= 2, `${lanes.tops.length} 条落在 ${distinct} 个位置`);
    }

    // 书搭子：流式 + 回复内容
    await cdp.eval(null, `document.getElementById('btn-companion').click(); return true;`);
    await sleep(700);
    const streamed = await cdp.eval(
      null,
      `const s = [...document.querySelectorAll('.sheet')].pop();
       const chip = s.querySelector('.chip');
       chip.click();
       // 抓一下"正在流式输出"的那个瞬间
       let sawLive = false;
       for (let i = 0; i < 60; i++) {
         await new Promise(r => setTimeout(r, 100));
         if (s.querySelector('.cm--live')) { sawLive = true; break; }
       }
       for (let i = 0; i < 80; i++) {
         await new Promise(r => setTimeout(r, 100));
         if (!s.querySelector('.cm--live') && s.querySelector('.cm--ai')) break;
       }
       const bubbles = [...s.querySelectorAll('.cm')].map(b => ({
         me: b.classList.contains('cm--me'),
         text: (b.querySelector('.cm__text') || {}).textContent || '',
       }));
       return { sawLive, bubbles, quick: s.querySelectorAll('.chip').length };`
    );
    check('书搭子会流式输出（能看到"正在说"的状态）', streamed.sawLive);
    check('书搭子回了话', streamed.bubbles.some((b) => !b.me && b.text.length > 3),
      streamed.bubbles.filter((b) => !b.me).map((b) => b.text.slice(0, 30)).join(' | '));

    /* ---- 朗读（TTS）----
       听不到声音，但"有没有真的去调 speechSynthesis"是可测的：
       把 speak() 换成一个记账的桩，再点「念」。
       能力探测也要诚实：系统不支持就不该显示这个按钮。 */
    const tts = await cdp.eval(
      null,
      `const s = [...document.querySelectorAll('.sheet')].pop();
       const box = window.speechSynthesis;
       const supported = typeof window.speechSynthesis === 'object' && !!window.speechSynthesis;
       const calls = [];
       if (supported) window.speechSynthesis.speak = (u) => calls.push(String(u && u.text || ''));
       const readBtn = [...s.querySelectorAll('button')].find(b => /念/.test(b.textContent));
       if (!readBtn) return { supported, hasBtn: false, calls };
       // 先打开"念"，再点一条 AI 消息上的朗读
       if (readBtn.getAttribute('aria-pressed') !== 'true') readBtn.click();
       await new Promise(r => setTimeout(r, 250));
       const say = s.querySelector('.cm__say');
       if (say) say.click();
       await new Promise(r => setTimeout(r, 350));
       const S = window.__peidu.state;
       return { supported, hasBtn: true,
                pressed: readBtn.getAttribute('aria-pressed'),
                speakOn: S.settings.companionSpeak === true,
                cancelled: true,
                calls };`
    );
    check('朗读按钮只在系统支持时出现（能力探测诚实）', tts.supported ? tts.hasBtn : !tts.hasBtn,
      `speechSynthesis=${tts.supported ? '有' : '无'}，按钮 ${tts.hasBtn ? '在' : '不在'}`);
    if (tts.supported && tts.hasBtn) {
      check('点「念」之后真的调了 speechSynthesis.speak', (tts.calls || []).length > 0,
        tts.calls && tts.calls[0] ? `念的是「${tts.calls[0].slice(0, 24)}…」` : '没有调用');
      check('朗读开关会落盘（下次打开还是这个状态）', tts.speakOn === true, `companionSpeak=${tts.speakOn}`);
    }
    await closeAllSheets(cdp);

    /* ---- 剧透红线：拿**真实发出去的请求**来验，而不是读 prompt 自我安慰 ----
       书搭子的上下文里，spoilerPi 之后的内容一个字都不该出现，
       包括后面章节的标题。书名里带"账本"两个字，所以断言只能用
       只在后文出现的字眼（第二章的「铜锁」、第三章的「文具店」「十七楼」）。 */
    const log = await (await fetch('http://127.0.0.1:8787/__log')).json();
    const companionReqs = log.filter((e) =>
      (e.messages || []).some((m) => /读到的进度完全一样/.test(m.content || ''))
    );
    const allDamage = companionReqs.map((e) => (e.messages || []).map((m) => m.content).join('\n'));
    const leaks = allDamage.filter((t) => /铜锁|文具店|十七楼|蓝皮，横格/.test(t));
    check('书搭子的请求里没有后文（第二条红线）', companionReqs.length > 0 && leaks.length === 0,
      `书搭子请求 ${companionReqs.length} 次，泄漏 ${leaks.length} 次`);
    if (leaks.length) info(`泄漏样例：${leaks[0].match(/.{0,30}(铜锁|文具店|十七楼|蓝皮，横格).{0,30}/)?.[0] || ''}`);
    const noteReqs = log.filter((e) => e.json && !companionReqs.includes(e));
    check('批注/弹幕请求用的是 JSON 模式', noteReqs.length > 0, `${noteReqs.length} 次`);
    check('每次请求都带了鉴权头', log.every((e) => e.auth.startsWith('Bearer')), log[0]?.auth || '（无请求）');
    info(`假服务共收到 ${log.length} 次请求（书搭子 ${companionReqs.length} 次，JSON 模式 ${noteReqs.length} 次）`);

    const shot7 = await shot(cdp, '07-notes-with-ai');
    info(`截图 → ${path.relative(ROOT, shot7)}`);
  }

  console.log('\n== Service Worker ==');
  const sw = await cdp.eval(
    null,
    `if (!('serviceWorker' in navigator)) return { supported: false };
     const regs = await navigator.serviceWorker.getRegistrations();
     return { supported: true, count: regs.length, scope: regs[0]?.scope || '' };`
  );
  check('在 localhost 上注册了 Service Worker', sw.count >= 1, `${sw.count} 个，scope=${sw.scope}`);

  // 「能装到 iOS 主屏幕、断网还能读」是 PWA 的全部意义所在，
  // 所以离线缓存必须真的建起来了 —— 注册成功不等于缓存成功。
  const offline = await cdp.eval(
    null,
    `if (!('caches' in window)) return { supported: false };
     const names = await caches.keys();
     const shell = names.find(n => n.startsWith('shell-'));
     let entries = 0, hasIndex = false, hasJs = false, hasCss = false;
     if (shell) {
       const c = await caches.open(shell);
       const keys = await c.keys();
       entries = keys.length;
       const urls = keys.map(r => new URL(r.url).pathname);
       hasIndex = urls.some(u => u === '/' || u.endsWith('/index.html'));
       hasJs = urls.some(u => u.endsWith('/js/app.js'));
       hasCss = urls.some(u => u.endsWith('/css/reader.css'));
     }
     return { supported: true, names, shell, entries, hasIndex, hasJs, hasCss };`
  );
  if (offline.supported) {
    check('离线缓存建起来了', !!offline.shell && offline.entries > 5, `${offline.shell} 中共 ${offline.entries} 个资源`);
    check('离线缓存里有外壳三件套（HTML / JS / CSS）',
      offline.hasIndex && offline.hasJs && offline.hasCss,
      `index=${offline.hasIndex} app.js=${offline.hasJs} reader.css=${offline.hasCss}`);
  } else {
    info('这个浏览器不支持 Cache Storage，跳过离线检查');
  }

  /* ---- 断网还能读 ----
     这是 PWA 存在的全部意义：装到 iOS 主屏之后，地铁里没信号也得能读。
     "SW 注册成功""缓存里有 39 个文件"都只是必要条件，不是充分条件 ——
     真正要验的是**把网断掉再打开**。 */
  console.log('\n== 断网还能读 ==');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await cdp.send('Page.navigate', { url: APP });
  const bootOffline = await waitBooted(cdp, 12000);
  check('断网后应用仍能启动（Service Worker 供货）', bootOffline >= 0, bootOffline >= 0 ? `${bootOffline}ms` : '超时没起来');
  await sleep(700);
  const offlineState = await cdp.eval(
    null,
    `const cards = document.querySelectorAll('.bookcard');
     return { online: navigator.onLine, books: cards.length,
              title: (document.querySelector('.library__title') || {}).textContent || '',
              text: (document.getElementById('library').textContent || '').replace(/\\s+/g, ' ').slice(0, 40) };`
  );
  info(`navigator.onLine=${offlineState.online}（断网时浏览器会报 false）`);
  check('断网后书架还在、书还在', offlineState.books >= 1, `${offlineState.books} 本：${offlineState.text}`);
  const offlineRead = await cdp.eval(
    null,
    `const btn = document.querySelector('.bookcard__main');
     if (!btn) return { opened: false };
     btn.click();
     for (let i = 0; i < 40; i++) {
       await new Promise(r => setTimeout(r, 150));
       const chars = document.getElementById('page-body').textContent.length;
       if (chars > 0) return { opened: true, chars, foot: document.getElementById('foot-num').textContent };
     }
     return { opened: false };`
  );
  check('断网后能打开书、正文读得出来', offlineRead.opened && offlineRead.chars > 0,
    offlineRead.opened ? `${offlineRead.chars} 字，${offlineRead.foot}` : '打不开');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await sleep(300);

  const finalErrors = pageErrors.filter((e) => !/favicon|Download the React/i.test(e));
  check('整轮下来没有页面级报错', finalErrors.length === 0, finalErrors.slice(0, 4).join(' | '));
  if (finalErrors.length) for (const e of finalErrors.slice(0, 6)) info(`页面报错：${e.split('\n')[0]}`);
  const uniq404 = [...new Set(failedUrls)].filter((u) => !/ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/.test(u));
  check('没有加载失败的资源', uniq404.length === 0, uniq404.slice(0, 6).join(' | '));
  if (uniq404.length) info(`加载失败的资源：\n      ${uniq404.join('\n      ')}`);
} catch (err) {
  console.error('\n自检脚本自己挂了：', err.message);
  process.exitCode = 2;
} finally {
  if (browser) {
    try {
      browser.cdp.ws.close();
    } catch {
      /* ignore */
    }
    try {
      browser.child.kill();
    } catch {
      /* ignore */
    }
    if (!KEEP) {
      await sleep(400);
      try {
        rmSync(browser.profile, { recursive: true, force: true });
      } catch {
        /* 文件被占用就算了，临时目录里的东西 */
      }
    }
  }
}

/* ---------------------------- 结算 ---------------------------- */

if (results.length) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n== 结算 ==\n  ${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    console.log('  没过：');
    for (const f of failed) console.log(`    ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}
