import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_JUDGE_OPTIONS, JudgeClient } from '../lib/judge/client.js';

/** 造一个 2xx 的 JSON 响应。 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 装一个只记录调用的假 fetch；`handler` 决定每次返回/抛出什么。 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

const STATE = '[10:00] 张三：薛定谔方程的边界条件\n[10:01] 李四：本质是无界算子的自伴扩张';

test('JUDGE-01: noul 响应解析为 P(true) 且请求形状符合 System One 契约', async () => {
  const { impl, calls } = fakeFetch(() =>
    jsonResponse({ answers: { valuable: { type: 'noul', noul: 0.83 } } }),
  );
  const client = new JudgeClient(
    { enabled: true, baseURL: 'http://127.0.0.1:5070', apiKey: 'jev-secret' },
    { fetch: impl },
  );

  const decision = await client.gate(STATE);

  assert.equal(decision.available, true);
  assert.equal(decision.probability, 0.83);
  assert.equal(decision.reason, undefined);

  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.ok(url.endsWith('/v1/systemone'), `URL 应以 /v1/systemone 结尾，实际 ${url}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer jev-secret');

  const body = JSON.parse(init.body);
  assert.equal(body.model, 'jev-local');
  assert.equal(body.state, STATE);
  assert.equal(body.questions.valuable.type, 'noul');
  assert.equal(typeof body.questions.valuable.instructions, 'string');
  assert.ok(body.questions.valuable.instructions.length > 0);
});

test('JUDGE-02: choice 响应选中最可能候选；none 表示连续讨论不切', async () => {
  const chosen = fakeFetch(() =>
    jsonResponse({
      answers: {
        boundary: {
          type: 'choice',
          choice: '7',
          probabilities: { 3: 0.2, 7: 0.6, none: 0.2 },
          confidence: 0.6,
        },
      },
    }),
  );
  const client = new JudgeClient({ enabled: true }, { fetch: chosen.impl });

  const cut = await client.boundary(STATE, [3, 7]);
  assert.equal(cut.available, true);
  assert.equal(cut.index, 7);
  assert.deepEqual(cut.probabilities, { 3: 0.2, 7: 0.6, none: 0.2 });

  const continuous = fakeFetch(() =>
    jsonResponse({
      answers: {
        boundary: {
          type: 'choice',
          choice: 'none',
          probabilities: { 3: 0.1, 7: 0.1, none: 0.8 },
        },
      },
    }),
  );
  const client2 = new JudgeClient({ enabled: true }, { fetch: continuous.impl });

  const noCut = await client2.boundary(STATE, [3, 7]);
  assert.equal(noCut.available, true);
  assert.equal(noCut.index, null);
});

test('JUDGE-03: 非 2xx 降级为 available:false 且 reason 含状态码', async () => {
  for (const status of [500, 401]) {
    const { impl } = fakeFetch(() => new Response('upstream exploded', { status }));
    const client = new JudgeClient({ enabled: true }, { fetch: impl });

    const decision = await client.gate(STATE);
    assert.equal(decision.available, false);
    assert.equal(decision.probability, 1, 'fail-open：不可用时按放行处理');
    assert.match(String(decision.reason), new RegExp(String(status), 'u'));

    const boundary = await client.boundary(STATE, [3, 7]);
    assert.equal(boundary.available, false);
    assert.equal(boundary.index, null);
    assert.deepEqual(boundary.probabilities, {});
    assert.match(String(boundary.reason), new RegExp(String(status), 'u'));
  }
});

test('JUDGE-04: 超时降级为 available:false、reason 可读且定时器已清理', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map();

  globalThis.setTimeout = (callback, delay, ...rest) => {
    const timer = realSetTimeout(callback, delay, ...rest);
    timers.set(timer, { delay, cleared: false });
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    const record = timers.get(timer);
    if (record !== undefined) record.cleared = true;
    return realClearTimeout(timer);
  };

  try {
    // 只在 abort 时 reject：模拟一个被超时打断的挂起请求。
    const { impl } = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        }),
    );
    const client = new JudgeClient({ enabled: true, timeoutMs: 20 }, { fetch: impl });

    const decision = await client.gate(STATE);
    assert.equal(decision.available, false);
    assert.equal(decision.probability, 1);
    assert.equal(typeof decision.reason, 'string');
    assert.match(String(decision.reason), /超时|timeout|abort/iu);

    const judgeTimers = [...timers.values()].filter((record) => record.delay === 20);
    assert.equal(judgeTimers.length, 1, '应当只创建一个 20ms 超时定时器');
    assert.equal(judgeTimers[0].cleared, true, '超时定时器必须在 finally 中清理');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('JUDGE-05: 畸形 JSON / answers 缺失 / 概率越界一律降级', async () => {
  const malformed = new JudgeClient(
    { enabled: true },
    { fetch: fakeFetch(() => new Response('{ not json', { status: 200 })).impl },
  );
  const malformedGate = await malformed.gate(STATE);
  assert.equal(malformedGate.available, false);
  assert.match(String(malformedGate.reason), /JSON/u);

  const noAnswers = new JudgeClient(
    { enabled: true },
    { fetch: fakeFetch(() => jsonResponse({ ok: true })).impl },
  );
  const noAnswersGate = await noAnswers.gate(STATE);
  assert.equal(noAnswersGate.available, false);
  assert.match(String(noAnswersGate.reason), /answers/u);
  const noAnswersBoundary = await noAnswers.boundary(STATE, [3, 7]);
  assert.equal(noAnswersBoundary.available, false);
  assert.match(String(noAnswersBoundary.reason), /answers/u);

  const overRange = new JudgeClient(
    { enabled: true },
    { fetch: fakeFetch(() => jsonResponse({ answers: { valuable: { type: 'noul', noul: 1.4 } } })).impl },
  );
  const overRangeGate = await overRange.gate(STATE);
  assert.equal(overRangeGate.available, false);
  assert.match(String(overRangeGate.reason), /1\.4/u);

  const badProbabilities = new JudgeClient(
    { enabled: true },
    {
      fetch: fakeFetch(() =>
        jsonResponse({
          answers: {
            boundary: { type: 'choice', choice: '7', probabilities: { 7: 1.5, none: -0.1 } },
          },
        }),
      ).impl,
    },
  );
  const badBoundary = await badProbabilities.boundary(STATE, [3, 7]);
  assert.equal(badBoundary.available, false);
  assert.equal(badBoundary.index, null);
  assert.deepEqual(badBoundary.probabilities, {});
});

test('JUDGE-06: enabled:false 不发任何请求，直接失败关闭', async () => {
  assert.equal(DEFAULT_JUDGE_OPTIONS.enabled, false);
  assert.equal(DEFAULT_JUDGE_OPTIONS.baseURL, 'http://127.0.0.1:5070');
  assert.equal(DEFAULT_JUDGE_OPTIONS.model, 'jev-local');
  assert.equal(DEFAULT_JUDGE_OPTIONS.timeoutMs, 8000);

  const { impl, calls } = fakeFetch(() => {
    throw new Error('should never be called');
  });
  const client = new JudgeClient({ enabled: false }, { fetch: impl });
  const unconfigured = new JudgeClient(undefined, { fetch: impl });

  for (const instance of [client, unconfigured]) {
    const gate = await instance.gate(STATE);
    assert.equal(gate.available, false);
    assert.equal(gate.probability, 1);
    assert.equal(gate.reason, 'judge-disabled');

    const boundary = await instance.boundary(STATE, [3, 7]);
    assert.equal(boundary.available, false);
    assert.equal(boundary.index, null);
    assert.deepEqual(boundary.probabilities, {});
    assert.equal(boundary.reason, 'judge-disabled');
  }

  assert.equal(calls.length, 0, '未启用时假 fetch 的调用次数必须为 0');
});

test('JUDGE-07: boundary 默认 criteria 覆盖候选编号与 none，且语义为「该编号消息之前」', async () => {
  const { impl, calls } = fakeFetch(() =>
    jsonResponse({ answers: { boundary: { type: 'choice', choice: 'none', probabilities: {} } } }),
  );
  const client = new JudgeClient({ enabled: true }, { fetch: impl });

  await client.boundary(STATE, [3, 7]);

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  const question = body.questions.boundary;
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria).sort(), ['3', '7', 'none']);
  assert.equal(question.criteria['3'], '在编号 3 的消息之前发生话题切换');
  assert.equal(question.criteria['7'], '在编号 7 的消息之前发生话题切换');
  assert.equal(question.criteria.none, '连续讨论，不切');
  assert.match(question.instructions, /序号从 1 开始/, 'instructions 必须说明编号从 1 开始');
  assert.match(question.instructions, /发生在哪个编号的消息之前/, '请求语义必须与执行侧「切在该消息之前」一致');
  assert.ok(!/之后发生话题切换/.test(question.instructions), '不得再出现与执行侧错位一条的「之后」语义');
});
