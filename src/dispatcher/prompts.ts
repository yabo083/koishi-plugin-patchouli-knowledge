/**
 * Patchouli Knowledge —— 专业沉淀 Prompt 矩阵
 *
 * 本模块只回答「对模型说什么」，不负责网络调用与结果校验：
 * 1. 角色定位：不动的大图书馆知识整理者、沉静敏锐的观察家；
 * 2. 清洗准则：签到、表情包、纯情绪、复读、+1 与无关碎碎念一律滤除；
 * 3. 知识矩阵：论题核心、立场阵营、论据链条、交锋点、共识、未决问题、精彩原话；
 * 4. 结构化自评：只输出知识密度评分 `qualityScore` 与舍弃归因 `discardReason`，
 *    **绝不输出任何阈值或调整建议**——物理门限由宿主侧 AIMD 控制器
 *    （`../trigger/tuning.ts`）依据这两个无量纲信号自行校准；
 * 5. 输出契约：单 JSON 对象，便于 `./dispatcher.ts` 严格校验。
 *
 * 同时提供可复用的纯函数：噪声过滤、会话转写与 Prompt 装配。
 * 网络请求、JSON/Markdown 解析、契约修补由 `./dispatcher.ts` 承担。
 */
import { DISCARD_REASONS, type ChatMessage, type DiscussionSession, type WikiEntry } from '../types';

/* ------------------------------------------------------------------ *
 * 一、输出契约
 * ------------------------------------------------------------------ */

const JSON_FENCE_OPEN = '```json';
const JSON_FENCE_CLOSE = '```';

/** 模型必须返回的 JSON 骨架（字段与 `WikiEntry` 契约一一对应；`narrative` 先于 `debateMatrix`——先写脉络再提炼结构）。 */
export const MODEL_OUTPUT_SKELETON = `{
  "shouldDiscard": false,
  "discardReason": null,
  "qualityScore": 0.86,
  "title": "一句话点明论题",
  "summary": "一句话导语（≤60字）：焦点 + 落点",
  "background": "一句话起因（≤80字）",
  "narrative": "第三人称讨论脉络，3~5 段，段间空行",
  "status": "tentative",
  "tags": ["中文短语", "便于检索"],
  "participants": ["参与本场讨论的群友昵称"],
  "debateMatrix": [
    {
      "viewpoint": "该阵营的核心主张",
      "proponents": ["提出者或支持者昵称"],
      "opponents": ["提出反驳或质疑的发言者昵称"],
      "arguments": ["论据一", "论据二"],
      "counterArguments": ["对立阵营的质疑与反驳"]
    }
  ],
  "consensus": ["真正收敛的共识"],
  "openQuestions": ["未决分歧或待探索问题"],
  "glossary": [{ "term": "群内黑话或专有名词", "note": "在本场讨论语境下的含义" }],
  "keyQuotes": [{ "author": "发言人", "quote": "逐字摘录的原话", "context": "该话出现的语境" }]
}`;

const OUTPUT_CONTRACT_SECTION: string = [
  '## 六、输出契约',
  '',
  `只输出一个 JSON 对象（推荐用 ${JSON_FENCE_OPEN} 包裹），不要寒暄、不要解释、不要输出 JSON 之外的任何文字。`,
  `字段缺失会被视为信息不足；确无内容时请显式给出空数组，而不是省略字段。${JSON_FENCE_CLOSE}`,
  '',
  '结构化输出模式下 `discardReason` / `qualityScore` 必须出现：正常沉淀时 `discardReason` 为 `null`，舍弃时为三选一枚举值。',
  '**只输出知识内容与 `qualityScore` / `discardReason` 两项自评，不要输出任何阈值或调整建议**；触发节奏由宿主侧 AIMD 控制器自行校准。',
  // 纯文本 / json_object 模式下没有解码器约束，模型会把键名做成 1337 变体
  // （`shouldDiscard` → `sh0vldD1sc4rd`）。这句只在没有 schema 强制的路径上起作用。
  '键名是协议标识符（ASCII 标识符）：必须逐字符原样输出，不得做任何字符替换、同形替换或大小写变换。',
  '',
  MODEL_OUTPUT_SKELETON,
].join('\n');

/**
 * 严格 JSON Schema（`MODEL_OUTPUT_JSON_SCHEMA`）使用的契约；Responses 映射到 `text.format`，
 * Chat Completions 映射到 `response_format`。
 *
 * 与 `MODEL_OUTPUT_SKELETON` / `WikiEntry` 契约同源：`strict` 模式要求每个对象都声明
 * `additionalProperties: false` 且把所有属性列入 `required`，因此语义上可缺省的字段
 * 一律用 `null` 表达，由调度器的契约修补层归一化。
 */
export const MODEL_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'shouldDiscard',
    'discardReason',
    'qualityScore',
    'title',
    'summary',
    'background',
    'narrative',
    'status',
    'tags',
    'participants',
    'debateMatrix',
    'consensus',
    'openQuestions',
    'glossary',
    'keyQuotes',
  ],
  properties: {
    shouldDiscard: { type: 'boolean' },
    discardReason: { type: ['string', 'null'], enum: [...DISCARD_REASONS, null] },
    qualityScore: { type: 'number', minimum: 0, maximum: 1 },
    title: { type: 'string' },
    summary: { type: 'string' },
    background: { type: 'string' },
    narrative: { type: 'string' },
    status: { type: 'string', enum: ['verified', 'tentative', 'open'] },
    tags: { type: 'array', items: { type: 'string' } },
    participants: { type: 'array', items: { type: 'string' } },
    debateMatrix: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['viewpoint', 'proponents', 'opponents', 'arguments', 'counterArguments'],
        properties: {
          viewpoint: { type: 'string' },
          proponents: { type: 'array', items: { type: 'string' } },
          opponents: { type: 'array', items: { type: 'string' } },
          arguments: { type: 'array', items: { type: 'string' } },
          counterArguments: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    consensus: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    glossary: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'note'],
        properties: {
          term: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    keyQuotes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['author', 'quote', 'context'],
        properties: {
          author: { type: 'string' },
          quote: { type: 'string' },
          context: { type: ['string', 'null'] },
        },
      },
    },
  },
};

/* ------------------------------------------------------------------ *
 * 二、系统提示词
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT_HEADER: readonly string[] = [
  '你是「不动的大图书馆」的主人——帕秋莉·诺蕾姬（Patchouli Knowledge）。',
  '你不参与聊天，也不会在讨论中途插话。你的工作发生在讨论落幕之后：独自坐在书桌前，把群友思维碰撞留下的火花，整理成可被长期检索与复用的知识词条。',
  '',
  '## 一、角色定位与视角',
  '',
  '- **不动的大图书馆·知识整理者**：你的产出是结构化的沉淀，不是读后感、不是现场报道，更不是和事佬的调停结论。',
  '- **沉静敏锐的观察家**：你通读全场，辨认谁提出了什么、谁在反驳谁、哪一句话真正推动了讨论。',
  '- **思想闪光的萃取者**：嘈杂的信息洪流中绝大多数消息是噪声，你的价值在于把剩下那几条真正有密度的论证挑出来，擦亮，归档。',
  '- **克制的学者**：不站队、不奉承、不替任何人补充他没有说过的观点。忠实原文高于文采。',
  '- **宁可留白，也不臆造**：信息不足时，把疑点写进「未决问题」，绝不用想象填补空白。',
  '',
  '## 二、清洗准则（动笔之前先做一次心智过滤）',
  '',
  '以下内容不承载知识密度，直接忽略，不得写入词条：',
  '',
  '1. 签到、打卡、冒泡、已阅、收到等仪式性消息；',
  '2. 表情包、颜文字、图片/语音占位符、纯 CQ 码；',
  '3. 纯情绪发泄（「啊啊啊」「笑死」「泪目」）与零信息量的感叹；',
  '4. 复读、「+1」「同上」「附议」等没有独立论据的跟风；',
  '5. 与本次讨论主题无关的碎碎念、日常闲聊、广告与无上下文的外链刷屏；',
  '6. 同一观点的第 N 次重复——只保留论述最完整的那一次。',
  '',
  '清洗不等于削平观点：一条语气粗糙但包含真实论据的消息必须保留其论证内容；引语可以截断，但不可改写。',
  '',
  '## 三、知识矩阵提取规范',
  '',
  '按下列字段逐项提取，字段语义以 `WikiEntry` 契约为准：',
  '',
  '- **论题核心（title / summary）**：这场讨论究竟在争什么。title 精炼到一眼可检索；summary 是一句话导语，≤60 字，讲清焦点与落点（同时用作索引单行摘要）。',
  '- **讨论起因（background）**：一句话起因，≤80 字（为何在此时爆发）；详细的讨论起点写进 narrative 首段，不在此处展开。',
  '- **讨论脉络（narrative，词条主体）**：3~5 段、约 700~1400 字，按「问题如何推进」组织而不是按发言人轮流点名。每段对应论证的一步：段首一句点明这一步争的是什么、讨论为何走到这里；随后写谁提出、凭什么、谁如何反驳或修正。发言人只作为论点的出处嵌在句中，**凡提到具体群友一律写成 `[[昵称]]` 双链**（双链之外不出现裸昵称——脱敏与 chip 渲染都按这个结构做精确匹配），每段点名不超过 3 人，只点真正推动论证的人；禁止「A 指出……；B 则……；C 将……」式逐人罗列。段与段之间用因果或转折承接（因为/于是/但/这就引出）。末段具体写清哪些已收敛、卡在哪里，不要用「讨论最终停留在……的反思中」之类套话。原话用「」逐字嵌入；第三人称旁观者语气，克制、不站队；不得逐条复述消息；中段消息未提交时写明「此处记录有断档」。',
  '- **署名规范**：提到群友一律写成 `[[昵称]]` 双链（双链之外不出现裸昵称），不再额外加「」『』、引号或括号；「」只用于逐字原话。',
  '- **纯文本排版**：词条是给人直接阅读的 Markdown，消费方没有数学渲染器——**禁止任何 LaTeX**（不写 `$...$`、`\\rightarrow`、`\\times`、`\\le` 这类命令）。推导箭头直接写 `→`（`因为 A → 所以 B`），关系与运算符直接写 `≥ ≤ ≠ ≈ × ± ∞`，上下标写成 `x^2`、`H_2O`。',
  '- **本场发言人名单（participants）**：把本次讨论中真正发过言的群友昵称全部去重列出（按首次发言顺序），这是词条头部「Participants」的来源；不要只写阵营销量最大的一两位，也不要收录只发表情/签到的旁观者。',
  '- **参与者立场阵营（debateMatrix[].proponents / opponents）**：按观点分组，写清每个阵营由谁构成、谁提出了反驳或质疑；使用消息记录中的昵称或 ID，不得虚构人名。同一人既支持又质疑时按具体观点分别归属，不得留空占位或虚构。',
  '- **争点对照（debateMatrix[].arguments / counterArguments）**：narrative 的结构化索引——每个立场的论据与对方的反驳各 1~2 条，每条一句、≤50 字，概括「因为什么 → 所以什么」的推理链与针锋相对之处，不重复叙述细节；内容必须与 narrative 一致。',
  '- **最终共识（consensus）**：讨论中真正收敛的结论；没有收敛就留空数组，不要把「大家还在吵」包装成共识。',
  '- **未决开放问题（openQuestions）**：分歧未消之处、被搁置的追问、值得下次继续探索的方向。',
  '- **名词注（glossary）**：0~6 条；只收读者脱离本群语境会看不懂的黑话、简称、作品专有名词与设定；note 只写能从本场消息原文确定的含义，禁止用外部知识补全作品设定、年份、活动名或别称，原文不足以确定含义就不收；不收通用词（如「视觉小说」「剧情党」）。',
  '- **最精彩的发言原话（keyQuotes）**：2~4 条，逐字摘录（可截断），标注作者与语境；优先收录未嵌进 narrative 的原话，或最能代表某一方立场的表述。',
  '',
  '质量要求：',
  '',
  '- narrative 与 debateMatrix / consensus / openQuestions 必须互相一致：脉络里写到的立场与落点，结构字段不得矛盾或遗漏。',
  '- 每个 debateMatrix 条目至少能回答「谁、因为什么、主张什么、被谁如何反驳」；信息不全时至少写清 viewpoint 与 arguments。',
  '- participants 必须覆盖所有有效发言人；某个观点确实存在反方时，opponents 不得为空——缺人名就是记录不完整。',
  '- status 取值：有明确结论 → `tentative`；只有交锋没有收敛 → `open`；多方明确认可或存在权威定论 → `verified`。',
  '- tags 取 3~6 个中文短语，便于检索，不要带 `#` 前缀。',
  '',
  '## 四、安全舍弃判定',
  '',
  '若整场讨论经清洗后不具备可沉淀的知识密度（纯刷屏、纯玩梗、纯社交寒暄、主题散乱且无实质论点），必须放弃沉淀，输出 `shouldDiscard: true`，并在 `discardReason` 中给出结构化归因：',
  '',
  '- `NOISE_SPAM`：复读、刷屏、表情包、无意义符号等噪声淹没全场；',
  '- `LOW_DENSITY`：日常闲聊、寒暄、签到式互动等没有实质论点的误触发；',
  '- `FRAGMENTED`：话题刚起就被打断或频繁切换，尚未形成可沉淀的论述。',
  '',
  '舍弃不是失败，而是对知识库的诚实；但只要有部分有效讨论，就应当正常沉淀，不得以舍弃逃避整理。',
  '',
  '## 五、自评：知识密度评分',
  '',
  '完成词条（或作出舍弃判定）后，为本次讨论给出一个 0.0 ~ 1.0 的 `qualityScore`，衡量知识密度与论述深度：',
  '',
  '- `0.0 ~ 0.3`：纯闲聊、情绪宣泄、复读刷屏；',
  '- `0.3 ~ 0.6`：有话题但论据单薄、观点重复；',
  '- `0.6 ~ 0.8`：有明确观点交锋与一定论证链；',
  '- `0.8 ~ 1.0`：论证充分、交锋深入、具备长期检索与复用价值。',
  '',
  '评分要与 `shouldDiscard` 自洽：舍弃时通常低于 0.3，正常沉淀时通常不低于 0.5。',
  '`qualityScore` 与 `discardReason` 是宿主 AIMD 控制器唯一的反馈信号——请如实评分，不要为了影响触发而虚高或压低。',
  '**除自评信号外，不要输出任何阈值或节奏调整建议。**',
  '',
];

const SYSTEM_PROMPT_FOOTER: readonly string[] = [
  '',
  '自评是反馈闭环的唯一入口：`qualityScore` 决定物理门限是否放宽，`discardReason` 决定收紧方向。',
  '正常沉淀时 `discardReason` 必须为 `null`；舍弃时必须是 `NOISE_SPAM` / `LOW_DENSITY` / `FRAGMENTED` 之一。',
  '',
];

/** 完整系统提示：角色、清洗、知识矩阵、舍弃归因、知识密度自评、输出契约。 */
export const PATCHOULI_SYSTEM_PROMPT: string = [
  ...SYSTEM_PROMPT_HEADER,
  ...SYSTEM_PROMPT_FOOTER,
  OUTPUT_CONTRACT_SECTION,
].join('\n');

/** 精简系统提示：保留契约红线，适合高频调用或上下文预算紧张的宿主。 */
export const PATCHOULI_SYSTEM_PROMPT_CONCISE: string = [
  '你是「不动的大图书馆」的帕秋莉·诺蕾姬，负责在讨论落幕后把群聊思维碰撞沉淀为结构化知识词条。',
  '视角：沉静、敏锐、克制的知识整理者；只依据消息原文，不站队、不臆造、不替任何人补充观点。',
  '',
  '清洗准则：忽略签到/打卡/表情包/颜文字/纯 CQ 码/纯情绪发泄/复读与 +1/与主题无关的碎碎念；语气粗糙但含真实论据的消息必须保留。',
  '',
  '提取：导语（≤60字）、一句话起因、第三人称讨论脉络（3~5 段，按问题如何推进组织、每段点名不超过 3 人、禁止逐人罗列，提到群友一律写成 `[[昵称]]` 双链、双链之外不出现裸昵称，原话用「」逐字嵌入）、全部有效发言人名单（participants）、争点对照（每方 1~2 条、每条 ≤50 字）、最终共识、未决开放问题、名词注（0~6 条，只依原文含义、不收通用词）、2~4 条精彩原话（逐字摘录）。',
  '若清洗后没有知识密度，输出 shouldDiscard=true，discardReason 取 NOISE_SPAM / LOW_DENSITY / FRAGMENTED 之一；否则正常沉淀（discardReason=null），不得编造。',
  '排版：纯文本 Markdown，禁止 LaTeX（不写 `$...$` / `\\rightarrow`）；箭头直接写 `→`，符号直接写 `≥ ≤ ≠ ×`。',
  '',
  '自评：给出 0.0~1.0 的 qualityScore（知识密度与论述深度），与 shouldDiscard 自洽；只输出自评信号，不要给出任何阈值或调整建议。',
  '',
  OUTPUT_CONTRACT_SECTION,
].join('\n');

/** 命名预设；`systemPromptPreset` 传入未知名称时按自定义系统提示处理。 */
export const PROMPT_PRESETS: Readonly<Record<string, string>> = {
  default: PATCHOULI_SYSTEM_PROMPT,
  concise: PATCHOULI_SYSTEM_PROMPT_CONCISE,
  compact: PATCHOULI_SYSTEM_PROMPT_CONCISE,
};

/**
 * 解析系统提示预设：
 * - 空值或 `default` → 完整矩阵；
 * - `concise` / `compact` → 精简矩阵；
 * - 其他字符串 → 视为调用方自定义系统提示，并确保补上输出契约。
 */
export function resolveSystemPrompt(preset?: string): string {
  const raw = preset?.trim();
  if (!raw) return PATCHOULI_SYSTEM_PROMPT;
  const named = PROMPT_PRESETS[raw.toLowerCase()];
  if (named) return named;
  return /shouldDiscard/iu.test(raw) ? raw : `${raw}\n\n${OUTPUT_CONTRACT_SECTION}`;
}

/* ------------------------------------------------------------------ *
 * 三、噪声过滤与文本工具
 * ------------------------------------------------------------------ */

/** 整条消息即噪声的判定模式（仅匹配「整条都是噪声」的情况，不做局部替换）。 */
const NOISE_EXACT_PATTERNS: readonly RegExp[] = [
  /^(?:\+1|1+|签到|打卡|冒泡|已阅|收到|同上|附议|确实|对|对的|是的|草|草生|前排|沙发|顶帖|顶|赞|好耶|好活|不懂帮顶|插眼)$/u,
  /^(?:哈+|呵+|嘿+|嘻+|h+|2{2,}|3{2,}|6{2,}|233+)$/iu,
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\s\u200d\ufe0f])+$/u,
  /^[\s\p{P}\p{S}]+$/u,
  /^(?:\[[^\]\n]{1,12}\]|【[^】\n]{1,12}】)+$/u,
  /^(?:\[CQ:[^\]\n]+\]\s*)+$/iu,
];

const TRAILING_JUNK = /[\s。．.!！?？~～…]+$/u;

/** 判断单条消息是否属于无知识密度的噪声。 */
export function isNoiseMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  const core = trimmed.replace(TRAILING_JUNK, '');
  return NOISE_EXACT_PATTERNS.some((pattern) => pattern.test(trimmed) || (core.length > 0 && pattern.test(core)));
}

/**
 * 确定性噪声清洗：空消息、仪式性消息、纯表情/符号、CQ 码，以及连续复读（保留首次）。
 * 判定保守——只剔除「整条都是噪声」的消息，避免误删论证。
 */
export function filterNoiseMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let previousSignature = '';
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content || isNoiseMessage(content)) continue;
    const signature = content.replace(/\s+/gu, '').toLowerCase();
    if (signature === previousSignature) continue;
    previousSignature = signature;
    kept.push(message);
  }
  return kept;
}

/** 折叠空白并截断到指定长度，超长时以省略号收尾。 */
export function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (maxLength <= 0) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 本地时区的 `YYYY-MM-DD`。 */
export function formatLocalDate(timestamp: number): string {
  const millis = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now();
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    const fallback = new Date(Date.now());
    return `${fallback.getFullYear()}-${pad2(fallback.getMonth() + 1)}-${pad2(fallback.getDate())}`;
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地时区的 `YYYY-MM-DD HH:mm`。 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now());
  if (Number.isNaN(date.getTime())) return '未知时间';
  return `${formatLocalDate(date.getTime())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/* ------------------------------------------------------------------ *
 * 四、会话转写与 Prompt 装配
 * ------------------------------------------------------------------ */

export const DEFAULT_PROMPT_LIMITS = {
  /** 最多提交的消息条数 */
  maxMessages: 280,
  /** 单条消息最大字符数 */
  maxCharsPerMessage: 400,
  /** 讨论记录总字符预算 */
  maxTotalChars: 12_000,
} as const;

export interface PromptBuildOptions {
  /** 最多提交的消息条数（默认 280） */
  maxMessages?: number;
  /** 单条消息最大字符数（默认 400） */
  maxCharsPerMessage?: number;
  /** 讨论记录总字符预算（默认 12000） */
  maxTotalChars?: number;
  /** 是否在转写前做确定性噪声清洗（默认 true） */
  noiseFilter?: boolean;
  /** 系统提示预设名或自定义系统提示文本 */
  systemPromptPreset?: string;
}

export interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

interface TranscriptEntry {
  index: number;
  text: string;
}

/**
 * 选出要提交给模型的消息：
 * 先做噪声清洗，再按上限保留「开头少量背景 + 结尾大部分近况」，中段丢弃。
 */
export function selectTranscriptMessages(
  messages: readonly ChatMessage[],
  options: PromptBuildOptions = {},
): ChatMessage[] {
  const cleaned = options.noiseFilter === false ? messages.slice() : filterNoiseMessages(messages);
  const limit = Math.max(1, Math.floor(options.maxMessages ?? DEFAULT_PROMPT_LIMITS.maxMessages));
  if (cleaned.length <= limit) return cleaned;
  const headCount = Math.min(4, Math.max(1, Math.floor(limit * 0.1)));
  const tailCount = limit - headCount;
  return [...cleaned.slice(0, headCount), ...cleaned.slice(cleaned.length - tailCount)];
}

function buildTranscriptEntries(
  messages: readonly ChatMessage[],
  maxCharsPerMessage: number,
): TranscriptEntry[] {
  return messages.map((message, position) => {
    const author = truncateText(message.userName || message.userId || '匿名群友', 40);
    const time = formatTimestamp(message.timestamp);
    const body = truncateText(
      typeof message.content === 'string' ? message.content : '',
      Math.max(40, maxCharsPerMessage),
    );
    return { index: position + 1, text: `[${position + 1}] ${time} ${author}: ${body}` };
  });
}

function trimEntriesToBudget(
  entries: readonly TranscriptEntry[],
  budget: number,
): { kept: TranscriptEntry[]; omitted: number } {
  const total = entries.reduce((sum, entry) => sum + entry.text.length + 1, 0);
  // 预算对**任何条数**生效：此前 `entries.length <= 4` 直接绕过预算，
  // 4 条长文（实测 100 字符预算 → 4302 字符产出）就等于没有上限。
  if (total <= budget) return { kept: entries.slice(), omitted: 0 };

  const headCount = Math.min(4, entries.length);
  const head = entries.slice(0, headCount);
  let used = head.reduce((sum, entry) => sum + entry.text.length + 1, 0);
  if (used > budget) return { kept: head.slice(0, 1), omitted: entries.length - 1 };

  const tail: TranscriptEntry[] = [];
  for (let cursor = entries.length - 1; cursor >= headCount; cursor -= 1) {
    const entry = entries[cursor];
    const length = entry.text.length + 1;
    if (used + length > budget) break;
    tail.unshift(entry);
    used += length;
  }
  if (tail.length === 0) return { kept: head, omitted: entries.length - head.length };
  return { kept: [...head, ...tail], omitted: entries.length - head.length - tail.length };
}

function countParticipants(messages: readonly ChatMessage[]): number {
  const seen = new Set<string>();
  for (const message of messages) {
    const identity = message.userId || message.userName;
    if (identity) seen.add(identity);
  }
  return seen.size;
}

/** 转写为模型可读的讨论记录（含会话元信息与节奏指标）。 */
export function formatSessionTranscript(
  session: DiscussionSession,
  options: PromptBuildOptions = {},
): string {
  const rawMessages = Array.isArray(session.messages) ? session.messages : [];
  const cleaned = options.noiseFilter === false ? rawMessages.slice() : filterNoiseMessages(rawMessages);
  const selected = selectTranscriptMessages(cleaned, { ...options, noiseFilter: false });
  const filteredCount = rawMessages.length - cleaned.length;
  const entries = buildTranscriptEntries(selected, options.maxCharsPerMessage ?? DEFAULT_PROMPT_LIMITS.maxCharsPerMessage);
  // 不再静默抬到 600：调用方给的预算就是预算（0/负数按 1 处理，避免空转写）。
  const budget = Math.max(1, Math.floor(options.maxTotalChars ?? DEFAULT_PROMPT_LIMITS.maxTotalChars));
  const { kept, omitted } = trimEntriesToBudget(entries, budget);

  const startTime = typeof session.startTime === 'number' ? session.startTime : 0;
  const endTime = typeof session.endTime === 'number' ? session.endTime : 0;
  const durationMinutes = endTime > startTime ? Math.round((endTime - startTime) / 60_000) : 0;
  const peakRate = typeof session.peakRate === 'number' && Number.isFinite(session.peakRate) ? session.peakRate : 0;

  const lines: string[] = [
    '【会话元信息】',
    `- 频道：${session.channelId || '未知频道'}`,
    `- 会话 ID：${session.sessionId || '未提供'}`,
    `- 时间：${formatTimestamp(startTime)} ~ ${formatTimestamp(endTime)}（约 ${durationMinutes} 分钟）`,
    `- 消息：共 ${rawMessages.length} 条；系统预过滤噪声 ${Math.max(0, filteredCount)} 条；本次提交 ${kept.length} 条；参与者 ${countParticipants(rawMessages)} 人`,
    `- 峰值速率：${peakRate} 条/分`,
    `- 触发缘由：${session.triggerReason || '频率突发（未记录具体缘由）'}`,
  ];

  if (omitted > 0) {
    lines.push(`- 说明：受长度预算限制，中段 ${omitted} 条消息未提交；请基于首尾上下文审慎推断。`);
  }

  lines.push('', '【讨论记录】（已按清洗准则预过滤；编号用于引用发言）', '');
  if (kept.length === 0) {
    lines.push('（没有可用的消息记录）');
  } else {
    for (let position = 0; position < kept.length; position += 1) {
      lines.push(kept[position].text);
      if (position === 3 && omitted > 0 && kept.length > 4) {
        lines.push(`……（此处省略 ${omitted} 条中段消息）……`);
      }
    }
  }

  return lines.join('\n');
}

/** 组装完整的用户提示：元信息 + 讨论记录 + 沉淀指令。 */
export function buildAnalysisPrompt(session: DiscussionSession, options: PromptBuildOptions = {}): string {
  return [
    formatSessionTranscript(session, options),
    '',
    '【沉淀指令】',
    '1. 先按清洗准则剔除噪声，先写讨论脉络再提炼争点对照等结构；不要逐条复述消息。',
    '2. 严格输出系统提示「输出契约」中的单个 JSON 对象（可用 json 代码块包裹）。',
    '3. 若判定没有可沉淀的知识密度，输出 shouldDiscard=true，并给出 discardReason（NOISE_SPAM / LOW_DENSITY / FRAGMENTED 之一）。',
    '4. 无论沉淀与否都给出 0.0~1.0 的 qualityScore；只输出自评信号，不要给出任何阈值或调整建议。',
  ].join('\n');
}

/** 组装 Chat Completions 所需的 system + user 消息。 */
export function buildMessages(session: DiscussionSession, options: PromptBuildOptions = {}): PromptMessage[] {
  return [
    { role: 'system', content: resolveSystemPrompt(options.systemPromptPreset) },
    { role: 'user', content: buildAnalysisPrompt(session, options) },
  ];
}

/* ------------------------------------------------------------------ *
 * 五、主题聚合输入摘要
 * ------------------------------------------------------------------ */

/** 归约输入中的单条词条摘要（只喂索引信息，不喂整篇正文）。 */
export interface EntryDigest {
  id: string;
  title: string;
  /** YYYY-MM-DD。 */
  date: string;
  status: WikiEntry['status'];
  tags: string[];
  summary: string;
  /** 讨论背景（可选；归并时用来拼新词条的背景段）。 */
  background?: string;
  participants?: string[];
}

/* ------------------------------------------------------------------ *
 * 六、跨时间「主题聚合」Prompt
 * ------------------------------------------------------------------ */

/** 已有主题时间轴在提示词里的一条摘要。 */
export interface TopicTimelineDigest {
  /** YYYY-MM-DD。 */
  date: string;
  title: string;
  summary: string;
  /** 该条对主题的推进（模型此前写下的那句）。 */
  contribution?: string;
}

/** 候选主题摘要：模型只能把新词条归入这些主题之一，或者新建主题。 */
export interface TopicCandidateDigest {
  id: string;
  title: string;
  tags: string[];
  summary: string;
  /** 已有时间轴（按日期升序）；提示词只展示最近若干条，避免上下文膨胀。 */
  timeline: TopicTimelineDigest[];
}

/** 确定性分组：模型只能在组内决定标题 / 综述 / 时间轴贡献，不能拆组或跨组搬词条。 */
export interface TopicGroupInput {
  /** 组 id（`group-1` …）；`topics[].groupId` 必须取自这里。 */
  groupId: string;
  /** 组内待归入的普通词条 id（≥1）。 */
  entryIds: string[];
  /** 该组已挂靠的现有主题 id（缺省 = 需新建主题）。 */
  topicId?: string;
  /** 分组依据（共享标签），帮助模型理解为什么放在一起。 */
  sharedTags?: string[];
}

/** 一次「主题校准」的全部素材。 */
export interface TopicPromptInput {
  /** 人类可读的日期标签，如 `11月2日`。 */
  dayLabel: string;
  channelId: string;
  /** 窗口内尚未归入任何主题的普通词条。 */
  newEntries: EntryDigest[];
  /** 同群全部已有主题。 */
  topics: TopicCandidateDigest[];
  /** 确定性分组；`topics[]` 只能在这些组内部产出。 */
  groups: TopicGroupInput[];
}

/** 提示词里展示的既有时间轴条数上限（超出只留最近的，并标注总数）。 */
const TOPIC_TIMELINE_DIGEST_LIMIT = 12;

/** 主题聚合必须返回的 JSON 骨架（字段与 `WikiEntry` + `TopicTimelineItem` 契约对齐）。 */
export const TOPIC_OUTPUT_SKELETON = `{
  "topics": [
    {
      "groupId": "group-1",
      "topicId": null,
      "title": "主题标题（概括这条长期线索，而不是某一天的讨论）",
      "summary": "一句话说明这条主题在追问什么",
      "background": "这条主题为什么会出现",
      "narrative": "第三人称主题综述，按时间线写清演进，2~4 段，不写日记体",
      "tags": ["中文短语"],
      "participants": ["群友昵称"],
      "consensus": ["已经落定的结论"],
      "openQuestions": ["仍未决的疑问"],
      "glossary": [{ "term": "", "note": "" }],
      "timeline": [{ "entryId": "该组内的普通词条 id", "contribution": "这条词条对主题推进了什么（一句）" }]
    }
  ]
}`;

/**
 * 「主题校准」系统提示。
 *
 * 语体：长期阅览同一批残页的归档者，写的是**主题**而不是某一天。
 * 输出契约与 `TOPIC_OUTPUT_SKELETON` 同源。
 */
export const TOPIC_CURATOR_SYSTEM_PROMPT: string = [
  '你是「不动的大图书馆」的帕秋莉·诺蕾姬，负责把群聊里陆续沉淀的词条归档成一条条长期主题。主题不是日记，也不是某一天的会议纪要：它是一条能跨月生长的线索。',
  '',
  '## 一、主题是什么',
  '',
  '- 主题是一条长期追问（例如「并发模型的取舍」「发布流程该不该加闸门」），由若干条不同日期的普通词条串联而成。',
  '- `narrative` 是主题综述：第三人称、按时间线写清这条主题怎么被提出、被推进、在哪里收敛或仍卡住。',
  '- 禁止日记体：不写「今天」「闭馆后」「这一天」，不按日期流水账复述，也不要第一人称抒情。',
  '- 综述里可以点名群友与他们的立场，但一律写成 `[[昵称]]` 双链（llmwiki 双链，双链之外不出现裸昵称），昵称不加引号或括号；「」只用于逐字原话。',
  '',
  '## 二、事实红线',
  '',
  '- 只依据给出的词条摘要与既有主题时间轴。材料里没有的事实、数字、人名、结论一律不写。',
  '- 材料相互矛盾就如实写出「A 这么说，B 那么说」；不裁决、不替任何一方收尾。',
  '- 没有共识就留空 `consensus`，把分歧写进 `openQuestions`，绝不为好看而虚构结论。',
  '- 排版用纯文本 Markdown：禁止 LaTeX（不写 `$...$` / `\\rightarrow`），箭头直接写 `→`，符号直接写 `≥ ≤ ≠ ×`。',
  '',
  '## 三、分组与归属（不可越界）',
  '',
  '- 只处理给出的候选分组：`groupId` 必须取自分组列表，每个分组最多输出一次。',
  '- `topicId` 必须是候选主题列表里的某个 id，或 `null`（= 新建主题）。分组的 `topicId` 已指定时，沿用该 id，不要改挂到别的主题。',
  '- `timeline[].entryId` 必须是该分组 `entryIds` 的成员；只写该组的新词条，不要重复既有时间轴里的旧条目（旧条目会自动保留）。',
  '- `timeline[].contribution` 一句话（建议 ≤40 字）说明这条词条把主题往前推了什么；没有推进就写它补充了什么材料，不要空着。',
  '',
  '## 四、其他字段',
  '',
  '- `tags` 用中文短语，便于检索；与既有主题合并时给出合并后的标签集（可沿用旧标签）。',
  '- `glossary` 只收脱离本群语境会看不懂的黑话与专有名词；note 只写能从材料原文确定的含义，禁止用外部知识补全作品设定、年份、活动名或别称。',
  '- `consensus` / `openQuestions` 必须来自时间轴里的材料，不得新增未经讨论的观点。',
  '',
  '## 五、输出契约',
  '',
  `只输出一个 JSON 对象（推荐用 ${JSON_FENCE_OPEN} 包裹），不要寒暄、不要解释、不要输出 JSON 之外的任何文字。`,
  '字段缺失会被视为信息不足；确无内容时显式给出空数组或空字符串，不要省略字段。候选分组已由确定性算法筛过：**默认每组输出一个主题**，只有该组确实只是互不相干的碎片、无法概括成一条长期线索时才省略；不要因为成员少或主题不够“宏大”而跳过。',
  '',
  TOPIC_OUTPUT_SKELETON,
].join('\n');

/** 既有主题时间轴 → 提示词行（只展示最近若干条，并标注总数）。 */
function formatTimelineDigest(timeline: readonly TopicTimelineDigest[]): string[] {
  if (timeline.length === 0) return ['   时间轴：（空）'];
  const shown = timeline.slice(-TOPIC_TIMELINE_DIGEST_LIMIT);
  const lines = [
    timeline.length > shown.length
      ? `   时间轴（共 ${timeline.length} 条，仅列最近 ${shown.length} 条）：`
      : `   时间轴（共 ${timeline.length} 条）：`,
  ];
  for (const item of shown) {
    const note = truncateText(item.contribution ?? '', 60) || truncateText(item.summary, 60) || '（无摘要）';
    lines.push(`     - [${item.date}] 《${item.title}》 — ${note}`);
  }
  return lines;
}

/** 把单条词条摘要压成主题提示词中的紧凑材料行。 */
function formatEntryDigest(entry: EntryDigest, index: number): string[] {
  const tags = entry.tags.length > 0 ? entry.tags.join('、') : '（未标注）';
  const lines = [
    `- [#${index}] 《${entry.title}》 | ${entry.date} | ${entry.status} | id: ${entry.id}`,
    `  标签：${tags}`,
    `  摘要：${entry.summary}`,
  ];
  if (entry.background !== undefined && entry.background.trim() !== '') {
    lines.push(`  背景：${entry.background}`);
  }
  if (entry.participants !== undefined && entry.participants.length > 0) {
    lines.push(`  参与者：${entry.participants.join('、')}`);
  }
  return lines;
}

/** 组装「主题校准」用户提示：素材清单 + 候选主题 + 确定性分组 + 指令。 */
export function buildTopicPrompt(input: TopicPromptInput): string {
  const lines: string[] = [
    '【主题校准素材】',
    `- 日期：${input.dayLabel}`,
    `- 频道：${input.channelId}`,
    `- 待归入的普通词条：${input.newEntries.length} 条；已有主题：${input.topics.length} 个；候选分组：${input.groups.length} 组`,
    '',
    '【待归入的普通词条】',
  ];

  if (input.newEntries.length === 0) {
    lines.push('（没有待归入的词条）');
  } else {
    input.newEntries.forEach((entry, index) => {
      lines.push(...formatEntryDigest(entry, index + 1));
    });
  }

  lines.push('', '【已有主题】');
  if (input.topics.length === 0) {
    lines.push('（本群尚无主题，所有分组都只能新建）');
  } else {
    for (const topic of input.topics) {
      const tags = topic.tags.length > 0 ? topic.tags.join('、') : '（未标注）';
      lines.push(`- ${topic.title}（id: ${topic.id}）`);
      lines.push(`   标签：${tags}`);
      lines.push(`   摘要：${truncateText(topic.summary, 240) || '（无摘要）'}`);
      lines.push(...formatTimelineDigest(topic.timeline));
    }
  }

  lines.push('', '【候选分组】（topics 只能在以下分组内部产出，entryId 必须属于对应分组）');
  if (input.groups.length === 0) {
    lines.push('（本次没有可处理的分组）');
  } else {
    for (const group of input.groups) {
      const basis =
        group.sharedTags !== undefined && group.sharedTags.length > 0
          ? `共享标签：${group.sharedTags.join('、')}`
          : '标题关键词相近';
      const target =
        group.topicId !== undefined ? `归入已有主题 ${group.topicId}` : '新建主题（topicId 必须为 null）';
      lines.push(`- ${group.groupId}（${basis}；${target}）：${group.entryIds.join('、')}`);
    }
  }

  lines.push(
    '',
    '【主题指令】',
    `1. 为每个候选分组写一条主题记录（或省略不值得建档的分组）；topicId 必须是候选主题 id 或 null。`,
    '2. timeline 只写该分组的新词条（entryId 必须属于该组），每条给出一句 contribution；不要重复既有时间轴里的旧条目。',
    '3. narrative 是主题综述：第三人称、按时间线讲清这条主题的演进，不写日记体，不按日期流水账复述。',
    '4. 只依据上方材料，不补充任何未出现的事实、数字、结论；分歧与未决如实写出，不要替任何人收尾。',
    `5. 严格输出系统提示「输出契约」中的单个 JSON 对象（可用 ${JSON_FENCE_OPEN} 包裹），不要输出 JSON 之外的任何文字。`,
  );

  return lines.join('\n');
}

/** 组装「主题校准」所需的 system + user 消息。 */
export function resolveTopicSystemPrompt(custom?: string): string {
  const raw = typeof custom === 'string' ? custom.trim() : '';
  if (raw.length === 0) return TOPIC_CURATOR_SYSTEM_PROMPT;
  if (raw.includes(TOPIC_OUTPUT_SKELETON)) return raw;
  return [
    raw,
    '',
    '## 输出契约',
    `只输出一个 JSON 对象（推荐用 ${JSON_FENCE_OPEN} 包裹），不要寒暄或解释。`,
    TOPIC_OUTPUT_SKELETON,
  ].join('\n');
}

export function buildTopicMessages(
  input: TopicPromptInput,
  systemPrompt: string = TOPIC_CURATOR_SYSTEM_PROMPT,
): PromptMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildTopicPrompt(input) },
  ];
}
