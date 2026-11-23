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
 * 精确名单（真实群号 / 相册 ID / QQ 号）不进仓库——脚本本身就会发布：从
 * `tmp/forbidden-ids.json` 或环境变量 `PATCHOULI_FORBIDDEN_IDS` 读；读不到时退化为
 * 形状检测并 warn（误报变多，强度下降）。
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

/**
 * 恒定形状（不含任何真实主机名 / 群号：那些走外部精确名单，见下）。
 * 命中即中止（宁可人工确认，也不静默放过）。
 */
const BASE_FORBIDDEN = [
  { pattern: /\/root\/\.koishi/iu, label: '服务器绝对路径' },
  { pattern: /[A-Z]:\\Codes\\/iu, label: '本地绝对路径' },
  { pattern: /\bsk-[A-Za-z0-9]{16,}/u, label: '疑似 API Key' },
];

/**
 * 精确名单（真实群号 / 相册 ID / QQ 号 / 部署主机名）**绝不写进仓库**：本脚本会随公开
 * 快照发布，把名单写在这里等于自己把名单带出去。
 *
 * 读取顺序：环境变量 `PATCHOULI_FORBIDDEN_IDS`（逗号分隔）→ `tmp/forbidden-ids.json`
 * （`tmp/` 已 gitignore；内容是字符串数组，或 `{ ids: [...] }`；逐条按整词匹配）。
 * 两者都读不到时退化为形状检测并 warn：拦截强度下降（误报变多），但明显泄漏仍会被拦下。
 * 文件存在但内容为空数组 = 运维显式清空名单，此时不做形状检测。
 */
const EXACT_IDS_FILE = path.join(REPO, 'tmp', 'forbidden-ids.json');
const EXACT_IDS_ENV = 'PATCHOULI_FORBIDDEN_IDS';

/**
 * 形状检测（精确名单未加载时的回退）。每条都收窄到「一眼像敏感值」的形态，
 * 否则干净树自己就过不去（假阳性会淹没真命中）：
 *
 * - 群号 / QQ 号：9–12 位，排除我们自己的虚构前缀 `1000000xx`，且不接在小数点 / 数字后
 *   （吃掉测试里的浮点尾数）。
 * - 内网主机：带端口的完整 IPv4 私网四段（形如 `192.168.x.x:3000`，此处不写实数）。
 *   **不带端口的不算**：`tests/auth.test.mjs` 的私网判定用例与
 *   `tests/rich-message.test.mjs` 的拒收用例必须出现裸私网地址，那是被测行为本身，
 *   不能当泄漏。
 * - 相册 ID：32 位以上且**大小写 + 数字混排**——纯驼峰标识符不含数字，不再误报。
 *
 * 另外形状检测按行进行并跳过超长行（内嵌 base64 资源 / 压缩产物）：真实泄漏的
 * 群号 / 相册 ID 不会只出现在 100KB 的单行里，而资源行会让每个 32 位串都误报。
 */
const MAX_SHAPE_LINE = 2000;

/**
 * 生成文件不参与形状检测：`pnpm-lock.yaml` 里的 32+ 位混排串全是 npm 的完整性哈希
 * （base64 段被 `+` / `/` 切碎，长短不一），必然误报。精确名单仍扫全文。
 */
const SHAPE_SKIP_FILES = new Set(['pnpm-lock.yaml']);

const SHAPE_FORBIDDEN = [
  { pattern: /(?<![\d.])\b(?!1000000)[1-9]\d{8,11}\b/u, label: '疑似群号 / QQ 号（形状检测）', shape: true },
  {
    pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}:\d{2,5}\b/u,
    label: '内网主机:端口（形状检测）',
    shape: true,
  },
  {
    // 上限 64：真实相册 ID 是 33 位上下；更长的整串是 base64 段 / 哈希，不当相册 ID。
    pattern:
      /\b(?=[A-Za-z0-9]{32,64}\b)(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,64}\b/u,
    label: '疑似相册 ID（形状检测）',
    shape: true,
  },
];

/** 读精确名单：返回 `string[]`（可能为空），读不到返回 `null`（调用方退化为形状检测）。 */
async function loadExactIds() {
  const fromEnv = (process.env[EXACT_IDS_ENV] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (fromEnv.length > 0) return fromEnv;
  try {
    const parsed = JSON.parse(await fs.readFile(EXACT_IDS_FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.ids;
    if (!Array.isArray(list)) throw new Error('名单格式应为字符串数组或 { ids: [...] }');
    return list.map((value) => String(value).trim()).filter((value) => value !== '');
  } catch {
    return null;
  }
}

/** 组装本轮生效的模式表：精确名单（或形状回退）+ 恒定的路径 / 密钥形状。 */
function buildForbidden(exactIds) {
  const exact =
    exactIds === null
      ? SHAPE_FORBIDDEN
      : exactIds.map((id) => ({
          // 不用 `\b`：名单里可能有 `.` 之类的非词字符（主机名、相册 ID）。
          pattern: new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9])`, 'u'),
          label: '精确名单命中',
        }));
  return [...exact, ...BASE_FORBIDDEN];
}

const TEXT_EXT = new Set(['.md', '.ts', '.js', '.mjs', '.cjs', '.json', '.html', '.yml', '.yaml', '.txt']);

async function copyEntry(source, destination, report, forbidden) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    const names = await fs.readdir(source);
    await fs.mkdir(destination, { recursive: true });
    for (const name of names) {
      if (EXCLUDE_SEGMENTS.includes(name)) continue;
      await copyEntry(path.join(source, name), path.join(destination, name), report, forbidden);
    }
    return;
  }
  if (EXCLUDE_SEGMENTS.includes(path.basename(source))) return;
  if (EXCLUDE_FILES.includes(path.relative(REPO, source).replaceAll('\\', '/'))) return;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  report.files += 1;
  if (!TEXT_EXT.has(path.extname(source).toLowerCase())) return;
  const text = await fs.readFile(source, 'utf8');
  const relative = path.relative(REPO, source).replaceAll('\\', '/');
  for (const { pattern, label, shape } of forbidden) {
    if (shape === true) {
      if (SHAPE_SKIP_FILES.has(relative)) continue;
      // 资源 / 压缩行不参与形状检测，见 SHAPE_FORBIDDEN 上的说明。
      for (const line of text.split('\n')) {
        if (line.length > MAX_SHAPE_LINE) continue;
        const hit = pattern.exec(line);
        if (hit !== null) {
          report.hits.push(`${relative}: [${label}] ${hit[0]}`);
          break;
        }
      }
      continue;
    }
    const match = pattern.exec(text);
    if (match !== null) report.hits.push(`${relative}: [${label}] ${match[0]}`);
  }
}

const report = { files: 0, hits: [] };
const exactIds = await loadExactIds();
if (exactIds === null) {
  console.warn(
    '[export] 精确名单未加载（tmp/forbidden-ids.json / PATCHOULI_FORBIDDEN_IDS），改用形状检测：误报会变多，发布前请补上名单。',
  );
}
const forbidden = buildForbidden(exactIds);
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
    await copyEntry(source, path.join(TARGET, entry), report, forbidden);
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
