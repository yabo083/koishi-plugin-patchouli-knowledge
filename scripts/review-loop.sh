#!/usr/bin/env bash
# Review loop：把 PR 上未处理的自动审查意见（chatgpt-codex-connector）逐轮交给 omp 修复，
# 全量测试通过后提交并推送，再触发下一轮审查，直到连续两轮没有新意见或到达轮次上限。
#
# 用法：bash scripts/review-loop.sh <pr> [max_rounds]
# 环境：REVIEW_PUBLIC 指向公开仓库的工作树（导出与推送在那里进行），默认 ../patchouli-knowledge-public-worktree
# 前提：本地 gh 已认证；omp 在 PATH；主检出工作区干净。
# 产物：tmp/review-loop/ 下的每轮 prompt 与输出、tmp/review-loop/state-<pr>（该 PR 已处理的最大评论 id）。
# 工作目录可用 REVIEW_LOOP_WORK 覆盖（沙箱用例），水位文件永远按 PR 分开。
set -uo pipefail

REPO="yabo083/koishi-plugin-patchouli-knowledge"
BOT="chatgpt-codex-connector"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
IO="$PROJECT/scripts/review-loop-io.mjs"
PUBLIC="${REVIEW_PUBLIC:-$(dirname "$PROJECT")/pk-loop}"
PR="${1:?usage: review-loop.sh <pr> [max_rounds]}"
MAX_ROUNDS="${2:-6}"
WORK="${REVIEW_LOOP_WORK:-$PROJECT/tmp/review-loop}"
# 水位必须按 PR 分开：共用一份时，第二个 PR 上编号更小的意见会被当成「已处理」直接丢掉，
# 循环还会报「无新意见」当成收敛。
STATE="$WORK/state-$PR"
mkdir -p "$WORK"
[ -f "$STATE" ] || echo 0 > "$STATE"

cd "$PROJECT" || exit 1

log() { printf '[loop %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# 拉未处理意见：id 大于已处理最大值。
# 一律按 JSONL 整条传递（`tojson`）：正文里的换行 / 制表符留在 JSON 字符串里转义，
# 不会像 `-r` 直接拼进 TSV 那样把一条意见拆成多行、让下游按行过滤时丢掉后半截。
# 拼 prompt 与水位过滤在 review-loop-io.mjs 里做（有用例覆盖）；本函数打印 "<条数> <最大 id>"。
collect() {
  gh api "repos/$REPO/pulls/$PR/comments" --paginate \
    --jq ".[] | select(.user.login | startswith(\"$BOT\")) | tojson" > "$WORK/comments.jsonl" 2>/dev/null || return 1
  node "$IO" collect --in "$WORK/comments.jsonl" --state-file "$STATE" --bot "$BOT" --pr "$PR" "$@" || return 1
}

# 等下一轮审查跑完：出现比当前时间更新的 codex 评论，或超时
wait_review() {
  local deadline=$(( $(date +%s) + 600 ))
  local since
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if gh api "repos/$REPO/pulls/$PR/comments" --paginate \
      --jq "[.[] | select(.user.login | startswith(\"chatgpt-codex-connector\")) | select(.created_at > \"$since\")] | length" 2>/dev/null | grep -qv '^0$'; then
      sleep 20   # 让同批意见全部落地
      return 0
    fi
    sleep 20
  done
  log "等待审查超时（10 分钟）"
  return 1
}

VERIFY() {
  mise exec -- npx tsc --noEmit >/dev/null 2>&1 || return 1
  mise exec -- pnpm build >/dev/null 2>&1 || return 1
  timeout 600 mise exec -- pnpm test 2>&1 | grep -qE '^ℹ fail 0' || return 1
  return 0
}

ROUND=0
IDLE=0
while [ "$ROUND" -lt "$MAX_ROUNDS" ]; do
  ROUND=$((ROUND + 1))
  # prompt 由 collect 一并写出（多行正文在那边还原成真实换行）
  COLLECTED="$(collect --prompt "$WORK/prompt-$ROUND.md")" || { log "拉取评论失败，退出"; exit 1; }
  N="${COLLECTED%% *}"
  MAX_ID="${COLLECTED##* }"
  if [ "${N:-0}" -eq 0 ]; then
    IDLE=$((IDLE + 1))
    log "第 $ROUND 轮：无新意见（连续 $IDLE 轮）"
    [ "$IDLE" -ge 2 ] && { log "连续两轮无意见，收工"; break; }
    wait_review && continue || break
  fi
  IDLE=0
  log "第 $ROUND 轮：$N 条新意见"

  log "调用 omp 修复（prompt-$ROUND.md）"
  omp -p "$(cat "$WORK/prompt-$ROUND.md")" --auto-approve --mode text > "$WORK/omp-$ROUND.log" 2>&1
  OMP_STATUS=$?
  tail -5 "$WORK/omp-$ROUND.log"

  # 非零退出码 = 这一轮修复没跑完。工作树里还压着上一轮已发布的改动，VERIFY 会对着旧代码判绿，
  # 一发布就把本轮意见记成「已处理」。按失败轮处理：不验证、不发布、不推进水位。
  if [ "$OMP_STATUS" -ne 0 ]; then
    log "omp 退出码 $OMP_STATUS：本轮修复未完成，保留现场并退出（未提交）"
    exit 5
  fi

  if ! VERIFY; then
    log "验证未通过，让 omp 再修一次"
    omp -p --auto-approve "上一轮改动未通过验证（tsc / build / test 之一失败）。请读取 $WORK/omp-$ROUND.log 的结尾与本轮 diff，修复直到 npx tsc --noEmit、pnpm build、pnpm test 全绿。不要新增无关改动。" \
      > "$WORK/omp-$ROUND-retry.log" 2>&1
    RETRY_STATUS=$?
    # 同上：重试命令失败时第二次 VERIFY 可能对着没被修过的旧代码判绿。
    if [ "$RETRY_STATUS" -ne 0 ]; then
      log "重试 omp 退出码 $RETRY_STATUS：修复未完成，保留现场并退出（未提交）"
      exit 5
    fi
    if ! VERIFY; then
      log "重试后仍不通过，保留现场并退出（未提交）"
      exit 2
    fi
  fi

  if [ ! -e "$PUBLIC/.git" ]; then
    log "公开工作树不存在：$PUBLIC（先 git worktree add 并设置 REVIEW_PUBLIC）"
    exit 3
  fi
  node "$PROJECT/scripts/export-public.mjs" "$PUBLIC" >/dev/null 2>&1 || { log "导出失败"; exit 3; }
  # 提交 + 推送 + 推进已处理水位都在这里：工作树有改动（含未跟踪文件）才推，推送失败时水位不动，
  # 且本脚本必须在失败处终止——带着未发布的修复去触发下一轮审查只会让循环假收敛。
  if ! VERDICT="$(node "$IO" publish --project "$PROJECT" --public "$PUBLIC" --state-file "$STATE" --max-id "$MAX_ID" \
      --message "fix(review): 第 $ROUND 轮自动审查修复（$N 条）

详见 tmp/review-loop/prompt-$ROUND.md" 2>&1)"; then
    log "发布失败（提交 / 推送），已处理水位未推进，退出：$VERDICT"
    exit 4
  fi
  case "$VERDICT" in
    *pushed\ *) log "已推送公开仓库 ${VERDICT##*pushed }" ;;
    *) log "本轮无代码改动（可能全部判为已知限制），仍继续下一轮" ;;
  esac

  # 触发失败不能当成跑完：水位已推进，退出码却是 0 会让「本轮已发布」看起来像「循环收敛」。
  if ! gh pr comment "$PR" --body "@codex review" >/dev/null 2>&1; then
    log "触发下一轮审查失败（gh pr comment 非零退出）：本轮已发布，修好 gh 后重跑"
    exit 6
  fi
  log "已触发下一轮审查"
  wait_review || break
done

log "结束：$ROUND 轮，最后 HEAD $(git rev-parse --short HEAD)"
