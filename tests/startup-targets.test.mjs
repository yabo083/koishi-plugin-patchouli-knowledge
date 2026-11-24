import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Config,
  installStartupTargets,
  resetStartupTargetCache,
  startupTargetValues,
  writeAlbumCache,
} from '../lib/index.js';

/**
 * 订阅目标候选的**启动期目录**契约。
 *
 * 静态 const union 在模块加载时求值，那时没有 `ctx`，只能按 `process.cwd()` 读一次盘。
 * `cwd` 不是实例目录时，实例里已配置的相册目标就不在候选里 —— 而 union 的校验是严格的，
 * 整份插件配置会被拒载（`apply()` 拿 `ctx.baseDir` 重读已经太晚：校验在它之前）。
 * 兜底入口是 `installStartupTargets({ baseDir })`：任何先拿到实例目录的时机调它，
 * 该目录的候选与已配置值立刻进 union。
 *
 * 用例的价值在于**先证伪再证明**：构造一个 cwd 下绝不可能出现的相册名，
 * 断言 install 之前解析抛错、之后通过。
 */
const unionValues = () =>
  (Config.dict?.subscriptions?.inner?.dict?.targets?.inner?.list ?? []).map((item) => item.value);

test('STARTUP-01: cwd 读不到实例时 installStartupTargets(baseDir) 让配置不再拒载', async () => {
  const albumName = `拒载回归-${process.pid}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'patchouli-startup-'));
  const wikiDir = 'data/llmwiki';
  try {
    mkdirSync(path.join(dir, wikiDir), { recursive: true });
    writeFileSync(
      path.join(dir, 'koishi.yml'),
      [
        'plugins:',
        '  patchouli-knowledge:',
        '    storage:',
        `      wikiDir: ${wikiDir}`,
        '    subscriptions:',
        "      - source: '1'",
        `        targets: ['${albumName}']`,
      ].join('\n'),
      'utf8',
    );
    await writeAlbumCache(path.join(dir, wikiDir), [
      { groupId: '1', groupName: '群1', albumId: 'a', albumName },
    ]);

    const config = { subscriptions: [{ source: '1', targets: [albumName] }] };

    // 前提：这个名字只存在于实例目录里，模块级候选（cwd）读不到它。
    assert.equal(unionValues().includes(albumName), false, '前提：候选里还没有这个实例的值');
    assert.throws(() => Config(config), '静态 union 是严格的：baseDir 没进 union 就拒载');

    // 兜底入口：拿到实例目录就能把该目录的候选装进 union。
    const installed = installStartupTargets({ baseDir: dir });
    assert.deepEqual(
      installed.configured,
      [albumName],
      '实例 yml 里已配置的目标必须被读出来（configuredFromBlocks 路径）',
    );
    assert.deepEqual(
      installed.albums.map((album) => album.albumName),
      [albumName],
      '实例目录的相册缓存同样要读出来',
    );
    assert.equal(unionValues().includes(albumName), true, 'baseDir 里的值必须进候选 union');
    assert.equal(unionValues()[0], '@chat', '「本群聊天」仍是首项（union 结构不变）');

    const parsed = Config(config);
    assert.deepEqual(parsed.subscriptions[0].targets, [albumName], '同一条配置现在能通过校验');
    assert.deepEqual(parsed.subscriptions[0].source, '1');
  } finally {
    resetStartupTargetCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('STARTUP-02: 同一实例目录只读一次盘；空目录不把已装好的候选挤掉', () => {
  const albumName = `缓存回归-${process.pid}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'patchouli-startup-cache-'));
  try {
    writeFileSync(
      path.join(dir, 'koishi.yml'),
      ['plugins:', '  patchouli-knowledge:', '    subscriptions:', `      - targets: ['${albumName}']`].join('\n'),
      'utf8',
    );

    const first = startupTargetValues(dir);
    const second = startupTargetValues(dir);
    assert.equal(second, first, '同一目录第二次调用命中缓存（返回同一份快照）');
    assert.deepEqual(first.configured, [albumName]);

    // 缓存过期后重读：磁盘上的新值立刻可见（`apply()` 的重载路径）。
    writeFileSync(
      path.join(dir, 'koishi.yml'),
      ['plugins:', '  patchouli-knowledge:', '    subscriptions:', `      - targets: ['${albumName}-new']`].join('\n'),
      'utf8',
    );
    assert.equal(startupTargetValues(dir), first, '不带 reload 时不重读');
    assert.deepEqual(
      startupTargetValues(dir, { reload: true }).configured,
      [`${albumName}-new`],
      'reload 才重读磁盘（插件重载要看见新相册）',
    );

    // 读不到任何实例配置时降级为空，且**不动**已经装好的 union（否则配置会被自己挤掉）。
    installStartupTargets({ baseDir: dir });
    const before = unionValues();
    const empty = installStartupTargets({ baseDir: path.join(dir, 'no-such-instance') });
    assert.deepEqual(empty, { albums: [], configured: [], bindings: {} }, '缺目录静默降级为空');
    assert.deepEqual(unionValues(), before, '空候选不覆盖上一份 union');
  } finally {
    resetStartupTargetCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
