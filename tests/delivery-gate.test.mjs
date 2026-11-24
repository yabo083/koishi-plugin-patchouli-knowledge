/**
 * 定时投递闸门（`docs/delivery-schedule.md` §8，SCHED-01..17）。
 *
 * 时钟与定时器都是注入的：断言落在「取出哪几条 / 什么时候唤醒 / 一次广播发几条」，
 * 不依赖真实 `setTimeout`，也不依赖宿主时区（时间戳一律用 `+08:00` 明确写出）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DeliveryGate, MAX_BATCH_ITEMS } from '../lib/plugin/delivery-gate.js';
import { MAX_QUEUE_ITEMS, DeliveryStateStore } from '../lib/plugin/delivery-state.js';

/** 上海时刻 → epoch ms（显式偏移，避免依赖进程 TZ）。 */
const sh = (text) => Date.parse(`${text}+08:00`);

const PNG = (tag) => Buffer.from(`png:${tag}`);

const ALBUM_A = '100000001/ALBUM01';
const ALBUM_B = '100000001/ALBUM02';
const ALBUM_C = '100000001/ALBUM03';

const albumTarget = (albumId, groupId = '100000001') => ({
  kind: 'album',
  channelId: `onebot:${groupId}`,
  albumId,
});

const albumPlan = (targetKey) => {
  const [groupId, albumId] = targetKey.split('/');
  return { targetKey, target: albumTarget(albumId, groupId) };
};

const chatPlan = (source = '100000001') => ({
  targetKey: `@chat:${source}`,
  target: { kind: 'channel', channelId: `onebot:${source}` },
});

function makeLogger() {
  const warnings = [];
  const infos = [];
  return { warnings, infos, warn: (message) => warnings.push(message), info: (message) => infos.push(message) };
}

const okOutcomes = (deliveries) =>
  deliveries.map(() => ({ ok: true, attempts: 1, messageId: `m${Math.random().toString(16).slice(2)}` }));

async function makeHarness(options = {}) {
  const dir = options.dir ?? (await mkdtemp(path.join(tmpdir(), 'patchouli-gate-')));
  const statePath = path.join(dir, 'delivery-state.json');
  const logger = makeLogger();
  const policies = { ...(options.policies ?? {}) };
  let now = options.now ?? sh('2026-11-24T22:30:00');
  const timers = new Map();
  let timerSeq = 0;
  const calls = [];
  const renderCalls = [];
  const gate = new DeliveryGate({
    store: new DeliveryStateStore({ path: statePath, logger }),
    policies: async () => policies,
    render:
      options.render ??
      (async (item) => {
        renderCalls.push(item.eventKey);
        return PNG(item.eventKey);
      }),
    deliver: async (deliveries) => {
      calls.push(deliveries);
      if (options.broadcast !== undefined) return options.broadcast(deliveries, calls.length);
      const outcomes = okOutcomes(deliveries);
      return { ok: true, delivered: deliveries.length, total: deliveries.length, outcomes };
    },
    logger,
    now: () => now,
    random: options.random ?? (() => 0.5),
    setTimer: (callback, delayMs) => {
      timerSeq += 1;
      timers.set(timerSeq, { callback, delayMs, cleared: false });
      return timerSeq;
    },
    clearTimer: (handle) => {
      const timer = timers.get(handle);
      if (timer !== undefined) timer.cleared = true;
    },
  });
  await gate.start();
  return {
    gate,
    dir,
    statePath,
    logger,
    policies,
    calls,
    renderCalls,
    timers,
    readState: async () => JSON.parse(await readFile(statePath, 'utf8')),
    advance: (to) => {
      now = to;
    },
    now: () => now,
    disposeDir: () => rm(dir, { recursive: true, force: true }),
  };
}

function offerEvent(harness, event) {
  return harness.gate.offer({
    kind: 'entry',
    source: '100000001',
    png: PNG(event.eventKey),
    ...event,
  });
}

test('SCHED-01: 无策略时直通——入队即可投，一次广播一条，队列清空', async () => {
  const harness = await makeHarness();
  try {
    const at = harness.now();
    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    assert.equal(harness.gate.snapshot().queue.length, 1);

    const result = await harness.gate.drain(at);

    assert.equal(result.skipped, false);
    assert.equal(result.deliveries, 1);
    assert.equal(result.delivered, 1);
    assert.equal(harness.calls.length, 1, '一批只调一次批量外发');
    assert.equal(harness.gate.snapshot().queue.length, 0, '投递成功必须出队');
    assert.deepEqual(harness.gate.snapshot().counters, {}, '无策略不记账');
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-02: 窗口内立即投递，不排队', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-24T22:30:00'),
    policies: { [ALBUM_A]: { window: '* 22:00-23:30', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
  try {
    const at = harness.now();
    const offer = await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    assert.equal(offer.accepted, 1);
    assert.equal(offer.deferred, 0, '窗口内不该延后');
    assert.equal(harness.gate.snapshot().queue[0].deliverAt, at);

    const result = await harness.gate.drain(at);
    assert.equal(result.delivered, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-03: 窗口外排队，到窗口首刻才投', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-24T09:00:00'),
    policies: { [ALBUM_A]: { window: '* 22:00-23:30', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
  try {
    const offer = await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    assert.equal(offer.accepted, 1);
    assert.equal(offer.deferred, 1);
    assert.equal(harness.gate.snapshot().queue.length, 1);
    assert.equal(harness.gate.nextWakeAt(), sh('2026-11-24T22:00:00'));

    const early = await harness.gate.drain(sh('2026-11-24T09:05:00'));
    assert.equal(early.skipped, true);
    assert.equal(harness.calls.length, 0, '窗口前一条都不许发');

    const ontime = await harness.gate.drain(sh('2026-11-24T22:00:00'));
    assert.equal(ontime.delivered, 1);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-04: 跨午夜窗口的 01:30 属开始日——立即投递', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-25T01:30:00'),
    policies: { [ALBUM_A]: { window: '22:00-02:00', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
  try {
    const at = harness.now();
    const offer = await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    assert.equal(offer.deferred, 0, '01:30 落在昨晚 22:00 开始的窗口里');
    assert.equal(harness.gate.snapshot().queue[0].deliverAt, at);

    const result = await harness.gate.drain(at);
    assert.equal(result.delivered, 1);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-05: 每目标独立——A 满额丢弃，B 照常投递', async () => {
  const harness = await makeHarness({
    policies: { [ALBUM_A]: { window: '', entryPerDay: 1, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
  try {
    const at = harness.now();
    const planA = albumPlan(ALBUM_A);
    const planB = albumPlan(ALBUM_B);

    await offerEvent(harness, { eventKey: 'entry-1', targets: [planA, planB] });
    const second = await offerEvent(harness, { eventKey: 'entry-2', targets: [planA, planB] });

    assert.equal(second.accepted, 1, '只有 B 还有额度');
    assert.equal(second.dropped, 1, 'A 当天已满 1 条');
    assert.ok(harness.logger.warnings.some((line) => line.includes(ALBUM_A) && line.includes('额度已用尽')));

    const result = await harness.gate.drain(at);
    assert.equal(result.delivered, 3, 'B 收两条、A 收一条');
    const targets = harness.calls[0].map((delivery) => delivery.target.albumId);
    assert.deepEqual(targets.sort(), ['ALBUM01', 'ALBUM02', 'ALBUM02']);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-06: 每目标每日限量——第 3 条丢弃并告警', async () => {
  const harness = await makeHarness({
    policies: { [ALBUM_A]: { window: '', entryPerDay: 2, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
  try {
    for (const eventKey of ['entry-1', 'entry-2']) {
      const offer = await offerEvent(harness, { eventKey, targets: [albumPlan(ALBUM_A)] });
      assert.equal(offer.accepted, 1);
    }
    const third = await offerEvent(harness, { eventKey: 'entry-3', targets: [albumPlan(ALBUM_A)] });
    assert.equal(third.accepted, 0);
    assert.equal(third.dropped, 1);
    assert.equal(harness.gate.snapshot().queue.length, 2, '被丢弃的事件不占队列');
    assert.ok(harness.logger.warnings.some((line) => line.includes('2/2')));
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-07: 同一事件投 3 个目标，各扣各自额度一次（不倍增）', async () => {
  const harness = await makeHarness({
    policies: {
      [ALBUM_A]: { window: '', entryPerDay: 5, weeklyPerWeek: 0, jitterMinutes: 0 },
      [ALBUM_B]: { window: '', entryPerDay: 5, weeklyPerWeek: 0, jitterMinutes: 0 },
      [ALBUM_C]: { window: '', entryPerDay: 5, weeklyPerWeek: 0, jitterMinutes: 0 },
    },
  });
  try {
    const at = harness.now();
    const offer = await offerEvent(harness, {
      eventKey: 'entry-1',
      targets: [albumPlan(ALBUM_A), albumPlan(ALBUM_B), albumPlan(ALBUM_C)],
    });
    assert.equal(offer.accepted, 3);

    const counters = harness.gate.snapshot().counters;
    for (const targetKey of [ALBUM_A, ALBUM_B, ALBUM_C]) {
      assert.equal(counters[`entry\u0000${targetKey}`].used, 1, `${targetKey} 只扣 1 次`);
    }

    const result = await harness.gate.drain(at);
    assert.equal(result.deliveries, 3);
    assert.equal(harness.calls[0].length, 3, '一次广播带 3 条（产物 × 目标）');
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-08: 周期滚动——跨自然日 / 自然周惰性清零', async () => {
  const week1 = sh('2026-11-24T22:30:00'); // 周二
  const harness = await makeHarness({
    now: week1,
    policies: {
      [ALBUM_A]: { window: '', entryPerDay: 1, weeklyPerWeek: 1, jitterMinutes: 0 },
      [ALBUM_B]: { window: '', entryPerDay: 0, weeklyPerWeek: 1, jitterMinutes: 0 },
    },
  });
  try {
    assert.equal((await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] })).accepted, 1);
    assert.equal(
      (await offerEvent(harness, { eventKey: 'entry-2', targets: [albumPlan(ALBUM_B)] })).accepted,
      1,
    );

    // 同日晚些时候：词条额度已用尽。
    harness.advance(sh('2026-11-24T23:30:00'));
    assert.equal(
      (await offerEvent(harness, { eventKey: 'entry-3', targets: [albumPlan(ALBUM_A)] })).dropped,
      1,
    );

    // 次日：词条清零（自然日），周报仍属同一自然周。
    harness.advance(sh('2026-11-25T10:00:00'));
    assert.equal(
      (await offerEvent(harness, { eventKey: 'entry-4', targets: [albumPlan(ALBUM_A)] })).accepted,
      1,
    );
    const weeklyFirst = await harness.gate.offer({
      kind: 'weekly',
      source: '100000001',
      eventKey: 'fire-1',
      targets: [albumPlan(ALBUM_B)],
      png: PNG('weekly-1'),
    });
    assert.equal(weeklyFirst.accepted, 1);
    const weeklySameWeek = await harness.gate.offer({
      kind: 'weekly',
      source: '100000001',
      eventKey: 'fire-2',
      targets: [albumPlan(ALBUM_B)],
      png: PNG('weekly-2'),
    });
    assert.equal(weeklySameWeek.dropped, 1, '同一自然周的周报额度已用尽');

    // 下一自然周（12-01 周二）：周报额度清零。
    harness.advance(sh('2026-12-01T10:00:00'));
    const nextWeek = await harness.gate.offer({
      kind: 'weekly',
      source: '100000001',
      eventKey: 'fire-3',
      targets: [albumPlan(ALBUM_B)],
      png: PNG('weekly-3'),
    });
    assert.equal(nextWeek.accepted, 1);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-09: 跨重启——队列与计数持久化，同事件键不重复扣额', async () => {
  const first = await makeHarness({
    now: sh('2026-11-24T09:00:00'),
    policies: { [ALBUM_A]: { window: '* 22:00-23:30', entryPerDay: 3, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
  let dir;
  let deliverAt;
  try {
    dir = first.dir;
    await offerEvent(first, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    deliverAt = first.gate.snapshot().queue[0].deliverAt;
    const raw = await first.readState();
    assert.equal(raw.queue.length, 1);
    assert.equal(raw.counters[`entry\u0000${ALBUM_A}`].used, 1);
  } finally {
    // 不删目录：模拟进程重启后重新挂载。
  }

  const second = await makeHarness({ dir, now: sh('2026-11-24T09:30:00') });
  try {
    const snapshot = second.gate.snapshot();
    assert.equal(snapshot.queue.length, 1, '队列必须从磁盘恢复');
    assert.equal(snapshot.queue[0].deliverAt, deliverAt, '已排定的投递时刻不得重算');
    assert.equal(snapshot.counters[`entry\u0000${ALBUM_A}`].used, 1, '计数必须从磁盘恢复');

    const again = await offerEvent(second, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    assert.equal(again.duplicates, 1, '同（目标 × 事件键）已在队列里');
    assert.equal(again.accepted, 0);
    assert.equal(second.gate.snapshot().counters[`entry\u0000${ALBUM_A}`].used, 1, '重复投递不重复扣额');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCHED-10: 抖动——deliverAt 落在 [窗口首刻, min(右界, 首刻+抖动)]，重启不重算', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-24T08:00:00'),
    policies: { [ALBUM_A]: { window: '* 22:00-23:30', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 15 } },
    random: () => 0.25,
  });
  const dir = harness.dir;
  let deliverAt;
  try {
    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    deliverAt = harness.gate.snapshot().queue[0].deliverAt;
    const windowStart = sh('2026-11-24T22:00:00');
    const windowEnd = sh('2026-11-24T23:30:00');
    assert.ok(deliverAt >= windowStart, '不早于窗口首刻');
    assert.ok(deliverAt <= Math.min(windowEnd, windowStart + 15 * 60_000), '不晚于抖动上界');

    const raw = await harness.readState();
    assert.equal(raw.queue[0].deliverAt, deliverAt, '抖动量必须落库');
  } finally {
    // 不删目录：重启读的是同一份状态文件。
  }

  const restarted = await makeHarness({ dir, now: sh('2026-11-24T09:00:00'), random: () => 0.9 });
  try {
    const raw = await restarted.readState();
    assert.equal(raw.queue[0].deliverAt, deliverAt, '重启后不得用新随机数重算');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCHED-11: 批量——3 条同时到期，一次广播发 3 条', async () => {
  const harness = await makeHarness();
  try {
    const at = harness.now();
    for (const eventKey of ['entry-1', 'entry-2', 'entry-3']) {
      await offerEvent(harness, { eventKey, targets: [albumPlan(ALBUM_A)] });
    }
    const result = await harness.gate.drain(at);

    assert.equal(harness.calls.length, 1, '一批只有一次 broadcast');
    assert.equal(harness.calls[0].length, 3);
    assert.equal(result.deliveries, 3);
    assert.equal(result.delivered, 3);
    assert.equal(result.taken, 3);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-12: 批量部分失败——只重试失败目标，成功项不重复投', async () => {
  const harness = await makeHarness({
    broadcast: (deliveries, round) =>
      round === 1
        ? {
            ok: false,
            delivered: 2,
            total: 3,
            outcomes: [
              { ok: true, attempts: 1 },
              { ok: false, attempts: 1, error: { code: 'RATE_LIMITED', message: '平台限流' } },
              { ok: true, attempts: 1 },
            ],
          }
        : { ok: true, delivered: deliveries.length, total: deliveries.length, outcomes: okOutcomes(deliveries) },
  });
  try {
    const at = harness.now();
    for (const eventKey of ['entry-1', 'entry-2', 'entry-3']) {
      await offerEvent(harness, { eventKey, targets: [albumPlan(ALBUM_A)] });
    }
    const first = await harness.gate.drain(at);
    assert.equal(first.delivered, 2);
    assert.equal(first.failed, 1);
    const queued = harness.gate.snapshot().queue;
    assert.equal(queued.length, 1, '只留失败的那条');
    assert.equal(queued[0].eventKey, 'entry-2');
    assert.ok(queued[0].deliverAt > at, '失败条目退避到未来');

    const second = await harness.gate.drain(queued[0].deliverAt);
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[1].length, 1, '成功项不得重投');
    assert.equal(harness.calls[1][0].item.eventKey, 'entry-2');
    assert.equal(second.delivered, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-13: 队满——第 1025 条拒收并告警，旧项保留', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'patchouli-gate-full-'));
  const now = sh('2026-11-24T22:30:00');
  const queue = Array.from({ length: MAX_QUEUE_ITEMS }, (_, index) => ({
    seq: index + 1,
    source: '100000001',
    targetKey: ALBUM_A,
    kind: 'entry',
    eventKey: `entry-${index + 1}`,
    createdAt: now,
    deliverAt: now + 86_400_000,
    channelId: 'onebot:100000001',
    attempts: 0,
  }));
  await writeFile(
    path.join(dir, 'delivery-state.json'),
    `${JSON.stringify({ version: 1, queue, counters: {} })}\n`,
    'utf8',
  );
  const harness = await makeHarness({ dir, now });
  try {
    const offer = await offerEvent(harness, { eventKey: 'entry-new', targets: [albumPlan(ALBUM_A)] });
    assert.equal(offer.accepted, 0);
    assert.equal(offer.dropped, 1);
    assert.equal(harness.gate.snapshot().queue.length, MAX_QUEUE_ITEMS, '旧项一条都不许淘汰');
    assert.ok(harness.logger.warnings.some((line) => line.includes('投递队列已满')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCHED-14: 坏状态文件——空状态 + 一次告警，写路径不覆盖', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'patchouli-gate-bad-'));
  const statePath = path.join(dir, 'delivery-state.json');
  const broken = '{"version":1,"queue":[';
  await writeFile(statePath, broken, 'utf8');
  const harness = await makeHarness({ dir });
  try {
    assert.ok(harness.logger.warnings.some((line) => line.includes('投递状态文件')), '坏文件必须告警');
    assert.equal(harness.gate.snapshot().queue.length, 0, '按空状态运行');

    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    const result = await harness.gate.drain(harness.now());
    assert.equal(result.delivered, 1, '坏文件不阻断投递');

    assert.equal(await readFile(statePath, 'utf8'), broken, '写路径必须拒绝覆盖坏文件');
    assert.ok(harness.logger.warnings.some((line) => line.includes('落盘失败')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCHED-15: 并发 offer 同事件键只入队一次', async () => {
  const harness = await makeHarness();
  try {
    const offers = await Promise.all(
      Array.from({ length: 5 }, () => offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] })),
    );
    const accepted = offers.reduce((sum, offer) => sum + offer.accepted, 0);
    const duplicates = offers.reduce((sum, offer) => sum + offer.duplicates, 0);
    assert.equal(accepted, 1);
    assert.equal(duplicates, 4);
    assert.equal(harness.gate.snapshot().queue.length, 1);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-16: dispose——定时器停止、不再发送', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-24T09:00:00'),
    policies: { [ALBUM_A]: { window: '* 22:00-23:30', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
  try {
    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    const armed = [...harness.timers.values()];
    assert.equal(armed.length, 1, '只有一条 wake 定时器');
    assert.equal(armed[0].delayMs, sh('2026-11-24T22:00:00') - harness.now());

    harness.gate.dispose();
    assert.equal([...harness.timers.values()].every((timer) => timer.cleared), true, '定时器必须被清掉');

    const late = await harness.gate.drain(sh('2026-11-24T22:05:00'));
    assert.equal(late.skipped, true);
    assert.equal(harness.calls.length, 0, '停闸后不再发送');
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-17: 目标失效——该目标出队告警，同批其他目标照常投', async () => {
  const harness = await makeHarness({
    broadcast: (deliveries) => ({
      ok: false,
      delivered: 1,
      total: 2,
      outcomes: [
        { ok: true, attempts: 1 },
        { ok: false, attempts: 1, error: { code: 'TARGET_UNBOUND', message: '相册已解绑' } },
      ],
    }),
  });
  try {
    const at = harness.now();
    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    await offerEvent(harness, { eventKey: 'entry-2', targets: [albumPlan(ALBUM_B)] });

    const result = await harness.gate.drain(at);
    assert.equal(result.delivered, 1);
    assert.equal(result.dropped, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0, '失效目标出队而不是无限重试');
    assert.ok(harness.logger.warnings.some((line) => line.includes('目标已失效')));
  } finally {
    await harness.disposeDir();
  }
});

test('DELIVERY-GATE-RENDER: 渲染失败退避重试，3 次后出队告警', async () => {
  const harness = await makeHarness({
    render: async () => {
      throw new Error('puppeteer 崩了');
    },
  });
  try {
    const at = harness.now();
    // 不带产物入队：只能靠 render 重渲。
    await harness.gate.offer({ kind: 'entry', source: '100000001', eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });

    const first = await harness.gate.drain(at);
    assert.equal(first.dropped, 0);
    assert.equal(first.failed, 1);
    let queued = harness.gate.snapshot().queue;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].attempts, 1);

    await harness.gate.drain(queued[0].deliverAt);
    queued = harness.gate.snapshot().queue;
    assert.equal(queued.length, 1, '第 2 次仍然留队');
    assert.equal(queued[0].attempts, 2);

    const third = await harness.gate.drain(queued[0].deliverAt);
    assert.equal(third.dropped, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0);
    assert.equal(harness.calls.length, 0, '渲染不出来的条目从未进入批量外发');
    assert.ok(harness.logger.warnings.some((line) => line.includes('渲染失败')));
  } finally {
    await harness.disposeDir();
  }
});

test('DELIVERY-GATE-BATCH-CAP: 到期条目超过单批上限时切批', async () => {
  const harness = await makeHarness();
  try {
    const at = harness.now();
    for (let index = 0; index < MAX_BATCH_ITEMS + 5; index += 1) {
      await offerEvent(harness, { eventKey: `entry-${index}`, targets: [albumPlan(ALBUM_A)] });
    }
    const result = await harness.gate.drain(at);
    assert.equal(result.taken, MAX_BATCH_ITEMS);
    assert.equal(harness.calls[0].length, MAX_BATCH_ITEMS);
    assert.equal(harness.gate.snapshot().queue.length, 5, '剩余条目下一批再发');

    const rest = await harness.gate.drain(at);
    assert.equal(rest.taken, 5);
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('DELIVERY-GATE-SCOPE: 词条 / 周报各带各的 scope 与去重键', async () => {
  const harness = await makeHarness();
  try {
    const at = harness.now();
    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    await harness.gate.offer({
      kind: 'weekly',
      source: '100000001',
      eventKey: 'fire-1',
      targets: [albumPlan(ALBUM_B)],
      png: PNG('weekly'),
    });
    await harness.gate.drain(at);

    const deliveries = harness.calls[0];
    assert.equal(deliveries.length, 2);
    const entry = deliveries.find((delivery) => delivery.item.kind === 'entry');
    const weekly = deliveries.find((delivery) => delivery.item.kind === 'weekly');
    assert.equal(entry.scope, 'patchouli:entry');
    assert.equal(weekly.scope, 'patchouli:weekly-album');
    assert.equal(entry.dedupeKey, `entry-1:${ALBUM_A}`);
    assert.equal(weekly.dedupeKey, `fire-1:${ALBUM_B}`);
    assert.deepEqual(weekly.target, albumTarget('ALBUM02'));
  } finally {
    await harness.disposeDir();
  }
});

test('DELIVERY-GATE-CHAT: @chat 目标的策略键带来源群，投递到记录的频道', async () => {
  const harness = await makeHarness({
    policies: {
      '@chat:100000001': { window: '', entryPerDay: 1, weeklyPerWeek: 0, jitterMinutes: 0 },
    },
  });
  try {
    const at = harness.now();
    const first = await offerEvent(harness, { eventKey: 'entry-1', targets: [chatPlan()] });
    assert.equal(first.accepted, 1);
    const second = await offerEvent(harness, { eventKey: 'entry-2', targets: [chatPlan()] });
    assert.equal(second.dropped, 1, '同一来源群的 @chat 额度共享');

    await harness.gate.drain(at);
    assert.deepEqual(harness.calls[0][0].target, { kind: 'channel', channelId: 'onebot:100000001' });
  } finally {
    await harness.disposeDir();
  }
});
