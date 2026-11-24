/**
 * 投递策略解析：窗口文本 / 时区 / 窗口命中 / 下一个窗口首刻 / 抖动落点 / 周期键。
 *
 * 纯函数、无 IO、无定时器：状态与调度在 `delivery-state.ts` / `delivery-gate.ts`，
 * 这里只回答「这一刻在不在窗口内」「下一次窗口什么时候开」「这条事件该排到哪个时刻」。
 *
 * 时区一律 `Asia/Shanghai`，本地年月日时分**只从 `Intl.DateTimeFormat` 取**，
 * 绝不手算 UTC 偏移（偏移量在 `offsetMsAt` 里由同一份本地时间反推）。
 */

import type { TargetPolicies, TargetPolicy } from '../types';
import { ALBUM_TARGET_PATTERN } from './subscriptions';

/** 投递窗口的归一形状（分钟口径，左闭右开）。 */
export interface WindowSpec {
  /** 命中的星期（0=周日，1=周一 … 6=周六），`*` 的形式即全集。 */
  days: number[];
  /** 窗口开始：本地当日第几分钟（0–1439）。 */
  startMin: number;
  /** 窗口结束：本地当日第几分钟；跨午夜时 **> 1440**（相对开始日）。 */
  endMin: number;
  /** 窗口内随机抖动上界（分钟）；0 = 不抖动。 */
  jitterMinutes: number;
}

/** 策略表项数上限（与 `settings.json` 的清洗口径一致）。 */
export const MAX_TARGET_POLICIES = 256;

/** 单周期额度上限（词条 / 日、周报 / 周共用）；不设上限会让一份脏文件写出天文数字。 */
export const MAX_PERIOD_QUOTA = 999;

/** 抖动上限（分钟）：一天。窗口更长也不会用到更多。 */
export const MAX_JITTER_MINUTES = 1440;

/** 策略键长度上限（`@chat:<来源群>` 或 `群号/相册ID`）。 */
export const MAX_POLICY_KEY_CHARS = 160;

/** 窗口文本长度上限：脏文件不得把长字符串带进解析器。 */
const MAX_WINDOW_CHARS = 120;

/** 来源群号（`@chat:` 后缀）长度上限。 */
const MAX_SOURCE_CHARS = 64;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];
const DAY_MINUTES = 1440;
const POLICY_FIELDS: Readonly<Record<string, true>> = {
  window: true,
  entryPerDay: true,
  weeklyPerWeek: true,
  jitterMinutes: true,
};

/** 无策略：全天、不限量、不抖动。读路径缺键时的唯一缺省值。 */
export const DEFAULT_POLICY: TargetPolicy = Object.freeze({
  window: '',
  entryPerDay: 0,
  weeklyPerWeek: 0,
  jitterMinutes: 0,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非负整数且在 `max` 以内；否则 `null`（调用方据此判定非法）。 */
function boundedInt(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

/* ------------------------------------------------------------------ *
 * 时区：本地年月日时分秒（Asia/Shanghai）
 * ------------------------------------------------------------------ */

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=周日 … 6=周六（由本地年月日按公历反推，不依赖宿主时区）。 */
  weekday: number;
}

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const found = parts.find((part) => part.type === type);
  return found === undefined ? Number.NaN : Number(found.value);
}

/** 某一时刻在 `Asia/Shanghai` 的本地时间。 */
function localTimeAt(at: number): LocalTime {
  const parts = SHANGHAI_FORMATTER.formatToParts(new Date(at));
  const year = partValue(parts, 'year');
  const month = partValue(parts, 'month');
  const day = partValue(parts, 'day');
  return {
    year,
    month,
    day,
    hour: partValue(parts, 'hour'),
    minute: partValue(parts, 'minute'),
    second: partValue(parts, 'second'),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** 该时刻的本地偏移（毫秒）：由同一份本地时间反推，不假定 +08:00。 */
function offsetMsAt(at: number): number {
  const local = localTimeAt(at);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** 本地「年月日 + 当日第几分钟」→ epoch ms（跨日 / 跨午夜由分钟数自然溢出）。 */
function epochFromLocal(year: number, month: number, day: number, minuteOfDay: number): number {
  const wallClock = Date.UTC(year, month - 1, day, 0, 0, 0) + minuteOfDay * MINUTE_MS;
  const candidate = wallClock - offsetMsAt(wallClock);
  const corrected = wallClock - offsetMsAt(candidate);
  // Asia/Shanghai 无夏令时，一步即收敛；这一步只为「偏移变化时仍然正确」兜底。
  return corrected === candidate ? candidate : wallClock - offsetMsAt(corrected);
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** 本地日期加减天数（公历运算，不涉及时区）。 */
function shiftCivilDate(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/* ------------------------------------------------------------------ *
 * 窗口语法
 * ------------------------------------------------------------------ */

const TIME = String.raw`(\d{1,2}):(\d{2})`;
/** `* HH:MM[-HH:MM] [~N]` 与 `W HH:MM[-HH:MM] [~N]`。 */
const DAY_WINDOW_RE = new RegExp(
  String.raw`^(?:\*|([0-6]))\s+${TIME}(?:\s*-\s*${TIME})?(?:\s*~\s*(\d{1,4}))?$`,
  'u',
);
/** `HH:MM-HH:MM [~N]`：每天该区间（不带前缀 = 每天）。 */
const ANY_DAY_RANGE_RE = new RegExp(String.raw`^${TIME}\s*-\s*${TIME}(?:\s*~\s*(\d{1,4}))?$`, 'u');

function clockMinute(hourText: string, minuteText: string): number | null {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || hour > 23) return null;
  if (!Number.isInteger(minute) || minute > 59) return null;
  return hour * 60 + minute;
}

function jitterValue(text: string | undefined): number | null {
  if (text === undefined) return 0;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= MAX_JITTER_MINUTES ? value : null;
}

/**
 * 解析窗口文本；非法（含超长 / 未知形状 / 时刻越界 / 零长窗口）一律 `null`，绝不抛。
 *
 * 支持的四种写法：
 * - `* HH:MM-HH:MM` 每天该区间
 * - `W HH:MM-HH:MM` 周 W 该区间（0=周日，1=周一）
 * - `W HH:MM` 该日一分钟窗口
 * - `HH:MM-HH:MM` 每天该区间（`22:00-02:00` = 跨午夜，归开始日）
 *
 * 末尾可带 `~N`：窗口内抖动上界（分钟）。`* HH:MM` 是一分钟窗口的同样推广。
 */
export function parseWindow(text: string): WindowSpec | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WINDOW_CHARS) return null;

  const dayMatch = DAY_WINDOW_RE.exec(trimmed);
  if (dayMatch !== null) {
    const [, dayText, startHour, startMinute, endHour, endMinute, jitterText] = dayMatch;
    const start = clockMinute(startHour, startMinute);
    if (start === null) return null;
    const jitter = jitterValue(jitterText);
    if (jitter === null) return null;
    let end: number;
    if (endHour === undefined || endMinute === undefined) {
      end = start + 1;
    } else {
      const rawEnd = clockMinute(endHour, endMinute);
      if (rawEnd === null || rawEnd === start) return null;
      end = rawEnd < start ? rawEnd + DAY_MINUTES : rawEnd;
    }
    const days = dayText === undefined ? [...ALL_DAYS] : [Number(dayText)];
    return { days, startMin: start, endMin: end, jitterMinutes: jitter };
  }

  const rangeMatch = ANY_DAY_RANGE_RE.exec(trimmed);
  if (rangeMatch !== null) {
    const [, startHour, startMinute, endHour, endMinute, jitterText] = rangeMatch;
    const start = clockMinute(startHour, startMinute);
    const rawEnd = clockMinute(endHour, endMinute);
    const jitter = jitterValue(jitterText);
    if (start === null || rawEnd === null || jitter === null || rawEnd === start) return null;
    return {
      days: [...ALL_DAYS],
      startMin: start,
      endMin: rawEnd < start ? rawEnd + DAY_MINUTES : rawEnd,
      jitterMinutes: jitter,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 窗口命中 / 下一窗口 / 抖动落点
 * ------------------------------------------------------------------ */

interface WindowRange {
  /** 窗口首刻（epoch ms）。 */
  start: number;
  /** 窗口右边界（epoch ms，**不含**）。 */
  end: number;
}

/** `at` 落在的窗口（含跨午夜归属开始日）；不在任何窗口内返回 `null`。 */
function currentWindow(spec: WindowSpec, at: number): WindowRange | null {
  const local = localTimeAt(at);
  const minute = local.hour * 60 + local.minute;
  const crossing = spec.endMin > DAY_MINUTES;
  const tailMinutes = crossing ? spec.endMin - DAY_MINUTES : 0;
  const today: CivilDate = { year: local.year, month: local.month, day: local.day };

  for (const day of spec.days) {
    if (!crossing) {
      if (local.weekday !== day || minute < spec.startMin || minute >= spec.endMin) continue;
    } else if (local.weekday === day && minute >= spec.startMin) {
      // 开始日当天，已过首刻。
    } else if (local.weekday === (day + 1) % 7 && minute < tailMinutes) {
      // 跨午夜的尾巴：窗口属于**前一天**（开始日）。
      const startDay = shiftCivilDate(today, -1);
      return {
        start: epochFromLocal(startDay.year, startDay.month, startDay.day, spec.startMin),
        end: epochFromLocal(today.year, today.month, today.day, tailMinutes),
      };
    } else {
      continue;
    }
    return {
      start: epochFromLocal(today.year, today.month, today.day, spec.startMin),
      end: epochFromLocal(today.year, today.month, today.day, spec.endMin),
    };
  }
  return null;
}

/** `at` 是否落在窗口内（左闭右开；跨午夜窗口的尾巴归开始日）。 */
export function windowContains(spec: WindowSpec, at: number): boolean {
  return currentWindow(spec, at) !== null;
}

/**
 * 下一次窗口首刻（epoch ms，`>= at`）。
 *
 * 「下一次开窗」而不是「当前窗口的首刻」：正在窗口里时返回的是**下一个**窗口的首刻，
 * 这样调用方不必区分「已在窗口内」与「还没开窗」——前者直接投递，后者才排到首刻。
 */
export function nextWindowStart(spec: WindowSpec, at: number): number {
  const local = localTimeAt(at);
  const today: CivilDate = { year: local.year, month: local.month, day: local.day };
  // 0–7：任意非空 `days` 在 8 天内必有一日；偏移 7 覆盖「今天已过首刻」的同一星期。
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = shiftCivilDate(today, offset);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (!spec.days.includes(weekday)) continue;
    const start = epochFromLocal(date.year, date.month, date.day, spec.startMin);
    if (start >= at) return start;
  }
  // `parseWindow` 保证 `days` 非空且取值在 0–6，循环必然命中；兜底只为类型闭合。
  return at;
}

/** 从已知首刻反推该窗口右边界（按开始日的本地日期 + 归一后的 `endMin`）。 */
function windowEndFromStart(spec: WindowSpec, start: number): number {
  const local = localTimeAt(start);
  return epochFromLocal(local.year, local.month, local.day, spec.endMin);
}

/**
 * 这条事件该排到哪个时刻（epoch ms）。
 *
 * - 无窗口（`null` / 空窗口）：`at` 立即投递。
 * - 已在窗口内：`at` 起随时可投；有抖动时取 `[窗口首刻, 首刻+抖动]` 里的随机点，
 *   但**不早于 `at`**（已经等到现在的不能倒流）。
 * - 不在窗口内：排到下一次开窗首刻 + 抖动。
 * - 抖动绝不越过窗口右边界（右开：最晚取 `end - 1`）。
 *
 * `random` 返回 `[0, 1)`；结果完全由 `spec` + `at` + `random()` 决定，调用方负责落库
 * （重启不得重算，见 SCHED-10）。
 */
export function deliverAtFor(spec: WindowSpec | null, at: number, random: () => number): number {
  if (spec === null) return at;

  const open = currentWindow(spec, at);
  const start = open === null ? nextWindowStart(spec, at) : open.start;
  if (spec.jitterMinutes <= 0) return open === null ? start : at;

  const end = open === null ? windowEndFromStart(spec, start) : open.end;
  const jitterMs = spec.jitterMinutes * MINUTE_MS;
  const latest = Math.min(start + jitterMs, end - 1);
  const drawn = start + Math.floor(random() * (jitterMs + 1));
  const scheduled = Math.min(drawn, latest);
  return open === null ? scheduled : Math.max(at, scheduled);
}

/* ------------------------------------------------------------------ *
 * 周期键
 * ------------------------------------------------------------------ */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * 事件所属周期的键（惰性清零用）。
 *
 * - 词条：上海本地日期 `YYYY-MM-DD`（本地 00:00 切日）。
 * - 周报：ISO 周 `YYYY-Www`（周一起；跨年按 ISO 归属年）。两种键形状不重叠。
 */
export function periodKeyFor(kind: 'entry' | 'weekly', at: number): string {
  const local = localTimeAt(at);
  if (kind === 'entry') return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}`;

  // ISO 8601：该周的周四决定归属年（周四所在年份 = 该周的年）。
  const thursday = new Date(Date.UTC(local.year, local.month - 1, local.day));
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = Date.UTC(isoYear, 0, 4);
  const week = 1 + Math.round((thursday.getTime() - firstThursday) / (7 * DAY_MS));
  return `${pad(isoYear, 4)}-W${pad(week)}`;
}

/* ------------------------------------------------------------------ *
 * 策略表：清洗（读文件）/ 严格校验（POST）
 * ------------------------------------------------------------------ */

/** 键形状：`@chat:<来源群>`（必须带来源、不接受通配 `*`）或 `群号/相册ID`。 */
export function isPolicyKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_POLICY_KEY_CHARS) return false;
  if (key.startsWith('@chat:')) {
    const source = key.slice('@chat:'.length);
    if (source.length === 0 || source.length > MAX_SOURCE_CHARS || source === '*') return false;
    return !/[\s\u0000-\u001F\u007F]/u.test(source);
  }
  return ALBUM_TARGET_PATTERN.test(key);
}

/**
 * 单条策略归一；非法返回 `null`（不抛）。
 *
 * `window` 文本里若带 `~N` 后缀，归一为 `jitterMinutes = N` 并**从文本里去掉后缀**：
 * 抖动只有一个真源（字段），文本不会与字段各说一套。字段缺省 = 0，窗口缺省 = 空。
 */
export function normalizePolicy(input: unknown): TargetPolicy | null {
  if (!isPlainObject(input)) return null;

  const rawWindow = input.window ?? '';
  if (typeof rawWindow !== 'string') return null;
  const spec = parseWindow(rawWindow);
  if (rawWindow.trim() !== '' && spec === null) return null;

  const entryPerDay = boundedInt(input.entryPerDay ?? 0, MAX_PERIOD_QUOTA);
  const weeklyPerWeek = boundedInt(input.weeklyPerWeek ?? 0, MAX_PERIOD_QUOTA);
  const fieldJitter = boundedInt(input.jitterMinutes ?? 0, MAX_JITTER_MINUTES);
  if (entryPerDay === null || weeklyPerWeek === null || fieldJitter === null) return null;

  const suffixJitter = spec === null ? 0 : spec.jitterMinutes;
  const jitterMinutes = suffixJitter > 0 ? suffixJitter : fieldJitter;
  const window = suffixJitter > 0 ? rawWindow.replace(/\s*~\s*\d{1,4}\s*$/u, '').trim() : rawWindow.trim();
  return { window, entryPerDay, weeklyPerWeek, jitterMinutes };
}

/**
 * 读路径清洗：非法项 / 非法键静默丢弃，最多 `MAX_TARGET_POLICIES` 项（按文件顺序截断）。
 * 一份脏 `settings.json` 绝不能变成「插件起不来」或「策略意外全开」。
 */
export function parsePolicies(input: unknown): TargetPolicies {
  const policies: TargetPolicies = {};
  if (!isPlainObject(input)) return policies;
  let kept = 0;
  for (const [key, value] of Object.entries(input)) {
    if (kept >= MAX_TARGET_POLICIES) break;
    if (!isPolicyKey(key)) continue;
    const policy = normalizePolicy(value);
    if (policy === null) continue;
    policies[key] = policy;
    kept += 1;
  }
  return policies;
}

/** 写路径校验结果（面板 400 / 放行）。 */
export type PolicyPatchResult =
  | { readonly ok: true; readonly value: TargetPolicies }
  | { readonly ok: false; readonly error: string };

/**
 * 面板补丁的严格校验：非对象 / 超限 / 键形状不符 / 未知字段 / 非法值一律拒绝（400），
 * 不做「猜一个合法值」的静默替换。缺省字段按 0（无限制）补齐——整张表由面板给出。
 */
export function validatePolicies(input: unknown): PolicyPatchResult {
  if (!isPlainObject(input)) return { ok: false, error: 'policies 必须是对象' };
  const keys = Object.keys(input);
  if (keys.length > MAX_TARGET_POLICIES) {
    return { ok: false, error: `policies 最多 ${MAX_TARGET_POLICIES} 项（收到 ${keys.length}）` };
  }
  const value: TargetPolicies = {};
  for (const key of keys) {
    if (!isPolicyKey(key)) {
      return { ok: false, error: `policies 键非法：${JSON.stringify(key)}（只能是 @chat:<来源群> 或 群号/相册ID）` };
    }
    const raw = input[key];
    if (!isPlainObject(raw)) return { ok: false, error: `policies[${key}] 必须是对象` };
    for (const field of Object.keys(raw)) {
      if (!Object.hasOwn(POLICY_FIELDS, field)) {
        return { ok: false, error: `policies[${key}] 含未知字段 ${JSON.stringify(field)}` };
      }
    }
    const policy = normalizePolicy(raw);
    if (policy === null) {
      return {
        ok: false,
        error: `policies[${key}] 字段非法（window 语法 / entryPerDay ≤ ${MAX_PERIOD_QUOTA} / weeklyPerWeek ≤ ${MAX_PERIOD_QUOTA} / jitterMinutes ≤ ${MAX_JITTER_MINUTES}）`,
      };
    }
    value[key] = policy;
  }
  return { ok: true, value };
}

/**
 * 策略 → 窗口形状（唯一的「策略字段 ⊕ 窗口文本」合成点）。
 *
 * 空窗口 / 非法窗口返回 `null`（= 立即投递），抖动只取 `policy.jitterMinutes`。
 */
export function windowSpecFor(policy: TargetPolicy): WindowSpec | null {
  const spec = parseWindow(policy.window);
  if (spec === null) return null;
  const jitter = boundedInt(policy.jitterMinutes, MAX_JITTER_MINUTES);
  return { ...spec, jitterMinutes: jitter === null ? 0 : jitter };
}
