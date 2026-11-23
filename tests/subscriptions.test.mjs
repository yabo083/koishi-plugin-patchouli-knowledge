import test from 'node:test';
import assert from 'node:assert/strict';

import {
  albumValueOfTarget,
  compileSubscriptions,
  entryTargetsFor,
  formatSubscriptionLogLines,
  installSubscriptionTargetLabels,
  installSubscriptionTargetWarnings,
  isListening,
  listeningGroupIds,
  normalizeSubscriptionRows,
  projectLegacySubscriptionRows,
  resolveRows,
  resolveTarget,
  resolveTargets,
  validateSubscriptionRows,
} from '../lib/plugin/subscriptions.js';
import { buildLegacyTargetIndex, buildTargetNameIndex } from '../lib/index.js';

/** 最小配置：只带订阅编译需要的字段。 */
function config(overrides = {}) {
  return {
    channels: [],
    albumDelivery: { cron: '30 4 * * 1', albums: [], entryEnabled: true, entryRedirectChannelId: '' },
    subscriptions: [],
    ...overrides,
  };
}

/** 一行订阅的完整形状（多值目标）。 */
function row(source, targets, entry = true, weekly = false) {
  return { source, targets: Array.isArray(targets) ? targets : [targets], entry, weekly };
}

/** 历史单值行（宿主 yml 的旧写法，归一后必须等价于 `targets: [target]`）。 */
function legacyRow(source, target, entry = true, weekly = false) {
  return { source, target, entry, weekly };
}

test('SUBS-01: 空表完全回退旧配置——白名单为空即监听全部群', () => {
  const snapshot = compileSubscriptions(config());
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.listening, null, '旧配置 channels 为空 = 全部群');
  assert.equal(isListening(snapshot, 'onebot:123'), true);
  assert.equal(entryTargetsFor(snapshot, 'onebot:123').length, 0, '词条目标交给旧路径，编译层不推断');
});

test('SUBS-02: 空表时旧白名单仍是监听范围，且带平台前缀也能匹配', () => {
  const snapshot = compileSubscriptions(config({ channels: ['123', '456'] }));
  assert.equal(snapshot.active, false);
  assert.equal(isListening(snapshot, 'onebot:123'), true);
  assert.equal(isListening(snapshot, 'onebot:789'), false);
  assert.deepEqual(listeningGroupIds(snapshot)?.sort(), ['123', '456']);
});

test('SUBS-03: 表生效后监听集合只认表，旧白名单不再参与', () => {
  const snapshot = compileSubscriptions(config({ channels: ['999'], subscriptions: [row('123', '')] }));
  assert.equal(snapshot.active, true);
  assert.equal(isListening(snapshot, '123'), true);
  assert.equal(isListening(snapshot, '999'), false, '旧白名单在表生效后失效');
  assert.equal(isListening(snapshot, 'onebot:123'), true, '来源比较兼容平台前缀');
});

test('SUBS-04: `*` 行让监听回到全部群，但仍保留其他行的词条路由', () => {
  const snapshot = compileSubscriptions(
    config({ subscriptions: [row('*', '456/A1'), row('123', '123/A1')] }),
  );
  assert.equal(snapshot.listening, null);
  assert.equal(listeningGroupIds(snapshot), null);
  assert.deepEqual(entryTargetsFor(snapshot, 'onebot:999'), [
    { kind: 'album', channelId: 'onebot:456', albumId: 'A1' },
  ]);
  assert.deepEqual(entryTargetsFor(snapshot, 'onebot:123'), [
    { kind: 'album', channelId: 'onebot:456', albumId: 'A1' },
    { kind: 'album', channelId: 'onebot:123', albumId: 'A1' },
  ]);
});

test('SUBS-05: 行级 entry=false 不投递；target 留空也不投', () => {
  const off = compileSubscriptions(config({ subscriptions: [row('123', '456/A1', false)] }));
  assert.deepEqual(entryTargetsFor(off, '123'), []);
  const blank = compileSubscriptions(config({ subscriptions: [row('123', '', true)] }));
  assert.deepEqual(entryTargetsFor(blank, '123'), []);
});

test('SUBS-06: resolveTarget 只认 @chat、唯一可读名与旧 `群号/相册ID`，其余一律丢弃', () => {
  installSubscriptionTargetLabels();
  assert.deepEqual(resolveTarget('@chat', '123'), [{ kind: 'channel', channelId: 'onebot:123' }]);
  assert.deepEqual(resolveTarget('123/A1'), [{ kind: 'album', channelId: 'onebot:123', albumId: 'A1' }]);
  for (const bad of ['', '*', 'onebot:123', '123', '123/', '/A1', '123/A1/B2', '周报', '群1 · 周报']) {
    assert.deepEqual(resolveTarget(bad), [], `非法目标必须丢弃：${bad}`);
  }
  assert.deepEqual(resolveTarget('#group:1'), [], '分组标题不是目标');
  assert.deepEqual(resolveTarget('#group:1', '123'), [], '分组标题不是目标（带来源也一样）');

  // 名字靠唯一表解析；未登记的名字丢弃并 warn（同一个值只喊一次）。
  const warnings = [];
  installSubscriptionTargetLabels({
    nameToValue: new Map([
      ['词条', '1/a'],
      ['群2 · 词条', '2/b'],
    ]),
  });
  installSubscriptionTargetWarnings((message) => warnings.push(message));
  try {
    assert.deepEqual(resolveTarget('词条'), [{ kind: 'album', channelId: 'onebot:1', albumId: 'a' }]);
    assert.deepEqual(resolveTarget('群2 · 词条'), [{ kind: 'album', channelId: 'onebot:2', albumId: 'b' }]);
    assert.deepEqual(resolveTarget(' 词条 '), [{ kind: 'album', channelId: 'onebot:1', albumId: 'a' }], '两端空白不影响解析');
    assert.deepEqual(resolveTarget('没人叫这个名字'), [], '解析失败即拒绝');
    assert.deepEqual(resolveTarget('没人叫这个名字'), [], '重复解析仍然拒绝');
    assert.deepEqual(warnings, ['目标未绑定或相册已变更：没人叫这个名字，请在面板重新选择']);
  } finally {
    installSubscriptionTargetLabels();
    installSubscriptionTargetWarnings();
  }
});

test('SUBS-06a: 归一原样保留名字；投递期按唯一表解析，未命中丢弃并 warn', () => {
  const warnings = [];
  installSubscriptionTargetLabels({
    nameToValue: new Map([
      ['群1 · 词条', '1/a'],
      ['群/名 · 相册', '3/c'],
    ]),
  });
  installSubscriptionTargetWarnings((message) => warnings.push(message));
  try {
    const rows = normalizeSubscriptionRows([
      { source: '9', targets: ['群1 · 词条', '群/名 · 相册', '周报', '没人叫这个名字'], entry: true, weekly: false },
    ]);
    assert.deepEqual(
      rows[0].targets,
      ['群1 · 词条', '群/名 · 相册', '周报', '没人叫这个名字'],
      '归一不查表、不改写：值就是用户/面板写进去的那个',
    );
    const snapshot = compileSubscriptions(config({ subscriptions: rows }));
    assert.deepEqual(
      entryTargetsFor(snapshot, '9'),
      [
        { kind: 'album', channelId: 'onebot:1', albumId: 'a' },
        { kind: 'album', channelId: 'onebot:3', albumId: 'c' },
      ],
      '唯一命中的名字解析成相册；歧义/未知名丢弃',
    );
    assert.deepEqual(warnings, [
      '目标未绑定或相册已变更：周报，请在面板重新选择',
      '目标未绑定或相册已变更：没人叫这个名字，请在面板重新选择',
    ]);
    assert.equal(albumValueOfTarget('群1 · 词条'), '1/a', '周报上传 / 日志用同一张表拿地址');
    assert.equal(albumValueOfTarget('2/b'), '2/b', '旧稳定地址按形状直接认');
    assert.equal(albumValueOfTarget('周报'), undefined, '未登记名字没有地址');
  } finally {
    installSubscriptionTargetLabels();
    installSubscriptionTargetWarnings();
  }
});

test('SUBS-06b: 名字与旧稳定地址指向同一投递点；面板接受候选名字', () => {
  installSubscriptionTargetLabels({ nameToValue: new Map([['群1 · 词条', '123/A1']]) });
  try {
    const rows = normalizeSubscriptionRows([
      { source: '123', targets: ['群1 · 词条', '123/A1', '123/A1'], entry: true, weekly: false },
    ]);
    assert.deepEqual(rows[0].targets, ['群1 · 词条', '123/A1'], '归一只做去重，不把名字改写成地址');

    const snapshot = compileSubscriptions(config({ subscriptions: rows }));
    assert.deepEqual(
      entryTargetsFor(snapshot, '123'),
      [{ kind: 'album', channelId: 'onebot:123', albumId: 'A1' }],
      '名字与旧地址解析到同一个投递点 → 只投一次',
    );

    // 长名字也要先读得进来才谈得上匹配（`群名 · 相册名` 比稳定地址长得多）。
    const long = `${'群'.repeat(80)} · ${'册'.repeat(80)}`;
    installSubscriptionTargetLabels({ nameToValue: new Map([[long, '7/z']]) });
    const kept = normalizeSubscriptionRows([{ source: '123', targets: [long], entry: true, weekly: false }]);
    assert.deepEqual(kept[0].targets, [long], '长名字原样保留');
    assert.deepEqual(resolveTarget(long), [{ kind: 'album', channelId: 'onebot:7', albumId: 'z' }]);

    const allowed = new Set(['群1 · 词条', '123/A1']);
    const accepted = validateSubscriptionRows([row('123', ['群1 · 词条', '123/A1'])], allowed);
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.error);
    const unknown = validateSubscriptionRows([row('123', ['456/A9'])], allowed);
    assert.equal(unknown.ok, false, '目录里没有这条相册就不能静默投到不存在的地址');
    assert.match(unknown.error, /相册未在探测结果中/u);
    const bogusName = validateSubscriptionRows([row('123', ['不存在的相册'])], allowed);
    assert.equal(bogusName.ok, false, '下拉里没有的名字一律拒绝');
    assert.match(bogusName.error, /target 只能是/u);
  } finally {
    installSubscriptionTargetLabels();
  }
});

test('SUBS-07: 周报行独立于监听——今天不监听也能发历史主题', () => {
  const snapshot = compileSubscriptions(config({ subscriptions: [row('*', '303/A1', false, true)] }));
  assert.equal(snapshot.weekly.length, 1);
  assert.deepEqual(snapshot.weekly[0].targets, ['303/A1'], '周报行保留它自己的相册目标');
  assert.deepEqual(snapshot.topicGroups, null, '`*` 行不参与每日主题校准');
});

test('SUBS-08: 主题校准集合取具体来源群，去重且去平台前缀', () => {
  const snapshot = compileSubscriptions(
    config({
      subscriptions: [row('onebot:123', ''), row('123', ''), row('456', '', true, false)],
    }),
  );
  assert.deepEqual([...(snapshot.topicGroups ?? [])].sort(), ['123', '456']);
});

test('SUBS-09: resolveRows 丢弃空来源，并把非法行按「关」处理', () => {
  const rows = resolveRows(
    config({
      subscriptions: [
        { source: '  ', targets: ['456/A1'], entry: true, weekly: true },
        { source: ' 123 ', targets: [' 456/A1 ', '456/A1', ''], entry: undefined, weekly: 1 },
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { source: '123', targets: ['456/A1'], entry: false, weekly: false }, '空白 / 重复目标收敛');
});

test('SUBS-10: 脏数据不抛错——subscriptions 非数组时按空表处理', () => {
  const snapshot = compileSubscriptions(config({ subscriptions: null }));
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.listening, null);
});

test('SUBS-11: `@chat` 解析为来源群聊天；缺来源 / `*` 来源一律丢弃', () => {
  assert.deepEqual(resolveTarget('@chat', '123'), [{ kind: 'channel', channelId: 'onebot:123' }]);
  assert.deepEqual(resolveTarget('@chat', 'onebot:123'), [{ kind: 'channel', channelId: 'onebot:123' }]);
  assert.deepEqual(resolveTarget('@chat'), [], '没有来源就无从解析');
  assert.deepEqual(resolveTarget('@chat', '*'), [], '`*` 不是具体群');

  const snapshot = compileSubscriptions(config({ subscriptions: [row('123', ['@chat'])] }));
  assert.deepEqual(entryTargetsFor(snapshot, 'onebot:123'), [{ kind: 'channel', channelId: 'onebot:123' }]);
  assert.deepEqual(entryTargetsFor(snapshot, 'onebot:456'), [], '别的群不该收到这条投递');
});

test('SUBS-12: 多值目标合并去重——同一相册写两次只投一次', () => {
  const snapshot = compileSubscriptions(
    config({ subscriptions: [row('123', ['@chat', '123/A1', '123/A1', '456/A2', '@chat'])] }),
  );
  assert.deepEqual(entryTargetsFor(snapshot, '123'), [
    { kind: 'channel', channelId: 'onebot:123' },
    { kind: 'album', channelId: 'onebot:123', albumId: 'A1' },
    { kind: 'album', channelId: 'onebot:456', albumId: 'A2' },
  ]);
  // 非法目标照样留在表里，但不会变成投递点（不猜测、不广播）。
  const dirty = compileSubscriptions(config({ subscriptions: [row('123', ['abc', '123/', '123/A1'])] }));
  assert.deepEqual(entryTargetsFor(dirty, '123'), [{ kind: 'album', channelId: 'onebot:123', albumId: 'A1' }]);
  assert.deepEqual(resolveTargets(['123/A1', '123/A1', 'abc']), [
    { kind: 'album', channelId: 'onebot:123', albumId: 'A1' },
  ]);
});

test('SUBS-13: `*` 行的 `@chat` 非法（无具体来源）被丢弃，其余目标对所有群生效', () => {
  const snapshot = compileSubscriptions(config({ subscriptions: [row('*', ['@chat', '456/A1'])] }));
  assert.equal(snapshot.listening, null, '`*` 行监听全部群');
  assert.deepEqual(snapshot.entryTargetsAll, [{ kind: 'album', channelId: 'onebot:456', albumId: 'A1' }]);
  assert.deepEqual(entryTargetsFor(snapshot, 'onebot:789'), [
    { kind: 'album', channelId: 'onebot:456', albumId: 'A1' },
  ]);
  assert.deepEqual(resolveTargets(['@chat'], '*'), [], '`*` 来源解析 `@chat` 必须为空');
});

test('SUBS-14: 历史单值 `target` 归一成 targets，且「目标 = 来源群」等价写成 @chat', () => {
  const rows = normalizeSubscriptionRows([
    legacyRow('123', '456/A1'),
    legacyRow('111', '111'),
    legacyRow('222', 'onebot:222'),
    { source: '333' },
  ]);
  assert.deepEqual(rows, [
    { source: '123', targets: ['456/A1'], entry: true, weekly: false },
    { source: '111', targets: ['@chat'], entry: true, weekly: false },
    { source: '222', targets: ['@chat'], entry: true, weekly: false },
    { source: '333', targets: [], entry: false, weekly: false },
  ]);
  // 兼容读入后编译等价于新写法
  const legacy = compileSubscriptions(config({ subscriptions: [legacyRow('123', '123', true, false)] }));
  assert.deepEqual(entryTargetsFor(legacy, '123'), [{ kind: 'channel', channelId: 'onebot:123' }]);
});

test('SUBS-15: validateSubscriptionRows 的值域、去重与上限', () => {
  const albums = new Set(['123/A1']);
  const ok = validateSubscriptionRows(
    [
      { source: 'onebot:123', targets: ['@chat', '123/A1', '123/A1'], entry: true, weekly: false },
      { source: '*', targets: [], entry: false, weekly: true },
    ],
    albums,
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rows, [
    { source: '123', targets: ['@chat', '123/A1'], entry: true, weekly: false },
    { source: '*', targets: [], entry: false, weekly: true },
  ]);

  const reject = (rows, pattern) => {
    const result = validateSubscriptionRows(rows, albums);
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
  };
  reject(null, /数组/u);
  reject([{ source: '', targets: [], entry: true, weekly: false }], /source 不能为空/u);
  reject([{ source: 'abc', targets: [], entry: true, weekly: false }], /source 必须是群号/u);
  reject([{ source: '123', targets: ['456'], entry: true, weekly: false }], /target 只能是/u);
  reject([{ source: '123', targets: ['456/A9'], entry: true, weekly: false }], /未在探测结果中/u);
  reject([{ source: '123', targets: ['不存在的相册'], entry: true, weekly: false }], /target 只能是/u);
  reject([{ source: '123', targets: [''], entry: true, weekly: false }], /target 不能为空/u);
  reject([{ source: '123', targets: ['@chat'], entry: 'yes', weekly: false }], /entry 必须是布尔值/u);
  reject([{ source: '123', targets: ['@chat'], entry: true, weekly: 1 }], /weekly 必须是布尔值/u);
  reject([{ source: '123', targets: [], entry: true, weekly: false }, 'x'], /第 2 行必须是对象/u);
  reject(
    [{ source: '123', targets: ['@chat'], entry: true, weekly: false }, { source: '123', targets: '123/A1', entry: true, weekly: false }],
    /targets 必须是数组/u,
  );
  reject([{ source: '123', targets: Array.from({ length: 17 }, (_, i) => `123/A${i}`), entry: true, weekly: false }], /目标最多 16 个/u);
  reject([{ source: '123', targets: ['#group:1'], entry: true, weekly: false }], /分组标题/u);
  reject(Array.from({ length: 257 }, () => ({ source: '123', targets: [], entry: true, weekly: false })), /最多 256 行/u);

  // 候选唯一名与现有值都在白名单里：名字是面板写出的形态，旧地址只为原样保存。
  const withNames = validateSubscriptionRows(
    [row('123', ['词条', '123/A1'])],
    new Set(['词条', '123/A1']),
  );
  assert.equal(withNames.ok, true, withNames.ok ? '' : withNames.error);

  // 目录为空（探测不可用）时只做形状校验，否则面板在掉线时连 @chat 都存不下去。
  const offline = validateSubscriptionRows([{ source: '123', targets: ['456/A9'], entry: true, weekly: false }], new Set());
  assert.equal(offline.ok, true);
});

test('SUBS-16: 订阅日志——多目标（相册名（群号））、无目标、`*` 三种形状', () => {
  installSubscriptionTargetLabels({
    valueToName: new Map([['100000001/ALBUM01', '【每周更新】群聊话题汇总（100000001）']]),
  });
  try {
    assert.deepEqual(
      formatSubscriptionLogLines([
        row('100000001', ['@chat', '100000001/ALBUM01'], true, true),
        row('100000004', [], true, false),
        row('*', [], false, false),
      ]),
      [
        '[Patchouli] 订阅 100000001 → 本群聊天 + 【每周更新】群聊话题汇总（100000001）（词条、周报）',
        '[Patchouli] 订阅 100000004 → 无投递（词条）',
        '[Patchouli] 订阅 *（全部群） → 无投递（仅沉淀）',
      ],
    );
  } finally {
    installSubscriptionTargetLabels();
  }
});

test('SUBS-17: 订阅日志——目标显示「相册名（群号）」，缺映射回退稳定值，分组标题不显示', () => {
  // 没有展示表：认得成相册但没有可读名 → 回退稳定值，不谎报、不猜目标。
  installSubscriptionTargetLabels();
  assert.deepEqual(formatSubscriptionLogLines([row('123', ['1/ALBUM01'], false, true)]), [
    '[Patchouli] 订阅 123 → 1/ALBUM01（周报）',
  ]);
  // 不是相册形状的脏值原样展示：日志只做展示，不猜目标。
  assert.deepEqual(formatSubscriptionLogLines([row('123', ['456'], true, false)]), [
    '[Patchouli] 订阅 123 → 456（词条）',
  ]);

  // 装上展示表 → `相册名（群号）`；分组标题（`#group:`）不是目标，一行只剩它时算「无投递」。
  installSubscriptionTargetLabels({ valueToName: new Map([['1/ALBUM01', '周报（1）']]) });
  try {
    assert.deepEqual(formatSubscriptionLogLines([row('123', ['1/ALBUM01', '#group:1'], false, true)]), [
      '[Patchouli] 订阅 123 → 周报（1）（周报）',
    ]);
    assert.deepEqual(formatSubscriptionLogLines([row('123', ['#group:1'], true, false)]), [
      '[Patchouli] 订阅 123 → 无投递（词条）',
    ]);

    // 存的是唯一可读名：日志先解析成地址再取文案，解析不了的名字原样回显（便于对照配置）。
    installSubscriptionTargetLabels({
      nameToValue: new Map([['周报', '1/ALBUM01']]),
      valueToName: new Map([['1/ALBUM01', '周报（1）']]),
    });
    assert.deepEqual(formatSubscriptionLogLines([row('123', ['周报'], false, true)]), [
      '[Patchouli] 订阅 123 → 周报（1）（周报）',
    ]);
    assert.deepEqual(formatSubscriptionLogLines([row('123', ['已改名的相册'], false, true)]), [
      '[Patchouli] 订阅 123 → 已改名的相册（周报）',
    ]);
  } finally {
    installSubscriptionTargetLabels();
  }
});

test('SUBS-19: 名字解析——歧义不登记、@chat 恒为保留值、`#group:` 丢弃', () => {
  const warnings = [];
  installSubscriptionTargetLabels({
    nameToValue: new Map([
      // 两个群都有「周报」：裸名字不登记（歧义 = 解析失败），只有带限定的名字可用。
      ['群3 · 周报', '3/c'],
      // 相册名撞上保留值时，下拉会分配 `群4 · @chat` 这种限定名。
      ['群4 · @chat', '4/d'],
    ]),
  });
  installSubscriptionTargetWarnings((message) => warnings.push(message));
  try {
    const rows = normalizeSubscriptionRows([
      { source: '100', targets: ['周报', '群3 · 周报', '@chat', '#group:3', '早上好'], entry: true, weekly: false },
    ]);
    assert.deepEqual(
      rows[0].targets,
      ['周报', '群3 · 周报', '@chat', '早上好'],
      '归一原样保留（分组标题丢弃）；名字不在这里换算',
    );
    const snapshot = compileSubscriptions(config({ subscriptions: rows }));
    assert.deepEqual(entryTargetsFor(snapshot, '100'), [
      { kind: 'album', channelId: 'onebot:3', albumId: 'c' },
      { kind: 'channel', channelId: 'onebot:100' },
    ], '歧义 / 未登记的名字丢弃，@chat 照常投到来源群');
    assert.deepEqual(warnings, [
      '目标未绑定或相册已变更：周报，请在面板重新选择',
      '目标未绑定或相册已变更：早上好，请在面板重新选择',
    ]);

    // 保留值优先：`@chat` 永远只按该行来源群解析，不会被同名相册截走。
    assert.deepEqual(resolveTarget('@chat', '100'), [{ kind: 'channel', channelId: 'onebot:100' }]);
    assert.deepEqual(resolveTarget('群4 · @chat'), [{ kind: 'album', channelId: 'onebot:4', albumId: 'd' }]);
  } finally {
    installSubscriptionTargetLabels();
    installSubscriptionTargetWarnings();
  }
});

test('SUBS-18: 订阅日志——默认最多 20 行，超出补「另有 N 行」', () => {
  const rows = Array.from({ length: 23 }, (_, index) => row(String(100 + index), [], true, false));
  const lines = formatSubscriptionLogLines(rows);
  assert.equal(lines.length, 21, '20 条正文 + 1 条汇总');
  assert.equal(lines[0], '[Patchouli] 订阅 100 → 无投递（词条）');
  assert.equal(lines.at(-1), '… 另有 3 行');

  const tight = formatSubscriptionLogLines(rows, 2);
  assert.deepEqual(tight, [
    '[Patchouli] 订阅 100 → 无投递（词条）',
    '[Patchouli] 订阅 101 → 无投递（词条）',
    '… 另有 21 行',
  ]);
  assert.deepEqual(formatSubscriptionLogLines([], 2), [], '空表不产出任何日志行');
});

test('SUBS-20: 旧 `target` 形态——单值 / 字符串数组都保留，显式 `targets: []` 不复活', () => {
  // 早期版本写过 `target: ['1/a','2/b']`：数组元素一个都不能丢。
  assert.deepEqual(
    normalizeSubscriptionRows([{ source: '123', target: ['456/A1', '789/A2'], entry: true, weekly: true }]),
    [{ source: '123', targets: ['456/A1', '789/A2'], entry: true, weekly: true }],
    '字符串数组的每个元素都是目标',
  );
  // 脏数组：非字符串 / 空白 / 重复项按原有规则收敛。
  assert.deepEqual(
    normalizeSubscriptionRows([{ source: '123', target: ['456/A1', ' 456/A1 ', '  ', 42], entry: true, weekly: false }]),
    [{ source: '123', targets: ['456/A1'], entry: true, weekly: false }],
  );
  // `targets` 键存在即权威：显式 [] 是「我清空了收件人」，旧 target 绝不能被复活。
  assert.deepEqual(
    normalizeSubscriptionRows([{ source: '123', targets: [], target: '456/A1', entry: true, weekly: false }]),
    [{ source: '123', targets: [], entry: true, weekly: false }],
  );
  // `targets` 缺失才用旧 target 回填。
  assert.deepEqual(
    normalizeSubscriptionRows([{ source: '123', target: '456/A1', entry: true, weekly: false }]),
    [{ source: '123', targets: ['456/A1'], entry: true, weekly: false }],
  );
});

test('SUBS-21: 旧形态投影——字符串数组展开成多行，`targets` 键存在时原样放行', () => {
  assert.deepEqual(
    projectLegacySubscriptionRows([
      { source: '123', target: ['1/a', '2/b'], entry: true, weekly: true },
    ]),
    [
      { source: '123', target: '1/a', entry: true, weekly: true },
      { source: '123', target: '2/b', entry: true, weekly: true },
    ],
    '每个元素一行，source / entry / weekly 原样复制',
  );
  // 单值 / 空数组 / 非字符串元素：不展开，整行交给归一阶段。
  const stringRow = { source: '123', target: '1/a' };
  assert.deepEqual(projectLegacySubscriptionRows([stringRow]), [stringRow]);
  const emptyRow = { source: '123', target: [] };
  assert.deepEqual(projectLegacySubscriptionRows([emptyRow]), [emptyRow], '空数组不吞掉这一行的监听范围');
  const dirtyRow = { source: '123', target: [42, null] };
  assert.deepEqual(projectLegacySubscriptionRows([dirtyRow]), [dirtyRow], '非字符串元素不产生空行');
  // `targets` 存在（含 []）：绝不看旧 target。
  for (const targets of [[], ['3/c']]) {
    const row = { source: '123', targets, target: ['1/a'] };
    assert.deepEqual(projectLegacySubscriptionRows([row]), [row]);
  }
  // 非数组整体输入不炸。
  assert.deepEqual(projectLegacySubscriptionRows(undefined), []);
});

test('SUBS-22: 旧后缀形态与唯一名表——只登记唯一匹配，歧义名字解析失败', () => {
  const albums = [
    { groupId: '1', groupName: '示例群一', albumId: 'a', albumName: '词条' },
    { groupId: '2', groupName: '示例群二', albumId: 'b', albumName: '周报' },
    { groupId: '3', groupName: '示例群三', albumId: 'c1', albumName: '重名' },
    { groupId: '3', groupName: '示例群三', albumId: 'c2', albumName: '重名' },
    { groupId: '4', groupName: '同名群', albumId: 'd', albumName: '跨群' },
    { groupId: '5', groupName: '同名群', albumId: 'e', albumName: '跨群' },
  ];
  const index = buildLegacyTargetIndex(albums);
  assert.deepEqual(index.get('词条（示例群一）'), ['1/a'], '`相册名（群名）` 唯一匹配');
  assert.deepEqual(index.get('词条（1）'), ['1/a'], '`相册名（群号）` 唯一匹配');
  assert.deepEqual(index.get('重名（3）'), ['3/c1', '3/c2'], '同群同名 = 歧义（两个候选）');
  assert.deepEqual(index.get('跨群（同名群）'), ['4/d', '5/e'], '跨群同名 = 歧义');

  const names = buildTargetNameIndex(albums);
  assert.equal(names.get('词条（示例群一）'), '1/a', '旧后缀形态的唯一别名并进解析表');
  assert.equal(names.get('周报（2）'), '2/b');
  assert.equal(names.get('重名（3）'), undefined, '歧义名字不进表');
  assert.equal(names.get('词条（示例群二）'), undefined, '对不上的名字不进表');
  assert.equal(names.get('词条'), '1/a', '本批唯一的相册名直接可用');
  assert.equal(names.get('重名'), undefined, '同批重名的裸名字不分配');

  const warnings = [];
  installSubscriptionTargetLabels({ nameToValue: names });
  installSubscriptionTargetWarnings((message) => warnings.push(message));
  try {
    const rows = normalizeSubscriptionRows([
      { source: '100', targets: ['词条（示例群一）', '周报（2）', '重名（3）', '词条（示例群二）'], entry: true, weekly: false },
    ]);
    assert.deepEqual(rows[0].targets, ['词条（示例群一）', '周报（2）', '重名（3）', '词条（示例群二）'], '归一原样保留');
    const snapshot = compileSubscriptions(config({ subscriptions: rows }));
    assert.deepEqual(entryTargetsFor(snapshot, '100'), [
      { kind: 'album', channelId: 'onebot:1', albumId: 'a' },
      { kind: 'album', channelId: 'onebot:2', albumId: 'b' },
    ], '唯一匹配的旧名解析成相册；歧义与无匹配丢弃');
    assert.deepEqual(warnings, [
      '目标未绑定或相册已变更：重名（3），请在面板重新选择',
      '目标未绑定或相册已变更：词条（示例群二），请在面板重新选择',
    ]);
  } finally {
    installSubscriptionTargetLabels();
    installSubscriptionTargetWarnings();
  }
});
