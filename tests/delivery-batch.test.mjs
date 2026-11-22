import test from 'node:test';
import assert from 'node:assert/strict';

import { deliverCardToTargets } from '../lib/plugin/delivery.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const keyOf = (target) => `${target.channelId}${target.kind === 'album' ? `/${target.albumId}` : ''}`;

test('DELIVERY-BATCH-01: 有 broadcast 时一次批量提交，重试策略原样透传', async () => {
  const calls = [];
  const ctx = {
    'miyako-delivery': {
      deliver: async () => {
        throw new Error('不应逐个投递');
      },
      broadcast: async (deliveries) => {
        calls.push(deliveries);
        return {
          ok: true,
          deliveredCount: 2,
          totalCount: 2,
          outcomes: deliveries.map((item) => ({ target: item.target, ok: true, attempts: 1 })),
        };
      },
    },
  };
  const targets = [
    { kind: 'album', channelId: 'onebot:1', albumId: 'a' },
    { kind: 'album', channelId: 'onebot:2', albumId: 'b' },
  ];
  const result = await deliverCardToTargets(ctx, targets, PNG, {
    scope: 'patchouli:entry',
    dedupeKeyOf: keyOf,
    retry: { maxAttempts: 4, baseDelayMs: 3000 },
  });

  assert.equal(calls.length, 1, '必须只调用一次 broadcast');
  assert.equal(calls[0].length, 2);
  assert.deepEqual(calls[0][0].retry, { maxAttempts: 4, baseDelayMs: 3000 });
  assert.equal(calls[0][0].scope, 'patchouli:entry');
  assert.equal(calls[0][0].dedupeKey, 'onebot:1/a');
  assert.deepEqual(result, { ok: true, delivered: 2, total: 2, outcomes: result.outcomes });
});

test('DELIVERY-BATCH-02: 服务只有 deliver、没有 broadcast → NO_BROADCAST，不退化逐个投递', async () => {
  const seen = [];
  const ctx = {
    'miyako-delivery': {
      deliver: async (delivery) => {
        seen.push(delivery.dedupeKey);
        return { target: delivery.target, ok: true, attempts: 1 };
      },
    },
  };
  const targets = [
    { kind: 'channel', channelId: 'onebot:1' },
    { kind: 'channel', channelId: 'onebot:2' },
  ];
  const result = await deliverCardToTargets(ctx, targets, PNG, { dedupeKeyOf: keyOf });
  assert.equal(result.ok, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.outcomes[0].error?.code, 'NO_BROADCAST');
  assert.deepEqual(seen, [], '不得回退到逐个 deliver');
});

test('DELIVERY-BATCH-03: 无投递服务时结构化失败，不抛出', async () => {
  const targets = [{ kind: 'album', channelId: 'onebot:1', albumId: 'a' }];
  const result = await deliverCardToTargets({}, targets, PNG, { dedupeKeyOf: keyOf });
  assert.equal(result.ok, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.outcomes[0].error?.code, 'NO_DELIVERY_SERVICE');
});

test('DELIVERY-BATCH-04: 空目标表直接成功返回，不发任何请求', async () => {
  const result = await deliverCardToTargets({}, [], PNG, { dedupeKeyOf: keyOf });
  assert.deepEqual(result, { ok: true, delivered: 0, total: 0, outcomes: [] });
});
