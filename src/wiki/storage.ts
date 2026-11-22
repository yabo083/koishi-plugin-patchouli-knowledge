/**
 * Patchouli Knowledge - 本地轻量持久化仓储
 *
 * 职责边界：
 *  - 持久化沉淀词条的**元数据清单**（正文归 `WikiEngine` 的 Markdown 文件所有）；
 *  - 持久化每个群的自适应节奏快照（基线速率 + 触发器参数），供重启回灌；
 *  - 提供按 channelId / date / tag / 关键词的检索。
 *
 * 存储形态：单个 JSON 文档（默认 `<wikiDir>/.patchouli/store.json`），
 * 写入走「临时文件 + 原子 rename」，并对变更串行化，避免并发结算互相覆盖。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

import type {
  CadenceMetrics,
  CadencePhase,
  CadenceStateSnapshot,
  TopicTimelineItem,
  TriggerOptions,
  WikiEntry,
  WikiStorageConfig,
} from '../types';

/** 词条沉淀状态（与 `WikiEntry.status` 同源，供补丁参数复用）。 */
export type EntryStatus = WikiEntry['status'];

/** 词条元数据记录（不含正文，检索与列表展示用）。 */
export interface WikiEntryRecord {
  id: string;
  title: string;
  channelId: string;
  /** YYYY-MM-DD。 */
  date: string;
  status: EntryStatus;
  tags: string[];
  summary: string;
  /** 参与本场讨论的发言人（去重，按首次有效发言顺序）。 */
  participants: string[];
  metadata: WikiEntry['metadata'];
  /** 词条种类；缺省等价于 `debate`（旧库无此字段）。 */
  kind?: WikiEntry['kind'];
  /** 真理源相对路径（多源词条：主题聚合）。 */
  sources?: string[];
  /** 主题时间轴（仅 `kind: 'topic'`；旧库无此键即视为空时间轴）。 */
  timeline?: TopicTimelineItem[];
  /** 词条 Markdown 的相对 / 绝对路径（若由 `WikiEngine` 落盘后回填）。 */
  path?: string;
  createdAt: number;
  updatedAt: number;
}

/** `updateEntry` 的局部更新补丁；未给出的字段保持原值。 */
export interface WikiEntryPatch {
  title?: string;
  summary?: string;
  status?: EntryStatus;
  tags?: string[];
  participants?: string[];
}

/** 词条检索条件；未给出的条件不参与过滤。 */
export interface WikiEntryQuery {
  channelId?: string;
  /** 精确匹配 YYYY-MM-DD。 */
  date?: string;
  /** 起始日期（含），YYYY-MM-DD。 */
  from?: string;
  /** 结束日期（含），YYYY-MM-DD。 */
  to?: string;
  tag?: string;
  status?: WikiEntry['status'];
  /** 关键词，空格分隔多词时要求全部命中（AND）。 */
  keyword?: string;
  /**
   * 关键词匹配范围：`meta` 仅 id / 标题 / 摘要 / 标签；
   * `full`（默认）再穿透 Markdown 正文，覆盖观点碰撞矩阵与原始引用等段落。
   */
  view?: 'meta' | 'full';
  /** 结果上限；省略则返回全部命中项。 */
  limit?: number;
}

export interface LocalStoreOptions {
  /** 是否缩进输出 JSON（默认 false，省空间）。 */
  pretty?: boolean;
  /** `getRecentEntries` 未指定 limit 时的默认条数，默认 20。 */
  defaultRecentLimit?: number;
  /** 可注入时钟，便于测试。 */
  now?: () => number;
}

interface StoreDocument {
  version: number;
  entries: Record<string, WikiEntryRecord>;
  cadence: Record<string, CadenceStateSnapshot>;
}

const STORE_VERSION = 1;
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_DATABASE_DIR = '.patchouli';
const DEFAULT_DATABASE_FILE = 'store.json';
/**
 * 孤儿临时文件的年龄阈值（毫秒）。
 *
 * 写盘本身是毫秒级的，1 小时前的 `.tmp` 必然是崩溃残留；用墙钟判断，因为 mtime 是
 * 文件系统时间，与可注入的逻辑时钟无关。
 */
const ORPHAN_TEMP_MS = 60 * 60 * 1000;

/**
 * 参与持久化的**数值**触发参数（`triggerMode` 是字符串枚举，由 `isTriggerMode` 单独校验）。
 *
 * 这里的白名单是磁盘往返的唯一阀门：`saveCadenceState` 写出整份 `options`，
 * 但重建 `LocalStore` 后只有本表列出的键会被读回，漏一个键就等于「重启即失效」。
 * 因此它必须与 `TriggerOptions` 的数值字段保持一一对应。
 */
const TRIGGER_OPTION_KEYS = [
  'windowSizeSeconds',
  'burstMultiplier',
  'minBurstRate',
  'quiescenceSeconds',
  'coolingRatioThreshold',
  'minDiscussionMessages',
  'maxBufferMessages',
  'baselineEwmaAlpha',
  'thetaMin',
  'rhoMin',
  'densityMultiplier',
  'peakCoolFraction',
  'dispatchMargin',
] as const;

/**
 * 本地 JSON 仓储。
 *
 * 首次访问时懒加载整份文档到内存；此后读操作走内存、写操作原子落盘。
 * 文档损坏时隔离为 `*.corrupt-<ts>` 并以空库启动，绝不阻断插件加载。
 */
export class LocalStore {
  private readonly filePath: string;
  private readonly pretty: boolean;
  private readonly defaultRecentLimit: number;
  private readonly now: () => number;
  private snapshot: StoreDocument | undefined;
  private queue: Promise<void> = Promise.resolve();
  /**
   * 库文件解析失败且已隔离时为 `true`：此时**拒绝写入**。
   * 以空库继续跑会让下一次 commit 把空表写回原路径，整库元数据只剩隔离副本。
   */
  private corrupted = false;

  constructor(config: WikiStorageConfig, options: LocalStoreOptions = {}) {
    if (!config || typeof config.wikiDir !== 'string' || config.wikiDir.trim() === '') {
      throw new TypeError('LocalStore: config.wikiDir 必填且不能为空字符串');
    }
    const explicitPath = config.databasePath;
    this.filePath =
      typeof explicitPath === 'string' && explicitPath.trim() !== ''
        ? nodePath.resolve(explicitPath)
        : nodePath.join(nodePath.resolve(config.wikiDir), DEFAULT_DATABASE_DIR, DEFAULT_DATABASE_FILE);
    this.pretty = options.pretty === true;
    this.defaultRecentLimit = Math.max(1, options.defaultRecentLimit ?? DEFAULT_RECENT_LIMIT);
    this.now = options.now ?? Date.now;
  }

  /** 持久化文件绝对路径。 */
  get path(): string {
    return this.filePath;
  }

  /** 保存（或覆盖）一个词条的元数据。 */
  async saveEntry(entry: WikiEntry, entryPath?: string): Promise<WikiEntryRecord> {
    assertSavableEntry(entry);
    return this.serialize(async () => {
      const store = await this.load();
      const now = this.now();
      const previous = store.entries[entry.id];
      const record: WikiEntryRecord = {
        id: entry.id,
        title: entry.title,
        channelId: entry.channelId,
        date: entry.date,
        status: entry.status,
        tags: [...entry.tags],
        summary: entry.summary,
        participants: [...(entry.participants ?? [])],
        metadata: { ...entry.metadata },
        createdAt: previous ? previous.createdAt : now,
        updatedAt: now,
      };
      if (entryPath !== undefined) record.path = entryPath;
      else if (previous?.path !== undefined) record.path = previous.path;
      const kind = entry.kind ?? previous?.kind;
      if (kind !== undefined) record.kind = kind;
      if (entry.sources !== undefined) record.sources = [...entry.sources];
      else if (previous?.sources !== undefined) record.sources = [...previous.sources];
      // 时间轴随词条覆写：给出 `timeline` 时整份替换（主题聚合总是给出合并后的完整时间轴），
      // 未给出时沿用旧值，旧库无此键则不写。
      if (entry.timeline !== undefined) record.timeline = entry.timeline.map(copyTimelineItem);
      else if (previous?.timeline !== undefined) record.timeline = previous.timeline.map(copyTimelineItem);
      await this.commit({
        version: store.version,
        entries: { ...store.entries, [entry.id]: record },
        cadence: store.cadence,
      });
      return copyRecord(record);
    });
  }

  /**
   * 删除一个词条的元数据，原子写回；键不存在返回 `false`（不产生写盘）。
   * 节奏快照（`cadence`）与其他词条原样保留。
   */
  async deleteEntry(id: string): Promise<boolean> {
    assertEntryId('deleteEntry', id);
    return this.serialize(async () => {
      const store = await this.load();
      if (!Object.prototype.hasOwnProperty.call(store.entries, id)) return false;

      const entries = { ...store.entries };
      delete entries[id];
      await this.commit({ version: store.version, entries, cadence: store.cadence });
      return true;
    });
  }

  /**
   * 局部更新词条元数据：只覆盖给出的字段，刷新 `updatedAt` 后原子写回。
   * 词条不存在时抛错（返回值契约保证记录存在）；字段类型非法时抛 `TypeError`。
   */
  async updateEntry(id: string, patch: WikiEntryPatch): Promise<WikiEntryRecord> {
    assertEntryId('updateEntry', id);
    assertEntryPatch(patch);

    return this.serialize(async () => {
      const store = await this.load();
      const previous = store.entries[id];
      if (previous === undefined) {
        throw new Error(`LocalStore.updateEntry: 词条 ${id} 不存在`);
      }

      const record: WikiEntryRecord = { ...copyRecord(previous), updatedAt: this.now() };
      if (patch.title !== undefined) record.title = patch.title;
      if (patch.summary !== undefined) record.summary = patch.summary;
      if (patch.status !== undefined) record.status = patch.status;
      if (patch.tags !== undefined) record.tags = [...patch.tags];
      if (patch.participants !== undefined) record.participants = [...patch.participants];

      await this.commit({
        version: store.version,
        entries: { ...store.entries, [id]: record },
        cadence: store.cadence,
      });
      return copyRecord(record);
    });
  }

  /**
   * 清空全部词条元数据并原子写回。
   * **节奏快照（`cadence`）原样保留**——调优参数属于运行时学习结果，不随知识库清空丢失。
   */
  async clearEntries(): Promise<void> {
    return this.serialize(async () => {
      const store = await this.load();
      await this.commit({ version: store.version, entries: {}, cadence: store.cadence });
    });
  }

  /** 按 `id` 取词条元数据；不存在返回 undefined。 */
  async getEntry(id: string): Promise<WikiEntryRecord | undefined> {
    const store = await this.load();
    const record = store.entries[id];
    return record === undefined ? undefined : copyRecord(record);
  }

  /**
   * 关键词检索：空格分隔的多个词需全部命中（AND），大小写不敏感。
   * 默认 `view: 'full'` —— 先匹配 id / 标题 / 摘要 / 标签，未命中的词条再穿透其
   * Markdown 正文（背景、观点碰撞矩阵、共识、分歧、原始引用）二次匹配；
   * `view: 'meta'` 可退回纯元数据检索。空关键词等价于“该范围内全部词条”。
   *
   * 排序：命中位置权重（标题 3 > id/摘要/标签 2 > 正文 1）逐词累加后倒序，
   * 同分按 `createdAt` 倒序、再按 `id` 升序稳定收敛；空关键词沿用日期倒序。
   */
  async searchEntries(
    keyword: string,
    channelId?: string,
    options: { view?: 'meta' | 'full'; limit?: number } = {},
  ): Promise<WikiEntryRecord[]> {
    const tokens = keyword.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    const view = options.view ?? 'full';
    if (tokens.length === 0) {
      return this.queryEntries({ channelId, view, limit: options.limit });
    }

    const matched = await this.queryEntries({ channelId, keyword: tokens.join(' '), view });
    if (matched.length <= 1) {
      const only = matched.map(copyRecord);
      return options.limit === undefined ? only : only.slice(0, Math.max(0, options.limit));
    }

    const ranked: Array<{ record: WikiEntryRecord; score: number }> = [];
    for (const record of matched) {
      ranked.push({ record, score: await this.rankRecord(record, tokens, view) });
    }
    ranked.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      if (left.record.createdAt !== right.record.createdAt) return right.record.createdAt - left.record.createdAt;
      if (left.record.id === right.record.id) return 0;
      return left.record.id < right.record.id ? -1 : 1;
    });

    const limited = options.limit === undefined ? ranked : ranked.slice(0, Math.max(0, options.limit));
    return limited.map((item) => copyRecord(item.record));
  }

  /**
   * 检索排序权重：标题命中（3）> id/摘要/标签命中（2）> 仅正文命中（1），逐词累加。
   * 元数据全命中时不再读正文文件；`view: 'meta'` 下正文权重恒为 0。
   */
  private async rankRecord(
    record: WikiEntryRecord,
    tokens: readonly string[],
    view: 'meta' | 'full',
  ): Promise<number> {
    const title = record.title.toLowerCase();
    const meta = [record.id, record.summary, ...record.tags].join(' ').toLowerCase();
    let score = 0;
    let needsBody = false;
    for (const token of tokens) {
      if (title.includes(token)) score += 3;
      else if (meta.includes(token)) score += 2;
      else needsBody = true;
    }
    if (!needsBody || view !== 'full') return score;

    const body = await this.readBodyHaystack(record.path);
    if (body.length === 0) return score;
    for (const token of tokens) {
      if (title.includes(token) || meta.includes(token)) continue;
      if (body.includes(token)) score += 1;
    }
    return score;
  }

  /**
   * 按 `createdAt` 落在 `[fromMs, toMs)` 区间内取词条，升序返回（同一时刻按 `id` 升序）。
   * 纯内存读：不触碰磁盘，供「主题校准」挑选窗口内尚未归入主题的词条使用。
   */
  async listEntriesBetween(fromMs: number, toMs: number, channelId?: string): Promise<WikiEntryRecord[]> {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new TypeError('LocalStore.listEntriesBetween: fromMs / toMs 必须是毫秒时间戳');
    }
    const store = await this.load();
    const matched = Object.values(store.entries).filter(
      (record) =>
        (channelId === undefined || record.channelId === channelId) &&
        record.createdAt >= fromMs &&
        record.createdAt < toMs,
    );
    matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
    return matched.map(copyRecord);
  }

  /**
   * 按状态取词条（可选限定群），日期倒序（同日按 `updatedAt` 倒序）。
   * 供主题聚合挑选 30 天内仍待定 / 未决的候选（按时间轴成员判定）。
   */
  async listEntriesByStatus(status: EntryStatus, channelId?: string): Promise<WikiEntryRecord[]> {
    if (!isEntryStatus(status)) {
      throw new TypeError('LocalStore.listEntriesByStatus: status 必须是 verified / tentative / open / superseded');
    }
    const store = await this.load();
    const matched = Object.values(store.entries).filter(
      (record) => record.status === status && (channelId === undefined || record.channelId === channelId),
    );
    return matched.sort(compareRecords).map(copyRecord);
  }

  /** 已沉淀词条涉及的群聊（升序去重），供前端群聊筛选下拉使用。 */
  async listChannels(): Promise<string[]> {
    const store = await this.load();
    const channels = Object.values(store.entries)
      .map((record) => record.channelId)
      .filter((channelId): channelId is string => typeof channelId === 'string' && channelId.length > 0);
    return [...new Set(channels)].sort();
  }

  /** 最近沉淀：按日期倒序，同日按更新时间倒序。 */
  async getRecentEntries(channelId?: string, limit?: number): Promise<WikiEntryRecord[]> {
    const store = await this.load();
    const all = Object.values(store.entries).filter(
      (record) => channelId === undefined || record.channelId === channelId,
    );
    const capped = limit === undefined ? this.defaultRecentLimit : Math.max(0, limit);
    return all.sort(compareRecords).slice(0, capped).map(copyRecord);
  }

  /** 组合条件检索（channelId / date / from / to / tag / status / keyword）。 */
  async queryEntries(query: WikiEntryQuery = {}): Promise<WikiEntryRecord[]> {
    const store = await this.load();
    const tokens = (query.keyword ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0);

    const matched: WikiEntryRecord[] = [];
    const metaMisses: WikiEntryRecord[] = [];

    for (const record of Object.values(store.entries)) {
      if (query.channelId !== undefined && record.channelId !== query.channelId) continue;
      if (query.date !== undefined && record.date !== query.date) continue;
      if (query.from !== undefined && record.date < query.from) continue;
      if (query.to !== undefined && record.date > query.to) continue;
      if (query.status !== undefined && record.status !== query.status) continue;
      if (query.tag !== undefined) {
        const wanted = query.tag.toLowerCase();
        if (!record.tags.some((tag) => tag.toLowerCase() === wanted)) continue;
      }
      if (tokens.length === 0) {
        matched.push(record);
        continue;
      }
      const haystack = [record.id, record.title, record.summary, ...record.tags]
        .join(' ')
        .toLowerCase();
      if (tokens.every((token) => haystack.includes(token))) matched.push(record);
      else metaMisses.push(record);
    }

    // 广义检索：元数据未命中的词条，再穿透其 Markdown 正文（观点碰撞矩阵 / 共识 / 原始引用等）
    if (tokens.length > 0 && (query.view ?? 'full') === 'full') {
      for (const record of metaMisses) {
        const body = await this.readBodyHaystack(record.path);
        if (body.length > 0 && tokens.every((token) => body.includes(token))) matched.push(record);
      }
    }

    matched.sort(compareRecords);
    const limited = query.limit === undefined ? matched : matched.slice(0, Math.max(0, query.limit));
    return limited.map(copyRecord);
  }

  /** 读取词条 Markdown 正文并归一化为小写检索串；文件缺失或不可读时返回空串。 */
  private async readBodyHaystack(path?: string): Promise<string> {
    if (typeof path !== 'string' || path.length === 0) return '';
    try {
      return (await fs.readFile(path, 'utf8')).toLowerCase();
    } catch {
      return '';
    }
  }

  /** 保存某群的自适应节奏快照（覆盖式）。 */
  async saveCadenceState(state: CadenceStateSnapshot): Promise<CadenceStateSnapshot> {
    assertCadenceState(state);
    return this.serialize(async () => {
      const store = await this.load();
      const next: CadenceStateSnapshot = {
        channelId: state.channelId,
        options: { ...state.options },
        metrics: { ...state.metrics },
        updatedAt: state.updatedAt,
      };
      await this.commit({
        version: store.version,
        entries: store.entries,
        cadence: { ...store.cadence, [state.channelId]: next },
      });
      return { ...next, options: { ...next.options }, metrics: { ...next.metrics } };
    });
  }

  /** 取某群的节奏快照；不存在返回 undefined。 */
  async loadCadenceState(channelId: string): Promise<CadenceStateSnapshot | undefined> {
    const store = await this.load();
    const state = store.cadence[channelId];
    return state === undefined ? undefined : copyCadenceState(state);
  }

  /** 列出全部群的节奏快照（最近更新优先），供启动时批量回灌。 */
  async listCadenceStates(): Promise<CadenceStateSnapshot[]> {
    const store = await this.load();
    return Object.values(store.cadence)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(copyCadenceState);
  }

  /* ---------------------------------------------------------------- *
   * 文档生命周期
   * ---------------------------------------------------------------- */

  private async load(): Promise<StoreDocument> {
    if (this.snapshot !== undefined) return this.snapshot;
    await this.sweepTempFiles();
    // 首次加载与 `serialize` 队列里的首次 commit 会并发：读路径不排队，所以每个
    // `await` 之后都要重查 `snapshot`。否则「读到旧文件 → commit 写入新快照 → 这里
    // 再用旧内容覆盖」会让刚写进去的那一条永久丢失（下一次 load 直接从内存返回旧值）。
    if (this.snapshot !== undefined) return this.snapshot;

    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        // 读文件期间首次 commit 可能已经落盘并装了新快照：ENOENT 只说明「当时还没有」。
        this.snapshot ??= emptyDocument();
        return this.snapshot;
      }
      throw error;
    }
    if (this.snapshot !== undefined) return this.snapshot;

    let parsed: StoreDocument | undefined;
    try {
      const raw: unknown = JSON.parse(text);
      parsed = parseDocument(raw);
    } catch {
      // 解析失败只在没有并发落盘时隔离：并发的 commit 已经用合法内容覆盖了同一路径。
      if (this.snapshot === undefined) {
        this.corrupted = true;
        await this.quarantineCorruptFile();
      }
    }
    this.snapshot ??= parsed ?? emptyDocument();
    return this.snapshot;
  }

  /**
   * 清理崩溃残留的写盘临时文件。
   *
   * `commit()` 在 `writeFile` 与 `rename` 之间被杀掉时，同目录会留下
   * `<store>.json.<pid>.<ts>.tmp`。用**年龄**而不是 pid 判断：本进程正在写的临时文件
   * 年龄必然是毫秒级，1 小时前的不可能是活跃写入（mtime 是墙钟，故不能用注入时钟）。
   */
  private async sweepTempFiles(): Promise<void> {
    const directory = nodePath.dirname(this.filePath);
    const prefix = `${nodePath.basename(this.filePath)}.`;
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const path = nodePath.join(directory, name);
      try {
        if (now - (await fs.stat(path)).mtimeMs < ORPHAN_TEMP_MS) continue;
        await fs.rm(path, { force: true });
      } catch {
        // 并发删除 / 权限问题：清理是尽力而为，失败不影响加载。
      }
    }
  }

  private async commit(next: StoreDocument): Promise<void> {
    if (this.corrupted) {
      throw new Error('store.json 解析失败且已隔离；已拒绝以空库覆盖。检查 .corrupt-* 备份后重启即可恢复写入');
    }
    const directory = nodePath.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const payload = `${JSON.stringify(next, null, this.pretty ? 2 : 0)}\n`;
    const tempPath = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, payload, 'utf8');
      await renameWithRetry(tempPath, this.filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(noop);
      throw error;
    }
    this.snapshot = next;
  }

  private async quarantineCorruptFile(): Promise<void> {
    const backupPath = `${this.filePath}.corrupt-${this.now()}`;
    try {
      await fs.rename(this.filePath, backupPath);
      console.warn(
        `[patchouli-knowledge] 本地存储已损坏，已隔离到 ${backupPath}；重启前拒绝写入（避免空库覆盖）`,
      );
    } catch (error) {
      console.warn('[patchouli-knowledge] 本地存储已损坏且无法隔离；重启前拒绝写入', error);
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(noop, noop);
    return run;
  }
}

/* ------------------------------------------------------------------ *
 * 反序列化：外部 JSON 一律以 unknown 进入并逐字段守卫
 * ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyDocument(): StoreDocument {
  return { version: STORE_VERSION, entries: {}, cadence: {} };
}

function parseDocument(raw: unknown): StoreDocument {
  if (!isObject(raw)) throw new TypeError('本地存储根节点必须是 JSON 对象');

  const entryPairs: Array<[string, WikiEntryRecord]> = [];
  if (isObject(raw.entries)) {
    for (const [key, value] of Object.entries(raw.entries)) {
      const record = parseEntryRecord(value);
      if (record !== undefined) entryPairs.push([key, record]);
    }
  }

  const cadencePairs: Array<[string, CadenceStateSnapshot]> = [];
  if (isObject(raw.cadence)) {
    for (const [key, value] of Object.entries(raw.cadence)) {
      const state = parseCadenceState(value);
      if (state !== undefined) cadencePairs.push([key, state]);
    }
  }

  return {
    version: readNumber(raw, 'version') ?? STORE_VERSION,
    entries: Object.fromEntries(entryPairs),
    cadence: Object.fromEntries(cadencePairs),
  };
}

function parseEntryRecord(value: unknown): WikiEntryRecord | undefined {
  if (!isObject(value)) return undefined;

  const id = readString(value, 'id');
  const title = readString(value, 'title');
  if (id === undefined || id === '' || title === undefined || title === '') return undefined;

  const statusValue = readString(value, 'status');
  const status: WikiEntry['status'] = isEntryStatus(statusValue) ? statusValue : 'tentative';

  const createdAt = readNumber(value, 'createdAt') ?? 0;
  const record: WikiEntryRecord = {
    id,
    title,
    channelId: readString(value, 'channelId') ?? '',
    date: readString(value, 'date') ?? '',
    status,
    tags: readStringArray(value, 'tags'),
    summary: readString(value, 'summary') ?? '',
    participants: readStringArray(value, 'participants'),
    metadata: {
      messageCount: readNumber(value.metadata, 'messageCount') ?? 0,
      participantCount: readNumber(value.metadata, 'participantCount') ?? 0,
      durationMinutes: readNumber(value.metadata, 'durationMinutes') ?? 0,
      peakRate: readNumber(value.metadata, 'peakRate') ?? 0,
    },
    createdAt,
    updatedAt: readNumber(value, 'updatedAt') ?? createdAt,
  };
  const path = readString(value, 'path');
  if (path !== undefined) record.path = path;
  const kindValue = readString(value, 'kind');
  if (kindValue === 'debate' || kindValue === 'topic') record.kind = kindValue;
  if (Array.isArray(value.sources)) record.sources = readStringArray(value, 'sources');
  const timeline = parseTimeline(value.timeline);
  if (timeline !== undefined) record.timeline = timeline;
  return record;
}

/**
 * 解析持久化时间轴：逐项校验，任何一项不合法即整份作废（时间轴是结构，不做部分保留）。
 * 旧库无该键时返回 `undefined`（记录保持无时间轴）。
 */
function parseTimeline(value: unknown): TopicTimelineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: TopicTimelineItem[] = [];
  for (const item of value) {
    if (!isObject(item)) return undefined;
    const entryId = readString(item, 'entryId');
    const date = readString(item, 'date');
    const title = readString(item, 'title');
    const summary = readString(item, 'summary');
    if (entryId === undefined || entryId === '') return undefined;
    if (date === undefined || title === undefined || summary === undefined) return undefined;
    const contribution = readString(item, 'contribution');
    items.push({
      entryId,
      date,
      title,
      summary,
      ...(contribution !== undefined && contribution !== '' ? { contribution } : {}),
    });
  }
  return items;
}

function parseCadenceState(value: unknown): CadenceStateSnapshot | undefined {
  if (!isObject(value)) return undefined;

  const channelId = readString(value, 'channelId');
  if (channelId === undefined || channelId === '') return undefined;

  const metrics = parseMetrics(value.metrics);
  if (metrics === undefined) return undefined;

  return {
    channelId,
    options: readTriggerOptions(value.options),
    metrics,
    updatedAt: readNumber(value, 'updatedAt') ?? 0,
  };
}

function parseMetrics(value: unknown): CadenceMetrics | undefined {
  if (!isObject(value)) return undefined;

  const phaseValue = readString(value, 'phase');
  if (!isCadencePhase(phaseValue)) return undefined;

  const numericFields = ['currentRate', 'baselineRate', 'baselineDeviation', 'burstRatio', 'lastMessageTime', 'bufferedCount'] as const;
  const numbers: number[] = [];
  for (const field of numericFields) {
    const numeric = readNumber(value, field);
    if (numeric === undefined) return undefined;
    numbers.push(numeric);
  }

  return {
    currentRate: numbers[0],
    baselineRate: numbers[1],
    baselineDeviation: numbers[2],
    burstRatio: numbers[3],
    lastMessageTime: numbers[4],
    phase: phaseValue,
    bufferedCount: numbers[5],
  };
}

function readTriggerOptions(value: unknown): Partial<TriggerOptions> {
  const options: Partial<TriggerOptions> = {};
  if (!isObject(value)) return options;
  for (const key of TRIGGER_OPTION_KEYS) {
    const numeric = readNumber(value, key);
    if (numeric !== undefined) options[key] = numeric;
  }
  // `triggerMode` 是字符串枚举，不在数值白名单里：非法值（含未知字符串 / 非字符串）
  // 一律丢弃而非抛错——落盘文档可能来自更旧或更未来的版本，读库不能因此整体失败。
  const mode = readString(value, 'triggerMode');
  if (isTriggerMode(mode)) options.triggerMode = mode;
  // `potentialAutoTuning` 是布尔，不进数值白名单；与 triggerMode 同走「非法值丢弃不抛错」。
  const autoTuning = readBoolean(value, 'potentialAutoTuning');
  if (autoTuning !== undefined) options.potentialAutoTuning = autoTuning;
  return options;
}

function isTriggerMode(value: string | undefined): value is TriggerOptions['triggerMode'] {
  return value === 'rate' || value === 'potential' || value === 'shadow';
}

function isEntryStatus(value: string | undefined): value is EntryStatus {
  return (
    value === 'verified' || value === 'tentative' || value === 'open' || value === 'superseded'
  );
}

function isCadencePhase(value: string | undefined): value is CadencePhase {
  return value === 'IDLE' || value === 'BURSTING' || value === 'COOLING' || value === 'SUMMARIZING';
}

function readString(source: unknown, key: string): string | undefined {
  if (!isObject(source)) return undefined;
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(source: unknown, key: string): boolean | undefined {
  if (!isObject(source)) return undefined;
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (!isObject(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(source: JsonObject, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/* ------------------------------------------------------------------ *
 * 领域校验与拷贝
 * ------------------------------------------------------------------ */

function assertSavableEntry(entry: WikiEntry): void {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('LocalStore.saveEntry: entry 必须是对象');
  }
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    throw new TypeError('LocalStore.saveEntry: entry.id 必填');
  }
  if (typeof entry.title !== 'string' || entry.title.trim() === '') {
    throw new TypeError('LocalStore.saveEntry: entry.title 必填');
  }
  if (typeof entry.channelId !== 'string' || entry.channelId.trim() === '') {
    throw new TypeError('LocalStore.saveEntry: entry.channelId 必填');
  }
  if (typeof entry.date !== 'string' || entry.date.trim() === '') {
    throw new TypeError('LocalStore.saveEntry: entry.date 必填 (YYYY-MM-DD)');
  }
  if (!isEntryStatus(entry.status)) {
    throw new TypeError(
      'LocalStore.saveEntry: entry.status 必须是 verified / tentative / open / superseded',
    );
  }
  if (!Array.isArray(entry.tags)) {
    throw new TypeError('LocalStore.saveEntry: entry.tags 必须是字符串数组');
  }
  if (entry.timeline !== undefined && !isValidTimeline(entry.timeline)) {
    throw new TypeError('LocalStore.saveEntry: entry.timeline 必须是合法的 TopicTimelineItem 数组');
  }
}

/** 时间轴结构校验：`entryId/date/title/summary` 为非空字符串，`contribution` 可选字符串。 */
function isValidTimeline(value: unknown): value is TopicTimelineItem[] {
  if (!Array.isArray(value)) return false;
  return value.every((item: unknown) => {
    if (!isObject(item)) return false;
    const required = ['entryId', 'date', 'title', 'summary'] as const;
    for (const key of required) {
      const field = item[key];
      if (typeof field !== 'string' || field.trim() === '') return false;
    }
    const contribution = item.contribution;
    return contribution === undefined || typeof contribution === 'string';
  });
}

/** 时间轴节点浅拷贝（对象内全是原始类型，复制一层即可断开引用）。 */
function copyTimelineItem(item: TopicTimelineItem): TopicTimelineItem {
  return { ...item };
}

function assertEntryId(method: string, id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError(`LocalStore.${method}: id 必填`);
  }
}

function assertEntryPatch(patch: WikiEntryPatch): void {
  if (!patch || typeof patch !== 'object') {
    throw new TypeError('LocalStore.updateEntry: patch 必须是对象');
  }
  if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim() === '')) {
    throw new TypeError('LocalStore.updateEntry: patch.title 必须是非空字符串');
  }
  if (patch.summary !== undefined && typeof patch.summary !== 'string') {
    throw new TypeError('LocalStore.updateEntry: patch.summary 必须是字符串');
  }
  if (patch.status !== undefined && !isEntryStatus(patch.status)) {
    throw new TypeError(
      'LocalStore.updateEntry: patch.status 必须是 verified / tentative / open / superseded',
    );
  }
  if (patch.tags !== undefined && !isStringArray(patch.tags)) {
    throw new TypeError('LocalStore.updateEntry: patch.tags 必须是字符串数组');
  }
  if (patch.participants !== undefined && !isStringArray(patch.participants)) {
    throw new TypeError('LocalStore.updateEntry: patch.participants 必须是字符串数组');
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function assertCadenceState(state: CadenceStateSnapshot): void {
  if (!state || typeof state !== 'object') {
    throw new TypeError('LocalStore.saveCadenceState: state 必须是对象');
  }
  if (typeof state.channelId !== 'string' || state.channelId.trim() === '') {
    throw new TypeError('LocalStore.saveCadenceState: state.channelId 必填');
  }
  if (parseMetrics(state.metrics) === undefined) {
    throw new TypeError('LocalStore.saveCadenceState: state.metrics 字段不完整');
  }
  if (typeof state.updatedAt !== 'number' || !Number.isFinite(state.updatedAt)) {
    throw new TypeError('LocalStore.saveCadenceState: state.updatedAt 必须是毫秒时间戳');
  }
}

function copyRecord(record: WikiEntryRecord): WikiEntryRecord {
  const copy: WikiEntryRecord = {
    ...record,
    tags: [...record.tags],
    participants: [...record.participants],
    metadata: { ...record.metadata },
  };
  if (record.sources !== undefined) copy.sources = [...record.sources];
  if (record.timeline !== undefined) copy.timeline = record.timeline.map(copyTimelineItem);
  return copy;
}

function copyCadenceState(state: CadenceStateSnapshot): CadenceStateSnapshot {
  return {
    channelId: state.channelId,
    options: { ...state.options },
    metrics: { ...state.metrics },
    updatedAt: state.updatedAt,
  };
}

/** 按日期倒序、更新时刻倒序、id 升序稳定排序。 */
function compareRecords(left: WikiEntryRecord, right: WikiEntryRecord): number {
  if (left.date !== right.date) return left.date < right.date ? 1 : -1;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === code;
}

/**
 * Windows 上目标文件可能被索引器 / 杀软短暂占用，`rename` 会返回 EPERM / EBUSY。
 * 这是瞬时锁而非数据错误：20/40/60/80ms 有界重试，仍失败才向上抛。
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const transient = isErrnoCode(error, 'EPERM') || isErrnoCode(error, 'EBUSY') || isErrnoCode(error, 'EACCES');
      if (!transient || attempt >= attempts) throw error;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, attempt * 20);
      await promise;
    }
  }
}

function noop(): void {
  /* intentionally empty */
}
