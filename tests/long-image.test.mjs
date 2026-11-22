import test from 'node:test';
import assert from 'node:assert/strict';

import { renderEntryLongImageHtml, renderEntryLongImagePng } from '../lib/plugin/card.js';
import { createMasker, maskPublicView } from '../lib/wiki/mask.js';

function makeView(overrides = {}) {
  return {
    id: '2026-11-10-long',
    title: '长图渲染与脱敏',
    date: '2026-11-10',
    status: 'verified',
    tags: ['管线', '脱敏'],
    summary: '一句话摘要。',
    background: '',
    consensus: ['共识一', '共识二'],
    divergence: ['分歧一'],
    quotes: [{ speaker: '张三', text: '原句。' }],
    sources: ['raw/sessions/2026-11-10-long.json'],
    ...overrides,
  };
}

function createFakePage({ height = 6400, shot = Buffer.from('png-bytes'), failFullPage = false } = {}) {
  const calls = { viewport: [], screenshot: [], closeCount: 0, html: '' };
  return {
    calls,
    handle: {
      setViewport: async (options) => {
        calls.viewport.push(options);
      },
      setContent: async (html) => {
        calls.html = html;
      },
      evaluate: async () => height,
      screenshot: async (options) => {
        calls.screenshot.push(options);
        if (options.fullPage && failFullPage) throw new Error('宿主不支持 fullPage');
        return shot;
      },
      close: async () => {
        calls.closeCount += 1;
      },
    },
  };
}

test('LONGIMAGE-01: 长图 HTML 自包含，含标题、矩阵与词条 id，零脚本零外链', () => {
  const view = makeView({
    debate: [
      {
        viewpoint: '是否收录',
        proponents: ['李四'],
        opponents: ['王五'],
        arguments: ['论据一'],
        counterArguments: ['反驳一'],
      },
    ],
  });
  const html = renderEntryLongImageHtml(view);

  assert.ok(html.includes('<title>长图渲染与脱敏</title>'));
  assert.ok(html.includes('<h1>长图渲染与脱敏</h1>'));
  assert.ok(html.includes('2026-11-10-long'));
  assert.ok(html.includes('>#2026-11-10-long<'), '无序号时页眉退回词条 id');
  assert.ok(
    renderEntryLongImageHtml(view, { index: 7 }).includes('>#7<'),
    '有独立序号时页眉显示自然数',
  );
  assert.ok(html.toLowerCase().includes('patchouli knowledge'), '页眉右侧保留品牌名');
  assert.ok(!html.includes('<footer'), '无一言时不渲染页脚');
  const said = renderEntryLongImageHtml(view, { saying: '知识由群聊沉淀' });
  assert.ok(said.includes('class="said"') && said.includes('知识由群聊沉淀'), '有一言时以一言收尾');
  assert.ok(!said.includes('class="id"'), '页脚不再重复词条 id');
  assert.equal((html.match(/<script/gu) ?? []).length, 0, '长图不得包含脚本');
  assert.equal((html.match(/https?:(?!\/\/www\.w3\.org\/2000\/svg)/gu) ?? []).length, 0, '长图不得引用外链（仅允许内联 SVG 命名空间）');
  assert.ok(!/@import|<link|src=/u.test(html), '不得引入外部字体 / 样式 / 图片');
  assert.ok(html.includes('width:720px'));
  // 五要素（立场 / 支持 / 质疑 / 论据 / 反驳）在窄宽下改为「争点块」而非五列表格。
  assert.ok(html.includes('class="view"'), '争点必须以独立区块呈现');
  assert.ok(html.includes('是否收录'), '争点立场必须出现');
  // 支持/质疑现在是纯图标胶囊（▲/▼），用 class 断言而非文字断言
  assert.ok(html.includes('side-label pro'), '支持侧必须有立场徽标');
  assert.ok(html.includes('side-label con'), '质疑侧必须有立场徽标');
  assert.ok(html.includes('arg-group counter'), '反驳论据必须以 counter 分组呈现（绿/红边线语义挂钩）');
  for (const label of ['论据', '反驳']) {
    assert.ok(html.includes(`>${label}<`), `争点要素缺 ${label}`);
  }
  assert.ok(html.includes('已确证'), '状态徽章走既有映射');
  assert.ok(html.includes('class="nm"'), '人名必须由 chip 组件包裹');
  assert.ok(html.includes('--nm-bg:hsl('), 'chip 必须带同名同色的色相变量');
});

test('LONGIMAGE-02: 真实昵称与号码不出现在长图，同一人多处别名一致', () => {
  const view = makeView({
    summary: '@张三 提出 QQ 123456789 的疑问。',
    quotes: [{ speaker: '张三', text: '我认为 987654321 这个群号才是关键。' }],
    debate: [
      {
        viewpoint: '是否该收录',
        proponents: ['张三'],
        opponents: ['李四'],
        arguments: ['论据一'],
        counterArguments: ['反驳一'],
      },
    ],
  });
  const html = renderEntryLongImageHtml(view);

  for (const secret of ['张三', '李四', '123456789', '987654321']) {
    assert.ok(!html.includes(secret), `${secret} 不得出现在长图里`);
  }
  const alias = createMasker().maskName('张三');
  assert.ok(html.includes(alias));
  assert.ok(html.includes(`>${alias}</span>`), '别名必须由 chip 包裹（正文提及与署名同步替换）');
  assert.ok(html.split(alias).length - 1 >= 3, '同一人在摘要、署名与争点支持列使用同一别名');
});

test('LONGIMAGE-03: 无 puppeteer 时返回 null 且不抛', async () => {
  await assert.doesNotReject(async () => {
    assert.equal(await renderEntryLongImagePng({}, makeView()), null);
  });
  assert.equal(await renderEntryLongImagePng(undefined, makeView()), null);
  assert.equal(await renderEntryLongImagePng({ puppeteer: {} }, makeView()), null);
  assert.equal(await renderEntryLongImagePng({ puppeteer: { page: async () => ({}) } }, makeView()), null);
});

test('LONGIMAGE-04: masked:false 时原始昵称可见', () => {
  const view = makeView({
    summary: '@张三 提出 QQ 123456789 的疑问。',
    quotes: [{ speaker: '张三', text: '原句。' }],
  });
  const html = renderEntryLongImageHtml(view, { masked: false });

  assert.ok(/@<span class="nm"[^>]*>张三<\/span>/u.test(html), '正文提及保持原文（@ + chip）');
  assert.ok(html.includes('123456789'));
  assert.ok(/<figcaption><span class="nm"[^>]*>张三<\/span><\/figcaption>/u.test(html), '署名仍由 chip 包裹');
});

test('LONGIMAGE-05: 优先 fullPage 截长图并关闭页面；超 maxHeight 或宿主不支持时走视口 + clip', async () => {
  const full = createFakePage({ height: 6400 });
  const png = await renderEntryLongImagePng({ puppeteer: { page: async () => full.handle } }, makeView());
  assert.equal(png?.toString(), 'png-bytes');
  assert.deepEqual(full.calls.viewport[0], { width: 720, height: 900, deviceScaleFactor: 2 });
  assert.equal(full.calls.screenshot.length, 1);
  assert.equal(full.calls.screenshot[0].fullPage, true);
  assert.ok(full.calls.html.includes('长图渲染与脱敏'));
  assert.equal(full.calls.closeCount, 1);
  // 页尾一言必须穿过 captureLongImage 传到模板（曾经在这里被吞掉）。
  const withSaying = createFakePage({ height: 6400 });
  await renderEntryLongImagePng({ puppeteer: { page: async () => withSaying.handle } }, makeView(), {
    saying: '什么都无法舍弃的人，什么都无法改变。',
  });
  assert.ok(withSaying.calls.html.includes('class="said"'), 'saying 必须转发到模板');

  const tall = createFakePage({ height: 30_000 });
  await renderEntryLongImagePng({ puppeteer: { page: async () => tall.handle } }, makeView());
  assert.equal(tall.calls.screenshot.length, 1);
  assert.equal(tall.calls.screenshot[0].fullPage, undefined);
  assert.deepEqual(tall.calls.screenshot[0].clip, { x: 0, y: 0, width: 720, height: 20_000 });
  assert.equal(tall.calls.closeCount, 1);

  const fallback = createFakePage({ height: 800, failFullPage: true });
  await renderEntryLongImagePng({ puppeteer: { page: async () => fallback.handle } }, makeView());
  assert.equal(fallback.calls.screenshot.length, 2);
  assert.deepEqual(fallback.calls.screenshot[1].clip, { x: 0, y: 0, width: 720, height: 800 });
  assert.deepEqual(fallback.calls.viewport[1], { width: 720, height: 800, deviceScaleFactor: 2 });
  assert.equal(fallback.calls.closeCount, 1);
});

test('LONGIMAGE-07: 看板娘底图内联为 SVG 位图，可整层关闭且不引入外链/脚本', () => {
  const html = renderEntryLongImageHtml(makeView());

  assert.equal((html.match(/class="mascot mascot-bust"/gu) ?? []).length, 1, '标题区必须有半身像一层');
  assert.equal((html.match(/class="mascot mascot-reading"/gu) ?? []).length, 1, '页尾必须有读书图一层');
  assert.equal((html.match(/data:image\/webp;base64,/gu) ?? []).length, 2, '两张位图各内联一次（<use> 复用同一份）');
  assert.equal((html.match(/<use href="#art-/gu) ?? []).length, 4, '每张图两层：模糊光晕 + 锐利本体');
  assert.equal((html.match(/<feGaussianBlur/gu) ?? []).length, 2, '光晕层靠高斯模糊做边缘虚化');
  assert.equal(html.includes('<script'), false, '长图永不带脚本');
  assert.equal(/https?:\/\//u.test(html), false, '长图永不带外链（数据 URI 不算）');
  // SVG 只做容器，不是描摹路径：mascot 图层内不得出现 path（立场徽标图标用 <path> 是合法的）。
  const mascotStart = html.indexOf('class="mascots"');
  const mascotEnd = html.indexOf('</div>', mascotStart);
  assert.equal(/<path[\s>]/u.test(html.slice(mascotStart, mascotEnd)), false, '看板娘不得用路径描摹替代位图');

  const off = renderEntryLongImageHtml(makeView(), { mascot: false });
  assert.equal(off.includes('<svg class="mascot'), false, 'mascot:false 必须整层关闭（CSS 规则仍在，但不再有图层）');
  assert.equal(off.includes('data:image/webp'), false, '关闭后不得内联任何位图');
});

test('LONGIMAGE-08: 只出现在正文的假名也包成 chip（knownNames 透传）', () => {
  // 视图契约不携带参与者：`矢田寺成美` 这类只被综述提到的假名，
  // 只能靠调用方把名单喂进 `knownNames` 才有特殊渲染。
  const view = makeView({ narrative: 'VMNXD 直言该阵营在高压下无法取胜，最爱强权之人 随即补充。', quotes: [] });
  const masker = createMasker('chip-seed');
  const masked = maskPublicView(view, masker, ['VMNXD', '最爱强权之人']);
  const knownNames = ['VMNXD', '最爱强权之人'].map((name) => masker.maskName(name));

  const withNames = renderEntryLongImageHtml(masked, { masked: false, knownNames });
  const without = renderEntryLongImageHtml(masked, { masked: false });

  const chipCount = (html) => (html.match(/class="nm"/gu) ?? []).length;
  assert.equal(chipCount(without), 0, '不喂名单时正文里的假名只是纯文本');
  assert.ok(chipCount(withNames) >= 2, `喂了名单后综述里的假名要包成 chip：${chipCount(withNames)}`);
  assert.ok(withNames.includes(knownNames[0]), '第一个假名必须出现在 chip 里');
  assert.ok(withNames.includes(knownNames[1]), '第二个假名必须出现在 chip 里');
});

test('LONGIMAGE-09: 人名双链渲染成 chip，概念双链保留原文', () => {
  const view = makeView({ narrative: '关于 [[数值膨胀]]，[[红美铃]] 认为低本过渡断裂。', quotes: [] });
  const html = renderEntryLongImageHtml(view, { knownNames: ['红美铃'], mascot: false });

  assert.equal(html.includes('[[红美铃]]'), false, '人名的双链括号必须被剥掉');
  assert.ok(html.includes('>红美铃</span>'), '剥掉括号后必须包成 chip');
  assert.ok(html.includes('[[数值膨胀]]'), '概念双链不是人名，必须原样保留');
});

test('LONGIMAGE-10: chipify 只在文本片段上替换——不吃自己的 chip 标记，也不进概念双链', () => {
  // 现场一：名单里的 `nm` 会命中 `class="nm"` 与 `--nm-bg`，chip 套 chip。
  const view = makeView({ narrative: 'Vader 说了话。', participants: ['Vader', 'nm'], quotes: [] });
  const html = renderEntryLongImageHtml(view, { masked: false, mascot: false });

  assert.equal(/class="[^"]*<span/u.test(html), false, '属性值里不得被塞进 chip');
  assert.equal((html.match(/class="nm"/gu) ?? []).length, 1, '`nm` 只能当人名用，不得命中 class="nm"');
  assert.equal((html.match(/--nm-bg:hsl\(/gu) ?? []).length, 1, '--nm-bg 同理（CSS 里的 var(--nm-bg) 不计）');
  assert.ok(html.includes('>Vader</span>'), '正文里的人名仍必须 chip 化');

  // 现场二：保留名 `膨胀` 钻进概念双链，把 `[[数值膨胀]]` 换成 `[[数值<nm>]]`。
  const concept = renderEntryLongImageHtml(
    makeView({ narrative: '关于 [[数值膨胀]] 的讨论。', quotes: [] }),
    { masked: false, knownNames: ['膨胀'], mascot: false },
  );
  assert.ok(concept.includes('[[数值膨胀]]'), '概念双链必须原样保留');
  assert.equal((concept.match(/class="nm"/gu) ?? []).length, 0, '保留名不得改写概念链内部');
});
