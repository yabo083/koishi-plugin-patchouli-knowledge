import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  TokenAuthority,
  createApiGuard,
  allowsBootstrapFrom,
  handleBootstrap,
  handleLogin,
  isPrivateAddress,
  handleLogout,
  handleSession,
  readApiTokenFile,
  SESSION_COOKIE_NAME,
} from '../lib/web/auth.js';

const TOKEN = 's3cret-api-token';

/** 可控时钟，便于测过期与滑动续期。 */
function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('AUTH-01: 未配置长期令牌时一切失败（fail closed）', () => {
  const authority = new TokenAuthority('');
  assert.equal(authority.configured, false);
  assert.equal(authority.login(TOKEN), undefined);
  assert.deepEqual(authority.authorize({ headers: { authorization: `Bearer ${TOKEN}` } }), {
    ok: false,
    reason: 'unconfigured',
  });
});

test('AUTH-02: 登录用长期令牌换会话，会话可经 Cookie 或 Bearer 使用', () => {
  const authority = new TokenAuthority(TOKEN);
  const session = authority.login(TOKEN);
  assert.ok(session && session.id.length === 64, '须为 32 字节随机十六进制');
  assert.equal(session.expiresAt - session.createdAt, authority.ttl);

  const viaCookie = authority.authorize({ headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` } });
  assert.equal(viaCookie.ok, true);
  assert.equal(viaCookie.via, 'session');

  const viaBearer = authority.authorize({ headers: { authorization: `Bearer ${session.id}` } });
  assert.equal(viaBearer.ok, true);
});

test('AUTH-03: 错误长期令牌 / 未知会话 / 无凭据分别归类', () => {
  const authority = new TokenAuthority(TOKEN);
  assert.equal(authority.login('wrong'), undefined);
  assert.deepEqual(authority.authorize({}), { ok: false, reason: 'missing' });
  assert.deepEqual(authority.authorize({ headers: { authorization: 'Bearer nope' } }), {
    ok: false,
    reason: 'invalid',
  });
});

test('AUTH-04: 长期令牌仍可用于运维直连（curl / 探针）', () => {
  const authority = new TokenAuthority(TOKEN);
  const result = authority.authorize({ headers: { 'x-api-token': TOKEN } });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'token');
  assert.equal(authority.authorize({ query: { token: TOKEN } }).ok, true);
});

test('AUTH-05: 会话过期即拒绝，且过半后自动滑动续期', () => {
  const time = clock();
  const authority = new TokenAuthority(TOKEN, { ttlMs: 1000, now: time.now });
  const session = authority.login(TOKEN);
  const headers = { authorization: `Bearer ${session.id}` };

  time.advance(400); // 未过半
  assert.equal(authority.authorize({ headers }).ok, true);

  time.advance(400); // 已过半 → 续满
  assert.equal(authority.authorize({ headers }).ok, true);
  assert.equal(authority.sessionOf(session.id).expiresAt, time.now() + 1000);

  time.advance(1200); // 超过续期后的有效期
  assert.deepEqual(authority.authorize({ headers }), { ok: false, reason: 'expired' });
});

test('AUTH-06: 登出吊销会话；cookie 与 bearer 都指向同一票据', () => {
  const authority = new TokenAuthority(TOKEN);
  const session = authority.login(TOKEN);
  assert.equal(authority.logout(session.id), true);
  assert.equal(authority.logout(session.id), false, '重复登出幂等');
  assert.equal(authority.authorize({ headers: { authorization: `Bearer ${session.id}` } }).ok, false);
  assert.equal(authority.size, 0);
});

test('AUTH-07: 守卫对未授权请求回 401 且短路，授权后放行', async () => {
  const authority = new TokenAuthority(TOKEN);
  const guard = createApiGuard(authority);

  const denied = { status: 200, headers: {}, type: '', body: undefined };
  let reached = false;
  await guard(denied, async () => { reached = true; });
  assert.equal(denied.status, 401);
  assert.equal(reached, false);
  assert.deepEqual(denied.body, { error: 'unauthorized', reason: 'missing' });

  const session = authority.login(TOKEN);
  const allowed = { status: 200, headers: { authorization: `Bearer ${session.id}` } };
  await guard(allowed, async () => { reached = true; });
  assert.equal(reached, true);
  assert.equal(allowed.status, 200);
});

test('AUTH-08: 登录返回短票据与到期时间并写 HttpOnly Cookie；登出清 Cookie', () => {
  const authority = new TokenAuthority(TOKEN);
  const ctx = { headers: {}, status: 0, set: (name, value) => { ctx[name] = value; } };
  assert.equal(handleLogin(ctx, authority, { token: TOKEN }), true);
  assert.equal(ctx.status, 200);
  const body = ctx.body;
  assert.ok(typeof body.session === 'string' && body.session.length === 64);
  assert.equal(typeof body.expiresAt, 'number');
  assert.match(String(ctx['Set-Cookie']), /HttpOnly/u);
  assert.match(String(ctx['Set-Cookie']), /SameSite=Strict/u);
  assert.ok(!String(ctx['Set-Cookie']).includes(TOKEN), 'Cookie 里绝不能出现长期令牌');

  const out = { headers: { cookie: `${SESSION_COOKIE_NAME}=${body.session}` }, status: 0, set: (n, v) => { out[n] = v; } };
  handleLogout(out, authority);
  assert.equal(out.status, 204);
  assert.match(String(out['Set-Cookie']), /Max-Age=0/u);
  assert.equal(authority.sessionOf(body.session), undefined);
});

test('AUTH-09: /session 自检区分已认证、过期与未配置', () => {
  const authority = new TokenAuthority(TOKEN, { ttlMs: 1000 });
  const probe = (headers) => {
    const ctx = { headers, status: 0, set: () => {} };
    handleSession(ctx, authority);
    return ctx.body;
  };
  assert.deepEqual(probe({}).authenticated, false);

  const session = authority.login(TOKEN);
  const ok = probe({ authorization: `Bearer ${session.id}` });
  assert.equal(ok.authenticated, true);
  assert.equal(ok.expiresAt, session.expiresAt);

  const empty = new TokenAuthority('');
  const ctx = { headers: {}, status: 0, set: () => {} };
  handleSession(ctx, empty);
  assert.equal(ctx.body.configured, false);
});

test('AUTH-10: 会话表有上限，超出时淘汰最早到期的', () => {
  const authority = new TokenAuthority(TOKEN, { maxSessions: 3 });
  const sessions = [1, 2, 3, 4].map(() => authority.login(TOKEN));
  assert.equal(authority.size, 3, '最多保留 3 个会话');
  assert.equal(authority.sessionOf(sessions[0].id), undefined, '最早的被淘汰');
  assert.ok(authority.sessionOf(sessions[3].id));
});

test('AUTH-11: 首次初始化生成密钥并落盘，当场签发会话', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pk-token-'));
  const file = path.join(dir, 'api-token.txt');
  const authority = new TokenAuthority('');
  const ctx = { status: 0, ip: '127.0.0.1', headers: {}, set: (n, v) => { ctx[n] = v; } };

  assert.equal(await handleBootstrap(ctx, authority, {}, { file }), 'ok');
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.generated, true);
  assert.equal(ctx.body.token.length, 64, '默认生成 32 字节十六进制');
  assert.equal(authority.configured, true);
  assert.match(String(ctx['Set-Cookie']), /HttpOnly/u);

  const persisted = (await readFile(file, 'utf8')).trim();
  assert.equal(persisted, ctx.body.token);
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600, '密钥文件必须 0600（Windows 无 POSIX 权限位）');
  }

  const session = ctx.body.session;
  assert.equal(authority.authorize({ headers: { authorization: `Bearer ${session}` } }).ok, true);
  await rm(dir, { recursive: true, force: true });
});

test('AUTH-12: 初始化接受自定义密钥（≥16 字符），过短拒绝', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pk-token-'));
  const file = path.join(dir, 'api-token.txt');

  const weak = new TokenAuthority('');
  const weakCtx = { status: 0, ip: '127.0.0.1', headers: {}, set: () => {} };
  assert.equal(await handleBootstrap(weakCtx, weak, { token: 'short' }, { file }), 'weak-token');
  assert.equal(weakCtx.status, 400);
  assert.equal(weak.configured, false, '弱密钥不得落定');

  const ok = new TokenAuthority('');
  const okCtx = { status: 0, ip: '10.0.0.5', headers: {}, set: () => {} };
  assert.equal(await handleBootstrap(okCtx, ok, { token: 'a-sufficiently-long-token' }, { file }), 'ok');
  assert.equal(okCtx.body.generated, false);
  assert.equal(await readApiTokenFile(file), 'a-sufficiently-long-token');
  await rm(dir, { recursive: true, force: true });
});

test('AUTH-13: 已配置后初始化返回 409，不会被第二个请求顶掉', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pk-token-'));
  const file = path.join(dir, 'api-token.txt');
  const authority = new TokenAuthority(TOKEN);
  const ctx = { status: 0, ip: '127.0.0.1', headers: {}, set: () => {} };
  assert.equal(await handleBootstrap(ctx, authority, { token: 'another-long-token-here' }, { file }), 'already-configured');
  assert.equal(ctx.status, 409);
  assert.equal(authority.authorize({ headers: { 'x-api-token': TOKEN } }).ok, true, '原密钥仍然有效');
  await rm(dir, { recursive: true, force: true });
});

test('AUTH-14: 重启后用落盘密钥恢复（配置留空也能工作）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pk-token-'));
  const file = path.join(dir, 'api-token.txt');
  const first = new TokenAuthority('');
  const ctx = { status: 0, ip: '127.0.0.1', headers: {}, set: () => {} };
  await handleBootstrap(ctx, first, {}, { file });

  const restored = await readApiTokenFile(file);
  const second = new TokenAuthority(restored ?? '');
  assert.equal(second.configured, true);
  assert.equal(await handleBootstrap({ status: 0, ip: '127.0.0.1', headers: {}, set: () => {} }, second, {}, { file }), 'already-configured');
  await rm(dir, { recursive: true, force: true });
});

test('AUTH-15: /session 在未配置时报告 bootstrapRequired', () => {
  const empty = new TokenAuthority('');
  const ctx = { headers: {}, status: 0, set: () => {} };
  handleSession(ctx, empty);
  assert.equal(ctx.body.bootstrapRequired, true);
  assert.equal(ctx.body.configured, false);
});

test('AUTH-16: 私网/回环地址判定（IPv4、IPv6、映射地址）', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.9', '192.168.1.7', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.2']) {
    assert.equal(isPrivateAddress(address), true, `${address} 应判为私网`);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2001:db8::1', '', undefined, 'not-an-ip', '999.1.1.1']) {
    assert.equal(isPrivateAddress(address), false, `${String(address)} 应判为非私网`);
  }
});

test('AUTH-17: 首次初始化只允许本机/内网；公网或透传公网一律 423', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pk-token-'));
  const file = path.join(dir, 'api-token.txt');

  assert.equal(allowsBootstrapFrom({ ip: '127.0.0.1' }), true);
  assert.equal(allowsBootstrapFrom({ ip: '192.168.0.10' }), true);
  assert.equal(allowsBootstrapFrom({ ip: '8.8.8.8' }), false);
  assert.equal(allowsBootstrapFrom({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8' } }), false, '反代透传的公网客户端不得初始化');
  assert.equal(allowsBootstrapFrom({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '192.168.0.9' } }), true);

  const authority = new TokenAuthority('');
  const remote = { status: 0, ip: '8.8.8.8', headers: {}, set: () => {} };
  assert.equal(await handleBootstrap(remote, authority, {}, { file }), 'blocked-remote');
  assert.equal(remote.status, 423);
  assert.equal(authority.configured, false, '被拒绝时不得落定密钥');

  const tunneled = { status: 0, ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' }, set: () => {} };
  assert.equal(await handleBootstrap(tunneled, authority, {}, { file }), 'blocked-remote');

  await rm(dir, { recursive: true, force: true });
});

test('AUTH-18: 直连对端非 loopback 时 XFF 不可采信（自填 127.0.0.1 不能换到密钥）', async () => {
  // 公网直连 + 伪造 XFF：XFF 一律不看
  assert.equal(
    allowsBootstrapFrom({ ip: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } }),
    false,
    '公网直连自填 XFF 不得放行',
  );
  // 内网直连（反代在别的机器上）：XFF 不采信，只按直连对端判定
  assert.equal(
    allowsBootstrapFrom({ ip: '192.168.0.10', headers: { 'x-forwarded-for': '8.8.8.8' } }),
    true,
    '内网直连只判定对端；XFF 由客户端掌控，不参与决策',
  );
  // 同机反代（对端 loopback）：采信**最右**一跳，左侧伪造值不生效
  assert.equal(
    allowsBootstrapFrom({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' } }),
    false,
    '伪造在最左跳、真实客户端在最右跳时必须拒绝',
  );
  assert.equal(
    allowsBootstrapFrom({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8, 192.168.0.9' } }),
    true,
    '最右一跳为内网时放行',
  );
  assert.equal(
    allowsBootstrapFrom({ ip: '::1', headers: { 'x-forwarded-for': '203.0.113.9' } }),
    false,
    'IPv6 loopback 对端同样采信最右一跳',
  );

  // 端到端：伪造 XFF 的远程请求拿到 423，且内存里不得落定任何密钥
  const dir = await mkdtemp(path.join(tmpdir(), 'pk-token-'));
  const file = path.join(dir, 'api-token.txt');
  const authority = new TokenAuthority('');
  const spoofed = {
    status: 0,
    ip: '203.0.113.9',
    headers: { 'x-forwarded-for': '127.0.0.1' },
    set: () => {},
  };
  assert.equal(await handleBootstrap(spoofed, authority, {}, { file }), 'blocked-remote');
  assert.equal(spoofed.status, 423);
  assert.equal(authority.configured, false, '被拒时绝不能把密钥落定');
  assert.equal(await readApiTokenFile(file), undefined, '被拒时连文件都不该出现');
  await rm(dir, { recursive: true, force: true });
});

test('AUTH-19: 长期令牌直连的 /session 不回显令牌，会话路径照常回显短票据', () => {
  const authority = new TokenAuthority(TOKEN);

  const direct = { headers: { 'x-api-token': TOKEN }, status: 0, set: () => {} };
  handleSession(direct, authority);
  assert.equal(direct.body.authenticated, true);
  assert.equal(direct.body.via, 'token');
  assert.equal(direct.body.session, null, '运维凭据不得被回显给调用方');
  assert.equal(direct.body.expiresAt, null);

  const bearer = { headers: { authorization: `Bearer ${TOKEN}` }, status: 0, set: () => {} };
  handleSession(bearer, authority);
  assert.equal(bearer.body.via, 'token');
  assert.equal(bearer.body.session, null);

  const session = authority.login(TOKEN);
  const viaSession = { headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` }, status: 0, set: () => {} };
  handleSession(viaSession, authority);
  assert.equal(viaSession.body.via, 'session');
  assert.equal(viaSession.body.session, session.id, '短票据仍要回显，供前端续用');
});

test('AUTH-20: 并发初始化只有第一个请求生效，后来者 409 且不覆写已落盘密钥', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pk-token-'));
  const file = path.join(dir, 'api-token.txt');
  const authority = new TokenAuthority('');
  const makeCtx = () => ({ status: 0, ip: '127.0.0.1', headers: {}, set: () => {} });
  const first = makeCtx();
  const second = makeCtx();

  const [firstResult, secondResult] = await Promise.all([
    handleBootstrap(first, authority, { token: 'first-sufficiently-long-token' }, { file }),
    handleBootstrap(second, authority, { token: 'second-sufficiently-long-token' }, { file }),
  ]);

  assert.equal(firstResult, 'ok');
  assert.equal(secondResult, 'already-configured');
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { error: 'already-initialized' });
  assert.equal(
    await readApiTokenFile(file),
    'first-sufficiently-long-token',
    '第二个请求不得覆写第一个请求写下的密钥文件',
  );
  assert.equal(authority.authorize({ headers: { 'x-api-token': 'second-sufficiently-long-token' } }).ok, false);
  await rm(dir, { recursive: true, force: true });
});

test('AUTH-21: 落盘失败时退回占位，面板仍可再次初始化', async () => {
  const authority = new TokenAuthority('');
  const ctx = { status: 0, ip: '127.0.0.1', headers: {}, set: () => {} };

  // 空路径必然写不进去 → 500，且内存里的占位必须撤销
  assert.equal(await handleBootstrap(ctx, authority, { token: 'a-sufficiently-long-token' }, { file: '' }), 'persist-failed');
  assert.equal(ctx.status, 500);
  assert.equal(authority.configured, false, '落盘失败不得留下「已配置」的幽灵状态');

  const dir = await mkdtemp(path.join(tmpdir(), 'pk-token-'));
  const file = path.join(dir, 'api-token.txt');
  const retry = { status: 0, ip: '127.0.0.1', headers: {}, set: () => {} };
  assert.equal(await handleBootstrap(retry, authority, { token: 'a-sufficiently-long-token' }, { file }), 'ok');
  await rm(dir, { recursive: true, force: true });
});

test('AUTH-22: 会话表落盘——重启后同一票据仍然有效（不再要求重新登录）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'patchouli-session-'));
  const file = path.join(dir, 'sessions.json');
  const now = () => 1_700_000_000_000;

  const first = new TokenAuthority(TOKEN, { sessionsFile: file, now });
  const session = first.login(TOKEN);
  assert.ok(session);
  await first.flush();

  // 模拟进程重启：同一令牌、同一文件。
  const restarted = new TokenAuthority(TOKEN, { sessionsFile: file, now });
  const result = restarted.authorize({ headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` } });
  assert.equal(result.ok, true, '重启后同一票据必须仍然有效');
  assert.equal(result.via, 'session');

  // 文件里不得出现票据原文——只存 sha256。
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.includes(session.id), false, '落盘文件不得包含会话原文');
  assert.ok(raw.includes('"fingerprint"'));

  await rm(dir, { recursive: true, force: true });
});

test('AUTH-23: 落盘会话的有效期是 7 天，且令牌轮换会整批作废', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'patchouli-session-'));
  const file = path.join(dir, 'sessions.json');
  const now = () => 1_700_000_000_000;
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  const authority = new TokenAuthority(TOKEN, { sessionsFile: file, now });
  const session = authority.login(TOKEN);
  assert.equal(session.expiresAt - session.createdAt, WEEK, '默认有效期为一周');
  await authority.flush();

  // 令牌轮换：指纹变化 → 旧票据整批作废（不能因为文件在就继续放行）。
  const rotated = new TokenAuthority('another-token-value', { sessionsFile: file, now });
  const denied = rotated.authorize({ headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` } });
  assert.equal(denied.ok, false, '换令牌后旧票据必须失效');

  // 过期条目在载入时丢弃。
  const later = new TokenAuthority(TOKEN, { sessionsFile: file, now: () => 1_700_000_000_000 + WEEK + 1 });
  const expired = later.authorize({ headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` } });
  assert.equal(expired.ok, false, '过期票据不得在重启后复活');

  await rm(dir, { recursive: true, force: true });
});
