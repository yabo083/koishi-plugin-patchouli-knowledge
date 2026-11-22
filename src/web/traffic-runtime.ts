import { richMessageRuntime } from './rich-message-runtime';

/**
 * 三端共用的局部监控更新器。宿主仅提供 DOM、格式化和状态读取函数。
 *
 * 渲染顺序契约：消息流量图表 → 当前群最新消息 → 指标磁贴。
 * 触发器门限（突发倍率 / 平息等待）不在这条时间线上：它们是配置而不是观测，
 * 统一收在设置页（settingsHtml）的「触发器门限」分区，监控页只保留仪表盘。
 * 最新消息横条由 `richMessageRuntime()` 提供，按指纹增量更新（同一消息绝不重建 DOM）。
 */
export function trafficRuntime(): string {
  return String.raw`
  var trafficFrame = 0;
  var trafficAnchor = 0;
  var trafficReceived = 0;
  var trafficPoints = [];
  var trafficScale = 10;
  var trafficChannel = "";

  var trafficLastFrame = 0;
  var trafficLastSecond = -1;
  function metricsHtml() {
    return head("消息监控", "") +
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

  function updateMetrics() {
    var root = monitorViewport();
    if (!root || !root.querySelector('[data-traffic-summary]')) return;
    var status = state.status;
    if (!status) {
      if (trafficChannel && trafficChannel !== channelScopeId()) {
        trafficText('.ptx-vhead-sub', '群聊 ' + channelScopeId());
        trafficText('[data-message-author]', '');
        trafficText('[data-message-time]', '');
        resetLatestMessage();
        for (var index = 0; index < 4; index += 1) trafficText('[data-metric="' + index + '"]', '—');
      }
      trafficText('.ptx-monitor-status', state.statusChecked ? '连接中断，保留最后一次数据' : '正在连接监控服务');
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

  function resumeTraffic() {
    var root = monitorViewport();
    if (document.hidden || !root || !root.isConnected || state.stage !== 'metrics' || state.collapsed) return;
    loadStatus().then(function () { refreshPhase(); updateMetrics(); });
  }
  document.addEventListener('visibilitychange', resumeTraffic);
${richMessageRuntime()}`;
}
