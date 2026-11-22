/**
 * Patchouli Knowledge - 出图前的敏感信息脱敏（纯函数，零依赖，不碰磁盘）
 *
 * 出图管线（`renderEntryLongImageHtml`）在渲染前把 `PublicWikiView` 过一遍本模块：
 *  - 真实昵称 → 幻想乡角色名（同一 masker 内稳定，跨 masker 按 seed 重新洗牌）；
 *  - 正文里的 `@提及` → `@<别名>`；
 *  - 独立的 5~12 位数字（QQ 号 / 群号）→ 稳定伪号。
 *
 * 铁律：
 *  - 纯函数：不读写文件、不发网络请求、不依赖 Koishi；
 *  - `maskPublicView` 返回新对象，**绝不**修改入参（调用方可继续按原样使用视图）；
 *  - 空串 / 纯空白名称原样返回，任何输入都不抛异常。
 */

import type {
  PublicDebatePoint,
  PublicQuote,
  PublicTimelineItem,
  PublicWikiView,
} from './public-view';

/**
 * 内置幻想乡角色名替换池（≥40 个，全局唯一）。
 *
 * 池内名称只作为假名来源，不参与反向替换；用尽后由 `maskName` 追加序号扩展。
 */
export const FANTASY_NAME_POOL: readonly string[] = Object.freeze([
  '博丽灵梦',
  '雾雨魔理沙',
  '十六夜咲夜',
  '蕾米莉亚',
  '芙兰朵露',
  '帕秋莉',
  '小恶魔',
  '红美铃',
  '琪露诺',
  '大妖精',
  '露米娅',
  '魂魄妖梦',
  '西行寺幽幽子',
  '八云紫',
  '八云蓝',
  '橙',
  '爱丽丝',
  '蓬莱山辉夜',
  '藤原妹红',
  '因幡帝',
  '铃仙',
  '八意永琳',
  '上白泽慧音',
  '米斯蒂娅',
  '莉格露',
  '射命丸文',
  '犬走椛',
  '东风谷早苗',
  '八坂神奈子',
  '洩矢诹访子',
  '比那名居天子',
  '永江衣玖',
  '伊吹萃香',
  '星熊勇仪',
  '四季映姬',
  '小野塚小町',
  '风见幽香',
  '古明地觉',
  '古明地恋',
  '火焰猫燐',
  '灵乌路空',
  '娜兹玲',
  '云居一轮',
  '村纱水蜜',
  '寅丸星',
  '圣白莲',
  '封兽鵺',
  '姬海棠果',
  '秦心',
  '鬼人正邪',
  '少名针妙丸',
  '本居小铃',
  '稗田阿求',
  '奥野田美宵',
  '摩多罗隐岐奈',
  '高丽野阿吽',
  '稀神探女',
  '克劳恩皮丝',
  '纯狐',
  '赫卡提亚',
  '坂田合欢',
  '矢田寺成美',
]);

/** 脱敏器：名称映射与正文替换共用同一份内部状态。 */
export interface Masker {
  /** 真实名 → 假名；同一 masker 内稳定，空串 / 纯空白原样返回。 */
  maskName(real: string): string;
  /**
   * 正文脱敏：`@提及` → 假名、双链内已登记人名 → 假名、已登记名的裸提 → 假名、
   * 独立 5~12 位数字 → 伪号；其余字符（含未登记的概念双链）原样保留。
   *
   * 裸名与双链的替换都只在**原文**上跑一遍：假名不会被后续规则再次改写。
   */
  maskText(text: string): string;
  /**
   * 预先登记整份材料里的真实号码。
   *
   * 逐字段脱敏时 `maskText` 只认得当前字符串，先处理的字段选出的伪号可能正好是
   * 后处理字段里的真实号码；调用方在逐字段处理**之前**把全部文本交进来即可避免撞车。
   */
  reserveRealNumbers(texts: readonly string[]): void;
  /**
   * 预先登记整份材料里的真实昵称（发言人 / 引证署名 / 支持与质疑者）。
   *
   * `maskText` 只能认出 `@昵称` 形式的提及；正文里裸写的昵称（如标题「张三的观察」）
   * 必须靠调用方先把结构化字段里的名字登记进来，再由 `maskText` 按最长优先整词替换。
   */
  reserveRealNames(names: readonly string[]): void;
}

/**
 * 视图可能附带、但 `PublicWikiView` 契约里尚未声明的身份字段。
 *
 * 富视图（或未来契约）会带 `participants` / `debateMatrix`；这里按可选字段处理，
 * 出现即脱敏、缺席即跳过，不改动 `PublicWikiView` 本身。
 */
interface ViewIdentityExtras {
  participants?: string[];
  debateMatrix?: PublicDebatePoint[];
  openQuestions?: string[];
}

/** FNV-1a 32 位哈希：同一输入恒定，用于稳定取模。 */
function hash32(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** 纯空白（含空串）不参与映射，避免把空发言人变成角色名。 */
const BLANK_NAME = /^\s*$/u;
/** 独立数字：前后都不是数字，长度 5~12（QQ 号 5~11 位、群号 6~10 位均在射程内）。 */
const STANDALONE_NUMBER = String.raw`(?<!\d)(\d{5,12})(?!\d)`;
/** 独立数字的全局替换式（`replace` 跑完自动归零 `lastIndex`，可复用同一份）。 */
const STANDALONE_NUMBER_ALL = new RegExp(STANDALONE_NUMBER, 'gu');
/** llmwiki 双链：`[[昵称]]` 是人名，`[[概念]]` 是词条内引用。 */
const WIKI_LINK = /\[\[([^\[\]\n]{1,64})\]\]/gu;
/** 假名边界：后接字母 / 数字 / 下划线视为「更长的名字」，交给未知提及分支整体处理。 */
const NAME_CHAR = /[\p{L}\p{N}_]/u;
/** 邮箱 / 标识符里的 `@` 不是提及。 */
const IDENTIFIER_CHAR = /[\p{L}\p{N}_.%+-]/u;
/** 未知提及的令牌切分（遇到空白、`@`、中英文标点即止）。 */
const MENTION_TOKEN = /^[^\s@，。、；：！？…·（）()\[\]【】「」『』《》<>"“”'‘’]+/u;
/** 令牌尾部的句读符号：属于文本，不属于昵称。 */
const MENTION_TAIL = /[.．。]+$/u;
/** 昵称尾部的附着信息：`VMNXD 1606987772` / `空庭流萤（B服天蓝色的海#9937）` 的底名要归一。 */
const NAME_PARENS = /（[^）]*）|\([^)]*\)/gu;
const NAME_SUFFIX = /[\s_#-]*\d+$/u;
/** 伪号空间：`10` + 6 位十进制。 */
const PSEUDO_SPACE = 1_000_000;
/**
 * 纯 ASCII 昵称（`7` / `Vader` / `fufuu`）按词边界命中；中文名走整串替换。
 * 判据只看字符集，不看长度——`1527` 里的 `7` 与 `Vaderx` 里的 `Vader` 都靠边界挡住。
 */
const ASCII_NAME = /^[A-Za-z0-9_]{1,32}$/u;

/** 单字符且非 ASCII 的名字（`夜` / `明`）：正文裸提必须靠上下文才能判定。 */
const SINGLE_CHAR_CJK = /^[^\x00-\x7f]$/u;

/**
 * 单字名的线索字符集。**左右必须镜像补齐**——线索集只补一侧时，
 * 「句号后点名」（`他走了。夜说这不合理。`）与「句尾点名」（`晚安，夜`）
 * 就是整类漏判：判据本是「名字两侧都是文本边界」，而不是「恰好只有某几种标点算边界」。
 */
const NAME_CUE_CHARS = "\\s「」『』“”\"'‘’（）()【】\\[\\]、,，:：;；。.!！?？…·\\-—";

/** 左线索：串首 / 空白 / 标点 / 引号括号 / 连词。 */
const NAME_LEFT_CUE = `(?<=^|[${NAME_CUE_CHARS}]|[与和跟同])`;

/** 右线索：说话动词 / 连词 / 标点 / 句尾 EOS（句末点名的最后一个字也要算提及）。 */
const NAME_RIGHT_CUE =
  `(?=[${NAME_CUE_CHARS}]|$|说|称|表示|认为|指出|补充|反驳|质疑|问|答|道|讲|吐槽|提议|强调|调侃|附和|与|和|跟|同)`;

/**
 * 正则元字符转义。保留而非删除：裸名交替正则的「多字中文」分支直接拼原文，
 * 而昵称可以是 `念。` / `千聆(小号)` 这种带标点的形态——放宽字符集时这里是唯一防线。
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 归一昵称：`VMNXD 1606987772` → `VMNXD`、`空庭流萤（B服…#9937）` → `空庭流萤`。
 * 复合昵称与它的裸写形态共享同一个假名；剥完不足 2 字符时退回原名（不吞单字昵称）。
 */
export function canonicalNameKey(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(NAME_PARENS, '').replace(NAME_SUFFIX, '').trim();
  return stripped.length >= 2 ? stripped : trimmed;
}

function pad6(value: number): string {
  return String(value).padStart(6, '0');
}

/**
 * 创建脱敏器。
 *
 * @param seed 洗牌种子；同 seed 得到同一映射，不同 seed 得到不同假名（默认空串）
 */
export function createMasker(seed = ''): Masker {
  const nameSalt = `${seed}\u0000name\u0000`;
  const numberSalt = `${seed}\u0000number\u0000`;
  /** 归一键 → 假名：`VMNXD 1606987772` 与 `VMNXD` 落同一条，共享一个假名。 */
  const byRealName = new Map<string, string>();
  const takenNames = new Set<string>();
  const byRealNumber = new Map<string, string>();
  const takenNumbers = new Set<string>();
  /** 已知真实号码：伪号不得与之重合（同段正文先全量登记，再做替换）。 */
  const realNumbers = new Set<string>();

  const maskName = (real: string): string => {
    if (BLANK_NAME.test(real)) return real;
    const key = canonicalNameKey(real);
    const cached = byRealName.get(key) ?? byRealName.get(real);
    if (cached !== undefined) return cached;

    const size = FANTASY_NAME_POOL.length;
    const start = hash32(nameSalt + key) % size;
    for (let step = 0; step < size; step += 1) {
      const candidate = FANTASY_NAME_POOL[(start + step) % size];
      if (takenNames.has(candidate)) continue;
      byRealName.set(key, candidate);
      byRealName.set(real, candidate);
      takenNames.add(candidate);
      return candidate;
    }
    // 真实名多于角色池：追加序号扩展，仍然确定性且不与已用假名重复。
    const expanded = `${FANTASY_NAME_POOL[start]}·${byRealName.size + 1}`;
    byRealName.set(key, expanded);
    byRealName.set(real, expanded);
    takenNames.add(expanded);
    return expanded;
  };

  const maskNumber = (real: string): string => {
    const cached = byRealNumber.get(real);
    if (cached !== undefined) return cached;

    const start = hash32(numberSalt + real) % PSEUDO_SPACE;
    for (let step = 0; step < PSEUDO_SPACE; step += 1) {
      const candidate = `10${pad6((start + step) % PSEUDO_SPACE)}`;
      if (candidate === real || realNumbers.has(candidate) || takenNumbers.has(candidate)) continue;
      byRealNumber.set(real, candidate);
      takenNumbers.add(candidate);
      return candidate;
    }
    // 伪号空间被上百万个真实号码占满：追加序号继续扩展，仍然确定性。
    let extended = `10${pad6(start)}`;
    let suffix = 0;
    while (extended === real || realNumbers.has(extended) || takenNumbers.has(extended)) {
      suffix += 1;
      extended = `10${pad6(start)}${suffix}`;
    }
    byRealNumber.set(real, extended);
    takenNumbers.add(extended);
    return extended;
  };

  /** 已知昵称按长度降序，保证 `@十六夜咲夜` 优先于 `@十六夜` 命中。 */
  const knownNames = (): string[] => Array.from(byRealName.keys()).sort((left, right) => right.length - left.length);

  const replaceMentions = (text: string): string => {
    let output = '';
    let cursor = 0;
    while (cursor < text.length) {
      const at = text.indexOf('@', cursor);
      if (at < 0) {
        output += text.slice(cursor);
        break;
      }
      output += text.slice(cursor, at);
      const previous = at > 0 ? text.charAt(at - 1) : '';
      if (previous !== '' && IDENTIFIER_CHAR.test(previous)) {
        output += '@';
        cursor = at + 1;
        continue;
      }

      const rest = text.slice(at + 1);
      const known = knownNames().find((name) => rest.startsWith(name) && !NAME_CHAR.test(rest.charAt(name.length)));
      if (known !== undefined) {
        output += `@${maskName(known)}`;
        cursor = at + 1 + known.length;
        continue;
      }

      const token = MENTION_TOKEN.exec(rest);
      if (token === null) {
        output += '@';
        cursor = at + 1;
        continue;
      }
      const tail = MENTION_TAIL.exec(token[0])?.[0] ?? '';
      const nickname = token[0].slice(0, token[0].length - tail.length);
      if (nickname === '') {
        output += '@';
        cursor = at + 1;
        continue;
      }
      output += `@${maskName(nickname)}${tail}`;
      cursor = at + 1 + token[0].length;
    }
    return output;
  };

  const reserveRealNumbers = (texts: readonly string[]): void => {
    for (const text of texts) {
      for (const match of text.matchAll(new RegExp(STANDALONE_NUMBER, 'gu'))) realNumbers.add(match[1]);
    }
  };

  /** 已登记的真实昵称，按长度降序（整词替换时必须长者优先）。 */
  const reservedNames = new Set<string>();
  /** 裸名交替正则的缓存：名单只增不减，一旦增长就置空重建。 */
  let bareNamePattern: RegExp | undefined;
  const reserveRealNames = (names: readonly string[]): void => {
    for (const name of names) {
      const trimmed = name.trim();
      if (BLANK_NAME.test(trimmed)) continue;
      // 单字符中文名（如「夜」）照登记：结构化字段（participants / 金句署名 / 支持质疑方）
      // 走 `maskName` 直接换，与长度无关；只有**正文裸提**需要上下文判定（见 replaceReservedNames）。
      reservedNames.add(trimmed);
      // 复合昵称的底名也要能命中：`VMNXD 1606987772` 在正文常被裸写成 `VMNXD`。
      const base = canonicalNameKey(trimmed);
      if (base !== trimmed && base !== '') reservedNames.add(base);
    }
    // 名单变了，旧的交替正则缺分支（同一 masker 复用脱敏多篇视图时会漏名）。
    bareNamePattern = undefined;
  };
  const orderedReserved = (): string[] => Array.from(reservedNames).sort((left, right) => right.length - left.length);

  /**
   * 双链里的名字：`[[昵称]]` 是**结构信号**，不是文本猜测。
   *
   * 正文要求把人名写成 llmwiki 双链（见 `prompts.ts` 的 narrative 约定），于是脱敏退化成
   * 字典查表：任意长度、单字也不再需要上下文判定，`深夜` 这种同形词天然不可能被误伤。
   * 双链内未登记的名字（概念链接如 `[[数值膨胀]]`）原样保留。
   */
  const replaceLink = (whole: string, inner: string): string => {
    const name = inner.trim();
    if (name === '' || !reservedNames.has(name)) return whole;
    return `[[${maskName(name)}]]`;
  };

  /**
   * 裸名交替正则：所有保留名按长度降序拼成**一个**匹配式，一次 `replace` 完成全部替换。
   *
   * 为什么必须一次扫描：逐名 `split/join` 时，先处理的 `张三 → 魂魄妖梦` 把假名写回了文本，
   * 后处理的保留名 `妖梦` 于是命中这个假名，产出「魂魄铃仙」——一个不存在的角色名。
   * 单个正则的 `replace` 只在**原文**上从左往右推进（`lastIndex` 只增不减），
   * 替换结果永远不会回流给下一次匹配，别名也就没有「二次替换」的可能。
   *
   * 三种形态各带自己的条件（长度降序保证长者优先）：
   *   - 纯 ASCII 名（`7` / `Vader` / `VMNXD`）：左右 ASCII 词边界，`1527` 里的 `7` 不动；
   *   - 单字中文名（`夜` / `明`）：左右线索同时成立才算指名提及（见 NAME_LEFT_CUE）；
   *   - 多字中文名：整串命中——中文没有词分隔符，`与千聆进一步` 这种紧贴汉字才是常态。
   */
  const bareNameMatcher = (): RegExp | undefined => {
    if (bareNamePattern !== undefined) return bareNamePattern;
    const ordered = orderedReserved();
    if (ordered.length === 0) return undefined;
    const branches = ordered.map((name) => {
      const escaped = escapeRegExp(name);
      if (SINGLE_CHAR_CJK.test(name)) return `${NAME_LEFT_CUE}${escaped}${NAME_RIGHT_CUE}`;
      if (ASCII_NAME.test(name)) return `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`;
      return escaped;
    });
    bareNamePattern = new RegExp(branches.join('|'), 'gu');
    return bareNamePattern;
  };

  /** 裸昵称替换：`@` 提及已在 `replaceMentions` 处理，这里只处理正文里直接出现的名字。 */
  const replaceReservedNames = (text: string): string => {
    const pattern = bareNameMatcher();
    if (pattern === undefined) return text;
    // 交替分支都带上「名字本身」的零宽断言，因此 `match` 就是命中的真名。
    return text.replace(pattern, (name) => maskName(name));
  };

  const maskText = (text: string): string => {
    if (text === '') return '';
    // 先登记本轮全部真实号码，保证伪号不会撞上同段正文里的另一个真实号。
    reserveRealNumbers([text]);
    // 双链切流：链内只做字典替换，链外才做 @ 提及与裸名兜底。
    // 整段一起跑裸名规则的话，`[[魂魄妖梦]]` 会被当成普通文本，链里被塞进第二个假名。
    // `split` 的捕获组只留下链内容（奇数位），括号在回填时补回。
    const output = text
      .split(WIKI_LINK)
      .map((part, index) =>
        index % 2 === 0 ? replaceReservedNames(replaceMentions(part)) : replaceLink(`[[${part}]]`, part),
      )
      .join('');
    return output.replace(STANDALONE_NUMBER_ALL, (digits) => maskNumber(digits));
  };

  return { maskName, maskText, reserveRealNumbers, reserveRealNames };
}

/** 观点矩阵单点脱敏（立场 / 支持者 / 质疑者 / 论据 / 反驳）。 */
function maskDebatePoint(point: PublicDebatePoint, masker: Masker): PublicDebatePoint {
  // 视图可能来自不同解析路径（Markdown 降级 / 结构化解），数组字段允许缺席：
  // 渲染侧必须容忍，绝不让一篇词条因为少一个可选栏目而整个出图失败。
  const { viewpoint, proponents, opponents, arguments: args, counterArguments } = point;
  return {
    viewpoint: masker.maskText(viewpoint),
    proponents: Array.isArray(proponents) ? proponents.map((name) => masker.maskName(name)) : [],
    opponents: Array.isArray(opponents) ? opponents.map((name) => masker.maskName(name)) : [],
    arguments: Array.isArray(args) ? args.map((item) => masker.maskText(item)) : [],
    counterArguments: Array.isArray(counterArguments) ? counterArguments.map((item) => masker.maskText(item)) : [],
  };
}

function maskTimelineItem(item: PublicTimelineItem, masker: Masker): PublicTimelineItem {
  const next: PublicTimelineItem = {
    entryId: item.entryId,
    date: item.date,
    title: masker.maskText(item.title),
    summary: masker.maskText(item.summary),
  };
  if (item.contribution !== undefined) next.contribution = masker.maskText(item.contribution);
  return next;
}

/** 递归收集任意视图片段里的全部字符串（含数组 / 嵌套对象里的字段）。 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
}

/**
 * 脱敏整份公开视图。
 *
 * 处理范围：`participants` / `openQuestions`（若存在）、`quotes[].speaker`、`debate` /
 * `debateMatrix` 的支持者与质疑者，以及全部字符串字段里的 `@提及` 与号码。
 * 返回新对象，入参保持不变。
 *
 * 伪号分配做**两遍**：先扫全视图登记所有真实号码，再逐字段脱敏。否则先处理的引文
 * 选出的伪号可能正好是后处理字段里真实出现的号码，视图里就留下了一个真实号码。
 *
 * @param masker 复用同一映射时传入；缺省时按默认 seed 新建
 * @param extraNames 视图之外的真名清单——`PublicWikiView` 契约不携带 `participants`，
 *   只被正文裸提（不进金句 / 观点矩阵）的群友只能靠调用方把 `record.participants`
 *   喂进来，否则他们的名字会原样留在综述 / 正文里。
 */
export function maskPublicView(
  view: PublicWikiView,
  masker?: Masker,
  extraNames?: readonly string[],
): PublicWikiView {
  const active = masker ?? createMasker();
  const source = view as PublicWikiView & ViewIdentityExtras;

  // 第一遍：整份视图的真实号码先入库，逐字段脱敏时伪号不会落在其中。
  const texts: string[] = [];
  collectStrings(source, texts);
  active.reserveRealNumbers(texts);

  // 第二遍：结构化字段里的真实昵称先入库——正文 / 标题里**裸写**的同名要靠这一份名单
  // 做整词替换（`maskText` 只认得 `@昵称`）。顺序无关，替换时按长度降序。
  const names: string[] = [];
  if (Array.isArray(source.participants)) names.push(...source.participants);
  if (extraNames !== undefined) names.push(...extraNames);
  for (const quote of source.quotes) names.push(quote.speaker);
  for (const point of source.debate ?? []) {
    names.push(...(point.proponents ?? []), ...(point.opponents ?? []));
  }
  for (const point of source.debateMatrix ?? []) {
    names.push(...(point.proponents ?? []), ...(point.opponents ?? []));
  }
  active.reserveRealNames(names);

  const quotes: PublicQuote[] = source.quotes.map((quote) => ({
    speaker: active.maskName(quote.speaker),
    text: active.maskText(quote.text),
  }));

  const next: PublicWikiView & ViewIdentityExtras = {
    id: source.id,
    title: active.maskText(source.title),
    date: source.date,
    status: source.status,
    tags: source.tags.map((tag) => active.maskText(tag)),
    summary: active.maskText(source.summary),
    background: active.maskText(source.background),
    consensus: source.consensus.map((item) => active.maskText(item)),
    divergence: source.divergence.map((item) => active.maskText(item)),
    quotes,
    // 来源路径也要过脱敏：`maskText` 只替换已登记的真实号码，字母与普通数字原样保留。
    sources: source.sources.map((item) => active.maskText(item)),
  };

  if (source.kind !== undefined) next.kind = source.kind;
  if (typeof source.narrative === 'string') next.narrative = active.maskText(source.narrative);
  if (source.timeline !== undefined) next.timeline = source.timeline.map((item) => maskTimelineItem(item, active));
  if (source.glossary !== undefined) {
    next.glossary = source.glossary.map((item) => ({
      term: active.maskText(item.term),
      note: active.maskText(item.note),
    }));
  }
  if (source.debate !== undefined) next.debate = source.debate.map((point) => maskDebatePoint(point, active));
  if (Array.isArray(source.participants)) {
    next.participants = source.participants.map((name) => active.maskName(name));
  }
  if (Array.isArray(source.debateMatrix)) {
    next.debateMatrix = source.debateMatrix.map((point) => maskDebatePoint(point, active));
  }
  if (Array.isArray(source.openQuestions)) {
    next.openQuestions = source.openQuestions.map((item) => active.maskText(item));
  }
  return next;
}
