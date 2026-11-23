import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 浮窗挂载路由契约。
 *
 * 独立页 `/patchouli` 已删除，console 浮窗是唯一入口；它的路由判定在 `client/dist/index.js`
 * 的 `checkRoute()` 里。这里按既有 WEBUI 契约测试的路径把产物当函数体载入（只替换掉 default
 * 导出），用最小 DOM 桩驱动 `checkRoute()`，断言的是「哪些路径会挂载」而非渲染细节。
 *
 * 关键回归点：浮窗只认**本插件**的插件页 —— `/plugins/patchouli-knowledge[:实例id]`，或名字是宿主
 * 生成的随机实例 id 但页面身份文本（标题 / 面包屑 / data-plugin-name）认出本插件。别的插件页一律
 * 不挂载：宽泛的 `/plugins` 前缀会把全屏鉴权遮罩盖到别人的配置页上。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');

const noop = () => {};

function createNode() {
  const classes = new Set();
  return {
    __classes: classes,
    classList: {
      add: (...names) => { for (const name of names) classes.add(name); },
      remove: (...names) => { for (const name of names) classes.delete(name); },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    style: {},
    offsetWidth: 820,
    offsetHeight: 560,
    offsetLeft: 0,
    offsetTop: 0,
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    querySelector: () => null,
  };
}

/**
 * 载入产物并按用例摆好宿主环境。
 * `mount()` 被替换成记账桩：真壳层需要完整 DOM，而本文件只断言挂载 / 收回的判定。
 */
function loadClient({ pathname = '/', hash = '', search = '', title = '', breadcrumb = '' }) {
  const windowStub = {
    location: { pathname, hash, search },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    getComputedStyle: () => ({ left: '0px', top: '0px' }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    // 产物顶层的门禁 IIFE 会 `window.fetch.bind(window)`：桩上必须有它，否则载入即失败
    fetch: () => Promise.reject(new Error('probe: no network')),
    CustomEvent: function CustomEvent() {},
  };
  const documentStub = {
    readyState: 'complete',
    hidden: false,
    title,
    documentElement: null,
    body: null,
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
    querySelector: (selector) => (breadcrumb && selector === '.el-breadcrumb' ? { textContent: breadcrumb } : null),
    querySelectorAll: () => [],
    createElement: () => createNode(),
  };

  const body = CLIENT_SOURCE.replace(
    'export default function applyPatchouliWikiReader',
    'function applyPatchouliWikiReader',
  );
  const factory = new Function(
    'window', 'document', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    `${body}
let __mounts = 0;
function __stateNode() {
  const classes = new Set();
  return {
    __classes: classes,
    classList: {
      add: function () { for (let i = 0; i < arguments.length; i += 1) classes.add(arguments[i]); },
      remove: function () { for (let i = 0; i < arguments.length; i += 1) classes.delete(arguments[i]); },
      contains: function (name) { return classes.has(name); },
      toggle: function (name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    },
    style: {},
    offsetWidth: 820,
    offsetHeight: 560,
    offsetLeft: 0,
    offsetTop: 0,
    setAttribute: function () {},
    getAttribute: function () { return null; },
    removeAttribute: function () {},
    addEventListener: function () {},
    removeEventListener: function () {},
    appendChild: function () {},
    querySelector: function () { return null; },
  };
}
mount = function () {
  __mounts += 1;
  rootEl = __stateNode();
  frameEl = __stateNode();
  pillEl = __stateNode();
  state.mounted = true;
  state.stage = 'entries';
};
return {
  checkRoute,
  routeMatches,
  state,
  win: window,
  doc: document,
  mountCount: function () { return __mounts; },
  classes: function (which) {
    const node = which === 'root' ? rootEl : which === 'frame' ? frameEl : pillEl;
    return node ? Array.from(node.__classes) : [];
  },
};`,
  );

  return factory(
    windowStub,
    documentStub,
    () => Promise.reject(new Error('probe: no network')),
    () => 0,
    noop,
    // setTimeout 桩：idle 自动收纳 / 折叠过渡都不在断言范围内，且不拖住事件循环
    () => 0,
    noop,
    () => 0,
    noop,
  );
}

test('ROUTE-01: 随机实例 id + 页面身份文本命中时挂载并展开（真实部署形态）', () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Patchouli Knowledge · Koishi' });
  api.checkRoute();

  assert.equal(api.routeMatches(), true, '身份文本认出本插件即为本插件页');
  assert.equal(api.mountCount(), 1, '本插件页必须挂载浮窗');
  assert.equal(api.state.visible, true);
  assert.equal(api.state.collapsed, false, '身份命中：面板直接展开');
  assert.equal(api.classes('root').includes('ptx-hidden'), false, '命中后必须摘掉隐藏态');
});

test('ROUTE-02: 别的插件的插件页不挂载 —— C1 回归（不得被鉴权遮罩盖住）', () => {
  const api = loadClient({
    pathname: '/plugins/adapter-onebot',
    title: '适配器 · Koishi',
    breadcrumb: 'Koishi 控制台 / 插件配置 / onebot',
  });
  api.checkRoute();

  assert.equal(api.routeMatches(), false);
  assert.equal(api.mountCount(), 0, '陌生插件页一律不挂载，否则全屏门禁会盖住宿主页面');
  assert.equal(api.state.mounted, false);
  assert.equal(api.state.visible, false);
});

test('ROUTE-03: /plugins/patchouli-knowledge:实例id 按名字挂载，无需身份文本', () => {
  const api = loadClient({ pathname: '/plugins/patchouli-knowledge:xyz' });
  api.checkRoute();

  assert.equal(api.routeMatches(), true);
  assert.equal(api.mountCount(), 1);
  assert.equal(api.state.visible, true);
  assert.equal(api.state.collapsed, false, '名字命中即认定为配置页，直接展开');
});

test('ROUTE-04: 非插件页 /other/path 不挂载（标题里带插件名也不算）', () => {
  const api = loadClient({ pathname: '/other/path', title: 'Patchouli Knowledge' });
  api.checkRoute();

  assert.equal(api.mountCount(), 0, '插件页之外不得挂载');
  assert.equal(api.state.visible, false);
});

test('ROUTE-05: /plugins/patchouli-knowledge 名字命中，软校验文本为空也照常挂载', () => {
  const api = loadClient({
    pathname: '/plugins/patchouli-knowledge',
    title: 'Koishi',
    breadcrumb: '插件配置',
  });
  api.checkRoute();

  assert.equal(api.routeMatches(), true, '插件名本身就是唯一身份');
  assert.equal(api.mountCount(), 1);
  assert.equal(api.state.collapsed, false);
});

test('ROUTE-06: hash 路由 /#/plugins/patchouli-knowledge 同样挂载', () => {
  const api = loadClient({ pathname: '/', hash: '#/plugins/patchouli-knowledge' });
  api.checkRoute();

  assert.equal(api.routeMatches(), true);
  assert.equal(api.mountCount(), 1, 'hash 路由的插件页同样需要入口');
  assert.equal(api.state.visible, true);
});

test('ROUTE-07: 身份文本迟到时先不挂载，认出后只挂载一次并自动展开', () => {
  const api = loadClient({ pathname: '/plugins/abc123' });
  api.checkRoute();
  assert.equal(api.mountCount(), 0, '随机实例 id + 读不到标识：先不认领，别遮住宿主');

  // 宿主 SPA 随后画出标题 / 面包屑
  api.doc.title = 'LLMWiki 知识库 · Koishi';
  api.checkRoute();
  assert.equal(api.mountCount(), 1, '认出本插件后挂载一次');
  assert.equal(api.state.collapsed, false, '首帧即展开');
  assert.equal(api.classes('root').includes('ptx-hidden'), false);

  // 用户手动收回后不再被掀开；重复判定不得重复挂载
  api.state.collapsed = true;
  api.checkRoute();
  assert.equal(api.state.collapsed, true, '自动展开每页只做一次，用户收回后不得再弹开');
  assert.equal(api.mountCount(), 1, '重复判定不得重复挂载');
});

test('ROUTE-08: 离开本插件页恢复隐藏，换到别的插件页仍隐藏，返回后重新显示', () => {
  const api = loadClient({ pathname: '/plugins/patchouli-knowledge' });
  api.checkRoute();
  assert.equal(api.state.visible, true);

  api.win.location.pathname = '/other/path';
  let dismissed = 0;
  // 门禁模态由生成块挂在 body 上：离开本插件页必须把它收起来。
  api.win.__ptxAuth = { dismiss: () => { dismissed += 1; } };
  api.checkRoute();
  assert.equal(dismissed, 1, '离开本插件页必须收起鉴权模态，别让它跟着盖住别的插件页');
  assert.equal(api.state.visible, false, '离开插件页必须隐藏浮窗');
  assert.equal(api.classes('root').includes('ptx-hidden'), true);

  // 换到别的插件的插件页：仍然隐藏 —— 浮窗与鉴权遮罩都不能跟过去。
  api.doc.title = '适配器 · Koishi';
  api.win.location.pathname = '/plugins/adapter-onebot';
  api.checkRoute();
  assert.equal(api.state.visible, false, '别的插件页不得恢复浮窗');

  api.win.location.pathname = '/plugins/patchouli-knowledge';
  api.checkRoute();
  assert.equal(api.state.visible, true, '回到本插件页重新显示');
  assert.equal(api.mountCount(), 1, '壳层复用，不重复挂载');
});
