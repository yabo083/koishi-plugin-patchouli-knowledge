/**
 * Patchouli Knowledge — 主动书记员持久化（§7.2 / §7.5.9）
 *
 * 录制中的群每来一条消息就**追加**一行到 `<wikiDir>/.patchouli/scribe/<channelId>.jsonl`，
 * 进程重启后据此把会话原样交回触发器（`restoreManualSession`）。三条硬约束：
 *
 *  1. **只追加**：`appendFile` 语义，绝不重写既有行；一条消息对应一行 JSON，行内不含 `raw`
 *     （Koishi 事件对象绝不落盘），`content` 按码点截断到 2000 字，与丢弃留证同口径。
 *  2. **串行写**：同一实例的写入 / 删除走单条 Promise 队列，并发消息不会互相覆盖；
 *     目录懒创建，从未录制过的实例不留空目录（与 `discards/` 同策略）。
 *  3. **绝不丢用户数据**：恢复时解析失败的文件**原样保留**并告警，只删除「不足 2 条」的
 *     无意义残file；写入 / 删除失败一律降级为告警，不阻塞消息主流程。
 *
 * 与消息行并排维护 `<channelId>.meta.json`（`ScribeMeta`）：记录**已交付水位**
 * （`deliveredUpTo = detector.lastSettledTime`）与话题提示。软切片 / 边界切分交付过的
 * 消息仍留在 jsonl 里（只追加，绝不重写），水位是唯一的去重依据——否则重启后
 * `rec off` 会把已经交付的片段再交一次。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

import type { ChatMessage } from '../types';
import type { BurstQuiescenceDetector } from '../trigger/detector';

/** 单条内容落盘截断长度（码点）：与 `DISCARD_MESSAGE_MAX_CHARS` 同口径。 */
export const SCRIBE_MESSAGE_MAX_CHARS = 2000;

/** 单群录制文件的字节上限（手动录制只受 2h 熔断约束，jsonl 只追加不轮转）。 */
export const SCRIBE_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** 恢复并交付所需的最低条数：与 `MANUAL_SESSION_MIN_MESSAGES` 一致，不足即视为残留。 */
export const SCRIBE_MIN_RESTORE_MESSAGES = 2;

/** 书记员日志面（结构兼容 Koishi Logger 与插件内部的 `PluginLogger`）。 */
export interface ScribeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

/** 一行录制记录：字段与 `ChatMessage` 同名，缺 `raw`。 */
export interface ScribeRecord {
  id: string;
  channelId: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: number;
}

export interface ScribeStoreOptions {
  /** `.patchouli/scribe/` 绝对路径。 */
  dir: string;
  logger?: ScribeLogger;
}

/** 单次恢复的结局：恢复成功的群、被删的残留、因损坏而原样保留的文件。 */
export interface ScribeRestoreResult {
  restored: Array<{ channelId: string; count: number; deliveredUpTo: number }>;
  discarded: string[];
  kept: string[];
}

/**
 * 与消息行并排的会话元数据：已交付水位。
 *
 * 只有真的产生过交付（软切片 / 边界切分）时才会落盘；`deliveredUpTo = 0`
 * 的缺省状态不写文件（缺省即 0）。
 */
export interface ScribeMeta {
  /** 已交付的最后一条消息时间戳（`detector.lastSettledTime`）；0 表示尚无交付。 */
  deliveredUpTo: number;
  /** 落盘时刻（epoch 毫秒），仅供排障。 */
  updatedAt: number;
}

export interface ScribeRestoreOptions {
  dir: string;
  detector: Pick<BurstQuiescenceDetector, 'restoreManualSession'>;
  logger?: ScribeLogger;
}

/**
 * 按码点截断消息内容，超出以 `…` 收尾并保证总长不超过上限（代理对不会被劈开）。
 * 与 `src/wiki/discard-dump.ts` 的 `clampMessageContents` 同一口径。
 */
export function clampScribeContent(content: string, maxChars: number = SCRIBE_MESSAGE_MAX_CHARS): string {
  const limit = Math.floor(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  const chars = [...content];
  if (chars.length <= limit) return content;
  return `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/** 由群号推导记录文件名：只保留文件名安全字符（群号通常纯数字，跨平台前缀才会带 `:`）。 */
export function scribeFilePath(dir: string, channelId: string): string {
  return nodePath.join(dir, `${toChannelFileStem(channelId)}.jsonl`);
}

/** 与 `scribeFilePath` 同族的元数据文件路径：`<channelId>.meta.json`。 */
export function scribeMetaPath(dir: string, channelId: string): string {
  return nodePath.join(dir, `${toChannelFileStem(channelId)}.meta.json`);
}

/** 记录文件名主干：群号里只有文件名不安全字符会被替换。 */
function toChannelFileStem(channelId: string): string {
  return channelId.replace(/[\\/:*?"<>|\s]/gu, '_');
}

/** 把一条消息转成落盘记录（纯函数，便于测试口径）。 */
export function toScribeRecord(msg: ChatMessage, maxChars: number = SCRIBE_MESSAGE_MAX_CHARS): ScribeRecord {
  return {
    id: msg.id,
    channelId: msg.channelId,
    userId: msg.userId,
    userName: msg.userName,
    content: clampScribeContent(msg.content, maxChars),
    timestamp: msg.timestamp,
  };
}

/**
 * 读取配置里的管理员白名单（`adminUsers`）。
 *
 * 配置对象来自 Koishi 反序列化，字段可能缺失或类型不符：一律按 unknown 守卫，
 * 缺省 / 非数组 / 混合类型都只取其中的非空字符串。**空数组 = fail closed**。
 */
export function resolveAdminUsers(config: unknown): string[] {
  const record = asRecord(config);
  const raw = record?.adminUsers;
  if (!Array.isArray(raw)) return [];
  const users: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '' && !users.includes(trimmed)) users.push(trimmed);
  }
  return users;
}

/** 指令侧的权限判定：白名单为空时任何人都不通过。 */
export function isScribeAdmin(config: unknown, userId: string | undefined): boolean {
  if (typeof userId !== 'string' || userId.trim() === '') return false;
  return resolveAdminUsers(config).includes(userId.trim());
}

/**
 * 单群录制存储：追加写 + 幂等删除，写入串行化。
 *
 * 实例内部记住「本进程已写过记录的群」，用于熔断结算后清理文件：
 * 只有真正落过盘的群才会在「已不在录制」的第一条消息上尝试删除，
 * 避免对每个非录制群消息都发一次 `unlink`。
 */
export class ScribeStore {
  private readonly dir: string;
  private readonly logger?: ScribeLogger;
  private readonly recordedChannels = new Set<string>();
  /**
   * 每群最后一次真正落盘的元数据内容。水位只在交付时前进，
   * 因而绝大多数消息不需要重写 meta（省掉一半 syscall），但不能省第一次写入。
   */
  private readonly persistedMeta = new Map<string, { deliveredUpTo: number }>();
  /** 每个录制文件当前字节数（append 时维护；首次访问用 stat 初始化）。 */
  private readonly fileSizes = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ScribeStoreOptions) {
    this.dir = nodePath.resolve(options.dir);
    this.logger = options.logger;
  }

  /** 录制目录绝对路径。 */
  get directory(): string {
    return this.dir;
  }

  /** 某群的记录文件路径。 */
  pathFor(channelId: string): string {
    return scribeFilePath(this.dir, channelId);
  }

  /** 某群的元数据（已交付水位 + 话题提示）文件路径。 */
  metaPathFor(channelId: string): string {
    return scribeMetaPath(this.dir, channelId);
  }

  /**
   * 追加一条消息，并把该群**已交付水位**一并写入 meta。
   *
   * 返回 `true` 表示消息行已落盘；IO 异常只告警并返回 `false`——录制是可观测能力，
   * 绝不能把消息主流程拖进异常。并发调用按到达顺序串行，不会互相覆盖。
   * 水位写失败只降级为告警：最坏后果是重启后多恢复一段（重复交付），绝不丢消息。
   *
   * `deliveredUpTo` 必须是**原始消息时间戳域**（被交付片段的 endTime）。调用方若传入
   * 逻辑时间/墙钟以外的时钟，恢复时的 `message.timestamp > deliveredUpTo` 比较会失效。
   */
  append(
    msg: ChatMessage,
    maxChars: number = SCRIBE_MESSAGE_MAX_CHARS,
    deliveredUpTo = 0,
  ): Promise<boolean> {
    this.recordedChannels.add(msg.channelId);
    const channelId = msg.channelId;
    const line = `${JSON.stringify(toScribeRecord(msg, maxChars))}\n`;
    const path = this.pathFor(channelId);
    return this.serialize(async () => {
      try {
        await fs.mkdir(this.dir, { recursive: true });
        // 单群录制文件必须有字节上界：录制只受 2h 熔断约束，jsonl 只追加不轮转。
        const known =
          this.fileSizes.get(path) ?? (await fs.stat(path).then((info) => info.size).catch(() => 0));
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (known + lineBytes > SCRIBE_FILE_MAX_BYTES) {
          this.logger?.warn(
            `[Patchouli] 主动书记员文件已达上限，暂停录制（群 ${channelId}，${known} 字节）；原件保留`,
          );
          this.fileSizes.set(path, known);
          return false;
        }
        await fs.appendFile(path, line, 'utf8');
        this.fileSizes.set(path, known + lineBytes);
      } catch (error) {
        this.logger?.warn(`[Patchouli] 主动书记员写入失败（群 ${channelId}）: ${describeError(error)}`);
        return false;
      }
      await this.persistMeta(channelId, deliveredUpTo);
      return true;
    });
  }

  /**
   * 删除某群的记录文件与元数据（`logoff` 成功、熔断结算后调用）。
   *
   * 幂等：记录文件不存在返回 `false`，不抛错；其它删除失败只告警。
   */
  remove(channelId: string): Promise<boolean> {
    this.fileSizes.delete(this.pathFor(channelId));
    this.recordedChannels.delete(channelId);
    this.persistedMeta.delete(channelId);
    const path = this.pathFor(channelId);
    const metaPath = this.metaPathFor(channelId);
    return this.serialize(async () => {
      const removed = await unlinkQuietly(path, this.logger, `群 ${channelId} 记录`);
      await unlinkQuietly(metaPath, this.logger, `群 ${channelId} 水位`);
      return removed;
    });
  }

  /**
   * 消息到达时的唯一入口：录制中则追加（并刷新已交付水位）；已不在录制但本进程写过，
   * 则清理残留文件。不抛错、不阻塞调用方（`void` 掉即可）。
   */
  async syncMessage(msg: ChatMessage, recording: boolean, deliveredUpTo = 0): Promise<void> {
    if (recording) {
      await this.append(msg, SCRIBE_MESSAGE_MAX_CHARS, deliveredUpTo);
      return;
    }
    if (!this.recordedChannels.has(msg.channelId)) return;
    await this.remove(msg.channelId);
  }

  /**
   * 把磁盘上的水位灌回内存表（启动恢复后调用）。
   *
   * `persistedMeta` 是「磁盘水位」的内存镜像，但它在启动时是空的；不灌回就会在
   * 「磁盘有旧水位、内存无记录」时跳过写盘，让两者永久分叉。
   */
  hydrateMeta(channelId: string, deliveredUpTo: number): void {
    if (this.persistedMeta.has(channelId)) return;
    if (!Number.isFinite(deliveredUpTo) || deliveredUpTo <= 0) return;
    this.persistedMeta.set(channelId, { deliveredUpTo });
  }

  /**
   * 写 meta：内容与上次落盘一致则跳过，缺省状态（水位 0）不落文件。
   * 水位单调：内存里更旧的值绝不会覆盖磁盘上的新值。
   */
  private async persistMeta(channelId: string, deliveredUpTo: number): Promise<void> {
    const previous = this.persistedMeta.get(channelId);
    const requested = Number.isFinite(deliveredUpTo) ? Math.max(0, deliveredUpTo) : 0;
    const watermark = Math.max(previous?.deliveredUpTo ?? 0, requested);
    if (previous !== undefined && previous.deliveredUpTo === watermark) {
      return;
    }
    if (previous === undefined && watermark === 0) {
      return;
    }
    const meta: ScribeMeta = { deliveredUpTo: watermark, updatedAt: Date.now() };
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.metaPathFor(channelId), `${JSON.stringify(meta)}\n`, 'utf8');
      this.persistedMeta.set(channelId, { deliveredUpTo: watermark });
    } catch (error) {
      this.logger?.warn(`[Patchouli] 主动书记员水位写入失败（群 ${channelId}）: ${describeError(error)}`);
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(noop, noop);
    return run;
  }
}

/**
 * 启动恢复：扫描记录目录，把仍在进行中的会话交回触发器。
 *
 *  - 先按 `<channelId>.meta.json` 的 `deliveredUpTo` 过滤掉**已交付**的行（软切片 / 边界切分
 *    交付过的消息仍留在 jsonl 里），只装载未交付部分；
 *  - 未交付 `>= 2` 条：`detector.restoreManualSession(channelId, pending, deliveredUpTo)`，
 *    不改写文件；
 *  - 未交付不足 2 条（含完全交付、空文件）：删 jsonl 与 meta——已交付的记录没有恢复价值，
 *    留着只会让每次启动都重复扫描；这与「不足 2 条视为残留」的既有口径一致；
 *  - 任一行解析失败 / 记录不自洽：**保留文件**、告警、不恢复（绝不丢用户数据）。
 *
 * 永不抛错：目录缺失视为空目录，单文件异常只影响该文件。
 */
export async function restoreScribeSessions(options: ScribeRestoreOptions): Promise<ScribeRestoreResult> {
  const result: ScribeRestoreResult = { restored: [], discarded: [], kept: [] };
  let names: string[];
  try {
    const dirents = await fs.readdir(options.dir, { withFileTypes: true });
    names = dirents.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (!isMissingFileError(error)) {
      options.logger?.warn(`[Patchouli] 主动书记员恢复扫描失败: ${describeError(error)}`);
    }
    return result;
  }

  const dataFiles = names.filter((name) => name.endsWith('.jsonl')).sort();
  for (const name of dataFiles) {
    const path = nodePath.join(options.dir, name);
    // 与 jsonl 同干名的 meta：文件名一一对应，不依赖内容里的 channelId（损坏文件也有水位）。
    const metaPath = nodePath.join(options.dir, `${name.slice(0, -'.jsonl'.length)}.meta.json`);
    let messages: ChatMessage[];
    try {
      messages = await readScribeFile(path);
    } catch (error) {
      options.logger?.warn(`[Patchouli] 主动书记员记录损坏，保留文件不恢复: ${path}（${describeError(error)}）`);
      result.kept.push(path);
      continue;
    }

    const meta = await readScribeMeta(metaPath, options.logger);
    const deliveredUpTo = meta?.deliveredUpTo ?? 0;
    const pending = messages.filter((message) => message.timestamp > deliveredUpTo);
    if (pending.length < SCRIBE_MIN_RESTORE_MESSAGES) {
      await unlinkQuietly(path, options.logger, '主动书记员残留');
      await unlinkQuietly(metaPath, options.logger, '主动书记员残留水位');
      result.discarded.push(path);
      continue;
    }

    const channelId = pending[0].channelId;
    options.detector.restoreManualSession(channelId, pending, deliveredUpTo);
    options.logger?.info(`[Patchouli] 已恢复主动书记员会话: 群 ${channelId}，${pending.length} 条消息`);
    result.restored.push({ channelId, count: pending.length, deliveredUpTo });
  }

  // 孤立 meta（对应 jsonl 已不存在）只描述「已交付到哪里」，没有可恢复内容，顺手清掉。
  const dataStems = new Set(dataFiles.map((name) => name.slice(0, -'.jsonl'.length)));
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    if (dataStems.has(name.slice(0, -'.meta.json'.length))) continue;
    await unlinkQuietly(nodePath.join(options.dir, name), options.logger, '主动书记员孤立水位');
  }
  return result;
}

/**
 * 读取水位文件：缺失 / 内容非法一律视为「尚未交付」，绝不阻断恢复
 * （最坏后果是重复交付一段已切片的会话，而不是丢消息或启动失败）。
 */
async function readScribeMeta(path: string, logger?: ScribeLogger): Promise<ScribeMeta | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) {
      logger?.warn(`[Patchouli] 主动书记员水位读取失败: ${path}（${describeError(error)}）`);
    }
    return undefined;
  }
  try {
    const record = asRecord(JSON.parse(text));
    if (record === undefined) throw new Error('不是对象');
    const deliveredUpTo = record.deliveredUpTo;
    if (typeof deliveredUpTo !== 'number' || !Number.isFinite(deliveredUpTo) || deliveredUpTo < 0) {
      throw new Error('deliveredUpTo 不是非负有限数值');
    }
    const rawUpdatedAt = record.updatedAt;
    const meta: ScribeMeta = {
      deliveredUpTo,
      updatedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0,
    };
    return meta;
  } catch (error) {
    logger?.warn(`[Patchouli] 主动书记员水位文件损坏，按「尚未交付」处理: ${path}（${describeError(error)}）`);
    return undefined;
  }
}

/** 读取一个记录文件；任一行损坏 / 记录不自洽即整体抛错（调用方保留文件）。 */
async function readScribeFile(path: string): Promise<ChatMessage[]> {
  const text = await fs.readFile(path, 'utf8');
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '');
  const messages: ChatMessage[] = [];
  let channelId: string | undefined;
  for (const [index, line] of lines.entries()) {
    const record = parseScribeRecord(line, index);
    if (channelId === undefined) {
      channelId = record.channelId;
    } else if (record.channelId !== channelId) {
      throw new Error(`第 ${index + 1} 行的群号与首行不一致`);
    }
    messages.push({
      id: record.id,
      channelId: record.channelId,
      userId: record.userId,
      userName: record.userName,
      content: record.content,
      timestamp: record.timestamp,
    });
  }
  return messages;
}

function parseScribeRecord(line: string, index: number): ScribeRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`第 ${index + 1} 行不是合法 JSON: ${describeError(error)}`);
  }
  const record = asRecord(parsed);
  if (record === undefined) throw new Error(`第 ${index + 1} 行不是对象`);
  const id = requireString(record.id, index, 'id');
  const channelId = requireString(record.channelId, index, 'channelId');
  const userId = requireString(record.userId, index, 'userId');
  const userName = requireString(record.userName, index, 'userName');
  if (typeof record.content !== 'string') throw new Error(`第 ${index + 1} 行 content 不是字符串`);
  if (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) {
    throw new Error(`第 ${index + 1} 行 timestamp 不是有限数值`);
  }
  return { id, channelId, userId, userName, content: record.content, timestamp: record.timestamp };
}

function requireString(value: unknown, index: number, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`第 ${index + 1} 行 ${field} 不是非空字符串`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isMissingFileError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = error.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** 删除单个文件：不存在视为成功；其它失败只告警（`label` 只用于日志可读性）。 */
async function unlinkQuietly(path: string, logger?: ScribeLogger, label = '记录'): Promise<boolean> {
  try {
    await fs.unlink(path);
    return true;
  } catch (error) {
    if (!isMissingFileError(error)) {
      logger?.warn(`[Patchouli] 主动书记员${label}删除失败: ${path}（${describeError(error)}）`);
    }
    return false;
  }
}

/**
 * `rec on` 的范围前置校验：返回拒绝理由（人类可读），可用时返回 `undefined`。
 *
 * 书记员只能录「本插件真的会观测到」的群：插件停用或该群不在 `channels` 白名单（且白名单非空）
 * 时，`ctx.intersect` 会把消息全部过滤掉，录制必然空转却仍回复「已开启」——必须在开启前拒绝。
 * 私聊不在此列（由调用方直接拒绝）：消息监听本身只覆盖群聊。
 */
export function scribeScopeRefusal(config: unknown, channelId: string): string | undefined {
  const record = asRecord(config);
  if (record?.enabled === false) {
    return '[PATCHOULI] 插件当前已停用（enabled = false），消息监听不工作，录制只会一直为空。请先启用插件。';
  }
  const rawChannels = record?.channels;
  // 与 `channelScope` 逐字同口径：非空数组即白名单，空数组才表示「监听全部群」。
  // 不做 trim 过滤——`['']` 在白名单语义下是「只监听空群号」（等于谁都不监听），
  // 若在这里当成空数组放行，就会重演「回复已开启但永远录不到消息」。
  const channels = Array.isArray(rawChannels)
    ? rawChannels.filter((value): value is string => typeof value === 'string')
    : [];
  if (channels.length > 0 && !channels.includes(channelId)) {
    return (
      `[PATCHOULI] 本群 ${channelId} 不在 channels 白名单内：插件不监听此群消息，无法录制。` +
      '请把群号加入 channels 或清空白名单后再试。'
    );
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noop(): void {
  // 队列尾部只用于排序，不需要返回值。
}
