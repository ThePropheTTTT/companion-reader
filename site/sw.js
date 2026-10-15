/* 陪读 —— Service Worker
 *
 * 目标只有两个，别的什么都不做：
 *   1. 把外壳（HTML/CSS/JS/图标）缓存起来，让 iOS 加到主屏后能秒开、能离线打开书架。
 *   2. 保证「书」和「AI 请求」绝不被卷进来。
 *
 * 第 2 点是这个文件里最要紧的设计：
 *   · 书存在 IndexedDB 里，本来就不走网络，但用户可能从任意 URL 导书；
 *   · AI 请求（/chat/completions）和任何带 Authorization 的请求一旦进缓存，
 *     会在换 Key、换服务商、或服务商改返回时给出**又旧又像真的**结果 ——
 *     这种 bug 排查起来极其痛苦。所以：请求带 Authorization 就直接放行，
 *     带 query string 的直接放行（DeepSeek/OpenAI 的兼容接口常这么带参数）。
 *
 * 缓存策略也刻意选简单的一档：install 时**尽力预缓存**（单个文件失败不让整次安装失败），
 * fetch 时 stale-while-revalidate。用 cache-first 会在开发期看半天旧页面，
 * 用 network-first 又会让离线首屏白等一个超时 —— 同源静态资源不值得那么复杂。
 */

const VERSION = 'peidu-v1';
const SHELL = `shell-${VERSION}`;
const KEEP = new Set([SHELL]);

// 预缓存清单。用相对路径，这样项目放在子目录（GitHub Pages 的 /bookreader/）也能用。
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/app.css',
  './css/library.css',
  './css/reader.css',
  './css/panel.css',
  './css/notes.css',
  './css/danmaku.css',
  './css/chat.css',
  './js/app.js',
  './js/state.js',
  './js/core/model.js',
  './js/core/store.js',
  './js/core/xml.js',
  './js/core/zip.js',
  './js/core/epub.js',
  './js/core/media.js',
  './js/core/anchor.js',
  './js/core/paginate.js',
  './js/ui/dom.js',
  './js/ui/library.js',
  './js/ui/reader.js',
  './js/ui/renderer.js',
  './js/ui/progress.js',
  './js/ui/settings.js',
  './js/ui/notes-panel.js',
  './js/ui/danmaku.js',
  './js/ui/ai-config.js',
  './js/ui/ai-bridge.js',
  './js/ui/chat.js',
  './js/ai/runtime.js',
  './js/ai/generate.js',
  './js/ai/danmaku.js',
  './js/ai/companion.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // 逐个 add 而不是 addAll：addAll 一个 404 就整批失败，
      // 而列表里任何一个文件暂时不存在（比如正在写的模块）不该让离线能力全废。
      const results = await Promise.allSettled(
        PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })))
      );
      const failed = PRECACHE.filter((_, i) => results[i].status === 'rejected');
      if (failed.length) console.warn('[sw] 这些资源没预缓存上（不影响使用）', failed);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => (KEEP.has(n) ? null : caches.delete(n))));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只碰 GET。POST/PUT 一律放行（AI 对话、未来的同步）。
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // 跨域不碰：AI 接口、将来可能的图床，都交给网络层自己处理。
  if (url.origin !== self.location.origin) return;
  // 带鉴权头的不碰（见文件头第 2 点）。
  if (req.headers.get('authorization')) return;
  // 带 query 的不碰：这类地址通常意味着「参数变了结果就该变」。
  if (url.search) return;
  // Range 请求不碰：缓存里存的是整份响应，拿去答 206 会给出错的字节。
  if (req.headers.get('range')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: false });

      // 后台更新（stale-while-revalidate）。用 event.waitUntil 让浏览器
      // 别在响应返回后立刻掐掉这次 fetch。
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (hit) {
        event.waitUntil(refresh);
        return hit;
      }

      const res = await refresh;
      if (res) return res;

      // 网络也挂了：导航请求退回缓存的 index.html，
      // 这样离线点开主屏图标至少还能看到书架，而不是浏览器的恐龙页。
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      // 其它资源就给一个明确的 503，而不是让 fetch 抛不可读的 TypeError。
      return new Response('离线，且这个资源没有缓存过。', {
        status: 503,
        statusText: 'Offline',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    })()
  );
});

// 让页面能主动触发「立刻用新版本」，见 app.js 里的注册处。
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
