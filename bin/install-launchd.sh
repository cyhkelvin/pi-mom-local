#!/usr/bin/env bash
# 安裝／移除 launchd 常駐。用法：bin/install-launchd.sh [install|uninstall|status]
#
# 為什麼要 launchd 而不是 KeepAlive 以外的東西：2026-09-09 的故障是 process 活著、
# socket 半開，KeepAlive 單獨用完全無效。要先讓 mom 斷線超時自己 exit（slack.ts），
# KeepAlive 才有東西可以接。watchdog 是保底，處理連 exit 都沒發生的情況。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

AGENTS="$HOME/Library/LaunchAgents"
LABELS=(local.pi-mom local.pi-mom-watchdog)
ACTION="${1:-install}"

case "$ACTION" in
install)
	mkdir -p "$AGENTS"
	for L in "${LABELS[@]}"; do
		sed -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
		    -e "s|__LOG_DIR__|$LOG_DIR|g" \
		    -e "s|__PATH__|$PATH|g" \
		    "$REPO_ROOT/launchd/$L.plist" > "$AGENTS/$L.plist"
		launchctl bootout "gui/$UID/$L" 2>/dev/null || true
		launchctl bootstrap "gui/$UID" "$AGENTS/$L.plist"
		ok "已載入 $L"
	done
	echo
	echo "⚠ KeepAlive 開著，bin/stop.sh 停掉之後 launchd 會再把它拉起來。"
	echo "  要真的停：bin/install-launchd.sh uninstall"
	;;
uninstall)
	for L in "${LABELS[@]}"; do
		launchctl bootout "gui/$UID/$L" 2>/dev/null && ok "已卸載 $L" || echo "· $L 本來就沒載入"
		rm -f "$AGENTS/$L.plist"
	done
	;;
status)
	for L in "${LABELS[@]}"; do
		launchctl print "gui/$UID/$L" 2>/dev/null | grep -E "^\s+(state|pid|last exit code) " | sed "s/^/  $L /" || echo "  $L 未載入"
	done
	;;
*) die "用法：$0 [install|uninstall|status]" ;;
esac
