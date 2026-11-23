import test from 'node:test';
import assert from 'node:assert/strict';

import { FANTASY_NAME_POOL, createMasker, maskPublicView } from '../lib/wiki/mask.js';
import { collectSessionNames } from '../lib/plugin/card-pipeline.js';

function makeView(overrides = {}) {
  return {
    id: '2026-11-10-mask',
    title: '脱敏主题',
    date: '2026-11-10',
    status: 'verified',
    tags: ['分类学'],
    summary: '摘要正文。',
    background: '',
    consensus: ['共识一'],
    divergence: ['分歧一'],
    quotes: [{ speaker: '张三', text: '原话。' }],
    sources: ['raw/sessions/2026-11-10-mask.json'],
    ...overrides,
  };
}

test('MASK-01: 同一 masker 内真实名多次映射恒定', () => {
  const masker = createMasker('stable-seed');
  const first = masker.maskName('张三');
  assert.ok(FANTASY_NAME_POOL.includes(first), '假名应来自内置角色池');
  assert.notEqual(first, '张三');
  for (let round = 0; round < 5; round += 1) assert.equal(masker.maskName('张三'), first);

  const twin = createMasker('stable-seed');
  assert.equal(twin.maskName('张三'), first, '同 seed 可复现同一映射');
  assert.equal(twin.maskName('李四'), masker.maskName('李四'));
  assert.notEqual(masker.maskName('李四'), first, '不同真实名不共用假名');
});

test('MASK-02: 不同 seed 洗牌不同，假名均来自角色池且互不重复', () => {
  const names = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十'];
  const alphaMasker = createMasker('alpha');
  const betaMasker = createMasker('beta');
  const alpha = names.map((name) => alphaMasker.maskName(name));
  const beta = names.map((name) => betaMasker.maskName(name));

  for (const alias of [...alpha, ...beta]) assert.ok(FANTASY_NAME_POOL.includes(alias), `${alias} 应来自角色池`);
  assert.equal(new Set(alpha).size, names.length, '同一 masker 内假名互不重复');
  assert.equal(new Set(beta).size, names.length, '同一 masker 内假名互不重复');
  assert.notDeepEqual(alpha, beta, '不同 seed 应洗出不同假名');
  assert.ok(FANTASY_NAME_POOL.length >= 40, '角色池至少 40 个');
  assert.equal(new Set(FANTASY_NAME_POOL).size, FANTASY_NAME_POOL.length, '角色池自身无重复');
});

test('MASK-03: 视图脱敏 participants / speaker / 支持者 / 质疑者且指代一致', () => {
  const view = makeView({
    participants: ['张三', '李四', '王五'],
    quotes: [{ speaker: '张三', text: '原文。' }],
    debate: [
      {
        viewpoint: '是否收敛',
        proponents: ['李四'],
        opponents: ['张三'],
        arguments: ['论据一'],
        counterArguments: ['反驳一'],
      },
    ],
    debateMatrix: [
      {
        viewpoint: '矩阵立场',
        proponents: ['王五'],
        opponents: ['李四'],
        arguments: ['矩阵论据'],
        counterArguments: ['矩阵反驳'],
      },
    ],
  });
  const masked = maskPublicView(view, createMasker('view-seed'));

  const aliasOf = new Map();
  for (const [index, real] of ['张三', '李四', '王五'].entries()) {
    const alias = masked.participants[index];
    assert.ok(FANTASY_NAME_POOL.includes(alias), `${alias} 应来自角色池`);
    aliasOf.set(real, alias);
  }

  assert.equal(masked.quotes[0].speaker, aliasOf.get('张三'));
  assert.equal(masked.debate[0].opponents[0], aliasOf.get('张三'));
  assert.equal(masked.debate[0].proponents[0], aliasOf.get('李四'));
  assert.equal(masked.debateMatrix[0].proponents[0], aliasOf.get('王五'));
  assert.equal(masked.debateMatrix[0].opponents[0], aliasOf.get('李四'));
  const serialized = JSON.stringify(masked);
  for (const real of ['张三', '李四', '王五']) assert.ok(!serialized.includes(real), `${real} 不得残留在视图里`);
});

test('MASK-04: @昵称 与 5–12 位号码被替换，伪号不等于原号且同号同伪号', () => {
  const masker = createMasker('number-seed');
  const alias = masker.maskName('张三');
  const text = '@张三 你好，QQ 100000011，群 100000012，重帖 100000011。';
  const masked = masker.maskText(text);

  assert.ok(masked.includes(`@${alias}`), '提及替换成同一假名');
  assert.ok(!masked.includes('@张三'));
  assert.ok(!masked.includes('100000011'));
  assert.ok(!masked.includes('100000012'));

  const pseudos = masked.match(/\d{5,12}/gu) ?? [];
  assert.equal(pseudos.length, 3, '三处号码都应替换为伪号');
  assert.equal(pseudos[0], pseudos[2], '同一个真实号永远得到同一伪号');
  assert.notEqual(pseudos[0], pseudos[1], '不同真实号得到不同伪号');
  assert.ok(pseudos.every((pseudo) => pseudo !== '100000011' && pseudo !== '100000012'));

  assert.equal(masker.maskText(''), '');
  assert.equal(masker.maskText('2026-11-10'), '2026-11-10', '四位年份不是号码');
  assert.equal(masker.maskText('编号 1000000112345'), '编号 1000000112345', '超过 12 位的长串不是独立号码');
});

test('MASK-05: maskPublicView 不改入参（深比较不变）、短名与空串不崩', () => {
  const view = makeView({
    participants: ['张三'],
    summary: '@张三 说 QQ 100000011 才是关键。',
  });
  const snapshot = structuredClone(view);
  const masked = maskPublicView(view);

  assert.notEqual(masked, view);
  assert.deepEqual(view, snapshot, '入参必须原样保留');
  assert.ok(!JSON.stringify(masked).includes('张三'));
  assert.ok(!JSON.stringify(masked).includes('100000011'));

  const masker = createMasker();
  assert.equal(masker.maskName(''), '');
  assert.equal(masker.maskName('   '), '   ');
  assert.doesNotThrow(() => masker.maskName('甲'));
  assert.equal(masker.maskText(''), '');

  const lean = maskPublicView({ ...makeView(), quotes: [], consensus: [], divergence: [], tags: [] });
  assert.equal(lean.id, '2026-11-10-mask');
  assert.deepEqual(lean.tags, []);
});

test('MASK-06: 伪号先扫全视图登记真实号码，后处理字段的真实号码不会被写成伪号', () => {
  // bug 现场：只扫引文时 12345678 会拿到伪号 P；若标题里真实写着 P，P 就成了「漏网的真实号码」。
  const pseudo = createMasker().maskText('联系 12345678');
  const candidate = (pseudo.match(/\d{5,12}/gu) ?? [])[0];
  assert.ok(candidate !== undefined && candidate !== '12345678', '前置探针必须产出伪号');

  const view = makeView({
    title: `关于 ${candidate} 的讨论`,
    quotes: [{ speaker: '张三', text: '联系 12345678 即可' }],
  });
  const masked = maskPublicView(view);
  const text = `${masked.title} ${masked.quotes[0].text}`;

  assert.ok(!text.includes('12345678'), '真实号码 12345678 不得出现在脱敏视图里');
  assert.ok(!text.includes(candidate), `伪号不得撞上后处理字段里的真实号码 ${candidate}`);
  const numbers = text.match(/\d{5,12}/gu) ?? [];
  assert.equal(numbers.length, 2, '两个号码都应被替换且各自独立');
  assert.notEqual(numbers[0], numbers[1], '两个号码不得映射到同一伪号');

  // 映射稳定：同一视图重复脱敏得到同一结果。
  assert.deepEqual(maskPublicView(view), masked);
});

test('MASK-07: 仅出现在参与名单、正文裸写的名字由 extraNames 覆盖（VMNXD 回归）', () => {
  // 线上事故：VMNXD 只被综述正文提到、没进金句 / 观点矩阵，
  // 视图契约又不携带 participants——必须由调用方把 record.participants 喂进来。
  const view = makeView({
    narrative: '讨论始于群友对阵容表现的强烈不满。VMNXD 直言该阵营在高难下几乎无法取胜。',
    quotes: [],
  });
  const masked = maskPublicView(view, createMasker('leak-seed'), ['VMNXD', 'VMNXD 100000009', '7', 'fufuu']);

  assert.ok(!masked.narrative.includes('VMNXD'), '正文裸写的 VMNXD 必须被替换');
  // 复合昵称与其底名共享同一个假名（maskName 归一）。
  const masker = createMasker('leak-seed');
  assert.equal(masker.maskName('VMNXD 100000009'), masker.maskName('VMNXD'));
});

test('MASK-08: 短名按词边界命中——独立 `7` 换掉，`1527` 里的 7 不动', () => {
  const masker = createMasker('guard-seed');
  masker.reserveRealNames(['7', '千聆', 'VMNXD 100000009', '空庭流萤（B服天蓝色的海#9937）']);

  const masked = masker.maskText('7 与千聆进一步拆解，黑流n16才1527，编号 7 号');
  const seven = masker.maskName('7');
  assert.ok(masked.includes(`${seven} 与`), `独立的 7 必须换成假名：${masked}`);
  assert.ok(masked.includes('黑流n16才1527'), '数字 1527 里的 7 不得被替换');
  assert.ok(masked.includes(`编号 ${seven} 号`), '标点/空格分隔的 7 仍要替换');
  // 中文名紧贴汉字（`与千聆进一步`）必须整串命中。
  assert.ok(!masked.includes('千聆'), `中文名必须替换：${masked}`);
  // 复合昵称的裸写形态命中底名。
  assert.ok(!masker.maskText('VMNXD 直言难度过高').includes('VMNXD'), 'VMNXD 底名必须命中');
  // 括号附注剥掉后底名归一。
  assert.ok(!masker.maskText('空庭流萤 补充了数据').includes('空庭流萤'), '括号附注昵称的底名必须命中');
});

test('MASK-09: 原始会话的 userName 补齐 participants 漏掉的人', () => {
  const dump = JSON.stringify({
    version: 1,
    id: 'e1',
    messages: [
      { id: '1', userId: '1', userName: '7', content: 'a', timestamp: 0 },
      { id: '2', userId: '2', userName: ' VMNXD 100000009 ', content: 'b', timestamp: 0 },
      { id: '3', userId: '1', userName: '7', content: 'c', timestamp: 0 },
      { id: '4', userId: '3', content: 'd', timestamp: 0 },
    ],
  });
  assert.deepEqual(collectSessionNames(dump), ['7', 'VMNXD 100000009']);
  assert.deepEqual(collectSessionNames(undefined), []);
  assert.deepEqual(collectSessionNames('{ not json'), []);
  assert.deepEqual(collectSessionNames('{"messages":"nope"}'), []);

  // 只有 dump 里的名字（participants 完全没提）也必须被替换。
  const view = makeView({ narrative: '7 与 VMNXD 讨论了牌池。', quotes: [] });
  const masked = maskPublicView(view, createMasker('dump-seed'), collectSessionNames(dump));
  assert.ok(!masked.narrative.includes('VMNXD'), 'VMNXD 必须被替换');
  assert.ok(!/(^|[\s，。])7([\s，。]|$)/u.test(masked.narrative), `独立的 7 必须被替换：${masked.narrative}`);
});

test('MASK-10: 单字中文名按上下文判定——普通词里的同形字不动', () => {
  const masker = createMasker('single-char');
  masker.reserveRealNames(['夜', '千聆']);
  // 左「深」右「的」都不是提及线索 ⇒ 不动。
  assert.equal(masker.maskText('深夜的牌池讨论。'), '深夜的牌池讨论。', '普通词不得被改写');
  assert.equal(masker.maskText('夜晚的灯光很暗。'), '夜晚的灯光很暗。');
  assert.equal(masker.maskText('十六夜咲夜在说话。'), '十六夜咲夜在说话。', '长专名里的同形字不得被切开');
});

test('MASK-11: 单字中文名在提及语境里必须替换（结构化字段同样）', () => {
  const masker = createMasker('single-char');
  masker.reserveRealNames(['夜', '千聆', 'Vader']);
  const alias = masker.maskName('夜');

  assert.equal(masker.maskText('夜说这不合理。'), `${alias}说这不合理。`, '串首 + 说话动词 ⇒ 指名提及');
  assert.equal(masker.maskText('夜、千聆、Vader 三人'), `${alias}、${masker.maskName('千聆')}、${masker.maskName('Vader')} 三人`, '顿号并列 ⇒ 提名');
  assert.ok(masker.maskText('千聆与夜、Vader 都同意。').includes(alias), '连词 + 顿号并列 ⇒ 提名');

  // 结构化字段与长度无关：单字名在参与者 / 金句署名里一律替换。
  const view = makeView({
    narrative: '',
    participants: ['夜'],
    quotes: [{ speaker: '夜', text: '原句。' }],
  });
  const masked = maskPublicView(view, createMasker('single-char-struct'), ['夜']);
  assert.equal(masked.participants.length, 1, '参与者仍在');
  assert.notEqual(masked.participants[0], '夜', '参与者字段不得留真名');
  assert.notEqual(masked.quotes[0].speaker, '夜', '金句署名不得留真名');
});

test('MASK-12: 双链内人名精确替换（单字/复合皆可，概念链不动）', () => {
  const masker = createMasker('link-seed');
  masker.reserveRealNames(['夜', 'VMNXD', 'VMNXD 100000009']);
  const night = masker.maskName('夜');

  // 双链是结构信号：不需要上下文判定，单字名同样精确命中。
  assert.equal(masker.maskText('深夜的牌池，[[夜]] 补充了论点。'), `深夜的牌池，[[${night}]] 补充了论点。`);
  // 概念双链必须原样保留。
  assert.equal(masker.maskText('[[数值膨胀]] 是核心问题'), '[[数值膨胀]] 是核心问题');
  // 复合昵称与底名各自映射到同一假名族。
  assert.equal(
    masker.maskText('[[VMNXD]] 与 [[VMNXD 100000009]]'),
    `[[${masker.maskName('VMNXD')}]] 与 [[${masker.maskName('VMNXD 100000009')}]]`,
  );
});

test('MASK-13: 别名不参与二次替换——固定 seed 下每句话只出现各自的假名', () => {
  // 回归现场：seed-55 下 `张三 → 魂魄妖梦`、`妖梦 → 铃仙`。逐名 split/join 时，
  // 先写入的假名「魂魄妖梦」会被后处理的真名「妖梦」再切一刀，产出「魂魄铃仙」。
  const masker = createMasker('seed-55');
  masker.reserveRealNames(['张三', '妖梦']);
  const aliasA = masker.maskName('张三');
  const aliasB = masker.maskName('妖梦');
  assert.equal(aliasA, '魂魄妖梦', '该 seed 必须复现「假名里含另一个真名」的现场');
  assert.equal(aliasB, '铃仙');
  assert.notEqual(aliasA, aliasB, '两个真名不得共用假名');

  const masked = masker.maskText('张三 与 妖梦 都在。');
  assert.equal(masked, `${aliasA} 与 ${aliasB} 都在。`, '两个真名各换一次，顺序与原文一致');
  assert.ok(!masked.includes(`魂魄${aliasB}`), '假名内部不得再被切成混合体');
  // 独立复算：句中恰好两个假名，且互不相同。
  const pseudonyms = masked.match(/魂魄妖梦|铃仙/gu) ?? [];
  assert.deepEqual(pseudonyms, [aliasA, aliasB], '整句只应出现两个不同的假名');
});

test('MASK-14: 双链只做字典替换，链内文字不会被裸名规则打穿', () => {
  const masker = createMasker('seed-55');
  masker.reserveRealNames(['张三', '妖梦', '膨胀']);

  // 链内人名 + 链外裸名：同一个人在两处必须是同一个假名。
  const mixed = masker.maskText('张三 与 [[妖梦]] 都在。');
  assert.equal(mixed, `${masker.maskName('张三')} 与 [[${masker.maskName('妖梦')}]] 都在。`);
  const inner = mixed.slice(mixed.indexOf('[[') + 2, mixed.indexOf(']]'));
  assert.equal(inner, masker.maskName('妖梦'), '链内只允许一个假名');

  // 现场复原：`张三` 的假名恰是「魂魄妖梦」，链里的假名不得被真名「妖梦」二次改写。
  const once = masker.maskText('[[张三]]');
  assert.equal(once, `[[${masker.maskName('张三')}]]`);
  assert.ok(!once.includes(masker.maskName('妖梦')), '链内别名不得再被第二个真名切一次');

  // 未登记的概念链：括号与内容都原样保留，哪怕里面含保留名 `膨胀`。
  assert.equal(masker.maskText('关于 [[数值膨胀]] 的讨论'), '关于 [[数值膨胀]] 的讨论');
  // 链内直接写成「魂魄妖梦」（未登记）时，也不得被真名「妖梦」切成两个假名。
  assert.equal(masker.maskText('[[魂魄妖梦]]'), '[[魂魄妖梦]]');
});

test('MASK-15: 单字名线索左右镜像——句号/问号后与句尾点名都算提及', () => {
  const masker = createMasker('single-char');
  masker.reserveRealNames(['夜']);
  const alias = masker.maskName('夜');

  assert.equal(masker.maskText('他走了。夜说这不合理。'), `他走了。${alias}说这不合理。`, '句号后点名');
  assert.equal(masker.maskText('结果呢？夜补充了几句'), `结果呢？${alias}补充了几句`, '问号后点名');
  assert.equal(masker.maskText('他停了；夜道：好。'), `他停了；${alias}道：好。`, '分号后点名');
  assert.equal(masker.maskText('晚安，夜'), `晚安，${alias}`, '句尾点名（右线索 = EOS）');
  assert.equal(masker.maskText('晚安！夜'), `晚安！${alias}`, '感叹号后 + 句尾');
  assert.equal(masker.maskText('「夜」'), `「${alias}」`, '引号包裹');
  // 对称补齐不等于放宽：普通词里的同形字仍不动（MASK-10 的反向守卫）。
  assert.equal(masker.maskText('深夜的牌池讨论。'), '深夜的牌池讨论。');
});

test('MASK-16: 来源路径并入脱敏流——真实号码替换，普通路径原样', () => {
  const view = makeView({
    quotes: [],
    sources: ['raw/sessions/100000011.json', 'raw/sessions/2026-11-10-mask.json'],
  });
  const masked = maskPublicView(view, createMasker('source-seed'));

  assert.ok(!masked.sources[0].includes('100000011'), '来源里的真实号码必须脱敏');
  assert.ok(/^raw\/sessions\/10\d{6}\.json$/u.test(masked.sources[0]), `伪号形态不变：${masked.sources[0]}`);
  assert.equal(masked.sources[1], 'raw/sessions/2026-11-10-mask.json', '字母与普通数字原样保留');
});
