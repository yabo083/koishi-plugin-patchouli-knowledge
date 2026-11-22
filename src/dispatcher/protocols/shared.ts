/**
 * 协议模块共用的边界守卫。
 *
 * 外部 JSON 一律以 `unknown` 进入，逐字段收敛；这里只放两个协议都会用到的
 * 最小工具，避免各协议各自复制一套不一致的守卫。
 */

import { ProtocolParseError } from './types';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = toFiniteNumber(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 读取 Chat Completions 的 `content`：字符串或 `[{type:'text',text}]` 数组。 */
export function contentToText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  const parts = asArray(value);
  let text = '';
  for (const part of parts) {
    const item = asRecord(part);
    if (item === undefined) continue;
    const piece = toText(item.text);
    if (piece !== undefined) text += piece;
  }
  return text.length > 0 ? text : undefined;
}

/** 构建统一的 JSON 请求头（鉴权只在有 key 时附加）。 */
export function jsonHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

export function requireRoot(payload: unknown, protocolLabel: string): Record<string, unknown> {
  const root = asRecord(payload);
  if (root === undefined) throw new ProtocolParseError(`${protocolLabel} 响应体不是 JSON 对象`);
  return root;
}

/** 非流式响应：解析 JSON 或抛出不可重试的协议错误。 */
export async function readJsonBody(response: Response, protocolLabel: string): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProtocolParseError(`${protocolLabel} 响应体无法解析为 JSON`);
  }
}
