import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

import { TopicScheduler, localDayKey } from '../lib/plugin/topic-scheduler.js';

const TEST_DIR = nodePath.resolve('tmp/test-topic-scheduler');
const STATE_PATH = nodePath.join(TEST_DIR, 'topics-state.json');

const CONFIG = {
  enabled: true,
  hour: 4,
  minute: 0,
  mergeThreshold: 0.5,
  minEntries: 1,
  lookbackDays: 30,
  maxSessionsPerRun: 20,
  maxMessagesPerSession: 60,
};

function at(hour, minute = 0, day = 2) {
  return new Date(2026, 10, day, hour, minute, 0, 0).getTime();
}

function ok(channelId) {
  return {
    channelId,
    dayKey: localDayKey(at(4, 5)),
    createdTopicIds: [`${localDayKey(at(4, 5))}-topic-${channelId}`],
    updatedTopicIds: [],
    assignedEntryIds: [`${channelId}-entry-1`],
  };
}

function makeScheduler({ now, run, channels = ['g1'] }) {
  const timers = [];
  const scheduler = new TopicScheduler(CONFIG, {
    channels: () => channels,
    run,
    statePath: STATE_PATH,
    now: () => now,
    retryDelayMs: 30 * 60_000,
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { scheduler, timers };
}

test('TOPIC-SCHED-01: 成功后当天封盘，重启不再重复调用（日切水位持久化）', async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  let calls = 0;
  const now = at(4, 5);
  const first = makeScheduler({ now, run: async (channelId) => (calls++, ok(channelId)) });
  await first.scheduler.start();
  assert.equal(calls, 1);

  // 同一天的第二个进程：仍不应再跑
  const second = makeScheduler({ now: at(9, 0), run: async (channelId) => (calls++, ok(channelId)) });
  await second.scheduler.start();
  assert.equal(calls, 1);

  // 次日到点后恢复
  const third = makeScheduler({ now: at(4, 5, 3), run: async (channelId) => (calls++, ok(channelId)) });
  await third.scheduler.start();
  assert.equal(calls, 2);
});

test('TOPIC-SCHED-02: 未到 04:00 不触发，过点后补跑', async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  let calls = 0;
  const early = makeScheduler({ now: at(3, 59), run: async (channelId) => (calls++, ok(channelId)) });
  await early.scheduler.start();
  assert.equal(calls, 0);
  assert.equal(early.timers.length, 1, '启动后必须排下一个事件，否则每日调度只生效一次');
  assert.equal(early.timers[0].delayMs, 60_000, '03:59 下一个事件应为 04:00');

  const late = makeScheduler({ now: at(4, 0), run: async (channelId) => (calls++, ok(channelId)) });
  await late.scheduler.start();
  assert.equal(calls, 1);
});

test('TOPIC-SCHED-03: 模型失败当天按 30 分钟退避重试，成功后封盘', async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  let calls = 0;
  const failing = async (channelId) => {
    calls += 1;
    return { channelId, dayKey: localDayKey(at(4, 5)), createdTopicIds: [], updatedTopicIds: [], assignedEntryIds: [], skippedReason: 'model-failed' };
  };

  const first = makeScheduler({ now: at(4, 0), run: failing });
  await first.scheduler.start();
  assert.equal(calls, 1);

  const tooEarly = makeScheduler({ now: at(4, 20), run: failing });
  await tooEarly.scheduler.start();
  assert.equal(calls, 1);

  const retry = makeScheduler({ now: at(4, 31), run: async (channelId) => (calls++, ok(channelId)) });
  await retry.scheduler.start();
  assert.equal(calls, 2);

  const sealed = makeScheduler({ now: at(5, 0), run: failing });
  await sealed.scheduler.start();
  assert.equal(calls, 2);
});

test('TOPIC-SCHED-04: runNow(force) 无视日切水位，force 透传给聚合器', async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  const seen = [];
  const { scheduler } = makeScheduler({
    now: at(4, 5),
    run: async (channelId, options) => {
      seen.push(options.force === true);
      return ok(channelId);
    },
  });
  await scheduler.start();
  await scheduler.runNow(true);
  await scheduler.runNow(true);
  assert.deepEqual(seen, [false, true, true]);
});

test('TOPIC-SCHED-05: 水位文件损坏时按空状态启动并告警，不阻断调度', async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, '{broken', 'utf8');
  const warnings = [];
  let calls = 0;
  const scheduler = new TopicScheduler(CONFIG, {
    channels: () => ['g1'],
    run: async (channelId) => (calls++, ok(channelId)),
    statePath: STATE_PATH,
    now: () => at(4, 5),
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  await scheduler.start();
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
});

test('TOPIC-SCHED-06: 并发 runNow 同群只真正执行一次（单群锁）', async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { scheduler } = makeScheduler({
    now: at(3, 0),
    run: async (channelId) => {
      calls += 1;
      await gate;
      return ok(channelId);
    },
  });

  const first = scheduler.runNow(true);
  const second = scheduler.runNow(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1, '并发 runNow 不得对同一个群双跑');

  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].channelId, b[0].channelId);
  assert.deepEqual(a[0].createdTopicIds, b[0].createdTopicIds);
});

test('TOPIC-SCHED-07: 并发写水位后文件仍是完整 JSON（临时名递增 + 串行落盘）', async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { scheduler } = makeScheduler({
    now: at(3, 0),
    channels: ['g1', 'g2'],
    run: async (channelId) => {
      await gate;
      return ok(channelId);
    },
  });

  const runs = [scheduler.runChannelNow('g1'), scheduler.runChannelNow('g2')];
  release();
  const results = await Promise.all(runs);
  assert.equal(results.length, 2);

  const text = await fs.readFile(STATE_PATH, 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.channels).sort(), ['g1', 'g2']);

  const leftovers = (await fs.readdir(TEST_DIR)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '临时文件必须被 rename 消费干净');
});
