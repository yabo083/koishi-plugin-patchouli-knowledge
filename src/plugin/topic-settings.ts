/**
 * 主题校准运行时参数的持久化。
 *
 * 这些是「多久回看、多严才合并」的产品旋钮，允许在阅读面板里即时调整；
 * 与凭据/模型路由等部署面配置分开存放，避免 WebUI 触碰 `koishi.yml`。
 * 文件：`<wikiDir>/.patchouli/topics-settings.json`（只存可调子集）。
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

export interface TopicSettingsFile {
  version: 1;
  settings: TopicSettingsPatch;
}

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

function settingsPath(wikiDir: string): string {
  return nodePath.join(resolveWikiLayout(wikiDir).patchouliDir, 'topics-settings.json');
}

/** 读取运行时覆盖值；文件不存在 / 损坏一律返回空补丁（沿用 koishi.yml 配置）。 */
export async function readTopicSettings(wikiDir: string): Promise<TopicSettingsPatch> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(wikiDir), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return {};
    const record = raw as { version?: unknown; settings?: unknown };
    if (record.version !== 1) return {};
    return normalizeTopicSettingsPatch(record.settings);
  } catch {
    return {};
  }
}

/** 原子写入运行时覆盖值。 */
export async function writeTopicSettings(wikiDir: string, settings: TopicSettingsPatch): Promise<void> {
  const target = settingsPath(wikiDir);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const document: TopicSettingsFile = { version: 1, settings };
  await fs.mkdir(nodePath.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}
