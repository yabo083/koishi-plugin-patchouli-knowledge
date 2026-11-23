#!/usr/bin/env node
/**
 * 导出一份可公开的干净快照，并做发布前的敏感信息扫描。
 *
 *   node scripts/export-public.mjs [目标目录]
 *
 * 白名单之外的一切（`.context/` 协作记录、`AGENTS.md` 宪法、`roadmap.md`、
 * 构建产物 `lib/`、依赖 `node_modules/`、临时目录）都不会进入快照。
 * 扫描命中真实群号 / 内网主机 / 密钥形状时直接失败，避免把部署信息推出去。
 *
 * 设计取向：宁可漏文件，也不漏信息。新增顶层文件时先确认它能否公开，再加白名单。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/u, '$1'));
const TARGET = path.resolve(process.argv[2] ?? path.join(REPO, '..', 'patchouli-knowledge-public'));

/** 只导出这些顶层条目（顺序即复制顺序）。 */
const WHITELIST = [
  'LICENSE',
  'README.md',
  '.github',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  '.gitignore',
  'src',
  'tests',
  'docs',
  'client',
  'scripts',
];

/** 白名单内部仍需剔除的路径片段。 */
const EXCLUDE_SEGMENTS = ['node_modules', 'lib', 'tmp', '.gemini-designer'];

/**
 * 按相对路径精确排除的文件。
 *
 * `docs/preview-cards.html` 内嵌真实词条正文（已脱敏昵称，但讨论内容属于群内语境），
 * 不随开源快照发布；需要预览效果时由维护者本地生成。
 */
const EXCLUDE_FILES = ['docs/preview-cards.html'];

/** 发布前必须为空的敏感模式：命中即中止（宁可人工确认，也不静默放过）。 */
const FORBIDDEN = [
  { pattern: /\b(?:854365377|966138163|635492503|836510950)\b/u, label: '真实群号' },
  { pattern: /bren9np|long\.moyuu\.cc/iu, label: '部署主机 / 私有端点' },
  { pattern: /\/root\/\.koishi/iu, label: '服务器绝对路径' },
  { pattern: /[A-Z]:\\Codes\\/iu, label: '本地绝对路径' },
  { pattern: /\bsk-[A-Za-z0-9]{16,}/u, label: '疑似 API Key' },
];

const TEXT_EXT = new Set(['.md', '.ts', '.js', '.mjs', '.cjs', '.json', '.html', '.yml', '.yaml', '.txt']);

async function copyEntry(source, destination, report) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    const names = await fs.readdir(source);
    await fs.mkdir(destination, { recursive: true });
    for (const name of names) {
      if (EXCLUDE_SEGMENTS.includes(name)) continue;
      await copyEntry(path.join(source, name), path.join(destination, name), report);
    }
    return;
  }
  if (EXCLUDE_SEGMENTS.includes(path.basename(source))) return;
  if (EXCLUDE_FILES.includes(path.relative(REPO, source).replaceAll('\\', '/'))) return;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  report.files += 1;
  // 扫描器自身包含模式串，必须排除，否则永远自命中
  if (path.relative(REPO, source).replaceAll('\\', '/') === 'scripts/export-public.mjs') return;
  if (!TEXT_EXT.has(path.extname(source).toLowerCase())) return;
  const text = await fs.readFile(source, 'utf8');
  for (const { pattern, label } of FORBIDDEN) {
    const match = pattern.exec(text);
    if (match !== null) report.hits.push(`${path.relative(REPO, source)}: [${label}] ${match[0]}`);
  }
}

const report = { files: 0, hits: [] };
// 目标目录通常就是公开仓库的工作树：只清内容、保留 `.git`，否则每次导出都会丢掉
// 提交历史，强制重走 init/fetch（2026-11-23 踩过）。
await fs.mkdir(TARGET, { recursive: true });
for (const name of await fs.readdir(TARGET)) {
  if (name === '.git') continue;
  await fs.rm(path.join(TARGET, name), { recursive: true, force: true });
}

for (const entry of WHITELIST) {
  const source = path.join(REPO, entry);
  try {
    await copyEntry(source, path.join(TARGET, entry), report);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.warn(`[export] 跳过不存在的顶层条目: ${entry}`);
      continue;
    }
    throw error;
  }
}

console.log(`[export] 目标目录: ${TARGET}`);
console.log(`[export] 已复制 ${report.files} 个文件`);

if (report.hits.length > 0) {
  console.error(`\n[export] 发现 ${report.hits.length} 处敏感信息，已中止发布：`);
  for (const hit of report.hits.slice(0, 40)) console.error(`  - ${hit}`);
  process.exit(1);
}

console.log('[export] 敏感扫描通过：无真实群号 / 内网主机 / 密钥形状命中');
console.log('[export] 下一步：cd 到目标目录 → git init → 提交 → 推到公开仓库');
