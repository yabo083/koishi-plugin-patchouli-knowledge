/**
 * 群相册目录：把 SnowLuma / OneBot 探测到的相册变成控制台可选候选项。
 *
 * 配置项 `topicDelivery.albums` 声明为 `Schema.array(Schema.dynamic('patchouli.album'))`，
 * 候选项由 `ctx.schema.set(ALBUM_SCHEMA_KEY, ...)` 注入（schemastery 的 `dynamic` 角色）：
 * Console 的 schema 数据服务订阅 `internal/schema` 事件，注入后**在线页面立即拿到新候选**，
 * 不需要重启插件或刷新页面。相册无法由 bot 创建，这里只探测已经存在的相册。
 *
 * 探测范围是「白名单群 ∪ 机器人所在全部群」：`channels` 是**监听**白名单，
 * 相册是**投递**目标，两者语义独立——新拉群 + 新建相册不应该要求先改监听白名单。
 */

import { promises as fs } from 'node:fs';
import { join as joinPath } from 'node:path';
import { Schema } from 'koishi';

/** 动态 schema 的注册键（`Schema.dynamic` 与 `ctx.schema.set` 必须一致）。 */
export const ALBUM_SCHEMA_KEY = 'patchouli.album';

/** 单群相册分页上限：SnowLuma 每页 10 条，5 页足够覆盖常见群。 */
export const DEFAULT_ALBUM_PAGES = 5;

/** 探测群数量上限：机器人被拉进大量群时避免一次刷新打满 OneBot。 */
export const MAX_PROBE_GROUPS = 40;

/** 候选总数上限：防止 schema union 无限膨胀。 */
export const MAX_ALBUM_CANDIDATES = 400;

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
 * 相册配置项的候选 union。
 *
 * 已配置但本轮探测不到的值也保留一个带说明的条目，否则用户一保存配置，
 * 旧值就会在下拉里消失（Koishi 只用 union 里的 const 渲染选项）。
 */
export function albumSchemaUnion(
  albums: readonly AlbumCandidate[],
  configured: readonly string[],
): Schema {
  const values = new Set(albums.map(albumValue));
  // 空值放在 union 首位：控制台「添加项目」拿第一个 const 作为新行默认值，
  // 新行必须默认「不上传」，否则会静默挑中某个群相册。
  const items: Schema[] = [
    Schema.const('').description(
      albums.length === 0 && configured.length === 0
        ? '尚未探测到相册：机器人入群并建好相册后，候选会在下一次探测（最多 15 分钟）后自动出现'
        : '不上传相册（留空即跳过）',
    ),
  ];
  for (const album of albums) {
    items.push(
      Schema.const(albumValue(album)).description(
        `${album.groupName !== '' ? album.groupName : '群'}（${album.groupId}）/ ${album.albumName !== '' ? album.albumName : album.albumId}`,
      ),
    );
  }
  for (const value of configured) {
    const trimmed = String(value ?? '').trim();
    if (trimmed === '' || values.has(trimmed)) continue;
    items.push(Schema.const(trimmed).description(`${trimmed}（未探测到：确认机器人在该群且相册已创建）`));
    values.add(trimmed);
  }
  return Schema.union(items);
}

/** 读取上一次探测结果；文件缺失或损坏时返回空数组。 */
export async function readAlbumCache(wikiDir: string): Promise<AlbumCandidate[]> {
  try {
    const payload: unknown = JSON.parse(await fs.readFile(albumCachePath(wikiDir), 'utf8'));
    if (!Array.isArray(payload)) return [];
    const albums: AlbumCandidate[] = [];
    for (const raw of payload) {
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
  } catch {
    return [];
  }
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
