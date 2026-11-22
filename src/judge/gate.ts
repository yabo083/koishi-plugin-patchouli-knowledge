/**
 * Patchouli Knowledge — 本地 System-1 裁判的两个装配点（roadmap §4.4 / §7.3）
 *
 * 一、`PreDispatchGate`：平息结算前的门控。
 *     在调用云端大模型之前，用同一段纯文本 tail 问一次「这段讨论值不值得沉淀」；
 *     判为低密度时直接走 `recordDiscard(MODEL / LOW_DENSITY)` + AIMD 步进，
 *     省下整轮云端调度。裁判不可用（未启用 / 超时 / 非 2xx / 响应不可解析）
 *     一律 fail-open：**服务故障绝不能被翻译成丢弃**。
 *
 * 二、`BoundaryAnnotator`：L0 词汇凝聚候选 → L2 边界裁决。
 *     `observe()` 在消息热路径上被 `void` 掉：内部同步跑微秒级 L0，
 *     只有出现候选且该群不在冷却期时才异步调裁判；同一群最多一个在途请求。
 *     候选下标是**相对 tail 的位置**，裁决命中后映射回该条消息的绝对时间戳，
 *     交给 `detector.noteBoundary(channelId, at, confidence)` 做回溯切片。
 *
 * 两条路径共用同一条降级守则：任何异常都只落在本模块内部，
 * 绝不向 `onMessage` / `onIncomingMessage` 冒泡，也绝不阻塞消息主循环。
 */

import type { ChatMessage, DiscussionSession } from '../types';
import { LexicalBoundaryDetector } from '../trigger/boundary';
import { stripMessageMarkup } from '../trigger/filter';
import type { GateDecision, JudgeClient } from './client';

/* ------------------------------------------------------------------ *
 * 一、常量
 * ------------------------------------------------------------------ */

/** 门控阈值 τ：P(true) ≥ τ 放行云端大模型（roadmap §4.4）。 */
export const DEFAULT_GATE_THRESHOLD = 0.5;

/** 送进门控的 tail 条数（roadmap §4.4 的 20~30 条区间）。 */
export const GATE_TAIL_SIZE = 30;

/** 门控判为低密度时写入 `DiscardVerdict.discardReason` 的归因。 */
export const LOW_DENSITY_REASON = 'LOW_DENSITY';

/** 同群两次真实边界裁决之间的最小间隔：10 分钟。 */
export const DEFAULT_BOUNDARY_COOLDOWN_MS = 10 * 60_000;

/** 边界裁决用的 tail 条数。 */
export const DEFAULT_BOUNDARY_TAIL_SIZE = 30;

/** 裁判未给出该候选概率时的置信度兜底（roadmap §4.4）。 */
export const DEFAULT_BOUNDARY_CONFIDENCE = 0.6;

/* ------------------------------------------------------------------ *
 * 二、门控
 * ------------------------------------------------------------------ */

/** 门控判决：`available === false` 时调用方必须按「放行」处理。 */
export interface GateVerdict {
  /** 最终是否放行云端大模型；`available === false` 时恒为 true。 */
  valuable: boolean;
  /** 裁判给出的 P(true)；不可用时无意义。 */
  probability: number;
  /** false = 未启用 / 超时 / 非 2xx / 响应不可解析 / 调用异常。 */
  available: boolean;
  /** 低密度的归因（`LOW_DENSITY`）或裁判不可用的原因。 */
  reason?: string;
}

/** 门控参数；`threshold` 缺省 0.5，越界取值按默认值处理。 */
export interface PreDispatchGateOptions {
  threshold?: number;
}

function resolveThreshold(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_GATE_THRESHOLD;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string' && error.length > 0) return error;
  return '未知错误';
}

/** 发言人称谓：昵称优先，回落到 userId，最后给一个可读占位。 */
function speakerOf(message: Pick<ChatMessage, 'userName' | 'userId'>): string {
  const name = typeof message.userName === 'string' ? message.userName.trim() : '';
  if (name.length > 0) return name;
  const id = typeof message.userId === 'string' ? message.userId.trim() : '';
  return id.length > 0 ? id : '未知发言者';
}

/** 单行渲染：`昵称: 文本`，文本统一剥离 CQ 码 / Satori 标签（纯文本输入）。 */
function renderLine(speaker: string, text: string): string {
  return `${speaker}: ${stripMessageMarkup(text)}`;
}

/**
 * 取消息序列的**尾部** `limit` 条，按原顺序渲染为多行纯文本。
 * `render` 的第二个实参是**相对下标**（0 起，相对本次输出的第一行），供需要编号的调用方使用。
 * `limit` 非有限数或 ≤ 0 时退回整段（调用方不会传这种值，防御性收敛）。
 */
function renderTail<T>(
  messages: readonly T[],
  limit: number,
  render: (message: T, index: number) => string,
): string {
  const lines: string[] = [];
  const bounded = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : messages.length;
  const start = Math.max(0, messages.length - bounded);
  for (let i = start; i < messages.length; i += 1) {
    lines.push(render(messages[i], i - start));
  }
  return lines.join('\n');
}

/**
 * 平息结算前的门控。
 *
 * 只做一次裁判调用，**永不抛错**：任何异常都退化 `{ valuable: true, available: false }`。
 */
export class PreDispatchGate {
  private readonly threshold: number;

  constructor(
    private readonly client: JudgeClient,
    options: PreDispatchGateOptions = {},
  ) {
    this.threshold = resolveThreshold(options.threshold);
  }

  async evaluate(session: DiscussionSession): Promise<GateVerdict> {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const state = renderTail(messages, GATE_TAIL_SIZE, (message) =>
      renderLine(speakerOf(message), message.content),
    );

    let decision: GateDecision;
    try {
      decision = await this.client.gate(state);
    } catch (error: unknown) {
      return {
        valuable: true,
        probability: 1,
        available: false,
        reason: `judge 调用异常：${describeError(error)}`,
      };
    }

    const probability =
      typeof decision.probability === 'number' && Number.isFinite(decision.probability)
        ? decision.probability
        : 1;

    if (decision.available === false) {
      return { valuable: true, probability, available: false, reason: decision.reason };
    }
    if (probability >= this.threshold) {
      return { valuable: true, probability, available: true };
    }
    return { valuable: false, probability, available: true, reason: LOW_DENSITY_REASON };
  }
}

/* ------------------------------------------------------------------ *
 * 三、L0 候选 → L2 边界裁决
 * ------------------------------------------------------------------ */

/** 边界标注器的最小依赖面：候选落定后的回灌端。 */
export interface BoundaryAnnotatorDeps {
  noteBoundary: (channelId: string, at: number, confidence: number) => void;
}

/** 一次观测输入（由 `onIncomingMessage` 逐条投递，绝不 await）。 */
export interface BoundaryObservationInput {
  channelId: string;
  id: string;
  userId: string;
  /** 展示昵称；缺省回落到 `userId`（tail 渲染用）。 */
  userName?: string;
  /** 原始消息文本（可含 CQ 码 / 标签，渲染时统一剥离）。 */
  text: string;
  /** 消息时间戳（毫秒）；既作 tail 排序依据，也作冷却期的逻辑时钟。 */
  at: number;
}

/** 边界标注器参数。 */
export interface BoundaryAnnotatorOptions {
  /** 同群两次真实裁决的最小间隔（毫秒），缺省 10 分钟。 */
  cooldownMs?: number;
  /** 送进裁判的 tail 条数，缺省 30。 */
  tailSize?: number;
  /** 候选落定后的回灌端；缺省时不回灌（纯观测装配）。 */
  noteBoundary?: BoundaryAnnotatorDeps['noteBoundary'];
  /** 丢弃计数 / 降级信息的落点；缺省时静默。 */
  logger?: { info: (message: string) => void };
}

/** 单条 tail 观测：渲染用昵称 + 绝对时间戳。 */
interface TailEntry {
  at: number;
  speaker: string;
  text: string;
}

/** 单群标注状态：L0 检测器 + 有界 tail + 冷却与在途标记。 */
interface ChannelBoundaryState {
  detector: LexicalBoundaryDetector;
  tail: TailEntry[];
  /** 上一次真实裁决的发送时刻（逻辑时间 = 该条消息的 `at`）。 */
  lastDecisionAt: number | null;
  /** 是否有裁决请求在途（同群最多一个）。 */
  inFlight: boolean;
  /** 因冷却 / 在途被丢弃的候选数（只增不减，供日志与排障）。 */
  droppedCandidates: number;
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 候选 `at` → tail 内的相对下标。
 * 从尾部向前找：同一毫秒出现多条消息时优先命中最近的一条。
 */
function indexOfAt(tail: readonly TailEntry[], at: number): number {
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (tail[i].at === at) return i;
  }
  return -1;
}

/**
 * L0 词汇凝聚候选 → L2 边界裁决 → `noteBoundary` 回灌。
 *
 * `observe()` 永远 resolve（内部全量 try/catch），因此调用方可以安全 `void` 掉；
 * 热路径上只做纯内存的 L0 push，不产生任何网络 / 磁盘 I/O。
 */
export class BoundaryAnnotator {
  private readonly cooldownMs: number;
  private readonly tailSize: number;
  private readonly noteBoundary?: BoundaryAnnotatorDeps['noteBoundary'];
  private readonly logger?: { info: (message: string) => void };
  private readonly states = new Map<string, ChannelBoundaryState>();

  constructor(
    private readonly client: JudgeClient,
    options: BoundaryAnnotatorOptions = {},
  ) {
    this.cooldownMs = resolvePositiveInteger(options.cooldownMs, DEFAULT_BOUNDARY_COOLDOWN_MS);
    this.tailSize = resolvePositiveInteger(options.tailSize, DEFAULT_BOUNDARY_TAIL_SIZE);
    this.noteBoundary = options.noteBoundary;
    this.logger = options.logger;
  }

  /** 每条消息调用一次。永不抛错、永不 reject。 */
  async observe(input: BoundaryObservationInput): Promise<void> {
    try {
      await this.observeInternal(input);
    } catch {
      // 标注是纯增益路径：任何失败都不得影响消息主循环。
    }
  }

  /** 清空全部群状态（`dispose()` / 测试复用）。 */
  reset(): void {
    this.states.clear();
  }

  private stateFor(channelId: string): ChannelBoundaryState {
    const existing = this.states.get(channelId);
    if (existing !== undefined) return existing;
    const created: ChannelBoundaryState = {
      detector: new LexicalBoundaryDetector(),
      tail: [],
      lastDecisionAt: null,
      inFlight: false,
      droppedCandidates: 0,
    };
    this.states.set(channelId, created);
    return created;
  }

  private async observeInternal(input: BoundaryObservationInput): Promise<void> {
    const state = this.stateFor(input.channelId);

    state.tail.push({
      at: input.at,
      speaker: input.userName !== undefined && input.userName.trim().length > 0 ? input.userName : input.userId,
      text: input.text,
    });
    if (state.tail.length > this.tailSize) {
      state.tail.splice(0, state.tail.length - this.tailSize);
    }

    const candidate = state.detector.push({ id: input.id, text: input.text, at: input.at });
    if (candidate === null) return;

    if (state.inFlight) {
      state.droppedCandidates += 1;
      this.logger?.info(
        `[Patchouli] 群 ${input.channelId} 边界候选丢弃：上一轮裁决仍在途（累计 ${state.droppedCandidates}）`,
      );
      return;
    }
    if (state.lastDecisionAt !== null && input.at - state.lastDecisionAt < this.cooldownMs) {
      state.droppedCandidates += 1;
      this.logger?.info(
        `[Patchouli] 群 ${input.channelId} 边界候选丢弃：冷却期内` +
          `（距上次裁决 ${Math.max(0, input.at - state.lastDecisionAt)} ms < ${this.cooldownMs} ms，累计 ${state.droppedCandidates}）`,
      );
      return;
    }

    // 快照 tail：判决返回前可能继续有新消息进来（tail 会滚动），下标必须对快照解释。
    const snapshot = state.tail.slice();
    const relative = indexOfAt(snapshot, candidate.at);
    if (relative < 0) {
      // 候选点早于当前 tail 窗口：无法映射回绝对时间戳，直接放弃（不冒任何风险）。
      return;
    }
    // 裁判看到的必须是带编号的行（1 起）：编号即 `choice` 的取值，也就是候选消息本身。
    const stateText = renderTail(
      snapshot,
      this.tailSize,
      (entry, index) => `${index + 1}. ${renderLine(entry.speaker, entry.text)}`,
    );
    // 候选编号 1 起 = 相对下标 + 1；裁决语义是「该编号消息即新话题首条」。
    const candidateNumber = relative + 1;

    state.inFlight = true;
    state.lastDecisionAt = input.at;
    try {
      const decision = await this.client.boundary(stateText, [candidateNumber]);
      if (decision.available !== true || decision.index === null) return;
      const chosen = snapshot[decision.index - 1];
      if (chosen === undefined) return;

      const rawConfidence = decision.probabilities[String(decision.index)];
      const confidence =
        typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
          ? rawConfidence
          : DEFAULT_BOUNDARY_CONFIDENCE;
      this.noteBoundary?.(input.channelId, chosen.at, confidence);
    } finally {
      state.inFlight = false;
    }
  }
}
