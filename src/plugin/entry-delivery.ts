/**
 * 词条投递目标规划。
 *
 * 产品决策（2026-11-10）：每轮讨论沉淀出的词条，在**讨论结束后立刻**投递到选定的
 * 群相册；「知识周报」只保留主题，按周定时。
 *
 * 灰度改道：把 `redirectChannelId` 填成一个群号，所有词条卡片改为发到该群聊天
 * （不进相册），用于小范围观察效果；留空即恢复正常相册投递。
 */

/** 一个投递目标（与 `DeliveryTargetLike` 同构的子集）。 */
export type EntryDeliveryTarget =
  | { kind: 'channel'; channelId: string }
  | { kind: 'album'; channelId: string; albumId: string };

/** 相册目标串：`<group_id>/<album_id>`，两侧空白会被裁剪。 */
const ALBUM_PATTERN = /^([^/]+)\/(.+)$/u;

/** 去掉 `onebot:` 之类的平台前缀，只留群号本身，用于跨形态比较。 */
function groupIdOf(channelId: string): string {
  const trimmed = channelId.trim();
  const index = trimmed.lastIndexOf(':');
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function withPlatform(channelId: string): string {
  return channelId.includes(':') ? channelId : `onebot:${channelId}`;
}

/**
 * 计算一次词条投递要发的目标。
 *
 * - `redirectChannelId` 非空：只发该群聊天（灰测改道），相册列表被忽略；
 * - 否则逐个解析 `topicDelivery.albums` 形态的相册目标，非法项丢弃；
 * - 结果按 channelId + albumId 去重，避免同一目标重复投放。
 */
export function planEntryTargets(
  albums: readonly string[],
  redirectChannelId: string,
  sourceChannelId = '',
): EntryDeliveryTarget[] {
  const redirect = redirectChannelId.trim();
  if (redirect !== '') {
    return [{ kind: 'channel', channelId: withPlatform(redirect) }];
  }

  // 词条只投递到**它自己所属群**的相册：albums 是「哪些群允许收卡片」的白名单，
  // 不是「所有词条都发到这里」的广播目标。来源群在名单里才投，其余静默跳过。
  const sourceGroup = groupIdOf(sourceChannelId);
  const targets: EntryDeliveryTarget[] = [];
  const seen = new Set<string>();
  for (const value of albums) {
    const match = ALBUM_PATTERN.exec(value.trim());
    if (match === null) continue;
    const groupId = match[1].trim();
    const albumId = match[2].trim();
    if (groupId === '' || albumId === '') continue;
    if (sourceGroup !== '' && groupIdOf(groupId) !== sourceGroup) continue;
    const key = `${groupId}/${albumId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ kind: 'album', channelId: withPlatform(groupId), albumId });
  }
  return targets;
}
