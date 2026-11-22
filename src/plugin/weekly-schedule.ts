/**
 * 知识周报的排程壳：定时能力由 `miyako-delivery` 提供，触发规则（cron 表达式）由本插件配置决定。
 *
 * 这层只做三件事：表达式归一（空白 / 空值回落默认）、字段数前置校验、
 * 把 `scheduleCron` 抛出的解析错误变成一条可读告警，绝不静默吞掉。
 */

import { DEFAULT_WEEKLY_CRON } from '../types';

/** 周报按时区固定 `Asia/Shanghai` 解释，避免宿主 TZ 漂移改变 04:30 的含义。 */
export const WEEKLY_TIME_ZONE = 'Asia/Shanghai';

/** 宿主 `ctx['miyako-delivery']` 的 cron 子集。 */
export interface CronSchedulerLike {
  scheduleCron?: (
    expression: string,
    run: () => void | Promise<void>,
    options?: { timeZone?: string },
  ) => () => void;
}

export interface CronLoggerLike {
  info(message: string): void;
  warn(message: string): void;
}

export interface RegisterWeeklyCronOptions {
  scheduler: CronSchedulerLike | undefined;
  expression: string | undefined;
  run: () => void | Promise<void>;
  logger: CronLoggerLike;
  timeZone?: string;
}

/**
 * 注册知识周报的 cron 任务；返回停止函数，失败返回 `undefined`。
 *
 * 表达式无效时不注册（行为明确可见），而不是悄悄回落到默认值——
 * 静默改期会让用户以为报了错。
 */
export function registerWeeklyCron(options: RegisterWeeklyCronOptions): (() => void) | undefined {
  const { scheduler, run, logger, timeZone = WEEKLY_TIME_ZONE } = options;
  const expression = (options.expression ?? '').trim().replace(/\s+/gu, ' ') || DEFAULT_WEEKLY_CRON;
  if (expression.split(' ').length !== 5) {
    logger.warn(`[Patchouli] 知识周报 cron 表达式无效（${expression}）：需要五段「分 时 日 月 周」，已停止排程`);
    return undefined;
  }
  if (typeof scheduler?.scheduleCron !== 'function') {
    logger.warn('[Patchouli] miyako-delivery 未提供 scheduleCron，知识周报不会自动上传');
    return undefined;
  }
  try {
    const stop = scheduler.scheduleCron(expression, run, { timeZone });
    logger.info(`[Patchouli] 知识周报已排程: ${expression}（${timeZone}）`);
    return stop;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`[Patchouli] 知识周报 cron 表达式无效（${expression}）：${detail}；已停止排程`);
    return undefined;
  }
}
