/**
 * Patchouli Knowledge — 可观测性（Telemetry）数据契约
 *
 * 本文件是遥测链路三方共享的唯一口径：Inspector 写入 / HTTP API 暴露 / 单测断言。
 *
 * 时间基准约定（全局不可违背）：所有遥测事件的 `at` 都取**触发器逻辑时间**
 * （最后一条被观测消息的逻辑时刻）。静默期不推进逻辑时间，因此离线仿真与真实运行
 * 完全同口径；跨群比较时也不会因为某个群长期静默而被误判为「陈旧数据」。
 * 唯一的例外是 `durationMs`（真实 I/O 耗时）与 `generatedAt`（响应时刻），
 * 二者必须使用墙钟，否则无法衡量真实延迟。
 */

import type { CadencePhase } from '../types';

/** 全局 trace 环形缓冲容量（`GET /api/telemetry` 的 traces 上限）。 */
export const TELEMETRY_TRACE_CAPACITY = 300;

/** 单频道 trace 保留条数（快照中每群载荷上限）。 */
export const TELEMETRY_CHANNEL_TRACE_CAPACITY = 50;

/** 基线账本的滑动窗口（毫秒）：1 小时。 */
export const BASELINE_LEDGER_WINDOW_MS = 3_600_000;

/** 基线账本事件缓冲上限：窗口内保留最近 N 条事件（有界内存，超出按 FIFO 覆盖）。 */
export const BASELINE_LEDGER_EVENT_CAPACITY = 1024;

/** NEAR_MISS 每频道频控窗口（毫秒）：3 分钟。 */
export const NEAR_MISS_COOLDOWN_MS = 180_000;

/** NEAR_MISS 判定比例：有效速率 ≥ 突发门限 × 该比例，且独立发言人 ≥ 2。 */
export const NEAR_MISS_RATE_RATIO = 0.7;

/** RSI 周期（步数）：Wilder 标准 14 步。 */
export const MOMENTUM_RSI_PERIOD = 14;

/** RSI 分母保护项（除零安全）。 */
export const MOMENTUM_EPSILON = 1e-9;

/** 遥测内部浮点比较容差（速率 / 基线增量）。 */
export const TELEMETRY_EPSILON = 1e-9;

/**
 * 遥测事件类型。
 *
 * - `PHASE_CHANGE`：状态机相位迁移（含瞬态向量）；
 * - `NEAR_MISS`：擦肩而过（IDLE 下速率逼近突发门限但未触发，带 3 分钟频控）；
 * - `COOLING_REARM`：进入冷却期并重置平息计时（延长倍率 / 剩余秒数）；
 * - `SESSION_FINALIZED`：一轮讨论平息结算并交付调度器；
 * - `SESSION_DISCARDED`：平息结算但消息数不足门限，判定丢弃；
 * - `DISPATCH_RESULT`：调度器单轮产物（耗时 / 质量分 / 丢弃归因）；
 * - `AIMD_TUNED`：AIMD 门限校准（调参前后值 / 命中分支 / 硬限幅夹回字段）。
 */
export type TelemetryEventKind =
  | 'PHASE_CHANGE'
  | 'NEAR_MISS'
  | 'COOLING_REARM'
  | 'SESSION_FINALIZED'
  | 'SESSION_DISCARDED'
  | 'DISPATCH_RESULT'
  | 'AIMD_TUNED';

/** `TelemetryEventKind` 全集（顺序固定），供聚合计数与前端枚举共用。 */
export const TELEMETRY_EVENT_KINDS: readonly TelemetryEventKind[] = [
  'PHASE_CHANGE',
  'NEAR_MISS',
  'COOLING_REARM',
  'SESSION_FINALIZED',
  'SESSION_DISCARDED',
  'DISPATCH_RESULT',
  'AIMD_TUNED',
];

/** `data` 允许的标量类型：只放数值 / 枚举 / 布尔 / null，绝不放消息正文或凭据。 */
export type TelemetryScalar = number | string | boolean | null;

/** 单条 trace 的结构化附加字段。 */
export type TelemetryData = Readonly<Record<string, TelemetryScalar>>;

/**
 * 单群闸门瞬态向量：某一观测锚点上的「为什么没触发 / 为什么触发」的全部判据。
 *
 * 判据层随该群的 `triggerMode` 走：`rate` / `shadow` 的相位由速率裁决，`rate` 与
 * `threshold` 是物理层滤波后的条/分且与触发器**同一口径**；`potential` 的相位由 Q/ρ
 * 裁决，`threshold` 是该群势能模式的自适应门限 Θ_burst，`rate` 仅作速率层观测保留。
 * 两套口径不得混用，否则 NEAR_MISS 判定会与相位裁决出现系统性偏差。
 */
export interface GateStatus {
  phase: CadencePhase;
  /** 有效消息速率（条/分，滤波后）。 */
  rate: number;
  /** 动态日常基线（条/分，EWMA）。 */
  baseline: number;
  /**
   * 触发门限：`rate` / `shadow` 下是速率门限（条/分，含 `minBurstRate × 1.8` 天花板）；
   * `potential` 下是势能门限 Θ_burst（与状态机同一个 `potentialBurstThreshold` 口径）。
   */
  threshold: number;
  /** `rate / max(baseline, 0.1)`，反映相对日常的放大倍数。 */
  burstRatio: number;
  /** 窗口内独立发言人数。 */
  speakers: number;
  /** 样本信息熵率（0..1）。 */
  entropy: number;
  /** 本次观测是否构成 NEAR_MISS 原始判定（未经频控；频控计数见 `counters`）。 */
  nearMiss: boolean;
  /** 本轮讨论缓冲消息数。 */
  buffered: number;
  /** 观测锚点（最后一条被观测消息的逻辑时刻，毫秒；无消息为 0）。 */
  lastMessageTime: number;
  /**
   * 势能层观测向量（shadow / potential 模式下必填，`rate` 模式整体省略）。
   *
   * 五个值与 `CadenceMetrics.potential` 同源同口径（同一个取值函数产出），因此遥测与状态机
   * 不会出现两套门限（STATE Phase 13 约束）；`rate` 模式省略这些键，保证既有消费者拿到的
   * 向量逐位不变。
   *
   * 本字段：有效讨论势能 Q = E · S_turn（nat）。
   */
  quality?: number;
  /** 信息密度 ρ = E / N（nat/条）。 */
  density?: number;
  /** 交互熵归一化后的 S_turn ∈ [0, 1]。 */
  interaction?: number;
  /** Q 的逐群日常基线 b_Q。 */
  baselineQuality?: number;
  /** 冷却门限 Θ_cool（由触发器导出的同一函数计算，遥测不另立公式）。 */
  coolThreshold?: number;
  /**
   * 势能模式的信息密度下限 ρ_min（`potential` 模式下必填）。
   *
   * 只有 `potential` 的相位裁决带 ρ 判据；`shadow` 的相位仍由速率裁决，故与 `rate`
   * 一样省略本字段——遥测口径必须与状态机一致，不得给 shadow 伪造 Q/ρ 门限。
   */
  rhoMin?: number;
  /** 本次裁决实际生效的密度下限 ρ_eff = max(rhoMin, densityMultiplier × b_ρ)。 */
  rhoEff?: number;
}

/**
 * 消息速率的差分动量（RSI 基础）。
 *
 * 逐步累积 $\Delta r = r_t - r_{t-1}$，按 Wilder 14 步平滑增益/损失：
 * $RS = AvgGain / (AvgLoss + \epsilon)$，$RSI = 100 - 100/(1+RS)$。
 * 样本不足一个周期时 `rsi` 恒为 `null`（绝不伪造 50 之类的中性值）。
 */
export interface MomentumMetrics {
  /** 已累积的 Δr 样本数。 */
  samples: number;
  /** 一阶斜率：最近一次 Δr（条/分/步）。 */
  velocity: number;
  /** 最近 `MOMENTUM_RSI_PERIOD` 步的净动量 Σ Δr。 */
  netMomentum: number;
  /** Wilder 平均增益（预热期的临时均值同样导出，语义一致）。 */
  avgGain: number;
  /** Wilder 平均损失（非负）。 */
  avgLoss: number;
  /** 14 步 RSI（0..100）；样本不足一个周期时为 `null`。 */
  rsi: number | null;
  /** 最近一次观测到的速率。 */
  lastRate: number | null;
  /** 最近一次观测的逻辑时刻。 */
  lastAt: number | null;
}

/**
 * 基线账本快照：最近 1 小时（滑动窗口）内基线的每一次增减。
 *
 * 语义边界：
 * - `acceptedUp` / `acceptedDown`：样本**确实写入** EWMA 且基线朝该方向移动；
 * - `rejectedHysteresis`：学习闸门开放，但上行滞回（斜率限制 / 85% 天花板）拒绝该样本；
 * - `rejectedPrewarm`：基线学习被冻结（爆发期绝对冻结 / 尚未解冻）而拒绝该样本；
 * - `decayDelta`：时间衰减造成的基线漂移（恒 ≤ 0）。
 */
export interface BaselineLedgerSnapshot {
  channelId: string;
  /** 滑动窗口长度（毫秒）。 */
  windowMs: number;
  /** 窗口起点（毫秒）；窗口为左开右闭区间 `(since, now]`。 */
  since: number;
  /** 窗口内事件条数（受有界缓冲上限约束）。 */
  events: number;
  /** 时间衰减造成的基线漂移（≤ 0）。 */
  decayDelta: number;
  /** 基线下行累计（≤ 0）。 */
  downwardDelta: number;
  /** 基线上行累计（≥ 0）。 */
  upwardDelta: number;
  /** 窗口内基线净变化（decayDelta + downwardDelta + upwardDelta）。 */
  netDelta: number;
  acceptedDown: number;
  acceptedUp: number;
  rejectedHysteresis: number;
  rejectedPrewarm: number;
  /** 窗口内最早 / 最晚事件时刻；无事件时为 `null`。 */
  firstAt: number | null;
  lastAt: number | null;
}

/** 单频道累计计数器。 */
export interface TelemetryCounters {
  /** 被观测并真正推进状态机的消息条数（重投消息不计）。 */
  observedMessages: number;
  /** 写入 trace 的事件条数。 */
  traces: number;
  nearMiss: number;
  /** 命中 NEAR_MISS 判定但被 3 分钟频控压制的次数。 */
  nearMissSuppressed: number;
  phaseChanges: number;
  sessionsFinalized: number;
  sessionsDiscarded: number;
  dispatches: number;
  aimdTunes: number;
}

/** 单条遥测事件。 */
export interface TelemetryTrace {
  /** 事件唯一 ID（同一 traceId 下的多条事件彼此不同）。 */
  eventId: string;
  /**
   * 关联 traceId：同一轮「突发 → 冷却 → 平息 → 沉淀 → 调参」事件链共享同一个 ID。
   * 会话交付时通过 `WeakMap<DiscussionSession, string>` 贴附，调度器回执据此回填。
   */
  traceId: string;
  kind: TelemetryEventKind;
  channelId: string;
  /** 事件逻辑时刻（毫秒）。 */
  at: number;
  /** 人类可读的单行摘要（不含消息正文与凭据）。 */
  detail: string;
  /** 事件发生时刻的闸门瞬态向量（副本）。 */
  gate: GateStatus;
  data: TelemetryData;
}

/** 单频道遥测快照。 */
export interface ChannelTelemetrySnapshot {
  channelId: string;
  gate: GateStatus;
  momentum: MomentumMetrics;
  baseline: BaselineLedgerSnapshot;
  /** 该群最近 `TELEMETRY_CHANNEL_TRACE_CAPACITY` 条 trace（时间升序）。 */
  traces: TelemetryTrace[];
  counters: TelemetryCounters;
}

/** `GET /api/telemetry` 的完整载荷。 */
export interface TelemetrySnapshot {
  /** 是否已挂载 Inspector；未挂载时其余字段均为基础空结构。 */
  attached: boolean;
  /** 响应生成时刻（墙钟毫秒）。 */
  generatedAt: number;
  /** 按 channelId 升序排列的单群快照。 */
  channels: ChannelTelemetrySnapshot[];
  /** 最近 `TELEMETRY_TRACE_CAPACITY` 条全局 trace（时间升序）。 */
  traces: TelemetryTrace[];
  /** 全群累计计数器。 */
  totals: TelemetryCounters;
  /** 被遥测自身吞掉的异常次数（遥测绝不影响主流程，但绝不静默无声）。 */
  errors: number;
}

/**
 * 未知值 → 有限数值（本子系统唯一的数值守卫，禁止在各调用点另立门户）。
 *
 * 遥测吸收的是**外部方法回执**（`BaselineObservation` / `DispatcherResult` / AIMD 信号），
 * 其运行时形状不由本模块掌握，因此只做最小必要校验后再消费具体字段。
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 未知值 → 非空对象（本子系统唯一的对象守卫）。
 *
 * 仅证明「是对象」，绝不代表字段合法：调用方必须继续逐个校验真正使用的字段。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 构造全零计数器。 */
export function createTelemetryCounters(): TelemetryCounters {
  return {
    observedMessages: 0,
    traces: 0,
    nearMiss: 0,
    nearMissSuppressed: 0,
    phaseChanges: 0,
    sessionsFinalized: 0,
    sessionsDiscarded: 0,
    dispatches: 0,
    aimdTunes: 0,
  };
}

/** 构造全零闸门（未观测过的群）。 */
export function createEmptyGate(): GateStatus {
  return {
    phase: 'IDLE',
    rate: 0,
    baseline: 0,
    threshold: 0,
    burstRatio: 0,
    speakers: 0,
    entropy: 0,
    nearMiss: false,
    buffered: 0,
    lastMessageTime: 0,
  };
}

/** 构造基础空快照（Inspector 未挂载时的 HTTP 载荷）。 */
export function createEmptyTelemetrySnapshot(now: number = Date.now()): TelemetrySnapshot {
  return {
    attached: false,
    generatedAt: now,
    channels: [],
    traces: [],
    totals: createTelemetryCounters(),
    errors: 0,
  };
}
