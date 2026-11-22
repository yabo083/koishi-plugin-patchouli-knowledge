/**
 * Patchouli Knowledge - 公开只读视图
 *
 * 职责边界：把内部词条（`WikiEntryRecord` + 词条 Markdown）投影成**可对外分发**的
 * 脱敏视图，并把视图渲染成零依赖的自包含 HTML 页面。
 *
 * 铁律：
 *  - 视图绝不携带 `channelId`、`participants`、`userId`、`metadata`，也不携带
 *    `record.path`（宿主机绝对路径）；`sources` 只保留 `raw/sessions/<file>.json`
 *    形态的相对名，其余一律丢弃；
 *  - Markdown 解析**永不抛异常**：结构不符 / 空正文 / 缺失章节时逐字段回退到
 *    `record` 的元数据，最坏情形仍是一份只有标题与摘要的合法视图；
 *  - HTML 自包含：无脚本、无外链字体、无外部资源，所有文本经 `escapeHtml`。
 */

import { plainText } from './plain-text';
import type { WikiEntryRecord } from './storage';

/** 词条内的一句话原话采撷（发言人 + 原话）。 */
export interface PublicQuote {
  speaker: string;
  text: string;
}

/** 公开的观点碰撞矩阵单元（不含发言人名单，避免把群友身份带出馆外）。 */
export interface PublicDebatePoint {
  viewpoint: string;
  proponents: string[];
  opponents: string[];
  arguments: string[];
  counterArguments: string[];
}

/** 公开的主题时间轴条目（与内部 `TopicTimelineItem` 同形，已脱敏）。 */
export interface PublicTimelineItem {
  entryId: string;
  date: string;
  title: string;
  summary: string;
  contribution?: string;
}

/** 对外可分发的最小词条视图（已脱敏）。 */
export interface PublicWikiView {
  id: string;
  title: string;
  date: string;
  status: string;
  tags: string[];
  summary: string;
  background: string;
  /** 「讨论脉络」/「主题综述」章节正文（词条主体叙事），无则该字段缺席。 */
  narrative?: string;
  /** 词条种类：`topic` 为跨时间的长期主题聚合，`debate` 为单轮讨论沉淀。 */
  kind?: 'debate' | 'topic';
  /** 主题时间轴（仅 `kind: 'topic'`）；来自记录字段，缺省时回退解析 Markdown。 */
  timeline?: PublicTimelineItem[];
  /** 名词注：群内黑话 / 专有名词的语境释义（不含身份信息，可安全公开）。 */
  glossary?: Array<{ term: string; note: string }>;
  consensus: string[];
  divergence: string[];
  quotes: PublicQuote[];
  debate?: PublicDebatePoint[];
  /** 仅形如 `raw/sessions/<file>.json` 的相对路径。 */
  sources: string[];
}

/** 原始会话相对路径白名单：只有这个形态允许出现在脱敏视图里。 */
const PUBLIC_SOURCE_PATTERN = /^raw\/sessions\/[A-Za-z0-9._-]+\.json$/u;
/** 词条 id 的文件名安全形态（与路由校验共用）。 */
const SAFE_ENTRY_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/u;
/** llmwiki 渲染的占位文本（`_（无额外背景信息）_` 之类），公开视图里一律视为空。 */
const PLACEHOLDER_PATTERN = /^_?（[^）]*）_?$/u;

/* ------------------------------------------------------------------ *
 * Markdown 解析
 * ------------------------------------------------------------------ */

interface ParsedMarkdown {
  title: string;
  headers: Map<string, string>;
  /** 归一化后的 `## ` 章节名 → 原始行。 */
  sections: Array<{ heading: string; lines: string[] }>;
}

function parseMarkdown(markdown: string): ParsedMarkdown {
  const result: ParsedMarkdown = { title: '', headers: new Map(), sections: [] };
  let current: { heading: string; lines: string[] } | undefined;
  let inHeader = true;

  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (inHeader && current === undefined) {
      const h1 = /^#\s+(.+)$/u.exec(trimmed);
      if (h1 !== null && result.title === '') {
        result.title = cleanInline(h1[1]);
        continue;
      }
      const header = /^([A-Za-z][A-Za-z ]*[A-Za-z])\s*[:：]\s*(.*)$/u.exec(trimmed);
      if (header !== null) {
        result.headers.set(header[1].trim().toLowerCase(), header[2].trim());
        continue;
      }
      if (trimmed === '') continue;
      inHeader = false;
    }

    const h2 = /^##\s+(.+)$/u.exec(trimmed);
    if (h2 !== null) {
      current = { heading: h2[1].trim(), lines: [] };
      result.sections.push(current);
      continue;
    }
    if (current !== undefined) current.lines.push(line);
  }

  return result;
}

function findSection(parsed: ParsedMarkdown, pattern: RegExp): string[] | undefined {
  return parsed.sections.find((section) => pattern.test(section.heading))?.lines;
}

/** 抽取章节里的全部正文段落（空行分段，占位文本丢弃）。 */
function readParagraphs(lines: string[] | undefined): string[] {
  if (lines === undefined) return [];
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = cleanInline(buffer.join(' '));
    if (text !== '' && !PLACEHOLDER_PATTERN.test(text)) paragraphs.push(text);
    buffer = [];
  };
  for (const line of lines) {
    if (line.trim() === '') flush();
    else buffer.push(line.trim());
  }
  flush();
  return paragraphs;
}

/** 抽取章节里的列表项（有序 / 无序统一成纯文本条目）。 */
function readListItems(lines: string[] | undefined): string[] {
  if (lines === undefined) return [];
  const items: string[] = [];
  for (const line of lines) {
    const matched = /^(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(line.trim());
    if (matched === null) continue;
    const text = cleanInline(matched[1]);
    if (text !== '' && !PLACEHOLDER_PATTERN.test(text)) items.push(text);
  }
  return items;
}

/** 抽取 `> **发言人**：原话` 形态的金句，忽略语境补充行。 */
function readQuotes(lines: string[] | undefined): PublicQuote[] {
  if (lines === undefined) return [];
  const quotes: PublicQuote[] = [];
  for (const line of lines) {
    const matched = /^>\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)$/u.exec(line.trim());
    if (matched === null) continue;
    const speaker = cleanInline(matched[1]);
    const text = cleanInline(matched[2]);
    if (speaker === '' || text === '' || PLACEHOLDER_PATTERN.test(text)) continue;
    quotes.push({ speaker, text });
  }
  return quotes;
}

const MATRIX_SUBHEADING = /论据细分|细分/iu;

/**
 * 解析「观点碰撞矩阵」。
 *
 * 现行 `renderEntryMarkdown` 同时输出表格与 `### 论据细分` 小节；以细分为准
 * （表格是同一内容的压缩视图，解析它会得到重复条目）。
 */
function readDebate(lines: string[] | undefined): PublicDebatePoint[] {
  if (lines === undefined) return [];
  const points: PublicDebatePoint[] = [];
  let current: PublicDebatePoint | undefined;
  let section: 'argument' | 'counter' | 'none' = 'none';

  const flush = (): void => {
    if (current !== undefined && (current.viewpoint !== '' || current.arguments.length > 0)) points.push(current);
    current = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^(#{3,6})\s+(.+)$/u.exec(trimmed);
    if (heading !== null) {
      if (MATRIX_SUBHEADING.test(heading[2])) {
        flush();
        section = 'none';
        continue;
      }
      flush();
      current = {
        viewpoint: cleanInline(
          heading[2]
            .replace(/^\d+[.)]\s*/u, '')
            .replace(/^(?:观点|立场|阵营)\s*[一二三四五六七八九十\d]*\s*[:：]\s*/u, ''),
        ),
        proponents: [],
        opponents: [],
        arguments: [],
        counterArguments: [],
      };
      section = 'none';
      continue;
    }
    if (current === undefined) continue;

    const supporters = /^[-*]\s*\*\*(?:提出\/支持者|支持者|提出者|主张者|阵营)\*\*\s*[:：]\s*(.*)$/u.exec(trimmed);
    if (supporters !== null) {
      current.proponents.push(...splitNames(supporters[1]));
      section = 'none';
      continue;
    }
    if (/^[-*]\s*\*\*(?:核心论据|主要论据|论据|论证)\*\*\s*[:：]\s*$/u.test(trimmed)) {
      section = 'argument';
      continue;
    }
    const counter = /^[-*]\s*\*\*(?:质疑\/反驳|反驳\/质疑|反驳|质疑)\*\*\s*(?:\(质疑者\s*[:：]\s*(.*?)\))?\s*[:：]\s*$/u.exec(
      trimmed,
    );
    if (counter !== null) {
      if (counter[1] !== undefined) current.opponents.push(...splitNames(counter[1]));
      section = 'counter';
      continue;
    }
    const bullet = /^\s{2,}[-*]\s+(.+)$/u.exec(line);
    if (bullet === null) continue;
    const body = cleanInline(bullet[1]);
    if (body === '') continue;
    if (section === 'argument') current.arguments.push(body);
    else if (section === 'counter') current.counterArguments.push(body);
  }
  flush();
  return points.filter((point) => point.viewpoint !== '' || point.arguments.length > 0);
}

/** 解析 `## 名词注` 的 `- **术语**：释义` 列表项。 */
function readGlossary(lines: string[] | undefined): Array<{ term: string; note: string }> {
  if (lines === undefined) return [];
  const items: Array<{ term: string; note: string }> = [];
  for (const line of lines) {
    const matched = /^(?:[-*+]|\d+[.)])\s+\*\*(.+?)\*\*\s*[:：]\s*(.+)$/u.exec(line.trim());
    if (matched === null) continue;
    const term = cleanInline(matched[1]);
    const note = cleanInline(matched[2]);
    if (term === '' || note === '' || PLACEHOLDER_PATTERN.test(note)) continue;
    items.push({ term, note });
  }
  return items;
}

/** 把记录里的时间轴投影成公开视图条目（丢弃标题为空的脏项）。 */
function readRecordTimeline(record: WikiEntryRecord): PublicTimelineItem[] {
  const raw = record.timeline;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const items: PublicTimelineItem[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const title = cleanInline(String(item.title ?? ''));
    if (title === '') continue;
    const contribution = cleanInline(String(item.contribution ?? ''));
    const entry: PublicTimelineItem = {
      entryId: cleanInline(String(item.entryId ?? '')),
      date: cleanInline(String(item.date ?? '')),
      title,
      summary: cleanInline(String(item.summary ?? '')) || contribution,
    };
    if (contribution !== '') entry.contribution = contribution;
    items.push(entry);
  }
  return items;
}

/**
 * 解析 `- YYYY-MM-DD 《标题》 — 贡献` 形态的时间轴行。
 *
 * 记录层缺失 `timeline`（旧库 / 直接喂 Markdown）时用它兜底：Markdown 行里没有
 * `entryId`，因此公开视图的外部条目 `entryId` 留空，只保留日期、标题与一句贡献。
 */
function readTimelineLines(lines: string[] | undefined): PublicTimelineItem[] {
  if (lines === undefined) return [];
  const items: PublicTimelineItem[] = [];
  for (const line of lines) {
    const matched = /^(?:[-*+]|\d+[.)])\s+(?:(\d{4}-\d{2}-\d{2})\s*)?《(.+?)》\s*(?:[—–-]\s*(.*))?$/u.exec(
      line.trim(),
    );
    if (matched === null) continue;
    const title = cleanInline(matched[2]);
    if (title === '') continue;
    const rawNote = cleanInline(matched[3] ?? '');
    const note = PLACEHOLDER_PATTERN.test(rawNote) ? '' : rawNote;
    const entry: PublicTimelineItem = {
      entryId: '',
      date: matched[1] ?? '',
      title,
      summary: note,
    };
    if (note !== '') entry.contribution = note;
    items.push(entry);
  }
  return items;
}

function splitNames(raw: string): string[] {
  return raw
    .replace(/\[\[|\]\]/gu, '')
    .split(/[,，、/]/u)
    .map((item) => cleanInline(item))
    .filter((item) => item.length > 0 && item !== '—' && !PLACEHOLDER_PATTERN.test(item));
}

/** 去掉 Markdown 内联标记与 llmwiki 双链括号，折叠空白。 */
function cleanInline(raw: string): string {
  // 先摊平内联数学（`$\rightarrow$` → `→`）：卡片 / 展厅都是纯文本渲染，LaTeX 会原样露出。
  return plainText(raw)
    .replace(/\[\[([^\]]*)\]\]/gu, '$1')
    .replace(/\*\*|__|`/gu, '')
    .replace(/^>\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function readPublicSources(parsed: ParsedMarkdown, entryId: string): string[] {
  const raw = parsed.headers.get('sources') ?? parsed.headers.get('source') ?? '';
  const declared = raw
    .replace(/\[\[|\]\]/gu, '')
    .split(/[,，、\s]+/u)
    .map((item) => item.trim())
    .filter((item) => PUBLIC_SOURCE_PATTERN.test(item));
  if (declared.length > 0) return Array.from(new Set(declared));
  return SAFE_ENTRY_ID_PATTERN.test(entryId) ? [`raw/sessions/${entryId}.json`] : [];
}

/* ------------------------------------------------------------------ *
 * 视图投影
 * ------------------------------------------------------------------ */

function emptyView(record: WikiEntryRecord): PublicWikiView {
  const view: PublicWikiView = {
    id: record.id,
    title: plainText(record.title),
    date: record.date,
    status: String(record.status ?? ''),
    tags: Array.isArray(record.tags) ? record.tags.map(plainText) : [],
    summary: plainText(record.summary ?? ''),
    background: '',
    consensus: [],
    divergence: [],
    quotes: [],
    sources: SAFE_ENTRY_ID_PATTERN.test(record.id) ? [`raw/sessions/${record.id}.json`] : [],
  };
  if (record.kind !== undefined) view.kind = record.kind;
  const timeline = readRecordTimeline(record);
  if (timeline.length > 0) view.timeline = timeline;
  return view;
}

/**
 * 投影为公开视图；`markdown` 缺失或结构不可解析时回退到 `record` 元数据。
 *
 * 该函数**绝不抛异常**：路由层可以无条件调用它。
 */
export function toPublicView(record: WikiEntryRecord, markdown?: string): PublicWikiView {
  const fallback = emptyView(record);
  if (typeof markdown !== 'string' || markdown.trim() === '') return fallback;

  try {
    const parsed = parseMarkdown(markdown);
    const view: PublicWikiView = {
      id: record.id,
      title: parsed.title !== '' ? parsed.title : fallback.title,
      date: parsed.headers.get('date') ?? fallback.date,
      status: parsed.headers.get('status') ?? fallback.status,
      tags: parseTags(parsed.headers.get('tags'), fallback.tags),
      summary: readParagraphs(findSection(parsed, /摘要/u))[0] ?? fallback.summary,
      background: readParagraphs(findSection(parsed, /背景/u)).join('\n\n'),
      consensus: readListItems(findSection(parsed, /共识/u)),
      divergence: readListItems(findSection(parsed, /分歧|开放/u)),
      quotes: readQuotes(findSection(parsed, /金句|原话|言论/u)),
      debate: readDebate(findSection(parsed, /碰撞|矩阵|观点矩阵/u)),
      sources: readPublicSources(parsed, record.id),
    };

    const kind = record.kind ?? parsedKind(parsed.headers.get('kind'));
    if (kind !== undefined) view.kind = kind;
    const narrative = readParagraphs(findSection(parsed, /讨论脉络|主题综述/u)).join('\n\n');
    if (narrative !== '') view.narrative = narrative;
    /* 时间轴以记录字段为准（带 entryId）；旧库 / 纯 Markdown 输入回退解析 `## 时间轴`。 */
    const recordTimeline = readRecordTimeline(record);
    const timeline = recordTimeline.length > 0 ? recordTimeline : readTimelineLines(findSection(parsed, /时间轴/u));
    if (timeline.length > 0) view.timeline = timeline;
    const glossary = readGlossary(findSection(parsed, /名词注/u));
    if (glossary.length > 0) view.glossary = glossary;
    if (view.summary.trim() === '') view.summary = fallback.summary;
    if (view.debate !== undefined && view.debate.length === 0) delete view.debate;
    return view;
  } catch {
    return fallback;
  }
}

function parsedKind(raw: string | undefined): PublicWikiView['kind'] {
  const value = raw?.trim().toLowerCase();
  return value === 'debate' || value === 'topic' ? value : undefined;
}

function parseTags(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  const tags = raw
    .replace(/\[\[|\]\]/gu, '')
    .split(/[,，、]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !PLACEHOLDER_PATTERN.test(item));
  return tags.length > 0 ? tags : fallback;
}

/* ------------------------------------------------------------------ *
 * HTML 渲染
 * ------------------------------------------------------------------ */

/** HTML 文本转义（标题、正文、标签一律经此出站）。 */
export function escapeHtml(raw: string): string {
  return String(raw)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}
