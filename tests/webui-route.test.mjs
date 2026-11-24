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

/**
 * 载入产物并按用例摆好宿主环境。
 * `mount()` 被替换成记账桩：真壳层需要完整 DOM，而本文件只断言挂载 / 收回的判定。
 */
function loadClient({ pathname = '/', hash = '', search = '', title = '', breadcrumb = '', bodyText = '', bodyNodes = null, panelNode = false }) {
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
  /* 深探测的正文取样走 TreeWalker：桩按顺序交出文本节点，并记账「读了几次、一共几个字符」。
     ROUTE-16 用它证明取样停在第 600 字 —— 没有像 innerText 那样先物化整页。 */
  const probeReads = { nodes: 0, chars: 0 };
  const pageTextNodes = () => {
    if (Array.isArray(bodyNodes)) {
      return bodyNodes.map((entry) => ({
        nodeType: 3,
        nodeValue: entry.text,
        parentNode: entry.panel
          ? { nodeName: 'DIV', id: 'patchouli-organic-root', parentNode: null }
          : { nodeName: entry.parent || 'DIV', parentNode: null },
      }));
    }
    if (!bodyText) return [];
    return [{ nodeType: 3, nodeValue: bodyText, parentNode: { nodeName: 'DIV', parentNode: null } }];
  };
  const documentStub = {
    readyState: 'complete',
    hidden: false,
    title,
    documentElement: null,
    /* 页面正文只经 TreeWalker 取样（产物不再读 innerText）：桩里连 innerText 都不提供，
       任何回退到 innerText 的写法都会立刻在 ROUTE-11/12/15/16 上失败。 */
    body: { nodeName: 'BODY', appendChild: noop, removeChild: noop, addEventListener: noop, querySelector: () => null, getAttribute: () => null },
    createTreeWalker: (root, whatToShow, filter) => {
      const queue = pageTextNodes();
      let index = 0;
      const walker = {
        currentNode: null,
        nextNode() {
          while (index < queue.length) {
            const node = queue[index];
            index += 1;
            /* FILTER_REJECT(2) / 任一非 ACCEPT 值都跳过：脚本、浮窗自身子树都不算正文。 */
            if (filter && typeof filter.acceptNode === 'function' && filter.acceptNode(node) !== 1) continue;
            probeReads.nodes += 1;
            probeReads.chars += (node.nodeValue || '').length;
            walker.currentNode = node;
            return node;
          }
          return null;
        },
      };
      return walker;
    },
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
    querySelector: (selector) => {
      if (breadcrumb && selector === '.el-breadcrumb') return { textContent: breadcrumb };
      /* 宽取样点可能正好落在浮窗自己的 DOM 里（壳层文案带「LLMWiki 知识阅读器」）：
         这类命中必须被丢弃，否则挂载即自我认领。 */
      if (panelNode && selector === '[class*="plugin"]') {
        return {
          textContent: 'LLMWiki 知识阅读器',
          id: '',
          parentNode: { id: 'patchouli-organic-root', parentNode: null },
        };
      }
      return null;
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
  probeOwnershipDeep,
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
      deepTried: routeProbe.deepTried,
      deepOwned: routeProbe.deepOwned,
    };
  },
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

  return { ...api, auth, requests: () => requests.slice(), probeReads: () => ({ ...probeReads }) };
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

test('ROUTE-11: 随机实例 id + 标题与面包屑都不含身份文本 → 用户点开胶囊后深探测认领本页并开始取数', () => {
  const api = loadClient({
    pathname: '/plugins/0848oh',
    title: 'Koishi',
    breadcrumb: 'Koishi 控制台 / 插件配置',
    // 宿主把插件名画在页头之外的地方（说明 / 表单标题），首帧取样读不到
    bodyText: '插件配置 实例 0848oh LLMWiki 知识阅读器 频道白名单',
  });
  api.checkRoute();

  assert.equal(api.state.own, false, '首帧身份文本不命中：先不认领');
  assert.equal(api.state.collapsed, true, '只留胶囊，整窗不盖住宿主表单');
  assert.deepEqual(api.requests(), [], '认领之前一个 /api 请求都不发');

  // 用户点开胶囊（data-act="expand" → expandPanel）：这是「我要用这个面板」的唯一凭据
  api.expandPanel();

  assert.equal(api.state.own, true, '用户意图兜底：正文命中标识即认领本页');
  assert.equal(api.auth.ownPage, true, '认领结果必须同步给生成块');
  assert.equal(api.state.collapsed, false, '点开就是展开，不留在胶囊态');
  assert.equal(api.auth.gates, 1, '认领本页即弹门禁');
  const started = api.requests();
  assert.ok(started.length > 0, '认领后立刻启动数据面');
  assert.equal(
    started.every((url) => url.startsWith('/patchouli/api/')),
    true,
    '深探测本身零请求：取数只打 /api',
  );
  assert.equal(api.probeState().deepTried, true, '本页的深探测已用掉');
  assert.equal(api.probeState().deepOwned, true, '认领结果记在本页上');

  // 下一轮路由判定现算 routeMatches() 仍是 false：不得把用户刚认领的页收回去
  api.checkRoute();
  assert.equal(api.state.own, true, '轮询判定不得反悔用户的认领');
  assert.equal(api.state.dataFlow, true, '数据面保持运行');
  assert.equal(api.state.collapsed, false, '面板保持展开');
  assert.equal(api.auth.dismissals, 0, '不得因为下一轮判定收起门禁');
});

test('ROUTE-12: 随机实例 id + 正文也不含身份文本 → 保持未认领、零请求、文案区分「不是本插件页」', () => {
  const api = loadClient({
    pathname: '/plugins/0848oh',
    title: 'Koishi',
    breadcrumb: 'Koishi 控制台 / 插件配置',
    bodyText: '适配器配置 账号协议 心跳间隔 重连次数',
  });
  api.checkRoute();
  assert.equal(api.state.own, false);
  assert.equal(api.monitorStatusText(), '当前不是本插件页', '未认领页面的监控条不得报「连接中断」');

  api.expandPanel();

  assert.equal(api.state.own, false, '正文也认不出：不认领');
  assert.equal(api.probeState().deepTried, true, '深探测每页只跑一次');
  assert.deepEqual(api.requests(), [], '深探测不产生任何网络请求，拒绝也不会绕开闸口');
  assert.equal(api.auth.gates, 0, '认不出身份不得弹全屏门禁');
  assert.equal(api.state.dataFlow, false, '不启动数据面');
  assert.equal(api.monitorStatusText(), '当前不是本插件页', '展开后仍是「不是本插件页」，不是断线');
  assert.equal(api.phaseLabel('UNOWNED'), '当前不是本插件页', '状态胶囊同样区分未认领与断线');
  assert.equal(api.phaseLabel('OFFLINE'), '连接中断', '真断线的文案保持不变');

  // 再来一次点击也不会重探（每页一次），更不会因此认领
  api.expandPanel();
  assert.equal(api.state.own, false, '重复点击不重探、不认领');
  assert.deepEqual(api.requests(), [], '零请求保持不变');
});

test('ROUTE-13: 身份取样落到浮窗自己的 DOM 里不算页面身份（挂载不得自我认领）', () => {
  const api = loadClient({
    pathname: '/plugins/adapter-onebot',
    title: '适配器 · Koishi',
    panelNode: true,
  });
  api.checkRoute();

  assert.equal(api.routeMatches(), false, '浮窗自己的「LLMWiki 知识阅读器」不是页面身份');
  assert.equal(api.state.own, false);
  assert.equal(api.state.collapsed, true, '别的插件页仍是胶囊');
  assert.deepEqual(api.requests(), [], '自我认领会连带把别人的插件页变成取数页 —— 必须零请求');
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

test('ROUTE-15: 正文只有泛化词「知识库」→ 深探测不认领（零请求）', () => {
  const api = loadClient({
    pathname: '/plugins/0848oh',
    title: 'Koishi',
    breadcrumb: 'Koishi 控制台 / 插件配置',
    // 别的插件的页面正文里随口提一句「知识库」：泛化词不该成为认领凭据
    bodyText: '知识库范围 群聊归档 讨论缓存 索引重建 关键词提取',
  });
  api.checkRoute();
  assert.equal(api.state.own, false);

  api.expandPanel();

  assert.equal(api.probeState().deepTried, true, '深探测只跑一次');
  assert.equal(api.state.own, false, '泛化词不参与深探测：别人的插件页提到「知识库」也不认领');
  assert.deepEqual(api.requests(), [], '不认领就不发一个请求');
  assert.equal(api.auth.gates, 0, '不认领就不弹全屏门禁');
  assert.equal(api.monitorStatusText(), '当前不是本插件页');
});

test('ROUTE-16: 5000 字正文、专有标识在 600 字之后 → 不认领，且取样绝不读超过 600 字', () => {
  const nodes = [
    /* 浮窗自己的子树：壳层文案带专有标识，但不算页面正文 */
    { text: 'Patchouli Knowledge 知识阅读器', panel: true },
    /* <script> 里的标识同理：不是可见正文 */
    { text: 'llmwiki', parent: 'SCRIPT' },
  ];
  /* 100 个 50 字节点 = 5000 字可见正文 */
  for (let index = 0; index < 100; index += 1) nodes.push({ text: '配'.repeat(50) });
  /* 专有标识整体落在第 5000 字之后，远在第 600 字窗口之外 */
  nodes.push({ text: '知识阅读器 大图书馆' });

  const api = loadClient({
    pathname: '/plugins/0848oh',
    title: 'Koishi',
    breadcrumb: 'Koishi 控制台 / 插件配置',
    bodyNodes: nodes,
  });
  api.checkRoute();
  assert.equal(api.state.own, false);

  api.expandPanel();

  assert.equal(api.state.own, false, '600 字之外的标识、浮窗子树与脚本内容都不算页面身份');
  assert.equal(api.probeState().deepTried, true);
  assert.deepEqual(api.requests(), [], '零请求');
  assert.equal(api.auth.gates, 0);

  const reads = api.probeReads();
  assert.ok(reads.chars <= 600, `取样最多读 600 字，实际读了 ${reads.chars}`);
  assert.ok(reads.nodes <= 12, `凑满 600 字即中断，实际遍历了 ${reads.nodes} 个文本节点`);
});
