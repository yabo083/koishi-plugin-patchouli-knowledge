import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { LocalStore } from '../lib/index.js';

test('STORE-CORRUPT-01: 库文件解析失败后拒绝以空库覆盖（fail closed）', async () => {
  const dir = path.resolve('tmp/store-corrupt');
  await fs.rm(dir, { recursive: true, force: true });
  const file = path.join(dir, '.patchouli', 'store.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ 这不是合法 JSON', 'utf8');

  const store = new LocalStore({ wikiDir: dir });
  // 读路径触发隔离（重命名走坏文件），但内存里不得变成「空库可写」
  const entries = await store.queryEntries();
  assert.deepEqual(entries, [], '损坏库读出空表');

  const quarantined = (await fs.readdir(path.dirname(file))).filter((name) => name.includes('.corrupt-'));
  assert.ok(quarantined.length === 1, '坏文件必须被隔离留证');

  await assert.rejects(
    () => store.saveEntry({ id: 'x', title: '新条目', channelId: 'g', date: '2026-11-22', status: 'open', tags: [], summary: '摘要' }, '/tmp/x.md'),
    /解析失败且已隔离/u,
    '拒绝以空库覆盖，直到人工处理后重启',
  );

  // 重启（新实例）后原路径已不存在 → 空库可正常写入
  const restarted = new LocalStore({ wikiDir: dir });
  await restarted.saveEntry({ id: 'x', title: '新条目', channelId: 'g', date: '2026-11-22', status: 'open', tags: [], summary: '摘要' }, '/tmp/x.md');
  assert.equal((await restarted.queryEntries()).length, 1, '重启后恢复写入');

  await fs.rm(dir, { recursive: true, force: true });
});
