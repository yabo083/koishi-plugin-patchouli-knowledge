// Patchouli Knowledge - LLMWiki 知识阅读器下属组件 (Koishi Console Client Extension)
// 挂载路径: /plugins/** (plugin-console 静态服务以 <uiPath>/@plugin-<entry>/index.js 提供)
//   挂载只看 /plugins 前缀（换实例 / 随机实例 id 都不会失去入口）；
//   页面身份（名字或标题 / 面包屑）只决定自动展开与是否弹全屏鉴权门
// 材质：瓷白 / 葱绿 · 工具级精密质感
//   - 外骨骼容器：固定圆角 14px + 四边同一条中性发丝线（--hairline-frame，底边不做单独覆盖）
//     + 单层中性双层立体影（近层贴边 3px / 远层铺开 28px，无荧光泛光、无墨绿脏边）
//   - 封底：子元素不再各自补内层圆角，四个底角统一由 .ptx-shell 的实体底色 + 单一
//     overflow 硬裁剪闭合；旧版底边那条实色亮灰发丝线会在 14px 圆角处让深线突变亮线，
//     看起来像拐角撕裂，已彻底移除
//   - 位移与裁剪分离：.ptx-window 只承担几何与 translate3d（拖拽合成层），圆角 / 边框 /
//     投影 / overflow 全部下沉到 .ptx-shell。位移层自身带圆角裁剪时，合成器要逐帧重算那圈
//     遮罩，运动中的边缘是断续的（截图拍不到，横向拖动肉眼最明显）
//   - 控件：固定几何（7px 倒角 / 28-40px 尺寸），hover / active 仅颜色、描边与阴影反馈，绝不形变
//   - 瓷白/肤白基底：--bg-porcelain #f7f5f0 → 生物膜 --bg-membrane #fffdf9（100% 不透明实体色）
//     窗口 / 左栏 / 顶栏 / 底栏四条承载面渐变全部无 alpha，.ptx-shell 另叠 background-color 遮光板，
//     浮在宿主表单之上时不透任何底层文字
//   - 窗口内无附加全窗图层（无噪点薄膜 / 场等势线）：实体底色 + 发丝线边框干净封闭，
//     避免任何 composited 描边动画溢出窗口边界造成撕裂
//   - 排版：窗内全部阶段容器共用 820px 单版心（整块居中、内部左缘严格齐平）
//   - 语义点缀：葱绿 #0ea44f / 深海青 #0e8f86 / 琥珀孢子 #b8791e
//   - 状态胶囊：中文检测器状态（就绪 / 突发采样 / 平息观察 / 沉淀生成 / 连接中断）
// 交互：视口内自由拖拽 / 边缘与四角 8 向缩放（几何钳制在视口内）/ 静置 5 秒弹性收回为悬浮胶囊 /
//       胶囊点击展开（hover 不擅自弹出）/ 两个核心页签（词条 / 监控）就地切换 / 齿轮是平级的第三个页签（设置页，非浮层）/
//       词条正文可就地修正与删除（二次确认）/ 设置页清空知识库（二次确认）/
//       rail 底部日 / 月按钮切换明暗主题（localStorage: patchouli-theme）；
//       缺省主题跟随宿主：宿主深色（class="dark" / theme-dark / data-theme="dark" / body 底色偏暗）
//       时直接以夜间渲染，优先级高于 localStorage 里残留的旧浅色记忆（仅本会话手动切换可覆盖）
// 红线：零 Emoji，100% 内联 SVG；零 window.open；零 iframe；DOM 一律文本节点安全
//       （用户内容绝不经过 innerHTML 注入）；消息媒体仅放行 http(s) 直链，
//       由浏览器自行加载，图片 / 视频 / 音频一律不自动播放
// 性能：backdrop-filter 仅用于右下角悬浮胶囊（尺寸恒定、不参与缩放）；窗口本体不采样背板，
//       缩放只做布局与轻量重绘；卡片不叠加模糊；正文小字无 text-shadow
// 拖拽：纯平移 → 起手帧提升为独立合成层（.is-dragging 的 will-change: transform），每帧只写
//       translate3d，零布局零重绘；落点同帧写 left / top 并清 transform，手势类延后一帧摘除。
//       旧版每帧写 left / top 会让整窗逐帧重排重光栅，分数 DPI 下像素相位每帧被推 1.25 / 1.5
//       设备 px，竖边 1px 发丝线与字形反复重算抗锯齿 —— 横向拖动时边缘像未开垂直同步一样抖裂。

/* global window, document, fetch, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame */

const API_BASE = '/patchouli';
/* 频道作用域兜底：留空，由宿主配置的频道列表决定（不在公开产物里硬编码任何真实群号）。 */
const CHANNEL_ID = '';
const DEFAULT_CHANNELS = [];
const IDLE_COLLAPSE_MS = 5000;
const TICKER_SWAP_MS = 400;
const TICKER_COUNT_DEFAULT = 6;
const TICKER_COUNT_MIN = 1;
const TICKER_COUNT_MAX = 20;
const TICKER_INTERVAL_DEFAULT = 5;
const TICKER_INTERVAL_MIN = 3;
const TICKER_INTERVAL_MAX = 60;
const LATEST_POLL_MS = 30000;
const LATEST_LIMIT = 20;
const SETTINGS_KEY = 'patchouli.panel-settings';
const THEME_KEY = 'patchouli-theme';
const VIEW_KEY = 'patchouli-view-mode';
const CHANNEL_SCOPE_KEY = 'patchouli-channel-scope';
/* 路由形状：console 的插件页统一挂在 `<uiPath>/<key>`（hash 路由也算），key 通常是插件名，
   多实例 / 分组时是宿主生成的随机 id。
   两次判定必须分开，否则随机实例 id 的页面连浮窗都不会出现：
   - `isPluginPage()`：**宽**——只要在某个插件的插件页上就挂载（浮窗与胶囊是只读入口，不遮宿主）；
   - `routeMatches()`：**窄**——名字认出本插件、页面身份元数据命中，或用户点开胶囊认领，才展开、
     才弹全屏鉴权门。 */
const ROUTE_SEGMENT = '/plugins/';
/* 本插件在 console 里的页面名（koishi-plugin- 前缀已去掉）；`:实例 id` 后缀同样命中。 */
const PLUGIN_ROUTE_NAMES = ['patchouli-knowledge', 'patchouli'];
/* 页面身份只认**元数据**：标题 / 面包屑 / h1 / data-*，全是宿主专为页面身份画的取样点。
   正文文本一概不读 —— 页面归属是开集问题，靠正文猜永远挡不住下一条反例（SPA 残留的旧视图、
   隐藏子树、别的插件设置表单里随口写的「知识库」…），取样越宽误认领的代价越大：
   全屏门与 /api 请求会落到别人的配置页上。随机实例 id 且元数据读不到的页面改由
   「用户点开胶囊即认领」兜底（见 expandPanel）。 */
const IDENTITY_HINTS = ['patchouli', 'llmwiki', 'llm wiki', '知识库', '知识阅读器', '大图书馆'];
/* 软校验的短发窗口（单位 = checkRoute 轮次，700ms/轮 ≈ 5.6s）：宿主 SPA 常常先挂空壳再画标题 /
   面包屑，第一轮读不到元数据不代表不是本插件页。窗口过后不再重探，避免与用户手动操作抢状态。 */
const IDENTITY_PROBE_TICKS = 8;
const ROOT_ID = 'patchouli-organic-root';
const STYLE_ID = 'patchouli-organic-style';
const PREFIX = 'ptxClient';
const VIEWPORT_MARGIN = 14;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;

const STAGES = [
  { key: 'entries', label: '词条', icon: 'entries', tip: '词条索引' },
  { key: 'topics', label: '主题', icon: 'topics', tip: '跨时间主题聚合' },
  { key: 'metrics', label: '监控', icon: 'metrics', tip: '实时监控' },
];

/* 8 向缩放手柄方向：e=右缘加宽，w=左缘（对边为锚），s=下缘，n=上缘，其余为对角双向 */
const RESIZE_DIRS = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];

/** 8 向缩放手柄：热区独立成层，完全内嵌于窗口内部（8px 厚 / 四角 16×16），
 *  因此容器可以 overflow: hidden；指针由 setPointerCapture 锁定，不靠外溢补偿。 */
function resizeLayerMarkup() {
  return `<div class="ptx-resize-layer" aria-hidden="true">` +
    RESIZE_DIRS.map((dir) => `<span class="ptx-resize is-${dir}" data-resize="${dir}"></span>`).join('') +
    `</div>`;
}

/* ------------------------------------------------------------------ *
 * 1. 内联 SVG 图标库（无字体图标、无 Emoji、无外部资源）
 * ------------------------------------------------------------------ */

const LUCIDE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"';

const ICONS = {
  nucleus: `<g ${LUCIDE}><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></g>`,
  entries: `<g ${LUCIDE}><path d="M2 6h4m-4 4h4m-4 4h4m-4 4h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9.5 8h5m-5 4H16m-6.5 4H14"/></g>`,
  matrix: `<g ${LUCIDE}><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></g>`,
  quote: `<g ${LUCIDE}><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1a6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1a6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></g>`,
  metrics: `<g ${LUCIDE}><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></g>`,
  pulse: `<g ${LUCIDE}><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676a.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/><path d="M3.22 13H9.5l.5-1l2 4.5l2-7l1.5 3.5h5.27"/></g>`,
  sync: `<g ${LUCIDE}><path d="M3 12a9 9 0 0 1 9-9a9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5m5 4a9 9 0 0 1-9 9a9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></g>`,
  autodock: `<g ${LUCIDE}><path d="M10 2h4m-2 12l3-3"/><circle cx="12" cy="14" r="8"/></g>`,
  collapse: `<g ${LUCIDE}><path d="m14 10l7-7m-1 7h-6V4M3 21l7-7m-6 0h6v6"/></g>`,
  expand: `<g ${LUCIDE}><path d="M15 3h6v6m0-6l-7 7M3 21l7-7m-1 7H3v-6"/></g>`,
  settings: `<g ${LUCIDE}><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></g>`,
  maximize: `<g ${LUCIDE}><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></g>`,
  restore: `<g ${LUCIDE}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></g>`,
  minimize: `<g ${LUCIDE}><path d="M5 12h14"/></g>`,
  close: `<g ${LUCIDE}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></g>`,
  chevron: `<g ${LUCIDE}><path d="m9 18l6-6l-6-6"/></g>`,
  chevronDown: `<g ${LUCIDE}><path d="m6 9 6 6 6-6"/></g>`,
  back: `<g ${LUCIDE}><path d="m15 18l-6-6l6-6"/></g>`,
  check: `<g ${LUCIDE}><path d="M20 6L9 17l-5-5"/></g>`,
  scope: `<g ${LUCIDE}><path d="M4 9h16M4 15h16M10 3L8 21m8-18l-2 18"/></g>`,
  find: `<g ${LUCIDE}><path d="m21 21l-4.34-4.34"/><circle cx="11" cy="11" r="8"/></g>`,
  node: `<g ${LUCIDE}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></g>`,
  spore: `<g ${LUCIDE}><path d="M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4a4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3M4 9a5 5 0 0 1 8 4a5 5 0 0 1-8-4m1 12h14"/></g>`,
  grid: `<g ${LUCIDE}><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></g>`,
  list: `<g ${LUCIDE}><path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/></g>`,
  pencil: `<g ${LUCIDE}><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></g>`,
  trash: `<g ${LUCIDE}><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></g>`,
  sun: `<g ${LUCIDE}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></g>`,
  moon: `<g ${LUCIDE}><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></g>`,
  /* Lucide layers：主题页签——长期聚合视图，与词条页的列表图标明确区分 */
  topics: `<g ${LUCIDE}><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></g>`,
};

function organicIcon(name, size = 16) {
  return `<svg class="ptx-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.nucleus}</svg>`;
}

/* ------------------------------------------------------------------ *
 * 2. 休眠胚胎细胞核（8 参数：角度 / 半径 / X 缩放 / Y 缩放 /
 *    不透明度 / 周期 / 相位延迟 / 色调）
 * ------------------------------------------------------------------ */

const STATUS_POLL_MS = 5000;
const STATUS_IDLE_POLL_MS = 15000;


const ORBIT_SEEDS = [
  { angle: 0, radius: 52, sx: 1.16, sy: 0.68, opacity: 0.72, duration: 9.4, delay: 0, tone: '#0ea44f' },
  { angle: 45, radius: 44, sx: 0.86, sy: 1.2, opacity: 0.6, duration: 11.6, delay: -1.6, tone: '#0e8f86' },
  { angle: 90, radius: 56, sx: 1.24, sy: 0.62, opacity: 0.5, duration: 13.2, delay: -3.1, tone: '#0ea44f' },
  { angle: 135, radius: 39, sx: 0.94, sy: 1.08, opacity: 0.66, duration: 10.4, delay: -4.7, tone: '#b8791e' },
  { angle: 180, radius: 49, sx: 1.1, sy: 0.78, opacity: 0.44, duration: 12.8, delay: -2.3, tone: '#0e8f86' },
  { angle: 225, radius: 58, sx: 0.8, sy: 1.14, opacity: 0.38, duration: 14.6, delay: -5.9, tone: '#0ea44f' },
  { angle: 270, radius: 42, sx: 1.02, sy: 0.9, opacity: 0.58, duration: 9.9, delay: -0.8, tone: '#b8791e' },
  { angle: 315, radius: 61, sx: 1.18, sy: 0.7, opacity: 0.34, duration: 15.4, delay: -6.8, tone: '#0e8f86' },
];

function nucleusSvg() {
  const orbs = ORBIT_SEEDS.map((seed) => {
    const vars =
      `--n-angle:${seed.angle}deg;--n-radius:${seed.radius}px;` +
      `--n-sx:${seed.sx};--n-sy:${seed.sy};--n-opacity:${seed.opacity};` +
      `--n-dur:${seed.duration}s;--n-delay:${seed.delay}s;--n-tone:${seed.tone}`;
    return `<g class="ptx-orb" style="${vars}"><ellipse cx="80" cy="80" rx="7.4" ry="5.2"/></g>`;
  }).join('');

  return (
    `<svg class="ptx-nucleus" viewBox="0 0 160 160" aria-hidden="true" focusable="false">` +
    `<defs><radialGradient id="${PREFIX}NucleusGlow" cx="50%" cy="50%" r="50%">` +
    `<stop offset="0%" stop-color="#0ea44f" stop-opacity="0.22"/>` +
    `<stop offset="58%" stop-color="#0e8f86" stop-opacity="0.08"/>` +
    `<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>` +
    `</radialGradient></defs>` +
    `<circle cx="80" cy="80" r="64" fill="url(#${PREFIX}NucleusGlow)"/>` +
    `<circle class="ptx-nucleus-membrane" cx="80" cy="80" r="54"/>` +
    `<circle class="ptx-nucleus-wall" cx="80" cy="80" r="41"/>` +
    orbs +
    `<circle class="ptx-nucleus-core" cx="80" cy="80" r="12"/>` +
    `<circle class="ptx-nucleus-seed" cx="80" cy="80" r="4.4"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ *
 * 3. 工具函数
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

function num(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : (fallback || 0);
}

function fixed(value, digits) {
  return num(value, 0).toFixed(digits == null ? 1 : digits);
}

function clip(text, limit) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (raw.length <= limit) return raw;
  return raw.slice(0, limit - 1) + '…';
}

/* 请求超时：没有它，一个挂死的连接会让 status 轮询链永久停摆（promise 永不 settle）。 */
const REQUEST_TIMEOUT_MS = 15000;
/* 非本插件页时请求被拦下的错误文案：调用方的 catch 会把它当普通失败展示。 */
const NOT_OWN_PAGE = '非本插件页：已暂停取数';
const NOT_OWN_PAGE_WRITE = '当前不在本插件页';
/* 「接口不可用」：404 / 405 / 410 与「响应不是 JSON」说明这台宿主上根本没有这套接口（插件没启用 /
   路径被反代吞掉 / 落到了静态站），和「连不上服务」（网络错误 / 5xx）是两回事：前者重连多少次都
   不会好，把用户引向网络排查是错误归因。401 不算 —— 那是会话问题，走生成块的 gate() 流程。
   连续两次才报（单次抖动不改判定）。 */
const API_UNAVAILABLE_STREAK = 2;
/* 读写的唯一物理闸口：本页标记 + 超时。
   浮窗挂在**任何** /plugins/** 页上（宿主用随机实例 id 渲染插件页时，不挂就等于用户看不到入口），
   但取数与写入都只属于本插件页 —— 别的插件页既不为其拉数据，也不许改它的设置；
   零请求也就没有 401 去弹门禁（生成块里的 401 兜底同样按本页标记判定）。
   `notify` 只给写路径用：按钮刚被按过，用户需要知道为什么没生效；读失败由各调用方展示。 */
function guardedFetch(url, options, notify) {
  if (!state.own) {
    if (notify) toast(NOT_OWN_PAGE_WRITE);
    return Promise.reject(new Error(NOT_OWN_PAGE));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, Object.assign({ credentials: 'same-origin' }, options, { signal: controller.signal }))
    .then((res) => {
      clearTimeout(timer);
      return res;
    }, (err) => {
      clearTimeout(timer);
      throw err;
    });
}

/* 读请求的失败分级：只有「404 / 405 / 410」与「响应不是 JSON」算接口不可用（见
   `API_UNAVAILABLE_STREAK`）。错误对象上带标记，供 `noteApiRead` 记账。 */
function readFailure(status) {
  const err = new Error(status ? `HTTP ${status}` : '响应不是 JSON');
  err.apiUnavailable = true;
  return err;
}

function requestJson(url, options) {
  return guardedFetch(url, options)
    .then((res) => {
      if (!res.ok) {
        const status = Number(res.status) || 0;
        /* 401 / 5xx / 网络层是「连接」问题，不在这一档 */
        if (status === 404 || status === 405 || status === 410) throw readFailure(status);
        throw new Error('HTTP ' + res.status);
      }
      /* 先取文本再解析：body 流中途被 reset 时 `res.text()` 抛的是连接层错误，
         必须走「连接中断」；只有真拿到响应体却解析不出 JSON，才算这套接口不存在。
         读 `res.json()` 会把两种失败混成一种，用户认领的页面上报「接口不可用」误导排查。 */
      if (typeof res.text !== 'function') {
        if (typeof res.json !== 'function') return res;
        return res.json().catch(() => { throw readFailure(0); });
      }
      return res.text().then((body) => {
        try { return JSON.parse(body); } catch (err) { throw readFailure(0); }
      });
    })
    .then((data) => { noteApiRead(null); return data; }, (err) => { noteApiRead(err); throw err; });
}

/* 接口可用性记账：连续命中「接口不可用」才置位；任何一次成功都清零。
   置位/清零时重画状态位 —— 监控条与胶囊说的必须是同一件事。 */
function noteApiRead(err) {
  state.apiStreak = err && err.apiUnavailable ? state.apiStreak + 1 : 0;
  const next = state.apiStreak >= API_UNAVAILABLE_STREAK;
  if (next === state.apiUnavailable) return;
  state.apiUnavailable = next;
  refreshPhase();
  if (state.stage === 'metrics') updateMetrics();
}

/* 写请求（设置 / 出图选项 / 提示词 / 词条修正与删除 / 清空知识库）一律走同一个闸口：
   非本插件页直接 reject 且**不发 fetch**。失败原因优先用服务端 body 里的 error
   —— HTTP 400 的原因只有 body 里有，状态码本身对用户没有意义。 */
function writeJson(url, method, payload) {
  const init = { method };
  if (payload !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  return guardedFetch(url, init, true).then((res) => res.json().catch(() => null).then((data) => {
    if (!res.ok || (data && data.ok === false)) {
      throw new Error(data && data.error ? String(data.error) : `HTTP ${res.status}`);
    }
    return data;
  }));
}

function tip(text, pos) {
  return `data-tip="${escapeHtml(text)}"${pos ? ` data-tip-pos="${pos}"` : ''}`;
}

function namesOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const name = typeof raw === 'string' ? raw : (raw && (raw.name || raw.userName || raw.id));
    const key = String(name == null ? '' : name).trim();
    if (key) out.push(key);
  }
  return out;
}

function uniq(list) {
  return Array.from(new Set(list));
}

function speakersOf(detail) {
  if (!detail) return [];
  let collected = namesOf(detail.participants);
  const points = Array.isArray(detail.debateMatrix) ? detail.debateMatrix : [];
  for (const point of points) {
    collected = collected.concat(namesOf(point && point.proponents));
    collected = collected.concat(namesOf(point && point.opponents));
  }
  const quotes = Array.isArray(detail.keyQuotes) ? detail.keyQuotes : [];
  for (const quote of quotes) {
    if (quote && quote.author) collected.push(String(quote.author));
  }
  return uniq(collected);
}

function nodeTag(name, tone) {
  const cls = 'ptx-node' + (tone ? ' is-' + tone : '');
  return `<span class="${cls}">${escapeHtml(name)}</span>`;
}

/* 检测器状态中文映射（与 src/web/organic-runtime.ts 同源）：OFFLINE 即与后端连接中断 */
const PHASE_LABELS = {
  LOADING: '正在连接',
  IDLE: '就绪',
  BURSTING: '突发采样',
  COOLING: '平息观察',
  SUMMARIZING: '沉淀生成',
  OFFLINE: '连接中断',
  /* 未认领本页：数据面没启动，不是「连不上」——两者混用会让用户白排查网络。 */
  UNOWNED: '当前不是本插件页',
  /* 用户点开胶囊认领的页面上接口整片不存在（404 / 非 JSON）：重连不会好，也不是断线。 */
  API_UNAVAILABLE: '接口不可用',
};

function phaseLabel(phase) {
  const key = String(phase == null ? '' : phase).trim().toUpperCase();
  return PHASE_LABELS[key] || '状态未知';
}

/* 状态提示：只说当下有意义的一句，不罗列全部状态 */
const PHASE_TIPS = {
  LOADING: '正在连接服务',
  IDLE: '等待讨论，暂无突发',
  BURSTING: '正在缓存活跃讨论',
  COOLING: '讨论已平息，等待沉淀',
  SUMMARIZING: '正在生成词条',
  OFFLINE: '无法连接服务，请检查后刷新',
  UNOWNED: '在本插件的插件页打开才取数',
  API_UNAVAILABLE: '本页没有这套接口：确认插件已启用，且 /patchouli/api 未被反代拦截',
};

/* 词条状态中文映射：后端只有 verified / tentative / open 三态 */
const ENTRY_STATUS = { verified: '已核验', tentative: '待定', open: '存疑', draft: '草稿' };

function entryStatusKey(status) {
  const key = String(status == null ? '' : status).trim().toLowerCase();
  return ENTRY_STATUS[key] ? key : 'unknown';
}

function entryStatusLabel(status) {
  return ENTRY_STATUS[entryStatusKey(status)] || '未标注';
}

/* ------------------------------------------------------------------ *
 * 4. 样式（有机未来主义；backdrop-filter 仅用于悬浮胶囊）
 * ------------------------------------------------------------------ */

const ORGANIC_STYLES = `/* ================= 宿主 ================= */
#patchouli-organic-root {
--bg-porcelain: #f7f5f0;
  --bg-membrane: #fffdf9;
  --bio-primary: #0ea44f;
  --bio-primary-strong: #2a6e3f;
  --bio-secondary: #108b96;
  --bio-cyan: #5aa4ae;
  --bio-slate: #45465e;
  --bio-violet: #7c3aed;
  --bio-violet-strong: #5b21b6;
  --bio-enzyme: #b8791e;
  --bio-danger: #c4485c;
  --bio-ink: #1b2620;
  --bio-ink-2: #36443c;
  --bio-ink-3: #4f5e56;
  --bio-ink-4: #6b7870;
  --hairline: rgba(20, 50, 34, 0.09);
  --hairline-strong: rgba(20, 50, 34, 0.14);
  /* 窗体框线：四边共用同一条中性发丝线（不含墨绿色相）。
     旧版给底边单独覆盖一条实色亮灰（#dee2e0），左 / 上 / 右是暗线、底边却是一根发光
     亮灰横线：在 14px 圆角处深线画到一半突然换成亮灰线，白窗压深色宿主时下沿两角就
     像被切断翘起。四边同色同 alpha 之后，圆角处才真正连续闭合。 */
  --hairline-frame: rgba(0, 0, 0, 0.12);
  --r-ctl: 7px;
  --r-card: 10px;
  --r-window: 14px;
  --r-pill: 999px;
  --r-tag: 5px;
  --ctl-sm: 28px;
  --ctl: 32px;
  --ctl-lg: 40px;
  --bevel-hi: inset 0 1px 0 rgba(255, 255, 255, 0.9);
  --shadow-card: 0 1px 2px rgba(20, 50, 34, 0.04);
  --shadow-float: 0 18px 40px -26px rgba(20, 50, 34, 0.34);
  /* 窗体立体影：中性双层。近层 3px 压出贴边的不透明感，远层 28px 收在窗口下方铺开；
     两层都只用中性黑，任何宿主底色上都不会渗出色相断层或墨绿脏边。 */
  --shadow-window: 0 1px 3px rgba(0, 0, 0, 0.08), 0 10px 28px -6px rgba(0, 0, 0, 0.18);
  --ease-organic: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-spring: cubic-bezier(0.34, 1.2, 0.64, 1);
  --bio-mono: "JetBrains Mono", "Cascadia Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --bio-ui: "Inter", "Segoe UI Variable Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;

  /* 承载面令牌：明暗两套主题只覆盖这一组，控件 / 卡片 / 输入框不各自持有色值。 */
  --surface: #ffffff;
  --surface-soft: #f7faf8;
  --surface-warm: #fffdf8;
  --surface-cyan: #f1f8f7;
  --surface-cyan-soft: #eef7f6;
  --surface-mint: #eff7f2;
  --surface-mint-strong: #eef7f1;
  --surface-mint-soft: #f4faf6;
  --surface-hover: #f6faf7;
  --surface-active: #eef5f0;
  --surface-raise: #fcfdfb;
  --surface-press: #f7faf7;
  --surface-track: #f2f4f1;
  --surface-amber: #fbf4e8;
  --surface-danger: #fdf2f3;
  --surface-float: #ffffff;
  --knob: #ffffff;
  --ctl-ink: #44534a;
  --ctl-ink-weak: #c2ccc5;
  --node-ink: #12703e;
  --node-support-ink: #0a7c3a;
  --amber-ink: #8a5b16;
  --tag-ink: #0b6f68;
  --brand-ink: #1d6b43;
  --topbar-ink: #2b4636;
  --danger-ink: #8f2f3d;
  --scroll-thumb: rgba(20, 50, 34, 0.16);
  --scroll-thumb-hover: rgba(20, 50, 34, 0.26);
  /* 承载面渐变一律 100% 不透明实体色：窗口压在任何宿主页面之上，带 alpha 的渐变会让
     宿主表单文字透上来（穿模），所以这四条令牌里 NEVER 出现 rgba。 */
  --win-grad: linear-gradient(168deg, #ffffff 0%, #fffdf9 52%, #fafbf6 100%);
  --rail-grad: linear-gradient(180deg, #ffffff 0%, #f4f7f2 100%);
  --topbar-grad: linear-gradient(180deg, #ffffff 0%, #f7f9f5 100%);
  --foot-grad: linear-gradient(180deg, #fbfcf9 0%, #f4f6f1 100%);
  position: fixed;
  inset: 0;
  z-index: 9990;
  pointer-events: none;
  color: var(--bio-ink);
  font-family: var(--bio-ui);
  -webkit-font-smoothing: antialiased;
  user-select: none;
}

  #patchouli-organic-root * { box-sizing: border-box; }
  #patchouli-organic-root button { font-family: inherit; }
  #patchouli-organic-root svg { display: block; }

  /* ================= 外骨骼容器（几何 / 位移层） =================
     这一层只负责几何与排版，绝不承担圆角裁剪：拖拽时它是被 translate3d 搬运的合成层，
     而「被位移的层」同时又是「带圆角的裁剪容器」时，那圈圆角裁剪必须由合成器遮罩每帧按新
     位置重新求解，边缘在帧与帧之间就是断续的——截图（强制重新光栅）拍不到，肉眼在横向拖动
     时最明显。裁剪下沉到 .ptx-shell 后，圆角边界是图层自身栅格的一部分，随层整体搬运。 */
  #patchouli-organic-root .ptx-window {
    display: flex;
    position: fixed;
    width: min(820px, calc(100vw - 48px));
    height: min(560px, calc(100vh - 120px));
    z-index: 10040;
    /* 响应式换挡不再依赖容器查询：窗口宽度每帧都由 JS 写进行内样式，
       同一处顺带维护 is-narrow / is-compact（见 syncResponsiveTier），
       省掉 container-type 建立的查询容器——它会让每次尺寸变化都重算整窗查询。 */
    transform-origin: 100% 100%;
    transition: transform 0.56s var(--ease-spring), opacity 0.34s var(--ease-organic);
  }

  /* ================= 窗面（唯一硬裁剪矩形 + 全部材质，永不位移） ================= */
  #patchouli-organic-root .ptx-shell {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    border-radius: var(--r-window);
    background:
      radial-gradient(120% 85% at 8% -12%, rgba(14, 143, 134, 0.04), transparent 56%),
      var(--win-grad);
    /* 遮光板底色：浮动窗口压在任何宿主表单之上，必须是一块 100% 不透明的实体纸面。
       background 简写会把背景色重置为 transparent，实体底色只能写在简写之后；
       渐变本身也已改为全实体色，宿主文字再也透不上来（穿模根因）。 */
    background-color: var(--surface);
    /* 不采样背板模糊：窗口背后的页面底色与膜色本就接近，blur 在视觉上几乎不可见，
       却让每次尺寸变化都要重新采样整块背板，正是缩放时“边缘断裂后重绘”的来源。 */
    border: 1px solid var(--hairline-frame);
    /* 立体投影：中性双层，近层贴边、远层铺开。
       旧版 0 24px 48px -28px rgba(20, 50, 34, 0.3) 是负外扩加 24px 位移的"悬浮假影"：
       影体整体收在窗口内侧，只有下沿外 4px 处溢出一条比深色宿主更亮的墨绿带
       （实测该处 G 通道比背景高 3、亮度高 1.5），白窗压黑底时就像下沿裂开一道脏口子。
       中性黑只会把宿主压得更暗，与任何底色都自然衔接，也没有色相断层。 */
    box-shadow: var(--shadow-window);
    /* 天然单一硬裁剪矩形：圆角裁剪由这一层自己承担，窗口内全部子层（.ptx-rail /
       .ptx-body / 内容版心）一律被这件矩形裁住，每帧都不可能再脱离边界。
       实体底色（--surface）+ 这唯一的硬裁剪已经足够闭合下沿两角，子元素不再各自补内层
       圆角——那些补丁在分数 DPI 下与父级圆角各算一次抗锯齿，反而描出双重轮廓。
       缩放手柄全部内嵌在窗口内部最上层，因此这里不再需要 overflow: visible。 */
    overflow: hidden;
  }

  /* ================= 手势态（拖拽 / 缩放） =================
     零材质重写：这两个类上不允许出现 background / backdrop-filter / box-shadow / display
     任何一条——静止、拖拽、缩放全程材质、底色、投影、裁剪矩形 100% 恒定不变。
     手势态只做三件事：关掉过渡（几何逐帧直写，不允许补间）、给出抓取光标、
     拖拽期把整窗提升成独立合成层。
     拖拽是纯平移：起手帧把整窗光栅化一次，之后每帧只由合成器搬运 translate3d，
     既不重排也不重绘。旧版每帧写 left / top，等于每帧对 820×560 的整窗（近白渐变底 +
     发丝线边框 + 双层投影 + 全部卡片文本）重排重光栅；125% / 150% 缩放下每次写进 1 CSS px
     就等于把整窗的像素相位推 1.25 / 1.5 设备 px，竖边的 1px 发丝线与全部字形每帧重算一次
     抗锯齿——拖动途中边缘就在"1 行 / 2 行"两种像素形态之间来回跳，观感等同未开垂直同步。
     横向拖动最明显：竖边是唯一被搬运、且相位敏感的 1px 线；纵向拖动时上下边沿落在投影的
     柔和斜坡里，同样的抖动看不出来。
     缩放是尺寸变化：本来就必须逐帧重新光栅，提升合成层只会多付一次全幅重光栅，故不提升。 */
  #patchouli-organic-root .ptx-window.is-dragging,
  #patchouli-organic-root .ptx-window.is-resizing { transition: none; }
  #patchouli-organic-root .ptx-window.is-dragging { cursor: grabbing; will-change: transform; }

  /* 窗口收回 / 展开：整体缩放属于容器状态变化，不是按钮形变 */
  #patchouli-organic-root .ptx-window.is-collapsed {
    transform: scale(0.14) translate(38px, 42px);
    opacity: 0;
    pointer-events: none;
  }

  /* JS 在折叠过渡结束后挂载：彻底摘除内容层，避免留下无内容的幽灵玻璃。
     窗口本体从未使用 backdrop-filter，这里只保留可见性，不写任何材质属性。 */
  #patchouli-organic-root .ptx-window.is-docked {
    visibility: hidden;
  }

  /* 最大化：page / dock / overlay 三种承载面统一覆盖为视口内缩 12px。
     !important 用于压过拖拽写入的行内 left / top / width / height，几何仍然固定无过渡形变。 */
  #patchouli-organic-root .ptx-window.is-maximized {
    position: fixed !important;
    inset: 12px !important;
    width: auto !important;
    height: auto !important;
    max-width: none !important;
    max-height: none !important;
    margin: 0 !important;
    z-index: 10040;
  }

  /* ================= 边缘 / 四角缩放手柄（8 向，完全内嵌） =================
     全部热区都在窗口内部，向内厚度 8px，四角 16×16：容器可以放心 overflow: hidden，
     手柄依然抓得住，圆角边界也不会被任何外溢元素撑破。
     每个手柄在 pointerdown 时 setPointerCapture 锁定指针（见 bindResize），指针移出
     热区甚至移出窗口也照样跟随，鼠标动得再快都不会脱手——内嵌方案不靠外溢补偿。
     唯一反馈通道是系统标准缩放光标，绝不改变边框厚度 / 圆角 / 阴影（无按钮形变契约）。 */
  #patchouli-organic-root .ptx-resize-layer {
    position: absolute;
    inset: 0;
    z-index: 60;
    pointer-events: none;
    touch-action: none;
  }
  #patchouli-organic-root .ptx-resize { position: absolute; pointer-events: auto; background: transparent; touch-action: none; }
  #patchouli-organic-root .ptx-resize.is-n { top: 0; left: 16px; right: 16px; height: 8px; cursor: ns-resize; }
  #patchouli-organic-root .ptx-resize.is-s { bottom: 0; left: 16px; right: 16px; height: 8px; cursor: ns-resize; }
  #patchouli-organic-root .ptx-resize.is-w { left: 0; top: 16px; bottom: 16px; width: 8px; cursor: ew-resize; }
  #patchouli-organic-root .ptx-resize.is-e { right: 0; top: 16px; bottom: 16px; width: 8px; cursor: ew-resize; }
  #patchouli-organic-root .ptx-resize.is-nw { top: 0; left: 0; width: 16px; height: 16px; cursor: nwse-resize; }
  #patchouli-organic-root .ptx-resize.is-ne { top: 0; right: 0; width: 16px; height: 16px; cursor: nesw-resize; }
  #patchouli-organic-root .ptx-resize.is-sw { bottom: 0; left: 0; width: 16px; height: 16px; cursor: nesw-resize; }
  #patchouli-organic-root .ptx-resize.is-se { bottom: 0; right: 0; width: 16px; height: 16px; cursor: nwse-resize; }

  /* 最大化由视口接管；收回 / 停靠隐藏态手柄整体退场，不参与命中测试 */
  #patchouli-organic-root .ptx-window.is-maximized .ptx-resize-layer,
  #patchouli-organic-root .ptx-window.is-collapsed .ptx-resize-layer,
  #patchouli-organic-root .ptx-window.is-docked .ptx-resize-layer { display: none; }

  /* ================= 内容入场：纯淡入 + 网格 stagger（无位移、无缩放） ================= */
  #patchouli-organic-root .ptx-viewport > :not(dialog) { animation: ptxFade 0.4s var(--ease-organic) backwards; }
  #patchouli-organic-root .ptx-spores > *,
  #patchouli-organic-root .ptx-points > *,
  #patchouli-organic-root .ptx-quotes > *,
  #patchouli-organic-root .ptx-tiles > *,
  #patchouli-organic-root .ptx-strip > * {
    animation: ptxFade 0.45s var(--ease-organic) backwards;
  }
  #patchouli-organic-root .ptx-spores > *:nth-child(2), #patchouli-organic-root .ptx-points > *:nth-child(2), #patchouli-organic-root .ptx-quotes > *:nth-child(2), #patchouli-organic-root .ptx-tiles > *:nth-child(2) { animation-delay: 0.04s; }
  #patchouli-organic-root .ptx-spores > *:nth-child(3), #patchouli-organic-root .ptx-points > *:nth-child(3), #patchouli-organic-root .ptx-quotes > *:nth-child(3), #patchouli-organic-root .ptx-tiles > *:nth-child(3) { animation-delay: 0.08s; }
  #patchouli-organic-root .ptx-spores > *:nth-child(4), #patchouli-organic-root .ptx-points > *:nth-child(4), #patchouli-organic-root .ptx-quotes > *:nth-child(4), #patchouli-organic-root .ptx-tiles > *:nth-child(4) { animation-delay: 0.12s; }
  #patchouli-organic-root .ptx-spores > *:nth-child(5), #patchouli-organic-root .ptx-points > *:nth-child(5), #patchouli-organic-root .ptx-quotes > *:nth-child(5), #patchouli-organic-root .ptx-tiles > *:nth-child(5) { animation-delay: 0.16s; }
  #patchouli-organic-root .ptx-spores > *:nth-child(n+6), #patchouli-organic-root .ptx-points > *:nth-child(n+6), #patchouli-organic-root .ptx-quotes > *:nth-child(n+6), #patchouli-organic-root .ptx-tiles > *:nth-child(n+6) { animation-delay: 0.2s; }

  /* ================= 左侧工具栏 ================= */
  #patchouli-organic-root .ptx-rail {
    position: relative;
    z-index: 7;
    flex: none;
    width: 62px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 14px 0 12px;
    background: var(--rail-grad);
    border-right: 1px solid var(--hairline);
    /* 左栏不再自持底角圆角：父级 .ptx-shell 的实体底色 + 单一 overflow 裁剪已经闭合
       下沿两角。子层各补一枚 calc(--r-window - 1px) 会和父级圆角各算一次抗锯齿，
       在分数 DPI 下描出双重轮廓，也正是在下沿看到的"撕裂"痕迹之一。 */
    box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.8);
  }

  #patchouli-organic-root .ptx-rail-brand {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: var(--r-card);
    color: var(--bio-primary-strong);
    background: var(--surface-mint);
    border: 1px solid rgba(14, 164, 79, 0.16);
  }

  #patchouli-organic-root .ptx-keys {
    flex: 1;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding-top: 2px;
  }

  /* 系统区：齿轮固定在侧栏底部，与导航区用 margin-top + 留白隔离。
     这里不再画 border-top：那条横线距底 70px，而底栏的 border-top 距底 52px，
     两条线一高一低在左下角形成 ~18px 的错位断阶；留白已经把齿轮与导航区分开，
     侧栏因此保持为一根连续纯净的垂直侧轨。 */
  #patchouli-organic-root .ptx-rail-foot {
    flex: none;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-top: auto;
    padding-top: 10px;
  }

  /* 齿轮页签激活态：与 .ptx-tab.is-active 同一套视觉语言（左侧葱绿指示条 + 浅绿底） */
  #patchouli-organic-root .ptx-gear.is-active {
    color: var(--bio-primary-strong);
    background: var(--surface-mint-strong);
    border-color: rgba(14, 164, 79, 0.28);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-gear.is-active::before {
    content: "";
    position: absolute;
    left: -8px;
    top: 7px;
    bottom: 7px;
    width: 2px;
    border-radius: 1px;
    background: var(--bio-primary);
  }

  /* ================= 设置页（页签化：与词条 / 监控同级，就地复用主视窗） =================
     不再是绝对定位浮层：进入设置页签后整块替换视窗内容，底栏轮播照常运行。 */
  #patchouli-organic-root .ptx-settings-page {
    display: flex;
    flex-direction: column;
  }
  #patchouli-organic-root .ptx-settings-shell {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr);
    gap: 22px;
    align-items: start;
  }
  #patchouli-organic-root .ptx-settings-outline {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 12px 2px 0;
    border-right: 1px solid var(--hairline);
  }
  #patchouli-organic-root .ptx-outline-h {
    margin-bottom: 8px;
    font-family: var(--bio-mono);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--bio-primary-strong);
  }
  #patchouli-organic-root .ptx-outline-item {
    -webkit-appearance: none;
    appearance: none;
    display: block;
    width: 100%;
    margin: 0;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    font: inherit;
    font-size: 12px;
    line-height: 1.45;
    text-align: left;
    color: var(--bio-ink-3);
    cursor: pointer;
    transition: color 0.16s var(--ease-organic), background-color 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-outline-item:hover,
  #patchouli-organic-root .ptx-outline-item:focus-visible {
    outline: none;
    color: var(--bio-primary-strong);
    background: var(--surface-mint);
  }
  #patchouli-organic-root .ptx-settings-main { min-width: 0; display: flex; flex-direction: column; }
  #patchouli-organic-root .ptx-settings-main > .ptx-sec + .ptx-sec { margin-top: 18px; }
  #patchouli-organic-root .ptx-settings-main > .ptx-sec > .ptx-sec-h { cursor: pointer; user-select: none; }
  #patchouli-organic-root .ptx-settings-main > .ptx-sec > .ptx-sec-h::before {
    content: "−";
    flex: none;
    width: 14px;
    font-family: var(--bio-mono);
    font-size: 13px;
    line-height: 1;
    color: var(--bio-primary-strong);
  }
  #patchouli-organic-root .ptx-settings-main > .ptx-sec.is-collapsed > .ptx-sec-h::before { content: "+"; }
  #patchouli-organic-root .ptx-settings-main > .ptx-sec.is-collapsed > :not(.ptx-sec-h) { display: none; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-settings-shell { grid-template-columns: 1fr; gap: 0; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-settings-outline { position: static; flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--hairline); padding: 0 0 10px; margin-bottom: 16px; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-outline-h { width: 100%; margin: 0 0 4px; }
  #patchouli-organic-root .ptx-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 46px;
    padding: 8px 12px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-settings-row + .ptx-settings-row { margin-top: 8px; }
  #patchouli-organic-root .ptx-settings-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--bio-ink-2);
  }
  #patchouli-organic-root .ptx-settings-label em {
    font-style: normal;
    font-size: 11.5px;
    font-weight: 400;
    line-height: 1.62;
    color: var(--bio-ink-4);
  }

  #patchouli-organic-root .ptx-input.ptx-settings-num { width: 84px; height: 30px; padding: 0 9px; font-size: 12.5px; text-align: right; }

  #patchouli-organic-root .ptx-settings-inline { display: inline-flex; align-items: center; gap: 6px; }
  #patchouli-organic-root .ptx-settings-sep { font-size: 12.5px; color: var(--bio-ink-4); }

  #patchouli-organic-root .ptx-settings-note {
    margin-top: 10px;
    padding: 0 2px;
    font-size: 11.5px;
    line-height: 1.62;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }

  /* 运行时参数：枚举下拉 / 文本字段 / 分组底部「其余参数」折叠 / 行内保存回执 */
  #patchouli-organic-root .ptx-input.ptx-settings-select {
    width: auto;
    min-width: 128px;
    height: 30px;
    padding: 0 8px;
    font-size: 12.5px;
    cursor: pointer;
  }
  #patchouli-organic-root .ptx-input.ptx-settings-text {
    width: 190px;
    height: 30px;
    padding: 0 9px;
    font-size: 12.5px;
  }
  #patchouli-organic-root .ptx-cfg-fold { margin-top: 10px; }
  #patchouli-organic-root .ptx-cfg-fold > summary {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 11px;
    border: 1px dashed var(--hairline);
    border-radius: var(--r-card);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--bio-ink-3);
    cursor: pointer;
    list-style: none;
  }
  #patchouli-organic-root .ptx-cfg-fold > summary::-webkit-details-marker { display: none; }
  /* 折叠箭头：复用分区标题的 13px 尺寸，展开时顺时针转 90° */
  #patchouli-organic-root .ptx-cfg-fold-arrow {
    display: inline-flex;
    flex: none;
    color: var(--bio-ink-4);
    transition: transform 0.16s var(--ease-organic), color 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-cfg-fold-arrow svg { display: block; }
  #patchouli-organic-root .ptx-cfg-fold[open] > summary .ptx-cfg-fold-arrow { transform: rotate(90deg); }
  #patchouli-organic-root .ptx-cfg-fold-title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 计数徽标：等宽小号弱色，与标题之间由 gap 留白 */
  #patchouli-organic-root .ptx-cfg-fold-count {
    margin-left: auto;
    font-family: var(--bio-mono);
    font-size: 10.5px;
    line-height: 1;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
    font-variant-numeric: tabular-nums;
  }
  #patchouli-organic-root .ptx-cfg-fold > summary:hover { color: var(--bio-primary-strong); border-color: rgba(14, 164, 79, 0.32); }
  #patchouli-organic-root .ptx-cfg-fold > summary:hover .ptx-cfg-fold-arrow { color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-cfg-fold[open] > summary { margin-bottom: 8px; }
  #patchouli-organic-root .ptx-cfg-foldbody > .ptx-settings-row + .ptx-settings-row { margin-top: 8px; }
  /* 控件位：行内回执贴在控件左侧空白处，绝对定位不参与布局，保存时其它行不位移 */
  #patchouli-organic-root .ptx-settings-ctl {
    position: relative;
    display: flex;
    align-items: center;
    flex: none;
  }
  #patchouli-organic-root .ptx-cfg-row-msg {
    position: absolute;
    right: calc(100% + 10px);
    top: 50%;
    transform: translateY(-50%);
    padding: 1px 4px;
    border-radius: var(--r-tag);
    background: var(--surface);
    font-family: var(--bio-mono);
    font-size: 10.5px;
    line-height: 1.5;
    letter-spacing: 0.01em;
    white-space: nowrap;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--bio-primary-strong);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.28s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-cfg-row-msg.is-visible { opacity: 1; }
  #patchouli-organic-root .ptx-cfg-row-msg.is-error { color: var(--bio-danger); }

  /* 知识库维护：危险操作独立成卡，柔和朱红发丝线，二次确认就地展开 */
  #patchouli-organic-root .ptx-maint {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 11px 12px;
    border-radius: var(--r-card);
    background: var(--surface-danger);
    border: 1px solid rgba(196, 72, 92, 0.2);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-maint-text { font-size: 12.5px; line-height: 1.68; color: var(--bio-ink-3); }
  #patchouli-organic-root .ptx-maint-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
  #patchouli-organic-root .ptx-maint-confirm .ptx-act-ask { flex: 1 1 180px; color: var(--danger-ink); }

  /* 系统提示词状态行：与词条修正表单共用 ptx-editor 卡片，
     只保留这一条状态文本（等宽小字，自定义生效时转向主绿）。 */
  #patchouli-organic-root .ptx-prompt-status {
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
  }
  #patchouli-organic-root .ptx-prompt-status.is-custom { color: var(--bio-primary-strong); }

  /* 开关：几何固定 34×20，仅轨道底色 / 描边与滑块位移变化 */
  #patchouli-organic-root .ptx-switch {
    position: relative;
    flex: none;
    width: 34px;
    height: 20px;
    padding: 0;
    border-radius: var(--r-pill);
    background: var(--surface-track);
    border: 1px solid var(--hairline-strong);
    cursor: pointer;
    transition: background-color 0.16s var(--ease-organic), border-color 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--knob);
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.18);
    transition: transform 0.2s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-switch.is-on { background: var(--bio-primary); border-color: #0a7c3a; }
  #patchouli-organic-root .ptx-switch.is-on::after { transform: translateX(14px); }
  #patchouli-organic-root .ptx-switch:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 2px; }

  /* ================= 控件基座：几何固定，仅颜色 / 描边 / 阴影反馈 ================= */
  #patchouli-organic-root .ptx-tab,
  #patchouli-organic-root .ptx-tool,
  #patchouli-organic-root .ptx-foot-btn,
  #patchouli-organic-root .ptx-back {
    border-radius: var(--r-ctl);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
    color: var(--ctl-ink);
    cursor: pointer;
    transition:
      color 0.16s var(--ease-organic),
      background-color 0.16s var(--ease-organic),
      border-color 0.16s var(--ease-organic),
      box-shadow 0.16s var(--ease-organic);
  }

  #patchouli-organic-root .ptx-tab:hover,
  #patchouli-organic-root .ptx-tool:hover,
  #patchouli-organic-root .ptx-foot-btn:hover,
  #patchouli-organic-root .ptx-back:hover {
    color: var(--bio-primary-strong);
    background: var(--surface-hover);
    border-color: rgba(14, 164, 79, 0.26);
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.06);
  }

  #patchouli-organic-root .ptx-tab:active,
  #patchouli-organic-root .ptx-tool:active,
  #patchouli-organic-root .ptx-foot-btn:active,
  #patchouli-organic-root .ptx-back:active {
    background: var(--surface-active);
    border-color: rgba(14, 164, 79, 0.34);
    box-shadow: inset 0 1px 2px rgba(20, 50, 34, 0.07);
  }

  #patchouli-organic-root .ptx-tab:focus-visible,
  #patchouli-organic-root .ptx-tool:focus-visible,
  #patchouli-organic-root .ptx-foot-btn:focus-visible,
  #patchouli-organic-root .ptx-back:focus-visible,
  #patchouli-organic-root .ptx-spore:focus-visible,
  #patchouli-organic-root .ptx-pill:focus-visible,
  #patchouli-organic-root .ptx-trow:focus-visible,
  #patchouli-organic-root .ptx-btn:focus-visible {
    outline: 2px solid rgba(14, 164, 79, 0.55);
    outline-offset: 2px;
  }

  /* ================= 词条操作按钮（发丝线 + 柔和朱红危险标注，几何恒定） ================= */
  #patchouli-organic-root .ptx-acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 2px 0 12px;
    padding: 8px 10px;
    border-radius: var(--r-card);
    background: var(--surface-hover);
    border: 1px solid var(--hairline);
  }
  #patchouli-organic-root .ptx-acts.is-confirm { background: var(--surface-danger); border-color: rgba(196, 72, 92, 0.24); }
  #patchouli-organic-root .ptx-act-ask { flex: 1 1 auto; min-width: 0; font-size: 12.5px; line-height: 1.6; color: var(--bio-ink-2); }
  #patchouli-organic-root .ptx-acts.is-confirm .ptx-act-ask { color: var(--danger-ink); }

  #patchouli-organic-root .ptx-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: none;
    height: var(--ctl-sm);
    padding: 0 11px;
    border-radius: var(--r-ctl);
    background: var(--surface);
    border: 1px solid var(--hairline-strong);
    box-shadow: var(--shadow-card);
    color: var(--ctl-ink);
    font-family: var(--bio-ui);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
    cursor: pointer;
    transition:
      color 0.16s var(--ease-organic),
      background-color 0.16s var(--ease-organic),
      border-color 0.16s var(--ease-organic),
      box-shadow 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-btn:hover {
    color: var(--bio-primary-strong);
    background: var(--surface-hover);
    border-color: rgba(14, 164, 79, 0.26);
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.06);
  }
  #patchouli-organic-root .ptx-btn:active { background: var(--surface-active); border-color: rgba(14, 164, 79, 0.34); box-shadow: inset 0 1px 2px rgba(20, 50, 34, 0.07); }
  #patchouli-organic-root .ptx-btn.is-primary { color: var(--bio-primary-strong); border-color: rgba(14, 164, 79, 0.3); }
  #patchouli-organic-root .ptx-btn.is-primary:hover { background: var(--bio-primary); border-color: rgba(10, 124, 58, 0.6); color: #ffffff; }
  #patchouli-organic-root .ptx-btn.is-danger { color: var(--bio-danger); border-color: rgba(196, 72, 92, 0.32); }
  #patchouli-organic-root .ptx-btn.is-danger:hover { color: var(--bio-danger); background: var(--surface-danger); border-color: rgba(196, 72, 92, 0.48); }
  #patchouli-organic-root .ptx-btn.is-danger-solid { color: #ffffff; background: var(--bio-danger); border-color: rgba(168, 58, 76, 0.9); }
  #patchouli-organic-root .ptx-btn.is-danger-solid:hover { color: #ffffff; background: #b03d50; border-color: #97364a; }
  #patchouli-organic-root .ptx-btn.is-danger-solid:active { background: #a83a4c; }
  #patchouli-organic-root .ptx-btn.is-busy { opacity: 0.56; pointer-events: none; }

  /* 明暗主题切换：rail 底部与齿轮并列，日 / 月图标只由 .is-dark 切换显隐，不产生形变 */
  #patchouli-organic-root .ptx-theme .ptx-ico-sun { display: none; }
  #patchouli-organic-root .ptx-theme .ptx-ico-moon { display: block; }

  #patchouli-organic-root .ptx-tab {
    position: relative;
    width: var(--ctl-lg);
    height: var(--ctl-lg);
    display: grid;
    place-items: center;
    padding: 0;
  }

  #patchouli-organic-root .ptx-tab::before {
    content: "";
    position: absolute;
    left: -7px;
    top: 10px;
    bottom: 10px;
    width: 2px;
    border-radius: 1px;
    background: var(--bio-primary);
    opacity: 0;
    transition: opacity 0.16s var(--ease-organic);
  }

  #patchouli-organic-root .ptx-tab.is-active {
    color: var(--bio-primary-strong);
    background: var(--surface-mint-strong);
    border-color: rgba(14, 164, 79, 0.28);
    box-shadow: var(--shadow-card);
  }

  #patchouli-organic-root .ptx-tab.is-active::before { opacity: 1; }

  /* ================= 主体 ================= */
  /* 右列恢复标准 flex 列布局：圆角与裁剪一律由 .ptx-shell 自己承担，这里不再下沉圆角 */
  #patchouli-organic-root .ptx-body {
    position: relative;
    z-index: 6;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  #patchouli-organic-root .ptx-topbar {
    flex: none;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 12px 0 14px;
    background: var(--topbar-grad);
    border-bottom: 1px solid var(--hairline);
    cursor: grab;
    /* 触控 / 触媒指针下不让浏览器把拖动解释成滚动或手势取消，pointer capture 才不会被收回 */
    touch-action: none;
  }

  #patchouli-organic-root .ptx-window.is-dragging .ptx-topbar { cursor: grabbing; }

  #patchouli-organic-root .ptx-id { display: flex; align-items: center; gap: 8px; min-width: 0; }
  #patchouli-organic-root .ptx-id-glyph { color: var(--bio-primary-strong); opacity: 0.92; }
  #patchouli-organic-root .ptx-id-code {
    font-family: var(--bio-mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--topbar-ink);
  }
  #patchouli-organic-root .ptx-id-sep { width: 1px; height: 12px; background: var(--hairline-strong); }

  /* 顶栏状态徽标：语义色 + 单点，无装饰斜杠、无呼吸缩放。
     它必须是 <button>（点击跳转监控页签）：顶栏是拖拽手柄，守卫只放行
     button/input/select/textarea/a，span 的点击会被拖拽吞掉。故先抹平 UA 按钮外观
     （appearance / font / margin 归零），border / background / padding 全部按胶囊规格
     显式重声明，观感与原来的 span 完全一致。 */
  #patchouli-organic-root .ptx-phase {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    margin: 0;
    padding: 0 9px 0 8px;
    border-radius: var(--r-pill);
    font: inherit;
    font-family: var(--bio-mono);
    font-size: 11px;
    line-height: 1;
    letter-spacing: 0.02em;
    color: var(--brand-ink);
    background: var(--surface-mint);
    border: 1px solid rgba(14, 164, 79, 0.2);
    white-space: nowrap;
    cursor: pointer;
    transition: border-color 0.16s var(--ease-organic);
  }

  #patchouli-organic-root .ptx-phase i {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--bio-primary);
  }

  #patchouli-organic-root .ptx-phase[data-phase="BURSTING"] { color: var(--danger-ink); background: var(--surface-danger); border-color: rgba(196, 72, 92, 0.28); }
  #patchouli-organic-root .ptx-phase[data-phase="BURSTING"] i { background: var(--bio-danger); }
  #patchouli-organic-root .ptx-phase[data-phase="COOLING"] { color: var(--amber-ink); background: var(--surface-amber); border-color: rgba(184, 121, 30, 0.28); }
  #patchouli-organic-root .ptx-phase[data-phase="COOLING"] i { background: var(--bio-enzyme); }
  #patchouli-organic-root .ptx-phase[data-phase="SUMMARIZING"] { color: var(--tag-ink); background: var(--surface-cyan-soft); border-color: rgba(14, 143, 134, 0.26); }
  #patchouli-organic-root .ptx-phase[data-phase="SUMMARIZING"] i { background: var(--bio-secondary); }
  #patchouli-organic-root .ptx-phase[data-phase="LOADING"] { color: var(--bio-ink-3); background: var(--surface-track); border-color: var(--hairline-strong); }
  #patchouli-organic-root .ptx-phase[data-phase="LOADING"] i { background: var(--bio-ink-4); animation: ptxPhasePulse 2.6s var(--ease-organic) infinite; }
  /* 未认领本页：中性态（不是故障），与 OFFLINE 的警示红明确区分 */
  #patchouli-organic-root .ptx-phase[data-phase="UNOWNED"] { color: var(--bio-ink-3); background: var(--surface-track); border-color: var(--hairline-strong); }
  #patchouli-organic-root .ptx-phase[data-phase="UNOWNED"] i { background: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-phase[data-phase="OFFLINE"] { color: var(--danger-ink); background: var(--surface-danger); border-color: rgba(196, 72, 92, 0.24); }
  #patchouli-organic-root .ptx-phase[data-phase="OFFLINE"] i { background: var(--bio-danger); }

  /* 可点击反馈：只加深描边（各相位用自己的语义色阶），底色与呼吸点一律不动 */
  #patchouli-organic-root .ptx-phase:hover { border-color: rgba(14, 164, 79, 0.36); }
  #patchouli-organic-root .ptx-phase[data-phase="LOADING"]:hover,
  #patchouli-organic-root .ptx-phase[data-phase="UNOWNED"]:hover { border-color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-phase[data-phase="BURSTING"]:hover,
  #patchouli-organic-root .ptx-phase[data-phase="OFFLINE"]:hover { border-color: rgba(196, 72, 92, 0.46); }
  #patchouli-organic-root .ptx-phase[data-phase="COOLING"]:hover { border-color: rgba(184, 121, 30, 0.46); }
  #patchouli-organic-root .ptx-phase[data-phase="SUMMARIZING"]:hover { border-color: rgba(14, 143, 134, 0.44); }
  #patchouli-organic-root .ptx-phase:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 2px; }

  #patchouli-organic-root .ptx-tools { display: flex; align-items: center; gap: 6px; }

  #patchouli-organic-root .ptx-tool { position: relative; width: var(--ctl); height: var(--ctl); display: grid; place-items: center; padding: 0; }
  #patchouli-organic-root .ptx-tool.is-on { color: var(--bio-primary-strong); background: var(--surface-mint); border-color: rgba(14, 164, 79, 0.26); }
  #patchouli-organic-root .ptx-tool.is-busy svg { animation: ptxSpin 0.9s linear infinite; }

  /* 常规三窗口按钮：固定圆角 28px，hover / active 仅明度与描边变化，绝不形变 */
  #patchouli-organic-root .ptx-winctl {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 2px;
    padding-left: 10px;
    border-left: 1px solid var(--hairline);
  }
  #patchouli-organic-root .ptx-winctl-btn {
    width: var(--ctl-sm);
    height: var(--ctl-sm);
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: var(--r-ctl);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
    color: var(--ctl-ink);
    cursor: pointer;
    transition:
      color 0.16s var(--ease-organic),
      background-color 0.16s var(--ease-organic),
      border-color 0.16s var(--ease-organic),
      box-shadow 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-winctl-btn:hover {
    color: var(--bio-primary-strong);
    background: var(--surface-hover);
    border-color: rgba(14, 164, 79, 0.26);
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.06);
  }
  #patchouli-organic-root .ptx-winctl-btn:active {
    background: var(--surface-active);
    border-color: rgba(14, 164, 79, 0.34);
    box-shadow: inset 0 1px 2px rgba(20, 50, 34, 0.07);
  }
  #patchouli-organic-root .ptx-winctl-btn:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 2px; }
  #patchouli-organic-root .ptx-winctl-btn.is-close:hover { color: #ffffff; background: var(--bio-danger); border-color: #a83a4c; box-shadow: 0 1px 2px rgba(196, 72, 92, 0.24); }
  #patchouli-organic-root .ptx-winctl-btn.is-close:active { background: #b03c4e; border-color: #93333f; color: #ffffff; }

  /* 最大化 / 还原图标按窗口状态纯 CSS 互换 */
  #patchouli-organic-root .ptx-ico-restore { display: none; }
  #patchouli-organic-root .ptx-window.is-maximized .ptx-ico-max { display: none; }
  #patchouli-organic-root .ptx-window.is-maximized .ptx-ico-restore { display: grid; place-items: center; }

  /* 筛选控件 */
  #patchouli-organic-root .ptx-filter { display: flex; align-items: center; gap: 6px; }
  #patchouli-organic-root .ptx-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--ctl);
    padding: 0 9px;
    border-radius: var(--r-ctl);
    background: var(--surface);
    border: 1px solid var(--hairline);
    color: var(--ctl-ink);
    cursor: default;
    transition: border-color 0.16s var(--ease-organic), background-color 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-chip:focus-within { border-color: rgba(14, 164, 79, 0.4); background: var(--surface-hover); }
  #patchouli-organic-root .ptx-chip > svg { flex: none; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-selectbtn,
  #patchouli-organic-root .ptx-find {
    height: 26px;
    border: 0;
    background: transparent;
    color: var(--ctl-ink);
    font-family: var(--bio-mono);
    font-size: 12px;
    letter-spacing: 0.01em;
    outline: none;
  }
  #patchouli-organic-root .ptx-find { width: 112px; }
  #patchouli-organic-root .ptx-find::placeholder { color: var(--bio-ink-4); letter-spacing: 0.02em; }
  #patchouli-organic-root .ptx-find::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }

  /* 群聊范围：自绘 listbox。原生 select 展开后是系统弹层（深色矩形 + 系统蓝高亮条），
     与纸面材质完全冲突，故整块自绘：chip 里只留一个开合按钮 + 一层面板。 */
  #patchouli-organic-root .ptx-channel { position: relative; padding-right: 7px; }
  #patchouli-organic-root .ptx-channel.is-open { border-color: rgba(14, 164, 79, 0.4); background: var(--surface-hover); }
  #patchouli-organic-root .ptx-selectbtn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    cursor: pointer;
    transition: color 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-selectbtn-label { max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #patchouli-organic-root .ptx-selectbtn:hover { color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-selectbtn > svg { flex: none; color: var(--bio-ink-4); transition: transform 0.18s var(--ease-organic); }
  #patchouli-organic-root .ptx-channel.is-open .ptx-selectbtn > svg { transform: rotate(180deg); }
  #patchouli-organic-root .ptx-selectbtn:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 2px; border-radius: var(--r-tag); }

  /* 面板绝对定位在 chip 正下方：右缘对齐、不窄于 chip，内部滚动上限 236px。
     right / min-width 抵掉 chip 的 1px 边框与 7px 右内边距（100% 量的是 padding box），
     面板因此与 chip 外缘等宽或更宽；z-index 高于顶栏内容，仍在 .ptx-body 自己的
     层叠上下文与裁剪矩形内。 */
  #patchouli-organic-root .ptx-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: -8px;
    z-index: 80;
    min-width: calc(100% + 2px);
    max-height: 236px;
    overflow-y: auto;
    padding: 4px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-float);
    scrollbar-width: thin;
    scrollbar-color: var(--scroll-thumb) transparent;
  }
  #patchouli-organic-root .ptx-menu-item {
    position: relative;
    display: block;
    width: 100%;
    height: 30px;
    padding: 0 10px 0 11px;
    border: 0;
    border-radius: var(--r-tag);
    background: transparent;
    color: var(--ctl-ink);
    font-family: var(--bio-mono);
    font-size: 12px;
    line-height: 30px;
    letter-spacing: 0.01em;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.14s var(--ease-organic), color 0.14s var(--ease-organic);
  }
  /* 左侧 2px 葱绿指示条只标记当前值；hover 与键盘高亮只挪底色，绝不出现系统蓝 */
  #patchouli-organic-root .ptx-menu-item::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: 1px;
    background: transparent;
    transition: background-color 0.14s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-menu-item:hover,
  #patchouli-organic-root .ptx-menu-item.is-active { background: var(--surface-hover); color: var(--bio-ink-2); }
  #patchouli-organic-root .ptx-menu-item[aria-selected="true"] { background: var(--surface-mint-soft); color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-menu-item[aria-selected="true"]::before { background: var(--bio-primary); }
  #patchouli-organic-root .ptx-menu-item:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.45); outline-offset: -2px; }

  /* ================= 内容视窗 ================= */
  #patchouli-organic-root .ptx-viewport {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px 20px 18px;
    /* 东侧缩放手柄内嵌占住窗口右缘 8px：滚动条整列右移 8px（落在 8..16px），
       绝不压在透明热区底下，滑块照常可以拖动。 */
    margin-right: 8px;
    scrollbar-width: thin;
    scrollbar-color: var(--scroll-thumb) transparent;
  }
  #patchouli-organic-root .ptx-viewport::-webkit-scrollbar { width: 8px; }
  #patchouli-organic-root .ptx-viewport::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 4px; }
  #patchouli-organic-root .ptx-viewport::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }

  #patchouli-organic-root .ptx-vhead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--hairline);
  }
  #patchouli-organic-root .ptx-vhead-bar {
    flex: none;
    width: 14px;
    height: 2px;
    border-radius: 1px;
    background: var(--bio-primary);
  }
  #patchouli-organic-root .ptx-vhead-title { font-size: 13.5px; font-weight: 650; letter-spacing: 0.02em; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-vhead-sub {
    margin-left: auto;
    font-family: var(--bio-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
    white-space: nowrap;
  }

  #patchouli-organic-root .ptx-back { flex: none; width: var(--ctl-sm); height: var(--ctl-sm); display: grid; place-items: center; padding: 0; }

  /* ================= 视图模式切换（卡片 / 列表） =================
     标题行右端的分段胶囊：26px 底槽 + 两枚 24×22 按钮，几何恒定，
     激活态只换底色与图标色。底槽用 --surface-track 与纸面拉开一档。 */
  #patchouli-organic-root .ptx-view-mode {
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: 1px;
    height: 26px;
    padding: 1px;
    border-radius: var(--r-ctl);
    background: var(--surface-track);
    border: 1px solid var(--hairline);
  }
  #patchouli-organic-root .ptx-view-btn {
    display: grid;
    place-items: center;
    flex: none;
    width: 24px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: calc(var(--r-ctl) - 2px);
    background: transparent;
    color: var(--ctl-ink-weak);
    cursor: pointer;
    transition:
      color 0.16s var(--ease-organic),
      background-color 0.16s var(--ease-organic),
      box-shadow 0.16s var(--ease-organic);
  }
  /* hover 只在底槽上浮一层纸面渐变（两端均为 100% 不透明实体色），绝不留半透明膜 */
  #patchouli-organic-root .ptx-view-btn:hover {
    color: var(--bio-primary-strong);
    background: linear-gradient(180deg, var(--surface) 0%, var(--surface-hover) 100%);
  }
  #patchouli-organic-root .ptx-view-btn:active { background: var(--surface-active); }
  /* 文字变体（触发器引擎切换）：图标按钮的 24px 定宽放不下中文标签 */
  #patchouli-organic-root .ptx-view-btn.is-text {
    width: auto;
    min-width: 46px;
    padding: 0 10px;
    font-size: 12px;
    letter-spacing: 0.02em;
  }
  #patchouli-organic-root .ptx-view-btn.is-active {
    color: var(--bio-primary-strong);
    background: var(--surface);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-view-btn:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 1px; }

  /* ================= 词条网格 ================= */
  #patchouli-organic-root .ptx-spores {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(268px, 1fr));
    gap: 8px;
  }

  #patchouli-organic-root .ptx-spore {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    min-height: 128px;
    text-align: left;
    padding: 12px 13px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
    color: inherit;
    cursor: pointer;
    transition:
      border-color 0.16s var(--ease-organic),
      background-color 0.16s var(--ease-organic),
      box-shadow 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-spore:hover {
    background: var(--surface-raise);
    border-color: rgba(14, 164, 79, 0.26);
    box-shadow: 0 1px 3px rgba(20, 50, 34, 0.07);
  }
  #patchouli-organic-root .ptx-spore:active {
    background: var(--surface-press);
    border-color: rgba(14, 164, 79, 0.34);
    box-shadow: inset 0 1px 2px rgba(20, 50, 34, 0.06);
  }

  #patchouli-organic-root .ptx-spore-glyph {
    flex: none;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: var(--r-ctl);
    color: var(--bio-primary-strong);
    background: var(--surface-mint);
    border: 1px solid rgba(14, 164, 79, 0.16);
  }

  /* 主题：长期聚合视图，深海青层叠图标 */
  #patchouli-organic-root .ptx-spore-glyph.is-topic {
    color: var(--bio-secondary);
    background: rgba(14, 143, 134, 0.1);
    border-color: rgba(14, 143, 134, 0.22);
  }

  #patchouli-organic-root .ptx-spore-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  #patchouli-organic-root .ptx-spore-top { display: flex; align-items: center; gap: 7px; }
  #patchouli-organic-root .ptx-spore-date { font-family: var(--bio-mono); font-size: 10.5px; letter-spacing: 0.02em; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-spore-status {
    font-family: var(--bio-mono);
    font-size: 10px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
    padding-left: 7px;
    border-left: 1px solid var(--hairline-strong);
  }
  #patchouli-organic-root .ptx-spore-status.is-verified { color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-spore-status.is-tentative { color: var(--bio-enzyme); }
  #patchouli-organic-root .ptx-spore-status.is-open { color: var(--bio-violet); }
  #patchouli-organic-root .ptx-spore-status.is-unknown { color: var(--bio-ink-4); }
  /* 主题卡的状态位报「N 条相关词条」：主题永远是跨时间聚合的待定视图 */
  #patchouli-organic-root .ptx-spore-status.is-topic { color: var(--bio-secondary); }
  #patchouli-organic-root .ptx-spore-title {
    font-size: 14.5px;
    font-weight: 600;
    line-height: 1.45;
    letter-spacing: -0.005em;
    color: var(--bio-ink);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  #patchouli-organic-root .ptx-spore-sum {
    font-size: 12.5px;
    line-height: 1.68;
    color: var(--bio-ink-2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-shadow: none;
  }
  #patchouli-organic-root .ptx-spore-go { flex: none; align-self: center; color: var(--ctl-ink-weak); transition: color 0.16s var(--ease-organic); }
  #patchouli-organic-root .ptx-spore:hover .ptx-spore-go { color: var(--bio-primary); }

  /* 列表模式：单列紧凑横向条（最小 46px，垂直居中）。标题单行截断省略，
     多行大摘要与发言人标签让位给密度；日期 / 状态 / 箭头照常保留。 */
  #patchouli-organic-root .ptx-spores.is-list { grid-template-columns: 1fr; gap: 6px; }
  #patchouli-organic-root .ptx-spores.is-list .ptx-spore { min-height: 46px; align-items: center; padding: 6px 10px; }
  #patchouli-organic-root .ptx-spores.is-list .ptx-spore-glyph { width: 24px; height: 24px; }
  #patchouli-organic-root .ptx-spores.is-list .ptx-spore-main { flex-direction: row; align-items: center; gap: 8px; }
  #patchouli-organic-root .ptx-spores.is-list .ptx-spore-title {
    order: 1;
    flex: 1;
    min-width: 0;
    display: block;
    font-size: 13px;
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #patchouli-organic-root .ptx-spores.is-list .ptx-spore-top { order: 2; flex: none; }
  #patchouli-organic-root .ptx-spores.is-list .ptx-spore-sum,
  #patchouli-organic-root .ptx-spores.is-list .ptx-spore-main .ptx-nodes { display: none; }

  /* ================= 指标条（稀疏数据时的信息密度） ================= */
  #patchouli-organic-root .ptx-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0 0 10px 0;
    border-radius: var(--r-card);
    border: 1px solid var(--hairline);
    background: var(--surface);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  #patchouli-organic-root .ptx-stat { display: flex; flex-direction: column; gap: 2px; padding: 11px 14px; min-width: 0; }
  #patchouli-organic-root .ptx-stat + .ptx-stat { border-left: 1px solid var(--hairline); }
  #patchouli-organic-root .ptx-stat-l { font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.02em; color: var(--bio-ink-4); white-space: nowrap; }
  #patchouli-organic-root .ptx-stat-v {
    font-family: var(--bio-mono);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--bio-ink);
    font-variant-numeric: tabular-nums;
  }

  /* ================= 发言人标签 ================= */
  #patchouli-organic-root .ptx-nodes { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 2px; }
  #patchouli-organic-root .ptx-node {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: var(--r-tag);
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.01em;
    color: var(--node-ink);
    background: var(--surface-mint);
    border: 1px solid rgba(14, 164, 79, 0.18);
    text-shadow: none;
    transition: border-color 0.16s var(--ease-organic), background-color 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-node:hover { border-color: rgba(14, 164, 79, 0.34); background: var(--surface-mint-strong); }
  #patchouli-organic-root .ptx-node.is-support { color: var(--node-support-ink); background: var(--surface-mint-strong); border-color: rgba(14, 164, 79, 0.26); }
  #patchouli-organic-root .ptx-node.is-dissent { color: var(--amber-ink); background: var(--surface-amber); border-color: rgba(184, 121, 30, 0.26); }
  #patchouli-organic-root .ptx-node.is-dissent:hover { border-color: rgba(184, 121, 30, 0.4); }
  #patchouli-organic-root .ptx-nodes-label {
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
    margin-right: 2px;
  }

  /* ================= 词条正文 ================= */
  #patchouli-organic-root .ptx-r-title { font-size: 19px; font-weight: 700; line-height: 1.38; letter-spacing: -0.01em; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-tags { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
  #patchouli-organic-root .ptx-tag {
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.01em;
    color: var(--tag-ink);
    border: 1px solid rgba(14, 143, 134, 0.2);
    background: var(--surface-cyan);
    border-radius: var(--r-tag);
    padding: 1px 7px;
  }
  #patchouli-organic-root .ptx-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-bottom: 12px;
    font-family: var(--bio-mono);
    font-size: 11px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }
  #patchouli-organic-root .ptx-meta b { color: var(--bio-ink-2); font-weight: 600; margin-left: 3px; }

  #patchouli-organic-root .ptx-sec { margin-bottom: 16px; }
  #patchouli-organic-root .ptx-sec-h {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.02em;
    color: var(--bio-primary-strong);
  }
  #patchouli-organic-root .ptx-sec-h::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--hairline);
  }

  #patchouli-organic-root .ptx-text { max-width: 72ch; font-size: 14px; line-height: 1.78; color: var(--bio-ink-2); white-space: pre-wrap; text-shadow: none; }
  #patchouli-organic-root .ptx-bul { max-width: 72ch; margin: 0; padding-left: 17px; }
  #patchouli-organic-root .ptx-bul li { font-size: 13.5px; line-height: 1.75; color: var(--bio-ink-2); text-shadow: none; }
  #patchouli-organic-root .ptx-bul li + li { margin-top: 3px; }
  #patchouli-organic-root .ptx-bul li::marker { color: rgba(14, 164, 79, 0.6); }

  /* 词条修正：就地编辑表单。正文用等宽字，随内容增高到上限后内部滚动。 */
  #patchouli-organic-root .ptx-editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-editor-row { display: flex; flex-wrap: wrap; gap: 10px; }
  #patchouli-organic-root .ptx-editor-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  #patchouli-organic-root .ptx-editor-row .ptx-editor-field { flex: 1 1 240px; }
  #patchouli-organic-root .ptx-editor-row .ptx-editor-field.is-narrow { flex: 0 0 132px; }
  #patchouli-organic-root .ptx-editor-label { font-family: var(--bio-mono); font-size: 10.5px; letter-spacing: 0.02em; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-editor .ptx-input { width: 100%; height: var(--ctl); padding: 0 10px; font-size: 13px; }
  #patchouli-organic-root .ptx-editor select.ptx-input { padding-right: 6px; cursor: pointer; }
  #patchouli-organic-root .ptx-editor .ptx-editor-area {
    height: auto;
    min-height: 72px;
    padding: 8px 10px;
    line-height: 1.72;
    resize: vertical;
    overflow-y: auto;
  }
  #patchouli-organic-root .ptx-editor .ptx-editor-md {
    min-height: 190px;
    max-height: 340px;
    overflow: auto;
    font-family: var(--bio-mono);
    font-size: 12px;
    line-height: 1.7;
    white-space: pre;
    tab-size: 2;
  }
  #patchouli-organic-root .ptx-editor-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 2px; }
  #patchouli-organic-root .ptx-editor-hint { margin-left: auto; font-size: 11px; line-height: 1.6; color: var(--bio-ink-4); }

  /* 参与群友条 */
  #patchouli-organic-root .ptx-speakers {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 9px 12px;
    margin-bottom: 12px;
    border-radius: var(--r-card);
    background: var(--surface-soft);
    border: 1px solid var(--hairline);
  }

  /* 观点矩阵卡片 */
  #patchouli-organic-root .ptx-points { display: grid; grid-template-columns: repeat(auto-fit, minmax(244px, 1fr)); gap: 8px; }
  #patchouli-organic-root .ptx-point {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 11px 13px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-left: 2px solid rgba(14, 164, 79, 0.45);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-point-view { font-size: 13.5px; font-weight: 650; line-height: 1.5; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-voice { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
  #patchouli-organic-root .ptx-voice-l {
    font-family: var(--bio-mono);
    font-size: 10px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
    min-width: 28px;
  }
  #patchouli-organic-root .ptx-voice.is-support .ptx-voice-l { color: rgba(10, 124, 58, 0.8); }
  #patchouli-organic-root .ptx-voice.is-dissent .ptx-voice-l { color: rgba(138, 91, 22, 0.85); }
  #patchouli-organic-root .ptx-point-line { font-size: 12.5px; line-height: 1.7; color: var(--bio-ink-2); text-shadow: none; }
  #patchouli-organic-root .ptx-point-line b { color: var(--bio-ink-3); font-weight: 600; margin-right: 5px; }

  /* 原始引用 */
  #patchouli-organic-root .ptx-quotes { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px; }
  #patchouli-organic-root .ptx-quote {
    padding: 11px 13px;
    border-radius: var(--r-card);
    border-left: 2px solid rgba(184, 121, 30, 0.5);
    background: var(--surface-warm);
    border-top: 1px solid var(--hairline);
    border-right: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-quote-t { font-size: 13.5px; line-height: 1.75; color: var(--bio-ink); text-shadow: none; }
  #patchouli-organic-root .ptx-quote-a { margin-top: 5px; font-family: var(--bio-mono); font-size: 10.5px; letter-spacing: 0.01em; color: rgba(138, 91, 22, 0.9); }

  /* 导语与起因行 */
  #patchouli-organic-root .ptx-lead { max-width: 72ch; font-size: 14.5px; line-height: 1.75; color: var(--bio-ink); border-left: 2px solid rgba(14, 164, 79, 0.45); padding-left: 12px; text-shadow: none; }
  #patchouli-organic-root .ptx-cause { margin-top: 7px; max-width: 72ch; font-size: 12.5px; line-height: 1.65; color: var(--bio-ink-3); text-shadow: none; }
  #patchouli-organic-root .ptx-cause-l { font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.02em; color: var(--bio-slate); margin-right: 6px; }

  /* 讨论脉络 / 主题综述：词条主体的连续叙事 */
  #patchouli-organic-root .ptx-narrative { max-width: 68ch; }
  #patchouli-organic-root .ptx-narrative p { margin: 0 0 12px; font-size: 14px; line-height: 1.85; color: var(--bio-ink-2); text-shadow: none; }
  #patchouli-organic-root .ptx-narrative p:last-child { margin-bottom: 0; }
  #patchouli-organic-root .ptx-quote-span { color: var(--bio-primary-strong); background: rgba(14, 143, 134, 0.08); border-radius: 3px; padding: 0 2px; }

  /* 正文内联昵称胶囊：与「…」原话高亮（无边框）在视觉上区分 */
  #patchouli-organic-root .ptx-node.is-inline { display: inline; padding: 0 5px; margin: 0 1px; font-size: 0.84em; line-height: inherit; vertical-align: baseline; white-space: nowrap; box-decoration-break: clone; }

  /* 相关线索：序号 + 标题 + 一行摘要（+ 箭头 / 未入索引旗标） */
  #patchouli-organic-root .ptx-related { list-style: none; padding: 0; margin: 0; display: grid; gap: 2px; max-width: 72ch; }
  #patchouli-organic-root .ptx-link { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; align-items: center; column-gap: 8px; width: 100%; padding: 7px 10px; border: 1px solid transparent; border-radius: var(--r-ctl); background: none; font: inherit; text-align: left; color: inherit; cursor: pointer; transition: background-color 0.16s var(--ease-organic), border-color 0.16s var(--ease-organic); }
  #patchouli-organic-root button.ptx-link:hover, #patchouli-organic-root button.ptx-link:focus-visible { background: var(--surface-mint); border-color: rgba(14, 164, 79, 0.18); outline: none; }
  #patchouli-organic-root button.ptx-link:hover .ptx-link-title, #patchouli-organic-root button.ptx-link:focus-visible .ptx-link-title { color: var(--bio-primary-strong); }
  #patchouli-organic-root button.ptx-link:hover .ptx-link-go, #patchouli-organic-root button.ptx-link:focus-visible .ptx-link-go { color: var(--bio-primary); transform: translateX(2px); }
  #patchouli-organic-root .ptx-link-no { font-family: var(--bio-mono); font-size: 10.5px; color: var(--bio-ink-4); font-variant-numeric: tabular-nums; }
  #patchouli-organic-root .ptx-link-main { display: grid; gap: 1px; min-width: 0; }
  #patchouli-organic-root .ptx-link-title { font-size: 13.5px; font-weight: 600; color: var(--bio-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #patchouli-organic-root .ptx-link-sum { display: block; font-size: 12px; line-height: 1.55; color: var(--bio-ink-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #patchouli-organic-root .ptx-link-go { color: var(--ctl-ink-weak); transition: color 0.16s var(--ease-organic), transform 0.16s var(--ease-organic); }
  #patchouli-organic-root .ptx-link.is-missing { cursor: default; opacity: 0.62; }
  #patchouli-organic-root .ptx-link.is-missing .ptx-link-title { font-weight: 500; color: var(--bio-ink-3); }
  #patchouli-organic-root .ptx-link-flag { font-family: var(--bio-mono); font-size: 10px; padding: 0 6px; border: 1px solid var(--hairline); border-radius: var(--r-tag); color: var(--bio-ink-4); }

  /* 「其余 N 条」折叠：安静的小字 summary */
  #patchouli-organic-root .ptx-related-more { margin-top: 2px; }
  #patchouli-organic-root .ptx-related-more > summary { cursor: pointer; padding: 6px 10px; font-family: var(--bio-mono); font-size: 11px; color: var(--bio-ink-3); list-style: none; }
  #patchouli-organic-root .ptx-related-more > summary::-webkit-details-marker { display: none; }
  #patchouli-organic-root .ptx-related-more > summary::after { content: "＋"; float: right; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-related-more[open] > summary::after { content: "－"; }

  /* 附录：争点对照 + 摘句收进默认折叠的结构化索引 */
  #patchouli-organic-root .ptx-appendix { border: 1px solid var(--hairline); border-radius: var(--r-card); background: var(--surface); }
  #patchouli-organic-root .ptx-appendix > summary { cursor: pointer; padding: 9px 12px; font-size: 12px; font-weight: 650; letter-spacing: 0.02em; color: var(--bio-primary-strong); list-style: none; }
  #patchouli-organic-root .ptx-appendix > summary::-webkit-details-marker { display: none; }
  #patchouli-organic-root .ptx-appendix > summary::after { content: "＋"; float: right; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-appendix[open] > summary::after { content: "－"; }
  #patchouli-organic-root .ptx-appendix .ptx-points, #patchouli-organic-root .ptx-appendix .ptx-quotes { padding: 0 12px 12px; }
  #patchouli-organic-root .ptx-app-h { padding: 0 12px 6px; font-size: 11px; font-weight: 650; letter-spacing: 0.04em; color: var(--bio-secondary); }

  /* 落点：已收敛 / 仍悬而未决 双列 */
  #patchouli-organic-root .ptx-outcome { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  #patchouli-organic-root .ptx-outcome-col { padding: 10px 12px; border-radius: var(--r-card); background: var(--surface); border: 1px solid var(--hairline); }
  #patchouli-organic-root .ptx-outcome-l { display: block; margin-bottom: 6px; font-size: 11.5px; font-weight: 650; color: var(--bio-ink-3); }

  /* 名词注：紧凑释义表 */
  #patchouli-organic-root .ptx-gloss { max-width: 72ch; margin: 0; }
  #patchouli-organic-root .ptx-gloss-row { display: flex; gap: 10px; font-size: 13px; line-height: 1.7; margin-bottom: 4px; }
  #patchouli-organic-root .ptx-gloss-row dt { flex: 0 0 auto; font-weight: 650; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-gloss-row dd { margin: 0; color: var(--bio-ink-2); text-shadow: none; }

  /* ================= 监控 ================= */
  #patchouli-organic-root .ptx-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  #patchouli-organic-root .ptx-tile {
    padding: 10px 12px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
    min-width: 0;
  }
  #patchouli-organic-root .ptx-tile-l { font-size: 11.5px; line-height: 1.4; color: var(--bio-ink-3); }
  #patchouli-organic-root .ptx-tile-v {
    margin-top: 2px;
    font-family: var(--bio-mono);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.25;
    color: var(--bio-ink);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  #patchouli-organic-root .ptx-tile-v small { margin-left: 4px; font-size: 10.5px; font-weight: 500; color: var(--bio-ink-4); }

  /* 监控页纵向顺序：流量图表 → 最新消息 → 指标磁贴（消息夹在趋势与数值之间充当事件锚点） */
  #patchouli-organic-root .ptx-message-preview + .ptx-tiles { margin-top: 10px; }

  /* 当前群最新消息横条：柔和葱绿底 + 发丝线边界；富媒体段就地展开，绝不撑满监控视窗 */
  #patchouli-organic-root .ptx-message-preview {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: var(--r-card);
    background: var(--surface-mint-soft);
    border: 1px solid rgba(14, 164, 79, 0.16);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-message-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }
  #patchouli-organic-root .ptx-message-head strong {
    flex: none;
    font-family: var(--bio-ui);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.01em;
    color: var(--bio-ink);
  }
  #patchouli-organic-root .ptx-message-head [data-message-author] {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--bio-primary-strong);
  }
  #patchouli-organic-root .ptx-message-head time { flex: none; font-variant-numeric: tabular-nums; }
  /* 正文容器：文字段与媒体段共用一条可换行基线，媒体段独占整行 */
  #patchouli-organic-root .ptx-message-body {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px 8px;
    margin-top: 6px;
    font-size: 12.5px;
    line-height: 1.7;
    letter-spacing: 0.01em;
    color: var(--bio-ink-2);
    overflow-wrap: anywhere;
    text-shadow: none;
  }
  #patchouli-organic-root .ptx-rich-text {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 100%;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  #patchouli-organic-root .ptx-rich-face { width: 20px; height: 20px; border-radius: 5px; object-fit: cover; vertical-align: -5px; }

  /* 图片缩略：点击放大走原生 dialog；按钮本体永不形变（只换边框色，无位移 / 缩放 / 发光） */
  #patchouli-organic-root .ptx-rich-image {
    flex: 0 0 auto;
    margin: 0;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--r-ctl);
    background: var(--surface);
    box-shadow: var(--shadow-card);
    overflow: hidden;
    cursor: zoom-in;
    line-height: 0;
  }
  #patchouli-organic-root .ptx-rich-image img { display: block; max-width: 100%; max-height: 140px; width: auto; height: auto; }
  #patchouli-organic-root .ptx-rich-image:hover { border-color: rgba(14, 164, 79, 0.3); }
  #patchouli-organic-root .ptx-rich-image:active { border-color: rgba(14, 164, 79, 0.44); }
  #patchouli-organic-root .ptx-rich-image:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.42); outline-offset: 1px; }
  /* 加载失败的可见兜底（直链失效 / 媒体代理已过期），绝不留空白或假图 */
  #patchouli-organic-root .ptx-rich-failed { font-family: var(--bio-mono); font-size: 10.5px; color: var(--bio-danger); }

  /* 卡片 / 视频：白底发丝线小卡，封面统一裁切，避免富媒体抢走图表的注意力 */
  #patchouli-organic-root .ptx-rich-media-card,
  #patchouli-organic-root .ptx-rich-card {
    flex: 1 1 100%;
    min-width: 0;
    display: block;
    padding: 8px 10px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
    color: var(--bio-ink-2);
    text-decoration: none;
    overflow: hidden;
  }
  #patchouli-organic-root .ptx-rich-card:hover { border-color: rgba(14, 164, 79, 0.26); }
  #patchouli-organic-root .ptx-rich-cover {
    display: block;
    width: 100%;
    max-height: 128px;
    object-fit: cover;
    border-radius: var(--r-ctl);
    background: rgba(20, 50, 34, 0.04);
  }
  #patchouli-organic-root .ptx-rich-media-title,
  #patchouli-organic-root .ptx-rich-card-title { display: block; margin-top: 6px; font-size: 12px; font-weight: 650; line-height: 1.5; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-rich-media-title:first-child { margin-top: 0; }
  #patchouli-organic-root .ptx-rich-card-text { display: block; margin-top: 2px; font-size: 11.5px; line-height: 1.6; color: var(--bio-ink-3); }
  #patchouli-organic-root .ptx-rich-card-source { display: block; margin-top: 4px; font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-rich-video-player { display: block; width: 100%; max-height: 168px; margin-top: 6px; border-radius: var(--r-ctl); background: #0f1a14; }
  #patchouli-organic-root .ptx-rich-link { display: inline-block; margin-top: 6px; font-family: var(--bio-mono); font-size: 10.5px; color: var(--bio-primary-strong); text-decoration: none; }
  #patchouli-organic-root .ptx-rich-link:hover { text-decoration: underline; }

  /* 引用 / 合并转发：左侧薄荷绿竖线（与观点矩阵同一套样式语言） */
  #patchouli-organic-root .ptx-rich-quote,
  #patchouli-organic-root .ptx-rich-forward {
    flex: 1 1 100%;
    min-width: 0;
    padding: 6px 10px;
    border-left: 2px solid rgba(14, 164, 79, 0.28);
    border-radius: 0 var(--r-ctl) var(--r-ctl) 0;
    background: rgba(14, 164, 79, 0.05);
  }
  #patchouli-organic-root .ptx-rich-quote-title { display: block; font-size: 11px; font-weight: 650; line-height: 1.5; color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-rich-quote-text { display: block; font-size: 11.5px; line-height: 1.6; color: var(--bio-ink-3); overflow-wrap: anywhere; }
  #patchouli-organic-root .ptx-rich-forward-summary {
    display: flex;
    align-items: baseline;
    gap: 8px;
    cursor: pointer;
    list-style: none;
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--bio-primary-strong);
  }
  #patchouli-organic-root .ptx-rich-forward-summary::-webkit-details-marker { display: none; }
  #patchouli-organic-root .ptx-rich-forward-summary::after { content: "展开"; margin-left: auto; flex: none; font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-rich-forward[open] > .ptx-rich-forward-summary::after { content: "收起"; }
  #patchouli-organic-root .ptx-rich-forward-title { flex: none; font-weight: 650; }
  #patchouli-organic-root .ptx-rich-forward-count { flex: 1; min-width: 0; font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); }
  /* 展开后就地推挤，但内部细滚动 + 高度上限，绝不把监控视窗无节制向下推 */
  #patchouli-organic-root .ptx-rich-forward-body {
    max-height: 180px;
    margin-top: 6px;
    padding-right: 2px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(20, 50, 34, 0.18) transparent;
  }
  #patchouli-organic-root .ptx-rich-forward-body::-webkit-scrollbar { width: 6px; }
  #patchouli-organic-root .ptx-rich-forward-body::-webkit-scrollbar-thumb { border-radius: 3px; background: rgba(20, 50, 34, 0.16); }
  #patchouli-organic-root .ptx-rich-forward-item { padding: 5px 0; border-top: 1px dashed rgba(20, 50, 34, 0.1); }
  #patchouli-organic-root .ptx-rich-forward-item:first-child { padding-top: 0; border-top: none; }
  #patchouli-organic-root .ptx-rich-forward-author { display: block; font-size: 10.5px; font-weight: 650; line-height: 1.5; color: var(--bio-ink-2); }
  #patchouli-organic-root .ptx-rich-forward-more { display: block; margin-top: 4px; font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-rich-line {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 4px 6px;
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--bio-ink-3);
    overflow-wrap: anywhere;
  }
  #patchouli-organic-root .ptx-rich-line .ptx-rich-image img { max-height: 96px; }
  #patchouli-organic-root .ptx-rich-line .ptx-rich-cover { max-height: 96px; }

  /* 文件 / 语音：单行胶囊，链接仅在 URL 合法时出现 */
  #patchouli-organic-root .ptx-rich-file {
    flex: 1 1 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: var(--r-ctl);
    background: var(--surface);
    border: 1px solid var(--hairline);
  }
  #patchouli-organic-root .ptx-rich-file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 11.5px;
    color: var(--bio-ink-2);
  }
  #patchouli-organic-root .ptx-rich-file .ptx-rich-link { flex: none; margin-top: 0; }
  #patchouli-organic-root .ptx-rich-record { flex: 1 1 100%; min-width: 0; display: flex; align-items: center; gap: 8px; }
  #patchouli-organic-root .ptx-rich-audio { flex: 1 1 auto; min-width: 0; height: 30px; }
  #patchouli-organic-root .ptx-rich-record-label { flex: none; font-family: var(--bio-mono); font-size: 10.5px; color: var(--bio-ink-4); font-variant-numeric: tabular-nums; }

  /* 图片放大：原生 dialog（Esc / 点空白关闭），固定全屏居中的顶层弹窗。
     dialog 挂在 #patchouli-organic-root 下（不是 .ptx-viewport 里），因此定位与尺寸必须
     自带全套：fixed + inset: 0 + margin: auto 才同时拿到水平与垂直居中，width: fit-content
     让小图不撑成整屏；!important 用于压过 top layer 的 UA 版式与宿主继承下来的宽容规则
     （旧版正是被 .ptx-viewport > * 的 100% 宽度 + 左右 auto 边距锁成 820px 并偏左）。 */
  #patchouli-organic-root .ptx-rich-lightbox {
    position: fixed !important;
    inset: 0 !important;
    margin: auto !important;
    width: fit-content !important;
    max-width: min(92vw, 1040px) !important;
    max-height: 92vh !important;
    padding: 0;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--r-card);
    background: var(--surface);
    box-shadow: var(--shadow-float);
    overflow: hidden;
    /* 根容器整体 pointer-events: none，弹窗必须自己收回命中测试，点空白才能关闭 */
    pointer-events: auto;
  }
  #patchouli-organic-root .ptx-rich-lightbox::backdrop { background: rgba(12, 24, 18, 0.56); }
  #patchouli-organic-root .ptx-rich-lightbox img {
    display: block;
    margin: 0 auto;
    max-width: min(92vw, 1040px);
    max-height: 92vh;
    object-fit: contain;
  }

  #patchouli-organic-root .ptx-bar { height: 3px; margin-top: 7px; overflow: hidden; border-radius: 2px; background: rgba(20, 50, 34, 0.08); }
  #patchouli-organic-root .ptx-bar i {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--bio-secondary);
    transition: width 0.5s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-bar.is-alert i { background: var(--bio-danger); }

  /* 时间序列图表面板 */
  #patchouli-organic-root .ptx-panel {
    margin-top: 10px;
    padding: 12px 14px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
  }
  #patchouli-organic-root .ptx-panel-h {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
    font-variant-numeric: tabular-nums;
  }
  #patchouli-organic-root .ptx-panel-h strong {
    font-family: var(--bio-ui);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.01em;
    color: var(--bio-ink);
  }
  #patchouli-organic-root .ptx-panel-h > span:last-child { text-align: right; }
  #patchouli-organic-root .ptx-panel-h b { font-weight: 700; color: var(--bio-ink-2); }
  #patchouli-organic-root .ptx-panel-h + .ptx-panel-h { margin-top: 3px; font-size: 10px; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-ecg {
    display: block;
    width: 100%;
    height: 78px;
    margin-top: 8px;
    overflow: visible;
  }
  /* 网格基准线：极淡虚线（流量图的三条 Y 刻度线） */
  #patchouli-organic-root .ptx-ecg-base {
    fill: none;
    stroke: rgba(20, 50, 34, 0.12);
    stroke-width: 1;
    stroke-dasharray: 2 4;
    vector-effect: non-scaling-stroke;
  }
  /* ============ 消息流量图：真实时间轴 × 每 5 秒消息条数 ============ */
  /* 左列 42px 承载 Y 刻度，右列绘图区（minmax(0,1fr) 防止 SVG 撑破面板） */
  #patchouli-organic-root .ptx-traffic-chart {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr);
    align-items: stretch;
    margin-top: 8px;
  }
  #patchouli-organic-root .ptx-traffic-y {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-end;
    padding-right: 6px;
    font-family: var(--bio-mono);
    font-size: 9.5px;
    line-height: 1;
    color: var(--bio-ink-4);
    font-variant-numeric: tabular-nums;
  }
  /* 上边距由图表容器承担：SVG 归零后与 Y 刻度逐行对齐；高度放宽到 140px 供读数 */
  #patchouli-organic-root .ptx-traffic-chart .ptx-ecg { margin-top: 0; height: 140px; }
  /* 时间刻度：缩进 42px 与绘图区左边界对齐 */
  #patchouli-organic-root .ptx-traffic-times {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    margin-left: 42px;
    font-family: var(--bio-mono);
    font-size: 9.5px;
    line-height: 1;
    color: var(--bio-ink-4);
    font-variant-numeric: tabular-nums;
  }
  /* 监控状态条：连接中断 / 等待采样；空态不占位 */
  #patchouli-organic-root .ptx-monitor-status {
    margin-bottom: 8px;
    font-family: var(--bio-mono);
    font-size: 10px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }
  #patchouli-organic-root .ptx-monitor-status:empty { display: none; }
  #patchouli-organic-root .ptx-ecg-line {
    fill: none;
    stroke: var(--bio-primary-strong);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
    transition: stroke 0.3s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-ecg-note {
    margin-top: 4px;
    font-family: var(--bio-mono);
    font-size: 10px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }
  /* 突发相位：曲线与描边转为绯红语义色 */
  #patchouli-organic-root .ptx-panel.is-burst { border-color: rgba(196, 72, 92, 0.28); }
  #patchouli-organic-root .ptx-panel.is-burst .ptx-panel-h b { color: var(--bio-danger); }
  #patchouli-organic-root .ptx-panel.is-burst .ptx-ecg-base { stroke: rgba(196, 72, 92, 0.16); }
  #patchouli-organic-root .ptx-panel.is-burst .ptx-ecg-line { stroke: var(--bio-danger); }
  #patchouli-organic-root .ptx-panel.is-burst .ptx-ecg-note { color: var(--bio-danger); }

  #patchouli-organic-root .ptx-input {
    width: 92px;
    height: 30px;
    padding: 0 9px;
    border-radius: var(--r-ctl);
    background: var(--surface);
    border: 1px solid var(--hairline-strong);
    box-shadow: inset 0 1px 1px rgba(20, 50, 34, 0.04);
    color: var(--bio-ink);
    font-family: var(--bio-mono);
    font-size: 12.5px;
    outline: none;
    transition: border-color 0.16s var(--ease-organic), box-shadow 0.16s var(--ease-organic);
  }
  #patchouli-organic-root .ptx-input:focus { border-color: rgba(14, 164, 79, 0.5); box-shadow: 0 0 0 3px rgba(14, 164, 79, 0.12); }

  /* ================= 空状态 ================= */
  #patchouli-organic-root .ptx-dormant {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 26px 16px 30px;
    text-align: center;
  }
  #patchouli-organic-root .ptx-nucleus { width: 124px; height: 124px; }
  #patchouli-organic-root .ptx-nucleus-membrane { fill: none; stroke: rgba(14, 164, 79, 0.2); stroke-width: 1; stroke-dasharray: 3 6; }
  #patchouli-organic-root .ptx-nucleus-wall { fill: none; stroke: rgba(14, 143, 134, 0.16); stroke-width: 1; }
  #patchouli-organic-root .ptx-nucleus-core { fill: rgba(14, 164, 79, 0.06); stroke: rgba(14, 164, 79, 0.34); stroke-width: 1; }
  #patchouli-organic-root .ptx-nucleus-seed { fill: var(--bio-primary); opacity: 0.75; }

  /* 空状态点缀轨道：仅保留定位所需动画，无缩放脉冲 */
  #patchouli-organic-root .ptx-orb { transform-origin: 80px 80px; animation: ptxOrbit var(--n-dur) var(--ease-organic) infinite; animation-delay: var(--n-delay); }
  #patchouli-organic-root .ptx-orb ellipse { fill: var(--n-tone); opacity: var(--n-opacity); }

  #patchouli-organic-root .ptx-dormant-t { margin-top: 2px; font-size: 13px; font-weight: 650; letter-spacing: 0.02em; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-dormant-s { font-size: 12px; line-height: 1.6; letter-spacing: 0.01em; color: var(--bio-ink-3); text-shadow: none; max-width: 34ch; }

  /* ================= 底栏 ================= */
  #patchouli-organic-root .ptx-foot {
    flex: none;
    height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px;
    border-top: 1px solid var(--hairline);
    background: var(--foot-grad);
    /* 右下角同样交给父级统一硬裁剪，底栏不再自补内层圆角（见 .ptx-rail 同段说明）。 */
  }

  /* 双槽位滑入：容器自身就是唯一裁切矩形（28px 高 + 上下 2px 微羽化），
     行绝对定位在同一槽位里交替进出——不再有承载长轨道的内层元素。 */
  #patchouli-organic-root .ptx-ticker {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 28px;
    overflow: hidden;
    mask-image: linear-gradient(180deg, transparent 0, #000 2px, #000 calc(100% - 2px), transparent 100%);
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 2px, #000 calc(100% - 2px), transparent 100%);
  }

  #patchouli-organic-root .ptx-trow {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    line-height: 28px;
    min-width: 0;
    padding: 0;
    background: none;
    border: none;
    border-radius: 0;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transform: translateY(0);
    opacity: 1;
    transition: transform 0.4s var(--ease-organic), opacity 0.3s ease;
  }
  #patchouli-organic-root .ptx-trow.is-active { transform: translateY(0); opacity: 1; }
  #patchouli-organic-root .ptx-trow.is-leaving {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
    transition: transform 0.4s var(--ease-organic), opacity 0.3s ease;
  }
  #patchouli-organic-root .ptx-trow.is-entering { transform: translateY(100%); opacity: 0; }
  #patchouli-organic-root .ptx-tdot { flex: none; width: 4px; height: 4px; border-radius: 50%; background: rgba(14, 164, 79, 0.55); }
  #patchouli-organic-root .ptx-ttitle { flex: 1; min-width: 0; font-size: 13px; font-weight: 550; color: var(--bio-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.16s var(--ease-organic); }
  #patchouli-organic-root .ptx-trow:hover .ptx-ttitle { color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-tdate { flex: none; font-family: var(--bio-mono); font-size: 11px; white-space: nowrap; color: var(--bio-ink-4); }

  #patchouli-organic-root .ptx-foot-acts { flex: none; display: flex; align-items: center; gap: 7px; }
  #patchouli-organic-root .ptx-foot-btn { width: var(--ctl); height: var(--ctl); display: grid; place-items: center; padding: 0; }

  /* 主操作按钮：实心葱绿，固定圆形 */
  #patchouli-organic-root .ptx-foot-btn.is-core {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: #ffffff;
    background: var(--bio-primary);
    border: 1px solid #0a7c3a;
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.12);
  }
  #patchouli-organic-root .ptx-foot-btn.is-core:hover {
    background: #0b9446;
    border-color: #076d33;
    color: #ffffff;
    box-shadow: 0 2px 4px rgba(20, 50, 34, 0.16);
  }
  /* 刷新中的唯一反馈：图标匀速旋转，按钮本体不形变 */
  #patchouli-organic-root .ptx-foot-btn.is-busy svg { animation: ptxSpin 0.9s linear infinite; }

  /* ================= 悬浮胶囊（第二处 backdrop-filter，点击展开） ================= */
  #patchouli-organic-root .ptx-pill {
    position: fixed;
    right: 24px;
    bottom: 116px;
    z-index: 10050;
    height: 46px;
    padding: 0 16px 0 9px;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    border-radius: var(--r-pill);
    background: var(--surface-float);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    border: 1px solid var(--hairline-strong);
    box-shadow: var(--bevel-hi), var(--shadow-float);
    color: var(--bio-ink);
    cursor: pointer;
    /* 触摸拖动：胶囊自身吞掉手势，页面滚动 / 双指缩放不再抢走指针 */
    touch-action: none;
    opacity: 0;
    transform: scale(0.66) translateY(12px);
    visibility: hidden;
    transition:
      transform 0.46s var(--ease-spring),
      opacity 0.34s var(--ease-organic),
      visibility 0s linear 0.46s,
      border-color 0.16s var(--ease-organic),
      background-color 0.16s var(--ease-organic);
  }

  /* 展开 / 收回的显隐过渡：窗口状态变化，按钮本体 hover / active 不形变 */
  #patchouli-organic-root .ptx-pill.is-visible {
    opacity: 1;
    transform: scale(1) translateY(0);
    visibility: visible;
    transition-delay: 0s;
  }

  #patchouli-organic-root .ptx-pill:hover {
    background: var(--surface);
    border-color: rgba(14, 164, 79, 0.32);
  }

  /* 拖动中：唯一状态类是 .is-dragging，位移全部走行内 left / top（无过渡、无 transform 形变） */
  #patchouli-organic-root .ptx-pill.is-dragging {
    transition: none;
    transform: none;
    cursor: grabbing;
  }

  #patchouli-organic-root .ptx-pill-core {
    flex: none;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: #ffffff;
    background: var(--bio-primary);
    border: 1px solid #0a7c3a;
  }

  #patchouli-organic-root .ptx-pill-txt { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.32; }
  #patchouli-organic-root .ptx-pill-name { font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-pill-id { font-size: 11px; letter-spacing: 0.01em; color: var(--bio-ink-4); }

  /* ================= hover 浮层（说明文字唯一出口） ================= */
  #patchouli-organic-root :where([data-tip]) { position: relative; }

  #patchouli-organic-root [data-tip]::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%;
    top: calc(100% + 8px);
    z-index: 70;
    width: max-content;
    max-width: 220px;
    padding: 7px 10px;
    border-radius: var(--r-ctl);
    background: var(--surface);
    border: 1px solid var(--hairline-strong);
    box-shadow: var(--bevel-hi), 0 8px 20px -12px rgba(20, 50, 34, 0.32);
    color: var(--bio-ink-2);
    font-family: var(--bio-ui);
    font-size: 11.5px;
    font-weight: 500;
    line-height: 1.6;
    letter-spacing: 0.01em;
    text-align: left;
    white-space: normal;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transform: translate(-50%, -3px);
    transition: opacity 0.16s var(--ease-organic), transform 0.16s var(--ease-organic), visibility 0s linear 0.16s;
  }

  #patchouli-organic-root [data-tip]:hover::after,
  #patchouli-organic-root [data-tip]:focus-visible::after {
    opacity: 1;
    visibility: visible;
    transform: translate(-50%, 0);
    transition-delay: 0s;
  }

  #patchouli-organic-root [data-tip][data-tip-pos="right"]::after { left: calc(100% + 10px); top: 50%; transform: translate(-4px, -50%); }
  #patchouli-organic-root [data-tip][data-tip-pos="right"]:hover::after { transform: translate(0, -50%); }
  #patchouli-organic-root [data-tip][data-tip-pos="top"]::after { top: auto; bottom: calc(100% + 8px); transform: translate(-50%, 3px); }
  #patchouli-organic-root [data-tip][data-tip-pos="top"]:hover::after { transform: translate(-50%, 0); }

  /* 群聊面板展开时压掉 chip 自己的提示气泡：面板正落在那条气泡的位置上 */
  #patchouli-organic-root .ptx-channel.is-open::after { opacity: 0; visibility: hidden; }

  /* ================= 轻提示 ================= */
  #patchouli-organic-root .ptx-toast {
    position: fixed;
    left: 50%;
    bottom: 30px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 14px;
    border-radius: var(--r-ctl);
    background: var(--surface);
    border: 1px solid var(--hairline-strong);
    box-shadow: var(--bevel-hi), 0 10px 24px -14px rgba(20, 50, 34, 0.36);
    color: var(--bio-ink-2);
    font-size: 12px;
    letter-spacing: 0.01em;
    opacity: 0;
    transform: translate(-50%, 8px);
    pointer-events: none;
    transition: opacity 0.24s var(--ease-organic), transform 0.24s var(--ease-organic);
    z-index: 10000;
  }
  #patchouli-organic-root .ptx-toast.is-visible { opacity: 1; transform: translate(-50%, 0); }

  @keyframes ptxFade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes ptxSpin { to { transform: rotate(360deg); } }
  /* 连接中的状态点：仅透明度呼吸，无缩放 */
  @keyframes ptxPhasePulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }
  @keyframes ptxOrbit {
    from { transform: rotate(var(--n-angle)) translateX(var(--n-radius)); }
    to { transform: rotate(calc(var(--n-angle) + 360deg)) translateX(var(--n-radius)); }
  }


  /* ================= 视窗主体：单一 820px 版心 =================
     全部阶段容器共用同一条 820px 版心：整块内容在视窗中轴上居中（左右外边距完全对称），
     版心内部每个容器都是 100% 宽，于是标题绿条、设置卡片边框、编辑器边框、列表边框
     全部落在同一条垂直线上（严格左对齐）。不再有 960 / 720 / 82ch 三档宽度各自居中
     造成的参差错位；视窗窄于 820px 时自动退化为整宽铺满，窄档无需额外覆盖。 */
  #patchouli-organic-root .ptx-vhead {
    max-width: 820px;
    width: 100%;
    margin: 0 auto 12px;
  }
  #patchouli-organic-root .ptx-strip {
    max-width: 820px;
    width: 100%;
    margin: 0 auto 10px;
  }
  #patchouli-organic-root .ptx-spores,
  #patchouli-organic-root .ptx-panel,
  #patchouli-organic-root .ptx-message-preview,
  #patchouli-organic-root .ptx-tiles,
  #patchouli-organic-root .ptx-meta,
  #patchouli-organic-root .ptx-sec,
  #patchouli-organic-root .ptx-editor,
  #patchouli-organic-root .ptx-dormant {
    max-width: 820px;
    width: 100%;
    margin-left: auto;
    margin-right: auto;
  }
  /* 设置页本身就是版心：内部行与编辑器满铺 100%，左缘与标题 100% 垂直对齐 */
  #patchouli-organic-root .ptx-settings-page {
    max-width: 820px;
    width: 100%;
    margin: 0 auto;
  }
  #patchouli-organic-root .ptx-settings-row { width: 100%; }
  /* 兜底：视窗是唯一的排版容器，任何直接子块（正文标题行 / 标签行 / 操作条 / 发言人
     行，以及以后新增的阶段块）都约束在同一条 820px 版心里，左缘永远与标题绿条对齐。
     只排除 dialog：弹窗是挂在根容器上的顶层浮层，fixed / inset / margin: auto 是它自身的
     居中契约；被这里的 100% 宽度 + 左右 auto 边距接管的后果就是“820px 宽、贴左不居中”。 */
  #patchouli-organic-root .ptx-viewport > :not(dialog) {
    max-width: 820px;
    width: 100%;
    margin-left: auto;
    margin-right: auto;
  }

  /* ================= 窗口尺寸响应（运行时档位类：排版随窗口宽度换挡，而非浏览器宽度） =================
     不再使用 container-type / @container：查询容器会让窗口每次尺寸变化都重算整窗查询条件，
     正是缩放时的全屏重光栅瓶颈。JS 在写入宽度的同一次调用里维护
     .ptx-window.is-narrow（宽度 ≤ 782px）与 .ptx-window.is-compact（≤ 562px），
     由 ResizeObserver 与几何提交共用同一个同步函数维护（见 syncResponsiveTier）。
     只有窗口本体几何与窗口外的浮层入口（胶囊 / 重开按钮）仍按视口判定。 */
  #patchouli-organic-root .ptx-window.is-narrow .ptx-id-code { display: none; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-spore-sum { display: none; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-spores { grid-template-columns: 1fr; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-viewport { padding: 14px 16px 16px; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-stat:nth-child(3) { border-left: 0; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-stat:nth-child(n+3) { border-top: 1px solid var(--hairline); }

  /* 极窄档的顶栏改成两行：第一行 id 左对齐 + 三键右对齐，第二行筛选与搜索整行铺满。
     .ptx-tools 只是常规档的右侧聚拢层，窄档用 display: contents 把它解包，
     让 filter / winctl 直接成为顶栏的 flex 子项，才能用 order 重新分行。 */
  #patchouli-organic-root .ptx-window.is-compact .ptx-topbar {
    height: auto;
    min-height: 56px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px 8px 12px;
    row-gap: 8px;
  }
  #patchouli-organic-root .ptx-window.is-compact .ptx-tools { display: contents; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-id {
    order: 1;
    flex: 0 1 auto;
    min-width: 0;
  }
  #patchouli-organic-root .ptx-window.is-compact .ptx-winctl {
    order: 2;
    flex: none;
    margin-left: auto;
    gap: 4px;
    padding-left: 8px;
  }
  #patchouli-organic-root .ptx-window.is-compact .ptx-filter {
    order: 3;
    flex: 1 1 100%;
    width: 100%;
    min-width: 0;
  }
  #patchouli-organic-root .ptx-window.is-compact .ptx-chip:last-child { flex: 1 1 96px; min-width: 0; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-find { flex: 1 1 auto; width: auto; min-width: 0; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-tiles { grid-template-columns: 1fr; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-tile-v { font-size: 18px; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-panel { padding: 10px 12px; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-panel-h { flex-wrap: wrap; gap: 2px 10px; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-panel-h > span:last-child { text-align: left; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-ecg { height: 64px; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-traffic-chart .ptx-ecg { height: 120px; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-input { width: 84px; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-editor .ptx-input { width: 100%; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-settings-page { max-width: none; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-acts { padding: 8px; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-editor { padding: 10px; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-editor-field.is-narrow { flex: 1 1 100%; }
  #patchouli-organic-root .ptx-window.is-compact .ptx-editor-hint { margin-left: 0; }

  /* ================= 夜间主题（根容器 .is-dark 上的变量覆盖） =================
     中性冷炭灰（charcoal / slate，参考 Koishi 控制台、Linear、GitHub Dark）：
     页面 #222327、窗口面 #28292e、提升面 #32333b、悬浮面 #393b44，形成 5 级灰度高程；
     主波长收敛为清爽薄荷翠绿 #10b981，发丝线转为白色 8% / 14%，文字走柔白 → 中灰四级。
     明暗共用同一套几何与布局，只换纸面与墨色。 */
  #patchouli-organic-root.is-dark {
    color-scheme: dark;
    --bg-porcelain: #222327;
    --bg-membrane: #28292e;
    --bio-primary: #10b981;
    --bio-primary-strong: #34d399;
    --bio-secondary: #2dd4bf;
    --bio-cyan: #5eead4;
    --bio-slate: #9499b0;
    --bio-violet: #a78bfa;
    --bio-violet-strong: #c4b5fd;
    --bio-enzyme: #e3b781;
    --bio-danger: #f08c9c;
    --bio-ink: #f3f4f6;
    --bio-ink-2: #d1d5db;
    --bio-ink-3: #9ca3af;
    --bio-ink-4: #6b7280;
    --hairline: rgba(255, 255, 255, 0.08);
    --hairline-strong: rgba(255, 255, 255, 0.14);
    /* 夜间窗体框线：与日间同一策略，四边同一条白光发丝线，圆角处连续闭合 */
    --hairline-frame: rgba(255, 255, 255, 0.1);
    --surface: #28292e;
    --surface-soft: #2e3036;
    --surface-warm: #2c2d33;
    --surface-cyan: #1e2b2c;
    --surface-cyan-soft: #1f3031;
    --surface-mint: #203328;
    --surface-mint-strong: #253f30;
    --surface-mint-soft: #21352a;
    --surface-hover: #393b44;
    --surface-active: #2c2e35;
    --surface-raise: #32333b;
    --surface-press: #24252b;
    --surface-track: #1f2024;
    --surface-amber: #322a1e;
    --surface-danger: #33222a;
    --surface-float: #2d2e35;
    --knob: #e5e7eb;
    --ctl-ink: #d1d5db;
    --ctl-ink-weak: #6b7280;
    --node-ink: #6ee7b7;
    --node-support-ink: #a7f3d0;
    --amber-ink: #e8c493;
    --tag-ink: #5eead4;
    --brand-ink: #6ee7b7;
    --topbar-ink: #e5e7eb;
    --danger-ink: #f8a4b2;
    --scroll-thumb: rgba(255, 255, 255, 0.13);
    --scroll-thumb-hover: rgba(255, 255, 255, 0.22);
    --bevel-hi: inset 0 1px 0 rgba(255, 255, 255, 0.07);
    --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.35), 0 1px 2px rgba(0, 0, 0, 0.2);
    --shadow-float: 0 18px 40px -26px rgba(0, 0, 0, 0.7);
    /* 夜间窗体影：深色宿主上需要更实的贴边层与更长的铺开层，才不会被炭灰底吃掉 */
    --shadow-window: 0 1px 3px rgba(0, 0, 0, 0.4), 0 12px 32px -8px rgba(0, 0, 0, 0.55);
    --win-grad: linear-gradient(168deg, #2c2d33 0%, #28292e 52%, #24252a 100%);
    --rail-grad: linear-gradient(180deg, #2b2c32 0%, #25262b 100%);
    --topbar-grad: linear-gradient(180deg, #2d2e34 0%, #28292e 100%);
    --foot-grad: linear-gradient(180deg, #2a2b31 0%, #25262b 100%);
  }
  #patchouli-organic-root.is-dark .ptx-rail { box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.05); }
  #patchouli-organic-root.is-dark .ptx-input { box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.35); }
  /* 荧光绿底上的文字改用深墨：高亮底色配白字在夜间会发灰、刺眼 */
  #patchouli-organic-root.is-dark .ptx-btn.is-primary:hover,
  #patchouli-organic-root.is-dark .ptx-foot-btn.is-core,
  #patchouli-organic-root.is-dark .ptx-foot-btn.is-core:hover,
  #patchouli-organic-root.is-dark .ptx-pill-core { color: #0b1710; }
  /* 夜间危险色压暗一档，保证白字可读，仍是柔和朱红而非鲜红 */
  #patchouli-organic-root.is-dark .ptx-btn.is-danger-solid { color: #fdf3f5; background: #9c3b4c; border-color: #b45263; }
  #patchouli-organic-root.is-dark .ptx-btn.is-danger-solid:hover { background: #ad4658; border-color: #c06070; }
  #patchouli-organic-root.is-dark .ptx-btn.is-danger-solid:active { background: #8f3545; }
  #patchouli-organic-root.is-dark .ptx-winctl-btn.is-close:hover { background: #9c3b4c; border-color: #b45263; }
  #patchouli-organic-root.is-dark .ptx-winctl-btn.is-close:active { background: #8f3545; border-color: #7c2e3d; }
  #patchouli-organic-root.is-dark .ptx-rich-forward-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); }
  #patchouli-organic-root.is-dark .ptx-rich-lightbox::backdrop { background: rgba(10, 11, 13, 0.72); }
  #patchouli-organic-root.is-dark .ptx-bar { background: rgba(255, 255, 255, 0.1); }
  #patchouli-organic-root.is-dark .ptx-theme .ptx-ico-sun { display: block; }
  #patchouli-organic-root.is-dark .ptx-theme .ptx-ico-moon { display: none; }


  /* ===== 阅读区重整：相关线索 / 附录 / 名词注 / 内联昵称 ===== */
  #patchouli-organic-root .ptx-node.is-inline { font-size: 0.92em; line-height: 1.5; padding: 0 6px; margin: 0 2px; border-radius: 4px; font-weight: 600; white-space: nowrap; }

  #patchouli-organic-root .ptx-related { display: flex; flex-direction: column; gap: 0; max-width: 72ch; margin: 0; padding: 0; border-top: 1px solid var(--hairline); background: transparent; }
  #patchouli-organic-root .ptx-link { -webkit-appearance: none; appearance: none; display: grid; grid-template-columns: 22px minmax(0, 1fr) 14px; align-items: start; column-gap: 10px; width: 100%; margin: 0; padding: 9px 6px 9px 2px; border: 0; border-bottom: 1px solid var(--hairline); border-radius: 0; background: transparent; box-shadow: none; font: inherit; text-align: left; color: inherit; cursor: pointer; transition: background-color 0.16s var(--ease-organic); }
  #patchouli-organic-root .ptx-link:last-child { border-bottom: 0; }
  #patchouli-organic-root button.ptx-link:hover, #patchouli-organic-root button.ptx-link:focus-visible { background: var(--surface-mint); border-radius: 6px; outline: none; }
  #patchouli-organic-root button.ptx-link:hover .ptx-link-title, #patchouli-organic-root button.ptx-link:focus-visible .ptx-link-title { color: var(--bio-primary-strong); }
  #patchouli-organic-root button.ptx-link:hover .ptx-link-go, #patchouli-organic-root button.ptx-link:focus-visible .ptx-link-go { color: var(--bio-primary); opacity: 1; transform: translateX(2px); }
  #patchouli-organic-root .ptx-link-no { padding-top: 1px; font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.04em; color: var(--bio-primary-strong); font-variant-numeric: tabular-nums; }
  #patchouli-organic-root .ptx-link-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  #patchouli-organic-root .ptx-link-title { font-size: 13px; line-height: 1.5; font-weight: 600; color: var(--bio-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #patchouli-organic-root .ptx-link-sum { font-size: 11.5px; line-height: 1.55; color: var(--bio-ink-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #patchouli-organic-root .ptx-link-go { align-self: center; color: var(--bio-ink-4); opacity: 0.5; transition: color 0.16s var(--ease-organic), opacity 0.16s var(--ease-organic), transform 0.16s var(--ease-organic); }
  #patchouli-organic-root .ptx-link.is-missing { grid-template-columns: 22px minmax(0, 1fr) auto; cursor: default; opacity: 0.55; }
  #patchouli-organic-root .ptx-link.is-missing .ptx-link-title { font-weight: 500; color: var(--bio-ink-3); }
  #patchouli-organic-root .ptx-link-flag { align-self: center; margin-left: 6px; padding: 0 5px; border: 1px solid var(--hairline); border-radius: var(--r-tag); font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); white-space: nowrap; }
  #patchouli-organic-root .ptx-related-more { margin-top: 0; border-top: 1px solid var(--hairline); }
  #patchouli-organic-root .ptx-related-more > summary { display: flex; align-items: center; gap: 8px; padding: 9px 6px 9px 2px; font-family: var(--bio-mono); font-size: 11px; color: var(--bio-ink-3); list-style: none; cursor: pointer; }
  #patchouli-organic-root .ptx-related-more > summary::-webkit-details-marker { display: none; }
  #patchouli-organic-root .ptx-related-more > summary::after { content: "＋"; margin-left: auto; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-related-more[open] > summary::after { content: "－"; }
  #patchouli-organic-root .ptx-related-more > .ptx-related { border-top: 0; }

  /* 主题时间轴：左侧一条发丝竖线 + 节点圆点；等宽日期、13px/600 可点击标题、一句贡献。
     延续相关线索的安静分隔语法，不做卡片堆叠。 */
  #patchouli-organic-root .ptx-timeline { list-style: none; margin: 0; padding: 0; max-width: 72ch; }
  #patchouli-organic-root .ptx-tl { position: relative; padding: 0 0 15px 20px; }
  #patchouli-organic-root .ptx-tl:last-child { padding-bottom: 0; }
  #patchouli-organic-root .ptx-tl::before { content: ""; position: absolute; left: 3px; top: 0; bottom: 0; width: 1px; background: var(--hairline-strong); }
  #patchouli-organic-root .ptx-tl:last-child::before { bottom: auto; height: 12px; }
  #patchouli-organic-root .ptx-tl-dot { position: absolute; left: 0; top: 5px; width: 7px; height: 7px; border-radius: 50%; background: var(--bio-cyan); box-shadow: 0 0 0 2px var(--bg-membrane); }
  #patchouli-organic-root .ptx-tl-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  #patchouli-organic-root .ptx-tl-date { font-family: var(--bio-mono); font-size: 10.5px; line-height: 1.4; letter-spacing: 0.02em; color: var(--bio-ink-4); font-variant-numeric: tabular-nums; }
  #patchouli-organic-root .ptx-tl-title { -webkit-appearance: none; appearance: none; display: inline; align-self: flex-start; max-width: 100%; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; font: inherit; font-size: 13px; line-height: 1.5; font-weight: 600; color: var(--bio-ink); text-align: left; cursor: pointer; transition: color 0.16s var(--ease-organic); }
  #patchouli-organic-root button.ptx-tl-title:hover, #patchouli-organic-root button.ptx-tl-title:focus-visible { color: var(--bio-primary-strong); outline: none; }
  #patchouli-organic-root span.ptx-tl-title { cursor: default; color: var(--bio-ink-2); font-weight: 500; }
  #patchouli-organic-root .ptx-tl-note { margin: 2px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--bio-ink-4); text-shadow: none; }

  #patchouli-organic-root .ptx-appendix { margin-top: 18px; border: 0; border-top: 1px solid var(--hairline); border-radius: 0; background: transparent; box-shadow: none; }
  #patchouli-organic-root .ptx-appendix > summary { display: flex; align-items: center; gap: 8px; padding: 11px 2px; font-family: var(--bio-mono); font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em; color: var(--bio-primary-strong); list-style: none; cursor: pointer; }
  #patchouli-organic-root .ptx-appendix > summary::-webkit-details-marker { display: none; }
  #patchouli-organic-root .ptx-appendix > summary::after { content: "＋"; margin-left: auto; font-family: var(--bio-ui); font-size: 13px; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-appendix[open] > summary::after { content: "－"; }
  #patchouli-organic-root .ptx-appendix .ptx-points, #patchouli-organic-root .ptx-appendix .ptx-quotes { padding: 0; }
  #patchouli-organic-root .ptx-app-h { margin: 18px 0 2px; padding-top: 12px; border-top: 1px solid var(--hairline); font-family: var(--bio-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--bio-secondary); }

  #patchouli-organic-root .ptx-points { counter-reset: point; display: block; }
  #patchouli-organic-root .ptx-point { counter-increment: point; position: relative; display: flex; flex-direction: column; gap: 6px; padding: 12px 0 12px 30px; border: 0; border-bottom: 1px solid var(--hairline); border-radius: 0; background: transparent; box-shadow: none; }
  #patchouli-organic-root .ptx-point:last-child { border-bottom: 0; }
  #patchouli-organic-root .ptx-point::before { content: counter(point, decimal-leading-zero); position: absolute; left: 0; top: 14px; font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.03em; color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-point-view { font-size: 13.5px; font-weight: 650; line-height: 1.55; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-voice { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
  #patchouli-organic-root .ptx-voice-l { min-width: 24px; font-family: var(--bio-mono); font-size: 9.5px; letter-spacing: 0.06em; color: var(--bio-ink-4); }
  #patchouli-organic-root .ptx-voice.is-support .ptx-voice-l { color: rgba(10, 124, 58, 0.8); }
  #patchouli-organic-root .ptx-voice.is-dissent .ptx-voice-l { color: rgba(138, 91, 22, 0.85); }
  #patchouli-organic-root .ptx-point-line { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 8px; font-size: 12.5px; line-height: 1.7; color: var(--bio-ink-2); text-shadow: none; }
  #patchouli-organic-root .ptx-point-line b { margin: 0; padding-top: 2px; font-family: var(--bio-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.04em; color: var(--bio-ink-4); }

  #patchouli-organic-root .ptx-quotes { display: block; }
  /* 教科书式引诗：去掉竖线，整段居中，以留白与引号承担引用层级 */
  #patchouli-organic-root .ptx-quote { padding: 10px 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; text-align: center; }

  #patchouli-organic-root .ptx-quote-t { font-size: 13px; line-height: 1.8; color: var(--bio-ink-2); text-align: center; }
  #patchouli-organic-root .ptx-quote-a { margin-top: 8px; font-family: var(--bio-mono); font-size: 10.5px; color: rgba(138, 91, 22, 0.9); text-align: center; }

  #patchouli-organic-root .ptx-gloss { max-width: 72ch; margin: 0; padding: 0; }
  #patchouli-organic-root .ptx-gloss-row { display: grid; grid-template-columns: minmax(64px, 104px) minmax(0, 1fr); align-items: start; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--hairline); font-size: 13px; line-height: 1.7; }
  #patchouli-organic-root .ptx-gloss-row:first-child { border-top: 1px solid var(--hairline); }
  #patchouli-organic-root .ptx-gloss-row dt { margin: 0; font-size: 12.5px; font-weight: 650; color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-gloss-row dd { margin: 0; color: var(--bio-ink-2); text-shadow: none; }
  #patchouli-organic-root .ptx-window.is-narrow .ptx-gloss-row { grid-template-columns: 1fr; gap: 2px; }


  /* 最终一致性：内联昵称略放大；落点改为无卡片的双栏发丝线结构 */
  #patchouli-organic-root .ptx-node.is-inline { font-size: 0.95em; padding: 0 7px; line-height: 1.5; }
  #patchouli-organic-root .ptx-outcome { gap: 24px; padding-top: 2px; }
  #patchouli-organic-root .ptx-outcome-col { padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  #patchouli-organic-root .ptx-outcome-l { margin-bottom: 6px; font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.06em; color: var(--bio-ink-3); }
  #patchouli-organic-root .ptx-outcome-col.is-consensus .ptx-outcome-l { color: var(--bio-primary-strong); }
  #patchouli-organic-root .ptx-outcome-col.is-open .ptx-outcome-l { color: var(--bio-violet-strong); }

  /* 争点对照：真正的表格，便于横向对照；表头固定、单元格自动换行 */
  #patchouli-organic-root .ptx-table-wrap { width: 100%; overflow-x: auto; }
  #patchouli-organic-root .ptx-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; line-height: 1.65; }
  #patchouli-organic-root .ptx-table th { padding: 7px 8px; text-align: left; font-family: var(--bio-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em; color: var(--bio-slate); border-bottom: 1px solid var(--hairline-strong); white-space: nowrap; }
  #patchouli-organic-root .ptx-table td { padding: 10px 8px; vertical-align: top; border-bottom: 1px solid var(--hairline); color: var(--bio-ink-2); overflow-wrap: anywhere; }
  #patchouli-organic-root .ptx-table tbody tr:last-child td { border-bottom: 0; }
  #patchouli-organic-root .ptx-table th:nth-child(1) { width: 26px; }
  #patchouli-organic-root .ptx-table th:nth-child(2) { width: 24%; }
  #patchouli-organic-root .ptx-table th:nth-child(3), #patchouli-organic-root .ptx-table th:nth-child(4) { width: 16%; }
  #patchouli-organic-root .ptx-table th:nth-child(5), #patchouli-organic-root .ptx-table th:nth-child(6) { width: 21%; }
  #patchouli-organic-root .ptx-table td:nth-child(1) { padding-left: 0; }
  #patchouli-organic-root .ptx-table td:nth-child(6) { padding-right: 0; }
  #patchouli-organic-root .ptx-td-no { font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.03em; color: var(--bio-primary-strong); font-variant-numeric: tabular-nums; }
  #patchouli-organic-root .ptx-td-view { font-weight: 600; color: var(--bio-ink); }
  #patchouli-organic-root .ptx-td-side .ptx-node { display: inline-flex; margin: 0 4px 4px 0; padding: 0 6px; font-size: 10.5px; line-height: 1.6; }
  #patchouli-organic-root .ptx-td-body { font-size: 11.5px; line-height: 1.7; }
  #patchouli-organic-root .ptx-td-empty { color: var(--bio-ink-4); }

  /* 对照表转置：属性竖排、观点横排；只保留表头一条横线 */
  #patchouli-organic-root .ptx-table.ptx-compare thead th { padding: 8px 10px; border-bottom: 1px solid var(--hairline); }
  #patchouli-organic-root .ptx-table.ptx-compare thead th:first-child { width: 64px; padding-left: 0; }
  #patchouli-organic-root .ptx-table.ptx-compare thead th:not(:first-child) { width: auto; }
  #patchouli-organic-root .ptx-table.ptx-compare tbody th { width: 64px; padding: 11px 8px; text-align: center; vertical-align: top; font-family: var(--bio-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em; color: var(--bio-ink-3); border: 0; }
  #patchouli-organic-root .ptx-table.ptx-compare tbody td { padding: 11px 10px; vertical-align: top; border: 0; color: var(--bio-ink-2); }
  #patchouli-organic-root .ptx-table.ptx-compare tbody tr:first-child td, #patchouli-organic-root .ptx-table.ptx-compare tbody tr:first-child th { padding-top: 12px; }
  #patchouli-organic-root .ptx-table.ptx-compare tbody tr:last-child td, #patchouli-organic-root .ptx-table.ptx-compare tbody tr:last-child th { padding-bottom: 16px; }
  #patchouli-organic-root .ptx-table.ptx-compare .ptx-td-view { font-size: 12.5px; line-height: 1.6; }
  #patchouli-organic-root .ptx-table.ptx-compare .ptx-td-body { font-size: 11.5px; line-height: 1.7; }

  /* 横线收敛：列表、名词注、摘句、附录小标题不再逐行画线 */
  #patchouli-organic-root .ptx-link { padding: 10px 8px; border-bottom: 0; border-radius: 6px; }
  #patchouli-organic-root .ptx-related-more { border-top: 0; }
  #patchouli-organic-root .ptx-gloss-row { padding: 9px 0; border-top: 0 !important; border-bottom: 0; }
  #patchouli-organic-root .ptx-quote { border-bottom: 0; }
  #patchouli-organic-root .ptx-app-h { margin: 16px 0 4px; padding-top: 0; border-top: 0; }

  /* 正文占满版心并水平居中；段落首行缩进两字 */
  #patchouli-organic-root .ptx-lead, #patchouli-organic-root .ptx-cause, #patchouli-organic-root .ptx-narrative, #patchouli-organic-root .ptx-gloss, #patchouli-organic-root .ptx-related, #patchouli-organic-root .ptx-outcome { width: 100%; max-width: none; margin-left: 0; margin-right: 0; }
  #patchouli-organic-root .ptx-narrative p { text-indent: 2em; }

  /* 附录小标题不再单独画线；只保留附录顶线与表头线 */
  #patchouli-organic-root .ptx-app-h { border: 0 !important; }
  #patchouli-organic-root .ptx-quotes { border-top: 0 !important; }

  /* 争点对照：轻量网格边框 + 全部左对齐（内容不再居中） */
  #patchouli-organic-root .ptx-table.ptx-compare {
    border: 1px solid var(--hairline);
    border-collapse: separate;
    border-spacing: 0;
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
    text-align: left;
  }
  #patchouli-organic-root .ptx-table.ptx-compare th,
  #patchouli-organic-root .ptx-table.ptx-compare td { text-align: left; }
  #patchouli-organic-root .ptx-table.ptx-compare thead th {
    background: transparent;
    border-bottom: 1px solid var(--hairline-strong);
  }
  #patchouli-organic-root .ptx-table.ptx-compare thead th + th { border-left: 1px solid var(--hairline); }
  #patchouli-organic-root .ptx-table.ptx-compare tbody th {
    background: transparent;
    border-right: 1px solid var(--hairline);
  }
  #patchouli-organic-root .ptx-table.ptx-compare tbody td + td { border-left: 1px solid var(--hairline); }
  #patchouli-organic-root .ptx-table.ptx-compare tbody tr:not(:last-child) > th,
  #patchouli-organic-root .ptx-table.ptx-compare tbody tr:not(:last-child) > td { border-bottom: 1px solid var(--hairline); }

  /* 表头与行首属性标签居中，内容左对齐 */
  #patchouli-organic-root .ptx-table.ptx-compare thead th,
  #patchouli-organic-root .ptx-table.ptx-compare tbody th { text-align: center; }
  #patchouli-organic-root .ptx-table.ptx-compare tbody td { text-align: left; }
  @media (max-width: 780px) {
    #patchouli-organic-root .ptx-window { width: calc(100vw - 24px); height: calc(100vh - 48px); }
  }

  @media (max-width: 560px) {
    #patchouli-organic-root .ptx-pill { right: 14px; bottom: 96px; }
  }

  @media (prefers-reduced-motion: reduce) {
    #patchouli-organic-root * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
  }

  #patchouli-organic-root.ptx-hidden { display: none; }
  #patchouli-organic-root .ptx-window,
  #patchouli-organic-root .ptx-pill,
  #patchouli-organic-root .ptx-toast { pointer-events: auto; }

`;

/* ------------------------------------------------------------------ *
 * 5. 状态与 DOM 引用
 * ------------------------------------------------------------------ */

/* 面板设置（localStorage，独立页 / dock / Console 三处共用同一键）。
 * 读取容错：损坏、越界、类型不符的字段一律回退保守默认值。 */
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function defaultSettings() {
  return {
    autoDock: true,
    tickerCount: TICKER_COUNT_DEFAULT,
    tickerInterval: TICKER_INTERVAL_DEFAULT,
    collapsedSections: {},
  };
}

function loadSettings() {
  const out = defaultSettings();
  let raw = null;
  try { raw = window.localStorage.getItem(SETTINGS_KEY); } catch (err) { raw = null; }
  if (!raw) return out;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') return out;
  if (typeof parsed.autoDock === 'boolean') out.autoDock = parsed.autoDock;
  out.tickerCount = clampInt(parsed.tickerCount, TICKER_COUNT_MIN, TICKER_COUNT_MAX, out.tickerCount);
  out.tickerInterval = clampInt(parsed.tickerInterval, TICKER_INTERVAL_MIN, TICKER_INTERVAL_MAX, out.tickerInterval);
  if (parsed.collapsedSections && typeof parsed.collapsedSections === 'object') {
    for (const [key, value] of Object.entries(parsed.collapsedSections)) {
      if (value === true) out.collapsedSections[String(key)] = true;
    }
  }
  return out;
}

function saveSettings() {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      autoDock: state.settings.autoDock,
      tickerCount: state.settings.tickerCount,
      tickerInterval: state.settings.tickerInterval,
      collapsedSections: state.settings.collapsedSections,
    }));
  } catch (err) { /* 隐私模式或配额异常时静默降级：仅本次会话生效 */ }
}

/* ---------------- 卡片 / 列表视图模式（唯一键 patchouli-view-mode） ----------------
 * 布局偏好独立于 SETTINGS：重置面板设置不应把用户刚选的布局一起清掉。
 * 读取容错同设置项——任何异常 / 非法值都退回默认的卡片模式。 */
function readStoredViewMode() {
  let raw = null;
  try { raw = window.localStorage.getItem(VIEW_KEY); } catch (err) { raw = null; }
  return raw === 'list' ? 'list' : 'card';
}

function setViewMode(mode) {
  state.viewMode = mode === 'list' ? 'list' : 'card';
  try { window.localStorage.setItem(VIEW_KEY, state.viewMode); } catch (err) { /* 隐私模式：仅本次会话生效 */ }
}

/* ---------------- 群聊范围（唯一键 patchouli-channel-scope） ----------------
 * 群聊筛选是用户在顶栏做的选择，属于跨会话记忆：下次打开面板仍停在同一个群。
 * 读取容错："all" / 空值 / 读取异常都收敛到"全部"，具体群聊是否仍存在由
 * loadChannels 的成员校验兜底（群被移除时回落"全部"）。 */
function readStoredChannel() {
  let raw = null;
  try { raw = window.localStorage.getItem(CHANNEL_SCOPE_KEY); } catch (err) { raw = null; }
  const value = String(raw == null ? '' : raw).trim();
  return value || 'all';
}

function setChannelScope(value) {
  try { window.localStorage.setItem(CHANNEL_SCOPE_KEY, value || 'all'); } catch (err) { /* 隐私模式：仅本次会话生效 */ }
}

/* ---------------- 明暗主题（唯一键 patchouli-theme，缺省跟随宿主） ----------------
 * 变量覆盖全部落在根容器的 .is-dark 上，窗口内不持有任何主题分支；
 * 独立页 / 内嵌组件 / 本客户端共用同一套切换逻辑与同一份记忆。
 * 缺省主题优先跟随宿主（Koishi 控制台深色主题）：本客户端是挂在宿主 body 上的全屏浮层，
 * 宿主深色时窗口还保持亮白纸面，就是一块刺眼的白板。 */
function systemTheme() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch (err) { /* 无 matchMedia 的老浏览器回退浅色 */ }
  return 'light';
}

function readStoredTheme() {
  let raw = null;
  try { raw = window.localStorage.getItem(THEME_KEY); } catch (err) { raw = null; }
  return raw === 'dark' || raw === 'light' ? raw : null;
}

/* 宿主底色亮度：只认 computed backgroundColor，alpha 为 0 视为“这层没铺底色”，
 * 继续往下一层（body → html）找。Koishi 深色主题的底色亮度在 20~40 之间，
 * 日间纸面在 240 以上，128 一刀切足够区分。 */
function hostLuma(el) {
  if (!el || typeof window.getComputedStyle !== 'function') return null;
  let raw = '';
  try { raw = window.getComputedStyle(el).backgroundColor; } catch (err) { return null; }
  const match = /rgba?\(\s*([0-9.]+)[,\s/]+([0-9.]+)[,\s/]+([0-9.]+)(?:[,\s/]+([0-9.]+)(%?))?\s*\)/i.exec(String(raw || ''));
  if (!match) return null;
  const alpha = match[4] == null ? 1 : (match[5] ? Number(match[4]) / 100 : Number(match[4]));
  if (!isFinite(alpha) || alpha <= 0) return null;
  return 0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3]);
}

/* 宿主 class 上的主题语义令牌：控制台可能写 dark / theme-dark / is-dark（浅色同理），
 * 逐个显式列举，避免子串匹配把 .dark-mode-toggle 之类误判成夜间主题。 */
const DARK_TOKENS = ['dark', 'theme-dark', 'is-dark', 'dark-theme'];
const LIGHT_TOKENS = ['light', 'theme-light', 'is-light', 'light-theme'];

function tokenTheme(el) {
  if (!el || !el.classList) return null;
  for (const token of DARK_TOKENS) if (el.classList.contains(token)) return 'dark';
  for (const token of LIGHT_TOKENS) if (el.classList.contains(token)) return 'light';
  return null;
}

/* 宿主暗色检测。宿主可能用 class="dark" / ["dark-mode"] / theme-dark、data-theme="dark"，
 * 也可能只是把 <body> 刷成深色，所以三种信号依次判定：
 * 显式声明 → 宿主实际底色亮度 → 系统偏好（两者都读不到时的兜底）。 */
function detectHostDark() {
  if (typeof document === 'undefined') return false;
  const hosts = [document.body, document.documentElement];
  for (const el of hosts) {
    if (!el) continue;
    const token = tokenTheme(el);
    if (token === 'dark') return true;
    if (token === 'light') return false;
    const declared = el.getAttribute('data-theme');
    if (declared === 'dark') return true;
    if (declared === 'light') return false;
  }
  for (const el of hosts) {
    const luma = hostLuma(el);
    if (luma != null) return luma < 128;
  }
  return systemTheme() === 'dark';
}

/* 生效主题的唯一裁决点。宿主深色优先：控制台深底下，任何一次旧测试 / 旧会话留下的
 * "light" 记忆都会把窗口刷成刺眼白板，因此宿主判定为深色时直接以夜间渲染，持久化的
 * 浅色不再生效；本次会话内用户手动点过日 / 月按钮则尊重手动选择（manualTheme）。 */
let manualTheme = null;

function desiredTheme() {
  if (manualTheme === 'dark' || manualTheme === 'light') return manualTheme;
  if (detectHostDark()) return 'dark';
  return readStoredTheme() || 'light';
}

function applyTheme(theme, persist) {
  const next = theme === 'dark' ? 'dark' : 'light';
  state.theme = next;
  if (rootEl) rootEl.classList.toggle('is-dark', next === 'dark');
  const button = rootEl ? rootEl.querySelector('.ptx-theme') : null;
  if (button) {
    const label = next === 'dark' ? '切换日间主题' : '切换夜间主题';
    button.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tip', label);
  }
  if (persist) {
    try { window.localStorage.setItem(THEME_KEY, next); } catch (err) { /* 隐私模式：仅本次会话生效 */ }
  }
}

function toggleTheme() {
  manualTheme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(manualTheme, true);
}

/* 宿主换肤跟随：宿主 class / data-theme / style 任一变化都重新判定一次。
 * 裁决统一走 desiredTheme()：本会话内手动选择 > 宿主深色 > 持久化偏好 > 浅色。 */
let hostObserver = null;

function syncHostTheme() {
  applyTheme(desiredTheme(), false);
}

function watchHostTheme() {
  if (hostObserver || typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
  const targets = [document.documentElement, document.body].filter(Boolean);
  if (!targets.length) return;
  /* 连续换肤（宿主切主题往往改一串 class）合并成一次：60ms 内只判一次，避免反复重算样式。 */
  let queued = false;
  hostObserver = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; syncHostTheme(); }, 60);
  });
  for (const target of targets) {
    hostObserver.observe(target, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  }
}

const state = {
  mounted: false,
  visible: false,
  collapsed: false,
  /* 本插件页判定（唯一真源）：门禁、取数、401 兜底都只看它。
     浮窗挂在**任何** /plugins/** 页上，但只有本插件页才展开、才弹门禁、才拉 /api。 */
  own: false,
  /* 数据面是否在跑：只有本插件页为真；mount() 只建壳，零请求。 */
  dataFlow: false,
  maximized: false,
  sized: false,
  restoreStyle: '',
  settings: loadSettings(),
  theme: detectHostDark() ? 'dark' : 'light',
  stage: 'entries',
  /* 进入正文时记住来源列表页签：返回键与页签高亮都回到它 */
  listStage: 'entries',
  viewMode: readStoredViewMode(),
  entries: [],
  entriesLoaded: false,
  entriesError: '',
  latestEntries: [],
  latestLoaded: false,
  latestError: false,
  channels: DEFAULT_CHANNELS.slice(),
  channel: readStoredChannel(),
  keyword: '',
  activeId: null,
  detail: null,
  detailError: '',
  detailLoading: false,
  status: null,
  statusChecked: false,
  /* 接口可用性账：连续命中「404 / 非 JSON」的次数与置位（见 requestJson / noteApiRead）。
     置位只在用户点开胶囊认领的页面上显示成「接口不可用」，不撤销认领。 */
  apiStreak: 0,
  apiUnavailable: false,
  tickerIndex: 0,
  lastView: '',
  idleTimer: null,
  refreshTimer: null,
  tickerTimer: null,
  tickerSwap: null,
  routeTimer: null,
  rafId: 0,
  pending: null,
  editingEntryId: null,
  deleteArmed: false,
  clearArmed: false,
  /* <details> 开合态记忆（key → true/false）：render() 会整页重写 innerHTML，
     用户开过 / 关过的折叠区（附录、其余线索）不能弹回默认态；缺省值由渲染处给出 */
  folds: {},
  /* 系统提示词：服务端真值，进入设置页时拉取；data 为 null 表示尚未读取 */
  prompt: { data: null, error: '' },
  /* 运行时设置（触发算法 / 主题校准 / 素材池与长图 / 本地裁判）：
     服务端真值 + meta 字段表，进入设置页时拉取；sections 保存合并后的段值 */
  runtimeSettings: { sections: null, meta: [], error: '', loading: false, seq: {}, draftMode: '' },
  /* 出图选项（服务端持久化）：maskNames=false 时按原昵称出图。 */
  cardSettings: { settings: { maskNames: true }, error: '' },
};

let rootEl = null;
let frameEl = null;
let pillEl = null;
let viewportEl = null;
let tickerEl = null;
let phaseEl = null;
let toastEl = null;
let gearBtnEl = null;
let latestTimer = null;
/* 群聊范围：自绘 listbox（原生 select 的系统弹层与整体材质冲突，故整块自绘） */
let channelChip = null;
let channelToggle = null;
let channelMenu = null;
let searchInput = null;
let dragHandle = null;

/* ------------------------------------------------------------------ *
 * 6. 渲染
 * ------------------------------------------------------------------ */

function renderHead(title, sub, extra) {
  return `<div class="ptx-vhead"><span class="ptx-vhead-bar"></span>` +
    `<span class="ptx-vhead-title">${escapeHtml(title)}</span>` +
    `<span class="ptx-vhead-sub">${escapeHtml(sub)}</span>` +
    `${extra || ''}</div>`;
}

/* 卡片 / 列表切换块：标题行右端的分段胶囊。两枚按钮共用一个 data-act，
   各自带 data-mode 与 aria-pressed，点击即落库并整屏重绘（滚动位置由 lastView 保持）。 */
function renderViewToggle() {
  const card = state.viewMode !== 'list';
  const btn = (mode, icon, label, active) =>
    `<button type="button" class="ptx-view-btn${active ? ' is-active' : ''}"` +
    ` data-act="view-mode" data-mode="${mode}"` +
    ` aria-pressed="${active ? 'true' : 'false'}" ${tip(label)} aria-label="${label}">` +
    organicIcon(icon, 12) + '</button>';
  return `<div class="ptx-view-mode" role="group" aria-label="词条布局">` +
    btn('card', 'grid', '卡片视图', card) +
    btn('list', 'list', '列表视图', !card) +
  `</div>`;
}

/* 空状态：中文短标题 + 一句可执行提示 */
function renderDormant(title, hint) {
  return `<div class="ptx-dormant">${nucleusSvg()}` +
    `<span class="ptx-dormant-t">${escapeHtml(title)}</span>` +
    `<span class="ptx-dormant-s">${escapeHtml(hint)}</span></div>`;
}

function renderSection(title, inner) {
  return `<div class="ptx-sec"><div class="ptx-sec-h">${escapeHtml(title)}</div>${inner}</div>`;
}

/* ---------------- 运行时设置（服务端真值，/api/settings） ----------------
 * 字段清单完全由服务端 `meta` 驱动：这里只声明分组归属与「常显」键，
 * 其余字段自动落进分组底部「其余参数」折叠——服务端新增字段不需要改前端。
 * 保存是单字段补丁（POST {section, patch}），成功后行内回写「已保存」；
 * 失败整行回滚到服务端现值并就地显示原因，不弹窗、不 toast。 */
const RUNTIME_GROUPS = [
  { id: 'trigger', title: '触发算法', sections: ['trigger'], primary: ['triggerMode', 'windowSizeSeconds', 'burstMultiplier', 'minBurstRate', 'quiescenceSeconds', 'coolingRatioThreshold', 'thetaMin', 'rhoMin', 'densityMultiplier', 'peakCoolFraction', 'dispatchMargin'] },
  { id: 'topics', title: '主题校准', sections: ['topics'], primary: ['enabled', 'hour', 'minute', 'mergeThreshold', 'minEntries', 'lookbackDays'] },
  { id: 'media', title: '素材池与长图', sections: ['media', 'query'], primary: ['offline', 'lowWater', 'batch', 'cooldownHours', 'cardMaxHeight'] },
  { id: 'judge', title: '本地裁判服务', sections: ['judge'], primary: ['enabled', 'baseURL', 'model', 'timeoutMs'] },
];
/* 枚举显示别名：只改文案，不改提交值；未收录的值原样显示。 */
const RUNTIME_OPTION_LABELS = { triggerMode: { potential: '势能', rate: '速率' } };
/* 凭据类字段以密码框呈现（服务端 meta 的 `secret` 是首选判据，键名正则只作兜底） */
const RUNTIME_SECRET_KEY = /(?:apikey|token|secret)/i;
const RUNTIME_SECRET_PLACEHOLDER = '已配置（留空不修改）';

function runtimeIsSecret(meta) {
  if (!meta) return false;
  return meta.secret === true || RUNTIME_SECRET_KEY.test(String(meta.key));
}

/* 读路径的密钥恒为空串，同段 `secretConfigured.<key>` 才是「有没有存过值」。 */
function runtimeSecretConfigured(section, key) {
  const bag = state.runtimeSettings.sections && state.runtimeSettings.sections[section];
  const flags = bag && typeof bag === 'object' ? bag.secretConfigured : null;
  return Boolean(flags && typeof flags === 'object' && flags[key] === true);
}

function runtimeMeta(section, key) {
  for (const item of state.runtimeSettings.meta) {
    if (item && item.section === section && item.key === key) return item;
  }
  return null;
}

function runtimeValue(section, key) {
  const bag = state.runtimeSettings.sections && state.runtimeSettings.sections[section];
  return bag && typeof bag === 'object' ? bag[key] : undefined;
}

/* 判据模式：只有 trigger 段按 triggerMode 分流；未知值不过滤（宁可全显示，也不吞字段）。
 * draftMode 是切换模式后、保存回执到达前的本地预览值：重渲染只用本地 sections，
 * 不重新 GET。 */
function runtimeMode() {
  const draft = state.runtimeSettings.draftMode;
  if (draft === 'potential' || draft === 'rate') return draft;
  const value = runtimeValue('trigger', 'triggerMode');
  return value === 'potential' || value === 'rate' ? value : '';
}

/* 字段的模式白名单：不写 modes = 两种判据都显示；空数组 = 两种模式都不适用（shadow 观测字段）。 */
function runtimeFieldModes(meta) {
  return Array.isArray(meta && meta.modes) ? meta.modes.map(String) : null;
}

/* 控件显示值：判据模式切换后、保存回执到达前，下拉先显示本地选择 */
function runtimeDisplayValue(meta) {
  const draft = state.runtimeSettings.draftMode;
  if (String(meta.section) === 'trigger' && String(meta.key) === 'triggerMode' &&
      (draft === 'potential' || draft === 'rate')) return draft;
  return runtimeValue(String(meta.section), String(meta.key));
}

/* 范围提示只放上下限，单位已在 label 里，控制在一行内 */
function runtimeHint(meta) {
  if (meta.type !== 'number') return '';
  const min = typeof meta.min === 'number' ? meta.min : null;
  const max = typeof meta.max === 'number' ? meta.max : null;
  if (min === null && max === null) return '';
  return `${min === null ? '' : min}–${max === null ? '' : max}`;
}

function runtimeTextControl(meta, value, attrs, aria) {
  const secret = runtimeIsSecret(meta);
  const type = secret ? 'password' : 'text';
  /* 已存的密钥只回显空串：没有占位文案时看起来像「没配置」，用户会重填甚至以为丢了。 */
  const placeholder =
    secret && runtimeSecretConfigured(String(meta.section), String(meta.key))
      ? ` placeholder="${RUNTIME_SECRET_PLACEHOLDER}"`
      : '';
  return `<input class="ptx-input ptx-settings-text" type="${type}"${attrs} autocomplete="off" spellcheck="false"` +
    ` value="${escapeHtml(value == null ? '' : String(value))}"${placeholder}${aria}>`;
}

function runtimeControl(meta) {
  const section = String(meta.section);
  const key = String(meta.key);
  const value = runtimeDisplayValue(meta);
  const attrs = ` data-cfg-section="${escapeHtml(section)}" data-cfg-key="${escapeHtml(key)}" data-cfg-type="${escapeHtml(String(meta.type || 'string'))}"`;
  const aria = ` aria-label="${escapeHtml(String(meta.label || key))}"`;
  if (meta.type === 'boolean') {
    const on = value === true;
    return `<button type="button" class="ptx-switch${on ? ' is-on' : ''}" data-cfg-toggle="1"${attrs}` +
      ` role="switch" aria-checked="${on ? 'true' : 'false'}"${aria}></button>`;
  }
  if (meta.type === 'enum') {
    const options = Array.isArray(meta.options) ? meta.options.map((item) => String(item)) : [];
    if (!options.length) return runtimeTextControl(meta, value, attrs, aria);
    const alias = RUNTIME_OPTION_LABELS[key] || {};
    const current = value == null ? options[0] : String(value);
    const body = options.map((option) =>
      `<option value="${escapeHtml(option)}"${option === current ? ' selected' : ''}>${escapeHtml(alias[option] || option)}</option>`).join('');
    return `<select class="ptx-input ptx-settings-select"${attrs}${aria}>${body}</select>`;
  }
  if (meta.type === 'number') {
    const step = typeof meta.step === 'number' && meta.step > 0 ? meta.step : 'any';
    return `<input class="ptx-input ptx-settings-num" type="number"${attrs}` +
      `${typeof meta.min === 'number' ? ` min="${meta.min}"` : ''}` +
      `${typeof meta.max === 'number' ? ` max="${meta.max}"` : ''} step="${step}"` +
      ` value="${escapeHtml(value == null ? '' : String(value))}"${aria}>`;
  }
  return runtimeTextControl(meta, value, attrs, aria);
}

function runtimeRow(meta) {
  const label = String(meta.label || meta.key || '');
  const hint = runtimeHint(meta);
  const rowKey = `${String(meta.section)}.${String(meta.key)}`;
  return `<div class="ptx-settings-row" data-cfg-row="${escapeHtml(rowKey)}">` +
    `<span class="ptx-settings-label">${escapeHtml(label)}${hint ? `<em>${escapeHtml(hint)}</em>` : ''}</span>` +
    `<span class="ptx-settings-ctl"><span class="ptx-cfg-row-msg" role="status" aria-live="polite"></span>` +
      runtimeControl(meta) +
    `</span>` +
  `</div>`;
}

/* 折叠块：箭头 + 标题 + 计数徽标；开合态沿用 state.folds 的同一条记忆路径 */
function runtimeFold(foldId, title, entries) {
  return `<details class="ptx-cfg-fold" data-fold="${foldId}"${state.folds[foldId] === true ? ' open' : ''}>` +
    `<summary><span class="ptx-cfg-fold-arrow">${organicIcon('chevron', 13)}</span>` +
      `<span class="ptx-cfg-fold-title">${escapeHtml(title)}</span>` +
      `<span class="ptx-cfg-fold-count">${entries.length}</span></summary>` +
    `<div class="ptx-cfg-foldbody">${entries.map(runtimeRow).join('')}</div>` +
  `</details>`;
}

/* 一个分区的行体：常显行 + 「其余参数」折叠（外层分区由 renderRuntimeGroup 包）
 * 常显行的顺序跟 primary 声明走（判据模式在最前），其余字段保持服务端 meta 顺序。
 * trigger 段按当前 triggerMode 过滤：不属于当前判据的字段直接不渲染、不计数，
 * 也不做第二种折叠；不写 modes 的字段两种模式都出现在常显组。
 * modes 为空数组的字段两种模式都不适用（仅 shadow 观测生效），同样不渲染。 */
function renderRuntimeGroupBody(group) {
  const entries = state.runtimeSettings.meta.filter((item) => item && group.sections.includes(item.section));
  if (!entries.length) return '';
  const mode = group.id === 'trigger' ? runtimeMode() : '';
  const visible = [];
  for (const entry of entries) {
    const modes = group.id === 'trigger' ? runtimeFieldModes(entry) : null;
    if (modes && (mode ? !modes.includes(mode) : modes.length === 0)) continue;
    visible.push(entry);
  }
  const primary = [];
  const rest = [];
  for (const key of group.primary) {
    const entry = visible.find((item) => String(item.key) === String(key));
    if (entry) primary.push(entry);
  }
  for (const entry of visible) {
    if (!primary.includes(entry)) rest.push(entry);
  }
  const rows = primary.length ? primary.map(runtimeRow).join('') : `<div class="ptx-settings-note">本分区暂无可调项</div>`;
  const fold = rest.length ? runtimeFold(`cfg-${group.id}`, '其余参数', rest) : '';
  return `${rows}${fold}`;
}

function renderRuntimeGroup(group) {
  const body = renderRuntimeGroupBody(group);
  if (!body) return '';
  /* 组内容装进稳定容器：判据模式切换只替换这一块，设置页其它 DOM 与滚动不动 */
  return renderSection(group.title, `<div data-cfg-group="${escapeHtml(group.id)}">${body}</div>`);
}

/* 单组局部刷新：切换判据模式后只重排该组的字段，不重绘整个设置页 */
function refreshRuntimeGroup(groupId) {
  if (!viewportEl) return;
  const group = RUNTIME_GROUPS.find((item) => item.id === groupId);
  const holder = group ? viewportEl.querySelector(`[data-cfg-group="${groupId}"]`) : null;
  if (!holder) return;
  holder.innerHTML = renderRuntimeGroupBody(group);
}

function renderRuntimeSettings() {
  const runtime = state.runtimeSettings;
  if (runtime.error) {
    return renderSection('运行时参数',
      `<div class="ptx-settings-note">读取失败：${escapeHtml(runtime.error)}</div>` +
      `<div class="ptx-settings-row"><span class="ptx-settings-label">服务端设置</span>` +
      `<button class="ptx-btn" data-act="reload-runtime" type="button">重新读取</button></div>`);
  }
  if (!runtime.meta.length) {
    return renderSection('运行时参数',
      `<div class="ptx-settings-note">${runtime.loading ? '正在读取运行时设置…' : '服务端未返回可调字段'}</div>`);
  }
  const known = new Set();
  for (const group of RUNTIME_GROUPS) for (const section of group.sections) known.add(section);
  const extraSections = [];
  for (const item of runtime.meta) {
    if (item && !known.has(item.section) && !extraSections.includes(item.section)) extraSections.push(item.section);
  }
  const groups = RUNTIME_GROUPS.map(renderRuntimeGroup).join('');
  /* 服务端新增的段不得静默消失：兜底成「其他参数」，正常配置下不会出现 */
  const extra = extraSections.length
    ? renderRuntimeGroup({ id: 'extra', title: '其他参数', sections: extraSections, primary: runtime.meta.filter((item) => item && extraSections.includes(item.section)).map((item) => String(item.key)) })
    : '';
  return groups + extra;
}

function renderBullets(items, fallback) {
  if (!Array.isArray(items) || !items.length) return `<div class="ptx-text">${escapeHtml(fallback)}</div>`;
  return `<ul class="ptx-bul">${items.map((line) => `<li>${escapeHtml(String(line))}</li>`).join('')}</ul>`;
}

function extractMarkdownSection(markdown, headings) {
  if (!markdown) return '';
  const lines = String(markdown).split('\n');
  const collected = [];
  let capturing = false;
  for (const line of lines) {
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(line.trim());
    if (heading) {
      if (capturing) break;
      const name = heading[1].toLowerCase();
      if (headings.some((item) => name.includes(item))) capturing = true;
      continue;
    }
    if (capturing) collected.push(line);
  }
  return collected.join('\n').trim();
}

function renderVoice(tone, label, list) {
  if (!list.length) return '';
  return `<div class="ptx-voice is-${tone}"><span class="ptx-voice-l">${label}</span>` +
    list.map((name) => nodeTag(name, tone)).join('') + '</div>';
}

function renderSpeakers(list) {
  if (!list.length) return '';
  return `<div class="ptx-speakers">` +
    `<span class="ptx-nodes-label">参与成员</span>` +
    list.map((name) => nodeTag(name)).join('') + '</div>';
}

/* 主题判定：主题是跨时间的长期聚合视图，单独成页；
   早期主题词条可能还没有 kind 字段，此时以 timeline 非空兜底。 */
function isTopicEntry(entry) {
  if (!entry) return false;
  if (entry.kind === 'topic') return true;
  if (entry.kind === 'debate') return false;
  return Array.isArray(entry.timeline) && entry.timeline.length > 0;
}

/* 当前列表页签下的可见词条（state.entries 恒为全量，过滤只发生在渲染） */
function listEntries() {
  const wantTopic = state.stage === 'topics';
  return state.entries.filter((entry) => entry && isTopicEntry(entry) === wantTopic);
}

/* 主题时间轴的日期覆盖范围：取首尾两条来源日期（后端按 date 升序）；
   没有时间线时回退词条自身日期，绝不显示空占位。 */
function topicRange(entry) {
  const items = Array.isArray(entry.timeline) ? entry.timeline : [];
  const dates = items.map((item) => String((item && item.date) || '').trim()).filter(Boolean);
  if (!dates.length) return String(entry.date || '--');
  const first = dates[0];
  const last = dates[dates.length - 1];
  return first === last ? first : `${first} → ${last}`;
}

/* <details> 开合态：state.folds 只记用户碰过的键，未碰过的按 defaultOpen 渲染。 */
function foldOpen(key, defaultOpen) {
  return Object.prototype.hasOwnProperty.call(state.folds, key)
    ? state.folds[key] === true
    : defaultOpen === true;
}

function renderStrip(list) {
  const channels = new Set();
  const nodes = [];
  let latest = '';
  for (const entry of list) {
    nodes.push(...namesOf(entry.participants));
    if (entry.channelId) channels.add(entry.channelId);
    if (entry.date && entry.date > latest) latest = entry.date;
  }
  const stat = (label, value, tipText) =>
    `<div class="ptx-stat" ${tip(tipText)}><span class="ptx-stat-l">${escapeHtml(label)}</span>` +
    `<span class="ptx-stat-v">${escapeHtml(value)}</span></div>`;
  return `<div class="ptx-strip">` +
    stat(state.stage === 'topics' ? '主题' : '词条', String(list.length), '当前筛选下的条目数') +
    stat('群聊', String(channels.size), '词条涉及的群聊数') +
    stat('发言人', String(uniq(nodes).length), '参与过讨论的发言人数') +
    stat('最近更新', latest || '--', '最新词条日期') +
  `</div>`;
}

function renderSpores() {
  const isTopicList = state.stage === 'topics';
  const list = listEntries();
  if (!list.length) {
    if (state.entriesError) {
      return renderDormant('读取失败', `无法读取索引（${state.entriesError}）。请检查网络或点击底栏核心按钮刷新数据重试。`);
    }
    if (!state.entriesLoaded) {
      return renderDormant('正在加载', isTopicList ? '正在读取主题索引，请稍候。' : '正在读取词条索引，请稍候。');
    }
    if (state.keyword) {
      return renderDormant('没有匹配结果', `当前关键词没有检索到${isTopicList ? '主题' : '词条'}；换个关键词，或清空搜索框查看全部。`);
    }
    return isTopicList
      ? renderDormant('暂无主题', '跨时间的同一话题被识别归并后，会在这里形成长期主题；也可点击底栏核心按钮刷新数据重新读取。')
      : renderDormant('暂无词条', '群聊讨论平息后会自动生成词条；也可点击底栏核心按钮刷新数据重新读取。');
  }
  const cards = list.map((entry) => {
    const nodes = namesOf(entry.participants);
    const nodeHtml = nodes.length
      ? `<span class="ptx-nodes">${nodes.map((name) => `<span class="ptx-node">${escapeHtml(name)}</span>`).join('')}</span>`
      : '';
    const isTopic = isTopicEntry(entry);
    const glyph = isTopic ? 'topics' : 'spore';
    const glyphClass = isTopic ? ' is-topic' : '';
    const timelineCount = isTopic && Array.isArray(entry.timeline) ? entry.timeline.length : 0;
    /* 主题永远处于待定态（跨时间聚合，不做「已核验」断言），状态位改报时间线条数 */
    const statusHtml = isTopic
      ? `<span class="ptx-spore-status is-topic">${timelineCount || 0} 条相关词条</span>`
      : `<span class="ptx-spore-status is-${escapeHtml(entryStatusKey(entry.status))}">${escapeHtml(entryStatusLabel(entry.status))}</span>`;
    const dateText = isTopic ? topicRange(entry) : entry.date || '--';
    return `<button class="ptx-spore" data-act="select" data-id="${escapeHtml(entry.id)}" ${tip('阅读词条')}>` +
      `<span class="ptx-spore-glyph${glyphClass}">${organicIcon(glyph, 14)}</span>` +
      `<span class="ptx-spore-main">` +
        `<span class="ptx-spore-top">` +
          `<span class="ptx-spore-date">${escapeHtml(dateText)}</span>` +
          statusHtml +
        `</span>` +
        `<span class="ptx-spore-title">${escapeHtml(entry.title || '未命名词条')}</span>` +
        `<span class="ptx-spore-sum">${escapeHtml(clip(entry.summary || '', 96))}</span>` +
        nodeHtml +
      `</span>` +
      `<span class="ptx-spore-go">${organicIcon('chevron', 13)}</span>` +
    `</button>`;
  }).join('');
  return renderStrip(list) + `<div class="ptx-spores${state.viewMode === 'list' ? ' is-list' : ''}">${cards}</div>`;
}

/* mentionize：把正文里的群友昵称渲染成 ptx-node 内联胶囊。
   先整体转义，再用一条联合正则同时命中「昵称」与裸昵称（前者剥掉括号），
   命中处暂存占位符；随后照常做「…」原话高亮，最后把占位符还原为胶囊——
   三步分离保证胶囊与原话高亮不会互相嵌套出坏标签。
   昵称首 / 尾字符是 ASCII 字母数字时要求相邻字符非字母数字（「7」不会误伤「17」）。 */
function mentionize(text, names) {
  const safe = escapeHtml(text);
  const list = [];
  const seen = new Set();
  for (const item of Array.isArray(names) ? names : []) {
    const raw = String(item == null ? '' : item).trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    if (raw.length === 1 && !/[A-Za-z0-9]/.test(raw)) continue;
    list.push(raw);
  }
  const wrapQuotes = (m, inner) => `<span class="ptx-quote-span">「${inner}」</span>`;
  if (!list.length) return safe.replace(/「([^」]*)」/g, wrapQuotes);
  const escNames = list.map((n) => escapeHtml(n)).sort((a, b) => b.length - a.length);
  const alternation = escNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`「(${alternation})」|(${alternation})`, 'g');
  const stash = [];
  let staged = safe.replace(re, (match, bracketed, bare, offset) => {
    const name = bracketed !== undefined ? bracketed : bare;
    if (bracketed === undefined) {
      const first = name.charAt(0);
      const last = name.charAt(name.length - 1);
      const before = offset > 0 ? safe.charAt(offset - 1) : '';
      const after = safe.charAt(offset + match.length);
      if (/[A-Za-z0-9]/.test(first) && /[A-Za-z0-9]/.test(before)) return match;
      if (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(after)) return match;
    }
    stash.push(name);
    return '\u0000' + (stash.length - 1) + '\u0000';
  });
  staged = staged.replace(/「([^」]*)」/g, wrapQuotes);
  return staged.replace(/\u0000(\d+)\u0000/g, (m, index) => `<span class="ptx-node is-inline">${stash[Number(index)]}</span>`);
}

/* 列表项版 mentionize：与 renderBullets 同形但正文走昵称胶囊化 */
function mentionBullets(items, names) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<ul class="ptx-bul">${items.map((line) => `<li>${mentionize(line, names)}</li>`).join('')}</ul>`;
}

function renderMatrixBody(detail, mentionNames) {
  const points = detail && Array.isArray(detail.debateMatrix) ? detail.debateMatrix : [];
  if (!points.length) return '';
  const empty = '<span class="ptx-td-empty">—</span>';
  const side = (list, tone) => list.length
    ? list.map((name) => nodeTag(name, tone)).join('')
    : empty;
  const body = (list) => list.length
    ? mentionize(clip(list.join('；'), 220), mentionNames)
    : empty;
  const namesOfPoint = (point, key) => namesOf(point && point[key]);
  const listOfPoint = (point, key) => (Array.isArray(point && point[key]) ? point[key] : []);
  const head = `<tr><th class="ptx-th-corner">对照</th>${points.map((_, index) =>
    `<th>观点 ${(index + 1 < 10 ? '0' : '') + (index + 1)}</th>`).join('')}</tr>`;
  const row = (label, render) =>
    `<tr><th scope="row">${label}</th>${points.map(render).join('')}</tr>`;
  return `<div class="ptx-table-wrap"><table class="ptx-table ptx-compare"><thead>${head}</thead><tbody>` +
    row('立场', (point) => `<td class="ptx-td-view">${escapeHtml((point && point.viewpoint) || '未命名观点')}</td>`) +
    row('支持', (point) => `<td class="ptx-td-side">${side(namesOfPoint(point, 'proponents'), 'support')}</td>`) +
    row('质疑', (point) => `<td class="ptx-td-side">${side(namesOfPoint(point, 'opponents'), 'dissent')}</td>`) +
    row('论据', (point) => `<td class="ptx-td-body">${body(listOfPoint(point, 'arguments'))}</td>`) +
    row('反驳', (point) => `<td class="ptx-td-body">${body(listOfPoint(point, 'counterArguments'))}</td>`) +
    `</tbody></table></div>`;
}

function renderQuotesBody(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return '';
  return `<div class="ptx-quotes">${quotes.map((item) => {
    const author = (item && item.author) || '匿名成员';
    return `<div class="ptx-quote">` +
      `<div class="ptx-quote-t">「${escapeHtml(clip((item && item.quote) || '', 320))}」</div>` +
      `<div class="ptx-quote-a">${nodeTag(author)}</div>` +
    `</div>`;
  }).join('')}</div>`;
}

/* ---------------- 系统提示词（服务端真值，热生效） ----------------
 * 提示词不是浏览器偏好：读 / 写都走 /api/prompt，保存后下一轮沉淀即生效，
 * 因此设置页永远显示服务端返回的 effective / isCustom，而不是本地缓存。 */
function promptEditorValue() {
  const data = state.prompt.data;
  if (!data) return '';
  const custom = String(data.customPrompt == null ? '' : data.customPrompt);
  /* 自定义为空 = 使用默认预设：把默认全文摊开供查阅，而不是留一块空白 */
  if (custom.trim()) return custom;
  return String(data.defaultPrompt == null ? '' : data.defaultPrompt);
}

function promptStatusLabel() {
  if (state.prompt.error) return `提示词读取失败：${state.prompt.error}`;
  const data = state.prompt.data;
  if (!data) return '正在读取提示词…';
  return data.isCustom ? '自定义提示词生效中' : '默认预设生效中';
}

/* 就地回写，避免重新渲染整页（文本框里的换行缩进与焦点都不会被打断） */
function syncPromptUI() {
  if (!viewportEl || state.stage !== 'settings') return;
  const field = viewportEl.querySelector('[data-role="system-prompt"]');
  if (field) field.value = promptEditorValue();
  const statusEl = viewportEl.querySelector('.ptx-prompt-status');
  if (statusEl) {
    statusEl.textContent = promptStatusLabel();
    statusEl.classList.toggle('is-custom', Boolean(state.prompt.data && state.prompt.data.isCustom));
  }
  /* 主题聚合提示词与系统提示词同源：一次 /api/prompt 响应同时带两套真值 */
  const topicField = viewportEl.querySelector('[data-role="topic-system-prompt"]');
  if (topicField && state.prompt.data) {
    topicField.value = state.prompt.data.topicEffectivePrompt || state.prompt.data.topicDefaultPrompt || '';
  }
  const topicStatusEl = viewportEl.querySelector('.ptx-topic-prompt-status');
  if (topicStatusEl && state.prompt.data) {
    topicStatusEl.textContent = state.prompt.data.isTopicCustom ? '自定义主题提示词生效中' : '默认主题提示词生效中';
    topicStatusEl.classList.toggle('is-custom', Boolean(state.prompt.data.isTopicCustom));
  }
}

function loadPrompt() {
  return requestJson(`${API_BASE}/api/prompt`)
    .then((data) => {
      if (data && typeof data === 'object') state.prompt.data = data;
      state.prompt.error = '';
      syncPromptUI();
    })
    .catch((err) => {
      state.prompt.error = err && err.message ? err.message : '未知错误';
      syncPromptUI();
    });
}

/* ---------------- 运行时设置读写（/api/settings） ----------------
 * 读：一次拿到合并后的五段值与字段表；字段表决定渲染，段值决定初值。
 * 写：单字段补丁；服务端回写整段合并值，直接作为该段新真值，不做二次读文件。 */
function loadRuntimeSettings() {
  state.runtimeSettings.loading = true;
  return requestJson(`${API_BASE}/api/settings`)
    .then((data) => {
      const payload = data && typeof data === 'object' ? data : {};
      state.runtimeSettings.sections = payload.sections && typeof payload.sections === 'object' ? payload.sections : {};
      state.runtimeSettings.meta = Array.isArray(payload.meta) ? payload.meta : [];
      state.runtimeSettings.draftMode = '';
      state.runtimeSettings.error = '';
    }, (err) => {
      state.runtimeSettings.error = err && err.message ? err.message : '未知错误';
    })
    .then(() => {
      state.runtimeSettings.loading = false;
      if (state.stage === 'settings') renderStage();
    });
}

/* 失败要显示服务端给的原因（HTTP 400 的 body）：writeJson 优先抛出 body 里的 error，
   而不是只有状态码的 requestJson；写入本身与读共用 guardedFetch 的本页闸口。 */
function postRuntimeSettings(section, patch) {
  return writeJson(`${API_BASE}/api/settings`, 'POST', { section, patch });
}

/* 服务端值写回控件：保存后归一化与失败回滚共用同一条路径 */
function applyRuntimeField(node, meta, value) {
  if (!node) return;
  if (meta.type === 'boolean') {
    const on = value === true;
    node.classList.toggle('is-on', on);
    node.setAttribute('aria-checked', on ? 'true' : 'false');
    return;
  }
  node.value = value == null ? '' : String(value);
  /* 密钥框的值恒为空串，状态只能靠占位文案表达：保存成功后要立刻从「未配置」翻成「已配置」 */
  if (runtimeIsSecret(meta)) {
    const configured = runtimeSecretConfigured(String(meta.section), String(meta.key));
    if (configured) node.setAttribute('placeholder', RUNTIME_SECRET_PLACEHOLDER);
    else node.removeAttribute('placeholder');
  }
}

/* 行内回执：保持在 2 秒后淡出（与 CSS 的 0.28s 过渡配套），只写目标行的提示节点 */
const CFG_NOTICE_HOLD_MS = 2000;
const CFG_NOTICE_FADE_MS = 300;
const cfgNoticeTimers = new WeakMap();

function runtimeRowNotice(rowKey, text, isError) {
  if (!viewportEl) return;
  const row = viewportEl.querySelector(`[data-cfg-row="${rowKey}"]`);
  const node = row ? row.querySelector('.ptx-cfg-row-msg') : null;
  if (!node) return;
  const timers = cfgNoticeTimers.get(node);
  if (timers) {
    clearTimeout(timers.hold);
    clearTimeout(timers.clear);
    cfgNoticeTimers.delete(node);
  }
  if (!text) {
    node.textContent = '';
    node.classList.remove('is-visible');
    node.classList.remove('is-error');
    return;
  }
  node.textContent = text;
  node.classList.toggle('is-error', Boolean(isError));
  node.classList.add('is-visible');
  const hold = setTimeout(() => {
    node.classList.remove('is-visible');
    const clear = setTimeout(() => {
      cfgNoticeTimers.delete(node);
      node.textContent = '';
    }, CFG_NOTICE_FADE_MS);
    cfgNoticeTimers.set(node, { hold: 0, clear });
  }, CFG_NOTICE_HOLD_MS);
  cfgNoticeTimers.set(node, { hold, clear: 0 });
}

/* 单字段保存：只提交动过的那一个键；成功只回写该行，绝不重绘设置页。
 * 同字段连点时只有最后一次响应能改 UI（seq 令牌），不同字段互不打断。 */
function saveRuntimeField(node) {
  const section = node ? node.getAttribute('data-cfg-section') : '';
  const key = node ? node.getAttribute('data-cfg-key') : '';
  const meta = section && key ? runtimeMeta(section, key) : null;
  if (!meta) return Promise.resolve();
  const rowKey = `${section}.${key}`;
  const modeSwitch = section === 'trigger' && key === 'triggerMode';
  const before = runtimeValue(section, key);
  let next;
  if (meta.type === 'boolean') next = node.classList.contains('is-on');
  else if (meta.type === 'number') {
    /* 空框不等于 0：直接回滚并提示，避免把「没填」静默写成某个值 */
    const raw = String(node.value == null ? '' : node.value).trim();
    const parsed = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(parsed)) {
      applyRuntimeField(node, meta, before);
      runtimeRowNotice(rowKey, '请输入有效数字', true);
      return Promise.resolve();
    }
    next = parsed;
  } else next = String(node.value == null ? '' : node.value);
  /* 密钥的读路径恒为空串：留空 = 不修改（服务端写路径同样如此）。
     前端绝不能把它当「清空」提交，否则保存一次别的字段就会顺手抹掉密钥。 */
  if (runtimeIsSecret(meta) && next === '') {
    applyRuntimeField(node, meta, '');
    runtimeRowNotice(
      rowKey,
      runtimeSecretConfigured(section, key) ? '留空不修改' : '尚未配置',
      false,
    );
    return Promise.resolve();
  }
  if (next === before) {
    if (modeSwitch) state.runtimeSettings.draftMode = '';
    runtimeRowNotice(rowKey, '', false);
    return Promise.resolve();
  }
  const tokenKey = section + '/' + key;
  const token = (state.runtimeSettings.seq[tokenKey] || 0) + 1;
  state.runtimeSettings.seq[tokenKey] = token;
  runtimeRowNotice(rowKey, '保存中…', false);
  return postRuntimeSettings(section, { [key]: next })
    .then((data) => {
      if (state.runtimeSettings.seq[tokenKey] !== token) return;
      const value = data && data.value && typeof data.value === 'object' ? data.value : null;
      /* 只并入本次写入的键：同段其它字段的并发响应可能更旧，整段覆盖会把它冲掉 */
      if (value) {
        const sections = state.runtimeSettings.sections || {};
        const bag = Object.assign({}, sections[section], {
          [key]: Object.prototype.hasOwnProperty.call(value, key) ? value[key] : next,
        });
        /* 密钥回包附 `secretConfigured`：不并入的话保存成功后占位文案仍写着「未配置」 */
        if (value.secretConfigured && typeof value.secretConfigured === 'object') {
          bag.secretConfigured = Object.assign(
            {},
            sections[section] && sections[section].secretConfigured,
            value.secretConfigured,
          );
        }
        sections[section] = bag;
        state.runtimeSettings.sections = sections;
      }
      if (modeSwitch) {
        /* 判据模式决定可见字段集：只替换 trigger 组容器（用本地 sections 重算，不重新 GET） */
        state.runtimeSettings.draftMode = '';
        refreshRuntimeGroup('trigger');
        runtimeRowNotice(rowKey, '已保存', false);
        return;
      }
      applyRuntimeField(node, meta, runtimeValue(section, key));
      runtimeRowNotice(rowKey, '已保存', false);
    }, (err) => {
      if (state.runtimeSettings.seq[tokenKey] !== token) return;
      const reason = `保存失败：${err && err.message ? err.message : '未知错误'}`;
      if (modeSwitch) {
        /* 保存失败：丢弃预览，按服务端现值重排 trigger 组，控件与字段集一起回滚 */
        state.runtimeSettings.draftMode = '';
        refreshRuntimeGroup('trigger');
        runtimeRowNotice(rowKey, reason, true);
        return;
      }
      applyRuntimeField(node, meta, before);
      runtimeRowNotice(rowKey, reason, true);
    });
}

function loadCardSettings() {
  return requestJson(`${API_BASE}/api/card/settings`)
    .then((data) => {
      if (data && typeof data === 'object' && data.settings) state.cardSettings.settings = data.settings;
      state.cardSettings.error = '';
      if (state.stage === 'settings') renderStage();
    }, (err) => {
      state.cardSettings.error = err && err.message ? err.message : '未知错误';
      if (state.stage === 'settings') renderStage();
    });
}

/* 图片匿名化开关：切换即落盘并热生效，作用于下一次出图 */
function toggleCardMask(node) {
  const next = !(state.cardSettings.settings.maskNames !== false);
  return writeJson(`${API_BASE}/api/card/settings`, 'POST', { settings: { maskNames: next } })
    .then((data) => {
      if (data && data.settings) state.cardSettings.settings = data.settings;
      const on = state.cardSettings.settings.maskNames !== false;
      if (node) {
        node.classList.toggle('is-on', on);
        node.setAttribute('aria-checked', on ? 'true' : 'false');
      }
      toast(on ? '图片匿名化已开启' : '图片匿名化已关闭：图片将按原昵称输出');
    }, (err) => {
      toast(`图片匿名化切换失败：${err && err.message ? err.message : '未知错误'}`);
    });
}

function postPrompt(payload) {
  return writeJson(`${API_BASE}/api/prompt`, 'POST', payload);
}

/* 保存：内容与默认提示词完全一致时按「恢复默认」提交，绝不留下一份同文的伪自定义副本 */
function savePrompt() {
  const field = viewportEl ? viewportEl.querySelector('[data-role="system-prompt"]') : null;
  const value = field ? String(field.value == null ? '' : field.value) : '';
  const button = viewportEl ? viewportEl.querySelector('[data-action="save-prompt"]') : null;
  if (button) button.classList.add('is-busy');
  const data = state.prompt.data;
  const defaultText = data && typeof data.defaultPrompt === 'string' ? data.defaultPrompt.trim() : '';
  const next = value.trim() === '' || value.trim() === defaultText ? '' : value;
  return postPrompt({ customPrompt: next })
    .then((result) => {
      if (result && typeof result === 'object') state.prompt.data = result;
      state.prompt.error = '';
      syncPromptUI();
      toast(next ? '自定义提示词已生效' : '已恢复默认提示词');
    }, (err) => {
      toast(`提示词保存失败：${err && err.message ? err.message : '未知错误'}`);
    })
    .then(() => {
      if (button) button.classList.remove('is-busy');
    });
}

/* 主题聚合提示词：与系统提示词同一端点，字段换成 customTopicPrompt，
   内容与默认主题提示词完全一致时同样按「恢复默认」提交 */
function saveTopicPrompt() {
  const field = viewportEl ? viewportEl.querySelector('[data-role="topic-system-prompt"]') : null;
  const value = field ? String(field.value == null ? '' : field.value) : '';
  const data = state.prompt.data;
  const defaultText = data && typeof data.topicDefaultPrompt === 'string' ? data.topicDefaultPrompt.trim() : '';
  const next = value.trim() === '' || value.trim() === defaultText ? '' : value;
  const button = viewportEl ? viewportEl.querySelector('[data-action="save-topic-prompt"]') : null;
  if (button) button.classList.add('is-busy');
  return postPrompt({ customTopicPrompt: next })
    .then((result) => {
      if (result && typeof result === 'object') state.prompt.data = result;
      toast(next ? '主题聚合提示词已生效' : '已恢复主题聚合默认提示词');
      renderStage();
    }, (err) => {
      toast(`主题提示词保存失败：${err && err.message ? err.message : '未知错误'}`);
    })
    .then(() => {
      if (button) button.classList.remove('is-busy');
    });
}

function resetTopicPrompt() {
  const button = viewportEl ? viewportEl.querySelector('[data-action="reset-topic-prompt"]') : null;
  if (button) button.classList.add('is-busy');
  return postPrompt({ customTopicPrompt: '' })
    .then((result) => {
      if (result && typeof result === 'object') state.prompt.data = result;
      toast('已恢复主题聚合默认提示词');
      renderStage();
    }, (err) => {
      toast(`恢复默认失败：${err && err.message ? err.message : '未知错误'}`);
    })
    .then(() => {
      if (button) button.classList.remove('is-busy');
    });
}

/* 恢复默认：清空自定义后重新拉取，编辑区回填默认全文 */
function resetPrompt() {
  const button = viewportEl ? viewportEl.querySelector('[data-action="reset-prompt"]') : null;
  if (button) button.classList.add('is-busy');
  return postPrompt({ customPrompt: '' })
    .then((result) => {
      if (result && typeof result === 'object') state.prompt.data = result;
      state.prompt.error = '';
      syncPromptUI();
      toast('已恢复默认提示词');
    }, (err) => {
      toast(`恢复默认失败：${err && err.message ? err.message : '未知错误'}`);
    })
    .then(() => {
      if (button) button.classList.remove('is-busy');
    });
}

/* 设置页（侧栏底部齿轮，与两个核心页签平级）
 * 本机偏好（自动收纳 / 索引视图 / 底栏轮播）存浏览器，运行时参数
 * （触发算法 / 主题校准 / 素材池与长图 / 本地裁判）存服务端 .patchouli/settings.json，
 * 逐字段保存并即时热生效，不重启服务。数据刷新只有底栏核心按钮一个入口。
 * 设置整块替换视窗内容，底栏轮播与状态轮询照常运行，绝不影响轮播节奏。 */
function renderSettings() {
  const settings = state.settings;
  const cardMask = state.cardSettings.settings.maskNames !== false;
  return renderHead('参数设置', '本机偏好 · 运行时覆盖') +
    `<div class="ptx-settings-page">` +
      `<div class="ptx-settings-shell"><nav class="ptx-settings-outline" aria-label="设置大纲"></nav><div class="ptx-settings-main">` +
      renderSection('面板行为',
        `<div class="ptx-settings-row">` +
          `<span class="ptx-settings-label">自动收纳<em>静置 5 秒后收回为呼吸胶囊，点击胶囊可重新展开。</em></span>` +
          `<button class="ptx-switch${settings.autoDock ? ' is-on' : ''}" data-act="autodock" role="switch" aria-checked="${settings.autoDock ? 'true' : 'false'}" aria-label="自动收纳"></button>` +
        `</div>`) +
      renderSection('图片脱敏',
        `<div class="ptx-settings-row">` +
          `<span class="ptx-settings-label">图片匿名化<em>开启后词条图片里的昵称一律替换为假名；关闭则按群聊原文昵称出图。切换即生效，作用于下一次出图。</em></span>` +
          `<button class="ptx-switch${cardMask ? ' is-on' : ''}" data-act="toggle-card-mask" role="switch" aria-checked="${cardMask ? 'true' : 'false'}" aria-label="图片匿名化"></button>` +
        `</div>`) +
      renderSection('索引视图',
        `<div class="ptx-settings-row">` +
          `<span class="ptx-settings-label">默认展示模式<em>词条索引列表的默认展示方式，与索引标题行右侧的切换胶囊双向同步。</em></span>` +
          renderViewToggle() +
        `</div>`) +
      renderSection('底栏轮播',
        `<label class="ptx-settings-row">` +
          `<span class="ptx-settings-label">轮播条数<em>底栏最多显示的最新词条数，取值 ${TICKER_COUNT_MIN} – ${TICKER_COUNT_MAX}。</em></span>` +
          `<input class="ptx-input ptx-settings-num" data-role="ticker-count" type="number" min="${TICKER_COUNT_MIN}" max="${TICKER_COUNT_MAX}" step="1" value="${settings.tickerCount}" aria-label="轮播条数">` +
        `</label>` +
        `<label class="ptx-settings-row">` +
          `<span class="ptx-settings-label">轮播间隔<em>每条轮播停留的秒数，取值 ${TICKER_INTERVAL_MIN} – ${TICKER_INTERVAL_MAX}。</em></span>` +
          `<input class="ptx-input ptx-settings-num" data-role="ticker-interval" type="number" min="${TICKER_INTERVAL_MIN}" max="${TICKER_INTERVAL_MAX}" step="1" value="${settings.tickerInterval}" aria-label="轮播间隔（秒）">` +
        `</label>`) +
      renderRuntimeSettings() +
      renderSection('系统提示词',
        `<div class="ptx-editor">` +
          `<label class="ptx-editor-field">` +
            `<span class="ptx-editor-label">帕秋莉系统提示词 (SYSTEM PROMPT)</span>` +
            `<textarea class="ptx-input ptx-editor-area ptx-editor-md" data-role="system-prompt" spellcheck="false" aria-label="帕秋莉系统提示词">${escapeHtml(promptEditorValue())}</textarea>` +
          `</label>` +
          `<div class="ptx-editor-foot">` +
            `<span class="ptx-prompt-status${state.prompt.data && state.prompt.data.isCustom ? ' is-custom' : ''}">${escapeHtml(promptStatusLabel())}</span>` +
            `<span class="ptx-editor-hint">在悬浮窗内即时热生效，可随时一键恢复默认</span>` +
            `<button class="ptx-btn" data-action="reset-prompt" type="button">恢复默认</button>` +
            `<button class="ptx-btn is-primary" data-action="save-prompt" type="button">${organicIcon('check', 13)}<span>保存并应用</span></button>` +
          `</div>` +
        `</div>`) +
      renderSection('主题聚合提示词',
        `<div class="ptx-editor">` +
          `<label class="ptx-editor-field">` +
            `<span class="ptx-editor-label">主题校准系统提示词 (TOPIC PROMPT)</span>` +
            `<textarea class="ptx-input ptx-editor-area ptx-editor-md" data-role="topic-system-prompt" spellcheck="false" aria-label="主题聚合系统提示词">${escapeHtml((state.prompt.data && (state.prompt.data.topicEffectivePrompt || state.prompt.data.topicDefaultPrompt)) || '')}</textarea>` +
          `</label>` +
          `<div class="ptx-editor-foot">` +
            `<span class="ptx-prompt-status ptx-topic-prompt-status${state.prompt.data && state.prompt.data.isTopicCustom ? ' is-custom' : ''}">${escapeHtml(state.prompt.data && state.prompt.data.isTopicCustom ? '自定义主题提示词生效中' : '默认主题提示词生效中')}</span>` +
            `<span class="ptx-editor-hint">只影响主题聚合，保存即热生效</span>` +
            `<button class="ptx-btn" data-action="reset-topic-prompt" type="button">恢复默认</button>` +
            `<button class="ptx-btn is-primary" data-action="save-topic-prompt" type="button">${organicIcon('check', 13)}<span>保存并应用</span></button>` +
          `</div>` +
        `</div>`) +
      renderSection('知识库维护',
        `<div class="ptx-maint">` +
          `<div class="ptx-maint-text">清空全部已沉淀条目与原始会话。保留默认目录结构与索引骨架。</div>` +
          (state.clearArmed
            ? `<div class="ptx-maint-confirm">` +
                `<span class="ptx-act-ask">确定清空全部知识库？(不可逆)</span>` +
                `<button class="ptx-btn is-danger-solid" data-action="confirm-clear-kb" type="button">确认清空</button>` +
                `<button class="ptx-btn" data-action="cancel-clear-kb" type="button">取消</button>` +
              `</div>`
            : `<button class="ptx-btn is-danger" data-action="clear-kb" type="button">${organicIcon('trash', 13)}<span>清空全部词条</span></button>`) +
        `</div>`) +
      `<div class="ptx-settings-note">本机偏好存在浏览器；运行时参数存在服务端 .patchouli/settings.json 并即时热生效；提示词存在 .patchouli/custom-prompt.txt。</div>` +
      `</div></div></div>`;
}

// BEGIN GENERATED TRAFFIC RUNTIME
function buildTrafficPath(points, width, height, startTime, endTime, maxCount) {
    const pad = 4; // 绘图区上下留白，与图内网格线 4 / height - 4 对齐
    const sampleMs = 5000; // 采样桶固定 5 秒（后端 TRAFFIC_SAMPLE_MS）；函数体自包含故写字面量
    const span = endTime - startTime;
    const scale = Number.isFinite(maxCount) && maxCount > 0 ? maxCount : 1;
    const baseY = height - pad;
    const usable = Math.max(1, height - pad * 2);
    // 投影成若干段连续折线（扁平存储 [x0, y0, x1, y1, ...]）。
    const runs = [];
    let run = [];
    let previous = Number.NaN;
    for (let i = 0; i < points.length; i += 1) {
        const point = points[i];
        const at = point.timestamp;
        const count = point.count;
        // 窗口外的采样（滚动出窗的过期点、超前于窗口的点）与时间戳 / 条数非有限的
        // 采样一律视为未监测：直接跳过，既不绘制也不压到边界上堆积。
        if (!Number.isFinite(at) || !Number.isFinite(count) || at < startTime || at > endTime)
            continue;
        // 相邻采样必须正好相隔一个采样周期，否则中间存在未监测的桶 → 断开子路径。
        if (Number.isFinite(previous) && (at - previous <= 0 || at - previous > sampleMs)) {
            if (run.length > 0)
                runs.push(run);
            run = [];
        }
        const ratio = span > 0 ? (at - startTime) / span : 0;
        const value = Math.min(1, Math.max(0, count / scale));
        const x = Math.round(ratio * width * 100) / 100;
        const y = Math.round((baseY - value * usable) * 100) / 100;
        run.push(x, y);
        previous = at;
    }
    if (run.length > 0)
        runs.push(run);
    // 单点段画短横线（半宽 3 用户单位），避免只剩一个孤立 moveto 而不可见。
    const tick = 3;
    let d = '';
    for (let i = 0; i < runs.length; i += 1) {
        const segment = runs[i];
        if (segment.length === 2) {
            const from = Math.max(0, Math.round((segment[0] - tick) * 100) / 100);
            const to = Math.min(width, Math.round((segment[0] + tick) * 100) / 100);
            d += 'M' + from + ' ' + segment[1] + ' L' + to + ' ' + segment[1];
            continue;
        }
        d += 'M' + segment[0] + ' ' + segment[1];
        for (let k = 2; k < segment.length; k += 2)
            d += ' L' + segment[k] + ' ' + segment[k + 1];
    }
    return d;
}
function monitorViewport() { return viewportEl; }

  var trafficFrame = 0;
  var trafficAnchor = 0;
  var trafficReceived = 0;
  var trafficPoints = [];
  var trafficScale = 10;
  var trafficChannel = "";

  var trafficLastFrame = 0;
  var trafficLastSecond = -1;
  function renderMetrics() {
    return renderHead("消息监控", "") +
      '<div class="ptx-monitor-status" role="status"></div>' +
      '<div class="ptx-panel"><div class="ptx-panel-h"><strong>消息流量</strong><span data-traffic-summary></span></div>' +
      '<div class="ptx-traffic-chart"><div class="ptx-traffic-y"><span data-traffic-max>10</span><span data-traffic-mid>5</span><span>0 条</span></div>' +
      '<svg class="ptx-ecg" viewBox="0 0 516 120" preserveAspectRatio="none" role="img" aria-label="最近5分钟每5秒收到的消息数">' +
      '<path class="ptx-ecg-base" d="M0 4 H516 M0 60 H516 M0 116 H516"></path>' +
      '<path class="ptx-ecg-line" d=""></path></svg></div>' +
      '<div class="ptx-traffic-times"><span data-traffic-time="0"></span><span data-traffic-time="1"></span><span data-traffic-time="2"></span></div>' +
      '<div class="ptx-ecg-note" data-traffic-note></div></div>' +
      '<section class="ptx-message-preview" aria-label="当前群最新消息"><div class="ptx-message-head"><strong>最新消息</strong><span data-message-author></span><time data-message-time></time></div><div class="ptx-message-body" data-message-body>等待当前群的新消息</div></section>' +
      '<div class="ptx-tiles">' +
      ['瞬时速率', '日常基线', '突发倍率', '讨论缓存'].map(function (label, index) {
        return '<div class="ptx-tile"><div class="ptx-tile-l">' + label + '</div><div class="ptx-tile-v" data-metric="' + index + '">—</div></div>';
      }).join('') + '</div>';
  }

  function trafficText(selector, value) {
    var node = monitorViewport().querySelector(selector);
    if (node && node.textContent !== String(value)) node.textContent = value;
  }

  function trafficTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  }

  /* 监控条状态文案的唯一真源：**不是本插件页** / **接口不可用** / **真断线**必须分开说。
     未认领的页面上数据面根本没启动，报「连接中断」会把用户引向错误的排查方向；
     本插件页上接口整片 404 / 非 JSON，重连也不会好，同样不是断线。
     判据只看「本页 + 接口账」：认领是点胶囊还是元数据命中与失败归因无关，
     拿 userClaimed 当门槛会让元数据认领的页面把 404 报成断线。 */
  function monitorStatusText() {
    if (!state.own) return '当前不是本插件页';
    if (state.apiUnavailable) return '接口不可用';
    return state.statusChecked ? '连接中断，保留最后一次数据' : '正在连接监控服务';
  }

  /* 显示态与缓存是两回事，必须分开清：
     - 缓存 = state.status（最近一次拿到的快照）。离开本页**不清**：回来立刻可重画，不闪空态。
     - 显示态 = 下面这些变量 + 屏上的数字 / 预览 / 曲线 / 消息指纹。本页一变就得清空，
       否则「当前不是本插件页」的标题下仍挂着**上一页**的指标与图表。
     清空后的终态 = 空态：指标全 '—'、预览回「等待当前群的新消息」、曲线没有路径、指纹作废。 */
  function clearTrafficDisplay() {
    if (trafficFrame) cancelAnimationFrame(trafficFrame);
    trafficFrame = 0;
    trafficLastFrame = 0;
    trafficLastSecond = -1;
    trafficChannel = '';
    trafficAnchor = 0;
    trafficReceived = 0;
    trafficPoints = [];
    trafficScale = 10;
    var root = monitorViewport();
    var line = root ? root.querySelector('.ptx-ecg-line') : null;
    if (line) line.setAttribute('d', '');
    var panel = root ? root.querySelector('.ptx-panel') : null;
    if (panel) panel.classList.remove('is-burst');
    trafficText('.ptx-vhead-sub', '群聊 ' + channelScopeId());
    trafficText('[data-traffic-summary]', '');
    trafficText('[data-traffic-max]', trafficScale + ' 条');
    trafficText('[data-traffic-mid]', trafficScale / 2 + ' 条');
    trafficText('[data-traffic-note]', '');
    trafficText('[data-traffic-time="0"]', '');
    trafficText('[data-traffic-time="1"]', '');
    trafficText('[data-traffic-time="2"]', '');
    for (var index = 0; index < 4; index += 1) trafficText('[data-metric="' + index + '"]', '—');
    trafficText('[data-message-author]', '');
    trafficText('[data-message-time]', '');
    /* 指纹跟着一起作废：不重置的话，回到本页时同一条消息会被「指纹没变」跳过，预览永远空着。 */
    resetLatestMessage();
    trafficText('.ptx-monitor-status', monitorStatusText());
  }

  function updateMetrics() {
    var root = monitorViewport();
    if (!root || !root.querySelector('[data-traffic-summary]')) return;
    var status = state.status;
    /* 未认领本页：数据面没启动，屏上留着的就是上一页的残留 —— 无条件清空。
       不能只在「频道变了」时清：同一个群切到别的插件页，trafficChannel 恰好等于当前作用域，
       原来的判断就整段跳过，指标与图表跟着页走。 */
    if (!state.own) {
      clearTrafficDisplay();
      return;
    }
    if (!status) {
      /* 真断线 / 首帧：**同一个群**保留最后一次数据并由文案说明（见 monitorStatusText），
         换了群才清 —— 上一个群的数字不能贴在这个群上。 */
      if (trafficChannel && trafficChannel !== channelScopeId()) {
        clearTrafficDisplay();
        return;
      }
      trafficText('.ptx-monitor-status', monitorStatusText());
      return;
    }
    var channel = String(status.channelId || channelScopeId());
    trafficChannel = channel;
    trafficAnchor = num(status.serverTime, Date.now());
    trafficReceived = performance.now();
    trafficLastSecond = -1;
    trafficPoints = Array.isArray(status.traffic) ? status.traffic : [];
    var peak = trafficPoints.reduce(function (max, point) { return Math.max(max, num(point.count)); }, 0);
    trafficScale = Math.max(10, Math.ceil(peak * 1.2 / 2) * 2);
    trafficText('.ptx-vhead-sub', '群聊 ' + channel);
    trafficText('.ptx-monitor-status', '');
    trafficText('[data-metric="0"]', fixed(num(status.currentRate), 2) + ' 条/分');
    trafficText('[data-metric="1"]', fixed(num(status.baselineRate), 2) + ' 条/分');
    trafficText('[data-metric="2"]', fixed(num(status.burstRatio), 2) + ' 倍');
    trafficText('[data-metric="3"]', num(status.bufferedCount) + ' 条');
    trafficText('[data-traffic-summary]', '每5秒消息数 · 峰值 ' + peak + ' 条');
    trafficText('[data-traffic-max]', trafficScale + ' 条');
    trafficText('[data-traffic-mid]', trafficScale / 2 + ' 条');
    trafficText('[data-traffic-note]', trafficPoints.length ? '最近5分钟 · 5秒分桶汇总 · 实时被动监听' : '等待第一个完整的5秒分桶汇总');
    var message = status.latestMessage;
    trafficText('[data-message-author]', message ? message.userName || '群成员' : '');
    trafficText('[data-message-time]', message ? trafficTime(message.timestamp) : '');
    /* 只在新消息（id / elements 指纹变化）时重建预览：图片、播放与展开状态不被轮询打断。 */
    renderLatestMessage(message);
    var panel = root.querySelector('.ptx-panel');
    panel.classList.toggle('is-burst', status.phase === 'BURSTING');
    drawTraffic();
    if (!trafficFrame && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) trafficFrame = requestAnimationFrame(animateTraffic);
  }

  function drawTraffic() {
    var root = monitorViewport();
    if (!root) return;
    var line = root.querySelector('.ptx-ecg-line');
    if (!line || !trafficAnchor) return;
    var end = trafficAnchor + Math.max(0, performance.now() - trafficReceived);
    var start = end - 300000;
    line.setAttribute('d', buildTrafficPath(trafficPoints, 516, 120, start, end, trafficScale));
    var second = Math.floor(end / 1000);
    if (second !== trafficLastSecond) {
      trafficLastSecond = second;
      trafficText('[data-traffic-time="0"]', trafficTime(start));
      trafficText('[data-traffic-time="1"]', trafficTime(end - 150000));
      trafficText('[data-traffic-time="2"]', trafficTime(end));
    }
  }

  function animateTraffic(now) {
    trafficFrame = 0;
    var root = monitorViewport();
    if (!root || !root.isConnected || state.stage !== 'metrics' || state.collapsed || document.hidden) return;
    if (now - trafficLastFrame >= 33) { drawTraffic(); trafficLastFrame = now; }
    trafficFrame = requestAnimationFrame(animateTraffic);
  }

  /* 回到前台补一次数据：只在**本插件页**发。未认领的页面上数据面根本没启动，
     这里不设闸口就等于「切一次标签页 = 一条 /api 请求」。 */
  function resumeTraffic() {
    var root = monitorViewport();
    if (document.hidden || !root || !root.isConnected || state.stage !== 'metrics' || state.collapsed || !state.own) return;
    loadStatus().then(function () { refreshPhase(); updateMetrics(); });
  }
  document.addEventListener('visibilitychange', resumeTraffic);

  /* 合并转发递归深度上限：超过即降级为折叠摘要，杜绝恶意深层嵌套拖垮渲染。 */
  var RICH_FORWARD_DEPTH = 3;
  /* 单个合并转发最多就地渲染的条目数（其余只报数量，不展开）。 */
  var RICH_FORWARD_ITEMS = 20;
  /* 单次渲染的元素上限（与后端顶层 elements 上限 60 一致）：任何一层都不允许超量 AST 膨胀成等量 DOM。 */
  var RICH_ELEMENT_LIMIT = 60;

  function richText(value) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return String(value);
  }

  /* URL 白名单：只放行 http / https；相对路径按当前页面解析后同样归入 http(s)。 */
  function richUrl(raw) {
    var text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return "";
    try {
      var url = new URL(text, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function richLabel(element, fallback) {
    var text = richText(element && element.text).trim();
    if (text) return text;
    var title = richText(element && element.title).trim();
    return title || fallback;
  }

  function richCreate(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function richSpan(className, text) {
    var node = richCreate("span", className);
    node.textContent = text;
    return node;
  }

  function richLink(href, className, text) {
    var node = richCreate("a", className);
    node.setAttribute("href", href);
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
    node.textContent = text;
    return node;
  }

  function richImage(url, className, alt) {
    var image = document.createElement("img");
    if (className) image.className = className;
    image.setAttribute("src", url);
    image.setAttribute("alt", alt || "");
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    image.setAttribute("referrerpolicy", "no-referrer");
    return image;
  }

  /* 图片 / 视频 / 语音加载失败（直链失效、代理 404「媒体已过期」）→ 可见文本，绝不留空白。 */
  function richFail(node, label) {
    if (node && node.parentNode) node.parentNode.replaceChild(richSpan("ptx-rich-text ptx-rich-failed", label), node);
  }

  /* 把失败兜底挂到真正抛 error 的节点（media 的 error 事件不冒泡），替换掉 target。 */
  function richGuard(node, target, label) {
    node.addEventListener("error", function () {
      richFail(target || node, label);
    });
    return node;
  }

  /* 语音时长：秒 → m:ss；非正数 / 非数字返回空串（不占位）。 */
  function richClock(seconds) {
    var total = Math.round(Number(seconds));
    if (!isFinite(total) || total <= 0) return "";
    var minutes = Math.floor(total / 60);
    var rest = total - minutes * 60;
    return minutes + ":" + (rest < 10 ? "0" + rest : String(rest));
  }

  /* ---------------- 图片放大：原生 dialog（Esc / 点空白关闭） ---------------- */

  /* 弹窗宿主：dialog 必须挂在有机根容器上，绝不能留在 .ptx-viewport 里。
     版心规则（.ptx-viewport > :not(dialog)）虽然已排除 dialog，但只要它还留在视窗内，
     就会继续被视窗的内容流、裁剪上下文与背景层包住，任何一条宿主继承下来的宽容规则
     （宽度 / 外边距）都能改写它的几何，全屏居中无从谈起。挂到根容器后它与窗口同级，
     尺寸与位置完全由自己的 fixed + inset: 0 + margin: auto 决定。 */
  function richLightboxHost() {
    var root = document.getElementById("patchouli-organic-root");
    if (root) return root;
    /* 内嵌面板 / 独立页没有这个 id：沿视窗向上取挂在 body 下的最外层有机容器
       （内嵌面板即 #ptxDockRoot），dialog 既脱出版心，又留在样式令牌与
       .ptx-rich-lightbox 规则的作用域内——直接挂 body 会丢掉全部令牌。 */
    var origin = monitorViewport();
    var node = origin;
    while (node && node.parentElement && node.parentElement !== document.body) node = node.parentElement;
    if (!node || node === origin || !node.parentElement) return document.body;
    return node;
  }

  function richLightbox() {
    var host = richLightboxHost();
    var dialog = host.querySelector("dialog.ptx-rich-lightbox");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.className = "ptx-rich-lightbox";
    dialog.setAttribute("aria-label", "图片预览");
    var image = document.createElement("img");
    image.setAttribute("alt", "图片预览");
    image.setAttribute("decoding", "async");
    image.setAttribute("referrerpolicy", "no-referrer");
    dialog.appendChild(image);
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog && dialog.open) dialog.close();
    });
    host.appendChild(dialog);
    return dialog;
  }

  function richOpenImage(url) {
    if (!url) return;
    var dialog = richLightbox();
    var image = dialog.querySelector("img");
    if (image && image.getAttribute("src") !== url) image.setAttribute("src", url);
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
      return;
    }
    dialog.setAttribute("open", "open");
  }

  /* ---------------- 单元素渲染 ---------------- */

  function richTextNode(element) {
    var text = richText(element.text);
    if (!text) return null;
    return richSpan("ptx-rich-text", text);
  }

  function richFaceNode(element) {
    var emoji = richUrl(element.emojiUrl);
    var label = richText(element.text).trim() || "表情";
    if (!emoji) return richSpan("ptx-rich-text", label);
    var image = richImage(emoji, "ptx-rich-face", label);
    image.setAttribute("loading", "eager");
    return richGuard(image, image, label);
  }

  function richImageNode(element) {
    var url = richUrl(element.url);
    if (!url) return richSpan("ptx-rich-text", richLabel(element, "[图片]"));
    var button = richCreate("button", "ptx-rich-image");
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "查看大图");
    /* 后端把 image 元素的 text 归一成人读标签（如「[图片]」），有 url 时用作 alt，无 url 时才是正文。 */
    button.appendChild(richGuard(richImage(url, "", richText(element.text).trim() || "图片"), button, "图片加载失败"));
    button.addEventListener("click", function () {
      richOpenImage(url);
    });
    return button;
  }

  /* 视频：封面（有直链时直接当 poster）+ 标题 + 合法外链 + 原生 controls，绝不自动播放。 */
  function richVideoNode(element) {
    var url = richUrl(element.url);
    var poster = richUrl(element.imageUrl);
    var title = richText(element.title).trim() || richText(element.text).trim();
    if (!url) {
      if (!poster) return richSpan("ptx-rich-text", richLabel(element, "[视频]"));
      var coverOnly = richCreate("div", "ptx-rich-media-card");
      coverOnly.appendChild(richGuard(richImage(poster, "ptx-rich-cover", title || richText(element.text).trim() || "视频封面"), null, "封面加载失败"));
      if (title) coverOnly.appendChild(richSpan("ptx-rich-media-title", title));
      return coverOnly;
    }
    var card = richCreate("div", "ptx-rich-media-card");
    if (title) card.appendChild(richSpan("ptx-rich-media-title", title));
    var player = document.createElement("video");
    player.className = "ptx-rich-video-player";
    player.setAttribute("controls", "controls");
    player.setAttribute("preload", "metadata");
    player.setAttribute("playsinline", "playsinline");
    player.setAttribute("referrerpolicy", "no-referrer");
    player.setAttribute("src", url);
    if (poster) {
      player.setAttribute("poster", poster);
      /* 封面失效时摘掉 poster，让原生播放器回落到首帧，而不是留一块空白海报位。 */
      var probe = new Image();
      probe.addEventListener("error", function () {
        player.removeAttribute("poster");
      });
      probe.src = poster;
    }
    richGuard(player, player, "视频加载失败（可能已失效或未登记）");
    card.appendChild(player);
    card.appendChild(richLink(url, "ptx-rich-link", "在新窗口打开视频"));
    return card;
  }

  function richCardNode(element) {
    var url = richUrl(element.url);
    var cover = richUrl(element.imageUrl);
    var title = richText(element.title).trim();
    var text = richText(element.text).trim();
    var source = richText(element.source).trim();
    if (!cover && !title && !text && !source) return richSpan("ptx-rich-text", "[卡片消息]");
    var node = richCreate(url ? "a" : "div", "ptx-rich-card");
    if (url) {
      node.setAttribute("href", url);
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (cover) node.appendChild(richGuard(richImage(cover, "ptx-rich-cover", title || richText(element.text).trim() || "卡片封面"), null, "封面加载失败"));
    var body = richCreate("div", "ptx-rich-card-body");
    if (title) body.appendChild(richSpan("ptx-rich-card-title", title));
    if (text) body.appendChild(richSpan("ptx-rich-card-text", text));
    if (source) body.appendChild(richSpan("ptx-rich-card-source", source));
    node.appendChild(body);
    return node;
  }

  function richQuoteNode(element) {
    var node = richCreate("div", "ptx-rich-quote");
    var title = richText(element.title).trim();
    if (title) node.appendChild(richSpan("ptx-rich-quote-title", title));
    node.appendChild(richSpan("ptx-rich-quote-text", richText(element.text).trim() || "[引用消息]"));
    var target = richText(element.targetMessageId).trim();
    if (target) node.setAttribute("data-target-message", target);
    return node;
  }

  function richForwardItem(item, depth) {
    var node = richCreate("div", "ptx-rich-forward-item");
    var title = richText(item && item.title).trim();
    if (title) node.appendChild(richSpan("ptx-rich-forward-author", title));
    var line = richCreate("div", "ptx-rich-line");
    richAppendChildren(line, item && item.elements, depth);
    if (!line.firstChild) line.textContent = "[空消息]";
    node.appendChild(line);
    return node;
  }

  /* 合并转发：折叠态只报标题与条数，展开后就地推挤但内部细滚动，绝不撑满监控视窗。 */
  function richForwardNode(element, depth) {
    var items = Array.isArray(element.items) ? element.items : [];
    var title = richText(element.title).trim() || "合并转发";
    if (!items.length || depth >= RICH_FORWARD_DEPTH) {
      var flat = richCreate("div", "ptx-rich-quote");
      flat.appendChild(richSpan("ptx-rich-quote-title", title));
      flat.appendChild(richSpan("ptx-rich-quote-text", richText(element.text).trim() || "[合并转发]"));
      return flat;
    }
    var details = richCreate("details", "ptx-rich-forward");
    var summary = richCreate("summary", "ptx-rich-forward-summary");
    summary.appendChild(richSpan("ptx-rich-forward-title", title));
    summary.appendChild(richSpan("ptx-rich-forward-count", "共 " + items.length + " 条"));
    details.appendChild(summary);
    var body = richCreate("div", "ptx-rich-forward-body");
    var limit = Math.min(items.length, RICH_FORWARD_ITEMS);
    for (var index = 0; index < limit; index += 1) body.appendChild(richForwardItem(items[index], depth + 1));
    if (items.length > limit) body.appendChild(richSpan("ptx-rich-forward-more", "另有 " + (items.length - limit) + " 条未展开"));
    details.appendChild(body);
    return details;
  }

  function richFileNode(element) {
    var url = richUrl(element.url);
    var name = richText(element.title).trim() || richText(element.text).trim() || "文件";
    var node = richCreate("div", "ptx-rich-file");
    node.appendChild(richSpan("ptx-rich-file-name", name));
    if (url) {
      var link = richLink(url, "ptx-rich-link", "下载 / 打开");
      link.setAttribute("download", "");
      node.appendChild(link);
    }
    return node;
  }

  function richRecordNode(element) {
    var url = richUrl(element.url);
    var node = richCreate("div", "ptx-rich-record");
    if (url) {
      var audio = document.createElement("audio");
      audio.className = "ptx-rich-audio";
      audio.setAttribute("controls", "controls");
      audio.setAttribute("preload", "none");
      audio.setAttribute("referrerpolicy", "no-referrer");
      audio.setAttribute("src", url);
      node.appendChild(richGuard(audio, audio, "语音加载失败（可能已失效或未登记）"));
    }
    node.appendChild(richSpan("ptx-rich-record-label", richClock(element.duration) || richText(element.text).trim() || "语音"));
    return node;
  }

  function richElementNode(element, depth) {
    if (!element || typeof element !== "object") return null;
    var type = richText(element.type);
    if (type === "text") return richTextNode(element);
    if (type === "face") return richFaceNode(element);
    if (type === "image") return richImageNode(element);
    if (type === "video") return richVideoNode(element);
    if (type === "card") return richCardNode(element);
    if (type === "quote") return richQuoteNode(element);
    if (type === "forward") return richForwardNode(element, depth);
    if (type === "file") return richFileNode(element);
    if (type === "record") return richRecordNode(element);
    return richSpan("ptx-rich-text", richLabel(element, "[未知消息]"));
  }

  /* 元素数量硬上限：超出部分只留一句可见提示，绝不逐条建 DOM（防恶意超量 AST）。 */
  function richAppendChildren(container, elements, depth) {
    if (!Array.isArray(elements)) return;
    var limit = Math.min(elements.length, RICH_ELEMENT_LIMIT);
    for (var index = 0; index < limit; index += 1) {
      var node = richElementNode(elements[index], depth);
      if (node) container.appendChild(node);
    }
    if (elements.length > limit) {
      container.appendChild(richSpan("ptx-rich-text", "另有 " + (elements.length - limit) + " 段内容未展开"));
    }
  }

  /* ---------------- 最新消息横条：指纹不变则一个节点都不动 ---------------- */

  /* 指纹与渲染上限严格对齐：凡是不参与渲染的元素也不必参与比对，凡是渲染出来的内容变化必须被看见。 */
  function richElementsKey(elements, depth) {
    if (!Array.isArray(elements)) return "";
    var parts = [];
    var limit = Math.min(elements.length, RICH_ELEMENT_LIMIT);
    for (var index = 0; index < limit; index += 1) {
      var element = elements[index] && typeof elements[index] === "object" ? elements[index] : {};
      var items = Array.isArray(element.items) ? element.items : [];
      var nested = "";
      if (items.length && depth < 2) {
        var nestedParts = [];
        var nestedLimit = Math.min(items.length, RICH_FORWARD_ITEMS);
        for (var inner = 0; inner < nestedLimit; inner += 1) {
          nestedParts.push(richElementsKey(items[inner] && items[inner].elements, depth + 1));
        }
        nested = nestedParts.join("/");
      }
      parts.push([element.type, element.text, element.title, element.url, element.imageUrl, element.emojiUrl, element.source, element.targetMessageId, element.duration, items.length, nested].join("\u0001"));
    }
    return parts.length + "|" + parts.join("\u0002");
  }

  function richMessageKey(message) {
    if (!message) return "none";
    var elements = Array.isArray(message.elements) ? message.elements : null;
    return richText(message.id) + "#" + richElementsKey(elements, 0) + "#" + richText(message.content).length;
  }

  /**
   * 渲染当前群最新消息。
   *
   * 指纹（id + elements 结构 + 文本长度）与容器上记录的一致时**直接返回**：正在播放的语音 /
   * 视频、已展开的合并转发、已放大或正在加载的图片都不会被 5 秒轮询重建。只有新消息到达
   * （指纹变化）或视图被重新渲染（新容器没有指纹）时才替换内容。
   */
  function renderLatestMessage(message) {
    var root = monitorViewport();
    var body = root ? root.querySelector("[data-message-body]") : null;
    if (!body) return;
    var key = richMessageKey(message);
    if (body.dataset.richKey === key) return;
    body.dataset.richKey = key;
    while (body.firstChild) body.removeChild(body.firstChild);
    if (!message) {
      body.textContent = "等待当前群的新消息";
      return;
    }
    richAppendChildren(body, message.elements, 0);
    if (!body.firstChild) body.textContent = richText(message.content).trim() || "[无文本内容]";
  }

  /* 切换群聊 / 连接中断：清掉指纹并回到空态，避免把上一个群的消息留在横条上。 */
  function resetLatestMessage() {
    var root = monitorViewport();
    var body = root ? root.querySelector("[data-message-body]") : null;
    if (body) body.dataset.richKey = "";
    renderLatestMessage(null);
  }

// END GENERATED TRAFFIC RUNTIME

/* ---------------- 词条操作（修正 / 删除 · 危险动作走二次确认） ----------------
 * 操作栏放在正文标题与元信息之下：修正进入就地编辑态，删除先切换为确认条，
 * 两条路径都不离开当前视窗，也不产生任何模态浮层。 */
function renderEntryActions() {
  if (state.deleteArmed) {
    return `<div class="ptx-acts is-confirm">` +
      `<span class="ptx-act-ask">确定删除此词条？</span>` +
      `<button class="ptx-btn is-danger-solid" data-action="confirm-delete-entry" type="button">确认删除</button>` +
      `<button class="ptx-btn" data-action="cancel-delete-entry" type="button">取消</button>` +
    `</div>`;
  }
  return `<div class="ptx-acts">` +
    `<button class="ptx-btn" data-action="edit-entry" ${tip('修正标题、状态、标签、摘要与正文')} type="button">${organicIcon('pencil', 13)}<span>修正</span></button>` +
    `<button class="ptx-btn is-danger" data-action="delete-entry" ${tip('删除该词条与其原始会话', 'top')} type="button">${organicIcon('trash', 13)}<span>删除</span></button>` +
  `</div>`;
}

/* 可改状态：与后端 PUT 契约一致，只放 verified / tentative / open 三态 */
const EDITOR_STATUSES = ['verified', 'tentative', 'open'];
const EDITOR_MAX_HEIGHT = 340;

function renderEditor(detail) {
  let current = entryStatusKey(detail.status);
  if (!EDITOR_STATUSES.includes(current)) current = 'open';
  const options = EDITOR_STATUSES.map((key) =>
    `<option value="${key}"${key === current ? ' selected' : ''}>${escapeHtml(ENTRY_STATUS[key])}</option>`).join('');
  const tags = Array.isArray(detail.tags) ? detail.tags.join(', ') : '';
  return `<div class="ptx-editor" data-role="entry-editor">` +
    `<label class="ptx-editor-field">` +
      `<span class="ptx-editor-label">标题</span>` +
      `<input class="ptx-input" data-role="entry-title" type="text" maxlength="200" value="${escapeHtml(detail.title || '')}" aria-label="词条标题">` +
    `</label>` +
    `<div class="ptx-editor-row">` +
      `<label class="ptx-editor-field is-narrow">` +
        `<span class="ptx-editor-label">状态</span>` +
        `<select class="ptx-input" data-role="entry-status" aria-label="词条状态">${options}</select>` +
      `</label>` +
      `<label class="ptx-editor-field">` +
        `<span class="ptx-editor-label">标签（逗号分隔）</span>` +
        `<input class="ptx-input" data-role="entry-tags" type="text" value="${escapeHtml(tags)}" aria-label="词条标签">` +
      `</label>` +
    `</div>` +
    `<label class="ptx-editor-field">` +
      `<span class="ptx-editor-label">摘要</span>` +
      `<textarea class="ptx-input ptx-editor-area" data-role="entry-summary" rows="3" aria-label="词条摘要">${escapeHtml(detail.summary || '')}</textarea>` +
    `</label>` +
    `<label class="ptx-editor-field">` +
      `<span class="ptx-editor-label">正文 Markdown</span>` +
      `<textarea class="ptx-input ptx-editor-area ptx-editor-md" data-role="entry-markdown" spellcheck="false" aria-label="词条正文 Markdown">${escapeHtml(detail.markdown || '')}</textarea>` +
    `</label>` +
    `<div class="ptx-editor-foot">` +
      `<button class="ptx-btn is-primary" data-action="save-entry" type="button">${organicIcon('check', 13)}<span>保存修正</span></button>` +
      `<button class="ptx-btn" data-action="cancel-edit-entry" type="button">取消</button>` +
      `<span class="ptx-editor-hint">正文为 llmwiki Markdown，保存后立即重写词条与索引</span>` +
    `</div>` +
  `</div>`;
}

/* 正文 / 摘要会随内容增高，到 CSS 上限后转为内部滚动 */
function growField(field) {
  if (!field || field.tagName !== 'TEXTAREA') return;
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, EDITOR_MAX_HEIGHT)}px`;
}

function growEditor() {
  if (!viewportEl) return;
  for (const field of viewportEl.querySelectorAll('[data-role="entry-summary"], [data-role="entry-markdown"]')) growField(field);
}

/* 讨论脉络正文：段落各自成 <p>；昵称变内联胶囊，「…」原话保持低调高亮。 */
function renderNarrative(text, mentionNames) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const paragraphs = text.split(/\n\s*\n|\r\n\s*\r\n/).map((p) => p.trim()).filter(Boolean);
  return `<div class="ptx-narrative">${paragraphs.map((p) =>
    `<p>${mentionize(p, mentionNames)}</p>`,
  ).join('')}</div>`;
}

function renderGloss(items, mentionNames) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<dl class="ptx-gloss">${items.map((item) =>
    `<div class="ptx-gloss-row"><dt>${escapeHtml((item && item.term) || '')}</dt><dd>${mentionize((item && item.note) || '', mentionNames)}</dd></div>`,
  ).join('')}</dl>`;
}

/* 相关线索：命中索引的渲染为可点击行（序号 + 标题 + 一行摘要 + 箭头），
   未命中的降级为「未入索引」条目；超过 8 条折叠进「其余 N 条」。 */
function renderRelatedItem(text, hit, index) {
  const no = (index + 1 < 10 ? '0' : '') + (index + 1);
  if (hit) {
    return `<button type="button" class="ptx-link" data-act="select" data-id="${escapeHtml(hit.id)}" title="${escapeHtml(text)}">` +
      `<span class="ptx-link-no">${no}</span>` +
      `<span class="ptx-link-main">` +
        `<span class="ptx-link-title">${escapeHtml(text)}</span>` +
        `<span class="ptx-link-sum">${escapeHtml(clip(hit.summary || '', 72))}</span>` +
      `</span>` +
      `<span class="ptx-link-go">${organicIcon('chevron', 12)}</span>` +
      `</button>`;
  }
  return `<div class="ptx-link is-missing" title="${escapeHtml(text)}">` +
    `<span class="ptx-link-no">${no}</span>` +
    `<span class="ptx-link-main"><span class="ptx-link-title">${escapeHtml(text)}</span></span>` +
    `<span class="ptx-link-flag">未入索引</span>` +
    `</div>`;
}

function renderRelated(titles, entryId) {
  if (!Array.isArray(titles) || !titles.length) return '';
  const rows = titles.map((title, index) => {
    const text = String(title == null ? '' : title).trim();
    if (!text) return '';
    /* 相关词条查找扫全量索引（state.entries 永为全量，页签过滤只影响列表渲染） */
    const hit = state.entries.find((entry) => entry && entry.title === text);
    return renderRelatedItem(text, hit, index);
  }).filter(Boolean);
  if (!rows.length) return '';
  let html = `<div class="ptx-related">${rows.slice(0, 8).join('')}</div>`;
  const tail = rows.slice(8);
  if (tail.length) {
    const key = `relmore:${entryId || ''}`;
    html += `<details class="ptx-related-more"${foldOpen(key, false) ? ' open' : ''} data-fold="${escapeHtml(key)}">` +
      `<summary>其余 ${tail.length} 条</summary><div class="ptx-related">${tail.join('')}</div></details>`;
  }
  return html;
}

/* 落点：已收敛 / 仍悬而未决 两列一栏；两列皆空则整栏隐藏。 */
function renderOutcome(detail, mentionNames) {
  const consensus = Array.isArray(detail.consensus) ? detail.consensus : [];
  const openQuestions = Array.isArray(detail.openQuestions) ? detail.openQuestions : [];
  if (!consensus.length && !openQuestions.length) return '';
  const left = consensus.length
    ? `<div class="ptx-outcome-col is-consensus"><span class="ptx-outcome-l">已收敛</span>${mentionBullets(consensus, mentionNames)}</div>` : '';
  const right = openQuestions.length
    ? `<div class="ptx-outcome-col is-open"><span class="ptx-outcome-l">仍悬而未决</span>${mentionBullets(openQuestions, mentionNames)}</div>` : '';
  return `<div class="ptx-outcome">${left}${right}</div>`;
}

/* 附录：争点对照 + 摘句 收进同一个折叠区，摘要行列出内含物；两者皆空则整区消失。
   旧词条没有讨论脉络时默认展开（否则主体内容被藏进折叠区）。 */
function renderAppendix(detail, mentionNames) {
  const points = Array.isArray(detail.debateMatrix) ? detail.debateMatrix : [];
  const quotes = Array.isArray(detail.keyQuotes) ? detail.keyQuotes : [];
  if (!points.length && !quotes.length) return '';
  const parts = [];
  if (points.length) parts.push(`争点对照 ${points.length} 个立场`);
  if (quotes.length) parts.push(`摘句 ${quotes.length} 条`);
  const hasNarrative = typeof detail.narrative === 'string' && detail.narrative.trim() !== '';
  const key = `appendix:${detail.id || ''}`;
  const inner =
    (points.length ? `<div class="ptx-app-h">争点对照</div>${renderMatrixBody(detail, mentionNames)}` : '') +
    (quotes.length ? `<div class="ptx-app-h">摘句</div>${renderQuotesBody(detail.keyQuotes)}` : '');
  return `<details class="ptx-appendix"${foldOpen(key, !hasNarrative) ? ' open' : ''} data-fold="${escapeHtml(key)}">` +
    `<summary>附录 · ${parts.join(' · ')}</summary>${inner}</details>`;
}

/* 主题时间轴：左侧一条发丝竖线 + 节点圆点，每条来源词条一行——
   等宽日期 / 可点击标题（走 data-act=select）/ 一句贡献（缺省回退该条摘要）。
   没有 timeline 时回退「相关线索」列表，但小节标题仍写「时间轴」。 */
function renderTimeline(detail, mentionNames) {
  const items = Array.isArray(detail.timeline) ? detail.timeline : [];
  if (!items.length) {
    const related = Array.isArray(detail.related) ? detail.related : [];
    if (!related.length) return `<div class="ptx-text">这条主题还没有累积来源词条。</div>`;
    return renderRelated(related, detail.id);
  }
  const rows = items.map((item) => {
    const entryId = String((item && item.entryId) || '').trim();
    const title = String((item && item.title) || '未命名来源词条');
    const date = String((item && item.date) || '--');
    const note = String((item && (item.contribution || item.summary)) || '');
    const titleHtml = entryId
      ? `<button type="button" class="ptx-tl-title" data-act="select" data-id="${escapeHtml(entryId)}" ${tip('阅读来源词条')}>${escapeHtml(title)}</button>`
      : `<span class="ptx-tl-title is-static">${escapeHtml(title)}</span>`;
    return `<li class="ptx-tl">` +
      `<span class="ptx-tl-dot" aria-hidden="true"></span>` +
      `<div class="ptx-tl-main">` +
        `<span class="ptx-tl-date">${escapeHtml(date)}</span>` +
        titleHtml +
        (note ? `<p class="ptx-tl-note">${mentionize(note, mentionNames)}</p>` : '') +
      `</div>` +
    `</li>`;
  }).join('');
  return `<ol class="ptx-timeline">${rows}</ol>`;
}

function renderPanorama() {
  const backLabel = state.listStage === 'topics' ? '返回主题' : '返回词条索引';
  const back = `<button class="ptx-back" data-act="stage" data-stage="${escapeHtml(state.listStage || 'entries')}" ${tip(backLabel)} aria-label="${escapeHtml(backLabel)}">${organicIcon('back', 13)}</button>`;
  if (state.detailLoading) {
    return renderHead('词条正文', '正在载入', back) + renderDormant('正在载入', '正在读取词条正文并解析导语、脉络与结构字段。');
  }
  const detail = state.detail;
  if (!detail) {
    if (state.detailError) {
      return renderHead('词条正文', '读取失败', back) + renderDormant('词条读取失败', `无法读取该词条正文（${state.detailError}）。可返回索引重试，或点击底栏核心按钮刷新数据。`);
    }
    return renderHead('词条正文', '未选择词条', back) + renderDormant('未选择词条', '请先在词条索引中选择一条词条，正文会在这里展开。');
  }
  const tags = Array.isArray(detail.tags) && detail.tags.length
    ? `<div class="ptx-tags">${detail.tags.map((tag) => `<span class="ptx-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';
  const metadata = detail.metadata || {};
  const metaStatus = isTopicEntry(detail) ? '主题' : entryStatusLabel(detail.status);
  const metaRow = `<div class="ptx-meta">` +
    `<span>日期<b>${escapeHtml(detail.date || '--')}</b></span>` +
    `<span>状态<b>${escapeHtml(metaStatus)}</b></span>` +
    `<span>群聊<b>${escapeHtml(detail.channelId || CHANNEL_ID)}</b></span>` +
    `<span>消息<b>${num(metadata.messageCount)} 条</b></span>` +
    `<span>发言人<b>${num(metadata.participantCount)} 人</b></span></div>`;
  const rawBackground = extractMarkdownSection(detail.markdown, ['背景', 'background']);
  /* 占位行（`_（无额外背景信息）_`）不是内容：主题 / 旧词条都不该在详情里显示这句空话 */
  const background = /^_?（[^）]*）_?$/u.test(rawBackground.replace(/\s+/g, ' ').trim()) ? '' : rawBackground;

  if (state.editingEntryId && state.editingEntryId === detail.id) {
    return renderHead('修正词条', detail.date || '就地编辑', back) + renderEditor(detail);
  }

  const isTopic = isTopicEntry(detail);
  const narrative = typeof detail.narrative === 'string' ? detail.narrative : '';
  const glossary = Array.isArray(detail.glossary) ? detail.glossary : [];
  const mentionNames = speakersOf(detail);

  /* 导语：summary 作导语；有脉络时起因收成一行小字，无脉络（旧词条）背景保留为独立小节。 */
  const lead = `<div class="ptx-sec">` +
    `<div class="ptx-lead">${escapeHtml(detail.summary || '该词条未包含摘要')}</div>` +
    (narrative.trim() && background
      ? `<div class="ptx-cause"><span class="ptx-cause-l">起因</span>${mentionize(background, mentionNames)}</div>`
      : '') +
  `</div>`;

  let body = lead;
  if (!narrative.trim() && background) {
    body += renderSection('背景', `<div class="ptx-text">${mentionize(background, mentionNames)}</div>`);
  }
  if (narrative.trim()) {
    body += renderSection(isTopic ? '主题综述' : '讨论脉络', renderNarrative(narrative, mentionNames));
  }
  if (isTopic) {
    body += renderSection('时间轴', renderTimeline(detail, mentionNames));
  }
  const outcome = renderOutcome(detail, mentionNames);
  if (outcome) body += renderSection('落点', outcome);
  if (glossary.length) {
    body += renderSection('名词注', renderGloss(glossary, mentionNames));
  }
  const appendix = renderAppendix(detail, mentionNames);
  if (appendix) body += `<div class="ptx-sec">${appendix}</div>`;

  return renderHead('词条正文', detail.date || '无日期', back) +
    `<div class="ptx-r-title">${escapeHtml(detail.title || '未命名词条')}</div>` +
    metaRow + tags +
    renderEntryActions() +
    renderSpeakers(speakersOf(detail)) +
    body;
}

function renderStage() {
  if (!viewportEl) return;
  if (state.stage === 'metrics' && viewportEl.querySelector('[data-traffic-summary]')) { updateMetrics(); syncTabs(); return; }
  let html;
  if (state.stage === 'panorama') {
    html = renderPanorama();
  } else if (state.stage === 'metrics') {
    html = renderMetrics();
  } else if (state.stage === 'settings') {
    html = renderSettings();
  } else {
    const isTopicList = state.stage === 'topics';
    html = renderHead(isTopicList ? '主题' : '词条索引',
      `共 ${listEntries().length} ${isTopicList ? '个主题' : '条'}`,
      renderViewToggle()) + renderSpores();
  }

  const key = state.stage + '|' + (state.activeId || '');
  viewportEl.innerHTML = html;
  if (state.stage === 'settings') decorateSettings();
  if (state.stage === 'metrics') updateMetrics();
  if (state.editingEntryId) growEditor();
  if (key !== state.lastView) {
    viewportEl.scrollTop = 0;
    state.lastView = key;
  }
  syncTabs();
}

function syncTabs() {
  if (!rootEl) return;
  const active = state.stage === 'panorama' ? state.listStage : state.stage;
  for (const button of rootEl.querySelectorAll('.ptx-tab')) {
    button.classList.toggle('is-active', button.getAttribute('data-stage') === active);
  }
  /* 设置页签独立于两个核心页签：进入设置时主页签全部非激活，齿轮独占激活态 */
  if (gearBtnEl) gearBtnEl.classList.toggle('is-active', active === 'settings');
}

/* 底栏轮播：数据源是独立的 /api/latest（按最新时间排序），与词条索引的搜索 / 群聊筛选
 * 完全解耦；显示条数与换行间隔由面板设置驱动，改动即时生效。
 * 结构是双槽位交替滑入：容器内恒定只有一个 .ptx-trow.is-active，步进时下一节点从下方
 * 滑入、旧节点向上滑出后 400ms 直接移除——没有长轨道，也就没有首尾循环时的反向倒退
 * 回滚；Tab 焦点永远只落在当前唯一可见的那一条上，跳不进任何幽灵节点。 */
function tickerWindow() {
  return Math.max(1, Math.min(state.latestEntries.length, state.settings.tickerCount));
}

/* 单条节点：有词条时是可直接激活的 <button>，无词条时降级为只读提示行（不带 data-act） */
function tickerRow(entry) {
  const row = entry ? document.createElement('button') : document.createElement('div');
  row.className = 'ptx-trow';
  if (entry) {
    row.setAttribute('type', 'button');
    row.setAttribute('data-act', 'select');
    row.setAttribute('data-id', String(entry.id));
  }
  const dot = document.createElement('span');
  dot.className = 'ptx-tdot';
  const title = document.createElement('span');
  title.className = 'ptx-ttitle';
  /* 无词条时的只读提示：失败 → 空 → 加载中，三者共用同一个槽位 */
  title.textContent = entry
    ? clip(entry.title || '未命名词条', 44)
    : state.latestError ? '最新词条读取失败' : state.latestLoaded ? '暂无最新词条' : '正在加载最新词条';
  row.appendChild(dot);
  row.appendChild(title);
  if (entry) {
    const date = document.createElement('span');
    date.className = 'ptx-tdate';
    date.textContent = entry.date || '--';
    row.appendChild(date);
  }
  return row;
}

function tickerEntry(index) {
  const list = state.latestEntries.slice(0, state.settings.tickerCount);
  return list.length ? list[index % list.length] : null;
}

/* 重建：清空容器并落地唯一激活行（首次加载 / 数据刷新 / 设置变更 / 删除词条后调用） */
function refreshTicker() {
  clearTimeout(state.tickerSwap);
  state.tickerSwap = null;
  if (!tickerEl) return;
  tickerEl.innerHTML = '';
  state.tickerIndex = state.latestEntries.length ? state.tickerIndex % tickerWindow() : 0;
  const row = tickerRow(tickerEntry(state.tickerIndex));
  row.classList.add('is-active');
  tickerEl.appendChild(row);
}

/* 步进：新节点以 .is-entering（下方 100%）追加 → 下一帧旧节点转 .is-leaving、新节点转
 * .is-active → 400ms 后旧节点直接移出 DOM。构建与动画状态之间强制读一次几何，
 * 初始 Transform 才会成为过渡起点，滑入不会被浏览器合并成瞬间换位。 */
function stepTicker() {
  if (!tickerEl || !state.latestEntries.length) return;
  const count = tickerWindow();
  if (count <= 1) return;
  /* 自愈：上一帧被系统吞掉（后台标签页暂停 rAF）时清掉残留的进场 / 离场节点，
   * 容器先回到"只有一个激活行"的不变量，再做下一次步进。 */
  for (const leftover of Array.from(tickerEl.querySelectorAll('.ptx-trow:not(.is-active)'))) {
    leftover.remove();
  }
  const current = tickerEl.querySelector('.ptx-trow.is-active');
  if (!current) {
    refreshTicker();
    return;
  }
  clearTimeout(state.tickerSwap);
  state.tickerSwap = null;
  state.tickerIndex = (state.tickerIndex + 1) % count;
  const incoming = tickerRow(tickerEntry(state.tickerIndex));
  incoming.classList.add('is-entering');
  tickerEl.appendChild(incoming);
  void incoming.offsetHeight;
  requestAnimationFrame(() => {
    if (!tickerEl || !tickerEl.contains(incoming)) return;
    current.classList.remove('is-active');
    current.classList.add('is-leaving');
    /* 离场节点退出 Tab 序列：过渡期间按 Tab 也绝不落进正在淡出的幽灵行 */
    current.setAttribute('tabindex', '-1');
    incoming.classList.remove('is-entering');
    incoming.classList.add('is-active');
    state.tickerSwap = setTimeout(() => {
      state.tickerSwap = null;
      const active = tickerEl ? tickerEl.querySelector('.ptx-trow.is-active') : null;
      if (current === document.activeElement && active) {
        try { active.focus({ preventScroll: true }); } catch (err) { active.focus(); }
      }
      if (current.parentNode) current.parentNode.removeChild(current);
    }, TICKER_SWAP_MS);
  });
}

function startTicker() {
  clearInterval(state.tickerTimer);
  state.tickerTimer = setInterval(() => {
    if (!state.visible || state.collapsed) return;
    stepTicker();
  }, Math.max(TICKER_INTERVAL_MIN, state.settings.tickerInterval) * 1000);
}

function refreshPhase() {
  /* 两种「不是断线」的态要分开说：未认领本页（数据面没启动）、本页接口整片不存在
     （404 / 非 JSON，重连也不会好）。报 OFFLINE 是错误归因。
     失败态只看 `state.own`：元数据认领的页面与点胶囊认领的页面要说出同一个原因。 */
  const phase = !state.own
    ? 'UNOWNED'
    : (state.apiUnavailable
      ? 'API_UNAVAILABLE'
      : (state.status ? String(state.status.phase || 'IDLE') : (state.statusChecked ? 'OFFLINE' : 'LOADING')));
  if (frameEl) frameEl.setAttribute('data-phase', phase);
  if (!phaseEl) return;
  phaseEl.setAttribute('data-phase', phase);
  phaseEl.setAttribute('data-tip', PHASE_TIPS[String(phase).toUpperCase()] || '状态未知');
  phaseEl.innerHTML = `<i></i><span>${escapeHtml(phaseLabel(phase))}</span>`;
}

/* ------------------------------------------------------------------ *
 * 7. 数据层
 * ------------------------------------------------------------------ */

function channelScopeId() {
  if (state.channel && state.channel !== 'all') return state.channel;
  // 「全部」按单群读取时取频道列表首个；没有列表才落到兜底常量
  return (state.channels && state.channels.length > 0 ? state.channels[0] : '') || CHANNEL_ID;
}

function entriesUrl() {
  const params = new URLSearchParams();
  if (state.channel !== 'all') params.set('channelId', state.channel);
  if (state.keyword) params.set('keyword', state.keyword);
  const query = params.toString();
  return `${API_BASE}/api/entries${query ? `?${query}` : ''}`;
}

function applyEntries(list) {
  state.entries = Array.isArray(list) ? list : [];
  if (state.activeId && !state.entries.some((item) => item && item.id === state.activeId)) {
    state.activeId = null;
    state.detail = null;
    state.detailError = '';
    state.editingEntryId = null;
    state.deleteArmed = false;
  }
  if (!state.activeId && state.entries.length) state.activeId = state.entries[0].id;
}

function loadChannels() {
  return requestJson(`${API_BASE}/api/channels`)
    .then((data) => {
      const list = data && Array.isArray(data.channels) ? data.channels : [];
      state.channels = list.length ? list : DEFAULT_CHANNELS.slice();
      if (state.channel !== 'all' && !state.channels.includes(state.channel)) {
        /* 记忆里的群已不存在：回落"全部"并把记忆一并纠正，避免继续用失效范围请求词条 */
        state.channel = 'all';
        setChannelScope('all');
        renderChannelMenu();
        return loadEntries();
      }
      renderChannelMenu();
    })
    .catch(() => renderChannelMenu());
}

function channelItems() {
  return channelMenu ? Array.from(channelMenu.querySelectorAll('.ptx-menu-item')) : [];
}

function renderChannelMenu() {
  if (!channelToggle || !channelMenu) return;
  const label = channelToggle.querySelector('.ptx-selectbtn-label');
  if (label) label.textContent = state.channel === 'all' ? '全部' : `#${state.channel}`;
  const options = [{ value: 'all', text: '全部' }].concat(state.channels.map((id) => ({ value: String(id), text: `#${id}` })));
  channelMenu.innerHTML = options.map((option) =>
    `<button type="button" class="ptx-menu-item" role="option" data-act="channel-pick" data-value="${escapeHtml(option.value)}" aria-selected="${option.value === state.channel ? 'true' : 'false'}">${escapeHtml(option.text)}</button>`
  ).join('');
}

/* 高亮 = 键盘当前位置：移动高亮同时把焦点交给该项（面板里每一项都是 <button>），
   Enter / 空格由原生 button 激活，不额外拦截。 */
function highlightChannelItem(index) {
  const items = channelItems();
  if (!items.length) return;
  const next = ((index % items.length) + items.length) % items.length;
  items.forEach((item, i) => item.classList.toggle('is-active', i === next));
  const item = items[next];
  if (item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
  try { item.focus({ preventScroll: true }); } catch (err) { item.focus(); }
}

function openChannelMenu() {
  if (!channelToggle || !channelMenu) return;
  renderChannelMenu();
  channelMenu.hidden = false;
  channelToggle.setAttribute('aria-expanded', 'true');
  if (channelChip) channelChip.classList.add('is-open');
  /* 高亮落在当前值上（'all' 恒为首项），打开即可用方向键接管 */
  highlightChannelItem(state.channel === 'all' ? 0 : state.channels.indexOf(state.channel) + 1);
}

function closeChannelMenu(focusToggle) {
  if (!channelMenu || channelMenu.hidden) return;
  channelMenu.hidden = true;
  if (channelChip) channelChip.classList.remove('is-open');
  if (channelToggle) {
    channelToggle.setAttribute('aria-expanded', 'false');
    if (focusToggle) channelToggle.focus();
  }
  const active = channelMenu.querySelector('.ptx-menu-item.is-active');
  if (active) active.classList.remove('is-active');
}

/* 选中：写入 state.channel 与本地记忆后沿用原 change 事件里的重新加载逻辑 */
function pickChannel(value) {
  const next = value || 'all';
  closeChannelMenu(true);
  if (next === state.channel) return;
  state.channel = next;
  setChannelScope(next);
  renderChannelMenu();
  state.status = null;
  trafficPoints = [];
  trafficAnchor = 0;
  const line = viewportEl.querySelector('.ptx-ecg-line');
  if (line) line.setAttribute('d', '');
  Promise.all([loadEntries(), loadStatus()]).then(() => {
    refreshPhase();
    renderStage();
  });
  resetIdleTimer();
}

/* 群聊面板的全局键盘 / 外部点击：只在首次挂载时绑定一次。
   Console 会在路由间反复 mount / unmount，若每次都往 document 上挂一份，
   ↑↓ 在第二次挂载后会一步跨两行；channelMenu 为空时这些处理器自动不做任何事。 */
let menuGlobalsBound = false;

function bindMenuGlobals() {
  if (menuGlobalsBound) return;
  menuGlobalsBound = true;

  /* Esc 收起并交还焦点 / ↑↓ 移动高亮 / Tab 离开即收起；
     其余按键照旧只负责重置静置计时。Enter 与空格由面板内的原生 button 自行激活。 */
  document.addEventListener('keydown', (event) => {
    if (!channelMenu || channelMenu.hidden) {
      resetIdleTimer();
      return;
    }
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      closeChannelMenu(true);
      return;
    }
    if (key === 'Tab') {
      closeChannelMenu(false);
      resetIdleTimer();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      let at = channelItems().indexOf(channelMenu.querySelector('.ptx-menu-item.is-active'));
      if (at < 0) at = key === 'ArrowDown' ? -1 : 0;
      highlightChannelItem(key === 'ArrowDown' ? at + 1 : at - 1);
    }
    resetIdleTimer();
  });

  /* 点击面板外部收起：chip 内部的点击留给开合与选中处理器，不在这里抢 */
  document.addEventListener('pointerdown', (event) => {
    if (!channelMenu || channelMenu.hidden) return;
    if (channelChip && channelChip.contains(event.target)) return;
    closeChannelMenu(false);
  });
}

function loadEntries() {
  // 请求代号：切群 / 连续输入关键词时，先发后到的响应不得覆盖后发的。
  const token = (state.entriesRequest = (state.entriesRequest || 0) + 1);
  return requestJson(entriesUrl())
    .then((data) => {
      if (token !== state.entriesRequest) return;
      applyEntries(data);
      state.entriesLoaded = true;
      state.entriesError = '';
      state.entriesFetchedAt = Date.now();
    })
    .catch((err) => {
      if (token !== state.entriesRequest) return;
      // 失败保留「最后已知良好」的列表：把未知物化成空列表会让用户以为词条被删了。
      state.entriesError = err && err.message ? err.message : '网络错误';
      toast(`词条索引读取失败：${state.entriesError}`);
    });
}

/* 列表轮询：后台沉淀 / 另一管理员改名删除后，本页最多 60s 内看见（无需手动刷新）。 */
const ENTRIES_POLL_MS = 60_000;
function pollEntriesIfStale() {
  if (!state.visible || state.stage !== 'entries') return;
  if (Date.now() - (state.entriesFetchedAt || 0) < ENTRIES_POLL_MS) return;
  loadEntries();
}

/* 底栏轮播的独立数据源：只取最新时间序列，不带群聊 / 关键词参数。
 * 失败时保留上一次序列，不打断轮播；不触发任何视图重绘（监控曲线不受影响）。 */
function loadLatest() {
  return requestJson(`${API_BASE}/api/latest?limit=${LATEST_LIMIT}`)
    .then((data) => {
      if (!Array.isArray(data)) throw new Error('最新词条响应格式错误');
      state.latestEntries = data;
      state.latestError = false;
      state.latestLoaded = true;
    })
    .catch(() => { state.latestLoaded = true; state.latestError = true; });
}

let statusRequest = 0;
function loadStatus() {
  const request = ++statusRequest;
  const channel = channelScopeId();
  return requestJson(`${API_BASE}/api/status?channelId=${encodeURIComponent(channel)}`)
    .then((data) => { if (request === statusRequest && channel === channelScopeId()) { state.status = data; state.statusChecked = true; } })
    .catch(() => { if (request === statusRequest && channel === channelScopeId()) { state.status = null; state.statusChecked = true; } });
}

/* 状态轮询：监控页 5 秒（跟随后端 5 秒采样），其余阶段 15 秒；
 * 自调度以便阶段切换即时换挡，收回胶囊期间暂停取数但不丢链。
 * 只在数据面运行中（本插件页）排链：别的插件页上连计时器都不该有。 */
function scheduleStatusPoll() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  if (!state.dataFlow || !state.own) return;
  if (!state.visible) return;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    if (!state.visible) return;
    if (state.collapsed) {
      scheduleStatusPoll();
      return;
    }
    loadStatus().then(() => {
      refreshPhase();
      if (state.stage === 'metrics') updateMetrics();
      pollEntriesIfStale();
      scheduleStatusPoll();
    });
  }, state.stage === 'metrics' ? STATUS_POLL_MS : STATUS_IDLE_POLL_MS);
}

function loadDetail(id) {
  if (!id) return Promise.resolve();
  const token = (state.detailRequest = (state.detailRequest || 0) + 1);
  state.detailLoading = true;
  renderStage();
  return requestJson(`${API_BASE}/api/entries/${encodeURIComponent(id)}`)
    .then((data) => {
      // 代号 + 主键双重复核：慢/快倒挂时正文不得落到别的 activeId 名下。
      if (token !== state.detailRequest || !data || data.id !== id) return;
      state.detail = data;
      state.detailError = '';
    })
    .catch((err) => {
      if (token !== state.detailRequest) return;
      state.detail = null;
      state.detailError = err && err.message ? err.message : '网络错误';
    })
    .then(() => { if (token === state.detailRequest) state.detailLoading = false; });
}

function ensureDetail() {
  if (!state.activeId) return Promise.resolve();
  if (state.detail && state.detail.id === state.activeId) return Promise.resolve();
  return loadDetail(state.activeId);
}

/* ------------------------------------------------------------------ *
 * 8. 轻提示
 * ------------------------------------------------------------------ */

let toastTimer = null;

function toast(text) {
  if (!toastEl) return;
  toastEl.innerHTML = `${organicIcon('check', 11)}<span>${escapeHtml(text)}</span>`;
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2400);
}

/* ------------------------------------------------------------------ *
 * 9. 壳层构建
 * ------------------------------------------------------------------ */

function buildShell() {
  const keys = STAGES.map((stage) => `
      <button class="ptx-tab" data-act="stage" data-stage="${stage.key}" ${tip(stage.tip, 'right')} aria-label="${escapeHtml(stage.label)}">
        ${organicIcon(stage.icon, 17)}
      </button>`).join('');

  const el = document.createElement('div');
  el.id = ROOT_ID;
  el.className = 'ptx-hidden';
  el.innerHTML = `
    <section class="ptx-window" role="region" aria-label="LLMWiki 知识阅读器" data-phase="LOADING">
      <div class="ptx-shell">
      <aside class="ptx-rail">
        <div class="ptx-rail-brand" ${tip('LLMWiki 知识阅读器', 'right')}>${organicIcon('nucleus', 19)}</div>
        <nav class="ptx-keys">${keys}</nav>
        <div class="ptx-rail-foot">
          <button class="ptx-tool ptx-theme" data-act="theme" ${tip('切换夜间主题', 'right')} aria-label="切换夜间主题" aria-pressed="false"><span class="ptx-ico-sun">${organicIcon('sun', 15)}</span><span class="ptx-ico-moon">${organicIcon('moon', 15)}</span></button>
          <button class="ptx-tool ptx-gear" data-act="stage" data-stage="settings" ${tip('面板设置', 'right')} aria-label="面板设置">${organicIcon('settings', 15)}</button>
        </div>
      </aside>

      <section class="ptx-body">
        <header class="ptx-topbar" data-drag="1">
          <div class="ptx-id">
            <span class="ptx-id-glyph">${organicIcon('pulse', 14)}</span>
            <span class="ptx-id-code">LLMWIKI</span>
            <span class="ptx-id-sep"></span>
            <button type="button" class="ptx-phase" data-phase="LOADING" data-act="stage" data-stage="metrics" ${tip('正在连接服务')}><i></i><span>正在连接</span></button>
          </div>
          <div class="ptx-tools">
            <div class="ptx-filter">
              <div class="ptx-chip ptx-channel" ${tip('按群聊筛选')}>
                ${organicIcon('scope', 12)}
                <button type="button" class="ptx-selectbtn" data-act="channel-toggle" aria-haspopup="listbox" aria-expanded="false" aria-label="群聊范围">
                  <span class="ptx-selectbtn-label">全部</span>${organicIcon('chevronDown', 11)}
                </button>
                <div class="ptx-menu" role="listbox" aria-label="群聊范围" hidden></div>
              </div>
              <label class="ptx-chip" ${tip('搜索标题与正文')}>
                ${organicIcon('find', 12)}
                <input class="ptx-find" data-role="search" type="search" placeholder="检索" aria-label="检索词条" autocomplete="off">
              </label>
            </div>
            <div class="ptx-winctl">
              <button class="ptx-winctl-btn" data-act="maximize" ${tip('最大化')} aria-label="最大化" aria-pressed="false"><span class="ptx-ico-max">${organicIcon('maximize', 13)}</span><span class="ptx-ico-restore">${organicIcon('restore', 13)}</span></button>
              <button class="ptx-winctl-btn" data-act="minimize" ${tip('最小化')} aria-label="最小化">${organicIcon('minimize', 13)}</button>
              <button class="ptx-winctl-btn is-close" data-act="close" ${tip('关闭')} aria-label="关闭">${organicIcon('close', 13)}</button>
            </div>
          </div>
        </header>

        <div class="ptx-viewport" id="ptxViewport"></div>

        <footer class="ptx-foot">
          <div class="ptx-ticker" id="ptxTicker" ${tip('最新词条，点击直接阅读')}></div>
          <div class="ptx-foot-acts">
            <button class="ptx-foot-btn is-core" data-act="refresh" ${tip('刷新数据', 'top')} aria-label="刷新数据">${organicIcon('sync', 13)}</button>
          </div>
        </footer>
      </section>
      </div>

      ${resizeLayerMarkup()}
    </section>

    <button class="ptx-pill" data-act="expand" ${tip('点击展开阅读器', 'top')} aria-label="展开 LLMWiki 知识阅读器">
      <span class="ptx-pill-core">${organicIcon('nucleus', 15)}</span>
      <span class="ptx-pill-txt">
        <span class="ptx-pill-name">LLMWiki 知识库</span>
        <span class="ptx-pill-id">知识阅读器</span>
      </span>
    </button>

    <div class="ptx-toast"></div>
  `;

  return el;
}

/* ------------------------------------------------------------------ *
 * 10. 拖拽（视口钳制 + rAF 合并写入）
 * ------------------------------------------------------------------ */

const drag = { active: false, pointerId: 0, startX: 0, startY: 0, originLeft: 0, originTop: 0, dx: 0, dy: 0 };
const resize = { active: false, node: null, dir: '', pointerId: 0, startX: 0, startY: 0, left: 0, top: 0, width: 0, height: 0 };
/* 8 向鼠标光标：手势期间钉在 <html> 上，边缘尚在追帧时也不会退回箭头 */
const RESIZE_CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
let resizeBound = false;
/* 拖拽的 document 级兜底监听同样只注册一次（rootEl 每次 mount 都是新节点） */
let dragBound = false;

const PILL_DRAG_THRESHOLD = 5;
const pillDrag = {
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
  suppressClick: false,
};
let pillBound = false;

function clampPosition(left, top) {
  if (!frameEl) return { left, top };
  const width = frameEl.offsetWidth;
  const height = frameEl.offsetHeight;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, left), maxLeft),
    top: Math.min(Math.max(VIEWPORT_MARGIN, top), maxTop),
  };
}

/* 尺寸区间：下限 min(480 / 360, 视口 - 2×VIEWPORT_MARGIN)，上限即视口内缩后的可用面积。
 * 视口比下限还小时上下限重合，窗口被压进视口——绝不抖动、绝不越界。 */
function sizeBounds() {
  const minWidth = Math.min(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const minHeight = Math.min(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
  return {
    minWidth,
    minHeight,
    maxWidth: Math.max(minWidth, window.innerWidth - VIEWPORT_MARGIN * 2),
    maxHeight: Math.max(minHeight, window.innerHeight - VIEWPORT_MARGIN * 2),
  };
}

function clampGeometry(left, top, width, height) {
  const bounds = sizeBounds();
  const nextWidth = Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth);
  const nextHeight = Math.min(Math.max(height, bounds.minHeight), bounds.maxHeight);
  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, left), Math.max(VIEWPORT_MARGIN, window.innerWidth - nextWidth - VIEWPORT_MARGIN)),
    top: Math.min(Math.max(VIEWPORT_MARGIN, top), Math.max(VIEWPORT_MARGIN, window.innerHeight - nextHeight - VIEWPORT_MARGIN)),
    width: nextWidth,
    height: nextHeight,
  };
}

/* 窗口排版档位：宽度 ≤ 782 / ≤ 562 时挂 is-narrow / is-compact。
   这两处阈值以前由 @container 求值，容器查询会让窗口每次尺寸变化都重算整窗条件。
   现在档位只跟窗口真实宽度走：ResizeObserver 是唯一真源（隐藏 → 可见、@media 改宽都会
   触发，回调里读的是已经布局好的 offsetWidth，不强制回流；档位类不改宽度，不会自我触发），
   另在 applyGeometry（拖动缩放）、最大化 / 还原、视口 resize、重新可见处补显式调用。
   w <= 0 一律直接返回：display:none 的宿主读不到宽度，此时保留上一次档位、绝不清档。 */
const NARROW_MAX = 782;
const COMPACT_MAX = 562;
let tierObserver = null;

function syncResponsiveTier(width) {
  if (!frameEl) return;
  const w = width == null ? frameEl.offsetWidth : width;
  if (!(w > 0)) return;
  frameEl.classList.toggle('is-narrow', w <= NARROW_MAX);
  frameEl.classList.toggle('is-compact', w <= COMPACT_MAX);
}

/* 设备像素对齐：窗口几何必须落在整设备像素网格上。
   125% / 150% 缩放下 1 CSS px = 1.25 / 1.5 设备 px，取整到 CSS px 之后边框每移动一格都会
   在"1 行实线"与"两行各半"之间切换；合成层的 translate3d 落在半个设备像素上更会被双线性
   重采样，整窗发虚。统一对齐到 1 / dpr 网格后，静置、拖动起手、拖动落定只有一种像素形态。 */
function snapPx(value) {
  const dpr = window.devicePixelRatio || 1;
  return Math.round(value * dpr) / dpr;
}

/* 布局位置（保留分数像素）：offsetLeft / offsetTop 会被取整成整数，而我们写入的 left / top
   是设备像素对齐后的分数值（如 1214.4px = 1518 整设备像素）。拿取整值当拖拽起点，位移就带上
   0.4px 偏差，合成层停在半个设备像素上被重采样：整窗发虚，紧贴宿主的顶边/竖边最先显出"撕裂"。
   computedStyle 读的是使用值，分数像素不丢；未定位（auto）时回退 offsetLeft。 */
function layoutOffset(el) {
  try {
    const cs = window.getComputedStyle(el);
    const left = parseFloat(cs.left);
    const top = parseFloat(cs.top);
    if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
  } catch (err) { /* 读不到计算样式时回退整数盒 */ }
  return { left: el.offsetLeft, top: el.offsetTop };
}

function placeFrame(left, top) {
  if (!frameEl) return;
  const next = clampPosition(snapPx(left), snapPx(top));
  frameEl.style.left = `${snapPx(next.left)}px`;
  frameEl.style.top = `${snapPx(next.top)}px`;
}

/* 尺寸 + 位置一次性写入：几何成对更新，不会出现半途越界的中间态 */
function applyGeometry(left, top, width, height) {
  if (!frameEl) return;
  const next = clampGeometry(snapPx(left), snapPx(top), snapPx(width), snapPx(height));
  const nextWidth = snapPx(next.width);
  frameEl.style.width = `${nextWidth}px`;
  frameEl.style.height = `${snapPx(next.height)}px`;
  frameEl.style.left = `${snapPx(next.left)}px`;
  frameEl.style.top = `${snapPx(next.top)}px`;
  /* 同一处提交宽度与档位：布局换挡赶在同一帧完成，缩放过程不会出现“先窄后宽”的抖动 */
  syncResponsiveTier(nextWidth);
}

function commitGeometry(next) {
  if (next.width == null) placeFrame(next.left, next.top);
  else applyGeometry(next.left, next.top, next.width, next.height);
}

/* 拖拽帧：只写 transform，绝不碰 left / top。
   目标位置先钳制到视口内再减起手位置，最后对齐设备像素——合成层因此永远落在整像素上，
   拖动全程零布局、零重绘，边缘的 1px 发丝线不会逐帧重算抗锯齿。 */
function applyDrag(left, top) {
  if (!frameEl) return;
  const next = clampPosition(left, top);
  drag.dx = snapPx(next.left - drag.originLeft);
  drag.dy = snapPx(next.top - drag.originTop);
  frameEl.style.transform = `translate3d(${drag.dx}px, ${drag.dy}px, 0)`;
}

function flushPending() {
  state.rafId = 0;
  const next = state.pending;
  state.pending = null;
  if (!next) return;
  if (next.translate) applyDrag(next.left, next.top);
  else commitGeometry(next);
}

/* 拖拽终结：先把最终 left / top 落定，再在同一帧摘掉 transform。
   此刻 .is-dragging 仍然挂着（transition: none），两条几何写入合并成一次样式计算，
   画面直接停在终点；随后摘类只是恢复过渡，不会补间出“先回原位”的跳变。 */
function settleDrag(final) {
  if (state.rafId) {
    window.cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }
  const next = final || state.pending;
  state.pending = null;
  placeFrame(next ? next.left : drag.originLeft + drag.dx, next ? next.top : drag.originTop + drag.dy);
  if (frameEl) frameEl.style.transform = '';
  drag.dx = 0;
  drag.dy = 0;
}

/* 手势终结：先撤销排队中的帧，再用终止坐标同步落定最终几何。调用方随后才摘除
   is-dragging / is-resizing —— 材质恢复的那一帧拿到的就是最终几何，绝不会出现
   “旧 rAF 在模糊恢复后才回放上一帧尺寸”的二次跳变。 */
function settleGesture(final) {
  if (state.rafId) {
    window.cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }
  const next = final || state.pending;
  state.pending = null;
  if (next) commitGeometry(next);
}

function schedulePlace(left, top) {
  /* translate: 手上有拖拽时本帧走合成层搬运（applyDrag），否则是普通位置提交 */
  state.pending = { left, top, width: null, height: null, translate: drag.active };
  if (state.rafId) return;
  state.rafId = window.requestAnimationFrame(flushPending);
}

function scheduleGeometry(left, top, width, height) {
  state.pending = { left, top, width, height };
  if (state.rafId) return;
  state.rafId = window.requestAnimationFrame(flushPending);
}

function defaultPosition() {
  if (!frameEl) return { left: 24, top: 24 };
  const width = frameEl.offsetWidth || Math.min(820, Math.max(0, window.innerWidth - 48));
  const height = frameEl.offsetHeight || Math.min(560, Math.max(0, window.innerHeight - 120));
  return clampPosition(
    window.innerWidth - width - 24,
    window.innerHeight - height - 24,
  );
}

function bindDrag() {
  if (!frameEl) return;

  rootEl.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest ? event.target.closest('[data-drag="1"]') : null;
    if (!handle) return;
    /* 最大化时窗口由视口接管，拖拽整体禁用 */
    if (state.maximized) return;
    if (event.target.closest('button, input, select, textarea, a')) return;
    if (event.button != null && event.button !== 0) return;
    drag.active = true;
    drag.pointerId = event.pointerId;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    const origin = layoutOffset(frameEl);
    drag.originLeft = origin.left;
    drag.originTop = origin.top;
    drag.dx = 0;
    drag.dy = 0;
    frameEl.classList.add('is-dragging');
    /* 起手只挂类（will-change: transform 在本类上，提升已经生效），绝不在这里写 transform：
       窗口可能正处在收回 / 展开的弹性过渡中（0.56s，transform-origin 100% 100%），此刻写
       translate3d 会把弹簧中途打断成一次硬跳。位移一律从第一帧 pointermove 才写，落点由
       settleDrag 落定。 */
    try { handle.setPointerCapture(event.pointerId); } catch (err) { /* 指针捕获不可用时静默降级 */ }
    resetIdleTimer();
    event.preventDefault();
  });

  /* 文档级兜底监听只注册一次：unmount / 重新 mount 绝不重复挂载。
     指针捕获是主通道（捕获后事件照样冒泡到 document，因此这里每条分支都先判
     drag.active 与 pointerId，绝不会双发）；捕获被浏览器拒绝时，这两条 document
     监听仍然接得住，is-dragging 不会卡死。 */
  if (dragBound) return;
  dragBound = true;

  document.addEventListener('pointermove', (event) => {
    if (!drag.active || event.pointerId !== drag.pointerId) return;
    schedulePlace(
      drag.originLeft + (event.clientX - drag.startX),
      drag.originTop + (event.clientY - drag.startY),
    );
    resetIdleTimer();
  });

  /* 先落定最终几何（left / top）并在同一帧摘掉 transform，再摘除手势类。只有 pointerup
     的坐标可信，pointercancel 直接提交最后一帧待写几何。 */
  const finishDrag = (event) => {
    if (!drag.active) return;
    if (event && event.pointerId != null && event.pointerId !== drag.pointerId) return;
    const final = event && event.type === 'pointerup'
      ? {
        left: drag.originLeft + (event.clientX - drag.startX),
        top: drag.originTop + (event.clientY - drag.startY),
        width: null,
        height: null,
      }
      : null;
    drag.active = false;
    settleDrag(final);
    /* 摘类推到下一帧：settleDrag 把 transform 归零时 .is-dragging 还在（transition: none），
       这一帧的样式计算落定后过渡才恢复。若在同一帧里连 transform 一起改并摘类，浏览器会
       把刚清掉的 translate3d 当成过渡起点，窗口在落点处再补间滑一下——看起来像"回弹"。 */
    if (frameEl) {
      const node = frameEl;
      window.requestAnimationFrame(() => {
        if (!drag.active && node.isConnected) node.classList.remove('is-dragging');
      });
    }
    resetIdleTimer();
  };

  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
}

/* ------------------------------------------------------------------ *
 * 10b. 边缘 / 四角缩放（8 向，Pointer Events + 指针捕获 + rAF 合并写入）
 *
 * 8 向手柄全部内嵌在窗口内部（向内 8px / 四角 16×16，z-index 60），容器保持
 * overflow: hidden；命中之后立刻 setPointerCapture 锁定指针，指针甩出热区甚至
 * 甩出窗口也照样跟随，所以内嵌方案不需要任何外溢补偿。几何始终被钳制在
 * [最小尺寸, 视口内缩 VIEWPORT_MARGIN]，缩到下限只停止更新，绝不抖动、
 * 绝不改变边框厚度与圆角。手势结束在 pointerup / pointercancel /
 * lostpointercapture 三处统一释放，绝不残留捕获或 is-resizing。
 * 手势态不触碰任何材质属性（background / backdrop-filter / box-shadow / display）。
 * ------------------------------------------------------------------ */

function finishResize(pointerId, final) {
  if (!resize.active) return;
  resize.active = false;
  const node = resize.node;
  resize.node = null;
  /* 与拖拽同序：先撤销排队帧并同步落定最终几何，再摘除轻量表面 —— 恢复材质的那一帧
     尺寸已经就位，不会出现“模糊回来了而窗口还差一帧”的断裂感。 */
  settleGesture(final);
  if (frameEl) frameEl.classList.remove('is-resizing');
  document.documentElement.style.cursor = '';
  if (node && pointerId != null) {
    try { node.releasePointerCapture(pointerId); } catch (err) { /* 忽略 */ }
  }
  resetIdleTimer();
}

/* 缩放目标几何：pointermove 与 pointerup 共用同一套增量，终止帧不会停在倒数第二帧的
   尺寸上。西 / 北向以对边为锚：尺寸被钳制时对边保持不动，窗口不会整体漂移。 */
function resizeTarget(clientX, clientY) {
  const dir = resize.dir;
  const dx = clientX - resize.startX;
  const dy = clientY - resize.startY;
  const bounds = sizeBounds();
  const width = dir.includes('e') ? resize.width + dx : (dir.includes('w') ? resize.width - dx : resize.width);
  const height = dir.includes('s') ? resize.height + dy : (dir.includes('n') ? resize.height - dy : resize.height);
  const nextWidth = Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth);
  const nextHeight = Math.min(Math.max(height, bounds.minHeight), bounds.maxHeight);
  return {
    left: dir.includes('w') ? resize.left + (resize.width - nextWidth) : resize.left,
    top: dir.includes('n') ? resize.top + (resize.height - nextHeight) : resize.top,
    width: nextWidth,
    height: nextHeight,
  };
}

function bindResize() {
  if (!frameEl) return;

  frameEl.addEventListener('pointerdown', (event) => {
    const node = event.target.closest ? event.target.closest('[data-resize]') : null;
    if (!node) return;
    /* 最大化时窗口由视口接管，缩放整体禁用；收回态手柄已退场，这里再兜一层 */
    if (state.maximized || state.collapsed) return;
    if (event.button != null && event.button !== 0) return;
    resize.active = true;
    resize.node = node;
    resize.dir = node.getAttribute('data-resize') || '';
    resize.pointerId = event.pointerId;
    resize.startX = event.clientX;
    resize.startY = event.clientY;
    const origin = layoutOffset(frameEl);
    resize.left = origin.left;
    resize.top = origin.top;
    resize.width = frameEl.offsetWidth;
    resize.height = frameEl.offsetHeight;
    state.sized = true;
    frameEl.classList.add('is-resizing');
    /* 几何每帧才追上一次指针，指针会短时落在手柄热区之外；把缩放光标钉在整页上，
       避免光标在缩放方向与箭头之间闪动（视觉上像边缘在抖）。 */
    document.documentElement.style.cursor = RESIZE_CURSORS[resize.dir] || 'nwse-resize';
    try { node.setPointerCapture(event.pointerId); } catch (err) { /* 指针捕获不可用时静默降级 */ }
    resetIdleTimer();
    event.preventDefault();
  });

  /* 文档级监听只注册一次：unmount / 重新 mount 绝不重复挂载 */
  if (resizeBound) return;
  resizeBound = true;

  document.addEventListener('pointermove', (event) => {
    if (!resize.active || event.pointerId !== resize.pointerId) return;
    const next = resizeTarget(event.clientX, event.clientY);
    scheduleGeometry(next.left, next.top, next.width, next.height);
    resetIdleTimer();
  });

  document.addEventListener('pointerup', (event) => {
    if (!resize.active || event.pointerId !== resize.pointerId) return;
    finishResize(resize.pointerId, resizeTarget(event.clientX, event.clientY));
  });
  document.addEventListener('pointercancel', (event) => {
    if (!resize.active || event.pointerId !== resize.pointerId) return;
    finishResize(resize.pointerId, null);
  });
  document.addEventListener('lostpointercapture', () => finishResize(null, null));

  window.addEventListener('resize', () => {
    if (state.maximized || !frameEl) return;
    /* 拖拽进行中：位置归合成层（inline transform）所有，这里写 left / top 会与位移叠加 */
    if (drag.active) return;
    /* 未定尺寸（宽度仍由 CSS 决定）时只钳位置；已定尺寸才夹紧视口 */
    const at = layoutOffset(frameEl);
    if (!state.sized) { placeFrame(at.left, at.top); syncResponsiveTier(); return; }
    applyGeometry(at.left, at.top, frameEl.offsetWidth, frameEl.offsetHeight);
  });
}

/* ------------------------------------------------------------------ *
 * 10c. 悬浮胶囊拖动（Pointer Events + 指针捕获 + rAF 合并写入）
 *
 * 胶囊默认由 CSS 锚定 right / bottom；第一次越过 5px 阈值时把当前位置换算成
 * left / top（right / bottom 置 auto），此后位置完全由行内 left / top 驱动，只在
 * 当前会话保留，不落任何本地存储。拖动只切换 .is-dragging（无过渡、无 transform
 * 形变），四边均按 viewport 内缩 VIEWPORT_MARGIN（14px）夹紧并把胶囊自身宽高计入。
 * 越过阈值后的那一次 click 在 window 捕获阶段被吞掉：不展开面板、不冒泡到宿主
 * 委托；普通点击与键盘 Enter / Space 照常展开。胶囊只在收回态可见，拖动期间绝不
 * 自动收回。pointercancel / lostpointercapture 与原生气势结束时统一清理状态。
 * ------------------------------------------------------------------ */

function pillPlace(left, top) {
  if (!pillEl) return;
  /* 宽高取拖动开始时的布局盒缓存：resize 与每帧写入都不再触发强制重排 */
  if (!pillDrag.width) pillDrag.width = pillEl.offsetWidth;
  if (!pillDrag.height) pillDrag.height = pillEl.offsetHeight;
  /* 四边夹紧：四周内缩 VIEWPORT_MARGIN，胶囊自身宽高计入；视口更小则贴住左上边，绝不越界 */
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - pillDrag.width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - pillDrag.height - VIEWPORT_MARGIN);
  const nextLeft = Math.round(Math.min(Math.max(VIEWPORT_MARGIN, left), maxLeft));
  const nextTop = Math.round(Math.min(Math.max(VIEWPORT_MARGIN, top), maxTop));
  pillEl.style.left = `${nextLeft}px`;
  pillEl.style.top = `${nextTop}px`;
  pillEl.style.right = 'auto';
  pillEl.style.bottom = 'auto';
  pillDrag.left = nextLeft;
  pillDrag.top = nextTop;
  pillDrag.custom = true;
}

function pillFlush() {
  pillDrag.rafId = 0;
  const next = pillDrag.pending;
  pillDrag.pending = null;
  if (next) pillPlace(next.left, next.top);
}

function pillSchedulePlace(left, top) {
  pillDrag.pending = { left, top };
  if (pillDrag.rafId) return;
  pillDrag.rafId = window.requestAnimationFrame(pillFlush);
}

function endPillDrag(keepSuppress) {
  if (!pillDrag.active) return;
  pillDrag.active = false;
  const pending = pillDrag.pending;
  pillDrag.pending = null;
  if (pillDrag.rafId) {
    window.cancelAnimationFrame(pillDrag.rafId);
    pillDrag.rafId = 0;
  }
  /* 先落下最后一帧再释放捕获：pointerup 与最后一次 pointermove 之间的位移绝不丢失 */
  if (pillDrag.moved && pending) pillPlace(pending.left, pending.top);
  if (pillEl) pillEl.classList.remove('is-dragging');
  const pointerId = pillDrag.pointerId;
  pillDrag.pointerId = null;
  if (pillEl && pointerId != null) {
    try { pillEl.releasePointerCapture(pointerId); } catch (err) { /* 忽略 */ }
  }
  if (!keepSuppress) pillDrag.suppressClick = false;
  resetIdleTimer();
}

function bindPill() {
  /* 重挂载：上一次手势的残留一律作废，文档 / window 级监听只注册一次 */
  pillDrag.active = false;
  pillDrag.pointerId = null;
  pillDrag.moved = false;
  pillDrag.pending = null;
  pillDrag.suppressClick = false;
  if (pillDrag.rafId) {
    window.cancelAnimationFrame(pillDrag.rafId);
    pillDrag.rafId = 0;
  }
  if (!pillEl) return;

  pillEl.addEventListener('pointerdown', (event) => {
    /* 新手势开始：上一次拖动遗留的抑制标记一律作废，下一次点击绝不失灵 */
    pillDrag.suppressClick = false;
    if (event.button != null && event.button !== 0) return;
    if (event.isPrimary === false) return;
    pillDrag.active = true;
    pillDrag.pointerId = event.pointerId;
    pillDrag.startX = event.clientX;
    pillDrag.startY = event.clientY;
    pillDrag.moved = false;
    try { pillEl.setPointerCapture(event.pointerId); } catch (err) { /* 指针捕获不可用时静默降级 */ }
    /* 只拦冒泡（窗口拖拽 / 路由不得接管胶囊手势），不 preventDefault：保留按钮原生焦点与键盘激活 */
    event.stopPropagation();
  });

  pillEl.addEventListener('pointermove', (event) => {
    if (!pillDrag.active || event.pointerId !== pillDrag.pointerId) return;
    const dx = event.clientX - pillDrag.startX;
    const dy = event.clientY - pillDrag.startY;
    if (!pillDrag.moved) {
      /* 阈值内一律仍按点击处理：1–4px 的抖动不把点击变成拖动 */
      if (dx * dx + dy * dy < PILL_DRAG_THRESHOLD * PILL_DRAG_THRESHOLD) return;
      pillDrag.moved = true;
      /* 这一次手势之后的 click 必须被吞掉，绝不展开面板 */
      pillDrag.suppressClick = true;
      pillEl.classList.add('is-dragging');
      /* .is-dragging 已把入场动画残留的 transform 收掉，此刻读到的是真实布局盒：
         起点不从 pointerdown 的视觉矩形取，胶囊在缩放动画中被抓住也不会跳一格 */
      const box = pillEl.getBoundingClientRect();
      pillDrag.originLeft = box.left;
      pillDrag.originTop = box.top;
      pillDrag.left = Math.round(box.left);
      pillDrag.top = Math.round(box.top);
      pillDrag.width = box.width;
      pillDrag.height = box.height;
    }
    event.stopPropagation();
    pillSchedulePlace(pillDrag.originLeft + dx, pillDrag.originTop + dy);
    resetIdleTimer();
  });

  pillEl.addEventListener('pointerup', () => endPillDrag(true));
  pillEl.addEventListener('pointercancel', () => endPillDrag(false));
  pillEl.addEventListener('lostpointercapture', () => endPillDrag(false));

  if (pillBound) return;
  pillBound = true;

  /* 捕获失效（元素被移出文档 / 浏览器异常）时的兜底：手势必须在文档级收尾 */
  document.addEventListener('pointerup', () => { if (pillDrag.active) endPillDrag(true); });
  document.addEventListener('pointercancel', () => { if (pillDrag.active) endPillDrag(false); });

  /* 拖动后的那一次 click：window 捕获阶段吞掉，既不展开也不冒泡到宿主委托 */
  window.addEventListener('click', (event) => {
    if (!pillDrag.suppressClick) return;
    const target = event.target;
    const onPill = !!pillEl && (target === pillEl || pillEl.contains(target));
    /* 键盘 Enter / Space 触发的 click（detail 为 0）永不抑制；标记只对紧接拖动的指针 click 生效 */
    if (!onPill || event.detail === 0) { pillDrag.suppressClick = false; return; }
    pillDrag.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  /* 浏览器尺寸变化：自定义位置重新夹紧（默认 right / bottom 锚定由 CSS 自行负责） */
  window.addEventListener('resize', () => {
    if (!pillDrag.custom || pillDrag.active) return;
    pillPlace(pillDrag.left, pillDrag.top);
  });
}

/* ------------------------------------------------------------------ *
 * 11. 自动收回（静置 5 秒弹性收回为呼吸胶囊）
 * ------------------------------------------------------------------ */

function clearIdleTimer() {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function resetIdleTimer() {
  clearIdleTimer();
  /* 拖拽 / 缩放 / 胶囊拖动进行中绝不启动收回计时：手势未结束就收回会打断用户操作 */
  if (drag.active || resize.active || pillDrag.active) return;
  if (!state.settings.autoDock || state.collapsed || !state.visible) return;
  state.idleTimer = setTimeout(collapsePanel, IDLE_COLLAPSE_MS);
}

/* 唯一收回出口：右上角 × 与最小化、静置自动收纳都走这里。
   窗口播放缩放过渡后退场，右下的悬浮球随后接替为唯一入口。 */
function collapsePanel() {
  if (!frameEl || state.collapsed) return;
  clearIdleTimer();
  closeChannelMenu(false);
  state.collapsed = true;
  frameEl.classList.remove('is-docked');
  frameEl.classList.add('is-collapsed');
  setTimeout(() => {
    if (state.collapsed && pillEl) pillEl.classList.add('is-visible');
  }, 180);
  // 折叠过渡结束后再彻底隐藏（摘除 blur 层）；JS 驱动，不依赖 CSS 过渡时序
  setTimeout(() => {
    if (state.collapsed && frameEl) frameEl.classList.add('is-docked');
  }, 470);
}

/* 认领本页的唯一入口：胶囊点击、投递标签右键都走这里。
   必须写 `routeProbe.userClaimed`，否则下一轮 checkRoute 的 routeMatches() 仍为 false，
   syncOwn(false) 会把刚打开的菜单/面板收掉（表现为「闪一下就消失」）。
   路由确实变了走整轮重置：只改 key 会让下一轮 tick 认为「没换页」，
   上一页的接口失败连胜会记到新页头上。 */
function claimOwnPage() {
  const key = currentRouteKey();
  if (routeProbe.key !== key) resetRouteProbe(key);
  routeProbe.userClaimed = true;
  syncAuthGate(true);
}

function expandPanel({ claim = true } = {}) {
  if (!frameEl) return;
  clearIdleTimer();
  /* 点开即认领：胶囊只在本插件的插件页上出现在用户眼前（壳层挂在任何 /plugins/** 页上，
     但未认领的页面只留胶囊）。宿主用随机实例 id 渲染插件页时，标题 / 面包屑 / h1 可能
     一个都读不到 —— 归属是开集问题，正文文本不再参与推断，用户点开胶囊就是唯一凭据：
     认领本页、启动数据面、弹门禁。认领跟着本页走（路由 key 一变就作废，见 resetRouteProbe）。
     `claim: false` 只给元数据迟到命中的自动展开用（见 checkRoute）：那条路已经靠页面身份
     认出来了，再记一笔用户认领，会让宿主随后撤掉元数据时把一页陌生页面留在 own 状态里。 */
  if (claim && isPluginPage()) {
    /* 认领绑定到**点击时刻**的路由：宿主切页后 700ms 内的点击若记在旧 key 上，
       下一轮 tick 会把它当跨页认领清掉，新页白点一次。
       这一句对已认领的页面同样要跑（`state.own` 还是上一页的判定结果），
       而点胶囊在任何插件页上都是「本页归我」的凭据 —— 元数据认领的页面切走后，
       新页第一个可用的凭据就是这一下点击。
       路由确实变了就走整轮重置（与 checkRoute 的 newRoute 分支同一出口）：
       只改 key 会让下一轮 tick 认为「没换页」，上一页的接口失败连胜与「接口不可用」
       就记到新页头上，新页还没发过请求就先触到不可用阈值。 */
    claimOwnPage();
  }
  state.collapsed = false;
  if (pillEl) pillEl.classList.remove('is-visible');
  // 先摘除 docked 让面板立即可见，再撤销折叠态播放展开过渡
  frameEl.classList.remove('is-docked');
  frameEl.classList.remove('is-collapsed');
  /* visibility:hidden 期间宽度读不到，重新可见的这一帧补一次档位判定 */
  syncResponsiveTier();
  setTimeout(resetIdleTimer, 80);
  /* 没认领本页就没有数据面可拉：直接按「不是本插件页」刷新状态位，
     不去发注定被闸口拒掉的请求（也就不用把拒绝当断线来报）。 */
  if (!state.own) {
    refreshPhase();
    return;
  }
  loadStatus().then(() => { refreshPhase(); if (state.stage === 'metrics') updateMetrics(); });
}

function toggleAutoDock() {
  const next = !state.settings.autoDock;
  applySettings({ autoDock: next });
  if (next) {
    resetIdleTimer();
    toast('自动收纳：已启用');
  } else {
    clearIdleTimer();
    toast('自动收纳：已停用');
  }
}

/* ------------------------------------------------------------------ *
 * 11b. 窗口状态：最大化 / 还原、最小化、关闭
 * ------------------------------------------------------------------ */

function syncMaxButton() {
  if (!frameEl) return;
  const button = frameEl.querySelector('.ptx-topbar [data-act="maximize"]');
  if (!button) return;
  const label = state.maximized ? '还原' : '最大化';
  button.setAttribute('aria-label', label);
  button.setAttribute('data-tip', label);
  button.setAttribute('aria-pressed', state.maximized ? 'true' : 'false');
}

/* 最大化：几何整体交给 is-maximized，进入前把行内样式整串存下，还原时原样写回。 */
function maximizePanel() {
  if (!frameEl || state.maximized || state.collapsed) return;
  state.restoreStyle = frameEl.getAttribute('style') || '';
  state.maximized = true;
  frameEl.removeAttribute('style');
  frameEl.classList.add('is-maximized');
  /* 最大化后宽度由视口接管（inset 12px），档位随新宽度重新判定 */
  syncResponsiveTier();
  syncMaxButton();
  clearIdleTimer();
}

function restorePanel() {
  if (!frameEl || !state.maximized) return;
  state.maximized = false;
  frameEl.classList.remove('is-maximized');
  if (state.restoreStyle) frameEl.setAttribute('style', state.restoreStyle);
  else frameEl.removeAttribute('style');
  state.restoreStyle = '';
  syncMaxButton();
  /* 自定义尺寸原样回写；若期间视口变小，只做视口内缩钳制（尺寸仍尽可能保留） */
  if (state.sized) {
    const at = layoutOffset(frameEl);
    applyGeometry(at.left, at.top, frameEl.offsetWidth, frameEl.offsetHeight);
  } else syncResponsiveTier();
  resetIdleTimer();
}

function toggleMaximize() {
  if (state.maximized) restorePanel();
  else maximizePanel();
}

/* ------------------------------------------------------------------ *
 * 11c. 设置页（侧栏底部齿轮，与两个核心页签平级）
 * ------------------------------------------------------------------ */

/* 设置页控件回写：落库后显示值与生效值永远一致（切换页签回来也会重新渲染） */
function decorateSettings() {
  if (!viewportEl || state.stage !== 'settings') return;
  const shell = viewportEl.querySelector('.ptx-settings-shell');
  if (!shell) return;
  const outline = shell.querySelector('.ptx-settings-outline');
  const main = shell.querySelector('.ptx-settings-main');
  if (!outline || !main) return;
  const sections = Array.from(main.children).filter((node) => node.classList && node.classList.contains('ptx-sec'));
  outline.innerHTML = '<div class="ptx-outline-h">大纲</div>';
  sections.forEach((sec, index) => {
    const head = sec.querySelector('.ptx-sec-h');
    if (!head) return;
    const id = `set-sec-${index}`;
    sec.setAttribute('data-sec', id);
    const collapsed = state.settings.collapsedSections[id] === true;
    sec.classList.toggle('is-collapsed', collapsed);
    head.setAttribute('data-action', 'toggle-section');
    head.setAttribute('data-target', id);
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ptx-outline-item';
    item.setAttribute('data-action', 'jump-section');
    item.setAttribute('data-target', id);
    item.textContent = (head.textContent || '').trim();
    outline.appendChild(item);
  });
}

function syncSettingsUI() {
  if (!viewportEl) return;
  const toggle = viewportEl.querySelector('[data-act="autodock"]');
  if (toggle) {
    toggle.classList.toggle('is-on', state.settings.autoDock);
    toggle.setAttribute('aria-checked', state.settings.autoDock ? 'true' : 'false');
  }
  const count = viewportEl.querySelector('[data-role="ticker-count"]');
  if (count) count.value = String(state.settings.tickerCount);
  const interval = viewportEl.querySelector('[data-role="ticker-interval"]');
  if (interval) interval.value = String(state.settings.tickerInterval);
}

/* 设置落库 + 即时生效：轮播条数 / 间隔改动立刻重排并换挡，无需刷新页面 */
function applySettings(patch) {
  const settings = state.settings;
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

/* ------------------------------------------------------------------ *
 * 12. 交互
 * ------------------------------------------------------------------ */

function selectEntry(id) {
  if (!id) return Promise.resolve();
  state.activeId = id;
  state.stage = 'panorama';
  state.editingEntryId = null;
  state.deleteArmed = false;
  state.clearArmed = false;
  state.folds = {};
  return loadDetail(id).then(() => renderStage());
}

/* ---------------- 词条修正 / 删除 / 知识库清空 ----------------
 * 所有写操作都只走 REST（PUT / DELETE / POST /api/clear），成功后先回读列表再重绘，
 * 因此列表、底栏轮播与详情三处显示值永远来自同一份服务端真值。 */
function editorValue(role) {
  const field = viewportEl ? viewportEl.querySelector(`[data-role="${role}"]`) : null;
  return field ? String(field.value == null ? '' : field.value) : '';
}

function splitTags(raw) {
  const out = [];
  for (const part of String(raw == null ? '' : raw).split(/[,，]/)) {
    const tag = part.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function startEdit() {
  if (!state.detail) return;
  state.deleteArmed = false;
  state.editingEntryId = state.detail.id;
  renderStage();
}

function saveEntry() {
  const id = state.editingEntryId;
  if (!id) return Promise.resolve();
  const title = editorValue('entry-title').trim();
  if (!title) { toast('标题不能为空'); return Promise.resolve(); }
  const markdown = editorValue('entry-markdown');
  if (!markdown.trim()) { toast('正文不能为空'); return Promise.resolve(); }
  let status = editorValue('entry-status').trim();
  if (!EDITOR_STATUSES.includes(status)) status = 'open';
  const button = viewportEl ? viewportEl.querySelector('[data-action="save-entry"]') : null;
  if (button) button.classList.add('is-busy');
  return writeJson(`${API_BASE}/api/entries/${encodeURIComponent(id)}`, 'PUT', {
    title,
    status,
    tags: splitTags(editorValue('entry-tags')),
    summary: editorValue('entry-summary').trim(),
    markdown,
  })
    .then((data) => {
      if (data && typeof data === 'object') state.detail = data;
      state.editingEntryId = null;
      state.deleteArmed = false;
      return Promise.all([loadEntries(), loadLatest()]);
    })
    .then(() => {
      refreshTicker();
      renderStage();
      toast('词条已更新');
    })
    .catch((err) => {
      if (button) button.classList.remove('is-busy');
      toast(`词条更新失败：${err && err.message ? err.message : '未知错误'}`);
    });
}

function removeEntry() {
  const id = state.activeId;
  if (!id) return Promise.resolve();
  const button = viewportEl ? viewportEl.querySelector('[data-action="confirm-delete-entry"]') : null;
  if (button) button.classList.add('is-busy');
  return writeJson(`${API_BASE}/api/entries/${encodeURIComponent(id)}`, 'DELETE')
    .then(() => {
      state.activeId = null;
      state.detail = null;
      state.detailError = '';
      state.editingEntryId = null;
      state.deleteArmed = false;
      state.stage = 'entries';
      return Promise.all([loadEntries(), loadLatest()]);
    })
    .then(() => {
      /* 删除后回到索引并保持空选中：不让首条词条被自动顶替成新的当前条目 */
      state.activeId = null;
      state.detail = null;
      refreshTicker();
      renderStage();
      toast('词条已删除');
    })
    .catch((err) => {
      if (button) button.classList.remove('is-busy');
      toast(`删除失败：${err && err.message ? err.message : '未知错误'}`);
    });
}

function clearKnowledgeBase() {
  const button = viewportEl ? viewportEl.querySelector('[data-action="confirm-clear-kb"]') : null;
  if (button) button.classList.add('is-busy');
  return writeJson(`${API_BASE}/api/clear`, 'POST', {})
    .then(() => {
      state.entries = [];
      state.entriesLoaded = true;
      state.entriesError = '';
      state.latestEntries = [];
      state.latestLoaded = true;
      state.latestError = false;
      state.tickerIndex = 0;
      state.activeId = null;
      state.detail = null;
      state.detailError = '';
      state.editingEntryId = null;
      state.deleteArmed = false;
      state.clearArmed = false;
      return Promise.all([loadEntries(), loadLatest()]);
    })
    .then(() => {
      refreshTicker();
      renderStage();
      toast('知识库已清空，保留默认骨架');
    })
    .catch((err) => {
      if (button) button.classList.remove('is-busy');
      toast(`清空失败：${err && err.message ? err.message : '未知错误'}`);
    });
}

/* 就地切换阶段：轮询随阶段换挡；设置页就位后立刻拉取服务端提示词真值 */
function enterStage(next) {
  state.stage = next;
  /* 进入列表页签时记住来源：正文返回键与页签高亮都靠它指路 */
  if (next === 'entries' || next === 'topics') state.listStage = next;
  if (next !== 'panorama') { state.editingEntryId = null; state.deleteArmed = false; }
  if (next !== 'settings') state.clearArmed = false;
  scheduleStatusPoll();
  resetIdleTimer();
  /* 先发起读请求再渲染：首次进设置页时 loading 已置真，不会先闪一句“无字段”。
     非本插件页（数据面没跑）不拉服务端设置 —— 那些请求会被 requestJson 的闸口拦下，
     不如干脆不发起，免得面板里多一行「非本插件页」的假错误。 */
  if (next === 'settings' && state.own) { loadPrompt(); loadRuntimeSettings(); loadCardSettings(); }
  renderStage();
}

function handleAction(action, node) {
  if (action === 'edit-entry') startEdit();
  else if (action === 'delete-entry') { state.deleteArmed = true; renderStage(); }
  else if (action === 'cancel-delete-entry') { state.deleteArmed = false; renderStage(); }
  else if (action === 'confirm-delete-entry') removeEntry().then(() => resetIdleTimer());
  else if (action === 'save-entry') saveEntry().then(() => resetIdleTimer());
  else if (action === 'cancel-edit-entry') { state.editingEntryId = null; renderStage(); }
  else if (action === 'clear-kb') { state.clearArmed = true; renderStage(); }
  else if (action === 'cancel-clear-kb') { state.clearArmed = false; renderStage(); }
  else if (action === 'confirm-clear-kb') clearKnowledgeBase().then(() => resetIdleTimer());
  else if (action === 'save-prompt') savePrompt().then(() => resetIdleTimer());
  else if (action === 'reset-prompt') resetPrompt().then(() => resetIdleTimer());
  else if (action === 'save-topic-prompt') saveTopicPrompt().then(() => resetIdleTimer());
  else if (action === 'reset-topic-prompt') resetTopicPrompt().then(() => resetIdleTimer());
  else if (action === 'toggle-card-mask') toggleCardMask(node).then(() => resetIdleTimer());
  else if (action === 'toggle-section') {
    const target = node && node.getAttribute('data-target');
    if (target) {
      state.settings.collapsedSections[target] = state.settings.collapsedSections[target] !== true;
      saveSettings();
      decorateSettings();
    }
  }
  else if (action === 'jump-section') {
    const target = node && node.getAttribute('data-target');
    const section = target && viewportEl ? viewportEl.querySelector(`[data-sec="${target}"]`) : null;
    if (section) section.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

/* 唯一刷新入口：底栏核心按钮（data-act="refresh" 仅此一处）。
   按钮常驻不随视图重绘，故 is-busy 必须自己收尾，否则刷新一次就永久转圈。 */
function refreshAll() {
  const button = frameEl ? frameEl.querySelector('[data-act="refresh"]') : null;
  if (button) button.classList.add('is-busy');
  return Promise.all([loadEntries(), loadStatus(), loadLatest()]).then(() => {
    refreshTicker();
    refreshPhase();
    renderStage();
    toast('词条索引与监控数据已刷新');
    if (button) button.classList.remove('is-busy');
  });
}

function bindActions() {
  if (!rootEl) return;

  rootEl.addEventListener('click', (event) => {
    const node = event.target.closest ? event.target.closest('[data-act], [data-stage], [data-action], [data-cfg-toggle]') : null;
    if (!node) return;
    const action = node.getAttribute('data-action');
    if (action) {
      handleAction(action, node);
      return;
    }
    if (node.getAttribute('data-cfg-toggle')) {
      /* 布尔开关：先翻转再落库，失败时由 saveRuntimeField 回滚到服务端现值 */
      const on = !node.classList.contains('is-on');
      node.classList.toggle('is-on', on);
      node.setAttribute('aria-checked', on ? 'true' : 'false');
      saveRuntimeField(node).then(() => resetIdleTimer());
      return;
    }
    const act = node.getAttribute('data-act');
    const stage = node.getAttribute('data-stage');

    if (act === 'stage') {
      /* 页签按键与状态胶囊共用同一入口；设置页会在就位后拉取服务端提示词真值 */
      enterStage(stage && node.classList.contains('ptx-tab') ? stage : stage || 'entries');
      return;
    }

    if (act === 'select') {
      selectEntry(node.getAttribute('data-id')).then(() => resetIdleTimer());
      return;
    }

    if (act === 'refresh') {
      refreshAll().then(() => resetIdleTimer());
      return;
    }

    if (act === 'channel-toggle') {
      if (channelMenu && !channelMenu.hidden) closeChannelMenu(false);
      else openChannelMenu();
      resetIdleTimer();
      return;
    }

    if (act === 'channel-pick') {
      pickChannel(node.getAttribute('data-value'));
      return;
    }

    if (act === 'autodock') {
      toggleAutoDock();
      return;
    }

    if (act === 'view-mode') {
      setViewMode(node.getAttribute('data-mode'));
      renderStage();
      resetIdleTimer();
      return;
    }

    if (act === 'theme') {
      toggleTheme();
      resetIdleTimer();
      return;
    }

    if (act === 'maximize') {
      toggleMaximize();
      return;
    }

    if (act === 'minimize' || act === 'close') {
      /* × 与最小化同义：都只把窗口收回成悬浮球，绝不销毁阅读状态 */
      collapsePanel();
      return;
    }

    if (act === 'expand') {
      expandPanel();
      return;
    }

    if (act === 'reload-runtime') {
      loadRuntimeSettings().then(() => resetIdleTimer());
      return;
    }
  });

  /* 运行时参数：开关是按钮，点击即翻转并立刻落库；数值 / 文本 / 枚举走 change */
  rootEl.addEventListener('change', (event) => {
    const node = event.target;
    if (!node || typeof node.getAttribute !== 'function') return;
    if (node.getAttribute('data-cfg-key')) {
      if (node.getAttribute('data-cfg-section') === 'trigger' && node.getAttribute('data-cfg-key') === 'triggerMode') {
        /* 判据模式决定可见字段：先按本地选择即时重排 trigger 组（不重新 GET），保存回执到达后再落定 */
        state.runtimeSettings.draftMode = String(node.value == null ? '' : node.value);
        refreshRuntimeGroup('trigger');
      }
      saveRuntimeField(node).then(() => resetIdleTimer());
      return;
    }
    const field = node.closest ? node.closest('[data-role]') : null;
    if (!field) return;
    const role = field.getAttribute('data-role');
    if (role === 'ticker-count') applySettings({ tickerCount: field.value });
    else if (role === 'ticker-interval') applySettings({ tickerInterval: field.value });
  });

  /* <details> 的 toggle 不冒泡，捕获阶段监听即可把开合态记回 state.folds，
   * 下次整页重绘时用 data-fold 键恢复，不被刷新弹回默认态。 */
  rootEl.addEventListener('toggle', (event) => {
    const node = event.target;
    if (node && node.getAttribute && node.getAttribute('data-fold')) {
      state.folds[node.getAttribute('data-fold')] = !!node.open;
    }
  }, true);

  /* 修正页的摘要 / 正文随输入增高（到上限后由 CSS 接管内部滚动） */
  rootEl.addEventListener('input', (event) => {
    const node = event.target;
    if (!node || node.tagName !== 'TEXTAREA') return;
    const role = node.getAttribute('data-role');
    if (role === 'entry-summary' || role === 'entry-markdown') growField(node);
  });

  channelChip = rootEl.querySelector('.ptx-channel');
  channelToggle = channelChip ? channelChip.querySelector('.ptx-selectbtn') : null;
  channelMenu = channelChip ? channelChip.querySelector('.ptx-menu') : null;
  searchInput = rootEl.querySelector('[data-role="search"]');

  if (searchInput) {
    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.keyword = searchInput.value.trim();
        loadEntries().then(() => renderStage());
      }, 180);
      resetIdleTimer();
    });
  }

  rootEl.addEventListener('pointermove', (event) => {
    if (drag.active) return;
    if (event.target.closest && event.target.closest('.ptx-window')) resetIdleTimer();
  });

  rootEl.addEventListener('wheel', () => resetIdleTimer(), { passive: true });
  bindMenuGlobals();

  if (frameEl) {
    frameEl.addEventListener('mouseenter', clearIdleTimer);
    frameEl.addEventListener('mouseleave', () => {
      if (!drag.active) resetIdleTimer();
    });
  }

  /* 胶囊仅响应显式点击展开（data-act="expand" 委派），hover 不擅自弹出，把控制权交还用户。 */
}

/* ------------------------------------------------------------------ *
 * 12.5 订阅表投递群标签 · 右键策略菜单
 * ------------------------------------------------------------------ *
 * 投递策略的真实编辑入口是 Console 插件页订阅表里的投递群标签（el-tag.is-closable）：
 * 右键 → 菜单 → 写 settings.json。浮窗只负责把策略画成标签后缀。
 * 与宿主 DOM 的全部约定都收敛在这里：
 *   - 行：最近的 tr（Element Plus 表格）或 [role="row"]；
 *   - 监听群号：该行第一格文本；投递群名：标签内 .el-tag__content 文本；
 *   - 后缀：追加在标签末尾的 .ptx-tag-policy，pointer-events:none，
 *     既不吃掉关闭按钮的点击，也不影响 el-select 的下拉展开。
 * 非本插件页一律不发请求（open 前判 isOwnPage，写路径另有一层 guardedFetch）。
 * 本段自成一体（只依赖注入的 document / window），测试按标记载入。
 */
// BEGIN TAG POLICY MENU
const TAG_POLICY_MENU_CLASS = 'ptx-policy-menu';
const TAG_POLICY_SUFFIX_CLASS = 'ptx-tag-policy';
const TAG_POLICY_SUFFIX_ATTR = 'data-ptx-policy';
const TAG_POLICY_STYLE_ID = 'patchouli-tag-policy-style';
const TAG_POLICY_STYLE_MARK = 'tag-policy';
const TAG_POLICY_BOUND_ATTR = 'data-ptx-policy-tag';
/* `collapse-tags` 折叠出来的 `+ N`：被折叠的目标不在 DOM 里（没有 `is-closable` 标签），
   单独打一组标记，右键给出「选择投递目标」列表。 */
const TAG_POLICY_PLUS_ATTR = 'data-ptx-policy-plus';
const TAG_POLICY_COUNT_ATTR = 'data-ptx-policy-count';
const TAG_POLICY_PLUS_TEXT = /^\+\s*\d+$/;
const TAG_POLICY_PICKER_CLASS = 'ptx-policy-picker';
const TAG_POLICY_TARGET_CLASS = 'ptx-policy-target';
/* 一行最多 16 个目标，但同一监听群可以有多行；菜单按钮的 DOM 数量必须有上限。 */
const TAG_POLICY_PICKER_LIMIT = 32;

/* 定时预设：点 chip 只把 cron 填进**本块**的输入框，保存仍然要用户点「保存」（不发请求）。
   日词条每天都有、周主题每周一次，两块各给各的预设，改一块绝不碰另一块。 */
const TAG_POLICY_ENTRY_CRON_PRESETS = [
  { label: '每天 22:00', cron: '0 22 * * *' },
  { label: '每天 09:00', cron: '0 9 * * *' },
];
const TAG_POLICY_WEEKLY_CRON_PRESETS = [
  { label: '每周一 09:00', cron: '0 9 * * 1' },
  { label: '每周五 20:00', cron: '0 20 * * 5' },
];

/* 后缀 + 菜单的全部材质：莫兰迪灰绿（sage / stone / clay），与浮窗 `.ptx-*` 同一套
   发丝线 + 低饱和填充语汇。菜单挂在 body 上（宿主页面，不是浮窗根节点），
   因此不引用 `--bio-*`（那些变量只定义在 #patchouli-organic-root 上）。 */
const TAG_POLICY_STYLES = `.ptx-policy-menu {
  position: fixed;
  z-index: 2147482;
  width: 304px;
  box-sizing: border-box;
  padding: 14px 14px 12px;
  border: 1px solid rgba(74, 84, 76, 0.16);
  border-radius: 12px;
  background: #faf9f5;
  color: #333b35;
  font: 12px/1.5 "Inter", "Segoe UI Variable Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", sans-serif;
  box-shadow: 0 1px 2px rgba(30, 40, 33, 0.08), 0 16px 34px -14px rgba(30, 40, 33, 0.32);
  user-select: none;
}
.ptx-policy-menu.is-dark {
  border-color: rgba(255, 255, 255, 0.1);
  background: #2f3033;
  color: #e6e2dc;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 16px 36px -16px rgba(0, 0, 0, 0.7);
}
.ptx-policy-menu button { font: inherit; }
.ptx-policy-menu button:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(109, 139, 123, 0.24); }
.ptx-policy-menu button:disabled { opacity: 0.5; cursor: default; }
.ptx-policy-menu.is-dark .ptx-policy-head { border-bottom-color: rgba(255, 255, 255, 0.08); }
.ptx-policy-menu.is-dark .ptx-policy-eyebrow { color: #8c8781; }
.ptx-policy-menu.is-dark .ptx-policy-who { color: #dcd8d2; }
.ptx-policy-menu.is-dark .ptx-policy-sec-title { color: #ddd8d2; }
.ptx-policy-menu.is-dark .ptx-policy-sec + .ptx-policy-sec { border-top-color: rgba(255, 255, 255, 0.07); }
.ptx-policy-menu.is-dark .ptx-policy-clear { color: #9db3a6; }
.ptx-policy-menu.is-dark .ptx-policy-clear:hover { color: #bcd0c2; }
.ptx-policy-menu.is-dark .ptx-policy-input,
.ptx-policy-menu.is-dark .ptx-policy-stepper {
  background: #38383d;
  border-color: #4a4a50;
  color: #e6e2dc;
}
.ptx-policy-menu.is-dark .ptx-policy-input::placeholder { color: #7b766f; }
.ptx-policy-menu.is-dark .ptx-policy-stepper:focus-within {
  border-color: #6f8a7c;
  box-shadow: 0 0 0 2px rgba(140, 154, 143, 0.2);
}
.ptx-policy-menu.is-dark .ptx-policy-chip { border-color: rgba(255, 255, 255, 0.12); color: #b6b1ab; }
.ptx-policy-menu.is-dark .ptx-policy-chip:hover { background: #414147; color: #dfe9e2; }
.ptx-policy-menu.is-dark .ptx-policy-field-label { color: #b6b1ab; }
.ptx-policy-menu.is-dark .ptx-policy-count { color: #e6e2dc; }
.ptx-policy-menu.is-dark .ptx-policy-count.is-unlimited { color: #7b766f; }
.ptx-policy-menu.is-dark .ptx-policy-step { color: #b6b1ab; }
.ptx-policy-menu.is-dark .ptx-policy-step:hover { background: #414147; color: #e6e2dc; }
.ptx-policy-menu.is-dark .ptx-policy-hint { color: #8c8781; }
.ptx-policy-menu.is-dark .ptx-policy-blocked { color: #d3bb94; }
.ptx-policy-menu.is-dark .ptx-policy-footnote { color: #8c8781; }
.ptx-policy-menu.is-dark .ptx-policy-error { color: #e39aa1; }
.ptx-policy-menu.is-dark .ptx-policy-actions button {
  border-color: #4a4a50;
  background: transparent;
  color: #ddd8d2;
}
.ptx-policy-menu.is-dark .ptx-policy-actions button:hover { background: #414147; }
.ptx-policy-menu.is-dark .ptx-policy-actions .ptx-policy-save {
  border-color: transparent;
  background: #8c9a8f;
  color: #20241f;
}
.ptx-policy-menu.is-dark .ptx-policy-actions .ptx-policy-save:hover { background: #9aa89d; }
.ptx-policy-menu.is-dark .ptx-policy-target {
  background: #38383d;
  border-color: #4a4a50;
  color: #ddd8d2;
}
.ptx-policy-menu.is-dark .ptx-policy-target:hover { background: #414147; color: #e6e2dc; }
.ptx-policy-menu.is-dark .ptx-policy-target.is-set { border-color: #6f8a7c; color: #b3c8bc; }
.ptx-policy-menu.is-dark .ptx-policy-target.is-set::before { background: #8c9a8f; }
.ptx-policy-menu .ptx-policy-head {
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(74, 84, 76, 0.08);
}
.ptx-policy-menu .ptx-policy-eyebrow {
  display: block;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: #8b948d;
}
.ptx-policy-menu .ptx-policy-who {
  display: block;
  padding-right: 16px;
  font-family: ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: #3c4740;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ptx-policy-menu .ptx-policy-sec { margin-top: 12px; }
.ptx-policy-menu .ptx-policy-sec + .ptx-policy-sec {
  padding-top: 12px;
  border-top: 1px solid rgba(74, 84, 76, 0.08);
}
.ptx-policy-menu .ptx-policy-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.ptx-policy-menu .ptx-policy-sec-title { font-size: 12px; font-weight: 600; color: #3c4740; }
.ptx-policy-menu .ptx-policy-clear {
  padding: 0;
  border: 0;
  background: none;
  color: #5f7d6d;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
}
.ptx-policy-menu .ptx-policy-clear:hover { color: #2f5b45; }
.ptx-policy-menu .ptx-policy-input {
  box-sizing: border-box;
  display: block;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 1px solid rgba(74, 84, 76, 0.2);
  border-radius: 7px;
  background: #fffefb;
  color: #333b35;
  font: 12.5px/1 ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  outline: none;
}
.ptx-policy-menu .ptx-policy-input:focus {
  border-color: rgba(109, 139, 123, 0.62);
  box-shadow: 0 0 0 2px rgba(109, 139, 123, 0.14);
}
.ptx-policy-menu .ptx-policy-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ptx-policy-menu .ptx-policy-chip {
  height: 22px;
  padding: 0 8px;
  border: 1px solid rgba(74, 84, 76, 0.16);
  border-radius: 6px;
  background: transparent;
  color: #5f6b63;
  font-size: 11.5px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
.ptx-policy-menu .ptx-policy-chip:hover {
  border-color: rgba(109, 139, 123, 0.5);
  background: #eef3ef;
  color: #2f5b45;
}
.ptx-policy-menu .ptx-policy-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.ptx-policy-menu .ptx-policy-field + .ptx-policy-field { margin-top: 8px; }
.ptx-policy-menu .ptx-policy-field-label { font-size: 12px; color: #5f6b63; }
.ptx-policy-menu .ptx-policy-stepper {
  display: flex;
  align-items: center;
  flex: none;
  width: 104px;
  height: 28px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid rgba(74, 84, 76, 0.2);
  border-radius: 7px;
  background: #fffefb;
}
.ptx-policy-menu .ptx-policy-step {
  flex: 0 0 30px;
  width: 30px;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: #5f6b63;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.ptx-policy-menu .ptx-policy-step:hover { background: #eef3ef; color: #2f5b45; }
.ptx-policy-menu .ptx-policy-count {
  flex: 1 1 auto;
  width: 44px;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  border-left: 1px solid rgba(74, 84, 76, 0.12);
  border-right: 1px solid rgba(74, 84, 76, 0.12);
  border-radius: 0;
  background: transparent;
  color: #333b35;
  font: 12.5px/1 ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  text-align: center;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: textfield;
}
.ptx-policy-menu .ptx-policy-count::-webkit-outer-spin-button,
.ptx-policy-menu .ptx-policy-count::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ptx-policy-menu .ptx-policy-count.is-unlimited { color: #9aa39c; }
.ptx-policy-menu .ptx-policy-count:focus { outline: none; }
.ptx-policy-menu .ptx-policy-stepper:focus-within {
  border-color: rgba(109, 139, 123, 0.62);
  box-shadow: 0 0 0 2px rgba(109, 139, 123, 0.14);
}
.ptx-policy-menu .ptx-policy-hint { margin: 4px 0 0; font-size: 10.5px; line-height: 1.5; color: #8b948d; }
.ptx-policy-menu .ptx-policy-blocked { margin-top: 9px; font-size: 11px; color: #6f5a3c; white-space: normal; }
.ptx-policy-menu .ptx-policy-targets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0 0;
}
.ptx-policy-menu .ptx-policy-target {
  max-width: 148px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid rgba(74, 84, 76, 0.18);
  border-radius: 995px;
  background: #f2f1ec;
  color: #3c4740;
  font: inherit;
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.ptx-policy-menu .ptx-policy-target:hover { border-color: rgba(109, 139, 123, 0.5); background: #e7efe9; color: #2f5b45; }
.ptx-policy-menu .ptx-policy-target.is-set { border-color: rgba(109, 139, 123, 0.42); color: #2f5b45; }
.ptx-policy-menu .ptx-policy-target.is-set::before {
  content: "";
  display: inline-block;
  width: 4px;
  height: 4px;
  margin-right: 5px;
  border-radius: 50%;
  background: #6d8b7b;
  vertical-align: middle;
}
.ptx-policy-menu .ptx-policy-error {
  display: none;
  font-size: 11px;
  line-height: 1.45;
  color: #a8575f;
  word-break: break-word;
}
.ptx-policy-menu .ptx-policy-error.is-visible { display: block; }
.ptx-policy-menu .ptx-policy-foot { display: flex; align-items: center; gap: 8px; padding-top: 12px; }
.ptx-policy-menu .ptx-policy-foot-left { flex: 1 1 auto; min-width: 0; }
.ptx-policy-menu .ptx-policy-footnote { display: block; font-size: 11px; line-height: 1.4; color: #9aa39c; }
.ptx-policy-menu .ptx-policy-footnote.is-hidden { display: none; }
.ptx-policy-menu .ptx-policy-actions { display: flex; flex: none; justify-content: flex-end; gap: 8px; }
.ptx-policy-menu .ptx-policy-actions button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid rgba(74, 84, 76, 0.18);
  border-radius: 7px;
  background: transparent;
  color: #4d5a51;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
}
.ptx-policy-menu .ptx-policy-actions button:hover { background: #f2f1ec; }
.ptx-policy-menu .ptx-policy-actions .ptx-policy-save {
  border-color: transparent;
  background: #5f7d6d;
  color: #fffefb;
  font-weight: 600;
}
.ptx-policy-menu .ptx-policy-actions .ptx-policy-save:hover { background: #547060; }
.ptx-policy-menu .ptx-policy-actions .ptx-policy-save.is-busy { opacity: 0.5; cursor: default; }
.el-tag[data-ptx-policy]::after {
  content: attr(data-ptx-policy);
  margin-left: 6px;
  padding-left: 6px;
  border-left: 1px solid rgba(90, 100, 92, 0.28);
  font-family: ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.2;
  opacity: 0.72;
  pointer-events: none;
  white-space: nowrap;
}
.el-tag[data-ptx-policy-plus] { cursor: context-menu; }
.el-tag[data-ptx-policy-count]::after {
  content: attr(data-ptx-policy-count);
  margin-left: 6px;
  padding-left: 6px;
  border-left: 1px solid rgba(90, 100, 92, 0.28);
  font-family: ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.2;
  opacity: 0.72;
  pointer-events: none;
  white-space: nowrap;
}
.ptx-tag-policy {
  pointer-events: none;
  display: inline-block;
  max-width: 132px;
  margin-left: 5px;
  padding-left: 6px;
  border-left: 1px solid rgba(90, 100, 92, 0.28);
  font-family: ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 10.5px;
  letter-spacing: 0.01em;
  color: #5f6f66;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}
`;

let tagPolicyMenu = null;

/* 平台前缀归一（`onebot:123` → `123`）：服务端落键时去前缀，表里偶尔带前缀的写法
 * 在这里同步归一并拼键，否则回显会因 `onebot:123` ≠ `123` 全部落空。 */
function normalizePolicySource(source) {
  const raw = String(source == null ? '' : source).trim();
  const prefixed = /^[a-zA-Z][\w-]*:(\d+)$/.exec(raw);
  return prefixed ? prefixed[1] : raw;
}

/* 策略键：同一个投递群在不同监听群下各自独立（`\u0000` 不会出现在群号 / 群名里）。 */
function tagPolicyKey(source, target) {
  return normalizePolicySource(source) + '\u0000' + String(target).trim();
}

/* 单条策略归一化：两条 cron 存原文（服务端才是语法权威），两个计数取非负整数。
   旧版载荷只有一个 `cron`（两类事件共用）：没有 `entryCron` 时按它读，`weeklyCron` 留空。 */
function normalizeTagPolicy(raw) {
  const legacyCron = raw && raw.cron != null ? String(raw.cron).trim() : '';
  const entryCron = raw && raw.entryCron != null ? String(raw.entryCron).trim() : legacyCron;
  const weeklyCron = raw && raw.weeklyCron != null ? String(raw.weeklyCron).trim() : '';
  const perDay = Math.max(0, Math.trunc(Number(raw && raw.perDay) || 0));
  const perWeek = Math.max(0, Math.trunc(Number(raw && raw.perWeek) || 0));
  return { entryCron, weeklyCron, perDay, perWeek };
}

/* 后缀文案：`entryCron·周weeklyCron·perDay/perWeek`，任一段为空就省略；全空 → 空串（不挂后缀）。
   周报那条带「周」前缀：两条表达式并排时不至于分不清哪条管哪类事件。 */
function formatTagPolicy(policy) {
  if (!policy) return '';
  const entryCron = String(policy.entryCron || '').trim();
  const weeklyCron = String(policy.weeklyCron || '').trim();
  const perDay = Math.max(0, Math.trunc(Number(policy.perDay) || 0));
  const perWeek = Math.max(0, Math.trunc(Number(policy.perWeek) || 0));
  const parts = [];
  if (entryCron) parts.push(entryCron);
  if (weeklyCron) parts.push('周' + weeklyCron);
  if (perDay || perWeek) parts.push(perDay + '/' + perWeek);
  return parts.join('·');
}

/* 标签后缀的读写是幂等的：文案没变就不碰 DOM（否则 MutationObserver 会被自己的写入
   再触发一轮，扫描永远停不下来）。 */
function applyTagPolicySuffix(_doc, tag, policy) {
  const text = formatTagPolicy(policy);
  if (!tag || typeof tag.setAttribute !== 'function') return;
  if (!text) {
    if (typeof tag.removeAttribute === 'function') tag.removeAttribute(TAG_POLICY_SUFFIX_ATTR);
    return;
  }
  /* 不往标签里插节点：Vue 的虚拟 DOM 重渲染会把外部插入的 span 抹掉（并连带触发
     MutationObserver → 菜单被当成「标签已消失」收掉）。改用属性 + CSS 伪元素，
     宿主 patch 属性时顶多覆盖一个 aria 无关的属性，不会与渲染冲突。 */
  tag.setAttribute(TAG_POLICY_SUFFIX_ATTR, text);
}

function ensureTagPolicyStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  if (typeof doc.getElementById === 'function' && doc.getElementById(TAG_POLICY_STYLE_ID)) return;
  if (!doc.head || typeof doc.head.appendChild !== 'function') return;
  const style = doc.createElement('style');
  style.id = TAG_POLICY_STYLE_ID;
  style.setAttribute('data-patchouli', TAG_POLICY_STYLE_MARK);
  style.textContent = TAG_POLICY_STYLES;
  doc.head.appendChild(style);
}

/**
 * 投递群标签右键菜单。
 * 依赖全部注入（document / isOwnPage / read / write / readTargets），本段因此可被测试单独载入。
 * `read` 返回 `GET /api/policies` 的载荷（数组或 `{ policies }`），`write` 抛错时
 * 的 `message` 会原样显示在菜单里（服务端 400 的 body.error 已在 writeJson 里抬出来）。
 * `readTargets` 返回 `GET /api/subscriptions` 的载荷（`{ rows: [{ source, targets }] }`）：
 * 只有 `+ N` 折叠标签需要它——被折叠的目标不在 DOM 里，只能从订阅表取回。
 */
function createTagPolicyMenu(options) {
  const opts = options || {};
  const doc = opts.document;
  if (!doc || typeof doc.createElement !== 'function') return null;
  const win = opts.window || null;
  const isOwnPage = typeof opts.isOwnPage === 'function' ? opts.isOwnPage : () => true;
  const readPolicies = typeof opts.read === 'function' ? opts.read : null;
  const writePolicy = typeof opts.write === 'function' ? opts.write : null;
  const readTargets = typeof opts.readTargets === 'function' ? opts.readTargets : null;
  /* 右键标签即「用户要在这个页面配置」——与点胶囊认领同义，不能因为宿主用随机实例 id
     渲染插件页就把右键吞掉（默认菜单已被 preventDefault，不认领就等于什么都不发生）。 */
  const claimPage = typeof opts.claim === 'function' ? opts.claim : null;
  const scanDelay = typeof opts.scanDelay === 'number' ? opts.scanDelay : 60;

  const cache = new Map();
  const bound = new WeakMap();
  const listeners = [];
  let menuEl = null;
  let menuTag = null;
  let observer = null;
  let scanTimer = null;
  let inflight = null;
  let attempted = false;
  /* 服务端策略是否已成功读回：没读回时保存会把未知的现有策略覆盖成 0，先拦住。 */
  let loaded = false;

  /* ---------------- 行 / 标签识别 ---------------- */
  /* 监听群号**不假设列序**：宿主表格可能带索引列 / 展开列，第一个单元格未必是有内容的。
     先逐格找「纯数字 6–12 位」，找不到再退到整行文本里抓第一个群号形状。 */
  function readRowSource(row) {
    if (!row) return '';
    let source = '';
    const cells = row.querySelectorAll ? row.querySelectorAll('td, th') : [];
    for (const cell of cells) {
      /* 宿主把「监听群」渲染成输入框：文本节点是空的，值在 `input.value` 里。 */
      const input = cell.querySelector ? cell.querySelector('input, textarea') : null;
      const value = input && typeof input.value === 'string' ? input.value.trim() : '';
      if (/^\d{6,12}$/.test(value)) {
        source = value;
        break;
      }
      const text = String(cell.textContent == null ? '' : cell.textContent).replace(/\s+/g, ' ').trim();
      if (text === '*' || /^\d{6,12}$/.test(text)) {
        source = text;
        break;
      }
    }
    if (!source) {
      const rowText = String(row.textContent == null ? '' : row.textContent);
      const m = /\b(\d{6,12})\b/.exec(rowText);
      if (m) source = m[1];
      else if (/(^|\s)\*(\s|$)/.test(rowText)) source = '*';
    }
    return source;
  }

  function readTagInfo(tag) {
    if (!tag || typeof tag.closest !== 'function') return null;
    const row = tag.closest('tr') || tag.closest('[role="row"]');
    if (!row) return null;
    const source = readRowSource(row);
    const labelNode = tag.querySelector ? tag.querySelector('.el-tag__content') : null;
    let target = String((labelNode && labelNode.textContent) || '').trim();
    if (!target) {
      /* 老版本 Element Plus 没有 `.el-tag__content`：去掉关闭按钮的文字后取剩余。 */
      const closeBtn = tag.querySelector ? tag.querySelector('.el-tag__close') : null;
      const raw = String(tag.textContent == null ? '' : tag.textContent);
      target = (closeBtn && closeBtn.textContent ? raw.split(closeBtn.textContent).join('') : raw).trim();
    }
    if (!source || !target) return null;
    return { row, source, target, key: tagPolicyKey(source, target) };
  }

  /* ---------------- 后缀同步 ---------------- */
  function paintTag(tag) {
    const info = readTagInfo(tag);
    if (!info) return null;
    applyTagPolicySuffix(doc, tag, cache.get(info.key));
    return info;
  }

  function scan() {
    if (!doc.querySelectorAll) return;
    const tags = doc.querySelectorAll('.el-tag.is-closable');
    for (const tag of tags) {
      if (menuEl && typeof menuEl.contains === 'function' && menuEl.contains(tag)) continue;
      if (tag.getAttribute(TAG_POLICY_BOUND_ATTR) !== '1') bindTag(tag);
      else paintTag(tag);
    }
    scanCollapsed();
  }

  /* ---------------- 折叠标签（`+ N`） ----------------
   * Element Plus 的 `collapse-tags` 把多余目标摘出 DOM，只留一个 `+ N` 标签：
   *   <span class="el-tag"><span class="el-tag__content"><span class="el-select__tags-text">+ 1</span></span></span>
   * 它没有 `is-closable`，所以上面那轮扫描看不见它；目标真值只能回订阅表取。 */
  function readCollapsedSource(host) {
    if (!host || typeof host.closest !== 'function') return '';
    const node = host.querySelector ? host.querySelector('.el-select__tags-text') : null;
    const text = String((node && node.textContent) || '').trim();
    if (!TAG_POLICY_PLUS_TEXT.test(text)) return '';
    const row = host.closest('tr') || host.closest('[role="row"]');
    return row ? readRowSource(row) : '';
  }

  /* 折叠标签上的策略条数：本行监听群下已有几条目标策略（缓存键前缀即监听群）。 */
  function countPolicies(source) {
    const prefix = normalizePolicySource(source) + '\u0000';
    let count = 0;
    cache.forEach((_policy, key) => {
      if (key.indexOf(prefix) === 0) count += 1;
    });
    return count;
  }

  function paintCollapsed(host) {
    const source = readCollapsedSource(host);
    if (!source) return null;
    const count = countPolicies(source);
    if (count > 0) host.setAttribute(TAG_POLICY_COUNT_ATTR, count + ' 条策略');
    else if (typeof host.removeAttribute === 'function') host.removeAttribute(TAG_POLICY_COUNT_ATTR);
    return source;
  }

  function scanCollapsed() {
    if (!doc.querySelectorAll) return;
    const texts = doc.querySelectorAll('.el-select__tags-text');
    for (const node of texts) {
      const text = String(node.textContent == null ? '' : node.textContent).trim();
      if (!TAG_POLICY_PLUS_TEXT.test(text)) continue;
      /* 最内层 `.el-tag` 是 `+ N` 自己的标签；老版本没有 `.el-tag` 时退到选择器项。 */
      const host = (typeof node.closest === 'function' && node.closest('.el-tag'))
        || (typeof node.closest === 'function' ? node.closest('.el-select__selected-item') : null);
      if (!host) continue;
      if (menuEl && typeof menuEl.contains === 'function' && menuEl.contains(host)) continue;
      if (host.getAttribute(TAG_POLICY_PLUS_ATTR) !== '1') bindCollapsed(host);
      else paintCollapsed(host);
    }
  }

  function bindCollapsed(host) {
    if (!host || typeof host.addEventListener !== 'function') return;
    if (!readCollapsedSource(host)) return;
    host.setAttribute(TAG_POLICY_PLUS_ATTR, '1');
    const handler = (event) => {
      const source = readCollapsedSource(host);
      if (!source) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      if (claimPage) claimPage();
      if (!isOwnPage()) return;
      openTargetPicker(source, Number(event && event.clientX) || 0, Number(event && event.clientY) || 0);
    };
    host.addEventListener('contextmenu', handler);
    bound.set(host, handler);
    paintCollapsed(host);
  }

  function bindTag(tag) {
    if (!tag || typeof tag.addEventListener !== 'function') return;
    const info = readTagInfo(tag);
    if (!info) return;
    /* 少数版本的 `+ N` 折叠标签也带 `is-closable`：它是「选择目标」入口，不是投递目标本身。 */
    if (TAG_POLICY_PLUS_TEXT.test(info.target)) return;
    tag.setAttribute(TAG_POLICY_BOUND_ATTR, '1');
    const handler = (event) => {
      const fresh = readTagInfo(tag);
      if (!fresh) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      /* 右键 = 「我要在这页配置」。**无条件**走认领（幂等）：已 own 时也要写
         `routeProbe.userClaimed`，否则 own 若是靠标题文本临时命中，标题一消失
         下一轮 tick 就会 syncOwn(false) 把菜单收掉。 */
      if (claimPage) claimPage();
      if (!isOwnPage()) return;
      openMenu(tag, fresh, Number(event && event.clientX) || 0, Number(event && event.clientY) || 0);
    };
    tag.addEventListener('contextmenu', handler);
    bound.set(tag, handler);
    applyTagPolicySuffix(doc, tag, cache.get(info.key));
  }

  /* ---------------- 策略读取 ---------------- */
  function refresh() {
    if (!readPolicies || !isOwnPage()) return Promise.resolve(false);
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => readPolicies())
      .then((payload) => {
        const list = Array.isArray(payload)
          ? payload
          : (payload && Array.isArray(payload.policies) ? payload.policies : []);
        cache.clear();
        for (const raw of list) {
          if (!raw) continue;
          const source = String(raw.source == null ? '' : raw.source).trim();
          const target = String(raw.target == null ? '' : raw.target).trim();
          if (!source || !target) continue;
          cache.set(tagPolicyKey(source, target), normalizeTagPolicy(raw));
        }
        loaded = true;
        scan();
        return true;
      }, () => false)
      .then((ok) => {
        inflight = null;
        return ok;
      });
    return inflight;
  }

  /* 本插件页归属变化：变真 → 本次进入只读一次策略；变假 → 收起菜单（请求零发出）。 */
  function syncOwn(own) {
    if (!own) {
      attempted = false;
      loaded = false;
      closeMenu();
      return;
    }
    if (attempted) return;
    attempted = true;
    refresh();
  }

  /* ---------------- 菜单 ---------------- */
  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    menuTag = null;
  }

  function onDocPointer(event) {
    if (!menuEl) return;
    const target = event && event.target;
    if (target && typeof menuEl.contains === 'function' && menuEl.contains(target)) return;
    closeMenu();
  }

  function onDocKey(event) {
    if (!menuEl) return;
    if (event && (event.key === 'Escape' || event.key === 'Esc')) closeMenu();
  }

  /* 指针坐标定位 + 视口钳制：贴右边 / 底边时向内收，不把按钮推出屏外。 */
  function placeMenu(root, x, y) {
    const vw = (win && Number(win.innerWidth)) || 1024;
    const vh = (win && Number(win.innerHeight)) || 768;
    const rect = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
    const boxW = rect ? Number(rect.width) || 0 : 0;
    const boxH = rect ? Number(rect.height) || 0 : 0;
    let left = x;
    let top = y;
    if (boxW && left + boxW > vw - 8) left = Math.max(8, vw - boxW - 8);
    if (boxH && top + boxH > vh - 8) top = Math.max(8, vh - boxH - 8);
    root.style.left = left + 'px';
    root.style.top = top + 'px';
  }

  /* 宿主可能切深色主题：按 body 背景亮度给菜单加 is-dark，样式另给一套变量。 */
  function menuThemeClass() {
    try {
      const body = doc.body;
      const style = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(body) : null;
      const raw = style && typeof style.backgroundColor === 'string' ? style.backgroundColor : '';
      const m = /rgba?\(([^)]+)\)/.exec(raw);
      if (m) {
        const parts = m[1].split(',').map((value) => parseFloat(value));
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (!(alpha > 0) || alpha > 0.5) {
          const luma = 0.299 * parts[0] + 0.587 * parts[1] + 0.114 * parts[2];
          return luma < 128 ? ' is-dark' : ' is-light';
        }
      }
    } catch (err) {
      /* 读不到主题就按浅色 */
    }
    return ' is-light';
  }

  /* ---------------- 折叠标签的目标选择 ----------------
   * 被折叠的目标不在 DOM 里，唯一真源是订阅表接口：按本行监听群号筛 `row.targets`。
   * 草稿（还没保存）或接口失败时行里没有目标，菜单只说明原因、不给可点项。 */
  function resolveRowTargets(payload, source) {
    const rows = payload && Array.isArray(payload.rows)
      ? payload.rows
      : (Array.isArray(payload) ? payload : []);
    const wanted = normalizePolicySource(source);
    const out = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (normalizePolicySource(row.source) !== wanted) continue;
      const list = Array.isArray(row.targets) ? row.targets : [];
      for (const raw of list) {
        const target = typeof raw === 'string' ? raw.trim() : '';
        if (!target || out.indexOf(target) >= 0) continue;
        out.push(target);
        if (out.length >= TAG_POLICY_PICKER_LIMIT) return out;
      }
    }
    return out;
  }

  function openTargetPicker(source, x, y) {
    ensureTagPolicyStyles(doc);
    closeMenu();
    if (!doc.body || typeof doc.body.appendChild !== 'function') return;

    const root = doc.createElement('div');
    root.className = TAG_POLICY_MENU_CLASS + ' ' + TAG_POLICY_PICKER_CLASS + menuThemeClass();
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '选择投递目标');

    const head = doc.createElement('div');
    head.className = 'ptx-policy-head';
    const tipNode = doc.createElement('span');
    tipNode.className = 'ptx-policy-eyebrow';
    tipNode.textContent = '选择目标';
    const who = doc.createElement('span');
    who.className = 'ptx-policy-who';
    who.textContent = source;
    head.appendChild(tipNode);
    head.appendChild(who);
    root.appendChild(head);

    const listNode = doc.createElement('div');
    listNode.className = 'ptx-policy-targets';
    root.appendChild(listNode);

    const actions = doc.createElement('div');
    actions.className = 'ptx-policy-actions';
    const cancelBtn = doc.createElement('button');
    cancelBtn.setAttribute('type', 'button');
    cancelBtn.className = 'ptx-policy-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      closeMenu();
    });
    actions.appendChild(cancelBtn);
    root.appendChild(actions);

    const showNote = (text, cls) => {
      /* `textContent` 写入会清空列表：一次只留一种状态，避免旧按钮和新提示并存。 */
      listNode.textContent = '';
      const note = doc.createElement('p');
      note.className = cls;
      note.textContent = text;
      listNode.appendChild(note);
    };
    showNote('正在读取投递目标…', 'ptx-policy-hint');
    /* 读不到目标 = 这行还只是草稿（或接口失败）：说明原因，一个可点项都不给。 */
    const showDraft = () => {
      showNote('目标是草稿，先保存订阅表', 'ptx-policy-blocked');
      root.setAttribute('aria-disabled', 'true');
      placeMenu(root, x, y);
    };

    doc.body.appendChild(root);
    menuEl = root;
    menuTag = null;
    placeMenu(root, x, y);

    if (!readTargets) {
      showDraft();
      return;
    }

    Promise.resolve()
      .then(() => readTargets())
      .then((payload) => {
        /* 回执可能迟到：菜单已被收起 / 换成了别的菜单时不能再往里写。 */
        if (menuEl !== root) return;
        const targets = resolveRowTargets(payload, source);
        if (!targets.length) {
          showDraft();
          return;
        }
        listNode.textContent = '';
        for (const target of targets) {
          const button = doc.createElement('button');
          button.setAttribute('type', 'button');
          button.className = TAG_POLICY_TARGET_CLASS;
          button.setAttribute('data-ptx-target', target);
          button.textContent = target;
          const key = tagPolicyKey(source, target);
          if (cache.has(key)) button.classList.add('is-set');
          button.addEventListener('click', (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            if (menuEl !== root) return;
            if (!isOwnPage()) {
              closeMenu();
              return;
            }
            /* 折叠标签没有可见的 `el-tag` 可回写后缀：`tag` 传 null（见 openMenu 的保存分支）。 */
            openMenu(null, { source, target, key }, x, y);
          });
          listNode.appendChild(button);
        }
        placeMenu(root, x, y);
      }, () => {
        if (menuEl !== root) return;
        showDraft();
      });
  }

  function openMenu(tag, info, x, y) {
    ensureTagPolicyStyles(doc);
    closeMenu();
    if (!doc.body || typeof doc.body.appendChild !== 'function') return;
    const policy = cache.get(info.key) || { entryCron: '', weeklyCron: '', perDay: 0, perWeek: 0 };

    const root = doc.createElement('div');
    root.className = TAG_POLICY_MENU_CLASS + menuThemeClass();
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '投递策略');

    const head = doc.createElement('div');
    head.className = 'ptx-policy-head';
    const eyebrow = doc.createElement('span');
    eyebrow.className = 'ptx-policy-eyebrow';
    eyebrow.textContent = '投递策略';
    const who = doc.createElement('span');
    who.className = 'ptx-policy-who';
    who.textContent = info.source + ' → ' + info.target;
    head.appendChild(eyebrow);
    head.appendChild(who);
    root.appendChild(head);

    /* 通配行（`*`）没有确定的来源群，服务端按 400 拒收：直接在菜单里说明，不给保存入口。 */
    if (info.source === '*') {
      const blocked = doc.createElement('p');
      blocked.className = 'ptx-policy-hint ptx-policy-blocked';
      blocked.textContent = '这行是通配来源（*），没有确定的来源群，暂不支持单独策略；请按具体群号建行后再配置。';
      root.appendChild(blocked);
      const actions = doc.createElement('div');
      actions.className = 'ptx-policy-actions';
      const dismiss = doc.createElement('button');
      dismiss.setAttribute('type', 'button');
      dismiss.className = 'ptx-policy-cancel';
      dismiss.textContent = '知道了';
      dismiss.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        closeMenu();
      });
      actions.appendChild(dismiss);
      root.appendChild(actions);
      doc.body.appendChild(root);
      menuEl = root;
      menuTag = tag;
      placeMenu(root, x, y);
      return;
    }

    /* 一块定时区：标题 + 右侧「立即投」（只清空本块的输入框）+ 输入框 + 预设 chips。
       日词条与周主题各一块：两者节律不同（每天 / 每周），合成一个输入框必然改一个动另一个。 */
    function timeSection(base, titleText, placeholder, presets, cron) {
      const section = doc.createElement('div');
      section.className = 'ptx-policy-sec ptx-policy-sec-' + base;

      const head = doc.createElement('div');
      head.className = 'ptx-policy-sec-head';
      const title = doc.createElement('span');
      title.className = 'ptx-policy-sec-title';
      title.textContent = titleText;
      const clearBtn = doc.createElement('button');
      clearBtn.setAttribute('type', 'button');
      clearBtn.className = 'ptx-policy-clear ptx-policy-' + base + '-clear';
      clearBtn.textContent = '立即投';
      head.appendChild(title);
      head.appendChild(clearBtn);

      const input = doc.createElement('input');
      input.setAttribute('type', 'text');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('aria-label', titleText + '（cron 表达式）');
      input.className = 'ptx-policy-input ptx-policy-cron ptx-policy-' + base + '-cron';
      input.setAttribute('placeholder', placeholder);
      input.value = cron;
      clearBtn.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        /* 清空即「立即投」：只改本块输入框，是否落盘仍由用户点「保存」决定。 */
        input.value = '';
      });

      const chips = doc.createElement('div');
      chips.className = 'ptx-policy-chips';
      for (const preset of presets) {
        const chip = doc.createElement('button');
        chip.setAttribute('type', 'button');
        chip.className = 'ptx-policy-chip';
        chip.setAttribute('data-ptx-cron', preset.cron);
        chip.textContent = preset.label;
        chip.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          /* 预设只填本块的值（保存前的预览），不发请求、不收起菜单。 */
          input.value = preset.cron;
        });
        chips.appendChild(chip);
      }

      section.appendChild(head);
      section.appendChild(input);
      section.appendChild(chips);
      return { section, input };
    }

    const entryTime = timeSection(
      'entry',
      '日词条投递时间',
      '0 22 * * *',
      TAG_POLICY_ENTRY_CRON_PRESETS,
      policy.entryCron,
    );
    const weeklyTime = timeSection(
      'weekly',
      '周主题投递时间',
      '0 9 * * 1',
      TAG_POLICY_WEEKLY_CRON_PRESETS,
      policy.weeklyCron,
    );

    /* 数字控件：`− [ n ] +` 三段。0 展示为「不限」，聚焦 / 点击时换回可编辑的 `0`；
       `+` / `−` 在 0 与上限处钳制（值域由调用方给）。 */
    function countField(labelText, base, value, max) {
      const field = doc.createElement('div');
      field.className = 'ptx-policy-field ptx-policy-field-' + base;
      const label = doc.createElement('span');
      label.className = 'ptx-policy-field-label';
      label.textContent = labelText;

      const stepper = doc.createElement('div');
      stepper.className = 'ptx-policy-stepper';

      const down = doc.createElement('button');
      down.setAttribute('type', 'button');
      down.className = 'ptx-policy-step ptx-policy-step-down ptx-policy-' + base + '-down';
      down.setAttribute('aria-label', '减少' + labelText);
      down.textContent = '−';

      const input = doc.createElement('input');
      input.setAttribute('type', 'text');
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('aria-label', labelText);
      input.className = 'ptx-policy-count ptx-policy-' + base;

      const up = doc.createElement('button');
      up.setAttribute('type', 'button');
      up.className = 'ptx-policy-step ptx-policy-step-up ptx-policy-' + base + '-up';
      up.setAttribute('aria-label', '增加' + labelText);
      up.textContent = '+';

      const clamp = (raw) => {
        const parsed = Math.trunc(Number(raw));
        return Math.min(max, Math.max(0, Number.isFinite(parsed) ? parsed : 0));
      };
      let current = clamp(value);
      const render = () => {
        const unlimited = current === 0;
        input.value = unlimited ? '不限' : String(current);
        input.classList.toggle('is-unlimited', unlimited);
        down.disabled = current <= 0;
        up.disabled = current >= max;
      };
      const commit = (raw) => {
        current = clamp(raw);
        render();
      };
      /* 输入框里可能是「不限」：解析失败按 0，绝不把 NaN 带进保存。 */
      const read = () => clamp(input.value);
      const reveal = () => {
        if (current !== 0) return;
        input.value = '0';
        input.classList.remove('is-unlimited');
      };
      input.addEventListener('focus', reveal);
      input.addEventListener('click', reveal);
      input.addEventListener('blur', () => commit(input.value));
      down.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        commit(read() - 1);
      });
      up.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        commit(read() + 1);
      });

      stepper.appendChild(down);
      stepper.appendChild(input);
      stepper.appendChild(up);
      field.appendChild(label);
      field.appendChild(stepper);
      render();
      return { field, read };
    }

    const limitSec = doc.createElement('div');
    limitSec.className = 'ptx-policy-sec ptx-policy-sec-limit';
    const limitHead = doc.createElement('div');
    limitHead.className = 'ptx-policy-sec-head';
    const limitTitle = doc.createElement('span');
    limitTitle.className = 'ptx-policy-sec-title';
    limitTitle.textContent = '限量';
    limitHead.appendChild(limitTitle);
    limitSec.appendChild(limitHead);

    /* 值域：词条每天最多 1000、周报每周最多 100（与服务端一致的量级护栏）。 */
    const perDayField = countField('词条 / 日', 'perday', policy.perDay, 1000);
    const perWeekField = countField('周报 / 周', 'perweek', policy.perWeek, 100);
    limitSec.appendChild(perDayField.field);
    limitSec.appendChild(perWeekField.field);

    root.appendChild(entryTime.section);
    root.appendChild(weeklyTime.section);
    root.appendChild(limitSec);

    const errorNode = doc.createElement('div');
    errorNode.className = 'ptx-policy-error';
    const note = doc.createElement('span');
    note.className = 'ptx-policy-footnote';
    note.textContent = '0 = 不限 · 空 = 立即投';
    const footLeft = doc.createElement('div');
    footLeft.className = 'ptx-policy-foot-left';
    footLeft.appendChild(note);
    footLeft.appendChild(errorNode);

    const actions = doc.createElement('div');
    actions.className = 'ptx-policy-actions';
    const cancelBtn = doc.createElement('button');
    cancelBtn.setAttribute('type', 'button');
    cancelBtn.className = 'ptx-policy-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      closeMenu();
    });
    const saveBtn = doc.createElement('button');
    saveBtn.setAttribute('type', 'button');
    saveBtn.className = 'ptx-policy-save';
    saveBtn.textContent = '保存';
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    const foot = doc.createElement('div');
    foot.className = 'ptx-policy-foot';
    foot.appendChild(footLeft);
    foot.appendChild(actions);
    root.appendChild(foot);

    /* 错误占底部左侧说明的位置：有错误时收起说明，成功后恢复。 */
    const showError = (text) => {
      const message = text == null ? '' : String(text);
      errorNode.textContent = message;
      errorNode.classList.toggle('is-visible', !!message);
      note.classList.toggle('is-hidden', !!message);
    };

    let saving = false;
    saveBtn.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (saving || !writePolicy) return;
      /* 策略还没读回来就保存，会把服务端上未知的 cron / 限量覆盖成默认值：先补读一次。 */
      if (!loaded) {
        showError('策略尚未读取完成，正在重试…');
        refresh();
        return;
      }
      const next = {
        source: info.source,
        target: info.target,
        entryCron: String(entryTime.input.value == null ? '' : entryTime.input.value).trim(),
        weeklyCron: String(weeklyTime.input.value == null ? '' : weeklyTime.input.value).trim(),
        perDay: perDayField.read(),
        perWeek: perWeekField.read(),
      };
      showError('');
      saving = true;
      saveBtn.disabled = true;
      saveBtn.classList.add('is-busy');
      saveBtn.textContent = '保存中…';
      const settle = () => {
        saving = false;
        saveBtn.disabled = false;
        saveBtn.classList.remove('is-busy');
        saveBtn.textContent = '保存';
      };
      /* 一次点击最多一次 POST：按钮在回执前不再接受新的保存。 */
      Promise.resolve()
        .then(() => writePolicy(next))
        .then(() => {
          cache.set(info.key, normalizeTagPolicy(next));
          if (tag) {
            applyTagPolicySuffix(doc, tag, next);
          }
          /* 折叠徽标的条数取自缓存：缓存一改就要重画（这次没有可见标签可写时也一样）。 */
          scanCollapsed();
          /* 回执可能迟到：这期间用户已打开另一个目标的菜单，此时不能把新菜单关掉。 */
          if (menuEl === root) closeMenu();
        }, (err) => {
          settle();
          showError(err && err.message ? String(err.message) : '保存失败');
        });
    });

    doc.body.appendChild(root);
    menuEl = root;
    menuTag = tag;
    placeMenu(root, x, y);
  }

  /* ---------------- 生命周期 ---------------- */
  function attach() {
    ensureTagPolicyStyles(doc);
    scan();
    if (!observer) {
      const MO = opts.MutationObserver || (win && win.MutationObserver);
      if (typeof MO === 'function' && doc.body) {
        observer = new MO(() => {
          if (scanTimer) return;
          /* 宿主一次渲染会连发几十条 childList：合并成一轮扫描，不吃掉 Vue 的帧。 */
          scanTimer = setTimeout(() => {
            scanTimer = null;
            /* 标签被宿主重渲染时**不关菜单**：Vue patch 会换掉节点，菜单是用户显式打开的弹层，
               关掉它等于「鼠标一移开菜单就消失」。菜单只由外部点击 / Esc / 路由变化 / 保存收起。 */
            scan();
          }, scanDelay);
        });
        observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
      }
    }
    if (!listeners.length && typeof doc.addEventListener === 'function') {
      /* 滚动也会让 fixed 坐标的菜单脱离标签：滚动即收（菜单自身不滚动）。 */
      const pairs = [['mousedown', onDocPointer], ['keydown', onDocKey]];
      for (const pair of pairs) {
        doc.addEventListener(pair[0], pair[1], true);
        listeners.push(pair);
      }
    }
  }

  function destroy() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    closeMenu();
    while (listeners.length) {
      const pair = listeners.pop();
      if (typeof doc.removeEventListener === 'function') doc.removeEventListener(pair[0], pair[1], true);
    }
    if (doc.querySelectorAll) {
      const seen = new Set();
      const nodes = [
        ...doc.querySelectorAll('.el-tag.is-closable'),
        ...doc.querySelectorAll('[' + TAG_POLICY_PLUS_ATTR + '="1"]'),
        ...doc.querySelectorAll('[' + TAG_POLICY_COUNT_ATTR + ']'),
      ];
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        const handler = bound.get(node);
        if (handler && typeof node.removeEventListener === 'function') node.removeEventListener('contextmenu', handler);
        bound.delete(node);
        if (typeof node.removeAttribute !== 'function') continue;
        node.removeAttribute(TAG_POLICY_BOUND_ATTR);
        node.removeAttribute(TAG_POLICY_SUFFIX_ATTR);
        node.removeAttribute(TAG_POLICY_PLUS_ATTR);
        node.removeAttribute(TAG_POLICY_COUNT_ATTR);
      }
    }
    cache.clear();
    attempted = false;
    loaded = false;
    inflight = null;
  }

  return { attach, destroy, scan, refresh, syncOwn, openMenu, closeMenu, readTagInfo, formatSuffix: formatTagPolicy };
}
// END TAG POLICY MENU

/* ------------------------------------------------------------------ *
 * 13. 挂载 / 路由感应 / 生命周期
 * ------------------------------------------------------------------ */

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = ORGANIC_STYLES;
  document.head.appendChild(style);
}

/* 宿主深色主题没有覆盖 Element Plus 的 .el-tag：插件配置卡里多选出来的标签
 * （订阅表「投递群」列）在夜间是白底黑字。上游 CSS 改不了，这里补一段覆盖，
 * 让标签与同排输入框同材质：1 级填充（--bg1）+ 输入框描边（--k-color-border）
 * + 正文色（--k-text-dark = --fg1，即 --el-input-text-color 的取值）+ 输入框
 * 圆角（--el-border-radius-base）。变量名取自 @koishijs/client 5.30 的
 * app/styles/index.scss 与 app/styles/element.scss——Koishi 没有
 * --k-color-fill-* / --k-color-text，别再退回半透明白当底色。
 *
 * 作用域用 `.k-schema-item`：`k-schema` 是 Vue 组件标签而不是类名，
 * schemastery-vue 的真实根节点是 .k-schema-item（base.vue）。选择器绝不以
 * `.el-tag` 裸开头，不触碰其它插件的外层 UI。 */
const SCHEMA_TAG_STYLE_MARK = 'schema-tag-theme';
const SCHEMA_TAG_STYLES = `.k-schema-item .el-select .el-tag {
  background: var(--bg1, transparent);
  border-color: var(--k-color-border, transparent);
  color: var(--k-text-dark, var(--fg1, inherit));
  border-radius: var(--el-border-radius-base, 4px);
  font-size: 12px;
  margin: 2px 0;
}
.k-schema-item .el-select .el-tag .el-tag__close { color: inherit; opacity: .6; border-radius: 2px; }
.k-schema-item .el-select .el-tag .el-tag__close:hover { opacity: 1; background: rgba(127, 127, 127, .18); }
`;

/* 幂等：同一页面无论挂载多少次，只落一个 <style>。 */
function ensureSchemaTagTheme() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.head.querySelector('style[data-patchouli="' + SCHEMA_TAG_STYLE_MARK + '"]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-patchouli', SCHEMA_TAG_STYLE_MARK);
  style.textContent = SCHEMA_TAG_STYLES;
  document.head.appendChild(style);
}

// BEGIN GENERATED AUTH GATE
(() => {
  const base = "/patchouli";
  const SESSION_KEY = "patchouli.session";
  const EXPIRY_KEY = "patchouli.expires";
  const OVERLAY_ID = 'ptx-auth-gate';
  const read = (key) => { try { return window.localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { window.localStorage.setItem(key, value); } catch {} };
  const clear = () => { try { window.localStorage.removeItem(SESSION_KEY); window.localStorage.removeItem(EXPIRY_KEY); } catch {} };

  const session = () => {
    const sid = read(SESSION_KEY);
    const exp = Number(read(EXPIRY_KEY) || '0');
    if (!sid) return null;
    if (!Number.isFinite(exp) || exp <= Date.now() + 30000) return null;
    return sid;
  };
  const saveSession = (payload) => {
    write(SESSION_KEY, payload.session);
    write(EXPIRY_KEY, String(payload.expiresAt || 0));
  };

  const rawFetch = window.fetch.bind(window);
  let overlayOpen = false;
  /* 门禁只属于**本插件页**：Console 浮窗挂在任何 /plugins/** 页上，但全屏遮罩只许盖在
     本插件自己的配置页 —— 否则别人的插件页会被登录 / 首次初始化对话框堵住。
     Console 组件按路由写入（setOwnPage）；独立页面永远是本页，故默认 true。
     读一律走 isOwnPage() **现读**：路由标记每 700ms 才更新一轮，任何一次快照都可能
     在用户已经离开本页之后还认为「这是我的页」，于是把遮罩盖到别人的插件页上。 */
  let ownPageState = true;
  const isOwnPage = () => ownPageState === true;

  const shell = (inner) => {
    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('style', 'position:fixed;inset:0;z-index:2147483;display:flex;align-items:center;justify-content:center;background:rgba(5,9,16,.9);backdrop-filter:blur(6px);font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;color:#e8edf7');
    const card = document.createElement('form');
    card.setAttribute('style', 'width:min(440px,88vw);padding:26px 24px;border-radius:16px;background:rgba(19,25,40,.97);border:1px solid rgba(255,255,255,.13);box-shadow:0 24px 70px rgba(0,0,0,.55)');
    card.innerHTML = inner;
    root.appendChild(card);
    return { root, card };
  };

  const mountOverlay = (root) => {
    if (overlayOpen) return false;
    overlayOpen = true;
    document.body.appendChild(root);
    return true;
  };

  const finish = () => {
    overlayOpen = false;
    const node = document.getElementById(OVERLAY_ID);
    if (node) node.remove();
  };

  /* 普通登录：粘贴已保存的密钥。 */
  const showLogin = (message) => {
    const { root, card } = shell(
      '<div style="font-size:15px;font-weight:600;letter-spacing:.02em">需要访问密钥</div>' +
      '<div style="margin-top:8px;font-size:12px;line-height:1.85;color:rgba(232,237,247,.62)">管理面已启用鉴权。填入首次初始化时保存的密钥；' +
      '服务器上的副本在 <code>&lt;知识库&gt;/.patchouli/api-token.txt</code>。</div>' +
      '<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="管理密钥" ' +
      'style="margin-top:14px;width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e8edf7;font:13px/1.4 ui-monospace,monospace;outline:none">' +
      '<div data-err style="margin-top:8px;font-size:12px;color:#f08a7a;min-height:16px">' + (message || '') + '</div>' +
      '<button type="submit" style="margin-top:6px;width:100%;padding:10px;border-radius:10px;border:0;background:#3f9d78;color:#06120d;font-size:13px;font-weight:600;cursor:pointer">进入</button>'
    );
    if (!mountOverlay(root)) return;
    const input = card.querySelector('input');
    const err = card.querySelector('[data-err]');
    if (input) input.focus();
    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = (input && input.value || '').trim();
      if (value === '') return;
      const response = await rawFetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token: value }),
      }).catch(() => null);
      if (response === null || !response.ok) {
        if (err) err.textContent = '密钥无效（服务器返回 ' + (response ? response.status : '网络错误') + '）';
        return;
      }
      const payload = await response.json().catch(() => null);
      if (!payload || !payload.session) {
        if (err) err.textContent = '登录响应缺少会话票据';
        return;
      }
      saveSession(payload);
      finish();
      window.dispatchEvent(new CustomEvent('patchouli:auth'));
      window.location.reload();
    });
  };

  /* 首次初始化：留空自动生成，成功后一次性展示密钥。 */
  const showInit = () => {
    const { root, card } = shell(
      '<div style="font-size:15px;font-weight:600;letter-spacing:.02em">首次初始化</div>' +
      '<div style="margin-top:8px;font-size:12px;line-height:1.85;color:rgba(232,237,247,.62)">还没有管理密钥。可以留空由服务端生成，' +
      '也可以自己填一个（至少 16 个字符）。密钥会写入 <code>&lt;知识库&gt;/.patchoulI/api-token.txt</code>，之后每次打开面板用它登录。</div>'
        .replace('.patchoulI', '.patchouli') +
      '<input name="token" type="text" autocomplete="off" spellcheck="false" placeholder="留空 = 自动生成" ' +
      'style="margin-top:14px;width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e8edf7;font:13px/1.4 ui-monospace,monospace;outline:none">' +
      '<div data-err style="margin-top:8px;font-size:12px;color:#f08a7a;min-height:16px"></div>' +
      '<button type="submit" style="margin-top:6px;width:100%;padding:10px;border-radius:10px;border:0;background:#3f9d78;color:#06120d;font-size:13px;font-weight:600;cursor:pointer">生成并进入</button>'
    );
    if (!mountOverlay(root)) return;
    const input = card.querySelector('input');
    const err = card.querySelector('[data-err]');
    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = (input && input.value || '').trim();
      const response = await rawFetch(base + '/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(value === '' ? {} : { token: value }),
      }).catch(() => null);
      if (response === null) {
        if (err) err.textContent = '网络错误，请重试';
        return;
      }
      if (response.status === 409) {
        finish();
        showLogin('已完成初始化，请输入管理密钥。');
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (err) err.textContent = (payload && payload.message) || ('初始化失败（' + response.status + '）');
        return;
      }
      const payload = await response.json().catch(() => null);
      if (!payload || !payload.token || !payload.session) {
        if (err) err.textContent = '初始化响应不完整';
        return;
      }
      saveSession(payload);
      card.innerHTML =
        '<div style="font-size:15px;font-weight:600">初始化完成</div>' +
        '<div style="margin-top:8px;font-size:12px;line-height:1.85;color:rgba(232,237,247,.62)">这是管理密钥，只显示这一次；已写入 <code>' +
        String(payload.tokenPath || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code>。请复制保存，之后打开面板用它登录。</div>' +
        '<div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);font:12px/1.6 ui-monospace,monospace;word-break:break-all;user-select:all">' +
        String(payload.token).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>' +
        '<button type="button" data-enter style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:0;background:#3f9d78;color:#06120d;font-size:13px;font-weight:600;cursor:pointer">我已保存，进入</button>';
      const enter = card.querySelector('[data-enter]');
      if (enter) enter.addEventListener('click', () => {
        finish();
        window.dispatchEvent(new CustomEvent('patchouli:auth'));
        window.location.reload();
      });
    });
  };

  /* 每个 /api 请求自动带会话票据；401 视为过期/吊销，重新门禁。 */
  window.fetch = (input, init) => {
    const target = typeof input === 'string' ? input : (input && input.url) || '';
    const isApi = target.includes(base + '/api/');
    const sid = session();
    if (sid && isApi) {
      const headers = new Headers((init && init.headers) || (typeof input === 'string' ? undefined : input.headers));
      if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + sid);
      init = Object.assign({}, init, { headers });
    }
    const pending = rawFetch(input, init);
    if (!isApi) return pending;
    return pending.then((response) => {
      if (response.status === 401) {
        /* 票据确实过期 / 被吊销：一律清掉，但不一定重弹门禁 ——
           别的插件页上这块全屏遮罩会盖住宿主的表单，而那不是用户此刻在操作的页面。
           数据面本身也只在本插件页取数（Console 侧 requestJson 同一条契约），这里是兜底。 */
        clear();
        /* 现读：请求在途时用户可能已经离开本插件页（路由轮询 700ms 一轮）。 */
        if (isOwnPage()) gate('会话已过期，请重新输入。');
      }
      return response;
    });
  };

  /* 门禁入口：无有效会话时按服务端状态选「首次初始化」或「登录」。
   * 独立页面在加载时调用，Console 组件在打开悬浮窗时调用；重复调用幂等。
   * dismiss 供宿主路由离开本插件页时收起模态——否则遮罩会跟着留在别人的插件页上。
   */
  const gate = (message) => {
    /* 兜底：非本插件页一律不开门禁（含 401 路径与宿主直接调用）。 */
    if (!isOwnPage()) return;
    if (overlayOpen) return;
    /* /session 探测是异步的：用户可能在探测在途时离开本插件页。每次回写都现读标记，
       晚到的结果一律丢弃 —— 清票据可以，遮罩绝不能盖到别人的插件页上。 */
    const leftSinceProbe = () => {
      if (isOwnPage()) return false;
      clear();
      return true;
    };
    if (!session()) {
      rawFetch(base + '/session', { credentials: 'same-origin' })
        .then((response) => response.json())
        .then((state) => {
          if (leftSinceProbe()) return;
          if (state && state.authenticated === true) return;
          if (state && state.bootstrapRequired === true) showInit();
          else showLogin(message || '');
        })
        .catch(() => {
          if (leftSinceProbe()) return;
          showLogin(message || '网络错误');
        });
      return;
    }
    rawFetch(base + '/session', {
      headers: { Authorization: 'Bearer ' + session() },
      credentials: 'same-origin',
    })
      .then((response) => response.json())
      .then((state) => {
        if (leftSinceProbe()) return;
        if (state && state.authenticated === true) {
          if (state.expiresAt) write(EXPIRY_KEY, String(state.expiresAt));
          return;
        }
        clear();
        if (state && state.bootstrapRequired === true) showInit();
        else showLogin('会话已失效，请重新输入。');
      })
      .catch(() => {
        /* 网络抖动不算会话失效：只在本页仍需遵循「离开即清票据」这一条。 */
        leftSinceProbe();
      });
  };

  window.__ptxAuth = {
    gate,
    dismiss: finish,
    hasSession: () => session() !== null,
    /* 本插件页判定：Console 组件按路由写状态源；门禁与 401 兜底每次现读 isOwnPage。 */
    setOwnPage: (value) => { ownPageState = value === true; },
    isOwnPage,
  };
})();
// END GENERATED AUTH GATE

/* 壳层与会话门禁：mount() 只建壳 + 绑定事件，**一个 /api 请求都不发**。
   浮窗挂在任何 /plugins/** 页上（宿主用随机实例 id 渲染插件页时，不挂就没入口），
   但取数只属于本插件页：在别的插件页上首帧取数，401 就会把登录 / 初始化模态盖住宿主。
   数据面由 syncAuthGate 在「本页」变真时启动（startDataFlow），变假时停掉（stopDataFlow）。 */
function mount() {
  if (state.mounted) return;
  document.addEventListener('visibilitychange', resumeTraffic);
  ensureStyles();

  rootEl = buildShell();
  document.body.appendChild(rootEl);

  /* 鉴权门**不在这里**开：只有本插件页才弹（`checkRoute` 按路由判定），
     否则在别的插件页上首帧就会盖一块全屏遮罩。 */

  frameEl = rootEl.querySelector('.ptx-window');
  pillEl = rootEl.querySelector('.ptx-pill');
  viewportEl = rootEl.querySelector('#ptxViewport');
  tickerEl = rootEl.querySelector('#ptxTicker');
  phaseEl = rootEl.querySelector('.ptx-phase');
  toastEl = rootEl.querySelector('.ptx-toast');
  gearBtnEl = rootEl.querySelector('.ptx-gear');

  const home = defaultPosition();
  placeFrame(home.left, home.top);
  /* 档位类不在这里判定：mount 时宿主还挂着 ptx-hidden（display:none，宽度读到 0），
     等 checkRoute 摘掉隐藏态、窗口真正有了布局盒之后再同步（见 checkRoute）。 */

  /* 宿主暗色跟随：先按宿主当前底色定主题（此刻壳层已挂进 body，读得到宿主底色），
     再挂观察器；用户手动切换过（localStorage 有记录）时以记忆为准，宿主换肤不覆盖。 */
  syncHostTheme();
  watchHostTheme();

  bindDrag();
  bindResize();
  bindPill();
  bindActions();

  /* 档位唯一真源：窗口盒真的变了才回调（隐藏 → 可见、@media 改宽都会触发）；
     回调里读的是已经布局好的 offsetWidth，不强制回流，档位类不改宽度也不会自我触发。 */
  if (typeof ResizeObserver === 'function' && frameEl) {
    if (tierObserver) tierObserver.disconnect();
    tierObserver = new ResizeObserver(() => syncResponsiveTier());
    tierObserver.observe(frameEl);
  }
  startTicker();

  state.mounted = true;
  state.stage = 'entries';

  /* 首帧只画本地记忆与空态：数据回来后由 startDataFlow 重绘 */
  renderChannelMenu();
  renderStage();
  resetIdleTimer();
  refreshPhase();
}

/* 数据面启动：只有本插件页（state.own）才有资格拉 /api。
 * 首次取数与两条轮询链（状态 / 最新）都在这里落地，mount() 里一个都不留。 */
function startDataFlow() {
  if (!state.mounted || !state.own || state.dataFlow) return;
  state.dataFlow = true;
  /* 选项先于数据落地：面板此刻已经可见，下拉 / 轮播条数不该等一次往返。 */
  syncSettingsUI();
  scheduleStatusPoll();
  clearInterval(latestTimer);
  latestTimer = setInterval(() => {
    if (!state.visible) return;
    loadLatest().then(refreshTicker);
  }, LATEST_POLL_MS);
  Promise.all([loadChannels(), loadEntries(), loadStatus(), loadLatest()]).then(() => {
    refreshTicker();
    refreshPhase();
    renderStage();
    ensureDetail().then(() => {
      if (state.stage !== 'entries') renderStage();
    });
  });
}

/* 数据面停止：清掉两条自调度链，断掉后不再为**看不见的页**取数。
 * 已拿到的数据留在 state 里：回到本插件页立刻可读，不必重拉一遍（首屏不闪空态）。 */
function stopDataFlow() {
  if (!state.dataFlow) return;
  state.dataFlow = false;
  clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  clearInterval(latestTimer);
  latestTimer = null;
}

function unmount() {
  if (!state.mounted || !rootEl) return;
  ++statusRequest;
  cancelAnimationFrame(trafficFrame);
  trafficFrame = 0;
  /* 观察器必须摘掉：它持有即将被丢弃的窗口节点 */
  if (tierObserver) { tierObserver.disconnect(); tierObserver = null; }
  document.removeEventListener('visibilitychange', resumeTraffic);
  clearIdleTimer();
  clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  clearInterval(state.tickerTimer);
  state.tickerTimer = null;
  clearTimeout(state.tickerSwap);
  state.tickerSwap = null;
  clearInterval(latestTimer);
  latestTimer = null;
  clearInterval(state.routeTimer);
  state.routeTimer = null;
  /* 胶囊手势随壳层一起作废：取消未落地的帧，清掉抑制标记与自定义位置 */
  pillDrag.active = false;
  pillDrag.pointerId = null;
  pillDrag.moved = false;
  pillDrag.pending = null;
  pillDrag.suppressClick = false;
  pillDrag.custom = false;
  if (pillDrag.rafId) {
    cancelAnimationFrame(pillDrag.rafId);
    pillDrag.rafId = 0;
  }
  rootEl.remove();
  rootEl = null;
  frameEl = null;
  pillEl = null;
  viewportEl = null;
  tickerEl = null;
  phaseEl = null;
  toastEl = null;
  gearBtnEl = null;
  channelChip = null;
  channelToggle = null;
  channelMenu = null;
  searchInput = null;
  state.mounted = false;
  state.visible = false;
  state.collapsed = false;
  state.own = false;
  state.dataFlow = false;
  /* 壳层销毁即本次认领作废：重新挂载要重新取样 / 重新走一次用户意图兜底。 */
  resetRouteProbe('');
  /* 壳层都没了就不再是「本插件页」：生成块的 401 兜底不能还给幽灵面板弹门禁。 */
  syncGateOwnPage(false);
  state.maximized = false;
  state.sized = false;
  state.restoreStyle = '';
}

/* 插件页路由的后半段（`/plugins/<key>` 的 key）；不在插件页返回空串。 */
function pluginRouteKey() {
  const routes = [window.location.pathname || '', window.location.hash || ''];
  for (const route of routes) {
    const at = route.toLowerCase().indexOf(ROUTE_SEGMENT);
    if (at < 0) continue;
    const key = route.slice(at + ROUTE_SEGMENT.length).split(/[/?#]/)[0].toLowerCase();
    if (key !== '') return key;
  }
  return '';
}

/* key 直接就是本插件（插件名或 `插件名:实例 id`）。 */
function routeKeyOwned(key) {
  if (!key) return false;
  return PLUGIN_ROUTE_NAMES.some((name) => key === name || key.startsWith(`${name}:`));
}

/* 宽判定：当前是不是「某个插件的插件页」——**只决定挂载**。
   宿主用随机实例 id 渲染插件页（`/plugins/<随机id>`），名字可能永远对不上本插件，首帧也读不到
   标题 / 面包屑；把它和身份判定耦在一起会让浮窗整块消失（用户根本看不到入口）。 */
function isPluginPage() {
  return [window.location.pathname || '', window.location.hash || '']
    .some((route) => route.toLowerCase().includes(ROUTE_SEGMENT));
}

/* 窄判定：是不是**本插件**的插件页。
   三条凭据任一成立即认领：路由 key 就是本插件名（`/plugins/patchouli-knowledge[:id]`）、
   页面身份元数据命中（标题 / 面包屑 / data-* / h1）、用户在胶囊上点开过（`userClaimed`，
   随机实例 id 的页面唯一可用的凭据）。它只影响展开与鉴权门，不影响挂载。 */
function routeMatches() {
  const key = pluginRouteKey();
  if (key === '') return false;
  if (routeKeyOwned(key)) return true;
  if (pageIdentityMatches()) return true;
  return routeProbe.userClaimed;
}

/* 当前路由键：路径 + hash 变了才重新做软校验（宿主是 SPA，pushState 不会重载脚本）。 */
function currentRouteKey() {
  const path = window.location.pathname || '';
  const hash = window.location.hash || '';
  return `${path}${hash}`;
}

/* 页面身份取样：只读**元数据** —— `document.title` 与宿主专为页面身份画的取样点
   （data-* / 面包屑 / h1）。正文与宽容器一概不读：归属是开集问题，容器越宽越可能装着与本插件
   无关的普通设置文案（别的插件页写着「知识库范围」就被认领走），全屏门与 /api 请求就落到别人的
   配置页上。读不到元数据就当作「认不出」而不是「不是本插件」—— 随机实例 id 的页面由用户点开
   胶囊认领（见 expandPanel），这条路不需要任何文本推断。 */
const IDENTITY_SELECTORS = ['[data-plugin-name]', '[data-plugin]', '.el-breadcrumb', 'h1'];

/* 取样落在浮窗自己的 DOM 里就丢弃：壳层的文案本身带「LLMWiki 知识阅读器」，
   拿它当页面身份会自我认领 —— 别的插件页一挂载就被判成本插件页。 */
function insideOwnPanel(node) {
  let cur = node || null;
  while (cur) {
    if (cur.id === ROOT_ID) return true;
    cur = cur.parentNode || null;
  }
  return false;
}

/* 命中判定：文本小写后与 `IDENTITY_HINTS` 比对（不区分大小写，包含即算）。 */
function identityHits(text) {
  if (typeof text !== 'string' || !text) return false;
  const lower = text.toLowerCase();
  return IDENTITY_HINTS.some((hint) => lower.includes(hint));
}

/* 软校验：元数据命中任一标识即认为当前页是本插件的配置页。命中失败只影响自动展开，不影响挂载。
   取样量恒有界（一个标题 + 四个节点的 textContent），不遍历页面、不读正文。 */
function pageIdentityMatches() {
  const parts = [];
  try {
    if (typeof document.title === 'string') parts.push(document.title);
  } catch (err) { /* 宿主没暴露 title 时按「认不出」处理 */ }
  for (const selector of IDENTITY_SELECTORS) {
    let node = null;
    try { node = document.querySelector(selector); } catch (err) { node = null; }
    if (!node || insideOwnPanel(node)) continue;
    const text = typeof node.textContent === 'string' ? node.textContent : '';
    if (text) parts.push(text);
  }
  return identityHits(parts.join(' '));
}

/* 软校验状态机：key 变了重开窗口；窗口过后不再重探，避免一会儿展开一会儿收回地跟用户抢状态。
   `userClaimed` 是「用户点开胶囊」的凭据：认领跟着本页走 —— 同一页内的 700ms 轮询不清，
   路由 key 一变（切到别的页）立刻作废。 */
let routeProbe = { key: '', identified: false, ticks: 0, promoted: false, userClaimed: false };

function resetRouteProbe(key) {
  routeProbe = { key: key || '', identified: false, ticks: 0, promoted: false, userClaimed: false };
  /* 认领作废，接口可用性账一起清：新页面的失败要重新累计，不能带着上一页的「接口不可用」。 */
  state.apiStreak = 0;
  state.apiUnavailable = false;
}

/* 挂载即收回：软校验没认出本插件页时只留悬浮胶囊，不遮住别的插件页。
   与 collapsePanel 同一终态（is-collapsed + 胶囊可见），但不起过渡 —— 首帧发生在 ptx-hidden
   里，不会先闪一帧整窗再收回去。 */
function collapseQuietly() {
  if (!frameEl) return;
  clearIdleTimer();
  state.collapsed = true;
  frameEl.classList.remove('is-docked');
  frameEl.classList.add('is-collapsed');
  if (pillEl) pillEl.classList.add('is-visible');
}

/* 把「本插件页」标记写给生成块（幂等）：生成块里的 401 兜底与 gate() 都只看它。
   每轮路由判定都写一次 —— 首帧 own 本来就是 false，没有「翻转」事件，
   跳过就等于让生成块停在它自己的默认值上。 */
function syncGateOwnPage(own) {
  try {
    if (window.__ptxAuth && typeof window.__ptxAuth.setOwnPage === 'function') {
      window.__ptxAuth.setOwnPage(own);
    }
  } catch (err) {
    /* 宿主没暴露门禁接口时无事可做 */
  }
}

/* 本插件页判定只有一个真源（`state.own`）：它同时决定鉴权门与数据面。
   本页变真 → 先把标记同步给生成块，再启动取数并开门禁；
   本页变假 → 立刻停掉取数（别的插件页一个 /api 都不发），再收起门禁。
   浮窗壳层留在页面上（悬浮胶囊是入口），但绝不盖全屏遮罩、绝不为不可见页拉数据。 */
function syncAuthGate(own) {
  /* 先同步标记再判翻转：快路径也要保证生成块知道当前页不是本插件页。 */
  syncGateOwnPage(own);
  if (own === state.own) return;
  state.own = own;
  /* 归属一变，状态位与监控条的语义就变了（本页 / 非本页 / 断线三态）：
     立刻按新归属重画，别让上一页的「连接中断」留在胶囊上误导用户。 */
  refreshPhase();
  if (own) {
    startDataFlow();
    /* 缓存（state.status）没被动过：立刻按它重画一次，等新数据回来自然覆盖。
       不重画就得等一次往返，监控页会先闪一帧空态。 */
    if (state.stage === 'metrics') updateMetrics();
    try {
      if (window.__ptxAuth && typeof window.__ptxAuth.gate === 'function') window.__ptxAuth.gate();
    } catch (err) {
      /* 宿主没暴露门禁接口时无事可做 */
    }
    return;
  }
  stopDataFlow();
  if (state.stage === 'metrics') updateMetrics();
  try {
    if (window.__ptxAuth && typeof window.__ptxAuth.dismiss === 'function') window.__ptxAuth.dismiss();
  } catch (err) {
    /* 宿主没暴露门禁接口时无事可做 */
  }
}

function checkRoute() {
  if (!isPluginPage()) {
    /* 离开插件页：探针清零，回到插件页时重新做一次软校验。
       鉴权模态是挂在 body 上的独立节点，路由离开时必须一并收起，
       否则切到别处后仍被这块全屏遮罩盖住；取数也同步停掉（「不遮住宿主」与
       「不为看不见的页拉数据」是同一条契约，都归 syncAuthGate(false) 管）。 */
    resetRouteProbe('');
    syncAuthGate(false);
    if (tagPolicyMenu) tagPolicyMenu.syncOwn(false);
    if (state.visible) {
      if (rootEl) rootEl.classList.add('ptx-hidden');
      state.visible = false;
      clearIdleTimer();
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    return;
  }

  const key = currentRouteKey();
  const newRoute = routeProbe.key !== key;
  if (newRoute) resetRouteProbe(key);
  if (!routeProbe.identified && routeProbe.ticks < IDENTITY_PROBE_TICKS) {
    routeProbe.ticks += 1;
    // 名字直接就是本插件：无需等宿主画标题，首帧即展开。
    routeProbe.identified = routeKeyOwned(pluginRouteKey()) || pageIdentityMatches();
  }

  /* 任何插件页都挂载：随机实例 id + 首帧读不到标题时，浮窗仍然要出现在用户眼前。 */
  const fresh = !state.mounted;
  if (fresh) mount();

  /* 本插件页判定每轮现算（宿主是 SPA，标题 / 面包屑会迟到）：它决定展开与鉴权门。
     用户点开胶囊的认领也算数（`routeProbe.userClaimed`）：下一轮判定不能把用户刚要到手的页
     收回去，只有路由 key 变了（resetRouteProbe）才作废。 */
  syncAuthGate(routeMatches());
  /* 订阅表标签的右键菜单只在本插件页接管；进入本页时读一次策略（一页一次，失败不轮询）。 */
  if (tagPolicyMenu) tagPolicyMenu.syncOwn(state.own);

  if (rootEl) {
    /* 刚进入的页面还没被认领（别人的插件页 / 元数据未画出来）时只留胶囊：
       整窗不盖住宿主表单；用户自己点开的胶囊不再被下一次判定收回。 */
    if ((fresh || newRoute) && !routeProbe.identified) collapseQuietly();
    rootEl.classList.remove('ptx-hidden');
  }

  if (!state.visible) {
    state.visible = true;
    const home = defaultPosition();
    const at = frameEl ? layoutOffset(frameEl) : home;
    placeFrame(at.left, at.top);
    /* 此刻宿主刚摘掉 ptx-hidden，窗口才真正有了布局盒：首帧就把档位定下来，
       不必等第一次拖拽 / 缩放才换挡（收回态 visibility:hidden 时读不到宽度）。 */
    if (frameEl) syncResponsiveTier();
    /* 收回态不随路由自动展开：悬浮球是收回态下的唯一入口，
       否则 × 收回的面板会在切走再回来时被弹开。 */
    resetIdleTimer();
    /* 本插件页才排状态轮询（syncAuthGate 在 visible 置真之前就已启动数据面，
       那里的首次排链会因「不可见」跳过，这里补上；别的插件页 dataFlow 为假，连计时器都不建）。 */
    if (state.dataFlow) scheduleStatusPoll();
  }

  /* 软校验迟到命中（宿主先挂壳后画标题）：挂载时只留了胶囊，认出本插件页后自动展开一次。
     每页只展开一次，用户随后手动收回不会被它掀开。
     这条不是用户点的胶囊，不能记成用户认领（见 expandPanel 的 `claim`）。 */
  if (routeProbe.identified && !routeProbe.promoted) {
    routeProbe.promoted = true;
    if (!fresh && state.collapsed) expandPanel({ claim: false });
  }
}

/* ------------------------------------------------------------------ *
 * 14. Console 插件入口
 * ------------------------------------------------------------------ */

export default function applyPatchouliWikiReader(ctx) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__patchouliWikiReader) return;
  window.__patchouliWikiReader = true;

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      if (tagPolicyMenu) {
        tagPolicyMenu.destroy();
        tagPolicyMenu = null;
      }
      unmount();
      window.__patchouliWikiReader = false;
    });
  }

  /* 订阅表投递群标签的右键菜单：策略真源在 settings.json，读写都走 /api/policies。
     读挂在 requestJson 上（接口不可用记账），写挂在 writeJson 上（400 的 body.error 直接
     进菜单；非本插件页连 fetch 都不会发）。 */
  tagPolicyMenu = createTagPolicyMenu({
    document,
    window,
    MutationObserver: typeof MutationObserver === 'function' ? MutationObserver : null,
    isOwnPage: () => state.own === true,
    /* 必须走完整的认领：只 `syncAuthGate(true)` 不写 `routeProbe.userClaimed`，
       下一轮 checkRoute 的 routeMatches() 仍为 false → syncOwn(false) → 菜单被关，
       表现就是「闪一下就没」。 */
    claim: () => claimOwnPage(),
    read: () => requestJson(`${API_BASE}/api/policies`),
    write: (payload) => writeJson(`${API_BASE}/api/policies`, 'POST', payload),
    /* `collapse-tags` 把多余目标折叠成 `+ N`：这些目标不在 DOM 里，只能回订阅表取。 */
    readTargets: () => requestJson(`${API_BASE}/api/subscriptions`),
  });

  const boot = () => {
    /* 配置卡的标签主题与浮窗无关：脚本一启动就铺好，不依赖用户是否打开面板。 */
    ensureSchemaTagTheme();
    if (tagPolicyMenu) tagPolicyMenu.attach();
    checkRoute();
    state.routeTimer = setInterval(checkRoute, 700);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
