#!/usr/bin/env node
/**
 * 生成 `docs/mascot-tuner.html`：词条长图 + 一个可调面板，用来现场微调看板娘的位置 / 大小 / 边缘渐变，
 * 调好后把 JSON 交回代理固化进 `src/plugin/card.ts`。
 *
 * 用法：
 *   node scripts/build-mascot-tuner.mjs <entry.md> [backdrop.jpg] [out.html]
 *     entry.md    一篇真实词条（长一点更好，能同时看到半身像与读书图与文字的遮挡关系）
 *     backdrop    可选：素材池底图（JPEG/PNG），会压到 820px 内联；省略则无底图
 *     out         默认 docs/mascot-tuner.html
 *
 * 面板参数存 `localStorage['patchouli-mascot-tune']`（file:// 同源共享），页面里也有 JSON 预览可直接复制。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderEntryLongImageHtml } from '../lib/plugin/card.js';
import { toPublicView } from '../lib/wiki/public-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const [entryPath, backdropPath, outArg] = process.argv.slice(2);
if (entryPath === undefined) {
  console.error('用法: node scripts/build-mascot-tuner.mjs <entry.md> [backdrop.jpg] [out.html]');
  process.exit(1);
}
const out = resolve(repo, outArg ?? 'docs/mascot-tuner.html');

const backdrop = backdropPath === undefined
  ? ''
  : execFileSync(
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

const id = entryPath.replace(/\\/g, '/').split('/').pop().replace(/\.md$/u, '');
const markdown = readFileSync(entryPath, 'utf8');
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
const html = renderEntryLongImageHtml(view, {
  width: 720,
  backdrop,
  saying: '上層は賢能に納め、収束は時に至る。',
  index: 1,
});

const styleOf = (h) => (/<style>[\s\S]*?<\/style>/u.exec(h) ?? [''])[0];
const mainOf = (h) => (/<main class="sheet">[\s\S]*?<\/main>/u.exec(h) ?? [''])[0];

// 面板与接线全部在页内，和 card.ts 的当前常量保持一致——DEFAULTS 即现状，「重置」回到现状。
const TUNER = `(() => {
const DEFAULTS = {
  bust:    { top: 21, right: -17, width: 603, opacity: 1, cx: 450, cy: 420, r: 420, hem: 0.84, blur: 30, coreMid: 0.54, coreOuter: 0.79, outerOp: 0.39, haloOp: 0.27 },
  reading: { bottom: -52, left: -43, width: 505, opacity: 0.52, cx: 132, cy: 452, r: 269, hem: 0.63, blur: 18.5, coreMid: 0.57, coreOuter: 0.83, outerOp: 0.2, haloOp: 0.26 },
};
const DIMS = { bust: { w: 880, h: 876 }, reading: { w: 620, h: 669 } };
const KEY = 'patchouli-mascot-tune-v2';
let cfg;
try { cfg = JSON.parse(localStorage.getItem(KEY)) || structuredClone(DEFAULTS); }
catch { cfg = structuredClone(DEFAULTS); }
for (const k of Object.keys(DEFAULTS)) cfg[k] = Object.assign({}, DEFAULTS[k], cfg[k]);

const $ = (sel, root) => (root ?? document).querySelector(sel);
const sheet = $('main.sheet');

function apply() {
  for (const key of ['bust', 'reading']) {
    const c = cfg[key], d = DIMS[key];
    const svg = document.querySelector('svg.mascot-' + key);
    if (!svg) continue;
    svg.style.width = c.width + 'px';
    svg.style.opacity = c.opacity;
    if (key === 'bust') { svg.style.top = c.top + 'px'; svg.style.right = c.right + 'px'; }
    else { svg.style.bottom = c.bottom + 'px'; svg.style.left = c.left + 'px'; }
    const core = svg.querySelector('#core-' + key);
    core.setAttribute('cx', c.cx); core.setAttribute('cy', c.cy); core.setAttribute('r', c.r);
    const st = core.querySelectorAll('stop');
    st[1].setAttribute('offset', c.coreMid);
    st[2].setAttribute('offset', c.coreOuter);
    st[2].setAttribute('stop-opacity', c.outerOp);
    const halo = svg.querySelector('#halo-' + key);
    halo.setAttribute('cx', c.cx); halo.setAttribute('cy', c.cy); halo.setAttribute('r', c.r);
    halo.querySelector('stop').setAttribute('stop-opacity', c.haloOp);
    const hem = svg.querySelector('#hem-' + key);
    hem.setAttribute('y2', Math.round(d.h * c.hem));
    const blur = svg.querySelector('#blur-' + key + ' feGaussianBlur');
    if (blur) blur.setAttribute('stdDeviation', c.blur);
  }
  localStorage.setItem(KEY, JSON.stringify(cfg));
  $('#json').value = JSON.stringify(cfg, null, 2);
}

const DEFS = [
  ['bust', '半身像（右上）', [
    ['top', 'top', -200, 160], ['right', 'right', -200, 160], ['width', 'width', 160, 720],
    ['opacity', 'opacity', 0, 1, 0.01],
    ['cx', 'mask cx', 0, 880], ['cy', 'mask cy', 0, 876], ['r', 'mask r', 60, 880],
    ['coreMid', '芯收起点', 0.1, 0.9, 0.01], ['coreOuter', '芯收束点', 0.3, 1, 0.01],
    ['outerOp', '外缘残光', 0, 0.6, 0.01], ['haloOp', '光晕强度', 0, 0.6, 0.01],
    ['hem', '下缘化开(高)', 0.2, 0.95, 0.01], ['blur', '光晕模糊', 2, 40, 0.5],
  ]],
  ['reading', '读书图（左下）', [
    ['bottom', 'bottom', -260, 80], ['left', 'left', -260, 160], ['width', 'width', 120, 620],
    ['opacity', 'opacity', 0, 1, 0.01],
    ['cx', 'mask cx', 0, 620], ['cy', 'mask cy', 0, 669], ['r', 'mask r', 60, 620],
    ['coreMid', '芯收起点', 0.1, 0.9, 0.01], ['coreOuter', '芯收束点', 0.3, 1, 0.01],
    ['outerOp', '外缘残光', 0, 0.6, 0.01], ['haloOp', '光晕强度', 0, 0.6, 0.01],
    ['hem', '下缘化开(高)', 0.2, 0.95, 0.01], ['blur', '光晕模糊', 2, 40, 0.5],
  ]],
];

const panel = document.createElement('aside');
panel.id = 'tuner';
panel.innerHTML = '<h2>MASCOT TUNER</h2>' +
  DEFS.map(([key, title, rows]) =>
    '<fieldset><legend>' + title + '</legend>' +
    rows.map(([name, label, min, max, step]) =>
      '<label>' + label +
      '<input type="range" data-k="' + key + '" data-n="' + name + '" min="' + min + '" max="' + max +
      '" step="' + (step ?? 1) + '"><output></output></label>').join('') +
    '</fieldset>').join('') +
  '<div class="row"><button id="reset">重置为现状</button><button id="copy">复制 JSON</button></div>' +
  '<textarea id="json" readonly rows="14"></textarea>';
document.body.appendChild(panel);

panel.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.tagName !== 'INPUT') return;
  cfg[el.dataset.k][el.dataset.n] = Number(el.value);
  el.nextElementSibling.textContent = el.value;
  apply();
});
$('#reset').addEventListener('click', () => {
  cfg = structuredClone(DEFAULTS);
  panel.querySelectorAll('input[type=range]').forEach((el) => {
    el.value = cfg[el.dataset.k][el.dataset.n];
    el.nextElementSibling.textContent = el.value;
  });
  apply();
});
$('#copy').addEventListener('click', () => { $('#json').select(); document.execCommand('copy'); });

panel.querySelectorAll('input[type=range]').forEach((el) => {
  el.value = cfg[el.dataset.k][el.dataset.n];
  el.nextElementSibling.textContent = el.value;
});
apply();
})();`;

const shell = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>看板娘调参 · ${id}</title>
${styleOf(html)}
<style>
  body{padding:34px 360px 56px 0;background:#05060c}
  .demo{display:flex;flex-direction:column;align-items:center;gap:34px}
  .demo-label{width:720px;font:11px ui-monospace,monospace;letter-spacing:.18em;color:#8b93c9}
  #tuner{position:fixed;top:0;right:0;bottom:0;width:330px;overflow-y:auto;background:#0b0d16;
    border-left:1px solid #262a3d;padding:14px 16px;font:12px/1.5 ui-monospace,Consolas,monospace;
    color:#c9cfee;z-index:99}
  #tuner h2{font-size:12px;letter-spacing:.2em;color:#8b93c9;margin:0 0 10px}
  #tuner fieldset{border:1px solid #262a3d;border-radius:8px;margin:0 0 12px;padding:8px 10px 10px}
  #tuner legend{color:#8b93c9;padding:0 6px}
  #tuner label{display:grid;grid-template-columns:86px 1fr 42px;align-items:center;gap:8px;margin:4px 0}
  #tuner input[type=range]{width:100%;accent-color:#7c6cf0}
  #tuner output{text-align:right;color:#e6e9ff}
  #tuner .row{display:flex;gap:8px;margin:6px 0}
  #tuner button{flex:1;background:#1b1f31;border:1px solid #343a58;color:#c9cfee;border-radius:6px;
    padding:6px 0;cursor:pointer;font:inherit}
  #tuner button:hover{background:#262c46}
  #tuner textarea{width:100%;box-sizing:border-box;background:#070910;border:1px solid #262a3d;
    color:#9fe0a8;border-radius:6px;font:10px/1.4 ui-monospace,monospace;padding:6px;resize:vertical}
</style>
</head>
<body>
<div class="demo">
<div class="demo-label">${id}（调完点「复制 JSON」或直接告诉我「好了」）</div>
${mainOf(html)}
</div>
<script>${TUNER}</script>
</body>
</html>`;

writeFileSync(out, shell, 'utf8');
console.log(view.title.slice(0, 30), '| written', out, shell.length, 'bytes');
