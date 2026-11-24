#!/bin/sh
# 關鍵字 → 搜尋結果清單。在沙箱容器裡執行。
#
# 為什麼需要它（TASK-039）：沒有搜尋，agent 只能猜網址，
# 而猜錯的網址會變成一連串 404。先 search 找到來源，再用 fetch 讀內容。
#
# 憑證從環境變數來，是在 docker run 當下注入的（見 runtimes/mom/start）。
# 所以改了 config/agent.env 的 key 之後，必須重啟才會生效——
# start 會比對 label 自動重建容器，不需要手動 docker rm。
set -eu

# 同樣是 context 問題：回太多筆會把後面 fetch 的額度吃掉。
MAX_RESULTS=5
MAX_DESC=200
TIMEOUT=20

[ $# -ge 1 ] || { echo "用法：search.sh <關鍵字>" >&2; exit 2; }
QUERY="$*"
PROVIDER="${SEARCH_PROVIDER:-brave}"

no_key() {
	echo "✗ 還沒設定搜尋用的 API key（目前 SEARCH_PROVIDER=$PROVIDER）。" >&2
	echo "  這不是你能自己解決的，請直接告訴使用者：" >&2
	echo "  要在 config/agent.env 填入 $1，然後重啟 pi agent。" >&2
	exit 3
}

case "$PROVIDER" in
	brave)
		[ -n "${BRAVE_SEARCH_API_KEY:-}${SEARCH_TEST_FIXTURE:-}" ] || no_key BRAVE_SEARCH_API_KEY
		RAW=""
		[ -n "${SEARCH_TEST_FIXTURE:-}" ] || RAW="$(curl -sS --max-time "$TIMEOUT" -G \
			-H 'Accept: application/json' \
			-H "X-Subscription-Token: $BRAVE_SEARCH_API_KEY" \
			--data-urlencode "q=$QUERY" \
			--data "count=$MAX_RESULTS" \
			-w '\n%{http_code}' \
			https://api.search.brave.com/res/v1/web/search)" || {
			echo "✗ 連不上 Brave Search API" >&2; exit 1; }
		FILTER='def c: (. // "") | gsub("[\\n\\r\\t]+"; " ") | gsub("^ +| +$"; "");
		         def cut: if length > $maxdesc then .[:$maxdesc] + "…" else . end;
		         (.web.results // [])[:$maxn] | .[] | "\(.title|c)\n\(.url)\n\(.description|c|cut)"'
		;;
	tavily)
		[ -n "${TAVILY_API_KEY:-}${SEARCH_TEST_FIXTURE:-}" ] || no_key TAVILY_API_KEY
		BODY="$(jq -n --arg k "${TAVILY_API_KEY:-}" --arg q "$QUERY" \
			--argjson n "$MAX_RESULTS" \
			'{api_key:$k, query:$q, max_results:$n}')"
		RAW=""
		[ -n "${SEARCH_TEST_FIXTURE:-}" ] || RAW="$(curl -sS --max-time "$TIMEOUT" \
			-H 'Content-Type: application/json' \
			-d "$BODY" -w '\n%{http_code}' \
			https://api.tavily.com/search)" || {
			echo "✗ 連不上 Tavily API" >&2; exit 1; }
		FILTER='def c: (. // "") | gsub("[\\n\\r\\t]+"; " ") | gsub("^ +| +$"; "");
		         def cut: if length > $maxdesc then .[:$maxdesc] + "…" else . end;
		         (.results // [])[:$maxn] | .[] | "\(.title|c)\n\(.url)\n\(.content|c|cut)"'
		;;
	searxng)
		# 自架的 metasearch，不需要 key。URL 指向同一個 docker 網路上的容器。
		URL="${SEARXNG_URL:-http://searxng:8080}"
		RAW=""
		[ -n "${SEARCH_TEST_FIXTURE:-}" ] || RAW="$(curl -sS --max-time "$TIMEOUT" -G \
			-H 'Accept: application/json' \
			--data-urlencode "q=$QUERY" \
			--data "format=json" \
			`# SearXNG 沒有限制筆數的參數，切片在下面的 jq 做` \
			-w '\n%{http_code}' \
			"$URL/search")" || {
			echo "✗ 連不上自架的 SearXNG（$URL）。" >&2
			echo "  請告訴使用者：可能是 SearXNG 容器沒起來，用 bin/searxng.sh status 檢查。" >&2
			exit 1; }
		FILTER='def c: (. // "") | gsub("[\\n\\r\\t]+"; " ") | gsub("^ +| +$"; "");
		         def cut: if length > $maxdesc then .[:$maxdesc] + "…" else . end;
		         (.results // [])[:$maxn] | .[] | "\(.title|c)\n\(.url)\n\(.content|c|cut)"'
		;;
	*)
		echo "✗ 不認得的 SEARCH_PROVIDER：$PROVIDER（只支援 searxng／brave／tavily）" >&2
		exit 2 ;;
esac

# 測試用注入點：沒有 API key 就驗不到成功路徑，而「等使用者填了 key 才發現
# jq 寫錯」是最糟的發現時機。設了這個變數就直接讀檔當回應，不打網路。
# 只有 tests/skills_test.sh 會用；正常執行不會設它。
if [ -n "${SEARCH_TEST_FIXTURE:-}" ]; then
	RAW="$(cat "$SEARCH_TEST_FIXTURE")
200"
fi

CODE="$(printf '%s' "$RAW" | tail -n 1)"
JSON="$(printf '%s' "$RAW" | sed '$d')"

case "$CODE" in
	200) ;;
	401|403)
		if [ "$PROVIDER" = "searxng" ]; then
			# 這是整合 SearXNG 最常見的失敗：settings.yml 的 search.formats
			# 預設只有 html，沒加 json 的話 API 就回 403，而且不會說原因。
			echo "✗ SearXNG 拒絕了 JSON 請求（HTTP $CODE）。" >&2
			echo "  請告訴使用者：settings.yml 的 search.formats 要包含 json，" >&2
			echo "  或 server.limiter 把這個請求當成機器人擋掉了。" >&2
		else
			echo "✗ API key 被拒絕（HTTP $CODE）。請告訴使用者 key 可能填錯或已失效。" >&2
		fi
		exit 3 ;;
	429)
		echo "✗ 超過用量上限（HTTP $CODE）。免費方案有每月次數限制，今天先別再搜了。" >&2
		exit 3 ;;
	*)
		echo "✗ 搜尋失敗（HTTP $CODE）" >&2
		printf '%s\n' "$JSON" | head -c 300 >&2
		exit 1 ;;
esac

RESULTS="$(printf '%s' "$JSON" | jq -r --argjson maxdesc "$MAX_DESC" --argjson maxn "$MAX_RESULTS" "$FILTER" 2>/dev/null || true)"
[ -n "$RESULTS" ] || { echo "（查無結果：$QUERY）"; exit 0; }

echo "搜尋：$QUERY（$PROVIDER，最多 $MAX_RESULTS 筆）"
echo
printf '%s\n' "$RESULTS" | awk '
	# 只負責編號與縮排。截字在 jq 那邊做——awk 的 substr 是按 byte 切，
	# 會把中文切成半個字（2026-09-15 的 fixture 測試就是這樣抓到的）。
	{ i = (NR - 1) % 3 }
	i == 0 { printf "%d. %s\n", int((NR - 1) / 3) + 1, $0 }
	i == 1 { printf "   %s\n", $0 }
	i == 2 { if ($0 != "") printf "   %s\n", $0; print "" }
'
echo "以上只是標題與摘要。要知道某一筆實際寫什麼，用 fetch 讀那個網址。"
