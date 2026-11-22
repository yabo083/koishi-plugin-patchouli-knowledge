import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CARD_SETTINGS_DEFAULT, normalizeCardSettingsPatch, readCardSettings, writeCardSettings } from '../lib/index.js';

test('CARD-SETTINGS-01: 缺文件即默认脱敏；写入后可回读；损坏文件退回默认', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'patchouli-card-'));
  try {
    assert.deepEqual(await readCardSettings(dir), { maskNames: true }, '缺文件必须默认脱敏');
    assert.equal(CARD_SETTINGS_DEFAULT.maskNames, true);

    await writeCardSettings(dir, { maskNames: false });
    assert.deepEqual(await readCardSettings(dir), { maskNames: false }, '关闭状态必须跨重启存活');

    const file = path.join(dir, '.patchouli', 'card-settings.json');
    assert.match(await fs.readFile(file, 'utf8'), /"version": 1/u);

    await fs.writeFile(file, '{ 损坏的 JSON', 'utf8');
    assert.deepEqual(await readCardSettings(dir), { maskNames: true }, '损坏文件不得让插件起不来');

    await fs.writeFile(file, JSON.stringify({ version: 2, settings: { maskNames: false } }), 'utf8');
    assert.deepEqual(await readCardSettings(dir), { maskNames: true }, '未知版本一律退回默认');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CARD-SETTINGS-02: 归一化只接受布尔 maskNames（字符串/数字/未知键丢弃）', () => {
  assert.deepEqual(normalizeCardSettingsPatch({ maskNames: false }), { maskNames: false });
  assert.deepEqual(normalizeCardSettingsPatch({ maskNames: 'false' }), {}, '字符串不得被当成布尔');
  assert.deepEqual(normalizeCardSettingsPatch({ maskNames: 0 }), {});
  assert.deepEqual(normalizeCardSettingsPatch({ apiKey: 'x', maskNames: true }), { maskNames: true });
  assert.deepEqual(normalizeCardSettingsPatch(null), {});
  assert.deepEqual(normalizeCardSettingsPatch('nope'), {});
});
