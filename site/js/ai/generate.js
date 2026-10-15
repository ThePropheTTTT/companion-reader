'use strict';
/* ============================================================
   陪读 · 批注与摘要生成（site/js/ai/generate.js）
   ------------------------------------------------------------
   职责只有两件：把一章正文变成「挂在段落上的短批注 + 一句话梗概」，
   把一堆章节梗概揉成全书一句话。别的都不管（不渲染、不落盘决策、不重试调度）。

   ── 四条不能破的线（改这个文件之前先读这几行）────────────────────────
   1. 只依赖 model.js / store.js / runtime.js。不碰 DOM、模块顶层不碰
      IndexedDB、不发任何网络请求 —— 唯一出口是 runtime 的 chat()，那是用户
      自己配的模型。所以这个文件在 Node 里能被直接 import 跑纯逻辑测试。
   2. selectNoteParas 必须**确定性**：UI 要先拿它标出「待写位置」的骨架，
      之后 AI 再往这些位置填字。两次选择只要差一段，整章的批注就会错位。
      所以这里没有 Math.random：排序的每一个平局都有明确规则。
   3. 花钱的地方要抠。只有抽中的候选段落进 prompt（正文的 6%~20%），
      每批 ≤60 段，同一章各批的「稳定前缀」逐字节相同（prompt cache 才命中）。
   4. 批注最容易退化的方向是「这段描写很细腻」式的雨露均沾废话。三重防线：
      prompt 里用硬规矩堵（必须抓住本段一个具体细节）→ 返回后规则体检
      （passesQualityGate）→ 不合格的直接丢，**不重试**（重试比丢掉更贵，
      而且模型第二次大概率还是写废话）。
   ============================================================ */

import {
  currentModelRev, makeChapterAI, makeNote, normalizeDensity, normalizeText,
} from '../core/model.js';
import { aiKey, getChapterAI, parseAiKey, setChapterAI, store } from '../core/store.js';
import { chat, getAIConfig, parseJSON } from './runtime.js';

/* ------------------------------------------------------------------ */
/* 常量：阈值全部集中在这里，不要散进函数体                              */
/* ------------------------------------------------------------------ */

/** 密度档位 → 抽样比例（0 少 / 1 中 / 2 多），与 model.js 的 density 档位一一对应。 */
const DENSITY_RATIO = Object.freeze([0.06, 0.12, 0.2]);

/** 每章批注条数的夹取区间。下限 3 是「身边有人」的最低感受，上限 24 是不把正文挤爆。 */
const TARGET_MIN = 3;
const TARGET_MAX = 24;

/** 段落进候选的最小长度：比这更短的（「嗯。」「……」）实在聊不出东西。 */
const PARA_MIN_CHARS = 4;

/** 两条批注之间至少隔几段（pi 差）。2 = 中间至少空一段，否则批注会扎堆。 */
const PARA_GAP = 2;

/** 单次请求最多带几段。超了就分批（同一章多轮请求）。 */
const PARA_PER_CALL = 60;

/** 超长段落进 prompt 前截断到多少字（TXT 没分段时整章就是一段，不截会把上下文撑爆）。 */
const PARA_PROMPT_CHARS = 400;

/** 批注正文长度：4 / 80 是结构约束（模型明显跑偏就丢），6 是质量下限（见 passesQualityGate）。 */
const NOTE_MIN_CHARS = 4;
const NOTE_MAX_CHARS = 80;
const NOTE_GATE_MIN_CHARS = 6;

/** 与原文的字符 bigram 重合率超过它，就认定这条批注在复述原句。 */
const RESTATE_RATIO = 0.7;

/** 梗概的硬上限：模型偶尔会写一篇小作文，超了截断（梗概要塞进下一章的 prompt）。 */
const DIGEST_MAX_CHARS = 160;

/** 出场人物最多记几个。只用来给下一章当前情上下文，不需要全。 */
const MAX_CHARACTERS = 12;

/** 人物名的长度上限，挡住模型把一整句塞进 characters 里。 */
const MAX_CHARACTER_CHARS = 12;

/** 批注类型白名单。模型给了别的（或没给）一律按 quip 处理。 */
const NOTE_KINDS = Object.freeze(['quip', 'note', 'ask']);

/**
 * 空话黑名单：出现即丢。prompt 里也点了这些词的名，两边保持一致 ——
 * 只堵一边的话，模型会从没被点名的那一侧绕进来。
 */
const HOLLOW_WORDS = Object.freeze([
  '细腻', '生动', '精彩', '优美', '深刻', '引人入胜',
  '淋漓尽致', '跃然纸上', '值得玩味', '铺陈',
]);

/** 情绪标点：出现得多说明这一段有戏（争吵、惊呼、停顿、转折）。 */
const EMOTION_RE = /[！？…—!?]/g;

/** 对话标点：小说里带引号的段落信息量通常最大。 */
const DIALOGUE_RE = /[「」“”"]/g;

/**
 * 高频动作 / 感官词表。**这是粗略启发式**，不是分词：
 * 单字词（「看」「笑」）会误命中（「看法」也算「看」），但打分只用来排序，
 * 误命中的结果是「多给一点分」，不会产生错误输出 —— 所以不值得为它引入分词器。
 */
const ACTION_WORDS = Object.freeze([
  '走', '跑', '站', '坐', '躺', '靠', '转身', '回头', '点头', '摇头', '皱眉', '叹气',
  '开口', '低头', '抬头', '伸手', '抬手', '哼', '笑', '哭', '喊', '叫', '吼', '骂',
  '说', '问', '答', '看', '望', '盯', '听', '闻', '摸', '抓', '握', '拿', '放', '递',
  '扔', '摔', '推', '拉', '扯', '拽', '踢', '踩', '抱', '搂', '拍', '撞', '咬',
  '抖', '颤', '甩', '心跳', '呼吸', '嗓子', '眼睛', '手指', '脸', '血', '汗',
  '冷', '热', '烫', '湿', '亮', '暗', '安静', '声音', '味道', '气味', '光',
]);

/** 费用估算用的粗参数（都只是量级提示，别拿它当账单）。 */
const EST_CHARS_PER_PARA = 120;   // 中文小说一段大约多少字
const TOKENS_PER_CHAR = 0.7;      // 中文 1 字 ≈ 0.7 token（各家不同）
const CALL_OVERHEAD_TOKENS = 1200; // 每次调用固定的 system + 头部 + 输出预算
const TOKENS_PER_NOTE = 70;       // 一条批注（正文 + JSON 结构）大约多少 token
const MAX_TOKENS_PER_CALL = 8192;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/**
 * 段落的下标。优先用 para.pi（UI 也是按 pi 锚批注的），缺了才退回数组下标。
 * @param {Object} para
 * @param {number} i
 * @returns {number}
 */
function piOf(para, i) {
  const n = Number(para && para.pi);
  return Number.isFinite(n) ? n : i;
}

/** 超长文本截断（附省略号，让模型知道后面还有内容）。 */
function clip(s, max) {
  const t = String(s);
  return t.length > max ? t.slice(0, max) + '……' : t;
}

/** 统计正则命中次数（正则必须是 /g；String.match 每次都会重置 lastIndex）。 */
function countMatches(text, re) {
  const m = String(text).match(re);
  return m ? m.length : 0;
}

/** 字符 bigram 集合。中文里两个字的组合已经能代表「这句话在说什么」。 */
function bigramSet(s) {
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 批注在多大程度上是「把原句抄了一遍」：以批注自己的 bigram 为分母，
 * 落回原文的比例。方向很重要 —— 分母用原文长度的话，长段落里抄一句短句
 * 比例会很低，反而判不出来。
 * @param {string} note
 * @param {string} src 该段原文
 * @returns {number} 0..1
 */
function restateRatio(note, src) {
  if (!src || note.length < 2) return 0;
  const grams = bigramSet(note);
  if (grams.size === 0) return 0;
  const source = bigramSet(src);
  let hit = 0;
  grams.forEach((g) => { if (source.has(g)) hit++; });
  return hit / grams.size;
}

/**
 * 进度回调的统一出口。回调可能不存在（调用方不关心进度），也可能自己抛错
 * （UI 的 bug）—— 两种情况都不该把生成过程带崩。
 * @param {(p:{done:number,total:number,phase:string})=>void} [cb]
 */
function report(cb, done, total, phase) {
  if (typeof cb !== 'function') return;
  try { cb({ done, total, phase }); } catch (err) { /* UI 自己的错，不传染给生成 */ }
}

/* ------------------------------------------------------------------ */
/* 打分：为什么选这一段                                                */
/* ------------------------------------------------------------------ */

/**
 * 长度分。太短没得聊，太长批注贴不住（一段 800 字，评论挂在哪一句上都显得飘）。
 * @param {number} len
 * @returns {number} 0.3 ~ 1
 */
function lengthScore(len) {
  if (len < 12) return 0.3;                       // 短对话/短动作：能聊，但排在有内容的后面
  if (len < 24) return 0.3 + 0.7 * (len - 12) / 12;
  if (len <= 140) return 1;                       // 甜区：一段两三行，说得出细节
  if (len <= 400) return 1 - 0.55 * (len - 140) / 260;
  return 0.45;
}

/**
 * 段落打分。四项相加，权重是拍的但方向明确：长度是基本盘，
 * 对话/情绪/动作是「这段有具体东西可抓」的信号。
 * @param {string} text 已 normalize 的段落正文
 * @returns {number}
 */
function scoreParagraph(text) {
  let actions = 0;
  for (let i = 0; i < ACTION_WORDS.length; i++) {
    if (text.indexOf(ACTION_WORDS[i]) >= 0) actions++;
  }
  const dialogue = Math.min(1, countMatches(text, DIALOGUE_RE) / 2); // 一对引号才算一段对话
  const emotion = Math.min(1, countMatches(text, EMOTION_RE) / 2);
  const action = Math.min(1, actions / 3);
  return lengthScore(text.length) + 0.5 * dialogue + 0.35 * emotion + 0.45 * action;
}

/**
 * 同分时的位置打散键。
 *
 * 为什么不直接按 pi 升序做平局决胜：分值相同的段落很常见（TXT 里大段格式雷同的
 * 文本尤其明显），按 pi 升序会让同分的批注**全部挤在章首**，后面半章一条都没有。
 * 0.618…（黄金比）的小数部分序列是低差异序列：它最小的那 k 个值对应的 pi
 * 天然均匀铺满整章。它没有任何随机性 —— 同一个 pi 永远得到同一个键。
 *
 * @param {number} pi
 * @returns {number} 0..1
 */
function spreadKey(pi) {
  return (pi * 0.6180339887498949) % 1;
}

/**
 * 挑出「值得写批注」的段落下标（章内 pi，升序）。
 *
 * **必须确定性**，理由见文件头第 2 条。
 *
 * @param {Array} paras Para[]（章内全部段落，含标题/图片）
 * @param {number} density 0=少 1=中 2=多
 * @param {Object} [opt]
 * @param {number} [opt.target] 覆盖目标条数（给定后不再套 [3,24] 夹取；批量生成/测试用）
 * @returns {number[]} 升序的 pi 列表
 */
export function selectNoteParas(paras, density, opt = {}) {
  const list = Array.isArray(paras) ? paras : [];
  const d = normalizeDensity(density);
  const o = opt || {};
  if (list.length === 0) return [];

  let target;
  if (o.target !== undefined && Number.isFinite(Number(o.target))) {
    target = Math.max(0, Math.round(Number(o.target)));
  } else {
    target = Math.round(list.length * DENSITY_RATIO[d]);
    target = Math.min(TARGET_MAX, Math.max(TARGET_MIN, target));
  }
  if (target <= 0) return [];

  // 1) 收集候选。标题（h1~h4）、引文（quote）、图片（img）不挂批注：
  //    标题批注会显得像目录摘要，图片段落没有文本可供批注引用。
  const cands = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p.type !== 'p') continue;
    const text = normalizeText(p.text);
    if (text.length < PARA_MIN_CHARS) continue;
    const pi = piOf(p, i);
    cands.push({ pi, score: scoreParagraph(text), key: spreadKey(pi) });
  }
  if (cands.length === 0) return [];

  // 2) 排序：分高者先，同分按打散键（不是 pi，理由见 spreadKey 的注释）。
  //    显式给出全部比较级，不依赖 sort 的稳定性。
  cands.sort((a, b) => (b.score - a.score) || (a.key - b.key) || (a.pi - b.pi));

  // 3) 依次接受，保证任意两条之间至少隔 PARA_GAP 段。
  //    注意这里是「按固定顺序走一遍、取前 target 个被接受的」——
  //    因此 target 变大时结果一定是原来的超集（UI 上调密度不会让已有批注跳位）。
  //
  //    target 是**目标**，不是保证：短章里段落本来就少，隔段规则可能凑不满
  //    （例：4 段正文、最佳段是第 2 段，它一入选就把左右两段都挡掉了）。
  //    这时宁可少写几条 —— 为了凑够数去选一段没什么可说的正文，正是本项目
  //    最不想看到的结果。所以这里不做回溯、不去求最大独立集。
  const picked = [];
  for (let i = 0; i < cands.length && picked.length < target; i++) {
    const pi = cands[i].pi;
    let ok = true;
    for (let j = 0; j < picked.length; j++) {
      if (Math.abs(pi - picked[j]) < PARA_GAP) { ok = false; break; }
    }
    if (ok) picked.push(pi);
  }

  picked.sort((a, b) => a - b);
  return picked;
}

/**
 * 批注质量闸门：一条批注能不能留下来。**导出是为了让测试和 UI 预览能直接调它。**
 *
 * 三道体检（顺序有意为之：便宜的、最能说明问题的放前面）：
 *   a. 太短（< 6 字）—— 「好。」「有意思。」这类没有信息量。
 *   b. 空洞词 —— 「细腻/生动/精彩…」是雨露均沾废话的指纹，出现即整条丢。
 *   c. 纯复述 —— 与原文 bigram 重合率 > 0.7，说明它只是把原句抄了一遍。
 *
 * @param {string} text 批注正文
 * @param {string} paraText 它所挂段落的原文
 * @returns {boolean}
 */
export function passesQualityGate(text, paraText) {
  const t = normalizeText(text);
  if (t.length < NOTE_GATE_MIN_CHARS) return false;
  for (let i = 0; i < HOLLOW_WORDS.length; i++) {
    if (t.indexOf(HOLLOW_WORDS[i]) >= 0) return false;
  }
  if (restateRatio(t, normalizeText(paraText)) > RESTATE_RATIO) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

/**
 * 系统提示。**整段是常量、不做任何插值** —— 它要逐字节相同，
 * 才能在所有请求之间共享 prompt cache（差一个空格就全灭）。
 * 书信息、章节序号、前情提要都放在 user 消息里，不放在这里。
 */
const SYSTEM_PROMPT = `你是「陪读」App 里的书搭子：读者一个人看书看不进去，你坐在他旁边，陪着他读。

你的身份：一个已经读过这本书、读得比他快半章，但**绝不剧透**的朋友。
不是老师，不是书评人。不总结中心思想，不分析写作手法，不夸作者文笔好。

怎么说话：
- 一句，15~40 字，口语，像随手在微信上发出去的一句话。
- 具体。可以吐槽作者，可以说「我看到这句的时候愣了一下」，可以说你想到了什么。
- 不许出现这些词：细腻、生动、精彩、优美、深刻、引人入胜、淋漓尽致、跃然纸上、值得玩味、铺陈。

【最硬的一条规矩，没有例外】
每条批注必须抓住它所挂那一段里的一个**具体细节**：一个动作、一个词、一个物件、一个语气、一个数字。
做不到就不要写这条批注。空着，比写一句「这段写得很感人」强一百倍。

其它：
- 宁少勿滥。某一段没什么可说的就跳过；一整章只写两三条也完全可以。
- 绝不剧透：不提后文会发生什么，不提人物之后会怎样，不总结全书。
- 只根据给你的正文说话，不要编造原文里没有的设定。
- 每个段落最多写一条批注。

输出：只输出下面这个 JSON，前后不要任何解释，不要 markdown 代码块：
{"notes":[{"pi":3,"kind":"quip","text":"……"}],"summary":"……","characters":["……"]}

字段说明：
- pi：批注挂在哪一段。必须是给你的段落编号里的一个，不许自己编号、不许猜。
- kind：三选一。quip=随口一句吐槽；note=一个观察或联想；ask=抛给读者的问题。
- text：批注正文，15~40 字。
- summary：本章梗概，40 字以内一句话，不剧透。
- characters：本章出场的人物名。没有就给 []。`;

/** 全书梗概的系统提示（同样是常量，同样不插值）。 */
const BOOK_SUMMARY_SYSTEM = `你在「陪读」App 里当书搭子，现在要用一句话说清整本书讲了什么，
用来给你自己后面的对话当上下文。

要求：
- 一句话，60 字以内，中文。
- 只讲主线：谁、在什么处境、要做什么、卡在哪。
- 不评价好坏，不用「细腻/精彩/深刻/引人入胜」这类词。
- 只用给你的材料，材料里没提到的人物和情节不要编。
- 只输出这句话本身，不要引号、不要解释、不要换行。`;

/**
 * 稳定头部：同一章各批**逐字节相同**（书信息 + 章节序号 + 前情提要 + 格式说明），
 * 候选段落接在它后面。prompt cache 只认前缀，所以任何「每批会变」的东西
 * （比如本批段数）都必须放在候选段落之后。
 *
 * @param {Object} chapter
 * @param {Object} ctx
 * @returns {string}
 */
function buildStableHead(chapter, ctx) {
  const meta = (ctx && ctx.bookMeta) || {};
  const lines = [];
  const title = meta.title ? String(meta.title) : '（未命名）';
  const author = meta.author ? String(meta.author) : '';
  lines.push('《' + title + '》' + (author ? ' · ' + author : ''));

  const ch = chapter || {};
  const idx = Number.isFinite(Number(ch.index)) ? Number(ch.index)
    : (Number.isFinite(Number(ctx && ctx.chapterIndex)) ? Number(ctx.chapterIndex) : 0);
  const total = Number.isFinite(Number(ctx && ctx.chapterCount)) ? Number(ctx.chapterCount) : 0;
  lines.push('第 ' + (idx + 1) + ' 章' + (total ? ' / 共 ' + total + ' 章' : '')
    + '：' + (ch.title ? String(ch.title) : '（无标题）'));

  const prev = normalizeText(ctx && ctx.prevDigest);
  if (prev) lines.push('上一章讲了：' + prev);
  const prev2 = normalizeText(ctx && ctx.prevPrevDigest);
  if (prev2) lines.push('再往前一章：' + prev2);

  lines.push('下面是要写批注的段落，每行格式为【[段落下标] 正文】。'
    + '段落下标是这段在本章里的编号，回填时原样照抄。');
  return lines.join('\n');
}

/**
 * 拼一条 user 消息：稳定头部 + 候选段落 + 尾部叮嘱。
 * 尾部（含「本批共 N 段」）在候选段落**之后**，所以它变了也不影响缓存前缀。
 */
function buildUserMessage(head, lines, count) {
  return head + '\n' + lines.join('\n')
    + '\n\n（本批共 ' + count + ' 段。只给真有话说的段落写，宁可少写几条。）';
}

/* ------------------------------------------------------------------ */
/* 返回值清洗                                                          */
/* ------------------------------------------------------------------ */

/** 梗概归一：折成一行、去空白、超长截断。没有就返回 ''（chapterDigest 的语义）。 */
function normalizeSummary(v) {
  const s = normalizeText(v);
  if (!s) return '';
  return s.length > DIGEST_MAX_CHARS ? s.slice(0, DIGEST_MAX_CHARS) + '…' : s;
}

/** 把一批 characters 合并进 names（去重、限长、限个数）。 */
function mergeCharacters(names, from) {
  const raw = Array.isArray(from) ? from : [];
  for (let i = 0; i < raw.length && names.length < MAX_CHARACTERS; i++) {
    const name = normalizeText(raw[i]);
    if (!name || name.length > MAX_CHARACTER_CHARS) continue;
    if (names.indexOf(name) >= 0) continue;
    names.push(name);
  }
}

/**
 * 校验并构造一条批注。不合格返回 null（调用方直接丢）。
 *
 * pi 校验是这里最要紧的一件事：**模型编段落下标是它最常犯的错**，
 * 而且编出来的数字看上去完全合理。白名单之外的一律丢，
 * 宁可这一段空着，也不能把批注挂到错的段落上（挂错了比没有更糟）。
 *
 * @param {any} raw 模型返回的一条 note
 * @param {Set<number>} allowed 本批候选的 pi 集合
 * @param {Map<number,string>} textByPi pi → 段落原文（给闸门比对用）
 * @returns {Object|null} Note
 */
function normalizeNote(raw, allowed, textByPi) {
  if (!raw || typeof raw !== 'object') return null;

  // Number(null) 是 0、Number('') 也是 0 —— 不先挡掉，缺失的 pi 会变成「第 0 段」。
  if (raw.pi === undefined || raw.pi === null || raw.pi === '') return null;
  const pi = Math.round(Number(raw.pi));           // 模型有时把下标写成字符串
  if (!Number.isFinite(pi) || !allowed.has(pi)) return null;

  const text = normalizeText(raw.text);
  if (text.length < NOTE_MIN_CHARS || text.length > NOTE_MAX_CHARS) return null;

  const kind = NOTE_KINDS.indexOf(raw.kind) >= 0 ? String(raw.kind) : 'quip';
  if (!passesQualityGate(text, textByPi.get(pi) || '')) return null;

  return makeNote({ pi, kind, text });
}

/* ------------------------------------------------------------------ */
/* 生成本章批注                                                        */
/* ------------------------------------------------------------------ */

/**
 * 生成一章的 AI 产物（批注 + 梗概 + 人物）。**只调用模型，不落盘**
 * （落盘由调用方决定：写完就想存，存哪里见 saveChapterAI）。
 *
 * @param {Object} chapter Chapter
 * @param {Array} paras Para[]（章内全部段落）
 * @param {Object} [ctx]
 * @param {Object}   [ctx.bookMeta]       BookMeta
 * @param {number}   [ctx.chapterIndex]
 * @param {number}   [ctx.chapterCount]
 * @param {string}   [ctx.prevDigest]     上一章的一行梗概
 * @param {string}   [ctx.prevPrevDigest] 上上章
 * @param {AbortSignal} [ctx.signal]
 * @param {number}   [ctx.density]    opt.density 的兜底位置（两者都认）
 * @param {(p:{done:number,total:number,phase:string})=>void} [ctx.onProgress]
 * @param {Object} [opt]
 * @param {number} [opt.density]     0/1/2，默认 1
 * @param {number} [opt.target]      覆盖批注目标条数（透传给 selectNoteParas）
 * @param {number} [opt.temperature] 不传就用运行时配置里的温度
 * @param {Function} [opt.chat]      替换 runtime 的 chat（测试用通道）
 * @returns {Promise<import('../core/model.js').ChapterAI>}
 */
export async function generateChapterAI(chapter, paras, ctx, opt = {}) {
  const c = ctx || {};
  const o = opt || {};
  const list = Array.isArray(paras) ? paras : [];
  const chapterId = chapter && chapter.id !== undefined && chapter.id !== null
    ? String(chapter.id) : '';
  if (!chapterId) throw new Error('生成批注需要章节 id（chapter.id 为空）');

  // 密度：优先取 opt.density（正路），但也认 ctx.density —— UI 层把「多写点」
  // 这种跟着章节走的状态塞进 ctx 是很自然的写法，静默退回中档（1）会让人
  // 以为是模型不听话，那种 bug 很难查。
  const density = normalizeDensity(
    o.density !== undefined ? o.density : (c.density === undefined ? 1 : c.density),
  );
  const picked = selectNoteParas(list, density, o);

  // 一段候选都没有（整章是图/标题，或全是「嗯。」这种短句）：一次请求都不发。
  // 为一段没有正文的章节花钱，用户不会觉得值。
  if (picked.length === 0) {
    return makeChapterAI({ chapterId, notes: [], modelRev: currentModelRev() });
  }

  // pi → 原文。批注闸门要拿它比对「是不是在复述原句」。
  const textByPi = new Map();
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p.type !== 'p') continue;
    const text = normalizeText(p.text);
    if (text) textByPi.set(piOf(p, i), text);
  }

  const call = typeof o.chat === 'function' ? o.chat : chat;
  const head = buildStableHead(chapter, c);
  const notes = [];
  const seenPi = new Set();
  const characters = [];
  let summary = '';
  let firstError = null;
  const total = Math.ceil(picked.length / PARA_PER_CALL);

  for (let b = 0; b < total; b++) {
    // 用户取消了：不再发后续批次（已花掉的钱不追回，见下面的收尾规则）。
    if (c.signal && c.signal.aborted) break;
    report(c.onProgress, b, total, 'notes');

    const batch = picked.slice(b * PARA_PER_CALL, (b + 1) * PARA_PER_CALL);
    const allowed = new Set(batch);
    const lines = [];
    for (let i = 0; i < batch.length; i++) {
      lines.push('[' + batch[i] + '] ' + clip(textByPi.get(batch[i]) || '', PARA_PROMPT_CHARS));
    }

    let raw;
    try {
      raw = await call({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(head, lines, batch.length) },
        ],
        json: true,
        // 输出预算按候选段数给：一条批注正文加 JSON 结构约 70 token，
        // 再加梗概与人物。给紧了会被截断成半个 JSON，整批白花。
        maxTokens: Math.min(MAX_TOKENS_PER_CALL, 400 + batch.length * TOKENS_PER_NOTE),
        temperature: o.temperature,
        signal: c.signal,
        doing: '写本章批注',
      });
    } catch (err) {
      if (!firstError) firstError = err;
      continue; // 一批失败不牵连其它批
    }

    let parsed;
    try {
      parsed = parseJSON(raw, '解析本章批注');
    } catch (err) {
      if (!firstError) firstError = err;
      continue;
    }

    // 模型偶尔直接返回数组（只给 notes），也认。
    const obj = Array.isArray(parsed) ? { notes: parsed }
      : (parsed && typeof parsed === 'object' ? parsed : {});
    const rawNotes = Array.isArray(obj.notes) ? obj.notes : [];
    for (let i = 0; i < rawNotes.length; i++) {
      const note = normalizeNote(rawNotes[i], allowed, textByPi);
      if (!note) continue;
      if (seenPi.has(note.pi)) continue; // 同一段只留第一条
      seenPi.add(note.pi);
      notes.push(note);
    }
    // 多批时只认第一批的梗概：各批看到的是同一章，拼接反而更乱。
    if (!summary) summary = normalizeSummary(obj.summary);
    mergeCharacters(characters, obj.characters);
  }

  report(c.onProgress, total, total, 'notes');

  // 收尾规则（一次说清，别再改）：
  //  - 一条批注都没拿到、而且确实出过错 → 把第一个错抛出去，UI 才能提示
  //    「密钥不对 / 没网」（这时候安静返回空对象等于什么都没发生）。
  //  - 已经拿到东西 → 返回现状，不抛。用户已经为它付过钱了，
  //    而且本项目本来就认为「少写几条」比「为了凑数写废话」好。
  if (notes.length === 0 && firstError) throw firstError;
  if (notes.length === 0 && c.signal && c.signal.aborted) {
    // 被取消且颗粒无收：抛 AbortError，别让 UI 以为「生成完了，这章没什么可说的」。
    const e = new Error('已取消本章批注生成');
    e.name = 'AbortError';
    throw e;
  }

  const ai = makeChapterAI({ chapterId, notes, modelRev: currentModelRev() });
  if (summary) ai.summary = summary;
  if (characters.length) ai.characters = characters;
  return ai;
}

/* ------------------------------------------------------------------ */
/* 梗概                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一行章节梗概，给下一章当前情上下文用。没有摘要就返回 ''（不要返回「（无）」，
 * 那种占位符会被原样喂进下一章的 prompt）。
 * @param {import('../core/model.js').ChapterAI} chapterAI
 * @returns {string}
 */
export function chapterDigest(chapterAI) {
  if (!chapterAI || typeof chapterAI !== 'object') return '';
  return normalizeSummary(chapterAI.summary);
}

/**
 * 全书一句话梗概。
 *
 * 实现选择：**不重读正文**，只用已经生成的章节梗概（分层摘要）揉成一句。
 * 理由：重读全书是几百次请求，而这一步的目的是给「书搭子」一个上下文，
 * 一章梗概的信息量已经足够，且这一步只该花一次便宜模型的钱。
 *
 * 这里**不做任何缓存**：一次调用就是一次请求。缓存归调用方（把结果连同
 * 书一起存下来）。模块内缓存看着省钱，但会让用户点「重新生成」时静默无反应 ——
 * 那种省法买到的是一头雾水的用户。
 *
 * @param {import('../core/model.js').BookDoc} doc
 * @param {(p:{done:number,total:number,phase:string})=>void} [onProgress]
 * @returns {Promise<string>} 没有材料可依据时返回 ''（不发请求）
 */
export async function generateBookSummary(doc, onProgress) {
  const meta = (doc && doc.meta) || {};
  const chapters = (doc && Array.isArray(doc.chapters)) ? doc.chapters : [];
  const bookId = meta.id === undefined || meta.id === null ? '' : String(meta.id);
  const total = 2;

  report(onProgress, 0, total, 'read');
  let map = {};
  if (bookId) {
    try {
      map = await loadBookAI(bookId);
    } catch (err) {
      // 读不到已生成的梗概不算致命：顶多是这一步没有材料，下面会走「没材料就不发请求」。
      console.warn('[generate] 读取章节产物失败，全书梗概将退回书籍简介', err);
    }
  }
  report(onProgress, 1, total, 'read');

  const digests = [];
  for (let i = 0; i < chapters.length; i++) {
    const d = chapterDigest(map[chapters[i].id]);
    if (d) digests.push((i + 1) + '. ' + d); // 带章号，模型能看出先后顺序
  }
  const blurb = normalizeText(meta.description);

  // 既没有章节梗概、书里也没有简介 → 手上没有任何材料。编出来的东西不如不给。
  if (digests.length === 0 && !blurb) return '';

  const head = '《' + (meta.title ? String(meta.title) : '未命名') + '》'
    + (meta.author ? ' · ' + String(meta.author) : '');
  const body = digests.length > 0
    ? head + '\n各章梗概（按顺序）：\n' + digests.join('\n') + '\n\n请用一句话概括这本书。'
    : head + '\n书里自带的简介：' + blurb + '\n\n请用一句话概括这本书。';

  report(onProgress, 1, total, 'generate');
  const cfg = await getAIConfig();
  const text = await chat({
    messages: [
      { role: 'system', content: BOOK_SUMMARY_SYSTEM },
      { role: 'user', content: body },
    ],
    model: cfg.cheapModel || cfg.model, // 把一堆梗概揉成一句，便宜模型够用
    temperature: 0.3,                   // 梗概要稳，不要发挥
    maxTokens: 200,
    doing: '生成全书梗概',
  });
  const out = normalizeSummary(text);
  report(onProgress, total, total, 'generate');
  return out;
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 从一批 kv 键里挑出属于 bookId 的章节产物键。**纯函数，导出供测试。**
 *
 * 为什么不用 parseAiKey 直接切：store.js 的 parseAiKey 只切第一个分隔符，
 * 它保证的是「chapterId 里可以含 ':'」，**不保证 bookId 里可以含 ':'**
 * （store.test.js 里就记着这条已知限制）。而 bookId 是「文件名|字节数|mtime」，
 * 文件名带 ':' 并非不可能，所以这里用**已知的 bookId 做前缀切分**，
 * 分隔符从 store.js 的 aiKey() 来（不手写 ':' 拼接），parseAiKey 只用来复核
 * 「这个键确实是一条 AI 产物键」。
 *
 * @param {string[]} keys store.keys('ai:<bookId>:') 的结果
 * @param {string} bookId
 * @returns {Array<{key:string, chapterId:string}>}
 */
export function pickAiKeys(keys, bookId) {
  const prefix = aiKey(bookId, ''); // 'ai:<bookId>:'
  const list = Array.isArray(keys) ? keys : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const k = String(list[i]);
    if (k.indexOf(prefix) !== 0) continue;
    const chapterId = k.slice(prefix.length);
    if (!chapterId) continue;
    const parsed = parseAiKey(k);
    if (!parsed || !parsed.chapterId) continue;
    out.push({ key: k, chapterId });
  }
  return out;
}

/** 单章的读取 + 过期判定。 */
async function loadOne(bookId, chapterId) {
  const ai = await getChapterAI(bookId, chapterId);
  if (!ai || typeof ai !== 'object') return null;
  if (!Array.isArray(ai.notes)) return null;              // 结构坏了当作没有（宁可重生成）
  if (Number(ai.modelRev) !== currentModelRev()) return null; // 过期，见 loadBookAI 的注释
  return { chapterId, ai };
}

/** 并发读的上限。串行读 300 章要开 300 次事务（开书会卡），一把全并发又会在
 *  Safari 上排起几百个事务 —— 8 是这两者之间的折中。 */
const READ_CONCURRENCY = 8;

/**
 * 读出整本书已生成的 AI 产物。
 *
 * modelRev 过期的产物**跳过，但不删除**：用户可能只是把 prompt 回滚了一版，
 * 删掉就再也拿不回来了（而重生成要花钱）。
 *
 * @param {string} bookId
 * @returns {Promise<Record<string, import('../core/model.js').ChapterAI>>} chapterId → ChapterAI
 */
export async function loadBookAI(bookId) {
  const id = bookId === undefined || bookId === null ? '' : String(bookId);
  const out = {};
  if (!id) return out;

  const keys = await store.keys(aiKey(id, ''));
  const entries = pickAiKeys(keys, id);

  for (let i = 0; i < entries.length; i += READ_CONCURRENCY) {
    const tasks = [];
    const slice = entries.slice(i, i + READ_CONCURRENCY);
    for (let j = 0; j < slice.length; j++) tasks.push(loadOne(id, slice[j].chapterId));
    const rows = await Promise.all(tasks);
    for (let j = 0; j < rows.length; j++) {
      if (rows[j]) out[rows[j].chapterId] = rows[j].ai;
    }
  }
  return out;
}

/**
 * 读一章的 AI 产物。modelRev 过期的当没有（返回 null，不删）。
 * @param {string} bookId
 * @param {string} chapterId
 * @returns {Promise<import('../core/model.js').ChapterAI|null>}
 */
export async function loadChapterAI(bookId, chapterId) {
  if (bookId === undefined || bookId === null) return null;
  if (chapterId === undefined || chapterId === null) return null;
  const row = await loadOne(String(bookId), String(chapterId));
  return row ? row.ai : null;
}

/**
 * 存一章的 AI 产物。
 * @param {string} bookId
 * @param {string} chapterId
 * @param {import('../core/model.js').ChapterAI} ai
 * @returns {Promise<void>}
 */
export async function saveChapterAI(bookId, chapterId, ai) {
  // 空串要一并挡掉：store 会把 '' 当成一个合法键写下去（然后开库、报一个
  // 跟真实病因（参数丢了）毫无关系的 IndexedDB 错），错误信息要指向调用方。
  const bid = bookId === undefined || bookId === null ? '' : String(bookId);
  const cid = chapterId === undefined || chapterId === null ? '' : String(chapterId);
  if (!bid || !cid) throw new Error('保存批注需要 bookId 与 chapterId（当前为空）');
  if (!ai || typeof ai !== 'object') throw new Error('保存批注需要一个 ChapterAI 对象');
  await setChapterAI(bid, cid, ai);
}

/**
 * 清掉整本书的 AI 产物（重新生成整本、或用户要求「忘掉这本书的批注」时用）。
 * @param {string} bookId
 * @returns {Promise<void>}
 */
export async function clearChapterAI(bookId) {
  const id = bookId === undefined || bookId === null ? '' : String(bookId);
  if (!id) return;
  const keys = await store.keys(aiKey(id, ''));
  const entries = pickAiKeys(keys, id);
  if (entries.length === 0) return;
  const toDel = [];
  for (let i = 0; i < entries.length; i++) toDel.push(entries[i].key);
  await store.del(toDel);
}

/* ------------------------------------------------------------------ */
/* 费用估算                                                            */
/* ------------------------------------------------------------------ */

/**
 * 粗略估算要花多少钱（界面提示用，别当账单）。
 *
 * @param {number} chars 正文字符数（一般传 BookMeta.charCount）
 * @param {number} [density] 0/1/2，默认 1。密度越高送进模型的段落越多。
 * @returns {{chars:number, calls:number, roughTokens:number}}
 */
export function estimateCost(chars, density) {
  const n = Math.max(0, Math.round(Number(chars) || 0));
  const d = normalizeDensity(density === undefined ? 1 : density);
  if (n === 0) return { chars: 0, calls: 0, roughTokens: 0 };

  // 关键一步：不是全文字符都进模型，只有抽中的候选段落（6%~20%）。
  // 不算这一步的话，界面会给出一个把用户吓退的十倍数字。
  const billable = n * DENSITY_RATIO[d];
  const paras = billable / EST_CHARS_PER_PARA;
  const calls = Math.max(1, Math.ceil(paras / PARA_PER_CALL));
  const roughTokens = Math.round(billable * TOKENS_PER_CHAR) + calls * CALL_OVERHEAD_TOKENS;
  return { chars: n, calls, roughTokens };
}
