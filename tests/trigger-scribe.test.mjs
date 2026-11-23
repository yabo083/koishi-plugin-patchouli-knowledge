import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BurstQuiescenceDetector,
  MAX_MANUAL_IDLE_MS,
  MANUAL_SESSION_MIN_MESSAGES,
  ScribeStore,
  restoreScribeSessions,
} from '../lib/index.js';

const CHANNEL = '100000005';

/** 假时钟 + 假调度器：定时器按逻辑时间排队，测试显式推进。 */
function createHarness(options = {}, hooks = {}) {
  let clock = 1_700_000_000_000;
  let timers = [];
  const deliveries = [];
  const discards = [];
  const endings = [];
  const errors = [];
  const detector = new BurstQuiescenceDetector({
    options: { triggerMode: 'rate', triggerMode: 'rate', minDiscussionMessages: 12, ...options },
    now: () => clock,
    scheduler: (callback, delayMs) => {
      const timer = { at: clock + delayMs, callback };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    onQuiescence: (session) => {
      deliveries.push(session);
    },
    onDiscard: (info) => {
      discards.push(info);
    },
    onManualSessionEnd: (channelId, reason) => {
      endings.push({ channelId, reason });
      hooks.onManualSessionEnd?.(channelId, reason);
    },
    onError: (error) => {
      errors.push(error);
    },
  });

  const advance = (ms) => {
    clock += ms;
  };

  const runTimers = () => {
    timers.sort((left, right) => left.at - right.at);
    while (timers.length > 0 && timers[0].at <= clock) {
      const timer = timers.shift();
      timer.callback();
    }
  };

  const say = (index, content, gapMs = 0) => {
    advance(gapMs);
    runTimers();
    return detector.onMessage({
      id: `m${index}`,
      channelId: CHANNEL,
      userId: `u${index % 3}`,
      userName: `群友${index % 3}`,
      content,
      timestamp: clock,
    });
  };

  return {
    detector,
    deliveries,
    discards,
    endings,
    errors,
    say,
    advance,
    runTimers,
    get clock() {
      return clock;
    },
    stop() {
      detector.dispose();
    },
  };
}

const LONG = [
  '我认为这套方案的取舍主要取决于写入仲裁成本与副本一致性之间的权衡，如果仲裁成本过高就应当降低副本数量并引入两阶段提交来保证强一致。',
  '不完全同意，因为两阶段提交在高延迟网络下会把阻塞窗口放大，实际吞吐反而低于基于逻辑时钟的乐观并发控制方案，需要先做压测。',
  '乐观并发在冲突率高的时候会大量回滚，这里的关键变量是热点键的分布而不是协议实现细节，应该先把热点拆出来单独观测。',
  '从运维角度看回滚率超过百分之五就必须改协议，所以我会先把热点拆分出来单独用悲观锁，其余路径保持乐观并加上幂等令牌。',
  '这个分层方案我认可，但热点拆分会引入跨分片事务，需要在业务层保证幂等并且提前定义好补偿失败时的告警等级与回滚策略。',
];

test('SCRIBE-01: 主动书记员启停——10 分钟静默不自动平息，结束时立即交付全部消息', () => {
  const harness = createHarness({ minDiscussionMessages: 12 });
  try {
    const started = harness.detector.startManualSession(CHANNEL);
    assert.ok(harness.detector.isManualRecording(CHANNEL), '开启后必须置位 manualRecording');
    assert.equal(started.phase, 'BURSTING', 'IDLE 下开启必须立即切入 BURSTING');
    assert.match(harness.detector.getState(CHANNEL).triggerReason, /自动书记开始/u);

    for (let index = 0; index < 4; index += 1) {
      harness.say(index, LONG[index], index === 0 ? 0 : 10 * 60_000);
      assert.equal(
        harness.detector.getStatus(CHANNEL).phase,
        'BURSTING',
        `第 ${index + 1} 条后仍必须停留在 BURSTING（10 分钟静默不得触发自动平息）`,
      );
      assert.equal(harness.deliveries.length, 0, '录制期间不得交付');
      assert.equal(harness.discards.length, 0, '录制期间不得判定丢弃');
    }
    assert.equal(harness.detector.getState(CHANNEL).buffer.length, 4, '缓冲必须收齐 4 条');

    const stopped = harness.detector.stopManualSession(CHANNEL);
    assert.equal(harness.detector.isManualRecording(CHANNEL), false, '结束必须解除 manualRecording');
    assert.equal(harness.deliveries.length, 1, '结束必须立即交付一次');
    assert.equal(harness.deliveries[0].messages.length, 4, '交付必须包含全部 4 条');
    assert.equal(harness.deliveries[0].partial, false, '主动结束交付是完整会话');
    assert.equal(stopped.phase, 'SUMMARIZING', '交付后进入 SUMMARIZING 闩锁');

    harness.detector.completeSummarizing(CHANNEL);
    assert.equal(harness.detector.getStatus(CHANNEL).phase, 'IDLE', '宿主回收闩锁后相位回到 IDLE');
    assert.deepEqual(
      harness.endings,
      [{ channelId: CHANNEL, reason: 'stop' }],
      '手动结束必须通知宿主清档（reason = stop）',
    );
    harness.runTimers();
  } finally {
    harness.stop();
  }
});

test('SCRIBE-02: 录制期软切片不退出相位，超 2 小时静默由熔断结算剩余消息', () => {
  const harness = createHarness({ minDiscussionMessages: 12 });
  try {
    harness.detector.startManualSession(CHANNEL);

    for (let index = 0; index < 125; index += 1) {
      harness.say(index, `${LONG[index % LONG.length]}（第 ${index} 段）`, index === 0 ? 0 : 2_000);
    }

    const slices = harness.deliveries.filter((session) => session.partial === true);
    assert.equal(slices.length, 1, '第 120 条触发一次软切片');
    assert.equal(slices[0].messages.length, 120, '软切片交付 120 条');
    assert.equal(harness.detector.getStatus(CHANNEL).phase, 'BURSTING', '软切片不得改变相位');
    assert.equal(harness.detector.isManualRecording(CHANNEL), true, '软切片不得解除录制');
    assert.equal(harness.detector.getState(CHANNEL).buffer.length, 5, '剩余 5 条留在缓冲');

    // 静默 2 小时 1 分：由录制期专用定时器驱动熔断。
    harness.advance(MAX_MANUAL_IDLE_MS + 60_000);
    harness.runTimers();

    assert.equal(harness.detector.isManualRecording(CHANNEL), false, '熔断必须解除手动录制');
    const fused = harness.deliveries.filter((session) => session.partial !== true);
    assert.equal(fused.length, 1, '熔断必须交付剩余消息一次');
    assert.equal(fused[0].messages.length, 5, '熔断交付剩余 5 条');
    assert.equal(
      fused[0].endTime >= fused[0].startTime,
      true,
      '交付时间段必须自洽',
    );
    assert.ok(MANUAL_SESSION_MIN_MESSAGES <= 5, '剩余 5 条满足主动模式的最低交付条数');
    assert.deepEqual(
      harness.endings,
      [{ channelId: CHANNEL, reason: 'fuse' }],
      '2h 熔断同样必须通知宿主清档（reason = fuse），否则重启会再交付一次',
    );
  } finally {
    harness.stop();
  }
});

test('SCRIBE-03: 进程重启后从 scribe/*.jsonl 恢复录制，续写并一次交付 15 条', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'patchouli-scribe-'));
  try {
    // ── 第一段进程：开启录制并落 10 条 ──
    const first = createHarness({ minDiscussionMessages: 12 });
    const firstStore = new ScribeStore({ dir });
    first.detector.startManualSession(CHANNEL);
    for (let index = 0; index < 10; index += 1) {
      const metrics = first.say(index, `${LONG[index % LONG.length]}（第 ${index} 段）`, index === 0 ? 0 : 5_000);
      await firstStore.syncMessage(
        {
          id: `m${index}`,
          channelId: CHANNEL,
          userId: `u${index % 3}`,
          userName: `群友${index % 3}`,
          content: `${LONG[index % LONG.length]}（第 ${index} 段）`,
          timestamp: metrics.lastMessageTime,
        },
        first.detector.isManualRecording(CHANNEL),
      );
    }
    const lines = await readdir(dir);
    assert.deepEqual(lines, [`${CHANNEL}.jsonl`], '落盘文件名必须是 <channelId>.jsonl');
    first.stop(); // 模拟进程消失：内存状态全丢

    // ── 第二段进程：从磁盘恢复，续写 5 条后结束 ──
    const second = createHarness({ minDiscussionMessages: 12 });
    const restored = await restoreScribeSessions({ dir, detector: second.detector });
    assert.equal(restored.restored.length, 1, '必须恢复一个会话');
    assert.equal(restored.restored[0].channelId, CHANNEL);
    assert.equal(restored.restored[0].count, 10);
    assert.equal(second.detector.isManualRecording(CHANNEL), true, '恢复后必须回到录制态');
    assert.equal(second.detector.getState(CHANNEL).buffer.length, 10, '缓冲必须包含恢复的 10 条');
    assert.equal(second.detector.getStatus(CHANNEL).phase, 'BURSTING', '恢复后相位必须是 BURSTING');

    for (let index = 10; index < 15; index += 1) {
      second.say(index, `${LONG[index % LONG.length]}（第 ${index} 段）`, 5_000);
    }
    second.detector.stopManualSession(CHANNEL);

    assert.equal(second.deliveries.length, 1, '结束时交付一次');
    assert.equal(second.deliveries[0].messages.length, 15, '交付必须包含恢复的 10 条 + 新写的 5 条');
    second.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCRIBE-04: 2h 熔断通知宿主清档，重启后不再恢复已结束的会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'patchouli-scribe-fuse-'));
  const store = new ScribeStore({ dir });
  const harness = createHarness({ minDiscussionMessages: 12 }, {
    // 与插件侧接线一致：会话结束即删档（`void scribe.remove(channelId)`）。
    onManualSessionEnd: (channelId) => {
      void store.remove(channelId);
    },
  });
  try {
    harness.detector.startManualSession(CHANNEL);
    for (let index = 0; index < 4; index += 1) {
      harness.say(index, `${LONG[index]}（第 ${index} 段）`, index === 0 ? 0 : 10 * 60_000);
      await store.syncMessage(
        {
          id: `m${index}`,
          channelId: CHANNEL,
          userId: `u${index % 3}`,
          userName: `群友${index % 3}`,
          content: `${LONG[index]}（第 ${index} 段）`,
          timestamp: harness.clock,
        },
        harness.detector.isManualRecording(CHANNEL),
        harness.detector.getState(CHANNEL)?.lastSettledTime ?? 0,
      );
    }
    assert.deepEqual(await readdir(dir), [`${CHANNEL}.jsonl`], '录制期间只落一个记录文件（未交付故无 meta）');

    harness.advance(MAX_MANUAL_IDLE_MS + 60_000);
    harness.runTimers();

    assert.equal(harness.detector.isManualRecording(CHANNEL), false, '熔断必须解除录制');
    assert.deepEqual(harness.endings, [{ channelId: CHANNEL, reason: 'fuse' }]);
    assert.equal(harness.deliveries.length, 1, '熔断交付剩余消息一次');
    // 回调里的 `store.remove` 走串行队列：再排一次删除作为「落盘完成」的屏障（幂等，无副作用）。
    await store.remove(CHANNEL);
    assert.deepEqual(await readdir(dir), [], '熔断结算后录制文件必须删除');

    const restarted = createHarness({ minDiscussionMessages: 12 });
    try {
      const restored = await restoreScribeSessions({ dir, detector: restarted.detector });
      assert.deepEqual(restored.restored, [], '已结束的会话不得在重启后再恢复、再交付一次');
      assert.equal(restarted.detector.isManualRecording(CHANNEL), false);
    } finally {
      restarted.stop();
    }
  } finally {
    harness.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCRIBE-05: onManualSessionEnd 抛错只转交 onError，会话照常结束', () => {
  const harness = createHarness({ minDiscussionMessages: 12 }, {
    onManualSessionEnd: () => {
      throw new Error('cleanup boom');
    },
  });
  try {
    harness.detector.startManualSession(CHANNEL);
    harness.say(0, LONG[0]);
    harness.detector.stopManualSession(CHANNEL);

    assert.equal(harness.detector.isManualRecording(CHANNEL), false, '回调抛错不得阻断会话结束');
    assert.deepEqual(harness.endings, [{ channelId: CHANNEL, reason: 'stop' }]);
    assert.equal(harness.errors.length, 1, '异常必须转交 onError 而不是外溢到消息主循环');
    assert.match(String(harness.errors[0]), /cleanup boom/u);
  } finally {
    harness.stop();
  }
});
