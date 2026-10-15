/* ============================================================
   陪读 · 用 GitHub Data API 推送（github.com 的 git 端口不通时的替代路径）
   ------------------------------------------------------------
   为什么会有这个文件：这台机器上 `github.com:443` 连不上（git push/pull 全废），
   但 `api.github.com` 是通的。REST 的 Git Data API 能建 blob / tree / commit / ref，
   效果等价于一次 push，而且**能逐文件比对 blob sha**，比 push 更可验证。

   它不是 git 的替代品，只是网络被卡住时的应急通道。
   网络正常时请用普通的 `git push`。

   安全设计：任何一步对不上就中止，绝不在远端留下半个仓库。
     1. 每个要上传的文件，API 算出的 blob sha 必须等于本地 index 里的 sha；
     2. 拼出来的 tree sha 必须等于 `git rev-parse HEAD^{tree}`；
     3. API 建的 commit，其 sha 必须等于本地 HEAD 的 sha
        （对不上说明作者/日期/提交信息在传输中被改过，那就只报告、不动 ref）。

   ★ 踩过的坑：`git cat-file commit HEAD` 的返回值**不能 trim**。
     commit 对象的正文末尾有一个换行，trim 掉之后重算的 sha 会变，
     于是第 3 步的校验会拿"被截过的本地文本"去比"API 建的提交"，
     两边都截过、于是"校验通过"，而本地和远端的 commit 其实不是一个 ——
     本地显示与远端分叉，用户下一次 push 直接失败。
     第一次用这个脚本就栽在这上面，所以现在提交信息是从原始对象里**原样截取**的。

   用法：
     $env:GH_PUSH_TOKEN = '<有 repo 权限的 token>'
     node tools/push-via-api.mjs <owner/repo> [--dry]
   ============================================================ */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = process.argv[2];
const DRY = process.argv.includes('--dry');
const TOKEN = process.env.GH_PUSH_TOKEN;
if (!REPO || !TOKEN) {
  console.error('用法：GH_PUSH_TOKEN=xxx node tools/push-via-api.mjs owner/repo [--dry]');
  process.exit(2);
}

const API = 'https://api.github.com';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `token ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'companion-reader-push',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}\n${text.slice(0, 400)}`);
  return json;
}

/* ---- 本地 HEAD 的原样信息 ---- */

const headSha = git('rev-parse', 'HEAD').trim();
const headTree = git('rev-parse', 'HEAD^{tree}').trim();
const rawCommit = git('cat-file', 'commit', 'HEAD'); // ★ 不 trim

// commit 对象：头部若干行 + 空行 + 正文（正文末尾自带换行，原样保留）
const splitAt = rawCommit.indexOf('\n\n');
if (splitAt < 0) throw new Error('看不懂 commit 对象：找不到头部与正文的分界');
const rawMessage = rawCommit.slice(splitAt + 2);

const meta = git('log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI').trim().split('\n');
const [aName, aEmail, aISO, cName, cEmail, cISO] = meta;
const parents = [];
for (const line of rawCommit.split('\n')) {
  if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  if (line === '') break;
}

console.log(`本地 HEAD  ${headSha}`);
console.log(`  tree    ${headTree}`);
console.log(`  父提交  ${parents.length ? parents.join(', ') : '（根提交）'}`);
console.log(`  作者    ${aName} <${aEmail}> ${aISO}`);

/* ---- 索引里的文件清单 ---- */

const entries = git('ls-files', '-s')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const m = line.match(/^(\d{6}) ([0-9a-f]{40}) (\d+)\t(.+)$/);
    if (!m) throw new Error(`看不懂 ls-files 输出：${line}`);
    return { mode: m[1], sha: m[2], path: m[4] };
  });
console.log(`\n共 ${entries.length} 个文件`);

/* ---- 远端已有的 tree：能复用的 blob 就不重传（省额度也快得多） ---- */

const reuse = new Map();
try {
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/main`);
  const base = await api('GET', `/repos/${REPO}/git/commits/${ref.object.sha}`);
  const tree = await api('GET', `/repos/${REPO}/git/trees/${base.tree.sha}?recursive=1`);
  for (const it of tree.tree) if (it.type === 'blob') reuse.set(it.path, it.sha);
  console.log(`远端已有 ${reuse.size} 个文件，能复用的不重传`);
} catch (err) {
  console.log(`远端还没有 main 或读不到（${String(err.message).split('\n')[0]}），全部上传`);
}

const blobs = [];
let uploaded = 0;
let reused = 0;
for (const e of entries) {
  if (reuse.get(e.path) === e.sha) {
    blobs.push({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha });
    reused++;
    continue;
  }
  const bytes = readFileSync(e.path);
  const created = await api('POST', `/repos/${REPO}/git/blobs`, {
    content: bytes.toString('base64'),
    encoding: 'base64',
  });
  if (created.sha !== e.sha) {
    throw new Error(
      `内容 sha 对不上：${e.path}\n  API ${created.sha}\n  本地 ${e.sha}\n（已中止，远端未被改动）`
    );
  }
  blobs.push({ path: e.path, mode: e.mode, type: 'blob', sha: created.sha });
  uploaded++;
}
console.log(`  复用 ${reused} 个，新上传 ${uploaded} 个（每个都比对过 sha）`);

/* ---- tree ---- */

const tree = await api('POST', `/repos/${REPO}/git/trees`, { tree: blobs });
if (tree.sha !== headTree) {
  throw new Error(`tree sha 对不上：\n  API  ${tree.sha}\n  本地 ${headTree}\n（已中止）`);
}
console.log(`\n✓ tree ${tree.sha} 与本地一致`);

/* ---- commit ---- */

const commit = await api('POST', `/repos/${REPO}/git/commits`, {
  message: rawMessage, // ★ 原样，含末尾换行
  tree: tree.sha,
  parents,
  author: { name: aName, email: aEmail, date: aISO },
  committer: { name: cName, email: cEmail, date: cISO },
});
console.log(`✓ commit ${commit.sha}`);
if (commit.sha !== headSha) {
  throw new Error(
    `commit sha 与本地不一致（作者/日期/提交信息在传输中被改动了）：\n` +
      `  API  ${commit.sha}\n  本地 ${headSha}\n` +
      `（ref 没有被动；本地与远端不会分叉）`
  );
}
console.log('  与本地 HEAD 完全一致（本地与远端不会分叉）');

if (DRY) {
  console.log('\n--dry：到此为止，不动 ref');
  process.exit(0);
}

/* ---- ref ---- */

try {
  await api('POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha });
  console.log('✓ 已创建 refs/heads/main');
} catch (err) {
  if (/HTTP 422/.test(err.message)) {
    await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: true });
    console.log('✓ 已更新 refs/heads/main');
  } else {
    throw err;
  }
}

console.log(`\n完成：https://github.com/${REPO}/tree/main`);
