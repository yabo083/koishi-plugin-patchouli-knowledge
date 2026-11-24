/**
 * 定时投递闸门：入队、限额、cron 到点、批量结算。
 *
 * 设计要点（`docs/delivery-schedule.md` §3/§4）：
 *   - **排队不丢弃**：策略带 cron 的事件进队列等下一次触发，绝不让「讨论结束的时刻」决定词条可见性；
 *   - **限额按（来源群 × 目标）**：同一事件投三个目标 = 三条独立额度，各自扣一次；
 *   - **先判额再渲染**：到点条目先过额度闸门，超额直接出队告警、不白渲染一张图；
 *   - **批量外发**：额度内的条目渲染后**一次** `broadcast`，按 `outcomes` 逐（产物 × 目标）结算，
 *     成功出队、失败留队退避、不整批回滚；
 *   - **单定时器**：只有一条 wake 定时器指向队列里最早的 `dueAt`，没有任何轮询。
 *
 * 内存边界：队列本身在 `delivery-state.json`（≤1024 条 / ≤1 MiB），本类只额外暂存
 * **已渲染产物**（≤32 MiB，超出即不再暂存、到点重渲），进程重启后条目靠 `render` 重渲。
 * 渲染不出来的条目按 3 次上限出队并告警，绝不阻塞同批其他条目。
 */

import { h } from 'koishi';

import type { TargetPolicies, TargetPolicy } from '../types';
import {
  getDeliveryService,
  type DeliveryBatchOutcome,
  type DeliveryOutcomeLike,
  type DeliveryRetryOptions,
  type DeliveryTargetLike,
} from './delivery';
import {
  MAX_STATE_BYTES,
  MAX_QUEUE_ITEMS,
  DeliveryStateStore,
  counterKey,
  type DeliveryKind,
  type DeliveryStateDoc,
  type QueuedDelivery,
} from './delivery-state';
import { DEFAULT_POLICY, cronForKind, nextCronAt, parseCron, periodKeyFor, policyKey } from './policy-resolve';
import { bareChannelId } from './subscriptions';

/** 单批条目上限（事件数）。 */
export const MAX_BATCH_ITEMS = 20;

/** 单批字节上限（产物字节和）：超过就提前切批。 */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;

/** 已渲染产物的内存上限：超出后不再暂存，条目到点改用 `render` 重渲。 */
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** 渲染 / 投递的最大尝试次数（含首次）。 */
export const MAX_RENDER_ATTEMPTS = 3;
export const MAX_DELIVERY_ATTEMPTS = 10;

/** 投递失败后的首次退避（指数增长，封顶 30 分钟）。 */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

/**
 * 同目标相邻两条的最小 / 最大随机间隔（内部常量，不对外配置）。
 *
 * 平台风控看的是「同一收件人短时间连续收到同形态消息」，间隔只需打散成不规律即可；
 * 条目因此按 `dueAt` 逐个到点，而不是同一毫秒挤进一批。
 */
const TARGET_GAP_MIN_MS = 60_000;
const TARGET_GAP_MAX_MS = 180_000;

/** 没有暂存产物时，一条条目在批字节预算里按这个值估算。 */
const ESTIMATED_ITEM_BYTES = 4096;

/** 词条 / 周报的投递 scope（透传给 `miyako-delivery`，与旧实现一致）。 */
const SCOPE_ENTRY = 'patchouli:entry';
const SCOPE_WEEKLY = 'patchouli:weekly-album';

/** 单次 `setTimer` 的延迟上界：超过它的延迟会被运行时当成 1ms 立即触发（等于空转唤醒）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 宿主透传的重试策略：维持条目投递的历史行为。 */
const ENTRY_RETRY: DeliveryRetryOptions = { maxAttempts: 4, baseDelayMs: 3000 };

/**
 * 「目标已失效」类错误码：该目标出队并告警（沿用绑定表「未绑定即停投」语义），
 * 不退避重试——绑定没了，重试也不会自己长回来。
 */
const INVALID_TARGET_CODES: Readonly<Record<string, true>> = {
  TARGET_UNBOUND: true,
  INVALID_TARGET: true,
  ALBUM_NOT_FOUND: true,
  TARGET_MISSING: true,
  TARGET_GONE: true,
};

/** 可注入的定时器句柄（Node 定时器 / 测试替身）。 */
export type DeliveryTimerHandle = NodeJS.Timeout | number;

export interface DeliveryGateLogger {
  info?(message: string): void;
  warn(message: string): void;
}

/** 一个投递目标的计划：策略键 + 运行期目标本身。 */
export interface DeliveryTargetPlan {
  /** 目标键：`@chat:<来源群>` 或 `群号/相册ID`（策略键 = 来源群 ⊕ 它，见 `policyKeyOf`）。 */
  targetKey: string;
  target: DeliveryTargetLike;
}

/** 一次投递事件（一个事件可带多个目标，各自独立额度 / cron）。 */
export interface DeliveryOffer {
  kind: DeliveryKind;
  /** 来源群（策略键的前半段；`@chat` 目标的策略归属也来自它）。 */
  source: string;
  /** 事件键：词条 = `entryId`，周报 = 取材时刻的 `fireKey`。 */
  eventKey: string;
  targets: readonly DeliveryTargetPlan[];
  /** 事件发生时刻；缺省取时钟。 */
  at?: number;
  /** 已渲染产物：进程内直接复用，重启后靠 `render` 重渲。 */
  png?: Buffer;
}

/** `offer` 的结算明细（测试与日志用）。 */
export interface DeliveryOfferResult {
  /** 真正入队的条目数（`deferred` 是其中 `dueAt` 在未来的部分）。 */
  accepted: number;
  deferred: number;
  /** 同（来源群 × 目标 × 事件键）已在队列里，跳过。 */
  duplicates: number;
  /** 目标键非法 / 队满。额度在 `drain` 判定，所以这里没有「超额」。 */
  dropped: number;
}

/** 一条待外发的（产物 × 目标）。 */
export interface DeliveryGateDelivery {
  item: QueuedDelivery;
  target: DeliveryTargetLike;
  png: Buffer;
  scope: string;
  /** 下游幂等键：`<来源群>:<事件键>:<目标键>`——三者都对上才算「同一张卡」。 */
  dedupeKey: string;
  retry?: DeliveryRetryOptions;
}

/** 批量外发实现（生产 = 一次 `broadcast`；测试 = 桩）。 */
export type DeliveryGateBatch = (deliveries: readonly DeliveryGateDelivery[]) => Promise<DeliveryBatchOutcome>;

export interface DeliveryGateDeps {
  store: DeliveryStateStore;
  /** 策略表读取（每次 offer / drain 刷新一次；失败按「无策略」处理）。 */
  policies: () => Promise<TargetPolicies>;
  /** 没有暂存产物时重渲（进程重启后的词条卡片）；返回 `undefined` = 渲染不出来。 */
  render?: (item: QueuedDelivery) => Promise<Buffer | undefined>;
  deliver: DeliveryGateBatch;
  logger?: DeliveryGateLogger;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => DeliveryTimerHandle;
  clearTimer?: (handle: DeliveryTimerHandle) => void;
}

/** 一轮 drain 的结果。 */
export interface DeliveryDrainResult {
  /** 取出的条目数（不含因重入被跳过的）。 */
  taken: number;
  /** 送进批量外发的条数。 */
  deliveries: number;
  delivered: number;
  /** 本轮失败并留队退避的条数。 */
  failed: number;
  /** 本轮出队放弃的条数（渲染失败到上限 / 目标失效）。 */
  dropped: number;
  /** 本轮因额度用尽而未渲染、直接出队的条数（事件已入库，只是没出卡）。 */
  overQuota: number;
  /** 没有到期项 / 已在 drain / 已销毁。 */
  skipped: boolean;
}

/** 闸门状态快照（测试 / 排障用）。 */
export interface DeliveryGateSnapshot {
  queue: QueuedDelivery[];
  counters: DeliveryStateDoc['counters'];
  nextWakeAt: number | undefined;
  disposed: boolean;
  /**
   * 某（来源群 × 目标）当期已出卡数：读内存里的计数缓存，不额外读盘。
   * 面板 / 日志用它回答「今天这个相册还剩几张」。
   */
  quotaUsed(kind: DeliveryKind, source: string, targetKey: string, at?: number): number;
}

interface QuotaStatus {
  allowed: boolean;
  limit: number;
  used: number;
  periodKey: string;
}

interface RenderedItem {
  item: QueuedDelivery;
  png: Buffer;
}

interface RenderFailure {
  item: QueuedDelivery;
  reason: string;
}

/**
 * 投递闸门。
 *
 * 状态突变（入队 / 结算 / 计数）全部在一条串行链上，`offer` 与 `drain` 因此不会互相覆盖；
 * 渲染与 `broadcast`（慢 I/O）在链外执行，不占用链——决定「先发谁」的是 `seq`，
 * 不是谁先渲染完。
 */
export class DeliveryGate {
  private readonly deps: DeliveryGateDeps;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => DeliveryTimerHandle;
  private readonly clearTimer: (handle: DeliveryTimerHandle) => void;
  private state: DeliveryStateDoc = { version: 1, queue: [], counters: {} };
  private policiesCache: TargetPolicies = {};
  private readonly payloads = new Map<number, Buffer>();
  private payloadBytes = 0;
  private readonly inflight = new Set<number>();
  private readonly warnedWindows = new Set<string>();
  private nextSeq = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private readyPromise: Promise<void> | undefined;
  private timer: DeliveryTimerHandle | undefined;
  private draining = false;
  private disposed = false;
  private persistWarned = false;

  constructor(deps: DeliveryGateDeps) {
    this.deps = deps;
    this.clock = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.setTimer =
      deps.setTimer ??
      ((callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref();
        return handle;
      });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /** 读状态文件并排好第一个 wake；重复调用幂等。 */
  async start(): Promise<void> {
    await this.ensureReady();
    await this.refresh();
  }

  /**
   * 刷新策略缓存（面板保存后调用）。
   *
   * `allows()` 是同步的额度预筛接口，只能读缓存；`offer` / `drain` 每次也会刷新，
   * 因此这里最迟在下一轮投递前生效。
   */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    await this.refreshPolicies();
  }

  /**
   * 投递事件入队（每个目标一条）。
   *
   * 顺序是硬约束：先判重复（同一来源 × 目标 × 事件键不重复入队）→ 再判队列容量
   * （拒收时不改已有队列）→ 才入队并排定 `dueAt`。**额度不在这里判**：
   * 到点时才由 `drain` 按当时的周期判定，cron 把事件推到未来的那一段不占额。
   */
  async offer(event: DeliveryOffer): Promise<DeliveryOfferResult> {
    const result: DeliveryOfferResult = { accepted: 0, deferred: 0, duplicates: 0, dropped: 0 };
    if (this.disposed) return { ...result, dropped: event.targets.length };
    await this.ensureReady();
    const at = event.at ?? this.clock();
    const source = bareChannelId(event.source);
    await this.enqueue(async () => {
      await this.refreshPolicies();
      const seen = new Set<string>();
      for (const plan of event.targets) {
        const targetKey = plan.targetKey.trim();
        if (targetKey === '' || seen.has(targetKey)) {
          result.dropped += 1;
          continue;
        }
        seen.add(targetKey);
        const duplicate = this.state.queue.some(
          (item) =>
            item.source === source &&
            item.targetKey === targetKey &&
            item.eventKey === event.eventKey &&
            item.kind === event.kind,
        );
        if (duplicate) {
          result.duplicates += 1;
          continue;
        }
        const policy = this.policyOf(source, targetKey);
        const dueAt = this.planDueAt(policy, event.kind, source, targetKey, at);
        const item: QueuedDelivery = {
          seq: this.nextSeq,
          source,
          targetKey,
          kind: event.kind,
          eventKey: event.eventKey,
          createdAt: at,
          dueAt,
          channelId: plan.target.channelId,
          attempts: 0,
        };
        if (!this.admits(item)) {
          this.deps.logger?.warn(
            `[Patchouli] ${labelOf(event.kind)}《${event.eventKey}》未投递：投递队列已满` +
              `（${MAX_QUEUE_ITEMS} 条 / ${MAX_STATE_BYTES} 字节上限），目标 ${targetKey}`,
          );
          result.dropped += 1;
          continue;
        }
        this.nextSeq += 1;
        this.state.queue.push(item);
        if (event.png !== undefined) this.keepPayload(item.seq, event.png);
        result.accepted += 1;
        if (dueAt > at) result.deferred += 1;
      }
    });
    if (result.accepted > 0) {
      await this.persist();
      this.arm();
    }
    return result;
  }

  /**
   * 投递一批到期条目。
   *
   * 取到期项（`dueAt <= at`，≤20 条 / ≤8 MiB）→ 按（来源群 × 目标）判 `perDay` / `perWeek`
   * 额度（用尽即出队告警，**不再渲染**）→ 渲染（同一事件多目标只渲一次）→ **一次** 批量外发 →
   * 按 `outcomes` 逐条结算（成功出队、失败留队退避、目标失效出队）→ 落盘 → 重排 wake。
   *
   * 判额 / 占额与出队都在串行链内完成：并发 drain 看到的永远是同一条队列与同一份计数，
   * 不会把同一条额度占两次。
   */
  async drain(at = this.clock()): Promise<DeliveryDrainResult> {
    const idle: DeliveryDrainResult = {
      taken: 0,
      deliveries: 0,
      delivered: 0,
      failed: 0,
      dropped: 0,
      overQuota: 0,
      skipped: true,
    };
    if (this.disposed || this.draining) return idle;
    this.draining = true;
    try {
      await this.ensureReady();
      // 额度在到点这一刻判定，所以策略缓存必须先刷新：面板刚存的 cron / 额度本轮就生效。
      const taken = await this.enqueue(async () => {
        await this.refreshPolicies();
        const due = this.takeDue(at);
        return this.filterByQuota(due, at);
      });
      if (taken.admitted.length === 0) {
        if (taken.overQuota === 0) return idle;
        await this.persist();
        return { ...idle, overQuota: taken.overQuota, skipped: false };
      }
      const batch = taken.admitted;
      const rendered = await this.renderBatch(batch);
      const prepared = rendered.ready;
      let outcomes: readonly DeliveryOutcomeLike[] = [];
      let batchError: string | undefined;
      if (prepared.length > 0) {
        const deliveries: DeliveryGateDelivery[] = prepared.map((entry) => ({
          item: entry.item,
          target: targetOf(entry.item),
          png: entry.png,
          scope: entry.item.kind === 'weekly' ? SCOPE_WEEKLY : SCOPE_ENTRY,
          /* 幂等键必须带来源群：队列身份是（来源 × 目标 × 事件键），而 `eventKey` 在跨来源时
             会撞——同一个相册、同一天的同一标题 slug（词条），或同一取材时刻（周报 `fireKey`）。
             只按事件键 + 目标做键，第二个来源的那张卡会被下游判成「已发过」直接跳过。 */
          dedupeKey: `${entry.item.source}:${entry.item.eventKey}:${entry.item.targetKey}`,
          retry: entry.item.kind === 'entry' ? ENTRY_RETRY : undefined,
        }));
        try {
          const result = await this.deps.deliver(deliveries);
          if (result.outcomes.length !== deliveries.length) {
            batchError = `批量投递结果条数不符（outcomes ${result.outcomes.length} != deliveries ${deliveries.length}）`;
          } else {
            outcomes = result.outcomes;
          }
        } catch (error: unknown) {
          batchError = error instanceof Error ? error.message : String(error);
        }
        if (batchError !== undefined) {
          this.deps.logger?.warn(`[Patchouli] 批量投递失败，本批 ${deliveries.length} 条留队退避：${batchError}`);
        }
      }
      const settled = await this.enqueue(() => this.settle(at, prepared, outcomes, rendered.failures));
      // 落盘在串行链外：一次慢盘写不该挡住新的 `offer`（队列已经定序，写谁都是全量快照）。
      await this.persist();
      return { ...settled, overQuota: taken.overQuota };
    } finally {
      this.draining = false;
      this.arm();
    }
  }

  /** 下一次需要唤醒的时刻（`undefined` = 队列空 / 正在 drain / 已销毁）。 */
  nextWakeAt(): number | undefined {
    if (this.disposed || this.draining) return undefined;
    let wake: number | undefined;
    for (const item of this.state.queue) {
      if (this.inflight.has(item.seq)) continue;
      // 过期条目原样返回：`arm()` 用 `max(0, wake - now)` 排一次 0 延迟唤醒，
      // 本轮没取到的部分不能等下一个未来时刻。
      if (wake === undefined || item.dueAt < wake) wake = item.dueAt;
    }
    return wake;
  }

  /**
   * 该目标现在还有额度吗（周报取材前的预筛，最终以 `drain` 到点判定为准）。
   *
   * 同步读内存快照：`offer` / `drain` 会刷新策略缓存，因此这里的结果最多滞后一次投递事件。
   */
  allows(kind: DeliveryKind, source: string, targetKey: string, at = this.clock()): boolean {
    const key = this.policyKeyOf(source, targetKey);
    const policy = this.policiesCache[key];
    if (policy === undefined) return true;
    return this.quotaStatus(kind, key, at, policy).allowed;
  }

  /**
   * 本期额度已满时，这个目标还有没有下一班。
   *
   * `allows()` 只看**当前周期**的计数，所以「今天就满了」不等于「这条没机会」：
   * cron 把下一次到点排在下一个自然日 / 自然周时，那一条该入队等新周期的额度，
   * 而不是在预筛里被当成超额丢掉。返回值 = 候选 `dueAt` 落在别的周期。
   *
   * 同步只读：与 `allows()` 同一份策略缓存口径，不占额、不改计数。
   */
  wouldDeferPastPeriod(kind: DeliveryKind, source: string, targetKey: string, at = this.clock()): boolean {
    const policy = this.policiesCache[this.policyKeyOf(source, targetKey)];
    // 无策略 = 立即投，下一次到点就是现在，不存在「等到下一周期」。
    if (policy === undefined) return false;
    const dueAt = this.cronDueAt(policy, kind, at);
    return periodKeyFor(kind, dueAt) !== periodKeyFor(kind, at);
  }

  /** 状态快照（只读副本）。 */
  snapshot(): DeliveryGateSnapshot {
    return {
      queue: this.state.queue.map((item) => ({ ...item })),
      counters: Object.fromEntries(
        Object.entries(this.state.counters).map(([key, counter]) => [key, { ...counter }]),
      ),
      nextWakeAt: this.nextWakeAt(),
      disposed: this.disposed,
      quotaUsed: (kind, source, targetKey, at = this.clock()) => this.quotaUsed(kind, source, targetKey, at),
    };
  }

  /** 停闸：清定时器、丢弃暂存产物；此后 `offer` / `drain` 一律空转。 */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.payloads.clear();
    this.payloadBytes = 0;
    this.inflight.clear();
  }

  /* ---------------------------------------------------------------- *
   * 内部：状态 / 额度 / 排期
   * ---------------------------------------------------------------- */

  private ensureReady(): Promise<void> {
    if (this.readyPromise === undefined) {
      this.readyPromise = this.loadState();
    }
    return this.readyPromise;
  }

  private async loadState(): Promise<void> {
    this.state = await this.deps.store.load();
    let maxSeq = 0;
    for (const item of this.state.queue) {
      if (item.seq > maxSeq) maxSeq = item.seq;
    }
    this.nextSeq = maxSeq + 1;
    this.pruneCounters();
    this.arm();
  }

  /** 掉陈旧计数：周期已翻篇的格子除了占地方没有别的作用。 */
  private pruneCounters(): void {
    const now = this.clock();
    for (const [key, counter] of Object.entries(this.state.counters)) {
      const separator = key.indexOf('\u0000');
      const kind = key.slice(0, separator);
      if (separator <= 0 || (kind !== 'entry' && kind !== 'weekly')) {
        delete this.state.counters[key];
        continue;
      }
      if (counter.periodKey !== periodKeyFor(kind, now)) delete this.state.counters[key];
    }
  }

  private async refreshPolicies(): Promise<void> {
    try {
      this.policiesCache = await this.deps.policies();
    } catch (error: unknown) {
      // 策略读不出来 = 按「无策略」直通：宁可照旧投递，也不要拿一次 IO 抖动停掉全部投递。
      this.deps.logger?.warn(
        `[Patchouli] 读取投递策略失败，本次按无策略投递：${error instanceof Error ? error.message : String(error)}`,
      );
      this.policiesCache = {};
    }
  }

  /** 策略键：`<来源群>\u0000<目标键>`（来源群去平台前缀，同一个群的不同写法认同一份策略）。 */
  private policyKeyOf(source: string, targetKey: string): string {
    return policyKey(bareChannelId(source), targetKey);
  }

  private policyOf(source: string, targetKey: string): TargetPolicy {
    return this.policiesCache[this.policyKeyOf(source, targetKey)] ?? DEFAULT_POLICY;
  }

  /** 额度状态（只读）：`limit <= 0` = 不限量。`key` 是策略键（计数与策略同一口径）。 */
  private quotaStatus(kind: DeliveryKind, key: string, at: number, policy: TargetPolicy): QuotaStatus {
    const limit = kind === 'entry' ? policy.perDay : policy.perWeek;
    if (limit <= 0) return { allowed: true, limit, used: 0, periodKey: '' };
    const periodKey = periodKeyFor(kind, at);
    const counter = this.state.counters[counterKey(kind, key)];
    const used = counter !== undefined && counter.periodKey === periodKey ? counter.used : 0;
    return { allowed: used < limit, limit, used, periodKey };
  }

  private recordQuota(kind: DeliveryKind, key: string, quota: QuotaStatus): void {
    if (quota.limit <= 0) return;
    this.state.counters[counterKey(kind, key)] = { periodKey: quota.periodKey, used: quota.used + 1 };
  }

  /** 当期已出卡数（只读缓存；`limit <= 0` 的无限量目标按 0 算，与计数口径一致）。 */
  private quotaUsed(kind: DeliveryKind, source: string, targetKey: string, at: number): number {
    const key = this.policyKeyOf(source, targetKey);
    return this.quotaStatus(kind, key, at, this.policiesCache[key] ?? DEFAULT_POLICY).used;
  }

  /**
   * cron 给出的候选到期时刻（epoch ms，不含队列随机间隔）。
   *
   * - 定时取**本类型**的那一条 cron（词条 `entryCron` / 周报 `weeklyCron`）；
   * - 空 cron（或解析不出来）：`at`，立即投；
   * - 非空 cron：`nextCronAt`（严格大于 `at` 的下一次触发，上海时区）。
   */
  private cronDueAt(policy: TargetPolicy, kind: DeliveryKind, at: number): number {
    const cron = cronForKind(policy, kind);
    const spec = cron === '' ? null : parseCron(cron);
    /* 同一分钟内的触发要算「现在」：全局 cron 生成周报的时刻通常就等于目标的 weeklyCron
       时刻，而 `nextCronAt` 是严格大于，会把每份周报整整推迟一周。回看一分钟即覆盖「本分钟已到点」。 */
    const sameMinute = spec !== null && nextCronAt(spec, at - 60_000) <= at;
    return spec === null || sameMinute ? at : nextCronAt(spec, at);
  }

  /**
   * 该条目的到期时刻（epoch ms）。
   *
   * 见 `cronDueAt`；同（来源群 × 目标）在队列里已有条目时再退一个随机间隔，相邻两条不挤在同一毫秒。
   */
  private planDueAt(
    policy: TargetPolicy,
    kind: DeliveryKind,
    source: string,
    targetKey: string,
    at: number,
  ): number {
    const candidate = this.cronDueAt(policy, kind, at);
    let previous: number | undefined;
    for (const item of this.state.queue) {
      if (item.source !== source || item.targetKey !== targetKey) continue;
      if (previous === undefined || item.dueAt > previous) previous = item.dueAt;
    }
    if (previous === undefined || candidate >= previous + TARGET_GAP_MIN_MS) return candidate;
    const gap = TARGET_GAP_MIN_MS + Math.floor(this.random() * (TARGET_GAP_MAX_MS - TARGET_GAP_MIN_MS + 1));
    return previous + gap;
  }

  /** 准入：条数与序列化字节都不得越界（越界拒收，已有条目原样保留）。 */
  private admits(item: QueuedDelivery): boolean {
    if (this.state.queue.length >= MAX_QUEUE_ITEMS) return false;
    const candidate: DeliveryStateDoc = {
      version: 1,
      queue: [...this.state.queue, item],
      counters: this.state.counters,
    };
    return this.deps.store.measure(candidate) <= MAX_STATE_BYTES;
  }

  /* ---------------------------------------------------------------- *
   * 内部：产物缓存
   * ---------------------------------------------------------------- */

  private keepPayload(seq: number, png: Buffer): void {
    const size = png.length;
    if (size > MAX_PAYLOAD_BYTES) return;
    if (this.payloadBytes + size > MAX_PAYLOAD_BYTES) {
      // 超出上界就不再暂存：条目仍在队列里，到点由 `render` 重渲。
      this.deps.logger?.info?.('[Patchouli] 已渲染产物缓存达到上限，后续条目将在投递时重新渲染');
      return;
    }
    this.payloads.set(seq, png);
    this.payloadBytes += size;
  }

  private releasePayload(seq: number): void {
    const png = this.payloads.get(seq);
    if (png === undefined) return;
    this.payloads.delete(seq);
    this.payloadBytes = Math.max(0, this.payloadBytes - png.length);
  }

  /* ---------------------------------------------------------------- *
   * 内部：drain 三段（取件 / 渲染 / 结算）
   * ---------------------------------------------------------------- */

  /**
   * 取到期待发的一批（≤20 条 / ≤8 MiB），并标记在途。
   *
   * 这里只决定「谁到点了」，不判额度：额度是独立的一步，见 `filterByQuota`。
   */
  private takeDue(at: number): QueuedDelivery[] {
    const due: QueuedDelivery[] = [];
    let bytes = 0;
    for (const item of this.state.queue) {
      if (due.length >= MAX_BATCH_ITEMS) break;
      if (this.inflight.has(item.seq) || item.dueAt > at) continue;
      const size = this.payloads.get(item.seq)?.length ?? ESTIMATED_ITEM_BYTES;
      if (due.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
      bytes += size;
      due.push(item);
    }
    for (const item of due) this.inflight.add(item.seq);
    return due;
  }

  /**
   * 渲染前的额度闸门：读额度 → 判定 → 占额 → 超额出队。
   *
   * 必须在串行链内调用（`drain` 已如此），否则并发 drain 会读到同一份 `used` 各占一次。
   * 超额条目**不渲染**：词条已经入库，缺的只是这张卡，丢掉比空转一次渲染更划算。
   * 重试中的条目（`attempts > 0`）跳过判额：首次到点时已经占过额，重试不能再扣一次。
   */
  private filterByQuota(
    batch: readonly QueuedDelivery[],
    at: number,
  ): { admitted: QueuedDelivery[]; overQuota: number } {
    const admitted: QueuedDelivery[] = [];
    const rejected = new Set<number>();
    for (const item of batch) {
      if (item.attempts > 0) {
        admitted.push(item);
        continue;
      }
      const key = this.policyKeyOf(item.source, item.targetKey);
      const quota = this.quotaStatus(item.kind, key, at, this.policiesCache[key] ?? DEFAULT_POLICY);
      if (!quota.allowed) {
        rejected.add(item.seq);
        this.deps.logger?.warn(
          `今日卡片配额已满，词条已入库未出卡：${item.kind} ${item.targetKey} ${item.eventKey}`,
        );
        continue;
      }
      this.recordQuota(item.kind, key, quota);
      admitted.push(item);
    }
    if (rejected.size > 0) {
      this.state.queue = this.state.queue.filter((item) => !rejected.has(item.seq));
      for (const seq of rejected) {
        this.releasePayload(seq);
        this.inflight.delete(seq);
      }
    }
    return { admitted, overQuota: rejected.size };
  }

  /** 逐条取产物：同事件多目标只渲一次；渲染失败只记该条，不连坐同批。 */
  private async renderBatch(
    batch: readonly QueuedDelivery[],
  ): Promise<{ ready: RenderedItem[]; failures: RenderFailure[] }> {
    const ready: RenderedItem[] = [];
    const failures: RenderFailure[] = [];
    const cache = new Map<string, Buffer>();
    const missing = new Set<string>();
    for (const item of batch) {
      /* 产物身份必须带来源群，与队列身份 / 下游幂等键同一口径：`eventKey` 会跨来源撞
         （周报同一取材时刻的 `fireKey`、词条同一天的标题 slug），只按「种类 + 事件键」
         缓存会让第二个来源的卡片拿到第一个来源的 PNG。 */
      const key = `${item.kind}\u0000${item.source}\u0000${item.eventKey}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        ready.push({ item, png: cached });
        continue;
      }
      if (missing.has(key)) {
        failures.push({ item, reason: '同一事件的产物渲染失败' });
        continue;
      }
      const stored = this.payloads.get(item.seq);
      if (stored !== undefined) {
        cache.set(key, stored);
        ready.push({ item, png: stored });
        continue;
      }
      if (this.deps.render === undefined) {
        missing.add(key);
        failures.push({ item, reason: '没有暂存产物且未提供重渲入口（进程重启过）' });
        continue;
      }
      try {
        const png = await this.deps.render(item);
        if (png === undefined) {
          missing.add(key);
          failures.push({ item, reason: '渲染未产出图片' });
          continue;
        }
        cache.set(key, png);
        ready.push({ item, png });
      } catch (error: unknown) {
        missing.add(key);
        failures.push({ item, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ready, failures };
  }

  /** 结算一批：成功出队、失败退避、渲染失败到上限 / 目标失效出队。落盘一次。 */
  private async settle(
    at: number,
    prepared: readonly RenderedItem[],
    outcomes: readonly DeliveryOutcomeLike[],
    failures: readonly RenderFailure[],
  ): Promise<DeliveryDrainResult> {
    const result: DeliveryDrainResult = {
      taken: prepared.length + failures.length,
      deliveries: prepared.length,
      delivered: 0,
      failed: 0,
      dropped: 0,
      overQuota: 0,
      skipped: false,
    };
    const drop = (item: QueuedDelivery, reason: string): void => {
      this.removeItem(item.seq);
      this.releasePayload(item.seq);
      this.inflight.delete(item.seq);
      result.dropped += 1;
      this.deps.logger?.warn(
        `[Patchouli] ${labelOf(item.kind)}《${item.eventKey}》放弃投递到 ${item.targetKey}：${reason}`,
      );
    };
    const retry = (item: QueuedDelivery, reason: string, maxAttempts: number): void => {
      const attempts = item.attempts + 1;
      if (attempts >= maxAttempts) {
        drop(item, `${reason}（已尝试 ${attempts} 次）`);
        return;
      }
      item.attempts = attempts;
      item.dueAt = at + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
      this.inflight.delete(item.seq);
      result.failed += 1;
      this.deps.logger?.warn(
        `[Patchouli] ${labelOf(item.kind)}《${item.eventKey}》投递 ${item.targetKey} 失败（第 ${attempts} 次）：${reason}`,
      );
    };

    for (const failure of failures) {
      retry(failure.item, `渲染失败：${failure.reason}`, MAX_RENDER_ATTEMPTS);
    }

    for (const [index, entry] of prepared.entries()) {
      const outcome = outcomes[index];
      if (outcome === undefined) {
        // 整批失败（没有逐条结果）：留队退避，绝不整批回滚成「都算成功」。
        retry(entry.item, '批量投递无逐条结果', MAX_DELIVERY_ATTEMPTS);
        continue;
      }
      if (outcome.ok || outcome.skipped !== undefined) {
        this.removeItem(entry.item.seq);
        this.releasePayload(entry.item.seq);
        this.inflight.delete(entry.item.seq);
        result.delivered += 1;
        continue;
      }
      const code = outcome.error?.code ?? 'DELIVERY_FAILED';
      const message = outcome.error?.message ?? '投递未成功';
      if (INVALID_TARGET_CODES[code] === true) {
        drop(entry.item, `目标已失效（${code}：${message}）`);
        continue;
      }
      retry(entry.item, `${code}：${message}`, MAX_DELIVERY_ATTEMPTS);
    }

    if (result.taken > 0) {
      this.deps.logger?.info?.(
        `[Patchouli] 投递一批 ${result.taken} 条：成功 ${result.delivered}，退避 ${result.failed}，放弃 ${result.dropped}`,
      );
    }
    return result;
  }

  private removeItem(seq: number): void {
    const index = this.state.queue.findIndex((item) => item.seq === seq);
    if (index >= 0) this.state.queue.splice(index, 1);
  }

  /* ---------------------------------------------------------------- *
   * 内部：定时器 / 串行链 / 落盘
   * ---------------------------------------------------------------- */

  /** 单定时器：永远指向队列里最早的 `dueAt`。 */
  private arm(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const wake = this.nextWakeAt();
    if (wake === undefined) return;
    /* 超过 `MAX_TIMER_DELAY_MS` 的延迟会被当成 1ms 立即触发：夹到上界后到点再排一次，
       绝不把「很久以后」变成空转唤醒（`nextCronAt` 的兜底就可能排在 8 年后）。 */
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, wake - this.clock()));
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.drain().catch((error: unknown) => {
        this.deps.logger?.warn(
          `[Patchouli] 定时投递触发异常：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, delay);
  }

  /** 状态突变的串行链（只包内存操作与落盘，不包渲染 / 网络）。 */
  private enqueue<T>(run: () => Promise<T> | T): Promise<T> {
    const started = this.chain.then(run, run);
    this.chain = started.then(
      (): undefined => undefined,
      (): undefined => undefined,
    );
    return started;
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.store.save(this.state);
    } catch (error: unknown) {
      // 坏文件 / 超限一律不覆盖；只在第一次告警，避免每次 drain 刷屏。
      if (!this.persistWarned) {
        this.persistWarned = true;
        this.deps.logger?.warn(
          `[Patchouli] 投递状态落盘失败（文件保持原样，队列只在内存里）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

/**
 * 生产用批量外发：**一次** `broadcast`。
 *
 * 服务缺失 / 未实现 `broadcast` 一律整理成「整批失败」（`outcomes` 为空）：
 * 闸门据此把整批留队退避，没有逐条 fallback（`DELIVERY-BATCH-01`）。
 */
export function createBroadcastDeliver(ctx: unknown, logger?: DeliveryGateLogger): DeliveryGateBatch {
  return async (deliveries) => {
    if (deliveries.length === 0) return { ok: true, delivered: 0, total: 0, outcomes: [] };
    const service = getDeliveryService(ctx);
    if (service === undefined) {
      logger?.warn("[Patchouli] 批量投递需要宿主提供 ctx['miyako-delivery']，本批留队退避");
      return { ok: false, delivered: 0, total: deliveries.length, outcomes: [] };
    }
    if (service.broadcast === undefined) {
      logger?.warn('[Patchouli] 投递服务未实现 broadcast：批量投递是硬契约，本批留队退避');
      return { ok: false, delivered: 0, total: deliveries.length, outcomes: [] };
    }
    try {
      const result = await service.broadcast(
        deliveries.map((delivery) => ({
          target: delivery.target,
          elements: [h.image(delivery.png, 'image/png')],
          scope: delivery.scope,
          dedupeKey: delivery.dedupeKey,
          retry: delivery.retry,
        })),
      );
      const outcomes = result.outcomes ?? [];
      return {
        ok: result.ok,
        delivered: result.deliveredCount ?? outcomes.filter((item) => item.ok && item.skipped === undefined).length,
        total: result.totalCount ?? deliveries.length,
        outcomes,
      };
    } catch (error: unknown) {
      logger?.warn(
        `[Patchouli] 批量投递异常，本批留队退避：${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, delivered: 0, total: deliveries.length, outcomes: [] };
    }
  };
}

/**
 * 队列项 → 投递目标。
 *
 * 队列只持久化 `targetKey` + `channelId`：相册目标的相册 ID 在键里（`群号/相册ID`），
 * 频道目标（`@chat:<source>`）直接用 `channelId`（灰测改道时它与来源群不同，因此**不能**从键反推）。
 */
function targetOf(item: QueuedDelivery): DeliveryTargetLike {
  const slash = item.targetKey.indexOf('/');
  if (!item.targetKey.startsWith('@chat:') && slash > 0) {
    return { kind: 'album', channelId: item.channelId, albumId: item.targetKey.slice(slash + 1) };
  }
  return { kind: 'channel', channelId: item.channelId };
}

function labelOf(kind: DeliveryKind): string {
  return kind === 'entry' ? '词条' : '知识周报';
}
