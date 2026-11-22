/**
 * Patchouli Knowledge — 可观测性 AOP 检查器（Telemetry Inspector）
 *
 * 设计红线：
 *  - **零侵入**：不修改触发器 / 调度器 / 主流程的任何一行逻辑，全部通过
 *    「实例级原地替换（Monkey-Patching on Instance）」织入；
 *  - **100% 可还原**：每个补丁都记录「是否本就有自有属性」与「替换前的值」，
 *    `dispose()` 逆序还原——原型方法（含 `private` 方法）一律 `delete` 自有属性回到原型，
 *    主流程对象在卸载后与从未挂载过遥测完全一致；
 *  - **绝不拖垮主流程**：所有观测代码包在 `try/catch` 里，异常只累加 `errors` 计数，
 *    绝不向消息 / 结算 / 调度路径外溢；
 *  - **高信噪比**：不是「每条消息一条 trace」，而是每条消息只更新闸门与动量（快照可见），
 *    仅相位迁移、擦肩而过、冷却、结算、调度结果、AIMD 调参才落 trace。
 *
 * 织入点与产出：
 * | 织入点 | 产出 |
 * | --- | --- |
 * | `detector.onMessage` | 闸门瞬态向量、动量/RSI、基线账本增减、`NEAR_MISS`（3 分钟频控）、相位变迁 |
 * | `detector.startBurst` / `detector.enterCooling` | `PHASE_CHANGE` / `COOLING_REARM`（延长倍率、剩余秒数） |
 * | `detector.finalize` + `detector.invokeHandler` | `SESSION_FINALIZED` / `SESSION_DISCARDED`，并给会话贴附 traceId |
 * | `dispatcher.dispatch` | `DISPATCH_RESULT`（耗时、质量分、丢弃归因、traceId 连续） |
 * | `system.applyAimdTuning` | `AIMD_TUNED`（调参前后值、命中分支、硬限幅夹回字段） |
 * | `detector.baseline.record` / `detector.baseline.decay` | 基线账本精确增量（含衰减） |
 *
 * 时间基准：事件时刻一律取触发器**逻辑时间**（最后一条消息的逻辑时刻），
 * 只有 `durationMs` / `generatedAt` 使用墙钟。
 */

import { randomUUID } from 'node:crypto';

import type { DiscardReason, DiscussionSession, TriggerOptions } from '../types';
import { DISCARD_REASONS } from '../types';
import type { GroupCadenceState, TriggerVerdicts } from '../trigger/detector';
import { burstThreshold, evaluateWindowEntries, potentialBurstThreshold } from '../trigger/detector';
import type { TuningSignal, TuningTarget } from '../trigger/tuning';
import { updateParameters } from '../trigger/tuning';
import type { PatchouliKnowledgeSystem } from '../plugin/index';
import { BaselineLedger, MomentumTracker } from './ledger';
import type {
  ShadowConfigRecord,
  ShadowDecisionRecord,
  ShadowDigestRecord,
  ShadowDispatchRecord,
  ShadowRecord,
  ShadowSessionRecord,
} from './shadow-ledger';
import { RingBuffer } from './ring-buffer';
import type {
  ChannelTelemetrySnapshot,
  GateStatus,
  TelemetryCounters,
  TelemetryData,
  TelemetryEventKind,
  TelemetrySnapshot,
  TelemetryTrace,
} from './types';
import {
  createEmptyGate,
  createEmptyTelemetrySnapshot,
  createTelemetryCounters,
  isFiniteNumber,
  isRecord,
  NEAR_MISS_COOLDOWN_MS,
  NEAR_MISS_RATE_RATIO,
  TELEMETRY_CHANNEL_TRACE_CAPACITY,
  TELEMETRY_EPSILON,
  TELEMETRY_TRACE_CAPACITY,
} from './types';

/** Inspector 的可注入参数（测试用；生产一律走默认值）。 */
export interface InspectorOptions {
  /** 墙钟（仅 `generatedAt` 与真实 I/O 耗时使用），默认 `Date.now`。 */
  now?: () => number;
  /** 全局 trace 容量，默认 `TELEMETRY_TRACE_CAPACITY`。 */
  traceCapacity?: number;
  /** 单频道 trace 容量，默认 `TELEMETRY_CHANNEL_TRACE_CAPACITY`。 */
  channelTraceCapacity?: number;
  /** NEAR_MISS 频控窗口（逻辑毫秒），默认 `NEAR_MISS_COOLDOWN_MS`。 */
  nearMissCooldownMs?: number;
  /** NEAR_MISS 速率比例，默认 `NEAR_MISS_RATE_RATIO`。 */
  nearMissRatio?: number;
  /**
   * 判据持久化落点（可选）：裁决点与会话结算的**可落盘**副本。
   *
   * 与内存 trace 的区别：trace 是给人看的流水（重启即失），这份记录是给三天后
   * 两套判据对照用的台账（`shadow-ledger.ts` 追加 JSONL）。回调抛出的异常只计 `errors`，
   * 绝不外溢到消息 / 结算路径。
   */
  onRecord?: (record: ShadowRecord) => void;
}

type AnyFunction = (...args: unknown[]) => unknown;

interface ChannelRuntime {
  channelId: string;
  /** 已上报给遥测的相位（用于相位变迁去重）。 */
  phase: GroupCadenceState['phase'];
  gate: GateStatus;
  /** 本轮讨论事件链 ID；进入新突发时重建。 */
  episodeTraceId: string | null;
  /** 上次 NEAR_MISS 上报的逻辑时刻（频控）。 */
  nearMissAt: number | null;
  /** 上次落盘裁决点的去重键（`phase|rateReady|potentialReady`）：只在结论跳变时记一条。 */
  decisionKey: string | null;
  /** 当前小时的标定摘要累加器（无消息时为 null，跨小时即落盘重置）。 */
  digest: DigestAccumulator | null;
  /** 本进程是否已为该群记过参数快照（每群一条，与 `triggerMode` 无关；AIMD 另记）。 */
  configSeen: boolean;
  /** 本轮的事件链 ID 是否已由 `recordJudgement` 提前轮换（避免 `observePhase` 再生成一个）。 */
  episodeFresh: boolean;
  momentum: MomentumTracker;
  ledger: BaselineLedger;
  traces: RingBuffer<TelemetryTrace>;
  counters: TelemetryCounters;
}

/** 小时摘要的累加器：只在内存里滚，跨小时落一条 `digest` 记录。 */
interface DigestAccumulator {
  hour: string;
  messages: number;
  maxQuality: number;
  maxDensity: number;
  maxRate: number;
  maxInteraction: number;
  rateReady: number;
  potentialReady: number;
  disagreed: number;
  /** 满足 NEAR_MISS **原始判定**的消息条数（未经频控；判据侧随 `triggerMode`）。 */
  nearMiss: number;
}

/**
 * 从织入实参中读取频道 ID：`baseline.record/decay` 首参是 channelId 字符串，
 * 触发器内部方法首参是携带 `channelId` 的状态 / 消息对象。
 */
function readChannelId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  const channelId = value.channelId;
  return typeof channelId === 'string' ? channelId : '';
}

function isDiscussionSession(value: unknown): value is DiscussionSession {
  return isRecord(value) && typeof value.channelId === 'string' && typeof value.sessionId === 'string';
}

/** 遥测向量的势能层七元组（`CadenceMetrics.potential` 的子集，口径完全一致）。 */
interface PotentialVector {
  quality: number;
  density: number;
  interaction: number;
  baselineQuality: number;
  coolThreshold: number;
  /** 本次裁决实际生效的密度下限 ρ_eff（旧版探测对象缺失时为 undefined）。 */
  rhoEff?: number;
  /** 逐群学习的密度基线 b_ρ。 */
  baselineDensity?: number;
}

/** 五个值全部有限才接受该向量；任一缺失即整体放弃，绝不伪造 0。 */
function readPotentialVector(value: unknown): PotentialVector | null {
  if (!isRecord(value)) return null;
  const { quality, density, interaction, baselineQuality, coolThreshold, rhoEff, baselineDensity } = value;
  if (
    !isFiniteNumber(quality) ||
    !isFiniteNumber(density) ||
    !isFiniteNumber(interaction) ||
    !isFiniteNumber(baselineQuality) ||
    !isFiniteNumber(coolThreshold)
  ) {
    return null;
  }
  return {
    quality,
    density,
    interaction,
    baselineQuality,
    coolThreshold,
    ...(isFiniteNumber(rhoEff) ? { rhoEff } : {}),
    ...(isFiniteNumber(baselineDensity) ? { baselineDensity } : {}),
  };
}

/** 读取实例上的方法（含 TS `private` 方法：`private` 只是编译期约束）。 */
function readMethod(target: object, name: string): AnyFunction {
  const holder = target as Record<string, unknown>;
  const candidate = holder[name];
  if (typeof candidate !== 'function') {
    throw new TypeError(`[patchouli/telemetry] 织入点 ${name} 不是可调用方法`);
  }
  return candidate as AnyFunction;
}

/**
 * 实例级原地替换：写入自有属性遮蔽原型方法，返回的还原器负责恢复。
 *
 * 还原语义严格区分两种情形：本就有自有属性（如构造器里赋值的 `handler`）→ 写回旧值；
 * 只有原型方法 → `delete` 自有属性，实例重新落回原型，`hasOwnProperty` 同步回到 `false`。
 */
function replaceMethod(
  target: object,
  name: string,
  factory: (original: AnyFunction) => AnyFunction,
): () => void {
  const holder = target as Record<string, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(holder, name);
  const previous = holder[name];
  const original = readMethod(target, name);
  holder[name] = factory((...args: unknown[]): unknown => original.apply(target, args));
  return () => {
    if (hadOwn) {
      holder[name] = previous;
    } else {
      delete holder[name];
    }
  };
}

/**
 * 可观测性 AOP 检查器。
 *
 * 典型用法：
 * ```ts
 * const inspector = attachTelemetry(system);   // 等价于 new PatchouliInspector().attachTelemetry(system)
 * const snapshot = inspector.getTelemetrySnapshot();
 * system.dispose();                            // → inspector.dispose() → 全部补丁还原
 * ```
 */
export class PatchouliInspector {
  private readonly clock: () => number;
  private readonly traceCapacity: number;
  private readonly channelTraceCapacity: number;
  private readonly nearMissCooldownMs: number;
  private readonly nearMissRatio: number;
  /** 判据持久化落点（未配置时只走内存 trace）。 */
  private readonly onRecord: ((record: ShadowRecord) => void) | undefined;
  private readonly traces: RingBuffer<TelemetryTrace>;
  private readonly channels = new Map<string, ChannelRuntime>();
  /** 会话 → 事件链 traceId（会话交付时贴附，调度器回执据此回填）。 */
  private sessionTraces = new WeakMap<DiscussionSession, string>();
  private restores: Array<() => void> = [];
  private system: PatchouliKnowledgeSystem | null = null;
  private errorCount = 0;
  /** `finalize` 嵌套深度与本次结算捕获到的会话（同步调用，单线程即安全）。 */
  private finalizeDepth = 0;
  private finalizeSession: DiscussionSession | null = null;

  constructor(options: InspectorOptions = {}) {
    this.clock = typeof options.now === 'function' ? options.now : (): number => Date.now();
    const traceCapacity = options.traceCapacity;
    this.traceCapacity =
      isFiniteNumber(traceCapacity) && Number.isInteger(traceCapacity) && traceCapacity > 0
        ? traceCapacity
        : TELEMETRY_TRACE_CAPACITY;
    const channelTraceCapacity = options.channelTraceCapacity;
    this.channelTraceCapacity =
      isFiniteNumber(channelTraceCapacity) && Number.isInteger(channelTraceCapacity) && channelTraceCapacity > 0
        ? channelTraceCapacity
        : TELEMETRY_CHANNEL_TRACE_CAPACITY;
    const cooldownMs = options.nearMissCooldownMs;
    this.nearMissCooldownMs =
      isFiniteNumber(cooldownMs) && cooldownMs > 0 ? cooldownMs : NEAR_MISS_COOLDOWN_MS;
    const ratio = options.nearMissRatio;
    this.nearMissRatio = isFiniteNumber(ratio) && ratio > 0 ? ratio : NEAR_MISS_RATE_RATIO;
    this.onRecord = options.onRecord;
    this.traces = new RingBuffer<TelemetryTrace>(this.traceCapacity);
  }

  /** 已挂载的系统（未挂载时 `null`）。 */
  get attachedTo(): PatchouliKnowledgeSystem | null {
    return this.system;
  }

  /** 遥测自身吞掉的异常次数。 */
  get errors(): number {
    return this.errorCount;
  }

  /**
   * 把本检查器挂载到系统上（幂等：重复挂载同一系统直接返回自身）。
   *
   * 挂载顺序固定：基线账本 → 触发器 → 调度器 → 宿主 AIMD，确保任一织入点内部
   * 触发的下游调用都已被更外层的补丁覆盖（例如 `finalize` 期间的 `dispatch`）。
   */
  attachTelemetry(system: PatchouliKnowledgeSystem): PatchouliInspector {
    if (this.system === system) {
      return this;
    }
    if (this.system !== null) {
      this.dispose();
    }
    this.system = system;
    this.installBaselinePatches(system);
    this.installDetectorPatches(system);
    this.installDispatcherPatches(system);
    this.installSystemPatches(system);
    return this;
  }

  /**
   * 100% 还原所有猴子补丁并清空状态（幂等）。
   *
   * 逆序还原（后挂的先摘），单个还原器异常不得阻断其余还原。
   */
  /** 遗忘单群运行时（群被空闲回收时调用，避免 traces/ledger 随群数永久累积）。 */
  forgetChannel(channelId: string): boolean {
    return this.channels.delete(channelId);
  }

  dispose(): void {
    // 未满一小时的摘要不能被卸载吞掉：用最后的逻辑时间落一条残片记录。
    for (const [channelId, runtime] of this.channels) {
      if (runtime.digest !== null) {
        this.flushDigest(channelId, runtime.digest, runtime.gate.lastMessageTime, runtime);
      }
    }
    for (let index = this.restores.length - 1; index >= 0; index -= 1) {
      try {
        this.restores[index]();
      } catch {
        this.errorCount += 1;
      }
    }
    this.restores = [];
    this.finalizeDepth = 0;
    this.finalizeSession = null;
    this.channels.clear();
    this.traces.clear();
    this.sessionTraces = new WeakMap<DiscussionSession, string>();
    this.system = null;
  }

  /**
   * 读取高信噪比监控快照。
   *
   * 纯读：只刷新闸门显示（`detector.getState` 的防御副本），绝不推进状态机、绝不产出 trace。
   */
  getTelemetrySnapshot(): TelemetrySnapshot {
    const system = this.system;
    if (system === null) {
      return createEmptyTelemetrySnapshot(this.clock());
    }

    const channels: ChannelTelemetrySnapshot[] = [];
    const totals = createTelemetryCounters();

    for (const runtime of [...this.channels.values()].sort((a, b) => a.channelId.localeCompare(b.channelId))) {
      try {
        const state = system.detector.getState(runtime.channelId);
        if (state) {
          runtime.gate = this.buildGate(state);
        }
      } catch {
        this.errorCount += 1;
      }

      const reference = runtime.gate.lastMessageTime;
      channels.push({
        channelId: runtime.channelId,
        gate: { ...runtime.gate },
        momentum: runtime.momentum.snapshot(),
        baseline: runtime.ledger.snapshot(reference),
        traces: runtime.traces.toArray(),
        counters: { ...runtime.counters },
      });
      accumulateCounters(totals, runtime.counters);
    }

    return {
      attached: true,
      generatedAt: this.clock(),
      channels,
      traces: this.traces.toArray(),
      totals,
      errors: this.errorCount,
    };
  }

  // ---------------------------------------------------------------------------
  // 织入：基线估算器（精确增量账本）
  // ---------------------------------------------------------------------------

  private installBaselinePatches(system: PatchouliKnowledgeSystem): void {
    const baseline = system.detector.baseline;

    this.restores.push(
      replaceMethod(baseline, 'record', (original) => (...args: unknown[]): unknown => {
        const channelId = readChannelId(args[0]);
        const before = channelId.length > 0 ? baseline.getRate(channelId) : 0;
        const result = original(...args);
        try {
          this.observeBaselineSample(channelId, before, result);
        } catch {
          this.errorCount += 1;
        }
        return result;
      }),
    );

    this.restores.push(
      replaceMethod(baseline, 'decay', (original) => (...args: unknown[]): unknown => {
        const channelId = readChannelId(args[0]);
        const before = channelId.length > 0 ? baseline.getRate(channelId) : 0;
        const result = original(...args);
        try {
          if (channelId.length > 0) {
            const after = isFiniteNumber(result) ? result : before;
            const at = baseline.getLastTimestamp(channelId);
            this.channel(channelId).ledger.recordDecay(at, before, after);
          }
        } catch {
          this.errorCount += 1;
        }
        return result;
      }),
    );
  }

  /** `baseline.record` 回执 → 账本（只统计确实写入 EWMA 的样本）。 */
  private observeBaselineSample(channelId: string, before: number, observation: unknown): void {
    if (channelId.length === 0 || !isRecord(observation) || observation.learned !== true) {
      return;
    }
    const after = isFiniteNumber(observation.baselineRate) ? observation.baselineRate : before;
    const at = isFiniteNumber(observation.timestamp) ? observation.timestamp : this.clock();
    this.channel(channelId).ledger.recordSample(at, before, after);
  }

  // ---------------------------------------------------------------------------
  // 织入：触发器状态机
  // ---------------------------------------------------------------------------

  private installDetectorPatches(system: PatchouliKnowledgeSystem): void {
    const detector = system.detector;

    this.restores.push(
      replaceMethod(detector, 'onMessage', (original) => (...args: unknown[]): unknown => {
        const channelId = readChannelId(args[0]);
        if (channelId.length === 0) {
          return original(...args);
        }

        let before: GroupCadenceState | undefined;
        let sampleCountBefore = 0;
        let baselineBefore = 0;
        try {
          before = detector.getState(channelId);
          sampleCountBefore = detector.baseline.getSampleCount(channelId);
          baselineBefore = detector.baseline.getRate(channelId);
        } catch {
          this.errorCount += 1;
        }

        const result = original(...args);

        try {
          this.observeMessage(channelId, before, sampleCountBefore, baselineBefore);
        } catch {
          this.errorCount += 1;
        }
        return result;
      }),
    );

    this.restores.push(
      replaceMethod(detector, 'startBurst', (original) => (...args: unknown[]): unknown => {
        const result = original(...args);
        try {
          const channelId = readChannelId(args[0]);
          if (channelId.length > 0) {
            this.observePhase(channelId, this.currentGate(channelId), 'startBurst');
          }
        } catch {
          this.errorCount += 1;
        }
        return result;
      }),
    );

    this.restores.push(
      replaceMethod(detector, 'enterCooling', (original) => (...args: unknown[]): unknown => {
        const result = original(...args);
        try {
          const channelId = readChannelId(args[0]);
          if (channelId.length > 0) {
            this.observeCooling(channelId);
          }
        } catch {
          this.errorCount += 1;
        }
        return result;
      }),
    );

    this.restores.push(
      replaceMethod(detector, 'finalize', (original) => (...args: unknown[]): unknown => {
        const channelId = readChannelId(args[0]);
        if (channelId.length === 0) {
          return original(...args);
        }
        const before = detector.getState(channelId);
        this.finalizeDepth += 1;
        this.finalizeSession = null;
        let failed = false;
        try {
          return original(...args);
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          this.finalizeDepth -= 1;
          const session = this.finalizeSession;
          this.finalizeSession = null;
          try {
            if (!failed) {
              this.observeFinalize(channelId, before, session);
            }
          } catch {
            this.errorCount += 1;
          }
        }
      }),
    );

    // 会话唯一出口（finalize 与软切片 flushSlice 都走这里）：贴附事件链 traceId。
    this.restores.push(
      replaceMethod(detector, 'invokeHandler', (original) => (...args: unknown[]): unknown => {
        try {
          const session = args[0];
          if (isDiscussionSession(session)) {
            const runtime = this.channel(session.channelId);
            this.sessionTraces.set(session, this.ensureEpisode(runtime));
            if (this.finalizeDepth > 0 && this.finalizeSession === null) {
              this.finalizeSession = session;
            }
          }
        } catch {
          this.errorCount += 1;
        }
        return original(...args);
      }),
    );
  }

  /** 一条消息落定后的完整观测：闸门 → 动量 → 基线拒绝归因 → 擦肩而过 → 相位。 */
  private observeMessage(
    channelId: string,
    before: GroupCadenceState | undefined,
    sampleCountBefore: number,
    baselineBefore: number,
  ): void {
    const system = this.system;
    if (system === null) return;
    const state = system.detector.getState(channelId);
    if (!state) return;

    const runtime = this.channel(channelId);
    const gate = this.buildGate(state);
    // 首条消息前该群尚无状态（`before === undefined`），此时 totalMessages === 1 即代表被处理。
    const processed =
      before === undefined ? state.totalMessages === 1 : state.totalMessages === before.totalMessages + 1;

    if (processed) {
      runtime.counters.observedMessages += 1;
      runtime.momentum.observe(gate.rate, gate.lastMessageTime);
      this.classifyBaselineRejection(runtime, state, gate, sampleCountBefore, baselineBefore);
      // 参数快照与判据模式无关：`rate` 群同样需要门限快照，否则跨天比较时那些样本连
      // 「当时的参数」都无从核对。原先只在 digest 跨小时分支里记，而 `rate` 在
      // `recordJudgement` 就被提前 return，连一条都落不下来。
      if (!runtime.configSeen) {
        runtime.configSeen = true;
        this.persistConfig(channelId, state, gate.lastMessageTime, 'startup', null);
      }
    }

    runtime.gate = gate;
    this.observeNearMiss(runtime, gate, processed);
    if (processed) {
      // 进新突发时先轮换事件链：否则本轮最关键的裁决点会挂到上一轮的 episodeId 上，
      // 事后 decision → session → dispatch 三段就 join 不上。
      // `runtime.phase !== 'BURSTING'` 保证只轮换一次：`startBurst` 的补丁可能已经
      // 先调用过 `observePhase` 完成迁移并生成事件链，这里再换一个 ID 就会让
      // decision 与本轮 session/dispatch 分属两条链。
      if (
        state.phase === 'BURSTING' &&
        runtime.phase !== 'BURSTING' &&
        (before?.phase === 'IDLE' || before?.phase === 'SUMMARIZING')
      ) {
        runtime.episodeTraceId = randomUUID();
        runtime.episodeFresh = true;
      }
      this.recordJudgement(
        channelId,
        before,
        state,
        gate.lastMessageTime,
        state.buffer.length,
        gate.nearMiss,
      );
    }
    this.observePhase(channelId, gate, 'onMessage');
  }

  /**
   * 基线账本拒绝归因：样本未能写入 EWMA 时，区分「学习闸门冻结」与「上行滞回」。
   *
   * 只在「本条消息真的推进了状态机」且「前后都处于 IDLE」时判定，
   * 重投消息 / 突发迁移期间的冻结不计入拒绝，避免账本被噪声灌满。
   */
  private classifyBaselineRejection(
    runtime: ChannelRuntime,
    state: GroupCadenceState,
    gate: GateStatus,
    sampleCountBefore: number,
    baselineBefore: number,
  ): void {
    const system = this.system;
    if (system === null) return;
    const baseline = system.detector.baseline;
    if (baseline.getSampleCount(runtime.channelId) !== sampleCountBefore) {
      return;
    }
    if (state.phase !== 'IDLE') {
      return;
    }
    const at = gate.lastMessageTime;
    if (!baseline.isLearning(runtime.channelId)) {
      runtime.ledger.recordRejection(at, 'prewarm');
      return;
    }
    const grew = gate.rate > baselineBefore + TELEMETRY_EPSILON;
    if (!grew) {
      return;
    }
    const withinSlope = gate.rate <= baselineBefore * 1.3 + 0.5 + TELEMETRY_EPSILON;
    const belowCeiling = gate.rate < state.options.minBurstRate * 0.85;
    if (!withinSlope || !belowCeiling) {
      runtime.ledger.recordRejection(at, 'hysteresis');
    }
  }

  /**
   * 擦肩而过：判据层与该群 `triggerMode` 一致——`potential` 比 Q 与 ρ，`rate` / `shadow`
   * 比有效速率。带 3 分钟（逻辑时间）频控。
   */
  private observeNearMiss(runtime: ChannelRuntime, gate: GateStatus, processed: boolean): void {
    if (!processed || !gate.nearMiss) {
      return;
    }
    const at = gate.lastMessageTime;
    if (runtime.nearMissAt !== null && at - runtime.nearMissAt < this.nearMissCooldownMs) {
      runtime.counters.nearMissSuppressed += 1;
      return;
    }
    runtime.nearMissAt = at;
    runtime.counters.nearMiss += 1;
    const ratioThreshold = this.nearMissRatio * gate.threshold;
    const potential =
      gate.rhoMin !== undefined && gate.quality !== undefined && gate.density !== undefined
        ? { quality: gate.quality, density: gate.density, rhoMin: gate.rhoMin, rhoEff: gate.rhoEff }
        : null;
    const headline =
      potential === null
        ? `擦肩而过：有效速率 ${gate.rate.toFixed(2)} ≥ ${ratioThreshold.toFixed(2)}` +
          `（门限 ${gate.threshold.toFixed(2)}），发言人 ${gate.speakers}，未进入 BURSTING`
        : `擦肩而过：有效势能 Q ${potential.quality.toFixed(2)} ≥ ${ratioThreshold.toFixed(2)}` +
          `（Θ_burst ${gate.threshold.toFixed(2)}，ρ ${potential.density.toFixed(2)} ≥ ρ_eff ${potential.rhoEff?.toFixed(2) ?? potential.rhoMin}），` +
          `发言人 ${gate.speakers}，未进入 BURSTING`;
    this.emit(
      runtime,
      'NEAR_MISS',
      at,
      headline,
      {
        rate: gate.rate,
        baseline: gate.baseline,
        threshold: gate.threshold,
        distance: gate.threshold - (potential === null ? gate.rate : potential.quality),
        speakers: gate.speakers,
        entropy: gate.entropy,
        ratio: this.nearMissRatio,
        cooldownMs: this.nearMissCooldownMs,
        ...this.potentialTraceData(gate),
      },
      gate,
    );
  }

  /** 冷却期重装：延长倍率与剩余秒数。 */
  private observeCooling(channelId: string): void {
    const system = this.system;
    if (system === null) return;
    const state = system.detector.getState(channelId);
    if (!state) return;
    const runtime = this.channel(channelId);
    const gate = this.buildGate(state);
    runtime.gate = gate;

    const coolingSince = state.coolingSince ?? state.lastMessageTime;
    const deadline = state.quiescenceDeadline ?? coolingSince;
    const windowSeconds = Math.max(0, (deadline - coolingSince) / 1000);
    const remainingSeconds = Math.max(0, (deadline - Math.max(coolingSince, state.lastMessageTime)) / 1000);

    this.emit(
      runtime,
      'COOLING_REARM',
      gate.lastMessageTime,
      `进入冷却：平息期 ×${state.quiescenceFactor.toFixed(2)}（${windowSeconds.toFixed(0)} 秒），` +
        `自末条消息起剩余 ${remainingSeconds.toFixed(0)} 秒`,
      {
        extendFactor: state.quiescenceFactor,
        windowSeconds,
        remainingSeconds,
        coolingSince,
        deadline,
        buffered: state.buffer.length,
        burstCount: state.burstCount,
      },
      gate,
    );

    this.observePhase(channelId, gate, 'enterCooling');
  }

  /**
   * 判据观测总入口（每条被处理的消息调用一次）：两侧结论只算一次，分发给
   * 「小时摘要累加」与「裁决点落盘」两个消费者，避免重复求值。
   */
  private recordJudgement(
    channelId: string,
    before: GroupCadenceState | undefined,
    state: GroupCadenceState,
    at: number,
    buffered: number,
    nearMiss: boolean,
  ): void {
    const sink = this.onRecord;
    const system = this.system;
    if (sink === undefined || system === null) return;
    if (state.options.triggerMode === 'rate') return;
    try {
      const verdicts = system.detector.evaluateVerdicts(channelId, at);
      if (verdicts === null) return;
      const runtime = this.channel(channelId);
      this.accumulateDigest(channelId, at, verdicts, nearMiss, runtime);
      this.persistDecision(channelId, before, state, at, buffered, verdicts, runtime, sink);
    } catch {
      this.errorCount += 1;
    }
  }

  /**
   * 小时摘要累加：这是**标定**用的分布数据（最大 Q / 最大 ρ / 各判据 ready 次数）。
   *
   * 只保存每群每小时的极值与计数，不保存每条消息——三天后据此判断
   * `Θ_min` / `ρ_min` 是否定得过高，而台账体积与消息量无关。
   *
   * `nearMiss` 是**判据侧**的原始判定（`gate.nearMiss`：IDLE 且判据越过擦肩阈值），
   * 不是上报侧口径——它未经 NEAR_MISS 频控，也不等于 trace 里的 `NEAR_MISS` 条数。
   */
  private accumulateDigest(
    channelId: string,
    at: number,
    verdicts: TriggerVerdicts,
    nearMiss: boolean,
    runtime: ChannelRuntime,
  ): void {
    const hour = new Date(at).toISOString().slice(0, 13);
    let acc = runtime.digest;
    if (acc === null || acc.hour !== hour) {
      if (acc !== null) this.flushDigest(channelId, acc, at, runtime);
      acc = {
        hour,
        messages: 0,
        maxQuality: 0,
        maxDensity: 0,
        maxRate: 0,
        maxInteraction: 0,
        rateReady: 0,
        potentialReady: 0,
        disagreed: 0,
        nearMiss: 0,
      };
      runtime.digest = acc;
    }
    acc.messages += 1;
    acc.maxQuality = Math.max(acc.maxQuality, verdicts.potential.quality);
    acc.maxDensity = Math.max(acc.maxDensity, verdicts.potential.density);
    acc.maxRate = Math.max(acc.maxRate, verdicts.rate.rate);
    acc.maxInteraction = Math.max(acc.maxInteraction, verdicts.potential.interaction);
    if (verdicts.rate.ready) acc.rateReady += 1;
    if (verdicts.potential.ready) acc.potentialReady += 1;
    if (verdicts.rate.ready !== verdicts.potential.ready) acc.disagreed += 1;
    if (nearMiss) acc.nearMiss += 1;
  }

  /** 摘要落盘（跨小时 / 卸载时）：`at` 取触发落盘的那条消息的逻辑时间。 */
  private flushDigest(
    channelId: string,
    acc: DigestAccumulator,
    at: number,
    runtime: ChannelRuntime,
  ): void {
    const sink = this.onRecord;
    if (sink === undefined) return;
    try {
      const record: ShadowDigestRecord = {
        kind: 'digest',
        at,
        iso: new Date(at).toISOString(),
        channelId,
        hour: acc.hour,
        messages: acc.messages,
        maxQuality: acc.maxQuality,
        maxDensity: acc.maxDensity,
        maxRate: acc.maxRate,
        maxInteraction: acc.maxInteraction,
        rateReadyMessages: acc.rateReady,
        potentialReadyMessages: acc.potentialReady,
        disagreed: acc.disagreed,
        nearMiss: acc.nearMiss,
      };
      sink(record);
      runtime.digest = null;
    } catch {
      this.errorCount += 1;
    }
  }

  /** 参数快照落盘：`before` 只在 AIMD 调参时有值。 */
  private persistConfig(
    channelId: string,
    state: GroupCadenceState,
    at: number,
    reason: 'startup' | 'aimd',
    before: ShadowConfigRecord['before'],
  ): void {
    const sink = this.onRecord;
    if (sink === undefined) return;
    try {
      const options = state.options;
      const tuning = this.system?.getTuningSnapshot(channelId);
      const record: ShadowConfigRecord = {
        kind: 'config',
        at,
        iso: new Date(at).toISOString(),
        channelId,
        reason,
        triggerMode: options.triggerMode,
        thetaMin: options.thetaMin,
        burstMultiplier: options.burstMultiplier,
        rhoMin: options.rhoMin,
        coolingRatioThreshold: options.coolingRatioThreshold,
        minDiscussionMessages: options.minDiscussionMessages,
        before,
        decayFactor: tuning === undefined ? null : tuning.decayFactor ?? null,
      };
      sink(record);
    } catch {
      this.errorCount += 1;
    }
  }

  /**
   * 裁决点落盘：只在「结论跳变」时记一条，避免每条消息刷满台账。
   *
   * 结论键 = `相位|速率判据ready|势能判据ready`；相位迁移本身也强制记一条
   * （即便两侧 ready 未变，迁移点仍是事后复盘的关键锚点）。
   */
  private persistDecision(
    channelId: string,
    before: GroupCadenceState | undefined,
    state: GroupCadenceState,
    at: number,
    buffered: number,
    verdicts: TriggerVerdicts,
    runtime: ChannelRuntime,
    sink: (record: ShadowRecord) => void,
  ): void {
    const phaseChanged = before !== undefined && before.phase !== state.phase;
    const key = `${state.phase}|${verdicts.rate.ready}|${verdicts.potential.ready}`;
    if (!phaseChanged && runtime.decisionKey === key) return;
    runtime.decisionKey = key;
    const record: ShadowDecisionRecord = {
      kind: 'decision',
      at,
      iso: new Date(at).toISOString(),
      channelId,
      triggerMode: state.options.triggerMode,
      phase: state.phase,
      rate: verdicts.rate,
      potential: verdicts.potential,
      agree: verdicts.rate.ready === verdicts.potential.ready,
      buffered,
      episodeId: runtime.episodeTraceId,
    };
    sink(record);
  }

  /** 会话结算落盘：`messages` 与 `delivered` 是「两套判据各沉淀多少」的唯一口径。 */
  private recordSession(
    channelId: string,
    state: GroupCadenceState,
    at: number,
    session: DiscussionSession | null,
    buffered: number,
    peakRate: number,
  ): void {
    const sink = this.onRecord;
    if (sink === undefined) return;
    try {
      const record: ShadowSessionRecord = {
        kind: 'session',
        at,
        iso: new Date(at).toISOString(),
        channelId,
        sessionId: session?.sessionId ?? `${channelId}@${at}`,
        verdict: session === null ? 'discarded' : 'finalized',
        messages: session === null ? buffered : session.messages.length,
        peakRate: session === null ? peakRate : session.peakRate,
        delivered: session !== null,
        reason:
          session === null
            ? `below-min(${buffered}<${state.options.minDiscussionMessages})`
            : null,
        episodeId: session === null ? null : this.sessionTraces.get(session) ?? null,
        triggerMode: state.options.triggerMode,
        // `potentialPeak` 只落在 finalized 且势能侧确有观测的记录上（rate 模式 / 未观测到峰值
        // 时为 undefined，不写字段，与旧记录形状保持一致）。
        ...(session !== null && session.potentialPeak !== undefined
          ? { potentialPeak: session.potentialPeak }
          : {}),
      };
      sink(record);
    } catch (error) {
      this.errorCount += 1;
      void error;
    }
  }

  /** 平息结算：交付（`SESSION_FINALIZED`）或判定不足（`SESSION_DISCARDED`）。 */
  private observeFinalize(
    channelId: string,
    before: GroupCadenceState | undefined,
    session: DiscussionSession | null,
  ): void {
    const system = this.system;
    if (system === null) return;
    const state = system.detector.getState(channelId);
    if (!state) return;

    const runtime = this.channel(channelId);
    const gate = this.buildGate(state);
    runtime.gate = gate;
    const at = Math.max(before?.sessionLastMessageTime ?? 0, gate.lastMessageTime);

    if (session !== null) {
      runtime.counters.sessionsFinalized += 1;
      this.emit(
        runtime,
        'SESSION_FINALIZED',
        at,
        `平息结算交付：${session.messages.length} 条发言，峰值 ${session.peakRate.toFixed(2)}/分，` +
          `共 ${before?.burstCount ?? 0} 波`,
        {
          messages: session.messages.length,
          partial: session.partial === true,
          peakRate: session.peakRate,
          durationSeconds: Math.max(0, (session.endTime - session.startTime) / 1000),
          minDiscussionMessages: state.options.minDiscussionMessages,
          startTime: session.startTime,
          endTime: session.endTime,
        },
        gate,
        this.sessionTraces.get(session) ?? null,
      );
    } else {
      const buffered = before?.buffer.length ?? 0;
      runtime.counters.sessionsDiscarded += 1;
      this.emit(
        runtime,
        'SESSION_DISCARDED',
        at,
        `判定不足丢弃：缓冲 ${buffered} 条 < 下限 ${state.options.minDiscussionMessages} 条`,
        {
          messages: buffered,
          minDiscussionMessages: state.options.minDiscussionMessages,
          peakRate: before?.peakRate ?? 0,
          burstCount: before?.burstCount ?? 0,
        },
        gate,
      );
    }

    this.recordSession(
      channelId,
      state,
      at,
      session,
      before?.buffer.length ?? 0,
      before?.peakRate ?? 0,
    );
    this.observePhase(channelId, gate, 'finalize');
  }

  /**
   * 相位变迁上报（去重）：以「已上报相位」为基准，任一织入点观测到迁移都只落一条 trace。
   *
   * 事件链 traceId 的生成规则：从 IDLE / SUMMARIZING 进入 BURSTING 即开启新一轮讨论
   * （新 traceId）；COOLING → BURSTING 的次级突发沿用同一 ID，保证整轮讨论可串联。
   */
  private observePhase(channelId: string, gate: GateStatus, source: string): void {
    const runtime = this.channel(channelId);
    const previous = runtime.phase;
    const next = gate.phase;
    runtime.gate = gate;
    if (previous === next) {
      return;
    }
    runtime.phase = next;

    if (next === 'BURSTING' && (previous === 'IDLE' || previous === 'SUMMARIZING')) {
      // `recordJudgement` 已在同一轮迁移前轮换过则沿用，保证两处写的是同一个 episodeId。
      if (!runtime.episodeFresh) runtime.episodeTraceId = randomUUID();
      runtime.episodeFresh = false;
    }
    const traceId = this.ensureEpisode(runtime);

    runtime.counters.phaseChanges += 1;
    this.emit(
      runtime,
      'PHASE_CHANGE',
      gate.lastMessageTime,
      `${previous} → ${next}（${source}）：速率 ${gate.rate.toFixed(2)}/分，基线 ${gate.baseline.toFixed(2)}/分，` +
        `门限 ${gate.threshold.toFixed(2)}/分，发言人 ${gate.speakers}，熵率 ${gate.entropy.toFixed(2)}`,
      {
        from: previous,
        to: next,
        source,
        rate: gate.rate,
        baseline: gate.baseline,
        threshold: gate.threshold,
        speakers: gate.speakers,
        entropy: gate.entropy,
        burstRatio: gate.burstRatio,
        buffered: gate.buffered,
        ...this.potentialTraceData(gate),
      },
      gate,
      traceId,
    );
  }

  // ---------------------------------------------------------------------------
  // 织入：调度器与宿主 AIMD
  // ---------------------------------------------------------------------------

  private installDispatcherPatches(system: PatchouliKnowledgeSystem): void {
    const dispatcher = system.dispatcher;
    this.restores.push(
      replaceMethod(dispatcher, 'dispatch', (original) => async (...args: unknown[]): Promise<unknown> => {
        const session = args[0];
        if (!isDiscussionSession(session)) {
          return original(...args);
        }

        const runtime = this.channel(session.channelId);
        const traceId = this.sessionTraces.get(session) ?? this.ensureEpisode(runtime);
        const startedAt = this.clock();

        try {
          const result = await original(...args);
          this.recordDispatch(runtime, traceId, session, result, startedAt, null);
          return result;
        } catch (error) {
          this.recordDispatch(runtime, traceId, session, null, startedAt, error);
          throw error;
        }
      }),
    );
  }

  /** `dispatcher.dispatch` 回执 → `DISPATCH_RESULT`（traceId 与会话交付事件连续）。 */
  private recordDispatch(
    runtime: ChannelRuntime,
    traceId: string,
    session: DiscussionSession,
    result: unknown,
    startedAt: number,
    error: unknown,
  ): void {
    const durationMs = Math.max(0, this.clock() - startedAt);
    const gate = runtime.gate;
    try {
      const payload = isRecord(result) ? result : undefined;
      const success = payload?.success === true;
      const qualityScore = isFiniteNumber(payload?.qualityScore) ? payload.qualityScore : 0;
      const discardReason = readDiscardReason(payload?.discardReason);
      // 截断：这两段会进 traces（50 条/群）与 dispatch ledger（跨小时），
      // 上游把一个 10MB 错误体塞进 failureReason 会让它们按字节无界增长。
      const failureReason =
        typeof payload?.failureReason === 'string' && payload.failureReason.length > 0
          ? payload.failureReason.slice(0, 300)
          : null;
      const errorText =
        error === null
          ? null
          : (error instanceof Error ? error.message : String(error)).slice(0, 300);
      const ok = success && error === null;

      runtime.counters.dispatches += 1;
      this.persistDispatch(runtime.channelId, traceId, session, ok, qualityScore, discardReason,
        failureReason ?? errorText, durationMs);
      this.emit(
        runtime,
        'DISPATCH_RESULT',
        gate.lastMessageTime,
        errorText !== null
          ? `调度异常：${errorText}（耗时 ${durationMs}ms）`
          : `调度${ok ? '成功' : discardReason !== null ? `判定丢弃 ${discardReason}` : '未产出词条'}` +
            `（质量分 ${qualityScore.toFixed(2)}，耗时 ${durationMs}ms，${session.messages.length} 条发言）`,
        {
          success: ok,
          qualityScore,
          discardReason,
          failureReason: failureReason ?? errorText,
          durationMs,
          messages: session.messages.length,
          partial: session.partial === true,
          traceId,
        },
        gate,
        traceId,
      );
    } catch {
      this.errorCount += 1;
    }
  }

  /** 调度回执落盘：`session` + `dispatch` 合起来才是「触发→产出」的完整漏斗。 */
  private persistDispatch(
    channelId: string,
    traceId: string,
    session: DiscussionSession,
    success: boolean,
    qualityScore: number,
    discardReason: string | null,
    failureReason: string | null,
    durationMs: number,
  ): void {
    const sink = this.onRecord;
    if (sink === undefined) return;
    try {
      const at = session.endTime;
      const record: ShadowDispatchRecord = {
        kind: 'dispatch',
        at,
        iso: new Date(at).toISOString(),
        channelId,
        sessionId: session.sessionId,
        success,
        qualityScore,
        discardReason,
        // 上游异常文本可能夹带上游响应片段：截到 200 字符并压平换行，台账只留可定位前缀。
        failureReason:
          failureReason === null ? null : failureReason.replace(/\s+/gu, ' ').slice(0, 200),
        durationMs,
        messages: session.messages.length,
        episodeId: traceId,
        triggerMode: this.system?.detector.getOptions(channelId).triggerMode ?? 'rate',
      };
      sink(record);
    } catch {
      this.errorCount += 1;
    }
  }

  /**
   * `applyAimdTuning` 回执 → `AIMD_TUNED`。
   *
   * `clamped` 由**同一个纯函数** `updateParameters` 以完全相同入参重放得出：
   * 调参前后门限取自 `detector.getOptions`，上次校准时刻取自 `getTuningSnapshot().lastUpdated`，
   * 本次校准时刻取调参后的同一字段（即 `applyAimdTuning` 写入 `tuningClocks` 的值），
   * 因此重放结果与主流程逐位一致，不存在「第二套限幅口径」。
   */
  private installSystemPatches(system: PatchouliKnowledgeSystem): void {
    this.restores.push(
      replaceMethod(system, 'applyAimdTuning', (original) => async (...args: unknown[]): Promise<unknown> => {
        const channelId = readChannelId(args[0]);
        if (channelId.length === 0) {
          return original(...args);
        }

        const before = system.detector.getOptions(channelId);
        const lastBefore = system.getTuningSnapshot(channelId).lastUpdated;
        const result = await original(...args);
        try {
          this.recordTuning(system, channelId, before, lastBefore, args[1]);
        } catch {
          this.errorCount += 1;
        }
        return result;
      }),
    );
  }

  private recordTuning(
    system: PatchouliKnowledgeSystem,
    channelId: string,
    before: TriggerOptions,
    lastBefore: number | null,
    rawSignal: unknown,
  ): void {
    const lastAfter = system.getTuningSnapshot(channelId).lastUpdated;
    const after = system.detector.getOptions(channelId);
    // 未真正进入控制器（自动调参关闭 / 提前返回）：不落 trace，避免噪声。
    if (lastAfter === null || lastAfter === lastBefore) {
      return;
    }

    // 与主流程同一条判据（重放必须与 `applyAimdTuning` 逐位一致）：`potential` 调 Θ_min；
    // `shadow` 在 `potentialAutoTuning` 开启时两套同步调（`both`），否则只调 `minBurstRate`。
    // 与主流程同一来源：`before` 是该群生效 options（detector.getOptions），
    // 面板逐群开关 `potentialAutoTuning` 与全局 config 底色都在里面。
    const potentialAutoTuning = before.potentialAutoTuning === true;
    const target: TuningTarget =
      before.triggerMode === 'potential'
        ? 'potential'
        : before.triggerMode === 'shadow' && potentialAutoTuning
          ? 'both'
          : 'rate';
    const replay = updateParameters(
      {
        minBurstRate: before.minBurstRate,
        minDiscussionMessages: before.minDiscussionMessages,
        thetaMin: before.thetaMin,
        lastUpdated: lastBefore ?? undefined,
      },
      readTuningSignal(rawSignal),
      system.config.trigger,
      lastAfter,
      { target },
    );

    const runtime = this.channel(channelId);
    runtime.counters.aimdTunes += 1;
    const stateForConfig = system.detector.getState(channelId);
    if (stateForConfig !== undefined) {
      this.persistConfig(channelId, stateForConfig, runtime.gate.lastMessageTime, 'aimd', {
        thetaMin: before.thetaMin,
        burstMultiplier: before.burstMultiplier,
        rhoMin: before.rhoMin,
        minDiscussionMessages: before.minDiscussionMessages,
      });
    }
    this.emit(
      runtime,
      'AIMD_TUNED',
      runtime.gate.lastMessageTime,
      `AIMD ${replay.action}（${target}）：minBurstRate ${before.minBurstRate} → ${after.minBurstRate}，` +
        `thetaMin ${before.thetaMin} → ${after.thetaMin}，` +
        `minDiscussionMessages ${before.minDiscussionMessages} → ${after.minDiscussionMessages}` +
        `（衰减 ×${replay.decayFactor.toFixed(3)}` +
        (replay.clamped.length > 0 ? `，触及物理边界: ${replay.clamped.join(', ')}` : '') +
        '）',
      {
        action: replay.action,
        target,
        decayFactor: replay.decayFactor,
        clamped: replay.clamped.join(','),
        clampedCount: replay.clamped.length,
        beforeMinBurstRate: before.minBurstRate,
        afterMinBurstRate: after.minBurstRate,
        beforeThetaMin: before.thetaMin,
        afterThetaMin: after.thetaMin,
        beforeMinDiscussionMessages: before.minDiscussionMessages,
        afterMinDiscussionMessages: after.minDiscussionMessages,
        lastUpdated: lastAfter,
      },
      runtime.gate,
    );
  }

  // ---------------------------------------------------------------------------
  // 内部：闸门构造 / trace 写入 / 通道运行时
  // ---------------------------------------------------------------------------

  /** 以「最后一条消息的逻辑时刻」为锚点构造闸门瞬态向量（与触发器判据同口径）。 */
  private buildGate(state: GroupCadenceState): GateStatus {
    const system = this.system;
    const options = state.options;
    const baseline = system === null ? 0 : system.detector.baseline.getRate(state.channelId);
    const anchor = state.lastMessageTime;
    const evaluation = evaluateWindowEntries(state.window, options.windowSizeSeconds, anchor);
    const rate = evaluation.effectiveRate;
    const potential = this.readPotential(state);
    // 判据层必须与状态机一致：potential 用 Q/ρ，rate 与 shadow 一律用速率口径。
    const gated = options.triggerMode === 'potential' ? potential : null;
    const threshold =
      gated === null ? burstThreshold(options, baseline) : potentialBurstThreshold(options, gated.baselineQuality);
    const ready =
      gated === null
        ? rate >= this.nearMissRatio * threshold && evaluation.uniqueSpeakers >= 2
        : gated.quality >= this.nearMissRatio * threshold &&
          gated.density >= (gated.rhoEff ?? options.rhoMin);
    const nearMiss = state.phase === 'IDLE' && threshold > 0 && ready;

    return {
      phase: state.phase,
      rate,
      baseline,
      threshold,
      burstRatio: rate / Math.max(baseline, 0.1),
      speakers: evaluation.uniqueSpeakers,
      entropy: evaluation.entropyRatio,
      nearMiss,
      buffered: state.buffer.length,
      lastMessageTime: anchor,
      ...(potential ?? {}),
      ...(gated === null ? {} : { rhoMin: options.rhoMin, rhoEff: gated.rhoEff ?? options.rhoMin }),
    };
  }

  /**
   * 读取势能层观测向量（纯读，绝不推进状态机）。
   *
   * 不走 `detector.getStatus()`：那条路径会 `settleDue` + `rearm`，读一次遥测就等于提前
   * 结算一轮讨论。这里直接复用它的内部取值函数 `potentialMetricsOf`，与状态机读取的是
   * **同一次计算**，因此 Θ_burst / Θ_cool 不会出现两套口径（STATE Phase 13 约束）。
   * `rate` 模式整体省略，保证既有向量逐位不变。
   */
  private readPotential(state: GroupCadenceState): PotentialVector | null {
    const system = this.system;
    if (system === null || state.options.triggerMode === 'rate') {
      return null;
    }
    try {
      const read = readMethod(system.detector, 'potentialMetricsOf');
      return readPotentialVector(
        read.call(system.detector, state.channelId, state.options, state.lastMessageTime),
      );
    } catch {
      // 触发器内部形状变化不得影响主流程，但也不许静默：计入 errors 供监控发现。
      this.errorCount += 1;
      return null;
    }
  }

  /** 把势能五元组并入 trace `data`（`rate` 模式下返回空对象，绝不写 undefined 键）。 */
  private potentialTraceData(gate: GateStatus): TelemetryData {
    const vector = readPotentialVector(gate);
    return vector === null ? {} : { ...vector };
  }

  /** 读取某群当前闸门（优先实时读取，绝不推进状态机）。 */
  private currentGate(channelId: string): GateStatus {
    const system = this.system;
    if (system === null) {
      return createEmptyGate();
    }
    const state = system.detector.getState(channelId);
    if (!state) {
      return this.channel(channelId).gate;
    }
    const gate = this.buildGate(state);
    this.channel(channelId).gate = gate;
    return gate;
  }

  private ensureEpisode(runtime: ChannelRuntime): string {
    if (runtime.episodeTraceId === null) {
      runtime.episodeTraceId = randomUUID();
    }
    return runtime.episodeTraceId;
  }

  private channel(channelId: string): ChannelRuntime {
    const existing = this.channels.get(channelId);
    if (existing) {
      return existing;
    }
    const runtime: ChannelRuntime = {
      channelId,
      phase: 'IDLE',
      gate: createEmptyGate(),
      episodeTraceId: null,
      nearMissAt: null,
      decisionKey: null,
      digest: null,
      configSeen: false,
      episodeFresh: false,
      momentum: new MomentumTracker(),
      ledger: new BaselineLedger(channelId),
      traces: new RingBuffer<TelemetryTrace>(this.channelTraceCapacity),
      counters: createTelemetryCounters(),
    };
    this.channels.set(channelId, runtime);
    return runtime;
  }

  private emit(
    runtime: ChannelRuntime,
    kind: TelemetryEventKind,
    at: number,
    detail: string,
    data: TelemetryData,
    gate: GateStatus,
    traceId: string | null = null,
  ): TelemetryTrace {
    // 事件描述来自错误文案 / 会话摘要，长度不受控：trace 环（每群 50 条）按条数有界，
    // 单条 detail 若无上限仍能按字节撑爆。`data` 由调用方构造且字段固定，仅靠条数上限约束。
    const safeDetail = detail.length <= 512 ? detail : `${detail.slice(0, 512)}…`;
    const trace: TelemetryTrace = {
      eventId: randomUUID(),
      traceId: traceId ?? runtime.episodeTraceId ?? randomUUID(),
      kind,
      channelId: runtime.channelId,
      at: isFiniteNumber(at) && at > 0 ? at : this.clock(),
      detail: safeDetail,
      gate: { ...gate },
      data,
    };
    runtime.traces.push(trace);
    this.traces.push(trace);
    runtime.counters.traces += 1;
    return trace;
  }
}

function accumulateCounters(target: TelemetryCounters, source: TelemetryCounters): void {
  target.observedMessages += source.observedMessages;
  target.traces += source.traces;
  target.nearMiss += source.nearMiss;
  target.nearMissSuppressed += source.nearMissSuppressed;
  target.phaseChanges += source.phaseChanges;
  target.sessionsFinalized += source.sessionsFinalized;
  target.sessionsDiscarded += source.sessionsDiscarded;
  target.dispatches += source.dispatches;
  target.aimdTunes += source.aimdTunes;
}

function readDiscardReason(value: unknown): DiscardReason | null {
  if (typeof value !== 'string') {
    return null;
  }
  const matched = DISCARD_REASONS.find((reason) => reason === value);
  return matched ?? null;
}

function readTuningSignal(value: unknown): TuningSignal | null {
  if (!isRecord(value)) {
    return null;
  }
  const signal: TuningSignal = {};
  if (value.shouldDiscard === true) {
    signal.shouldDiscard = true;
  }
  const reason = readDiscardReason(value.discardReason);
  if (reason !== null) {
    signal.discardReason = reason;
  }
  if (isFiniteNumber(value.qualityScore)) {
    signal.qualityScore = value.qualityScore;
  }
  return signal;
}

/**
 * 挂载可观测性检查器到系统（`new PatchouliInspector(options).attachTelemetry(system)` 的语法糖）。
 */
export function attachTelemetry(
  system: PatchouliKnowledgeSystem,
  options: InspectorOptions = {},
): PatchouliInspector {
  return new PatchouliInspector(options).attachTelemetry(system);
}
