/**
 * Patchouli Knowledge —— 跨时间「主题聚合」内核
 *
 * 职责边界：
 *  - 选定窗口：`now - lookbackDays * 86400e3` 到 `now` 内**尚未归入任何主题**的普通词条；
 *  - 确定性分组：标签 Jaccard 优先归入已有主题，其余在本地聚类（不依赖模型）；
 *  - 让模型在给定分组内写主题综述与时间轴贡献，只允许沿用候选主题或新建；
 *  - 按「先合并旧时间轴 → 再写主题词条」的顺序落盘。
 *
 * 主题聚合的边界：
 *  - 只生成 `kind: 'topic'` 主题词条；
 *  - 不把来源词条标记 `superseded`，也不改它们的 Markdown；
 *  - 主题是长期聚合视图：已有主题沿用原 id 追加时间轴，新主题按成员 id 派生稳定 id。
 *
 * 本模块不持有定时器、不读插件配置、不碰 Koishi：调度与 `TopicConfig` 的 Schema 由
 * 集成方接线，这里只提供一次可重入的运行函数。
 *
 * 红线：模型失败 / 输出不可解析时**零写入**；重跑只处理剩余未分配词条，天然幂等。
 */

import { createHash } from 'node:crypto';

import {
  buildTopicMessages,
  truncateText,
  type EntryDigest,
  type PromptMessage,
  type TopicCandidateDigest,
  type TopicGroupInput,
} from '../dispatcher/prompts';
import { coerceGlossary, coerceNarrative } from '../dispatcher/dispatcher';
import type { TopicConfig, TopicTimelineItem, WikiEntry } from '../types';
import { formatDate, sourcePathOf, type WikiEngine } from './engine';
import type { LocalStore, WikiEntryRecord } from './storage';

/** 一天的毫秒数。 */
const DAY_MS = 86_400_000;
/** 单次校准最多产出的分组数量（其余留到下一轮）。 */
const MAX_GROUPS = 5;
/** 标题关键词的最短长度（中文按二元词计，英文按整词计）。 */
const TITLE_TOKEN_MIN_CHARS = 2;
/** 标题共享关键词数量达到该值即视为同簇。 */
const TITLE_TOKEN_SHARED = 2;
/** 主题标题缺省值的拼接长度上限。 */
const TITLE_FALLBACK_LIMIT = 48;

export interface TopicRunOptions {
  /** 覆盖注入时钟（毫秒时间戳），便于测试与补跑。 */
  now?: number;
  /**
   * 强制重跑：当前实现不影响结果（未分配词条的判定本身就是幂等的），
   * 保留给调度器 / 运维入口透传，避免调用方分支。
   */
  force?: boolean;
}

/**
 * 一次主题校准的结果。
 *
 * `skippedReason`：
 * - `disabled`：总开关关闭，零读写；
 * - `no-entries`：窗口内没有可归入的普通词条，或分组不足 2 个成员且没有可并入的主题；
 * - `model-failed`：模型调用异常 / 输出不可解析，**零写入**；
 * - `already-ran`：保留的兼容取值，主题聚合的幂等由 `no-entries` 表达，当前不会产生。
 */
export interface TopicRunResult {
  channelId: string;
  /** 本地时区的 `YYYY-MM-DD`。 */
  dayKey: string;
  /** 本次新建的主题词条 id。 */
  createdTopicIds: string[];
  /** 本次追加了时间轴的已有主题 id。 */
  updatedTopicIds: string[];
  /** 本次归入主题的普通词条 id。 */
  assignedEntryIds: string[];
  skippedReason?: 'disabled' | 'no-entries' | 'already-ran' | 'model-failed';
  /** 面向日志的人类可读补充说明（失败原因、被丢弃的越界分组等）。 */
  detail?: string;
}

export interface TopicCuratorDeps {
  engine: WikiEngine;
  store: LocalStore;
  /** 模型调用器（通常接 `ModelDispatcher.invokeRaw`）；失败必须抛出。 */
  invoke: (messages: PromptMessage[]) => Promise<{ text: string }>;
  /** 主题聚合系统提示词提供者（支持热更新）；缺省使用内置 `TOPIC_CURATOR_SYSTEM_PROMPT`。 */
  systemPrompt?: () => string;
  logger?: { info(msg: string): void; warn(msg: string): void };
  /** 可注入时钟，便于测试。 */
  now?: () => number;
}

/** 确定性分组的候选组。 */
interface TopicGroup {
  groupId: string;
  entryIds: string[];
  /** 已挂靠的现有主题 id（缺省 = 新建）。 */
  topicId?: string;
  sharedTags: string[];
}

/** 通过校验的模型计划（成员 id 已确认属于该组）。 */
interface AcceptedTopicPlan {
  group: TopicGroup;
  topicId: string | null;
  payload: Record<string, unknown>;
  timeline: Array<{ entryId: string; contribution: string }>;
}

type JsonObject = Record<string, unknown>;

/**
 * 主题聚合器。
 *
 * 一次 `runChannel` 只处理一个群：捡未分配词条 → 确定性分组 → 模型写综述 → 落盘主题。
 * 所有写操作都发生在模型成功返回并通过校验之后，失败路径不产生任何文件。
 */
export class TopicCurator {
  private readonly engine: WikiEngine;
  private readonly store: LocalStore;
  private readonly invoke: TopicCuratorDeps['invoke'];
  private readonly systemPrompt?: TopicCuratorDeps['systemPrompt'];
  private readonly logger?: TopicCuratorDeps['logger'];
  private readonly clock: () => number;

  constructor(deps: TopicCuratorDeps) {
    if (!deps || typeof deps !== 'object') {
      throw new TypeError('TopicCurator: deps 必填');
    }
    if (!deps.engine || !deps.store) {
      throw new TypeError('TopicCurator: deps.engine / deps.store 必填');
    }
    if (typeof deps.invoke !== 'function') {
      throw new TypeError('TopicCurator: deps.invoke 必须是函数');
    }
    this.engine = deps.engine;
    this.store = deps.store;
    this.invoke = deps.invoke;
    this.systemPrompt = deps.systemPrompt;
    this.logger = deps.logger;
    this.clock = deps.now ?? Date.now;
  }

  /**
   * 对一个群执行一次主题校准。
   *
   * 短路顺序：`disabled` → `no-entries`。模型失败一律 `model-failed` 且不写任何文件。
   */
  async runChannel(
    channelId: string,
    config: TopicConfig,
    options: TopicRunOptions = {},
  ): Promise<TopicRunResult> {
    if (typeof channelId !== 'string' || channelId.trim() === '') {
      throw new TypeError('TopicCurator.runChannel: channelId 必填');
    }
    const nowMs = options.now ?? this.clock();
    const dayKey = formatDate(new Date(nowMs));
    const base: TopicRunResult = {
      channelId,
      dayKey,
      createdTopicIds: [],
      updatedTopicIds: [],
      assignedEntryIds: [],
    };

    if (!config || config.enabled !== true) {
      return { ...base, skippedReason: 'disabled' };
    }

    const topics = (await this.store.queryEntries({ channelId })).filter(
      (record) => record.kind === 'topic',
    );
    const assigned = collectAssignedEntryIds(topics);

    const windowStart = nowMs - Math.max(1, Math.floor(config.lookbackDays)) * DAY_MS;
    const windowRecords = await this.store.listEntriesBetween(windowStart, nowMs, channelId);
    // 时间轴成员天然幂等：已归入任何主题的普通词条不再参与本轮。
    const newRecords = windowRecords.filter((record) => isCuratable(record) && !assigned.has(record.id));

    const minimum = Math.max(1, Math.floor(config.minEntries));
    if (newRecords.length === 0 || newRecords.length < minimum) {
      return { ...base, skippedReason: 'no-entries' };
    }

    const groups = buildGroups(newRecords, topics, config.mergeThreshold);
    if (groups.length === 0) {
      // 单条孤立词条既进不了主题也凑不成簇：留给下一轮，绝不为此调用模型。
      return { ...base, skippedReason: 'no-entries' };
    }

    const topicDigests = topics.map(toTopicDigest);
    const newEntries = newRecords.map(toDigest);

    let raw: string;
    try {
      raw = (
        await this.invoke(
          buildTopicMessages({
            dayLabel: dayLabelOf(nowMs),
            channelId,
            newEntries,
            topics: topicDigests,
            groups: groups.map(toGroupInput),
          }, this.systemPrompt?.()),
        )
      ).text;
    } catch (error) {
      const detail = `模型调用失败：${describeError(error)}`;
      this.logger?.warn(`[patchouli-topics] ${channelId} ${detail}`);
      return { ...base, skippedReason: 'model-failed', detail };
    }

    const payload = extractJsonObject(raw);
    if (payload === undefined || !Array.isArray(payload.topics)) {
      const detail = '模型输出不是含 `topics` 数组的 JSON 对象';
      this.logger?.warn(`[patchouli-topics] ${channelId} ${detail}`);
      return { ...base, skippedReason: 'model-failed', detail };
    }

    const allowedTopicIds = new Set(topics.map((record) => record.id));
    const { plans, dropped } = validateTopicPlans(payload.topics, groups, allowedTopicIds);
    if (dropped.length > 0) {
      this.logger?.warn(
        `[patchouli-topics] ${channelId} 丢弃越界分组 ${dropped.length} 组：${dropped.join('；')}`,
      );
    }

    const recordById = new Map<string, WikiEntryRecord>();
    for (const record of newRecords) recordById.set(record.id, record);

    const createdTopicIds: string[] = [];
    const updatedTopicIds: string[] = [];
    const assignedEntryIds: string[] = [];

    for (const plan of plans) {
      const previous = plan.topicId === null ? undefined : topics.find((item) => item.id === plan.topicId);
      const members = await this.collectMembers(plan, previous, recordById);
      if (members.size === 0) continue;

      const timeline = mergeTimeline(previous?.timeline ?? [], plan.timeline, members);
      if (timeline.length === 0) continue;

      const entry = this.buildTopicEntry({
        plan,
        previous,
        members,
        timeline,
        dayKey,
        channelId,
      });

      await this.engine.saveEntry(entry);
      await this.store.saveEntry(entry, this.engine.entryPath(entry.id));

      if (plan.topicId === null) createdTopicIds.push(entry.id);
      else updatedTopicIds.push(entry.id);
      for (const item of plan.timeline) {
        if (members.has(item.entryId)) assignedEntryIds.push(item.entryId);
      }
    }

    const uniqueAssigned = uniqueStrings(assignedEntryIds);
    this.logger?.info(
      `[patchouli-topics] ${channelId} ${dayKey} 完成：创建 ${createdTopicIds.length} / 更新 ${updatedTopicIds.length} 主题，` +
        `归入 ${uniqueAssigned.length} 条`,
    );

    return {
      channelId,
      dayKey,
      createdTopicIds,
      updatedTopicIds,
      assignedEntryIds: uniqueAssigned,
      ...(dropped.length > 0 ? { detail: `丢弃越界分组 ${dropped.length} 组` } : {}),
    };
  }

  /**
   * 取本次计划涉及的全部时间轴成员记录：新词条直接复用窗口内记录，旧时间轴成员回查仓储。
   * 返回 `entryId -> record`；查不到的成员（脏数据 / 已删除）由调用方跳过。
   */
  private async collectMembers(
    plan: AcceptedTopicPlan,
    previous: WikiEntryRecord | undefined,
    recordById: Map<string, WikiEntryRecord>,
  ): Promise<Map<string, WikiEntryRecord>> {
    const ids = new Set<string>();
    for (const item of previous?.timeline ?? []) if (item.entryId !== '') ids.add(item.entryId);
    for (const item of plan.timeline) ids.add(item.entryId);

    const members = new Map<string, WikiEntryRecord>();
    for (const id of ids) {
      const known = recordById.get(id);
      if (known !== undefined) {
        members.set(id, known);
        continue;
      }
      const record = await this.store.getEntry(id);
      if (record !== undefined) members.set(id, record);
    }
    return members;
  }

  /** 组装主题词条：时间轴合并结果 + 模型综述 + 成员聚合元数据。 */
  private buildTopicEntry(input: {
    plan: AcceptedTopicPlan;
    previous: WikiEntryRecord | undefined;
    members: Map<string, WikiEntryRecord>;
    timeline: TopicTimelineItem[];
    dayKey: string;
    channelId: string;
  }): WikiEntry {
    const { plan, previous, members, timeline } = input;
    const payload = plan.payload;
    const memberRecords = timeline
      .map((item) => members.get(item.entryId))
      .filter((record): record is WikiEntryRecord => record !== undefined);

    const declaredParticipants = readStringList(payload, 'participants');
    const participants = uniqueStrings([
      ...declaredParticipants,
      ...memberRecords.flatMap((record) => record.participants),
    ]);
    const declaredTags = readStringList(payload, 'tags');
    const tags =
      declaredTags.length > 0
        ? uniqueStrings(declaredTags)
        : uniqueStrings(memberRecords.flatMap((record) => record.tags));

    const fallbackTitle = truncateText(
      uniqueStrings(timeline.map((item) => item.title)).join('、'),
      TITLE_FALLBACK_LIMIT,
    );
    const narrative = coerceNarrative(payload.narrative);
    const glossary = coerceGlossary(payload.glossary);
    const id = plan.topicId ?? topicIdOf(input.dayKey, timeline.map((item) => item.entryId));

    return {
      id,
      title: readText(payload, 'title') || previous?.title || fallbackTitle || `${input.dayKey} 的主题`,
      channelId: input.channelId,
      // 主题的 date 是「最近一次校准日」，方便索引按新鲜度排序；时间轴保存真实发生日期。
      date: input.dayKey,
      status: 'tentative',
      tags,
      summary: readText(payload, 'summary') || previous?.summary || memberRecords[0]?.summary || '',
      background: readText(payload, 'background'),
      participants,
      debateMatrix: [],
      consensus: readStringList(payload, 'consensus'),
      openQuestions: readStringList(payload, 'openQuestions'),
      keyQuotes: [],
      metadata: aggregateMetadata(memberRecords),
      kind: 'topic',
      sources: timeline.map((item) => sourcePathOf(item.entryId)),
      related: uniqueStrings(timeline.map((item) => item.title)),
      timeline,
      ...(narrative.length > 0 ? { narrative } : {}),
      ...(glossary.length > 0 ? { glossary } : {}),
    };
  }
}

/* ------------------------------------------------------------------ *
 * 候选挑选与确定性分组
 * ------------------------------------------------------------------ */

/** 可参与主题聚合的词条：普通 `debate`（kind 缺省或 debate）且未被历史归并。 */
function isCuratable(record: WikiEntryRecord): boolean {
  if (record.status === 'superseded') return false;
  return record.kind === undefined || record.kind === 'debate';
}

/** 已被任何主题收录的普通词条 id（时间轴成员不再重复归入）。 */
function collectAssignedEntryIds(topics: readonly WikiEntryRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const topic of topics) {
    for (const item of topic.timeline ?? []) {
      if (typeof item.entryId === 'string' && item.entryId.length > 0) ids.add(item.entryId);
    }
  }
  return ids;
}

/** 词条 → 提交给模型的摘要（不喂整篇正文）。 */
function toDigest(record: WikiEntryRecord): EntryDigest {
  return {
    id: record.id,
    title: record.title,
    date: record.date,
    status: record.status,
    tags: [...record.tags],
    summary: record.summary,
    participants: [...record.participants],
  };
}

function toTopicDigest(record: WikiEntryRecord): TopicCandidateDigest {
  return {
    id: record.id,
    title: record.title,
    tags: [...record.tags],
    summary: record.summary,
    timeline: (record.timeline ?? []).map((item) => ({
      date: item.date,
      title: item.title,
      summary: item.summary,
      ...(item.contribution !== undefined ? { contribution: item.contribution } : {}),
    })),
  };
}

function toGroupInput(group: TopicGroup): TopicGroupInput {
  return {
    groupId: group.groupId,
    entryIds: [...group.entryIds],
    sharedTags: [...group.sharedTags],
    ...(group.topicId !== undefined ? { topicId: group.topicId } : {}),
  };
}

/**
 * 确定性分组（结果与输入顺序无关）：
 *  1. 每条新词条先找标签 Jaccard ≥ 门限的已有主题，取相似度最高者（同分取 id 小的）；
 *  2. 找不到归属的，按「标签 Jaccard 或标题共享 ≥2 关键词」单链接聚类；
 *  3. 只保留「新词条 + 已有主题」总数 ≥ 2 的组，按「已有主题优先、成员多者优先」排序取前 5 组。
 */
function buildGroups(
  records: readonly WikiEntryRecord[],
  topics: readonly WikiEntryRecord[],
  threshold: number,
): TopicGroup[] {
  const bound = Math.min(1, Math.max(0, Number.isFinite(threshold) ? threshold : 1));
  const recordById = new Map(records.map((record) => [record.id, record]));

  const byTopic = new Map<string, string[]>();
  const remaining: WikiEntryRecord[] = [];

  for (const record of records) {
    let best: { id: string; score: number } | undefined;
    for (const topic of topics) {
      const score = tagSimilarity(record.tags, topic.tags);
      if (score <= 0 || score < bound) continue;
      if (
        best === undefined ||
        score > best.score ||
        (score === best.score && topic.id < best.id)
      ) {
        best = { id: topic.id, score };
      }
    }
    if (best === undefined) {
      remaining.push(record);
      continue;
    }
    const bucket = byTopic.get(best.id);
    if (bucket === undefined) byTopic.set(best.id, [record.id]);
    else bucket.push(record.id);
  }

  const groups: TopicGroup[] = [];
  for (const [topicId, entryIds] of byTopic) {
    const members = entryIds
      .map((id) => recordById.get(id))
      .filter((record): record is WikiEntryRecord => record !== undefined);
    if (members.length === 0) continue;
    const topic = topics.find((item) => item.id === topicId);
    const shared = sharedTagsOf(members);
    groups.push({
      groupId: '',
      entryIds: members.map((record) => record.id),
      topicId,
      sharedTags: shared.length > 0 ? shared : (topic?.tags ?? []).slice(0, 3),
    });
  }

  for (const cluster of buildClusters(remaining, bound)) {
    groups.push({
      groupId: '',
      entryIds: cluster.entryIds,
      sharedTags: cluster.sharedTags,
    });
  }

  const kept = groups.filter((group) => group.entryIds.length + (group.topicId === undefined ? 0 : 1) >= 2);
  kept.sort((left, right) => {
    const leftTopic = left.topicId === undefined ? 0 : 1;
    const rightTopic = right.topicId === undefined ? 0 : 1;
    if (leftTopic !== rightTopic) return rightTopic - leftTopic;
    if (left.entryIds.length !== right.entryIds.length) return right.entryIds.length - left.entryIds.length;
    return left.entryIds[0] < right.entryIds[0] ? -1 : 1;
  });

  return kept.slice(0, MAX_GROUPS).map((group, index) => ({ ...group, groupId: `group-${index + 1}` }));
}

/** 单链接 + 并查集聚类，只保留成员 ≥2 的簇。 */
function buildClusters(
  records: readonly WikiEntryRecord[],
  threshold: number,
): Array<{ entryIds: string[]; sharedTags: string[] }> {
  const generic = genericTokens(records);
  const clusters: WikiEntryRecord[][] = [];

  /* 完全链接：新条目必须与簇内**每一个**成员都达到阈值才并入，避免
     「A~B、B~C 但 A 与 C 无关」的单链接串联把整个群聊串成一个巨主题。 */
  for (const record of records) {
    let best: WikiEntryRecord[] | undefined;
    let bestScore = 0;
    for (const cluster of clusters) {
      let total = 0;
      let linked = true;
      for (const member of cluster) {
        const score = linkScore(record, member, generic);
        if (score < threshold) {
          linked = false;
          break;
        }
        total += score;
      }
      if (!linked || cluster.length === 0) continue;
      const average = total / cluster.length;
      if (average > bestScore) {
        bestScore = average;
        best = cluster;
      }
    }
    if (best === undefined) clusters.push([record]);
    else best.push(record);
  }

  return clusters
    .filter((group) => group.length >= 2)
    .map((group) => ({
      entryIds: group.map((record) => record.id),
      sharedTags: sharedTagsOf(group),
    }));
}

interface GenericTokens {
  titles: ReadonlySet<string>;
  tags: ReadonlySet<string>;
}

/** 去掉在本次候选集里高频出现的通用词（如「明日方舟」），只让具体信号参与聚类。 */
function genericTokens(records: readonly WikiEntryRecord[]): GenericTokens {
  const titleCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  for (const record of records) {
    for (const token of new Set(tokenizeTitle(record.title))) {
      titleCount.set(token, (titleCount.get(token) ?? 0) + 1);
    }
    for (const tag of new Set(normalizeTags(record.tags))) {
      tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    }
  }
  const titleLimit = Math.max(3, Math.ceil(records.length * 0.5));
  const tagLimit = Math.max(3, Math.ceil(records.length * 0.6));
  return {
    titles: new Set([...titleCount].filter(([, count]) => count >= titleLimit).map(([token]) => token)),
    tags: new Set([...tagCount].filter(([, count]) => count >= tagLimit).map(([tag]) => tag)),
  };
}

function linkScore(left: WikiEntryRecord, right: WikiEntryRecord, generic: GenericTokens): number {
  const tagScore = specificTagSimilarity(left.tags, right.tags, generic.tags);
  const leftTokens = tokenizeTitle(left.title).filter((token) => !generic.titles.has(token));
  if (leftTokens.length === 0) return tagScore;
  const rightTokens = new Set(tokenizeTitle(right.title).filter((token) => !generic.titles.has(token)));
  let shared = 0;
  for (const token of leftTokens) {
    if (!rightTokens.has(token)) continue;
    shared += 1;
    if (shared >= TITLE_TOKEN_SHARED) return Math.max(tagScore, 1);
  }
  return tagScore;
}

function specificTagSimilarity(
  left: readonly string[],
  right: readonly string[],
  generic: ReadonlySet<string>,
): number {
  const leftSet = new Set([...normalizeTags(left)].filter((tag) => !generic.has(tag)));
  const rightSet = new Set([...normalizeTags(right)].filter((tag) => !generic.has(tag)));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const tag of leftSet) if (rightSet.has(tag)) intersection += 1;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function isLinked(left: WikiEntryRecord, right: WikiEntryRecord, threshold: number): boolean {
  const similarity = tagSimilarity(left.tags, right.tags);
  if (similarity > 0 && similarity >= threshold) return true;
  const leftTokens = tokenizeTitle(left.title);
  if (leftTokens.length === 0) return false;
  const rightTokens = new Set(tokenizeTitle(right.title));
  let shared = 0;
  for (const token of leftTokens) {
    if (!rightTokens.has(token)) continue;
    shared += 1;
    if (shared >= TITLE_TOKEN_SHARED) return true;
  }
  return false;
}

/** 标签 Jaccard：两边并集为空时返回 0（无证据，不因「都没标签」而聚成一团）。 */
function tagSimilarity(left: readonly string[], right: readonly string[]): number {
  const leftSet = normalizeTags(left);
  const rightSet = normalizeTags(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const tag of leftSet) {
    if (rightSet.has(tag)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeTags(tags: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const tag of tags) {
    const key = tag.trim().toLowerCase();
    if (key.length > 0) set.add(key);
  }
  return set;
}

/** 标题关键词：英文/数字整词（≥2 字符）+ 中文二元词。 */
function tokenizeTitle(title: string): string[] {
  const normalized = title.toLowerCase();
  const tokens = new Set<string>();
  for (const matched of normalized.matchAll(/[a-z0-9]{2,}/gu)) tokens.add(matched[0]);
  for (const matched of normalized.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const run = matched[0];
    for (let cursor = 0; cursor + TITLE_TOKEN_MIN_CHARS <= run.length; cursor += 1) {
      tokens.add(run.slice(cursor, cursor + TITLE_TOKEN_MIN_CHARS));
    }
  }
  return [...tokens];
}

/** 簇内所有成员共享的标签（大小写不敏感，保留首次出现的写法）。 */
function sharedTagsOf(group: readonly WikiEntryRecord[]): string[] {
  if (group.length === 0) return [];
  const counts = new Map<string, number>();
  const spelling = new Map<string, string>();
  for (const record of group) {
    const seen = new Set<string>();
    for (const tag of record.tags) {
      const key = tag.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!spelling.has(key)) spelling.set(key, tag.trim());
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count === group.length)
    .map(([key]) => spelling.get(key) ?? key);
}

/* ------------------------------------------------------------------ *
 * 模型输出解析与计划校验
 * ------------------------------------------------------------------ */

/** 剥掉 ```json 围栏后取首个 `{` 到末个 `}`，容错解析模型输出。 */
function extractJsonObject(text: string): JsonObject | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const stripped = text.replace(/```(?:json)?/giu, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 校验 `topics`：分组必须存在、每组最多一次、`topicId` 必须是候选主题或 `null`、
 * 分组已指定主题时必须沿用、`timeline.entryId` 必须属于该组。
 * 不合法只丢弃该组（记入 `dropped`），绝不让整轮失败。
 */
function validateTopicPlans(
  raw: unknown,
  groups: readonly TopicGroup[],
  allowedTopicIds: ReadonlySet<string>,
): { plans: AcceptedTopicPlan[]; dropped: string[] } {
  const plans: AcceptedTopicPlan[] = [];
  const dropped: string[] = [];
  if (!Array.isArray(raw)) return { plans, dropped };

  const groupById = new Map(groups.map((group) => [group.groupId, group]));
  const usedGroups = new Set<string>();
  const claimedTopics = new Set<string>();

  for (const item of raw) {
    if (!isObject(item)) {
      dropped.push('topic 不是对象');
      continue;
    }
    const groupId = readText(item, 'groupId');
    const group = groupById.get(groupId);
    if (group === undefined) {
      dropped.push(`未知分组 ${groupId || '(空)'}`);
      continue;
    }
    if (usedGroups.has(groupId)) {
      dropped.push(`分组 ${groupId} 重复输出`);
      continue;
    }

    const declared = readText(item, 'topicId');
    const topicId = declared.length === 0 || declared === 'null' ? null : declared;
    if (topicId !== null && !allowedTopicIds.has(topicId)) {
      dropped.push(`分组 ${groupId} 的 topicId 越界：${topicId}`);
      continue;
    }
    if (group.topicId !== undefined && topicId !== group.topicId) {
      dropped.push(`分组 ${groupId} 必须沿用主题 ${group.topicId}（收到 ${topicId ?? 'null'}）`);
      continue;
    }
    if (group.topicId === undefined && topicId !== null) {
      dropped.push(`分组 ${groupId} 是新建组，topicId 必须为 null（收到 ${topicId}）`);
      continue;
    }
    if (topicId !== null && claimedTopics.has(topicId)) {
      dropped.push(`主题 ${topicId} 被多组重复归入`);
      continue;
    }

    const timeline = readTimeline(item, group);
    if (timeline.error !== undefined) {
      dropped.push(`分组 ${groupId} 的 ${timeline.error}`);
      continue;
    }

    usedGroups.add(groupId);
    if (topicId !== null) claimedTopics.add(topicId);
    plans.push({ group, topicId, payload: item, timeline: timeline.items });
  }

  return { plans, dropped };
}

/** 读取 `timeline`：成员必须属于该组，重复 id 去重（保留首次出现的贡献）。 */
function readTimeline(
  item: JsonObject,
  group: TopicGroup,
): { items: Array<{ entryId: string; contribution: string }>; error?: string } {
  if (!Array.isArray(item.timeline)) return { items: [], error: 'timeline 缺失' };
  const members = new Set(group.entryIds);
  const seen = new Set<string>();
  const items: Array<{ entryId: string; contribution: string }> = [];
  for (const raw of item.timeline) {
    if (!isObject(raw)) return { items: [], error: 'timeline 含非对象项' };
    const entryId = readText(raw, 'entryId');
    if (!members.has(entryId)) {
      return { items: [], error: `timeline.entryId 越界：${entryId || '(空)'}` };
    }
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    items.push({ entryId, contribution: readText(raw, 'contribution') });
  }
  if (items.length === 0) return { items: [], error: 'timeline 为空' };
  return { items };
}

/* ------------------------------------------------------------------ *
 * 时间轴合并
 * ------------------------------------------------------------------ */

/**
 * 合并旧时间轴与新归入的成员：按 `entryId` 去重，新贡献覆盖旧贡献。
 * 结果按「日期升序、同日 id 升序」稳定排序，与 Markdown 渲染顺序一致。
 */
function mergeTimeline(
  previous: readonly TopicTimelineItem[],
  additions: ReadonlyArray<{ entryId: string; contribution: string }>,
  members: Map<string, WikiEntryRecord>,
): TopicTimelineItem[] {
  const merged = new Map<string, TopicTimelineItem>();
  for (const item of previous) {
    if (typeof item.entryId !== 'string' || item.entryId.length === 0) continue;
    merged.set(item.entryId, { ...item });
  }

  for (const addition of additions) {
    const member = members.get(addition.entryId);
    if (member === undefined) continue;
    const existing = merged.get(addition.entryId);
    const contribution = addition.contribution.length > 0 ? addition.contribution : existing?.contribution;
    merged.set(addition.entryId, {
      entryId: addition.entryId,
      date: member.date,
      title: member.title,
      summary: member.summary,
      ...(contribution !== undefined && contribution.length > 0 ? { contribution } : {}),
    });
  }

  return [...merged.values()].sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? -1 : 1;
    if (left.entryId === right.entryId) return 0;
    return left.entryId < right.entryId ? -1 : 1;
  });
}

/* ------------------------------------------------------------------ *
 * 字段读取（外部 JSON 一律 unknown 进入）
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(source: unknown, key: string): string {
  if (!isObject(source)) return '';
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readStringList(source: unknown, key: string): string[] {
  if (!isObject(source)) return [];
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 成员元数据聚合：消息数 / 时长累加，人数去重，峰值取最大。 */
function aggregateMetadata(records: readonly WikiEntryRecord[]): WikiEntry['metadata'] {
  const participants = new Set<string>();
  let messageCount = 0;
  let durationMinutes = 0;
  let peakRate = 0;
  for (const record of records) {
    messageCount += Number.isFinite(record.metadata.messageCount) ? record.metadata.messageCount : 0;
    durationMinutes += Number.isFinite(record.metadata.durationMinutes) ? record.metadata.durationMinutes : 0;
    peakRate = Math.max(peakRate, Number.isFinite(record.metadata.peakRate) ? record.metadata.peakRate : 0);
    for (const participant of record.participants) participants.add(participant);
  }
  return { messageCount, participantCount: participants.size, durationMinutes, peakRate };
}

/* ------------------------------------------------------------------ *
 * 标识与文本工具
 * ------------------------------------------------------------------ */

/** 新主题 id：`<YYYY-MM-DD>-topic-<成员 id 排序拼接的 sha1 前 8 位>`（稳定、可复算）。 */
function topicIdOf(dayKey: string, memberIds: readonly string[]): string {
  return `${dayKey}-topic-${shortHash([...memberIds].sort().join('|'))}`;
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

function dayLabelOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}
