#!/usr/bin/env bash
# socket_health() 的迴歸測試。
# 這支存在的理由：2026-09-09 status.sh 對一個已經 3 天沒收訊息的殭屍
# 報出「應已恢復」——判定只數次數、不比先後。fixture 就是那天的真實 log。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# 只取要測的函式，不要 load_config（它會讀真實設定、建立真實目錄）
RUNTIME=mom
eval "$(sed -n '/^count_since_connect()/,/^}/p;/^last_line_since_connect()/,/^}/p;/^log_mtime_epoch()/,/^}/p;/^last_wake_epoch()/,/^}/p;/^proc_start_epoch()/,/^}/p;/^socket_health()/,/^}/p;/^ok()/,/^}/p' bin/lib.sh)"

pass=0; fail=0
check() { # $1 名稱 $2 期望 return code $3 log 檔
	local tmp; tmp="$(mktemp -d)"; LOG_DIR="$tmp"
	cp "$3" "$tmp/mom.log"
	local out rc
	out="$(socket_health "" 2>&1)"; rc=$?
	if [ "$rc" -eq "$2" ]; then
		echo "  ✅ $1"; pass=$((pass+1))
	else
		echo "  ❌ $1（期望 $2，實得 $rc）"; echo "$out" | sed 's/^/     /'; fail=$((fail+1))
	fi
	rm -rf "$tmp"
}

echo "socket_health()"
# 真實殭屍：錯誤 4 次、訊息 1 則，但訊息在錯誤之前 → 必須判殭屍
check "3 天沒收訊息的真殭屍要判 ✗（回傳 1）" 1 tests/fixtures/mom-zombie-2026-09-09.log
# 對照組：同一份 log，把訊息移到所有錯誤之後 → 才算已恢復
check "錯誤之後有收到訊息才算已恢復（回傳 0）"  0 tests/fixtures/mom-recovered.log

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
