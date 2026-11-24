import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 「投递策略」视图的渲染与整表保存契约（POLICY-UI-01..04）。
 *
 * 客户端产物是 Console 组件，不导出内部渲染函数；与 WEBUI-19..22 同一条路径：
 * 把产物当函数体载入，只取策略视图的渲染 / 保存内核，不挂载真实 DOM。
 * 服务端契约（src/web/api.ts + src/plugin/policy-resolve.ts）：
 * GET /api/settings 带 `policies` 与 `targets`，POST section:'policies' 收整表、
 * 非法值 400 且 body.error 是人话；缺省目标 = 空窗口 / 0 / 0 / 0。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');

const noop = () => {};

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

/* 可手动推进的定时器：toast 的自动淡出不拖住事件循环 */
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
  state, loadPolicies, renderPolicies, policyRows, policyPatchOf, policyOf,
  savePolicyTable, collectPolicyRows,
  setViewport(el) { viewportEl = el; },
  setToast(el) { toastEl = el; },
  renderStageCalls() { return __renderStageCalls; },
};`,
  );
  const api = factory(
    WINDOW_STUB, DOCUMENT_STUB, (...args) => fetchImpl(...args),
    () => 0, noop, clock.setTimeout, clock.clearTimeout,
  );
  api.setFetch = (next) => { fetchImpl = next; };
  /* 产物默认 own=false（首帧路由还没认领本页）；这里只跑策略视图内核，
     按真实使用形态（用户就在本插件页上点保存）置真。POLICY-UI-04 自己翻回 false。 */
  api.state.own = true;
  return api;
}

/* ---------------- 服务端响应替身 ---------------- */

function response(body, status = 200) {
  const code = status;
  return { ok: code >= 200 && code < 300, status: code, json: async () => body };
}

const TARGETS = ['111/222', '333/444', '@chat:555'];
const ALBUM_LABEL = '摸鱼群 / 日常';

function settingsBody(policies, targets = TARGETS) {
  return { sections: {}, meta: [], policies, targets };
}

function albumsBody() {
  return { albums: [{ value: '111/222', label: ALBUM_LABEL }], probedAt: 1 };
}

/* 按 URL 分派的读路径替身：GET /api/settings 与 GET /api/albums 是仅有的两条 */
function readStub(options, urls) {
  const settings = options && options.settings ? options.settings : settingsBody({});
  const albums = options && options.albums ? options.albums : albumsBody();
  return (url) => {
    const path = String(url);
    if (urls) urls.push(path);
    if (path.endsWith('/api/settings')) return Promise.resolve(response(settings));
    if (path.endsWith('/api/albums')) return Promise.resolve(response(albums));
    return Promise.reject(new Error(`probe: unexpected ${path}`));
  };
}

/* 一次 POST 的记录器 */
function writeStub(body, status) {
  const sent = [];
  const fetch = (url, init) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(response(body, status));
  };
  return { sent, fetch };
}

/* ---------------- 断言辅助 ---------------- */

function rowOf(html, key) {
  const marker = `data-pol-row="${key}"`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `缺少目标 ${key} 的行`);
  const next = html.indexOf('data-pol-row="', start + marker.length);
  return html.slice(start, next < 0 ? html.length : next);
}

function fieldValue(rowHtml, field) {
  const match = new RegExp(`data-pol-field="${field}"[^>]*value="([^"]*)"`).exec(rowHtml);
  assert.ok(match, `缺少字段 ${field}`);
  return match[1];
}

function createClassList(initial) {
  const set = new Set(initial || []);
  return {
    add: (...names) => { for (const name of names) set.add(name); },
    remove: (...names) => { for (const name of names) set.delete(name); },
    contains: (name) => set.has(name),
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name); else set.delete(name);
      return on;
    },
  };
}

/* ---------------- 用例 ---------------- */

test('POLICY-UI-01: 加载后每个目标一行，未配置目标显示默认值', async () => {
  const api = loadClient();
  const urls = [];
  api.setFetch(readStub({
    settings: settingsBody({
      '111/222': { window: '* 22:00-23:30', entryPerDay: 3, weeklyPerWeek: 1, jitterMinutes: 15 },
    }),
  }, urls));
  api.state.stage = 'policies';

  await api.loadPolicies();
  assert.deepEqual(urls.sort(), ['/patchouli/api/albums', '/patchouli/api/settings'], '只读两份真值');

  const html = api.renderPolicies();
  const keys = [...html.matchAll(/data-pol-row="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(keys, TARGETS, '目标顺序跟服务端 targets 一致');

  const configured = rowOf(html, '111/222');
  assert.ok(configured.includes(ALBUM_LABEL), '相册地址翻成可读名');
  assert.equal(fieldValue(configured, 'window'), '* 22:00-23:30');
  assert.equal(fieldValue(configured, 'entryPerDay'), '3');
  assert.equal(fieldValue(configured, 'weeklyPerWeek'), '1');
  assert.equal(fieldValue(configured, 'jitterMinutes'), '15');

  // 未配置的目标：空窗口 + 0 / 0 / 0，与缺省语义一致
  const fresh = rowOf(html, '333/444');
  assert.equal(fieldValue(fresh, 'window'), '');
  assert.equal(fieldValue(fresh, 'entryPerDay'), '0');
  assert.equal(fieldValue(fresh, 'weeklyPerWeek'), '0');
  assert.equal(fieldValue(fresh, 'jitterMinutes'), '0');
  assert.ok(!fresh.includes('<em>'), '可读名缺失时只显示稳定地址，不重复一遍');

  const chat = rowOf(html, '@chat:555');
  assert.ok(chat.includes('本群聊天（555）'), '@chat 键还原成本群聊天（群号）');
  assert.equal(fieldValue(chat, 'jitterMinutes'), '0');

  // 相册名里的 & / < 只转义一次：可见文本与 aria-label 是同一份转义结果
  api.state.policies.labels = { '333/444': 'A&B <相册>' };
  const escaped = rowOf(api.renderPolicies(), '333/444');
  assert.ok(escaped.includes('A&amp;B &lt;相册&gt;'), '可读名按 HTML 转义');
  assert.ok(escaped.includes('aria-label="A&amp;B &lt;相册&gt;的投递窗口"'), 'aria-label 与文本同一份转义');
  assert.ok(!escaped.includes('&amp;amp;'), '不得二次转义');
  api.state.policies.labels = {};

  // 空清单：给出去订阅表选目标的空态，而不是空表格
  api.state.policies.targets = [];
  api.state.policies.saved = {};
  const empty = api.renderPolicies();
  assert.ok(empty.includes('还没有投递目标，先在订阅表里选择'), '空 targets 给空态文案');
  assert.ok(!empty.includes('data-pol-row='));
  assert.ok(!empty.includes('data-action="save-policies"'), '没有目标就不给保存入口');
});

test('POLICY-UI-02: 编辑一处只提交差异项，成功后按服务端真值就地更新', async () => {
  const api = loadClient();
  api.setFetch(readStub({}));
  api.state.stage = 'policies';
  await api.loadPolicies();
  const rendersBefore = api.renderStageCalls();

  // 1) 只在「333/444」上填词条上限：其余目标仍是缺省值，不得进补丁
  const normalized = { '333/444': { window: '', entryPerDay: 3, weeklyPerWeek: 0, jitterMinutes: 0 } };
  const first = writeStub({ ok: true, value: normalized });
  api.setFetch(first.fetch);
  const rows = api.policyRows().map((row) => (row.key === '333/444' ? { ...row, entryPerDay: 3 } : row));
  await api.savePolicyTable(rows);

  assert.equal(first.sent.length, 1, '整表保存只发一次请求');
  assert.equal(first.sent[0].url, '/patchouli/api/settings');
  assert.equal(first.sent[0].init.method, 'POST');
  assert.equal(first.sent[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(first.sent[0].init.body), {
    section: 'policies',
    patch: { '333/444': { window: '', entryPerDay: 3, weeklyPerWeek: 0, jitterMinutes: 0 } },
  }, '未改动的目标按缺省值省略');
  assert.deepEqual(api.state.policies.saved, normalized, '服务端回值是新的本地真值');
  assert.ok(api.renderStageCalls() > rendersBefore, '成功后重绘回服务端归一化值');

  const html = api.renderPolicies();
  assert.equal(fieldValue(rowOf(html, '333/444'), 'entryPerDay'), '3');
  assert.equal(fieldValue(rowOf(html, '111/222'), 'entryPerDay'), '0', '未编辑的目标保持缺省');

  // 2) 窗口带 ~N 抖动后缀：文本原样提交，服务端把抖动折进字段，面板按回值重绘
  const suffixNormalized = {
    ...normalized,
    '@chat:555': { window: '* 22:00-23:30', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 15 },
  };
  const second = writeStub({ ok: true, value: suffixNormalized });
  api.setFetch(second.fetch);
  const next = api.policyRows().map((row) => (row.key === '@chat:555' ? { ...row, window: '* 22:00-23:30 ~15' } : row));
  await api.savePolicyTable(next);
  const patch = JSON.parse(second.sent[0].init.body).patch;
  assert.equal(patch['@chat:555'].window, '* 22:00-23:30 ~15', '窗口文本原样提交，归一化是服务端的事');
  assert.equal(patch['@chat:555'].jitterMinutes, 0);
  const chatRow = rowOf(api.renderPolicies(), '@chat:555');
  assert.equal(fieldValue(chatRow, 'window'), '* 22:00-23:30', '回值里的窗口去掉了后缀');
  assert.equal(fieldValue(chatRow, 'jitterMinutes'), '15', '抖动落进独立字段');

  // 3) 把某目标清空 = 从整表里删掉它（缺省项不再出现在补丁里）
  const cleared = writeStub({ ok: true, value: {} });
  api.setFetch(cleared.fetch);
  await api.savePolicyTable(api.policyRows().map((row) => ({ ...row, window: '', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 })));
  assert.deepEqual(JSON.parse(cleared.sent[0].init.body).patch, {}, '全部回到缺省 → 空补丁');
});

test('POLICY-UI-03: 400 只显示服务端原因，本地真值不被覆盖', async () => {
  const api = loadClient();
  const saved = { '111/222': { window: '* 09:00-22:00', entryPerDay: 2, weeklyPerWeek: 0, jitterMinutes: 0 } };
  api.setFetch(readStub({ settings: settingsBody(saved) }));
  api.state.stage = 'policies';
  await api.loadPolicies();

  const errorNode = { textContent: '', classList: createClassList() };
  api.setViewport({ querySelector: (selector) => (selector === '[data-pol-error]' ? errorNode : null) });
  const rendersBefore = api.renderStageCalls();

  const reason = 'policies[111/222] 字段非法（window 语法 / entryPerDay ≤ 999 / weeklyPerWeek ≤ 999 / jitterMinutes ≤ 1440）';
  const failing = writeStub({ ok: false, error: reason }, 400);
  api.setFetch(failing.fetch);
  const before = JSON.parse(JSON.stringify(api.state.policies.saved));
  const rows = api.policyRows().map((row) => (row.key === '111/222' ? { ...row, entryPerDay: -3 } : row));
  await api.savePolicyTable(rows);

  assert.equal(failing.sent.length, 1);
  assert.equal(errorNode.textContent, `保存失败：${reason}`, '400 的 body.error 原样显示');
  assert.ok(errorNode.classList.contains('is-visible'), '错误行可见');
  assert.deepEqual(api.state.policies.saved, before, '失败不覆盖本地真值');
  assert.equal(api.renderStageCalls(), rendersBefore, '失败不整页重绘，输入留在原地');
  assert.ok(api.renderPolicies().includes(`保存失败：${reason}`), '重绘后错误仍在页面上');

  // 改对之后重试：错误清掉，真值跟进
  const fixed = writeStub({ ok: true, value: { '111/222': { window: '* 09:00-22:00', entryPerDay: 3, weeklyPerWeek: 0, jitterMinutes: 0 } } });
  api.setFetch(fixed.fetch);
  await api.savePolicyTable(api.policyRows().map((row) => (row.key === '111/222' ? { ...row, entryPerDay: 3 } : row)));
  assert.equal(errorNode.textContent, '', '保存开始时清掉上一次的错误');
  assert.equal(api.state.policies.saved['111/222'].entryPerDay, 3);
});

test('POLICY-UI-04: 非本插件页的保存被闸口拒绝且零请求', async () => {
  const api = loadClient();
  const calls = [];
  api.setFetch(() => {
    calls.push('unexpected');
    return Promise.resolve(response({ ok: true, value: {} }));
  });
  const toastNode = { innerHTML: '', classList: createClassList() };
  api.setToast(toastNode);
  api.state.own = false;
  api.state.policies.saved = { '111/222': { window: '', entryPerDay: 2, weeklyPerWeek: 0, jitterMinutes: 0 } };
  const before = JSON.parse(JSON.stringify(api.state.policies.saved));

  await api.savePolicyTable([{ key: '111/222', window: '', entryPerDay: 3, weeklyPerWeek: 0, jitterMinutes: 0 }]);
  assert.deepEqual(calls, [], '非本插件页的写入不得发到网络');
  assert.ok(toastNode.innerHTML.includes('当前不在本插件页'), '被拦下必须给出理由');
  assert.deepEqual(api.state.policies.saved, before, '本地真值不变');
  assert.equal(api.state.policies.saveError, '', '不把读路径的「已暂停取数」写成保存失败');

  // 回到本插件页：同一次保存照常发出（同一个 writeJson 闸口）
  api.state.own = true;
  const sent = writeStub({ ok: true, value: { '111/222': { window: '', entryPerDay: 3, weeklyPerWeek: 0, jitterMinutes: 0 } } });
  api.setFetch(sent.fetch);
  await api.savePolicyTable([{ key: '111/222', window: '', entryPerDay: 3, weeklyPerWeek: 0, jitterMinutes: 0 }]);
  assert.equal(sent.sent.length, 1, '本插件页的保存正常发出');
  assert.deepEqual(JSON.parse(sent.sent[0].init.body), {
    section: 'policies',
    patch: { '111/222': { window: '', entryPerDay: 3, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
});
