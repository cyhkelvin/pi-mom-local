#!/usr/bin/env bash
# 檢查上游有沒有更新，產出一份可以直接貼給 agent 看的報告。
#
# 要知道的前提：
#   mom 本身「沒有上游了」——badlogic/pi-mono 在 commit 0ed0d4343
#   ("remove mom and pods packages") 把整個 packages/mom 刪掉了。
#   本 repo 的 runtimes/mom 是被刪之前的最後一版 0.70.6。
#   所以能追的只有它依賴的那幾個套件，而且作者已經把它們搬到
#   @earendil-works/* 命名空間。

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PKGS=(pi-agent-core pi-ai pi-coding-agent)
MOM_DIR="$REPO_ROOT/runtimes/mom"

echo "# pi-mom-local 上游檢查　$(date '+%F %T')"
echo
echo "## mom 本體"
echo
echo "- 基底：badlogic/pi-mono \`packages/mom\` v$(node -p "require('$MOM_DIR/package.json').version" 2>/dev/null)"
echo "- 上游狀態：**已移除**（commit 0ed0d4343 \"remove mom and pods packages\"），沒有新版可追。"
echo
echo "## 依賴套件"
echo
printf '| 套件 | 本機安裝 | @mariozechner 最新 | @earendil-works 最新 |\n'
printf '| --- | --- | --- | --- |\n'
for p in "${PKGS[@]}"; do
	installed="$(node -p "require('$MOM_DIR/node_modules/@mariozechner/$p/package.json').version" 2>/dev/null || echo '—')"
	old="$(npm view "@mariozechner/$p" version 2>/dev/null || echo '—')"
	new="$(npm view "@earendil-works/$p" version 2>/dev/null || echo '—')"
	printf '| %s | %s | %s | %s |\n' "$p" "$installed" "$old" "$new"
done
echo
echo "## 怎麼判讀"
echo
echo "- 三欄一致 → 沒事，不用動。"
echo "- \`@mariozechner\` 有新版 → 改 \`runtimes/mom/package.json\` 的版本後跑 \`runtimes/mom/build\`，風險低。"
echo "- 只有 \`@earendil-works\` 在動 → 那是搬家後的新家。要不要跟著搬是一個**決策**，"
echo "  不是例行更新：API 可能已經改過，mom 是舊版、不會自己跟上。"
echo
echo "決定要不要更新之前，先確認現在是好的：\`bin/status.sh\` 與 \`bin/probe.sh\`。"
