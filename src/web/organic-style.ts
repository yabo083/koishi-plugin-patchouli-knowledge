/**
 * Patchouli Knowledge - 界面样式内核（瓷白 / 葱绿 · 工具级精密质感）
 *
 * 材质方向：瓷白 #f7f5f0 基底 + 100% 不透明实体生物膜 #fffdf9，葱绿 #0ea44f 作语义点缀，
 * 深海青 / 琥珀孢子作辅色。以发丝线、单层柔和投影与严格单版心的排版
 * 营造质感，摒弃异形倒角与荧光泛光。
 *
 * 材质契约（硬性）：
 * - 几何固定：控件使用 --r-ctl（7px）、卡片 --r-card（10px）、容器 --r-window（14px），
 *   任何 hover / active 均不改变 border-radius、不位移、不缩放。
 * - 控件尺寸统一：小控件 28px、标准控件 32px、导航页签 40px。
 * - 阴影单层：卡片仅 1px 级环境阴影，禁止叠加多重投影与彩色外发光。
 * - 承载面全不透明：--bg-membrane / --win-grad / --rail-grad / --topbar-grad / --foot-grad /
 *   --surface-float 一律实体色，任何一处带 alpha 都会让宿主表单文字透上来（穿模）；
 *   .ptx-window 另在 background 简写之后叠 background-color: var(--surface) 作遮光板。
 * - 正文对比：--bio-ink-2 #36443c 于 #ffffff 上约 10:1；正文 14px / 1.78，摘要 12.5px。
 * - 承载体无附加图层：窗口内只有实体底色 + 发丝线边框，不再有任何全窗 SVG 图层
 *   （噪点薄膜 / 场等势线）。任何超出 viewBox 的描边动画都会在 GPU 合成层里溢出到
 *   窗口外侧的大底上、在边框处被切断成错位发丝线——这正是“窗口边缘撕裂”的根因。
 * - 排版版心：窗内所有阶段容器共用 820px 单版心（max-width + margin: 0 auto，内部
 *   100% 宽），整块居中、内部左缘严格齐平；不使用 960 / 720 / 82ch 多档宽度各自居中。
 * - 夜间主题：根容器挂 `.is-dark` 即整套切换到中性冷炭灰（页面 #222327 / 窗口面 #28292e、
 *   提升面 #32333b、悬浮面 #393b44），主波长为清爽薄荷翠绿 #10b981，
 *   发丝线 rgba(255,255,255,0.08 / 0.14)，文字柔白 #f3f4f6 → 中灰 #6b7280 四级；
 *   明暗只覆盖同一声明令牌组，布局与几何零差异。
 * - 动效仅使用 transform / opacity；窗口收回展开保留，按钮本体永不形变。
 * - 缩放热区：8 向手柄完全内嵌（向内厚度 8px、四角 16×16），唯一反馈是系统缩放光标；
 *   指针在 pointerdown 时被 setPointerCapture 锁定，热区因此永远不需要外溢。
 *   尺寸钳制在 [min(480/360, 视口-28), 视口-28]，到下限只停止更新，绝不抖动。
 * - 单一硬裁剪：.ptx-shell 用 overflow: hidden + 自身圆角形成唯一裁剪矩形，
 *   子层（左栏 / 主体 / 底栏）绝不脱离父级裁剪边界，也绝不各自自持内层圆角——
 *   子元素再补一枚 calc(--r-window - 1px) 会和父级圆角各算一次抗锯齿，在分数 DPI 下
 *   描出双重轮廓（下沿“撕裂”的来源之一）。四个底角统一由实体底色 + 该矩形闭合。
 *   裁剪刻意不放在 .ptx-window（拖拽时被 translate3d 搬运的合成层）上：位移层同时是
 *   圆角裁剪容器时，合成器要为每帧重新求解那圈遮罩，运动中的边缘就是断续的。
 * - 框线一体：.ptx-shell 四边共用 --hairline-frame 一条中性发丝线，底边不做任何
 *   单独覆盖——旧版底边换成实色亮灰，使 14px 圆角处深线突变亮线，看起来像拐角撕裂。
 * - 窗口排版：换挡由运行时类名 .is-narrow（<780）/ .is-compact（<560）驱动，量的是窗口
 *   自身宽度，因此手动缩小窗口与缩小浏览器得到同一套排版，最大化还原后自动重排。
 *
 * 性能陷阱防范：
 * - 窗口本体不采样背板模糊：背景色与页面底色接近，blur 视觉收益极低，却会让每次
 *   尺寸变化重新采样整块背板（缩放时“边缘断裂后重绘”的来源）。backdrop-filter
 *   只保留在右下角悬浮胶囊（尺寸恒定、不参与缩放）。
 * - 手势（is-dragging / is-resizing）状态类上只允许 transition / cursor 与拖拽期的
 *   will-change: transform：绝不允许 background / backdrop-filter / box-shadow / display
 *   重写——切换表面本身就会被看成断裂，拖动时还会出现底色跳变。
 * - 拖拽走合成层平移（translate3d），不写 left / top：每帧写 left / top 会让整窗重排重光栅，
 *   分数 DPI 下边框与字形逐帧重算抗锯齿，横向拖动时竖边像未开垂直同步一样抖裂。
 *   缩放仍走 left / top / width / height（尺寸变化本来就要重光栅，提升合成层只会多付一次）。
 * - 正文小字禁用 text-shadow / drop-shadow，保证笔画锐利并避免高分屏光栅化抖动。
 * - 拖拽使用 requestAnimationFrame 合并写入；尊重 prefers-reduced-motion。
 */

const TOKENS = `
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

  /* 承载面令牌：明暗两套主题只覆盖这一组，控件 / 卡片 / 输入框不各自持有色值。
     --surface 系列是"纸面"，--*ink 系列是纸面上的文字，两者必须成对切换。 */
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
  /* 承载面渐变一律 100% 不透明实体色：窗口是全屏浮层 / Console 内嵌组件，背后就是宿主
     表单与正文。任何带 alpha 的渐变都会让宿主文字透上来（穿模），因此这四条令牌里
     NEVER 出现 rgba。 */
  --win-grad: linear-gradient(168deg, #ffffff 0%, #fffdf9 52%, #fafbf6 100%);
  --rail-grad: linear-gradient(180deg, #ffffff 0%, #f4f7f2 100%);
  --topbar-grad: linear-gradient(180deg, #ffffff 0%, #f7f9f5 100%);
  --foot-grad: linear-gradient(180deg, #fbfcf9 0%, #f4f6f1 100%);
`.trim();

/** 承载面：独立页面 / Console 内嵌组件 / 全屏浮层客户端（client/dist 单文件产物）。 */
export type OrganicSurface = 'page' | 'dock' | 'overlay';

export function organicStyles(scope: string, surface: OrganicSurface, prefix: string): string {
  const S = scope ? `${scope} ` : '';
  const standalone = surface === 'page';
  const overlay = surface === 'overlay';
  /* 夜间主题挂在最外层宿主上：独立页是 <html>，内嵌组件是隔离根节点。
     变量只在选中宿主上覆盖，窗口内所有控件都靠 var() 自动跟随。 */
  const DK = scope ? `${scope}.is-dark` : 'html.is-dark';

  const hostBlock = overlay
    ? `${scope} {
${TOKENS}
  position: fixed;
  inset: 0;
  z-index: 9990;
  pointer-events: none;
  color: var(--bio-ink);
  font-family: var(--bio-ui);
  -webkit-font-smoothing: antialiased;
  user-select: none;
}`
    : standalone
    ? `:root {
${TOKENS}
}

  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background:
      radial-gradient(1180px 700px at 76% -12%, rgba(14, 143, 134, 0.05), transparent 62%),
      radial-gradient(960px 560px at 2% 112%, rgba(14, 164, 79, 0.06), transparent 62%),
      linear-gradient(180deg, #fbfaf6 0%, var(--bg-porcelain) 58%, #eef0e8 100%);
    color: var(--bio-ink);
    font-family: var(--bio-ui);
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }`
    : `${scope} {
${TOKENS}
  position: relative;
  width: 100%;
  margin: 16px 0 24px;
  color: var(--bio-ink);
  font-family: var(--bio-ui);
  -webkit-font-smoothing: antialiased;
  user-select: none;
}`;

  const windowLayout = overlay
    ? `position: fixed;
    width: min(820px, calc(100vw - 48px));
    height: min(560px, calc(100vh - 120px));`
    : standalone
    ? `position: absolute;
    width: min(1040px, calc(100vw - 64px));
    height: min(660px, calc(100vh - 96px));`
    : `position: relative;
    width: 100%;
    max-width: 1060px;
    height: 620px;
    margin: 0 auto;`;

  return `
  /* ================= 宿主 ================= */
${hostBlock}

  ${S}* { box-sizing: border-box; }
  ${S}button { font-family: inherit; }
  ${S}svg { display: block; }

  /* ================= 外骨骼容器（几何 / 位移层） =================
     这一层只负责几何与排版，绝不承担圆角裁剪。原因：拖拽时它是被 translate3d 搬运的合成层，
     而「被位移的层」同时又是「带圆角的裁剪容器」时，那圈圆角裁剪必须由合成器遮罩在每一帧按
     新位置重新求解，边缘在帧与帧之间就是断续的——截图（强制重新光栅）拍不到，肉眼在横向拖动
     时最明显。裁剪下沉到 .ptx-shell 后，圆角边界成为图层自身栅格的一部分，随层整体搬运，
     任何速度下都只有一种像素形态。 */
  ${S}.ptx-window {
    display: flex;
    ${windowLayout}
    z-index: 10040;
    transform-origin: 100% 100%;
    transition: transform 0.56s var(--ease-spring), opacity 0.34s var(--ease-organic);
  }

  /* ================= 窗面（唯一硬裁剪矩形 + 全部材质） ================= */
  ${S}.ptx-shell {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    border-radius: var(--r-window);
    background:
      radial-gradient(120% 85% at 8% -12%, rgba(14, 143, 134, 0.04), transparent 56%),
      var(--win-grad);
    /* 遮光板底色：浮动窗口压在宿主表单之上，必须是一块 100% 不透明的实体纸面。
       background 简写会把背景色重置为 transparent，故实体底色必须在简写之后声明；
       渐变本身也已改为全实体色，两层叠加后宿主文字再也透不上来（穿模根因）。 */
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
    /* 唯一裁剪矩形：自身圆角 + overflow: hidden。左栏 / 主体 / 窗内版心全部被这一个硬
       边界裁掉，子层不再各自外溢，拖动时不会出现裁剪边界错位或发丝线断裂。
       实体底色（--surface）+ 这唯一的硬裁剪已经能把下沿两角闭合，子元素不再各自补内层
       圆角——那些补丁在分数 DPI 下与父级圆角各算一次抗锯齿，反而描出双重轮廓。
       8 向缩放手柄因此必须完全内嵌（见下方手柄段），绝不依赖 overflow: visible。 */
    overflow: hidden;
  }

  ${overlay ? '' : `${S}.ptx-window.is-floating { position: fixed; z-index: 9998; margin: 0; }`}

  /* ================= 手势态（拖拽 / 缩放） =================
     材质（background / backdrop-filter / box-shadow）与布局（display / visibility /
     opacity）在手势期间必须与静止态完全一致——只要有一条重写，进入手势的那一帧就会换一次
     表面，观感就是"拖动时背景层变色"。
     拖拽期额外把整窗提升为独立合成层（is-dragging 上的 will-change: transform）：
     拖拽是纯平移，整窗只在起手帧光栅化一次，之后每帧只由合成器搬运 translate3d，
     既不重排也不重绘。旧版每帧写 left / top，等于每帧对整窗（近白渐变底 + 1px 发丝线边框
     + 双层投影 + 全部卡片文本）重排重光栅；125% / 150% 缩放下每次 1 CSS px 的位移等于把
     整窗像素相位推 1.25 / 1.5 设备 px，竖边发丝线与全部字形每帧重算一次抗锯齿，边缘就在
     "1 行实线 / 两行各半"之间来回跳——观感等同未开垂直同步。横向拖动最明显：竖边是唯一
     被搬运且相位敏感的 1px 线；纵向拖动时上下边沿落在投影的柔和斜坡里，同样的抖动看不出来。
     缩放是尺寸变化，本来就必须逐帧重新光栅，提升合成层只会多付一次全幅重光栅，故不提升。 */
  ${S}.ptx-window.is-dragging,
  ${S}.ptx-window.is-resizing { transition: none; }
  ${S}.ptx-window.is-dragging { cursor: grabbing; will-change: transform; }

  /* 窗口收回 / 展开：整体缩放属于容器状态变化，不是按钮形变 */
  ${S}.ptx-window.is-collapsed {
    transform: scale(0.14) translate(38px, 42px);
    opacity: 0;
    pointer-events: none;
  }

  /* JS 在折叠过渡结束后挂载：整窗退出绘制（用 visibility 而不是 display，几何与换挡类名
     仍可读，展开时无需重新测量）。窗口本身从不使用 backdrop-filter，因此没有模糊层要摘。 */
  ${S}.ptx-window.is-docked {
    visibility: hidden;
  }

  /* 最大化：page / dock / overlay 三种承载面统一覆盖为视口内缩 12px。
     !important 用于压过拖拽写入的行内 left / top / width / height，几何仍然固定无过渡形变。 */
  ${S}.ptx-window.is-maximized {
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
     窗口是唯一硬裁剪矩形（overflow: hidden），因此手柄一律向内：边框热区 8px 厚、
     四角 16×16（对角拖拽不会滑落成单边拉伸），background: transparent 且无任何材质，
     唯一反馈是系统缩放光标。pointerdown 时 JS 对命中的手柄 setPointerCapture，
     指针被锁死在这块热区上——窗口几何即使暂时追不上指针也不会脱手，
     所以永远不需要父容器 overflow: visible。
     东西两侧同理：热区占据窗口左右边缘各 8px，滚动条槽位由 .ptx-viewport 让出。 */
  ${S}.ptx-resize-layer {
    position: absolute;
    inset: 0;
    z-index: 60;
    pointer-events: none;
  }
  ${S}.ptx-resize {
    position: absolute;
    background: transparent;
    touch-action: none;
    pointer-events: auto;
  }
  ${S}.ptx-resize.is-n { top: 0; left: 16px; right: 16px; height: 8px; cursor: ns-resize; }
  ${S}.ptx-resize.is-s { bottom: 0; left: 16px; right: 16px; height: 8px; cursor: ns-resize; }
  ${S}.ptx-resize.is-w { left: 0; top: 16px; bottom: 16px; width: 8px; cursor: ew-resize; }
  ${S}.ptx-resize.is-e { right: 0; top: 16px; bottom: 16px; width: 8px; cursor: ew-resize; }
  ${S}.ptx-resize.is-nw { top: 0; left: 0; width: 16px; height: 16px; cursor: nwse-resize; }
  ${S}.ptx-resize.is-ne { top: 0; right: 0; width: 16px; height: 16px; cursor: nesw-resize; }
  ${S}.ptx-resize.is-sw { bottom: 0; left: 0; width: 16px; height: 16px; cursor: nesw-resize; }
  ${S}.ptx-resize.is-se { bottom: 0; right: 0; width: 16px; height: 16px; cursor: nwse-resize; }

  /* 最大化由视口接管；收回 / 停靠隐藏态手柄整体退场，不参与命中测试 */
  ${S}.ptx-window.is-maximized .ptx-resize-layer,
  ${S}.ptx-window.is-collapsed .ptx-resize-layer,
  ${S}.ptx-window.is-docked .ptx-resize-layer { display: none; }

  /* ================= 内容入场：纯淡入 + 网格 stagger（无位移、无缩放） ================= */
  ${S}.ptx-viewport > :not(dialog) { animation: ptxFade 0.4s var(--ease-organic) backwards; }
  ${S}.ptx-spores > *,
  ${S}.ptx-points > *,
  ${S}.ptx-quotes > *,
  ${S}.ptx-tiles > *,
  ${S}.ptx-strip > * {
    animation: ptxFade 0.45s var(--ease-organic) backwards;
  }
  ${S}.ptx-spores > *:nth-child(2), ${S}.ptx-points > *:nth-child(2), ${S}.ptx-quotes > *:nth-child(2), ${S}.ptx-tiles > *:nth-child(2) { animation-delay: 0.04s; }
  ${S}.ptx-spores > *:nth-child(3), ${S}.ptx-points > *:nth-child(3), ${S}.ptx-quotes > *:nth-child(3), ${S}.ptx-tiles > *:nth-child(3) { animation-delay: 0.08s; }
  ${S}.ptx-spores > *:nth-child(4), ${S}.ptx-points > *:nth-child(4), ${S}.ptx-quotes > *:nth-child(4), ${S}.ptx-tiles > *:nth-child(4) { animation-delay: 0.12s; }
  ${S}.ptx-spores > *:nth-child(5), ${S}.ptx-points > *:nth-child(5), ${S}.ptx-quotes > *:nth-child(5), ${S}.ptx-tiles > *:nth-child(5) { animation-delay: 0.16s; }
  ${S}.ptx-spores > *:nth-child(n+6), ${S}.ptx-points > *:nth-child(n+6), ${S}.ptx-quotes > *:nth-child(n+6), ${S}.ptx-tiles > *:nth-child(n+6) { animation-delay: 0.2s; }

  /* ================= 左侧工具栏 ================= */
  ${S}.ptx-rail {
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

  ${S}.ptx-rail-brand {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: var(--r-card);
    color: var(--bio-primary-strong);
    background: var(--surface-mint);
    border: 1px solid rgba(14, 164, 79, 0.16);
  }

  ${S}.ptx-keys {
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
  ${S}.ptx-rail-foot {
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
  ${S}.ptx-gear.is-active {
    color: var(--bio-primary-strong);
    background: var(--surface-mint-strong);
    border-color: rgba(14, 164, 79, 0.28);
    box-shadow: var(--shadow-card);
  }
  ${S}.ptx-gear.is-active::before {
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
  ${S}.ptx-settings-page {
    display: flex;
    flex-direction: column;
  }
  ${S}.ptx-settings-shell {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr);
    gap: 22px;
    align-items: start;
  }
  ${S}.ptx-settings-outline {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 12px 2px 0;
    border-right: 1px solid var(--hairline);
  }
  ${S}.ptx-outline-h {
    margin-bottom: 8px;
    font-family: var(--bio-mono);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--bio-primary-strong);
  }
  ${S}.ptx-outline-item {
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
  ${S}.ptx-outline-item:hover,
  ${S}.ptx-outline-item:focus-visible {
    outline: none;
    color: var(--bio-primary-strong);
    background: var(--surface-mint);
  }
  ${S}.ptx-settings-main { min-width: 0; display: flex; flex-direction: column; }
  ${S}.ptx-settings-main > .ptx-sec + .ptx-sec { margin-top: 18px; }
  ${S}.ptx-settings-main > .ptx-sec > .ptx-sec-h { cursor: pointer; user-select: none; }
  ${S}.ptx-settings-main > .ptx-sec > .ptx-sec-h::before {
    content: "−";
    flex: none;
    width: 14px;
    font-family: var(--bio-mono);
    font-size: 13px;
    line-height: 1;
    color: var(--bio-primary-strong);
  }
  ${S}.ptx-settings-main > .ptx-sec.is-collapsed > .ptx-sec-h::before { content: "+"; }
  ${S}.ptx-settings-main > .ptx-sec.is-collapsed > :not(.ptx-sec-h) { display: none; }
  ${S}.ptx-window.is-narrow .ptx-settings-shell { grid-template-columns: 1fr; gap: 0; }
  ${S}.ptx-window.is-narrow .ptx-settings-outline { position: static; flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--hairline); padding: 0 0 10px; margin-bottom: 16px; }
  ${S}.ptx-window.is-narrow .ptx-outline-h { width: 100%; margin: 0 0 4px; }
  ${S}.ptx-settings-row {
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
  ${S}.ptx-settings-row + .ptx-settings-row { margin-top: 8px; }
  ${S}.ptx-settings-label {
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
  ${S}.ptx-settings-label em {
    font-style: normal;
    font-size: 11.5px;
    font-weight: 400;
    line-height: 1.62;
    color: var(--bio-ink-4);
  }

  ${S}.ptx-input.ptx-settings-num { width: 84px; height: 30px; padding: 0 9px; font-size: 12.5px; text-align: right; }

  ${S}.ptx-settings-inline { display: inline-flex; align-items: center; gap: 6px; }
  ${S}.ptx-settings-sep { font-size: 12.5px; color: var(--bio-ink-4); }

  ${S}.ptx-settings-note {
    margin-top: 10px;
    padding: 0 2px;
    font-size: 11.5px;
    line-height: 1.62;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }

  /* 知识库维护：危险操作独立成卡，柔和朱红发丝线，二次确认就地展开 */
  ${S}.ptx-maint {
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
  ${S}.ptx-maint-text { font-size: 12.5px; line-height: 1.68; color: var(--bio-ink-3); }
  ${S}.ptx-maint-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
  ${S}.ptx-maint-confirm .ptx-act-ask { flex: 1 1 180px; color: var(--danger-ink); }

  /* 系统提示词状态行：与词条修正表单共用 ptx-editor 卡片，
     只保留这一条状态文本（等宽小字，自定义生效时转向主绿）。 */
  ${S}.ptx-prompt-status {
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
  }
  ${S}.ptx-prompt-status.is-custom { color: var(--bio-primary-strong); }

  /* 开关：几何固定 34×20，仅轨道底色 / 描边与滑块位移变化 */
  ${S}.ptx-switch {
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
  ${S}.ptx-switch::after {
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
  ${S}.ptx-switch.is-on { background: var(--bio-primary); border-color: #0a7c3a; }
  ${S}.ptx-switch.is-on::after { transform: translateX(14px); }
  ${S}.ptx-switch:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 2px; }

  /* ================= 控件基座：几何固定，仅颜色 / 描边 / 阴影反馈 ================= */
  ${S}.ptx-tab,
  ${S}.ptx-tool,
  ${S}.ptx-foot-btn,
  ${S}.ptx-back {
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

  ${S}.ptx-tab:hover,
  ${S}.ptx-tool:hover,
  ${S}.ptx-foot-btn:hover,
  ${S}.ptx-back:hover {
    color: var(--bio-primary-strong);
    background: var(--surface-hover);
    border-color: rgba(14, 164, 79, 0.26);
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.06);
  }

  ${S}.ptx-tab:active,
  ${S}.ptx-tool:active,
  ${S}.ptx-foot-btn:active,
  ${S}.ptx-back:active {
    background: var(--surface-active);
    border-color: rgba(14, 164, 79, 0.34);
    box-shadow: inset 0 1px 2px rgba(20, 50, 34, 0.07);
  }

  ${S}.ptx-tab:focus-visible,
  ${S}.ptx-tool:focus-visible,
  ${S}.ptx-foot-btn:focus-visible,
  ${S}.ptx-back:focus-visible,
  ${S}.ptx-spore:focus-visible,
  ${S}.ptx-pill:focus-visible,
  ${S}.ptx-trow:focus-visible,
  ${S}.ptx-btn:focus-visible {
    outline: 2px solid rgba(14, 164, 79, 0.55);
    outline-offset: 2px;
  }

  /* ================= 词条操作按钮（发丝线 + 柔和朱红危险标注，几何恒定） ================= */
  ${S}.ptx-acts {
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
  ${S}.ptx-acts.is-confirm { background: var(--surface-danger); border-color: rgba(196, 72, 92, 0.24); }
  ${S}.ptx-act-ask { flex: 1 1 auto; min-width: 0; font-size: 12.5px; line-height: 1.6; color: var(--bio-ink-2); }
  ${S}.ptx-acts.is-confirm .ptx-act-ask { color: var(--danger-ink); }

  ${S}.ptx-btn {
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
  ${S}.ptx-btn:hover {
    color: var(--bio-primary-strong);
    background: var(--surface-hover);
    border-color: rgba(14, 164, 79, 0.26);
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.06);
  }
  ${S}.ptx-btn:active { background: var(--surface-active); border-color: rgba(14, 164, 79, 0.34); box-shadow: inset 0 1px 2px rgba(20, 50, 34, 0.07); }
  ${S}.ptx-btn.is-primary { color: var(--bio-primary-strong); border-color: rgba(14, 164, 79, 0.3); }
  ${S}.ptx-btn.is-primary:hover { background: var(--bio-primary); border-color: rgba(10, 124, 58, 0.6); color: #ffffff; }
  ${S}.ptx-btn.is-danger { color: var(--bio-danger); border-color: rgba(196, 72, 92, 0.32); }
  ${S}.ptx-btn.is-danger:hover { color: var(--bio-danger); background: var(--surface-danger); border-color: rgba(196, 72, 92, 0.48); }
  ${S}.ptx-btn.is-danger-solid { color: #ffffff; background: var(--bio-danger); border-color: rgba(168, 58, 76, 0.9); }
  ${S}.ptx-btn.is-danger-solid:hover { color: #ffffff; background: #b03d50; border-color: #97364a; }
  ${S}.ptx-btn.is-danger-solid:active { background: #a83a4c; }
  ${S}.ptx-btn.is-busy { opacity: 0.56; pointer-events: none; }

  /* 明暗主题切换：rail 底部与齿轮并列，日 / 月图标只由 .is-dark 切换显隐，不产生形变 */
  ${S}.ptx-theme .ptx-ico-sun { display: none; }
  ${S}.ptx-theme .ptx-ico-moon { display: block; }

  ${S}.ptx-tab {
    position: relative;
    width: var(--ctl-lg);
    height: var(--ctl-lg);
    display: grid;
    place-items: center;
    padding: 0;
  }

  ${S}.ptx-tab::before {
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

  ${S}.ptx-tab.is-active {
    color: var(--bio-primary-strong);
    background: var(--surface-mint-strong);
    border-color: rgba(14, 164, 79, 0.28);
    box-shadow: var(--shadow-card);
  }

  ${S}.ptx-tab.is-active::before { opacity: 1; }

  /* ================= 主体 ================= */
  /* 标准右列：圆角与裁剪全部由 .ptx-shell 统一负责，这里只做 flex 布局 */
  ${S}.ptx-body {
    position: relative;
    z-index: 6;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  ${S}.ptx-topbar {
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
  }

  ${S}.ptx-window.is-dragging .ptx-topbar { cursor: grabbing; }

  ${S}.ptx-id { display: flex; align-items: center; gap: 8px; min-width: 0; }
  ${S}.ptx-id-glyph { color: var(--bio-primary-strong); opacity: 0.92; }
  ${S}.ptx-id-code {
    font-family: var(--bio-mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--topbar-ink);
  }
  ${S}.ptx-id-sep { width: 1px; height: 12px; background: var(--hairline-strong); }

  /* 顶栏状态徽标：语义色 + 单点，无装饰斜杠、无呼吸缩放。
     它必须是 <button>（点击跳转监控页签）：顶栏是拖拽手柄，守卫只放行
     button/input/select/textarea/a，span 的点击会被拖拽吞掉。故先抹平 UA 按钮外观
     （appearance / font / margin 归零），border / background / padding 全部按胶囊规格
     显式重声明，观感与原来的 span 完全一致。 */
  ${S}.ptx-phase {
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

  ${S}.ptx-phase i {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--bio-primary);
  }

  ${S}.ptx-phase[data-phase="BURSTING"] { color: var(--danger-ink); background: var(--surface-danger); border-color: rgba(196, 72, 92, 0.28); }
  ${S}.ptx-phase[data-phase="BURSTING"] i { background: var(--bio-danger); }
  ${S}.ptx-phase[data-phase="COOLING"] { color: var(--amber-ink); background: var(--surface-amber); border-color: rgba(184, 121, 30, 0.28); }
  ${S}.ptx-phase[data-phase="COOLING"] i { background: var(--bio-enzyme); }
  ${S}.ptx-phase[data-phase="SUMMARIZING"] { color: var(--tag-ink); background: var(--surface-cyan-soft); border-color: rgba(14, 143, 134, 0.26); }
  ${S}.ptx-phase[data-phase="SUMMARIZING"] i { background: var(--bio-secondary); }
  ${S}.ptx-phase[data-phase="LOADING"] { color: var(--bio-ink-3); background: var(--surface-track); border-color: var(--hairline-strong); }
  ${S}.ptx-phase[data-phase="LOADING"] i { background: var(--bio-ink-4); animation: ptxPhasePulse 2.6s var(--ease-organic) infinite; }
  ${S}.ptx-phase[data-phase="OFFLINE"] { color: var(--danger-ink); background: var(--surface-danger); border-color: rgba(196, 72, 92, 0.24); }
  ${S}.ptx-phase[data-phase="OFFLINE"] i { background: var(--bio-danger); }

  /* 可点击反馈：只加深描边（各相位用自己的语义色阶），底色与呼吸点一律不动 */
  ${S}.ptx-phase:hover { border-color: rgba(14, 164, 79, 0.36); }
  ${S}.ptx-phase[data-phase="LOADING"]:hover { border-color: var(--bio-ink-4); }
  ${S}.ptx-phase[data-phase="BURSTING"]:hover,
  ${S}.ptx-phase[data-phase="OFFLINE"]:hover { border-color: rgba(196, 72, 92, 0.46); }
  ${S}.ptx-phase[data-phase="COOLING"]:hover { border-color: rgba(184, 121, 30, 0.46); }
  ${S}.ptx-phase[data-phase="SUMMARIZING"]:hover { border-color: rgba(14, 143, 134, 0.44); }
  ${S}.ptx-phase:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 2px; }

  ${S}.ptx-tools { display: flex; align-items: center; gap: 6px; }

  ${S}.ptx-tool { position: relative; width: var(--ctl); height: var(--ctl); display: grid; place-items: center; padding: 0; }
  ${S}.ptx-tool.is-on { color: var(--bio-primary-strong); background: var(--surface-mint); border-color: rgba(14, 164, 79, 0.26); }
  ${S}.ptx-tool.is-busy svg { animation: ptxSpin 0.9s linear infinite; }

  /* 常规三窗口按钮：固定圆角 28px，hover / active 仅明度与描边变化，绝不形变 */
  ${S}.ptx-winctl {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 2px;
    padding-left: 10px;
    border-left: 1px solid var(--hairline);
  }
  ${S}.ptx-winctl-btn {
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
  ${S}.ptx-winctl-btn:hover {
    color: var(--bio-primary-strong);
    background: var(--surface-hover);
    border-color: rgba(14, 164, 79, 0.26);
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.06);
  }
  ${S}.ptx-winctl-btn:active {
    background: var(--surface-active);
    border-color: rgba(14, 164, 79, 0.34);
    box-shadow: inset 0 1px 2px rgba(20, 50, 34, 0.07);
  }
  ${S}.ptx-winctl-btn:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 2px; }
  ${S}.ptx-winctl-btn.is-close:hover { color: #ffffff; background: var(--bio-danger); border-color: #a83a4c; box-shadow: 0 1px 2px rgba(196, 72, 92, 0.24); }
  ${S}.ptx-winctl-btn.is-close:active { background: #b03c4e; border-color: #93333f; color: #ffffff; }

  /* 最大化 / 还原图标按窗口状态纯 CSS 互换 */
  ${S}.ptx-ico-restore { display: none; }
  ${S}.ptx-window.is-maximized .ptx-ico-max { display: none; }
  ${S}.ptx-window.is-maximized .ptx-ico-restore { display: grid; place-items: center; }

  /* 筛选控件 */
  ${S}.ptx-filter { display: flex; align-items: center; gap: 6px; }
  ${S}.ptx-chip {
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
  ${S}.ptx-chip:focus-within { border-color: rgba(14, 164, 79, 0.4); background: var(--surface-hover); }
  ${S}.ptx-chip > svg { flex: none; color: var(--bio-ink-4); }
  ${S}.ptx-selectbtn,
  ${S}.ptx-find {
    height: 26px;
    border: 0;
    background: transparent;
    color: var(--ctl-ink);
    font-family: var(--bio-mono);
    font-size: 12px;
    letter-spacing: 0.01em;
    outline: none;
  }
  ${S}.ptx-find { width: 112px; }
  ${S}.ptx-find::placeholder { color: var(--bio-ink-4); letter-spacing: 0.02em; }
  ${S}.ptx-find::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }

  /* 群聊范围：自绘 listbox。原生 select 展开后是系统弹层（深色矩形 + 系统蓝高亮条），
     与纸面材质完全冲突，故整块自绘：chip 里只留一个开合按钮 + 一层面板。 */
  ${S}.ptx-channel { position: relative; padding-right: 7px; }
  ${S}.ptx-channel.is-open { border-color: rgba(14, 164, 79, 0.4); background: var(--surface-hover); }
  ${S}.ptx-selectbtn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    cursor: pointer;
    transition: color 0.16s var(--ease-organic);
  }
  ${S}.ptx-selectbtn-label { max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ${S}.ptx-selectbtn:hover { color: var(--bio-primary-strong); }
  ${S}.ptx-selectbtn > svg { flex: none; color: var(--bio-ink-4); transition: transform 0.18s var(--ease-organic); }
  ${S}.ptx-channel.is-open .ptx-selectbtn > svg { transform: rotate(180deg); }
  ${S}.ptx-selectbtn:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 2px; border-radius: var(--r-tag); }

  /* 面板绝对定位在 chip 正下方：右缘对齐、不窄于 chip，内部滚动上限 236px。
     right / min-width 抵掉 chip 的 1px 边框与 7px 右内边距（100% 量的是 padding box），
     面板因此与 chip 外缘等宽或更宽；z-index 高于顶栏内容，仍在 .ptx-body 自己的
     层叠上下文与裁剪矩形内。 */
  ${S}.ptx-menu {
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
  ${S}.ptx-menu-item {
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
  ${S}.ptx-menu-item::before {
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
  ${S}.ptx-menu-item:hover,
  ${S}.ptx-menu-item.is-active { background: var(--surface-hover); color: var(--bio-ink-2); }
  ${S}.ptx-menu-item[aria-selected="true"] { background: var(--surface-mint-soft); color: var(--bio-primary-strong); }
  ${S}.ptx-menu-item[aria-selected="true"]::before { background: var(--bio-primary); }
  ${S}.ptx-menu-item:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.45); outline-offset: -2px; }

  /* ================= 内容视窗 ================= */
  ${S}.ptx-viewport {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px 20px 18px;
    /* 东侧缩放热区内嵌占住窗口右缘 8px：滚动条整体右移 8px，绝不落在透明热区底下 */
    margin-right: 8px;
    scrollbar-width: thin;
    scrollbar-color: var(--scroll-thumb) transparent;
  }
  ${S}.ptx-viewport::-webkit-scrollbar { width: 8px; }
  ${S}.ptx-viewport::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 4px; }
  ${S}.ptx-viewport::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }

  ${S}.ptx-vhead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--hairline);
  }
  ${S}.ptx-vhead-bar {
    flex: none;
    width: 14px;
    height: 2px;
    border-radius: 1px;
    background: var(--bio-primary);
  }
  ${S}.ptx-vhead-title { font-size: 13.5px; font-weight: 650; letter-spacing: 0.02em; color: var(--bio-ink); }
  ${S}.ptx-vhead-sub {
    margin-left: auto;
    font-family: var(--bio-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
    white-space: nowrap;
  }

  ${S}.ptx-back { flex: none; width: var(--ctl-sm); height: var(--ctl-sm); display: grid; place-items: center; padding: 0; }

  /* ================= 视图模式切换（卡片 / 列表） =================
     标题行右端的分段胶囊：26px 底槽 + 两枚 24×22 按钮，几何恒定，
     激活态只换底色与图标色。底槽用 --surface-track 与纸面拉开一档。 */
  ${S}.ptx-view-mode {
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
  ${S}.ptx-view-btn {
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
  ${S}.ptx-view-btn:hover {
    color: var(--bio-primary-strong);
    background: linear-gradient(180deg, var(--surface) 0%, var(--surface-hover) 100%);
  }
  ${S}.ptx-view-btn:active { background: var(--surface-active); }
  /* 文字变体（触发器引擎切换）：图标按钮的 24px 定宽放不下中文标签，
     引擎名两个字需要自适应宽度 + 内边距，其余交互（hover / active / focus）全部继承。 */
  ${S}.ptx-view-btn.is-text {
    width: auto;
    min-width: 46px;
    padding: 0 10px;
    font-size: 12px;
    letter-spacing: 0.02em;
  }
  ${S}.ptx-view-btn.is-active {
    color: var(--bio-primary-strong);
    background: var(--surface);
    box-shadow: var(--shadow-card);
  }
  ${S}.ptx-view-btn:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.55); outline-offset: 1px; }

  /* ================= 词条网格 ================= */
  ${S}.ptx-spores {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(268px, 1fr));
    gap: 8px;
  }

  ${S}.ptx-spore {
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
  ${S}.ptx-spore:hover {
    background: var(--surface-raise);
    border-color: rgba(14, 164, 79, 0.26);
    box-shadow: 0 1px 3px rgba(20, 50, 34, 0.07);
  }
  ${S}.ptx-spore:active {
    background: var(--surface-press);
    border-color: rgba(14, 164, 79, 0.34);
    box-shadow: inset 0 1px 2px rgba(20, 50, 34, 0.06);
  }

  ${S}.ptx-spore-glyph {
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
  ${S}.ptx-spore-glyph.is-topic {
    color: var(--bio-secondary);
    background: rgba(14, 143, 134, 0.1);
    border-color: rgba(14, 143, 134, 0.22);
  }

  ${S}.ptx-spore-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  ${S}.ptx-spore-top { display: flex; align-items: center; gap: 7px; }
  ${S}.ptx-spore-date { font-family: var(--bio-mono); font-size: 10.5px; letter-spacing: 0.02em; color: var(--bio-ink-4); }
  ${S}.ptx-spore-status {
    font-family: var(--bio-mono);
    font-size: 10px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
    padding-left: 7px;
    border-left: 1px solid var(--hairline-strong);
  }
  ${S}.ptx-spore-status.is-verified { color: var(--bio-primary-strong); }
  ${S}.ptx-spore-status.is-tentative { color: var(--bio-enzyme); }
  ${S}.ptx-spore-status.is-open { color: var(--bio-violet); }
  ${S}.ptx-spore-status.is-unknown { color: var(--bio-ink-4); }
  /* 主题卡的状态位报「N 条相关词条」：主题永远是跨时间聚合的待定视图 */
  ${S}.ptx-spore-status.is-topic { color: var(--bio-secondary); }
  ${S}.ptx-spore-title {
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
  ${S}.ptx-spore-sum {
    font-size: 12.5px;
    line-height: 1.68;
    color: var(--bio-ink-2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-shadow: none;
  }
  ${S}.ptx-spore-go { flex: none; align-self: center; color: var(--ctl-ink-weak); transition: color 0.16s var(--ease-organic); }
  ${S}.ptx-spore:hover .ptx-spore-go { color: var(--bio-primary); }

  /* 列表模式：单列紧凑横向条（最小 46px，垂直居中）。标题单行截断省略，
     多行大摘要与发言人标签让位给密度；日期 / 状态 / 箭头照常保留。 */
  ${S}.ptx-spores.is-list { grid-template-columns: 1fr; gap: 6px; }
  ${S}.ptx-spores.is-list .ptx-spore { min-height: 46px; align-items: center; padding: 6px 10px; }
  ${S}.ptx-spores.is-list .ptx-spore-glyph { width: 24px; height: 24px; }
  ${S}.ptx-spores.is-list .ptx-spore-main { flex-direction: row; align-items: center; gap: 8px; }
  ${S}.ptx-spores.is-list .ptx-spore-title {
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
  ${S}.ptx-spores.is-list .ptx-spore-top { order: 2; flex: none; }
  ${S}.ptx-spores.is-list .ptx-spore-sum,
  ${S}.ptx-spores.is-list .ptx-spore-main .ptx-nodes { display: none; }

  /* ================= 指标条（稀疏数据时的信息密度） ================= */
  ${S}.ptx-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0 0 10px 0;
    border-radius: var(--r-card);
    border: 1px solid var(--hairline);
    background: var(--surface);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  ${S}.ptx-stat { display: flex; flex-direction: column; gap: 2px; padding: 11px 14px; min-width: 0; }
  ${S}.ptx-stat + .ptx-stat { border-left: 1px solid var(--hairline); }
  ${S}.ptx-stat-l { font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.02em; color: var(--bio-ink-4); white-space: nowrap; }
  ${S}.ptx-stat-v {
    font-family: var(--bio-mono);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--bio-ink);
    font-variant-numeric: tabular-nums;
  }

  /* ================= 发言人标签 ================= */
  ${S}.ptx-nodes { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 2px; }
  ${S}.ptx-node {
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
  ${S}.ptx-node:hover { border-color: rgba(14, 164, 79, 0.34); background: var(--surface-mint-strong); }
  ${S}.ptx-node.is-support { color: var(--node-support-ink); background: var(--surface-mint-strong); border-color: rgba(14, 164, 79, 0.26); }
  ${S}.ptx-node.is-dissent { color: var(--amber-ink); background: var(--surface-amber); border-color: rgba(184, 121, 30, 0.26); }
  ${S}.ptx-node.is-dissent:hover { border-color: rgba(184, 121, 30, 0.4); }
  ${S}.ptx-nodes-label {
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
    margin-right: 2px;
  }

  /* ================= 词条正文 ================= */
  ${S}.ptx-r-title { font-size: 19px; font-weight: 700; line-height: 1.38; letter-spacing: -0.01em; color: var(--bio-ink); }
  ${S}.ptx-tags { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
  ${S}.ptx-tag {
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.01em;
    color: var(--tag-ink);
    border: 1px solid rgba(14, 143, 134, 0.2);
    background: var(--surface-cyan);
    border-radius: var(--r-tag);
    padding: 1px 7px;
  }
  ${S}.ptx-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-bottom: 12px;
    font-family: var(--bio-mono);
    font-size: 11px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }
  ${S}.ptx-meta b { color: var(--bio-ink-2); font-weight: 600; margin-left: 3px; }

  ${S}.ptx-sec { margin-bottom: 16px; }
  ${S}.ptx-sec-h {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.02em;
    color: var(--bio-primary-strong);
  }
  ${S}.ptx-sec-h::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--hairline);
  }

  ${S}.ptx-text { max-width: 72ch; font-size: 14px; line-height: 1.78; color: var(--bio-ink-2); white-space: pre-wrap; text-shadow: none; }
  ${S}.ptx-bul { max-width: 72ch; margin: 0; padding-left: 17px; }
  ${S}.ptx-bul li { font-size: 13.5px; line-height: 1.75; color: var(--bio-ink-2); text-shadow: none; }
  ${S}.ptx-bul li + li { margin-top: 3px; }
  ${S}.ptx-bul li::marker { color: rgba(14, 164, 79, 0.6); }

  /* 词条修正：就地编辑表单。正文用等宽字，随内容增高到上限后内部滚动。 */
  ${S}.ptx-editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
  }
  ${S}.ptx-editor-row { display: flex; flex-wrap: wrap; gap: 10px; }
  ${S}.ptx-editor-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  ${S}.ptx-editor-row .ptx-editor-field { flex: 1 1 240px; }
  ${S}.ptx-editor-row .ptx-editor-field.is-narrow { flex: 0 0 132px; }
  ${S}.ptx-editor-label { font-family: var(--bio-mono); font-size: 10.5px; letter-spacing: 0.02em; color: var(--bio-ink-4); }
  ${S}.ptx-editor .ptx-input { width: 100%; height: var(--ctl); padding: 0 10px; font-size: 13px; }
  ${S}.ptx-editor select.ptx-input { padding-right: 6px; cursor: pointer; }
  ${S}.ptx-editor .ptx-editor-area {
    height: auto;
    min-height: 72px;
    padding: 8px 10px;
    line-height: 1.72;
    resize: vertical;
    overflow-y: auto;
  }
  ${S}.ptx-editor .ptx-editor-md {
    min-height: 190px;
    max-height: 340px;
    overflow: auto;
    font-family: var(--bio-mono);
    font-size: 12px;
    line-height: 1.7;
    white-space: pre;
    tab-size: 2;
  }
  ${S}.ptx-editor-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 2px; }
  ${S}.ptx-editor-hint { margin-left: auto; font-size: 11px; line-height: 1.6; color: var(--bio-ink-4); }

  /* 参与群友条 */
  ${S}.ptx-speakers {
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
  ${S}.ptx-points { display: grid; grid-template-columns: repeat(auto-fit, minmax(244px, 1fr)); gap: 8px; }
  ${S}.ptx-point {
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
  ${S}.ptx-point-view { font-size: 13.5px; font-weight: 650; line-height: 1.5; color: var(--bio-ink); }
  ${S}.ptx-voice { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
  ${S}.ptx-voice-l {
    font-family: var(--bio-mono);
    font-size: 10px;
    letter-spacing: 0.02em;
    color: var(--bio-ink-4);
    min-width: 28px;
  }
  ${S}.ptx-voice.is-support .ptx-voice-l { color: rgba(10, 124, 58, 0.8); }
  ${S}.ptx-voice.is-dissent .ptx-voice-l { color: rgba(138, 91, 22, 0.85); }
  ${S}.ptx-point-line { font-size: 12.5px; line-height: 1.7; color: var(--bio-ink-2); text-shadow: none; }
  ${S}.ptx-point-line b { color: var(--bio-ink-3); font-weight: 600; margin-right: 5px; }

  /* 原始引用 */
  ${S}.ptx-quotes { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px; }
  ${S}.ptx-quote {
    padding: 11px 13px;
    border-radius: var(--r-card);
    border-left: 2px solid rgba(184, 121, 30, 0.5);
    background: var(--surface-warm);
    border-top: 1px solid var(--hairline);
    border-right: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
  }
  ${S}.ptx-quote-t { font-size: 13.5px; line-height: 1.75; color: var(--bio-ink); text-shadow: none; }
  ${S}.ptx-quote-a { margin-top: 5px; font-family: var(--bio-mono); font-size: 10.5px; letter-spacing: 0.01em; color: rgba(138, 91, 22, 0.9); }

  /* 导语与起因行 */
  ${S}.ptx-lead { max-width: 72ch; font-size: 14.5px; line-height: 1.75; color: var(--bio-ink); border-left: 2px solid rgba(14, 164, 79, 0.45); padding-left: 12px; text-shadow: none; }
  ${S}.ptx-cause { margin-top: 7px; max-width: 72ch; font-size: 12.5px; line-height: 1.65; color: var(--bio-ink-3); text-shadow: none; }
  ${S}.ptx-cause-l { font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.02em; color: var(--bio-slate); margin-right: 6px; }

  /* 讨论脉络 / 主题综述：词条主体的连续叙事 */
  ${S}.ptx-narrative { max-width: 68ch; }
  ${S}.ptx-narrative p { margin: 0 0 12px; font-size: 14px; line-height: 1.85; color: var(--bio-ink-2); text-shadow: none; }
  ${S}.ptx-narrative p:last-child { margin-bottom: 0; }
  ${S}.ptx-quote-span { color: var(--bio-primary-strong); background: rgba(14, 143, 134, 0.08); border-radius: 3px; padding: 0 2px; }

  /* 正文内联昵称胶囊：与「…」原话高亮（无边框）在视觉上区分 */
  ${S}.ptx-node.is-inline { display: inline; padding: 0 5px; margin: 0 1px; font-size: 0.84em; line-height: inherit; vertical-align: baseline; white-space: nowrap; box-decoration-break: clone; }

  /* 相关线索：无外框的安静索引；行间发丝线分隔，数字走等宽绿，标题与摘要分层 */
  ${S}.ptx-related { list-style: none; margin: 0; padding: 0; max-width: 72ch; display: flex; flex-direction: column; border-top: 1px solid var(--hairline); background: transparent; }
  ${S}.ptx-link { -webkit-appearance: none; appearance: none; display: grid; grid-template-columns: 22px minmax(0, 1fr) 14px; align-items: start; column-gap: 10px; width: 100%; margin: 0; padding: 9px 6px 9px 2px; border: 0; border-bottom: 1px solid var(--hairline); border-radius: 0; background: transparent; box-shadow: none; font: inherit; text-align: left; color: inherit; cursor: pointer; transition: background-color 0.16s var(--ease-organic); }
  ${S}.ptx-link:last-child { border-bottom: 0; }
  ${S}button.ptx-link:hover, ${S}button.ptx-link:focus-visible { background: var(--surface-mint); border-radius: 6px; outline: none; }
  ${S}button.ptx-link:hover .ptx-link-title, ${S}button.ptx-link:focus-visible .ptx-link-title { color: var(--bio-primary-strong); }
  ${S}button.ptx-link:hover .ptx-link-go, ${S}button.ptx-link:focus-visible .ptx-link-go { color: var(--bio-primary); opacity: 1; transform: translateX(2px); }
  ${S}.ptx-link-no { padding-top: 1px; font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.04em; color: var(--bio-primary-strong); font-variant-numeric: tabular-nums; }
  ${S}.ptx-link-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  ${S}.ptx-link-title { font-size: 13px; line-height: 1.5; font-weight: 600; color: var(--bio-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  ${S}.ptx-link-sum { font-size: 11.5px; line-height: 1.55; color: var(--bio-ink-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  ${S}.ptx-link-go { align-self: center; color: var(--bio-ink-4); opacity: 0.5; transition: color 0.16s var(--ease-organic), opacity 0.16s var(--ease-organic), transform 0.16s var(--ease-organic); }
  ${S}.ptx-link.is-missing { grid-template-columns: 22px minmax(0, 1fr) auto; cursor: default; opacity: 0.55; }
  ${S}.ptx-link.is-missing .ptx-link-title { font-weight: 500; color: var(--bio-ink-3); }
  ${S}.ptx-link-flag { align-self: center; margin-left: 6px; font-family: var(--bio-mono); font-size: 10px; padding: 0 5px; border: 1px solid var(--hairline); border-radius: var(--r-tag); color: var(--bio-ink-4); white-space: nowrap; }

  /* 「其余 N 条」折叠：与列表同轴对齐的安静入口 */
  ${S}.ptx-related-more { margin-top: 0; border-top: 1px solid var(--hairline); }
  ${S}.ptx-related-more > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 9px 6px 9px 2px; font-family: var(--bio-mono); font-size: 11px; color: var(--bio-ink-3); list-style: none; }
  ${S}.ptx-related-more > summary::-webkit-details-marker { display: none; }
  ${S}.ptx-related-more > summary::after { content: "＋"; margin-left: auto; color: var(--bio-ink-4); }
  ${S}.ptx-related-more[open] > summary::after { content: "－"; }
  ${S}.ptx-related-more > .ptx-related { border-top: 0; }

  /* 附录：争点对照 + 摘句收进默认折叠的结构化索引 */
  ${S}.ptx-appendix { border: 1px solid var(--hairline); border-radius: var(--r-card); background: var(--surface); }
  ${S}.ptx-appendix > summary { cursor: pointer; padding: 9px 12px; font-size: 12px; font-weight: 650; letter-spacing: 0.02em; color: var(--bio-primary-strong); list-style: none; }
  ${S}.ptx-appendix > summary::-webkit-details-marker { display: none; }
  ${S}.ptx-appendix > summary::after { content: "＋"; float: right; color: var(--bio-ink-4); }
  ${S}.ptx-appendix[open] > summary::after { content: "－"; }
  ${S}.ptx-appendix .ptx-points, ${S}.ptx-appendix .ptx-quotes { padding: 0 12px 12px; }
  ${S}.ptx-app-h { padding: 0 12px 6px; font-size: 11px; font-weight: 650; letter-spacing: 0.04em; color: var(--bio-secondary); }

  /* 落点：已收敛 / 仍悬而未决 双列 */
  ${S}.ptx-outcome { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  ${S}.ptx-outcome-col { padding: 10px 12px; border-radius: var(--r-card); background: var(--surface); border: 1px solid var(--hairline); }
  ${S}.ptx-outcome-l { display: block; margin-bottom: 6px; font-size: 11.5px; font-weight: 650; color: var(--bio-ink-3); }
  ${S}.ptx-window.is-narrow .ptx-outcome { grid-template-columns: 1fr; }

  /* 名词注：紧凑释义表 */
  ${S}.ptx-gloss { max-width: 72ch; margin: 0; }
  ${S}.ptx-gloss-row { display: flex; gap: 10px; font-size: 13px; line-height: 1.7; margin-bottom: 4px; }
  ${S}.ptx-gloss-row dt { flex: 0 0 auto; font-weight: 650; color: var(--bio-ink); }
  ${S}.ptx-gloss-row dd { margin: 0; color: var(--bio-ink-2); text-shadow: none; }

  /* ================= 监控 ================= */
  ${S}.ptx-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  ${S}.ptx-tile {
    padding: 10px 12px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
    min-width: 0;
  }
  ${S}.ptx-tile-l { font-size: 11.5px; line-height: 1.4; color: var(--bio-ink-3); }
  ${S}.ptx-tile-v {
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
  ${S}.ptx-tile-v small { margin-left: 4px; font-size: 10.5px; font-weight: 500; color: var(--bio-ink-4); }

  /* 监控页纵向顺序：流量图表 → 最新消息 → 指标磁贴（消息夹在趋势与数值之间充当事件锚点） */
  ${S}.ptx-message-preview + .ptx-tiles { margin-top: 10px; }

  /* 当前群最新消息横条：柔和葱绿底 + 发丝线边界；富媒体段就地展开，绝不撑满监控视窗 */
  ${S}.ptx-message-preview {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: var(--r-card);
    background: var(--surface-mint-soft);
    border: 1px solid rgba(14, 164, 79, 0.16);
    box-shadow: var(--shadow-card);
  }
  ${S}.ptx-message-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--bio-mono);
    font-size: 10.5px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }
  ${S}.ptx-message-head strong {
    flex: none;
    font-family: var(--bio-ui);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.01em;
    color: var(--bio-ink);
  }
  ${S}.ptx-message-head [data-message-author] {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--bio-primary-strong);
  }
  ${S}.ptx-message-head time { flex: none; font-variant-numeric: tabular-nums; }
  /* 正文容器：文字段与媒体段共用一条可换行基线，媒体段独占整行 */
  ${S}.ptx-message-body {
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
  ${S}.ptx-rich-text {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 100%;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  ${S}.ptx-rich-face { width: 20px; height: 20px; border-radius: 5px; object-fit: cover; vertical-align: -5px; }

  /* 图片缩略：点击放大走原生 dialog；按钮本体永不形变（只换边框色，无位移 / 缩放 / 发光） */
  ${S}.ptx-rich-image {
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
  ${S}.ptx-rich-image img { display: block; max-width: 100%; max-height: 140px; width: auto; height: auto; }
  ${S}.ptx-rich-image:hover { border-color: rgba(14, 164, 79, 0.3); }
  ${S}.ptx-rich-image:active { border-color: rgba(14, 164, 79, 0.44); }
  ${S}.ptx-rich-image:focus-visible { outline: 2px solid rgba(14, 164, 79, 0.42); outline-offset: 1px; }
  /* 加载失败的可见兜底（直链失效 / 媒体代理已过期），绝不留空白或假图 */
  ${S}.ptx-rich-failed { font-family: var(--bio-mono); font-size: 10.5px; color: var(--bio-danger); }

  /* 卡片 / 视频：白底发丝线小卡，封面统一裁切，避免富媒体抢走图表的注意力 */
  ${S}.ptx-rich-media-card,
  ${S}.ptx-rich-card {
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
  ${S}.ptx-rich-card:hover { border-color: rgba(14, 164, 79, 0.26); }
  ${S}.ptx-rich-cover {
    display: block;
    width: 100%;
    max-height: 128px;
    object-fit: cover;
    border-radius: var(--r-ctl);
    background: rgba(20, 50, 34, 0.04);
  }
  ${S}.ptx-rich-media-title,
  ${S}.ptx-rich-card-title { display: block; margin-top: 6px; font-size: 12px; font-weight: 650; line-height: 1.5; color: var(--bio-ink); }
  ${S}.ptx-rich-media-title:first-child { margin-top: 0; }
  ${S}.ptx-rich-card-text { display: block; margin-top: 2px; font-size: 11.5px; line-height: 1.6; color: var(--bio-ink-3); }
  ${S}.ptx-rich-card-source { display: block; margin-top: 4px; font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); }
  ${S}.ptx-rich-video-player { display: block; width: 100%; max-height: 168px; margin-top: 6px; border-radius: var(--r-ctl); background: #0f1a14; }
  ${S}.ptx-rich-link { display: inline-block; margin-top: 6px; font-family: var(--bio-mono); font-size: 10.5px; color: var(--bio-primary-strong); text-decoration: none; }
  ${S}.ptx-rich-link:hover { text-decoration: underline; }

  /* 引用 / 合并转发：左侧薄荷绿竖线（与观点矩阵同一套样式语言） */
  ${S}.ptx-rich-quote,
  ${S}.ptx-rich-forward {
    flex: 1 1 100%;
    min-width: 0;
    padding: 6px 10px;
    border-left: 2px solid rgba(14, 164, 79, 0.28);
    border-radius: 0 var(--r-ctl) var(--r-ctl) 0;
    background: rgba(14, 164, 79, 0.05);
  }
  ${S}.ptx-rich-quote-title { display: block; font-size: 11px; font-weight: 650; line-height: 1.5; color: var(--bio-primary-strong); }
  ${S}.ptx-rich-quote-text { display: block; font-size: 11.5px; line-height: 1.6; color: var(--bio-ink-3); overflow-wrap: anywhere; }
  ${S}.ptx-rich-forward-summary {
    display: flex;
    align-items: baseline;
    gap: 8px;
    cursor: pointer;
    list-style: none;
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--bio-primary-strong);
  }
  ${S}.ptx-rich-forward-summary::-webkit-details-marker { display: none; }
  ${S}.ptx-rich-forward-summary::after { content: "展开"; margin-left: auto; flex: none; font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); }
  ${S}.ptx-rich-forward[open] > .ptx-rich-forward-summary::after { content: "收起"; }
  ${S}.ptx-rich-forward-title { flex: none; font-weight: 650; }
  ${S}.ptx-rich-forward-count { flex: 1; min-width: 0; font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); }
  /* 展开后就地推挤，但内部细滚动 + 高度上限，绝不把监控视窗无节制向下推 */
  ${S}.ptx-rich-forward-body {
    max-height: 180px;
    margin-top: 6px;
    padding-right: 2px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(20, 50, 34, 0.18) transparent;
  }
  ${S}.ptx-rich-forward-body::-webkit-scrollbar { width: 6px; }
  ${S}.ptx-rich-forward-body::-webkit-scrollbar-thumb { border-radius: 3px; background: rgba(20, 50, 34, 0.16); }
  ${S}.ptx-rich-forward-item { padding: 5px 0; border-top: 1px dashed rgba(20, 50, 34, 0.1); }
  ${S}.ptx-rich-forward-item:first-child { padding-top: 0; border-top: none; }
  ${S}.ptx-rich-forward-author { display: block; font-size: 10.5px; font-weight: 650; line-height: 1.5; color: var(--bio-ink-2); }
  ${S}.ptx-rich-forward-more { display: block; margin-top: 4px; font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); }
  ${S}.ptx-rich-line {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 4px 6px;
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--bio-ink-3);
    overflow-wrap: anywhere;
  }
  ${S}.ptx-rich-line .ptx-rich-image img { max-height: 96px; }
  ${S}.ptx-rich-line .ptx-rich-cover { max-height: 96px; }

  /* 文件 / 语音：单行胶囊，链接仅在 URL 合法时出现 */
  ${S}.ptx-rich-file {
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
  ${S}.ptx-rich-file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 11.5px;
    color: var(--bio-ink-2);
  }
  ${S}.ptx-rich-file .ptx-rich-link { flex: none; margin-top: 0; }
  ${S}.ptx-rich-record { flex: 1 1 100%; min-width: 0; display: flex; align-items: center; gap: 8px; }
  ${S}.ptx-rich-audio { flex: 1 1 auto; min-width: 0; height: 30px; }
  ${S}.ptx-rich-record-label { flex: none; font-family: var(--bio-mono); font-size: 10.5px; color: var(--bio-ink-4); font-variant-numeric: tabular-nums; }

  /* 图片放大：原生 dialog（Esc / 点空白关闭），固定全屏居中的顶层弹窗。
     dialog 挂在有机根容器下（不是 .ptx-viewport 里），因此定位与尺寸必须自带全套：
     fixed + inset: 0 + margin: auto 才同时拿到水平与垂直居中，width: fit-content 让
     小图不撑成整屏；!important 用于压过 top layer 的 UA 版式与任何宿主继承下来的
     宽容规则（尤其 .ptx-viewport > :not(dialog) 之外残留的 100% 宽度 / 单轴 auto）。 */
  ${S}.ptx-rich-lightbox {
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
    /* 浮层宿主整体 pointer-events: none，弹窗必须自己收回命中测试，点空白才能关闭 */
    pointer-events: auto;
  }
  ${S}.ptx-rich-lightbox::backdrop { background: rgba(12, 24, 18, 0.56); }
  ${S}.ptx-rich-lightbox img {
    display: block;
    margin: 0 auto;
    max-width: min(92vw, 1040px);
    max-height: 92vh;
    object-fit: contain;
  }

  ${S}.ptx-bar { height: 3px; margin-top: 7px; overflow: hidden; border-radius: 2px; background: rgba(20, 50, 34, 0.08); }
  ${S}.ptx-bar i {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--bio-secondary);
    transition: width 0.5s var(--ease-organic);
  }
  ${S}.ptx-bar.is-alert i { background: var(--bio-danger); }

  /* 时间序列图表面板 */
  ${S}.ptx-panel {
    margin-top: 10px;
    padding: 12px 14px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
  }
  ${S}.ptx-panel-h {
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
  ${S}.ptx-panel-h strong {
    font-family: var(--bio-ui);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.01em;
    color: var(--bio-ink);
  }
  ${S}.ptx-panel-h > span:last-child { text-align: right; }
  ${S}.ptx-panel-h b { font-weight: 700; color: var(--bio-ink-2); }
  ${S}.ptx-panel-h + .ptx-panel-h { margin-top: 3px; font-size: 10px; color: var(--bio-ink-4); }
  ${S}.ptx-ecg {
    display: block;
    width: 100%;
    height: 78px;
    margin-top: 8px;
    overflow: visible;
  }
  /* 网格基准线：极淡虚线（流量图的三条 Y 刻度线） */
  ${S}.ptx-ecg-base {
    fill: none;
    stroke: rgba(20, 50, 34, 0.12);
    stroke-width: 1;
    stroke-dasharray: 2 4;
    vector-effect: non-scaling-stroke;
  }
  /* ============ 消息流量图：真实时间轴 × 每 5 秒消息条数 ============ */
  /* 左列 42px 承载 Y 刻度，右列绘图区（minmax(0,1fr) 防止 SVG 撑破面板） */
  ${S}.ptx-traffic-chart {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr);
    align-items: stretch;
    margin-top: 8px;
  }
  ${S}.ptx-traffic-y {
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
  ${S}.ptx-traffic-chart .ptx-ecg { margin-top: 0; height: 140px; }
  /* 时间刻度：缩进 42px 与绘图区左边界对齐 */
  ${S}.ptx-traffic-times {
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
  ${S}.ptx-monitor-status {
    margin-bottom: 8px;
    font-family: var(--bio-mono);
    font-size: 10px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }
  ${S}.ptx-monitor-status:empty { display: none; }
  ${S}.ptx-ecg-line {
    fill: none;
    stroke: var(--bio-primary-strong);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
    transition: stroke 0.3s var(--ease-organic);
  }
  ${S}.ptx-ecg-note {
    margin-top: 4px;
    font-family: var(--bio-mono);
    font-size: 10px;
    letter-spacing: 0.01em;
    color: var(--bio-ink-4);
  }
  /* 突发相位：曲线与描边转为绯红语义色 */
  ${S}.ptx-panel.is-burst { border-color: rgba(196, 72, 92, 0.28); }
  ${S}.ptx-panel.is-burst .ptx-panel-h b { color: var(--bio-danger); }
  ${S}.ptx-panel.is-burst .ptx-ecg-base { stroke: rgba(196, 72, 92, 0.16); }
  ${S}.ptx-panel.is-burst .ptx-ecg-line { stroke: var(--bio-danger); }
  ${S}.ptx-panel.is-burst .ptx-ecg-note { color: var(--bio-danger); }

  ${S}.ptx-input {
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
  ${S}.ptx-input:focus { border-color: rgba(14, 164, 79, 0.5); box-shadow: 0 0 0 3px rgba(14, 164, 79, 0.12); }

  /* ================= 空状态 ================= */
  ${S}.ptx-dormant {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 26px 16px 30px;
    text-align: center;
  }
  ${S}.ptx-nucleus { width: 124px; height: 124px; }
  ${S}.ptx-nucleus-membrane { fill: none; stroke: rgba(14, 164, 79, 0.2); stroke-width: 1; stroke-dasharray: 3 6; }
  ${S}.ptx-nucleus-wall { fill: none; stroke: rgba(14, 143, 134, 0.16); stroke-width: 1; }
  ${S}.ptx-nucleus-core { fill: rgba(14, 164, 79, 0.06); stroke: rgba(14, 164, 79, 0.34); stroke-width: 1; }
  ${S}.ptx-nucleus-seed { fill: var(--bio-primary); opacity: 0.75; }

  /* 空状态点缀轨道：仅保留定位所需动画，无缩放脉冲 */
  ${S}.ptx-orb { transform-origin: 80px 80px; animation: ptxOrbit var(--n-dur) var(--ease-organic) infinite; animation-delay: var(--n-delay); }
  ${S}.ptx-orb ellipse { fill: var(--n-tone); opacity: var(--n-opacity); }

  ${S}.ptx-dormant-t { margin-top: 2px; font-size: 13px; font-weight: 650; letter-spacing: 0.02em; color: var(--bio-ink); }
  ${S}.ptx-dormant-s { font-size: 12px; line-height: 1.6; letter-spacing: 0.01em; color: var(--bio-ink-3); text-shadow: none; max-width: 34ch; }

  /* ================= 底栏 ================= */
  ${S}.ptx-foot {
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
  ${S}.ptx-ticker {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 28px;
    overflow: hidden;
    mask-image: linear-gradient(180deg, transparent 0, #000 2px, #000 calc(100% - 2px), transparent 100%);
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 2px, #000 calc(100% - 2px), transparent 100%);
  }

  ${S}.ptx-trow {
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
  ${S}.ptx-trow.is-active { transform: translateY(0); opacity: 1; }
  ${S}.ptx-trow.is-leaving {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
    transition: transform 0.4s var(--ease-organic), opacity 0.3s ease;
  }
  ${S}.ptx-trow.is-entering { transform: translateY(100%); opacity: 0; }
  ${S}.ptx-tdot { flex: none; width: 4px; height: 4px; border-radius: 50%; background: rgba(14, 164, 79, 0.55); }
  ${S}.ptx-ttitle { flex: 1; min-width: 0; font-size: 13px; font-weight: 550; color: var(--bio-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.16s var(--ease-organic); }
  ${S}.ptx-trow:hover .ptx-ttitle { color: var(--bio-primary-strong); }
  ${S}.ptx-tdate { flex: none; font-family: var(--bio-mono); font-size: 11px; white-space: nowrap; color: var(--bio-ink-4); }

  ${S}.ptx-foot-acts { flex: none; display: flex; align-items: center; gap: 7px; }
  ${S}.ptx-foot-btn { width: var(--ctl); height: var(--ctl); display: grid; place-items: center; padding: 0; }

  /* 主操作按钮：实心葱绿，固定圆形 */
  ${S}.ptx-foot-btn.is-core {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: #ffffff;
    background: var(--bio-primary);
    border: 1px solid #0a7c3a;
    box-shadow: 0 1px 2px rgba(20, 50, 34, 0.12);
  }
  ${S}.ptx-foot-btn.is-core:hover {
    background: #0b9446;
    border-color: #076d33;
    color: #ffffff;
    box-shadow: 0 2px 4px rgba(20, 50, 34, 0.16);
  }
  /* 刷新中的唯一反馈：图标匀速旋转，按钮本体不形变 */
  ${S}.ptx-foot-btn.is-busy svg { animation: ptxSpin 0.9s linear infinite; }

  /* ================= 悬浮胶囊（第二处 backdrop-filter，点击展开） ================= */
  ${S}.ptx-pill {
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
  ${S}.ptx-pill.is-visible {
    opacity: 1;
    transform: scale(1) translateY(0);
    visibility: visible;
    transition-delay: 0s;
  }

  ${S}.ptx-pill:hover {
    background: var(--surface);
    border-color: rgba(14, 164, 79, 0.32);
  }

  /* 拖动中：唯一状态类是 .is-dragging，位移全部走行内 left / top（无过渡、无 transform 形变） */
  ${S}.ptx-pill.is-dragging {
    transition: none;
    transform: none;
    cursor: grabbing;
  }

  ${S}.ptx-pill-core {
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

  ${S}.ptx-pill-txt { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.32; }
  ${S}.ptx-pill-name { font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; color: var(--bio-ink); }
  ${S}.ptx-pill-id { font-size: 11px; letter-spacing: 0.01em; color: var(--bio-ink-4); }

  /* ================= hover 浮层（说明文字唯一出口） ================= */
  ${S}:where([data-tip]) { position: relative; }

  ${S}[data-tip]::after {
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

  ${S}[data-tip]:hover::after,
  ${S}[data-tip]:focus-visible::after {
    opacity: 1;
    visibility: visible;
    transform: translate(-50%, 0);
    transition-delay: 0s;
  }

  ${S}[data-tip][data-tip-pos="right"]::after { left: calc(100% + 10px); top: 50%; transform: translate(-4px, -50%); }
  ${S}[data-tip][data-tip-pos="right"]:hover::after { transform: translate(0, -50%); }
  ${S}[data-tip][data-tip-pos="top"]::after { top: auto; bottom: calc(100% + 8px); transform: translate(-50%, 3px); }
  ${S}[data-tip][data-tip-pos="top"]:hover::after { transform: translate(-50%, 0); }

  /* 群聊面板展开时压掉 chip 自己的提示气泡：面板正落在那条气泡的位置上 */
  ${S}.ptx-channel.is-open::after { opacity: 0; visibility: hidden; }

  /* ================= 轻提示 ================= */
  ${S}.ptx-toast {
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
  ${S}.ptx-toast.is-visible { opacity: 1; transform: translate(-50%, 0); }

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
  ${S}.ptx-vhead {
    max-width: 820px;
    width: 100%;
    margin: 0 auto 12px;
  }
  ${S}.ptx-strip {
    max-width: 820px;
    width: 100%;
    margin: 0 auto 10px;
  }
  ${S}.ptx-spores,
  ${S}.ptx-panel,
  ${S}.ptx-message-preview,
  ${S}.ptx-tiles,
  ${S}.ptx-meta,
  ${S}.ptx-sec,
  ${S}.ptx-editor,
  ${S}.ptx-dormant {
    max-width: 820px;
    width: 100%;
    margin-left: auto;
    margin-right: auto;
  }
  /* 设置页本身就是版心：内部行与编辑器满铺 100%，左缘与标题 100% 垂直对齐 */
  ${S}.ptx-settings-page {
    max-width: 820px;
    width: 100%;
    margin: 0 auto;
  }
  ${S}.ptx-settings-row { width: 100%; }
  /* 兜底：视窗是唯一的排版容器，任何直接子块（正文标题行 / 标签行 / 操作条 / 发言人
     行，以及以后新增的阶段块）都约束在同一条 820px 版心里，左缘永远与标题绿条对齐。
     只排除 dialog：弹窗是挂在根容器上的顶层浮层，它的 fixed / inset / margin: auto
     是自身居中契约，一旦被这里的 100% 宽度 + 左右 auto 边距接管，就只剩水平居中、
     垂直方向直接落回内容流顶部。 */
  ${S}.ptx-viewport > :not(dialog) {
    max-width: 820px;
    width: 100%;
    margin-left: auto;
    margin-right: auto;
  }

  /* ================= 窗口尺寸响应（运行时类名换挡，不用容器查询） =================
     容器查询要声明 container-type 的 inline-size 包含，它会强制布局包含：拖动时窗口每帧改
     left / top、缩放时每帧改 width / height，都会让整窗连同全部子层重新布局并重光栅，
     正是“窗口撕裂 + 背景重绘”的放大器。改为运行时按窗口自身宽度同步两个类名
     （organic-runtime：.is-narrow / .is-compact，阈值计入两侧 1px 发丝线边框），
     CSS 侧只剩普通后代选择器，命中时只做样式重算，不触发尺寸包含。
     只有窗口本体几何与窗口外的浮层入口（胶囊 / 重开按钮）仍按视口判定。 */
  ${S}.ptx-window.is-narrow .ptx-id-code { display: none; }
  ${S}.ptx-window.is-narrow .ptx-spore-sum { display: none; }
  ${S}.ptx-window.is-narrow .ptx-spores { grid-template-columns: 1fr; }
  ${S}.ptx-window.is-narrow .ptx-viewport { padding: 14px 16px 16px; }
  ${S}.ptx-window.is-narrow .ptx-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  ${S}.ptx-window.is-narrow .ptx-stat:nth-child(3) { border-left: 0; }
  ${S}.ptx-window.is-narrow .ptx-stat:nth-child(n+3) { border-top: 1px solid var(--hairline); }

  /* 极窄档的顶栏改成两行：第一行 id 左对齐 + 三键右对齐，第二行筛选与搜索整行铺满。
     .ptx-tools 只是常规档的右侧聚拢层，窄档用 display: contents 把它解包，
     让 filter / winctl 直接成为顶栏的 flex 子项，才能用 order 重新分行。 */
  ${S}.ptx-window.is-compact .ptx-topbar {
    height: auto;
    min-height: 56px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px 8px 12px;
    row-gap: 8px;
  }
  ${S}.ptx-window.is-compact .ptx-tools { display: contents; }
  ${S}.ptx-window.is-compact .ptx-id {
    order: 1;
    flex: 0 1 auto;
    min-width: 0;
  }
  ${S}.ptx-window.is-compact .ptx-winctl {
    order: 2;
    flex: none;
    margin-left: auto;
    gap: 4px;
    padding-left: 8px;
  }
  ${S}.ptx-window.is-compact .ptx-filter {
    order: 3;
    flex: 1 1 100%;
    width: 100%;
    min-width: 0;
  }
  ${S}.ptx-window.is-compact .ptx-chip:last-child { flex: 1 1 96px; min-width: 0; }
  ${S}.ptx-window.is-compact .ptx-find { flex: 1 1 auto; width: auto; min-width: 0; }
  ${S}.ptx-window.is-compact .ptx-tiles { grid-template-columns: 1fr; }
  ${S}.ptx-window.is-compact .ptx-tile-v { font-size: 18px; }
  ${S}.ptx-window.is-compact .ptx-panel { padding: 10px 12px; }
  ${S}.ptx-window.is-compact .ptx-panel-h { flex-wrap: wrap; gap: 2px 10px; }
  ${S}.ptx-window.is-compact .ptx-panel-h > span:last-child { text-align: left; }
  ${S}.ptx-window.is-compact .ptx-ecg { height: 64px; }
  ${S}.ptx-window.is-compact .ptx-traffic-chart .ptx-ecg { height: 120px; }
  ${S}.ptx-window.is-compact .ptx-input { width: 84px; }
  ${S}.ptx-window.is-compact .ptx-editor .ptx-input { width: 100%; }
  ${S}.ptx-window.is-compact .ptx-settings-page { max-width: none; }
  ${S}.ptx-window.is-compact .ptx-acts { padding: 8px; }
  ${S}.ptx-window.is-compact .ptx-editor { padding: 10px; }
  ${S}.ptx-window.is-compact .ptx-editor-field.is-narrow { flex: 1 1 100%; }
  ${S}.ptx-window.is-compact .ptx-editor-hint { margin-left: 0; }

  /* ================= 夜间主题（根容器 .is-dark 上的变量覆盖） =================
     中性冷炭灰（charcoal / slate，参考 Koishi 控制台、Linear、GitHub Dark）：
     页面 #222327、窗口面 #28292e、提升面 #32333b、悬浮面 #393b44，形成 5 级灰度高程；
     主波长收敛为清爽薄荷翠绿 #10b981，发丝线转为白色 8% / 14%，文字走柔白 → 中灰四级。
     明暗共用同一套几何与布局，只换纸面与墨色。 */
  ${DK} {
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
${standalone ? `  html.is-dark body {
    background:
      radial-gradient(1180px 700px at 76% -12%, rgba(16, 185, 129, 0.06), transparent 62%),
      radial-gradient(960px 560px at 2% 112%, rgba(45, 212, 191, 0.05), transparent 62%),
      linear-gradient(180deg, #222327 0%, #1f2024 58%, #1c1d21 100%);
    color: var(--bio-ink);
  }` : ''}

  ${DK} .ptx-rail { box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.05); }
  ${DK} .ptx-input { box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.35); }
  /* 荧光绿底上的文字改用深墨：高亮底色配白字在夜间会发灰、刺眼 */
  ${DK} .ptx-btn.is-primary:hover,
  ${DK} .ptx-foot-btn.is-core,
  ${DK} .ptx-foot-btn.is-core:hover,
  ${DK} .ptx-pill-core { color: #0b1710; }
  /* 夜间危险色压暗一档，保证白字可读，仍是柔和朱红而非鲜红 */
  ${DK} .ptx-btn.is-danger-solid { color: #fdf3f5; background: #9c3b4c; border-color: #b45263; }
  ${DK} .ptx-btn.is-danger-solid:hover { background: #ad4658; border-color: #c06070; }
  ${DK} .ptx-btn.is-danger-solid:active { background: #8f3545; }
  ${DK} .ptx-winctl-btn.is-close:hover { background: #9c3b4c; border-color: #b45263; }
  ${DK} .ptx-winctl-btn.is-close:active { background: #8f3545; border-color: #7c2e3d; }
  ${DK} .ptx-rich-forward-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); }
  ${DK} .ptx-rich-lightbox::backdrop { background: rgba(10, 11, 13, 0.72); }
  ${DK} .ptx-bar { background: rgba(255, 255, 255, 0.1); }
  ${DK} .ptx-theme .ptx-ico-sun { display: block; }
  ${DK} .ptx-theme .ptx-ico-moon { display: none; }


  /* ===== 阅读区重整：相关线索 / 附录 / 名词注 / 内联昵称 ===== */
  ${S} .ptx-node.is-inline { font-size: 0.92em; line-height: 1.5; padding: 0 6px; margin: 0 2px; border-radius: 4px; font-weight: 600; white-space: nowrap; }

  ${S} .ptx-related { display: flex; flex-direction: column; gap: 0; max-width: 72ch; margin: 0; padding: 0; border-top: 1px solid var(--hairline); background: transparent; }
  ${S} .ptx-link { -webkit-appearance: none; appearance: none; display: grid; grid-template-columns: 22px minmax(0, 1fr) 14px; align-items: start; column-gap: 10px; width: 100%; margin: 0; padding: 9px 6px 9px 2px; border: 0; border-bottom: 1px solid var(--hairline); border-radius: 0; background: transparent; box-shadow: none; font: inherit; text-align: left; color: inherit; cursor: pointer; transition: background-color 0.16s var(--ease-organic); }
  ${S} .ptx-link:last-child { border-bottom: 0; }
  ${S} button.ptx-link:hover, ${S} button.ptx-link:focus-visible { background: var(--surface-mint); border-radius: 6px; outline: none; }
  ${S} button.ptx-link:hover .ptx-link-title, ${S} button.ptx-link:focus-visible .ptx-link-title { color: var(--bio-primary-strong); }
  ${S} button.ptx-link:hover .ptx-link-go, ${S} button.ptx-link:focus-visible .ptx-link-go { color: var(--bio-primary); opacity: 1; transform: translateX(2px); }
  ${S} .ptx-link-no { padding-top: 1px; font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.04em; color: var(--bio-primary-strong); font-variant-numeric: tabular-nums; }
  ${S} .ptx-link-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  ${S} .ptx-link-title { font-size: 13px; line-height: 1.5; font-weight: 600; color: var(--bio-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  ${S} .ptx-link-sum { font-size: 11.5px; line-height: 1.55; color: var(--bio-ink-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  ${S} .ptx-link-go { align-self: center; color: var(--bio-ink-4); opacity: 0.5; transition: color 0.16s var(--ease-organic), opacity 0.16s var(--ease-organic), transform 0.16s var(--ease-organic); }
  ${S} .ptx-link.is-missing { grid-template-columns: 22px minmax(0, 1fr) auto; cursor: default; opacity: 0.55; }
  ${S} .ptx-link.is-missing .ptx-link-title { font-weight: 500; color: var(--bio-ink-3); }
  ${S} .ptx-link-flag { align-self: center; margin-left: 6px; padding: 0 5px; border: 1px solid var(--hairline); border-radius: var(--r-tag); font-family: var(--bio-mono); font-size: 10px; color: var(--bio-ink-4); white-space: nowrap; }
  ${S} .ptx-related-more { margin-top: 0; border-top: 1px solid var(--hairline); }
  ${S} .ptx-related-more > summary { display: flex; align-items: center; gap: 8px; padding: 9px 6px 9px 2px; font-family: var(--bio-mono); font-size: 11px; color: var(--bio-ink-3); list-style: none; cursor: pointer; }
  ${S} .ptx-related-more > summary::-webkit-details-marker { display: none; }
  ${S} .ptx-related-more > summary::after { content: "＋"; margin-left: auto; color: var(--bio-ink-4); }
  ${S} .ptx-related-more[open] > summary::after { content: "－"; }
  ${S} .ptx-related-more > .ptx-related { border-top: 0; }

  /* 主题时间轴：左侧一条发丝竖线 + 节点圆点；等宽日期、13px/600 可点击标题、一句贡献。
     延续相关线索的安静分隔语法，不做卡片堆叠。 */
  ${S} .ptx-timeline { list-style: none; margin: 0; padding: 0; max-width: 72ch; }
  ${S} .ptx-tl { position: relative; padding: 0 0 15px 20px; }
  ${S} .ptx-tl:last-child { padding-bottom: 0; }
  ${S} .ptx-tl::before { content: ""; position: absolute; left: 3px; top: 0; bottom: 0; width: 1px; background: var(--hairline-strong); }
  ${S} .ptx-tl:last-child::before { bottom: auto; height: 12px; }
  ${S} .ptx-tl-dot { position: absolute; left: 0; top: 5px; width: 7px; height: 7px; border-radius: 50%; background: var(--bio-cyan); box-shadow: 0 0 0 2px var(--bg-membrane); }
  ${S} .ptx-tl-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  ${S} .ptx-tl-date { font-family: var(--bio-mono); font-size: 10.5px; line-height: 1.4; letter-spacing: 0.02em; color: var(--bio-ink-4); font-variant-numeric: tabular-nums; }
  ${S} .ptx-tl-title { -webkit-appearance: none; appearance: none; display: inline; align-self: flex-start; max-width: 100%; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; font: inherit; font-size: 13px; line-height: 1.5; font-weight: 600; color: var(--bio-ink); text-align: left; cursor: pointer; transition: color 0.16s var(--ease-organic); }
  ${S} button.ptx-tl-title:hover, ${S} button.ptx-tl-title:focus-visible { color: var(--bio-primary-strong); outline: none; }
  ${S} span.ptx-tl-title { cursor: default; color: var(--bio-ink-2); font-weight: 500; }
  ${S} .ptx-tl-note { margin: 2px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--bio-ink-4); text-shadow: none; }

  ${S} .ptx-appendix { margin-top: 18px; border: 0; border-top: 1px solid var(--hairline); border-radius: 0; background: transparent; box-shadow: none; }
  ${S} .ptx-appendix > summary { display: flex; align-items: center; gap: 8px; padding: 11px 2px; font-family: var(--bio-mono); font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em; color: var(--bio-primary-strong); list-style: none; cursor: pointer; }
  ${S} .ptx-appendix > summary::-webkit-details-marker { display: none; }
  ${S} .ptx-appendix > summary::after { content: "＋"; margin-left: auto; font-family: var(--bio-ui); font-size: 13px; color: var(--bio-ink-4); }
  ${S} .ptx-appendix[open] > summary::after { content: "－"; }
  ${S} .ptx-appendix .ptx-points, ${S} .ptx-appendix .ptx-quotes { padding: 0; }
  ${S} .ptx-app-h { margin: 18px 0 2px; padding-top: 12px; border-top: 1px solid var(--hairline); font-family: var(--bio-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--bio-secondary); }

  ${S} .ptx-points { counter-reset: point; display: block; }
  ${S} .ptx-point { counter-increment: point; position: relative; display: flex; flex-direction: column; gap: 6px; padding: 12px 0 12px 30px; border: 0; border-bottom: 1px solid var(--hairline); border-radius: 0; background: transparent; box-shadow: none; }
  ${S} .ptx-point:last-child { border-bottom: 0; }
  ${S} .ptx-point::before { content: counter(point, decimal-leading-zero); position: absolute; left: 0; top: 14px; font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.03em; color: var(--bio-primary-strong); }
  ${S} .ptx-point-view { font-size: 13.5px; font-weight: 650; line-height: 1.55; color: var(--bio-ink); }
  ${S} .ptx-voice { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
  ${S} .ptx-voice-l { min-width: 24px; font-family: var(--bio-mono); font-size: 9.5px; letter-spacing: 0.06em; color: var(--bio-ink-4); }
  ${S} .ptx-voice.is-support .ptx-voice-l { color: rgba(10, 124, 58, 0.8); }
  ${S} .ptx-voice.is-dissent .ptx-voice-l { color: rgba(138, 91, 22, 0.85); }
  ${S} .ptx-point-line { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 8px; font-size: 12.5px; line-height: 1.7; color: var(--bio-ink-2); text-shadow: none; }
  ${S} .ptx-point-line b { margin: 0; padding-top: 2px; font-family: var(--bio-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.04em; color: var(--bio-ink-4); }

  ${S} .ptx-quotes { display: block; }
  /* 教科书式引诗：去掉竖线，整段居中，以留白与引号承担引用层级 */
  ${S} .ptx-quote { padding: 10px 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; text-align: center; }

  ${S} .ptx-quote-t { font-size: 13px; line-height: 1.8; color: var(--bio-ink-2); text-align: center; }
  ${S} .ptx-quote-a { margin-top: 8px; font-family: var(--bio-mono); font-size: 10.5px; color: rgba(138, 91, 22, 0.9); text-align: center; }

  ${S} .ptx-gloss { max-width: 72ch; margin: 0; padding: 0; }
  ${S} .ptx-gloss-row { display: grid; grid-template-columns: minmax(64px, 104px) minmax(0, 1fr); align-items: start; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--hairline); font-size: 13px; line-height: 1.7; }
  ${S} .ptx-gloss-row:first-child { border-top: 1px solid var(--hairline); }
  ${S} .ptx-gloss-row dt { margin: 0; font-size: 12.5px; font-weight: 650; color: var(--bio-primary-strong); }
  ${S} .ptx-gloss-row dd { margin: 0; color: var(--bio-ink-2); text-shadow: none; }
  ${S} .ptx-window.is-narrow .ptx-gloss-row { grid-template-columns: 1fr; gap: 2px; }


  /* 最终一致性：内联昵称略放大；落点改为无卡片的双栏发丝线结构 */
  ${S} .ptx-node.is-inline { font-size: 0.95em; padding: 0 7px; line-height: 1.5; }
  ${S} .ptx-outcome { gap: 24px; padding-top: 2px; }
  ${S} .ptx-outcome-col { padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  ${S} .ptx-outcome-l { margin-bottom: 6px; font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.06em; color: var(--bio-ink-3); }
  ${S} .ptx-outcome-col.is-consensus .ptx-outcome-l { color: var(--bio-primary-strong); }
  ${S} .ptx-outcome-col.is-open .ptx-outcome-l { color: var(--bio-violet-strong); }

  /* 争点对照：真正的表格，便于横向对照；表头固定、单元格自动换行 */
  ${S} .ptx-table-wrap { width: 100%; overflow-x: auto; }
  ${S} .ptx-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; line-height: 1.65; }
  ${S} .ptx-table th { padding: 7px 8px; text-align: left; font-family: var(--bio-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em; color: var(--bio-slate); border-bottom: 1px solid var(--hairline-strong); white-space: nowrap; }
  ${S} .ptx-table td { padding: 10px 8px; vertical-align: top; border-bottom: 1px solid var(--hairline); color: var(--bio-ink-2); overflow-wrap: anywhere; }
  ${S} .ptx-table tbody tr:last-child td { border-bottom: 0; }
  ${S} .ptx-table th:nth-child(1) { width: 26px; }
  ${S} .ptx-table th:nth-child(2) { width: 24%; }
  ${S} .ptx-table th:nth-child(3), ${S} .ptx-table th:nth-child(4) { width: 16%; }
  ${S} .ptx-table th:nth-child(5), ${S} .ptx-table th:nth-child(6) { width: 21%; }
  ${S} .ptx-table td:nth-child(1) { padding-left: 0; }
  ${S} .ptx-table td:nth-child(6) { padding-right: 0; }
  ${S} .ptx-td-no { font-family: var(--bio-mono); font-size: 10px; letter-spacing: 0.03em; color: var(--bio-primary-strong); font-variant-numeric: tabular-nums; }
  ${S} .ptx-td-view { font-weight: 600; color: var(--bio-ink); }
  ${S} .ptx-td-side .ptx-node { display: inline-flex; margin: 0 4px 4px 0; padding: 0 6px; font-size: 10.5px; line-height: 1.6; }
  ${S} .ptx-td-body { font-size: 11.5px; line-height: 1.7; }
  ${S} .ptx-td-empty { color: var(--bio-ink-4); }

  /* 对照表转置：属性竖排、观点横排；只保留表头一条横线 */
  ${S} .ptx-table.ptx-compare thead th { padding: 8px 10px; border-bottom: 1px solid var(--hairline); }
  ${S} .ptx-table.ptx-compare thead th:first-child { width: 64px; padding-left: 0; }
  ${S} .ptx-table.ptx-compare thead th:not(:first-child) { width: auto; }
  ${S} .ptx-table.ptx-compare tbody th { width: 64px; padding: 11px 8px; text-align: center; vertical-align: top; font-family: var(--bio-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em; color: var(--bio-ink-3); border: 0; }
  ${S} .ptx-table.ptx-compare tbody td { padding: 11px 10px; vertical-align: top; border: 0; color: var(--bio-ink-2); }
  ${S} .ptx-table.ptx-compare tbody tr:first-child td, ${S} .ptx-table.ptx-compare tbody tr:first-child th { padding-top: 12px; }
  ${S} .ptx-table.ptx-compare tbody tr:last-child td, ${S} .ptx-table.ptx-compare tbody tr:last-child th { padding-bottom: 16px; }
  ${S} .ptx-table.ptx-compare .ptx-td-view { font-size: 12.5px; line-height: 1.6; }
  ${S} .ptx-table.ptx-compare .ptx-td-body { font-size: 11.5px; line-height: 1.7; }

  /* 横线收敛：列表、名词注、摘句、附录小标题不再逐行画线 */
  ${S} .ptx-link { padding: 10px 8px; border-bottom: 0; border-radius: 6px; }
  ${S} .ptx-related-more { border-top: 0; }
  ${S} .ptx-gloss-row { padding: 9px 0; border-top: 0 !important; border-bottom: 0; }
  ${S} .ptx-quote { border-bottom: 0; }
  ${S} .ptx-app-h { margin: 16px 0 4px; padding-top: 0; border-top: 0; }

  /* 正文占满版心并水平居中；段落首行缩进两字 */
  ${S} .ptx-lead, ${S} .ptx-cause, ${S} .ptx-narrative, ${S} .ptx-gloss, ${S} .ptx-related, ${S} .ptx-outcome { width: 100%; max-width: none; margin-left: 0; margin-right: 0; }
  ${S} .ptx-narrative p { text-indent: 2em; }

  /* 附录小标题不再单独画线；只保留附录顶线与表头线 */
  ${S} .ptx-app-h { border: 0 !important; }
  ${S} .ptx-quotes { border-top: 0 !important; }

  /* 争点对照：轻量网格边框 + 全部左对齐（内容不再居中） */
  ${S} .ptx-table.ptx-compare {
    border: 1px solid var(--hairline);
    border-collapse: separate;
    border-spacing: 0;
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
    text-align: left;
  }
  ${S} .ptx-table.ptx-compare th,
  ${S} .ptx-table.ptx-compare td { text-align: left; }
  ${S} .ptx-table.ptx-compare thead th {
    background: transparent;
    border-bottom: 1px solid var(--hairline-strong);
  }
  ${S} .ptx-table.ptx-compare thead th + th { border-left: 1px solid var(--hairline); }
  ${S} .ptx-table.ptx-compare tbody th {
    background: transparent;
    border-right: 1px solid var(--hairline);
  }
  ${S} .ptx-table.ptx-compare tbody td + td { border-left: 1px solid var(--hairline); }
  ${S} .ptx-table.ptx-compare tbody tr:not(:last-child) > th,
  ${S} .ptx-table.ptx-compare tbody tr:not(:last-child) > td { border-bottom: 1px solid var(--hairline); }

  /* 表头与行首属性标签居中，内容左对齐 */
  ${S} .ptx-table.ptx-compare thead th,
  ${S} .ptx-table.ptx-compare tbody th { text-align: center; }
  ${S} .ptx-table.ptx-compare tbody td { text-align: left; }
  @media (max-width: 780px) {
    ${S}.ptx-window { width: calc(100vw - 24px); height: calc(100vh - 48px); }
  }

  @media (max-width: 560px) {
    ${S}.ptx-pill { right: 14px; bottom: 96px; }
  }

  @media (prefers-reduced-motion: reduce) {
    ${S}* { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
  }
${overlay ? `
  ${scope}.ptx-hidden { display: none; }
  ${S}.ptx-window,
  ${S}.ptx-pill,
  ${S}.ptx-toast { pointer-events: auto; }
` : ''}`.trim();
}
