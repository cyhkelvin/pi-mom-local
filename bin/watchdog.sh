#!/usr/bin/env bash
# 保底監看。由 launchd 每 5 分鐘叫一次，不是常駐。
#
# 分工：連線斷太久由 mom 自己 exit（slack.ts 的 watchConnection），launchd KeepAlive 重啟。
# 這支只處理「連 exit 都沒發生」的殭屍——也就是 2026-09-09 那種 process 活著、socket 半開。
# 只負責停，不負責起：起是 launchd 的事，避免兩個 Socket Mode 搶同一組 token。
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
# lib.sh 開頭是 set -euo pipefail，source 進來會把 errexit 一併打開，
# 蓋掉上面那行的 set -uo。這支靠 socket_health 的回傳碼判斷，
# 而 errexit 會在它回非 0 的那一瞬間就把整支 script 殺掉——
# 下面的 RC=$? 永遠執行不到，等於「一偵測到殭屍就自殺」。
# 2026-09-11～09-16 三次殭屍都沒被處理，就是卡在這裡（launchd runs=427 全是 exit 1）。
set +e

WD_LOG="$LOG_DIR/watchdog.log"
COOLDOWN=900          # 15 分鐘內只動一次，避免重啟風暴
say() { echo "$(date '+%F %T') $*" >> "$WD_LOG"; }

PIDFILE="$STATE_DIR/$RUNTIME.pid"
if [ ! -f "$PIDFILE" ] || ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
	say "process 不在（交給 launchd KeepAlive）"
	exit 0
fi

# 網路不通時重啟救不了，只會製造重啟風暴——什麼都不做
if ! curl -sf -m 8 https://slack.com/api/api.test >/dev/null 2>&1; then
	say "略過：連不到 slack.com"
	exit 0
fi

socket_health "$(cat "$PIDFILE")" >/dev/null 2>&1
RC=$?
[ "$RC" -eq 0 ] && exit 0     # 健康

STAMP="$STATE_DIR/.watchdog-last-restart"
NOW="$(date +%s)"
LAST="$(cat "$STAMP" 2>/dev/null || echo 0)"
if [ $((NOW - LAST)) -lt "$COOLDOWN" ]; then
	say "判定 rc=$RC，但距上次重啟不到 $((COOLDOWN / 60)) 分鐘，先不動"
	exit 0
fi

say "判定 rc=$RC（1=殭屍 2=喚醒後無法確認）→ 停掉，等 launchd 重啟"
echo "$NOW" > "$STAMP"
"$(dirname "${BASH_SOURCE[0]}")/stop.sh" >> "$WD_LOG" 2>&1
