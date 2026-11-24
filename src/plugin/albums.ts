/**
 * 群相册目录：把 SnowLuma / OneBot 探测到的相册变成控制台可选候选项。
 *
 * 两个字段共用同一份探测结果，但候选的**生效时机**不同：
 * - `albumDelivery.albums` → `Schema.array(Schema.dynamic(ALBUM_SCHEMA_KEY))`，候选是
 *   单选 const union（首位空值 = 不上传），由 `ctx.schema.set` 注入、在线页面即时刷新；
 * - `subscriptions[].targets` → `array(const union)` + role `select`
 *   （`subscriptionTargetsSchema`，模块加载时先算一份，`apply()` 每次重载再原地替换
 *   `inner.list`——`require` 缓存让重载不重跑模块顶层，静态 union 否则永远停在首启）。
 *   订阅表是 `.role('table')`：schemastery-vue 的表格在渲染前就按 `toColumns(inner)`
 *   校验列，`Schema.dynamic` 那时只是 `Schema.any()`，永远进不了表格。
 *
 * 相册无法由 bot 创建，这里只探测已经存在的相册。
 * 探测范围只覆盖**订阅表里出现的监听群**（`*` 行 = 全部群，此时才回退到机器人所在群
 * 列表）：候选是给订阅表用的，把机器人所在的几十个群全探一遍只会把候选撑成噪音。
 */

import { promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join as joinPath, dirname, resolve as resolvePath } from 'node:path';
import { Schema } from 'koishi';
import { DEFAULT_WIKI_SUBDIR } from '../wiki/layout';
import type { SubscriptionRow } from '../types';
import { readTargetBindingsSync } from './settings-store';
import {
  ALBUM_TARGET_PATTERN,
  CHAT_TARGET,
  installSubscriptionTargetLabels,
  isTargetGroupHeader,
  MAX_SUBSCRIPTION_ROWS,
  MAX_TARGETS_PER_ROW,
  targetGroupValue,
} from './subscriptions';

/** 动态 schema 的注册键（`Schema.dynamic` 与 `ctx.schema.set` 必须一致）。 */
export const ALBUM_SCHEMA_KEY = 'patchouli.album';

/** 单群相册分页上限：SnowLuma 每页 10 条，5 页足够覆盖常见群。 */
export const DEFAULT_ALBUM_PAGES = 5;

/** 探测群数量上限：机器人被拉进大量群时避免一次刷新打满 OneBot。 */
export const MAX_PROBE_GROUPS = 40;

/** 候选总数上限：防止 schema union 无限膨胀。 */
export const MAX_ALBUM_CANDIDATES = 400;

/**
 * 「已配置但未探测到」的候选项上限。
 *
 * 这个数**不是裁剪阈值，是上界**：订阅表本身封顶 `MAX_SUBSCRIPTION_ROWS ×
 * MAX_TARGETS_PER_ROW`（256 行 × 16 个目标 = 4096），所以「行数 × 每行目标数」已经是
 * 任何一份合法配置能写出的全部取值。
 *
 * 为什么不能像展示候选那样「留 64 个够用」：静态 const union 的校验是**严格**的，
 * 少一个已保存值，整份插件配置就过不了校验、插件直接拒载（第 65 个未探测目标正是
 * 这样把实例打挂的）。union 总长度随之钉死在
 * `MAX_ALBUM_CANDIDATES + MAX_CONFIGURED_TARGETS + 1`（400 + 4096 + 1），仍然有界。
 */
export const MAX_CONFIGURED_TARGETS = MAX_SUBSCRIPTION_ROWS * MAX_TARGETS_PER_ROW;

/** 一条相册候选。 */
export interface AlbumCandidate {
  groupId: string;
  groupName: string;
  albumId: string;
  albumName: string;
}

/** 探测所需的 bot 公共子集（不依赖 Koishi `Bot` 类型，便于单测）。 */
export interface AlbumBot {
  platform?: string;
  selfId?: string;
  internal?: unknown;
  /** 隐藏 Bot（`chatluna-sandbox` 之类模拟实例）：其 `internal` 是个 Proxy，任何动作都报「不支持」 */
  hidden?: boolean;
}

/** 宿主投递服务的最小面（`ctx['miyako-delivery'].listAlbums`）。 */
export interface AlbumServiceLike {
  listAlbums?: (groupId: string) => Promise<AlbumCandidate[]>;
}

type InternalGet = (action: string, params?: Record<string, unknown>) => Promise<unknown>;

/** 相册在配置里的取值形态：`<group_id>/<album_id>`。 */
export function albumValue(album: AlbumCandidate): string {
  return `${album.groupId}/${album.albumId}`;
}

/** 相册候选缓存的落盘路径（与其它 `.patchouli` 状态同目录）。 */
export function albumCachePath(wikiDir: string): string {
  return joinPath(wikiDir, '.patchouli', 'albums.json');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown, keys: readonly string[]): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === 'string') return field;
    if (typeof field === 'number' && Number.isFinite(field)) return String(field);
  }
  return undefined;
}

function internalGet(bot: AlbumBot): InternalGet | undefined {
  const internal = asRecord(bot.internal);
  const get = internal?.['_get'];
  return typeof get === 'function' ? (get.bind(bot.internal) as InternalGet) : undefined;
}

/** 把配置里的频道条目归一成群号：`123` / `onebot:123` / `onebot:group:123`。 */
export function channelGroupIds(channels: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const channel of channels) {
    const text = String(channel ?? '').trim();
    const numeric = /^\d+$/u.test(text) ? text : '';
    const matched = /^onebot:(?:group:)?(\d+)$/iu.exec(text);
    const id = numeric !== '' ? numeric : (matched?.[1] ?? '');
    if (id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 机器人所在全部群号（`get_group_list`）；平台不支持或掉线时返回空数组。 */
export async function listBotGroupIds(
  bots: readonly AlbumBot[],
  limit = MAX_PROBE_GROUPS,
): Promise<string[]> {
  const ids: string[] = [];
  for (const bot of bots) {
    if (bot.platform !== 'onebot' || bot.hidden === true) continue;
    const get = internalGet(bot);
    if (get === undefined) continue;
    try {
      const payload = await get('get_group_list', {});
      const outer = asRecord(payload);
      const data = asRecord(outer?.['data']) ?? outer;
      const list = data?.['group_list'] ?? data;
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const id = stringField(entry, ['group_id']);
        if (id === undefined || ids.includes(id)) continue;
        ids.push(id);
        if (ids.length >= limit) return ids;
      }
    } catch {
      // 该 bot 的平台不支持群列表或已掉线：换下一个
    }
  }
  return ids;
}

/** 单 bot 的相册列表（含 `attach_info` 翻页，兼容顶层与 `data` 两种响应形状）。 */
async function albumListOfBot(
  get: InternalGet,
  groupId: string,
  maxPages: number,
): Promise<Array<{ albumId: string; albumName: string }>> {
  const numeric = /^\d+$/u.test(groupId) ? Number(groupId) : groupId;
  const found: Array<{ albumId: string; albumName: string }> = [];
  let attachInfo = '';
  for (let page = 0; page < maxPages; page += 1) {
    const payload = (await get('get_qun_album_list', {
      group_id: numeric,
      ...(attachInfo !== '' ? { attach_info: attachInfo } : {}),
    })) as unknown;
    const outer = asRecord(payload);
    const data = asRecord(outer?.['data']) ?? outer;
    const retcode = Number(outer?.['retcode']);
    if (Number.isFinite(retcode) && retcode !== 0) throw new Error(`retcode ${retcode}`);
    const list = data?.['album_list'] ?? outer?.['album_list'];
    for (const raw of Array.isArray(list) ? list : []) {
      const albumId = stringField(raw, ['album_id', 'id']);
      if (albumId === undefined) continue;
      found.push({ albumId, albumName: (stringField(raw, ['name', 'album_name']) ?? '').trim() });
    }
    const hasMore = data?.['has_more'] === true || outer?.['has_more'] === true;
    const next = stringField(data, ['attach_info']) ?? stringField(outer, ['attach_info']) ?? '';
    if (!hasMore || next === '' || next === attachInfo) break;
    attachInfo = next;
  }
  return found;
}

async function groupNameOf(get: InternalGet, groupId: string): Promise<string> {
  try {
    const payload = await get('get_group_info', { group_id: Number(groupId) });
    const outer = asRecord(payload);
    const data = asRecord(outer?.['data']);
    return (stringField(data, ['group_name']) ?? stringField(outer, ['group_name']) ?? '').trim();
  } catch {
    return '';
  }
}

/** 逐个 bot 试该群，第一个能查到列表的 bot 认主（空列表也算查到了）。 */
async function botAlbumsOfGroup(
  bots: readonly AlbumBot[],
  groupId: string,
  maxPages: number,
): Promise<AlbumCandidate[]> {
  for (const bot of bots) {
    if (bot.platform !== 'onebot' || bot.hidden === true) continue;
    const get = internalGet(bot);
    if (get === undefined) continue;
    try {
      const albums = await albumListOfBot(get, groupId, maxPages);
      const groupName = await groupNameOf(get, groupId);
      return albums.map((album) => ({ groupId, groupName, albumId: album.albumId, albumName: album.albumName }));
    } catch {
      // 该群不归这个 bot，试下一个
    }
  }
  return [];
}

export interface AlbumProbeOptions {
  groupIds: readonly string[];
  bots: readonly AlbumBot[];
  service?: AlbumServiceLike;
  maxPages?: number;
}

/**
 * 探测若干群的相册。
 *
 * 优先用宿主投递服务（`miyako-delivery.listAlbums`，语义唯一实现处），
 * 返回空列表或服务缺失时回退到 bot 直查。单群失败不影响其它群。
 */
export async function probeGroupAlbums(options: AlbumProbeOptions): Promise<AlbumCandidate[]> {
  const { groupIds, bots, service, maxPages = DEFAULT_ALBUM_PAGES } = options;
  const albums: AlbumCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: AlbumCandidate): void => {
    const key = albumValue(candidate);
    if (seen.has(key) || albums.length >= MAX_ALBUM_CANDIDATES) return;
    seen.add(key);
    albums.push(candidate);
  };

  for (const groupId of groupIds) {
    let found: AlbumCandidate[] = [];
    if (typeof service?.listAlbums === 'function') {
      try {
        found = await service.listAlbums(groupId);
      } catch {
        found = [];
      }
    }
    if (found.length === 0) found = await botAlbumsOfGroup(bots, groupId, maxPages);
    for (const candidate of found) push({ ...candidate, groupId });
  }
  return albums;
}

/**
 * 合并「上一轮缓存」与「本轮探测」。
 *
 * 规则：本轮探测到相册的群整体覆盖；本轮为空的群**保留旧候选**——
 * 单群掉线 / QQ 限流 / 权限抖动都不能把该群的相册从下拉里抹掉。
 * 不再出现在探测范围内的群（机器人退群）丢弃。
 */
export function mergeAlbumCandidates(
  previous: readonly AlbumCandidate[],
  discovered: readonly AlbumCandidate[],
  groupIds: readonly string[],
): AlbumCandidate[] {
  const byGroup = (source: readonly AlbumCandidate[], groupId: string): AlbumCandidate[] =>
    source.filter((album) => album.groupId === groupId);
  const merged: AlbumCandidate[] = [];
  const seen = new Set<string>();
  for (const groupId of groupIds) {
    const fresh = byGroup(discovered, groupId);
    const candidates = fresh.length > 0 ? fresh : byGroup(previous, groupId);
    for (const candidate of candidates) {
      const key = albumValue(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
      if (merged.length >= MAX_ALBUM_CANDIDATES) return merged;
    }
  }
  return merged;
}

/**
 * 按探测范围过滤候选：**表外群的历史缓存直接丢弃**。
 *
 * 缓存文件按群累积，用户把某群从订阅表移除后，它的相册仍躺在 `albums.json` 里；
 * 不在这里砍掉，下拉里就会一直挂着「早就没订阅的测试群」的相册。
 *
 * `configured`（宿主 yml 里已保存的目标）是例外：表外相册只要被点名就保留，且**只保留
 * 这几个具体值**——它们所属群的其它相册照旧丢弃。静态 const union 的校验是严格的，
 * 丢一个已保存的值等于让整份配置过不了校验。
 */
export function scopeAlbumCandidates(
  albums: readonly AlbumCandidate[],
  groupIds: readonly string[],
  configured: readonly string[] = [],
): AlbumCandidate[] {
  const inScope = new Set(groupIds);
  const scoped = albums.filter((album) => inScope.has(album.groupId));
  if (configured.length === 0 || scoped.length === albums.length) return scoped;
  // yml 里的值可能是唯一可读名（新形态）或旧稳定地址：名字只做唯一匹配，歧义不参与（不猜）。
  const nameIndex = buildTargetNameIndex(albums);
  const wanted = new Set<string>();
  for (const raw of configured) {
    const trimmed = String(raw).trim();
    const value = /^\d+\/[^/]+$/u.test(trimmed) ? trimmed : nameIndex.get(trimmed);
    if (value !== undefined) wanted.add(value);
  }
  if (wanted.size === 0) return scoped;
  return albums.filter((album) => inScope.has(album.groupId) || wanted.has(albumValue(album)));
}

/** `albumSchemaUnion` 的形态开关。 */
export interface AlbumUnionOptions {
  /**
   * 订阅目标候选（`subscriptions[].targets`）：
   * - 首位放 `@chat`（本群聊天）而不是空串——`targets` 是数组，空数组本身就是「不投递」；
   * - 相册项按群分段：每组一条不可选的分组标题（`#group:<群号>`，见 `albumTargetOptions`）；
   * - 相册项取值 = 稳定地址 `群号/相册ID`，文案 = 短相册名（重名才追加 `（群名）` 等后缀）。
   */
  targets?: boolean;
}

/**
 * 已选但本轮探测不到的取值的说明文案。
 *
 * 值本身是 `群号/相册ID`，原样展示在标签里既难读又像 bug（用户确实报过
 * `100000001/ALBUM01…` 这种原始串）。拆成「<群号> 的相册 <相册ID>」并保留
 * 「未探测到」的原因提示；不是 `群号/相册ID` 形态的脏值原样带回。
 */
function describeUnprobed(value: string): string {
  const match = /^([^/]+)\/(.+)$/u.exec(value);
  if (match === null) return `${value}（未探测到）`;
  return `${match[1]} 的相册 ${match[2]}（未探测到：确认机器人在该群且相册已创建）`;
}

/** 一个订阅目标候选项。 */
export interface AlbumTargetOption {
  /**
   * 写进 `subscriptions[].targets` 的值：
   * - 相册项 = **唯一可读名**（相册名；同批重名加 `群名 · ` 前缀，再重加 `（群号）`，最后 `#n`）；
   * - `@chat` = 该行来源群聊天；
   * - 分组标题项 = `#group:<群号>`（不可选，只当下拉分段）。
   */
  value: string;
  /**
   * 下拉里的文案。相册项与 `value` 相同（schemastery-vue 的 `<el-option>` 没有 `:label`，
   * 标签只显示 value），标题项 = 群名，`@chat` = 说明句。
   */
  description?: string;
  /** 分组标题项：只当标题渲染、不可选（`Schema.disabled()`）。 */
  disabled?: boolean;
  /** 相册项对应的稳定地址 `群号/相册ID`：只用来建「名字 → 地址」表，不写进配置。 */
  albumValue?: string;
}

/** `@chat` 候选的文案（下拉里唯一一项「投到该行来源群聊天」）。 */
const CHAT_TARGET_DESCRIPTION = '本群聊天（投递到该行来源群本身）';

/** 分组键 / 标题文案：群名（缺失或空白回退群号）。 */
function albumGroupName(album: AlbumCandidate): string {
  const groupName = album.groupName.trim();
  return groupName !== '' ? groupName : album.groupId;
}

/**
 * 展示顺序：先按群名聚拢，组内按相册名，最后用稳定值兜底（结果唯一、可复现）。
 *
 * 用 `localeCompare('zh-Hans-CN')` 而不是码点比较：中文群名按拼音排，和用户翻下拉的
 * 直觉一致；分段只依赖「同群比较结果为 0」，与具体语言的排序规则无关。
 */
function compareAlbumsForDisplay(left: AlbumCandidate, right: AlbumCandidate): number {
  const compact = (album: AlbumCandidate): string => album.albumName.trim() || album.albumId;
  const byGroup = albumGroupName(left).localeCompare(albumGroupName(right), 'zh-Hans-CN');
  if (byGroup !== 0) return byGroup;
  const byAlbum = compact(left).localeCompare(compact(right), 'zh-Hans-CN');
  if (byAlbum !== 0) return byAlbum;
  return albumValue(left).localeCompare(albumValue(right), 'zh-Hans-CN');
}

/** 一条带唯一可读名的相册（名字与稳定地址的对应只在内存里用）。 */
interface NamedAlbumTarget {
  album: AlbumCandidate;
  /** 写进 `subscriptions[].targets` 的唯一可读名。 */
  name: string;
  /** 稳定地址 `群号/相册ID`。 */
  albumValue: string;
}

/**
 * 相册名恰好长得像稳定地址（`群号/相册ID`，例如就叫 `2026/Spring`）时，追加后缀直到不像。
 *
 * 不处理的两个后果都是静默错投：`resolveTargetBindings` 把名字当「已经是地址」跳过
 * （永不绑定 → 停投），`resolveTarget` 又拿它当地址解析（投到 `2026/Spring` 这个
 * 不存在的位置）。后缀里带**稳定地址**（本身含 `/`），一次就把形状破坏掉，
 * 而且每个相册的后缀不同，枚举内依然唯一。
 *
 * 未命名相册的兜底值就是它自己的地址，**不走这里**：地址天然唯一、必须可用。
 */
function escapeAddressShape(label: string, album: AlbumCandidate): string {
  let escaped = label;
  // 后缀含 `/`，所以至多一轮就退出（`^\d+/[^/]+$` 不可能匹配两个 `/`）。
  while (ALBUM_TARGET_PATTERN.test(escaped)) escaped = `${escaped}（${albumValue(album)}）`;
  return escaped;
}

/**
 * 相册 → 唯一可读名。**名字是持久化的值**，所以两条硬约束：
 *
 * 1. 枚举内唯一：同批重名一律加限定，绝不靠「先到先得」决定谁是裸名字
 *    （探测顺序会变，裸名字换主就等于把卡投进另一个群）；
 * 2. 永占保留值：`@chat` 与 `#group:<群号>` 不会被相册名截走。相册恰好叫 `@chat`
 *    （或 `#group:…`）时跳过裸名，直接落到限定名 `群名 · @chat`——它在候选里可见可选，
 *    但不占用保留值。
 *
 * 优先级：相册名（本批唯一时）→ `群名 · 相册名` → `群名 · 相册名（群号）` → 末尾 `#n`；
 * 相册名缺失（探测无名）→ 回退稳定地址 `群号/相册ID`（地址天然唯一）。
 * 相册名自己长得像地址（`2026/Spring`）时先按 `escapeAddressShape` 加限定：
 * 名字必须是**名字**，不能被当成地址跳过绑定、也不能被当地址投递。
 * 分配按**候选原顺序**，排序只影响展示。
 */
function nameAlbumTargets(albums: readonly AlbumCandidate[]): NamedAlbumTarget[] {
  const seen = new Set<string>();
  const candidates: AlbumCandidate[] = [];
  const plainCounts = new Map<string, number>();
  for (const album of albums) {
    const value = albumValue(album);
    if (seen.has(value)) continue;
    seen.add(value);
    candidates.push(album);
    const plain = album.albumName.trim();
    if (plain !== '') plainCounts.set(plain, (plainCounts.get(plain) ?? 0) + 1);
  }
  const taken = new Set<string>([CHAT_TARGET]);
  for (const album of candidates) taken.add(targetGroupValue(album.groupId));
  const named: NamedAlbumTarget[] = [];
  for (const album of candidates) {
    const value = albumValue(album);
    const plain = album.albumName.trim();
    const qualified = escapeAddressShape(
      `${albumGroupName(album)} · ${plain !== '' ? plain : value}`,
      album,
    );
    // 相册名缺失（探测无名）→ 直接用稳定地址：它天然唯一，也永远不是保留值。
    const preferred =
      plain === ''
        ? [value]
        : plainCounts.get(plain) === 1
          ? [escapeAddressShape(plain, album), qualified]
          : [qualified];
    const name = claimTargetName(taken, [...preferred, `${qualified}（${album.groupId}）`], value);
    named.push({ album, name, albumValue: value });
  }
  return named;
}

/** 按顺序取第一个未占用的名字；全被占用时在最后一个非保留名字后加 `#n`（保留值永不被截走）。 */
function claimTargetName(taken: Set<string>, preferred: readonly string[], fallback: string): string {
  let anchor = fallback;
  for (const candidate of preferred) {
    if (candidate === '' || candidate === CHAT_TARGET || isTargetGroupHeader(candidate)) continue;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
    anchor = candidate;
  }
  for (let n = 2; ; n += 1) {
    const label = `${anchor}#${n}`;
    if (taken.has(label)) continue;
    taken.add(label);
    return label;
  }
}

/**
 * `targets` 候选：`@chat` + 每个群一段（不可选的群名标题 + 该群相册） + 未探测保留项。
 *
 * **value 就是相册的唯一可读名**（见 `nameAlbumTargets`）：schemastery-vue 的
 * `<el-option>` 没有 `:label`，已选标签只显示 value，所以可读名必须直接当值。
 * 「不会错投」由两件事保证：枚举内名字唯一；**保存时**把名字绑定成 `群号/相册ID`
 * （`resolveTargetBindings`），投递期只查那张绑定表，查不到就**拒绝投递**并 warn
 * （见 `resolveTarget`），绝不按名字猜。
 *
 * 分组靠 `<el-option :disabled>`：上游的 multiselect 只渲染平铺选项（没有
 * `el-option-group`），于是每组先插一条 `#group:<群号>` 的不可选条目当标题，下拉看起来
 * 就是按群分段。标题项不是目标（见 `isTargetGroupHeader`），永远不会被选中或写出。
 */
export function albumTargetOptions(
  albums: readonly AlbumCandidate[],
  configured: readonly string[] = [],
): AlbumTargetOption[] {
  const named = nameAlbumTargets(albums);

  // 每个群一段：标题项（不可选）+ 该群相册（组内按相册名排序）。
  const buckets = new Map<string, NamedAlbumTarget[]>();
  for (const item of named) {
    const bucket = buckets.get(item.album.groupId);
    if (bucket === undefined) buckets.set(item.album.groupId, [item]);
    else bucket.push(item);
  }
  const groups = [...buckets.values()].sort((left, right) =>
    compareAlbumsForDisplay(left[0].album, right[0].album),
  );
  const options: AlbumTargetOption[] = [{ value: CHAT_TARGET, description: CHAT_TARGET_DESCRIPTION }];
  for (const bucket of groups) {
    bucket.sort((left, right) => compareAlbumsForDisplay(left.album, right.album));
    const { album } = bucket[0];
    options.push({ value: targetGroupValue(album.groupId), description: albumGroupName(album), disabled: true });
    for (const item of bucket) {
      options.push({ value: item.name, description: item.name, albumValue: item.albumValue });
    }
  }

  // 已配置但本轮探测不到的取值也要留在候选里：Koishi 只用 union 的 const 渲染选项，
  // 丢掉一个已保存的值就等于让整份插件配置过不了严格校验。
  const covered = new Set(options.map((option) => option.value));
  const nameIndex = buildTargetNameIndex(albums);
  const valueToName = new Map<string, string>();
  for (const item of named) {
    const albumName = item.album.albumName.trim() !== '' ? item.album.albumName.trim() : item.album.albumId;
    valueToName.set(item.albumValue, `${albumName}（${item.album.groupId}）`);
  }
  let extras = 0;
  for (const raw of configured) {
    if (extras >= MAX_CONFIGURED_TARGETS) break;
    const trimmed = String(raw ?? '').trim();
    if (trimmed === '' || trimmed === CHAT_TARGET || isTargetGroupHeader(trimmed)) continue;
    if (covered.has(trimmed)) continue;
    if (/^\d+\/.+$/u.test(trimmed)) {
      // 旧稳定地址：已迁移的值只在 yml 里还有（面板会写成名字），留着只为过校验。
      const known = valueToName.get(trimmed);
      options.push({
        value: trimmed,
        description:
          known === undefined
            ? describeUnprobed(trimmed)
            : `旧值 ${trimmed}（对应「${known}」，建议重新选择）`,
      });
    } else {
      // 旧可读名：候选里还能唯一解析就说明保存后能重新绑定，否则说清会被丢弃。
      const resolved = nameIndex.get(trimmed);
      options.push({
        value: trimmed,
        description:
          resolved === undefined
            ? `无法解析的旧值「${trimmed}」：相册可能已改名或删除，请重新选择`
            : `旧相册名「${trimmed}」（候选里对应 ${resolved}；保存后按它重新绑定）`,
        disabled: true,
      });
    }
    covered.add(trimmed);
    extras += 1;
  }
  return options;
}

/** 旧命名的候选项：`value` 是升级前可能写进 yml 的可读名，`albumValue` 是它对应的稳定地址。 */
export interface LegacyAlbumTargetOption {
  /** 升级前版本写进 `subscriptions[].targets` 的可读名（`群名 · 相册名`，重名带后缀）。 */
  value: string;
  /** 它指向的稳定地址 `群号/相册ID`。 */
  albumValue: string;
}

/**
 * 旧命名的候选项：`群名 · 相册名`（同批重名追加 `（群号）`、同群同名再追加 `（群号/相册ID）`）。
 *
 * 只用于**旧值迁移**：升级前的订阅行存的就是这套文案，`buildLegacyTargetIndex` 用它做
 * 唯一匹配；匹配不到或匹配到多个的一律丢弃（绝不猜）。
 */
export function legacyAlbumTargetOptions(albums: readonly AlbumCandidate[]): LegacyAlbumTargetOption[] {
  return buildTargetOptions(albums, (album) => {
    const albumName = album.albumName.trim();
    const groupName = album.groupName.trim();
    const value = albumValue(album);
    // 名字不全就整体回退成稳定值：`群1 · a` 这种半可读串既难读也帮不上忙。
    return {
      base: groupName !== '' && albumName !== '' ? `${groupName} · ${albumName}` : value,
      suffixes: [album.groupId, value],
    };
  }).map((item) => item.option);
}

/**
 * 旧短名 → 稳定地址的**候选索引**（同一个旧名可能对应多个相册：跨群同名）。
 *
 * 归一阶段只做唯一匹配：`values.length === 1` 才转换，其余丢弃并 warn。
 * 键是升级前版本可能保存过的全部可读形态：
 * - 短相册名（更早版本）；
 * - `群名 · 相册名` 及其重名后缀（上一版）；
 * - `相册名（群名）` / `相册名（群号）`：更早版本把「短名 + 群」直接拼成一个值写出，
 *   与新版下拉的重名后缀同一套形状（`词条（群1）` / `词条（1）`）。
 *
 * 条数 ≤ 4 × 候选数，与候选缓存同一份数据，不额外读盘。
 */
export function buildLegacyTargetIndex(albums: readonly AlbumCandidate[]): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  const add = (label: string, value: string): void => {
    const trimmed = label.trim();
    // 名字缺失时旧版本的 value 就是稳定地址本身，不需要登记。
    if (trimmed === '' || trimmed === value) return;
    // 保留值永不登记：相册恰好叫 `@chat` / `#group:…` 时，只能被改名成 `群名 · @chat`
    // 再出现在候选里，绝不能借相册名把保留值变成相册投递点。
    if (trimmed === CHAT_TARGET || isTargetGroupHeader(trimmed)) return;
    const bucket = index.get(trimmed);
    if (bucket === undefined) index.set(trimmed, new Set([value]));
    else bucket.add(value);
  };
  for (const album of albums) {
    const value = albumValue(album);
    const albumName = album.albumName.trim();
    const groupName = album.groupName.trim();
    if (albumName === '') continue;
    add(albumName, value);
    // 后缀形态：群名 / 群号都登记。同名同群的多个相册会落进同一个桶（长度 ≥2 =
    // 歧义），`buildTargetNameIndex` 只登记恰好一个候选的别名，冲突照旧不登记。
    if (groupName !== '') {
      add(`${groupName} · ${albumName}`, value);
      add(`${albumName}（${groupName}）`, value);
    }
    add(`${albumName}（${album.groupId}）`, value);
  }
  for (const option of legacyAlbumTargetOptions(albums)) add(option.value, option.albumValue);
  return new Map([...index].map(([label, values]) => [label, [...values].sort()]));
}

/**
 * 可读名 → 稳定地址的**候选索引**（保存订阅表与首轮迁移用它把名字绑定成地址）。
 *
 * 这里是**保存期**的解析：用当时的候选把面板交上来的名字换成 `群号/相册ID`，结果写进
 * `settings.json` 的 `targetBindings`。投递期只读那张绑定表，不再碰这个索引
 * （否则探测顺序变化 / 别的群出现同名相册就会悄悄换主）。
 *
 * 只登记恰好一个候选的名字：本批重名的短名不登记（只有 `nameAlbumTargets` 实际分配
 * 给某个相册的名字、以及旧索引里唯一匹配的别名才会进来），解析不到就是「未绑定」。
 * 保留值（`@chat` / `#group:`）永不登记。
 *
 * 条数 ≤ 5 × 候选数，与候选缓存同一份数据，不额外读盘。
 */
export function buildTargetNameIndex(albums: readonly AlbumCandidate[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const item of nameAlbumTargets(albums)) index.set(item.name, item.albumValue);
  for (const [label, values] of buildLegacyTargetIndex(albums)) {
    if (values.length !== 1 || index.has(label)) continue;
    index.set(label, values[0]);
  }
  return index;
}

/** `POST /api/subscriptions` 响应与日志里上报的未绑定名字上限（有界）。 */
export const MAX_UNRESOLVED_TARGETS = 64;

/** 保存订阅表时的绑定结果。 */
export interface TargetBindingResult {
  /** 名字 → 稳定地址；这是 `targetBindings` 的**整份新值**（旧绑定在这里被替换/丢弃）。 */
  bindings: Record<string, string>;
  /** 解析不到或与旧绑定冲突的名字：保留名字但不绑定，投递期停投并 warn。 */
  unresolved: string[];
}

/**
 * 保存订阅表时把名字绑定成稳定地址（`settings.json` 的 `targetBindings`）。
 *
 * 跳过两类值：`@chat` / `#group:`（保留值，本来就不是相册）与已经是 `群号/相册ID`
 * 的旧地址（不需要解析）。其余名字按**当时候选**解析，规则只有「不猜」：
 *
 * 1. **已有绑定**：本轮候选里还能看到那个相册（`live`）→ 绑定原样保留。名字即使换了主
 *    （探测顺序 / 别的群出现同名相册）也不会改写收件人；候选为空（探测抖动 / 掉线）时
 *    同样原样保留——没有证据就不动。
 * 2. **已有绑定、但相册在候选里没了**：掉绑并进 `unresolved` → 停投 + warn，
 *    绝不给同名的新相册当替身。
 * 3. **没有绑定的名字，但上一次落盘的那一行里就有它**（`previousRows`）：那时也没绑上
 *    （就是掉绑后留下的），**不再尝试解析**，继续 `unresolved`。这是「掉绑」的持久标记：
 *    否则下一次同样的保存会把名字当新名字，绑到别的群恰好同名的相册上——那正是
 *    「一次相册消失，下次保存静默改投」的来路。用户显式改过这一行（值变了 → 名字不在
 *    上一次的行里）才重新解析。
 * 4. **其余没有绑定的名字**：解析成功就绑定；解析不到（歧义 / 改名 / 已删除）进 `unresolved`。
 *
 * 「上一次落盘的行」本身就是标记，不需要另存一份 `unresolvedTargets`：它与绑定表
 * 同一次原子落盘、同一个真源，不可能与行分叉（见 `writeSubscriptionOverride`）。
 *
 * 绑定只从当前行重建：删掉的目标不会留下孤儿绑定（上限 = 行数 × 单行目标数）。
 */
export function resolveTargetBindings(
  rows: readonly SubscriptionRow[],
  albums: readonly AlbumCandidate[],
  previous: Readonly<Record<string, string>> = {},
  previousRows: readonly SubscriptionRow[] = [],
): TargetBindingResult {
  const index = buildTargetNameIndex(albums);
  // 探测为空时「相册还在不在」无从判断：已有绑定一律原样保留，免得一次掉线清空投递。
  const live = albums.length === 0 ? undefined : new Set(albums.map(albumValue));
  // 上一次落盘时就没绑上的（来源群, 名字）：本次同样的行不再重解析（见规则 3）。
  const dropped = new Set<string>();
  for (const row of previousRows) {
    const source = row.source.trim();
    for (const target of row.targets) {
      const name = target.trim();
      if (name === '' || Object.hasOwn(previous, name)) continue;
      dropped.add(rowKey(source, name));
    }
  }
  const bindings: Record<string, string> = {};
  const unresolved: string[] = [];
  const reported = new Set<string>();
  const report = (name: string): void => {
    if (reported.has(name) || unresolved.length >= MAX_UNRESOLVED_TARGETS) return;
    reported.add(name);
    unresolved.push(name);
  };
  for (const row of rows) {
    for (const target of row.targets) {
      const name = target.trim();
      if (name === '' || name === '__proto__') continue;
      if (name === CHAT_TARGET || isTargetGroupHeader(name)) continue;
      if (ALBUM_TARGET_PATTERN.test(name)) continue;
      // 只认自有键：`constructor` / `toString` 这类原型属性不得被当成绑定。
      const existing = Object.hasOwn(previous, name) ? previous[name] : undefined;
      if (existing !== undefined) {
        if (live === undefined || live.has(existing)) bindings[name] = existing;
        else report(name);
        continue;
      }
      if (dropped.has(rowKey(row.source.trim(), name))) {
        report(name);
        continue;
      }
      const address = index.get(name);
      if (address !== undefined) bindings[name] = address;
      else report(name);
    }
  }
  return { bindings, unresolved };
}

/** 「来源群 + 名字」的复合键（`\u0000` 不会出现在群号 / 相册名里）。 */
function rowKey(source: string, name: string): string {
  return `${source}\u0000${name}`;
}

/**
 * 面板 `targets` 的可选值集合：候选唯一名 + 候选稳定地址（旧值兼容）。
 *
 * `POST /api/subscriptions` 用它做白名单：名字是面板写出的形态，
 * 稳定地址只为让升级前没迁移的表原样保存（否则一保存就被 400）。
 */
export function albumTargetValues(albums: readonly AlbumCandidate[]): string[] {
  const values: string[] = [];
  for (const item of nameAlbumTargets(albums)) values.push(item.name, item.albumValue);
  return values;
}

/** 标签唯一化：`base` 被占用就按 `suffixes` 顺序试 `（…）`，全占用再加 `#n`。 */
function claimLabel(taken: Set<string>, base: string, suffixes: readonly string[]): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (const suffix of suffixes) {
    const label = `${base}（${suffix}）`;
    if (!taken.has(label)) {
      taken.add(label);
      return label;
    }
  }
  const last = suffixes[suffixes.length - 1] ?? base;
  for (let n = 2; ; n += 1) {
    const label = `${base}（${last}#${n}）`;
    if (!taken.has(label)) {
      taken.add(label);
      return label;
    }
  }
}

/** `buildTargetOptions` 的中间形态：还带着候选本身（旧命名表要按候选顺序分配后缀）。 */
interface BuiltTargetOption {
  option: { value: string; albumValue: string };
  album: AlbumCandidate;
}

/**
 * 候选 → 带唯一标签的选项列表（同一相册的重复候选直接丢掉）。
 *
 * 只服务**旧命名索引**（`legacyAlbumTargetOptions`）：现行候选的唯一可读名由
 * `nameAlbumTargets` 分配，规则不同（重名一律加群名、`#n` 收尾）。
 */
function buildTargetOptions(
  albums: readonly AlbumCandidate[],
  labelOf: (album: AlbumCandidate) => { base: string; suffixes: readonly string[] },
): BuiltTargetOption[] {
  const built: BuiltTargetOption[] = [];
  const taken = new Set<string>();
  const seen = new Set<string>();
  for (const album of albums) {
    const value = albumValue(album);
    if (seen.has(value)) continue;
    seen.add(value);
    const { base, suffixes } = labelOf(album);
    built.push({ option: { value: claimLabel(taken, base, suffixes), albumValue: value }, album });
  }
  return built;
}

/**
 * 相册 / 订阅目标的候选 union。
 *
 * 已配置但本轮探测不到的值也保留一个带说明的条目，否则用户一保存配置，
 * 旧值就会在下拉里消失（Koishi 只用 union 里的 const 渲染选项）。
 */
export function albumSchemaUnion(
  albums: readonly AlbumCandidate[],
  configured: readonly string[],
  options: AlbumUnionOptions = {},
): Schema {
  return Schema.union(albumUnionItems(albums, configured, options));
}

/**
 * 候选 union 的 const 列表。
 *
 * 单独暴露给「插件重载时刷新候选」用：`targets` 的 schema 是模块顶层求值的，
 * `apply()` 只需把 `inner.list` 换成这一份新列表（见 `refreshSubscriptionTargets`）。
 */
export function albumUnionItems(
  albums: readonly AlbumCandidate[],
  configured: readonly string[],
  options: AlbumUnionOptions = {},
): Schema[] {
  // 多选目标：顺序、分组标题（不可选）、`@chat` 与未探测保留项都由 `albumTargetOptions` 定。
  if (options.targets === true) {
    return albumTargetOptions(albums, configured).map((option) => {
      const item = Schema.const(option.value).description(option.description ?? option.value);
      return option.disabled === true ? item.disabled() : item;
    });
  }
  /** 已经出现的 const value → 说明文案（同时充当去重集合）。 */
  const described = new Map<string, string>();
  // 单选项（`albumDelivery.albums`）把空值放在 union 首位：控制台「添加项目」拿第一个
  // const 作为新行默认值，新行必须默认「不上传」，否则会静默挑中某个群相册。
  const items: Schema[] = [
    Schema.const('').description(
      albums.length === 0 && configured.length === 0
        ? '尚未探测到相册：机器人入群并建好相册后，候选会在下一次探测（最多 15 分钟）后自动出现'
        : '不上传相册（留空即跳过）',
    ),
  ];
  for (const album of albums) {
    const groupName = album.groupName !== '' ? album.groupName : album.groupId;
    const albumName = album.albumName !== '' ? album.albumName : album.albumId;
    const value = albumValue(album);
    const description = `${groupName}（${album.groupId}）/ ${albumName}`;
    described.set(value, description);
    items.push(Schema.const(value).description(description));
  }
  let extras = 0;
  for (const value of configured) {
    if (extras >= MAX_CONFIGURED_TARGETS) break;
    const trimmed = String(value ?? '').trim();
    if (trimmed === '' || described.has(trimmed)) continue;
    // 旧 `群号/相册ID` 值（改名前的选择 / 手填）照旧保留：静态 const union 的校验是严格的，
    // 丢掉就等于让整份插件配置过不了校验。
    const description = describeUnprobed(trimmed);
    items.push(Schema.const(trimmed).description(description));
    described.set(trimmed, description);
    extras += 1;
  }
  return items;
}

/**
 * 订阅表 `targets` 的 schema：**多选标签**，候选由调用方给（模块加载时一份，
 * `apply()` 每次重载原地替换 `inner.list`）。
 *
 * 形态必须是 `array(const union)` + `role: 'select'`：schemastery-vue 的
 * `isMultiSelect()` 只认 `array` 的 inner 是纯 const union，`SchemaMultiSelect`
 * 的注册条件是 `type: 'array'` 且 `meta.role === 'select'`。
 *
 * 与 `albumDelivery.albums` 的 `Schema.dynamic` 不同，这里**不能**用 dynamic：
 * 订阅表是 `.role('table')`，表格列在渲染前就按 `toColumns(inner)` 校验，
 * dynamic 解析太晚（那时只是 `Schema.any()`）。
 */
export function subscriptionTargetsSchema(
  albums: readonly AlbumCandidate[],
  configured: readonly string[],
): Schema {
  return Schema.array(albumSchemaUnion(albums, configured, { targets: true }))
    .role('select')
    .default([])
    .description(TARGETS_FIELD_DESCRIPTION);
}

/** `targets` 的文案：表格里 description 就是列头，别再写第二行说明。 */
export const TARGETS_FIELD_DESCRIPTION = '投递群（可多个）';


/**
 * 相册缓存 JSON → 候选：清洗 + 上限（异步读取与启动期同步读取共用这一处）。
 *
 * 缓存文件是外部可写的，脏条目一律丢弃；条数封顶 `MAX_ALBUM_CANDIDATES`，
 * 别让一份手改过的缓存把 schema union 撑大。
 */
export function parseAlbumCandidates(payload: unknown): AlbumCandidate[] {
  if (!Array.isArray(payload)) return [];
  const albums: AlbumCandidate[] = [];
  for (const raw of payload) {
    if (albums.length >= MAX_ALBUM_CANDIDATES) break;
    const groupId = stringField(raw, ['groupId']);
    const albumId = stringField(raw, ['albumId']);
    if (groupId === undefined || albumId === undefined) continue;
    albums.push({
      groupId,
      albumId,
      groupName: stringField(raw, ['groupName']) ?? '',
      albumName: stringField(raw, ['albumName']) ?? '',
    });
  }
  return albums;
}

/** 读取上一次探测结果；文件缺失或损坏时返回空数组。 */
export async function readAlbumCache(wikiDir: string): Promise<AlbumCandidate[]> {
  try {
    return parseAlbumCandidates(JSON.parse(await fs.readFile(albumCachePath(wikiDir), 'utf8')) as unknown);
  } catch {
    return [];
  }
}

// ── 启动期静态候选（订阅表 `targets` 用）─────────────────────────────────

/**
 * 实例配置文件名（相对实例目录），按 `Loader.findConfig` 的顺序找：
 * `['koishi.config', 'koishi']` × 支持的扩展名。第一个存在的就是本次启动用的配置。
 */
export const STARTUP_CONFIG_FILES = [
  'koishi.yml',
  'koishi.yaml',
  'koishi.json',
  'koishi.config.yml',
  'koishi.config.yaml',
  'koishi.config.json',
] as const;

/** 本插件在 `plugins` 树里的键名（实例键可能带 `~` 前缀或 `:id` 后缀）。 */
const PLUGIN_CONFIG_KEY = 'patchouli-knowledge';

/** `readStartupTargetValues` 的结果：相册候选 + yml 里已配置的目标值 + 持久化绑定表。 */
export interface StartupTargetValues {
  albums: AlbumCandidate[];
  /** 已配置但可能没探测到的目标（交给 `albumSchemaUnion` 保留成「未探测到」条目）。 */
  configured: string[];
  /** `settings.json` 的 `targetBindings`：可读名 → 稳定地址（投递期解析的唯一真源）。 */
  bindings: Record<string, string>;
}

export interface StartupTargetOptions {
  /**
   * 实例目录（`ctx.baseDir`）：`koishi.yml` 与相对 `wikiDir` 的锚点。
   *
   * 必须传插件上下文里的 `ctx.baseDir`，**不能靠 `process.cwd()`**——Koishi 多实例 / 以服务方式
   * 启动时 cwd 常常不是实例目录，读错目录会让严格 const union 把整份配置拒载。
   * 留空才回退 `process.cwd()`（单进程脚本 / 测试的直接调用）。
   */
  baseDir?: string;
}

/** `ENOENT`（该文件名不存在）——换下一个候选配置名，不是故障。 */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * js-yaml 的 `load`。
 *
 * 宿主没把 js-yaml 列进本包 dependencies（它是 Koishi 的传递依赖），所以按三个锚点解析：
 * 实例目录（ini 与 `node_modules` 都在那里）→ 本插件目录 → koishi 所在目录（pnpm 下
 * 依赖只在 `.pnpm/<pkg>/node_modules` 里可见，从 koishi 出发才看得到）。
 * 一个都解析不到时返回 `undefined`，调用方降级成空候选——少一个可选依赖绝不能连累插件加载。
 */
function loadYaml(baseDir: string): { load?: (text: string) => unknown } | undefined {
  const anchors: string[] = [baseDir, __dirname];
  try {
    anchors.push(dirname(createRequire(__filename).resolve('koishi')));
  } catch {
    // koishi 解析不到就少一个锚点
  }
  for (const anchor of anchors) {
    try {
      const requireFrom = createRequire(joinPath(anchor, 'noop.js'));
      const mod = requireFrom('js-yaml') as { load?: (text: string) => unknown } | undefined;
      if (typeof mod?.load === 'function') return mod;
    } catch {
      // 换下一个锚点
    }
  }
  return undefined;
}

/** `plugins` 树里的本插件块（键名匹配；`~` 前缀 / `:id` 后缀 / 分组嵌套都算）。 */
function patchouliBlocks(root: unknown): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 32) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (record === undefined || seen.has(record)) return;
    seen.add(record);
    for (const [key, value] of Object.entries(record)) {
      const base = key.replace(/^[~!]/u, '').split(':')[0];
      if (base === PLUGIN_CONFIG_KEY || base.endsWith(`/${PLUGIN_CONFIG_KEY}`)) {
        const block = asRecord(value);
        if (block !== undefined) blocks.push(block);
      }
      walk(value, depth + 1);
    }
  };
  walk(root, 0);
  return blocks;
}

/**
 * yml 里 `subscriptions[].targets`（+ 历史 `target` 单值 / 字符串数组）的已配置目标，去重。
 *
 * 上界是订阅表自身的硬上限（`MAX_CONFIGURED_TARGETS` = 行数 × 每行目标数），不是裁剪：
 * 任何能通过 Schema 校验的表都在这个数以内，所以这里的每个值都能进候选 union，
 * 也就都能通过严格校验（少一个 = 整份配置拒载）。
 */
function configuredFromBlocks(blocks: readonly Record<string, unknown>[]): string[] {
  const configured: string[] = [];
  for (const block of blocks) {
    const rows = block['subscriptions'];
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = asRecord(raw);
      if (row === undefined) continue;
      const targets = row['targets'];
      const legacy = row['target'];
      // `targets` 键存在即权威：显式 `[]` 不该让残留的旧 `target` 重新进候选。
      const values: unknown[] =
        targets !== undefined
          ? Array.isArray(targets)
            ? [...targets]
            : [targets]
          : Array.isArray(legacy)
            ? [...legacy]
            : [legacy];
      for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed === '' || trimmed === CHAT_TARGET || configured.includes(trimmed)) continue;
        configured.push(trimmed);
        if (configured.length >= MAX_CONFIGURED_TARGETS) return configured;
      }
    }
  }
  return configured;
}

/**
 * 订阅目标候选：同步读一次实例配置 + 相册缓存 + `settings.json` 的绑定表。
 *
 * 调用两次：模块加载期（`Config` 求值时算初值，首次启动就能用）与 `apply()` 每次
 * **重载**（`require` 缓存让重载不重跑模块顶层，不重算的话新相册永远进不了候选）。
 *
 * 为什么必须是静态 const union：订阅表是 `.role('table')`，表格列要求 inner 是
 * **静态** const union（`toColumns` 在渲染前校验），`Schema.dynamic` 的解析发生在
 * 渲染期，永远赶不上。
 *
 * 读取内容：
 * - 全部路径锚定**实例目录**（`ctx.baseDir`，缺省才用 `process.cwd()`），不跟进程 cwd 走；
 * - `plugins` 树里本插件块的 `storage.wikiDir`（缺省 `data/llmwiki`）；
 * - `<wikiDir>/.patchouli/albums.json`（上次探测结果，即候选）；
 * - `<wikiDir>/.patchouli/settings.json` 的 `targetBindings`（名字 → 稳定地址）；
 * - 同一批插件块的 `subscriptions[].targets`（+ 历史 `target`，供「未探测到」保留项）。
 *
 * `configured` 必须把配置里已有的目标都带上：静态 const union 的校验是严格的，
 * 候选里没有的值会让整个插件配置过不了校验（这正是「表格列无法用动态候选」的代价）。
 *
 * **任何异常都降级成空候选**：它跑在 `apply()` 的早段，抛错会让整个插件起不来，
 * 而它给出的只是「下拉里多几个选项」。
 */
export function readStartupTargetValues(options: StartupTargetOptions = {}): StartupTargetValues {
  const empty: StartupTargetValues = { albums: [], configured: [], bindings: {} };
  try {
    /* 所有路径锚定实例目录（插件传 `ctx.baseDir`）；只有它为空才退回进程 cwd。 */
    const baseDir = options.baseDir?.trim() || process.cwd();
    const yaml = loadYaml(baseDir);
    if (yaml?.load === undefined) return empty;
    let document: unknown = undefined;
    for (const name of STARTUP_CONFIG_FILES) {
      try {
        document = yaml.load(readFileSync(joinPath(baseDir, name), 'utf8'));
        break;
      } catch (error) {
        // 该文件名不存在 → 试下一个；解析失败是真故障 → 外层降级。
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
    if (document === undefined) return empty;
    const blocks = patchouliBlocks(asRecord(document)?.['plugins'] ?? document);
    let wikiDir = DEFAULT_WIKI_SUBDIR;
    for (const block of blocks) {
      const raw = asRecord(block['storage'])?.['wikiDir'];
      if (typeof raw === 'string' && raw.trim() !== '') {
        wikiDir = raw.trim();
        break;
      }
    }
    let albums: AlbumCandidate[] = [];
    try {
      albums = parseAlbumCandidates(JSON.parse(readFileSync(albumCachePath(resolvePath(baseDir, wikiDir)), 'utf8')));
    } catch {
      albums = [];
    }
    // 绑定表与相册缓存同一目录：读不到 = 尚未建立绑定（首轮迁移会补），不是故障。
    return {
      albums,
      configured: configuredFromBlocks(blocks),
      bindings: readTargetBindingsSync(resolvePath(baseDir, wikiDir)),
    };
  } catch {
    return empty;
  }
}

/**
 * 投递期用的两张表：一张把**名字解析成投递地址**（落盘绑定表），一张只给日志起可读文案。
 *
 * 「解析不了就拒绝」是这一层的安全边界：绑定表里没有的名字（相册改过名 / 已删除 /
 * 从未保存过的旧值）一律按解析失败处理，丢弃并 warn，绝不按当前候选猜名字。
 */
export interface StartupTargetMaps {
  /** 名字 → 稳定地址 `群号/相册ID`（**来自 `settings.json` 的 `targetBindings`**）。 */
  nameToValue: Map<string, string>;
  /** `群号/相册ID` → 日志文案 `相册名（群号）`（`formatSubscriptionLogLines` 用）。 */
  valueToName: Map<string, string>;
}

/**
 * 当前候选的展示表：`群号/相册ID` → `相册名（群号）`。
 *
 * 只影响日志文案，不参与投递；同名相册光写名字分不清群，光写地址又没法读。
 * 条数 = 候选数，与候选缓存是同一份数据。
 */
export function albumValueNames(albums: readonly AlbumCandidate[]): Map<string, string> {
  const valueToName = new Map<string, string>();
  for (const album of albums) {
    const albumName = album.albumName.trim() !== '' ? album.albumName.trim() : album.albumId;
    valueToName.set(albumValue(album), `${albumName}（${album.groupId}）`);
  }
  return valueToName;
}

/**
 * 由「候选 + 落盘绑定表」构建两张表（模块加载期算一次，`apply()` 每次重载 / 每轮探测重算）。
 *
 * `nameToValue` **只来自绑定表**：探测候选只负责展示文案与下拉，绝不参与解析。
 */
export function readStartupTargetTables(values: StartupTargetValues): StartupTargetMaps {
  return {
    nameToValue: new Map(Object.entries(values.bindings)),
    valueToName: albumValueNames(values.albums),
  };
}

/**
 * 安装解析 / 展示表（`installSubscriptionTargetLabels` 的唯一调用点）。
 *
 * 解析表 = 落盘绑定表；展示表 = 当前候选。两者刻意分开：候选每轮都会变，
 * 绑定只有在「保存订阅表 / 首轮迁移」时才改写。
 */
export function installTargetTables(values: StartupTargetValues): void {
  installSubscriptionTargetLabels(readStartupTargetTables(values));
}

/** 落盘探测结果（失败只影响下次冷启动的候选，不影响当前会话）。 */
export async function writeAlbumCache(wikiDir: string, albums: readonly AlbumCandidate[]): Promise<boolean> {
  try {
    await fs.mkdir(joinPath(wikiDir, '.patchouli'), { recursive: true });
    await fs.writeFile(albumCachePath(wikiDir), JSON.stringify(albums, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 相册目录快照：面板 `GET /api/albums` 的响应体。 */
export interface AlbumCatalog {
  albums: AlbumCandidate[];
  /** 上次探测时刻（epoch 毫秒）；`null` = 既没有缓存也没有探测成功。 */
  probedAt: number | null;
}

/** 缓存文件的写入时刻 = 上次探测完成时刻（`albums.json` 只由探测路径写）。 */
export async function albumCacheProbedAt(wikiDir: string): Promise<number | null> {
  try {
    const stat = await fs.stat(albumCachePath(wikiDir));
    return Number.isFinite(stat.mtimeMs) ? Math.floor(stat.mtimeMs) : null;
  } catch {
    return null;
  }
}

/**
 * 读取相册目录：**缓存优先**，缓存为空时才用 `probe` 现场探测一次并回写缓存。
 *
 * 面板每次打开都要拿到候选，但探测要打 OneBot / 宿主投递服务（秒级、有限流），
 * 因此冷启动才探测。探测失败（抛错或空结果）返回空目录 + `probedAt: null`——
 * 面板不该因为「机器人掉线」收到 500。
 */
export async function loadAlbumCatalog(
  wikiDir: string | undefined,
  probe?: () => Promise<readonly AlbumCandidate[]>,
): Promise<AlbumCatalog> {
  const dir = typeof wikiDir === 'string' && wikiDir.trim() !== '' ? wikiDir : undefined;
  if (dir !== undefined) {
    const cached = await readAlbumCache(dir);
    if (cached.length > 0) return { albums: cached, probedAt: await albumCacheProbedAt(dir) };
  }
  if (probe === undefined) return { albums: [], probedAt: null };
  let discovered: readonly AlbumCandidate[];
  try {
    discovered = await probe();
  } catch {
    return { albums: [], probedAt: null };
  }
  const albums = discovered.slice(0, MAX_ALBUM_CANDIDATES);
  if (albums.length === 0) return { albums: [], probedAt: null };
  const probedAt = Date.now();
  if (dir !== undefined) await writeAlbumCache(dir, albums);
  return { albums, probedAt };
}
