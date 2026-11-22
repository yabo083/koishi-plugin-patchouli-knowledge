import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUFFER_SOFT_SLICE_MESSAGES,
  BurstQuiescenceDetector,
  computeDynamicQuiescence,
  evaluateWindow,
} from '../lib/index.js';

const BASE_TIME = 1700000000000;

function makeMessage(overrides = {}) {
  return {
    id: 'msg',
    channelId: 'group-trigger',
    userId: 'u1',
    userName: '群友1',
    content: '讨论内容',
    timestamp: BASE_TIME,
    ...overrides,
  };
}

function assertClose(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message ?? ''} 期望 ${expected}，实际 ${actual}`,
  );
}

test('BURST-01: 常态闲聊不误触 (速率低于突发阈值保持 IDLE)', () => {
  const settled = [];
  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
    },
    onQuiescence: (session) => {
      settled.push(session);
    },
  });

  const channelId = 'group-normal-chat';
  let timestamp = BASE_TIME;

  // 模拟闲聊：每 30 秒发送一条消息，持续 10 分钟 (20条消息，瞬时速率 2 条/分)
  for (let i = 0; i < 20; i++) {
    timestamp += 30_000;
    const metrics = detector.onMessage(
      makeMessage({
        id: `msg-${i}`,
        channelId,
        userId: `user-${i % 3}`,
        userName: `群友${i % 3}`,
        content: `闲聊消息 ${i}`,
        timestamp,
      }),
    );

    // 速率恒低于 minBurstRate (6 条/分)，状态必须始终为 IDLE
    assert.equal(metrics.phase, 'IDLE');
    assert.ok(metrics.currentRate <= 2.5);
  }

  assert.equal(settled.length, 0, '常态闲聊不应触发平息结算');
  detector.dispose();
});

test('BURST-02 & BURST-03: 激烈讨论触发录制，并在平息后进入迟智结算', () => {
  const settled = [];
  let currentTime = BASE_TIME;

  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 100, // 100 秒无次级突发即平息
      minDiscussionMessages: 10,
    },
    now: () => currentTime,
    onQuiescence: (session) => {
      settled.push(session);
    },
  });

  const channelId = 'group-debate';

  // 1. 铺垫少许日常基线 (1 条消息)
  detector.onMessage(
    makeMessage({
      id: 'base-1',
      channelId,
      userId: 'u1',
      userName: 'A',
      content: '开始讨论了吗？',
      timestamp: currentTime,
    }),
  );

  // 2. 突发讨论：在 30 秒内密集涌入 15 条观点消息 (双人以上、内容互异)
  for (let i = 1; i <= 15; i++) {
    currentTime += 2000; // 每 2 秒一条
    const metrics = detector.onMessage(
      makeMessage({
        id: `debate-${i}`,
        channelId,
        userId: `user-${i % 4}`,
        userName: `辩友-${i % 4}`,
        content: `论点交锋 #${i}：我认为方案A优于方案B，理由...`,
        timestamp: currentTime,
      }),
    );

    if (i >= 7) {
      // 滑动窗口累积超过 minBurstRate(6 条/分) 门限，状态进入 BURSTING
      assert.equal(metrics.phase, 'BURSTING');
      assert.ok(metrics.currentRate > 6);
    }
  }

  assert.equal(detector.getStatus(channelId).phase, 'BURSTING');
  assert.equal(settled.length, 0, '讨论高潮期间严禁插话结算 (迟智特性)');

  // 3. 讨论降温：进入 120 秒长静默期，频率归零（末尾 3 条为普通论点，不触发动态延长）
  currentTime += 120_000;
  // 注入一条心跳消息或推进时钟触发平息
  detector.onMessage(
    makeMessage({
      id: 'after-quiescent-msg',
      channelId,
      userId: 'u2',
      userName: 'B',
      content: '大家说完了吗？',
      timestamp: currentTime,
    }),
  );

  assert.equal(settled.length, 1, '平息静默期结束后必须完成迟智沉淀交接');
  const session = settled[0];
  assert.equal(session.channelId, channelId);
  assert.ok(session.messages.length >= 15);
  assert.ok(session.peakRate >= 10);

  detector.dispose();
});

test('BURST-04: 冷却期次级突发重置状态机，防止截断论战', () => {
  const settled = [];
  let currentTime = BASE_TIME;

  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.0,
      minBurstRate: 5,
      quiescenceSeconds: 100,
    },
    now: () => currentTime,
    onQuiescence: (session) => {
      settled.push(session);
    },
  });

  const channelId = 'group-counter-debate';

  // 第一波突发：10 条消息 (每 3 秒一条，双人交锋)
  for (let i = 1; i <= 10; i++) {
    currentTime += 3000;
    detector.onMessage(
      makeMessage({
        id: `wave1-${i}`,
        channelId,
        userId: i % 2 === 0 ? 'u2' : 'u1',
        userName: i % 2 === 0 ? 'B' : 'A',
        content: `第一波观点 ${i}：方案A的第 ${i} 条论据`,
        timestamp: currentTime,
      }),
    );
  }

  assert.equal(detector.getStatus(channelId).phase, 'BURSTING');

  // 等待 65 秒 (瞬时速率回落，开始进入 COOLING)
  currentTime += 65_000;
  detector.tick(currentTime, channelId);
  const statusAfterWait = detector.getStatus(channelId, currentTime);
  assert.ok(statusAfterWait.phase === 'COOLING' || statusAfterWait.phase === 'BURSTING');

  // 在未满 100 秒平息窗口前，突然爆发第二波反驳论战！
  for (let i = 1; i <= 8; i++) {
    currentTime += 2000;
    const m = detector.onMessage(
      makeMessage({
        id: `wave2-${i}`,
        channelId,
        userId: i % 2 === 0 ? 'u4' : 'u3',
        userName: i % 2 === 0 ? 'D' : 'C',
        content: `强烈反对上一轮观点！补充反例 ${i} 与对照实验`,
        timestamp: currentTime,
      }),
    );
    if (i >= 6) {
      // 第二波累积速率超过 minBurstRate(5 条/分) 门限，状态重新回弹回 BURSTING
      assert.equal(m.phase, 'BURSTING');
    }
  }
  // 此时未交接
  assert.equal(settled.length, 0, '次级突发必须延长缓存，不得过早结算');

  // 最终平息
  currentTime += 150_000;
  detector.tick(currentTime, channelId);
  assert.equal(settled.length, 1, '第二波平息后统一交付全量会话');
  assert.ok(settled[0].messages.length >= 18, '应包含前后两波的全部讨论内容');

  detector.dispose();
});

test('FILTER-01: 物理层剥离 Satori/CQ 码并过滤纯表情/单字/标点刷屏', () => {
  const messages = [
    makeMessage({ id: 'f1', content: '<img src="https://x/y.png"/>' }),
    makeMessage({ id: 'f2', content: '[CQ:image,file=abc.jpg]' }),
    makeMessage({ id: 'f3', content: '😂😂😂😂' }),
    makeMessage({ id: 'f4', content: '好' }),
    makeMessage({ id: 'f5', content: '？？？！！！……' }),
    makeMessage({ id: 'f6', content: '<at id="1" name="A"/> 怎么办？' }),
    makeMessage({ id: 'f7', userId: 'u1', content: '<b>这个方案</b>其实风险很大' }),
    makeMessage({ id: 'f8', userId: 'u2', content: '&lt;img src=x&gt; 只是被转义的正文' }),
  ];

  const evaluation = evaluateWindow(messages, 60);
  assert.equal(evaluation.totalMessages, 8);
  assert.equal(evaluation.effectiveMessages, 2, '只有真正的纯文本才计入有效消息');
  assert.equal(evaluation.uniqueSpeakers, 2);
  assert.equal(evaluation.entropyRatio, 1);
  assert.equal(evaluation.effectiveRate, 2);
});

test('FILTER-02: 有效速率按窗口折算，信息熵率暴露复读', () => {
  const content = '同一句复读内容反复刷屏';
  const messages = [];
  for (let i = 0; i < 6; i++) {
    messages.push(
      makeMessage({
        id: `rep-${i}`,
        userId: i % 2 === 0 ? 'u1' : 'u2',
        userName: i % 2 === 0 ? 'A' : 'B',
        content,
        timestamp: BASE_TIME + i * 5000,
      }),
    );
  }

  const evaluation = evaluateWindow(messages, 30);
  assert.equal(evaluation.effectiveMessages, 6);
  assert.equal(evaluation.uniqueSpeakers, 2);
  assert.equal(evaluation.entropyRatio, 1 / 6);
  assert.equal(evaluation.effectiveRate, 12);
  assert.equal(evaluation.avgCharLength, content.length);

  // 锚点之外的旧消息不参与统计
  const outside = evaluateWindow(
    messages.concat([makeMessage({ id: 'old', content: '很久以前的有效消息', timestamp: BASE_TIME - 60_000 })]),
    30,
  );
  assert.equal(outside.totalMessages, 6);
  assert.equal(outside.effectiveMessages, 6);
});

test('GATE-01: 单人高速刷屏在 IDLE 被物理门限拦截', () => {
  let now = BASE_TIME;
  const settled = [];
  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 1.5,
      minBurstRate: 4,
      quiescenceSeconds: 60,
    },
    now: () => now,
    onQuiescence: (session) => {
      settled.push(session);
    },
  });

  const channelId = 'group-solo-spam';
  for (let i = 0; i < 15; i++) {
    now += 2000;
    const metrics = detector.onMessage(
      makeMessage({
        id: `solo-${i}`,
        channelId,
        userId: 'solo',
        userName: '刷屏者',
        content: `独自刷屏的第 ${i} 条内容，速率很高`,
        timestamp: now,
      }),
    );
    assert.equal(metrics.phase, 'IDLE', '单人刷屏不得进入 BURSTING');
  }

  assert.equal(settled.length, 0);
  detector.dispose();
});

test('GATE-02: 双人复读机因信息熵率不足被拦截', () => {
  let now = BASE_TIME;
  const settled = [];
  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 1.5,
      minBurstRate: 4,
      quiescenceSeconds: 60,
    },
    now: () => now,
    onQuiescence: (session) => {
      settled.push(session);
    },
  });

  const channelId = 'group-copy-spam';
  for (let i = 0; i < 15; i++) {
    now += 2000;
    const metrics = detector.onMessage(
      makeMessage({
        id: `copy-${i}`,
        channelId,
        userId: i % 2 === 0 ? 'u1' : 'u2',
        userName: i % 2 === 0 ? 'A' : 'B',
        content: '同一句话反复复读刷屏水群',
        timestamp: now,
      }),
    );
    assert.equal(metrics.phase, 'IDLE', '双人复读也不得进入 BURSTING');
  }

  assert.equal(settled.length, 0);
  detector.dispose();
});

test('DYNQ-01: computeDynamicQuiescence 四类语义信号按 1.2~2.2 倍延长', () => {
  const normal = computeDynamicQuiescence([makeMessage({ content: '普通讨论内容，没有特殊标记' })], 100);
  assert.equal(normal.factor, 1);
  assert.equal(normal.seconds, 100);
  assert.deepEqual(normal.signals, {
    codeBlock: false,
    url: false,
    question: false,
    longForm: false,
  });

  const single = computeDynamicQuiescence([makeMessage({ content: '这个方案到底怎么落地？' })], 100);
  assertClose(single.factor, 1.45);
  assertClose(single.seconds, 145);

  const filler = '用于触发长文判据的完整论证内容'.repeat(3);
  const all = computeDynamicQuiescence(
    [
      makeMessage({
        content: `\`\`\`ts\nconst cache = new Map();\n\`\`\` 参考 https://example.com/spec 的约束，${filler}？`,
      }),
      makeMessage({ content: `方案二的论证如下：${filler}` }),
      makeMessage({ content: `方案三的论证如下：${filler}` }),
    ],
    100,
  );
  assert.deepEqual(all.signals, {
    codeBlock: true,
    url: true,
    question: true,
    longForm: true,
  });
  assertClose(all.factor, 2.2);
  assertClose(all.seconds, 220);
  assert.equal(all.sampleSize, 3);
});

test('DYNQ-02: BURSTING 接近平息时按末尾语义延长 quiescence', () => {
  let now = BASE_TIME;
  const settled = [];
  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 1.5,
      minBurstRate: 4,
      quiescenceSeconds: 60,
      minDiscussionMessages: 6,
    },
    now: () => now,
    onQuiescence: (session) => {
      settled.push(session);
    },
  });

  const channelId = 'group-dynq';
  for (let i = 0; i < 8; i++) {
    now += 2000;
    detector.onMessage(
      makeMessage({
        id: `dyn-${i}`,
        channelId,
        userId: i % 2 === 0 ? 'u1' : 'u2',
        content: `常规论据 ${i} 的展开说明`,
        timestamp: now,
      }),
    );
  }
  assert.equal(detector.getStatus(channelId).phase, 'BURSTING');

  const filler = '用于触发长文判据的完整论证内容'.repeat(3);
  const tail = [
    `\`\`\`js\nconsole.log('x')\n\`\`\` 参考 https://example.com/spec 的实现，${filler}？`,
    `方案二论证：${filler}`,
    `方案三论证：${filler}`,
  ];
  for (let i = 0; i < tail.length; i++) {
    now += 2000;
    detector.onMessage(
      makeMessage({
        id: `dyn-tail-${i}`,
        channelId,
        userId: i % 2 === 0 ? 'u1' : 'u2',
        content: tail[i],
        timestamp: now,
      }),
    );
  }

  // 基础平息 60s × 2.2 = 132s：80 秒时不得结算
  detector.tick(now + 80_000);
  assert.equal(settled.length, 0, '动态延长后不得按基础平息期提前结算');
  assert.equal(detector.getStatus(channelId, now + 80_000).phase, 'COOLING');
  assertClose(detector.getState(channelId).quiescenceFactor, 2.2);

  // 越过 132 秒后正常结算
  detector.tick(now + 140_000);
  assert.equal(settled.length, 1);
  detector.dispose();
});

test('FREEZE-01: 突发期基线绝对冻结，结算后解冻', () => {
  let now = BASE_TIME;
  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 1.5,
      minBurstRate: 4,
      quiescenceSeconds: 60,
      minDiscussionMessages: 6,
    },
    now: () => now,
    onQuiescence: () => {},
  });

  const channelId = 'group-freeze';
  // 常态铺垫：每 20 秒一条，双发言人
  for (let i = 0; i < 6; i++) {
    now += 20_000;
    detector.onMessage(
      makeMessage({
        id: `normal-${i}`,
        channelId,
        userId: i % 2 === 0 ? 'u1' : 'u2',
        content: `日常闲聊内容 ${i}`,
        timestamp: now,
      }),
    );
  }
  assert.equal(detector.baseline.isLearning(channelId), true);

  let baselineAtBurst = null;
  for (let i = 0; i < 40; i++) {
    now += 2000;
    const metrics = detector.onMessage(
      makeMessage({
        id: `burst-${i}`,
        channelId,
        userId: i % 2 === 0 ? 'u1' : 'u2',
        content: `突发论据 ${i}：方案对比与反例`,
        timestamp: now,
      }),
    );
    if (metrics.phase === 'BURSTING' && baselineAtBurst === null) {
      baselineAtBurst = detector.baseline.getRate(channelId);
      assert.equal(detector.baseline.isLearning(channelId), false, '脱离 IDLE 后必须冻结学习');
    }
  }

  assert.notEqual(baselineAtBurst, null, '本轮必须触发突发');
  assert.equal(detector.baseline.getRate(channelId), baselineAtBurst, '突发期基线不得变化');
  assert.equal(detector.baseline.isLearning(channelId), false);

  // 静默结算后解冻
  now += 200_000;
  detector.tick(now);
  assert.equal(detector.getStatus(channelId, now).phase, 'SUMMARIZING');
  assert.equal(detector.baseline.isLearning(channelId), true, '结算后必须解冻基线学习');
  detector.dispose();
});

test('SLICE-01: 缓冲区达到 120 条触发软切片且相位不变', () => {
  let now = BASE_TIME;
  const sessions = [];
  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 1.5,
      minBurstRate: 4,
      quiescenceSeconds: 3600,
      minDiscussionMessages: 6,
    },
    now: () => now,
    onQuiescence: (session) => {
      sessions.push(session);
    },
  });

  const channelId = 'group-slice';
  for (let i = 0; i < 200; i++) {
    now += 100;
    detector.onMessage(
      makeMessage({
        id: `slice-${i}`,
        channelId,
        userId: `u${i % 3}`,
        content: `持续讨论的第 ${i} 条观点，内容互不相同`,
        timestamp: now,
      }),
    );
  }

  assert.ok(sessions.length >= 1, '达到阈值必须交付软切片');
  assert.equal(sessions[0].messages.length, BUFFER_SOFT_SLICE_MESSAGES);
  assert.ok(sessions[0].triggerReason.includes('软切片'));
  const state = detector.getState(channelId);
  assert.equal(state.phase, 'BURSTING', '软切片不得改变状态机相位');
  assert.ok(state.buffer.length < BUFFER_SOFT_SLICE_MESSAGES, '切片后缓冲必须清空并重新累积');
  detector.dispose();
});

test('BOUND-01: 超长消息在进入常驻容器前被裁到入口上限（且不阻塞事件循环）', () => {
  const detector = new BurstQuiescenceDetector({
    options: { triggerMode: 'shadow', windowSizeSeconds: 60, minDiscussionMessages: 12, maxBufferMessages: 500 },
    onQuiescence: async () => {},
    onDiscard: async () => {},
  });
  const started = Date.now();
  detector.onMessage(makeMessage({ id: 'big', content: 'x'.repeat(5_000_000) }));
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 500, `5MB 单条不得同步阻塞（实测 ${elapsed}ms）`);
  const recent = detector.recentMessages.get('group-trigger') ?? [];
  assert.ok(recent.length > 0, 'shadow 模式必须写入回溯环');
  for (const entry of recent) {
    assert.ok(
      entry.message.content.length <= 4000,
      `回溯环里不得出现未裁剪正文（${entry.message.content.length} 字符）`,
    );
  }
  for (const entry of detector.states.get('group-trigger')?.window ?? []) {
    assert.ok(entry.message.content.length <= 4000, '窗口里不得出现未裁剪正文');
  }
  detector.dispose();
});

test('BOUND-02: 未来时间戳不得把逻辑窗口撑到永不收缩', () => {
  let clock = Date.now();
  const detector = new BurstQuiescenceDetector({
    // 注入单调时钟：真实场景里墙钟与消息同步前进，用固定 wall 造不出正确的时间轴。
    now: () => clock,
    options: { windowSizeSeconds: 60, minDiscussionMessages: 12, maxBufferMessages: 500 },
    onQuiescence: async () => {},
    onDiscard: async () => {},
  });
  // 伪造一条 365 天后的消息：必须被钳到「当前 + 允许偏差」
  detector.onMessage(makeMessage({ id: 'future', timestamp: clock + 365 * 24 * 3600 * 1000, content: '伪造未来' }));
  const afterFuture = detector.states.get('group-trigger');
  assert.ok(
    afterFuture.lastMessageTime - clock <= 61_000,
    `未来戳必须被钳制（偏移 ${afterFuture.lastMessageTime - clock}ms）`,
  );

  for (let index = 0; index < 300; index += 1) {
    clock += 1000;
    detector.onMessage(
      makeMessage({ id: `real-${index}`, timestamp: clock, content: `正常消息 ${index} 讨论缓存淘汰` }),
    );
  }
  const window = detector.states.get('group-trigger')?.window ?? [];
  assert.ok(window.length <= 62, `窗口必须随墙钟收缩，实际保留 ${window.length} 条`);
  detector.dispose();
});

test('BOUND-03: 空闲群状态可回收，活跃群不受影响', () => {
  let clock = Date.now();
  const detector = new BurstQuiescenceDetector({
    now: () => clock,
    options: { windowSizeSeconds: 60, minDiscussionMessages: 12, maxBufferMessages: 500 },
    onQuiescence: async () => {},
    onDiscard: async () => {},
  });
  detector.onMessage(makeMessage({ id: 'idle-1', channelId: 'chan-idle', timestamp: clock, content: '很久以前的讨论' }));
  clock += 1000;
  detector.onMessage(makeMessage({ id: 'hot-1', channelId: 'chan-hot', timestamp: clock, content: '刚刚的讨论' }));

  // 推进 8 天：只有 chan-idle 超过阈值
  clock += 8 * 86_400_000;
  detector.onMessage(makeMessage({ id: 'hot-2', channelId: 'chan-hot', timestamp: clock, content: '又是刚刚的讨论' }));

  const removed = detector.sweepIdleChannels(7 * 86_400_000, clock);
  assert.deepEqual(removed, ['chan-idle']);
  assert.equal(detector.states.has('chan-idle'), false, '空闲群状态必须被回收');
  assert.equal(detector.states.has('chan-hot'), true, '活跃群不得被回收');
  detector.dispose();
});

test('BOUND-04: getStatus({settle:false}) 是纯读，不推进结算', async () => {
  let clock = Date.now();
  const settled = [];
  const detector = new BurstQuiescenceDetector({
    now: () => clock,
    options: { windowSizeSeconds: 60, burstMultiplier: 2.5, minBurstRate: 6, quiescenceSeconds: 300, minDiscussionMessages: 12, maxBufferMessages: 500 },
    onQuiescence: async (session) => { settled.push(session); },
    onDiscard: async () => {},
  });
  for (let index = 0; index < 20; index += 1) {
    clock += 500;
    detector.onMessage(makeMessage({
      id: `burst-${index}`,
      timestamp: clock,
      content: `第 ${index} 条密集讨论，涉及缓存分层与共识算法`,
      userId: `u${index % 5}`,
    }));
  }
  clock += 600_000; // 远超平息窗口

  detector.getStatus('group-trigger', undefined, { settle: false });
  assert.equal(settled.length, 0, '纯读不得触发结算');

  detector.getStatus('group-trigger');
  assert.equal(settled.length, 1, '默认路径仍按原语义结算');
  detector.dispose();
});

test('BOUND-05: 迟到的上一轮完成回调不得清掉当前轮的 SUMMARIZING 闩锁', () => {
  let clock = Date.now();
  const sessions = [];
  const detector = new BurstQuiescenceDetector({
    now: () => clock,
    options: { windowSizeSeconds: 60, burstMultiplier: 2.5, minBurstRate: 6, quiescenceSeconds: 300, minDiscussionMessages: 12, maxBufferMessages: 500 },
    onQuiescence: async (session) => { sessions.push(session); },
    onDiscard: async () => {},
  });
  const burst = (tag) => {
    for (let index = 0; index < 20; index += 1) {
      clock += 500;
      detector.onMessage(makeMessage({
        id: `${tag}-${index}`,
        timestamp: clock,
        userId: `u${index % 5}`,
        content: `第 ${index} 条密集讨论，涉及缓存分层与共识算法`,
      }));
    }
  };

  // 用 getStatus（推进 settle、但不像 onMessage 那样把相位复位）制造持久的 SUMMARIZING
  burst('a');
  clock += 600_000;
  detector.getStatus('group-trigger');
  assert.equal(sessions.length, 1, 'A 轮应先结算');
  assert.equal(detector.getState('group-trigger').phase, 'SUMMARIZING');

  // 新消息触发复位 → B 轮开始并再次结算
  clock += 1000;
  detector.onMessage(makeMessage({ id: 'b-start', timestamp: clock, content: '再开一轮讨论' }));
  burst('b');
  clock += 600_000;
  detector.getStatus('group-trigger');
  assert.equal(sessions.length, 2, 'B 轮也应结算');
  assert.equal(detector.getState('group-trigger').phase, 'SUMMARIZING');

  // A 的迟到完成回调：id 不匹配，不得释放 B 的闩锁
  detector.completeSummarizing('group-trigger', sessions[0].sessionId);
  assert.equal(detector.getState('group-trigger').phase, 'SUMMARIZING', 'A 的回调不得清 B 的闩锁');

  // B 自己的回调：正常释放
  detector.completeSummarizing('group-trigger', sessions[1].sessionId);
  assert.equal(detector.getState('group-trigger').phase, 'IDLE');
  detector.dispose();
});
