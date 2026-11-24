/**
 * 知识周报（相册总结）的**来源规划 + 执行**。
 *
 * 订阅表把「哪个来源参与周报」写在 `weekly` 行上：来源 A 的周报只该带 A 的主题，
 * 也只该投到 A 的相册。旧实现取全库最近 500 条主题渲染一张图再投所有相册，
 * 于是只给 A 开周报时 A 的相册也会收到 B 群的主题。
 *
 * 这里按来源分组：
 * - 每个来源查一次该频道的主题（`*` 行 = 全库，沿用旧口径）；
 * - 同一批主题跨来源命中时 PNG 复用（只渲染一次）；
 * - 同一来源的多行目标取并集，逐相册去重投递。
 *
 * 来源判据是 `WikiEntryRecord.channelId`：主题聚合（`TopicCurator.buildTopicEntry`）
 * 写入的就是被校准的来源群，`LocalStore.getRecentEntries(channelId)` 按它精确过滤，
 * 与词条投递（`entryTargets` 按来源建索引）同一条依据。
 */
import type { PublicWikiView } from '../wiki/public-view';
import type { WikiEntryRecord } from '../wiki/storage';
import {
  ALBUM_TARGET_PATTERN,
  albumValueOfTarget,
  CHAT_TARGET,
  isTargetGroupHeader,
  type SubscriptionSnapshot,
} from './subscriptions';

/** 单个来源单轮取材上限（沿用旧值：全库最近 500 条）。 */
export const WEEKLY_TOPIC_LIMIT = 500;

/** 监听全部群的 `weekly` 行（也是订阅表为空时的来源标记）。 */
export const WEEKLY_ALL_SOURCES = '*';

/** 卡片复用缓存上限：跨来源同主题集合几乎不存在，留几格只为兜住重复查询。 */
const MAX_CACHED_PNGS = 4;

export interface WeeklyAlbumLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** `deliverCardPng` 的结果里周报用得到的字段。 */
export interface WeeklyAlbumDeliveryOutcome {
  ok: boolean;
  skipped?: string;
  error?: { code?: string; message?: string };
}

export interface WeeklyAlbumDeps {
  /** ISO 周键（日志 / 卡片标题）。 */
  readonly weekKey: string;
  /** 本次触发的分钟桶；参与每张相册的去重键。 */
  readonly fireKey: string;
  /** 取材水位（时间戳）：只收 `updatedAt >= since` 的主题。 */
  readonly since: number;
  readonly snapshot: SubscriptionSnapshot;
  /** 订阅表为空时的相册候选（`albumDelivery.albums`，非相册形状的项会被丢弃）。 */
  readonly fallbackAlbums: readonly string[];
  /**
   * 额度预筛（按稳定地址判断该相册本周还有额度）：用尽的目标不取材、不渲染。
   * 只是省算力，**最终仍以 `deliver` 里的占额为准**。
   */
  readonly allowTarget?: (album: string) => boolean;
  readonly logger: WeeklyAlbumLogger;
  readonly recentEntries: (channelId: string | undefined, limit: number) => Promise<readonly WikiEntryRecord[]>;
  /** 词条 → 脱敏后的公开视图；读正文 / 原始会话失败时返回 `undefined`。 */
  readonly buildView: (record: WikiEntryRecord) => Promise<PublicWikiView | undefined>;
  readonly render: (views: readonly PublicWikiView[], weekKey: string) => Promise<Buffer | null>;
  /** 投递一个相册产物；`source` 是本次取材来源（投递策略 / 日志据此归属）。 */
  readonly deliver: (
    album: string,
    png: Buffer,
    dedupeKey: string,
    source: string,
  ) => Promise<WeeklyAlbumDeliveryOutcome>;
}

export interface WeeklyAlbumRunResult {
  ok: boolean;
  reason?: string;
  uploaded: number;
}

/** 一个来源的相册目标并集（按首次出现顺序去重）。 */
export interface WeeklyAlbumSourcePlan {
  readonly source: string;
  readonly albums: readonly string[];
}

/**
 * 订阅表 → 来源计划。订阅表为空（`active=false`）时退回旧的全局行为：
 * 全库主题 → `fallbackAlbums` 里的全部相册。
 *
 * `allowTarget` 是**额度预筛**：周报每目标每自然周限量，已经用尽的目标不必取材、
 * 不必渲染（最终仍以投递前的占额为准——预筛只是省掉一次无用的取材与渲染）。
 */
export function planWeeklyAlbumSources(
  snapshot: SubscriptionSnapshot,
  fallbackAlbums: readonly string[],
  allowTarget?: (album: string) => boolean,
): WeeklyAlbumSourcePlan[] {
  if (!snapshot.active) {
    const albums = uniqueStrings(
      fallbackAlbums.filter(
        (value) => ALBUM_TARGET_PATTERN.test(value) && (allowTarget === undefined || allowTarget(value)),
      ),
    );
    return albums.length === 0 ? [] : [{ source: WEEKLY_ALL_SOURCES, albums }];
  }
  const bySource = new Map<string, string[]>();
  for (const row of snapshot.weekly) {
    const collected = bySource.get(row.source) ?? [];
    for (const target of row.targets) {
      const trimmed = target.trim();
      // `@chat` 与分组标题不是相册：这里**显式**跳过，不依赖解析层的兜底——
      // 哪怕某天绑定表里混进了保留值键，周报也不会把整张卡传到相册里。
      if (trimmed === '' || trimmed === CHAT_TARGET || isTargetGroupHeader(trimmed)) continue;
      // 剩下的按「绑定表里的名字 → 稳定地址」解析：未绑定 / 已变更的名字拿不到地址，
      // 停投 + warn（解析层负责告警），绝不改投到同名相册。
      const value = albumValueOfTarget(trimmed);
      if (value === undefined || collected.includes(value)) continue;
      if (allowTarget !== undefined && !allowTarget(value)) continue;
      collected.push(value);
    }
    bySource.set(row.source, collected);
  }
  // 没有相册目标的来源（只勾了周报却没选相册）不参与：没有投递点，取材也没人看。
  return [...bySource.entries()]
    .filter(([, albums]) => albums.length > 0)
    .map(([source, albums]) => ({ source, albums }));
}

/**
 * 按来源取材 → 渲染 → 投递。返回值与原「全库周报」保持一致：
 * 无主题 `no-topics`（不算失败）、渲染不出来 `render-failed`、一张都没投出去 `upload-failed`。
 */
export async function runWeeklyAlbumDelivery(deps: WeeklyAlbumDeps): Promise<WeeklyAlbumRunResult> {
  const plans = planWeeklyAlbumSources(deps.snapshot, deps.fallbackAlbums, deps.allowTarget);
  if (plans.length === 0) return { ok: false, reason: 'album-not-configured', uploaded: 0 };

  /** 主题 id 集合 → PNG（`null` = 渲染失败，避免同一批主题反复撞 puppeteer）。 */
  const pngByTopics = new Map<string, Buffer | null>();
  let totalTopics = 0;
  let uploaded = 0;
  let renderFailed = false;

  for (const plan of plans) {
    const topics = await selectRecentTopics(deps, plan.source);
    totalTopics += topics.length;
    if (topics.length === 0) {
      deps.logger.info(`[Patchouli] 知识周报 ${deps.weekKey} 来源 ${plan.source}：最近 7 天没有新主题`);
      continue;
    }

    const topicKey = topics.map((record) => record.id).sort().join('\n');
    const cached = pngByTopics.get(topicKey);
    let png: Buffer | null;
    if (cached === undefined) {
      const views = await buildWeeklyViews(deps, topics);
      png = views.length === 0 ? null : await deps.render(views, deps.weekKey);
      if (pngByTopics.size < MAX_CACHED_PNGS) pngByTopics.set(topicKey, png);
      if (png === null) {
        renderFailed = true;
        deps.logger.warn(
          `[Patchouli] 知识周报 ${deps.weekKey} 来源 ${plan.source} 渲染失败：宿主未提供 puppeteer 或截图异常`,
        );
      }
    } else {
      png = cached;
    }
    if (png === null) {
      deps.logger.warn(`[Patchouli] 知识周报 ${deps.weekKey} 来源 ${plan.source}：${topics.length} 个主题没有可用卡片，跳过投递`);
      continue;
    }

    for (const album of plan.albums) {
      const outcome = await deps.deliver(album, png, `${deps.fireKey}:${plan.source}:${album}`, plan.source);
      if (outcome.ok && outcome.skipped === undefined) uploaded += 1;
      else if (!outcome.ok && outcome.skipped === undefined) {
        deps.logger.warn(
          `[Patchouli] 知识周报上传 ${album} 失败: ${outcome.error?.code ?? 'UNKNOWN'} ${outcome.error?.message ?? ''}`,
        );
      }
    }
    deps.logger.info(
      `[Patchouli] 知识周报 ${deps.weekKey} 来源 ${plan.source}：${topics.length} 个主题 → 投递 ${plan.albums.length} 个目标`,
    );
  }

  if (totalTopics === 0) return { ok: true, reason: 'no-topics', uploaded: 0 };
  if (renderFailed && uploaded === 0) return { ok: false, reason: 'render-failed', uploaded: 0 };
  return uploaded > 0 ? { ok: true, uploaded } : { ok: false, reason: 'upload-failed', uploaded: 0 };
}

/** 该来源最近 7 天有更新的主题（`*` = 全库）。 */
async function selectRecentTopics(
  deps: WeeklyAlbumDeps,
  source: string,
): Promise<WikiEntryRecord[]> {
  const channelId = source === WEEKLY_ALL_SOURCES ? undefined : source;
  const recent = await deps.recentEntries(channelId, WEEKLY_TOPIC_LIMIT);
  return recent.filter((record) => record.kind === 'topic' && (record.updatedAt ?? 0) >= deps.since);
}

/** 批量做视图转换：读不到正文的条目（`undefined`）只丢它自己，不连坐整张卡。 */
async function buildWeeklyViews(
  deps: WeeklyAlbumDeps,
  topics: readonly WikiEntryRecord[],
): Promise<PublicWikiView[]> {
  const views = await Promise.all(topics.map((record) => deps.buildView(record)));
  return views.filter((view): view is PublicWikiView => view !== undefined);
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
