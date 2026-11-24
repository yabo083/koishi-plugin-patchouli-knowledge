import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 订阅表自定义 role 组件（`ptx-subscriptions`）的契约。
 *
 * 服务端把 `subscriptions` 的 role 从 `table` 换成 `ptx-subscriptions`，客户端产物里的
 * role 组件接管这张表：列头 `监听群 / 投递群 / 词条 / 周报 / 操作`，投递群是 chip 列表，
 * 点 chip 在本行下方就地展开策略面板（日词条 / 周主题投递时间 + 限量），策略只发**改动字段**。
 *
 * 产物这一段用 `BEGIN/END SUBSCRIPTIONS ROLE` 标记，独立载入即可（只依赖注入的 vue /
 * read / write），所以这里给一个最小 `h`（返回可遍历的普通对象）与真实的动作路径：
 * 动作挂在 vnode 的 `onClick` / `onInput` 上，测试调的就是组件挂到 DOM 上的同一个函数。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');
const BEGIN = '// BEGIN SUBSCRIPTIONS ROLE';
const END = '// END SUBSCRIPTIONS ROLE';

/* ---------------- 载入产物片段 ---------------- */

function loadFactory() {
  const start = CLIENT_SOURCE.indexOf(BEGIN);
  const stop = CLIENT_SOURCE.indexOf(END, start);
  assert.ok(start >= 0 && stop > start, '客户端产物里缺 SUBSCRIPTIONS ROLE 标记');
  const body = CLIENT_SOURCE.slice(start + BEGIN.length, stop);
  return new Function(
    'window', 'document',
    `${body}
return {
  createSubscriptionsRole,
  ensureSubscriptionsRoleStyles,
  SUBSCRIPTIONS_ROLE,
  SUBSCRIPTIONS_ROLE_STYLES,
  SUBSCRIPTIONS_POLICY_API,
  subscriptionsApiFetch,
  subscriptionsPolicySummary,
  subscriptionsNormalizePolicies,
};`,
  );
}

const SECTION = loadFactory()(undefined, undefined);
const SECTION_SOURCE = CLIENT_SOURCE.slice(
  CLIENT_SOURCE.indexOf(BEGIN) + BEGIN.length,
  CLIENT_SOURCE.indexOf(END, CLIENT_SOURCE.indexOf(BEGIN)),
);

/** 最小 `h`：vnode 就是 `{ type, props, children }`，文本子节点保持字符串。 */
function normalizeChildren(children) {
  if (children == null) return [];
  if (Array.isArray(children)) {
    const out = [];
    for (const child of children) {
      if (Array.isArray(child)) out.push(...normalizeChildren(child));
      else if (child != null) out.push(child);
    }
    return out;
  }
  return [children];
}

function h(type, props, children) {
  return { type, props: props && typeof props === 'object' ? props : {}, children: normalizeChildren(children) };
}

function createRole(deps) {
  /* 测试桩不做响应式：动作之后由测试自己再取一次树，语义与 Vue 里一致。 */
  return SECTION.createSubscriptionsRole({ h, reactive: (value) => value }, deps || {});
}

/* ---------------- 遍历 / 取值 ---------------- */

function walk(node, visit) {
  if (node == null || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function findAll(tree, predicate) {
  const out = [];
  walk(tree, (node) => { if (predicate(node)) out.push(node); });
  return out;
}

function findOne(tree, predicate) {
  return findAll(tree, predicate)[0] || null;
}

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map(text).join('');
}

const hasAct = (name) => (node) => node.props && node.props['data-ptx-act'] === name;

function actNode(tree, name) {
  const node = findOne(tree, hasAct(name));
  assert.ok(node, `找不到动作节点 ${name}`);
  return node;
}

/** 走组件挂在 DOM 上的同一个处理函数（`{}` 当事件：组件对事件字段有取值保护）。 */
function press(tree, name) {
  const node = actNode(tree, name);
  assert.equal(typeof node.props.onClick, 'function', `${name} 必须挂 onClick`);
  node.props.onClick({});
  return node;
}

function input(tree, predicate, value) {
  const node = findOne(tree, predicate);
  assert.ok(node, '找不到输入节点');
  node.props.onInput({ target: { value } });
  return node;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------------- 网络桩：组件自带的 fetch / 浮窗的本页闸口 ---------------- */

/* `fetch` 桩：回执只有组件真正会用到的三样（ok / status / text），调用全记下来。
   `respond(call)` 返回 `{ ok, status, body }`；body 为 null 表示空响应体。
   默认带 JSON `content-type`；反代兜底页那种场景显式给 `contentType: 'text/html'` + `raw`。 */
function stubFetch(respond) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init: init || {} };
    calls.push(call);
    const reply = typeof respond === 'function' ? respond(call, calls) : respond;
    return {
      ok: reply.ok !== false,
      status: reply.status || 200,
      headers: {
        get: (name) => (String(name).toLowerCase() === 'content-type'
          ? (reply.contentType === undefined ? 'application/json; charset=utf-8' : reply.contentType)
          : null),
      },
      text: async () => (reply.raw != null ? String(reply.raw) : (reply.body == null ? '' : JSON.stringify(reply.body))),
    };
  };
  return { calls, restore() { globalThis.fetch = previous; } };
}

/* 浮窗那套闸口：`state.own === false` 时连 fetch 都不发、直接 reject。
   装成全页可见的桩，只为证明组件一次都没有碰它们。 */
function installForeignPageGate() {
  const calls = { gate: 0 };
  const previous = {};
  const keys = ['state', 'guardedFetch', 'requestJson', 'writeJson'];
  for (const key of keys) previous[key] = globalThis[key];
  const reject = (message) => () => {
    calls.gate += 1;
    return Promise.reject(new Error(message));
  };
  globalThis.state = { own: false };
  globalThis.guardedFetch = reject('非本插件页：已暂停取数');
  globalThis.requestJson = reject('非本插件页：已暂停取数');
  globalThis.writeJson = reject('当前不在本插件页');
  return {
    calls,
    restore() {
      for (const key of keys) {
        if (previous[key] === undefined) delete globalThis[key];
        else globalThis[key] = previous[key];
      }
    },
  };
}

/* ---------------- 组件实例 ---------------- */

function mount(modelValue, options) {
  const opts = options || {};
  const emitted = [];
  const requests = { reads: 0, writes: [] };
  const props = {
    modelValue,
    schema: opts.schema || null,
    initial: null,
    disabled: opts.disabled === true,
    prefix: '',
    extra: null,
  };
  const role = createRole({
    read: () => {
      requests.reads += 1;
      return typeof opts.read === 'function' ? opts.read() : Promise.resolve({ policies: [] });
    },
    write: (payload) => {
      requests.writes.push(payload);
      return typeof opts.write === 'function' ? opts.write(payload) : Promise.resolve({ ok: true, policies: [] });
    },
  });
  const model = role.createModel(props, (name, value) => {
    emitted.push({ name, value });
    /* 宿主会把新数组写回 `modelValue`（真实 Vue 里就是 props 更新）。 */
    props.modelValue = value;
  });
  return { model, props, emitted, requests, role };
}

/* ---------------- SUBROLE-01 ---------------- */

test('SUBROLE-01: 按 modelValue 画出表格骨架，监听群与 chip 数量正确', () => {
  const rows = [
    { source: '111111', targets: ['甲群', '乙群'], entry: true, weekly: false },
    /* 历史单值 `target` 也要能读（写回时才统一成 `targets`）。 */
    { source: '222222:333333', target: '丙群', entry: false, weekly: true },
  ];
  const { model } = mount(rows);
  const tree = model.render();

  const headers = findAll(tree, (node) => node.type === 'th').map(text);
  assert.deepEqual(headers, ['监听群', '投递群', '词条', '周报', '操作'], '列头与 role=table 时期一致');

  const rowNodes = findAll(tree, (node) => node.props && node.props['data-ptx-row'] != null && node.type === 'tr');
  assert.equal(rowNodes.length, 2, '两行 modelValue 画两行');

  const sourceInputs = findAll(tree, hasAct('source'));
  assert.deepEqual(sourceInputs.map((node) => node.props.value), ['111111', '222222:333333']);
  assert.equal(sourceInputs.every((node) => node.type === 'input'), true);

  const chips = findAll(tree, (node) => typeof node.props['data-ptx-chip'] === 'string');
  assert.deepEqual(chips.map((node) => node.props['data-ptx-chip']), ['甲群', '乙群', '丙群'], '数组与历史单值都摊成 chip');

  const adds = findAll(tree, hasAct('add-target'));
  assert.equal(adds.length, 2, '每行右侧一个「＋ 添加目标」');
  assert.equal(text(adds[0]), '＋ 添加目标');

  /* 词条 / 周报复选框取当前值。 */
  const entry = findAll(tree, hasAct('entry')).map((node) => node.props.checked);
  const weekly = findAll(tree, hasAct('weekly')).map((node) => node.props.checked);
  assert.deepEqual(entry, [true, false]);
  assert.deepEqual(weekly, [false, true]);

  const addRow = findOne(tree, (node) => node.props['data-ptx-act'] === 'add-row');
  assert.ok(addRow, '底部有「添加行」');
  assert.ok(
    findAll(tree, (node) => String(node.props.class || '') === 'ptx-subrole-foot')
      .some((foot) => foot.children.includes(addRow)),
    '「添加行」放在表格底部的页脚里',
  );
  assert.equal(findOne(tree, (node) => node.props['data-ptx-panel']), null, '没有展开的面板');
});

/* ---------------- SUBROLE-02 ---------------- */

test('SUBROLE-02: 添加行 / 添加目标都换新引用，绝不就地改 modelValue', () => {
  const rows = [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }];
  const { model, emitted } = mount(rows);

  press(model.render(), 'add-row');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, 'update:modelValue');
  const next = emitted[0].value;
  assert.equal(next.length, 2, '长度 +1');
  assert.notEqual(next, rows, '必须换新数组');
  assert.equal(next[0], rows[0], '没改动的行保留原引用（只换容器，不做无谓拷贝）');
  assert.deepEqual(rows, [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }], '原数组不得被就地修改');
  assert.deepEqual(next[0], rows[0], '原有行内容不变');
  assert.deepEqual(next[1], { source: '', targets: [], entry: true, weekly: false }, '新行给的是可编辑的空壳');

  /* 改某一行 = 那一行换新对象，别的行引用不动。 */
  const original = [
    { source: '111111', targets: ['甲群'], entry: true, weekly: false },
    { source: '222222', targets: [], entry: true, weekly: false },
  ];
  const patched = mount(original);
  patched.model.toggleField(0, 'weekly');
  const patchedRows = patched.emitted[0].value;
  assert.notEqual(patchedRows, original, '换新数组');
  assert.notEqual(patchedRows[0], original[0], '改动的那一行换新对象');
  assert.equal(patchedRows[1], original[1], '未改动的行保留原引用');
  assert.equal(patchedRows[0].weekly, true);
  assert.equal(original[0].weekly, false, '原行不得就地修改');

  /* 历史 `target` 行：加目标后只写 `targets`，旧键删除（否则旧值会被回填）。 */
  const legacyRows = [{ source: '111111', target: '甲群' }];
  const second = mount(legacyRows);
  second.model.startNewTarget(0);
  second.model.setNewTarget({ target: { value: '乙群' } });
  second.model.commitNewTarget(0);
  assert.equal(second.emitted.length, 1);
  assert.deepEqual(second.emitted[0].value[0], { source: '111111', targets: ['甲群', '乙群'] });
  assert.equal('target' in second.emitted[0].value[0], false, '写回只留 targets');
  assert.deepEqual(legacyRows, [{ source: '111111', target: '甲群' }], '原行对象不变');

  /* 有候选时「添加目标」是下拉（手填候选外的名字会让整份配置过校验失败）。 */
  const withSchema = mount([{ source: '111111', targets: [] }], {
    schema: {
      inner: {
        dict: {
          targets: {
            inner: {
              type: 'union',
              list: [
                { type: 'const', value: '@chat', meta: { description: '本群聊天' } },
                { type: 'const', value: '#group:111111', meta: { disabled: true, description: '某群' } },
                { type: 'const', value: '甲群', meta: { description: '甲群' } },
              ],
            },
          },
        },
      },
    },
  });
  withSchema.model.startNewTarget(0);
  const picker = findOne(withSchema.model.render(), hasAct('new-target'));
  assert.equal(picker.type, 'select', '有候选就用下拉');
  const options = findAll(picker, (node) => node.type === 'option').map((node) => node.props.value);
  assert.deepEqual(options, ['', '@chat', '甲群'], '标出占位项，分组标题不可选');
});

/* ---------------- SUBROLE-03 ---------------- */

test('SUBROLE-03: 点 chip 展开内联面板，保存只发改动字段并替换本地策略', async () => {
  const policies = [
    { source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 },
  ];
  const rows = [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }];
  const { model, requests, emitted } = mount(rows, {
    read: () => Promise.resolve({ policies }),
    write: () => Promise.resolve({
      ok: true,
      policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 5, perWeek: 1 }],
    }),
  });

  model.loadPolicies();
  await flush();
  assert.equal(requests.reads, 1, '进入组件读一次策略');

  let tree = model.render();
  const chip = findOne(tree, (node) => node.props['data-ptx-chip'] === '甲群');
  const summary = text(findOne(chip, (node) => String(node.props.class || '').includes('chip-policy')));
  assert.equal(summary, '22:00·3/1', 'chip 右侧显示策略摘要');

  chip.props.onClick({});
  tree = model.render();
  const panel = findOne(tree, (node) => node.props['data-ptx-panel'] === '1');
  assert.ok(panel, 'chip 点击后在本行下方展开内联面板');
  assert.ok(text(panel).includes('当前 22:00·3/1'), '面板回显当前策略');
  assert.ok(text(panel).includes('日词条投递时间') && text(panel).includes('周主题投递时间'));
  assert.ok(text(panel).includes('限量'));

  /* 预设只填 cron，不发请求；「立即投」= 清空该字段。 */
  const presets = findAll(panel, (node) => node.type === 'button' && node.props['data-ptx-preset']);
  assert.deepEqual(
    presets.map((node) => node.props['data-ptx-preset']),
    ['0 22 * * *', '0 9 * * *', '0 9 * * 1', '0 20 * * 5'],
  );
  assert.equal(requests.writes.length, 0, '点预设不写盘');

  /* 只改「词条 / 日」这一项。 */
  input(tree, (node) => node.props['data-ptx-count'] === 'perDay', '5');
  assert.equal(requests.writes.length, 0, '输入本身不发请求');

  press(model.render(), 'save');
  await flush();
  assert.equal(requests.writes.length, 1, '一次点击最多一次 POST');
  assert.deepEqual(requests.writes[0], { source: '111111', target: '甲群', perDay: 5 }, '只发改动字段');
  assert.equal(emitted.length, 0, '策略保存不动订阅表本身');

  tree = model.render();
  assert.equal(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), null, '保存成功后收起面板');
  assert.equal(model.state.policiesLoaded, true);
  assert.equal(model.state.policies[0].perDay, 5, '回执里的策略表直接替换本地列表');
  assert.equal(requests.reads, 1, '保存后不再补一次 GET');

  /* 点同一个 chip 再点一次 = 收起（面板就在本行下方）。 */
  findOne(tree, (node) => node.props['data-ptx-chip'] === '甲群').props.onClick({});
  tree = model.render();
  assert.ok(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), '第一次点开');
  findOne(tree, (node) => node.props['data-ptx-chip'] === '甲群').props.onClick({});
  tree = model.render();
  assert.equal(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), null, '再点一次收起');
  assert.equal(requests.reads, 1, '策略已读回，开面板不再请求');
});

test('SUBROLE-03b: 保存失败保留草稿并显示服务端原因', async () => {
  const rows = [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }];
  const { model } = mount(rows, {
    read: () => Promise.resolve({ policies: [] }),
    write: () => Promise.reject(new Error('目标 甲群 未绑定到相册')),
  });
  model.loadPolicies();
  await flush();
  model.openPanel(0, '甲群');
  model.setDraft('entryCron', '0 22 * * *');
  model.savePanel();
  await flush();

  const tree = model.render();
  const error = findOne(tree, (node) => node.props['data-ptx-panel-error'] === '1');
  assert.ok(error, '面板里显示错误文案');
  assert.match(text(error), /未绑定到相册/);
  assert.equal(model.state.draft.entryCron, '0 22 * * *', '草稿必须留着');
  assert.ok(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), '面板不收起');
});

test('SUBROLE-03c: 策略未读回就开面板——读回后草稿换成真值，不会把已有策略清空', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const rows = [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }];
  const { model, requests } = mount(rows, {
    read: () => gate.then(() => ({
      policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1', perDay: 3, perWeek: 1 }],
    })),
    write: () => Promise.resolve({ ok: true, policies: [] }),
  });

  model.loadPolicies();
  model.openPanel(0, '甲群');
  assert.equal(model.state.draft.entryCron, '', '读回之前草稿只能是默认值');
  assert.equal(model.state.draftStale, true);

  release();
  await flush();
  assert.equal(model.state.draft.entryCron, '0 22 * * *', '读回后草稿换成真值');
  assert.equal(model.state.draftStale, false);

  model.savePanel();
  await flush();
  assert.equal(requests.writes.length, 0, '没有任何改动就不发 POST（否则会把已有的 cron 清成立即投）');
});

/* ---------------- SUBROLE-04 ---------------- */
test('SUBROLE-04: disabled 时既不 emit 也不发请求', () => {
  const rows = [
    { source: '111111', targets: ['甲群'], entry: true, weekly: false },
    { source: '222222', targets: ['乙群'], entry: true, weekly: true },
  ];
  const { model, emitted, requests } = mount(rows, { disabled: true });

  model.loadPolicies();
  assert.equal(requests.reads, 0, '禁用态连策略都不读');

  const tree = model.render();
  const chip = findOne(tree, (node) => node.props['data-ptx-chip'] === '甲群');
  assert.equal(chip.props.tabindex, -1, 'chip 不可聚焦');
  chip.props.onClick({});
  assert.equal(model.state.open, null, '点 chip 不展开面板');

  press(tree, 'add-row');
  press(tree, 'add-target');
  press(tree, 'remove');
  press(tree, 'up');
  press(tree, 'remove-target');

  const inputs = findAll(tree, (node) => node.type === 'input');
  const buttons = findAll(tree, (node) => node.type === 'button');
  assert.equal(inputs.every((node) => node.props.disabled === true), true, '所有输入框禁用');
  assert.equal(
    buttons.every((node) => node.props.disabled === true),
    true,
    '所有按钮（含行操作与 chip 删除）禁用',
  );

  /* 直接调动作也走同一条闸门：不是「只靠 DOM 禁用」。 */
  model.setSource(0, { target: { value: '1' } });
  model.toggleField(0, 'weekly');
  model.addTarget(0, '丙群');
  model.removeTarget(0, '甲群');
  model.removeRow(1);
  model.moveRow(0, 1);

  assert.equal(emitted.length, 0, '禁用态一次 emit 都没有');
  assert.equal(requests.reads, 0);
  assert.equal(requests.writes.length, 0);
  assert.deepEqual(rows, [
    { source: '111111', targets: ['甲群'], entry: true, weekly: false },
    { source: '222222', targets: ['乙群'], entry: true, weekly: true },
  ], 'modelValue 一字未动');
});

/* ---------------- 注册契约 ---------------- */

test('SUBROLE-05: role 名 / 注册点 / 注入兜底都对得上', () => {
  assert.equal(SECTION.SUBSCRIPTIONS_ROLE, 'ptx-subscriptions');
  assert.match(CLIENT_SOURCE, /ctx\.schema\(\{ type: 'array', role: SUBSCRIPTIONS_ROLE, component: role\.component \}\)/);
  assert.match(CLIENT_SOURCE, /ctx\.inject\(\['\$setting'\]/, '`ctx.schema` 还没混入时等 `$setting` 上线');

  const boot = /const boot = \(\) => \{([\s\S]*?)\n  \};/.exec(CLIENT_SOURCE);
  assert.ok(boot, '找不到 console 入口的 boot 段');
  assert.match(boot[1], /installSubscriptionsRole\(ctx\)/, 'boot 里注册，不依赖浮窗');
  assert.match(boot[1], /__ptxTagMenuInjection === true/, '旧的标签注入默认关闭');

  assert.equal(SECTION.subscriptionsNormalizePolicies({ policies: [{ source: 'onebot:1', target: '甲群', entryCron: ' ' }] })[0].entryCron, '');
  assert.equal(SECTION.subscriptionsPolicySummary({ entryCron: '0 22 * * *', perDay: 3, perWeek: 1 }), '22:00·3/1');
  assert.equal(SECTION.subscriptionsPolicySummary(null), '', '没有策略就不显示摘要');
});

/* ---------------- SUBROLE-06 ---------------- */

test('SUBROLE-06: 组件自己发请求，state.own === false 时点 chip 也能读回策略并渲染摘要', async () => {
  const gate = installForeignPageGate();
  const net = stubFetch({
    ok: true,
    status: 200,
    body: { policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', perDay: 3, perWeek: 1 }] },
  });
  try {
    /* 不注入 read / write：走生产路径（组件自带的 fetch）。 */
    const role = SECTION.createSubscriptionsRole({ h, reactive: (value) => value });
    const props = { modelValue: [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }] };
    const model = role.createModel(props, () => {});

    findOne(model.render(), (node) => node.props['data-ptx-chip'] === '甲群').props.onClick({});
    await flush();

    assert.equal(net.calls.length, 1, '点 chip 只发一次 GET');
    assert.equal(net.calls[0].url, SECTION.SUBSCRIPTIONS_POLICY_API);
    assert.equal(net.calls[0].url, '/patchouli/api/policies');
    assert.equal(net.calls[0].init.method, undefined, '读是 GET');
    assert.equal(net.calls[0].init.credentials, 'same-origin');
    assert.equal(gate.calls.gate, 0, '浮窗的本页闸口一次都没被调用');
    assert.equal(model.state.policiesLoaded, true, '策略读回来了');

    const tree = model.render();
    assert.equal(findOne(tree, (node) => node.props['data-ptx-status'] === 'error'), null, '不该出现「非本插件页」红字');
    const chip = findOne(tree, (node) => node.props['data-ptx-chip'] === '甲群');
    assert.equal(
      text(findOne(chip, (node) => String(node.props.class || '').includes('chip-policy'))),
      '22:00·3/1',
      'chip 上渲染策略摘要',
    );
    assert.ok(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), '面板照常展开');

    /* 保存走同一条 fetch：POST + JSON 体。 */
    input(tree, (node) => node.props['data-ptx-count'] === 'perDay', '5');
    press(model.render(), 'save');
    await flush();
    const posts = net.calls.filter((call) => call.init.method === 'POST');
    assert.equal(posts.length, 1, '保存发一次 POST');
    assert.equal(posts[0].url, '/patchouli/api/policies');
    assert.equal(posts[0].init.credentials, 'same-origin');
    assert.equal(String(posts[0].init.headers['Content-Type']).toLowerCase(), 'application/json');
    assert.deepEqual(JSON.parse(posts[0].init.body), { source: '111111', target: '甲群', perDay: 5 });
    assert.equal(gate.calls.gate, 0, '写路径也不经过浮窗闸口');
  } finally {
    net.restore();
    gate.restore();
  }
});

/* ---------------- SUBROLE-07 ---------------- */

test('SUBROLE-07: 400 保留草稿并显示服务端原因（走组件自带的 fetch）', async () => {
  const net = stubFetch((call) => (call.init.method === 'POST'
    ? { ok: false, status: 400, body: { ok: false, error: '目标 甲群 未绑定到相册' } }
    : {
      ok: true,
      status: 200,
      body: { policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', perDay: 3, perWeek: 1 }] },
    }));
  try {
    const role = SECTION.createSubscriptionsRole({ h, reactive: (value) => value });
    const props = { modelValue: [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }] };
    const model = role.createModel(props, () => {});

    model.loadPolicies();
    await flush();
    model.openPanel(0, '甲群');
    model.setDraft('perDay', '7');
    model.savePanel();
    await flush();

    const posts = net.calls.filter((call) => call.init.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].init.body), { source: '111111', target: '甲群', perDay: 7 });

    const tree = model.render();
    const error = findOne(tree, (node) => node.props['data-ptx-panel-error'] === '1');
    assert.ok(error, '面板底部显示服务端原因');
    assert.match(text(error), /未绑定到相册/, '原因取自 body.error，不是 HTTP 400');
    assert.equal(model.state.draft.perDay, '7', '草稿必须留着');
    assert.ok(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), '面板不收起');
    assert.equal(model.state.saving, false, '保存态复位，可以再点一次');
  } finally {
    net.restore();
  }
});

/* ---------------- SUBROLE-08 ---------------- */

test('SUBROLE-08: 限量是 `− [ n ] +` 三段，按 0 与上限钳制，且不联网', async () => {
  const rows = [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }];
  const { model, requests } = mount(rows, {
    read: () => Promise.resolve({
      policies: [{ source: '111111', target: '甲群', entryCron: '', weeklyCron: '', perDay: 0, perWeek: 100 }],
    }),
    write: () => Promise.resolve({ ok: true, policies: [] }),
  });
  model.loadPolicies();
  await flush();
  model.openPanel(0, '甲群');

  let tree = model.render();
  const steppers = findAll(tree, (node) => String(node.props.class || '') === 'ptx-subrole-stepper');
  assert.equal(steppers.length, 2, '两个计数各一个 stepper');
  const counts = findAll(tree, (node) => node.props['data-ptx-count'] != null);
  assert.deepEqual(counts.map((node) => node.props.type), ['number', 'number']);
  assert.equal(
    counts.every((node) => !String(node.props.class || '').includes('ptx-subrole-input')),
    true,
    '计数不再是通用输入框：它是 stepper 的中段',
  );
  const daySteps = findAll(tree, (node) => node.props['data-ptx-step'] === 'perDay');
  assert.deepEqual(daySteps.map(text), ['−', '+'], '两侧各一个 `−` / `+`');

  /* 0 再减还是 0；上限处再加就停在上限。 */
  daySteps[0].props.onClick({});
  assert.equal(model.state.draft.perDay, '0', '0 处减一不变');
  daySteps[1].props.onClick({});
  daySteps[1].props.onClick({});
  assert.equal(model.state.draft.perDay, '2', '加一按当前值走');
  model.setDraft('perDay', String(999));
  daySteps[1].props.onClick({});
  assert.equal(model.state.draft.perDay, '999', '词条 / 日上限 999');

  tree = model.render();
  findAll(tree, (node) => node.props['data-ptx-step'] === 'perWeek')[1].props.onClick({});
  assert.equal(model.state.draft.perWeek, '100', '周报 / 周上限 100，不再往上走');
  findAll(model.render(), (node) => node.props['data-ptx-step'] === 'perWeek')[0].props.onClick({});
  assert.equal(model.state.draft.perWeek, '99');

  assert.equal(requests.writes.length, 0, '步进只改草稿，不发请求');
  assert.equal(requests.reads, 1);
});

/* ---------------- SUBROLE-09 ---------------- */

test('SUBROLE-09: 材质跟宿主主题走（主色变量 / 无自绘绿色 / 滚动条 / 无原生 spinner）', () => {
  const css = SECTION.SUBSCRIPTIONS_ROLE_STYLES;

  assert.ok(css.includes('.ptx-subrole .ptx-subrole-btn.is-primary {'), '保存按钮有独立规则');
  assert.match(css, /\.ptx-subrole \.ptx-subrole-btn\.is-primary \{[^}]*background: var\(--k-color-primary/);
  assert.match(css, /\.ptx-subrole \.ptx-subrole-step:hover \{[^}]*var\(--k-color-primary/);
  assert.match(css, /\.ptx-subrole \.ptx-subrole-chip\.is-open \{[^}]*var\(--k-color-primary/);
  assert.match(css, /color-mix\(in srgb, var\(--k-color-primary, #7b6fd8\) 18%, transparent\)/, 'hover 用主色 18% 混色');
  assert.match(css, /background: rgba\(123, 111, 216, \.18\);/, 'color-mix 不支持时的兜底');
  assert.match(css, /accent-color: var\(--k-color-primary/);

  assert.doesNotMatch(css, /#0ea44f|#0b8f45|#0b7f3e/i, '旧的绿色点缀必须清掉');

  assert.match(css, /scrollbar-width: thin/);
  assert.match(css, /scrollbar-color: color-mix\(in srgb, var\(--k-color-border/);
  assert.match(css, /::-webkit-scrollbar-thumb \{[^}]*var\(--k-color-border/);
  assert.match(css, /::-webkit-scrollbar-track \{ background: transparent; \}/);

  assert.match(css, /appearance: textfield/, '原生 spinner 关掉，`−` / `+` 才是入口');

  assert.match(SECTION_SOURCE, /subscriptionsApiFetch\(SUBSCRIPTIONS_POLICY_API\)/, '默认读走组件自带的 fetch');
  assert.match(SECTION_SOURCE, /subscriptionsApiFetch\(SUBSCRIPTIONS_POLICY_API, \{ method: 'POST'/, '默认写也走它');
  assert.doesNotMatch(SECTION_SOURCE, /guardedFetch\(|\brequestJson\(|\bwriteJson\(/, '组件不调浮窗闸口上的任何函数');
});

/* ---------------- SUBROLE-10 ---------------- */

test('SUBROLE-10: 原生下拉换成面板同款材质（color-scheme / 自绘 caret / 28px）', () => {
  const css = SECTION.SUBSCRIPTIONS_ROLE_STYLES;
  /** 取一条规则的正文（这些规则都没有嵌套，第一个 `}` 就是结尾）。 */
  const rule = (selector) => {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, `缺规则 ${selector}`);
    return css.slice(start, css.indexOf('}', start) + 1);
  };

  const base = rule('.ptx-subrole .ptx-subrole-input {');
  assert.match(base, /height: 28px/, '与相邻按钮同高');
  assert.match(base, /box-sizing: border-box/);
  assert.match(base, /border-radius: 6px/, '圆角统一 6px');
  assert.match(base, /background: var\(--k-color-bg2, #2f3033\)/, '底与面板同源');
  assert.match(base, /border: 1px solid var\(--k-color-border/, '与 select 同一条边框');
  assert.match(
    rule('.ptx-subrole .ptx-subrole-input:focus {'),
    /border-color: var\(--k-color-primary[^}]*0 0 0 2px/,
    'focus = 主色 1px 边框 + 2px 淡色外环',
  );

  const select = rule('.ptx-subrole select.ptx-subrole-input {');
  assert.match(select, /color-scheme: dark/, '浏览器自带的 option 列表跟随深色');
  assert.match(select, /appearance: none/, '系统箭头不要');
  assert.match(select, /background: var\(--k-color-bg2, #2f3033\)\s*url\("data:image\/svg\+xml,/, '自绘 caret');
  assert.match(select, /no-repeat right 8px center/);
  assert.match(select, /background-size: 12px 12px/);
  assert.match(select, /padding: 0 26px 0 8px/, '右侧 26px 留给 caret');

  const option = rule('.ptx-subrole select.ptx-subrole-input option {');
  assert.match(option, /background: var\(--k-color-bg2, #2f3033\)/, '支持的平台让 option 也跟随深色');
  assert.match(option, /color: var\(--k-color-font/);
});

/* ---------------- SUBROLE-11 ---------------- */

test('SUBROLE-11: 滚动条 6px、thumb 3px 圆角、hover 走主色', () => {
  const css = SECTION.SUBSCRIPTIONS_ROLE_STYLES;

  assert.match(css, /::-webkit-scrollbar \{ width: 6px; height: 6px; \}/);
  assert.doesNotMatch(css, /::-webkit-scrollbar \{ width: 8px/, '8px 偏粗，已收窄');
  assert.match(css, /scrollbar-width: thin/, 'Firefox 侧仍是细滚动条');

  const thumbAt = css.indexOf('::-webkit-scrollbar-thumb {');
  assert.ok(thumbAt >= 0, '缺 thumb 规则');
  const thumb = css.slice(thumbAt, css.indexOf('}', thumbAt) + 1);
  assert.match(thumb, /color-mix\(in srgb, var\(--k-color-border/);
  assert.match(thumb, /70%, transparent\)/);
  assert.match(thumb, /border-radius: 3px/);

  assert.match(css, /::-webkit-scrollbar-thumb:hover \{ background: var\(--k-color-primary/, 'hover 变主色');
  assert.match(css, /scrollbar-color: color-mix\(in srgb, var\(--k-color-border/);
});

/* ---------------- SUBROLE-12 ---------------- */

test('SUBROLE-12: 全段清空硬编码色值（只留变量与 color-mix 兜底）', () => {
  const css = SECTION.SUBSCRIPTIONS_ROLE_STYLES.toLowerCase();
  const source = SECTION_SOURCE.toLowerCase();

  for (const hex of ['#0ea44f', '#0b8f45', '#5f7d6d', '#7d6fa8', '#8c9a8f']) {
    assert.equal(css.includes(hex), false, `样式里还留着硬编码色 ${hex}`);
    assert.equal(source.includes(hex), false, `角色段源码里还留着硬编码色 ${hex}`);
  }

  /* 允许的形态只有三种：var() 的兜底值、rgba() 的混色兜底、内联 SVG 里 %23 编码的灰。
     `#fff` 是主按钮上的对比白字（深色底上的实心主色按钮不能靠主题变量取反）。 */
  const offenders = css.split('\n').filter((line) => {
    const bare = line
      .replace(/var\([^)]*\)/g, '')
      .replace(/rgba?\([^)]*\)/g, '')
      .replace(/%23[0-9a-f]{6}/g, '')
      .replace(/#fff\b/g, '');
    return /#[0-9a-f]{3,8}\b/.test(bare);
  });
  assert.deepEqual(offenders, [], '这些行出现了变量之外的裸色值：' + offenders.join(' | '));

  assert.doesNotMatch(css, /--el-border-radius-base/, '圆角不再跟宿主的 4px 走，统一 6px');
  assert.doesNotMatch(css, /--el-border-color-light/, '分隔线一律走 --k-color-border');
});

/* ---------------- SUBROLE-13 ---------------- */

test('SUBROLE-13: 一套尺度——按钮/chip/复选框/表格/面板尺寸口径一致', () => {
  const css = SECTION.SUBSCRIPTIONS_ROLE_STYLES;
  const rule = (selector) => {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, `缺规则 ${selector}`);
    return css.slice(start, css.indexOf('}', start) + 1);
  };

  /* 按钮：28px 高、6px 圆角、10px 水平内距；hover 提亮，禁用半透明且不再显示可点光标。 */
  const btn = rule('.ptx-subrole .ptx-subrole-add-target,\n.ptx-subrole .ptx-subrole-btn,\n.ptx-subrole .ptx-subrole-preset {');
  assert.match(btn, /height: 28px/);
  assert.match(btn, /padding: 0 10px/);
  assert.match(btn, /border-radius: 6px/);
  assert.match(btn, /background: transparent/, '次要按钮是描边款');
  assert.match(rule('.ptx-subrole .ptx-subrole-btn.is-primary {'), /background: var\(--k-color-primary/);
  assert.match(css, /filter: brightness\(1\.1\)/);
  assert.match(css, /:disabled \{ opacity: \.5; cursor: default/);

  /* chip：22px 高、6px 圆角、6px 内距。 */
  const chip = rule('.ptx-subrole .ptx-subrole-chip {');
  assert.match(chip, /height: 22px/);
  assert.match(chip, /padding: 0 6px/);
  assert.match(chip, /border-radius: 6px/);
  assert.match(css, /\.ptx-subrole-chip:hover[\s\S]*?border-color: var\(--k-color-primary/, 'hover 边框变主色');

  /* 复选框：15px、跟随主色、自己声明深色渲染。 */
  const check = rule('.ptx-subrole .ptx-subrole-check {');
  assert.match(check, /width: 15px/);
  assert.match(check, /height: 15px/);
  assert.match(check, /vertical-align: middle/);
  assert.match(check, /color-scheme: dark/);
  assert.match(check, /accent-color: var\(--k-color-primary/);

  /* 表格：固定布局 + 百分比列宽，表头 500 字重走次要字色，单元格竖直居中。 */
  assert.match(rule('.ptx-subrole .ptx-subrole-table {'), /table-layout: fixed/);
  assert.match(css, /th:nth-child\(1\) \{ width: 24%; \}/);
  assert.match(css, /th:nth-child\(2\) \{ width: 46%; \}/);
  const th = rule('.ptx-subrole .ptx-subrole-table th {');
  assert.match(th, /font-weight: 500/);
  assert.match(th, /color: var\(--k-color-font-secondary/);
  assert.match(rule('.ptx-subrole .ptx-subrole-table td {'), /vertical-align: middle/);

  /* 面板：12px 内距、10px 区块节律、1px 实线分隔。 */
  assert.match(rule('.ptx-subrole .ptx-subrole-panel {'), /padding: 12px/);
  const secGap = rule('.ptx-subrole .ptx-subrole-sec + .ptx-subrole-sec {');
  assert.match(secGap, /margin-top: 10px/);
  assert.match(secGap, /padding-top: 10px/);
  assert.match(secGap, /border-top: 1px solid var\(--k-color-border/);

  /* 超长目标名/群号截断，不撑宽整表。 */
  for (const selector of ['.ptx-subrole .ptx-subrole-chip-name {', '.ptx-subrole .ptx-subrole-panel-who {']) {
    const r = rule(selector);
    assert.match(r, /max-width:/, `${selector} 缺 max-width`);
    assert.match(r, /text-overflow: ellipsis/);
    assert.match(r, /white-space: nowrap/);
    assert.match(r, /overflow: hidden/);
  }
});

/* ---------------- SUBROLE-14 ---------------- */

test('SUBROLE-14: 策略没读回来之前面板整块禁用，读回后只有真实改动进 body', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const rows = [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }];
  const { model, requests, emitted } = mount(rows, {
    read: () => gate.then(() => ({
      policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1', perDay: 3, perWeek: 1 }],
    })),
    write: () => Promise.resolve({
      ok: true,
      policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1', perDay: 5, perWeek: 1 }],
    }),
  });

  model.loadPolicies();
  model.openPanel(0, '甲群');
  let tree = model.render();
  let panel = findOne(tree, (node) => node.props['data-ptx-panel'] === '1');
  assert.ok(panel, '读回之前也能开面板（草稿是默认值，控件全禁用）');

  const inputs = findAll(panel, (node) => node.type === 'input');
  assert.ok(inputs.length >= 4, '面板里有两条 cron 与两个计数输入框');
  assert.equal(inputs.every((node) => node.props.disabled === true), true, '读回之前所有输入禁用');
  const buttons = findAll(panel, (node) => node.type === 'button' && node.props['data-ptx-act'] !== 'cancel');
  assert.ok(buttons.length > 0);
  assert.equal(buttons.every((node) => node.props.disabled === true), true, '预设 / 立即投 / 步进 / 保存全禁用');
  assert.equal(actNode(tree, 'save').props.disabled, true, '保存按钮在读到策略之前禁用');
  assert.match(text(panel), /正在读取投递策略/);

  /* 直接调动作也走同一条闸门：读回之前草稿动不了，也没有任何写请求。 */
  model.setDraft('perDay', '9');
  assert.equal(model.state.draft.perDay, '0', '读回之前改不动草稿');
  model.savePanel();
  assert.equal(requests.writes.length, 0, '读到之前保存一律不发 POST');

  await flush(); /* 放行微任务：在途的 GET 已发出，但 gate 还没兑现 */
  assert.equal(requests.reads, 1, '读还在途：不会因为开面板 / 点保存再发一遍');
  assert.equal(model.state.policiesLoading, true, '读仍挂着');

  release();
  await flush();
  tree = model.render();
  panel = findOne(tree, (node) => node.props['data-ptx-panel'] === '1');
  assert.equal(
    findAll(panel, (node) => node.type === 'input').every((node) => node.props.disabled !== true),
    true,
    '读回后启用',
  );
  assert.equal(actNode(tree, 'save').props.disabled, false, '读到之后保存可用');
  assert.equal(model.state.draft.perDay, '3', '草稿换成服务端真值');
  assert.equal(model.state.draft.entryCron, '0 22 * * *');
  assert.doesNotMatch(text(panel), /正在读取投递策略/, '读完不再显示读取中');

  /* 只改「词条 / 日」：body 里只有这一项，未改动项一个都不能出现（否则会覆盖 cron / 周报额度）。 */
  input(model.render(), (node) => node.props['data-ptx-count'] === 'perDay', '5');
  press(model.render(), 'save');
  await flush();
  assert.equal(requests.writes.length, 1, '一次点击最多一次 POST');
  assert.deepEqual(requests.writes[0], { source: '111111', target: '甲群', perDay: 5 }, '未改动项不进 body');
  assert.equal(emitted.length, 0, '策略保存不碰订阅表');
  assert.equal(model.state.saving, false, '回执后解锁');
  assert.equal(findOne(model.render(), (node) => node.props['data-ptx-panel'] === '1'), null, '保存成功后收起');
});

/* ---------------- SUBROLE-15 ---------------- */

test('SUBROLE-15: 保存进行中行操作全禁用，迟到回执只收自己那一次的面板', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const rows = [{ source: '111111', targets: ['甲群', '乙群'], entry: true, weekly: false }];
  const { model, requests, emitted } = mount(rows, {
    read: () => Promise.resolve({ policies: [] }),
    write: () => gate.then(() => ({
      ok: true,
      policies: [{ source: '111111', target: '甲群', entryCron: '', weeklyCron: '', perDay: 5, perWeek: 0 }],
    })),
  });

  model.loadPolicies();
  await flush();
  model.openPanel(0, '甲群');
  model.setDraft('perDay', '5');
  model.savePanel();
  assert.equal(model.state.saving, true, '写请求在途');
  await flush(); /* POST 已发出（gate 还没兑现），写锁仍然在 */
  assert.equal(requests.writes.length, 1, '一次点击只有一次 POST');
  assert.equal(model.state.saving, true, '回执没到之前不解锁');

  let tree = model.render();
  assert.equal(tree.props['data-ptx-saving'], '1', '保存期间根节点带 data-ptx-saving');
  assert.equal(actNode(tree, 'remove').props.disabled, true, '删行按钮禁用');
  assert.equal(actNode(tree, 'add-row').props.disabled, true, '加行按钮禁用');
  assert.equal(actNode(tree, 'add-target').props.disabled, true, '加目标按钮禁用');
  assert.equal(actNode(tree, 'up').props.disabled, true, '上移按钮禁用');
  assert.equal(actNode(tree, 'down').props.disabled, true, '下移按钮禁用');
  assert.equal(actNode(tree, 'remove-target').props.disabled, true, '删目标按钮禁用');
  assert.equal(actNode(tree, 'save').props.disabled, true, '保存中再点一次也不重发');

  /* DOM 禁用 + 动作闸门两条都要挡住：底下的函数直接调也不能改表。 */
  press(tree, 'remove');
  press(tree, 'add-row');
  press(tree, 'add-target');
  press(tree, 'remove-target');
  model.removeRow(0);
  model.moveRow(0, 1);
  model.addTarget(0, '丙群');
  model.removeTarget(0, '甲群');
  assert.equal(emitted.length, 0, '保存期间删行 / 加行 / 加目标 / 移行一次 emit 都没有');
  assert.equal(requests.writes.length, 1, '一次点击只有一次 POST');

  /* 请求没回来时换到另一个目标的面板：写锁仍在，但旧回执不许关掉新面板。 */
  model.openPanel(0, '乙群');
  tree = model.render();
  assert.equal(model.state.open.target, '乙群', '保存期间允许换面板（chip 不是行操作）');
  assert.equal(tree.props['data-ptx-saving'], '1', '换面板不提前解除写锁');
  assert.ok(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), '新面板已展开');

  release();
  await flush();
  assert.equal(model.state.saving, false, '回执到达后解锁');
  assert.equal(requests.writes.length, 1);
  assert.equal(model.state.open && model.state.open.target, '乙群', '旧回执没有关掉新面板');
  tree = model.render();
  assert.ok(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), '新面板还开着');
  assert.equal(tree.props['data-ptx-saving'], undefined, '解锁后根节点不再带 data-ptx-saving');
  assert.equal(model.state.policies[0].perDay, 5, '回执里的策略表照样替换本地列表');
});

/* ---------------- SUBROLE-16 ---------------- */

test('SUBROLE-16: 接口回 HTML（非 JSON）时算读失败，面板禁保存且不发 POST', async () => {
  const net = stubFetch({
    ok: true,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    raw: '<!doctype html><html><body>Not Found</body></html>',
  });
  try {
    await assert.rejects(
      SECTION.subscriptionsApiFetch(SECTION.SUBSCRIPTIONS_POLICY_API),
      /策略接口返回非 JSON（HTTP 200）/,
      '解析不出 JSON 必须抛错，不能当成空的策略表',
    );

    const role = SECTION.createSubscriptionsRole({ h, reactive: (value) => value });
    const props = { modelValue: [{ source: '111111', targets: ['甲群'], entry: true, weekly: false }] };
    const model = role.createModel(props, () => {});

    model.loadPolicies();
    await flush();
    assert.equal(model.state.policiesLoaded, false, '非 JSON 绝不能当成「已读到」');
    assert.deepEqual(model.state.policies, [], '本地策略表不能被反代页面冒充成「服务端没有策略」');
    assert.match(model.state.policiesError, /非 JSON/);

    model.openPanel(0, '甲群');
    const tree = model.render();
    const panel = findOne(tree, (node) => node.props['data-ptx-panel'] === '1');
    const error = findOne(panel, (node) => node.props['data-ptx-panel-error'] === '1');
    assert.ok(error, '面板里显示读取失败的原因');
    assert.match(text(error), /非 JSON/);
    assert.equal(
      findAll(panel, (node) => node.type === 'input').every((node) => node.props.disabled === true),
      true,
      '读失败时面板控件照样禁用',
    );
    assert.equal(actNode(tree, 'save').props.disabled, true, '读不到策略时禁止保存');
    assert.ok(actNode(tree, 'retry'), '给出「重试」入口');

    press(tree, 'save');
    await flush();
    assert.equal(
      net.calls.filter((call) => call.init.method === 'POST').length,
      0,
      '不发 POST（否则会把服务端已有的 cron / 额度覆盖成空）',
    );
  } finally {
    net.restore();
  }
});

/* ---------------- SUBROLE-17 ---------------- */

test('SUBROLE-17: 键盘——删除键只删除不展开、Esc 关闭回焦、Tab 首尾回绕', async () => {
  const { model, emitted } = mount([{ source: '111111', targets: ['甲群', '乙群'], entry: true, weekly: false }], {
    read: () => Promise.resolve({ policies: [] }),
  });
  model.loadPolicies();
  await flush();

  /* 删除键上的 Enter：只删目标，事件不冒到 chip 上把面板打开。 */
  let tree = model.render();
  let chip = findAll(tree, (node) => node.props['data-ptx-chip'] === '甲群')[0];
  let remove = findOne(chip, hasAct('remove-target'));
  let prevented = 0;
  let stopped = 0;
  remove.props.onKeydown({
    key: 'Enter',
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  });
  assert.equal(prevented, 1, 'preventDefault：挡掉浏览器在 keydown 之后补发的 click');
  assert.equal(stopped, 1, 'stopPropagation：别让 chip 的 keydown 再把面板打开');
  assert.equal(emitted.length, 1, '删除只发一次 update:modelValue');
  assert.deepEqual(emitted[0].value[0].targets, ['乙群'], '删的是被点的那一个目标');
  assert.equal(model.state.open, null, '删除键不展开面板');

  /* 空格走同一条：只删除。 */
  tree = model.render();
  chip = findAll(tree, (node) => node.props['data-ptx-chip'] === '乙群')[0];
  findOne(chip, hasAct('remove-target')).props.onKeydown({
    key: ' ',
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.deepEqual(emitted[1].value[0].targets, [], '空格也只删除');
  assert.equal(model.state.open, null);

  /* 面板：role/aria、Tab 循环、Esc 关闭并把焦点还给 chip。 */
  const second = mount([{ source: '111111', targets: ['甲群'], entry: true, weekly: false }], {
    read: () => Promise.resolve({
      policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 }],
    }),
  });
  second.model.loadPolicies();
  await flush();

  const chipEl = { focusCount: 0, focus() { this.focusCount += 1; } };
  tree = second.model.render();
  chip = findOne(tree, (node) => node.props['data-ptx-chip'] === '甲群');
  assert.equal(chip.props['aria-expanded'], 'false', '收起时 aria-expanded=false');
  chip.props.onClick({ currentTarget: chipEl });
  tree = second.model.render();
  assert.equal(
    findOne(tree, (node) => node.props['data-ptx-chip'] === '甲群').props['aria-expanded'],
    'true',
    '展开时 aria-expanded=true',
  );
  const panel = findOne(tree, (node) => node.props['data-ptx-panel'] === '1');
  assert.equal(panel.props.role, 'dialog', '面板是对话框语义');
  assert.equal(panel.props['aria-label'], '投递策略');
  assert.equal(typeof panel.props.onKeydown, 'function', '键盘处理挂在面板上');

  const focusable = (name) => ({ name, disabled: false, focused: 0, focus() { this.focused += 1; } });
  const first = focusable('first');
  const middle = focusable('middle');
  const last = focusable('last');
  const host = {
    querySelectorAll: () => [first, middle, last],
    contains: (node) => node === first || node === middle || node === last,
  };
  let tabPrevented = 0;
  const swallow = () => { tabPrevented += 1; };
  panel.props.onKeydown({ key: 'Tab', currentTarget: host, target: last, preventDefault: swallow });
  assert.equal(tabPrevented, 1, '末尾 Tab 要吃掉默认行为');
  assert.equal(first.focused, 1, '末尾 Tab 回绕到第一个控件');
  panel.props.onKeydown({ key: 'Tab', shiftKey: true, currentTarget: host, target: first, preventDefault: swallow });
  assert.equal(tabPrevented, 2);
  assert.equal(last.focused, 1, '第一个控件 Shift+Tab 回绕到末尾');
  panel.props.onKeydown({ key: 'Tab', currentTarget: host, target: middle });
  assert.equal(middle.focused, 0, '中间控件不拦截');
  panel.props.onKeydown({ key: 'Tab', currentTarget: host, target: { focus() {} }, preventDefault: swallow });
  assert.equal(tabPrevented, 3);
  assert.equal(first.focused, 2, '焦点不在面板里时 Tab 拉回第一个控件');

  let escPrevented = 0;
  panel.props.onKeydown({
    key: 'Escape',
    currentTarget: host,
    preventDefault: () => { escPrevented += 1; },
    stopPropagation: () => {},
  });
  assert.equal(escPrevented, 1);
  assert.equal(second.model.state.open, null, 'Esc 关闭面板');
  assert.equal(chipEl.focusCount, 1, '焦点回到触发它的 chip');
  tree = second.model.render();
  assert.equal(findOne(tree, (node) => node.props['data-ptx-panel'] === '1'), null, '面板已收起');
  assert.equal(
    findOne(tree, (node) => node.props['data-ptx-chip'] === '甲群').props['aria-expanded'],
    'false',
  );
});
