/* ============================================================
   陪读 · AI 运行时（key / 模型 / 调用底座）
   ------------------------------------------------------------
   这一层只管三件事，别的都不管：
     1. 密钥与模型配置从哪来（IndexedDB 的 kv，键 `ai.config`）
     2. 怎么发一次 chat 请求（OpenAI 兼容 /chat/completions，流式或整段）
     3. 出错怎么变成人话（401 说密钥、429 说限流、超时说什么）

   为什么单独一层：批注生成、弹幕、书搭子聊天都要调模型，
   但它们对「怎么调」不应该各有各的实现 —— 超时、重试、JSON 解析
   这三件事只要有两份实现，就一定会有一份漏掉某个分支。

   隐私：密钥只存在本机 IndexedDB，请求直接从浏览器发往用户填的 baseURL。
   陪读自己没有任何后端，也不上报任何东西。
   ============================================================ */

import { store } from '../core/store.js';

/** 配置键名（kv）。 */
export const AI_CONFIG_KEY = 'ai.config';

/** 预设服务商。baseURL 都指向 OpenAI 兼容的 /chat/completions。 */
export const PROVIDERS = Object.freeze({
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    cheapModel: 'deepseek-chat',
    keyHint: 'sk-…（platform.deepseek.com 里创建）',
  },
  moonshot: {
    label: '月之暗面 Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
    cheapModel: 'moonshot-v1-8k',
    keyHint: 'sk-…（platform.moonshot.cn）',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    cheapModel: 'gpt-4o-mini',
    keyHint: 'sk-…（platform.openai.com）',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseURL: '',
    model: '',
    cheapModel: '',
    keyHint: '任何 OpenAI 兼容网关的 key',
  },
});

/** 默认配置。apiKey 为空 = 没配过。 */
export function defaultAIConfig() {
  return {
    provider: 'deepseek',
    baseURL: PROVIDERS.deepseek.baseURL,
    model: PROVIDERS.deepseek.model,
    /** 粗读全书用的便宜模型（留空则与 model 相同） */
    cheapModel: PROVIDERS.deepseek.cheapModel,
    apiKey: '',
    /** 单次请求超时 ms */
    timeout: 90000,
    /** 温度：批注要有个性，但别胡说 */
    temperature: 0.8,
  };
}

/** @type {ReturnType<typeof defaultAIConfig>|null} 进程内缓存 */
let cached = null;

/** 读配置（带缓存）。 */
export async function getAIConfig() {
  if (cached) return cached;
  const saved = await store.get(AI_CONFIG_KEY, null);
  cached = Object.assign(defaultAIConfig(), saved && typeof saved === 'object' ? saved : {});
  return cached;
}

/** 写配置（只传要改的字段）。 */
export async function saveAIConfig(patch) {
  const next = Object.assign(await getAIConfig(), patch || {});
  cached = next;
  await store.set(AI_CONFIG_KEY, next);
  return next;
}

/** 配好了没有？没配就根本没有 AI 功能，UI 该引导去设置而不是报错。 */
export async function isAIConfigured() {
  const c = await getAIConfig();
  return Boolean(c.apiKey && c.baseURL && c.model);
}

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把一次失败的请求翻译成用户能照着做的话。
 * 界面层直接 `toast(err.message)` 就行，不需要再判断状态码。
 *
 * @param {Response|null} res
 * @param {string} body 响应正文（可能是 HTML 错误页）
 * @param {string} doing 正在做什么
 * @returns {Error}
 */
function httpError(res, body, doing) {
  const status = res ? res.status : 0;
  const snippet = String(body || '').slice(0, 200).replace(/\s+/g, ' ');
  let msg;
  let name = 'AIError';
  if (status === 401 || status === 403) {
    msg = '密钥不对或没权限（HTTP ' + status + '）。检查一下 AI 设置里的 API Key。';
    name = 'AIKeyError';
  } else if (status === 404) {
    msg = '接口地址或模型名找不到（HTTP 404）。检查 baseURL 是否以 /v1 结尾、模型名是否拼对。';
    name = 'AIModelError';
  } else if (status === 429) {
    msg = '请求太频繁或额度用完了（HTTP 429）。等一会儿再试，或换一个模型。';
    name = 'AIRateLimitError';
  } else if (status === 402 || /insufficient|balance|quota/i.test(snippet)) {
    msg = '账户余额不足（HTTP ' + status + '）。去服务商那边充值后再试。';
    name = 'AIBalanceError';
  } else if (status >= 500) {
    msg = '服务商那边出错了（HTTP ' + status + '）。这通常不是你的问题，等会儿再试。';
  } else {
    msg = (doing ? doing + '失败' : '请求失败') + '：HTTP ' + status + (snippet ? ' ' + snippet : '');
  }
  const err = new Error(msg);
  err.name = name;
  err.status = status;
  return err;
}

/** AbortError → 中文；其余原样。 */
function normalizeError(err, doing) {
  if (err && (err.name === 'AbortError' || err.code === 20)) {
    const e = new Error((doing ? doing + '超时' : '请求超时') + '：模型太久没回应。可以把设置里的超时调大，或换个更快的模型/更短的段落。');
    e.name = 'AITimeoutError';
    e.cause = err;
    return e;
  }
  if (err && err.name === 'TypeError' && /fetch|network|Failed/i.test(String(err.message))) {
    const e = new Error('连不上模型服务：可能是断网、baseURL 写错，或对方不允许浏览器跨域（CORS）。' +
      'DeepSeek / Kimi / OpenAI 官方接口都允许浏览器直连。');
    e.name = 'AINetworkError';
    e.cause = err;
    return e;
  }
  return err;
}

/* ------------------------------------------------------------------ */
/* 调用                                                                */
/* ------------------------------------------------------------------ */

/**
 * 发一次 chat 请求，返回完整文本。
 *
 * `messages` 用 OpenAI 的格式：[{role:'system'|'user'|'assistant', content:'…'}]。
 * 想拿 JSON 就用 `json: true`：会带上 response_format，并且**在解析失败时报错而不是返回半截**。
 *
 * @param {Object} p
 * @param {Array<{role:string, content:string}>} p.messages
 * @param {string} [p.model]        覆盖配置里的模型（粗读用便宜模型）
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {boolean} [p.json]        要求返回 JSON 对象
 * @param {AbortSignal} [p.signal]  外部取消
 * @param {string} [p.doing]        错误文案里「正在做什么」
 * @param {(delta:string, full:string)=>void} [p.onDelta] 流式回调；给了就走 SSE
 * @returns {Promise<string>}
 */
export async function chat(p) {
  const cfg = await getAIConfig();
  if (!cfg.apiKey) {
    const e = new Error('还没填 API Key。打开右上角的 AI 设置填一下就能用了。');
    e.name = 'AIKeyError';
    throw e;
  }
  const base = String(cfg.baseURL || '').replace(/\/+$/, '');
  if (!base) {
    const e = new Error('AI 设置里没有接口地址（baseURL）。');
    e.name = 'AIModelError';
    throw e;
  }
  const model = p.model || (cfg.model || '');
  if (!model) {
    const e = new Error('AI 设置里没有模型名。');
    e.name = 'AIModelError';
    throw e;
  }

  const doing = p.doing || 'AI 请求';
  const stream = typeof p.onDelta === 'function';
  const body = {
    model,
    messages: p.messages,
    temperature: p.temperature === undefined ? cfg.temperature : p.temperature,
    stream: stream || undefined,
  };
  if (p.maxTokens) body.max_tokens = p.maxTokens;
  if (p.json) body.response_format = { type: 'json_object' };

  // 超时用 AbortController 自己管（fetch 没有 timeout 选项）。
  // 外部 signal 也要能中断：两者合成一个。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(cfg.timeout) || 90000);
  const onOuterAbort = () => ac.abort();
  if (p.signal) {
    if (p.signal.aborted) ac.abort();
    else p.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (p.signal) p.signal.removeEventListener('abort', onOuterAbort);
    throw normalizeError(err, doing);
  }

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* 读不出来就算了，状态码已经够定位 */
    }
    clearTimeout(timer);
    if (p.signal) p.signal.removeEventListener('abort', onOuterAbort);
    throw httpError(res, text, doing);
  }

  try {
    const text = stream ? await readSSE(res, p.onDelta) : await readWhole(res);
    if (!text) {
      const e = new Error(doing + '返回了空内容。可以再试一次，或把段落选短一点。');
      e.name = 'AIEmptyError';
      throw e;
    }
    return text;
  } catch (err) {
    throw normalizeError(err, doing);
  } finally {
    clearTimeout(timer);
    if (p.signal) p.signal.removeEventListener('abort', onOuterAbort);
  }
}

/** 非流式：一次读完，顺带兼容个别网关不返回 choices[0].message 的情况。 */
async function readWhole(res) {
  const data = await res.json().catch(() => null);
  const choice = data && data.choices && data.choices[0];
  if (!choice) {
    const e = new Error('模型返回的格式看不懂（没有 choices）。');
    e.name = 'AIFormatError';
    e.detail = data;
    throw e;
  }
  return String((choice.message && choice.message.content) || choice.text || '');
}

/**
 * 流式：解析 SSE。
 * 关键点：一个 chunk 里可能有半行 JSON（TCP 分包不按行切），
 * 所以必须维护 buffer，只处理完整的 `data:` 行，残段留到下一轮。
 */
async function readSSE(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || ''; // 最后一段可能是半行，留着
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(':')) continue; // 空行 / 心跳注释
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue; // 半行/坏行：跳过，别让一个坏 chunk 毁掉整段输出
      }
      const choice = obj.choices && obj.choices[0];
      const delta = choice && ((choice.delta && choice.delta.content) || choice.text);
      if (delta) {
        full += delta;
        onDelta(delta, full);
      }
    }
  }
  return full;
}

/* ------------------------------------------------------------------ */
/* JSON 解析                                                           */
/* ------------------------------------------------------------------ */

/**
 * 从模型输出里抠出 JSON。模型很爱加 ```` ```json ```` 围栏或前后废话，
 * 所以按「先去围栏 → 直接 parse → 退而求其次找第一个 { 到最后一个 }」三步走。
 *
 * @param {string} text
 * @param {string} doing 出错文案
 * @returns {any}
 */
export function parseJSON(text, doing = '解析模型输出') {
  let s = String(text || '').trim();

  // 1) 去掉 markdown 围栏
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  // 2) 直接试
  try {
    return JSON.parse(s);
  } catch {
    /* 继续 */
  }

  // 3) 截取最外层的 {…} 或 […]
  const first = s.search(/[{[]/);
  if (first >= 0) {
    const lastBrace = s.lastIndexOf('}');
    const lastBracket = s.lastIndexOf(']');
    const last = Math.max(lastBrace, lastBracket);
    if (last > first) {
      const slice = s.slice(first, last + 1);
      try {
        return JSON.parse(slice);
      } catch {
        /* 继续 */
      }
    }
  }

  const e = new Error(doing + '失败：模型没按要求返回 JSON。再试一次通常就好了。');
  e.name = 'AIFormatError';
  e.raw = String(text || '').slice(0, 500);
  throw e;
}

/**
 * 探活：拿最便宜的一次请求验证「密钥 + baseURL + 模型名」三件套是通的。
 * 设置面板里的「测试连接」按钮用它。
 *
 * @returns {Promise<{ok:true, text:string, ms:number}>}
 */
export async function testConnection() {
  const t0 = Date.now();
  const cfg = await getAIConfig();
  const text = await chat({
    messages: [
      { role: 'system', content: '你是一个测试用的回声机器人。' },
      { role: 'user', content: '只回四个字：连接正常' },
    ],
    model: cfg.cheapModel || cfg.model,
    temperature: 0,
    maxTokens: 16,
    doing: '测试连接',
  });
  return { ok: true, text: String(text).trim(), ms: Date.now() - t0 };
}
