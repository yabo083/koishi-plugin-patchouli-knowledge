/**
 * Patchouli Knowledge —— 每日「主题校准」调度器
 *
 * 职责边界：
 *   - 只决定「什么时候让某个群跑一次主题校准」，归并与落盘全部由 `TopicCurator` 负责；
 *   - 日切水位持久化到 `<wikiDir>/.patchouli/topics-state.json`，进程重启后不会当天重跑；
 *   - 失败（`model-failed` / 抛错）按 `retryDelayMs` 有界重试，成功或「无料」当天即封盘；
 *   - 定时器用「睡到下一个事件」而不是固定轮询。
 *
 * 不变量：调度器绝不直接调用模型、绝不写词条；它只读回 `TopicRunResult` 并记水位。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import type { TopicConfig } from '../types';
import type { TopicRunResult } from '../wiki/topics';

const DAY_MS = 86_400_000;
const DEFAULT_RETRY_DELAY_MS = 30 * 60_000;
/** 定时器最短睡眠：避免配置错误导致忙等。 */
const MIN_SLEEP_MS = 1_000;

/** 可注入的定时器句柄（Node 定时器 / 测试替身）。 */
export type TopicTimerHandle = NodeJS.Timeout | number;

/** 单群当日主题校准水位。 */
interface TopicChannelState {
  /** 该记录归属的本地日期（YYYY-MM-DD）。 */
  dayKey: string;
  /** `success` = 成功或已存在；`skipped` = 无料/关闭；`failed` = 可重试失败。 */
  status: 'success' | 'skipped' | 'failed';
  /** 最近一次尝试时刻（毫秒）。 */
  at: number;
  /** 当日累计尝试次数。 */
  attempts: number;
}

export interface TopicSchedulerDeps {
  /** 待整理的群；返回空数组时视为「暂无目标」，不会扫描全库。 */
  channels: () => readonly string[] | Promise<readonly string[]>;
  /** 真正执行一次主题校准（接 `PatchouliKnowledgeSystem.runTopicsDirect`，避免递归回调度器）。 */
  run: (channelId: string, options: { force?: boolean }) => Promise<TopicRunResult>;
  /** 水位文件绝对路径（`<wikiDir>/.patchouli/topics-state.json`）。 */
  statePath: string;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
  now?: () => number;
  /** 失败后的重试间隔（默认 30 分钟）。 */
  retryDelayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TopicTimerHandle;
  clearTimer?: (handle: TopicTimerHandle) => void;
}

interface TopicStateDocument {
  version: 1;
  channels: Record<string, TopicChannelState>;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 本地时区日期键（YYYY-MM-DD）。 */
export function localDayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 当天 `hour:minute` 的时刻；已过则顺延到明天。 */
export function nextScheduledAt(at: number, config: Pick<TopicConfig, 'hour' | 'minute'>): number {
  const date = new Date(at);
  date.setHours(config.hour, config.minute, 0, 0);
  if (date.getTime() <= at) date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** 当天 `hour:minute` 的时刻（可能早于 `at`）。 */
function todayScheduledAt(at: number, config: Pick<TopicConfig, 'hour' | 'minute'>): number {
  const date = new Date(at);
  date.setHours(config.hour, config.minute, 0, 0);
  return date.getTime();
}

function isStateDocument(value: unknown): value is TopicStateDocument {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.channels === 'object' && record.channels !== null;
}

function isChannelState(value: unknown): value is TopicChannelState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.dayKey === 'string' &&
    typeof record.at === 'number' &&
    typeof record.attempts === 'number' &&
    (record.status === 'success' || record.status === 'skipped' || record.status === 'failed')
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 每日主题校准调度器。
 *
 * `start()` 先读水位再排下一个事件；`runNow(force)` / `runChannelNow(id, force)` 立刻跑一轮
 * （管理入口使用），同样写日切水位，避免手动跑完当天又白跑一次定时。
 */
export class TopicScheduler {
  private readonly deps: TopicSchedulerDeps;
  private readonly config: TopicConfig;
  private readonly clock: () => number;
  private readonly retryDelayMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TopicTimerHandle;
  private readonly clearTimer: (handle: TopicTimerHandle) => void;
  private state: TopicStateDocument = { version: 1, channels: {} };
  private timer: TopicTimerHandle | undefined;
  private disposed = false;
  private ticking = false;
  /**
   * 单群执行锁：`runNow` / 管理入口与定时 `tick` 可能同时触发同一个群，
   * 并入同一次执行（共用结果），避免同群双跑、重复扣模型调用。
   */
  private readonly inflight = new Map<string, Promise<TopicRunResult>>();
  /** 水位临时文件序号：并发写各自的 temp，绝不共用同一个文件。 */
  private persistSeq = 0;
  /** 水位写盘串行队列：并发 persist 依次落盘，最后一次 rename 一定是完整文档。 */
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(config: TopicConfig, deps: TopicSchedulerDeps) {
    if (!deps || typeof deps.statePath !== 'string' || deps.statePath.trim() === '') {
      throw new TypeError('TopicScheduler: deps.statePath 必填');
    }
    this.config = config;
    this.deps = deps;
    this.clock = deps.now ?? Date.now;
    this.retryDelayMs = Math.max(0, deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.setTimer =
      deps.setTimer ??
      ((callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref();
        return handle;
      });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /** 读取水位并排下一个事件；重复调用幂等。 */
  async start(): Promise<void> {
    if (this.disposed) return;
    await this.load();
    // 启动即补跑：进程在 04:00 之前被杀掉时，重启后当天仍会补上一次。
    await this.tick(true);
  }

  /** 立刻为所有目标群跑一轮（`force` 透传给聚合器）。 */
  async runNow(force = true): Promise<TopicRunResult[]> {
    const channels = await this.resolveChannels();
    const results: TopicRunResult[] = [];
    for (const channelId of channels) {
      results.push(await this.runChannel(channelId, force));
    }
    return results;
  }

  /**
   * 立刻为单个群跑一轮（管理入口的「手动触发」）。
   *
   * 与定时 `tick` 共用单群锁，并像定时一样写日切水位——手动跑完当天 04:00 不会再跑一次。
   */
  async runChannelNow(channelId: string, force = true): Promise<TopicRunResult> {
    return this.runChannel(channelId, force);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 配置热更新后按新值重排下一次事件。
   *
   * `config` 是本类持有的实时引用：面板改 `hour` / `minute` 后已排的 `setTimeout` 仍是旧
   * 时刻，`enabled=false` 时 `schedule()` 只清不设——不重排就会出现「改了时间不生效」
   * 与「关掉再打开后永远不再触发」。这里只重建定时器，不立即补跑（补跑仍由 `tick` 的
   * 到点 / 重启逻辑负责）。
   */
  reschedule(): void {
    if (this.disposed) return;
    this.schedule();
  }

  /** 当前水位快照（只读副本，供状态接口 / 测试）。 */
  snapshot(): Record<string, TopicChannelState> {
    const copy: Record<string, TopicChannelState> = {};
    for (const [channelId, state] of Object.entries(this.state.channels)) {
      copy[channelId] = { ...state };
    }
    return copy;
  }

  private async resolveChannels(): Promise<string[]> {
    try {
      const channels = await this.deps.channels();
      return channels.filter((channelId) => typeof channelId === 'string' && channelId.trim() !== '');
    } catch (error: unknown) {
      this.deps.logger?.warn(`[Patchouli] 主题校准目标群解析失败: ${describeError(error)}`);
      return [];
    }
  }

  private async tick(scheduleNext: boolean): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock();
      for (const channelId of await this.resolveChannels()) {
        if (!this.eligible(channelId, now)) continue;
        await this.runChannel(channelId, false);
      }
    } finally {
      this.ticking = false;
      if (scheduleNext && !this.disposed) this.schedule();
    }
  }

  /** 是否应在本轮尝试该群：每日到点后，成功/跳过当天封盘，失败按重试间隔。 */
  private eligible(channelId: string, now: number): boolean {
    if (this.config.enabled !== true) return false;
    if (now < todayScheduledAt(now, this.config)) return false;
    const dayKey = localDayKey(now);
    const state = this.state.channels[channelId];
    if (state === undefined || state.dayKey !== dayKey) return true;
    if (state.status === 'success' || state.status === 'skipped') return false;
    return now - state.at >= this.retryDelayMs;
  }

  /**
   * 单群执行入口：同一群的并发调用并入同一次执行（共享结果）。
   *
   * 锁在 `runChannel` 层而不在 `tick`：`runNow` 与定时 `tick` 走的都是这里，
   * 因此「手动 + 定时」撞车时也只真正跑一次。
   */
  private runChannel(channelId: string, force: boolean): Promise<TopicRunResult> {
    const existing = this.inflight.get(channelId);
    if (existing !== undefined) return existing;
    const task = this.executeChannel(channelId, force).finally(() => {
      this.inflight.delete(channelId);
    });
    this.inflight.set(channelId, task);
    return task;
  }

  private async executeChannel(channelId: string, force: boolean): Promise<TopicRunResult> {
    const now = this.clock();
    const dayKey = localDayKey(now);
    const previous = this.state.channels[channelId];
    const attempts = previous?.dayKey === dayKey ? previous.attempts + 1 : 1;
    try {
      const result = await this.deps.run(channelId, { force });
      const status =
        result.skippedReason === 'model-failed'
          ? 'failed'
          : result.skippedReason === 'no-entries' || result.skippedReason === 'disabled'
            ? 'skipped'
            : 'success';
      this.state.channels[channelId] = { dayKey, status, at: this.clock(), attempts };
      this.deps.logger?.info(
        `[Patchouli] 主题 ${channelId}: ${result.skippedReason ?? 'ok'}` +
          `（创建 ${result.createdTopicIds.length} / 更新 ${result.updatedTopicIds.length} 主题，` +
          `归入 ${result.assignedEntryIds.length} 条）` +
          (result.detail ? ` | ${result.detail}` : ''),
      );
      await this.persist();
      return result;
    } catch (error: unknown) {
      const detail = describeError(error);
      this.state.channels[channelId] = { dayKey, status: 'failed', at: this.clock(), attempts };
      this.deps.logger?.warn(`[Patchouli] 主题校准 ${channelId} 执行异常（第 ${attempts} 次）: ${detail}`);
      await this.persist();
      return {
        channelId,
        dayKey,
        createdTopicIds: [],
        updatedTopicIds: [],
        assignedEntryIds: [],
        skippedReason: 'model-failed',
        detail,
      };
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.config.enabled !== true) return;
    const now = this.clock();
    let delay = nextScheduledAt(now, this.config) - now;
    for (const state of Object.values(this.state.channels)) {
      if (state.status !== 'failed') continue;
      const retryAt = state.at + this.retryDelayMs;
      if (retryAt > now) delay = Math.min(delay, retryAt - now);
    }
    this.timer = this.setTimer(
      () => {
        void this.tick(true);
      },
      Math.max(MIN_SLEEP_MS, delay),
    );
  }

  private async load(): Promise<void> {
    try {
      const text = await fs.readFile(this.deps.statePath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (!isStateDocument(parsed)) {
        this.deps.logger?.warn('[Patchouli] 主题校准水位文件结构不合法，按空状态启动');
        return;
      }
      for (const [channelId, state] of Object.entries(parsed.channels)) {
        if (isChannelState(state)) this.state.channels[channelId] = state;
      }
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') {
        this.deps.logger?.warn(`[Patchouli] 读取主题校准水位失败: ${describeError(error)}`);
      }
    }
  }

  private persist(): Promise<void> {
    const task = this.persistQueue.then(() => this.writeState());
    // 队列自身永不 reject，单次写失败不影响后续 persist。
    this.persistQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async writeState(): Promise<void> {
    const target = this.deps.statePath;
    this.persistSeq += 1;
    const temp = `${target}.tmp-${process.pid}-${this.persistSeq}`;
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    try {
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.writeFile(temp, body, 'utf8');
      await fs.rename(temp, target);
    } catch (error: unknown) {
      this.deps.logger?.warn(`[Patchouli] 写入主题校准水位失败: ${describeError(error)}`);
      await fs.rm(temp, { force: true }).catch((): undefined => undefined);
    }
  }
}
