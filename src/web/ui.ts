/**
 * Patchouli Knowledge - LLMWiki 知识阅读器独立页面 (/patchouli)
 * 材质：有机未来主义（瓷白 / 肤白 #f7f5f0 生物膜 / 双倒角高光边 / 双生物荧光漫射 /
 *       葱绿 #0ea44f 主波长荧光 / 深海青 #0e8f86 / 琥珀孢子 #b8791e 作辅色）。
 * 结构：细胞膜脊柱 Rail（纯图标囊泡按键）+ 主视窗；说明文字全部收进 hover 浮层。
 * 交互：视口内自由拖拽、静置 5 秒收回呼吸胶囊、胶囊点击展开、两个核心页签全部就地切换，绝不跳转。
 * 红线：零 Emoji，100% 内联 SVG 矢量图标，零外部资源。
 */

import { authBootstrap } from './auth-bootstrap';
import { organicMarkup, organicRuntime } from './organic-runtime';
import { organicStyles } from './organic-style';

const PREFIX = 'ptx';

export function renderLibraryHtml(basePath = '/patchouli'): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLMWiki 知识阅读器</title>
<style>
${organicStyles('', 'page', PREFIX)}
</style>
</head>
<body>
${organicMarkup(PREFIX)}

<script>
${authBootstrap(basePath)}
window.__ptxAuth && window.__ptxAuth.gate();
${organicRuntime({ basePath, prefix: PREFIX, mode: 'page' })}
</script>
</body>
</html>`;
}
