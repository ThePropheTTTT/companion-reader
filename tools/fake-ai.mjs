/* ============================================================
   陪读 · 假模型服务（只用于自检，不进产品）
   ------------------------------------------------------------
   为什么必须有这个东西：

   这个产品**一半的价值在 AI 层**（预生成批注、弹幕、书搭子），但那一层的
   真正风险不在"模型答得好不好"，而在**我们自己这半边的管道**：
   请求发出去没有、返回的 JSON 解不解得开、pi 有没有对上段落、
   批注有没有画到页上、流式的字是不是一个字一个字出来的、
   以及最要紧的 —— **送出去的上下文里有没有剧透**。

   这些用真实 API 反而测不了：模型每次回答都不一样，断言就没法写死在测试里。
   所以这里起一个假服务，用确定性规则生成回答，同时把**每一个收到的请求原文
   记到 .fake-ai/requests.jsonl** —— 于是"请求里到底有没有第三章的字"
   这种事可以拿断言钉住，而不是靠读 prompt 自我安慰。

   用法：
     node tools/fake-ai.mjs            # 监听 127.0.0.1:8787
     POST /v1/chat/completions         # OpenAI 兼容；stream:true 时走 SSE
     GET  /v1/models                   # 有些客户端会先探这个
     GET  /__log                       # 把录到的请求读回来（自检用）
     POST /__reset                     # 清空记录
   ============================================================ */

import { createServer } from 'node:http';
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, '.fake-ai');
const LOG_FILE = path.join(LOG_DIR, 'requests.jsonl');
const PORT = Number(process.env.FAKE_AI_PORT || 8787);
const HOST = process.env.FAKE_AI_HOST || '127.0.0.1';

mkdirSync(LOG_DIR, { recursive: true });
if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, '', 'utf8');

/* ---------------------------- 从 prompt 里读出候选段落 ---------------------------- */

/**
 * 应用的 prompt 里，候选段落的格式是每行 `[123] 正文`。
 * 假模型就照着这个格式反解出候选集合 —— 这样它给出的 pi 一定是合法的，
 * 于是测试测的是"我们的管道"，而不是"模型会不会编下标"。
 * @returns {Array<{pi:number, text:string}>}
 */
function readCandidates(text) {
  const out = [];
  const re = /^\[(\d+)\]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({ pi: Number(m[1]), text: m[2].trim() });
  }
  return out;
}

/** 从一段中文里挑一个"具体细节"：取一个 3~5 字的片段当锚点。
 *  掐头去尾只保留汉字 —— 第一版没做这件事，取出来的片段常以标点开头
 *  （生成了「，他自己」扎心 这种弹幕），假数据太脏会掩盖真问题。 */
function detailOf(text, seed = 0) {
  const clean = String(text).replace(/[^\p{Script=Han}]/gu, '');
  if (clean.length < 4) return clean || '这一段';
  const len = clean.length >= 12 ? 4 : 3;
  const maxStart = Math.max(0, clean.length - len);
  const start = maxStart ? (seed * 7 + 2) % maxStart : 0;
  return clean.slice(start, start + len);
}

/** 批注正文：15~40 字，含一个来自该段的具体细节，不含空洞词，不复述原文 */
function noteTextFor(p, i) {
  const d = detailOf(p.text, i + 1);
  const shapes = [
    `「${d}」这半句我停了很久。`,
    `看到「${d}」的时候我想起一件不相干的事。`,
    `他这里用「${d}」，有点狠。`,
    `我盯着「${d}」看了三遍，还是觉得别扭。`,
    `「${d}」—— 这个细节太具体了，像是真发生过。`,
    `换我会把「${d}」删掉，留着反而更响。`,
  ];
  return shapes[i % shapes.length];
}

/** 弹幕正文：4~12 字，不空洞、不自指、不复述 */
function danmakuTextFor(p, i) {
  const d = detailOf(p.text, i + 1);
  const shapes = [
    `这里好安静`,
    `「${d}」扎心`,
    `我猜他撒谎了`,
    `这段我读了两遍`,
    `雨还没停啊`,
    `别回头`,
    `「${d}」记得`,
    `字迹是父亲的`,
    `这句话好重`,
    `我也有个这样的抽屉`,
    `停在这挺好`,
  ];
  return shapes[i % shapes.length];
}

/* ---------------------------- 造回答 ---------------------------- */

function looksLikeDanmaku(system, user) {
  return /弹幕/.test(system) || /"items"/.test(user) || /"items"/.test(system);
}

function looksLikeBookSummary(system) {
  return /整本书讲了什么/.test(system) || /一句话说清整本书/.test(system);
}

function looksLikeRecap(system) {
  return /梗概|讲了什么|一句话/.test(system) && /章/.test(system);
}

/** 应用要的是 json_object；假模型必须返回**合法 JSON**，否则测的是解析器的容错而不是管道 */
function buildJsonAnswer(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const cands = readCandidates(user);

  if (looksLikeDanmaku(system, user)) {
    const picked = cands.filter((_, i) => i % 3 === 1).slice(0, 6);
    const items = picked.map((p, i) => ({
      pi: p.pi,
      text: danmakuTextFor(p, i),
      kind: ['react', 'laugh', 'ask', 'warn', 'awe'][i % 5],
    }));
    return JSON.stringify({ items });
  }

  // 默认按"批注生成"处理
  const picked = cands.filter((_, i) => i % 3 === 0).slice(0, 4);
  const notes = picked.map((p, i) => ({
    pi: p.pi,
    kind: ['quip', 'note', 'ask'][i % 3],
    text: noteTextFor(p, i),
  }));
  return JSON.stringify({
    notes,
    summary: '这一章里他把伞留在门口，自己站在屋檐下等一个人。',
    characters: ['他', '那人'],
  });
}

function buildTextAnswer(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  if (looksLikeBookSummary(system) || looksLikeRecap(system)) {
    return '一个人回到旧屋翻出父亲的账本，想弄清一笔说不通的支出。';
  }
  // 书搭子对话：口语、短、只谈已经给到它的内容
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const q = String(lastUser?.content || '');
  if (/谁/.test(q)) return '账本上那个名字，前面出现过一次，就在他数呼吸那段。';
  if (/无聊|没意思/.test(q)) return '那就先跳过这两页。我陪你把后面那段读完再说。';
  if (/猜|后面/.test(q)) return '我猜那笔理发钱不是他自己花的。别的我也没读到。';
  return '我看到那句的时候也停了一下。伞留在门口，这个动作比说什么都清楚。';
}

/* ---------------------------- HTTP ---------------------------- */

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 4e6) req.destroy();
    });
    req.on('end', () => resolve(s));
  });
}

function record(entry) {
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  /* CORS 必须处理，而且必须处理 OPTIONS 预检。
     浏览器的 fetch 带 `authorization` 头时一定先发预检，服务端不回
     Access-Control-Allow-Headers 就直接被拦掉 —— 表现是页面里
     "连不上模型服务……对方不允许浏览器跨域（CORS）"。
     第一次跑 smoke 时就是栽在这里：假服务没回 CORS，AI 段全线失败。
     （顺带证明应用那条 CORS 错误提示是准确的、指向也对。） */
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, accept',
    'access-control-max-age': '600',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__log') {
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(lines));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__reset') {
    writeFileSync(LOG_FILE, '', 'utf8');
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-peidu', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(url.pathname)) {
    res.writeHead(404, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  const raw = await readBody(req);
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const wantsJson = payload.response_format?.type === 'json_object';
  const stream = payload.stream === true;
  const answer = wantsJson ? buildJsonAnswer(messages) : buildTextAnswer(messages);

  record({
    at: Date.now(),
    model: payload.model || '',
    stream,
    json: wantsJson,
    auth: req.headers.authorization ? String(req.headers.authorization).slice(0, 14) + '…' : '',
    messages,
    // 把"我给出去的回答"也记下来：自检要靠它比对
    // 「模型给了几条批注」和「应用留下了几条」—— 差得多就说明闸门过严或解析出错，
    // 这种问题光看页面是看不出来的（页面上只是"批注有点少"，看不出少了多少）。
    answer,
  });

  if (!stream) {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        model: payload.model || 'fake-peidu',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      })
    );
    return;
  }

  // 流式：按小块切，**故意让一个 data 行跨两个 chunk**（真网关就是这样，
  // 读取端必须自己缓冲半行 —— readSSE 里那段 buffer 逻辑就是为它写的）
  res.writeHead(200, {
    ...cors, // ★ 少一次就够呛：请求会照常到达这里（于是日志里"有请求"），
    // 但浏览器因为读不到 Allow-Origin 而把响应整个丢掉，页面上报 CORS 错。
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chars = [...answer];
  let i = 0;
  const tick = () => {
    if (i >= chars.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const piece = chars.slice(i, i + 3).join('');
    i += 3;
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;
    res.write(frame);
    setTimeout(tick, 12);
  };
  // 先发一个心跳注释行（真网关也会发），确认读取端不会把它当内容
  res.write(': ping\n\n');
  setTimeout(tick, 20);
});

server.listen(PORT, HOST, () => {
  console.log(`假模型服务在 http://${HOST}:${PORT}/v1（OpenAI 兼容，stream 支持）`);
  console.log(`请求记录 → ${path.relative(ROOT, LOG_FILE)}`);
  console.log(`把 AI 设置里的 baseURL 填成 http://${HOST}:${PORT}/v1，model 随便填。`);
});
