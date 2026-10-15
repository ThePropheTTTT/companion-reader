/* ============================================================
   陪读 · AI 设置面板
   ------------------------------------------------------------
   一条硬规矩：**API Key 只存在这台设备的 IndexedDB 里**。
   没有后端、没有中转、没有遥测 —— 请求从浏览器直接打到
   用户自己填的 baseURL。这一点必须写在界面上，
   因为「把 API Key 粘进一个网页」是个需要信任的动作，
   而信任要靠说清楚，不靠让人猜（见 CONTRACT 第 7 节）。

   另一个取舍：**不做「一键填入我们的服务」**。
   这个软件不提供 AI 服务，用户用的是自己的账号和额度。
   ============================================================ */

import { PROVIDERS, getAIConfig, saveAIConfig, testConnection } from '../ai/runtime.js';
import { el, sheet, toast } from './dom.js';

/** 输入行：标签 + <input>，失焦或回车时提交 */
function fieldRow({ label, key, hint, type = 'text', placeholder, get, set }) {
  const input = el('input', {
    class: 'input',
    type,
    value: get(),
    placeholder: placeholder || '',
    'aria-label': label,
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
  });
  const commit = async () => {
    const v = input.value.trim();
    if (v === get()) return;
    await set(v);
    toast('改好了');
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  return el(
    'div',
    { class: 'set__row' },
    el('div', { class: 'set__head set__head--stack' },
      el('span', { class: 'set__label', text: label }),
      hint ? el('span', { class: 'set__hint', text: hint }) : null
    ),
    input
  );
}

/**
 * 打开 AI 设置。
 * @param {{onSaved?: () => void}} [opt]
 */
export async function openAISettings(opt = {}) {
  const cfg = await getAIConfig();
  const s = sheet({ title: 'AI 设置', side: 'bottom', className: 'sheet--ai' });

  const statusLine = el('p', { class: 'set__hint set__hint--block' });

  const paintStatus = async () => {
    const c = await getAIConfig();
    const ok = Boolean(c.apiKey && c.baseURL && c.model);
    statusLine.textContent = ok
      ? `已配置：${c.baseURL} · ${c.model}`
      : '还没填 API Key —— 填好之后才能生成批注。';
    statusLine.classList.toggle('is-warn', !ok);
  };

  /* ---- 服务商选择 ---- */
  const providerWrap = el('div', { class: 'segmented', role: 'group', 'aria-label': '服务商' });
  const pButtons = [];
  const paintProviders = async () => {
    const c = await getAIConfig();
    for (const b of pButtons) {
      b.setAttribute('aria-pressed', String(c.provider === b.dataset.value));
    }
  };
  for (const key of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[key];
    const b = el('button', {
      type: 'button',
      class: 'segmented__item',
      text: p.label,
      dataset: { value: key },
      'aria-pressed': 'false',
    });
    b.addEventListener('click', async () => {
      const patch = { provider: key };
      // 预设的 baseURL/model 只在「用户没自己改过」时覆盖 —— 否则
      // 用户填好的自建网关会被切服务商这一步悄悄清掉。
      if (key !== 'custom') {
        patch.baseURL = p.baseURL;
        if (!cfg.model || Object.values(PROVIDERS).some((x) => x.model === cfg.model)) {
          patch.model = p.model;
        }
        if (!cfg.cheapModel || Object.values(PROVIDERS).some((x) => x.cheapModel === cfg.cheapModel)) {
          patch.cheapModel = p.cheapModel;
        }
      }
      Object.assign(cfg, await saveAIConfig(patch));
      for (const input of s.body.querySelectorAll('input')) {
        if (input.dataset.key) input.value = cfg[input.dataset.key] || '';
      }
      await paintProviders();
      await paintStatus();
      opt.onSaved?.();
    });
    pButtons.push(b);
    providerWrap.append(b);
  }

  /* ---- 字段 ---- */
  const mkField = (label, key, hintText, type, placeholder) =>
    fieldRow({
      label,
      key,
      hint: hintText,
      type,
      placeholder,
      get: () => cfg[key] || '',
      set: async (v) => {
        Object.assign(cfg, await saveAIConfig({ [key]: v }));
        await paintStatus();
        opt.onSaved?.();
      },
    });

  const keyRow = mkField(
    'API Key',
    'apiKey',
    '只存在这台设备上，不经过任何服务器。',
    'password',
    PROVIDERS[cfg.provider]?.keyHint || 'sk-…'
  );
  // 记下 key，方便切服务商时回填
  for (const input of keyRow.querySelectorAll('input')) input.dataset.key = 'apiKey';

  const baseRow = mkField('接口地址', 'baseURL', 'OpenAI 兼容的 /v1 地址。', 'url', 'https://…/v1');
  for (const input of baseRow.querySelectorAll('input')) input.dataset.key = 'baseURL';

  const modelRow = mkField(
    '写批注用的模型',
    'model',
    '要有点个性、又要稳，别用最小的那个。',
    'text',
    'deepseek-chat'
  );
  for (const input of modelRow.querySelectorAll('input')) input.dataset.key = 'model';

  const cheapRow = mkField(
    '粗读用的便宜模型',
    'cheapModel',
    '只用来做章节梗概，留空则同上。',
    'text',
    'deepseek-chat'
  );
  for (const input of cheapRow.querySelectorAll('input')) input.dataset.key = 'cheapModel';

  /* ---- 测试连接 ---- */
  const testBtn = el('button', { type: 'button', class: 'btn btn--ghost', text: '测一下能不能连上' });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = '正在连…';
    try {
      const r = await testConnection();
      toast(`连上了：${r.model || cfg.model}`, { ms: 3200 });
    } catch (err) {
      toast(err?.message || '连不上', { error: true, ms: 6000 });
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '测一下能不能连上';
    }
  });

  s.body.append(
    el('section', { class: 'set__section' },
      el('h3', { class: 'set__title', text: '用哪个模型' }),
      providerWrap
    ),
    el('section', { class: 'set__section' },
      el('h3', { class: 'set__title', text: '凭据' }),
      keyRow,
      baseRow,
      modelRow,
      cheapRow,
      el('div', { class: 'set__row set__row--actions' }, testBtn)
    ),
    el('section', { class: 'set__section' },
      el('h3', { class: 'set__title', text: '状态' }),
      statusLine,
      el('p', { class: 'set__hint set__hint--block', text:
        '批注是导入后在后台一章一章生成的：模型只看到当前章选出来的几段，' +
        '以及前两章的梗概（防止它写重复的废话）。整本书不会一次性发给模型。' })
    )
  );

  await paintProviders();
  await paintStatus();
  return s;
}
