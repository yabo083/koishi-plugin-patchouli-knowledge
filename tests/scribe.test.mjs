/**
 * 主动书记员持久化（§7.2 / §7.5.9）：追加式录制、串行写、启动恢复与幂等删除。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCRIBE_MESSAGE_MAX_CHARS,
  SCRIBE_MIN_RESTORE_MESSAGES,
  ScribeStore,
  isScribeAdmin,
  resolveAdminUsers,
  restoreScribeSessions,
  scribeFilePath,
  scribeMetaPath,
  scribeScopeRefusal,
} from '../lib/plugin/scribe.js';
import { BurstQuiescenceDetector } from '../lib/trigger/detector.js';
import { ensureWikiLayout, resolveWikiLayout } from '../lib/wiki/layout.js';
import { LocalStore } from '../lib/wiki/storage.js';
import { Config } from '../lib/index.js';

const TEST_ROOT = fileURLToPath(new URL('../tmp/scribe-test', import.meta.url));
const NOW = 1793000000000;

function buildDetector(now = NOW, onQuiescence = async () => {}) {
  return new BurstQuiescenceDetector({
    options: {
triggerMode: 'rate', triggerMode: 'rate',
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      minDiscussionMessages: 10,
    },
    onQuiescence,
    now: () => now,
  });
}

function makeMessage(index, channelId = 'group-1', overrides = {}) {
  return {
    id: `msg-${index}`,
    channelId,
    userId: `user-${index}`,
    userName: `群友${index}`,
    content: `第 ${index} 条讨论`,
    timestamp: NOW - 20_000 + index * 1000,
    ...overrides,
  };
}

function makeStore(dir, logs = []) {
  return new ScribeStore({
    dir,
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });
}

async function readLines(file) {
  const text = await fs.readFile(file, 'utf8');
  return text.split(/\r?\n/u).filter((line) => line.trim() !== '');
}

test('SCRIBE-STORE-01: 追加写读回字段完整、不落 raw、内容按码点截断 2000 字', async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  const dir = path.join(TEST_ROOT, 'store-01', '.patchouli', 'scribe');
  const store = makeStore(dir);

  // 布局契约：scribe/ 懒创建，ensureWikiLayout 不预建（与 discards/ 同策略）。
  const root = path.join(TEST_ROOT, 'store-01');
  const layout = await ensureWikiLayout(root);
  assert.equal(layout.scribeDir, path.join(layout.patchouliDir, 'scribe'));
  await assert.rejects(fs.stat(layout.scribeDir), { code: 'ENOENT' }, 'ensureWikiLayout 不得预建 scribe/');

  const longContent = '😀'.repeat(SCRIBE_MESSAGE_MAX_CHARS + 100);
  const msg = makeMessage(1, 'group-1', { content: longContent, raw: { event: 'must-not-persist' } });
  const written = await store.append(msg);
  assert.equal(written, true);

  const file = scribeFilePath(dir, 'group-1');
  const lines = await readLines(file);
  assert.equal(lines.length, 1);

  const record = JSON.parse(lines[0]);
  assert.equal(record.id, msg.id);
  assert.equal(record.channelId, 'group-1');
  assert.equal(record.userId, msg.userId);
  assert.equal(record.userName, msg.userName);
  assert.equal(record.timestamp, msg.timestamp);
  assert.ok(!('raw' in record), '录制记录绝不写入 Koishi 事件对象');
  assert.equal([...record.content].length, SCRIBE_MESSAGE_MAX_CHARS, '超出部分必须按码点截断到 2000');
  assert.ok(record.content.endsWith('…'), '超长内容以省略号收尾');
  assert.ok(record.content.isWellFormed(), '截断不得劈开代理对');

  const short = makeMessage(2, 'group-1');
  await store.append(short);
  const again = await readLines(file);
  assert.equal(again.length, 2, '追加写不得覆盖已有行');
  assert.equal(JSON.parse(again[1]).content, short.content, '未超长的内容原样保留');
  assert.equal(SCRIBE_MIN_RESTORE_MESSAGES, 2);
  await assert.rejects(
    fs.stat(scribeMetaPath(dir, 'group-1')),
    { code: 'ENOENT' },
    '水位 0 且无话题提示时不落 meta（缺省即 0，不留多余文件）',
  );

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('SCRIBE-STORE-02: 并发 10 次 append 不丢行、不互相覆盖', async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  const dir = path.join(TEST_ROOT, 'store-02', 'scribe');
  const store = makeStore(dir);

  const messages = Array.from({ length: 10 }, (_, index) => makeMessage(index, 'group-concurrent'));
  const outcomes = await Promise.all(messages.map((msg) => store.append(msg)));
  assert.deepEqual(outcomes, new Array(10).fill(true));

  const lines = await readLines(scribeFilePath(dir, 'group-concurrent'));
  assert.equal(lines.length, 10, '10 次并发追加必须留下 10 行');
  const ids = lines.map((line) => {
    const record = JSON.parse(line);
    assert.equal(record.channelId, 'group-concurrent');
    return record.id;
  });
  assert.deepEqual(ids, messages.map((msg) => msg.id), '串行队列保持到达顺序');

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('SCRIBE-STORE-03: 启动恢复 15 条会话，不足 2 条的残留被删除', async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  const dir = path.join(TEST_ROOT, 'store-03', 'scribe');
  const logs = [];
  const store = makeStore(dir, logs);

  const channelId = 'group-restore';
  for (let index = 0; index < 15; index++) {
    await store.append(makeMessage(index, channelId));
  }
  const residual = makeMessage(99, 'group-residual');
  await store.append(residual);

  const detector = buildDetector();
  const result = await restoreScribeSessions({ dir, detector, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });

  assert.equal(detector.isManualRecording(channelId), true, '恢复后必须仍处于录制态');
  assert.equal(detector.getState(channelId).buffer.length, 15);
  assert.deepEqual(result.restored, [{ channelId, count: 15, deliveredUpTo: 0 }]);
  assert.ok(
    logs.includes(`[Patchouli] 已恢复主动书记员会话: 群 ${channelId}，15 条消息`),
    '恢复必须留一行可检索日志',
  );

  const residualFile = scribeFilePath(dir, 'group-residual');
  await assert.rejects(fs.stat(residualFile), { code: 'ENOENT' }, '不足 2 条的残留文件必须删除');
  assert.deepEqual(result.discarded, [residualFile]);
  assert.equal(detector.isManualRecording('group-residual'), false);
  assert.equal(detector.getState('group-residual'), undefined);
  assert.deepEqual(result.kept, []);

  // 恢复不改写文件：再次恢复依旧拿到同样 15 条。
  assert.equal((await readLines(scribeFilePath(dir, channelId))).length, 15);

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('SCRIBE-STORE-04: 解析失败的记录保留文件、告警且不恢复', async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  const dir = path.join(TEST_ROOT, 'store-04', 'scribe');
  await fs.mkdir(dir, { recursive: true });

  const channelId = 'group-corrupt';
  const file = scribeFilePath(dir, channelId);
  const valid = {
    id: 'msg-0',
    channelId,
    userId: 'user-0',
    userName: '群友0',
    content: '有效的一行',
    timestamp: NOW,
  };
  await fs.writeFile(file, `${JSON.stringify(valid)}\n{ 这不是 JSON\n`, 'utf8');

  const logs = [];
  const detector = buildDetector();
  const result = await restoreScribeSessions({ dir, detector, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });

  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.kept, [file]);
  assert.equal((await fs.readFile(file, 'utf8')).includes('这不是 JSON'), true, '损坏文件必须原样保留');
  assert.equal(detector.isManualRecording(channelId), false, '损坏记录不得被恢复');
  assert.ok(
    logs.some((line) => line.includes('主动书记员记录损坏，保留文件不恢复')),
    '必须留下告警',
  );

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('SCRIBE-STORE-05: 删除幂等，记录目录缺失时恢复不抛错', async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  const dir = path.join(TEST_ROOT, 'store-05', 'scribe');
  const store = makeStore(dir);

  // 目录从未创建：删除不抛错，返回 false。
  assert.equal(await store.remove('group-absent'), false);

  await store.append(makeMessage(1, 'group-remove'));
  const file = scribeFilePath(dir, 'group-remove');
  assert.equal((await fs.stat(file)).isFile(), true);
  assert.equal(await store.remove('group-remove'), true);
  assert.equal(await store.remove('group-remove'), false, '重复删除必须幂等');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });

  // 恢复：目录不存在视为空目录，不抛错。
  const logs = [];
  const result = await restoreScribeSessions({ dir, detector: buildDetector(), logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  assert.deepEqual(result, { restored: [], discarded: [], kept: [] });
  assert.deepEqual(logs, [], '空目录不产生噪声日志');

  const layout = resolveWikiLayout('/tmp/llmwiki');
  assert.equal(layout.scribeDir, path.join(layout.patchouliDir, 'scribe'));

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('SCRIBE-STORE-06: 管理员白名单默认 fail closed，未登记用户一律拒绝', () => {
  assert.deepEqual(Config({}).adminUsers, [], '缺省白名单必须为空数组');

  const config = { adminUsers: [' 10001 ', '10002', '', 42, null] };
  assert.deepEqual(resolveAdminUsers(config), ['10001', '10002'], '只保留非空字符串并去重');
  assert.equal(isScribeAdmin(config, '10001'), true);
  assert.equal(isScribeAdmin(config, '10002'), true);
  assert.equal(isScribeAdmin(config, '10003'), false);
  assert.equal(isScribeAdmin(config, undefined), false);

  // 空 / 缺失白名单 = 谁都不通过（绝不放行）。
  assert.equal(isScribeAdmin({ adminUsers: [] }, '10001'), false);
  assert.equal(isScribeAdmin({}, '10001'), false);
  assert.equal(isScribeAdmin(undefined, '10001'), false);
});

test('SCRIBE-STORE-07: 节奏快照磁盘往返保留 thetaMin / rhoMin / triggerMode', async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  const root = path.join(TEST_ROOT, 'store-07');
  const databasePath = path.join(root, 'store.json');
  const channelId = 'group-cadence';
  const options = {
    windowSizeSeconds: 60,
    burstMultiplier: 2.5,
    minBurstRate: 6,
    quiescenceSeconds: 300,
    coolingRatioThreshold: 0.5,
    minDiscussionMessages: 12,
    maxBufferMessages: 500,
    baselineEwmaAlpha: 0.05,
    triggerMode: 'potential',
    thetaMin: 23.5,
    rhoMin: 1.35,
  };
  const metrics = {
    currentRate: 3.5,
    baselineRate: 2.25,
    baselineDeviation: 0.4,
    burstRatio: 1.55,
    lastMessageTime: NOW - 1000,
    phase: 'BURSTING',
    bufferedCount: 7,
  };

  const writer = new LocalStore({ wikiDir: root, databasePath });
  await writer.saveCadenceState({ channelId, options, metrics, updatedAt: NOW });

  // 新实例 = 进程重启：只有磁盘状态可用，内存里没有任何残留。
  const reader = new LocalStore({ wikiDir: root, databasePath });
  const loaded = await reader.loadCadenceState(channelId);
  assert.deepEqual(loaded.options, options, '整份触发参数必须原样读回（含新增三键）');
  assert.equal(loaded.options.triggerMode, 'potential', 'AIMD / 面板设置的判据模式不得在重启后丢失');
  assert.equal(loaded.options.thetaMin, 23.5, 'AIMD 学到的 Θ_min 不得在重启后丢失');
  assert.equal(loaded.options.rhoMin, 1.35, '密度门限 ρ_min 不得在重启后丢失');
  assert.deepEqual(loaded.metrics, metrics, '度量快照同步往返');

  // 非法枚举 / 非数值：丢弃而不是抛错（读库不能让整份文档失败）。
  const document = JSON.parse(await fs.readFile(databasePath, 'utf8'));
  document.cadence[channelId].options.triggerMode = 'no-such-mode';
  document.cadence[channelId].options.rhoMin = 'not-a-number';
  await fs.writeFile(databasePath, `${JSON.stringify(document)}\n`, 'utf8');

  const reloaded = await new LocalStore({ wikiDir: root, databasePath }).loadCadenceState(channelId);
  assert.equal(reloaded.options.triggerMode, undefined, '非法 triggerMode 必须按缺失丢弃');
  assert.equal(reloaded.options.rhoMin, undefined, '非数值 rhoMin 必须按缺失丢弃');
  assert.equal(reloaded.options.thetaMin, 23.5, '合法键不因邻居非法而丢失');

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('SCRIBE-STORE-08: 已交付水位随消息行落盘、只进不退，删除时一并清理', async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  const dir = path.join(TEST_ROOT, 'store-08', 'scribe');
  const store = makeStore(dir);
  const channelId = 'group-watermark';
  const watermark = makeMessage(3, channelId).timestamp;

  assert.equal(await store.append(makeMessage(0, channelId), SCRIBE_MESSAGE_MAX_CHARS, watermark), true);

  const metaPath = scribeMetaPath(dir, channelId);
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(meta.deliveredUpTo, watermark, 'meta 必须记下已交付水位');
  assert.equal(typeof meta.updatedAt, 'number', 'meta 必须带落盘时刻，便于排障');
  assert.deepEqual(Object.keys(meta).sort(), ['deliveredUpTo', 'updatedAt'], 'meta 只有水位与落盘时刻');

  // 水位单调：更旧的水位绝不覆盖磁盘上的新值。
  await store.append(makeMessage(1, channelId), SCRIBE_MESSAGE_MAX_CHARS, 1);
  assert.equal(
    JSON.parse(await fs.readFile(metaPath, 'utf8')).deliveredUpTo,
    watermark,
    '水位只允许前进',
  );

  assert.equal(await store.remove(channelId), true);
  await assert.rejects(fs.stat(metaPath), { code: 'ENOENT' }, '删除记录文件必须同时删除 meta');
  await assert.rejects(fs.stat(scribeFilePath(dir, channelId)), { code: 'ENOENT' });

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('SCRIBE-STORE-09: 恢复只装载未交付部分，水位写回 lastSettledTime', async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  const dir = path.join(TEST_ROOT, 'store-09', 'scribe');
  const store = makeStore(dir);
  const channelId = 'group-sliced';
  const deliveredUpTo = makeMessage(119, channelId).timestamp;

  // 模拟软切片：第 120 条触发交付，其后的消息携带新水位（只追加，旧行留在文件里）。
  for (let index = 0; index < 125; index += 1) {
    const watermark = index < 120 ? 0 : deliveredUpTo;
    await store.append(makeMessage(index, channelId), SCRIBE_MESSAGE_MAX_CHARS, watermark);
  }
  assert.equal((await readLines(scribeFilePath(dir, channelId))).length, 125, '录制文件保留全部行');

  const delivered = [];
  const detector = buildDetector(NOW, (session) => {
    delivered.push(session);
  });
  const result = await restoreScribeSessions({ dir, detector });

  assert.deepEqual(result.restored, [{ channelId, count: 5, deliveredUpTo }], '只恢复未交付的 5 条');
  const state = detector.getState(channelId);
  assert.equal(state.buffer.length, 5);
  assert.deepEqual(
    state.buffer.map((message) => message.id),
    ['msg-120', 'msg-121', 'msg-122', 'msg-123', 'msg-124'],
    '已切片的 120 条绝不能再进缓冲',
  );
  assert.equal(state.lastSettledTime, deliveredUpTo, '水位必须写回 lastSettledTime');
  assert.match(state.triggerReason, /自动书记恢复/u, '触发依据标明是重启恢复');

  // 结束录制只交付这 5 条：已交付的前 120 条不会被再交一次。
  detector.stopManualSession(channelId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].messages.length, 5);

  // 整个文件都已交付：没有可恢复内容 → 视为残留，jsonl 与 meta 一并删除。
  const doneDir = path.join(TEST_ROOT, 'store-09-done', 'scribe');
  const doneStore = makeStore(doneDir);
  const doneChannel = 'group-done';
  const doneWatermark = makeMessage(3, doneChannel).timestamp;
  for (let index = 0; index < 4; index += 1) {
    await doneStore.append(makeMessage(index, doneChannel), SCRIBE_MESSAGE_MAX_CHARS, doneWatermark);
  }
  const second = await restoreScribeSessions({ dir: doneDir, detector: buildDetector() });
  assert.deepEqual(second.restored, [], '全部已交付的文件不恢复');
  assert.deepEqual(second.discarded, [scribeFilePath(doneDir, doneChannel)]);
  await assert.rejects(fs.stat(scribeMetaPath(doneDir, doneChannel)), { code: 'ENOENT' });

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('SCRIBE-STORE-10: logon 范围校验——插件停用 / 非白名单群明确拒绝', () => {
  assert.equal(scribeScopeRefusal({ enabled: true, channels: [] }, 'group-1'), undefined, '白名单为空即监听全部群');
  assert.equal(scribeScopeRefusal({ channels: [] }, 'group-1'), undefined, '缺省 enabled 视为启用');
  assert.equal(scribeScopeRefusal({ enabled: true, channels: ['group-1'] }, 'group-1'), undefined);

  const disabled = scribeScopeRefusal({ enabled: false, channels: ['group-1'] }, 'group-1');
  assert.match(disabled, /已停用/u, '插件停用时必须说明原因而不是回「已开启」');

  const outside = scribeScopeRefusal({ enabled: true, channels: ['group-1'] }, 'group-2');
  assert.match(outside, /不在 channels 白名单/u);
  assert.match(outside, /group-2/u, '拒绝理由必须点明是哪个群');
  assert.match(
    scribeScopeRefusal({ enabled: true, channels: [''] }, 'group-1'),
    /不在 channels 白名单/u,
    '空白名单项按 channelScope 的同一口径处理（不等于「监听全部群」）',
  );

  // 公开版本默认不预置任何真实群号：缺省配置的 channels 为空 = 监听全部群
  assert.equal(scribeScopeRefusal(Config({}), 'group-9'), undefined, '缺省空白名单必须放行');
  assert.equal(scribeScopeRefusal(Config({}), '100000000'), undefined);
});
