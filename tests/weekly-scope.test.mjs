import test from 'node:test';
import assert from 'node:assert/strict';

import {
  albumSchemaUnion,
  planWeeklyAlbumSources,
  runWeeklyAlbumDelivery,
  WEEKLY_TOPIC_LIMIT,
} from '../lib/index.js';
import {
  albumValueOfTarget,
  compileSubscriptions,
  installSubscriptionTargetLabels,
} from '../lib/plugin/subscriptions.js';

const WEEK_MS = 7 * 86_400_000;
const NOW = Date.UTC(2026, 10, 24, 4, 30);
const SINCE = NOW - WEEK_MS;
const WEEK_KEY = '2026-W48';
const FIRE_KEY = '29456789';

/** 最小配置：只带订阅编译需要的字段。 */
function config(overrides = {}) {
  return {
    channels: [],
    albumDelivery: { cron: '30 4 * * 1', albums: [], entryEnabled: true, entryRedirectChannelId: '' },
    subscriptions: [],
    ...overrides,
  };
}

function row(source, targets, weekly = true, entry = false) {
  return { source, targets: Array.isArray(targets) ? targets : [targets], entry, weekly };
}

/** 主题记录：`channelId` 是聚合时写入的来源群（周报取材的唯一判据）。 */
function topic(id, channelId, title, updatedAt = NOW) {
  return { id, channelId, title, kind: 'topic', updatedAt, participants: [], path: `${id}.md` };
}

/** 内存版 LocalStore：`getRecentEntries(channelId?, limit)` 同语义（按频道过滤 + 截断）。 */
function store(records) {
  return async (channelId, limit) => {
    const matched = records.filter((record) => channelId === undefined || record.channelId === channelId);
    return matched
      .slice()
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, Math.max(0, limit));
  };
}

function harness(options) {
  const renders = [];
  const deliveries = [];
  const logs = [];
  const logger = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
  };
  const deps = {
    weekKey: WEEK_KEY,
    fireKey: FIRE_KEY,
    since: SINCE,
    snapshot: options.snapshot,
    fallbackAlbums: options.fallbackAlbums ?? [],
    logger,
    recentEntries: store(options.records),
    buildView: async (record) => ({ id: record.id, title: record.title }),
    render: async (views, weekKey) => {
      renders.push({ titles: views.map((view) => view.title), weekKey });
      return Buffer.from(`png:${views.map((view) => view.id).join(',')}`);
    },
    deliver: async (album, png, dedupeKey) => {
      deliveries.push({ album, dedupeKey, png: png.toString() });
      return { ok: true };
    },
    ...options.deps,
  };
  return { deps, renders, deliveries, logs };
}

const GROUP_A = { channelId: '111', album: '111/album-a' };
const GROUP_B = { channelId: '222', album: '222/album-b' };

test('WEEKLY-SCOPE-01: 只有 A 群开周报时只取材/投递 A 的主题', async () => {
  const records = [
    topic('topic-a', GROUP_A.channelId, 'A 群的主题'),
    topic('topic-b', GROUP_B.channelId, 'B 群的主题'),
  ];
  const snapshot = compileSubscriptions(config({ subscriptions: [row(GROUP_A.channelId, GROUP_A.album)] }));
  const { deps, renders, deliveries } = harness({ snapshot, records });

  const result = await runWeeklyAlbumDelivery(deps);

  assert.equal(result.ok, true);
  assert.equal(result.uploaded, 1);
  assert.equal(renders.length, 1, '每个来源渲染一次');
  assert.deepEqual(renders[0].titles, ['A 群的主题'], 'B 群的主题不该进 A 的周报卡');
  assert.equal(renders[0].weekKey, WEEK_KEY);
  assert.deepEqual(deliveries.map((item) => item.album), [GROUP_A.album]);
  assert.equal(deliveries[0].dedupeKey, `${FIRE_KEY}:${GROUP_A.channelId}:${GROUP_A.album}`);
});

test('WEEKLY-SCOPE-02: `*` 行取全库主题，投到它自己的相册', async () => {
  const records = [
    topic('topic-a', GROUP_A.channelId, 'A 群的主题'),
    topic('topic-b', GROUP_B.channelId, 'B 群的主题'),
  ];
  const snapshot = compileSubscriptions(config({ subscriptions: [row('*', '333/album-all')] }));
  const { deps, renders, deliveries } = harness({ snapshot, records });

  const result = await runWeeklyAlbumDelivery(deps);

  assert.equal(result.uploaded, 1);
  assert.equal(renders.length, 1);
  assert.deepEqual(renders[0].titles.sort(), ['A 群的主题', 'B 群的主题']);
  assert.deepEqual(deliveries.map((item) => item.album), ['333/album-all']);
});

test('WEEKLY-SCOPE-03: 订阅表为空时保持旧行为——全库主题投旧相册列表', async () => {
  const records = [
    topic('topic-a', GROUP_A.channelId, 'A 群的主题'),
    topic('topic-b', GROUP_B.channelId, 'B 群的主题'),
  ];
  const snapshot = compileSubscriptions(config());
  assert.equal(snapshot.active, false);
  const { deps, renders, deliveries } = harness({
    snapshot,
    records,
    fallbackAlbums: ['444/album-old', 'not-an-album'],
  });

  const result = await runWeeklyAlbumDelivery(deps);

  assert.equal(result.uploaded, 1);
  assert.deepEqual(renders[0].titles.sort(), ['A 群的主题', 'B 群的主题'], '旧口径是全库周报');
  assert.deepEqual(deliveries.map((item) => item.album), ['444/album-old'], '非相册形状的旧值被丢弃');
  assert.equal(deliveries[0].dedupeKey, `${FIRE_KEY}:*:444/album-old`);
});

test('WEEKLY-SCOPE-04: 同一来源多行目标——一张图、多目标投递', async () => {
  const records = [topic('topic-a', GROUP_A.channelId, 'A 群的主题')];
  const snapshot = compileSubscriptions(
    config({ subscriptions: [row(GROUP_A.channelId, GROUP_A.album), row(GROUP_A.channelId, '111/album-a2')] }),
  );
  const { deps, renders, deliveries } = harness({ snapshot, records });

  const result = await runWeeklyAlbumDelivery(deps);

  assert.equal(result.uploaded, 2);
  assert.equal(renders.length, 1, '同一主题集合只渲染一次');
  assert.deepEqual(deliveries.map((item) => item.album), ['111/album-a', '111/album-a2']);
  assert.deepEqual(
    deliveries.map((item) => item.dedupeKey),
    [`${FIRE_KEY}:111:111/album-a`, `${FIRE_KEY}:111:111/album-a2`],
    '去重键必须带来源，跨来源同相册不会互吞',
  );
});

test('WEEKLY-SCOPE-05: 两个来源各自取材，互不串主题', async () => {
  const records = [
    topic('topic-a', GROUP_A.channelId, 'A 群的主题'),
    topic('topic-b', GROUP_B.channelId, 'B 群的主题'),
  ];
  const snapshot = compileSubscriptions(
    config({ subscriptions: [row(GROUP_A.channelId, GROUP_A.album), row(GROUP_B.channelId, GROUP_B.album)] }),
  );
  const { deps, renders, deliveries } = harness({ snapshot, records });

  const result = await runWeeklyAlbumDelivery(deps);

  assert.equal(result.uploaded, 2);
  assert.equal(renders.length, 2, '两个来源主题集合不同，各渲染一次');
  assert.deepEqual(renders.map((item) => item.titles), [['A 群的主题'], ['B 群的主题']]);
  assert.deepEqual(deliveries.map((item) => item.album), [GROUP_A.album, GROUP_B.album]);
});

test('WEEKLY-SCOPE-06: 来源没主题时记 info 且不渲染、不投递', async () => {
  const records = [topic('topic-a', GROUP_A.channelId, 'A 群的主题')];
  const snapshot = compileSubscriptions(
    config({ subscriptions: [row(GROUP_A.channelId, GROUP_A.album), row(GROUP_B.channelId, GROUP_B.album)] }),
  );
  const { deps, renders, deliveries, logs } = harness({ snapshot, records });

  const result = await runWeeklyAlbumDelivery(deps);

  assert.equal(result.uploaded, 1);
  assert.equal(renders.length, 1);
  assert.deepEqual(deliveries.map((item) => item.album), [GROUP_A.album]);
  assert.ok(
    logs.some(([level, message]) => level === 'info' && message.includes('来源 222') && message.includes('没有新主题')),
    '空来源要留下可读 info',
  );
  assert.ok(
    logs.some(([level, message]) => level === 'info' && /来源 111：1 个主题 → 投递 1 个目标/u.test(message)),
    '每个来源一行「N 个主题 → M 个目标」',
  );
});

test('WEEKLY-SCOPE-07: 周报行没有相册目标时不算配置成功', async () => {
  const records = [topic('topic-a', GROUP_A.channelId, 'A 群的主题')];
  const snapshot = compileSubscriptions(config({ subscriptions: [row(GROUP_A.channelId, '@chat')] }));
  assert.deepEqual(planWeeklyAlbumSources(snapshot, []), [], '`@chat` 不是相册');
  const { deps, renders } = harness({ snapshot, records });

  const result = await runWeeklyAlbumDelivery(deps);

  assert.deepEqual(result, { ok: false, reason: 'album-not-configured', uploaded: 0 });
  assert.equal(renders.length, 0);
});

test('WEEKLY-SCOPE-07a: 相册取名 @chat——候选里改名，周报行只勾 @chat 时上传数为 0', async () => {
  // 候选里有一个相册就叫 `@chat`：它必须被改名成「群名 · @chat」，不占用保留值。
  const albums = [
    { groupId: GROUP_A.channelId, groupName: '图书室', albumId: 'ALBUM01', albumName: '@chat' },
  ];
  const values = albumSchemaUnion(albums, [], { targets: true }).list.map((item) => item.value);
  assert.equal(values[0], '@chat', '保留值仍在首位');
  assert.equal(values.includes('图书室 · @chat'), true, '相册被改名成「群名 · @chat」');
  assert.equal(values.filter((value) => value === '@chat').length, 1, '相册不占用保留值（@chat 只有一项）');

  // 即便绑定表被塞进 `@chat` 键（落盘清洗会丢，这里模拟更坏的运行态），解析层也把
  // 保留值挡在相册之外：周报行只勾了本群聊天时，绝不能变成「上传到某个相册」。
  installSubscriptionTargetLabels({
    nameToValue: new Map([
      ['@chat', `${GROUP_A.channelId}/ALBUM01`],
      [`#group:${GROUP_A.channelId}`, `${GROUP_A.channelId}/ALBUM01`],
    ]),
  });
  try {
    assert.equal(albumValueOfTarget('@chat'), undefined, '`@chat` 永远拿不到相册地址');
    assert.equal(albumValueOfTarget(`#group:${GROUP_A.channelId}`), undefined, '分组标题也不是相册');
    const snapshot = compileSubscriptions(config({ subscriptions: [row(GROUP_A.channelId, '@chat')] }));
    assert.deepEqual(planWeeklyAlbumSources(snapshot, []), [], '周报没有相册目标');
    const { deps, renders } = harness({
      snapshot,
      records: [topic('topic-a', GROUP_A.channelId, 'A 群的主题')],
    });

    const result = await runWeeklyAlbumDelivery(deps);

    assert.deepEqual(result, { ok: false, reason: 'album-not-configured', uploaded: 0 });
    assert.equal(renders.length, 0, '没有相册目标就不渲染卡片');
  } finally {
    installSubscriptionTargetLabels();
  }
});

test('WEEKLY-SCOPE-08: 过期主题不参与取材，全部过期时报 no-topics', async () => {
  const records = [topic('topic-old', GROUP_A.channelId, '旧主题', SINCE - 1)];
  const snapshot = compileSubscriptions(config({ subscriptions: [row(GROUP_A.channelId, GROUP_A.album)] }));
  const { deps, renders, deliveries } = harness({ snapshot, records });

  const result = await runWeeklyAlbumDelivery(deps);

  assert.deepEqual(result, { ok: true, reason: 'no-topics', uploaded: 0 });
  assert.equal(renders.length, 0);
  assert.equal(deliveries.length, 0);
});

test('WEEKLY-SCOPE-09: 取材上限沿用 500 条', async () => {
  const seen = [];
  const snapshot = compileSubscriptions(config({ subscriptions: [row(GROUP_A.channelId, GROUP_A.album)] }));
  const { deps } = harness({
    snapshot,
    records: [topic('topic-a', GROUP_A.channelId, 'A 群的主题')],
    deps: {
      recentEntries: async (channelId, limit) => {
        seen.push([channelId, limit]);
        return [];
      },
    },
  });

  await runWeeklyAlbumDelivery(deps);

  assert.deepEqual(seen, [[GROUP_A.channelId, WEEKLY_TOPIC_LIMIT]]);
});
