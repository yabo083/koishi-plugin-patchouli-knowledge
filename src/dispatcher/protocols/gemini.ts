/**
 * Google Gemini 原生协议（`POST {baseURL}/models/{model}:generateContent`）。
 *
 * Gemini 的生成式端点与 OpenAI 兼容层是两套形状：`contents[]`（`user` / `model` 两种角色）、
 * `systemInstruction` 独立于对话之外、输出格式由 `generationConfig.responseMimeType` 控制。
 * 这里不做 OpenAI 兼容映射——该端点说 Gemini，就按 Gemini 说。
 *
 * 鉴权走 `x-goog-api-key` 头而不是 `?key=` 查询参数：query 更容易被网关、代理与
 * 访问日志记录下来，密钥不进 URL。
 */

import { MODEL_OUTPUT_JSON_SCHEMA } from '../prompts';
import {
  asArray,
  asRecord,
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

/** Gemini 生成端点走过的 API 版本；用户漏填时补上。 */
const GEMINI_API_VERSION = 'v1beta';

/** `.../models/<name>` 或 `.../models/<name>:generateContent` 的端点尾缀。 */
const GEMINI_MODELS_SUFFIX = /\/models(?:\/[^/]+(?::(?:stream)?[gG]enerateContent)?)?$/u;

/**
 * 归一化到「版本根」（`https://host/v1beta`）。
 *
 * 容忍三种用户输入：
 * - `https://generativelanguage.googleapis.com` → 补 `/v1beta`
 * - `https://generativelanguage.googleapis.com/v1beta[/]` → 原样
 * - `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
 *   → 剥掉 `/models/...`
 */
export function geminiBaseURL(baseURL: string): string {
  const stripped = (baseURL ?? '').trim().replace(/\/+$/u, '').replace(GEMINI_MODELS_SUFFIX, '');
  const base = stripped.replace(/\/+$/u, '');
  if (/\/v\d+(?:beta|alpha)?\d*$/u.test(base)) return base;
  return `${base}/${GEMINI_API_VERSION}`;
}

export function geminiUrl(baseURL: string, model?: string): string {
  const base = geminiBaseURL(baseURL);
  const name = (model ?? '').trim().replace(/^models\//u, '');
  return name.length > 0 ? `${base}/models/${name}:generateContent` : base;
}

/**
 * 把内部 JSON Schema 翻译成 Gemini 的 `responseSchema` 子集（OpenAPI 3.0 方言）。
 *
 * Gemini 不接受 JSON Schema 的 `additionalProperties`，`type` 也不接受联合数组，
 * 可空字段要写 `nullable: true`（且 enum 里不能带 `null`）。这些只是方言差异，
 * 语义一一对应：**键名由解码器约束**，不靠模型自觉，也不需要事后再做键名修补。
 */
function toGeminiSchema(node: unknown): Record<string, unknown> {
  const source = asRecord(node);
  if (source === undefined) return { type: 'string' };
  const out: Record<string, unknown> = {};

  const rawType = source.type;
  const typeList = Array.isArray(rawType) ? rawType.map((item) => String(item)) : [String(rawType ?? '')];
  const nonNull = typeList.filter((item) => item.length > 0 && item !== 'null');
  out.type = nonNull[0] ?? 'string';
  if (typeList.includes('null')) out.nullable = true;

  if (Array.isArray(source.enum)) {
    const values = source.enum.filter((item) => item !== null);
    if (values.length > 0) out.enum = values;
  }
  if (typeof source.description === 'string') out.description = source.description;
  if (typeof source.minimum === 'number') out.minimum = source.minimum;
  if (typeof source.maximum === 'number') out.maximum = source.maximum;

  if (source.items !== undefined) out.items = toGeminiSchema(source.items);

  const properties = asRecord(source.properties);
  if (properties !== undefined) {
    const translated: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(properties)) translated[key] = toGeminiSchema(child);
    out.properties = translated;
    // Gemini 用 propertyOrdering 固定键顺序，与 required 分开表达。
    out.propertyOrdering = Object.keys(translated);
  }
  if (Array.isArray(source.required) && source.required.length > 0) {
    out.required = source.required.map((item) => String(item));
  }
  return out;
}

function build(input: ProtocolBuildInput): ProtocolHttpRequest {
  const systemParts: string[] = [];
  const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];

  for (const message of input.messages) {
    const text = message.content;
    if (typeof text !== 'string' || text.length === 0) continue;
    if (message.role === 'system') {
      systemParts.push(text);
      continue;
    }
    const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last !== undefined && last.role === role) {
      // 相邻同角色消息合并：Gemini 不接受交替以外的多余轮次，也不接受空 parts。
      last.parts[0].text = `${last.parts[0].text}\n\n${text}`;
      continue;
    }
    contents.push({ role, parts: [{ text }] });
  }

  const generationConfig: Record<string, unknown> = {
    temperature: input.temperature,
    maxOutputTokens: input.maxTokens,
  };
  // 纯文本模式不声明 MIME：Gemini 会按 text/plain 返回，便于本地 Markdown 降级解析。
  if (input.format !== 'text') generationConfig.responseMimeType = 'application/json';
  // 严格模式把契约 schema 一并下发：键名由解码器约束（端点不支持时 400 → 调度器降级为 text）。
  if (input.format === 'structured') generationConfig.responseSchema = toGeminiSchema(MODEL_OUTPUT_JSON_SCHEMA);

  const body: Record<string, unknown> = { contents, generationConfig };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  // 密钥走头部：绝不拼进 URL，避免代理与访问日志留存。
  if (input.apiKey) headers['x-goog-api-key'] = input.apiKey;

  return { url: geminiUrl(input.baseURL, input.model), headers, body };
}

function parse(payload: unknown): ProtocolCompletion {
  const root = requireRoot(payload, 'Gemini');

  const feedback = asRecord(root.promptFeedback);
  const blockReason = feedback === undefined ? undefined : toText(feedback.blockReason);
  if (blockReason !== undefined) {
    throw new ProtocolParseError(`Gemini 因安全策略未生成内容（blockReason=${blockReason}）`);
  }

  const candidate = asRecord(asArray(root.candidates)[0]);
  if (candidate === undefined) throw new ProtocolParseError('Gemini 响应缺少 candidates[0]');

  const content = asRecord(candidate.content);
  let text = '';
  for (const part of asArray(content?.parts)) {
    const item = asRecord(part);
    if (item === undefined) continue;
    if (item.thought === true) continue;
    const piece = toText(item.text);
    if (piece !== undefined) text += piece;
  }
  const usage = asRecord(root.usageMetadata);
  const tokensUsed = usage === undefined ? undefined : pickNumber(usage, ['totalTokenCount', 'total_tokens']);
  const rawFinish = toText(candidate.finishReason);
  // Gemini 用 MAX_TOKENS 表示被 maxOutputTokens 截断；调度器只认 `length`。
  const finishReason = rawFinish === 'MAX_TOKENS' ? 'length' : rawFinish;

  // 截断到「一个字都没有」是 thinking 模型把预算烧在思考上的典型形态。
  // 必须先把 finishReason 换算出来再判空，否则调度器只能看到「响应缺 parts」这种
  // 与真实原因无关的硬失败，连「压缩篇幅重试」的分支都走不到。
  if (text.length === 0 && finishReason === 'length') {
    return { text: '', tokensUsed, finishReason };
  }
  if (text.length === 0) throw new ProtocolParseError('Gemini 响应缺少 candidates[0].content.parts[].text');

  return { text, tokensUsed, finishReason };
}

async function read(response: Response): Promise<ProtocolCompletion> {
  return parse(await readJsonBody(response, 'Gemini'));
}

function isFormatRejection(detail: string): boolean {
  return /(response_?mime_?type|response_?schema|mime type)/iu.test(detail);
}

export const geminiProtocol: ModelProtocol = {
  id: 'gemini',
  label: 'Gemini',
  url: geminiUrl,
  build,
  read,
  parse,
  isFormatRejection,
};
