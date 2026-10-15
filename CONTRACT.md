# 陪读 — 接口契约

> 本文件是模块之间的**唯一真相**。任何模块改动都必须先改这里。
> 纯逻辑模块（解析、锚点、分页、存储）**不得触碰 DOM 与浏览器专属 API 之外的东西**，以便用 `node --test` 直接跑。
>
> ⚠ 第 0 节的目录**已按实际落地的结构更新过**（早期版本写的是 `core/ai.js`，实际 AI 代码都在 `js/ai/` 下 —— 这条偏差曾导致 `app.js` 去 import 一个不存在的模块，而外面套着 try/catch，所以只是静默失效、没有任何报错）。

## 0. 目录

```
site/
  index.html            应用外壳（唯一 HTML 入口）
  manifest.webmanifest  PWA 清单
  sw.js                 Service Worker（离线）。★ 注意它在 site/ 下、不在 site/js/ 下，
                        所以 tools/check.mjs 不会检查它
  icons/                PWA 图标（由 tools/make-icons.mjs 手写 PNG 编码器生成，零依赖）
  css/                  设计系统与阅读器排版
    tokens.css          设计变量（颜色/字号/间距/时长）
    app.css             外壳、顶栏、底栏、toast
    library.css         书架
    reader.css          正文排版与翻页（含"锚点绝不能是原子盒"那条警告）
    panel.css           浮层/抽屉/表单控件
    notes.css           批注
    danmaku.css         弹幕
    chat.css            书搭子对话
  js/
    app.js              启动、视图编排、导入、事件绑定
    state.js            全局可变状态（单一 store；settings 走 DEFAULT_SETTINGS 兜底合并）
    ai/                 AI 层（会联网、会读密钥；core/ 里不放这些）
      runtime.js        唯一的网络出口：provider 配置、密钥、chat()、SSE、错误分类
      generate.js       批注生成（分层读 + 质量闸门 + prompt cache 前缀）
      danmaku.js        弹幕生成（比批注更短、更便宜、按需）
      companion.js      书搭子：上下文压缩、剧透线（spoilerPi）、线程持久化
    ui/                 视图层（会碰 DOM）
      dom.js            el()/svg()/sheet()/toast()/confirmDialog()/nextFrame/settleFrame
      renderer.js       章节渲染 + 测量式分页（ChapterRenderer）
      reader.js         阅读交互（翻页/切章/进度/重排）
      library.js        书架
      settings.js       排版面板
      ai-config.js      AI 设置面板
      ai-bridge.js      批注生成编排（串行队列 + 预取）
      notes-panel.js    批注面板
      danmaku.js        弹幕显示层
      chat.js           书搭子面板
      progress.js       进度读写（键名从 core/store.js 复用，不自己拼字符串）
    core/               纯逻辑层（可单测，不碰 DOM）
      xml.js            手写 XML 解析器（Node 没有 DOMParser）
      epub.js           EPUB/TXT 解析（内置 ZIP 读取 + DecompressionStream）
      zip.js            ZIP 读取（CRC32、ZIP64 报错、编码嗅探）—— 自检与测试也用它的 crc32
      media.js          段落懒解析（ensureParas）与图片 blob URL
      anchor.js         中文语义锚点
      paginate.js       测量式分页（唯一碰 DOM 度量的 core 模块）
      store.js          IndexedDB 持久化
      model.js          数据结构、默认值、设置校验
test/                   node --test 测试（148 项；见 §7 的跑法）
tools/
  dev-server.mjs        开发用静态服务器（零依赖）
  check.mjs             静态自检：模块能否加载、import 是否断裂、资源是否存在、CSS 括号
  make-icons.mjs        生成 PWA 图标（手写 PNG 编码）
  make-fixture.mjs      生成 .fixtures/ 里的测试用 EPUB/TXT
  smoke.mjs             真机自检：开一个 headless Edge 把书真的读一遍（见 §7）
  probe-runtime.mjs     运行时能力探测（一次性，留作回归检查）
```

---

## 1. 核心数据结构（`js/core/model.js`）

```js
/** @typedef {'h1'|'h2'|'h3'|'h4'|'p'|'quote'|'img'} ParaType */

/** @typedef {Object} Para
 *  @property {ParaType} type
 *  @property {string}   text     纯文本，已 trim、已折叠连续空白
 *  @property {string=}  src      仅 img：相对 EPUB 根的路径（已解析，可直接喂给 URL 构造）
 *  @property {string=}  alt      仅 img
 *  @property {number}   pi       段落在本章内的下标（由 parse 填，从 0 起）
 */

/** @typedef {Object} Chapter
 *  @property {string}   id       稳定 id（EPUB 用 spine item id，TXT 用 `c${index}`）
 *  @property {string}   title    目录标题；无则回退「第 N 章」
 *  @property {number}   index    从 0 起
 *  @property {number}   depth    目录层级，0 起（EPUB3 nav 多级；无则 0）
 *  @property {string=}  href     章节在书内原始路径（TXT 为 undefined）
 *  @property {Para[]=}  paras    懒解析缓存，**初始为 undefined**
 *  @property {string=}  body     懒解析用原始 XHTML/文本（TXT 时就是正文）
 */

/** @typedef {Object} BookMeta
 *  @property {string} id         `${文件名}|${字节数}|${lastModified}`，稳定书籍指纹
 *  @property {string} title
 *  @property {string} author
 *  @property {string} [language]
 *  @property {string} [publisher]
 *  @property {string} [description]
 *  @property {string} format      'epub' | 'txt'
 *  @property {number} size        字节数
 *  @property {number} addedAt     ms
 *  @property {string} [cover]     封面 data URL（EPUB 内嵌图，若可提取）
 *  @property {number} charCount   全书正文字符数（估算费用用）
 *  @property {number} chapterCount
 */

/** @typedef {Object} BookDoc
 *  @property {BookMeta} meta
 *  @property {Chapter[]} chapters
 *  @property {Object=}   toc       预留：嵌套目录树
 *  @property {number}    rev       结构版本号，每次结构变更 +1（用于让下游缓存失效）
 */

/** 锚点强度 0..4，越大锚点越密 */
/** @typedef {0|1|2|3|4} Strength */

/** @typedef {Object} AnchorRange  @property {number} start  @property {number} end 半开区间，均落在词首 */
```

### 进度（`store.js` 持久化，不进 BookDoc）

```js
/** @typedef {Object} Progress
 *  @property {string} chapterId
 *  @property {number} pi          该章起始段落下标
 *  @property {number} scrollRatio 页内偏移 0..1（长段落兜底）
 *  @property {number} at          ms
 *  @property {number} percent     全书百分比 0..100，仅用于显示
 */
```

### AI 产物（M1，先占位）

```js
/** @typedef {Object} Note
 *  @property {number} pi        挂在哪一段（章内下标）
 *  @property {'quip'|'note'|'ask'|'spoiler-free-summary'} kind
 *  @property {string} text      番茄式短书评，1~3 句
 *  @property {number} [likes]   装饰性数字，纯氛围
 *  @property {number} at
 */

/** @typedef {Object} ChapterAI
 *  @property {string}  chapterId
 *  @property {string=} summary   滚动分层摘要，约 300~500 字，供「书搭子」复用
 *  @property {string[]=} characters  本章出现的人物名
 *  @property {Note[]}  notes
 *  @property {number}  modelRev  生成时的 prompt 版本，变了就重生成
 *  @property {number}  at
 */
```

---

## 2. `core/epub.js`

```js
/**
 * 只接受 ArrayBuffer，返回 BookDoc。失败抛 Error（message 面向用户，中文）。
 * 要求：
 *  - 用浏览器原生 DecompressionStream('deflate-raw') 解压，**禁止任何 zip 库、禁止网络请求**
 *  - 正确处理 mimetype（stored）、container.xml、OPF（manifest/spine/metadata）、
 *    EPUB3 nav.xhtml 与 EPUB2 toc.ncx 两种目录、子目录相对路径、XML 命名空间前缀任意
 *  - 中文 XHTML 常见实体（&nbsp; &mdash; &#xxx;）要解码
 *  - 目录标题缺失时按内容回退；章节正文用 DOM 解析（需要 DOMParser → 该函数允许触 DOM，
 *    但解析出的结果必须与 DOM 无关，可序列化）
 * @param {ArrayBuffer} buf
 * @param {string} filename
 * @returns {Promise<BookDoc>}
 */
export async function parseEPUB(buf, filename) {}

/**
 * 编码嗅探 + 章节切分。
 * 编码顺序：BOM → UTF-8 严格解码 → UTF-16LE/BE(BOM) → GBK 回退
 * 章节切分认：第N章/节/回、Chapter N、以及全角空格分隔的标题行
 * @param {ArrayBuffer} buf
 * @param {string} filename
 * @returns {BookDoc}
 */
export function parseTXT(buf, filename) {}
```

## 3. `core/anchor.js`（**独立实现，参考思路不抄代码**）

```js
/**
 * 中文语义小句锚定。返回锚点区间，每段独立调用。
 * 规则（这是设计约束，不是建议）：
 *  R1 只锚「词首」。借 Intl.Segmenter 分词（不可用则退化为启发式），绝不把词从中间劈开。
 *  R2 候选 = 小句起点（段首、或分句标点后）的第一个词。
 *  R3 句首连词（但/并/而/且/或/则/因/所/即/若/虽/可/是/又/也/还/就/那/这…）要跳过，
 *     改锚其后的实词，避免出现「【但】是」这种没意义的加粗。
 *  R4 小句过长时按强度 N = [18,14,12,10,8][strength] 补锚点，补位以目标点为中心双向 ±3 词搜索，
 *     只接受实词，搜不到就**不补**（宁可留白，不硬凑）。
 *  R5 不变量：两锚点间距 ≥ 4 个字符。
 *  R6 锚点区间长度恒为 1 个字符（中文场景），故永不会出现连续加粗。
 *  R7 纯 ASCII 串（英文单词）不处理，交给调用方决定。
 * @param {string} text
 * @param {Strength} strength
 * @returns {AnchorRange[]} 已按 start 升序，互不重叠
 */
export function computeAnchors(text, strength) {}

/**
 * 把文本转成可插入 DOM 的片段描述（**不碰 DOM**，由渲染层消费）。
 * @param {string} text
 * @param {Strength} strength
 * @returns {Array<{t:'text'|'head', v:string}>}
 */
export function anchorTokens(text, strength) {}
```

## 4. `core/paginate.js`

```js
/**
 * 测量式分页：整章先完整渲染并测量，再切成页，只渲染当前页。
 * 之所以不用 CSS multi-column：Safari 在 100dvh 容器里分栏高度与滚动条行为不可靠。
 *
 * measure() 会临时改动传入容器的内容，调用方需自行保存/恢复，或在测量后立即渲染。
 *
 * @param {HTMLElement} host      已按最终排版样式渲染了整章的容器
 * @param {{available:number}} opt available = 可用高度 px
 * @returns {{pages:number[], heights:number[]}}
 *          pages   = 每页起始段落下标，形如 [0, 7, 15, ...]，末尾不重复闭合
 *          heights = 每页实际内容高度 px
 * 要求：
 *  - 段间距必须用相邻段 offsetTop 之差推算，**不能用 rect.height 相加**，
 *    否则外边距折叠会让分页结果比实际多塞段落，最后一页被裁掉。
 *  - 单段超过 available 时，该段独占一页（不切分段落，宁可让用户滚动）。
 *  - 空文本段落高度视为 0 但**仍占一个 pi**，保持下标稳定。
 */
export function paginate(paras, opt) {}
```

## 5. `core/store.js`

```js
/**
 * IndexedDB 单库 `peidu`，两个对象仓：
 *   books      keyPath 'meta.id'   —— { meta, chapters, rev }，整本一条记录
 *   kv         keyPath 'k'         —— 杂项：progress:<bookId>、ai:<bookId>:<chapterId>、settings
 * 要求：无依赖 Promise 封装；每次操作开库；对 QuotaExceededError 抛出可读中文错误；
 * 提供 deleteBook(bookId) 连带清掉 progress:* 与 ai:<bookId>:*。
 */
export const store = {
  async ready(),                       // 一次性升级 schema
  async listBooks(),                   // -> BookMeta[]（按 addedAt 降序）
  async getBook(id),                   // -> BookDoc | undefined
  async putBook(doc),
  async deleteBook(id),
  async get(k, fallback),              // 任意 JSON
  async set(k, v),
  async keys(prefix),                  // -> string[]
  async del(...keys),
};
```

---

## 6. 排版与响应式约束（UI 层，但算法层要遵守）

- 阅读视口高度 = `100dvh` 减掉顶栏/底栏；不要用 `100vh`（iOS 地址栏伸缩会抖）。
- 安全区：容器 padding 必须吃 `env(safe-area-inset-*)`，横屏 iPad 尤其明显。
- 行宽：**手机竖屏 20~26 字，iPad 30~38 字**。由 `--measure`（ch 单位）控制，不是固定 px。
- 锚点样式**绝不能**用 `display:inline-block` 或 `transform`：inline-block 会在两侧无条件
  制造断行机会，把中文整段排乱。只用 `font-weight` / `color` / `letter-spacing` 补偿。
- 所有可点区域 ≥ 44×44 pt（iOS HIG）。

### 已知坑（来自 bionic-reader 的踩坑记录，直接继承，不重蹈）

1. 宋体合成加粗会让字宽膨胀约 2%，需要在锚点元素上加 `margin-inline-end` 补偿，否则行内累积错位。
2. 锚点缩放方案已判定为死路（见上条 inline-block 约束），不要尝试。
3. EPUB 里 `mimetype` 必须是第一个且 stored，解析时不要假设它可解压。

### 本机实测踩出来的坑（补进契约，避免重犯）

4. **分页容器 `.page-body` 必须是 `position: relative`。** static 元素不是 `offsetParent`，
   段落的 offsetParent 链会直接跳过它（实测 `p → #paper → #pages → #main → body`），
   于是 `measureBlocks` 里"链走不到 host"就按 `display:none` 记 0 高 —— 整章量出 0px，
   被当成一页装得下，页脚永远 `1/1`、正文靠滚动看，而且**一声不响**。
   `paginate.js` 的 `offsetChain` 现在有 parentElement 退路兜底，但 CSS 这条也别拆。
5. **切换视图那一刻量不到高度。** 阅读视图刚从 `display:none` 变可见的一两帧里
   `clientHeight` 是 0，量出来的分页是错的，而且会被指纹缓存住。
   现在的防线有三层：`renderer.layout()` 重试最多 5 次、退化结果**不缓存**、
   `reader.js` 用 `IntersectionObserver` 在变可见时补一次 `relayout()`。
6. **切页要从"整章节点数组"里切，不能从当前 DOM 里切。** DOM 里平时只剩当前页，
   在它上面再切第二次必然索引越界 —— 症状是翻到第 2 页之后整页空白。
   `renderer.paint()` 存 `this.allNodes`，`paintPage()` 从它切片。
7. **`el()` 里的函数值必须用 `node[k] = v` 挂，不能走 `setAttribute`。**
   否则 `onclick: () => onOpen(meta)` 只是写了一个字符串属性：点击既不报错也不响应
   （书架上的书点不开就是这么来的）。
8. **`state.chapterIndex` 必须在 `enterChapter()` 里落定**，不能只靠 `goChapter()` 设 ——
   跨章翻页是直接调 `enterChapter` 的，不设就会表现为在本章首末页之间反复横跳。
9. **图片段落解不出图时要清空 `src`。** 留着相对路径（如 `OEBPS/px.png`）会让浏览器
   去请求站点根下的同名路径，必然 404 加一个碎图标。渲染层对空 `src` 画"（插图）"占位；
   段落本身不能删 —— `pi` 是批注与阅读进度的坐标系。

---

## 7. 怎么跑（含本沙箱的两个限制）

```bash
npm run dev        # 开发服务器，默认 5178（file:// 下 ES 模块和 SW 都用不了）
npm run check      # 静态自检：模块能否加载 / import 是否断裂 / 资源是否存在 / CSS 括号
npm test           # 148 项单测（5 项 skip：需要真实 IndexedDB）
npm run verify     # check + test
npm run fixtures   # 造 .fixtures/测试书.epub|txt
npm run smoke      # 用 headless Edge 把这本书真的读一遍，产出 .shots/*.png
```

两个环境限制（都是沙箱边界，不是代码问题）：

- `node --test test/` 会报 `ERR_UNSUPPORTED_DIR_IMPORT`；而 `node --test` 默认的多进程隔离
  会 `spawn EPERM`（Windows 沙箱禁命名管道）。所以 `package.json` 里写的是
  `node --test --experimental-test-isolation=none "test/*.test.js"`。
- **`npm run smoke` 需要非沙箱环境**：Edge 的 IPC 走命名管道，受限沙箱下必定
  `platform_channel.cc:187 Check failed: 拒绝访问` 而死。它是"最后一道防线"级别的验证 ——
  单层测试证明不了"把书拖进去屏幕上有没有字"，而下面这些 bug 全都是它抓到的：
  `pageChars` 重名导致的白屏、`reader.js` 被子 agent 覆盖、空 `src` 的 404、
  书架点不开、章号不更新导致的翻页横跳、以及最严重的"整章被当成一页"。

`window.__peidu` 是留给控制台和 smoke 的只读把手（`state` / `store` / `renderer`）；
应用代码不许用它，该走 import。

---

## 8. AI 层怎么验（`tools/fake-ai.mjs`）

AI 层的风险不在"模型答得好不好"，而在**我们这半边**：请求发出去没有、返回的 JSON
解不解得开、`pi` 有没有对上段落、批注有没有画到页上、流式是不是一个字一个字出来的、
以及最要紧的——**送出去的上下文里有没有后文**。

用真 API 测不了这些：模型每次回答都不一样，断言写不死。所以有一个假服务：

```
node tools/fake-ai.mjs      # 127.0.0.1:8787，OpenAI 兼容
                           # POST /v1/chat/completions（stream / response_format 都支持）
                           # GET  /__log      录下的每一个请求（含我给出的回答）
                           # POST /__reset    清空记录
```

它按应用 prompt 里的 `[123] 正文` 格式反解候选段落，于是给出的 `pi` 一定是合法的 ——
测的是管道，不是模型会不会编下标。请求逐条记进 `.fake-ai/requests.jsonl`。

已经靠它钉住的几件事（`tools/smoke.mjs` 的「配 AI」段）：

- 批注生成 → 画到页上 → 面板列出 → 点一条能跳到原文那一段；
- 一键弹幕真的飘出字，且每条 ≤14 字；
- 书搭子能流式输出、回了话、朗读真的调了 `speechSynthesis.speak`；
- **剧透红线**：写死断言"书搭子的请求里不得出现 `铜锁/文具店/十七楼/蓝皮，横格`"
  （书名含"账本"，所以只能用只在后文出现的字眼）；
- 模型给几条批注 vs 应用留下几条（差太多就说明质量闸门过严或解析丢数据，
  而页面上只表现为"批注有点少"，看不出来）。

### 假服务自己的两个坑（留给下一个写假服务的人）

1. **必须处理 CORS，而且必须处理 `OPTIONS` 预检。** 浏览器带 `authorization` 头时
   一定先发预检；不回 `Access-Control-Allow-Headers` 就直接被拦。
2. **预检头要加在每一个真正回数据的响应上，尤其是 SSE 那条。** 第一次跑的时候
   我给 `OPTIONS`/`404`/`models` 都加了 `...cors`，唯独漏了 `chat/completions` 的
   两个分支 —— 症状极具迷惑性：**请求照样到达服务端（日志里有记录），
   但浏览器因为读不到 `Allow-Origin` 把响应整个丢掉**，页面上报 CORS 错、
   批注是空的。看日志会以为"发出去成功了"，看页面会以为"没发出去"。
