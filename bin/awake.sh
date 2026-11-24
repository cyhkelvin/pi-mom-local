#!/usr/bin/env bash
# 手動擋休眠。前景跑著，Ctrl-C 就停——刻意不做成常駐服務。
#
# 為什麼要旗標：不帶旗標的 caffeinate 只 assert PreventUserIdleSystemSleep，
# 只擋閒置睡。2026-09-09 掛了 9 小時，機器照睡，因為蓋子是闔上的。
#   -d 螢幕不睡  -i 不閒置睡  -m 硬碟不睡  -s 系統不睡（只在接電源時有效）
#   -u 不加：沒配 -t 預設只有 5 秒，等於白寫
#
# ⚠ 蓋子闔上一定會睡，沒有任何 caffeinate 旗標擋得住。
#   真要闔蓋不睡只有 sudo pmset -a disablesleep 1（改設定、重開機仍在，
#   要自己 disablesleep 0 關掉；無外接螢幕時等於封閉散熱，不建議）。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

PIDFILE="$STATE_DIR/$RUNTIME.pid"
ARGS=(-dims)

# 綁在 agent 的生命週期上：agent 一結束就放掉，不會出現
# 「agent 早就死了但機器還在硬撐」
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
	ARGS+=(-w "$(cat "$PIDFILE")")
	info "擋休眠中，綁定 $RUNTIME（PID $(cat "$PIDFILE")）。Ctrl-C 結束"
else
	echo "⚠ $RUNTIME 沒在跑，改成無限期擋休眠。Ctrl-C 結束" >&2
fi

# -s 只在接電源時有效，所以把電源狀態印出來
pmset -g batt | head -1
exec caffeinate "${ARGS[@]}"
