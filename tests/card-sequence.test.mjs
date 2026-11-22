import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CardSequence } from '../lib/media/card-sequence.js';

const ROOT = path.resolve('tmp/card-seq-test');

async function freshFile(name) {
  const dir = path.join(ROOT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return path.join(dir, 'card-seq.json');
}

test('CARDSEQ-01: 每个群独立计数，各自从 1 开始', async () => {
  const file = await freshFile('per-channel');
  const seq = new CardSequence({ file });
  assert.equal(await seq.allocate('a', 'g1'), 1);
  assert.equal(await seq.allocate('b', 'g1'), 2);
  assert.equal(await seq.allocate('c', 'g2'), 1, '另一个群从 1 重来');
  assert.equal(await seq.allocate('d', 'g2'), 2);
  assert.equal(await seq.allocate('e', 'g3'), 1);
});

test('CARDSEQ-02: 同一词条重复分配沿用原号，与传入群无关', async () => {
  const file = await freshFile('stable');
  const seq = new CardSequence({ file });
  const first = await seq.allocate('entry-1', 'g1');
  assert.equal(await seq.allocate('entry-1', 'g1'), first);
  assert.equal(await seq.allocate('entry-1', 'g2'), first, '已分配过的词条不换号');
  assert.equal(await seq.allocate('entry-2', 'g1'), first + 1);
});

test('CARDSEQ-03: 跨实例延续（重启不重置），文件按群分桶', async () => {
  const file = await freshFile('persist');
  const first = new CardSequence({ file });
  await first.allocate('a', 'g1');
  await first.allocate('b', 'g1');
  await first.allocate('c', 'g2');

  const second = new CardSequence({ file });
  assert.equal(await second.allocate('d', 'g1'), 3, 'g1 接着数');
  assert.equal(await second.allocate('e', 'g2'), 2, 'g2 接着数');
  assert.equal(await second.allocate('a', 'g1'), 1, '旧词条的号仍在');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(raw, {
    version: 2,
    channels: {
      g1: { next: 4, map: { a: 1, b: 2, d: 3 } },
      g2: { next: 3, map: { c: 1, e: 2 } },
    },
  });
});

test('CARDSEQ-04: 同 id 并发只占一个号，不同 id 不重号', async () => {
  const file = await freshFile('concurrent');
  const seq = new CardSequence({ file });
  const same = await Promise.all([
    seq.allocate('x', 'g1'),
    seq.allocate('x', 'g1'),
    seq.allocate('x', 'g1'),
  ]);
  assert.equal(new Set(same).size, 1, '同一 id 并发分配必须同号');

  const many = await Promise.all(['p', 'q', 'r', 's'].map((id) => seq.allocate(id, 'g1')));
  assert.deepEqual([...many].sort((left, right) => left - right), [2, 3, 4, 5]);
  assert.equal(new Set(many).size, 4, '不同 id 不重号');
});

test('CARDSEQ-05: 文件损坏时从 1 重来且不抛', async () => {
  const file = await freshFile('corrupt');
  await writeFile(file, '{ not json', 'utf8');
  const seq = new CardSequence({ file });
  assert.equal(await seq.allocate('a', 'g1'), 1);
});

test('CARDSEQ-06: 未配置文件路径时只做内存计数', async () => {
  const seq = new CardSequence({ file: '' });
  assert.equal(await seq.allocate('a', 'g1'), 1);
  assert.equal(await seq.allocate('b', 'g1'), 2);
});

test.after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

test('CARDSEQ-07: 首次读取回收崩溃残留的陈旧 .tmp，保留新鲜临时文件', async () => {
  const file = await freshFile('stale-temp');
  const staleTemp = `${file}.tmp`;
  const liveTemp = `${file}.live.tmp`;
  await writeFile(staleTemp, '{ broken', 'utf8');
  await writeFile(liveTemp, '{ broken', 'utf8');
  const oldSeconds = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  await utimes(staleTemp, oldSeconds, oldSeconds);

  const seq = new CardSequence({ file });
  assert.equal(await seq.nextOf('g1'), 1, '主文件缺失时当空表');
  const names = await readdir(path.dirname(file));
  assert.ok(!names.includes('card-seq.json.tmp'), '陈旧孤儿临时文件必须被清掉');
  assert.ok(names.includes('card-seq.json.live.tmp'), '新鲜临时文件可能是活跃写入，不得误删');
});
