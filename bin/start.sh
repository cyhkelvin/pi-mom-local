#!/usr/bin/env bash
# 啟動 pi-mom-local。前景執行，Ctrl-C 停止。
#
# 這支腳本只做「與 runtime 無關」的事：載入設定、檢查模型主機、防止重複啟動、
# 日誌落地，然後把控制權交給 runtimes/$RUNTIME/start。

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
require_config

# --- 重複啟動防護 -----------------------------------------------------------
# 同一組 Slack token 起兩個 Socket Mode 連線會互搶訊息，症狀是回覆隨機消失。
PIDFILE="$STATE_DIR/$RUNTIME.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
	die "已經有一個 $RUNTIME 在跑了（PID $(cat "$PIDFILE")）
要停止它：kill $(cat "$PIDFILE")"
fi

# --- 模型主機是否活著 -------------------------------------------------------
BASE_URL="$(host_base_url)" || die "config/hosts/$HOST.json 缺少 providers.$HOST.baseUrl"
if ! curl -sf -m 5 "$BASE_URL/models" >/dev/null 2>&1; then
	die "連不上 $HOST（$BASE_URL）
  ollama   → 開啟 Ollama.app，或執行 ollama serve
  lmstudio → 在 LM Studio 的 Developer 分頁啟動 server
  llamacpp → 執行 llama-server
  vllm     → 執行 vllm serve"
fi
ok "$HOST 有回應（$BASE_URL）"

# --- 日誌落地 ---------------------------------------------------------------
# 固定檔名，不帶日期。帶日期的檔名會在啟動當下就凍結，跨日之後
# `tail logs/xxx-$(date +%F).log` 會找不到檔案，讓人誤判成服務掛了。
LOG_FILE="$LOG_DIR/$RUNTIME.log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "===== $(date '+%F %T') 啟動 runtime=$RUNTIME host=$HOST model=$LLM_MODEL sandbox=$SANDBOX ====="

echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

exec "$REPO_ROOT/runtimes/$RUNTIME/start"
