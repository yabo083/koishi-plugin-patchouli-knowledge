/**
 * 词条出图选项的持久化（面板可调，不写进 `koishi.yml`）。
 *
 * 目前只有一项：**图片匿名化**——开启时出图前把全部昵称替换成假名
 * （`maskPublicView`），关闭时按会话原文的昵称出图。默认开启：卡片会被投递到
 * 群相册，脱敏是安全默认值，关闭必须是显式动作。
 *
 * 文件：`<wikiDir>/.patchouli/card-settings.json`（只存可调子集，与凭据/路由分离）。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { resolveWikiLayout } from '../wiki/layout';

export interface CardSettings {
  /** 出图前是否脱敏昵称；`false` = 原样输出真实昵称。 */
  maskNames: boolean;
}

export const CARD_SETTINGS_DEFAULT: Readonly<CardSettings> = Object.freeze({ maskNames: true });

interface CardSettingsFile {
  version: 1;
  settings: Partial<CardSettings>;
}

/** 归一化：只认已知布尔字段，未知值一律丢弃（不猜意图）。 */
export function normalizeCardSettingsPatch(input: unknown): Partial<CardSettings> {
  if (typeof input !== 'object' || input === null) return {};
  const raw = input as Record<string, unknown>;
  const next: Partial<CardSettings> = {};
  if (typeof raw.maskNames === 'boolean') next.maskNames = raw.maskNames;
  return next;
}

/** 读取持久化选项；文件缺失 / 损坏 / 版本不符一律退回默认值。 */
export async function readCardSettings(wikiDir: string): Promise<CardSettings> {
  try {
    const file = nodePath.join(resolveWikiLayout(wikiDir).patchouliDir, 'card-settings.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return { ...CARD_SETTINGS_DEFAULT };
    const record = raw as { version?: unknown; settings?: unknown };
    if (record.version !== 1) return { ...CARD_SETTINGS_DEFAULT };
    return { ...CARD_SETTINGS_DEFAULT, ...normalizeCardSettingsPatch(record.settings) };
  } catch {
    return { ...CARD_SETTINGS_DEFAULT };
  }
}

/** 原子写入：临时文件 + rename，进程中断不会留下半截配置。 */
export async function writeCardSettings(wikiDir: string, settings: CardSettings): Promise<void> {
  const target = nodePath.join(resolveWikiLayout(wikiDir).patchouliDir, 'card-settings.json');
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const document: CardSettingsFile = { version: 1, settings };
  await fs.mkdir(nodePath.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}
