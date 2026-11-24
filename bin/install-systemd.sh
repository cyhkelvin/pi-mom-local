#!/usr/bin/env bash
# 安裝／移除 systemd 使用者服務（Linux／WSL 版的 install-launchd.sh）。
# 用法：bin/install-systemd.sh [install|uninstall|status]
#
# 裝兩個東西，分工和 launchd 版相同：
#   pi-mom.service          常駐。Restart=always：mom 斷線超時會自己 exit，靠這個接手重啟。
#   pi-mom-watchdog.timer   每 5 分鐘跑一次 bin/watchdog.sh，處理「process 活著但 socket 死了」。
#                           watchdog 只負責停，重啟交給 Restart=always。
#
# 設計重點：
# - 不用 EnvironmentFile：bin/start.sh 的 load_config 會用 bash 讀 config/agent.env（set -a），
#   之後新增的設定（例如 IMAGE_*）不需要改 unit 檔就會帶進來。systemd 的 EnvironmentFile
#   語法和 bash 不完全相同，兩邊各讀一次反而容易不一致。
# - PATH 寫死成「安裝當下 node 所在目錄 + 系統路徑」：systemd 不讀 .bashrc，nvm 的 node 找不到。
#   換 node 版本（nvm use）後要重跑 install。
# - KillMode=control-group（預設值，這裡明寫）：停服務時整個 cgroup 一起結束，
#   包含之後產圖功能的 sd-server 子程序，不會留著佔 VRAM。
# - Restart=always 而不是 on-failure：watchdog 用 SIGTERM 停掉殭屍，SIGTERM 對 systemd 來說是
#   「正常結束」，on-failure 不會重啟。代價是手動 bin/stop.sh 之後約 60 秒會被拉回來，
#   要真的停：systemctl --user stop pi-mom（或 uninstall）。
# - 使用者服務不能依賴系統的 docker.service／ollama.service。兩者沒起來時 start.sh 會失敗退出，
#   每 60 秒重試一次。StartLimitIntervalSec=0 讓它不會放棄，但也代表失敗不會自己停：
#   要看 systemctl --user status pi-mom（README G4 的教訓：Mac 上失敗 3160 次沒人發現）。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

command -v systemctl >/dev/null || die "找不到 systemctl。Mac 請用 bin/install-launchd.sh"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE_BIN="$(dirname "$(command -v node 2>/dev/null || echo /nonexistent/node)")"
[ -x "$NODE_BIN/node" ] || die "目前的 shell 找不到 node。nvm 使用者先跑：source ~/.nvm/nvm.sh"
SVC_PATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# WSL 的 GPU 工具（nvidia-smi、libcuda）放在 /usr/lib/wsl/lib，登入 shell 有、systemd 預設沒有
[ -d /usr/lib/wsl/lib ] && SVC_PATH="$SVC_PATH:/usr/lib/wsl/lib"
UNITS=(pi-mom.service pi-mom-watchdog.service pi-mom-watchdog.timer)
ACTION="${1:-install}"

write_units() {
	mkdir -p "$UNIT_DIR"
	cat > "$UNIT_DIR/pi-mom.service" <<EOF
# 由 $REPO_ROOT/bin/install-systemd.sh 產生，修改請改腳本後重跑 install
[Unit]
Description=pi-mom-local (Slack agent)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
Environment=PATH=$SVC_PATH
ExecStart=$REPO_ROOT/bin/start.sh
ExecStop=$REPO_ROOT/bin/stop.sh
KillMode=control-group
TimeoutStopSec=30
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
EOF

	cat > "$UNIT_DIR/pi-mom-watchdog.service" <<EOF
# 由 $REPO_ROOT/bin/install-systemd.sh 產生
[Unit]
Description=pi-mom-local watchdog（殭屍連線偵測）

[Service]
Type=oneshot
Environment=PATH=$SVC_PATH
ExecStart=$REPO_ROOT/bin/watchdog.sh
EOF

	cat > "$UNIT_DIR/pi-mom-watchdog.timer" <<EOF
# 由 $REPO_ROOT/bin/install-systemd.sh 產生
[Unit]
Description=每 5 分鐘檢查 pi-mom-local 連線

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
}

case "$ACTION" in
install)
	# 防止兩個 Socket Mode 連線搶訊息：手動起的那個要先停
	PIDFILE="$STATE_DIR/$RUNTIME.pid"
	if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null \
		&& ! systemctl --user is-active --quiet pi-mom; then
		die "有一個手動啟動的 $RUNTIME 在跑（PID $(cat "$PIDFILE")）。先 bin/stop.sh 再 install。"
	fi
	write_units
	systemctl --user daemon-reload
	systemctl --user enable --now pi-mom.service pi-mom-watchdog.timer
	ok "已啟用 pi-mom.service、pi-mom-watchdog.timer（unit 在 $UNIT_DIR）"
	if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
		echo "⚠ linger 沒開：沒有登入時服務不會跑。執行：sudo loginctl enable-linger $USER"
	fi
	echo "⚠ Restart=always：bin/stop.sh 停掉後約 60 秒會自動重啟。要真的停：systemctl --user stop pi-mom"
	echo "  看狀態：systemctl --user status pi-mom ／ log：$LOG_DIR/$RUNTIME.log"
	;;
uninstall)
	systemctl --user disable --now pi-mom.service pi-mom-watchdog.timer 2>/dev/null || true
	for U in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$U"; done
	systemctl --user daemon-reload
	ok "已移除 systemd 常駐"
	;;
status)
	for U in pi-mom.service pi-mom-watchdog.timer; do
		printf '  %-24s %s／%s\n' "$U" \
			"$(systemctl --user is-enabled "$U" 2>/dev/null || echo 未安裝)" \
			"$(systemctl --user is-active "$U" 2>/dev/null || true)"
	done
	echo "  linger                   $(loginctl show-user "$USER" -p Linger --value 2>/dev/null)"
	systemctl --user show pi-mom -p NRestarts -p ExecMainStartTimestamp 2>/dev/null | sed 's/^/  /'
	;;
*) die "用法：$0 [install|uninstall|status]" ;;
esac
