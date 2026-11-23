import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Config,
  PatchouliKnowledgeSystem,
  SETTINGS_META,
  SETTINGS_SECTIONS,
  flattenConfig,
  readSettingsOverrides,
  readSettingsOverridesSync,
  registerWebUi,
  settingsPath,
  validateSettingsPatch,
  writeSettingsOverrides,
} from '../lib/index.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const makeWiki = () => mkdtemp(path.join(tmpdir(), 'patchouli-settings-'));

const cleanup = (wikiDir) => rm(wikiDir, { recursive: true, force: true });

test('SETTINGS-STORE-01: 原子写入 settings.json，读回等价、未知键丢弃、重复写幂等', async () => {
  const wikiDir = await makeWiki();
  try {
    const sections = await writeSettingsOverrides(wikiDir, 'trigger', {
      maxBufferMessages: 900,
      triggerMode: 'rate',
      bogusKey: 1,
    });
    assert.equal(sections.trigger.maxBufferMessages, 900);
    assert.equal(sections.trigger.triggerMode, 'rate');
    assert.equal('bogusKey' in sections.trigger, false, '未知键必须丢弃，不得落盘');

    // 文件契约：`{ version: 1, sections: { ... } }`，只存白名单字段。
    const raw = JSON.parse(await readFile(settingsPath(wikiDir), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.sections.trigger, { maxBufferMessages: 900, triggerMode: 'rate' });
    assert.equal(path.basename(settingsPath(wikiDir)), 'settings.json');
    assert.equal(path.basename(path.dirname(settingsPath(wikiDir))), '.patchouli');

    assert.deepEqual(await readSettingsOverrides(wikiDir), sections);
    assert.deepEqual(readSettingsOverridesSync(wikiDir), sections, '同步读取与异步读取必须同源');

    const again = await writeSettingsOverrides(wikiDir, 'trigger', {
      maxBufferMessages: 900,
      triggerMode: 'rate',
    });
    assert.deepEqual(again, sections, '重复写同样的值必须幂等（不产生新键）');
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-STORE-02: 非法值拒绝、未知段拒绝、未知键丢弃', () => {
  assert.equal(validateSettingsPatch('nope', {}).ok, false, '段名必须在白名单内');
  assert.equal(validateSettingsPatch('trigger', null).ok, false, 'patch 必须是对象');
  assert.equal(validateSettingsPatch('trigger', []).ok, false, 'patch 不得是数组');

  for (const bad of [NaN, Infinity, '900', true]) {
    const result = validateSettingsPatch('trigger', { maxBufferMessages: bad });
    assert.equal(result.ok, false, `${String(bad)} 必须被拒绝`);
    assert.match(result.error, /trigger\.maxBufferMessages/u);
  }
  assert.equal(validateSettingsPatch('trigger', { maxBufferMessages: 1 }).ok, false, '低于 min 必须拒绝');
  assert.equal(validateSettingsPatch('trigger', { maxBufferMessages: 999999 }).ok, false, '高于 max 必须拒绝');
  assert.equal(validateSettingsPatch('topics', { hour: 4.5 }).ok, false, 'step=1 只接受整数');
  assert.equal(validateSettingsPatch('topics', { hour: 26 }).ok, false);
  assert.equal(validateSettingsPatch('trigger', { triggerMode: 'shadow' }).ok, false, 'shadow 不是面板选项');
  assert.equal(validateSettingsPatch('trigger', { triggerMode: 'potential' }).ok, true);
  assert.equal(validateSettingsPatch('media', { offline: 'yes' }).ok, false);
  assert.equal(validateSettingsPatch('judge', { timeoutMs: -1 }).ok, false);

  const unknown = validateSettingsPatch('query', { cardMaxHeight: 6000, surprise: 1 });
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.value, { cardMaxHeight: 6000 }, '未知键静默丢弃，其余照常通过');
});

test('SETTINGS-STORE-03: 损坏文件 / 未知段 / 非法存值一律静默清洗', async () => {
  const wikiDir = await makeWiki();
  try {
    const target = settingsPath(wikiDir);
    await mkdir(path.dirname(target), { recursive: true });

    await writeFile(target, '{not json', 'utf8');
    assert.deepEqual(await readSettingsOverrides(wikiDir), {}, '损坏 JSON 当空表');

    await writeFile(target, JSON.stringify({ version: 2, sections: { trigger: { maxBufferMessages: 700 } } }), 'utf8');
    assert.deepEqual(await readSettingsOverrides(wikiDir), {}, '未知版本当空表');

    await writeFile(
      target,
      JSON.stringify({
        version: 1,
        sections: {
          trigger: { maxBufferMessages: 700, bogus: 'x', triggerMode: 'nope' },
          topics: { hour: 99 },
          billing: { enabled: true },
        },
      }),
      'utf8',
    );
    const stored = await readSettingsOverrides(wikiDir);
    assert.deepEqual(stored, { trigger: { maxBufferMessages: 700 } }, '只保留白名单内的合法值');
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-STORE-04: 覆盖层优先于 config，且回灌绝不写宿主 config', async () => {
  const wikiDir = await makeWiki();
  try {
    await writeSettingsOverrides(wikiDir, 'trigger', { maxBufferMessages: 900 });
    await writeSettingsOverrides(wikiDir, 'topics', { hour: 5 });
    await writeSettingsOverrides(wikiDir, 'query', { cardMaxHeight: 7200 });

    const config = Config({ storage: { wikiDir }, advanced: { trigger: { maxBufferMessages: 300 } } });
    const before = JSON.stringify(config);
    const system = new PatchouliKnowledgeSystem(config, quiet);
    try {
      await system.ready;
      assert.equal(system.settings('trigger').maxBufferMessages, 900, '覆盖层优先于 config');
      assert.equal(system.settings('topics').hour, 5);
      assert.equal(system.settings('query').cardMaxHeight, 7200);
      assert.equal(system.config.trigger.maxBufferMessages, 300, 'config 原值保持不动');
      assert.equal(JSON.stringify(config), before, '启动回灌不得写宿主 config（ADR-022）');

      const defaults = flattenConfig(Config({}));
      assert.equal(system.settings('media').lowWater, defaults.media.lowWater, '未覆盖段回落 Schema 默认值');
      assert.equal(system.settings('judge').enabled, false, '裁判默认关闭');
    } finally {
      system.dispose();
    }
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-STORE-05: updateSettings 落盘即生效，非法补丁返回 ok:false', async () => {
  const wikiDir = await makeWiki();
  try {
    const config = Config({ storage: { wikiDir } });
    const system = new PatchouliKnowledgeSystem(config, quiet);
    try {
      await system.ready;
      assert.equal(system.settings('query').cardMaxHeight, 6000, '默认长图上限');

      const ok = await system.updateSettings('query', { cardMaxHeight: 8000 });
      assert.equal(ok.ok, true);
      assert.equal(ok.section, 'query');
      assert.equal(ok.value.cardMaxHeight, 8000);
      assert.equal(system.settings('query').cardMaxHeight, 8000, '合并读取必须即时生效');
      assert.equal((await readSettingsOverrides(wikiDir)).query.cardMaxHeight, 8000, '必须落盘');

      const rejected = await system.updateSettings('query', { cardMaxHeight: '8000' });
      assert.equal(rejected.ok, false);
      assert.match(rejected.error, /query\.cardMaxHeight/u);

      const unknownSection = await system.updateSettings('dispatcher', {});
      assert.equal(unknownSection.ok, false);

      const topics = await system.updateSettings('topics', { hour: 6, minEntries: 4 });
      assert.equal(topics.ok, true);
      assert.equal(system.getTopicSettings().hour, 6, '主题运行时副本同步更新');
      assert.equal(system.topicConfig.minEntries, 4, '调度器持有的引用同源');

      assert.equal(system.config.query.cardMaxHeight, 6000, '热更新不得写宿主 config');
    } finally {
      system.dispose();
    }
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-STORE-06: 并发写不同段串行合并，三段的覆盖值全部保留', async () => {
  const wikiDir = await makeWiki();
  try {
    await Promise.all([
      writeSettingsOverrides(wikiDir, 'trigger', { maxBufferMessages: 800 }),
      writeSettingsOverrides(wikiDir, 'topics', { hour: 7 }),
      writeSettingsOverrides(wikiDir, 'query', { cardMaxHeight: 5000 }),
      writeSettingsOverrides(wikiDir, 'trigger', { minDiscussionMessages: 9 }),
    ]);
    const stored = await readSettingsOverrides(wikiDir);
    assert.equal(stored.trigger.maxBufferMessages, 800, '同段并发写不得互相覆盖');
    assert.equal(stored.trigger.minDiscussionMessages, 9);
    assert.equal(stored.topics.hour, 7);
    assert.equal(stored.query.cardMaxHeight, 5000);
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-STORE-07: SETTINGS_META 覆盖五段全部可调字段，且与运行时段键一一对应', async () => {
  assert.deepEqual([...SETTINGS_SECTIONS], ['trigger', 'topics', 'media', 'query', 'judge']);
  assert.deepEqual(
    [...new Set(SETTINGS_META.map((field) => field.section))].sort(),
    [...SETTINGS_SECTIONS].sort(),
  );

  const wikiDir = await makeWiki();
  try {
    const system = new PatchouliKnowledgeSystem(Config({ storage: { wikiDir } }), quiet);
    try {
      await system.ready;
      for (const section of SETTINGS_SECTIONS) {
        const metaKeys = SETTINGS_META.filter((field) => field.section === section).map((field) => field.key);
        assert.deepEqual(
          [...metaKeys].sort(),
          Object.keys(system.settings(section)).sort(),
          `${section} 段必须全部可调（不多不少）`,
        );
      }
    } finally {
      system.dispose();
    }
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-STORE-08: trigger 段 modes 与源码读取点一致（rate / potential / 共用）', () => {
  // 核对依据是 `src/trigger/detector.ts` 的实际读取点，不是字段名的直觉：
  // - rate 专属：`windowSizeSeconds`（`burstThreshold` / `currentRate` / 冷却观察点）
  //   与 `minBurstRate`（速率门限 + 上行滞回闸门）只服务速率判据；
  // - potential 专属：`thetaMin`（`potentialBurstThreshold` / `potentialCoolThreshold`）、
  //   `rhoMin`（`effectiveRhoMin` 密度闸门）、`densityMultiplier`、`peakCoolFraction`、
  //   `dispatchMargin`（宿主质量门只读非 rate 模式填的 `potentialPeak`）；
  // - 共用：`burstMultiplier` 与 `coolingRatioThreshold` 同时出现在
  //   `potentialBurstThreshold` / `potentialCoolThreshold` 里，并非 rate 独占；
  //   `quiescenceSeconds` 由 `enterCooling` 在 rate / potential 两条分支共用；
  //   `minDiscussionMessages` / `maxBufferMessages` / `baselineEwmaAlpha` /
  //   `triggerMode` 本身与判据模式无关；
  // - `potentialAutoTuning` 只在 `triggerMode === 'shadow'` 时被读取，面板没有
  //   shadow 选项，因此两种面板模式下都不显示（`modes: []`）。
  const expected = {
    windowSizeSeconds: ['rate'],
    burstMultiplier: undefined,
    minBurstRate: ['rate'],
    quiescenceSeconds: undefined,
    coolingRatioThreshold: undefined,
    minDiscussionMessages: undefined,
    maxBufferMessages: undefined,
    baselineEwmaAlpha: undefined,
    triggerMode: undefined,
    thetaMin: ['potential'],
    potentialAutoTuning: [],
    dispatchMargin: ['potential'],
    densityMultiplier: ['potential'],
    peakCoolFraction: ['potential'],
    rhoMin: ['potential'],
  };

  const trigger = SETTINGS_META.filter((field) => field.section === 'trigger');
  const byKey = new Map(trigger.map((field) => [field.key, field]));
  assert.deepEqual(
    [...byKey.keys()].sort(),
    Object.keys(expected).sort(),
    'trigger 段的字段清单必须与核对结果一一对应（不多不少）',
  );

  for (const field of trigger) {
    const want = expected[field.key];
    if (want === undefined) {
      assert.equal(field.modes, undefined, `${field.key} 是两模式共用字段，不得标注 modes`);
    } else {
      assert.deepEqual(field.modes, want, `${field.key} 的 modes 必须与源码读取点一致`);
    }
  }

  // 未标注 modes 的字段两种模式都可见（与前端过滤口径一致）；标注的只在其列出的模式可见。
  const visibleIn = (field, mode) => field.modes === undefined || field.modes.includes(mode);

  const shared = [
    'burstMultiplier',
    'quiescenceSeconds',
    'coolingRatioThreshold',
    'minDiscussionMessages',
    'maxBufferMessages',
    'baselineEwmaAlpha',
    'triggerMode',
  ];
  for (const key of shared) {
    assert.equal(visibleIn(byKey.get(key), 'rate'), true, `${key} 在 rate 模式可见`);
    assert.equal(visibleIn(byKey.get(key), 'potential'), true, `${key} 在 potential 模式可见`);
  }

  for (const key of ['windowSizeSeconds', 'minBurstRate']) {
    assert.equal(visibleIn(byKey.get(key), 'rate'), true, `${key} 在 rate 模式可见`);
    assert.equal(visibleIn(byKey.get(key), 'potential'), false, `${key} 在 potential 模式隐藏`);
  }

  for (const key of ['thetaMin', 'rhoMin', 'dispatchMargin', 'densityMultiplier', 'peakCoolFraction']) {
    assert.equal(visibleIn(byKey.get(key), 'potential'), true, `${key} 在 potential 模式可见`);
    assert.equal(visibleIn(byKey.get(key), 'rate'), false, `${key} 在 rate 模式隐藏`);
  }

  assert.equal(visibleIn(byKey.get('potentialAutoTuning'), 'potential'), false);
  assert.equal(visibleIn(byKey.get('potentialAutoTuning'), 'rate'), false);

  // modes 只允许两个判据模式值，且不出现在 trigger 段之外（其余段与判据模式无关）。
  for (const field of SETTINGS_META) {
    if (field.modes === undefined) continue;
    for (const mode of field.modes) {
      assert.ok(mode === 'potential' || mode === 'rate', `${field.section}.${field.key} 含未知模式 ${mode}`);
    }
    assert.equal(field.section, 'trigger', `${field.section}.${field.key} 不应标注 modes`);
  }

  // GET /patchouli/api/settings 原样序列化 SETTINGS_META：modes 必须随 JSON 带出。
  const serialized = JSON.parse(JSON.stringify(SETTINGS_META)).filter((field) => field.section === 'trigger');
  assert.deepEqual(
    serialized.map((field) => field.modes),
    trigger.map((field) => field.modes),
    'JSON 序列化后 trigger 段的 modes 必须与内存中的元数据一致',
  );
  assert.deepEqual(serialized.find((field) => field.key === 'thetaMin').modes, ['potential']);
  assert.deepEqual(serialized.find((field) => field.key === 'potentialAutoTuning').modes, []);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 合并后校验（BLOCKER 2）：面板单字段合法、但「config ⊕ 覆盖 ⊕ 补丁」合并后
 * 违反触发器运行时断言的补丁，必须在**落盘之前**被拒（400），文件与运行态都不变。
 * 预置坏 settings.json 时插件必须能起来（自愈 + 告警），不能把管理路由一起带倒。
 * ──────────────────────────────────────────────────────────────────────────── */

const GUARD_API_TOKEN = 'settings-guard-token';

/** Koa Router 替身：`use` 必须存在，否则插件按 fail closed 跳过全部 `/api/*` 路由。 */
function createGuardRouterDouble() {
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

/** 带长期令牌的 Koa 上下文（管理面守卫只认 `x-api-token` / Bearer / Cookie）。 */
function guardKoaCtx({ body } = {}) {
  return {
    params: {},
    query: {},
    headers: { 'x-api-token': GUARD_API_TOKEN },
    request: { body, headers: { 'x-api-token': GUARD_API_TOKEN } },
    status: 200,
    body: undefined,
    set: () => {},
  };
}

/** 起一个真 system + 真 WebUI 路由（覆盖层读写全走真实现）。 */
async function bootGuard(wikiDir, logger = quiet) {
  const config = Config({ storage: { wikiDir }, security: { apiToken: GUARD_API_TOKEN } });
  const system = new PatchouliKnowledgeSystem(config, logger);
  await system.ready;
  const { router, routes, request } = createGuardRouterDouble();
  registerWebUi({ router }, system, '/patchouli');
  return { system, routes, request };
}

test('SETTINGS-GUARD-01: thetaMin=0 在合并校验被拒，文件与运行态都不变', async () => {
  const wikiDir = await makeWiki();
  const { system } = await bootGuard(wikiDir);
  try {
    // 先写一段合法覆盖：证明「文件没变」而不是「文件不存在」。
    assert.equal((await system.updateSettings('query', { cardMaxHeight: 7200 })).ok, true);
    const before = await readFile(settingsPath(wikiDir), 'utf8');
    const beforeTrigger = system.settings('trigger');

    // 面板 SETTINGS_META 允许 thetaMin = 0（min: 0），但触发器要求 ≥ 1e-3。
    const rejected = await system.updateSettings('trigger', { thetaMin: 0 });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /thetaMin/u, '错误必须指名越界字段');

    assert.equal(await readFile(settingsPath(wikiDir), 'utf8'), before, '非法补丁不得落盘');
    assert.deepEqual(system.settings('trigger'), beforeTrigger, '运行态不得变化');
    assert.equal((await readSettingsOverrides(wikiDir)).trigger, undefined, '覆盖层里不得出现 trigger 段');
  } finally {
    system.dispose();
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-02: coolingRatioThreshold >= burstMultiplier 被拒（单字段与成对两条路径）', async () => {
  const wikiDir = await makeWiki();
  const { system } = await bootGuard(wikiDir);
  try {
    const before = system.settings('trigger');
    // ① 只抬回落倍率：默认 burstMultiplier 2.5，cooling 3 会抹掉迟滞区间。
    const alone = await system.updateSettings('trigger', { coolingRatioThreshold: 3 });
    assert.equal(alone.ok, false);
    assert.match(alone.error, /coolingRatioThreshold/u);

    // ② 同一补丁里成对越界（字段级都合法：cooling ∈ [1,5]、burst ∈ [1,20]）。
    const pair = await system.updateSettings('trigger', { burstMultiplier: 2, coolingRatioThreshold: 2 });
    assert.equal(pair.ok, false, '相等同样非法（必须严格小于）');
    assert.match(pair.error, /burstMultiplier/u);

    assert.deepEqual(system.settings('trigger'), before, '被拒后运行态保持原值');
    assert.equal((await readSettingsOverrides(wikiDir)).trigger, undefined, '被拒后不落盘');
  } finally {
    system.dispose();
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-03: 合法补丁 200 且落盘（跨字段约束被满足）', async () => {
  const wikiDir = await makeWiki();
  const { system } = await bootGuard(wikiDir);
  try {
    const accepted = await system.updateSettings('trigger', {
      coolingRatioThreshold: 1.5,
      burstMultiplier: 4,
      thetaMin: 12,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value.coolingRatioThreshold, 1.5);
    assert.equal(accepted.value.burstMultiplier, 4);
    assert.equal(accepted.value.thetaMin, 12);
    assert.equal(system.settings('trigger').thetaMin, 12, '合并读取即时生效');

    const raw = JSON.parse(await readFile(settingsPath(wikiDir), 'utf8'));
    assert.deepEqual(raw.sections.trigger, { coolingRatioThreshold: 1.5, burstMultiplier: 4, thetaMin: 12 });
    assert.deepEqual(await readSettingsOverrides(wikiDir), { trigger: raw.sections.trigger });
  } finally {
    system.dispose();
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-04: POST /api/settings 对合并后非法补丁返回 400（不是 500）', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await bootGuard(wikiDir);
  try {
    await writeSettingsOverrides(wikiDir, 'query', { cardMaxHeight: 7000 });
    const before = await readFile(settingsPath(wikiDir), 'utf8');

    const rejected = guardKoaCtx({ body: { section: 'trigger', patch: { thetaMin: 0 } } });
    await request('POST /patchouli/api/settings', rejected);
    assert.equal(rejected.status, 400, '合并后非法必须是 400');
    assert.equal(rejected.body.ok, false);
    assert.match(rejected.body.error, /thetaMin/u);
    assert.equal(await readFile(settingsPath(wikiDir), 'utf8'), before, '400 时文件不得变化');

    const accepted = guardKoaCtx({ body: { section: 'trigger', patch: { thetaMin: 15, burstMultiplier: 3 } } });
    await request('POST /patchouli/api/settings', accepted);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.ok, true);
    const stored = JSON.parse(await readFile(settingsPath(wikiDir), 'utf8'));
    assert.equal(stored.sections.trigger.thetaMin, 15, '合法补丁必须落盘');
    assert.equal(stored.sections.query.cardMaxHeight, 7000, '写入其他段不得抹掉既有覆盖');
  } finally {
    system.dispose();
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-05: 预置坏 settings.json → 构造不抛、回落 config 并告警', async () => {
  const wikiDir = await makeWiki();
  const warnings = [];
  const logger = { info: () => {}, warn: (message) => warnings.push(message), error: () => {} };
  const file = settingsPath(wikiDir);
  try {
    await mkdir(path.dirname(file), { recursive: true });

    // ① thetaMin = 0（面板曾允许的合法单字段）+ 同一段里的合法键：整段丢弃。
    await writeFile(
      file,
      JSON.stringify({ version: 1, sections: { trigger: { thetaMin: 0, maxBufferMessages: 900 } } }),
      'utf8',
    );
    const config = Config({ storage: { wikiDir }, advanced: { trigger: { maxBufferMessages: 777 } } });
    const system = new PatchouliKnowledgeSystem(config, logger);
    try {
      await system.ready;
      assert.equal(system.settings('trigger').thetaMin, 20, 'thetaMin 回落 config 默认值');
      assert.equal(system.settings('trigger').maxBufferMessages, 777, '坏段整段丢弃，同段的合法键也不生效');
      assert.equal(system.detector.size, 0, '触发器必须构造成功（没有任何启动期异常）');
      assert.ok(
        warnings.some((message) => /settings\.json 的 trigger 段合并后非法/u.test(message)),
        `必须留下自愈告警，实际 ${JSON.stringify(warnings)}`,
      );
    } finally {
      system.dispose();
    }

    // ② 迟滞区间失效的成对坏值：同样整段丢弃。
    await writeFile(
      file,
      JSON.stringify({ version: 1, sections: { trigger: { burstMultiplier: 2, coolingRatioThreshold: 2.5 } } }),
      'utf8',
    );
    const second = new PatchouliKnowledgeSystem(Config({ storage: { wikiDir } }), logger);
    try {
      await second.ready;
      assert.equal(second.settings('trigger').burstMultiplier, 2.5, '回落 config 默认倍率');
      assert.equal(second.settings('trigger').coolingRatioThreshold, 1.1, '回落 config 默认回落倍率');
    } finally {
      second.dispose();
    }
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-06: 坏文件在下一次合法保存时被就地修复', async () => {
  const wikiDir = await makeWiki();
  const warnings = [];
  const logger = { info: () => {}, warn: (message) => warnings.push(message), error: () => {} };
  const file = settingsPath(wikiDir);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, sections: { trigger: { thetaMin: 0, maxBufferMessages: 900 }, topics: { hour: 6 } } }),
      'utf8',
    );

    const system = new PatchouliKnowledgeSystem(Config({ storage: { wikiDir } }), logger);
    try {
      await system.ready;
      const accepted = await system.updateSettings('trigger', { rhoMin: 1.6 });
      assert.equal(accepted.ok, true);

      const raw = JSON.parse(await readFile(file, 'utf8'));
      assert.equal('thetaMin' in raw.sections.trigger, false, '坏键必须从文件里消失');
      assert.equal(raw.sections.trigger.rhoMin, 1.6, '本次合法补丁必须落盘');
      assert.equal(raw.sections.topics.hour, 6, '其他段（含合法段）不得被牵连');
      assert.equal(system.settings('trigger').thetaMin, 20);
    } finally {
      system.dispose();
    }
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-07: 文件里的旧覆盖与本次补丁冲突时拒绝写入（400，文件不变）', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await bootGuard(wikiDir);
  const file = settingsPath(wikiDir);
  try {
    await system.ready;
    // 绕过面板直接改文件（等价于外部编辑器 / 另一个进程）：内存快照看不到这个值。
    await writeFile(
      file,
      JSON.stringify({ version: 1, sections: { trigger: { coolingRatioThreshold: 2 } } }),
      'utf8',
    );
    const before = await readFile(file, 'utf8');

    // 内存里的合并值（config burstMultiplier 2.5 ⊕ 补丁 1.5）合法；落盘时才与文件里的 2 撞车。
    const rejected = guardKoaCtx({ body: { section: 'trigger', patch: { burstMultiplier: 1.5 } } });
    await request('POST /patchouli/api/settings', rejected);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.ok, false);
    assert.match(rejected.body.error, /coolingRatioThreshold/u, '400 文案必须按文件里的真实值给出');
    assert.equal(await readFile(file, 'utf8'), before, '冲突时不得写盘');
    assert.equal(system.settings('trigger').burstMultiplier, 2.5, '冲突时运行态保持 config 值');

    // 冲突后内存快照已与文件对齐：再提一个真正合法的补丁就正常落地。
    const accepted = await system.updateSettings('trigger', { burstMultiplier: 3 });
    assert.equal(accepted.ok, true);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.sections.trigger.burstMultiplier, 3);
    assert.equal(stored.sections.trigger.coolingRatioThreshold, 2, '旧值本身合法，必须保留');
    assert.equal(system.settings('trigger').burstMultiplier, 3);
  } finally {
    system.dispose();
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-08: 密钥只出空串 + secretConfigured；空串写入不修改，非空才覆盖', async () => {
  const wikiDir = await makeWiki();
  const { system, request } = await bootGuard(wikiDir);
  try {
    const first = guardKoaCtx();
    await request('GET /patchouli/api/settings', first);
    assert.equal(first.body.sections.media.apiKey, '');
    assert.equal(first.body.sections.judge.apiKey, '');
    assert.deepEqual(first.body.sections.media.secretConfigured, { apiKey: false });
    assert.deepEqual(first.body.sections.judge.secretConfigured, { apiKey: false });
    assert.equal('secretConfigured' in first.body.sections.trigger, false, '非密钥段不得凭空多出字段');

    const saved = await system.updateSettings('media', { apiKey: 'media-secret-1' });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.apiKey, '', 'POST 回包同样不得回显明文');
    assert.deepEqual(saved.value.secretConfigured, { apiKey: true });
    assert.equal(
      JSON.parse(await readFile(settingsPath(wikiDir), 'utf8')).sections.media.apiKey,
      'media-secret-1',
      '磁盘必须存真值（运行态要用）',
    );
    assert.equal(system.settings('media').apiKey, 'media-secret-1', '运行态不得被打码');

    const second = guardKoaCtx();
    await request('GET /patchouli/api/settings', second);
    assert.equal(second.body.sections.media.apiKey, '');
    assert.deepEqual(second.body.sections.media.secretConfigured, { apiKey: true });
    assert.ok(!JSON.stringify(second.body).includes('media-secret-1'), '响应体任何位置都不得出现明文');

    // 面板把空串原样回传：等同「不修改」，不得把已配置密钥冲掉。
    const noop = await system.updateSettings('media', { apiKey: '', lowWater: 7 });
    assert.equal(noop.ok, true);
    assert.deepEqual(noop.value.secretConfigured, { apiKey: true });
    const afterNoop = JSON.parse(await readFile(settingsPath(wikiDir), 'utf8'));
    assert.equal(afterNoop.sections.media.apiKey, 'media-secret-1');
    assert.equal(afterNoop.sections.media.lowWater, 7, '同补丁的其他字段照常落盘');

    // 非空才覆盖。
    const replaced = await system.updateSettings('judge', { apiKey: 'judge-secret-1' });
    assert.equal(replaced.ok, true);
    assert.equal(
      JSON.parse(await readFile(settingsPath(wikiDir), 'utf8')).sections.judge.apiKey,
      'judge-secret-1',
    );
  } finally {
    system.dispose();
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-09: settings.json 落盘权限 0600（Windows 无 POSIX 权限位，跳过）', { skip: process.platform === 'win32' }, async () => {
  const wikiDir = await makeWiki();
  try {
    await writeSettingsOverrides(wikiDir, 'media', { apiKey: 'k1' });
    assert.equal((await stat(settingsPath(wikiDir))).mode & 0o777, 0o600, '首次落盘必须 0600');

    // 覆盖写（temp + rename）同样保持 0600。
    await writeSettingsOverrides(wikiDir, 'query', { cardMaxHeight: 6000 });
    assert.equal((await stat(settingsPath(wikiDir))).mode & 0o777, 0o600, '覆写后仍须 0600');
  } finally {
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-10: 字符串长度上限 / 控制字符 / URL 形态在字段级就 400', async () => {
  const wikiDir = await makeWiki();
  const { system } = await bootGuard(wikiDir);
  try {
    // 长度上限：secret 512 / URL 2048 / media.dir 512
    const tooLongDir = validateSettingsPatch('media', { dir: 'a'.repeat(513) });
    assert.equal(tooLongDir.ok, false);
    assert.match(tooLongDir.error, /media\.dir/u);
    assert.equal(validateSettingsPatch('media', { dir: 'a'.repeat(512) }).ok, true);
    assert.equal(validateSettingsPatch('media', { apiKey: 'k'.repeat(512) }).ok, true);
    assert.equal(validateSettingsPatch('media', { apiKey: 'k'.repeat(513) }).ok, false);
    assert.equal(validateSettingsPatch('judge', { baseURL: `https://x.example/${'a'.repeat(2048)}` }).ok, false);

    // 控制字符（含换行 / 制表 / NUL）
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
      const rejected = validateSettingsPatch('media', { dir: bad });
      assert.equal(rejected.ok, false, `${JSON.stringify(bad)} 必须被拒绝`);
      assert.match(rejected.error, /控制字符/u);
    }

    // URL 形态：只接受 http(s) 绝对地址且无 userinfo；留空 = 用默认值
    for (const bad of ['ftp://x.example', 'javascript:alert(1)', 'not a url', 'https://user:pw@x.example']) {
      const rejected = validateSettingsPatch('judge', { baseURL: bad });
      assert.equal(rejected.ok, false, `${bad} 必须被拒绝`);
    }
    for (const good of ['https://judge.example/v1', 'http://127.0.0.1:11434', '']) {
      assert.equal(validateSettingsPatch('judge', { baseURL: good }).ok, true, `${good || '空串'} 必须通过`);
    }

    // 系统级：400 且文件不变
    assert.equal((await system.updateSettings('query', { cardMaxHeight: 6800 })).ok, true);
    const before = await readFile(settingsPath(wikiDir), 'utf8');
    const rejected = await system.updateSettings('media', { imageSource: 'ftp://x.example/a' });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /imageSource/u);
    assert.equal(await readFile(settingsPath(wikiDir), 'utf8'), before, '被拒补丁不得落盘');
  } finally {
    system.dispose();
    await cleanup(wikiDir);
  }
});

test('SETTINGS-GUARD-11: 旧文件里的明文密钥 → GET 不回显，但运行态照旧使用', async () => {
  const wikiDir = await makeWiki();
  const warnings = [];
  const logger = { info: () => {}, warn: (message) => warnings.push(message), error: () => {} };
  const file = settingsPath(wikiDir);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sections: {
          media: { apiKey: 'legacy-media-key', lowWater: 9 },
          judge: { enabled: true, apiKey: 'legacy-judge-key', baseURL: 'http://127.0.0.1:11434' },
        },
      }),
      'utf8',
    );

    const system = new PatchouliKnowledgeSystem(
      Config({ storage: { wikiDir }, security: { apiToken: GUARD_API_TOKEN } }),
      logger,
    );
    try {
      await system.ready;
      assert.deepEqual(warnings, [], '合法旧文件不得触发自愈告警');

      // 运行态 / 合并值仍是真值（功能不能被打码弄坏）。
      assert.equal(system.settings('media').apiKey, 'legacy-media-key');
      assert.equal(system.settings('judge').apiKey, 'legacy-judge-key');
      assert.equal(system.settings('judge').enabled, true);

      const { router, request } = createGuardRouterDouble();
      registerWebUi({ router }, system, '/patchouli');
      const ctx = guardKoaCtx();
      await request('GET /patchouli/api/settings', ctx);
      assert.equal(ctx.body.sections.media.apiKey, '');
      assert.equal(ctx.body.sections.judge.apiKey, '');
      assert.deepEqual(ctx.body.sections.media.secretConfigured, { apiKey: true });
      assert.deepEqual(ctx.body.sections.judge.secretConfigured, { apiKey: true });
      const serialized = JSON.stringify(ctx.body);
      assert.ok(!serialized.includes('legacy-media-key'));
      assert.ok(!serialized.includes('legacy-judge-key'));
    } finally {
      system.dispose();
    }
  } finally {
    await cleanup(wikiDir);
  }
});
