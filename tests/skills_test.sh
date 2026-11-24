#!/usr/bin/env bash
# 內建 skill（fetch／search）的測試。
#
# 這支存在的理由：skill 的失敗只會出現在 Slack 上一句「我查不到」，
# 不會有 stack trace。所以每一條失敗路徑都要在這裡先跑過一次。
#
# 三件在開發當下就被這支抓到的事：
#   ① fetch 遇到「整份只有一行」的 JSON 時，截斷那刀會把內容刪光
#   ② search 的 tavily 分支在 set -u 下，沒 key 就先炸在 jq 那行
#   ③ awk 的 substr 按 byte 切，中文摘要會被切成半個字
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE="${SANDBOX_IMAGE:-pi-mom-sandbox:local}"
pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
no()  { echo "  ❌ $1"; shift; [ $# -gt 0 ] && echo "$*" | sed 's/^/     /'; fail=$((fail+1)); }

# 在沙箱 image 裡跑一段 sh，repo 掛在 /repo
box() { docker run --rm -v "$PWD:/repo" -e "SEARCH_PROVIDER=${1:-brave}" "$IMAGE" sh -c "$2" 2>&1; }

# --- SKILL.md 的格式 ---------------------------------------------------------
# loader 的規則（core/skills.js）：name 必須等於目錄名、只能小寫英數與連字號、
# description 必填且 ≤1024 字。寫錯不會報錯，只是那個 skill 安靜地不存在。
echo "SKILL.md 格式"
for dir in skills/*/; do
	name="$(basename "$dir")"
	f="$dir/SKILL.md"
	[ -f "$f" ] || { no "$name 有 SKILL.md"; continue; }
	fm_name="$(awk -F': *' '/^name:/{print $2; exit}' "$f")"
	fm_desc="$(awk -F': *' '/^description:/{sub(/^description: */,""); print; exit}' "$f")"
	[ "$fm_name" = "$name" ] \
		&& ok "$name：frontmatter 的 name 等於目錄名" \
		|| no "$name：name 是「$fm_name」但目錄是「$name」——不相等 loader 會整個跳過"
	[[ "$name" =~ ^[a-z0-9-]+$ ]] \
		&& ok "$name：目錄名只用小寫英數與連字號" \
		|| no "$name：目錄名有不合法字元"
	[ -n "$fm_desc" ] && [ "${#fm_desc}" -le 1024 ] \
		&& ok "$name：description 有填且未超過 1024 字" \
		|| no "$name：description 空的或太長（${#fm_desc}）"
	grep -q '{baseDir}' "$f" \
		&& ok "$name：用 {baseDir} 指路徑（寫死路徑換機就壞）" \
		|| no "$name：SKILL.md 沒有出現 {baseDir}"
done

# --- 腳本語法 ----------------------------------------------------------------
echo
echo "腳本語法"
for s in skills/*/*.sh; do
	sh -n "$s" 2>/dev/null && ok "$(basename "$(dirname "$s")")/$(basename "$s") 語法正確" \
		|| no "$s 語法錯誤"
done

# --- image 內容 --------------------------------------------------------------
echo
echo "沙箱 image"
for c in curl lynx jq; do
	box brave "command -v $c >/dev/null" >/dev/null \
		&& ok "image 裡有 $c" || no "image 裡沒有 $c——Dockerfile 沒建好"
done

# --- fetch -------------------------------------------------------------------
echo
echo "fetch"
out="$(box brave 'sh /repo/skills/fetch/fetch.sh https://example.com')"
# example.com 改版後內文已經沒有 "Example Domain"（只剩 <title>，lynx -dump 不會輸出），改比對內文
grep -q "documentation examples" <<<"$out" && ok "抓得到一般網頁並轉成純文字" || no "抓不到 example.com" "$out"
grep -q "^來源：" <<<"$out" && ok "輸出第一行標出來源網址" || no "輸出沒有標來源"

box brave 'sh /repo/skills/fetch/fetch.sh https://example.com/nope-404' >/dev/null 2>&1 \
	&& no "404 應該要失敗卻回傳成功" || ok "404 會失敗（不會把錯誤頁當內容回傳）"

box brave 'sh /repo/skills/fetch/fetch.sh ftp://example.com' >/dev/null 2>&1 \
	&& no "非 http scheme 應該被擋" || ok "非 http/https 的網址會被擋下"

out="$(box brave 'sh /repo/skills/fetch/fetch.sh https://api.github.com/repos/torvalds/linux/commits')"
[ "$(wc -c <<<"$out")" -gt 1000 ] \
	&& ok "整份只有一行的長 JSON 不會被截成空白（①）" \
	|| no "單行長內容被刪光了" "$out"
grep -q "內容已截斷" <<<"$out" && ok "超過上限時有明講被截斷" || no "截斷了卻沒說"

# 編碼（2026-11-20：中文網頁變成「�U82�U96」亂碼）。不靠外部網站：在容器裡用 nc
# 架一次性的 HTTP server，分別測「標頭宣告 UTF-8」「只有 meta 宣告 Big5」「標頭宣告 Big5」。
# Big5 檔用 python 在 host 產生（musl 的 iconv 只能把 Big5 轉出來，不能轉進去）。
CS_DIR="$(mktemp -d)"
python3 - "$CS_DIR" <<'PY'
import sys
d = sys.argv[1]
body = '<html><body><p>台北今天天氣晴，最高溫 17 度</p></body></html>'
open(f'{d}/utf8.html', 'wb').write(body.encode('utf-8'))
open(f'{d}/big5-meta.html', 'wb').write(body.replace('<html>', '<html><head><meta http-equiv="Content-Type" content="text/html; charset=big5"></head>').encode('big5'))
open(f'{d}/big5-plain.html', 'wb').write(body.encode('big5'))
PY
serve_fetch() {  # $1 = 檔名，$2 = Content-Type 標頭
	docker run --rm -v "$PWD:/repo" -v "$CS_DIR:/cs" "$IMAGE" sh -c "
		(printf 'HTTP/1.0 200 OK\r\nContent-Type: $2\r\n\r\n'; cat /cs/$1) | nc -l -p 8080 >/dev/null 2>&1 &
		sleep 1; sh /repo/skills/fetch/fetch.sh http://127.0.0.1:8080/" 2>&1
}
for c in "utf8.html|text/html; charset=UTF-8|標頭宣告 UTF-8" \
         "big5-meta.html|text/html|只有 <meta> 宣告 Big5" \
         "big5-plain.html|text/html; charset=big5|只有 HTTP 標頭宣告 Big5"; do
	IFS='|' read -r f ct label <<<"$c"
	out="$(serve_fetch "$f" "$ct")"
	grep -q "台北今天天氣晴，最高溫 17 度" <<<"$out" && ok "中文正確：$label" || no "中文亂碼：$label" "$out"
done
rm -rf "$CS_DIR"

# --- search ------------------------------------------------------------------
echo
echo "search"
out="$(box brave 'sh /repo/skills/search/search.sh 測試')"
grep -q "還沒設定搜尋用的 API key" <<<"$out" \
	&& ok "沒有 key 時給出可行動的訊息（而不是空結果）" || no "沒 key 的訊息不對" "$out"

for p in brave tavily; do
	out="$(box "$p" "SEARCH_TEST_FIXTURE=/repo/tests/fixtures/$p-search.json sh /repo/skills/search/search.sh 測試")"
	grep -q "https://example" <<<"$out" \
		&& ok "$p：解析得出標題與網址（②）" || no "$p 解析失敗" "$out"
done
out="$(box searxng "SEARCH_TEST_FIXTURE=/repo/tests/fixtures/searxng-search.json sh /repo/skills/search/search.sh 測試")"
grep -q "https://www.cwa.gov.tw" <<<"$out" \
	&& ok "searxng：解析得出標題與網址" || no "searxng 解析失敗" "$out"

# 先收進變數再比對：這裡開了 pipefail，而 search.sh 這條路徑本來就會 exit 2，
# 直接 `box ... | grep -q` 的話整條管線會被判成失敗，grep 明明是成功的。
out="$(box zzz 'sh /repo/skills/search/search.sh 測試')"
grep -q "searxng／brave／tavily" <<<"$out" \
	&& ok "不認得的 provider 會列出支援清單" || no "不認得的 provider 訊息沒更新" "$out"

# 字元數要在容器裡量：macOS 的 wc -m 在非 UTF-8 locale 下數的是 byte，
# 200 個中文字會被算成 600，量測本身就先錯了。
chars="$(box brave 'SEARCH_TEST_FIXTURE=/repo/tests/fixtures/brave-search.json \
	sh /repo/skills/search/search.sh 測試 | grep -o "很長.*…" | head -1 | wc -m' | tr -d ' ')"
if [ -n "$chars" ] && [ "$chars" -gt 100 ]; then
	[ "$chars" -le 205 ] && ok "長摘要被截到 200 字元上限（實得 $chars）" \
		|| no "摘要沒截好（$chars 字元）——jq 的 .[:n] 沒生效？"
else
	no "fixture 裡應該要有一筆超過 200 字元的摘要（量到 ${chars:-空})"
fi
# 破字會讓 iconv 檢查失敗——這正是 ③ 的症狀
out="$(box brave 'SEARCH_TEST_FIXTURE=/repo/tests/fixtures/brave-search.json sh /repo/skills/search/search.sh 測試')"
printf '%s' "$out" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 \
	&& ok "截斷後仍是完整的 UTF-8，中文沒被切半（③）" || no "輸出有破掉的字元"

out="$(box brave 'SEARCH_TEST_FIXTURE=/repo/tests/fixtures/brave-empty.json sh /repo/skills/search/search.sh 測試')"
grep -q "查無結果" <<<"$out" && ok "查無結果時明講，不是回傳空白" || no "查無結果的訊息不對"

# --- 自架 SearXNG（有跑才測）------------------------------------------------
echo
echo "SearXNG（自架）"
NET="${SANDBOX_NETWORK:-pi-mom-net}"
if docker ps --format '{{.Names}}' | grep -qx "${SEARXNG_CONTAINER:-pi-mom-searxng}"; then
	live() { docker run --rm --network "$NET" -v "$PWD:/repo" \
		-e SEARCH_PROVIDER=searxng -e SEARXNG_URL=http://searxng:8080 \
		"$IMAGE" sh -c "$1" 2>&1; }
	out="$(live 'curl -sf -m 10 http://searxng:8080/healthz')" \
		&& ok "沙箱容器連得到 searxng（同一個 docker 網路）" \
		|| no "沙箱連不到 searxng——網路沒接上" "$out"
	out="$(live 'sh /repo/skills/search/search.sh 中央氣象署 台北')"
	grep -qE "^1\. " <<<"$out" && ok "真實查詢拿得到結果（不是 fixture）" || no "真實查詢失敗" "$out"
	n="$(grep -cE "^[0-9]+\. " <<<"$out" || true)"
	# SearXNG 的 JSON API 沒有 count 參數，會把整頁都給你——
	# 開發當下實測回了 7 筆，切片漏做就會超出 context 預算。
	[ "$n" -le 5 ] && ok "筆數被切到 5 筆上限（實得 $n）" || no "回了 $n 筆，超過上限"
	grep -q "用 fetch 讀那個網址" <<<"$out" && ok "結尾有提醒要再 fetch" || no "結尾提示不見了"
else
	echo "  ⏭ pi-mom-searxng 沒在跑，跳過（bin/searxng.sh up 可啟動）"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
