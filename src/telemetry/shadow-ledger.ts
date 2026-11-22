/**
 * Patchouli Knowledge — 判据持久化（Shadow Ledger）
 *
 * 内存遥测（`inspector.ts` 的环形缓冲）重启即清零，无法回答「三天里两套判据到底谁更准」。
 * 本模块把裁决点与会话结算**追加落盘**，供事后的 shadow 对照：
 *
 *  - `decision`：每次相位裁决点（相位迁移 / 两套判据任一 ready）同时记录频率判据与势能判据
 *    的结论与数值，`agree` 直接标出两者是否一致；
 *  - `session`：每一轮讨论结算的条数、峰值速率、是否投递、销毁原因——这是「沉淀数量」的口径。
 *
 * 硬约束与 `scribe.ts` 同构：
 *
 *  1. **只追加**：一行 JSON，绝不重写既有行；
 *  2. **串行写**：单条 Promise 队列，并发裁决不会互相覆盖；目录懒创建，从未写过不留空目录；
 *  3. **有界**：按逻辑时间的 UTC 日期分片（`shadow-YYYY-MM-DD.jsonl`），单文件超
 *     `SHADOW_FILE_MAX_BYTES` 后按序号续写，启动时清扫超过 `SHADOW_RETENTION_DAYS` 天的分片；
 *  4. **绝不拖垮主流程**：写入 / 清扫失败一律降级为告警回调，异常绝不外溢到消息与结算路径。
 *
 * 时间基准：记录里的 `at` 一律是触发器**逻辑时间**（与遥测同一口径），`iso` 由它派生；
 * 分片名也按逻辑时间的 UTC 日期切分。唯一的例外是 `sweep()` —— 启动时尚无消息、
 * 也就没有逻辑时间可用，保留期清扫以墙钟 cutover（14 天）为准，这是刻意的取舍。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

import type { CadencePhase, TriggerMode } from '../types';

/** 单个分片文件的字节上限：超过后按 `-2`/`-3` 续写，避免长跑实例出现巨型文件。 */
export const SHADOW_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** 保留天数：启动时清扫更早的分片（`--days` 报告窗口的上限即此值）。 */
export const SHADOW_RETENTION_DAYS = 14;

/** 频率判据侧的裁决输入与结论。 */
export interface ShadowRateSide {
  /** 速率判据是否会在此刻开启突发（与会话状态机同一口径）。 */
  ready: boolean;
  /** 滤波后的有效速率（条/分）。 */
  rate: number;
  /** 速率门限（条/分）。 */
  threshold: number;
  /** 动态日常基线（条/分）。 */
  baseline: number;
  /** 窗口内独立发言人数。 */
  speakers: number;
  /** 样本信息熵率（0..1）。 */
  entropy: number;
}

/** 势能判据侧的裁决输入与结论。 */
export interface ShadowPotentialSide {
  /** Q/ρ 双判据是否会在此刻开启突发（与 `potential` 模式的裁决同一口径）。 */
  ready: boolean;
  /** 有效讨论势能 Q = E · S_turn。 */
  quality: number;
  /** 信息密度 ρ = E / N。 */
  density: number;
  /** 信息密度下限 ρ_min。 */
  rhoMin: number;
  /** 归一化交互熵 S_turn。 */
  interaction: number;
  /** Q 的逐群日常基线 b_Q。 */
  baselineQuality: number;
  /** 突发门限 Θ_burst。 */
  burstThreshold: number;
  /** 冷却门限 Θ_cool。 */
  coolThreshold: number;
  /** 本次裁决实际生效的密度下限 ρ_eff（0.8.31+，旧记录缺省）。 */
  rhoEff?: number;
  /** ρ 的逐群学习基线 b_ρ（0.8.31+，旧记录缺省）。 */
  baselineDensity?: number;
}

/** 相位裁决点：两套判据在同一时刻的结论并列落盘。 */
export interface ShadowDecisionRecord {
  kind: 'decision';
  /** 触发器逻辑时间（毫秒）。 */
  at: number;
  /** 由 `at` 派生的 ISO 时间（UTC），便于人读与跨群对齐。 */
  iso: string;
  channelId: string;
  /**
   * 该群当前配置的判据模式：`shadow` 才是对照期，`potential` 为单侧结论。
   * `rate` 模式不落裁决点（`recordJudgement` 提前返回），只落参数快照与会话 / 调度回执。
   */
  triggerMode: TriggerMode;
  /** 裁决时的相位（迁移前）。 */
  phase: CadencePhase;
  rate: ShadowRateSide;
  potential: ShadowPotentialSide;
  /** 两套判据结论是否一致。 */
  agree: boolean;
  /** 本轮讨论缓冲区条数。 */
  buffered: number;
  /** 事件链 ID（与内存 trace 的 `traceId` 同源）：决策 / 会话 / 调度三张表靠它可 join。 */
  episodeId: string | null;
}

/** 一轮讨论的结算结果：沉淀数量的唯一口径。 */
export interface ShadowSessionRecord {
  kind: 'session';
  at: number;
  iso: string;
  channelId: string;
  sessionId: string;
  /** `finalized` = 交付调度器；`discarded` = 条数不足等原因销毁。 */
  verdict: 'finalized' | 'discarded';
  /** 本轮参与结算的消息条数。 */
  messages: number;
  /** 本轮峰值速率（条/分）。 */
  peakRate: number;
  /** 是否真的投递出去（销毁或投递失败为 false）。 */
  delivered: boolean;
  /** 销毁原因（`verdict === 'discarded'` 时为原因码，否则 null）。 */
  reason: string | null;
  /** 事件链 ID（与 decision / dispatch 同源）。 */
  episodeId: string | null;
  /** 本轮生效的判据模式：按引擎分组统计有效率的分组键。 */
  triggerMode: TriggerMode;
  /**
   * 本轮观测到的有效讨论势能峰值（0.8.34+，旧记录缺省）。
   *
   * 调度质量门 `trigger.dispatchMargin` 的离线标定口径：`quality / burstThreshold`
   * 分布直接给出「多少轮只是勉强过阈」；`rate` 模式与 `discarded` 记录无值。
   */
  potentialPeak?: { quality: number; density: number; burstThreshold: number };
}

/** 调度回执：触发之后真正「产出多少」的口径（与 `session` 合起来才是完整漏斗）。 */
export interface ShadowDispatchRecord {
  kind: 'dispatch';
  at: number;
  iso: string;
  channelId: string;
  sessionId: string;
  /** 是否成功产出词条。 */
  success: boolean;
  /** 质量分（0..1）。 */
  qualityScore: number;
  /** 模型侧判定丢弃的原因码（未丢弃为 null）。 */
  discardReason: string | null;
  /** 失败原因（异常文本 / 失败码，成功为 null）。 */
  failureReason: string | null;
  /** 真实耗时（墙钟）。 */
  durationMs: number;
  /** 本轮参与调度器的消息条数。 */
  messages: number;
  /** 事件链 ID（与 decision / session 同源）。 */
  episodeId: string | null;
  /** 本轮生效的判据模式。 */
  triggerMode: TriggerMode;
}

/**
 * 参数快照：判据门限会随 AIMD 漂移，三天后拿现在的数据反推参数会得到错的结论。
 *
 * 每群每进程记一条（`reason:'startup'`，该群第一条被处理的消息触发，**与 `triggerMode`
 * 无关**——`rate` 群同样需要门限快照）；每次 AIMD 调参后再记一条（`reason:'aimd'` 带前后值）。
 */
export interface ShadowConfigRecord {
  kind: 'config';
  at: number;
  iso: string;
  channelId: string;
  reason: 'startup' | 'aimd';
  triggerMode: TriggerMode;
  /** 势能突发门限下限 Θ_min（nat）。 */
  thetaMin: number;
  burstMultiplier: number;
  /** 信息密度下限 ρ_min。 */
  rhoMin: number;
  coolingRatioThreshold: number;
  minDiscussionMessages: number;
  /** AIMD 调参时的改前值（`reason:'startup'` 为 null）。 */
  before: { thetaMin: number; burstMultiplier: number; rhoMin: number; minDiscussionMessages: number } | null;
  /** 时间衰减倍率。 */
  decayFactor: number | null;
}

/**
 * 小时摘要：**标定用的分布**，不是流水。
 *
 * 只记每群每小时的最大 Q / 最大 ρ / 最大速率与各判据 ready 次数——三天后据此判断
 * `Θ_min`（当前 20）与 `ρ_min`（当前 1.2）是否定高了/定低了，而无需保存每条消息。
 */
export interface ShadowDigestRecord {
  kind: 'digest';
  at: number;
  iso: string;
  channelId: string;
  /** 小时键（UTC `YYYY-MM-DDTHH`）。 */
  hour: string;
  /** 该小时内被观测的消息数。 */
  messages: number;
  /** 该小时内最大值。 */
  maxQuality: number;
  maxDensity: number;
  maxRate: number;
  maxInteraction: number;
  /** 判据 ready 的消息条数（不是「决策点」数）。 */
  rateReadyMessages: number;
  potentialReadyMessages: number;
  /** 该小时内两套判据结论不一致的消息条数。 */
  disagreed: number;
  /**
   * 满足 NEAR_MISS **原始判定**的消息条数（未经频控；判据侧随 `triggerMode`）。
   *
   * 不是上报侧口径：`NEAR_MISS` trace 受 `nearMissCooldownMs` 频控，两者数字不必相等。
   */
  nearMiss: number;
}

export type ShadowRecord =
  | ShadowDecisionRecord
  | ShadowSessionRecord
  | ShadowDispatchRecord
  | ShadowConfigRecord
  | ShadowDigestRecord;

/** 账本日志面（结构兼容 Koishi Logger 与插件内部的 `PluginLogger`）。 */
export interface ShadowLedgerLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface ShadowLedgerOptions {
  /** `.patchouli/observability/` 绝对路径。 */
  dir: string;
  logger?: ShadowLedgerLogger;
  /** 可注入时钟（毫秒），缺省 `Date.now`；仅用于分片日期的兜底。 */
  now?: () => number;
}

/** 记录写入的位置：分片文件绝对路径。 */
export interface ShadowAppendTarget {
  file: string;
  bytes: number;
}

/**
 * 追加式判据账本。
 *
 * 单个实例、单个串行队列；`append` 立即返回，不阻塞调用方（裁决 / 结算路径）。
 */
export class ShadowLedger {
  private readonly dir: string;
  private readonly logger: ShadowLedgerLogger | undefined;
  private readonly now: () => number;
  /** 串行写队列：每条记录一节，失败只告警不中断后续。 */
  private queue: Promise<void> = Promise.resolve();
  /** 每个分片文件的当前字节数（按需惰性探测，避免每次写都 stat）。 */
  private readonly sizes = new Map<string, number>();
  private dirReady = false;
  private closed = false;
  private written = 0;
  private failed = 0;
  private lastWriteAt: number | null = null;

  constructor(options: ShadowLedgerOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** 追加一条记录；永不抛出、永不阻塞。 */
  append(record: ShadowRecord): void {
    if (this.closed) return;
    this.queue = this.queue.then(() => this.write(record)).catch(() => undefined);
  }

  /** 清扫超过保留期的分片（启动时调用一次）。 */
  async sweep(at: number = this.now()): Promise<string[]> {
    const cutoff = dayKey(at - SHADOW_RETENTION_DAYS * 86_400_000);
    try {
      const names = await fs.readdir(this.dir);
      const removed: string[] = [];
      for (const name of names) {
        const match = /^shadow-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/u.exec(name);
        if (match === null) continue;
        if (match[1] >= cutoff) continue;
        const target = nodePath.join(this.dir, name);
        await fs.rm(target, { force: true });
        // sizes 与文件一一对应：删文件不删尺寸表，累计字节会永久虚高。
        this.sizes.delete(target);
        removed.push(name);
      }
      if (removed.length > 0) {
        this.logger?.info(`判据账本清扫 ${removed.length} 个过期分片（保留 ${SHADOW_RETENTION_DAYS} 天）`);
      }
      return removed;
    } catch (error) {
      if (!isMissing(error)) this.logger?.warn(`判据账本清扫失败：${describe(error)}`);
      return [];
    }
  }

  /** 写入统计：`failed > 0` 或 `lastWriteAt` 陈旧 = 台账链路出问题。 */
  stats(): { written: number; failed: number; lastWriteAt: number | null } {
    return { written: this.written, failed: this.failed, lastWriteAt: this.lastWriteAt };
  }

  /** 等待队列落盘（测试与优雅关闭用）。 */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * 停止接收**新**记录，并返回队列排空的 Promise。
   *
   * 关键：`closed` 只在 `append()` 入口拦截。已入队的记录必须照常落盘——
   * 卸载瞬间队列里通常还有 digest 残片与会话/调度回执，`write()` 里再查一次
   * `closed` 会把它们静默吞掉（且不计入 failed）。
   */
  close(): Promise<void> {
    this.closed = true;
    return this.flush();
  }

  private async write(record: ShadowRecord): Promise<void> {
    // 不在这里检查 `closed`：能进入队列就代表调用方已经通过了 `append()` 的门禁，
    // 丢弃它等于「关闭时静默丢数据」。
    const line = `${JSON.stringify(record)}\n`;
    try {
      await this.appendOnce(record.at, line);
    } catch (error) {
      if (!isMissing(error)) {
        this.failed += 1;
        this.logger?.warn(`判据账本写入失败：${describe(error)}`);
        return;
      }
      // 目录被外部删除：重建成因缓存过期，重建后重试一次；仍失败则放弃（可观测性不阻塞主流程）。
      this.dirReady = false;
      this.sizes.clear();
      try {
        await this.appendOnce(record.at, line);
      } catch (retryError) {
        this.failed += 1;
        this.logger?.warn(`判据账本重建后仍写入失败：${describe(retryError)}`);
      }
    }
  }

  private async appendOnce(at: number, line: string): Promise<void> {
    if (!this.dirReady) {
      await fs.mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    const target = await this.pickFile(at);
    const bytes = Buffer.byteLength(line, 'utf8');
    await fs.appendFile(target, line, 'utf8');
    this.sizes.set(target, (this.sizes.get(target) ?? 0) + bytes);
    this.written += 1;
    this.lastWriteAt = this.now();
  }

  /**
   * 选定本次写入的分片：按逻辑时间的 UTC 日期命名；同一天超过字节上限时顺延序号。
   * 首次使用时探测既有文件大小，保证进程重启后接着写而不是覆盖。
   */
  private async pickFile(at: number): Promise<string> {
    const day = dayKey(at);
    const base = nodePath.join(this.dir, `shadow-${day}.jsonl`);
    let index = 1;
    let candidate = base;
    for (;;) {
      const known = this.sizes.get(candidate);
      const size = known ?? (await fileSize(candidate));
      if (size < SHADOW_FILE_MAX_BYTES) {
        this.sizes.set(candidate, size);
        return candidate;
      }
      index += 1;
      candidate = nodePath.join(this.dir, `shadow-${day}-${index}.jsonl`);
    }
  }
}

/** 逻辑时间 → UTC 日期键（`YYYY-MM-DD`）。 */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
