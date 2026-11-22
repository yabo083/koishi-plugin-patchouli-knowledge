import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TUNING_DECAY_FACTOR,
  TUNING_LIMITS,
  createTuningState,
  updateParameters,
} from '../lib/index.js';

const ANCHOR = { minBurstRate: 6, minDiscussionMessages: 12, thetaMin: 20 };
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

const closeTo = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
};

test('TUNING-01: 时间向心力按 0.85^hours 向 ANCHOR 回落', () => {
  const update = updateParameters(
    { minBurstRate: 8, minDiscussionMessages: 16, lastUpdated: NOW - 2 * HOUR },
    null,
    ANCHOR,
    NOW,
  );

  assert.equal(update.action, 'NEUTRAL', '无反馈时只发生时间衰减');
  closeTo(update.decayFactor, 0.7225, '两小时衰减系数');
  closeTo(update.parameters.minBurstRate, 6 + 2 * 0.7225, '速率门限向 6 回落');
  closeTo(update.parameters.minDiscussionMessages, 12 + 4 * 0.7225, '消息门限向 12 回落');
  assert.equal(update.lastUpdated, NOW, 'lastUpdated 推进到本次结算时刻');
  assert.deepEqual(update.clamped, []);
  assert.equal(TUNING_DECAY_FACTOR, 0.85);
});

test('TUNING-02: 长时间无反馈即可自己解除高位死锁', () => {
  const update = updateParameters(
    { minBurstRate: 8, minDiscussionMessages: 16, lastUpdated: NOW - 6 * HOUR },
    null,
    ANCHOR,
    NOW,
  );
  const factor = 0.85 ** 6;

  closeTo(update.decayFactor, factor, '六小时衰减系数');
  assert.equal(update.parameters.minBurstRate, 6.754, '速率门限回到 6.754');
  assert.equal(update.parameters.minDiscussionMessages, 13.509, '消息门限回到 13.509');
  assert.ok(update.parameters.minBurstRate < 7, '不再滞留在上限');
  assert.ok(update.parameters.minDiscussionMessages < 14, '不再滞留在上限');
});

test('TUNING-03: 舍弃归因驱动非对称小步反馈', () => {
  const atAnchor = { ...ANCHOR, lastUpdated: NOW };

  const lowDensity = updateParameters(
    atAnchor,
    { shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.1 },
    ANCHOR,
    NOW,
  );
  assert.equal(lowDensity.action, 'LOW_DENSITY');
  // 连续化步进：minBurstRate += 0.1 + 0.4×(1−q)，q=0.1 → +0.46。
  closeTo(lowDensity.parameters.minBurstRate, 6.46, 'LOW_DENSITY 按质量分收紧 0.46');
  closeTo(lowDensity.parameters.minDiscussionMessages, 13, 'LOW_DENSITY 加性增 1');

  const fragmented = updateParameters(
    atAnchor,
    { shouldDiscard: true, discardReason: 'FRAGMENTED', qualityScore: 0.2 },
    ANCHOR,
    NOW,
  );
  assert.equal(fragmented.action, 'FRAGMENTED');
  closeTo(fragmented.parameters.minBurstRate, 5.8, 'FRAGMENTED 略降速率门槛');
  closeTo(fragmented.parameters.minDiscussionMessages, 14, 'FRAGMENTED 提高完整度门槛');

  const noise = updateParameters(
    atAnchor,
    { shouldDiscard: true, discardReason: 'NOISE_SPAM', qualityScore: 0.05 },
    ANCHOR,
    NOW,
  );
  assert.equal(noise.action, 'NOISE_SPAM');
  assert.deepEqual(noise.parameters, ANCHOR, 'NOISE_SPAM 不动物理门限（交给噪声滤波）');

  const unknown = updateParameters(
    atAnchor,
    { shouldDiscard: true, discardReason: '模型随手写的自由文本', qualityScore: 0.1 },
    ANCHOR,
    NOW,
  );
  assert.equal(unknown.action, 'LOW_DENSITY', '未知归因按日常闲聊误触保守收紧');
  closeTo(unknown.parameters.minBurstRate, 6.46, '未知归因走 LOW_DENSITY 连续步进');
});

test('TUNING-04: 高价值讨论才放宽，且舍弃判定优先于评分', () => {
  const atAnchor = { ...ANCHOR, lastUpdated: NOW };

  const high = updateParameters(atAnchor, { shouldDiscard: false, qualityScore: 0.8 }, ANCHOR, NOW);
  assert.equal(high.action, 'HIGH_QUALITY');
  closeTo(high.parameters.minBurstRate, 5.85, 'HIGH_QUALITY 放宽 0.15');
  closeTo(high.parameters.minDiscussionMessages, 11.5, 'HIGH_QUALITY 放宽 0.5');

  const below = updateParameters(atAnchor, { shouldDiscard: false, qualityScore: 0.79 }, ANCHOR, NOW);
  assert.equal(below.action, 'NEUTRAL');
  assert.deepEqual(below.parameters, ANCHOR, '未达 0.8 不放宽');

  const discardWins = updateParameters(
    atAnchor,
    { shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.95 },
    ANCHOR,
    NOW,
  );
  assert.equal(discardWins.action, 'LOW_DENSITY');
  // 高分舍弃的收紧量更小：minBurstRate += 0.1 + 0.4×(1−0.95) = +0.12。
  closeTo(discardWins.parameters.minBurstRate, 6.12, '舍弃时无视高分，但只按该分值小幅收紧');
});

test('TUNING-05: 硬限幅恒成立（minBurstRate 3~8 / minDiscussionMessages 6~16 / thetaMin 10~60）', () => {
  assert.deepEqual(TUNING_LIMITS.minBurstRate, [3, 8]);
  assert.deepEqual(TUNING_LIMITS.minDiscussionMessages, [6, 16]);
  assert.deepEqual(TUNING_LIMITS.thetaMin, [10, 60]);

  const over = updateParameters(
    { minBurstRate: 20, minDiscussionMessages: 30, lastUpdated: NOW },
    null,
    { minBurstRate: 20, minDiscussionMessages: 30 },
    NOW,
  );
  assert.deepEqual(over.parameters, { minBurstRate: 8, minDiscussionMessages: 16, thetaMin: 20 });
  assert.deepEqual(over.clamped.sort(), ['minBurstRate', 'minDiscussionMessages']);

  const under = updateParameters(
    { minBurstRate: 3, minDiscussionMessages: 6, lastUpdated: NOW },
    { shouldDiscard: false, qualityScore: 0.95 },
    { minBurstRate: 3, minDiscussionMessages: 6 },
    NOW,
  );
  assert.deepEqual(under.parameters, { minBurstRate: 3, minDiscussionMessages: 6, thetaMin: 20 });
  assert.deepEqual(under.clamped.sort(), ['minBurstRate', 'minDiscussionMessages']);
});

test('TUNING-06: 初始状态与非法输入收敛到锚点/默认值', () => {
  const created = createTuningState({ minBurstRate: 2, minDiscussionMessages: 40 }, NOW);
  assert.deepEqual(created, {
    minBurstRate: 3,
    minDiscussionMessages: 16,
    thetaMin: 20,
    lastUpdated: NOW,
  });

  const fallback = updateParameters(
    { minBurstRate: Number.NaN, minDiscussionMessages: Number.POSITIVE_INFINITY, lastUpdated: NOW },
    undefined,
    {},
    NOW,
  );
  assert.deepEqual(fallback.parameters, { minBurstRate: 6, minDiscussionMessages: 12, thetaMin: 20 });
  assert.deepEqual(
    Object.keys(fallback.parameters).sort(),
    ['minBurstRate', 'minDiscussionMessages', 'thetaMin'],
    '控制器只暴露三个物理门限',
  );
  closeTo(fallback.decayFactor, 1, '同一时刻无衰减');
});

test('AIMD-08: target=potential 时步进作用于 Θ_min，速率门限零步进', () => {
  const atAnchor = { ...ANCHOR, lastUpdated: NOW };
  const potential = { target: 'potential' };

  const lowDensity = updateParameters(
    atAnchor,
    { shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.1 },
    ANCHOR,
    NOW,
    potential,
  );
  assert.equal(lowDensity.action, 'LOW_DENSITY');
  // 连续化：thetaMin += 0.5 + 2.5×(1−q)，q=0.1 → 0.5 + 2.25 = +2.75。
  closeTo(lowDensity.parameters.thetaMin, 22.75, 'LOW_DENSITY 按质量分抬高 Θ_min 2.75');
  closeTo(lowDensity.parameters.minBurstRate, 6, '势能层的步进不移动速率门限');
  closeTo(lowDensity.parameters.minDiscussionMessages, 13, '完整度门限照常加性增 1');

  const fragmented = updateParameters(
    atAnchor,
    { shouldDiscard: true, discardReason: 'FRAGMENTED', qualityScore: 0.2 },
    ANCHOR,
    NOW,
    potential,
  );
  assert.equal(fragmented.action, 'FRAGMENTED');
  closeTo(fragmented.parameters.thetaMin, 19, 'FRAGMENTED 放宽 Θ_min 1.0');
  closeTo(fragmented.parameters.minBurstRate, 6, '速率门限零步进');
  closeTo(fragmented.parameters.minDiscussionMessages, 14, '完整度门限加 2');

  const high = updateParameters(atAnchor, { shouldDiscard: false, qualityScore: 0.9 }, ANCHOR, NOW, potential);
  assert.equal(high.action, 'HIGH_QUALITY');
  closeTo(high.parameters.thetaMin, 19, 'HIGH_QUALITY 放宽 Θ_min 1.0');
  closeTo(high.parameters.minBurstRate, 6, '速率门限零步进');

  const noise = updateParameters(
    atAnchor,
    { shouldDiscard: true, discardReason: 'NOISE_SPAM', qualityScore: 0.05 },
    ANCHOR,
    NOW,
    potential,
  );
  assert.equal(noise.action, 'NOISE_SPAM');
  assert.deepEqual(noise.parameters, ANCHOR, 'NOISE_SPAM 对 Θ_min 同样零步进');

  // 输出恒在 [10, 60]：上下边界都由 `thetaMin` 进入 clamped
  const highAnchor = { minBurstRate: 6, minDiscussionMessages: 12, thetaMin: 59.5, lastUpdated: NOW };
  const over = updateParameters(
    highAnchor,
    { shouldDiscard: true, discardReason: 'LOW_DENSITY' },
    highAnchor,
    NOW,
    potential,
  );
  assert.equal(over.parameters.thetaMin, 60, 'Θ_min 上界 60');
  assert.ok(over.clamped.includes('thetaMin'), `越界键必须进入 clamped，实际 ${over.clamped.join(',')}`);

  const lowAnchor = { minBurstRate: 6, minDiscussionMessages: 12, thetaMin: 10, lastUpdated: NOW };
  const under = updateParameters(
    lowAnchor,
    { shouldDiscard: false, qualityScore: 0.95 },
    lowAnchor,
    NOW,
    potential,
  );
  assert.equal(under.parameters.thetaMin, 10, 'Θ_min 下界 10');
  assert.ok(under.clamped.includes('thetaMin'));
});

test('TUNING-10: target=both 同步步进两套绝对门限，衰减只算一次', () => {
  // shadow 对照专用：势能侧若只吃时间衰减，比较时就是被让子。
  const signal = { shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.2 };
  const both = updateParameters(
    { minBurstRate: 6, minDiscussionMessages: 12, thetaMin: 20, lastUpdated: NOW },
    signal,
    ANCHOR,
    NOW,
    { target: 'both' },
  );
  const rateOnly = updateParameters(
    { minBurstRate: 6, minDiscussionMessages: 12, thetaMin: 20, lastUpdated: NOW },
    signal,
    ANCHOR,
    NOW,
    { target: 'rate' },
  );
  const potOnly = updateParameters(
    { minBurstRate: 6, minDiscussionMessages: 12, thetaMin: 20, lastUpdated: NOW },
    signal,
    ANCHOR,
    NOW,
    { target: 'potential' },
  );

  assert.ok(both.parameters.minBurstRate > rateOnly.parameters.minBurstRate - 1e-9, 'minBurstRate 必须与 rate 分支同步抬升');
  closeTo(both.parameters.minBurstRate, rateOnly.parameters.minBurstRate, 'both 的 minBurstRate 等于 rate 分支');
  closeTo(both.parameters.thetaMin, potOnly.parameters.thetaMin, 'both 的 thetaMin 等于 potential 分支');
  closeTo(
    both.parameters.minDiscussionMessages,
    rateOnly.parameters.minDiscussionMessages,
    'minDiscussionMessages 只加一次，不能两倍步进',
  );
  closeTo(both.decayFactor, 1, '同一时刻调用衰减为 1，不存在双倍衰减');
});

test('TUNING-11: LOW_DENSITY 按质量分连续收紧，both 目标两侧同步', () => {
  const atAnchor = { ...ANCHOR, lastUpdated: NOW };
  const tune = (signal, target) => updateParameters(atAnchor, signal, ANCHOR, NOW, { target });
  const lowSignal = { shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.15 };
  const mildSignal = { shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.45 };

  const lowBoth = tune(lowSignal, 'both');
  const mildBoth = tune(mildSignal, 'both');
  const lowRate = tune(lowSignal, 'rate');
  const lowPotential = tune(lowSignal, 'potential');

  // q=0.15 → Θ_min +2.625（≈+2.6）、速率 +0.44；q=0.45 → Θ_min +1.875（≈+1.9）、速率 +0.32。
  closeTo(lowBoth.parameters.thetaMin, 20 + 2.625, '低分判废的 Θ_min 步进 = 0.5 + 2.5×0.85');
  closeTo(lowBoth.parameters.minBurstRate, 6 + 0.44, '低分判废的速率步进 = 0.1 + 0.4×0.85');
  closeTo(mildBoth.parameters.thetaMin, 20 + 1.875, '中低分判废的 Θ_min 步进 = 0.5 + 2.5×0.55');
  closeTo(mildBoth.parameters.minBurstRate, 6 + 0.32, '中低分判废的速率步进 = 0.1 + 0.4×0.55');

  assert.ok(
    lowBoth.parameters.thetaMin > mildBoth.parameters.thetaMin,
    '判废越狠（q 越低）Θ_min 收紧越多',
  );
  assert.ok(
    lowBoth.parameters.minBurstRate > mildBoth.parameters.minBurstRate,
    '判废越狠（q 越低）速率门限收紧越多',
  );

  // both：两侧各走自身步进，完整度门限只加一次，衰减只算一次。
  closeTo(lowBoth.parameters.minBurstRate, lowRate.parameters.minBurstRate, 'both 的速率侧等于 rate 分支');
  closeTo(lowBoth.parameters.thetaMin, lowPotential.parameters.thetaMin, 'both 的势能侧等于 potential 分支');
  closeTo(lowBoth.parameters.minDiscussionMessages, 13, 'minDiscussionMessages 恒 +1，不双倍');
  closeTo(lowBoth.decayFactor, 1, '同一时刻调用衰减为 1');

  // 评分缺失 / 非法：退化为原固定步进 +0.25 / +1.5（老信号行为逐位不变）。
  const cases = [
    ['缺失', { shouldDiscard: true, discardReason: 'LOW_DENSITY' }],
    ['NaN', { shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: Number.NaN }],
    ['非数值', { shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: '0.2' }],
  ];
  for (const [label, signal] of cases) {
    const update = tune(signal, 'both');
    closeTo(update.parameters.thetaMin, 21.5, `${label}评分退化为固定 Θ_min +1.5`);
    closeTo(update.parameters.minBurstRate, 6.25, `${label}评分退化为固定速率 +0.25`);
  }

  // 评分越界夹到 [0,1]：只剩步进下界 / 上界。
  closeTo(tune({ shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 2 }, 'both').parameters.thetaMin, 20.5, '上限夹紧后 Θ_min 步进 = 0.5');
  closeTo(tune({ shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 2 }, 'both').parameters.minBurstRate, 6.1, '上限夹紧后速率步进 = 0.1');
  closeTo(tune({ shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: -1 }, 'both').parameters.thetaMin, 23, '下限夹紧后 Θ_min 步进 = 3.0');
  closeTo(tune({ shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: -1 }, 'both').parameters.minBurstRate, 6.5, '下限夹紧后速率步进 = 0.5');

  // 其余分支与评分无关（连续化只作用于 LOW_DENSITY）。
  const fragmentedLow = tune({ shouldDiscard: true, discardReason: 'FRAGMENTED', qualityScore: 0.05 }, 'both');
  const fragmentedHigh = tune({ shouldDiscard: true, discardReason: 'FRAGMENTED', qualityScore: 0.95 }, 'both');
  closeTo(fragmentedLow.parameters.thetaMin, 19, 'FRAGMENTED 的 Θ_min 步进与评分无关');
  closeTo(fragmentedLow.parameters.minBurstRate, 5.8, 'FRAGMENTED 的速率步进与评分无关');
  closeTo(fragmentedHigh.parameters.thetaMin, fragmentedLow.parameters.thetaMin, 'FRAGMENTED 不随评分漂移');
  assert.deepEqual(
    tune({ shouldDiscard: true, discardReason: 'NOISE_SPAM', qualityScore: 0.02 }, 'both').parameters,
    ANCHOR,
    'NOISE_SPAM 恒零步进',
  );
  closeTo(
    tune({ shouldDiscard: false, qualityScore: 0.8 }, 'both').parameters.thetaMin,
    19,
    'HIGH_QUALITY 固定放宽 1.0，与评分高低无关',
  );
});
