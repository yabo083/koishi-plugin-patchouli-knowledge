/**
 * OpenAI Responses API 协议（`POST {baseURL}/responses`）。
 *
 * 这是 standalone 模式的默认协议：
 *   - 系统提示词走 `instructions`，其余消息走 `input`（`role + content`）；
 *   - 输出预算字段是 `max_output_tokens`（不是 `max_tokens`）；
 *   - 结构化输出走 `text.format`（`json_schema` / `json_object`），不再是 `response_format`；
 *   - 响应正文优先读 `output_text`，缺失时遍历 `output[].content[].output_text`。
 *
 * 本模块只依赖 `types.ts` / `shared.ts`，不引用 dispatcher；删除它时只需从注册表摘除。
 */

import { MODEL_OUTPUT_JSON_SCHEMA } from '../prompts';
import {
  asArray,
  asRecord,
  jsonHeaders,
  pickNumber,
  readJsonBody,
  requireRoot,
  toText,
} from './shared';
import {
  ProtocolParseError,
  type ModelProtocol,
  type ProtocolBuildInput,
  type ProtocolCompletion,
  type ProtocolHttpRequest,
} from './types';

/**
 * 单次响应的字符上限（SSE 累积）。
 *
 * 网关不回 `[DONE]`、或事件流缺少空行分隔时，`buffer`/`text` 会一直增长直到进程 OOM；
 * `max_output_tokens` 只约束正常端点，这里给传输层兜底。
 */
const MAX_STREAM_CHARS = 8 * 1024 * 1024;

/** 结构化输出的 schema 名称（Responses 必填）。 */
export const RESPONSES_SCHEMA_NAME = 'patchouli_wiki_entry';

/** 稳定缓存键：让同一前缀的请求尽量落到同一缓存分片。 */
export const RESPONSES_CACHE_KEY = 'patchouli-knowledge';

export function responsesUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/u, '')}/responses`;
}

/** 把消息拆成 `instructions`（system）与 `input`（user/assistant）。 */
function splitMessages(messages: ProtocolBuildInput['messages']): {
  instructions: string | undefined;
  input: Array<{ role: string; content: string }>;
} {
  const system: string[] = [];
  const input: Array<{ role: string; content: string }> = [];
  for (const message of messages) {
    if (message.role === 'system') system.push(message.content);
    else input.push({ role: message.role, content: message.content });
  }
  return {
    instructions: system.length > 0 ? system.join('\n\n') : undefined,
    input,
  };
}

function build(input: ProtocolBuildInput): ProtocolHttpRequest {
  const { instructions, input: items } = splitMessages(input.messages);
  const body: Record<string, unknown> = {
    model: input.model,
    input: items,
    temperature: input.temperature,
    max_output_tokens: input.maxTokens,
    stream: true,
    // 不把群聊内容留在上游；缓存是前缀级复用，与 store 无关。
    store: false,
    // 公益站按「流式 + 缓存命中」判别：稳定 key 提升同前缀请求的缓存命中率。
    prompt_cache_key: RESPONSES_CACHE_KEY,
  };
  if (instructions !== undefined) body.instructions = instructions;
  if (input.format === 'json_object') {
    body.text = { format: { type: 'json_object' } };
  } else if (input.format === 'structured') {
    body.text = {
      format: {
        type: 'json_schema',
        name: RESPONSES_SCHEMA_NAME,
        strict: true,
        schema: MODEL_OUTPUT_JSON_SCHEMA,
      },
    };
  }
  return { url: responsesUrl(input.baseURL), headers: jsonHeaders(input.apiKey), body };
}

function extractText(root: Record<string, unknown>): string {
  let text = toText(root.output_text) ?? '';
  if (text.length === 0) {
    for (const item of asArray(root.output)) {
      const node = asRecord(item);
      if (node === undefined || node.type !== 'message') continue;
      for (const part of asArray(node.content)) {
        const content = asRecord(part);
        if (content === undefined) continue;
        if (content.type !== 'output_text') continue;
        const piece = toText(content.text);
        if (piece !== undefined) {
          text += piece;
          if (text.length > MAX_STREAM_CHARS) throw new ProtocolParseError('Responses 流式输出超过上限');
        }
      }
    }
  }
  return text;
}

function readUsage(root: Record<string, unknown>): {
  tokensUsed?: number;
  cachedTokens?: number;
  finishReason?: string;
} {
  const usage = asRecord(root.usage);
  const total = usage === undefined ? undefined : pickNumber(usage, ['total_tokens', 'totalTokens']);
  const tokensUsed =
    total ??
    (usage === undefined
      ? undefined
      : sumTokens(
          pickNumber(usage, ['input_tokens', 'inputTokens']),
          pickNumber(usage, ['output_tokens', 'outputTokens']),
        ));
  const inputDetails = asRecord(usage?.input_tokens_details);
  const cachedTokens =
    inputDetails === undefined ? undefined : pickNumber(inputDetails, ['cached_tokens', 'cachedTokens']);

  const incomplete = asRecord(root.incomplete_details);
  const finishReason =
    root.status === 'incomplete' ? (toText(incomplete?.reason) ?? 'incomplete') : undefined;
  return { tokensUsed, cachedTokens, finishReason };
}

function parse(payload: unknown): ProtocolCompletion {
  const root = requireRoot(payload, 'Responses');
  const text = extractText(root);
  if (text.length === 0) throw new ProtocolParseError('Responses 响应缺少 output_text / output[].content[].output_text');
  return { text, ...readUsage(root) };
}

function sumTokens(input?: number, output?: number): number | undefined {
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

/** 从 SSE 事件里取 `data:` 行并解析为 JSON 对象。 */
function parseSseEvent(raw: string): Record<string, unknown> | undefined {
  const data = raw
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (data.length === 0 || data === '[DONE]') return undefined;
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return undefined;
  }
}

/**
 * 读取 Responses 的 SSE 流。
 *
 * 兼容三类上游实现：
 *   1. 标准事件流：`response.output_text.delta` 累加，`response.completed` 带 usage；
 *   2. 只有 `response.completed`（部分网关丢弃中间事件）：从完整 response 解析；
 *   3. 网关忽略 `stream` 直接返回 JSON：由 `read()` 按 content-type 分流到 `parse`。
 */
async function readStream(response: Response): Promise<ProtocolCompletion> {
  const body = response.body;
  if (body === null) throw new ProtocolParseError('Responses 流式响应缺少 body');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed: Record<string, unknown> | undefined;
  let failure: string | undefined;

  const consume = (raw: string): void => {
    const event = parseSseEvent(raw);
    if (event === undefined) return;
    const type = toText(event.type);
    if (type === 'response.output_text.delta') {
      text += toText(event.delta) ?? '';
      return;
    }
    if (type === 'response.output_text.done') {
      const full = toText(event.text);
      if (full !== undefined) text = full;
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      completed = asRecord(event.response) ?? event;
      return;
    }
    if (type === 'response.failed' || type === 'error') {
      const resp = asRecord(event.response);
      const err = asRecord(resp?.error) ?? asRecord(event.error);
      failure = toText(err?.message) ?? 'Responses 流式响应失败';
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/gu, '\n');
      if (buffer.length > MAX_STREAM_CHARS) throw new ProtocolParseError('Responses 事件流超过上限');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode().replace(/\r\n/gu, '\n');
    if (buffer.trim().length > 0) consume(buffer);
  } finally {
    reader.releaseLock();
  }

  if (failure !== undefined) throw new ProtocolParseError(failure);

  if (completed !== undefined) {
    try {
      const parsed = parse(completed);
      if (parsed.text.length > 0) return parsed;
    } catch {
      // 完整事件里没有 output：退回已累加的 delta + usage。
    }
  }

  if (text.length === 0) throw new ProtocolParseError('Responses 流式响应未产出 output_text');
  return { text, ...(completed === undefined ? {} : readUsage(completed)) };
}

async function read(response: Response): Promise<ProtocolCompletion> {
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.includes('text/event-stream')) return readStream(response);
  return parse(await readJsonBody(response, 'Responses'));
}

function isFormatRejection(detail: string): boolean {
  // 只认「格式参数本身被拒」：裸 `structured` / `json mode` 会命中内容类 400
  // （如 `structured content required`），把普通失败误降级成 text 并永久粘住。
  return /(text\.format|response_format|json_schema|response_schema|unsupported.{0,20}format|format.{0,20}(unsupported|not supported))/iu.test(
    detail,
  );
}

export const responsesProtocol: ModelProtocol = {
  id: 'responses',
  label: 'OpenAI Responses',
  url: responsesUrl,
  build,
  read,
  parse,
  isFormatRejection,
};
