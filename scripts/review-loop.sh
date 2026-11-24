#!/usr/bin/env bash
# Review loop：把 PR 上未处理的自动审查意见（chatgpt-codex-connector）逐轮交给 omp 修复，
# 全量测试通过后提交并推送，再触发下一轮审查，直到连续两轮没有新意见或到达轮次上限。
#
# 用法：bash scripts/review-loop.sh <pr> [max_rounds]
# 环境：REVIEW_PUBLIC 指向公开仓库的工作树（导出与推送在那里进行），默认 ../patchouli-knowledge-public-worktree
# 前提：本地 gh 已认证；omp 在 PATH；主检出工作区干净。
# 产物：tmp/review-loop/ 下的每轮 prompt 与输出、tmp/review-loop/state（已处理的最大评论 id）。
set -uo pipefail

REPO="yabo083/koishi-plugin-patchouli-knowledge"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="${REVIEW_PUBLIC:-$(dirname "$PROJECT")/pk-loop}"
PR="${1:?usage: review-loop.sh <pr> [max_rounds]}"
MAX_ROUNDS="${2:-6}"
WORK="$PROJECT/tmp/review-loop"
STATE="$WORK/state"
mkdir -p "$WORK"
[ -f "$STATE" ] || echo 0 > "$STATE"

cd "$PROJECT" || exit 1

log() { printf '[loop %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# 拉未处理意见：id 大于已处理最大值
collect() {
  gh api "repos/$REPO/pulls/$PR/comments" --paginate \
    --jq '.[] | select(.user.login | startswith("chatgpt-codex-connector")) | "\(.id)\t\(.path):\(.line // .original_line)\t\(.body)"' \
    > "$WORK/all.tsv" 2>/dev/null || return 1
  awk -F'\t' -v last="$(cat "$STATE")" '$1 > last' "$WORK/all.tsv" > "$WORK/new.tsv"
  wc -l < "$WORK/new.tsv" | tr -d ' '
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
  N="$(collect)" || { log "拉取评论失败，退出"; exit 1; }
  if [ "${N:-0}" -eq 0 ]; then
    IDLE=$((IDLE + 1))
    log "第 $ROUND 轮：无新意见（连续 $IDLE 轮）"
    [ "$IDLE" -ge 2 ] && { log "连续两轮无意见，收工"; break; }
    wait_review && continue || break
  fi
  IDLE=0
  log "第 $ROUND 轮：$N 条新意见"

  {
    echo "# 任务"
    echo "以下是 PR #$PR 上自动审查的未处理意见。逐条对照当前代码核实，**只修仍然成立的问题**；"
    echo "如果某条属于已知限制或已有等价修复，写明理由后跳过（不要为凑数改动）。"
    echo
    echo "## 硬约束"
    echo "- TypeScript 严格无 \`any\`；不降低既有测试语义；每条修复补一个用例。"
    echo "- 不 commit、不 tag、不部署、不修改 \`.context/\` 之外的文档口径。"
    echo "- 完成后跑 \`npx tsc --noEmit\`、\`pnpm build\`、\`pnpm test\`，全绿才算完成。"
    echo
    echo "## 意见"
    cut -f2,3 "$WORK/new.tsv" | sed 's/^/### /'
  } > "$WORK/prompt-$ROUND.md"

  log "调用 omp 修复（prompt-$ROUND.md）"
  omp -p "$(cat "$WORK/prompt-$ROUND.md")" --mode text > "$WORK/omp-$ROUND.log" 2>&1
  OMP_STATUS=$?
  tail -5 "$WORK/omp-$ROUND.log"

  if ! VERIFY; then
    log "验证未通过，让 omp 再修一次"
    omp -p "上一轮改动未通过验证（tsc / build / test 之一失败）。请读取 tmp/review-loop/omp-$ROUND.log 的结尾与本轮 diff，修复直到 npx tsc --noEmit、pnpm build、pnpm test 全绿。不要新增无关改动。" \
      > "$WORK/omp-$ROUND-retry.log" 2>&1
    if ! VERIFY; then
      log "重试后仍不通过，保留现场并退出（未提交）"
      exit 2
    fi
  fi

  if git diff --quiet && git diff --cached --quiet; then
    log "本轮无代码改动（可能全部判为已知限制），仍继续下一轮"
  else
    cut -f1 "$WORK/new.tsv" | sort -n | tail -1 > "$STATE"
    if [ ! -d "$PUBLIC/.git" ]; then
      log "公开工作树不存在：$PUBLIC（先 git worktree add 并设置 REVIEW_PUBLIC）"
      exit 3
    fi
    node "$PROJECT/scripts/export-public.mjs" "$PUBLIC" >/dev/null 2>&1 || { log "导出失败"; exit 3; }
    git -C "$PUBLIC" add -A
    git -C "$PUBLIC" commit -q -m "fix(review): 第 $ROUND 轮自动审查修复（$N 条）

详见 tmp/review-loop/prompt-$ROUND.md" || log "无变更可提交"
    git -C "$PUBLIC" push -q origin HEAD && log "已推送公开仓库 $(git -C "$PUBLIC" rev-parse --short HEAD)"
  fi

  gh pr comment "$PR" --body "@codex review" >/dev/null 2>&1 && log "已触发下一轮审查"
  wait_review || break
done

log "结束：$ROUND 轮，最后 HEAD $(git rev-parse --short HEAD)"
