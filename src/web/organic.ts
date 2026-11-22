/**
 * Patchouli Knowledge - 有机未来主义 (Organic Futurism) 视觉内核
 *
 * 造型语言：非对称囊泡曲率、820px 单版心、ECG 脉冲、8 参数休眠细胞核。
 * 图标：Lucide 图标集（ISC License，24px 网格 / 2px 圆头描边），全部内联注入，不加载外部字体或脚本。
 * 质感方向（用户拍板）：瓷白 / 肤白基底 + 葱绿 #0ea44f / 深海青 #0e8f86 / 琥珀孢子 #b8791e 生物荧光点缀。
 * 样式表见 `organic-style.ts`；本模块只负责图标、几何与结构化 ID。
 *
 * 红线：零 Emoji，100% 内联 SVG 图标，不注入外部脚本、样式或字体；富消息媒体由安全媒体渲染层单独校验。
 */

/* ------------------------------------------------------------------ *
 * 1. 矢量图标库（stroke/fill 全部 currentColor，随语义色继承）
 * ------------------------------------------------------------------ */

const LUCIDE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"';

export const ORGANIC_ICONS: Record<string, string> = {
  nucleus: `<g ${LUCIDE}><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></g>`,
  entries: `<g ${LUCIDE}><path d="M2 6h4m-4 4h4m-4 4h4m-4 4h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9.5 8h5m-5 4H16m-6.5 4H14"/></g>`,
  /* 视图模式切换：Lucide layout-grid / list，只表达布局，不承载状态色 */
  grid: `<g ${LUCIDE}><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></g>`,
  list: `<g ${LUCIDE}><path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/></g>`,
};

export function organicIcon(name: string, size = 16): string {
  const body = ORGANIC_ICONS[name] ?? ORGANIC_ICONS.nucleus;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/* ------------------------------------------------------------------ *
 * 2. 真实时间轴流量曲线构建器
 * ------------------------------------------------------------------ */

/**
 * 真实时间轴流量曲线：把 `/api/status` 的 `traffic` 采样映射成 SVG path
 *
 * 数据契约（与后端 `TrafficPoint` 一致）：每个采样点是服务器墙钟对齐的 5 秒
 * 桶起点（ms）与该桶内真实收到的消息条数（整数）。X 轴按**真实时间戳**定位
 * （`startTime`..`endTime` 线性映射到 0..width），Y 轴为条数（0..maxCount 映射
 * 到基线..顶部），因此时间轴上的疏密、断裂都来自真实采样，而非等宽槽位。
 *
 * 诚实呈现：未监测的周期**没有采样点**，曲线在该处断开（相邻采样相隔不止一个
 * 5 秒桶，或 `count` 非有限，即断段）；已监测但无消息的周期是真实 0，落在基线上。
 * 窗口外的采样点直接丢弃——滚动出窗的旧点不会压在左边界上堆积。空采样返回空
 * 字符串（不画线，也不伪造平直基线）；只有一个采样点时画一段短横线。
 *
 * 函数体保持无外部依赖（可被 `fn.toString()` 原样注入页面运行时 / 客户端产物），
 * 因此不得引用任何模块级符号；由 tests/webui.test.mjs 守护。
 * ------------------------------------------------------------------ */

/**
 * 采样点 → SVG path。
 *
 * @param points    采样点（按 `timestamp` 升序；窗口 `startTime`..`endTime` 之外的采样点不绘制）
 * @param width     绘图区宽度（用户单位）
 * @param height    绘图区高度（用户单位）
 * @param startTime X 轴左端时间戳（ms）
 * @param endTime   X 轴右端时间戳（ms）
 * @param maxCount  Y 轴满刻度条数（≤ 0 或非有限值时按 1 处理）
 */
export function buildTrafficPath(
  points: readonly { readonly timestamp: number; readonly count: number }[],
  width: number,
  height: number,
  startTime: number,
  endTime: number,
  maxCount: number,
): string {
  const pad = 4; // 绘图区上下留白，与图内网格线 4 / height - 4 对齐
  const sampleMs = 5000; // 采样桶固定 5 秒（后端 TRAFFIC_SAMPLE_MS）；函数体自包含故写字面量
  const span = endTime - startTime;
  const scale = Number.isFinite(maxCount) && maxCount > 0 ? maxCount : 1;
  const baseY = height - pad;
  const usable = Math.max(1, height - pad * 2);

  // 投影成若干段连续折线（扁平存储 [x0, y0, x1, y1, ...]）。
  const runs: number[][] = [];
  let run: number[] = [];
  let previous = Number.NaN;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const at = point.timestamp;
    const count = point.count;
    // 窗口外的采样（滚动出窗的过期点、超前于窗口的点）与时间戳 / 条数非有限的
    // 采样一律视为未监测：直接跳过，既不绘制也不压到边界上堆积。
    if (!Number.isFinite(at) || !Number.isFinite(count) || at < startTime || at > endTime) continue;
    // 相邻采样必须正好相隔一个采样周期，否则中间存在未监测的桶 → 断开子路径。
    if (Number.isFinite(previous) && (at - previous <= 0 || at - previous > sampleMs)) {
      if (run.length > 0) runs.push(run);
      run = [];
    }
    const ratio = span > 0 ? (at - startTime) / span : 0;
    const value = Math.min(1, Math.max(0, count / scale));
    const x = Math.round(ratio * width * 100) / 100;
    const y = Math.round((baseY - value * usable) * 100) / 100;
    run.push(x, y);
    previous = at;
  }
  if (run.length > 0) runs.push(run);

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
    for (let k = 2; k < segment.length; k += 2) d += ' L' + segment[k] + ' ' + segment[k + 1];
  }
  return d;
}

/* ------------------------------------------------------------------ *
 * 3. 休眠胚胎细胞核：8 参数（角度 / 半径 / X 缩放 / Y 缩放 / 不透明度 /
 *    周期 / 相位延迟 / 色调），全部由 CSS 变量驱动，静止时零 JS 开销。
 * ------------------------------------------------------------------ */

interface OrbitSeed {
  angle: number;
  radius: number;
  sx: number;
  sy: number;
  opacity: number;
  duration: number;
  delay: number;
  tone: string;
}

const ORBIT_SEEDS: readonly OrbitSeed[] = [
  { angle: 0, radius: 52, sx: 1.16, sy: 0.68, opacity: 0.62, duration: 9.4, delay: 0, tone: '#0ea44f' },
  { angle: 45, radius: 44, sx: 0.86, sy: 1.2, opacity: 0.52, duration: 11.6, delay: -1.6, tone: '#0e8f86' },
  { angle: 90, radius: 56, sx: 1.24, sy: 0.62, opacity: 0.44, duration: 13.2, delay: -3.1, tone: '#0ea44f' },
  { angle: 135, radius: 39, sx: 0.94, sy: 1.08, opacity: 0.56, duration: 10.4, delay: -4.7, tone: '#b8791e' },
  { angle: 180, radius: 49, sx: 1.1, sy: 0.78, opacity: 0.4, duration: 12.8, delay: -2.3, tone: '#0e8f86' },
  { angle: 225, radius: 58, sx: 0.8, sy: 1.14, opacity: 0.34, duration: 14.6, delay: -5.9, tone: '#0ea44f' },
  { angle: 270, radius: 42, sx: 1.02, sy: 0.9, opacity: 0.5, duration: 9.9, delay: -0.8, tone: '#b8791e' },
  { angle: 315, radius: 61, sx: 1.18, sy: 0.7, opacity: 0.3, duration: 15.4, delay: -6.8, tone: '#0e8f86' },
];

export function organicNucleus(prefix: string): string {
  const orbs = ORBIT_SEEDS.map((seed) => {
    const style =
      `--n-angle:${seed.angle}deg;--n-radius:${seed.radius}px;` +
      `--n-sx:${seed.sx};--n-sy:${seed.sy};--n-opacity:${seed.opacity};` +
      `--n-dur:${seed.duration}s;--n-delay:${seed.delay}s;--n-tone:${seed.tone}`;
    return `<g class="ptx-orb" style="${style}"><ellipse cx="80" cy="80" rx="7.4" ry="5.2"/></g>`;
  }).join('');

  return (
    `<svg class="ptx-nucleus" viewBox="0 0 160 160" aria-hidden="true" focusable="false">` +
    `<defs><radialGradient id="${prefix}NucleusGlow" cx="50%" cy="50%" r="50%">` +
    `<stop offset="0%" stop-color="#0ea44f" stop-opacity="0.22"/>` +
    `<stop offset="58%" stop-color="#0e8f86" stop-opacity="0.08"/>` +
    `<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>` +
    `</radialGradient></defs>` +
    `<circle cx="80" cy="80" r="64" fill="url(#${prefix}NucleusGlow)"/>` +
    `<circle class="ptx-nucleus-membrane" cx="80" cy="80" r="54"/>` +
    `<circle class="ptx-nucleus-wall" cx="80" cy="80" r="41"/>` +
    orbs +
    `<circle class="ptx-nucleus-core" cx="80" cy="80" r="12"/>` +
    `<circle class="ptx-nucleus-seed" cx="80" cy="80" r="4.4"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ *
 * 4. 结构化 ID / 频道常量
 * ------------------------------------------------------------------ */

export interface OrganicIds {
  window: string;
  pill: string;
  viewport: string;
  ticker: string;
  phase: string;
  toast: string;
  autoDock: string;
  search: string;
  dragHandle: string;
}

export function organicIds(prefix: string): OrganicIds {
  return {
    window: `${prefix}Window`,
    pill: `${prefix}Pill`,
    viewport: `${prefix}Viewport`,
    ticker: `${prefix}Ticker`,
    phase: `${prefix}Phase`,
    toast: `${prefix}Toast`,
    autoDock: `${prefix}AutoDock`,
    search: `${prefix}Search`,
    dragHandle: `${prefix}DragHandle`,
  };
}

/**
 * 频道作用域的兜底值。
 *
 * 刻意留空：订阅哪些群由宿主配置（`channels`）决定，界面在拿到频道列表前不该假设任何
 * 真实群号——公开版本里硬编码群号既泄露部署信息，也会让新宿主把请求打到别人的群上。
 */
export const PATCHOULI_CHANNEL = '';
export const PATCHOULI_CHANNELS: readonly string[] = [];
