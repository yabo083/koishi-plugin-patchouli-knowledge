/**
 * 三层加固回归测试：静默衰减 / 绝对速率天花板 / 双向学习闸门。
 *
 * 用例 A（静默衰减 + 慢热递增）：高位基线在长静默后向底噪回落，
 *   慢热型讨论（真实 01:27-02:06 形态）不再被高位基线锁死，能在 01:28~01:30 进入 BURSTING。
 * 用例 B（下行学习）：速率持续低于基线时基线正常向下收敛，不发生高位死锁。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASELINE_DECAY_HALF_LIFE_MS,
  BaselineEstimator,
  BurstQuiescenceDetector,
  DEFAULT_MAX_BURST_CEILING_RATIO,
  MIN_BASELINE_FLOOR,
} from '../lib/index.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** 01:27 作为逻辑时间原点（真实故障复现时间轴）。 */
const BASE_TIME = 1_700_000_000_000;

const CHANNEL = 'group-decay-ceiling';

function makeMessage(id, offsetMs, index) {
  return {
    id,
    channelId: CHANNEL,
    userId: `user-${index % 3}`,
    userName: `群友${index % 3}`,
    content: `论点 #${index}：模块化设计的第 ${index} 个取舍，需要继续讨论其可行性与维护代价。`,
    timestamp: BASE_TIME + offsetMs,
  };
}

/** 永不定时触发的调度器：测试完全由消息驱动，避免真实等待与进程悬挂。 */
const inertScheduler = () => () => {};

function createDetector(initialRate) {
  const settled = [];
  const baseline = new BaselineEstimator({
    alpha: 0.05,
    initialRate,
    sampleWindowSeconds: 60,
  });
  const clock = { now: BASE_TIME - 3 * 60 * MINUTE };

  const detector = new BurstQuiescenceDetector({
    options: {
triggerMode: 'rate', triggerMode: 'rate',
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      minDiscussionMessages: 12,
      baselineEwmaAlpha: 0.05,
    },
    baseline,
    now: () => clock.now,
    scheduler: inertScheduler,
    onQuiescence: (session) => {
      settled.push(session);
    },
  });

  return { detector, baseline, clock, settled };
}

test('DECAY-A: 长静默后基线回落至底噪，慢热讨论可在 01:28~01:30 进入 BURSTING', () => {
  const { detector, baseline, clock } = createDetector(4.0);

  // 冷启动前的既有基线：4.0 条/分，最后观测时间 = 01:27 之前 3 小时。
  const seedAt = BASE_TIME - 3 * 60 * MINUTE;
  baseline.setInitialRate(CHANNEL, 4.0);
  baseline.record(CHANNEL, seedAt, { sampleRate: 4.0, learn: true });
  assert.equal(baseline.getLastTimestamp(CHANNEL), seedAt, 'getLastTimestamp 应返回种子样本时间');
  assert.equal(baseline.getRate(CHANNEL), 4.0, '预热基线应为 4.0 条/分');

  // 01:27：静默 3 小时后的第一条消息 —— 先执行真实时间差指数衰减。
  clock.now = BASE_TIME;
  const first = detector.onMessage(makeMessage('silence-break', 0, 0));

  assert.ok(
    Math.abs(first.baselineRate - MIN_BASELINE_FLOOR) < 1e-3,
    `3 小时静默后基线应回落至底噪 ${MIN_BASELINE_FLOOR}，实际 ${first.baselineRate}`,
  );
  // 3 小时 ≫ 多少个衰减半衰期：结果必须紧贴底噪而非「只降一点」。
  assert.ok(
    3 * 3600_000 > 10 * BASELINE_DECAY_HALF_LIFE_MS,
    '道具时间轴应覆盖多个衰减时间常数',
  );
  assert.equal(first.phase, 'IDLE');

  // 慢热递增消息流：20s/条 → 10s/条 → 7s/条（模拟 01:27-02:06 的真实讨论爬坡）。
  const offsets = [];
  let offset = 0;
  for (let step = 0; step < 3; step += 1) {
    offset += 20 * SECOND;
    offsets.push(offset);
  }
  for (let step = 0; step < 6; step += 1) {
    offset += 10 * SECOND;
    offsets.push(offset);
  }
  for (let step = 0; step < 40; step += 1) {
    offset += 7 * SECOND;
    offsets.push(offset);
  }

  let burstOffset = null;
  let burstRate = 0;
  let burstBaseline = 0;

  for (let index = 0; index < offsets.length; index += 1) {
    const at = offsets[index];
    clock.now = BASE_TIME + at;
    const metrics = detector.onMessage(makeMessage(`ramp-${index}`, at, index + 1));

    if (burstOffset === null) {
      // 爬坡期基线不得被上行样本污染（上行闸门只在真正贴底噪时放行）。
      assert.ok(
        metrics.baselineRate < MIN_BASELINE_FLOOR * 1.5,
        `爬坡期基线不应被抬高，位置 ${at / SECOND}s 实际 ${metrics.baselineRate}`,
      );
    }

    if (metrics.phase === 'BURSTING' && burstOffset === null) {
      burstOffset = at;
      burstRate = metrics.currentRate;
      burstBaseline = metrics.baselineRate;
      break;
    }
  }

  assert.notEqual(burstOffset, null, '慢热递增讨论必须能进入 BURSTING（不得被基线高位锁死）');
  assert.ok(
    burstOffset >= 60 * SECOND && burstOffset <= 180 * SECOND,
    `应在 01:28~01:30 触发 BURSTING，实际偏移 ${burstOffset / SECOND}s`,
  );
  // 天花板：动态门限不得越过 minBurstRate × 1.8。
  const ceiling = 6 * DEFAULT_MAX_BURST_CEILING_RATIO;
  assert.ok(
    burstRate > 6 && burstRate <= ceiling,
    `触发速率应落在 (6, ${ceiling}]，实际 ${burstRate}`,
  );
  assert.ok(burstBaseline <= MIN_BASELINE_FLOOR * 1.5, `触发时基线应仍贴底噪，实际 ${burstBaseline}`);

  detector.dispose();
});

test('DECAY-B: 速率持续低于基线时基线向下收敛，不发生高位死锁', () => {
  const { detector, baseline, clock, settled } = createDetector(4.5);
  // 无静默间隔：最后观测就在本条消息之前 20 秒（不触发衰减，只考察下行学习）。
  const seedAt = BASE_TIME - 20 * SECOND;
  baseline.setInitialRate(CHANNEL, 4.5);
  baseline.record(CHANNEL, seedAt, { sampleRate: 4.5, learn: true });

  const samples = [];
  const totalSamples = 15; // 5 分钟，每 20 秒一条 → 3 条/分

  for (let index = 0; index < totalSamples; index += 1) {
    const at = index * 20 * SECOND;
    clock.now = BASE_TIME + at;
    const metrics = detector.onMessage(makeMessage(`steady-${index}`, at, index));

    assert.equal(metrics.phase, 'IDLE', '3 条/分不应触发突发');
    assert.ok(metrics.currentRate <= 3.0 + 1e-9, `瞬时速率应为 3 条/分，实际 ${metrics.currentRate}`);
    samples.push(metrics.baselineRate);
  }

  // 单调不增：任何一步都不得反向抬升基线。
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(
      samples[index] <= samples[index - 1] + 1e-9,
      `基线应单调向下收敛，第 ${index} 步 ${samples[index - 1]} → ${samples[index]}`,
    );
  }

  const finalBaseline = samples[samples.length - 1];
  assert.ok(
    finalBaseline <= 4.5 - 0.5,
    `5 分钟后基线应至少回落 0.5 条/分（向下收敛生效），实际 ${finalBaseline}`,
  );
  assert.ok(
    finalBaseline < 4.0,
    `基线应已脱离高位（< 4.0 条/分），实际 ${finalBaseline}`,
  );
  assert.ok(finalBaseline >= 3.0, `基线不应跌破样本速率，实际 ${finalBaseline}`);
  assert.equal(baseline.getRate(CHANNEL), finalBaseline, '估算器读回的基线应与度量一致');
  assert.equal(settled.length, 0, '稳态低速率不应产出沉淀会话');

  detector.dispose();
});
