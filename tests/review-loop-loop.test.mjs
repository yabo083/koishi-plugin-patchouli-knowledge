import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * review-loop.sh 的轮次控制（外部命令全部换成记账桩，被测的是脚本自己的判定）。
 *
 * 断言的都不是脚本长相，而是三次会假收敛的失效：
 * - `omp` 非零退出（本轮修复没跑完）时工作树里还压着上一轮的改动，VERIFY 会对着旧代码判绿，
 *   一发布就把本轮意见记成「已处理」；
 * - `gh pr comment` 失败时脚本仍等审查超时再退出 0，水位已推进而审查从未触发；
 * - 水位跨 PR 共用一份，第二个 PR 上编号更小的意见被直接判成「已处理」。
 *
 * 沙箱：临时目录里放 wrapper + 工作目录 + 公开工作树，`REVIEW_LOOP_WORK` 指过去，
 * 绝不碰真实 tmp/review-loop（那正是正在运行的循环的现场）。被测脚本仍是仓库里的那一份：
 * PROJECT 由它自己的路径推出来，stub 通过导出给子 bash 的 shell 函数注入。
 */
const SCRIPT = fileURLToPath(new URL('../scripts/review-loop.sh', import.meta.url)).replaceAll('\\', '/');
const SCRIPT_DIR = path.posix.dirname(SCRIPT);

/** 找一个**能读本仓库路径**的 bash：Windows 上 PATH 里的 `bash` 可能是 WSL 的，
 *  它看不见 NTFS 路径，也读不到 `E:/…` 这种参数，跑起来只会全盘失败。 */
function findBash() {
  const candidates = [process.env.REVIEW_LOOP_BASH, 'bash'];
  /* git-for-windows 自带 bash：`<git>/mingw64/libexec/git-core` 往上三级就是安装根目录。
     POSIX 的 resolve 认不出盘符路径，这里按段砍。 */
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (execPath.status === 0) {
    const root = execPath.stdout.trim().replaceAll('\\', '/').replace(/(?:\/[^/]+){3}$/, '');
    candidates.push(`${root}/bin/bash.exe`, `${root}/usr/bin/bash.exe`);
  }
  for (const bin of candidates.filter(Boolean)) {
    const probe = spawnSync(bin, ['-c', 'test -d "$1"', '_', SCRIPT_DIR], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
}

const BASH = findBash();
const bashSkip = BASH ? false : '环境没有能读本仓库的 bash（例如 WSL 的 bash），跳过依赖真实脚本的用例';

const STUBS = `
script="$1"; shift
gh() {
  case "$*" in
    *pr\\ comment*) return "\${GH_COMMENT_EXIT:-0}" ;;
    *api\\ repos/*) printf '1\\n'; return 0 ;;
  esac
  return 0
}
omp() { return "\${OMP_EXIT:-0}"; }
mise() {
  case "$*" in
    *"pnpm test"*) printf 'ℹ fail 0\\n' ;;
  esac
  return 0
}
timeout() { shift; "$@"; }
sleep() { :; }
node() {
  printf '%s\\n' "$*" >> "\${STUB_LOG:?}"
  case "\${2:-}" in
    collect) printf '1 1000\\n' ;;
    publish) printf 'pushed stub123\\n' ;;
  esac
  return 0
}
export -f gh omp mise timeout sleep node
exec bash "$script" "$@"
`;

/** 沙箱：wrapper、工作目录、带 .git 的公开工作树。 */
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const posix = (p) => p.replaceAll('\\', '/');
  const dirs = {
    work: path.join(root, 'work'),
    public: path.join(root, 'public'),
    log: path.join(root, 'stub.log'),
  };
  fs.mkdirSync(dirs.work, { recursive: true });
  fs.mkdirSync(dirs.public, { recursive: true });
  /* 脚本只判 `.git` 是否存在（工作树的 .git 是文件，不带 /）。 */
  fs.writeFileSync(path.join(dirs.public, '.git'), 'gitdir: nowhere\n', 'utf8');
  const wrapper = path.join(root, 'run.sh');
  fs.writeFileSync(wrapper, `#!/usr/bin/env bash\n${STUBS}`, 'utf8');

  return {
    posix,
    dirs,
    /** 跑一轮：返回退出码与 node 桩收到的全部调用。 */
    run(pr, extraEnv = {}) {
      fs.writeFileSync(dirs.log, '', 'utf8');
      fs.writeFileSync(
        path.join(dirs.work, `state-${pr}`),
        extraEnv.WATERMARK === undefined ? '0\n' : `${extraEnv.WATERMARK}\n`,
        'utf8',
      );
      const result = spawnSync(BASH, [wrapper, SCRIPT, String(pr), '1'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          REVIEW_LOOP_WORK: posix(dirs.work),
          REVIEW_PUBLIC: posix(dirs.public),
          STUB_LOG: posix(dirs.log),
          ...extraEnv,
        },
      });
      return {
        status: result.status,
        output: `${result.stdout || ''}${result.stderr || ''}`,
        calls: fs.readFileSync(dirs.log, 'utf8').split('\n').filter(Boolean),
      };
    },
  };
}

const published = (calls) => calls.filter((line) => /review-loop-io\.mjs publish/.test(line));
const collected = (calls) => calls.filter((line) => /review-loop-io\.mjs collect/.test(line));

test('LOOP-01: omp 非零退出 = 本轮修复未完成 —— 不验证、不发布、不推进水位', { skip: bashSkip }, (t) => {
  const box = sandbox(t);
  const run = box.run(42, { OMP_EXIT: '3' });

  assert.equal(run.status, 5, `omp 失败必须终止循环，实际退出码 ${run.status}：\n${run.output}`);
  assert.deepEqual(published(run.calls), [], '修复没跑完就发布：水位的意见会被记成已处理');
  assert.equal(fs.readFileSync(path.join(box.dirs.work, 'state-42'), 'utf8').trim(), '0', '水位保持原值');
});

test('LOOP-02: gh pr comment 失败 → 非零退出，不当成循环收敛', { skip: bashSkip }, (t) => {
  const box = sandbox(t);
  const run = box.run(42, { GH_COMMENT_EXIT: '1' });

  assert.equal(run.status, 6, `触发失败必须以非零码结束，实际 ${run.status}：\n${run.output}`);
  assert.equal(published(run.calls).length, 1, '本轮已发布（水位已推进）：失败发生在触发审查这一步');
  assert.match(run.output, /触发下一轮审查失败/, '日志必须说清终止原因');
});

test('LOOP-03: 已处理水位按 PR 分开 —— 换 PR 不会吃掉它编号更小的意见', { skip: bashSkip }, (t) => {
  const box = sandbox(t);
  const first = box.run(42);
  const second = box.run(43);

  assert.equal(first.status, 0, `第一轮应正常结束：\n${first.output}`);
  assert.equal(second.status, 0, `第二轮应正常结束：\n${second.output}`);

  const stateOf = (calls) => {
    const line = collected(calls)[0] ?? '';
    const match = line.match(/--state-file (\S+)/);
    assert.ok(match, `collect 必须带 --state-file：${line}`);
    return match[1];
  };
  const stateA = stateOf(first.calls);
  const stateB = stateOf(second.calls);

  assert.notEqual(stateA, stateB, '两个 PR 必须各用一份水位文件');
  assert.ok(stateA.endsWith('state-42'), `PR #42 的水位文件：${stateA}`);
  assert.ok(stateB.endsWith('state-43'), `PR #43 的水位文件：${stateB}`);
});
