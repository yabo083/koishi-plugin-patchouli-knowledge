/**
 * Patchouli Knowledge (不动的大图书馆) - 核心类型与契约定义
 */

import type { ProtocolId } from './dispatcher/protocols/types';

export interface ChatMessage {
  id: string;
  channelId: string; // 群聊/频道 ID
  userId: string;
  userName: string;
  content: string;
  timestamp: number; // 毫秒
  raw?: unknown;
}

export type CadencePhase = 'IDLE' | 'BURSTING' | 'COOLING' | 'SUMMARIZING';

/* ------------------------------------------------------------------ *
 * 群聊流量采样契约（后端采样 / API 暴露 / 前端绘图三方共享）
 *
 * 以**服务器墙钟的固定 5 秒边界**切桶：桶 k 覆盖 [k·5000, (k+1)·5000)。
 * 只统计 `onIncomingMessage` 实际接受的群消息；已监测但无消息的闭合桶为真实 0，
 * 未监测的周期（进程启动前 / 从未跟踪的群）根本不产出数据点，绝不伪造历史零值。
 * 桶一旦闭合即不可变：新消息只写入当前桶，不回溯改写已发布的采样点。
 * ------------------------------------------------------------------ */

/** 流量采样节拍：每 5 秒一个闭合桶。 */
export const TRAFFIC_SAMPLE_MS = 5000;
/** 每频道保留的采样点数：60 点 × 5 秒 = 5 分钟滚动窗口。 */
export const TRAFFIC_CAPACITY = 60;

/** 知识周报默认排程：每周一 04:30（五段 cron，`Asia/Shanghai`）。 */
export const DEFAULT_WEEKLY_CRON = '30 4 * * 1';

/** 单个 5 秒流量桶。 */
export interface TrafficPoint {
  /** 桶起始时刻（服务器墙钟毫秒），严格对齐 `TRAFFIC_SAMPLE_MS` 边界。 */
  timestamp: number;
  /** 该桶内被 `onIncomingMessage` 接受的群消息条数（整数；已监测但无消息的真实周期为 0）。 */
  count: number;
}

/** 群聊流量采样序列（`GET /api/status` 与 `GET /api/series` 的统一载荷）。 */
export interface TrafficSeries {
  channelId: string;
  /** 固定采样节拍（毫秒），恒为 `TRAFFIC_SAMPLE_MS`。 */
  sampleMs: number;
  /** 响应生成时刻的服务器墙钟（毫秒），供前端把采样点对齐到真实时间轴。 */
  serverTime: number;
  /** 按时间升序排列的闭合桶，最多 `TRAFFIC_CAPACITY` 点；未监测周期不出现在数组中。 */
  traffic: TrafficPoint[];
}

/* ------------------------------------------------------------------ *
 * 最新消息只读预览契约（后端缓存 / API 暴露 / 前端横条三方共享）
 *
 * 只在 `onIncomingMessage` **实际接受**群消息时按接受顺序覆盖，每群至多保留 1 条；
 * 仅驻留内存、绝不落盘，且只保留 `id / channelId / userName / content / timestamp`——
 * 不携带 `raw`（Koishi 事件对象）与 `userId`，避免把无关隐私字段交给浏览器。
 * `content` 已是剥离 Koishi markup 的纯文本预览（图片 / @ / 表情等替换为 `[图片]` 之类
 * 占位提示），前端一律以 `textContent` 渲染，不得当作 HTML 注入。
 * ------------------------------------------------------------------ */

/** 最新消息预览文本上限（字符）：长消息与图片原始 markup 一律截断，避免拖垮前端横条。 */
export const LATEST_MESSAGE_MAX_CHARS = 1000;
/** 底栏最新词条轮播（`GET /api/latest`）的缺省与上限条数。 */
export const LATEST_ENTRIES_LIMIT = 20;

/** 单群最新一条消息的只读预览（`GET /api/status` 的 `latestMessage` 字段，无消息时为 `null`）。 */
export interface LatestMessage {
  /** 消息 ID（Koishi `session.messageId`，缺失时为生成的临时标识）。 */
  id: string;
  channelId: string;
  /** 发送者显示名；绝不含 `userId`。 */
  userName: string;
  /**
   * 去 markup 的纯文本摘要（**兜底**，最长 `LATEST_MESSAGE_MAX_CHARS` 字符）。
   * 即使富元素解析完全失败也恒定可得；富元素解析成功后仍保留该字段，便于前端降级展示。
   */
  content: string;
  /** 消息时间戳（毫秒，取 Koishi 会话时间；缺失时为接受时刻）。 */
  timestamp: number;
  /**
   * 富消息元素 AST（恒为非空数组，最坏情形为 `[{ type: 'text', text: content }]`）。
   * 详见 `RichMessageElement`；**绝不**携带 OneBot 原始 segment、`userId` 或任何凭据。
   */
  elements: RichMessageElement[];
}

/* ------------------------------------------------------------------ *
 * 富消息元素契约（后端解析 / API 暴露 / 前端渲染三方共享）
 *
 * 元素类型与字段语义对齐 `koishi-plugin-onebot-webqq`（MIT, Copyright (c) 2026 Sor85）
 * 的 `WebQQMessageElement`，但按本插件「只读预览」定位做了收敛：
 *   - 不暴露 `senderId` / 头像 / 任何 userId（`userName` 已在 `LatestMessage` 层给出）；
 *   - 不暴露 OneBot 原始 segment、`raw`、资源 id（`forward` 的展开只保留标题与元素）。
 * 媒体字段（`url` / `imageUrl` / `emojiUrl`）一律为**浏览器可直接加载**的地址：
 * 公网 https 原样直链；http（https 页面会被混合内容拦截）改写为同源
 * `<basePath>/api/media/<opaqueId>`，仅代理本缓存消息登记过的 URL。
 * ------------------------------------------------------------------ */

/** 富消息元素类型：与参考实现（WebQQ）保持同一枚举。 */
export type RichMessageElementType =
  | 'text'
  | 'image'
  | 'quote'
  | 'forward'
  | 'card'
  | 'face'
  | 'file'
  | 'record'
  | 'video'
  | 'unknown';

/** 合并转发中的单条节点（只有昵称标题与元素，绝不含 userId / 头像）。 */
export interface RichForwardItem {
  /** 该节点的发送者显示名（缺失时省略）。 */
  title?: string;
  elements: RichMessageElement[];
}

/** 单个富消息元素。所有字段可省略；`type` 恒存在。 */
export interface RichMessageElement {
  type: RichMessageElementType;
  /** 纯文本（text 元素正文、face/file/quote/forward 的占位或摘要文案）。前端必须以 textContent 渲染。 */
  text?: string;
  /** 标题（card 标题、quote 发送者、forward 固定为「合并转发」）。 */
  title?: string;
  /** 媒体或跳转地址（image/record/video 的播放源、file 的下载地址、card 的跳转链接）。 */
  url?: string;
  /** 封面/缩略图地址（card 预览图、video 封面）。 */
  imageUrl?: string;
  /** 表情图片地址（face 元素的 QFace 图）。 */
  emojiUrl?: string;
  /** 卡片来源标识（如 `com.tencent.multimsg` / `qq` / 应用名）。 */
  source?: string;
  /** 引用目标消息 ID（quote 元素；仅消息 ID，不是 userId）。 */
  targetMessageId?: string;
  /** 媒体时长（秒，仅 record 等带时长的元素）。 */
  duration?: number;
  /** 合并转发节点（仅 forward 元素）。 */
  items?: RichForwardItem[];
}

/** 单条消息的富元素上限（顶层与每个嵌套层级各自生效；超出部分截断并追加可见提示元素）。 */
export const RICH_MESSAGE_MAX_ELEMENTS = 60;
/** 单次合并转发展开的节点上限（每层，超出部分截断并追加可见提示）。 */
export const RICH_FORWARD_MAX_NODES = 30;
/** 单条消息内所有层级的合并转发节点总数上限（跨层总预算，防深嵌套放大）。 */
export const RICH_FORWARD_MAX_TOTAL_ITEMS = 60;
/** 合并转发 / 引用的递归展开深度上限（含顶层消息本身）。 */
export const RICH_FORWARD_MAX_DEPTH = 3;
/** 单个元素文本上限（字符，按码点截断）。 */
export const RICH_ELEMENT_TEXT_MAX_CHARS = 1000;
/** 单个只读 OneBot action（get_msg / get_forward_msg / get_image / get_record）的超时（毫秒）。 */
export const RICH_RESOLVE_TIMEOUT_MS = 8000;
/**
 * 单条消息允许发起的只读 action 总次数上限。
 * 与 `RICH_FORWARD_MAX_DEPTH` / `RICH_FORWARD_MAX_NODES` 一起把「深嵌套合并转发」的
 * 最坏 IO 放大收敛为常数；超限的解析按失败处理（元素保留占位文案并记录脱敏日志）。
 */
export const RICH_RESOLVE_MAX_ACTIONS = 60;
/** 同源媒体代理登记表的容量上限（超出按插入顺序淘汰最旧条目）。 */
export const RICH_MEDIA_REGISTRY_CAPACITY = 256;

/**
 * 入站单条消息的字符上限（码点）。
 *
 * 这是**物理上界**而不是格式约束：窗口 / 缓冲 / 回溯环 / 词频表都按消息正文建结构，
 * 没有这条上限时一条 10MB 脏消息即可同步阻塞事件循环数秒并使常驻堆增长数百 MB
 * （实测 9.73MB → 3.87s、+222MB）。4000 码点覆盖正常长文（QQ 单条上限约 4500）。
 */
export const MAX_INBOUND_CONTENT_CHARS = 4_000;
/** 同源媒体代理的路径段：`<basePath>/api/media/<opaqueId>`。 */
export const MEDIA_PROXY_SEGMENT = 'api/media';
/** 同源媒体代理向媒体源发起请求的连接/首包超时（毫秒）。 */
export const MEDIA_FETCH_TIMEOUT_MS = 15000;
/** 同源媒体代理允许跟随的最大重定向跳数（每跳都重新做安全校验）。 */
export const MEDIA_MAX_REDIRECTS = 5;

/** 触发判据的三态模式：频率（现状）/ 势能 / 影子（旧判据裁决、新判据只观测）。 */
export type TriggerMode = 'rate' | 'potential' | 'shadow';

/**
 * 势能层（Phase 7）的观测快照：只描述「当前这一群有多值得沉淀」，不含任何相位裁决结果。
 *
 * 只有 `triggerMode` 为 `potential` / `shadow` 时才会填进 `CadenceMetrics.potential`；
 * `rate` 模式（默认）完全省略该字段，保证既有消费者的响应结构逐位不变。
 */
export interface PotentialMetrics {
  /** 漏桶势能 E（nat，按 τ=240s 同核衰减）。 */
  energy: number;
  /** 同核衰减的消息计数 N。 */
  count: number;
  /** 信息密度 ρ = E / N（近期单条平均信息量）。 */
  density: number;
  /** 交互熵归一化后的 S_turn ∈ [0, 1]。 */
  interaction: number;
  /** 有效讨论势能 Q = E · S_turn。 */
  quality: number;
  /** Q 的逐群日常基线 b_Q（独立于速率基线）。 */
  baselineQuality: number;
  /** 突发门限 Θ_burst = max(thetaMin, b_Q × burstMultiplier)。 */
  burstThreshold: number;
  /**
   * 冷却门限 Θ_cool = max(coolingRatioThreshold × max(thetaMin / burstMultiplier, b_Q),
   *                      sessionPeakQuality × peakCoolFraction)，
   * 封顶在 Θ_burst × 0.99 之下，迟滞带恒成立。
   *
   * 冷启动 `b_Q = 0` 时用种子基线保证迟滞带成立（否则 Q > 0 恒不冷却 → 常驻 BURSTING）。
   */
  coolThreshold: number;
  /** ρ 的逐群日常基线 b_ρ（`densityMultiplier` 生效后的参照）。 */
  baselineDensity: number;
  /** 本次裁决实际生效的密度下限 ρ_eff = max(rhoMin, densityMultiplier × b_ρ)。 */
  rhoEff: number;
}

export interface CadenceMetrics {
  currentRate: number;      // 消息/分钟 (近期滑动窗口速率)
  baselineRate: number;     // 动态日常基准速率 (EWMA)
  baselineDeviation: number;// 速率标准差或偏离度
  burstRatio: number;       // 当前突发倍率 currentRate / max(baselineRate, minRate)
  lastMessageTime: number;  // 毫秒时间戳
  phase: CadencePhase;
  bufferedCount: number;    // 当前处于本轮讨论缓冲区的消息数
  /** 势能层观测（rate 模式省略；potential / shadow 模式必填）。 */
  potential?: PotentialMetrics;
  /**
   * 主动书记员模式是否录制中。
   *
   * `rate` 模式的常规路径不填（缺省视同 `false`，保证既有响应结构不变）；
   * `potential` / `shadow` 模式恒为布尔值，书记员入口（开启 / 恢复 / 结束）也一定带出。
   */
  manualRecording?: boolean;
}

export interface TriggerOptions {
  windowSizeSeconds: number;       // 瞬时滑动窗口 (默认 60 秒)
  burstMultiplier: number;         // 判定突发讨论的倍率阈值 (默认 2.5)
  minBurstRate: number;            // 触发突发的最低绝对消息速率 (条/分，默认 6 条/分，防冷清群偶尔发两句被误判)
  quiescenceSeconds: number;       // 讨论平息判定的静默观察期 (默认 300 秒 / 5 分钟)
  coolingRatioThreshold: number;   // 认定回落到常态的突发倍率下限 (默认 1.1)
  minDiscussionMessages: number;   // 一轮有效沉淀所需的最低消息数 (默认 12 条)
  maxBufferMessages: number;       // 最大缓存消息条数 (默认 500 条，防 OOM)
  baselineEwmaAlpha: number;       // 基准速率更新的平滑系数 (默认 0.05)
  triggerMode: TriggerMode;        // 判据模式 (默认 'rate'，即 Phase 7 之前的频率判据)
  thetaMin: number;                // 势能突发门限下限（自然数 nat 累加，默认 20）
  rhoMin: number;                  // 信息密度下限（Δnat/条，默认 1.2）
  /**
   * shadow 对照时是否让两套判据门限同步参与 AIMD（默认 false）。
   *
   * 开启后 AIMD 作用于 `both`：`minBurstRate` 与 `thetaMin` 在同一控制器、同一时钟、
   * 同一信号下各走一步，衰减只算一次。关闭时势能侧只受时间衰减——比较势能判据与
   * 频率判据时那样是「让子」，结论会系统性地低估势能引擎。
   */
  potentialAutoTuning?: boolean;
  /**
   * 信息密度基线倍率（默认 1.0）。
   *
   * ρ 的生效下限 `ρ_eff = max(rhoMin, densityMultiplier × b_ρ)`：`b_ρ` 是逐群 EWMA 学习的
   * 密度基线。ADR-021 已证 ρ 不是跨群分离轴，该字段只让下限随群量级自适应，
   * 不承担「区分高低价值」的职责。
   */
  densityMultiplier?: number;
  /**
   * 峰值比例冷却分数（默认 0.5，`0` 表示退回纯基线口径）。
   *
   * `Θ_cool` 在基线口径之上再叠加 `sessionPeakQuality × peakCoolFraction`：
   * 峰值高的讨论允许多烧一会再结算，峰值低的快速冷却。实现必须保证叠加后
   * `Θ_cool < Θ_burst`，迟滞带恒成立。
   */
  peakCoolFraction?: number;
  /**
   * 调度质量门倍数（默认 0 = 关闭）。
   *
   * 结算交付的会话若 `potentialPeak.quality < burstThreshold × dispatchMargin` 直接跳过
   * 云端调度（`dispatchMargin=1.3` ≈ 过阈 30% 以内不烧一次 LLM）。仅对携带
   * `potentialPeak` 的完整结算（非 partial）生效；不触发即不产生 dispatch 记录。
   */
  dispatchMargin?: number;
}

export interface DiscussionSession {
  sessionId: string;
  channelId: string;
  startTime: number;
  endTime: number;
  messages: ChatMessage[];
  peakRate: number;
  triggerReason: string;
  /**
   * 软切片交付的片段（进行中讨论的中间段），语义上不完整，不得作为门限调节依据。
   *
   * `true` = 缓冲区软切片（`flushSlice`，达到 120 条强制交付）的产物：讨论尚未结束，
   * 模型必然倾向判 `FRAGMENTED`，若据此步进 AIMD 会形成「切得越碎 → 门限越高 → 越发难触发」
   * 的自激抬升；`false`/缺省 = 正常平息结算（`finalize`）交付的完整一轮讨论。
   */
  partial?: boolean;
  /**
   * 本轮讨论期间的势能峰值观测（potential / shadow 模式下填充）。
   *
   * `quality` / `density` 是该轮的最高值，`burstThreshold` 是**结算时刻**按当前基线重算的
   * 突发门限（突发期基线冻结，参数漂移时可能与峰值时刻真值有偏；与运行时门同口径）；
   * 供调度质量门（`dispatchMargin`）与遥测对照使用，rate 模式为 undefined。
   */
  potentialPeak?: { quality: number; density: number; burstThreshold: number };
}

export interface WikiDebatePoint {
  viewpoint: string;           // 观点主旨
  proponents: string[];        // 支持者/提出者名单或代号
  opponents?: string[];        // 提出反驳或质疑的发言人名单
  arguments: string[];         // 核心论据与支撑事实
  counterArguments?: string[]; // 质疑或反驳
}

/**
 * 主题时间轴上的一个节点：某条普通词条对主题的推进。
 *
 * 主题（`kind: 'topic'`）是长期聚合视图：每追加一条来源词条，就在时间轴上多一段。
 * `summary` 用于脱离上下文时快速回忆，`contribution` 由模型写成一句「它推进了什么」。
 */
export interface TopicTimelineItem {
  /** 来源普通词条的 id（不得指向主题自身）。 */
  entryId: string;
  /** 该来源词条的日期，YYYY-MM-DD。 */
  date: string;
  /** 该来源词条的标题。 */
  title: string;
  /** 该来源词条的一句话摘要。 */
  summary: string;
  /** 该条对主题的推进/贡献（一句）；模型没给时缺省。 */
  contribution?: string;
}

export interface WikiEntry {
  id: string;                  // 唯一词条标识符 (如 2026-10-25-ai-alignment-debate)
  title: string;               // 沉淀词条标题
  channelId: string;
  date: string;                // YYYY-MM-DD
  /**
   * 词条状态。
   *
   * `superseded` 是历史归并留下的只读标记（旧库兼容）：正文保留作历史证据，
   * `Merged-Into: [[目标标题]]` 指回归并后的词条。主题聚合**不再**使用该状态，
   * 时间轴成员保持原状态并继续出现在词条页。
   */
  status: 'verified' | 'tentative' | 'open' | 'superseded';
  tags: string[];
  summary: string;             // 一句话沉淀摘要
  background: string;          // 讨论背景与触发契机
  participants: string[];      // 参与本场讨论的核心发言人群友去重名单
  debateMatrix: WikiDebatePoint[]; // 观点碰撞矩阵
  consensus: string[];         // 达成的共识/结论
  openQuestions: string[];     // 遗留未决的分歧或待探索问题
  keyQuotes: Array<{ author: string; quote: string; context?: string }>; // 经典原句采撷
  metadata: {
    messageCount: number;
    participantCount: number;
    durationMinutes: number;
    peakRate: number;
  };
  /**
   * 词条种类：
   * - `debate`（缺省语义）：一次讨论的原子沉淀；
   * - `topic`：长期聚合视图，按 `timeline` 把多条普通词条串成一条主题脉络。
   */
  kind?: 'debate' | 'topic';
  /** 真理源相对路径（相对 llmwiki 根目录）；多源（主题聚合）时按成员顺序列出。 */
  sources?: string[];
  /**
   * 词条主体叙事（段落之间以空行分隔）：
   * - `debate`：第三人称旁观者语气的讨论脉络，以时间为轴写清起因、转折与落点；
   * - `topic`：主题综述（第三人称综合，不写日记体）。
   */
  narrative?: string;
  /**
   * 主题时间轴（仅 `kind: 'topic'`）：按日期升序记录每条来源词条对主题的推进。
   * 普通词条不写该字段；时间轴成员不会因此被标记 `superseded`。
   */
  timeline?: TopicTimelineItem[];
  /**
   * 名词注：脱离本群语境会看不懂的黑话、简称、作品专有名词 / 设定，
   * `note` 写其在本场讨论语境下的含义。
   */
  glossary?: Array<{ term: string; note: string }>;
  /** 相关词条标题（`[[双链]]` 渲染）；主题词条里是时间轴成员的标题。 */
  related?: string[];
}

/**
 * 「主题校准」配置（仅类型；Koishi 配置 Schema 由集成方声明）。
 *
 * 语义为长期主题聚合：每日 `hour:minute`
 * 触发一次，把窗口内**尚未归入任何主题**的普通词条按标签相似度并入已有主题或新建主题。
 * 主题是长期聚合视图（`kind: 'topic'` + `timeline`），不把来源词条标记为 `superseded`。
 */
export interface TopicConfig {
  /** 总开关；关闭时 `runChannel` 直接返回 `disabled`，零读写。 */
  enabled: boolean;
  /** 每日触发时刻的小时（0~23，本地时区）。 */
  hour: number;
  /** 每日触发时刻的分钟（0~59）。 */
  minute: number;
  /** 聚类门限：标签 Jaccard 相似度不低于该值即视为同一主题 / 同簇（0~1）。 */
  mergeThreshold: number;
  /** 窗内未分配词条少于此数则不校准（避免为一条碎片动模型）。 */
  minEntries: number;
  /** 上下文回看天数：窗口起点 = `now - lookbackDays * 86400e3`。 */
  lookbackDays: number;
  /** 单次校准最多读取多少个会话的原始消息。 */
  maxSessionsPerRun: number;
  /** 单个会话最多提交多少条原始消息。 */
  maxMessagesPerSession: number;
}

/** 模型连通性自检结果 */
export interface ModelProbeResult {
  ok: boolean;
  /** 本次实际走的通道：chatluna 继承平台凭据 / standalone 直连 API */
  route: 'chatluna' | 'standalone';
  /**
   * 本次（或当前生效的）端点协议 id；ChatLuna 通道不经过协议层时为主候选。
   * 自动探测成功后即为固定下来的协议。
   */
  protocol?: ProtocolId;
  /**
   * 当前**生效**的输出格式（`structured` 被端点拒绝后降级为 `text`，此后 schema 约束失效）。
   * 自检必须报出它：只看 `ok` 会把「约束已失效」误读成「一切正常」。
   */
  responseFormat?: 'json_object' | 'structured' | 'text';
  /** 显式配置的模型标识；留空表示继承 ChatLuna 平台默认模型 */
  model: string;
  latencyMs: number;
  content?: string;
  error?: string;
}

/**
 * 丢弃归因枚举（模型明确判定「本轮不值得沉淀」时的结构化原因）。
 *
 * - `NOISE_SPAM`：纯刷屏 / 复读 / 表情包 / 发癫，清洁后不剩有效内容；
 * - `LOW_DENSITY`：有对话但无实质论点（寒暄、玩梗、单句感叹）；
 * - `FRAGMENTED`：话题碎散、被反复打断或截断，凑不出完整碰撞。
 *
 * 运行时失败（网络 / 超时 / 输出不可解析 / 会话为空）**不属于**丢弃归因，
 * 一律使用 `discardReason: null` + `failureReason` 表达。
 */
export type DiscardReason = 'NOISE_SPAM' | 'LOW_DENSITY' | 'FRAGMENTED';
/** `DiscardReason` 的全集（顺序固定），供校验、提示词白名单与前端枚举共用。 */
export const DISCARD_REASONS: readonly DiscardReason[] = ['NOISE_SPAM', 'LOW_DENSITY', 'FRAGMENTED'];

/**
 * 调度器（大模型萃取）的单轮产物。
 *
 * 四维闭环里 dispatcher 只负责「判定 + 沉淀」两件事：给出可判读的质量信号，
 * 把参数调节完全让渡给宿主 AIMD 控制器（`src/trigger/tuning.ts`）。
 */
export interface DispatcherResult {
  /** 是否产出了可落库的 `WikiEntry`。 */
  success: boolean;
  /** 沉淀产物；`success === true` 时必存在。 */
  entry?: WikiEntry;
  /**
   * 本轮讨论的知识质量分，0~1，**恒存在**：
   * 成功 = 模型评分（缺失/非法按 0.5）；模型判定丢弃 = 模型评分（缺失/非法按 0）；
   * 运行时失败 = 0。作为 AIMD 控制器的唯一反馈输入。
   */
  qualityScore: number;
  /** 模型明确判定舍弃时的结构化归因；成功或运行时失败恒为 `null`。 */
  discardReason: DiscardReason | null;
  /** 仅运行时失败 / 取消 / 输出不可解析时的人类可读说明（面向日志，不参与控制）。 */
  failureReason?: string;
  tokensUsed?: number;
  /**
   * 因契约校验未通过而追加的重试次数（0 / 缺省 = 一次即过）。
   * 只做观测与排障：重试成功的结果与一次即过的结果同权，不参与 AIMD 控制。
   */
  contractRetries?: number;
}

export interface DispatcherConfig {
  /**
   * 模型通道：
   * - `chatluna`（默认）：优先走 ChatLuna 服务；异常时若配置了独立模型则回退自定义端点
   *   （旧值 `auto` 归一化到此）；
   * - `custom`：始终直连自定义端点，凭据与协议完全由本配置决定（旧值 `standalone` 归一化到此）。
   *
   * 插件层用 `normalizeDispatcherProvider()` 收敛历史配置值。
   */
  provider?: 'chatluna' | 'custom';
  /** 仅 `provider=custom` 使用；ChatLuna 通道完全忽略（凭据由 ChatLuna 平台接管） */
  apiKey?: string;
  /** 仅 `provider=custom` 使用；ChatLuna 通道完全忽略 */
  baseURL?: string;
  /**
   * 端点协议（仅自定义端点生效；ChatLuna 通道由 ChatLuna 适配器负责）：
   * - `auto`（默认）：按端点形状自动探测，顺序见 `resolveProtocolChain()`——
   *   Gemini 端点 `gemini` → `chat-completions`，其余 `responses` → `chat-completions`；
   *   探测只在「协议不被该端点支持」（404 / 405 / 明确的 endpoint 400）时顺延，成功后固定；
   * - `responses`：OpenAI Responses API `POST /v1/responses`（`input` + `max_output_tokens` + `text.format`）；
   * - `gemini`：Gemini 原生 `POST /v1beta/models/{model}:generateContent`（`contents` + `systemInstruction`）；
   * - `chat-completions`：旧版 Chat Completions `POST /v1/chat/completions`（兼容未实现 `/responses` 的网关）。
   *
   * 协议实现位于 `src/dispatcher/protocols/`，新增协议只需实现 `ModelProtocol` 并注册。
   */
  protocol?: 'auto' | 'responses' | 'gemini' | 'chat-completions';
  /**
   * ChatLuna 通道的模型标识，写 `<platform>/<model>`（留空或「无」= 继承平台默认模型）。
   * 与 `customModel` 是**两套命名空间**：ChatLuna 模型 id 永远不会被当作端点模型名发出。
   */
  chatlunaModel?: string;
  /**
   * 仅 `provider=custom` 使用：端点侧的模型名（自由文本，如 `gpt-5` / `gemini-2.5-pro`）。
   * ChatLuna 通道完全忽略此键。
   */
  customModel?: string;
  /**
   * 历史单键（0.8.43 及以前）：一个 `model` 同时充当 ChatLuna 模型标识与端点模型名，
   * 控制台切 provider 时两个字段互相覆盖。现仅作为**当前通道**的兜底值被读取
   * （`resolveDispatcherModels`），新配置一律写 `chatlunaModel` / `customModel`。
   */
  model?: string;
  /**
   * 输出格式（仅 `provider=custom` 生效，各协议映射到自己的字段）：
   * - `json_object`：Responses 的 `text.format={"type":"json_object"}` / Chat 的 `response_format`（默认）；
   * - `structured`：严格 JSON Schema（`MODEL_OUTPUT_JSON_SCHEMA`）；
   * - `text`：不声明响应格式，靠系统提示约束并本地解析。
   */
  responseFormat?: 'json_object' | 'structured' | 'text';
  temperature?: number;
  maxTokens?: number;
  /**
   * 契约校验未通过时的重试次数（默认 1，钳制 0~3）。
   *
   * 「通过」= 解析出 JSON/Markdown 且能构造出 `WikiEntry`（模型明确 `shouldDiscard` 也算通过）。
   * 未通过时把「上一次原始输出 + 具体失败原因 + 逐字符字段名清单」追加进对话重发，
   * 用于矫正会写字面量畸变键名的端点（实测 `gemini-4-hydrogen` 返回 `sh0vldD1sc4rd`）。
   * 每次重试都是一次完整模型调用，故默认只留 1 次。
   */
  contractRetries?: number;
  /**
   * 自定义系统提示词：**不来自 Koishi 配置表单**（表单只留 provider 与其分支字段：
   * ChatLuna 分支只有 model，custom 分支另有 baseURL / apiKey / model），默认空串 =
   * 使用内置最高品质的帕秋莉专属提示词。非空时整段覆盖内置提示词并自动补齐输出契约。
   *
   * 唯一写入点是悬浮窗设置页的 `POST /api/prompt`：保存即原子落盘到
   * `<wikiDir>/.patchouli/custom-prompt.txt` 并热更新本字段，插件启动时自动回灌。
   * 调度器持有配置对象的实时引用，每轮请求都读取最新值，无需重启。
   */
  customSystemPrompt?: string;
  /**
   * 主题聚合专用自定义系统提示词。与 `customSystemPrompt` 独立落盘到
   * `<wikiDir>/.patchouli/custom-topic-prompt.txt`，只影响主题校准调用。
   */
  customTopicPrompt?: string;
  /**
   * 是否允许宿主 AIMD 控制器（`src/trigger/tuning.ts`）按每轮 `qualityScore` /
   * `discardReason` 自动校准该群的触发闸门。调度器本身不再产出任何参数建议；
   * 该开关只由插件主流程读取。
   */
  enableAutoTuning?: boolean;
}

/** ChatLuna 桥接调用器函数契约 */
export type ChatLunaInvoker = (input: {
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<{ content: string; tokensUsed?: number }>;

export interface WikiStorageConfig {
  wikiDir: string;          // llmwiki 根存储目录
  databasePath?: string;    // 本地持久化 SQLite / 存储文件路径
}

export interface PatchouliPluginConfig {
  enabled: boolean;
  channels: string[];       // 启用的群聊白名单 (空为所有群)
  trigger: TriggerOptions;
  dispatcher: DispatcherConfig;
  storage: WikiStorageConfig;
  notifyOnSummarized: boolean; // 是否在总结完成后在群里发送轻提示
  /** 每日「主题校准」作业（默认每日 04:00，按群各自跑一次）。 */
  topics: TopicConfig;
  /** 相册投递面：词条与主题共用同一份相册目标（需要宿主提供 `ctx['miyako-delivery']`）。 */
  albumDelivery: AlbumDeliveryConfig;
  /** 群内查询与卡片投递。 */
  query: QueryConfig;
  /** 卡片素材池（背景图 / 一言的水位与离线模式）。 */
  media: MediaConfig;
  /** 管理面鉴权（`apiToken` 为空即全部 API 拒绝）。 */
  security: SecurityConfig;
  /**
   * 可观测性与排障留证开关。缺省（旧配置 / 未写该项）按**全部关闭**处理：
   * 普通用户只需要知识库与面板，排障证据由运维显式开启。
   */
  observability?: ObservabilityConfig;
}

/** 管理面鉴权配置。 */
export interface SecurityConfig {
  /**
   * 管理面 `/patchouli/api/*` 的访问令牌。**未配置时所有 API 一律 401**（fail closed；
   * 守卫对任何成因都只回 401 `{error:'unauthorized', reason}`，从不区分 403），
   * 公网部署前必须填写。页面可通过 `?token=` 或一次 `POST /login` 换取 Cookie。
   */
  apiToken: string;
}

/**
 * 相册投递配置。
 *
 * 词条与主题**共用同一份相册目标**：每轮讨论沉淀后立即投词条，主题仍按周定时；
 * 定时能力由 `miyako-delivery` 的 `scheduleCron` 承载，相册动作也只由该服务知道。
 */
export interface AlbumDeliveryConfig {
  /** 主题周报 cron 表达式（五段，默认每周一 04:30，本地时区）。 */
  cron: string;
  /** 相册目标 `<group_id>/<album_id>`，候选由控制台自动探测生成。 */
  albums: string[];
  /** 讨论沉淀后是否立即把词条长图投到上面的相册（默认开）。 */
  entryEnabled: boolean;
  /**
   * 灰度改道：非空时**所有词条卡片**改为发到该群聊天、不进相册（填裸群号）；
   * 主题周报不受影响。留空按相册投递。
   */
  entryRedirectChannelId: string;
}

/**
 * 卡片素材池配置。
 *
 * 生产方按水位批量抓取背景图与一言，落地到固定目录；渲染方每次消费一条。
 * 两边只通过目录交互，互不 import，因此抓取失败、断网、离线都不影响出图。
 */
export interface MediaConfig {
  /** 素材根目录；留空回退到 `<wikiDir>/.patchouli/media`。 */
  dir: string;
  /**
   * 离线模式：不抓新素材，已消费素材进冷却区，冷却结束后回到可用队列
   * （环形缓冲）。适合断网 / 限额场景，代价是素材会重复出现。
   */
  offline: boolean;
  /** 可用素材低于该值时补货。 */
  lowWater: number;
  /** 单次补货条数。 */
  batch: number;
  /** 离线模式下已消费素材的冷却时长（小时）。 */
  cooldownHours: number;
  /** 背景图来源（HTTP(S)，允许 302）。 */
  imageSource: string;
  /** 一言来源（HTTP(S)，返回 JSON `{ text }`）。 */
  sayingSource: string;
  /**
   * 可选：素材来源的 key。留空即匿名调用（公开端点不需要）；填写后作为 `key`
   * 查询参数附加到两个来源 URL，绝不写进日志或渲染产物。
   */
  apiKey: string;
}

/** 长图渲染配置（内部参数，控制台不展示）。 */
export interface QueryConfig {
  /** 长图最大高度（CSS px），超出按底部截断。 */
  cardMaxHeight: number;
}

/**
 * 可观测性配置。
 *
 * 内存侧的遥测（环形缓冲：全局 300 条 trace、每群 50 条、每群 1024 条账本事件）
 * 恒定开启——它驱动监控页且体积有硬上限；**落盘侧**的丢弃留证会占用磁盘，
 * 因此单独给开关，关闭时不落一个字节、也不建目录。
 */
export interface ObservabilityConfig {
  /**
   * 把被判定不沉淀的整轮讨论留证到 `<wikiDir>/.patchouli/discards/`。
   *
   * 默认 `false`。开启后仍受三重硬上限约束（份数 40 / 8 MiB / 单条 2000 字），
   * 不存在无界膨胀路径。
   */
  discardDumps: boolean;
}

/**
 * 单频道自适应节奏快照。
 *
 * 触发器每完成一次结算即落盘；插件重启时由 LocalStore 回灌，
 * 避免丢失已学习到的日常基线速率与 AIMD 控制器调节出的闸门参数。
 */
export interface CadenceStateSnapshot {
  channelId: string;
  /**
   * 该群当前生效的触发器参数（`minBurstRate` / `minDiscussionMessages` 等
   * 闸门字段由 AIMD 控制器逐轮写入）。
   */
  options: Partial<TriggerOptions>;
  /** 最近一次结算时的节奏度量与状态机阶段。 */
  metrics: CadenceMetrics;
  /**
   * 快照落盘时间（毫秒时间戳）。同时作为 AIMD 控制器的时间衰减基准
   * （`lastUpdated`），重启后据此计算停摆期的加性恢复步数。
   */
  updatedAt: number;
}

/**
 * 单群 AIMD 门限的只读视图（`GET /api/status` 的 `tuning` 字段）。
 *
 * AIMD 接管三个**物理闸门**：`minBurstRate`（rate 判据）、`thetaMin`（potential / shadow
 * 判据的 Θ_min）与 `minDiscussionMessages`（两种判据共用）。
 * 其余节奏参数（窗口、平息期、缓存上限、EWMA α）仍由配置直接决定，
 * 不参与自动校准，避免「调参把触发系统调死」的旧问题。
 */
export interface TuningSnapshot {
  /**
   * 当前生效的三个门限。AIMD 写入后恒落在 `limits` 内；
   * 从未校准过的群等于配置值（配置本身是运维逃生舱，不受硬限幅约束）。
   */
  parameters: {
    minBurstRate: number;
    minDiscussionMessages: number;
    thetaMin: number;
  };
  /** 物理硬限幅区间（含端点），越界一律夹回。 */
  limits: {
    readonly minBurstRate: readonly [number, number];
    readonly minDiscussionMessages: readonly [number, number];
    readonly thetaMin: readonly [number, number];
  };
  /** 时间向心力底数：每小时向配置锚点回落的保留比例。 */
  decayFactor: number;
  /** 触发 `HIGH_QUALITY` 加性放宽分支的质量分阈值。 */
  highQualityThreshold: number;
  /** 上次校准时刻（毫秒）；该群从未校准过（快照缺失）时为 `null`。 */
  lastUpdated: number | null;
}
