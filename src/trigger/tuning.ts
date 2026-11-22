/**
 * 触发门限的宿主侧非对称 AIMD（Additive Increase / Multiplicative Decrease）控制器。
 *
 * 设计红线：**模型不再输出任何参数绝对值**。旧实现让 LLM 每轮给出
 * `parameterFeedback` 绝对数值并持久化，结果只会单向抬门限——一次「本轮未沉淀」
 * 就把 `minBurstRate` / `minDiscussionMessages` 往上推，下一次更难触发，触发次数与
 * 沉淀量一起单调下降到死锁。
 *
 * 现在模型只输出两个**无量纲信号**：
 * - `qualityScore`（0~1，知识密度与论述深度）；
 * - `discardReason`（舍弃归因，三选一）。
 *
 * 宿主用下面两条力把物理门限拉回可用区间：
 *
 * 1. **时间向心力**：每次结算都先把参数按 `0.85^hours` 向配置锚点（ANCHOR）回落。
 *    即使连续误判把门限推到上限，只要一段时间没有新的反馈，参数也会自己走回基线，
 *    从机制上打破「越调越死」的锁死。
 * 2. **步进反馈**（非对称，小步且方向可逆）：步进只作用于当前判据层的绝对门限
 *    （`rate` / `shadow` → `minBurstRate`，`potential` → `thetaMin`），`minDiscussionMessages`
 *    两层共用：
 *    - `LOW_DENSITY`（日常闲聊误触）：加性增、且**按质量分连续化**——判废越狠（`qualityScore`
 *      越低）收紧越多：`thetaMin += 0.5 + 2.5×(1−q)`、`minBurstRate += 0.1 + 0.4×(1−q)`、
 *      `minDiscussionMessages +1`；评分缺失 / 非法退化为原固定步进 `+0.25` / `+1.5`（`q` 夹到 `[0,1]`）；
 *    - `FRAGMENTED`（切太早、话题碎片化）：更看重完整度，`minDiscussionMessages +2`、
 *      同时略降绝对门限 `minBurstRate -0.2` / `thetaMin -1.0`（让稍慢但更完整的讨论也能进入）；
 *    - `NOISE_SPAM`（复读发癫）：物理门限**不动**，交给信息熵/确定性噪声滤波拦截；
 *    - 成功沉淀且 `qualityScore >= 0.8`（高价值讨论）：适度放宽，`minBurstRate -0.15` /
 *      `thetaMin -1.0`、`minDiscussionMessages -0.5`。
 * 3. **硬限幅**：无论锚点或历史值如何，输出永远落在
 *    `minBurstRate ∈ [3.0, 8.0]`、`minDiscussionMessages ∈ [6, 16]`、`thetaMin ∈ [10, 60]`。
 *
 * 该模块是纯函数，不读写存储、不依赖触发器实例；插件层负责把结果写回
 * `detector.updateOptions()` 并随 `CadenceStateSnapshot.updatedAt` 持久化 `lastUpdated`。
 */

import type { DiscardReason } from '../types';

/** AIMD 控制的三个物理门限。 */
export interface TuningParameters {
  /** 突发速率保底（条/分）；仅 `rate` 模式参与步进。 */
  minBurstRate: number;
  /** 一轮有效沉淀所需的最低消息数。 */
  minDiscussionMessages: number;
  /** 势能突发门限下限 Θ_min（nat）；仅 `potential` 模式参与步进（`shadow` 用 rate 目标，它只受时间衰减）。 */
  thetaMin: number;
}

/**
 * AIMD 步进作用的目标判据层：
 * - `rate` 只调 `minBurstRate`；
 * - `potential` 只调 `thetaMin`；
 * - `both` 两套绝对门限同步步进（衰减只算一次）——`shadow` 对照专用：
 *   两侧共用同一个控制器、同一个信号与同一个时钟，才是「同等条件」的比较，
 *   否则势能侧只受时间衰减、永远追不上本群量级，等于被判据层人为让子。
 */
export type TuningTarget = 'rate' | 'potential' | 'both';

/** 一次校准的可选行为开关。 */
export interface TuningOptions {
  /** 步进作用的判据层，默认 `'rate'`（`minDiscussionMessages` 恒参与）。 */
  target?: TuningTarget;
}

/** 带时间戳的控制器状态（`lastUpdated` 用于时间向心力衰减）。 */
export interface TuningState extends TuningParameters {
  /** 上次校准时刻（epoch 毫秒）。 */
  lastUpdated: number;
}

/** 模型单轮输出的无量纲反馈信号。 */
export interface TuningSignal {
  /** 模型是否判定本轮不沉淀。 */
  shouldDiscard?: boolean;
  /** 舍弃归因；仅 `shouldDiscard === true` 时有意义。 */
  discardReason?: DiscardReason | null;
  /** 知识密度评分（0~1）；非有限值按「无信号」处理。 */
  qualityScore?: number;
}

/** 本次反馈实际触发的动作（时间衰减恒发生，不单独记入 action）。 */
export type TuningAction = 'NEUTRAL' | 'LOW_DENSITY' | 'FRAGMENTED' | 'NOISE_SPAM' | 'HIGH_QUALITY';

/** 一次校准的完整结果。 */
export interface TuningUpdate {
  /** 校准后的门限（已含时间衰减、步进反馈与硬限幅）。 */
  parameters: TuningParameters;
  /** 本次校准时刻（下次衰减的起点）。 */
  lastUpdated: number;
  /** 本次命中的反馈分支；`NEUTRAL` 表示没有产生步进。 */
  action: TuningAction;
  /** 实际生效的时间衰减系数 `0.85^hours`（1 = 无衰减）。 */
  decayFactor: number;
  /** 被硬限幅夹回的字段（用于日志）。 */
  clamped: Array<keyof TuningParameters>;
}

/** 时间向心力底数：每小时向锚点回落 15%。 */
export const TUNING_DECAY_FACTOR = 0.85;

/** 三个物理门限的硬限幅区间（含端点）。 */
export const TUNING_LIMITS = {
  minBurstRate: [3.0, 8.0],
  minDiscussionMessages: [6, 16],
  thetaMin: [10, 60],
} as const satisfies Record<keyof TuningParameters, readonly [number, number]>;

/** 锚点/历史值都不可用时的兜底值（与 `DEFAULT_TRIGGER_OPTIONS` 口径一致）。 */
export const DEFAULT_TUNING_PARAMETERS: Readonly<TuningParameters> = Object.freeze({
  minBurstRate: 6,
  minDiscussionMessages: 12,
  thetaMin: 20,
});

/** 高价值讨论的评分阈值。 */
export const HIGH_QUALITY_THRESHOLD = 0.8;

/**
 * 各反馈分支的小步增量：正数收紧门限，负数放宽门限。
 *
 * `rate` 层用 `minBurstRate`，`potential` 层用 `thetaMin`；两者互为镜像（收紧 = 抬高门限），
 * `minDiscussionMessages` 两层共用同一组步进。`STEP_LOW_DENSITY` 只在评分缺失 / 非法时兜底，
 * 有 `qualityScore` 时走 {@link resolveLowDensityStep} 的连续化步进。
 */
const STEP_LOW_DENSITY: Readonly<TuningParameters> = {
  minBurstRate: 0.25,
  minDiscussionMessages: 1,
  thetaMin: 1.5,
};
const STEP_FRAGMENTED: Readonly<TuningParameters> = {
  minBurstRate: -0.2,
  minDiscussionMessages: 2,
  thetaMin: -1.0,
};
const STEP_HIGH_QUALITY: Readonly<TuningParameters> = {
  minBurstRate: -0.15,
  minDiscussionMessages: -0.5,
  thetaMin: -1.0,
};

/**
 * `LOW_DENSITY` 连续化系数：步进随 `1−q` 线性放大（`q` 已在 `[0,1]` 内）。
 *
 * 固定小步分不出「过阈且勉强」与「纯水」两种情况——q=0.45 与 q=0.05 的一轮被同样收紧，
 * 判废证据白丢。连续化后收缩量 = 下界 + 跨度 × (1−q)：
 * `thetaMin ∈ [0.5, 3.0]`、`minBurstRate ∈ [0.1, 0.5]`，缺省评分才退回固定 1.5 / 0.25。
 */
const LOW_DENSITY_STEP_FLOOR = { minBurstRate: 0.1, thetaMin: 0.5 } as const;
const LOW_DENSITY_STEP_SPAN = { minBurstRate: 0.4, thetaMin: 2.5 } as const;

/** 本轮 `LOW_DENSITY` 的实际步进：评分缺失 / 非法退化为固定小步。 */
function resolveLowDensityStep(qualityScore: number | undefined): Readonly<TuningParameters> {
  if (qualityScore === undefined) return STEP_LOW_DENSITY;
  const pressure = 1 - qualityScore;
  return {
    minBurstRate: LOW_DENSITY_STEP_FLOOR.minBurstRate + LOW_DENSITY_STEP_SPAN.minBurstRate * pressure,
    minDiscussionMessages: STEP_LOW_DENSITY.minDiscussionMessages,
    thetaMin: LOW_DENSITY_STEP_FLOOR.thetaMin + LOW_DENSITY_STEP_SPAN.thetaMin * pressure,
  };
}

const HOUR_MS = 3_600_000;

function toFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampToRange(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** 读取锚点：缺失/非有限值回落到默认参数。 */
function resolveAnchor(anchor: Partial<TuningParameters> | undefined): TuningParameters {
  return {
    minBurstRate: toFinite(anchor?.minBurstRate, DEFAULT_TUNING_PARAMETERS.minBurstRate),
    minDiscussionMessages: toFinite(
      anchor?.minDiscussionMessages,
      DEFAULT_TUNING_PARAMETERS.minDiscussionMessages,
    ),
    thetaMin: toFinite(anchor?.thetaMin, DEFAULT_TUNING_PARAMETERS.thetaMin),
  };
}

/** 归一化模型评分：只接受有限数，夹到 [0,1]；其他情况视为无信号。 */
function readQualityScore(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return clampToRange(value, 0, 1);
}

function readDiscardReason(signal: TuningSignal): DiscardReason {
  const reason = signal.discardReason;
  // 运行时仍可能收到旧模型/手写配置的字符串，未知归因按「日常闲聊误触」处理（保守收紧）。
  if (reason === 'NOISE_SPAM' || reason === 'FRAGMENTED' || reason === 'LOW_DENSITY') return reason;
  return 'LOW_DENSITY';
}

/**
 * 以锚点创建初始控制器状态（首次接入、快照缺失时使用）。
 */
export function createTuningState(
  anchor: Partial<TuningParameters> = {},
  now: number = Date.now(),
): TuningState {
  const resolved = resolveAnchor(anchor);
  return {
    minBurstRate: round3(clampToRange(resolved.minBurstRate, ...TUNING_LIMITS.minBurstRate)),
    minDiscussionMessages: round3(
      clampToRange(resolved.minDiscussionMessages, ...TUNING_LIMITS.minDiscussionMessages),
    ),
    thetaMin: round3(clampToRange(resolved.thetaMin, ...TUNING_LIMITS.thetaMin)),
    lastUpdated: toFinite(now, Date.now()),
  };
}

/**
 * 执行一次非对称 AIMD 校准。
 *
 * @param current 当前门限与上次校准时刻；缺失时以锚点为起点。
 * @param llmResult 模型本轮的无量纲反馈；`null`/`undefined` 表示只走时间衰减。
 * @param anchor 配置锚点（通常是 `config.trigger` 的三个门限）。
 * @param now 结算时刻（epoch 毫秒），默认 `Date.now()`。
 * @param options `target='potential'` 时把原本作用于 `minBurstRate` 的步进改作用于 `thetaMin`
 *   （`rate` 模式下 `thetaMin` 只受时间衰减影响）；`minDiscussionMessages` 两种目标共用同一组步进。
 */
export function updateParameters(
  current: (Partial<TuningParameters> & { lastUpdated?: number }) | undefined,
  llmResult: TuningSignal | null | undefined,
  anchor: Partial<TuningParameters>,
  now: number = Date.now(),
  options: TuningOptions = {},
): TuningUpdate {
  const at = toFinite(now, Date.now());
  const resolvedAnchor = resolveAnchor(anchor);
  const target: TuningTarget =
    options.target === 'both' ? 'both' : options.target === 'potential' ? 'potential' : 'rate';

  // 1. 时间向心力：先向锚点回落，再叠加本轮步进（顺序不可交换，否则衰减会吃掉反馈）。
  const lastUpdated = toFinite(current?.lastUpdated, at);
  const hours = Math.max(0, (at - lastUpdated) / HOUR_MS);
  const decayFactor = Math.pow(TUNING_DECAY_FACTOR, hours);

  let minBurstRate =
    resolvedAnchor.minBurstRate +
    (toFinite(current?.minBurstRate, resolvedAnchor.minBurstRate) - resolvedAnchor.minBurstRate) *
      decayFactor;
  let minDiscussionMessages =
    resolvedAnchor.minDiscussionMessages +
    (toFinite(current?.minDiscussionMessages, resolvedAnchor.minDiscussionMessages) -
      resolvedAnchor.minDiscussionMessages) *
      decayFactor;
  let thetaMin =
    resolvedAnchor.thetaMin +
    (toFinite(current?.thetaMin, resolvedAnchor.thetaMin) - resolvedAnchor.thetaMin) * decayFactor;

  // 2. 非对称步进反馈：只落在目标判据层，另一层的绝对门限不随反馈漂移。
  let action: TuningAction = 'NEUTRAL';
  const qualityScore = readQualityScore(llmResult?.qualityScore);
  const applyStep = (step: Readonly<TuningParameters>): void => {
    // 绝对门限按目标层步进；`both` 两层都走，但 `minDiscussionMessages` 只加一次。
    if (target !== 'potential') minBurstRate += step.minBurstRate;
    if (target === 'potential' || target === 'both') thetaMin += step.thetaMin;
    minDiscussionMessages += step.minDiscussionMessages;
  };
  if (llmResult?.shouldDiscard === true) {
    const reason = readDiscardReason(llmResult);
    action = reason;
    if (reason === 'FRAGMENTED') {
      applyStep(STEP_FRAGMENTED);
    } else if (reason === 'LOW_DENSITY') {
      // 判废越狠（q 越低）收紧越多；q 缺失 / 非有限值走固定小步兜底。
      applyStep(resolveLowDensityStep(qualityScore));
    }
  } else if (qualityScore !== undefined && qualityScore >= HIGH_QUALITY_THRESHOLD) {
    action = 'HIGH_QUALITY';
    applyStep(STEP_HIGH_QUALITY);
  }

  // 3. 硬限幅：任何锚点/历史值/反馈叠加都不能越出物理门限。
  const clamped: Array<keyof TuningParameters> = [];
  const roundedBurst = round3(minBurstRate);
  const burstLimited = clampToRange(roundedBurst, ...TUNING_LIMITS.minBurstRate);
  if (burstLimited !== roundedBurst) clamped.push('minBurstRate');
  const roundedMessages = round3(minDiscussionMessages);
  const messagesLimited = clampToRange(roundedMessages, ...TUNING_LIMITS.minDiscussionMessages);
  if (messagesLimited !== roundedMessages) clamped.push('minDiscussionMessages');
  const roundedTheta = round3(thetaMin);
  const thetaLimited = clampToRange(roundedTheta, ...TUNING_LIMITS.thetaMin);
  if (thetaLimited !== roundedTheta) clamped.push('thetaMin');

  return {
    parameters: {
      minBurstRate: burstLimited,
      minDiscussionMessages: messagesLimited,
      thetaMin: thetaLimited,
    },
    lastUpdated: at,
    action,
    decayFactor,
    clamped,
  };
}
