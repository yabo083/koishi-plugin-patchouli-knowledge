import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALBUM_SCHEMA_KEY,
  CHATLUNA_MODEL_INHERIT,
  Config,
  DEFAULT_WEEKLY_CRON,
  flattenConfig,
} from '../lib/index.js';

/**
 * 插件页是**单层 object**：空配置解析后顶层只剩
 * `modelConfig / enabled / subscriptions / features / storage / security`（+ 历史 `advancedMode`）。
 * 调参面（trigger / topics / media / query / judge / channels / albumDelivery / observability）
 * 以 `.default(undefined)` 的隐藏字段留在 Schema 里（旧配置能加载），但空配置里不物化。
 */
const topField = (key) => Config.dict?.[key];

/** 运行时摊平（与 `apply()` / `PatchouliKnowledgeSystem` 同一个函数）。 */
const resolve = (value = {}) => flattenConfig(Config(value));

/** `modelConfig` 是条件表单：`intersect([判别字段, 分支 union, 公共隐藏项])`。 */
const modelConfigSchema = () => topField('modelConfig');
const branches = () => modelConfigSchema().list[1].list;

/** custom 分支的全部端点键（历史 standalone / auto 分支与它同构）。 */
const CUSTOM_KEYS = ['apiKey', 'baseURL', 'contractRetries', 'customModel', 'protocol', 'provider', 'responseFormat'];

test('CONFIG-01: modelConfig 条件表单——provider 只有 chatluna / custom 两个可见选项', () => {
  const schema = modelConfigSchema();
  assert.equal(schema.type, 'intersect', 'modelConfig 必须是条件表单，而不是单层扁平 object');
  assert.deepEqual(
    schema.list.map((item) => item.type),
    ['object', 'union', 'object'],
    '结构：判别字段 / 分支 / 公共高级项',
  );

  const provider = schema.list[0].dict.provider;
  assert.equal(provider.type, 'union');
  assert.deepEqual(
    provider.list.filter((item) => !item.meta.hidden).map((item) => item.value),
    ['chatluna', 'custom'],
    '下拉只暴露 chatluna / custom；auto / standalone 仅作为隐藏的历史值保留',
  );
  assert.deepEqual(
    provider.list.filter((item) => item.meta.hidden).map((item) => item.value),
    ['standalone', 'auto'],
    '历史值必须留在枚举里（否则旧配置过不了校验），但不得出现在下拉里',
  );
  assert.equal(provider.meta.default, 'chatluna');

  const resolved = resolve({});
  assert.equal(resolved.modelConfig.provider, 'chatluna', '默认走 ChatLuna');
  assert.equal(resolved.dispatcher.provider, 'chatluna', '运行时键 dispatcher 与 modelConfig 同值');
  assert.deepEqual(resolved.dispatcher, resolved.modelConfig);
  assert.equal(resolved.dispatcher.chatlunaModel, CHATLUNA_MODEL_INHERIT, '默认「无」= 继承平台默认模型');
  assert.equal(resolved.dispatcher.temperature, 0.3);
  assert.equal(resolved.dispatcher.maxTokens, 6000);
  assert.equal(resolved.dispatcher.enableAutoTuning, true);

  for (const removed of ['chatlunaPreset', 'systemPromptPreset', 'customSystemPrompt']) {
    assert.equal(removed in resolved.dispatcher, false, `${removed} 不得出现在 modelConfig 配置里`);
  }
});

test('CONFIG-02: ChatLuna 分支只有模型下拉，custom 分支才渲染端点字段', () => {
  const [chatluna, custom] = branches();

  assert.deepEqual(
    Object.keys(chatluna.dict).sort(),
    ['chatlunaModel', 'provider'],
    'ChatLuna 分支除判别名外只有模型一项',
  );
  const model = chatluna.dict.chatlunaModel;
  assert.equal(model.meta.role, 'dynamic', '模型候选项由 ChatLuna 注册的 model 动态 Schema 提供');
  assert.equal(model.meta.extra.name, 'model', '与 ChatLuna 自身 defaultModel / livingmemory mainModel 同一个键');
  assert.equal(model.meta.default, CHATLUNA_MODEL_INHERIT);

  assert.equal(
    chatluna.dict.provider.meta.required,
    undefined,
    'ChatLuna 分支的 const 不得 required：provider 等于默认值时控制台会省略该键，required 会让整个分支塌成空白',
  );
  assert.equal(custom.dict.provider.meta.required, true, 'custom 分支必须用 required const 认领自己的值');

  assert.deepEqual(Object.keys(custom.dict).sort(), CUSTOM_KEYS, 'custom 分支：baseURL + apiKey + customModel + 高级覆盖');
  assert.equal(custom.dict.apiKey.meta.role, 'secret', 'apiKey 仍是 secret 角色');
  assert.equal(custom.dict.baseURL.meta.default, 'https://api.openai.com/v1');
  assert.equal(custom.dict.customModel.type, 'string', 'custom 的模型名是自由文本，不是 ChatLuna 下拉');
  assert.equal(custom.dict.protocol.meta.default, 'auto', '协议默认自动探测');
  assert.equal(custom.dict.protocol.meta.hidden, true, '协议 / 输出格式是高级覆盖，始终收起');
  assert.equal(custom.dict.responseFormat.meta.hidden, true);
  assert.equal(custom.dict.contractRetries.meta.hidden, true, '契约重试次数属于高级覆盖，必须收起');
  assert.equal(custom.dict.contractRetries.meta.default, 1, '默认只追加 1 次重试（每次都是一次完整模型调用）');

  const common = modelConfigSchema().list[2];
  assert.deepEqual(Object.keys(common.dict).sort(), ['enableAutoTuning', 'maxTokens', 'temperature']);
  for (const key of Object.keys(common.dict)) {
    assert.equal(common.dict[key].meta.hidden, true, `${key} 属于高级覆盖，必须收起`);
  }
});

test('CONFIG-03: custom 解析补齐端点默认值，端点字段写回后不被丢弃', () => {
  const resolved = resolve({
    modelConfig: { provider: 'custom', baseURL: 'https://newapi.example/v1', apiKey: 'sk-test', customModel: 'gpt-5' },
  });

  assert.equal(resolved.dispatcher.provider, 'custom');
  assert.equal(resolved.dispatcher.baseURL, 'https://newapi.example/v1');
  assert.equal(resolved.dispatcher.apiKey, 'sk-test');
  assert.equal(resolved.dispatcher.customModel, 'gpt-5');
  assert.equal(resolved.dispatcher.protocol, 'auto');
  assert.equal(resolved.dispatcher.responseFormat, 'json_object');
  assert.equal(resolved.dispatcher.maxTokens, 6000);
});

test('CONFIG-04: 历史 provider 与旧键 dispatcher / advanced.dispatcher 通过校验并原样保留', () => {
  for (const legacy of ['standalone', 'auto']) {
    const resolved = resolve({
      dispatcher: { provider: legacy, baseURL: 'https://legacy.example/v1', apiKey: 'sk-legacy', model: 'legacy-model' },
    });
    assert.equal(resolved.dispatcher.provider, legacy, `${legacy} 必须在解析后保留，由运行时归一化`);
    assert.equal(resolved.dispatcher.baseURL, 'https://legacy.example/v1');
    assert.equal(resolved.dispatcher.apiKey, 'sk-legacy');
    assert.equal(resolved.dispatcher.model, 'legacy-model', '旧单键必须过校验：否则旧配置一加载就丢模型名');
    assert.equal(resolved.dispatcher.customModel, '', '旧配置不产出新键值，由 resolveDispatcherModels 按当前通道回填旧 model');
    assert.equal(resolved.modelConfig.provider, legacy, 'modelConfig 与 dispatcher 同步');
  }
  assert.equal(modelConfigSchema().list[0].dict.model.meta.hidden, true, '旧单键不得出现在控制台表单里');

  // 0.8.66 把 dispatcher 收在 advanced 容器里：升级后必须搬出来，不能回落到 Schema 默认值。
  const fromAdvanced = resolve({
    advanced: { dispatcher: { provider: 'custom', baseURL: 'https://box.example/v1', apiKey: 'k', customModel: 'm' } },
  });
  assert.equal(fromAdvanced.dispatcher.provider, 'custom');
  assert.equal(fromAdvanced.dispatcher.customModel, 'm');
  assert.equal(fromAdvanced.modelConfig.baseURL, 'https://box.example/v1');
});

test('CONFIG-08: 两条分支不共用可见字段（切 provider 不再互相覆盖）', () => {
  const [chatluna, custom] = branches();
  const visible = (branch) =>
    Object.keys(branch.dict).filter((key) => key !== 'provider' && !branch.dict[key].meta.hidden);

  assert.deepEqual(visible(chatluna), ['chatlunaModel']);
  assert.deepEqual(visible(custom), ['baseURL', 'apiKey', 'customModel']);
  assert.deepEqual(
    visible(chatluna).filter((key) => visible(custom).includes(key)),
    [],
    '同名可见键 = 控制台同一配置路径，切模式即串值（0.8.43 的 model 就踩在这里）',
  );
});

test('CONFIG-09: ChatLuna 模型与端点模型在解析后互相不可见', () => {
  const chatluna = resolve({ modelConfig: { provider: 'chatluna', chatlunaModel: 'newapi/xz/gemini-3.8-flash' } });
  assert.equal(chatluna.dispatcher.chatlunaModel, 'newapi/xz/gemini-3.8-flash');
  assert.equal(chatluna.dispatcher.customModel, undefined, 'chatluna 分支不产出端点模型名');

  const custom = resolve({
    modelConfig: { provider: 'custom', baseURL: 'https://x.example/v1', apiKey: 'k', customModel: 'gpt-5' },
  });
  assert.equal(custom.dispatcher.customModel, 'gpt-5');
  assert.equal(custom.dispatcher.chatlunaModel, undefined, 'custom 分支不产出 ChatLuna 模型 id');
});

test('CONFIG-05: 序列化契约保留动态模型 / 密钥角色与输出格式枚举，无提示词残留', () => {
  const serialized = JSON.stringify(Config.toJSON());

  assert.ok(serialized.includes('"role":"dynamic"'), '模型下拉与相册候选的 dynamic 角色必须保留');
  assert.ok(serialized.includes('"role":"secret"'), 'apiKey / apiToken 的 secret 角色必须保留');
  for (const value of ['chatluna', 'custom', 'auto', 'responses', 'gemini', 'chat-completions']) {
    assert.ok(serialized.includes(`"${value}"`), `序列化必须暴露 ${value}`);
  }
  assert.ok(serialized.includes('"json_object"') && serialized.includes('"structured"'));
  assert.ok(serialized.includes('"maxBufferMessages"'), '隐藏段仍要序列化：旧配置的字段必须能过校验');

  assert.equal(serialized.includes('systemPromptPreset'), false, '系统提示词预设配置项必须彻底删除');
  assert.equal(serialized.includes('customSystemPrompt'), false, '自定义提示词配置项必须彻底删除');
  assert.equal(serialized.includes('"role":"textarea"'), false, '配置表单不得再出现提示词多行文本框');
  assert.equal(serialized.includes('_preview'), false, '不得残留 _preview 字段');
  assert.equal(serialized.includes('iframe'), false, '不得残留 iframe 字段');
});

test('CONFIG-06: 词条与主题共用一个相册列表，cron 与动态相册候选仍在', () => {
  const resolved = resolve({});
  assert.equal(resolved.albumDelivery.cron, DEFAULT_WEEKLY_CRON, '默认每周一 04:30');
  assert.deepEqual(resolved.albumDelivery.albums, []);
  assert.equal(resolved.albumDelivery.entryEnabled, true, '讨论后立即投词条默认开启');
  assert.equal(resolved.albumDelivery.entryRedirectChannelId, '', '默认不带宽改道');

  const fields = topField('albumDelivery').dict;
  assert.deepEqual(Object.keys(fields), ['entryEnabled', 'entryRedirectChannelId', 'cron', 'albums']);
  assert.equal(fields.cron.type, 'string');
  assert.equal(JSON.stringify(fields.cron.meta).includes('miyako-delivery'), true, '说明文字点明调度服务来源');

  assert.equal(fields.albums.type, 'array');
  assert.equal(fields.albums.inner.type, 'any');
  assert.equal(fields.albums.inner.meta.role, 'dynamic', '相册候选项必须由 ctx.schema 动态注入');
  assert.equal(fields.albums.inner.meta.extra.name, ALBUM_SCHEMA_KEY);
});

test('CONFIG-07: provider 写回幂等——custom 反复解析不被覆盖回 chatluna', () => {
  const first = resolve({
    modelConfig: { provider: 'custom', apiKey: 'sk-test', baseURL: 'https://x.example/v1', customModel: 'm' },
  });
  assert.equal(first.dispatcher.provider, 'custom', '用户选择的 provider 必须在解析后保留');

  const second = Config(first);
  assert.equal(second.modelConfig.provider, 'custom', '二次解析（写回后再读）仍必须是 custom');
  assert.equal(second.modelConfig.apiKey, 'sk-test');
  assert.equal(second.modelConfig.baseURL, 'https://x.example/v1');

  const third = Config(second);
  assert.deepEqual(third.modelConfig, second.modelConfig, '反复写回必须幂等');

  // 旧键 dispatcher 同时存在时也不得把 custom 覆盖回默认值。
  const legacyCarried = flattenConfig(Config({ ...first, modelConfig: second.modelConfig }));
  assert.equal(legacyCarried.dispatcher.provider, 'custom');
});

test('CONFIG-10: 插件页顶层七块 + 历史 advancedMode，features 默认全开，隐藏段不物化', () => {
  assert.equal(Config.type, 'object', '顶层必须是单层 object（不再是条件表单）');

  const parsed = Config({});
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['adminUsers', 'advancedMode', 'enabled', 'features', 'modelConfig', 'security', 'storage', 'subscriptions'],
    '空配置只物化这八块：七块可见配置 + 历史判别字段',
  );

  assert.deepEqual(
    parsed.features,
    { entries: true, weekly: true, topics: true, media: true },
    '功能总闸默认全开（行为与 0.8.66 一致）',
  );
  const features = topField('features').dict;
  for (const key of ['entries', 'weekly', 'topics', 'media']) {
    assert.equal(features[key].type, 'boolean');
    assert.equal(features[key].meta.default, true, `${key} 默认开启`);
    assert.equal(features[key].meta.hidden, undefined, `${key} 必须渲染`);
  }

  for (const key of ['channels', 'notifyOnSummarized', 'topics', 'albumDelivery', 'query', 'media', 'trigger', 'judge', 'observability']) {
    assert.equal(key in parsed, false, `${key} 不得出现在空配置里（否则控制台会多出隐藏键）`);
    assert.ok(topField(key), `${key} 仍必须在 Schema 里声明：旧配置要能加载`);
    assert.equal(topField(key).meta.hidden, true, `${key} 必须收起`);
  }

  // 管理员白名单是可见的主区字段：留空 = 无人可用（fail closed），命令层直接读 config。
  const adminUsers = topField('adminUsers');
  assert.equal(adminUsers.meta.hidden, undefined, '管理员白名单必须渲染');
  assert.equal(adminUsers.meta.role, 'table', 'string[] 走无表头单列表格');
  assert.deepEqual(adminUsers.meta.default, []);
  assert.deepEqual(parsed.adminUsers, []);
  assert.deepEqual(Config({ adminUsers: ['42'] }).adminUsers, ['42']);

  // 历史判别字段：保留声明只为旧配置过校验，不再渲染。
  assert.equal(topField('advancedMode').meta.hidden, true);
  assert.equal(topField('advancedMode').meta.default, false);

  // 订阅表：`.role('table')` 回来了，`targets` 的候选是 const union（模块加载期先算一份，
  // `apply()` 每次重载原地替换 `inner.list`）。表格列在渲染前按 `toColumns(inner)` 校验，
  // `Schema.dynamic`（= `Schema.any()`）永远过不了，所以候选必须是静态 const union。
  const subscriptions = topField('subscriptions');
  assert.equal(subscriptions.meta.role, 'table', '静态目标候选可以进表格');
  assert.equal(subscriptions.inner.type, 'object');
  assert.equal(subscriptions.meta.description, undefined, '表格上方不再有多行说明');
  const targets = subscriptions.inner.dict.targets;
  assert.equal(targets.type, 'array');
  assert.equal(targets.meta.role, 'select', 'SchemaMultiSelect 的注册条件：array + role select');
  assert.equal(
    targets.meta.default,
    undefined,
    '刻意不物化默认值：缺失 = 没写过（允许旧 target 回填），显式 [] = 清空收件人，两者都要能区分',
  );
  assert.equal(targets.inner.type, 'union', '多选标签只认 const union');
  assert.equal(
    targets.inner.list.every((item) => item.type === 'const'),
    true,
    'union 成员必须全是 const，否则 isMultiSelect 不认',
  );
  assert.ok(
    targets.inner.list.some((item) => item.value === '@chat'),
    '@chat 恒定在候选里（测试进程的 cwd 没有 koishi.yml / 相册缓存，候选只剩它）',
  );
  // 取值形态：`@chat` / 分组标题 `#group:<群号>` / 相册的**唯一可读名**（`相册名` 或
  // `群名 · 相册名`）。测试进程的 cwd 没有 koishi.yml 与相册缓存，候选只剩 `@chat`。
  for (const item of targets.inner.list) {
    assert.equal(typeof item.value, 'string');
    assert.ok(item.value.length > 0, 'targets 不提供空值项：空数组就是「不投递」');
    assert.equal(typeof item.meta.description, 'string', '每个候选项都必须有展示文案');
    if (item.value === '@chat') {
      assert.match(item.meta.description, /本群聊天/u);
    } else if (item.value.startsWith('#group:')) {
      assert.equal(item.meta.disabled, true, '分组标题项不可选');
    } else {
      assert.equal(item.value, item.meta.description, '相册项：标签只显示 value，文案必须与取值一致');
    }
  }
  // 列头文案：表格里字段 description 就是列头，一行说完，别再叠说明。
  assert.equal(targets.meta.description, '投递群（可多个）');
  assert.equal(subscriptions.inner.dict.source.meta.description, '监听群');
  assert.equal(subscriptions.inner.dict.entry.meta.description, '词条');
  assert.equal(subscriptions.inner.dict.weekly.meta.description, '周报');
  assert.equal(targets.meta.role === 'dynamic', false, '不再注册成 dynamic');
  assert.equal(subscriptions.inner.dict.target.meta.hidden, true, '历史单值 target 仍收起');
  assert.equal(topField('enabled').meta.default, true);

  // 可见的两块：知识库目录与面板密钥。
  assert.equal(topField('storage').dict.wikiDir.meta.hidden, undefined);
  assert.equal(topField('storage').dict.databasePath.meta.hidden, true, '索引库路径是内部项');
  assert.equal(topField('security').dict.apiToken.meta.role, 'secret');

  // triggerMode 的可见枚举只剩 potential / rate，shadow 以 .hidden() 保留（旧配置必须能加载）。
  const mode = topField('trigger').dict.triggerMode;
  assert.equal(mode.type, 'union');
  assert.deepEqual(
    mode.list.filter((item) => !item.meta.hidden).map((item) => item.value),
    ['potential', 'rate'],
  );
  assert.deepEqual(mode.list.filter((item) => item.meta.hidden).map((item) => item.value), ['shadow']);
  assert.equal(mode.meta.default, 'potential');

  const legacy = Config({ trigger: { triggerMode: 'shadow' } });
  assert.equal(legacy.trigger.triggerMode, 'shadow', '旧配置里的 shadow 必须能通过校验并原样保留');
});

test('CONFIG-11: 摊平——旧扁平配置 / 0.8.66 advanced 容器 / 新默认值三条来源，且幂等', () => {
  // 旧文件（高级区出现之前）把段平铺在顶层：Koishi 用本 Schema 解析后顶层就是用户值。
  const flat = resolve({
    adminUsers: ['42'],
    channels: ['10086'],
    trigger: { triggerMode: 'rate' },
    storage: { wikiDir: 'data/old' },
  });
  assert.deepEqual(flat.adminUsers, ['42'], '旧白名单不得被默认值 [] 覆盖');
  assert.deepEqual(flat.channels, ['10086'], '旧白名单不得被默认值 [] 覆盖');
  assert.equal(flat.trigger.triggerMode, 'rate', '旧触发模式必须保留');
  assert.equal(flat.trigger.maxBufferMessages, 500, '旧配置缺省项按 Schema 补齐');
  assert.equal(flat.storage.wikiDir, 'data/old');

  // 0.8.66 的容器布局：整段在 `advanced` 里。
  const nested = resolve({ advanced: { channels: ['20000'], trigger: { triggerMode: 'shadow' } } });
  assert.deepEqual(nested.channels, ['20000'], '新格式取 advanced');
  assert.equal(nested.trigger.triggerMode, 'shadow');
  assert.equal(nested.trigger.quiescenceSeconds, 300);

  // 全新配置：隐藏段全部由 Schema 默认值补齐。
  const empty = resolve({});
  assert.equal(empty.trigger.triggerMode, 'potential');
  assert.equal(empty.trigger.maxBufferMessages, 500);
  assert.equal(empty.topics.hour, 4);
  assert.deepEqual(empty.adminUsers, []);
  assert.deepEqual(empty.features, { entries: true, weekly: true, topics: true, media: true });
  assert.deepEqual(flattenConfig(empty), empty, '摊平幂等（apply 摊平后构造函数再摊平一次）');

  // 新版仍可见的三块（modelConfig / storage / security）从 advanced 迁移，旧值不能丢。
  const migrated = resolve({
    advanced: {
      storage: { wikiDir: 'data/kb' },
      security: { apiToken: 'token-from-advanced' },
      dispatcher: { provider: 'custom', baseURL: 'https://x.example/v1', apiKey: 'k', customModel: 'm' },
    },
  });
  assert.equal(migrated.storage.wikiDir, 'data/kb');
  assert.equal(migrated.security.apiToken, 'token-from-advanced');
  assert.equal(migrated.dispatcher.provider, 'custom');
  assert.deepEqual(migrated.dispatcher, migrated.modelConfig);

  // 显式写在新位置的 modelConfig 优先于旧键。
  const explicit = resolve({
    modelConfig: { provider: 'custom', baseURL: 'https://new.example/v1', apiKey: 'k', customModel: 'n' },
    dispatcher: { provider: 'standalone', baseURL: 'https://old.example/v1', apiKey: 'k', model: 'old' },
  });
  assert.equal(explicit.dispatcher.provider, 'custom', '新键写了非默认值时必须以新键为准');
  assert.equal(explicit.dispatcher.customModel, 'n');
});

test('CONFIG-13: 订阅表旧 `target` 形态——Schema 接受字符串数组，摊平后每元素一行', () => {
  // 宿主校验阶段：早期版本写出的 `target: ['1/a','2/b']` 必须能过，不能被 Schema.string() 拒掉。
  const parsedArray = Config({ subscriptions: [{ source: '1', target: ['1/a', '2/b'], entry: true, weekly: true }] });
  assert.deepEqual(parsedArray.subscriptions[0].target, ['1/a', '2/b'], '字符串数组原样通过校验');
  assert.equal('targets' in parsedArray.subscriptions[0], false, '缺失的 targets 不被 Schema 物化成 []');

  // 摊平：数组按元素展开成多行（source / entry / weekly 原样复制）。
  assert.deepEqual(flattenConfig(parsedArray).subscriptions, [
    { source: '1', targets: ['1/a'], entry: true, weekly: true },
    { source: '1', targets: ['2/b'], entry: true, weekly: true },
  ]);

  // 单值 target：一行。
  assert.deepEqual(
    flattenConfig(Config({ subscriptions: [{ source: '1', target: '2/b' }] })).subscriptions,
    [{ source: '1', targets: ['2/b'], entry: true, weekly: false }],
  );

  // 显式清空：`targets: []` 存在即权威，残留的旧 target 不复活。
  assert.deepEqual(
    flattenConfig(Config({ subscriptions: [{ source: '1', targets: [], target: '2/b' }] })).subscriptions,
    [{ source: '1', targets: [], entry: true, weekly: false }],
  );

  // 显式 targets 优先于旧 target（面板/yml 混写时以 targets 为唯一真源）。
  // 测试进程没有相册候选，`targets` 的可选值只有 `@chat`。
  assert.deepEqual(
    flattenConfig(Config({ subscriptions: [{ source: '1', targets: ['@chat'], target: '2/b' }] })).subscriptions,
    [{ source: '1', targets: ['@chat'], entry: true, weekly: false }],
  );
});
