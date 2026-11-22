/**
 * Patchouli Knowledge - 内联数学去标记（LaTeX → 纯文本）
 *
 * 模型偶尔会把推导链写成 LaTeX（`敌方导弹无法锁定隐匿目标 $\rightarrow$ 攻击转移`）。
 * 词条 Markdown 的消费方——QQ 长图卡片、Web 展厅、外部 Agent——都是**纯文本渲染**，
 * 没有 KaTeX / MathJax，于是 `$\rightarrow$` 连同美元符原样落到图上。
 *
 * 职责边界：只在**显示与落盘文本**上做无损替换，不改变词条结构、不处理行内数学排版。
 * 规则：
 *  - 只处理成对的数学定界符（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`），成对美元之间的
 *    内容不含任何 LaTeX 记号（`\`、`^`、`_`、`{`、`}`）时原样保留——「价格 $5 到 $6」
 *    这类普通文本不会被吃掉美元符；
 *  - 已知命令按符号表替换（箭头 / 关系 / 运算符 / 希腊字母），未知命令去掉反斜杠保留词干，
 *    绝不吞内容；
 *  - 输出只依赖入参，天然幂等。
 */

/** LaTeX 命令 → Unicode 等价字符（键不含反斜杠）。 */
const SYMBOLS: Readonly<Record<string, string>> = {
  // 箭头与推导
  rightarrow: '→',
  longrightarrow: '→',
  to: '→',
  leftarrow: '←',
  longleftarrow: '←',
  gets: '←',
  leftrightarrow: '↔',
  Leftrightarrow: '⇔',
  iff: '⇔',
  Rightarrow: '⇒',
  implies: '⇒',
  Longrightarrow: '⇒',
  Leftarrow: '⇐',
  mapsto: '↦',
  uparrow: '↑',
  downarrow: '↓',
  nearrow: '↗',
  searrow: '↘',
  // 关系与比较
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  sim: '∼',
  simeq: '≃',
  equiv: '≡',
  propto: '∝',
  ll: '≪',
  gg: '≫',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  supset: '⊃',
  subseteq: '⊆',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  varnothing: '∅',
  forall: '∀',
  exists: '∃',
  // 运算与符号
  times: '×',
  cdot: '·',
  pm: '±',
  mp: '∓',
  div: '÷',
  ast: '∗',
  star: '⋆',
  bullet: '•',
  circ: '°',
  degree: '°',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  sum: '∑',
  prod: '∏',
  sqrt: '√',
  int: '∫',
  ldots: '…',
  dots: '…',
  cdots: '⋯',
  therefore: '∴',
  because: '∵',
  // 希腊字母
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

/** 命令名按长度降序，保证 `\rightarrow` 先于 `\to` 命中。 */
const SYMBOL_PATTERN = new RegExp(
  `\\\\(?:${Object.keys(SYMBOLS)
    .sort((a, b) => b.length - a.length)
    .join('|')})`,
  'gu',
);

/** 带字面内容的文本类命令：只保留花括号内的字。 */
const TEXT_COMMAND = /\\(?:text|textrm|textnormal|texttt|mathrm|mathbf|mathit|mathsf|mathtt|operatorname|mbox)\s*\{([^{}]*)\}/gu;

/** 数学环境声明（`\begin{cases}` / `\end{aligned}`）本身没有语义，直接丢弃。 */
const ENVIRONMENT = /\\(?:begin|end)\s*\{[^{}]*\}/gu;

/** 只含这些字符的 `$…$` 视为普通文本（价格、占位符），不做转换。 */
const MATH_SIGNAL = /[\\^_{}]/u;

/** 单段数学内容的转换：命令映射 + 结构剥离。 */
function convertMath(source: string): string {
  let text = source;
  text = text.replace(ENVIRONMENT, '');
  for (let guard = 0; guard < 8; guard += 1) {
    const next = text.replace(TEXT_COMMAND, '$1');
    if (next === text) break;
    text = next;
  }
  // 排版间距命令 → 空格；`\\` 换行 → 空格。
  text = text.replace(/\\(?:quad|qquad|,|;|:|!)/gu, ' ');
  text = text.replace(/\\\\/gu, ' ');
  text = text.replace(SYMBOL_PATTERN, (match) => SYMBOLS[match.slice(1)] ?? match);
  // 未知命令去反斜杠保留词干；转义标点（`\%` `\&` `\_`）只留标点。
  text = text.replace(/\\([A-Za-z]+)/gu, '$1');
  text = text.replace(/\\([^A-Za-z])/gu, '$1');
  // 分组花括号本身不是内容（`x^{2}` → `x^2`）。
  text = text.replace(/[{}]/gu, '');
  return text.replace(/\s+/gu, ' ').trim();
}

/** 单个定界符片段：无数学记号时按 `fallback`（默认原文）返回。 */
function renderSpan(body: string, fallback: string, always: boolean): string {
  if (!always && !MATH_SIGNAL.test(body)) return fallback;
  return convertMath(body);
}

/**
 * 把内联 LaTeX 数学压成纯文本。
 *
 * 非字符串入参原样返回；不含定界符时零成本短路。
 */
export function plainText(raw: string): string {
  if (typeof raw !== 'string' || raw === '') return raw;
  if (!raw.includes('$') && !raw.includes('\\(') && !raw.includes('\\[')) return raw;
  return raw
    .replace(/\\\[([\s\S]*?)\\\]/gu, (_match, body: string) => renderSpan(body, _match, true))
    .replace(/\\\(([\s\S]*?)\\\)/gu, (_match, body: string) => renderSpan(body, _match, true))
    .replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/gu, (_match, body: string) => renderSpan(body, _match, true))
    .replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/gu, (match, body: string) => renderSpan(body, match, false));
}
