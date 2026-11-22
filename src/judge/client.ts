/**
 * Patchouli Knowledge —— 本地 System-1 判决客户端（`jev.service` / TypeSafe System One 方言）
 *
 * 职责：把「这场讨论值不值得沉淀」与「话题切点在哪」交给同机轻量裁判，
 * 为 Wave 3 的 `PreDispatchGate`（平息结算前门控）与 Phase 4 的边界裁决
 * 提供**永不抛错**的 `Promise`。
 *
 * 协议形状（roadmap §4.4 / §7.5.10，**不是** OpenAI chat-completions）：
 *   POST {baseURL}/v1/systemone
 *   Authorization: Bearer <apiKey>
 *   { model, state, questions: { <key>: { type: 'noul' | 'choice', instructions, criteria? } } }
 *   -> { answers: { <key>: { type: 'noul', noul } | { type: 'choice', choice, probabilities } } }
 *
 * 降级原则（roadmap §4.5）：未启用 / 超时 / 非 2xx / 响应不可解析 / 概率越界，
 * 一律 `available: false`，调用方按「放行到大模型」或「无边界」处理——
 * 服务故障绝不能被翻译成「全是水」或「全是边界」。
 *
 * 红线：不出现 `: any` / `as any`；响应体以 `unknown` 进入并经类型守卫收敛；
 * 不依赖 `src/trigger/*`（与保证金路径无关），模块加载期不发起任何 I/O。
 */

/* ------------------------------------------------------------------ *
 * 一、对外契约类型
 * ------------------------------------------------------------------ */

export interface JudgeOptions {
  /** opt-in 总开关，默认 false：关闭时任何调用都不发请求，直接返回 available:false。 */
  enabled: boolean;
  /** 默认 'http://127.0.0.1:5070'（本机 jev.service）。 */
  baseURL: string;
  apiKey: string;
  /** 默认 'jev-local'，服务端不校验。 */
  model: string;
  /** 单次请求超时，默认 8000ms。 */
  timeoutMs: number;
}

export const DEFAULT_JUDGE_OPTIONS: Readonly<JudgeOptions> = Object.freeze({
  enabled: false,
  baseURL: 'http://127.0.0.1:5070',
  apiKey: '',
  model: 'jev-local',
  timeoutMs: 8000,
});

export interface GateDecision {
  /** P(true)；available=false 时无意义，调用方必须按「放行」处理。 */
  probability: number;
  /** false = 未启用 / 超时 / 非 2xx / 响应不可解析——一律 fail-open。 */
  available: boolean;
  reason?: string;
}

export interface BoundaryDecision {
  /** 选中的候选编号（1 起的消息序号，即新话题首条）；null = 未选中或不可用。 */
  index: number | null;
  probabilities: Record<string, number>;
  available: boolean;
  reason?: string;
}

export interface JudgeClientDeps {
  fetch?: typeof globalThis.fetch;
}

/* ------------------------------------------------------------------ *
 * 二、常量
 * ------------------------------------------------------------------ */

/** System One 端点路径（`{baseURL}/v1/systemone`）。 */
const SYSTEM_ONE_PATH = '/v1/systemone';

/** 门控问题的 key：一个 `noul` 问题取 P(true)。 */
const GATE_QUESTION_KEY = 'valuable';

/** 边界裁决问题的 key：`choice` over 候选下标。 */
const BOUNDARY_QUESTION_KEY = 'boundary';

/** 门控默认问法（roadmap §4.4）。 */
const GATE_INSTRUCTIONS = '这段群聊讨论是否包含值得沉淀的知识密度？';

/**
 * 边界裁决默认问法。
 *
 * 语义必须与执行侧（`BoundaryAnnotator` 切在该消息**之前**）一致：消息按 1 起编号，
 * `choice = N` 表示「第 N 条消息本身就是新话题的第一条」，因此切换发生在它**之前**。
 */
const BOUNDARY_INSTRUCTIONS =
  '阅读以下同一群聊的连续消息列表（每行形如「序号. 昵称: 文本」，序号从 1 开始，序号 1 即表示第一条消息本身已是新话题），' +
  '判断话题切换发生在哪个编号的消息之前；若为连续讨论则不切。';

/* ------------------------------------------------------------------ *
 * 三、内部类型与守卫
 * ------------------------------------------------------------------ */

interface SystemOneQuestion {
  type: 'noul' | 'choice';
  instructions: string;
  criteria?: Record<string, string>;
}

type SystemOneOutcome =
  | { ok: true; answers: Record<string, unknown> }
  | { ok: false; reason: string };

type ProbabilitiesOutcome =
  | { ok: true; probabilities: Record<string, number> }
  | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 概率守卫：只接受落在 `[0,1]` 内的有限数值。 */
function toProbability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string' && error.length > 0) return error;
  return '未知错误';
}

/**
 * 端点归一化：去尾斜杠、去重复的 `/v1` 后缀。
 * 与 `../dispatcher/protocols` 的 `normalizeBaseURL` 同形，但默认值不同（本机 5070），
 * 故不共用其实现。
 */
function normalizeBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim();
  const raw = trimmed.length > 0 ? trimmed : DEFAULT_JUDGE_OPTIONS.baseURL;
  return raw.replace(/\/+$/u, '').replace(/\/v1$/u, '').replace(/\/+$/u, '');
}

function resolveJudgeOptions(input: Partial<JudgeOptions>): Readonly<JudgeOptions> {
  const baseURL =
    typeof input.baseURL === 'string' ? normalizeBaseURL(input.baseURL) : DEFAULT_JUDGE_OPTIONS.baseURL;
  const apiKey =
    typeof input.apiKey === 'string' && input.apiKey.trim().length > 0
      ? input.apiKey.trim()
      : DEFAULT_JUDGE_OPTIONS.apiKey;
  const model =
    typeof input.model === 'string' && input.model.trim().length > 0
      ? input.model.trim()
      : DEFAULT_JUDGE_OPTIONS.model;
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : DEFAULT_JUDGE_OPTIONS.timeoutMs;
  return Object.freeze({ enabled: input.enabled === true, baseURL, apiKey, model, timeoutMs });
}

/**
 * 候选编号 → 默认 criteria。
 *
 * 编号是 1 起的消息序号，语义为「切换发生在该编号的消息**之前**」——与
 * `BoundaryAnnotator` 把候选落定消息当作新话题首条的执行侧一致。
 * 只对非空候选生成；空候选时调用方不该发问（choice 必然落空）。
 */
function buildDefaultCriteria(candidates: readonly number[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[String(candidate)] = `在编号 ${candidate} 的消息之前发生话题切换`;
  }
  criteria.none = '连续讨论，不切';
  return criteria;
}

function readProbabilities(value: unknown): ProbabilitiesOutcome {
  if (value === undefined || value === null) return { ok: true, probabilities: {} };
  const record = asRecord(value);
  if (!record) return { ok: false, reason: 'judge 响应 probabilities 不是对象' };
  const probabilities: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    const probability = toProbability(entry);
    if (probability === undefined) {
      return { ok: false, reason: `judge 概率越界：${key}=${typeof entry === 'number' ? String(entry) : '非数值'}` };
    }
    probabilities[key] = probability;
  }
  return { ok: true, probabilities };
}

/** 响应体 → answers 表。JSON 解析失败或 `answers` 缺失一律转成可读 reason。 */
function readAnswers(text: string): SystemOneOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'judge 响应 JSON 解析失败' };
  }
  const answers = asRecord(asRecord(payload)?.answers);
  if (answers === undefined) return { ok: false, reason: 'judge 响应缺少 answers' };
  return { ok: true, answers };
}

/* ------------------------------------------------------------------ *
 * 四、客户端
 * ------------------------------------------------------------------ */

export class JudgeClient {
  readonly options: Readonly<JudgeOptions>;

  private readonly fetchImpl: typeof globalThis.fetch;

  private readonly endpoint: string;

  constructor(options: Partial<JudgeOptions> = {}, deps: JudgeClientDeps = {}) {
    this.options = resolveJudgeOptions(options);
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.endpoint = `${this.options.baseURL}${SYSTEM_ONE_PATH}`;
  }

  /** 门控：一个 noul 问题，返回 P(true)。**永不抛错**。 */
  async gate(state: string, instructions: string = GATE_INSTRUCTIONS): Promise<GateDecision> {
    if (!this.options.enabled) {
      return { probability: 1, available: false, reason: 'judge-disabled' };
    }

    const outcome = await this.postQuestions(state, {
      [GATE_QUESTION_KEY]: { type: 'noul', instructions },
    });
    if (!outcome.ok) return { probability: 1, available: false, reason: outcome.reason };

    const answer = asRecord(outcome.answers[GATE_QUESTION_KEY]);
    if (answer === undefined) {
      return {
        probability: 1,
        available: false,
        reason: `judge 响应缺少 answers.${GATE_QUESTION_KEY}`,
      };
    }
    if (typeof answer.type === 'string' && answer.type !== 'noul') {
      return { probability: 1, available: false, reason: `judge 判决类型不符：${answer.type}` };
    }

    const probability = toProbability(answer.noul);
    if (probability === undefined) {
      return {
        probability: 1,
        available: false,
        reason: `judge P(true) 不可用：${typeof answer.noul === 'number' ? String(answer.noul) : '非数值'}`,
      };
    }
    return { probability, available: true };
  }

  /** 边界裁决：choice over 1 起编号的候选消息（编号语义见 `BOUNDARY_INSTRUCTIONS`）。**永不抛错**。 */
  async boundary(
    state: string,
    candidates: readonly number[],
    criteria?: Record<string, string>,
  ): Promise<BoundaryDecision> {
    const unavailable = (reason: string): BoundaryDecision => ({
      index: null,
      probabilities: {},
      available: false,
      reason,
    });

    if (!this.options.enabled) return unavailable('judge-disabled');

    const question: SystemOneQuestion = {
      type: 'choice',
      instructions: BOUNDARY_INSTRUCTIONS,
    };
    const resolvedCriteria = criteria ?? (candidates.length > 0 ? buildDefaultCriteria(candidates) : undefined);
    if (resolvedCriteria !== undefined) question.criteria = resolvedCriteria;

    const outcome = await this.postQuestions(state, { [BOUNDARY_QUESTION_KEY]: question });
    if (!outcome.ok) return unavailable(outcome.reason);

    const answer = asRecord(outcome.answers[BOUNDARY_QUESTION_KEY]);
    if (answer === undefined) {
      return unavailable(`judge 响应缺少 answers.${BOUNDARY_QUESTION_KEY}`);
    }
    if (typeof answer.type === 'string' && answer.type !== 'choice') {
      return unavailable(`judge 判决类型不符：${answer.type}`);
    }

    const probabilities = readProbabilities(answer.probabilities);
    if (!probabilities.ok) return unavailable(probabilities.reason);

    const choice =
      typeof answer.choice === 'string'
        ? answer.choice.trim()
        : typeof answer.choice === 'number' && Number.isFinite(answer.choice)
          ? String(answer.choice)
          : undefined;
    if (choice === undefined) {
      return unavailable('judge 响应缺少 choice');
    }
    if (choice === 'none') {
      return { index: null, probabilities: probabilities.probabilities, available: true };
    }

    const index = Number(choice);
    if (!Number.isInteger(index) || !candidates.includes(index)) {
      return {
        index: null,
        probabilities: probabilities.probabilities,
        available: true,
        reason: `judge choice 不在候选内：${choice}`,
      };
    }
    return { index, probabilities: probabilities.probabilities, available: true };
  }

  /**
   * 单次 System One 调用：超时 → 非 2xx → 响应解析，逐层降级为 `{ ok: false, reason }`。
   * 定时器在 `finally` 中清理，任何分支都不向调用方抛出。
   */
  private async postQuestions(
    state: string,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneOutcome> {
    const { timeoutMs, apiKey, model } = this.options;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, state, questions }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { ok: false, reason: `judge HTTP ${response.status}` };
      }

      const text = await response.text();
      return readAnswers(text);
    } catch (error) {
      if (timedOut) return { ok: false, reason: `judge 请求超时（${timeoutMs} ms）` };
      return { ok: false, reason: `judge 网络请求失败：${describeError(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
