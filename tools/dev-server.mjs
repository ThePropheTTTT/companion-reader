// 零依赖静态服务器。
// 存在的理由：ES 模块和 Service Worker 在 file:// 下不可用，
// 而 iOS 要「加到主屏幕」必须走 HTTPS（局域网 http://<ip>:port 可用于同网段真机调试）。
// 部署时不需要这个文件——整个 site/ 目录丢到任意静态托管即可。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../site/', import.meta.url));
const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.epub': 'application/epub+zip',
  '.txt': 'text/plain; charset=utf-8',
};

/** 阻止 ../ 穿越到 site/ 之外。返回 null 表示越界。 */
function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const abs = join(ROOT, rel);
  if (abs !== ROOT.replace(/[/\\]$/, '') && !abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    return null;
  }
  return abs;
}

const server = createServer(async (req, res) => {
  const target = resolveSafe(req.url || '/');
  if (!target) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let file = target;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + req.url);
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      // 开发期禁用缓存，避免改完代码刷新还是旧的
      'cache-control': 'no-store',
      // 让 Service Worker 的作用域能覆盖整个站点（部署时由托管商处理）
      'service-worker-allowed': '/',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`陪读 dev server`);
  console.log(`  本机      http://localhost:${PORT}`);
  console.log(`  同网段真机 http://<你的局域网IP>:${PORT}   (iOS 真机调试用，非 HTTPS 无法加主屏幕)`);
  console.log(`  静态根目录 ${ROOT}`);
});
