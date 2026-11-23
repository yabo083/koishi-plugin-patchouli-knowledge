import test from 'node:test';
import assert from 'node:assert/strict';

import { planEntryTargets } from '../lib/plugin/entry-delivery.js';

test('ENTRY-DELIVER-01: 未配置改道时按相册目标表逐个投递', () => {
  const targets = planEntryTargets(['100000001/album-a', '100000003/album-b'], '');
  assert.deepEqual(targets, [
    { kind: 'album', channelId: 'onebot:100000001', albumId: 'album-a' },
    { kind: 'album', channelId: 'onebot:100000003', albumId: 'album-b' },
  ]);
});

test('ENTRY-DELIVER-02: 配置改道后只发该群聊天，相册列表被忽略', () => {
  const targets = planEntryTargets(['100000001/album-a'], '100000002');
  assert.deepEqual(targets, [{ kind: 'channel', channelId: 'onebot:100000002' }]);
});

test('ENTRY-DELIVER-03: 改道目标允许带平台前缀，且不会重复加前缀', () => {
  assert.deepEqual(planEntryTargets([], 'onebot:100000002'), [
    { kind: 'channel', channelId: 'onebot:100000002' },
  ]);
});

test('ENTRY-DELIVER-04: 非法与重复的相册目标被丢弃', () => {
  const targets = planEntryTargets(
    ['no-slash', '/only-album', '100000001/', '100000001/album-a', ' 100000001/album-a ', ''],
    '',
  );
  assert.deepEqual(targets, [{ kind: 'album', channelId: 'onebot:100000001', albumId: 'album-a' }]);
});

test('ENTRY-DELIVER-05: 既无相册也未改道时返回空表（调用方据此告警）', () => {
  assert.deepEqual(planEntryTargets([], '   '), []);
});

test('ENTRY-DELIVER-06: 词条只投递到自身所属群的相册（不跨群广播）', () => {
  const albums = ['100000001/album-a', '100000003/album-b'];

  // 来源群在名单里：只取它自己的相册
  assert.deepEqual(planEntryTargets(albums, '', 'onebot:100000003'), [
    { kind: 'album', channelId: 'onebot:100000003', albumId: 'album-b' },
  ]);
  // 平台前缀形态不影响匹配
  assert.deepEqual(planEntryTargets(albums, '', '100000001'), [
    { kind: 'album', channelId: 'onebot:100000001', albumId: 'album-a' },
  ]);
  // 来源群不在名单里：静默不投递，绝不借用别人群的相册
  assert.deepEqual(planEntryTargets(albums, '', 'onebot:199999999'), []);
  assert.deepEqual(planEntryTargets(['100000003/album-b'], '', 'onebot:100000001'), []);
});
