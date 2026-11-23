/**
 * 订阅表编译：把「来源群 → 投递目标（多值标签）+ 开关」翻译成运行时快照。
 *
 * 单一真源规则：表里**有任何有效行**时只认表；表为空时完全回退到旧配置
 * （`channels` + `albumDelivery`），保证升级后的实例行为不变。
 *
 * 投递目标是**多值标签**：一行可以同时投「来源群聊天」（`@chat`）与若干群相册
 * （写的是相册的**唯一可读名**，见 `albums.ts` 的 `albumTargetOptions`），空数组 = 不投。
 * 旧配置里的单值 `target` 在归一阶段转成 `targets: [target]`，宿主 yml 不用改也能继续跑。
 *
 * 名字是唯一真源，但**解析不了就拒绝**：`resolveTarget` 只认
 * `@chat` → 名字查表 → 旧稳定地址 `群号/相册ID`；查不到就丢弃并 warn，
 * 绝不按名字猜一个群（两个群都有「周报」时会把卡投错地方）。
 *
 * 本模块是纯函数集合（无 I/O、无时钟、无随机），便于直接单测；调用方每次读取
 * 都重新编译，行数上限由 Schema 的 `.max(256)` 兜住，编译成本可忽略。
 */

import type { PatchouliPluginConfig, SubscriptionRow } from '../types';
import type { EntryDeliveryTarget } from './entry-delivery';

/**
 * 相册的稳定地址：`<群号>/<相册ID>`。
 *
 * 两种来源：①升级前直接写进 yml 的旧值（永远兼容）；②绑定表的值——保存订阅表时
 * 由可读名解析出来（`targetBindings`）。面板白名单同样收它。
 */
export const ALBUM_TARGET_PATTERN = /^(\d+)\/([^/]+)$/u;

/** 投递到**来源群本身**聊天：替代「source 即目标群」的隐式写法，跨群时不产生歧义。 */
export const CHAT_TARGET = '@chat';

/**
 * 下拉分组标题项的 value 前缀：`#group:<群号>`。
 *
 * schemastery-vue 的 multiselect 只渲染平铺 `<el-option>`（没有 `el-option-group`），
 * 但 `<el-option :disabled>` 会渲染成不可点的灰行——于是用 `Schema.disabled()` 造一条
 * 「群名」标题项，下拉自然按群分段，而且它仍是 const union 的合法成员（表格列校验不变）。
 *
 * 这些值**永远不是投递目标**：不可选所以不会被写进配置，旧配置里也不可能出现；
 * 万一手填 / 覆盖层里带了它，归一、解析、日志一律跳过，不猜、不报「非法目标」刷屏。
 */
export const TARGET_GROUP_PREFIX = '#group:';

/** 分组标题项的 value。 */
export function targetGroupValue(groupId: string): string {
  return `${TARGET_GROUP_PREFIX}${groupId.trim()}`;
}

/** 是不是分组标题项（`#group:<群号>`）：只当标题渲染，永不解析成投递目标。 */
export function isTargetGroupHeader(target: string): boolean {
  return target.trim().startsWith(TARGET_GROUP_PREFIX);
}

/** 订阅表行数上限（与控制台 Schema 的 `.max(256)` 同一个数）。 */
export const MAX_SUBSCRIPTION_ROWS = 256;

/** 单行目标数上限：一行投十几个相册已经远超正常用法，封顶防止脏数据撑大快照。 */
export const MAX_TARGETS_PER_ROW = 16;

/** 单行字段长度上限：脏文件 / 恶意载荷不得把长字符串带进常驻内存与每次重编译。 */
export const MAX_SUBSCRIPTION_SOURCE_CHARS = 64;
/**
 * 目标串长度上限：持久化值是相册的唯一可读名（`相册名` / `群名 · 相册名`），
 * 旧值还可能是稳定地址 `群号/相册ID`。192 覆盖两个名字都取到 60+ 字符的极端情况，
 * 同时仍是硬上限（单行 ≤16 个目标、总行 ≤256）。
 */
export const MAX_SUBSCRIPTION_TARGET_CHARS = 192;

/** 去平台前缀，只留群号本身。 */
export function bareChannelId(channelId: string): string {
  const trimmed = channelId.trim();
  const index = trimmed.lastIndexOf(':');
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** 平台前缀归一：裸群号补 `onebot:`。 */
export function withPlatform(channelId: string): string {
  const trimmed = channelId.trim();
  return trimmed.includes(':') ? trimmed : `onebot:${trimmed}`;
}

/**
 * 单行 targets：`targets` 键存在即权威，缺失才回填历史 `target`（单值或字符串数组）；
 * 去重、丢弃空串与超长项。
 *
 * 「键存在」而不是「值非空」是硬语义：`targets: []` 是用户显式清空收件人，
 * 不能因为同一条记录里还留着升级前的 `target` 就把目标复活。
 */
function rawTargets(record: Record<string, unknown>): string[] {
  const values: unknown[] = [];
  if (Object.hasOwn(record, 'targets')) {
    const targets = record.targets;
    if (Array.isArray(targets)) values.push(...targets);
    else if (typeof targets === 'string') values.push(targets);
  } else {
    // 历史写法（宿主 yml / 旧面板）：单值 `target`，后来也写出过字符串数组。
    const legacy = record.target;
    if (Array.isArray(legacy)) values.push(...legacy);
    else if (typeof legacy === 'string') values.push(legacy);
  }
  const targets: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MAX_SUBSCRIPTION_TARGET_CHARS) continue;
    // 分组标题项只是下拉分段，不是目标：别让手填 / 覆盖层里的它占掉一个目标位。
    if (isTargetGroupHeader(trimmed)) continue;
    if (targets.includes(trimmed)) continue;
    targets.push(trimmed);
    if (targets.length >= MAX_TARGETS_PER_ROW) break;
  }
  return targets;
}

/**
 * 旧形态投影：把历史 `target`（单值 / 字符串数组）提前摊成现行 `targets` 形态。
 *
 * - `targets` 键存在（含 `[]`）→ 原样放行：显式空数组是「我清空了收件人」，
 *   不能被同一条记录里残留的旧 `target` 复活；
 * - `target: string` → 保持原样（`normalizeSubscriptionRows` 把它读成 `targets: [target]`）；
 * - `target: string[]` → 每个字符串元素展开成一行，`source` / `entry` / `weekly` 原样复制；
 *   元素全非法（非字符串 / 空数组）时整行保留，交给归一阶段变成「不投递」。
 *
 * 这一步单独成函数、必须在归一之前跑（`flattenConfig` 里就排在
 * `normalizeSubscriptionRows` 前）：Config 里 `targets` 刻意不物化默认值，
 * 所以「键缺失」能活着走到这里，而不是被默认 `[]` 掩盖。
 * 展开行数同样按 `MAX_SUBSCRIPTION_ROWS` 封顶。
 */
export function projectLegacySubscriptionRows(rows: unknown): unknown[] {
  if (!Array.isArray(rows)) return [];
  const projected: unknown[] = [];
  for (const raw of rows) {
    if (projected.length >= MAX_SUBSCRIPTION_ROWS) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      projected.push(raw);
      continue;
    }
    const record = raw as Record<string, unknown>;
    const legacy = record.target;
    const values =
      !Object.hasOwn(record, 'targets') && Array.isArray(legacy)
        ? legacy.filter((value): value is string => typeof value === 'string')
        : [];
    if (values.length === 0) {
      projected.push(raw);
      continue;
    }
    for (const value of values) {
      if (projected.length >= MAX_SUBSCRIPTION_ROWS) break;
      projected.push({ ...record, target: value });
    }
  }
  return projected;
}

/**
 * 把任意来源（宿主 config / 覆盖层文件 / HTTP 请求）的行归一成运行时形状。
 *
 * - 来源去平台前缀，`*` 原样保留，空来源整行丢弃；
 * - `targets` 键存在即权威（`[]` = 用户清空了收件人，绝不复活旧 `target`）；缺失时回填
 *   历史 `target`（单值 / 字符串数组），历史「目标 = 来源群号」等价写成 `@chat`
 *   （语义完全相同，但面板的合法值域里只有 `@chat`）；
 * - 目标串**原样保留**（trim / 去重 / 长度封顶，见 `rawTargets`）：这一层不做解析，
 *   名字能不能解析由投递期的 `resolveTarget` 裁决，查不到就丢弃并 warn；
 * - 行数 / 目标数 / 字段长度一律封顶。
 */
export function normalizeSubscriptionRows(rows: unknown): SubscriptionRow[] {
  if (!Array.isArray(rows)) return [];
  const normalized: SubscriptionRow[] = [];
  for (const raw of rows.slice(0, MAX_SUBSCRIPTION_ROWS)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const sourceText = typeof record.source === 'string' ? record.source.trim() : '';
    if (sourceText === '') continue;
    const source = sourceText === '*' ? '*' : bareChannelId(sourceText);
    // 历史单值 `target` 里「目标 = 来源群号」等价于 `@chat`。只对旧写法成立：
    // `targets` 是现行形态，值可能是恰好叫「123」的相册，不能被解释成群聊天。
    const legacyChat = !Object.hasOwn(record, 'targets');
    const targets: string[] = [];
    for (const value of rawTargets(record)) {
      const target = legacyChat && (value === source || value === withPlatform(source)) ? CHAT_TARGET : value;
      if (targets.includes(target)) continue;
      targets.push(target);
      if (targets.length >= MAX_TARGETS_PER_ROW) break;
    }
    normalized.push({
      source,
      targets,
      entry: record.entry === true,
      weekly: record.weekly === true,
    });
  }
  return normalized;
}

/**
 * 有效行：来源非空且已归一（去平台前缀），开关缺省按「关」处理。
 *
 * `override` 为 `undefined` 时读宿主 config 的 `subscriptions`；面板写入的覆盖层
 * （`.patchouli/settings.json` 顶层 `subscriptions`）**整段顶替** config，不做逐行合并。
 */
export function resolveRows(
  config: PatchouliPluginConfig,
  override?: readonly SubscriptionRow[],
): SubscriptionRow[] {
  return normalizeSubscriptionRows(override ?? config.subscriptions);
}

/** 编译后的运行时快照。`listening` 为 `null` 表示监听全部群。 */
export interface SubscriptionSnapshot {
  /** 表内是否有有效行；false 时其余字段都是旧配置的镜像。 */
  readonly active: boolean;
  /**
   * 需要监听的群号集合；`null` = 全部群。
   *
   * 表生效时是归一后的裸群号（`isListening` 会剥入站 ID 的前缀）；
   * 表为空时是 `config.channels` 的**原值**（精确匹配，与升级前一致）。
   */
  readonly listening: ReadonlySet<string> | null;
  /** 词条投递：来源群号（`*` 见 `entryTargetsAll`）→ 目标。 */
  readonly entryTargets: ReadonlyMap<string, EntryDeliveryTarget[]>;
  /** `*` 行的词条目标（任何来源都命中；`@chat` 在 `*` 行非法，已丢弃）。 */
  readonly entryTargetsAll: readonly EntryDeliveryTarget[];
  /** 参与周报的行（按首次出现顺序）。 */
  readonly weekly: readonly SubscriptionRow[];
  /**
   * 参与每日主题校准的群集合；`null` 表示按旧白名单（调用方回落 `config.channels`）。
   * 表为空时与 `listening` 同源：`config.channels` 原值。
   */
  readonly topicGroups: ReadonlySet<string> | null;
}

/**
 * 可读名 → 稳定地址 `群号/相册ID`（**持久化绑定表**，`settings.json` 的 `targetBindings`）。
 *
 * **这是投递期的唯一解析表**：查不到 = 解析失败，丢弃并 warn。表只在「保存订阅表 /
 * 首轮迁移」时由当时的候选写入，投递期绝不回退到按当前候选猜名字——否则同群同名相册
 * 换顺序、别的群出现同名相册都会悄悄换主。
 */
let targetNameToValue: ReadonlyMap<string, string> = new Map();

/**
 * 相册稳定值 → 日志可读名 `相册名（群号）`。
 *
 * 日志里要看出「投到哪个群的哪个相册」：只写相册名分不清同名相册，只写
 * `群号/相册ID` 又没法读。**只影响日志文案**，不参与投递。
 */
let targetValueToName: ReadonlyMap<string, string> = new Map();

/** 旧值被丢弃时的告警出口（`index.ts` 在 `apply()` 里接到 logger；测试可捕获）。 */
let targetWarn: ((message: string) => void) | undefined;

/** 解析失败告警的去重集合：同一条消息只在重装候选表之前喊一次（有界，见 `warnUnresolvedTarget`）。 */
const warnedTargets = new Set<string>();

/** 去重集合上限：脏表塞满坏值时不影响内存与日志量。 */
const MAX_WARNED_TARGETS = 64;

/** 解析失败时喊一次：`resolveTarget` 会被每条消息调用，不去重会刷屏日志。 */
function warnUnresolvedTarget(value: string): void {
  if (targetWarn === undefined || warnedTargets.has(value) || warnedTargets.size >= MAX_WARNED_TARGETS) return;
  warnedTargets.add(value);
  targetWarn(`目标未绑定或相册已变更：${value}，请在面板重新选择`);
}

/** `installSubscriptionTargetLabels` 的入参：一张用于解析，一张只给日志起文案。 */
export interface SubscriptionTargetLabels {
  /** 持久化绑定表：可读名 → 稳定地址 `群号/相册ID`；缺省为空（任何名字都解析失败）。 */
  nameToValue?: ReadonlyMap<string, string>;
  /** `群号/相册ID` → 日志文案 `相册名（群号）`；缺省为空（日志回退稳定值）。 */
  valueToName?: ReadonlyMap<string, string>;
}

/**
 * 安装解析 / 展示表（模块加载期、每轮探测后与每次保存后重装；测试按需）。
 *
 * `nameToValue` 必须是**落盘的绑定表**，不是当前候选的反解表：绑定决定「名字投到哪个
 * 相册」，探测顺序 / 同名相册进出都不该改写它。重装时清空告警去重集合，
 * 让改名后的旧值在新一轮里重新报一次。
 */
export function installSubscriptionTargetLabels(labels: SubscriptionTargetLabels = {}): void {
  targetNameToValue = labels.nameToValue ?? new Map();
  targetValueToName = labels.valueToName ?? new Map();
  warnedTargets.clear();
}

/** 安装旧值丢弃告警的出口（没安装时静默，测试可捕获）。 */
export function installSubscriptionTargetWarnings(report?: (message: string) => void): void {
  targetWarn = report;
}

/**
 * `target` → 相册的稳定值 `群号/相册ID`：先排除保留值，再查绑定表，最后按旧稳定地址认。
 *
 * **保留值优先于绑定表**：`@chat` 与 `#group:<群号>` 永远不是相册，哪怕某个相册就叫
 * 这个名字（候选会给它改名 `群名 · @chat`）。周报上传与日志文案都走这里，所以
 * 「一行只勾了 `@chat` 却上传到某个相册」在源头就不可能发生。
 *
 * 都不命中返回 `undefined`（未绑定的名字 / 脏值）：绑定表缺失时停投并 warn，
 * 绝不回退到当前候选里找同名相册。
 */
export function albumValueOfTarget(target: string): string | undefined {
  const value = target.trim();
  if (value === '' || value === CHAT_TARGET || isTargetGroupHeader(value)) return undefined;
  const mapped = targetNameToValue.get(value);
  if (mapped !== undefined) return mapped;
  const match = ALBUM_TARGET_PATTERN.exec(value);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/** 启动 / 保存时打进日志的订阅行数上限；超出只留一行汇总，避免大表刷屏启动日志。 */
export const MAX_SUBSCRIPTION_LOG_ROWS = 20;

/**
 * 生效订阅关系的日志行，每条一行便于 grep：
 * `[Patchouli] 订阅 <来源> → <目标列表 | 无投递>（<启用动作 | 仅沉淀>）`。
 *
 * 目标显示 `相册名（群号）`（展示表没装 / 未命中时回退原值：可读名或 `群号/相册ID`）；
 * `@chat` 写成「本群聊天」，分组标题项（`#group:`）不是目标、直接跳过。
 * 超过 `limit` 行时末尾补 `… 另有 N 行`，不静默丢行。
 */
export function formatSubscriptionLogLines(
  rows: readonly SubscriptionRow[],
  limit: number = MAX_SUBSCRIPTION_LOG_ROWS,
): string[] {
  const cap = Math.max(0, Math.floor(limit));
  const lines: string[] = [];
  for (const row of rows.slice(0, cap)) {
    const shown: string[] = [];
    for (const target of row.targets) {
      const trimmed = target.trim();
      if (isTargetGroupHeader(trimmed)) continue;
      if (trimmed === CHAT_TARGET) {
        shown.push('本群聊天');
        continue;
      }
      const value = albumValueOfTarget(trimmed);
      // 命中（名字或旧地址）→ `相册名（群号）`；未命中（解析不了的名字 / 脏值）原样展示：
      // 日志只做展示，不猜目标，也不假装它已经能投递。
      shown.push(value === undefined ? trimmed : (targetValueToName.get(value) ?? value));
    }
    const targets = shown.length === 0 ? '无投递' : shown.join(' + ');
    const actions: string[] = [];
    if (row.entry) actions.push('词条');
    if (row.weekly) actions.push('周报');
    lines.push(
      `[Patchouli] 订阅 ${row.source === '*' ? '*（全部群）' : row.source} → ${targets}` +
        `（${actions.length > 0 ? actions.join('、') : '仅沉淀'}）`,
    );
  }
  if (rows.length > cap) lines.push(`… 另有 ${rows.length - cap} 行`);
  return lines;
}

/**
 * 单个目标串 → 投递目标；解析不了返回空数组（不猜测、不广播）。
 *
 * 顺序固定，每一步都不会「猜」：
 * 1. `@chat` → 该行来源群聊天（保留值，优先于绑定表）；
 * 2. 绑定表 → 查 `targetNameToValue` 得到 `群号/相册ID`（保存订阅表时写入的绑定）；
 * 3. 旧稳定地址 `群号/相册ID` → 直接认（升级前写进 yml 的值仍能用）。
 *
 * 其余一律**拒绝并 warn**（同一个值只喊一次）：未绑定 / 相册已删除的旧名字会走到这里，
 * 用户能在日志里看见「请在面板重新选择」，而不是静默投到别的群或别的同名相册。
 *
 * 分组标题项（`#group:<群号>`）只是下拉分段、不是目标，永远返回空数组且不 warn。
 *
 * `source` 只在 `@chat` 时需要：缺省 / `*` 时无法定值，返回空数组而不是猜一个群。
 */
export function resolveTarget(target: string, source?: string): EntryDeliveryTarget[] {
  const value = target.trim();
  if (value === '') return [];
  if (value === CHAT_TARGET) {
    const groupId = source === undefined ? '' : bareChannelId(source);
    return /^\d+$/u.test(groupId) ? [{ kind: 'channel', channelId: withPlatform(groupId) }] : [];
  }
  if (isTargetGroupHeader(value)) return [];
  const id = albumValueOfTarget(value);
  if (id === undefined) {
    warnUnresolvedTarget(value);
    return [];
  }
  const match = ALBUM_TARGET_PATTERN.exec(id);
  // `albumValueOfTarget` 只返回本形状；这里不猜任何其它形态。
  return match === null ? [] : [{ kind: 'album', channelId: withPlatform(match[1]), albumId: match[2] }];
}

/**
 * 一行的 targets → 投递目标列表：逐个解析、按投递点去重、丢弃非法项。
 *
 * `source` 传给 `resolveTarget` 供 `@chat` 使用；`*` 行调用时应省略，
 * 交给 `entryTargetsFor` 按真实来源补。
 */
export function resolveTargets(targets: readonly string[], source?: string): EntryDeliveryTarget[] {
  const resolved: EntryDeliveryTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    for (const item of resolveTarget(target, source)) {
      // 同群同相册只投一次；群聊天与相册是两个不同的投递点，不能合并。
      const key = item.kind === 'album' ? `album:${item.channelId}/${item.albumId}` : `channel:${item.channelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(item);
    }
  }
  return resolved;
}

/**
 * 编译订阅表。
 *
 * 旧配置镜像（表为空时）：`listening` / `topicGroups` 直接取 `config.channels` 的**原值**
 * （与升级前的 `config.channels.includes(session.channelId)` 一字不差：精确匹配、不去
 * 平台前缀），词条目标留给调用方用 `planEntryTargets` 走老路径（这里返回空，
 * `active=false` 已标明）。平台前缀归一**只在表生效时**做，见 `isListening`。
 */
export function compileSubscriptions(
  config: PatchouliPluginConfig,
  override?: readonly SubscriptionRow[],
): SubscriptionSnapshot {
  const rows = resolveRows(config, override);
  if (rows.length === 0) {
    // 旧语义是精确匹配：`onebot:123` 与 `123` 是两个不同的写法，绝不互相命中。
    const legacy = new Set(config.channels);
    return {
      active: false,
      listening: legacy.size > 0 ? legacy : null,
      entryTargets: new Map(),
      entryTargetsAll: [],
      weekly: [],
      topicGroups: legacy.size > 0 ? legacy : null,
    };
  }

  const listening = new Set<string>();
  const weekly: SubscriptionRow[] = [];
  const topicGroups = new Set<string>();
  /** 来源群号（含 `*`）→ 目标串（按首次出现累积，去重；编译末尾统一解析）。 */
  const sourceTargets = new Map<string, string[]>();
  let listenAll = false;

  for (const row of rows) {
    if (row.source === '*') {
      listenAll = true;
    } else {
      listening.add(row.source);
    }
    // 周报行即使今天不监听该来源也要能发（历史主题仍在库里）。
    if (row.weekly) weekly.push(row);
    if (row.entry) {
      // 同一来源出现多行时合并目标串，避免跨行重复投递同一个点。
      const collected = sourceTargets.get(row.source) ?? [];
      for (const target of row.targets) {
        if (!collected.includes(target)) collected.push(target);
      }
      sourceTargets.set(row.source, collected);
    }
    // 主题校准按来源群：`*` 行不参与（它没有具体群可校准）。
    if (row.source !== '*') topicGroups.add(row.source);
  }

  // 解析放在最后：`@chat` 需要该行自己的来源群，解析器同时按投递点去重。
  const entryTargets = new Map<string, EntryDeliveryTarget[]>();
  for (const [source, targets] of sourceTargets) {
    if (source === '*') continue;
    const resolved = resolveTargets(targets, source);
    if (resolved.length > 0) entryTargets.set(source, resolved);
  }
  // `*` 行没有具体来源：不带 source 解析，因此 `@chat` 不产生投递点（`*` + `@chat` 非法）。
  const entryTargetsAll = resolveTargets(sourceTargets.get('*') ?? []);

  return {
    active: true,
    listening: listenAll ? null : listening,
    entryTargets,
    entryTargetsAll,
    weekly,
    topicGroups: topicGroups.size > 0 ? topicGroups : null,
  };
}

/**
 * 该频道是否在监听范围内。
 *
 * 表生效时表的键是归一后的裸群号 → 入站 ID 剥平台前缀再比（`onebot:123` 与 `123` 同一群）。
 * 表为空时的旧配置镜像是 `config.channels` 的**原值**，因此这里保持升级前的精确匹配：
 * 不剥前缀（`channels: ['onebot:123']` 只命中 `onebot:123`，不命中 `123`）。
 */
export function isListening(snapshot: SubscriptionSnapshot, channelId: string): boolean {
  if (snapshot.listening === null) return true;
  return snapshot.active
    ? snapshot.listening.has(bareChannelId(channelId))
    : snapshot.listening.has(channelId);
}

/** 该来源的词条投递目标（含 `*` 行）。 */
export function entryTargetsFor(
  snapshot: SubscriptionSnapshot,
  sourceChannelId: string,
): EntryDeliveryTarget[] {
  const source = bareChannelId(sourceChannelId);
  return [...snapshot.entryTargetsAll, ...(snapshot.entryTargets.get(source) ?? [])];
}

/** 需要监听/登记流量统计的群号列表；`null` 表示全部群（不展开）。 */
export function listeningGroupIds(snapshot: SubscriptionSnapshot): string[] | null {
  return snapshot.listening === null ? null : [...snapshot.listening];
}

/**
 * 单个 target 的合法性（`POST /api/subscriptions` 的校验）。
 *
 * 合法值域（`allowed`）= 候选唯一名 ∪ 候选稳定地址 ∪ 调用方补进来的现有值 ∪ `@chat`：
 * 名字是面板写出的形态，稳定地址只为让升级前的表原样保存，现有值即使暂时解析不了
 * 也允许原样保存（探测抖动不该让用户连「保存」都做不到）。
 *
 * `allowed` 为空 = 本轮探测不可用（无宿主投递服务 / 机器人掉线）：只做形状校验。
 * 返回 `undefined` 表示通过，否则是给人看的错误原因。
 *
 * `@chat` 只看形状就会通过——它的合法性还取决于**行来源**（`*` 行没有来源群，
 * 见 `validateSubscriptionRows` 的显式拒绝）。
 */
function targetIssue(target: string, allowed: ReadonlySet<string>): string | undefined {
  if (target === '') return 'target 不能为空（不投递请给空数组）';
  if (target.length > MAX_SUBSCRIPTION_TARGET_CHARS) {
    return `target 过长（上限 ${MAX_SUBSCRIPTION_TARGET_CHARS} 字符）`;
  }
  if (target === CHAT_TARGET) return undefined;
  if (isTargetGroupHeader(target)) return `target 不能是下拉分组标题（${TARGET_GROUP_PREFIX}… 只是分段，不可选）`;
  if (allowed.has(target)) return undefined;
  const shapeOnly = allowed.size === 0;
  const looksLikeValue = ALBUM_TARGET_PATTERN.test(target);
  if (shapeOnly) {
    return looksLikeValue
      ? undefined
      : `target 只能是候选相册名、${CHAT_TARGET} 或 群号/相册ID（收到 ${target}）`;
  }
  return looksLikeValue
    ? `相册未在探测结果中：${target}（如果相册刚改过名，请重新选择）`
    : `target 只能是候选相册名、${CHAT_TARGET} 或 群号/相册ID（相册名请从下拉里选；收到 ${target}）`;
}

/** 订阅表校验结果：`ok:false` 由 HTTP 层翻成 400。 */
export type SubscriptionRowsValidation =
  | { ok: true; rows: SubscriptionRow[] }
  | { ok: false; error: string };

/**
 * 校验面板提交的整张订阅表。
 *
 * 严格拒绝而不是静默清洗：面板显示什么就存什么，悄悄改表比报错更难查。
 * 行数 `≤ 256`、单行目标 `≤ 16` 且去重后保存；目标值域见 `targetIssue`。
 *
 * `*` 行不允许 `@chat`：`*` 没有具体来源群，编译时 `@chat` 必然解析成空（登记成功
 * 却不投 = 静默失效），因此在这一层直接 400，让用户改成具体群。
 */
export function validateSubscriptionRows(
  input: unknown,
  allowedTargets: ReadonlySet<string>,
): SubscriptionRowsValidation {
  if (!Array.isArray(input)) return { ok: false, error: 'rows 必须是数组' };
  if (input.length > MAX_SUBSCRIPTION_ROWS) {
    return { ok: false, error: `订阅表最多 ${MAX_SUBSCRIPTION_ROWS} 行（收到 ${input.length} 行）` };
  }
  const rows: SubscriptionRow[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const where = `第 ${index + 1} 行`;
    const raw: unknown = input[index];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `${where}必须是对象` };
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.source !== 'string') return { ok: false, error: `${where}：source 必须是字符串` };
    const sourceText = record.source.trim();
    if (sourceText === '') return { ok: false, error: `${where}：source 不能为空（全部群请填 *）` };
    if (sourceText.length > MAX_SUBSCRIPTION_SOURCE_CHARS) {
      return { ok: false, error: `${where}：source 过长（上限 ${MAX_SUBSCRIPTION_SOURCE_CHARS} 字符）` };
    }
    if (sourceText !== '*' && !/^\d+$/u.test(bareChannelId(sourceText))) {
      return { ok: false, error: `${where}：source 必须是群号或 *（收到 ${sourceText}）` };
    }
    if (!Array.isArray(record.targets)) return { ok: false, error: `${where}：targets 必须是数组` };
    if (record.targets.length > MAX_TARGETS_PER_ROW) {
      return {
        ok: false,
        error: `${where}：目标最多 ${MAX_TARGETS_PER_ROW} 个（收到 ${record.targets.length} 个）`,
      };
    }
    const targets: string[] = [];
    for (const item of record.targets) {
      if (typeof item !== 'string') return { ok: false, error: `${where}：targets 的元素必须是字符串` };
      const target = item.trim();
      // `*` 行没有来源群 → `@chat` 在编译期被丢弃（存下去就是「日志有目标、实际不投」）。
      if (sourceText === '*' && target === CHAT_TARGET) {
        return {
          ok: false,
          error: `${where}：\`*\` 行不支持本群聊天（${CHAT_TARGET}），请指定具体群`,
        };
      }
      const issue = targetIssue(target, allowedTargets);
      if (issue !== undefined) return { ok: false, error: `${where}：${issue}` };
      if (targets.includes(target)) continue;
      targets.push(target);
    }
    if (typeof record.entry !== 'boolean') return { ok: false, error: `${where}：entry 必须是布尔值` };
    if (typeof record.weekly !== 'boolean') return { ok: false, error: `${where}：weekly 必须是布尔值` };
    rows.push({
      source: sourceText === '*' ? '*' : bareChannelId(sourceText),
      targets,
      entry: record.entry,
      weekly: record.weekly,
    });
  }
  return { ok: true, rows };
}
