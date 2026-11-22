/**
 * Patchouli Knowledge - LLMWiki 知识阅读器内嵌面板 (Console 配置页 / 独立组件)
 * 材质：有机未来主义（瓷白 / 肤白 #f7f5f0 生物膜 / 双倒角高光边 / 双生物荧光漫射 /
 *       葱绿 #0ea44f 主波长荧光 / 深海青 #0e8f86 / 琥珀孢子作辅色）。
 * 结构：细胞膜脊柱 Rail（纯图标囊泡按键）+ 主视窗；说明文字全部收进 hover 浮层。
 * 交互：首次拖拽转为浮动层并做视口钳制、静置 5 秒收回呼吸胶囊、胶囊点击展开、两个核心页签（词条 / 监控）就地切换。
 * 红线：零 Emoji，100% 内联 SVG 矢量图标，零外部资源，绝不新开窗口。
 */

import { authBootstrap } from './auth-bootstrap';
import { organicMarkup, organicRuntime } from './organic-runtime';
import { organicStyles } from './organic-style';

const PREFIX = 'ptxDock';
const ROOT_ID = 'ptxDockRoot';

export function renderTacticalDockComponent(basePath = '/patchouli'): string {
  return `<div id="${ROOT_ID}" class="ptx-dock-root">
${organicMarkup(PREFIX)}
</div>

<style>
${organicStyles(`#${ROOT_ID}`, 'dock', PREFIX)}
</style>

<script>
${authBootstrap(basePath)}
${organicRuntime({ basePath, prefix: PREFIX, mode: 'dock' })}
</script>`;
}
