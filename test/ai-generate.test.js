'use strict';
/* ============================================================
   陪读 · ai/generate.js 纯逻辑测试
   ------------------------------------------------------------
   node --test test/ai-generate.test.js   （或 npm test 全量跑）

   设计取舍与 test/store.test.js 保持一致：
   - 不引入 fake-indexeddb。Node 里没有 indexedDB，涉及真实读写的用例直接 skip
     并打印原因，不算失败；纯逻辑（抽样 / 闸门 / 校验 / 键解析）全部真跑。
   - 不联网、不调模型：generateChapterAI 走 opt.chat 注入口，不需要 key。
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { currentModelRev, makeChapter, makeParagraph } from '../site/js/core/model.js';
import { aiKey, parseAiKey } from '../site/js/core/store.js';
import { parseJSON } from '../site/js/ai/runtime.js';
import {
  chapterDigest, clearChapterAI, estimateCost, generateBookSummary, generateChapterAI,
  loadBookAI, loadChapterAI, passesQualityGate, pickAiKeys, saveChapterAI, selectNoteParas,
} from '../site/js/ai/generate.js';

const HAS_IDB = typeof globalThis.indexedDB !== 'undefined';
const NO_IDB_REASON = 'Node 无 IndexedDB（与 store.test.js 同一取舍：不注入 fake-indexeddb）';

/* ------------------------------------------------------------------ */
/* 夹具：完全确定性，不用 Math.random                                  */
/* ------------------------------------------------------------------ */

/**
 * 造一章候选段落。文本按 i % 6 轮转，五种正文长度/信号各不相同，
 * 保证 selectNoteParas 的打分**必然出现大量并列**（这才是需要检验的情况：
 * 并列时若按 pi 升序决胜，批注会全挤在章首）。
 */
function makeParas(n) {
  const paras = [];
  for (let i = 0; i < n; i++) {
    let text;
    const m = i % 6;
    if (m === 0) text = '他推开门，屋里没人，桌上那盏灯还亮着。';
    else if (m === 1) text = '「你怎么现在才回来？」她问，声音有点抖。';
    else if (m === 2) text = '风从窗缝里钻进来，吹得纸页哗哗响，他抬手按住。';
    else if (m === 3) text = '嗯。'; // 太短，不该进候选
    else if (m === 4) text = '他看了很久，没说话，手指在杯沿上转了一圈又一圈。';
    else text = '那年冬天特别冷，冷到水管都冻住了，母亲每天早上要烧一壶水去浇。';
    paras.push(makeParagraph({ type: 'p', text }, i));
  }
  return paras;
}

/** 断言：结果里任意两条批注至少隔 PARA_GAP 段（|pi 差| >= 2）。 */
function assertNotAdjacent(list) {
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i] - list[i - 1] >= 2, '相邻段落被同时选中：' + list[i - 1] + ',' + list[i]);
  }
}

/* ------------------------------------------------------------------ */
/* 1. 模块导入与导出面                                                 */
/* ------------------------------------------------------------------ */

test('模块在 Node 下可直接 import，且导出面与 UI 约定一致', () => {
  // 能执行到这里就说明模块顶层没有碰 document / window / IndexedDB。
  const api = {
    selectNoteParas, generateChapterAI, chapterDigest, generateBookSummary,
    loadBookAI, loadChapterAI, saveChapterAI, clearChapterAI, estimateCost,
  };
  for (const name of Object.keys(api)) {
    assert.equal(typeof api[name], 'function', name + ' 应该是函数');
  }
  assert.equal(typeof passesQualityGate, 'function', 'passesQualityGate 应该导出（供测试与预览）');
  assert.equal(typeof pickAiKeys, 'function', 'pickAiKeys 应该导出（纯函数，供测试）');
});

/* ------------------------------------------------------------------ */
/* 2. selectNoteParas                                                  */
/* ------------------------------------------------------------------ */

test('selectNoteParas：确定性 —— 同输入连跑两次完全相同，且不改动入参', () => {
  const a = makeParas(120);
  const snapshot = a.map((p) => p.pi);
  const first = selectNoteParas(a, 1);
  const second = selectNoteParas(a, 1);
  assert.deepEqual(first, second, '同一次数组上连跑两次必须相同');
  assert.deepEqual(a.map((p) => p.pi), snapshot, '不能改动入参数组');
  // 重新构造一份等价的、全新的输入（不同对象身份）再跑一次
  assert.deepEqual(selectNoteParas(makeParas(120), 1), first, '等价输入必须给出等价结果');
  assert.ok(first.length > 0);
});

test('selectNoteParas：相邻段落不同时选中', () => {
  for (const n of [5, 12, 60, 300]) {
    for (const d of [0, 1, 2]) {
      assertNotAdjacent(selectNoteParas(makeParas(n), d));
    }
  }
});

test('selectNoteParas：密度档位单调，且高密度是低密度的超集', () => {
  const paras = makeParas(100); // 100 段时三档不会被 [3,24] 夹到同一个值
  const s0 = selectNoteParas(paras, 0);
  const s1 = selectNoteParas(paras, 1);
  const s2 = selectNoteParas(paras, 2);
  assert.equal(s0.length, 6, '100 段 × 6% = 6');
  assert.equal(s1.length, 12, '100 段 × 12% = 12');
  assert.equal(s2.length, 20, '100 段 × 20% = 20');
  assert.ok(s0.length < s1.length && s1.length < s2.length, '条数应随密度严格增加');
  // 超集关系：调高密度只会让批注变多，不会让原批注跳位（UI 上调档位时的体感）
  for (const pi of s0) assert.ok(s1.indexOf(pi) >= 0, '少档的 ' + pi + ' 应仍在多档里');
  for (const pi of s1) assert.ok(s2.indexOf(pi) >= 0, '中档的 ' + pi + ' 应仍在多档里');
});

test('selectNoteParas：条数夹到 [3, 24]（下限是目标，不是保证）', () => {
  // 下限：30 段 × 6% = 1.8 → 抬到 3，且 30 段足够疏，能真的选出 3 条
  const small = selectNoteParas(makeParas(30), 0);
  assert.equal(small.length, 3, '短章也得有人陪：目标下限 3 条');
  assertNotAdjacent(small);

  // 5 段正文只有 2 条：最佳段落(i=1)入选后把 i=0、i=2 都挡掉了，
  // 唯一能凑到 3 条的选法是 {0,2,4}，但那要牺牲全章最有戏的那一段。
  // 这里明确钉住「宁少勿滥」这个取舍 —— 如果哪天改成回溯求最大独立集，这条用例会失败，
  // 那时应该先确认是不是真的想为了凑数丢掉最好的段落。
  const tiny = selectNoteParas(makeParas(5), 0);
  assert.deepEqual(tiny, [1, 4], '短章允许达不到目标条数，但不许为了凑数乱选');
  assertNotAdjacent(tiny);

  // 上限：1000 段 × 20% = 200 → 夹到 24
  const big = selectNoteParas(makeParas(1000), 2);
  assert.equal(big.length, 24, '长章不能把正文挤爆：至多 24 条');
  assertNotAdjacent(big);
});

test('selectNoteParas：跳过非 p 段落（标题/引文/图片）与空段、短段', () => {
  const paras = [
    makeParagraph({ type: 'h2', text: '第一章 灯' }, 0),
    makeParagraph({ type: 'p', text: '他推开门，屋里没人，桌上那盏灯还亮着。' }, 1),
    makeParagraph({ type: 'p', text: '嗯。' }, 2),                       // 太短
    makeParagraph({ type: 'p', text: '   ' }, 3),                       // 空（normalize 后为 ''）
    makeParagraph({ type: 'quote', text: '「你怎么现在才回来？」她问，声音有点抖。' }, 4),
    makeParagraph({ type: 'img', text: '', src: 'a.png' }, 5),
    makeParagraph({ type: 'p', text: '他看了很久，没说话，手指在杯沿上转了一圈又一圈。' }, 6),
    makeParagraph({ type: 'h1', text: '灯' }, 7),
    makeParagraph({ type: 'p', text: '那年冬天特别冷，冷到水管都冻住了，母亲每天早上要烧一壶水去浇。' }, 8),
  ];
  const picked = selectNoteParas(paras, 2, { target: 99 });
  assert.deepEqual(picked, [1, 6, 8], '只有这三段够格，且只能是 p 类型');
});

test('selectNoteParas：没有候选时返回空数组，不抛错', () => {
  assert.deepEqual(selectNoteParas([], 1), []);
  assert.deepEqual(selectNoteParas(null, 1), []);
  assert.deepEqual(selectNoteParas([makeParagraph({ type: 'h1', text: '第一章' }, 0)], 2), []);
  assert.deepEqual(selectNoteParas(makeParas(20), 1, { target: 0 }), []);
});

test('selectNoteParas：难分高下时批注要铺满整章，不能全挤在章首', () => {
  // 这条用例专门盯 spreadKey 那个决定：若并列时按 pi 升序决胜，
  // 前 12 个候选全是段 1~67 里最靠前的段落，max(pi) 会很小。
  const picked = selectNoteParas(makeParas(100), 1);
  assert.ok(Math.max.apply(null, picked) >= 50,
    '并列段落应被低差异序列打散到整章，实际最靠后只到 ' + Math.max.apply(null, picked));
  assert.ok(picked.indexOf(0) === -1 || picked.length > 1, '首位是否入选不重要，铺开才重要');
  assertNotAdjacent(picked);
});

/* ------------------------------------------------------------------ */
/* 3. 质量闸门                                                         */
/* ------------------------------------------------------------------ */

test('质量闸门：空洞词批注一律丢掉', () => {
  const src = '他推开门，屋里没人，桌上那盏灯还亮着。';
  const bad = [
    '这段描写很细腻', '写得很生动', '这一幕太精彩了', '语言优美',
    '含义深刻', '引人入胜的开头', '把孤独写得淋漓尽致',
    '人物跃然纸上', '这个比喻值得玩味', '作者在这里铺陈了很多',
  ];
  for (const text of bad) {
    assert.equal(passesQualityGate(text, src), false, '应丢掉：' + text);
  }
});

test('质量闸门：太短的丢掉（< 6 字），长度合适的放行', () => {
  const src = '他推开门，屋里没人，桌上那盏灯还亮着。';
  assert.equal(passesQualityGate('好看', src), false);
  assert.equal(passesQualityGate('好看得很', src), false, '4 字仍低于 6 字下限');
  assert.equal(passesQualityGate('这盏灯有点意思', src), true);
});

test('质量闸门：纯复述原句的丢掉（bigram 重合 > 0.7）', () => {
  const src = '他推开门，屋里没人，桌上那盏灯还亮着。';
  assert.equal(passesQualityGate(src, src), false, '整句照抄必须丢');
  assert.equal(passesQualityGate('他推开门，屋里没人', src), false, '半句照抄也要丢');
  assert.equal(
    passesQualityGate('桌上那盏灯还亮着这句话让我停了一下', src),
    true,
    '抓了具体细节但有自己的话，应放行',
  );
  assert.equal(passesQualityGate('写到这我突然想起自己家的老台灯', src), true);
  assert.equal(passesQualityGate('', src), false);
  assert.equal(passesQualityGate('这盏灯一直亮着没人管', null), true, '没有原文可比对时不因复述被误杀');
  assert.equal(passesQualityGate('这盏灯', null), false, '太短这条不因为缺原文就放过');
});

/* ------------------------------------------------------------------ */
/* 4. parseJSON 的围栏 / 截取逻辑（runtime 提供，这里验证它确实兜得住）  */
/* ------------------------------------------------------------------ */

test('parseJSON：markdown 围栏、前后废话、纯文本报错三态', () => {
  assert.deepEqual(parseJSON('```json\n{"notes":[],"summary":"x"}\n```'), { notes: [], summary: 'x' });
  assert.deepEqual(parseJSON('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSON('好的，结果如下：{"notes":[{"pi":3}]} 希望有帮助'), { notes: [{ pi: 3 }] });
  assert.deepEqual(parseJSON('前缀 [1,2,3] 后缀'), [1, 2, 3]);
  assert.throws(() => parseJSON('抱歉，我没法完成'), (err) => {
    assert.equal(err.name, 'AIFormatError');
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* 5. generateChapterAI（走 opt.chat 注入口，不联网）                   */
/* ------------------------------------------------------------------ */

/** 记录所有请求、并按脚本返回固定 JSON 的假 chat。 */
function scriptedChat(sink, payload) {
  return async (req) => {
    sink.push(req);
    return typeof payload === 'function' ? payload(req) : JSON.stringify(payload);
  };
}

/** 从 user 消息里抽出本批候选的 pi（按 prompt 里 '[pi] 正文' 的行首格式）。 */
function pisInRequest(req) {
  const content = req.messages[1].content;
  const out = [];
  const re = /^\[(\d+)\] /gm;
  let m = re.exec(content);
  while (m) { out.push(Number(m[1])); m = re.exec(content); }
  return out;
}

test('generateChapterAI：校验 pi 白名单 / 长度 / kind / 重复，并过质量闸门', async () => {
  const paras = makeParas(120);
  const chapter = makeChapter({ id: 'c1', title: '灯', index: 0 });
  const picked = selectNoteParas(paras, 1);
  assert.ok(picked.length >= 5, '夹具应给出足够多的候选');
  const [pGood, pHollow, pShort, pRestate, pKind, pLong] = picked;
  const restateText = paras[pRestate].text; // 与原文逐字相同 → 必须被当成复述丢掉

  const payload = {
    notes: [
      { pi: pGood, kind: 'quip', text: '他推门之前先在门口站了两秒，这个停顿我认得' },
      { pi: 9999, kind: 'note', text: '这条挂在不存在的段落上，必须丢掉' },
      { pi: -1, kind: 'note', text: '负数下标同样必须丢掉' },
      { pi: pGood, kind: 'note', text: '同一段落的第二条，只留第一条' },
      { pi: pHollow, kind: 'quip', text: '这段描写很细腻，作者手法很成熟' },
      { pi: pShort, kind: 'quip', text: '好看得很' },
      { pi: pRestate, kind: 'ask', text: restateText },
      { pi: pKind, kind: 'banana', text: '「声音有点抖」这五个字让我停了一下' },
      { pi: pLong, kind: 'quip', text: 'x'.repeat(81) },
      null,
      '不是对象',
    ],
    summary: '  他一整夜都守着桌上那盏灯。  ',
    characters: ['他', '她', '他', '', '这个人物名字明显超过十二个字了应该被丢掉'],
  };
  const sink = [];
  const ai = await generateChapterAI(chapter, paras, { prevDigest: '上一章他出了趟远门。' }, {
    density: 1,
    chat: scriptedChat(sink, payload),
  });

  assert.equal(sink.length, 1, '不足 3 条也不许补第二轮请求（省钱）');
  assert.equal(sink[0].json, true, '必须要求模型返回 JSON');
  assert.equal(ai.chapterId, 'c1');
  assert.equal(ai.modelRev, currentModelRev());
  assert.equal(typeof ai.at, 'number');
  assert.deepEqual(ai.notes.map((n) => n.pi), [pGood, pKind], '只有这两条能活下来');
  assert.equal(ai.notes[0].kind, 'quip');
  assert.equal(ai.notes[1].kind, 'quip', '白名单外的 kind 归 quip');
  assert.equal(ai.notes[0].likes, 0);
  for (const n of ai.notes) {
    assert.ok(n.text.length >= 4 && n.text.length <= 80, '批注正文长度必须落在 4~80');
    assert.ok(picked.indexOf(n.pi) >= 0, 'pi 必须落在本批候选集合里');
  }
  assert.equal(ai.summary, '他一整夜都守着桌上那盏灯。', '梗概要折成一行并去空白');
  assert.deepEqual(ai.characters, ['他', '她'], '去重 / 去空 / 丢掉超长项');
  assert.notEqual(ai.notes.length, 3, '这里就是不足 3 条，不许为了凑数放行废批注');
});

test('generateChapterAI：prompt 结构与 prompt cache 前缀', async () => {
  const paras = makeParas(300);
  const chapter = makeChapter({ id: 'c2', title: '第二盏灯', index: 1 });
  const sink = [];
  const payload = (req) => {
    const pis = pisInRequest(req);
    return JSON.stringify({
      notes: pis.slice(0, 2).map((pi) => ({ pi, kind: 'quip', text: '第 ' + pi + ' 段里那个动作我做过一模一样的事' })),
      summary: '',
      characters: [],
    });
  };
  // target 70 > 每批 60 → 强制走分批路径（这是目前唯一能触发分批的入口：
  // 密度档位夹到至多 24 条，正常 UI 路径不会超过一批）
  const ai = await generateChapterAI(chapter, paras, {
    bookMeta: { title: '灯下', author: '某人' },
    chapterCount: 12,
    prevDigest: '上一章他出了趟远门。',
    prevPrevDigest: '再上一章他修好了那盏灯。',
  }, { target: 70, chat: scriptedChat(sink, payload) });

  assert.equal(sink.length, 2, '70 个候选应切成 2 批');
  const counts = sink.map((r) => pisInRequest(r).length);
  assert.deepEqual(counts, [60, 10], '每批最多 60 段');
  assert.equal(sink[0].messages[0].content, sink[1].messages[0].content,
    'system 前缀必须逐字节一致，否则 prompt cache 全灭');
  const heads = sink.map((r) => r.messages[1].content.slice(0, r.messages[1].content.indexOf('\n[')));
  assert.equal(heads[0], heads[1], '稳定前缀（书信息+章序+前情+格式说明）必须逐批一致');
  assert.ok(heads[0].indexOf('《灯下》 · 某人') >= 0, '书信息在稳定前缀里');
  assert.ok(heads[0].indexOf('上一章讲了：上一章他出了趟远门。') >= 0, '前情提要在稳定前缀里');
  assert.ok(sink[0].messages[1].content.indexOf('\n[0] ') > 0 || /\n\[\d+\] /.test(sink[0].messages[1].content),
    '候选段落拼在最后，格式为 [pi] 正文');

  const sys = sink[0].messages[0].content;
  assert.ok(sys.indexOf('具体细节') >= 0, 'system prompt 必须含「必须抓一个原文具体细节」这条硬规矩');
  assert.ok(sys.indexOf('不剧透') >= 0 || sys.indexOf('绝不剧透') >= 0, 'system prompt 必须禁止剧透');
  assert.ok(sys.indexOf('细腻') >= 0, 'system prompt 要点名空洞词');
  assert.ok(sys.indexOf('```') === -1, '不要在 prompt 里示范 markdown 围栏（模型会照抄）');

  assert.equal(ai.notes.length, 4, '两批各 2 条');
  assert.equal(ai.summary, undefined, '模型没给梗概就不该凭空造一个键');
});

test('generateChapterAI：进度回调 / 回调自己抛错不影响生成', async () => {
  const paras = makeParas(300);
  const chapter = makeChapter({ id: 'c3', index: 2 });
  const progress = [];
  const sink = [];
  const payload = (req) => JSON.stringify({
    notes: pisInRequest(req).slice(0, 1).map((pi) => ({ pi, kind: 'note', text: '第 ' + pi + ' 段的停顿让我想起去年冬天' })),
    summary: '一句话。',
  });
  await generateChapterAI(chapter, paras, {
    chapterIndex: 2,
    chapterCount: 30,
    onProgress: (p) => progress.push(p),
  }, { target: 70, chat: scriptedChat(sink, payload) });
  assert.ok(progress.length >= 3, '每批至少一次进度 + 收尾一次');
  assert.equal(progress[progress.length - 1].done, progress[progress.length - 1].total);
  assert.equal(progress[progress.length - 1].phase, 'notes');

  // UI 的 onProgress 抛错不该把整个生成带崩
  const ai2 = await generateChapterAI(chapter, makeParas(20), {
    chapterIndex: 2,
    onProgress: () => { throw new Error('UI 自己炸了'); },
  }, { density: 1, chat: scriptedChat([], payload) });
  assert.equal(ai2.chapterId, 'c3');
  assert.ok(ai2.notes.length > 0);

  // 没有 onProgress 也不能报错（调用方可能不关心进度）
  const ai3 = await generateChapterAI(chapter, makeParas(20), {}, { density: 1, chat: scriptedChat([], payload) });
  assert.equal(ai3.chapterId, 'c3');
});

test('generateChapterAI：没有候选段落时一次请求都不发', async () => {
  const chapter = makeChapter({ id: 'c4', index: 3 });
  const sink = [];
  const ai = await generateChapterAI(chapter, [
    makeParagraph({ type: 'h1', text: '第三章' }, 0),
    makeParagraph({ type: 'img', text: '', src: 'b.png' }, 1),
    makeParagraph({ type: 'p', text: '嗯。' }, 2),
  ], {}, { density: 1, chat: scriptedChat(sink, { notes: [] }) });
  assert.equal(sink.length, 0, '没候选就不该花钱');
  assert.deepEqual(ai.notes, []);
  assert.equal(ai.modelRev, currentModelRev());
});

test('generateChapterAI：全批失败时抛出第一个错（UI 要能提示密钥/网络问题）', async () => {
  const chapter = makeChapter({ id: 'c5', index: 4 });
  const err = new Error('没有配置模型 API Key');
  err.name = 'AIKeyError';
  await assert.rejects(
    generateChapterAI(chapter, makeParas(40), {}, { density: 1, chat: async () => { throw err; } }),
    (e) => {
      assert.equal(e.name, 'AIKeyError');
      return true;
    },
  );
});

test('generateChapterAI：模型输出不是 JSON 时按 AIFormatError 处理', async () => {
  const chapter = makeChapter({ id: 'c6', index: 5 });
  await assert.rejects(
    generateChapterAI(chapter, makeParas(40), {}, { density: 1, chat: async () => '抱歉，我不太确定。' }),
    (e) => {
      assert.equal(e.name, 'AIFormatError');
      return true;
    },
  );
});

test('generateChapterAI：已生成的批注不会因为后续批次失败被丢掉', async () => {
  const chapter = makeChapter({ id: 'c7', index: 6 });
  let n = 0;
  const flaky = async (req) => {
    n++;
    if (n === 1) {
      return JSON.stringify({
        notes: pisInRequest(req).slice(0, 3).map((pi) => ({ pi, kind: 'note', text: '第 ' + pi + ' 段里那句「嗯」我读出了别的意思' })),
        summary: '他把灯留着。',
      });
    }
    const e = new Error('超时'); e.name = 'AITimeoutError'; throw e;
  };
  const ai = await generateChapterAI(chapter, makeParas(300), {}, { target: 70, chat: flaky });
  assert.equal(ai.notes.length, 3, '第一批的成果要保住');
  assert.equal(ai.summary, '他把灯留着。');
});

test('generateChapterAI：signal 取消后不再发后续批次', async () => {
  const chapter = makeChapter({ id: 'c8', index: 7 });
  const ctrl = new AbortController();
  const sink = [];
  const chatImpl = async (req) => {
    sink.push(req);
    ctrl.abort();
    return JSON.stringify({
      notes: pisInRequest(req).slice(0, 1).map((pi) => ({ pi, kind: 'quip', text: '第 ' + pi + ' 段那盏灯让我想起老房子' })),
      summary: 'x',
    });
  };
  const ai = await generateChapterAI(chapter, makeParas(300), { signal: ctrl.signal }, { target: 70, chat: chatImpl });
  assert.equal(sink.length, 1, '取消后不该再发第二批');
  assert.equal(ai.notes.length, 1, '已拿到的批注保留');
});

test('generateChapterAI：chapter.id 缺失时明确报错', async () => {
  await assert.rejects(generateChapterAI({ title: '无 id' }, makeParas(20), {}, {}), /章节 id/);
});

test('generateChapterAI：density 走 opt 或 ctx 都认（单批也能看出条数差异）', async () => {
  const paras = makeParas(100); // 100 段：d0 → 6 条，d2 → 20 条
  const chapter = makeChapter({ id: 'c9', index: 8 });
  const payload = (req) => JSON.stringify({
    notes: pisInRequest(req).map((pi) => ({ pi, kind: 'note', text: '第 ' + pi + ' 段那个动作我在自己身上见过' })),
  });
  const viaOpt = await generateChapterAI(chapter, paras, {}, { density: 0, chat: scriptedChat([], payload) });
  const viaCtx = await generateChapterAI(chapter, paras, { density: 2 }, { chat: scriptedChat([], payload) });
  const dflt = await generateChapterAI(chapter, paras, {}, { chat: scriptedChat([], payload) });
  assert.equal(viaOpt.notes.length, 6);
  assert.equal(viaCtx.notes.length, 20, 'ctx.density 也要生效');
  assert.equal(dflt.notes.length, 12, '都不给就是中档');
});

/* ------------------------------------------------------------------ */
/* 6. chapterDigest / 全书梗概                                          */
/* ------------------------------------------------------------------ */

test('chapterDigest：没有摘要就返回空串（不要占位符）', () => {
  assert.equal(chapterDigest(null), '');
  assert.equal(chapterDigest(undefined), '');
  assert.equal(chapterDigest({ notes: [] }), '');
  assert.equal(chapterDigest({ summary: '   ' }), '');
  assert.equal(chapterDigest({ summary: '  他把灯留在桌上，等人回来。  ' }), '他把灯留在桌上，等人回来。');
  const long = chapterDigest({ summary: '灯'.repeat(200) });
  assert.ok(long.length <= 161, '超长梗概要截断，不能整篇塞进下一章 prompt');
  assert.ok(long.slice(-1) === '…');
});

test('generateBookSummary：没有任何材料时返回空串且不发请求', async () => {
  const doc = { meta: { id: '', title: '无材料', format: 'epub', author: '' }, chapters: [] };
  assert.equal(await generateBookSummary(doc), '');
  assert.equal(await generateBookSummary(null), '');
});

test('generateBookSummary：有书简介就能生成（此处仅验证无 IDB 环境下不崩）', {
  skip: HAS_IDB ? false : NO_IDB_REASON,
}, async () => {
  const doc = {
    meta: { id: 'b1', title: '灯下', author: '某人', description: '一个人守着一盏灯。', format: 'epub' },
    chapters: [],
  };
  const out = await generateBookSummary(doc);
  assert.equal(typeof out, 'string');
});

/* ------------------------------------------------------------------ */
/* 7. 键解析与持久化                                                   */
/* ------------------------------------------------------------------ */

test('pickAiKeys：按已知 bookId 前缀切分，兼容 bookId / chapterId 里含 ":"', () => {
  const bid = 'C:\\我的书\\灯:下部.txt|1234|1700000000000';
  const k1 = aiKey(bid, 'c1');
  const keys = [k1, aiKey(bid, 'ch:7'), aiKey('别的书|1|2', 'c1'), aiKey(bid, ''), 'progress:' + bid];
  const got = pickAiKeys(keys, bid).map((e) => e.chapterId);
  assert.deepEqual(got, ['c1', 'ch:7'], '含 ":" 的 bookId 与 chapterId 都要还原正确');
  assert.equal(pickAiKeys(keys, bid).length, 2, '别的书的键、空 chapterId、progress 键都不许命中');
  assert.deepEqual(pickAiKeys(keys, '别的书|1|2').map((e) => e.chapterId), ['c1']);
  assert.deepEqual(pickAiKeys([], bid), []);
  assert.deepEqual(pickAiKeys(null, bid), []);
  // 前缀带尾分隔符，所以 bookId 互为前缀时不会串
  assert.deepEqual(pickAiKeys([aiKey('a|1|2', 'c1')], 'a|1|20'), []);
  // 顺带把 store.parseAiKey 的真实行为钉在这里：它只切**第一个**分隔符，
  // 所以 bookId 含 ':' 时会切错（store.test.js 记着这条已知限制）。
  // 这正是 pickAiKeys 不靠它来还原 chapterId、只用它做「确实是 AI 键」复核的原因。
  assert.deepEqual(parseAiKey(aiKey('a|1|2', 'c1')), { bookId: 'a|1|2', chapterId: 'c1' });
  assert.deepEqual(parseAiKey(k1), {
    bookId: 'C',
    chapterId: '\\我的书\\灯:下部.txt|1234|1700000000000:c1',
  });
});

test('持久化 API：空 bookId 是安全的空操作，缺参数要报错', async () => {
  assert.deepEqual(await loadBookAI(''), {});
  assert.deepEqual(await loadBookAI(null), {});
  await clearChapterAI('');   // 不应触碰 IndexedDB
  await clearChapterAI(null);
  await assert.rejects(saveChapterAI('', 'c1', { notes: [] }), /bookId/);
  await assert.rejects(saveChapterAI('b', 'c1', null), /ChapterAI/);
});

test('loadChapterAI / saveChapterAI / clearChapterAI 真读写（Node 下跳过）', {
  skip: HAS_IDB ? false : NO_IDB_REASON,
}, async () => {
  const bookId = 'test-book|1|2';
  const ai = { chapterId: 'c1', notes: [{ pi: 1, kind: 'quip', text: '一段批注', likes: 0, at: 1 }], modelRev: currentModelRev(), at: 1 };
  await saveChapterAI(bookId, 'c1', ai);
  const back = await loadChapterAI(bookId, 'c1');
  assert.equal(back.notes.length, 1);
  const stale = Object.assign({}, ai, { modelRev: currentModelRev() - 1 });
  await saveChapterAI(bookId, 'c2', stale);
  assert.equal(await loadChapterAI(bookId, 'c2'), null, 'modelRev 过期要当 null，但不删');
  const all = await loadBookAI(bookId);
  assert.deepEqual(Object.keys(all), ['c1']);
  await clearChapterAI(bookId);
  assert.deepEqual(await loadBookAI(bookId), {});
});

/* ------------------------------------------------------------------ */
/* 8. 费用估算                                                         */
/* ------------------------------------------------------------------ */

test('estimateCost：数量级正确、随密度单调、只按抽中的段落计费', () => {
  assert.deepEqual(estimateCost(0), { chars: 0, calls: 0, roughTokens: 0 });
  assert.deepEqual(estimateCost(NaN), { chars: 0, calls: 0, roughTokens: 0 });

  const c0 = estimateCost(300000, 0);
  const c1 = estimateCost(300000, 1);
  const c2 = estimateCost(300000, 2);
  assert.ok(c0.roughTokens < c1.roughTokens && c1.roughTokens < c2.roughTokens, '密度越高越贵');
  assert.equal(c2.chars, 300000);
  assert.equal(c2.calls, 9, '30 万字 × 20% = 6 万字 ≈ 500 段 → 9 批');
  assert.ok(c2.roughTokens > 40000 && c2.roughTokens < 60000, '实际值 ' + c2.roughTokens);
  // 关键：送进模型的不是全文字符（否则会给出把用户吓退的十倍数字）
  assert.ok(c1.roughTokens < 300000 * 0.7, '中等密度必须明显低于「全文都进模型」的估算');
  assert.equal(estimateCost(1200, 1).calls, 1, '小书一批就够');
});
