import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 运行时设置的渲染与保存契约。
 *
 * 客户端产物是 Console 组件，不导出内部渲染函数；这里把产物当函数体载入
 * （与 WEBUI-15 的语法断言同一条路径），只取渲染内核与保存函数，不挂载真实 DOM。
 * meta 里的 modes 是手写 fixture，形状与服务端 /api/settings 的字段表一致。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');

const noop = () => {};

/* 产物顶层会挂一些浏览器监听（如 visibilitychange）并读 localStorage；
 * 探针只需要渲染 / 保存内核，这里给出最小无副作用桩。 */
const WINDOW_STUB = {
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  addEventListener: noop,
  removeEventListener: noop,
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  fetch: () => Promise.reject(new Error('probe: no network')),
};
const DOCUMENT_STUB = {
  readyState: 'complete',
  hidden: false,
  documentElement: null,
  body: null,
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, setAttribute: noop, addEventListener: noop }),
};

/* 可手动推进的定时器：回执的 2 秒保持与 0.3 秒淡出都能断言，且不拖住事件循环 */
function createClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    run(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== ms) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

function loadClient() {
  const body = CLIENT_SOURCE.replace(
    'export default function applyPatchouliWikiReader',
    'function applyPatchouliWikiReader',
  );
  const clock = createClock();
  let fetchImpl = () => Promise.reject(new Error('probe: no network'));
  const factory = new Function(
    'window', 'document', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    `${body}
let __renderStageCalls = 0;
renderStage = function () { __renderStageCalls += 1; };
return {
  state, renderRuntimeGroup, RUNTIME_GROUPS, saveRuntimeField, refreshRuntimeGroup,
  requestJson, postRuntimeSettings, writeJson,
  setViewport(el) { viewportEl = el; },
  setToast(el) { toastEl = el; },
  renderStageCalls() { return __renderStageCalls; },
};`,
  );
  const api = factory(
    WINDOW_STUB, DOCUMENT_STUB, (...args) => fetchImpl(...args),
    () => 0, noop, clock.setTimeout, clock.clearTimeout,
  );
  api.clock = clock;
  api.setFetch = (next) => { fetchImpl = next; };
  /* 产物默认 own=false（首帧路由还没认领本页）；本文件只跑渲染 / 保存内核，不跑路由判定，
     因此按真实使用形态（用户就在本插件页上点保存）置真。WRITE-01 自己把它翻回 false。 */
  api.state.own = true;
  return api;
}

/* 与服务端 SETTINGS_META 的 trigger 段同序：modes 按源码实际读取点标注 */
const TRIGGER_META = [
  { section: 'trigger', key: 'windowSizeSeconds', label: '发言速率窗口（秒）', type: 'number', modes: ['rate'] },
  { section: 'trigger', key: 'burstMultiplier', label: '突发倍率阈值', type: 'number' },
  { section: 'trigger', key: 'minBurstRate', label: '最低突发速率（条/分）', type: 'number', modes: ['rate'] },
  { section: 'trigger', key: 'quiescenceSeconds', label: '平息静默观察期（秒）', type: 'number' },
  { section: 'trigger', key: 'coolingRatioThreshold', label: '回落常态倍率', type: 'number' },
  { section: 'trigger', key: 'minDiscussionMessages', label: '单次沉淀最低消息数', type: 'number' },
  { section: 'trigger', key: 'maxBufferMessages', label: '历史消息缓存上限', type: 'number' },
  { section: 'trigger', key: 'baselineEwmaAlpha', label: '基线平滑系数', type: 'number' },
  { section: 'trigger', key: 'triggerMode', label: '判据模式', type: 'enum', options: ['potential', 'rate'] },
  { section: 'trigger', key: 'thetaMin', label: '势能突发阈值下限', type: 'number', modes: ['potential'] },
  { section: 'trigger', key: 'potentialAutoTuning', label: 'shadow 双门限同步调优', type: 'boolean', modes: [] },
  { section: 'trigger', key: 'dispatchMargin', label: '调度质量门倍数（0 关闭）', type: 'number', modes: ['potential'] },
  { section: 'trigger', key: 'densityMultiplier', label: '密度基线倍率（0 用固定下限）', type: 'number', modes: ['potential'] },
  { section: 'trigger', key: 'peakCoolFraction', label: '峰值冷却比例（0 仅基线）', type: 'number', modes: ['potential'] },
  { section: 'trigger', key: 'rhoMin', label: '信息密度下限', type: 'number', modes: ['potential'] },
];

const SHARED = ['burstMultiplier', 'quiescenceSeconds', 'coolingRatioThreshold', 'minDiscussionMessages', 'maxBufferMessages', 'baselineEwmaAlpha'];
const RATE_ONLY = ['windowSizeSeconds', 'minBurstRate'];
const POTENTIAL_ONLY = ['thetaMin', 'dispatchMargin', 'densityMultiplier', 'peakCoolFraction', 'rhoMin'];

const API = loadClient();
const TRIGGER_GROUP = API.RUNTIME_GROUPS.find((group) => group.id === 'trigger');

function renderTrigger(mode) {
  API.state.runtimeSettings.meta = TRIGGER_META;
  API.state.runtimeSettings.sections = { trigger: { triggerMode: mode } };
  API.state.runtimeSettings.draftMode = '';
  API.state.folds = {};
  return API.renderRuntimeGroup(TRIGGER_GROUP);
}

function keysOf(html) {
  return Array.from(html.matchAll(/data-cfg-key="([^"]+)"/g), (match) => match[1]);
}

/* 常显行在第一个 <details> 之前，其余字段都在「其余参数」折叠里 */
function partition(html) {
  const chunks = html.split('<details class="ptx-cfg-fold"');
  return { primary: keysOf(chunks[0]), rest: chunks.slice(1).flatMap(keysOf) };
}

test('WEBUI-19: trigger 段只渲染当前判据的字段', () => {
  const potentialHtml = renderTrigger('potential');
  const rateHtml = renderTrigger('rate');
  const potential = partition(potentialHtml);
  const rate = partition(rateHtml);
  const potentialKeys = [...potential.primary, ...potential.rest];
  const rateKeys = [...rate.primary, ...rate.rest];

  // 势能模式：只出现势能字段 + 共用字段；速率专属字段彻底不渲染
  assert.deepEqual(
    potential.primary,
    ['triggerMode', 'burstMultiplier', 'quiescenceSeconds', 'coolingRatioThreshold', 'thetaMin', 'rhoMin', 'densityMultiplier', 'peakCoolFraction', 'dispatchMargin'],
    '势能模式的常显组必须只含模式选择 + 共用字段 + 势能字段',
  );
  assert.deepEqual(potential.rest, ['minDiscussionMessages', 'maxBufferMessages', 'baselineEwmaAlpha'], '共用的低频字段进「其余参数」');
  for (const key of RATE_ONLY) {
    assert.ok(!potentialHtml.includes(`data-cfg-key="${key}"`), `势能模式不得渲染速率专属字段 ${key}`);
  }

  // 速率模式：只出现速率字段 + 共用字段；势能专属字段彻底不渲染
  assert.deepEqual(
    rate.primary,
    ['triggerMode', 'windowSizeSeconds', 'burstMultiplier', 'minBurstRate', 'quiescenceSeconds', 'coolingRatioThreshold'],
    '速率模式的常显组必须只含模式选择 + 速率字段 + 共用字段',
  );
  assert.deepEqual(rate.rest, ['minDiscussionMessages', 'maxBufferMessages', 'baselineEwmaAlpha']);
  for (const key of POTENTIAL_ONLY) {
    assert.ok(!rateHtml.includes(`data-cfg-key="${key}"`), `速率模式不得渲染势能专属字段 ${key}`);
  }

  // 共用的 6 项两种模式都出现
  for (const key of SHARED) {
    assert.ok(potentialKeys.includes(key), `${key} 在势能模式可见`);
    assert.ok(rateKeys.includes(key), `${key} 在速率模式可见`);
  }
  assert.ok(potentialKeys.includes('triggerMode') && rateKeys.includes('triggerMode'), '模式选择自身两种模式都可见');

  // modes: [] 的 shadow 观测字段永远不渲染
  assert.ok(!potentialHtml.includes('potentialAutoTuning'), 'modes: [] 字段在势能模式不显示');
  assert.ok(!rateHtml.includes('potentialAutoTuning'), 'modes: [] 字段在速率模式不显示');

  // 不再有第二个（另一套判据）折叠
  assert.ok(!potentialHtml.includes('另一套判据的参数'), '势能模式不得出现「另一套判据的参数」折叠');
  assert.ok(!rateHtml.includes('另一套判据的参数'), '速率模式不得出现「另一套判据的参数」折叠');
});

test('WEBUI-20: 折叠 summary 是 图标 + 标题 + 计数徽标，默认收起', () => {
  const html = renderTrigger('potential');
  const fold = HTMLOfFirstDetails(html);
  assert.ok(fold.includes('class="ptx-cfg-fold-arrow"'), 'summary 必须有折叠箭头容器');
  assert.ok(/class="ptx-cfg-fold-arrow"><svg class="ptx-icon" width="13"/.test(fold), '箭头复用 bundle 内的 13px SVG 图标');
  assert.ok(fold.includes('class="ptx-cfg-fold-title">其余参数</span>'), '标题是独立文本节点，不与计数粘连');
  assert.ok(fold.includes('class="ptx-cfg-fold-count">3</span>'), '计数徽标单独成节点');
  assert.ok(!/<details[^>]*\bopen\b/.test(fold), '折叠默认收起');
});

test('WEBUI-21: 未标 modes 的其他段两种模式都照常渲染', () => {
  API.state.runtimeSettings.meta = [
    { section: 'topics', key: 'enabled', label: '启用每日主题校准', type: 'boolean' },
    { section: 'topics', key: 'hour', label: '校准触发小时', type: 'number' },
  ];
  API.state.runtimeSettings.sections = { trigger: { triggerMode: 'rate' } };
  API.state.runtimeSettings.draftMode = '';
  API.state.folds = {};
  const group = API.RUNTIME_GROUPS.find((item) => item.id === 'topics');
  const view = partition(API.renderRuntimeGroup(group));
  assert.deepEqual(view.primary, ['enabled', 'hour'], '非 trigger 段不受 triggerMode 影响');
  assert.deepEqual(view.rest, [], '非 trigger 段不产生多余折叠');
});

/* ---- 行内保存：最小 DOM stub ---- */

function createClassList(initial) {
  const set = new Set(initial || []);
  return {
    add(...names) { for (const name of names) set.add(name); },
    remove(...names) { for (const name of names) set.delete(name); },
    contains: (name) => set.has(name),
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name); else set.delete(name);
      return on;
    },
  };
}

function createNotice() {
  return { textContent: '', classList: createClassList() };
}

function createRow(notice) {
  return { querySelector: (selector) => (selector === '.ptx-cfg-row-msg' ? notice : null) };
}

function createControl(attrs, value) {
  const values = { ...attrs };
  return {
    value,
    classList: createClassList(),
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null; },
    setAttribute(name, next) { values[name] = String(next); },
  };
}

test('WEBUI-22: 保存只更新目标行，模式切换只替换 trigger 容器', async () => {
  const api = loadClient();
  const cells = new Map();
  const queried = [];
  api.setViewport({
    querySelector(selector) {
      queried.push(selector);
      return cells.get(selector) || null;
    },
  });

  api.state.runtimeSettings.meta = TRIGGER_META;
  api.state.runtimeSettings.sections = { trigger: { triggerMode: 'potential', thetaMin: 20 } };
  api.state.runtimeSettings.draftMode = '';
  api.state.runtimeSettings.seq = {};
  api.state.stage = 'settings';

  const thetaNotice = createNotice();
  const otherNotice = createNotice();
  const modeNotice = createNotice();
  const holder = { innerHTML: '' };
  cells.set('[data-cfg-row="trigger.thetaMin"]', createRow(thetaNotice));
  cells.set('[data-cfg-row="trigger.burstMultiplier"]', createRow(otherNotice));
  cells.set('[data-cfg-row="trigger.triggerMode"]', createRow(modeNotice));
  cells.set('[data-cfg-group="trigger"]', holder);

  // 1) 成功：只写回目标控件 + 目标行回执，不调用整页 renderStage
  api.setFetch(() => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: { thetaMin: 26.5 } }),
  }));
  const thetaControl = createControl({ 'data-cfg-section': 'trigger', 'data-cfg-key': 'thetaMin', 'data-cfg-type': 'number' }, '25');
  await api.saveRuntimeField(thetaControl);
  assert.equal(thetaControl.value, '26.5', '成功后只把服务端归一化值写回该控件');
  assert.equal(thetaNotice.textContent, '已保存', '回执出现在目标行');
  assert.ok(thetaNotice.classList.contains('is-visible'), '回执同帧可见');
  assert.equal(otherNotice.textContent, '', '其它行的提示节点不受影响');
  assert.equal(holder.innerHTML, '', '普通字段保存不得触碰组容器');
  assert.equal(api.renderStageCalls(), 0, '不得整页重渲染');
  assert.deepEqual(new Set(queried), new Set(['[data-cfg-row="trigger.thetaMin"]']), '只查询目标行');

  // 2 秒后淡出、再 0.3 秒清空
  api.clock.run(2000);
  assert.ok(!thetaNotice.classList.contains('is-visible'), '2 秒后开始淡出');
  api.clock.run(300);
  assert.equal(thetaNotice.textContent, '', '淡出结束后清空回执');

  // 2) 失败：只回滚该控件 + 目标行显示原因
  queried.length = 0;
  api.setFetch(() => Promise.resolve({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, error: '值超出范围' }),
  }));
  const failing = createControl({ 'data-cfg-section': 'trigger', 'data-cfg-key': 'thetaMin', 'data-cfg-type': 'number' }, '99');
  await api.saveRuntimeField(failing);
  assert.equal(failing.value, '26.5', '失败只回滚目标控件到服务端现值');
  assert.equal(thetaNotice.textContent, '保存失败：值超出范围');
  assert.ok(thetaNotice.classList.contains('is-error'), '失败回执走错误色');
  assert.equal(otherNotice.textContent, '');
  assert.equal(api.renderStageCalls(), 0, '失败也不整页重渲染');
  assert.deepEqual(new Set(queried), new Set(['[data-cfg-row="trigger.thetaMin"]']));

  // 3) 模式切换：只替换 [data-cfg-group="trigger"]，其余 DOM 与 renderStage 不动
  queried.length = 0;
  api.state.runtimeSettings.draftMode = 'rate';
  api.refreshRuntimeGroup('trigger');
  assert.ok(holder.innerHTML.includes('data-cfg-key="windowSizeSeconds"'), '预览按速率判据重排');
  assert.ok(!holder.innerHTML.includes('data-cfg-key="thetaMin"'), '非当前判据字段不渲染');
  assert.ok(/value="rate" selected/.test(holder.innerHTML), '下拉显示本地选择的模式');
  assert.equal(api.renderStageCalls(), 0);
  assert.deepEqual(queried, ['[data-cfg-group="trigger"]'], '只查询并替换 trigger 容器');

  // 4) 模式保存成功：仍只替换容器 + 该行回执
  queried.length = 0;
  api.setFetch(() => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: { triggerMode: 'rate' } }),
  }));
  const modeControl = createControl({ 'data-cfg-section': 'trigger', 'data-cfg-key': 'triggerMode', 'data-cfg-type': 'enum' }, 'rate');
  await api.saveRuntimeField(modeControl);
  assert.equal(api.state.runtimeSettings.sections.trigger.triggerMode, 'rate', '服务端真值落进本地 sections');
  assert.equal(api.state.runtimeSettings.draftMode, '');
  assert.ok(holder.innerHTML.includes('data-cfg-key="windowSizeSeconds"'));
  assert.ok(!holder.innerHTML.includes('data-cfg-key="thetaMin"'));
  assert.equal(modeNotice.textContent, '已保存', '模式行也有行内回执');
  assert.equal(api.renderStageCalls(), 0, '模式保存同样不得整页重渲染');
  assert.ok(
    queried.every((selector) => selector === '[data-cfg-group="trigger"]' || selector === '[data-cfg-row="trigger.triggerMode"]'),
    '模式保存只触碰 trigger 容器与模式行',
  );
});

function HTMLOfFirstDetails(html) {
  const start = html.indexOf('<details class="ptx-cfg-fold"');
  assert.ok(start >= 0, '缺少「其余参数」折叠');
  const end = html.indexOf('</details>', start);
  return html.slice(start, end + '</details>'.length);
}

/* 写请求（设置 / 提示词 / 出图选项 / 词条修正与删除 / 清空知识库）走同一个受控通道：
   非本插件页一律 reject，且**一条 fetch 都不发** —— 面板收缩到别人的插件页后，
   残留的按钮 / 在途回调都不得对 Patchouli 的设置发起写入。 */
test('WRITE-01: 非本插件页的写请求被拒且不产生 fetch', async () => {
  const api = loadClient();
  const calls = [];
  const toastNode = { innerHTML: '', classList: { add: noop, remove: noop, toggle: noop, contains: () => false } };
  api.setToast(toastNode);
  api.setFetch(() => {
    calls.push('unexpected');
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  });

  api.state.own = false;
  await assert.rejects(api.postRuntimeSettings('trigger', { thetaMin: 20 }), /非本插件页/);
  await assert.rejects(api.writeJson('/patchouli/api/prompt', 'POST', { customPrompt: 'x' }), /非本插件页/);
  await assert.rejects(api.writeJson('/patchouli/api/clear', 'POST', {}), /非本插件页/);
  await assert.rejects(api.writeJson('/patchouli/api/entries/e1', 'DELETE'), /非本插件页/);
  assert.deepEqual(calls, [], '非本插件页的写请求不得发到网络');
  assert.ok(toastNode.innerHTML.includes('当前不在本插件页'), '写请求被拦下必须给出理由');

  // 回到本插件页：同一通道放行，写请求照旧带 JSON 头与补丁体
  api.state.own = true;
  const sent = [];
  api.setFetch((url, init) => {
    sent.push({ url: String(url), init });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: { thetaMin: 20 } }) });
  });
  await api.postRuntimeSettings('trigger', { thetaMin: 20 });
  assert.equal(sent.length, 1, '本插件页的写请求正常发出');
  assert.equal(sent[0].url, '/patchouli/api/settings');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers['Content-Type'], 'application/json');
  assert.equal(sent[0].init.body, JSON.stringify({ section: 'trigger', patch: { thetaMin: 20 } }));

  // 写失败要带上服务端给的原因（HTTP 400 的 body），而不是只有一个状态码
  api.setFetch(() => Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, error: '值超出范围' }) }));
  await assert.rejects(api.postRuntimeSettings('trigger', { thetaMin: 99 }), /值超出范围/);
});
