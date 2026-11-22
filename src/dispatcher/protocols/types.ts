/**
 * 模型端点协议的 Seam 契约。
 *
 * 传输层（超时、取消、重试、鉴权头）由 `ModelDispatcher` 负责；本目录下的每个协议模块
 * 只回答三件事：请求发到哪个 URL、请求体长什么样、响应怎么翻译成纯文本。
 *
 * 新增协议 = 新建一个实现 `ModelProtocol` 的模块 + 在 `index.ts` 注册一行；
 * 删除协议 = 从注册表移除（未知 id 自动回退 `responses`），调用方无需改动。
 */

/** 端点协议标识。新增协议时扩展此联合类型并在注册表登记。 */
export type ProtocolId = 'responses' | 'gemini' | 'chat-completions';

/** 输出格式三态：JSON 对象 / 严格 Schema / 纯文本。 */
export type ProtocolFormat = 'json_object' | 'structured' | 'text';

/** 协议层只关心的最小消息形状（与 `PromptMessage` 结构兼容）。 */
export interface ProtocolMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 构建一次 HTTP 请求所需的全部输入。 */
export interface ProtocolBuildInput {
  /** 已归一化的 API 根地址（不含 `/responses` 或 `/chat/completions`）。 */
  baseURL: string;
  apiKey?: string;
  model: string;
  messages: readonly ProtocolMessage[];
  temperature: number;
  maxTokens: number;
  format: ProtocolFormat;
}

/** 协议产出的 HTTP 请求（URL / 头 / JSON 体）。 */
export interface ProtocolHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 协议解析出的补全结果。 */
export interface ProtocolCompletion {
  text: string;
  tokensUsed?: number;
  /** 输入侧缓存命中的 token 数（Responses: `usage.input_tokens_details.cached_tokens`）。 */
  cachedTokens?: number;
  /** `length` / `max_output_tokens` 表示被截断；其余实现不强制。 */
  finishReason?: string;
}

/** 响应体形状不符合该协议时抛出；传输层据此判定为不可重试。 */
export class ProtocolParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolParseError';
  }
}

export interface ModelProtocol {
  readonly id: ProtocolId;
  /** 人类可读名称，用于日志。 */
  readonly label: string;
  /**
   * 实际请求端点（`baseURL` 已归一化）。
   * `model` 只在 URL 里嵌模型名的协议（Gemini `.../models/{model}:generateContent`）使用。
   */
  url(baseURL: string, model?: string): string;
  build(input: ProtocolBuildInput): ProtocolHttpRequest;
  /** 读取 HTTP 响应：可自行决定 JSON / SSE 流式解析。 */
  read(response: Response): Promise<ProtocolCompletion>;
  parse(payload: unknown): ProtocolCompletion;
  /** HTTP 400 时判断是否为「该格式参数不被支持」，触发降级到 `text`。 */
  isFormatRejection(detail: string): boolean;
}
