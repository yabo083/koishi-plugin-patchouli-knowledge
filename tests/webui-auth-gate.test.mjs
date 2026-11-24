import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 生成块（`BEGIN GENERATED AUTH GATE`）的 401 契约。
 *
 * 浮窗挂在**任何** `/plugins/**` 页上，但全屏门禁只属于本插件页：
 * - 本插件页的 401 = 票据过期 → 清票据 + 重弹门禁（探一次 `/session` 决定登录还是初始化）；
 * - 别的插件页的 401 只清票据，**绝不**盖遮罩 —— 那会堵住宿主自己的表单。
 * 标记由 Console 侧写进 `window.__ptxAuth.setOwnPage()`；本文件只验生成块这一侧。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');
const BEGIN = '// BEGIN GENERATED AUTH GATE';
const END = '// END GENERATED AUTH GATE';

/** 载入生成块本体（不含浮窗代码），返回记账桩。
 *  `holdSession`：把 `/session` 探测卡住，直到 `release()` —— 用来复现
 *  「探测在途时用户离开本插件页」的竞态。 */
function loadGate({ holdSession = false } = {}) {
  const start = CLIENT_SOURCE.indexOf(BEGIN);
  const stop = CLIENT_SOURCE.indexOf(END, start);
  assert.ok(start >= 0 && stop > start, '客户端产物里缺鉴权门的生成标记');

  const requests = [];
  let overlays = 0;
  let releaseSession = null;
  const sessionHeld = holdSession ? new Promise((resolve) => { releaseSession = resolve; }) : null;
  const createNode = () => ({
    id: '',
    innerHTML: '',
    style: {},
    setAttribute: () => {},
    appendChild: () => {},
    remove: () => {},
    addEventListener: () => {},
    querySelector: () => null,
  });
  const documentStub = {
    body: { appendChild: () => { overlays += 1; } },
    createElement: createNode,
    getElementById: () => null,
  };

  /* /api 一律 401（模拟票据过期），/session 回「未通过」：门禁会走登录分支。 */
  const fetchStub = (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    requests.push(url);
    if (url.includes('/api/')) {
      return Promise.resolve({ status: 401, ok: false, json: async () => ({}) });
    }
    const answer = { status: 200, ok: true, json: async () => ({ authenticated: false }) };
    return sessionHeld ? sessionHeld.then(() => answer) : Promise.resolve(answer);
  };

  const storage = new Map([
    ['patchouli.session', 'sid-1'],
    ['patchouli.expires', String(Date.now() + 3_600_000)],
  ]);
  const windowStub = {
    fetch: fetchStub,
    location: { reload: () => {} },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
    },
    dispatchEvent: () => {},
  };

  const body = CLIENT_SOURCE.slice(start + BEGIN.length, stop);
  const factory = new Function(
    'window', 'document', 'fetch', 'Headers',
    `${body}\nreturn window.__ptxAuth;`,
  );
  const api = factory(windowStub, documentStub, fetchStub, Headers);
  return {
    api,
    win: windowStub,
    requests,
    overlays: () => overlays,
    session: () => storage.get('patchouli.session') ?? null,
    release: () => { if (releaseSession) releaseSession(); },
  };
}

/** 门禁是 401 之后**另起**的异步链：flush 一次宏任务再断言它走到了哪一步。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('GATE-01: 本插件页的 401 重弹门禁（清票据 + 探 /session + 挂遮罩）', async () => {
  const gate = loadGate();
  assert.equal(gate.api.isOwnPage(), true, '缺省就是本插件页（独立页面形态）');

  const response = await gate.win.fetch('/patchouli/api/status');
  assert.equal(response.status, 401);
  await flush();

  assert.equal(gate.session(), null, '401 必须清掉过期票据');
  assert.deepEqual(
    gate.requests.filter((url) => url.includes('/session')),
    ['/patchouli/session'],
    '本插件页要重新确认会话状态（决定登录还是首次初始化）',
  );
  assert.equal(gate.overlays(), 1, '本插件页 401 必须弹门禁');
});

test('GATE-02: 别的插件页的 401 只清票据，绝不盖全屏遮罩', async () => {
  const gate = loadGate();
  gate.api.setOwnPage(false);
  assert.equal(gate.api.isOwnPage(), false);

  const response = await gate.win.fetch('/patchouli/api/entries');
  assert.equal(response.status, 401);
  await flush();
  assert.equal(gate.session(), null, '票据照样清掉（它确实过期了）');
  assert.equal(
    gate.requests.filter((url) => url.includes('/session')).length,
    0,
    '别的插件页连会话探测都不发',
  );
  assert.equal(gate.overlays(), 0, '别人的插件页上不得出现登录 / 初始化遮罩');
});

test('GATE-03: 非本插件页时直接调 gate() / 再点开登录也不挂遮罩（兜底幂等）', async () => {
  const gate = loadGate();
  gate.api.setOwnPage(false);
  gate.api.gate('会话已过期，请重新输入。');
  await flush();
  assert.equal(gate.overlays(), 0);
  assert.deepEqual(gate.requests, [], 'gate() 自己也不该为一个看不见的页去探会话');

  // 回到本插件页：标记恢复后一切照旧
  gate.api.setOwnPage(true);
  gate.api.gate();
  await flush();
  assert.equal(gate.overlays(), 1, '回到本插件页后门禁恢复');
});

test('GATE-04: 401 晚到的 /session 探测不弹门禁（探测在途时已离开本插件页）', async () => {
  const gate = loadGate({ holdSession: true });

  /* 401 落在**本插件页**上（标记此刻仍为真），门禁链起来并发出 /session 探测；
     探测被卡在半路，正是宿主路由 700ms 轮询窗口里的那一段。 */
  const response = await gate.win.fetch('/patchouli/api/entries');
  assert.equal(response.status, 401);
  assert.deepEqual(
    gate.requests.filter((url) => url.includes('/session')),
    ['/patchouli/session'],
    '401 当时还是本插件页：门禁照常探会话',
  );
  assert.equal(gate.session(), null, '401 先清票据');

  // 用户在探测返回前离开本插件页：路由标记下一轮才写进来，这里是写进来之后
  gate.api.setOwnPage(false);
  gate.release();
  await flush();

  assert.equal(gate.overlays(), 0, '晚到的探测结果一律丢弃：绝不在别人的插件页上盖遮罩');
  assert.equal(gate.session(), null, '离开本页时票据保持清空');
});
