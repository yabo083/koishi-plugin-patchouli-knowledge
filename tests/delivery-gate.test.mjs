/**
 * 定时投递闸门（`docs/delivery-schedule.md` §8，SCHED-01..25 + ENTRY-QUOTA-01/02）。
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

/** 策略键 = `<来源群>\u0000<目标键>`；相册目标的来源群就是相册所属群。 */
const policyKeyOf = (source, targetKey) => `${source}\u0000${targetKey}`;
const albumPolicyKey = (targetKey) => policyKeyOf(targetKey.split('/')[0], targetKey);
const chatPolicyKey = (source = '100000001') => policyKeyOf(source, `@chat:${source}`);

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
    assert.equal(harness.gate.snapshot().queue[0].dueAt, at, '无策略 = dueAt 就是入队时刻');

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

test('SCHED-02: 空 cron = 立即投，不排队', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-24T22:30:00'),
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 3, perWeek: 1 } },
  });
  try {
    const at = harness.now();
    const offer = await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    assert.equal(offer.accepted, 1);
    assert.equal(offer.deferred, 0, '空 cron 不该延后');
    assert.equal(harness.gate.snapshot().queue[0].dueAt, at);

    const result = await harness.gate.drain(at);
    assert.equal(result.delivered, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-03: cron 到点才投——入队排到下一次触发', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-24T09:00:00'),
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '0 22 * * *', weeklyCron: '', perDay: 0, perWeek: 0 } },
  });
  try {
    const offer = await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    assert.equal(offer.accepted, 1);
    assert.equal(offer.deferred, 1);
    assert.equal(harness.gate.snapshot().queue.length, 1);
    assert.equal(harness.gate.nextWakeAt(), sh('2026-11-24T22:00:00'));
    assert.equal([...harness.timers.values()].filter((timer) => !timer.cleared).at(-1).delayMs, 13 * 3600_000);

    const early = await harness.gate.drain(sh('2026-11-24T09:05:00'));
    assert.equal(early.skipped, true);
    assert.equal(harness.calls.length, 0, '触发点之前一条都不许发');

    const ontime = await harness.gate.drain(sh('2026-11-24T22:00:00'));
    assert.equal(ontime.delivered, 1);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-04: 当天触发点已过 → 排到次日（nextCronAt 严格大于 at）', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-24T22:30:00'),
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '0 22 * * *', weeklyCron: '', perDay: 0, perWeek: 0 } },
  });
  try {
    const offer = await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    assert.equal(offer.deferred, 1);
    assert.equal(harness.gate.nextWakeAt(), sh('2026-11-25T22:00:00'));

    const early = await harness.gate.drain(sh('2026-11-25T21:59:59'));
    assert.equal(early.skipped, true);
    const due = await harness.gate.drain(sh('2026-11-25T22:00:00'));
    assert.equal(due.delivered, 1);
  } finally {
    await harness.disposeDir();
  }
});

test('POLICY-CRON-SPLIT-01: 同一目标两条 cron 各管一类——词条走 entryCron，周报走 weeklyCron', async () => {
  /* 2026-11-24 是周二：次日没有周一，周报必须排到 11-30（周一）09:00。 */
  const harness = await makeHarness({
    now: sh('2026-11-24T07:00:00'),
    policies: {
      [albumPolicyKey(ALBUM_A)]: {
        entryCron: '0 22 * * *',
        weeklyCron: '0 9 * * 1',
        perDay: 0,
        perWeek: 0,
      },
    },
    random: () => 0,
  });
  try {
    const entry = await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    const weekly = await harness.gate.offer({
      kind: 'weekly',
      source: '100000001',
      eventKey: 'fire-1',
      targets: [albumPlan(ALBUM_A)],
    });
    assert.equal(entry.deferred, 1, '词条被 entryCron 推到当天 22:00');
    assert.equal(weekly.deferred, 1, '周报被 weeklyCron 推到下周一 09:00');

    const queue = harness.gate.snapshot().queue;
    const entryItem = queue.find((item) => item.kind === 'entry');
    const weeklyItem = queue.find((item) => item.kind === 'weekly');
    assert.ok(entryItem && weeklyItem, '两类事件各占一条队列项');
    assert.equal(entryItem.dueAt, sh('2026-11-24T22:00:00'), '词条按 entryCron 排期');
    assert.equal(weeklyItem.dueAt, sh('2026-11-30T09:00:00'), '周报按 weeklyCron 排期');

    const evening = await harness.gate.drain(sh('2026-11-24T22:00:00'));
    assert.equal(evening.deliveries, 1, '22:00 只发词条');
    assert.equal(harness.calls[0][0].item.kind, 'entry');
    assert.equal(harness.gate.snapshot().queue.length, 1, '周报仍在队列里等周一');

    const monday = await harness.gate.drain(sh('2026-11-30T09:00:00'));
    assert.equal(monday.deliveries, 1, '周一 09:00 才发周报');
    assert.equal(harness.calls[1][0].item.kind, 'weekly');
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-05: 额度到点判定——同目标第二条超额丢弃，别的目标照常投', async () => {
  const harness = await makeHarness({
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 } },
    random: () => 0,
  });
  try {
    const at = harness.now();
    const planA = albumPlan(ALBUM_A);
    const planB = albumPlan(ALBUM_B);

    const first = await offerEvent(harness, { eventKey: 'entry-1', targets: [planA, planB] });
    const second = await offerEvent(harness, { eventKey: 'entry-2', targets: [planA, planB] });
    assert.equal(first.accepted, 2);
    assert.equal(second.accepted, 2, '额度不挡入队——到点才判');

    const early = await harness.gate.drain(at);
    assert.equal(early.delivered, 2, 'A 的第一条 + B 的第一条（同目标第二条退了一个随机间隔）');
    assert.equal(early.dropped, 0);

    const spaced = await harness.gate.drain(at + 60_000);
    assert.equal(spaced.delivered, 1, 'B 的第二条照常投');
    assert.equal(spaced.overQuota, 1, 'A 当天只允许 1 条');
    assert.ok(harness.logger.warnings.some((line) => line.includes('今日卡片配额已满') && line.includes(ALBUM_A)));
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-06: 每目标每日限量——第 3 条到点丢弃并告警', async () => {
  const harness = await makeHarness({
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 2, perWeek: 0 } },
    random: () => 0,
  });
  try {
    const at = harness.now();
    for (const eventKey of ['entry-1', 'entry-2', 'entry-3']) {
      const offer = await offerEvent(harness, { eventKey, targets: [albumPlan(ALBUM_A)] });
      assert.equal(offer.accepted, 1, '三条都能入队');
    }
    assert.equal(harness.gate.snapshot().queue.length, 3);
    assert.deepEqual(
      harness.gate.snapshot().queue.map((item) => item.dueAt),
      [at, at + 60_000, at + 120_000],
      '同目标相邻两条按 1 分钟起排',
    );

    const first = await harness.gate.drain(at);
    assert.equal(first.delivered, 1);

    const second = await harness.gate.drain(at + 60_000);
    assert.equal(second.delivered, 1, '当天第 2 条仍可投');
    assert.equal(second.dropped, 0);

    const third = await harness.gate.drain(at + 120_000);
    assert.equal(third.delivered, 0);
    assert.equal(third.overQuota, 1, '第 3 条超额丢弃');
    assert.ok(harness.logger.warnings.some((line) => line.includes('今日卡片配额已满') && line.includes('entry-3')));
    assert.equal(harness.gate.snapshot().queue.length, 0, '被丢弃的事件不占队列');
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-07: 同一事件投 3 个目标，各扣各自额度一次（不倍增）', async () => {
  const harness = await makeHarness({
    policies: {
      [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 5, perWeek: 0 },
      [albumPolicyKey(ALBUM_B)]: { entryCron: '', weeklyCron: '', perDay: 5, perWeek: 0 },
      [albumPolicyKey(ALBUM_C)]: { entryCron: '', weeklyCron: '', perDay: 5, perWeek: 0 },
    },
  });
  try {
    const at = harness.now();
    const offer = await offerEvent(harness, {
      eventKey: 'entry-1',
      targets: [albumPlan(ALBUM_A), albumPlan(ALBUM_B), albumPlan(ALBUM_C)],
    });
    assert.equal(offer.accepted, 3);

    const result = await harness.gate.drain(at);
    assert.equal(result.deliveries, 3);
    assert.equal(harness.calls[0].length, 3, '一次广播带 3 条（产物 × 目标）');

    const counters = harness.gate.snapshot().counters;
    for (const targetKey of [ALBUM_A, ALBUM_B, ALBUM_C]) {
      assert.equal(counters[`entry\u0000${albumPolicyKey(targetKey)}`].used, 1, `${targetKey} 只扣 1 次`);
    }
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-08: 周期滚动——跨自然日 / 自然周惰性清零', async () => {
  const week1 = sh('2026-11-24T22:30:00'); // 周二
  const harness = await makeHarness({
    now: week1,
    policies: {
      [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 1 },
      [albumPolicyKey(ALBUM_B)]: { entryCron: '', weeklyCron: '', perDay: 0, perWeek: 1 },
    },
  });
  const offerEntry = (eventKey, targetKey) => offerEvent(harness, { eventKey, targets: [albumPlan(targetKey)] });
  const offerWeekly = (eventKey, targetKey) =>
    harness.gate.offer({
      kind: 'weekly',
      source: '100000001',
      eventKey,
      targets: [albumPlan(targetKey)],
      png: PNG(eventKey),
    });
  try {
    assert.equal((await offerEntry('entry-1', ALBUM_A)).accepted, 1);
    assert.equal((await harness.gate.drain(week1)).delivered, 1);
    assert.equal((await offerEntry('entry-2', ALBUM_A)).accepted, 1, '额度不挡入队');
    const sameDay = await harness.gate.drain(sh('2026-11-24T23:30:00'));
    assert.equal(sameDay.overQuota, 1, '同一天的第二条到点即超额');

    // 次日：词条清零（自然日），周报仍属同一自然周。
    harness.advance(sh('2026-11-25T10:00:00'));
    assert.equal((await offerEntry('entry-4', ALBUM_A)).accepted, 1);
    assert.equal((await harness.gate.drain(sh('2026-11-25T10:00:00'))).delivered, 1);

    assert.equal((await offerWeekly('fire-1', ALBUM_B)).accepted, 1);
    assert.equal((await harness.gate.drain(sh('2026-11-25T10:00:00'))).delivered, 1);
    assert.equal((await offerWeekly('fire-2', ALBUM_B)).accepted, 1);
    const sameWeek = await harness.gate.drain(sh('2026-11-25T11:00:00'));
    assert.equal(sameWeek.overQuota, 1, '同一自然周的周报额度已用尽');

    // 下一自然周（12-01 周二）：周报额度清零。
    harness.advance(sh('2026-12-01T10:00:00'));
    assert.equal((await offerWeekly('fire-3', ALBUM_B)).accepted, 1);
    assert.equal((await harness.gate.drain(sh('2026-12-01T10:00:00'))).delivered, 1);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-09: 跨重启——队列与计数持久化，同事件键不重复入队', async () => {
  const first = await makeHarness({
    now: sh('2026-11-24T09:00:00'),
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 0 } },
  });
  const dir = first.dir;
  let dueAt;
  try {
    await offerEvent(first, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    dueAt = first.gate.snapshot().queue[0].dueAt;
    assert.equal(dueAt, sh('2026-11-24T22:00:00'));

    // 到点投一条，记下额度；分钟已过（22:05）再排一条 → 只能排到明天同一时刻。
    await first.gate.drain(sh('2026-11-24T22:00:00'));
    first.advance(sh('2026-11-24T22:05:00'));
    await offerEvent(first, { eventKey: 'entry-2', targets: [albumPlan(ALBUM_A)] });

    const raw = await first.readState();
    assert.equal(raw.queue.length, 1);
    assert.equal(raw.queue[0].dueAt, sh('2026-11-25T22:00:00'), '状态文件写的是 dueAt');
    assert.equal(raw.counters[`entry\u0000${albumPolicyKey(ALBUM_A)}`].used, 1);
  } finally {
    // 不删目录：模拟进程重启后重新挂载。
  }

  const second = await makeHarness({ dir, now: sh('2026-11-24T22:30:00') });
  try {
    const snapshot = second.gate.snapshot();
    assert.equal(snapshot.queue.length, 1, '队列必须从磁盘恢复');
    assert.equal(snapshot.queue[0].dueAt, sh('2026-11-25T22:00:00'), '已排定的到期时刻不得重算');
    assert.equal(
      snapshot.counters[`entry\u0000${albumPolicyKey(ALBUM_A)}`].used,
      1,
      '计数必须从磁盘恢复',
    );

    const again = await offerEvent(second, { eventKey: 'entry-2', targets: [albumPlan(ALBUM_A)] });
    assert.equal(again.duplicates, 1, '同（来源群 × 目标 × 事件键）已在队列里');
    assert.equal(again.accepted, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCHED-10: 同目标随机间隔 1–3 分钟：错开到点、落库、重启不重算', async () => {
  const harness = await makeHarness({
    now: sh('2026-11-24T09:00:00'),
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '0 22 * * *', weeklyCron: '', perDay: 0, perWeek: 0 } },
    random: () => 0.25,
  });
  const dir = harness.dir;
  let dueAts;
  try {
    for (const eventKey of ['entry-1', 'entry-2', 'entry-3']) {
      await offerEvent(harness, { eventKey, targets: [albumPlan(ALBUM_A)] });
    }
    dueAts = harness.gate.snapshot().queue.map((item) => item.dueAt);
    const base = sh('2026-11-24T22:00:00');
    assert.equal(dueAts[0], base);
    assert.equal(dueAts[1], base + 90_000, '随机源 0.25 → 间隔 90000ms');
    assert.equal(dueAts[2], base + 180_000);

    for (let index = 1; index < dueAts.length; index += 1) {
      const gap = dueAts[index] - dueAts[index - 1];
      assert.ok(gap >= 60_000 && gap <= 180_000, `间隔必须落在 1–3 分钟：${gap}`);
    }

    const raw = await harness.readState();
    assert.deepEqual(raw.queue.map((item) => item.dueAt), dueAts, '间隔必须落库');
  } finally {
    // 不删目录：重启读的是同一份状态文件。
  }

  const restarted = await makeHarness({ dir, now: sh('2026-11-24T10:00:00'), random: () => 0.9 });
  try {
    assert.deepEqual(
      restarted.gate.snapshot().queue.map((item) => item.dueAt),
      dueAts,
      '重启后不得用新随机数重算',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCHED-11: 批量——3 个目标同时到期，一次广播发 3 条', async () => {
  const harness = await makeHarness();
  try {
    const at = harness.now();
    for (const [index, targetKey] of [ALBUM_A, ALBUM_B, ALBUM_C].entries()) {
      await offerEvent(harness, { eventKey: `entry-${index + 1}`, targets: [albumPlan(targetKey)] });
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
    for (const [index, targetKey] of [ALBUM_A, ALBUM_B, ALBUM_C].entries()) {
      await offerEvent(harness, { eventKey: `entry-${index + 1}`, targets: [albumPlan(targetKey)] });
    }
    const first = await harness.gate.drain(at);
    assert.equal(first.delivered, 2);
    assert.equal(first.failed, 1);
    const queued = harness.gate.snapshot().queue;
    assert.equal(queued.length, 1, '只留失败的那条');
    assert.equal(queued[0].eventKey, 'entry-2');
    assert.ok(queued[0].dueAt > at, '失败条目退避到未来');

    const second = await harness.gate.drain(queued[0].dueAt);
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
    dueAt: now + 86_400_000,
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
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '0 22 * * *', weeklyCron: '', perDay: 0, perWeek: 0 } },
  });
  try {
    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    const armed = [...harness.timers.values()].filter((timer) => !timer.cleared);
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

test('SCHED-18: 同一个投递群在不同监听群下策略互相独立', async () => {
  const harness = await makeHarness({
    policies: { [policyKeyOf('200', ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 } },
  });
  try {
    const at = harness.now();
    const offerFrom = (source, eventKey) =>
      harness.gate.offer({
        kind: 'entry',
        source,
        eventKey,
        targets: [albumPlan(ALBUM_A)],
        png: PNG(eventKey),
      });

    await offerFrom('200', 'entry-a1');
    await offerFrom('300', 'entry-b1');
    assert.equal(harness.gate.snapshot().queue.length, 2);

    const first = await harness.gate.drain(at);
    assert.equal(first.delivered, 2, '不同来源不共享同目标间隔，也不共享额度');

    await offerFrom('200', 'entry-a2');
    const second = await harness.gate.drain(at + 5000);
    assert.equal(second.overQuota, 1, '来源群 200 当天已用尽 1 条');
    assert.equal(harness.gate.snapshot().queue.length, 0, '来源群 300 不受牵连');
    assert.ok(harness.logger.warnings.some((line) => line.includes('今日卡片配额已满') && line.includes(ALBUM_A)));
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-19: 额度用尽不再渲染——perDay=2、5 条到点只渲 2 条，3 条出队告警', async () => {
  const harness = await makeHarness({
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 2, perWeek: 0 } },
    random: () => 0,
  });
  try {
    const at = harness.now();
    for (const eventKey of ['entry-1', 'entry-2', 'entry-3', 'entry-4', 'entry-5']) {
      // 不带产物入队：必须经过 render 才能验证「超额条目不渲染」。
      const offer = await harness.gate.offer({
        kind: 'entry',
        source: '100000001',
        eventKey,
        targets: [albumPlan(ALBUM_A)],
      });
      assert.equal(offer.accepted, 1);
    }

    const result = await harness.gate.drain(at + 5 * 60_000);

    assert.equal(result.overQuota, 3, '3 条超额直接出队');
    assert.equal(result.deliveries, 2, '只有额度内的两条进入投递');
    assert.equal(result.delivered, 2);
    assert.equal(result.dropped, 0, '超额不算渲染失败 / 目标失效');
    assert.deepEqual(harness.renderCalls, ['entry-1', 'entry-2'], '渲染桩只被调用 2 次');
    assert.equal(harness.calls.length, 1, '一批只有一次 broadcast');
    assert.equal(harness.calls[0].length, 2, 'deliver 只收到 2 条');
    assert.equal(harness.gate.snapshot().queue.length, 0, '超额条目不回流到下一轮');

    const overQuotaWarnings = harness.logger.warnings.filter((line) => line.includes('今日卡片配额已满'));
    assert.equal(overQuotaWarnings.length, 3, '每条超额各一条 warn');
    for (const eventKey of ['entry-3', 'entry-4', 'entry-5']) {
      assert.ok(
        overQuotaWarnings.some((line) => line.includes(eventKey) && line.includes(ALBUM_A)),
        `${eventKey} 的 warn 必须带目标与事件键`,
      );
    }
    assert.equal(
      harness.gate.snapshot().quotaUsed('entry', '100000001', ALBUM_A, at + 5 * 60_000),
      2,
      'snapshot 暴露当期已出卡数',
    );
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-20: 重试条目不重复占额——首次失败退避后重试不再判额', async () => {
  const harness = await makeHarness({
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 } },
    broadcast: (deliveries, round) =>
      round === 1
        ? {
            ok: false,
            delivered: 0,
            total: 1,
            outcomes: [{ ok: false, attempts: 1, error: { code: 'RATE_LIMITED', message: '平台限流' } }],
          }
        : { ok: true, delivered: deliveries.length, total: deliveries.length, outcomes: okOutcomes(deliveries) },
  });
  try {
    const at = harness.now();
    await harness.gate.offer({
      kind: 'entry',
      source: '100000001',
      eventKey: 'entry-1',
      targets: [albumPlan(ALBUM_A)],
    });

    const first = await harness.gate.drain(at);
    assert.equal(first.delivered, 0);
    assert.equal(first.failed, 1);
    assert.equal(first.overQuota, 0);
    const queued = harness.gate.snapshot().queue;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].attempts, 1);

    const retried = await harness.gate.drain(queued[0].dueAt);
    assert.equal(retried.delivered, 1);
    assert.equal(retried.overQuota, 0, '重试条目跳过额度判定');

    const snapshot = harness.gate.snapshot();
    assert.equal(snapshot.queue.length, 0);
    assert.equal(snapshot.quotaUsed('entry', '100000001', ALBUM_A, at), 1, '只占一次额');
    assert.equal(snapshot.counters[`entry\u0000${albumPolicyKey(ALBUM_A)}`].used, 1);
    assert.equal(harness.calls.length, 2, '首次失败 + 一次重试');
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-21: 并发 drain 不重复占额——额度判定在串行链内只跑一遍', async () => {
  const harness = await makeHarness({
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 2, perWeek: 0 } },
    random: () => 0,
  });
  try {
    const at = harness.now();
    for (const eventKey of ['entry-1', 'entry-2', 'entry-3']) {
      await harness.gate.offer({
        kind: 'entry',
        source: '100000001',
        eventKey,
        targets: [albumPlan(ALBUM_A)],
      });
    }

    const dueAt = at + 3 * 60_000;
    const [a, b] = await Promise.all([harness.gate.drain(dueAt), harness.gate.drain(dueAt)]);
    const ran = [a, b].filter((result) => !result.skipped);
    assert.equal(ran.length, 1, '并发 drain 只有一轮真正执行，另一轮空转');
    assert.equal(ran[0].delivered, 2);
    assert.equal(ran[0].overQuota, 1);
    assert.equal(harness.calls.length, 1, '两条额度只对应一次批量外发');
    assert.equal(
      harness.gate.snapshot().quotaUsed('entry', '100000001', ALBUM_A, dueAt),
      2,
      '额度只被占两次（不是四次）',
    );
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-22: 入队时刻与 weeklyCron 同一分钟 → 当场到期，不推迟一周', async () => {
  /* 2026-11-23 是周一。全局 cron 生成周报的时刻（09:00）与目标的 `weeklyCron` 是同一分钟，
     但入队时刻带秒：`nextCronAt` 严格大于会把它推到 11-30。回看一分钟必须把「本分钟已到点」算成现在。 */
  const at = sh('2026-11-23T09:00:30');
  const harness = await makeHarness({
    now: at,
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '0 9 * * 1', perDay: 0, perWeek: 0 } },
    random: () => 0,
  });
  try {
    const weekly = await harness.gate.offer({
      kind: 'weekly',
      source: '100000001',
      eventKey: 'fire-1',
      targets: [albumPlan(ALBUM_A)],
    });
    assert.equal(weekly.accepted, 1);
    assert.equal(weekly.deferred, 0, '同一分钟内的触发就是「现在」，不算延期');

    const [item] = harness.gate.snapshot().queue;
    assert.equal(item.dueAt, at, 'dueAt 必须是入队时刻，不能推到下周一');
    assert.equal(harness.gate.nextWakeAt(), at);

    const ontime = await harness.gate.drain(at);
    assert.equal(ontime.delivered, 1, '当场就能发出去');
    assert.equal(harness.calls[0][0].item.kind, 'weekly');
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-23: 入队时刻已过匹配分钟（09:01:30）→ 排到下一个周一 09:00', async () => {
  const at = sh('2026-11-23T09:01:30');
  const harness = await makeHarness({
    now: at,
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '0 9 * * 1', perDay: 0, perWeek: 0 } },
    random: () => 0,
  });
  try {
    const weekly = await harness.gate.offer({
      kind: 'weekly',
      source: '100000001',
      eventKey: 'fire-1',
      targets: [albumPlan(ALBUM_A)],
    });
    assert.equal(weekly.deferred, 1, '匹配分钟已过，必须等下一次触发');
    assert.equal(harness.gate.snapshot().queue[0].dueAt, sh('2026-11-30T09:00:00'), '下一个周一 09:00');
    assert.equal(harness.gate.nextWakeAt(), sh('2026-11-30T09:00:00'));

    const early = await harness.gate.drain(at);
    assert.equal(early.skipped, true);
    assert.equal(harness.calls.length, 0, '本周这条已经错过，绝不当场补发');

    const due = await harness.gate.drain(sh('2026-11-30T09:00:00'));
    assert.equal(due.delivered, 1);
    assert.equal(harness.calls[0][0].item.kind, 'weekly');
  } finally {
    await harness.disposeDir();
  }
});

test('ENTRY-QUOTA-01: 额度预筛——allows 为 false 的目标被剔除，只把通过的目标交给 offer', async () => {
  /* 词条 sink 的语义：渲染之前先用 `allows('entry', …)` 过滤目标，全被剔除就不出卡。
     这里锁死闸门侧的契约：`allows` 是同步只读预筛，剔除的目标根本进不了 offer。 */
  const harness = await makeHarness({
    policies: {
      [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 },
      [albumPolicyKey(ALBUM_B)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 },
    },
    random: () => 0,
  });
  try {
    const at = harness.now();
    const source = '100000001';

    // 先把 ALBUM_A 的当日额度用满。
    await offerEvent(harness, { eventKey: 'entry-a1', targets: [albumPlan(ALBUM_A)] });
    const first = await harness.gate.drain(at);
    assert.equal(first.delivered, 1);

    // 预筛是只读的：反复调用不占额、不改计数。
    for (let round = 0; round < 3; round += 1) {
      assert.equal(harness.gate.allows('entry', source, ALBUM_A), false, '额度耗尽的目标预筛必须拒');
    }
    assert.equal(harness.gate.allows('entry', source, ALBUM_B), true, '未占额的目标照常放行');
    assert.equal(
      harness.gate.snapshot().quotaUsed('entry', source, ALBUM_A, at),
      1,
      '预筛不占额',
    );

    const plans = [albumPlan(ALBUM_A), albumPlan(ALBUM_B)];
    const candidates = plans.filter((plan) => harness.gate.allows('entry', source, plan.targetKey));
    assert.deepEqual(
      candidates.map((plan) => plan.targetKey),
      [ALBUM_B],
      '只有通过预筛的目标进入候选',
    );

    // 被剔除的目标连队列都不进：不渲染、不投递、不告警超额。
    const offer = await harness.gate.offer({
      kind: 'entry',
      source,
      eventKey: 'entry-a2',
      targets: candidates,
    });
    assert.equal(offer.accepted, 1, '只入队一条');
    assert.deepEqual(
      harness.gate.snapshot().queue.map((item) => item.targetKey),
      [ALBUM_B],
    );

    const drained = await harness.gate.drain(at + 120_000);
    assert.equal(drained.deliveries, 1);
    assert.equal(drained.overQuota, 0, '被预筛掉的目标不会走 drain 的超额分支');
    assert.deepEqual(
      harness.calls.at(-1).map((delivery) => delivery.item.targetKey),
      [ALBUM_B],
    );
    assert.equal(harness.gate.snapshot().quotaUsed('entry', source, ALBUM_A, at), 1, 'A 的额度没被再动');

    // 周期滚动后预筛重新放行（sink 下一张卡又该出图）。
    assert.equal(harness.gate.allows('entry', source, ALBUM_A, sh('2026-11-25T10:00:00')), true);
  } finally {
    await harness.disposeDir();
  }
});

/**
 * 词条 sink 的目标预筛（镜像 `src/plugin/index.ts` 的 `setEntryCardSink`）。
 *
 * 额度已满时不能一律剔除：cron 把下一班排在下一个周期时，那条仍该入队等新周期的额度。
 */
function sinkCandidates(gate, source, plans) {
  return plans.filter((plan) => {
    const key = plan.targetKey;
    if (gate.allows('entry', source, key)) return true;
    return gate.wouldDeferPastPeriod('entry', source, key);
  });
}

test('SCHED-24: 今日额度已满但下一班在明天——该条入队等新周期，不当成没机会丢掉', async () => {
  const at = sh('2026-11-25T09:00:00');
  const harness = await makeHarness({
    now: at,
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '0 9 * * *', weeklyCron: '', perDay: 1, perWeek: 0 } },
    random: () => 0,
  });
  try {
    const source = '100000001';
    // 09:00 这一班已经投过一条，今日 perDay=1 用尽。
    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    const first = await harness.gate.drain(at);
    assert.equal(first.delivered, 1);
    assert.equal(harness.gate.snapshot().quotaUsed('entry', source, ALBUM_A, at), 1);

    const later = sh('2026-11-25T10:00:00');
    harness.advance(later);
    assert.equal(harness.gate.allows('entry', source, ALBUM_A, later), false, '今天的额度确实满了');
    assert.equal(
      harness.gate.wouldDeferPastPeriod('entry', source, ALBUM_A, later),
      true,
      '下一班是明天 09:00 → 落在下一个周期，说明这条还有机会',
    );

    const second = await offerEvent(harness, { eventKey: 'entry-2', targets: [albumPlan(ALBUM_A)] });
    assert.equal(second.accepted, 1, '满额不等于丢弃：必须入队');
    assert.equal(second.deferred, 1);
    const [queued] = harness.gate.snapshot().queue;
    assert.equal(queued.eventKey, 'entry-2');
    assert.equal(queued.dueAt, sh('2026-11-26T09:00:00'), 'dueAt 是明天的 09:00');
    assert.equal(harness.gate.nextWakeAt(), sh('2026-11-26T09:00:00'));

    const today = await harness.gate.drain(sh('2026-11-25T23:59:00'));
    assert.equal(today.skipped, true, '今天不会再补发');
    const tomorrow = await harness.gate.drain(sh('2026-11-26T09:00:00'));
    assert.equal(tomorrow.delivered, 1, '新周期额度从零算，照常出卡');
    assert.equal(harness.gate.snapshot().queue.length, 0);
  } finally {
    await harness.disposeDir();
  }
});

test('SCHED-25: 空 cron（立即投）且额度已满——本周期内就到期，没有下一班，照旧丢弃', async () => {
  const at = sh('2026-11-25T09:00:00');
  const harness = await makeHarness({
    now: at,
    policies: { [albumPolicyKey(ALBUM_A)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 } },
    random: () => 0,
  });
  try {
    const source = '100000001';
    await offerEvent(harness, { eventKey: 'entry-1', targets: [albumPlan(ALBUM_A)] });
    await harness.gate.drain(at);

    assert.equal(harness.gate.allows('entry', source, ALBUM_A, at), false);
    assert.equal(
      harness.gate.wouldDeferPastPeriod('entry', source, ALBUM_A, at),
      false,
      '立即投的目标下一次到点就是现在，等不到下一个周期',
    );
    assert.deepEqual(sinkCandidates(harness.gate, source, [albumPlan(ALBUM_A)]), [], 'sink 预筛必须剔除');

    // 即使塞进队列，到点也会被额度闸门丢掉（语义与修复前一致）。
    const second = await offerEvent(harness, { eventKey: 'entry-2', targets: [albumPlan(ALBUM_A)] });
    assert.equal(second.accepted, 1);
    assert.equal(second.deferred, 0);
    assert.equal(harness.gate.snapshot().queue[0].dueAt, at);

    const dropped = await harness.gate.drain(at);
    assert.equal(dropped.delivered, 0);
    assert.equal(dropped.overQuota, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0);
    assert.ok(harness.logger.warnings.some((message) => message.includes('配额已满')));
  } finally {
    await harness.disposeDir();
  }
});

test('ENTRY-QUOTA-02: sink 预筛——满额但下一班在明天的目标留队，本轮就到期且满额的才剔除', async () => {
  const at = sh('2026-11-25T09:00:00');
  const harness = await makeHarness({
    now: at,
    policies: {
      [albumPolicyKey(ALBUM_A)]: { entryCron: '0 9 * * *', weeklyCron: '', perDay: 1, perWeek: 0 },
      [albumPolicyKey(ALBUM_B)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 },
      [albumPolicyKey(ALBUM_C)]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 },
    },
    random: () => 0,
  });
  try {
    const source = '100000001';
    // A（09:00 定时）与 C（立即投）的今日额度先用满。
    await offerEvent(harness, { eventKey: 'entry-a1', targets: [albumPlan(ALBUM_A)] });
    await offerEvent(harness, { eventKey: 'entry-c1', targets: [albumPlan(ALBUM_C)] });
    const filled = await harness.gate.drain(at);
    assert.equal(filled.delivered, 2);

    const later = sh('2026-11-25T10:00:00');
    harness.advance(later);
    const candidates = sinkCandidates(harness.gate, source, [
      albumPlan(ALBUM_A),
      albumPlan(ALBUM_B),
      albumPlan(ALBUM_C),
    ]);
    assert.deepEqual(
      candidates.map((plan) => plan.targetKey),
      [ALBUM_A, ALBUM_B],
      'A 满额但下一班在明天 → 留；B 有额度 → 留；C 满额且本周期就到期 → 剔除',
    );

    const offer = await harness.gate.offer({
      kind: 'entry',
      source,
      eventKey: 'entry-2',
      targets: candidates,
      png: PNG('entry-2'),
    });
    assert.equal(offer.accepted, 2, '两者都进 offer');
    assert.equal(offer.deferred, 1, '只有 A 等下一班');
    assert.deepEqual(
      harness.gate.snapshot().queue.map((item) => [item.targetKey, item.dueAt]),
      [
        [ALBUM_A, sh('2026-11-26T09:00:00')],
        [ALBUM_B, later],
      ],
    );

    const sameDay = await harness.gate.drain(later);
    assert.equal(sameDay.delivered, 1);
    assert.deepEqual(
      harness.calls.at(-1).map((delivery) => delivery.item.targetKey),
      [ALBUM_B],
      'A 还没到点，今天只发 B',
    );

    const nextDay = await harness.gate.drain(sh('2026-11-26T09:00:00'));
    assert.equal(nextDay.delivered, 1);
    assert.deepEqual(
      harness.calls.at(-1).map((delivery) => delivery.item.targetKey),
      [ALBUM_A],
      'A 在明天的 09:00 拿到新周期额度并投出',
    );
    assert.equal(harness.gate.snapshot().queue.length, 0);
    assert.equal(harness.gate.snapshot().quotaUsed('entry', source, ALBUM_A, sh('2026-11-26T09:00:00')), 1);
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

    await harness.gate.drain(queued[0].dueAt);
    queued = harness.gate.snapshot().queue;
    assert.equal(queued.length, 1, '第 2 次仍然留队');
    assert.equal(queued[0].attempts, 2);

    const third = await harness.gate.drain(queued[0].dueAt);
    assert.equal(third.dropped, 1);
    assert.equal(harness.gate.snapshot().queue.length, 0);
    assert.equal(harness.calls.length, 0, '渲染不出来的条目从未进入批量外发');
    assert.ok(harness.logger.warnings.some((line) => line.includes('渲染失败')));
  } finally {
    await harness.disposeDir();
  }
});

test('DELIVERY-GATE-BATCH-CAP: 到期条目超过单批上限时切批', async () => {
  const harness = await makeHarness({ random: () => 0 });
  try {
    const at = harness.now();
    const total = MAX_BATCH_ITEMS + 5;
    for (let index = 0; index < total; index += 1) {
      await offerEvent(harness, { eventKey: `entry-${index}`, targets: [albumPlan(ALBUM_A)] });
    }
    // 同目标相邻条目按 1 分钟起排（random 固定 0），等到全部到期再一次性取。
    const dueAt = at + total * 60_000;
    const result = await harness.gate.drain(dueAt);
    assert.equal(result.taken, MAX_BATCH_ITEMS);
    assert.equal(harness.calls[0].length, MAX_BATCH_ITEMS);
    assert.equal(harness.gate.snapshot().queue.length, 5, '剩余条目下一批再发');

    const rest = await harness.gate.drain(dueAt);
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
    assert.equal(entry.dedupeKey, `100000001:entry-1:${ALBUM_A}`);
    assert.equal(weekly.dedupeKey, `100000001:fire-1:${ALBUM_B}`);
    assert.deepEqual(weekly.target, albumTarget('ALBUM02'));
  } finally {
    await harness.disposeDir();
  }
});

test('DELIVERY-GATE-SCOPE-SOURCE: 两个来源群的同一事件投同一相册，幂等键与投递都各算各的', async () => {
  const harness = await makeHarness();
  try {
    const at = harness.now();
    // 同一个 `fireKey` / 同一个相册，只有来源群不同：队列身份本就按来源分开，
    // 下游幂等键也必须分开，否则后到的那条会被判成「已发过」而静默跳过。
    for (const source of ['100000001', '100000002']) {
      await harness.gate.offer({
        kind: 'weekly',
        source,
        eventKey: 'fire-1',
        targets: [albumPlan(ALBUM_A)],
        png: PNG(`weekly-${source}`),
      });
    }
    // 词条同理：同一天同标题 slug 在不同来源群里会撞 `entryId`。
    for (const source of ['100000001', '100000002']) {
      await harness.gate.offer({
        kind: 'entry',
        source,
        eventKey: '2026-11-24-some-topic',
        targets: [albumPlan(ALBUM_B)],
        png: PNG(`entry-${source}`),
      });
    }
    await harness.gate.drain(at);

    const deliveries = harness.calls[0];
    assert.equal(deliveries.length, 4, '两条来源的四张卡都要真的发出去');
    const keys = deliveries.map((delivery) => delivery.dedupeKey);
    assert.equal(new Set(keys).size, 4, '幂等键必须按来源群区分');
    assert.deepEqual(keys.slice().sort(), [
      `100000001:2026-11-24-some-topic:${ALBUM_B}`,
      `100000001:fire-1:${ALBUM_A}`,
      `100000002:2026-11-24-some-topic:${ALBUM_B}`,
      `100000002:fire-1:${ALBUM_A}`,
    ].sort());
    /* 产物也不能按「种类 + 事件键」合并：第二个来源的卡必须带自己的 PNG。 */
    const pngByKey = new Map(deliveries.map((delivery) => [delivery.dedupeKey, delivery.png.toString()]));
    assert.equal(pngByKey.get(`100000001:fire-1:${ALBUM_A}`), 'png:weekly-100000001');
    assert.equal(pngByKey.get(`100000002:fire-1:${ALBUM_A}`), 'png:weekly-100000002');
    assert.equal(pngByKey.get(`100000002:2026-11-24-some-topic:${ALBUM_B}`), 'png:entry-100000002');
  } finally {
    await harness.disposeDir();
  }
});

test('DELIVERY-GATE-RENDER-CACHE: 同批同事件键不同来源各渲各的产物，不复用别的来源的 PNG', async () => {
  let renders = 0;
  const harness = await makeHarness({
    render: async (item) => {
      renders += 1;
      return PNG(`${item.source}:${item.eventKey}`);
    },
  });
  try {
    const at = harness.now();
    for (const source of ['100000001', '100000002']) {
      await harness.gate.offer({
        kind: 'weekly',
        source,
        eventKey: 'fire-1',
        targets: [albumPlan(ALBUM_A)],
        /* 不给 png：两条都要真正走进渲染，命中缓存就会暴露成第二个来源拿到第一个来源的图。 */
      });
    }
    await harness.gate.drain(at);

    const deliveries = harness.calls[0];
    assert.equal(deliveries.length, 2);
    assert.deepEqual(deliveries.map((delivery) => delivery.png.toString()), [
      'png:100000001:fire-1',
      'png:100000002:fire-1',
    ]);
    assert.equal(renders, 2, '两个来源各渲一次，产物身份必须带来源群');
  } finally {
    await harness.disposeDir();
  }
});

test('DELIVERY-GATE-TIMER-CAP: 极远的到期时刻夹到定时器上界，不当成立即唤醒', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'patchouli-gate-far-'));
  try {
    const now = sh('2026-11-24T22:30:00');
    const far = now + 8 * 366 * 86_400_000;
    await writeFile(
      path.join(dir, 'delivery-state.json'),
      JSON.stringify({
        version: 1,
        queue: [
          {
            seq: 1,
            source: '100000001',
            targetKey: ALBUM_A,
            kind: 'entry',
            eventKey: 'entry-far',
            createdAt: now,
            dueAt: far,
            channelId: 'onebot:100000001',
            attempts: 0,
          },
        ],
        counters: {},
      }),
      'utf8',
    );
    const harness = await makeHarness({ dir, now });
    const armed = [...harness.timers.values()];
    assert.equal(armed.length, 1, '有一条待投就要排一次唤醒');
    assert.equal(armed[0].delayMs, 2_147_483_647, '超过上界的延迟必须夹住（否则运行时按 1ms 触发）');
    assert.ok(armed[0].delayMs > 0, '绝不能是 0 延迟的空转唤醒');
    await harness.disposeDir();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DELIVERY-GATE-CHAT: @chat 目标的策略键带来源群，投递到记录的频道', async () => {
  const harness = await makeHarness({
    policies: { [chatPolicyKey('100000001')]: { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 } },
  });
  try {
    const at = harness.now();
    const first = await offerEvent(harness, { eventKey: 'entry-1', targets: [chatPlan()] });
    assert.equal(first.accepted, 1);
    const second = await offerEvent(harness, { eventKey: 'entry-2', targets: [chatPlan()] });
    assert.equal(second.accepted, 1, '额度不挡入队');

    const early = await harness.gate.drain(at);
    assert.equal(early.delivered, 1);
    assert.deepEqual(harness.calls[0][0].target, { kind: 'channel', channelId: 'onebot:100000001' });

    const late = await harness.gate.drain(at + 180_000);
    assert.equal(late.overQuota, 1, '同一来源群的 @chat 额度共享');
  } finally {
    await harness.disposeDir();
  }
});
