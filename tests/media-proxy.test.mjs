import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { MediaRegistry, createMediaProxyHandler } from '../lib/index.js';

function context(id) {
  return { params: { id }, headers: {}, status: 200, body: null, set() {} };
}

test('MEDIA-IDLE: upstream headers do not disable response-body idle timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const registry = new MediaRegistry();
  const id = registry.register('a', 'http://media.example.test/stalled.mp4');
  let aborted = false;
  const upstream = new PassThrough();
  const handler = createMediaProxyHandler(registry, {
    timeoutMs: 1000,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async () => ({ status: 200, headers: { 'content-type': 'video/mp4' }, body: upstream, abort() { aborted = true; upstream.destroy(); } }),
  });
  const ctx = context(id);
  await handler(ctx);
  const failed = new Promise((resolve) => ctx.body.once('error', resolve));
  t.mock.timers.tick(1001);
  const error = await failed;
  assert.match(error.message, /媒体读取超时/);
  assert.equal(ctx.body.destroyed, true);
  assert.equal(aborted, true);
});

test('MEDIA-IPV6: public literal is pinned without DNS and streams bytes unchanged', async () => {
  const registry = new MediaRegistry();
  const id = registry.register('a', 'http://[2606:4700:4700::1111]/image.png');
  let pinned;
  const handler = createMediaProxyHandler(registry, {
    lookup: async () => { throw new Error('numeric literal must not use DNS'); },
    fetch: async (_target, options) => {
      pinned = [options.address, options.family];
      return { status: 200, headers: { 'content-type': 'image/png' }, body: Readable.from([Buffer.from('image-bytes')]) };
    },
  });
  const ctx = context(id);
  await handler(ctx);
  assert.equal(ctx.status, 200);
  const chunks = [];
  for await (const chunk of ctx.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'image-bytes');
  assert.deepEqual(pinned, ['2606:4700:4700::1111', 6]);
});

test('MEDIA-IPV6-MAPPED: IPv4 映射字面量在字面量直通分支即拒绝，不进 DNS / pinnedLookup / fetch', async () => {
  // 登记表用最小替身绕过「URL 阶段」：字面量直通分支本身必须拒绝映射写法
  for (const target of [
    'http://[::ffff:7f00:1]/a.png',
    'http://[::ffff:c0a8:101]/a.png',
    'http://[::ffff:a9fe:a9fe]/a.png',
    'http://[0:0:0:0:0:ffff:7f00:1]/a.png',
    'http://[::FFFF:A9FE:A9FE]/a.png',
    'http://[::ffff:8.8.8.8]/a.png',
    'https://[::ffff:808:808]/a.png',
  ]) {
    let fetched = false;
    let lookupCalls = 0;
    const handler = createMediaProxyHandler(
      { resolve: () => target },
      {
        lookup: async () => {
          lookupCalls += 1;
          throw new Error('numeric literal must not use DNS');
        },
        fetch: async () => {
          fetched = true;
          throw new Error('mapped literal must not be fetched');
        },
      },
    );
    const ctx = context('0123456789abcdef0123456789abcdef');
    await handler(ctx);
    assert.equal(ctx.status, 403, `${target} 必须 403`);
    assert.equal(fetched, false, `${target} 不得发起上游请求`);
    assert.equal(lookupCalls, 0, `${target} 不得走 DNS`);
  }
});

test('MEDIA-IPV6-MAPPED: 已登记的公网映射字面量（URL 规范化为 ::ffff:808:808）仍在 socket 层被拒绝', async () => {
  const registry = new MediaRegistry();
  // `http://[::ffff:8.8.8.8]/` 经 WHATWG 归一化为 `[::ffff:808:808]`，内嵌 IPv4 为公网 8.8.8.8
  const id = registry.register('a', 'http://[::ffff:8.8.8.8]/image.png');
  assert.ok(id, '规范化后的公网映射字面量能通过 URL 层登记');
  let fetched = false;
  const handler = createMediaProxyHandler(registry, {
    lookup: async () => {
      throw new Error('numeric literal must not use DNS');
    },
    fetch: async () => {
      fetched = true;
      throw new Error('mapped literal must not be fetched');
    },
  });
  const ctx = context(id);
  await handler(ctx);
  assert.equal(ctx.status, 403, '映射写法整体拒绝，与私网同路径');
  assert.equal(fetched, false);
});
