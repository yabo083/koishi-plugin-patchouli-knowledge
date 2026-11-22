import test from 'node:test';
import assert from 'node:assert/strict';

import { ALBUM_SCHEMA_KEY, CHATLUNA_MODEL_INHERIT, Config, DEFAULT_WEEKLY_CRON } from '../lib/index.js';

/** dispatcher 是条件表单：`intersect([判别字段, 分支 union, 公共隐藏项])`。 */
const dispatcherIntersect = () => Config.dict.dispatcher;
const branches = () => dispatcherIntersect().list[1].list;

/** custom 分支的全部端点键（历史 standalone / auto 分支与它同构）。 */
const CUSTOM_KEYS = ['apiKey', 'baseURL', 'contractRetries', 'customModel', 'protocol', 'provider', 'responseFormat'];

test('CONFIG-01: dispatcher 条件表单——provider 只有 chatluna / custom 两个可见选项', () => {
  const schema = dispatcherIntersect();
  assert.equal(schema.type, 'intersect', 'dispatcher 必须是条件表单，而不是单层扁平 object');
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

  const resolved = Config({});
  assert.equal(resolved.dispatcher.provider, 'chatluna', '默认走 ChatLuna');
  assert.equal(resolved.dispatcher.chatlunaModel, CHATLUNA_MODEL_INHERIT, '默认「无」= 继承平台默认模型');
  assert.equal(resolved.dispatcher.temperature, 0.3);
  assert.equal(resolved.dispatcher.maxTokens, 6000);
  assert.equal(resolved.dispatcher.enableAutoTuning, true);

  for (const removed of ['chatlunaPreset', 'systemPromptPreset', 'customSystemPrompt']) {
    assert.equal(removed in resolved.dispatcher, false, `${removed} 不得出现在 dispatcher 配置里`);
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

  const common = dispatcherIntersect().list[2];
  assert.deepEqual(Object.keys(common.dict).sort(), ['enableAutoTuning', 'maxTokens', 'temperature']);
  for (const key of Object.keys(common.dict)) {
    assert.equal(common.dict[key].meta.hidden, true, `${key} 属于高级覆盖，必须收起`);
  }
});

test('CONFIG-03: custom 解析补齐端点默认值，端点字段写回后不被丢弃', () => {
  const resolved = Config({
    dispatcher: { provider: 'custom', baseURL: 'https://newapi.example/v1', apiKey: 'sk-test', customModel: 'gpt-5' },
  });

  assert.equal(resolved.dispatcher.provider, 'custom');
  assert.equal(resolved.dispatcher.baseURL, 'https://newapi.example/v1');
  assert.equal(resolved.dispatcher.apiKey, 'sk-test');
  assert.equal(resolved.dispatcher.customModel, 'gpt-5');
  assert.equal(resolved.dispatcher.protocol, 'auto');
  assert.equal(resolved.dispatcher.responseFormat, 'json_object');
  assert.equal(resolved.dispatcher.maxTokens, 6000);
});

test('CONFIG-04: 历史 provider（standalone / auto）与旧单键 model 通过校验并原样保留', () => {
  for (const legacy of ['standalone', 'auto']) {
    const resolved = Config({
      dispatcher: { provider: legacy, baseURL: 'https://legacy.example/v1', apiKey: 'sk-legacy', model: 'legacy-model' },
    });
    assert.equal(resolved.dispatcher.provider, legacy, `${legacy} 必须在解析后保留，由运行时归一化`);
    assert.equal(resolved.dispatcher.baseURL, 'https://legacy.example/v1');
    assert.equal(resolved.dispatcher.apiKey, 'sk-legacy');
    assert.equal(resolved.dispatcher.model, 'legacy-model', '旧单键必须过校验：否则旧配置一加载就丢模型名');
    assert.equal(resolved.dispatcher.customModel, '', '旧配置不产出新键值，由 resolveDispatcherModels 按当前通道回填旧 model');
  }
  assert.equal(dispatcherIntersect().list[0].dict.model.meta.hidden, true, '旧单键不得出现在控制台表单里');
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
  const chatluna = Config({ dispatcher: { provider: 'chatluna', chatlunaModel: 'newapi/xz/gemini-3.8-flash' } });
  assert.equal(chatluna.dispatcher.chatlunaModel, 'newapi/xz/gemini-3.8-flash');
  assert.equal(chatluna.dispatcher.customModel, undefined, 'chatluna 分支不产出端点模型名');

  const custom = Config({
    dispatcher: { provider: 'custom', baseURL: 'https://x.example/v1', apiKey: 'k', customModel: 'gpt-5' },
  });
  assert.equal(custom.dispatcher.customModel, 'gpt-5');
  assert.equal(custom.dispatcher.chatlunaModel, undefined, 'custom 分支不产出 ChatLuna 模型 id');
});

test('CONFIG-05: 序列化契约保留动态模型 / 密钥角色与输出格式枚举，无提示词残留', () => {
  const serialized = JSON.stringify(Config.toJSON());

  assert.ok(serialized.includes('"role":"dynamic"'), '模型下拉与相册候选的 dynamic 角色必须保留');
  assert.ok(serialized.includes('"role":"secret"'), 'apiKey 的 secret 角色必须保留');
  for (const value of ['chatluna', 'custom', 'auto', 'responses', 'gemini', 'chat-completions']) {
    assert.ok(serialized.includes(`"${value}"`), `序列化必须暴露 ${value}`);
  }
  assert.ok(serialized.includes('"json_object"') && serialized.includes('"structured"'));

  assert.equal(serialized.includes('systemPromptPreset'), false, '系统提示词预设配置项必须彻底删除');
  assert.equal(serialized.includes('customSystemPrompt'), false, '自定义提示词配置项必须彻底删除');
  assert.equal(serialized.includes('"role":"textarea"'), false, '配置表单不得再出现提示词多行文本框');
  assert.equal(serialized.includes('_preview'), false, '不得残留 _preview 字段');
  assert.equal(serialized.includes('iframe'), false, '不得残留 iframe 字段');
});

test('CONFIG-06: 词条与主题共用一个相册列表，cron 与动态相册候选仍在', () => {
  const resolved = Config({});
  assert.equal(resolved.albumDelivery.cron, DEFAULT_WEEKLY_CRON, '默认每周一 04:30');
  assert.deepEqual(resolved.albumDelivery.albums, []);
  assert.equal(resolved.albumDelivery.entryEnabled, true, '讨论后立即投词条默认开启');
  assert.equal(resolved.albumDelivery.entryRedirectChannelId, '', '默认不带宽改道');

  const fields = Config.dict.albumDelivery.dict;
  assert.deepEqual(Object.keys(fields), ['entryEnabled', 'entryRedirectChannelId', 'cron', 'albums']);
  assert.equal(fields.cron.type, 'string');
  assert.equal(JSON.stringify(fields.cron.meta).includes('miyako-delivery'), true, '说明文字点明调度服务来源');

  assert.equal(fields.albums.type, 'array');
  assert.equal(fields.albums.inner.type, 'any');
  assert.equal(fields.albums.inner.meta.role, 'dynamic', '相册候选项必须由 ctx.schema 动态注入');
  assert.equal(fields.albums.inner.meta.extra.name, ALBUM_SCHEMA_KEY);
});

test('CONFIG-07: provider 写回幂等——custom 反复解析不被覆盖回 chatluna', () => {
  const first = Config({ dispatcher: { provider: 'custom', apiKey: 'sk-test', baseURL: 'https://x.example/v1', customModel: 'm' } });
  assert.equal(first.dispatcher.provider, 'custom', '用户选择的 provider 必须在解析后保留');

  const second = Config(first);
  assert.equal(second.dispatcher.provider, 'custom', '二次解析（写回后再读）仍必须是 custom');
  assert.equal(second.dispatcher.apiKey, 'sk-test');
  assert.equal(second.dispatcher.baseURL, 'https://x.example/v1');

  const third = Config(second);
  assert.deepEqual(third.dispatcher, second.dispatcher, '反复写回必须幂等');
});
