/**
 * Patchouli Knowledge - 有机未来主义 (Organic Futurism) 标记与运行时
 *
 * 同一套运行时同时驱动：
 * - 独立页面 `/patchouli`（绝对定位 + 拖拽钳制）
 * - Console 内嵌组件（首次拖拽转为浮动层 + 拖拽钳制）
 *
 * 材质：瓷白 / 肤白 #f7f5f0 生物膜 + 葱绿 #0ea44f / 深海青 #0e8f86 / 琥珀孢子 #b8791e。
 * 交互契约：两个核心页签（词条 / 监控）就地切换 / 齿轮是平级的第三个页签（设置页，非浮层）/
 *           顶栏拖拽 + 边缘与四角 8 向缩放（几何钳制在视口内）/ 静置 5 秒弹性收回胶囊 /
 *           胶囊点击展开（用户控制权）/ rail 底部的日 / 月按钮切换明暗主题并记忆到
 *           localStorage `patchouli-theme`；宿主判为深色时直接以夜间渲染（优先级高于旧的
 *           浅色记忆，仅本会话手动切换可覆盖），MutationObserver 跟随宿主换肤 / 全部就地渲染，
 *           绝不跳转。
 * 红线：零 Emoji，100% 内联 SVG；零 window.open；零 iframe；DOM 一律文本节点安全
 *       （用户内容绝不经过 innerHTML 注入）；消息媒体仅放行 http(s) 直链，
 *       由浏览器自行加载，图片 / 视频 / 音频一律不自动播放。
 */

import {
  ORGANIC_ICONS,
  PATCHOULI_CHANNEL,
  PATCHOULI_CHANNELS,
  buildTrafficPath,
  organicIcon,
  organicIds,
  organicNucleus,
} from './organic';
import { trafficRuntime } from './traffic-runtime';

const TAB_SPECS: ReadonlyArray<{ key: string; label: string; tip: string; icon: string }> = [
  { key: 'entries', label: '词条', tip: '词条索引', icon: 'entries' },
  { key: 'topics', label: '主题', tip: '跨时间主题聚合', icon: 'topics' },
  { key: 'metrics', label: '监控', tip: '实时监控', icon: 'metrics' },
];

/**
 * 运行时补充图标（词条操作 / 明暗切换）：与 `organic.ts` 的 Lucide 规格严格同参
 * （24px 网格 / 2px 圆头描边 / currentColor），随控件语义色继承。
 */
const RUNTIME_ICONS: Record<string, string> = {
  pencil:
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">` +
    `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>` +
    `<path d="m15 5 4 4"/></g>`,
  trash:
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">` +
    `<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>` +
    `<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></g>`,
  sun:
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">` +
    `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/>` +
    `<path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/>` +
    `<path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></g>`,
  moon:
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">` +
    `<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></g>`,
  /* Lucide layers：主题页签——长期聚合视图，与词条页的列表图标明确区分 */
  topics:
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">` +
    `<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/>` +
    `<path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/>` +
    `<path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></g>`,
  /* Lucide chevron-down：organic.ts 的 chevron 是右向箭头，下拉开合需要向下的等价图标 */
  chevronDown:
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">` +
    `<path d="m6 9 6 6 6-6"/></g>`,
};

/** 运行时补充图标的 SVG 包装：与 `organicIcon` 同规格，仅多认本模块新增的日 / 月图标。 */
function runtimeIcon(name: string, size = 16): string {
  const body = RUNTIME_ICONS[name] ?? ORGANIC_ICONS[name] ?? ORGANIC_ICONS.nucleus;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

const RESIZE_DIRS: ReadonlyArray<string> = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];

/** 8 向缩放手柄：热区独立成层并完全内嵌在窗口内部（向内 8px / 四角 16×16），
    因此 .ptx-window 可以放心用 overflow: hidden 做唯一硬裁剪矩形。 */
function resizeLayer(): string {
  return (
    `<div class="ptx-resize-layer" aria-hidden="true">` +
    RESIZE_DIRS.map((dir) => `<span class="ptx-resize is-${dir}" data-resize="${dir}"></span>`).join('') +
    `</div>`
  );
}

export function organicMarkup(prefix: string): string {
  const ids = organicIds(prefix);

  const tabs = TAB_SPECS.map((tab, index) => {
    const active = index === 0 ? ' is-active' : '';
    return (
      `<button class="ptx-tab${active}" data-act="stage" data-stage="${tab.key}" data-tip="${tab.tip}" data-tip-pos="right" aria-label="${tab.label}">` +
      `${organicIcon(tab.icon, 17)}</button>`
    );
  }).join('');

  return `
  <div class="ptx-window" id="${ids.window}" role="region" aria-label="LLMWiki 知识阅读器" data-phase="LOADING">
    <div class="ptx-shell">
    <aside class="ptx-rail">
      <div class="ptx-rail-brand" data-tip="LLMWiki 知识阅读器" data-tip-pos="right">
        ${organicIcon('nucleus', 19)}
      </div>
      <nav class="ptx-keys">${tabs}</nav>
      <div class="ptx-rail-foot">
        <button class="ptx-tool ptx-theme" data-act="theme" data-tip="切换夜间主题" data-tip-pos="right" aria-label="切换夜间主题" aria-pressed="false"><span class="ptx-ico-sun">${runtimeIcon('sun', 15)}</span><span class="ptx-ico-moon">${runtimeIcon('moon', 15)}</span></button>
        <button class="ptx-tool ptx-gear" data-act="stage" data-stage="settings" data-tip="面板设置" data-tip-pos="right" aria-label="面板设置">${organicIcon('settings', 15)}</button>
      </div>
    </aside>

    <section class="ptx-body">
      <header class="ptx-topbar" id="${ids.dragHandle}" data-drag="1">
        <div class="ptx-id">
          <span class="ptx-id-glyph">${organicIcon('pulse', 14)}</span>
          <span class="ptx-id-code">LLMWIKI</span>
          <span class="ptx-id-sep"></span>
          <button type="button" class="ptx-phase" id="${ids.phase}" data-phase="LOADING" data-act="stage" data-stage="metrics" data-tip="正在连接服务" data-tip-pos="bottom"><i></i><span>正在连接</span></button>
        </div>
        <div class="ptx-tools">
          <div class="ptx-filter">
            <div class="ptx-chip ptx-channel" data-tip="按群聊筛选" data-tip-pos="bottom">
              ${organicIcon('scope', 12)}
              <button type="button" class="ptx-selectbtn" data-act="channel-toggle" aria-haspopup="listbox" aria-expanded="false" aria-label="群聊范围">
                <span class="ptx-selectbtn-label">全部</span>${runtimeIcon('chevronDown', 11)}
              </button>
              <div class="ptx-menu" role="listbox" aria-label="群聊范围" hidden></div>
            </div>
            <label class="ptx-chip" data-tip="搜索标题与正文" data-tip-pos="bottom">
              ${organicIcon('find', 12)}
              <input class="ptx-find" id="${ids.search}" type="search" placeholder="检索" aria-label="检索词条" autocomplete="off">
            </label>
          </div>
          <div class="ptx-winctl">
            <button class="ptx-winctl-btn" data-act="maximize" data-tip="最大化" data-tip-pos="bottom" aria-label="最大化" aria-pressed="false"><span class="ptx-ico-max">${organicIcon('maximize', 13)}</span><span class="ptx-ico-restore">${organicIcon('restore', 13)}</span></button>
            <button class="ptx-winctl-btn" data-act="minimize" data-tip="最小化" data-tip-pos="bottom" aria-label="最小化">${organicIcon('minimize', 13)}</button>
            <button class="ptx-winctl-btn is-close" data-act="close" data-tip="关闭" data-tip-pos="bottom" aria-label="关闭">${organicIcon('close', 13)}</button>
          </div>
        </div>
      </header>

      <div class="ptx-viewport" id="${ids.viewport}"></div>

      <footer class="ptx-foot">
        <div class="ptx-ticker" id="${ids.ticker}"></div>
        <div class="ptx-foot-acts">
          <button class="ptx-foot-btn is-core" data-act="refresh" data-tip="刷新数据" data-tip-pos="top" aria-label="刷新数据">${organicIcon('sync', 13)}</button>
        </div>
      </footer>
    </section>
    </div>

    ${resizeLayer()}
  </div>

  <button class="ptx-pill" id="${ids.pill}" data-act="expand" data-tip="点击展开阅读器" data-tip-pos="top" aria-label="展开 LLMWiki 知识阅读器">
    <span class="ptx-pill-core">${organicIcon('nucleus', 15)}</span>
    <span class="ptx-pill-txt">
      <span class="ptx-pill-name">LLMWiki 知识库</span>
      <span class="ptx-pill-id">知识阅读器</span>
    </span>
  </button>

  <div class="ptx-toast" id="${ids.toast}"></div>
`.trim();
}

export interface OrganicRuntimeOptions {
  basePath: string;
  prefix: string;
  mode: 'page' | 'dock';
}

export function organicRuntime(options: OrganicRuntimeOptions): string {
  const ids = organicIds(options.prefix);
  const cfg = {
    base: options.basePath,
    channel: PATCHOULI_CHANNEL,
    channels: [...PATCHOULI_CHANNELS],
    mode: options.mode,
    host: options.mode === 'dock' ? 'ptxDockRoot' : '',
    ids,
  };

  return `(function () {
  "use strict";
  var CFG = ${JSON.stringify(cfg)};
  var IDS = CFG.ids;
  var BASE = CFG.base;
  var CHANNEL = CFG.channel;
  var DEFAULT_CHANNELS = CFG.channels;
  var MODE = CFG.mode;
  var IDLE_MS = 5000;
  var TICKER_SWAP_MS = 400;
  var TICKER_COUNT_DEFAULT = 6;
  var TICKER_COUNT_MIN = 1;
  var TICKER_COUNT_MAX = 20;
  var TICKER_INTERVAL_DEFAULT = 5;
  var TICKER_INTERVAL_MIN = 3;
  var TICKER_INTERVAL_MAX = 60;
  var LATEST_POLL_MS = 30000;
  var LATEST_LIMIT = 20;
  var SETTINGS_KEY = "patchouli.panel-settings";
  var MARGIN = 14;
  var MIN_WIDTH = 480;
  var MIN_HEIGHT = 360;
  /* 窗口宽度换挡阈值：offsetWidth 含左右各 1px 发丝线边框，故 +2 对齐原来的容器查询
     （容器查询量的是内容盒）。这两条类名取代容器查询的 inline-size 包含，避免布局包含
     在每帧几何写入时把整窗连同子层重排 / 重光栅。 */
  var NARROW_MAX = 782;
  var COMPACT_MAX = 562;
  var ORBIT_PARAMS = 8;
  var SERIES_POLL_MS = 5000;
  var IDLE_POLL_MS = 15000;
  var PATHS = ${JSON.stringify({ ...ORGANIC_ICONS, ...RUNTIME_ICONS })};
  var NUCLEUS = ${JSON.stringify(organicNucleus(options.prefix))};

  var buildTrafficPath = ${buildTrafficPath.toString()};
  function monitorViewport() { return viewport; }
  ${trafficRuntime()}

  function byId(id) { return document.getElementById(id); }

  var win = byId(IDS.window);
  if (!win) return;
  var pill = byId(IDS.pill);
  var viewport = byId(IDS.viewport);
  var tickerEl = byId(IDS.ticker);
  var phaseEl = byId(IDS.phase);
  var toastEl = byId(IDS.toast);
  /* 群聊范围：自绘 listbox（原生 select 的系统弹层与整体材质冲突，故整块自绘） */
  var channelChip = win.querySelector(".ptx-channel");
  var channelToggle = channelChip ? channelChip.querySelector(".ptx-selectbtn") : null;
  var channelMenu = channelChip ? channelChip.querySelector(".ptx-menu") : null;
  var searchInput = byId(IDS.search);
  var handle = byId(IDS.dragHandle);
  var host = CFG.host ? byId(CFG.host) : document;
  if (!host) host = document;
  /* 主题类挂在最外层宿主：Console 组件挂在隔离根节点；独立页与全屏客户端退到 <html> / 根容器 */
  var themeRoot = document.getElementById("patchouli-organic-root") || (CFG.host ? byId(CFG.host) : null) || document.documentElement;
  var gearBtn = win.querySelector(".ptx-gear");

  /* ---------------- 卡片 / 列表视图模式（唯一键 patchouli-view-mode） ----------------
     布局偏好独立于 SETTINGS：重置面板设置不应把用户刚选的布局一起清掉。
     读取容错同设置项——任何异常 / 非法值都退回默认的卡片模式。
     常量必须先于 state 初始化声明（state 首行就会读一次），否则读到 undefined 键。 */

  var VIEW_KEY = "patchouli-view-mode";

  function readStoredViewMode() {
    var raw = null;
    try { raw = window.localStorage.getItem(VIEW_KEY); } catch (err) { raw = null; }
    return raw === "list" ? "list" : "card";
  }

  function setViewMode(mode) {
    state.viewMode = mode === "list" ? "list" : "card";
    try { window.localStorage.setItem(VIEW_KEY, state.viewMode); } catch (err) { /* 隐私模式：仅本次会话生效 */ }
  }

  /* ---------------- 群聊范围（唯一键 patchouli-channel-scope） ----------------
     群聊筛选是用户在顶栏做的选择，属于跨会话记忆：下次打开面板仍停在同一个群。
     读取容错："all" / 空值 / 读取异常都收敛到"全部"，具体群聊是否仍存在由
     loadChannels 的成员校验兜底（群被移除时回落"全部"）。 */

  var CHANNEL_SCOPE_KEY = "patchouli-channel-scope";

  function readStoredChannel() {
    var raw = null;
    try { raw = window.localStorage.getItem(CHANNEL_SCOPE_KEY); } catch (err) { raw = null; }
    var value = String(raw == null ? "" : raw).trim();
    return value ? value : "all";
  }

  function setChannelScope(value) {
    var next = value || "all";
    try { window.localStorage.setItem(CHANNEL_SCOPE_KEY, next); } catch (err) { /* 隐私模式：仅本次会话生效 */ }
  }

  /* ---------------- 主题原语（必须早于 state 初始化） ----------------
     唯一键 patchouli-theme；宿主 class 上的语义令牌逐个显式列举，避免用子串匹配把
     .dark-mode-toggle 之类误判成夜间主题。
     这三条是 var 声明而不是函数：下面 state 的首个字段就要调用 detectHostDark()，
     声明若留在后面，var 提升会让它们在此刻等于 undefined，tokenTheme 读 .length 直接抛
     TypeError，整个运行时（渲染 / 主题 / 手势 / 轮播）会在初始化那一行全部停摆。 */
  var THEME_KEY = "patchouli-theme";
  var DARK_TOKENS = ["dark", "theme-dark", "is-dark", "dark-theme"];
  var LIGHT_TOKENS = ["light", "theme-light", "is-light", "light-theme"];

  var state = {
    entries: [],
    entriesLoaded: false,
    entriesError: "",
    latestEntries: [],
    latestLoaded: false,
    latestError: false,
    channels: DEFAULT_CHANNELS.slice(),
    channel: readStoredChannel(),
    keyword: "",
    stage: "entries",
    /* 进入正文时记住来源列表页签：返回键与页签高亮都回到它 */
    listStage: "entries",
    viewMode: readStoredViewMode(),
    activeId: null,
    detail: null,
    detailError: "",
    detailLoading: false,
    status: null,
    statusChecked: false,
    collapsed: false,
    floating: false,
    maximized: false,
    sized: false,
    restoreStyle: "",
    theme: detectHostDark() ? "dark" : "light",
    settings: loadSettings(),
    tickerIndex: 0,
    tickerTimer: null,
    tickerSwap: null,
    idleTimer: null,
    rafId: 0,
    pending: null,
    lastView: "",
    statusTimer: null,
    editingEntryId: null,
    deleteArmed: false,
    clearArmed: false,
    /* <details> 开合态记忆（key → true/false）：render() 会整页重写 innerHTML，
       用户开过 / 关过的折叠区（附录、其余线索）不能弹回默认态；缺省值由渲染处给出 */
    folds: {},
    /* 系统提示词：服务端真值，进入设置页时拉取；data 为 null 表示尚未读取 */
    prompt: { data: null, error: "" },
    topicSettings: { data: null, error: "" },
    /* 出图选项（服务端持久化）：maskNames=false 时按原昵称出图。 */
    cardSettings: { settings: { maskNames: true }, error: "" }
  };


  /* ---------------- 基础工具 ---------------- */

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return "&quot;";
      return "&#39;";
    });
  }

  function num(value, fallback) {
    var parsed = typeof value === "number" ? value : Number(value);
    return isFinite(parsed) ? parsed : (fallback || 0);
  }

  function fixed(value, digits) {
    return num(value, 0).toFixed(digits == null ? 1 : digits);
  }

  function clip(text, limit) {
    var raw = String(text == null ? "" : text).replace(/\\s+/g, " ").trim();
    if (raw.length <= limit) return raw;
    return raw.slice(0, limit - 1) + "…";
  }

  /* ---------------- 面板设置（localStorage，独立页 / dock / Console 三处共用同一键） ----------------
     读取容错：任何损坏、越界、类型不符的字段都回退到保守默认值，绝不因本地存储异常影响面板。 */

  function clampInt(value, min, max, fallback) {
    var parsed = typeof value === "number" ? value : Number(value);
    if (!isFinite(parsed)) return fallback;
    var rounded = Math.round(parsed);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
  }

  function defaultSettings() {
    return {
      autoDock: true,
      tickerCount: TICKER_COUNT_DEFAULT,
      tickerInterval: TICKER_INTERVAL_DEFAULT,
      collapsedSections: {}
    };
  }

  function loadSettings() {
    var out = defaultSettings();
    var raw = null;
    try { raw = window.localStorage.getItem(SETTINGS_KEY); } catch (err) { raw = null; }
    if (!raw) return out;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
    if (!parsed || typeof parsed !== "object") return out;
    if (typeof parsed.autoDock === "boolean") out.autoDock = parsed.autoDock;
    out.tickerCount = clampInt(parsed.tickerCount, TICKER_COUNT_MIN, TICKER_COUNT_MAX, out.tickerCount);
    out.tickerInterval = clampInt(parsed.tickerInterval, TICKER_INTERVAL_MIN, TICKER_INTERVAL_MAX, out.tickerInterval);
    if (parsed.collapsedSections && typeof parsed.collapsedSections === "object") {
      var collapsed = parsed.collapsedSections;
      Object.keys(collapsed).forEach(function (key) {
        if (collapsed[key] === true) out.collapsedSections[String(key)] = true;
      });
    }
    return out;
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        autoDock: state.settings.autoDock,
        tickerCount: state.settings.tickerCount,
        tickerInterval: state.settings.tickerInterval,
        collapsedSections: state.settings.collapsedSections
      }));
    } catch (err) { /* 隐私模式或配额异常时静默降级：仅本次会话生效 */ }
  }

  /* ---------------- 明暗主题（唯一键 patchouli-theme，缺省跟随宿主） ----------------
     变量覆盖全部落在 themeRoot 的 .is-dark 上，窗口内不持有任何主题分支；
     因此独立页 / 内嵌组件 / 全屏客户端共用同一套切换逻辑与同一份记忆。
     缺省主题优先跟随宿主：内嵌组件长在 Koishi 控制台里，宿主是深色主题时窗口若
     仍是亮白纸面，就会在深底上悬一块刺眼的白板。
     THEME_KEY / DARK_TOKENS / LIGHT_TOKENS 已在 state 之前声明（见上），此处直接使用。 */

  function systemTheme() {
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch (err) { /* 无 matchMedia 的老浏览器回退浅色 */ }
    return "light";
  }

  function readStoredTheme() {
    var raw = null;
    try { raw = window.localStorage.getItem(THEME_KEY); } catch (err) { raw = null; }
    return raw === "dark" || raw === "light" ? raw : null;
  }

  /* 宿主底色亮度：只认 computed backgroundColor，alpha 为 0 视为“这层没铺底色”，
     继续往下一层（body → html）找；两层都透明才由系统偏好兜底。 */
  function hostLuma(el) {
    if (!el || !window.getComputedStyle) return null;
    var raw = "";
    try { raw = window.getComputedStyle(el).backgroundColor; } catch (err) { return null; }
    var match = /rgba?\\(\\s*([0-9.]+)[,\\s/]+([0-9.]+)[,\\s/]+([0-9.]+)(?:[,\\s/]+([0-9.]+)(%?))?\\s*\\)/i.exec(String(raw == null ? "" : raw));
    if (!match) return null;
    var alpha = match[4] == null ? 1 : (match[5] ? Number(match[4]) / 100 : Number(match[4]));
    if (!isFinite(alpha) || alpha <= 0) return null;
    return 0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3]);
  }

  /* 宿主 class 上的主题语义令牌：控制台可能写 dark / theme-dark / is-dark（浅色同理），
     逐个显式列举，避免用子串匹配把 .dark-mode-toggle 之类误判成夜间主题。
     （数组本体已在 state 之前声明，此处只保留判定函数。） */
  function tokenTheme(el) {
    if (!el || !el.classList) return null;
    var i;
    for (i = 0; i < DARK_TOKENS.length; i++) if (el.classList.contains(DARK_TOKENS[i])) return "dark";
    for (i = 0; i < LIGHT_TOKENS.length; i++) if (el.classList.contains(LIGHT_TOKENS[i])) return "light";
    return null;
  }

  /* 宿主暗色检测：class 令牌 / data-theme / 实际底色亮度三级判定，都读不到时退回
     prefers-color-scheme。前两级是显式声明，优先级高于亮度（深色主题也可能把 body
     刷成中性灰而亮度接近阈值）。 */
  function detectHostDark() {
    var hosts = [document.body, document.documentElement];
    var i;
    for (i = 0; i < hosts.length; i++) {
      var el = hosts[i];
      if (!el) continue;
      var token = tokenTheme(el);
      if (token === "dark") return true;
      if (token === "light") return false;
      var declared = el.getAttribute("data-theme");
      if (declared === "dark") return true;
      if (declared === "light") return false;
    }
    for (i = 0; i < hosts.length; i++) {
      var luma = hostLuma(hosts[i]);
      if (luma != null) return luma < 128;
    }
    return systemTheme() === "dark";
  }

  /* 生效主题的唯一裁决点。宿主深色优先：控制台深底下，任何一次旧测试 / 旧会话留下的
     "light" 记忆都会把窗口刷成刺眼白板，因此宿主判定为深色时直接以夜间渲染，持久化的
     浅色不再生效；本次会话内用户手动点过日 / 月按钮则尊重手动选择（manualTheme）。 */
  var manualTheme = null;

  function desiredTheme() {
    if (manualTheme === "dark" || manualTheme === "light") return manualTheme;
    if (detectHostDark()) return "dark";
    return readStoredTheme() || "light";
  }

  function applyTheme(theme, persist) {
    var next = theme === "dark" ? "dark" : "light";
    state.theme = next;
    if (themeRoot) themeRoot.classList.toggle("is-dark", next === "dark");
    var button = win ? win.querySelector(".ptx-theme") : null;
    if (button) {
      var label = next === "dark" ? "切换日间主题" : "切换夜间主题";
      button.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
      button.setAttribute("aria-label", label);
      button.setAttribute("data-tip", label);
    }
    if (persist) {
      try { window.localStorage.setItem(THEME_KEY, next); } catch (err) { /* 隐私模式：仅本次会话生效 */ }
    }
  }

  function toggleTheme() {
    manualTheme = state.theme === "dark" ? "light" : "dark";
    applyTheme(manualTheme, true);
  }

  /* 宿主换肤跟随：MutationObserver 只盯 <html> / <body> 的 class · data-theme · style，
     连续变更合并成一次（60ms 静默后再判）。裁决统一走 desiredTheme()：本会话内手动
     选择 > 宿主深色 > 持久化偏好 > 浅色。
     独立页自己就是宿主，观察自己只会把刚写下的类名回声一遍，故不挂。 */
  var hostObserver = null;

  function syncHostTheme() {
    applyTheme(desiredTheme(), false);
  }

  function watchHostTheme() {
    if (hostObserver || !window.MutationObserver) return;
    var targets = [document.documentElement, document.body];
    var watching = [];
    var i;
    for (i = 0; i < targets.length; i++) if (targets[i]) watching.push(targets[i]);
    if (!watching.length) return;
    var queued = false;
    hostObserver = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () { queued = false; syncHostTheme(); }, 60);
    });
    for (i = 0; i < watching.length; i++) {
      hostObserver.observe(watching[i], { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    }
  }

  /* 检测器状态中文映射（全产品唯一来源）：OFFLINE 即与后端连接中断 */
  var PHASE_LABELS = {
    LOADING: "正在连接",
    IDLE: "就绪",
    BURSTING: "突发采样",
    COOLING: "平息观察",
    SUMMARIZING: "沉淀生成",
    OFFLINE: "连接中断"
  };

  function phaseLabel(phase) {
    var key = String(phase == null ? "" : phase).trim().toUpperCase();
    return PHASE_LABELS[key] || "状态未知";
  }

  /* 状态提示：只说当下有意义的一句，不罗列全部状态 */
  var PHASE_TIPS = {
    LOADING: "正在连接服务",
    IDLE: "等待讨论，暂无突发",
    BURSTING: "正在缓存活跃讨论",
    COOLING: "讨论已平息，等待沉淀",
    SUMMARIZING: "正在生成词条",
    OFFLINE: "无法连接服务，请检查后刷新"
  };

  /* 词条状态中文映射：后端只有 verified / tentative / open 三态 */
  var ENTRY_STATUS = { verified: "已核验", tentative: "待定", open: "存疑", draft: "草稿" };

  function entryStatusKey(status) {
    var key = String(status == null ? "" : status).trim().toLowerCase();
    return ENTRY_STATUS[key] ? key : "unknown";
  }

  function entryStatusLabel(status) {
    return ENTRY_STATUS[entryStatusKey(status)] || "未标注";
  }

  function svg(name, size) {
    var dim = size || 14;
    return '<svg width="' + dim + '" height="' + dim + '" viewBox="0 0 24 24" aria-hidden="true">' + (PATHS[name] || PATHS.nucleus) + "</svg>";
  }

  function tipAttr(text, pos) {
    return ' data-tip="' + esc(text) + '" data-tip-pos="' + (pos || "bottom") + '"';
  }

  var REQUEST_TIMEOUT_MS = 15000;

  function getJson(url, options) {
    /* 请求超时：没有它，一个挂死的连接会让 status 轮询链永久停摆（promise 永不 settle）。 */
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(url, Object.assign({ credentials: "same-origin" }, options, { signal: controller.signal })).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function toast(text) {
    if (!toastEl) return;
    toastEl.innerHTML = svg("check", 11) + "<span>" + esc(text) + "</span>";
    toastEl.classList.add("is-visible");
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(function () { toastEl.classList.remove("is-visible"); }, 2400);
  }

  /* ---------------- 词条种类与列表过滤 ---------------- */

  /* kind 判定（主题）：主题是跨时间的长期聚合视图，单独成页；
     早期主题词条可能还没有 kind 字段，此时以 timeline 非空兜底。 */
  function isTopicEntry(entry) {
    if (!entry) return false;
    if (entry.kind === "topic") return true;
    if (entry.kind === "debate") return false;
    return Array.isArray(entry.timeline) && entry.timeline.length > 0;
  }

  /* 当前列表页签下的可见词条（state.entries 恒为全量，过滤只发生在渲染） */
  function listEntries() {
    var wantTopic = state.stage === "topics";
    return state.entries.filter(function (entry) {
      return entry && isTopicEntry(entry) === wantTopic;
    });
  }

  /* 主题时间轴的日期覆盖范围：取首尾两条来源日期（后端按 date 升序）；
     没有时间线时回退词条自身日期，绝不显示空占位。 */
  function topicRange(entry) {
    var items = Array.isArray(entry.timeline) ? entry.timeline : [];
    var dates = [];
    for (var i = 0; i < items.length; i += 1) {
      var value = String((items[i] && items[i].date) || "").trim();
      if (value) dates.push(value);
    }
    if (!dates.length) return String(entry.date || "--");
    var first = dates[0];
    var last = dates[dates.length - 1];
    return first === last ? first : first + " → " + last;
  }

  /* <details> 开合态：state.folds 只记用户碰过的键，未碰过的按 defaultOpen 渲染。 */
  function foldOpen(key, defaultOpen) {
    return Object.prototype.hasOwnProperty.call(state.folds, key)
      ? state.folds[key] === true
      : defaultOpen === true;
  }

  /* ---------------- 正文昵称高亮 ---------------- */

  /* mentionize：把正文里的群友昵称渲染成 ptx-node 内联胶囊。
     先整体转义，再用一条联合正则同时命中「昵称」与裸昵称（前者剥掉括号），
     命中处暂存占位符；随后照常做「…」原话高亮，最后把占位符还原为胶囊——
     三步分离保证胶囊与原话高亮不会互相嵌套出坏标签。
     昵称首 / 尾字符是 ASCII 字母数字时要求相邻字符非字母数字（「7」不会误伤「17」）。 */
  function mentionize(text, names) {
    var safe = esc(text);
    var list = [];
    var seen = {};
    var all = Array.isArray(names) ? names : [];
    for (var i = 0; i < all.length; i += 1) {
      var raw = String(all[i] == null ? "" : all[i]).trim();
      if (!raw || seen[raw]) continue;
      seen[raw] = 1;
      /* 单字符非字母数字名（「，」「。」之类）不参与高亮，防止误伤标点 */
      if (raw.length === 1 && !/[A-Za-z0-9]/.test(raw)) continue;
      list.push(raw);
    }
    var wrapQuotes = function (m, inner) {
      return '<span class="ptx-quote-span">「' + inner + "」</span>";
    };
    if (!list.length) {
      return safe.replace(/「([^」]*)」/g, wrapQuotes);
    }
    /* 昵称也按 esc 规则转义后再进正则（正文是转义后的文本）；
       长名在前，避免短名先吃掉长名的前缀。 */
    var escNames = list
      .map(function (n) { return esc(n); })
      .sort(function (a, b) { return b.length - a.length; });
    var alternation = escNames
      .map(function (n) { return n.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, "\\\\$&"); })
      .join("|");
    var re = new RegExp("「(" + alternation + ")」|(" + alternation + ")", "g");
    var stash = [];
    var staged = safe.replace(re, function (match, bracketed, bare, offset) {
      var name = bracketed !== undefined ? bracketed : bare;
      if (bracketed === undefined) {
        var first = name.charAt(0);
        var last = name.charAt(name.length - 1);
        var before = offset > 0 ? safe.charAt(offset - 1) : "";
        var after = safe.charAt(offset + match.length);
        if (/[A-Za-z0-9]/.test(first) && /[A-Za-z0-9]/.test(before)) return match;
        if (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(after)) return match;
      }
      stash.push(name);
      return "\\u0000" + (stash.length - 1) + "\\u0000";
    });
    staged = staged.replace(/「([^」]*)」/g, wrapQuotes);
    return staged.replace(/\\u0000(\\d+)\\u0000/g, function (m, index) {
      return '<span class="ptx-node is-inline">' + stash[Number(index)] + "</span>";
    });
  }

  /* 列表项版 mentionize：与 bullets() 同形但正文走昵称胶囊化 */
  function mentionBullets(items, names) {
    if (!Array.isArray(items) || !items.length) return "";
    return '<ul class="ptx-bul">' + items.map(function (line) {
      return "<li>" + mentionize(line, names) + "</li>";
    }).join("") + "</ul>";
  }

  /* ---------------- 发言人链路 ---------------- */

  function names(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var raw = list[i];
      var name = typeof raw === "string" ? raw : (raw && (raw.name || raw.userName || raw.id));
      var key = String(name == null ? "" : name).trim();
      if (key) out.push(key);
    }
    return out;
  }

  function uniqNames(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      if (seen[list[i]]) continue;
      seen[list[i]] = 1;
      out.push(list[i]);
    }
    return out;
  }

  function speakersOf(detail) {
    if (!detail) return [];
    var collected = names(detail.participants);
    var points = Array.isArray(detail.debateMatrix) ? detail.debateMatrix : [];
    for (var i = 0; i < points.length; i += 1) {
      collected = collected.concat(names(points[i] && points[i].proponents));
      collected = collected.concat(names(points[i] && points[i].opponents));
    }
    var quotes = Array.isArray(detail.keyQuotes) ? detail.keyQuotes : [];
    for (var j = 0; j < quotes.length; j += 1) {
      if (quotes[j] && quotes[j].author) collected.push(String(quotes[j].author));
    }
    return uniqNames(collected);
  }

  function nodeTag(name, tone) {
    var cls = "ptx-node" + (tone ? " is-" + tone : "");
    return '<span class="' + cls + '">' + esc(name) + "</span>";
  }

  function voice(tone, label, list) {
    if (!list.length) return "";
    return '<div class="ptx-voice is-' + tone + '"><span class="ptx-voice-l">' + label + "</span>" +
      list.map(function (name) { return nodeTag(name, tone); }).join("") + "</div>";
  }

  function speakersHtml(list) {
    if (!list.length) return "";
    return '<div class="ptx-speakers">' +
      '<span class="ptx-nodes-label">参与成员</span>' +
      list.map(function (name) { return nodeTag(name); }).join("") + "</div>";
  }

  /* ---------------- 视图骨架 ---------------- */

  function head(title, sub, extra) {
    return '<div class="ptx-vhead"><span class="ptx-vhead-bar"></span>' +
      '<span class="ptx-vhead-title">' + esc(title) + "</span>" +
      '<span class="ptx-vhead-sub">' + esc(sub) + "</span>" +
      (extra || "") + "</div>";
  }

  /* 卡片 / 列表切换块：标题行右端的分段胶囊。两枚按钮共用一个 data-act，
     各自带 data-mode 与 aria-pressed，点击即落库并整页重绘（滚动位置由 lastView 保持）。 */
  function renderViewToggle() {
    var card = state.viewMode !== "list";
    var btn = function (mode, icon, label, active) {
      return '<button type="button" class="ptx-view-btn' + (active ? " is-active" : "") + '"' +
        ' data-act="view-mode" data-mode="' + mode + '"' +
        ' aria-pressed="' + (active ? "true" : "false") + '"' +
        tipAttr(label) + ' aria-label="' + label + '">' +
        svg(icon, 12) + "</button>";
    };
    return '<div class="ptx-view-mode" role="group" aria-label="词条布局">' +
      btn("card", "grid", "卡片视图", card) +
      btn("list", "list", "列表视图", !card) +
    "</div>";
  }

  /* 空状态：中文短标题 + 一句可执行提示（不再有装饰性英文标语） */
  function dormant(title, hint) {
    return '<div class="ptx-dormant">' + NUCLEUS +
      '<span class="ptx-dormant-t">' + esc(title) + "</span>" +
      '<span class="ptx-dormant-s">' + esc(hint) + "</span></div>";
  }

  function section(title, inner) {
    return '<div class="ptx-sec"><div class="ptx-sec-h">' + esc(title) + "</div>" + inner + "</div>";
  }

  function bullets(items, fallback) {
    if (!Array.isArray(items) || !items.length) return '<div class="ptx-text">' + esc(fallback) + "</div>";
    return '<ul class="ptx-bul">' + items.map(function (line) {
      return "<li>" + esc(String(line)) + "</li>";
    }).join("") + "</ul>";
  }

  function markdownSection(markdown, headings) {
    if (!markdown) return "";
    var lines = String(markdown).split("\\n");
    var out = [];
    var capturing = false;
    for (var i = 0; i < lines.length; i += 1) {
      var match = /^#{1,6}\\s*(.+?)\\s*$/.exec(lines[i].trim());
      if (match) {
        if (capturing) break;
        var name = match[1].toLowerCase();
        for (var j = 0; j < headings.length; j += 1) {
          if (name.indexOf(headings[j]) >= 0) { capturing = true; break; }
        }
        continue;
      }
      if (capturing) out.push(lines[i]);
    }
    return out.join("\\n").trim();
  }

  /* ---------------- 词条索引（列表卡片） ---------------- */

  function sporeHtml(entry) {
    var id = esc(entry.id);
    var isTopic = isTopicEntry(entry);
    var glyph = isTopic ? "topics" : "spore";
    var glyphClass = isTopic ? " is-topic" : "";
    var timelineCount = isTopic && Array.isArray(entry.timeline) ? entry.timeline.length : 0;
    /* 主题永远处于待定态（跨时间聚合，不做「已核验」断言），状态位改报时间线条数 */
    var statusHtml = isTopic
      ? '<span class="ptx-spore-status is-topic">' + ((timelineCount || 0) + " 条相关词条") + "</span>"
      : '<span class="ptx-spore-status is-' + esc(entryStatusKey(entry.status)) + '">' + esc(entryStatusLabel(entry.status)) + "</span>";
    var dateText = isTopic ? topicRange(entry) : entry.date || "--";
    var nodes = names(entry.participants);
    var nodeHtml = nodes.length
      ? '<span class="ptx-nodes">' + nodes.map(function (name) {
          return '<span class="ptx-node">' + esc(name) + "</span>";
        }).join("") + "</span>"
      : "";
    return '<button class="ptx-spore" data-act="select" data-id="' + id + '"' + tipAttr("阅读词条") + ">" +
      '<span class="ptx-spore-glyph' + glyphClass + '">' + svg(glyph, 14) + "</span>" +
      '<span class="ptx-spore-main">' +
        '<span class="ptx-spore-top">' +
          '<span class="ptx-spore-date">' + esc(dateText) + "</span>" +
          statusHtml +
        "</span>" +
        '<span class="ptx-spore-title">' + esc(entry.title || "未命名词条") + "</span>" +
        '<span class="ptx-spore-sum">' + esc(clip(entry.summary || "", 96)) + "</span>" +
        nodeHtml +
      "</span>" +
      '<span class="ptx-spore-go">' + svg("chevron", 13) + "</span>" +
    "</button>";
  }

  function stripHtml(list) {
    var latest = "";
    var nodes = [];
    var channels = {};
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      nodes = nodes.concat(names(entry.participants));
      if (entry.channelId) channels[entry.channelId] = 1;
      if (entry.date && entry.date > latest) latest = entry.date;
    }
    var stat = function (label, value, tipText) {
      return '<div class="ptx-stat"' + tipAttr(tipText) + '><span class="ptx-stat-l">' + esc(label) + "</span>" +
        '<span class="ptx-stat-v">' + esc(value) + "</span></div>";
    };
    return '<div class="ptx-strip">' +
      stat(state.stage === "topics" ? "主题" : "词条", String(list.length), "当前筛选下的条目数") +
      stat("群聊", String(Object.keys(channels).length), "词条涉及的群聊数") +
      stat("发言人", String(uniqNames(nodes).length), "参与过讨论的发言人数") +
      stat("最近更新", latest || "--", "最新词条日期") +
    "</div>";
  }

  function sporesView() {
    var isTopicList = state.stage === "topics";
    var list = listEntries();
    if (!list.length) {
      if (state.entriesError) {
        return dormant("读取失败", "无法读取索引（" + state.entriesError + "）。请检查网络或点击底栏核心按钮刷新数据重试。");
      }
      if (!state.entriesLoaded) {
        return dormant("正在加载", isTopicList ? "正在读取主题索引，请稍候。" : "正在读取词条索引，请稍候。");
      }
      if (state.keyword) {
        return dormant("没有匹配结果", "当前关键词没有检索到" + (isTopicList ? "主题" : "词条") + "；换个关键词，或清空搜索框查看全部。");
      }
      return isTopicList
        ? dormant("暂无主题", "跨时间的同一话题被识别归并后，会在这里形成长期主题；也可点击底栏核心按钮刷新数据重新读取。")
        : dormant("暂无词条", "群聊讨论平息后会自动生成词条；也可点击底栏核心按钮刷新数据重新读取。");
    }
    return stripHtml(list) +
      '<div class="ptx-spores' + (state.viewMode === "list" ? " is-list" : "") + '">' +
      list.map(sporeHtml).join("") + "</div>";
  }

  /* ---------------- 系统提示词（服务端真值，热生效） ----------------
     提示词不是浏览器偏好：读 / 写都走 /api/prompt，保存后下一轮沉淀即生效，
     因此设置页永远显示服务端返回的 effective / isCustom，而不是本地缓存。 */

  function promptEditorValue() {
    var data = state.prompt.data;
    if (!data) return "";
    var custom = String(data.customPrompt == null ? "" : data.customPrompt);
    /* 自定义为空 = 使用默认预设：把默认全文摊开供查阅，而不是留一块空白 */
    if (custom.trim()) return custom;
    return String(data.defaultPrompt == null ? "" : data.defaultPrompt);
  }

  function promptStatusLabel() {
    if (state.prompt.error) return "提示词读取失败：" + state.prompt.error;
    var data = state.prompt.data;
    if (!data) return "正在读取提示词…";
    return data.isCustom ? "自定义提示词生效中" : "默认预设生效中";
  }

  /* 就地回写，避免重新渲染整页（文本框里的换行缩进与焦点都不会被打断） */
  function syncPromptUI() {
    if (!viewport || state.stage !== "settings") return;
    var field = viewport.querySelector('[data-role="system-prompt"]');
    if (field) field.value = promptEditorValue();
    var status = viewport.querySelector(".ptx-prompt-status");
    if (status) {
      status.textContent = promptStatusLabel();
      status.classList.toggle("is-custom", Boolean(state.prompt.data && state.prompt.data.isCustom));
    }
    var topicField = viewport.querySelector('[data-role="topic-system-prompt"]');
    if (topicField && state.prompt.data) topicField.value = state.prompt.data.topicEffectivePrompt || state.prompt.data.topicDefaultPrompt || "";
    var topicStatus = viewport.querySelector(".ptx-topic-prompt-status");
    if (topicStatus && state.prompt.data) {
      topicStatus.textContent = state.prompt.data.isTopicCustom ? "自定义主题提示词生效中" : "默认主题提示词生效中";
      topicStatus.classList.toggle("is-custom", Boolean(state.prompt.data.isTopicCustom));
    }
  }

  function loadPrompt() {
    return getJson(BASE + "/api/prompt").then(function (data) {
      if (data && typeof data === "object") state.prompt.data = data;
      state.prompt.error = "";
      syncPromptUI();
    }).catch(function (err) {
      state.prompt.error = err && err.message ? err.message : "未知错误";
      syncPromptUI();
    });
  }

  function loadTopicSettings() {
    return getJson(BASE + "/api/topics/settings").then(function (data) {
      if (data && typeof data === "object") state.topicSettings.data = data;
      state.topicSettings.error = "";
      if (state.stage === "settings") render();
    }, function (err) {
      state.topicSettings.error = err && err.message ? err.message : "未知错误";
      if (state.stage === "settings") render();
    });
  }

  function postTopicSettings(payload) {
    return getJson(BASE + "/api/topics/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  function saveTopicSettings() {
    var read = function (role, fallback) {
      var el = viewport ? viewport.querySelector('[data-role="' + role + '"]') : null;
      var value = el ? Number(el.value) : NaN;
      return isFinite(value) ? value : fallback;
    };
    var payload = {
      enabled: !(state.topicSettings.data && state.topicSettings.data.settings && state.topicSettings.data.settings.enabled === false),
      lookbackDays: read("topic-lookback", 30),
      mergeThreshold: read("topic-threshold", 0.5),
      minEntries: read("topic-min-entries", 1)
    };
    return postTopicSettings(payload).then(function () {
      return loadTopicSettings();
    }).then(function () {
      toast("主题校准参数已保存并热生效");
      render();
    }).catch(function (err) {
      toast("主题校准参数保存失败：" + (err && err.message ? err.message : "未知错误"));
    });
  }

  function loadCardSettings() {
    return getJson(BASE + "/api/card/settings").then(function (data) {
      if (data && typeof data === "object" && data.settings) state.cardSettings.settings = data.settings;
      state.cardSettings.error = "";
      if (state.stage === "settings") render();
    }, function (err) {
      state.cardSettings.error = err && err.message ? err.message : "未知错误";
      if (state.stage === "settings") render();
    });
  }

  /* 图片匿名化开关：切换即落盘（服务端原子写 + 热生效），下一次出图按新值执行。 */
  function toggleCardMask(node) {
    var next = !(state.cardSettings.settings.maskNames !== false);
    return getJson(BASE + "/api/card/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { maskNames: next } })
    }).then(function (data) {
      if (data && data.settings) state.cardSettings.settings = data.settings;
      if (node) {
        node.classList.toggle("is-on", state.cardSettings.settings.maskNames !== false);
        node.setAttribute("aria-checked", state.cardSettings.settings.maskNames !== false ? "true" : "false");
      }
      toast(state.cardSettings.settings.maskNames !== false ? "图片匿名化已开启" : "图片匿名化已关闭：图片将按原昵称输出");
    }, function (err) {
      toast("图片匿名化切换失败：" + (err && err.message ? err.message : "未知错误"));
    });
  }

  function postPrompt(payload) {
    return getJson(BASE + "/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  /* 保存：内容与默认提示词完全一致时按「恢复默认」提交，绝不留下一份同文的伪自定义副本 */
  function savePrompt() {
    var field = viewport ? viewport.querySelector('[data-role="system-prompt"]') : null;
    var value = field ? String(field.value == null ? "" : field.value) : "";
    var button = viewport ? viewport.querySelector('[data-action="save-prompt"]') : null;
    if (button) button.classList.add("is-busy");
    var data = state.prompt.data;
    var defaultText = data && typeof data.defaultPrompt === "string" ? data.defaultPrompt.trim() : "";
    var next = value.trim() === "" || value.trim() === defaultText ? "" : value;
    return postPrompt({ customPrompt: next }).then(function (result) {
      if (result && typeof result === "object") state.prompt.data = result;
      state.prompt.error = "";
      syncPromptUI();
      toast(next ? "自定义提示词已生效" : "已恢复默认提示词");
    }, function (err) {
      toast("提示词保存失败：" + (err && err.message ? err.message : "未知错误"));
    }).then(function () {
      if (button) button.classList.remove("is-busy");
    });
  }

  function saveTopicPrompt() {
    var field = viewport ? viewport.querySelector('[data-role="topic-system-prompt"]') : null;
    var value = field ? String(field.value == null ? "" : field.value) : "";
    var data = state.prompt.data;
    var defaultText = data && typeof data.topicDefaultPrompt === "string" ? data.topicDefaultPrompt.trim() : "";
    var next = value.trim() === "" || value.trim() === defaultText ? "" : value;
    var button = viewport ? viewport.querySelector('[data-action="save-topic-prompt"]') : null;
    if (button) button.classList.add("is-busy");
    return postPrompt({ customTopicPrompt: next }).then(function (result) {
      if (result && typeof result === "object") state.prompt.data = result;
      toast(next ? "主题聚合提示词已生效" : "已恢复主题聚合默认提示词");
      render();
    }, function (err) {
      toast("主题提示词保存失败：" + (err && err.message ? err.message : "未知错误"));
    }).then(function () {
      if (button) button.classList.remove("is-busy");
    });
  }

  function resetTopicPrompt() {
    var button = viewport ? viewport.querySelector('[data-action="reset-topic-prompt"]') : null;
    if (button) button.classList.add("is-busy");
    return postPrompt({ customTopicPrompt: "" }).then(function (result) {
      if (result && typeof result === "object") state.prompt.data = result;
      toast("已恢复主题聚合默认提示词");
      render();
    }, function (err) {
      toast("恢复默认失败：" + (err && err.message ? err.message : "未知错误"));
    }).then(function () {
      if (button) button.classList.remove("is-busy");
    });
  }

  /* 恢复默认：清空自定义后重新拉取，编辑区回填默认全文 */
  function resetPrompt() {
    var button = viewport ? viewport.querySelector('[data-action="reset-prompt"]') : null;
    if (button) button.classList.add("is-busy");
    return postPrompt({ customPrompt: "" }).then(function (result) {
      if (result && typeof result === "object") state.prompt.data = result;
      state.prompt.error = "";
      syncPromptUI();
      toast("已恢复默认提示词");
    }, function (err) {
      toast("恢复默认失败：" + (err && err.message ? err.message : "未知错误"));
    }).then(function () {
      if (button) button.classList.remove("is-busy");
    });
  }

  /* ---------------- 设置页（侧栏底部齿轮，与两个核心页签平级） ----------------
     只放面板自身的配置：自动收纳开关、词条索引视图模式、底栏轮播条数与间隔；
     触发器门限（突发倍率 / 平息等待）也从监控页收进这里——它们是配置而非观测，
     放在仪表盘上会让监控页既是读数区又是调参区。
     数据刷新只有底栏核心按钮一个入口，设置页只留说明文字。
     整块替换视窗内容，底栏轮播与状态轮询照常运行，绝不影响轮播节奏。 */

  function settingsHtml() {
    var settings = state.settings;
    /* 门限当前值取服务端最近一次状态快照；群聊切换后 loadStatus 会带回该群自己的值，
       保存走同一个 POST /api/tune，硬限幅仍由服务端夹紧。 */
    var tuneOptions = (state.status && state.status.options) || {};
    var topicData = (state.topicSettings.data && state.topicSettings.data.settings) || {};
    var topicLast = state.topicSettings.data && state.topicSettings.data.lastRun;
    var topicDispatch = (state.topicSettings.data && state.topicSettings.data.dispatcher) || {};
    var cardMask = state.cardSettings.settings.maskNames !== false;
    return head("参数设置", "本机设置 · 服务端门限") +
      '<div class="ptx-settings-page">' +
        '<div class="ptx-settings-shell">' +
        '<nav class="ptx-settings-outline" aria-label="设置大纲"></nav>' +
        '<div class="ptx-settings-main">' +
        section("面板行为",
          '<div class="ptx-settings-row">' +
            '<span class="ptx-settings-label">自动收纳<em>静置 5 秒后收回为呼吸胶囊，点击胶囊可重新展开。</em></span>' +
            '<button class="ptx-switch' + (settings.autoDock ? " is-on" : "") + '" data-act="autodock" role="switch" aria-checked="' + (settings.autoDock ? "true" : "false") + '" aria-label="自动收纳"></button>' +
          "</div>") +
        section("图片脱敏",
          '<div class="ptx-settings-row">' +
            '<span class="ptx-settings-label">图片匿名化<em>开启后词条图片里的昵称一律替换为假名；关闭则按群聊原文昵称出图。切换即生效，作用于下一次出图。</em></span>' +
            '<button class="ptx-switch' + (cardMask ? " is-on" : "") + '" data-act="toggle-card-mask" role="switch" aria-checked="' + (cardMask ? "true" : "false") + '" aria-label="图片匿名化"></button>' +
          "</div>") +
        section("索引视图",
          '<div class="ptx-settings-row">' +
            '<span class="ptx-settings-label">默认展示模式<em>词条索引列表的默认展示方式，与索引标题行右侧的切换胶囊双向同步。</em></span>' +
            renderViewToggle() +
          "</div>") +
        section("底栏轮播",
          '<label class="ptx-settings-row">' +
            '<span class="ptx-settings-label">轮播条数<em>底栏最多显示的最新词条数，取值 ' + TICKER_COUNT_MIN + " – " + TICKER_COUNT_MAX + '。</em></span>' +
            '<input class="ptx-input ptx-settings-num" data-role="ticker-count" type="number" min="' + TICKER_COUNT_MIN + '" max="' + TICKER_COUNT_MAX + '" step="1" value="' + settings.tickerCount + '" aria-label="轮播条数">' +
          "</label>" +
          '<label class="ptx-settings-row">' +
            '<span class="ptx-settings-label">轮播间隔<em>每条轮播停留的秒数，取值 ' + TICKER_INTERVAL_MIN + " – " + TICKER_INTERVAL_MAX + '。</em></span>' +
            '<input class="ptx-input ptx-settings-num" data-role="ticker-interval" type="number" min="' + TICKER_INTERVAL_MIN + '" max="' + TICKER_INTERVAL_MAX + '" step="1" value="' + settings.tickerInterval + '" aria-label="轮播间隔（秒）">' +
          "</label>") +
        section("触发器引擎", renderEngineSettings(tuneOptions)) +
        section("主题校准",
          '<div class="ptx-settings-note">跨时间聚合的运行时旋钮；保存后立即作用于下一轮校准，与 Console 的部署配置分开存放。</div>' +
          '<div class="ptx-settings-row">' +
            '<span class="ptx-settings-label">每日校准<em>固定 04:00 触发；关闭后不再自动归并。</em></span>' +
            '<button class="ptx-switch' + (topicData.enabled === false ? "" : " is-on") + '" data-action="toggle-topic-enabled" role="switch" aria-checked="' + (topicData.enabled === false ? "false" : "true") + '" aria-label="每日主题校准"></button>' +
          "</div>" +
          '<label class="ptx-settings-row">' +
            '<span class="ptx-settings-label">回看天数<em>只扫描最近 N 天内尚未归入主题的词条，1–90。</em></span>' +
            '<input class="ptx-input ptx-settings-num" data-role="topic-lookback" type="number" min="1" max="90" step="1" value="' + num(topicData.lookbackDays, 30) + '" aria-label="回看天数">' +
          "</label>" +
          '<label class="ptx-settings-row">' +
            '<span class="ptx-settings-label">聚类门限<em>标签 Jaccard 达到该值才进入候选组，0–1。</em></span>' +
            '<input class="ptx-input ptx-settings-num" data-role="topic-threshold" type="number" min="0" max="1" step="0.05" value="' + num(topicData.mergeThreshold, 0.5) + '" aria-label="聚类门限">' +
          "</label>" +
          '<label class="ptx-settings-row">' +
            '<span class="ptx-settings-label">最少词条<em>窗口内可归入词条少于此数则跳过本轮，1–50。</em></span>' +
            '<input class="ptx-input ptx-settings-num" data-role="topic-min-entries" type="number" min="1" max="50" step="1" value="' + num(topicData.minEntries, 1) + '" aria-label="最少词条">' +
          "</label>" +
          '<div class="ptx-settings-row">' +
            '<span class="ptx-settings-label">只读状态<em>' +
              esc(String(topicDispatch.provider || "—")) + " · " + esc(String(topicDispatch.protocol || "—")) + " · " + esc(String(topicDispatch.model || "—")) +
              (topicLast ? " · 上次创建 " + (topicLast.createdTopicIds ? topicLast.createdTopicIds.length : 0) + " / 更新 " + (topicLast.updatedTopicIds ? topicLast.updatedTopicIds.length : 0) + " / 归入 " + (topicLast.assignedEntryIds ? topicLast.assignedEntryIds.length : 0) : " · 本次尚未校准") +
            "</em></span>" +
            '<button class="ptx-btn is-primary" data-action="save-topic-settings" type="button">' + svg("check", 13) + "<span>保存主题参数</span></button>" +
          "</div>") +
        section("系统提示词",
          '<div class="ptx-editor">' +
            '<label class="ptx-editor-field">' +
              '<span class="ptx-editor-label">帕秋莉系统提示词 (SYSTEM PROMPT)</span>' +
              '<textarea class="ptx-input ptx-editor-area ptx-editor-md" data-role="system-prompt" spellcheck="false" aria-label="帕秋莉系统提示词">' + esc(promptEditorValue()) + "</textarea>" +
            "</label>" +
            '<div class="ptx-editor-foot">' +
              '<span class="ptx-prompt-status' + (state.prompt.data && state.prompt.data.isCustom ? " is-custom" : "") + '">' + esc(promptStatusLabel()) + "</span>" +
              '<span class="ptx-editor-hint">在悬浮窗内即时热生效，可随时一键恢复默认</span>' +
              '<button class="ptx-btn" data-action="reset-prompt" type="button">恢复默认</button>' +
              '<button class="ptx-btn is-primary" data-action="save-prompt" type="button">' + svg("check", 13) + "<span>保存并应用</span></button>" +
            "</div>" +
          "</div>") +
        section("主题聚合提示词",
          '<div class="ptx-editor">' +
            '<label class="ptx-editor-field">' +
              '<span class="ptx-editor-label">主题校准系统提示词 (TOPIC PROMPT)</span>' +
              '<textarea class="ptx-input ptx-editor-area ptx-editor-md" data-role="topic-system-prompt" spellcheck="false" aria-label="主题聚合系统提示词">' + esc((state.prompt.data && (state.prompt.data.topicEffectivePrompt || state.prompt.data.topicDefaultPrompt)) || "") + "</textarea>" +
            "</label>" +
            '<div class="ptx-editor-foot">' +
              '<span class="ptx-prompt-status ptx-topic-prompt-status' + (state.prompt.data && state.prompt.data.isTopicCustom ? " is-custom" : "") + '">' + esc(state.prompt.data && state.prompt.data.isTopicCustom ? "自定义主题提示词生效中" : "默认主题提示词生效中") + "</span>" +
              '<span class="ptx-editor-hint">只影响主题聚合，保存即热生效</span>' +
              '<button class="ptx-btn" data-action="reset-topic-prompt" type="button">恢复默认</button>' +
              '<button class="ptx-btn is-primary" data-action="save-topic-prompt" type="button">' + svg("check", 13) + "<span>保存并应用</span></button>" +
            "</div>" +
          "</div>") +
        section("知识库维护",
          '<div class="ptx-maint">' +
            '<div class="ptx-maint-text">清空全部已沉淀条目与原始会话。保留默认目录结构与索引骨架。</div>' +
            (state.clearArmed
              ? '<div class="ptx-maint-confirm">' +
                  '<span class="ptx-act-ask">确定清空全部知识库？(不可逆)</span>' +
                  '<button class="ptx-btn is-danger-solid" data-action="confirm-clear-kb" type="button">确认清空</button>' +
                  '<button class="ptx-btn" data-action="cancel-clear-kb" type="button">取消</button>' +
                "</div>"
              : '<button class="ptx-btn is-danger" data-action="clear-kb" type="button">' + svg("trash", 13) + "<span>清空全部词条</span></button>") +
          "</div>") +
        '<div class="ptx-settings-note">面板行为与轮播设置保存在本机浏览器，独立页与 Console 内嵌面板共用同一份配置；触发器门限按群聊保存在服务端并即时热生效；系统提示词保存在服务端 .patchouli/custom-prompt.txt，保存即热生效且重启不丢失。数据刷新统一收在底栏核心按钮。</div>' +
        "</div></div></div>";
  }

  /* 设置页大纲 + 单栏折叠：直接在当前 DOM 上装饰，不复制一份 section 结构。
     折叠态存 state.settings.collapsedSections，只影响本机阅读偏好。 */
  function decorateSettings() {
    if (!viewport || state.stage !== "settings") return;
    var shell = viewport.querySelector(".ptx-settings-shell");
    if (!shell) return;
    var outline = shell.querySelector(".ptx-settings-outline");
    var main = shell.querySelector(".ptx-settings-main");
    if (!outline || !main) return;
    var sections = Array.prototype.slice.call(main.children).filter(function (node) {
      return node && node.classList && node.classList.contains("ptx-sec");
    });
    outline.innerHTML = '<div class="ptx-outline-h">大纲</div>';
    sections.forEach(function (sec, index) {
      var head = sec.querySelector(".ptx-sec-h");
      if (!head) return;
      var id = "set-sec-" + index;
      sec.setAttribute("data-sec", id);
      var collapsed = state.settings.collapsedSections[id] === true;
      sec.classList.toggle("is-collapsed", collapsed);
      head.setAttribute("data-action", "toggle-section");
      head.setAttribute("data-target", id);
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      var title = (head.textContent || "").trim();
      var item = document.createElement("button");
      item.type = "button";
      item.className = "ptx-outline-item";
      item.setAttribute("data-action", "jump-section");
      item.setAttribute("data-target", id);
      item.textContent = title;
      outline.appendChild(item);
    });
  }

  /* 设置页控件回写：落库后显示值与生效值永远一致（切换页签回来也会重新渲染） */
  function syncSettingsUI() {
    if (!viewport) return;
    var toggle = viewport.querySelector('[data-act="autodock"]');
    if (toggle) {
      toggle.classList.toggle("is-on", state.settings.autoDock);
      toggle.setAttribute("aria-checked", state.settings.autoDock ? "true" : "false");
    }
    var count = viewport.querySelector('[data-role="ticker-count"]');
    if (count) count.value = String(state.settings.tickerCount);
    var interval = viewport.querySelector('[data-role="ticker-interval"]');
    if (interval) interval.value = String(state.settings.tickerInterval);
  }

  /* ---------------- 观点碰撞矩阵 ---------------- */

  function matrixHtml(detail, mentionNames) {
    var points = detail && Array.isArray(detail.debateMatrix) ? detail.debateMatrix : [];
    if (!points.length) return "";
    var empty = '<span class="ptx-td-empty">—</span>';
    var side = function (list, tone) {
      return list.length
        ? list.map(function (name) { return nodeTag(name, tone); }).join("")
        : empty;
    };
    var body = function (list) {
      return list.length ? mentionize(clip(list.join("；"), 220), mentionNames) : empty;
    };
    var namesOfPoint = function (point, key) { return names(point && point[key]); };
    var listOfPoint = function (point, key) { return Array.isArray(point && point[key]) ? point[key] : []; };
    var head = '<tr><th class="ptx-th-corner">对照</th>' + points.map(function (_, index) {
      return "<th>观点 " + (index + 1 < 10 ? "0" : "") + (index + 1) + "</th>";
    }).join("") + "</tr>";
    var row = function (label, render) {
      return '<tr><th scope="row">' + label + "</th>" + points.map(render).join("") + "</tr>";
    };
    return '<div class="ptx-table-wrap"><table class="ptx-table ptx-compare"><thead>' + head + "</thead><tbody>" +
      row("立场", function (point) {
        return '<td class="ptx-td-view">' + esc((point && point.viewpoint) || "未命名观点") + "</td>";
      }) +
      row("支持", function (point) { return '<td class="ptx-td-side">' + side(namesOfPoint(point, "proponents"), "support") + "</td>"; }) +
      row("质疑", function (point) { return '<td class="ptx-td-side">' + side(namesOfPoint(point, "opponents"), "dissent") + "</td>"; }) +
      row("论据", function (point) { return '<td class="ptx-td-body">' + body(listOfPoint(point, "arguments")) + "</td>"; }) +
      row("反驳", function (point) { return '<td class="ptx-td-body">' + body(listOfPoint(point, "counterArguments")) + "</td>"; }) +
      "</tbody></table></div>";
  }

  /* ---------------- 原始引用 ---------------- */

  function quotesHtml(quotes) {
    if (!Array.isArray(quotes) || !quotes.length) return "";
    return '<div class="ptx-quotes">' + quotes.map(function (item) {
      var author = (item && item.author) || "匿名成员";
      return '<div class="ptx-quote">' +
        '<div class="ptx-quote-t">「' + esc(clip((item && item.quote) || "", 320)) + "」</div>" +
        '<div class="ptx-quote-a">' + nodeTag(author) + "</div>" +
      "</div>";
    }).join("") + "</div>";
  }


  /* ---------------- 词条操作（修正 / 删除 · 危险动作走二次确认） ----------------
     操作栏放在正文标题与元信息之下：修正进入就地编辑态，删除先切换为确认条，
     两条路径都不离开当前视窗，也不产生任何模态浮层。 */

  function entryActionsHtml() {
    if (state.deleteArmed) {
      return '<div class="ptx-acts is-confirm">' +
        '<span class="ptx-act-ask">确定删除此词条？</span>' +
        '<button class="ptx-btn is-danger-solid" data-action="confirm-delete-entry" type="button">确认删除</button>' +
        '<button class="ptx-btn" data-action="cancel-delete-entry" type="button">取消</button>' +
      "</div>";
    }
    return '<div class="ptx-acts">' +
      '<button class="ptx-btn" data-action="edit-entry"' + tipAttr("修正标题、状态、标签、摘要与正文") + ' type="button">' + svg("pencil", 13) + "<span>修正</span></button>" +
      '<button class="ptx-btn is-danger" data-action="delete-entry"' + tipAttr("删除该词条与其原始会话", "top") + ' type="button">' + svg("trash", 13) + "<span>删除</span></button>" +
    "</div>";
  }

  /* 可改状态：与后端 PUT 契约一致，只放 verified / tentative / open 三态 */
  var EDITOR_STATUSES = ["verified", "tentative", "open"];

  function editorHtml(detail) {
    var current = entryStatusKey(detail.status);
    if (EDITOR_STATUSES.indexOf(current) === -1) current = "open";
    var options = EDITOR_STATUSES.map(function (key) {
      return '<option value="' + key + '"' + (key === current ? " selected" : "") + ">" + esc(ENTRY_STATUS[key]) + "</option>";
    }).join("");
    var tags = Array.isArray(detail.tags) ? detail.tags.join(", ") : "";
    return '<div class="ptx-editor" data-role="entry-editor">' +
      '<label class="ptx-editor-field">' +
        '<span class="ptx-editor-label">标题</span>' +
        '<input class="ptx-input" data-role="entry-title" type="text" maxlength="200" value="' + esc(detail.title || "") + '" aria-label="词条标题">' +
      "</label>" +
      '<div class="ptx-editor-row">' +
        '<label class="ptx-editor-field is-narrow">' +
          '<span class="ptx-editor-label">状态</span>' +
          '<select class="ptx-input" data-role="entry-status" aria-label="词条状态">' + options + "</select>" +
        "</label>" +
        '<label class="ptx-editor-field">' +
          '<span class="ptx-editor-label">标签（逗号分隔）</span>' +
          '<input class="ptx-input" data-role="entry-tags" type="text" value="' + esc(tags) + '" aria-label="词条标签">' +
        "</label>" +
      "</div>" +
      '<label class="ptx-editor-field">' +
        '<span class="ptx-editor-label">摘要</span>' +
        '<textarea class="ptx-input ptx-editor-area" data-role="entry-summary" rows="3" aria-label="词条摘要">' + esc(detail.summary || "") + "</textarea>" +
      "</label>" +
      '<label class="ptx-editor-field">' +
        '<span class="ptx-editor-label">正文 Markdown</span>' +
        '<textarea class="ptx-input ptx-editor-area ptx-editor-md" data-role="entry-markdown" spellcheck="false" aria-label="词条正文 Markdown">' + esc(detail.markdown || "") + "</textarea>" +
      "</label>" +
      '<div class="ptx-editor-foot">' +
        '<button class="ptx-btn is-primary" data-action="save-entry" type="button">' + svg("check", 13) + "<span>保存修正</span></button>" +
        '<button class="ptx-btn" data-action="cancel-edit-entry" type="button">取消</button>' +
        '<span class="ptx-editor-hint">正文为 llmwiki Markdown，保存后立即重写词条与索引</span>' +
      "</div>" +
    "</div>";
  }

  /* 正文 / 摘要会随内容增高，到 CSS 上限后转为内部滚动 */
  var EDITOR_MAX_HEIGHT = 340;

  function growField(field) {
    if (!field || field.tagName !== "TEXTAREA") return;
    field.style.height = "auto";
    field.style.height = Math.min(field.scrollHeight, EDITOR_MAX_HEIGHT) + "px";
  }

  function growEditor() {
    if (!viewport) return;
    var fields = viewport.querySelectorAll('[data-role="entry-summary"], [data-role="entry-markdown"]');
    for (var i = 0; i < fields.length; i += 1) growField(fields[i]);
  }

  /* 讨论脉络正文：段落各自成 <p>；昵称变内联胶囊，「…」原话保持低调高亮。 */
  function narrativeHtml(text, mentionNames) {
    if (typeof text !== "string" || !text.trim()) return "";
    var paragraphs = text.split(/\\n\\s*\\n|\\r\\n\\s*\\r\\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    return '<div class="ptx-narrative">' + paragraphs.map(function (p) {
      return "<p>" + mentionize(p, mentionNames) + "</p>";
    }).join("") + "</div>";
  }

  function glossaryHtml(items, mentionNames) {
    if (!Array.isArray(items) || !items.length) return "";
    return '<dl class="ptx-gloss">' + items.map(function (item) {
      return '<div class="ptx-gloss-row"><dt>' + esc((item && item.term) || "") + "</dt>" +
        "<dd>" + mentionize((item && item.note) || "", mentionNames) + "</dd></div>";
    }).join("") + "</dl>";
  }

  /* 相关线索：命中索引的渲染为可点击行（序号 + 标题 + 一行摘要 + 箭头），
     未命中的降级为「未入索引」条目；超过 8 条折叠进「其余 N 条」。 */
  function relatedItemHtml(text, hit, index) {
    var no = (index + 1 < 10 ? "0" : "") + (index + 1);
    if (hit) {
      return '<button type="button" class="ptx-link" data-act="select" data-id="' + esc(hit.id) + '" title="' + esc(text) + '">' +
        '<span class="ptx-link-no">' + no + "</span>" +
        '<span class="ptx-link-main">' +
          '<span class="ptx-link-title">' + esc(text) + "</span>" +
          '<span class="ptx-link-sum">' + esc(clip(hit.summary || "", 72)) + "</span>" +
        "</span>" +
        '<span class="ptx-link-go">' + svg("chevron", 12) + "</span>" +
        "</button>";
    }
    return '<div class="ptx-link is-missing" title="' + esc(text) + '">' +
      '<span class="ptx-link-no">' + no + "</span>" +
      '<span class="ptx-link-main"><span class="ptx-link-title">' + esc(text) + "</span></span>" +
      '<span class="ptx-link-flag">未入索引</span>' +
      "</div>";
  }

  function relatedHtml(titles, entryId) {
    if (!Array.isArray(titles) || !titles.length) return "";
    var rows = titles.map(function (title, index) {
      var text = String(title == null ? "" : title).trim();
      if (!text) return "";
      var hit = null;
      /* 相关词条查找扫全量索引（state.entries 永为全量，页签过滤只影响列表渲染） */
      for (var i = 0; i < state.entries.length; i += 1) {
        if (state.entries[i] && state.entries[i].title === text) { hit = state.entries[i]; break; }
      }
      return relatedItemHtml(text, hit, index);
    }).filter(Boolean);
    if (!rows.length) return "";
    var head = rows.slice(0, 8).join("");
    var tail = rows.slice(8);
    var html = '<div class="ptx-related">' + head + "</div>";
    if (tail.length) {
      var key = "relmore:" + (entryId || "");
      html += '<details class="ptx-related-more"' + (foldOpen(key, false) ? " open" : "") +
        ' data-fold="' + esc(key) + '"><summary>其余 ' + tail.length + " 条</summary>" +
        '<div class="ptx-related">' + tail.join("") + "</div></details>";
    }
    return html;
  }

  /* 落点：已收敛 / 仍悬而未决 两列一栏；两列皆空则整栏隐藏。 */
  function outcomeHtml(detail, mentionNames) {
    var consensus = Array.isArray(detail.consensus) ? detail.consensus : [];
    var openQuestions = Array.isArray(detail.openQuestions) ? detail.openQuestions : [];
    if (!consensus.length && !openQuestions.length) return "";
    var left = consensus.length
      ? '<div class="ptx-outcome-col is-consensus"><span class="ptx-outcome-l">已收敛</span>' + mentionBullets(consensus, mentionNames) + "</div>" : "";
    var right = openQuestions.length
      ? '<div class="ptx-outcome-col is-open"><span class="ptx-outcome-l">仍悬而未决</span>' + mentionBullets(openQuestions, mentionNames) + "</div>" : "";
    return '<div class="ptx-outcome">' + left + right + "</div>";
  }

  /* ---------------- 词条正文 ---------------- */

  /* 附录：争点对照 + 摘句 收进同一个折叠区，摘要行列出内含物；两者皆空则整区消失。
     旧词条没有讨论脉络时默认展开（否则主体内容被藏进折叠区）。 */
  function appendixHtml(detail, mentionNames) {
    var points = Array.isArray(detail.debateMatrix) ? detail.debateMatrix : [];
    var quotes = Array.isArray(detail.keyQuotes) ? detail.keyQuotes : [];
    if (!points.length && !quotes.length) return "";
    var parts = [];
    if (points.length) parts.push("争点对照 " + points.length + " 个立场");
    if (quotes.length) parts.push("摘句 " + quotes.length + " 条");
    var hasNarrative = typeof detail.narrative === "string" && detail.narrative.trim() !== "";
    var key = "appendix:" + (detail.id || "");
    var inner =
      (points.length ? '<div class="ptx-app-h">争点对照</div>' + matrixHtml(detail, mentionNames) : "") +
      (quotes.length ? '<div class="ptx-app-h">摘句</div>' + quotesHtml(detail.keyQuotes) : "");
    return '<details class="ptx-appendix"' + (foldOpen(key, !hasNarrative) ? " open" : "") +
      ' data-fold="' + esc(key) + '"><summary>附录 · ' + parts.join(" · ") + "</summary>" +
      inner + "</details>";
  }

  /* 主题时间轴：左侧一条发丝竖线 + 节点圆点，每条来源词条一行——
     等宽日期 / 可点击标题（走 data-act=select）/ 一句贡献（缺省回退该条摘要）。
     没有 timeline 时回退「相关线索」列表，但小节标题仍写「时间轴」。 */
  function timelineHtml(detail, mentionNames) {
    var items = Array.isArray(detail.timeline) ? detail.timeline : [];
    if (!items.length) {
      var related = Array.isArray(detail.related) ? detail.related : [];
      if (!related.length) return '<div class="ptx-text">这条主题还没有累积来源词条。</div>';
      return relatedHtml(related, detail.id);
    }
    return '<ol class="ptx-timeline">' + items.map(function (item) {
      var entryId = String((item && item.entryId) || "").trim();
      var title = String((item && item.title) || "未命名来源词条");
      var date = String((item && item.date) || "--");
      var note = String((item && (item.contribution || item.summary)) || "");
      var titleHtml = entryId
        ? '<button type="button" class="ptx-tl-title" data-act="select" data-id="' + esc(entryId) + '"' +
          tipAttr("阅读来源词条") + ">" + esc(title) + "</button>"
        : '<span class="ptx-tl-title is-static">' + esc(title) + "</span>";
      return '<li class="ptx-tl">' +
        '<span class="ptx-tl-dot" aria-hidden="true"></span>' +
        '<div class="ptx-tl-main">' +
          '<span class="ptx-tl-date">' + esc(date) + "</span>" +
          titleHtml +
          (note ? '<p class="ptx-tl-note">' + mentionize(note, mentionNames) + "</p>" : "") +
        "</div>" +
      "</li>";
    }).join("") + "</ol>";
  }

  function panoramaHtml() {
    var backLabel = state.listStage === "topics" ? "返回主题" : "返回词条索引";
    var backBtn = '<button class="ptx-back" data-act="stage" data-stage="' + esc(state.listStage || "entries") + '"' +
      tipAttr(backLabel) + ' aria-label="' + esc(backLabel) + '">' + svg("back", 13) + "</button>";
    if (state.detailLoading) {
      return head("词条正文", "正在载入", backBtn) + dormant("正在载入", "正在读取词条正文并解析导语、脉络与结构字段。");
    }
    var detail = state.detail;
    if (!detail) {
      if (state.detailError) {
        return head("词条正文", "读取失败", backBtn) + dormant("词条读取失败", "无法读取该词条正文（" + state.detailError + "）。可返回索引重试，或点击底栏核心按钮刷新数据。");
      }
      return head("词条正文", "未选择词条", backBtn) + dormant("未选择词条", "请先在词条索引中选择一条词条，正文会在这里展开。");
    }
    var tags = Array.isArray(detail.tags) && detail.tags.length
      ? '<div class="ptx-tags">' + detail.tags.map(function (tag) {
          return '<span class="ptx-tag">' + esc(tag) + "</span>";
        }).join("") + "</div>"
      : "";
    var meta = detail.metadata || {};
    var metaStatus = isTopicEntry(detail) ? "主题" : entryStatusLabel(detail.status);
    var metaRow = '<div class="ptx-meta">' +
      "<span>日期<b>" + esc(detail.date || "--") + "</b></span>" +
      "<span>状态<b>" + esc(metaStatus) + "</b></span>" +
      "<span>群聊<b>" + esc(detail.channelId || CHANNEL) + "</b></span>" +
      "<span>消息<b>" + num(meta.messageCount) + " 条</b></span>" +
      "<span>发言人<b>" + num(meta.participantCount) + " 人</b></span></div>";
    var background = markdownSection(detail.markdown, ["背景", "background"]);
    /* 占位行（_（无额外背景信息）_）不是内容：主题同样不该在详情里显示这句空话 */
    if (/^_?（[^）]*）_?$/.test(background.replace(/\\s+/g, " ").trim())) background = "";

    if (state.editingEntryId && state.editingEntryId === detail.id) {
      return head("修正词条", detail.date || "就地编辑", backBtn) + editorHtml(detail);
    }

    var isTopic = isTopicEntry(detail);
    var narrative = typeof detail.narrative === "string" ? detail.narrative : "";
    var glossary = Array.isArray(detail.glossary) ? detail.glossary : [];
    var mentionNames = speakersOf(detail);

    /* 导语：summary 作导语；有脉络时起因收成一行小字，无脉络（旧词条）背景保留为独立小节。 */
    var lead = '<div class="ptx-sec">' +
      '<div class="ptx-lead">' + esc(detail.summary || "该词条未包含摘要") + "</div>" +
      (narrative.trim() && background
        ? '<div class="ptx-cause"><span class="ptx-cause-l">起因</span>' + mentionize(background, mentionNames) + "</div>"
        : "") +
      "</div>";

    var body = lead;
    if (!narrative.trim() && background) {
      body += section("背景", '<div class="ptx-text">' + mentionize(background, mentionNames) + "</div>");
    }
    if (narrative.trim()) {
      body += section(isTopic ? "主题综述" : "讨论脉络", narrativeHtml(narrative, mentionNames));
    }
    if (isTopic) {
      body += section("时间轴", timelineHtml(detail, mentionNames));
    }
    var outcome = outcomeHtml(detail, mentionNames);
    if (outcome) body += section("落点", outcome);
    if (glossary.length) {
      body += section("名词注", glossaryHtml(glossary, mentionNames));
    }
    var appendix = appendixHtml(detail, mentionNames);
    if (appendix) body += '<div class="ptx-sec">' + appendix + "</div>";

    return head("词条正文", detail.date || "") +
      '<div class="ptx-r-title">' + esc(detail.title || "未命名词条") + "</div>" +
      metaRow + tags +
      entryActionsHtml() +
      speakersHtml(speakersOf(detail)) +
      body;
  }

  function render() {
    if (!viewport) return;
    if (state.stage === "metrics" && viewport.querySelector('[data-traffic-summary]')) { updateMetrics(); syncTabs(); return; }
    var html;
    if (state.stage === "panorama") html = panoramaHtml();
    else if (state.stage === "metrics") html = metricsHtml();
    else if (state.stage === "settings") html = settingsHtml();
    else {
      var isTopicList = state.stage === "topics";
      html = head(isTopicList ? "主题" : "词条索引",
        "共 " + listEntries().length + (isTopicList ? " 个主题" : " 条"),
        renderViewToggle()) + sporesView();
    }

    var key = state.stage + "|" + (state.activeId || "");
    viewport.innerHTML = html;
    if (state.stage === "settings") decorateSettings();
    if (state.stage === "metrics") updateMetrics();
    if (state.editingEntryId) growEditor();
    if (key !== state.lastView) {
      viewport.scrollTop = 0;
      state.lastView = key;
    }
    syncTabs();
  }

  function syncTabs() {
    var active = state.stage === "panorama" ? state.listStage : state.stage;
    var tabs = win.querySelectorAll(".ptx-tab");
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].classList.toggle("is-active", tabs[i].getAttribute("data-stage") === active);
    }
    /* 设置页签独立于两个核心页签：进入设置时主页签全部非激活，齿轮独占激活态 */
    if (gearBtn) gearBtn.classList.toggle("is-active", active === "settings");
  }

  /* 底栏轮播：数据源是独立的 /api/latest（按最新时间排序），与词条索引的搜索 / 群聊筛选
     完全解耦；显示条数与换行间隔由面板设置驱动，改动即时生效。
     结构是双槽位交替滑入：容器内恒定只有一个 .ptx-trow.is-active，步进时下一节点从下方
     滑入、旧节点向上滑出后 400ms 直接移除——没有长轨道，也就没有首尾循环时的反向倒退
     回滚；Tab 焦点永远只落在当前唯一可见的那一条上，跳不进任何幽灵节点。 */
  function tickerWindow() {
    return Math.max(1, Math.min(state.latestEntries.length, state.settings.tickerCount));
  }

  /* 单条节点：有词条时是可直接激活的 <button>，无词条时降级为只读提示行（不带 data-act） */
  function tickerRow(entry) {
    var row = entry ? document.createElement("button") : document.createElement("div");
    row.className = "ptx-trow";
    if (entry) {
      row.setAttribute("type", "button");
      row.setAttribute("data-act", "select");
      row.setAttribute("data-id", String(entry.id));
    }
    var dot = document.createElement("span");
    dot.className = "ptx-tdot";
    var title = document.createElement("span");
    title.className = "ptx-ttitle";
    /* 无词条时的只读提示：失败 → 空 → 加载中，三者共用同一个槽位 */
    title.textContent = entry
      ? clip(entry.title || "未命名词条", 44)
      : state.latestError ? "最新词条读取失败" : state.latestLoaded ? "暂无最新词条" : "正在加载最新词条";
    row.appendChild(dot);
    row.appendChild(title);
    if (entry) {
      var date = document.createElement("span");
      date.className = "ptx-tdate";
      date.textContent = entry.date || "--";
      row.appendChild(date);
    }
    return row;
  }

  function tickerEntry(index) {
    var list = state.latestEntries.slice(0, state.settings.tickerCount);
    if (!list.length) return null;
    return list[index % list.length];
  }

  /* 重建：清空容器并落地唯一激活行（首次加载 / 数据刷新 / 设置变更 / 删除词条后调用） */
  function refreshTicker() {
    clearTimeout(state.tickerSwap);
    state.tickerSwap = null;
    if (!tickerEl) return;
    tickerEl.innerHTML = "";
    state.tickerIndex = state.latestEntries.length ? state.tickerIndex % tickerWindow() : 0;
    var row = tickerRow(tickerEntry(state.tickerIndex));
    row.classList.add("is-active");
    tickerEl.appendChild(row);
  }

  /* 步进：新节点以 .is-entering（下方 100%）追加 → 下一帧旧节点转 .is-leaving、新节点转
     .is-active → 400ms 后旧节点直接移出 DOM。build 与动画状态之间强制读一次几何，
     初始 Transform 才会成为过渡起点，滑入不会被浏览器合并成瞬间换位。 */
  function stepTicker() {
    if (!tickerEl || !state.latestEntries.length) return;
    var count = tickerWindow();
    if (count <= 1) return;
    /* 自愈：上一帧被系统吞掉（后台标签页暂停 rAF）时清掉残留的进场 / 离场节点，
       容器先回到"只有一个激活行"的不变量，再做下一次步进。 */
    var leftovers = tickerEl.querySelectorAll(".ptx-trow:not(.is-active)");
    for (var i = 0; i < leftovers.length; i += 1) {
      if (leftovers[i].parentNode) leftovers[i].parentNode.removeChild(leftovers[i]);
    }
    var current = tickerEl.querySelector(".ptx-trow.is-active");
    if (!current) {
      refreshTicker();
      return;
    }
    clearTimeout(state.tickerSwap);
    state.tickerSwap = null;
    state.tickerIndex = (state.tickerIndex + 1) % count;
    var incoming = tickerRow(tickerEntry(state.tickerIndex));
    incoming.classList.add("is-entering");
    tickerEl.appendChild(incoming);
    void incoming.offsetHeight;
    requestAnimationFrame(function () {
      if (!tickerEl || !tickerEl.contains(incoming)) return;
      current.classList.remove("is-active");
      current.classList.add("is-leaving");
      /* 离场节点退出 Tab 序列：过渡期间按 Tab 也绝不落进正在淡出的幽灵行 */
      current.setAttribute("tabindex", "-1");
      incoming.classList.remove("is-entering");
      incoming.classList.add("is-active");
      var stale = current;
      state.tickerSwap = setTimeout(function () {
        state.tickerSwap = null;
        var active = tickerEl ? tickerEl.querySelector(".ptx-trow.is-active") : null;
        if (stale === document.activeElement && active) {
          try { active.focus({ preventScroll: true }); } catch (err) { active.focus(); }
        }
        if (stale.parentNode) stale.parentNode.removeChild(stale);
      }, TICKER_SWAP_MS);
    });
  }

  function startTicker() {
    clearInterval(state.tickerTimer);
    state.tickerTimer = setInterval(function () {
      if (!document.body.contains(win) || state.collapsed) return;
      stepTicker();
    }, Math.max(TICKER_INTERVAL_MIN, state.settings.tickerInterval) * 1000);
  }

  function refreshPhase() {
    var phase = state.status ? String(state.status.phase || "IDLE") : (state.statusChecked ? "OFFLINE" : "LOADING");
    win.setAttribute("data-phase", phase);
    if (!phaseEl) return;
    phaseEl.setAttribute("data-phase", phase);
    phaseEl.setAttribute("data-tip", PHASE_TIPS[String(phase).toUpperCase()] || "状态未知");
    phaseEl.innerHTML = "<i></i><span>" + esc(phaseLabel(phase)) + "</span>";
  }

  /* ---------------- 数据 ---------------- */

  function channelScopeId() {
    if (state.channel && state.channel !== "all") return state.channel;
    /* 「全部」在服务端按单群读取时，取宿主配置里的第一个群；没有频道列表才落到兜底常量。 */
    return (state.channels && state.channels.length > 0 ? state.channels[0] : "") || CHANNEL;
  }

  function entriesUrl() {
    var params = [];
    if (state.channel !== "all") params.push("channelId=" + encodeURIComponent(state.channel));
    if (state.keyword) params.push("keyword=" + encodeURIComponent(state.keyword));
    return BASE + "/api/entries" + (params.length ? "?" + params.join("&") : "");
  }

  function channelItems() {
    return channelMenu ? Array.prototype.slice.call(channelMenu.querySelectorAll(".ptx-menu-item")) : [];
  }

  function renderChannelMenu() {
    if (!channelToggle || !channelMenu) return;
    var label = channelToggle.querySelector(".ptx-selectbtn-label");
    if (label) label.textContent = state.channel === "all" ? "全部" : "#" + state.channel;
    var options = [{ value: "all", text: "全部" }].concat(state.channels.map(function (id) {
      return { value: String(id), text: "#" + id };
    }));
    channelMenu.innerHTML = options.map(function (option) {
      return '<button type="button" class="ptx-menu-item" role="option" data-act="channel-pick" data-value="' +
        esc(option.value) + '" aria-selected="' + (option.value === state.channel ? "true" : "false") + '">' +
        esc(option.text) + "</button>";
    }).join("");
  }

  /* 高亮 = 键盘当前位置：移动高亮同时把焦点交给该项（面板里每一项都是 <button>），
     Enter / 空格由原生 button 激活，不额外拦截。 */
  function highlightChannelItem(index) {
    var items = channelItems();
    if (!items.length) return;
    var next = ((index % items.length) + items.length) % items.length;
    for (var i = 0; i < items.length; i++) items[i].classList.toggle("is-active", i === next);
    var item = items[next];
    if (item.scrollIntoView) item.scrollIntoView({ block: "nearest" });
    try { item.focus({ preventScroll: true }); } catch (err) { item.focus(); }
  }

  function openChannelMenu() {
    if (!channelToggle || !channelMenu) return;
    renderChannelMenu();
    channelMenu.hidden = false;
    channelToggle.setAttribute("aria-expanded", "true");
    if (channelChip) channelChip.classList.add("is-open");
    /* 高亮落在当前值上（'all' 恒为首项），打开即可用方向键接管 */
    highlightChannelItem(state.channel === "all" ? 0 : state.channels.indexOf(state.channel) + 1);
  }

  function closeChannelMenu(focusToggle) {
    if (!channelMenu || channelMenu.hidden) return;
    channelMenu.hidden = true;
    if (channelChip) channelChip.classList.remove("is-open");
    if (channelToggle) {
      channelToggle.setAttribute("aria-expanded", "false");
      if (focusToggle) channelToggle.focus();
    }
    var active = channelMenu.querySelector(".ptx-menu-item.is-active");
    if (active) active.classList.remove("is-active");
  }

  /* 选中：写入 state.channel 与本地记忆后沿用原 change 事件里的重新加载逻辑 */
  function pickChannel(value) {
    var next = value || "all";
    closeChannelMenu(true);
    if (next === state.channel) return;
    /* 引擎草稿按频道隔离：A 群没保存的切换选择绝不能随频道切到 B 群被误保存。 */
    engineDraft = null;
    tuneDraft = {};
    autotuneDraft = null;
    state.channel = next;
    setChannelScope(next);
    renderChannelMenu();
    state.status = null;
    trafficPoints = [];
    trafficAnchor = 0;
    var line = viewport.querySelector('.ptx-ecg-line');
    if (line) line.setAttribute('d', '');
    Promise.all([loadEntries(), loadStatus()]).then(function () {
      refreshPhase();
      render();
    });
    resetIdle();
  }

  function applyEntries(list) {
    state.entries = Array.isArray(list) ? list : [];
    if (state.activeId && !state.entries.some(function (item) { return item && item.id === state.activeId; })) {
      state.activeId = null;
      state.detail = null;
      state.detailError = "";
      state.editingEntryId = null;
      state.deleteArmed = false;
    }
    if (!state.activeId && state.entries.length) state.activeId = state.entries[0].id;
  }

  function loadChannels() {
    return getJson(BASE + "/api/channels").then(function (data) {
      var list = data && Array.isArray(data.channels) ? data.channels : [];
      state.channels = list.length ? list : DEFAULT_CHANNELS.slice();
      if (state.channel !== "all" && state.channels.indexOf(state.channel) === -1) {
        /* 记忆里的群已不存在：回落"全部"并把记忆一并纠正，避免继续用失效范围请求词条 */
        state.channel = "all";
        setChannelScope("all");
        renderChannelMenu();
        return loadEntries();
      }
      renderChannelMenu();
    }).catch(function () {
      renderChannelMenu();
    });
  }

  function loadEntries() {
    /* 请求代号：切群 / 连续输入关键词时，先发后到的响应不得覆盖后发的。 */
    var token = (state.entriesRequest = (state.entriesRequest || 0) + 1);
    return getJson(entriesUrl()).then(function (data) {
      if (token !== state.entriesRequest) return;
      applyEntries(data);
      state.entriesLoaded = true;
      state.entriesError = "";
      state.entriesFetchedAt = Date.now();
    }).catch(function (err) {
      if (token !== state.entriesRequest) return;
      /* 失败保留「最后已知良好」：把未知物化成空列表会让用户以为词条被删了。 */
      state.entriesError = err && err.message ? err.message : "网络错误";
      toast("词条索引读取失败：" + state.entriesError);
    });
  }

  /* 列表轮询：后台沉淀 / 另一管理员改名删除后，本页最多 60s 内看见。 */
  var ENTRIES_POLL_MS = 60000;
  function pollEntriesIfStale() {
    if (state.stage !== "entries") return;
    if (Date.now() - (state.entriesFetchedAt || 0) < ENTRIES_POLL_MS) return;
    loadEntries();
  }

  /* 底栏轮播的独立数据源：只取最新时间序列，不带群聊 / 关键词参数。
     失败时保留上一次序列，不打断轮播；不触发任何视图重绘（监控曲线不受影响）。 */
  function loadLatest() {
    return getJson(BASE + "/api/latest?limit=" + LATEST_LIMIT).then(function (data) {
      if (!Array.isArray(data)) throw new Error("最新词条响应格式错误");
      state.latestEntries = data;
      state.latestError = false;
      state.latestLoaded = true;
    }).catch(function () {
      state.latestLoaded = true;
      state.latestError = true;
    });
  }

  var statusRequest = 0;
  function loadStatus() {
    var request = ++statusRequest;
    var channel = channelScopeId();
    return getJson(BASE + "/api/status?channelId=" + encodeURIComponent(channel)).then(function (data) {
      if (request !== statusRequest || channel !== channelScopeId()) return;
      state.status = data;
      state.statusChecked = true;
    }).catch(function () {
      if (request !== statusRequest || channel !== channelScopeId()) return;
      state.status = null;
      state.statusChecked = true;
    });
  }

  function loadDetail(id) {
    if (!id) return Promise.resolve();
    var token = (state.detailRequest = (state.detailRequest || 0) + 1);
    state.detailLoading = true;
    render();
    return getJson(BASE + "/api/entries/" + encodeURIComponent(id)).then(function (data) {
      /* 代号 + 主键双重复核：慢/快倒挂时正文不得落到别的 activeId 名下。 */
      if (token !== state.detailRequest || !data || data.id !== id) return;
      state.detail = data;
      state.detailError = "";
    }).catch(function (err) {
      if (token !== state.detailRequest) return;
      state.detail = null;
      state.detailError = err && err.message ? err.message : "网络错误";
    }).then(function () {
      if (token === state.detailRequest) state.detailLoading = false;
    });
  }

  function ensureDetail() {
    if (!state.activeId) return Promise.resolve();
    if (state.detail && state.detail.id === state.activeId) return Promise.resolve();
    return loadDetail(state.activeId);
  }

  /* ---------------- 拖拽（视口钳制 + rAF 合并写入） ---------------- */

  var drag = { active: false, pointerId: null, startX: 0, startY: 0, left: 0, top: 0, dx: 0, dy: 0 };
  var resize = { active: false, pointerId: null, node: null, dir: "", startX: 0, startY: 0, left: 0, top: 0, width: 0, height: 0 };
  /* 8 向鼠标光标：手势期间钉在 <html> 上，边缘尚在追帧时也不会退回箭头 */
  var RESIZE_CURSORS = {
    n: "ns-resize", s: "ns-resize",
    e: "ew-resize", w: "ew-resize",
    ne: "nesw-resize", sw: "nesw-resize",
    nw: "nwse-resize", se: "nwse-resize"
  };

  function clampPosition(left, top) {
    var width = win.offsetWidth;
    var height = win.offsetHeight;
    var maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    var maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN);
    return {
      left: Math.min(Math.max(MARGIN, left), maxLeft),
      top: Math.min(Math.max(MARGIN, top), maxTop)
    };
  }

  /* 尺寸区间：下限 min(480 / 360, 视口 - 2×MARGIN)，上限即视口内缩 MARGIN 后的可用面积。
     视口比下限还小时上下限重合，窗口被压进视口——绝不抖动、绝不越界。 */
  function sizeBounds() {
    var minWidth = Math.min(MIN_WIDTH, window.innerWidth - MARGIN * 2);
    var minHeight = Math.min(MIN_HEIGHT, window.innerHeight - MARGIN * 2);
    return {
      minWidth: minWidth,
      minHeight: minHeight,
      maxWidth: Math.max(minWidth, window.innerWidth - MARGIN * 2),
      maxHeight: Math.max(minHeight, window.innerHeight - MARGIN * 2)
    };
  }

  function clampGeometry(left, top, width, height) {
    var bounds = sizeBounds();
    var nextWidth = Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth);
    var nextHeight = Math.min(Math.max(height, bounds.minHeight), bounds.maxHeight);
    return {
      left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, window.innerWidth - nextWidth - MARGIN)),
      top: Math.min(Math.max(MARGIN, top), Math.max(MARGIN, window.innerHeight - nextHeight - MARGIN)),
      width: nextWidth,
      height: nextHeight
    };
  }

  /* 按窗口宽度同步换挡类名：只有两次 classList.toggle，值未变时零成本。
     调用点是所有“宽度可能变化”的唯一入口——几何写入、最大化 / 还原、视口尺寸变化、启动。 */
  function syncWidthClass(width) {
    var w = width;
    if (w == null) w = win.offsetWidth;
    /* 宿主被 .ptx-hidden / display:none 收走时宽度是 0：此时既不换挡也不清档，
       保留上一次的档位，等真正显示出来再由 ResizeObserver 校正。 */
    if (!(w > 0)) return;
    win.classList.toggle("is-narrow", w <= NARROW_MAX);
    win.classList.toggle("is-compact", w <= COMPACT_MAX);
  }

  /* 兜底真源：宿主显隐（display:none → 可见）与 @media 改宽都不经过上面的几何写入。
     ResizeObserver 只在窗口盒子真的变化时回调，回调里读到的是已布局完成的宽度，
     不产生额外强制重排；换挡类名不改变宽度，因此不会自激。 */
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () { syncWidthClass(); }).observe(win);
  }

  /* 设备像素对齐：窗口几何必须落在整设备像素网格上。
     125% / 150% 缩放下 1 CSS px = 1.25 / 1.5 设备 px，取整到 CSS px 之后边框每移动一格都会
     在"1 行实线"与"两行各半"之间切换；合成层的 translate3d 落在半个设备像素上更会被双线性
     重采样，整窗发虚。统一对齐到 1 / dpr 网格后，静置、拖动起手、拖动落定只有一种像素形态。 */
  function snapPx(value) {
    var dpr = window.devicePixelRatio || 1;
    return Math.round(value * dpr) / dpr;
  }

  /* 布局位置（保留分数像素）：offsetLeft / offsetTop 会被取整成整数，而我们写入的 left / top
     是设备像素对齐后的分数值（如 1214.4px = 1518 整设备像素）。拿取整值当拖拽起点，位移就带上
     0.4px 偏差，合成层停在半个设备像素上被重采样：整窗发虚，紧贴宿主的顶边/竖边最先显出"撕裂"。
     computedStyle 读的是使用值，分数像素不丢；未定位（auto）时回退 offsetLeft。 */
  function layoutOffset(el) {
    try {
      var cs = window.getComputedStyle(el);
      var left = parseFloat(cs.left);
      var top = parseFloat(cs.top);
      if (isFinite(left) && isFinite(top)) return { left: left, top: top };
    } catch (err) { /* 读不到计算样式时回退整数盒 */ }
    return { left: el.offsetLeft, top: el.offsetTop };
  }

  function place(left, top) {
    var next = clampPosition(snapPx(left), snapPx(top));
    win.style.left = snapPx(next.left) + "px";
    win.style.top = snapPx(next.top) + "px";
  }

  /* 尺寸 + 位置一次性写入：几何成对更新，不会出现半途越界的中间态 */
  function applyGeometry(left, top, width, height) {
    var next = clampGeometry(snapPx(left), snapPx(top), snapPx(width), snapPx(height));
    var nextWidth = snapPx(next.width);
    win.style.width = nextWidth + "px";
    win.style.height = snapPx(next.height) + "px";
    win.style.left = snapPx(next.left) + "px";
    win.style.top = snapPx(next.top) + "px";
    /* 换挡用的就是刚刚写入的宽度，不必回读布局（无强制重排） */
    syncWidthClass(nextWidth);
  }

  function commitGeometry(next) {
    if (next.width == null) place(next.left, next.top);
    else applyGeometry(next.left, next.top, next.width, next.height);
  }

  /* 拖拽帧：只写 transform，绝不碰 left / top。
     目标位置先钳制到视口内再减起手位置，最后对齐设备像素——合成层因此永远落在整像素上，
     拖动全程零布局、零重绘，边缘的 1px 发丝线不会逐帧重算抗锯齿。 */
  function applyDrag(left, top) {
    var next = clampPosition(left, top);
    drag.dx = snapPx(next.left - drag.left);
    drag.dy = snapPx(next.top - drag.top);
    win.style.transform = "translate3d(" + drag.dx + "px, " + drag.dy + "px, 0)";
  }

  function flushPending() {
    state.rafId = 0;
    var next = state.pending;
    state.pending = null;
    if (!next) return;
    if (next.translate) applyDrag(next.left, next.top);
    else commitGeometry(next);
  }

  /* 拖拽终结：先把最终 left / top 落定，再在同一帧摘掉 transform。
     此刻 .is-dragging 仍然挂着（transition: none），两条几何写入合并成一次样式计算，
     画面直接停在终点；随后摘类只是恢复过渡，不会补间出"先回原位"的跳变。 */
  function settleDrag(final) {
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    var next = final || state.pending;
    state.pending = null;
    place(next ? next.left : drag.left + drag.dx, next ? next.top : drag.top + drag.dy);
    win.style.transform = "";
    drag.dx = 0;
    drag.dy = 0;
  }

  /* 手势终结：先撤销排队中的帧，再用终止坐标同步落定最终几何。
     调用方随后才摘除 is-dragging / is-resizing —— 材质恢复的那一帧拿到的就是最终
     几何，绝不会出现“旧 rAF 在模糊恢复后才回放上一帧尺寸”的二次跳变。 */
  function settleGesture(final) {
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    var next = final || state.pending;
    state.pending = null;
    if (next) commitGeometry(next);
  }

  function schedulePlace(left, top) {
    /* translate: 手上有拖拽时本帧走合成层搬运（applyDrag），否则是普通位置提交 */
    state.pending = { left: left, top: top, width: null, height: null, translate: drag.active };
    if (state.rafId) return;
    state.rafId = window.requestAnimationFrame(flushPending);
  }

  function scheduleGeometry(left, top, width, height) {
    state.pending = { left: left, top: top, width: width, height: height };
    if (state.rafId) return;
    state.rafId = window.requestAnimationFrame(flushPending);
  }

  function floatWindow() {
    if (MODE !== "dock" || state.floating) return;
    var rect = win.getBoundingClientRect();
    win.classList.add("is-floating");
    win.style.width = rect.width + "px";
    state.floating = true;
    state.sized = true;
    /* 行内宽度刚被冻成当前布局宽：换挡类名按这个宽度重算一次 */
    syncWidthClass(rect.width);
    place(rect.left, rect.top);
  }

  function initialPlacement() {
    if (MODE === "dock") return;
    place((window.innerWidth - win.offsetWidth) / 2, (window.innerHeight - win.offsetHeight) / 2);
  }

  /* 拖拽目标几何：pointermove 与 pointerup 共用同一套增量，终止帧不会漏掉最后几像素 */
  function dragTarget(clientX, clientY) {
    return {
      left: drag.left + (clientX - drag.startX),
      top: drag.top + (clientY - drag.startY),
      width: null,
      height: null
    };
  }

  if (handle) {
    handle.addEventListener("pointerdown", function (event) {
      /* 最大化时窗口由视口接管，拖拽整体禁用 */
      if (state.maximized) return;
      if (event.target.closest("button, input, select, textarea, a")) return;
      if (event.button != null && event.button !== 0) return;
      floatWindow();
      drag.active = true;
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      var origin = layoutOffset(win);
      drag.left = origin.left;
      drag.top = origin.top;
      drag.dx = 0;
      drag.dy = 0;
      win.classList.add("is-dragging");
      /* 起手只挂类（will-change: transform 在本类上，提升已经生效），绝不在这里写 transform：
         窗口可能正处在收回 / 展开的弹性过渡中（0.56s，transform-origin 100% 100%），此刻写
         translate3d 会把弹簧中途打断成一次硬跳。位移一律从第一帧 pointermove 才写，落点由
         settleDrag 落定。 */
      drag.pointerId = event.pointerId;
      /* 指针捕获：拖动面上的后续 move / up 全部投递到顶栏，指针飞多快都不脱手。
         捕获不可用时下面的 document 监听仍然兜底。 */
      try { handle.setPointerCapture(event.pointerId); } catch (err) { /* 指针捕获不可用时静默降级 */ }
      resetIdle();
      event.preventDefault();
    });

    /* 挂在 document 上而不是顶栏上：捕获成功后事件照样冒泡到这里，捕获失败或被浏览器
       回收时也不会因为指针离开顶栏而丢手势。pointerId 保证多指输入互不串扰。 */
    document.addEventListener("pointermove", function (event) {
      if (!drag.active || event.pointerId !== drag.pointerId) return;
      schedulePlace(drag.left + (event.clientX - drag.startX), drag.top + (event.clientY - drag.startY));
      resetIdle();
    });

    var endDrag = function (event) {
      if (!drag.active) return;
      if (event.pointerId != null && event.pointerId !== drag.pointerId) return;
      drag.active = false;
      drag.pointerId = null;
      /* 先落定最终几何（left / top）并在同一帧摘掉 transform，再摘除手势类。只有 pointerup
         的坐标可信，pointercancel / lostpointercapture 直接提交最后一帧待写几何。 */
      settleDrag(event && event.type === "pointerup" ? dragTarget(event.clientX, event.clientY) : null);
      /* 摘类推到下一帧：settleDrag 把 transform 归零时 .is-dragging 还在（transition: none），
         这一帧的样式计算落定后过渡才恢复。若在同一帧里连 transform 一起改并摘类，浏览器会
         把刚清掉的 translate3d 当成过渡起点，窗口在落点处再补间滑一下——看起来像"回弹"。 */
      window.requestAnimationFrame(function () {
        if (!drag.active && win.isConnected) win.classList.remove("is-dragging");
      });
      try { handle.releasePointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
      resetIdle();
    };

    /* up / cancel 同样挂在 document：即使指针捕获完全不可用，手势也一定在抬手时收尾，
       绝不会留下粘在 is-dragging 上的幽灵窗口。 */
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);
    handle.addEventListener("lostpointercapture", endDrag);
  }

  /* ---------------- 边缘 / 四角缩放（8 向，Pointer Events + 指针捕获 + rAF 合并写入） ----------------
     手柄完全内嵌在窗口内部（边框 8px / 四角 16×16），窗口因此保持 overflow: hidden 的
     单一硬裁剪矩形；pointerdown 立刻对被按下的手柄 setPointerCapture，指针被锁在这块
     热区上，几何每帧才追一次也绝不脱手。几何始终被钳制在 [最小尺寸, 视口内缩 MARGIN]，
     缩到下限只停止更新，绝不抖动、绝不改变边框厚度与圆角。
     dock 承载面第一次缩放与拖拽一致：先转为浮动层再缩放。 */
  win.addEventListener("pointerdown", function (event) {
    var node = event.target && event.target.closest ? event.target.closest("[data-resize]") : null;
    if (!node) return;
    /* 最大化时窗口由视口接管，缩放整体禁用；收回态手柄已退场，这里再兜一层 */
    if (state.maximized || state.collapsed) return;
    if (event.button != null && event.button !== 0) return;
    floatWindow();
    resize.active = true;
    resize.pointerId = event.pointerId;
    resize.node = node;
    resize.dir = node.getAttribute("data-resize") || "";
    resize.startX = event.clientX;
    resize.startY = event.clientY;
    var origin = layoutOffset(win);
    resize.left = origin.left;
    resize.top = origin.top;
    resize.width = win.offsetWidth;
    resize.height = win.offsetHeight;
    state.sized = true;
    win.classList.add("is-resizing");
    /* 几何每帧才追上一次指针，指针会短时落在手柄热区之外；把缩放光标钉在整页上，
       避免光标在 ew/ns-resize 与箭头之间闪动（视觉上像边缘在抖）。 */
    document.documentElement.style.cursor = RESIZE_CURSORS[resize.dir] || "nwse-resize";
    try { node.setPointerCapture(event.pointerId); } catch (err) { /* 指针捕获不可用时静默降级 */ }
    resetIdle();
    event.preventDefault();
  });

  /* 缩放目标几何：pointermove 与 pointerup 共用同一套增量，终止帧不会停在倒数第二帧的
     尺寸上。西 / 北向以对边为锚：尺寸被钳制时对边保持不动，窗口不会整体漂移。 */
  function resizeTarget(clientX, clientY) {
    var dir = resize.dir;
    var dx = clientX - resize.startX;
    var dy = clientY - resize.startY;
    var bounds = sizeBounds();
    var width = dir.indexOf("e") >= 0 ? resize.width + dx : (dir.indexOf("w") >= 0 ? resize.width - dx : resize.width);
    var height = dir.indexOf("s") >= 0 ? resize.height + dy : (dir.indexOf("n") >= 0 ? resize.height - dy : resize.height);
    var nextWidth = Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth);
    var nextHeight = Math.min(Math.max(height, bounds.minHeight), bounds.maxHeight);
    return {
      left: dir.indexOf("w") >= 0 ? resize.left + (resize.width - nextWidth) : resize.left,
      top: dir.indexOf("n") >= 0 ? resize.top + (resize.height - nextHeight) : resize.top,
      width: nextWidth,
      height: nextHeight
    };
  }

  document.addEventListener("pointermove", function (event) {
    if (!resize.active || event.pointerId !== resize.pointerId) return;
    var next = resizeTarget(event.clientX, event.clientY);
    scheduleGeometry(next.left, next.top, next.width, next.height);
    resetIdle();
  });

  function endResize(pointerId, final) {
    if (!resize.active) return;
    if (pointerId != null && pointerId !== resize.pointerId) return;
    resize.active = false;
    resize.pointerId = null;
    var node = resize.node;
    resize.node = null;
    /* 与拖拽同序：先撤销排队帧并同步落定最终几何，再摘除轻量表面 —— 恢复材质的那一帧
       尺寸已经就位，不会出现“模糊回来了而窗口还差一帧”的断裂感。 */
    settleGesture(final);
    win.classList.remove("is-resizing");
    document.documentElement.style.cursor = "";
    if (node && pointerId != null) {
      try { node.releasePointerCapture(pointerId); } catch (err) { /* 忽略 */ }
    }
    resetIdle();
  }

  document.addEventListener("pointerup", function (event) {
    if (!resize.active) return;
    endResize(event.pointerId, resizeTarget(event.clientX, event.clientY));
  });
  document.addEventListener("pointercancel", function (event) { endResize(event.pointerId, null); });
  document.addEventListener("lostpointercapture", function () { endResize(null, null); });

  window.addEventListener("resize", function () {
    /* 最大化时宽度由 is-maximized 的 inset: 12px 决定，视口变化同样要换挡 */
    if (state.maximized) { syncWidthClass(window.innerWidth - 24); return; }
    /* 拖拽进行中：位置归合成层（inline transform）所有，这里写 left / top 会与位移叠加 */
    if (drag.active) return;
    /* 未定尺寸（页面 / 停靠承载面仍由文档流决定宽度）时只钳位置；已定尺寸才夹紧视口 */
    var at = layoutOffset(win);
    if (!state.sized) { place(at.left, at.top); syncWidthClass(); return; }
    applyGeometry(at.left, at.top, win.offsetWidth, win.offsetHeight);
  });

  /* ---------------- 悬浮胶囊拖动（Pointer Events + 指针捕获 + rAF 合并写入） ----------------
     胶囊默认由 CSS 锚定 right / bottom；第一次越过 5px 阈值时把当前位置换算成 left / top
     （right / bottom 置 auto），此后位置完全由行内 left / top 驱动，只在当前会话保留，
     不落任何本地存储。拖动只切换 .is-dragging（无过渡、无 transform 形变），四边均按
     viewport 内缩 MARGIN（14px）夹紧并把胶囊自身宽高计入。
     越过阈值后的那一次 click 在 window 捕获阶段被吞掉：不展开面板、不冒泡到宿主委托；
     普通点击与键盘 Enter / Space 照常展开。胶囊只在收回态可见，拖动期间绝不自动收回。 */
  var PILL_DRAG_THRESHOLD = 5;

  var pillDrag = {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    originLeft: 0,
    originTop: 0,
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    moved: false,
    custom: false,
    rafId: 0,
    pending: null,
    suppressClick: false
  };

  function pillPlace(left, top) {
    if (!pill) return;
    /* 宽高取拖动开始时的布局盒缓存：resize 与每帧写入都不再触发强制重排 */
    if (!pillDrag.width) pillDrag.width = pill.offsetWidth;
    if (!pillDrag.height) pillDrag.height = pill.offsetHeight;
    /* 四边夹紧：四周内缩 MARGIN，胶囊自身宽高计入；视口比胶囊还小则贴住左上边，绝不越界 */
    var maxLeft = Math.max(MARGIN, window.innerWidth - pillDrag.width - MARGIN);
    var maxTop = Math.max(MARGIN, window.innerHeight - pillDrag.height - MARGIN);
    var nextLeft = Math.round(Math.min(Math.max(MARGIN, left), maxLeft));
    var nextTop = Math.round(Math.min(Math.max(MARGIN, top), maxTop));
    pill.style.left = nextLeft + "px";
    pill.style.top = nextTop + "px";
    pill.style.right = "auto";
    pill.style.bottom = "auto";
    pillDrag.left = nextLeft;
    pillDrag.top = nextTop;
    pillDrag.custom = true;
  }

  function pillFlush() {
    pillDrag.rafId = 0;
    var next = pillDrag.pending;
    pillDrag.pending = null;
    if (next) pillPlace(next.left, next.top);
  }

  function pillSchedulePlace(left, top) {
    pillDrag.pending = { left: left, top: top };
    if (pillDrag.rafId) return;
    pillDrag.rafId = window.requestAnimationFrame(pillFlush);
  }

  function endPillDrag(keepSuppress) {
    if (!pillDrag.active) return;
    pillDrag.active = false;
    var pending = pillDrag.pending;
    pillDrag.pending = null;
    if (pillDrag.rafId) {
      window.cancelAnimationFrame(pillDrag.rafId);
      pillDrag.rafId = 0;
    }
    /* 先落下最后一帧再释放捕获：pointerup 与最后一次 pointermove 之间的位移绝不丢失 */
    if (pillDrag.moved && pending) pillPlace(pending.left, pending.top);
    if (pill) pill.classList.remove("is-dragging");
    var pointerId = pillDrag.pointerId;
    pillDrag.pointerId = null;
    if (pill && pointerId != null) {
      try { pill.releasePointerCapture(pointerId); } catch (err) { /* 忽略 */ }
    }
    if (!keepSuppress) pillDrag.suppressClick = false;
    resetIdle();
  }

  if (pill) {
    pill.addEventListener("pointerdown", function (event) {
      /* 新手势开始：上一次拖动遗留的抑制标记一律作废，下一次点击绝不失灵 */
      pillDrag.suppressClick = false;
      if (event.button != null && event.button !== 0) return;
      if (event.isPrimary === false) return;
      pillDrag.active = true;
      pillDrag.pointerId = event.pointerId;
      pillDrag.startX = event.clientX;
      pillDrag.startY = event.clientY;
      pillDrag.moved = false;
      try { pill.setPointerCapture(event.pointerId); } catch (err) { /* 指针捕获不可用时静默降级 */ }
      /* 只拦冒泡（窗口拖拽 / 路由不得接管胶囊手势），不 preventDefault：保留按钮原生焦点与键盘激活 */
      event.stopPropagation();
    });

    pill.addEventListener("pointermove", function (event) {
      if (!pillDrag.active || event.pointerId !== pillDrag.pointerId) return;
      var dx = event.clientX - pillDrag.startX;
      var dy = event.clientY - pillDrag.startY;
      if (!pillDrag.moved) {
        /* 阈值内一律仍按点击处理：1–4px 的抖动不把点击变成拖动 */
        if (dx * dx + dy * dy < PILL_DRAG_THRESHOLD * PILL_DRAG_THRESHOLD) return;
        pillDrag.moved = true;
        /* 这一次手势之后的 click 必须被吞掉，绝不展开面板 */
        pillDrag.suppressClick = true;
        pill.classList.add("is-dragging");
        /* .is-dragging 已把入场动画残留的 transform 收掉，此刻读到的是真实布局盒：
           起点不从 pointerdown 的视觉矩形取，胶囊在缩放动画中被抓住也不会跳一格 */
        var box = pill.getBoundingClientRect();
        pillDrag.originLeft = box.left;
        pillDrag.originTop = box.top;
        pillDrag.left = Math.round(box.left);
        pillDrag.top = Math.round(box.top);
        pillDrag.width = box.width;
        pillDrag.height = box.height;
      }
      event.stopPropagation();
      pillSchedulePlace(pillDrag.originLeft + dx, pillDrag.originTop + dy);
      resetIdle();
    });

    pill.addEventListener("pointerup", function () { endPillDrag(true); });
    pill.addEventListener("pointercancel", function () { endPillDrag(false); });
    pill.addEventListener("lostpointercapture", function () { endPillDrag(false); });

    /* 捕获失效（元素被移出文档 / 浏览器异常）时的兜底：手势必须在文档级收尾 */
    document.addEventListener("pointerup", function () { if (pillDrag.active) endPillDrag(true); });
    document.addEventListener("pointercancel", function () { if (pillDrag.active) endPillDrag(false); });

    /* 拖动后的那一次 click：window 捕获阶段吞掉，既不展开也不冒泡到宿主委托 */
    window.addEventListener("click", function (event) {
      if (!pillDrag.suppressClick) return;
      var target = event.target;
      var onPill = target === pill || (!!target && pill.contains(target));
      /* 键盘 Enter / Space 触发的 click（detail 为 0）永不抑制；标记只对紧接拖动的指针 click 生效 */
      if (!onPill || event.detail === 0) { pillDrag.suppressClick = false; return; }
      pillDrag.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    /* 浏览器尺寸变化：自定义位置重新夹紧（默认 right / bottom 锚定由 CSS 自行负责） */
    window.addEventListener("resize", function () {
      if (!pillDrag.custom || pillDrag.active) return;
      pillPlace(pillDrag.left, pillDrag.top);
    });
  }

  /* ---------------- 自动收回（5 秒） ---------------- */

  function clearIdle() {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  function resetIdle() {
    clearIdle();
    /* 拖拽 / 缩放 / 胶囊拖动进行中绝不启动收回计时：手势未结束就收回会打断用户操作 */
    if (drag.active || resize.active || pillDrag.active) return;
    if (!state.settings.autoDock || state.collapsed) return;
    state.idleTimer = setTimeout(collapsePanel, IDLE_MS);
  }

  /* 唯一收回出口：右上角 × 与最小化、静置自动收纳都走这里。
     窗口播放缩放过渡后退场，右下的悬浮球随后接替为唯一入口。 */
  function collapsePanel() {
    if (state.collapsed) return;
    clearIdle();
    closeChannelMenu(false);
    state.collapsed = true;
    win.classList.remove("is-docked");
    win.classList.add("is-collapsed");
    setTimeout(function () {
      if (state.collapsed && pill) pill.classList.add("is-visible");
    }, 180);
    // 折叠过渡结束后再彻底隐藏（摘除 blur 层）；JS 驱动，不依赖 CSS 过渡时序
    setTimeout(function () {
      if (state.collapsed) win.classList.add("is-docked");
    }, 470);
  }

  function expandPanel() {
    clearIdle();
    state.collapsed = false;
    if (pill) pill.classList.remove("is-visible");
    // 先摘除 docked 让面板立即可见，再撤销折叠态播放展开过渡
    win.classList.remove("is-docked");
    win.classList.remove("is-collapsed");
    setTimeout(resetIdle, 80);
    loadStatus().then(function () { refreshPhase(); if (state.stage === "metrics") updateMetrics(); });
  }

  function toggleAutoDock() {
    var next = !state.settings.autoDock;
    applySettings({ autoDock: next });
    if (next) {
      resetIdle();
      toast("自动收纳：已启用");
    } else {
      clearIdle();
      toast("自动收纳：已停用");
    }
  }

  /* ---------------- 窗口状态：最大化 / 还原、最小化、关闭 ---------------- */

  function syncMaxButton() {
    var btn = win.querySelector('.ptx-topbar [data-act="maximize"]');
    if (!btn) return;
    var label = state.maximized ? "还原" : "最大化";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("data-tip", label);
    btn.setAttribute("aria-pressed", state.maximized ? "true" : "false");
  }

  /* 最大化：几何整体交给 is-maximized，进入前把行内样式整串存下，还原时原样写回。 */
  function maximizePanel() {
    if (state.maximized || state.collapsed) return;
    state.restoreStyle = win.getAttribute("style") || "";
    state.maximized = true;
    win.removeAttribute("style");
    win.classList.add("is-maximized");
    /* 最大化宽度 = 视口 - 两侧各 12px 内缩；不读布局，直接算 */
    syncWidthClass(window.innerWidth - 24);
    syncMaxButton();
    clearIdle();
  }

  function restorePanel() {
    if (!state.maximized) return;
    state.maximized = false;
    win.classList.remove("is-maximized");
    if (state.restoreStyle) win.setAttribute("style", state.restoreStyle);
    else win.removeAttribute("style");
    state.restoreStyle = "";
    syncMaxButton();
    /* 自定义尺寸原样回写；若期间视口变小，只做视口内缩钳制（尺寸仍尽可能保留） */
    if (state.sized) {
      var at = layoutOffset(win);
      applyGeometry(at.left, at.top, win.offsetWidth, win.offsetHeight);
    } else syncWidthClass();
    resetIdle();
  }

  function toggleMaximize() {
    if (state.maximized) restorePanel();
    else maximizePanel();
  }

  win.addEventListener("mouseenter", clearIdle);
  win.addEventListener("mouseleave", function () { if (!drag.active) resetIdle(); });
  /* 胶囊仅响应显式点击展开（data-act="expand"），hover 不擅自弹出，把控制权交还用户。 */

  /* ---------------- 交互 ---------------- */

  function selectEntry(id) {
    if (!id) return Promise.resolve();
    state.activeId = id;
    state.stage = "panorama";
    state.editingEntryId = null;
    state.deleteArmed = false;
    state.clearArmed = false;
    state.folds = {};
    return loadDetail(id).then(render);
  }

  /* ---------------- 词条修正 / 删除 / 知识库清空 ----------------
     所有写操作都只走 REST（PUT / DELETE / POST /api/clear），成功后先回读列表再重绘，
     因此列表、底栏轮播与详情三处显示值永远来自同一份服务端真值。 */

  function editorValue(role) {
    var field = viewport ? viewport.querySelector('[data-role="' + role + '"]') : null;
    return field ? String(field.value == null ? "" : field.value) : "";
  }

  function splitTags(raw) {
    var parts = String(raw == null ? "" : raw).split(/[,，]/);
    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      var tag = parts[i].trim();
      if (tag && out.indexOf(tag) === -1) out.push(tag);
    }
    return out;
  }

  function startEdit() {
    if (!state.detail) return;
    state.deleteArmed = false;
    state.editingEntryId = state.detail.id;
    render();
  }

  function saveEntry() {
    var id = state.editingEntryId;
    if (!id) return Promise.resolve();
    var title = editorValue("entry-title").trim();
    if (!title) { toast("标题不能为空"); return Promise.resolve(); }
    var markdown = editorValue("entry-markdown");
    if (!markdown.trim()) { toast("正文不能为空"); return Promise.resolve(); }
    var status = editorValue("entry-status").trim();
    if (EDITOR_STATUSES.indexOf(status) === -1) status = "open";
    var button = viewport ? viewport.querySelector('[data-action="save-entry"]') : null;
    if (button) button.classList.add("is-busy");
    return getJson(BASE + "/api/entries/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title,
        status: status,
        tags: splitTags(editorValue("entry-tags")),
        summary: editorValue("entry-summary").trim(),
        markdown: markdown
      })
    }).then(function (data) {
      if (data && typeof data === "object") state.detail = data;
      state.editingEntryId = null;
      state.deleteArmed = false;
      return Promise.all([loadEntries(), loadLatest()]);
    }).then(function () {
      refreshTicker();
      render();
      toast("词条已更新");
    }).catch(function (err) {
      if (button) button.classList.remove("is-busy");
      toast("词条更新失败：" + (err && err.message ? err.message : "未知错误"));
    });
  }

  function removeEntry() {
    var id = state.activeId;
    if (!id) return Promise.resolve();
    var button = viewport ? viewport.querySelector('[data-action="confirm-delete-entry"]') : null;
    if (button) button.classList.add("is-busy");
    return getJson(BASE + "/api/entries/" + encodeURIComponent(id), { method: "DELETE" }).then(function () {
      state.activeId = null;
      state.detail = null;
      state.detailError = "";
      state.editingEntryId = null;
      state.deleteArmed = false;
      state.stage = "entries";
      return Promise.all([loadEntries(), loadLatest()]);
    }).then(function () {
      /* 删除后回到索引并保持空选中：不让首条词条被自动顶替成新的当前条目 */
      state.activeId = null;
      state.detail = null;
      refreshTicker();
      render();
      toast("词条已删除");
    }).catch(function (err) {
      if (button) button.classList.remove("is-busy");
      toast("删除失败：" + (err && err.message ? err.message : "未知错误"));
    });
  }

  function clearKnowledgeBase() {
    var button = viewport ? viewport.querySelector('[data-action="confirm-clear-kb"]') : null;
    if (button) button.classList.add("is-busy");
    return getJson(BASE + "/api/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }).then(function () {
      state.entries = [];
      state.entriesLoaded = true;
      state.entriesError = "";
      state.latestEntries = [];
      state.latestLoaded = true;
      state.latestError = false;
      state.tickerIndex = 0;
      state.activeId = null;
      state.detail = null;
      state.detailError = "";
      state.editingEntryId = null;
      state.deleteArmed = false;
      state.clearArmed = false;
      return Promise.all([loadEntries(), loadLatest()]);
    }).then(function () {
      refreshTicker();
      render();
      toast("知识库已清空，保留默认骨架");
    }).catch(function (err) {
      if (button) button.classList.remove("is-busy");
      toast("清空失败：" + (err && err.message ? err.message : "未知错误"));
    });
  }

  function handleAction(action, node) {
    if (action === "edit-entry") startEdit();
    else if (action === "delete-entry") { state.deleteArmed = true; render(); }
    else if (action === "cancel-delete-entry") { state.deleteArmed = false; render(); }
    else if (action === "confirm-delete-entry") removeEntry().then(resetIdle);
    else if (action === "save-entry") saveEntry().then(resetIdle);
    else if (action === "cancel-edit-entry") { state.editingEntryId = null; render(); }
    else if (action === "clear-kb") { state.clearArmed = true; render(); }
    else if (action === "cancel-clear-kb") { state.clearArmed = false; render(); }
    else if (action === "confirm-clear-kb") clearKnowledgeBase().then(resetIdle);
    else if (action === "save-prompt") savePrompt().then(resetIdle);
    else if (action === "reset-prompt") resetPrompt().then(resetIdle);
    else if (action === "save-topic-prompt") saveTopicPrompt().then(resetIdle);
    else if (action === "reset-topic-prompt") resetTopicPrompt().then(resetIdle);
    else if (action === "save-topic-settings") saveTopicSettings().then(resetIdle);
    else if (action === "toggle-card-mask") toggleCardMask(node).then(resetIdle);
    else if (action === "toggle-section") {
      var target = node && node.getAttribute("data-target");
      if (target) {
        state.settings.collapsedSections[target] = state.settings.collapsedSections[target] !== true;
        saveSettings();
        decorateSettings();
      }
    }
    else if (action === "jump-section") {
      var jump = node && node.getAttribute("data-target");
      var section = jump && viewport ? viewport.querySelector('[data-sec="' + jump + '"]') : null;
      if (section) section.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    else if (action === "toggle-topic-enabled") {
      var topic = state.topicSettings.data;
      if (topic && topic.settings) topic.settings.enabled = topic.settings.enabled === false;
      render();
    }
  }


  /* 触发器引擎：模式选择 + 按模式分组的参数组。
     草稿保存在 engineDraft，点「保存并校准」随其余参数一起 POST /api/tune；
     三档共用 burst/quiet/minMessages，rate 组加 minBurstRate，
     potential 组加 theta/rho/densityMultiplier/peakCool/dispatchMargin，
     shadow 两组并列 + potentialAutoTuning。 */
  var engineDraft = null;
  /* 未保存的 tune 数值草稿（模式切换重渲染的存活载体）：
     键 = data-role，值 = 用户当前输入串。保存成功或频道切换后清空。 */
  var tuneDraft = {};
  /* 双判据同步调参开关的草稿：null = 未拨动（以服务端值为准），
     true/false = 用户拨过的目标态（模式往返不吞）。 */
  var autotuneDraft = null;

  function engineModeFrom(options) {
    var raw = options && options.triggerMode;
    return raw === 'potential' || raw === 'shadow' ? raw : 'rate';
  }

  function renderEngineSettings(tuneOptions) {
    var mode = engineDraft || engineModeFrom(tuneOptions);
    var current = engineModeFrom(tuneOptions);
    function modeBtn(value, label, desc) {
      return '<button type="button" class="ptx-view-btn is-text' + (mode === value ? ' is-active' : '') + '"' +
        ' data-act="engine-mode" data-mode="' + value + '" aria-pressed="' + (mode === value ? 'true' : 'false') + '"' +
        tipAttr(desc) + ' aria-label="' + label + '">' + label + '</button>';
    }
    function field(role, label, min, max, step, value, aria) {
      return '<label class="ptx-settings-row">' +
        '<span class="ptx-settings-label">' + label + '<em>' + aria + '</em></span>' +
        '<input class="ptx-input ptx-settings-num" data-role="' + role + '" type="number"' +
        ' min="' + min + '"' + (max === undefined ? '' : ' max="' + max + '"') + ' step="' + step + '" value="' + value + '" aria-label="' + label + '">' +
      '</label>';
    }
    function group(label, inner) { return '<div class="ptx-settings-note">' + label + '</div>' + inner; }
    var common =
      field('tune-burst', '突发倍率', 1, undefined, 0.1, num(tuneOptions.burstMultiplier, 2.5), '瞬时速率超过日常基线的倍数即判定为突发，下限 1。') +
      field('tune-quiet', '平息等待', 30, undefined, 30, num(tuneOptions.quiescenceSeconds, 300), '突发结束后静默多久才回到常态判定，单位秒。') +
      field('tune-min-messages', '沉淀下限', 6, 16, 1, num(tuneOptions.minDiscussionMessages, 12), '一轮讨论至少多少条消息才交给模型，硬限幅 6–16。');
    var rateGroup = field('tune-min-rate', '突发速底', 0, undefined, 0.5, num(tuneOptions.minBurstRate, 6), '速率判据的最低门槛（条/分），AIMD 会围绕它自动收紧/放宽。');
    var potGroup =
      field('tune-theta', '势能门限 Θ', 1, undefined, 1, num(tuneOptions.thetaMin, 20), '有效讨论势能 Q 的触发下限（nat），0.8.31 起线上校准值为 28。') +
      field('tune-rho', '密度下限 ρ', 0, undefined, 0.1, num(tuneOptions.rhoMin, 1.2), '每条消息的信息密度下限（nat/条），ADR-021 后只做物理拦截。') +
      field('tune-density-mult', '密度倍率', 0, 100, 0.1, num(tuneOptions.densityMultiplier, 1), 'ρ_eff = max(ρ_min, 倍率 × b_ρ)：0=只用固定下限，1=随本群量级浮动。') +
      field('tune-peak-cool', '峰值冷却', 0, 1, 0.05, num(tuneOptions.peakCoolFraction, 0.5), 'Θ_cool 抬到 max(基线, 峰值×比例)，封顶 Θ_burst×0.99；0=纯基线口径。') +
      field('tune-dispatch-margin', '质量门倍率', 0, 10, 0.1, num(tuneOptions.dispatchMargin, 0), '结算后 peakQ < Θ_burst×倍率 直接跳过云端调度；0=关闭（推荐 1.3）。');
    var autoTuneRow =
      '<div class="ptx-settings-row">' +
        '<span class="ptx-settings-label">双判据同步调参<em>shadow 对照期两引擎共用同一 AIMD；关闭则势能侧只吃时间衰减，比较天然被让子。</em></span>' +
        '<button class="ptx-switch' + ((autotuneDraft !== null ? autotuneDraft : tuneOptions.potentialAutoTuning === true) ? ' is-on' : '') + '" data-act="toggle-engine-autotune" role="switch"' +
        ' aria-checked="' + (tuneOptions.potentialAutoTuning === true ? 'true' : 'false') + '" aria-label="双判据同步调参"></button>' +
      '</div>';
    return '<div class="ptx-settings-note">当前生效：' + (current === 'rate' ? '速率引擎' : current === 'potential' ? '势能引擎' : '影子对照（rate 裁决 + 势能观测）') +
      (engineDraft && engineDraft !== current ? ' · 待保存：切换到「' + (engineDraft === 'potential' ? '势能' : engineDraft === 'shadow' ? '影子' : '速率') + '」' : '') + '</div>' +
      '<div class="ptx-view-mode" role="group" aria-label="触发器引擎">' +
      modeBtn('rate', '速率', '旧引擎：按消息速率与基线裁决，稳定但语义盲。') +
      modeBtn('potential', '势能', '新引擎：按消息信息量与密度的势能裁决，θ_min=28 已校准。') +
      modeBtn('shadow', '影子', 'rate 照常裁决 + 势能并行只观测：切换前的对照期。') +
      '</div>' +
      group('通用参数', common) +
      (mode === 'rate' ? group('速率判据', rateGroup) : '') +
      (mode === 'potential' ? group('势能判据', potGroup) : '') +
      (mode === 'shadow' ? group('速率判据（裁决方）', rateGroup) + group('势能判据（观测方）', potGroup) + autoTuneRow : '') +
      '<div class="ptx-settings-row">' +
        '<span class="ptx-settings-label">保存校准<em>按当前群聊即时热生效（含引擎切换），不重启服务，也不改动已沉淀的词条。</em></span>' +
        '<button class="ptx-btn is-primary" data-act="tune" type="button">' + svg('check', 13) + '<span>保存并校准</span></button>' +
      '</div>';
  }

  function snapshotTuneDraft() {
    if (!viewport) return;
    var fields = viewport.querySelectorAll('[data-role^="tune-"]');
    for (var i = 0; i < fields.length; i++) {
      var role = fields[i].getAttribute("data-role");
      if (role) tuneDraft[role] = fields[i].value;
    }
  }

  function tune() {
    /* 快照没到手就没有权威初值：此时输入框里只是渲染兜底值，直接提交会用兜底值
       覆盖服务端真实门限，因此宁可拒绝也不猜。 */
    if (!state.status) {
      toast("尚未取得服务端门限，暂不能校准");
      return Promise.resolve();
    }
    /* data-role → 服务端键的收集表：页面上没有的分组（模式切换后隐藏）一律跳过，
       服务端保留原值；切模式不会把旧组覆盖回去。 */
    var TUNE_FIELDS = {
      'tune-burst': 'burstMultiplier',
      'tune-quiet': 'quiescenceSeconds',
      'tune-min-messages': 'minDiscussionMessages',
      'tune-min-rate': 'minBurstRate',
      'tune-theta': 'thetaMin',
      'tune-rho': 'rhoMin',
      'tune-density-mult': 'densityMultiplier',
      'tune-peak-cool': 'peakCoolFraction',
      'tune-dispatch-margin': 'dispatchMargin'
    };
    var tuned = {};
    var invalid = false;
    for (var role in TUNE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(TUNE_FIELDS, role)) continue;
      var input = viewport ? viewport.querySelector('[data-role="' + role + '"]') : null;
      if (!input && tuneDraft[role] === undefined) continue;
      /* 草稿优先：模式切换重渲染后 DOM 里的字段是初值，用户在另一模式下敲过
         的数（该字段此刻可能根本不在页面上）仍以草稿为准。 */
      var raw = tuneDraft[role] !== undefined ? tuneDraft[role] : input.value;
      var value = Number(raw);
      if (!isFinite(value)) { invalid = true; break; }
      tuned[TUNE_FIELDS[role]] = value;
    }
    if (invalid) {
      toast("参数格式无效");
      return Promise.resolve();
    }
    var tuneOptions = (state.status && state.status.options) || {};
    var modeNow = tuneOptions.triggerMode === 'potential' || tuneOptions.triggerMode === 'shadow' ? tuneOptions.triggerMode : 'rate';
    if (engineDraft && engineDraft !== modeNow) tuned.triggerMode = engineDraft;
    if (autotuneDraft !== null) {
      tuned.potentialAutoTuning = autotuneDraft;
    } else {
      var autoTune = viewport ? viewport.querySelector('[data-act="toggle-engine-autotune"]') : null;
      if (autoTune) tuned.potentialAutoTuning = autoTune.classList.contains('is-on');
    }
    return getJson(BASE + "/api/tune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: channelScopeId(), options: tuned })
    }).then(function () {
      engineDraft = null;
      tuneDraft = {};
      autotuneDraft = null;
      return loadStatus();
    }).then(function () {
      render();
      refreshPhase();
      toast("触发器参数已校准");
    }).catch(function (err) {
      toast("参数校准失败：" + (err && err.message ? err.message : "未知错误"));
    });
  }

  /* 设置落库 + 即时生效：轮播条数 / 间隔改动立刻重排并换挡，无需刷新页面 */
  function applySettings(patch) {
    var settings = state.settings;
    if (patch.autoDock !== undefined) settings.autoDock = !!patch.autoDock;
    if (patch.tickerCount !== undefined) settings.tickerCount = clampInt(patch.tickerCount, TICKER_COUNT_MIN, TICKER_COUNT_MAX, settings.tickerCount);
    if (patch.tickerInterval !== undefined) settings.tickerInterval = clampInt(patch.tickerInterval, TICKER_INTERVAL_MIN, TICKER_INTERVAL_MAX, settings.tickerInterval);
    saveSettings();
    if (patch.tickerCount !== undefined || patch.tickerInterval !== undefined) {
      refreshTicker();
      startTicker();
    }
    syncSettingsUI();
  }

  /* 唯一刷新入口：底栏核心按钮（data-act="refresh" 仅此一处）。
     按钮常驻不随视图重绘，故 is-busy 必须自己收尾，否则刷新一次就永久转圈。 */
  function refreshAll() {
    var btn = win.querySelector('[data-act="refresh"]');
    if (btn) btn.classList.add("is-busy");
    return Promise.all([loadEntries(), loadStatus(), loadLatest()]).then(function () {
      refreshTicker();
      refreshPhase();
      render();
      toast("词条索引与监控数据已刷新");
      if (btn) btn.classList.remove("is-busy");
    });
  }

  /* 就地切换阶段：轮询随阶段换挡（监控页 5 秒）；词条正文由 selectEntry 自行载入 */
  function enterStage(next) {
    state.stage = next;
    /* 进入列表页签时记住来源：正文返回键与页签高亮都靠它指路 */
    if (next === "entries" || next === "topics") state.listStage = next;
    /* 离开正文 / 设置即丢弃未提交的编辑与二次确认态，避免跨页签残留 */
    if (next !== "panorama") {
      state.editingEntryId = null;
      state.deleteArmed = false;
    }
    if (next !== "settings") state.clearArmed = false;
    resetIdle();
    scheduleStatusPoll();
    render();
    /* 设置页打开即向服务端取一次提示词真值；返回后就地回填，不重绘整页 */
    if (next === "settings") { loadPrompt(); loadTopicSettings(); loadCardSettings(); }
  }

  host.addEventListener("click", function (event) {
    var node = event.target.closest("[data-act], [data-stage], [data-action]");
    if (!node) return;

    var action = node.getAttribute("data-action");
    if (action) {
      handleAction(action, node);
      return;
    }

    var stage = node.getAttribute("data-stage");
    if (stage && node.classList.contains("ptx-tab")) {
      enterStage(stage);
      return;
    }

    var act = node.getAttribute("data-act");
    if (!act) return;

    if (act === "select") {
      selectEntry(node.getAttribute("data-id")).then(resetIdle);
    } else if (act === "stage") {
      enterStage(stage || "entries");
    } else if (act === "refresh") {
      refreshAll().then(resetIdle);
    } else if (act === "channel-toggle") {
      if (channelMenu && !channelMenu.hidden) closeChannelMenu(false);
      else openChannelMenu();
      resetIdle();
    } else if (act === "channel-pick") {
      pickChannel(node.getAttribute("data-value"));
    } else if (act === "autodock") {
      toggleAutoDock();
    } else if (act === "view-mode") {
      setViewMode(node.getAttribute("data-mode"));
      render();
      resetIdle();
    } else if (act === "theme") {
      toggleTheme();
      resetIdle();
    } else if (act === "maximize") {
      toggleMaximize();
    } else if (act === "minimize" || act === "close") {
      /* × 与最小化同义：都只把窗口收回成悬浮球，绝不销毁阅读状态 */
      collapsePanel();
    } else if (act === "expand") {
      expandPanel();
    } else if (act === "tune") {
      tune().then(resetIdle);
    } else if (act === "engine-mode") {
      engineDraft = node.getAttribute("data-mode");
      /* 切换模式整页重渲染前，先把同页未保存的 tune 输入拍进草稿：
         tune() 提交时草稿优先，往返切换不再吞掉用户已敲的数。 */
      snapshotTuneDraft();
      render();
    } else if (act === "toggle-engine-autotune") {
      /* 拨动只进草稿，不即写服务端；同 tune 数值一起随「保存并校准」提交。 */
      var nextOn = !node.classList.contains("is-on");
      autotuneDraft = nextOn;
      node.classList.toggle("is-on", nextOn);
      node.setAttribute("aria-checked", nextOn ? "true" : "false");
    }
  });

  /* 设置视图里的数值输入：change 即落库并立刻作用于底栏轮播 */
  host.addEventListener("change", function (event) {
    var node = event.target;
    if (!node || !node.closest) return;
    var field = node.closest("[data-role]");
    if (!field) return;
    var role = field.getAttribute("data-role");
    if (role === "ticker-count") applySettings({ tickerCount: field.value });
    else if (role === "ticker-interval") applySettings({ tickerInterval: field.value });
  });

  /* <details> 的 toggle 不冒泡，捕获阶段监听即可把开合态记回 state.folds，
     下次整页重绘时用 data-fold 键恢复，不被刷新弹回默认态。 */
  host.addEventListener("toggle", function (event) {
    var node = event.target;
    if (node && node.getAttribute && node.getAttribute("data-fold")) {
      state.folds[node.getAttribute("data-fold")] = !!node.open;
    }
  }, true);

  /* 修正页的摘要 / 正文随输入增高（到上限后由 CSS 接管内部滚动） */
  host.addEventListener("input", function (event) {
    var node = event.target;
    if (!node || node.tagName !== "TEXTAREA") return;
    var role = node.getAttribute("data-role");
    if (role === "entry-summary" || role === "entry-markdown") growField(node);
  });

  /* 设置页是普通页签，不再是浮层：无需点击外部或 Esc 收起。 */
  host.addEventListener("pointermove", function (event) {
    if (drag.active) return;
    if (event.target && event.target.closest && event.target.closest(".ptx-window")) resetIdle();
  });

  host.addEventListener("wheel", function () { resetIdle(); }, { passive: true });

  /* 群聊面板键盘契约：Esc 收起并交还焦点 / ↑↓ 移动高亮 / Tab 离开即收起；
     其余按键照旧只负责重置静置计时。Enter 与空格由面板内的原生 button 自行激活。 */
  document.addEventListener("keydown", function (event) {
    if (!channelMenu || channelMenu.hidden) {
      resetIdle();
      return;
    }
    var key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      closeChannelMenu(true);
      return;
    }
    if (key === "Tab") {
      closeChannelMenu(false);
      resetIdle();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      var at = channelItems().indexOf(channelMenu.querySelector(".ptx-menu-item.is-active"));
      if (at < 0) at = key === "ArrowDown" ? -1 : 0;
      highlightChannelItem(key === "ArrowDown" ? at + 1 : at - 1);
    }
    resetIdle();
  });

  /* 点击面板外部收起：chip 内部的点击留给开合与选中处理器，不在这里抢 */
  document.addEventListener("pointerdown", function (event) {
    if (!channelMenu || channelMenu.hidden) return;
    if (channelChip && channelChip.contains(event.target)) return;
    closeChannelMenu(false);
  });

  var searchTimer = null;

  if (searchInput) {
    searchInput.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.keyword = searchInput.value.trim();
        loadEntries().then(function () { render(); });
      }, 180);
      resetIdle();
    });
  }

  /* ---------------- 启动 ---------------- */

  initialPlacement();
  /* 首次渲染前就把换挡类名定下来，窄窗口不会先按宽版排一次再跳 */
  syncWidthClass();
  /* 主题先贴合宿主当前底色（此刻节点已经在宿主文档里，读得到宿主底色），再挂观察器 */
  syncHostTheme();
  if (MODE !== "page") watchHostTheme();
  syncSettingsUI();
  /* 首次绘制前先把选项落地（loadChannels 回来后覆盖一次），下拉不存在空面板帧 */
  renderChannelMenu();
  render();
  resetIdle();
  refreshPhase();

  Promise.all([loadChannels(), loadEntries(), loadStatus(), loadLatest()]).then(function () {
    refreshTicker();
    refreshPhase();
    render();
    ensureDetail().then(function () {
      if (state.stage !== "entries") render();
    });
  });

  startTicker();

  /* 最新序列轮询：每 30 秒拉一次 /api/latest，只刷新底栏轮播，绝不重绘监控视图。 */
  setInterval(function () {
    if (!document.body.contains(win)) return;
    loadLatest().then(refreshTicker);
  }, LATEST_POLL_MS);

  /* 状态轮询：监控页 5 秒（跟随后端 5 秒采样），其余阶段 15 秒。
     自调度以便阶段切换后立即换挡，收回胶囊期间停采但不丢链。 */
  function scheduleStatusPoll() {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
    if (!document.body.contains(win)) return;
    state.statusTimer = setTimeout(function () {
      state.statusTimer = null;
      if (!document.body.contains(win)) return;
      if (state.collapsed) { scheduleStatusPoll(); return; }
      loadStatus().then(function () {
        refreshPhase();
        if (state.stage === "metrics") updateMetrics();
        pollEntriesIfStale();
        scheduleStatusPoll();
      });
    }, state.stage === "metrics" ? SERIES_POLL_MS : IDLE_POLL_MS);
  }

  scheduleStatusPoll();
})();`;
}
