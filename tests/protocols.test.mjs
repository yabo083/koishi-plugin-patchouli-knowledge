import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_PROTOCOLS,
  ModelDispatcher,
  geminiBaseURL,
  geminiProtocol,
  geminiUrl,
  isGeminiEndpoint,
  isProtocolId,
  normalizeBaseURL,
  resolveProtocolChain,
} from '../lib/index.js';

/** Gemini 原生响应的最小合法响应体（协议层解析用）。 */
function geminiPayload(text, tokens = 10, finishReason = 'STOP') {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason,
      },
    ],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: tokens },
  };
}

/** Chat Completions 的最小合法响应体（降级链尾）。 */
function chatPayload(text, tokens = 12) {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { total_tokens: tokens },
  };
}

// 词条必须有结构化要素（脉络 / 矩阵 / 共识 / 未决 / 原话）：摘要与名单只是导语
const KNOWLEDGE_PAYLOAD = JSON.stringify({
  shouldDiscard: false,
  title: '端点协议自动探测之争',
  summary: '群友讨论了自定义端点该不该手选协议。',
  consensus: ['默认自动探测，失败再显式指定'],
  participants: ['甲', '乙'],
  qualityScore: 0.72,
});

function makeSession() {
  return {
    sessionId: 's-protocol',
    channelId: 'g-protocol',
    startTime: 0,
    endTime: 60_000,
    messages: [
      { id: '1', channelId: 'g-protocol', userId: 'u1', userName: '甲', content: '手选协议对普通用户是多余的心智负担。', timestamp: 1 },
      { id: '2', channelId: 'g-protocol', userId: 'u2', userName: '乙', content: '但自动探测失败时要能看出走了哪条路。', timestamp: 2 },
    ],
    peakRate: 6,
    triggerReason: '协议探测测试',
  };
}

/** 一次性 HTTP 响应替身：`json` / `text` 都可用，与原生 fetch 的消费方式一致。 */
function httpResponse({ status = 200, body = '', payload } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload ?? JSON.parse(body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('PROTOCOL-06: Gemini 端点归一化与请求体形状', () => {
  const official = 'https://generativelanguage.googleapis.com';
  assert.equal(
    geminiUrl(`${official}/v1beta`, 'gemini-2.5-pro'),
    `${official}/v1beta/models/gemini-2.5-pro:generateContent`,
  );
  assert.equal(
    geminiUrl(`${official}/v1beta/`, 'models/gemini-2.5-flash'),
    `${official}/v1beta/models/gemini-2.5-flash:generateContent`,
  );
  assert.equal(
    geminiUrl(`${official}/v1beta/models/gemini-2.5-pro:generateContent`, 'gemini-2.5-pro'),
    `${official}/v1beta/models/gemini-2.5-pro:generateContent`,
    '完整端点再喂一次仍是同一个 URL',
  );
  assert.equal(
    geminiUrl(official, 'gemini-2.5-pro'),
    `${official}/v1beta/models/gemini-2.5-pro:generateContent`,
    '漏填版本段时补 /v1beta',
  );
  assert.equal(geminiBaseURL(`${official}/v1beta/models/gemini-2.5-pro:generateContent`), `${official}/v1beta`);

  assert.equal(normalizeBaseURL(`${official}/v1beta/models/gemini-2.5-pro:generateContent`), `${official}/v1beta`);
  assert.equal(normalizeBaseURL(`${official}/v1beta/`), `${official}/v1beta`);
  assert.equal(normalizeBaseURL('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1');

  const built = geminiProtocol.build({
    baseURL: `${official}/v1beta`,
    apiKey: 'gemini-key',
    model: 'gemini-2.5-pro',
    messages: [
      { role: 'system', content: '系统一' },
      { role: 'system', content: '系统二' },
      { role: 'user', content: '问题一' },
      { role: 'user', content: '问题二' },
      { role: 'assistant', content: '回答一' },
    ],
    temperature: 0.4,
    maxTokens: 2048,
    format: 'json_object',
  });

  assert.match(built.url, /\/v1beta\/models\/gemini-2\.5-pro:generateContent$/u);
  assert.equal(built.headers['x-goog-api-key'], 'gemini-key');
  assert.equal('authorization' in built.headers, false, 'Gemini 鉴权走头部而非 Bearer');
  assert.equal(built.url.includes('key='), false, '密钥绝不拼进 URL');

  assert.equal(built.body.systemInstruction.parts[0].text, '系统一\n\n系统二');
  assert.deepEqual(built.body.contents, [
    { role: 'user', parts: [{ text: '问题一\n\n问题二' }] },
    { role: 'model', parts: [{ text: '回答一' }] },
  ]);
  assert.deepEqual(built.body.generationConfig, {
    temperature: 0.4,
    maxOutputTokens: 2048,
    responseMimeType: 'application/json',
  });
  assert.equal('model' in built.body, false, '模型名在 URL 里，不在请求体');
  assert.equal('messages' in built.body, false);

  const text = geminiProtocol.build({
    baseURL: `${official}/v1beta`,
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'ping' }],
    temperature: 0.4,
    maxTokens: 64,
    format: 'text',
  });
  assert.deepEqual(text.body.generationConfig, { temperature: 0.4, maxOutputTokens: 64 });
  assert.equal('systemInstruction' in text.body, false, '无 system 消息时不发空 systemInstruction');
  assert.equal('x-goog-api-key' in text.headers, false, '无 key 时不发空鉴权头');

  assert.equal(geminiProtocol.isFormatRejection('response_mime_type is not supported'), true);
  assert.equal(geminiProtocol.isFormatRejection('Invalid JSON payload: response_schema unknown'), true);
  assert.equal(geminiProtocol.isFormatRejection('API key not valid. Please pass a valid API key.'), false);
});

test('PROTOCOL-07: Gemini 响应解析（parts 拼接 / usage / MAX_TOKENS / blockReason）', () => {
  const payload = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: '前半' }, { thought: true, text: '思考过程' }, { text: '后半' }],
        },
        finishReason: 'MAX_TOKENS',
      },
    ],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 },
  };
  const parsed = geminiProtocol.parse(payload);
  assert.equal(parsed.text, '前半后半', '思考分片不计入正文');
  assert.equal(parsed.tokensUsed, 33);
  assert.equal(parsed.finishReason, 'length', 'MAX_TOKENS 归一化为 length');

  assert.throws(
    () => geminiProtocol.parse({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }),
    (error) => error.name === 'ProtocolParseError' && /blockReason=SAFETY/u.test(error.message),
  );
  assert.throws(
    () => geminiProtocol.parse({ candidates: [] }),
    (error) => error.name === 'ProtocolParseError' && /candidates\[0\]/u.test(error.message),
  );
  assert.throws(
    () => geminiProtocol.parse({ candidates: [{ content: { parts: [] } }] }),
    (error) => error.name === 'ProtocolParseError',
  );
  assert.throws(
    () => geminiProtocol.parse([]),
    (error) => error.name === 'ProtocolParseError',
  );
});

test('PROTOCOL-08: 协议注册表与自动探测链顺序', () => {
  assert.deepEqual(Object.keys(MODEL_PROTOCOLS).sort(), ['chat-completions', 'gemini', 'responses']);
  assert.equal(MODEL_PROTOCOLS.gemini.id, 'gemini');
  assert.equal(MODEL_PROTOCOLS.gemini.label, 'Gemini');
  assert.equal(isProtocolId('gemini'), true);
  assert.equal(isProtocolId('auto'), false, 'auto 是选择策略，不是协议');

  assert.equal(isGeminiEndpoint('https://generativelanguage.googleapis.com/v1beta'), true);
  assert.equal(isGeminiEndpoint('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent'), true);
  assert.equal(isGeminiEndpoint('https://api.openai.com/v1'), false);
  assert.equal(isGeminiEndpoint(''), false);

  const ids = (config) => resolveProtocolChain(config).map((protocol) => protocol.id);

  assert.deepEqual(ids({ protocol: 'auto', baseURL: 'https://generativelanguage.googleapis.com/v1beta' }), [
    'gemini',
    'chat-completions',
  ]);
  assert.deepEqual(ids({ baseURL: 'https://api.openai.com/v1' }), ['responses', 'chat-completions']);
  assert.deepEqual(ids({ protocol: 'auto', baseURL: 'https://api.deepseek.com/v1' }), [
    'responses',
    'chat-completions',
  ]);
  assert.deepEqual(ids({ baseURL: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'responses' }), [
    'responses',
  ], '显式协议不参与端点形状推断');
  assert.deepEqual(ids({ protocol: 'gemini' }), ['gemini']);
  assert.deepEqual(ids({ protocol: 'chat-completions' }), ['chat-completions']);
  assert.deepEqual(ids({ protocol: 'future-rpc' }), ['responses'], '未知协议沿用旧回退');
});

test('PROTOCOL-09: auto 探测在 404 时顺延协议并缓存结果', async () => {
  const calls = [];
  const logs = [];
  const fetchFake = async (url) => {
    calls.push(url);
    if (url.endsWith('/responses')) {
      return httpResponse({ status: 404, body: 'Not Found' });
    }
    return httpResponse({ status: 200, payload: chatPayload(KNOWLEDGE_PAYLOAD) });
  };

  const dispatcher = new ModelDispatcher(
    { provider: 'custom', apiKey: 'sk-secret-key', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
    { fetch: fetchFake, logger: { warn: (message) => logs.push(message), debug: () => undefined } },
  );

  assert.equal(dispatcher.protocolId, 'responses', '未发请求前 = 主候选');
  assert.match(dispatcher.chatUrl, /\/responses$/u);

  const first = await dispatcher.dispatch(makeSession());
  assert.equal(first.success, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/responses$/u);
  assert.match(calls[1], /\/chat\/completions$/u);

  assert.equal(dispatcher.protocolId, 'chat-completions', '探测成功后固定该协议');
  assert.match(dispatcher.chatUrl, /\/chat\/completions$/u);

  const second = await dispatcher.dispatch(makeSession());
  assert.equal(second.success, true);
  assert.equal(calls.length, 3, '已固定协议，不再每次重探');
  assert.match(calls[2], /\/chat\/completions$/u);

  const switched = logs.filter((line) => line.includes('切换为'));
  assert.equal(switched.length, 1);
  assert.ok(switched[0].includes('HTTP 404'), '切换日志带状态码');
  for (const line of logs) {
    assert.equal(line.includes('sk-secret-key'), false, '日志绝不记录密钥');
    assert.equal(line.includes('手选协议'), false, '日志绝不记录消息正文');
  }
});

test('PROTOCOL-10: Gemini 端点自动走原生协议并把生效协议透出给 self-check', async () => {
  const calls = [];
  const fetchFake = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return httpResponse({ status: 200, payload: geminiPayload(KNOWLEDGE_PAYLOAD, 42) });
  };
  const dispatcher = new ModelDispatcher(
    {
      provider: 'custom',
      apiKey: 'gemini-key',
      model: 'gemini-2.5-pro',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    },
    { fetch: fetchFake },
  );

  assert.equal(dispatcher.protocolId, 'gemini', 'Gemini 端点的主候选是 gemini');
  assert.match(dispatcher.chatUrl, /:generateContent$/u);

  const result = await dispatcher.dispatch(makeSession());
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-2\.5-pro:generateContent$/u);
  assert.equal(calls[0].headers['x-goog-api-key'], 'gemini-key');
  assert.equal(Array.isArray(calls[0].body.contents), true);

  const probe = await dispatcher.probe();
  assert.equal(probe.ok, true);
  assert.equal(probe.protocol, 'gemini');
  assert.equal(probe.route, 'standalone');
});

test('PROTOCOL-11: 只有「端点不支持该协议」才降级，凭据 / 限流 / 显式协议都不切换', async () => {
  const logs = [];

  // 1) 400 + 明确的 endpoint 文案 → 顺延链
  const unknownUrlCalls = [];
  const unknownUrl = new ModelDispatcher(
    { provider: 'custom', apiKey: 'k', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
    {
      fetch: async (url) => {
        unknownUrlCalls.push(url);
        if (url.endsWith('/responses')) {
          return httpResponse({ status: 400, body: '{"error":"Unknown url: /v1/responses"}' });
        }
        return httpResponse({ status: 200, payload: chatPayload(KNOWLEDGE_PAYLOAD) });
      },
      logger: { warn: (message) => logs.push(message) },
    },
  );
  assert.equal((await unknownUrl.dispatch(makeSession())).success, true);
  assert.equal(unknownUrl.protocolId, 'chat-completions');
  assert.equal(unknownUrlCalls.length, 2);

  // 2) Gemini 400 `API key not valid` 是凭据错 → 不降级
  const credentialCalls = [];
  const credential = new ModelDispatcher(
    {
      provider: 'custom',
      apiKey: 'bad-key',
      model: 'gemini-2.5-pro',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    },
    {
      fetch: async (url) => {
        credentialCalls.push(url);
        return httpResponse({ status: 400, body: 'API key not valid. Please pass a valid API key.' });
      },
    },
  );
  const credentialResult = await credential.dispatch(makeSession());
  assert.equal(credentialResult.success, false);
  assert.match(credentialResult.failureReason ?? '', /HTTP 400/u);
  assert.equal(credential.protocolId, 'gemini', '凭据错误绝不切换协议');
  assert.equal(credentialCalls.length, 1);

  // 3) 429 是重试类错误 → 不切换
  const rateLimitedCalls = [];
  const rateLimited = new ModelDispatcher(
    { provider: 'custom', apiKey: 'k', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
    {
      maxRetries: 0,
      fetch: async (url) => {
        rateLimitedCalls.push(url);
        return httpResponse({ status: 429, body: 'slow down' });
      },
    },
  );
  assert.equal((await rateLimited.dispatch(makeSession())).success, false);
  assert.equal(rateLimited.protocolId, 'responses');
  assert.equal(rateLimitedCalls.length, 1);

  // 4) 显式协议 = 单元素链 → 404 保持旧失败语义
  const explicitCalls = [];
  const explicit = new ModelDispatcher(
    { provider: 'custom', apiKey: 'k', model: 'gpt-4o-mini', protocol: 'responses' },
    {
      fetch: async (url) => {
        explicitCalls.push(url);
        return httpResponse({ status: 404, body: 'Not Found' });
      },
    },
  );
  const explicitResult = await explicit.dispatch(makeSession());
  assert.equal(explicitResult.success, false);
  assert.match(explicitResult.failureReason ?? '', /HTTP 404/u);
  assert.equal(explicit.protocolId, 'responses');
  assert.equal(explicitCalls.length, 1);

  // 5) 自动探测链尾也失败 → 明确失败，且两条协议各试一次
  const exhaustedCalls = [];
  const exhausted = new ModelDispatcher(
    { provider: 'custom', apiKey: 'k', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
    {
      fetch: async (url) => {
        exhaustedCalls.push(url);
        return httpResponse({ status: 404, body: 'Not Found' });
      },
    },
  );
  const exhaustedResult = await exhausted.dispatch(makeSession());
  assert.equal(exhaustedResult.success, false);
  assert.match(exhaustedResult.failureReason ?? '', /HTTP 404/u);
  assert.equal(exhaustedCalls.length, 2, '链上两条协议各试一次');
  assert.equal(exhausted.protocolId, 'chat-completions', '链尾协议被固定，后续请求不再重探');
});
