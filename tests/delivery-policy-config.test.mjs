import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Config,
  PatchouliKnowledgeSystem,
  installStartupTargets,
  readTargetPolicies,
  resetStartupTargetCache,
  settingsPath,
  writeAlbumCache,
  writeTargetBindings,
} from '../lib/index.js';

/**
 * 插件页「投递策略」表格 → `.patchouli/settings.json` 的 `policies`（POLICY-CONFIG-01）。
 *
 * 配置面写的是**可读名**（与订阅表同一份候选），运行时只认**稳定地址**：翻译只发生在
 * `initialize()` 里一次（绑定表已回灌 + 首轮迁移已跑），之后的投递闸门直接读 `policies`。
 *
 * 用例盯三件事：① 名字按落盘绑定表解析（含唯一 `@chat` 行取来源群）；② 解析不到的行
 * warn 跳过、不回退猜；③ 内容不变不写盘（换实例重启不刷文件），变了才写。
 */
const makeWiki = () => mkdtemp(path.join(tmpdir(), 'patchouli-policy-config-'));

const cleanup = (wikiDir) => rm(wikiDir, { recursive: true, force: true });

function recorder() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    logger: {
      info: (message) => lines.info.push(String(message)),
      warn: (message) => lines.warn.push(String(message)),
      error: (message) => lines.error.push(String(message)),
    },
  };
}

test('POLICY-CONFIG-01: 插件页策略按绑定表解析成稳定地址落盘，未解析行 warn 跳过，内容不变不写盘', async () => {
  const wikiDir = await makeWiki();
  const albumName = `策略相册-${process.pid}`;
  const staleName = `已删除的相册-${process.pid}`;
  // 与 SETTINGS-STORE-16 同一份策略形状：窗口文本落盘时会被归一（`~N` 折进抖动字段）。
  const albumPolicy = { window: '* 22:00-23:30', entryPerDay: 3, weeklyPerWeek: 1, jitterMinutes: 15 };
  const chatPolicy = { window: '1 09:00', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 };
  try {
    // 启动期候选：静态 const union 是严格校验的，yml 里已保存的策略目标必须进候选，
    // 否则整份配置在 `Config()` 就被拒载（这里连"已删除的相册"也要进去，它正是要被 warn 的那行）。
    await writeFile(
      path.join(wikiDir, 'koishi.yml'),
      [
        'plugins:',
        '  patchouli-knowledge:',
        '    storage:',
        `      wikiDir: ${wikiDir}`,
        '    subscriptions:',
        "      - source: '200'",
        "        targets: ['@chat']",
        '    deliveryPolicies:',
        `      - target: '${albumName}'`,
        `      - target: '${staleName}'`,
      ].join('\n'),
      'utf8',
    );
    await writeAlbumCache(wikiDir, [{ groupId: '100', groupName: '群100', albumId: 'A1', albumName }]);
    await writeTargetBindings(wikiDir, { [albumName]: '100/A1' });

    const installed = installStartupTargets({ baseDir: wikiDir });
    assert.deepEqual(installed.bindings, { [albumName]: '100/A1' }, '绑定表来自 settings.json');
    assert.ok(installed.configured.includes(staleName), 'yml 里的策略目标同样要进候选（否则配置拒载）');
    // 候选是两份独立 union 实例：刷新必须同时换 `list`，否则策略表停在首启候选上。
    const policyUnion = Config.dict.deliveryPolicies.inner.dict.target;
    assert.ok(
      policyUnion.list.some((item) => item.value === albumName),
      '重装候选后策略表的目标下拉必须跟着更新',
    );

    const policyRows = () => [
      { target: albumName, ...albumPolicy },
      { target: '@chat', ...chatPolicy },
      { target: staleName, window: '* 22:00-23:30', entryPerDay: 1, weeklyPerWeek: 0, jitterMinutes: 0 },
    ];
    const configOf = (rows) =>
      Config({
        storage: { wikiDir },
        subscriptions: [{ source: '200', targets: ['@chat'], entry: true, weekly: false }],
        deliveryPolicies: rows,
      });

    const first = recorder();
    const system = new PatchouliKnowledgeSystem(configOf(policyRows()), first.logger);
    try {
      await system.ready;
      assert.deepEqual(
        await readTargetPolicies(wikiDir),
        { '100/A1': albumPolicy, '@chat:200': chatPolicy },
        '相册名 → 群号/相册ID；唯一的 @chat 行 → @chat:<来源群>',
      );
      assert.equal(
        first.lines.warn.some((line) => line.includes(staleName)),
        true,
        `解析不到的目标必须 warn：${first.lines.warn.join(' | ')}`,
      );
      assert.equal(
        first.lines.warn.some((line) => line.includes(albumName)),
        false,
        '解析成功的行不该有告警',
      );
    } finally {
      system.dispose();
    }

    // ③ 内容不变不写盘：同一份配置换一个实例重启，文件时间戳必须原样。
    const before = (await stat(settingsPath(wikiDir))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = new PatchouliKnowledgeSystem(configOf(policyRows()), recorder().logger);
    try {
      await second.ready;
    } finally {
      second.dispose();
    }
    assert.equal(
      (await stat(settingsPath(wikiDir))).mtimeMs,
      before,
      '策略内容没变就不该重写 settings.json（每次启动都写盘毫无意义）',
    );
    assert.deepEqual(await readTargetPolicies(wikiDir), { '100/A1': albumPolicy, '@chat:200': chatPolicy });

    // ④ 变了才写：改一个字段，重启后磁盘跟着变（证明比较不是「永远跳过」）。
    const changed = policyRows();
    changed[0] = { ...changed[0], entryPerDay: 5 };
    const third = new PatchouliKnowledgeSystem(configOf(changed), recorder().logger);
    try {
      await third.ready;
    } finally {
      third.dispose();
    }
    assert.equal(
      (await readTargetPolicies(wikiDir))['100/A1'].entryPerDay,
      5,
      '插件页改过的值必须落盘',
    );

    // ⑤ 单一真源：插件页清空策略 = 磁盘上的表一并清掉（否则浮窗时代的旧值永远删不掉）。
    const cleared = new PatchouliKnowledgeSystem(configOf([]), recorder().logger);
    try {
      await cleared.ready;
    } finally {
      cleared.dispose();
    }
    assert.deepEqual(await readTargetPolicies(wikiDir), {}, '空表 = 没有策略（键被删除）');
  } finally {
    resetStartupTargetCache();
    await cleanup(wikiDir);
  }
});
