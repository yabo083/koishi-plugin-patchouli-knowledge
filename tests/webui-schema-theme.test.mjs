import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 配置卡标签主题的注入契约。
 *
 * 宿主深色主题没覆盖 Element Plus 的 .el-tag，插件配置页多选标签（订阅表「投递群」列）
 * 夜间是白底黑字；客户端产物用一段作用域限定的 CSS 补上。这里按既有 WEBUI 契约测试
 * 的路径（把产物当函数体载入、给最小 DOM 桩）直接跑两遍注入函数：
 * 只允许一个 <style>、标记属性正确、颜色走宿主变量，且选择器不得裸写 .el-tag 污染别处。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');
const MARK = 'schema-tag-theme';

const noop = () => {};

function createStyleNode(tagName) {
  return {
    tagName: String(tagName).toUpperCase(),
    attributes: new Map(),
    textContent: '',
    style: {},
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    appendChild() {},
    addEventListener: noop,
  };
}

function createDomStub() {
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node);
      node.parentNode = this;
      return node;
    },
    removeChild(node) {
      const at = this.children.indexOf(node);
      if (at >= 0) this.children.splice(at, 1);
      return node;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const match = /^style\[data-patchouli="([^"]+)"\]$/.exec(String(selector).trim());
      if (!match) return [];
      return this.children.filter(
        (node) => node.tagName === 'STYLE' && node.getAttribute('data-patchouli') === match[1],
      );
    },
  };
  const document = {
    readyState: 'complete',
    hidden: false,
    head,
    body: null,
    documentElement: null,
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
    querySelector: (selector) => head.querySelector(selector),
    querySelectorAll: () => [],
    createElement: (tagName) => createStyleNode(tagName),
  };
  const window = {
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    location: { pathname: '/', hash: '' },
    fetch: () => Promise.reject(new Error('probe: no network')),
  };
  return { window, document, head };
}

function loadClient() {
  const body = CLIENT_SOURCE.replace(
    'export default function applyPatchouliWikiReader',
    'function applyPatchouliWikiReader',
  );
  const dom = createDomStub();
  const factory = new Function(
    'window', 'document', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    `${body}
return { ensureSchemaTagTheme, SCHEMA_TAG_STYLES };`,
  );
  const api = factory(
    dom.window, dom.document, (...args) => dom.window.fetch(...args),
    () => 0, noop, () => 0, noop,
  );
  return { ...api, head: dom.head };
}

/* 从样式表文本里抽出全部选择器（按 , 与 } 切分），用于断言作用域。 */
function selectorsOf(css) {
  return css
    .split('}')
    .map((chunk) => chunk.split('{')[0])
    .filter((selector) => selector.trim() !== '')
    .flatMap((selector) => selector.split(','))
    .map((selector) => selector.trim())
    .filter(Boolean);
}

test('WEBUI-SCHEMA-01: 标签主题注入幂等，且只落一个 style', () => {
  const client = loadClient();

  client.ensureSchemaTagTheme();
  client.ensureSchemaTagTheme();

  const injected = client.head.children.filter((node) => node.getAttribute('data-patchouli') === MARK);
  assert.equal(injected.length, 1, '重复调用只应产生一个标记样式表');
  assert.equal(client.head.children.length, 1, '不得追加第二个 <style>');
  assert.equal(injected[0].tagName, 'STYLE');
});

test('WEBUI-SCHEMA-02: 样式内容命中真实作用域，且材质取自宿主变量', () => {
  const client = loadClient();
  client.ensureSchemaTagTheme();
  const css = client.head.children[0].textContent;

  assert.ok(css.includes('.k-schema-item .el-select .el-tag'), '必须覆盖多选标签本体（真实根类是 .k-schema-item）');
  assert.ok(css.includes('.k-schema-item .el-select .el-tag .el-tag__close'), '必须覆盖关闭按钮');
  assert.match(css, /background:\s*var\(--bg1,\s*transparent\)/, '底色必须走宿主 1 级填充 --bg1，缺失时回退透明');
  assert.match(css, /border-color:\s*var\(--k-color-border/, '描边必须与输入框同源');
  assert.match(css, /color:\s*var\(--k-text-dark/, '正文色必须走宿主文字变量');
  assert.match(css, /border-radius:\s*var\(--el-border-radius-base/, '圆角必须与输入框一致');
  assert.doesNotMatch(css, /rgba\(255,\s*255,\s*255/, '不得用半透明白当标签底色');
});

test('WEBUI-SCHEMA-03: 选择器全部限定在 .k-schema-item 内，不得裸写 el-tag', () => {
  const client = loadClient();
  client.ensureSchemaTagTheme();
  const css = client.head.children[0].textContent;

  const selectors = selectorsOf(css);
  assert.ok(selectors.length >= 3, '至少三条规则');
  for (const selector of selectors) {
    assert.match(selector, /^\.k-schema-item\b/, `选择器缺少真实作用域 .k-schema-item: ${selector}`);
    assert.ok(!/^\.?el-tag\b/.test(selector), `不得以裸 el-tag 选择器开头: ${selector}`);
  }
});

test('WEBUI-SCHEMA-04: 注入挂在入口初始化路径上，不依赖浮窗挂载', () => {
  /* 浮窗打开才注入 -> 配置页（浮窗未开）依旧是白底黑字，所以调用点必须在 boot 里。 */
  const boot = /const boot = \(\) => \{([\s\S]*?)\n  \};/.exec(CLIENT_SOURCE);
  assert.ok(boot, '找不到 console 入口的 boot 段');
  assert.match(boot[1], /ensureSchemaTagTheme\(\);/);

  const mount = /function mount\(\) \{([\s\S]*?)\n  rootEl = buildShell\(\);/.exec(CLIENT_SOURCE);
  assert.ok(mount, '找不到 mount 段');
  assert.doesNotMatch(mount[1], /ensureSchemaTagTheme/, '不得把注入塞进浮窗挂载');
});
