/**
 * 定时投递的运行期状态：待投队列 + 每「目标 × 周期」用量计数。
 *
 * 独立文件 `.patchouli/delivery-state.json`、独立原子写、`0600`——这里的字节决定
 * 「哪些投递还没发出去」与「今天已经发了几条」，与 `settings.json`（用户配置）
 * 的生命周期完全不同，混在一个文件里会让一次面板保存把队列抹掉。
 *
 * 三条硬约束：
 *   1. **有界**：队列 ≤1024 条且序列化 ≤1 MiB。满了**拒收新事件并告警**，绝不淘汰旧项
 *      （丢掉的必须是「还没承诺过的新投递」，不能是已经占过额度的旧投递）。
 *   2. **不覆盖坏文件**：读不懂就当空状态运行并告警，但写路径一律拒绝落盘
 *      （`DeliveryStateError`）——「当成空状态写回去」等于把整条队列静默清空。
 *   3. **同路径串行**：同一进程内对同一文件的读改写依次执行，最后一次 `rename`
 *      一定是完整文档。
 *
 * 计数口径：键 = `<kind>\u0000<targetKey>`，值 = 该目标当前周期的用量。
 * 周期切换是**惰性**的——比较 `periodKey` 不同就清零，不做定时任务。
 * 同一事件投多个目标时每个目标各扣一次（目标各自独立额度）。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

import { resolveWikiLayout } from '../wiki/layout';

/** 状态文件版本；结构不符（含旧版）一律视为读不懂。 */
export const DELIVERY_STATE_VERSION = 1;

/** 队列条数上限：1024 条已经是「几十天没发出去」的量级。 */
export const MAX_QUEUE_ITEMS = 1024;

/** 状态文件序列化上限（字节）：超过就不再接受新事件，避免状态文件无限膨胀。 */
export const MAX_STATE_BYTES = 1024 * 1024;

/** 计数项上限（`目标 × kind`）：相册候选 ≤400、订阅行 ≤256，2048 足够且是硬上限。 */
export const MAX_DELIVERY_COUNTERS = 2048;

/** 单个字符串字段（来源 / 目标键 / 事件键）的字节上限：脏文件不得带长字符串进常驻内存。 */
const MAX_FIELD_CHARS = 256;
const MAX_CHANNEL_CHARS = 128;

/** 投递种类：词条（讨论沉淀）与周报（定时取材）。 */
export type DeliveryKind = 'entry' | 'weekly';

/** 队列里的一条**待投**（粒度是「事件 × 目标」：同一事件投三个目标 = 三条）。 */
export interface QueuedDelivery {
  /** 单调递增，FIFO 序。 */
  seq: number;
  /** 来源群（`@chat` 目标据此决定策略归属）。 */
  source: string;
  /** 策略 / 计数键：`@chat:<source>` 或 `群号/相册ID`。 */
  targetKey: string;
  kind: DeliveryKind;
  /** 事件键：词条 = `entryId`，周报 = 取材时刻的 `fireKey`。 */
  eventKey: string;
  createdAt: number;
  /** 已含抖动与窗口约束的投递时刻。 */
  deliverAt: number;
  /** 实际投递频道（`@chat` 是来源群，相册是相册所属群）。 */
  channelId: string;
  /** 已尝试次数（渲染或批量投递失败后 +1），用于退避与放弃。 */
  attempts: number;
}

/** 一个目标在一个周期内的用量。 */
export interface DeliveryCounter {
  /** 该用量所属周期（词条 `YYYY-MM-DD`，周报 ISO 周）；不同即清零。 */
  periodKey: string;
  used: number;
}

/** 状态文档（落盘形状）。 */
export interface DeliveryStateDoc {
  version: typeof DELIVERY_STATE_VERSION;
  queue: QueuedDelivery[];
  counters: Record<string, DeliveryCounter>;
}

/** 计数的存储键：`<kind>\u0000<targetKey>`（每目标每种类只留当前周期一格）。 */
export function counterKey(kind: DeliveryKind, targetKey: string): string {
  return `${kind}\u0000${targetKey}`;
}

/** 状态文件路径：`<wikiDir>/.patchouli/delivery-state.json`。 */
export function deliveryStatePath(wikiDir: string): string {
  return nodePath.join(resolveWikiLayout(wikiDir).patchouliDir, 'delivery-state.json');
}

/** 空状态（每次新建对象：调用方会直接改它）。 */
export function emptyDeliveryState(): DeliveryStateDoc {
  return { version: DELIVERY_STATE_VERSION, queue: [], counters: {} };
}

/** 读不懂的状态文件：写路径拒绝落盘（文件字节保持原样）。 */
export class DeliveryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryStateError';
  }
}

export interface DeliveryStateLogger {
  warn(message: string): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxChars) return undefined;
  return trimmed;
}

/** 单条队列项清洗；任何字段不合法就整条丢弃（宁可不投，也不拿脏数据建投递点）。 */
function sanitizeQueuedDelivery(raw: unknown): QueuedDelivery | undefined {
  if (!isPlainObject(raw)) return undefined;
  const seq = finiteNumber(raw.seq);
  if (seq === undefined || !Number.isSafeInteger(seq) || seq <= 0) return undefined;
  const kind = raw.kind === 'entry' || raw.kind === 'weekly' ? raw.kind : undefined;
  if (kind === undefined) return undefined;
  const source = boundedText(raw.source, MAX_FIELD_CHARS);
  const targetKey = boundedText(raw.targetKey, MAX_FIELD_CHARS);
  const eventKey = boundedText(raw.eventKey, MAX_FIELD_CHARS);
  const channelId = boundedText(raw.channelId, MAX_CHANNEL_CHARS);
  const createdAt = finiteNumber(raw.createdAt);
  const deliverAt = finiteNumber(raw.deliverAt);
  if (
    source === undefined ||
    targetKey === undefined ||
    eventKey === undefined ||
    channelId === undefined ||
    createdAt === undefined ||
    deliverAt === undefined
  ) {
    return undefined;
  }
  const attempts = finiteNumber(raw.attempts);
  return {
    seq,
    source,
    targetKey,
    kind,
    eventKey,
    createdAt,
    deliverAt,
    channelId,
    attempts: attempts !== undefined && attempts >= 0 ? Math.floor(attempts) : 0,
  };
}

function sanitizeCounter(raw: unknown): DeliveryCounter | undefined {
  if (!isPlainObject(raw)) return undefined;
  const periodKey = boundedText(raw.periodKey, 64);
  const used = finiteNumber(raw.used);
  if (periodKey === undefined || used === undefined || used < 0) return undefined;
  return { periodKey, used: Math.floor(used) };
}

function sanitizeCounters(raw: unknown): Record<string, DeliveryCounter> {
  if (!isPlainObject(raw)) return {};
  const counters: Record<string, DeliveryCounter> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_DELIVERY_COUNTERS) break;
    // `__proto__` 是对象字面量的原型槽：脏 JSON 不得因此改写计数表的原型。
    if (key === '__proto__' || key.length > MAX_FIELD_CHARS * 2) continue;
    const counter = sanitizeCounter(value);
    if (counter === undefined) continue;
    counters[key] = counter;
    kept += 1;
  }
  return counters;
}

/**
 * 状态文档清洗。返回 `null` = 结构不可识别（版本不符 / 顶层不是对象），
 * 由读路径当空状态处理、写路径拒绝覆盖。
 *
 * 队列按 `seq` 升序重排（落盘顺序不是权威，`seq` 才是），超出上限按 `seq` 截断：
 * 丢掉的是最晚入队的条目，且**没有**占额之外的副作用。
 */
export function sanitizeDeliveryState(raw: unknown): DeliveryStateDoc | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== DELIVERY_STATE_VERSION) return null;
  const queue: QueuedDelivery[] = [];
  const rawQueue = raw.queue;
  if (Array.isArray(rawQueue)) {
    for (const item of rawQueue) {
      const queued = sanitizeQueuedDelivery(item);
      if (queued !== undefined) queue.push(queued);
    }
  }
  queue.sort((left, right) => left.seq - right.seq);
  const seen = new Set<number>();
  const deduped: QueuedDelivery[] = [];
  for (const item of queue) {
    if (seen.has(item.seq)) continue;
    seen.add(item.seq);
    if (deduped.length >= MAX_QUEUE_ITEMS) break;
    deduped.push(item);
  }
  return {
    version: DELIVERY_STATE_VERSION,
    queue: deduped,
    counters: sanitizeCounters(raw.counters),
  };
}

/** 落盘正文（紧凑 JSON + 换行）：状态文件不给手改，体积优先。 */
function serializeState(state: DeliveryStateDoc): string {
  return `${JSON.stringify({ version: DELIVERY_STATE_VERSION, queue: state.queue, counters: state.counters })}\n`;
}

export interface DeliveryStateStoreDeps {
  /** 状态文件绝对路径（见 `deliveryStatePath`）。 */
  path: string;
  logger?: DeliveryStateLogger;
}

/**
 * 状态文件的读写。
 *
 * 读：`ENOENT` → 空状态（可写）；读不懂 / 超过 1 MiB → 空状态 + 一次 warn + **毒化**
 * （写路径从此拒绝落盘）。
 * 写：同一路径串行，temp + `rename`，`0600`；序列化超限或已毒化一律抛 `DeliveryStateError`。
 */
export class DeliveryStateStore {
  private readonly filePath: string;
  private readonly logger: DeliveryStateLogger | undefined;
  /** 同路径串行链：只在状态文件写路径上串行，不阻塞投递本身。 */
  private tail: Promise<unknown> = Promise.resolve();
  private poison: string | undefined;
  private tempSeq = 0;

  constructor(deps: DeliveryStateStoreDeps) {
    if (typeof deps?.path !== 'string' || deps.path.trim() === '') {
      throw new TypeError('DeliveryStateStore: deps.path 必填');
    }
    this.filePath = deps.path;
    this.logger = deps.logger;
  }

  /** 状态文件路径。 */
  get path(): string {
    return this.filePath;
  }

  /** 写完不会被覆盖的原因（`undefined` = 可写）。 */
  get poisonReason(): string | undefined {
    return this.poison;
  }

  /** 读取状态；坏文件当空状态。返回的文档由调用方持有，可直接改。 */
  async load(): Promise<DeliveryStateDoc> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      // 还没建过 = 全新实例，可以写。
      if (errorCode(error) === 'ENOENT') return emptyDeliveryState();
      const detail = error instanceof Error ? error.message : String(error);
      this.poison = `${this.filePath} 读取失败：${detail}`;
      this.logger?.warn(
        `[Patchouli] 投递状态文件无法读取，本次按空队列运行（写入会被拒绝，请修复或删除该文件）：${this.poison}`,
      );
      return emptyDeliveryState();
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_STATE_BYTES) {
      this.poison = `${this.filePath} 体积 ${bytes} 字节超过上限 ${MAX_STATE_BYTES}`;
      this.logger?.warn(
        `[Patchouli] 投递状态文件过大（${bytes} > ${MAX_STATE_BYTES} 字节），本次按空队列运行（写入会被拒绝）：${this.filePath}`,
      );
      return emptyDeliveryState();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.poison = `${this.filePath} 不是合法 JSON`;
      this.logger?.warn(
        `[Patchouli] 投递状态文件不是合法 JSON，本次按空队列运行（写入会被拒绝，请修复或删除该文件）：${this.filePath}`,
      );
      return emptyDeliveryState();
    }
    const state = sanitizeDeliveryState(parsed);
    if (state === null) {
      this.poison = `${this.filePath} 结构不合法（version 应为 ${DELIVERY_STATE_VERSION}）`;
      this.logger?.warn(
        `[Patchouli] 投递状态文件结构不合法，本次按空队列运行（写入会被拒绝，请修复或删除该文件）：${this.filePath}`,
      );
      return emptyDeliveryState();
    }
    return state;
  }

  /** 该状态的序列化字节数（准入判断用，不落盘）。 */
  measure(state: DeliveryStateDoc): number {
    return Buffer.byteLength(serializeState(state), 'utf8');
  }

  /** 原子落盘。坏文件 / 超限一律抛错，文件字节保持原样。 */
  async save(state: DeliveryStateDoc): Promise<void> {
    const body = serializeState(state);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (this.poison !== undefined) {
      throw new DeliveryStateError(`${this.poison} —— 已拒绝写入（文件保持原样）`);
    }
    if (bytes > MAX_STATE_BYTES) {
      throw new DeliveryStateError(
        `投递状态序列化 ${bytes} 字节超过上限 ${MAX_STATE_BYTES}，已拒绝写入（先发掉队列里的积压）`,
      );
    }
    const target = this.filePath;
    this.tempSeq += 1;
    const temp = `${target}.${process.pid}.${this.tempSeq}.tmp`;
    const task = this.tail.then(async () => {
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      try {
        await fs.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, target);
        // `rename` 继承 temp 的模式；目标文件早先存在且权限更宽时补一次 chmod 兜住。
        // Windows 没有 POSIX 权限位，失败一律忽略。
        await fs.chmod(target, 0o600).catch((): undefined => undefined);
      } catch (error: unknown) {
        await fs.rm(temp, { force: true }).catch((): undefined => undefined);
        throw error;
      }
    });
    // 队列自身永不 reject：单次写失败不阻塞后续写。
    this.tail = task.then(
      (): undefined => undefined,
      (): undefined => undefined,
    );
    await task;
  }
}

/** `errno` 码读取（`ENOENT` 判定用）；非对象 / 无该字段一律 `undefined`。 */
function errorCode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return 'code' in value ? value.code : undefined;
}
