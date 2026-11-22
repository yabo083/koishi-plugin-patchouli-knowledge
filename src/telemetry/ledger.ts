/**
 * Patchouli Knowledge — 遥测账本
 *
 * 两个纯内存观测器，都不参与触发器决策：
 *
 * 1. `BaselineLedger`：记录 1 小时滑动窗口内基线的每一次增减 —— 时间衰减漂移、
 *    EWMA 上行 / 下行样本、以及被学习闸门拒绝的样本归因。它是「基线为什么不动」
 *    与「基线为什么突然爬高」的唯一可追溯来源。
 * 2. `MomentumTracker`：对消息速率做差分动量累积，输出一阶斜率 `velocity`、
 *    净动量 `netMomentum` 与 Wilder 14 步 `RSI`，为后续把 RSI 引入触发判据
 *    （动量确认：速率突破但动量衰减时不判定突发）奠定数据基础。
 */

import type {
  BaselineLedgerSnapshot,
  MomentumMetrics,
} from './types';
import {
  BASELINE_LEDGER_EVENT_CAPACITY,
  BASELINE_LEDGER_WINDOW_MS,
  isFiniteNumber,
  MOMENTUM_EPSILON,
  MOMENTUM_RSI_PERIOD,
  TELEMETRY_EPSILON,
} from './types';
import { RingBuffer } from './ring-buffer';

/** 基线事件类型（`flat` = 样本写入但基线未移动）。 */
export type BaselineEventKind = 'decay' | 'up' | 'down' | 'flat' | 'rejected-hysteresis' | 'rejected-prewarm';

interface BaselineEvent {
  at: number;
  kind: BaselineEventKind;
  delta: number;
}

/**
 * 单群基线账本（1 小时滑动窗口）。
 *
 * 事件时间一律取**触发器逻辑时间**（消息逻辑时刻），因此窗口语义在离线仿真中
 * 与真实运行完全一致；`snapshot(now)` 的 `now` 也应按逻辑时间传入。
 * 事件本身存放在有界环形缓冲中：窗口内超过 `capacity` 条时按 FIFO 覆盖最旧事件，
 * 保证长时间挂机的内存恒定（此时快照反映最近 `capacity` 条窗口内事件）。
 */
export class BaselineLedger {
  private readonly events: RingBuffer<BaselineEvent>;

  constructor(
    private readonly channelId: string,
    private readonly capacity: number = BASELINE_LEDGER_EVENT_CAPACITY,
  ) {
    this.events = new RingBuffer<BaselineEvent>(capacity);
  }

  /**
   * 记录一次 EWMA 样本写入结果。
   *
   * 只统计**确实写入**的样本（`learned === true`）：未写入的样本按拒绝归因由
   * `recordRejection` 单独计数，避免同一件事被记两次。
   */
  recordSample(at: number, baselineBefore: number, baselineAfter: number): void {
    if (!isFiniteNumber(at) || !isFiniteNumber(baselineBefore) || !isFiniteNumber(baselineAfter)) {
      return;
    }
    const delta = baselineAfter - baselineBefore;
    let kind: BaselineEventKind = 'flat';
    if (delta > TELEMETRY_EPSILON) {
      kind = 'up';
    } else if (delta < -TELEMETRY_EPSILON) {
      kind = 'down';
    }
    this.events.push({ at, kind, delta: Math.abs(delta) <= TELEMETRY_EPSILON ? 0 : delta });
  }

  /** 记录一次静默时间衰减造成的基线漂移。 */
  recordDecay(at: number, baselineBefore: number, baselineAfter: number): void {
    if (!isFiniteNumber(at) || !isFiniteNumber(baselineBefore) || !isFiniteNumber(baselineAfter)) {
      return;
    }
    const delta = baselineAfter - baselineBefore;
    if (Math.abs(delta) <= TELEMETRY_EPSILON) {
      return;
    }
    this.events.push({ at, kind: 'decay', delta });
  }

  /** 记录一次被学习闸门拒绝的样本。 */
  recordRejection(at: number, reason: 'hysteresis' | 'prewarm'): void {
    if (!isFiniteNumber(at)) {
      return;
    }
    this.events.push({
      at,
      kind: reason === 'hysteresis' ? 'rejected-hysteresis' : 'rejected-prewarm',
      delta: 0,
    });
  }

  /** 清空账本（插件卸载时调用）。 */
  clear(): void {
    this.events.clear();
  }

  /**
   * 生成窗口快照。
   *
   * 窗口为左开右闭区间 `(now - windowMs, now]`：恰好落在一小时前的边界事件按「已过期」处理，
   * 与「最近 1 小时」的直觉一致。
   *
   * @param now 逻辑当前时刻；非有限值或 ≤ 0 时不做窗口裁剪（用于从未观测过消息的群）。
   */
  snapshot(now: number = 0): BaselineLedgerSnapshot {
    const windowMs = BASELINE_LEDGER_WINDOW_MS;
    const anchor = isFiniteNumber(now) && now > 0 ? now : null;
    const since = anchor === null ? 0 : anchor - windowMs;
    const withinWindow =
      anchor === null ? this.events.toArray() : this.events.toArray().filter((event) => event.at > since);

    let decayDelta = 0;
    let downwardDelta = 0;
    let upwardDelta = 0;
    let acceptedDown = 0;
    let acceptedUp = 0;
    let rejectedHysteresis = 0;
    let rejectedPrewarm = 0;
    let firstAt: number | null = null;
    let lastAt: number | null = null;

    for (const event of withinWindow) {
      if (firstAt === null || event.at < firstAt) firstAt = event.at;
      if (lastAt === null || event.at > lastAt) lastAt = event.at;
      switch (event.kind) {
        case 'decay':
          decayDelta += event.delta;
          break;
        case 'down':
          downwardDelta += event.delta;
          acceptedDown += 1;
          break;
        case 'up':
          upwardDelta += event.delta;
          acceptedUp += 1;
          break;
        case 'rejected-hysteresis':
          rejectedHysteresis += 1;
          break;
        case 'rejected-prewarm':
          rejectedPrewarm += 1;
          break;
        default:
          break;
      }
    }

    return {
      channelId: this.channelId,
      windowMs,
      since,
      events: withinWindow.length,
      decayDelta,
      downwardDelta,
      upwardDelta,
      netDelta: decayDelta + downwardDelta + upwardDelta,
      acceptedDown,
      acceptedUp,
      rejectedHysteresis,
      rejectedPrewarm,
      firstAt,
      lastAt,
    };
  }
}

/**
 * 消息速率差分动量跟踪器（RSI 基础）。
 *
 * - `velocity`：最近一次 Δr（一阶斜率）；
 * - `netMomentum`：最近一个 RSI 周期的净动量 Σ Δr；
 * - `rsi`：Wilder 14 步相对强弱指数，样本不足一周期时为 `null`。
 *
 * 除零安全：分母恒加 `MOMENTUM_EPSILON`；「零变化」区间（无涨无跌）显式返回中性 50，
 * 避免把「完全没动」误报为超卖 0。任何非有限输入都被忽略，输出永不为 NaN / Infinity。
 */
export class MomentumTracker {
  private readonly deltas: RingBuffer<number>;
  private previousRate: number | null = null;
  private deltaCount = 0;
  private rawGainSum = 0;
  private rawLossSum = 0;
  private avgGain = 0;
  private avgLoss = 0;
  private velocity = 0;
  private lastRate: number | null = null;
  private lastAt: number | null = null;

  constructor(private readonly period: number = MOMENTUM_RSI_PERIOD) {
    this.deltas = new RingBuffer<number>(period);
  }

  /** 观测一个速率样本（非有限值 / 负值直接忽略）。 */
  observe(rate: number, at: number): MomentumMetrics {
    if (!isFiniteNumber(rate) || rate < 0) {
      return this.snapshot();
    }
    const moment = isFiniteNumber(at) ? at : this.lastAt ?? 0;

    if (this.previousRate !== null) {
      const delta = rate - this.previousRate;
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;
      this.deltaCount += 1;
      this.rawGainSum += gain;
      this.rawLossSum += loss;
      this.deltas.push(delta);
      this.velocity = delta;

      if (this.deltaCount <= this.period) {
        this.avgGain = this.rawGainSum / this.deltaCount;
        this.avgLoss = this.rawLossSum / this.deltaCount;
      } else {
        this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
        this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
      }
    }

    this.previousRate = rate;
    this.lastRate = rate;
    this.lastAt = moment;
    return this.snapshot();
  }

  /** 读取当前动量（纯读，不推进状态）。 */
  snapshot(): MomentumMetrics {
    let netMomentum = 0;
    for (const delta of this.deltas.toArray()) {
      netMomentum += delta;
    }
    return {
      samples: this.deltaCount,
      velocity: this.velocity,
      netMomentum,
      avgGain: this.avgGain,
      avgLoss: this.avgLoss,
      rsi: this.computeRsi(),
      lastRate: this.lastRate,
      lastAt: this.lastAt,
    };
  }

  /** 清空所有样本。 */
  clear(): void {
    this.deltas.clear();
    this.previousRate = null;
    this.deltaCount = 0;
    this.rawGainSum = 0;
    this.rawLossSum = 0;
    this.avgGain = 0;
    this.avgLoss = 0;
    this.velocity = 0;
    this.lastRate = null;
    this.lastAt = null;
  }

  private computeRsi(): number | null {
    if (this.deltaCount < this.period) {
      return null;
    }
    // 零变化区间：无涨无跌，中性 50（而非 0，避免把静默误报为超卖极值）。
    if (this.avgGain === 0 && this.avgLoss === 0) {
      return 50;
    }
    const rs = this.avgGain / (this.avgLoss + MOMENTUM_EPSILON);
    const rsi = 100 - 100 / (1 + rs);
    // 浮点兜底：任何情况下都不外泄 NaN / Infinity。
    return Number.isFinite(rsi) ? Math.min(100, Math.max(0, rsi)) : 50;
  }
}
