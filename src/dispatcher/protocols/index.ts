/**
 * 协议注册表、端点归一化与自动探测链。
 *
 * 新增协议：实现 `ModelProtocol` 并在 `MODEL_PROTOCOLS` 增加一行，
 * 同时扩展 `ProtocolId` 联合类型与配置 Schema 的枚举。
 * 未知 / 缺失的 id 一律回退到 `responses`，不会因配置漂移阻断沉淀。
 */

import { chatCompletionsProtocol, chatCompletionsUrl } from './chat-completions';
import { geminiBaseURL, geminiProtocol, geminiUrl } from './gemini';
import { responsesProtocol, responsesUrl } from './responses';
import type { ModelProtocol, ProtocolId } from './types';

export * from './types';
export { chatCompletionsProtocol, chatCompletionsUrl } from './chat-completions';
export { geminiBaseURL, geminiProtocol, geminiUrl } from './gemini';
export { responsesProtocol, responsesUrl, RESPONSES_SCHEMA_NAME } from './responses';

export const DEFAULT_DISPATCHER_BASE_URL = 'https://api.openai.com/v1';

/** 已注册协议；键即配置值。`auto` 是选择策略而非协议，不在此表中。 */
export const MODEL_PROTOCOLS: Readonly<Record<ProtocolId, ModelProtocol>> = {
  responses: responsesProtocol,
  gemini: geminiProtocol,
  'chat-completions': chatCompletionsProtocol,
};

export const DEFAULT_PROTOCOL_ID: ProtocolId = 'responses';

export function isProtocolId(value: unknown): value is ProtocolId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MODEL_PROTOCOLS, value);
}

/** 按 id 取协议；未知 id 回退默认协议。 */
export function resolveProtocol(id?: string): ModelProtocol {
  return isProtocolId(id) ? MODEL_PROTOCOLS[id] : MODEL_PROTOCOLS[DEFAULT_PROTOCOL_ID];
}

/**
 * 归一化 baseURL：允许 `https://host/v1`、`.../v1/`、完整 `/chat/completions`、
 * 完整 `/responses`，以及 Gemini 的 `/v1beta`、`/v1beta/models/<m>:generateContent`，
 * 统一去掉端点后缀与尾斜杠。
 */
export function normalizeBaseURL(baseURL?: string): string {
  const raw = (baseURL ?? '').trim() || DEFAULT_DISPATCHER_BASE_URL;
  const withoutSlash = raw.replace(/\/+$/u, '');
  const withoutEndpoint = withoutSlash.replace(/\/(chat\/completions|responses)$/u, '');
  const withoutGeminiEndpoint = withoutEndpoint.replace(/\/models\/[^/]+:(?:stream)?[gG]enerateContent$/u, '');
  return withoutGeminiEndpoint.replace(/\/+$/u, '') || DEFAULT_DISPATCHER_BASE_URL;
}

/** 协议对应的实际请求 URL（自检 / 诊断展示用）。 */
export function protocolUrl(protocol: ModelProtocol, baseURL?: string, model?: string): string {
  return protocol.url(normalizeBaseURL(baseURL), model);
}

/**
 * 端点是否说 Gemini：官方域名，或用户直接粘贴了版本化 / 生成式路径。
 * 只看 URL 形状，不猜模型名——`baseURL` 才是「这是谁的端点」的唯一凭据。
 */
export function isGeminiEndpoint(baseURL?: string): boolean {
  const raw = (baseURL ?? '').trim().toLowerCase();
  if (raw.length === 0) return false;
  if (raw.includes('generativelanguage.googleapis.com')) return true;
  if (raw.includes(':generatecontent')) return true;
  return /\/v1beta(?:\/|$)/u.test(raw);
}

export interface ProtocolChainConfig {
  baseURL?: string;
  /** 仅用于诊断：端点形状只看 `baseURL`（模型名不足以说明端点是哪一家）。 */
  model?: string;
  /** `auto`（默认）/ 显式协议 id / 未知值。 */
  protocol?: string;
}

/**
 * 自动探测链：显式协议 = 单元素；`auto` 时按端点形状给出候选顺序。
 *
 * 调用方从链首开始请求，只有「该协议不被端点支持」才顺延到下一个候选；
 * 网络错误 / 429 / 5xx / 凭据错误都在同一协议上重试或失败，不切换协议。
 */
export function resolveProtocolChain(config: ProtocolChainConfig): ModelProtocol[] {
  const selection = config.protocol;
  if (selection !== undefined && selection !== 'auto') return [resolveProtocol(selection)];
  if (isGeminiEndpoint(config.baseURL)) {
    return [MODEL_PROTOCOLS.gemini, MODEL_PROTOCOLS['chat-completions']];
  }
  return [MODEL_PROTOCOLS.responses, MODEL_PROTOCOLS['chat-completions']];
}
