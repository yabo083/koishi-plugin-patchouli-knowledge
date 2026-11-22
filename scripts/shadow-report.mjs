#!/usr/bin/env node
/**
 * shadow-report.mjs：读取 observability 目录下的 `shadow-*.jsonl` 持久化日志，
 * 对照 rate（频率）与 potential（势能）两套触发判据在 shadow 模式下的裁决差异，
 * 默认输出 markdown 报告，`--json` 时输出机器可读 JSON。
 *
 * 用法：
 *   node scripts/shadow-report.mjs [--dir <observability目录>] [--days N] [--channel <id>] [--json]
 *
 * 日志契约（见决策/会话两类记录）：decision 行同时带 rate / potential 两组结论与 agree；
 * session 行带 verdict（finalized|discarded）、messages、delivered。字段缺失一律按 0/null 处理。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

/** 缺省目录相对 cwd，与运行时写入侧保持一致。 */
const DEFAULT_DIR = 'data/llmwiki/.patchouli/observability';
const DAY_MS = 86_400_000;

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { dir: resolve(process.cwd(), DEFAULT_DIR), days: null, channel: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--dir') {
      opts.dir = resolve(process.cwd(), argv[++i] ?? '');
    } else if (arg === '--days') {
      opts.days = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(opts.days) || opts.days <= 0) {
        console.error(`--days 需要正整数，收到: ${argv[i] ?? '(空)'}`);
        process.exit(1);
      }
    } else if (arg === '--channel') {
      opts.channel = argv[++i] ?? null;
    } else {
      console.error(`未知参数: ${arg}`);
      console.error('用法: node scripts/shadow-report.mjs [--dir <目录>] [--days N] [--channel <id>] [--json]');
      process.exit(1);
    }
  }
  return opts;
}

/** 缺字段按 null 返回，避免 NaN 污染统计。 */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 表格里统一显示两位以内小数，null 显示为占位符。 */
function fmt(v) {
  if (v === null || v === undefined) return '—';
  return String(Math.round(v * 100) / 100);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 记录所在 UTC 日期：优先 iso 字段，缺失时退回 epoch ms。 */
function utcDateOf(rec) {
  if (typeof rec.iso === 'string' && rec.iso.length >= 10) return rec.iso.slice(0, 10);
  const at = numOrNull(rec.at);
  return at === null ? null : new Date(at).toISOString().slice(0, 10);
}

/** 把一行原始 JSON 归一成内部结构；未知 kind 返回 null 交给调用方跳过。 */
function normalize(rec) {
  if (rec === null || typeof rec !== 'object') return null;
  if (rec.kind === 'decision') {
    const rate = rec.rate ?? {};
    const potential = rec.potential ?? {};
    const rateReady = rate.ready === true;
    const potReady = potential.ready === true;
    return {
      kind: 'decision',
      at: numOrNull(rec.at),
      iso: typeof rec.iso === 'string' ? rec.iso : '',
      channelId: typeof rec.channelId === 'string' ? rec.channelId : '(unknown)',
      rateReady,
      rate: numOrNull(rate.rate),
      threshold: numOrNull(rate.threshold),
      potReady,
      quality: numOrNull(potential.quality),
      density: numOrNull(potential.density),
      rhoMin: numOrNull(potential.rhoMin),
      burstThreshold: numOrNull(potential.burstThreshold),
      // 日志自带 agree 时以它为准（它才是运行时的裁决结论），缺了才自己算。
      agree: typeof rec.agree === 'boolean' ? rec.agree : rateReady === potReady,
      triggerMode: typeof rec.triggerMode === 'string' ? rec.triggerMode : '',
      episodeId: typeof rec.episodeId === 'string' ? rec.episodeId : null,
    };
  }
  if (rec.kind === 'session') {
    return {
      kind: 'session',
      at: numOrNull(rec.at),
      iso: typeof rec.iso === 'string' ? rec.iso : '',
      channelId: typeof rec.channelId === 'string' ? rec.channelId : '(unknown)',
      verdict: rec.verdict === 'discarded' ? 'discarded' : 'finalized',
      messages: numOrNull(rec.messages),
      delivered: rec.delivered === true,
      reason: typeof rec.reason === 'string' ? rec.reason : null,
      triggerMode: typeof rec.triggerMode === 'string' ? rec.triggerMode : '',
      episodeId: typeof rec.episodeId === 'string' ? rec.episodeId : null,
    };
  }
  if (rec.kind === 'dispatch') {
    return {
      kind: 'dispatch',
      at: numOrNull(rec.at),
      iso: typeof rec.iso === 'string' ? rec.iso : '',
      channelId: typeof rec.channelId === 'string' ? rec.channelId : '(unknown)',
      sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
      success: rec.success === true,
      qualityScore: numOrNull(rec.qualityScore),
      discardReason: typeof rec.discardReason === 'string' ? rec.discardReason : null,
      failureReason: typeof rec.failureReason === 'string' ? rec.failureReason : null,
      messages: numOrNull(rec.messages),
      episodeId: typeof rec.episodeId === 'string' ? rec.episodeId : null,
      triggerMode: typeof rec.triggerMode === 'string' ? rec.triggerMode : '',
    };
  }
  if (rec.kind === 'config') {
    return {
      kind: 'config',
      at: numOrNull(rec.at),
      iso: typeof rec.iso === 'string' ? rec.iso : '',
      channelId: typeof rec.channelId === 'string' ? rec.channelId : '(unknown)',
      reason: rec.reason === 'aimd' ? 'aimd' : 'startup',
      triggerMode: typeof rec.triggerMode === 'string' ? rec.triggerMode : '',
      thetaMin: numOrNull(rec.thetaMin),
      burstMultiplier: numOrNull(rec.burstMultiplier),
      rhoMin: numOrNull(rec.rhoMin),
      minDiscussionMessages: numOrNull(rec.minDiscussionMessages),
    };
  }
  if (rec.kind === 'digest') {
    return {
      kind: 'digest',
      at: numOrNull(rec.at),
      iso: typeof rec.iso === 'string' ? rec.iso : '',
      channelId: typeof rec.channelId === 'string' ? rec.channelId : '(unknown)',
      hour: typeof rec.hour === 'string' ? rec.hour : '',
      messages: numOrNull(rec.messages),
      maxQuality: numOrNull(rec.maxQuality),
      maxDensity: numOrNull(rec.maxDensity),
      maxRate: numOrNull(rec.maxRate),
      maxInteraction: numOrNull(rec.maxInteraction),
      rateReadyMessages: numOrNull(rec.rateReadyMessages),
      potentialReadyMessages: numOrNull(rec.potentialReadyMessages),
      disagreed: numOrNull(rec.disagreed),
      nearMiss: numOrNull(rec.nearMiss),
    };
  }
  return null;
}

/** 读取目录下全部分片，返回 { records, skipped, totalLines }。坏行只计数不中断。 */
function loadRecords(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('shadow-') && f.endsWith('.jsonl'))
    .sort();
  const records = [];
  let skipped = 0;
  let totalLines = 0;
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue; // 空行不算坏行
      totalLines += 1;
      try {
        const rec = normalize(JSON.parse(trimmed));
        if (rec === null) {
          skipped += 1;
        } else {
          records.push(rec);
        }
      } catch {
        skipped += 1;
      }
    }
  }
  return { records, skipped, totalLines, fileCount: files.length };
}

/** --days / --channel 过滤；days 按 iso 的 UTC 日期取最近 N 天。 */
function applyFilters(records, opts) {
  let out = records;
  if (opts.days !== null) {
    // 截止日 = 今天往前推 N-1 天，UTC 日期串可直接字典序比较。
    const cutoff = new Date(Date.now() - (opts.days - 1) * DAY_MS).toISOString().slice(0, 10);
    out = out.filter((r) => {
      const d = utcDateOf(r);
      return d !== null && d >= cutoff;
    });
  }
  if (opts.channel !== null) {
    out = out.filter((r) => r.channelId === opts.channel);
  }
  return out;
}

/** 给出一条分歧记录的原因标注：三个闸门各自是否达标。 */
function disagreeReason(d) {
  const parts = [];
  if (d.rate !== null && d.threshold !== null) {
    parts.push(`rate ${fmt(d.rate)}${d.rate >= d.threshold ? '≥' : '<'}阈值 ${fmt(d.threshold)}`);
  }
  if (d.quality !== null && d.burstThreshold !== null) {
    parts.push(`Q ${fmt(d.quality)}${d.quality >= d.burstThreshold ? '≥' : '<'}burst ${fmt(d.burstThreshold)}`);
  }
  if (d.density !== null && d.rhoMin !== null) {
    parts.push(`ρ ${fmt(d.density)}${d.density >= d.rhoMin ? '≥' : '<'}ρmin ${fmt(d.rhoMin)}`);
  }
  return parts.join('；') || '字段不足';
}

function aggregate(records) {
  const decisions = records.filter((r) => r.kind === 'decision');
  const sessions = records.filter((r) => r.kind === 'session');

  const disagreements = decisions
    .filter((d) => !d.agree)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  // 覆盖率：一方 ready 而另一方没 ready 的次数，用来衡量谁更"敢触发"。
  const rateOnly = decisions.filter((d) => d.rateReady && !d.potReady).length;
  const potOnly = decisions.filter((d) => d.potReady && !d.rateReady).length;

  const msgValues = sessions.map((s) => s.messages).filter((m) => m !== null);

  /** @type {Map<string, {finalized:number,discarded:number,delivered:number,messages:number[]}>} */
  const byChannel = new Map();
  for (const s of sessions) {
    if (!byChannel.has(s.channelId)) {
      byChannel.set(s.channelId, { finalized: 0, discarded: 0, delivered: 0, messages: [] });
    }
    const agg = byChannel.get(s.channelId);
    if (s.verdict === 'finalized') agg.finalized += 1;
    else agg.discarded += 1;
    if (s.delivered) agg.delivered += 1;
    if (s.messages !== null) agg.messages.push(s.messages);
  }

  const dispatches = records.filter((r) => r.kind === 'dispatch');
  const configs = records.filter((r) => r.kind === 'config');
  const digests = records.filter((r) => r.kind === 'digest');
  const lastAt = records.reduce((acc, r) => Math.max(acc, r.at ?? 0), 0);

  return {
    decisions,
    sessions,
    disagreements,
    dispatches,
    configs,
    digests,
    lastAt,
    engines: efficiencyByEngine(decisions, sessions, dispatches),
    overview: {
      decisionCount: decisions.length,
      rateReady: decisions.filter((d) => d.rateReady).length,
      potReady: decisions.filter((d) => d.potReady).length,
      agree: decisions.filter((d) => d.agree).length,
      disagree: disagreements.length,
      rateOnlyReady: rateOnly,
      potOnlyReady: potOnly,
    },
    sessionStats: {
      total: sessions.length,
      finalized: sessions.filter((s) => s.verdict === 'finalized').length,
      discarded: sessions.filter((s) => s.verdict === 'discarded').length,
      delivered: sessions.filter((s) => s.delivered).length,
      msgMin: msgValues.length ? Math.min(...msgValues) : null,
      msgMedian: median(msgValues),
      msgMax: msgValues.length ? Math.max(...msgValues) : null,
    },
    byChannel,
    dispatchStats: {
      total: dispatches.length,
      success: dispatches.filter((d) => d.success).length,
      discarded: dispatches.filter((d) => d.discardReason !== null).length,
      failed: dispatches.filter((d) => d.failureReason !== null).length,
      scoreAvg:
        dispatches.length === 0
          ? null
          : dispatches.reduce((sum, d) => sum + (d.qualityScore ?? 0), 0) / dispatches.length,
    },
    // 标定口径：每群每小时的最大 Q / ρ，直接用来判断 Θ_min 与 ρ_min 定得高低。
    digestStats: {
      hours: digests.length,
      messages: digests.reduce((sum, d) => sum + (d.messages ?? 0), 0),
      maxQuality: digests.reduce((acc, d) => Math.max(acc, d.maxQuality ?? 0), 0),
      maxDensity: digests.reduce((acc, d) => Math.max(acc, d.maxDensity ?? 0), 0),
      maxRate: digests.reduce((acc, d) => Math.max(acc, d.maxRate ?? 0), 0),
      nearMiss: digests.reduce((sum, d) => sum + (d.nearMiss ?? 0), 0),
      rateReadyMessages: digests.reduce((sum, d) => sum + (d.rateReadyMessages ?? 0), 0),
      potentialReadyMessages: digests.reduce((sum, d) => sum + (d.potentialReadyMessages ?? 0), 0),
    },
  };
}

/**
 * 黑盒口径的效率表：把每个引擎当成黑盒，只看「发起多少次 → 有效产出多少」。
 *
 * - 发起：该引擎为主判据时判 ready 的次数。`potential` 模式看 `potential.ready`，
 *   其余（`rate` / `shadow`）看 `rate.ready`——shadow 下势能侧只观测不裁决，
 *   它判 ready 但没有产出，那是「未接管」而不是「效率为 0」，报告里要分开说。
 * - 产出：按 `triggerMode` 分组统计 `session.delivered` 与 `dispatch.success`。
 *   shadow 期的势能尝试无法归因到实际产出，因此只报发起次数与「未接管」标记。
 */
function efficiencyByEngine(decisions, sessions, dispatches) {
  const modes = new Set([
    ...decisions.map((d) => d.triggerMode || 'unknown'),
    ...sessions.map((s) => s.triggerMode || 'unknown'),
  ]);
  const rows = [];
  for (const mode of [...modes].sort()) {
    const driverIsPotential = mode === 'potential';
    const modeDecisions = decisions.filter((d) => (d.triggerMode || 'unknown') === mode);
    const initiatives = modeDecisions.filter((d) => (driverIsPotential ? d.potReady : d.rateReady)).length;
    const otherSide = modeDecisions.filter((d) => (driverIsPotential ? d.rateReady : d.potReady)).length;
    const modeSessions = sessions.filter((s) => (s.triggerMode || 'unknown') === mode);
    const delivered = modeSessions.filter((s) => s.delivered).length;
    const produced = dispatches.filter(
      (d) => (d.triggerMode || 'unknown') === mode && d.success,
    ).length;
    rows.push({
      mode,
      engine: driverIsPotential ? 'potential' : 'rate',
      initiatives,
      otherSideReady: otherSide,
      sessions: modeSessions.length,
      delivered,
      produced,
      // 发起次数只统计**主判据**（真正裁决相位的那一侧），因此有效率恒有意义：
      // shadow 期的势能 ready 属于「未接管」，已排除在分子分母之外。
      rate: initiatives === 0 ? null : produced / initiatives,
      note:
        mode === 'shadow'
          ? '影子期：势能侧只观测不裁决，其 ready 次数不计入产出'
          : mode === 'potential'
            ? '势能接管'
            : '频率接管',
    });
  }
  return rows;
}

/** 结论段全部由已算出的统计拼装，不写任何臆测。 */
function buildConclusion(stats) {
  const { overview, sessionStats } = stats;
  const sentences = [];
  if (overview.decisionCount === 0) {
    return '样本内没有决策记录，两套判据无从比较。';
  }
  if (overview.disagree === 0) {
    sentences.push(
      `在 ${overview.decisionCount} 个裁决点上两套判据完全一致（各判 ready ${overview.rateReady} 次），触发时机无差异。`,
    );
  } else {
    const hotter =
      overview.potOnlyReady > overview.rateOnlyReady
        ? `potential 更激进（单独就绪 ${overview.potOnlyReady} 次，高于 rate 的 ${overview.rateOnlyReady} 次）`
        : overview.rateOnlyReady > overview.potOnlyReady
          ? `rate 更激进（单独就绪 ${overview.rateOnlyReady} 次，高于 potential 的 ${overview.potOnlyReady} 次）`
          : `两侧单独就绪次数持平（各 ${overview.rateOnlyReady} 次）`;
    sentences.push(
      `在 ${overview.decisionCount} 个裁决点上，rate 判 ready ${overview.rateReady} 次、potential 判 ready ${overview.potReady} 次，分歧 ${overview.disagree} 次，${hotter}。`,
    );
  }
  sentences.push(
    `会话共结算 ${sessionStats.total} 轮：finalized ${sessionStats.finalized}、discarded ${sessionStats.discarded}；其中 ${sessionStats.delivered} 轮进入调度管线，真实产出以「调度产出」的 success 为准（session.delivered 只表示结算出了会话对象，不代表群里拿到词条）。`,
  );
  return sentences.join('');
}

function renderMarkdown(stats, meta) {
  const { overview, disagreements, sessionStats, byChannel } = stats;
  const lines = [];
  lines.push('# Shadow 判据对照报告');
  lines.push('');
  lines.push(`- 数据目录：\`${meta.dir}\``);
  lines.push(`- 分片文件：${meta.fileCount} 个；解析 ${meta.totalLines} 行，跳过坏行 ${meta.skipped} 行`);
  const scope = [];
  if (meta.days !== null) scope.push(`最近 ${meta.days} 天`);
  if (meta.channel !== null) scope.push(`群 ${meta.channel}`);
  lines.push(`- 统计范围：${scope.length ? scope.join('，') : '全部记录'}`);
  if (stats.lastAt > 0) {
    const ageHours = (Date.now() - stats.lastAt) / 3_600_000;
    const stale = ageHours > 6 ? '⚠️ 台账可能已断流（检查 `/api/status.observability.failed`）' : '✅ 新鲜';
    const ageText =
      ageHours < 0 ? `比本机时钟超前 ${Math.abs(ageHours).toFixed(1)} 小时（时钟偏移或回放数据）` : `${ageHours.toFixed(1)} 小时前`;
    lines.push(`- 最新记录：${new Date(stats.lastAt).toISOString()}（${ageText}）${stale}`);
  }
  lines.push('');

  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| 决策点数 | ${overview.decisionCount} |`);
  lines.push(`| rate 判 ready | ${overview.rateReady} |`);
  lines.push(`| potential 判 ready | ${overview.potReady} |`);
  lines.push(`| 两者一致 | ${overview.agree} |`);
  lines.push(`| 两者分歧 | ${overview.disagree} |`);
  lines.push(`| rate 未覆盖（potential ready 而 rate 未 ready） | ${overview.potOnlyReady} |`);
  lines.push(`| potential 未覆盖（rate ready 而 potential 未 ready） | ${overview.rateOnlyReady} |`);
  lines.push('');

  lines.push('## 分歧明细');
  lines.push('');
  if (disagreements.length === 0) {
    lines.push('三日无分歧。');
  } else {
    lines.push('| 时间 | 群 | rate | potential | 差异原因 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const d of disagreements) {
      const time = d.iso || (d.at !== null ? new Date(d.at).toISOString() : '—');
      lines.push(
        `| ${time} | ${d.channelId} | rate=${fmt(d.rate)}/${fmt(d.threshold)} ready=${d.rateReady} ` +
          `| Q=${fmt(d.quality)} ρ=${fmt(d.density)} ready=${d.potReady} | ${disagreeReason(d)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## 会话');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| finalized | ${sessionStats.finalized} |`);
  lines.push(`| discarded | ${sessionStats.discarded} |`);
  lines.push(`| 进入调度的轮次 | ${sessionStats.delivered} |`);
  lines.push(`| messages min/median/max | ${fmt(sessionStats.msgMin)} / ${fmt(sessionStats.msgMedian)} / ${fmt(sessionStats.msgMax)} |`);
  lines.push('');
  if (byChannel.size > 0) {
    lines.push('| 群 | finalized | discarded | 进入调度 | messages 中位数 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const [channelId, agg] of [...byChannel.entries()].sort()) {
      lines.push(`| ${channelId} | ${agg.finalized} | ${agg.discarded} | ${agg.delivered} | ${fmt(median(agg.messages))} |`);
    }
    lines.push('');
  }

  lines.push('## 引擎效率（黑盒口径：发起次数 → 有效产出）');
  lines.push('');
  if (stats.engines.length === 0) {
    lines.push('样本内没有可用于归因的记录。');
  } else {
    lines.push('| 模式 | 主判据 | 发起次数 | 有效产出 | 有效率 | 有效会话 | 对侧 ready | 说明 |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const e of stats.engines) {
      const rateText = e.rate === null ? '—' : `${(e.rate * 100).toFixed(0)}%`;
      lines.push(
        `| ${e.mode} | ${e.engine} | ${e.initiatives} | ${e.produced} | ${rateText} | ${e.delivered} | ${e.otherSideReady} | ${e.note} |`,
      );
    }
    lines.push('');
    lines.push('有效率 = 有效产出 / 发起次数（`dispatch.success` 计 1，同一轮多次调度按次计）。');
  }
  lines.push('');

  lines.push('## 调度产出');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| 调度回执 | ${stats.dispatchStats.total} |`);
  lines.push(`| 成功产出词条 | ${stats.dispatchStats.success} |`);
  lines.push(`| 模型侧判定丢弃 | ${stats.dispatchStats.discarded} |`);
  lines.push(`| 失败 | ${stats.dispatchStats.failed} |`);
  lines.push(`| 平均质量分 | ${fmt(stats.dispatchStats.scoreAvg)} |`);
  lines.push('');

  lines.push('## 标定分布（每小时极值，用来判断 Θ_min / ρ_min 定得高低）');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| 摘要小时数 | ${stats.digestStats.hours} |`);
  lines.push(`| 覆盖消息数 | ${stats.digestStats.messages} |`);
  lines.push(`| 最大 Q | ${fmt(stats.digestStats.maxQuality)} |`);
  lines.push(`| 最大 ρ | ${fmt(stats.digestStats.maxDensity)} |`);
  lines.push(`| 最大速率（条/分） | ${fmt(stats.digestStats.maxRate)} |`);
  lines.push(`| rate ready 消息数 | ${stats.digestStats.rateReadyMessages} |`);
  lines.push(`| potential ready 消息数 | ${stats.digestStats.potentialReadyMessages} |`);
  lines.push(`| NEAR_MISS 次数 | ${stats.digestStats.nearMiss} |`);
  lines.push('');

  const aimd = stats.configs.filter((c) => c.reason === 'aimd');
  if (stats.configs.length > 0) {
    lines.push('## 参数快照');
    lines.push('');
    lines.push('| 时间 | 群 | 来源 | 模式 | Θ_min | 倍率 | ρ_min | 最少条数 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const c of stats.configs.slice(-12)) {
      lines.push(
        `| ${c.iso || '—'} | ${c.channelId} | ${c.reason} | ${c.triggerMode} | ${fmt(c.thetaMin)} | ${fmt(c.burstMultiplier)} | ${fmt(c.rhoMin)} | ${fmt(c.minDiscussionMessages)} |`,
      );
    }
    lines.push('');
    if (aimd.length > 0) {
      lines.push(`期间 AIMD 调参 ${aimd.length} 次——比较跨天数据时要按参数分段看，别把不同门限下的样本混在一起。`);
      lines.push('');
    }
  }
  lines.push('## 结论');
  lines.push('');
  lines.push(buildConclusion(stats));
  lines.push('');
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.dir)) {
    console.log(`目录不存在，无可统计数据：${opts.dir}`);
    return;
  }
  const { records, skipped, totalLines, fileCount } = loadRecords(opts.dir);
  const filtered = applyFilters(records, opts);
  const stats = aggregate(filtered);
  const meta = { dir: opts.dir, days: opts.days, channel: opts.channel, skipped, totalLines, fileCount };

  if (opts.json) {
    const out = {
      meta,
      overview: stats.overview,
      disagreements: stats.disagreements,
      sessions: {
        ...stats.sessionStats,
        byChannel: Object.fromEntries(
          [...stats.byChannel.entries()].map(([k, v]) => [k, { ...v, msgMedian: median(v.messages) }]),
        ),
      },
      engines: stats.engines,
      dispatch: stats.dispatchStats,
      digest: stats.digestStats,
      configs: stats.configs,
      lastAt: stats.lastAt,
      conclusion: buildConclusion(stats),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(renderMarkdown(stats, meta));
}

main();
