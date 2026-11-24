import { promises as fs, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import { Context, Schema, Session, h } from 'koishi';
import type {
  CadenceStateSnapshot,
  ChatMessage,
  ChatLunaInvoker,
  DiscussionSession,
  DispatcherConfig,
  LatestMessage,
  PatchouliFeatureToggles,
  PatchouliPluginConfig,
  RichMessageElement,
  SubscriptionRow,
  TrafficPoint,
  TriggerOptions,
  TuningSnapshot,
  WikiStorageConfig,
} from '../types';
import {
  DEFAULT_WEEKLY_CRON,
  LATEST_MESSAGE_MAX_CHARS,
  MAX_INBOUND_CONTENT_CHARS,
  TRAFFIC_CAPACITY,
  TRAFFIC_SAMPLE_MS,
} from '../types';
import type { DispatcherResult } from '../types';
import { clampCodePoints } from '../trigger/filter';
import {
  ALBUM_SCHEMA_KEY,
  MAX_PROBE_GROUPS,
  albumSchemaUnion,
  albumUnionItems,
  channelGroupIds,
  installTargetTables,
  listBotGroupIds,
  mergeAlbumCandidates,
  probeGroupAlbums,
  readAlbumCache,
  resolveTargetBindings,
  scopeAlbumCandidates,
  startupTargetValues,
  subscriptionTargetsSchema,
  writeAlbumCache,
  type AlbumBot,
  type AlbumCandidate,
  type AlbumServiceLike,
  type StartupTargetOptions,
  type StartupTargetValues,
} from './albums';
import { registerWeeklyCron, type CronSchedulerLike } from './weekly-schedule';
import { planWeeklyAlbumSources, runWeeklyAlbumDelivery } from './weekly-album';
import { MediaRegistry } from './media-registry';
import {
  persistCustomPrompt,
  persistTopicPrompt,
  readCustomPromptFile,
  readTopicPromptFile,
  writeTopicPromptFile,
} from './custom-prompt';
import {
  readSettingsOverrides,
  readSettingsOverridesSync,
  readSubscriptionOverride,
  readSubscriptionOverrideSync,
  readTargetBindingMigration,
  readTargetBindings,
  readTargetBindingsSync,
  readTargetPolicies,
  validateMergedSettings,
  validateSettingsPatch,
  writeSettingsOverrides,
  writeSubscriptionOverride,
  writeTargetBindings,
  redactSettingsSection,
  SETTINGS_META,
  SETTINGS_SECTIONS,
  SettingsConflictError,
  type SettingsBaseSections,
  type SettingsOverrides,
  type SettingsRepairContext,
  type SettingsSection,
  type SettingsSectionPatch,
  type SettingsValue,
} from './settings-store';
import {
  CARD_SETTINGS_DEFAULT,
  normalizeCardSettingsPatch,
  readCardSettings,
  writeCardSettings,
  type CardSettings,
} from './card-settings';
import { normalizeTopicSettingsPatch, readTopicSettings } from './topic-settings';
import { resolveTopicSystemPrompt } from '../dispatcher/prompts';
import { TopicCurator, type TopicRunResult } from '../wiki/topics';
import { renderWeeklyAlbumSummaryPng } from './card';
import { deliverElements } from './delivery';
import { DeliveryGate, createBroadcastDeliver } from './delivery-gate';
import { DeliveryStateStore, deliveryStatePath } from './delivery-state';
import { maskPublicView } from '../wiki/mask';
import { toPublicView } from '../wiki/public-view';
import { TopicScheduler } from './topic-scheduler';

const WEEK_MS = 7 * 86_400_000;
import {
  collectMediaUrls,
  freezeElements,
  parseRichElements,
  redactUrls,
  textFallbackElements,
  type RichMessageContext,
} from './rich-message';
import type { DispatcherRuntimeOptions } from '../dispatcher/dispatcher';
import {
  BurstQuiescenceDetector,
  DEFAULT_TRIGGER_OPTIONS,
  MANUAL_SESSION_MIN_MESSAGES,
  POTENTIAL_SEEDING,
} from '../trigger/detector';
import {
  DEFAULT_TUNING_PARAMETERS,
  HIGH_QUALITY_THRESHOLD,
  TUNING_DECAY_FACTOR,
  TUNING_LIMITS,
  updateParameters,
  type TuningSignal,
  type TuningTarget,
} from '../trigger/tuning';
import { ModelDispatcher, normalizeDispatcherProvider, resolveDispatcherModels } from '../dispatcher/dispatcher';
import { formatDate, WikiEngine } from '../wiki/engine';
import { LocalStore } from '../wiki/storage';
import type { WikiEntryRecord } from '../wiki/storage';
import { DEFAULT_WIKI_SUBDIR, ensureWikiLayout, resolveWikiLayout } from '../wiki/layout';
import { saveDiscardDump } from '../wiki/discard-dump';
import type { DiscardVerdict } from '../wiki/discard-dump';
import { ScribeStore, isScribeAdmin, restoreScribeSessions, scribeScopeRefusal } from './scribe';
import { registerWebUi } from '../web/api';
import { attachTelemetry } from '../telemetry/inspector';
import { ShadowLedger } from '../telemetry/shadow-ledger';
import type { PatchouliInspector } from '../telemetry/inspector';
import { CardSequence, cardSequencePath } from '../media/card-sequence';
import { collectSessionNames, renderEntryCard } from './card-pipeline';
import { planEntryTargets, type EntryDeliveryTarget } from './entry-delivery';
import {
  ALBUM_TARGET_PATTERN,
  CHAT_TARGET,
  bareChannelId,
  compileSubscriptions,
  entryTargetsFor,
  formatSubscriptionLogLines,
  installSubscriptionTargetWarnings,
  isListening,
  isTargetGroupHeader,
  listeningGroupIds,
  normalizeSubscriptionRows,
  projectLegacySubscriptionRows,
  resolveRows,
  validateSubscriptionRows,
  type SubscriptionSnapshot,
} from './subscriptions';
import { MediaPool } from '../media/pool';
import { JudgeClient } from '../judge/client';
import type { JudgeOptions } from '../judge/client';
import { BoundaryAnnotator, PreDispatchGate, LOW_DENSITY_REASON } from '../judge/gate';

/**
 * 自定义系统提示词的持久化读写（`<wikiDir>/.patchouli/custom-prompt.txt`）：
 * 实现位于 `./custom-prompt`，这里从插件公共面导出，
 * 供 `web/api.ts`（悬浮窗设置页保存 / 恢复默认）与测试直接复用。
 */
export {
  persistCustomPrompt,
  persistTopicPrompt,
  readCustomPromptFile,
  readTopicPromptFile,
  resolveCustomPromptPath,
  resolveTopicPromptPath,
  writeCustomPromptFile,
  writeTopicPromptFile,
} from './custom-prompt';
export {
  TOPIC_SETTING_LIMITS,
  normalizeTopicSettingsPatch,
  readTopicSettings,
  type TopicSettingsPatch,
} from './topic-settings';
export {
  MAX_TARGET_BINDINGS,
  SETTINGS_META,
  SETTINGS_SECRET_KEYS,
  SETTINGS_SECTIONS,
  SettingsConflictError,
  readSettingsOverrides,
  readSettingsOverridesSync,
  readSubscriptionOverride,
  readSubscriptionOverrideSync,
  readTargetBindings,
  readTargetBindingsSync,
  readTargetPolicies,
  redactSettingsSection,
  sanitizeTargetBindings,
  settingsPath,
  validateMergedSettings,
  validateSettingsPatch,
  writeSettingsOverrides,
  writeSubscriptionOverride,
  writeTargetBindings,
  type SettingsBaseSections,
  type SettingsFieldMeta,
  type SettingsOverrides,
  type SettingsRepairContext,
  type SettingsSection,
  type SettingsSectionPatch,
} from './settings-store';

export const name = 'patchouli-knowledge';

/**
 * 解析 llmwiki 根目录。
 *
 * - 绝对路径：原样使用（运维可把知识库挂到任意卷）；
 * - 相对路径：**一律锚定 Koishi 实例的 `ctx.baseDir`**，而不是进程 cwd——
 *   否则 systemd / pm2 之类以 `/` 或任意目录启动宿主时会落到意料之外的位置；
 * - 留空：默认 `<baseDir>/data/llmwiki`，即 Koishi 实例自己的 data 目录。
 */
export function resolveWikiDir(configured: string | undefined, baseDir?: string): string {
  const anchor = typeof baseDir === 'string' && baseDir.trim() !== '' ? baseDir.trim() : process.cwd();
  const raw = typeof configured === 'string' ? configured.trim() : '';
  return resolvePath(anchor, raw.length > 0 ? raw : DEFAULT_WIKI_SUBDIR);
}

interface ChatLunaChatModelInstance {
  invoke(messages: unknown[]): Promise<{ content: unknown }>;
}

interface ChatLunaInvocationResponse {
  ok: boolean;
  reply?: string;
  message?: { content?: unknown };
}

interface ChatLunaHostService {
  createChatModel?(modelName: string): Promise<{ value?: ChatLunaChatModelInstance }>;
  invoke?(input: { message: string; model?: string; persist?: boolean; delivery?: string }): Promise<ChatLunaInvocationResponse>;
  /** 等待平台客户端（模型清单）加载完成；ChatLuna 1.4+ 提供 */
  awaitLoadPlatform?(platformName: string, timeout?: number): Promise<void>;
  /** ChatLuna 插件配置（`defaultModel` 即平台当前默认模型） */
  config?: { defaultModel?: unknown };
  currentConfig?: { defaultModel?: unknown };
}

/**
 * 解析本次实际请求的模型标识：显式配置优先；留空或「无」（下拉里的不指定值）时继承
 * ChatLuna 平台的当前默认模型（`config.defaultModel`）。因此 ChatLuna 模式下既不需要
 * 配置模型名，也不需要 apiKey / baseURL。
 */
function resolveChatLunaModel(host: ChatLunaHostService, configured?: string): string | undefined {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit.length > 0 && explicit !== CHATLUNA_MODEL_INHERIT) return explicit;
  for (const cfg of [host.config, host.currentConfig]) {
    const candidate = cfg?.defaultModel;
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

function getChatLunaHost(ctx: Context): ChatLunaHostService | undefined {
  const rawCtx = ctx as unknown;
  if (typeof rawCtx === 'object' && rawCtx !== null && 'chatluna' in rawCtx) {
    const candidate = rawCtx.chatluna;
    if (typeof candidate === 'object' && candidate !== null) {
      return candidate as ChatLunaHostService;
    }
  }
  return undefined;
}

interface LangChainMessageCtor {
  new (content: string): unknown;
}

interface LangChainMessagesModule {
  HumanMessage: LangChainMessageCtor;
  SystemMessage: LangChainMessageCtor;
}

/**
 * ChatLuna 的 `ChatLunaChatModel.invoke()` 直接走 LangChain BaseChatModel，
 * 传入的字面量对象缺少 `getType()` / `additional_kwargs`，会在推理时抛错。
 * 因此优先复用 Koishi 实例内的 `@langchain/core` 构造真实消息；解析失败时退回 duck-typed 对象。
 */
function loadLangChainMessages(baseDir?: string): LangChainMessagesModule | undefined {
  const anchors = [baseDir, process.cwd()].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  for (const anchor of anchors) {
    try {
      const requireFrom = createRequire(joinPath(anchor, 'noop.js'));
      const mod = requireFrom('@langchain/core/messages') as Partial<LangChainMessagesModule> | undefined;
      if (mod && typeof mod.HumanMessage === 'function' && typeof mod.SystemMessage === 'function') {
        return { HumanMessage: mod.HumanMessage, SystemMessage: mod.SystemMessage };
      }
    } catch {
      // 该锚点下没有 @langchain/core，继续尝试下一个
    }
  }
  return undefined;
}

function toLangChainMessages(
  messages: Array<{ role: string; content: string }>,
  baseDir?: string,
): unknown[] {
  const langchain = loadLangChainMessages(baseDir);
  if (langchain) {
    return messages.map((message) =>
      message.role === 'system' ? new langchain.SystemMessage(message.content) : new langchain.HumanMessage(message.content),
    );
  }
  return messages.map((message) => {
    const type = message.role === 'system' ? 'system' : 'human';
    return {
      role: message.role,
      content: message.content,
      getType: () => type,
      _getType: () => type,
    };
  });
}

export type PluginOptions = PatchouliPluginConfig;

/**
 * `system.settings(section)` 的返回类型表：与 `SETTINGS_SECTIONS` 的键一一对应。
 *
 * 五段都是「合并后的完整对象」（覆盖层 > config > Schema 默认值），
 * `judge` 在 Schema 里是可选段，这里按已补齐的完整对象暴露。
 */
export interface PatchouliSettingsValues {
  trigger: PluginOptions['trigger'];
  topics: PluginOptions['topics'];
  media: PluginOptions['media'];
  query: PluginOptions['query'];
  judge: NonNullable<PluginOptions['judge']>;
}

/**
 * 裁判配置的运行时归一化：入参是**合并后**的 `judge` 段（覆盖层 > config > Schema 默认值）。
 *
 * 按外部数据对待（`unknown` + 逐字段类型守卫）：`enabled` / `baseURL` / `apiKey` 等缺失或类型
 * 不对时一律丢弃，由 `JudgeClient` 回落 `DEFAULT_JUDGE_OPTIONS`（`enabled: false`）——
 * 非法配置不会把服务拖进半开状态。
 */
function readJudgeOptions(section: unknown): Partial<JudgeOptions> {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return {};
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(section)) record[key] = value;
  const options: Partial<JudgeOptions> = {};
  if (typeof record.enabled === 'boolean') options.enabled = record.enabled;
  if (typeof record.baseURL === 'string') options.baseURL = record.baseURL;
  if (typeof record.apiKey === 'string') options.apiKey = record.apiKey;
  if (typeof record.model === 'string') options.model = record.model;
  if (typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)) {
    options.timeoutMs = record.timeoutMs;
  }
  return options;
}

/**
 * 非文本 Koishi 元素 → 纯文本占位提示。
 *
 * 预览只服务于监控页只读横条，因此不追求元素语义完整还原：图片 / 语音 / 表情等
 * 一律降级为 `[图片]` 之类可读提示，而不是把原始 markup（含超长图片 URL）甩给前端。
 */
const MESSAGE_ELEMENT_HINTS: Record<string, string> = {
  img: '[图片]',
  image: '[图片]',
  face: '[表情]',
  emoji: '[表情]',
  audio: '[语音]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  quote: '[引用]',
  message: '[合并转发]',
  br: ' ',
  p: ' ',
};

/** 单个 Koishi 元素标签：`<tag attr="…"/>`、`<tag attr="…">` 或闭合标签 `</tag>`。 */
const MESSAGE_ELEMENT_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gu;
const MESSAGE_ATTR = (attrs: string, name: string): string | undefined => {
  const matched = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u').exec(attrs);
  return matched ? (matched[1] ?? matched[2]) : undefined;
};

/** `@` 元素 → `@名字` / `@全体成员`（无名字时退化为裸 `@`）。 */
function messageAtHint(attrs: string): string {
  const name = MESSAGE_ATTR(attrs, 'name')?.trim();
  if (name) return `@${name}`;
  const type = MESSAGE_ATTR(attrs, 'type')?.trim();
  if (type === 'all') return '@全体成员';
  if (type === 'here') return '@在线成员';
  return '@';
}

/** Koishi markup 文本里的实体反转义（`&lt;` 等），顺序上 `&amp;` 必须最后处理。 */
function unescapeMessageText(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&');
}

/**
 * 把 `ChatMessage.content`（Koishi 文本 markup）压成单行纯文本预览。
 *
 * 仅做字符串剥离，不引入 markup 解析器：元素替换为占位提示、其余标签直接去掉、
 * 实体反转义、连续空白折叠为单个空格，最后按码点截断到 `LATEST_MESSAGE_MAX_CHARS`
 * 字符（超长时以 `…` 收尾，保证结果不超过上限）。
 */
export function toMessagePreview(content: string, maxChars: number = LATEST_MESSAGE_MAX_CHARS): string {
  if (typeof content !== 'string' || content.length === 0) return '';
  const stripped = content.replace(MESSAGE_ELEMENT_TAG, (match, tag: string, attrs: string) => {
    // 闭合标签只剥除、不重复产出占位提示（`</img>` 不得再补一个 `[图片]`）。
    if (match.startsWith('</')) return '';
    const name = tag.toLowerCase();
    if (name === 'at') return messageAtHint(attrs);
    return MESSAGE_ELEMENT_HINTS[name] ?? '';
  });
  const text = unescapeMessageText(stripped).replace(/\s+/gu, ' ').trim();
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.trunc(maxChars)) : LATEST_MESSAGE_MAX_CHARS;
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return chars.slice(0, limit - 1).join('') + '…';
}

interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface ConsoleEntryHandle {
  id: string;
}

interface ConsoleService {
  addEntry(files: string): ConsoleEntryHandle;
  config?: { uiPath?: string };
}

/**
 * 将「不动的大图书馆」LLMWiki 知识阅读器作为 Console 下属组件注入。
 *
 * @koishijs/plugin-console 的静态服务会对 `@plugin-<entry>/index.js` 请求做越权校验：
 * `if (!filename.startsWith(root) && !filename.includes('node_modules')) return ctx.status = 403`
 * （见 plugin-console/lib/node/index.js）。因此 `addEntry` 必须收到**绝对路径**，
 * 且该路径必须落在 Koishi 实例根目录或 node_modules 之内，否则前端必然 403。
 *
 * 编译产物位于 `<pkg>/lib/plugin/index.js`，故 `../../client/dist` 即包内的客户端产物目录；
 * 以依赖方式安装时它天然位于 `.../node_modules/koishi-plugin-patchouli-knowledge/client/dist`。
 */
export function registerConsoleEntry(ctx: Context, logger: PluginLogger): void {
  // Koishi 的 Context 类型未声明 console 服务（由 @koishijs/plugin-console 以依赖注入方式提供），
  // 这里把插件上下文窄化为可选的 console 服务契约，并在使用前做运行时存在性校验。
  const consoleHost = ctx as unknown as { console?: ConsoleService };
  const consoleService = consoleHost.console;
  if (!consoleService || typeof consoleService.addEntry !== 'function') {
    return;
  }

  const entryDir = joinPath(__dirname, '..', '..', 'client', 'dist');
  const entryFile = joinPath(entryDir, 'index.js');
  if (!existsSync(entryFile)) {
    logger.warn(`[Patchouli] 未找到 Console 阅读器产物，跳过注入: ${entryFile}`);
    return;
  }

  if (!entryDir.replace(/\\/g, '/').includes('node_modules')) {
    logger.warn(
      `[Patchouli] Console 组件目录不在 node_modules 内 (${entryDir})，plugin-console 的静态服务会以 403 拒绝该资源，请以依赖方式安装本插件`
    );
  }

  const handle = consoleService.addEntry(entryDir);
  const uiPath = (consoleService.config?.uiPath ?? '/plugins').replace(/\/+$/, '');
  logger.info(`[Patchouli] LLMWiki 阅读器 Console 组件已挂载: ${uiPath}/@plugin-${handle.id}/index.js`);
}

/** ChatLuna 模型下拉的「不指定」值：与 ChatLuna 自身 `defaultModel` 的默认值同字面。 */
export const CHATLUNA_MODEL_INHERIT = '无';

/**
 * 大模型调度器配置（条件表单）。
 *
 * provider 二值，两个分支各有**自己的**模型键（早期版本共用一个 `model`，控制台切 provider
 * 时两个字段会互相覆盖，把 ChatLuna 的 `<platform>/<model>` 当成端点模型名发出去）：
 * - `chatluna`：继承 ChatLuna 平台的凭据与适配器，下面**只有一个模型下拉框** `chatlunaModel`——
 *   候选项由 ChatLuna 注册的 `model` 动态 Schema 提供（与 livingmemory 的 `mainModel` 同源）；
 *   选「无」= 继承平台默认模型。
 * - `custom`：自定义端点，填 baseURL + API Key + `customModel`；协议自动探测
 *   （Responses → Gemini 原生 → Chat Completions），无需手选。
 *
 * 结构是 schemastery 的条件渲染写法：`intersect([判别字段, union([各分支])])`，
 * 分支用 `Schema.const(<provider>)` 认领自己的值。两条硬约束（控制台实测）：
 * 1. 首个分支（chatluna）**不能**加 `.required()`——provider 等于公共默认值时控制台会把
 *    该键从表单值里省略，required 让分支判为不匹配、塌成空白并把配置存成 `{}`；
 * 2. 其余分支必须 `.required()`——缺省时 const 在不匹配时不报错，union 会在第一个分支上
 *    就地成功，写回时 `provider` 被公共默认值覆盖（旧版踩过的坑）。
 *
 * 历史值 `auto` / `standalone` 不再出现在下拉里；运行时仍把它们归一化为
 * `chatluna` / `custom`（`normalizeDispatcherProvider`）。旧配置打开表单重选一次即被改写。
 * 旧单键 `model` 仍被声明为隐藏项（否则旧配置过不了 Schema 校验），由
 * `resolveDispatcherModels` 只回填当前通道，绝不跨通道复制。
 * 系统提示词固定使用内置最高品质的帕秋莉提示词，需要改动就去悬浮窗设置页
 * （`POST <base>/api/prompt`），控制台配置表单不提供任何提示词项。
 */
const dispatcherCommonFields = () => ({
  temperature: Schema.number().default(0.3).description('模型采样温度。').hidden(),
  maxTokens: Schema.number().default(6000).description('单次总结最大生成 Token 数。').hidden(),
  enableAutoTuning: Schema.boolean().default(true).description('允许调度器自动微调触发参数。').hidden(),
});

/** custom 分支的端点字段：ChatLuna 通道下这些键不渲染、也不被读取。 */
const dispatcherCustomFields = () => ({
  baseURL: Schema.string()
    .default('https://api.openai.com/v1')
    .description('接口根地址，支持 OpenAI 或 Gemini 协议。'),
  apiKey: Schema.string().role('secret').default('').description('API 密钥，绝不入日志，勿与阅读面板密钥混用。'),
  customModel: Schema.string().default('').description('端点模型名，如 gpt-5 或 deepseek-chat。'),
  protocol: Schema.union(['auto', 'responses', 'gemini', 'chat-completions'] as const)
    .default('auto')
    .hidden()
    .description('端点协议，默认 auto 自动探测。'),
  responseFormat: Schema.union(['json_object', 'structured', 'text'] as const)
    .default('json_object')
    .hidden()
    .description('模型输出格式，默认 json_object。'),
  contractRetries: Schema.number()
    .min(0)
    .max(3)
    .step(1)
    .default(1)
    .hidden()
    .description('格式校验未通过时的追加重试次数。'),
});

const dispatcherSchema = Schema.intersect([
  Schema.object({
    provider: Schema.union([
      Schema.const('chatluna').description('ChatLuna（继承平台配置）'),
      Schema.const('custom').description('自定义端点（须填 baseURL 与模型名）'),
      // 旧配置里的 `auto` / `standalone`：留在枚举里才能通过配置校验（`.hidden()` 使其不进下拉），
      // 由下面的历史分支认领并原样保留，运行时归一化为 chatluna / custom。
      Schema.const('standalone').hidden(),
      Schema.const('auto').hidden(),
    ])
      .default('chatluna')
      .description('custom 须填 baseURL 与模型名；chatluna 继承平台。'),
    // 0.8.43 及以前的单键：同一份值既当 ChatLuna 模型 id 又当端点模型名，控制台切 provider
    // 即互相覆盖。保留声明只为让旧配置过 Schema 校验（不渲染、不可编辑），
    // 运行时由 `resolveDispatcherModels` 只回填**当前**通道。
    model: Schema.string().default('').hidden().description('旧版模型配置，仅用于向下兼容。'),
  })
    // 分区标题挂在这个元素上：intersect 的 meta 会被复制到每个元素（3 个元素 = 3 个重复标题），
    // 所以标题只能放在单个元素上。
    .description('大模型调度器。'),
  Schema.union([
    // 首个分支**不能**写 `.required()`：provider 等于公共默认值 `chatluna` 时控制台会把该键
    // 从表单值里省略，带 required 的 const 会因此判为不匹配、整个分支塌成空白（实测）。
    // 省略 required 后 const 仍会拒绝不匹配的值（如 `custom`），只是容忍「键不存在」。
    Schema.object({
      provider: Schema.const('chatluna'),
      chatlunaModel: Schema.dynamic('model')
        .default(CHATLUNA_MODEL_INHERIT)
        .description('ChatLuna 模型，留空继承平台默认模型。'),
    }),
    Schema.object({
      provider: Schema.const('custom').required(),
      ...dispatcherCustomFields(),
    }),
    // 历史值：只在校验旧配置文件时用到，不出现在 provider 下拉里；运行时归一化为 custom。
    Schema.object({
      provider: Schema.const('standalone').required(),
      ...dispatcherCustomFields(),
    }),
    Schema.object({
      provider: Schema.const('auto').required(),
      ...dispatcherCustomFields(),
    }),
  ]),
  Schema.object(dispatcherCommonFields()),
]).default({
  provider: 'chatluna',
  chatlunaModel: CHATLUNA_MODEL_INHERIT,
  model: '',
  temperature: 0.3,
  maxTokens: 6000,
  enableAutoTuning: true,
});

/** 功能总闸的字段声明（默认全开，行为与 0.8.66 一致）。 */
const FEATURES_FIELDS = {
  entries: Schema.boolean().default(true).description('讨论沉淀后投递词条长图。'),
  weekly: Schema.boolean().default(true).description('每周主题周报（按订阅表的 weekly 行投递）。'),
  topics: Schema.boolean().default(true).description('每日主题校准。'),
  media: Schema.boolean().default(true).description('卡片素材池：关闭后不抓素材，卡片出无图版式。'),
};

/** 知识库目录（`databasePath` 是内部项，保持收起）。 */
const STORAGE_FIELDS = Schema.object({
  wikiDir: Schema.string().default(DEFAULT_WIKI_SUBDIR).description('知识库根目录路径。'),
  databasePath: Schema.string().description('索引数据库存储路径。').hidden(),
});

/** 管理面鉴权（`apiToken` 为空即全部 API 拒绝）。 */
const SECURITY_FIELDS = Schema.object({
  apiToken: Schema.string()
    .role('secret')
    .default('')
    .description('管理面密钥，留空则所有 /api 请求返回 401。'),
});

/**
 * 已撤出控制台的运行时段：声明保留（旧配置能加载、能校验），但空配置不物化这些键。
 *
 * `.default(undefined)` 让「用户没写过」的段不出现在解析结果里——插件页顶层才只剩七块；
 * 用户写过时仍按该段自己的 Schema 补齐默认值。`flattenConfig` 负责摊平回运行时顶层键。
 */
const HIDDEN_LEGACY_FIELDS: Record<string, Schema> = Object.fromEntries(
  Object.entries(legacySectionsSchema().dict ?? {}).map(([key, field]) => [
    key,
    field.default(undefined as unknown as never).hidden(),
  ]),
);

/**
 * 订阅目标候选的初值：**模块加载时**读一次实例目录（`koishi.yml` + 相册缓存）。
 *
 * 模块顶层没有 `ctx`，这里只能先按 `process.cwd()` 猜一次（`startupTargetValues()` 的
 * 缺省回退）。`cwd` 不是实例目录时，实例里已配置的目标就不在这份静态 const union 里，
 * 而 union 的校验是**严格**的 —— 那会让整份配置被拒载。所以候选不是「只读这一次」：
 *
 * - `apply()` 拿到 `ctx.baseDir` 后立刻用同一目录**重读**（`startupTargetValues(baseDir,
 *   { reload: true })`）并原地换掉 union 的 `inner.list`（见 `refreshSubscriptionTargets`）；
 * - 任何先拿到 `ctx.baseDir` 的时机都可以直接调 `installStartupTargets(baseDir)` 把该实例
 *   的值补进 union —— 这是「配置校验一定看得见实例值」的兜底入口（测试也走它）；
 * - 同一个目录只读一次盘（`startupTargetValues` 的进程内缓存，有上界）。
 *
 * 为什么不能在 `apply()` 里注入 dynamic schema：订阅表是 `.role('table')`，
 * schemastery-vue 的表格列在渲染前就按 `toColumns(schema.inner)` 校验，而
 * `Schema.dynamic()` 那时只是 `Schema.any()`（解析发生在渲染期）→ validate 失败、
 * 退回每行一张卡片。**表格 + 动态候选无法共存**，所以候选是静态 const union，
 * 由 `refreshSubscriptionTargets()` 在每次重载时原地换掉（见该函数）。
 */
const STARTUP_TARGETS = startupTargetValues();

/**
 * 解析 / 展示用两张表：`targets` 的 const value 是相册的**唯一可读名**，
 * `nameToValue` 是 `settings.json` 里的**绑定表**（名字 → `群号/相册ID`，查不到就拒绝
 * 并 warn），`valueToName` 只给日志起文案（`相册名（群号）`）。
 * 模块加载期安装一次，`apply()` 每次重载、每轮探测与每次保存后重装。
 */
installTargetTables(STARTUP_TARGETS);

/** 订阅表 `targets` 的多选 schema（`@chat` + 相册候选）。 */
const SUBSCRIPTION_TARGETS_SCHEMA = subscriptionTargetsSchema(STARTUP_TARGETS.albums, STARTUP_TARGETS.configured);

/**
 * Config 里 `targets` 的默认值刻意是 `undefined` 而不是 `[]`。
 *
 * Schema 解析会把**缺失**的键按 `meta.default` 物化：默认 `[]` 时，「用户没写过」和
 * 「用户写了 `targets: []`（清空收件人）」在 `flattenConfig` 里长得一模一样，旧 `target`
 * 就会把已清空的目标复活。留成 `undefined` 后缺失键不物化，`projectLegacySubscriptionRows`
 * 才能按「键存在即权威」迁移；两种形态归一后都是运行时 `[]`（不投递），行为不变。
 *
 * `.default()` 返回的是浅拷贝，`inner` 与 `SUBSCRIPTION_TARGETS_SCHEMA` 共享同一份
 * const union —— `refreshSubscriptionTargets` 原地换 `inner.list` 依然生效。
 */
const SUBSCRIPTION_TARGETS_FIELD = SUBSCRIPTION_TARGETS_SCHEMA.default(undefined as unknown as string[]);

/**
 * 重算订阅目标候选：插件重载时与每轮相册探测后各调一次。
 *
 * 静态 union 只在模块顶层求值，而 Koishi 的 `require` 缓存让「重载插件」不重跑顶层——
 * 不重算的话新相册永远进不了下拉。这里**原地**替换 union 的 `list`：外层 `array` +
 * `role: 'select'`、inner 的类型与 `meta` 都不动，所以 `isMultiSelect()`（type array +
 * role select + 纯 const union）与表格列校验 `toColumns(inner)` 的结论不变；
 * `Schema.toJSON()` 每次序列化都现读 `list`，控制台下一次拉 schema 就拿到新候选。
 *
 * 读盘全空（yml 读不到 / 缓存为空）时**不替换**：那会把已保存的值挤出候选，
 * 整份配置过不了严格校验。
 *
 * `groupIds` 给定时按探测范围过滤候选（`scopeAlbumCandidates`）：缓存按群累积，
 * 表外群（退订 / 早已移除的测试群）的历史相册不该继续挂在候选里；`configured`
 * 里点名的旧值仍保留成「未探测」条目。`undefined` = 范围要异步问机器人，先不过滤。
 *
 * 返回过滤后的候选（调用方拿它记住 `configured`，供探测后的再次刷新）。
 */
function refreshSubscriptionTargets(
  values: StartupTargetValues,
  groupIds?: readonly string[],
): StartupTargetValues {
  if (values.albums.length === 0 && values.configured.length === 0) {
    // 没有候选也要装表：解析表只认绑定表，展示表为空即可——不装的话残留的是上一份快照。
    installTargetTables(values);
    return values;
  }
  const albums =
    groupIds === undefined ? values.albums : scopeAlbumCandidates(values.albums, groupIds, values.configured);
  const next: StartupTargetValues = { albums: [...albums], configured: values.configured, bindings: values.bindings };
  // 解析表 = 落盘绑定（不随候选变）；展示表 = 本轮候选。
  installTargetTables(next);
  const items = albumUnionItems(albums, values.configured, { targets: true });
  const union = Config.dict?.['subscriptions']?.inner?.dict?.['targets']?.inner;
  if (union !== undefined) union.list = items;
  return next;
}

/**
 * `installStartupTargets` 的入参：实例目录 + 可选的范围过滤 / 强制重读。
 */
export interface InstallStartupTargetsOptions extends StartupTargetOptions {
  /** 按探测范围过滤候选（异步范围还没问出来时留空 = 不过滤）。 */
  groupIds?: readonly string[];
  /** 跳过按目录缓存重读磁盘（`apply()` 每次重载都走，磁盘上的新相册要当轮生效）。 */
  reload?: boolean;
}

/**
 * 把**某个实例目录**的启动期候选装进模块级订阅目标 union。
 *
 * 这是「`cwd` 不是实例目录」那条缺口的兜底入口：静态 const union 在模块加载时只能按
 * `process.cwd()` 读盘，配置校验却是严格的 —— 实例里已配置、但 cwd 下读不到的目标会让
 * 整份配置被拒载。任何先拿到 `ctx.baseDir` 的时机（`apply()`、宿主钩子、测试）调这个函数，
 * 该目录的候选与已配置值就进了 union，后续 `Config(value)` 不再拒载。
 *
 * `reload` 交回给 `startupTargetValues`：`apply()` 每次重载都要看磁盘上的新相册，
 * 其余调用共用同一份按目录缓存的快照。读盘失败按空候选降级（`readStartupTargetValues`
 * 内部吞异常），这里不额外抛。
 */
export function installStartupTargets(options: InstallStartupTargetsOptions = {}): StartupTargetValues {
  return refreshSubscriptionTargets(
    startupTargetValues(options.baseDir, { reload: options.reload }),
    options.groupIds,
  );
}

/**
 * 一轮相册探测 → 合并缓存 → 注入候选 → 重装订阅目标表。
 *
 * 从 `apply()` 的闭包里提出来只为一件事：**卸载竞态**。探测是异步且可跨秒的，
 * 插件 dispose 之后探测才返回时，`ctx.schema.set` 会在已销毁的 context 上建 effect
 * （cordis 抛 `cannot create effect on inactive context`，卸载流程被打断），`install`
 * 还会把**旧实例的候选**写进模块级 union——新实例的下拉就被上一份快照顶掉了。
 * 所以每个 `await` 之后都要重查 `disposed`，一次都不许漏；写成一条线性函数才能一眼数清。
 *
 * 返回值只给测试与日志用：`disposed` = 中途卸载，什么都没装。
 */
export interface AlbumRefreshDeps {
  /** 卸载标志（`ctx.on('dispose')` 里置位）。 */
  disposed: () => boolean;
  /** 探测范围：机器人 + 群号（`albumProbeScope`）。 */
  scope: () => Promise<{ bots: AlbumBot[]; groupIds: string[] }>;
  probe: (input: { bots: readonly AlbumBot[]; groupIds: readonly string[] }) => Promise<readonly AlbumCandidate[]>;
  readCache: () => Promise<readonly AlbumCandidate[]>;
  writeCache: (albums: readonly AlbumCandidate[]) => Promise<unknown>;
  /** 注入控制台候选（`Schema.dynamic`）。 */
  applySchema: (albums: readonly AlbumCandidate[]) => void;
  /** 重装解析 / 展示表并原地替换订阅目标 union（`refreshSubscriptionTargets`）。 */
  install: (values: StartupTargetValues, groupIds: readonly string[]) => void;
  configured: () => readonly string[];
  bindings: () => Record<string, string>;
  log: (message: string) => void;
}

/** `refreshAlbumCandidates` 的结果（`disposed` = 中途卸载，零副作用）。 */
export type AlbumRefreshOutcome = 'disposed' | 'cached' | 'installed';

export async function refreshAlbumCandidates(deps: AlbumRefreshDeps): Promise<AlbumRefreshOutcome> {
  if (deps.disposed()) return 'disposed';
  const { bots, groupIds } = await deps.scope();
  if (deps.disposed()) return 'disposed';
  if (groupIds.length === 0) {
    const cached = await deps.readCache();
    if (deps.disposed()) return 'disposed';
    deps.applySchema(cached);
    return 'cached';
  }
  const discovered = await deps.probe({ bots, groupIds });
  if (deps.disposed()) return 'disposed';
  const previous = await deps.readCache();
  if (deps.disposed()) return 'disposed';
  const merged = mergeAlbumCandidates(previous, discovered, groupIds);
  // 表外群的历史缓存直接丢弃（缓存按群累积，退订群的相册不该继续挂在候选里）；
  // scope 内的群掉线时仍走「保留旧候选」，它们本来就在 `groupIds` 里。
  // `configured` 点名的旧值例外：只留这几个具体相册，不连带它所属群的其它相册。
  const scoped = scopeAlbumCandidates(merged, groupIds, deps.configured());
  if (deps.disposed()) return 'disposed';
  deps.applySchema(scoped);
  if (scoped.length > 0) await deps.writeCache(scoped);
  if (deps.disposed()) return 'disposed';
  deps.install({ albums: scoped, configured: [...deps.configured()], bindings: deps.bindings() }, groupIds);
  deps.log(`[Patchouli] 群相册候选 ${scoped.length} 个（覆盖 ${groupIds.length} 个群）`);
  return 'installed';
}

/**
 * 订阅表的同步范围判定：显式来源群 + 是否「监听全部群」。
 *
 * `*` 行，以及「表为空且旧白名单也为空」（旧配置的 `listening: null`）都表示全部群；
 * 那种范围只能异步问机器人（`listBotGroupIds`），这里只如实标注出来。
 * `apply()` 的同步预过滤与 `albumProbeScope()` 的异步探测共用这一处，不许各判一套。
 */
function subscriptionProbeSources(
  rows: readonly { source: string }[],
  channels: readonly string[],
): { explicit: string[]; listenAll: boolean } {
  const explicit = channelGroupIds(rows.length > 0 ? rows.map((row) => row.source) : channels);
  const listenAll = rows.some((row) => row.source === '*') || (rows.length === 0 && explicit.length === 0);
  return { explicit, listenAll };
}

/**
 * 插件页配置：只保留八块高频项（模型置顶、启用、管理员、订阅表、投递策略、功能总闸、知识库目录、面板密钥）。
 *
 * 调参面（触发算法 / 主题校准 / 素材池 / 长图 / 裁判）已撤出控制台，改由自建面板写
 * `<wikiDir>/.patchouli/settings.json`（`SETTINGS_META` 是唯一字段表）。旧配置里的值仍然
 * **可以加载**：这些段以降级声明留在 Schema 里（`hiddenLegacyFields()`，`.default(undefined)`
 * 使空配置不物化它们），`flattenConfig` 负责把它们摊平回运行时顶层键。
 *
 * 为什么隐藏段用 `.default(undefined)`：schemastery 的 object 会把子默认值填进结果，声明了
 * 就会出现在 `Config({})` 里——那会让控制台多出十几个隐藏键，也让「顶层只有七块」的契约失效。
 * `.default(undefined)` 保留字段校验能力，但键在用户没写过时不会出现。
 */
export const Config: Schema<PluginOptions> = Schema.object({
  // ── 1. 模型配置（置顶）────────────────────────────────────────────────
  modelConfig: dispatcherSchema,
  // ── 2. 启用 ───────────────────────────────────────────────────────────
  enabled: Schema.boolean().default(true).description('是否启用群聊讨论沉淀。'),
  /** 自动书记管理员白名单：留空 = 无人可用（fail closed）。 */
  adminUsers: Schema.array(Schema.string())
    .default([])
    .role('table')
    .description('管理员'),
  // ── 3. 订阅表 ─────────────────────────────────────────────────────────
  //
  // 控制台这张表**只服务于 yml 用户**：面板写入的覆盖层（`.patchouli/settings.json`
  // 顶层 `subscriptions`）优先于这里。字段形状与面板保持一致（`targets` 多值），
  // 历史 `target` 保留为隐藏字段：单值能加载，早期版本写出的字符串数组同样必须过校验
  // （`flattenConfig` 再把它摊成每个元素一行）。
  //
  // 列头就是字段 description，文案只留最短的一行（`监听群` / `投递群` / `词条` / `周报`）：
  // 表格上方那段多行说明纯噪音，语义都在候选本身与 README 里。
  subscriptions: Schema.array(
    Schema.object({
      source: Schema.string().default('').description('监听群'),
      targets: SUBSCRIPTION_TARGETS_FIELD,
      target: Schema.union([Schema.string(), Schema.array(Schema.string())])
        .description('历史投递目标（单值或字符串数组）')
        .hidden(),
      entry: Schema.boolean().default(true).description('词条'),
      weekly: Schema.boolean().default(false).description('周报'),
    }),
  )
    .role('table')
    .default([])
    .max(256),
  // ── 5. 功能总闸 ───────────────────────────────────────────────────────
  features: Schema.object(FEATURES_FIELDS).description('功能总闸：关掉即整条链路不跑。'),
  // ── 6. 知识库目录 ─────────────────────────────────────────────────────
  storage: STORAGE_FIELDS,
  // ── 7. 面板密钥 ───────────────────────────────────────────────────────
  security: SECURITY_FIELDS,
  /**
   * 历史字段：`advancedMode` 是 0.8.66 条件表单的判别位，现在只用于让旧配置过校验。
   * 不渲染、运行时忽略（高级段改由 `settings.json` 覆盖层承载）。
   */
  advancedMode: Schema.boolean()
    .default(false)
    .description('历史字段：高级设置已移到自建面板。')
    .hidden(),
  // ── 已撤出控制台的运行时段（值仍在，旧配置必须能加载）────────────────
  ...HIDDEN_LEGACY_FIELDS,
}) as unknown as Schema<PluginOptions>;

/**
 * 隐藏段的唯一定义处（`HIDDEN_LEGACY_FIELDS` 与 `flattenConfig` 共用）。
 *
 * 运行时由 `apply()` 与 `PatchouliKnowledgeSystem` 构造把这一段摊平回顶层字段，
 * 其余代码照旧读 `config.trigger` 这类顶层键，不需要知道它们藏在哪。
 */
function legacySectionsSchema() {
  return Schema.object({
    channels: Schema.array(Schema.string()).default([]).description('群聊白名单，留空监听全部群，不是禁用。').hidden(),
    notifyOnSummarized: Schema.boolean().default(false).description('沉淀完成后是否在群内轻提示。').hidden(),
    topics: Schema.object({
      enabled: Schema.boolean().default(true).description('是否启用每日主题校准。'),
      hour: Schema.number().default(4).description('每日校准触发的小时（0～23）。'),
      minute: Schema.number().default(0).description('每日校准触发的分钟（0～59）。'),
      mergeThreshold: Schema.number().default(0.5).description('标签相似度阈值，达到即归入同一主题。'),
      minEntries: Schema.number().default(1).description('待处理词条少于此数则跳过校准。'),
      lookbackDays: Schema.number().default(30).description('回看天数，仅处理窗口内未归档词条。'),
      maxSessionsPerRun: Schema.number().default(20).description('单次校准最多读取的会话数。'),
      maxMessagesPerSession: Schema.number().default(60).description('单会话最多提交的原始消息条数。'),
    }).description('每日主题校准，将新词条归入或新建主题。'),
    albumDelivery: Schema.object({
      entryEnabled: Schema.boolean()
        .default(true)
        .description('每轮沉淀后是否将词条长图发至相册。')
        .hidden(),
      entryRedirectChannelId: Schema.string()
        .default('')
        .description('改道群号，填群号则发聊天不进相册。')
        .hidden(),
      cron: Schema.string()
        .default(DEFAULT_WEEKLY_CRON)
        .description(
          '主题周报定时表达式（五段），由 miyako-delivery 调度；订阅表生效时相册目标由 weekly 行决定，这里是回退默认。',
        ),
      albums: Schema.array(Schema.dynamic(ALBUM_SCHEMA_KEY))
        .default([])
        .description('词条与主题的目标相册，支持在线刷新。')
        .hidden(),
    }).description('相册投递：讨论后发词条，每周发主题。'),
    query: Schema.object({
      cardMaxHeight: Schema.number().default(6000).description('词条长图最大像素高度。'),
    }).description('长图渲染参数。'),
    media: Schema.object({
      offline: Schema.boolean()
        .default(false)
        .description('离线模式，不抓取新素材，循环复用旧素材。'),
      lowWater: Schema.number().default(12).description('可用素材低于此数时自动补货。'),
      batch: Schema.number().default(8).description('单次补货的素材数量。'),
      cooldownHours: Schema.number().default(6).description('离线复用前已用素材的冷却小时数。'),
      dir: Schema.string().default('').description('素材目录，留空使用知识库默认目录。'),
      imageSource: Schema.string()
        .default('https://uapis.cn/api/v1/random/image?category=acg&type=pc')
        .description('背景图接口地址，支持 HTTP 重定向。'),
      sayingSource: Schema.string()
        .default('https://uapis.cn/api/v1/saying')
        .description('一言接口地址，需返回含 text 的 JSON。'),
      apiKey: Schema.string()
        .role('secret')
        .default('')
        .description('素材接口密钥，留空为匿名调用。'),
    }).description('卡片素材池，管理背景图与一言。'),
    trigger: Schema.object({
      windowSizeSeconds: Schema.number().default(60).description('发言速率检测的瞬时滑动窗口（秒）。'),
      burstMultiplier: Schema.number().default(2.5).description('判定突发讨论的速率倍率阈值。'),
      minBurstRate: Schema.number().default(6).description('触发突发的最低绝对速率（条/分）。'),
      quiescenceSeconds: Schema.number().default(300).description('判定讨论平息的静默观察期（秒）。'),
      coolingRatioThreshold: Schema.number().default(1.1).description('平息回落常态倍率下限。'),
      minDiscussionMessages: Schema.number().default(12).description('单次有效沉淀的最低消息条数。'),
      maxBufferMessages: Schema.number().default(500).description('最多缓存的历史消息条数。'),
      baselineEwmaAlpha: Schema.number().default(0.05).description('动态速率基线的平滑系数。'),
      triggerMode: Schema.union([
        Schema.const('potential').description('potential 看信息势能'),
        Schema.const('rate').description('rate 只看发言频率'),
        // 历史模式：两套判据并列、只观测。留在枚举里才能加载旧配置，但不作为选项。
        Schema.const('shadow').hidden(),
      ]).default('potential'),
      thetaMin: Schema.number().default(POTENTIAL_SEEDING.thetaMin).description('势能突发阈值下限。'),
      potentialAutoTuning: Schema.boolean()
        .default(false)
        .description('shadow 模式下两套门限同步参与自动调优。'),
      dispatchMargin: Schema.number()
        .default(1.2)
        .description(
          '调度质量门，过滤弱讨论，0 为关闭。',
        ),
      densityMultiplier: Schema.number()
        .default(1)
        .description(
          '密度基线倍率，设为 0 使用固定下限。',
        ),
      peakCoolFraction: Schema.number()
        .default(0.5)
        .description(
          '峰值冷却比例，设为 0 仅按基线计算。',
        ),
      rhoMin: Schema.number().default(POTENTIAL_SEEDING.rhoMin).description('单条消息的平均信息密度下限。'),
    }).description('自适应突发与平息触发器配置。'),
    judge: Schema.object({
      enabled: Schema.boolean()
        .default(false)
        .description('启用本地裁判服务，关闭则门控直通。'),
      baseURL: Schema.string().default('http://127.0.0.1:5070').description('本地裁判服务基础地址。'),
      apiKey: Schema.string().role('secret').default('').description('裁判服务的 Bearer 令牌。'),
      model: Schema.string().default('jev-local').hidden(),
      timeoutMs: Schema.number().default(8000).hidden(),
    })
      .description('本地裁判服务配置。')
      .hidden(),
    observability: Schema.object({
      discardDumps: Schema.boolean()
        .default(false)
        .description(
          '转储未沉淀讨论至 discards 目录供排障。',
        ),
    }).description('运行可观测性与排障留证配置。').hidden(),
  });
}

/** 功能总闸的缺省值（Schema 默认值之外的第二道兜底：直接构造实例 / 旧配置都能跑）。 */
const FEATURE_DEFAULTS: PatchouliFeatureToggles = { entries: true, weekly: true, topics: true, media: true };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 键序无关的深比较：只用于识别「这个字段还停在 Schema 默认值」。 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

/**
 * 三块「新版仍可见」的配置（`modelConfig` / `storage` / `security`）在 0.8.66 里住在
 * `advanced` 段：新版 Schema 解析旧文件时，顶层是 Schema 默认值、旧值还在 `advanced`。
 * 顶层仍等于默认值 = 用户没在新位置写过，采用旧位置的值；否则新位置优先。
 *
 * 这是**升级迁移规则**，不是运行期兜底：只在「旧值存在且新值仍是默认值」时生效，
 * 两边都写了同样的值时结果也相同，因此不存在双源漂移。
 */
function adoptLegacyField(
  top: unknown,
  legacy: unknown,
  fallback: unknown,
  parse: (value: unknown) => unknown,
): unknown {
  if (legacy !== undefined && (top === undefined || deepEqual(top, fallback))) {
    try {
      return parse(legacy);
    } catch {
      return legacy;
    }
  }
  return top ?? legacy ?? fallback;
}

/**
 * 把控制台的隐藏段摊平成顶层字段（`apply()` 与 `PatchouliKnowledgeSystem` 构造共用，
 * 摊平两次是幂等的）。
 *
 * 来源优先级（**逐段独立**判定，不是整包二选一）：
 * 1. **该段写在顶层**（0.8.4x 之前的扁平配置，或新版控制台把改过的段写回顶层）——原值优先，
 *    否则升级会把用户每一档设置静默重置成默认值；
 * 2. 该段只在 `advanced` 里（0.8.66 的容器布局）——取旧位置的值；
 * 3. `legacySectionsSchema()` 的 Schema 默认值（`Config({})` 不物化隐藏段，运行时在这里补齐）。
 *
 * 「有顶层键就整包按旧文件读」会丢掉 `advanced` 里没被搬到顶层的段（典型：
 * 顶层改了 `trigger`、`channels` 白名单还在 `advanced` → 白名单清空 = 监听所有群）。
 *
 * `features` / `adminUsers` 同样在这里补齐：前者是插件页总闸（缺省全开），
 * 后者是自动书记白名单（缺省 `[]` = 无人可用，fail closed）。
 */
export function flattenConfig(rawConfig: PluginOptions): PluginOptions {
  const raw = rawConfig as unknown as Record<string, unknown>;
  const legacySchema = legacySectionsSchema();
  const defaults = legacySchema({}) as unknown as Record<string, unknown>;
  const nested = isPlainRecord(raw.advanced) ? raw.advanced : {};
  // **逐段**决策来源（不是「顶层出现了任一隐藏键就整份按旧文件读」）：混写是真实存在的
  // 形态——新版控制台把 `trigger` 写在顶层，而没动过的 `channels` 还留在 `advanced` 里。
  // 按单个顶层键决定整包来源会让 `advanced.channels` 的白名单整段丢失 = 退化成监听全部群。
  const source: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    if (raw[key] !== undefined) source[key] = raw[key];
    else if (nested[key] !== undefined) source[key] = nested[key];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = legacySchema({ ...defaults, ...source }) as unknown as Record<string, unknown>;
  } catch {
    // 旧配置里有非法取值时不让启动失败：原样透传，由运行时归一化 / 忽略。
    parsed = { ...defaults, ...source };
  }
  const sections: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) sections[key] = parsed[key];

  const dispatcherFallback = dispatcherSchema({}) as unknown;
  const storageFallback = STORAGE_FIELDS({}) as unknown;
  const securityFallback = SECURITY_FIELDS({}) as unknown;
  const dispatcher = adoptLegacyField(
    raw.modelConfig,
    nested.dispatcher ?? raw.dispatcher,
    dispatcherFallback,
    (value) => dispatcherSchema(value as Record<string, unknown>),
  );
  const storage = adoptLegacyField(raw.storage, nested.storage, storageFallback, (value) =>
    STORAGE_FIELDS(value as Record<string, unknown>),
  );
  const security = adoptLegacyField(raw.security, nested.security, securityFallback, (value) =>
    SECURITY_FIELDS(value as Record<string, unknown>),
  );

  const rawFeatures = isPlainRecord(raw.features) ? raw.features : {};
  const features: PatchouliFeatureToggles = {
    entries: rawFeatures.entries !== false,
    weekly: rawFeatures.weekly !== false,
    topics: rawFeatures.topics !== false,
    media: rawFeatures.media !== false,
  };
  const adminUsers = Array.isArray(raw.adminUsers)
    ? raw.adminUsers.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    ...(raw as unknown as PluginOptions),
    ...sections,
    adminUsers,
    features,
    // 订阅表在这里就归一成运行时形状：先投影旧形态（`target` 单值 / 字符串数组，
    // 字符串数组按元素展开成多行；`targets` 键存在即权威，`[]` 不复活），再归一，
    // 行数 / 目标数 / 字段长度封顶。下游（含 `plugins` 面板）只认归一后的值。
    subscriptions: normalizeSubscriptionRows(projectLegacySubscriptionRows(raw.subscriptions)),
    storage,
    security,
    modelConfig: dispatcher,
    dispatcher,
  } as PluginOptions;
}

export class PatchouliKnowledgeSystem {
  public readonly detector: BurstQuiescenceDetector;
  public readonly dispatcher: ModelDispatcher;
  public readonly wikiEngine: WikiEngine;
  public readonly localStore: LocalStore;
  /**
   * 跨时间「主题聚合」内核：捡未分配词条 → 确定性分组 → 模型写主题综述 → 落盘主题。
   * 调度（每日 04:00 / 失败重试）由 `apply()` 层的 `TopicScheduler` 负责。
   */
  private readonly topicCurator: TopicCurator;
  /**
   * `apply()` 挂入的主题校准调度器。挂入后 `runTopics()`（管理入口）也走它，
   * 手动触发同样写日切水位，避免当天 04:00 再白跑一次模型。
   */
  private topicScheduler: TopicScheduler | undefined;
  /** 最近一次主题校准结果（只读状态面；进程重启后归零）。 */
  public lastTopicRun: TopicRunResult | null = null;
  /**
   * 可观测性 AOP 检查器：挂载即通过实例级猴子补丁织入触发器 / 调度器 / AIMD 关键路径，
   * `dispose()` 时 100% 还原（原型方法与内部状态与从未挂载完全一致）。
   * 只产生 trace 与快照，绝不参与任何决策。
   */
  public readonly inspector: PatchouliInspector;
  /** 解析后的 llmwiki 根目录绝对路径（相对配置按 `baseDir` 锚定）。 */
  public readonly wikiDir: string;
  /** `.patchouli/discards/`：被判定不沉淀的轮次留证目录。 */
  private readonly discardsDir: string;
  /**
   * `.patchouli/scribe/`：主动书记员的追加式录制存储（§7.2）。
   * 写入只发生在 `manualRecording` 的群；目录首次写入才创建。
   */
  public readonly scribe: ScribeStore;
  /**
   * `.patchouli/observability/`：判据持久化台账（裁决点 + 会话结算，JSONL 追加写）。
   *
   * 内存遥测重启即清零，而 shadow 对照需要跨天的连续数据；两者互不替代：
   * trace 供监控页实时看，本台账供三天后统计「两套判据各沉淀多少」。
   */
  public readonly shadowLedger: ShadowLedger;
  public readonly config: PluginOptions;
  /**
   * 主题校准运行时参数：独立于宿主 `config.topics` 的可变副本。
   *
   * 面板改参数与重启回灌都只写这里；`TopicScheduler` 持有同一引用，热更新即时生效。
   * 宿主配置对象保持只读——Koishi loader 在启停时序列化/比较它，运行时写入会被当作
   * 配置变更并把「停止」翻成 reload（ADR-022）。
   */
  private readonly topicRuntime: PluginOptions['topics'];
  /**
   * `settings.json` 覆盖层（自建面板写入的调参面）。
   *
   * 构造期同步载入一次——触发器 / 素材池 / 裁判的参数在这里就要定型；`initialize()`
   * 再异步回灌一次作为真源（写入路径也会用落盘结果覆盖它）。
   * **绝不写宿主 config**（ADR-022）：覆盖值只存在于本字段与磁盘文件。
   */
  private settingsOverrides: SettingsOverrides = {};
  /**
   * 上一条设置告警：同一份坏值在构造期与 `initialize()` 回灌期会被读两次，
   * 只保留「连续重复即丢弃」这一条 O(1) 规则，避免同一行日志刷两遍。
   */
  private lastSettingsWarning: string | undefined;
  /**
   * 订阅表覆盖层（`settings.json` 顶层 `subscriptions` 键）。
   *
   * `null` = 文件里没有覆盖，`subscriptions()` 完全按宿主 config 编译；
   * 非 `null`（含空数组 = 面板清空了表）**整段顶替** config。构造期同步载入一次，
   * `initialize()` 再异步回灌；写入只经 `updateSubscriptions`（ADR-022：绝不写宿主 config）。
   */
  private subscriptionOverride: readonly SubscriptionRow[] | null = null;
  /**
   * 绑定表（`settings.json` 顶层 `targetBindings` 键）：可读名 → `群号/相册ID`。
   *
   * **投递期解析名字的唯一真源**：一旦绑定，探测顺序变化 / 同名相册进出 / 相册改名
   * 都不会改变收件人。只在「保存订阅表」与「首轮迁移」时写入，构造期同步载入一次、
   * `initialize()` 再异步回灌。
   */
  private targetBindings: Record<string, string> = {};
  /**
   * 绑定表是否已经「建立」过（首轮迁移或面板保存至少完成一次）。
   *
   * 判据来自 `settings.json` 的 `bindingMigration` 标记（与绑定表同一次原子写，
   * 见 `readTargetBindingMigration`）。它把两类「名字没有绑定」分开：
   * - **未建立**（升级前只有 yml）→ 名字从没解析过，首轮迁移/首次保存要解析；
   * - **已建立** → 名字在落盘的行里却没有绑定，只可能是掉绑后留下的（相册消失 /
   *   歧义 / 改名）→ 不再拿当前候选重解析，等用户重选（见 `resolveTargetBindings` 规则 3）。
   */
  private bindingTableEstablished = false;
  /**
   * 订阅表变更回调：由 `apply()` 注入。
   *
   * 订阅表一变，控制台里跟订阅有关的候选就要重新同步（`albumDelivery.albums` 的
   * `Schema.dynamic` 重注入；`subscriptions[].targets` 的 const 列表由相册探测刷新）。
   * 未注入时静默跳过（直接构造本类的测试 / 嵌入方没有控制台）。
   */
  public onSubscriptionsChanged?: () => void;
  /** 自定义提示词覆盖（`system` 沉淀用 / `topic` 主题聚合用），同样不写宿主 config。 */
  private readonly promptOverrides: { system: string; topic: string } = { system: '', topic: '' };
  /**
   * 卡片素材池：背景图与一言的预取 / 消费 / 离线复用。
   * 与渲染器只通过目录交互——渲染器不联网，抓不到素材就出无图版式。
   */
  public readonly media: MediaPool;
  /** 页眉 `#编号` 的独立自然数序列（与词条 id 无关，跨重启延续）。 */
  public readonly cardSequence: CardSequence;
  /** 首次初始化落盘的管理密钥路径（`<wikiDir>/.patchouli/api-token.txt`）。 */
  public readonly apiTokenPath: string;
  /**
   * 词条沉淀后的卡片投递钩子：由 `apply()` 注入（渲染 + 投递都在宿主侧完成）。
   * 未注入时静默跳过——直接构造本类的测试 / 嵌入方不需要投递能力。
   */
  private entryCardSink?: (entryId: string, channelId: string) => Promise<void>;
  /** 出图选项（面板可调，落盘在 `.patchouli/card-settings.json`）。 */
  private cardSettings: CardSettings = { ...CARD_SETTINGS_DEFAULT };
  /** 本地 System-1 裁判客户端（构造零 I/O；`judge.enabled` 关闭时所有调用点直接短路）。 */
  public readonly judgeClient: JudgeClient;
  /** 平息结算前的门控（§7.3）：低密度直接舍弃，裁判不可用时 fail-open。 */
  private readonly gate: PreDispatchGate;
  /** L0 候选 → L2 边界裁决的异步标注器（§4.4）；消息热路径只 `void` 调用。 */
  private readonly boundaryAnnotator: BoundaryAnnotator;
  /**
   * 启动期异步初始化的完成信号：目录骨架 + 自定义提示词回灌。
   * 构造期间即启动，恒为 resolve（失败已在内部降级），可安全 `await`。
   */
  public readonly ready: Promise<void>;

  /**
   * 按频道的 5 秒流量桶：`bucketStart(ms) -> 该桶内被接受的群消息条数`。
   * 写入只发生在消息被接受时，读取只做桶展开——不触碰触发器状态机。
   */
  private readonly trafficBuckets = new Map<string, Map<number, number>>();
  /** 按频道的「已监测起点」桶（对齐 5 秒边界）；不在表中的群一律不产出数据点。 */
  private readonly trafficMonitorStart = new Map<string, number>();
  /**
   * 每群至多 1 条最新消息预览（按接受顺序覆盖）。
   * 只驻留内存、随进程结束消失；绝不落盘，也不参与沉淀流程。
   */
  private readonly latestMessages = new Map<string, LatestMessage>();
  /**
   * 同源媒体代理的 opaqueId 登记表：唯一写入点是 `recordLatestMessage`，
   * 因此只登记「本缓存消息里出现过的公网 http(s) 媒体地址」，`dispose()` 清空。
   */
  public readonly mediaRegistry = new MediaRegistry();
  /**
   * 每群 AIMD 上次校准时刻（epoch 毫秒）：只作为时间向心力衰减的基准，
   * 启动时由持久化快照的 `updatedAt` 回灌，`dispose()` 清空。
   */
  private readonly tuningClocks = new Map<string, number>();
  /** 单群 AIMD 串行链：两轮结算并发时，后到者必须看到前一步的结果（读-改-写不能交错）。 */
  private readonly tuningChains = new Map<string, Promise<void>>();
  /**
   * 每群「已交付到哪」的水位，**原始时间戳域**（= 被交付片段的 endTime）。
   *
   * 绝不能用水位直接比较 `detector.lastSettledTime`：那是**逻辑时间**（可领先墙钟），
   * 与消息的原始 timestamp 不同域——跨域比较会把每条合法切点判成陈旧（实测丢消息并删档）。
   */
  private readonly deliveredWatermarks = new Map<string, number>();
  /** 空闲群状态回收定时器（每小时一次，`unref` 不阻止进程退出）。 */
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    rawConfig: PluginOptions,
    private readonly logger?: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    },
    private readonly onNotify?: (channelId: string, text: string) => Promise<void>,
    dispatcherRuntime?: DispatcherRuntimeOptions,
    /** Koishi 实例根目录：相对路径（wikiDir / 素材目录）一律锚定它，热更新时同样要用。 */
    private readonly baseDir?: string,
  ) {
    // 控制台的隐藏段（含 0.8.66 的 `advanced` 容器）摊平回顶层：其余代码只读 `this.config.<顶层键>`。
    const config: PluginOptions = flattenConfig(rawConfig);
    this.config = config;
    this.wikiDir = resolveWikiDir(config.storage.wikiDir, baseDir);
    // 覆盖层要在构造期同步载入：trigger / media / judge 的实例参数在下面几行就要定型。
    // 合并基线随读入透传：坏值在读取时整段丢弃并告警，绝不让一份写坏的 settings.json
    // 变成「插件在挂上管理路由之前就抛错」——那样面板连修复的机会都没有。
    this.settingsOverrides = readSettingsOverridesSync(this.wikiDir, this.settingsRepairContext());
    // 订阅表同住一个文件，必须一起回灌：否则「面板改过表 + 重启」会静默退回 yml 配置。
    this.subscriptionOverride = readSubscriptionOverrideSync(this.wikiDir);
    // 绑定表与订阅表同一次落盘：名字→地址的对应必须跟着行一起回灌，否则重启后停投。
    this.targetBindings = readTargetBindingsSync(this.wikiDir);
    // 主题校准运行时参数：合并后的段值（覆盖层 > config）。调度器持有同一引用，改完即生效。
    this.topicRuntime = { ...this.mergedSection('topics') };
    this.discardsDir = resolveWikiLayout(this.wikiDir).discardsDir;
    // 素材池参数同样按覆盖层合并；`features.media === false` 时整体停用（不抓素材、出无图版式）。
    const mediaConfig = this.mergedSection('media');
    this.media = new MediaPool({
      dir: mediaConfig.dir.trim() ? resolveWikiDir(mediaConfig.dir, baseDir) : resolveWikiLayout(this.wikiDir).mediaDir,
      offline: mediaConfig.offline,
      lowWater: mediaConfig.lowWater,
      batch: mediaConfig.batch,
      cooldownMs: Math.max(0, mediaConfig.cooldownHours) * 3_600_000,
      imageSource: mediaConfig.imageSource,
      sayingSource: mediaConfig.sayingSource,
      apiKey: mediaConfig.apiKey,
      disabled: config.features.media === false,
    });
    const patchouliLayout = resolveWikiLayout(this.wikiDir);
    this.cardSequence = new CardSequence({ file: cardSequencePath(patchouliLayout.patchouliDir) });
    this.apiTokenPath = patchouliLayout.apiTokenPath;
    this.wikiEngine = new WikiEngine({ wikiDir: this.wikiDir });
    this.localStore = new LocalStore({ ...config.storage, wikiDir: this.wikiDir });
    const loggerRef = this.logger;
    this.scribe = new ScribeStore({
      dir: resolveWikiLayout(this.wikiDir).scribeDir,
      logger: loggerRef
        ? { info: (message: string) => loggerRef.info(message), warn: (message: string) => loggerRef.warn(message) }
        : undefined,
    });
    this.shadowLedger = new ShadowLedger({
      dir: patchouliLayout.observabilityDir,
      logger: loggerRef
        ? { info: (message: string) => loggerRef.info(message), warn: (message: string) => loggerRef.warn(message) }
        : undefined,
    });
    const dispatcherRuntimeWithLogger: DispatcherRuntimeOptions = { ...dispatcherRuntime };
    if (dispatcherRuntimeWithLogger.logger === undefined && loggerRef !== undefined) {
      dispatcherRuntimeWithLogger.logger = {
        info: (message: string) => loggerRef.info(message),
        warn: (message: string) => loggerRef.warn(message),
        error: (message: string) => loggerRef.error(message),
      };
    }
    this.dispatcher = new ModelDispatcher(config.dispatcher, dispatcherRuntimeWithLogger);
    this.topicCurator = new TopicCurator({
      engine: this.wikiEngine,
      store: this.localStore,
      invoke: async (messages) => this.dispatcher.invokeRaw(messages),
      systemPrompt: () => resolveTopicSystemPrompt(this.promptOverrides.topic),
      logger: loggerRef
        ? { info: (message: string) => loggerRef.info(message), warn: (message: string) => loggerRef.warn(message) }
        : undefined,
    });

    this.detector = new BurstQuiescenceDetector({
      options: this.resolveTriggerOptions(),
      onQuiescence: async (session: DiscussionSession) => {
        // 先记水位再交付：本片段的消息到此为止，重启恢复不该再交一次。
        this.deliveredWatermarks.set(session.channelId, session.endTime);
        await this.handleQuiescence(session);
      },
      onManualSessionEnd: (channelId) => {
        // 会话结束（`rec off` / 2h 熔断）即清档：录制文件只服务于重启恢复，
        // 留着会让下次启动把已经交付过的会话再恢复、再交付一次。
        // `ScribeStore.remove` 自带串行队列并吞掉异常，`void` 掉即可。
        void this.scribe.remove(channelId);
      },
      onDiscard: (info) => {
        // 缓冲不足丢弃是「什么都没发生」的唯一解释来源：必须留痕，否则无法区分未触发与故障。
        this.logger?.info(
          `[Patchouli] 群 ${info.channelId} 讨论不足未沉淀：缓冲 ${info.messageCount} 条 < 下限 ` +
            `${info.minDiscussionMessages} 条（峰值 ${info.peakRate.toFixed(1)}/m）`,
        );
        // 留证不参与任何决策：内部自吞异常，`void` 掉也绝不会产生未处理的 rejection。
        void this.recordDiscard(
          {
            sessionId: `floor-${info.channelId}-${info.endTime}`,
            channelId: info.channelId,
            startTime: info.startTime,
            endTime: info.endTime,
            messages: info.messages,
            peakRate: info.peakRate,
            triggerReason: info.triggerReason,
            partial: false,
          },
          { kind: 'FLOOR', minDiscussionMessages: info.minDiscussionMessages },
        );
      },
    });

    // 本地 System-1 裁判（§7.3）：构造零 I/O；`judge.enabled` 关闭时两个调用点都直接短路，
    // 因此无条件创建不改变默认行为，也不会发起任何网络请求。
    this.judgeClient = new JudgeClient(readJudgeOptions(this.mergedSection('judge')));
    this.gate = new PreDispatchGate(this.judgeClient);
    this.boundaryAnnotator = new BoundaryAnnotator(this.judgeClient, {
      noteBoundary: (channelId, at, confidence) => this.detector.noteBoundary(channelId, at, confidence),
      logger: loggerRef ? { info: (message: string) => loggerRef.info(message) } : undefined,
    });

    // 可观测性挂载点：所有依赖（detector / dispatcher / config）就绪后才织入，
    // 早于任何异步恢复流程，确保启动期的调参 / 消息同样被观测到。
    this.inspector = attachTelemetry(this, {
      onRecord: (record) => this.shadowLedger.append(record),
    });

    // 目录骨架建好之后立刻回灌自定义提示词：调度器持有配置对象的实时引用，
    // 因此回灌完成即生效，且跨服务重启不丢失。
    this.ready = this.initialize();
    void this.restorePersistedCadenceStates();
    this.markWhitelistedChannelsMonitored();
  }

  /** 注入词条投递钩子（幂等，后注入覆盖先注入）。 */
  public setEntryCardSink(sink: (entryId: string, channelId: string) => Promise<void>): void {
    this.entryCardSink = sink;
  }

  /**
   * 词条投递的外层闸：**新表生效时由行决定，表为空（旧配置回退）时才读 `entryEnabled`**。
   *
   * 旧实现无条件先看 `albumDelivery.entryEnabled`：用户在新表里勾了「词条」，只要这个旧开关
   * 是关的（升级前关的 / 旧配置里写的），词条就永远不投——保存成功、日志里也有目标，实际一条不发。
   * `features.entries` 是功能总闸，关掉就整个不做（投递钩子里还有一道同样的判断）。
   */
  private entryCardDeliveryEnabled(): boolean {
    if (this.entryCardSink === undefined) return false;
    if (this.config.features.entries === false) return false;
    return this.subscriptions().active || this.config.albumDelivery?.entryEnabled !== false;
  }

  /**
   * 启动期异步初始化：建全 llmwiki 骨架，再回灌 `<wikiDir>/.patchouli/custom-prompt.txt`。
   * 两段都自带错误降级，`ready` 恒为 resolve —— 调用方可以安全 `await`。
   */
  private async initialize(): Promise<void> {
    await this.ensureStorageLayout();
    // 重启后 knownTitles 是空的：不回填会让「改名」只写新标题、旧索引行永久残留。
    const hydrated = await this.wikiEngine.hydrateKnownTitles();
    if (hydrated > 0) this.logger?.info(`[Patchouli] 已从现有词条重建标题索引：${hydrated} 条`);
    await this.restoreSettings();
    await this.migrateTargetBindings();
    await this.restoreCardSettings();
    await this.restoreCustomPrompt();
    // 判据台账的保留期清扫：失败只告警，绝不阻塞启动。
    void this.shadowLedger.sweep();
    // 空闲群状态回收：每小时一次；`unref` 保证不拖住进程退出。
    if (this.idleSweepTimer === null) {
      this.idleSweepTimer = setInterval(() => {
        try {
          this.sweepIdleChannels();
        } catch (error) {
          this.logger?.warn(`[Patchouli] 空闲群回收失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }, 3_600_000);
      this.idleSweepTimer.unref?.();
    }
    // 启动期覆盖层已回灌、订阅表定型：把生效关系打一次，之后只在保存成功时更新。
    this.logSubscriptionSummary();
  }

  /**
   * 启动期补货：只在在线模式且低于水位时抓取。
   * 失败只记一条警告——素材池是增强项，缺料时卡片自动退化为无图版式。
   */
  public async prefillMedia(): Promise<void> {
    // 总闸关闭：不抓素材、不补货，渲染侧由 `MediaPool.disabled` 直接返回无图版式。
    if (this.config.features.media === false) return;
    try {
      const [images, sayings] = await Promise.all([
        this.media.ensureFilled('image'),
        this.media.ensureFilled('saying'),
      ]);
      if (images > 0 || sayings > 0) {
        this.logger?.info(`[Patchouli] 素材池补货: 背景图 +${images}, 一言 +${sayings}`);
      }
    } catch (error: unknown) {
      this.logger?.warn(`[Patchouli] 素材池补货失败: ${String(error)}`);
    }
  }

  /**
   * 启动期回灌设置覆盖层（`<wikiDir>/.patchouli/settings.json`）。
   *
   * 两件事：① 异步重读覆盖层（构造期同步载入的版本先顶住实例参数）；② 旧版
   * `topics-settings.json` 一次性迁移——新文件还没有 `topics` 段时把旧值搬进去，
   * 之后只有 `settings.json` 一个真源。任何失败只告警，绝不让启动失败。
   */
  private async restoreSettings(): Promise<void> {
    try {
      let overrides = await readSettingsOverrides(this.wikiDir, this.settingsRepairContext());
      if (overrides.topics === undefined) {
        const legacy = validateSettingsPatch('topics', await readTopicSettings(this.wikiDir));
        if (legacy.ok && Object.keys(legacy.value).length > 0) {
          overrides = await writeSettingsOverrides(
            this.wikiDir,
            'topics',
            legacy.value,
            this.settingsRepairContext(),
          );
          this.logger?.info('[Patchouli] 已把主题校准参数迁移到 .patchouli/settings.json');
        }
      }
      this.applySettingsOverrides(overrides, 'replay');
      // 订阅表与标量段同一个文件、同一条读取路径：两处都要回灌，避免读到构造期的旧快照。
      this.subscriptionOverride = await readSubscriptionOverride(this.wikiDir);
      this.targetBindings = await readTargetBindings(this.wikiDir);
      // 覆盖层回灌完成：控制台候选要跟着换（构造期注入时读到的还是空覆盖）。
      this.onSubscriptionsChanged?.();
    } catch (error: unknown) {
      this.logger?.warn(`[Patchouli] 读取运行时设置失败，沿用配置文件与构造期快照: ${String(error)}`);
    }
  }

  /**
   * 首轮绑定迁移：绑定表为空、但订阅表里还有可读名时，用**当前候选**一次性填充并落盘。
   *
   * 之后不再自动改写：相册改名 / 别的群出现同名相册都不会动已保存的绑定
   * （那正是「悄悄换主」的来源）。解析不到的名字不绑定、只 warn——用户在面板重选。
   *
   * 幂等：绑定表非空直接返回；一个名字都解析不到时也不写空表（下次启动还能再试）。
   */
  private async migrateTargetBindings(): Promise<void> {
    try {
      this.targetBindings = await readTargetBindings(this.wikiDir);
      // 「建立过」判据来自落盘标记（与绑定表同一次原子写）：非空表本身也算建立过。
      this.bindingTableEstablished =
        Object.keys(this.targetBindings).length > 0 || (await readTargetBindingMigration(this.wikiDir));
      if (Object.keys(this.targetBindings).length > 0) return;
      const rows = resolveRows(this.config, this.subscriptionOverride ?? undefined);
      const hasNames = rows.some((row) =>
        row.targets.some((target) => {
          const name = target.trim();
          return (
            name !== '' && name !== CHAT_TARGET && !isTargetGroupHeader(name) && !ALBUM_TARGET_PATTERN.test(name)
          );
        }),
      );
      if (!hasNames) return;
      const albums = await readAlbumCache(this.wikiDir);
      // 掉绑标记只来自「上一次落盘的行」，且只在绑定表**建立过**时才算数：
      // 升级前只有 yml、还没建立绑定时名字本来就还没解析过，必须照常解析。
      const previousRows: readonly SubscriptionRow[] = this.bindingTableEstablished
        ? this.subscriptionOverride ?? []
        : [];
      const { bindings, unresolved } = resolveTargetBindings(rows, albums, {}, previousRows);
      if (Object.keys(bindings).length === 0) {
        this.logger?.warn(
          `[Patchouli] 订阅目标尚未建立绑定（投递期会停投）：${unresolved.join('、')} —— 请重新选择相册`,
        );
        return;
      }
      this.targetBindings = await writeTargetBindings(this.wikiDir, bindings);
      // 迁移写成（或本来就有标记）= 绑定表已建立：之后的掉绑不再被自动重解析。
      this.bindingTableEstablished = true;
      const bound = Object.keys(this.targetBindings).length;
      this.logger?.info(
        `[Patchouli] 已为 ${bound} 个订阅目标建立相册绑定（写入 .patchouli/settings.json）` +
          (unresolved.length > 0 ? `；未绑定：${unresolved.join('、')}` : ''),
      );
      this.onSubscriptionsChanged?.();
    } catch (error: unknown) {
      this.logger?.warn(`[Patchouli] 订阅目标绑定迁移失败，沿用现有绑定: ${String(error)}`);
    }
  }

  /**
   * 合并后的段值：**覆盖层 > config > Schema 默认值**。
   *
   * `config` 已经由 `flattenConfig` 补齐过默认值，所以这里只需叠一层覆盖。
   * `topics` 特殊：返回 `topicRuntime` 本体（调度器持有同一引用，面板保存即时生效）。
   */
  public settings<K extends SettingsSection>(section: K): PatchouliSettingsValues[K] {
    return (section === 'topics' ? this.topicRuntime : this.mergedSection(section)) as PatchouliSettingsValues[K];
  }

  /** 纯合并（不碰 `topicRuntime`）：供 `settings()` 与构造期副本初始化使用。 */
  private mergedSection<K extends SettingsSection>(section: K): PatchouliSettingsValues[K] {
    const base: unknown =
      section === 'trigger'
        ? this.config.trigger
        : section === 'topics'
          ? this.config.topics
          : section === 'media'
            ? this.config.media
            : section === 'query'
              ? this.config.query
              : this.config.judge;
    const merged: Record<string, unknown> = {};
    if (typeof base === 'object' && base !== null) {
      for (const [key, value] of Object.entries(base)) merged[key] = value;
    }
    for (const [key, value] of Object.entries(this.settingsOverrides[section] ?? {})) merged[key] = value;
    return merged as unknown as PatchouliSettingsValues[K];
  }

  /**
   * 覆盖层自愈的合并基线（宿主 config 的段值）。
   *
   * 只有 `trigger` 需要基线：`validateMergedSettings` 里其余四段没有跨字段约束，
   * 它们的非法值在字段级就被挡掉了。突发倍率与回落倍率的关系必须拿 config 的真实值来判，
   * 拿 Schema 默认值判会误删「单独看越界、合并后合法」的覆盖。
   */
  private settingsBase(): SettingsBaseSections {
    return { trigger: { ...this.config.trigger } as Record<string, unknown> };
  }

  /** 读取 / 写入覆盖层时的自愈上下文（基线 + 告警出口）。 */
  private settingsRepairContext(): SettingsRepairContext {
    return {
      base: this.settingsBase(),
      warn: (message: string) => this.warnSettings(message),
    };
  }

  /** 设置相关的告警出口：宿主没注入 logger 时静默（与其余可选日志一致）。 */
  private warnSettings(message: string): void {
    if (this.lastSettingsWarning === message) return;
    this.lastSettingsWarning = message;
    this.logger?.warn(message);
  }

  /**
   * 构造器定型用的触发参数：合并值非法时回落到宿主 config（config 也非法则回落 Schema 默认值）。
   *
   * 正常情况下 `readSettingsOverridesSync` 已经把非法段摘掉了，这里是第二道闸：
   * `BurstQuiescenceDetector` 的构造是同步硬断言，抛错就会把整个插件（含管理路由）带倒，
   * 面板也就永久失去修复入口。宁可降级运行并告警，也不能起不来。
   */
  private resolveTriggerOptions(): PluginOptions['trigger'] {
    const merged = this.mergedSection('trigger');
    const mergedErrors = validateMergedSettings('trigger', merged);
    if (mergedErrors.length === 0) return merged;
    this.warnSettings(
      `[Patchouli] settings.json 的 trigger 段合并后非法（${mergedErrors.join('；')}），已回落宿主 config`,
    );
    const configured = this.config.trigger;
    const configErrors = validateMergedSettings('trigger', configured);
    if (configErrors.length === 0) return configured;
    this.warnSettings(
      `[Patchouli] 宿主 config.trigger 同样非法（${configErrors.join('；')}），已回落 Schema 默认值`,
    );
    return { ...DEFAULT_TRIGGER_OPTIONS };
  }

  /** 五段合并值的一次性快照（`GET /api/settings` 的响应体）。 */
  public getSettingsSections(): PatchouliSettingsValues {
    const sections: PatchouliSettingsValues = {
      trigger: this.settings('trigger'),
      topics: this.settings('topics'),
      media: this.settings('media'),
      query: this.settings('query'),
      judge: this.settings('judge'),
    };
    // 密钥一律打码：浏览器只拿到空串 + 同段 `secretConfigured`，真值留在运行态与文件里。
    return {
      ...sections,
      media: redactSettingsSection('media', sections.media) as unknown as PatchouliSettingsValues['media'],
      judge: redactSettingsSection('judge', sections.judge) as unknown as PatchouliSettingsValues['judge'],
    };
  }

  /**
   * 校验并持久化一段覆盖值（面板 `POST /api/settings` 的唯一入口）。
   *
   * 两道校验，**都在落盘之前**：① 字段级（白名单 / 类型 / 单字段区间 / 长度上限 / URL 形态）；
   * ② 合并后的跨字段约束（`config` ⊕ 现有覆盖 ⊕ 本次补丁，判据见
   * `validateMergedSettings`）。任一不过都返回 `ok:false`（HTTP 层翻 400），
   * 文件与运行态都不动 —— 绝不允许「写进去了但应用失败」的半截状态。
   * 密钥字段（`SETTINGS_SECRET_KEYS`）的空串 = 不修改：面板回显的空串不会冲掉已存值。
   * 落盘成功后直接采用写盘返回的整份覆盖层，避免「写盘成功再读文件」的双读窗口。
   */
  public async updateSettings(
    section: unknown,
    patch: unknown,
  ): Promise<{ ok: true; section: SettingsSection; value: PatchouliSettingsValues[SettingsSection] } | { ok: false; error: string }> {
    const validated = validateSettingsPatch(section, patch);
    if (!validated.ok) return { ok: false, error: validated.error };
    const merged: Record<string, unknown> = {
      ...(this.mergedSection(validated.section) as unknown as Record<string, unknown>),
      ...validated.value,
    };
    const mergedErrors = validateMergedSettings(validated.section, merged);
    if (mergedErrors.length > 0) return { ok: false, error: mergedErrors.join('；') };
    let overrides: SettingsOverrides;
    try {
      overrides = await writeSettingsOverrides(
        this.wikiDir,
        validated.section,
        validated.value,
        this.settingsRepairContext(),
      );
    } catch (error: unknown) {
      if (!(error instanceof SettingsConflictError)) throw error;
      // 文件被外部改写（内存快照滞后）：先把真源读回来，再按**真实合并值**给出可读的 400。
      // 不这样做的话面板会永远拿同一个冲突文案，而它看到的段值又不是文件里的值。
      const refreshed = await readSettingsOverrides(this.wikiDir, this.settingsRepairContext());
      // 文件是外部改写的：运行态直接服从文件真源（整段应用），不是「本次补丁」。
      this.applySettingsOverrides(refreshed, 'replay');
      const conflicts = validateMergedSettings(validated.section, {
        ...(this.mergedSection(validated.section) as unknown as Record<string, unknown>),
        ...validated.value,
      });
      return { ok: false, error: conflicts.length > 0 ? conflicts.join('；') : error.message };
    }
    this.applySettingsOverrides(overrides);
    // 回包与 GET 同构：密钥位置空串 + `secretConfigured`，绝不把明文送回浏览器。
    return {
      ok: true,
      section: validated.section,
      value: redactSettingsSection(
        validated.section,
        this.settings(validated.section) as unknown as Record<string, unknown>,
      ) as unknown as PatchouliSettingsValues[SettingsSection],
    };
  }

  /**
   * 覆盖层变更的统一生效点：替换内存快照、同步主题副本，并把**本次变化的键**
   * 落到已建状态的触发器与裁判上（只应用变化的键，不覆盖 AIMD 逐群调校结果）。
   *
   * `mode` 决定「变化」怎么算：
   * - `patch`（默认，面板保存）：只应用 `previous` → `next` 之间真正变了的键。
   *   落盘的 `trigger` 段是**累积**的（上次保存就把 `minBurstRate` 写进去了），
   *   整段重放等于把每个群 AIMD 学到的值按老快照改回去——保存一个无关设置也会。
   * - `replay`（启动回灌 / 文件被外部改写后重读）：整段应用。那时运行态参数本来就该
   *   服从文件里的真源，没有「本次补丁」可言。
   *
   * 触发器热更新按群逐个兜底：文件已经落盘，这里再抛错就只剩「500 + 运行态半截」，
   * 比「这个群沿用旧参数 + 一条告警」糟得多。
   */
  private applySettingsOverrides(next: SettingsOverrides, mode: 'patch' | 'replay' = 'patch'): void {
    const previous = this.settingsOverrides;
    this.settingsOverrides = next;
    // 主题调度器持有 `topicRuntime` 的实时引用：值换了还得重排定时器，
    // 否则改 `hour` / `minute` 后旧 `setTimeout` 仍按老时刻触发，`enabled` 关掉再打开则永不触发。
    const topicsBefore = { ...this.topicRuntime };
    Object.assign(this.topicRuntime, this.mergedSection('topics'));
    if (!deepEqual(topicsBefore, this.topicRuntime)) this.topicScheduler?.reschedule();
    const triggerPatch = mode === 'replay' ? next.trigger : this.changedTriggerKeys(previous.trigger, next.trigger);
    if (triggerPatch !== undefined) {
      try {
        this.detector.applyDefaultOptions(triggerPatch);
      } catch (error: unknown) {
        this.warnSettings(
          `[Patchouli] 触发默认参数热更新失败，沿用旧值：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      for (const channelId of this.detector.channelIds()) {
        try {
          this.detector.updateOptions(channelId, triggerPatch);
        } catch (error: unknown) {
          this.warnSettings(
            `[Patchouli] 群 ${channelId} 的触发参数热更新失败，沿用旧值：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    const judgePatch = next.judge;
    if (judgePatch !== undefined) this.judgeClient.applyOptions(readJudgeOptions(this.mergedSection('judge')));
    const mediaPatch = next.media;
    if (mediaPatch !== undefined) {
      // 目录与其余参数同一真源（合并值）：面板存了新目录就必须换扫描根，否则「显示已保存、
      // 进程还在读旧目录」。空目录名的语义与构造期一致——回落到 `<wikiDir>/media`。
      const mediaMerged = this.mergedSection('media');
      this.media.configure({
        dir: mediaMerged.dir.trim()
          ? resolveWikiDir(mediaMerged.dir, this.baseDir)
          : resolveWikiLayout(this.wikiDir).mediaDir,
        offline: typeof mediaPatch.offline === 'boolean' ? mediaPatch.offline : undefined,
        lowWater: typeof mediaPatch.lowWater === 'number' ? mediaPatch.lowWater : undefined,
        batch: typeof mediaPatch.batch === 'number' ? mediaPatch.batch : undefined,
        cooldownMs: typeof mediaPatch.cooldownHours === 'number' ? mediaPatch.cooldownHours * 3_600_000 : undefined,
        imageSource: typeof mediaPatch.imageSource === 'string' ? mediaPatch.imageSource : undefined,
        sayingSource: typeof mediaPatch.sayingSource === 'string' ? mediaPatch.sayingSource : undefined,
        apiKey: typeof mediaPatch.apiKey === 'string' ? mediaPatch.apiKey : undefined,
      });
    }
  }

  /**
   * 两次覆盖层快照之间**真正变了的** `trigger` 键；没有变化返回 `undefined`。
   *
   * 删掉的键按「回落到宿主 config 的值」应用（覆盖层里没有它了）——不能塞 `undefined`：
   * `normalizeTriggerOptions` 只认有值的键。上限 = `trigger` 的字段数（十几个），
   * 每次保存算一遍的成本可以忽略。
   */
  private changedTriggerKeys(
    previous: SettingsSectionPatch | undefined,
    next: SettingsSectionPatch | undefined,
  ): SettingsSectionPatch | undefined {
    const before = previous ?? {};
    const after = next ?? {};
    const patch: SettingsSectionPatch = {};
    let changed = false;
    for (const [key, value] of Object.entries(after)) {
      if (Object.hasOwn(before, key) && deepEqual(before[key], value)) continue;
      patch[key] = value;
      changed = true;
    }
    const base = this.config.trigger as unknown as Record<string, SettingsValue | undefined>;
    for (const key of Object.keys(before)) {
      if (Object.hasOwn(after, key)) continue;
      const fallback = base[key];
      if (fallback === undefined) continue;
      patch[key] = fallback;
      changed = true;
    }
    return changed ? patch : undefined;
  }

  /**
   * 用落盘的自定义提示词回灌实时配置；文件不存在 / 为空时清空为内置提示词。
   * 读取失败只告警并保留内存现值，绝不让启动流程失败。
   */
  public async restoreCustomPrompt(): Promise<void> {
    try {
      const prompt = await readCustomPromptFile(this.wikiDir);
      const topicPrompt = await readTopicPromptFile(this.wikiDir);
      this.promptOverrides.system = prompt;
      this.promptOverrides.topic = topicPrompt;
      this.dispatcher.setPromptOverrides({ system: prompt, topic: topicPrompt });
      if (prompt.length > 0) {
        this.logger?.info(
          `[Patchouli] 已载入自定义系统提示词（.patchouli/custom-prompt.txt，${prompt.length} 字符），内置提示词被整段覆盖`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[Patchouli] 读取自定义系统提示词失败，沿用内置提示词: ${msg}`);
    }
  }

  /**
   * 保存自定义提示词：原子落盘 + 热更新实时配置（空白内容 = 恢复默认并删除落盘文件）。
   * 悬浮窗设置页的「保存并应用」/「恢复默认」都走这一条路径。
   */
  public async saveCustomPrompt(prompt: string): Promise<void> {
    const next = await persistCustomPrompt(this.wikiDir, prompt);
    this.promptOverrides.system = next;
    this.dispatcher.setPromptOverrides({ system: next });
  }

  /** 保存主题聚合提示词：原子落盘 + 热更新，只影响主题校准。 */
  public async saveTopicPrompt(prompt: string): Promise<void> {
    const next = await persistTopicPrompt(this.wikiDir, prompt);
    this.promptOverrides.topic = next;
    this.dispatcher.setPromptOverrides({ topic: next });
  }

  /** 当前主题校准运行时参数（只读副本）。 */
  public getTopicSettings(): typeof this.config.topics {
    return { ...this.topicRuntime };
  }

  /**
   * 订阅表编译快照：表为空时是旧配置（`channels` + `albumDelivery`）的镜像。
   * 纯函数、无缓存——行数上限 256，每次重算的成本远低于失效风险。
   *
   * 值域优先级：`settings.json` 的 `subscriptions` 键 > 宿主 config 的 `subscriptions`。
   */
  public subscriptions(): SubscriptionSnapshot {
    return compileSubscriptions(this.config, this.subscriptionOverride ?? undefined);
  }

  /**
   * 订阅表视图（面板 `GET /api/subscriptions` 的 rows + 来源）。
   *
   * `source` 明确告诉前端「现在生效的是面板覆盖层还是宿主 yml」，
   * 面板据此决定是否提示「保存后会接管 yml 里的表」。
   */
  public subscriptionTable(): { rows: SubscriptionRow[]; source: 'settings' | 'config' } {
    const override = this.subscriptionOverride;
    return {
      rows: resolveRows(this.config, override ?? undefined),
      source: override === null ? 'config' : 'settings',
    };
  }

  /**
   * 当前绑定表（只读副本）：`apply()` 注入的变更回调拿它重装投递期解析表。
   *
   * 投递期解析只认这张表——它不是候选的反解表，候选怎么变都不影响已绑定的收件人。
   */
  public targetBindingsSnapshot(): Record<string, string> {
    return { ...this.targetBindings };
  }

  /**
   * 把**生效**的订阅关系打进插件日志：`监听群 → 投递目标（启用动作）`，每条一行便于 grep。
   *
   * 只在启动完成与订阅表保存成功后调用；相册探测只刷新候选标签，关系没变，不重打。
   */
  private logSubscriptionSummary(): void {
    for (const line of formatSubscriptionLogLines(this.subscriptionTable().rows)) {
      this.logger?.info(line);
    }
  }

  /**
   * 校验并持久化订阅表（面板 `POST /api/subscriptions` 的唯一入口）。
   *
   * 落盘位置是 `.patchouli/settings.json` 的顶层 `subscriptions` 键（原子写 + 与标量段
   * 共用串行链），**绝不写宿主 config**。`allowedTargets` 是候选唯一名 ∪ 稳定地址 ∪
   * 现有值（空集合时只做形状校验，见 `validateSubscriptionRows` / `targetIssue`）。
   *
   * **保存时绑定**：同一行里的可读名用 `albums`（此刻的相册候选）解析成 `群号/相册ID`，
   * 与订阅表**同一次原子落盘**写进 `targetBindings`。已有绑定只要相册还看得见就原样保留；
   * 解析不到 / 相册已消失的名字保留在行里但**不绑定**，进 `unresolved` 由面板提示、日志
   * warn——投递期它会停投，绝不会改投到同名相册。
   */
  public async updateSubscriptions(
    rows: unknown,
    allowedTargets: ReadonlySet<string>,
    albums: readonly AlbumCandidate[] = [],
  ): Promise<{ ok: true; rows: SubscriptionRow[]; unresolved: string[] } | { ok: false; error: string }> {
    const validated = validateSubscriptionRows(rows, allowedTargets);
    if (!validated.ok) return { ok: false, error: validated.error };
    // 已有绑定是「上一次保存时的解析结论」：相册仍可见就原样保留（名字换主也不换收件人），
    // 看不见了才掉绑并上报 → 停投 + 告警，绝不给同名相册当替身。
    // `subscriptionOverride` 是上一次**落盘**的行：名字在里面却不在绑定表里 = 上次就掉绑了，
    // 本次同样的行不再重解析（否则下一次保存会把它绑到新群恰好同名的相册上）。
    // 只在绑定表建立过时才算标记：升级前只有 yml 时名字还没解析过，必须照常解析。
    const previousRows: readonly SubscriptionRow[] = this.bindingTableEstablished
      ? this.subscriptionOverride ?? []
      : [];
    const { bindings, unresolved } = resolveTargetBindings(validated.rows, albums, this.targetBindings, previousRows);
    // 落盘失败是真故障（磁盘 / 权限），直接抛出由 HTTP 层归 500，不能伪装成 400。
    const stored = await writeSubscriptionOverride(this.wikiDir, validated.rows, bindings);
    this.subscriptionOverride = stored.rows;
    // 绑定表整份替换：新表只认本次解析成功的名字。
    // 这次写盘同时带上迁移完成标记（`writeSubscriptionOverride` 的语义：显式给绑定 = 用户
    // 对绑定做了选择，删空也算），所以从这一刻起名字没绑上就是掉绑，不再自动重解析。
    this.targetBindings = stored.bindings;
    this.bindingTableEstablished = true;
    if (unresolved.length > 0) {
      this.logger?.warn(
        `[Patchouli] 订阅目标未绑定（投递期会停投）：${unresolved.join('、')} —— 请重新选择相册`,
      );
    }
    // 新表可能改变监听范围：白名单群立即登记为已监测（静默群产出真实 0）。
    this.markWhitelistedChannelsMonitored();
    // 新表可能引入新目标：立刻重注入候选与解析表，配置页的标签文案不必等下一轮相册探测。
    this.onSubscriptionsChanged?.();
    this.logSubscriptionSummary();
    return { ok: true, rows: resolveRows(this.config, stored.rows ?? undefined), unresolved };
  }

  /**
   * 主题校准运行时参数的**可变引用**：仅供 `TopicScheduler` 持有以实时读热更新值，
   * 外部（面板 / API）一律走 `updateTopicSettings`，不要直接写。
   */
  public get topicConfig(): typeof this.config.topics {
    return this.topicRuntime;
  }

  /**
   * 更新并持久化主题校准参数；未知字段丢弃、数值夹进硬限幅。
   *
   * 落盘目标是 `.patchouli/settings.json` 的 `topics` 段（与新的设置面板同源），
   * 不再写旧的 `topics-settings.json`。宿主 config 保持只读（ADR-022）。
   */
  public async updateTopicSettings(patch: unknown): Promise<typeof this.config.topics> {
    const checked = validateSettingsPatch('topics', normalizeTopicSettingsPatch(patch));
    if (checked.ok) {
      const overrides = await writeSettingsOverrides(
        this.wikiDir,
        'topics',
        checked.value,
        this.settingsRepairContext(),
      );
      this.settingsOverrides = overrides;
    }
    // 与 applySettingsOverrides 同一契约：值变了就重排定时器（`/api/topics/settings` 是另一条写入口）。
    const topicsBefore = { ...this.topicRuntime };
    Object.assign(this.topicRuntime, this.mergedSection('topics'));
    if (!deepEqual(topicsBefore, this.topicRuntime)) this.topicScheduler?.reschedule();
    return this.getTopicSettings();
  }

  /**
   * 回收长期空闲的群级运行时（detector / 遥测 / 流量桶 / 水位 / 素材登记）。
   *
   * 这些都是按 channelId 常驻的 Map，此前只有显式 reset / 卸载才会清理——机器人被拉进的群
   * 只增不减。7 天无消息且无未结讨论的群，缓冲已空、基线也已衰减到地板，重建成本可忽略。
   */
  public sweepIdleChannels(idleMs: number = 7 * 86_400_000): string[] {
    const removed = this.detector.sweepIdleChannels(idleMs);
    for (const channelId of removed) {
      this.inspector.forgetChannel(channelId);
      this.tuningClocks.delete(channelId);
      this.deliveredWatermarks.delete(channelId);
      this.trafficBuckets.delete(channelId);
      this.trafficMonitorStart.delete(channelId);
      this.latestMessages.delete(channelId);
      this.mediaRegistry.clearChannel(channelId);
    }
    if (removed.length > 0) {
      this.logger?.info(`[Patchouli] 已回收 ${removed.length} 个空闲群的状态（阈值 7 天）`);
    }
    return removed;
  }

  /** 当前出图选项（只读副本）。 */
  public getCardSettings(): CardSettings {
    return { ...this.cardSettings };
  }

  /** 更新并持久化出图选项；未知字段丢弃，落盘成功后才算生效。 */
  public async updateCardSettings(patch: unknown): Promise<CardSettings> {
    const normalized = normalizeCardSettingsPatch(patch);
    Object.assign(this.cardSettings, normalized);
    await writeCardSettings(this.wikiDir, this.cardSettings);
    return this.getCardSettings();
  }

  /** 回灌面板保存的出图选项（文件缺失即默认值：匿名化开启）。 */
  private async restoreCardSettings(): Promise<void> {
    this.cardSettings = await readCardSettings(this.wikiDir);
  }

  /**
   * 白名单群在启动时即登记为已监测（静默周期产出真实 0）。
   * 起点取**下一个 5 秒整刻度**，避免把启动当刻的半截桶冒充完整采样。
   */
  private markWhitelistedChannelsMonitored(): void {
    if (!this.config.enabled) return;
    const startBucket = Math.ceil(Date.now() / TRAFFIC_SAMPLE_MS) * TRAFFIC_SAMPLE_MS;
    // 订阅表为空时沿用旧白名单；`null` = 全部群，无法预登记，等消息到达自然登记。
    const channels = listeningGroupIds(this.subscriptions());
    if (channels === null) return;
    for (const channelId of channels) {
      if (!this.trafficMonitorStart.has(channelId)) {
        this.trafficMonitorStart.set(channelId, startBucket);
      }
    }
  }

  /**
   * 把一条被接受的群消息计入其所属的服务器墙钟 5 秒桶。
   *
   * 起点只在「尚未监测」或「本条消息早于已登记起点」时才登记：
   * 白名单静默群的半截启动桶因此不会被伪造成 0，而半桶内真实到达的消息仍保留实际计数。
   * 桶按 `Date.now()` 定位，已闭合的桶永不回溯改写；同时裁剪窗口外的旧桶。
   */
  private recordTraffic(channelId: string): void {
    try {
      const bucket = Math.floor(Date.now() / TRAFFIC_SAMPLE_MS) * TRAFFIC_SAMPLE_MS;
      const monitorStart = this.trafficMonitorStart.get(channelId);
      if (monitorStart === undefined || bucket < monitorStart) {
        this.trafficMonitorStart.set(channelId, bucket);
      }

      let buckets = this.trafficBuckets.get(channelId);
      if (!buckets) {
        buckets = new Map<number, number>();
        this.trafficBuckets.set(channelId, buckets);
      }
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);

      const floor = bucket - TRAFFIC_CAPACITY * TRAFFIC_SAMPLE_MS;
      for (const key of buckets.keys()) {
        if (key < floor) buckets.delete(key);
      }
    } catch (error) {
      // 流量统计仅用于展示，异常不得影响消息处理与沉淀主流程；但绝不静默吞错。
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`[Patchouli] 流量桶写入失败（仅影响监控曲线）: ${redactUrls(detail)}`);
    }
  }

  /**
   * 读取某群的流量序列（副本，按时间升序）。
   *
   * 纯读：只按 `now` 展开已闭合的桶，不调用 detector、不推进状态机。
   * 已监测但无消息的桶补真实 0；未监测的周期不出现；从未跟踪的群返回空数组。
   */
  public getTraffic(channelId: string, limit: number = TRAFFIC_CAPACITY, now: number = Date.now()): TrafficPoint[] {
    const monitorStart = this.trafficMonitorStart.get(channelId);
    if (monitorStart === undefined) return [];

    const requested = Number.isFinite(limit) ? Math.trunc(limit) : TRAFFIC_CAPACITY;
    const cap = Math.max(1, Math.min(TRAFFIC_CAPACITY, requested));
    const currentBucket =
      Math.floor((Number.isFinite(now) ? now : Date.now()) / TRAFFIC_SAMPLE_MS) * TRAFFIC_SAMPLE_MS;
    const lastClosed = currentBucket - TRAFFIC_SAMPLE_MS;
    if (lastClosed < monitorStart) return [];

    const buckets = this.trafficBuckets.get(channelId);
    const earliest = Math.max(monitorStart, lastClosed - (cap - 1) * TRAFFIC_SAMPLE_MS);
    const points: TrafficPoint[] = [];
    for (let timestamp = earliest; timestamp <= lastClosed; timestamp += TRAFFIC_SAMPLE_MS) {
      points.push({ timestamp, count: buckets?.get(timestamp) ?? 0 });
    }
    return points;
  }

  /**
   * 缓存本群最新一条被接受的消息预览（每群至多 1 条，按接受顺序覆盖）。
   *
   * 只保留 `id / channelId / userName / content / timestamp / elements`：`raw`（Koishi 事件对象）
   * 与 `userId` 一律不进入缓存，避免把无关隐私字段暴露给浏览器。
   * `content` 先剥离 Koishi markup 并截断，`elements` 深冻结（缓存内视为不可变，读取可安全共享引用）；
   * 同时把元素里的公网媒体地址登记进 `mediaRegistry`（旧条目的 opaqueId 立即失效）。
   */
  private recordLatestMessage(msg: ChatMessage, elements: readonly RichMessageElement[]): void {
    const frozen = freezeElements(elements);
    this.latestMessages.set(msg.channelId, {
      id: msg.id,
      channelId: msg.channelId,
      userName: msg.userName,
      content: toMessagePreview(msg.content),
      timestamp: msg.timestamp,
      elements: frozen,
    });
    this.mediaRegistry.setChannelMedia(msg.channelId, collectMediaUrls(frozen));
  }

  /**
   * 读取某群最新一条消息预览（副本）；从未接受过消息的群返回 `null`。
   * 纯读：不触碰触发器状态机，也不产生任何副作用。
   * `elements` 为深冻结的不可变树，副本与缓存安全共享引用。
   */
  public getLatestMessage(channelId: string): LatestMessage | null {
    const cached = this.latestMessages.get(channelId);
    return cached === undefined ? null : { ...cached };
  }

  /** 加载即建全 llmwiki 骨架：`raw/sessions/`、`wiki/debates/`、`.patchouli/`。 */
  private async ensureStorageLayout(): Promise<void> {
    try {
      await ensureWikiLayout(this.wikiDir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[Patchouli] 初始化 llmwiki 目录结构失败 (${this.wikiDir}): ${msg}`);
    }
  }

  private async restorePersistedCadenceStates(): Promise<void> {
    try {
      const snapshots = await this.localStore.listCadenceStates();
      for (const snap of snapshots) {
        // 逐群隔离：某群快照里的参数非法（如历史遗留的 `thetaMin: 0` 现在会被
        // `normalizeTriggerOptions` 拒绝）时只跳过该群，不能让其余群的校准全部丢失。
        try {
          if (snap.options && Object.keys(snap.options).length > 0) {
            this.detector.updateOptions(snap.channelId, snap.options);
          }
          // 快照时间即 AIMD 的上次校准时刻：重启不重置时间衰减，也不重复叠加步进。
          if (Number.isFinite(snap.updatedAt)) {
            this.tuningClocks.set(snap.channelId, snap.updatedAt);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger?.warn(`[Patchouli] 群 ${snap.channelId} 的节奏快照不可用，已按默认参数运行: ${msg}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[Patchouli] 恢复自适应基线快照失败: ${msg}`);
    }
  }

  /**
   * 接受一条群消息（`enabled` + 白名单校验之后的唯一入口）。
   *
   * 时序契约：
   *   1. **同步**完成流量桶计数、文本兜底预览落地与 detector 投递——异步富解析绝不阻塞它们；
   *   2. 随后在内部完成富元素解析（只读 `get_msg` / `get_forward_msg` / `get_image`，无任何 RPC 暴露），
   *      失败一律转成元素上的可见 error 文本，绝不造假 URL / 假图片，也不向外抛错；
   *   3. 富结果只在「该群缓存仍是本条消息 id」时写入——晚到的旧解析不会覆盖新消息。
   *
   * `context` 只用于本次解析（OneBot 原始段、Koishi 元素、引用对象、只读通道），
   * 绝不持久化，也绝不写入 `ChatMessage.raw`。
   */
  public async onIncomingMessage(msg: ChatMessage, context?: RichMessageContext): Promise<void> {
    if (!this.config.enabled) return;
    if (!isListening(this.subscriptions(), msg.channelId)) {
      return;
    }

    // 只统计真正被接受的群消息；写入只落到当前 5 秒桶，绝不推进 detector 状态机。
    this.recordTraffic(msg.channelId);
    this.recordLatestMessage(msg, textFallbackElements(toMessagePreview(msg.content)));
    this.detector.onMessage(msg);
    // 主动书记员（§7.2）：录制中的群逐条追加到 `<wikiDir>/.patchouli/scribe/<channelId>.jsonl`；
    // 已不在录制（手动结束 / 2h 熔断结算）但本进程写过文件的群，顺手在此清理残留。
    // 内部走串行队列并自吞异常，`void` 掉即可，绝不阻塞也不影响消息主流程。
    // 水位取 `onMessage` **之后**的 `lastSettledTime`：本条消息若触发了软切片，水位已经前进，
    // 落盘的就是新水位，重启恢复时不会把刚交付的片段再交一次。
    const recording = this.detector.isManualRecording(msg.channelId);
    void this.scribe.syncMessage(
      msg,
      recording,
      // 原始时间域水位；不是 detector 的逻辑时间（跨域比较会丢消息）。
      recording ? (this.deliveredWatermarks.get(msg.channelId) ?? 0) : 0,
    );

    // 边界标注（§4.4）：热路径上只做纯内存 L0 push；`observe` 内部自吞全部异常，
    // `void` 掉不会产生未处理的 rejection，也绝不阻塞下面的富消息解析。
    if (this.judgeClient.options.enabled) {
      void this.boundaryAnnotator.observe({
        channelId: msg.channelId,
        id: msg.id,
        userId: msg.userId,
        userName: msg.userName,
        text: msg.content,
        at: msg.timestamp,
      });
    }

    try {
      const elements = await parseRichElements(
        { ...context, content: context?.content ?? msg.content },
        { warn: (message) => this.logger?.warn(`[Patchouli] ${message}`) },
      );
      const current = this.latestMessages.get(msg.channelId);
      if (!current || current.id !== msg.id) return;
      this.recordLatestMessage(msg, elements);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`[Patchouli] 富消息解析失败，保留纯文本预览: ${redactUrls(detail)}`);
    }
  }

  /**
   * 抛开「触发 → 沉淀」两维之后的第三维：闭环调节。
   *
   * 调度器每轮只交付无量纲质量信号（`qualityScore` + `discardReason`），
   * 由宿主 AIMD 控制器把它们折算成两个物理闸门（`minBurstRate` /
   * `minDiscussionMessages`）的微小步进，并立即持久化到该群的节奏快照。
   * 运行时失败同样进来一次：零分且非丢弃的信号只触发时间向心力衰减，
   * 不会把门限继续往上抬。
   */
  /**
   * AIMD 步进入口：**按群串行**。
   *
   * `applyAimdTuningOnce` 是「读 before → 算 → 写 options」的读-改-写，两轮结算并发时
   * 会基于同一份 before 各算一次，后写覆盖先写（一次质量信号永久丢失）。这里用一条
   * per-channel Promise 链把同群的步进排成先后，跨群仍并行。
   */
  private async applyAimdTuning(channelId: string, signal: TuningSignal): Promise<void> {
    const previous = this.tuningChains.get(channelId) ?? Promise.resolve();
    const task = previous.then(
      () => this.applyAimdTuningOnce(channelId, signal),
      () => this.applyAimdTuningOnce(channelId, signal),
    );
    this.tuningChains.set(channelId, task.then(
      () => undefined,
      () => undefined,
    ));
    return task;
  }

  private async applyAimdTuningOnce(channelId: string, signal: TuningSignal): Promise<void> {
    if (this.config.dispatcher.enableAutoTuning === false) return;

    const before = this.detector.getOptions(channelId);
    // 步进落在**真正裁决相位**的门限上：`rate` / `shadow` 由速率判据裁决，`potential` 由 Q/ρ 裁决。
    // 例外是 shadow 对照：开门 `potentialAutoTuning` 后两套门限同步步进（`both`），
    // 让势能侧也用同一个控制器追平本群量级——否则它只吃时间衰减，比较时天然被让子。
    const target: TuningTarget =
      before.triggerMode === 'potential'
        ? 'potential'
        : before.triggerMode === 'shadow' && before.potentialAutoTuning === true
          ? 'both'
          : 'rate';
    const tuning = updateParameters(
      { ...before, lastUpdated: this.tuningClocks.get(channelId) },
      signal,
      // 锚点是**当前生效值**（覆盖层 > 宿主 config）：拿 `this.config.trigger` 会让面板里
      // 改过的 `thetaMin` 在每次 AIMD 步进后被时间向心力拉回 yml 基线。
      this.settings('trigger'),
      Date.now(),
      { target },
    );

    this.detector.updateOptions(channelId, tuning.parameters);
    this.tuningClocks.set(channelId, tuning.lastUpdated);

    const updated = this.detector.getOptions(channelId);
    await this.localStore.saveCadenceState({
      channelId,
      options: updated,
      metrics: this.detector.getStatus(channelId, undefined, { settle: false }),
      updatedAt: tuning.lastUpdated,
    });

    const step =
      `minBurstRate ${before.minBurstRate}→${tuning.parameters.minBurstRate}, ` +
      `thetaMin ${before.thetaMin}→${tuning.parameters.thetaMin}, ` +
      `minDiscussionMessages ${before.minDiscussionMessages}→${tuning.parameters.minDiscussionMessages}`;
    this.logger?.info(
      `[Patchouli] AIMD 调节 (群 ${channelId}, ${target}): ${tuning.action} | ${step} | 时间衰减 ×${tuning.decayFactor.toFixed(3)}` +
        (tuning.clamped.length > 0 ? ` | 触及物理边界: ${tuning.clamped.join(', ')}` : ''),
    );
  }

  /**
   * 把一轮被丢弃的讨论连同判定依据留证到 `.patchouli/discards/<date>-<sessionId>.json`。
   *
   * 为什么必须留证：`discardReason` / `qualityScore` 是模型自评，事后无法复核。
   * 只留一行日志时，「这轮确实没料」与「判据过严误杀」不可区分。
   *
   * 开关：`observability.discardDumps`，缺省关闭——普通用户不需要排障证据，
   * 也不该为此付磁盘。开启后仍受份数 / 字节 / 单条长度三重硬上限约束。
   * 纯观测路径：任何 IO 异常都降级为告警，绝不影响沉淀主流程与 AIMD 闭环。
   */
  private async recordDiscard(session: DiscussionSession, verdict: DiscardVerdict): Promise<void> {
    if (this.config.observability?.discardDumps !== true) return;
    try {
      const saved = await saveDiscardDump({ dir: this.discardsDir, session, verdict });
      if (saved.pruned.length > 0) {
        this.logger?.info(`[Patchouli] 丢弃留证已轮转：移除 ${saved.pruned.length} 份最早文件`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[Patchouli] 丢弃留证写入失败: ${msg}`);
    }
  }

  private static costSuffix(result: DispatcherResult): string {
    const parts: string[] = [];
    if (result.tokensUsed !== undefined) parts.push(`tokens ${result.tokensUsed}`);
    if (result.contractRetries !== undefined && result.contractRetries > 0) parts.push(`契约重试 ${result.contractRetries} 次`);
    return parts.length > 0 ? `；${parts.join('，')}` : '';
  }

  private async handleQuiescence(session: DiscussionSession): Promise<void> {
    this.logger?.info(
      `[Patchouli] 群 ${session.channelId} 讨论平息，开启迟智沉淀。消息数: ${session.messages.length}，峰值速率: ${session.peakRate.toFixed(1)}/m`
    );

    try {
      // 调度质量门（`trigger.dispatchMargin`）：峰值只是**勉强过阈**时不值得烧一次云端大模型。
      // 判据由势能侧给出（`potentialPeak` 由 detector 在 potential/shadow 结算时填充），
      // 放在 judge 门控之前：门控要调本地裁判，这一层连裁判都不用调。
      // 自家闸门不构成证据——跳过时不再做 AIMD 步进（否则「门越紧 → 门限越高」自激）。
      // 读**该群生效值**（面板逐群调校可改）；缺省落回全局配置 / DEFAULT，语义不变。
      const margin = this.detector.getOptions(session.channelId).dispatchMargin ?? 0;
      const peak = session.potentialPeak;
      if (
        session.partial !== true &&
        peak !== undefined &&
        margin > 0 &&
        peak.quality < peak.burstThreshold * margin
      ) {
        const threshold = peak.burstThreshold * margin;
        this.logger?.info(
          `[Patchouli] 群 ${session.channelId} 峰值质量未达调度门限，跳过云端调度` +
            `（peakQ=${peak.quality.toFixed(3)} < ${threshold.toFixed(3)}` +
            ` = Θ_burst ${peak.burstThreshold.toFixed(3)} × ${margin}）`,
        );
        await this.recordDiscard(session, { kind: 'GATE', qualityScore: peak.quality });
        return;
      }

      // §7.3 门控：软切片（partial）语义不完整，不参与门控；裁判未启用时整段跳过。
      // 判为低密度时直接舍弃并把概率交给 AIMD，省下整轮云端大模型调度。
      if (session.partial !== true && this.judgeClient.options.enabled) {
        const verdict = await this.gate.evaluate(session);
        if (verdict.available === false) {
          // 服务故障绝不能被翻译成「全是水」：只留一条调试告警，照常走云端链路。
          this.logger?.debug?.(
            `[Patchouli] 群 ${session.channelId} 本地门控不可用，按原链路调度: ${verdict.reason ?? '未知原因'}`,
          );
        } else if (verdict.valuable === false) {
          this.logger?.info(
            `[Patchouli] 群 ${session.channelId} 本地门控判定低密度，跳过云端调度` +
              `（P=${verdict.probability.toFixed(3)}，${verdict.reason ?? LOW_DENSITY_REASON}）`,
          );
          await this.recordDiscard(session, {
            kind: 'MODEL',
            discardReason: 'LOW_DENSITY',
            qualityScore: verdict.probability,
          });
          await this.applyAimdTuning(session.channelId, {
            shouldDiscard: true,
            discardReason: 'LOW_DENSITY',
            qualityScore: verdict.probability,
          });
          return;
        }
      }

      // 调度器不再接收 / 产出任何参数建议：它只回答「这轮值不值钱、值多少」。
      const result = await this.dispatcher.dispatch(session);
      const quality = `质量分 ${result.qualityScore.toFixed(2)}`;

      if (result.success && result.entry) {
        // 1. 原始会话 dump (raw/sessions/<id>.json) + Markdown 词条 (wiki/debates/<id>.md) + index.md / log.md
        const writeRes = await this.wikiEngine.saveEntry(result.entry, { session });
        // 2. 写入本地结构化存储库
        await this.localStore.saveEntry(result.entry, writeRes.entryPath);

        this.logger?.info(
          `[Patchouli] 知识沉淀成功: 《${result.entry.title}》 -> ${writeRes.entryPath}` +
            ` (raw: ${writeRes.rawSessionPath}${writeRes.rawSessionCreated ? '' : '，已存在未覆写'}；${quality}` +
            `${PatchouliKnowledgeSystem.costSuffix(result)})`,
        );

        // 3. 词条卡片投递：产品决策（2026-11-10）改为「讨论结束即出图」，
        //    不再等周报；投递失败不影响沉淀结果，也不拖慢结算。
        if (this.entryCardDeliveryEnabled()) {
          const sink = this.entryCardSink;
          if (sink !== undefined) {
            void sink(result.entry.id, session.channelId).catch((error: unknown) => {
              this.logger?.warn(`[Patchouli] 词条投递异常: ${String(error)}`);
            });
          }
        }

        // 4. 是否在群内轻量播报
        if (this.config.notifyOnSummarized && this.onNotify) {
          const notifyText =
            `[PATCHOULI] llmwiki 知识阅读器\n` +
            `已生成并写入新词条：《${result.entry.title}》\n` +
            `摘要：${result.entry.summary}\n` +
            `指令：patchouli.show ${result.entry.id}`;
          await this.onNotify(session.channelId, notifyText);
        }
      } else if (result.discardReason !== null) {
        // 模型明确判定不值得沉淀：归因枚举本身即调节信号。
        this.logger?.info(`[Patchouli] 本轮讨论主动舍弃 (${result.discardReason}，${quality}${PatchouliKnowledgeSystem.costSuffix(result)})`);
        await this.recordDiscard(session, {
          kind: 'MODEL',
          discardReason: result.discardReason,
          qualityScore: result.qualityScore,
          ...(result.tokensUsed === undefined ? {} : { tokensUsed: result.tokensUsed }),
          ...(result.contractRetries === undefined ? {} : { contractRetries: result.contractRetries }),
        });
      } else {
        // 运行时失败 / 取消 / 输出不可解析：与「判定为噪声」严格区分。
        this.logger?.warn(
          `[Patchouli] 本轮调度未产出词条 (${quality}${PatchouliKnowledgeSystem.costSuffix(result)}): ${result.failureReason ?? '未知原因'}`,
        );
        await this.recordDiscard(session, {
          kind: 'FAILURE',
          qualityScore: result.qualityScore,
          failureReason: result.failureReason ?? '未知原因',
          ...(result.tokensUsed === undefined ? {} : { tokensUsed: result.tokensUsed }),
          ...(result.contractRetries === undefined ? {} : { contractRetries: result.contractRetries }),
        });
      }

      // 4. 闭环第三维：质量信号 → AIMD 门限步进 → 该群快照持久化
      if (session.partial === true) {
        // 软切片交付的是进行中讨论的中间段，语义必然不完整（模型通常判 FRAGMENTED）。
        // 若据此步进 AIMD，会形成「切得越碎 → 门限越高 → 越难再触发」的自激抬升。
        this.logger?.info(
          `[Patchouli] 群 ${session.channelId} 软切片交付不参与 AIMD 门限调节` +
            `（片段 ${session.messages.length} 条，${quality}）`,
        );
      } else {
        await this.applyAimdTuning(session.channelId, {
          shouldDiscard: result.discardReason !== null,
          discardReason: result.discardReason,
          qualityScore: result.qualityScore,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error(`[Patchouli] 沉淀处理发生异常: ${msg}`);
    } finally {
      // 带会话 id 释放：迟到的上一轮完成回调不得清掉当前轮的闩锁。
      this.detector.completeSummarizing(session.channelId, session.sessionId);
    }
  }

  /**
   * 某群当前 AIMD 门限的只读视图（`GET /api/status` 的 `tuning` 字段）。
   * 纯读：不推进状态机、不落盘。
   */
  public getTuningSnapshot(channelId: string): TuningSnapshot {
    const options = this.detector.getOptions(channelId);
    return {
      parameters: {
        minBurstRate:
          typeof options.minBurstRate === 'number' ? options.minBurstRate : DEFAULT_TUNING_PARAMETERS.minBurstRate,
        minDiscussionMessages:
          typeof options.minDiscussionMessages === 'number'
            ? options.minDiscussionMessages
            : DEFAULT_TUNING_PARAMETERS.minDiscussionMessages,
        thetaMin:
          typeof options.thetaMin === 'number' ? options.thetaMin : DEFAULT_TUNING_PARAMETERS.thetaMin,
      },
      limits: TUNING_LIMITS,
      decayFactor: TUNING_DECAY_FACTOR,
      highQualityThreshold: HIGH_QUALITY_THRESHOLD,
      lastUpdated: this.tuningClocks.get(channelId) ?? null,
    };
  }

  /**
   * 把某群当前生效的触发参数与度量快照落盘（管理员手动校准复用），
   * 并同步 AIMD 时间基准——刚手动设定的门限不会在下一轮被当作陈旧值向锚点衰减。
   */
  public async persistCadenceState(channelId: string, updatedAt: number = Date.now()): Promise<CadenceStateSnapshot> {
    const saved = await this.localStore.saveCadenceState({
      channelId,
      options: this.detector.getOptions(channelId),
      metrics: this.detector.getStatus(channelId, undefined, { settle: false }),
      updatedAt,
    });
    this.tuningClocks.set(channelId, updatedAt);
    return saved;
  }

  /**
   * 记录一次「外部已自行落盘」的校准时刻（`/api/tune` 沿用既有 store 写入路径时使用），
   * 只同步 AIMD 的时间衰减基准，不重复写盘。
   */
  public noteCadenceUpdate(channelId: string, updatedAt: number): void {
    this.tuningClocks.set(channelId, updatedAt);
  }

  /**
   * 主题校准的目标群——定时调度与 `POST /api/topics` 共用这一份判定。
   *
   * 订阅表生效（`topicGroups !== null`）时只跑订阅来源群：`config.channels` 里残留的旧群
   * 不该被批量校准顺手烧一遍模型。表为空时才回退旧白名单，再回退库里出现过的群。
   * `features.topics === false` 返回空表（总闸关掉时没有目标）。
   */
  public async topicTargets(): Promise<string[]> {
    if (this.config.features.topics === false) return [];
    const snapshot = this.subscriptions();
    if (snapshot.topicGroups !== null) return [...snapshot.topicGroups];
    return this.config.channels.length > 0 ? [...this.config.channels] : this.localStore.listChannels();
  }

  /** 由 `apply()` 挂入调度器实例；挂入后 `runTopics()` 经调度器执行并记水位。 */
  public attachTopicScheduler(scheduler: TopicScheduler): void {
    this.topicScheduler = scheduler;
  }

  /**
   * 立即对指定群执行一次「主题校准」。
   *
   * 幂等由聚合器把守：已归入任何主题的词条不再参与，窗口内没有剩余条目时返回 `no-entries`；
   * 模型失败返回 `model-failed` 且零写入。
   *
   * 调度器就位后走它执行：与定时 tick 共用单群锁，并写入日切水位——
   * 手动跑完当天 04:00 不会再跑一次。调度器未挂入（单测 / 裸 system）时直接执行。
   */
  public async runTopics(
    channelId: string,
    options: { force?: boolean; now?: number } = {},
  ): Promise<TopicRunResult> {
    if (this.topicScheduler !== undefined && options.now === undefined) {
      return this.topicScheduler.runChannelNow(channelId, options.force ?? true);
    }
    return this.runTopicsDirect(channelId, options);
  }

  /**
   * 直接执行一次主题校准、不写日切水位（调度器与需要绕过水位的场景使用）。
   *
   * 开关 / 幂等 / 零写入语义全部由聚合器把守，这里只透传。
   *
   * **功能总闸在这里也要判**：`features.topics === false` 时调度器的 `channels()` 返回空表
   * （定时轮空），但管理入口 `/api/topics` 走的是 `runTopics` → 调度器 `runChannelNow`
   * → 本方法，会绕过那张空表照样烧一次模型。返回与聚合器同一形状的 disabled 结果。
   */
  public async runTopicsDirect(
    channelId: string,
    options: { force?: boolean; now?: number } = {},
  ): Promise<TopicRunResult> {
    if (this.config.features.topics === false) {
      const result: TopicRunResult = {
        channelId,
        dayKey: formatDate(new Date(options.now ?? Date.now())),
        createdTopicIds: [],
        updatedTopicIds: [],
        assignedEntryIds: [],
        skippedReason: 'disabled',
      };
      this.lastTopicRun = result;
      return result;
    }
    const result = await this.topicCurator.runChannel(channelId, this.topicRuntime, options);
    this.lastTopicRun = result;
    return result;
  }

  /** 主题校准日切水位文件（`<wikiDir>/.patchouli/topics-state.json`）。 */
  public get topicsStatePath(): string {
    return joinPath(this.wikiDir, '.patchouli', 'topics-state.json');
  }

  /**
   * 删除单个知识词条：词条 Markdown、原始会话 dump、`index.md` / `log.md` 托管行
   * 与 `.patchouli/store.json` 元数据一并清除。
   *
   * 返回是否确实删除了任意一项；`id` 不存在时返回 `false`（幂等）。
   * 各群节奏快照不受影响。
   */
  public async deleteEntry(id: string): Promise<boolean> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('PatchouliKnowledgeSystem.deleteEntry: id 必填');
    }

    const record = await this.localStore.getEntry(id);
    const wikiResult = await this.wikiEngine.deleteEntry(id, record?.title);
    const storeDeleted = await this.localStore.deleteEntry(id);
    return wikiResult.ok || storeDeleted;
  }

  /**
   * 清空知识库：全部词条产物（Markdown / 原始 dump / 索引 / 流水）与元数据清单。
   *
   * 保留 `wiki/debates`、`raw/sessions`、`.patchouli` 目录骨架，以及各群节奏快照
   * （AIMD 学到的门限不随知识库清空丢失）。
   */
  public async clearKnowledgeBase(): Promise<void> {
    await this.wikiEngine.clearAllEntries();
    await this.localStore.clearEntries();
  }

  public dispose(): void {
    // **卸载路径不可抛**：任何一项清理失败都记日志后继续。
    // 抛出去会让 loader 的 stop 流程在「移除配置项」之前中断，表现为
    // 「点停止 → 一两秒后又 apply 回来」，同时 yml 被写回启用态。
    const safe = (label: string, task: () => void): void => {
      try {
        task();
      } catch (error) {
        this.logger?.warn?.(
          `[Patchouli] 卸载清理失败（${label}）: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    safe('idleSweepTimer', () => {
      if (this.idleSweepTimer !== null) {
        clearInterval(this.idleSweepTimer);
        this.idleSweepTimer = null;
      }
    });
    // 先还原猴子补丁，再销毁被织入对象：保证卸载过程中不会调用到已清空的遥测状态。
    safe('inspector', () => this.inspector.dispose());
    safe('trafficBuckets', () => this.trafficBuckets.clear());
    safe('trafficMonitorStart', () => this.trafficMonitorStart.clear());
    safe('latestMessages', () => this.latestMessages.clear());
    safe('mediaRegistry', () => this.mediaRegistry.clear());
    safe('tuningClocks', () => this.tuningClocks.clear());
    safe('boundaryAnnotator', () => this.boundaryAnnotator.reset());
    // 关闭并排空台账：`close()` 返回排空 Promise，已入队的 digest 残片 / 回执仍会落盘。
    safe('shadowLedger', () => {
      void this.shadowLedger.close().catch(() => undefined);
    });
    safe('detector', () => this.detector.dispose());
  }
}

export const inject = {
  optional: ['chatluna', 'server', 'console', 'miyako-delivery', 'puppeteer'],
};

/**
 * 声明可重入：插件全部状态挂在 `apply()` 的实例闭包与 `PatchouliKnowledgeSystem` 上，
 * `dispose()` 逐项还原（定时器 / 路由 / 猴子补丁 / 子 scope 订阅）。缺这一条时 loader
 * 认为实例不可复用，控制台在「已停用」状态下对着仍在注册表里的 runtime 报
 * 「此插件已在运行且不可重用」——启停看起来就不干净（0.8.55）。
 */
export const reusable = true;

/**
 * 宿主是否已有可挂路由的快照面。
 *
 * `registerWebUi` 在 `ctx.server` / 旧宿主自有 `ctx.router` 缺失时静默跳过；这里先判断，
 * 避免把「其实没挂上」记成幂等成功，害得 `ready` 不再重试。
 */
function hasWebRouter(ctx: Context): boolean {
  const host = ctx as unknown as {
    server?: { get?: unknown } | null;
    router?: { get?: unknown } | null;
  };
  const router = host.server ?? (Object.prototype.hasOwnProperty.call(host, 'router') ? host.router : undefined);
  return router !== undefined && router !== null && typeof router.get === 'function';
}

/**
 * 生成幂等的 WebUI 挂载闭包：`apply()` 与 `ready` 都会调用它，成功一次后不再重复注册，
 * 避免路由与 `TokenAuthority` 双份。路由器未就绪或注册抛错时不标记，留给 `ready` 重试。
 */
export function createWebUiRegistrar(
  ctx: Context,
  register: () => void,
  onError: (error: unknown) => void,
): () => void {
  let registered = false;
  return () => {
    if (registered || !hasWebRouter(ctx)) return;
    try {
      register();
      registered = true;
    } catch (error: unknown) {
      onError(error);
    }
  };
}

export function apply(ctx: Context, rawConfig: PluginOptions): void {
  // 控制台把高级段折叠在 `advanced` 里：运行时摊平回顶层，下游一律只读顶层键。
  const config: PluginOptions = flattenConfig(rawConfig);
  const logger = ctx.logger('patchouli');
  // 旧值无法唯一匹配时的告警出口（归一阶段会丢弃该值，绝不按名字猜投递目标）。
  installSubscriptionTargetWarnings((message) => logger.warn(`[Patchouli] ${message}`));
  // 历史值 auto / standalone 在运行时归一化为 chatluna / custom（调度器内部同一套映射）。
  const provider = normalizeDispatcherProvider(config.dispatcher.provider);

  // ChatLuna 服务位于注入作用域内：Koishi 4.18 的服务按配置分组隔离，插件 ctx 直接读取会得到 undefined，
  // 因此必须在 ctx.inject(['chatluna']) 的回调里取得句柄。
  let chatlunaHost: ChatLunaHostService | undefined;
  ctx.inject(['chatluna'], (injectedCtx: Context) => {
    chatlunaHost = getChatLunaHost(injectedCtx);
    if (chatlunaHost) {
      logger.info(
        `[Patchouli] ChatLuna 服务可用（当前 provider=${provider}，` +
          `${provider === 'chatluna' ? '沉淀走 ChatLuna 适配器' : '当前配置走自定义端点，ChatLuna 不参与'}）`,
      );
    }
  });

  // 端点字段只在 custom 生效；ChatLuna 通道由 ChatLuna 自己的适配器负责。
  const models = resolveDispatcherModels(config.dispatcher);
  const protocolId = config.dispatcher.protocol ?? 'auto';
  const formatId = config.dispatcher.responseFormat ?? 'json_object';
  if (provider === 'custom') {
    logger.info(
      `[Patchouli] 自定义端点已启用：协议=${protocolId === 'auto' ? '自动探测（Responses → Gemini → Chat Completions）' : protocolId}` +
        `，输出格式=${formatId}，baseURL=${config.dispatcher.baseURL ?? '默认'}，model=${models.customModel || '未填写'}`,
    );
  }
  ctx.on('ready', () => {
    if (provider !== 'chatluna') return;
    if (chatlunaHost) {
      logger.info(
        `[Patchouli] ChatLuna 通道已就绪：端点协议由 ChatLuna 适配器决定` +
          `（当前模型: ${models.chatlunaModel && models.chatlunaModel !== CHATLUNA_MODEL_INHERIT ? models.chatlunaModel : '继承平台默认'}）`,
      );
    } else {
      logger.warn(
        '[Patchouli] 配置要求 ChatLuna 通道，但 ChatLuna 服务未就绪：沉淀将失败。' +
          '请确认 koishi-plugin-chatluna 已加载且平台凭据有效，或把 provider 改为 custom 并填写端点。',
      );
    }
  });

  const chatlunaInvoker: ChatLunaInvoker = async ({ messages, model }) => {
    const host = chatlunaHost;
    if (!host) {
      throw new Error('ChatLuna 服务尚未就绪');
    }
    const rawModel = (model || models.chatlunaModel || '').trim();
    const configuredModel = rawModel === CHATLUNA_MODEL_INHERIT ? '' : rawModel;
    const targetModel = resolveChatLunaModel(host, configuredModel);
    const inherited = configuredModel.length === 0;
    if (!targetModel) {
      throw new Error(
        'ChatLuna 未声明默认模型：请在 ChatLuna 面板选择默认模型，或在本插件 dispatcher.chatlunaModel 显式填写（ChatLuna 模式下无需 apiKey / baseURL）'
      );
    }
    const separatorIndex = targetModel.indexOf('/');
    const platformName = separatorIndex > 0 ? targetModel.slice(0, separatorIndex) : targetModel;

    // ChatLuna 的平台客户端（模型清单）是异步装载的，未就绪时 createChatModel 会返回空模型
    if (typeof host.awaitLoadPlatform === 'function') {
      try {
        await host.awaitLoadPlatform(platformName, 30_000);
      } catch (err: unknown) {
        logger.warn(`[Patchouli] 等待 ChatLuna 平台 ${platformName} 就绪超时: ${String(err)}`);
      }
    }

    if (typeof host.createChatModel === 'function') {
      try {
        const modelRef = await host.createChatModel(targetModel);
        const chatModel = modelRef?.value;
        if (chatModel && typeof chatModel.invoke === 'function') {
          const startedAt = Date.now();
          const res = await chatModel.invoke(toLangChainMessages(messages, ctx.baseDir));
          const content = typeof res?.content === 'string' ? res.content : JSON.stringify(res?.content ?? '');
          logger.info(
            `[Patchouli] ChatLuna 调用成功: model=${targetModel}${inherited ? '（继承平台默认）' : ''} 耗时=${Date.now() - startedAt}ms 输出=${content.length} 字符`
          );
          return { content };
        }
        logger.warn(`[Patchouli] ChatLuna 未能实例化模型 ${targetModel}，尝试 invoke 兜底`);
      } catch (err: unknown) {
        logger.warn(`[Patchouli] ChatLuna createChatModel 失败，尝试 invoke 兜底: ${String(err)}`);
      }
    }
    if (typeof host.invoke === 'function') {
      const userPrompt = messages.map((m) => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n');
      const startedAt = Date.now();
      const res = await host.invoke({
        message: userPrompt,
        model: targetModel,
        persist: false,
        delivery: 'silent',
      });
      const reply = res.reply ?? (typeof res.message?.content === 'string' ? res.message.content : undefined);
      if (reply) {
        logger.info(
          `[Patchouli] ChatLuna invoke 成功: model=${targetModel}${inherited ? '（继承平台默认）' : ''} 耗时=${Date.now() - startedAt}ms 输出=${reply.length} 字符`
        );
        return { content: reply };
      }
    }
    throw new Error(`ChatLuna 无法为模型 ${targetModel} 提供有效响应`);
  };
  const system = new PatchouliKnowledgeSystem(
    config,
    logger,
    async (channelId: string, text: string) => {
      // 静默红线二次防线：严禁未经允许向群发任何广播
      if (!config.notifyOnSummarized) return;
      const platform = 'onebot';
      await deliverElements(
        ctx,
        { kind: 'channel', channelId: channelId.includes(':') ? channelId : `${platform}:${channelId}` },
        [h.text(text)],
      );
    },
    { chatluna: chatlunaInvoker },
    ctx.baseDir,
  );
  logger.info(`[Patchouli] llmwiki 存储根目录: ${system.wikiDir}`);
  // 重载即刷新订阅目标候选：模块顶层只求值一次，`require` 缓存让重载跳过它。
  // 同步能确定的范围只有订阅表里显式写出的监听群；`*` / 空表要枚举机器人所在群，
  // 那是异步的——先不过滤，`ready` 后的首轮探测会按真实范围收窄。
  // （不做这步预过滤的话，`albums.json` 里早先探测过的退订群相册会一直挂在候选里。）
  const startupProbe = subscriptionProbeSources(system.subscriptionTable().rows, config.channels);
  // 解析表用实例里的绑定表（构造期已读盘）：候选只决定下拉与展示文案。
  // 路径必须锚定 `ctx.baseDir`：进程 cwd 不是实例目录时读错配置会让静态 union 拒载整份配置。
  // `reload: true` 让重载看见磁盘上的新相册；同一个进程内仍按目录缓存，不重复读盘。
  let currentTargets = refreshSubscriptionTargets(
    { ...startupTargetValues(ctx.baseDir, { reload: true }), bindings: system.targetBindingsSnapshot() },
    startupProbe.listenAll ? undefined : startupProbe.explicit,
  );
  // 管理面密钥：配置留空且尚未初始化时，引导用户从面板完成（不再要求先上服务器抄 token）。
  if (config.security.apiToken.trim() === '' && !existsSync(system.apiTokenPath)) {
    logger.info(
      `[Patchouli] 管理面尚未初始化：打开面板会弹出「首次初始化」，生成的密钥写入 ${system.apiTokenPath}`,
    );
  }

  // 素材池补货：不阻塞插件挂载，断网 / 5xx 只留一条警告。
  void system.prefillMedia();

  // 投递闸门：词的定时窗口、每目标限量、随机抖动与批量外发都收敛到这里。
  // 状态独立落在 `.patchouli/delivery-state.json`（队列 + 每目标周期计数），
  // 与 `settings.json`（用户配置）分开：一次面板保存不该抹掉待投队列。
  const deliveryGate = new DeliveryGate({
    store: new DeliveryStateStore({ path: deliveryStatePath(system.wikiDir), logger }),
    policies: () => readTargetPolicies(system.wikiDir),
    render: async (item) => {
      // 进程重启后队列里只剩规格没有产物：词条按 id 重渲，周报产物随进程丢失（见 delivery-gate 注释）。
      if (item.kind !== 'entry') return undefined;
      const rendered = await renderEntryCard(ctx, system, item.eventKey, {
        maskNames: system.getCardSettings().maskNames,
        maxHeight: system.settings('query').cardMaxHeight,
      });
      return rendered.kind === 'image' ? rendered.image : undefined;
    },
    deliver: createBroadcastDeliver(ctx, logger),
    logger,
  });
  void deliveryGate.start().catch((error: unknown) => {
    logger.warn(`[Patchouli] 投递闸门启动失败: ${error instanceof Error ? error.message : String(error)}`);
  });

  /**
   * 词条投递目标的策略键：相册用稳定地址 `群号/相册ID`，群聊用 `@chat:<来源群>`。
   *
   * `@chat` 必须带来源群：同一个 `@chat` 在不同来源行里指向不同群，只写 `@chat` 会让策略互相覆盖。
   */
  function entryTargetKey(target: EntryDeliveryTarget, source: string): string {
    if (target.kind === 'album') return `${bareChannelId(target.channelId)}/${target.albumId}`;
    return `${CHAT_TARGET}:${bareChannelId(source)}`;
  }

  // 词条投递：每轮讨论沉淀后立刻出图并入队（相册目标复用「知识周报」的相册选择）。
  // `redirectChannelId` 非空时全部改发该群聊天，用于灰度观察。
  // 入队之后由闸门决定「什么时候发、还能发几条」：窗口外排队，超额丢弃。
  system.setEntryCardSink(async (entryId: string, sourceChannelId: string) => {
    // 功能总闸：词条投递关闭时直接返回（沉淀与索引照常，只是不外发）。
    if (config.features.entries === false) return;
    const albumConfig = config.albumDelivery;
    const snapshot = system.subscriptions();
    // 订阅表生效时按行投递；表为空时沿用旧的「全量相册 + 灰度改道」语义。
    const targets = snapshot.active
      ? entryTargetsFor(snapshot, sourceChannelId)
      : albumConfig.entryEnabled === false
        ? []
        : planEntryTargets(albumConfig.albums, albumConfig.entryRedirectChannelId, sourceChannelId);
    if (targets.length === 0) {
      logger.warn(
        snapshot.active
          ? `[Patchouli] 词条《${entryId}》未投递：订阅表里来源群 ${sourceChannelId} 没有可用的投递目标`
          : `[Patchouli] 词条《${entryId}》未投递：相册未选择且未配置改道目标`,
      );
      return;
    }
    const rendered = await renderEntryCard(ctx, system, entryId, {
      maskNames: system.getCardSettings().maskNames,
      maxHeight: system.settings('query').cardMaxHeight,
    });
    if (rendered.kind !== 'image') {
      logger.warn(`[Patchouli] 词条《${entryId}》出图失败（${rendered.kind}），本轮不投递`);
      return;
    }
    const offer = await deliveryGate.offer({
      kind: 'entry',
      source: sourceChannelId,
      eventKey: entryId,
      targets: targets.map((target) => ({ targetKey: entryTargetKey(target, sourceChannelId), target })),
      png: rendered.image,
    });
    const targetText = targets
      .map((target) => (target.kind === 'album' ? `相册 ${target.channelId}/${target.albumId}` : `群 ${target.channelId}`))
      .join('、');
    logger.info(
      `[Patchouli] 词条《${entryId}》投递入队 ${offer.accepted}/${targets.length}` +
        (offer.deferred > 0 ? `（${offer.deferred} 个待窗口）` : '') +
        (offer.dropped > 0 ? `（${offer.dropped} 个超额 / 队满丢弃）` : '') +
        `（来源群 ${sourceChannelId}，目标：${targetText}）`,
    );
  });

  // 服务加载顺序不由本插件决定：`optional` 注入不会等待 delivery 就绪，
  // 因此把探测推迟到 ready，避免「服务明明存在却报未接入」的假告警。
  ctx.on('ready', () => {
    const deliveryHost = ctx as unknown as Record<string, unknown>;
    if (deliveryHost['miyako-delivery'] && typeof (deliveryHost['miyako-delivery'] as { deliver?: unknown }).deliver === 'function') {
      logger.info("[Patchouli] 已接入 ctx['miyako-delivery']（主题推送与群相册上传可用）");
    } else {
      logger.warn("[Patchouli] 未检测到 ctx['miyako-delivery']：主题推送与群相册上传不可用，频道 / 相册投递将一律失败（NO_DELIVERY_SERVICE）");
    }
  });


  function deliveryAlbumService(): AlbumServiceLike | undefined {
    const host = ctx as unknown as Record<string, unknown>;
    const service = host['miyako-delivery'] as AlbumServiceLike | undefined;
    return service !== undefined && typeof service.listAlbums === 'function' ? service : undefined;
  }

  /**
   * 插件卸载标志。
   *
   * 相册探测是异步且可跨秒的：unload 之后探测才返回时，`ctx.schema.set` 会在已销毁的
   * context 上创建 effect，cordis 抛 `cannot create effect on inactive context`，
   * 卸载流程被这条异常打断（表现为「无法停止插件」）。
   */
  let disposed = false;
  ctx.on('dispose', () => {
    disposed = true;
  });

  /**
   * 最近一次注入控制台的相册候选。
   *
   * 订阅表变化（面板保存 / 覆盖层回灌）时只拿它重注入，**不再探测一次**：
   * 控制台不该因为一次保存去打 OneBot。
   */
  let lastAlbumCandidates: readonly AlbumCandidate[] = [];

  /**
   * 把相册候选注入控制台：`Schema.dynamic(ALBUM_SCHEMA_KEY)` 按 key 读取，注入后在线
   * 页面立即刷新（`albumDelivery.albums`）。
   *
   * `subscriptions[].targets` **不在这里**：它是 `.role('table')` 里的静态 union，
   * 候选只能由 `refreshSubscriptionTargets()` **原地换 `inner.list`**（模块加载期先按
   * `process.cwd()` 读一次，`apply()` 按 `ctx.baseDir` 重读并覆盖），`Schema.dynamic`
   * 那套注入改不动表格。
   */
  function applyAlbumSchema(albums: readonly AlbumCandidate[]): void {
    if (disposed) return;
    lastAlbumCandidates = albums;
    // `Schema.dynamic` 的注册表：Koishi 4 的 `ctx.schema`，只在控制台在线时存在。
    ctx.schema?.set?.(ALBUM_SCHEMA_KEY, albumSchemaUnion(albums, config.albumDelivery.albums));
  }

  // 订阅表 / 绑定表一变（面板保存、覆盖层回灌、首轮迁移）就重装解析表并重注入候选：
  // 解析只认落盘绑定，候选只决定下拉与标签文案，两者刻意分开刷新。
  system.onSubscriptionsChanged = () => {
    // 卸载后不得再碰模块级 schema / 解析表：旧实例会顶掉新实例刚装好的那一份。
    if (disposed) return;
    applyAlbumSchema(lastAlbumCandidates);
    currentTargets = refreshSubscriptionTargets({
      ...currentTargets,
      bindings: system.targetBindingsSnapshot(),
    });
  };

  /**
   * 探测群相册 → 合并旧缓存 → 刷新控制台候选。
   *
   * 探测范围只覆盖订阅表里出现的监听群（`albumProbeScope`）；探测拿到的新相册会顺手
   * 原地刷新订阅表 `targets` 的候选，控制台不必等到下次重载。
   * 群号上限由 `MAX_PROBE_GROUPS` 兜住（供控制台连接时按需触发）。
   * 卸载竞态由 `refreshAlbumCandidates` 里的逐 `await` 重查兜住。
   */
  async function refreshAlbumSchema(): Promise<void> {
    await refreshAlbumCandidates({
      disposed: () => disposed,
      scope: albumProbeScope,
      probe: ({ bots, groupIds }) =>
        probeGroupAlbums({ groupIds: [...groupIds], bots: [...bots], service: deliveryAlbumService() }),
      readCache: () => readAlbumCache(system.wikiDir),
      writeCache: (albums) => writeAlbumCache(system.wikiDir, albums),
      applySchema: applyAlbumSchema,
      install: (values, groupIds) => {
        currentTargets = refreshSubscriptionTargets(values, groupIds);
      },
      configured: () => currentTargets.configured,
      bindings: () => system.targetBindingsSnapshot(),
      log: (message) => logger.info(message),
    });
  }

  /**
   * 相册探测范围：**只探订阅表里的监听群**（`subscriptionTable().rows` 的 `source`）。
   *
   * 候选是给订阅表用的，把机器人所在的几十个群全探一遍只会把下拉撑成噪音。
   * 两种情况仍要覆盖全部群：
   * - 有 `*` 行（监听全部群）；`get_group_list` 失败时退回显式来源群；
   * - 表为空且旧白名单也为空（旧配置的 `listening: null` 同样是「全部群」）。
   */
  async function albumProbeScope(): Promise<{ bots: AlbumBot[]; groupIds: string[] }> {
    const bots = ctx.bots.filter((bot) => bot.platform === 'onebot') as unknown as AlbumBot[];
    const { explicit, listenAll } = subscriptionProbeSources(system.subscriptionTable().rows, config.channels);
    // `get_group_list` 拿不到（掉线 / 平台不支持）时仍用显式来源群，别把候选清空。
    const listed = listenAll ? await listBotGroupIds(bots) : [];
    const scope = new Set<string>([...listed, ...explicit]);
    const groupIds = [...scope].slice(0, MAX_PROBE_GROUPS);
    if (scope.size > groupIds.length) {
      logger.warn(
        `[Patchouli] 待探测群 ${scope.size} 个，超过单轮上限 ${MAX_PROBE_GROUPS}：只探前 ${groupIds.length} 个，其余群的相册不会出现在候选里`,
      );
    }
    return { bots, groupIds };
  }

  /**
   * 面板 `GET /api/albums` 的冷启动探测（只探测，不写缓存也不改控制台候选）。
   *
   * 探测失败由 HTTP 层降级成 `albums: []`：面板不该因为「机器人掉线」收到 500。
   */
  async function probeAlbumsForPanel(): Promise<readonly AlbumCandidate[]> {
    if (disposed) return [];
    const { bots, groupIds } = await albumProbeScope();
    if (groupIds.length === 0) return [];
    return probeGroupAlbums({ groupIds, bots, service: deliveryAlbumService() });
  }

  /** ISO 周键（YYYY-Www），作为 `gateDailySlot` 的周期键。 */
  function isoWeekKey(at: number): string {
    const date = new Date(Date.UTC(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  /**
   * 知识周报上传：按订阅来源把最近 7 天新建 / 更新的主题渲成总结卡，投到该来源的相册。
   *
   * 取材与投递都按 `weekly` 行的来源分组（`*` 行 = 全库）；订阅表为空时退回旧的
   * 全库口径 + `albumDelivery.albums`。具体编排见 `weekly-album.ts`。
   *
   * 去重键是**本次触发的分钟桶**：同一分钟内插件重载不会重复上传，
   * 而下一次触发（无论 cron 改成每天还是每月）一定是新键。
   * `force` 仅给管理指令测试用，跳过去重。
   */
  async function runWeeklyAlbumUpload(
    options: { force?: boolean; firedAt?: number } = {},
  ): Promise<{ ok: boolean; reason?: string; uploaded: number }> {
    // 功能总闸：周报关闭时不跑（也不注册 cron，这里是二次防线：管理入口手工触发同样跳过）。
    if (config.features.weekly === false) return { ok: false, reason: 'disabled', uploaded: 0 };
    const deliveryHost = ctx as unknown as Record<string, unknown>;
    const delivery = deliveryHost['miyako-delivery'] as { gateDailySlot?: (slot: string, key: string) => Promise<boolean> } | undefined;
    const firedAt = options.firedAt ?? Date.now();
    const weekKey = isoWeekKey(firedAt);
    const fireKey = String(Math.floor(firedAt / 60_000));
    const snapshot = system.subscriptions();
    // 面板刚存过策略：预筛前先刷新一次，免得拿挂载时的旧缓存去判断本周额度。
    await deliveryGate.refresh();
    // 没有任何相册目标就别占掉本轮的触发槽（`gateDailySlot` 一旦放行即算跑过）。
    // 额度预筛：本周已用尽的相册不算「有目标」——否则会白占触发槽、还白跑一次取材。
    const weeklySources = planWeeklyAlbumSources(snapshot, config.albumDelivery.albums, (album, source) =>
      deliveryGate.allows('weekly', source, album, firedAt),
    );
    if (weeklySources.length === 0) {
      return { ok: false, reason: 'album-not-configured', uploaded: 0 };
    }
    if (options.force !== true) {
      if (typeof delivery?.gateDailySlot !== 'function') {
        return { ok: false, reason: 'delivery-unavailable', uploaded: 0 };
      }
      if (!(await delivery.gateDailySlot('patchouli:weekly-album', fireKey))) {
        return { ok: false, reason: 'already-ran', uploaded: 0 };
      }
    }
    const since = firedAt - WEEK_MS;
    // 按订阅来源取材与投递（`weekly` 行 = 「该来源参与周报」）；表为空时退回全库 + 旧相册。
    return runWeeklyAlbumDelivery({
      weekKey,
      fireKey,
      since,
      snapshot,
      fallbackAlbums: config.albumDelivery.albums,
      logger,
      recentEntries: (channelId, limit) => system.localStore.getRecentEntries(channelId, limit),
      buildView: async (record) => {
        // 周报图外发前同样要过脱敏：标题 / 摘要可能裸写群友昵称。
        const view = toPublicView(record, await system.wikiEngine.readEntry(record.id));
        const extraNames = [
          ...record.participants,
          ...collectSessionNames(await system.wikiEngine.readSessionDump(record.id)),
        ];
        return maskPublicView(view, undefined, extraNames);
      },
      render: (views, weekLabel) =>
        renderWeeklyAlbumSummaryPng(ctx, views, {
          maxHeight: system.settings('query').cardMaxHeight,
          weekLabel,
        }),
      allowTarget: (album, source) => deliveryGate.allows('weekly', source, album, firedAt),
      deliver: async (album, png, _dedupeKey, source) => {
        const separator = album.indexOf('/');
        const groupId = album.slice(0, separator).trim();
        const albumId = album.slice(separator + 1).trim();
        if (separator <= 0 || groupId === '' || albumId === '') {
          return { ok: false, error: { code: 'INVALID_TARGET', message: `相册目标不合法：${album}` } };
        }
        // 产物进闸门而不是直接外发：目标窗口外就排队，本周额度用尽就丢弃（都记账告警）。
        const offer = await deliveryGate.offer({
          kind: 'weekly',
          source,
          eventKey: fireKey,
          targets: [
            {
              targetKey: `${groupId}/${albumId}`,
              target: { kind: 'album', channelId: `onebot:${groupId}`, albumId },
            },
          ],
          png,
        });
        if (offer.accepted > 0) return { ok: true };
        return {
          ok: false,
          ...(offer.duplicates > 0
            ? { skipped: 'already-queued' }
            : { error: { code: 'POLICY_DROP', message: `目标 ${album} 本周额度已用尽或队列已满` } }),
        };
      },
    });
  }

  // 每日主题校准：04:00 按群各自归并；失败 30 分钟后重试，日切水位落盘。
  const topicScheduler = new TopicScheduler(system.topicConfig, {
    channels: async () => {
      // 目标群判定只有一份（`topicTargets`）：订阅表生效时就是订阅来源群，总闸关掉时为空。
      return system.topicTargets();
    },
    run: async (channelId, options) => {
      // 绕过 `runTopics` 的调度器委派，否则会递归回本调度器。
      const result = await system.runTopicsDirect(channelId, options);
      // 只有产生新 / 更新的主题词条时才重探相册：周报目标变化时才需要刷新候选。
      if (result.createdTopicIds.length > 0 || result.updatedTopicIds.length > 0) {
        void refreshAlbumSchema();
      }
      return result;
    },
    statePath: system.topicsStatePath,
    logger: { info: (message: string) => logger.info(message), warn: (message: string) => logger.warn(message) },
  });
  // 管理入口（`/api/topics`）经 `system.runTopics` 也走调度器，手动触发同样写水位。
  system.attachTopicScheduler(topicScheduler);
  void topicScheduler.start().catch((error: unknown) => {
    logger.warn(`[Patchouli] 主题校准调度启动失败: ${error instanceof Error ? error.message : String(error)}`);
  });

  // 知识周报：定时由 miyako-delivery 承载，触发规则（cron 表达式）来自本插件配置；
  // 服务就绪后再注册，避免 apply 顺序导致漏挂。改表达式保存即重载本插件、重新排程。
  ctx.inject(['miyako-delivery'], (deliveryCtx: Context) => {
    // 功能总闸：周报关闭时连 cron 都不注册（管理入口的手动触发由 runWeeklyAlbumUpload 再挡一次）。
    if (config.features.weekly === false) return;
    const deliveryHost = deliveryCtx as unknown as Record<string, unknown>;
    const stop = registerWeeklyCron({
      scheduler: deliveryHost['miyako-delivery'] as CronSchedulerLike | undefined,
      expression: config.albumDelivery.cron,
      run: () => {
        void runWeeklyAlbumUpload({ firedAt: Date.now() });
      },
      logger,
    });
    if (stop === undefined) return;
    deliveryCtx.on('dispose', stop);
  });

  // 挂载「不动的大图书馆」WebUI：阅读页与全部管理 API 都在 `/patchouli` 前缀下（不注册任何公开端点）
  // apply 与 ready 都会调用；幂等由 `createWebUiRegistrar` 保证（只成功注册一次）。
  const tryRegisterWeb = createWebUiRegistrar(
    ctx,
    () => registerWebUi(ctx, system, '/patchouli', { probeAlbums: probeAlbumsForPanel }),
    (err: unknown) => logger.warn(`[Patchouli] 挂载 WebUI 路由异常: ${String(err)}`),
  );
  tryRegisterWeb();
  // 先用上一次的探测缓存填满下拉（直接读 wikiDir，不依赖 cwd），ready 后再真探测。
  void readAlbumCache(system.wikiDir)
    .then((cached) => applyAlbumSchema(cached))
    .catch((): undefined => undefined);
  ctx.on('ready', () => {
    tryRegisterWeb();
    // 生命周期驱动：仅在启动 / 重载时探测一次；后续由新主题词条产生触发。
    void refreshAlbumSchema();
    // 主动书记员恢复：把上次进程遗留的录制会话交回触发器（不足 2 条的残file 直接清理，
    // 解析失败的文件保留）。恢复失败只告警，绝不阻断消息监听。
    //
    // 顺序是硬约束（Major-4）：消息监听必须等恢复**完成后**才挂载，否则恢复读盘期间到达的
    // 消息会看到 `manualRecording = false` 而不落盘，随后又被 `restoreManualSession` 整体
    // 替换缓冲而丢失；期间 `rec off` 也会与恢复交错。
    void restoreScribeSessions({ dir: system.scribe.directory, detector: system.detector, logger })
      .then((restored) => {
        // 把磁盘水位灌回内存表：否则「磁盘有旧水位、内存无记录」会让 persistMeta 跳过写盘，
        // 两者永久分叉，下次启动按旧水位重复恢复。
        for (const item of restored.restored) system.scribe.hydrateMeta(item.channelId, item.deliveredUpTo);
      })
      .catch((error: unknown) => {
        logger.warn(`[Patchouli] 主动书记员恢复失败: ${error instanceof Error ? error.message : String(error)}`);
      })
      .then(() => {
        registerMessageListener();
      });
  });

  // LLMWiki 阅读器以 Console 下属组件形式就地注入（绝对 node_modules 路径，静态服务放行 200），
  // 仅当 @koishijs/plugin-console 就绪后注册，避免无效条目污染控制台。
  ctx.inject(['console'], (consoleCtx: Context) => {
    try {
      registerConsoleEntry(consoleCtx, logger);
    } catch (err: unknown) {
      logger.warn(`[Patchouli] 注入 Console 阅读器组件异常: ${String(err)}`);
    }
  });

  ctx.on('dispose', () => {
    // 停闸先行：定时器停下后不再有新的批量外发，随后清理各子系统才不会撞上半销毁状态。
    try {
      deliveryGate.dispose();
    } catch (error) {
      logger.warn(
        `[Patchouli] 卸载清理失败（deliveryGate）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // 同样不可抛：调度器与系统各清各的，一个失败不得连累另一个。
    try {
      topicScheduler.dispose();
    } catch (error) {
      logger.warn(
        `[Patchouli] 卸载清理失败（topicScheduler）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      system.dispose();
    } catch (error) {
      logger.warn(
        `[Patchouli] 卸载清理失败（system）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  // 监听群聊消息：使用 Koishi 框架级作用域过滤（ctx.intersect）。
  // 白名单非空时，只有命中 channels 的群聊上下文才会分发 message 事件到本插件：
  // 非白名单群、私聊连回调都不会执行，框架层直接丢弃而非回调内丢弃。
  const channelScope = (session: Session): boolean =>
    !session.isDirect &&
    !!session.channelId &&
    isListening(system.subscriptions(), session.channelId);

  // 单条群消息的入站处理。注册时机由 `registerMessageListener` 决定（见 ready 阶段）。
  const handleIncomingMessage = async (session: Session): Promise<void> => {
    if (!session.channelId) return;

    const rawContent = session.content?.trim();
    if (!rawContent) return;

    // 入口单点裁剪：这条上限之后，窗口 / 缓冲 / 回溯环 / 词频表 / 落盘全部只看到裁剪值。
    // 之前每个消费者各自处理全文（10MB 单条 = 13 次全串拷贝 + 3.87s 同步阻塞）。
    // `raw`（Koishi 事件对象）刻意不挂到 ChatMessage 上：长驻容器不得持有宿主大对象。
    const content =
      rawContent.length <= MAX_INBOUND_CONTENT_CHARS
        ? rawContent
        : clampCodePoints(rawContent, MAX_INBOUND_CONTENT_CHARS);

    const msg: ChatMessage = {
      id: session.messageId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      channelId: session.channelId,
      userId: session.userId ?? 'unknown',
      userName: session.username ?? session.event?.user?.name ?? session.userId ?? '群友',
      content,
      timestamp: session.timestamp ?? Date.now(),
    };

    await system.onIncomingMessage(msg, {
      // 只读通道：真实 OneBot 适配器的 bot.internal（仅 get_msg / get_forward_msg / get_image）
      onebot: session.bot?.internal,
      // 原始 OneBot 消息段：字段最全，作为首选解析输入（仅内存使用，绝不落盘）
      rawMessage: session.event?._data?.message,
      elements: session.elements,
      // Session.content 会把首部 quote 元素剥离到 event.message.quote，必须单独传入
      quote: session.quote,
    });
  };

  // 一次性注册标志：ready 阶段（恢复完成后）调用；即便 ready 被重复触发也只挂一次。
  let messageListenerRegistered = false;
  const registerMessageListener = (): void => {
    if (messageListenerRegistered) return;
    messageListenerRegistered = true;
    ctx.intersect(channelScope).on('message', handleIncomingMessage);
  };

  // 注册群聊指令体系
  const cmd = ctx.command('patchouli', '「不动的大图书馆」llmwiki 词条沉淀与查阅系统')
    .action(() => {
      return (
        `[PATCHOULI] llmwiki 知识阅读器 // Patchouli Knowledge\n` +
        `基于群聊频率自适应突发检测的迟智知识沉淀与 llmwiki 词条生成系统。\n\n` +
        `[WEB] 词条阅读端点：/patchouli\n` +
        `可用指令：\n` +
        `- patchouli.status: 查看当前群实时速率与基线状态（管理员限定）\n` +
        `- patchouli.logon / .logoff: 自动书记开始 / 结束（管理员限定）\n`
      );
    });

  cmd.subcommand('.status', '查看当前群聊的自适应频率与沉淀状态（管理员）')
    .action(async ({ session }) => {
      if (!session?.channelId) return '请在群聊中使用此指令。';
      if (!isScribeAdmin(config, session.userId)) {
        return '馆藏记录权限仅限登记在册的管理者。';
      }
      const m = system.detector.getStatus(session.channelId, undefined, { settle: false });
      const opts = system.detector.getOptions(session.channelId);
      const tuning = system.getTuningSnapshot(session.channelId);
      const tunedAt =
        tuning.lastUpdated === null ? '从未校准' : new Date(tuning.lastUpdated).toISOString();

      return (
        `[METRICS] 群聊频率监控\n` +
        `群聊: ${session.channelId}\n` +
        `当前状态: ${m.phase}\n` +
        `瞬时速率: ${m.currentRate.toFixed(2)} 条/分\n` +
        `常态基准: ${m.baselineRate.toFixed(2)} 条/分\n` +
        `突发倍率: ${m.burstRatio.toFixed(2)}x (门限: ${opts.burstMultiplier}x)\n` +
        `缓冲区消息数: ${m.bufferedCount} 条\n` +
        `平息静默期设定: ${opts.quiescenceSeconds} 秒\n` +
        `AIMD 闸门: 保底 ${tuning.parameters.minBurstRate.toFixed(2)} 条/分 ` +
        `| 沉淀下限 ${tuning.parameters.minDiscussionMessages} 条 ` +
        `(上次校准: ${tunedAt})`
      );
    });

  // 主动书记员（§7.2 / §7.5.9）：管理员口令，开启后本群每条消息追加到
  // `<wikiDir>/.patchouli/scribe/<channelId>.jsonl`，进程重启由 ready 阶段恢复。
  // 权限只认白名单（`adminUsers`，默认空 = fail closed），不依赖 authority；
  // 回包只回到指令本身，绝不向群内广播（ADR-005）。
  const startScribe = async (session: Session | undefined): Promise<string> => {
    // 私聊一律拒绝：消息监听只覆盖群聊（`channelScope` 直接过滤 `isDirect`），
    // 在私聊里开启录制必然空转。
    if (!session?.channelId) return '请在群聊中使用此指令。';
    if (session.isDirect) return '自动书记仅在群聊中可用。';
    if (!isScribeAdmin(config, session.userId)) {
      return '馆藏记录权限仅限登记在册的管理者。';
    }
    const channelId = session.channelId;
    // 范围校验先于副作用：插件停用 / 群不在白名单时消息根本到不了本插件，
    // 开启只会空转——必须明确拒绝并说明原因，而不是回复「已开始」。
    const refusal = scribeScopeRefusal(config, channelId);
    if (refusal !== undefined) return refusal;
    if (system.detector.isManualRecording(channelId)) {
      const buffered = system.detector.getStatus(channelId, undefined, { settle: false }).bufferedCount;
      return `[PATCHOULI] 自动书记开始（群 ${channelId}）：已在记录中，当前缓冲 ${buffered} 条。`;
    }
    const before = system.detector.getStatus(channelId, undefined, { settle: false });
    const metrics = system.detector.startManualSession(channelId);
    const forced = before.phase === 'BURSTING' ? '' : `，已从 ${before.phase} 强制进入 BURSTING`;
    return `[PATCHOULI] 自动书记开始（群 ${channelId}）：当前缓冲 ${metrics.bufferedCount} 条${forced}。`;
  };

  const stopScribe = async (session: Session | undefined): Promise<string> => {
    if (!session?.channelId) return '请在群聊中使用此指令。';
    if (session.isDirect) return '自动书记仅在群聊中可用。';
    if (!isScribeAdmin(config, session.userId)) {
      return '馆藏记录权限仅限登记在册的管理者。';
    }
    const channelId = session.channelId;
    const wasRecording = system.detector.isManualRecording(channelId);
    const before = system.detector.getStatus(channelId, undefined, { settle: false });
    // `stopManualSession` 经 `onManualSessionEnd('stop')` 回调清档；这里再显式删一次，
    // 覆盖「未在录制但磁盘上仍有残留」的边角（`remove` 幂等，重复调用无副作用）。
    system.detector.stopManualSession(channelId);
    await system.scribe.remove(channelId);
    if (!wasRecording) return `[PATCHOULI] 自动书记结束（群 ${channelId}）：当前未在记录。`;
    if (before.bufferedCount < MANUAL_SESSION_MIN_MESSAGES) {
      return `[PATCHOULI] 自动书记结束（群 ${channelId}）：不足 ${MANUAL_SESSION_MIN_MESSAGES} 条，已丢弃。`;
    }
    return `[PATCHOULI] 自动书记结束（群 ${channelId}）：已交付 ${before.bufferedCount} 条消息给沉淀流程。`;
  };

  cmd
    .subcommand('.logon', '自动书记：开始记录本群讨论（管理员）')
    .usage('记录期间每条消息追加到 <wikiDir>/.patchouli/scribe/，进程重启自动恢复；用 patchouli.logoff 结束并交付。')
    .action(async ({ session }) => startScribe(session));

  cmd
    .subcommand('.logoff', '自动书记：结束记录并交付沉淀（管理员）')
    .usage('结束本群的自动书记，把缓冲消息交给沉淀流程；不足 2 条则丢弃。')
    .action(async ({ session }) => stopScribe(session));
}
export const schema = Config;

export interface PatchouliPlugin {
  (ctx: Context, config: PluginOptions): void;
  Config: typeof Config;
  schema: typeof Config;
  inject: typeof inject;
}

const typedApply = apply as unknown as PatchouliPlugin;
typedApply.Config = Config;
typedApply.schema = Config;
typedApply.inject = inject;
