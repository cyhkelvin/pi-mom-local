#!/usr/bin/env bash
# 在一台新機器上初始化 pi-mom-local。可重複執行，已完成的步驟會跳過。
#
# 目前只驗證過 macOS。

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "pi-mom-local setup"
echo "=================="
echo

# --- 1. 必要工具 ------------------------------------------------------------
info "檢查必要工具"
command -v node >/dev/null || die "找不到 node。安裝：brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node 需要 >= 20，目前是 $(node -v)"
ok "node $(node -v)"
# npm 版本會影響 package-lock.json 的內容：npm 11 會寫入 optional 套件的 "libc" 欄位，
# npm 10 會把它刪掉，讓 lock 檔無故出現 diff（2026-11-19 在 WSL 上的 npm 10.9.9 實測，
# 和作業系統無關）。所以要求 npm >= 11，不必另外維護各平台的 lock 檔。
NPM_MAJOR="$(npm -v | cut -d. -f1)"
if [ "$NPM_MAJOR" -lt 11 ]; then
	echo "⚠ npm $(npm -v) < 11：npm install 會改寫 package-lock.json（刪掉 libc 欄位）"
	echo "  升級：npm install -g npm@11"
else
	ok "npm $(npm -v)"
fi
command -v curl >/dev/null || die "找不到 curl"
if command -v docker >/dev/null; then
	docker info >/dev/null 2>&1 && ok "docker 可用" || echo "⚠ docker 有裝但 daemon 沒起來（open -a Docker）"
else
	echo "⚠ 找不到 docker。沙箱隔離會不能用，只能跑 SANDBOX=host（不建議）"
fi
echo

# --- 2. 設定檔 --------------------------------------------------------------
CFG="$REPO_ROOT/config/agent.env"
if [ -f "$CFG" ]; then
	ok "設定檔已存在：config/agent.env"
else
	cp "$REPO_ROOT/config/agent.env.example" "$CFG"
	ok "已從範本建立 config/agent.env"
	echo
	echo "  接下來要手動填入 Slack token（見 README「設定 Slack」）："
	echo "    \$EDITOR $CFG"
	echo
fi

load_config
echo

# --- 3. 模型主機 ------------------------------------------------------------
info "檢查模型主機 host=$HOST"
[ -f "$MOM_MODELS_JSON" ] || die "找不到 $MOM_MODELS_JSON"
BASE_URL="$(host_base_url)" || die "config/hosts/$HOST.json 缺少 baseUrl"
if curl -sf -m 5 "$BASE_URL/models" >/dev/null 2>&1; then
	ok "$HOST 有回應（$BASE_URL）"
else
	echo "⚠ 連不上 $HOST（$BASE_URL）。啟動它之後再跑一次這支腳本。"
fi

# ollama 專屬：把 context window 開大
# 為什麼需要：ollama 預設 num_ctx 只有 4096，超過就「靜默截斷」——
# 連 system prompt 裡的工具說明都會被砍掉，症狀是 agent 說自己沒有工具、或整段回覆消失。
if [ "$HOST" = "ollama" ] && command -v ollama >/dev/null; then
	echo
	info "ollama context window"
	if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "${LLM_MODEL}:latest\|${LLM_MODEL}"; then
		ok "模型 $LLM_MODEL 已存在"
	else
		BASE="${OLLAMA_BASE_MODEL:-}"
		NUM_CTX="${OLLAMA_NUM_CTX:-32768}"
		if [ -z "$BASE" ]; then
			echo "⚠ 找不到模型 $LLM_MODEL。要建立一個 context 加大的衍生模型，請執行："
			echo "    OLLAMA_BASE_MODEL=<你的基底模型> bin/setup.sh"
			echo "  例如：OLLAMA_BASE_MODEL=gemma4:latest bin/setup.sh"
		else
			info "從 $BASE 建立 $LLM_MODEL（num_ctx=$NUM_CTX）"
			printf 'FROM %s\nPARAMETER num_ctx %s\n' "$BASE" "$NUM_CTX" | ollama create "$LLM_MODEL" -f -
			ok "已建立 $LLM_MODEL"
			echo "  提醒：config/hosts/ollama.json 的 contextWindow 要與 num_ctx 一致，目前是 $NUM_CTX"
		fi
	fi
fi
echo

# --- 4. 建置 runtime --------------------------------------------------------
info "建置 runtime：$RUNTIME"
"$REPO_ROOT/runtimes/$RUNTIME/build"
echo

# --- 4b. 本機產圖（選用）------------------------------------------------------
if [ "${IMAGE_ENABLED:-0}" = "1" ]; then
	info "本機產圖"
	"$REPO_ROOT/bin/image-setup.sh"
	echo
fi

# --- 5. 收尾 ----------------------------------------------------------------
ok "setup 完成"
echo
echo "狀態目錄：$STATE_DIR"
echo "  workspace/  → 掛進沙箱容器的 /workspace"
echo "  channels/   → Slack 對話歷史"
echo "  home/       → 隔離用 HOME"
echo "  logs/       → 執行日誌"
echo
echo "接下來："
echo "  1. 填好 config/agent.env 裡的兩個 Slack token（README「設定 Slack」）"
echo "  2. bin/start.sh"
echo "  3. bin/status.sh   ← 任何時候想知道現在是什麼情況"
