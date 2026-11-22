/**
 * Patchouli Knowledge — 三元信息势能模型（L0 纯函数层）
 *
 * 职责：
 *  - 把单条消息归约为「信息量 I（nat-grams）」：对数容量 × 局部新颖率 × 类型/记号比；
 *  - 用同一衰减核（τ = 240s）维护跨尺度漏桶势能 E、同核消息计数 N、信息密度 ρ = E / N；
 *  - 用逐发言人衰减累加器 Map<userId, energy> 计算交互熵 S_turn 与有效讨论势能 Q = E · S_turn；
 *  - 提供等效消息数折算与冷却时刻闭式解，供触发器状态机使用。
 *
 * 非目标：
 *  - 不做语义理解、不调用模型、不读写持久化状态、不持有定时器；
 *  - 不产生任何 I/O。
 *
 * 设计约束：
 *  - 纯函数 / 纯内存；单条 push 复杂度 O(L)（L = 归一化后单元数），绝不重算 20 条滑窗；
 *  - 严格 TypeScript，禁止 any。
 *
 * 归一化口径（§7.5.4）：
 *  1. 先按 ``` 围栏切段：正文段交给 `stripMessageMarkup`，代码段按行折叠；
 *  2. 代码块每行折叠为一个记号 `code:<sha1 前 8 字节 hex>`，空行不计；
 *  3. URL 整体替换为记号 `url:<host>`（host 小写、去端口与 userinfo），同一条消息内同 host 只计一次；
 *  4. 其余只保留字母 / 数字 / 组合记号（`[\p{L}\p{N}\p{M}]`）并统一小写；
 *  5. 记号在归一化文本中占 1 个码点（U+E000..U+EFFF 表示代码行，U+F000..U+F7FF 表示 URL host），
 *     因此 `L` 与二元组都按「记号 = 1 字符」计算。
 *
 * 双文本：同一遍归一化同时产出两份文本——
 *  - 记号文本（私用区码点）只服务 `L` / 二元组 / 引用计数，不外泄给模型；
 *  - 可读文本把记号展开为 `[链接:host]` / `[代码 N 行]`，由 `PotentialTracker.recentTexts`
 *    交给 L2 边界裁决与回溯，避免 PUA 字符变成乱码。
 *
 * 说明：`stripMessageMarkup` 会把换行折叠为空格，代码块的行结构必须在其之前保留，
 * 故先切围栏再对正文段落剥标签；代码行逐行剥标签后取哈希，保证同一行在任何消息里折叠为同一记号。
 */

import { createHash } from 'node:crypto';
import { stripMessageMarkup } from './filter';

/** 势能模型常量集合。 */
export interface PotentialConstants {
  /** 漏桶衰减时间常数（秒）。 */
  tauSeconds: number;
  /** 计入信息量的最小实质字符数，低于该长度直接判为噪声。 */
  minChars: number;
  /** 二元组滑动并集的窗口条数。 */
  recentK: number;
  /** 等效消息数折算的参考信息量。 */
  refInfo: number;
  /** 发言人能量清理下限。 */
  speakerFloor: number;
  /** 等效消息数折算下界。 */
  equivMin: number;
  /** 等效消息数折算上界。 */
  equivMax: number;
}

export const DEFAULT_POTENTIAL_CONSTANTS: Readonly<PotentialConstants> = Object.freeze({
  tauSeconds: 240,
  minChars: 4,
  recentK: 20,
  refInfo: 1.5,
  speakerFloor: 1e-3,
  equivMin: 0.5,
  equivMax: 3,
});

/** 归一化结果：`text` 为单元串（记号占 1 个码点），`codeBlocks` / `urls` 为折叠计数。 */
export interface NormalizedText {
  text: string;
  codeBlocks: number;
  urls: number;
}

/** 势能跟踪器的只读快照。 */
export interface PotentialSnapshot {
  /** 快照时刻（毫秒）。 */
  at: number;
  /** 漏桶总势能 E = Σ E_u。 */
  energy: number;
  /** 同核衰减消息计数 N。 */
  count: number;
  /** 信息密度 ρ = E / N（N = 0 时为 0）。 */
  density: number;
  /** 归一化交互系数 S_turn ∈ [0, 1]。 */
  interaction: number;
  /** 有效讨论势能 Q = E · S_turn。 */
  quality: number;
  /** 最后一条消息的信息量 I。 */
  lastInfo: number;
  /** 最后一条消息折算的等效条数（I = 0 时为 0）。 */
  lastEquiv: number;
  /** 存活发言人（Map 插入顺序）及其归一化份额。 */
  speakers: Array<{ userId: string; energy: number; share: number }>;
}

const TAG = '[patchouli/trigger.potential]';

/** 代码围栏标记。 */
const CODE_FENCE = '```';

/** 正文段中的 URL：带 http(s) 协议或 www. 前缀，遇到空白与 CJK 标点即止。 */
const URL_PATTERN = /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

/** URL 尾部可能粘上的 ASCII 标点，解析 host 前先剥掉。 */
const URL_TRAILING_PATTERN = /[),.;:!?\]'"]+$/;

/** 实质字符：字母 / 数字 / 组合记号；与 `filter.ts` 的 `effectiveTextLength` 同一字符类。
 *  记号码点（U+E000..U+F8FF）在此保留，使归一化对自身输出幂等，重复归一化不会吃掉代码行 / URL 记号。 */
const NON_SIGNIFICANT_PATTERN = /[^\p{L}\p{N}\p{M}\u{E000}-\u{F8FF}]/gu;

/** 代码行记号的码点区间（BMP 私用区）。 */
const CODE_UNIT_BASE = 0xe000;
const CODE_UNIT_SLOTS = 0x1000;

/** URL 记号的码点区间（BMP 私用区，与代码行区间不重叠）。 */
const URL_UNIT_BASE = 0xf000;
const URL_UNIT_SLOTS = 0x0800;

/**
 * 话题边界处前段势能的保留系数：`E ← E × factor`。
 *
 * 为什么是 0.5 而不是 0：边界只说明「话题转了」，上一段讨论的余温仍是这个群当下的氛围。
 * 折半既让新话题从接近零的势能起步（不会被前一段的高 Q 直接顶过 Θ_burst，也不需要等满
 * 一个 τ 才回落），又保留了一部分语境连续性；`E` 与 `N` 同乘该系数，因此密度 ρ = E / N
 * 不变 —— 边界不该改变「这个群每条消息有多重」的判据口径。
 */
export const BOUNDARY_ENERGY_FACTOR = 0.5;

/** 记号查询接口：`Set<string>` 与 `Map<string, number>` 都满足（后者按键存在性判定）。 */
type GramLookup = { has(gram: string): boolean };

interface RecentEntry {
  /** 人类可读的归一化文本（供 L2 / 回溯使用，不含私用区记号码点）。 */
  readable: string;
  /** 该条消息的去重二元组。 */
  grams: string[];
}

interface NormalizedUnits {
  units: string[];
  /** 与 `units` 一一对应的可读文本：记号展开为 `[链接:host]` / `[代码 N 行]`。 */
  readable: string;
  codeBlocks: number;
  urls: number;
}

function assertFiniteNumber(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${TAG} ${field} 必须是有限数值，收到 ${String(value)}`);
  }
}

function resolveConstants(partial: Partial<PotentialConstants>): PotentialConstants {
  const merged: PotentialConstants = { ...DEFAULT_POTENTIAL_CONSTANTS };

  if (partial.tauSeconds !== undefined) {
    assertFiniteNumber(partial.tauSeconds, 'tauSeconds');
    if (partial.tauSeconds <= 0) {
      throw new RangeError(`${TAG} tauSeconds 必须为正数，收到 ${partial.tauSeconds}`);
    }
    merged.tauSeconds = partial.tauSeconds;
  }

  if (partial.minChars !== undefined) {
    assertFiniteNumber(partial.minChars, 'minChars');
    if (!Number.isInteger(partial.minChars) || partial.minChars < 0) {
      throw new RangeError(`${TAG} minChars 必须是非负整数，收到 ${partial.minChars}`);
    }
    merged.minChars = partial.minChars;
  }

  if (partial.recentK !== undefined) {
    assertFiniteNumber(partial.recentK, 'recentK');
    if (!Number.isInteger(partial.recentK) || partial.recentK < 1) {
      throw new RangeError(`${TAG} recentK 必须是正整数，收到 ${partial.recentK}`);
    }
    merged.recentK = partial.recentK;
  }

  if (partial.refInfo !== undefined) {
    assertFiniteNumber(partial.refInfo, 'refInfo');
    if (partial.refInfo <= 0) {
      throw new RangeError(`${TAG} refInfo 必须为正数，收到 ${partial.refInfo}`);
    }
    merged.refInfo = partial.refInfo;
  }

  if (partial.speakerFloor !== undefined) {
    assertFiniteNumber(partial.speakerFloor, 'speakerFloor');
    if (partial.speakerFloor < 0) {
      throw new RangeError(`${TAG} speakerFloor 不能为负，收到 ${partial.speakerFloor}`);
    }
    merged.speakerFloor = partial.speakerFloor;
  }

  if (partial.equivMin !== undefined) {
    assertFiniteNumber(partial.equivMin, 'equivMin');
    if (partial.equivMin < 0) {
      throw new RangeError(`${TAG} equivMin 不能为负，收到 ${partial.equivMin}`);
    }
    merged.equivMin = partial.equivMin;
  }

  if (partial.equivMax !== undefined) {
    assertFiniteNumber(partial.equivMax, 'equivMax');
    if (partial.equivMax < 0) {
      throw new RangeError(`${TAG} equivMax 不能为负，收到 ${partial.equivMax}`);
    }
    merged.equivMax = partial.equivMax;
  }

  if (merged.equivMin > merged.equivMax) {
    throw new RangeError(`${TAG} equivMin (${merged.equivMin}) 不得大于 equivMax (${merged.equivMax})`);
  }

  return merged;
}

/** 把哈希摘要的前两个字节映射为记号码点；同一摘要永远得到同一码点。 */
function unitFromDigest(digest: Buffer, base: number, slots: number): string {
  return String.fromCodePoint(base + (digest.readUInt16BE(0) % slots));
}

/** 从匹配到的 URL 里取出小写 host（去 userinfo、去端口、去路径与查询串）。 */
function urlHost(rawUrl: string): string {
  let rest = rawUrl.replace(URL_TRAILING_PATTERN, '');

  const schemeIndex = rest.indexOf('://');
  if (schemeIndex >= 0) {
    rest = rest.slice(schemeIndex + 3);
  }

  let authorityEnd = rest.length;
  for (const separator of ['/', '?', '#']) {
    const index = rest.indexOf(separator);
    if (index >= 0 && index < authorityEnd) {
      authorityEnd = index;
    }
  }

  const authority = rest.slice(0, authorityEnd);
  const atIndex = authority.lastIndexOf('@');
  const hostPort = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
  const colonIndex = hostPort.lastIndexOf(':');
  const host =
    colonIndex > 0 && /^\d+$/.test(hostPort.slice(colonIndex + 1)) ? hostPort.slice(0, colonIndex) : hostPort;

  return host.toLowerCase();
}

/** 追加正文段的实质字符（统一小写）：同时写入二元组单元与可读文本。 */
function appendText(chunk: string, units: string[], parts: string[]): void {
  const kept = chunk.replace(NON_SIGNIFICANT_PATTERN, '').toLowerCase();
  if (kept.length === 0) {
    return;
  }
  for (const unit of kept) {
    units.push(unit);
  }
  parts.push(kept);
}

/** 把正文段里的 URL 折叠为 host 记号（同 host 只计一次），返回新增的 URL 记号数。 */
function appendProseUnits(rawSegment: string, units: string[], parts: string[], hosts: Set<string>): number {
  const plain = stripMessageMarkup(rawSegment);
  if (plain.length === 0) {
    return 0;
  }

  let added = 0;
  let cursor = 0;
  URL_PATTERN.lastIndex = 0;

  for (let match = URL_PATTERN.exec(plain); match !== null; match = URL_PATTERN.exec(plain)) {
    appendText(plain.slice(cursor, match.index), units, parts);
    const host = urlHost(match[0]);
    if (host.length > 0 && !hosts.has(host)) {
      hosts.add(host);
      const digest = createHash('sha1').update(`url:${host}`, 'utf8').digest();
      units.push(unitFromDigest(digest, URL_UNIT_BASE, URL_UNIT_SLOTS));
      parts.push(`[链接:${host}]`);
      added += 1;
    }
    cursor = match.index + match[0].length;
  }

  appendText(plain.slice(cursor), units, parts);
  return added;
}

/** 把代码块按行折叠为记号：语言标注行丢弃，空行不计，同一行永远折叠为同一记号。 */
function appendCodeUnits(body: string, units: string[], parts: string[]): void {
  const firstBreak = body.indexOf('\n');
  const content = firstBreak < 0 ? body : body.slice(firstBreak + 1);

  let folded = 0;
  for (const line of content.split('\n')) {
    const cleaned = stripMessageMarkup(line).trim();
    if (cleaned.length === 0) {
      continue;
    }
    const digest = createHash('sha1').update(cleaned, 'utf8').digest();
    units.push(unitFromDigest(digest, CODE_UNIT_BASE, CODE_UNIT_SLOTS));
    folded += 1;
  }

  if (folded > 0) {
    parts.push(`[代码 ${folded} 行]`);
  }
}

function normalizeUnits(raw: string): NormalizedUnits {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { units: [], readable: '', codeBlocks: 0, urls: 0 };
  }

  const units: string[] = [];
  const parts: string[] = [];
  const hosts = new Set<string>();
  let codeBlocks = 0;
  let urls = 0;
  let cursor = 0;

  for (;;) {
    const open = raw.indexOf(CODE_FENCE, cursor);
    if (open < 0) {
      break;
    }
    if (open > cursor) {
      urls += appendProseUnits(raw.slice(cursor, open), units, parts, hosts);
    }

    const bodyStart = open + CODE_FENCE.length;
    const close = raw.indexOf(CODE_FENCE, bodyStart);
    const bodyEnd = close < 0 ? raw.length : close;
    codeBlocks += 1;
    appendCodeUnits(raw.slice(bodyStart, bodyEnd), units, parts);

    cursor = close < 0 ? raw.length : close + CODE_FENCE.length;
    if (close < 0) {
      break;
    }
  }

  if (cursor < raw.length) {
    urls += appendProseUnits(raw.slice(cursor), units, parts, hosts);
  }

  return { units, readable: parts.join(''), codeBlocks, urls };
}

/**
 * 归一化消息文本：剥 Satori / CQ、折叠代码块与 URL、只保留实质字符。
 *
 * 返回的 `text` 中，代码行与 URL 各占一个私用区码点（记号 = 1 字符），
 * 其余为小写的字母 / 数字 / 组合记号。该变换对自身输出幂等：
 * 再次归一化同一字符串得到相同结果，记号不会被当成标点吃掉。
 *
 * 这份文本是内部记号形态，**不要**直接交给模型；需要喂给 L2 / 回溯的可读文本请用
 * `PotentialTracker.recentTexts`（同一遍归一化产出的可读版本）。
 */
export function normalizePotentialText(raw: string): NormalizedText {
  const normalized = normalizeUnits(raw);
  return {
    text: normalized.units.join(''),
    codeBlocks: normalized.codeBlocks,
    urls: normalized.urls,
  };
}

/** 取单元串的去重二元组集合。 */
function collectGrams(units: readonly string[]): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index + 1 < units.length; index += 1) {
    grams.add(units[index] + units[index + 1]);
  }
  return grams;
}

function countNovel(grams: ReadonlySet<string>, recent: GramLookup): number {
  let novel = 0;
  for (const gram of grams) {
    if (!recent.has(gram)) {
      novel += 1;
    }
  }
  return novel;
}

/**
 * 信息量核心：I = ln(1 + |G|) · |G \\ G_recent| / (|G| + 1) · min(1, |G| / (L - 1))。
 */
function informationOf(
  length: number,
  gramCount: number,
  novelCount: number,
  settings: Readonly<PotentialConstants>,
): number {
  if (length < settings.minChars || length <= 1 || gramCount === 0) {
    return 0;
  }
  const capacity = Math.log(1 + gramCount);
  const novelty = novelCount / (gramCount + 1);
  const typeRatio = Math.min(1, gramCount / (length - 1));
  return capacity * novelty * typeRatio;
}

/**
 * 单条消息的信息量（nat-grams）。
 *
 * `text` 为原始消息文本（内部自行归一化）；`recentGrams` 为频道二元组滑动并集，
 * 缺省视为空集（即整条消息全新）。
 */
export function messageInformation(
  text: string,
  recentGrams: ReadonlySet<string> | undefined,
  constants?: Partial<PotentialConstants>,
): number {
  const settings = constants === undefined ? DEFAULT_POTENTIAL_CONSTANTS : resolveConstants(constants);
  const units = normalizeUnits(text).units;
  const grams = collectGrams(units);
  const novel = recentGrams === undefined ? grams.size : countNovel(grams, recentGrams);
  return informationOf(units.length, grams.size, novel, settings);
}

/**
 * 等效消息数：N_equiv = Σ clamp(I / I_ref, equivMin, equivMax)，只对 I > 0 的消息计入。
 */
export function effectiveMessageCount(
  infos: readonly number[],
  refInfo?: number,
  constants?: Partial<PotentialConstants>,
): number {
  const settings = constants === undefined ? DEFAULT_POTENTIAL_CONSTANTS : resolveConstants(constants);
  const reference = refInfo === undefined ? settings.refInfo : refInfo;
  assertFiniteNumber(reference, 'refInfo');
  if (reference <= 0) {
    throw new RangeError(`${TAG} refInfo 必须为正数，收到 ${reference}`);
  }

  let total = 0;
  for (const info of infos) {
    if (!Number.isFinite(info) || info <= 0) {
      continue;
    }
    total += Math.min(settings.equivMax, Math.max(settings.equivMin, info / reference));
  }
  return total;
}

/**
 * 势能回落越过阈值的闭式解：`energy > threshold` 时返回 `at + tau · log2(energy / threshold)`（毫秒）。
 * 阈值非正或势能未越界时返回 `null`。
 */
export function potentialCrossingAt(
  energy: number,
  threshold: number,
  at: number,
  tauSeconds?: number,
): number | null {
  assertFiniteNumber(energy, 'energy');
  assertFiniteNumber(threshold, 'threshold');
  assertFiniteNumber(at, 'at');

  const tau = tauSeconds === undefined ? DEFAULT_POTENTIAL_CONSTANTS.tauSeconds : tauSeconds;
  assertFiniteNumber(tau, 'tauSeconds');
  if (tau <= 0) {
    throw new RangeError(`${TAG} tauSeconds 必须为正数，收到 ${tau}`);
  }

  if (threshold <= 0 || energy <= threshold) {
    return null;
  }
  return at + tau * 1000 * Math.log2(energy / threshold);
}

/**
 * 逐群势能跟踪器：漏桶势能 E、同核计数 N、逐发言人衰减累加器与最近 K 条二元组并集。
 *
 * `E` 不单独维护，永远等于 `Map<userId, energy>` 的求和，因此 `Σ E_u == energy` 恒成立。
 */
export class PotentialTracker {
  readonly constants: Readonly<PotentialConstants>;

  private readonly tauMs: number;

  private readonly speakers = new Map<string, number>();

  private readonly gramCounts = new Map<string, number>();

  private readonly recent: RecentEntry[] = [];

  private lastAt: number | null = null;

  private count = 0;

  private lastInfo = 0;

  private lastEquiv = 0;

  constructor(constants?: Partial<PotentialConstants>) {
    this.constants =
      constants === undefined ? DEFAULT_POTENTIAL_CONSTANTS : Object.freeze(resolveConstants(constants));
    this.tauMs = this.constants.tauSeconds * 1000;
  }

  /**
   * 记录一条消息并返回记录后的快照。
   *
   * 乱序到达时 Δt 取下界 0（不倒退），`lastAt` 只前进；快照时间即 `lastAt`。
   */
  push(message: { userId: string; text: string; at: number }): PotentialSnapshot {
    const settings = this.constants;
    const { userId, at } = message;

    if (typeof userId !== 'string' || userId.length === 0) {
      throw new TypeError(`${TAG} userId 必须是非空字符串`);
    }
    assertFiniteNumber(at, 'at');

    const deltaMs = this.lastAt === null ? 0 : Math.max(0, at - this.lastAt);
    const factor = deltaMs === 0 ? 1 : Math.pow(2, -deltaMs / this.tauMs);

    // ① 全部 E_u 同核衰减
    for (const [speaker, energy] of this.speakers) {
      this.speakers.set(speaker, energy * factor);
    }

    const normalized = normalizeUnits(message.text);
    const grams = collectGrams(normalized.units);
    const info = informationOf(
      normalized.units.length,
      grams.size,
      countNovel(grams, this.gramCounts),
      settings,
    );

    // ② 本条发言人累加信息量
    this.speakers.set(userId, (this.speakers.get(userId) ?? 0) + info);

    // N 独立维护，与 E 同核衰减
    this.count = this.count * factor + 1;
    this.lastAt = this.lastAt === null ? at : Math.max(this.lastAt, at);

    // ③ 清理低于下限的发言人能量（等价于从总和中扣除）
    for (const [speaker, energy] of this.speakers) {
      if (energy < settings.speakerFloor) {
        this.speakers.delete(speaker);
      }
    }

    const gramList = Array.from(grams);
    for (const gram of gramList) {
      this.gramCounts.set(gram, (this.gramCounts.get(gram) ?? 0) + 1);
    }
    this.recent.push({ readable: normalized.readable, grams: gramList });

    while (this.recent.length > settings.recentK) {
      const evicted = this.recent.shift();
      if (evicted === undefined) {
        break;
      }
      for (const gram of evicted.grams) {
        const refcount = this.gramCounts.get(gram);
        if (refcount === undefined) {
          continue;
        }
        if (refcount <= 1) {
          this.gramCounts.delete(gram);
        } else {
          this.gramCounts.set(gram, refcount - 1);
        }
      }
    }

    this.lastInfo = info;
    this.lastEquiv =
      info > 0 ? Math.min(settings.equivMax, Math.max(settings.equivMin, info / settings.refInfo)) : 0;

    return this.snapshotAt(this.lastAt);
  }

  /** 非破坏性快照：按 `at` 对当前残余势能与计数做闭式衰减，不改变后续 push 的结果。 */
  peek(at: number): PotentialSnapshot {
    assertFiniteNumber(at, 'at');
    // 回看必须夹紧到 `lastAt`：衰减因子是 `2^(-(at-lastAt)/τ)`，`at < lastAt` 时会 > 1，
    // 于是「问过去」反而把残余势能、计数与密度全部放大（虚高）。与 push 同口径：
    // 快照时间只前进，时间不倒流。
    const clamped = this.lastAt === null ? at : Math.max(at, this.lastAt);
    return this.snapshotAt(clamped);
  }

  /**
   * 最近 `limit` 条**人类可读**的归一化文本，最旧 → 最新。
   *
   * 供 L2 边界裁决与回溯使用：URL 展开为 `[链接:host]`，代码块概括为 `[代码 N 行]`，
   * 其余为小写化并过滤后的实质字符；**不含**私用区记号码点。
   * 内部的二元组 / 引用计数用另一份记号文本维护，与本返回值无关。
   * 返回条数受 `limit` 与 `constants.recentK` 双重约束。
   */
  recentTexts(limit: number): string[] {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      return [];
    }
    const size = Math.min(Math.floor(limit), this.recent.length);
    if (size <= 0) {
      return [];
    }
    const texts: string[] = [];
    for (let index = this.recent.length - size; index < this.recent.length; index += 1) {
      texts.push(this.recent[index].readable);
    }
    return texts;
  }

  /**
   * 话题边界：把前段势能按 `factor` 折减，并清空二元组窗口。
   *
   * `E_u` 与同核计数 `N` 同乘 `factor`，故：
   *  - 总势能 `E = Σ E_u` 与有效势能 `Q = E · S_turn` 同比折减（`S_turn` 只看份额，不变）；
   *  - 信息密度 `ρ = E / N` 原样保持 —— 密度是「该群每条消息的信息量」，与话题无关；
   *  - `recent` / `gramCounts` 清空：新话题里的词不该被旧话题判成「重复」（否则跨话题的
   *    常见术语会被 ν 归零，把正常讨论压成噪声）。
   *
   * 不触碰 `lastAt`：边界不是消息，时间轴不变；下一次 push 的 Δt 仍按真实间隔衰减。
   */
  applyBoundary(factor: number): void {
    assertFiniteNumber(factor, 'factor');
    if (factor < 0 || factor > 1) {
      throw new RangeError(`${TAG} factor 必须落在 [0, 1]，收到 ${factor}`);
    }
    if (factor === 1) {
      return;
    }
    for (const [speaker, energy] of this.speakers) {
      this.speakers.set(speaker, energy * factor);
    }
    this.count *= factor;
    this.recent.length = 0;
    this.gramCounts.clear();
  }

  /** 清空全部状态（常量不变）。 */
  reset(): void {
    this.speakers.clear();
    this.gramCounts.clear();
    this.recent.length = 0;
    this.lastAt = null;
    this.count = 0;
    this.lastInfo = 0;
    this.lastEquiv = 0;
  }

  private snapshotAt(at: number): PotentialSnapshot {
    const factor = this.lastAt === null ? 1 : Math.pow(2, -(at - this.lastAt) / this.tauMs);

    let energy = 0;
    for (const value of this.speakers.values()) {
      energy += value * factor;
    }

    const count = this.count * factor;
    const density = count > 0 ? energy / count : 0;

    const speakers: Array<{ userId: string; energy: number; share: number }> = [];
    let entropy = 0;
    for (const [userId, value] of this.speakers) {
      const decayed = value * factor;
      const share = energy > 0 ? decayed / energy : 0;
      if (share > 0) {
        entropy -= share * Math.log(share);
      }
      speakers.push({ userId, energy: decayed, share });
    }

    const interaction = energy > 0 ? Math.min(1, entropy / Math.LN2) : 0;

    return {
      at,
      energy,
      count,
      density,
      interaction,
      quality: energy * interaction,
      lastInfo: this.lastInfo,
      lastEquiv: this.lastEquiv,
      speakers,
    };
  }
}
