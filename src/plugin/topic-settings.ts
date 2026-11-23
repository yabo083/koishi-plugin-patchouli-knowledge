/**
 * 主题校准参数的**旧存储**（只读迁移）。
 *
 * 0.8.66 及以前把这块调参面单独落在 `<wikiDir>/.patchouli/topics-settings.json`；
 * 现在统一进 `.patchouli/settings.json` 的 `topics` 段（`src/plugin/settings-store.ts`）。
 * 本模块只剩两件事：字段归一化（面板 POST 复用同一套限幅）与旧文件的一次性读取。
 * 新代码不得再写这个文件——两处真源必然漂移。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import type { TopicConfig } from '../types';
import { resolveWikiLayout } from '../wiki/layout';

export type TopicSettingsPatch = Partial<
  Pick<
    TopicConfig,
    'enabled' | 'hour' | 'minute' | 'lookbackDays' | 'mergeThreshold' | 'minEntries'
  >
>;

/** 可调字段及硬限幅。 */
export const TOPIC_SETTING_LIMITS = {
  hour: [0, 23] as const,
  minute: [0, 59] as const,
  lookbackDays: [1, 90] as const,
  mergeThreshold: [0, 1] as const,
  minEntries: [1, 50] as const,
};

function clampInteger(value: unknown, low: number, high: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(high, Math.max(low, value)));
}

function clampNumber(value: unknown, low: number, high: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(high, Math.max(low, value));
}

/** 归一化补丁：未知字段丢弃，数值夹进硬限幅。 */
export function normalizeTopicSettingsPatch(input: unknown): TopicSettingsPatch {
  if (typeof input !== 'object' || input === null) return {};
  const raw = input as Record<string, unknown>;
  const next: TopicSettingsPatch = {};
  if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled;
  const hour = clampInteger(raw.hour, ...TOPIC_SETTING_LIMITS.hour);
  if (hour !== undefined) next.hour = hour;
  const minute = clampInteger(raw.minute, ...TOPIC_SETTING_LIMITS.minute);
  if (minute !== undefined) next.minute = minute;
  const lookbackDays = clampInteger(raw.lookbackDays, ...TOPIC_SETTING_LIMITS.lookbackDays);
  if (lookbackDays !== undefined) next.lookbackDays = lookbackDays;
  const mergeThreshold = clampNumber(raw.mergeThreshold, ...TOPIC_SETTING_LIMITS.mergeThreshold);
  if (mergeThreshold !== undefined) next.mergeThreshold = mergeThreshold;
  const minEntries = clampInteger(raw.minEntries, ...TOPIC_SETTING_LIMITS.minEntries);
  if (minEntries !== undefined) next.minEntries = minEntries;
  return next;
}

function legacySettingsPath(wikiDir: string): string {
  return nodePath.join(resolveWikiLayout(wikiDir).patchouliDir, 'topics-settings.json');
}

/**
 * 读取旧版运行时覆盖值；文件不存在 / 损坏 / 版本不符一律返回空补丁。
 * 唯一调用点是启动期迁移：`settings.json` 还没有 `topics` 段时把旧值搬过去。
 */
export async function readTopicSettings(wikiDir: string): Promise<TopicSettingsPatch> {
  try {
    const raw = JSON.parse(await fs.readFile(legacySettingsPath(wikiDir), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return {};
    const record = raw as { version?: unknown; settings?: unknown };
    if (record.version !== 1) return {};
    return normalizeTopicSettingsPatch(record.settings);
  } catch {
    return {};
  }
}
