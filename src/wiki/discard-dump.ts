/**
 * Patchouli Knowledge — 丢弃轮次留证（Discard Dump）
 *
 * 存在理由：`discardReason` / `qualityScore` 是**模型自评**，落盘前无法复核。
 * 只留一行日志时，「这轮讨论确实没料」与「判据过严误杀」在事后完全不可区分——
 * 这正是「跑了一整天却零沉淀」无法归因的根因。本模块把被丢弃轮次的消息全集
 * 连同判定依据一起落到 `.patchouli/discards/<date>-<sessionId>.json`。
 *
 * 与 llmwiki 真理源的分工：`raw/sessions/` 按 llmwiki 契约只收编已成词条的轮次；
 * 丢弃轮次属于插件私有排障证据，因此落在 `.patchouli/` 下，**允许轮转删除**。
 *
 * 空间保证（硬约束，不是建议值）：
 *  - 份数上限 `DISCARD_DUMP_LIMIT`（40）、目录字节预算 `DISCARD_DUMP_MAX_BYTES`（8 MiB）双限；
 *  - 单条消息内容按 `DISCARD_MESSAGE_MAX_CHARS`（2000 字）截断；
 *  - 至少保留最新一份（哪怕它自身就超预算），否则排障证据会归零。
 *  - 目录**懒创建**：关闭开关的实例不会留下任何空目录。
 *
 * 三种丢弃来源（`kind`）：
 *  - `MODEL`   —— 模型明确判定不值得沉淀，带 `discardReason` + `qualityScore`；
 *  - `FLOOR`   —— 未调用模型，缓冲条数低于 `minDiscussionMessages`（L-01 冷群保护）；
 *  - `FAILURE` —— 运行时失败（模型 / 网络 / 输出不可解析），与「判定为噪声」严格区分。
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as nodePath from 'node:path';

import type { DiscardReason, DiscussionSession } from '../types';
import { formatDate, toRawSessionDocument } from './engine';
import type { RawSessionDocument } from './engine';

/** 留证文件的默认保留个数（超出按写入时间滚动删除，最旧的先删）。 */
export const DISCARD_DUMP_LIMIT = 40;

/**
 * 留证目录的默认字节预算：8 MiB。
 *
 * 只按份数限流不够——单份留证的最坏体积是 `maxBufferMessages`（默认 500）× 单条消息长度，
 * 转发/长文场景可以到 MB 级。份数与字节数必须双限，且**至少保留最新一份**（哪怕它自己就超预算）。
 */
export const DISCARD_DUMP_MAX_BYTES = 8 * 1024 * 1024;

/** 单条消息内容的落盘截断长度：留证只需要判断"有没有料"，不需要全文。 */
export const DISCARD_MESSAGE_MAX_CHARS = 2000;

/**
 * 丢弃来源枚举。
 *
 * - `MODEL`：云端模型判废；
 * - `FLOOR`：缓冲不足，根本没调到模型；
 * - `FAILURE`：运行时失败（网络 / 解析）；
 * - `GATE`：调度质量门（`trigger.dispatchMargin`）在调用模型前短路——峰值勉强过阈。
 */
export type DiscardKind = 'MODEL' | 'FLOOR' | 'FAILURE' | 'GATE';

/** 一轮讨论被丢弃的判定依据。 */
export interface DiscardVerdict {
  kind: DiscardKind;
  /** 仅 `MODEL` 有值：模型给出的结构化归因。 */
  discardReason?: DiscardReason | null;
  /** 知识密度评分；`FLOOR` 无值，`GATE` 为门限比较用的峰值质量。 */
  qualityScore?: number;
  /** 仅 `FAILURE` 有值：人类可读的失败说明。 */
  failureReason?: string;
  /** 仅 `FLOOR` 有值：本轮生效的沉淀条数下限。 */
  minDiscussionMessages?: number;
  /** 本轮调度实际消耗的 token 总数（多次契约重试累加）。 */
  tokensUsed?: number;
  /** 因契约校验未通过而追加的重试次数（0 / 缺省 = 一次即过）。 */
  contractRetries?: number;
}

/** 留证文档：与 `raw/sessions/*.json` 同构，外加 `verdict` 段落。 */
export interface DiscardDumpDocument extends RawSessionDocument {
  verdict: DiscardVerdict & { recordedAt: number };
}

/** 留证的保留策略：份数、字节、单条内容长度三重限流。 */
export interface DiscardRetention {
  /** 最多保留的份数，默认 `DISCARD_DUMP_LIMIT`。 */
  limit?: number;
  /** 目录总字节预算，默认 `DISCARD_DUMP_MAX_BYTES`；至少保留最新一份。 */
  maxBytes?: number;
  /** 单条消息落盘截断长度，默认 `DISCARD_MESSAGE_MAX_CHARS`；`0` 表示不截断。 */
  maxMessageChars?: number;
}

export interface SaveDiscardDumpOptions extends DiscardRetention {
  /** `.patchouli/discards/` 绝对路径。 */
  dir: string;
  session: DiscussionSession;
  verdict: DiscardVerdict;
  /** 可注入时钟（默认 `Date.now`），用于 `recordedAt` 与文件名日期。 */
  now?: () => number;
}

export interface SaveDiscardDumpResult {
  /** 本次写入的绝对路径。 */
  path: string;
  /** 因超出保留策略而被删除的绝对路径（旧的在前）。 */
  pruned: string[];
}

/** 推导留证文件名（不含扩展名）：`<YYYY-MM-DD>-<sessionId>`。 */
export function discardDumpName(session: DiscussionSession, nowMs: number): string {
  const at = Number.isFinite(session.startTime) && session.startTime > 0 ? session.startTime : nowMs;
  const stamp = formatDate(new Date(at));
  // 文件名必须剥掉 NTFS 非法字符：`floor-<channelId>-<ts>` 里的 `:` 在 Windows 上会写进
  // 备用数据流（目录里看不到 `.json`），导致留证永不轮转、字节统计恒为 0。
  const id = String(session.sessionId ?? '').trim().replace(/[\\/:*?"<>|\s]+/gu, '_') || 'session';
  return `${stamp}-${id}`;
}

/**
 * 写入一份丢弃留证并按保留策略轮转。文件名含 UUID，冲突实际不存在；
 * 重复写同名文件会整体替换，属幂等语义。
 */
export async function saveDiscardDump(options: SaveDiscardDumpOptions): Promise<SaveDiscardDumpResult> {
  const { dir, session, verdict } = options;
  const now = options.now ?? Date.now;
  const recordedAt = now();
  const name = discardDumpName(session, recordedAt);
  const document: DiscardDumpDocument = {
    ...toRawSessionDocument(session, name),
    verdict: { ...verdict, recordedAt },
  };
  clampMessageContents(document, options.maxMessageChars ?? DISCARD_MESSAGE_MAX_CHARS);

  // 写入前按字节预算再压一次单条正文：`maxMessageChars` 只按条数截断，
  // 2000 条 × 2000 字实测可达 28MiB，单份就击穿整个目录预算（文件头写明的硬约束）。
  const budget = options.maxBytes ?? 0;
  let payload = `${JSON.stringify(document, null, 2)}\n`;
  if (budget > 0 && Buffer.byteLength(payload) > budget) {
    const perMessage = Math.max(64, Math.floor(budget / Math.max(1, document.messages.length * 4)));
    clampMessageContents(document, Math.min(options.maxMessageChars ?? DISCARD_MESSAGE_MAX_CHARS, perMessage));
    payload = `${JSON.stringify(document, null, 2)}\n`;
  }

  await fs.mkdir(dir, { recursive: true });
  const path = nodePath.join(dir, `${name}.json`);
  await fs.writeFile(path, payload, 'utf8');
  const pruned = await pruneDiscardDumps(dir, { limit: options.limit, maxBytes: options.maxBytes });
  return { path, pruned };
}

/** 读取一份留证（测试与排障用；解析失败抛错）。 */
export async function readDiscardDump(path: string): Promise<DiscardDumpDocument> {
  const text = await fs.readFile(path, 'utf8');
  return JSON.parse(text) as DiscardDumpDocument;
}

/** 列出留证文件的绝对路径，按写入时间升序（最旧在前）。 */
export async function listDiscardDumps(dir: string): Promise<string[]> {
  const files = await listDiscardFiles(dir);
  return files.map((file) => file.path);
}

/**
 * 按保留策略滚动删除：先满足份数上限，再满足字节预算，**至少保留最新一份**。
 * 返回被删除的路径（旧的在前）。目录不存在视为空目录，不抛错。
 */
export async function pruneDiscardDumps(
  dir: string,
  retention: Pick<DiscardRetention, 'limit' | 'maxBytes'> = {},
): Promise<string[]> {
  const limit = Math.max(1, Math.floor(retention.limit ?? DISCARD_DUMP_LIMIT));
  const maxBytes = Math.max(0, Math.floor(retention.maxBytes ?? DISCARD_DUMP_MAX_BYTES));
  const files = await listDiscardFiles(dir);

  const doomed: DiscardFile[] = [];
  let kept = 0;
  let bytes = 0;
  // 从最新往旧扫：先满足预算，才能保证留下的是"最近的证据"。
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i];
    const withinCount = kept + 1 <= limit;
    const withinBytes = kept === 0 || bytes + file.size <= maxBytes;
    if (withinCount && withinBytes) {
      kept += 1;
      bytes += file.size;
    } else {
      doomed.push(file);
    }
  }

  const pruned: string[] = [];
  for (const file of doomed.reverse()) {
    try {
      await fs.unlink(file.path);
      pruned.push(file.path);
    } catch (error) {
      if (!isMissingDirError(error)) throw error;
    }
  }
  return pruned;
}

interface DiscardFile {
  path: string;
  mtimeMs: number;
  size: number;
}

async function listDiscardFiles(dir: string): Promise<DiscardFile[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirError(error)) return [];
    throw error;
  }
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const path = nodePath.join(dir, entry.name);
        const stat = await fs.stat(path);
        return { path, mtimeMs: stat.mtimeMs, size: stat.size };
      }),
  );
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 按码点截断单条消息内容，超出以 `…` 收尾（文档是排障证据，不是全文存档）。 */
function clampMessageContents(document: RawSessionDocument, maxChars: number): void {
  const limit = Math.floor(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return;
  for (const message of document.messages) {
    const chars = [...message.content];
    if (chars.length > limit) {
      message.content = `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`;
    }
  }
}

function isMissingDirError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = error.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
