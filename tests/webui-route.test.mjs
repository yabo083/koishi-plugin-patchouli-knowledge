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
 * 两个判定必须分开（R1 回归根因：把它们耦在一起会让浮窗整块消失）：
 * - **挂载**：任何 `/plugins/**` 页面都挂 —— 宿主用随机实例 id 渲染插件页时，页面名字与身份文本
 *   都可能读不到；不挂载等于用户根本看不到入口。
 * - **展开 + 全屏鉴权门**：只在本插件页（`/plugins/patchouli-knowledge[:实例id]`，或随机实例 id
 *   但标题 / 面包屑 / data-plugin-name 认出本插件）。别的插件页只留一个悬浮胶囊。
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
  /* 数据面的「零请求」断言靠这个记账桩：产物里的 `fetch` 与生成块抓到的
     `window.fetch` 都指向它，任何一条 /api 请求都躲不过去。 */
  const requests = [];
  const fetchStub = (input) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    requests.push(String(url));
    return Promise.reject(new Error('probe: no network'));
  };
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
    fetch: fetchStub,
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

  const api = factory(
    windowStub,
    documentStub,
    fetchStub,
    () => 0,
    noop,
    // setTimeout 桩：idle 自动收纳 / 折叠过渡都不在断言范围内，且不拖住事件循环
    () => 0,
    noop,
    () => 0,
    noop,
  );

  /* 产物自带真实门禁实现（会 `document.body.appendChild` 弹模态）；测试里换成记账桩：
     本文件断言的是「该不该开关门禁」，不是模态长什么样。 */
  const auth = { gates: 0, dismissals: 0, ownPage: null };
  auth.gate = () => { auth.gates += 1; };
  auth.dismiss = () => { auth.dismissals += 1; };
  /* 生成块按这个标记决定 401 要不要重弹门禁：路由判定必须把它同步过去。 */
  auth.setOwnPage = (value) => { auth.ownPage = value === true; };
  auth.isOwnPage = () => auth.ownPage === true;
  windowStub.__ptxAuth = auth;

  return { ...api, auth, requests: () => requests.slice() };
}

test('ROUTE-01: 随机实例 id + 页面身份文本命中时挂载并展开（真实部署形态）', () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Patchouli Knowledge · Koishi' });
  api.checkRoute();

  assert.equal(api.routeMatches(), true, '身份文本认出本插件即为本插件页');
  assert.equal(api.mountCount(), 1, '本插件页必须挂载浮窗');
  assert.equal(api.state.visible, true);
  assert.equal(api.state.collapsed, false, '身份命中：面板直接展开');
  assert.equal(api.classes('root').includes('ptx-hidden'), false, '命中后必须摘掉隐藏态');
  assert.equal(api.auth.gates, 1, '本插件页打开即门禁');
});

test('ROUTE-02: 别的插件的插件页挂载但不展开、不弹鉴权门 —— C1/R1 边界', () => {
  const api = loadClient({
    pathname: '/plugins/adapter-onebot',
    title: '适配器 · Koishi',
    breadcrumb: 'Koishi 控制台 / 插件配置 / onebot',
  });
  let gates = 0;
  let dismissals = 0;
  api.auth.gate = () => { gates += 1; };
  api.auth.dismiss = () => { dismissals += 1; };
  api.checkRoute();

  assert.equal(api.routeMatches(), false, '别的插件页不是本插件页');
  assert.equal(api.mountCount(), 1, '插件页就是浮窗入口：别的插件页也要挂载');
  assert.equal(api.state.mounted, true);
  assert.equal(gates, 0, '陌生插件页绝不能弹全屏鉴权遮罩');
  assert.equal(dismissals, 0, '没开过门禁就无需收起');
  assert.equal(api.auth.ownPage, false, '本页标记必须同步给生成块：401 兜底也只认它');
  assert.equal(api.state.own, false);
  assert.equal(api.state.dataFlow, false, '别的插件页不启动数据面');
  assert.deepEqual(api.requests(), [], '别的插件页零请求：既不为不可见页取数，也就没有 401 去弹门禁');
  assert.equal(api.state.collapsed, true, '未认领的插件页只留悬浮胶囊');
  assert.equal(api.classes('pill').includes('is-visible'), true, '胶囊是未认领页面上的唯一入口');
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

test('ROUTE-07: 身份文本迟到时先挂载但不展开，认出后自动展开一次', () => {
  const api = loadClient({ pathname: '/plugins/abc123' });
  api.checkRoute();
  assert.equal(api.mountCount(), 1, '随机实例 id 且读不到标识：仍要挂载（R1：浮窗不得整块消失）');
  assert.equal(api.state.collapsed, true, '身份没认出：只留胶囊，不遮住宿主页面');
  assert.equal(api.classes('pill').includes('is-visible'), true);

  // 宿主 SPA 随后画出标题 / 面包屑
  api.doc.title = 'LLMWiki 知识库 · Koishi';
  api.checkRoute();
  assert.equal(api.mountCount(), 1, '身份迟到只展开，不重复挂载');
  assert.equal(api.state.collapsed, false, '认出本插件后自动展开');
  assert.equal(api.classes('root').includes('ptx-hidden'), false);

  // 用户手动收回后不再被掀开；重复判定不得重复挂载
  api.state.collapsed = true;
  api.checkRoute();
  assert.equal(api.state.collapsed, true, '自动展开每页只做一次，用户收回后不得再弹开');
  assert.equal(api.mountCount(), 1, '重复判定不得重复挂载');
});

test('ROUTE-08: 离开插件页收起门禁与浮窗；换到别的插件页只留胶囊；返回本插件页重新展开并重新门禁', () => {
  const api = loadClient({ pathname: '/plugins/patchouli-knowledge' });
  api.checkRoute();
  assert.equal(api.state.visible, true);

  api.win.location.pathname = '/other/path';
  let gates = 0;
  let dismissed = 0;
  // 门禁模态由生成块挂在 body 上：离开插件页必须把它收起来。
  api.auth.gate = () => { gates += 1; };
  api.auth.dismiss = () => { dismissed += 1; };
  api.checkRoute();
  assert.equal(dismissed, 1, '离开插件页必须收起鉴权模态，别让它跟着盖住别的页面');
  assert.equal(api.state.visible, false, '离开插件页必须隐藏浮窗');
  assert.equal(api.classes('root').includes('ptx-hidden'), true);

  // 换到别的插件的插件页：浮窗回来但只留胶囊 —— 整窗与鉴权遮罩都不能跟过去。
  api.doc.title = '适配器 · Koishi';
  api.win.location.pathname = '/plugins/adapter-onebot';
  api.checkRoute();
  assert.equal(api.mountCount(), 1, '壳层复用，不重复挂载');
  assert.equal(api.state.visible, true, '插件页上胶囊要在');
  assert.equal(api.state.collapsed, true, '别的插件页上整窗不得展开');
  assert.equal(gates, 0, '别的插件页绝不弹门禁');

  api.win.location.pathname = '/plugins/patchouli-knowledge';
  api.checkRoute();
  assert.equal(api.state.collapsed, false, '回到本插件页重新展开');
  assert.equal(gates, 1, '回到本插件页重新门禁');
  assert.equal(api.mountCount(), 1, '壳层复用，不重复挂载');
});

test('ROUTE-09: 随机实例 id + 首帧读不到任何身份文本 → 仍挂载、不展开、不弹门禁（R1 回归）', () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: '', breadcrumb: '' });
  api.checkRoute();

  assert.equal(api.routeMatches(), false, '认不出身份：不当作本插件页');
  assert.equal(api.mountCount(), 1, '读不到标题也必须挂载 —— R1 的根因就是这里不 mount');
  assert.equal(api.state.mounted, true);
  assert.equal(api.classes('root').includes('ptx-hidden'), false, '挂载后必须摘掉隐藏态，用户才看得到胶囊');
  assert.equal(api.classes('pill').includes('is-visible'), true, '未认领的页面留胶囊当入口');
  assert.equal(api.state.collapsed, true, '身份没认出时只留胶囊，整窗不盖住宿主表单');
  assert.equal(api.auth.gates, 0, '认不出身份不得弹全屏鉴权门');
  assert.equal(api.auth.dismissals, 0, '没开过门禁就无需收起');
  assert.equal(api.auth.ownPage, false, '身份没认出就不是本插件页：401 兜底也只认这个标记');
  assert.deepEqual(api.requests(), [], '认不出身份时一个 /api 请求都不发（首帧零请求）');
});

test('ROUTE-10: 本插件页 own 变真才启动数据面；离开本插件页立刻停掉，不再为不可见页取数', () => {
  const api = loadClient({ pathname: '/plugins/adapter-onebot', title: '适配器 · Koishi' });
  api.checkRoute();
  assert.deepEqual(api.requests(), [], '别的插件页挂载壳层但零请求');
  assert.equal(api.state.dataFlow, false);

  // 换到本插件页：同一个壳层复用，own 变真 → 数据面启动
  api.doc.title = '知识库 · Koishi';
  api.win.location.pathname = '/plugins/0848oh';
  api.checkRoute();
  assert.equal(api.state.collapsed, false);
  assert.equal(api.state.own, true);
  assert.equal(api.auth.ownPage, true, '本插件页必须把标记同步给生成块');
  assert.equal(api.state.dataFlow, true, 'own 变真即启动数据面');
  const started = api.requests();
  assert.ok(started.length > 0, '本插件页 own 后开始取数');
  assert.equal(
    started.every((url) => url.startsWith('/patchouli/api/')),
    true,
    '首次取数只打 /api（没有别的请求被顺手发出去）',
  );

  // 回到别的插件页：own 变假 → 数据面停止，之后不再多发一个请求
  api.doc.title = '适配器 · Koishi';
  api.win.location.pathname = '/plugins/adapter-onebot';
  api.checkRoute();
  assert.equal(api.state.own, false);
  assert.equal(api.auth.ownPage, false);
  assert.equal(api.state.dataFlow, false, '离开本插件页立刻停掉数据面');
  const settled = api.requests().length;
  api.checkRoute();
  api.checkRoute();
  assert.equal(api.requests().length, settled, '数据面停掉后轮询链不再续，请求数不增长');
});
