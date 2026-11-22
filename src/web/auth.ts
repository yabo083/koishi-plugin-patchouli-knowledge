/**
 * 管理面令牌体系。
 *
 * 三层：
 * 1. **长期令牌** `security.apiToken`：只存在服务端配置里，用于换会话（登录）与运维直连；
 * 2. **会话票据**：`login` 时签发 `sid`（32 字节随机），服务端持有 `{createdAt, expiresAt}`，
 *    Cookie 与 `Authorization: Bearer <sid>` 都可用；到期前使用会**滑动续期**；
 *    会话表**落盘**到 `<wikiDir>/.patchouli/sessions.json`（只存 `sha256(sid)`），因此重启不再要求重新登录；
 *    落盘文件绑定 `apiToken` 指纹，令牌轮换即整批作废；
 * 3. **守卫**：`/patchouli/api/*` 一律要求「有效会话」或「长期令牌」，否则 401。
 *
 * 客户端**永不保存 apiToken**，只保存会话票据；因此吊销（重启 / 轮换 apiToken / 会话到期）
 * 会真实生效，而不是把密钥摊在浏览器里。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 页面/客户端保存会话的 Cookie 名。 */
export const SESSION_COOKIE_NAME = 'patchouli_session';

/** 默认会话有效期：7 天（滑动续期，活跃使用就一直有效）。 */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 会话表硬上限：7 天有效期下留足多设备/多标签页余量，超出淘汰最早到期的一批。 */
export const MAX_SESSIONS = 256;
/** 落盘格式版本；结构变化时递增，旧文件按「全部作废」处理。 */
export const SESSION_STORE_VERSION = 1;

/** 窄化 `unknown` 到普通对象（解析落盘 JSON 用）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 一次会话服务端记录。 */
export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
}

/** 鉴权失败的四种成因（对客户端只暴露统一种类，细节进日志）。 */
export type AuthFailure = 'unconfigured' | 'missing' | 'invalid' | 'expired';

/** 鉴权结果。 */
export type AuthResult =
  | { ok: true; via: 'session' | 'token'; session?: SessionRecord }
  | { ok: false; reason: AuthFailure };

/** 鉴权所需的最小 Koa 上下文面。 */
interface AuthContextLike {
  ip?: string;
  request?: { ip?: string };
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  set?: (name: string, value: string) => void;
  status?: number;
  type?: string;
  body?: unknown;
}

function headerValue(headers: AuthContextLike['headers'], name: string): string | undefined {
  if (headers === undefined) return undefined;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

/** 从 Cookie 头里取指定名字的值。 */
function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/** 恒定时间比较；长度不同直接失败。 */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 请求携带的 bearer / 查询串 / Cookie 凭据（按优先级）。 */
export function extractCredential(ctx: AuthContextLike): { bearer?: string; token?: string; session?: string } {
  const authorization = headerValue(ctx.headers, 'authorization');
  const bearerMatch = authorization === undefined ? null : /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  const bearer = bearerMatch?.[1]?.trim();
  const explicit = headerValue(ctx.headers, 'x-api-token')?.trim();
  const query = typeof ctx.query?.token === 'string' ? ctx.query.token.trim() : undefined;
  const cookie = cookieValue(headerValue(ctx.headers, 'cookie'), SESSION_COOKIE_NAME)?.trim();
  return {
    bearer: bearer === '' ? undefined : bearer,
    token: explicit === '' ? undefined : (explicit ?? (query === '' ? undefined : query)),
    session: cookie === '' ? undefined : cookie,
  };
}

/**
 * 会话签发与校验。
 *
 * 所有时间比较都走注入的 `now`，单测可直接拨表；过期项在每次访问时惰性清理。
 */
export class TokenAuthority {
  private apiToken: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxSessions: number;
  /**
   * 会话表：键是 `sha256(sid)` 而非 sid 原文。
   *
   * 这样内存与落盘文件都不含可直接使用的票据——文件泄露不等于会话泄露。
   */
  private readonly sessions = new Map<string, SessionRecord>();
  /** 落盘路径；缺省只存内存（单测与旧宿主）。 */
  private readonly sessionsFile: string | undefined;
  /** 串行写队列：会话表写入失败只告警，绝不影响鉴权主流程。 */
  private persistQueue: Promise<void> = Promise.resolve();
  private persistSeq = 0;

  public constructor(
    apiToken: string,
    options: {
      ttlMs?: number;
      now?: () => number;
      maxSessions?: number;
      /** 会话表落盘路径；缺省只存内存（单测与旧宿主）。 */
      sessionsFile?: string;
    } = {},
  ) {
    this.apiToken = apiToken.trim();
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.sessionsFile = options.sessionsFile;
    // 同步载入：构造发生在注册路由之前，异步装载会留出「刚重启时所有会话都判无效」的窗口，
    // 正是这次要消灭的现象。文件只有几 KB，代价可忽略。
    this.loadPersistedSessions();
  }

  /** 会话票据的存储键：只存哈希，文件泄露不等于会话泄露。 */
  private static keyOf(sid: string): string {
    return createHash('sha256').update(sid).digest('hex');
  }

  /** 当前长期令牌的指纹：令牌轮换后旧票据整批作废。 */
  private fingerprint(): string {
    return createHash('sha256').update(`patchouli-session-v${SESSION_STORE_VERSION}:${this.apiToken}`).digest('hex');
  }

  /**
   * 读取落盘会话表。
   *
   * 三条判据：版本不符 / 令牌指纹不符 / 单条过期——前两者整批丢弃，后者逐条丢弃。
   * 任何读取或解析异常都按「空表」处理：会话可重建，绝不让坏文件挡住启动。
   */
  private loadPersistedSessions(): void {
    const file = this.sessionsFile;
    if (file === undefined || !this.configured) return;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.version !== SESSION_STORE_VERSION) return;
      if (parsed.fingerprint !== this.fingerprint()) return;
      const list = parsed.sessions;
      if (!Array.isArray(list)) return;
      const now = this.now();
      for (const item of list) {
        if (!isRecord(item)) continue;
        const { idHash, createdAt, expiresAt } = item;
        if (typeof idHash !== 'string' || idHash.length !== 64) continue;
        if (typeof createdAt !== 'number' || typeof expiresAt !== 'number') continue;
        if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
        this.sessions.set(idHash, { id: idHash, createdAt, expiresAt });
      }
      this.evictOverflow();
    } catch {
      // 坏文件：当作空表，下次写入会覆盖。
    }
  }

  /** 串行落盘（失败只告警）。 */
  private schedulePersist(): void {
    const file = this.sessionsFile;
    if (file === undefined || !this.configured) return;
    this.persistQueue = this.persistQueue
      .then(async () => {
        const payload = {
          version: SESSION_STORE_VERSION,
          fingerprint: this.fingerprint(),
          // 写**表键**（哈希），不是 `session.id`（原始票据）——否则落盘文件会存明文票据，
          // 且重启后按哈希查不到。
          sessions: [...this.sessions.entries()].map(([idHash, session]) => ({
            idHash,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
          })),
        };
        await mkdir(dirname(file), { recursive: true });
        this.persistSeq += 1;
        const temp = `${file}.tmp-${process.pid}-${this.persistSeq}`;
        await writeFile(temp, JSON.stringify(payload), 'utf8');
        // 会话票据等价于登录态：文件只给属主读写。
        await chmod(temp, 0o600).catch(() => undefined);
        await rename(temp, file);
      })
      .catch(() => undefined);
  }

  /** 是否配置了长期令牌；未配置时一切鉴权都失败（fail closed），面板会走首次初始化。 */
  public get configured(): boolean {
    return this.apiToken !== '';
  }

  /**
   * 首次初始化：在尚未配置时落定一个长期令牌。
   *
   * 已配置时返回 `false`（幂等且不可覆盖，避免被远端的第二个请求顶掉）。
   */
  public configure(token: string): boolean {
    const next = token.trim();
    if (this.apiToken !== '' || next === '') return false;
    this.apiToken = next;
    return true;
  }

  public get ttl(): number {
    return this.ttlMs;
  }

  /**
   * 回滚一次未完成的首次初始化（仅当当前令牌仍是 `token` 时生效）。
   *
   * `handleBootstrap` 先占位再落盘：落盘失败必须把占位退掉，否则进程内是「已配置」
   * 而磁盘上没有密钥，重启后面板再也回不到初始化流程。
   */
  public revertConfiguration(token: string): boolean {
    if (this.apiToken === '' || this.apiToken !== token.trim()) return false;
    this.apiToken = '';
    return true;
  }

  /** 等待会话表落盘队列排空（测试与优雅关闭用）。 */
  public async flush(): Promise<void> {
    await this.persistQueue;
  }

  /** 活跃会话数（观测用）。 */
  public get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  /** 用长期令牌换会话；令牌不正确返回 `undefined`。 */
  public login(rawToken: string): SessionRecord | undefined {
    if (!this.configured) return undefined;
    if (!safeEqual(rawToken.trim(), this.apiToken)) return undefined;
    this.sweep();
    const now = this.now();
    const session: SessionRecord = {
      id: randomBytes(32).toString('hex'),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(TokenAuthority.keyOf(session.id), session);
    this.evictOverflow();
    this.schedulePersist();
    return session;
  }

  /** 吊销会话（幂等）。 */
  public logout(sid: string | undefined): boolean {
    if (sid === undefined) return false;
    const removed = this.sessions.delete(TokenAuthority.keyOf(sid));
    if (removed) this.schedulePersist();
    return removed;
  }

  /** 校验一次请求；会话命中时滑动续期。 */
  public authorize(ctx: AuthContextLike): AuthResult {
    if (!this.configured) return { ok: false, reason: 'unconfigured' };
    const credential = extractCredential(ctx);

    // 1) 会话优先：sid 可以是 Cookie，也可以是 Bearer。
    for (const sid of [credential.session, credential.bearer]) {
      if (sid === undefined) continue;
      const key = TokenAuthority.keyOf(sid);
      const session = this.sessions.get(key);
      if (session === undefined) continue;
      const now = this.now();
      if (session.expiresAt <= now) {
        this.sessions.delete(key);
        this.schedulePersist();
        return { ok: false, reason: 'expired' };
      }
      // 滑动续期：过半即续满，避免长任务中途被踢。续期即落盘，
      // 否则重启后票据会回退到旧到期时间（7 天有效期内重启频繁时尤其明显）。
      if (session.expiresAt - now < this.ttlMs / 2) {
        session.expiresAt = now + this.ttlMs;
        this.schedulePersist();
      }
      return { ok: true, via: 'session', session };
    }

    // 2) 长期令牌：只给运维直连（curl / 探针）用，不进浏览器存储。
    const token = credential.token ?? credential.bearer;
    if (token !== undefined && safeEqual(token, this.apiToken)) return { ok: true, via: 'token' };

    return { ok: false, reason: credential.session !== undefined || credential.bearer !== undefined ? 'invalid' : 'missing' };
  }

  /** 由会话 id 反查（`/session` 端点用）。 */
  public sessionOf(sid: string | undefined): SessionRecord | undefined {
    if (sid === undefined) return undefined;
    const key = TokenAuthority.keyOf(sid);
    const session = this.sessions.get(key);
    if (session === undefined) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      this.schedulePersist();
      return undefined;
    }
    // 表键是哈希：对外回显的 `id` 用调用方给的 sid，避免把哈希当成票据。
    return { ...session, id: sid };
  }

  private sweep(): void {
    const now = this.now();
    let removed = false;
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(key);
        removed = true;
      }
    }
    if (removed) this.schedulePersist();
  }

  /** 超出上限时按到期时间淘汰最早的，保证内存与落盘文件都有界。 */
  private evictOverflow(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const sorted = [...this.sessions.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt);
    for (const [key] of sorted.slice(0, this.sessions.size - this.maxSessions)) {
      this.sessions.delete(key);
    }
    this.schedulePersist();
  }
}

/** 统一拒绝响应：对外只说「未授权」，成因写进 body 方便排障但不泄露服务端状态。 */
export function rejectUnauthorized(ctx: AuthContextLike, reason: AuthFailure): void {
  ctx.status = 401;
  ctx.type = 'application/json; charset=utf-8';
  ctx.body = { error: 'unauthorized', reason };
}

/** 生成挂在 `/patchouli/api` 上的 Koa 中间件。 */
export function createApiGuard(
  authority: TokenAuthority,
): (ctx: AuthContextLike, next: () => Promise<unknown>) => Promise<unknown> {
  return async (ctx, next) => {
    const result = authority.authorize(ctx);
    if (!result.ok) {
      rejectUnauthorized(ctx, result.reason);
      return;
    }
    return next();
  };
}

/** 会话 Cookie（HttpOnly；值只放 sid，不放长期令牌）。 */
export function sessionCookie(session: SessionRecord, ttlMs: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

/** 清除会话 Cookie。 */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * 登录：校验长期令牌 → 签发会话 → 写 Cookie。
 *
 * 返回体会携带 `{session, expiresAt}`：客户端只保存这个短票据。
 */
export function handleLogin(ctx: AuthContextLike, authority: TokenAuthority, body: unknown): boolean {
  if (!authority.configured) {
    rejectUnauthorized(ctx, 'unconfigured');
    return false;
  }
  const token = typeof body === 'object' && body !== null && 'token' in body
    ? String((body as { token: unknown }).token ?? '').trim()
    : '';
  const session = token === '' ? undefined : authority.login(token);
  if (session === undefined) {
    rejectUnauthorized(ctx, 'invalid');
    return false;
  }
  ctx.set?.('Set-Cookie', sessionCookie(session, authority.ttl));
  ctx.set?.('Cache-Control', 'no-store');
  ctx.type = 'application/json; charset=utf-8';
  ctx.status = 200;
  ctx.body = { session: session.id, expiresAt: session.expiresAt, ttl: authority.ttl };
  return true;
}

/** 登出：吊销当前会话并清 Cookie。 */
export function handleLogout(ctx: AuthContextLike, authority: TokenAuthority): void {
  const credential = extractCredential(ctx);
  authority.logout(credential.session ?? credential.bearer);
  ctx.set?.('Set-Cookie', clearedSessionCookie());
  ctx.status = 204;
}

/** 会话自检：客户端启动时先问一句「我还行吗」，再决定是否弹模态。 */
export function handleSession(ctx: AuthContextLike, authority: TokenAuthority): void {
  const credential = extractCredential(ctx);
  const result = authority.authorize(ctx);
  ctx.set?.('Cache-Control', 'no-store');
  ctx.type = 'application/json; charset=utf-8';
  if (!result.ok) {
    ctx.status = 200;
    ctx.body = {
      authenticated: false,
      reason: result.reason,
      configured: authority.configured,
      bootstrapRequired: !authority.configured,
    };
    return;
  }
  ctx.status = 200;
  ctx.body = {
    authenticated: true,
    via: result.via,
    configured: true,
    bootstrapRequired: false,
    expiresAt: result.session?.expiresAt ?? null,
    ttl: authority.ttl,
    // 长期令牌直连（`via === 'token'`）不签发会话，也绝不把令牌回显给调用方：
    // 否则一份运维凭据会被原路写进浏览器或日志。
    session: result.via === 'session' ? (credential.session ?? credential.bearer ?? null) : null,
  };
}

/**
 * 归一化地址字面量：去掉 IPv6 方括号与首尾空白，`::ffff:a.b.c.d` 映射地址还原成 IPv4。
 *
 * 解析失败（空串 / 非 IP）返回 `undefined`，调用方一律按「不可信」处理。
 */
function normalizeAddress(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/^\[|\]$/gu, '');
  if (value === undefined || value === '') return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(value);
  return (mapped === null ? value : mapped[1]).toLowerCase();
}

/**
 * 是否为 loopback（127.0.0.0/8、::1、映射后的 127.x）。
 *
 * 只有直连对端是 loopback 时，才**可能**存在一个与本进程同机的可信反代在写
 * `x-forwarded-for`；这是采信该头的唯一前提。
 */
function isLoopbackAddress(raw: string | undefined): boolean {
  const address = normalizeAddress(raw);
  if (address === undefined) return false;
  if (address === '::1') return true;
  return /^127\./u.test(address);
}

/**
 * 判断地址是否落在 loopback / 私有网段（IPv4 + IPv6）。
 *
 * `::ffff:a.b.c.d` 这类映射地址先还原成 IPv4 再判；解析失败一律视为「不可信」。
 */
export function isPrivateAddress(raw: string | undefined): boolean {
  const address = normalizeAddress(raw);
  if (address === undefined) return false;
  if (address === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/iu.test(address)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/iu.test(address)) return true; // fe80::/10
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  if (v4 === null) return false;
  const octets = v4.slice(1).map((part) => Number(part));
  if (octets.some((part) => part > 255)) return false;
  const [a, b] = octets;
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 首次初始化是否允许来自该请求。
 *
 * 规则：
 * 1. 直连对端必须是 loopback / 私网，否则拒绝（连 XFF 都不看）；
 * 2. 只有直连对端是 loopback（反代与本进程同机部署）时，`x-forwarded-for` 才可能出自
 *    我们自己的反代，这时才采信它；否则整条链路对客户端都是可写字段，
 *    自填 `X-Forwarded-For: 127.0.0.1` 就能骗过来源限制；
 * 3. 采信时取**最右一跳**——可信反代把真实客户端追加在末尾，左侧各跳都是客户端可自填的。
 *
 * 取舍：反代若部署在另一台内网机器上（对端为私网但非 loopback），XFF 一律不采信，
 * 只按直连对端放行。这意味着「同机反代 + 公网客户端」会被挡在 423 外，
 * 需要远程初始化时请在配置里直接填写 `security.apiToken`。
 */
export function allowsBootstrapFrom(ctx: AuthContextLike): boolean {
  const peer = ctx.ip ?? ctx.request?.ip;
  if (!isPrivateAddress(peer)) return false;
  if (!isLoopbackAddress(peer)) return true;
  const forwarded = headerValue(ctx.headers, 'x-forwarded-for');
  if (forwarded === undefined) return true;
  const hops = forwarded.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (hops.length === 0) return true;
  return isPrivateAddress(hops[hops.length - 1]);
}

/** 生成一枚长期令牌：32 字节十六进制。 */
export function generateApiToken(): string {
  return randomBytes(32).toString('hex');
}

/** 读取落盘的长期令牌；不存在/为空返回 `undefined`。 */
export async function readApiTokenFile(file: string): Promise<string | undefined> {
  if (file.trim() === '') return undefined;
  try {
    const token = (await readFile(file, 'utf8')).trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

/**
 * 落盘长期令牌（0600，尽力而为）。
 *
 * 目录不存在时创建；权限设置失败不阻断（Windows 上没有 POSIX 权限位）。
 */
export async function writeApiTokenFile(file: string, token: string): Promise<boolean> {
  if (file.trim() === '') return false;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * 首次初始化：`POST <base>/bootstrap`。
 *
 * - 只在**尚未配置**时可用（配置了长期令牌就 409，避免被第二个请求顶掉）；
 * - 请求体带 `token` 就用它（长度 ≥ 16，拒绝弱口令），否则服务端生成 32 字节随机串；
 * - 成功后立即签发会话，并把令牌**一次性**返回给前端展示，同时落盘。
 */
export async function handleBootstrap(
  ctx: AuthContextLike,
  authority: TokenAuthority,
  body: unknown,
  options: { file: string },
): Promise<'ok' | 'already-configured' | 'weak-token' | 'persist-failed' | 'blocked-remote'> {
  if (authority.configured) {
    ctx.status = 409;
    ctx.type = 'application/json; charset=utf-8';
    ctx.body = { error: 'already-initialized' };
    return 'already-configured';
  }
  // 首次初始化只能在 loopback / 私网完成：避免公网首个请求就把密钥拿走。
  // 来源判定细节见 `allowsBootstrapFrom`（XFF 仅在直连对端是 loopback 时采信最右一跳）。
  if (!allowsBootstrapFrom(ctx)) {
    ctx.status = 423;
    ctx.type = 'application/json; charset=utf-8';
    ctx.body = {
      error: 'bootstrap-requires-local',
      message: '首次初始化只允许从本机 / 内网打开面板完成；远程请先在配置里填写 security.apiToken',
    };
    return 'blocked-remote';
  }

  const requested = typeof body === 'object' && body !== null && 'token' in body
    ? String((body as { token: unknown }).token ?? '').trim()
    : '';
  if (requested !== '' && requested.length < 16) {
    ctx.status = 400;
    ctx.type = 'application/json; charset=utf-8';
    ctx.body = { error: 'weak-token', message: '密钥至少 16 个字符；留空则由服务端生成' };
    return 'weak-token';
  }
  const token = requested === '' ? generateApiToken() : requested;

  // 先原子占位、再落盘：并发初始化时只有第一个请求能通过 `configure`，
  // 后来者在这里拿到 409，**绝不再覆写**已被第一个请求写下的密钥文件。
  if (!authority.configure(token)) {
    ctx.status = 409;
    ctx.type = 'application/json; charset=utf-8';
    ctx.body = { error: 'already-initialized' };
    return 'already-configured';
  }

  const persisted = await writeApiTokenFile(options.file, token);
  if (!persisted) {
    // 落盘失败必须退回占位：否则内存里「已配置」而磁盘上没有密钥，重启后面板再也回不到初始化。
    authority.revertConfiguration(token);
    ctx.status = 500;
    ctx.type = 'application/json; charset=utf-8';
    ctx.body = { error: 'persist-failed', message: `无法写入密钥文件：${options.file}` };
    return 'persist-failed';
  }
  const session = authority.login(token);
  if (session === undefined) {
    ctx.status = 500;
    ctx.type = 'application/json; charset=utf-8';
    ctx.body = { error: 'session-failed' };
    return 'persist-failed';
  }
  ctx.set?.('Set-Cookie', sessionCookie(session, authority.ttl));
  ctx.set?.('Cache-Control', 'no-store');
  ctx.type = 'application/json; charset=utf-8';
  ctx.status = 200;
  ctx.body = {
    initialized: true,
    generated: requested === '',
    token,
    tokenPath: options.file,
    session: session.id,
    expiresAt: session.expiresAt,
    ttl: authority.ttl,
  };
  return 'ok';
}
