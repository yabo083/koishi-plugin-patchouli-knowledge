import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MediaPool } from '../lib/media/pool.js';

const ROOT = path.resolve('tmp/media-pool-test');

/** 每个用例一个干净的素材根目录。 */
async function freshDir(name) {
  const dir = path.join(ROOT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

function baseConfig(dir, overrides = {}) {
  return {
    dir,
    offline: false,
    lowWater: 3,
    batch: 3,
    cooldownMs: 60_000,
    imageSource: 'https://example.test/image?category=acg',
    sayingSource: 'https://example.test/saying',
    apiKey: '',
    ...overrides,
  };
}

/**
 * 只测消费（`take`）的用例用它：`take()` 出队后会 `void ensureFilled()` 后台补货，
 * 而 fetch 桩是进程级全局的——遗留的后台请求会在下一个用例换上自己的桩之后才真正发出，
 * 把对方的 `stub.calls` 数错（MEDIA-10「上游只被请求一批」实测随机数成 5）。
 * `lowWater: 0` 让后台补货在水位判断处同步短路；补货行为本身由 MEDIA-02 / MEDIA-10 覆盖。
 */
const takeOnlyConfig = (dir) => baseConfig(dir, { lowWater: 0 });

/** 用固定响应替换全局 fetch，返回调用计数与还原函数。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function imageResponse(bytes = 'jpeg-bytes') {
  return {
    ok: true,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => Buffer.from(bytes),
  };
}

function sayingResponse(text) {
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ text }) };
}

/** 永远失败的响应：用于让后台补货静默返回。 */
function failedResponse() {
  return { ok: false, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0), json: async () => ({}) };
}

test('MEDIA-01: 未配置目录时素材池完全禁用，take 与补货都不产生 I/O', async () => {
  const stub = stubFetch(imageResponse);
  try {
    const pool = new MediaPool(baseConfig(''));
    assert.equal(pool.enabled, false);
    assert.equal(await pool.take('image'), undefined);
    assert.equal(await pool.ensureFilled('image'), 0);
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

test('MEDIA-02: 低于水位时补到 batch 条，达到水位后不再请求', async () => {
  const dir = await freshDir('fill');
  const stub = stubFetch(imageResponse);
  try {
    const pool = new MediaPool(baseConfig(dir));
    assert.equal(await pool.ensureFilled('image'), 3);
    const files = await readdir(path.join(dir, 'image', 'pending'));
    assert.equal(files.length, 3);
    assert.equal(await pool.ensureFilled('image'), 0, '已达水位不重复补货');
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test('MEDIA-03: 在线模式消费即删除，返回可直接内嵌的 data URI', async () => {
  const dir = await freshDir('consume-online');
  await mkdir(path.join(dir, 'image', 'pending'), { recursive: true });
  await writeFile(path.join(dir, 'image', 'pending', '0000000000001-aaaa.jpeg'), 'bytes');
  const stub = stubFetch(failedResponse);
  try {
    const pool = new MediaPool(takeOnlyConfig(dir));
    const data = await pool.take('image');
    assert.match(String(data), /^data:image\/jpeg;base64,/u);
    assert.equal((await pool.stats('image')).pending, 0, '在线模式消费后文件被删除');
    assert.equal((await pool.stats('image')).used, 0);
  } finally {
    stub.restore();
  }
});

test('MEDIA-04: 按文件名 FIFO 取最早的一条', async () => {
  const dir = await freshDir('fifo');
  const pending = path.join(dir, 'saying', 'pending');
  await mkdir(pending, { recursive: true });
  await writeFile(path.join(pending, '0000000000002-bbbb.txt'), '第二条', 'utf8');
  await writeFile(path.join(pending, '0000000000001-aaaa.txt'), '第一条', 'utf8');
  const stub = stubFetch(failedResponse);
  try {
    const pool = new MediaPool(takeOnlyConfig(dir));
    assert.equal(await pool.take('saying'), '第一条');
    assert.equal(await pool.take('saying'), '第二条');
  } finally {
    stub.restore();
  }
});

test('MEDIA-05: 一言去重并截断到 120 字', async () => {
  const dir = await freshDir('saying');
  const long = '啊'.repeat(200);
  let call = 0;
  const stub = stubFetch(() => {
    call += 1;
    return sayingResponse(call === 1 ? '同一句话' : call === 2 ? '同一句话' : long);
  });
  try {
    const pool = new MediaPool(baseConfig(dir, { lowWater: 5, batch: 3 }));
    assert.equal(await pool.ensureFilled('saying'), 2, '重复句被丢弃');
    const files = await readdir(path.join(dir, 'saying', 'pending'));
    const texts = await Promise.all(
      files.map(async (name) => (await import('node:fs/promises')).readFile(path.join(dir, 'saying', 'pending', name), 'utf8')),
    );
    assert.equal(Math.max(...texts.map((text) => text.length)), 120);
  } finally {
    stub.restore();
  }
});

test('MEDIA-06: 离线模式不请求上游，消费转入 used 并在冷却后回到队列', async () => {
  const dir = await freshDir('offline');
  await mkdir(path.join(dir, 'image', 'pending'), { recursive: true });
  await writeFile(path.join(dir, 'image', 'pending', '0000000000001-aaaa.png'), 'png-bytes');
  const stub = stubFetch(imageResponse);
  try {
    const pool = new MediaPool(baseConfig(dir, { offline: true, cooldownMs: 1_000 }));
    assert.equal(await pool.ensureFilled('image'), 0, '离线模式不触网');
    assert.deepEqual(stub.calls, []);

    assert.match(String(await pool.take('image')), /^data:image\/png;base64,/u);
    assert.equal((await pool.stats('image')).pending, 0);
    assert.equal((await pool.stats('image')).used, 1);

    // 冷却未到：不可用。
    assert.equal(await pool.sweep('image', Date.now()), 0);
    assert.equal((await pool.stats('image')).pending, 0);

    // 冷却结束：回到 pending，再次可消费（环形缓冲）。
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await pool.sweep('image'), 1);
    assert.equal((await pool.stats('image')).pending, 1);
    assert.match(String(await pool.take('image')), /^data:image\/png;base64,/u);
  } finally {
    stub.restore();
  }
});

test('MEDIA-07: 上游 5xx / 非图片响应不写入任何文件', async () => {
  const dir = await freshDir('bad-upstream');
  const stub = stubFetch(() => ({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('<html>') }));
  try {
    const pool = new MediaPool(baseConfig(dir));
    assert.equal(await pool.ensureFilled('image'), 0);
    assert.deepEqual(await readdir(path.join(dir, 'image', 'pending')), []);
  } finally {
    stub.restore();
  }
});

test('MEDIA-08: 配置 apiKey 时附加 key 参数且保留既有查询串；未配置则匿名请求', async () => {
  const anonDir = await freshDir('anon');
  const anonStub = stubFetch(imageResponse);
  try {
    const pool = new MediaPool(baseConfig(anonDir));
    await pool.ensureFilled('image');
    assert.ok(!anonStub.calls.some((url) => url.includes('key=')), '未配置密钥不得带 key');
    assert.ok(anonStub.calls[0].includes('category=acg'), '既有查询串保留');
  } finally {
    anonStub.restore();
  }

  const keyedDir = await freshDir('keyed');
  const keyedStub = stubFetch(imageResponse);
  try {
    const pool = new MediaPool(baseConfig(keyedDir, { apiKey: 'secret-token' }));
    await pool.ensureFilled('image');
    assert.ok(keyedStub.calls.length > 0);
    const url = new URL(keyedStub.calls[0]);
    assert.equal(url.searchParams.get('key'), 'secret-token');
    assert.equal(url.searchParams.get('category'), 'acg');
    // 密钥只在请求里，不写进素材文件。
    const files = await readdir(path.join(keyedDir, 'image', 'pending'));
    assert.equal(files.length, 3);
  } finally {
    keyedStub.restore();
  }
});

test('MEDIA-09: 并发 take 串行消费，两个调用必须拿到不同文件', async () => {
  const dir = await freshDir('concurrent-take');
  const pending = path.join(dir, 'image', 'pending');
  await mkdir(pending, { recursive: true });
  await writeFile(path.join(pending, '0000000000001-aaaa.png'), 'first-bytes');
  await writeFile(path.join(pending, '0000000000002-bbbb.png'), 'second-bytes');
  const stub = stubFetch(failedResponse);
  try {
    const pool = new MediaPool(takeOnlyConfig(dir));
    const [left, right] = await Promise.all([pool.take('image'), pool.take('image')]);
    assert.ok(left !== undefined && right !== undefined, '两个并发 take 都要拿到素材');
    const expected = [
      `data:image/png;base64,${Buffer.from('first-bytes').toString('base64')}`,
      `data:image/png;base64,${Buffer.from('second-bytes').toString('base64')}`,
    ];
    assert.deepEqual([left, right].sort(), [...expected].sort(), '同一文件不得被两个消费者取走');
    assert.equal((await pool.stats('image')).pending, 0, '两个文件都已出队');
    assert.equal(pool.metrics.consumed, 2, '计数按真实消费次数累加');
  } finally {
    stub.restore();
  }
});

test('MEDIA-10: 并发 ensureFilled 只补一批（单飞在任何 await 之前生效）', async () => {
  const dir = await freshDir('single-flight');
  const stub = stubFetch(imageResponse);
  try {
    const pool = new MediaPool(baseConfig(dir));
    const results = await Promise.all([pool.ensureFilled('image'), pool.ensureFilled('image')]);
    assert.equal(results.reduce((sum, added) => sum + added, 0), 3, '两次调用合计只补一批');
    assert.equal(stub.calls.length, 3, '上游只被请求一批');
    assert.equal((await readdir(path.join(dir, 'image', 'pending'))).length, 3);
  } finally {
    stub.restore();
  }
});

test('MEDIA-11: used 冷却锚定消费时刻，素材生产时刻不参与判定', async () => {
  const dir = await freshDir('cooldown-anchor');
  const pending = path.join(dir, 'image', 'pending');
  await mkdir(pending, { recursive: true });
  const file = path.join(pending, '0000000000001-old.png');
  await writeFile(file, 'old-bytes');
  // 生产于 2 小时前：若按 mtime 判冷却，刚消费完就会被 sweep 立刻回收，冷却形同虚设。
  const producedAt = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  await utimes(file, producedAt, producedAt);
  const stub = stubFetch(imageResponse);
  try {
    const pool = new MediaPool(baseConfig(dir, { offline: true, cooldownMs: 60_000 }));
    assert.match(String(await pool.take('image')), /^data:image\/png;base64,/u);
    assert.equal((await readdir(path.join(dir, 'image', 'used'))).length, 1);
    assert.equal(await pool.sweep('image'), 0, '刚消费完仍在冷却，不得回收');
    assert.equal(await pool.sweep('image', Date.now() + 60_001), 1, '冷却结束才回收');
    assert.equal((await pool.stats('image')).pending, 1);
  } finally {
    stub.restore();
  }
});

test.after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
