import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import type { Context } from 'koishi';
import type { PatchouliKnowledgeSystem } from '../plugin/index';
import type { DispatcherConfig, LatestMessage, RichMessageElement, SubscriptionRow, TargetPolicies, TuningSnapshot, TrafficSeries, TriggerOptions, WikiEntry } from '../types';
import { LATEST_ENTRIES_LIMIT, MEDIA_PROXY_SEGMENT, TRAFFIC_CAPACITY, TRAFFIC_SAMPLE_MS } from '../types';
import {
  PATCHOULI_SYSTEM_PROMPT,
  PATCHOULI_SYSTEM_PROMPT_CONCISE,
  TOPIC_CURATOR_SYSTEM_PROMPT,
  resolveSystemPrompt,
  resolveTopicSystemPrompt,
} from '../dispatcher/prompts';
import type { WikiEntryRecord } from '../wiki/storage';
import { resolveWikiLayout } from '../wiki/layout';
import { TOPIC_SETTING_LIMITS } from '../plugin/topic-settings';
import { SETTINGS_META, SettingsConflictError, readTargetPolicies, upsertTargetPolicy } from '../plugin/settings-store';
import { ALBUM_TARGET_PATTERN, CHAT_TARGET, bareChannelId, isTargetGroupHeader } from '../plugin/subscriptions';
import {
  MAX_PERIOD_QUOTA,
  isDefaultPolicy,
  isPolicyKey,
  normalizePolicy,
  policyKey,
  splitPolicyKey,
} from '../plugin/policy-resolve';
import { albumTargetValues, albumValue, loadAlbumCatalog, type AlbumCandidate } from '../plugin/albums';
import {
  DEFAULT_TUNING_PARAMETERS,
  HIGH_QUALITY_THRESHOLD,
  TUNING_DECAY_FACTOR,
  TUNING_LIMITS,
} from '../trigger/tuning';
import { isProxyRequiredMediaUrl, mapElementMediaUrls } from '../plugin/rich-message';
import { createEmptyTelemetrySnapshot } from '../telemetry/types';
import { normalizeDispatcherProvider, resolveDispatcherModels } from '../dispatcher/dispatcher';
import { createMediaProxyHandler, type MediaFetchLike } from './media-proxy';
import { readFileSync } from 'node:fs';
import {
  TokenAuthority,
  createApiGuard,
  handleBootstrap,
  handleLogin,
  handleLogout,
  handleSession,
} from './auth';
import { renderEntryCard } from '../plugin/card-pipeline';
import { plainText } from '../wiki/plain-text';

/**
 * 包版本（面板底栏只读行展示）。
 *
 * 从包根 `package.json` 读一次：编译产物在 `lib/web/` 下，`../../package.json`
 * 正好是包根（npm 安装形态同样成立）。读取失败只影响展示，不影响路由。
 */
const PLUGIN_VERSION: string = (() => {
  try {
    const pkg: unknown = JSON.parse(readFileSync(nodePath.resolve(__dirname, '../../package.json'), 'utf8'));
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg) {
      const version = pkg.version;
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    /* 忽略：版本号只用于展示 */
  }
  return 'unknown';
})();

type RouteHandler = (ctx: KoishiKoaContext) => Promise<void> | void;

interface KoishiRouter {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  /** Koa Router 动词；旧宿主 / 测试替身可能只提供 get + post，注册时按能力探测。 */
  put?(path: string, handler: RouteHandler): void;
  delete?(path: string, handler: RouteHandler): void;
}

interface KoishiKoaContext {
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  request: {
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
  };
  req?: {
    headers?: Record<string, string | string[] | undefined>;
    once?(event: string, listener: () => void): void;
    on?(event: string, listener: () => void): void;
  };
  res?: { once?(event: string, listener: () => void): void; on?(event: string, listener: () => void): void };
  status: number;
  body: unknown;
  type?: string;
  set(name: string, val: string): void;
}

/** `registerWebUi` 的宿主注入项（测试与自定义代理用）。 */
export interface WebUiOptions {
  /** 媒体代理的上游抓取实现；缺省走 `node:http(s)` + 固定 IP。 */
  mediaFetch?: MediaFetchLike;
  /** 媒体代理的 DNS 解析实现；缺省 `dns.lookup`（每个解析结果都会做公网校验）。 */
  mediaLookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  /**
   * 相册现场探测（`apply()` 注入 bot / `miyako-delivery` 能力）。
   *
   * 只在相册缓存为空时调用一次：`GET /api/albums` 的冷启动路径。缺省时面板只看到缓存，
   * 探测失败 / 抛错一律降级成空目录，绝不 500。
   */
  probeAlbums?: () => Promise<readonly AlbumCandidate[]>;
}

interface ParsedDebatePoint {
  viewpoint: string;
  proponents: string[];
  opponents: string[];
  arguments: string[];
  counterArguments: string[];
}

const MATRIX_HEADING = /观点碰撞|碰撞矩阵|观点矩阵|debate\s*matrix/iu;
const MATRIX_SUBHEADING = /论据细分|细分/iu;
const SUPPORTER_LINE = /^[-*]\s*\*\*(?:提出\/支持者|支持者|提出者|主张者|阵营)\*\*\s*[:：]\s*(.*)$/u;
const ARGUMENT_LINE = /^[-*]\s*\*\*(?:核心论据|主要论据|论据|论证)\*\*\s*[:：]\s*$/u;
const COUNTER_LINE = /^[-*]\s*\*\*(?:质疑\/反驳|反驳\/质疑|反驳|质疑)\*\*\s*(?:\(质疑者\s*[:：]\s*(.*?)\))?\s*[:：]\s*$/u;

function splitNames(raw: string): string[] {
  return raw
    .replace(/\[\[|\]\]/gu, '')
    .split(/[,，、/]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 解析词条 Markdown 的「观点碰撞矩阵」。
 *
 * 兼容 `WikiEngine.renderEntryMarkdown` 现行产物（`#### N. 观点` + `**支持者**` /
 * `**核心论据**` / `**质疑/反驳** (质疑者: X)`）与旧版 `### 观点` 小节。
 */
function parseMarkdownDebateMatrix(content: string): ParsedDebatePoint[] {
  const points: ParsedDebatePoint[] = [];
  const lines = content.split('\n');
  let inMatrix = false;
  let current: ParsedDebatePoint | undefined;
  let section: 'arg' | 'counter' | 'none' = 'none';

  const pushCurrent = (): void => {
    if (current && (current.viewpoint || current.arguments.length > 0 || current.counterArguments.length > 0)) {
      points.push(current);
    }
    current = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^(#{2,6})\s+(.+?)\s*$/u.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      if (level === 2) {
        pushCurrent();
        inMatrix = MATRIX_HEADING.test(text);
        section = 'none';
        continue;
      }
      if (!inMatrix) continue;
      if (MATRIX_SUBHEADING.test(text)) {
        pushCurrent();
        section = 'none';
        continue;
      }
      // `#### 1. 观点`（现行）或 `### 观点：...`（旧版）
      pushCurrent();
      const viewpoint = text
        .replace(/^\d+[.)]\s*/u, '')
        .replace(/^(?:观点|立场|阵营)\s*[一二三四五六七八九十\d]*\s*[:：]\s*/u, '')
        .trim();
      current = { viewpoint, proponents: [], opponents: [], arguments: [], counterArguments: [] };
      section = 'none';
      continue;
    }
    if (!inMatrix) continue;
    if (!current) {
      if (!trimmed || trimmed.startsWith('|') || /^[:\-\s|]+$/u.test(trimmed)) continue;
      continue;
    }

    const supporters = SUPPORTER_LINE.exec(trimmed);
    if (supporters) {
      current.proponents.push(...splitNames(supporters[1]));
      section = 'none';
      continue;
    }
    if (ARGUMENT_LINE.test(trimmed)) {
      section = 'arg';
      continue;
    }
    const counter = COUNTER_LINE.exec(trimmed);
    if (counter) {
      if (counter[1]) current.opponents.push(...splitNames(counter[1]));
      section = 'counter';
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/u.exec(trimmed);
    if (bullet && (trimmed.startsWith('  ') || /^\s{2,}[-*]/u.test(line))) {
      const body = bullet[1].trim();
      if (section === 'arg') current.arguments.push(body);
      else if (section === 'counter') current.counterArguments.push(body);
    }
  }
  pushCurrent();
  return points;
}

/** 从词条头部 `Participants: [[A]], [[B]]` 行解析发言人名单。 */
function parseMarkdownParticipants(content: string): string[] {
  const matched = /^\s*Participants\s*[:：]\s*(.+)$/imu.exec(content);
  if (!matched) return [];
  const raw = matched[1].trim();
  if (!raw || raw.startsWith('_（')) return [];
  return splitNames(raw);
}

function parseMarkdownBulletSection(content: string, heading: string): string[] {
  const lines = content.split('\n');
  const results: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ') && trimmed.includes(heading)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (trimmed.startsWith('## ')) break;
      const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(trimmed);
      if (bullet && !bullet[1].startsWith('_（')) {
        results.push(bullet[1].trim());
      }
    }
  }
  return results;
}

function parseMarkdownQuotes(content: string): Array<{ author: string; quote: string }> {
  const lines = content.split('\n');
  const quotes: Array<{ author: string; quote: string }> = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ') && trimmed.includes('金句')) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (trimmed.startsWith('## ')) break;
      // > **群友**：原话
      if (trimmed.startsWith('> **') && trimmed.includes('**：')) {
        const match = /^>\s*\*\*(.*?)\*\*[:：](.*)$/.exec(trimmed);
        if (match) {
          quotes.push({ author: match[1].trim(), quote: match[2].trim() });
        }
      }
    }
  }
  return quotes;
}

/** llmwiki 占位文本（`_（…）_`）：解析时一律视为空。 */
const PLACEHOLDER_LINE = /^_?（[^）]*）_?$/u;

/** 抽取 `## 讨论脉络` / `## 主题综述` 正文，空行分段原样保留；只有占位文本时返回空串。 */
function parseMarkdownNarrative(content: string): string {
  const lines = content.split('\n');
  const paragraphs: string[] = [];
  let inSection = false;
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join(' ').trim();
    if (text !== '' && !PLACEHOLDER_LINE.test(text)) paragraphs.push(text);
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      if (inSection) break;
      if (trimmed.includes('讨论脉络') || trimmed.includes('主题综述')) inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (trimmed === '') {
      flush();
    } else {
      buffer.push(trimmed);
    }
  }
  flush();
  return paragraphs.join('\n\n');
}

/** 解析 `## 名词注` 的 `- **术语**：释义` 列表。 */
function parseMarkdownGlossary(content: string): Array<{ term: string; note: string }> {
  const lines = content.split('\n');
  const items: Array<{ term: string; note: string }> = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      if (inSection) break;
      if (trimmed.includes('名词注')) inSection = true;
      continue;
    }
    if (!inSection) continue;
    const matched = /^[-*+]\s+\*\*(.+?)\*\*\s*[:：]\s*(.+)$/u.exec(trimmed);
    if (matched === null) continue;
    const term = matched[1].trim();
    const note = matched[2].trim();
    if (term !== '' && note !== '' && !PLACEHOLDER_LINE.test(note)) items.push({ term, note });
  }
  return items;
}

/** 解析词条头部 `Related: [[甲]], [[乙]]` 行，输出标题列表。 */
function parseMarkdownRelated(content: string): string[] {
  const matched = /^\s*Related\s*[:：]\s*(.+)$/imu.exec(content);
  if (!matched) return [];
  const titles: string[] = [];
  for (const link of matched[1].matchAll(/\[\[([^\]]+)\]\]/gu)) {
    const title = link[1].trim();
    if (title !== '') titles.push(title);
  }
  return titles;
}

/** 解析词条头部 `Kind: debate|topic` 行；缺失或非合法值返回 undefined。 */
function parseMarkdownKind(content: string): WikiEntry['kind'] | undefined {
  const matched = /^\s*Kind\s*[:：]\s*(\S+)\s*$/imu.exec(content);
  if (!matched) return undefined;
  const value = matched[1].toLowerCase();
  return value === 'debate' || value === 'topic' ? value : undefined;
}

/**
 * 把缓存中的最新消息转成**浏览器可直接消费**的副本。
 *
 * 元素里的媒体字段按「能直链就直链」改写：
 *   - 公网 https → 原样保留（前端 `<img src>` / `<video src>` 直接用真实公共 URL）；
 *   - http（https 页面会被混合内容策略拦截）→ 改写为同源 `<basePath>/api/media/<opaqueId>`，
 *     opaqueId 必须已由本缓存消息登记，未登记则丢弃该字段（绝不伪造地址）。
 * 每次调用都重新构造元素对象，响应体被外部篡改也不会污染缓存。
 */
export function toBrowserLatestMessage(
  system: PatchouliKnowledgeSystem,
  channelId: string,
  basePath: string,
): LatestMessage | null {
  const latest = system.getLatestMessage(channelId);
  if (!latest) return null;
  const mediaBase = `${basePath}/${MEDIA_PROXY_SEGMENT}`;
  const elements: RichMessageElement[] = mapElementMediaUrls(latest.elements, (url) => {
    if (!isProxyRequiredMediaUrl(url)) return url;
    const id = system.mediaRegistry.idFor(channelId, url);
    return id ? `${mediaBase}/${id}` : undefined;
  });
  return { ...latest, elements };
}

/**
 * 读取某群的 AIMD 门限视图。
 *
 * 宿主持有控制器时直接取真实值；测试替身 / 旧宿主缺少该方法时按配置与常量回退，
 * 保证 `/api/status` 的响应结构恒定（`tuning` 字段永不缺席）。
 */
function readTuningSnapshot(
  system: PatchouliKnowledgeSystem,
  channelId: string,
  options: Partial<TriggerOptions>,
): TuningSnapshot {
  if (typeof system.getTuningSnapshot === 'function') {
    return system.getTuningSnapshot(channelId);
  }
  const { minBurstRate, minDiscussionMessages, thetaMin } = options;
  return {
    parameters: {
      minBurstRate: typeof minBurstRate === 'number' && Number.isFinite(minBurstRate)
        ? minBurstRate
        : DEFAULT_TUNING_PARAMETERS.minBurstRate,
      minDiscussionMessages: typeof minDiscussionMessages === 'number' && Number.isFinite(minDiscussionMessages)
        ? minDiscussionMessages
        : DEFAULT_TUNING_PARAMETERS.minDiscussionMessages,
      thetaMin: typeof thetaMin === 'number' && Number.isFinite(thetaMin)
        ? thetaMin
        : DEFAULT_TUNING_PARAMETERS.thetaMin,
    },
    limits: TUNING_LIMITS,
    decayFactor: TUNING_DECAY_FACTOR,
    highQualityThreshold: HIGH_QUALITY_THRESHOLD,
    lastUpdated: null,
  };
}

/** 判据台账落盘健康度（`/api/status.observability`）。 */
interface LedgerStats {
  written: number;
  failed: number;
  lastWriteAt: number | null;
}

/** 宿主没有台账能力时的恒定默认形状（每次返回副本，调用方改不坏共享常量）。 */
const EMPTY_LEDGER_STATS: Readonly<LedgerStats> = { written: 0, failed: 0, lastWriteAt: null };

/**
 * 读取判据台账的落盘统计。
 *
 * `shadowLedger` 属于可观测性切片，旧宿主 / 测试替身可能整块缺失或没有 `stats`。
 * 这时回零值而不是让 `/api/status` 抛 `TypeError` 变 500——监控页其余指标仍然可用，
 * 响应形状也保持恒定。
 */
function readLedgerStats(system: PatchouliKnowledgeSystem): LedgerStats {
  const ledger: unknown = system.shadowLedger;
  const stats = readCapability<[], unknown>(ledger, 'stats');
  if (stats === undefined) return { ...EMPTY_LEDGER_STATS };
  try {
    const value = stats();
    if (typeof value !== 'object' || value === null) return { ...EMPTY_LEDGER_STATS };
    const record: Record<string, unknown> = value as Record<string, unknown>;
    return {
      written: typeof record.written === 'number' ? record.written : 0,
      failed: typeof record.failed === 'number' ? record.failed : 0,
      lastWriteAt: typeof record.lastWriteAt === 'number' ? record.lastWriteAt : null,
    };
  } catch {
    return { ...EMPTY_LEDGER_STATS };
  }
}

/**
 * 管理员手调参数的下发前处理。
 *
 * AIMD 接管的三个物理闸门必须落在 `TUNING_LIMITS` 内（否则下一轮控制器会立刻夹回，
 * 面板看起来「改了没生效」）；三个门限都是**连续值**（`minDiscussionMessages` / `thetaMin`
 * 也允许小数，AIMD 的 +1 / +2 / -0.5 / +1.5 / -1.0 步进与时间衰减都不取整），统一保留 3 位小数。
 * 其余节奏参数是运维逃生舱，原样透传。
 */
function clampManualTuning(options: Partial<TriggerOptions>): {
  options: Partial<TriggerOptions>;
  clamped: Array<keyof TriggerOptions>;
} {
  const next: Partial<TriggerOptions> = { ...options };
  const clamped: Array<keyof TriggerOptions> = [];
  for (const key of ['minBurstRate', 'minDiscussionMessages', 'thetaMin'] as const) {
    const raw = next[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const [low, high] = TUNING_LIMITS[key];
    const value = Math.round(Math.min(high, Math.max(low, raw)) * 1000) / 1000;
    next[key] = value;
    if (value !== raw) clamped.push(key);
  }
  return { options: next, clamped };
}

/** 词条状态取值域（`WikiEntry['status']`）。 */
function isEntryStatus(value: unknown): value is WikiEntry['status'] {
  return value === 'verified' || value === 'tentative' || value === 'open';
}

/**
 * 读取宿主对象上的**可选**方法。
 *
 * 编辑 / 删除 / 清空三件套由 storage / wiki / plugin 三个切片分别落地，Web 层可能与旧宿主
 * 或测试替身共存：能力缺失时返回 `undefined` 由调用点决定回退路径，绝不假设方法存在，
 * 也绝不使用 `any`。
 */
function readCapability<A extends unknown[], R>(target: unknown, key: string): ((...args: A) => R) | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const candidate = (target as Record<string, unknown>)[key];
  if (typeof candidate !== 'function') return undefined;
  // 绑定宿主为 `this`：引擎方法内部会读私有字段，脱绑调用必崩。
  return (candidate as (...args: A) => R).bind(target);
}

/**
 * PUT 允许改动的元数据字段（`LocalStore.updateEntry` 契约）。
 * 正文路径不由客户端决定，只在首次写入正文后由 `saveEntry` 回填。
 */
interface EntryMetadataPatch {
  title?: string;
  summary?: string;
  status?: WikiEntry['status'];
  tags?: string[];
}

/** `WikiEngine.updateEntryMarkdown` 第三参：改写 `index.md` 单行索引时采用的标题 / 摘要。 */
interface EntryIndexMetadata {
  title?: string;
  summary?: string;
}

interface ParsedEntryBody {
  title?: string;
  summary?: string;
  status?: WikiEntry['status'];
  tags?: string[];
  markdown?: string;
}

type EntryBodyParseResult = { ok: true; patch: ParsedEntryBody } | { ok: false; error: string };

/** `PUT /api/entries/:id` 的写入上限：超限直接 400，绝不「先写进去再回读截断」。 */
const MAX_ENTRY_TITLE_CHARS = 200;
const MAX_ENTRY_SUMMARY_CHARS = 2000;
/** 与读侧 `MAX_DETAIL_MARKDOWN_CHARS` 同值：写进来的正文必须能被完整读回。 */
const MAX_ENTRY_MARKDOWN_CHARS = 200_000;

/**
 * 校验 `PUT /api/entries/:id` 的请求体。
 *
 * 契约：所有字段可选，但出现即必须类型正确；`status` 收敛到 verified / tentative / open；
 * `tags` 逐项校验后去空白、去重、丢弃空串；`markdown` 非空（空正文会把词条头部一并抹掉）。
 * 长度上限在**写入前**判定：`title ≤ 200`、`summary ≤ 2000`、`markdown ≤ 200_000` 字符，
 * 超限即 400 —— 绝不「先落盘再在回读时截断」（那会让面板显示与磁盘内容不一致）。
 * 一个可识别字段都没给时视为客户端错误，避免「静默无操作」。
 */
function parseEntryBody(raw: unknown): EntryBodyParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const body = raw as Record<string, unknown>;
  const patch: ParsedEntryBody = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return { ok: false, error: 'title 必须是字符串' };
    const title = body.title.trim();
    if (title.length === 0) return { ok: false, error: 'title 不能为空' };
    if (title.length > MAX_ENTRY_TITLE_CHARS) {
      return { ok: false, error: `title 不得超过 ${MAX_ENTRY_TITLE_CHARS} 个字符（收到 ${title.length}）` };
    }
    patch.title = title;
  }

  if (body.summary !== undefined) {
    if (typeof body.summary !== 'string') return { ok: false, error: 'summary 必须是字符串' };
    const summary = body.summary.trim();
    if (summary.length > MAX_ENTRY_SUMMARY_CHARS) {
      return {
        ok: false,
        error: `summary 不得超过 ${MAX_ENTRY_SUMMARY_CHARS} 个字符（收到 ${summary.length}）`,
      };
    }
    patch.summary = summary;
  }

  if (body.status !== undefined) {
    if (!isEntryStatus(body.status)) {
      return { ok: false, error: 'status 必须是 verified / tentative / open' };
    }
    patch.status = body.status;
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) return { ok: false, error: 'tags 必须是字符串数组' };
    const rawTags: unknown[] = body.tags;
    const tags: string[] = [];
    for (const tag of rawTags) {
      if (typeof tag !== 'string') return { ok: false, error: 'tags 必须是字符串数组' };
      const trimmed = tag.trim();
      if (trimmed.length > 0 && !tags.includes(trimmed)) tags.push(trimmed);
    }
    patch.tags = tags;
  }

  if (body.markdown !== undefined) {
    if (typeof body.markdown !== 'string') return { ok: false, error: 'markdown 必须是字符串' };
    if (body.markdown.trim().length === 0) return { ok: false, error: 'markdown 不能为空' };
    if (body.markdown.length > MAX_ENTRY_MARKDOWN_CHARS) {
      return {
        ok: false,
        error: `markdown 不得超过 ${MAX_ENTRY_MARKDOWN_CHARS} 个字符（收到 ${body.markdown.length}）`,
      };
    }
    patch.markdown = body.markdown;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: '至少提供一个可更新字段（title / summary / status / tags / markdown）' };
  }
  return { ok: true, patch };
}

/**
 * 组装词条详情响应（`GET` 与 `PUT` 共用）：读正文并解析矩阵 / 共识 / 分歧 / 金句。
 *
 * 正文缺失（`path` 未回填或文件已被删除）时退回纯元数据，响应结构对前端保持稳定。
 */
/** 详情接口回传正文的字符上限（约 600KB UTF-8）。 */
const MAX_DETAIL_MARKDOWN_CHARS = 200_000;

async function buildEntryDetail(record: WikiEntryRecord): Promise<Record<string, unknown>> {
  if (!record.path) return { ...record };
  try {
    // 正文按字符上限回传：10MB 词条实测会产出 21MB JSON 并让服务端 RSS +82MB。
    // 截断时明确告知前端（`markdownTruncated`），编辑页据此拒绝保存，避免用半截正文覆盖原文。
    const rawMarkdown = await fs.readFile(record.path, 'utf8');
    const markdownTruncated = rawMarkdown.length > MAX_DETAIL_MARKDOWN_CHARS;
    const md = markdownTruncated ? rawMarkdown.slice(0, MAX_DETAIL_MARKDOWN_CHARS) : rawMarkdown;
    const parsedParticipants = parseMarkdownParticipants(md);
    const narrative = parseMarkdownNarrative(md);
    const glossary = parseMarkdownGlossary(md);
    const related = parseMarkdownRelated(md);
    return {
      ...record,
      title: plainText(record.title),
      summary: plainText(record.summary),
      kind: record.kind ?? parseMarkdownKind(md),
      participants: parsedParticipants.length > 0 ? parsedParticipants : record.participants,
      markdown: md,
      markdownTruncated,
      debateMatrix: parseMarkdownDebateMatrix(md).map(plainDebatePoint),
      consensus: parseMarkdownBulletSection(md, '共识').map(plainText),
      openQuestions: parseMarkdownBulletSection(md, '分歧').map(plainText),
      keyQuotes: parseMarkdownQuotes(md).map((quote) => ({
        author: plainText(quote.author),
        quote: plainText(quote.quote),
      })),
      ...(narrative !== '' ? { narrative: plainText(narrative) } : {}),
      ...(glossary.length > 0
        ? { glossary: glossary.map((item) => ({ term: plainText(item.term), note: plainText(item.note) })) }
        : {}),
      ...(related.length > 0 ? { related: related.map(plainText) } : {}),
    };
  } catch {
    // 正文不可读：仍然回传元数据，绝不 500——列表与编辑元数据不应被正文故障拖死。
    return { ...record };
  }
}

/** 观点矩阵单元的展示文本摊平（与卡片路径的 `toPublicView` 同口径）。 */
function plainDebatePoint(point: ParsedDebatePoint): ParsedDebatePoint {
  return {
    viewpoint: plainText(point.viewpoint),
    proponents: point.proponents.map(plainText),
    opponents: point.opponents.map(plainText),
    arguments: point.arguments.map(plainText),
    counterArguments: point.counterArguments.map(plainText),
  };
}

/**
 * 把元数据补丁摊平成 `WikiEntry`，仅供宿主缺少 `LocalStore.updateEntry` 时回退到
 * `saveEntry`（`LocalStore` 只持久化元数据字段，正文与结构化段落不入库）。
 */
function toWikiEntry(record: WikiEntryRecord, patch: EntryMetadataPatch): WikiEntry {
  return {
    id: record.id,
    title: patch.title ?? record.title,
    channelId: record.channelId,
    date: record.date,
    status: patch.status ?? record.status,
    tags: patch.tags ? [...patch.tags] : [...record.tags],
    summary: patch.summary ?? record.summary,
    background: '',
    participants: [...record.participants],
    debateMatrix: [],
    consensus: [],
    openQuestions: [],
    keyQuotes: [],
    metadata: { ...record.metadata },
  };
}

/** 取词条正文绝对路径：优先已回填的 `record.path`，否则问引擎要 `entryPath(id)`。 */
function resolveEntryPath(system: PatchouliKnowledgeSystem, record: WikiEntryRecord, id: string): string | undefined {
  if (typeof record.path === 'string' && record.path.length > 0) return record.path;
  const engine: unknown = system.wikiEngine;
  if (typeof engine !== 'object' || engine === null) return undefined;
  const entryPath = readCapability<[string], string>(engine, 'entryPath');
  return entryPath ? entryPath(id) : undefined;
}

/** 只注册宿主真正暴露的动词；旧宿主缺 `put` / `delete` 时静默降级，不影响既有 GET 路由。 */
function registerVerb(router: KoishiRouter, verb: 'put' | 'delete', path: string, handler: RouteHandler): void {
  const register = router[verb];
  if (typeof register !== 'function') return;
  register.call(router, path, handler);
}

/* ------------------------------------------------------------------ *
 * 系统提示词：读写视图
 * ------------------------------------------------------------------ */

/** `GET/POST /api/prompt` 的响应载荷；两端点结构完全一致。 */
export interface PromptStatePayload {
  /** 最高品质的帕秋莉专属提示词全文（默认生效项）。 */
  defaultPrompt: string;
  /** 精简版提示词全文（`resolveSystemPrompt('concise')` 时生效）。 */
  concisePrompt: string;
  /** 当前自定义提示词原文；未设置时为空串。 */
  customPrompt: string;
  /** 当前实际拼装进请求的完整系统提示词。 */
  effectivePrompt: string;
  /** 是否有非空自定义提示词正在生效。 */
  isCustom: boolean;
  /** 主题聚合默认提示词全文。 */
  topicDefaultPrompt: string;
  /** 主题聚合当前自定义提示词；未设置时为空串。 */
  topicCustomPrompt: string;
  /** 主题聚合实际生效的完整系统提示词。 */
  topicEffectivePrompt: string;
  /** 是否有非空主题聚合自定义提示词。 */
  isTopicCustom: boolean;
}

/**
 * 单次提交的提示词上限（UTF-8 字节，64 KiB）。
 *
 * 提示词会整段拼进**每一次**模型请求，必须有物理上限；超限直接 400 而不是截断
 * （截断会静默改掉用户写的提示词）。两套提示词各自独立计。
 */
const MAX_PROMPT_BYTES = 64 * 1024;

function dispatcherConfigOf(system: PatchouliKnowledgeSystem): DispatcherConfig | undefined {
  const config = system.config as { dispatcher?: DispatcherConfig } | undefined;
  const dispatcher = config?.dispatcher;
  return dispatcher && typeof dispatcher === 'object' ? dispatcher : undefined;
}

/** 读取当前提示词状态：只读调度器的运行时覆盖，不触碰任何运行态。 */
export function readPromptState(system: PatchouliKnowledgeSystem): PromptStatePayload {
  // 单一真源是调度器的运行时覆盖；`config.dispatcher` 只是 Schema 兜底（旧宿主 / 测试替身）。
  const config = dispatcherConfigOf(system);
  const dispatcher = system.dispatcher;
  const customPrompt =
    typeof dispatcher?.customSystemPromptText === 'string'
      ? dispatcher.customSystemPromptText
      : typeof config?.customSystemPrompt === 'string'
        ? config.customSystemPrompt
        : '';
  const custom = customPrompt.trim();
  const topicCustomPrompt =
    typeof dispatcher?.topicPrompt === 'string'
      ? dispatcher.topicPrompt
      : typeof config?.customTopicPrompt === 'string'
        ? config.customTopicPrompt
        : '';
  const topicCustom = topicCustomPrompt.trim();
  // 与调度器同一条解析路径（`ModelDispatcher.systemPrompt`），保证「看到的就是生效的」。
  const dispatcherPrompt = system.dispatcher?.systemPrompt;

  return {
    defaultPrompt: PATCHOULI_SYSTEM_PROMPT,
    concisePrompt: PATCHOULI_SYSTEM_PROMPT_CONCISE,
    customPrompt,
    effectivePrompt:
      typeof dispatcherPrompt === 'string' && dispatcherPrompt.length > 0
        ? dispatcherPrompt
        : resolveSystemPrompt(custom.length > 0 ? custom : undefined),
    isCustom: custom.length > 0,
    topicDefaultPrompt: TOPIC_CURATOR_SYSTEM_PROMPT,
    topicCustomPrompt,
    topicEffectivePrompt: resolveTopicSystemPrompt(topicCustom.length > 0 ? topicCustom : undefined),
    isTopicCustom: topicCustom.length > 0,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 首次初始化落到 `<wikiDir>/.patchouli/api-token.txt` 的密钥。
 *
 * 注册路由时同步读一次（文件极小）；读不到就当未配置，由面板走 `/bootstrap`。
 */
function readApiTokenFileSync(file: string): string | undefined {
  try {
    const token = readFileSync(file, 'utf8').trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

/** 最小日志面：`warn` 缺失的宿主视为没有日志服务。 */
interface HostWarnLogger {
  warn?: (text: string) => void;
}

/**
 * 探测宿主的 `ctx.logger` 工厂。
 *
 * `ctx.logger` 由 logger 服务注入，测试替身 / 极简宿主没有它；逐层 `typeof` 收窄，
 * 不做「形状断言后就信任」的读取。
 */
function loggerWarn(ctx: Context): ((text: string) => void) | undefined {
  if (typeof ctx !== 'object' || ctx === null || !('logger' in ctx)) return undefined;
  try {
    const factory: unknown = ctx.logger;
    if (typeof factory !== 'function') return undefined;
    // 已知这是 `(name: string) => Logger`；这里只需要 warn，故按最小面调用。
    const logger = (factory as (name: string) => unknown)('patchouli');
    if (typeof logger !== 'object' || logger === null) return undefined;
    const warn: unknown = (logger as HostWarnLogger).warn;
    if (typeof warn !== 'function') return undefined;
    return (text: string): void => {
      (warn as (value: string) => void).call(logger, text);
    };
  } catch {
    // 宿主没有 logger 服务（或 cordis 拒绝未注册服务访问）：交给控制台兜底。
    return undefined;
  }
}

/**
 * 向宿主日志发一条告警。
 *
 * 宿主可能是没有 logger 服务的测试替身 / 极简宿主，这时退回控制台——
 * 这次降级关系到「守卫没装上」，绝不允许静默。
 */
function warnHost(ctx: Context, message: string): void {
  const warn = loggerWarn(ctx);
  if (warn !== undefined) {
    warn(message);
    return;
  }
  console.warn(message);
}

/* ------------------------------------------------------------------ *
 * 相册目录 + 订阅表：面板「投递目标」的数据面
 * ------------------------------------------------------------------ */

/** 相册候选项的线上形状：`value` 直接写进订阅行的 `targets`，`label` 供下拉展示。 */
export interface AlbumOption {
  value: string;
  groupId: string;
  groupName: string;
  albumId: string;
  albumName: string;
  label: string;
}

/** `GET /api/albums` 的响应体。 */
export interface AlbumCatalogPayload {
  albums: AlbumOption[];
  /** 上次探测时刻（epoch 毫秒）；`null` = 既无缓存、本轮探测也没成功。 */
  probedAt: number | null;
}

/** 把探测候选摊成下拉项：群名 / 相册名缺失时退回群号 / 相册ID，绝不留空标签。 */
function toAlbumOption(candidate: AlbumCandidate): AlbumOption {
  const groupName = candidate.groupName.trim();
  const albumName = candidate.albumName.trim();
  return {
    value: albumValue(candidate),
    groupId: candidate.groupId,
    groupName: candidate.groupName,
    albumId: candidate.albumId,
    albumName: candidate.albumName,
    label: `${groupName !== '' ? groupName : `群 ${candidate.groupId}`} / ${albumName !== '' ? albumName : candidate.albumId}`,
  };
}

/**
 * 读取面板用的相册目录（缓存优先，缓存为空时才用注入的 `probe` 探测一次）。
 *
 * 所有异常都在这里收敛成「空目录 + `probedAt: null`」：相册探测依赖外部服务
 * （OneBot / `miyako-delivery`），它的抖动不该把面板打成 500。
 */
async function readAlbumCatalogFor(
  system: PatchouliKnowledgeSystem,
  options: WebUiOptions,
): Promise<AlbumCatalogPayload> {
  try {
    const catalog = await loadAlbumCatalog(system.wikiDir, options.probeAlbums);
    return { albums: catalog.albums.map(toAlbumOption), probedAt: catalog.probedAt };
  } catch {
    return { albums: [], probedAt: null };
  }
}

/**
 * 面板「投递策略」区块的目标清单：当前订阅里真实存在的目标稳定地址。
 *
 * 由绑定表的**值**（`群号/相册ID`）与每个投递 `@chat` 的行（`@chat:<来源群>`）合成：
 * 策略挂在稳定地址上，可读名 / 探测顺序变化都不该产生新目标。去重后按字典序排序，
 * 面板顺序稳定（不随绑定表插入顺序抖动）。
 */
function policyTargetKeys(system: PatchouliKnowledgeSystem): string[] {
  const keys = new Set<string>();
  if (typeof system.targetBindingsSnapshot === 'function') {
    for (const address of Object.values(system.targetBindingsSnapshot())) keys.add(address);
  }
  if (typeof system.subscriptionTable === 'function') {
    for (const row of system.subscriptionTable().rows) {
      // 同一行里的 `@chat` 指向该行的来源群：键必须带来源，否则不同群互相覆盖策略。
      if (row.targets.includes(CHAT_TARGET)) keys.add(`${CHAT_TARGET}:${row.source}`);
    }
  }
  return [...keys].sort();
}

/** 一条策略的面板载荷（`GET /api/policies` 的数组项）。 */
export interface PolicyEntry {
  /** 监听群号（策略键的前半段）。 */
  source: string;
  /** 投递目标：订阅表里的写法（相册名 / `@chat`），拿不到名字时退回稳定地址。 */
  target: string;
  /** 日词条投递时间（5 字段 cron，空串 = 立即投）。 */
  entryCron: string;
  /** 周主题投递时间（5 字段 cron，空串 = 立即投）。 */
  weeklyCron: string;
  perDay: number;
  perWeek: number;
}

/**
 * 策略表 → 面板载荷。
 *
 * 键拆成 `source` + `target`；`target` 优先回显**订阅表里的写法**——前端按单元格标签
 * 文案匹配后缀，写稳定地址会匹配不上（相册名 → `群号/相册ID` 只在绑定表里有一份）。
 */
function policyEntries(system: PatchouliKnowledgeSystem, policies: TargetPolicies): PolicyEntry[] {
  const rows = typeof system.subscriptionTable === 'function' ? system.subscriptionTable().rows : [];
  const bindings = typeof system.targetBindingsSnapshot === 'function' ? system.targetBindingsSnapshot() : {};
  const entries: PolicyEntry[] = [];
  for (const [key, policy] of Object.entries(policies)) {
    const parts = splitPolicyKey(key);
    if (parts === undefined) continue;
    entries.push({
      source: parts.source,
      target: policyTargetToken(rows, bindings, parts.source, parts.target),
      entryCron: policy.entryCron,
      weeklyCron: policy.weeklyCron,
      perDay: policy.perDay,
      perWeek: policy.perWeek,
    });
  }
  return entries.sort((left, right) =>
    left.source === right.source ? left.target.localeCompare(right.target) : left.source.localeCompare(right.source),
  );
}

/** 稳定目标地址 → 该来源行里对应的写法（`@chat` / 相册名）；找不到就原样返回地址。 */
function policyTargetToken(
  rows: readonly SubscriptionRow[],
  bindings: Readonly<Record<string, string>>,
  source: string,
  target: string,
): string {
  const tokens: string[] = [];
  for (const row of rows) {
    if (bareChannelId(row.source) !== source) continue;
    for (const token of row.targets) {
      const trimmed = token.trim();
      if (trimmed !== '' && !tokens.includes(trimmed)) tokens.push(trimmed);
    }
  }
  if (target === `${CHAT_TARGET}:${source}`) return tokens.includes(CHAT_TARGET) ? CHAT_TARGET : target;
  for (const token of tokens) {
    if (token === CHAT_TARGET || isTargetGroupHeader(token)) continue;
    if (token === target || bindings[token] === target) return token;
  }
  return target;
}

/**
 * 面板写法 → 稳定目标地址（POST 的唯一翻译点）。
 *
 * `@chat` = 本行来源群聊天；相册名按绑定表解析（与订阅表保存时同一条规则）；
 * 已落盘的稳定地址按形状直接认。解析不到返回 `undefined` —— 存一个永远匹配不上的键
 * 等于静默不生效，不如 400 让用户先保存订阅表。
 */
function resolvePolicyTarget(system: PatchouliKnowledgeSystem, source: string, target: string): string | undefined {
  const value = target.trim();
  const chatPrefix = `${CHAT_TARGET}:`;
  if (value === CHAT_TARGET) return `${CHAT_TARGET}:${source}`;
  if (value.startsWith(chatPrefix)) {
    const group = bareChannelId(value.slice(chatPrefix.length));
    return group === '' || group === '*' ? undefined : `${CHAT_TARGET}:${group}`;
  }
  if (ALBUM_TARGET_PATTERN.test(value)) return value;
  const bound = system.targetBindingsSnapshot()[value];
  return typeof bound === 'string' && ALBUM_TARGET_PATTERN.test(bound) ? bound : undefined;
}

export function registerWebUi(
  ctx: Context,
  system: PatchouliKnowledgeSystem,
  basePath = '/patchouli',
  options: WebUiOptions = {},
): void {
  // Koishi 4.18 的 `ctx.router` 只是 `server` 服务的别名，在插件作用域内不可见；
  // `ctx.server` 本身继承自 Koa Router，因此只读 `server`，避免未注册属性警告。
  const rawCtx = ctx as unknown as { server?: KoishiRouter; router?: KoishiRouter } | undefined;
  if (!rawCtx || typeof rawCtx !== 'object') {
    return;
  }

  // 只在测试替身 / 旧宿主显式持有 `router` 自有属性时回退；
  // 直接读取未注册属性会触发 Koishi 的 "not registered" 警告。
  const legacyRouter = Object.prototype.hasOwnProperty.call(rawCtx, 'router') ? rawCtx.router : undefined;
  const hostRouter = rawCtx.server ?? legacyRouter;
  if (!hostRouter || typeof hostRouter.get !== 'function') {
    return;
  }

  const cleanBase = basePath.replace(/\/+$/, '');

  // 管理面鉴权：长期令牌只留在服务端，浏览器拿短票据（见 src/web/auth.ts）。
  // 测试替身可能没有 config；缺省按「未配置令牌」处理，正好等于 fail closed。
  const configuredToken =
    (system.config as { security?: { apiToken?: string } } | undefined)?.security?.apiToken ?? '';
  // 配置优先；配置留空时用首次初始化落到 `<wikiDir>/.patchouli/api-token.txt` 的密钥。
  const tokenPath = system.apiTokenPath;
  const fileToken = configuredToken.trim() === '' ? readApiTokenFileSync(tokenPath) : undefined;
  // 会话表落盘：重启后登录态继续有效（否则每次重启都要重新输入令牌）。
  // 测试替身可能没有 wikiDir，此时退回纯内存（行为与旧版一致）。
  const wikiDir = typeof system.wikiDir === 'string' && system.wikiDir.trim() !== '' ? system.wikiDir : undefined;
  const sessionsFile = wikiDir === undefined ? undefined : resolveWikiLayout(wikiDir).sessionsPath;
  const authority = new TokenAuthority(
    configuredToken.trim() === '' ? (fileToken ?? '') : configuredToken,
    sessionsFile === undefined ? {} : { sessionsFile },
  );

  // Koishi Router 类型没有暴露 `use`，但运行时就是 Koa Router（支持路径前缀中间件）。
  const routerWithUse = hostRouter as unknown as {
    use?: (path: string, middleware: (kCtx: never, next: () => Promise<unknown>) => Promise<unknown>) => unknown;
  };
  const installGuard = routerWithUse.use;
  const apiGuardMounted = typeof installGuard === 'function';
  if (apiGuardMounted) {
    installGuard.call(hostRouter, `${cleanBase}/api`, createApiGuard(authority));
  } else {
    // 守卫挂不上就没有第二道闸门：此时注册 `/api/*` 等于零鉴权（fail open），
    // 因此宁可不注册，面板只剩登录 / 自检与静态壳。
    warnHost(
      ctx,
      `[Patchouli] 宿主 router 不支持 use，无法挂载管理面守卫：已跳过全部 ${cleanBase}/api/* 路由注册（fail closed）。`,
    );
  }

  const isApiPath = (path: string): boolean => path === `${cleanBase}/api` || path.startsWith(`${cleanBase}/api/`);

  /**
   * 受保护路由的注册闸门。
   *
   * 守卫缺席时这里直接丢弃 `/api/*`；其余路径（登录 / 登出 / 初始化 / 自检 / 页面壳）
   * 自带鉴权或只返回静态外壳，照常注册。
   */
  const registerGuarded = (verb: 'get' | 'post' | 'put' | 'delete', path: string, handler: RouteHandler): void => {
    if (!apiGuardMounted && isApiPath(path)) return;
    const register = hostRouter[verb];
    if (typeof register !== 'function') return;
    register.call(hostRouter, path, handler);
  };

  const router: KoishiRouter = {
    get: (path, handler) => registerGuarded('get', path, handler),
    post: (path, handler) => registerGuarded('post', path, handler),
  };
  // 与旧行为一致：宿主没有 `put` / `delete` 时不伪造能力，`registerVerb` 仍会跳过。
  if (typeof hostRouter.put === 'function') {
    router.put = (path, handler) => registerGuarded('put', path, handler);
  }
  if (typeof hostRouter.delete === 'function') {
    router.delete = (path, handler) => registerGuarded('delete', path, handler);
  }

  // 登录：`POST <base>/login {token}` → 签发会话（Cookie + JSON 双通道）。
  if (typeof router.post === 'function') {
    router.post(`${cleanBase}/login`, async (kCtx: KoishiKoaContext) => {
      const body: unknown = (kCtx as unknown as { request?: { body?: unknown } }).request?.body;
      handleLogin(kCtx as unknown as Parameters<typeof handleLogin>[0], authority, body);
    });
    // 登出：吊销会话 + 清 Cookie。
    router.post(`${cleanBase}/logout`, async (kCtx: KoishiKoaContext) => {
      handleLogout(kCtx as unknown as Parameters<typeof handleLogout>[0], authority);
    });
  }

  // 首次初始化：未配置密钥时由面板生成/自定义，落盘并当场签发会话。
  if (typeof router.post === 'function') {
    router.post(`${cleanBase}/bootstrap`, async (kCtx: KoishiKoaContext) => {
      const body: unknown = (kCtx as unknown as { request?: { body?: unknown } }).request?.body;
      await handleBootstrap(
        kCtx as unknown as Parameters<typeof handleBootstrap>[0],
        authority,
        body,
        { file: tokenPath },
      );
    });
  }

  // 会话自检：客户端启动第一件事，决定弹「首次初始化」还是「登录」。
  router.get(`${cleanBase}/session`, (kCtx: KoishiKoaContext) => {
    handleSession(kCtx as unknown as Parameters<typeof handleSession>[0], authority);
  });

  // 注意：不再提供任何服务端渲染的 HTML 页面（`GET <base>` / `GET <base>/` 已删除）。
  // 唯一的 UI 是 Console 里的「LLMWiki」浮窗（`client/dist/index.js`），它只消费下面的 `/api/*`。

  // 2. API: 获取词条清单（可按群聊分群筛选 + 广义关键词穿透检索）
  router.get(`${cleanBase}/api/entries`, async (kCtx: KoishiKoaContext) => {
    const channelQuery = typeof kCtx.query.channelId === 'string' && kCtx.query.channelId.length > 0
      ? kCtx.query.channelId
      : undefined;
    const keywordQuery = typeof kCtx.query.keyword === 'string' ? kCtx.query.keyword.trim() : '';
    // scope=meta 限定元数据；默认 full：关键词同时穿透 Markdown 正文（矩阵 / 共识 / 原始引用）
    const view = kCtx.query.scope === 'meta' ? 'meta' : 'full';

    const records = keywordQuery.length > 0
      ? await system.localStore.searchEntries(keywordQuery, channelQuery, { view, limit: 200 })
      : await system.localStore.getRecentEntries(channelQuery, 200);

    kCtx.type = 'application/json';
    kCtx.body = records;
  });

  // 2b. API: 群聊清单（配置白名单 ∪ 已沉淀词条涉及的群聊），供前端分群下拉
  router.get(`${cleanBase}/api/channels`, async (kCtx: KoishiKoaContext) => {
    const configured = Array.isArray(system.config.channels) ? system.config.channels : [];
    const stored = await system.localStore.listChannels();
    const channels = [...new Set([...configured, ...stored])].sort();

    kCtx.type = 'application/json';
    kCtx.body = { channels, configured };
  });

  // 2c. API: 最新词条（底栏轮播）——恒定取全局最近沉淀，独立于关键词检索与群聊筛选
  router.get(`${cleanBase}/api/latest`, async (kCtx: KoishiKoaContext) => {
    const rawLimit = typeof kCtx.query.limit === 'string' ? Number.parseInt(kCtx.query.limit, 10) : Number.NaN;
    const limit = Number.isFinite(rawLimit)
      ? Math.min(LATEST_ENTRIES_LIMIT, Math.max(1, rawLimit))
      : LATEST_ENTRIES_LIMIT;
    const records = await system.localStore.getRecentEntries(undefined, limit);

    kCtx.type = 'application/json';
    kCtx.body = records;
  });

  // 2d. API: 系统提示词查阅（默认 / 精简 / 当前自定义 / 实际生效全文）
  router.get(`${cleanBase}/api/prompt`, (kCtx: KoishiKoaContext) => {
    kCtx.type = 'application/json';
    kCtx.body = readPromptState(system);
  });

  // 2e. API: 系统提示词热更新并持久化（空 customPrompt = 恢复默认内置提示词）
  router.post(`${cleanBase}/api/prompt`, async (kCtx: KoishiKoaContext) => {
    const body = kCtx.request.body as { customPrompt?: unknown; customTopicPrompt?: unknown } | undefined;
    if (body !== undefined && (typeof body !== 'object' || body === null)) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'Invalid payload' };
      return;
    }

    const hasEntry = typeof body?.customPrompt === 'string';
    const hasTopic = typeof body?.customTopicPrompt === 'string';
    if (!hasEntry && !hasTopic) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: '至少提供 customPrompt 或 customTopicPrompt' };
      return;
    }

    // 物理上限先判：超限直接 400，绝不截断后落盘（用户看到的与生效的必须是同一份）。
    for (const [field, value] of [
      ['customPrompt', body?.customPrompt],
      ['customTopicPrompt', body?.customTopicPrompt],
    ] as const) {
      if (typeof value !== 'string') continue;
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_PROMPT_BYTES) {
        kCtx.status = 400;
        kCtx.body = { ok: false, error: `${field} 超过 ${MAX_PROMPT_BYTES} 字节上限（收到 ${bytes}）` };
        return;
      }
    }

    // 原样保存用户输入（含换行缩进）：先原子落盘，再由 system 热更新运行时覆盖；
    // 空白内容收敛回内置提示词，同时删除落盘文件。
    try {
      if (hasEntry) {
        await system.saveCustomPrompt(String(body?.customPrompt));
      }
      if (hasTopic) {
        await system.saveTopicPrompt(String(body?.customTopicPrompt));
      }
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: `系统提示词落盘失败：${errorMessage(err)}` };
      return;
    }

    kCtx.type = 'application/json';
    kCtx.body = { ok: true, ...readPromptState(system) };
  });

  // 2f. API: 主题校准运行时参数（面板可调：时/分、回看天数、聚类门限、最少条数）
  router.get(`${cleanBase}/api/topics/settings`, (kCtx: KoishiKoaContext) => {
    const models = resolveDispatcherModels(system.config.dispatcher);
    kCtx.type = 'application/json';
    kCtx.body = {
      ok: true,
      settings: system.getTopicSettings(),
      limits: TOPIC_SETTING_LIMITS,
      lastRun: system.lastTopicRun,
      dispatcher: {
        provider: normalizeDispatcherProvider(system.config.dispatcher.provider),
        protocol: system.dispatcher?.protocolId ?? 'responses',
        // 只报当前通道的模型名：ChatLuna 模型 id 与端点模型名是两套命名空间。
        model: models.chatlunaModel || models.customModel,
      },
    };
  });

  router.post(`${cleanBase}/api/topics/settings`, async (kCtx: KoishiKoaContext) => {
    const body = kCtx.request.body as { settings?: unknown } | undefined;
    const patch = body && typeof body === 'object' && 'settings' in body ? body.settings : body;
    if (typeof patch !== 'object' || patch === null) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'Invalid payload' };
      return;
    }
    try {
      const settings = await system.updateTopicSettings(patch);
      kCtx.type = 'application/json';
      kCtx.body = { ok: true, settings, limits: TOPIC_SETTING_LIMITS };
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: errorMessage(err) };
    }
  });

  // 2g. API: 出图选项（面板「图片匿名化」开关；默认开启，关闭后按原昵称出图）
  router.get(`${cleanBase}/api/card/settings`, (kCtx: KoishiKoaContext) => {
    kCtx.type = 'application/json';
    kCtx.body = { ok: true, settings: system.getCardSettings() };
  });

  router.post(`${cleanBase}/api/card/settings`, async (kCtx: KoishiKoaContext) => {
    const body = kCtx.request.body as { settings?: unknown; maskNames?: unknown } | undefined;
    const patch = body && typeof body === 'object' && 'settings' in body ? body.settings : body;
    if (typeof patch !== 'object' || patch === null) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'Invalid payload' };
      return;
    }
    try {
      const settings = await system.updateCardSettings(patch);
      kCtx.type = 'application/json';
      kCtx.body = { ok: true, settings };
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: errorMessage(err) };
    }
  });

  // 2h. API: 运行时设置覆盖层（触发算法 / 主题校准 / 素材池 / 长图 / 裁判）
  //
  // GET 返回**合并后**的五段值（覆盖层 > koishi.yml > Schema 默认值）与字段元数据，
  // 外加投递策略（`policies`，数组形状与 `GET /api/policies` 相同）与当前真实存在的
  // 目标清单（`targets`）——纯只读展示。
  // 策略的写入口是 `POST /api/policies`（订阅表里投递群标签的右键菜单）；
  // `POST /api/settings` 的 `section: 'policies'` 一律 400，绝不接受第二个写入口
  // （单一真源，ADR-022 同样适用）。
  // POST 只接受 {section, patch}，未知键丢弃、非法值 400。写入落在
  // `<wikiDir>/.patchouli/settings.json`，绝不改宿主 config（ADR-022）。
  // 校验分两层且都在落盘之前：字段级 + 「合并后」跨字段（触发器的 `normalizeTriggerOptions`）。
  // 任一层不过都是 400 且文件与运行态都不变——不会再出现「500 但坏值已落盘」。
  router.get(`${cleanBase}/api/settings`, async (kCtx: KoishiKoaContext) => {
    kCtx.type = 'application/json';
    const wikiDir = typeof system.wikiDir === 'string' && system.wikiDir.trim() !== '' ? system.wikiDir : undefined;
    kCtx.body = {
      sections: system.getSettingsSections(),
      meta: SETTINGS_META,
      // 策略缺失 / 文件损坏 → 空表（= 立即投、不限量），读路径绝不 500。
      policies: wikiDir === undefined ? [] : policyEntries(system, await readTargetPolicies(wikiDir)),
      targets: policyTargetKeys(system),
    };
  });

  router.post(`${cleanBase}/api/settings`, async (kCtx: KoishiKoaContext) => {
    const body = kCtx.request.body as { section?: unknown; patch?: unknown } | undefined;
    if (typeof body !== 'object' || body === null) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'Invalid payload' };
      return;
    }
    // 投递策略只认 `/api/policies`（逐项 upsert，见 2h2）：整表写入会让并发保存互相覆盖。
    if (body.section === 'policies') {
      kCtx.type = 'application/json';
      kCtx.status = 400;
      kCtx.body = { ok: false, error: '投递策略请在订阅表的投递群标签上右键设置（POST /api/policies）' };
      return;
    }
    try {
      const result = await system.updateSettings(body.section, body.patch);
      kCtx.type = 'application/json';
      if (!result.ok) {
        kCtx.status = 400;
        kCtx.body = { ok: false, error: result.error };
        return;
      }
      kCtx.body = { ok: true, value: result.value };
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: errorMessage(err) };
    }
  });

  // 2h2. API: 投递策略（订阅表「投递群」标签右键菜单的读写口）
  //
  // 键 = `<来源群>\u0000<目标键>`：同一个投递群在不同监听群里各有一份独立策略。
  // GET 把键拆成 `{ source, target, entryCron, weeklyCron, perDay, perWeek }`；`target` 回显
  // 订阅表里的写法（相册名 / `@chat`），前端按标签文案匹配后缀。
  // POST 是**逐项 upsert + 局部更新**：没给的字段沿用该项现有值，其余项原样保留
  // （并发保存因此不会互相覆盖）；四字段全等于缺省（空 cron / 0 / 0）= 删除该项。
  // 非法输入 400 且文件一个字节都不动。
  router.get(`${cleanBase}/api/policies`, async (kCtx: KoishiKoaContext) => {
    kCtx.type = 'application/json';
    const wikiDir = typeof system.wikiDir === 'string' ? system.wikiDir.trim() : '';
    kCtx.body = { policies: wikiDir === '' ? [] : policyEntries(system, await readTargetPolicies(wikiDir)) };
  });

  router.post(`${cleanBase}/api/policies`, async (kCtx: KoishiKoaContext) => {
    const body = kCtx.request.body as
      | {
          source?: unknown;
          target?: unknown;
          entryCron?: unknown;
          weeklyCron?: unknown;
          perDay?: unknown;
          perWeek?: unknown;
          cron?: unknown;
        }
      | undefined;
    if (typeof body !== 'object' || body === null) {
      kCtx.status = 400;
      kCtx.body = {
        ok: false,
        error: 'Invalid payload：需要 { source, target, entryCron?, weeklyCron?, perDay?, perWeek? }',
      };
      return;
    }
    /* 旧单一定时字段已经拆开：静默忽略会让面板的旧缓存把投递时间清成「立即投」。 */
    if (body.cron !== undefined) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'cron 已拆成 entryCron（日词条）/ weeklyCron（周主题），请分别提交' };
      return;
    }
    const source = typeof body.source === 'string' ? bareChannelId(body.source) : '';
    if (source === '') {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'source 不能为空' };
      return;
    }
    const targetText = typeof body.target === 'string' ? body.target.trim() : '';
    if (targetText === '') {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'target 不能为空' };
      return;
    }
    const target = resolvePolicyTarget(system, source, targetText);
    if (target === undefined) {
      kCtx.status = 400;
      kCtx.body = {
        ok: false,
        error: `目标 ${JSON.stringify(targetText)} 未绑定到相册（请先在订阅表里保存该相册）`,
      };
      return;
    }
    const key = policyKey(source, target);
    if (!isPolicyKey(key)) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: `策略键非法：${JSON.stringify(key)}` };
      return;
    }
    try {
      /* 局部更新：**没给**的字段沿用该项现有值（面板只发改动的那几项），
         没这一项时按缺省补（立即投 / 不限量）。整条四字段全默认 = 删除该项。 */
      const existing = (await readTargetPolicies(system.wikiDir))[key];
      const policy = normalizePolicy({
        entryCron: body.entryCron === undefined ? existing?.entryCron : body.entryCron,
        weeklyCron: body.weeklyCron === undefined ? existing?.weeklyCron : body.weeklyCron,
        perDay: body.perDay === undefined ? existing?.perDay : body.perDay,
        perWeek: body.perWeek === undefined ? existing?.perWeek : body.perWeek,
      });
      if (policy === null) {
        kCtx.status = 400;
        kCtx.body = {
          ok: false,
          error:
            `策略字段非法：entryCron / weeklyCron 需为 5 字段表达式（分 时 日 月 周），` +
            `perDay / perWeek 需为 0–${MAX_PERIOD_QUOTA} 的整数`,
        };
        return;
      }
      const stored = await upsertTargetPolicy(system.wikiDir, key, isDefaultPolicy(policy) ? null : policy);
      kCtx.type = 'application/json';
      kCtx.body = { ok: true, policies: policyEntries(system, stored) };
    } catch (err: unknown) {
      kCtx.type = 'application/json';
      kCtx.status = err instanceof SettingsConflictError ? 400 : 500;
      kCtx.body = {
        ok: false,
        error:
          err instanceof SettingsConflictError ? err.message : `投递策略保存失败：${errorMessage(err)}`,
      };
    }
  });

  // 2i. API: 相册目录（订阅表「投递目标」的动态候选）
  //
  // 缓存优先：`<wikiDir>/.patchouli/albums.json` 有内容就直接回；为空才让注入的
  // `probeAlbums` 现场探测一次并回写缓存。探测失败返回空目录 + `probedAt: null`。
  router.get(`${cleanBase}/api/albums`, async (kCtx: KoishiKoaContext) => {
    kCtx.type = 'application/json';
    kCtx.body = await readAlbumCatalogFor(system, options);
  });

  // 2j. API: 订阅表读取（当前生效行 + 来源 + 相册目录）
  //
  // `source`：`settings` = 面板覆盖层，`config` = 宿主 yml。相册只读缓存 ——
  // GET 是面板打开就发的请求，不能每次都触发秒级探测（保鲜由 `/api/albums` 负责）。
  router.get(`${cleanBase}/api/subscriptions`, async (kCtx: KoishiKoaContext) => {
    const catalog = await readAlbumCatalogFor(system, {});
    const table = system.subscriptionTable();
    kCtx.type = 'application/json';
    kCtx.body = {
      rows: table.rows,
      source: table.source,
      albums: catalog.albums,
      probedAt: catalog.probedAt,
    };
  });

  // 2k. API: 订阅表保存（写覆盖层，绝不改宿主 config —— ADR-022）
  //
  // 校验在 `system.updateSubscriptions` 里（纯函数 `validateSubscriptionRows`）：
  // 行数 ≤256、单行目标 ≤16 且去重。值域 = 候选唯一名 ∪ 候选稳定地址（升级前的值）
  // ∪ 现有值（暂时解析不了也允许原样保存）。
  //
  // 同一批候选还用于**保存时绑定**：名字在这里换成 `群号/相册ID` 写进 `targetBindings`，
  // 投递期只认那张表；解析不到的名字进响应 `unresolved`（保留但不投递）。
  router.post(`${cleanBase}/api/subscriptions`, async (kCtx: KoishiKoaContext) => {
    const body = kCtx.request.body as { rows?: unknown } | undefined;
    if (typeof body !== 'object' || body === null || !('rows' in body)) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'Invalid payload：需要 { rows: [...] }' };
      return;
    }
    try {
      const catalog = await readAlbumCatalogFor(system, {});
      // `AlbumOption` 带着探测到的那四个字段，重建候选即可复用 `albums.ts` 的命名规则。
      const candidates: AlbumCandidate[] = catalog.albums.map((item) => ({
        groupId: item.groupId,
        groupName: item.groupName,
        albumId: item.albumId,
        albumName: item.albumName,
      }));
      const allowed = new Set(albumTargetValues(candidates));
      // 已经生效的行里的目标一律放行：探测抖动不该让用户连「原样保存」都做不到，
      // 相册改名 / 删除后的旧名字也要能留在表里，由投递期拒绝并提示重新选择。
      for (const row of system.subscriptionTable().rows) {
        for (const target of row.targets) {
          const value = target.trim();
          if (value !== '') allowed.add(value);
        }
      }
      const result = await system.updateSubscriptions(body.rows, allowed, candidates);
      kCtx.type = 'application/json';
      if (!result.ok) {
        kCtx.status = 400;
        kCtx.body = { ok: false, error: result.error };
        return;
      }
      // `unresolved`：这些名字解析不到相册（歧义 / 改名 / 删除），保留在表里但投递期停投，
      // 面板据此提示「请重新选择」。
      kCtx.body = { ok: true, rows: result.rows, unresolved: result.unresolved };
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: `订阅表保存失败：${errorMessage(err)}` };
    }
  });

  // 3. API: 获取单篇词条详情 (融合 Markdown 解析数据)
  router.get(`${cleanBase}/api/entries/:id`, async (kCtx: KoishiKoaContext) => {
    const id = typeof kCtx.params.id === 'string' ? kCtx.params.id.trim() : '';
    const record = id.length > 0 ? await system.localStore.getEntry(id) : undefined;
    if (!record) {
      kCtx.status = 404;
      kCtx.body = { error: 'Entry not found' };
      return;
    }

    kCtx.type = 'application/json';
    kCtx.body = await buildEntryDetail(record);
  });

  // 3a2. 词条长图（管理面导出）。默认脱敏；宿主无 puppeteer 时 503 + 纯文本，绝不返回占位图。
  router.get(`${cleanBase}/api/card/:id`, async (kCtx: KoishiKoaContext) => {
    const id = typeof kCtx.params.id === 'string' ? kCtx.params.id.trim() : '';
    if (id.length === 0) {
      kCtx.status = 400;
      kCtx.type = 'text/plain; charset=utf-8';
      kCtx.body = '词条 id 不能为空';
      return;
    }
    const record = await system.localStore.getEntry(id);
    if (record === undefined) {
      kCtx.status = 404;
      kCtx.type = 'text/plain; charset=utf-8';
      kCtx.body = `馆藏中没有《${id}》这篇记载`;
      return;
    }
    // 与管理面 / 群内投递共用一条出图管线（脱敏 + 素材池 + 序号 + 高度上限）。
    const rendered = await renderEntryCard(ctx, system, id, {
      maskNames: system.getCardSettings().maskNames,
      maxHeight: system.settings('query').cardMaxHeight,
    });
    if (rendered.kind === 'no-puppeteer') {
      kCtx.status = 503;
      kCtx.type = 'text/plain; charset=utf-8';
      kCtx.body = '未启用图片渲染：宿主缺少 puppeteer 服务';
      return;
    }
    if (rendered.kind !== 'image') {
      kCtx.status = 404;
      kCtx.type = 'text/plain; charset=utf-8';
      kCtx.body = `馆藏中没有《${id}》这篇记载`;
      return;
    }
    kCtx.type = 'image/jpeg';
    kCtx.body = rendered.image;
  });

  // 3b. API: 编辑词条（元数据可选字段 + 可选整篇正文），返回与 GET 详情完全一致的载荷
  registerVerb(router, 'put', `${cleanBase}/api/entries/:id`, async (kCtx: KoishiKoaContext) => {
    const id = typeof kCtx.params.id === 'string' ? kCtx.params.id.trim() : '';
    if (id.length === 0) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: '缺少词条 id' };
      return;
    }

    const parsed = parseEntryBody(kCtx.request.body);
    if (!parsed.ok) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: parsed.error };
      return;
    }
    const patch = parsed.patch;

    const record = await system.localStore.getEntry(id);
    if (!record) {
      kCtx.status = 404;
      kCtx.body = { ok: false, error: 'Entry not found' };
      return;
    }

    const updateEntry = readCapability<[string, EntryMetadataPatch], Promise<unknown>>(system.localStore, 'updateEntry');
    const saveEntry = readCapability<[WikiEntry, string | undefined], Promise<unknown>>(system.localStore, 'saveEntry');
    const updateMarkdown = readCapability<
      [string, string, EntryIndexMetadata?],
      Promise<unknown>
    >(system.wikiEngine, 'updateEntryMarkdown');

    const metadata: EntryMetadataPatch = {};
    if (patch.title !== undefined) metadata.title = patch.title;
    if (patch.summary !== undefined) metadata.summary = patch.summary;
    if (patch.status !== undefined) metadata.status = patch.status;
    if (patch.tags !== undefined) metadata.tags = patch.tags;

    // 标题 / 摘要进 `index.md` 单行索引，改了就必须让引擎重写那一行。
    const indexDirty = metadata.title !== undefined || metadata.summary !== undefined;
    const targetPath = resolveEntryPath(system, record, id);

    try {
      // 正文：显式 markdown 一律落盘；只改标题 / 摘要时读回现有正文，仅为触发索引同步。
      let body = patch.markdown;
      if (body === undefined && indexDirty && updateMarkdown && targetPath) {
        body = await fs.readFile(targetPath, 'utf8').catch((): undefined => undefined);
      }
      let bodyWritten = false;
      if (body !== undefined) {
        if (!targetPath) throw new Error('无法定位词条正文路径');
        const markdown = body.endsWith('\n') ? body : `${body}\n`;
        if (updateMarkdown) {
          const indexMeta: EntryIndexMetadata = {};
          if (metadata.title !== undefined) indexMeta.title = metadata.title;
          if (metadata.summary !== undefined) indexMeta.summary = metadata.summary;
          await updateMarkdown(id, markdown, indexDirty ? indexMeta : undefined);
        } else {
          // 旧宿主无此能力：直接覆写正文；index.md 的对应行为引擎所有，绝不在此伪造。
          await fs.mkdir(nodePath.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, markdown, 'utf8');
        }
        bodyWritten = true;
      }

      // 元数据：首次写入正文需回填路径（`updateEntry` 不接 path），此时只能走 `saveEntry`；
      // 其余情况优先 `updateEntry`（空补丁也刷新 updatedAt），宿主缺此能力时退回 `saveEntry`。
      const needsPathPersist = bodyWritten && (record.path === undefined || record.path.length === 0);
      if (needsPathPersist) {
        if (!saveEntry) throw new Error('当前宿主不支持回填词条正文路径');
        await saveEntry(toWikiEntry(record, metadata), targetPath);
      } else if (updateEntry) {
        await updateEntry(id, metadata);
      } else if (Object.keys(metadata).length > 0) {
        if (!saveEntry) throw new Error('当前宿主不支持词条元数据更新');
        await saveEntry(toWikiEntry(record, metadata), record.path);
      }
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: errorMessage(err) };
      return;
    }

    const fresh = await system.localStore.getEntry(id);
    if (!fresh) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: '词条更新后未能回读' };
      return;
    }

    kCtx.type = 'application/json';
    kCtx.body = await buildEntryDetail(fresh);
  });

  // 3c. API: 删除词条（正文 + 原始会话 + 元数据），幂等失败以非 2xx 明示
  registerVerb(router, 'delete', `${cleanBase}/api/entries/:id`, async (kCtx: KoishiKoaContext) => {
    const id = typeof kCtx.params.id === 'string' ? kCtx.params.id.trim() : '';
    if (id.length === 0) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: '缺少词条 id' };
      return;
    }

    const record = await system.localStore.getEntry(id);
    if (!record) {
      kCtx.status = 404;
      kCtx.body = { ok: false, error: 'Entry not found' };
      return;
    }

    try {
      const systemDelete = readCapability<[string], Promise<unknown>>(system, 'deleteEntry');
      if (systemDelete) {
        // 系统层一站式删除：正文 + raw dump + 索引 / 流水行 + 元数据。
        await systemDelete(id);
      } else {
        const engineDelete = readCapability<[string, string?], Promise<unknown>>(system.wikiEngine, 'deleteEntry');
        const storeDelete = readCapability<[string], Promise<unknown>>(system.localStore, 'deleteEntry');
        if (!engineDelete && !storeDelete) throw new Error('当前宿主不支持删除词条');
        if (engineDelete) await engineDelete(id, record.title);
        if (storeDelete) await storeDelete(id);
        // 引擎无删除能力时，元数据已移除，正文文件仍需清掉，避免孤儿词条。
        if (!engineDelete && typeof record.path === 'string' && record.path.length > 0) {
          await fs.rm(record.path, { force: true });
        }
      }
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: errorMessage(err) };
      return;
    }

    kCtx.type = 'application/json';
    kCtx.body = { ok: true, id };
  });

  // 3d. API: 清空知识库（保留目录骨架与群聊节奏校准快照）
  router.post(`${cleanBase}/api/clear`, async (kCtx: KoishiKoaContext) => {
    try {
      const systemClear = readCapability<[], Promise<unknown>>(system, 'clearKnowledgeBase');
      if (systemClear) {
        await systemClear();
      } else {
        const engineClear = readCapability<[], Promise<unknown>>(system.wikiEngine, 'clearAllEntries');
        const storeClear = readCapability<[], Promise<unknown>>(system.localStore, 'clearEntries');
        if (!engineClear && !storeClear) throw new Error('当前宿主不支持清空知识库');
        if (engineClear) await engineClear();
        if (storeClear) await storeClear();
      }
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: errorMessage(err) };
      return;
    }

    kCtx.type = 'application/json';
    kCtx.body = { ok: true, message: '知识库已清空，保留默认骨架' };
  });

  // 3e. API: 手动触发「主题校准」（运维入口；默认 force，忽略日切幂等）
  const runTopicCalibration = async (kCtx: KoishiKoaContext): Promise<void> => {
    const body = kCtx.request.body as { channelId?: unknown; force?: unknown } | undefined;
    const bodyChannel = typeof body?.channelId === 'string' ? body.channelId.trim() : '';
    const queryChannel = typeof kCtx.query.channelId === 'string' ? kCtx.query.channelId.trim() : '';
    const channelId = bodyChannel || queryChannel;
    const force = body?.force !== false;

    const runTopics = readCapability<[string, { force?: boolean }], Promise<unknown>>(system, 'runTopics');
    if (!runTopics) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: '当前宿主不支持主题校准' };
      return;
    }

    try {
      /* 未指定群 = 批量校准：目标群用与定时调度**同一份**判定（`topicTargets`）。
         订阅表生效时只跑订阅来源群——`config.channels` 里残留的旧群与全库群不该被顺手烧一遍模型；
         `features.topics` 总闸也在这里面（关掉时目标为空表）。 */
      const targets = channelId ? [channelId] : await system.topicTargets();
      const results: unknown[] = [];
      for (const target of targets) {
        results.push(await runTopics(target, { force }));
      }
      kCtx.type = 'application/json';
      kCtx.body = { ok: true, force, results };
    } catch (err: unknown) {
      kCtx.status = 500;
      kCtx.body = { ok: false, error: errorMessage(err) };
    }
  };

  router.post(`${cleanBase}/api/topics`, runTopicCalibration);

  // 4. API: 监控指标（含 5 秒粒度真实流量桶，供面板按真实时间轴绘制曲线）
  router.get(`${cleanBase}/api/status`, async (kCtx: KoishiKoaContext) => {
    // 未指定群时取宿主配置的第一个频道；不硬编码任何真实群号。
    const configuredChannels = Array.isArray(system.config?.channels) ? system.config.channels : [];
    const channelId =
      typeof kCtx.query.channelId === 'string' ? kCtx.query.channelId : (configuredChannels[0] ?? '');
    // 纯读：轮询不得推进结算（否则监控页会以 5s 节奏触发交付）。
    const metrics = system.detector.getStatus(channelId, undefined, { settle: false });
    const options = system.detector.getOptions(channelId);
    const dispatcherConfig = dispatcherConfigOf(system);
    const dispatcherModels = dispatcherConfig
      ? resolveDispatcherModels(dispatcherConfig)
      : { chatlunaModel: '', customModel: '' };
    // 素材池遥测：两侧水位（目录实时数）+ 进程内抓取 / 消费 / 回收计数。
    // 失败数是最容易「静默」掉的指标——上游抖动时只剩它在说明补货不顺。
    const [imagePool, sayingPool] = await Promise.all([
      system.media.stats('image'),
      system.media.stats('saying'),
    ]);
    // 合并后的素材段（覆盖层 > config）；测试替身 / 旧宿主只有 config 时回落到它。
    const mediaSettings = typeof system.settings === 'function' ? system.settings('media') : system.config?.media;

    kCtx.type = 'application/json';
    kCtx.body = {
      channelId,
      // 面板底栏只读行：包版本与解析后的知识库根目录（相对路径已按 baseDir 锚定）。
      version: PLUGIN_VERSION,
      wikiDir: system.wikiDir,
      ...metrics,
      traffic: system.getTraffic(channelId),
      sampleMs: TRAFFIC_SAMPLE_MS,
      serverTime: Date.now(),
      options,
      // AIMD 维度：当前生效的三个物理闸门、硬限幅区间、时间衰减底数与上次校准时刻。
      tuning: readTuningSnapshot(system, channelId, options),
      // 只读部署状态：provider / protocol / model 由 Console 管，面板只展示。
      dispatcher: {
        provider: normalizeDispatcherProvider(dispatcherConfig?.provider),
        protocol: system.dispatcher?.protocolId ?? 'responses',
        model: dispatcherModels.chatlunaModel || dispatcherModels.customModel,
      },
      media: {
        image: imagePool,
        saying: sayingPool,
        counters: system.media.metrics,
        offline: mediaSettings?.offline === true,
      },
      topics: system.lastTopicRun,
      // 判据台账落盘健康度：`failed > 0` 或 `lastWriteAt` 停滞 = 三天对照会缺数据。
      observability: readLedgerStats(system),
      // 当前群最新一条被接受消息的只读预览（浏览器就绪副本）；该群尚无被接受消息时为 null。
      latestMessage: toBrowserLatestMessage(system, channelId, cleanBase),
    };
  });

  // 4b. API: 单独拉取流量序列（缺省 60 点，上限 60 点）
  router.get(`${cleanBase}/api/series`, (kCtx: KoishiKoaContext) => {
    // 未指定群时取宿主配置的第一个频道；不硬编码任何真实群号。
    const configuredChannels = Array.isArray(system.config?.channels) ? system.config.channels : [];
    const channelId =
      typeof kCtx.query.channelId === 'string' ? kCtx.query.channelId : (configuredChannels[0] ?? '');
    const rawLimit = typeof kCtx.query.limit === 'string' ? Number.parseInt(kCtx.query.limit, 10) : Number.NaN;
    const limit = Number.isFinite(rawLimit) ? Math.min(TRAFFIC_CAPACITY, Math.max(1, rawLimit)) : TRAFFIC_CAPACITY;
    const payload: TrafficSeries & { limit: number } = {
      channelId,
      limit,
      sampleMs: TRAFFIC_SAMPLE_MS,
      serverTime: Date.now(),
      traffic: system.getTraffic(channelId, limit),
    };

    kCtx.type = 'application/json';
    kCtx.body = payload;
  });

  // 4c. API: 可观测性遥测快照（闸门瞬态向量 / 动量与 RSI / 基线账本 / 事件链 trace）
  //     纯读：只返回 Inspector 的快照，绝不推进状态机；Inspector 未挂载时回基础空结构，
  //     保证测试替身与旧宿主拿到的载荷形状恒定。
  router.get(`${cleanBase}/api/telemetry`, (kCtx: KoishiKoaContext) => {
    let snapshot = createEmptyTelemetrySnapshot();
    try {
      const inspector = system.inspector;
      if (inspector && typeof inspector.getTelemetrySnapshot === 'function') {
        snapshot = inspector.getTelemetrySnapshot();
      }
    } catch {
      snapshot = createEmptyTelemetrySnapshot();
    }

    kCtx.type = 'application/json';
    kCtx.body = snapshot;
  });

  // 4d. API: 同源媒体代理（只服务本缓存消息登记过的 opaqueId）
  //     用途：QQ 媒体源多为 http 或带临时签名，https 页面直连会被混合内容策略拦截；
  //     代理恒定 `nosniff`、只放行媒体类型、逐跳校验重定向、Range 透明（视频可拖动），
  //     且绝不接受任意 URL 参数，也绝不转发浏览器或 bot 的凭据。
  router.get(
    `${cleanBase}/${MEDIA_PROXY_SEGMENT}/:id`,
    createMediaProxyHandler(system.mediaRegistry, { fetch: options.mediaFetch, lookup: options.mediaLookup }),
  );

  // 5. API: 模型路由自检（`?probe=1` 时真实发起一次最小模型调用，用于运维取证）
  //    ChatLuna 模式下 baseURL / apiKey 为 null、false，证明调用完全继承平台凭据。
  router.get(`${cleanBase}/api/self-check`, async (kCtx: KoishiKoaContext) => {
    const dispatcher = system.dispatcher;
    const route = dispatcher.route;
    const payload: Record<string, unknown> = {
      route,
      provider: route,
      configuredModel: (route === 'chatluna' ? dispatcher.model : dispatcher.customModel) || null,
      inheritsChatLunaDefaultModel: !dispatcher.hasExplicitModel,
      usesChatLunaCredentials: route === 'chatluna',
      protocol: route === 'chatluna' ? 'chatluna-adapter' : dispatcher.protocolId,
      apiKeyConfigured: Boolean(system.config.dispatcher.apiKey),
      baseURLUsed: route === 'chatluna' ? null : dispatcher.chatUrl,
    };

    const probeFlag = kCtx.query.probe;
    if (probeFlag === '1' || probeFlag === 'true') {
      payload.probe = await dispatcher.probe();
    }

    kCtx.type = 'application/json';
    kCtx.body = payload;
  });

  // 6. API: 管理员参数微调（AIMD 闸门按物理边界夹紧后下发，并回传新的 tuning 视图）
  router.post(`${cleanBase}/api/tune`, async (kCtx: KoishiKoaContext) => {
    const body = kCtx.request.body as { channelId?: string; options?: Partial<TriggerOptions> } | undefined;
    if (!body || typeof body.channelId !== 'string' || !body.options) {
      kCtx.status = 400;
      kCtx.body = { ok: false, error: 'Invalid payload' };
      return;
    }

    try {
      const { options: tuned, clamped } = clampManualTuning(body.options);
      system.detector.updateOptions(body.channelId, tuned);
      const updated = system.detector.getOptions(body.channelId);
      const persisted = await system.localStore.saveCadenceState({
        channelId: body.channelId,
        options: updated,
        metrics: system.detector.getStatus(body.channelId, undefined, { settle: false }),
        updatedAt: Date.now(),
      });

      // 手动校准同样刷新 AIMD 时间基准：刚设定的门限不会在下一轮被当作陈旧值向锚点衰减。
      if (typeof system.noteCadenceUpdate === 'function') {
        system.noteCadenceUpdate(body.channelId, persisted.updatedAt);
      }

      kCtx.body = {
        ok: true,
        options: updated,
        tuning: readTuningSnapshot(system, body.channelId, updated),
        clamped,
      };
    } catch (err: unknown) {
      // `RangeError` 是宿主对非法取值的输入校验（例如越界数字 / 枚举外参数），
      // 归 400 让面板提示「参数不合法」；其余异常才是服务端故障。
      kCtx.status = err instanceof RangeError ? 400 : 500;
      kCtx.body = { ok: false, error: errorMessage(err) };
    }
  });
}
