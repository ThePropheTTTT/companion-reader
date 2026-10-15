// @ts-check
/**
 * 中文语义锚点 —— 纯逻辑，不碰 DOM，零依赖。
 *
 * 思路：给每个「小句」一个视觉落点。锚点只落在**词**的开头，绝不落在词中间，
 * 否则加粗本身反而变成一种断字干扰。小句过长时按强度补第二个落点。
 *
 * 与 CONTRACT.md 第 3 节的 R1..R7 一一对应，实现说明见各常量上方注释。
 */

/**
 * @typedef {import('./model.js').Strength} Strength
 * @typedef {import('./model.js').AnchorRange} AnchorRange
 * @typedef {{t:'text'|'head', v:string}} AnchorToken
 * @typedef {{start:number, end:number, text:string, han:boolean}} Word
 */

/* ============================================================
   0. 字符与标点
   ============================================================ */

/** 汉字（含扩展区） */
const RE_HAN = /\p{Script=Han}/u;
/** 拉丁字母 / 数字 / 半角标点 —— 用来识别「英文词」 */
const RE_ASCII_CHAR = /[A-Za-z0-9_'-]/;
const NON_HAN = /[^\p{Script=Han}]/u;

/** 小句边界标点。取「至少含」的并集再补几个中文常见的。 */
const CLAUSE_PUNCT = new Set([
  ...'。！？；：，、…—～·!?;:,',
  ...'「」『』（）〈〉《》【】〔〕',
  ...'"\'\u2018\u2019\u201c\u201d',
]);
/** 空白也算小句起点（段首、换行、全角空格） */
const SPACE = new Set([' ', '\t', '\n', '\r', '\u3000', '\u00a0', '\v', '\f']);

/** 断句后必须跳过的「包装」字符：锚点不能落在引号/括号上，得落在里面的正文 */
const WRAPPER = new Set([
  ...'「」『』（）〈〉《》【】〔〕',
  ...'\u2018\u2019\u201c\u201d',
]);

function isClausePunct(ch) {
  return CLAUSE_PUNCT.has(ch);
}
function isSpace(ch) {
  return SPACE.has(ch);
}
function isHanChar(ch) {
  return ch !== undefined && RE_HAN.test(ch);
}

/* ============================================================
   1. 词表
   ============================================================ */

/**
 * 句首连词/虚词（单字）。只在小句**起点**起作用：命中后往后挪一步再锚。
 * 注意「这/那/是/在」也在表里 —— 它们确实常作虚词，但在「这是那场」里是内容。
 * 处理办法见 pickClauseStart：只有「后面那个词也值得锚」时才让位。
 */
const LEAD_CONJ = '但并而且或则因所即若虽可又也就还使从到在于与和及被把让为以对由如倘若假除无论';

/**
 * 程度/范围副词（单字）。在句首时**弱让位**：后面紧挨着的词能锚就让给它，
 * 不能锚就自己顶上（「都怪我」锚「怪」，「都是那场」锚「都」）。
 * 和 LEAD_CONJ 分开，是因为它们后面常常直接跟虚词，硬让会把落点让丢。
 */
const ADV_1 = '都也很太才只更再';

/**
 * 句首若只有这一个字，**不让位**，直接锚它自己。
 * 指示代词「这是那场」的「这」、数词「一个人」的「一」：让位会让到
 * 「是」「个」这种更没落点的字上，反而更糟（R3 判不准就锚）。
 */
const SELF_ANCHOR_1 = '这那一其';

/**
 * 完整的连词/虚词（多字）。小句起点若整个词命中，整词跳过，锚下一个词。
 * 表里只放**真的起承接作用**的词：「这是」「那些」「这样」不进来 ——
 * 它们多半是主语，锚上去是有意义的（见 R3「判不准时倾向锚它」）。
 */
const CONJ_WORD = new Set([
  // 转折 / 递进 / 并列
  '但是', '不但', '不仅', '并且', '而且', '而况', '况且', '何况',
  '而是', '反而', '反倒', '反之', '以及', '与其', '不如', '宁可',
  // 条件 / 假设
  '如果', '如若', '倘若', '假如', '假使', '要是', '一旦', '万一',
  '只要', '只有', '除非', '无论', '不论', '不管', '哪怕',
  // 因果 / 承接
  '因为', '因此', '因而', '所以', '由于', '于是', '然后', '然而',
  '从而', '进而', '总之', '终于',
  // 让步 / 转折
  '虽然', '虽说', '即使', '即便', '尽管', '不过', '不然', '否则',
  '可是', '只是', '还是', '同时', '此外', '另外',
  // 介词性整词：形状是虚词，落点很差，让位给后面的实词
  '在于', '为了', '关于', '对于', '至于', '根据', '按照', '随着',
  '通过', '经过', '除了', '直到', '基于', '鉴于', '针对', '凭着',
]);

/** 单字虚词 —— 不能当锚点，也用来判断「让位之后那一格是不是空的」 */
const FUNC_1 = new Set(
  [...'的了着过地得吗呢吧啊呀哦嗯嘛啦之乎者也矣焉哉把被给让使向往'] +
    [...'就都也还又才只更很太最来去起见所与及或而则并且但却'] +
    [...'的一是不在和有为以对从到于由如倘若假除无论这那其若'] +
    [...'于乎矣兮则乃尔焉'],
);

/** 常见单字实词 —— 单字词只有在白名单里才算「实词候选」 */
const CONTENT_1 = new Set(
  [...'人天年月日时分秒'] +
    [...'说看想问走跑飞站坐卧哭笑喊叫听读写画唱跳'] +
    [...'吃喝穿住买卖用做作拿放给送拉推打开关'] +
    [...'心手眼耳口鼻头身足力气血骨肉脸嘴牙'] +
    [...'山水火土金石木草花鸟鱼虫风雨雪云光'] +
    [...'国城家村路桥门车船窗墙田河海'] +
    [...'书字画歌诗词文章句纸笔'] +
    [...'真爱恨怒喜悲苦乐痛怕'] +
    [...'生死老病梦命魂神鬼'] +
    [...'东西南北上下左右前后里外中'] +
    [...'多少高低长短大小多少新旧'] +
    [...'一二三四五六七八九十百千万亿'] +
    [...'件个只条位名次场回种样'] +
    [...'你我他她它谁'],
    // 「是能有要会想该」这类**轻动词**故意不收：补位时锚在「是」上很难看
    // （「问题【是】分词的边界」），让位链本来就够用。
);

/* ============================================================
   2. 分词
   ============================================================ */

/** @type {Intl.Segmenter|null|undefined} undefined = 还没探测过 */
let cachedSegmenter;

/**
 * 构造并缓存 Segmenter。缓存是必须的：每次 new 大约 1ms 量级，
 * 而一段文本要分词一次，滑动重排会非常频繁。
 * 不支持的运行时（老 Safari / 被裁剪的引擎）返回 null，走启发式。
 */
function getSegmenter() {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  cachedSegmenter = null;
  try {
    const seg = /** @type {any} */ (globalThis.Intl)?.Segmenter;
    if (typeof seg === 'function') {
      cachedSegmenter = new seg('zh', { granularity: 'word' });
    }
  } catch {
    cachedSegmenter = null; // 构造失败当作不支持
  }
  return cachedSegmenter;
}

/**
 * 把一个分段再按「汉字 / 非汉字」切开，保证锚点不会落在 100 元 的「元」上，
 * 也不会落在 Kindle 的 0 号位上（中文正文里英文词整词加粗更自然）。
 * @param {number} base 分段在原文里的绝对起点
 * @param {string} chunk 分段本身
 * @returns {Word[]}
 */
function splitRuns(base, chunk) {
  /** @type {Word[]} */
  const out = [];
  /** @type {Word|null} */
  let cur = null;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    const han = isHanChar(ch);
    if (cur && cur.han === han) {
      cur.end = base + i + 1;
      // chunk 是**局部**串，切片必须用相对下标（base 是绝对起点）
      cur.text = chunk.slice(cur.start - base, i + 1);
    } else {
      cur = { start: base + i, end: base + i + 1, text: ch, han };
      out.push(cur);
    }
  }
  return out;
}

/**
 * 分词。有 Segmenter 就用它；没有（或抛错）退化成
 * 「连续汉字串当词 + 连续 ASCII 串当词」。
 * @param {string} text
 * @returns {Word[]}
 */
function tokenize(text) {
  /** @type {Word[]} */
  const words = [];
  const seg = getSegmenter();
  if (seg) {
    try {
      for (const part of seg.segment(text)) {
        if (!part.isWordLike) continue;
        const start = /** @type {any} */ (part).index;
        const chunk = /** @type {any} */ (part).segment;
        for (const w of splitRuns(start, chunk)) words.push(w);
      }
      return words;
    } catch {
      cachedSegmenter = null; // 这个运行时靠不住，后续一律走启发式
    }
  }
  // 启发式：汉字连排即一个词，ASCII 连排即一个词
  /** @type {Word|null} */
  let cur = null;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    const han = isHanChar(ch);
    const ascii = ch !== undefined && RE_ASCII_CHAR.test(ch);
    if (cur && ((han && cur.han) || (ascii && !cur.han))) {
      cur.end = i + 1;
      cur.text = text.slice(cur.start, cur.end);
    } else {
      cur = undefined;
      if (han || ascii) {
        cur = { start: i, end: i + 1, text: ch, han };
        words.push(cur);
      }
    }
  }
  return words;
}

/* ============================================================
   3. 判定：这个词配不配当锚点
   ============================================================ */

/** 纯汉字的多字词，若整词是连词 → 跳过。 */
function isPureConjWord(w) {
  return w.han && CONJ_WORD.has(w.text);
}

/** 小句起点：这个词能不能当本小句的第一个锚点 */
function isClauseAnchor(w) {
  if (!w.han) return false;
  if (isPureConjWord(w)) return false;
  if (w.text.length === 1) return !FUNC_1.has(w.text);
  return true; // 分词器给出多字汉字词，本身就是一个内容单位
}

/** 补位锚点：条件比小句起点严 —— 落错了不如不落 */
function isSupplementAnchor(w) {
  if (!w.han) return false;
  if (w.text.length === 1) return CONTENT_1.has(w.text);
  if (isPureConjWord(w)) return false;
  return !FUNC_1.has(w.text[0]); // 「在这」「那些」「这样」不补
}

/* ============================================================
   4. 小句起点
   ============================================================ */

/**
 * 判断 text[i] 是不是一个新小句的第一个字符。
 * 规则：段首 / 空白后 / 分句标点后（引号括号只算包装，往里看一层）。
 * @param {string} text
 * @param {number} i
 */
function isClauseStart(text, i) {
  if (i <= 0) return true;
  let j = i - 1;
  while (j >= 0 && WRAPPER.has(text[j])) j--;
  if (j < 0) return true;
  const prev = text[j];
  return isSpace(prev) || isClausePunct(prev);
}

/**
 * 从 cur 往后能不能「紧邻」接到 nxt：中间没有别的词，最多只隔着引号/括号。
 * 让位链必须能跨过包装字符 —— 「一旦把「浮士德」劈成两半」里，
 * 「把」和它管的名词之间隔着一对引号，不跨过去整句就留白了。
 * @param {string} text
 * @param {Word} cur
 * @param {Word|undefined} nxt
 */
function reaches(text, cur, nxt) {
  if (!nxt || !nxt.han || nxt.start < cur.end) return false;
  for (let i = cur.end; i < nxt.start; i++) {
    if (!WRAPPER.has(text[i])) return false;
  }
  return true;
}

/**
 * 小句起点取哪个词。返回值即「就锚这个词」，-1 表示这个小句留白。
 *
 * 三种情形：
 *  1. 起点是实词（或分词器给出的多字词）→ 锚它自己。
 *     「最后一句」锚「最」；「这是那场」锚「这」—— 这/那 在表里是虚词，
 *     但这里是主语，R3 说判不准就锚（漏锚比锚错更糟）。
 *  2. 起点是连词/介词（强让位）→ 顺着**紧邻**的词往后让，可以连锁穿过别的连词，
 *     落到第一个实词上。一路让到标点、或让到最后还是连词（「因为所以，」），
 *     整个小句留白。跨标点绝不让 —— 那是下一个从句的地盘。
 *  3. 起点是单字虚词（弱让位）→ 后面紧挨着的是实词就让给它（「都怪我」锚「怪」），
 *     否则自己顶上（「都是那场」锚「都」）。
 * @param {string} text
 * @param {Word[]} words
 * @param {number} k   words 下标，即小句起点所在的那个词
 * @returns {number} words 下标；-1 表示这个小句不锚
 */
function pickClauseStart(text, words, k) {
  const here = words[k];
  if (!here.han) return k; // 英文词开头：锚它自己（调用方决定要不要用）
  const strong = isSkipWorthyConj(here);
  const weak =
    !strong &&
    here.text.length === 1 &&
    !SELF_ANCHOR_1.includes(here.text) &&
    (FUNC_1.has(here.text) || ADV_1.includes(here.text));
  if (!strong && !weak) return k;

  const nxt = words[k + 1];
  const reachable = reaches(text, here, nxt);
  if (strong && !reachable) return -1; // 连词后面接不上词：整句留白
  if (weak) return reachable && isClauseAnchor(nxt) ? k + 1 : k;

  let j = k;
  for (let step = 0; step < 6; step++) {
    if (!isSkipWorthyConj(words[j])) break;
    const n = words[j + 1];
    if (!reaches(text, words[j], n)) break;
    if (!isClauseAnchor(n) && !isSkipWorthyConj(n)) break;
    j++;
  }
  if (j === k) return -1; // 让位链没动（后面接的是虚词）：整句留白
  return isClauseAnchor(words[j]) ? j : -1; // 停在连词上：整句留白
}

/** 是否是「该让位」的句首连词 */
function isSkipWorthyConj(w) {
  if (!w.han) return false;
  if (CONJ_WORD.has(w.text)) return true;
  return w.text.length === 1 && LEAD_CONJ.includes(w.text);
}

/* ============================================================
   5. 密度
   ============================================================ */

/** 目标间隔（字）。下标 = strength，数字越小锚点越密。 */
const TARGET_GAP = [18, 14, 12, 10, 8];

/** 归一化强度：夹到 0..4，非数字按默认 2 */
function normalizeStrength(strength) {
  const n = typeof strength === 'number' ? strength : Number(strength);
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(4, Math.trunc(n)));
}

/**
 * R5：本词和上一个已选中锚点之间至少隔 4 个字。
 * 只往前看 —— 往后那一段在选中下一个锚点时会再判一次，补位则两头都判。
 */
function gapOk(last, w) {
  return !last || w.start - last.end >= 4;
}

/** 补位搜索窗口：以目标位置为中心，前后各看几个**词**（R4 的 ±3 个词）。 */
const FILL_WINDOW = 3;

/** words 里第一个 start >= want 的下标（二分）。 */
function wordIndexNear(words, want) {
  let lo = 0;
  let hi = words.length - 1;
  let at = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start >= want) {
      at = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return Math.max(0, at);
}

/**
 * 在 [floor, ceil] 区间里、以 want 为中心前后 FILL_WINDOW 个词的窗口中，
 * 挑离 want 最近的一个「可补位实词」。
 * 窗口里没有合格的返回 null —— 搜不到就不补（R4）。
 * @param {Word[]} words
 * @param {Uint8Array} fillable 与 words 等长的标记
 * @param {number} want
 * @param {number} floor 允许的最左 start
 * @param {number} ceil  允许的最右 start
 * @returns {Word|null}
 */
function pickNearby(words, fillable, want, floor, ceil) {
  const c = wordIndexNear(words, want);
  const from = Math.max(0, c - FILL_WINDOW);
  const to = Math.min(words.length - 1, c + FILL_WINDOW);
  let best = null;
  let bestD = Infinity;
  for (let i = from; i <= to; i++) {
    if (!fillable[i]) continue;
    const w = words[i];
    if (w.start < floor || w.start > ceil) continue;
    const d = Math.abs(w.start - want);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

/**
 * 补位：从某个锚点往后，凡是出现超过 N 字的空白，就在第 N 字附近补一个实词锚点。
 * 两头都要留出 R5 的 4 字间距，找不到合适的就**不补**（R4：宁可留白，不硬凑）。
 * @param {Array<{w:Word, from:number, kind:number}>} picked
 * @param {Word[]} words
 * @param {Uint8Array} fillable
 * @param {number} N
 */
function fillGaps(picked, words, fillable, N) {
  const minFromPrev = Math.max(4, Math.ceil(N / 2)); // 离上一个锚点至少这么远
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;
    for (let i = 0; i < picked.length; i++) {
      const prev = picked[i];
      const next = picked[i + 1];
      const spanEnd = next ? next.w.start : Infinity;
      if (prev.w.end + N >= spanEnd) continue; // 这段够密了
      const want = prev.w.end + N;
      const floor = prev.w.end + minFromPrev;
      // 锚点是词首：end 至少是 start+1，所以 start 要 ≤ 下一锚点 - 5 才留得下 4 字
      const ceil = Number.isFinite(spanEnd) ? spanEnd - 5 : Infinity;
      const w = pickNearby(words, fillable, want, floor, ceil);
      if (!w) continue;
      picked.splice(i + 1, 0, { w, from: -1, kind: 2 });
      changed = true;
    }
    if (!changed) break;
  }
}

/* ============================================================
   6. 主流程
   ============================================================ */

/**
 * 算出可锚的词（给出 start/end），内部统一入口。
 * 锚点区间 = 词首一个字符（汉字）或整个 ASCII 词。
 * @param {string} text
 * @param {Strength} strength
 * @returns {Word[]}
 */
function planAnchors(text, strength) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const words = tokenize(text);
  if (words.length === 0) return [];
  // 整段没有汉字（纯英文/数字/标点）→ 不锚，交给调用方（R7）
  let hasHan = false;
  for (const w of words) {
    if (w.han) {
      hasHan = true;
      break;
    }
  }
  if (!hasHan) return [];

  const N = TARGET_GAP[normalizeStrength(strength)];

  /** 每个小句起点只取一次：words 里第一个 start >= 该小句首字符位置的词 */
  /** @type {Array<{w:Word, from:number, kind:number}>} */
  const picked = [];
  /** 补位候选（只收实词）的等长标记 */
  const fillable = new Uint8Array(words.length);
  for (let i = 0; i < words.length; i++) {
    if (isSupplementAnchor(words[i])) fillable[i] = 1;
  }

  /** @type {Word|null} */
  let last = null;
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    if (!isClauseStart(text, i)) continue;
    // 引号/括号本身不是词首，跳过它们找里面第一个词
    while (k < words.length && words[k].start < i) k++;
    if (k >= words.length) break;
    if (words[k].start !== i) continue; // 这一格不是词首（落在词中间），不锚
    if (isClausePunct(text[i]) || isSpace(text[i])) continue;

    const idx = pickClauseStart(text, words, k);
    if (idx < 0) continue; // 整个小句都是连词：「因为所以，」留白
    const w = words[idx];
    if (w.han) {
      if (!gapOk(last, w)) continue;
    } else {
      // 英文词：整词当锚点，太窄（单字母）就不锚
      if (w.end - w.start < 2) continue;
      if (!gapOk(last, w)) continue;
    }
    picked.push({ w, from: -1, kind: 1 });
    last = w;
  }

  if (picked.length === 0) {
    // 兜底：整段一个落点都没挑出来（唯一的小句全是连词）就锚开头第一个词。
    // 宁可锚一个连词，也好过整段没有落点（R3 的「宁锚错不漏锚」）。
    const head = words.find((w) => w.han);
    if (!head) return [];
    picked.push({ w: head, from: -1, kind: 0 });
  }
  fillGaps(picked, words, fillable, N);

  // 锚点区间：汉字恒为 1 字（R6），ASCII 整词
  return picked.map((p) => ({
    start: p.w.start,
    end: p.w.han ? p.w.start + 1 : p.w.end,
    text: p.w.han ? p.w.text[0] : p.w.text,
    han: p.w.han,
  }));
}

/* ============================================================
   7. 导出
   ============================================================ */

/**
 * 中文语义小句锚定。返回锚点区间，每段独立调用。
 * @param {string} text
 * @param {Strength} strength
 * @returns {AnchorRange[]}
 */
export function computeAnchors(text, strength) {
  const plan = planAnchors(text, strength);
  /** @type {AnchorRange[]} */
  const out = [];
  for (const w of plan) out.push({ start: w.start, end: w.end });
  return out;
}

/**
 * 把文本转成可插入 DOM 的片段描述（不碰 DOM，由渲染层消费）。
 * 与 computeAnchors 共用同一份规划，因此两者必然严格一致。
 * @param {string} text
 * @param {Strength} strength
 * @returns {AnchorToken[]}
 */
export function anchorTokens(text, strength) {
  /** @type {AnchorToken[]} */
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  const plan = planAnchors(text, strength);
  let cursor = 0;
  for (const w of plan) {
    if (w.start > cursor) out.push({ t: 'text', v: text.slice(cursor, w.start) });
    out.push({ t: 'head', v: text.slice(w.start, w.end) });
    cursor = w.end;
  }
  if (cursor < text.length) out.push({ t: 'text', v: text.slice(cursor) });
  return out;
}
