/**
 * Patchouli Knowledge - 统一投递适配层
 *
 * 目标服务名是 `miyako-delivery`（**不是** `notifier`）：目标宿主上 `ctx.notifier` 已被
 * `@koishijs/plugin-notifier` 占用，两者语义不同，绝不能混用。
 *
 * 优先级：
 *   1. 宿主提供 `ctx['miyako-delivery']`（含去重窗口、静默时段、重试策略）→ 全量委托；
 *   2. 服务缺失时**没有任何降级**（0.8.15 起删除 bot 直发）：频道目标统一结构化失败
 *      `NO_DELIVERY_SERVICE`——投递是生态基础设施，契约不满足就显式失败，不绕过治理层；
 *   3. 相册目标同理：只有 `delivery` 服务知道相册语义，缺服务即失败，不做替代发送。
 */

import { h } from 'koishi';

/** 投递目标：群聊频道或相册。 */
export type DeliveryTargetLike =
  | { kind?: 'channel'; channelId: string; silent?: boolean }
  | { kind: 'album'; channelId: string; albumId: string; albumName?: string };

/** 一条投递请求（与 `ctx['miyako-delivery'].deliver` 的入参同构）。 */
export interface DeliveryLike {
  target: DeliveryTargetLike;
  elements: readonly unknown[];
  scope?: string;
  dedupeKey?: string;
}

/** 投递结果（与 `ctx['miyako-delivery'].deliver` 的出参同构）。 */
export interface DeliveryOutcomeLike {
  ok: boolean;
  skipped?: string;
  messageId?: string;
  error?: { code: string; message: string };
  attempts: number;
}

/** 一次投递的重试策略（透传给 miyako-delivery，未提供时用服务端默认）。 */
export interface DeliveryRetryOptions {
  /** 含首次发送的总尝试次数。 */
  maxAttempts?: number;
  /** 首次退避基数（毫秒），第 n 次重试等待 `base * 2^(n-1)`。 */
  baseDelayMs?: number;
}

/** 批量投递汇总（`broadcast` 的返回面）。 */
export interface DeliveryBatchResultLike {
  ok: boolean;
  deliveredCount?: number;
  totalCount?: number;
  outcomes?: readonly DeliveryOutcomeLike[];
}

/** `ctx['miyako-delivery']` 的最小面。 */
export interface DeliveryServiceLike {
  deliver(delivery: DeliveryLike & { retry?: DeliveryRetryOptions }): Promise<DeliveryOutcomeLike>;
  /** 批量入口；宿主未实现时调用方退化为逐个 `deliver`。 */
  broadcast?(
    deliveries: ReadonlyArray<DeliveryLike & { retry?: DeliveryRetryOptions }>,
  ): Promise<DeliveryBatchResultLike>;
}

/** 宿主注入的投递服务句柄（字段在读取处逐一 `typeof` 校验）。 */
interface DeliveryServiceHandle {
  deliver?: (delivery: DeliveryLike) => unknown;
  broadcast?: (deliveries: readonly DeliveryLike[]) => unknown;
}

/** 外部对象边界：只做「是对象」这一层判断，字段在读取处校验。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asDeliveryService(value: unknown): DeliveryServiceHandle | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  // 外部服务实例无法在此逐字段建模；`deliver` 在调用前会用 typeof 校验。
  const handle = value as DeliveryServiceHandle;
  return typeof handle.deliver === 'function' ? handle : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '未知投递错误';
}

function failure(code: string, message: string, attempts = 0): DeliveryOutcomeLike {
  return { ok: false, attempts, error: { code, message } };
}

/** 把服务返回值归一化为 `DeliveryOutcomeLike`（宿主实现可能缺字段）。 */
function normalizeOutcome(raw: unknown): DeliveryOutcomeLike {
  const record = asRecord(raw);
  const ok = record?.ok === true;
  const attempts = typeof record?.attempts === 'number' && Number.isFinite(record.attempts) ? record.attempts : 0;
  const outcome: DeliveryOutcomeLike = { ok, attempts };
  if (typeof record?.skipped === 'string') outcome.skipped = record.skipped;
  if (typeof record?.messageId === 'string') outcome.messageId = record.messageId;
  if (!ok) {
    const error = asRecord(record?.error);
    const code = typeof error?.code === 'string' ? error.code : 'DELIVERY_FAILED';
    const message = typeof error?.message === 'string' ? error.message : '投递未成功';
    outcome.error = { code, message };
  }
  return outcome;
}

/**
 * 读取宿主的 `ctx['miyako-delivery']` 服务。
 *
 * 服务必须暴露 `deliver` 函数；缺失或形状不符时返回 `undefined`（调用方走降级）。
 */
export function getDeliveryService(ctx: unknown): DeliveryServiceLike | undefined {
  const service = asDeliveryService(asRecord(ctx)?.['miyako-delivery']);
  if (service?.deliver === undefined) return undefined;
  const deliver = service.deliver;
  const wrapper: DeliveryServiceLike = {
    deliver: async (delivery) => normalizeOutcome(await deliver.call(service, delivery)),
  };
  // `broadcast` 是 miyako-delivery 的批量入口（一次 Write-Ahead + 每目标退避重试）；
  // 存在就透传，缺失时调用方自动退化为逐个 `deliver`。
  const broadcast = service.broadcast;
  if (typeof broadcast === 'function') {
    wrapper.broadcast = async (deliveries) => {
      const raw: unknown = await broadcast.call(service, deliveries);
      const record = asRecord(raw);
      if (record === undefined) return { ok: false };
      const result: DeliveryBatchResultLike = { ok: record.ok === true };
      if (typeof record.deliveredCount === 'number') result.deliveredCount = record.deliveredCount;
      if (typeof record.totalCount === 'number') result.totalCount = record.totalCount;
      if (Array.isArray(record.outcomes)) result.outcomes = record.outcomes.map((item) => normalizeOutcome(item));
      return result;
    };
  }
  return wrapper;
}

/**
 * 投递任意消息元素。
 *
 * 全量委托 `ctx['miyako-delivery']`（scope / dedupeKey 原样透传，重试与幂等由服务负责）。
 * 服务缺失时返回 `NO_DELIVERY_SERVICE`——**没有 bot 直发降级**：投递是这个生态的基础设施，
 * 契约不满足就显式失败，而不是悄悄绕过治理层。
 */
export async function deliverElements(
  ctx: unknown,
  target: DeliveryTargetLike,
  elements: readonly unknown[],
  meta: { scope?: string; dedupeKey?: string } = {},
): Promise<DeliveryOutcomeLike> {
  const service = getDeliveryService(ctx);
  if (service !== undefined) {
    try {
      return await service.deliver({ target, elements, scope: meta.scope, dedupeKey: meta.dedupeKey });
    } catch (error) {
      return failure('DELIVERY_FAILED', errorMessage(error));
    }
  }

  // 投递契约只有一份：`ctx['miyako-delivery']`。缺它就报错，不自建 bot 直发。
  return failure(
    'NO_DELIVERY_SERVICE',
    `投递需要宿主提供 ctx['miyako-delivery'] 服务（目标 ${target.kind === 'album' ? '相册' : '频道'} ${target.channelId}）`,
  );
}

/** 一次批量投递的汇总结果。 */
export interface DeliveryBatchOutcome {
  ok: boolean;
  /** 真正送达的目标数（不含 skip）。 */
  delivered: number;
  total: number;
  outcomes: readonly DeliveryOutcomeLike[];
}

/**
 * 把同一张 PNG 投递到多个目标。
 *
 * 只走 `miyako-delivery.broadcast`：一次 Write-Ahead + 每目标独立退避重试，结果按目标返回。
 * 服务缺失或未实现 `broadcast` 一律结构化失败（`NO_BROADCAST`），**没有逐个退化**——
 * 投递是生态基础设施，契约不满足就显式报错。
 *
 * **重试不在这里实现**——`maxAttempts` / `baseDelayMs` 只是透传，真正的退避归服务。
 */
export async function deliverCardToTargets(
  ctx: unknown,
  targets: readonly DeliveryTargetLike[],
  png: Buffer,
  meta: { scope?: string; dedupeKeyOf: (target: DeliveryTargetLike) => string; retry?: DeliveryRetryOptions },
): Promise<DeliveryBatchOutcome> {
  if (targets.length === 0) return { ok: true, delivered: 0, total: 0, outcomes: [] };
  const elements = [h.image(png, 'image/png')];
  const service = getDeliveryService(ctx);

  if (service === undefined) {
    return {
      ok: false,
      delivered: 0,
      total: targets.length,
      outcomes: [failure('NO_DELIVERY_SERVICE', "批量投递需要宿主提供 ctx['miyako-delivery'] 服务")],
    };
  }
  if (service.broadcast === undefined) {
    return {
      ok: false,
      delivered: 0,
      total: targets.length,
      outcomes: [failure('NO_BROADCAST', '投递服务未实现 broadcast：批量投递是硬契约')],
    };
  }

  try {
    const result = await service.broadcast(
      targets.map((target) => ({
        target,
        elements,
        scope: meta.scope,
        dedupeKey: meta.dedupeKeyOf(target),
        retry: meta.retry,
      })),
    );
    const outcomes = result.outcomes ?? [];
    return {
      ok: result.ok,
      delivered: result.deliveredCount ?? outcomes.filter((item) => item.ok && item.skipped === undefined).length,
      total: result.totalCount ?? targets.length,
      outcomes,
    };
  } catch (error) {
    return { ok: false, delivered: 0, total: targets.length, outcomes: [failure('DELIVERY_FAILED', errorMessage(error))] };
  }
}

/** 把 PNG 卡片作为图片元素投递。 */
export async function deliverCardPng(
  ctx: unknown,
  target: DeliveryTargetLike,
  png: Buffer,
  meta: { scope?: string; dedupeKey?: string } = {},
): Promise<DeliveryOutcomeLike> {
  return deliverElements(ctx, target, [h.image(png, 'image/png')], meta);
}
