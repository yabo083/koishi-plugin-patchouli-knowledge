/**
 * 词条卡片的对外序号（**按群独立计数**）。
 *
 * 每个群一条独立自然数序列（1, 2, 3…），与词条 id 无关；同一个词条只在**首次渲染**
 * 时分配一次，之后重复出图沿用同一个号。
 *
 * 落盘 `<patchouliDir>/card-seq.json`：
 * ```json
 * { "version": 2, "channels": { "<channelId>": { "next": 3, "map": { "<entryId>": 1 } } } }
 * ```
 * 序号是**派生数据**：结构不符 / 文件损坏一律当空表重来（每个群重新从 1 数），
 * 不为历史格式留迁移分支——只有消息记录本身值得保。
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 单个群的序号序列。 */
interface ChannelSequence {
  /** 该群下一个可分配的自然数（从 1 开始）。 */
  next: number;
  /** 该群内「词条 id → 序号」。 */
  map: Record<string, number>;
}

interface SequenceFile {
  version: 2;
  channels: Record<string, ChannelSequence>;
}

export interface CardSequenceOptions {
  /** 序号文件路径；空串表示只做内存计数（测试 / 无盘场景）。 */
  file: string;
}

const EMPTY_FILE: SequenceFile = { version: 2, channels: {} };

/** 崩溃残留临时文件的年龄阈值：正常写盘是毫秒级，1 小时前的不可能是活跃写入。 */
const STALE_TEMP_MS = 60 * 60 * 1000;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1;
}

function readChannel(raw: unknown): ChannelSequence | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as { next?: unknown; map?: unknown };
  const next = isPositiveInteger(record.next) ? Math.floor(record.next) : 1;
  const map: Record<string, number> = {};
  if (typeof record.map === 'object' && record.map !== null) {
    for (const [key, value] of Object.entries(record.map)) {
      if (isPositiveInteger(value)) map[key] = Math.floor(value);
    }
  }
  return { next, map };
}

/**
 * 解析序号文件；结构不符或损坏一律返回空表，绝不抛。
 *
 * 只认当前结构——序号是派生数据，重新从 1 数没有代价。
 */
function parseSequence(raw: string): SequenceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 2, channels: {} };
  }
  if (typeof parsed !== 'object' || parsed === null) return { version: 2, channels: {} };
  const record = parsed as { version?: unknown; channels?: unknown };
  if (record.version !== 2 || typeof record.channels !== 'object' || record.channels === null) {
    return { version: 2, channels: {} };
  }
  const channels: Record<string, ChannelSequence> = {};
  for (const [channelId, value] of Object.entries(record.channels)) {
    const channel = readChannel(value);
    if (channel !== undefined) channels[channelId] = channel;
  }
  return { version: 2, channels };
}

/** 读取或初始化序号文件。 */
async function readSequence(file: string): Promise<SequenceFile> {
  if (file === '') return { version: 2, channels: {} };
  try {
    const state = parseSequence(await readFile(file, 'utf8'));
    return state;
  } catch {
    return { ...EMPTY_FILE, channels: {} };
  }
}

/** 原子落盘（先写临时文件再改名）。 */
async function writeSequence(file: string, state: SequenceFile): Promise<void> {
  if (file === '') return;
  const temp = `${file}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, JSON.stringify(state), 'utf8');
    await rename(temp, file);
  } catch {
    // 落盘失败只影响跨重启连续性，内存里的序号仍然有效。
  }
}

export class CardSequence {
  private readonly file: string;
  private loaded: Promise<SequenceFile> | undefined;
  /** 串行化：所有分配排队执行，避免读-改-写互相覆盖。 */
  private chain: Promise<unknown> = Promise.resolve();

  public constructor(options: CardSequenceOptions) {
    this.file = options.file;
  }

  /** 读取当前映射（不分配）；返回「群 → { 词条 → 序号 }」的浅拷贝。 */
  public async snapshot(): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>> {
    const state = await this.load();
    const result: Record<string, Readonly<Record<string, number>>> = {};
    for (const [channelId, channel] of Object.entries(state.channels)) result[channelId] = { ...channel.map };
    return result;
  }

  /** 某群当前的下一个序号（观测用；不存在时返回 1）。 */
  public async nextOf(channelId: string): Promise<number> {
    const state = await this.load();
    return state.channels[channelId]?.next ?? 1;
  }

  /**
   * 取该词条在**所属群**里的序号；首次出现时分配该群的下一个自然数并落盘。
   *
   * 已经分配过的词条（含旧版迁移过来的）无论传入哪个群都返回原号；
   * 同一 id 并发调用只会拿到同一个号。
   */
  public async allocate(entryId: string, channelId: string): Promise<number> {
    const run = async (): Promise<number> => {
      const state = await this.load();
      const key = channelId.trim();

      // 已有号直接沿用（同群内同一词条恒同号）。
      for (const channel of Object.values(state.channels)) {
        const existing = channel.map[entryId];
        if (existing !== undefined) return existing;
      }

      const channel = state.channels[key] ?? { next: 1, map: {} };
      const assigned = channel.next;
      channel.next = assigned + 1;
      channel.map[entryId] = assigned;
      state.channels[key] = channel;
      await writeSequence(this.file, state);
      return assigned;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<SequenceFile> {
    this.loaded ??= this.loadOnce();
    return this.loaded;
  }

  /**
   * 首次读取：先回收崩溃残留的 `.tmp`，再读（失败一律当空表）。
   *
   * `writeSequence` 是先写 `${file}.tmp` 再改名；进程死在两步之间会留下孤儿文件。
   * 以**年龄**而不是存在性判断：本进程正在写的临时文件年龄必然是毫秒级。
   */
  private async loadOnce(): Promise<SequenceFile> {
    if (this.file !== '') {
      const temp = `${this.file}.tmp`;
      try {
        if (Date.now() - (await stat(temp)).mtimeMs >= STALE_TEMP_MS) await rm(temp, { force: true });
      } catch {
        // 不存在或不可读：无需清理。
      }
    }
    return readSequence(this.file);
  }
}

/** 词条序号文件的默认路径（相对 `.patchouli/`）。 */
export const CARD_SEQ_FILE_NAME = 'card-seq.json';

/** 由插件私有目录推出序号文件路径（纯路径运算）。 */
export function cardSequencePath(patchouliDir: string): string {
  return join(patchouliDir, CARD_SEQ_FILE_NAME);
}
