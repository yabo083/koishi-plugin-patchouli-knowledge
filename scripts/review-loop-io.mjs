#!/usr/bin/env node
/**
 * review-loop.sh 的两个判定点。抽成独立进程是为了能测：多行正文的拼装、未跟踪文件的改动判定、
 * 以及「推送成功才算处理过」的水位推进，都是靠猜会猜错的地方。
 *
 *   node scripts/review-loop-io.mjs collect --in <gh JSONL> --state-file <f> --prompt <f> --bot <login> --pr <n>
 *   node scripts/review-loop-io.mjs publish --project <dir> --public <dir> --state-file <f> --max-id <n> --message <text>
 *
 * collect：gh 侧的 `--jq '.[] | … | tojson'` 一行一条意见，正文里的换行留在 JSON 字符串里转义，
 *   不会被拆成多行再被下游按行过滤丢掉。只有拼 prompt 时才还原成真实换行。
 *   stdout 打印 `<条数> <最大 id>`，无新意见时打印 `0 0` 且不写 prompt。
 *
 * publish：工作树有任何改动（含未跟踪文件）才提交推送；推送成功后才把已处理水位写成 `--max-id`。
 *   stdout 打印 `pushed <sha>` 或 `clean`（无改动）；任何一步失败都以非零码退出，水位保持原值，
 *   调用方必须据此终止——带着未发布的修复去触发下一轮审查会让脚本假收敛。
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (typeof key !== 'string' || !key.startsWith('--')) throw new Error(`未知参数：${key}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`参数缺值：${key}`);
    flags[key.slice(2)] = value;
  }
  return { command, flags };
}

function need(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value === '') throw new Error(`缺少 --${name}`);
  return value;
}

async function readOr(file, fallback) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** 提示词头部：与 review-loop.sh 的调用口径一致，只有 PR 号是变量。 */
function preamble(pr) {
  return [
    '# 任务',
    `以下是 PR #${pr} 上自动审查的未处理意见。逐条对照当前代码核实，**只修仍然成立的问题**；`,
    '如果某条属于已知限制或已有等价修复，写明理由后跳过（不要为凑数改动）。',
    '',
    '## 硬约束',
    '- TypeScript 严格无 `any`；不降低既有测试语义；每条修复补一个用例。',
    '- 不 commit、不 tag、不部署、不修改 `.context/` 之外的文档口径。',
    '- 完成后跑 `npx tsc --noEmit`、`pnpm build`、`pnpm test`，全绿才算完成。',
    '',
    '## 意见',
    '',
  ].join('\n');
}

/** gh 的 JSONL 里每条意见是一整行 JSON；正文换行已转义，所以这里不会出现续行。 */
function parseComments(raw, source) {
  const comments = [];
  raw.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      comments.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${source}:${index + 1} 不是合法 JSON：${err.message}`);
    }
  });
  return comments;
}

async function collect(flags) {
  const input = need(flags, 'in');
  const stateFile = need(flags, 'state-file');
  const promptFile = need(flags, 'prompt');
  const bot = need(flags, 'bot');
  const pr = need(flags, 'pr');

  const watermark = Number.parseInt((await readOr(stateFile, '0')).trim(), 10);
  const pending = parseComments(await readOr(input, ''), input)
    .filter((c) => typeof c?.user?.login === 'string' && c.user.login.startsWith(bot))
    .filter((c) => Number.isFinite(c?.id) && c.id > (Number.isFinite(watermark) ? watermark : 0))
    .sort((a, b) => a.id - b.id);

  if (pending.length === 0) {
    process.stdout.write('0 0\n');
    return;
  }

  const sections = pending.map((c) => {
    const line = c.line ?? c.original_line ?? '?';
    const body = typeof c.body === 'string' ? c.body.replace(/\r\n/g, '\n').trimEnd() : '';
    return `### ${c.path}:${line}\n\n${body}\n`;
  });
  await fs.writeFile(promptFile, preamble(pr) + sections.join('\n'), 'utf8');
  process.stdout.write(`${pending.length} ${pending[pending.length - 1].id}\n`);
}

function git(dir, args, input) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git 无法执行：${result.error.message}`);
  return result;
}

function failed(step, result) {
  const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 4).join(' ');
  return new Error(`${step}失败：${detail || `git 退出码 ${result.status}`}`);
}

async function publish(flags) {
  const project = need(flags, 'project');
  const target = need(flags, 'public');
  const stateFile = need(flags, 'state-file');
  const maxId = Number.parseInt(need(flags, 'max-id'), 10);
  if (!Number.isFinite(maxId)) throw new Error('--max-id 必须是数字');
  const message = need(flags, 'message');

  /* 改动判定必须含未跟踪文件：修复经常新增文件，`git diff` 两条都看不见它，
     那样会把「只新增了一个文件」当成「本轮无改动」而跳过导出与推送。 */
  const status = git(project, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0) throw failed('读工作树状态', status);
  if (status.stdout.trim() === '') {
    process.stdout.write('clean\n');
    return;
  }

  const repo = git(target, ['rev-parse', '--git-dir']);
  if (repo.status !== 0) throw new Error(`公开工作树不存在：${target}`);

  const add = git(target, ['add', '-A']);
  if (add.status !== 0) throw failed('git add ', add);

  /* 暂存区为空（改动只在导出白名单之外）不是错误：仍走推送对齐分支，但不上报「已提交」。 */
  if (git(target, ['diff', '--cached', '--quiet']).status === 1) {
    const commit = git(target, ['commit', '-q', '-F', '-'], message);
    if (commit.status !== 0) throw failed('git commit ', commit);
  }

  const push = git(target, ['push', '-q', 'origin', 'HEAD']);
  if (push.status !== 0) throw failed('git push ', push);

  /* 水位只在推送成功之后推进：发布失败时下一轮必须还能重新捡起同一批意见。 */
  await fs.writeFile(stateFile, `${maxId}\n`, 'utf8');
  const head = git(target, ['rev-parse', '--short', 'HEAD']);
  process.stdout.write(`pushed ${head.stdout.trim()}\n`);
}

const { command, flags } = parseArgs(process.argv.slice(2));
try {
  if (command === 'collect') await collect(flags);
  else if (command === 'publish') await publish(flags);
  else throw new Error(`未知子命令：${command ?? '(空)'}（可用：collect / publish）`);
} catch (err) {
  process.stderr.write(`review-loop-io: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
