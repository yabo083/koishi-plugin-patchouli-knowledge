import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  Config,
  DEFAULT_WIKI_SUBDIR,
  ensureWikiLayout,
  flattenConfig,
  resolveWikiDir,
  resolveWikiLayout,
} from '../lib/index.js';

const TEST_BASE_DIR = path.resolve('tmp/base-instance');

test('LAYOUT-01: wikiDir 未配置时默认锚定 baseDir/data/llmwiki', () => {
  assert.equal(DEFAULT_WIKI_SUBDIR, 'data/llmwiki');
  assert.equal(resolveWikiDir(undefined, TEST_BASE_DIR), path.join(TEST_BASE_DIR, 'data', 'llmwiki'));
  assert.equal(resolveWikiDir('   ', TEST_BASE_DIR), path.join(TEST_BASE_DIR, 'data', 'llmwiki'));
  // 缺省 baseDir 时回退进程 cwd
  assert.equal(resolveWikiDir(undefined), path.resolve('data/llmwiki'));
});

test('LAYOUT-02: 相对路径基于 baseDir 锚定，绝对路径原样使用', () => {
  assert.equal(resolveWikiDir('data/llmwiki', TEST_BASE_DIR), path.join(TEST_BASE_DIR, 'data', 'llmwiki'));
  assert.equal(resolveWikiDir('./wiki-store', TEST_BASE_DIR), path.join(TEST_BASE_DIR, 'wiki-store'));
  assert.equal(resolveWikiDir('../shared/llmwiki', TEST_BASE_DIR), path.resolve(TEST_BASE_DIR, '../shared/llmwiki'));

  const absolute = path.resolve('tmp/absolute-llmwiki');
  assert.equal(resolveWikiDir(absolute, TEST_BASE_DIR), absolute, '绝对路径不得被 baseDir 二次拼接');
});

test('LAYOUT-03: Config 的 storage.wikiDir 默认即 data/llmwiki（相对 baseDir）', () => {
  const resolved = flattenConfig(Config({}));
  assert.equal(resolved.storage.wikiDir, 'data/llmwiki');
  assert.equal(
    resolveWikiDir(resolved.storage.wikiDir, TEST_BASE_DIR),
    path.join(TEST_BASE_DIR, 'data', 'llmwiki'),
  );
});

test('LAYOUT-04: ensureWikiLayout 建全 raw/sessions、wiki/debates、.patchouli 三段骨架', async () => {
  const root = path.resolve('tmp/layout-skeleton');
  await fs.rm(root, { recursive: true, force: true });

  const layout = await ensureWikiLayout(root);

  assert.equal(layout.rootDir, root);
  assert.equal(layout.indexPath, path.join(root, 'index.md'));
  assert.equal(layout.logPath, path.join(root, 'log.md'));

  for (const dir of [layout.rawSessionsDir, layout.entryDir, layout.patchouliDir]) {
    assert.ok((await fs.stat(dir)).isDirectory(), `缺失目录: ${dir}`);
  }
  assert.equal(layout.rawSessionsDir, path.join(root, 'raw', 'sessions'));
  assert.equal(layout.entryDir, path.join(root, 'wiki', 'debates'));
  assert.equal(layout.patchouliDir, path.join(root, '.patchouli'));
  assert.equal(layout.storePath, path.join(root, '.patchouli', 'store.json'));

  // 幂等：重复调用不报错，且不会破坏已有文件
  const marker = path.join(layout.entryDir, 'keep.md');
  await fs.writeFile(marker, '# keep\n', 'utf8');
  await ensureWikiLayout(root);
  assert.equal(await fs.readFile(marker, 'utf8'), '# keep\n');

  assert.deepEqual(resolveWikiLayout(root), layout);

  await fs.rm(root, { recursive: true, force: true });
});
