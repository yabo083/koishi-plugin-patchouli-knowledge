/**
 * 同源媒体代理的 opaqueId 登记表。
 *
 * 只登记「本插件当前缓存的最新消息里实际出现过的媒体 URL」：
 *   - 写入点唯一——`PatchouliKnowledgeSystem.recordLatestMessage()`（消息被接受的路径）；
 *   - opaqueId 按 **(频道, URL)** 派生：不同群引用同一张图各自持有独立 id，
 *     某群消息被新消息覆盖时只失效该群自己的 id，绝不会误删他群仍在引用的地址；
 *   - 容量上限内按插入顺序淘汰最旧条目，`dispose()` 全清。
 * 因此 `GET <base>/api/media/:id` 无法被用来代理任意 URL，也无法枚举未收到的资源。
 */

import { createHash } from 'node:crypto';
import { RICH_MEDIA_REGISTRY_CAPACITY } from '../types';
import { sanitizeMediaUrl } from './rich-message';

/** opaqueId 形态：sha1(channelId + NUL + URL) 的前 32 位小写 hex。 */
export const MEDIA_ID_PATTERN = /^[a-f0-9]{32}$/;

/** 由（频道, 已通过安全校验的媒体 URL）推导稳定的 opaqueId。 */
export function createMediaId(channelId: string, url: string): string {
  return createHash('sha1').update(`${channelId}\u0000${url}`).digest('hex').slice(0, 32);
}

export class MediaRegistry {
  private readonly entries = new Map<string, { url: string; channelId: string }>();
  private readonly byChannel = new Map<string, Set<string>>();

  constructor(private readonly capacity: number = RICH_MEDIA_REGISTRY_CAPACITY) {}

  public get size(): number {
    return this.entries.size;
  }

  /** 登记单个 URL（非公网 http(s) 一律拒绝）；返回其 opaqueId。 */
  public register(channelId: string, url: string): string | undefined {
    const safe = sanitizeMediaUrl(url);
    if (!safe) return undefined;
    const id = createMediaId(channelId, safe);
    if (!this.entries.has(id)) this.entries.set(id, { url: safe, channelId });
    let ids = this.byChannel.get(channelId);
    if (!ids) {
      ids = new Set<string>();
      this.byChannel.set(channelId, ids);
    }
    ids.add(id);
    this.prune();
    return id;
  }

  /**
   * 用某群当前缓存消息的媒体 URL **覆盖**该群的登记（该群旧条目立即失效）。
   * 这是唯一的批量写入入口，保证登记表始终与缓存消息一一对应；他群条目不受影响。
   */
  public setChannelMedia(channelId: string, urls: readonly string[]): void {
    this.clearChannel(channelId);
    for (const url of urls) this.register(channelId, url);
  }

  /** 仅在 (频道, URL) 当前仍被登记时返回其 opaqueId（供 API 层改写为代理地址）。 */
  public idFor(channelId: string, url: string): string | undefined {
    const safe = sanitizeMediaUrl(url);
    if (!safe) return undefined;
    const id = createMediaId(channelId, safe);
    const entry = this.entries.get(id);
    return entry && entry.url === safe && entry.channelId === channelId ? id : undefined;
  }

  /** opaqueId → 媒体 URL（未登记/已失效返回 `undefined`）。 */
  public resolve(id: string): string | undefined {
    if (!MEDIA_ID_PATTERN.test(id)) return undefined;
    return this.entries.get(id)?.url;
  }

  public clearChannel(channelId: string): void {
    const ids = this.byChannel.get(channelId);
    if (!ids) return;
    for (const id of ids) this.entries.delete(id);
    this.byChannel.delete(channelId);
  }

  public clear(): void {
    this.entries.clear();
    this.byChannel.clear();
  }

  /** 容量裁剪：按插入顺序淘汰最旧条目，并同步清理所属频道的索引。 */
  private prune(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      const id = oldest.value;
      const entry = this.entries.get(id);
      this.entries.delete(id);
      if (!entry) continue;
      const ids = this.byChannel.get(entry.channelId);
      if (!ids) continue;
      ids.delete(id);
      if (ids.size === 0) this.byChannel.delete(entry.channelId);
    }
  }
}
