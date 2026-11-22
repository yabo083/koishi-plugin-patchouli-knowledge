#!/usr/bin/env node
/**
 * 生成 `docs/preview-cards.html`：把若干篇真实词条排成长图并拼成一页，用于人工核对版面。
 *
 * 用法：
 *   node scripts/build-card-preview.mjs <entriesDir> <backdrop.jpg> [out.html] [limit]
 *     entriesDir  含 `*.md` 词条文件的目录（脚本按文件名排序取前 limit 篇，默认 3）
 *     backdrop    素材池里的一张二次元底图（JPEG/PNG），会被压到 820px 宽再内联
 *     out         默认 docs/preview-cards.html
 * 依赖 `lib/`（先 `pnpm build`）。三张卡各自按自己的底图取色相，等价于页内 `BACKDROP_ACCENT_SNIPPET`。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderEntryLongImageHtml } from '../lib/plugin/card.js';
import { toPublicView } from '../lib/wiki/public-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const [entriesDir, backdropPath, outArg, limitArg] = process.argv.slice(2);
if (entriesDir === undefined || backdropPath === undefined) {
  console.error('用法: node scripts/build-card-preview.mjs <entriesDir> <backdrop.jpg> [out.html] [limit]');
  process.exit(1);
}
const limit = Number.parseInt(limitArg ?? '3', 10) || 3;
const out = resolve(repo, outArg ?? 'docs/preview-cards.html');

/** 底图压到 820px 宽再内联：预览页只需要看效果，不必塞原图。 */
const workDir = mkdtempSync(join(tmpdir(), 'patchouli-preview-'));
const backdrop = (() => {
  try {
    execFileSync(
      'python',
      [
        '-c',
        [
          'import base64, io, sys',
          'from PIL import Image',
          "im = Image.open(sys.argv[1]).convert('RGB')",
          'im = im.resize((820, max(1, round(im.height * 820 / im.width))), Image.LANCZOS)',
          'buf = io.BytesIO()',
          "im.save(buf, format='JPEG', quality=72, optimize=True, progressive=True)",
          "sys.stdout.write('data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode('ascii'))",
        ].join('\n'),
        backdropPath,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
})();

const SAYING = '上層は賢能に納め、収束は時に至る。';
const files = readdirSync(entriesDir)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .slice(0, limit);

const pages = files.map((name, index) => {
  const id = name.slice(0, -'.md'.length);
  const markdown = readFileSync(join(entriesDir, name), 'utf8');
  const record = {
    id,
    title: '',
    channelId: '',
    date: '',
    status: 'tentative',
    tags: [],
    summary: '',
    metadata: { messageCount: 0, participantCount: 0, durationMinutes: 0, peakRate: 0 },
    path: '',
    createdAt: 0,
    updatedAt: 0,
  };
  const view = toPublicView(record, markdown);
  return { id, view, html: renderEntryLongImageHtml(view, { width: 720, backdrop, saying: SAYING, index: index + 1 }) };
});

const styleOf = (html) => (/<style>[\s\S]*?<\/style>/u.exec(html) ?? [''])[0];
const mainOf = (html) => (/<main class="sheet">[\s\S]*?<\/main>/u.exec(html) ?? [''])[0];

/** 逐卡取色：每张卡按自己的底图算主峰色相（原页内脚本只处理 document.body，多卡会互相覆盖）。 */
const HUE = `(() => {
  const shade = (sheet) => {
    const img = sheet.querySelector('.backdrop-img');
    if (!img || !img.naturalWidth) return;
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return;
    g.drawImage(img, 0, 0, S, S);
    const d = g.getImageData(0, 0, S, S).data, bins = new Float64Array(360);
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
    if (bins[best] > 0) sheet.style.setProperty('--pk-accent-h', String(best));
  };
  const run = () => [...document.querySelectorAll('main.sheet')].forEach(shade);
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();`;

const shell = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>词条长图 · 看板娘 + 素材池底图（${pages.length} 例真实词条）</title>
${styleOf(pages[0].html)}
<style>
  body{padding:34px 0 56px;background:#05060c}
  .demo{display:flex;flex-direction:column;align-items:center;gap:34px}
  .demo-label{width:720px;font:11px ui-monospace,monospace;letter-spacing:.18em;color:#8b93c9}
</style>
</head>
<body>
<div class="demo">
${pages.map((page) => `<div class="demo-label">${page.id}</div>${mainOf(page.html)}`).join('\n')}
</div>
<script>${HUE}</script>
</body>
</html>`;

writeFileSync(out, shell, 'utf8');
for (const page of pages) console.log(page.id, '|', page.view.title.slice(0, 24));
console.log('written', out, shell.length, 'bytes');
