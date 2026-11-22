/**
 * Patchouli Knowledge - llmwiki 目录布局
 *
 * 与本地 `llmwiki` 仓库的基本架构逐字对齐：
 *  - `raw/`        真理源：`raw/sessions/<entryId>.json` 存放本轮讨论的原始消息 dump，只增不改；
 *  - `wiki/`       编译产物：`wiki/debates/<entryId>.md` 词条正文；
 *  - 根下          `index.md`（导航层，单行索引）/ `log.md`（时间流水，追加式）；
 *  - `.patchouli/` 插件私有仓储：`store.json`（词条元数据 + 各群节奏快照）、
 *                  `discards/`（被判定不沉淀的轮次留证，可开关、有界轮转、懒创建）、
 *                  `scribe/`（主动书记员的追加式录制，懒创建，会话结束即删除）、
 *                  `observability/`（判据持久化，两套触发判据的对照日志，懒创建）。
 *
 * 本模块只负责路径推导与目录创建，不读写任何具体文件内容。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

/** 未配置 `storage.wikiDir` 时的默认子目录（相对 Koishi 实例 baseDir）。 */
export const DEFAULT_WIKI_SUBDIR = 'data/llmwiki';
/** 原始数据（真理源）根目录名。 */
export const RAW_DIR_NAME = 'raw';
/** 编译产物根目录名。 */
export const WIKI_DIR_NAME = 'wiki';
/** 原始会话 dump 子目录（相对 `wikiDir`）。 */
export const RAW_SESSIONS_SUBDIR = 'raw/sessions';
/** 词条子目录（相对 `wikiDir`）。 */
export const WIKI_DEBATES_SUBDIR = 'wiki/debates';
/** 插件私有仓储目录名。 */
export const PATCHOULI_DIR_NAME = '.patchouli';
/** 丢弃轮次留证子目录名（相对 `.patchouli/`）。 */
export const DISCARDS_DIR_NAME = 'discards';
/** 主动书记员追加式录制子目录名（相对 `.patchouli/`）。 */
export const SCRIBE_DIR_NAME = 'scribe';
/** 卡片素材池目录名（相对 `.patchouli/`）：背景图与一言的预取队列。 */
export const MEDIA_DIR_NAME = 'media';
/** 判据持久化目录名（相对 `.patchouli/`）：shadow / potential 对照用的追加式 JSONL（懒创建）。 */
export const OBSERVABILITY_DIR_NAME = 'observability';
/** 首次初始化时生成的管理面密钥文件（相对 `.patchouli/`，仅存服务端）。 */
export const API_TOKEN_FILE_NAME = 'api-token.txt';
/** 管理面会话表（相对 `.patchouli/`）：只存 `sha256(sid)`，重启后登录态不丢。 */
export const SESSIONS_FILE_NAME = 'sessions.json';
export const INDEX_FILE_NAME = 'index.md';
export const LOG_FILE_NAME = 'log.md';
export const STORE_FILE_NAME = 'store.json';
/** 自定义系统提示词文件（相对 `wikiDir`，位于插件私有仓储内）。 */
export const CUSTOM_PROMPT_FILE_NAME = 'custom-prompt.txt';
/** `.patchouli/custom-topic-prompt.txt`：主题聚合专用系统提示词。 */
export const CUSTOM_TOPIC_PROMPT_FILE_NAME = 'custom-topic-prompt.txt';

export interface WikiLayout {
  /** llmwiki 根目录（绝对路径）。 */
  rootDir: string;
  /** `raw/`。 */
  rawDir: string;
  /** `raw/sessions/`：原始会话 dump。 */
  rawSessionsDir: string;
  /** `wiki/`。 */
  wikiDir: string;
  /** `wiki/debates/`：词条 Markdown。 */
  entryDir: string;
  /** `.patchouli/`：插件私有仓储。 */
  patchouliDir: string;
  /** `.patchouli/discards/`：被判定不沉淀的轮次留证（有界保留）。 */
  discardsDir: string;
  /** `.patchouli/scribe/`：主动书记员的追加式录制（`<channelId>.jsonl`，懒创建）。 */
  scribeDir: string;
  /** `.patchouli/media/`：卡片素材池（`image|saying/{pending,used}`，懒创建）。 */
  mediaDir: string;
  /** `.patchouli/observability/`：判据持久化（`shadow-YYYY-MM-DD.jsonl`，懒创建）。 */
  observabilityDir: string;
  /** `.patchouli/api-token.txt`：面板首次初始化生成的管理密钥（配置留空时的来源）。 */
  apiTokenPath: string;
  /** `.patchouli/sessions.json`：管理面会话表（哈希票据 + 到期时间）。 */
  sessionsPath: string;
  indexPath: string;
  logPath: string;
  storePath: string;
  /** `.patchouli/custom-prompt.txt`：悬浮窗设置页保存的自定义系统提示词。 */
  customPromptPath: string;
  /** `.patchouli/custom-topic-prompt.txt`：主题聚合的自定义系统提示词。 */
  customTopicPromptPath: string;
}

/** 由根目录推导完整布局（纯路径运算，不做 I/O）。 */
export function resolveWikiLayout(rootDir: string): WikiLayout {
  const root = nodePath.resolve(rootDir);
  const rawDir = nodePath.join(root, RAW_DIR_NAME);
  const wikiSubDir = nodePath.join(root, WIKI_DIR_NAME);
  const patchouliDir = nodePath.join(root, PATCHOULI_DIR_NAME);
  return {
    rootDir: root,
    rawDir,
    rawSessionsDir: nodePath.join(root, RAW_SESSIONS_SUBDIR),
    wikiDir: wikiSubDir,
    entryDir: nodePath.join(root, WIKI_DEBATES_SUBDIR),
    patchouliDir,
    discardsDir: nodePath.join(patchouliDir, DISCARDS_DIR_NAME),
    scribeDir: nodePath.join(patchouliDir, SCRIBE_DIR_NAME),
    mediaDir: nodePath.join(patchouliDir, MEDIA_DIR_NAME),
    observabilityDir: nodePath.join(patchouliDir, OBSERVABILITY_DIR_NAME),
    apiTokenPath: nodePath.join(patchouliDir, API_TOKEN_FILE_NAME),
    sessionsPath: nodePath.join(patchouliDir, SESSIONS_FILE_NAME),
    indexPath: nodePath.join(root, INDEX_FILE_NAME),
    logPath: nodePath.join(root, LOG_FILE_NAME),
    storePath: nodePath.join(patchouliDir, STORE_FILE_NAME),
    customPromptPath: nodePath.join(patchouliDir, CUSTOM_PROMPT_FILE_NAME),
    customTopicPromptPath: nodePath.join(patchouliDir, CUSTOM_TOPIC_PROMPT_FILE_NAME),
  };
}

/**
 * 创建 llmwiki 完整骨架：`raw/sessions/`、`wiki/debates/`、`.patchouli/`。
 * `mkdir -p` 语义，幂等；已存在的目录不会被清理或改写。
 *
 * `.patchouli/discards/` 与 `.patchouli/scribe/` **不在这里创建**：前者是可关闭的排障能力，
 * 后者只在真正录制时才有内容；都由各自的写入方懒创建，关闭 / 未使用的实例不留空目录。
 */
export async function ensureWikiLayout(rootDir: string): Promise<WikiLayout> {
  const layout = resolveWikiLayout(rootDir);
  await Promise.all([
    fs.mkdir(layout.rawSessionsDir, { recursive: true }),
    fs.mkdir(layout.entryDir, { recursive: true }),
    fs.mkdir(layout.patchouliDir, { recursive: true }),
  ]);
  return layout;
}
