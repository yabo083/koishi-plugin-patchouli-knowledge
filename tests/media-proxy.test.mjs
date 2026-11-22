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
