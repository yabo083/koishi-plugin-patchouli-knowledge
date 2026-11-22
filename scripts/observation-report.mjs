#!/usr/bin/env node
/**
 * 观测期摘要：读 llmwiki 的 `.patchouli/` 观测目录，输出判据切换所需的全部指标。
 *
 * 用法（本地或服务器均可，只读）：
 *   node scripts/observation-report.mjs <wikiDir> [--since YYYY-MM-DD]
 *
 *   <wikiDir> 例如 /path/to/koishi/data/instances/default/data/llmwiki
 *   脚本读取：observability/shadow-*.jsonl（裁决台账）、discards/*.json（丢弃/失败留证）、
 *             store.json（已落库词条）。
 *
 * 回答三件事：
 *   1. 两套判据在观测期内的触发差异（rate vs potential：ready 数、独有命中、NEAR_MISS）。
 *   2. 势能侧健康度：`potentialPeak` 样本数、`peakQ/Θ_burst` 分布（标定 `dispatchMargin` 用）、
 *      `baselineDensity`（b_ρ）是否已长出非零值。
 *   3. 调度结果分布：成功 / 模型判丢 / 运行时失败。
 *
 * 不写任何文件、不调模型；契约重试次数在日志里（`journalctl -u koishi.service | grep 契约重试`），
 * 不落台账，故此处只报「调度失败」比例作为代理指标。
 */

import fs from 'node:fs';
import path from 'node:path';

const wikiDir = process.argv[2];
if (!wikiDir) {
  console.error('用法: node scripts/observation-report.mjs <wikiDir> [--since YYYY-MM-DD]');
  process.exit(2);
}
const sinceIdx = process.argv.indexOf('--since');
const since = sinceIdx > 0 ? process.argv[sinceIdx + 1] : undefined;

const obsDir = path.join(wikiDir, '.patchouli', 'observability');
const discardDir = path.join(wikiDir, '.patchouli', 'discards');
const storeFile = path.join(wikiDir, '.patchouli', 'store.json');

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((row) => row !== undefined);
}

function listFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name))
    .sort();
}

const ledgerFiles = listFiles(obsDir, /^shadow-\d{4}-\d{2}-\d{2}\.jsonl$/u).filter((file) => {
  if (!since) return true;
  const day = path.basename(file).slice('shadow-'.length, 'shadow-YYYY-MM-DD'.length);
  return day >= since;
});

const decisions = [];
const sessions = [];
const configs = [];
const perDay = new Map();

for (const file of ledgerFiles) {
  const day = path.basename(file).slice(7, 17);
  const rows = readJsonl(file);
  const bucket = perDay.get(day) ?? { decisions: 0, rateReady: 0, potentialReady: 0, both: 0, rateOnly: 0, potentialOnly: 0, neither: 0 };
  for (const row of rows) {
    if (row.kind === 'decision') {
      decisions.push(row);
      bucket.decisions += 1;
      const rate = row.rate?.ready === true;
      const potential = row.potential?.ready === true;
      if (rate && potential) bucket.both += 1;
      else if (rate) bucket.rateOnly += 1;
      else if (potential) bucket.potentialOnly += 1;
      else bucket.neither += 1;
    } else if (row.kind === 'session') {
      sessions.push(row);
    } else if (row.kind === 'config') {
      configs.push(row);
    }
  }
  perDay.set(day, bucket);
}

const rateReady = decisions.filter((row) => row.rate?.ready === true).length;
const potentialReady = decisions.filter((row) => row.potential?.ready === true).length;
const rateOnly = decisions.filter((row) => row.rate?.ready === true && row.potential?.ready !== true).length;
const potentialOnly = decisions.filter((row) => row.potential?.ready === true && row.rate?.ready !== true).length;
const both = decisions.filter((row) => row.rate?.ready === true && row.potential?.ready === true).length;

const peaks = sessions.filter((row) => row.potentialPeak !== undefined && row.potentialPeak !== null).map((row) => row.potentialPeak);
const ratios = peaks
  .filter((peak) => Number.isFinite(peak.burstThreshold) && peak.burstThreshold > 0 && Number.isFinite(peak.quality))
  .map((peak) => peak.quality / peak.burstThreshold)
  .sort((a, b) => a - b);

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

const densitySamples = sessions
  .map((row) => row.potentialPeak?.density)
  .filter((value) => typeof value === 'number');
const densityMax = densitySamples.length > 0 ? Math.max(...densitySamples) : NaN;

const verdicts = { SUCCESS: 0, MODEL: 0, FAILURE: 0, FLOOR: 0, GATE: 0 };
for (const file of listFiles(discardDir, /\.json$/u)) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const kind = doc?.verdict?.kind;
    if (kind in verdicts) verdicts[kind] += 1;
  } catch {
    /* 单份留证损坏不影响整体统计 */
  }
}

let entryCount = 0;
if (fs.existsSync(storeFile)) {
  try {
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    entryCount = Array.isArray(store.entries) ? store.entries.length : Object.keys(store.entries ?? {}).length;
  } catch {
    /* 忽略 */
  }
}

const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

console.log(`# 观测摘要  ${since ? `自 ${since}` : '全部台账'}`);
console.log(`台账文件: ${ledgerFiles.map((file) => path.basename(file)).join(', ') || '（无）'}`);
console.log('');
console.log('## 1) 判据对照（decision 级）');
console.log(`裁决点 ${decisions.length}｜rate.ready ${rateReady}｜potential.ready ${potentialReady}｜两者同时 ${both}｜rate 独有 ${rateOnly}｜potential 独有 ${potentialOnly}｜双双缺席 ${decisions.length - both - rateOnly - potentialOnly}`);
if (decisions.length > 0) {
  console.log(`potential 相对 rate 的召回增量: ${(((potentialReady - rateReady) / Math.max(1, rateReady)) * 100).toFixed(1)}%`);
}
console.log('');
console.log('## 2) 势能健康度');
console.log(`potentialPeak 样本 ${peaks.length}｜peakQ/Θ_burst 中位 ${fmt(quantile(ratios, 0.5))}｜p90 ${fmt(quantile(ratios, 0.9))}｜max ${fmt(ratios.at(-1))}`);
console.log(`baselineDensity(density) 样本 ${densitySamples.length}｜最大 ${fmt(densityMax, 4)}${densityMax > 0 ? '  ← b_ρ 已长出非零值' : '  ← 仍为 0'}`);
console.log(
  peaks.length === 0
    ? '  ⚠ 尚无 finalized 会话带 potentialPeak：dispatchMargin 仍不可离线标定'
    : `  dispatchMargin 候选区间（取 p50×1.05 ~ p90）: ${fmt(quantile(ratios, 0.5) * 1.05)} ~ ${fmt(quantile(ratios, 0.9))}`,
);
console.log('');
console.log('## 3) 调度结果');
console.log(`已落库词条 ${entryCount}｜留证: 成功 ${verdicts.SUCCESS}｜模型判丢 ${verdicts.MODEL}｜运行时失败 ${verdicts.FAILURE}｜缓冲丢弃 ${verdicts.FLOOR}｜质量门跳过 ${verdicts.GATE}`);
console.log('契约重试次数不落台账，取值：journalctl -u koishi.service | grep -c "契约重试后输出通过校验"');
console.log('');
console.log('## 4) 按日');
for (const [day, bucket] of [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`${day}  决策 ${bucket.decisions}｜both ${bucket.both}｜rate 独有 ${bucket.rateOnly}｜potential 独有 ${bucket.potentialOnly}｜双双缺席 ${bucket.neither}`);
}
if (configs.length > 0) {
  const last = configs.at(-1);
  console.log('');
  console.log(`最近一次配置快照: ${JSON.stringify(last.data ?? last).slice(0, 400)}`);
}
