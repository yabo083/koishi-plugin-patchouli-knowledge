import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BurstQuiescenceDetector,
  PotentialTracker,
  effectiveMessageCount,
  evaluateWindowEntries,
} from '../lib/index.js';

/**
 * ENTROPY-01..06：势能触发器的行为规格（roadmap §7.4 Step 2 + §7.5.7 勘误）。
 *
 * 阈值注入的物理依据（每处注入都在用例里单独写明）：
 * - 实测分布见 `.context/DECISIONS.md` ADR-016：正样本 `maxQ` p10=29.7 / `maxρ` p10=1.27；
 *   结构性噪声 `maxQ ≤ 10.4`；高多样性闲聊 6 条/分稳态 `Q≈55`、`ρ≈1.67`；
 *   5 条百字量级 / 90s 的慢速深聊 `Q≈12`、`ρ≈4.1`。
 * - 默认 `thetaMin=20 / rhoMin=1.2` 在「慢速深聊」与「稳态闲聊」两端**同时不成立**
 *   （前者被 `Θ_min` 挡住，后者会越过 `Θ_min`）——这是 ADR-016 记录的「两盲区互斥」，
 *   故允许按用例注入阈值，但每个注入都必须写明依据。
 */

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/slow-debate.json', import.meta.url), 'utf8'));

/** 固定 LCG（种子 7）→ 可重放的「高多样性短句」生成器。 */
const CHAT_POOL =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理世车重并';

function createChatGenerator(seed) {
  let state = seed;
  return (length) => {
    let text = '';
    for (let index = 0; index < length; index += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      text += CHAT_POOL[Math.floor((state / 2147483648) * CHAT_POOL.length)];
    }
    return text;
  };
}

const BASE_TIME = 1_700_000_000_000;

/** 假时钟 + 假调度器 + 收件箱（与 tests/trigger-scribe.test.mjs 同构）。 */
function createHarness(options, channelId = 'entropy-channel') {
  const state = { clock: BASE_TIME };
  const timers = [];
  const deliveries = [];
  const discards = [];
  const detector = new BurstQuiescenceDetector({
    options,
    now: () => state.clock,
    scheduler: (callback, delayMs) => {
      const timer = { at: state.clock + delayMs, callback };
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
  });

  const drain = () => {
    timers.sort((left, right) => left.at - right.at);
    while (timers.length > 0 && timers[0].at <= state.clock) {
      timers.shift().callback();
    }
  };

  const say = (userId, content, at) => {
    state.clock = at;
    drain();
    return detector.onMessage({
      id: `${userId}-${at}`,
      channelId,
      userId,
      userName: userId,
      content,
      timestamp: at,
    });
  };

  return {
    detector,
    deliveries,
    discards,
    say,
    drain,
    state,
    setClock: (at) => {
      state.clock = at;
    },
    stop: () => detector.dispose(),
  };
}

test('ENTROPY-01: 单条信息量三因子正交（复读 0 / 单字刷屏 <0.2 / 短句区间 / 长文 >3.8）', () => {
  const repeated = '这个方案的关键在于把写入路径拆成两段，前段只做校验与排序，后段才落盘并广播。';
  const tracker = new PotentialTracker();
  tracker.push({ userId: 'u', text: repeated, at: BASE_TIME });
  const replay = tracker.push({ userId: 'v', text: repeated, at: BASE_TIME + 10_000 });
  assert.equal(replay.lastInfo, 0, '① 与上一条完全同文时 ν=0 ⇒ I=0（实算 0.0000000）');

  const shout = new PotentialTracker().push({ userId: 'u', text: '啊'.repeat(20), at: BASE_TIME });
  assert.ok(shout.lastInfo < 0.2, `② 20 个「啊」h=1/19 ⇒ I≈0.0182，实测 ${shout.lastInfo.toFixed(7)}`);

  const short = new PotentialTracker().push({ userId: 'u', text: '这条消息的信息量很低', at: BASE_TIME });
  assert.ok(
    short.lastInfo > 2.0 && short.lastInfo < 2.15,
    `③ 10 字正常短句实测 I=${short.lastInfo.toFixed(7)}（区间 [2.0, 2.15]）`,
  );

  const longText =
    '这个方案的关键在于把写入路径拆成两段，前段只做校验与排序，后段才落盘并广播，这样即便后段抖动也不会拖慢前段；' +
    '另外还要给每一段分别设置独立的限流与超时，避免一个环节的阻塞沿着调用链向上传播，并且把排队深度与拒绝计数暴露成指标，' +
    '便于在事故发生时快速定位瓶颈；最后要把两段的配置做成可热更新的，避免为了调整阈值而重启服务。';
  const long = new PotentialTracker().push({ userId: 'u', text: longText, at: BASE_TIME });
  assert.ok(long.lastInfo > 3.8, `④ 158 字新论述实测 I=${long.lastInfo.toFixed(7)}（>3.8）`);
  assert.equal(long.lastEquiv, 3, '④ 单条等效消息数被 clamp 到上限 3.0');
  assert.equal(effectiveMessageCount([long.lastInfo]), 3);
});

test('ENTROPY-02: 小群慢速深聊触发 + 回溯建仓 + 等效消息数结算（fixture 固定）', () => {
  // 注入理由：该 fixture 的 maxQ=12.005、maxρ=4.143（ADR-016 同量级样本），
  // 默认 thetaMin=20 会让它永远进不了 BURSTING（ADR-016 盲区二：冷启动慢群不触发）；
  // rhoMin=2.2 用于把长文（ρ≈4.1）与闲聊（ρ≈1.35~1.67）分开。
  const harness = createHarness({
    triggerMode: 'potential',
    thetaMin: 8,
    rhoMin: 2.2,
    burstMultiplier: 1.5,
    quiescenceSeconds: 300,
    minDiscussionMessages: 12,
  });
  try {
    const phases = [];
    FIXTURE.messages.forEach((message, index) => {
      const metrics = harness.say(message.userId, message.content, BASE_TIME + index * FIXTURE.intervalMs);
      phases.push(metrics.phase);
    });

    assert.deepEqual(phases.slice(0, 2), ['IDLE', 'IDLE'], '前 2 条（Q=4.14 / 7.15）仍低于门限 8');
    assert.equal(phases[2], 'BURSTING', '第 3 条时 Q=9.58 > Θ_burst=8 进入 BURSTING');

    const state = harness.detector.getState('entropy-channel');
    assert.equal(state.buffer.length, 5, '建仓回溯必须把 60 秒窗口外的第 1~2 条一起纳入缓冲');
    assert.equal(state.buffer[0].content, FIXTURE.messages[0].content, '缓冲首条必须是讨论发起的长文');

    const infos = [];
    const tracker = new PotentialTracker();
    FIXTURE.messages.forEach((message, index) => {
      infos.push(tracker.push({ userId: message.userId, text: message.content, at: index }).lastInfo);
    });
    assert.ok(effectiveMessageCount(infos) >= 12, `N_equiv=${effectiveMessageCount(infos).toFixed(2)} 必须 ≥ minDiscussionMessages=12`);

    // 静默越过平息期：末条 + 90s，再推进 15 分钟（含动态延长上限 2.2×）。
    harness.setClock(BASE_TIME + 4 * FIXTURE.intervalMs + 900_000);
    harness.detector.tick();
    harness.drain();

    assert.equal(harness.discards.length, 0, '等效消息数达标，绝不走 onDiscard');
    assert.equal(harness.deliveries.length, 1, '平息后交付一次');
    assert.equal(harness.deliveries[0].messages.length, 5, '交付必须包含 5 条（回溯的 2 条 + 后续 3 条）');
    assert.equal(harness.deliveries[0].partial, false, '这是完整一轮讨论，不是软切片');
  } finally {
    harness.stop();
  }
});

test('ENTROPY-03: 单人独白与伪双人拦截', () => {
  const body =
    '这个方案的关键在于把写入路径拆成两段，前段只做校验与排序，后段才落盘并广播，这样即便后段抖动也不会拖慢前段；' +
    '另外还要给每一段分别设置独立的限流与超时，避免一个环节的阻塞沿着调用链向上传播。';

  // ① 单人连发 10 条高熵长文：S_turn=0 ⇒ Q=0 ⇒ 恒 IDLE。
  const soloHarness = createHarness({ triggerMode: 'potential', thetaMin: 1, rhoMin: 0, minDiscussionMessages: 12 });
  try {
    let last;
    for (let index = 0; index < 10; index += 1) {
      last = soloHarness.say('solo', `${body}（第 ${index} 段）`, BASE_TIME + index * 20_000);
      assert.equal(last.phase, 'IDLE', '单人独白绝不触发');
    }
    assert.equal(last.potential.interaction, 0, 'S_turn 必须为 0（单一发言人）');
    assert.equal(last.potential.quality, 0, 'Q = E·S_turn = 0');
    assert.equal(soloHarness.deliveries.length + soloHarness.discards.length, 0);
  } finally {
    soloHarness.stop();
  }

  // ② A 连发 5 条长文、B 只回一句 4 字附和：S_turn 被压制、Q 远低于门限。
  const pseudo = new PotentialTracker();
  let snapshot;
  for (let index = 0; index < 5; index += 1) {
    snapshot = pseudo.push({ userId: 'A', text: `${body}（论点 ${index}）`, at: BASE_TIME + index * 30_000 });
  }
  snapshot = pseudo.push({ userId: 'B', text: '确实如此', at: BASE_TIME + 5 * 30_000 });
  assert.ok(
    snapshot.interaction < 0.9,
    `伪双人 S_turn=${snapshot.interaction.toFixed(4)} < 0.9（roadmap 的 0.40 假设 p_B≈0.08，` +
      '需 A 的累计能量达到 B 的 12 倍；受 C=ln(1+|G|) 的对数上限约束，单条 500 字长文做不到，故放宽到「严格小于 1」）',
  );
  assert.ok(snapshot.quality < 20, `压制后 Q=${snapshot.quality.toFixed(3)} 远低于默认 Θ_min=20，不误触`);
});

test('ENTROPY-04: 花式接梗被 ν 拦下（旧 entropyRatio 判满分）', () => {
  const base = '复活吧我的爱人这个梗真的太好笑了';
  const memes = [];
  for (let index = 0; index < 12; index += 1) {
    // 每条改掉前部的两个字，保证「前 32 字不完全相同」⇒ 旧熵率判 1.0。
    const head = String.fromCharCode(0x4e00 + index * 37) + String.fromCharCode(0x4e00 + index * 91);
    memes.push(head + base.slice(2, 13) + base.slice(13, 15));
  }

  const entries = memes.map((content, index) => ({
    message: {
      id: `meme-${index}`,
      channelId: 'entropy-channel',
      userId: `u${index % 4}`,
      userName: `u${index % 4}`,
      content,
      timestamp: BASE_TIME + index * 5_000,
    },
    at: BASE_TIME + index * 5_000,
  }));
  const window = evaluateWindowEntries(entries, 60, BASE_TIME + 11 * 5_000);
  assert.equal(window.entropyRatio, 1, '旧判据：前 32 字互不相同 ⇒ 熵率满分（拦不住接梗）');
  assert.equal(window.effectiveRate, 12, '旧判据的速率也已越过 minBurstRate=6');

  const harness = createHarness({ triggerMode: 'potential', minDiscussionMessages: 12 });
  try {
    let last;
    memes.forEach((content, index) => {
      last = harness.say(`u${index % 4}`, content, BASE_TIME + index * 5_000);
      assert.equal(last.phase, 'IDLE', '新判据必须全程 IDLE');
    });
    assert.ok(last.potential.quality < 20, `实测 Q=${last.potential.quality.toFixed(3)} < Θ_min=20`);
    assert.ok(last.potential.density < 1.2, `实测 ρ=${last.potential.density.toFixed(3)} < ρ_min=1.2`);
    assert.equal(harness.deliveries.length + harness.discards.length, 0);
  } finally {
    harness.stop();
  }
});

test('ENTROPY-05: 稳态闲聊恒 IDLE（锁 §7.5.1：门限必须高于日常势能）', () => {
  // 注入理由：实测 6 条/分、5~8 字互不重复的闲聊，稳态 Q≈53（ADR-016 表「合成·高多样性闲聊」），
  // 默认 thetaMin=20 会持续误触；60 是该量级之上留出余量后的取值。
  const harness = createHarness({ triggerMode: 'potential', thetaMin: 60, rhoMin: 1.2, minDiscussionMessages: 12 });
  try {
    const nextChat = createChatGenerator(7);
    const phases = new Set();
    for (let index = 0; index < 180; index += 1) {
      const metrics = harness.say(`u${index % 5}`, nextChat(5 + Math.floor((index * 7) % 4)), BASE_TIME + index * 10_000);
      phases.add(metrics.phase);
    }
    assert.deepEqual([...phases], ['IDLE'], '30 分钟稳态闲聊不得进入任何非 IDLE 相位');
    assert.equal(harness.deliveries.length, 0, '不得产生交付');
    assert.equal(harness.discards.length, 0, '不得产生丢弃');

    const early = harness.detector.getStatus('entropy-channel').potential.baselineQuality;
    for (let index = 180; index < 240; index += 1) {
      harness.say(`u${index % 5}`, nextChat(5 + Math.floor((index * 7) % 4)), BASE_TIME + index * 10_000);
    }
    const late = harness.detector.getStatus('entropy-channel').potential.baselineQuality;
    assert.ok(late > 20, `b_Q 必须学到日常量级（实测 ${late.toFixed(2)}），不能像 b_Q=0 时那样把自适应整条路径废掉`);
    assert.ok(Math.abs(late - early) < 5, `后段 b_Q 收敛（${early.toFixed(2)} → ${late.toFixed(2)}，变化 <5）`);
    assert.ok(late < 60, `b_Q=${late.toFixed(2)} 低于 thetaMin=60，封顶由 Ψ_min 兜住`);
  } finally {
    harness.stop();
  }
});

test('ENTROPY-06: 活跃群可冷却（底噪之上叠加争论后必须在 静默期×2.2 + τ 内结算）', () => {
  // 注入理由：ENTROPY-05 已把 b_Q 抬到日常量级（≈53），Θ_burst = max(60, b_Q×1.2) ≈ 63.6；
  // 争论段用 20 条 150 字长文推进 3 分钟，Q 必须越过该门限；Θ_cool = 1.1×max(60/1.2, b_Q) ≈ 58，
  // 争论停止后底噪（Q≈53）落到 Θ_cool 之下 ⇒ 冷却并按时结算。
  const harness = createHarness({
    triggerMode: 'potential',
    thetaMin: 60,
    rhoMin: 1.2,
    burstMultiplier: 1.2,
    quiescenceSeconds: 300,
    minDiscussionMessages: 12,
  });
  try {
    const nextChat = createChatGenerator(7);
    const chatterAt = (index) => BASE_TIME + index * 10_000;
    let index = 0;
    for (; index < 180; index += 1) {
      const metrics = harness.say(`u${index % 5}`, nextChat(5 + Math.floor((index * 7) % 4)), chatterAt(index));
      assert.equal(metrics.phase, 'IDLE', `底噪第 ${index} 条不得触发`);
    }

    const baseline = harness.detector.getStatus('entropy-channel').potential.baselineQuality;
    assert.ok(baseline > 20, `底噪已把 b_Q 抬到日常量级（实测 ${baseline.toFixed(2)}）`);

    // 争论语料必须**逐条不同**：同一段文本复述会让 ν 迅速归零，Q 根本涨不起来
    // （实测：20 条同文 maxQ 仅 55.9，换成本组 6 段轮换后 maxQ=65.1）。
    const bodies = [
      '仲裁成本高于收益就该降低副本数量并引入两阶段提交，同时用逻辑时钟排序压缩阻塞窗口，这需要先做压测确认回滚率。',
      '热点键的分布决定乐观并发的回滚率，先把热点拆出来单独观测再分层治理，比整体换协议更划算也更容易回退。',
      '告警链路必须区分采样窗口与原始窗口，否则高频错误会被稀释，我建议全量告警与降采样归档各走一条独立通道。',
      '采集端的背压要用有界队列加确定性抽样，并把丢弃计数单独暴露成指标，保住主干稳定又不让观测完全失真。',
      '批处理会把故障传播放大，采集进程一阻塞缓冲区就线性膨胀，运维事故时反倒先把自己压垮，必须有优先级丢弃。',
      '全量告警要维持独立通道，两套路径的维护成本不低，但误报代价更大，我同意降采样只限制在归档侧并做容量隔离。',
    ];
    const argumentStart = chatterAt(180) + 10_000;
    let burstIndex = -1;
    let maxQuality = 0;
    for (let step = 0; step < 20; step += 1) {
      const metrics = harness.say(
        `u${step % 3}`,
        `${bodies[step % bodies.length]}（第 ${step} 轮交锋）`,
        argumentStart + step * 9_000,
      );
      if (metrics.potential) maxQuality = Math.max(maxQuality, metrics.potential.quality);
      if (burstIndex < 0 && metrics.phase !== 'IDLE') burstIndex = step;
    }
    assert.ok(burstIndex >= 0, `3 分钟密集争论必须进入 BURSTING（实测 maxQ=${maxQuality.toFixed(2)}，Θ_burst≈${(Math.max(60, baseline * 1.2)).toFixed(2)}）`);

    const argumentEnd = argumentStart + 19 * 9_000;
    const deadline = argumentEnd + 300 * 2.2 * 1000 + 240_000;
    let settledAt = -1;
    for (let step = 0; step < 400 && settledAt < 0; step += 1) {
      const at = argumentEnd + (step + 1) * 10_000;
      harness.say(`u${step % 5}`, nextChat(5 + Math.floor((step * 7) % 4)), at);
      if (harness.deliveries.length > 0) settledAt = at;
    }

    assert.equal(harness.deliveries.length, 1, '争论结束后必须完成一次平息结算（不能只靠 120 条软切片）');
    assert.equal(harness.deliveries[0].partial, false, '结算的是完整一轮讨论');
    assert.ok(settledAt > 0 && settledAt <= deadline, `结算时刻 ${((settledAt - argumentEnd) / 1000).toFixed(0)}s 必须 ≤ ${((deadline - argumentEnd) / 1000).toFixed(0)}s`);
  } finally {
    harness.stop();
  }
});
