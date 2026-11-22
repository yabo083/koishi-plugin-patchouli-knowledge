/**
 * Patchouli Knowledge — 触发器物理层：窗口信息度量与结构化前置滤波
 *
 * 职责：
 *  - 剥掉 Satori / CQ 码等非文本负载，只保留人眼可读的纯文本；
 *  - 过滤「纯表情 / 单字回复 / 标点刷屏」等物理噪声，不让其污染有效速率；
 *  - 为突发判据提供与语义无关的硬指标：
 *      effectiveRate   有效消息速率（条/分）
 *      uniqueSpeakers  独立发言人数
 *      entropyRatio    样本信息熵率（前 32 字符去重计数 / 有效消息数）
 *      avgCharLength   有效消息平均字符长（码点，含标点与空格）
 *
 * 非目标：
 *  - 不做语义理解、不调用模型、不读写持久化状态；
 *  - 唯一的内存副作用是按消息对象做 WeakMap 样本缓存（摊销窗口重算成本，不改变结果）。
 *
 * 设计约束：
 *  - 纯函数，输入输出全部显式；非法窗口时长直接抛 RangeError；
 *  - 严格 TypeScript，禁止 any。
 */

import type { ChatMessage } from '../types';

/** 有效文本的最小「实质字符」数（字母 / 数字 / 组合记号），低于该长度视为表情、单字或标点刷屏。 */
export const MIN_EFFECTIVE_TEXT_LENGTH = 4;

/** 样本信息熵率的去重前缀长度（码点）。 */
export const ENTROPY_PREFIX_LENGTH = 32;

/** 突发判据的硬性物理门限：至少 2 名独立发言人。 */
export const MIN_UNIQUE_SPEAKERS = 2;

/** 突发判据的硬性物理门限：前 32 字符去重率不得低于 0.6（拦截单人复读与复制粘贴刷屏）。 */
export const MIN_ENTROPY_RATIO = 0.6;

/** 带逻辑时间的消息条目；与 `BurstQuiescenceDetector` 的 `WindowEntry` 结构兼容。 */
export interface WindowMessage {
  message: ChatMessage;
  at: number;
}

/** 单个滑窗的物理层度量。 */
export interface WindowEvaluation {
  /** 落在窗口内的原始消息条数（含被滤波剔除的噪声）。 */
  totalMessages: number;
  /** 通过物理层滤波、计入速率与语义判据的有效消息条数。 */
  effectiveMessages: number;
  /** 有效消息速率（条/分）。 */
  effectiveRate: number;
  /** 有效消息中的独立发言人数量。 */
  uniqueSpeakers: number;
  /** 样本信息熵率 = 前 `ENTROPY_PREFIX_LENGTH` 字符去重计数 / 有效消息数，取值 0..1。 */
  entropyRatio: number;
  /** 有效消息的平均纯文本字符长（码点）。 */
  avgCharLength: number;
}

/** CQ 码：[CQ:image,file=...]、[CQ:at,qq=...] 等。 */
const CQ_CODE_PATTERN = /\[CQ:[^\]]*\]/g;

/** Satori 标签（支持 `ns:tag` 命名空间）：自闭合与成对标签均整体剥除（保留标签之间的正文）。 */
const SATORI_TAG_PATTERN = /<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*?)?\/?>/g;

/** 常见 HTML 实体与数字实体。 */
const HTML_ENTITY_PATTERN = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(nbsp|amp|lt|gt|quot|apos));/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/** 控制字符、零宽字符与双向控制符：既不可读也不应参与长度统计。 */
const INVISIBLE_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

const WHITESPACE_PATTERN = /\s+/g;

/** 实质字符：字母 / 数字 / 组合记号；表情、标点、符号一律不计。 */
const SIGNIFICANT_CHAR_PATTERN = /[\p{L}\p{N}\p{M}]/u;

function safeFromCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
    return ' ';
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return ' ';
  }
}

function decodeEntities(text: string): string {
  return text.replace(
    HTML_ENTITY_PATTERN,
    (entity: string, hex: string | undefined, decimal: string | undefined, named: string | undefined): string => {
      if (hex !== undefined) {
        return safeFromCodePoint(Number.parseInt(hex, 16));
      }
      if (decimal !== undefined) {
        return safeFromCodePoint(Number.parseInt(decimal, 10));
      }
      if (named !== undefined) {
        return NAMED_ENTITIES[named] ?? entity;
      }
      return entity;
    },
  );
}

/**
 * 剥离消息中的非文本负载，返回折叠空白后的纯文本。
 *
 * 处理顺序：CQ 码 → Satori 标签 → HTML 实体 → 不可见字符 → 空白折叠。
 * 实体在标签剥除之后解码，保证 `&lt;img&gt;` 这类「被转义的正文」不会被误当标签。
 */
export function stripMessageMarkup(content: string): string {
  if (typeof content !== 'string' || content.length === 0) {
    return '';
  }
  const withoutCodes = content.replace(CQ_CODE_PATTERN, ' ');
  const withoutTags = withoutCodes.replace(SATORI_TAG_PATTERN, ' ');
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(INVISIBLE_PATTERN, '').replace(WHITESPACE_PATTERN, ' ').trim();
}

/**
 * 码点安全截断：超过 `limit` 时只遍历到第 `limit` 个码点即返回。
 *
 * 刻意不用 `Array.from(text)` 先摊平：那会对 10MB 串分配千万级数组（实测 +506MB），
 * 而 `text.length` 是 UTF-16 码元数、恒 ≥ 码点数，可安全用于短路。
 */
export function clampCodePoints(text: string, limit: number): string {
  if (typeof text !== 'string' || text.length === 0 || limit <= 0) return '';
  if (text.length <= limit) return text;
  let out = '';
  let count = 0;
  for (const char of text) {
    out += char;
    count += 1;
    if (count >= limit) break;
  }
  return out;
}

/** 有效文本长度：只统计字母 / 数字 / 组合记号，表情与标点刷屏计 0。 */
export function effectiveTextLength(text: string): number {
  let count = 0;
  for (const char of text) {
    if (SIGNIFICANT_CHAR_PATTERN.test(char)) {
      count += 1;
    }
  }
  return count;
}

/** 码点长度（emoji 等代理对按 1 计），用于平均字符长与熵前缀截取。 */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _char of text) {
    count += 1;
  }
  return count;
}

/** 取前 `limit` 个码点；不足则原样返回（不产生数组分配）。 */
function firstCodePoints(text: string, limit: number): string {
  let codePoints = 0;
  let endIndex = 0;
  for (const char of text) {
    if (codePoints === limit) {
      break;
    }
    endIndex += char.length;
    codePoints += 1;
  }
  return codePoints <= limit ? text : text.slice(0, endIndex);
}

interface EffectiveSample {
  text: string;
  length: number;
  speaker: string;
}

/**
 * 每消息物理样本缓存：触发器每条消息都会重算整个窗口，
 * 以消息对象为键（`ChatMessage` 视作不可变）把剥离/计数结果摊销为一次。
 * WeakMap 不阻止消息被回收，也不改变任何函数结果。
 */
const SAMPLE_CACHE = new WeakMap<ChatMessage, EffectiveSample | null>();

function normalizeWindowSeconds(windowSeconds: number): number {
  if (typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new RangeError(
      `[patchouli/trigger.filter] windowSeconds 必须为正数，收到 ${String(windowSeconds)}`,
    );
  }
  return windowSeconds;
}

function buildSample(message: ChatMessage): EffectiveSample | null {
  const cached = SAMPLE_CACHE.get(message);
  if (cached !== undefined) {
    return cached;
  }

  const text = stripMessageMarkup(message.content);
  const userId = typeof message.userId === 'string' ? message.userId.trim() : '';
  const userName = typeof message.userName === 'string' ? message.userName.trim() : '';
  const sample =
    effectiveTextLength(text) < MIN_EFFECTIVE_TEXT_LENGTH
      ? null
      : {
          text,
          length: codePointLength(text),
          speaker: userId || userName || '未知发言者',
        };
  SAMPLE_CACHE.set(message, sample);
  return sample;
}

function summarize(
  samples: readonly EffectiveSample[],
  totalMessages: number,
  windowSeconds: number,
): WindowEvaluation {
  const effectiveMessages = samples.length;
  if (effectiveMessages === 0) {
    return {
      totalMessages,
      effectiveMessages: 0,
      effectiveRate: 0,
      uniqueSpeakers: 0,
      entropyRatio: 0,
      avgCharLength: 0,
    };
  }

  const speakers = new Set<string>();
  const prefixes = new Set<string>();
  let charTotal = 0;
  for (const sample of samples) {
    speakers.add(sample.speaker);
    prefixes.add(firstCodePoints(sample.text, ENTROPY_PREFIX_LENGTH));
    charTotal += sample.length;
  }

  return {
    totalMessages,
    effectiveMessages,
    effectiveRate: (effectiveMessages * 60) / windowSeconds,
    uniqueSpeakers: speakers.size,
    entropyRatio: prefixes.size / effectiveMessages,
    avgCharLength: charTotal / effectiveMessages,
  };
}

/**
 * 评估一段带逻辑时间的窗口（触发器内部使用，避免重复做时间归一化）。
 *
 * @param entries 候选条目；只有 `at > anchor - windowSeconds × 1000` 的条目参与统计
 * @param windowSeconds 窗口时长（秒），必须为正数
 * @param at 窗口锚点（逻辑当前时间）；缺省取条目中的最大时间
 */
export function evaluateWindowEntries(
  entries: readonly WindowMessage[],
  windowSeconds: number,
  at?: number,
): WindowEvaluation {
  const span = normalizeWindowSeconds(windowSeconds);
  if (entries.length === 0) {
    return summarize([], 0, span);
  }

  let anchor = at !== undefined && Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(anchor)) {
    for (const entry of entries) {
      if (Number.isFinite(entry.at) && entry.at > anchor) {
        anchor = entry.at;
      }
    }
  }
  if (!Number.isFinite(anchor)) {
    return summarize([], 0, span);
  }

  const boundary = anchor - span * 1000;
  const samples: EffectiveSample[] = [];
  let totalMessages = 0;
  for (const entry of entries) {
    if (!(entry.at > boundary)) {
      continue;
    }
    totalMessages += 1;
    const sample = buildSample(entry.message);
    if (sample !== null) {
      samples.push(sample);
    }
  }

  return summarize(samples, totalMessages, span);
}

/**
 * 评估一个消息数组（对外主入口）。
 *
 * 窗口锚点取数组中最大的合法 `timestamp`，只统计
 * `timestamp > anchor - windowSeconds × 1000` 的消息——与触发器的窗口边界语义一致。
 * 非法时间戳的消息既不推进锚点，也不参与统计。
 */
export function evaluateWindow(
  messages: readonly ChatMessage[],
  windowSeconds: number,
): WindowEvaluation {
  const span = normalizeWindowSeconds(windowSeconds);
  if (messages.length === 0) {
    return summarize([], 0, span);
  }

  let anchor = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if (Number.isFinite(message.timestamp) && message.timestamp > anchor) {
      anchor = message.timestamp;
    }
  }
  if (!Number.isFinite(anchor)) {
    return summarize([], 0, span);
  }

  const boundary = anchor - span * 1000;
  const samples: EffectiveSample[] = [];
  let totalMessages = 0;
  for (const message of messages) {
    if (!(message.timestamp > boundary)) {
      continue;
    }
    totalMessages += 1;
    const sample = buildSample(message);
    if (sample !== null) {
      samples.push(sample);
    }
  }

  return summarize(samples, totalMessages, span);
}
