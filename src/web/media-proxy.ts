/**
 * 同源媒体代理：`GET <basePath>/api/media/:opaqueId`。
 *
 * 定位与红线（与 `MediaRegistry` 配合）：
 *   - 只服务**本插件缓存消息登记过**的 opaqueId，绝不接受 `?url=` 之类的任意 URL 参数；
 *   - 上游连接走 `node:http` / `node:https`，并用 `lookup` 固定到**已校验过的 IP**，
 *     杜绝「校验完 DNS 又被重新解析」造成的 rebinding；
 *   - 逐跳校验重定向（公网 http(s)、无 userinfo、端口 80/443、非私网），跳数上限 `MEDIA_MAX_REDIRECTS`；
 *   - 只透传 Range 与媒体相关响应头，绝不转发浏览器的 Cookie / Authorization / Referer，
 *     也绝不把 bot 的凭据带给媒体源；
 *   - 响应体流式转发（视频 Range 原样返回 206 + Content-Range），不整文件缓存；
 *   - 非媒体类型（HTML / SVG / JS 等 active content）一律 415 拒绝，并恒定带 `nosniff`，
 *     因此第三方内容永远不可能以本插件源的身份被浏览器执行；
 *   - 失败一律返回 JSON `{ error }` + 4xx/5xx，前端据此显示可见错误文本，绝不留空白/假图。
 */

import { promises as dns } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { MEDIA_FETCH_TIMEOUT_MS, MEDIA_MAX_REDIRECTS } from '../types';
import { isIPv4MappedIPv6, isPrivateOrLocalHost, sanitizeMediaUrl } from '../plugin/rich-message';
import { MEDIA_ID_PATTERN, type MediaRegistry } from '../plugin/media-registry';

/** 代理处理器所需的 Koa 上下文最小契约（由 `registerWebUi` 的宿主上下文满足）。 */
export interface MediaProxyContext {
  params: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  request?: { headers?: Record<string, string | string[] | undefined> };
  req?: {
    headers?: Record<string, string | string[] | undefined>;
    once?(event: string, listener: () => void): void;
    on?(event: string, listener: () => void): void;
  };
  res?: { once?(event: string, listener: () => void): void; on?(event: string, listener: () => void): void };
  status: number;
  body: unknown;
  type?: string;
  set(name: string, value: string): void;
}

/** 上游媒体响应（已固定 IP 的原始流）。 */
export interface MediaFetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body?: NodeJS.ReadableStream | null;
  /** 放弃本次上游响应（重定向、类型拒绝或客户端断开时调用）。 */
  abort?: () => void;
}

export interface MediaFetchOptions {
  range?: string;
  signal: AbortSignal;
  /** 已通过公网校验的固定 IP 与协议族。 */
  address: string;
  family: number;
}

export type MediaFetchLike = (target: URL, options: MediaFetchOptions) => Promise<MediaFetchResult>;

export interface MediaProxyOptions {
  /** 自定义上游抓取实现（测试注入）；默认走 node:http(s) + 固定 IP。 */
  fetch?: MediaFetchLike;
  /** 自定义 DNS 解析（测试注入）；默认 `dns.lookup`，返回的每个地址都会做公网校验。 */
  lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  /** 上游连接/首包超时（毫秒）。 */
  timeoutMs?: number;
  /** 允许跟随的最大重定向跳数。 */
  maxRedirects?: number;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MEDIA_USER_AGENT = 'PatchouliKnowledge/0.1 (read-only media proxy)';
const RANGE_PATTERN = /^bytes=\d*-\d*(?:,\d*-\d*)*$/u;
const MEDIA_CONTENT_TYPES: readonly RegExp[] = [
  /^image\/(?!svg)/u,
  /^audio\//u,
  /^video\//u,
  /^application\/(?:ogg|octet-stream|mp4|x-mpegurl|vnd\.apple\.mpegurl)/u,
  /^binary\/octet-stream$/u,
];

function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 媒体类型白名单：拒绝 HTML / SVG / JS 等可执行内容（含 `image/svg+xml`）。 */
export function isAllowedMediaType(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return MEDIA_CONTENT_TYPES.some((pattern) => pattern.test(type));
}

/**
 * 解析主机名并返回**唯一的公网 IP**（供 `lookup` 固定使用）。
 * 任一解析结果落在私网 / 本机 / 保留段（含 CGNAT、link-local、组播、RFC 2544 基准段）即整条拒绝，
 * IPv4 映射形式的 IPv6 字面量（`::ffff:7f00:1` / `::ffff:8.8.8.8` 等）同样整条拒绝，
 * 不存在任何例外段：媒体源必须是公网地址，且绝不把映射字面量交给 pinnedLookup 去连。
 */
async function resolvePublicAddress(
  hostname: string,
  lookup: (hostname: string) => Promise<readonly { address: string; family: number }[]>,
): Promise<{ address: string; family: number } | undefined> {
  const host = hostname.replace(/^\[(.*)\]$/u, '$1');
  const literal = isIP(host);
  if (literal !== 0) {
    // 映射形式与内嵌 IPv4 等价（`::ffff:808:808` ≡ 8.8.8.8），正规媒体源绝不会使用这种写法；
    // 与私网同路径直接判为不可用，绝不进入 pinnedLookup。
    if (literal === 6 && isIPv4MappedIPv6(host)) return undefined;
    return isPrivateOrLocalHost(host) ? undefined : { address: host, family: literal };
  }
  try {
    const records = await lookup(host);
    if (records.length === 0) return undefined;
    for (const record of records) {
      if (isPrivateOrLocalHost(record.address)) return undefined;
    }
    return { address: records[0].address, family: records[0].family };
  } catch {
    return undefined;
  }
}

/** 默认抓取实现：`lookup` 恒定返回已校验 IP，Host / SNI 仍用原主机名。 */
function createNodeMediaFetcher(): MediaFetchLike {
  return (target, options) =>
    new Promise<MediaFetchResult>((resolve, reject) => {
      const secure = target.protocol === 'https:';
      const pinnedLookup: NonNullable<RequestOptions['lookup']> = (_hostname, lookupOptions, callback) => {
        // autoSelectFamily / happy-eyeballs 会以 all: true 调用，需要数组形态
        if (lookupOptions?.all) callback(null, [{ address: options.address, family: options.family }], options.family);
        else callback(null, options.address, options.family);
      };
      const requestOptions: RequestOptions = {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[(.*)\]$/u, '$1'),
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          accept: '*/*',
          'user-agent': MEDIA_USER_AGENT,
          ...(options.range ? { range: options.range } : {}),
        },
        lookup: pinnedLookup,
        signal: options.signal,
        // HTTPS：SNI 与证书校验仍针对原始主机名，仅 TCP 连接落到已校验 IP
        ...(secure && isIP(target.hostname.replace(/^\[(.*)\]$/u, '$1')) === 0 ? { servername: target.hostname } : {}),
      };
      const onResponse = (response: IncomingMessage): void => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          abort: () => response.destroy(),
        });
      };
      const upstream = secure
        ? httpsRequest(requestOptions, onResponse)
        : httpRequest(requestOptions, onResponse);
      upstream.on('error', reject);
      upstream.end();
    });
}

function fail(kCtx: MediaProxyContext, status: number, message: string): void {
  kCtx.status = status;
  kCtx.set('content-type', 'application/json; charset=utf-8');
  kCtx.set('x-content-type-options', 'nosniff');
  kCtx.set('cache-control', 'no-store');
  kCtx.body = { error: message };
}

function readRange(kCtx: MediaProxyContext): string | undefined {
  const raw =
    readHeader(kCtx.headers, 'range') ??
    readHeader(kCtx.request?.headers, 'range') ??
    readHeader(kCtx.req?.headers, 'range');
  return raw && RANGE_PATTERN.test(raw.trim()) ? raw.trim() : undefined;
}

/**
 * 构造媒体代理路由处理器。`registry` 是唯一的地址来源（未登记 / 已失效一律 404）。
 */
export function createMediaProxyHandler(
  registry: MediaRegistry,
  options: MediaProxyOptions = {},
): (kCtx: MediaProxyContext) => Promise<void> {
  const fetchImpl = options.fetch ?? createNodeMediaFetcher();
  const lookup = options.lookup ?? (async (hostname: string) => await dns.lookup(hostname, { all: true, verbatim: true }));
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : MEDIA_FETCH_TIMEOUT_MS;
  const maxRedirects =
    typeof options.maxRedirects === 'number' && options.maxRedirects >= 0 ? options.maxRedirects : MEDIA_MAX_REDIRECTS;

  return async (kCtx: MediaProxyContext): Promise<void> => {
    const id = String(kCtx.params?.id ?? '');
    if (!MEDIA_ID_PATTERN.test(id)) {
      fail(kCtx, 400, '非法媒体标识');
      return;
    }
    const registered = registry.resolve(id);
    if (!registered) {
      fail(kCtx, 404, '媒体已失效或未登记');
      return;
    }

    const range = readRange(kCtx);
    let target = registered;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const safe = sanitizeMediaUrl(target);
      const url = safe ? new URL(safe) : undefined;
      const resolved = url ? await resolvePublicAddress(url.hostname, lookup) : undefined;
      if (!url || !resolved) {
        fail(kCtx, 403, '媒体地址不被允许');
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let result: MediaFetchResult;
      try {
        result = await fetchImpl(url, {
          range,
          signal: controller.signal,
          address: resolved.address,
          family: resolved.family,
        });
      } catch {
        clearTimeout(timer);
        fail(kCtx, 502, '媒体源不可达');
        return;
      }
      clearTimeout(timer);

      if (REDIRECT_STATUS.has(result.status)) {
        const location = readHeader(result.headers, 'location');
        result.abort?.();
        if (!location) {
          fail(kCtx, 502, '媒体重定向缺少目标');
          return;
        }
        target = new URL(location, url).toString();
        continue;
      }

      if (result.status !== 200 && result.status !== 206) {
        result.abort?.();
        fail(kCtx, 502, `媒体源返回 ${result.status}`);
        return;
      }

      const contentType = readHeader(result.headers, 'content-type');
      if (!contentType || !isAllowedMediaType(contentType)) {
        result.abort?.();
        fail(kCtx, 415, '媒体类型不被允许');
        return;
      }

      kCtx.status = result.status;
      kCtx.set('content-type', contentType);
      kCtx.set('x-content-type-options', 'nosniff');
      kCtx.set('content-disposition', 'inline');
      kCtx.set('content-security-policy', "default-src 'none'; sandbox");
      kCtx.set('cache-control', 'private, max-age=300');
      kCtx.set('accept-ranges', readHeader(result.headers, 'accept-ranges') ?? 'bytes');
      const contentLength = readHeader(result.headers, 'content-length');
      if (contentLength) kCtx.set('content-length', contentLength);
      const contentRange = readHeader(result.headers, 'content-range');
      if (contentRange) kCtx.set('content-range', contentRange);
      if (!result.body) { kCtx.body = null; return; }
      const stream = new Transform({
        transform(chunk, _encoding, callback) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            controller.abort();
            result.abort?.();
            stream.destroy(new Error('媒体读取超时'));
          }, timeoutMs);
          idleTimer.unref();
          callback(null, chunk);
        },
      });
      let idleTimer = setTimeout(() => {
        controller.abort();
        result.abort?.();
        stream.destroy(new Error('媒体读取超时'));
      }, timeoutMs);
      idleTimer.unref();
      const cleanup = (): void => { clearTimeout(idleTimer); };
      stream.once('end', cleanup);
      stream.once('error', cleanup);
      stream.once('close', () => { cleanup(); controller.abort(); result.abort?.(); });
      result.body.once('error', (error: Error) => stream.destroy(error));
      result.body.pipe(stream);
      kCtx.body = stream;
      // 下游断开与正文读取停滞都会终止上游，Range 响应保持流式传输。
      kCtx.res?.once?.('close', () => { stream.destroy(); controller.abort(); result.abort?.(); });
      return;
    }

    fail(kCtx, 502, '媒体重定向过多');
  };
}
