/**
 * L0 词汇凝聚边界标注器回归测试（roadmap §4.1 / §4.2 L0）。
 *
 * 锁死契约：
 *  - TextTiling 滑窗落差判据（局部极小 + 落差阈值 + 绝对上限）；
 *  - 切点 at = 切点右侧块首条消息时间戳；
 *  - 首块之前 / 末块之后永不报点；同一 at 不重复；
 *  - 流式 push 与批量 detectBoundaries 产出逐位一致；纯确定性可重放。
 *
 * 与 trigger 既有测试一致：node:test + node:assert/strict，深路径导入 lib 产物。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectBoundaries,
  LexicalBoundaryDetector,
  tokenizeCohesion,
} from '../lib/trigger/boundary.js';

const BASE_TIME = 1_700_000_000_000;
const SECOND = 1000;

function makeMessage(index, text) {
  return {
    id: `msg-${index}`,
    text,
    at: BASE_TIME + index * 5 * SECOND,
  };
}

/** 话题 A：落地窗与阳台采光。长公共词干 + 轮换尾部，保证块内 / 块间高重合度。 */
const TOPIC_A_STEM =
  '落地窗采光方案讨论纱帘和蜂巢帘的取舍还有玻璃面积对室温的影响阳台打通之后的进深光线均匀性';
const TOPIC_A_TAILS = [
  '白天直射还是偏刺眼',
  '西晒隔热膜是刚需',
  '进深采光反而均匀',
  '超白玻透光率明显',
  '遮光隔热都顾到了',
  '断桥铝顺带隔音',
  '绿植沿窗摆一圈',
  '深色地板吃掉进光',
  '白天不用开主灯',
  '空调负荷跟着上升',
];

/** 话题 B：Kubernetes 网络插件。英文词域，与 A 几乎零 2-gram 重合。 */
const TOPIC_B_STEM =
  'kubernetes cluster cni network plugin setup for pod networking stack and overlay configuration';
const TOPIC_B_TAILS = [
  'calico vxlan latency',
  'cilium ebpf proxy',
  'cni kubelet sandbox',
  'networkpolicy dns rules',
  'bgp peering misconfig',
  'weave sleeve throughput',
  'pod cidr conflict',
  'mtu fragmentation tuning',
  'ipvs conntrack table',
  'egress gateway latency',
];

function topicAMessage(index) {
  return `${TOPIC_A_STEM}${TOPIC_A_TAILS[index % TOPIC_A_TAILS.length]}`;
}

function topicBMessage(index) {
  return `${TOPIC_B_STEM} ${TOPIC_B_TAILS[index % TOPIC_B_TAILS.length]}`;
}

test('BOUNDARY-01: 同一话题持续讨论，零候选', () => {
  // 20 条同一话题：深度序列全程高位，不存在满足判据的局部极小。
  const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i, topicAMessage(i)));
  assert.deepEqual(detectBoundaries(messages), []);
  // 恰好 15 条（规格字面量）同样零候选。
  const fifteen = messages.slice(0, 15);
  assert.deepEqual(detectBoundaries(fifteen, { minMessages: 0 }), []);
});

test('BOUNDARY-02: 两段不同话题拼接，恰在交界处报出 1 个候选', () => {
  // 前 10 条讲落地窗采光、后 10 条讲 Kubernetes 网络插件。
  const messages = [
    ...Array.from({ length: 10 }, (_, i) => makeMessage(i, topicAMessage(i))),
    ...Array.from({ length: 10 }, (_, i) => makeMessage(i + 10, topicBMessage(i))),
  ];
  const candidates = detectBoundaries(messages);
  assert.equal(candidates.length, 1);
  // 切点落在块 1 与块 2 之间 → at = 第 11 条（下标 10）消息的时间戳。
  assert.equal(candidates[0].at, messages[10].at);
  assert.ok(candidates[0].score > 0);
});

test('BOUNDARY-03: 首块之前 / 末块之后永不报点；minMessages 未满足时零候选', () => {
  // 话题从第 2 块才切换 → i=0 不是合格局部极小，零候选（首块之前不报）。
  const headSwitch = [
    ...Array.from({ length: 5 }, (_, i) => makeMessage(i, topicAMessage(i))),
    ...Array.from({ length: 15 }, (_, i) => makeMessage(i + 5, topicBMessage(i))),
  ];
  assert.deepEqual(detectBoundaries(headSwitch), []);
  // 只有 3 块时没有任何 i 同时满足 i>=1 与 i<=B-3 → 末块之后不报。
  const threeBlocks = [
    ...Array.from({ length: 5 }, (_, i) => makeMessage(i, topicAMessage(i))),
    ...Array.from({ length: 5 }, (_, i) => makeMessage(i + 5, topicBMessage(i))),
    ...Array.from({ length: 5 }, (_, i) => makeMessage(i + 10, topicBMessage(i))),
  ];
  assert.deepEqual(detectBoundaries(threeBlocks, { minMessages: 0 }), []);
  // minMessages 闸门：消息数不足时一律零候选。
  const mixed = [
    ...Array.from({ length: 10 }, (_, i) => makeMessage(i, topicAMessage(i))),
    ...Array.from({ length: 10 }, (_, i) => makeMessage(i + 10, topicBMessage(i))),
  ];
  assert.deepEqual(detectBoundaries(mixed, { minMessages: 21 }), []);
  assert.ok(detectBoundaries(mixed).length === 1, '默认 minMessages 下应正常报点');
});

test('BOUNDARY-04: 确定性可重放，同一输入两次结果 deepEqual', () => {
  const messages = [
    ...Array.from({ length: 10 }, (_, i) => makeMessage(i, topicAMessage(i))),
    ...Array.from({ length: 10 }, (_, i) => makeMessage(i + 10, topicBMessage(i))),
  ];
  const first = detectBoundaries(messages);
  const second = detectBoundaries(messages);
  assert.deepEqual(first, second);
  // tokenizeCohesion 同样纯函数可重放。
  assert.deepEqual(tokenizeCohesion('落地窗的采光面'), tokenizeCohesion('落地窗的采光面'));
});

test('BOUNDARY-05: 流式 push 与批量 detectBoundaries 产出逐位一致', () => {
  const messages = [
    ...Array.from({ length: 10 }, (_, i) => makeMessage(i, topicAMessage(i))),
    ...Array.from({ length: 10 }, (_, i) => makeMessage(i + 10, topicBMessage(i))),
  ];
  const batch = detectBoundaries(messages);
  const detector = new LexicalBoundaryDetector();
  const streamed = [];
  for (const message of messages) {
    const before = detector.size;
    const candidate = detector.push(message);
    assert.equal(detector.size, before + 1, 'size 应随 push 单调累加');
    if (candidate !== null) {
      streamed.push(candidate);
    }
  }
  assert.equal(detector.size, messages.length);
  assert.deepEqual(streamed, batch);
  // reset 后重放同一序列，产出与首遍一致（同一 at 不重复上报、状态可复用）。
  detector.reset();
  assert.equal(detector.size, 0);
  const replayed = [];
  for (const message of messages) {
    const candidate = detector.push(message);
    if (candidate !== null) {
      replayed.push(candidate);
    }
  }
  assert.deepEqual(replayed, batch);
  // tokenizeCohesion：CQ 码 / 标签被剥离，大小写归一，产出 2-gram 数组。
  const grams = tokenizeCohesion('[CQ:at,qq=1] ABc 落地窗');
  assert.deepEqual(grams, tokenizeCohesion('[CQ:at,qq=1] abc 落地窗'));
  assert.ok(grams.includes('ab'));
  assert.ok(grams.includes('bc'));
});

test('BOUNDARY-06: 2000 条交替话题 push 总耗时 < 500ms（锁死增量复杂度）', () => {
  const detector = new LexicalBoundaryDetector();
  const messages = Array.from({ length: 2000 }, (_, i) =>
    // 每 10 条换一个话题，模拟长会话多次切换。
    i % 20 < 10 ? makeMessage(i, topicAMessage(i)) : makeMessage(i, topicBMessage(i)),
  );
  const startedAt = Date.now();
  for (const message of messages) {
    detector.push(message);
  }
  const elapsed = Date.now() - startedAt;
  assert.equal(detector.size, 2000);
  assert.ok(elapsed < 500, `2000 次 push 耗时 ${elapsed}ms，超出 500ms 上界`);
  // 顺带锁定：交替话题下流式与批量结果仍然逐位一致。
  const streamed = [];
  detector.reset();
  for (const message of messages) {
    const candidate = detector.push(message);
    if (candidate !== null) {
      streamed.push(candidate);
    }
  }
  assert.deepEqual(streamed, detectBoundaries(messages));
});

test('BOUNDARY-07: 同一 at 只上报一次（容量受限的去重窗口与批量等价）', () => {
  // 所有消息共享同一时间戳：每次话题切换都定格在同一个 `at` 上。
  // 去重窗口是有界数组（`REPORTED_AT_WINDOW`），这里锁死它的判定语义与批量一致。
  const messages = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `a-${i}`, text: topicAMessage(i), at: BASE_TIME })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b-${i}`, text: topicBMessage(i), at: BASE_TIME })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `c-${i}`, text: topicAMessage(i + 100), at: BASE_TIME })),
  ];

  const batch = detectBoundaries(messages);
  assert.deepEqual(batch.map((candidate) => candidate.at), [BASE_TIME], '同一个 at 不得重复上报');

  const detector = new LexicalBoundaryDetector();
  const streamed = [];
  for (const message of messages) {
    const candidate = detector.push(message);
    if (candidate !== null) {
      streamed.push(candidate);
    }
  }
  assert.equal(detector.size, messages.length);
  assert.deepEqual(streamed, batch, '流式去重结果必须与批量逐位一致');
});
