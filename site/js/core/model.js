// 陪读 — 数据结构与默认值（core/model.js）
//
// 纯常量与工厂函数。**无副作用、不碰 DOM、不发网络请求**，可直接在 Node 里 import。
// 本文件是「魔法数字」的唯一落点：业务代码里不要散落字号/padding/阈值，从这里取。
//
// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT_SETTINGS 字段表（与 CONTRACT 第 6 节的排版约束一一对应）
// ─────────────────────────────────────────────────────────────────────────────
//  排版（改了必须重新测量 + 重新分页，见 paginate.js 的已知坑 #2）
//   fontSize        number px    正文字号。默认 19
//   lineHeight      number 倍数  行高。默认 1.75（中文正文 1.7~1.8 可读性最好）
//   paraSpacing     number em    段间距，作用于 p/quote 的 margin-bottom。
//                                h1~h4 的间距另算，见 PARA_MARGIN_BLOCK_EM。默认 0.9
//   measure         number ch    行宽（每行字数）。手机竖屏 20~26，iPad 30~38。
//                                默认 22。**必须用 ch 单位**，不是固定 px，
//                                这样换字号时每行字数恒定、排版手感不变。
//   fontFamily      string       见 FONT_STACKS 的 key。默认 'serif'
//
//  主题
//   theme           string       见 THEMES 的 key。默认 'paper'
//   brightness      number 0..1  亮度遮罩，1 = 不压暗。默认 1
//
//  导航
//   pageTurnMode    string       'slide' | 'fade' | 'instant'。默认 'slide'
//   keepAwake       boolean      阅读时禁止息屏。默认 false
//
//  锚点（中文语义小句加粗）
//   anchorEnabled   boolean      锚点总开关。默认 true
//   strength        Strength     0..4，越大锚点越密（规则见 CONTRACT 第 3 节 R4）。
//                                默认 2。**改变会改变字宽 → 必须重排重分页**
//   anchorWeight    number       锚点 font-weight。默认 700
//   anchorColor     string|''    锚点颜色；'' = 继承正文色。默认 'inherit'
//                                ⚠ 绝不能加 display:inline-block / transform（CONTRACT 6）
//
//  批注（M1，AI 产物）
//   density         number 0..2  批注密度档位 [少, 中, 多] 的索引。默认 1
//   danmaku         boolean      弹幕（批注飘过）开关。默认 true
//   danmakuSpeed    number 1..3  弹幕速度档位。默认 2
//
//  横屏/大屏
//   wideMeasure     number ch    屏宽 ≥ 768px 时的行宽（iPad 30~38）。默认 34
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {'h1'|'h2'|'h3'|'h4'|'p'|'quote'|'img'} ParaType */
/** @typedef {0|1|2|3|4} Strength */

/**
 * @typedef {Object} BookMeta
 * @property {string} id
 * @property {string} title
 * @property {string} author
 * @property {string} [language]
 * @property {string} [publisher]
 * @property {string} [description]
 * @property {'epub'|'txt'} format
 * @property {number} size
 * @property {number} addedAt
 * @property {string} [cover]
 * @property {number} charCount
 * @property {number} chapterCount
 */

/** 段落类型白名单。渲染层用它决定标签，避免拼错 type 后静默变成 p。 */
export const PARA_TYPES = Object.freeze(['h1', 'h2', 'h3', 'h4', 'p', 'quote', 'img']);

/** type → 渲染用的 HTML 标签名。img 由渲染层特殊处理（要拼 URL）。 */
export const PARA_TAG = Object.freeze({
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', p: 'p', quote: 'blockquote', img: 'img',
});

/** 小标题（非首段）的上下间距，单位 em，乘 fontSize。首个小标题不加 margin-top。 */
export const PARA_MARGIN_BLOCK_EM = Object.freeze({ top: 1.6, bottom: 0.7 });

/** type → 是否按「块级小标题」处理间距。 */
export const HEADING_TYPES = Object.freeze(['h1', 'h2', 'h3', 'h4']);

/** 字体栈。serif 优先思源宋体/宋体，sans 优先苹方/系统字。 */
export const FONT_STACKS = Object.freeze({
  serif: '"Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", STSong, SimSun, serif',
  sans: '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  kai: '"Kaiti SC", KaiTi, STKaiti, "Songti SC", serif',
});

/** 主题调色板。UI 层负责把 key 映射到 CSS 变量；这里只存 key，保持模型无样式依赖。 */
export const THEMES = Object.freeze(['paper', 'sepia', 'night', 'ink']);

/** 主题 key → 中文名（设置面板展示用）。 */
export const THEME_LABEL = Object.freeze({
  paper: '纸白', sepia: '米黄', night: '夜间', ink: '墨黑',
});

/** 排版滑块的取值范围，UI 层直接据此渲染，避免 magic number 再次散落。 */
export const SETTING_RANGES = Object.freeze({
  fontSize: Object.freeze({ min: 14, max: 28, step: 1 }),
  lineHeight: Object.freeze({ min: 1.2, max: 2.4, step: 0.05 }),
  paraSpacing: Object.freeze({ min: 0, max: 2, step: 0.1 }),
  measure: Object.freeze({ min: 16, max: 44, step: 1 }),
  wideMeasure: Object.freeze({ min: 24, max: 52, step: 1 }),
  strength: Object.freeze({ min: 0, max: 4, step: 1 }),
  density: Object.freeze({ min: 0, max: 2, step: 1 }),
  danmakuSpeed: Object.freeze({ min: 1, max: 3, step: 1 }),
  brightness: Object.freeze({ min: 0.35, max: 1, step: 0.05 }),
});

/** 屏宽 ≥ 这个值时用 wideMeasure。768 = iPad 竖屏宽度。 */
export const WIDE_BREAKPOINT_PX = 768;

/** 正文默认设置。每次开新书都用它；用户改过之后整份存进 kv 的 'settings' 键。 */
export const DEFAULT_SETTINGS = Object.freeze({
  // 排版
  fontSize: 19,
  lineHeight: 1.75,
  paraSpacing: 0.9,
  measure: 22,
  wideMeasure: 34,
  fontFamily: 'serif',
  // 主题
  theme: 'paper',
  brightness: 1,
  // 导航
  pageTurnMode: 'slide',
  keepAwake: false,
  // 锚点
  anchorEnabled: true,
  strength: /** @type {Strength} */ (2),
  anchorWeight: 700,
  anchorColor: 'inherit',
  // 批注
  density: 1,
  danmaku: true,
  danmakuSpeed: 2,
});

/** 设置键名（存进 store 的 kv 仓）。 */
export const SETTINGS_KEY = 'settings';

/** 设置对象深拷贝，避免调用方改到被冻结的 DEFAULT_SETTINGS（静默失败很难查）。 */
export function cloneSettings() {
  return { ...DEFAULT_SETTINGS };
}

/** 把 v 夹到 [lo, hi]；非有限数返回 fallback。 */
export function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 锚点强度归一化到 0..4 的整数。 */
export function normalizeStrength(v) {
  return /** @type {Strength} */ (clamp(Math.round(Number(v)), 0, 4, DEFAULT_SETTINGS.strength));
}

/** 批注密度归一化到 0..2 的整数。 */
export function normalizeDensity(v) {
  return Math.round(clamp(v, 0, 2, DEFAULT_SETTINGS.density));
}

/**
 * 合并「用户已存的设置」与默认值：字段逐个校验 + 夹到合法区间。
 * 旧版本存下来的残缺设置、被手改坏的值都在这里被挡住，业务层可以放心用。
 * @param {Object} [saved]
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function mergeSettings(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const pick = (k, allowed) => (allowed.indexOf(s[k]) >= 0 ? s[k] : DEFAULT_SETTINGS[k]);
  const num = (k) => clamp(s[k], SETTING_RANGES[k].min, SETTING_RANGES[k].max, DEFAULT_SETTINGS[k]);
  return {
    fontSize: num('fontSize'),
    lineHeight: num('lineHeight'),
    paraSpacing: num('paraSpacing'),
    measure: num('measure'),
    wideMeasure: num('wideMeasure'),
    fontFamily: pick('fontFamily', Object.keys(FONT_STACKS)),
    theme: pick('theme', THEMES),
    brightness: num('brightness'),
    pageTurnMode: pick('pageTurnMode', ['slide', 'fade', 'instant']),
    keepAwake: typeof s.keepAwake === 'boolean' ? s.keepAwake : DEFAULT_SETTINGS.keepAwake,
    anchorEnabled: typeof s.anchorEnabled === 'boolean' ? s.anchorEnabled : DEFAULT_SETTINGS.anchorEnabled,
    strength: normalizeStrength(s.strength === undefined ? DEFAULT_SETTINGS.strength : s.strength),
    anchorWeight: clamp(s.anchorWeight, 400, 900, DEFAULT_SETTINGS.anchorWeight),
    anchorColor: typeof s.anchorColor === 'string' ? s.anchorColor : DEFAULT_SETTINGS.anchorColor,
    density: normalizeDensity(s.density === undefined ? DEFAULT_SETTINGS.density : s.density),
    danmaku: typeof s.danmaku === 'boolean' ? s.danmaku : DEFAULT_SETTINGS.danmaku,
    danmakuSpeed: Math.round(clamp(s.danmakuSpeed, 1, 3, DEFAULT_SETTINGS.danmakuSpeed)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 分页相关的数值（唯一落点：paginate.js 从这里 import，不要在那边硬编码）
// ─────────────────────────────────────────────────────────────────────────────

/** 分页数值配置。单位统一是 px，除 ratio 项外。 */
export const PAGINATION = Object.freeze({
  /**
   * 页高给足防线：available 至少要能放下 3 行正文，否则认为测量前提不成立
   * （容器还没布局完、reader 被 display:none、dvh 尚未解析…）。
   * packPages 是这个值的使用者；ui 层在算 available 时可直接用它做断言。
   */
  minLines: 3,

  /** 浮点容差：safari 的 offsetTop 是整数，但 lineHeight 会算出小数高度。
   *  装箱时允许 pageHeight 超出 available 这么多，避免 0.0001px 的漂移多切一页。 */
  epsilon: 0.5,

  /** 单块高度小于这个负值时判定为测量坏了（比 epsilon 宽松，允许子像素负差）。 */
  negativeSlack: -1,

  /** 视口高度变化超过这个 px 才值得重新分页（iOS 地址栏伸缩的抖动过滤）。 */
  relayoutThreshold: 24,
});

/**
 * 由实测 px 算出一页的可用高度：容器 clientHeight 减掉容器自身上下 padding。
 *
 * 为什么要减：measureBlocks 量的是**容器的 padding box** 内的内容
 * （offsetTop 相对 offsetParent 的 padding edge），如果容器自己还有 padding，
 * 那部分 padding 是量不出来的，必须在这里扣掉，否则每页都会多塞几行、末页被裁。
 *
 * 容器必须已经按最终排版样式渲染（字号/行高/行宽/锚点都套用完毕），
 * 且高度用 100dvh 而不是 100vh 算出来（CONTRACT 6）。
 *
 * @param {number} clientHeight  host.clientHeight（含 padding，不含 border/滚动条）
 * @param {number} [paddingY]    host 的上下 padding 之和，px
 * @param {number} [fontSize]    正文字号 px，用于 minLines 防线
 * @param {number} [lineHeight]  行高倍数
 * @returns {number} available px，已保证 > 0
 */
export function availableHeight(clientHeight, paddingY, fontSize, lineHeight) {
  const h = Number(clientHeight);
  if (!Number.isFinite(h)) throw new Error('容器高度不可用：clientHeight 不是有限数');
  const avail = h - (Number(paddingY) || 0);
  const fs = Number(fontSize) || DEFAULT_SETTINGS.fontSize;
  const lh = Number(lineHeight) || DEFAULT_SETTINGS.lineHeight;
  const floor = PAGINATION.minLines * fs * lh;
  if (avail < floor) {
    throw new Error('可用高度过小（' + Math.round(avail) + 'px）：容器可能尚未完成布局，或阅读区被隐藏');
  }
  return avail;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工厂函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 稳定书籍指纹。同一个文件（文件名 + 字节数 + mtime）永远得到同一个 id，
 * 所以重传同一本书能续上进度。
 *
 * ⚠ 没有转义：文件名里如果出现 '|'，理论上存在撞 id 的可能
 * （`a|1|2` + 字节数 3 与 `a` + 字节数 `1` 撞不上，但 `a|b|1` 这种要小心）。
 * 刻意不做转义：格式是 CONTRACT 第 1 节定死的，改动会让老库里的书全部失联。
 *
 * @param {string} filename
 * @param {number} byteLength
 * @param {number} lastModified  ms
 * @returns {string}
 */
export function bookIdOf(filename, byteLength, lastModified) {
  return String(filename) + '|' + String(byteLength) + '|' + String(lastModified);
}

/**
 * 结构版本号。改动解析/锚点/prompt 结构时 +1，下游（分页缓存、AI 产物）据此失效。
 * 注意：这个和 BookDoc.rev 不是一回事——BookDoc.rev 是单本书的结构版本，
 * MODEL_REV 是**模型/prompt 的全局版本**。
 *
 * @param {number} [n]
 * @returns {number}
 */
export function currentModelRev(n) {
  return n === undefined ? MODEL_REV : MODEL_REV;
}

/** AI 产物（ChapterAI.modelRev）与 prompt 的版本号。改 prompt 就 +1，旧产物会被重新生成。 */
export const MODEL_REV = 1;

/**
 * @param {Object} p
 * @param {string} [p.filename]
 * @param {number} [p.size]          字节数
 * @param {number} [p.lastModified]  ms
 * @param {string} [p.id]            直接给 id（优先于上面三个）
 * @param {string} [p.title]
 * @param {string} [p.author]
 * @param {string} [p.language]
 * @param {string} [p.publisher]
 * @param {string} [p.description]
 * @param {'epub'|'txt'} [p.format]
 * @param {number} [p.addedAt]       ms，默认 Date.now()
 * @param {string} [p.cover]         封面 data URL
 * @param {number} [p.charCount]
 * @param {number} [p.chapterCount]
 * @returns {import('./model.js').BookMeta}
 */
export function makeBookMeta(p) {
  const o = p || {};
  const filename = o.filename === undefined ? '未命名' : String(o.filename);
  const size = Number(o.size) || 0;
  const lastModified = Number(o.lastModified) || 0;
  const id = o.id ? String(o.id) : bookIdOf(filename, size, lastModified);
  const meta = {
    id,
    title: o.title ? String(o.title) : stripExt(filename),
    author: o.author ? String(o.author) : '佚名',
    format: o.format === 'txt' ? 'txt' : 'epub',
    size,
    addedAt: Number(o.addedAt) || Date.now(),
    charCount: Number(o.charCount) || 0,
    chapterCount: Number(o.chapterCount) || 0,
  };
  // 可空字段：缺省时**不写键**，保证 JSON 序列化后结构稳定（不出现 undefined 键）。
  if (o.language) meta.language = String(o.language);
  if (o.publisher) meta.publisher = String(o.publisher);
  if (o.description) meta.description = String(o.description);
  if (o.cover) meta.cover = String(o.cover);
  return meta;
}

/**
 * 章节工厂。paras 默认 **undefined**（懒解析缓存，CONTRACT 第 1 节）。
 *
 * @param {Object} p
 * @param {string} p.id
 * @param {string} [p.title]     无则回退「第 N 章」（N = index + 1）
 * @param {number} [p.index]     从 0 起
 * @param {number} [p.depth]     目录层级，0 起
 * @param {string} [p.href]
 * @param {string} [p.body]      懒解析用的原始 XHTML/文本
 * @param {Array}  [p.paras]     已解析结果（给了就填上）
 * @returns {Object} Chapter
 */
export function makeChapter(p) {
  const o = p || {};
  const index = Number.isFinite(Number(o.index)) ? Number(o.index) : 0;
  const ch = {
    id: o.id === undefined || o.id === '' ? 'c' + index : String(o.id),
    title: o.title ? String(o.title) : '第 ' + (index + 1) + ' 章',
    index,
    depth: Number(o.depth) || 0,
  };
  if (o.href !== undefined && o.href !== null) ch.href = String(o.href);
  if (o.body !== undefined) ch.body = String(o.body);
  if (Array.isArray(o.paras)) {
    ch.paras = o.paras.map((x, i) => makeParagraph(x, i));
  }
  // paras 缺省时**不写这个键**，保持 undefined —— 这是「未懒解析」的判定条件。
  return ch;
}

/**
 * 段落工厂。text 做 trim + 连续空白折叠（CONTRACT 第 1 节要求）。
 * 折叠包含全角空格：中文正文里的 U+3000 缩进由 CSS text-indent 负责，
 * 正文里残留的全角空格参与排版会让行宽跳动。
 *
 * @param {Object} p
 * @param {ParaType} [p.type]   默认 'p'，非法值回退 'p'
 * @param {string} [p.text]
 * @param {string} [p.src]      仅 img
 * @param {string} [p.alt]      仅 img
 * @param {number} [p.pi]       不给则 0；由调用方按数组下标填
 * @returns {Object} Para
 */
export function makeParagraph(p, pi) {
  const o = p || {};
  const type = PARA_TYPES.indexOf(o.type) >= 0 ? o.type : 'p';
  const para = {
    type,
    text: normalizeText(o.text),
    pi: Number.isFinite(Number(pi)) ? Number(pi) : (Number.isFinite(Number(o.pi)) ? Number(o.pi) : 0),
  };
  if (type === 'img') {
    // img 一定有 src（解析失败时退化为 ', 渲染层显示占位），alt 可缺省。
    para.src = o.src === undefined || o.src === null ? '' : String(o.src);
    if (o.alt !== undefined && o.alt !== null) para.alt = String(o.alt);
  } else if (o.alt !== undefined && o.alt !== null) {
    // 非 img 段落的 alt：EPUB 里图片降级成文字时的残留说明，保留但绝不写 src
    // （避免下游出现「有 src 的 p」这种非法组合）。
    para.alt = String(o.alt);
  }
  return para;
}

/**
 * 给整章段落重排 pi 下标（改过 paras 数组后调用，保持下标稳定）。
 * @param {Array} paras
 * @returns {Array} 同一个数组（原地改），方便链式
 */
export function reindexParas(paras) {
  for (let i = 0; i < paras.length; i++) paras[i].pi = i;
  return paras;
}

/** 章节正文的字符数（估算 AI 费用用）。空段落算 0。 */
export function countChars(paras) {
  let n = 0;
  for (let i = 0; i < paras.length; i++) {
    const t = paras[i].text;
    if (t) n += t.length;
  }
  return n;
}

/** 全书字符数 = 各章之和。chapters 里没解析的章（paras === undefined）按 0 计。 */
export function countBookChars(chapters) {
  let n = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].paras) n += countChars(chapters[i].paras);
  }
  return n;
}

/** 书籍格式判定：按扩展名。epub 之外一律 txt（CONTRACT 只定义了这两种）。 */
export function formatOf(filename) {
  return /\.epub$/i.test(String(filename)) ? 'epub' : 'txt';
}

/** 去掉扩展名的文件名，作为缺省书名。 */
export function stripExt(filename) {
  return String(filename).replace(/\.[^./\\]+$/, '') || '未命名';
}

/** trim + 折叠连续空白（含全角空格 U+3000）。 */
export function normalizeText(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/[\s\u3000]+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 进度与批注的缺省构造（存 store 的 kv，见 CONTRACT 第 1 节）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} p
 * @param {string} p.chapterId
 * @param {number} [p.pi]
 * @param {number} [p.scrollRatio]
 * @param {number} [p.percent]
 * @param {number} [p.at]
 * @returns {Object} Progress
 */
export function makeProgress(p) {
  const o = p || {};
  return {
    chapterId: o.chapterId === undefined ? '' : String(o.chapterId),
    pi: Math.max(0, Math.round(Number(o.pi) || 0)),
    scrollRatio: clamp(o.scrollRatio, 0, 1, 0),
    at: Number(o.at) || Date.now(),
    percent: clamp(o.percent, 0, 100, 0),
  };
}

/**
 * @param {Object} p
 * @param {number} [p.pi]
 * @param {'quip'|'note'|'ask'|'spoiler-free-summary'} [p.kind]
 * @param {string} [p.text]
 * @param {number} [p.likes]
 * @param {number} [p.at]
 * @returns {Object} Note
 */
export function makeNote(p) {
  const o = p || {};
  const kinds = ['quip', 'note', 'ask', 'spoiler-free-summary'];
  return {
    pi: Math.max(0, Math.round(Number(o.pi) || 0)),
    kind: kinds.indexOf(o.kind) >= 0 ? o.kind : 'quip',
    text: o.text === undefined ? '' : String(o.text),
    likes: Math.max(0, Math.round(Number(o.likes) || 0)),
    at: Number(o.at) || Date.now(),
  };
}

/**
 * @param {Object} p
 * @param {string} p.chapterId
 * @param {string} [p.summary]
 * @param {string[]} [p.characters]
 * @param {Array} [p.notes]
 * @param {number} [p.modelRev]  默认 currentModelRev()
 * @param {number} [p.at]
 * @returns {Object} ChapterAI
 */
export function makeChapterAI(p) {
  const o = p || {};
  const ai = {
    chapterId: o.chapterId === undefined ? '' : String(o.chapterId),
    notes: Array.isArray(o.notes) ? o.notes.map(makeNote) : [],
    modelRev: Number.isFinite(Number(o.modelRev)) ? Number(o.modelRev) : currentModelRev(),
    at: Number(o.at) || Date.now(),
  };
  if (o.summary) ai.summary = String(o.summary);
  if (Array.isArray(o.characters)) ai.characters = o.characters.map(String);
  return ai;
}
