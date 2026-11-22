import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOUNDARY_ENERGY_FACTOR,
  BurstQuiescenceDetector,
  DEFAULT_POTENTIAL_CONSTANTS,
  DEFAULT_TRIGGER_OPTIONS,
  PotentialTracker,
  effectiveMessageCount,
  messageInformation,
  normalizePotentialText,
  normalizeTriggerOptions,
  potentialBurstThreshold,
  potentialCoolThreshold,
  potentialCrossingAt,
} from '../lib/index.js';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const TAU_MS = 240_000;
/** 60 秒的衰减系数 2^(-60/240)。 */
const F60 = Math.pow(2, -0.25);

const closeTo = (actual, expected, message, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
};

/** 496 字长文：I = 4.3266240（含「确实」「如此」，不含「实如」）。 */
const LONG_MESSAGE =
  '这个模型要说清楚的问题其实很简单：群里每天都在说话，但是真正值得沉淀的讨论只占很小一部分，剩下的都是寒暄、复读和跟风。旧的触发器只看单位时间内的消息条数，于是复读群和讨论群在全序关系上完全一样，甚至复读群更容易越过门限，因为复读群的消息条数天然更多。换成漏桶以后，每条消息都带一个信息量权重，复读群的消息权重接近零，讨论群的消息权重更高，长度再被对数压缩一次，避免一条粘贴的超长文本把势能顶爆。剩下的问题是信息量本身怎么定义。字面层面的做法是取二元组，看二元组在最近的窗口里出现过没有：出现过就是重复，没出现过就是新的表达。这个判据对复读群非常有效，因为复读群的二元组几乎全部重复；对讨论群同样有效，因为讨论群的每一次推进都会引入新的二元组。如此看来，二元组判据不能单独用，它必须和长度项一起用。当然它也会误伤同话题的长文，因为同话题共享术语，二元组重合率天然偏高，所以还要乘上类型记号比，拦掉重复字符刷屏这种伪长文。确实，这三项乘起来只是一个可以被现算的值，不需要模型，不需要向量，每条消息只花常数级的时间，复读群和讨论群在同一套口径下自然分开。复读群和讨论群的差别，说到底就是二元组重复率的差别，复读群的重复率高，讨论群的重复率低，重复率高的消息权重低，重复率低的消息权重高。';

/** 20 个「啊」：I = 0.0182407。 */
const PURE_NOISE = '啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊';

/** 10 字正常短句：I = 2.0723266。 */
const SENTENCE10 = '这条消息的信息量很低';

/** 170 字全新论述：I = 4.601835，N_equiv 折算被上界 3.0 截断。 */
const FRESH_EXPOSITION =
  '如果只按消息条数衡量活跃度，那么一个复读群会永远排在讨论群前面，因为复读的节奏天然更快。换个角度，把每条消息折算成一个可以被比较的信息量，再把它放进同一个衰减核里积分，大小群的差异就被抹平了：大群靠频率，小群靠深度，两条路径在势能上收敛到同一量级。真正要小心的只有伪互动，也就是一个人在演讲，另一个人在附和，这时候交互熵会明显偏低，即使总势能很高也不会被误判成一场讨论。';

/** 千字文十二句：每条 L=8、|G|=7、I = 1.8195113，句间二元组互不重叠。 */
const CLASSIC_LINES = [
  '天地玄黄宇宙洪荒',
  '日月盈昃辰宿列张',
  '寒来暑往秋收冬藏',
  '闰余成岁律吕调阳',
  '云腾致雨露结为霜',
  '金生丽水玉出昆冈',
  '剑号巨阙珠称夜光',
  '果珍李柰菜重芥姜',
  '海咸河淡鳞潜羽翔',
  '龙师火帝鸟官人皇',
  '始制文字乃服衣裳',
  '推位让国有虞陶唐',
];

/** 80 行代码块（原始 1029 字符）：折叠后 L=80，I = 4.3272513。 */
const CODE_BLOCK = [
  '```ts',
  'v0 = f(0);',
  'v1 = f(1);',
  'v2 = f(2);',
  'v3 = f(3);',
  'v4 = f(4);',
  'v5 = f(5);',
  'v6 = f(6);',
  'v7 = f(7);',
  'v8 = f(8);',
  'v9 = f(9);',
  'v10 = f(10);',
  'v11 = f(11);',
  'v12 = f(12);',
  'v13 = f(13);',
  'v14 = f(14);',
  'v15 = f(15);',
  'v16 = f(16);',
  'v17 = f(17);',
  'v18 = f(18);',
  'v19 = f(19);',
  'v20 = f(20);',
  'v21 = f(21);',
  'v22 = f(22);',
  'v23 = f(23);',
  'v24 = f(24);',
  'v25 = f(25);',
  'v26 = f(26);',
  'v27 = f(27);',
  'v28 = f(28);',
  'v29 = f(29);',
  'v30 = f(30);',
  'v31 = f(31);',
  'v32 = f(32);',
  'v33 = f(33);',
  'v34 = f(34);',
  'v35 = f(35);',
  'v36 = f(36);',
  'v37 = f(37);',
  'v38 = f(38);',
  'v39 = f(39);',
  'v40 = f(40);',
  'v41 = f(41);',
  'v42 = f(42);',
  'v43 = f(43);',
  'v44 = f(44);',
  'v45 = f(45);',
  'v46 = f(46);',
  'v47 = f(47);',
  'v48 = f(48);',
  'v49 = f(49);',
  'v50 = f(50);',
  'v51 = f(51);',
  'v52 = f(52);',
  'v53 = f(53);',
  'v54 = f(54);',
  'v55 = f(55);',
  'v56 = f(56);',
  'v57 = f(57);',
  'v58 = f(58);',
  'v59 = f(59);',
  'v60 = f(60);',
  'v61 = f(61);',
  'v62 = f(62);',
  'v63 = f(63);',
  'v64 = f(64);',
  'v65 = f(65);',
  'v66 = f(66);',
  'v67 = f(67);',
  'v68 = f(68);',
  'v69 = f(69);',
  'v70 = f(70);',
  'v71 = f(71);',
  'v72 = f(72);',
  'v73 = f(73);',
  'v74 = f(74);',
  'v75 = f(75);',
  'v76 = f(76);',
  'v77 = f(77);',
  'v78 = f(78);',
  'v79 = f(79);',
  '```',
].join('\n');

/** 970 字自然语言：L=899，I = 5.4464670。 */
const NATURAL_TEXT =
  '折叠代码块的动机和折叠链接是同一个：如果一段消息里塞进八十行配置，那么按字符统计出来的长度会把这条消息抬成一篇长文，可是这八十行配置本身几乎不携带任何可讨论的新意，它只是把某个已经存在的文件复制了一遍，读者扫一眼就知道里面没有需要回应的东西。所以先把围栏里面的内容按行压成一个记号，每一行只贡献一个字符，语言标注行直接丢掉，空行也不计，这样八十行配置最终只等于八十个字符的长度，与它实际有多少列无关。这也是为什么折叠之后的信息量只随行数缓慢增长，而不是随字符数暴涨。链接的处理同理：一条消息里贴了同一个域名的五个地址，真实的语义增量只是这个域名出现了一次，后面的四个地址都不应该再贡献任何长度，否则贴链接就会变成刷势能最廉价的手段，而这恰恰是旧公式最容易被打穿的地方。归一化之后再去统计实质字符，表情包、标点、空白都不会被算进去，这也和触发器物理层的口径保持一致，避免两套长度定义互相打架。接下来是把这些量放进同一个衰减核。消息到达的时刻是逻辑时间，衰减用半衰期表达，间隔越长保留越少，这样慢群的长文不会被时间稀释到看不见，快群的短句也不会因为条数多就自动堆成高分。然后是交互这一维：如果所有贡献都来自同一个人，无论他发多少字，交互项都为零，触发永远不该发生，因为那只是一个人的演讲，而不是一场讨论。最后是门限本身：固定门限在活跃群里会被日常闲聊顶穿，所以门限也要逐群自适应，基线只在空闲期学习，突发期冻结，下行无条件学习，上行带滞回，静默久了再向心衰减。这样一来，同一个公式在小群和大群、慢群和快群里都能给出可比较的判据，而不需要人工配置任何群级别的参数。剩下的细节是窗口管理。二元组并集只需要最近若干条消息，旧消息滑出窗口时把引用计数减一，计数归零就删掉，内存占用因此是有界的，不会随着群的历史线性增长。同一套引用计数也顺便回答了另一个问题：一条复读的消息在窗口里待多久，就会让后来者重复多久，这正好是我们希望的惩罚时长。顺带一提，折叠之后的行数统计也要有个上限，否则一个上千行的日志文件仍然能堆出很高的对数项，只是增长速度远慢于按字符统计而已。窗口长度本身也是一个参数，条数太少会让复读很快被遗忘，条数太多又会让正常的新表达被误判成重复，二十条是这两者之间的折中，既覆盖得了一场短促的争论，也不会把半小时前的旧话题一直压在新话题头上。';

/** 十二条四字消息：每条 I = 1.0397208，句间二元组互不重叠。 */
const FOURS = [
  '甲乙丙丁',
  '戊己庚辛',
  '壬癸子丑',
  '寅卯辰巳',
  '午未申酉',
  '戌亥乾兑',
  '坎离震巽',
  '艮坤泰否',
  '咸恒损益',
  '晋明夷睽',
  '蹇解萃升',
  '困井鼎革',
];

/** 30 条连喂用的十条四字文本。 */
const TEXTS = ['甲乙丙丁', '戊己庚辛', '壬癸子丑', '寅卯辰巳', '午未申酉', '戌亥乾兑', '坎离震巽', '艮坤泰否', '咸恒损益', '晋明夷睽'];

test('POTENTIAL-01: 信息量的四个基准点', () => {
  const tracker = new PotentialTracker();
  const first = tracker.push({ userId: 'u1', text: LONG_MESSAGE, at: T0 });
  closeTo(first.lastInfo, 4.326624047, '496 字长文信息量', 1e-6);

  const repeat = tracker.push({ userId: 'u1', text: LONG_MESSAGE, at: T0 + 1000 });
  assert.equal(repeat.lastInfo, 0, '与上一条完全相同的文本必须得到 I = 0');

  const noise = messageInformation(PURE_NOISE, undefined);
  assert.ok(noise < 0.2, `重复字符刷屏必须被压到 0.2 以下，实际 ${noise}`);

  const sentence = messageInformation(SENTENCE10, undefined);
  assert.ok(sentence > 2.0 && sentence < 2.15, `10 字短句 I 应落在 (2.0, 2.15)，实际 ${sentence}`);

  const fresh = messageInformation(FRESH_EXPOSITION, undefined);
  assert.ok(fresh > 3.8, `170 字全新论述 I 应大于 3.8，实际 ${fresh}`);
  assert.ok(effectiveMessageCount([fresh]) >= 2.5, '单条长文折算的等效消息数应不低于 2.5');

  closeTo(messageInformation(LONG_MESSAGE, new Set()), first.lastInfo, '空二元组窗口等价于全新文本', 1e-6);
});

test('POTENTIAL-02: 漏桶按 2^(-Δt/τ) 闭式衰减', () => {
  assert.deepEqual({ ...DEFAULT_POTENTIAL_CONSTANTS }, {
    tauSeconds: 240,
    minChars: 4,
    recentK: 20,
    refInfo: 1.5,
    speakerFloor: 1e-3,
    equivMin: 0.5,
    equivMax: 3,
  });
  assert.ok(Object.isFrozen(DEFAULT_POTENTIAL_CONSTANTS), '默认常量必须冻结');

  const tracker = new PotentialTracker();
  const first = tracker.push({ userId: 'a', text: LONG_MESSAGE, at: T0 });
  const base = first.energy;
  closeTo(base, 4.326624047, '首条势能', 1e-6);

  closeTo(tracker.peek(T0 + MINUTE).energy, base * F60, 'peek 一分钟残余势能');
  closeTo(tracker.peek(T0 + TAU_MS).energy, base * 0.5, '跨一个 τ 残余势能减半');

  const second = tracker.push({ userId: 'b', text: '嗯', at: T0 + MINUTE });
  closeTo(second.energy, base * F60, '相邻两次 push 之间只有衰减（单字 I = 0）');
  closeTo(second.count, F60 + 1, '同核消息计数');
  assert.equal(second.lastInfo, 0, '单字消息不计信息量');
});

test('POTENTIAL-03: 同核计数与信息密度', () => {
  const tracker = new PotentialTracker();
  let snapshot = null;
  for (const [index, line] of CLASSIC_LINES.entries()) {
    snapshot = tracker.push({ userId: 'a', text: line, at: T0 + index * MINUTE });
  }

  const expectedCount = (1 - F60 ** 12) / (1 - F60);
  closeTo(snapshot.count, expectedCount, '12 条同核计数的闭式解');
  closeTo(snapshot.density, 1.819511349, '恒定 I 时密度收敛到 Ī', 1e-6);
  assert.ok(
    Math.abs(snapshot.density - 1.819511349) < 1.819511349 * 0.05,
    '密度必须落在 Ī 的 ±5% 内',
  );

  const later = tracker.peek(T0 + 11 * MINUTE + TAU_MS);
  closeTo(later.count, snapshot.count * 0.5, '跨 τ 计数减半');
  closeTo(later.energy, snapshot.energy * 0.5, '跨 τ 势能减半');
});

test('POTENTIAL-04: 交互系数压制伪互动', () => {
  const trio = new PotentialTracker();
  trio.push({ userId: 'u1', text: CLASSIC_LINES[0], at: T0 });
  trio.push({ userId: 'u2', text: CLASSIC_LINES[1], at: T0 });
  const three = trio.push({ userId: 'u3', text: CLASSIC_LINES[2], at: T0 });

  assert.equal(three.interaction, 1, '三人信息均分时交互系数饱和为 1');
  for (const speaker of three.speakers) {
    closeTo(speaker.share, 1 / 3, '三人份额均等');
  }

  const solo = new PotentialTracker();
  for (const [index, line] of CLASSIC_LINES.slice(0, 3).entries()) {
    solo.push({ userId: 'u1', text: line, at: T0 + index * MINUTE });
  }
  const monologue = solo.peek(T0 + 2 * MINUTE);
  assert.equal(monologue.interaction, 0, '单人独白的交互系数必须是 0');
  assert.equal(monologue.quality, 0, '单人独白的有效势能必须是 0');

  const pair = new PotentialTracker();
  pair.push({ userId: 'a', text: LONG_MESSAGE, at: T0 });
  const reply = pair.push({ userId: 'b', text: '确实如此', at: T0 + 1000 });
  closeTo(reply.lastInfo, 0.346573590, '4 字短句只保留一个全新二元组');
  assert.ok(
    Math.abs(reply.interaction - 0.4) <= 0.03,
    `长文 + 4 字回帖的交互系数应约为 0.40，实际 ${reply.interaction}`,
  );
});

test('POTENTIAL-05: ΣE_u 不变量与发言人清理', () => {
  const tracker = new PotentialTracker();
  let snapshot = null;
  for (let index = 0; index < 30; index += 1) {
    snapshot = tracker.push({
      userId: `u${index % 3}`,
      text: TEXTS[index % TEXTS.length],
      at: T0 + index * 30_000,
    });
  }

  const total = snapshot.speakers.reduce((sum, speaker) => sum + speaker.energy, 0);
  assert.ok(Math.abs(total - snapshot.energy) < 1e-9, `Σ E_u 必须等于 energy：${total} vs ${snapshot.energy}`);
  assert.equal(snapshot.speakers.length, 3, '三名发言人全部存活');

  const cleanup = new PotentialTracker();
  let last = null;
  for (const [index, text] of FOURS.entries()) {
    last = cleanup.push({ userId: `m${index}`, text, at: T0 + index * HOUR });
    assert.equal(last.speakers.length, 1, `第 ${index} 条之后低能量发言人必须被清理`);
  }

  const remaining = last.speakers.reduce((sum, speaker) => sum + speaker.energy, 0);
  assert.ok(Math.abs(remaining - last.energy) < 1e-9, '清理之后 Σ E_u 仍然等于 energy');
  closeTo(last.energy, 1.039720771, '只剩最后一条四字消息的势能', 1e-6);

  assert.deepEqual(
    tracker.recentTexts(2),
    [TEXTS[28 % TEXTS.length], TEXTS[29 % TEXTS.length]],
    '最近窗口按最旧 → 最新返回归一化文本',
  );
  assert.deepEqual(tracker.recentTexts(0), [], 'limit 非正时返回空数组');

  tracker.reset();
  assert.deepEqual(tracker.recentTexts(10), [], 'reset 清空二元组窗口');
  const afterReset = tracker.push({ userId: 'z', text: FOURS[0], at: T0 });
  assert.equal(afterReset.count, 1, 'reset 之后计数从 1 重新开始');
  assert.equal(afterReset.speakers.length, 1, 'reset 之后只保留新发言人');
  closeTo(afterReset.energy, 1.039720771, 'reset 之后窗口为空，等价于全新文本', 1e-6);
});

test('POTENTIAL-06: 归一化拦截 URL 与代码块虚高', () => {
  const single = normalizePotentialText('看看这个 https://a.com/1 很有意思的讨论');
  const repeated = normalizePotentialText(
    '看看这个 https://a.com/1 https://a.com/2 http://a.com:8080/x 很有意思的讨论',
  );

  assert.equal(single.urls, 1, '单条 URL 计一个记号');
  assert.equal(repeated.urls, 1, '同 host 的多条 URL 只计一个记号');
  assert.equal(repeated.text, single.text, '同 host 的重复 URL 不得改变归一化文本');
  assert.equal(single.text.length, 12, 'URL 只占 1 个字符');
  closeTo(messageInformation(repeated, undefined), messageInformation(single, undefined), 'URL 数量不影响信息量');

  const twoHosts = normalizePotentialText('看看这个 https://a.com/1 很有意思 https://b.org/x 的讨论');
  assert.equal(twoHosts.urls, 2, '不同 host 各计一个记号');
  assert.equal(twoHosts.text.length, single.text.length + 1, '第二个 host 只多占一个字符');

  const code = normalizePotentialText(CODE_BLOCK);
  assert.equal(code.codeBlocks, 1);
  assert.equal(code.text.length, 80, '80 行代码折叠为 80 个记号');
  assert.equal(CODE_BLOCK.length, 1029, '代码块原始字符数');
  assert.equal(normalizePotentialText(code.text).text, code.text, '归一化对自身输出幂等');

  const codeInfo = messageInformation(CODE_BLOCK, undefined);
  const proseInfo = messageInformation(NATURAL_TEXT, undefined);
  assert.ok(codeInfo < 4.4, `折叠后信息量必须接近 log(80)，实际 ${codeInfo}`);
  assert.ok(normalizePotentialText(NATURAL_TEXT).text.length > 850, '对照文本长度与代码块原始长度同量级');
  assert.ok(codeInfo < proseInfo * 0.82, `代码块信息量必须明显低于同长度自然语言：${codeInfo} vs ${proseInfo}`);
});

test('POTENTIAL-07: 等效消息数折算', () => {
  assert.equal(effectiveMessageCount([4.5, 4.5, 4.5, 4.5]), 12, '四条 4.5 折算为 12 条');
  assert.equal(effectiveMessageCount([0.1]), 0.5, '低于下界按 0.5 计');
  assert.equal(effectiveMessageCount([100]), 3, '高于上界按 3.0 计');
  assert.equal(effectiveMessageCount([0, -1, 1.5]), 1, 'I = 0 与负值都不计入');
  assert.equal(effectiveMessageCount([4.5], 3), 1.5, '可覆盖参考信息量');
});

test('POTENTIAL-08: 冷却回落闭式解', () => {
  const crossing = potentialCrossingAt(40, 10, T0);
  assert.ok(crossing !== null, 'E > Θ 时必须给出回落时刻');
  assert.ok(Math.abs(crossing - (T0 + 480_000)) <= 1, `τ 与 log2(4) 应给出 +480000ms，实际 ${crossing - T0}`);

  assert.equal(potentialCrossingAt(10, 10, T0), null, 'E == Θ 不产生回落时刻');
  assert.equal(potentialCrossingAt(9.999, 10, T0), null, 'E < Θ 不产生回落时刻');

  const halfTau = potentialCrossingAt(40, 10, T0, 120);
  assert.ok(halfTau !== null);
  assert.ok(Math.abs(halfTau - (T0 + 240_000)) <= 1, 'τ 减半则回落时刻减半');
});

test('POTENTIAL-09: recentTexts 返回人类可读文本', () => {
  const mixed = '看这个 https://a.com/docs 然后\n```ts\nconst a = 1;\nconst b = 2;\n```\n很有意思';
  const tracker = new PotentialTracker();
  tracker.push({ userId: 'u1', text: mixed, at: T0 });

  const tail = tracker.recentTexts(1);
  assert.equal(tail.length, 1, 'limit 生效');
  assert.ok(!/[\uE000-\uF7FF]/u.test(tail[0]), `可读文本不得含私用区记号码点：${JSON.stringify(tail[0])}`);
  assert.ok(tail[0].includes('[链接:a.com]'), `URL 记号应展开为 [链接:host]：${tail[0]}`);
  assert.ok(tail[0].includes('[代码 2 行]'), `代码块应概括为 [代码 N 行]：${tail[0]}`);
  assert.ok(tail[0].includes('看这个') && tail[0].includes('很有意思'), `正文应原样保留：${tail[0]}`);

  const capped = new PotentialTracker({ recentK: 3 });
  for (const [index, line] of CLASSIC_LINES.slice(0, 5).entries()) {
    capped.push({ userId: 'u1', text: line, at: T0 + index * MINUTE });
  }
  assert.deepEqual(capped.recentTexts(10), CLASSIC_LINES.slice(2, 5), '窗口只保留最近 recentK 条');
  assert.equal(capped.recentTexts(1)[0], CLASSIC_LINES[4], '纯文本消息的可读文本与归一化文本一致');
  assert.equal(capped.recentTexts(2).length, 2, '返回条数受 limit 约束');
  assert.deepEqual(capped.recentTexts(0), [], 'limit 非正时返回空数组');
});

test('POTENTIAL-10: peek 回看夹紧到 lastAt，势能与密度不得虚高', () => {
  const tracker = new PotentialTracker();
  tracker.push({ userId: 'u1', text: LONG_MESSAGE, at: T0 });
  tracker.push({ userId: 'u2', text: SENTENCE10, at: T0 + 2 * MINUTE });

  const now = tracker.peek(T0 + 2 * MINUTE);
  const past = tracker.peek(T0 + MINUTE);
  closeTo(past.energy, now.energy, '回看 1 分钟不得把残余势能放大（衰减因子 > 1）');
  closeTo(past.density, now.density, '回看不得把信息密度放大');
  closeTo(past.count, now.count, '回看不得把同核计数放大');
  assert.equal(past.at, T0 + 2 * MINUTE, '快照时间夹紧到 lastAt');

  const future = tracker.peek(T0 + 6 * MINUTE);
  assert.ok(future.energy < now.energy, '前瞻仍然正常衰减');
});

test('POTENTIAL-11: thetaMin 下限为正（0 被拒 ⇒ 冷启动 Θ_cool 恒正，不会楔死冷却）', () => {
  assert.throws(
    () => normalizeTriggerOptions({ thetaMin: 0 }),
    RangeError,
    'thetaMin=0 必须被拒：冷启动 b_Q=0 时 Θ_cool=max(0,0)×1.1=0，闭式解恒 null ⇒ 永不冷却',
  );
  assert.throws(
    () => new BurstQuiescenceDetector({ options: { thetaMin: 0 }, onQuiescence: () => {} }),
    RangeError,
    '构造函数走同一套参数校验，同样不得接受 thetaMin=0',
  );
  assert.throws(() => normalizeTriggerOptions({ thetaMin: -1 }), RangeError, '负值同样越界');

  const minimal = normalizeTriggerOptions({ thetaMin: 1e-3, burstMultiplier: 2 });
  const cool = potentialCoolThreshold(minimal, 0);
  assert.ok(cool > 0, `冷启动 b_Q=0 时 Θ_cool 必须为正，实际 ${cool}`);
  assert.ok(potentialBurstThreshold(minimal, 0) > 0, 'Θ_burst 同样恒正（thetaMin 就是它的下限）');
  assert.notEqual(potentialCrossingAt(10, cool, T0), null, '正阈值必须解得回落时刻');
  assert.equal(potentialCrossingAt(10, 0, T0), null, '阈值非正时闭式解为 null —— 这正是 thetaMin=0 的楔子');
});

// ---------------------------------------------------------------------------
// 建仓回溯环的时基（detector ↔ potential 的接缝）
// ---------------------------------------------------------------------------

/** 假时钟 + 假调度器 + 收件箱（与 tests/trigger-entropy.test.mjs 同构）。 */
function createHarness(options, channelId = 'potential-channel') {
  const state = { clock: T0 };
  const timers = [];
  const deliveries = [];
  const discards = [];
  const detector = new BurstQuiescenceDetector({
    options,
    now: () => state.clock,
    scheduler: (callback, delayMs) => {
      const timer = { at: state.clock + delayMs, callback };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    onQuiescence: (session) => {
      deliveries.push(session);
    },
    onDiscard: (info) => {
      discards.push(info);
    },
  });

  const drain = () => {
    timers.sort((left, right) => left.at - right.at);
    while (timers.length > 0 && timers[0].at <= state.clock) {
      timers.shift().callback();
    }
  };

  /** 墙钟与原始时间戳分离：模拟「逻辑时间已领先、原始戳仍旧」的投递滞后消息。 */
  const sayApart = (userId, content, timestamp, wallClock) => {
    state.clock = wallClock;
    drain();
    return detector.onMessage({
      id: `${userId}-${timestamp}-${wallClock}`,
      channelId,
      userId,
      userName: userId,
      content,
      timestamp,
    });
  };

  const say = (userId, content, at) => sayApart(userId, content, at, at);

  return { detector, deliveries, discards, say, sayApart, drain, state, channelId };
}

/** 第一轮讨论：双人轮换的长文，Q 迅速越过 thetaMin=1。 */
const DEBATE_ROUND_A = [
  '写入路径拆成两段之后，前段只做校验与排序，后段才落盘并广播，这样后段抖动不会拖慢前段，每一段还要各自限流，避免阻塞沿调用链向上传播。',
  '监控面板上真正有用的是排队深度与拒绝计数，而不是平均延迟；平均值会把长尾藏起来，事故发生时根本看不出瓶颈卡在哪一级队列。',
  '配置热更新比想象中难，难点不在推送而在校验：一旦某个非法阈值被推下去，整套限流会在几分钟内雪崩，所以要先做影子校验再切换。',
  '灰度发布要按调用方切而不是按机器切，因为同一台机器上不同租户的流量特征差别很大，按机器切会让灰度样本失去代表性。',
  '回滚预案必须先于上线写好，并且真的演练一次；没演练过的预案在凌晨三点通常跑不通，脚本里的路径与环境变量早就变了。',
  '数据一致性方面我倾向于最终一致，但要求补偿任务幂等；补偿任务一旦不幂等，重试就会把账目翻倍，排查成本远高于加一个去重键。',
];

/** 第二轮讨论：与第一轮完全不同的词域，便于断言缓冲里到底是哪几条。 */
const DEBATE_ROUND_B = [
  '客户端缓存失效策略要按资源类型分开，静态图走强缓存，接口响应只做协商缓存，否则新旧版本会在同一台设备上互相覆盖。',
  '分页游标比偏移量可靠，偏移量在写入并发时会跳过或重复记录，游标把位置编码进令牌，翻页期间新增数据也不会打乱顺序。',
  '重试要带抖动与上限，固定间隔的指数退避会在故障恢复瞬间把所有客户端同时打回服务端，把一次抖动放大成雪崩。',
];

test('POTENTIAL-12: 未来戳之后突发仍能从回溯环建仓（环与种子不得混用时基）', () => {
  const harness = createHarness({
    triggerMode: 'potential',
    thetaMin: 1,
    rhoMin: 0,
    burstMultiplier: 1.5,
    quiescenceSeconds: 10,
    minDiscussionMessages: 4,
  });
  try {
    const FUTURE = T0 + 2 * HOUR;

    // ① 一条未来戳消息把逻辑时间永久抬到 FUTURE（单人、低信息量 ⇒ 不触发）。
    harness.say('u0', '先占个位置，晚点补上具体方案。', FUTURE);

    // ② 诚实原始戳（停在 T0 附近）的讨论：归一化后的逻辑时间仍是 FUTURE 之后。
    let phase = '';
    for (const [index, text] of DEBATE_ROUND_A.entries()) {
      phase = harness.say(index % 2 === 0 ? 'u1' : 'u2', text, T0 + index * 1000).phase;
      if (index === 3) {
        assert.equal(phase, 'BURSTING', '第一轮必须成立，才能把 lastSettledTime 推到逻辑时间');
      }
    }

    // ③ 静默结算：lastSettledTime 变成逻辑结束时刻，远高于任何诚实的原始时间戳。
    harness.state.clock = FUTURE + 3 * HOUR;
    harness.detector.tick();
    harness.drain();
    assert.equal(harness.deliveries.length + harness.discards.length, 1, '第一轮必须结算一次');
    const settled = harness.detector.getState(harness.channelId).lastSettledTime;
    assert.ok(settled >= FUTURE, `lastSettledTime 必须是逻辑时间，实际 ${settled} < ${FUTURE}`);

    // ④ 第二轮：原始戳仍是旧值（T0 + 5s 起），墙钟已到 FUTURE + 3h。
    //    修前：环用逻辑 at 算 cutoff 却比较原始 timestamp ⇒ 环被自剪空；
    //          seed 用原始 timestamp 比 lastSettledTime ⇒ 恒为空。突发成立时缓冲里一条都没有。
    let burstIndex = -1;
    for (const [index, text] of DEBATE_ROUND_B.entries()) {
      const metrics = harness.sayApart(
        index % 2 === 0 ? 'u3' : 'u4',
        text,
        T0 + 5000 + index * 1000,
        FUTURE + 3 * HOUR + index * 1000,
      );
      if (metrics.phase === 'BURSTING') {
        burstIndex = index;
        break;
      }
    }
    assert.ok(burstIndex >= 0, '第二轮必须成立');

    const buffer = harness.detector.getState(harness.channelId).buffer;
    assert.ok(buffer.length > 0, `建仓缓冲不得为空，实际 ${buffer.length} 条`);
    assert.equal(buffer[0].content, DEBATE_ROUND_B[0], '缓冲首条必须是本轮讨论的第一条消息');
    assert.equal(buffer.length, burstIndex + 1, '缓冲恰好是本轮触发前的消息（不含上一轮残留）');
  } finally {
    harness.detector.dispose();
  }
});

// ---------------------------------------------------------------------------
// 密度基线 / 峰值冷却 / 边界衰减 / 峰值观测（POTENTIAL-13..16）
// ---------------------------------------------------------------------------

/**
 * 互不重复的高信息量长文：两条千字文句子 + 唯一序号与唯一汉字。
 *
 * 不能直接复用 `LONG_MESSAGE` 反复投喂：同一段文本第二次出现时二元组全部命中窗口，
 * `I` 立刻归零、密度塌到 0，测不出密度基线的学习曲线。
 */
const freshExposition = (index) =>
  `${CLASSIC_LINES[index % 12]}${CLASSIC_LINES[(index * 5 + 3) % 12]}第${index}轮` +
  `${String.fromCharCode(0x4e00 + index * 97)}方向`;

test('POTENTIAL-13: b_ρ 学习后 ρ_eff 抬过 rhoMin，裁决按 ρ_eff（densityMultiplier=0 才回落）', () => {
  // 注入理由：ADR-021 已证 ρ 不是跨群分离轴，densityMultiplier 只让下限随本群量级浮动。
  // 本用例把 rhoMin 压到 0.8 且用 shadow 模式（相位不迁移 ⇒ 学习闸门稳定），
  // 让「日常密度」明显高于 rhoMin，从而能观测到 ρ_eff 被 b_ρ 抬起。
  const baseOptions = {
    triggerMode: 'shadow',
    thetaMin: 1e-3,
    rhoMin: 0.8,
    burstMultiplier: 1.1,
    coolingRatioThreshold: 0.5,
    minDiscussionMessages: 12,
  };

  /** 同一条消息流：20 条高密度长文做预热，再补 2 条四字短句把 ρ 压到 b_ρ 之下。 */
  const stream = (densityMultiplier) => {
    const harness = createHarness(
      densityMultiplier === undefined ? baseOptions : { ...baseOptions, densityMultiplier },
    );
    try {
      for (let index = 0; index < 20; index += 1) {
        harness.say(index % 2 === 0 ? 'u1' : 'u2', freshExposition(index), T0 + index * MINUTE);
      }
      const warm = harness.detector.getStatus(harness.channelId).potential;
      harness.say('u2', `${FOURS[0]}0`, T0 + 20 * MINUTE);
      harness.say('u1', `${FOURS[1]}1`, T0 + 21 * MINUTE);
      const verdict = harness.detector.evaluateVerdicts(harness.channelId).potential;
      const status = harness.detector.getStatus(harness.channelId).potential;
      return { warm, verdict, status };
    } finally {
      harness.detector.dispose();
    }
  };

  const gated = stream(undefined); // 缺省 = 1.0，走 b_ρ
  assert.ok(
    gated.warm.baselineDensity > baseOptions.rhoMin,
    `预热后 b_ρ 必须高于 rhoMin（实测 ${gated.warm.baselineDensity.toFixed(3)}）`,
  );
  closeTo(gated.warm.rhoEff, gated.warm.baselineDensity, '倍数 1.0 时 ρ_eff = max(rhoMin, b_ρ) = b_ρ');
  assert.ok(gated.warm.rhoEff > baseOptions.rhoMin, 'ρ_eff 必须被 b_ρ 抬过固定 rhoMin');

  // 裁决必须用 ρ_eff 而不是裸 rhoMin：Q 已越界、ρ 却落在 (rhoMin, ρ_eff) 之间。
  assert.ok(
    gated.verdict.quality > gated.verdict.burstThreshold,
    `Q=${gated.verdict.quality.toFixed(2)} 必须高于门限 ${gated.verdict.burstThreshold.toFixed(2)}，否则测不到密度闸门`,
  );
  assert.ok(
    gated.verdict.density >= baseOptions.rhoMin,
    `ρ=${gated.verdict.density.toFixed(3)} 必须仍高于 rhoMin，否则测不到 ρ_eff 的增量`,
  );
  assert.ok(
    gated.verdict.density < gated.verdict.rhoEff,
    `ρ=${gated.verdict.density.toFixed(3)} 必须低于 ρ_eff=${gated.verdict.rhoEff.toFixed(3)}`,
  );
  assert.equal(gated.verdict.ready, false, 'ρ < ρ_eff 时势能判据不得就绪（旧口径按 rhoMin 会误判为就绪）');
  closeTo(gated.verdict.rhoEff, gated.status.rhoEff, '裁决与观测必须共用同一 ρ_eff 口径');
  closeTo(
    gated.verdict.rhoEff,
    Math.max(baseOptions.rhoMin, gated.verdict.baselineDensity),
    'ρ_eff 公式自洽',
  );

  const ungated = stream(0); // 0 = 只用固定 rhoMin
  closeTo(ungated.verdict.rhoEff, baseOptions.rhoMin, 'densityMultiplier=0 时 ρ_eff 恒等于 rhoMin');
  assert.equal(ungated.verdict.ready, true, '同一条消息流在关闭 ρ 自适应后必须就绪（对照）');

  const doubled = stream(2);
  closeTo(
    doubled.verdict.rhoEff,
    2 * doubled.verdict.baselineDensity,
    '倍数 2.0 时 ρ_eff = 2 × b_ρ',
  );
  assert.ok(doubled.verdict.rhoEff > gated.verdict.rhoEff, '倍数越大 ρ_eff 越高');

  // 静默不磨 b_ρ（回归 0.8.32 线上实测：b_ρ 被套用 Q 的 15 分钟半衰期衰减到 3e-7、
  // ρ_eff 恒退化为 rhoMin）。预热后隔 40 分钟再来一条消息，b_ρ 必须基本原地不动。
  const silent = createHarness(baseOptions);
  try {
    for (let index = 0; index < 20; index += 1) {
      silent.say(index % 2 === 0 ? 'u1' : 'u2', freshExposition(index), T0 + index * MINUTE);
    }
    const learned = silent.detector.getStatus(silent.channelId).potential.baselineDensity;
    assert.ok(learned > baseOptions.rhoMin, `预热后 b_ρ=${learned.toFixed(3)} 必须先高于 rhoMin`);
    silent.say('u3', freshExposition(40), T0 + 20 * MINUTE + 40 * MINUTE);
    const afterSilence = silent.detector.getStatus(silent.channelId).potential.baselineDensity;
    assert.ok(
      afterSilence > learned * 0.5,
      `40 分钟静默不得把 b_ρ 从 ${learned.toFixed(3)} 磨到 ${afterSilence.toFixed(3)}：ρ 是消息属性不随时间衰减`,
    );
  } finally {
    silent.detector.dispose();
  }
});

test('POTENTIAL-14: 峰值比例冷却抬高 Θ_cool 且恒低于 Θ_burst', () => {
  const options = normalizeTriggerOptions({
    thetaMin: 20,
    burstMultiplier: 2.5,
    coolingRatioThreshold: 1.1,
    peakCoolFraction: 0.5,
  });
  assert.equal(DEFAULT_TRIGGER_OPTIONS.peakCoolFraction, 0.5, '默认峰值冷却分数必须是 0.5');
  assert.equal(normalizeTriggerOptions({}).peakCoolFraction, 0.5, '缺省补默认值');

  const burst = potentialBurstThreshold(options, 40); // max(20, 100) = 100
  const base = potentialCoolThreshold(options, 40); // 1.1 × 40 = 44
  closeTo(base, 44, '未观测峰值时退化为纯基线口径');
  closeTo(potentialCoolThreshold(options, 40, 0), base, '峰值 0（尚未观测）逐位退化');
  closeTo(potentialCoolThreshold(options, 40, 120), 60, '峰值 120 × 0.5 = 60，高于基线 44');
  closeTo(potentialCoolThreshold(options, 40, 1e6), burst * 0.99, '峰值再高也封顶到 Θ_burst × 0.99');

  const off = normalizeTriggerOptions({ thetaMin: 20, burstMultiplier: 2.5, coolingRatioThreshold: 1.1, peakCoolFraction: 0 });
  closeTo(potentialCoolThreshold(off, 40, 1e6), base, 'peakCoolFraction=0 关闭叠加项');

  const half = normalizeTriggerOptions({ thetaMin: 20, burstMultiplier: 2.5, coolingRatioThreshold: 1.1, peakCoolFraction: 0.25 });
  closeTo(potentialCoolThreshold(half, 40, 120), 44, '0.25 × 120 = 30 低于基线 ⇒ 取基线');

  // 不变量：∀ b_Q, ∀ peak，Θ_cool 单调不低于基线口径，且严格低于 Θ_burst（迟滞带恒成立）。
  for (const baselineQuality of [0, 5, 20, 40, 100]) {
    const ceiling = potentialBurstThreshold(options, baselineQuality);
    const floor = potentialCoolThreshold(options, baselineQuality);
    for (const peak of [0, 1, 50, 120, 1e6]) {
      const cool = potentialCoolThreshold(options, baselineQuality, peak);
      assert.ok(
        cool < ceiling,
        `b_Q=${baselineQuality} peak=${peak}: Θ_cool=${cool} 必须严格小于 Θ_burst=${ceiling}`,
      );
      assert.ok(
        cool >= Math.min(floor, ceiling * 0.99),
        `b_Q=${baselineQuality} peak=${peak}: Θ_cool=${cool} 不得低于基线口径与封顶的较小者`,
      );
    }
    assert.ok(potentialCoolThreshold(options, baselineQuality, 120) >= floor, '峰值项只抬高、不压低');
  }
});

test('POTENTIAL-15: applyBoundary 折半 E/N、保持 ρ、清空二元组窗口（含 sliceAt 接线）', () => {
  assert.equal(BOUNDARY_ENERGY_FACTOR, 0.5, '边界保留系数是契约常量 0.5');

  const tracker = new PotentialTracker();
  tracker.push({ userId: 'a', text: LONG_MESSAGE, at: T0 });
  const before = tracker.push({ userId: 'b', text: SENTENCE10, at: T0 + MINUTE });
  assert.ok(before.energy > 0 && before.count > 1, '前置快照必须有势能与计数');
  assert.equal(tracker.recentTexts(5).length, 2, '边界前二元组窗口非空');

  tracker.applyBoundary(BOUNDARY_ENERGY_FACTOR);
  const after = tracker.peek(T0 + MINUTE);
  closeTo(after.energy, before.energy * 0.5, '总势能 E 折半');
  closeTo(after.count, before.count * 0.5, '同核计数 N 折半');
  closeTo(after.density, before.density, '信息密度 ρ 不变（E 与 N 同乘一个系数）');
  closeTo(after.quality, before.quality * 0.5, '有效势能 Q 随 E 同比折减（S_turn 只看份额）');
  assert.deepEqual(tracker.recentTexts(10), [], 'recent 必须清空');

  const replay = tracker.push({ userId: 'a', text: LONG_MESSAGE, at: T0 + 2 * MINUTE });
  assert.ok(replay.lastInfo > 0, `跨话题重述不得被判成「重复」：I=${replay.lastInfo}`);

  assert.throws(() => tracker.applyBoundary(-0.5), RangeError, '负系数越界');
  assert.throws(() => tracker.applyBoundary(1.5), RangeError, '大于 1 越界');
  assert.throws(() => tracker.applyBoundary(Number.NaN), RangeError, 'NaN 越界');

  // 接线：`noteBoundary → sliceAt` 必须在交付前段之后折减跟踪器势能。
  const harness = createHarness({
    triggerMode: 'potential',
    thetaMin: 1,
    rhoMin: 0,
    burstMultiplier: 1.5,
    quiescenceSeconds: 3600,
    minDiscussionMessages: 4,
  });
  try {
    for (const [index, text] of DEBATE_ROUND_A.entries()) {
      harness.say(index % 2 === 0 ? 'u1' : 'u2', text, T0 + index * 1000);
    }
    const state = harness.detector.getState(harness.channelId);
    assert.equal(state.phase, 'BURSTING', '前置条件：讨论已成立');
    const lastAt = T0 + (DEBATE_ROUND_A.length - 1) * 1000;
    const cut = T0 + 3 * 1000;
    const energyBefore = harness.detector.getStatus(harness.channelId, lastAt).potential.energy;
    harness.detector.noteBoundary(harness.channelId, cut, 0.9);
    assert.equal(harness.deliveries.length, 1, '边界必须交付前段');
    const energyAfter = harness.detector.getStatus(harness.channelId, lastAt).potential.energy;
    assert.ok(
      Math.abs(energyAfter - energyBefore * BOUNDARY_ENERGY_FACTOR) < Math.max(1e-9, energyBefore * 1e-9),
      `边界交付后残余势能应折半：${energyBefore} → ${energyAfter}`,
    );
    assert.ok(harness.deliveries[0].partial === true, '边界切分仍是半截会话');
  } finally {
    harness.detector.dispose();
  }
});

test('POTENTIAL-16: 结算会话携带 potentialPeak（rate 模式为 undefined）', () => {
  const harness = createHarness({
    triggerMode: 'potential',
    thetaMin: 1,
    rhoMin: 0,
    burstMultiplier: 1.5,
    quiescenceSeconds: 10,
    minDiscussionMessages: 4,
  });
  try {
    for (const [index, text] of DEBATE_ROUND_A.entries()) {
      harness.say(index % 2 === 0 ? 'u1' : 'u2', text, T0 + index * 1000);
    }
    const state = harness.detector.getState(harness.channelId);
    assert.equal(state.phase, 'BURSTING');
    assert.ok(state.sessionPeakQuality > 0, `本轮峰值必须被观测（实测 ${state.sessionPeakQuality}）`);

    // 峰值冷却接线：Θ_cool = min(max(基线, peak × fraction), Θ_burst × 0.99)。
    const verdict = harness.detector.evaluateVerdicts(harness.channelId).potential;
    const expectedCool = Math.min(
      Math.max(
        Math.max(1 / 1.5, verdict.baselineQuality) * 1.1,
        state.sessionPeakQuality * 0.5,
      ),
      verdict.burstThreshold * 0.99,
    );
    closeTo(verdict.coolThreshold, expectedCool, 'Θ_cool 必须把本轮峰值算进去');
    assert.ok(
      verdict.coolThreshold <= verdict.burstThreshold * 0.99 + 1e-9,
      `Θ_cool=${verdict.coolThreshold} 不得越过 Θ_burst=${verdict.burstThreshold}`,
    );

    const lastAt = T0 + (DEBATE_ROUND_A.length - 1) * 1000;
    harness.state.clock = lastAt + 3 * HOUR;
    harness.detector.tick();
    harness.drain();

    assert.equal(harness.deliveries.length, 1, '平息后必须结算一次');
    const session = harness.deliveries[0];
    assert.equal(session.partial, false, '这是完整一轮讨论');
    assert.ok(session.potentialPeak, '完整结算必须携带 potentialPeak');
    assert.ok(session.potentialPeak.quality > 0, '峰值 Q 必须为正');
    assert.ok(session.potentialPeak.density > 0, '峰值密度必须为正');
    assert.ok(
      session.potentialPeak.quality >= session.potentialPeak.burstThreshold,
      `峰值 ${session.potentialPeak.quality} 必须不低于峰值时刻的门限 ${session.potentialPeak.burstThreshold}`,
    );
    assert.equal(
      harness.detector.getState(harness.channelId).sessionPeakQuality,
      0,
      '结算后峰值观测必须清零，否则质量门会拿上一轮的高点放行',
    );
  } finally {
    harness.detector.dispose();
  }

  // rate 模式：判据层不做势能观测，会话不得带 potentialPeak。
  const rate = createHarness({ quiescenceSeconds: 10, minDiscussionMessages: 4 });
  try {
    for (let index = 0; index < 12; index += 1) {
      rate.say(index % 2 === 0 ? 'u1' : 'u2', freshExposition(index), T0 + index * 2000);
    }
    assert.equal(rate.detector.getState(rate.channelId).phase, 'BURSTING', '速率判据必须建仓');
    rate.state.clock = T0 + 12 * 2000 + 3 * HOUR;
    rate.detector.tick();
    rate.drain();
    assert.equal(rate.deliveries.length, 1, '速率模式同样结算一次');
    assert.equal(rate.deliveries[0].potentialPeak, undefined, 'rate 模式不得伪造势能峰值');
  } finally {
    rate.detector.dispose();
  }
});
