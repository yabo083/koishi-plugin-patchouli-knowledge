import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * review-loop 的两个判定点（`scripts/review-loop-io.mjs`）。
 *
 * 断言的都不是脚本长相，而是三次真踩过的失效：
 * - 多行审查正文被按行过滤拆断，prompt 只剩前半截（意见 = PR 评论 body）；
 * - 修复只新增文件时 `git diff` 看不见，本轮被当成「无改动」跳过推送；
 * - 推送失败仍推进已处理水位并继续触发审查，循环假收敛（修复从未发布）。
 */
const IO = fileURLToPath(new URL('../scripts/review-loop-io.mjs', import.meta.url));
const BOT = 'chatgpt-codex-connector';

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const gitSkip = HAS_GIT ? false : '环境没有 git，跳过依赖真实仓库的用例';

function run(...args) {
  return spawnSync(process.execPath, [IO, ...args], { encoding: 'utf8' });
}

/** 临时沙箱：git 仓库 / 公开工作树 / 裸远端都建在里面，结束即删。 */
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptx-loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败：${result.stderr}`);
  return result.stdout;
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'loop@example.test']);
  git(dir, ['config', 'user.name', 'review-loop']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
}

function jsonl(file, comments) {
  fs.writeFileSync(file, comments.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
}

test('COLLECT-01: 多行正文整条进 prompt，不被当成续行丢掉', (t) => {
  const root = sandbox(t);
  const state = path.join(root, 'state');
  const comments = path.join(root, 'comments.jsonl');
  const prompt = path.join(root, 'prompt.md');
  fs.writeFileSync(state, '100\n', 'utf8');

  /* 正文里有空行、代码块、制表符与二次出现的 `###`：任何一种按行展开的写法都会错位 */
  const body = '结论：这条仍然成立。\n\n```ts\nconst step = 1;\t// 制表符\n```\n\n### 补充\n最后一行必须出现在 prompt 里。';

  jsonl(comments, [
    { id: 99, path: 'old.ts', line: 1, user: { login: `${BOT}[bot]` }, body: '水位之前的旧意见' },
    { id: 101, path: 'scripts/review-loop.sh', line: 28, user: { login: `${BOT}[bot]` }, body },
    { id: 102, path: 'other.ts', line: 2, user: { login: 'human' }, body: '路人评论' },
  ]);

  const result = run('collect', '--in', comments, '--state-file', state, '--prompt', prompt, '--bot', BOT, '--pr', '4');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1 101', '只算水位之后的机器人意见，并报出最大 id');

  const text = fs.readFileSync(prompt, 'utf8');
  assert.ok(text.includes(body), '正文逐字保留（空行 / 制表符 / 代码块都在）');
  assert.ok(text.includes('### scripts/review-loop.sh:28'), '位置头保留');
  assert.ok(!text.includes('水位之前的旧意见'), '已处理意见不再进 prompt');
  assert.ok(!text.includes('路人评论'), '非审查机器人评论过滤掉');
});

test('COLLECT-02: 没有新意见时不写 prompt、报 0', (t) => {
  const root = sandbox(t);
  const state = path.join(root, 'state');
  const comments = path.join(root, 'comments.jsonl');
  const prompt = path.join(root, 'prompt.md');
  fs.writeFileSync(state, '101\n', 'utf8');
  jsonl(comments, [{ id: 101, path: 'a.ts', line: 1, user: { login: `${BOT}[bot]` }, body: '已处理' }]);

  const result = run('collect', '--in', comments, '--state-file', state, '--prompt', prompt, '--bot', BOT, '--pr', '4');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0 0');
  assert.equal(fs.existsSync(prompt), false, '无意见不落 prompt 文件');
});

test('PUBLISH-01: 只新增未跟踪文件也算有改动 —— 提交、推送、推进水位', { skip: gitSkip }, (t) => {
  const root = sandbox(t);
  const project = path.join(root, 'project');
  const publicDir = path.join(root, 'pk-loop');
  const origin = path.join(root, 'origin.git');
  const state = path.join(root, 'state');
  fs.writeFileSync(state, '100\n', 'utf8');

  initRepo(project);
  initRepo(publicDir);
  spawnSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8' });
  git(publicDir, ['remote', 'add', 'origin', origin]);
  git(publicDir, ['push', '-q', 'origin', 'HEAD']);

  /* 修复只新增一个文件：`git diff` / `git diff --cached` 都看不见它 */
  fs.writeFileSync(path.join(project, 'new-fix.txt'), 'fix\n');
  /* 导出步骤的等价物：新文件落进公开工作树 */
  fs.writeFileSync(path.join(publicDir, 'new-fix.txt'), 'fix\n');

  const result = run(
    'publish', '--project', project, '--public', publicDir, '--state-file', state,
    '--max-id', '101', '--message', 'fix(review): 第 1 轮\n\n详见 tmp/review-loop/prompt-1.md',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^pushed [0-9a-f]+\n?$/, '报告已推送并带上短 sha');
  assert.equal(fs.readFileSync(state, 'utf8').trim(), '101', '推送成功才推进水位');
  assert.equal(git(origin, ['show', 'main:new-fix.txt']), 'fix\n', '远端真的拿到了这次修复');
});

test('PUBLISH-02: 工作树干净 → 不提交不推送、水位不动', { skip: gitSkip }, (t) => {
  const root = sandbox(t);
  const project = path.join(root, 'project');
  const publicDir = path.join(root, 'pk-loop');
  const origin = path.join(root, 'origin.git');
  const state = path.join(root, 'state');
  fs.writeFileSync(state, '100\n', 'utf8');

  initRepo(project);
  initRepo(publicDir);
  spawnSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8' });
  git(publicDir, ['remote', 'add', 'origin', origin]);
  git(publicDir, ['push', '-q', 'origin', 'HEAD']);
  const head = git(origin, ['rev-parse', 'main']);

  const result = run(
    'publish', '--project', project, '--public', publicDir, '--state-file', state,
    '--max-id', '101', '--message', 'fix(review): 第 1 轮',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'clean');
  assert.equal(fs.readFileSync(state, 'utf8').trim(), '100', '无改动不推进水位');
  assert.equal(git(origin, ['rev-parse', 'main']), head, '远端没多出提交');
});

test('PUBLISH-03: 推送失败 → 非零退出且水位不推进（调用方据此终止）', { skip: gitSkip }, (t) => {
  const root = sandbox(t);
  const project = path.join(root, 'project');
  const publicDir = path.join(root, 'pk-loop');
  const state = path.join(root, 'state');
  fs.writeFileSync(state, '100\n', 'utf8');

  initRepo(project);
  initRepo(publicDir);
  /* 远端不存在：`git push` 必然失败，等价于网络 / 认证 / 被拒 */
  git(publicDir, ['remote', 'add', 'origin', path.join(root, 'missing.git')]);

  fs.writeFileSync(path.join(project, 'new-fix.txt'), 'fix\n');
  fs.writeFileSync(path.join(publicDir, 'new-fix.txt'), 'fix\n');

  const result = run(
    'publish', '--project', project, '--public', publicDir, '--state-file', state,
    '--max-id', '101', '--message', 'fix(review): 第 1 轮',
  );
  assert.notEqual(result.status, 0, '推送失败必须让调用方看见失败');
  assert.match(result.stderr, /git push/, '失败原因指向推送');
  assert.equal(fs.readFileSync(state, 'utf8').trim(), '100', '水位没动：下一轮还要捡回这批意见');
});
