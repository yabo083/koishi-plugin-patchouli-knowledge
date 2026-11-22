/**
 * 判据持久化（`shadow-ledger`）：追加式 JSONL、按逻辑时间分片、串行写、保留期清扫。
 *
 * 这份台账是「三天后两套判据对照」的唯一数据源，写入语义（不重写 / 不并发覆盖 / 不因
 * 目录缺失而崩）必须钉住；`evaluateVerdicts` 的两侧结论也一并在真实语料上验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHADOW_FILE_MAX_BYTES,
  SHADOW_RETENTION_DAYS,
  ShadowLedger,
  dayKey,
} from '../lib/telemetry/shadow-ledger.js';
import { BurstQuiescenceDetector, DEFAULT_TRIGGER_OPTIONS } from '../lib/trigger/detector.js';

const TEST_ROOT = fileURLToPath(new URL('../tmp/shadow-ledger-test', import.meta.url));
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 10, 11, 8, 0, 0);

function decision(at, overrides = {}) {
  return {
    kind: 'decision',
    at,
    iso: new Date(at).toISOString(),
    channelId: '100000001',
    triggerMode: 'shadow',
    phase: 'IDLE',
    rate: { ready: false, rate: 6.4, threshold: 6.3, baseline: 1.95, speakers: 3, entropy: 0.62 },
    potential: {
      ready: true,
      quality: 11.5,
      density: 1.19,
      rhoMin: 0.35,
      interaction: 1,
      baselineQuality: 2.8,
      burstThreshold: 20,
      coolThreshold: 8.8,
    },
    agree: false,
    buffered: 0,
    ...overrides,
  };
}

function session(at, overrides = {}) {
  return {
    kind: 'session',
    at,
    iso: new Date(at).toISOString(),
    channelId: '100000001',
    sessionId: '2026-11-11-session-test',
    verdict: 'finalized',
    messages: 35,
    peakRate: 15,
    delivered: true,
    reason: null,
    ...overrides,
  };
}

/** 每例独占子目录：上次运行残留会让「不建空目录 / 条数」这类断言假失败。 */
async function freshDir(name) {
  const dir = path.join(TEST_ROOT, name, 'observability');
  await fs.rm(dir, { recursive: true, force: true });
  return dir;
}

async function readLines(dir) {
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
  const lines = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    lines.push(...text.split('\n').filter((line) => line.trim() !== ''));
  }
  return lines;
}

test('SHADOW-LEDGER-01: 决策与会话各写一行可解析 JSON，不写空目录', async () => {
  const dir = await freshDir('basic');
  const ledger = new ShadowLedger({ dir });

  // 未曾 append 时不建目录：未启用的实例不留空壳。
  await ledger.flush();
  await assert.rejects(fs.readdir(dir));

  ledger.append(decision(BASE));
  ledger.append(session(BASE + 1000));
  await ledger.flush();

  const lines = await readLines(dir);
  assert.equal(lines.length, 2, '两条记录两行');
  const [first, second] = lines.map((line) => JSON.parse(line));
  assert.equal(first.kind, 'decision');
  assert.equal(first.agree, false);
  assert.equal(first.potential.quality, 11.5);
  assert.equal(second.kind, 'session');
  assert.equal(second.messages, 35);
  assert.equal(second.delivered, true);
});

test('SHADOW-LEDGER-02: 按逻辑时间 UTC 日期分片，跨天落在不同文件', async () => {
  const dir = await freshDir('shard');
  const ledger = new ShadowLedger({ dir });
  ledger.append(decision(BASE));
  ledger.append(decision(BASE + DAY));
  await ledger.flush();

  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, [`shadow-${dayKey(BASE)}.jsonl`, `shadow-${dayKey(BASE + DAY)}.jsonl`]);
});

test('SHADOW-LEDGER-03: 并发 append 串行落盘，一条不丢不互相覆盖', async () => {
  const dir = await freshDir('serial');
  const ledger = new ShadowLedger({ dir });
  for (let index = 0; index < 40; index += 1) {
    ledger.append(decision(BASE + index * 1000, { buffered: index }));
  }
  await ledger.flush();

  const lines = await readLines(dir);
  assert.equal(lines.length, 40);
  const buffered = lines.map((line) => JSON.parse(line).buffered).sort((a, b) => a - b);
  assert.deepEqual(buffered, Array.from({ length: 40 }, (_, index) => index));
});

test('SHADOW-LEDGER-04: 单文件超上限后按序号续写，旧文件不被截断', async () => {
  const dir = await freshDir('rotate');
  const ledger = new ShadowLedger({ dir });
  const heavy = { note: 'x'.repeat(4096) };
  const perRecord = Buffer.byteLength(`${JSON.stringify(decision(BASE, heavy))}\n`, 'utf8');
  const count = Math.ceil(SHADOW_FILE_MAX_BYTES / perRecord) + 2;
  for (let index = 0; index < count; index += 1) ledger.append(decision(BASE, heavy));
  await ledger.flush();

  const names = (await fs.readdir(dir)).sort();
  assert.ok(names.length >= 2, `应该续写出第二个分片，实际 ${names.join(',')}`);
  const lines = await readLines(dir);
  assert.equal(lines.length, count, '续写不丢记录');
});

test('SHADOW-LEDGER-05: sweep 只删超过保留期的分片', async () => {
  const dir = await freshDir('sweep');
  const ledger = new ShadowLedger({ dir });
  const fresh = BASE;
  const stale = BASE - (SHADOW_RETENTION_DAYS + 2) * DAY;
  ledger.append(decision(fresh));
  ledger.append(decision(stale));
  await ledger.flush();

  const removed = await ledger.sweep(BASE);
  assert.deepEqual(removed, [`shadow-${dayKey(stale)}.jsonl`]);
  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, [`shadow-${dayKey(fresh)}.jsonl`]);
});

test('SHADOW-LEDGER-06: 目录被外部删除后写入自动重建，不抛', async () => {
  const dir = await freshDir('recreate');
  const ledger = new ShadowLedger({ dir });
  ledger.append(decision(BASE));
  await ledger.flush();
  await fs.rm(dir, { recursive: true, force: true });

  ledger.append(decision(BASE + 1000));
  await ledger.flush();
  const lines = await readLines(dir);
  assert.equal(lines.length, 1, '重建后只留重建后的那条（旧数据已被外部删除）');
});

test('SHADOW-LEDGER-07: evaluateVerdicts 两侧结论与同口径门限一致', () => {
  const now = BASE;
  const detector = new BurstQuiescenceDetector({
    options: {
triggerMode: 'rate', triggerMode: 'rate',
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      minDiscussionMessages: 4,
      triggerMode: 'shadow',
    },
    onQuiescence: async () => {},
    now: () => now,
  });

  const users = ['u1', 'u2', 'u3'];
  for (let index = 0; index < 24; index += 1) {
    detector.onMessage({
      id: `m${index}`,
      channelId: '100000001',
      userId: users[index % 3],
      userName: users[index % 3],
      content: `第 ${index} 条：势能判据的交互熵来自不同发言人的异质内容`,
      timestamp: BASE + index * 1500,
    });
  }

  const verdicts = detector.evaluateVerdicts('100000001');
  assert.ok(verdicts !== null, '已知群必须给出两侧判据');
  // 两侧口径与状态机同一个辅助函数：门限必须相等，不能出现遥测自立的第二套公式。
  assert.ok(verdicts.rate.threshold > 0);
  assert.equal(verdicts.potential.rhoMin, DEFAULT_TRIGGER_OPTIONS.rhoMin, 'ρ_min 必须与状态机同一默认值');
  assert.equal(verdicts.potential.burstThreshold, Math.max(20, verdicts.potential.baselineQuality * 2.5));
  assert.ok(verdicts.potential.quality >= 0);
  assert.ok(verdicts.rate.speakers >= 2, '连续 24 条三发言人消息必须识别出多发言人');
  assert.equal(detector.evaluateVerdicts('unknown-channel'), null, '未知群返回 null 而非伪造结论');
});
