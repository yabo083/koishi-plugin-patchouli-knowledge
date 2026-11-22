import test from 'node:test';
import assert from 'node:assert/strict';

import { renderWeeklyAlbumSummaryHtml, renderWeeklyAlbumSummaryPng } from '../lib/plugin/card.js';
import { deliverCardPng, deliverElements, getDeliveryService } from '../lib/plugin/delivery.js';

function makeView(overrides = {}) {
  return {
    id: '2026-10-30-card',
    title: '卡片标题',
    date: '2026-10-30',
    status: 'verified',
    tags: ['分类学', '藏书'],
    summary: '一句话摘要。',
    background: '',
    consensus: ['先按流派分组', '组内按年代排序', '新流派另行登记', '第四条应被卡片丢弃'],
    divergence: [],
    quotes: [],
    sources: ['raw/sessions/2026-10-30-card.json'],
    ...overrides,
  };
}

function createFakePage({ height = 400, shot = Buffer.from('jpeg-bytes'), throwOnScreenshot = false } = {}) {
  const calls = { viewport: [], screenshot: [], closeCount: 0, html: '' };
  return {
    calls,
    handle: {
      setViewport: async (options) => {
        calls.viewport.push(options);
      },
      setContent: async (html) => {
        calls.html = html;
      },
      evaluate: async () => height,
      screenshot: async (options) => {
        calls.screenshot.push(options);
        if (throwOnScreenshot) throw new Error('截图失败');
        return shot;
      },
      close: async () => {
        calls.closeCount += 1;
      },
    },
  };
}

function createBot(platform, { fail = false } = {}) {
  const sent = { messages: [], privates: [] };
  return {
    sent,
    bot: {
      platform,
      sendMessage: async (channelId, content) => {
        if (fail) throw new Error('发送失败');
        sent.messages.push({ channelId, content });
        return ['mid-1'];
      },
      sendPrivateMessage: async (userId, content) => {
        if (fail) throw new Error('发送失败');
        sent.privates.push({ userId, content });
        return ['mid-private'];
      },
    },
  };
}

test("DELIVERY-01: 只认 ctx['miyako-delivery']，ctx.notifier 不算投递服务", () => {
  assert.equal(getDeliveryService({ notifier: { send: async () => undefined } }), undefined);
  assert.equal(getDeliveryService({}), undefined);
  assert.equal(getDeliveryService(undefined), undefined);

  const service = getDeliveryService({ 'miyako-delivery': { deliver: async () => ({ ok: true, attempts: 1 }) } });
  assert.ok(service !== undefined);
});

test('DELIVERY-02: 有 delivery 服务时全量委托并归一化结果', async () => {
  const captured = [];
  const ctx = {
    'miyako-delivery': {
      deliver: async (delivery) => {
        captured.push(delivery);
        return { ok: true, messageId: 'svc-1', attempts: 2 };
      },
    },
  };

  const outcome = await deliverElements(ctx, { channelId: 'onebot:100000000' }, ['hello'], {
    scope: 'patchouli',
    dedupeKey: 'entry-1',
  });

  assert.deepEqual(outcome, { ok: true, attempts: 2, messageId: 'svc-1' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].target.channelId, 'onebot:100000000');
  assert.deepEqual(captured[0].elements, ['hello']);
  assert.equal(captured[0].scope, 'patchouli');
  assert.equal(captured[0].dedupeKey, 'entry-1');

  const minimal = await deliverElements(
    { 'miyako-delivery': { deliver: async () => ({ ok: true }) } },
    { channelId: 'onebot:1' },
    ['x'],
  );
  assert.deepEqual(minimal, { ok: true, attempts: 0 });
});

test('DELIVERY-03: delivery 服务抛错 → 结构化失败而不是外抛', async () => {
  const outcome = await deliverElements(
    {
      'miyako-delivery': {
        deliver: async () => {
          throw new Error('上游炸了');
        },
      },
    },
    { channelId: 'onebot:1' },
    ['x'],
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'DELIVERY_FAILED');
  assert.equal(outcome.error.message, '上游炸了');
});

test('DELIVERY-04: 无 delivery 服务时频道目标也显式失败，绝不绕过服务直发', async () => {
  const group = createBot('onebot');
  const ctx = { bots: [group.bot] };

  const outcome = await deliverElements(ctx, { channelId: 'onebot:100000000' }, ['hello']);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'NO_DELIVERY_SERVICE');
  assert.equal(outcome.attempts, 0);
  assert.deepEqual(group.sent.messages, [], '不得绕过 miyako-delivery 直接发消息');
  assert.deepEqual(group.sent.privates, []);
});

test('DELIVERY-05: 服务缺失时平台不匹配 / 地址非法也不影响判定（契约先行）', async () => {
  const none = await deliverElements({}, { channelId: 'onebot:1' }, ['x']);
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'NO_DELIVERY_SERVICE');

  const mismatch = await deliverElements({ bots: [createBot('qq').bot] }, { channelId: 'onebot:1' }, ['x']);
  assert.equal(mismatch.error.code, 'NO_DELIVERY_SERVICE');

  const invalid = await deliverElements({ bots: [] }, { channelId: 'onebot::1' }, ['x']);
  assert.equal(invalid.error.code, 'NO_DELIVERY_SERVICE');
});

test('DELIVERY-06: 服务抛错被收敛为 DELIVERY_FAILED；相册目标同样要求服务', async () => {
  const broken = {
    'miyako-delivery': {
      deliver: async () => {
        throw new Error('上游炸了');
      },
    },
  };
  const failed = await deliverElements(broken, { channelId: 'onebot:1' }, ['x']);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'DELIVERY_FAILED');
  assert.equal(failed.error.message, '上游炸了');

  const album = await deliverElements({}, { kind: 'album', channelId: 'onebot:1', albumId: 'a' }, ['x']);
  assert.equal(album.ok, false);
  assert.equal(album.error.code, 'NO_DELIVERY_SERVICE');
  assert.equal(album.attempts, 0);
});

test('DELIVERY-07: 卡片以图片元素投递', async () => {
  const captured = [];
  const ctx = {
    'miyako-delivery': {
      deliver: async (delivery) => {
        captured.push(delivery);
        return { ok: true, attempts: 1 };
      },
    },
  };

  const outcome = await deliverCardPng(ctx, { channelId: 'onebot:1' }, Buffer.from('jpeg'), {
    scope: 'patchouli',
  });
  assert.equal(outcome.ok, true);
  assert.equal(captured.length, 1);
  const element = captured[0].elements[0];
  assert.equal(element.type, 'img');
  assert.equal(captured[0].scope, 'patchouli');
});

test('CARD-07: 每周相册总结一页列出主题，不复制正文，PNG 裁剪到实际高度', async () => {
  const views = [
    makeView(),
    { ...makeView(), id: 'second', title: '第二个主题', summary: '第二段摘要' },
  ];
  const html = renderWeeklyAlbumSummaryHtml(views, { weekLabel: '2026-W45' });
  assert.ok(html.includes('每周知识相册'));
  assert.ok(html.includes('2026-W45'));
  assert.ok(html.includes('第二个主题'));
  assert.ok(html.includes('本周 2 个主题'));
  assert.equal(/<script/i.test(html), false);

  const fake = createFakePage({ height: 640 });
  const png = await renderWeeklyAlbumSummaryPng(
    { puppeteer: { page: async () => fake.handle } },
    views,
    { maxHeight: 3000, weekLabel: '2026-W45' },
  );
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual(fake.calls.screenshot[0].clip, { x: 0, y: 0, width: 720, height: 640 });
  assert.equal(fake.calls.screenshot[0].type, 'png');
});
