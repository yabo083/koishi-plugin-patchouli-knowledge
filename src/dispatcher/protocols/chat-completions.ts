/**
 * OpenAI Chat Completions 协议（`POST {baseURL}/chat/completions`）。
 *
 * 保留为可插拔的兼容实现：部分 OpenAI 兼容网关尚未提供 `/responses`，
 * 或需要退回旧路径排查时可把 `dispatcher.protocol` 设为 `chat-completions`。
 * 新部署默认走 `responses`，本模块不参与默认链路。
 */

import { MODEL_OUTPUT_JSON_SCHEMA } from '../prompts';
import {
  asArray,
  asRecord,
  contentToText,
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

export function chatCompletionsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/u, '')}/chat/completions`;
}

function build(input: ProtocolBuildInput): ProtocolHttpRequest {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    stream: false,
  };
  if (input.format === 'json_object') {
    body.response_format = { type: 'json_object' };
  } else if (input.format === 'structured') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'patchouli_wiki_entry',
        strict: true,
        schema: MODEL_OUTPUT_JSON_SCHEMA,
      },
    };
  }
  return { url: chatCompletionsUrl(input.baseURL), headers: jsonHeaders(input.apiKey), body };
}

function parse(payload: unknown): ProtocolCompletion {
  const root = requireRoot(payload, 'Chat Completions');
  const first = asRecord(asArray(root.choices)[0]);
  if (first === undefined) throw new ProtocolParseError('Chat Completions 响应缺少 choices[0]');

  const message = asRecord(first.message);
  const text = contentToText(message?.content) ?? toText(first.text);
  if (text === undefined) throw new ProtocolParseError('Chat Completions 响应缺少 choices[0].message.content');

  const usage = asRecord(root.usage);
  const tokensUsed = usage === undefined ? undefined : pickNumber(usage, ['total_tokens', 'totalTokens']);
  const finishReason = toText(first.finish_reason);

  return { text, tokensUsed, finishReason };
}

async function read(response: Response): Promise<ProtocolCompletion> {
  return parse(await readJsonBody(response, 'Chat Completions'));
}

function isFormatRejection(detail: string): boolean {
  // 同 responses：只认显式格式参数名，不用 `structured` / `json mode` 这类泛词。
  return /(response_format|json_object|json_schema|response_schema)/iu.test(detail);
}

export const chatCompletionsProtocol: ModelProtocol = {
  id: 'chat-completions',
  label: 'OpenAI Chat Completions',
  url: chatCompletionsUrl,
  build,
  read,
  parse,
  isFormatRejection,
};
