#!/bin/sh
# 把一個網址變成模型讀得動的純文字。在沙箱容器裡執行。
#
# 為什麼不是直接 wget（TASK-038）：拿回來的是原始 HTML，而本地模型是
# gemma4-32k——一頁 HTML 就能把 32K context 塞爆。2026-09-02 查出的
# 「回應中斷」根因正是 context 不夠（prompt 48KB／num_ctx 4096）。
# 所以這支的重點是「轉純文字並且截斷」，不是「抓得到」。
set -eu

# 上限寫死在這裡，不開放參數——讓模型自己決定要抓多少，等於沒有上限。
# 12000 bytes ≈ 12000 個英數字 ≈ 4000 個中文字，約 3K token。
MAX_BYTES=12000
TIMEOUT=20
UA='Mozilla/5.0 (compatible; pi-mom-local fetch skill)'

[ $# -ge 1 ] || { echo "用法：fetch.sh <url>" >&2; exit 2; }
URL="$1"

case "$URL" in
	http://*|https://*) ;;
	*) echo "✗ 只接受 http:// 或 https:// 開頭的網址，收到：$URL" >&2; exit 2 ;;
esac

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# -w 同時拿到狀態碼與 content-type：只看 body 分不出 404 頁和正常頁
META="$(curl -sS -L --max-time "$TIMEOUT" -A "$UA" \
	-o "$TMP" -w '%{http_code} %{content_type}' "$URL" 2>&1)" || {
	echo "✗ 連不上：$URL" >&2
	echo "  $META" >&2
	exit 1
}

CODE="${META%% *}"
CTYPE="${META#* }"

# 編碼：輸出一律轉成 UTF-8（2026-11-20：中文網頁變成「�U82�U96」亂碼，模型讀不到內容）。
# 來源編碼先看 HTTP 標頭的 charset=；沒寫就假設 UTF-8（現在大多數網頁的預設）。
# 只寫在 HTML <meta> 裡的編碼（例如舊的 Big5 網站）lynx 自己會讀，不用在這裡處理——
# 但 lynx 讀的是存下來的檔案，看不到 HTTP 標頭，所以標頭的編碼要由這裡傳給它。
CHARSET="$(printf '%s' "$CTYPE" | sed -n 's/.*charset=["'\'']*\([A-Za-z0-9_.:-]*\).*/\1/p' | tr 'A-Z' 'a-z')"

case "$CODE" in
	2*) ;;
	*) echo "✗ HTTP $CODE：$URL" >&2; exit 1 ;;
esac

case "$CTYPE" in
	*text/html*|*application/xhtml*)
		BODY="$(lynx -dump -nolist -width=100 -force_html \
			-assume_charset="${CHARSET:-utf-8}" -display_charset=utf-8 "$TMP" 2>/dev/null || true)" ;;
	*text/*|*application/json*|*application/xml*)
		case "${CHARSET:-utf-8}" in
			utf-8|utf8|us-ascii) BODY="$(cat "$TMP")" ;;
			# 轉不過去（musl iconv 不認得的編碼）就原樣輸出，至少英數字還讀得到
			*) BODY="$(iconv -f "$CHARSET" -t UTF-8 "$TMP" 2>/dev/null || cat "$TMP")" ;;
		esac ;;
	*)
		echo "✗ 不是文字內容（content-type: ${CTYPE:-未知}）。" >&2
		echo "  這個 skill 只處理網頁與純文字，PDF／圖片／影音請改用別的方式。" >&2
		exit 1 ;;
esac

[ -n "$BODY" ] || { echo "✗ 抓到的內容是空的：$URL" >&2; exit 1; }

# 去掉行尾空白、把連續空行壓成一行——純粹是省 context
CLEAN="$(printf '%s\n' "$BODY" | sed 's/[[:space:]]*$//' | awk 'NF{b=0} !NF{b++} b<2')"
TOTAL="$(printf '%s\n' "$CLEAN" | wc -c | tr -d ' ')"

echo "來源：$URL"
echo "（純文字擷取，上限 ${MAX_BYTES} bytes）"
echo

if [ "$TOTAL" -gt "$MAX_BYTES" ]; then
	# 砍在行邊界：head -c 會把 UTF-8 字元切成半個，sed '$d' 丟掉那不完整的一行。
	TRUNC="$(printf '%s\n' "$CLEAN" | head -c "$MAX_BYTES" | sed '$d')"
	# 但整份只有一行時（未格式化的 JSON 就是這樣），上面那刀會把全部刪光。
	# 這時只能硬切，代價是結尾可能有一個破字——比整份變空白好。
	[ -n "$TRUNC" ] || TRUNC="$(printf '%s' "$CLEAN" | head -c "$MAX_BYTES")"
	printf '%s\n' "$TRUNC"
	echo
	echo "⚠ 內容已截斷（原始 ${TOTAL} bytes，只顯示前 ${MAX_BYTES}）。"
	echo "  需要後面的內容請換更精確的網址，不要重複抓同一頁。"
else
	printf '%s\n' "$CLEAN"
fi
