import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Config,
  PatchouliKnowledgeSystem,
  albumCachePath,
  installTargetTables,
  readAlbumCache,
  readSubscriptionOverride,
  readTargetBindings,
  registerWebUi,
  settingsPath,
  writeAlbumCache,
  writeSubscriptionOverride,
} from '../lib/index.js';
import { entryTargetsFor } from '../lib/plugin/subscriptions.js';

const API_TOKEN = 'subs-http-test-token';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Koa Router 替身：`use` 必须存在，否则插件按 fail closed 跳过全部 `/api/*` 路由，
 * 测试就会「全是 404」而看不出真问题。守卫和线上一样真实串进请求链。
 */
function createRouterDouble() {
  const routes = new Map();
  const middlewares = [];
  const router = {
    use: (prefix, middleware) => {
      middlewares.push({ prefix, middleware });
    },
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  };

  const request = async (key, kCtx) => {
    const handler = routes.get(key);
    if (handler === undefined) return undefined;
    const routePath = key.slice(key.indexOf(' ') + 1);
    const applicable = middlewares.filter(({ prefix }) => routePath === prefix || routePath.startsWith(`${prefix}/`));
    let index = -1;
    const dispatch = async () => {
      index += 1;
      if (index < applicable.length) return applicable[index].middleware(kCtx, dispatch);
      return handler(kCtx);
    };
    return dispatch();
  };

  return { router, routes, request };
}

/** 带长期令牌的 Koa 上下文（守卫只认 `x-api-token` / Bearer / Cookie）。 */
function koaCtx({ body, query = {} } = {}) {
  return {
    params: {},
    query,
    headers: { 'x-api-token': API_TOKEN },
    request: { body, headers: { 'x-api-token': API_TOKEN } },
    status: 200,
    body: undefined,
    set: () => {},
  };
}

async function makeWiki() {
  return mkdtemp(path.join(tmpdir(), 'patchouli-subs-http-'));
}

/** 起一个真 system（覆盖层 / 编译 / 落盘全走真实现），返回路由替身。 */
async function boot({ wikiDir, subscriptions = [], channels = [], probeAlbums }) {
  const config = Config({
    storage: { wikiDir },
    security: { apiToken: API_TOKEN },
    subscriptions,
    advanced: { channels },
  });
  const system = new PatchouliKnowledgeSystem(config, quiet);
  await system.ready;
  const { router, routes, request } = createRouterDouble();
  registerWebUi({ router }, system, '/patchouli', probeAlbums === undefined ? {} : { probeAlbums });
  return { config, system, routes, request };
}

const album = (groupId, albumId, groupName = `群${groupId}`, albumName = `相册${albumId}`) => ({
  groupId,
  groupName,
  albumId,
  albumName,
});

test('SUBS-HTTP-01: GET /api/albums 缓存优先，不触发探测', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await boot({
    wikiDir,
    probeAlbums: async () => {
      throw new Error('缓存命中时不得探测');
    },
  });
  try {
    await writeAlbumCache(wikiDir, [album('100000001', 'ALBUM01', '图书室', '周报相册')]);

    const ctx = koaCtx();
    await request('GET /patchouli/api/albums', ctx);
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.albums.length, 1);
    assert.deepEqual(ctx.body.albums[0], {
      value: '100000001/ALBUM01',
      groupId: '100000001',
      groupName: '图书室',
      albumId: 'ALBUM01',
      albumName: '周报相册',
      label: '图书室 / 周报相册',
    });
    assert.equal(typeof ctx.body.probedAt, 'number');
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-02: GET /api/albums 缓存为空时探测一次并回写缓存', async () => {
  const wikiDir = await makeWiki();
  let calls = 0;
  const { system, request } = await boot({
    wikiDir,
    probeAlbums: async () => {
      calls += 1;
      return [album('100000001', 'ALBUM01')];
    },
  });
  try {
    const ctx = koaCtx();
    await request('GET /patchouli/api/albums', ctx);
    assert.equal(ctx.status, 200);
    assert.equal(calls, 1, '缓存为空时探测恰好一次');
    assert.deepEqual(ctx.body.albums.map((item) => item.value), ['100000001/ALBUM01']);
    assert.equal(typeof ctx.body.probedAt, 'number');
    assert.deepEqual(
      (await readAlbumCache(wikiDir)).map((item) => item.albumId),
      ['ALBUM01'],
      '探测结果必须回写缓存（下次打开不再探测）',
    );

    // 第二轮走缓存：不再探测
    const again = koaCtx();
    await request('GET /patchouli/api/albums', again);
    assert.equal(calls, 1, '第二次请求必须命中缓存');
    assert.equal(again.body.albums.length, 1);
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-03: GET /api/albums 探测失败降级为空白目录，不 500', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await boot({
    wikiDir,
    probeAlbums: async () => {
      throw new Error('miyako-delivery 掉线');
    },
  });
  try {
    const ctx = koaCtx();
    await request('GET /patchouli/api/albums', ctx);
    assert.equal(ctx.status, 200, '探测失败绝不打成 500');
    assert.deepEqual(ctx.body, { albums: [], probedAt: null });
    assert.equal(
      await fs
        .access(albumCachePath(wikiDir))
        .then(() => true)
        .catch(() => false),
      false,
      '探测失败不得写空缓存（否则下一轮会把「无结果」当成已知状态）',
    );
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-04: GET /api/subscriptions 没有覆盖层时读 config，旧单值归一成 targets', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await boot({
    wikiDir,
    subscriptions: [{ source: '123', target: '123/A1', entry: true, weekly: false }],
  });
  try {
    await writeAlbumCache(wikiDir, [album('123', 'A1')]);
    const ctx = koaCtx();
    await request('GET /patchouli/api/subscriptions', ctx);
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.source, 'config', '未写覆盖层时来源是宿主配置');
    assert.deepEqual(ctx.body.rows, [{ source: '123', targets: ['123/A1'], entry: true, weekly: false }]);
    assert.deepEqual(ctx.body.albums.map((item) => item.value), ['123/A1'], 'GET 顺带带上相册目录');
    assert.equal(typeof ctx.body.probedAt, 'number');
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-05: POST /api/subscriptions 落覆盖层、立即生效，且不影响宿主 config 与其它覆盖段', async () => {
  const wikiDir = await makeWiki();
  const { config, system, request } = await boot({
    wikiDir,
    channels: ['999'],
    subscriptions: [{ source: '999', targets: ['@chat'], entry: true, weekly: false }],
  });
  try {
    await writeAlbumCache(wikiDir, [album('123', 'A1')]);
    // 先写一个标量段，验证两条写路径同住一个文件时互不抹除
    const section = await system.updateSettings('query', { cardMaxHeight: 8200 });
    assert.equal(section.ok, true);
    const before = JSON.stringify(config);

    const post = koaCtx({
      body: { rows: [{ source: '123', targets: ['@chat', '123/A1', '123/A1'], entry: true, weekly: false }] },
    });
    await request('POST /patchouli/api/subscriptions', post);
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.deepEqual(post.body, {
      ok: true,
      rows: [{ source: '123', targets: ['@chat', '123/A1'], entry: true, weekly: false }],
      unresolved: [],
    });

    const raw = JSON.parse(await readFile(settingsPath(wikiDir), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.sections.query, { cardMaxHeight: 8200 }, '写订阅表不得抹掉标量段');
    assert.deepEqual(raw.subscriptions, [{ source: '123', targets: ['@chat', '123/A1'], entry: true, weekly: false }]);
    assert.deepEqual(await readSubscriptionOverride(wikiDir), raw.subscriptions, '重启后能读回同一张表');

    assert.equal(JSON.stringify(config), before, '绝不写宿主 config（ADR-022）');
    // 宿主 config 的 `targets` 是**静态** const union（模块加载期读一次 koishi.yml + 相册缓存），
    // 所以测试这里只能用候选里一定有的 `@chat`；重点是面板写入不改宿主 config。
    assert.deepEqual(config.subscriptions[0].targets, ['@chat'], 'config 里的表保持原样');

    // 运行时立刻生效：监听范围换成了新表，旧白名单群不再监听
    const snapshot = system.subscriptions();
    assert.equal(snapshot.listening.has('123'), true);
    assert.equal(snapshot.listening.has('999'), false);

    const get = koaCtx();
    await request('GET /patchouli/api/subscriptions', get);
    assert.equal(get.body.source, 'settings');
    assert.deepEqual(get.body.rows, post.body.rows);

    // 再写一次标量段：订阅表要原样保留
    const again = await system.updateSettings('query', { cardMaxHeight: 7000 });
    assert.equal(again.ok, true);
    const raw2 = JSON.parse(await readFile(settingsPath(wikiDir), 'utf8'));
    assert.deepEqual(raw2.subscriptions, raw.subscriptions, '标量段写入不得抹掉订阅表');
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-06: POST /api/subscriptions 拒绝非法载荷（400）', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await boot({ wikiDir });
  try {
    await writeAlbumCache(wikiDir, [album('123', 'A1')]);

    const bad = [
      [{ notRows: true }, /需要 \{ rows/u],
      [{ rows: null }, /数组/u],
      [{ rows: [{ source: '', targets: ['@chat'], entry: true, weekly: false }] }, /source 不能为空/u],
      [{ rows: [{ source: '*', targets: ['456'], entry: true, weekly: false }] }, /target 只能是/u],
      [{ rows: [{ source: '*', targets: ['@chat'], entry: true, weekly: false }] }, /`\*` 行不支持本群聊天/u],
      [{ rows: [{ source: '*', targets: ['123/A1', '@chat'], entry: true, weekly: false }] }, /请指定具体群/u],
      [{ rows: [{ source: '*', targets: ['456/A9'], entry: true, weekly: false }] }, /未在探测结果中/u],
      [{ rows: [{ source: '*', targets: ['123/A1'], entry: 1, weekly: false }] }, /entry 必须是布尔值/u],
      [{ rows: [{ source: '*', targets: '123/A1', entry: true, weekly: false }] }, /targets 必须是数组/u],
      [
        { rows: [{ source: '*', targets: Array.from({ length: 17 }, (_, i) => `123/A${i}`), entry: true, weekly: false }] },
        /目标最多 16 个/u,
      ],
      [
        { rows: Array.from({ length: 257 }, () => ({ source: '*', targets: [], entry: true, weekly: false })) },
        /最多 256 行/u,
      ],
    ];
    for (const [body, pattern] of bad) {
      const ctx = koaCtx({ body });
      await request('POST /patchouli/api/subscriptions', ctx);
      assert.equal(ctx.status, 400, `必须拒绝：${JSON.stringify(body).slice(0, 80)}`);
      assert.equal(ctx.body.ok, false);
      assert.match(ctx.body.error, pattern);
    }

    // 全部被拒 → 文件不该出现订阅表覆盖
    assert.equal(
      await fs
        .access(settingsPath(wikiDir))
        .then(() => true)
        .catch(() => false),
      false,
      '校验失败不得落盘',
    );
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-07: 相册目录为空时 POST 只做形状校验（探测不可用也不能把面板写死）', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await boot({ wikiDir });
  try {
    const ok = koaCtx({ body: { rows: [{ source: '123', targets: ['456/A9'], entry: true, weekly: false }] } });
    await request('POST /patchouli/api/subscriptions', ok);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const groupChat = koaCtx({ body: { rows: [{ source: '123', targets: ['456'], entry: true, weekly: false }] } });
    await request('POST /patchouli/api/subscriptions', groupChat);
    assert.equal(groupChat.status, 400, '裸群号不再是合法目标（请用 @chat）');
    assert.match(groupChat.body.error, /target 只能是/u);
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-08: 覆盖层优先于 config，且并发 POST 串行落盘不互相覆盖', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await boot({
    wikiDir,
    subscriptions: [{ source: '999', targets: ['@chat'], entry: true, weekly: false }],
  });
  try {
    const firstRows = [{ source: '111', targets: ['@chat'], entry: true, weekly: false }];
    const secondRows = [{ source: '222', targets: ['@chat'], entry: false, weekly: true }];
    const first = koaCtx({ body: { rows: firstRows } });
    const second = koaCtx({ body: { rows: secondRows } });
    // 两个请求同时发出：谁最后落盘由各自的相册目录读完成先后决定（不保证与发出顺序一致），
    // 但队列必须保证落盘的是**某一次提交的整份结果**，绝不是合并 / 半截 / 空表。
    await Promise.all([
      request('POST /patchouli/api/subscriptions', first),
      request('POST /patchouli/api/subscriptions', second),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const stored = await readSubscriptionOverride(wikiDir);
    assert.ok(
      JSON.stringify(stored) === JSON.stringify(firstRows) ||
        JSON.stringify(stored) === JSON.stringify(secondRows),
      `串行落盘只接受整份提交，实际：${JSON.stringify(stored)}`,
    );
    const get = koaCtx();
    await request('GET /patchouli/api/subscriptions', get);
    assert.equal(get.body.source, 'settings');
    assert.deepEqual(get.body.rows, stored);
    assert.equal(system.subscriptions().listening.has('999'), false, '覆盖层整段顶替 config');
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-09: 保存成功后触发 onSubscriptionsChanged（控制台候选重注入），失败不触发', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await boot({ wikiDir });
  try {
    let fired = 0;
    system.onSubscriptionsChanged = () => {
      fired += 1;
    };

    // 400 路径：校验失败不落盘，也不能让控制台以为表变了。
    const rejected = koaCtx({ body: { rows: [{ source: '', targets: [], entry: true, weekly: false }] } });
    await request('POST /patchouli/api/subscriptions', rejected);
    assert.equal(rejected.status, 400);
    assert.equal(fired, 0, '校验失败不得触发重注入');

    const saved = koaCtx({
      body: { rows: [{ source: '100000001', targets: ['@chat', '100000001/ALBUM01'], entry: true, weekly: false }] },
    });
    await request('POST /patchouli/api/subscriptions', saved);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(fired, 1, '保存成功必须重注入一次候选');

    // 生效表里的新目标必须原样落进 snapshot（控制台 `targets` 的候选是启动期静态 union，
    // 面板保存不走 Config，因此任意已探测相册值都必须能存进覆盖层）。
    assert.deepEqual(system.subscriptionTable().rows[0].targets, ['@chat', '100000001/ALBUM01']);
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test('SUBS-HTTP-10: 批量校准目标群 = 订阅来源群（config.channels 不参与，总闸关掉为空）', async () => {
  const wikiDir = await makeWiki();
  const { system } = await boot({
    wikiDir,
    subscriptions: [{ source: '300001', targets: [], entry: true, weekly: false }],
    channels: ['100000009'],
  });
  try {
    assert.equal(system.subscriptions().active, true);
    assert.deepEqual(
      await system.topicTargets(),
      ['300001'],
      '订阅表生效时只跑订阅来源群：config.channels 里的旧群不得被批量校准顺手烧一遍',
    );
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }

  // 表为空：沿用旧白名单（升级前的行为不变）
  const legacyDir = await makeWiki();
  const legacy = new PatchouliKnowledgeSystem(
    Config({ storage: { wikiDir: legacyDir }, advanced: { channels: ['100000009'] } }),
    quiet,
  );
  await legacy.ready;
  try {
    assert.deepEqual(await legacy.topicTargets(), ['100000009'], '表为空时沿用旧白名单');
  } finally {
    legacy.dispose();
    await rm(legacyDir, { recursive: true, force: true });
  }

  // 功能总闸关掉：没有目标（定时轮空，管理入口的批量校准同样不跑）
  const offDir = await makeWiki();
  const off = new PatchouliKnowledgeSystem(
    Config({ storage: { wikiDir: offDir }, features: { topics: false } }),
    quiet,
  );
  await off.ready;
  try {
    assert.deepEqual(await off.topicTargets(), [], 'features.topics === false 时目标为空');
  } finally {
    off.dispose();
    await rm(offDir, { recursive: true, force: true });
  }
});

test('BIND-04: 保存时绑定落盘、首轮迁移一次性写入且幂等', async () => {
  const wikiDir = await makeWiki();
  const cached = [album('100000001', 'ALBUM01', '图书室', '周报相册')];
  const subscriptions = [{ source: '100000001', targets: ['周报相册'], entry: true, weekly: false }];
  const install = (system, albums) =>
    installTargetTables({ albums, configured: [], bindings: system.targetBindingsSnapshot() });
  try {
    await writeAlbumCache(wikiDir, cached);
    // 订阅表走覆盖层：宿主 config 的 `targets` 是模块加载期定死的 const union，
    // 测试进程里没有这个相册名，写进 config 会被 Schema 拒绝（与线上无关）。
    await writeSubscriptionOverride(wikiDir, subscriptions);

    // ① 首轮迁移：绑定表为空 + 订阅表里有名字 → 用当前候选**一次性**写入 settings.json。
    const first = await boot({ wikiDir });
    try {
      assert.deepEqual(
        await readTargetBindings(wikiDir),
        { 周报相册: '100000001/ALBUM01' },
        '名字 → 稳定地址写进顶层 targetBindings',
      );
      const raw = JSON.parse(await readFile(settingsPath(wikiDir), 'utf8'));
      assert.equal(raw.version, 1);
      assert.deepEqual(raw.targetBindings, { 周报相册: '100000001/ALBUM01' });
      assert.deepEqual(raw.subscriptions, subscriptions, '迁移只补绑定，不动订阅表');
      install(first.system, cached);
      assert.deepEqual(entryTargetsFor(first.system.subscriptions(), '100000001'), [
        { kind: 'album', channelId: 'onebot:100000001', albumId: 'ALBUM01' },
      ]);
    } finally {
      first.system.dispose();
    }

    // ② 幂等：绑定表非空 → 再启动不重写文件。
    const before = await readFile(settingsPath(wikiDir), 'utf8');
    const second = await boot({ wikiDir });
    try {
      assert.equal(await readFile(settingsPath(wikiDir), 'utf8'), before, '绑定表非空 → 迁移不再落盘');
      assert.deepEqual(second.system.targetBindingsSnapshot(), { 周报相册: '100000001/ALBUM01' });
    } finally {
      second.system.dispose();
    }

    // ③ 新群出现同名相册：已有绑定不被自动改写，旧订阅仍投老地址（不追新同名相册）。
    const newcomer = [album('100000002', 'ALBUM09', '阅览室', '周报相册')];
    await writeAlbumCache(wikiDir, newcomer);
    const third = await boot({ wikiDir });
    try {
      assert.deepEqual(
        await readTargetBindings(wikiDir),
        { 周报相册: '100000001/ALBUM01' },
        '已有绑定不被自动改写',
      );
      install(third.system, newcomer);
      assert.deepEqual(
        entryTargetsFor(third.system.subscriptions(), '100000001'),
        [{ kind: 'album', channelId: 'onebot:100000001', albumId: 'ALBUM01' }],
        '绑定过的名字继续投原地址',
      );

      // ④ 面板保存：老相册已不在候选里 → 掉绑 + unresolved（停投 + 告警），绝不给新同名相册当替身。
      const post = koaCtx({ body: { rows: subscriptions } });
      await third.request('POST /patchouli/api/subscriptions', post);
      assert.equal(post.status, 200, JSON.stringify(post.body));
      assert.deepEqual(post.body.unresolved, ['周报相册']);
      assert.deepEqual(await readTargetBindings(wikiDir), {}, '解析不到 → 掉绑，不猜同名相册');
      const raw = JSON.parse(await readFile(settingsPath(wikiDir), 'utf8'));
      assert.deepEqual(raw.targetBindings, undefined, '空绑定表不写键（缺失 = 尚未绑定）');
      assert.deepEqual(raw.subscriptions, subscriptions, '行本身原样落盘（名字保留，由面板提示重选）');
      install(third.system, newcomer);
      assert.deepEqual(entryTargetsFor(third.system.subscriptions(), '100000001'), [], '未绑定即停投');

      // ⑤ 重启：迁移标记已落盘 → 不得再拿当前候选（同名新相册）重新解析。
      const cleared = await readFile(settingsPath(wikiDir), 'utf8');
      const fourth = await boot({ wikiDir });
      try {
        assert.equal(
          await readFile(settingsPath(wikiDir), 'utf8'),
          cleared,
          '删光绑定后的重启不得再写绑定表',
        );
        assert.deepEqual(await readTargetBindings(wikiDir), {}, '同名新相册不得被自动绑定');
        install(fourth.system, newcomer);
        assert.deepEqual(
          entryTargetsFor(fourth.system.subscriptions(), '100000001'),
          [],
          '保持未绑定 = 停投 + 面板提示重选，绝不改投另一个群的同名相册',
        );
      } finally {
        fourth.system.dispose();
      }
    } finally {
      third.system.dispose();
    }
  } finally {
    await rm(wikiDir, { recursive: true, force: true });
  }
});
