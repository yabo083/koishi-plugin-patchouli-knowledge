/**
 * 投递策略解析：cron 语法 / 下一次触发时刻 / 周期键 / 策略表清洗与严格校验。
 *
 * 纯函数、无 IO、无定时器：状态与调度在 `delivery-state.ts` / `delivery-gate.ts`，
 * 这里只回答「这条策略下一次该在什么时候投」「这个键是不是合法策略键」。
 *
 * 时区一律 `Asia/Shanghai`，本地年月日时分**只从 `Intl.DateTimeFormat` 取**，
 * 绝不手算 UTC 偏移（偏移量在 `offsetMsAt` 里由同一份本地时间反推）。
 */

import type { TargetPolicies, TargetPolicy } from '../types';
import { ALBUM_TARGET_PATTERN, CHAT_TARGET } from './subscriptions';

/**
 * cron 的归一形状（标准 5 字段：分 时 日 月 周）。
 *
 * 分钟 / 小时恒为非空升序数组；日 / 月 / 周用 `null` 表示 `*`（不设限）——
 * 「空数组」与「通配」在语义上是两件事，不能合并成同一个值。
 */
export interface CronSpec {
  /** 分（0–59），升序。 */
  minutes: number[];
  /** 时（0–23），升序。 */
  hours: number[];
  /** 日（1–31）；`null` = `*`。 */
  daysOfMonth: number[] | null;
  /** 月（1–12）；`null` = `*`。 */
  months: number[] | null;
  /** 周（0=周日 … 6=周六）；`null` = `*`。不认 7=周日，避免与 0 两套口径。 */
  daysOfWeek: number[] | null;
}

/** 策略表项数上限（与 `settings.json` 的清洗口径一致）。 */
export const MAX_TARGET_POLICIES = 256;

/** 单周期额度上限（词条 / 日、周报 / 周共用）；不设上限会让一份脏文件写出天文数字。 */
export const MAX_PERIOD_QUOTA = 999;

/** cron 文本长度上限：脏文件不得把长字符串带进解析器。 */
export const MAX_CRON_CHARS = 120;

/** 策略键长度上限（`<来源群>\u0000<目标键>`）。 */
export const MAX_POLICY_KEY_CHARS = 256;

/** 目标键（`@chat:<来源群>` 或 `群号/相册ID`）长度上限。 */
export const MAX_TARGET_CHARS = 160;

/** 来源群号长度上限。 */
const MAX_SOURCE_CHARS = 64;

/** 下一次触发的搜索上界（天）：覆盖「闰日 + 每月 31 号」这类最长空档。 */
const MAX_CRON_LOOKAHEAD_DAYS = 366 * 8;

/** 各月最长天数；2 月按闰年 29 天算（闰日是合法日期，只是要等到下一个闰年）。 */
const MONTH_MAX_DAYS: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/* `cron` 是旧版单一定时字段：归一阶段按 `entryCron` 的别名读（见 `normalizePolicy`），
   写盘只写 `entryCron` / `weeklyCron`。 */
const POLICY_FIELDS: Readonly<Record<string, true>> = {
  entryCron: true,
  weeklyCron: true,
  perDay: true,
  perWeek: true,
  cron: true,
};

/** 策略键分隔符：来源群与目标键之间（两者都不会含 NUL）。 */
const POLICY_KEY_SEPARATOR = '\u0000';

/** 无策略：立即投、不限量。读路径缺键时的唯一缺省值。 */
export const DEFAULT_POLICY: TargetPolicy = Object.freeze({
  entryCron: '',
  weeklyCron: '',
  perDay: 0,
  perWeek: 0,
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
 * cron 语法
 * ------------------------------------------------------------------ */

interface CronField {
  /** 取值是否覆盖整个字段区间（通配、或步进 1）：日 / 周据此判断「是否设限」。 */
  wildcard: boolean;
  values: number[];
}

const DIGITS_RE = /^\d+$/u;

/**
 * 单个 cron 字段：`*` / `a` / `a-b` / 步进（`a/n`、`a-b/n`，通配步进写作 `*` 加 `/n`），逗号可并列。
 *
 * 越界 / 空段 / 步长为 0 / 倒序区间一律 `null`（调用方据此判定整条 cron 非法）。
 */
function parseCronField(text: string, min: number, max: number): CronField | null {
  if (text === '') return null;
  const values = new Set<number>();
  for (const part of text.split(',')) {
    if (part === '') return null;
    const slash = part.indexOf('/');
    const base = slash >= 0 ? part.slice(0, slash) : part;
    let step = 1;
    if (slash >= 0) {
      const stepText = part.slice(slash + 1);
      if (!DIGITS_RE.test(stepText)) return null;
      step = Number(stepText);
      if (step < 1) return null;
    }
    let from: number;
    let to: number;
    if (base === '*') {
      from = min;
      to = max;
    } else {
      const dash = base.indexOf('-');
      if (dash >= 0) {
        const fromText = base.slice(0, dash);
        const toText = base.slice(dash + 1);
        if (!DIGITS_RE.test(fromText) || !DIGITS_RE.test(toText)) return null;
        from = Number(fromText);
        to = Number(toText);
      } else {
        if (!DIGITS_RE.test(base)) return null;
        from = Number(base);
        // `a/n` = 从 a 起每 n 个到区间上界（标准 cron 简写）；单个 `a` 只是一个值。
        to = slash >= 0 ? max : from;
      }
      if (from < min || to > max || from > to) return null;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  const sorted = [...values].sort((left, right) => left - right);
  return { wildcard: sorted.length === max - min + 1, values: sorted };
}

/**
 * 「日 × 月」组合在该日历上是否可能命中。
 *
 * 只有「设了日、没设周」才可能永远空转：日与周同时设限取并集（周字段每月都能命中），
 * 只设周同样每月都有。剩下的逐个已列月份检查：有没有一个不超过该月天数的日。
 * `0 0 31 2 *`（2 月只有 28 / 29 天）命中不了任何日期——放它进去等于让
 * `nextCronAt` 搜满 8 年上界，再把一次「永不到点」折算成一次立刻外发。
 */
function cronDaysReachable(daysOfMonth: readonly number[], months: readonly number[] | null): boolean {
  for (let month = 1; month <= MONTH_MAX_DAYS.length; month += 1) {
    if (months !== null && !months.includes(month)) continue;
    const maxDay = MONTH_MAX_DAYS[month - 1];
    if (daysOfMonth.some((day) => day <= maxDay)) return true;
  }
  return false;
}

/**
 * 解析 5 字段 cron；非法（字段数不符 / 越界 / 空段 / 步长 0 / 超长 / 日历上永不发生）一律
 * `null`，绝不抛。
 *
 * 字段：`分 时 日 月 周`。周字段 0=周日 … 6=周六（不认 7）。
 * 日与周**同时**设限时按标准 cron 语义取并集（任一命中即触发）。
 */
export function parseCron(text: string): CronSpec | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > MAX_CRON_CHARS) return null;
  const fields = trimmed.split(/\s+/u);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const daysOfWeek = parseCronField(fields[4], 0, 6);
  if (
    minutes === null ||
    hours === null ||
    daysOfMonth === null ||
    months === null ||
    daysOfWeek === null
  ) {
    return null;
  }
  if (
    !daysOfMonth.wildcard &&
    daysOfWeek.wildcard &&
    !cronDaysReachable(daysOfMonth.values, months.wildcard ? null : months.values)
  ) {
    return null;
  }
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.wildcard ? null : daysOfMonth.values,
    months: months.wildcard ? null : months.values,
    daysOfWeek: daysOfWeek.wildcard ? null : daysOfWeek.values,
  };
}

/** 该本地日期是否命中 spec 的「日 / 月 / 周」三字段。 */
function cronDayMatches(spec: CronSpec, date: CivilDate): boolean {
  if (spec.months !== null && !spec.months.includes(date.month)) return false;
  if (spec.daysOfMonth === null && spec.daysOfWeek === null) return true;
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const dayOk = spec.daysOfMonth === null || spec.daysOfMonth.includes(date.day);
  const weekOk = spec.daysOfWeek === null || spec.daysOfWeek.includes(weekday);
  // 标准 cron：日与周同时设限时取并集；只设一个时只认那一个。
  if (spec.daysOfMonth !== null && spec.daysOfWeek !== null) return dayOk || weekOk;
  return spec.daysOfMonth !== null ? dayOk : weekOk;
}

/**
 * 下一次触发时刻（epoch ms，**严格大于** `at`）。
 *
 * 严格大于而不是大于等于：`at` 恰好落在触发点上时，这一刻已经不是「下一次」了——
 * 让事件晚一天，也好过与已经发生的那一轮挤在同一分钟。
 *
 * 非法 spec（`null`）返回 `at`（= 立即投），调用方不必再分支。
 */
export function nextCronAt(spec: CronSpec | null, at: number): number {
  if (spec === null) return at;
  const local = localTimeAt(at);
  const today: CivilDate = { year: local.year, month: local.month, day: local.day };
  for (let offset = 0; offset <= MAX_CRON_LOOKAHEAD_DAYS; offset += 1) {
    const date = shiftCivilDate(today, offset);
    if (!cronDayMatches(spec, date)) continue;
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const candidate = epochFromLocal(date.year, date.month, date.day, hour * 60 + minute);
        if (candidate > at) return candidate;
      }
    }
  }
  /* 合法 spec 在 8 年内必命中（2 月 29 日最坏 8 年一轮；永不发生的日 / 月组合已被
     `parseCron` 拒掉）。兜底只为类型闭合：**绝不**折算成「立即投」——那会把一次排期
     错误变成一次立刻外发。排在搜索上界之后，等于「排不进任何明确时刻」。 */
  return at + MAX_CRON_LOOKAHEAD_DAYS * DAY_MS;
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
 * 策略表：键形状 / 清洗（读文件）/ 严格校验（POST）
 * ------------------------------------------------------------------ */

/** 来源群号：非空、非通配、无空白与控制字符。 */
function isPolicySource(source: string): boolean {
  if (source.length === 0 || source.length > MAX_SOURCE_CHARS || source === '*') return false;
  return !/[\s\u0000-\u001F\u007F]/u.test(source);
}

/** 目标键：`@chat:<来源群>` 或 `群号/相册ID`（`@chat` 必须带来源，不接受通配）。 */
function isPolicyTarget(target: string): boolean {
  if (target.length === 0 || target.length > MAX_TARGET_CHARS) return false;
  const prefix = `${CHAT_TARGET}:`;
  if (target.startsWith(prefix)) return isPolicySource(target.slice(prefix.length));
  return ALBUM_TARGET_PATTERN.test(target);
}

/** 策略键：`<来源群>\u0000<目标键>`——同一个投递群在不同监听群下各有一份策略。 */
export function policyKey(source: string, target: string): string {
  return `${source.trim()}${POLICY_KEY_SEPARATOR}${target.trim()}`;
}

/** 策略键 → `{ source, target }`；形状不符返回 `undefined`（不抛）。 */
export function splitPolicyKey(key: string): { source: string; target: string } | undefined {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_POLICY_KEY_CHARS) return undefined;
  const cut = key.indexOf(POLICY_KEY_SEPARATOR);
  if (cut <= 0) return undefined;
  if (key.indexOf(POLICY_KEY_SEPARATOR, cut + 1) >= 0) return undefined;
  const source = key.slice(0, cut);
  const target = key.slice(cut + 1);
  if (!isPolicySource(source) || !isPolicyTarget(target)) return undefined;
  return { source, target };
}

/** 键形状校验（含 NUL 的两段：来源群 + 目标键）。 */
export function isPolicyKey(key: string): boolean {
  return splitPolicyKey(key) !== undefined;
}

/**
 * 单个 cron 字段归一：去首尾空白，空串 = 立即投，非法表达式 → `null`（整条策略非法）。
 *
 * `undefined` / `null` 按缺省（空串）处理：策略字段可局部给出，缺省即「立即投」。
 */
function normalizeCronField(value: unknown): string | null {
  const raw = value ?? '';
  if (typeof raw !== 'string') return null;
  const cron = raw.trim();
  if (cron !== '' && parseCron(cron) === null) return null;
  return cron;
}

/**
 * 单条策略归一；非法返回 `null`（不抛）。
 *
 * 字段收敛为 `{ entryCron, weeklyCron, perDay, perWeek }`：两个 cron 空串 = 该类事件立即投，
 * 额度 0 = 不限量。旧版只有一个 `cron`（两类事件共用一个时间）——没有 `entryCron` 时
 * 把它读成 `entryCron`、`weeklyCron` 置空，写盘只写新字段。
 * 抖动与随机间隔是投递逻辑的内部常量，不由用户配置——策略表里没有它们的字段。
 */
export function normalizePolicy(input: unknown): TargetPolicy | null {
  if (!isPlainObject(input)) return null;

  const entryCron = normalizeCronField(input.entryCron === undefined ? input.cron : input.entryCron);
  const weeklyCron = normalizeCronField(input.weeklyCron);
  if (entryCron === null || weeklyCron === null) return null;

  const perDay = boundedInt(input.perDay ?? 0, MAX_PERIOD_QUOTA);
  const perWeek = boundedInt(input.perWeek ?? 0, MAX_PERIOD_QUOTA);
  if (perDay === null || perWeek === null) return null;

  return { entryCron, weeklyCron, perDay, perWeek };
}

/** 该投递类型用哪一条定时：词条用 `entryCron`，周报用 `weeklyCron`（空串 = 立即投）。 */
export function cronForKind(policy: TargetPolicy, kind: 'entry' | 'weekly'): string {
  return kind === 'entry' ? policy.entryCron : policy.weeklyCron;
}

/** 策略是否等于缺省（两个 cron 都立即投 / 不限量）：面板据此把这一项从表里删掉。 */
export function isDefaultPolicy(policy: TargetPolicy): boolean {
  return policy.entryCron === '' && policy.weeklyCron === '' && policy.perDay === 0 && policy.perWeek === 0;
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
    if (splitPolicyKey(key) === undefined) {
      return {
        ok: false,
        error: `policies 键非法：${JSON.stringify(key)}（必须是 <来源群>\\u0000<@chat:来源群 | 群号/相册ID>）`,
      };
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
        error: `policies[${key}] 字段非法（entryCron / weeklyCron 需为 5 字段表达式，且日期必须真实存在（如 2 月 31 日不收） / perDay ≤ ${MAX_PERIOD_QUOTA} / perWeek ≤ ${MAX_PERIOD_QUOTA}）`,
      };
    }
    value[key] = policy;
  }
  return { ok: true, value };
}
