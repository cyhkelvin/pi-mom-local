# pi-mom-local 共用函式。被 bin/ 底下的腳本 source，不直接執行。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }
ok()   { echo "✓ $*"; }

# 載入 config/agent.env 並補上預設值。
load_config() {
	local cfg="$REPO_ROOT/config/agent.env"
	[ -f "$cfg" ] || die "找不到 $cfg
先複製範本並填入你的值：
  cp config/agent.env.example config/agent.env"

	set -a
	# shellcheck disable=SC1090
	source "$cfg"
	set +a

	: "${RUNTIME:=mom}"
	: "${HOST:=ollama}"
	: "${SANDBOX:=docker:pi-mom-sandbox}"
	# 沙箱 image 由 sandbox/Dockerfile 建出來。容器名（SANDBOX）與 image 名是兩件事，
	# 所以分開設；兩個都寫死在 start 裡的話，換名字就要改兩個地方。
	: "${SANDBOX_IMAGE:=pi-mom-sandbox:local}"
	# search skill 的憑證。沒填不會擋啟動——fetch 不需要它，
	# 只有 search 會在執行當下報「還沒設 key」。
	: "${SEARCH_PROVIDER:=brave}"
	: "${BRAVE_SEARCH_API_KEY:=}"
	: "${TAVILY_API_KEY:=}"
	# 自架 SearXNG（SEARCH_PROVIDER=searxng 時才會用到，不需要任何 key）。
	# URL 是「沙箱容器裡看到的位置」——兩個容器掛同一個 docker 網路，
	# 用 network-alias 互相找得到，所以不是 localhost。
	: "${SEARXNG_URL:=http://searxng:8080}"
	: "${SANDBOX_NETWORK:=pi-mom-net}"
	: "${STATE_DIR:=$HOME/.pi-mom-local}"
	[ -n "$STATE_DIR" ] || STATE_DIR="$HOME/.pi-mom-local"

	# HOST 同時決定 models.json 與 provider 名稱（JSON 裡的 provider key 必須等於檔名）
	MOM_MODELS_JSON="$REPO_ROOT/config/hosts/$HOST.json"
	LLM_PROVIDER="$HOST"

	WORKSPACE="$STATE_DIR/workspace"   # 掛進沙箱容器的目錄
	CHANNELS_DIR="$STATE_DIR/channels" # mom 的 workingDir：頻道歷史放這
	PI_HOME="$STATE_DIR/home"          # 隔離用 HOME，讓 agent 讀不到你的憑證
	LOG_DIR="$STATE_DIR/logs"

	export RUNTIME HOST SANDBOX SANDBOX_IMAGE STATE_DIR MOM_MODELS_JSON LLM_PROVIDER LLM_MODEL \
	       WORKSPACE CHANNELS_DIR PI_HOME LOG_DIR \
	       SEARCH_PROVIDER BRAVE_SEARCH_API_KEY TAVILY_API_KEY SEARXNG_URL SANDBOX_NETWORK

	mkdir -p "$WORKSPACE" "$CHANNELS_DIR" "$PI_HOME" "$LOG_DIR"
}

# 檢查一個 token 有填、而且不是範本的佔位值。
check_token() {
	local name="$1" value="$2" prefix="$3"
	[ -n "$value" ] || die "config/agent.env 沒有設 $name"
	case "$value" in
		*請填入*|"$prefix"|"${prefix}...")
			die "config/agent.env 的 $name 還是範本的佔位值，請填入真正的 token。
取得方式見 README「設定 Slack」。" ;;
	esac
	case "$value" in
		"$prefix"*) ;;
		*) die "config/agent.env 的 $name 看起來不對：應該以 $prefix 開頭。" ;;
	esac
}

require_config() {
	[ -f "$MOM_MODELS_JSON" ] || die "找不到 $MOM_MODELS_JSON
config/agent.env 的 HOST=$HOST，但 config/hosts/ 底下沒有對應的檔案。
現有的：$(ls -1 "$REPO_ROOT/config/hosts" | sed 's/\.json$//' | tr '\n' ' ')"
	[ -n "${LLM_MODEL:-}" ] || die "config/agent.env 沒有設 LLM_MODEL"
	# 注意：範本裡的佔位值是非空字串，只檢查「非空」擋不住「還沒填」。
	check_token MOM_SLACK_APP_TOKEN "${MOM_SLACK_APP_TOKEN:-}" xapp-
	check_token MOM_SLACK_BOT_TOKEN "${MOM_SLACK_BOT_TOKEN:-}" xoxb-
	[ -d "$REPO_ROOT/runtimes/$RUNTIME" ] || die "找不到 runtime：runtimes/$RUNTIME
現有的：$(ls -1 "$REPO_ROOT/runtimes" | tr '\n' ' ')"
}

# --- 連線健康度 ------------------------------------------------------------
# 為什麼需要這個：process 活著不代表 Slack 連得上。Mac 休眠時 DNS 會斷，
# Socket Mode 重連失敗後會一直空轉——process 在、容器在、token 有效，
# 但一則訊息都收不到。連 TCP 層都看不出來（殭屍連線仍顯示 ESTABLISHED）。
# 唯一可靠的訊號是 log：最後一次連線成功「之後」有沒有錯誤、有沒有收過訊息。

# macOS（BSD 工具）和 Linux（GNU 工具）的指令參數不同，下面的函式兩邊都要能跑。
# 判斷方式一律「先試 GNU、失敗再試 BSD」或反過來，選不會誤判的順序：
# GNU 的 `stat -f` 是「檔案系統資訊」、`date -r` 是「參考檔案」，
# 都會成功執行但輸出完全不同，所以這兩個要先試 GNU 寫法。

# epoch 秒 → 指定格式（GNU：date -d @N；BSD：date -r N）
fmt_epoch() {
	date -d "@$1" "+$2" 2>/dev/null || date -r "$1" "+$2" 2>/dev/null
}

# 上次系統從休眠喚醒的時間（epoch 秒）。查不到時回空字串，呼叫端會略過喚醒判斷。
#   macOS：kern.waketime
#   Linux：本次開機的 journal 裡最後一筆 "PM: suspend exit"
#   WSL：Windows 睡眠時 WSL 沒有對應的事件可查，回空字串
last_wake_epoch() {
	if [ "$(uname -s)" = Darwin ]; then
		sysctl -n kern.waketime 2>/dev/null | sed -n 's/^{ *sec = \([0-9]*\).*/\1/p'
	else
		journalctl -k -b -q -o short-unix --no-pager -g 'PM: suspend exit' 2>/dev/null \
			| tail -n 1 | cut -d. -f1
	fi
}

# runtime process 的啟動時間（epoch 秒）
proc_start_epoch() {
	local pid="$1"
	local lstart
	lstart="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" || return 1
	[ -n "$lstart" ] || return 1
	date -d "$lstart" +%s 2>/dev/null || date -j -f "%a %b %e %T %Y" "$lstart" +%s 2>/dev/null
}

# 自最後一次 "connected and listening" 之後的計數。$1 = 要數的 pattern
count_since_connect() {
	awk -v pat="$1" '
		/connected and listening/ { seen = 1; c = 0; next }
		seen && $0 ~ pat { c++ }
		END { print c + 0 }
	' "$LOG_DIR/$RUNTIME.log" 2>/dev/null || echo 0
}

# 同上，但回傳「最後一次命中」的行號（沒命中回 0）。
# 次數比不出先後——2026-09-09 就是栽在這：錯誤 4 次、訊息 1 則，
# 但訊息是 09-05 的、錯誤是 09-06 的，只數次數會判成「已恢復」。
last_line_since_connect() {
	awk -v pat="$1" '
		/connected and listening/ { seen = 1; n = 0; next }
		seen && $0 ~ pat { n = NR }
		END { print n + 0 }
	' "$LOG_DIR/$RUNTIME.log" 2>/dev/null || echo 0
}

# log 檔最後寫入時間（epoch 秒）。與 log 內容無關的第二道訊號——
# log 沒有可解析的時間戳，只能靠 mtime。
log_mtime_epoch() {
	stat -c %Y "$LOG_DIR/$RUNTIME.log" 2>/dev/null || stat -f %m "$LOG_DIR/$RUNTIME.log" 2>/dev/null || echo 0
}

# 印出連線健康度。回傳 0 = 健康，1 = 疑似殭屍，2 = 無法判斷
socket_health() {
	local pid="${1:-}"
	local logf="$LOG_DIR/$RUNTIME.log"
	[ -f "$logf" ] || { echo "⚠ 找不到 log，無法判斷連線狀態"; return 2; }

	local errs runs err_at run_at
	errs="$(count_since_connect 'ENOTFOUND|WebSocket error')"
	runs="$(count_since_connect 'Starting run')"
	# 判定看的是先後，不是次數
	err_at="$(last_line_since_connect 'ENOTFOUND|WebSocket error')"
	run_at="$(last_line_since_connect 'Starting run')"

	local wake start mtime wake_note=""
	wake="$(last_wake_epoch || true)"
	mtime="$(log_mtime_epoch)"
	if [ -n "$pid" ]; then
		start="$(proc_start_epoch "$pid" || true)"
		if [ -n "$wake" ] && [ -n "$start" ] && [ "$wake" -gt "$start" ]; then
			wake_note="（啟動後系統曾於 $(fmt_epoch "$wake" '%m-%d %H:%M') 從休眠喚醒）"
		fi
	fi

	local order_note=""
	[ "$errs" -gt 0 ] && [ "$err_at" -gt "$run_at" ] && order_note="，最後一筆是錯誤"
	[ "$errs" -gt 0 ] && [ "$run_at" -gt "$err_at" ] && order_note="，最後一筆是訊息"
	echo "連線     : 連線後錯誤 $errs 次、收到訊息 $runs 則$order_note $wake_note"
	echo "log 最後寫入：$(fmt_epoch "$mtime" '%m-%d %H:%M')"

	# ① 錯誤發生在最後一則訊息之後 → 殭屍。runs=0 也落在這（run_at=0）
	if [ "$errs" -gt 0 ] && [ "$err_at" -gt "$run_at" ]; then
		echo "✗ 疑似殭屍：最後一次連線錯誤之後就沒再收過訊息。"
		echo "  → bin/stop.sh && bin/start.sh（重啟後要重發訊息，mom 會跳過啟動前的）"
		return 1
	fi

	# ② 醒來之後 log 一個字都沒寫 → 連線是死是活無從證實，別報綠燈
	if [ -n "$wake" ] && [ "$mtime" -le "$wake" ] && [ -n "${start:-}" ] && [ "$wake" -gt "$start" ]; then
		echo "⚠ 無法確認：休眠喚醒後 log 沒有任何新內容，連線是否存活未經證實。"
		echo "  → 在 Slack 發一則訊息確認；沒回應就 bin/stop.sh && bin/start.sh"
		return 2
	fi

	# ③ 錯誤在訊息之前 → 真的斷過但已經恢復
	if [ "$errs" -gt 0 ]; then
		echo "⚠ 曾經斷線（$errs 次），但之後有收到訊息，已恢復"
		return 0
	fi
	ok "連線正常"
	return 0
}

# 從 models.json 讀出這個 host 的 baseUrl（去掉尾端的 /v1，得到服務根位址）
host_base_url() {
	node -e '
		const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const p = c.providers[process.argv[2]];
		if (!p || !p.baseUrl) { process.exit(1); }
		process.stdout.write(p.baseUrl);
	' "$MOM_MODELS_JSON" "$HOST"
}
