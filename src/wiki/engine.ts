/**
 * Patchouli Knowledge - llmwiki 沉淀引擎
 *
 * 职责边界：
 *  - 把本轮 `DiscussionSession` 的原始消息 dump 成 `raw/sessions/<id>.json`（真理源，只增不改）；
 *  - 把内存中的 `WikiEntry` 渲染成符合本地 llmwiki 规范的 Markdown 词条 `wiki/debates/<id>.md`；
 *  - 增量维护 `index.md`（单行索引，原地更新 / 按日期插入，严禁重复追加）；
 *  - 增量维护 `log.md`（沉淀流水）。
 *
 * 本模块只负责“知识产物”的格式化与文件落盘，不关心触发器、模型调度与检索仓储。
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as nodePath from 'node:path';

import type { ChatMessage, DiscussionSession, TopicTimelineItem, WikiDebatePoint, WikiEntry } from '../types';
import {
  INDEX_FILE_NAME,
  LOG_FILE_NAME,
  RAW_SESSIONS_SUBDIR,
  WIKI_DEBATES_SUBDIR,
} from './layout';
import { plainText } from './plain-text';

/** 词条默认子目录（与 ADR-003 对齐：`wiki/debates/<id>.md`）。 */
const DEFAULT_ENTRY_SUBDIR = WIKI_DEBATES_SUBDIR;
/** 原始会话 dump 默认子目录：`raw/sessions/<id>.json`。 */
const DEFAULT_RAW_SUBDIR = RAW_SESSIONS_SUBDIR;
const DEFAULT_INDEX_FILE = INDEX_FILE_NAME;
const DEFAULT_LOG_FILE = LOG_FILE_NAME;
/** 词条头部 `Source:` 行使用的原始数据相对路径前缀。 */
const RAW_SOURCE_PREFIX = `${RAW_SESSIONS_SUBDIR}/`;

const INDEX_HEADER = '# Patchouli Knowledge Index';
const INDEX_SECTION = '## 沉淀词条';
const INDEX_SUMMARY_LIMIT = 320;

const LOG_HEADER = '# Patchouli Knowledge Log';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INDEX_LINE_DATE = /^- \[\[.*?\]\] - (\d{4}-\d{2}-\d{2})\b/;
/** 词条正文的 H1 标题行。 */
const MARKDOWN_H1 = /^#\s+(.+)$/;
/** 词条头部的 `Date: YYYY-MM-DD` 行。 */
const ENTRY_DATE_LINE = /^Date:\s*(\d{4}-\d{2}-\d{2})\s*$/;
/** 词条头部的 `Status:` 行。 */
const ENTRY_STATUS_LINE = /^Status:\s*/;
/** 词条头部的 `Merged-Into: [[目标标题]]` 行（被归并词条的指回链接）。 */
const ENTRY_MERGED_INTO_LINE = /^Merged-Into:\s*/;
/** 词条头部的 `Channel:` 行。 */
const ENTRY_CHANNEL_LINE = /^Channel:\s*(.*)$/;
/** 词条正文的摘要分区标题。 */
const SUMMARY_HEADING = '## 摘要';

const EMPTY_CONSENSUS = '_（本轮讨论未收敛出明确共识）_';
const EMPTY_OPEN_QUESTIONS = '_（暂未见未决分歧）_';
const EMPTY_DEBATE = '_（本轮讨论未形成可对照的观点阵营）_';
const EMPTY_QUOTES = '_（本轮未采撷到值得留存的原始言论）_';
const EMPTY_BACKGROUND = '_（无额外背景信息）_';
const EMPTY_TIMELINE = '_（该主题尚无归入的词条）_';
const EMPTY_TOPIC_REVIEW = '_（暂无主题综述）_';

/**
 * 原子写：同目录临时文件 + `rename`。
 *
 * index.md / log.md / 词条 md 都是一次性整体覆盖写；直接 `writeFile` 在断电或进程被杀时
 * 会留下半截文件，而引擎没有任何启动对账能发现它。`rename` 在同分区上是原子的。
 */
async function writeTextAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}

export interface WikiEngineOptions {
  /** llmwiki 根目录，`index.md` / `log.md` 落在其根下。 */
  wikiDir: string;
  /** 词条子目录，默认 `wiki/debates`。 */
  entrySubdir?: string;
  /** 原始会话 dump 子目录，默认 `raw/sessions`。 */
  rawSubdir?: string;
  /** 索引文件名，默认 `index.md`。 */
  indexFileName?: string;
  /** 流水文件名，默认 `log.md`。 */
  logFileName?: string;
  /** 索引单行摘要的最大字数，超出截断并追加省略号，默认 320。 */
  maxIndexSummaryLength?: number;
  /** 可注入时钟，便于测试与确定性输出。 */
  now?: () => number;
}

/** `saveEntry` 的可选上下文：给出会话即同步沉淀真理源 dump。 */
export interface WikiSaveEntryOptions {
  /** 本轮讨论的原始消息集，落盘为 `raw/sessions/<entryId>.json`。 */
  session?: DiscussionSession;
}

/** 原始会话 dump 的落盘结果。 */
export interface WikiRawWriteResult {
  /** `raw/sessions/<id>.json` 绝对路径。 */
  path: string;
  /** true = 本次新建；false = 真理源已存在（绝不覆写）。 */
  created: boolean;
}

export interface WikiWriteResult {
  entryId: string;
  title: string;
  /** 词条 Markdown 的绝对路径。 */
  entryPath: string;
  /** `index.md` 的绝对路径。 */
  indexPath: string;
  /** `log.md` 的绝对路径。 */
  logPath: string;
  /** 本次对应的原始会话 dump 绝对路径。 */
  rawSessionPath: string;
  /** 原始会话 dump 是否为本次新建（false 表示已存在，真理源未被改写）。 */
  rawSessionCreated: boolean;
  /** 索引文件此前是否存在。 */
  indexFileCreated: boolean;
  /** 索引中本词条是否为新插入行（false 表示原地更新既有行）。 */
  indexLineInserted: boolean;
  /** 流水文件此前是否存在。 */
  logFileCreated: boolean;
}

/** `deleteEntry` 的落盘结果。 */
export interface WikiDeleteResult {
  /** 至少删除了一项产物（词条文件 / 原始 dump / 索引托管行 / 流水托管行）。 */
  ok: boolean;
  /** `wiki/debates/<id>.md` 是否实际删除。 */
  deletedFile: boolean;
  /** `raw/sessions/<id>.json` 是否实际删除。 */
  deletedRaw: boolean;
}

/** `clearAllEntries` 的清理计数。 */
export interface WikiClearResult {
  /** 实际删除的 `wiki/debates/*.md` 数量。 */
  clearedDebatesCount: number;
  /** 实际删除的 `raw/sessions/*.json` 数量。 */
  clearedRawsCount: number;
}

/** `updateEntryMarkdown` 可同步到 `index.md` 的可选元数据（未给出的字段从正文反推）。 */
export interface WikiEntryMetadataPatch {
  title?: string;
  summary?: string;
  /** 必须为 `YYYY-MM-DD`。 */
  date?: string;
}

/**
 * `raw/sessions/<id>.json` 的文档结构。
 *
 * 刻意剥离 `ChatMessage.raw`（Koishi 事件对象，体积巨大且可能含循环引用/敏感字段），
 * 只保留构成讨论事实所需的最小字段；其余字段与 `DiscussionSession` 一一对应。
 */
export interface RawSessionDocument {
  version: 1;
  /** 词条 id（与 `wiki/debates/<id>.md` 同名）。 */
  id: string;
  sessionId: string;
  channelId: string;
  /** 毫秒时间戳。 */
  startTime: number;
  /** 毫秒时间戳。 */
  endTime: number;
  peakRate: number;
  triggerReason: string;
  messageCount: number;
  messages: RawSessionMessage[];
}

export interface RawSessionMessage {
  id: string;
  userId: string;
  userName: string;
  content: string;
  /** 毫秒时间戳。 */
  timestamp: number;
}

interface UpsertOutcome {
  content: string;
  /** true = 新增行，false = 原地覆盖既有行。 */
  inserted: boolean;
}

/**
 * llmwiki 沉淀引擎。
 *
 * 内部对 `index.md` / `log.md` 的「读-改-写」做串行化，多群并发结算时不会互相覆盖。
 */
export class WikiEngine {
  private readonly rootDir: string;
  private readonly entryDir: string;
  private readonly rawDir: string;
  private readonly indexPath: string;
  private readonly logPath: string;
  private readonly maxSummaryLength: number;
  private readonly now: () => number;
  /**
   * 本进程内最近一次写入的标题：编辑路径可能只换索引标题而正文 H1 仍旧，
   * 由此定位漂移前的索引 / 流水行。纯内存、不落盘，重启后由正文 H1 兜底。
   */
  private readonly knownTitles = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: WikiEngineOptions) {
    if (!options || typeof options.wikiDir !== 'string' || options.wikiDir.trim() === '') {
      throw new TypeError('WikiEngine: options.wikiDir 必填且不能为空字符串');
    }
    this.rootDir = nodePath.resolve(options.wikiDir);
    this.entryDir = nodePath.join(this.rootDir, options.entrySubdir ?? DEFAULT_ENTRY_SUBDIR);
    this.rawDir = nodePath.join(this.rootDir, options.rawSubdir ?? DEFAULT_RAW_SUBDIR);
    this.indexPath = nodePath.join(this.rootDir, options.indexFileName ?? DEFAULT_INDEX_FILE);
    this.logPath = nodePath.join(this.rootDir, options.logFileName ?? DEFAULT_LOG_FILE);
    this.maxSummaryLength = Math.max(32, options.maxIndexSummaryLength ?? INDEX_SUMMARY_LIMIT);
    this.now = options.now ?? Date.now;
  }

  /**
   * 从现有词条文件重建 id → 标题 索引（启动时调用一次）。
   *
   * `knownTitles` 是「改名时要知道旧标题」的唯一内存来源；进程重启后它是空的，
   * 于是改名只 upsert 新标题、旧标题的索引行永久残留。这里按 `<id>.md` 的 H1 回填。
   */
  async hydrateKnownTitles(): Promise<number> {
    let hydrated = 0;
    let names: string[];
    try {
      names = await fs.readdir(this.entryDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const id = name.slice(0, -'.md'.length);
      if (this.knownTitles.has(id)) continue;
      try {
        const text = await fs.readFile(nodePath.join(this.entryDir, name), 'utf8');
        const title = parseEntryMarkdown(text).title;
        if (typeof title === 'string' && title.trim().length > 0) {
          this.knownTitles.set(id, sanitizeTitle(title));
          hydrated += 1;
        }
      } catch {
        // 单个坏文件不影响其余索引重建
      }
    }
    return hydrated;
  }

  /** llmwiki 根目录（绝对路径）。 */
  get wikiDir(): string {
    return this.rootDir;
  }

  /** 词条目录（绝对路径，默认 `<wikiDir>/wiki/debates`）。 */
  get entriesDir(): string {
    return this.entryDir;
  }

  /** 原始会话 dump 目录（绝对路径，默认 `<wikiDir>/raw/sessions`）。 */
  get rawSessionsDir(): string {
    return this.rawDir;
  }

  /** 词条 `id` 对应的 Markdown 绝对路径。 */
  entryPath(id: string): string {
    return nodePath.join(this.entryDir, `${sanitizeFileName(id)}.md`);
  }

  /** 词条 `id` 对应的原始会话 dump 绝对路径。 */
  sessionDumpPath(id: string): string {
    return nodePath.join(this.rawDir, `${sanitizeFileName(id)}.json`);
  }

  /**
   * 沉淀一个词条：写原始会话 dump（真理源）→ 写词条文件 → 更新 `index.md` 单行索引 →
   * 追加 / 刷新 `log.md` 流水。
   *
   * 同一 `id` 重复沉淀时词条文件被覆盖、索引行原地更新、流水行原地刷新（不产生重复行）；
   * 而 `raw/sessions/<id>.json` 一旦存在就不再覆写（真理源只增不改）。
   */
  async saveEntry(entry: WikiEntry, options: WikiSaveEntryOptions = {}): Promise<WikiWriteResult> {
    assertWikiEntry(entry);
    const session = options.session;
    if (session !== undefined) assertDiscussionSession(session);

    return this.serialize(async () => {
      const title = sanitizeTitle(entry.title);
      const date = normalizeDate(entry.date, this.now());
      const rendered: WikiEntry = { ...entry, title, date };

      const rawResult =
        session === undefined
          ? { path: this.sessionDumpPath(entry.id), created: false }
          : await this.writeSessionDumpUnsafe(session, entry.id);

      const markdown = renderEntryMarkdown(rendered);
      const entryPath = this.entryPath(entry.id);
      await fs.mkdir(this.entryDir, { recursive: true });
      await writeTextAtomic(entryPath, ensureTrailingNewline(markdown));

      const indexLine = formatIndexLine(rendered, this.maxSummaryLength);
      const indexBefore = await readTextOrNull(this.indexPath);
      const indexOutcome = upsertIndexEntry(indexBefore ?? '', indexLine, title, date);
      await fs.mkdir(nodePath.dirname(this.indexPath), { recursive: true });
      await writeTextAtomic(this.indexPath, indexOutcome.content);

      const logLine = formatLogLine(rendered, new Date(this.now()));
      const logBefore = await readTextOrNull(this.logPath);
      const logOutcome = upsertLogEntry(logBefore ?? '', logLine, title);
      await writeTextAtomic(this.logPath, logOutcome.content);

      this.knownTitles.set(entry.id, title);

      return {
        entryId: entry.id,
        title,
        entryPath,
        indexPath: this.indexPath,
        logPath: this.logPath,
        rawSessionPath: rawResult.path,
        rawSessionCreated: rawResult.created,
        indexFileCreated: indexBefore === null,
        indexLineInserted: indexOutcome.inserted,
        logFileCreated: logBefore === null,
      };
    });
  }

  /**
   * 单独沉淀一份原始会话 dump 到 `raw/sessions/<entryId>.json`。
   * 目标文件已存在时直接返回，绝不覆写已有真理源。
   */
  async saveSessionDump(session: DiscussionSession, entryId: string): Promise<WikiRawWriteResult> {
    assertDiscussionSession(session);
    if (typeof entryId !== 'string' || entryId.trim() === '') {
      throw new TypeError('WikiEngine.saveSessionDump: entryId 必填');
    }
    return this.serialize(() => this.writeSessionDumpUnsafe(session, entryId));
  }

  /** 读取原始会话 dump 正文；文件不存在返回 undefined。 */
  async readSessionDump(id: string): Promise<string | undefined> {
    return (await readTextOrNull(this.sessionDumpPath(id))) ?? undefined;
  }

  /** 读取词条正文；文件不存在返回 undefined。 */
  async readEntry(id: string): Promise<string | undefined> {
    return (await readTextOrNull(this.entryPath(id))) ?? undefined;
  }

  /** 删除索引文本中该标题的托管行（模块级 `removeIndexEntry` 的实例门面）。 */
  removeIndexEntry(indexText: string, title: string): string {
    return removeManagedLines(indexText, title, ensureIndexScaffold);
  }

  /** 删除流水文本中该标题的托管行（模块级 `removeLogEntry` 的实例门面）。 */
  removeLogEntry(logText: string, title: string): string {
    return removeManagedLines(logText, title, ensureLogScaffold);
  }

  /**
   * 删除一个词条的全部产物：`wiki/debates/<id>.md`、`raw/sessions/<id>.json`，
   * 并移除 `index.md` / `log.md` 中该标题的托管行（脚手架保留）。
   *
   * `title` 省略时从待删除词条 Markdown 的 H1 反推；索引 / 流水按最终标题匹配。
   * 整个「读-删-改-写」走同一串行队列，不会与并发 `saveEntry` 交错。
   * `index.md` / `log.md` 不存在时保持缺失（删除操作不凭空创建文件）。
   */
  async deleteEntry(id: string, title?: string): Promise<WikiDeleteResult> {
    assertEntryId('deleteEntry', id);
    if (title !== undefined && typeof title !== 'string') {
      throw new TypeError('WikiEngine.deleteEntry: title 必须是字符串');
    }

    return this.serialize(async () => {
      const entryPath = this.entryPath(id);
      const rawPath = this.sessionDumpPath(id);
      const previousMarkdown = await readTextOrNull(entryPath);
      const parsedTitle = parseEntryMarkdown(previousMarkdown ?? '').title;
      const knownTitle = this.knownTitles.get(id);
      const resolvedTitle =
        title !== undefined && title.trim() !== ''
          ? sanitizeTitle(title)
          : parsedTitle ?? knownTitle ?? sanitizeTitle(id);
      // 标题漂移（索引按新标题更新、正文 H1 仍是旧标题、log 未刷新）时多种标题行一并清理。
      const candidateTitles = collectTitles(resolvedTitle, parsedTitle, knownTitle);

      const deletedFile = await removeFileIfExists(entryPath);
      const deletedRaw = await removeFileIfExists(rawPath);

      const indexBefore = await readTextOrNull(this.indexPath);
      let indexLineRemoved = false;
      if (indexBefore !== null) {
        let indexAfter = indexBefore;
        for (const candidate of candidateTitles) {
          if (hasManagedLine(indexAfter, candidate)) indexLineRemoved = true;
          indexAfter = removeIndexEntry(indexAfter, candidate);
        }
        if (indexAfter !== indexBefore) await writeTextAtomic(this.indexPath, indexAfter);
      }

      const logBefore = await readTextOrNull(this.logPath);
      let logLineRemoved = false;
      if (logBefore !== null) {
        let logAfter = logBefore;
        for (const candidate of candidateTitles) {
          if (hasManagedLine(logAfter, candidate)) logLineRemoved = true;
          logAfter = removeLogEntry(logAfter, candidate);
        }
        if (logAfter !== logBefore) await writeTextAtomic(this.logPath, logAfter);
      }

      this.knownTitles.delete(id);

      return {
        ok: deletedFile || deletedRaw || indexLineRemoved || logLineRemoved,
        deletedFile,
        deletedRaw,
      };
    });
  }

  /**
   * 清空全部沉淀产物：删除 `wiki/debates/*.md` 与 `raw/sessions/*.json`，
   * 并把 `index.md` / `log.md` 重置为初始脚手架（保留标题与分区说明）。
   *
   * 只删这两个目录下的**直接文件**（不递归），目录骨架与 `.patchouli/` 仓储原样保留。
   */
  async clearAllEntries(): Promise<WikiClearResult> {
    return this.serialize(async () => {
      const clearedDebatesCount = await removeFilesWithExtension(this.entryDir, '.md');
      const clearedRawsCount = await removeFilesWithExtension(this.rawDir, '.json');

      await fs.mkdir(this.entryDir, { recursive: true });
      await fs.mkdir(this.rawDir, { recursive: true });
      await fs.mkdir(nodePath.dirname(this.indexPath), { recursive: true });
      await writeTextAtomic(this.indexPath, finalizeText(ensureIndexScaffold([])));
      await writeTextAtomic(this.logPath, finalizeText(ensureLogScaffold([])));
      this.knownTitles.clear();

      return { clearedDebatesCount, clearedRawsCount };
    });
  }

  /**
   * 覆写词条 Markdown（`wiki/debates/<id>.md`）。
   *
   * 给出 `metadata` 中任意字段时，同步 `index.md` 对应单行：缺失字段从新正文的
   * H1 / `Date:` / `## 摘要` 反推，标题变更时一并清除旧标题的索引行。
   * 未给出任何元数据时只写正文，索引保持不变。
   */
  async updateEntryMarkdown(
    id: string,
    markdown: string,
    metadata: WikiEntryMetadataPatch = {},
  ): Promise<void> {
    assertEntryId('updateEntryMarkdown', id);
    if (typeof markdown !== 'string') {
      throw new TypeError('WikiEngine.updateEntryMarkdown: markdown 必须是字符串');
    }
    assertMetadataPatch(metadata);

    return this.serialize(async () => {
      const entryPath = this.entryPath(id);
      const previousMarkdown = await readTextOrNull(entryPath);
      await fs.mkdir(this.entryDir, { recursive: true });
      await writeTextAtomic(entryPath, ensureTrailingNewline(markdown));

      if (metadata.title === undefined && metadata.summary === undefined && metadata.date === undefined) {
        return;
      }

      const parsed = parseEntryMarkdown(markdown);
      const previousParsed = parseEntryMarkdown(previousMarkdown ?? '');
      const knownTitle = this.knownTitles.get(id);
      const title = sanitizeTitle(metadata.title ?? parsed.title ?? previousParsed.title ?? knownTitle ?? id);
      const date = normalizeDate(metadata.date ?? parsed.date ?? previousParsed.date ?? '', this.now());
      const summary = sanitizeInline(metadata.summary ?? parsed.summary ?? previousParsed.summary ?? '');

      let indexText = (await readTextOrNull(this.indexPath)) ?? '';
      for (const candidate of collectTitles(previousParsed.title, knownTitle)) {
        if (candidate !== title) indexText = removeIndexEntry(indexText, candidate);
      }
      const outcome = upsertIndexEntry(
        indexText,
        renderIndexLine(title, date, summary, this.maxSummaryLength),
        title,
        date,
      );
      await fs.mkdir(nodePath.dirname(this.indexPath), { recursive: true });
      await writeTextAtomic(this.indexPath, outcome.content);
      this.knownTitles.set(id, title);
    });
  }

  /**
   * 把一个词条标记为「已被归并」（`status: superseded` + `Merged-Into: [[目标标题]]`）。
   *
   * 只动头部两行，正文原样保留（历史证据不重写）；同时从 `index.md` 移除该标题的托管行，
   * 并向 `log.md` 追加一行归并流水（复用既有脚手架与同标题去重语义，重复调用不产生重复行）。
   *
   * 词条 Markdown 不存在时返回 `undefined`（调用方据此判定「无此词条」，不做任何写入）。
   * 整个「读-改-写」走同一串行队列，不会与并发 `saveEntry` 交错。
   */
  async markSuperseded(
    id: string,
    intoTitle: string,
  ): Promise<{ path: string; title: string } | undefined> {
    assertEntryId('markSuperseded', id);
    if (typeof intoTitle !== 'string' || intoTitle.trim() === '') {
      throw new TypeError('WikiEngine.markSuperseded: intoTitle 必填且不能为空字符串');
    }

    return this.serialize(async () => {
      const entryPath = this.entryPath(id);
      const previous = await readTextOrNull(entryPath);
      if (previous === null) return undefined;

      const parsed = parseEntryMarkdown(previous);
      const title = parsed.title ?? this.knownTitles.get(id) ?? sanitizeTitle(id);
      const target = sanitizeTitle(intoTitle);
      const channelId = parseEntryChannel(previous);

      const next = applySupersededMarkdown(previous, target);
      if (next !== previous) await writeTextAtomic(entryPath, next);

      const indexBefore = await readTextOrNull(this.indexPath);
      if (indexBefore !== null) {
        const indexAfter = removeIndexEntry(indexBefore, title);
        if (indexAfter !== indexBefore) await writeTextAtomic(this.indexPath, indexAfter);
      }

      const logLine = `- ${formatDateTime(new Date(this.now()))} [${channelId}] 归并 [[${title}]] → [[${target}]]`;
      const logBefore = await readTextOrNull(this.logPath);
      const logOutcome = upsertLogEntry(logBefore ?? '', logLine, title);
      await fs.mkdir(nodePath.dirname(this.logPath), { recursive: true });
      if (logOutcome.content !== logBefore) await writeTextAtomic(this.logPath, logOutcome.content);

      this.knownTitles.set(id, title);
      return { path: entryPath, title };
    });
  }

  /** 串行化所有文件变更，避免并发结算互相覆盖索引。 */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(noop, noop);
    return run;
  }

  /** 已持有串行队列时的原始 dump 写入（不可重入 `serialize`）。 */
  private async writeSessionDumpUnsafe(session: DiscussionSession, entryId: string): Promise<WikiRawWriteResult> {
    const path = this.sessionDumpPath(entryId);
    const existing = await readTextOrNull(path);
    if (existing !== null) return { path, created: false };

    const payload = `${JSON.stringify(toRawSessionDocument(session, entryId), null, 2)}\n`;
    await fs.mkdir(this.rawDir, { recursive: true });
    await writeTextAtomic(path, payload);
    return { path, created: true };
  }
}

/**
 * 把 `WikiEntry` 渲染成 llmwiki 词条 Markdown。
 *
 * 输出为纯函数结果：仅依赖入参，不含时间戳等易变字段，便于断言与幂等覆写。
 */
export function renderEntryMarkdown(entry: WikiEntry): string {
  const title = sanitizeTitle(entry.title);
  const tags = entry.tags.map(sanitizeTag).filter((tag) => tag.length > 0);
  const tagLine = tags.length > 0 ? tags.map((tag) => `[[${tag}]]`).join(', ') : '_（未标注）_';
  const participants = (entry.participants ?? [])
    .map(sanitizeInline)
    .filter((name) => name.length > 0);
  const participantLine =
    participants.length > 0 ? participants.map((name) => `[[${name}]]`).join(', ') : '_（未记录）_';
  const sources = (entry.sources ?? []).map(sanitizeInline).filter((source) => source.length > 0);
  const related = (entry.related ?? []).map(sanitizeTitle).filter((item) => item.length > 0);
  const narrative = typeof entry.narrative === 'string' ? entry.narrative : '';

  const lines: string[] = [];
  lines.push(`# ${title}`, '');
  lines.push(`Status: ${entry.status}`);
  if (entry.kind !== undefined) lines.push(`Kind: ${entry.kind}`);
  lines.push(`Date: ${entry.date}`);
  lines.push(`Tags: ${tagLine}`);
  lines.push(`Channel: ${sanitizeInline(entry.channelId)}`);
  // 单源（或未声明 sources）保持 llmwiki 旧格式 `Source: raw/sessions/<id>.json`；
  // 主题聚合这类多源词条改用 `Sources:` 列表，逐行列出每份真理源。
  if (sources.length >= 2) {
    lines.push('Sources:');
    for (const source of sources) lines.push(`  - ${source}`);
  } else if (sources.length === 1) {
    lines.push(`Source: ${sources[0]}`);
  } else {
    lines.push(`Source: ${sourcePathOf(entry.id)}`);
  }
  lines.push(`Participants: ${participantLine}`);
  if (related.length > 0) lines.push(`Related: ${related.map((item) => `[[${item}]]`).join(', ')}`);
  lines.push('');

  lines.push('## 摘要', '');
  lines.push(paragraphOr(entry.summary, EMPTY_BACKGROUND), '');

  lines.push('## 背景', '');
  lines.push(paragraphOr(entry.background, EMPTY_BACKGROUND), '');

  if (entry.kind === 'topic') {
    // 主题是长期聚合视图：综述在前、时间轴在后，成员词条按日期升序逐行列出。
    lines.push('## 主题综述', '');
    lines.push(...(narrative.trim().length > 0 ? renderNarrative(narrative) : [EMPTY_TOPIC_REVIEW]), '');
    lines.push('## 时间轴', '');
    lines.push(...renderTopicTimeline(entry.timeline), '');
  } else if (narrative.trim().length > 0) {
    lines.push('## 讨论脉络', '');
    lines.push(...renderNarrative(narrative), '');
  }

  lines.push('## 观点碰撞矩阵', '');
  lines.push(...renderDebateMatrix(entry.debateMatrix), '');

  lines.push('## 共识与结论', '');
  if (entry.consensus.length > 0) {
    entry.consensus.forEach((item, index) => {
      lines.push(`${index + 1}. ${sanitizeInline(item)}`);
    });
  } else {
    lines.push(EMPTY_CONSENSUS);
  }
  lines.push('');

  lines.push('## 未决分歧与开放思考', '');
  if (entry.openQuestions.length > 0) {
    entry.openQuestions.forEach((item) => {
      lines.push(`- ${sanitizeInline(item)}`);
    });
  } else {
    lines.push(EMPTY_OPEN_QUESTIONS);
  }
  lines.push('');

  const glossary = renderGlossary(entry.glossary);
  if (glossary.length > 0) {
    lines.push('## 名词注', '');
    lines.push(...glossary, '');
  }

  lines.push('## 原始言论 / 金句采撷', '');
  lines.push(...renderQuotes(entry.keyQuotes));

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')}\n`;
}

/** 词条头部 `Source:` 指向的原始数据相对路径（相对 llmwiki 根目录）。 */
export function sourcePathOf(entryId: string): string {
  return `${RAW_SOURCE_PREFIX}${sanitizeFileName(entryId)}.json`;
}

/** 把讨论会话投影为 `raw/sessions/<id>.json` 文档（剥离 Koishi 事件对象）。 */
export function toRawSessionDocument(session: DiscussionSession, entryId: string): RawSessionDocument {
  return {
    version: 1,
    id: sanitizeFileName(entryId),
    sessionId: session.sessionId,
    channelId: session.channelId,
    startTime: session.startTime,
    endTime: session.endTime,
    peakRate: session.peakRate,
    triggerReason: session.triggerReason,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    messages: (Array.isArray(session.messages) ? session.messages : []).map(
      (message: ChatMessage): RawSessionMessage => ({
        id: String(message.id),
        userId: String(message.userId),
        userName: String(message.userName),
        content: String(message.content),
        timestamp: message.timestamp,
      }),
    ),
  };
}

/** 渲染 `index.md` 中该词条的唯一单行摘要。 */
export function formatIndexLine(entry: WikiEntry, maxSummaryLength = INDEX_SUMMARY_LIMIT): string {
  return renderIndexLine(entry.title, entry.date, entry.summary, maxSummaryLength);
}

/** 渲染索引单行（格式不变量：`- [[标题]] - YYYY-MM-DD 摘要`）。 */
function renderIndexLine(title: string, date: string, summary: string, maxSummaryLength: number): string {
  const limit = Math.max(32, maxSummaryLength);
  return `- [[${sanitizeTitle(title)}]] - ${date} ${truncate(sanitizeInline(summary), limit)}`;
}

/** 渲染 `log.md` 中的一行沉淀流水。 */
export function formatLogLine(entry: WikiEntry, at: Date): string {
  const stamp = formatDateTime(at);
  const count = Number.isFinite(entry.metadata.messageCount) ? entry.metadata.messageCount : 0;
  return `- ${stamp} [${sanitizeInline(entry.channelId)}] 沉淀条目 [[${sanitizeTitle(entry.title)}]] (共 ${count} 条消息)`;
}

/**
 * 在索引文本中插入 / 原地更新单行条目，并清除同标题的历史重复行。
 *
 * 排序不变量：同一 `## 沉淀词条` 分区内按 `Date` 倒序（新词条在上），无日期行视为最旧。
 */
export function upsertIndexEntry(indexText: string, line: string, title: string, date: string): UpsertOutcome {
  const linkToken = `[[${sanitizeTitle(title)}]]`;
  let lines = ensureIndexScaffold(normalizeLines(indexText));

  const hits: number[] = [];
  lines.forEach((candidate, index) => {
    // 只认行首托管前缀：摘要里引用 `[[别的词条]]` 时，`includes` 会把**别人的**索引行
    // 当成自己的并在 upsert 时整行替换掉（实测可让另一篇词条从 index.md 消失）。
    if (candidate.trimStart().startsWith(`- ${linkToken}`)) hits.push(index);
  });

  if (hits.length > 0) {
    const first = hits[0];
    lines[first] = line;
    for (let cursor = hits.length - 1; cursor >= 1; cursor -= 1) {
      lines.splice(hits[cursor], 1);
    }
    return { content: finalizeText(lines), inserted: false };
  }

  const headingIndex = lines.findIndex((candidate) => candidate.trim() === INDEX_SECTION);
  let sectionEnd = lines.length;
  for (let cursor = headingIndex + 1; cursor < lines.length; cursor += 1) {
    if (/^##\s/.test(lines[cursor].trim())) {
      sectionEnd = cursor;
      break;
    }
  }

  let lastEntryIndex = -1;
  for (let cursor = headingIndex + 1; cursor < sectionEnd; cursor += 1) {
    if (lines[cursor].trim() !== '') lastEntryIndex = cursor;
  }

  let insertAt =
    lastEntryIndex === -1
      ? headingIndex + 1 + (lines[headingIndex + 1] === '' ? 1 : 0)
      : lastEntryIndex + 1;

  for (let cursor = headingIndex + 1; cursor <= lastEntryIndex; cursor += 1) {
    const parsed = parseIndexLineDate(lines[cursor]);
    if (parsed !== undefined && parsed < date) {
      insertAt = cursor;
      break;
    }
  }

  lines.splice(insertAt, 0, line);
  return { content: finalizeText(lines), inserted: true };
}

/** 在流水文本尾部追加一行；同标题既有行原地刷新，保证一个词条只占一行。 */
export function upsertLogEntry(logText: string, line: string, title: string): UpsertOutcome {
  const linkToken = `[[${sanitizeTitle(title)}]]`;
  let lines = ensureLogScaffold(normalizeLines(logText));

  const hits: number[] = [];
  lines.forEach((candidate, index) => {
    if (candidate.includes(linkToken)) hits.push(index);
  });

  if (hits.length > 0) {
    const first = hits[0];
    lines[first] = line;
    for (let cursor = hits.length - 1; cursor >= 1; cursor -= 1) {
      lines.splice(hits[cursor], 1);
    }
    return { content: finalizeText(lines), inserted: false };
  }

  lines.push(line);
  return { content: finalizeText(lines), inserted: true };
}

/**
 * 在索引文本中删除该标题的**全部**托管行（含历史重复行），并维持脚手架不变量
 * （`# Patchouli Knowledge Index` 与 `## 沉淀词条` 分区始终存在）。
 * 不匹配标题时仅做规范化，不删除任何用户内容。
 */
export function removeIndexEntry(indexText: string, title: string): string {
  const scaffolded = ensureIndexScaffold(normalizeLines(indexText));
  if (typeof title !== 'string' || title.trim() === '') return finalizeText(scaffolded);
  // 与 upsert 同一口径：只删行首托管行，摘要里的引用不算（log 行格式不同，另走包含匹配）。
  const kept = scaffolded.filter((line) => !line.trimStart().startsWith(`- [[${sanitizeTitle(title)}]]`));
  return finalizeText(ensureIndexScaffold(kept));
}

/** 在流水文本中删除该标题的全部托管行，并维持 `# Patchouli Knowledge Log` 标题。 */
export function removeLogEntry(logText: string, title: string): string {
  return removeManagedLines(logText, title, ensureLogScaffold);
}

/** 删除以 `- ` 开头且包含 `[[标题]]` 的行（引擎只托管这两种文本中的无序列表行）。 */
function removeManagedLines(
  text: string,
  title: string,
  scaffold: (lines: string[]) => string[],
): string {
  const scaffolded = scaffold(normalizeLines(text));
  if (typeof title !== 'string' || title.trim() === '') return finalizeText(scaffolded);

  const linkToken = `[[${sanitizeTitle(title)}]]`;
  const kept = scaffolded.filter((line) => !(line.trim().startsWith('- ') && line.includes(linkToken)));
  return finalizeText(scaffold(kept));
}

/* ------------------------------------------------------------------ *
 * 渲染细节
 * ------------------------------------------------------------------ */

function renderDebateMatrix(points: WikiDebatePoint[]): string[] {
  if (points.length === 0) return [EMPTY_DEBATE];

  const lines: string[] = [];
  lines.push('| # | 观点 | 支持者 | 核心论据 | 反驳 / 质疑 |');
  lines.push('| :--- | :--- | :--- | :--- | :--- |');
  points.forEach((point, index) => {
    const opponents = (point.opponents ?? []).map(sanitizeInline).filter((name) => name.length > 0);
    const counterText = (point.counterArguments ?? []).join('；');
    const challenger = opponents.length > 0 ? `(质疑者: ${opponents.join('、')})` : '';
    const counterCell = cell([counterText, challenger].filter((item) => item.length > 0).join(' ')) || '—';
    lines.push(
      `| ${index + 1} | ${cell(point.viewpoint)} | ${cell(point.proponents.join('、'))} | ` +
        `${cell(point.arguments.join('；')) || '—'} | ${counterCell} |`,
    );
  });

  lines.push('', '### 论据细分', '');
  points.forEach((point, index) => {
    lines.push(`#### ${index + 1}. ${sanitizeInline(point.viewpoint)}`, '');
    const proponents = point.proponents.map(sanitizeInline).filter((name) => name.length > 0);
    lines.push(`- **支持者**：${proponents.join('、') || '—'}`);
    if (point.arguments.length > 0) {
      lines.push('- **核心论据**：');
      point.arguments.forEach((argument) => {
        lines.push(`  - ${sanitizeInline(argument)}`);
      });
    }
    const counters = (point.counterArguments ?? []).map(sanitizeInline).filter((item) => item.length > 0);
    const opponents = (point.opponents ?? []).map(sanitizeInline).filter((name) => name.length > 0);
    if (counters.length > 0 || opponents.length > 0) {
      const challenger = opponents.length > 0 ? ` (质疑者: ${opponents.join('、')})` : '';
      lines.push(`- **质疑/反驳**${challenger}：`);
      counters.forEach((counter) => {
        lines.push(`  - ${counter}`);
      });
    }
    lines.push('');
  });

  return lines;
}

/** 名词注：`- **术语**：释义` 列表，缺字段的条目跳过，空时整段缺席。 */
function renderGlossary(glossary: WikiEntry['glossary']): string[] {
  if (!Array.isArray(glossary)) return [];
  const lines: string[] = [];
  for (const item of glossary) {
    const term = sanitizeInline(item.term ?? '');
    const note = sanitizeInline(item.note ?? '');
    if (term.length === 0 || note.length === 0) continue;
    lines.push(`- **${term}**：${note}`);
  }
  return lines;
}

/**
 * 主题时间轴：每条来源词条一行 `- YYYY-MM-DD 《标题》 — 贡献`。
 * `contribution` 缺失时回退该条的 `summary`；两者都空则只留日期与标题。
 */
function renderTopicTimeline(timeline: WikiEntry['timeline']): string[] {
  if (!Array.isArray(timeline) || timeline.length === 0) return [EMPTY_TIMELINE];
  const lines: string[] = [];
  for (const item of timeline) {
    if (item === null || typeof item !== 'object') continue;
    const date = sanitizeInline(item.date ?? '');
    const title = sanitizeTitle(item.title ?? '');
    const note = sanitizeInline(item.contribution ?? '') || sanitizeInline(item.summary ?? '');
    const head = date.length > 0 ? `${date} 《${title}》` : `《${title}》`;
    lines.push(note.length > 0 ? `- ${head} — ${note}` : `- ${head}`);
  }
  return lines.length > 0 ? lines : [EMPTY_TIMELINE];
}

/** 叙事正文（讨论脉络 / 主题综述）：按空行分段渲染，保留作者的分段，折叠多余空白。 */
function renderNarrative(value: string): string[] {
  const paragraphs = value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => plainText(line).trim())
    .filter((line) => line.length > 0);
  const out: string[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) out.push('');
    out.push(paragraph);
  });
  return out;
}

function renderQuotes(quotes: WikiEntry['keyQuotes']): string[] {
  if (quotes.length === 0) return [EMPTY_QUOTES];

  const lines: string[] = [];
  quotes.forEach((item, index) => {
    if (index > 0) lines.push('');
    lines.push(`> **${sanitizeInline(item.author)}**：${sanitizeBlockquote(item.quote)}`);
    const context = item.context === undefined ? '' : sanitizeBlockquote(item.context);
    if (context.length > 0) {
      lines.push('>');
      lines.push(`> 语境：${context}`);
    }
  });
  return lines;
}

/* ------------------------------------------------------------------ *
 * 索引 / 流水文本维护
 * ------------------------------------------------------------------ */

function ensureIndexScaffold(lines: string[]): string[] {
  const out = [...lines];
  if (!out.some((candidate) => /^#\s/.test(candidate.trim()))) {
    out.unshift(INDEX_HEADER, '');
  }
  if (!out.some((candidate) => candidate.trim() === INDEX_SECTION)) {
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    out.push('', INDEX_SECTION, '');
  }
  return out;
}

function ensureLogScaffold(lines: string[]): string[] {
  const out = [...lines];
  if (!out.some((candidate) => /^#\s/.test(candidate.trim()))) {
    out.unshift(LOG_HEADER, '');
  }
  return out;
}

function normalizeLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function finalizeText(lines: string[]): string {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
  return `${trimmed.join('\n')}\n`;
}

function parseIndexLineDate(line: string): string | undefined {
  const match = INDEX_LINE_DATE.exec(line.trim());
  return match ? match[1] : undefined;
}

/** 文本中是否存在该标题的托管行（`- ` 开头且含 `[[标题]]`）。 */
function hasManagedLine(text: string, title: string): boolean {
  const linkToken = `[[${sanitizeTitle(title)}]]`;
  return normalizeLines(text).some((line) => line.trim().startsWith('- ') && line.includes(linkToken));
}

/** 去重收集候选标题（已规范化），供删除时同时清理漂移前后的托管行。 */
function collectTitles(...titles: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of titles) {
    if (title === undefined) continue;
    const normalized = sanitizeTitle(title);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 文本规范化
 * ------------------------------------------------------------------ */

function assertEntryId(method: string, id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError(`WikiEngine.${method}: id 必填`);
  }
}

function assertMetadataPatch(metadata: WikiEntryMetadataPatch): void {
  if (!metadata || typeof metadata !== 'object') {
    throw new TypeError('WikiEngine.updateEntryMarkdown: metadata 必须是对象');
  }
  if (metadata.title !== undefined && (typeof metadata.title !== 'string' || metadata.title.trim() === '')) {
    throw new TypeError('WikiEngine.updateEntryMarkdown: metadata.title 必须是非空字符串');
  }
  if (metadata.summary !== undefined && typeof metadata.summary !== 'string') {
    throw new TypeError('WikiEngine.updateEntryMarkdown: metadata.summary 必须是字符串');
  }
  if (metadata.date !== undefined && (typeof metadata.date !== 'string' || !DATE_PATTERN.test(metadata.date.trim()))) {
    throw new TypeError('WikiEngine.updateEntryMarkdown: metadata.date 必须是 YYYY-MM-DD');
  }
}

interface ParsedEntryMarkdown {
  title?: string;
  date?: string;
  summary?: string;
}

/** 从词条 Markdown 反推索引所需的最小元数据（H1 / `Date:` / `## 摘要` 首段）。 */
function parseEntryMarkdown(markdown: string): ParsedEntryMarkdown {
  const parsed: ParsedEntryMarkdown = {};
  const lines = normalizeLines(markdown);

  for (const line of lines) {
    const heading = MARKDOWN_H1.exec(line.trim());
    if (heading !== null) {
      parsed.title = sanitizeTitle(heading[1]);
      break;
    }
  }

  for (const line of lines) {
    const dateMatch = ENTRY_DATE_LINE.exec(line.trim());
    if (dateMatch !== null) {
      parsed.date = dateMatch[1];
      break;
    }
  }

  const headingIndex = lines.findIndex((line) => line.trim() === SUMMARY_HEADING);
  if (headingIndex !== -1) {
    const collected: string[] = [];
    for (let cursor = headingIndex + 1; cursor < lines.length; cursor += 1) {
      const trimmed = lines[cursor].trim();
      if (/^#{2,6}\s/.test(trimmed)) break;
      if (trimmed !== '') collected.push(trimmed);
    }
    if (collected.length > 0) parsed.summary = sanitizeInline(collected.join(' '));
  }

  return parsed;
}

/** 从词条 Markdown 读取 `Channel:` 值（缺失时为空串，流水行保留 `[]` 占位）。 */
function parseEntryChannel(markdown: string): string {
  for (const line of normalizeLines(markdown)) {
    const matched = ENTRY_CHANNEL_LINE.exec(line.trim());
    if (matched !== null) return sanitizeInline(matched[1]);
  }
  return '';
}

/**
 * 把词条 Markdown 改写为「已归并」形态：`Status:` 改为 `superseded`，
 * 紧随其后插入（或原地刷新）`Merged-Into: [[目标标题]]`，其余正文逐行不动。
 *
 * 没有 `Status:` 行时（手工删改过的文件）补在 H1 之后；没有 H1 时补在文首。
 */
function applySupersededMarkdown(markdown: string, intoTitle: string): string {
  const lines = normalizeLines(markdown);
  const mergedLine = `Merged-Into: [[${intoTitle}]]`;
  const statusIndex = lines.findIndex((line) => ENTRY_STATUS_LINE.test(line.trim()));

  if (statusIndex === -1) {
    const block = ['Status: superseded', mergedLine];
    const headingIndex = lines.findIndex((line) => MARKDOWN_H1.test(line.trim()));
    if (headingIndex === -1) {
      lines.unshift(...block);
    } else {
      const afterHeading = lines[headingIndex + 1];
      const insertAt = afterHeading !== undefined && afterHeading.trim() === '' ? headingIndex + 2 : headingIndex + 1;
      lines.splice(insertAt, 0, ...block);
    }
    return finalizeText(lines);
  }

  lines[statusIndex] = 'Status: superseded';
  const following = lines[statusIndex + 1];
  if (following !== undefined && ENTRY_MERGED_INTO_LINE.test(following.trim())) {
    lines[statusIndex + 1] = mergedLine;
  } else {
    lines.splice(statusIndex + 1, 0, mergedLine);
  }
  return finalizeText(lines);
}

function assertWikiEntry(entry: WikiEntry): void {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('WikiEngine.saveEntry: entry 必须是对象');
  }
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    throw new TypeError('WikiEngine.saveEntry: entry.id 必填');
  }
  if (typeof entry.title !== 'string' || entry.title.trim() === '') {
    throw new TypeError('WikiEngine.saveEntry: entry.title 必填');
  }
  if (typeof entry.channelId !== 'string' || entry.channelId.trim() === '') {
    throw new TypeError('WikiEngine.saveEntry: entry.channelId 必填');
  }
  if (!Array.isArray(entry.debateMatrix) || !Array.isArray(entry.tags)) {
    throw new TypeError('WikiEngine.saveEntry: entry.tags / entry.debateMatrix 必须是数组');
  }
  if (ENTRY_STATUS_TABLE[entry.status] !== true) {
    throw new TypeError('WikiEngine.saveEntry: entry.status 必须是 verified / tentative / open / superseded');
  }
  if (entry.kind !== undefined && entry.kind !== 'debate' && entry.kind !== 'topic') {
    throw new TypeError('WikiEngine.saveEntry: entry.kind 必须是 debate / topic');
  }
  if (entry.timeline !== undefined && !isValidTimeline(entry.timeline)) {
    throw new TypeError(
      'WikiEngine.saveEntry: entry.timeline 必须是 { entryId, date, title, summary, contribution? } 数组',
    );
  }
  if (entry.sources !== undefined && !isStringArray(entry.sources)) {
    throw new TypeError('WikiEngine.saveEntry: entry.sources 必须是字符串数组');
  }
  if (entry.related !== undefined && !isStringArray(entry.related)) {
    throw new TypeError('WikiEngine.saveEntry: entry.related 必须是字符串数组');
  }
  if (entry.narrative !== undefined && typeof entry.narrative !== 'string') {
    throw new TypeError('WikiEngine.saveEntry: entry.narrative 必须是字符串');
  }
  if (entry.glossary !== undefined && !Array.isArray(entry.glossary)) {
    throw new TypeError('WikiEngine.saveEntry: entry.glossary 必须是数组');
  }
}

/** 词条状态的合法取值域（与 `WikiEntry['status']` 同源，供运行期校验）。 */
const ENTRY_STATUS_TABLE: Record<WikiEntry['status'], true> = {
  verified: true,
  tentative: true,
  open: true,
  superseded: true,
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 时间轴结构校验：四个必填字符串 + 可选 `contribution`；`date` 必须是 YYYY-MM-DD。 */
function isValidTimeline(value: unknown): value is TopicTimelineItem[] {
  if (!Array.isArray(value)) return false;
  return value.every((item: unknown) => {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Partial<Record<keyof TopicTimelineItem, unknown>>;
    if (typeof record.entryId !== 'string' || record.entryId.trim() === '') return false;
    if (typeof record.date !== 'string' || !DATE_PATTERN.test(record.date.trim())) return false;
    if (typeof record.title !== 'string' || record.title.trim() === '') return false;
    if (typeof record.summary !== 'string') return false;
    return record.contribution === undefined || typeof record.contribution === 'string';
  });
}

function assertDiscussionSession(session: DiscussionSession): void {
  if (!session || typeof session !== 'object') {
    throw new TypeError('WikiEngine: session 必须是对象');
  }
  if (typeof session.channelId !== 'string' || session.channelId.trim() === '') {
    throw new TypeError('WikiEngine: session.channelId 必填');
  }
  if (!Array.isArray(session.messages)) {
    throw new TypeError('WikiEngine: session.messages 必须是数组');
  }
}

/** 折叠所有空白（含换行）为单空格，保证 Markdown 单行语义。 */
function sanitizeInline(value: string): string {
  // 内联数学在落盘前摊平：词条 Markdown 的消费方（卡片 / 展厅 / 外部 Agent）都不渲染 LaTeX。
  return plainText(value).replace(/\s+/g, ' ').trim();
}

/** 标题既用作文件名来源也用作 `[[双链]]` 键，折叠空白后去首尾。 */
function sanitizeTitle(title: string): string {
  const cleaned = sanitizeInline(title);
  return cleaned.length > 0 ? cleaned : '未命名词条';
}

function sanitizeTag(tag: string): string {
  return sanitizeInline(tag).replace(/[|[\]]/g, '');
}

/** 表格单元格：竖线转义，换行折叠。 */
function cell(value: string): string {
  return sanitizeInline(value).replace(/\|/g, '\\|');
}

/** 引用块内容：换行转为 `>` 续行。 */
function sanitizeBlockquote(value: string): string {
  return plainText(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n> ');
}

function paragraphOr(value: string, fallback: string): string {
  const cleaned = sanitizeInline(value);
  return cleaned.length > 0 ? cleaned : fallback;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function sanitizeFileName(id: string): string {
  const cleaned = id
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'entry';
}

function normalizeDate(date: string, nowMs: number): string {
  if (typeof date === 'string' && DATE_PATTERN.test(date.trim())) return date.trim();
  return formatDate(new Date(nowMs));
}

export function formatDate(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

function formatDateTime(at: Date): string {
  return `${formatDate(at)} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** 删除单个文件；不存在返回 false（不抛 ENOENT）。 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }
}

/** 删除目录下指定扩展名的**直接子文件**（不递归），返回实际删除数量；目录缺失视为 0。 */
async function removeFilesWithExtension(directory: string, extension: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(extension)) continue;
    if (await removeFileIfExists(nodePath.join(directory, entry.name))) removed += 1;
  }
  return removed;
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === code;
}

function noop(): void {
  /* intentionally empty */
}
