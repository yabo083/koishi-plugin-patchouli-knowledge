/**
 * Patchouli Knowledge — 自适应日常基线速率估算器 (Adaptive Baseline Estimator)
 *
 * 职责：
 *  - 以「条/分钟」为单位，为每个群聊独立维护长期日常聊天底噪（EWMA 均值）；
 *  - 同步维护速率离散度（EWMA 方差 / 标准差），供度量与自适应调参使用；
 *  - 支持冷启动先验（initialRate）、逐群独立配置、状态导出/恢复与重置。
 *
 * 设计约束：
 *  - 纯内存、无 I/O、无全局副作用，可被触发器与测试独立驱动；
 *  - 时间戳由调用方给出（毫秒），内部不依赖系统时钟；
 *  - 严格 TypeScript，禁止 any。
 *
 * 算法（见 README.md「算法公式」）：
 *   sampleRate_t = provided ?? (窗口内消息数 / sampleWindowSeconds) * 60
 *   baseline_t   = baseline_{t-1} + α_eff * (sampleRate_t - baseline_{t-1})
 *   variance_t   = (1 - α_eff) * (variance_{t-1} + α_eff * (sampleRate_t - baseline_{t-1})²)
 *   deviation_t  = √variance_t
 */

/** 默认 EWMA 平滑系数（与 TriggerOptions.baselineEwmaAlpha 默认值保持一致）。 */
export const DEFAULT_BASELINE_ALPHA = 0.05;

/** 冷启动先验速率（条/分）：未观测到足够样本前的日常基线保底值。 */
export const DEFAULT_INITIAL_RATE = 2;

/** 默认采样滑窗时长（秒）。 */
export const DEFAULT_SAMPLE_WINDOW_SECONDS = 60;

/** α 合法下界（避免完全不学习）。 */
export const MIN_BASELINE_ALPHA = 1e-4;

/** α 合法上界。 */
export const MAX_BASELINE_ALPHA = 1;

/** 静默底噪保底基线（条/分）：历经长久静默后向心回归的极限速率。 */
export const MIN_BASELINE_FLOOR = 1.0;

/** 静默衰减时间常数（毫秒）：15 分钟。 */
export const BASELINE_DECAY_HALF_LIFE_MS = 15 * 60_000;

export interface BaselineEstimatorOptions {
  /** EWMA 平滑系数，取值 (0, 1]。 */
  alpha: number;
  /** 冷启动初始基线（条/分），同时作为该群速率的先验起点。 */
  initialRate: number;
  /** 计算样本速率所用的滑动窗口时长（秒）。 */
  sampleWindowSeconds: number;
}

/** 单次记录的附加控制项。 */
export interface BaselineRecordOptions {
  /**
   * 外部已算好的样本速率（条/分）。
   * 触发器会传入自己滑窗算出的瞬时速率，保证「突发判定」与「基线学习」使用同一口径。
   */
  sampleRate?: number;
  /** 是否将本次样本写入 EWMA（默认 true；false 仅记录时间戳用于后续窗口速率）。 */
  learn?: boolean;
  /** α 缩放系数（默认 1），用于突发期降速学习，避免基线被短期峰值污染。 */
  alphaScale?: number;
}

export interface BaselineObservation {
  channelId: string;
  /** 归一化后的样本时间（毫秒）。 */
  timestamp: number;
  /** 本次样本速率（条/分）。 */
  sampleRate: number;
  /** 更新后的 EWMA 基线（条/分）。 */
  baselineRate: number;
  /** 更新后的速率离散度（标准差，条/分）。 */
  deviation: number;
  /** 该群累计参与 EWMA 的样本数。 */
  sampleCount: number;
  /** 本次是否真正写入了 EWMA。 */
  learned: boolean;
}

export interface BaselineChannelSnapshot {
  channelId: string;
  options: BaselineEstimatorOptions;
  baselineRate: number;
  variance: number;
  sampleCount: number;
  /** 该群最近一次样本时间（毫秒，无样本为 0）。 */
  lastTimestamp: number;
  /** 采样窗口内的时间戳（升序）。 */
  sampleTimestamps: number[];
}

export interface BaselineState {
  version: 1;
  exportedAt: number;
  channels: BaselineChannelSnapshot[];
}

export const DEFAULT_BASELINE_OPTIONS: Readonly<BaselineEstimatorOptions> = Object.freeze({
  alpha: DEFAULT_BASELINE_ALPHA,
  initialRate: DEFAULT_INITIAL_RATE,
  sampleWindowSeconds: DEFAULT_SAMPLE_WINDOW_SECONDS,
});

interface BaselineChannel {
  options: BaselineEstimatorOptions;
  baselineRate: number;
  variance: number;
  sampleCount: number;
  lastTimestamp: number;
  timestamps: number[];
}

/** 反序列化边界上的原始快照形状：字段全部未知，逐字段校验后才进入领域类型。 */
interface RawChannelSnapshot {
  channelId?: unknown;
  options?: unknown;
  baselineRate?: unknown;
  variance?: unknown;
  sampleCount?: unknown;
  lastTimestamp?: unknown;
  sampleTimestamps?: unknown;
}

interface RawBaselineState {
  version?: unknown;
  channels?: unknown;
  exportedAt?: unknown;
}

interface RawBaselineOptions {
  alpha?: unknown;
  initialRate?: unknown;
  sampleWindowSeconds?: unknown;
}

function asSnapshot(value: unknown, field: string): object {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`[patchouli/trigger.baseline] ${field} 必须是对象`);
  }
  return value;
}

function assertFiniteNumber(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`[patchouli/trigger.baseline] ${field} 必须是有限数值，收到 ${String(value)}`);
  }
}

function resolveAlpha(alpha: number): number {
  assertFiniteNumber(alpha, 'alpha');
  return Math.min(MAX_BASELINE_ALPHA, Math.max(MIN_BASELINE_ALPHA, alpha));
}

function normalizeOptions(
  partial: Partial<BaselineEstimatorOptions>,
  base: BaselineEstimatorOptions,
): BaselineEstimatorOptions {
  const next: BaselineEstimatorOptions = { ...base };

  if (partial.alpha !== undefined) {
    const alpha = partial.alpha;
    assertFiniteNumber(alpha, 'alpha');
    if (alpha <= 0 || alpha > MAX_BASELINE_ALPHA) {
      throw new RangeError(`[patchouli/trigger.baseline] alpha 必须落在 (0, ${MAX_BASELINE_ALPHA}]，收到 ${alpha}`);
    }
    next.alpha = alpha;
  }

  if (partial.initialRate !== undefined) {
    const initialRate = partial.initialRate;
    assertFiniteNumber(initialRate, 'initialRate');
    if (initialRate < 0) {
      throw new RangeError(`[patchouli/trigger.baseline] initialRate 不能为负，收到 ${initialRate}`);
    }
    next.initialRate = initialRate;
  }

  if (partial.sampleWindowSeconds !== undefined) {
    const sampleWindowSeconds = partial.sampleWindowSeconds;
    assertFiniteNumber(sampleWindowSeconds, 'sampleWindowSeconds');
    if (sampleWindowSeconds <= 0) {
      throw new RangeError(
        `[patchouli/trigger.baseline] sampleWindowSeconds 必须为正数，收到 ${sampleWindowSeconds}`,
      );
    }
    next.sampleWindowSeconds = sampleWindowSeconds;
  }

  return next;
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`[patchouli/trigger.baseline] 状态字段 ${field} 必须是有限数值`);
  }
  return value;
}

function parseChannelSnapshot(raw: unknown): BaselineChannelSnapshot {
  const channel = asSnapshot(raw, '状态快照中的频道项') as RawChannelSnapshot;

  if (typeof channel.channelId !== 'string' || channel.channelId.length === 0) {
    throw new TypeError('[patchouli/trigger.baseline] 状态快照缺少合法 channelId');
  }
  const rawOptions = asSnapshot(channel.options, '状态快照中的 options') as RawBaselineOptions;

  const options = normalizeOptions(
    {
      alpha: readFiniteNumber(rawOptions.alpha, 'options.alpha'),
      initialRate: readFiniteNumber(rawOptions.initialRate, 'options.initialRate'),
      sampleWindowSeconds: readFiniteNumber(rawOptions.sampleWindowSeconds, 'options.sampleWindowSeconds'),
    },
    DEFAULT_BASELINE_OPTIONS,
  );

  const baselineRate = readFiniteNumber(channel.baselineRate, 'baselineRate');
  const variance = readFiniteNumber(channel.variance, 'variance');
  const sampleCount = readFiniteNumber(channel.sampleCount, 'sampleCount');
  const lastTimestamp = readFiniteNumber(channel.lastTimestamp, 'lastTimestamp');

  if (baselineRate < 0 || variance < 0 || lastTimestamp < 0) {
    throw new RangeError('[patchouli/trigger.baseline] 状态快照中的速率/方差/时间戳不能为负');
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new TypeError('[patchouli/trigger.baseline] 状态快照中的 sampleCount 必须是非负整数');
  }

  const rawTimestamps = channel.sampleTimestamps;
  if (!Array.isArray(rawTimestamps)) {
    throw new TypeError('[patchouli/trigger.baseline] 状态快照缺少 sampleTimestamps 数组');
  }
  const sampleTimestamps: number[] = [];
  for (const value of rawTimestamps) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('[patchouli/trigger.baseline] sampleTimestamps 只能包含有限数值');
    }
    sampleTimestamps.push(value);
  }

  return {
    channelId: channel.channelId,
    options,
    baselineRate,
    variance,
    sampleCount,
    lastTimestamp,
    sampleTimestamps: sampleTimestamps.slice().sort((left, right) => left - right),
  };
}

/**
 * 逐群独立的 EWMA 基线估算器。
 *
 * 典型用法（触发器内部）：
 * ```ts
 * const baseline = new BaselineEstimator({ initialRate: 2 });
 * baseline.record(channelId, message.timestamp, { sampleRate: currentRate });
 * baseline.getRate(channelId);      // 日常基线（条/分）
 * baseline.getDeviation(channelId); // 速率离散度（条/分）
 * ```
 */
export class BaselineEstimator {
  private readonly channels = new Map<string, BaselineChannel>();
  /** 学习闸门（运行时状态，不参与状态导出）：命中即绝对冻结该群的 EWMA 学习。 */
  private readonly learningDisabled = new Set<string>();
  private defaults: BaselineEstimatorOptions;

  constructor(options: Partial<BaselineEstimatorOptions> = {}) {
    this.defaults = normalizeOptions(options, DEFAULT_BASELINE_OPTIONS);
  }

  /** 当前已跟踪的群聊数量。 */
  get size(): number {
    return this.channels.size;
  }

  /** 是否已跟踪某个群聊。 */
  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /** 已跟踪的群聊 ID 列表（按首次登记顺序）。 */
  channelIds(): string[] {
    return [...this.channels.keys()];
  }

  /**
   * 学习闸门：`enabled = false` 时该群的 `record()` **绝对冻结**，只登记时间戳，
   * 即使调用方显式传入 `learn: true` 也不会更新 EWMA 基线或方差。
   *
   * 触发器在脱离 IDLE（进入 BURSTING / COOLING）时冻结，结算回 IDLE 时解冻，
   * 防止水群峰值把长期底噪刷高、导致后续突发漏检。
   */
  setLearning(channelId: string, enabled: boolean): void {
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new TypeError('[patchouli/trigger.baseline] channelId 不能为空');
    }
    if (enabled) {
      this.learningDisabled.delete(channelId);
    } else {
      this.learningDisabled.add(channelId);
    }
  }

  /** 该群当前是否允许写入 EWMA 样本（未被冻结即 true）。 */
  isLearning(channelId: string): boolean {
    return !this.learningDisabled.has(channelId);
  }

  /**
   * 登记一条消息时间戳，并按需更新 EWMA 基线。
   *
   * - 时间戳会被归一化为单调不降（乱序消息不会让时间倒流）；
   * - 未显式提供 sampleRate 时，用内部采样滑窗的「条/分」估算；
   * - learn=false 时只维护窗口，不污染基线（供触发器在突发期使用）；
   * - 该群被 `setLearning(false)` 冻结时，`learn` 一律按 false 处理。
   */
  record(channelId: string, timestamp: number, options: BaselineRecordOptions = {}): BaselineObservation {
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new TypeError('[patchouli/trigger.baseline] channelId 不能为空');
    }
    assertFiniteNumber(timestamp, 'timestamp');

    const channel = this.ensureChannel(channelId);
    const at = Math.max(timestamp, channel.lastTimestamp);
    channel.lastTimestamp = at;
    this.pushTimestamp(channel, at);

    const sampleRate = options.sampleRate ?? this.sampleRateAt(channel, at);
    assertFiniteNumber(sampleRate, 'sampleRate');
    if (sampleRate < 0) {
      throw new RangeError(`[patchouli/trigger.baseline] sampleRate 不能为负，收到 ${sampleRate}`);
    }

    // 学习闸门优先于调用方意愿：冻结期间只登记时间戳，绝不写入 EWMA。
    const learn = (options.learn ?? true) && !this.learningDisabled.has(channelId);
    let learned = false;

    if (learn) {
      const alpha = resolveAlpha(channel.options.alpha * (options.alphaScale ?? 1));
      const delta = sampleRate - channel.baselineRate;
      channel.baselineRate = Math.max(0, channel.baselineRate + alpha * delta);
      // West 的 EWMA 方差：var_t = (1-α)(var_{t-1} + α·δ²)
      channel.variance = (1 - alpha) * (channel.variance + alpha * delta * delta);
      channel.sampleCount += 1;
      learned = true;
    }

    return {
      channelId,
      timestamp: at,
      sampleRate,
      baselineRate: channel.baselineRate,
      deviation: Math.sqrt(channel.variance),
      sampleCount: channel.sampleCount,
      learned,
    };
  }

  /** 读取某群当前的日常基线（条/分）；未登记时返回冷启动先验（不产生登记副作用）。 */
  getRate(channelId: string): number {
    return this.channels.get(channelId)?.baselineRate ?? this.defaults.initialRate;
  }

  /** 读取某群当前的速率离散度（标准差，条/分）；未登记时为 0。 */
  getDeviation(channelId: string): number {
    const channel = this.channels.get(channelId);
    return channel === undefined ? 0 : Math.sqrt(channel.variance);
  }

  /** 读取某群最近一次观测样本时间（毫秒）；未登记时返回 0。 */
  getLastTimestamp(channelId: string): number {
    return this.channels.get(channelId)?.lastTimestamp ?? 0;
  }

  /**
   * 面向静默底噪的基线指数衰减。
   *
   * 仅在当前基线高于 `minFloor` 时向下衰减，绝不反向拔高低于 `minFloor` 的基线。
   * 方差同步按比例衰减，避免残留方差失真。
   */
  decay(channelId: string, minFloor: number, decayFactor: number): number {
    assertFiniteNumber(minFloor, 'minFloor');
    assertFiniteNumber(decayFactor, 'decayFactor');
    if (minFloor < 0) {
      throw new RangeError(`[patchouli/trigger.baseline] minFloor 不能为负，收到 ${minFloor}`);
    }
    if (decayFactor < 0 || decayFactor > 1) {
      throw new RangeError(`[patchouli/trigger.baseline] decayFactor 必须落在 [0, 1]，收到 ${decayFactor}`);
    }
    const channel = this.ensureChannel(channelId);
    if (channel.baselineRate > minFloor) {
      channel.baselineRate = Math.max(minFloor, minFloor + (channel.baselineRate - minFloor) * decayFactor);
      channel.variance *= decayFactor;
    }
    return channel.baselineRate;
  }

  /** 读取某群累计有效样本数。 */
  getSampleCount(channelId: string): number {
    return this.ensureChannel(channelId).sampleCount;
  }

  /** 读取某群在指定时刻的窗口样本速率（条/分）；缺省用最近样本时间。 */
  getSampleRate(channelId: string, at?: number): number {
    const channel = this.ensureChannel(channelId);
    const moment = at !== undefined && Number.isFinite(at) ? Math.max(at, channel.lastTimestamp) : channel.lastTimestamp;
    return this.sampleRateAt(channel, moment);
  }

  /** 读取某群生效中的估算器配置。 */
  getOptions(channelId: string): BaselineEstimatorOptions {
    return { ...this.ensureChannel(channelId).options };
  }

  /**
   * 设定冷启动初始速率（条/分）。
   * 默认只重设基线值；`resetSamples: true` 时同时清空样本与方差，回到纯先验状态。
   */
  setInitialRate(channelId: string, rate: number, options: { resetSamples?: boolean } = {}): void {
    assertFiniteNumber(rate, 'rate');
    if (rate < 0) {
      throw new RangeError(`[patchouli/trigger.baseline] rate 不能为负，收到 ${rate}`);
    }
    const channel = this.ensureChannel(channelId);
    channel.options = { ...channel.options, initialRate: rate };
    channel.baselineRate = rate;
    if (options.resetSamples === true) {
      channel.variance = 0;
      channel.sampleCount = 0;
      channel.timestamps = [];
      channel.lastTimestamp = 0;
    }
  }

  /** 逐群热更新估算器配置（α / 采样窗口）。 */
  configure(channelId: string, partial: Partial<BaselineEstimatorOptions>): BaselineEstimatorOptions {
    const channel = this.ensureChannel(channelId);
    channel.options = normalizeOptions(partial, channel.options);
    this.pruneTimestamps(channel);
    return { ...channel.options };
  }

  /** 更新后续新建群聊使用的默认配置。 */
  updateDefaults(partial: Partial<BaselineEstimatorOptions>): BaselineEstimatorOptions {
    this.defaults = normalizeOptions(partial, this.defaults);
    return { ...this.defaults };
  }

  /** 重置单个群聊；不传 channelId 时清空全部。 */
  reset(channelId?: string): void {
    if (channelId === undefined) {
      this.channels.clear();
      this.learningDisabled.clear();
      return;
    }
    this.channels.delete(channelId);
    this.learningDisabled.delete(channelId);
  }

  /** 导出可 JSON 序列化的全量状态（深拷贝）。 */
  exportState(): BaselineState {
    const channels: BaselineChannelSnapshot[] = [];
    for (const [channelId, channel] of this.channels) {
      channels.push({
        channelId,
        options: { ...channel.options },
        baselineRate: channel.baselineRate,
        variance: channel.variance,
        sampleCount: channel.sampleCount,
        lastTimestamp: channel.lastTimestamp,
        sampleTimestamps: channel.timestamps.slice(),
      });
    }
    return { version: 1, exportedAt: Date.now(), channels };
  }

  /**
   * 从 `exportState()`（或经 JSON 往返后的未知数据）恢复状态。
   * 采用「全量替换」语义；结构非法时抛 TypeError / RangeError，绝不静默吞掉脏数据。
   */
  importState(state: unknown): void {
    const raw = asSnapshot(state, '状态') as RawBaselineState;
    if (raw.version !== 1) {
      throw new TypeError(`[patchouli/trigger.baseline] 不支持的状态版本: ${String(raw.version)}`);
    }
    const channels = raw.channels;
    if (!Array.isArray(channels)) {
      throw new TypeError('[patchouli/trigger.baseline] 状态缺少 channels 数组');
    }

    const restored = new Map<string, BaselineChannel>();
    for (const item of channels) {
      const snapshot = parseChannelSnapshot(item);
      if (restored.has(snapshot.channelId)) {
        throw new TypeError(`[patchouli/trigger.baseline] 状态中存在重复频道: ${snapshot.channelId}`);
      }
      restored.set(snapshot.channelId, {
        options: snapshot.options,
        baselineRate: snapshot.baselineRate,
        variance: snapshot.variance,
        sampleCount: snapshot.sampleCount,
        lastTimestamp: snapshot.lastTimestamp,
        timestamps: snapshot.sampleTimestamps.slice(),
      });
    }

    this.channels.clear();
    // 导入的是持久化基线，学习闸门属于运行时相位状态：恢复后一律解冻。
    this.learningDisabled.clear();
    for (const [channelId, channel] of restored) {
      this.channels.set(channelId, channel);
    }
  }

  private ensureChannel(channelId: string): BaselineChannel {
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new TypeError('[patchouli/trigger.baseline] channelId 不能为空');
    }
    const existing = this.channels.get(channelId);
    if (existing) {
      return existing;
    }
    const channel: BaselineChannel = {
      options: { ...this.defaults },
      baselineRate: this.defaults.initialRate,
      variance: 0,
      sampleCount: 0,
      lastTimestamp: 0,
      timestamps: [],
    };
    this.channels.set(channelId, channel);
    return channel;
  }

  private pushTimestamp(channel: BaselineChannel, at: number): void {
    channel.timestamps.push(at);
    this.pruneTimestamps(channel);
  }

  private pruneTimestamps(channel: BaselineChannel): void {
    const windowMs = channel.options.sampleWindowSeconds * 1000;
    const boundary = channel.lastTimestamp - windowMs;
    let drop = 0;
    while (drop < channel.timestamps.length && channel.timestamps[drop] <= boundary) {
      drop += 1;
    }
    if (drop > 0) {
      channel.timestamps.splice(0, drop);
    }
  }

  private sampleRateAt(channel: BaselineChannel, at: number): number {
    const windowMs = channel.options.sampleWindowSeconds * 1000;
    const boundary = at - windowMs;
    let count = 0;
    for (let index = channel.timestamps.length - 1; index >= 0; index -= 1) {
      if (channel.timestamps[index] > boundary) {
        count += 1;
      } else {
        break;
      }
    }
    return (count * 60) / channel.options.sampleWindowSeconds;
  }
}
