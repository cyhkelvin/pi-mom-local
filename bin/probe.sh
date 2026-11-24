#!/usr/bin/env bash
# 直接對模型主機做一次 tool-calling 實測，繞過 mom 與 Slack。
#
# 為什麼需要：當 agent 在 Slack 上「說自己沒有工具」時，要先分清楚是
#   (a) 模型本身不會產生 tool call，還是
#   (b) 模型會，但 mom / prompt / context 那一層出了問題。
# 這支腳本只測 (a)。
#
# 用法：bin/probe.sh [模型 id]   （預設用 config/agent.env 的 LLM_MODEL）

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

MODEL="${1:-$LLM_MODEL}"
BASE_URL="$(host_base_url)"
OUT="$STATE_DIR/probe"
mkdir -p "$OUT"

echo "host  : $HOST（$BASE_URL）"
echo "model : $MODEL"
echo

REQ="$OUT/request.json"
RES="$OUT/response.json"

cat > "$REQ" <<JSON
{
  "model": "$MODEL",
  "stream": false,
  "messages": [
    { "role": "user", "content": "列出目前目錄的檔案" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_files",
        "description": "列出指定路徑下的檔案",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string", "description": "要列出的路徑" } },
          "required": ["path"]
        }
      }
    }
  ]
}
JSON

curl -sf -m 120 "$BASE_URL/chat/completions" \
	-H "Content-Type: application/json" \
	-d @"$REQ" > "$RES" || die "請求失敗。$HOST 有在跑嗎？（$BASE_URL）"

node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const m = r.choices?.[0]?.message ?? {};
const calls = m.tool_calls ?? [];
if (calls.length) {
	console.log("✅ 模型有產生 tool call：");
	for (const c of calls) console.log("   " + c.function?.name + "(" + (c.function?.arguments ?? "") + ")");
	process.exit(0);
}
console.log("❌ 沒有 tool call。模型回了純文字：");
console.log("   " + String(m.content ?? "(空)").slice(0, 300));
console.log("");
console.log("可能原因：模型不支援 tools；或 context window 太小，工具說明被截掉。");
process.exit(1);
' "$RES"
STATUS=$?

echo
echo "請求：$REQ"
echo "回應：$RES"
exit $STATUS
