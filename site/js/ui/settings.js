/* ============================================================
   陪读 · 排版设置面板
   ------------------------------------------------------------
   设计取舍：

   1. **改一下就立刻看到效果**。所有控件都是「即时生效 + 立即落盘」，
      没有「保存」按钮。读书时调字号是个反复试的过程，
      多一步确认会让这个过程难受一倍。
      代价是每拖动一次滑块都会写一次 IndexedDB —— 所以滑块的
      input 事件只改 DOM，change（松手）才落盘，见 bindRange()。

   2. **预览用真书页，不用示意图**。用户当下正看着那一页，
      调字号时那一页自己会重排 —— 那就是最好的预览。
      所以这里只管改 state，重排交给 reader 的 'relayout' 订阅。

   3. **平板和手机的「每行字数」是两个值**（measure / wideMeasure）。
      用户在 iPad 上调好了，换到手机上不该继承平板的行宽；
      反过来也一样。所以界面上按当前档位只显示一个滑块。
   ============================================================ */

import { state, patchSettings } from '../state.js';
import { SETTING_RANGES, THEME_LABEL, FONT_STACKS } from '../core/model.js';
import { el, sheet, toast } from './dom.js';

/* ---------------------------- 小组件 ---------------------------- */

/**
 * 一行：标签 + 右侧值 + 滑块。
 * input 时立刻生效（看得见），change（松手）时才落盘。
 */
function rangeRow({ label, key, range, format }) {
  const value = el('span', { class: 'set__value', text: format(state.settings[key]) });
  const input = el('input', {
    type: 'range',
    min: String(range.min),
    max: String(range.max),
    step: String(range.step),
    value: String(state.settings[key]),
    'aria-label': label,
  });

  input.addEventListener('input', () => {
    const v = Number(input.value);
    value.textContent = format(v);
    // persist:false —— 拖动过程中不落盘，松手才写
    patchSettings({ [key]: v }, { persist: false });
  });
  input.addEventListener('change', () => {
    patchSettings({ [key]: Number(input.value) });
  });

  return el(
    'div',
    { class: 'set__row' },
    el('div', { class: 'set__head' }, el('span', { class: 'set__label', text: label }), value),
    input
  );
}

/** 分段控件：值相等的高亮。多用于「档位」型设置 */
function segmented({ label, key, options, hint }) {
  const wrap = el('div', { class: 'segmented', role: 'group', 'aria-label': label });
  const buttons = [];
  const paint = () => {
    for (const b of buttons) {
      b.setAttribute('aria-pressed', String(state.settings[key] === b.dataset.value));
    }
  };
  for (const opt of options) {
    const b = el('button', {
      type: 'button',
      class: 'segmented__item',
      text: opt.label,
      dataset: { value: String(opt.value) },
      'aria-pressed': 'false',
    });
    if (opt.title) b.title = opt.title;
    b.addEventListener('click', () => {
      state.settings[key] = opt.value; // 先落值，paint 里比较的是它
      paint();
      patchSettings({ [key]: opt.value });
    });
    buttons.push(b);
    wrap.append(b);
  }
  paint();

  return el(
    'div',
    { class: 'set__row' },
    el('div', { class: 'set__head' }, el('span', { class: 'set__label', text: label })),
    wrap,
    hint ? el('p', { class: 'set__hint', text: hint }) : null
  );
}

/** 开关行 */
function switchRow({ label, key, hint, onChange }) {
  const btn = el('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-pressed': String(!!state.settings[key]),
    'aria-label': label,
  });
  btn.append(el('span', { class: 'switch__knob' }));
  const paint = () => btn.setAttribute('aria-pressed', String(!!state.settings[key]));
  btn.addEventListener('click', () => {
    const next = !state.settings[key];
    state.settings[key] = next;
    paint();
    patchSettings({ [key]: next });
    onChange?.(next);
  });
  return el(
    'div',
    { class: 'set__row set__row--switch' },
    el(
      'div',
      { class: 'set__head set__head--stack' },
      el('span', { class: 'set__label', text: label }),
      hint ? el('span', { class: 'set__hint', text: hint }) : null
    ),
    btn
  );
}

function section(title, ...children) {
  return el(
    'section',
    { class: 'set__section' },
    el('h3', { class: 'set__title', text: title }),
    ...children
  );
}

/* ---------------------------- 主面板 ---------------------------- */

export function openReadSettings() {
  const s = sheet({ title: '排版', side: 'bottom', className: 'sheet--settings' });
  const s2 = state.settings;

  const fontSize = () => (s2.fontSize / 19).toFixed(2);
  const lineHeight = () => `${s2.lineHeight.toFixed(2)} 倍`;
  const paraSpacing = () => (s2.paraSpacing === 0 ? '不分段' : `${s2.paraSpacing.toFixed(1)} 字`);
  const measureKey = state.device === 'tablet' ? 'wideMeasure' : 'measure';

  s.body.append(
    section(
      '正文',
      rangeRow({
        label: '字号',
        key: 'fontSize',
        range: SETTING_RANGES.fontSize,
        format: (v) => `${v} px`,
      }),
      rangeRow({
        label: '行距',
        key: 'lineHeight',
        range: SETTING_RANGES.lineHeight,
        format: () => lineHeight(),
      }),
      rangeRow({
        label: '段间距',
        key: 'paraSpacing',
        range: SETTING_RANGES.paraSpacing,
        format: () => paraSpacing(),
      }),
      rangeRow({
        label: state.device === 'tablet' ? '每行字数（平板）' : '每行字数（手机）',
        key: measureKey,
        range: SETTING_RANGES[measureKey],
        format: (v) => `${v} 字`,
      }),
      segmented({
        label: '字体',
        key: 'fontFamily',
        options: Object.keys(FONT_STACKS).map((k) => ({
          value: k,
          label: { serif: '宋', sans: '黑', kai: '楷' }[k] || k,
        })),
        hint: '宋体最耐读；楷体更像纸书，但小字号下发虚。',
      })
    ),

    section(
      '主题',
      segmented({
        label: '配色',
        key: 'theme',
        options: Object.keys(THEME_LABEL).map((k) => ({ value: k, label: THEME_LABEL[k] })),
      }),
      rangeRow({
        label: '亮度',
        key: 'brightness',
        range: SETTING_RANGES.brightness,
        format: (v) => `${Math.round(v * 100)}%`,
      })
    ),

    section(
      '仿生锚点',
      switchRow({
        label: '锚点加粗',
        key: 'anchorEnabled',
        hint: '每个语义小句的第一个字加粗，给视线一个落点。',
      }),
      rangeRow({
        label: '强度',
        key: 'strength',
        range: SETTING_RANGES.strength,
        format: (v) => ['关', '很轻', '轻', '中', '重'][v] || `${v}`,
      }),
      el('p', {
        class: 'set__hint set__hint--block',
        text:
          '强度越高锚点越密。中文没有空格，锚点找的是「小句的第一个实词」——' +
          '太密反而变成新的噪声，一般用「轻」就够。',
      })
    ),

    section(
      '行为',
      switchRow({
        label: '保持屏幕常亮',
        key: 'keepAwake',
        hint: '用 Wake Lock；iOS 从 Safari 16.4 起支持。',
      })
    )
  );

  // 面板关掉后重新分页一次：拖动滑块时为了不卡，reader 用的是节流重排，
  // 松手（面板关闭）后需要一次「不带节流」的精确重排来收敛。
  s.root.addEventListener('transitionend', () => {
    // 什么都不用做：reader 订阅了 settings，节流会在下一帧收敛。
  });

  return s;
}

/* ---------------------------- 换字体时的一个坑 ---------------------------- */

/**
 * 字体是异步加载的：`data-font` 一改，浏览器立刻换 font-family，
 * 但「宋体」这类字体在系统里可能是懒加载的（尤其 iOS 的中文字体），
 * 换完的瞬间行宽还在用回退字体算，分页会量错。
 *
 * 这里等 document.fonts.ready 再触发一次重排。fire-and-forget，
 * 因为调用方（设置面板）不关心它什么时候完成。
 */
export function relayoutAfterFontsReady(emitRelayout) {
  if (typeof document === 'undefined' || !document.fonts) return;
  document.fonts.ready
    .then(() => emitRelayout())
    .catch(() => {
      /* 字体加载失败就算了，回退字体也能读 */
    });
}

/** 设置写入失败时给用户一个可见的提示（IndexedDB 可能因为配额或隐私模式失败） */
export function warnSettingsFailed(err) {
  console.warn('[settings]', err);
  toast('设置没能保存，这次改动只在当前页面有效', { error: true });
}
