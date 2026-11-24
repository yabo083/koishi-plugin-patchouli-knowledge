import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 浮窗挂载路由契约。
 *
 * 独立页 `/patchouli` 已删除，console 浮窗是唯一入口；它的路由判定在 `client/dist/index.js`
 * 的 `checkRoute()` 里。这里按既有 WEBUI 契约测试的路径把产物当函数体载入（只替换掉 default
 * 导出），用最小 DOM 桩驱动 `checkRoute()`，断言的是「哪些路径会挂载 / 认领」而非渲染细节。
 *
 * 三个判定必须分开（R1 回归根因：把前两个耦在一起会让浮窗整块消失）：
 * - **挂载**：任何 `/plugins/**` 页面都挂 —— 宿主用随机实例 id 渲染插件页时，页面名字与身份
 *   元数据都可能读不到；不挂载等于用户根本看不到入口。
 * - **自动认领**：只读元数据（`document.title` / `[data-plugin-name]` / `[data-plugin]` /
 *   `.el-breadcrumb` / `h1`）。正文文本与宽容器一概不读：页面归属是开集问题，靠正文猜挡不住
 *   下一条反例（SPA 残留的旧视图、隐藏子树、别的插件表单里写着「知识库」…）。
 * - **点开即认领**：用户点胶囊（`data-act="expand"` → `expandPanel()`）就是明确意图，
 *   认领跟着本页走，路由 key 一变立刻作废。
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
 * 监控视图的记账桩：`updateMetrics()` / `drawTraffic()` / `renderLatestMessage()` 只经
 * `querySelector` 读写，所以这里按选择器记忆节点，把 textContent / dataset / 属性留在原地。
 * ROUTE-14 断言的是「屏上还留着什么」（指标、预览、曲线），而不是渲染细节。
 */
function fakeMetricsView() {
  const children = new Map();
  const node = {
    textContent: '',
    dataset: {},
    attrs: {},
    firstChild: null,
    isConnected: true,
    style: {},
    classList: { add: noop, remove: noop, contains: () => false, toggle: () => true },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name] === undefined ? null : node.attrs[name]; },
    removeAttribute: noop,
    addEventListener: noop,
    removeEventListener: noop,
    innerHTML: '',
    appendChild: noop,
    removeChild: noop,
    querySelectorAll: () => [],
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, fakeMetricsView());
      return children.get(selector);
    },
  };
  return node;
}

/** 等一轮宏任务：读请求的 promise 链（loadStatus / loadEntries …）全在微任务里结算。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 载入产物并按用例摆好宿主环境。
 * `mount()` 被替换成记账桩：真壳层需要完整 DOM，而本文件只断言挂载 / 收回的判定。
 *
 * - `nodes`：页面身份取样点（选择器 → { text, panel }）。`panel: true` 表示这个节点画在浮窗
 *   自己的 DOM 里（壳层文案带专有名字），必须被丢弃，否则挂载即自我认领。
 * - `apiMissing`：`/patchouli/api/*` 全部回 404 + 非 JSON（插件没启用 / 路径被反代吞掉），
 *   用来验证「接口不可用」与「连接中断」分开说。
 * - `bodyFault`：响应头正常但 body 流读取失败（宿主 / 反代中途 reset）。
 *   这种失败在浏览器里是 `res.text()` 抛 TypeError，属于连接层，不是「非 JSON」。
 */
function loadClient({
  pathname = '/', hash = '', search = '', title = '', breadcrumb = '', nodes = null,
  apiMissing = false, bodyFault = false,
}) {
  /* 数据面的「零请求」断言靠这个记账桩：产物里的 `fetch` 与生成块抓到的
     `window.fetch` 都指向它，任何一条 /api 请求都躲不过去。 */
  const requests = [];
  const fetchStub = (input) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    requests.push(String(url));
    if (bodyFault) {
      /* 头拿到了、body 流被 reset：读响应体时抛 TypeError（连接层错误） */
      const reset = () => Promise.reject(new TypeError('terminated'));
      return Promise.resolve({ ok: true, status: 200, text: reset, json: reset });
    }
    if (apiMissing) {
      /* 形状同真实 404：ok 为假、body 不是 JSON（静态站 / 反代兜底页） */
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      });
    }
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
  /* 身份取样点：只有这五个选择器会被读，正文一个字符都不取。
     产物不再有 TreeWalker 取样，桩里也就不提供 `createTreeWalker` —— 任何回退到正文遍历的
     写法会立刻在 ROUTE-12/21 上失败。 */
  const sampleNode = (entry) => ({
    textContent: entry.text,
    id: '',
    parentNode: entry.panel ? { id: 'patchouli-organic-root', parentNode: null } : { nodeName: 'DIV', parentNode: null },
  });
  const documentStub = {
    readyState: 'complete',
    hidden: false,
    title,
    documentElement: null,
    body: { nodeName: 'BODY', appendChild: noop, removeChild: noop, addEventListener: noop, querySelector: () => null, getAttribute: () => null },
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
    querySelector: (selector) => {
      if (breadcrumb && selector === '.el-breadcrumb') return { textContent: breadcrumb, id: '', parentNode: null };
      const entry = nodes && nodes[selector];
      return entry ? sampleNode(entry) : null;
    },
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
  /* 属性留档：refreshPhase 把阶段写在 frameEl 的 data-phase 上，
     屏上的那一格就是这里（真实壳层读 phaseEl，桩里没有它）。 */
  const attrs = {};
  return {
    __classes: classes,
    __attrs: attrs,
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
    setAttribute: function (name, value) { attrs[name] = String(value); },
    getAttribute: function () { return null; },
    removeAttribute: function () {},
    addEventListener: function () {},
    removeEventListener: function () {},
    appendChild: function () {},
    querySelectorAll: function () { return []; },
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
  /* 胶囊的 data-act="expand" 委派到 expandPanel；mount 被桩掉时没有事件绑定，
     测试直接调用同一个入口，语义与用户点开胶囊一致。 */
  expandPanel,
  monitorStatusText,
  phaseLabel,
  refreshPhase,
  /* 监控视图换成记账桩，并留一条「屏上显示态」的读数（ROUTE-14）。 */
  setViewport: function (node) { viewportEl = node; },
  updateMetrics,
  paint: function () {
    return { points: trafficPoints.length, channel: trafficChannel, anchor: trafficAnchor, frame: trafficFrame };
  },
  probeState: function () {
    return {
      key: routeProbe.key,
      identified: routeProbe.identified,
      promoted: routeProbe.promoted,
      userClaimed: routeProbe.userClaimed,
    };
  },
  mountCount: function () { return __mounts; },
  classes: function (which) {
    const node = which === 'root' ? rootEl : which === 'frame' ? frameEl : pillEl;
    return node ? Array.from(node.__classes) : [];
  },
  /* 屏上的状态格：真实壳层画在 phaseEl 的 data-phase 上；桩 mount 不建 phaseEl，
     refreshPhase 写下的那份就在 frameEl 的同名属性里。 */
  phase: function () {
    return frameEl && frameEl.__attrs ? frameEl.__attrs['data-phase'] : null;
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

test('ROUTE-01: 随机实例 id + 标题命中时挂载并展开（真实部署形态）', () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Patchouli Knowledge · Koishi' });
  api.checkRoute();

  assert.equal(api.routeMatches(), true, '标题认出本插件即为本插件页');
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

test('ROUTE-03: /plugins/patchouli-knowledge:实例id 按名字挂载，无需身份元数据', () => {
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

test('ROUTE-05: /plugins/patchouli-knowledge 名字命中，身份元数据为空也照常挂载', () => {
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

test('ROUTE-07: 身份元数据迟到时先挂载但不展开，认出后自动展开一次', () => {
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

test('ROUTE-09: 随机实例 id + 读不到任何身份元数据 → 仍挂载、不展开、不弹门禁（R1 回归）', () => {
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

test('ROUTE-11: 随机实例 id + 元数据不含身份 → 点开胶囊即认领本页并开始取数', async () => {
  const api = loadClient({
    pathname: '/plugins/0848oh',
    title: 'Koishi',
    breadcrumb: 'Koishi 控制台 / 插件配置',
  });
  api.checkRoute();

  assert.equal(api.state.own, false, '首帧元数据不命中：先不认领');
  assert.equal(api.state.collapsed, true, '只留胶囊，整窗不盖住宿主表单');
  assert.deepEqual(api.requests(), [], '认领之前一个 /api 请求都不发');

  // 用户点开胶囊（data-act="expand" → expandPanel）：这是「我要用这个面板」的唯一凭据
  api.expandPanel();

  assert.equal(api.state.own, true, '点开即认领本页');
  assert.equal(api.auth.ownPage, true, '认领结果必须同步给生成块');
  assert.equal(api.state.collapsed, false, '点开就是展开，不留在胶囊态');
  assert.equal(api.auth.gates, 1, '认领本页即弹门禁');
  const started = api.requests();
  assert.ok(started.length > 0, '认领后立刻启动数据面');
  assert.equal(
    started.every((url) => url.startsWith('/patchouli/api/')),
    true,
    '认领本身零请求：取数只打 /api',
  );
  assert.equal(api.probeState().userClaimed, true, '认领记在本页上');

  // 下一轮路由判定不能把用户刚认领的页收回去
  api.checkRoute();
  assert.equal(api.state.own, true, '轮询判定不得反悔用户的认领');
  assert.equal(api.state.dataFlow, true, '数据面保持运行');
  assert.equal(api.state.collapsed, false, '面板保持展开');
  assert.equal(api.auth.dismissals, 0, '不得因为下一轮判定收起门禁');

  // 网络层失败仍是「断线」，不是「接口不可用」
  await settle();
  assert.equal(api.state.apiUnavailable, false, '网络错误不算接口不可用');
  assert.equal(api.monitorStatusText(), '连接中断，保留最后一次数据');
});

test('ROUTE-12: 随机实例 id + 元数据不含身份且没人点开 → 未认领、零请求、文案区分「不是本插件页」', () => {
  const api = loadClient({
    pathname: '/plugins/0848oh',
    title: 'Koishi',
    breadcrumb: 'Koishi 控制台 / 插件配置',
  });
  api.checkRoute();
  assert.equal(api.state.own, false);
  assert.equal(api.monitorStatusText(), '当前不是本插件页', '未认领页面的监控条不得报「连接中断」');

  // 轮询几轮也不会自己认领：没有元数据、没人点开，就没有认领
  api.checkRoute();
  api.checkRoute();

  assert.equal(api.state.own, false, '元数据认不出：不认领');
  assert.deepEqual(api.requests(), [], '不认领就不发一个请求');
  assert.equal(api.auth.gates, 0, '认不出身份不得弹全屏门禁');
  assert.equal(api.state.dataFlow, false, '不启动数据面');
  assert.equal(api.state.collapsed, true, '仍是胶囊');
  assert.equal(api.phaseLabel('UNOWNED'), '当前不是本插件页', '状态胶囊同样区分未认领与断线');
  assert.equal(api.phaseLabel('OFFLINE'), '连接中断', '真断线的文案保持不变');
});

test('ROUTE-13: 取样边界 —— 宽容器不参与判定，浮窗自身 DOM 里的元数据也不算页面身份', () => {
  // 宽容器（`[class*="plugin"]`）里写着专有名字：这一档已从产物里删除，读都不该读
  const wide = loadClient({
    pathname: '/plugins/0848oh',
    title: '',
    breadcrumb: '',
    nodes: { '[class*="plugin"]': { text: '知识阅读器 频道白名单 索引重建' } },
  });
  wide.checkRoute();
  assert.equal(wide.routeMatches(), false, '宽容器文本不再是身份凭据');
  assert.equal(wide.state.own, false);
  assert.equal(wide.state.collapsed, true, '未认领：整窗不盖住宿主表单');
  assert.deepEqual(wide.requests(), [], '误认领会连带为一个别人的页取数 —— 必须零请求');
  assert.equal(wide.auth.gates, 0);

  // 精确源落在浮窗自己的 DOM 里：壳层文案带「LLMWiki 知识阅读器」，读进来就是自我认领
  const own = loadClient({
    pathname: '/plugins/adapter-onebot',
    title: '适配器 · Koishi',
    nodes: { h1: { text: 'LLMWiki 知识阅读器', panel: true } },
  });
  own.checkRoute();
  assert.equal(own.routeMatches(), false, '浮窗自己的标题不是页面身份');
  assert.equal(own.state.own, false);
  assert.deepEqual(own.requests(), [], '自我认领会把别人的插件页变成取数页 —— 必须零请求');
});

test('ROUTE-14: 非本页但频道不变 → 指标/预览/图表清空，回本页后缓存可再显示', () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Patchouli Knowledge · Koishi' });
  api.checkRoute();
  assert.equal(api.state.own, true);

  const view = fakeMetricsView();
  api.setViewport(view);
  api.state.stage = 'metrics';
  /* 群聊作用域与快照里的 channelId 一致：这正是 G1 的漏点 ——
     旧写法「频道变了才清」在这里整段跳过，整窗带着上一页的指标去了别的插件页。 */
  api.state.channel = '1024';
  api.state.status = {
    channelId: '1024',
    serverTime: 1700000000000,
    currentRate: 12.5,
    baselineRate: 3.25,
    burstRatio: 3.84,
    bufferedCount: 40,
    traffic: [{ timestamp: 1699999995000, count: 6 }, { timestamp: 1700000000000, count: 9 }],
    latestMessage: { id: 'm1', userName: '阿求', timestamp: 1700000000000, content: '上一页残留的消息', elements: [] },
    phase: 'BURSTING',
  };
  api.updateMetrics();

  const metric0 = view.querySelector('[data-metric="0"]');
  const metric3 = view.querySelector('[data-metric="3"]');
  const preview = view.querySelector('[data-message-body]');
  const line = view.querySelector('.ptx-ecg-line');
  assert.equal(metric0.textContent, '12.50 条/分');
  assert.equal(metric3.textContent, '40 条');
  assert.equal(preview.textContent, '上一页残留的消息');
  assert.notEqual(line.attrs.d, '', '有快照时必须画出曲线');
  assert.equal(api.paint().points, 2);

  // 切到别的插件页：还是同一个群（频道作用域没变），但已经不是在用本面板
  api.doc.title = '适配器 · Koishi';
  api.win.location.pathname = '/plugins/adapter-onebot';
  api.checkRoute();

  assert.equal(api.state.own, false);
  assert.equal(api.state.channel, '1024', '离开本页不动群聊选择');
  assert.equal(metric0.textContent, '—', '指标不得跟着页走');
  assert.equal(metric3.textContent, '—');
  assert.equal(preview.textContent, '等待当前群的新消息', '预览必须回到空态');
  assert.equal(preview.dataset.richKey, 'none', '指纹必须作废，否则同一条消息回来时被「指纹没变」跳过');
  assert.equal(line.attrs.d, '', '曲线必须清空');
  assert.equal(api.paint().points, 0);
  assert.equal(api.paint().channel, '');
  assert.equal(view.querySelector('.ptx-monitor-status').textContent, '当前不是本插件页');
  assert.equal(api.state.status.currentRate, 12.5, '缓存（state.status）不跟着显示态一起清');

  // 回本插件页：缓存立刻重画，不必等一次往返、不闪空态
  api.doc.title = 'Patchouli Knowledge · Koishi';
  api.win.location.pathname = '/plugins/0848oh';
  api.checkRoute();

  assert.equal(api.state.own, true);
  assert.equal(metric0.textContent, '12.50 条/分', '回本页立刻按缓存重画');
  assert.equal(preview.textContent, '上一页残留的消息');
  assert.notEqual(line.attrs.d, '', '曲线按缓存重画');
});

test('ROUTE-21: 随机实例 id 且元数据全不命中 → 点开胶囊即认领、门禁一次、开始取数', async () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Koishi', breadcrumb: 'Koishi 控制台 / 插件配置' });
  api.checkRoute();

  assert.equal(api.state.own, false, '初始未认领');
  assert.equal(api.auth.gates, 0, '未认领不弹门禁');
  assert.deepEqual(api.requests(), [], '初始零请求');
  assert.equal(api.probeState().userClaimed, false);

  api.expandPanel();

  assert.equal(api.probeState().userClaimed, true, '点开胶囊置认领标记');
  assert.equal(api.state.own, true, '认领即本页');
  assert.equal(api.auth.ownPage, true, '认领结果同步给生成块（401 兜底只看它）');
  assert.equal(api.auth.gates, 1, '门禁恰好一次');
  assert.equal(api.state.dataFlow, true, '数据面启动');
  const started = api.requests();
  assert.ok(started.length > 0, '认领后开始取数');
  assert.equal(
    started.every((url) => url.startsWith('/patchouli/api/')),
    true,
    '取数只打 /api',
  );

  // 同一页内的轮询不反悔认领
  api.checkRoute();
  api.checkRoute();
  assert.equal(api.state.own, true, '同页轮询不清认领');
  assert.equal(api.auth.gates, 1, '不重复门禁');
  assert.equal(api.state.collapsed, false);

  // 网络层失败不影响认领判定：认领只看用户意图与路由 key
  await settle();
  assert.equal(api.state.own, true);
});

test('ROUTE-22: 认领后路由 key 变化 → 认领清除、回到未认领、停数据面', async () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Koishi' });
  api.checkRoute();
  api.expandPanel();
  assert.equal(api.state.own, true);
  assert.equal(api.probeState().userClaimed, true);
  const claimedAt = api.requests().length;
  assert.ok(claimedAt > 0);

  // 切到另一个随机实例 id 的插件页（宿主 SPA，不重载脚本）
  api.win.location.pathname = '/plugins/9x2fq7';
  api.checkRoute();

  assert.equal(api.probeState().userClaimed, false, '路由 key 一变，认领作废：切页要重新点');
  assert.equal(api.state.own, false, '新页面没认领');
  assert.equal(api.state.dataFlow, false, '数据面停止');
  assert.equal(api.auth.ownPage, false);
  assert.equal(api.state.collapsed, true, '回到只留胶囊');
  assert.equal(api.classes('pill').includes('is-visible'), true);

  const settled = api.requests().length;
  api.checkRoute();
  api.checkRoute();
  assert.equal(api.requests().length, settled, '停掉数据面后不再续请求');
  await settle();
  assert.equal(api.requests().length, settled, '异步结算也不补发请求');
});

test('ROUTE-24: 切页后 tick 到来前点胶囊 → 认领绑定当前路由，不被下一轮 tick 丢弃', () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Koishi' });
  api.checkRoute();
  assert.equal(api.probeState().key, '/plugins/0848oh');
  assert.equal(api.state.own, false);

  // 宿主刚切到新插件页，700ms 轮询还没跑
  api.win.location.pathname = '/plugins/9x2fq7';
  api.expandPanel();

  assert.equal(api.probeState().key, '/plugins/9x2fq7', '认领记录的是点击时刻的路由');
  assert.equal(api.state.own, true);

  api.checkRoute();
  assert.equal(api.probeState().userClaimed, true, 'tick 不再把认领当跨页清掉');
  assert.equal(api.state.own, true, '新页保持认领');
  assert.equal(api.state.dataFlow, true);
});

test('ROUTE-23: 认领后 /api 整片 404 + 非 JSON → 监控条报「接口不可用」，不撤销认领', async () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Koishi', apiMissing: true });
  api.checkRoute();
  assert.deepEqual(api.requests(), [], '认领前零请求');

  api.expandPanel();
  assert.equal(api.state.own, true, '点开即认领');
  assert.equal(api.auth.gates, 1, '401 之外的门禁流程不受影响：认领即开门禁');

  await settle();

  assert.equal(api.state.apiUnavailable, true, '连续两次 404 / 非 JSON 判为接口不可用');
  assert.equal(api.monitorStatusText(), '接口不可用', '监控条说原因，不说断线');
  assert.equal(api.phaseLabel('API_UNAVAILABLE'), '接口不可用', '状态胶囊同源');
  assert.equal(api.state.own, true, '认领不撤销：用户已明确要用这个面板');
  assert.equal(api.state.dataFlow, true, '数据面保持（用户可自行关掉面板）');
  assert.equal(api.state.collapsed, false);

  // 换页后账目清零：新页面的第一次失败要重新累计
  api.win.location.pathname = '/plugins/9x2fq7';
  api.checkRoute();
  assert.equal(api.state.apiUnavailable, false, '认领作废时接口账一起清');
  assert.equal(api.state.own, false);
});

test('ROUTE-25: 已认领页切到随机实例 id → tick 到来前点胶囊，认领迁到新路由、面板不被收回', () => {
  /* 场景一：胶囊认领过的页面切走（`userClaimed` 还在），700ms 轮询还没跑就又点一次。 */
  const own = loadClient({ pathname: '/plugins/0848oh', title: 'Koishi' });
  own.checkRoute();
  own.expandPanel();
  assert.equal(own.state.own, true, '点开即认领');

  own.win.location.pathname = '/plugins/9x2fq7';
  own.expandPanel();
  assert.equal(own.probeState().key, '/plugins/9x2fq7', '认领绑到点击时刻的路由');

  own.checkRoute();
  assert.equal(own.probeState().userClaimed, true, 'tick 不再把这次点击当跨页认领清掉');
  assert.equal(own.state.own, true, '新页保持认领');
  assert.equal(own.state.collapsed, false, '面板不被下一轮 tick 收起');

  /* 场景二：认领来自元数据（标题命中），切到的新页一个身份元数据都读不到 ——
     这一下点击就是新页唯一的凭据，不能因为上一页的判定还是 own 就跳过。 */
  const meta = loadClient({ pathname: '/plugins/0848oh', title: 'Patchouli Knowledge · Koishi' });
  meta.checkRoute();
  assert.equal(meta.state.own, true, '标题命中即为本插件页');
  assert.equal(meta.probeState().userClaimed, false, '没有人点过胶囊');

  meta.win.location.pathname = '/plugins/9x2fq7';
  meta.doc.title = 'Koishi';
  meta.expandPanel();

  assert.equal(meta.probeState().key, '/plugins/9x2fq7', '认领跟着点击时刻的路由');
  assert.equal(meta.probeState().userClaimed, true, '点击补上新页的身份凭据');

  meta.checkRoute();
  assert.equal(meta.state.own, true, '新页保持认领');
  assert.equal(meta.state.dataFlow, true, '数据面继续为新页服务');
  assert.equal(meta.state.collapsed, false, '面板不被下一轮 tick 收起');
});

test('ROUTE-26: 元数据认领的页面接口整片 404 / 非 JSON → 监控条与状态格都说「接口不可用」', async () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Patchouli Knowledge · Koishi', apiMissing: true });
  api.checkRoute();

  assert.equal(api.state.own, true, '标题命中即认领：不需要用户点胶囊');
  assert.equal(api.probeState().userClaimed, false, '本轮没有人点过胶囊');

  await settle();

  assert.equal(api.state.apiUnavailable, true, '连续两次 404 / 非 JSON 判为接口不可用');
  assert.equal(api.monitorStatusText(), '接口不可用', '失败归因与认领来源无关');
  assert.equal(api.phase(), 'API_UNAVAILABLE', '状态格同源：不落到 OFFLINE');
  assert.equal(api.phaseLabel(api.phase()), '接口不可用');
  assert.equal(api.state.own, true, '认领不撤销');
});

test('ROUTE-27: 响应头正常但 body 流被 reset → 说「连接中断」，不算接口不可用', async () => {
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Koishi', bodyFault: true });
  api.checkRoute();
  api.expandPanel();
  assert.equal(api.state.own, true, '点开即认领');

  await settle();

  assert.ok(api.requests().length > 0, '确实读到了响应体');
  assert.equal(api.state.apiUnavailable, false, '流被 reset 不是「这套接口不存在」');
  assert.equal(api.monitorStatusText(), '连接中断，保留最后一次数据');
  assert.equal(api.phase(), 'OFFLINE', '状态格报断线，不报接口不可用');
});

test('ROUTE-28: 切页后 tick 到来前点胶囊 → 上一页的接口失败账不带到新页', async () => {
  /* 旧页（随机实例 id）点开胶囊后 /api 整片 404，先把「接口不可用」触到置位 */
  const api = loadClient({ pathname: '/plugins/0848oh', title: 'Koishi', apiMissing: true });
  api.checkRoute();
  api.expandPanel();
  await settle();
  assert.equal(api.state.apiUnavailable, true, '旧页先触到不可用阈值');
  assert.ok(api.state.apiStreak >= 2, '失败连胜记在旧页上');

  /* 宿主切到新插件页，700ms 轮询还没跑用户就点开胶囊：认领跟着点击时刻的路由走，
     带走的是「本页归我」，而不是旧页的失败账 —— 新页一次请求都还没发过，
     不能一挂载就报「接口不可用」。 */
  api.win.location.pathname = '/plugins/9x2fq7';
  api.expandPanel();

  assert.equal(api.probeState().key, '/plugins/9x2fq7', '认领绑到点击时刻的路由');
  assert.equal(api.state.apiUnavailable, false, '换页即清接口可用性账');
  assert.equal(api.state.apiStreak, 0, '失败连胜从零开始累计');
  assert.equal(api.state.own, true, '本页仍然被认领');

  api.checkRoute();
  assert.equal(api.state.own, true, '下一轮 tick 不把这次认领丢掉');
  assert.equal(api.probeState().userClaimed, true);

  /* 新页第一次请求失败只是「1 次」，没到阈值：旧账跟着过来的话这里立刻就是不可用 */
  await settle();
  assert.ok(api.state.apiStreak < 2, `失败账从零累计，实际 ${api.state.apiStreak}`);
  assert.equal(api.state.apiUnavailable, false, '新页要自己的连续失败够数才置位');
});
