#!/usr/bin/env bash
# 停止 pi-mom-local。

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

# sd-server 是 mom 的子程序，mom 正常結束時會一起帶走；這裡是保險，
# 避免 mom 被 kill -9 之類的情況留下一個佔著 VRAM 的 sd-server。
stop_sd_server() {
	local f="$STATE_DIR/sd-server.pid" pid
	[ -f "$f" ] || return 0
	pid="$(cat "$f")"
	sleep 1
	if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q sd-server; then
		kill "$pid" && ok "已停止殘留的 sd-server（PID $pid）"
	fi
	rm -f "$f"
}

PIDFILE="$STATE_DIR/$RUNTIME.pid"
if [ ! -f "$PIDFILE" ]; then
	echo "沒有在跑（找不到 $PIDFILE）"
	stop_sd_server
	exit 0
fi
PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
	kill "$PID"
	ok "已送出停止訊號給 PID $PID"
else
	echo "PID $PID 已經不存在，清掉殘留的 pidfile"
fi
rm -f "$PIDFILE"
stop_sd_server


# systemd（Linux／WSL）：Restart=always 會在 60 秒後把它拉回來
if command -v systemctl >/dev/null && systemctl --user is-active --quiet pi-mom 2>/dev/null; then
	echo "⚠ systemd 常駐開著，約 60 秒後會自動重啟。要真的停：systemctl --user stop pi-mom"
fi

# KeepAlive 會把它拉回來，這裡講清楚，免得以為停不掉
if launchctl print "gui/$UID/local.pi-mom" >/dev/null 2>&1; then
	echo "⚠ launchd 常駐開著，約 60 秒後會自動重啟。要真的停：bin/install-launchd.sh uninstall"
fi
