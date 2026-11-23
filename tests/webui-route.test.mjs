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
 * 关键回归点：挂载只看 `/plugins` 前缀，不能绑定某个实例 id —— 宿主换实例、换配置页路径时
 * 仍然必须挂上浮窗，否则那个实例完全没有 UI。软校验（标题 / 面包屑 / 路径里的插件标识）
 * 只决定要不要自动展开，绝不阻止挂载。
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

test('ROUTE-01: /plugins/0848oh 命中软校验并展开面板', () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Patchouli Knowledge · Koishi' });
  api.checkRoute();

  assert.equal(api.mountCount(), 1, '插件页必须挂载浮窗');
  assert.equal(api.state.mounted, true);
  assert.equal(api.state.visible, true);
  assert.equal(api.state.collapsed, false, '软校验命中：面板直接展开');
  assert.equal(api.classes('root').includes('ptx-hidden'), false, '命中后必须摘掉隐藏态');
});

test('ROUTE-02: 不同实例 id（/plugins/abc123）仍然挂载 —— 回归点', () => {
  // 路径里既没有 0848oh 也没有插件名，页面文本也读不到任何标识
  const api = loadClient({ pathname: '/plugins/abc123' });
  api.checkRoute();

  assert.equal(api.mountCount(), 1, '换实例 id 也必须挂载，否则该实例完全没有入口');
  assert.equal(api.state.visible, true);
  assert.equal(api.state.collapsed, true, '认不出本插件页时只保留胶囊');
  assert.equal(api.classes('frame').includes('is-collapsed'), true, '窗口收回 = 最小胶囊形态');
  assert.equal(api.classes('pill').includes('is-visible'), true, '胶囊必须是收回态下的唯一入口');
  assert.equal(api.classes('root').includes('ptx-hidden'), false);
});

test('ROUTE-03: /plugins/patchouli-knowledge:xyz 挂载（路径自带插件标识）', () => {
  const api = loadClient({ pathname: '/plugins/patchouli-knowledge:xyz' });
  api.checkRoute();

  assert.equal(api.mountCount(), 1);
  assert.equal(api.state.visible, true);
  assert.equal(api.state.collapsed, false, '路径命中插件名即认定为配置页，直接展开');
});

test('ROUTE-04: 非插件页 /other/path 不挂载', () => {
  const api = loadClient({ pathname: '/other/path', title: 'Patchouli Knowledge' });
  api.checkRoute();

  assert.equal(api.mountCount(), 0, '插件页之外不得挂载');
  assert.equal(api.state.visible, false);
});

test('ROUTE-05: 软校验文本没有任何标识时也不阻止挂载', () => {
  const api = loadClient({
    pathname: '/plugins/abc123',
    title: '插件市场 · Koishi',
    breadcrumb: '今日运势 / 配置',
  });
  api.checkRoute();

  assert.equal(api.mountCount(), 1, '软校验失败只影响是否自动展开，绝不阻止挂载');
  assert.equal(api.state.visible, true);
  assert.equal(api.state.collapsed, true, '不认识的页面保持最小胶囊，不遮挡宿主');
  assert.equal(api.routeMatches(), true);
});

test('ROUTE-06: hash 路由 /#/plugins/xxx 同样挂载', () => {
  const api = loadClient({ pathname: '/', hash: '#/plugins/abc123' });
  api.checkRoute();

  assert.equal(api.mountCount(), 1, 'hash 路由的插件页同样需要入口');
  assert.equal(api.state.visible, true);
});

test('ROUTE-07: 软校验迟到命中时自动展开一次，且不重复挂载', () => {
  const api = loadClient({ pathname: '/plugins/abc123' });
  api.checkRoute();
  assert.equal(api.state.collapsed, true, '第一轮读不到标识：先只留胶囊');

  // 宿主 SPA 随后画出标题 / 面包屑
  api.doc.title = 'LLMWiki 知识库 · Koishi';
  api.checkRoute();
  assert.equal(api.state.collapsed, false, '迟到命中：自动展开一次');
  assert.equal(api.mountCount(), 1, '重复判定不得重复挂载');

  // 用户手动收回后不再被掀开
  api.state.collapsed = true;
  api.checkRoute();
  assert.equal(api.state.collapsed, true, '自动展开每页只做一次，用户收回后不得再弹开');
});

test('ROUTE-08: 离开插件页恢复隐藏，返回后重新挂载判定', () => {
  const api = loadClient({ pathname: '/plugins/abc123' });
  api.checkRoute();
  assert.equal(api.state.visible, true);

  api.win.location.pathname = '/other/path';
  api.checkRoute();
  assert.equal(api.state.visible, false, '离开插件页必须隐藏浮窗');
  assert.equal(api.classes('root').includes('ptx-hidden'), true);

  api.win.location.pathname = '/plugins/abc123';
  api.checkRoute();
  assert.equal(api.state.visible, true, '回到插件页重新显示');
  assert.equal(api.mountCount(), 1, '壳层复用，不重复挂载');
});
