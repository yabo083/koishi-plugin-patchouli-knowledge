/**
 * 定时投递闸门：入队、限额、窗口等待、批量结算。
 *
 * 设计要点（`docs/delivery-schedule.md` §3/§4）：
 *   - **排队不丢弃**：窗口外的事件进队列等下一个窗口，绝不让「讨论结束的时刻」决定词条可见性；
 *   - **限额按目标**：同一事件投三个目标 = 三条独立额度，各自扣一次；
 *   - **批量外发**：一批到期条目渲染后**一次** `broadcast`，按 `outcomes` 逐（产物 × 目标）结算，
 *     成功出队、失败留队退避、不整批回滚；
 *   - **单定时器**：只有一条 wake 定时器指向队列里最早的 `deliverAt`，没有任何轮询。
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
import { DEFAULT_POLICY, deliverAtFor, periodKeyFor, windowContains, windowSpecFor } from './policy-resolve';

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

/** 同目标相邻两条的最小 / 最大间隔（「同目标至少随机间隔 1–3 分钟」）。 */
const TARGET_GAP_MIN_MS = 60_000;
const TARGET_GAP_MAX_MS = 180_000;

/** 没有暂存产物时，一条条目在批字节预算里按这个值估算。 */
const ESTIMATED_ITEM_BYTES = 4096;

/** 词条 / 周报的投递 scope（透传给 `miyako-delivery`，与旧实现一致）。 */
const SCOPE_ENTRY = 'patchouli:entry';
const SCOPE_WEEKLY = 'patchouli:weekly-album';

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
  /** 策略 / 计数键：`@chat:<source>` 或 `群号/相册ID`。 */
  targetKey: string;
  target: DeliveryTargetLike;
}

/** 一次投递事件（一个事件可带多个目标，各自独立额度 / 窗口）。 */
export interface DeliveryOffer {
  kind: DeliveryKind;
  /** 来源群（`@chat` 目标的策略归属）。 */
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
  /** 真正入队的条目数（`deferred` 是其中需要等窗口的部分）。 */
  accepted: number;
  deferred: number;
  /** 同（目标 × 事件键）已在队列里，跳过且不扣额。 */
  duplicates: number;
  /** 额度用尽 / 队满 / 目标键非法。 */
  dropped: number;
}

/** 一条待外发的（产物 × 目标）。 */
export interface DeliveryGateDelivery {
  item: QueuedDelivery;
  target: DeliveryTargetLike;
  png: Buffer;
  scope: string;
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
  /** 没有到期项 / 已在 drain / 已销毁。 */
  skipped: boolean;
}

/** 闸门状态快照（测试 / 排障用）。 */
export interface DeliveryGateSnapshot {
  queue: QueuedDelivery[];
  counters: DeliveryStateDoc['counters'];
  nextWakeAt: number | undefined;
  disposed: boolean;
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
   * 顺序是硬约束：先判重复（不扣额）→ 再判额度（不占额就不入队）→ 再判队列容量
   * （拒收时**不**扣额）→ 才占额 + 入队。任何一步失败都不改变已有队列。
   */
  async offer(event: DeliveryOffer): Promise<DeliveryOfferResult> {
    const result: DeliveryOfferResult = { accepted: 0, deferred: 0, duplicates: 0, dropped: 0 };
    if (this.disposed) return { ...result, dropped: event.targets.length };
    await this.ensureReady();
    const at = event.at ?? this.clock();
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
          (item) => item.targetKey === targetKey && item.eventKey === event.eventKey && item.kind === event.kind,
        );
        if (duplicate) {
          result.duplicates += 1;
          continue;
        }
        const policy = this.policyOf(targetKey);
        const quota = this.quotaStatus(event.kind, targetKey, at, policy);
        if (!quota.allowed) {
          this.deps.logger?.warn(
            `[Patchouli] ${labelOf(event.kind)}《${event.eventKey}》未投递：目标 ${targetKey} ` +
              `${quota.periodKey} 额度已用尽（${quota.used}/${quota.limit}）`,
          );
          result.dropped += 1;
          continue;
        }
        const deliverAt = this.planDeliverAt(policy, targetKey, at);
        const item: QueuedDelivery = {
          seq: this.nextSeq,
          source: event.source,
          targetKey,
          kind: event.kind,
          eventKey: event.eventKey,
          createdAt: at,
          deliverAt,
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
        this.recordQuota(event.kind, targetKey, quota);
        this.state.queue.push(item);
        if (event.png !== undefined) this.keepPayload(item.seq, event.png);
        result.accepted += 1;
        if (deliverAt > at) result.deferred += 1;
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
   * 取到期项（≤20 条 / ≤8 MiB）→ 渲染（同一事件多目标只渲一次）→ **一次** 批量外发 →
   * 按 `outcomes` 逐条结算（成功出队、失败留队退避、目标失效出队）→ 落盘 → 重排 wake。
   */
  async drain(at = this.clock()): Promise<DeliveryDrainResult> {
    const idle: DeliveryDrainResult = {
      taken: 0,
      deliveries: 0,
      delivered: 0,
      failed: 0,
      dropped: 0,
      skipped: true,
    };
    if (this.disposed || this.draining) return idle;
    this.draining = true;
    try {
      await this.ensureReady();
      const batch = await this.enqueue(() => this.takeDue(at));
      if (batch.length === 0) return idle;
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
          dedupeKey: `${entry.item.eventKey}:${entry.item.targetKey}`,
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
      return settled;
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
      if (wake === undefined || item.deliverAt < wake) wake = item.deliverAt;
    }
    return wake;
  }

  /**
   * 该目标现在还有额度吗（周报取材前的预筛，最终以 `offer` 占额为准）。
   *
   * 同步读内存快照：`offer` / `drain` 会刷新策略缓存，因此这里的结果最多滞后一次投递事件。
   */
  allows(kind: DeliveryKind, targetKey: string, at = this.clock()): boolean {
    const policy = this.policiesCache[targetKey];
    if (policy === undefined) return true;
    return this.quotaStatus(kind, targetKey, at, policy).allowed;
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

  private policyOf(targetKey: string): TargetPolicy {
    return this.policiesCache[targetKey] ?? DEFAULT_POLICY;
  }

  /** 额度状态（只读）：`limit <= 0` = 不限量。 */
  private quotaStatus(kind: DeliveryKind, targetKey: string, at: number, policy: TargetPolicy): QuotaStatus {
    const limit = kind === 'entry' ? policy.entryPerDay : policy.weeklyPerWeek;
    if (limit <= 0) return { allowed: true, limit, used: 0, periodKey: '' };
    const periodKey = periodKeyFor(kind, at);
    const counter = this.state.counters[counterKey(kind, targetKey)];
    const used = counter !== undefined && counter.periodKey === periodKey ? counter.used : 0;
    return { allowed: used < limit, limit, used, periodKey };
  }

  private recordQuota(kind: DeliveryKind, targetKey: string, quota: QuotaStatus): void {
    if (quota.limit <= 0) return;
    this.state.counters[counterKey(kind, targetKey)] = { periodKey: quota.periodKey, used: quota.used + 1 };
  }

  /**
   * 该条目的投递时刻：策略窗口 + 抖动（`deliverAtFor`），再加同目标的 1–3 分钟间隔。
   *
   * 间隔只在「加完仍在窗口内」时生效——把条目推出窗口等于让它多等一整天。
   */
  private planDeliverAt(policy: TargetPolicy, targetKey: string, at: number): number {
    const spec = windowSpecFor(policy);
    if (spec === null) return at;
    const candidate = deliverAtFor(spec, at, this.random);
    let previous: number | undefined;
    for (const item of this.state.queue) {
      if (item.targetKey !== targetKey) continue;
      if (previous === undefined || item.deliverAt > previous) previous = item.deliverAt;
    }
    if (previous === undefined || candidate >= previous + TARGET_GAP_MIN_MS) return candidate;
    const gap = TARGET_GAP_MIN_MS + Math.floor(this.random() * (TARGET_GAP_MAX_MS - TARGET_GAP_MIN_MS + 1));
    const spaced = previous + gap;
    return windowContains(spec, spaced) ? spaced : candidate;
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

  private takeDue(at: number): QueuedDelivery[] {
    const due: QueuedDelivery[] = [];
    let bytes = 0;
    for (const item of this.state.queue) {
      if (due.length >= MAX_BATCH_ITEMS) break;
      if (this.inflight.has(item.seq) || item.deliverAt > at) continue;
      const size = this.payloads.get(item.seq)?.length ?? ESTIMATED_ITEM_BYTES;
      if (due.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
      bytes += size;
      due.push(item);
    }
    for (const item of due) this.inflight.add(item.seq);
    return due;
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
      const key = `${item.kind}\u0000${item.eventKey}`;
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
      item.deliverAt = at + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
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

  /** 单定时器：永远指向队列里最早的 `deliverAt`。 */
  private arm(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const wake = this.nextWakeAt();
    if (wake === undefined) return;
    const delay = Math.max(0, wake - this.clock());
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
