/**
 * 词条长图的统一出图管线。
 *
 * 管理面导出与灰度投递共用这一条路径：读词条 → 脱敏投影 → 从素材池取背景图 /
 * 一言 → 分配卡片序号 → 渲染 JPEG。放在这里是为了避免两处各写一份而漂移。
 */

import { createMasker, maskPublicView, type Masker } from '../wiki/mask';
import { toPublicView, type PublicWikiView } from '../wiki/public-view';
import type { WikiEntryRecord } from '../wiki/storage';
import type { CardSequence } from '../media/card-sequence';
import type { MediaPool } from '../media/pool';
import { hasRenderService, renderEntryLongImageJpeg } from './card';

/** 出图需要的最小宿主面（`PatchouliKnowledgeSystem` 满足）。 */
export interface CardPipelineHost {
  localStore: { getEntry: (id: string) => Promise<WikiEntryRecord | undefined> };
  wikiEngine: {
    readEntry: (id: string) => Promise<string | undefined>;
    readSessionDump?: (id: string) => Promise<string | undefined>;
  };
  media: Pick<MediaPool, 'take'>;
  cardSequence: Pick<CardSequence, 'allocate'>;
}

/**
 * 从 `raw/sessions/<id>.json` 里取全部发言人昵称。
 *
 * `record.participants` 是模型归纳出来的名单，会漏人；原始会话的 `userName`
 * 才是权威来源（每条消息都带）。解析失败一律返回空数组——出图不能因此失败。
 */
export function collectSessionNames(dump: string | undefined): string[] {
  if (dump === undefined || dump.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(dump);
  } catch {
    return [];
  }
  const messages = (parsed as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  const names = new Set<string>();
  for (const message of messages) {
    const raw = (message as { userName?: unknown } | null)?.userName;
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name !== '') names.add(name);
  }
  return [...names];
}

/** 出图结果：要么是图片，要么是可判定的失败原因（调用方各自映射到 HTTP / 日志）。 */
export type EntryCardResult =
  | { kind: 'image'; image: Buffer; view: PublicWikiView }
  | { kind: 'empty-id' }
  | { kind: 'not-found' }
  | { kind: 'no-puppeteer' };

/**
 * 渲染一篇词条的长图。
 *
 * 一切失败都收敛成结果枚举，绝不抛：HTTP 路由映射到 400/404/503，灰度投递只记日志。
 */
export async function renderEntryCard(
  ctx: unknown,
  host: CardPipelineHost,
  id: string,
  options: {
    /** 复用同一份昵称映射；仅在脱敏开启时有效。 */
    masker?: Masker;
    /** 是否脱敏（面板「图片匿名化」开关，默认开启）。关闭时按会话原文昵称出图。 */
    maskNames?: boolean;
  } = {},
): Promise<EntryCardResult> {
  const trimmed = id.trim();
  if (trimmed.length === 0) return { kind: 'empty-id' };

  const record = await host.localStore.getEntry(trimmed);
  if (record === undefined) return { kind: 'not-found' };

  const markdown = (await host.wikiEngine.readEntry(trimmed)) ?? '';
  // 真名清单 = record.participants ∪ 原始会话里的全部 userName：
  // PublicWikiView 契约不携带参与者，模型归纳的 participants 又会漏人（MASK-07/09 回归），
  // 原始 dump 的 sender 是唯一权威来源。
  const dump = await host.wikiEngine.readSessionDump?.(trimmed);
  const extraNames = [...record.participants, ...collectSessionNames(dump)];
  const view = toPublicView(record, markdown);
  let cardView = view;
  // 正文 chip 渲染需要一份**与视图同形态**的名单：脱敏开启时是假名，关闭时是真名——
  // 视图契约不携带参与者，只在综述里被提到的群友否则会退化成纯文本。
  let knownNames = extraNames;
  if (options.maskNames !== false) {
    const masker = options.masker ?? createMasker();
    cardView = maskPublicView(view, masker, extraNames);
    knownNames = extraNames.map((name) => masker.maskName(name));
  }
  // 先确认宿主能出图，再领卡号、取素材：没有 renderer 时这两步都是白耗。
  if (!hasRenderService(ctx)) return { kind: 'no-puppeteer' };
  const [backdrop, saying, index] = await Promise.all([
    host.media.take('image'),
    host.media.take('saying'),
    // 序号按**词条所属群**独立计数：改道投递不改号，同一群内从 1 递增。
    host.cardSequence.allocate(cardView.id, record.channelId),
  ]);
  const image = await renderEntryLongImageJpeg(ctx, cardView, {
    masked: false,
    backdrop,
    saying,
    index,
    knownNames,
  });
  if (image === null) return { kind: 'no-puppeteer' };
  return { kind: 'image', image, view: cardView };
}
