/* ============================================================
   陪读 · 书搭子上下文测试
   ------------------------------------------------------------
   这个文件只测一件最要紧的事：**剧透线守不守得住**。

   「AI 陪读」这个产品里，唯一一个会让人当场关掉、再也不打开的
   错误就是剧透 —— 其他 bug 都是难看，这一个是致命的。
   而它又恰好是个纯逻辑问题（给模型的 messages 数组里有没有不该有的字），
   所以必须能用测试钉死，而不是靠"prompt 里写了不要剧透"。

   附带测上下文组装的两个次要性质：
     · 稳定前缀在前（prompt cache 靠它省钱）
     · 历史裁剪不丢最近的对话
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMessages, cnNum, parasToText, QUICK_ASKS } from '../site/js/ai/companion.js';

/* ---------------------------- 造一本假书 ---------------------------- */

function para(text, pi, type = 'p') {
  return { type, text, pi };
}

function fakeDoc() {
  const ch1 = {
    id: 'ch1',
    title: '雨夜',
    index: 0,
    paras: [para('第一章开头。雨下了一整夜。', 0), para('他把伞留在了门口。', 1)],
  };
  const ch2 = {
    id: 'ch2',
    title: '账本',
    index: 1,
    paras: [
      para('第二章从这里开始。', 0),
      para('账本上写着一个名字。', 1),
      para('这个名字他见过。', 2),
      para('★剧透内容★：他其实早就知道。', 3),
      para('★更后面的剧透★：凶手是账房先生。', 4),
    ],
  };
  const ch3 = {
    id: 'ch3',
    title: '真相',
    index: 2,
    paras: [para('第三章才揭晓的事：账房先生跑了。', 0)],
  };
  return {
    meta: { id: 'book1', title: '下雨的账本', author: '测试作者' },
    chapters: [ch1, ch2, ch3],
  };
}

/** 把所有 message 的 content 拼起来，方便做"包含/不包含"断言 */
function allText(messages) {
  return messages.map((m) => m.content).join('\n');
}

/* ---------------------------- 剧透线 ---------------------------- */

test('剧透线：spoilerPi 之后的原文一个字都不能进 messages', async () => {
  const doc = fakeDoc();
  const paras = doc.chapters[1].paras;
  // 读到第 2 段（下标 2）为止，第 3、4 段还没读到
  const messages = await buildMessages({
    doc,
    chapterIndex: 1,
    paras,
    pageFrom: 2,
    pageTo: 3,
    thread: { spoilerPi: 3, messages: [] },
    recaps: {},
  });
  const text = allText(messages);

  // 读过的必须在
  assert.ok(text.includes('第二章从这里开始。'), '章首正文应该在上下文里');
  assert.ok(text.includes('账本上写着一个名字。'), '读过的段落应该在');
  assert.ok(text.includes('【他此刻正在看的这一页】'), '当前页要单独标出来');

  // ★ 没读到的一个字都不能有
  assert.ok(!text.includes('★剧透内容★'), '下一页的文字泄漏进了上下文');
  assert.ok(!text.includes('★更后面的剧透★'), '更后面的文字泄漏进了上下文');
  assert.ok(!text.includes('第三章才揭晓的事'), '后面的章被整章塞进了上下文');
});

test('剧透线：后面的章标题也不该出现（标题本身就是剧透）', async () => {
  const doc = fakeDoc();
  // ★ chapterIndex 必须是 1：第 0 章之前没有任何章可回顾，
  //   一开始我传 0 来测 recap，结果 recaps 根本没被读到（earlierChapters 空转）。
  const messages = await buildMessages({
    doc,
    chapterIndex: 1,
    paras: doc.chapters[1].paras,
    pageFrom: 0,
    pageTo: 1,
    thread: { spoilerPi: 1, messages: [] },
    recaps: { ch1: '@@R1@@' },
  });
  const text = allText(messages);
  assert.ok(text.includes('@@R1@@'), '读过的章（第 1 章）的梗概应该在');
  // 「第三章 真相」这个标题一旦出现，就已经说了后面有个"真相"。
  assert.ok(!text.includes('真相'), '后面章节的标题泄漏了');
  assert.ok(!text.includes('账房先生跑了'), '后面章节的正文泄漏了');
});

test('剧透线：spoilerPi 超过段落数时被夹住，不会出现 undefined 文本', async () => {
  const doc = fakeDoc();
  const paras = doc.chapters[1].paras;
  const messages = await buildMessages({
    doc,
    chapterIndex: 1,
    paras,
    pageFrom: 0,
    pageTo: 1,
    thread: { spoilerPi: 9999, messages: [] },
    recaps: {},
  });
  const text = allText(messages);
  assert.ok(!text.includes('undefined'), '夹取没生效，拼出了 undefined');
  assert.ok(text.includes('★更后面的剧透★'), 'spoilerPi 大到越界时应该把整章都算作已读');
});

test('剧透线：spoilerPi 是 0 时只剩当前页，且章节上下文仍然完整', async () => {
  const doc = fakeDoc();
  const paras = doc.chapters[1].paras;
  const messages = await buildMessages({
    doc,
    chapterIndex: 1,
    paras,
    pageFrom: 0,
    pageTo: 1,
    thread: { spoilerPi: 0, messages: [] },
    recaps: {},
  });
  const text = allText(messages);
  assert.ok(text.includes('第二章从这里开始。'), '当前页在 spoilerPi 之外也必须给 —— 用户正看着它');
  assert.ok(!text.includes('账本上写着一个名字。'), '不是当前页、又没读过，不该出现');
});

/* ---------------------------- 组装顺序 ---------------------------- */

test('稳定前缀在 messages[0]，且含书名/作者/章序/规矩', async () => {
  const doc = fakeDoc();
  const messages = await buildMessages({
    doc,
    chapterIndex: 1,
    paras: doc.chapters[1].paras,
    pageFrom: 0,
    pageTo: 1,
    thread: { spoilerPi: 1, messages: [] },
  });
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.startsWith('你在陪一个人读《下雨的账本》（测试作者）。'));
  assert.ok(messages[0].content.includes('全书 3 章'));
  assert.ok(messages[0].content.includes('第二章'));
  // 规矩要正向表述。这条断言是防回归的：
  // 「不要剧透」这种否定句会被模型理解成「可以暗示」，所以这里要的是正向句。
  assert.ok(messages[0].content.includes('读到的进度完全一样'), '规矩被改掉了');
});

test('历史被裁到最近若干条，但最近的一定在', async () => {
  const doc = fakeDoc();
  const many = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'ai',
    text: `第${i}句话`,
  }));
  const messages = await buildMessages({
    doc,
    chapterIndex: 0,
    paras: doc.chapters[0].paras,
    pageFrom: 0,
    pageTo: 1,
    thread: { spoilerPi: 1, messages: many },
  });
  const text = allText(messages);
  assert.ok(text.includes('第29句话'), '最近一条被裁掉了');
  assert.ok(!text.includes('第0句话'), '太早的历史应该被裁掉（否则 token 会无限涨）');
  // role 映射：内部用 'user'/'ai'，送出去必须是 'user'/'assistant'
  const roles = new Set(messages.slice(1).map((m) => m.role));
  assert.ok(!roles.has('ai'), "内部 role 'ai' 没被翻成 'assistant'");
});

test('线程 recap 存在时作为一段背景放在历史之前', async () => {
  const doc = fakeDoc();
  const messages = await buildMessages({
    doc,
    chapterIndex: 0,
    paras: doc.chapters[0].paras,
    pageFrom: 0,
    pageTo: 1,
    thread: { spoilerPi: 1, recap: '你们之前聊过伞的事。', messages: [{ role: 'user', text: '嗯' }] },
  });
  const i = messages.findIndex((m) => m.content.includes('你们之前聊过伞的事。'));
  const j = messages.findIndex((m) => m.content === '嗯');
  assert.ok(i > 0, 'recap 没进 messages');
  assert.ok(i < j, 'recap 必须排在最近对话之前');
});

/* ---------------------------- 纯工具 ---------------------------- */

test('parasToText：跳过空段、把图标注出来、区间是 [from, to)', () => {
  const paras = [para('甲', 0), para('', 1), { type: 'img', text: '', pi: 2, src: 'a.png' }, para('丁', 3)];
  assert.equal(parasToText(paras, 0, 2), '甲');
  assert.equal(parasToText(paras, 0, 3), '甲\n（这里有一张插图）');
  assert.equal(parasToText(paras, 2, 3), '（这里有一张插图）', '图片段落的 text 是空串，必须先判图片再判文字');
  assert.equal(parasToText(paras, 3, 4), '丁');
  assert.equal(parasToText(paras, 0, 999), '甲\n（这里有一张插图）\n丁');
  assert.equal(parasToText([], 0, 10), '');
});

test('cnNum：章号在常见范围内读起来是人话', () => {
  assert.equal(cnNum(1), '一');
  assert.equal(cnNum(9), '九');
  assert.equal(cnNum(10), '十');
  assert.equal(cnNum(11), '十一');
  assert.equal(cnNum(20), '二十');
  assert.equal(cnNum(35), '三十五');
  assert.equal(cnNum(0), '零');
  assert.equal(cnNum(-3), '零');
});

test('QUICK_ASKS 每条都带可直接发送的 text，标签不重复', () => {
  assert.ok(QUICK_ASKS.length >= 3);
  const labels = new Set();
  for (const q of QUICK_ASKS) {
    assert.equal(typeof q.text, 'string');
    assert.ok(q.text.trim().length > 0, `${q.id} 没有可发送的 text`);
    assert.ok(!labels.has(q.label), `标签重复：${q.label}`);
    labels.add(q.label);
    // 快速提问是"我卡住了"的按钮，不该是"帮我写读后感"
    assert.ok(q.text.length < 60, `${q.id} 的 text 太长，不像一句话`);
  }
});
