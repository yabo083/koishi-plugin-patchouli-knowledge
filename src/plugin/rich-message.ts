/**
 * 富消息元素解析（后端只读，绝不发送任何消息）。
 *
 * 输入优先级：
 *   1. 原始 OneBot 消息段（`session.event._data.message`，段数组或 CQ 码字符串）——字段最全；
 *   2. Koishi 已解析元素（`session.elements`）；
 *   3. `h.parse(session.content)`（Koishi 文本 markup）。
 * 引用（`session.quote`）因 `Session.content` 会剥掉 quote 元素，必须由调用方单独传入。
 *
 * 元素类型与字段语义对齐 `koishi-plugin-onebot-webqq`（MIT, Copyright (c) 2026 Sor85）
 * 的 `normalizeSegment` / `normalizeLiveElement` / `normalizeCardElement` /
 * `resolveOneBotForward` / `resolveOneBotQuote` 归一化约定；本模块按本插件契约重新实现，
 * 未复制其源码，也不依赖该包（只读 action 走真实 Koishi OneBot 适配器的 `bot.internal`）。
 *
 * 安全红线：
 *   - 只读：仅调用 `get_msg` / `get_forward_msg` / `get_image` 三个只读 action，绝不 send；
 *   - 媒体地址只允许公网 http(s)（拒绝 javascript/data/file/本地路径/私网/端口/凭据）；
 *   - 绝不把 OneBot 原始 segment、`raw`、`userId`、凭据写进元素或日志（日志中的 URL 一律脱敏）。
 *
 * 体积与 IO 上限（全部明示截断，绝不静默截断/假成功）：
 *   - 元素上限 `RICH_MESSAGE_MAX_ELEMENTS` 在**每一次遍历**（顶层、转发条目内、引用正文）都先切片再解析，
 *     绝不先完整遍历再事后裁剪；单元素文本 ≤ `RICH_ELEMENT_TEXT_MAX_CHARS`；
 *   - 合并转发每层 ≤ `RICH_FORWARD_MAX_NODES` 个节点、跨层总数 ≤ `RICH_FORWARD_MAX_TOTAL_ITEMS`、
 *     递归深度 ≤ `RICH_FORWARD_MAX_DEPTH`；
 *   - 单条消息的只读 action 总次数 ≤ `RICH_RESOLVE_MAX_ACTIONS`（防深嵌套转发把 IO 放大）。
 *
 * 媒体字段按用途区分（`MEDIA_FIELDS_BY_TYPE`）：
 *   - 子资源字段（image/video 的 `url`、video/card 的 `imageUrl`、face 的 `emojiUrl`、record 的 `url`）
 *     才参与「同源代理改写」与登记表登记；
 *   - 导航字段（`card.url` 网页跳转、`file.url` 下载）保留 `sanitizeMediaUrl` 校验后的**原始安全直链**，
 *     绝不改写成媒体代理地址——否则点击普通网页会被代理以非媒体类型拒绝。
 */

import { isIP } from 'node:net';
import { h } from 'koishi';
import type { RichForwardItem, RichMessageElement, RichMessageElementType } from '../types';
import {
  LATEST_MESSAGE_MAX_CHARS,
  RICH_ELEMENT_TEXT_MAX_CHARS,
  RICH_FORWARD_MAX_DEPTH,
  RICH_FORWARD_MAX_NODES,
  RICH_FORWARD_MAX_TOTAL_ITEMS,
  RICH_MESSAGE_MAX_ELEMENTS,
  RICH_RESOLVE_MAX_ACTIONS,
  RICH_RESOLVE_TIMEOUT_MS,
} from '../types';

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

export function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按候选键取首个非空值（空字符串 / null / undefined 视为缺失）。 */
function pick(value: unknown, keys: readonly string[]): unknown {
  if (!isDict(value)) return undefined;
  for (const key of keys) {
    const found = value[key];
    if (found === undefined || found === null || found === '') continue;
    return found;
  }
  return undefined;
}

function pickString(value: unknown, keys: readonly string[]): string {
  const found = pick(value, keys);
  if (typeof found === 'string') return found.trim();
  if (typeof found === 'number' && Number.isFinite(found)) return String(found);
  return '';
}

function pickNumber(value: unknown, keys: readonly string[]): number | undefined {
  const found = pick(value, keys);
  const num =
    typeof found === 'number' ? found : typeof found === 'string' ? Number.parseFloat(found) : Number.NaN;
  return Number.isFinite(num) ? num : undefined;
}

/** 按码点截断，超长以 `…` 收尾（保证结果不超过 limit）。 */
function clampText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return Array.from(value).slice(0, Math.max(1, limit - 1)).join('') + '…';
}

/** 日志脱敏：抹掉任何 http(s) 链接（可能带 rkey 之类的临时凭据）。 */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/giu, '[url]');
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactUrls(message);
}

const SEGMENT_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#91': '[',
  '#93': ']',
};

/** CQ 码 / Koishi markup 的实体反转义（`&#91;` 等）。 */
function decodeSegmentText(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(amp|lt|gt|quot|apos|#39|#91|#93);/giu, (match, name: string) => SEGMENT_ENTITIES[name] ?? match);
}

/* ------------------------------------------------------------------ *
 * 媒体地址安全（后端与代理共用同一条判定）
 * ------------------------------------------------------------------ */

const HTTP_URL = /^https?:\/\//iu;
const FOREIGN_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const WINDOWS_PATH = /^[a-z]:[\\/]/iu;
const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', '0.0.0.0', '::', '::1']);
const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

function readIPv4Parts(hostname: string): number[] | undefined {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4) return undefined;
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined;
}

function isPrivateIPv4(hostname: string): boolean {
  const parts = readIPv4Parts(hostname);
  if (!parts) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** 归一化主机名字面量：去方括号（IPv6 URL 形态）、去尾部根点、统一小写。 */
function normalizeHostLiteral(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/u, '$1').replace(/\.$/u, '');
}

/** IPv6 十六进制段：1~4 位（输入已归一化为小写）。 */
const HEXTET_PATTERN = /^[0-9a-f]{1,4}$/u;

/**
 * 把 IPv6 字面量解析成固定的 8 个 16 位段：
 *   - `::` 展开为若干 `0` 段（必须补足 8 段）；
 *   - 内嵌 IPv4 尾段（`::ffff:8.8.8.8`）折成两个 16 位段；
 *   - 全展开（`0:0:0:0:0:ffff:7f00:1`）与大小写混写同等对待。
 * 非法写法返回 `undefined`（调用方据此保守拒绝）。
 */
function readIPv6Hextets(host: string): number[] | undefined {
  let text = host;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (dotted) {
    const v4 = readIPv4Parts(dotted[1]);
    if (!v4) return undefined;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, text.length - dotted[1].length)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const compressed = halves.length === 2;
  // 带 `::` 时至少省略 1 段；不带 `::` 时必须正好 8 段
  if (compressed ? head.length + tail.length > 7 : head.length !== 8) return undefined;
  const missing = compressed ? 8 - head.length - tail.length : 0;
  // `::` 处补 `missing` 个 0 段，一次遍历校验 + 转换
  const ordered = compressed ? [...head, ...new Array<string>(missing).fill('0'), ...tail] : head;
  const hextets: number[] = [];
  for (const part of ordered) {
    if (!HEXTET_PATTERN.test(part)) return undefined;
    hextets.push(Number.parseInt(part, 16));
  }
  return hextets;
}

/**
 * IPv4 映射前缀 `::ffff:0:0/96` 的判定：前 5 段为 0、第 6 段为 `0xffff`。
 * 命中时把最后两个 16 位段拼成 32 位并按 IPv4 点分形式返回（`::ffff:7f00:1` → `127.0.0.1`）。
 */
function readMappedIPv4(hextets: readonly number[]): string | undefined {
  for (let i = 0; i < 5; i += 1) if (hextets[i] !== 0) return undefined;
  if (hextets[5] !== 0xffff) return undefined;
  const high = hextets[6];
  const low = hextets[7];
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * IPv6 字面量是否为 IPv4 映射形式（`::ffff:0:0/96`）：`::ffff:7f00:1`、
 * 全展开 `0:0:0:0:0:ffff:7f00:1`、点分 `::ffff:8.8.8.8`、任意大小写皆算。
 * 与内嵌 IPv4 等价，而正规媒体源绝不会使用这种写法——媒体代理的字面量直通分支
 * 据此**整体**拒绝映射形式（见 `resolvePublicAddress`），绝不交给 pinnedLookup。
 */
export function isIPv4MappedIPv6(hostname: string): boolean {
  const host = normalizeHostLiteral(hostname);
  if (isIP(host) !== 6) return false;
  const hextets = readIPv6Hextets(host);
  return hextets !== undefined && readMappedIPv4(hextets) !== undefined;
}

function isPrivateIPv6(host: string): boolean {
  const hextets = readIPv6Hextets(host);
  // 解析不出合法 IPv6：保守视为不可公开访问（调用方已用 isIP 确认过类型，正常不会走到这里）
  if (!hextets) return true;
  // IPv4 映射形式：拼回 32 位后按 IPv4 规则判私网 / 本机 / 保留段
  // （`::ffff:7f00:1` → 127.0.0.1、`::ffff:a9fe:a9fe` → 169.254.169.254、`::ffff:c0a8:101` → 192.168.1.1）；
  // 内嵌公网 IPv4 的映射写法由媒体代理的字面量直通分支统一拒绝（`isIPv4MappedIPv6`）。
  const mapped = readMappedIPv4(hextets);
  if (mapped !== undefined) return isPrivateIPv4(mapped);
  const first = hextets[0];
  return first === 0 || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** 私网 / 本机 / 内网单标签主机名判定（含 `.local` / `.internal` 等保留后缀）。 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = normalizeHostLiteral(hostname);
  if (!host) return true;
  if (LOCAL_HOSTNAMES.has(host)) return true;
  if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const version = isIP(host);
  if (version === 4) return isPrivateIPv4(host);
  if (version === 6) return isPrivateIPv6(host);
  // 单标签主机名（内网机器名）不可公开访问
  if (!host.includes('.')) return true;
  return false;
}

/**
 * 媒体地址白名单校验：仅放行**公网 http(s)**。
 * 拒绝 `javascript:` / `data:` / `file:` / `blob:` 等 scheme、本地路径与相对路径、
 * 带凭据（userinfo）的 URL、非 80/443 端口，以及私网 / localhost / 内网主机名。
 * 通过校验的地址返回规范化后的字符串，否则返回 `undefined`。
 */
export function sanitizeMediaUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value || value.length > 4096) return undefined;
  if (WINDOWS_PATH.test(value)) return undefined;
  if (FOREIGN_SCHEME.test(value) && !HTTP_URL.test(value)) return undefined;
  if (!HTTP_URL.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (url.port && url.port !== '80' && url.port !== '443') return undefined;
  if (isPrivateOrLocalHost(url.hostname)) return undefined;
  return url.toString();
}

/** 该媒体地址是否必须经同源代理：http 源在 https 页面会被混合内容策略拦截。 */
export function isProxyRequiredMediaUrl(url: string): boolean {
  const safe = sanitizeMediaUrl(url);
  return !!safe && safe.startsWith('http://');
}

/** 参与「子资源加载」的媒体字段名。 */
type RichMediaField = 'url' | 'imageUrl' | 'emojiUrl';

/**
 * 每个元素类型中**作为子资源加载**的字段（浏览器按 `<img>/<video>/<audio>` 之类直接取字节）。
 * 只有这些字段才需要「能直链就直链、否则同源代理」以及登记进代理登记表。
 * 导航类字段（`card.url` 网页跳转、`file.url` 下载）刻意不在表中：它们是用户点击后导航的普通 URL，
 * 一旦改写成媒体代理地址，点击普通 HTML 网页会被代理以非媒体类型拒绝（415）。
 * 表外类型（防御性）一律视为无媒体字段。
 */
const MEDIA_FIELDS_BY_TYPE: Record<RichMessageElementType, readonly RichMediaField[]> = {
  text: [],
  image: ['url'],
  quote: [],
  forward: [],
  card: ['imageUrl'],
  face: ['emojiUrl'],
  file: [],
  record: ['url'],
  video: ['url', 'imageUrl'],
  unknown: [],
};

/** 递归收集元素（含 forward 节点）中的全部**子资源**媒体地址（去重、已通过安全校验）。 */
export function collectMediaUrls(elements: readonly RichMessageElement[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const visit = (list: readonly RichMessageElement[]): void => {
    for (const element of list) {
      for (const field of MEDIA_FIELDS_BY_TYPE[element.type] ?? []) {
        const safe = sanitizeMediaUrl(element[field]);
        if (safe && !seen.has(safe)) {
          seen.add(safe);
          urls.push(safe);
        }
      }
      if (element.items) for (const item of element.items) visit(item.elements);
    }
  };
  visit(elements);
  return urls;
}

/**
 * 深拷贝元素树并把**子资源媒体字段**交给 `map` 重写（返回 `undefined` 即删除该字段）；
 * 导航字段（`card.url` / `file.url`）原样保留。
 * 只读用途：绝不修改传入的元素（缓存中的元素视为不可变）。
 */
export function mapElementMediaUrls(
  elements: readonly RichMessageElement[],
  map: (url: string) => string | undefined,
): RichMessageElement[] {
  return elements.map((element) => {
    const next: RichMessageElement = { ...element };
    for (const field of MEDIA_FIELDS_BY_TYPE[element.type] ?? []) {
      const value = element[field];
      if (typeof value !== 'string') continue;
      const mapped = map(value);
      if (mapped === undefined) delete next[field];
      else next[field] = mapped;
    }
    if (element.items) {
      next.items = element.items.map((item) => ({
        ...(item.title ? { title: item.title } : {}),
        elements: mapElementMediaUrls(item.elements, map),
      }));
    }
    return next;
  });
}

/* ------------------------------------------------------------------ *
 * 对外契约
 * ------------------------------------------------------------------ */

/** 富消息解析输入：全部来自原始 session；仅内存解析，绝不落盘、绝不进日志。 */
export interface RichMessageContext {
  /** OneBot 只读通道：原样传 `session.bot.internal`（只读 action 白名单见模块头注释）。 */
  onebot?: unknown;
  /** 原始 OneBot 消息段：`session.event._data.message`（段数组或 CQ 码字符串）。 */
  rawMessage?: unknown;
  /** Koishi 已解析元素：`session.elements`。 */
  elements?: unknown;
  /** 引用回复：`session.quote`（`Session.content` 会剥掉 quote，必须单独传）。 */
  quote?: unknown;
  /** Koishi 文本 markup（`session.content`）：仅当前两类输入都缺失时作为最后兜底。 */
  content?: string;
}

export interface RichParseOptions {
  /** 元素上限：顶层与每个嵌套层级各自生效（默认 `RICH_MESSAGE_MAX_ELEMENTS`）。 */
  maxElements?: number;
  /** 单次合并转发每层节点上限（默认 `RICH_FORWARD_MAX_NODES`）。 */
  maxForwardNodes?: number;
  /** 单条消息所有层级的转发节点总数上限（默认 `RICH_FORWARD_MAX_TOTAL_ITEMS`）。 */
  maxForwardItems?: number;
  /** 递归展开深度上限（默认 `RICH_FORWARD_MAX_DEPTH`）。 */
  maxForwardDepth?: number;
  /** 单个元素文本上限（默认 `RICH_ELEMENT_TEXT_MAX_CHARS`）。 */
  textLimit?: number;
  /** 单个只读 action 超时（默认 `RICH_RESOLVE_TIMEOUT_MS`）。 */
  timeoutMs?: number;
  /** 单条消息允许发起的只读 action 总次数（默认 `RICH_RESOLVE_MAX_ACTIONS`）。 */
  maxResolves?: number;
  /** 诊断日志（warn 级别，内容已脱敏；绝不打印原始消息体）。 */
  warn?: (message: string) => void;
}

interface ResolvedOptions {
  maxElements: number;
  maxForwardNodes: number;
  maxForwardItems: number;
  maxForwardDepth: number;
  textLimit: number;
  timeoutMs: number;
  maxResolves: number;
  warn?: (message: string) => void;
}

interface RichResolvers {
  /** 图片 `file` → 公网 URL（只读 `get_image`）。 */
  image?: (file: string) => Promise<string | undefined>;
  /** 引用消息 ID → quote 元素（只读 `get_msg`）；`depth` 为该引用所处的嵌套深度。 */
  quote?: (id: string, depth: number) => Promise<RichMessageElement | undefined>;
  /** 合并转发 ID → 节点列表（只读 `get_forward_msg`）。 */
  forward?: (id: string, depth: number) => Promise<RichForwardItem[] | undefined>;
}

function resolveOptions(options: RichParseOptions): ResolvedOptions {
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  return {
    maxElements: positive(options.maxElements, RICH_MESSAGE_MAX_ELEMENTS),
    maxForwardNodes: positive(options.maxForwardNodes, RICH_FORWARD_MAX_NODES),
    maxForwardItems: positive(options.maxForwardItems, RICH_FORWARD_MAX_TOTAL_ITEMS),
    maxForwardDepth: positive(options.maxForwardDepth, RICH_FORWARD_MAX_DEPTH),
    textLimit: positive(options.textLimit, RICH_ELEMENT_TEXT_MAX_CHARS),
    timeoutMs: positive(options.timeoutMs, RICH_RESOLVE_TIMEOUT_MS),
    maxResolves: positive(options.maxResolves, RICH_RESOLVE_MAX_ACTIONS),
    warn: options.warn,
  };
}

/** 富解析彻底失败时的纯文本兜底元素（恒为非空数组）。 */
export function textFallbackElements(content: string): RichMessageElement[] {
  const text = typeof content === 'string' ? content.trim() : '';
  return text ? [{ type: 'text', text: clampText(text, LATEST_MESSAGE_MAX_CHARS) }] : [{ type: 'unknown', text: '[消息]' }];
}

/** 元素 → 单行纯文本摘要（用于引用正文、转发节点摘要与 content 兜底）。 */
export function summarizeRichElements(elements: readonly RichMessageElement[]): string {
  const parts: string[] = [];
  for (const element of elements) {
    switch (element.type) {
      case 'text':
        if (element.text) parts.push(element.text);
        break;
      case 'quote':
        break;
      case 'image':
        parts.push(element.text || '[图片]');
        break;
      case 'forward':
        parts.push(element.text || '[合并转发]');
        break;
      case 'card':
        parts.push(element.title && element.title !== '卡片消息' ? element.title : element.text || '[卡片消息]');
        break;
      default:
        parts.push(element.text || '[消息]');
        break;
    }
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * OneBot 只读通道（真实适配器 / 测试假对象均支持）
 * ------------------------------------------------------------------ */

type ActionInvoker = (action: string, params: Dict) => Promise<unknown>;

/** 允许的只读 action 白名单（绝不包含任何 send / set / delete 类写操作）。 */
const READONLY_ACTIONS: readonly string[] = ['get_msg', 'get_forward_msg', 'get_image'];
const READONLY_ACTION_SET = new Set(READONLY_ACTIONS);

function readFunction(source: Dict, name: string): ((...args: unknown[]) => unknown) | undefined {
  const candidate = source[name];
  return typeof candidate === 'function' ? (candidate as (...args: unknown[]) => unknown).bind(source) : undefined;
}

/**
 * 构造只读 action 调用器。只要通道能提供**任意一个**白名单动作即可用（缺哪个 action 就在调用时明确报错），
 * 优先级：
 *   1. 真实 Koishi OneBot 适配器的 `internal._get(action, params)`（已解包 `data`，参数名正确）；
 *   2. 假对象上的 `get_msg` / `get_forward_msg` / `get_image`（位置参数，供测试注入）；
 *   3. `internal._request(action, params)`（校验 `retcode` 并解包 `data`）；
 *   4. 适配器的 `getMsg` / `getForwardMsg` / `getImage` 便捷方法。
 * 任何不在 `READONLY_ACTIONS` 内的 action 一律直接拒绝。
 */
export function createOneBotInvoker(onebot: unknown): ActionInvoker | undefined {
  if (!isDict(onebot)) return undefined;
  const source = onebot as Dict;
  const get = readFunction(source, '_get');
  const request = readFunction(source, '_request');
  const snake: Record<string, ((...args: unknown[]) => unknown) | undefined> = {};
  const camel: Record<string, ((...args: unknown[]) => unknown) | undefined> = {};
  for (const action of READONLY_ACTIONS) {
    snake[action] = readFunction(source, action);
    camel[action] = readFunction(source, action.replace(/_(.)/gu, (_, letter: string) => letter.toUpperCase()));
  }
  const hasChannel = !!get || !!request || READONLY_ACTIONS.some((action) => !!snake[action] || !!camel[action]);
  if (!hasChannel) return undefined;

  return async (action, params) => {
    if (!READONLY_ACTION_SET.has(action)) throw new Error(`只读通道拒绝执行 ${action}`);
    if (get) return await get(action, params);
    const positional = snake[action];
    if (positional) {
      if (action === 'get_msg') return await positional(params.message_id);
      if (action === 'get_forward_msg') return await positional(params.id ?? params.message_id);
      return await positional(params.file);
    }
    if (request) {
      const result = await request(action, params);
      const retcode = isDict(result) ? pickNumber(result, ['retcode', 'status']) : undefined;
      if (retcode !== undefined && retcode !== 0) throw new Error(`OneBot ${action} 返回 retcode=${retcode}`);
      return isDict(result) && 'data' in result ? result.data : result;
    }
    const fallback = camel[action];
    if (!fallback) throw new Error(`只读通道不支持 ${action}`);
    if (action === 'get_msg') return await fallback(params.message_id);
    if (action === 'get_forward_msg') return await fallback(params.id ?? params.message_id);
    return await fallback(params.file);
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`只读解析超时（${ms} ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 节点归一化
 * ------------------------------------------------------------------ */

interface RichNode {
  type: string;
  data: Dict;
  children: unknown[];
}

/** 把「原始 OneBot 段」与「Koishi 元素」统一成 `{ type, data, children }`。 */
function readNode(raw: unknown): RichNode | undefined {
  if (typeof raw === 'string') return { type: 'text', data: { content: raw }, children: [] };
  if (!isDict(raw)) return undefined;
  const type = (pickString(raw, ['type', 'tag']) || '').toLowerCase();
  if (!type) return undefined;
  const attrs = isDict(raw.attrs) ? raw.attrs : {};
  const data = isDict(raw.data) ? { ...attrs, ...raw.data } : attrs;
  const children = Array.isArray(raw.children) ? raw.children : [];
  return { type, data, children };
}

/** markup 字符串交给 `h.parse` 前的字符上限：远高于正常消息，只挡畸形超长载荷。 */
const MAX_MARKUP_CHARS = 100_000;

/** 段列表：数组原样（空数组视为无输入）；CQ 码 / Koishi markup 字符串交给 `h.parse`。 */
function readSegmentList(source: unknown): unknown[] | undefined {
  if (Array.isArray(source)) return source.length > 0 ? source : undefined;
  if (typeof source === 'string' && source.trim()) {
    try {
      // 数组路径可以「先切片再遍历」，字符串路径没有这个奢侈：`h.parse` 会整串构造元素树
      // （实测 10MB markup → 647ms / +75MB，随后才被裁到 60 段）。这里先按字符上限截断。
      const bounded = source.length <= MAX_MARKUP_CHARS ? source : source.slice(0, MAX_MARKUP_CHARS);
      const parsed = h.parse(bounded);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // 非法 markup：交给上层兜底
    }
  }
  return undefined;
}

/**
 * 归一化一段元素列表。
 *
 * **先切片再遍历**：`limit` 个元素之外的部分根本不进入解析（不产生任何工作），
 * 超额时在末尾追加一条可见的截断提示。这保证任何层级的输入（含 1000 段的转发条目）
 * 都不会被完整遍历后再生效上限。
 */
async function normalizeNodes(
  list: readonly unknown[],
  resolvers: RichResolvers,
  depth: number,
  opts: ResolvedOptions,
  limit: number = opts.maxElements,
): Promise<RichMessageElement[]> {
  const sliceLimit = Math.max(1, Math.trunc(limit));
  const accepted = list.length > sliceLimit ? list.slice(0, sliceLimit - 1) : list;
  const elements: RichMessageElement[] = [];
  for (const raw of accepted) {
    const node = readNode(raw);
    if (!node) continue;
    const element = await normalizeNode(node, resolvers, depth, opts);
    if (element) elements.push(element);
  }
  if (accepted.length < list.length) {
    elements.push({ type: 'text', text: `…（已截断，共 ${list.length} 段元素）` });
  }
  return elements;
}

async function safeResolve<T>(
  label: string,
  opts: ResolvedOptions,
  task: () => Promise<T | undefined>,
): Promise<T | undefined> {
  try {
    return await task();
  } catch (error) {
    opts.warn?.(`富消息${label}解析失败: ${describeError(error)}`);
    return undefined;
  }
}

async function normalizeNode(
  node: RichNode,
  resolvers: RichResolvers,
  depth: number,
  opts: ResolvedOptions,
): Promise<RichMessageElement | undefined> {
  const { data } = node;
  switch (node.type) {
    case 'text': {
      const text = decodeSegmentText(pickString(data, ['content', 'text']));
      return text ? { type: 'text', text: clampText(text, opts.textLimit) } : undefined;
    }
    case 'at': {
      const name = pickString(data, ['name', 'nickname', 'card', 'text']);
      const qq = pickString(data, ['id', 'qq', 'user_id', 'uin']);
      const kind = pickString(data, ['type', 'sub_type']);
      if (name) return { type: 'text', text: `@${name}` };
      if (kind === 'all' || qq === 'all') return { type: 'text', text: '@全体成员' };
      if (kind === 'here') return { type: 'text', text: '@在线成员' };
      // 只有 QQ 号时不暴露 userId
      return { type: 'text', text: '@成员' };
    }
    case 'sharp': {
      const id = pickString(data, ['id', 'channel_id']);
      return id ? { type: 'text', text: `#${id}` } : undefined;
    }
    case 'face':
      return normalizeFace(node);
    case 'mface': {
      if (pickString(data, ['src', 'url', 'file', 'file_id'])) return await normalizeImage(node, resolvers, opts);
      return normalizeFace(node);
    }
    case 'img':
    case 'image':
    case 'cardimage':
      return await normalizeImage(node, resolvers, opts);
    case 'audio':
    case 'record':
    case 'voice':
      return normalizeRecord(node);
    case 'video':
      return normalizeVideo(node);
    case 'file':
      return normalizeFile(node);
    case 'reply':
    case 'quote':
      return await normalizeQuote(node, resolvers, depth, opts);
    case 'forward':
    case 'node':
    case 'message':
      return await normalizeForward(node, resolvers, depth, opts);
    case 'json':
    case 'xml':
    case 'lightapp':
      return await normalizeStructured(node, resolvers, depth, opts);
    case 'share':
      return normalizeShare(node);
    case 'music':
      return normalizeMusic(node);
    case 'location':
      return normalizeLocation(node);
    case 'contact':
      return normalizeContact(node);
    case 'dice':
    case 'rps':
      return normalizeGame(node);
    case 'poke': {
      const target = pickString(data, ['name', 'nickname']);
      return { type: 'text', text: target ? `[戳一戳 ${target}]` : '[戳一戳]' };
    }
    case 'tts': {
      const spoken = decodeSegmentText(pickString(data, ['text', 'content']));
      return { type: 'record', text: spoken ? `[语音] ${clampText(spoken, opts.textLimit)}` : '[语音]' };
    }
    case 'markdown': {
      const content = decodeSegmentText(pickString(data, ['content', 'text']));
      return { type: 'text', text: content ? clampText(content, opts.textLimit) : '[消息]' };
    }
    case 'gift':
      return { type: 'card', title: '[礼物]', text: pickString(data, ['name', 'title']) || '[礼物]', source: 'gift' };
    default: {
      if (node.children.length > 0) {
        const nested = await normalizeNodes(node.children, resolvers, depth, opts);
        if (nested.length === 1) return nested[0];
        const text = summarizeRichElements(nested);
        if (text) return { type: 'text', text: clampText(text, opts.textLimit) };
      }
      return { type: 'unknown', text: '[消息]' };
    }
  }
}

function faceChildUrl(node: RichNode): string | undefined {
  for (const child of node.children) {
    const nested = readNode(child);
    if (!nested) continue;
    if (nested.type !== 'img' && nested.type !== 'image') continue;
    const url = sanitizeMediaUrl(pick(nested.data, ['src', 'url']));
    if (url) return url;
  }
  return undefined;
}

function normalizeFace(node: RichNode): RichMessageElement {
  const { data } = node;
  const name = pickString(data, ['summary', 'name', 'text']);
  const emojiUrl =
    sanitizeMediaUrl(pick(data, ['emoji_url', 'emojiUrl', 'url', 'src'])) ?? faceChildUrl(node);
  const text = name ? `[表情 ${name}]` : '[表情]';
  return { type: 'face', text, ...(emojiUrl ? { emojiUrl } : {}) };
}

async function normalizeImage(
  node: RichNode,
  resolvers: RichResolvers,
  opts: ResolvedOptions,
): Promise<RichMessageElement> {
  const { data } = node;
  const rawSource = pickString(data, ['src', 'url', 'origin_url', 'originUrl']);
  const direct = sanitizeMediaUrl(rawSource);
  if (direct) return { type: 'image', text: '[图片]', url: direct };
  if (rawSource && HTTP_URL.test(rawSource)) return { type: 'image', text: '[图片]（地址不可用）' };

  const file = pickString(data, ['file', 'file_id', 'fileId', 'path']);
  const resolveImage = resolvers.image;
  if (file && resolveImage) {
    const resolved = await safeResolve('图片', opts, () => resolveImage(file));
    if (resolved) return { type: 'image', text: '[图片]', url: resolved };
    return { type: 'image', text: '[图片]（解析失败）' };
  }
  return { type: 'image', text: '[图片]' };
}

function normalizeRecord(node: RichNode): RichMessageElement {
  const { data } = node;
  const duration = pickNumber(data, ['duration', 'time', 'seconds']);
  const url = sanitizeMediaUrl(pick(data, ['src', 'url']));
  const base: RichMessageElement = { type: 'record', text: '[语音]' };
  if (duration !== undefined) base.duration = Math.max(0, Math.round(duration));
  if (url) base.url = url;
  return base;
}

function normalizeVideo(node: RichNode): RichMessageElement {
  const { data } = node;
  const url = sanitizeMediaUrl(pick(data, ['src', 'url', 'origin_url', 'originUrl']));
  const cover = sanitizeMediaUrl(pick(data, ['cover', 'cover_url', 'coverUrl', 'thumb', 'thumbnail', 'image']));
  const element: RichMessageElement = { type: 'video', text: '[视频]' };
  if (url) element.url = url;
  if (cover) element.imageUrl = cover;
  const duration = pickNumber(data, ['duration', 'time', 'seconds']);
  if (duration !== undefined) element.duration = Math.max(0, Math.round(duration));
  return element;
}

function normalizeFile(node: RichNode): RichMessageElement {
  const { data } = node;
  const name = pickString(data, ['name', 'file_name', 'fileName', 'filename', 'summary']);
  const url = sanitizeMediaUrl(pick(data, ['url', 'src']));
  const element: RichMessageElement = { type: 'file', text: name ? `[文件] ${name}` : '[文件]' };
  if (url) element.url = url;
  return element;
}

async function normalizeQuote(
  node: RichNode,
  resolvers: RichResolvers,
  depth: number,
  opts: ResolvedOptions,
): Promise<RichMessageElement> {
  const { data } = node;
  const targetId = pickString(data, ['id', 'message_id', 'messageId', 'target']);
  const title = pickString(data, ['name', 'nickname', 'card', 'senderName', 'sender_name']);
  const inline = decodeSegmentText(pickString(data, ['content', 'text', 'sourceMsgText', 'summary']));
  const children = node.children.length > 0 ? await normalizeNodes(node.children, resolvers, depth, opts) : [];
  const text = inline || summarizeRichElements(children);
  if (text) {
    return {
      type: 'quote',
      text: clampText(text, opts.textLimit),
      ...(title ? { title } : {}),
      ...(targetId ? { targetMessageId: targetId } : {}),
    };
  }
  const resolveQuote = resolvers.quote;
  if (targetId && resolveQuote && depth < opts.maxForwardDepth) {
    const resolved = await safeResolve('引用', opts, () => resolveQuote(targetId, depth + 1));
    if (resolved) return resolved;
    return { type: 'quote', text: '[引用]（解析失败）', ...(title ? { title } : {}), targetMessageId: targetId };
  }
  return {
    type: 'quote',
    text: '[引用]',
    ...(title ? { title } : {}),
    ...(targetId ? { targetMessageId: targetId } : {}),
  };
}

function forwardNodeText(items: readonly RichForwardItem[]): string {
  const lines = items.map((item) => {
    const summary = summarizeRichElements(item.elements);
    return item.title ? `${item.title}：${summary}` : summary;
  });
  return lines.filter((line) => line.length > 0).join('\n');
}

async function normalizeForward(
  node: RichNode,
  resolvers: RichResolvers,
  depth: number,
  opts: ResolvedOptions,
): Promise<RichMessageElement> {
  const { data } = node;
  const id = pickString(data, ['id', 'message_id', 'messageId', 'resid', 'm_resid', 'resource_id', 'resourceId']);
  const base: RichMessageElement = { type: 'forward', title: '合并转发', text: '[合并转发]' };
  const resolveForward = resolvers.forward;
  if (!id || !resolveForward) return base;
  if (depth >= opts.maxForwardDepth) return { ...base, text: '[合并转发]（层级过深，未展开）' };
  let unavailable = false;
  let items: RichForwardItem[] | undefined;
  try {
    items = await resolveForward(id, depth + 1);
  } catch (error) {
    if (isUnavailableMessageError(error)) {
      unavailable = true;
    } else {
      opts.warn?.(`富消息合并转发解析失败: ${describeError(error)}`);
    }
  }
  if (unavailable) return { ...base, text: '[合并转发不可用]' };
  if (!items || items.length === 0) return { ...base, text: '[合并转发]（展开失败）' };
  return {
    type: 'forward',
    title: '合并转发',
    text: clampText(forwardNodeText(items), opts.textLimit),
    items,
  };
}

function parseJsonRecord(value: unknown): Dict | undefined {
  if (isDict(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isDict(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseXmlCard(xml: string): Dict {
  const read = (tag: string): string | undefined => {
    const matched = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'iu').exec(xml);
    if (!matched) return undefined;
    const value = matched[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1').trim();
    return value || undefined;
  };
  return {
    title: read('title'),
    desc: read('summary') ?? read('desc'),
    url: read('url'),
    preview: read('picture') ?? read('cover'),
  };
}

/** ark `com.tencent.multimsg` / 原生 forward 的资源 id（用于 get_forward_msg 展开）。 */
function readArkResourceId(payload: Dict): string {
  const meta = isDict(payload.meta) ? payload.meta : undefined;
  const view = pickString(payload, ['view']);
  const candidates: (Dict | undefined)[] = [
    meta && view && isDict(meta[view]) ? (meta[view] as Dict) : undefined,
    meta && isDict(meta.detail_1) ? (meta.detail_1 as Dict) : undefined,
    meta && isDict(meta.detail) ? (meta.detail as Dict) : undefined,
    meta && isDict(meta.news) ? (meta.news as Dict) : undefined,
    payload,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const id = pickString(candidate, ['resid', 'm_resid', 'resource_id', 'resourceId', 'multi_msg_id', 'multiMsgId']);
    if (id) return id;
  }
  return '';
}

function normalizeCard(payload: Dict, fallback: Dict, textLimit: number): RichMessageElement {
  const meta = isDict(payload.meta) ? payload.meta : undefined;
  const view = pickString(payload, ['view']);
  const viewed = meta && view && isDict(meta[view]) ? (meta[view] as Dict) : undefined;
  const card = viewed ?? (meta ? Object.values(meta).find(isDict) : undefined) ?? payload;
  const title =
    pickString(card, ['title']) || pickString(payload, ['title', 'prompt']) || pickString(fallback, ['title']) || '卡片消息';
  const text =
    pickString(card, ['desc', 'summary', 'content', 'prompt']) ||
    pickString(payload, ['desc', 'prompt']) ||
    '[卡片消息]';
  const url = sanitizeMediaUrl(pick(card, ['jumpUrl', 'jump_url', 'url', 'source_url', 'qqdocurl', 'qqDocUrl']) ?? pick(payload, ['jumpUrl', 'url', 'qqdocurl']));
  const imageUrl = sanitizeMediaUrl(
    pick(card, ['preview', 'image', 'imageUrl', 'image_url', 'picUrl', 'pic_url', 'icon']) ?? pick(payload, ['preview', 'image']),
  );
  const source = pickString(card, ['tag', 'source', 'app']) || pickString(payload, ['app', 'source', 'tag']);
  return {
    type: 'card',
    title: clampText(title, textLimit),
    text: clampText(text, textLimit),
    ...(url ? { url } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(source ? { source } : {}),
  };
}

async function normalizeStructured(
  node: RichNode,
  resolvers: RichResolvers,
  depth: number,
  opts: ResolvedOptions,
): Promise<RichMessageElement> {
  const { data } = node;
  const raw = pick(data, ['data', 'content', 'json', 'xml']);
  const payload = parseJsonRecord(raw);
  if (payload) {
    const resourceId = readArkResourceId(payload);
    if (resourceId) {
      const forward = await normalizeForward(
        { type: 'forward', data: { id: resourceId }, children: [] },
        resolvers,
        depth,
        opts,
      );
      const source = pickString(payload, ['app', 'app_name', 'source']);
      if (forward.type === 'forward') return source ? { ...forward, source } : forward;
    }
    return normalizeCard(payload, data, opts.textLimit);
  }
  if (node.type === 'xml' && typeof raw === 'string') return normalizeCard(parseXmlCard(raw), data, opts.textLimit);
  const text = pickString(data, ['summary', 'prompt', 'text']);
  return { type: 'card', title: '卡片消息', text: text || '[卡片消息]' };
}

function normalizeShare(node: RichNode): RichMessageElement {
  const { data } = node;
  const url = sanitizeMediaUrl(pick(data, ['url']));
  const imageUrl = sanitizeMediaUrl(pick(data, ['image', 'preview']));
  return {
    type: 'card',
    title: pickString(data, ['title']) || '链接分享',
    text: pickString(data, ['content', 'desc']) || '[链接分享]',
    ...(url ? { url } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    source: 'share',
  };
}

function normalizeMusic(node: RichNode): RichMessageElement {
  const { data } = node;
  const url = sanitizeMediaUrl(pick(data, ['url', 'jumpUrl', 'jump_url', 'audio']));
  const imageUrl = sanitizeMediaUrl(pick(data, ['image', 'preview']));
  return {
    type: 'card',
    title: pickString(data, ['title']) || '[音乐]',
    text: pickString(data, ['content', 'desc']) || '[音乐]',
    ...(url ? { url } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    source: 'music',
  };
}

function normalizeLocation(node: RichNode): RichMessageElement {
  const { data } = node;
  const lat = pickNumber(data, ['lat', 'latitude']);
  const lon = pickNumber(data, ['lon', 'lng', 'longitude']);
  const url = lat !== undefined && lon !== undefined
    ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`
    : undefined;
  return {
    type: 'card',
    title: pickString(data, ['title', 'name']) || '[位置]',
    text: pickString(data, ['content', 'address', 'desc']) || '[位置]',
    ...(url ? { url } : {}),
    source: 'location',
  };
}

function normalizeContact(node: RichNode): RichMessageElement {
  const { data } = node;
  const kind = pickString(data, ['type']);
  const name = pickString(data, ['name', 'nickname', 'group_name', 'title']);
  return {
    type: 'card',
    title: kind === 'group' ? '[推荐群聊]' : '[推荐好友]',
    text: name || '[联系人]',
    source: 'contact',
  };
}

const RPS_LABELS: Record<number, string> = { 1: '石头', 2: '剪刀', 3: '布' };

function normalizeGame(node: RichNode): RichMessageElement {
  const result = pickNumber(node.data, ['result']);
  if (node.type === 'dice') return { type: 'text', text: result !== undefined ? `[骰子 ${result}]` : '[骰子]' };
  const label = result !== undefined ? RPS_LABELS[result] : undefined;
  return { type: 'text', text: label ? `[猜拳 ${label}]` : '[猜拳]' };
}

/* ------------------------------------------------------------------ *
 * 只读 resolver
 * ------------------------------------------------------------------ */

function readForwardNodes(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!isDict(result)) return [];
  for (const key of ['message', 'messages', 'nodes', 'data', 'msg']) {
    const value = result[key];
    if (Array.isArray(value)) return value;
    if (isDict(value)) {
      const nested = readForwardNodes(value);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

async function buildForwardItems(
  result: unknown,
  resolvers: RichResolvers,
  depth: number,
  opts: ResolvedOptions,
  itemBudget: { items: number },
): Promise<RichForwardItem[]> {
  const nodes = readForwardNodes(result);
  // 先按「每层上限 ∩ 跨层剩余预算」切片，并**在解析任何子内容之前**就扣减共享预算，
  // 这样递归展开的子调用立即看到已消耗的额度（否则同一层顺序/并发展开都会重复使用旧预算）。
  const cap = Math.max(1, Math.min(opts.maxForwardNodes, itemBudget.items));
  const limited = nodes.slice(0, cap);
  itemBudget.items -= limited.length;
  const items: RichForwardItem[] = [];
  for (const raw of limited) {
    const outer = isDict(raw) ? raw : {};
    const item = isDict(outer.data) ? (outer.data as Dict) : outer;
    const sender = isDict(item.sender) ? (item.sender as Dict) : isDict(outer.sender) ? (outer.sender as Dict) : item;
    const title = pickString(sender, ['nickname', 'card', 'name', 'senderName', 'sender_name']);
    const content = item.content ?? item.message ?? outer.message ?? outer.content;
    const elements = await normalizeNodes(readSegmentList(content) ?? [], resolvers, depth, opts);
    items.push({
      ...(title ? { title } : {}),
      elements: elements.length > 0 ? elements : [{ type: 'unknown', text: '[消息]' }],
    });
  }
  if (nodes.length > limited.length) {
    items.push({
      elements: [{ type: 'text', text: `…（共 ${nodes.length} 条转发，仅展开前 ${limited.length} 条）` }],
    });
  }
  return items;
}

async function buildQuotedElement(
  result: unknown,
  targetId: string,
  resolvers: RichResolvers,
  depth: number,
  opts: ResolvedOptions,
): Promise<RichMessageElement> {
  const item = isDict(result) ? result : {};
  const sender = isDict(item.sender) ? (item.sender as Dict) : {};
  const title = pickString(sender, ['nickname', 'card', 'name']);
  const elements = await normalizeNodes(readSegmentList(item.message ?? item.content) ?? [], resolvers, depth, opts);
  const text = summarizeRichElements(elements);
  return {
    type: 'quote',
    text: clampText(text || '[引用]', opts.textLimit),
    ...(title ? { title } : {}),
    targetMessageId: targetId,
  };
}

/**
 * 被引用原消息不可读取（撤回 / 过期 / OneBot 侧无此 message_id）属于常态，
 * 不是解析故障：这类失败只在预览里显示占位文案，不写 warning 日志。
 * 判据是 OneBot 的 retcode（1200 = 查无此消息）与常见措辞。
 */
function isUnavailableMessageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/retcode\s*[:=]?\s*(?:1200|1400|1404)\b/iu.test(message)) return true;
  return /消息?(?:已)?(?:过期|不存在|撤回)|no\s+such\s+message|message\s+not\s+found|forward\s+(?:message\s+)?not\s+found/iu.test(message);
}
const isUnavailableQuoteError = isUnavailableMessageError;

function createResolvers(onebot: unknown, opts: ResolvedOptions): RichResolvers {
  const invoke = createOneBotInvoker(onebot);
  if (!invoke) return {};
  // 单条消息的只读 action 总次数上限：深嵌套合并转发不得把 IO 放大成无界请求。
  let remaining = opts.maxResolves;
  // 跨层转发节点总预算：**共享可变计数器**，每次切片即扣减，递归子调用立刻可见。
  const itemBudget = { items: opts.maxForwardItems };
  const limited = async (action: string, params: Dict): Promise<unknown> => {
    if (remaining <= 0) throw new Error(`只读解析次数已达上限（${opts.maxResolves} 次）`);
    remaining -= 1;
    return await withTimeout(invoke(action, params), opts.timeoutMs);
  };
  const resolvers: RichResolvers = {
    image: async (file) => {
      const result = await limited('get_image', { file });
      const source = isDict(result) && isDict(result.data) ? (result.data as Dict) : result;
      return sanitizeMediaUrl(pick(source, ['url']) ?? pick(source, ['file']));
    },
    quote: async (id, depth) => {
      let result: unknown;
      try {
        result = await limited('get_msg', { message_id: id });
      } catch (error) {
        // 原消息已撤回 / 过期：常态，不写 warning，只给可见占位。
        if (!isUnavailableQuoteError(error)) throw error;
        return { type: 'quote', text: '[引用消息不可用]', targetMessageId: id };
      }
      return await buildQuotedElement(result, id, resolvers, depth, opts);
    },
    forward: async (id, depth) => {
      const result = await limited('get_forward_msg', { id });
      return await buildForwardItems(result, resolvers, depth, opts, itemBudget);
    },
  };
  return resolvers;
}

/** `session.quote`（Koishi 已解析的引用消息对象）→ quote 元素。 */
async function normalizeSessionQuote(
  quote: unknown,
  resolvers: RichResolvers,
  opts: ResolvedOptions,
): Promise<RichMessageElement | undefined> {
  if (!isDict(quote)) return undefined;
  const id = pickString(quote, ['id', 'messageId', 'message_id']);
  const sender = pick(quote, ['member', 'user']);
  const title = pickString(sender, ['name', 'nick', 'username', 'nickname']);
  const inline = Array.isArray(quote.elements) ? quote.elements : readSegmentList(quote.content);
  const elements = await normalizeNodes(inline ?? [], resolvers, 2, opts);
  let text = summarizeRichElements(elements) || clampText(decodeSegmentText(pickString(quote, ['content'])), opts.textLimit);
  const resolveQuote = resolvers.quote;
  if (!text && id && resolveQuote) {
    const resolved = await safeResolve('引用', opts, () => resolveQuote(id, 2));
    if (resolved) {
      return {
        ...resolved,
        ...(title && !resolved.title ? { title } : {}),
        targetMessageId: resolved.targetMessageId ?? id,
      };
    }
    text = '[引用]（解析失败）';
  }
  if (!text && !title && !id) return undefined;
  return {
    type: 'quote',
    text: text || '[引用]',
    ...(title ? { title } : {}),
    ...(id ? { targetMessageId: id } : {}),
  };
}
/**
 * 剔除 OneBot 协议（如 NapCat / Go-CQHttp）为了兼容旧版纯文本客户端而在 reply 之后
 * 注入的被引用消息纯文本镜像行，避免引用内容被重复渲染两次。
 */
function deduplicateQuoteMirrorText(elements: RichMessageElement[]): RichMessageElement[] {
  const quotes = elements.filter(
    (el) => el.type === 'quote' && typeof el.text === 'string' && el.text.trim().length > 0,
  );
  if (quotes.length === 0) return elements;

  const quoteTexts = new Set(
    quotes
      .map((q) => q.text?.trim() ?? '')
      .filter((t) => t.length > 0 && !t.startsWith('[引用')),
  );
  if (quoteTexts.size === 0) return elements;

  const result: RichMessageElement[] = [];
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i];
    if (el.type === 'text' && typeof el.text === 'string') {
      const trimmed = el.text.trim();
      let isMirror = false;
      for (const qText of quoteTexts) {
        if (trimmed === qText || (trimmed.length >= 4 && qText.startsWith(trimmed))) {
          isMirror = true;
          break;
        }
      }
      if (isMirror) continue;
    }
    result.push(el);
  }
  return result;
}


/**
 * 解析富消息元素（只读，绝不发送任何消息）。
 *
 * 结果恒为非空数组；所有只读 action 失败都会被记录（脱敏日志）并转化为元素上的可见 error 文本，
 * 绝不伪造 URL / 假图片，也绝不抛出（调用方无需 try/catch）。
 */
export async function parseRichElements(
  input?: RichMessageContext,
  options: RichParseOptions = {},
): Promise<RichMessageElement[]> {
  const opts = resolveOptions(options);
  const content = typeof input?.content === 'string' ? input.content : '';
  const fallback = textFallbackElements(content);
  try {
    const resolvers = createResolvers(input?.onebot, opts);
    const rawNodes =
      readSegmentList(input?.rawMessage) ?? readSegmentList(input?.elements) ?? readSegmentList(content) ?? [];
    const elements: RichMessageElement[] = [];
    const quote = await normalizeSessionQuote(input?.quote, resolvers, opts);
    if (quote) elements.push(quote);

    // 过滤与 input.quote 相同 id 的重复 reply 段
    const filteredNodes = quote?.targetMessageId
      ? rawNodes.filter((raw) => {
          const node = readNode(raw);
          if (!node || (node.type !== 'reply' && node.type !== 'quote')) return true;
          const targetId = pickString(node.data, ['id', 'message_id', 'messageId']);
          return targetId !== quote.targetMessageId;
        })
      : rawNodes;

    // 顶层预算扣除引用占位；normalizeNodes 内部**先切片再遍历**，绝不先完整遍历再裁剪
    const childElements = await normalizeNodes(
      filteredNodes,
      resolvers,
      1,
      opts,
      Math.max(1, opts.maxElements - elements.length),
    );
    elements.push(...childElements);

    // 剔除 OneBot 协议为了兼容旧客户端在 reply 之后注入的被引用消息纯文本镜像
    const deduplicated = deduplicateQuoteMirrorText(elements);
    return deduplicated.length > 0 ? deduplicated : fallback;
  } catch (error) {
    opts.warn?.(`富消息元素解析异常，已回退纯文本: ${describeError(error)}`);
    return fallback;
  }
}

/** 元素树的深冻结（缓存中的元素视为不可变，可安全共享引用）。 */
export function freezeElements(elements: readonly RichMessageElement[]): RichMessageElement[] {
  for (const element of elements) {
    if (element.items) {
      for (const item of element.items) {
        freezeElements(item.elements);
        Object.freeze(item);
      }
      Object.freeze(element.items);
    }
    Object.freeze(element);
  }
  return Object.freeze(elements) as RichMessageElement[];
}
