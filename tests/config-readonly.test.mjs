import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Config, PatchouliKnowledgeSystem } from '../lib/index.js';
import * as pluginEntry from '../lib/plugin/index.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * ADR-022 的回归契约：宿主 `config` 是 Koishi 的配置对象，loader 在启停时会序列化/
 * 比较它。运行时回灌与热更新必须只写插件自己的副本，否则「停止」会被翻成 reload。
 */
test('CONFIG-READONLY-01: 回灌与热更新不修改宿主 config，且热更新即时生效', async () => {
  const wikiDir = await mkdtemp(path.join(tmpdir(), 'patchouli-readonly-'));

  // 第一轮：写入落盘参数与提示词，制造「重启后有东西可回灌」的前置条件。
  const seedConfig = Config({
    enabled: true,
    storage: { wikiDir },
    dispatcher: { provider: 'standalone', apiKey: 'sk-test', model: 'gpt-4o-mini' },
  });
  const seed = new PatchouliKnowledgeSystem(seedConfig, quiet);
  try {
    await seed.ready;
    await seed.updateTopicSettings({ hour: 5, minEntries: 3 });
    await seed.saveCustomPrompt('沉淀用提示词：只依据消息原文。');
    await seed.saveTopicPrompt('主题聚合提示词：按要点归并。');
  } finally {
    seed.dispose();
  }

  // 第二轮：构造即触发 restore*，之后宿主配置必须与构造前逐字节一致。
  const config = Config({
    enabled: true,
    storage: { wikiDir },
    dispatcher: { provider: 'standalone', apiKey: 'sk-test', model: 'gpt-4o-mini' },
  });
  const before = JSON.stringify(config);
  const system = new PatchouliKnowledgeSystem(config, quiet);
  try {
    await system.ready;

    assert.equal(JSON.stringify(config), before, '启动回灌不得写宿主 config');
    assert.equal(system.getTopicSettings().hour, 5, '回灌值必须进入运行时副本');
    assert.equal(system.getTopicSettings().minEntries, 3);
    assert.equal(system.dispatcher.topicPrompt, '主题聚合提示词：按要点归并。');
    assert.ok(
      system.dispatcher.systemPrompt.includes('沉淀用提示词'),
      '回灌的自定义系统提示词必须对调度器即时生效',
    );

    // 运行期热更新同样不得碰宿主配置。
    await system.updateTopicSettings({ hour: 6 });
    await system.saveCustomPrompt('改过的沉淀提示词。');
    assert.equal(JSON.stringify(config), before, '热更新不得写宿主 config');
    assert.equal(system.getTopicSettings().hour, 6);
    assert.ok(system.dispatcher.systemPrompt.includes('改过的沉淀提示词'));
    assert.equal(system.config.topics.hour, Config({}).topics.hour, '宿主 topics 保持 Schema 默认值');
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});

/**
 * 控制台在「已停用」状态下对不可 fork 的插件会报「此插件已在运行且不可重用」。
 * 插件状态全在实例闭包与 `PatchouliKnowledgeSystem` 里、`dispose()` 逐项还原，
 * 因此声明 `reusable = true` 是安全且必需的（ADR-022）。
 */
test('PLUGIN-REUSABLE-01: 声明 reusable，消除控制台的「已在运行且不可重用」告警', () => {
  assert.equal(pluginEntry.name, 'patchouli-knowledge');
  assert.equal(pluginEntry.reusable, true);
});
