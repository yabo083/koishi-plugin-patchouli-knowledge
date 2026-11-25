import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 面板接线契约：键盘可达、状态键稳定、拖窗守卫、在途去重、双套草稿互不覆盖、刷新诚实。
 *
 * 与 webui-settings-modes 同一条载入路径：客户端产物是 Console 组件，不导出内部函数，
 * 这里把它当函数体载入，只取出本次要用到的内核，不挂载真实浮窗。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');

const noop = () => {};

/* ---------------- 最小 DOM ---------------- *
 * 只实现 decorateSettings / 拖拽守卫真正用到的那几种操作：
 * 类名读写（直接落在 className 上，便于断言）、属性、父子关系、单类 / 标签 / [attr] 选择器。 */

function tokens(el) {
  return String(el.className == null ? '' : el.className).split(/\s+/).filter(Boolean);
}

function matches(el, selector) {
  const part = String(selector || '').trim();
  if (!part) return false;
  if (part.startsWith('.')) return tokens(el).includes(part.slice(1));
  if (part.startsWith('[')) {
    const name = part.slice(1, part.indexOf(']') === -1 ? undefined : part.indexOf(']')).split('=')[0].trim();
    return Object.prototype.hasOwnProperty.call(el.attrs, name);
  }
  return String(el.tagName || '').toLowerCase() === part.toLowerCase();
}

function queryAll(root, selector) {
  const parts = String(selector).split(',').map((item) => item.trim()).filter(Boolean);
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (parts.some((part) => matches(child, part))) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function createEl(tag, options) {
  const opts = options || {};
  const el = {
    tagName: String(tag).toUpperCase(),
    className: opts.class || '',
    textContent: opts.text == null ? '' : String(opts.text),
    value: opts.value == null ? '' : String(opts.value),
    disabled: false,
    type: '',
    attrs: {},
    children: [],
    parentNode: null,
    innerHTML: '',
  };
  el.setAttribute = (name, value) => { el.attrs[name] = String(value); };
  el.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null);
  el.removeAttribute = (name) => { delete el.attrs[name]; };
  el.appendChild = (child) => { child.parentNode = el; el.children.push(child); return child; };
  el.replaceChild = (next, prev) => {
    const at = el.children.indexOf(prev);
    if (at >= 0) el.children[at] = next;
    next.parentNode = el;
    if (prev) prev.parentNode = null;
    return prev;
  };
  el.querySelector = (selector) => queryAll(el, selector)[0] || null;
  el.querySelectorAll = (selector) => queryAll(el, selector);
  el.closest = (selector) => {
    for (let node = el; node; node = node.parentNode) {
      const parts = String(selector).split(',').map((item) => item.trim()).filter(Boolean);
      if (parts.some((part) => matches(node, part))) return node;
    }
    return null;
  };
  el.classList = {
    add(...names) {
      const set = new Set(tokens(el));
      for (const name of names) set.add(name);
      el.className = [...set].join(' ');
    },
    remove(...names) {
      const set = new Set(tokens(el));
      for (const name of names) set.delete(name);
      el.className = [...set].join(' ');
    },
    contains: (name) => tokens(el).includes(name),
    toggle(name, force) {
      const on = force === undefined ? !tokens(el).includes(name) : Boolean(force);
      if (on) el.classList.add(name);
      else el.classList.remove(name);
      return on;
    },
  };
  return el;
}

function createLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    dump: () => Object.fromEntries(store),
  };
}

function loadClient() {
  const body = CLIENT_SOURCE.replace(
    'export default function applyPatchouliWikiReader',
    'function applyPatchouliWikiReader',
  );
  const storage = createLocalStorage();
  let fetchImpl = () => Promise.reject(new Error('probe: no network'));
  const documentStub = {
    readyState: 'complete',
    hidden: false,
    documentElement: null,
    body: null,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => createEl(tag),
  };
  const windowStub = {
    localStorage: storage,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    fetch: (...args) => fetchImpl(...args),
  };
  const factory = new Function(
    'window', 'document', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    `${body}
let __renderStageCalls = 0;
let __renderStageImpl = function () {};
renderStage = function () { __renderStageCalls += 1; __renderStageImpl(); };
return {
  state, decorateSettings, handleAction, isDragGuardTarget,
  saveRuntimeField, toggleCardMask, savePrompt, saveTopicPrompt, refreshAll,
  loadSettings,
  setViewport(el) { viewportEl = el; },
  setToast(el) { toastEl = el; },
  renderStageCalls() { return __renderStageCalls; },
  onRenderStage(fn) { __renderStageImpl = fn; },
};`,
  );
  const api = factory(
    windowStub, documentStub, (...args) => fetchImpl(...args),
    () => 0, noop, setTimeout, clearTimeout,
  );
  api.storage = storage;
  api.createElement = createEl;
  api.setFetch = (next) => { fetchImpl = next; };
  return api;
}

/* 一次设置页渲染的替身：shell > (outline, main > 若干 .ptx-sec) */
function buildSettingsDom(api, titles) {
  const shell = api.createElement('div', { class: 'ptx-settings-shell' });
  const outline = shell.appendChild(api.createElement('nav', { class: 'ptx-settings-outline' }));
  const main = shell.appendChild(api.createElement('div', { class: 'ptx-settings-main' }));
  const sections = titles.map((title) => {
    const sec = main.appendChild(api.createElement('div', { class: 'ptx-sec' }));
    sec.appendChild(api.createElement('div', { class: 'ptx-sec-h', text: title }));
    sec.appendChild(api.createElement('div', { class: 'ptx-sec-body', text: '正文' }));
    return sec;
  });
  return { shell, outline, main, sections };
}

function okJson(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function failJson(status, payload) {
  const body = payload || { ok: false, error: `HTTP ${status}` };
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/* 本机设置落在 localStorage 的哪个键（键名是产物内部常量，这里按形状认） */
function settingsKeyOf(api) {
  for (const [key, raw] of Object.entries(api.storage.dump())) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
    if (parsed && typeof parsed === 'object' && 'collapsedSections' in parsed) return key;
  }
  return null;
}

test('UI-WIRE-01: 设置页分节标题是原生 button 且带 data-action="toggle-section"', () => {
  const api = loadClient();
  const dom = buildSettingsDom(api, ['面板行为', '运行时参数']);
  api.state.stage = 'settings';
  api.setViewport({ querySelector: (selector) => (selector === '.ptx-settings-shell' ? dom.shell : null) });

  api.decorateSettings();

  for (const [index, title] of ['面板行为', '运行时参数'].entries()) {
    const head = dom.sections[index].querySelector('.ptx-sec-h');
    assert.ok(head, `分节「${title}」缺标题节点`);
    assert.equal(head.tagName, 'BUTTON', '标题必须是原生 button：Enter / Space 由浏览器触发 click');
    assert.equal(head.type, 'button', '必须显式 type=button，避免落在表单里变成提交键');
    assert.equal(head.getAttribute('data-action'), 'toggle-section');
    assert.equal(head.getAttribute('data-target'), title, '折叠键是分区身份（标题），不是列表下标');
    assert.equal(head.getAttribute('aria-expanded'), 'true');
    assert.ok(dom.outline.children.some((item) => item.getAttribute('data-action') === 'jump-section' && item.getAttribute('data-target') === title));
  }

  // 二次装饰不重建节点：一次开合不能把键盘焦点甩掉
  const first = dom.sections[0].querySelector('.ptx-sec-h');
  api.decorateSettings();
  assert.equal(dom.sections[0].querySelector('.ptx-sec-h'), first, '已就位的标题按钮必须原样复用');
});

test('UI-WIRE-02: 折叠键稳定 —— 分节重排后仍是同一个分节收起', () => {
  const api = loadClient();
  const dom = buildSettingsDom(api, ['触发算法', '主题校准', '素材池与长图']);
  api.state.stage = 'settings';
  api.setViewport({ querySelector: (selector) => (selector === '.ptx-settings-shell' ? dom.shell : null) });
  api.decorateSettings();

  api.handleAction('toggle-section', dom.sections[1].querySelector('.ptx-sec-h'));
  assert.ok(dom.sections[1].classList.contains('is-collapsed'), '点一下即收起该分节');
  const stored = JSON.parse(api.storage.dump()[settingsKeyOf(api)]);
  assert.deepEqual(stored.collapsedSections, { 主题校准: true }, '持久化键就是分区标题，不是下标');

  // 运行时分组按服务端字段表增删 / 重排：主题校准换到第一位
  dom.main.children = [dom.sections[1], dom.sections[0], dom.sections[2]];
  api.decorateSettings();
  assert.ok(dom.sections[1].classList.contains('is-collapsed'), '重排后收起的仍是「主题校准」');
  assert.ok(!dom.sections[0].classList.contains('is-collapsed'), '「触发算法」不得替它收起');
  assert.equal(dom.sections[1].querySelector('.ptx-sec-h').getAttribute('aria-expanded'), 'false');

  // 旧版下标键（set-sec-N）读入时直接丢弃：它们只会把状态套到别的分区上
  api.storage.setItem(settingsKeyOf(api), JSON.stringify({
    autoDock: true,
    collapsedSections: { 'set-sec-0': true, 触发算法: true },
  }));
  assert.deepEqual(api.loadSettings().collapsedSections, { 触发算法: true }, '旧下标键不得复活');
});

test('UI-WIRE-03: 顶栏胶囊上的点击不启动拖窗', () => {
  const api = loadClient();
  const topbar = api.createElement('header', { class: 'ptx-topbar' });
  topbar.setAttribute('data-drag', '1');
  const filter = topbar.appendChild(api.createElement('div', { class: 'ptx-filter' }));
  const chip = filter.appendChild(api.createElement('div', { class: 'ptx-chip ptx-channel' }));
  const icon = chip.appendChild(api.createElement('svg'));
  const button = chip.appendChild(api.createElement('button'));
  const label = filter.appendChild(api.createElement('label', { class: 'ptx-chip' }));
  const input = label.appendChild(api.createElement('input'));
  const blank = topbar.appendChild(api.createElement('span', { class: 'ptx-id' }));
  const guarded = topbar.appendChild(api.createElement('div'));
  guarded.setAttribute('data-drag-guard', '1');
  const guardedChild = guarded.appendChild(api.createElement('span'));

  assert.equal(api.isDragGuardTarget(icon), true, '群聊胶囊里的图标不是把手');
  assert.equal(api.isDragGuardTarget(button), true, '按钮照旧不拖窗');
  assert.equal(api.isDragGuardTarget(label), true, '检索胶囊整块不拖窗');
  assert.equal(api.isDragGuardTarget(input), true);
  assert.equal(api.isDragGuardTarget(guardedChild), true, 'data-drag-guard 子树同样不拖窗');
  assert.equal(api.isDragGuardTarget(blank), false, '顶栏空白处仍然是拖窗把手');
  assert.equal(api.isDragGuardTarget(null), true, '没有目标时不拖窗');
});

test('UI-WIRE-04: 运行时开关在途时 disabled，连点只发一次请求', async () => {
  const api = loadClient();
  api.state.own = true;
  api.state.stage = 'entries';
  api.state.runtimeSettings.meta = [
    { section: 'trigger', key: 'quiescenceSeconds', label: '平息静默观察期（秒）', type: 'boolean' },
  ];
  api.state.runtimeSettings.sections = { trigger: { quiescenceSeconds: false } };
  api.state.runtimeSettings.seq = {};

  const control = api.createElement('button', { class: 'ptx-switch is-on' });
  control.setAttribute('data-cfg-section', 'trigger');
  control.setAttribute('data-cfg-key', 'quiescenceSeconds');
  control.setAttribute('data-cfg-type', 'boolean');

  let sent = 0;
  let release = null;
  api.setFetch(() => {
    sent += 1;
    return new Promise((resolve) => {
      release = () => resolve(okJson({ ok: true, value: { quiescenceSeconds: true } }));
    });
  });

  const first = api.saveRuntimeField(control);
  const second = api.saveRuntimeField(control); // 连点的第二次
  assert.equal(control.disabled, true, '请求在途时控件是原生 disabled（键盘也进不来）');
  assert.equal(sent, 1, '连点只发一次请求');
  release();
  await Promise.all([first, second]);
  assert.equal(control.disabled, false, '回执后解锁');
  assert.equal(sent, 1);

  // 回执失败同样解锁，且控件回到服务端现值
  api.state.runtimeSettings.sections.trigger.quiescenceSeconds = false;
  control.classList.add('is-on');
  api.setFetch(() => Promise.resolve(failJson(400, { ok: false, error: '值超出范围' })));
  const failing = api.saveRuntimeField(control);
  assert.equal(control.disabled, true);
  await failing;
  assert.equal(control.disabled, false, '失败也要解锁，否则开关永久点不动');
  assert.equal(control.classList.contains('is-on'), false, '失败回滚到服务端现值');

  // 图片匿名化开关走同一套在途去重
  api.setToast(api.createElement('div'));
  api.state.cardSettings.settings = { maskNames: true };
  let maskSent = 0;
  let releaseMask = null;
  api.setFetch(() => {
    maskSent += 1;
    return new Promise((resolve) => {
      releaseMask = () => resolve(okJson({ ok: true, settings: { maskNames: false } }));
    });
  });
  const maskButton = api.createElement('button', { class: 'ptx-switch is-on' });
  maskButton.setAttribute('data-action', 'toggle-card-mask');
  const maskFirst = api.toggleCardMask(maskButton);
  const maskSecond = api.toggleCardMask(maskButton);
  assert.equal(maskButton.disabled, true, '匿名化按钮在途时同样 disabled');
  assert.equal(maskSent, 1, '连点只发一次请求，不会把服务端来回切两遍');
  releaseMask();
  await Promise.all([maskFirst, maskSecond]);
  assert.equal(maskButton.disabled, false, '回执后恢复');
  assert.equal(maskButton.getAttribute('aria-checked'), 'false');
});

test('UI-WIRE-05: 保存一套提示词不覆盖另一套编辑区里的草稿', async () => {
  const api = loadClient();
  api.state.own = true;
  api.state.stage = 'settings';

  const customField = api.createElement('textarea');
  customField.setAttribute('data-prompt-kind', 'custom');
  const topicField = api.createElement('textarea');
  topicField.setAttribute('data-prompt-kind', 'topic');
  const saveCustomBtn = api.createElement('button');
  const saveTopicBtn = api.createElement('button');
  const toastNode = api.createElement('div');
  api.setToast(toastNode);

  api.setViewport({
    querySelector(selector) {
      if (selector === '[data-action="save-prompt"]') return saveCustomBtn;
      if (selector === '[data-action="save-topic-prompt"]') return saveTopicBtn;
      if (selector === '[data-prompt-kind="custom"]') return customField;
      if (selector === '[data-prompt-kind="topic"]') return topicField;
      return null;
    },
  });

  api.state.prompt.data = {
    customPrompt: '', defaultPrompt: '默认系统提示词', isCustom: false,
    topicEffectivePrompt: '服务端主题真值', topicDefaultPrompt: '默认主题提示词', isTopicCustom: false,
  };
  /* 整页重绘的替身：真实 renderStage 会用服务端真值把两套编辑区一起写回 */
  api.onRenderStage(() => {
    customField.value = api.state.prompt.data.customPrompt || api.state.prompt.data.defaultPrompt;
    topicField.value = api.state.prompt.data.topicEffectivePrompt || api.state.prompt.data.topicDefaultPrompt;
  });

  // 1) 保存主题提示词：系统提示词那套的草稿必须原样留着
  customField.value = '我的系统草稿（未保存）';
  topicField.value = '我的主题草稿';
  api.setFetch(() => Promise.resolve(okJson({
    customPrompt: '服务端系统值', defaultPrompt: '默认系统提示词', isCustom: false,
    topicEffectivePrompt: '提交后的主题提示词', topicDefaultPrompt: '默认主题提示词', isTopicCustom: true,
  })));
  await api.saveTopicPrompt();
  assert.equal(topicField.value, '提交后的主题提示词', '本次提交的那套按服务端回执回填');
  assert.equal(customField.value, '我的系统草稿（未保存）', '另一套的未保存草稿不得被服务端值覆盖');
  assert.equal(api.renderStageCalls(), 0, '保存提示词不得整页重绘');
  assert.equal(saveTopicBtn.disabled, false, '回执后按钮解锁');

  // 2) 反过来：保存系统提示词不得覆盖主题那套的草稿
  customField.value = '我的系统草稿 2';
  topicField.value = '我的主题草稿 2';
  api.setFetch(() => Promise.resolve(okJson({
    customPrompt: '我的系统草稿 2', defaultPrompt: '默认系统提示词', isCustom: true,
    topicEffectivePrompt: '服务端主题值', topicDefaultPrompt: '默认主题提示词', isTopicCustom: false,
  })));
  await api.savePrompt();
  assert.equal(customField.value, '我的系统草稿 2');
  assert.equal(topicField.value, '我的主题草稿 2', '主题编辑区的草稿不得被系统提示词的保存冲掉');
  assert.equal(api.renderStageCalls(), 0);
  assert.equal(saveCustomBtn.disabled, false);
});

test('UI-WIRE-06: 任一路刷新失败时绝不提示「已刷新」', async () => {
  const api = loadClient();
  api.state.own = true;
  api.state.stage = 'entries';
  const toastNode = api.createElement('div');
  api.setToast(toastNode);

  const routes = {
    '/api/entries': okJson([{ id: 'e1', title: '词条', summary: '', tags: [], status: 'open' }]),
    '/api/latest': okJson([]),
    '/api/status': okJson({ phase: 'IDLE' }),
    '/api/settings': okJson({ sections: {}, meta: [] }),
    '/api/card/settings': okJson({ settings: { maskNames: true } }),
    '/api/prompt': okJson({ customPrompt: '', defaultPrompt: '默认', isCustom: false, topicDefaultPrompt: '默认主题' }),
  };
  api.setFetch((url) => {
    const key = Object.keys(routes).find((entry) => String(url).includes(entry));
    if (!key) return Promise.reject(new Error(`probe: 未登记的路由 ${url}`));
    return Promise.resolve(routes[key]);
  });

  // 1) 监控那一路失败（5xx）：不能说「已刷新」
  routes['/api/status'] = failJson(503);
  await api.refreshAll();
  assert.ok(toastNode.innerHTML.includes('部分刷新失败'), '失败必须如实说出「部分刷新失败」');
  assert.ok(toastNode.innerHTML.includes('监控'), '要指出是哪一路失败');
  assert.ok(!toastNode.innerHTML.includes('已刷新'), '任一路失败时绝不能提示已刷新');

  // 2) 三路全绿才报「已刷新」
  routes['/api/status'] = okJson({ phase: 'IDLE' });
  await api.refreshAll();
  assert.ok(toastNode.innerHTML.includes('已刷新'));
  assert.ok(!toastNode.innerHTML.includes('部分刷新失败'));
});
