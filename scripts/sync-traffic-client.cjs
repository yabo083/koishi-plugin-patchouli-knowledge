// 在 tsc 后生成 Console 客户端监控片段，与独立页共用同一更新器和绘图函数。
const fs = require('node:fs');
const path = require('node:path');
const { trafficRuntime } = require('../lib/web/traffic-runtime.js');
const { authBootstrap } = require('../lib/web/auth-bootstrap.js');
const { buildTrafficPath } = require('../lib/web/organic.js');
const file = path.resolve(__dirname, '../client/dist/index.js');
const source = fs.readFileSync(file, 'utf8');
const begin = '// BEGIN GENERATED TRAFFIC RUNTIME';
const end = '// END GENERATED TRAFFIC RUNTIME';
const start = source.indexOf(begin);
const stop = source.indexOf(end, start);
if (start < 0 || stop < 0) throw new Error('Console traffic runtime generation markers missing');
const runtime = trafficRuntime()
  .replaceAll('IDS.tuneBurst', "'ptxClientTuneBurst'")
  .replaceAll('IDS.tuneQuiet', "'ptxClientTuneQuiet'")
  .replaceAll('head(', 'renderHead(')
  .replaceAll('svg(', 'organicIcon(')
  .replace('function metricsHtml()', 'function renderMetrics()');
const generated = begin + '\n' + buildTrafficPath.toString() + '\nfunction monitorViewport() { return viewportEl; }\n' + runtime + '\n';
let next = source.slice(0, start) + generated + source.slice(stop);

// 门禁块：Console 组件与独立页面共用同一份生成物（客户端产物里没有它，浮窗就不会弹模态）。
const gateBegin = '// BEGIN GENERATED AUTH GATE';
const gateEnd = '// END GENERATED AUTH GATE';
const gateStart = next.indexOf(gateBegin);
const gateStop = next.indexOf(gateEnd, gateStart);
if (gateStart < 0 || gateStop < 0) throw new Error('Console auth gate generation markers missing');
const gate = gateBegin + '\n' + authBootstrap('/patchouli') + '\n';
next = next.slice(0, gateStart) + gate + next.slice(gateStop);
fs.writeFileSync(file, next);
