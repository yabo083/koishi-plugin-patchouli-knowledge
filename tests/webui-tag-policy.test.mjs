import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 订阅表投递群标签（`el-tag.is-closable`）的右键策略菜单契约。
 *
 * 策略真源在 `settings.json`，编辑入口是 Console 插件页订阅表里投递群标签的右键菜单：
 *   - 后缀：`entryCron·周weeklyCron·perDay/perWeek`，挂成 `data-ptx-policy` 属性（CSS 伪元素渲染，避免与 Vue patch 冲突）；
 *   - 菜单：指针定位、三块（日词条投递时间 / 周主题投递时间 / 限量）、保存走 POST /api/policies；
 *   - 非本插件页：不接管右键、零请求。
 * 客户端产物里这一段用 `BEGIN/END TAG POLICY MENU` 标记，独立载入即可（只依赖注入的
 * document / window），因此这里给一个最小 DOM 桩，不用真的跑宿主 Vue。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');
const BEGIN = '// BEGIN TAG POLICY MENU';
const END = '// END TAG POLICY MENU';

/* ---------------- 最小 DOM 桩 ---------------- */

/** 只覆盖本段代码真正用到的选择器：标签名、`.a.b` 复合类、`#id`、`[attr="v"]`。 */
function matchesOne(node, selector) {
  const sel = String(selector).trim();
  if (!sel) return false;
  const attr = /^\[([\w-]+)(?:=(["']?)(.*?)\2)?\]$/.exec(sel);
  if (attr) {
    const value = node.getAttribute(attr[1]);
    return attr[2] === undefined ? value != null : value === attr[3];
  }
  const tag = /^([a-zA-Z][\w-]*)/.exec(sel);
  if (tag && node.tagName !== tag[1].toUpperCase()) return false;
  for (const cls of [...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1])) {
    if (!node._classes.has(cls)) return false;
  }
  const id = /#([\w-]+)/.exec(sel);
  if (id && node.getAttribute('id') !== id[1]) return false;
  return true;
}

function matches(node, selector) {
  return String(selector)
    .split(',')
    .some((part) => matchesOne(node, part));
}

function walk(node, visit) {
  for (const child of node.children) {
    visit(child);
    walk(child, visit);
  }
}

class StubNode {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.listeners = new Map();
    this._classes = new Set();
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.classList = {
      add: (...names) => { for (const name of names) this._classes.add(name); },
      remove: (...names) => { for (const name of names) this._classes.delete(name); },
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : !!force;
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
  }

  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }

  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parentNode = null;
    return node;
  }

  insertBefore(node, reference) {
    const at = reference ? this.children.indexOf(reference) : -1;
    node.parentNode = this;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  }

  /* DOM 语义：写 textContent 会清空子节点；读时文本节点在前、子节点文本在后。 */
  get textContent() {
    if (!this.children.length) return this._text;
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value == null ? '' : value);
    this.children = [];
  }

  getBoundingClientRect() {
    return { width: 260, height: 380, left: 0, top: 0 };
  }

  contains(node) {
    let cursor = node;
    while (cursor) {
      if (cursor === this) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }

  closest(selector) {
    let cursor = this;
    while (cursor) {
      if (cursor instanceof StubNode && matches(cursor, selector)) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const out = [];
    walk(this, (node) => { if (matches(node, selector)) out.push(node); });
    return out;
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    let cursor = this;
    while (cursor && !event._stopped) {
      const list = cursor.listeners.get(event.type) || [];
      for (const handler of list.slice()) handler.call(cursor, event);
      cursor = cursor.parentNode;
    }
    if (!event._stopped) {
      const doc = this.ownerDocument;
      const list = doc.listeners.get(event.type) || [];
      for (const handler of list.slice()) handler.call(doc, event);
    }
    return !event.defaultPrevented;
  }
}

function createDom() {
  const document = {
    readyState: 'complete',
    listeners: new Map(),
    addEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      list.push(handler);
      this.listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
    createElement(tagName) { return new StubNode(tagName, document); },
    getElementById(id) {
      let found = null;
      walk(document.documentElement, (node) => {
        if (!found && node.getAttribute('id') === id) found = node;
      });
      return found;
    },
    querySelector(selector) { return document.documentElement.querySelector(selector); },
    querySelectorAll(selector) { return document.documentElement.querySelectorAll(selector); },
  };
  document.documentElement = new StubNode('html', document);
  document.head = new StubNode('head', document);
  document.body = new StubNode('body', document);
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);

  const window = {
    innerWidth: 1280,
    innerHeight: 900,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { document, window };
}

/* ---------------- 产物载入 ---------------- */

function loadFactory() {
  const start = CLIENT_SOURCE.indexOf(BEGIN);
  const stop = CLIENT_SOURCE.indexOf(END, start);
  assert.ok(start >= 0 && stop > start, '客户端产物里缺 TAG POLICY MENU 标记');
  const body = CLIENT_SOURCE.slice(start + BEGIN.length, stop);
  return new Function(
    'window', 'document',
    `${body}\nreturn { createTagPolicyMenu, TAG_POLICY_STYLES, formatTagPolicy };`,
  );
}

function makeEvent(type, props) {
  return {
    type,
    target: null,
    defaultPrevented: false,
    _stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopped = true; },
    ...props,
  };
}

/** 造一行订阅表：第一列监听群号，第二列 el-select 里的投递群标签。 */
function buildSubscriptionTable(doc, rows) {
  const table = doc.createElement('table');
  const tbody = doc.createElement('tbody');
  table.appendChild(tbody);
  const built = [];
  for (const row of rows) {
    const tr = doc.createElement('tr');
    const sourceCell = doc.createElement('td');
    sourceCell.textContent = row.source;
    const targetCell = doc.createElement('td');
    const select = doc.createElement('div');
    select.className = 'el-select';
    const tag = doc.createElement('span');
    tag.className = 'el-tag el-tag--info el-tag--default el-tag--light is-closable';
    const content = doc.createElement('span');
    content.className = 'el-tag__content';
    content.textContent = row.target;
    const close = doc.createElement('span');
    close.className = 'el-tag__close';
    tag.appendChild(content);
    tag.appendChild(close);
    select.appendChild(tag);
    targetCell.appendChild(select);
    tr.appendChild(sourceCell);
    tr.appendChild(targetCell);
    tbody.appendChild(tr);
    built.push({ tr, tag, content, close });
  }
  doc.body.appendChild(table);
  return built;
}

/**
 * 造一行「目标被折叠」的订阅表：可见目标一个 `el-tag` + 折叠标记 `+ N`。
 *
 * 结构与 Element Plus 2.7 的 `collapse-tags` 一致：`+ N` 标签**没有** `is-closable`，
 * 文本在 `.el-select__tags-text` 里，因此只能靠文本形态识别。
 */
function buildCollapsedTable(doc, rows) {
  const table = doc.createElement('table');
  const tbody = doc.createElement('tbody');
  table.appendChild(tbody);
  const built = [];
  for (const row of rows) {
    const tr = doc.createElement('tr');
    const sourceCell = doc.createElement('td');
    sourceCell.textContent = row.source;
    const targetCell = doc.createElement('td');
    const select = doc.createElement('div');
    select.className = 'el-select';

    const visibleItem = doc.createElement('div');
    visibleItem.className = 'el-select__selected-item';
    const tag = doc.createElement('span');
    tag.className = 'el-tag el-tag--info el-tag--default el-tag--light is-closable';
    const content = doc.createElement('span');
    content.className = 'el-tag__content';
    content.textContent = row.visible;
    const close = doc.createElement('span');
    close.className = 'el-tag__close';
    tag.appendChild(content);
    tag.appendChild(close);
    visibleItem.appendChild(tag);
    select.appendChild(visibleItem);

    const plusItem = doc.createElement('div');
    plusItem.className = 'el-select__selected-item';
    const plusTag = doc.createElement('span');
    plusTag.className = 'el-tag el-tag--info el-tag--default el-tag--light';
    const plusContent = doc.createElement('span');
    plusContent.className = 'el-tag__content';
    const plusText = doc.createElement('span');
    plusText.className = 'el-select__tags-text';
    plusText.textContent = '+ ' + String(row.collapsed);
    plusContent.appendChild(plusText);
    plusTag.appendChild(plusContent);
    plusItem.appendChild(plusTag);
    select.appendChild(plusItem);

    targetCell.appendChild(select);
    tr.appendChild(sourceCell);
    tr.appendChild(targetCell);
    tbody.appendChild(tr);
    built.push({ tr, tag, content, close, plusItem, plusTag, plusText });
  }
  doc.body.appendChild(table);
  return built;
}

function setup(options = {}) {
  const dom = createDom();
  const factory = loadFactory();
  const api = factory(dom.window, dom.document);
  const state = { own: options.own !== false };
  const calls = { reads: 0, writes: [], targetReads: 0, claims: 0 };
  const menu = api.createTagPolicyMenu({
    document: dom.document,
    window: dom.window,
    MutationObserver: options.MutationObserver || null,
    isOwnPage: () => state.own,
    /* 认领替身：与生产同义（认领成功 → 本页变 own），并记一次数。 */
    claim: () => {
      calls.claims += 1;
      state.own = true;
    },
    identify: options.identify,
    read: () => {
      calls.reads += 1;
      return Promise.resolve({ policies: options.policies || [] });
    },
    write:
      options.write ||
      ((payload) => {
        calls.writes.push(payload);
        return Promise.resolve({ ok: true });
      }),
    readTargets:
      options.readTargets ||
      (() => {
        calls.targetReads += 1;
        return Promise.resolve(options.subscriptions || { rows: [] });
      }),
    scanDelay: 0,
  });
  return { ...dom, api, menu, calls, state };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------------- 用例 ---------------- */

test('TAG-01: 策略回显只落在有策略的标签上，文案为 entryCron·周weeklyCron·perDay/perWeek', async () => {
  const client = setup({
    policies: [
      { source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 },
      { source: '222222', target: '乙群', entryCron: '', weeklyCron: '0 9 * * 1', perDay: 0, perWeek: 2 },
    ],
  });
  const rows = buildSubscriptionTable(client.document, [
    { source: '111111', target: '甲群' },
    { source: '222222', target: '乙群' },
    { source: '333333', target: '丙群' },
  ]);

  client.menu.attach();
  await client.menu.refresh();

  const suffixes = rows.map((row) => row.tag.getAttribute('data-ptx-policy'));
  assert.equal(suffixes.filter(Boolean).length, 2, '只有两条策略对应标签带后缀');
  assert.equal(suffixes[0], '0 22 * * *·3/1', '只有词条定时时就是 cron + 限量');
  assert.equal(suffixes[1], '周0 9 * * 1·0/2', '周主题那条带「周」前缀，词条段为空即省略');
  assert.equal(suffixes[2], null, '没有策略的标签不得挂后缀');

  for (const row of rows) {
    assert.ok(row.tag.querySelector('.el-tag__close'), '关闭按钮必须原样保留');
    assert.equal(row.close.parentNode, row.tag, '后缀不得挪动关闭按钮的父节点');
  }
  assert.match(client.api.TAG_POLICY_STYLES, /\[data-ptx-policy\]::after\s*\{[^}]*content:\s*attr\(data-ptx-policy\)/,
    '后缀必须 pointer-events:none，否则会吃掉关闭按钮 / 下拉的点击');
  assert.equal(client.calls.reads, 1, '进入页面只读一次策略');
});

test('TAG-02: 右键在指针坐标弹菜单，菜单项正确，换标签时菜单跟随', async () => {
  const client = setup({
    policies: [
      { source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1', perDay: 3, perWeek: 1 },
    ],
  });
  const rows = buildSubscriptionTable(client.document, [
    { source: '111111', target: '甲群' },
    { source: '222222', target: '乙群' },
  ]);
  client.menu.attach();
  await client.menu.refresh();

  rows[0].tag.dispatchEvent(makeEvent('contextmenu', { clientX: 320, clientY: 210 }));
  let menus = client.document.querySelectorAll('.ptx-policy-menu');
  assert.equal(menus.length, 1, '右键后只允许一个菜单');
  assert.equal(menus[0].style.left, '320px');
  assert.equal(menus[0].style.top, '210px');

  const titles = menus[0].querySelectorAll('.ptx-policy-sec-title').map((node) => node.textContent);
  assert.deepEqual(titles, ['日词条投递时间', '周主题投递时间', '限量'], '定时拆成两块，限量另起一块');
  assert.equal(menus[0].querySelectorAll('.ptx-policy-toggle').length, 0, '不再有折叠头');
  assert.equal(menus[0].querySelector('.ptx-policy-eyebrow').textContent, '投递策略', '第一行是弱色小字标签');

  const entrySec = menus[0].querySelector('.ptx-policy-sec-entry');
  const weeklySec = menus[0].querySelector('.ptx-policy-sec-weekly');
  assert.ok(entrySec && weeklySec, '两块定时区各有自己的容器');
  const entryInput = entrySec.querySelector('.ptx-policy-cron');
  const weeklyInput = weeklySec.querySelector('.ptx-policy-cron');
  assert.ok(entryInput && weeklyInput, '两块各有自己的 cron 输入框');
  assert.equal(entryInput.getAttribute('placeholder'), '0 22 * * *');
  assert.equal(weeklyInput.getAttribute('placeholder'), '0 9 * * 1');
  assert.equal(entryInput.value, '0 22 * * *', '词条那块回显 entryCron');
  assert.equal(weeklyInput.value, '0 9 * * 1', '周报那块回显 weeklyCron');
  assert.equal(entrySec.querySelector('.ptx-policy-clear').textContent, '立即投', '每块右侧各一个清空入口');
  assert.equal(weeklySec.querySelector('.ptx-policy-clear').textContent, '立即投');
  assert.deepEqual(
    entrySec.querySelectorAll('.ptx-policy-chip').map((node) => node.textContent),
    ['每天 22:00', '每天 09:00'],
    '日词条只给每天的预设',
  );
  assert.deepEqual(
    weeklySec.querySelectorAll('.ptx-policy-chip').map((node) => node.textContent),
    ['每周一 09:00', '每周五 20:00'],
    '周主题只给每周的预设',
  );
  assert.ok(menus[0].querySelector('.ptx-policy-perday'), '限量下要有词条 / 日');
  assert.ok(menus[0].querySelector('.ptx-policy-perweek'), '限量下要有周报 / 周');
  assert.ok(menus[0].querySelector('.ptx-policy-perday-up'), '数字控件有 + 按钮');
  assert.ok(menus[0].querySelector('.ptx-policy-perday-down'), '数字控件有 − 按钮');
  assert.match(menus[0].querySelector('.ptx-policy-footnote').textContent, /0 = 不限 · 空 = 立即投/);
  assert.ok(menus[0].querySelector('.ptx-policy-save'));
  assert.ok(menus[0].querySelector('.ptx-policy-cancel'));
  assert.match(menus[0].querySelector('.ptx-policy-who').textContent, /111111 → 甲群/);

  /* 视觉契约：固定 304px、无原生数字 spinner、关键新增元素都有深色变体。 */
  const styles = client.api.TAG_POLICY_STYLES;
  assert.match(styles, /width: 304px;/, '菜单宽度固定 304px');
  assert.match(styles, /\.ptx-policy-count[^{]*\{[^}]*appearance: none/, '数字控件关掉原生 spinner');
  for (const part of ['ptx-policy-chip', 'ptx-policy-stepper', 'ptx-policy-footnote', 'ptx-policy-clear']) {
    assert.match(styles, new RegExp(`\\.ptx-policy-menu\\.is-dark \\.${part}`), `${part} 缺深色变体`);
  }

  /* 菜单的两种常规退场：Esc 与点击菜单外。 */
  client.document.body.dispatchEvent(makeEvent('keydown', { key: 'Escape' }));
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0, 'Esc 收起菜单');

  rows[1].tag.dispatchEvent(makeEvent('contextmenu', { clientX: 410, clientY: 300 }));
  client.document.body.dispatchEvent(makeEvent('mousedown'));
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0, '点菜单外收起菜单');

  rows[1].tag.dispatchEvent(makeEvent('contextmenu', { clientX: 410, clientY: 300 }));
  menus = client.document.querySelectorAll('.ptx-policy-menu');
  assert.equal(menus.length, 1, '换标签时必须先收起旧菜单');
  assert.equal(menus[0].style.left, '410px');
  assert.equal(menus[0].style.top, '300px');
  assert.match(menus[0].querySelector('.ptx-policy-who').textContent, /222222 → 乙群/);
  assert.equal(
    menus[0].querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value,
    '',
    '无策略的词条块回显为空',
  );
  assert.equal(
    menus[0].querySelector('.ptx-policy-sec-weekly').querySelector('.ptx-policy-cron').value,
    '',
    '无策略的周报块回显为空',
  );
});

test('TAG-03: 保存只发一次 POST，body 带 source/target/两条 cron/新值，成功后后缀更新', async () => {
  const client = setup({
    policies: [
      { source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1', perDay: 3, perWeek: 1 },
    ],
  });
  const [row] = buildSubscriptionTable(client.document, [{ source: '111111', target: '甲群' }]);
  client.menu.attach();
  await client.menu.refresh();

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  const menu = client.document.querySelector('.ptx-policy-menu');
  const entryInput = menu.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron');
  const weeklyInput = menu.querySelector('.ptx-policy-sec-weekly').querySelector('.ptx-policy-cron');
  entryInput.value = '0 7 * * *';
  weeklyInput.value = '0 20 * * 5';
  assert.equal(entryInput.value, '0 7 * * *', '改词条那块不得动周主题');
  assert.equal(weeklyInput.value, '0 20 * * 5', '改周主题那块不得动词条');
  menu.querySelector('.ptx-policy-perday').value = '5';
  menu.querySelector('.ptx-policy-perweek').value = '2';

  const save = menu.querySelector('.ptx-policy-save');
  save.dispatchEvent(makeEvent('click'));
  save.dispatchEvent(makeEvent('click')); // 连点：回执前不得再发
  await flush();

  assert.equal(client.calls.writes.length, 1, '一次保存只能有一个 POST');
  assert.deepEqual(client.calls.writes[0], {
    source: '111111',
    target: '甲群',
    entryCron: '0 7 * * *',
    weeklyCron: '0 20 * * 5',
    perDay: 5,
    perWeek: 2,
  });
  assert.equal(row.tag.getAttribute('data-ptx-policy'), '0 7 * * *·周0 20 * * 5·5/2');
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0, '保存成功后收起菜单');
});

test('TAG-04: 服务端 400 的原因显示在菜单里，后缀不变', async () => {
  const client = setup({
    policies: [
      { source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 },
    ],
    write: (payload) => {
      client.calls.writes.push(payload);
      return Promise.reject(new Error('entryCron 非法：字段数必须是 5'));
    },
  });
  const [row] = buildSubscriptionTable(client.document, [{ source: '111111', target: '甲群' }]);
  client.menu.attach();
  await client.menu.refresh();

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  const menu = client.document.querySelector('.ptx-policy-menu');
  menu.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value = '0 22 *';
  menu.querySelector('.ptx-policy-save').dispatchEvent(makeEvent('click'));
  await flush();

  const menuAfter = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menuAfter, '400 时菜单必须保持打开，用户才能改');
  const error = menuAfter.querySelector('.ptx-policy-error');
  assert.ok(error.classList.contains('is-visible'));
  assert.match(error.textContent, /entryCron 非法：字段数必须是 5/);
  assert.ok(menuAfter.querySelector('.ptx-policy-footnote').classList.contains('is-hidden'), '错误顶替底部说明');
  assert.equal(row.tag.getAttribute('data-ptx-policy'), '0 22 * * *·3/1', '失败不得改写后缀');
  assert.equal(client.calls.writes.length, 1);
});

test('TAG-05: 非本插件页不接管右键，零请求', async () => {
  const client = setup({
    own: false,
    policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 }],
  });
  const [row] = buildSubscriptionTable(client.document, [{ source: '111111', target: '甲群' }]);
  client.menu.attach();
  client.menu.syncOwn(false);
  await client.menu.refresh();

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));

  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0, '别的插件页不弹菜单');
  assert.equal(client.calls.reads, 0, '非本插件页连策略都不读');
  assert.equal(client.calls.writes.length, 0);
  assert.equal(row.tag.getAttribute('data-ptx-policy'), null, '非本插件页也不挂后缀');
});

test('TAG-07: 后挂载的订阅表由 MutationObserver 补绑，不用刷新页面', async () => {
  class FakeObserver {
    static last = null;
    constructor(callback) { this.callback = callback; this.observing = false; FakeObserver.last = this; }
    observe(target) { this.observing = true; this.target = target; }
    disconnect() { this.observing = false; }
    fire() { this.callback([]); }
  }

  const client = setup({
    MutationObserver: FakeObserver,
    policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 }],
  });
  client.menu.attach();
  client.menu.syncOwn(true);
  await flush();

  const observer = FakeObserver.last;
  assert.ok(observer && observer.observing, 'attach 必须监听宿主主区域');
  assert.equal(client.document.querySelectorAll('.el-tag.is-closable').length, 0);

  const [row] = buildSubscriptionTable(client.document, [{ source: '111111', target: '甲群' }]);
  observer.fire();
  await flush();

  assert.equal(row.tag.getAttribute('data-ptx-policy-tag'), '1', '新标签要打上已绑标记');
  assert.equal(row.tag.getAttribute('data-ptx-policy'), '0 22 * * *·3/1');

  client.menu.destroy();
  assert.equal(observer.observing, false, 'destroy 要断掉宿主观察');
  assert.equal(row.tag.getAttribute('data-ptx-policy'), null, 'destroy 要摘掉自己塞的后缀');
});

test('TAG-08: 策略还没读回来时保存先补读，不拿默认值覆盖服务端', async () => {
  const client = setup({
    policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 }],
  });
  const [row] = buildSubscriptionTable(client.document, [{ source: '111111', target: '甲群' }]);
  /* 只挂菜单，不做 refresh：模拟策略读取失败 / 迟到。 */
  client.menu.attach();
  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));

  const menu = client.document.querySelector('.ptx-policy-menu');
  menu.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value = '0 9 * * 1';
  menu.querySelector('.ptx-policy-save').dispatchEvent(makeEvent('click'));
  await flush();

  assert.equal(client.calls.writes.length, 0, '策略未读回时不得发出 POST');
  assert.equal(client.calls.reads, 1, '拦下后要补读一次');
  assert.match(menu.querySelector('.ptx-policy-error').textContent, /尚未读取完成/);
  assert.equal(row.tag.getAttribute('data-ptx-policy'), '0 22 * * *·3/1', '读回后后缀照常出现');
});

test('TAG-09: 通配来源行（*）只提示不可配置，没有保存入口', async () => {
  const client = setup({
    policies: [{ source: '*', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 }],
  });
  const [row] = buildSubscriptionTable(client.document, [{ source: '*', target: '甲群' }]);
  client.menu.attach();
  await client.menu.refresh();

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  const menu = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menu, '通配行也要给反馈，不能静默');
  assert.match(menu.querySelector('.ptx-policy-blocked').textContent, /通配来源（\*）/);
  assert.equal(menu.querySelector('.ptx-policy-save'), null, '通配行不给保存入口');
  assert.equal(menu.querySelector('.ptx-policy-cron'), null, '通配行也不给编辑框（两块都没有）');
  assert.equal(menu.querySelector('.ptx-policy-sec-entry'), null, '通配行连定时区都不建');

  menu.querySelector('.ptx-policy-cancel').dispatchEvent(makeEvent('click'));
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0);
  assert.equal(client.calls.writes.length, 0);
});

test('TAG-10: 表里带平台前缀时与后端去前缀的键等价', async () => {
  const client = setup({
    policies: [{ source: '444444', target: '甲群', entryCron: '0 9 * * *', weeklyCron: '', perDay: 0, perWeek: 0 }],
  });
  const [row] = buildSubscriptionTable(client.document, [{ source: 'onebot:444444', target: '甲群' }]);
  client.menu.attach();
  await client.menu.refresh();

  assert.equal(row.tag.getAttribute('data-ptx-policy'), '0 9 * * *');
});

test('TAG-06: 入口装上菜单，路由归属变化时同步（本页才读策略）', () => {
  const apply = /export default function applyPatchouliWikiReader[\s\S]*$/m.exec(CLIENT_SOURCE);
  assert.ok(apply, '找不到 Console 入口');
  assert.match(apply[0], /tagPolicyMenu = createTagPolicyMenu\(/);
  assert.match(apply[0], /\/api\/policies/);
  assert.match(apply[0], /tagPolicyMenu\.attach\(\)/, 'boot 里要挂上（不依赖浮窗打开）');

  const route = /function checkRoute\(\)[\s\S]*?\n\}/.exec(CLIENT_SOURCE);
  assert.ok(route, '找不到 checkRoute');
  assert.match(route[0], /tagPolicyMenu\.syncOwn\(state\.own\)/);
  assert.match(route[0], /tagPolicyMenu\.syncOwn\(false\)/, '离开插件页要收起菜单');
});

test('TAG-11: `+ N` 折叠标签被识别并绑定，右键列出该行全部目标', async () => {
  const client = setup({
    policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 0, perWeek: 0 }],
    subscriptions: { rows: [{ source: '111111', targets: ['甲群', '乙群', '丙群'] }] },
  });
  const [row] = buildCollapsedTable(client.document, [{ source: '111111', visible: '甲群', collapsed: 2 }]);
  client.menu.attach();
  await client.menu.refresh();

  assert.equal(row.plusTag.getAttribute('data-ptx-policy-plus'), '1', '折叠标签要打上已绑标记');
  assert.equal(row.plusTag.getAttribute('data-ptx-policy-count'), '1 条策略', '折叠标签提示本行已有几条策略');
  assert.equal(row.tag.getAttribute('data-ptx-policy-tag'), '1', '可见标签照常绑定');
  assert.equal(row.tag.getAttribute('data-ptx-policy-count'), null, '条数徽标只挂在折叠标签上');

  /* refresh 会预取一次订阅表填兜底缓存，右键再读一次列目标。 */
  const readsBeforePick = client.calls.targetReads;
  row.plusTag.dispatchEvent(makeEvent('contextmenu', { clientX: 512, clientY: 240 }));
  const picker = client.document.querySelector('.ptx-policy-picker');
  assert.ok(picker, '右键折叠标签要弹「选择投递目标」');
  assert.equal(picker.style.left, '512px');
  assert.equal(picker.querySelector('.ptx-policy-who').textContent, '111111');
  assert.equal(picker.querySelector('.ptx-policy-eyebrow').textContent, '选择目标');

  await flush();
  const targets = picker.querySelectorAll('.ptx-policy-target').map((node) => node.textContent);
  assert.deepEqual(targets, ['甲群', '乙群', '丙群'], '项数 = 该行 targets 数');
  assert.equal(picker.querySelectorAll('.ptx-policy-target.is-set').length, 1, '已配策略的目标要有标记');
  assert.equal(client.calls.targetReads, readsBeforePick + 1, '一次右键只读一次订阅表');
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 1);

  /* 重复扫描不得重复绑定 / 重复请求。 */
  client.menu.scan();
  assert.equal(client.document.querySelectorAll('.ptx-policy-picker').length, 1, '扫描不得收掉正在用的菜单');

  client.menu.destroy();
  assert.equal(row.plusTag.getAttribute('data-ptx-policy-plus'), null, 'destroy 要摘掉绑定标记');
  assert.equal(row.plusTag.getAttribute('data-ptx-policy-count'), null, 'destroy 要摘掉条数徽标');
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0, 'destroy 要收起菜单');
  row.plusTag.dispatchEvent(makeEvent('contextmenu', { clientX: 100, clientY: 100 }));
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0, 'destroy 后不再接管右键');
});

test('TAG-12: 点列表项 → 策略菜单，标题是所选目标，POST body 的 target 是所选值', async () => {
  const client = setup({
    subscriptions: { rows: [{ source: '111111', targets: ['甲群', '乙群'] }] },
  });
  const [row] = buildCollapsedTable(client.document, [{ source: '111111', visible: '甲群', collapsed: 1 }]);
  client.menu.attach();
  await client.menu.refresh();

  row.plusTag.dispatchEvent(makeEvent('contextmenu', { clientX: 300, clientY: 220 }));
  await flush();
  const picker = client.document.querySelector('.ptx-policy-picker');
  const items = picker.querySelectorAll('.ptx-policy-target');
  assert.equal(items.length, 2);
  items[1].dispatchEvent(makeEvent('click'));

  assert.equal(client.document.querySelectorAll('.ptx-policy-picker').length, 0, '选择菜单要收起');
  const menu = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menu, '选中目标后要打开策略菜单');
  assert.match(menu.querySelector('.ptx-policy-who').textContent, /111111 → 乙群/, '标题里的目标名是所选值');
  assert.equal(menu.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value, '', '无策略的目标回显为空');

  menu.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value = '0 9 * * *';
  menu.querySelector('.ptx-policy-sec-weekly').querySelector('.ptx-policy-cron').value = '0 9 * * 1';
  menu.querySelector('.ptx-policy-perweek').value = '2';
  menu.querySelector('.ptx-policy-save').dispatchEvent(makeEvent('click'));
  await flush();

  assert.deepEqual(client.calls.writes[0], {
    source: '111111',
    target: '乙群',
    entryCron: '0 9 * * *',
    weeklyCron: '0 9 * * 1',
    perDay: 0,
    perWeek: 2,
  });
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0, '保存成功后收起菜单');
  assert.equal(client.document.querySelectorAll('[data-ptx-policy]').length, 0, '没有可见标签可写后缀');
  assert.equal(row.plusTag.getAttribute('data-ptx-policy-count'), '1 条策略', '折叠徽标的条数跟着更新');
});

test('TAG-13: 订阅表读不到 / 该行没有目标 → 只提示草稿，不给可点项', async () => {
  const failing = setup({ readTargets: () => Promise.reject(new Error('network down')) });
  const [failRow] = buildCollapsedTable(failing.document, [
    { source: '111111', visible: '甲群', collapsed: 1 },
  ]);
  failing.menu.attach();
  await failing.menu.refresh();
  failRow.plusTag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  await flush();

  const failingPicker = failing.document.querySelector('.ptx-policy-picker');
  assert.ok(failingPicker, '请求失败也要给反馈，不能静默');
  assert.equal(failingPicker.querySelectorAll('.ptx-policy-target').length, 0, '失败时没有可点目标');
  assert.match(failingPicker.querySelector('.ptx-policy-blocked').textContent, /目标是草稿，先保存订阅表/);
  assert.equal(failingPicker.getAttribute('aria-disabled'), 'true');

  const draft = setup({ subscriptions: { rows: [{ source: '111111', targets: [] }] } });
  const [draftRow] = buildCollapsedTable(draft.document, [
    { source: '111111', visible: '甲群', collapsed: 1 },
  ]);
  draft.menu.attach();
  await draft.menu.refresh();
  draftRow.plusTag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  await flush();

  const draftPicker = draft.document.querySelector('.ptx-policy-picker');
  assert.ok(draftPicker);
  assert.equal(draftPicker.querySelectorAll('.ptx-policy-target').length, 0, '草稿行没有目标可点');
  assert.match(draftPicker.querySelector('.ptx-policy-blocked').textContent, /目标是草稿，先保存订阅表/);
  assert.equal(draftPicker.getAttribute('aria-disabled'), 'true');

  draftPicker.querySelector('.ptx-policy-cancel').dispatchEvent(makeEvent('click'));
  assert.equal(draft.document.querySelectorAll('.ptx-policy-menu').length, 0, '取消能收起菜单');
});

test('TAG-14: tag 为 null 的保存路径不回写后缀、不抛错，但更新缓存', async () => {
  const client = setup({
    policies: [{ source: '222222', target: '乙群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 0, perWeek: 0 }],
  });
  const [row] = buildCollapsedTable(client.document, [{ source: '111111', visible: '甲群', collapsed: 1 }]);
  client.menu.attach();
  await client.menu.refresh();

  /* 直接走 openMenu 的 `+ N` 入口：没有可见标签，tag 传 null。 */
  client.menu.openMenu(null, { source: '111111', target: '乙群', key: '111111\u0000乙群' }, 300, 200);
  const menu = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menu, 'tag 为 null 也要能开菜单');
  assert.match(menu.querySelector('.ptx-policy-who').textContent, /111111 → 乙群/);
  assert.equal(menu.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value, '', '无策略回显为空');

  menu.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value = '0 7 * * *';
  menu.querySelector('.ptx-policy-sec-weekly').querySelector('.ptx-policy-cron').value = '0 7 * * 1';
  menu.querySelector('.ptx-policy-save').dispatchEvent(makeEvent('click'));
  await flush();

  assert.equal(client.calls.writes.length, 1, 'tag 为 null 也要能保存');
  assert.deepEqual(client.calls.writes[0], {
    source: '111111',
    target: '乙群',
    entryCron: '0 7 * * *',
    weeklyCron: '0 7 * * 1',
    perDay: 0,
    perWeek: 0,
  });
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0, '保存成功后收起菜单');
  assert.equal(client.document.querySelectorAll('[data-ptx-policy]').length, 0, '无标签可写：一个后缀都不许挂');
  assert.equal(row.tag.getAttribute('data-ptx-policy'), null, '可见标签的目标不是它，不能被污染');
  assert.equal(row.plusTag.getAttribute('data-ptx-policy-count'), '1 条策略', '折叠徽标吃到了新缓存');

  /* 再点开同一条策略，回显新值（缓存已更新）。 */
  client.menu.openMenu(null, { source: '111111', target: '乙群', key: '111111\u0000乙群' }, 300, 200);
  const reopened = client.document.querySelector('.ptx-policy-menu');
  assert.equal(reopened.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value, '0 7 * * *');
  assert.equal(reopened.querySelector('.ptx-policy-sec-weekly').querySelector('.ptx-policy-cron').value, '0 7 * * 1');
});

test('TAG-15: 两块的预设 chip 各填各的 cron，「立即投」只清本块，都不发请求', async () => {
  const client = setup({
    policies: [{ source: '111111', target: '甲群', entryCron: '', weeklyCron: '', perDay: 0, perWeek: 0 }],
  });
  const [row] = buildSubscriptionTable(client.document, [{ source: '111111', target: '甲群' }]);
  client.menu.attach();
  await client.menu.refresh();

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  const menu = client.document.querySelector('.ptx-policy-menu');
  const entrySec = menu.querySelector('.ptx-policy-sec-entry');
  const weeklySec = menu.querySelector('.ptx-policy-sec-weekly');
  const entryCron = entrySec.querySelector('.ptx-policy-cron');
  const weeklyCron = weeklySec.querySelector('.ptx-policy-cron');
  const entryChips = entrySec.querySelectorAll('.ptx-policy-chip');
  const weeklyChips = weeklySec.querySelectorAll('.ptx-policy-chip');
  assert.equal(entryChips.length, 2, '日词条两个预设');
  assert.equal(weeklyChips.length, 2, '周主题两个预设');

  const presets = [
    [entryChips, entryCron, [['每天 22:00', '0 22 * * *'], ['每天 09:00', '0 9 * * *']]],
    [weeklyChips, weeklyCron, [['每周一 09:00', '0 9 * * 1'], ['每周五 20:00', '0 20 * * 5']]],
  ];
  for (const [chips, input, list] of presets) {
    for (let i = 0; i < list.length; i += 1) {
      assert.equal(chips[i].textContent, list[i][0]);
      assert.equal(chips[i].getAttribute('data-ptx-cron'), list[i][1]);
      /* 另一块先填个哨兵值：点本块 chip 绝不能抹掉它。 */
      const other = input === entryCron ? weeklyCron : entryCron;
      other.value = '0 1 * * *';
      input.value = '0 3 * * *';
      chips[i].dispatchEvent(makeEvent('click'));
      assert.equal(input.value, list[i][1], `点「${list[i][0]}」要填入本块的 cron`);
      assert.equal(other.value, '0 1 * * *', `点「${list[i][0]}」不得改另一块`);
    }
  }

  /* 「立即投」只清本块，另一块原样；同样不落盘。 */
  entryCron.value = '0 22 * * *';
  weeklyCron.value = '0 9 * * 1';
  entrySec.querySelector('.ptx-policy-clear').dispatchEvent(makeEvent('click'));
  assert.equal(entryCron.value, '', '词条的「立即投」清掉 entryCron');
  assert.equal(weeklyCron.value, '0 9 * * 1', '清词条不得清掉周主题');
  weeklySec.querySelector('.ptx-policy-clear').dispatchEvent(makeEvent('click'));
  assert.equal(weeklyCron.value, '', '周主题的「立即投」清掉 weeklyCron');
  assert.equal(entryCron.value, '', '两块都已清空');

  assert.equal(client.calls.writes.length, 0, '填值 / 清空都不许直接 POST');
  assert.equal(client.calls.reads, 1, '预设也不触发额外的策略读取');
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 1, '填值后菜单仍然开着');
});

test('TAG-16: 数字控件在 0 与上限处钳制，0 显示「不限」，点开变 0', async () => {
  const client = setup({});
  const [row] = buildSubscriptionTable(client.document, [{ source: '111111', target: '甲群' }]);
  client.menu.attach();
  await client.menu.refresh();

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  const menu = client.document.querySelector('.ptx-policy-menu');
  const perDay = menu.querySelector('.ptx-policy-perday');
  const perWeek = menu.querySelector('.ptx-policy-perweek');
  const dayUp = menu.querySelector('.ptx-policy-perday-up');
  const dayDown = menu.querySelector('.ptx-policy-perday-down');
  const weekUp = menu.querySelector('.ptx-policy-perweek-up');
  const weekDown = menu.querySelector('.ptx-policy-perweek-down');

  assert.equal(perDay.value, '不限', '词条为 0 时显示「不限」');
  assert.equal(perDay.classList.contains('is-unlimited'), true, '「不限」是弱色态');
  assert.equal(dayDown.disabled, true, '0 时减号禁用');
  dayDown.dispatchEvent(makeEvent('click'));
  assert.equal(perDay.value, '不限', '0 不会再往下减');

  perDay.dispatchEvent(makeEvent('click'));
  assert.equal(perDay.value, '0', '点进输入框切回可编辑的 0');
  assert.equal(perDay.classList.contains('is-unlimited'), false);

  dayUp.dispatchEvent(makeEvent('click'));
  assert.equal(perDay.value, '1', '+ 从 0 加到 1');

  perDay.value = '999';
  dayUp.dispatchEvent(makeEvent('click'));
  assert.equal(perDay.value, '999', '词条上限 999（与服务端 MAX_PERIOD_QUOTA 同一口径）');
  assert.equal(dayUp.disabled, true, '到上限后加号禁用');
  perDay.value = '5000';
  perDay.dispatchEvent(makeEvent('click'));
  dayUp.dispatchEvent(makeEvent('click'));
  assert.equal(perDay.value, '999', '手输超限也钳到 999');

  /* 旧界面能提交的 1000 现在读出来也是 999：服务端上限 999，保存不该带出 400。 */
  perDay.value = '1000';

  assert.equal(perWeek.value, '不限', '周报为 0 时也显示「不限」');
  perWeek.dispatchEvent(makeEvent('focus'));
  assert.equal(perWeek.value, '0', '聚焦同样切回 0');
  perWeek.value = '100';
  weekUp.dispatchEvent(makeEvent('click'));
  assert.equal(perWeek.value, '100', '周报上限 100');
  assert.equal(weekUp.disabled, true);
  weekDown.dispatchEvent(makeEvent('click'));
  assert.equal(perWeek.value, '99', '− 回落到 99');

  /* 保存读的是控件真值（不是「不限」这段展示文案）。 */
  menu.querySelector('.ptx-policy-save').dispatchEvent(makeEvent('click'));
  await flush();
  assert.deepEqual(client.calls.writes[0], {
    source: '111111',
    target: '甲群',
    entryCron: '',
    weeklyCron: '',
    perDay: 999,
    perWeek: 99,
  });
});

/** 造一行「监听群渲染成输入框」的订阅表：来源群号只能从 `input.value` 里读。 */
function buildInputTable(doc, row) {
  const table = doc.createElement('table');
  const tbody = doc.createElement('tbody');
  table.appendChild(tbody);
  const tr = doc.createElement('tr');
  const sourceCell = doc.createElement('td');
  const input = doc.createElement('input');
  input.value = row.source;
  sourceCell.appendChild(input);
  const targetCell = doc.createElement('td');
  const tag = doc.createElement('span');
  tag.className = 'el-tag el-tag--info el-tag--default el-tag--light is-closable';
  const content = doc.createElement('span');
  content.className = 'el-tag__content';
  content.textContent = row.target;
  const close = doc.createElement('span');
  close.className = 'el-tag__close';
  tag.appendChild(content);
  tag.appendChild(close);
  targetCell.appendChild(tag);
  tr.appendChild(sourceCell);
  tr.appendChild(targetCell);
  tbody.appendChild(tr);
  doc.body.appendChild(table);
  return { tr, tag, content, close, input };
}

/* 行内读不到监听群（宿主把群号藏进组件状态）时的兜底：订阅表回执按目标名反查。
   `refresh()` 预取填缓存；右键时再读一次，仍读不到就弹提示而不是静默。 */
test('TAG-17: 行内 input.value 为空时，用订阅表回执按目标名反查监听群并开策略菜单', async () => {
  const client = setup({
    policies: [],
    subscriptions: { rows: [{ source: '111111', targets: ['甲群', '乙群'] }] },
  });
  const row = buildInputTable(client.document, { source: '', target: '甲群' });
  client.menu.attach();
  await client.menu.refresh();
  /* 预取不并进 refresh 的返回链（热路径不吃慢 I/O），回执在下一次 tick 落地。 */
  await flush();

  const info = client.menu.readTagInfo(row.tag);
  assert.ok(info, '行内读不到监听群时，唯一命中一行就要认出来源');
  assert.equal(info.source, '111111');
  assert.equal(info.key, '111111\u0000甲群');

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 140, clientY: 96 }));
  const menu = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menu, '右键要能开策略菜单');
  assert.equal(menu.querySelector('.ptx-policy-who').textContent, '111111 → 甲群');

  menu.querySelector('.ptx-policy-save').dispatchEvent(makeEvent('click'));
  await flush();
  assert.equal(client.calls.writes.length, 1);
  assert.equal(client.calls.writes[0].source, '111111', 'POST 的 source 必须来自反查结果');
  assert.equal(client.calls.writes[0].target, '甲群');
});

test('TAG-18: 同一目标出现在多行时提示无法确定所属监听群，不发 POST', async () => {
  const client = setup({
    policies: [],
    subscriptions: {
      rows: [
        { source: '111111', targets: ['甲群'] },
        { source: '222222', targets: ['甲群'] },
      ],
    },
  });
  const row = buildInputTable(client.document, { source: '', target: '甲群' });
  client.menu.attach();
  await client.menu.refresh();
  await flush();

  assert.equal(client.menu.readTagInfo(row.tag), null, '多行同名目标不得猜一个来源群');
  const event = makeEvent('contextmenu', { clientX: 300, clientY: 180 });
  row.tag.dispatchEvent(event);

  const menu = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menu, '认不出来源也要有反馈');
  assert.match(menu.textContent, /无法确定所属监听群/u);
  assert.equal(menu.querySelectorAll('.ptx-policy-save').length, 0, '不确定来源时没有保存入口');
  assert.equal(client.calls.writes.length, 0, '不得发 POST（改错群比不改更糟）');
  assert.equal(event.defaultPrevented, true);
});

test('TAG-19: 缓存为空且行内也读不到监听群时，右键弹提示而不是静默', async () => {
  const client = setup({ policies: [], subscriptions: { rows: [] } });
  const row = buildInputTable(client.document, { source: '', target: '甲群' });
  client.menu.attach();
  await client.menu.refresh();
  await flush();

  assert.equal(client.menu.readTagInfo(row.tag), null);
  const event = makeEvent('contextmenu', { clientX: 260, clientY: 150 });
  row.tag.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true, '已认领的本插件页上右键要被接管');
  const menu = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menu, '不能静默什么都不发生');
  assert.match(menu.textContent, /读不到所属监听群/u);
  assert.match(menu.textContent, /点开/u, '提示要告诉用户下一步怎么做');
  assert.equal(menu.querySelectorAll('.ptx-policy-save').length, 0);
  assert.equal(client.calls.writes.length, 0);

  /* 关闭入口真的收掉提示。 */
  menu.querySelector('.ptx-policy-cancel').dispatchEvent(makeEvent('click'));
  assert.equal(client.document.querySelectorAll('.ptx-policy-menu').length, 0);
});

test('TAG-20: 输入框里的短群号（1–5 位）也认得出，右键能开策略菜单', async () => {
  const client = setup({ policies: [] });
  const row = buildInputTable(client.document, { source: '12345', target: '@chat' });
  client.menu.attach();
  await client.menu.refresh();

  const info = client.menu.readTagInfo(row.tag);
  assert.ok(info, '短群号行不能被当成「没有来源」');
  assert.equal(info.source, '12345', '服务端订阅校验接受 1–5 位群号，解析器也必须接受');
  assert.equal(info.key, '12345\u0000@chat');

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 120, clientY: 90 }));
  const menu = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menu, '短群号行的标签右键要能开菜单');
  assert.equal(menu.querySelector('.ptx-policy-who').textContent, '12345 → @chat');

  menu.querySelector('.ptx-policy-save').dispatchEvent(makeEvent('click'));
  await flush();
  assert.equal(client.calls.writes.length, 1);
  assert.equal(client.calls.writes[0].source, '12345', 'POST 的 source 原样是短群号');
});

test('TAG-21: 认不出归属的页面右键不认领、不吞宿主菜单；认得出才认领', async () => {
  const foreign = setup({ own: false, identify: () => false, policies: [] });
  const [row] = buildSubscriptionTable(foreign.document, [{ source: '111111', target: '甲群' }]);
  foreign.menu.attach();
  const event = makeEvent('contextmenu', { clientX: 200, clientY: 160 });
  row.tag.dispatchEvent(event);

  assert.equal(foreign.calls.claims, 0, '别的插件页不得被认领成帕秋莉的页面');
  assert.equal(event.defaultPrevented, false, '不认领就不吞宿主右键菜单');
  assert.equal(foreign.document.querySelectorAll('.ptx-policy-menu').length, 0);
  assert.equal(foreign.calls.reads, 0, '认不出归属时一个请求都不发');

  /* 折叠标签（`+ N`）同一条门槛。 */
  const collapsed = setup({ own: false, identify: () => false, policies: [] });
  const [folded] = buildCollapsedTable(collapsed.document, [{ source: '111111', visible: '甲群', collapsed: 1 }]);
  collapsed.menu.attach();
  const plusEvent = makeEvent('contextmenu', { clientX: 200, clientY: 160 });
  folded.plusTag.dispatchEvent(plusEvent);
  assert.equal(collapsed.calls.claims, 0);
  assert.equal(plusEvent.defaultPrevented, false);
  assert.equal(collapsed.document.querySelectorAll('.ptx-policy-picker').length, 0);

  /* 认得出（路由名 / 页面身份元数据命中）：右键即认领并开菜单。 */
  const own = setup({ own: false, identify: () => true, policies: [] });
  const [known] = buildSubscriptionTable(own.document, [{ source: '111111', target: '甲群' }]);
  own.menu.attach();
  known.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  assert.equal(own.calls.claims, 1, '认得出本插件页：右键就是认领凭据');
  assert.ok(own.document.querySelector('.ptx-policy-menu'), '认领后菜单要开');
});

test('TAG-22: 保存成全缺省 = 删项，缓存 / 折叠徽标 / 目标列表的已设置同步消失', async () => {
  const client = setup({
    policies: [{ source: '111111', target: '甲群', entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 0 }],
    subscriptions: { rows: [{ source: '111111', targets: ['甲群', '乙群'] }] },
  });
  const [row] = buildCollapsedTable(client.document, [{ source: '111111', visible: '甲群', collapsed: 1 }]);
  client.menu.attach();
  await client.menu.refresh();
  assert.equal(row.plusTag.getAttribute('data-ptx-policy-count'), '1 条策略');
  assert.equal(row.tag.getAttribute('data-ptx-policy'), '0 22 * * *·3/0');

  row.tag.dispatchEvent(makeEvent('contextmenu', { clientX: 200, clientY: 160 }));
  const menu = client.document.querySelector('.ptx-policy-menu');
  menu.querySelector('.ptx-policy-sec-entry').querySelector('.ptx-policy-cron').value = '';
  menu.querySelector('.ptx-policy-perday').value = '0';
  menu.querySelector('.ptx-policy-save').dispatchEvent(makeEvent('click'));
  await flush();

  assert.equal(client.calls.writes.length, 1);
  assert.deepEqual(client.calls.writes[0], {
    source: '111111',
    target: '甲群',
    entryCron: '',
    weeklyCron: '',
    perDay: 0,
    perWeek: 0,
  });
  assert.equal(row.tag.getAttribute('data-ptx-policy'), null, '标签后缀要摘掉');
  assert.equal(row.plusTag.getAttribute('data-ptx-policy-count'), null, '折叠徽标不得再算这条已删除的策略');

  /* 目标列表的「已设置」也取自缓存：删掉的那条不能再显示为已配置。 */
  row.plusTag.dispatchEvent(makeEvent('contextmenu', { clientX: 512, clientY: 240 }));
  await flush();
  const buttons = client.document.querySelectorAll('.ptx-policy-target');
  assert.equal(buttons.length, 2, '列表项来自订阅表');
  assert.equal(
    buttons.filter((button) => button.classList.contains('is-set')).length,
    0,
    '已删除的策略不得再显示为已设置',
  );
});

test('TAG-23: 超过一页的目标分页展示，第 33 个起的每个目标都点得到', async () => {
  const targets = [];
  for (let index = 1; index <= 40; index += 1) targets.push('相册' + String(index));
  const client = setup({
    subscriptions: {
      rows: [
        { source: '111111', targets: targets.slice(0, 16) },
        { source: '111111', targets: targets.slice(16) },
      ],
    },
  });
  const [row] = buildCollapsedTable(client.document, [{ source: '111111', visible: '相册1', collapsed: 39 }]);
  client.menu.attach();
  await client.menu.refresh();

  row.plusTag.dispatchEvent(makeEvent('contextmenu', { clientX: 400, clientY: 240 }));
  await flush();
  const picker = client.document.querySelector('.ptx-policy-picker');
  assert.ok(picker, '右键折叠标签要弹「选择投递目标」');

  let buttons = picker.querySelectorAll('.ptx-policy-target');
  assert.equal(buttons.length, 33, '第一页 32 个目标 + 一个「继续显示」（单屏 DOM 有界）');
  const firstPage = buttons
    .filter((button) => button.getAttribute('data-ptx-more') !== '1')
    .map((button) => button.textContent);
  assert.deepEqual(firstPage, targets.slice(0, 32), '第一页按订阅表顺序铺满 32 个');

  const more = picker.querySelector('[data-ptx-more]');
  assert.ok(more, '还有目标没铺出来时必须有「继续显示」入口');
  assert.match(more.textContent, /8/u, '按钮写明还剩几个');
  more.dispatchEvent(makeEvent('click'));

  buttons = picker.querySelectorAll('.ptx-policy-target');
  assert.equal(buttons.length, 40, '翻页后 40 个目标全部可达');
  assert.equal(picker.querySelectorAll('[data-ptx-more]').length, 0, '最后一页不再有「继续显示」');

  /* 被折叠掉的那一个也要能配置：点最后一个目标 → 策略菜单标题是它。 */
  const last = buttons[buttons.length - 1];
  assert.equal(last.textContent, '相册40');
  last.dispatchEvent(makeEvent('click'));
  const menu = client.document.querySelector('.ptx-policy-menu');
  assert.ok(menu, '点最后一项要进策略菜单');
  assert.match(menu.querySelector('.ptx-policy-who').textContent, /111111 → 相册40/u);
});
