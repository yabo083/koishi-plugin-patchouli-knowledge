/**
 * Patchouli Knowledge — 自适应突发 / 平息双门限触发器 (Burst-Quiescence Detector)
 *
 * 职责：
 *  - 为每个群聊独立维护节奏状态机 `IDLE → BURSTING → COOLING → SUMMARIZING`；
 *  - 以物理层滤波后的有效速率与 EWMA 日常基线的双门限迟滞（Schmitt Trigger）判定突发，
 *    并叠加「≥2 名独立发言人且信息熵率 ≥0.6」的硬门限拦截单人刷屏与复读；
 *  - 突发期间静默缓存消息（脱离 IDLE 后基线绝对冻结），冷却期按末尾语义动态延长平息期；
 *  - 缓冲达到 120 条软切片交付，防止无休止积压；平息观察期满后才以
 *    `DiscussionSession` 形式交接给调度器（迟智 / Post-hoc Deliberation）。
 *
 * 非目标：
 *  - 不调用模型、不写磁盘、不做知识抽取（见 `src/dispatcher` 与 `src/wiki`）；
 *  - 不在讨论峰值期间向群内发出任何消息。
 *
 * 契约与算法详见同目录 `README.md`。
 */

import { randomUUID } from 'node:crypto';

import {
  MAX_INBOUND_CONTENT_CHARS,
  type CadenceMetrics,
  type CadencePhase,
  type ChatMessage,
  type DiscussionSession,
  type PotentialMetrics,
  type TriggerMode,
  type TriggerOptions,
} from '../types';
import {
  BASELINE_DECAY_HALF_LIFE_MS,
  BaselineEstimator,
  DEFAULT_BASELINE_ALPHA,
  DEFAULT_INITIAL_RATE,
  MIN_BASELINE_FLOOR,
} from './baseline';
import {
  clampCodePoints,
  codePointLength,
  evaluateWindowEntries,
  MIN_ENTROPY_RATIO,
  MIN_UNIQUE_SPEAKERS,
  stripMessageMarkup,
} from './filter';
import type { WindowEvaluation } from './filter';
import {
  BOUNDARY_ENERGY_FACTOR,
  effectiveMessageCount,
  potentialCrossingAt,
  PotentialTracker,
} from './potential';
import type { PotentialSnapshot } from './potential';

/** 允许的最大「未来时间偏差」：超过即视为时钟漂移/伪造，钳到当前墙钟。 */
export const MAX_FUTURE_SKEW_MS = 60_000;

/**
 * 物理层工具与判据常数统一从 detector 再导出，
 * 保证 `src/index.ts` 无需改动即可让外部（测试 / 调度器）取到同一套口径。
 */
export {
  codePointLength,
  effectiveTextLength,
  ENTROPY_PREFIX_LENGTH,
  evaluateWindow,
  evaluateWindowEntries,
  MIN_EFFECTIVE_TEXT_LENGTH,
  MIN_ENTROPY_RATIO,
  MIN_UNIQUE_SPEAKERS,
  stripMessageMarkup,
} from './filter';
export type { WindowEvaluation, WindowMessage } from './filter';

/**
 * 势能模式的种子门限（Step 1 真实语料标定，2026-11-10）。
 *
 * 依据：正样本 A（88 场真实讨论）的 `maxρ` p10/p50/p90 = 1.272 / 1.535 / 1.729，
 * 真实结构性噪声（`kind=FLOOR`）`maxρ` ≤ 1.52；`rhoMin = 1.8` 会把 A 的召回打到 48%，
 * `1.2` 时为 98.9%，FLOOR 误触仍为 0。
 *
 * 已知盲区（**不要**在此处自行修补）：合成「5 条 120 字、90s 间隔」的慢速深聊 `maxQ ≈ 10.9 < thetaMin`，
 * 冷启动慢群因此不触发 —— 这是 §7.5.1「AND 双判据 + 逐群 Θ」在本标定下的直接后果，
 * 待「小体量高密度」分支或下调 `thetaMin` 的独立决策，本实现按 roadmap 原文只走单一路径。
 */
export const POTENTIAL_SEEDING: Readonly<{ thetaMin: number; rhoMin: number }> = Object.freeze({
  thetaMin: 20,
  rhoMin: 1.2,
});

/** TriggerOptions 的默认值（与 `src/types.ts` 注释中的默认口径一致）。 */
export const DEFAULT_TRIGGER_OPTIONS: Readonly<TriggerOptions> = Object.freeze({
  windowSizeSeconds: 60,
  burstMultiplier: 2.5,
  minBurstRate: 6,
  quiescenceSeconds: 300,
  coolingRatioThreshold: 1.1,
  minDiscussionMessages: 12,
  maxBufferMessages: 500,
  baselineEwmaAlpha: DEFAULT_BASELINE_ALPHA,
  // 默认即势能判据：速率判据只能看到「此刻多吵」，势能侧能看到「消息里的信息量累积」。
  // `dispatchMargin` 必须同开：势能比速率敏感（实测召回 +45%），没有质量门会让沉淀量暴涨。
  triggerMode: 'potential',
  dispatchMargin: 1.2,
  thetaMin: POTENTIAL_SEEDING.thetaMin,
  rhoMin: POTENTIAL_SEEDING.rhoMin,
  peakCoolFraction: 0.5,
});

/** 边界标注的最低置信度：低于该值的语义层上报一律丢弃（L0 打分不足即不切）。 */
export const MIN_BOUNDARY_CONFIDENCE = 0.5;

/** 主动书记员的安全熔断 TTL：连续静默超过该时长自动结算并关闭录制。 */
export const MAX_MANUAL_IDLE_MS = 2 * 3600_000;

/** 主动书记员期间触发「缓冲 ≥ N 条才按边界切分」的门槛（§7.2，只在录制期生效）。 */
export const MANUAL_BOUNDARY_SLICE_MIN_MESSAGES = 25;

/** 主动书记员结算的下限：结束指令 / 熔断时只要 ≥ 2 条即交付（§7.2 明文）。 */
export const MANUAL_SESSION_MIN_MESSAGES = 2;

/** 建仓回溯窗口：突发成立时把最近该时长内的消息补进缓冲（含开场长文）。 */
export const POTENTIAL_PREROLL_MS = 10 * 60_000;

/** 回溯环的硬容量上限（防 OOM；典型情况下时间窗先生效）。 */
export const RECENT_MESSAGE_CAPACITY = 400;

/** 势能模式结算的物理条数保底（§7.1：`|buffer| ≥ 4`，与 `minDiscussionMessages` 无关）。 */
const POTENTIAL_MIN_SETTLEMENT_MESSAGES = 4;

/**
 * Q 基线的冷启动预热样本数：前 N 个 IDLE 样本**无条件**入库。
 *
 * 为什么必需：`b_Q` 冷启动为 0（Q 的量纲是 nat 累加，不能沿用速率先验 2），而上行学习闸门
 * 是 `Q <= b_Q × 1.3 + 0.5` —— `b_Q = 0` 时退化成 `Q <= 0.5`，稳态闲聊的 Q 在数十量级，
 * 于是基线一个样本都学不到：`Θ_burst` 永远等于 `thetaMin`，逐群自适应整条路径失效。
 * 预热期无条件入库只为把基线抬到本群的日常量级，之后立即交还给三层闸门。
 */
export const POTENTIAL_BASELINE_WARMUP = 20;

/**
 * 缓冲区软切片阈值：本轮缓冲达到该条数时立即交付一个切片并清空缓冲，
 * 防止无休止积压导致下游超时或超 token（状态机相位保持不变）。
 */
export const BUFFER_SOFT_SLICE_MESSAGES = 120;

/** 动态平息期的采样范围：只检查缓存末尾 3 条消息。 */
export const DYNAMIC_QUIESCENCE_SAMPLE = 3;

/** 动态平息期的基础延长倍率（命中任一信号即生效）。 */
export const QUIESCENCE_EXTENSION_BASE = 1.2;

/** 每多命中一个信号追加的倍率。 */
export const QUIESCENCE_EXTENSION_STEP = 0.25;

/** 动态平息期的延长倍率上限。 */
export const QUIESCENCE_EXTENSION_MAX = 2.2;

/** 「长文思考」判据：末尾样本平均字符长超过该值即视为长文。 */
export const LONG_MESSAGE_THRESHOLD = 50;


/** 突发判定天花板相对倍率（minBurstRate 的 1.8 倍，例如 6 * 1.8 = 10.8 条/分）。 */
export const DEFAULT_MAX_BURST_CEILING_RATIO = 1.8;
/** burstRatio 的分母下限，避免冷启动时除零。 */
const MIN_RATE_DENOMINATOR = 0.1;

/** 浮点比较容差。 */
const RATE_EPSILON = 1e-9;

/** setTimeout 单次最大延时（Node 限制，约 24.8 天）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 定时器取消句柄。 */
export type CancelTimer = () => void;

/** 可注入的定时器实现（测试可用假时钟接管）。 */
export type TriggerScheduler = (callback: () => void, delayMs: number) => CancelTimer;

/** 平息结算回调：交出一轮完整讨论。 */
export type QuiescenceHandler = (session: DiscussionSession) => void | Promise<void>;

/**
 * 主动书记员会话的结束方式：`stop` = `rec off`（宿主主动结束），
 * `fuse` = 2h 无消息的静默熔断（`MAX_MANUAL_IDLE_MS`）。
 */
export type ManualSessionEndReason = 'fuse' | 'stop';

/** 滑窗条目：原始消息 + 归一化后的逻辑时间（毫秒）。 */
export interface WindowEntry {
  message: ChatMessage;
  at: number;
}

/** 单个群聊的节奏状态（对外的只读快照结构）。 */
export interface GroupCadenceState {
  channelId: string;
  phase: CadencePhase;
  /** 该群生效中的触发参数（逐群可热更新）。 */
  options: TriggerOptions;
  /** 瞬时速率滑窗（按逻辑时间升序）。 */
  window: WindowEntry[];
  /** 本轮讨论缓存（仅 BURSTING / COOLING 期间累积）。 */
  buffer: ChatMessage[];
  /** 本轮讨论起始时间（毫秒）。 */
  sessionStartTime: number;
  /** 本轮讨论最后一条被缓存消息的时间（毫秒）。 */
  sessionLastMessageTime: number;
  /** 本轮观测到的峰值瞬时速率（条/分）。 */
  peakRate: number;
  /** 本轮突发波数（主突发 = 1，每次次级突发 +1）。 */
  burstCount: number;
  /** 进入 COOLING 的时刻（毫秒，逻辑时间）。 */
  coolingSince: number | null;
  /** 平息观察期截止时刻（毫秒，逻辑时间）。 */
  quiescenceDeadline: number | null;
  /** 本轮平息期采用的动态延长倍率（1 = 未延长，范围 1.2~2.2 表示已延长）。 */
  quiescenceFactor: number;
  /**
   * 当前持有 SUMMARIZING 闩锁的会话 id（`null` = 没有闩锁）。
   *
   * 只有会话 id 匹配的完成回调才能释放闩锁：A 轮结算慢、B 轮已开始并也进入 SUMMARIZING 时，
   * A 的 `finally` 按群直接清相位会误清 B 的闩锁。
   */
  summarizingSessionId: string | null;
  /** 最后一条消息的逻辑时间（毫秒）。 */
  lastMessageTime: number;
  /** 最后一次观测消息时的墙钟时间（毫秒），用于把「无消息的静默」折算进逻辑时间。 */
  lastObservedWallClock: number;
  /** 上一轮已结算讨论的结束时刻，作为新会话缓存的起点（防重复沉淀）。 */
  lastSettledTime: number;
  /** 本轮突发的触发依据（人类可读）。 */
  triggerReason: string;
  /** 因超出 maxBufferMessages 而丢弃的消息数。 */
  droppedMessages: number;
  /** 已完成（成功交接或判定不足）的讨论轮数。 */
  completedSessions: number;
  /** 该群累计观测消息数。 */
  totalMessages: number;
  /** 上次基线更新/静默结算的逻辑时刻（毫秒，0 表示未初始化）。 */
  lastBaselineUpdateTs: number;
  /** 主动书记员模式：录制期间屏蔽自然冷却（BURSTING → COOLING / 自动结算）。 */
  manualRecording: boolean;
  /** 边界单调水位：同一缓冲内已按边界切分到的时刻，杜绝乱序标注回切同一段。 */
  lastBoundaryAt: number;
  /**
   * 本轮观测到的有效讨论势能峰值 Q（`BURSTING` / `COOLING` 期逐条更新）。
   *
   * 用途：① 峰值比例冷却门限 `Θ_cool' = max(Θ_cool, peak × peakCoolFraction)`；
   * ② 结算会话的 `DiscussionSession.potentialPeak`（调度质量门的判据）。
   * 结算（`finalize` / 软切片 / 边界切分）后清零，下一轮从 0 重新观测。
   */
  sessionPeakQuality: number;
}

/**
 * 判定不足而丢弃一轮讨论时的诊断信息。
 *
 * 触发条件：平息结算时缓冲区消息数 `< minDiscussionMessages`（冷群 / 短对话保护）。
 * 该分支不产出词条、不调用模型，若完全静默运维将无法区分「没触发」与「插件损坏」，
 * 因此把判定依据整体交给 `DetectorConfig.onDiscard` 记入日志。
 */
export interface DetectorDiscardInfo {
  /** 群聊 / 频道 ID。 */
  channelId: string;
  /** 缓冲区中被丢弃的消息条数。 */
  messageCount: number;
  /** 本轮生效的最低沉淀消息数门限。 */
  minDiscussionMessages: number;
  /** 本轮观测到的峰值瞬时速率（条/分）。 */
  peakRate: number;
  /** 本轮突发的触发依据（人类可读，含次级突发波数）。 */
  triggerReason: string;
  /** 本轮讨论起始时刻（毫秒，逻辑时间）。 */
  startTime: number;
  /** 本轮最后一条被缓存消息的时刻（毫秒，逻辑时间）。 */
  endTime: number;
  /**
   * 被丢弃的消息全集（只读副本）。
   *
   * 没有内容就无法复核「缓冲不足」是冷群短对话还是门限过高的误杀，
   * 因此诊断口一并交出消息，由宿主决定是否留证落盘。
   */
  messages: ChatMessage[];
}

export interface DetectorConfig {
  /** 触发参数（缺省项取 DEFAULT_TRIGGER_OPTIONS）。 */
  options?: Partial<TriggerOptions>;
  /** 平息结算回调（必填）。 */
  onQuiescence: QuiescenceHandler;
  /**
   * 判定不足丢弃一轮讨论时的诊断回调（可选）。
   *
   * 只用于可观测性：不参与状态机决策，回调抛出的异常会被转交 `onError`，绝不影响相位迁移。
   */
  onDiscard?: (info: DetectorDiscardInfo) => void;
  /**
   * 主动书记员会话结束通知（可选）：`reason` 区分手动 `stop` 与 2h 静默 `fuse`。
   *
   * 只用于宿主清档：录制文件（`scribe/<channelId>.jsonl`）服务于「进程重启后的恢复」，
   * 会话一旦结束就该删除，否则重启时已结束的会话会被再次恢复、再次交付。
   * 回调抛出的异常转交 `onError`，绝不影响相位迁移。
   */
  onManualSessionEnd?: (channelId: string, reason: ManualSessionEndReason) => void;
  /** 回调/定时器异常处理（默认 console.error）。 */
  onError?: (error: unknown) => void;
  /** 注入共享的基线估算器（默认内部新建）。 */
  baseline?: BaselineEstimator;
  /** 可注入时钟（毫秒），默认 Date.now。 */
  now?: () => number;
  /** 可注入定时器（默认 setTimeout + unref）。 */
  scheduler?: TriggerScheduler;
}

interface OptionRule {
  min: number;
  max: number;
  integer?: boolean;
}

/** 参与数值域校验的键（`triggerMode` 是字符串枚举、`potentialAutoTuning` 是布尔，均单独处理）。 */
type NumericTriggerOptionKey = Exclude<keyof TriggerOptions, 'triggerMode' | 'potentialAutoTuning'>;

const OPTION_RULES: Record<NumericTriggerOptionKey, OptionRule> = {
  windowSizeSeconds: { min: 1, max: 86_400 },
  burstMultiplier: { min: 1, max: 1_000 },
  minBurstRate: { min: 0, max: 100_000 },
  quiescenceSeconds: { min: 0, max: 604_800 },
  coolingRatioThreshold: { min: 0, max: 1_000 },
  // AIMD 的高价值放宽分支会给出 11.5 这类连续阈值：比较语义是
  // `messages.length < minDiscussionMessages`，小数等价于「至少 ceil(x) 条」，无需取整。
  minDiscussionMessages: { min: 0, max: 100_000 },
  maxBufferMessages: { min: 1, max: 100_000, integer: true },
  baselineEwmaAlpha: { min: 1e-4, max: 1 },
  // 势能门限的量纲是 nat 累加（数十量级），上限只做「明显写错」的兜底。
  // 下限必须为正数：`thetaMin = 0` 时冷启动 `b_Q = 0` 会让 `Θ_cool = max(0, 0) × 1.1 = 0`，
  // 而 `potentialCrossingAt` 对非正阈值恒返 `null` ⇒ 群永驻 BURSTING、`rearm` 也解不出回落
  // 时刻，只剩 120 条软切片（§7.5.1 阻断项的变体）。拒绝 0 比在 `potentialCoolThreshold`
  // 里再做正数兜底更早、更明确：参数域本身就不该允许「永不冷却」。
  thetaMin: { min: 1e-3, max: 1e6 },
  rhoMin: { min: 0, max: 1e6 },
  // 三个可选增强：密度基线倍率（0 = 不启用 ρ 自适应）、峰值冷却分数（0 = 纯基线口径）、
  // 调度质量门倍数（0 = 关闭）。均允许 0 作为「关闭」语义，上限只做写错兜底。
  densityMultiplier: { min: 0, max: 100 },
  peakCoolFraction: { min: 0, max: 1 },
  dispatchMargin: { min: 0, max: 10 },
};

const OPTION_KEYS = Object.keys(OPTION_RULES) as NumericTriggerOptionKey[];

/** `triggerMode` 的合法取值（顺序即报错文案顺序）。 */
/** 同一时刻两套判据的裁决结论（`evaluateVerdicts` 的返回值，shadow 对照用）。 */
export interface TriggerVerdicts {
  rate: {
    ready: boolean;
    rate: number;
    threshold: number;
    baseline: number;
    speakers: number;
    entropy: number;
  };
  potential: {
    ready: boolean;
    quality: number;
    density: number;
    rhoMin: number;
    /** 本次裁决实际使用的密度下限 ρ_eff = max(rhoMin, densityMultiplier × b_ρ)。 */
    rhoEff: number;
    /** 逐群学习的密度基线 b_ρ（Δnat/条）。 */
    baselineDensity: number;
    interaction: number;
    baselineQuality: number;
    burstThreshold: number;
    coolThreshold: number;
  };
}

const TRIGGER_MODES: readonly TriggerMode[] = ['rate', 'potential', 'shadow'];

/**
 * 合并并严格校验触发参数。
 * 越界/非数值/非整数一律抛 RangeError（不做静默纠正）。
 */
export function normalizeTriggerOptions(
  partial: Partial<TriggerOptions> = {},
  base: TriggerOptions = DEFAULT_TRIGGER_OPTIONS,
): TriggerOptions {
  const merged: TriggerOptions = { ...base };

  const mode = partial.triggerMode;
  if (mode !== undefined) {
    if (!TRIGGER_MODES.includes(mode)) {
      throw new RangeError(
        `[patchouli/trigger] triggerMode 必须是 ${TRIGGER_MODES.join(' | ')}，收到 ${String(mode)}`,
      );
    }
    merged.triggerMode = mode;
  }

  const autoTuning = partial.potentialAutoTuning;
  if (autoTuning !== undefined) {
    if (typeof autoTuning !== 'boolean') {
      throw new RangeError(`[patchouli/trigger] potentialAutoTuning 必须是布尔值，收到 ${String(autoTuning)}`);
    }
    merged.potentialAutoTuning = autoTuning;
  }

  for (const key of OPTION_KEYS) {
    const provided = partial[key];
    if (provided === undefined) {
      continue;
    }
    if (typeof provided !== 'number' || !Number.isFinite(provided)) {
      throw new RangeError(`[patchouli/trigger] ${key} 必须是有限数值，收到 ${String(provided)}`);
    }
    const rule = OPTION_RULES[key];
    if (rule.integer === true && !Number.isInteger(provided)) {
      throw new RangeError(`[patchouli/trigger] ${key} 必须是整数，收到 ${provided}`);
    }
    if (provided < rule.min || provided > rule.max) {
      throw new RangeError(
        `[patchouli/trigger] ${key} 必须落在 [${rule.min}, ${rule.max}]，收到 ${provided}`,
      );
    }
    merged[key] = provided;
  }

  if (merged.coolingRatioThreshold >= merged.burstMultiplier) {
    throw new RangeError(
      `[patchouli/trigger] coolingRatioThreshold(${merged.coolingRatioThreshold}) 必须小于 ` +
        `burstMultiplier(${merged.burstMultiplier})，否则迟滞区间失效`,
    );
  }

  return merged;
}

/**
 * 突发判定门限：受封顶天花板保护的动态门限。
 *
 * 导出供可观测性（`src/telemetry`）复用同一判据 —— 遥测的 NEAR_MISS 与 PHASE_CHANGE
 * 瞬态向量必须与状态机使用完全一致的 `threshold`，否则「擦肩而过」的判定会出现系统性偏差。
 */
export function burstThreshold(options: TriggerOptions, baselineRate: number): number {
  const dynamic = Math.max(options.minBurstRate, baselineRate * options.burstMultiplier);
  const ceiling = options.minBurstRate * DEFAULT_MAX_BURST_CEILING_RATIO;
  return Math.min(ceiling, dynamic);
}

/**
 * 势能模式的突发门限：逐群自适应的 `Θ_burst = max(thetaMin, b_Q × burstMultiplier)`。
 *
 * 与 `burstThreshold` 一样是**状态机与遥测共用的唯一口径**：任何调用方都不得另立公式，
 * 否则 NEAR_MISS 与相位迁移会用到两套门限（Phase 13 约束）。
 */
export function potentialBurstThreshold(options: TriggerOptions, baselineQuality: number): number {
  return Math.max(options.thetaMin, baselineQuality * options.burstMultiplier);
}

/**
 * 势能模式的冷却门限：`Θ_cool = coolingRatioThreshold × max(thetaMin / burstMultiplier, b_Q)`。
 *
 * 为什么不是裸的 `b_Q × coolingRatioThreshold`：Q 基线冷启动为 0（见 `qualityBaseline`），
 * 而 Q > 0 恒成立（残余势能按指数衰减、永不精确归零），于是 `Θ_cool = 0` 会让**任何**
 * 一次突发都无法冷却 —— 群常驻 BURSTING、`rearm` 也解不出回落时刻（`potentialCrossingAt`
 * 对非正阈值返回 `null`），只剩 120 条软切片。这正是 §7.5.1 阻断项（常驻 BURSTING）的变体。
 *
 * 取「种子基线」`thetaMin / burstMultiplier`（即「突发门限恰好等于 thetaMin 时的 Q 基线」），
 * 两条门限随同一个基线缩放，迟滞带恒成立：
 *   Θ_burst = burstMultiplier × max(seed, b_Q) ≡ max(thetaMin, b_Q × burstMultiplier)
 *   Θ_cool  = coolingRatioThreshold × max(seed, b_Q)  <  Θ_burst
 * `b_Q` 一旦学到正常值（> seed）就退化为契约原式 `b_Q × coolingRatioThreshold`。
 *
 * 正数前提由参数域保证：`thetaMin ≥ 1e-3 > 0`（见 `OPTION_RULES`），因此 `seedBaseline > 0`，
 * 冷启动 `b_Q = 0` 时本函数不会返回 0 —— 否则 `potentialCrossingAt` 恒返 `null`，群永不冷却。
 *
 * 峰值比例项（`peakCoolFraction`）：传入本轮峰值 `peakQuality` 时取
 *   `Θ_cool' = min( max(Θ_cool, peakQuality × peakCoolFraction), Θ_burst × 0.99 )`
 * 高势能场次在仍保有相当残余时即确认回落（避免 τ 量级的长尾把结算拖到几十分钟），
 * 低峰值 / 尚未观测到峰值（`peakQuality = 0`）时逐位退化为基线口径。
 * 封顶到 `Θ_burst × 0.99` 保证迟滞带恒成立：Θ_cool 一旦越过 Θ_burst，群会在突发判据
 * 成立的同时被判定回落，相位在 BURSTING / COOLING 之间抖动。
 */
export function potentialCoolThreshold(
  options: TriggerOptions,
  baselineQuality: number,
  peakQuality?: number,
): number {
  const seedBaseline = options.thetaMin / options.burstMultiplier;
  const baselineCool = Math.max(seedBaseline, baselineQuality) * options.coolingRatioThreshold;
  const peak = peakQuality !== undefined && Number.isFinite(peakQuality) ? Math.max(0, peakQuality) : 0;
  const fraction = options.peakCoolFraction ?? 0.5;
  const target = Math.max(baselineCool, peak * fraction);
  const ceiling = potentialBurstThreshold(options, baselineQuality) * 0.99;
  return Math.min(target, ceiling);
}

/**
 * 信息密度的生效下限：`ρ_eff = max(rhoMin, (densityMultiplier ?? 1.0) × b_ρ)`。
 *
 * ADR-021 回放证明 ρ 不是跨群分离轴（判废样本的 ρ@maxQ 中位 1.39 与正样本重叠），
 * 所以 `densityMultiplier` 只做「下限随本群量级浮动」：倍数缺省 1.0，`0` 表示只用固定 rhoMin。
 * 冷启动 `b_ρ = 0` 时逐位退化为原来的 `rhoMin`。
 */
export function effectiveRhoMin(options: TriggerOptions, baselineDensity: number): number {
  const multiplier = options.densityMultiplier ?? 1;
  return Math.max(options.rhoMin, multiplier * baselineDensity);
}

/** 平息判定门限：Rate ≤ baselineRate × coolingRatioThreshold。 */
function coolingRate(options: TriggerOptions, baselineRate: number): number {
  return baselineRate * options.coolingRatioThreshold;
}

/**
 * 平息门限对应的窗口内最大消息条数。
 * 窗口速率 rate = count × 60 / windowSizeSeconds，故 count ≤ rate × windowSizeSeconds / 60。
 */
function coolingMaxCount(options: TriggerOptions, baselineRate: number): number {
  const rate = coolingRate(options, baselineRate);
  return Math.max(0, Math.floor((rate * options.windowSizeSeconds) / 60 + RATE_EPSILON));
}

/** 动态平息期的四类语义信号。 */
export interface QuiescenceSignals {
  /** 末尾消息包含代码块（```）。 */
  codeBlock: boolean;
  /** 末尾消息包含 URL（http/https）。 */
  url: boolean;
  /** 末尾消息以问号结尾（? / ？）。 */
  question: boolean;
  /** 末尾样本平均字符长 > `LONG_MESSAGE_THRESHOLD`。 */
  longForm: boolean;
}

/** 动态平息期的结算结果。 */
export interface DynamicQuiescence {
  /** 实际采用的平息时长（秒）。 */
  seconds: number;
  /** 相对 `quiescenceSeconds` 的倍率；无信号时为 1。 */
  factor: number;
  /** 命中的语义信号。 */
  signals: QuiescenceSignals;
  /** 实际参与统计的末尾消息条数。 */
  sampleSize: number;
}

const CODE_BLOCK_PATTERN = /```/;
const URL_PATTERN = /https?:\/\//i;
const TRAILING_QUESTION_PATTERN = /[?？]\s*$/;

/**
 * 动态语义平息期：技术交锋往往以代码块 / 链接 / 长段论证推进，且常以问句收尾；
 * 若直接按固定 quiescenceSeconds 结算，会在对方长思考期间截断讨论。
 *
 * 规则：检查末尾 `DYNAMIC_QUIESCENCE_SAMPLE` 条消息的纯文本，
 * 命中代码块 / URL / 问号结尾 / 长文（平均 > 50 字）四类信号时，
 * 倍率 = min(2.2, 1.2 + 0.25 × 命中数)；无信号返回 1，完全不延长。
 */
export function computeDynamicQuiescence(
  messages: readonly ChatMessage[],
  quiescenceSeconds: number,
): DynamicQuiescence {
  if (
    typeof quiescenceSeconds !== 'number' ||
    !Number.isFinite(quiescenceSeconds) ||
    quiescenceSeconds < 0
  ) {
    throw new RangeError(
      `[patchouli/trigger] quiescenceSeconds 必须是非负有限数值，收到 ${String(quiescenceSeconds)}`,
    );
  }

  const start = Math.max(0, messages.length - DYNAMIC_QUIESCENCE_SAMPLE);
  let codeBlock = false;
  let url = false;
  let question = false;
  let charTotal = 0;
  let sampleSize = 0;

  for (let index = start; index < messages.length; index += 1) {
    const text = stripMessageMarkup(messages[index].content);
    if (text.length === 0) {
      continue;
    }
    if (!codeBlock && CODE_BLOCK_PATTERN.test(text)) {
      codeBlock = true;
    }
    if (!url && URL_PATTERN.test(text)) {
      url = true;
    }
    if (!question && TRAILING_QUESTION_PATTERN.test(text)) {
      question = true;
    }
    charTotal += codePointLength(text);
    sampleSize += 1;
  }

  const avgCharLength = sampleSize > 0 ? charTotal / sampleSize : 0;
  const longForm = sampleSize > 0 && avgCharLength > LONG_MESSAGE_THRESHOLD;
  const signals: QuiescenceSignals = { codeBlock, url, question, longForm };

  let matched = 0;
  if (codeBlock) matched += 1;
  if (url) matched += 1;
  if (question) matched += 1;
  if (longForm) matched += 1;

  const factor =
    matched === 0
      ? 1
      : Math.min(
          QUIESCENCE_EXTENSION_MAX,
          QUIESCENCE_EXTENSION_BASE + QUIESCENCE_EXTENSION_STEP * matched,
        );

  return { seconds: quiescenceSeconds * factor, factor, signals, sampleSize };
}

function describeBurst(
  threshold: number,
  baselineRate: number,
  multiplier: number,
  evaluation: WindowEvaluation,
): string {
  const rateText = evaluation.effectiveRate.toFixed(2);
  const thresholdText = threshold.toFixed(2);
  const baselineText = baselineRate.toFixed(2);
  return (
    `有效速率 ${rateText} 条/分 > 触发门限 ${thresholdText} 条/分` +
    `（基线 ${baselineText} 条/分 × ${multiplier}）` +
    `｜独立发言人 ${evaluation.uniqueSpeakers}，信息熵率 ${evaluation.entropyRatio.toFixed(2)}`
  );
}

/** 势能模式下触发一轮突发所需的对账信息（用于 `triggerReason` 文案）。 */
interface PotentialBurstInfo {
  /** 触发时刻的有效讨论势能 Q。 */
  quality: number;
  /** 触发时刻的信息密度 ρ。 */
  density: number;
  /** 触发门限 Θ_burst。 */
  threshold: number;
  /** 触发时刻的 Q 基线 b_Q（已含学习闸门，用于解释门限来源）。 */
  baselineQuality: number;
  /** 触发时刻生效的密度下限 ρ_eff（固定 rhoMin 与逐群密度基线的较大者）。 */
  rhoEff: number;
}

/** 突发建仓的一次性种子快照：开场消息 + 本轮起点 + 因上限丢弃的条数。 */
interface BurstSeed {
  messages: ChatMessage[];
  startTime: number;
  dropped: number;
}

function describePotentialBurst(info: PotentialBurstInfo, options: TriggerOptions): string {
  return (
    `有效势能 Q ${info.quality.toFixed(2)} > 触发门限 ${info.threshold.toFixed(2)}` +
    `（Q 基线 ${info.baselineQuality.toFixed(2)} × ${options.burstMultiplier}，下限 ${options.thetaMin}）` +
    `｜信息密度 ρ ${info.density.toFixed(2)} ≥ ${info.rhoEff.toFixed(2)}`
  );
}

/** 书记员入口的触发依据文案（无 hint：命令面只保留 logon/logoff）。 */
export const MANUAL_REASON_START = '自动书记开始';
/** 进程重启后从 scribe 记录恢复会话时的触发依据文案。 */
export const MANUAL_REASON_RESTORE = '自动书记恢复';

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

const defaultScheduler: TriggerScheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') {
    handle.unref();
  }
  return () => clearTimeout(handle);
};

/**
 * 双门限迟滞的突发 / 平息状态机。
 *
 * 典型生命周期（BURST-02 → BURST-03/04）：
 * ```ts
 * const detector = new BurstQuiescenceDetector({
 *   options: { quiescenceSeconds: 300 },
 *   onQuiescence: async (session) => { await dispatcher.dispatch(session); },
 * });
 * ctx.on('message', (session) => detector.onMessage(toChatMessage(session)));
 * ```
 */
export class BurstQuiescenceDetector {
  private readonly defaults: TriggerOptions;
  private readonly states = new Map<string, GroupCadenceState>();
  private readonly timers = new Map<string, CancelTimer>();
  private readonly handler: QuiescenceHandler;
  private readonly onDiscard: ((info: DetectorDiscardInfo) => void) | undefined;
  private readonly onManualSessionEnd:
    | ((channelId: string, reason: ManualSessionEndReason) => void)
    | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly clock: () => number;
  private readonly scheduler: TriggerScheduler;

  /** 内部（或外部注入）的日常基线估算器。 */
  readonly baseline: BaselineEstimator;

  /** 势能跟踪器（potential / shadow 模式）：逐群一个，rate 模式下不建。 */
  private readonly trackers = new Map<string, PotentialTracker>();

  /**
   * 建仓回溯环（potential / shadow）：按**逻辑时间**保留最近 `POTENTIAL_PREROLL_MS` 的消息。
   *
   * 条目与滑窗同构（`{ message, at }`，见 `WindowEntry`）：逻辑时间可能因未来戳 / 投递滞后
   * 而永久高于原始 `timestamp`，两套时间基准混用会让环把自己剪空（见 `recordRecentMessage`）。
   */
  private readonly recentMessages = new Map<string, WindowEntry[]>();

  /**
   * 最近一次入环的势能快照，作为冷却时刻闭式解的基准 `t_k`
   * （`S_turn` 在无新消息时恒定，故回落时刻可由 E(t_k) 一次解出）。
   */
  private readonly lastPotential = new Map<string, PotentialSnapshot>();

  /**
   * Q 的日常基线：与速率基线**完全独立**的实例。
   *
   * 冷启动初始速率必须为 0：Q 的量纲是 nat 累加（数十），若沿用速率的口径（2），
   * 首个样本一到就会把「日常」抬到样本量级，`max(thetaMin, ·)` 的下限兜底立刻失效。
   */
  private readonly qualityBaseline: BaselineEstimator;

  /**
   * Q 基线的冷启动预热计数（逐群）：达到 `POTENTIAL_BASELINE_WARMUP` 后走三层学习闸门。
   * 与 `qualityBaseline` 同生命周期：`reset()` / `dispose()` / 切回 rate 模式时一并清空。
   */
  private readonly qualitySamples = new Map<string, number>();

  /**
   * 信息密度 ρ 的日常基线 `b_ρ`：与 Q 基线同构的独立 EWMA（冷启动 `initialRate = 0`）。
   *
   * 只服务「ρ 生效下限随群自适应」：`ρ_eff = max(rhoMin, densityMultiplier × b_ρ)`。
   * 学习样本是每条入环消息的 `potentialSnapshot.density`，闸门与 `b_Q` 完全同构
   * （IDLE 才学 / 突发期冻结 / 下行无条件 / 上行滞回 / 前 N 个样本无条件预热）。
   */
  private readonly densityBaseline: BaselineEstimator;

  /** `b_ρ` 的冷启动预热计数（逐群），与 `qualitySamples` 同生命周期。 */
  private readonly densitySamples = new Map<string, number>();

  constructor(config: DetectorConfig) {
    if (typeof config.onQuiescence !== 'function') {
      throw new TypeError('[patchouli/trigger] onQuiescence 回调必填');
    }
    this.defaults = normalizeTriggerOptions(config.options ?? {});
    this.handler = config.onQuiescence;
    const onDiscard = config.onDiscard;
    if (onDiscard !== undefined && typeof onDiscard !== 'function') {
      throw new TypeError('[patchouli/trigger] onDiscard 必须是函数');
    }
    this.onDiscard = onDiscard;
    const onManualSessionEnd = config.onManualSessionEnd;
    if (onManualSessionEnd !== undefined && typeof onManualSessionEnd !== 'function') {
      throw new TypeError('[patchouli/trigger] onManualSessionEnd 必须是函数');
    }
    this.onManualSessionEnd = onManualSessionEnd;
    this.onError = config.onError;
    this.clock = config.now ?? ((): number => Date.now());
    this.scheduler = config.scheduler ?? defaultScheduler;
    this.baseline =
      config.baseline ??
      new BaselineEstimator({
        alpha: this.defaults.baselineEwmaAlpha,
        initialRate: DEFAULT_INITIAL_RATE,
        sampleWindowSeconds: this.defaults.windowSizeSeconds,
      });
    this.qualityBaseline = new BaselineEstimator({
      alpha: this.defaults.baselineEwmaAlpha,
      // Q 的冷启动基线必须为 0（见 `qualityBaseline` 字段注释）。
      initialRate: 0,
      sampleWindowSeconds: this.defaults.windowSizeSeconds,
    });
    this.densityBaseline = new BaselineEstimator({
      alpha: this.defaults.baselineEwmaAlpha,
      // 密度的冷启动基线同样为 0：`ρ_eff = max(rhoMin, ·)` 在学到样本前必须逐位退化。
      initialRate: 0,
      sampleWindowSeconds: this.defaults.windowSizeSeconds,
    });
  }

  /** 已跟踪的群聊数量。 */
  get size(): number {
    return this.states.size;
  }

  /** 已跟踪的群聊 ID 列表。 */
  channelIds(): string[] {
    return [...this.states.keys()];
  }

  /** 是否已进入跟踪状态。 */
  hasChannel(channelId: string): boolean {
    return this.states.has(channelId);
  }

  /**
   * 接收一条群聊消息，推进状态机并返回该群最新节奏度量。
   *
   * 幂等性：窗口内重复的 `message.id` 会被忽略（仅重算度量，不重复计数）。
   * 时序：若本条消息的时间戳已越过上一轮的平息截止点，会**先**结算上一轮再处理本条。
   */
  onMessage(input: ChatMessage): CadenceMetrics {
    const channelId = input.channelId;
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new TypeError('[patchouli/trigger] ChatMessage.channelId 不能为空');
    }
    // 容器守卫：window / buffer / recentMessages 都直接持有消息正文，字节上界必须由
    // 容器自己保证，不能假设调用方已经裁剪（恢复路径与三方调用同样走这里）。
    const message: ChatMessage =
      input.content.length <= MAX_INBOUND_CONTENT_CHARS
        ? input
        : { ...input, content: clampCodePoints(input.content, MAX_INBOUND_CONTENT_CHARS) };

    const state = this.ensureState(channelId);
    const at = this.normalizeMessageTime(state, message.timestamp);

    // 1) 先按新时间结算旧状态（可能在此触发上一轮的平息回调）。
    this.settleDueSafely(state, at);

    // 2) SUMMARIZING 只是交接闩锁：新消息视为新一轮节奏的起点。
    if (state.phase === 'SUMMARIZING') {
      state.phase = 'IDLE';
      state.summarizingSessionId = null;
    }

    // 3) 去重（窗口内的重投消息）。
    if (this.isDuplicate(state, message)) {
      this.rearm(state);
      return this.metrics(state, at);
    }

    // 3.5) 时间衰减（静默底噪回归）：
    // 若距离上次基线更新超过一个采样窗口，先面向底噪执行真实时间指数衰减。
    if (state.lastBaselineUpdateTs > 0) {
      const windowMs = state.options.windowSizeSeconds * 1000;
      const silentMs = Math.max(0, at - state.lastBaselineUpdateTs - windowMs);
      if (silentMs > 0) {
        const decay = Math.exp(-silentMs / BASELINE_DECAY_HALF_LIFE_MS);
        this.baseline.decay(channelId, MIN_BASELINE_FLOOR, decay);
        if (state.options.triggerMode !== 'rate') {
          // Q 的底噪下限是 0：用 1.0 会让 Q 基线永远回不到 0，冷启动兜底失效。
          this.qualityBaseline.decay(channelId, 0, decay);
          // 密度基线**不做静默衰减**：ρ 是「每条消息的属性」，静默期没有消息就没有 ρ 可
          // 衰减；套用与 Q 相同的时间衰减会把刚学到的 ρ_eff 磨成 0（0.8.32 线上实测
          // b_ρ ≈ 3e-7，ρ_eff 恒等于 rhoMin）。新消息到来后，下行样本无条件学习自然纠偏。
        }
      }
    }
    state.lastBaselineUpdateTs = at;

    const prevMessageTime = state.lastMessageTime;
    state.window.push({ message, at });
    state.lastMessageTime = Math.max(state.lastMessageTime, at);
    state.lastObservedWallClock = this.clock();
    state.totalMessages += 1;
    this.pruneWindow(state, at);

    // 4.0) 势能层（potential / shadow）：每条被接受的消息都喂给跟踪器与建仓回溯环。
    //      势能层的任何异常都在内部转交 onError，绝不允许污染消息主循环。
    let potentialSnapshot: PotentialSnapshot | null = null;
    if (state.options.triggerMode !== 'rate') {
      this.recordRecentMessage(state, message, at);
      potentialSnapshot = this.pushPotential(state, message, at);
    }

    const rate = this.currentRate(state, at);
    const baselineRate = this.baseline.getRate(channelId);
    const options = state.options;
    const threshold = burstThreshold(options, baselineRate);
    const evaluation = evaluateWindowEntries(state.window, options.windowSizeSeconds, at);

    // 物理层硬门限：速率之外还必须多发言人 + 低复读（信息熵）。
    const burstReady =
      evaluation.effectiveRate > threshold &&
      evaluation.uniqueSpeakers >= MIN_UNIQUE_SPEAKERS &&
      evaluation.entropyRatio >= MIN_ENTROPY_RATIO;

    // 势能判据：potential 模式用 Q/ρ 双判据裁决相位；shadow 模式只算不用（相位仍由速率判据裁决）。
    const mode = options.triggerMode;
    const baselineQuality = mode === 'rate' ? 0 : this.qualityBaseline.getRate(channelId);
    const baselineDensity = mode === 'rate' ? 0 : this.densityBaseline.getRate(channelId);
    const rhoEff = effectiveRhoMin(options, baselineDensity);
    const potentialThreshold = potentialBurstThreshold(options, baselineQuality);
    const potentialBurstInfo: PotentialBurstInfo | null =
      mode === 'potential' && potentialSnapshot !== null
        ? {
            quality: potentialSnapshot.quality,
            density: potentialSnapshot.density,
            threshold: potentialThreshold,
            baselineQuality,
            rhoEff,
          }
        : null;
    const potentialReady =
      potentialBurstInfo !== null &&
      potentialBurstInfo.quality > potentialThreshold &&
      potentialBurstInfo.density >= rhoEff;

    // 4) 基线学习（三层加固双向学习闸门）：
    //    只在 IDLE 且本条样本不构成突发时更新。
    //    - 下行无条件学习（rate <= baseline）：允许基线回落至底噪，防止高位死锁；
    //    - 上行严苛滞回（rate > baseline）：必须同时满足斜率限制与预热冻结，且按消息间隔缩放 alpha。
    if (state.phase === 'IDLE' && !burstReady) {
      const isDownside = rate <= baselineRate + RATE_EPSILON;
      const isUpsideAllowed =
        rate <= baselineRate * 1.3 + 0.5 + RATE_EPSILON &&
        rate < options.minBurstRate * 0.85;

      if (isDownside || isUpsideAllowed) {
        let alphaScale = 1.0;
        if (!isDownside) {
          const dtMs = prevMessageTime > 0 ? Math.max(0, at - prevMessageTime) : 15_000;
          alphaScale = Math.min(1.0, dtMs / 15_000);
        }
        this.learn(state, rate, at, alphaScale);
      }
    }

    // 4.5) Q 基线学习：闸门与速率基线**同构**（IDLE 才学 / 突发期冻结 / 下行无条件 / 上行滞回）。
    //      上行滞回的第二道闸门由 `minBurstRate * 0.85` 换成 `thetaMin * 0.85`；
    //      shadow 模式下 `potentialReady` 恒 false，学习只看速率相位（与旧判据裁决一致）。
    if (mode !== 'rate' && potentialSnapshot !== null && state.phase === 'IDLE' && !potentialReady) {
      const quality = potentialSnapshot.quality;
      // 冷启动预热：`b_Q` 从 0 起步时上行滞回退化为 `Q <= 0.5`，而稳态闲聊的 Q 在数十量级，
      // 数学上永远学不到第一个样本；前 `POTENTIAL_BASELINE_WARMUP` 个 IDLE 样本无条件入库，
      // 把基线抬到本群的日常量级，之后才交还给三层闸门。
      const samples = this.qualitySamples.get(channelId) ?? 0;
      if (samples < POTENTIAL_BASELINE_WARMUP) {
        this.qualitySamples.set(channelId, samples + 1);
        this.qualityBaseline.record(channelId, at, { sampleRate: quality, learn: true });
      } else {
        const isDownside = quality <= baselineQuality + RATE_EPSILON;
        // 冷启动期上行滞回以 `thetaMin` 为参照：`Q` 从 ~1 爬到数十，若仍用 `b_Q × 1.3 + 0.5`
        // （b_Q 还在个位数）则数学上永远追不上本群日常量级，自适应整条路径失效。
        // `b_Q` 一旦达到 `thetaMin`（活跃群已学到高位）就退化为契约原式 `b_Q × 1.3 + 0.5`。
        const upsideReference = Math.max(baselineQuality, options.thetaMin);
        const isUpsideAllowed =
          quality <= upsideReference * 1.3 + 0.5 + RATE_EPSILON &&
          quality < options.thetaMin * 0.85;

        if (isDownside || isUpsideAllowed) {
          let alphaScale = 1.0;
          if (!isDownside) {
            const dtMs = prevMessageTime > 0 ? Math.max(0, at - prevMessageTime) : 15_000;
            alphaScale = Math.min(1.0, dtMs / 15_000);
          }
          this.qualityBaseline.record(channelId, at, {
            sampleRate: quality,
            learn: true,
            alphaScale,
          });
        }
      }
    }

    // 4.6) 密度基线学习 `b_ρ`：与 `b_Q` **完全同构**的三层闸门（同一段代码形状、同一预热常量）。
    //      样本是本条的 `potentialSnapshot.density`；参照量从 `thetaMin` 换成 `rhoMin`。
    //      冷启动 `b_ρ = 0` ⇒ `ρ_eff = max(rhoMin, 0) = rhoMin`，逐位退化到旧判据。
    if (mode !== 'rate' && potentialSnapshot !== null && state.phase === 'IDLE' && !potentialReady) {
      const density = potentialSnapshot.density;
      const samples = this.densitySamples.get(channelId) ?? 0;
      if (samples < POTENTIAL_BASELINE_WARMUP) {
        this.densitySamples.set(channelId, samples + 1);
        this.densityBaseline.record(channelId, at, { sampleRate: density, learn: true });
      } else {
        const baselineDensity = this.densityBaseline.getRate(channelId);
        const isDownside = density <= baselineDensity + RATE_EPSILON;
        // 上行滞回的参照与 `b_Q` 同构：`max(b_ρ, rhoMin) × 1.3 + 0.5`，且样本本身
        // 还要低于 `rhoMin × 0.85` —— 接近触发口径的样本属于「异常活跃」，不入基线。
        const upsideReference = Math.max(baselineDensity, options.rhoMin);
        const isUpsideAllowed =
          density <= upsideReference * 1.3 + 0.5 + RATE_EPSILON &&
          density < options.rhoMin * 0.85;

        if (isDownside || isUpsideAllowed) {
          let alphaScale = 1.0;
          if (!isDownside) {
            const dtMs = prevMessageTime > 0 ? Math.max(0, at - prevMessageTime) : 15_000;
            alphaScale = Math.min(1.0, dtMs / 15_000);
          }
          this.densityBaseline.record(channelId, at, {
            sampleRate: density,
            learn: true,
            alphaScale,
          });
        }
      }
    }

    // 5) 讨论进行中：继续缓存。
    if (state.phase === 'BURSTING' || state.phase === 'COOLING') {
      this.appendToBuffer(state, message, at);
      state.peakRate = Math.max(state.peakRate, rate);
    }

    // 6) 状态迁移。
    //    主动书记员期间一律跳过：相位锁定 BURSTING，屏蔽自然冷却
    //    （缓冲仍由软切片 / 边界切分 / 2h 熔断保护）。
    if (!state.manualRecording) {
      if (state.phase === 'IDLE') {
        if (mode === 'potential') {
          if (potentialBurstInfo !== null && potentialReady) {
            this.startBurst(
              state,
              rate,
              at,
              potentialThreshold,
              baselineQuality,
              evaluation,
              potentialBurstInfo,
            );
          }
        } else if (burstReady) {
          this.startBurst(state, rate, at, threshold, baselineRate, evaluation);
        }
      } else if (state.phase === 'BURSTING') {
        if (mode === 'potential') {
          const coolingAt = this.potentialCoolingAt(state, at);
          if (coolingAt !== null) {
            this.enterCooling(state, coolingAt);
          }
        } else if (rate <= coolingRate(options, baselineRate) + RATE_EPSILON) {
          this.enterCooling(state, this.coolingCrossing(state, at));
        }
      } else if (state.phase === 'COOLING') {
        if (mode === 'potential') {
          if (potentialBurstInfo !== null && potentialReady) {
            // 次级突发：争论未结束，回弹到 BURSTING 并重置平息计时。
            this.resumeBurst(state, rate, describePotentialBurst(potentialBurstInfo, options));
          }
        } else if (burstReady) {
          this.resumeBurst(
            state,
            rate,
            describeBurst(threshold, baselineRate, options.burstMultiplier, evaluation),
          );
        }
      }
    }

    // 7) 极端情形下的兜底结算（例如回弹后立刻又满足平息条件）。
    this.settleDueSafely(state, at);
    this.rearm(state);
    return this.metrics(state, at);
  }

  /**
   * 同一时刻两套判据的裁决输入与结论（shadow 对照的唯一取值口径）。
   *
   * 与状态机**共用**同一批辅助函数（`burstThreshold` / `evaluateWindowEntries` /
   * `potentialBurstThreshold` / `potentialMetricsOf`），因此不会出现「遥测一套、裁决一套」
   * 的双口径漂移。只读：不推进窗口、不学习基线、不改相位。
   *
   * `at` 缺省取该群最后一条消息的逻辑时间；群未知时返回 `null`。
   */
  evaluateVerdicts(channelId: string, at?: number): TriggerVerdicts | null {
    const state = this.states.get(channelId);
    if (state === undefined) return null;
    const logicalAt = at ?? state.lastMessageTime;
    const options = state.options;
    const rate = this.currentRate(state, logicalAt);
    const baselineRate = this.baseline.getRate(channelId);
    const threshold = burstThreshold(options, baselineRate);
    const evaluation = evaluateWindowEntries(state.window, options.windowSizeSeconds, logicalAt);
    const rateReady =
      evaluation.effectiveRate > threshold &&
      evaluation.uniqueSpeakers >= MIN_UNIQUE_SPEAKERS &&
      evaluation.entropyRatio >= MIN_ENTROPY_RATIO;

    const potential = this.potentialMetricsOf(channelId, options, logicalAt);
    const potentialReady =
      options.triggerMode !== 'rate' &&
      potential.quality > potential.burstThreshold &&
      potential.density >= potential.rhoEff;

    return {
      rate: {
        ready: rateReady,
        rate,
        threshold,
        baseline: baselineRate,
        speakers: evaluation.uniqueSpeakers,
        entropy: evaluation.entropyRatio,
      },
      potential: {
        ready: potentialReady,
        quality: potential.quality,
        density: potential.density,
        rhoMin: options.rhoMin,
        rhoEff: potential.rhoEff,
        baselineDensity: potential.baselineDensity,
        interaction: potential.interaction,
        baselineQuality: potential.baselineQuality,
        burstThreshold: potential.burstThreshold,
        coolThreshold: potential.coolThreshold,
      },
    };
  }

  /**
   * 读取某群的节奏度量；缺省按「逻辑当前时间」结算（定时器失效时可作为手动驱动）。
   * 传入 `at` 可用于离线仿真推进时间。
   */
  /**
   * 取节奏快照。
   *
   * `options.settle === false` 时**纯读**：不推进结算、不重排定时器。Web 轮询必须走这条路——
   * 否则打开监控页等于用 5s 轮询驱动 `finalize`，把「看」变成「触发交付」。
   */
  getStatus(channelId: string, at?: number, options: { settle?: boolean } = {}): CadenceMetrics {
    const state = this.states.get(channelId);
    if (!state) {
      const baselineRate = this.baseline.getRate(channelId);
      const metrics: CadenceMetrics = {
        currentRate: 0,
        baselineRate,
        baselineDeviation: this.baseline.getDeviation(channelId),
        burstRatio: 0,
        lastMessageTime: 0,
        phase: 'IDLE',
        bufferedCount: 0,
      };
      if (this.defaults.triggerMode === 'rate') {
        return metrics;
      }
      // 尚未跟踪的群同样要给出势能观测（全零 + 当前门限口径），否则消费者要写两套分支。
      return { ...metrics, potential: this.potentialMetricsOf(channelId, this.defaults, this.clock()) };
    }

    const now =
      at !== undefined && Number.isFinite(at)
        ? Math.max(at, state.lastMessageTime)
        : this.logicalNow(state);

    if (options.settle !== false) {
      this.settleDueSafely(state, now);
      this.rearm(state);
    }
    return this.metrics(state, now);
  }

  /**
   * 全局默认参数热更新（面板设置覆盖层写入后调用）。
   *
   * 只改 patch 里出现的键：已建状态的群由调用方另行 `updateOptions`，
   * 未建状态的群下次 `ensureState` 时才吃到新默认值。
   */
  applyDefaultOptions(patch: Partial<TriggerOptions>): TriggerOptions {
    Object.assign(this.defaults, normalizeTriggerOptions(patch, this.defaults));
    return { ...this.defaults };
  }

  /**
   * 逐群热更新触发参数（AIMD 控制器输出的 `parameters` 可直接回灌）。
   * 返回更新后的度量快照。
   */
  updateOptions(channelId: string, options: Partial<TriggerOptions>): CadenceMetrics {
    const state = this.ensureState(channelId);
    const previousMode = state.options.triggerMode;
    state.options = normalizeTriggerOptions(options, state.options);
    this.baseline.configure(channelId, {
      alpha: state.options.baselineEwmaAlpha,
      sampleWindowSeconds: state.options.windowSizeSeconds,
    });

    if (state.options.triggerMode !== 'rate') {
      // rate → 其它：惰性建 tracker；已在 potential / shadow 时同步 α 与采样窗口。
      this.ensureTracker(channelId, state.options);
      this.qualityBaseline.configure(channelId, {
        alpha: state.options.baselineEwmaAlpha,
        sampleWindowSeconds: state.options.windowSizeSeconds,
      });
      this.densityBaseline.configure(channelId, {
        alpha: state.options.baselineEwmaAlpha,
        sampleWindowSeconds: state.options.windowSizeSeconds,
      });
    } else if (previousMode !== 'rate') {
      // 其它 → rate：清空势能残留，避免之后切回时拿到过期能量与回溯环。
      this.trackers.delete(channelId);
      this.recentMessages.delete(channelId);
      this.lastPotential.delete(channelId);
      this.qualitySamples.delete(channelId);
      this.qualityBaseline.reset(channelId);
      this.densitySamples.delete(channelId);
      this.densityBaseline.reset(channelId);
    }

    const now = this.logicalNow(state);
    this.pruneWindow(state, now);
    this.trimBuffer(state);

    if (state.phase === 'COOLING') {
      const since = state.coolingSince ?? state.lastMessageTime;
      const dynamic = this.currentQuiescence(state);
      state.quiescenceFactor = dynamic.factor;
      state.quiescenceDeadline = since + dynamic.seconds * 1000;
    }

    this.settleDueSafely(state, now);
    this.rearm(state);
    return this.metrics(state, now);
  }

  /**
   * 显式推进逻辑时间：检查所有群的平息截止点。
   * 生产环境由定时器自动调用；离线仿真/测试可传入逻辑时间做确定性推进。
   */
  tick(at?: number): void {
    const explicit = at !== undefined && Number.isFinite(at) ? at : undefined;
    for (const state of this.states.values()) {
      const now = explicit === undefined ? this.logicalNow(state) : Math.max(explicit, state.lastMessageTime);
      this.settleDueSafely(state, now);
      this.rearm(state);
    }
  }

  /** 结束 SUMMARIZING 闩锁，允许纯 IDLE 度量复位（不传则清理全部群）。 */
  completeSummarizing(channelId?: string, sessionId?: string): void {
    if (channelId === undefined) {
      for (const state of this.states.values()) {
        if (state.phase === 'SUMMARIZING') {
          state.phase = 'IDLE';
          state.summarizingSessionId = null;
          this.clearTimer(state.channelId);
        }
      }
      return;
    }
    const state = this.states.get(channelId);
    if (!state || state.phase !== 'SUMMARIZING') {
      return;
    }
    // 传了会话 id 就必须匹配：否则这是上一轮迟到的完成回调，不得清掉当前轮的闩锁。
    if (sessionId !== undefined && state.summarizingSessionId !== sessionId) {
      return;
    }
    state.phase = 'IDLE';
    state.summarizingSessionId = null;
    this.clearTimer(channelId);
  }

  // ---------------------------------------------------------------------------
  // 主动书记员（§7.2）与话题边界入口（Phase 4）
  // ---------------------------------------------------------------------------

  /** 某群是否正在主动录制。 */
  isManualRecording(channelId: string): boolean {
    return this.states.get(channelId)?.manualRecording === true;
  }

  /**
   * 开启自动书记（`patchouli.logon`）。
   *
   * 幂等：已开启时只重算度量，绝不重复清空缓冲或重置起点。
   * 相位强制 `BURSTING` 但**不清空**已累积缓冲；基线学习冻结、定时器清空、`lastSettledTime` 不动。
   */
  startManualSession(channelId: string): CadenceMetrics {
    const state = this.ensureState(channelId);
    const now = this.logicalNow(state);
    if (!state.manualRecording) {
      state.manualRecording = true;
      state.phase = 'BURSTING';
      if (state.buffer.length === 0) {
        // 空缓冲时以「此刻」为本轮起点：此时并不存在「本轮最后一条消息」，
        // 若沿用上一条历史消息的时间戳，2h 熔断会在开启瞬间立即命中。
        state.sessionStartTime = Math.max(state.lastMessageTime, now);
        state.sessionLastMessageTime = state.sessionStartTime;
      }
      state.triggerReason = MANUAL_REASON_START;
      this.baseline.setLearning(channelId, false);
      this.clearTimer(channelId);
    }
    this.pruneWindow(state, now);
    this.rearm(state);
    return this.metrics(state, now);
  }

  /**
   * 从持久化记录（`<wikiDir>/.patchouli/scribe/<channelId>.jsonl`）恢复一场进行中的录制。
   *
   * 恢复不是交付：不触发软切片、不结算、也不推进 `lastSettledTime`
   *（恢复进来的消息本就属于这场会话，不能在下一次结算时被当成「新消息」再缴一次）。
   *
   * `messages` 应只包含**尚未交付**的部分（宿主按 `<channelId>.meta.json` 的水位过滤）；
   * `deliveredUpTo > 0` 时把水位写回 `state.lastSettledTime`，保证恢复后的软切片 / 边界切分
   * 与结算都从「已交付到哪里」继续，而不会把旧片段再缴一次。
   */
  restoreManualSession(
    channelId: string,
    messages: readonly ChatMessage[],
    deliveredUpTo?: number,
  ): CadenceMetrics {
    if (messages.length === 0) {
      return this.startManualSession(channelId);
    }
    const state = this.ensureState(channelId);
    const now = this.logicalNow(state);
    const first = messages[0];
    const last = messages[messages.length - 1];

    state.manualRecording = true;
    state.phase = 'BURSTING';
    state.buffer = messages.slice();
    if (typeof deliveredUpTo === 'number' && Number.isFinite(deliveredUpTo) && deliveredUpTo > 0) {
      // 单调：水位只允许前进，绝不因为一次恢复把已结算边界回退。
      state.lastSettledTime = Math.max(state.lastSettledTime, deliveredUpTo);
    }
    state.sessionStartTime = first.timestamp;
    // 熔断计时的基准必须是**本场最后一条真实消息**的时刻，而非恢复时刻。
    state.sessionLastMessageTime = last.timestamp;
    state.peakRate = 0;
    state.burstCount = 1;
    state.coolingSince = null;
    state.quiescenceDeadline = null;
    state.quiescenceFactor = 1;
    state.triggerReason = MANUAL_REASON_RESTORE;
    this.baseline.setLearning(channelId, false);
    this.clearTimer(channelId);

    this.pruneWindow(state, now);
    this.rearm(state);
    return this.metrics(state, now);
  }

  /**
   * 结束主动书记员模式（`rec off`）：立即以 2 条为下限结算当前缓冲。
   *
   * `buffer.length < 2` 时只复位并走 `onDiscard` 诊断（绝不产出空词条）；
   * 结算成功则进入 `SUMMARIZING`，由宿主 `completeSummarizing` 收回 IDLE。
   */
  stopManualSession(channelId: string): CadenceMetrics {
    const state = this.ensureState(channelId);
    const now = this.logicalNow(state);
    if (state.manualRecording) {
      state.manualRecording = false;
      this.finalize(state, { minimumMessages: MANUAL_SESSION_MIN_MESSAGES });
      // 会话已结束：通知宿主清档，避免重启后把这一场再恢复、再交付一次。
      this.notifyManualSessionEnd(channelId, 'stop');
    }
    this.pruneWindow(state, now);
    this.rearm(state);
    return this.metrics(state, now);
  }

  /**
   * 接收语义层的边界标注（`at` 时刻前后不是同一个话题），并在缓冲内按切点交付前一段。
   *
   * 同步、无 await、无模型：语义层拿到结果后再调用，裁决延迟不进消息主循环。
   * 丢弃条件（任一命中即返回）：置信度不足 / 非有限数、相位不是 BURSTING|COOLING、
   * 切点未推进单调水位 `lastBoundaryAt`、切点不在当前缓冲区间内、
   * 主动录制期缓冲不足 `MANUAL_BOUNDARY_SLICE_MIN_MESSAGES` 条。
   */
  noteBoundary(channelId: string, at: number, confidence: number): void {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
      return;
    }
    if (confidence < MIN_BOUNDARY_CONFIDENCE || typeof at !== 'number' || !Number.isFinite(at)) {
      return;
    }
    const state = this.states.get(channelId);
    if (!state) {
      return;
    }
    if (state.phase !== 'BURSTING' && state.phase !== 'COOLING') {
      return;
    }
    const length = state.buffer.length;
    if (length === 0) {
      return;
    }
    // 单调水位：同一缓冲内只按最早的切点交付，剩余部分留给下一次标注。
    //
    // 这里**不**比较 `lastSettledTime`：它是逻辑时间（见 `normalizeMessageTime`），而 `at`
    // 与缓冲里的 `message.timestamp` 都在原始时间戳域。逻辑时间一旦因未来戳 / 投递滞后
    // 永久领先（与回溯环时基混用同源），跨域比较会把每一条合法切点都判成陈旧。
    // 「已交付不复切」由 `lastBoundaryAt`（原始域水位）+ 下面的缓冲区间判据共同保证：
    // 缓冲里只存未交付消息，因此 `timestamp < at` 的那一段必然还没交付过。
    if (at <= state.lastBoundaryAt) {
      return;
    }
    // 必须落在当前缓冲区间内（端点语义：切点之前交付，切点及之后留下）。
    if (at <= state.buffer[0].timestamp || at > state.buffer[length - 1].timestamp) {
      return;
    }
    // §7.2 的「≥25 条才切」门槛只在主动书记员期间生效；自动模式按语义层判决直接切。
    if (state.manualRecording && length < MANUAL_BOUNDARY_SLICE_MIN_MESSAGES) {
      return;
    }
    this.sliceAt(state, at);
  }

  /** 读取某群状态的防御性快照（数组均复制，外部修改不影响内部）。 */
  getState(channelId: string): GroupCadenceState | undefined {
    const state = this.states.get(channelId);
    if (!state) {
      return undefined;
    }
    return {
      ...state,
      options: { ...state.options },
      window: state.window.map((entry) => ({ message: entry.message, at: entry.at })),
      buffer: state.buffer.slice(),
    };
  }
  /** 读取某群当前生效的触发参数（未开始跟踪时返回默认参数的副本）。 */
  getOptions(channelId: string): TriggerOptions {
    const state = this.states.get(channelId);
    return { ...(state ? state.options : this.defaults) };
  }

  /**
   * 回收长期空闲的群聊状态，返回被回收的 channelId。
   *
   * 按频道常驻的结构（states/baseline/trackers/recent/timers…）此前只有 `reset()` 能清，
   * 而 `reset()` 只由显式操作触发——机器人加入的群只增不减。这里按「无未结讨论 + 空闲超过阈值」
   * 判定：这些群的缓冲已空、基线也已衰减到地板，重建成本可忽略。
   */
  sweepIdleChannels(idleMs: number, now: number = this.clock()): string[] {
    const removed: string[] = [];
    for (const [channelId, state] of [...this.states]) {
      if (state.phase === 'SUMMARIZING') continue;
      // 只看「有没有未结讨论」：`window` 里的历史条目本身就是要被回收的陈旧状态。
      if (state.buffer.length > 0) continue;
      if (now - state.lastMessageTime < idleMs) continue;
      this.reset(channelId);
      removed.push(channelId);
    }
    return removed;
  }

  /** 重置单个群聊；不传 channelId 时清空全部（含基线）。 */
  reset(channelId?: string): void {
    if (channelId === undefined) {
      for (const cancel of this.timers.values()) {
        cancel();
      }
      this.timers.clear();
      this.states.clear();
      this.baseline.reset();
      this.trackers.clear();
      this.recentMessages.clear();
      this.lastPotential.clear();
      this.qualitySamples.clear();
      this.qualityBaseline.reset();
      this.densitySamples.clear();
      this.densityBaseline.reset();
      return;
    }
    this.clearTimer(channelId);
    this.states.delete(channelId);
    this.baseline.reset(channelId);
    this.trackers.delete(channelId);
    this.recentMessages.delete(channelId);
    this.lastPotential.delete(channelId);
    this.qualitySamples.delete(channelId);
    this.qualityBaseline.reset(channelId);
    this.densitySamples.delete(channelId);
    this.densityBaseline.reset(channelId);
  }

  /** 停止所有定时器并清空状态（插件卸载时调用）。 */
  dispose(): void {
    this.reset();
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private ensureState(channelId: string): GroupCadenceState {
    const existing = this.states.get(channelId);
    if (existing) {
      return existing;
    }

    const state: GroupCadenceState = {
      channelId,
      phase: 'IDLE',
      options: { ...this.defaults },
      window: [],
      buffer: [],
      sessionStartTime: 0,
      sessionLastMessageTime: 0,
      peakRate: 0,
      burstCount: 0,
      coolingSince: null,
      quiescenceDeadline: null,
      quiescenceFactor: 1,
      summarizingSessionId: null,
      lastMessageTime: 0,
      lastObservedWallClock: this.clock(),
      lastSettledTime: 0,
      triggerReason: '',
      droppedMessages: 0,
      completedSessions: 0,
      totalMessages: 0,
      lastBaselineUpdateTs: this.baseline.getLastTimestamp(channelId),
      manualRecording: false,
      lastBoundaryAt: 0,
      sessionPeakQuality: 0,
    };
    this.states.set(channelId, state);
    this.baseline.configure(channelId, {
      alpha: state.options.baselineEwmaAlpha,
      sampleWindowSeconds: state.options.windowSizeSeconds,
    });
    if (state.options.triggerMode !== 'rate') {
      this.ensureTracker(channelId, state.options);
    }
    return state;
  }

  // ---- 势能层（potential / shadow） -----------------------------------------

  /**
   * 惰性建立某群的势能跟踪器与 Q 基线。
   *
   * Q 基线的初始速率固定为 0（见 `qualityBaseline` 字段注释）：冷启动期完全由
   * `max(thetaMin, ·)` 的下限兜底，绝不继承速率基线的先验。
   */
  private ensureTracker(channelId: string, options: TriggerOptions): PotentialTracker {
    const existing = this.trackers.get(channelId);
    if (existing) {
      return existing;
    }
    const tracker = new PotentialTracker();
    this.trackers.set(channelId, tracker);
    this.qualityBaseline.configure(channelId, {
      alpha: options.baselineEwmaAlpha,
      sampleWindowSeconds: options.windowSizeSeconds,
    });
    this.qualityBaseline.setInitialRate(channelId, 0, { resetSamples: false });
    this.densityBaseline.configure(channelId, {
      alpha: options.baselineEwmaAlpha,
      sampleWindowSeconds: options.windowSizeSeconds,
    });
    this.densityBaseline.setInitialRate(channelId, 0, { resetSamples: false });
    return tracker;
  }

  /**
   * 把消息推进建仓回溯环：时间窗 `POTENTIAL_PREROLL_MS` 与容量上限双约束。
   *
   * cutoff 与环条目都用归一化逻辑时间 `at`：逻辑时间 = `max(原始 timestamp, lastMessageTime + 墙钟流逝)`，
   * 一旦出现未来戳或投递滞后的消息就会**永久**高于原始 `timestamp`。若用逻辑 `at` 算 cutoff
   * 却拿原始 `timestamp` 比较，cutoff 会抬过随后所有诚实消息的原始戳，环逐条自剪成空。
   */
  private recordRecentMessage(state: GroupCadenceState, message: ChatMessage, at: number): void {
    const ring = this.recentMessages.get(state.channelId) ?? [];
    ring.push({ message, at });
    const cutoff = at - POTENTIAL_PREROLL_MS;
    let drop = 0;
    while (drop < ring.length && ring[drop].at <= cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      ring.splice(0, drop);
    }
    const overflow = ring.length - RECENT_MESSAGE_CAPACITY;
    if (overflow > 0) {
      ring.splice(0, overflow);
    }
    this.recentMessages.set(state.channelId, ring);
  }

  /** 记录一条消息到势能跟踪器；异常只转交 `onError`，绝不外溢到消息主循环。 */
  private pushPotential(
    state: GroupCadenceState,
    message: ChatMessage,
    at: number,
  ): PotentialSnapshot | null {
    const tracker = this.ensureTracker(state.channelId, state.options);
    try {
      const snapshot = tracker.push({ userId: message.userId, text: message.content, at });
      this.lastPotential.set(state.channelId, snapshot);
      // 本轮峰值只统计讨论进行中的势能：触发消息本身由 `startBurst` 播种，
      // IDLE 期的历史高点不得混进本轮的峰值冷却与调度质量门。
      if (state.phase === 'BURSTING' || state.phase === 'COOLING') {
        state.sessionPeakQuality = Math.max(state.sessionPeakQuality, snapshot.quality);
      }
      return snapshot;
    } catch (error) {
      this.reportError(error);
      return null;
    }
  }

  /** 组装对外导出的势能观测（`rate` 模式的调用点根本不会走到这里）。 */
  private potentialMetricsOf(
    channelId: string,
    options: TriggerOptions,
    at: number,
  ): PotentialMetrics {
    const tracker = this.trackers.get(channelId);
    const snapshot = tracker === undefined ? null : tracker.peek(at);
    const baselineQuality = this.qualityBaseline.getRate(channelId);
    const baselineDensity = this.densityBaseline.getRate(channelId);
    const sessionPeak = this.states.get(channelId)?.sessionPeakQuality ?? 0;
    return {
      energy: snapshot?.energy ?? 0,
      count: snapshot?.count ?? 0,
      density: snapshot?.density ?? 0,
      interaction: snapshot?.interaction ?? 0,
      quality: snapshot?.quality ?? 0,
      baselineQuality,
      baselineDensity,
      rhoEff: effectiveRhoMin(options, baselineDensity),
      burstThreshold: potentialBurstThreshold(options, baselineQuality),
      coolThreshold: potentialCoolThreshold(options, baselineQuality, sessionPeak),
    };
  }

  /**
   * `BURSTING → COOLING` 的精确回落时刻（闭式解）。
   *
   * `S_turn` 在无新消息时恒定，故 `Q(t) = E(t)·S_turn` 触到 `Θ_cool` 等价于
   * `E(t)` 回落到 `Θ_cool / S_turn`：`t_cool = t_k + τ·log2(E(t_k) / (Θ_cool/S_turn))`。
   * 基准取**最后一次入环的快照**（`t_k`）而不是观测时刻的衰减值：否则每次求值都会把
   * 起点向后推，冷却永远等不到（这正是速率判据里 `coolingCrossing` 的同款陷阱）。
   * `S_turn = 0`（单人独白）或 Q 已越界时直接返回 `t_k`。
   */
  private potentialCoolingCrossing(state: GroupCadenceState): number | null {
    const snapshot = this.lastPotential.get(state.channelId);
    if (snapshot === undefined) {
      return null;
    }
    const coolThreshold = potentialCoolThreshold(
      state.options,
      this.qualityBaseline.getRate(state.channelId),
      state.sessionPeakQuality,
    );
    if (snapshot.interaction <= 0 || snapshot.quality <= coolThreshold) {
      return snapshot.at;
    }
    return potentialCrossingAt(
      snapshot.energy,
      coolThreshold / Math.max(snapshot.interaction, 1e-6),
      snapshot.at,
    );
  }

  /** 冷却已到点则返回精确起点（≤ `at`），未回落返回 `null`。 */
  private potentialCoolingAt(state: GroupCadenceState, at: number): number | null {
    const crossing = this.potentialCoolingCrossing(state);
    if (crossing === null || crossing > at) {
      return null;
    }
    return Math.max(crossing, state.sessionStartTime);
  }

  /**
   * 一轮会话的等效消息数 N_equiv（§7.1）。
   *
   * 用临时 `PotentialTracker` 顺序喂入缓冲（内部按 `normalizePotentialText` 归一化）求每条
   * 信息量，再由 `effectiveMessageCount` 折算；只在 `finalize` 时算一次。
   */
  private effectiveSessionCount(messages: readonly ChatMessage[]): number {
    const tracker = new PotentialTracker();
    const infos: number[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      // 空 / 非字符串 userId 会让 push 抛 TypeError：结算侧一律按占位发言人处理，
      // 与 `startManualSession` 等入口的占位口径一致，绝不因为一条畸形消息丢掉整轮缓冲。
      const userId =
        typeof message.userId === 'string' && message.userId.length > 0
          ? message.userId
          : `anonymous:${index}`;
      // 时间戳用递增的 index（1ms 间隔）：信息量只与词面新颖度有关，与间隔无关。
      infos.push(tracker.push({ userId, text: message.content, at: index }).lastInfo);
    }
    return effectiveMessageCount(infos);
  }

  /** 势能模式的结算下限：`max(|buffer|, ⌊N_equiv⌋) ≥ minDiscussionMessages` 且 `|buffer| ≥ 4`。 */
  private potentialQualifies(messages: readonly ChatMessage[], minimumMessages: number): boolean {
    if (messages.length < POTENTIAL_MIN_SETTLEMENT_MESSAGES) {
      return false;
    }
    return Math.max(messages.length, Math.floor(this.effectiveSessionCount(messages))) >= minimumMessages;
  }

  /**
   * 逻辑当前时间：
   * 有消息时 = 最后消息逻辑时间 + 距上次观测的墙钟流逝（把「静默」也算进时间轴）；
   * 无消息时 = 墙钟时间。
   */
  private logicalNow(state: GroupCadenceState): number {
    if (state.totalMessages === 0) {
      return this.clock();
    }
    const elapsed = Math.max(0, this.clock() - state.lastObservedWallClock);
    return state.lastMessageTime + elapsed;
  }

  /** 归一化消息时间：非法值回退到墙钟，乱序消息夹紧到逻辑当前时间（时间不倒流）。 */
  private normalizeMessageTime(state: GroupCadenceState, raw: number): number {
    const wall = this.clock();
    // 时钟偏移 / 伪造时间戳不得把逻辑时钟推到未来：窗口与结算都以逻辑时间为界，
    // 一条 +365d 的消息会让 pruneWindow 的边界永远停在未来，窗口与缓冲从此不再收缩。
    const candidate =
      Number.isFinite(raw) && raw > 0 ? Math.min(raw, wall + MAX_FUTURE_SKEW_MS) : wall;
    if (state.totalMessages === 0) {
      return candidate;
    }
    const logical = state.lastMessageTime + Math.max(0, wall - state.lastObservedWallClock);
    return Math.max(candidate, logical);
  }

  private isDuplicate(state: GroupCadenceState, message: ChatMessage): boolean {
    if (typeof message.id !== 'string' || message.id.length === 0) {
      return false;
    }
    return state.window.some((entry) => entry.message.id === message.id);
  }

  /** 丢弃窗口外条目（窗口按逻辑时间升序）。 */
  private pruneWindow(state: GroupCadenceState, at: number): void {
    const boundary = at - state.options.windowSizeSeconds * 1000;
    let drop = 0;
    while (drop < state.window.length && state.window[drop].at <= boundary) {
      drop += 1;
    }
    if (drop > 0) {
      state.window.splice(0, drop);
    }
  }

  /** 瞬时速率（条/分）：窗口内条数 × 60 / windowSizeSeconds。 */
  private currentRate(state: GroupCadenceState, at: number): number {
    const windowMs = state.options.windowSizeSeconds * 1000;
    const boundary = at - windowMs;
    let count = 0;
    for (let index = state.window.length - 1; index >= 0; index -= 1) {
      if (state.window[index].at > boundary) {
        count += 1;
      } else {
        break;
      }
    }
    return (count * 60) / state.options.windowSizeSeconds;
  }

  /**
   * 计算「若此后无新消息，速率首次回落到平息门限」的精确时刻。
   * 窗口内第 (n - maxCount) 老的消息滑出窗口的那一刻，条数恰为 maxCount。
   */
  private coolingCrossing(state: GroupCadenceState, at: number): number {
    const baselineRate = this.baseline.getRate(state.channelId);
    const maxCount = coolingMaxCount(state.options, baselineRate);
    const length = state.window.length;

    if (length <= maxCount) {
      // 当前已满足回落条件：冷却自最后一条消息起算。
      return Math.max(state.sessionStartTime, state.lastMessageTime);
    }

    const index = length - maxCount - 1;
    const entry = state.window[index];
    if (entry === undefined) {
      return at;
    }
    return entry.at + state.options.windowSizeSeconds * 1000 + 1;
  }

  /**
   * 仅 IDLE 期把本次样本写入 EWMA。
   * 非 IDLE 期（BURSTING / COOLING / SUMMARIZING）由 baseline 的学习闸门绝对冻结，
   * 这里也不再调用，避免水群峰值把长期底噪刷高、造成后续漏检。
   */
  private learn(state: GroupCadenceState, rate: number, at: number, alphaScale = 1.0): void {
    this.baseline.record(state.channelId, at, { sampleRate: rate, learn: true, alphaScale });
  }

  private startBurst(
    state: GroupCadenceState,
    rate: number,
    at: number,
    threshold: number,
    baselineRate: number,
    evaluation: WindowEvaluation,
    potential?: PotentialBurstInfo,
  ): void {
    const options = state.options;
    const seed =
      potential === undefined ? this.windowSeed(state, at) : this.potentialSeed(state, at);

    state.phase = 'BURSTING';
    state.buffer = seed.messages;
    state.droppedMessages += seed.dropped;
    state.sessionStartTime = seed.startTime;
    state.sessionLastMessageTime = at;
    state.peakRate = rate;
    state.burstCount = 1;
    state.coolingSince = null;
    state.quiescenceDeadline = null;
    state.quiescenceFactor = 1;
    state.triggerReason =
      potential === undefined
        ? describeBurst(threshold, baselineRate, options.burstMultiplier, evaluation)
        : describePotentialBurst(potential, options);
    // 触发消息本身是这一轮的第一个观测点：起始峰值由它播种，
    // 否则「只触发一条就静默」的场次峰值恒为 0，调度质量门会把整轮误杀。
    state.sessionPeakQuality = Math.max(state.sessionPeakQuality, potential?.quality ?? 0);
    // 突发期基线绝对冻结：脱离 IDLE 后不再接受任何 EWMA 样本。
    this.baseline.setLearning(state.channelId, false);
    this.clearTimer(state.channelId);

    // 开场缓冲本身可能已经达到软切片阈值（超长预热窗口 / 回溯环整批补入）。
    if (state.buffer.length >= BUFFER_SOFT_SLICE_MESSAGES) {
      this.flushSlice(state, at);
    }
  }

  /** rate / shadow 模式：把「触发本次突发的滑窗消息」一并纳入讨论缓存，避免丢掉开场论点。 */
  private windowSeed(state: GroupCadenceState, at: number): BurstSeed {
    const seed = state.window.filter((entry) => entry.at > state.lastSettledTime);
    const max = state.options.maxBufferMessages;
    const dropped = Math.max(0, seed.length - max);
    const kept = dropped > 0 ? seed.slice(dropped) : seed;
    return {
      messages: kept.map((entry) => entry.message),
      startTime: kept.length > 0 ? kept[0].at : at,
      dropped,
    };
  }

  /**
   * potential 模式：从回溯环取种子。
   *
   * 环里 `at > lastSettledTime` 的消息全部纳入 —— 速率滑窗只有 60 秒，
   * 慢聊的开场 1~2 条百字长文必然已经滑出窗口，只有回溯环能把它们带进本轮缓冲。
   *
   * 过滤必须用逻辑 `at`（与 `windowSeed` 同一基准）：`lastSettledTime` 由逻辑时间推进，
   * 拿原始 `timestamp` 比较会在逻辑时间领先时把**全部**消息判成「已结算」，种子恒为空。
   */
  private potentialSeed(state: GroupCadenceState, at: number): BurstSeed {
    const ring = this.recentMessages.get(state.channelId) ?? [];
    const seed = ring.filter((entry) => entry.at > state.lastSettledTime);
    const max = state.options.maxBufferMessages;
    const dropped = Math.max(0, seed.length - max);
    const kept = dropped > 0 ? seed.slice(dropped) : seed;
    return {
      messages: kept.map((entry) => entry.message),
      startTime: kept.length > 0 ? kept[0].at : at,
      dropped,
    };
  }

  private resumeBurst(state: GroupCadenceState, rate: number, reason: string): void {
    state.phase = 'BURSTING';
    state.burstCount += 1;
    state.peakRate = Math.max(state.peakRate, rate);
    state.coolingSince = null;
    state.quiescenceDeadline = null;
    state.quiescenceFactor = 1;
    state.triggerReason = `次级突发（第 ${state.burstCount} 波）：${reason}`;
    this.baseline.setLearning(state.channelId, false);
    this.clearTimer(state.channelId);
  }

  private enterCooling(state: GroupCadenceState, since: number): void {
    const dynamic = this.currentQuiescence(state);
    state.phase = 'COOLING';
    state.coolingSince = since;
    state.quiescenceFactor = dynamic.factor;
    state.quiescenceDeadline = since + dynamic.seconds * 1000;
    this.clearTimer(state.channelId);
  }

  /** 当前平息策略：优先检查本轮缓存末尾，缓存为空时回落到滑窗末尾。 */
  private currentQuiescence(state: GroupCadenceState): DynamicQuiescence {
    const tail = state.buffer.length > 0 ? state.buffer : state.window.map((entry) => entry.message);
    return computeDynamicQuiescence(tail, state.options.quiescenceSeconds);
  }

  private appendToBuffer(state: GroupCadenceState, message: ChatMessage, at: number): void {
    state.buffer.push(message);
    state.sessionLastMessageTime = Math.max(state.sessionLastMessageTime, at);
    this.trimBuffer(state);
    // 缓冲区防爆软切片：达到阈值立即交付一个切片，相位保持不变。
    if (state.buffer.length >= BUFFER_SOFT_SLICE_MESSAGES) {
      this.flushSlice(state, at);
    }
  }

  /**
   * 缓冲区软切片：把当前缓存作为独立片段交接给下游并清空缓存。
   *
   * 与 `finalize` 的区别：**不改变相位**（仍为 BURSTING / COOLING），
   * 讨论继续累积下一段；已交付片段计入 `completedSessions` 并推进 `lastSettledTime`，
   * 避免下一轮突发把旧消息重复纳入种子缓冲。
   */
  private flushSlice(state: GroupCadenceState, at: number): void {
    if (state.buffer.length === 0) {
      return;
    }
    const messages = state.buffer.slice();
    const endTime = Math.max(state.sessionStartTime, state.sessionLastMessageTime);
    const reason =
      `${state.triggerReason || '讨论进行中'}；缓冲区软切片交付` +
      `（${messages.length} ≥ ${BUFFER_SOFT_SLICE_MESSAGES} 条）`;

    const session: DiscussionSession = {
      sessionId: randomUUID(),
      channelId: state.channelId,
      startTime: state.sessionStartTime,
      endTime,
      messages,
      peakRate: state.peakRate,
      triggerReason: reason,
      // 软切片只是进行中讨论的中间段：语义不完整，禁止作为 AIMD 门限调节依据。
      partial: true,
      potentialPeak: this.potentialPeakOf(state),
    };

    state.buffer = [];
    state.sessionStartTime = at;
    state.sessionLastMessageTime = at;
    state.peakRate = 0;
    // 切片交付后本段峰值观测作废：下一段重新起算（否则质量门会拿上一段的高点放行）。
    state.sessionPeakQuality = 0;
    state.lastSettledTime = Math.max(state.lastSettledTime, endTime);
    state.completedSessions += 1;
    this.invokeHandler(session);
  }

  /**
   * 按话题边界切分缓冲：`timestamp < at` 的消息立即作为独立片段交付，其余留待下一段。
   *
   * 与 `flushSlice` 的区别：切点来自语义层（不是条数）；与 `finalize` 的区别：
   * **相位不变**（BURSTING 仍是 BURSTING、COOLING 仍是 COOLING），不进入 SUMMARIZING、
   * 不重算 `t_cool`、不重置平息定时器、不动 `coolingSince` / `quiescenceDeadline`。
   */
  private sliceAt(state: GroupCadenceState, at: number): void {
    const delivered = state.buffer.filter((message) => message.timestamp < at);
    if (delivered.length === 0) {
      return;
    }
    const kept = state.buffer.filter((message) => message.timestamp >= at);
    const lastDelivered = delivered[delivered.length - 1];
    const endTime = Math.max(lastDelivered.timestamp, state.sessionStartTime);

    const session: DiscussionSession = {
      sessionId: randomUUID(),
      channelId: state.channelId,
      startTime: state.sessionStartTime,
      endTime,
      messages: delivered,
      peakRate: state.peakRate,
      triggerReason: `${state.triggerReason}；话题边界切分（t=${at}）`,
      // 边界切分交付的是「话题已转移」的半截会话：语义不完整，禁止作为 AIMD 依据。
      partial: true,
      potentialPeak: this.potentialPeakOf(state),
    };

    state.buffer = kept;
    state.sessionStartTime = at;
    state.sessionLastMessageTime = kept.length > 0 ? kept[kept.length - 1].timestamp : at;
    state.peakRate = 0;
    // 本段峰值随前段一起结算；下一段（新话题）从 0 重新观测。
    state.sessionPeakQuality = 0;
    // 话题边界：前段势能折半（ρ 不变），二元组窗口清空 —— 否则新话题里的常见术语
    // 会被旧话题判成「重复」，把正常讨论压成噪声。`lastPotential` 同步刷新，
    // 否则冷却闭式解仍用折半前的 E 求解，冷却时刻会被系统性推迟。
    const tracker = this.trackers.get(state.channelId);
    if (tracker !== undefined) {
      tracker.applyBoundary(BOUNDARY_ENERGY_FACTOR);
      this.lastPotential.set(state.channelId, tracker.peek(at));
    }
    state.lastSettledTime = Math.max(state.lastSettledTime, endTime);
    // 单调水位只在真正交付后推进：空片段不改变任何记账。
    state.lastBoundaryAt = at;
    state.completedSessions += 1;
    this.invokeHandler(session);
  }

  /**
   * 本轮势能峰值的会话快照（`rate` 模式或尚未观测到峰值时为 `undefined`）。
   *
   * `density` 取最后一次入环快照的密度：峰值时刻的密度没有被单独记录，
   * 而 ρ 在同一轮内的漂移远小于 Q 的量级差，作为质量门的对账口径已经足够。
   * 必须在 `sessionPeakQuality` 被清零**之前**调用。
   */
  private potentialPeakOf(state: GroupCadenceState): DiscussionSession['potentialPeak'] {
    if (state.options.triggerMode === 'rate' || state.sessionPeakQuality <= 0) {
      return undefined;
    }
    return {
      quality: state.sessionPeakQuality,
      density: this.lastPotential.get(state.channelId)?.density ?? 0,
      burstThreshold: potentialBurstThreshold(
        state.options,
        this.qualityBaseline.getRate(state.channelId),
      ),
    };
  }

  private trimBuffer(state: GroupCadenceState): void {
    const max = state.options.maxBufferMessages;
    if (state.buffer.length <= max) {
      return;
    }
    const overflow = state.buffer.length - max;
    state.buffer.splice(0, overflow);
    state.droppedMessages += overflow;
  }

  /**
   * 按逻辑时间结算：
   *  - BURSTING 且速率已回落到平息门限 → COOLING（冷却起点取精确回落时刻，而非「发现时刻」）；
   *  - COOLING 且越过 quiescenceDeadline → 交接给回调，进入 SUMMARIZING（或判定不足而丢弃）。
   */
  private settleDue(state: GroupCadenceState, at: number): void {
    // 主动书记员：屏蔽一切自动冷却，只保留 2h 静默熔断（§7.2 安全 TTL）。
    if (state.manualRecording) {
      if (at - state.sessionLastMessageTime > MAX_MANUAL_IDLE_MS) {
        state.manualRecording = false;
        this.finalize(state, { minimumMessages: MANUAL_SESSION_MIN_MESSAGES });
        // 熔断同样是「会话结束」：不通知宿主，群继续静默并重启时已结束的记录会被再次交付。
        this.notifyManualSessionEnd(state.channelId, 'fuse');
        return;
      }
      this.pruneWindow(state, at);
      return;
    }

    if (state.phase === 'IDLE' || state.phase === 'SUMMARIZING') {
      this.pruneWindow(state, at);
      return;
    }

    this.pruneWindow(state, at);
    const baselineRate = this.baseline.getRate(state.channelId);

    if (state.phase === 'BURSTING') {
      if (state.options.triggerMode === 'potential') {
        // 势能判据：Q 回落到 Θ_cool 的精确时刻由闭式解给出（起点不是「发现时刻」）。
        const coolingAt = this.potentialCoolingAt(state, at);
        if (coolingAt === null) {
          return;
        }
        this.enterCooling(state, coolingAt);
      } else {
        const rate = this.currentRate(state, at);
        if (rate > coolingRate(state.options, baselineRate) + RATE_EPSILON) {
          return;
        }
        this.enterCooling(state, this.coolingCrossing(state, at));
      }
    }

    if (state.phase === 'COOLING') {
      const deadline = state.quiescenceDeadline;
      if (deadline !== null && at >= deadline) {
        this.finalize(state);
      }
    }
  }

  /**
   * 结算求值的安全壳：异常只转交 `onError`，绝不把消息主循环 / 宿主调用栈一起带走。
   *
   * 没有这层隔离时，一次 `settleDue` 抛错会让 `onMessage` 直接抛出，而 `finalize` 早已
   * 清空缓冲、相位却停在 COOLING —— 整轮消息静默丢失。根因（畸形 `userId`）已在
   * `effectiveSessionCount` 里按占位发言人消解，这里只作最后一道闸门。
   */
  private settleDueSafely(state: GroupCadenceState, at: number): void {
    try {
      this.settleDue(state, at);
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * 结算一轮讨论：
   *  - 消息数不足下限 → 判定丢弃（`onDiscard` 诊断）并回到 IDLE（L-01 冷群/短对话保护）；
   *  - 否则移交缓冲区、进入 SUMMARIZING 并调用 onQuiescence（迟智交付点）。
   *
   * `overrides.minimumMessages` 只给主动书记员用（§7.2 放宽到 2 条），默认取
   * `state.options.minDiscussionMessages`；势能模式额外叠加 §7.1 的等效消息数折算。
   */
  private finalize(
    state: GroupCadenceState,
    overrides: { minimumMessages?: number } = {},
  ): void {
    const options = state.options;
    const messages = state.buffer.slice();
    const startTime = state.sessionStartTime;
    const endTime = Math.max(state.sessionStartTime, state.sessionLastMessageTime);
    const peakRate = state.peakRate;
    const minimumMessages = overrides.minimumMessages ?? options.minDiscussionMessages;
    const reason =
      state.burstCount > 1
        ? `${state.triggerReason}；本轮共 ${state.burstCount} 波突发`
        : state.triggerReason;

    // 判定必须先于任何状态突变：势能判据会逐条重放缓冲（`effectiveSessionCount`），
    // 而它是唯一可能因畸形消息而抛错的一步。若先清空 buffer 再判定，一次异常就会让
    // 「buffer 已清空、相位仍停在 COOLING」——整轮消息静默丢失。
    const sufficient =
      overrides.minimumMessages !== undefined
        ? messages.length >= minimumMessages
        : options.triggerMode === 'potential'
          ? this.potentialQualifies(messages, minimumMessages)
          : messages.length >= minimumMessages;

    // 峰值观测同样必须在 `resetSessionTracking` 清零之前取走。
    const potentialPeak = this.potentialPeakOf(state);

    state.buffer = [];
    state.coolingSince = null;
    state.quiescenceDeadline = null;
    state.quiescenceFactor = 1;
    state.lastSettledTime = Math.max(state.lastSettledTime, endTime);
    this.clearTimer(state.channelId);
    // 讨论结算后回到 IDLE / SUMMARIZING，解冻基线学习。
    this.baseline.setLearning(state.channelId, true);
    this.resetSessionTracking(state);

    if (!sufficient) {
      // 诊断先于相位迁移：即使回调抛错，也必须照常回到 IDLE（错误只转交 onError）。
      this.reportDiscard({
        channelId: state.channelId,
        messageCount: messages.length,
        minDiscussionMessages: minimumMessages,
        peakRate,
        triggerReason: reason,
        startTime,
        endTime,
        messages: messages.slice(),
      });
      state.phase = 'IDLE';
      return;
    }

    const session: DiscussionSession = {
      sessionId: randomUUID(),
      channelId: state.channelId,
      startTime,
      endTime,
      messages,
      peakRate,
      triggerReason: reason,
      // 平息结算交付的是完整一轮讨论：AIMD 可据此正常调节门限。
      partial: false,
      potentialPeak,
    };

    state.phase = 'SUMMARIZING';
    state.summarizingSessionId = session.sessionId;
    state.completedSessions += 1;
    this.invokeHandler(session);
  }

  /**
   * 把「判定不足而丢弃」的判定依据交给诊断回调。
   * 回调是纯观测口：任何异常都转交 `reportError`，绝不外溢到消息主循环。
   */
  private reportDiscard(info: DetectorDiscardInfo): void {
    if (!this.onDiscard) {
      return;
    }
    try {
      this.onDiscard(info);
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * 主动书记员会话结束的通知口：宿主据此删除录制文件。
   * 与 `reportDiscard` 同口径——回调是纯观测口，异常只转交 `reportError`。
   */
  private notifyManualSessionEnd(channelId: string, reason: ManualSessionEndReason): void {
    if (this.onManualSessionEnd === undefined) {
      return;
    }
    try {
      this.onManualSessionEnd(channelId, reason);
    } catch (error) {
      this.reportError(error);
    }
  }

  private resetSessionTracking(state: GroupCadenceState): void {
    state.sessionStartTime = 0;
    state.sessionLastMessageTime = 0;
    state.peakRate = 0;
    state.burstCount = 0;
    state.triggerReason = '';
    // 峰值观测属于「这一轮」：结算 / 切片之后必须清零，否则调度质量门会拿上一轮的高点
    // 给下一轮放行（峰值只增不减会让门恒定失效）。
    state.sessionPeakQuality = 0;
  }

  private invokeHandler(session: DiscussionSession): void {
    try {
      const result = this.handler(session);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error: unknown) => {
          this.reportError(error);
        });
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.onError) {
      try {
        this.onError(error);
      } catch {
        // 错误处理器自身异常不再外溢，避免污染消息主循环。
      }
      return;
    }
    console.error('[patchouli-knowledge/trigger] 平息结算失败:', error);
  }

  private metrics(state: GroupCadenceState, at: number): CadenceMetrics {
    const currentRate = this.currentRate(state, at);
    const baselineRate = this.baseline.getRate(state.channelId);
    const base: CadenceMetrics = {
      currentRate,
      baselineRate,
      baselineDeviation: this.baseline.getDeviation(state.channelId),
      burstRatio: currentRate / Math.max(baselineRate, MIN_RATE_DENOMINATOR),
      lastMessageTime: state.lastMessageTime,
      phase: state.phase,
      bufferedCount: state.buffer.length,
    };
    // rate 模式的分支逐位不变：既不填 `potential`，也不填 `manualRecording`。
    if (state.options.triggerMode !== 'rate') {
      base.potential = this.potentialMetricsOf(state.channelId, state.options, at);
      base.manualRecording = state.manualRecording;
    } else if (state.manualRecording) {
      base.manualRecording = true;
    }
    return base;
  }

  /** 依据当前相位安排下一次「必须重新求值」的时刻。 */
  private rearm(state: GroupCadenceState): void {
    this.clearTimer(state.channelId);

    if (state.manualRecording) {
      // 主动书记员：相位锁定 BURSTING，唯一需要自动求值的是 2h 静默熔断。
      this.armAt(state, state.sessionLastMessageTime + MAX_MANUAL_IDLE_MS);
      return;
    }

    if (state.phase !== 'BURSTING' && state.phase !== 'COOLING') {
      return;
    }

    let target: number | null;
    if (state.phase === 'COOLING') {
      target = state.quiescenceDeadline;
    } else if (state.options.triggerMode === 'potential') {
      // 势能模式：按 Q 的精确回落时刻预约，速率窗口的观察点在这里没有意义。
      target = this.potentialCoolingCrossing(state);
    } else {
      target = this.rateWatchTime(state);
    }
    if (target === null || !Number.isFinite(target)) {
      return;
    }
    this.armAt(state, target);
  }

  /** 在 `target`（逻辑时间）预约一次 `settleDue` 求值。 */
  private armAt(state: GroupCadenceState, target: number): void {
    const delay = Math.max(1, Math.min(target - this.logicalNow(state), MAX_TIMER_DELAY_MS));
    const channelId = state.channelId;
    const cancel = this.scheduler(() => {
      this.timers.delete(channelId);
      const current = this.states.get(channelId);
      if (!current) {
        return;
      }
      this.settleDueSafely(current, this.logicalNow(current));
      this.rearm(current);
    }, delay);

    this.timers.set(channelId, cancel);
  }

  /**
   * BURSTING 期间的「速率回落观察点」：
   * 若无新消息，窗口内第 (n - maxCount) 老的消息滑出的时刻即进入 COOLING 的时刻。
   */
  private rateWatchTime(state: GroupCadenceState): number | null {
    const baselineRate = this.baseline.getRate(state.channelId);
    const maxCount = coolingMaxCount(state.options, baselineRate);
    const length = state.window.length;
    if (length <= maxCount) {
      return this.logicalNow(state);
    }
    const entry = state.window[length - maxCount - 1];
    if (entry === undefined) {
      return null;
    }
    return entry.at + state.options.windowSizeSeconds * 1000 + 1;
  }

  private clearTimer(channelId: string): void {
    const cancel = this.timers.get(channelId);
    if (cancel) {
      this.timers.delete(channelId);
      try {
        cancel();
      } catch (error) {
        this.reportError(error);
      }
    }
  }
}
