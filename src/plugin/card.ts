/**
 * Patchouli Knowledge - 词条卡片
 *
 * 三种产物共用一份外观：`renderEntryLongImageHtml` 给出自包含长图 HTML（无脚本、无外链），
 * `renderEntryLongImagePng` / `renderEntryLongImageJpeg` 交给宿主 puppeteer 服务截图发群；
 * `renderWeeklyAlbumSummaryHtml` / `renderWeeklyAlbumSummaryPng` 渲染每周相册总结单页。
 *
 * 铁律：
 *  - 卡片只承载 `PublicWikiView`（已脱敏），文本一律 `escapeHtml`；
 *  - 超长正文由 CSS 裁剪（行数 / 高度上限），绝不依赖脚本；
 *  - puppeteer 服务缺失、页面创建失败或截图失败时返回 `null`，**绝不抛**。
 */

import { escapeHtml, type PublicDebatePoint, type PublicWikiView } from '../wiki/public-view';
import { createMasker, maskPublicView, type Masker } from '../wiki/mask';
import { MASCOT_BUST, MASCOT_READING } from './mascot-assets';

/** 单次出图的墙钟上限（setContent / evaluate / screenshot 各自生效）。 */
const RENDER_TIMEOUT_MS = 15_000;
const DEFAULT_CARD_WIDTH = 720;
const MIN_CARD_WIDTH = 320;
const MAX_CARD_WIDTH = 1600;
const DEFAULT_MAX_HEIGHT = 3000;
const MIN_MAX_HEIGHT = 320;
const MAX_MAX_HEIGHT = 20_000;
const CARD_CONSENSUS_LIMIT = 3;
/**
 * 页内取色脚本：读 `.backdrop-img`（已内嵌为 data: URI，无跨域问题），
 * 在 64×64 画布里做「色度 × 亮度 × 透明度」加权的色相直方图，
 * 把主峰写进 `body.style --pk-accent-h`。失败（无图 / 解码失败）静默返回。
 */
const BACKDROP_ACCENT_SNIPPET = `(() => {
  const img = document.querySelector('.backdrop-img');
  if (!img || !img.naturalWidth) return '';
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return '';
  g.drawImage(img, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data;
  const bins = new Float64Array(360);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, gr = d[i + 1] / 255, b = d[i + 2] / 255, a = (d[i + 3] ?? 255) / 255;
    const mx = Math.max(r, gr, b), mn = Math.min(r, gr, b), dl = mx - mn;
    const lum = (0.2126 * r + 0.7152 * gr + 0.0722 * b) * a;
    if (dl < 0.05) continue;
    let h = 0;
    if (mx === r) h = ((gr - b) / dl) % 6;
    else if (mx === gr) h = (b - r) / dl + 2;
    else h = (r - gr) / dl + 4;
    h = ((h * 60) + 360) % 360;
    bins[Math.floor(h)] += dl * lum * a;
  }
  let best = 0;
  for (let h = 1; h < 360; h += 1) if (bins[h] > bins[best]) best = h;
  if (bins[best] <= 0) return '';
  document.body.style.setProperty('--pk-accent-h', String(best));
  return String(best);
})()`;

const CARD_TAG_LIMIT = 6;
const DEFAULT_LONG_IMAGE_QUALITY = 90;
const DEFAULT_LONG_IMAGE_MAX_HEIGHT = 20_000;
const MAX_LONG_IMAGE_MAX_HEIGHT = 40_000;

const STATUS_LABELS: Record<string, string> = {
  verified: '已确证',
  tentative: '待考',
  open: '存疑',
};

interface ScreenshotOptions {
  type?: 'jpeg' | 'png';
  quality?: number;
  fullPage?: boolean;
  captureBeyondViewport?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
}

/** 页面句柄的公共子集（puppeteer `Page` 结构兼容）。 */
interface PageHandle {
  setViewport?: (options: { width: number; height?: number; deviceScaleFactor?: number }) => unknown;
  setContent?: (html: string, options?: { waitUntil?: string; timeout?: number }) => unknown;
  evaluate?: (fnOrExpr: (() => unknown) | string) => unknown;
  screenshot?: (options: ScreenshotOptions) => unknown;
  close?: () => unknown;
}

/** `ctx.puppeteer` 的最小面。 */
interface PuppeteerHandle {
  page: () => unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 从宿主上下文读取 puppeteer 服务；缺失或形状不符返回 `undefined`。 */
function getPuppeteer(ctx: unknown): PuppeteerHandle | undefined {
  if (typeof asRecord(ctx)?.puppeteer !== 'object') return undefined;
  // 外部服务实例无法在此逐字段建模；`page` 在下方用 typeof 校验。
  const service = asRecord(ctx)?.puppeteer as PuppeteerHandle | undefined;
  if (service === undefined || typeof service.page !== 'function') return undefined;
  return { page: () => service.page.call(service) };
}

/**
 * 宿主是否具备出图能力。
 *
 * 供出图管线在**领卡号、取素材之前**判断：没有 renderer 时直接返回 `no-puppeteer`，
 * 不让一次注定失败的渲染消耗序号与素材（序号是词条的稳定编号，不该被空耗）。
 */
export function hasRenderService(ctx: unknown): boolean {
  return getPuppeteer(ctx) !== undefined;
}

/** 已确认具备截图能力的页面句柄。 */
type ReadyPage = PageHandle & {
  setContent: (html: string, options?: { waitUntil?: string; timeout?: number }) => unknown;
  screenshot: (options: ScreenshotOptions) => unknown;
};

function toPage(value: unknown): ReadyPage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  // 外部页面句柄：断言为公共子集后在调用点逐一做可选调用，缺方法即跳过。
  const page = value as ReadyPage;
  return typeof page.setContent === 'function' && typeof page.screenshot === 'function' ? page : undefined;
}

function toBuffer(shot: unknown): Buffer | undefined {
  if (Buffer.isBuffer(shot)) return shot;
  if (shot instanceof Uint8Array) return Buffer.from(shot);
  if (typeof shot === 'string') return Buffer.from(shot, 'base64');
  return undefined;
}

function statusLabel(status: string): string {
  const key = status.trim().toLowerCase();
  return STATUS_LABELS[key] ?? status;
}

/** 每周相册总结：一页列出本周主题，不逐条复刻正文。 */
export function renderWeeklyAlbumSummaryHtml(
  views: readonly PublicWikiView[],
  options: { width?: number; weekLabel?: string } = {},
): string {
  const width = clampInt(options.width, DEFAULT_CARD_WIDTH, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
  const week = options.weekLabel ?? '';
  const items = views
    .slice(0, 8)
    .map(
      (view) =>
        `<li><time>${escapeHtml(view.date)}</time><div><h2>${escapeHtml(view.title)}</h2><p>${escapeHtml(view.summary)}</p></div></li>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>不动的大图书馆 · 每周相册</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f4f6f2;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans SC","PingFang SC",sans-serif;color:#101a17}
.card{width:${width}px;background:#fbfdfa;border:1px solid #dfe6de;border-radius:3px;padding:26px 28px 20px}
.crumb{color:#5c6b64;font-size:9px;letter-spacing:.22em;text-transform:uppercase;margin-bottom:8px}
h1{font-size:22px;line-height:1.3;margin-bottom:4px}
.week{font-family:ui-monospace,monospace;font-size:10px;color:#7c3aed;margin-bottom:16px}
ul{list-style:none;border-top:1px solid #dfe6de}
li{display:grid;grid-template-columns:76px 1fr;gap:12px;padding:11px 0;border-bottom:1px solid #dfe6de}
time{font-family:ui-monospace,monospace;font-size:9px;color:#6b7870;padding-top:2px}
h2{font-size:13px;line-height:1.45;margin-bottom:3px}
li p{font-size:10.5px;line-height:1.55;color:#5c6b64;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.footer{border-top:1px solid #dfe6de;margin-top:4px;padding-top:10px;color:#5c6b64;font-size:9px;letter-spacing:.18em}
</style>
</head>
<body>
<div class="card">
<p class="crumb">不动的大图书馆</p>
<h1>每周知识相册</h1>
<p class="week">${escapeHtml(week)} · 本周 ${views.length} 个主题</p>
<ul>${items}</ul>
<p class="footer">不动的大图书馆</p>
</div>
</body>
</html>`;
}

/** 页面高度（CSS px）；不支持 `evaluate` 或读取失败时返回 `undefined`。 */
async function measureHeight(page: PageHandle): Promise<number | undefined> {
  if (page.evaluate === undefined) return undefined;
  try {
    const value = await page.evaluate(() => {
      const scope = globalThis as { document?: { querySelector?: (selector: string) => { getBoundingClientRect?: () => { height?: number } } | null } };
      const card = scope.document?.querySelector?.('.card');
      return card?.getBoundingClientRect?.().height ?? 0;
    });
    const height = Number(value);
    return Number.isFinite(height) && height > 0 ? height : undefined;
  } catch {
    return undefined;
  }
}

/** 每周相册总结截图；宿主无 puppeteer 或截图失败时返回 null。 */
export async function renderWeeklyAlbumSummaryPng(
  ctx: unknown,
  views: readonly PublicWikiView[],
  options: { width?: number; maxHeight?: number; weekLabel?: string } = {},
): Promise<Buffer | null> {
  const puppeteer = getPuppeteer(ctx);
  if (puppeteer === undefined) return null;
  const width = clampInt(options.width, DEFAULT_CARD_WIDTH, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
  const maxHeight = clampInt(options.maxHeight, DEFAULT_MAX_HEIGHT, MIN_MAX_HEIGHT, MAX_MAX_HEIGHT);
  let page: ReadyPage | undefined;
  try {
    page = toPage(await puppeteer.page());
    if (page === undefined) return null;
    await page.setViewport?.({ width, height: 900, deviceScaleFactor: 2 });
    await page.setContent(renderWeeklyAlbumSummaryHtml(views, { width, weekLabel: options.weekLabel }), { waitUntil: 'load' });
    const measured = await measureHeight(page);
    const height = Math.min(maxHeight, Math.max(1, Math.round(measured ?? 900)));
    const shot = await page.screenshot({
      type: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height },
      timeout: RENDER_TIMEOUT_MS,
    } as ScreenshotOptions);
    return toBuffer(shot) ?? null;
  } catch {
    return null;
  } finally {
    try {
      await page?.close?.();
    } catch {
      // 页面已关闭或宿主回收，忽略
    }
  }
}

/* ------------------------------------------------------------------ *
 * 长图（Phase 8）：整篇词条一图排完，出图前内置脱敏
 * ------------------------------------------------------------------ */

/**
 * 渲染整篇词条的长图 HTML（暗色学术基调，零脚本、零外链资源）。
 *
 * 分节用发丝线而非卡片堆叠：标题区 → 摘要 → 主题综述 → 共识 → 分歧 →
 * 观点碰撞矩阵 → 原句引证 → 页脚品牌与词条 id。
 *
 * @param options.width  CSS 宽度，默认 720
 * @param options.masked 默认 `true`：出图前先脱敏；`false` 仅供内部排障
 * @param options.masker 复用同一份昵称映射；缺省按默认 seed 新建
 */
export function renderEntryLongImageHtml(
  view: PublicWikiView,
  options: {
    width?: number;
    masked?: boolean;
    masker?: Masker;
    backdrop?: string;
    saying?: string;
    index?: number;
    /** 看板娘底图（默认开）：标题区半身像 + 页尾书架读书图，内联 SVG 位图。 */
    mascot?: boolean;
    /**
     * 额外的「已知人名」（已是假名形态）：正文里裸写的名字要包成 chip。
     * 视图契约不携带参与者，只被正文提到的群友靠这一份外部名单才能拿到特殊渲染。
     * 契约：必须与 `masked:false` 搭配，且假名须由脱敏该视图的**同一个 masker** 产生——
     * 否则 `masked:true`（默认）会用新 masker 重洗全部别名，knownNames 静默失配。
     */
    knownNames?: readonly string[];
  } = {},
): string {
  const width = clampInt(options.width, DEFAULT_CARD_WIDTH, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
  const source = options.masked === false ? view : maskPublicView(view, options.masker ?? createMasker());
  const backdropSrc = options.backdrop ?? '';
  const sayingText = (options.saying ?? '').trim();
  const sayingMarkup = sayingText === ''
    ? ''
    : `<footer class="foot"><span class="said">${escapeHtml(sayingText)}</span></footer>`;
  const backdropMarkup = backdropSrc === ''
    ? ''
    : `<div class="backdrop" aria-hidden="true"><img class="backdrop-img" src="${backdropSrc}" alt=""></div>` +
      `<div class="veil" aria-hidden="true"></div>`;
  // 看板娘：单个内联 SVG，同一张位图叠两层——外层是自身色彩的模糊外溢（halo），
  // 内层是锐利本体，套「径向 + 纵向」双遮罩。于是边缘是渐变过渡而不是一条切线；
  // `<use>` 复用同一 data URI，位图只出现一次。不做路径描摹，保留原画质感。
  const mascotLayer = (
    key: 'bust' | 'reading',
    href: string,
    w: number,
    h: number,
    focus: { cx: number; cy: number; r: number },
    tune: { blur: number; hem: number; coreMid: number; coreOuter: number; outerOp: number; haloOp: number },
  ): string =>
    `<svg class="mascot mascot-${key}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">` +
    `<defs>` +
    `<image id="art-${key}" href="${href}" width="${w}" height="${h}"/>` +
    `<filter id="blur-${key}" x="-40%" y="-40%" width="180%" height="180%">` +
    `<feGaussianBlur stdDeviation="${tune.blur}"/></filter>` +
    `<radialGradient id="halo-${key}" gradientUnits="userSpaceOnUse" cx="${focus.cx}" cy="${focus.cy}" r="${focus.r}">` +
    `<stop offset="0" stop-color="#fff" stop-opacity="${tune.haloOp}"/>` +
    `<stop offset=".5" stop-color="#fff" stop-opacity="${(tune.haloOp * 0.35).toFixed(3)}"/>` +
    `<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
    `<mask id="m-halo-${key}" maskUnits="userSpaceOnUse" x="${-w}" y="${-h}" width="${w * 3}" height="${h * 3}">` +
    `<rect x="${-w}" y="${-h}" width="${w * 3}" height="${h * 3}" fill="url(#halo-${key})"/></mask>` +
    `<radialGradient id="core-${key}" gradientUnits="userSpaceOnUse" cx="${focus.cx}" cy="${focus.cy}" r="${focus.r}">` +
    `<stop offset=".22" stop-color="#fff"/>` +
    `<stop offset="${tune.coreMid}" stop-color="#fff" stop-opacity=".72"/>` +
    `<stop offset="${tune.coreOuter}" stop-color="#fff" stop-opacity="${tune.outerOp}"/>` +
    `<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
    `<mask id="m-core-${key}" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="url(#core-${key})"/></mask>` +
    `<linearGradient id="hem-${key}" gradientUnits="userSpaceOnUse" x1="0" y1="${h}" x2="0" y2="${Math.round(h * tune.hem)}">` +
    `<stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
    `<stop offset=".2" stop-color="#fff" stop-opacity=".45"/>` +
    `<stop offset=".48" stop-color="#fff" stop-opacity="1"/></linearGradient>` +
    `<mask id="m-hem-${key}" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="url(#hem-${key})"/></mask>` +
    `</defs>` +
    `<use href="#art-${key}" filter="url(#blur-${key})" mask="url(#m-halo-${key})"/>` +
    `<g mask="url(#m-core-${key})"><g mask="url(#m-hem-${key})">` +
    `<use href="#art-${key}"/></g></g>` +
    `</svg>`;

  const mascotMarkup = options.mascot === false
    ? ''
    : `<div class="mascots" aria-hidden="true">` +
      mascotLayer('bust', MASCOT_BUST, 880, 876, { cx: 449, cy: 326, r: 420 },
        { blur: 30, hem: 0.43, coreMid: 0.58, coreOuter: 0.79, outerOp: 0.39, haloOp: 0.26 }) +
      mascotLayer('reading', MASCOT_READING, 620, 669, { cx: 76, cy: 452, r: 269 },
        { blur: 23, hem: 0.75, coreMid: 0.57, coreOuter: 0.83, outerOp: 0.29, haloOp: 0.26 }) +
      `</div>`;

  const names = collectKnownNames(source, options.knownNames);
  // 正文里的人名按约定写成 llmwiki 双链（`[[昵称]]`）：脱敏据此精确查表，
  // 渲染时把括号去掉，交给 chipify 统一包成 chip。
  const rich = (text: string): string =>
    chipify(escapeHtml(stripPersonLinks(text, names)), names);
  const paragraphs = (text: string): string =>
    text
      .split(/\n{2,}/u)
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .map((item) => `<p>${rich(item)}</p>`)
      .join('');

  const tags = source.tags
    .filter((tag) => tag.trim() !== '')
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join('');

  const narrative = typeof source.narrative === 'string' ? source.narrative.trim() : '';
  const bullets = (items: readonly string[], kind: 'keep' | 'split'): string =>
    items.length === 0
      ? ''
      : `<ul class="bullets ${kind}">${items.map((item) => `<li>${rich(item)}</li>`).join('')}</ul>`;

  const debates = (source.debate ?? [])
    .map((point) => {
      // 立场徽标：▲ 支持 / ▼ 质疑 的纯图标胶囊（规范对立对，QQ 压缩下实心
      // 色块不糊）。胶囊比人名 chip 圆角更硬（4px vs 7px），区分「状态」与「实体」。
      const STANCE_ICON: Record<'pro' | 'con', string> = {
        pro: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.2 9.2 8.8H.8Z"/></svg>',
        con: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8.8.8 1.2h8.4Z"/></svg>',
      };
      const side = (list: readonly string[] | undefined, tone: 'pro' | 'con'): string => {
        const items = (list ?? []).filter((name) => name.trim() !== '');
        if (items.length === 0) return '';
        return (
          `<div class="side"><span class="side-label ${tone}">${STANCE_ICON[tone]}</span>` +
          `<span class="side-names">${items.map((name) => chip(name)).join('')}</span></div>`
        );
      };
      const args = (point.arguments ?? []).filter((item) => item.trim() !== '');
      const counters = (point.counterArguments ?? []).filter((item) => item.trim() !== '');
      return (
        `<article class="view">` +
        `<h3>${rich(point.viewpoint)}</h3>` +
        side(point.proponents, 'pro') +
        side(point.opponents, 'con') +
        (args.length === 0
          ? ''
          : `<div class="arg-group"><span class="arg-label">论据</span><ul>${args.map((item) => `<li>${rich(item)}</li>`).join('')}</ul></div>`) +
        (counters.length === 0
          ? ''
          : `<div class="arg-group counter"><span class="arg-label">反驳</span><ul>${counters.map((item) => `<li>${rich(item)}</li>`).join('')}</ul></div>`) +
        `</article>`
      );
    })
    .join('');

  const quotes = source.quotes
    .filter((quote) => quote.text.trim() !== '')
    .map(
      (quote) =>
        `<figure class="quote"><blockquote>${rich(quote.text)}</blockquote>` +
        `<figcaption>${chip(quote.speaker)}</figcaption></figure>`,
    )
    .join('');

  const timeline = (source.timeline ?? [])
    .filter((item) => item.title.trim() !== '' || item.summary.trim() !== '')
    .map((item) => {
      const contribution = (item.contribution ?? '').trim();
      return (
        `<li class="tl-item"><span class="tl-date">${escapeHtml(item.date)}</span>` +
        `<p class="tl-title">${rich(item.title)}</p>` +
        (item.summary.trim() === '' ? '' : `<p class="tl-note">${rich(item.summary.trim())}</p>`) +
        (contribution === '' ? '' : `<p class="tl-note tl-contrib">${rich(contribution)}</p>`) +
        `</li>`
      );
    })
    .join('');

  const glossary = (source.glossary ?? [])
    .filter((item) => item.term.trim() !== '')
    .map(
      (item) =>
        `<div class="gl-row"><dt>${rich(item.term)}</dt><dd>${rich(item.note)}</dd></div>`,
    )
    .join('');

  let index = 0;
  const section = (title: string, body: string, className = ''): string => {
    if (body === '') return '';
    index += 1;
    const number = String(index).padStart(2, '0');
    return (
      `<section class="sec glass ${className}">` +
      `<header class="sec-head"><span class="sec-no">${number}</span><h2>${title}</h2><span class="sec-line"></span></header>` +
      `${body}</section>`
    );
  };

  const status = statusLabel(source.status);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(source.title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{background:#0b0e1c}
body{
  position:relative;color:#e9ecf4;
  --pk-accent-h:228;
  font-family:-apple-system,"SF Pro Display","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Noto Sans SC",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
  background:#0b0e1c;
}
/*
 * 底图：重模糊 + 压暗，只当色场用。
 * 具象人物一旦压在正文后面就会和文字抢注意力，所以 blur 到只剩色块；
 * scale 略放大以吃掉模糊在边缘产生的透明羽化。
 */
.backdrop{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.backdrop-img{
  position:absolute;inset:0;width:100%;height:100%;object-fit:cover;
  filter:blur(14px) saturate(1.5) brightness(.86);
  transform:scale(1.08);transform-origin:center;
}
/* 柔纱：整幅压一层深色，再向底部加深，保证任何底图下正文都有对比度。 */
.veil{
  position:absolute;inset:0;pointer-events:none;
  background:
    linear-gradient(180deg,rgba(8,11,20,.06) 0%,rgba(8,11,20,.16) 40%,rgba(8,11,20,.3) 100%),
    radial-gradient(1100px 420px at 50% -8%,hsl(var(--pk-accent-h) 80% 64% / .18),transparent 72%);
}
/* 柔纱之下的暗面：无底图时它就是整张卡的底色（色相跟随取色）。 */
.sheet{
  position:relative;width:${width}px;margin:0 auto;
  border-radius:26px;overflow:hidden;
  border:1px solid rgba(255,255,255,.1);
  background:
    radial-gradient(720px 520px at 12% -8%,hsl(var(--pk-accent-h) 58% 62% / .34),transparent 66%),
    radial-gradient(860px 640px at 92% 14%,hsl(calc(var(--pk-accent-h) + 40) 58% 60% / .26),transparent 68%),
    radial-gradient(760px 560px at 55% 96%,hsl(calc(var(--pk-accent-h) + 60) 58% 62% / .2),transparent 70%),
    #101623;
}
/* 分区压暗层：顶部薄（让刊头与标题后透出画面）、正文区厚（保证对比度）。 */
.tint{
  position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(180deg,
    rgba(9,13,24,.46) 0,
    rgba(9,13,24,.56) 190px,
    rgba(9,13,24,.8) 300px,
    rgba(9,13,24,.86) 100%);
}
.content{position:relative;padding:44px 48px 38px;z-index:1}
/* 看板娘：两层内联 SVG（内部 <image> 是 WebP data URI）。
   半身像压标题右侧、读书图沉页尾左侧；矩形边由径向遮罩收掉，不留硬边。
   位置/尺寸/渐隐参数由 docs/mascot-tuner.html 调定后固化。 */
.mascots{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
.mascot{position:absolute;display:block;height:auto}
.mascot image{display:block}
.mascot-bust{top:-44px;right:-96px;width:516px;opacity:.63}
.mascot-reading{bottom:-44px;left:-17px;width:562px;opacity:.56}
.masthead{display:flex;align-items:baseline;gap:12px;padding-bottom:20px;
  text-shadow:0 1px 2px rgba(4,6,14,.5)}
.masthead .mark{font-size:12px;font-weight:600;letter-spacing:.12em;color:rgba(236,240,248,.82)}
.masthead .folio{font-family:ui-monospace,"SF Mono","Cascadia Mono",monospace;font-size:9.5px;letter-spacing:.2em;
  color:rgba(233,236,244,.44);font-variant-numeric:tabular-nums}
.masthead .folio::before{content:"//";letter-spacing:0;margin-right:9px;color:hsl(var(--pk-accent-h) 62% 70% / .5)}
h1{max-width:57%;font-size:28px;line-height:1.42;font-weight:700;letter-spacing:.015em;color:#f4f6fc;
  text-wrap:balance;text-shadow:0 1px 2px rgba(4,6,14,.45)}
.byline{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:18px}
.state{font-size:11px;font-weight:600;letter-spacing:.04em;
  padding:4px 12px;border-radius:999px;
  color:hsl(var(--pk-accent-h) 45% 86% / .96);background:hsl(var(--pk-accent-h) 55% 62% / .15);
  border:1px solid hsl(var(--pk-accent-h) 55% 62% / .32);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
.date{font-family:ui-monospace,"SF Mono","Cascadia Mono",monospace;font-size:11px;letter-spacing:.08em;
  color:rgba(233,236,244,.5);font-variant-numeric:tabular-nums}
.tags{margin-top:12px;display:flex;flex-wrap:wrap;gap:7px}
.tag{font-size:11px;letter-spacing:.04em;padding:3px 11px;border-radius:999px;
  color:rgba(233,238,250,.72);background:rgba(255,255,255,.09);
  border:1px solid rgba(255,255,255,.14)}
/* 章节头：左侧竖强调条 + 大号等宽「馆藏分类号」+ 章节名 + 向右淡出的引导线。
   编号不再是小号点缀，而是版面上的一枚铅字（图书馆书标），字重与字号都比正文大，
   靠透明度压回背景，保证「看得见但不抢读」。 */
.sec{margin-top:34px}
.sec-head{position:relative;display:flex;align-items:flex-end;gap:13px;
  padding:0 0 12px 15px;margin-bottom:17px}
.sec-head::before{content:"";position:absolute;left:0;top:2px;bottom:13px;width:3px;border-radius:2px;
  background:linear-gradient(to bottom,hsl(var(--pk-accent-h) 78% 70% / .95),hsl(var(--pk-accent-h) 78% 70% / 0))}
.sec-no{font-family:ui-monospace,"SF Mono","Cascadia Mono",monospace;font-size:20px;font-weight:800;
  letter-spacing:0;line-height:.86;color:hsl(var(--pk-accent-h) 66% 76% / .58);font-variant-numeric:tabular-nums}
.sec h2{font-size:15.5px;font-weight:600;letter-spacing:.055em;line-height:1.2;color:rgba(240,243,252,.97)}
.sec-line{flex:1;height:1px;margin-bottom:5px;
  background:linear-gradient(to right,hsl(var(--pk-accent-h) 62% 72% / .42),hsl(var(--pk-accent-h) 62% 72% / 0))}
p{font-size:14.5px;line-height:2;color:rgba(240,243,250,.96);text-align:justify}
/* 中文排版：正文段落首行缩进两格；时间轴 / 术语 / 页脚这些带 class 的行不缩进。 */
.sec p:not([class]){text-indent:2em}
p+p{margin-top:12px}
.bullets{list-style:none;display:flex;flex-direction:column;gap:10px}
.bullets li{position:relative;padding-left:18px;font-size:14px;line-height:1.88;color:rgba(226,231,242,.92)}
.bullets li::before{content:"";position:absolute;left:2px;top:.62em;width:5px;height:5px;border-radius:50%;
  background:hsl(var(--pk-accent-h) 62% 66% / .85)}
.bullets.split li::before{background:rgba(255,140,122,.75)}
.view+.view{margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,.07)}
.view h3{font-size:16px;line-height:1.6;font-weight:700;color:#eef0f8}
/* 立场徽标：18px 纯图标胶囊，4px 硬圆角（比人名 chip 的 7px 更硬，区分「状态」与「实体」）。
   墨绿 ▲=支持，暗赤 ▼=质疑；语义色固定，不随 accent / nameHue 漂移。 */
.side{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px}
.side-label{display:inline-flex;align-items:center;justify-content:center;height:18px;padding:0 6px;
  border-radius:4px;white-space:nowrap}
.side-label svg{width:9px;height:9px;fill:currentColor;flex:none}
.side-label.pro{color:#7ee8b7;background:rgba(46,125,90,.22);border:1px solid rgba(126,232,183,.35)}
.side-label.con{color:#ff9b8e;background:rgba(180,60,50,.2);border:1px solid rgba(255,155,142,.32)}
.side-names{display:flex;flex-wrap:wrap;gap:4px 2px}
/* 论据/反驳：盒中盒拆为左侧 2px 竖向参考线（学术引言式，与「分节用发丝线」原则一致）；
   边线与小标签复用立场徽章的固定绿/红（#7ee8b7 / #ff9b8e 同系），不随
   --pk-accent-h 或 nameHue 变化——立场色是全卡唯一「不可漂移」的语义色。 */
.arg-group{margin-top:12px;padding:3px 0 3px 13px;border-left:2px solid rgba(126,232,183,.55)}
.arg-group.counter{border-left-color:rgba(255,155,142,.6)}
/* 论据/反驳小标签：11px/600 半粗，反驳侧偏红呼应左侧边线色。 */
.arg-label{display:block;font-size:11px;font-weight:600;letter-spacing:.06em;
  color:rgba(126,232,183,.9);margin-bottom:6px}
.arg-group.counter .arg-label{color:rgba(255,155,142,.9)}
.arg-group ul{list-style:none;display:flex;flex-direction:column;gap:6px}
.arg-group li{font-size:13.5px;line-height:1.8;color:rgba(235,239,249,.95)}
/* 时间轴：日期列与正文之间加一条竖向淡出轴线 + 每节点 5px 冷蓝光点，
   由「两列表格」变为「编年档案轴线」。 */
.tl{list-style:none;position:relative;padding-left:0}
.tl::before{content:"";position:absolute;left:97px;top:9px;bottom:10px;width:1px;
  background:linear-gradient(to bottom,rgba(255,255,255,.13),rgba(255,255,255,.13) 82%,rgba(255,255,255,0))}
.tl-item{position:relative;display:grid;grid-template-columns:88px 1fr;gap:0 20px;padding:13px 0;
  border-top:1px solid rgba(255,255,255,.06)}
.tl-item::after{content:"";position:absolute;left:95px;top:17px;width:5px;height:5px;border-radius:50%;
  background:hsl(var(--pk-accent-h) 70% 72% / .95);
  box-shadow:0 0 5px hsl(var(--pk-accent-h) 78% 68% / .55)}
.tl-item:first-child{border-top:0;padding-top:0}
.tl-item:first-child::after{top:4px}
.tl-date{grid-row:1 / span 3;font-family:ui-monospace,"SF Mono","Cascadia Mono",monospace;font-size:10px;
  letter-spacing:.06em;color:hsl(var(--pk-accent-h) 62% 72% / .92);padding-top:4px;font-variant-numeric:tabular-nums}
.tl-title{font-size:14px;line-height:1.7;font-weight:600;color:rgba(240,242,250,.95)}
.tl-note{margin-top:4px;font-size:12.5px;line-height:1.75;color:rgba(214,219,233,.6)}
.tl-contrib{color:rgba(214,219,233,.75)}
.gl{display:flex;flex-direction:column}
.gl-row{display:grid;grid-template-columns:120px 1fr;gap:18px;padding:12px 0;
  border-top:1px solid rgba(255,255,255,.06)}
.gl-row:first-child{border-top:0;padding-top:0}
.gl-row dt{font-size:13px;font-weight:600;color:hsl(var(--pk-accent-h) 62% 74% / .95)}
.gl-row dd{font-size:13px;line-height:1.8;color:rgba(214,219,233,.68)}
.quote{position:relative;padding:14px 16px;border-radius:14px;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
.quote+.quote{margin-top:14px}
.quote blockquote{font-size:14px;line-height:1.92;color:rgba(230,234,245,.95)}
.quote figcaption{margin-top:10px;display:flex;justify-content:flex-end}
.foot{display:flex;flex-direction:column;align-items:center;gap:7px;margin-top:42px;
  padding-top:16px;border-top:1px solid rgba(255,255,255,.09);
  font-family:ui-monospace,"SF Mono","Cascadia Mono",monospace;font-size:9px;letter-spacing:.28em;
  color:rgba(233,236,244,.4)}
.foot .said{font-size:11.5px;letter-spacing:.02em;line-height:1.9;text-align:center;
  color:rgba(226,232,244,.62);font-weight:400;max-width:30em}
/* 假名 chip：inline + 零 margin + 小内边距。inline-block 会被 justify
   当成不可分原子再摊一点间隙，margin 和 .38em 内边距叠加后两侧各约 7px，
   相当于半个中文字宽的「漏风」感。 */
.nm{
  display:inline;margin:0;padding:1px .3em;border-radius:7px;
  font-size:.9em;font-weight:600;line-height:1.55;white-space:nowrap;
  background:var(--nm-bg);color:var(--nm-fg);
  border:1px solid var(--nm-bd);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.1);
}
</style>
</head>
<body>
<main class="sheet">
${backdropMarkup}
<div class="tint" aria-hidden="true"></div>
${mascotMarkup}
<div class="content">
<div class="masthead">
  <span class="mark">#${options.index === undefined ? escapeHtml(source.id) : String(options.index)}</span>
  <span class="folio">PATCHOULI KNOWLEDGE</span>
</div>
<h1>${rich(source.title)}</h1>
<div class="byline"><span class="state">${escapeHtml(status)}</span><span class="date">${escapeHtml(source.date)}</span></div>
${tags === '' ? '' : `<div class="tags">${tags}</div>`}
${section('摘要', source.summary.trim() === '' ? '' : `<p>${rich(source.summary.trim())}</p>`)}
${section('主题综述', narrative === '' ? '' : paragraphs(narrative))}
${section('时间轴', timeline === '' ? '' : `<ul class="tl">${timeline}</ul>`)}
${section('共识', bullets(source.consensus, 'keep'))}
${section('分歧', bullets(source.divergence, 'split'))}
${section('观点碰撞', debates)}
${section('名词注', glossary === '' ? '' : `<dl class="gl">${glossary}</dl>`)}
${section('原句引证', quotes)}
${sayingMarkup}
</div>
</main>
</body>
</html>`;
}

/** FNV-1a 32 位散列：名字 → 稳定色相（同一名字在任何词条里同色）。 */
function nameHue(name: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 360;
}

/** 名字 chip：同名同色，色相散列后用固定饱和度/明度保证正文可读。 */
function chip(name: string): string {
  const hue = nameHue(name);
  const style =
    `--nm-bg:hsl(${hue} 40% 52% / .15);` +
    `--nm-bd:hsl(${hue} 50% 64% / .24);` +
    `--nm-fg:hsl(${hue} 45% 88%)`;
  return `<span class="nm" style="${style}">${escapeHtml(name)}</span>`;
}

/** 视图可能附带但契约未声明的人名字段（`maskPublicView` 同款做法）。 */
interface ViewNameExtras {
  participants?: string[];
}

/** 收集一篇视图里出现的全部人名（发言人 / 支持者 / 质疑者 / 引证署名）。 */
function collectKnownNames(view: PublicWikiView, extra: readonly string[] = []): string[] {
  const names = new Set<string>();
  for (const name of extra) names.add(name.trim());
  for (const name of (view as PublicWikiView & ViewNameExtras).participants ?? []) names.add(name.trim());
  for (const quote of view.quotes) names.add(quote.speaker.trim());
  for (const point of view.debate ?? []) {
    for (const name of point.proponents ?? []) names.add(name.trim());
    for (const name of point.opponents ?? []) names.add(name.trim());
  }
  return [...names].filter((name) => name.length >= 2).sort((left, right) => right.length - left.length);
}

/**
 * 只剥掉**人名**双链的括号（`[[昵称]]` → `昵称`）；概念双链 `[[数值膨胀]]` 原样保留。
 */
function stripPersonLinks(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  const known = new Set(names);
  return text.replace(/\[\[([^\[\]\n]{1,64})\]\]/gu, (whole, inner: string) => {
    const name = inner.trim();
    return known.has(name) ? name : whole;
  });
}

const REGEXP_ESCAPE = /[.*+?^${}()|[\]\\]/g;
/** chip 与英文单词相邻时用来「断开」的词字符判定（补发丝空格，不参与 justify 拉伸）。 */
const ASCII_WORD_CHAR = /[A-Za-z0-9_]/u;

/**
 * chip 化的切分点：标签 / HTML 实体 / 概念双链各算一个不可改写的 token。
 *
 * 为什么必须切：`chipify` 曾在整段 HTML 上做字符串替换，名单里出现 `nm` 就会改写
 * 自己刚生成的 `class="nm"` 与 `--nm-bg`，出现 `膨胀` 就会钻进 `[[数值膨胀]]` 的括号里。
 * 只在文本 token 上替换，标签 / 实体 / 概念链原样输出，chip 标记与类名保持不变。
 */
const CHIP_TOKEN = /(<[^>]*>|&[^;]{1,8};|\[\[[^\[\]\n]{1,64}\]\])/gu;

/**
 * 把正文里裸写的人名包成 chip（长者优先，避免短名先命中把长名切碎）。
 *
 * 输入是**已转义**的 HTML 片段：替换只发生在文本 token 上，绝不作用于属性或标签结构。
 * 已知代价：名字本身若含 `&` / `<` / `>`，转义后会被实体 token 切断而不再 chip 化——
 * 名单来自角色池与群昵称，实际不会出现这些字符；真要支持需先还原实体再匹配，收益为零。
 */
function chipify(html: string, names: readonly string[]): string {
  if (names.length === 0 || html === '') return html;
  // 名字按长度降序（collectKnownNames 已排序）；转义形态 → 原名，回填时不再反推。
  const byEscaped = new Map<string, string>();
  const alternatives: string[] = [];
  for (const name of names) {
    const escaped = escapeHtml(name);
    if (byEscaped.has(escaped)) continue;
    byEscaped.set(escaped, name);
    alternatives.push(escaped.replace(REGEXP_ESCAPE, '\\$&'));
  }
  if (alternatives.length === 0) return html;
  // 一次交替匹配完成全部名字：后一个名字不可能命中前一个名字生成的 chip 标记
  // （与 `mask.ts` 裸名替换同一个教训）。
  // LLM 原文常在人名两侧打字面空格（"A 与 B"）；chip 化时必须一并吃掉，
  // 否则 text-align:justify 会把这些空格拉伸成一个字宽的缺口。
  const pattern = new RegExp(`[ \\t]*(?:${alternatives.join('|')})[ \\t]*`, 'g');
  // split 带捕获组：奇数位是分隔 token，偶数位才是可改写的文本。
  return html
    .split(CHIP_TOKEN)
    .map((part, index) => {
      if (index % 2 === 1 || part === '') return part;
      return part.replace(pattern, (match, offset: number, whole: string) => {
        const name = byEscaped.get(match.trim());
        if (name === undefined) return match;
        const before = ASCII_WORD_CHAR.test(whole.charAt(offset - 1)) ? '&#8202;' : '';
        const after = ASCII_WORD_CHAR.test(whole.charAt(offset + match.length)) ? '&#8202;' : '';
        return `${before}${chip(name)}${after}`;
      });
    })
    .join('');
}

export interface LongImageOptions {
  width?: number;
  maxHeight?: number;
  masked?: boolean;
  masker?: Masker;
  /** JPEG 质量（仅 `renderEntryLongImageJpeg` 使用），默认 90。 */
  quality?: number;
  /** 底图（`data:` URI，由素材池取出）；空字符串表示无底图，退回纯色场。 */
  backdrop?: string;
  /** 页尾一言：替代品牌与词条 id 的收尾文案；空字符串则不渲染页脚。 */
  saying?: string;
  /** 页眉 `#编号`：与词条 id 无关的独立自然数；缺省时退回词条 id。 */
  index?: number;
  /** 额外已知人名（假名形态），供正文 chip 渲染；见 `renderEntryLongImageHtml`。 */
  knownNames?: readonly string[];
}

/**
 * 截长图（PNG / JPEG 共用一套几何逻辑）。
 *
 * 优先 `fullPage` 整页截；宿主不支持时按实测高度设视口 + `clip`；
 * 超过 `maxHeight` 时按上限裁剪。任何路径都关页，失败返回 `null`。
 */
async function captureLongImage(
  ctx: unknown,
  view: PublicWikiView,
  options: LongImageOptions,
  type: 'png' | 'jpeg',
): Promise<Buffer | null> {
  const puppeteer = getPuppeteer(ctx);
  if (puppeteer === undefined) return null;

  const width = clampInt(options.width, DEFAULT_CARD_WIDTH, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
  const maxHeight = clampInt(
    options.maxHeight,
    DEFAULT_LONG_IMAGE_MAX_HEIGHT,
    MIN_MAX_HEIGHT,
    MAX_LONG_IMAGE_MAX_HEIGHT,
  );
  const quality = clampInt(options.quality, DEFAULT_LONG_IMAGE_QUALITY, 40, 100);
  const backdrop = options.backdrop ?? '';
  const html = renderEntryLongImageHtml(view, {
    width,
    masked: options.masked,
    masker: options.masker,
    backdrop,
    saying: options.saying,
    index: options.index,
    knownNames: options.knownNames,
  });
  const encode = (): Partial<ScreenshotOptions> => (type === 'jpeg' ? { type, quality } : { type });

  let page: ReadyPage | undefined;
  try {
    page = toPage(await puppeteer.page());
    if (page === undefined) return null;

    // puppeteer-core 要求 height 必填；长图先给一个中性视口，整页截图不受它限制。
    await page.setViewport?.({ width, height: 900, deviceScaleFactor: 2 });
    // 墙钟上限：页面挂住时不能让一个 puppeteer page 永久驻留（并拖住整个出图队列）。
    await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    // 有底图时跑页内取色；失败静默退回默认冷蓝。
    if (backdrop !== '' && page.evaluate !== undefined) {
      try {
        await page.evaluate(BACKDROP_ACCENT_SNIPPET);
      } catch {
        // 取色失败不影响出图。
      }
    }

    const measured = Math.max(1, Math.round((await measureHeight(page)) ?? 900));
    if (measured <= maxHeight) {
      try {
        const whole = toBuffer(
          await page.screenshot({
            ...encode(),
            fullPage: true,
            captureBeyondViewport: true,
            timeout: RENDER_TIMEOUT_MS,
          } as ScreenshotOptions),
        );
        if (whole !== undefined) return whole;
      } catch {
        // 宿主不支持 `fullPage`：落到下面的视口 + clip 路径。
      }
    }

    const height = Math.min(maxHeight, measured);
    await page.setViewport?.({ width, height, deviceScaleFactor: 2 });
    const shot = await page.screenshot({
      ...encode(),
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height },
      timeout: RENDER_TIMEOUT_MS,
    } as ScreenshotOptions);
    return toBuffer(shot) ?? null;
  } catch {
    return null;
  } finally {
    try {
      await page?.close?.();
    } catch {
      // 页面已被宿主回收，忽略。
    }
  }
}

/** 长图 PNG；宿主无 puppeteer 或截图失败时返回 `null`。 */
export async function renderEntryLongImagePng(
  ctx: unknown,
  view: PublicWikiView,
  options: LongImageOptions = {},
): Promise<Buffer | null> {
  return captureLongImage(ctx, view, options, 'png');
}

/**
 * 长图 JPEG（默认 q90）。
 *
 * 为什么需要它：玻璃 + 环境光是一整片低对比渐变，PNG 在这种画面上几乎不压缩
 * （实测 1440×5130 达 2.8 MB），JPEG 同画质约 1/4 体积，适合发群。
 */
export async function renderEntryLongImageJpeg(
  ctx: unknown,
  view: PublicWikiView,
  options: LongImageOptions = {},
): Promise<Buffer | null> {
  return captureLongImage(ctx, view, options, 'jpeg');
}
