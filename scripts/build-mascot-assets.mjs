#!/usr/bin/env node
/**
 * 生成 `src/plugin/mascot-assets.ts`：把看板娘位图预处理成 WebP 并内联为 data URI。
 *
 * 为什么内联而不是丢文件：
 *  - 词条长图由 puppeteer `setContent()` 渲染，HTML 字符串里没有可加载的 baseURL，
 *    任何外部 `src` 都会在截图时变成空白；内联 data URI 是唯一自包含的形态。
 *  - 目标宿主是单文件插件包，附带二进制还要处理打包/路径，内联省掉一整条发布链路。
 *
 * 用法：
 *   node scripts/build-mascot-assets.mjs <reading.png> <bust.png>
 * 输入：两张带 alpha 的 PNG（原始素材不入库，仓库只保留生成物）。
 * 输出：`src/plugin/mascot-assets.ts`（导出 MASCOT_READING / MASCOT_BUST 两个 data URI）。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

/** 显示尺寸（CSS px）；导出倍率是 2，故位图宽度取两倍。 */
const SPECS = [
  { key: 'MASCOT_READING', file: process.argv[2], width: 620, quality: 82 },
  { key: 'MASCOT_BUST', file: process.argv[3], width: 880, quality: 82 },
];

if (SPECS.some((spec) => typeof spec.file !== 'string' || spec.file === '')) {
  console.error('用法: node scripts/build-mascot-assets.mjs <reading.png> <bust.png>');
  process.exit(1);
}

const py = `
import base64, io, sys
from PIL import Image, ImageFilter

specs = ${JSON.stringify(SPECS.map(({ key, file, width, quality }) => ({ key, file, width, quality })))}
for spec in specs:
    im = Image.open(spec['file']).convert('RGBA')
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    ratio = spec['width'] / im.width
    im = im.resize((spec['width'], max(1, round(im.height * ratio))), Image.LANCZOS)
    # 抠图残留：边缘一圈极低 alpha 的品红/紫，直接放在深色卡上就是一道硬边。
    # 原始素材里有一块「不透明的背景补丁」，其左/上边界是直线剪切。羽化 22px 把这条切线摊成渐变，
    # 模板里的径向遮罩再负责把整块收进版面。
    alpha = im.getchannel('A').point(lambda v: 0 if v < 26 else (255 if v > 214 else round((v - 26) * 255 / 188)))
    alpha = alpha.filter(ImageFilter.GaussianBlur(22))
    im.putalpha(alpha)
    buf = io.BytesIO()
    im.save(buf, format='WEBP', quality=spec['quality'], method=6)
    data = base64.b64encode(buf.getvalue()).decode('ascii')
    print(f"{spec['key']}\\t{im.width}x{im.height}\\t{len(data)}")
    with open(f"{spec['key']}.b64", 'w', encoding='ascii') as fh:
        fh.write(data)
`;

const out = execFileSync('python', ['-c', py], { cwd: repo, encoding: 'utf8' });
const rows = out
  .trim()
  .split('\n')
  .map((line) => line.split('\t'));
console.log(out.trim());

const header = `/**
 * 看板娘素材（生成物，勿手改）。
 *
 * 由 \`scripts/build-mascot-assets.mjs\` 从两张带 alpha 的 PNG 生成：
 *   - MASCOT_READING：帕秋莉在书架前读书（页面底部左侧水印）
 *   - MASCOT_BUST：帕秋莉半身像，带月光与蝶形群（标题区右侧）
 *
 * 形态是 WebP 的 data URI，直接喂给内联 \`<svg><image href="…">\`：长图由 puppeteer
 * \`setContent()\` 渲染，HTML 里没有可加载的外部资源，只有内联才能保证截图不为空。
 * 重新生成：\`node scripts/build-mascot-assets.mjs <reading.png> <bust.png>\`
 */

`;

const body = rows
  .map(([key, size, chars]) => {
    const data = execFileSync('python', ['-c', `print(open("${key}.b64", encoding="ascii").read(), end="")`], {
      cwd: repo,
      encoding: 'utf8',
    });
    execFileSync('python', ['-c', `import os; os.remove("${key}.b64")`], { cwd: repo });
    return `/** ${size}，base64 ${chars} 字符 */\nexport const ${key} =\n  'data:image/webp;base64,${data}';\n`;
  })
  .join('\n');

writeFileSync(resolve(repo, 'src/plugin/mascot-assets.ts'), header + body, 'utf8');
console.log('written src/plugin/mascot-assets.ts');
