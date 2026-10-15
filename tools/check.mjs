/* ============================================================
   陪读 · 静态自检
   ------------------------------------------------------------
   为什么需要它：这个项目没有构建步骤、没有打包器、没有类型检查。
   `syntax error` 唯一的发现时机是浏览器打开页面的那一刻 ——
   而 iOS 上调试控制台并不方便。

   这个脚本做四件事：
     1. import 每一个模块，把语法错误和「顶层就碰 document」抓出来；
     2. 扫描 index.html 引用到的每个本地资源是否真的存在；
     3. 扫描各模块的 import 语句，确认被导入的路径都能解析；
     4. 扫部署可用性（写死的本机地址、PWA 清单、SW 预缓存清单与实际文件是否对得上）。

   它不能替代真机测试，但能在 200ms 内把「一打开就白屏」这类
   错误全部挡在前面。

   用法：node tools/check.mjs
   ============================================================ */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SITE = join(ROOT, 'site');

let errors = 0;
let warnings = 0;

const fail = (msg) => {
  errors++;
  console.log('  ✗ ' + msg);
};
const warn = (msg) => {
  warnings++;
  console.log('  ! ' + msg);
};
const ok = (msg) => console.log('  ✓ ' + msg);

/* ---------------------------- 1. 收集所有 .js ---------------------------- */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(join(SITE, 'js')).concat(walk(join(ROOT, 'tools')));
console.log(`\n[1/4] 模块能否被加载（${files.length} 个文件）`);

for (const f of files) {
  const rel = relative(ROOT, f);
  try {
    // 只 import，不调用任何东西。模块顶层的副作用（碰 document）会在这里炸。
    await import(pathToFileURL(f).href);
  } catch (err) {
    const msg = String(err?.message || err);
    // Node 里没有 DOM 是已知且预期的，单独标出来，别和真语法错混在一起
    if (/document is not defined|window is not defined|navigator is not defined|indexedDB is not defined|matchMedia is not defined|HTMLElement is not defined|CustomEvent is not defined|localStorage is not defined/.test(msg)) {
      warn(`${rel} — 顶层就用了浏览器 API：${msg.split('\n')[0]}`);
    } else if (/^Cannot find (package|module)/.test(msg) || /ERR_MODULE_NOT_FOUND/.test(msg)) {
      fail(`${rel} — 导入路径不存在：${msg.split('\n')[0]}`);
    } else {
      fail(`${rel} — ${msg.split('\n')[0]}`);
    }
    continue;
  }

  // 模块能加载：再检查它 import 的相对路径是不是都能找到。
  //
  // ★ 先把块注释整段删掉再做匹配。不删的话，JSDoc 里的
  //   `@property {import('../core/model.js').BookDoc|null} book`
  //   会被抓成两条**不存在的** import 路径 —— 这是这个脚本自己踩过的坑。
  //   假警报比漏报更糟：它会让人开始不信任整个自检结果。
  const raw = readFileSync(f, 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1]
  );
  // 动态 import('./x.js')。中间允许空白，但不允许 '*'：
  // `import('*')` 这种写法不存在，而 `{import('...')}` 在 JSDoc 里到处都是。
  const dyn = [...src.matchAll(/import\(\s*['"]([^'"*]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const spec of specs.concat(dyn)) {
    if (!spec.startsWith('.')) continue; // 裸模块名（Node 内置）跳过
    const target = resolve(dirname(f), spec);
    if (!existsSync(target)) fail(`${rel} → 找不到 '${spec}'`);
  }
}

if (errors === 0) ok('全部模块加载通过，没有断裂的 import');

/* ---------------------------- 2. index.html 引用的资源 ---------------------------- */

console.log('\n[2/4] index.html 引用的本地资源是否存在');
const html = readFileSync(join(SITE, 'index.html'), 'utf8');
const refs = new Set();
for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g)) {
  const v = m[1];
  if (/^(https?:|data:|mailto:|#)/.test(v)) continue;
  refs.add(v.replace(/^\.\//, ''));
}
for (const r of refs) {
  const p = join(SITE, r);
  if (existsSync(p)) ok(r);
  else fail(`${r} 不存在`);
}

/* ---------------------------- 3. CSS 引用的类是否定义了（抽样） ---------------------------- */

console.log('\n[3/4] CSS 括号配平（括号不配平会让后面整段样式静默失效）');
const cssDir = join(SITE, 'css');
for (const name of readdirSync(cssDir)) {
  if (!name.endsWith('.css')) continue;
  const src = readFileSync(join(cssDir, name), 'utf8');
  // 先去掉注释和字符串，避免里面的括号造成假警报
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"|'[^']*'/g, '');
  let depth = 0;
  let line = 1;
  let firstBad = null;
  for (const ch of stripped) {
    if (ch === '\n') line++;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0 && firstBad === null) firstBad = line;
    }
  }
  if (firstBad !== null) fail(`${name}:${firstBad} 多了一个 '}'`);
  else if (depth !== 0) fail(`${name} 有 ${depth} 个未闭合的 '{'`);
  else ok(name);
}

/* ---------------------------- 4. 部署可用性 ---------------------------- */

/* 「本机能跑」和「部署上去能跑」是两件事。这个项目**没有构建步骤**，
   所以部署时发生的事就是：把 site/ 整个目录拷到服务器上。
   那么能出问题的只有三类：路径写死了本机地址、PWA 清单引了不存在的图标、
   Service Worker 的预缓存清单漏了文件（漏了的后果是"断网时少一个模块、
   整个应用起不来"，而那恰恰是用户装到主屏之后才会遇到的场景）。 */

console.log('\n[4/4] 部署可用性（这个项目没有构建步骤，拷目录就是部署）');

const LOCAL_PAT = /https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/g;
const scanForLocalUrls = (dir, skip = /node_modules|_ref/) => {
  const hits = [];
  const walkSrc = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (skip.test(p)) continue;
      const st = statSync(p);
      if (st.isDirectory()) walkSrc(p);
      else if (/\.(js|mjs|css|html|webmanifest|json)$/.test(name)) {
        const src = readFileSync(p, 'utf8');
        // 注释里提到本机地址是允许的（文档用途），只看真正的字符串字面量
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const m of code.matchAll(LOCAL_PAT)) hits.push(`${relative(ROOT, p)} → ${m[0]}`);
      }
    }
  };
  walkSrc(dir);
  return hits;
};
const localHits = scanForLocalUrls(SITE);
if (localHits.length) for (const h of localHits) fail(`部署产物里写死了本机地址：${h}`);
else ok('site/ 里没有写死 127.0.0.1 / localhost');

// PWA 清单：图标都得在，字段都得对
try {
  const mf = JSON.parse(readFileSync(join(SITE, 'manifest.webmanifest'), 'utf8'));
  const iconOk = (mf.icons || []).every((i) => existsSync(join(SITE, i.src.replace(/^\.\//, ''))));
  const icon192 = (mf.icons || []).some((i) => /192/.test(i.sizes || ''));
  const icon512 = (mf.icons || []).some((i) => /512/.test(i.sizes || ''));
  if (!iconOk) fail('manifest 里引了不存在的图标');
  else if (!icon192 || !icon512) fail(`manifest 缺少 192/512 图标（iOS 主屏会没有图标）`);
  else if (!mf.start_url || !mf.display) fail('manifest 缺 start_url 或 display');
  else ok(`manifest 可用（display=${mf.display}、图标 ${(mf.icons || []).length} 个）`);
} catch (err) {
  fail(`manifest.webmanifest 解析失败：${err.message}`);
}

// Service Worker 的预缓存清单：每一项都要真实存在
try {
  const swSrc = readFileSync(join(SITE, 'sw.js'), 'utf8');
  const listMatch = swSrc.match(/PRECACHE\s*=\s*\[([\s\S]*?)\]/);
  if (!listMatch) fail('sw.js 里找不到 PRECACHE 清单');
  else {
    const items = [...listMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const missing = items.filter((i) => {
      const rel = i.replace(/^\.\//, '');
      return rel && !existsSync(join(SITE, rel));
    });
    if (missing.length) fail(`sw.js 预缓存清单里有不存在的文件：${missing.join(', ')}`);
    else ok(`sw.js 预缓存清单 ${items.length} 项全部存在`);
  }
  // 页面里实际引用的资源，是否都在预缓存清单里（漏一个 = 断网缺一块）
  const precached = new Set(
    ([...(swSrc.match(/PRECACHE\s*=\s*\[([\s\S]*?)\]/) || [null, ''])[1]].join('').match(/['"]([^'"]+)['"]/g) || []).map((s) =>
      s.replace(/['"]/g, '').replace(/^\.\//, '')
    )
  );
  const notCached = [...refs].filter((r) => !precached.has(r) && !/manifest|icons/.test(r));
  if (notCached.length) warn(`这些资源没进预缓存（断网时会缺）：${notCached.join(', ')}`);
  else ok('index.html 引用的资源都在预缓存清单里');
} catch (err) {
  fail(`sw.js 检查失败：${err.message}`);
}

/* ---------------------------- 汇总 ---------------------------- */

console.log(
  `\n${errors === 0 ? '通过' : '失败'}：${errors} 个错误，${warnings} 个提醒（浏览器 API 的提醒是预期的）\n`
);
process.exit(errors === 0 ? 0 : 1);
