/**
 * Patchouli Knowledge — L0 词汇凝聚话题边界标注器 (Lexical Boundary Annotator)
 *
 * 职责（roadmap §4.1 / §4.2 L0 行）：
 *  - TextTiling 风格滑窗：连续 blockSize 条消息并块，块特征为成员字符 2-gram 集合的并集；
 *  - 相邻块以 Dice 系数度量词汇重合度，在落差序列上找局部极小作为候选切点；
 *  - 输出带时间戳的边界事实 `{ at, score }`，只标注、不切分、不碰相位。
 *
 * 设计约束：
 *  - 纯确定性、可重放、微秒级：纯内存、零 I/O、零依赖（仅复用 filter.ts 的 stripMessageMarkup）；
 *  - 流式（LexicalBoundaryDetector.push）与批量（detectBoundaries）语义逐位一致：
 *    候选点 i 只有在第 i+2 块填满后才「定格」上报——此后无论再收到多少消息，
 *    判定结果都不再改变，保证同一输入下两种消费方式产出完全相同的候选序列；
 *  - 严格 TypeScript，禁止 any；非法参数直接抛 RangeError。
 */

import { stripMessageMarkup } from './filter';

/** 默认块大小：连续 5 条消息为一个词汇块。 */
export const DEFAULT_BOUNDARY_BLOCK_SIZE = 5;

/** 默认落差阈值：左侧重合度相对候选点至少下跌该值才上报。 */
export const DEFAULT_BOUNDARY_DROP_RATIO = 0.35;

/** 默认绝对上限：候选点重合度高于该值说明两侧仍是同一词域，不报点。 */
export const DEFAULT_BOUNDARY_ABSOLUTE_MAX = 0.25;

/**
 * 流式上报的去重窗口容量。
 *
 * 候选点的 `at` 取块首消息时间戳，而块按到达顺序封存，因此 `at` 单调不减 ——
 * 「同一个 `at` 被重复定格」只可能发生在相邻若干块之间。容量受限的滑窗与全量
 * `Set` 判定等价，却不会随群生命周期无界增长（旧的 `Set` 只有 `reset()` 才清空）。
 */
const REPORTED_AT_WINDOW = 8;

/** 实质字符：字母 / 数字 / 组合记号；表情、标点、空白一律剔除。 */
const SIGNIFICANT_CHAR_PATTERN = /[\p{L}\p{N}\p{M}]/u;

/** 参与边界判定的消息条目。 */
export interface BoundaryMessage {
  /** 消息标识（调用方用于去重与回溯，判定本身不依赖）。 */
  id: string;
  /** 原始消息文本（可含 CQ 码 / Satori 标签，内部统一剥离）。 */
  text: string;
  /** 消息时间戳（毫秒），候选点的 `at` 直接取自切点右侧块的首条消息。 */
  at: number;
}

/** L0 上报的候选切点：时刻 + 落差强度。 */
export interface BoundaryCandidate {
  /** 切点时刻：第 i+1 块首条消息的时间戳。 */
  at: number;
  /** 落差强度 = depth[i-1] - depth[i]，越大说明两侧词域断裂越明显。 */
  score: number;
}

/** L0 判定参数；非法取值（非有限数、越界、非整数）抛 RangeError。 */
export interface BoundaryDetectorOptions {
  /** 每个词汇块包含的消息条数（默认 5，整数 ≥ 1）。 */
  blockSize?: number;
  /** 左侧落差下限 depth[i-1] - depth[i]（默认 0.35，有限正数）。 */
  dropRatio?: number;
  /** 候选点重合度绝对上限 depth[i]（默认 0.25，有限非负数）。 */
  absoluteMax?: number;
  /**
   * 参与判定的最小消息数；未满足时一律零候选。
   * 默认 4 × blockSize：判定任一切点至少需要 4 个完整非空块
   * （depth[i-1]/depth[i]/depth[i+1] 与第 i+2 块填满），低于该值时
   * 任何输入在数学上都不可能产生候选。
   */
  minMessages?: number;
}

interface ResolvedOptions {
  blockSize: number;
  dropRatio: number;
  absoluteMax: number;
  minMessages: number;
}

function assertFiniteNumber(field: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`[patchouli/trigger.boundary] ${field} 必须是有限数值，收到 ${String(value)}`);
  }
}

function assertInteger(field: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`[patchouli/trigger.boundary] ${field} 必须是整数，收到 ${String(value)}`);
  }
}

function resolveOptions(options?: BoundaryDetectorOptions): ResolvedOptions {
  const blockSize = options?.blockSize ?? DEFAULT_BOUNDARY_BLOCK_SIZE;
  const dropRatio = options?.dropRatio ?? DEFAULT_BOUNDARY_DROP_RATIO;
  const absoluteMax = options?.absoluteMax ?? DEFAULT_BOUNDARY_ABSOLUTE_MAX;
  const minMessages = options?.minMessages ?? blockSize * 4;
  assertInteger('blockSize', blockSize);
  if (blockSize < 1) {
    throw new RangeError(`[patchouli/trigger.boundary] blockSize 不能小于 1，收到 ${blockSize}`);
  }
  assertFiniteNumber('dropRatio', dropRatio);
  if (dropRatio <= 0) {
    throw new RangeError(`[patchouli/trigger.boundary] dropRatio 必须为正数，收到 ${dropRatio}`);
  }
  assertFiniteNumber('absoluteMax', absoluteMax);
  if (absoluteMax < 0) {
    throw new RangeError(`[patchouli/trigger.boundary] absoluteMax 不能为负，收到 ${absoluteMax}`);
  }
  assertInteger('minMessages', minMessages);
  if (minMessages < 0) {
    throw new RangeError(`[patchouli/trigger.boundary] minMessages 不能为负，收到 ${minMessages}`);
  }
  return { blockSize, dropRatio, absoluteMax, minMessages };
}

/**
 * 归一化并切分字符 2-gram。
 *
 * 流程：stripMessageMarkup 剥除 CQ 码 / Satori 标签 / 实体 → 小写 →
 * 只保留 [\p{L}\p{N}\p{M}] 实质字符 → 按码点两两成 gram。
 * 对中文（字即 token）与英文（连续字母）同样成立；长度 < 2 时返回空数组。
 */
export function tokenizeCohesion(text: string): string[] {
  const stripped = stripMessageMarkup(text).toLowerCase();
  if (stripped.length === 0) {
    return [];
  }
  const grams: string[] = [];
  let previous: string | null = null;
  for (const char of stripped) {
    if (!SIGNIFICANT_CHAR_PATTERN.test(char)) {
      previous = null;
      continue;
    }
    if (previous !== null) {
      grams.push(previous + char);
    }
    previous = char;
  }
  return grams;
}

/** 词汇块：成员 2-gram 并集 + 块首消息时间戳 + 是否已填满 blockSize。 */
interface LexicalBlock {
  readonly grams: ReadonlySet<string>;
  readonly firstAt: number;
  readonly complete: boolean;
}

function buildBlocks(
  messages: readonly BoundaryMessage[],
  blockSize: number,
): LexicalBlock[] {
  const blocks: LexicalBlock[] = [];
  for (let start = 0; start < messages.length; start += blockSize) {
    const grams = new Set<string>();
    const end = Math.min(start + blockSize, messages.length);
    for (let index = start; index < end; index += 1) {
      for (const gram of tokenizeCohesion(messages[index].text)) {
        grams.add(gram);
      }
    }
    blocks.push({ grams, firstAt: messages[start].at, complete: end - start === blockSize });
  }
  return blocks;
}

/** 相邻块 Dice 系数：2|A∩B| / (|A|+|B|)；分母为零（双侧空块）按 0 处理。 */
function diceCoefficient(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const denominator = left.size + right.size;
  if (denominator === 0) {
    return 0;
  }
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const gram of smaller) {
    if (larger.has(gram)) {
      intersection += 1;
    }
  }
  return (2 * intersection) / denominator;
}

/**
 * 批量判定：对消息数组整体扫描一次，返回全部已定格的候选切点。
 *
 * 与 LexicalBoundaryDetector 逐条 push 的产出完全一致：候选点 i 仅在
 * 第 i+2 块填满后才参与判定（此前 depth[i+1] 仍可能变化），末块未填满时
 * 最后一个可判位置自动后撤，保证「末块之后永不报点」且流批语义一致。
 */
export function detectBoundaries(
  messages: readonly BoundaryMessage[],
  options?: BoundaryDetectorOptions,
): BoundaryCandidate[] {
  const resolved = resolveOptions(options);
  if (messages.length < resolved.minMessages) {
    return [];
  }
  const allBlocks = buildBlocks(messages, resolved.blockSize);
  // 空块（成员全部无实质字符）直接跳过，不参与落差序列。
  const blocks = allBlocks.filter((block) => block.grams.size > 0);
  const depth: number[] = [];
  for (let i = 0; i + 1 < blocks.length; i += 1) {
    depth.push(diceCoefficient(blocks[i].grams, blocks[i + 1].grams));
  }
  const candidates: BoundaryCandidate[] = [];
  const reported = new Set<number>();
  for (let i = 1; i + 1 < depth.length; i += 1) {
    // 定格条件：第 i+2 块已填满。此后 depth[i] 与 depth[i+1] 都不再变化，
    // 判定结果与输入长度无关——这是流式/批量一致性的根基。
    if (!blocks[i + 2].complete) {
      continue;
    }
    const drop = depth[i - 1] - depth[i];
    if (drop < resolved.dropRatio) {
      continue;
    }
    if (!(depth[i] < depth[i - 1]) || !(depth[i] <= depth[i + 1])) {
      continue;
    }
    if (depth[i] > resolved.absoluteMax) {
      continue;
    }
    const at = blocks[i + 1].firstAt;
    if (reported.has(at)) {
      continue;
    }
    reported.add(at);
    candidates.push({ at, score: drop });
  }
  return candidates;
}

/**
 * 流式入口：每条新消息推入一次，最多产出一个候选。
 *
 * 增量结构（O(1) 摊销 / 条，内存有界）：
 *  - 每条消息只做一次 tokenizeCohesion，2-gram 并入「正在填充」的块集合；
 *  - 块填满时封存：与上一块算一次 Dice 追加进 depth 尾部，随后判定因此定格的
 *    候选点 i = K-3（K 为完整非空块总数）——判据与 detectBoundaries 完全一致；
 *  - 只需保留最近 3 个完整非空块与其间 3 个 depth 值（判定 i 需要
 *    depth[i-1]/depth[i]/depth[i+1] 与块 nb[i+1].firstAt），更早的状态永久淘汰；
 *  - 不保存消息全文：只留块首时间戳与 2-gram 集合；
 *  - minMessages 闸门只控制「回吐」：闸门未开时已定格的候选压入 pending，
 *    闸门落下后每条 push 至多回吐一个，保证与批量结果逐位一致。
 */
export class LexicalBoundaryDetector {
  private readonly options: ResolvedOptions;
  /** 已见消息数（size 的 O(1) 实现，不保存全文）。 */
  private messageCount = 0;
  /** 正在填充的块：2-gram 并集 / 已收条数 / 首条消息时间戳。 */
  private pendingGrams = new Set<string>();
  private pendingCount = 0;
  private pendingFirstAt = 0;
  /** 最近 3 个完整非空块（nb 序列尾部）；再早的块对后续判定无意义。 */
  private readonly recentBlocks: Array<{ grams: ReadonlySet<string>; firstAt: number }> = [];
  /** 最近 3 个相邻块 Dice 值（depth 序列尾部）。 */
  private readonly recentDepths: number[] = [];
  /** 已封存的完整非空块总数，即 nb 序列长度 K。 */
  private completeBlocks = 0;
  /**
   * 已上报切点的去重窗口（容量 `REPORTED_AT_WINDOW`）。
   *
   * 不用无界 `Set`：每个候选点 add 一个 `at`、只有 `reset()` 才清空，长跑进程的内存
   * 会随候选点数量线性增长。`at` 随块首时间戳单调不减，容量受限的滑窗判定等价。
   */
  private readonly reportedAts: number[] = [];
  /** 已定格待回吐的候选（闸门未开或同 push 多产出时暂存）。 */
  private readonly pending: BoundaryCandidate[] = [];

  constructor(options?: BoundaryDetectorOptions) {
    this.options = resolveOptions(options);
  }

  /** 已见消息数。 */
  get size(): number {
    return this.messageCount;
  }

  /**
   * 推入一条消息；若新消息使某个切点「定格」且满足判据，返回该候选，否则 null。
   * 每条消息最多返回一个候选；同一 push 定格出的多余候选进 pending 队列，
   * 在后续 push 中依序回吐——保证与 detectBoundaries 的批量结果逐位一致。
   */
  push(message: BoundaryMessage): BoundaryCandidate | null {
    this.messageCount += 1;
    if (this.pendingCount === 0) {
      this.pendingFirstAt = message.at;
    }
    for (const gram of tokenizeCohesion(message.text)) {
      this.pendingGrams.add(gram);
    }
    this.pendingCount += 1;
    if (this.pendingCount === this.options.blockSize) {
      this.sealBlock();
    }
    if (this.messageCount < this.options.minMessages) {
      return null;
    }
    return this.pending.shift() ?? null;
  }

  /**
   * 封存一个填满的块：空块直接跳过（与批量的 filter 等价）；非空块追加 nb 尾部，
   * 计算新 depth，并判定因此定格的候选点 i = K-3（此前 depth[i+1] 尚未定值，
   * 此刻起该判定永久成立，与后续输入无关）。
   */
  private sealBlock(): void {
    const grams = this.pendingGrams;
    const firstAt = this.pendingFirstAt;
    this.pendingGrams = new Set<string>();
    this.pendingCount = 0;
    if (grams.size === 0) {
      return;
    }
    const previous = this.recentBlocks[this.recentBlocks.length - 1];
    if (previous !== undefined) {
      this.recentDepths.push(diceCoefficient(previous.grams, grams));
      if (this.recentDepths.length > 3) {
        this.recentDepths.shift();
      }
    }
    this.recentBlocks.push({ grams, firstAt });
    if (this.recentBlocks.length > 3) {
      this.recentBlocks.shift();
    }
    this.completeBlocks += 1;
    // 新块占 nb 下标 p = K-1；它使候选点 i = p-2 = K-3 的三个相邻 depth 全部定格。
    const verdictIndex = this.completeBlocks - 3;
    if (verdictIndex < 1 || this.recentDepths.length < 3 || this.recentBlocks.length < 3) {
      return;
    }
    const [previousDepth, currentDepth, nextDepth] = this.recentDepths.slice(-3);
    const drop = previousDepth - currentDepth;
    if (drop < this.options.dropRatio) {
      return;
    }
    if (!(currentDepth < previousDepth) || !(currentDepth <= nextDepth)) {
      return;
    }
    if (currentDepth > this.options.absoluteMax) {
      return;
    }
    // at = nb[i+1] 的首条消息时间戳 = 次新块（新块是 nb[i+2]）。
    const at = this.recentBlocks[this.recentBlocks.length - 2].firstAt;
    if (this.reportedAts.includes(at)) {
      return;
    }
    this.reportedAts.push(at);
    if (this.reportedAts.length > REPORTED_AT_WINDOW) {
      this.reportedAts.shift();
    }
    this.pending.push({ at, score: drop });
  }

  /** 清空全部已见状态、候选队列与块缓存，回到初始状态。 */
  reset(): void {
    this.messageCount = 0;
    this.pendingGrams = new Set<string>();
    this.pendingCount = 0;
    this.pendingFirstAt = 0;
    this.recentBlocks.length = 0;
    this.recentDepths.length = 0;
    this.completeBlocks = 0;
    this.reportedAts.length = 0;
    this.pending.length = 0;
  }
}
