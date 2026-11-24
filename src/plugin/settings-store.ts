/**
 * 运行时设置覆盖层（`.patchouli/settings.json`）。
 *
 * 宿主 `koishi.yml` 的插件页只保留六块高频配置（模型 / 启用 / 订阅表 / 功能总闸 /
 * 知识库目录 / 面板密钥），触发算法、主题校准、素材池、长图与裁判这些「调参面」
 * 改由自建面板写入本文件。四条硬契约：
 *
 * 1. **绝不写宿主 config**（ADR-022）：覆盖值只落盘在自己的文件里，
 *    运行时按「覆盖 > config > Schema 默认值」合并读取；
 * 2. **物理有界**：段与键白名单来自 `SETTINGS_META`，未知键丢弃、非法值拒绝，
 *    `sections` 里只有几十个标量；结构化键只有顶层 `subscriptions`
 *    （订阅表：≤256 行、单行 ≤16 个目标）与 `targetBindings`
 *    （名字 → 稳定地址：≤1024 项、名字 ≤192 字符、值必须是 `群号/相册ID`），
 *    读盘时静默清洗，其余一律不进内存；
 * 3. **原子写 + 串行**：同一路径的读改写按进程内队列排队，temp 文件各自独立、
 *    最后一次 `rename` 一定是完整文档，断电不会留下半截 JSON；
 * 4. **单文档**：标量段与订阅表同住一个文件，写任一侧都读出整份文档再整份落盘，
 *    不会互相抹掉。
 */

import { promises as fs, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { resolveWikiLayout } from '../wiki/layout';
import { normalizeTriggerOptions } from '../trigger/detector';
import type { SubscriptionRow, TargetPolicies, TargetPolicy, TriggerOptions } from '../types';
import {
  ALBUM_TARGET_PATTERN,
  CHAT_TARGET,
  MAX_SUBSCRIPTION_TARGET_CHARS,
  TARGET_GROUP_PREFIX,
  normalizeSubscriptionRows,
} from './subscriptions';
import { MAX_TARGET_POLICIES, parsePolicies } from './policy-resolve';

/** 面板可调的五个段（顺序即 GET 响应里的展示顺序）。 */
export const SETTINGS_SECTIONS = ['trigger', 'topics', 'media', 'query', 'judge'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** 覆盖层的值只允许是标量 / 字符串枚举。 */
export type SettingsValue = number | boolean | string;

/** 单段覆盖值（只含白名单键，且都已通过校验）。 */
export type SettingsSectionPatch = Record<string, SettingsValue>;

/** 整份覆盖层：缺段 = 没有覆盖，运行时回落到 config。 */
export type SettingsOverrides = Partial<Record<SettingsSection, SettingsSectionPatch>>;

/** 字段类型：面板据此渲染开关 / 数字框 / 文本框 / 下拉。 */
export type SettingsFieldType = 'number' | 'boolean' | 'string' | 'enum';

/**
 * 单字段元数据。
 *
 * 手写而不是从 Schema 反射生成：面板文案与上下限要稳定可控，Schema 的
 * `description` 是给控制台看的整句说明，不适合当行内 label。
 */
export interface SettingsFieldMeta {
  section: SettingsSection;
  key: string;
  label: string;
  type: SettingsFieldType;
  /**
   * 判据模式可见性：不写 = `potential` 与 `rate` 都显示；写了就只在列出的模式显示
   * （空数组 = 两种模式都不显示，用于仅 `shadow` 观测模式才生效的字段）。
   *
   * 标注依据是源码读取点，不是「字段名像谁」：
   * - `rate` 专属：`BurstQuiescenceDetector` 的速率路径才会读到；
   * - `potential` 专属：`PotentialTracker` / 势能门限 / 势能结算才读到；
   * - 两模式共用：两侧的相位裁决与结算脚手架都会读（如 `quiescenceSeconds` 决定
   *   两套判据共同的平息截止时刻，`burstMultiplier` / `coolingRatioThreshold` 同时
   *   出现在 `potentialBurstThreshold` / `potentialCoolThreshold` 里）。
   */
  modes?: readonly ('potential' | 'rate')[];
  /** type === 'enum' 时的可选值（同时是校验白名单）。 */
  options?: readonly string[];
  min?: number;
  max?: number;
  /** 数字步进；`step === 1` 表示只接受整数。 */
  step?: number;
  /**
   * 字符串的字节 / 字符上限（`value.length`）。超限直接 400，绝不静默截断 ——
   * 面板显示的就是写进去的值。
   */
  maxLength?: number;
  /**
   * 密钥字段：**读**路径的值恒为空串，同段附带 `secretConfigured.<key>` 布尔；
   * **写**路径空串 = 不修改（面板回显的空串不会把已配置密钥冲掉），非空才覆盖。
   */
  secret?: boolean;
  /** URL 字段：必须是 `http(s)` 绝对地址且不含 userinfo（留空 = 用默认值）。 */
  url?: boolean;
}

/**
 * 五段的可调字段表（唯一真源）。
 *
 * `trigger.triggerMode` 只暴露 `potential` / `rate`：`shadow` 是历史观测模式，
 * 仍能被旧配置加载（Schema union 里 `.hidden()` 保留），但不再作为面板选项。
 *
 * `trigger` 段的 `modes` 按源码实际读取点标注（详见 `SettingsFieldMeta.modes`）：
 * 未标注 = 两套判据都读；`['rate']` = 只有速率判据读；`['potential']` = 只有势能判据读；
 * `[]` = 面板两种模式下都不显示（仅 `shadow` 观测模式生效的字段）。
 */
export const SETTINGS_META: readonly SettingsFieldMeta[] = [
  // ── 触发算法 ────────────────────────────────────────────────────────────
  { section: 'trigger', key: 'windowSizeSeconds', label: '发言速率窗口（秒）', type: 'number', min: 10, max: 600, step: 1, modes: ['rate'] },
  { section: 'trigger', key: 'burstMultiplier', label: '突发倍率阈值', type: 'number', min: 1, max: 20, step: 0.1 },
  { section: 'trigger', key: 'minBurstRate', label: '最低突发速率（条/分）', type: 'number', min: 0, max: 120, step: 1, modes: ['rate'] },
  { section: 'trigger', key: 'quiescenceSeconds', label: '平息静默观察期（秒）', type: 'number', min: 30, max: 3600, step: 1 },
  { section: 'trigger', key: 'coolingRatioThreshold', label: '回落常态倍率', type: 'number', min: 1, max: 5, step: 0.05 },
  { section: 'trigger', key: 'minDiscussionMessages', label: '单次沉淀最低消息数', type: 'number', min: 2, max: 200, step: 1 },
  { section: 'trigger', key: 'maxBufferMessages', label: '历史消息缓存上限', type: 'number', min: 50, max: 5000, step: 1 },
  { section: 'trigger', key: 'baselineEwmaAlpha', label: '基线平滑系数', type: 'number', min: 0.005, max: 0.5, step: 0.005 },
  { section: 'trigger', key: 'triggerMode', label: '判据模式', type: 'enum', options: ['potential', 'rate'] },
  { section: 'trigger', key: 'thetaMin', label: '势能突发阈值下限', type: 'number', min: 0, max: 500, step: 0.5, modes: ['potential'] },
  // 仅 `shadow` 观测模式读取（`potentialAutoTuning` 只在 `triggerMode === 'shadow'` 时
  // 让势能侧门限同步参与 AIMD）；面板只提供 potential / rate，故两种模式都不显示。
  { section: 'trigger', key: 'potentialAutoTuning', label: 'shadow 双门限同步调优', type: 'boolean', modes: [] },
  { section: 'trigger', key: 'dispatchMargin', label: '调度质量门倍数（0 关闭）', type: 'number', min: 0, max: 5, step: 0.05, modes: ['potential'] },
  { section: 'trigger', key: 'densityMultiplier', label: '密度基线倍率（0 用固定下限）', type: 'number', min: 0, max: 5, step: 0.05, modes: ['potential'] },
  { section: 'trigger', key: 'peakCoolFraction', label: '峰值冷却比例（0 仅基线）', type: 'number', min: 0, max: 1, step: 0.05, modes: ['potential'] },
  { section: 'trigger', key: 'rhoMin', label: '信息密度下限', type: 'number', min: 0, max: 20, step: 0.1, modes: ['potential'] },

  // ── 主题校准 ────────────────────────────────────────────────────────────
  { section: 'topics', key: 'enabled', label: '启用每日主题校准', type: 'boolean' },
  { section: 'topics', key: 'hour', label: '校准触发小时', type: 'number', min: 0, max: 23, step: 1 },
  { section: 'topics', key: 'minute', label: '校准触发分钟', type: 'number', min: 0, max: 59, step: 1 },
  { section: 'topics', key: 'mergeThreshold', label: '主题相似度阈值', type: 'number', min: 0, max: 1, step: 0.01 },
  { section: 'topics', key: 'minEntries', label: '触发校准的最少词条数', type: 'number', min: 1, max: 50, step: 1 },
  { section: 'topics', key: 'lookbackDays', label: '回看天数', type: 'number', min: 1, max: 90, step: 1 },
  { section: 'topics', key: 'maxSessionsPerRun', label: '单次最多读取会话数', type: 'number', min: 1, max: 500, step: 1 },
  { section: 'topics', key: 'maxMessagesPerSession', label: '单会话最多提交消息数', type: 'number', min: 10, max: 500, step: 1 },

  // ── 素材池 ──────────────────────────────────────────────────────────────
  { section: 'media', key: 'offline', label: '离线模式（不抓新素材）', type: 'boolean' },
  { section: 'media', key: 'lowWater', label: '可用素材水位', type: 'number', min: 0, max: 200, step: 1 },
  { section: 'media', key: 'batch', label: '单次补货数量', type: 'number', min: 1, max: 100, step: 1 },
  { section: 'media', key: 'cooldownHours', label: '离线素材冷却小时', type: 'number', min: 0, max: 168, step: 1 },
  { section: 'media', key: 'dir', label: '素材目录（留空用默认）', type: 'string', maxLength: 512 },
  { section: 'media', key: 'imageSource', label: '背景图接口地址', type: 'string', maxLength: 2048, url: true },
  { section: 'media', key: 'sayingSource', label: '一言接口地址', type: 'string', maxLength: 2048, url: true },
  { section: 'media', key: 'apiKey', label: '素材接口密钥', type: 'string', maxLength: 512, secret: true },

  // ── 长图 ────────────────────────────────────────────────────────────────
  { section: 'query', key: 'cardMaxHeight', label: '词条长图最大高度（px）', type: 'number', min: 600, max: 20000, step: 100 },

  // ── 本地裁判 ────────────────────────────────────────────────────────────
  { section: 'judge', key: 'enabled', label: '启用本地裁判服务', type: 'boolean' },
  { section: 'judge', key: 'baseURL', label: '裁判服务地址', type: 'string', maxLength: 2048, url: true },
  { section: 'judge', key: 'apiKey', label: '裁判服务令牌', type: 'string', maxLength: 512, secret: true },
  // 模型名不是 URL，按标识符类给出与密钥同档的上限（不留无界字符串）。
  { section: 'judge', key: 'model', label: '裁判模型名', type: 'string', maxLength: 512 },
  { section: 'judge', key: 'timeoutMs', label: '单次请求超时（毫秒）', type: 'number', min: 100, max: 60000, step: 100 },
];

/** 段 → 字段表（查表校验，避免每次 patch 都扫全表）。 */
const FIELDS_BY_SECTION: Record<SettingsSection, readonly SettingsFieldMeta[]> = (() => {
  const table = {
    trigger: [],
    topics: [],
    media: [],
    query: [],
    judge: [],
  } as Record<SettingsSection, SettingsFieldMeta[]>;
  for (const field of SETTINGS_META) table[field.section].push(field);
  return table;
})();

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(SETTINGS_SECTIONS);

/**
 * 面板设置段里的密钥字段（唯一真源）。
 *
 * 契约（写死在此，前端据此渲染「已配置 / 未配置」）：
 * - **读**路径（`GET /api/settings` 与 `POST /api/settings` 的回包）值恒为空串，
 *   同段附带 `secretConfigured: { <key>: boolean }`（true = 运行态已配置非空值）；
 * - **写**路径空串 = 不修改，非空才覆盖；
 * - 运行态（`settings()` / `mergedSection()`）与磁盘文件保留真值，绝不打码。
 */
export const SETTINGS_SECRET_KEYS: Readonly<Partial<Record<SettingsSection, readonly string[]>>> = Object.freeze({
  media: Object.freeze(['apiKey']),
  judge: Object.freeze(['apiKey']),
});

/**
 * 读取路径的密钥打码：密钥位置换成空串，并在同段附带 `secretConfigured`。
 *
 * 入参按 `object` 收（`MediaConfig` / `JudgeConfig` 这类接口没有 index signature），
 * 返回的是**新对象**，调用方据此序列化给浏览器；运行态对象不受影响。
 */
export function redactSettingsSection(section: SettingsSection, values: object): Record<string, unknown> {
  const source = values as Readonly<Record<string, unknown>>;
  const redacted: Record<string, unknown> = { ...source };
  const keys = SETTINGS_SECRET_KEYS[section];
  if (keys === undefined) return redacted;
  const configured: Record<string, boolean> = {};
  for (const key of keys) {
    const value = source[key];
    configured[key] = typeof value === 'string' && value.trim().length > 0;
    redacted[key] = '';
  }
  redacted.secretConfigured = configured;
  return redacted;
}

/** 覆盖层文件路径：`<wikiDir>/.patchouli/settings.json`。 */
export function settingsPath(wikiDir: string): string {
  return nodePath.join(resolveWikiLayout(wikiDir).patchouliDir, 'settings.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldError(field: SettingsFieldMeta, reason: string): string {
  return `${field.section}.${field.key}：${reason}`;
}

/** C0 控制字符与 DEL：面板单行输入不该出现，且会破坏路径 / URL / 请求头的单行语义。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u;

/**
 * URL 字段的形态校验（留空 = 用 Schema 默认值）。
 *
 * 只接受 `http(s)` 绝对地址且不含 userinfo：凭据只该出现在专门的密钥字段里
 * （读路径会打码），塞进 URL 的 userinfo 既不可见也无法轮换。
 */
function urlFieldError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '必须是合法的绝对 URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '只接受 http(s) 协议';
  if (parsed.username !== '' || parsed.password !== '') return '不得包含用户名或密码（userinfo）';
  if (parsed.hostname === '') return '缺少主机名';
  return null;
}

/**
 * 单字段校验。返回规范化后的值或错误文本。
 *
 * 数值一律要求 `Number.isFinite`（`NaN` / `Infinity` 会把阈值判断变成恒真 / 恒假），
 * `step === 1` 的字段额外要求整数；超出 `min` / `max` 直接拒绝而不是静默夹断——
 * 面板显示的就是写进去的值，夹断会让「看起来保存成功、实际不是这个数」。
 */
function validateField(field: SettingsFieldMeta, value: unknown): { ok: true; value: SettingsValue } | { ok: false; error: string } {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, error: fieldError(field, '需要布尔值') };
    case 'string': {
      if (typeof value !== 'string') return { ok: false, error: fieldError(field, '需要字符串') };
      // 换行 / 制表等控制字符：会被它们逃出「单行」语义（路径、URL、请求头），没有任何合法用例。
      if (CONTROL_CHARS.test(value)) {
        return { ok: false, error: fieldError(field, '不得包含换行或控制字符') };
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return {
          ok: false,
          error: fieldError(field, `不得超过 ${field.maxLength} 个字符（收到 ${value.length}）`),
        };
      }
      if (field.url === true) {
        const reason = urlFieldError(value);
        if (reason !== null) return { ok: false, error: fieldError(field, reason) };
      }
      return { ok: true, value };
    }
    case 'enum': {
      const options = field.options ?? [];
      if (typeof value !== 'string' || !options.includes(value)) {
        return { ok: false, error: fieldError(field, `需要 ${options.join(' / ')} 之一`) };
      }
      return { ok: true, value };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: fieldError(field, '需要有限数值') };
      }
      if (field.step === 1 && !Number.isInteger(value)) {
        return { ok: false, error: fieldError(field, '需要整数') };
      }
      if (field.min !== undefined && value < field.min) {
        return { ok: false, error: fieldError(field, `不得小于 ${field.min}`) };
      }
      if (field.max !== undefined && value > field.max) {
        return { ok: false, error: fieldError(field, `不得大于 ${field.max}`) };
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, error: fieldError(field, '未知字段类型') };
  }
}

export type SettingsPatchResult =
  | { ok: true; section: SettingsSection; value: SettingsSectionPatch }
  | { ok: false; error: string };

/**
 * 校验 POST 补丁：段名必须在白名单内，patch 必须是普通对象；
 * 未知键**丢弃**（面板版本漂移不会污染文件），已知键的非法值**拒绝**（400）。
 */
export function validateSettingsPatch(section: unknown, patch: unknown): SettingsPatchResult {
  if (typeof section !== 'string' || !KNOWN_SECTIONS.has(section)) {
    return { ok: false, error: `未知设置段：${typeof section === 'string' ? section : typeof section}` };
  }
  const target = section as SettingsSection;
  if (!isPlainObject(patch)) {
    return { ok: false, error: 'patch 必须是对象' };
  }
  const value: SettingsSectionPatch = {};
  for (const field of FIELDS_BY_SECTION[target]) {
    if (!Object.prototype.hasOwnProperty.call(patch, field.key)) continue;
    const raw = patch[field.key];
    // 密钥字段的空串 = 「不修改」：面板回显的空串原样回传时不 400、也不落盘（不冲掉已存密钥）。
    if (field.secret === true && typeof raw === 'string' && raw.trim() === '') continue;
    const checked = validateField(field, raw);
    if (!checked.ok) return { ok: false, error: checked.error };
    value[field.key] = checked.value;
  }
  return { ok: true, section: target, value };
}

/** 段 → 合并基线（宿主 `config.<section>`）；缺省时不做跨字段判断。 */
export type SettingsBaseSections = Partial<Record<SettingsSection, Readonly<Record<string, unknown>>>>;

/**
 * 覆盖层读写的自愈上下文。
 *
 * `base` 是**合并基线**（宿主 config 的对应段）：面板单字段校验只能看一个值，
 * 而触发器真正执行的是「config ⊕ 覆盖层」合并后的整段。`warn` 是整段被丢弃时的告警出口。
 */
export interface SettingsRepairContext {
  base?: SettingsBaseSections;
  warn?: (message: string) => void;
}

/**
 * 合并后（`config` ⊕ 覆盖层 ⊕ 本次补丁）的跨字段校验，返回错误消息数组（空 = 通过）。
 *
 * 判据逐段对齐运行时**真正执行**的那套，不另造规则：
 * - `trigger`：直接复用 `normalizeTriggerOptions`（`BurstQuiescenceDetector` 的构造、
 *   `applyDefaultOptions`、`updateOptions` 都走它）。它负责各字段数值域 / 整数 /
 *   `triggerMode` 枚举，以及面板单字段校验看不到的两条跨字段约束：
 *   ① `thetaMin ≥ 1e-3`（`OPTION_RULES.thetaMin`：`thetaMin = 0` 时 `Θ_cool` 恒为 0，
 *   群永驻 BURSTING）；② `coolingRatioThreshold < burstMultiplier`（否则迟滞带失效）。
 * - `topics` / `media` / `query` / `judge`：运行时的应用点（`topicRuntime` 赋值、
 *   `MediaPool.configure`、`JudgeClient.applyOptions`）都不做跨字段断言，非法值各自
 *   按类型守卫回落默认值；因此这里没有额外规则，字段级校验仍由 `validateSettingsPatch`
 *   负责。往这些段加规则就是「比运行时更严」，会拒掉运行时本来能跑的组合。
 */
export function validateMergedSettings(section: SettingsSection, candidate: object): string[] {
  if (section !== 'trigger') return [];
  try {
    // `candidate` 是合并后的整段；缺省基线取 `DEFAULT_TRIGGER_OPTIONS`（Schema 默认值同源）。
    normalizeTriggerOptions(candidate as Partial<TriggerOptions>);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * 自愈：丢掉「合并基线后非法」的整段，并留下一条告警。
 *
 * 只在给了基线时做跨字段判断：没有基线的调用方（例如单测里只写一段）无法知道
 * `coolingRatioThreshold` 与宿主 `burstMultiplier` 的关系，拿 Schema 默认值去判会把
 * 「分两次写、每次单独看都越界、合并后合法」的正常覆盖误删。
 */
function repairSections(
  sections: SettingsOverrides,
  context: SettingsRepairContext | undefined,
): SettingsOverrides {
  const base = context?.base;
  if (base === undefined) return sections;
  let repaired: SettingsOverrides | null = null;
  for (const section of SETTINGS_SECTIONS) {
    const patch = sections[section];
    if (patch === undefined) continue;
    const merged: Record<string, unknown> = { ...(base[section] ?? {}), ...patch };
    const errors = validateMergedSettings(section, merged);
    if (errors.length === 0) continue;
    if (repaired === null) repaired = { ...sections };
    delete repaired[section];
    context?.warn?.(
      `[Patchouli] .patchouli/settings.json 的 ${section} 段合并后非法，已丢弃该段并回落 config：` +
        errors.join('；'),
    );
  }
  return repaired ?? sections;
}

/** 单段静默清洗：未知键 / 非法值丢弃，只留白名单内的合法标量。 */
function sanitizeSectionValue(section: SettingsSection, stored: unknown): SettingsSectionPatch {
  if (!isPlainObject(stored)) return {};
  const patch: SettingsSectionPatch = {};
  for (const field of FIELDS_BY_SECTION[section]) {
    if (!Object.prototype.hasOwnProperty.call(stored, field.key)) continue;
    const raw = stored[field.key];
    // 密钥字段的空串在磁盘上没有语义（等价于「未配置」），不留在覆盖层里。
    if (field.secret === true && typeof raw === 'string' && raw.trim() === '') continue;
    const checked = validateField(field, raw);
    if (checked.ok) patch[field.key] = checked.value;
  }
  return patch;
}

/** 读取时静默清洗：未知段 / 未知键 / 非法值一律丢弃，损坏文件当空表。 */
function sanitizeSections(raw: unknown): SettingsOverrides {
  if (!isPlainObject(raw)) return {};
  const sections: SettingsOverrides = {};
  for (const section of SETTINGS_SECTIONS) {
    const patch = sanitizeSectionValue(section, raw[section]);
    if (Object.keys(patch).length > 0) sections[section] = patch;
  }
  return sections;
}

/** 文档里除五段标量之外的独立键：订阅表（结构化数组，不进 `sections`）。 */
const SUBSCRIPTIONS_KEY = 'subscriptions';

/**
 * 文档里订阅表的姊妹键：**名字 → 稳定地址**的绑定表。
 *
 * 它是投递期解析可读名的唯一真源：名字一旦在这里绑上 `群号/相册ID`，
 * 之后相册改名 / 探测顺序变化 / 别的群出现同名相册都不会改变收件人。
 * 绑定只在「保存订阅表 / 首轮迁移」时写入，投递期只读。
 */
const TARGET_BINDINGS_KEY = 'targetBindings';

/**
 * 文档里与绑定表并列的投递策略表：**目标稳定地址 → 策略**。
 *
 * 键是稳定地址（`@chat:<来源群>` / `群号/相册ID`），不是可读名——改相册名不该重置策略；
 * 删掉绑定即自动失效（不存在悬空目标）。与绑定表**同一次原子写**、同一条串行链。
 */
const POLICIES_KEY = 'policies';

/**
 * 首轮绑定迁移的完成标记（`bindingMigration: 1`）。
 *
 * 与绑定表**同一次原子写**，只写一次。语义：有标记 + 空表 = 用户把绑定删光了，
 * 不是「还没迁移过」——启动期不得再拿当前候选重新解析同名相册（那会把收件人
 * 悄悄换成另一个群的同名相册）。只有「缺标记 + 空表」才是首轮迁移的入口。
 */
const BINDING_MIGRATION_KEY = 'bindingMigration';

/** 绑定表项数上限：相册候选 ≤400，1024 足够且是硬上限。 */
export const MAX_TARGET_BINDINGS = 1024;

/** 绑定值（`群号/相册ID`）长度上限：脏文件不得把长字符串带进常驻内存。 */
const MAX_BINDING_VALUE_CHARS = 128;

/**
 * 绑定表清洗：只留合法的「名字 → 稳定地址」。
 *
 * 丢弃：保留值键（`@chat` / `#group:<群号>`，否则相册名能遮蔽保留值）、超长键、
 * 非 `群号/相册ID` 形状的值、非字符串值；超出 `MAX_TARGET_BINDINGS` 后按文件顺序截断
 * （丢掉的是「更晚写入的绑定」，后果是停投 + 告警，不会误投）。
 */
export function sanitizeTargetBindings(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const bindings: Record<string, string> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_TARGET_BINDINGS) break;
    if (typeof value !== 'string') continue;
    const name = key.trim();
    const address = value.trim();
    if (name === '' || name.length > MAX_SUBSCRIPTION_TARGET_CHARS) continue;
    // `__proto__` 是对象字面量的原型槽：脏 JSON 不得因此改写绑定表的原型。
    if (name === '__proto__') continue;
    if (name === CHAT_TARGET || name.startsWith(TARGET_GROUP_PREFIX)) continue;
    if (address.length > MAX_BINDING_VALUE_CHARS || !ALBUM_TARGET_PATTERN.test(address)) continue;
    bindings[name] = address;
    kept += 1;
  }
  return bindings;
}

/** 覆盖层文档的完整形状。 */
interface StoredDocument {
  sections: SettingsOverrides;
  /** `null` = 文件里没有订阅覆盖（运行时回落到 `config.subscriptions`）。 */
  subscriptions: SubscriptionRow[] | null;
  /** 名字 → 稳定地址；空表且没有迁移标记 = 尚未建立绑定（首轮迁移会尝试填充一次）。 */
  bindings: Record<string, string>;
  /** 目标稳定地址 → 策略；空表 = 所有目标全天不限量（与升级前行为一致）。 */
  policies: TargetPolicies;
  /** 首轮绑定迁移已完成；`true` 且绑定表为空 = 用户删光了绑定，不得再自动解析。 */
  bindingMigration: boolean;
}

const EMPTY_DOCUMENT: StoredDocument = {
  sections: {},
  subscriptions: null,
  bindings: {},
  policies: {},
  bindingMigration: false,
};

/** 解析结果：`ok:false` 表示内容不可识别——读路径回退空表，写路径必须拒绝写入。 */
type DocumentParse =
  | { readonly ok: true; readonly document: StoredDocument }
  | { readonly ok: false; readonly reason: string };

function parseDocument(text: string): DocumentParse {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: '不是合法 JSON' };
  }
  if (!isPlainObject(doc)) return { ok: false, reason: '顶层不是对象' };
  // 版本不符 = 不认识的格式：静默当空表就会在下一保存时抹掉整份未知内容。
  if (doc.version !== 1) return { ok: false, reason: `version 不是 1（收到 ${JSON.stringify(doc.version)}）` };
  // 订阅表是结构化数组：脏载荷在这里收敛（行数 / 目标数 / 字段长度封顶，旧单值归一）。
  const subscriptions = doc[SUBSCRIPTIONS_KEY];
  const bindings = sanitizeTargetBindings(doc[TARGET_BINDINGS_KEY]);
  return {
    ok: true,
    document: {
      sections: sanitizeSections(doc.sections),
      subscriptions: Array.isArray(subscriptions) ? normalizeSubscriptionRows(subscriptions) : null,
      bindings,
      // 策略表是结构化对象：脏项在这里被丢弃（非法键 / 非法窗口 / 越界数值 / 超 256 项）。
      policies: parsePolicies(doc[POLICIES_KEY]),
      // 有绑定 = 迁移早已发生过（升级前的文件没有标记）；标记只在首次迁移 / 面板保存后落盘。
      bindingMigration: doc[BINDING_MIGRATION_KEY] === 1 || Object.keys(bindings).length > 0,
    },
  };
}

/** 读文件的结果：只有 `missing`（ENOENT）允许按空文档新建，`unreadable` 一律拒绝写入。 */
type DocumentRead =
  | { readonly ok: true; readonly document: StoredDocument }
  | { readonly ok: false; readonly kind: 'missing' | 'unreadable'; readonly reason: string };

async function readDocumentAt(path: string): Promise<DocumentRead> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (error) {
    // `ENOENT` 是唯一「可以新建」的失败；权限 / 临时 IO / 目录撞名都不行。
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { ok: false, kind: 'missing', reason: `${path} 不存在` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: 'unreadable', reason: `${path} 读取失败：${detail}` };
  }
  const parsed = parseDocument(text);
  if (!parsed.ok) return { ok: false, kind: 'unreadable', reason: `${path} ${parsed.reason}` };
  return { ok: true, document: parsed.document };
}

function readDocumentAtSync(path: string): DocumentRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { ok: false, kind: 'missing', reason: `${path} 不存在` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: 'unreadable', reason: `${path} 读取失败：${detail}` };
  }
  const parsed = parseDocument(text);
  if (!parsed.ok) return { ok: false, kind: 'unreadable', reason: `${path} ${parsed.reason}` };
  return { ok: true, document: parsed.document };
}

/**
 * 读路径（启动回灌 / GET）的宽松回退：读不出来就当空文档——一份坏文件绝不能变成
 * 「插件起不来」的原因；但留下一次告警，让用户知道下一次保存会被拒绝、需要修文件。
 */
function lenientDocument(read: DocumentRead, context?: SettingsRepairContext): StoredDocument {
  if (read.ok) return read.document;
  if (read.kind === 'unreadable') {
    context?.warn?.(
      `[Patchouli] .patchouli/settings.json 无法解析，本次按空设置运行（保存会被拒绝，请修复或删除该文件）：` +
        read.reason,
    );
  }
  return EMPTY_DOCUMENT;
}

/**
 * 读取覆盖层（异步；文件不存在 / 损坏 / 版本不符一律空表 + 一次 warn）。
 *
 * 给了 `context.base` 时会做自愈：合并后非法的段整段丢弃并 `warn`，
 * 绝不让一份坏 `settings.json` 变成插件起不来的原因。读懂了但内容非法（坏段）与
 * 读不懂（损坏 / 版本不符）是两件事：前者由下面的 `repairSections` 就地修，后者只告警，
 * 写路径同样会拒绝落盘——见 `performDocumentWrite`。
 */
export async function readSettingsOverrides(
  wikiDir: string,
  context?: SettingsRepairContext,
): Promise<SettingsOverrides> {
  const read = await readDocumentAt(settingsPath(wikiDir));
  return repairSections(lenientDocument(read, context).sections, context);
}

/**
 * 读取覆盖层（同步）。
 *
 * 仅用于插件构造期：触发算法 / 素材池 / 裁判客户端的参数在构造函数里就要定型，
 * 等不到异步初始化。文件是小体量的标量对象，同步读一次可接受。
 */
export function readSettingsOverridesSync(
  wikiDir: string,
  context?: SettingsRepairContext,
): SettingsOverrides {
  const read = readDocumentAtSync(settingsPath(wikiDir));
  return repairSections(lenientDocument(read, context).sections, context);
}

/** 读取订阅表覆盖层；`null` = 没有覆盖（运行时按宿主 config 编译订阅）。 */
export async function readSubscriptionOverride(wikiDir: string): Promise<SubscriptionRow[] | null> {
  return lenientDocument(await readDocumentAt(settingsPath(wikiDir))).subscriptions;
}

/** 读取订阅表覆盖层（同步；插件构造期用，理由同 `readSettingsOverridesSync`）。 */
export function readSubscriptionOverrideSync(wikiDir: string): SubscriptionRow[] | null {
  return lenientDocument(readDocumentAtSync(settingsPath(wikiDir))).subscriptions;
}

/**
 * 读取绑定表（名字 → `群号/相册ID`）。缺键 / 损坏 / 非法项 → 空表或已清洗的表：
 * 「没有绑定」的后果是停投 + 告警，绝不回退到按当前候选猜。
 */
export async function readTargetBindings(wikiDir: string): Promise<Record<string, string>> {
  return lenientDocument(await readDocumentAt(settingsPath(wikiDir))).bindings;
}

/** 读取绑定表（同步；插件构造期与模块加载期用，理由同 `readSettingsOverridesSync`）。 */
export function readTargetBindingsSync(wikiDir: string): Record<string, string> {
  return lenientDocument(readDocumentAtSync(settingsPath(wikiDir))).bindings;
}

/**
 * 读取投递策略表（目标稳定地址 → 策略）。缺键 / 损坏 / 非法项 → 空表或已清洗的表：
 * 「没有策略」= 全天不限时、不限量、不抖动（与升级前一致），绝不回退到按可读名猜。
 */
export async function readTargetPolicies(wikiDir: string): Promise<TargetPolicies> {
  return lenientDocument(await readDocumentAt(settingsPath(wikiDir))).policies;
}

/**
 * 「首轮绑定迁移是否已经做过」——启动期迁移的唯一判据。
 *
 * - `true`：`settings.json` 里有 `bindingMigration: 1`（首次迁移或面板保存时同一次原子写），
 *   或绑定表非空（升级前的文件没有标记，非空表本身就证明迁移发生过）。
 * - `false`：文件不存在 / 读不懂 / 从没写过标记且绑定表为空 —— 这才是首轮迁移的入口。
 *
 * **`true` + 空绑定表 = 用户把绑定删光了**：调用方必须原样保持未绑定，不得拿当前相册
 * 候选重新解析同名相册（那等于把收件人悄悄换成另一个群的同名相册）。迁移写盘侧的
 * 第二道闸在 `writeTargetBindings`：有标记时它原样返回、不落盘。
 */
export async function readTargetBindingMigration(wikiDir: string): Promise<boolean> {
  return lenientDocument(await readDocumentAt(settingsPath(wikiDir))).bindingMigration;
}

/** 同一路径的读改写串行链：两个并发 POST 不会互相覆盖（后到者一定读到前者的结果）。 */
const writeChains = new Map<string, Promise<unknown>>();

/** 入队一次读改写；队列尾部在完成时摘除，Map 只随「同时在写的路径数」增长。 */
async function enqueueWrite<T>(target: string, run: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(target) ?? Promise.resolve();
  const started = previous.then(run, run);
  const settled = started.then((): undefined => undefined, (): undefined => undefined);
  writeChains.set(target, settled);
  try {
    return await started;
  } finally {
    if (writeChains.get(target) === settled) writeChains.delete(target);
  }
}

/**
 * 原子落盘整份文档：temp 文件各自独立，最后一次 `rename` 一定是完整 JSON。
 *
 * 权限按 `writeApiTokenFile` 同一口径收成 0600：文件里有 `media.apiKey` / `judge.apiKey`
 * 的明文。`rename` 会继承 temp 的模式，之后补一次 `chmod` 兜住「目标文件早已存在且
 * 权限更宽」的旧部署；Windows 没有 POSIX 权限位，`chmod` 失败一律忽略。
 */
async function writeDocument(target: string, document: StoredDocument): Promise<void> {
  const payload: Record<string, unknown> = { version: 1, sections: document.sections };
  // 没有订阅覆盖时不写这个键：文件里「键缺失」与「null」必须是同一个语义（回落 config）。
  if (document.subscriptions !== null) payload[SUBSCRIPTIONS_KEY] = document.subscriptions;
  // 绑定表同理：空表不写键（「尚未建立绑定」与「空对象」同一个语义）。
  if (Object.keys(document.bindings).length > 0) payload[TARGET_BINDINGS_KEY] = document.bindings;
  // 策略表同理：空表 = 没有策略 = 全天不限量，不写键。
  if (Object.keys(document.policies).length > 0) payload[POLICIES_KEY] = document.policies;
  // 迁移标记：与绑定表**同一次原子写**。缺键 = 从未迁移过（首轮迁移的入口）；
  // 有标记 + 空表 = 用户删光了绑定，重启后不得再拿当前候选猜同名相册。
  if (document.bindingMigration) payload[BINDING_MIGRATION_KEY] = 1;
  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.mkdir(nodePath.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600).catch((): undefined => undefined);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}

/**
 * 读不懂的 `settings.json`：写路径拒绝落盘（HTTP 层翻成 500），文件字节保持原样。
 *
 * 「当成空文档写回去」的代价是：一次单段保存就把订阅表 / 绑定 / 密钥整份抹掉。
 * 因此损坏 JSON、`version` 不符、权限不足、临时 IO 失败一律拒绝，等用户修好文件再写；
 * 只有 `ENOENT`（还没建过）允许新建。
 */
export class SettingsDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsDocumentError';
  }
}

/** 写路径的读：`ENOENT` 当空文档新建，其余失败一律抛错（调用方保持文件原样）。 */
async function readWritableDocument(target: string): Promise<StoredDocument> {
  const read = await readDocumentAt(target);
  if (read.ok) return read.document;
  if (read.kind === 'missing') return EMPTY_DOCUMENT;
  throw new SettingsDocumentError(
    `${read.reason} —— 已拒绝写入（文件保持原样；请修复或删除 .patchouli/settings.json 后重试）`,
  );
}

/** 读改写的公共骨架：先读整份文档，交给 `mutate` 换出下一版，再原子落盘。 */
async function performDocumentWrite(
  target: string,
  mutate: (current: StoredDocument) => StoredDocument,
): Promise<StoredDocument> {
  const next = mutate(await readWritableDocument(target));
  await writeDocument(target, next);
  return next;
}

/**
 * 写盘前的「合并后非法」冲突：文件里遗留的旧覆盖与本次补丁合起来违反运行时断言。
 *
 * 抛在落盘之前，因此文件与运行态都不变；调用方（`updateSettings`）把它翻成 400，
 * 面板重试一次就能把坏段清掉（写路径会先修旧值）。
 */
export class SettingsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsConflictError';
  }
}

/**
 * 写入一段覆盖值（读改写 + 原子落盘），返回落盘后的完整覆盖层。
 *
 * 调用方应直接采用返回值作为内存真源，避免「写盘成功后再次读文件」的双读窗口。
 * 只改 `sections.<section>`，文件里的订阅表原样保留。
 *
 * 给了 `context.base` 时先修旧值再叠补丁：文件里遗留的非法段不参与合并，
 * 落盘结果一定是自洽的（下一次面板保存就把坏值顺手清掉）。若「修完的旧值 ⊕ 本次补丁」
 * 仍然非法（外部改写与内存快照分叉），抛 `SettingsConflictError` 且**不写盘**。
 */
export async function writeSettingsOverrides(
  wikiDir: string,
  section: SettingsSection,
  patch: SettingsSectionPatch,
  context?: SettingsRepairContext,
): Promise<SettingsOverrides> {
  const target = settingsPath(wikiDir);
  const next = await enqueueWrite(target, () =>
    performDocumentWrite(target, (current) => {
      const healed = repairSections(current.sections, context);
      const clean = sanitizeSectionValue(section, patch);
      const nextSection = { ...(healed[section] ?? {}), ...clean };
      const base = context?.base;
      if (base !== undefined) {
        const errors = validateMergedSettings(section, { ...(base[section] ?? {}), ...nextSection });
        if (errors.length > 0) {
          throw new SettingsConflictError(
            `settings.json 中的旧覆盖与本段补丁合并后非法，已拒绝写入：${errors.join('；')}`,
          );
        }
      }
      return { ...current, sections: { ...healed, [section]: nextSection } };
    }),
  );
  return next.sections;
}

/**
 * 写入订阅表覆盖层（`null` = 删除覆盖键，回落到宿主 config），返回落盘后的值。
 *
 * 与五段覆盖值共用同一个文件与同一条串行链：两个并发写（面板改调参面 + 改订阅表）
 * 不会互相覆盖。订阅表是唯一不写进 `sections` 的键——它是结构化数组，不是标量补丁。
 *
 * `bindings` 给了就与订阅表**同一次原子落盘**：名字→地址的绑定绝不能落后于行本身，
 * 否则一次断电就能留下「新行 + 旧绑定」的错配。缺省（`undefined`）= 保留文件里的绑定表，
 * 也**不算**用户对绑定做了选择（升级前的覆盖层就是这种形状，首轮迁移仍要补）。
 *
 * 显式给了 `bindings` 落盘的同时打上迁移完成标记：面板保存 = 用户对绑定做了**显式**
 * 选择（删空也算），之后启动期不得再拿当前候选重新解析同名相册。
 */
export async function writeSubscriptionOverride(
  wikiDir: string,
  rows: readonly SubscriptionRow[] | null,
  bindings?: Readonly<Record<string, string>>,
): Promise<{ rows: SubscriptionRow[] | null; bindings: Record<string, string> }> {
  const target = settingsPath(wikiDir);
  const next = await enqueueWrite(target, () =>
    performDocumentWrite(target, (current) => ({
      ...current,
      subscriptions: rows === null ? null : normalizeSubscriptionRows(rows),
      bindings: bindings === undefined ? current.bindings : sanitizeTargetBindings(bindings),
      bindingMigration: bindings === undefined ? current.bindingMigration : true,
    })),
  );
  return { rows: next.subscriptions, bindings: next.bindings };
}

/**
 * 只写绑定表（首轮迁移用），返回落盘后的值。
 *
 * 与订阅表共用一个文件 / 一条串行链，因此迁移与并发的面板保存不会互相抹掉：
 * 迁移只替换 `bindings` 键，`subscriptions` 与 `sections` 原样保留。
 *
 * **只做一次**：文件里已有迁移完成标记（首次迁移写过，或面板保存过、含用户把绑定删空）
 * 时原样返回、不落盘、不解析——迁移绝不能把用户删掉的绑定重新「猜」回来。标记与绑定表
 * 同一次原子写，因此「迁移过」与「绑定表内容」永远一致。
 */
export async function writeTargetBindings(
  wikiDir: string,
  bindings: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const target = settingsPath(wikiDir);
  const next = await enqueueWrite(target, async () => {
    const current = await readWritableDocument(target);
    if (current.bindingMigration) return current;
    const migrated: StoredDocument = {
      ...current,
      bindings: sanitizeTargetBindings(bindings),
      bindingMigration: true,
    };
    await writeDocument(target, migrated);
    return migrated;
  });
  return next.bindings;
}

/**
 * 写入整张投递策略表（面板保存的唯一入口），返回落盘后的值。
 *
 * 与订阅表 / 绑定表 / 五段标量**同一个文件、同一条串行链**：策略写入只替换
 * `policies` 键，其余键原样保留，并发的绑定表写入不会互相抹掉。写前按 `parsePolicies`
 * 清洗（非法键 / 非法窗口 / 越界数值丢弃），空表 = 删除该键（没有策略）。
 *
 * 空表写盘后不再有 `policies` 键：与绑定表一致，「键缺失」与「空对象」同一语义。
 */
export async function writeTargetPolicies(
  wikiDir: string,
  policies: Readonly<TargetPolicies>,
): Promise<TargetPolicies> {
  const target = settingsPath(wikiDir);
  const next = await enqueueWrite(target, () =>
    performDocumentWrite(target, (current) => ({ ...current, policies: parsePolicies(policies) })),
  );
  return next.policies;
}

/**
 * 逐项写一条策略（面板右键菜单的唯一入口）：`policy === null` = 删除该项。
 *
 * 读改写整段在**同一条串行链**里完成：两个并发 POST 不会各自读到旧表再互相覆盖。
 * 表项已满且是新增键时抛 `SettingsConflictError`（HTTP 层翻成 400），文件保持原样。
 * 键与值都由调用方先过 `isPolicyKey` / `normalizePolicy`——这里再清洗一遍整表，
 * 顺手把文件里遗留的非法项清掉。
 */
export async function upsertTargetPolicy(
  wikiDir: string,
  key: string,
  policy: TargetPolicy | null,
): Promise<TargetPolicies> {
  const target = settingsPath(wikiDir);
  const next = await enqueueWrite(target, () =>
    performDocumentWrite(target, (current) => {
      const policies: TargetPolicies = { ...current.policies };
      if (policy === null) {
        delete policies[key];
      } else {
        if (!Object.hasOwn(policies, key) && Object.keys(policies).length >= MAX_TARGET_POLICIES) {
          throw new SettingsConflictError(`投递策略最多 ${MAX_TARGET_POLICIES} 项，请先删除不再使用的目标`);
        }
        policies[key] = policy;
      }
      return { ...current, policies: parsePolicies(policies) };
    }),
  );
  return next.policies;
}
