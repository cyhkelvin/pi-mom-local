#!/usr/bin/env bash
# 一眼看完目前狀態。排查時第一個跑這支。

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

echo "runtime  : $RUNTIME"
echo "host     : $HOST"
echo "model    : ${LLM_MODEL:-（未設）}"
echo "sandbox  : $SANDBOX"
echo "state    : $STATE_DIR"
echo

PIDFILE="$STATE_DIR/$RUNTIME.pid"
PID=""
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
	PID="$(cat "$PIDFILE")"
	ok "process 在跑（PID $PID，已 $(ps -o etime= -p "$PID" | tr -d ' ')）"
else
	echo "✗ process 沒在跑 → bin/start.sh"
fi

# process 活著不等於 Slack 連得上——這一項才是真正會騙人的地方
if [ -n "$PID" ]; then
	socket_health "$PID" || true
fi

BASE_URL="$(host_base_url 2>/dev/null || echo '')"
if [ -n "$BASE_URL" ] && curl -sf -m 5 "$BASE_URL/models" >/dev/null 2>&1; then
	ok "$HOST 有回應（$BASE_URL）"
else
	echo "✗ $HOST 沒有回應（$BASE_URL）"
fi

case "$SANDBOX" in
	docker:*)
		CONTAINER="${SANDBOX#docker:}"
		if ! docker info >/dev/null 2>&1; then
			echo "✗ docker daemon 沒起來 → open -a Docker"
		else
			STATUS="$(docker ps -a --filter "name=^${CONTAINER}$" --format '{{.Status}}')"
			[ -n "$STATUS" ] && ok "容器 $CONTAINER：$STATUS" || echo "✗ 容器 $CONTAINER 不存在（bin/start.sh 會自動建）"
		fi
		;;
	host) echo "⚠ sandbox=host：agent 的 bash 直接跑在你的機器上" ;;
esac

if [ -n "${MOM_SLACK_BOT_TOKEN:-}" ]; then
	RESP="$(curl -s -m 8 -H "Authorization: Bearer $MOM_SLACK_BOT_TOKEN" https://slack.com/api/auth.test || echo '{}')"
	if echo "$RESP" | grep -q '"ok":true'; then
		ok "Slack bot token 有效（$(echo "$RESP" | sed -n 's/.*"user":"\([^"]*\)".*/\1/p')）"
	else
		echo "✗ Slack token 無效：$(echo "$RESP" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')"
	fi
fi

# --- 產圖 ---------------------------------------------------------------------
if [ "${IMAGE_ENABLED:-0}" = "1" ]; then
	SDPID_FILE="$STATE_DIR/sd-server.pid"
	if [ -f "$SDPID_FILE" ] && kill -0 "$(cat "$SDPID_FILE")" 2>/dev/null; then
		ok "sd-server 常駐中（PID $(cat "$SDPID_FILE")，port ${IMAGE_PORT:-7861}，模式 ${IMAGE_RESIDENT_MODE:-vram}）"
		JOBS="$(curl -s -m 3 "http://127.0.0.1:${IMAGE_PORT:-7861}/sdcpp/v1/models/status" 2>/dev/null | head -c 300)"
		[ -n "$JOBS" ] && echo "  models/status：$JOBS"
	else
		echo "· sd-server 沒在跑（第一次產圖時才會啟動）"
	fi
	BIN="${IMAGE_SD_SERVER_BIN:-$STATE_DIR/bin/sd-server}"
	[ -x "$BIN" ] || echo "✗ 找不到 sd-server：$BIN（編譯方式見 packages/image-router/README.md）"
	if command -v nvidia-smi >/dev/null; then
		echo "  VRAM：$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader)"
	fi
	[ -f "$STATE_DIR/image-stats.json" ] && echo "  ETA 統計：$(tr -d '\n\t' < "$STATE_DIR/image-stats.json")"
	echo "  log: $LOG_DIR/sd-server.log"
fi

echo
LATEST=""
for f in "$CHANNELS_DIR"/*/log.jsonl; do
	[ -f "$f" ] || continue
	[ -z "$LATEST" ] || [ "$f" -nt "$LATEST" ] && LATEST="$f"
done
if [ -n "$LATEST" ]; then
	# GNU stat 先試；BSD 的 stat -f 在 GNU 上意思不同但不會報錯，順序不能反（同 lib.sh）
	MTIME="$(stat -c %Y "$LATEST" 2>/dev/null || stat -f %m "$LATEST" 2>/dev/null)"
	echo "最後一則對話：$(fmt_epoch "$MTIME" '%m-%d %H:%M')　（$(basename "$(dirname "$LATEST")")）"
fi
echo "log: $LOG_DIR/$RUNTIME.log"
