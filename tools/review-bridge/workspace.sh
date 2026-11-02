#!/usr/bin/env bash
# Turns an untrusted PR checkout into a read-only OpenCode workspace.
# Usage (from the job root, control checkout in ./control):
#   workspace.sh <pr-dir> <base-sha> <head-sha> <evidence-dir>   (PROJECT_ID, TASK_ID from env)
set -euo pipefail
pr="$1" base="$2" head="$3" evidence="$4"
ctx="$pr/.autonomous-review"
test "$(git -C "$pr" rev-parse HEAD)" = "$head"
rm -rf "$ctx"
mkdir -p "$ctx"
git -C "$pr" diff "$base...$head" > "$ctx/diff.patch"
git -C "$pr" show "$base:AGENTS.md" > "$ctx/AGENTS.base.md"
# PR-controlled OpenCode config, plugins or agent instructions could grant tools,
# run code beside the API key, or pose as reviewer instructions.
rm -rf "$pr/.opencode" "$pr/opencode.json" "$pr/opencode.jsonc" "$pr/AGENTS.md" "$pr/CLAUDE.md" "$pr/.claude"
cp -r "$evidence/." "$ctx/"
cp "control/projects/$PROJECT_ID/tasks/$TASK_ID.md" "$ctx/task.md"
cp -r "control/projects/$PROJECT_ID" "$ctx/project"
cp control/reviewer/CHATGPT_REVIEW.md "$ctx/protocol.md"
