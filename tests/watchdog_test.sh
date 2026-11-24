#!/usr/bin/env bash
# bin/watchdog.sh 的迴歸測試。
#
# 這支存在的理由：2026-09-11～09-16 三次殭屍，watchdog 一次都沒作動，
# 而且**完全沒有徵兆**——它不寫 log、不建戳記、退出碼看起來像正常結束。
# 根因是 lib.sh 開頭的 set -euo pipefail 被 source 進來，errexit 在
# socket_health 回非 0 的那一瞬間就把整支 script 殺了，判斷那幾行永遠跑不到。
#
# 所以這裡測的不是「它平常活著」，而是**它在該作動的時候真的作動**。
# 手法：用假 HOME 讓 STATE_DIR 跟著搬家（load_config 的 STATE_DIR 預設是 $HOME/.pi-mom-local），
# 餵真實的殭屍 log fixture，pid 指向一隻拋棄式的 sleep。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pass=0; fail=0
ok() { echo "  ✅ $1"; pass=$((pass+1)); }
no() { echo "  ❌ $1"; shift; [ $# -gt 0 ] && echo "$*" | sed 's/^/     /'; fail=$((fail+1)); }

# --- ① 靜態：errexit 必須在 source 之後被關掉 -------------------------------
# 行為測試已經涵蓋這件事，這條額外存在是為了**在失敗時直接指出兇手**：
# 只看行為會得到「戳記沒建立」，看不出是 errexit 幹的。
echo "watchdog.sh 的 errexit"
awk '/source .*lib\.sh/{s=NR} /^set \+e$/{if(s&&NR>s) found=1} END{exit !found}' bin/watchdog.sh \
	&& ok "source lib.sh 之後有 set +e（lib.sh 會把 errexit 一併帶進來）" \
	|| no "source lib.sh 之後沒有 set +e" \
	   "socket_health 回非 0 的瞬間 script 就會被殺，下面的判斷全都跑不到。"

# --- 共用：造一個與真實環境隔離的 STATE_DIR ---------------------------------
# $3 = 期望的退出碼
run_case() { # $1 名稱 $2 log fixture $3 期望「有沒有動作」yes/no
	local name="$1" fixture="$2" want="$3"
	local home; home="$(mktemp -d)"
	mkdir -p "$home/.pi-mom-local/logs"
	cp "$fixture" "$home/.pi-mom-local/logs/mom.log"

	# 拋棄式 process，代表「mom 還活著」——watchdog 的第一道檢查是 kill -0
	sleep 300 & local dummy=$!
	disown "$dummy" 2>/dev/null   # 不要讓 shell 印 "Terminated: 15"
	echo "$dummy" > "$home/.pi-mom-local/mom.pid"

	local out rc
	out="$(HOME="$home" ./bin/watchdog.sh 2>&1)"; rc=$?

	local wd="$home/.pi-mom-local/logs/watchdog.log"
	local stamp="$home/.pi-mom-local/.watchdog-last-restart"

	if grep -q "連不到 slack.com" "$wd" 2>/dev/null; then
		echo "  ⏭  $name（跳過：現在連不到 slack.com，watchdog 在判定前就先退出了）"
		kill "$dummy" 2>/dev/null; rm -rf "$home"; return
	fi

	[ "$rc" -eq 0 ] \
		&& ok "$name：退出碼 0（修復前是 socket_health 的回傳碼，代表被 errexit 殺掉）" \
		|| no "$name：退出碼 $rc，不是 0" "$out"

	if [ "$want" = yes ]; then
		grep -q "判定 rc=" "$wd" 2>/dev/null \
			&& ok "$name：watchdog.log 有寫下判定" \
			|| no "$name：watchdog.log 沒有判定那行" "$(cat "$wd" 2>/dev/null)"
		[ -f "$stamp" ] \
			&& ok "$name：建立了冷卻戳記（真實環境從 09-11 起從未被建立過）" \
			|| no "$name：沒有建立 .watchdog-last-restart"
		sleep 1
		kill -0 "$dummy" 2>/dev/null \
			&& no "$name：判成殭屍卻沒把 process 停掉" \
			|| ok "$name：process 已被停掉（起交給 launchd，watchdog 只負責停）"
	else
		[ -f "$stamp" ] \
			&& no "$name：連線健康卻建了戳記——代表它會亂重啟" \
			|| ok "$name：連線健康時不建戳記"
		kill -0 "$dummy" 2>/dev/null \
			&& ok "$name：連線健康時不動 process" \
			|| no "$name：連線健康卻把 process 停掉了"
	fi

	kill "$dummy" 2>/dev/null
	rm -rf "$home"
}

echo
echo "watchdog.sh 對殭屍的處置"
run_case "殭屍" tests/fixtures/mom-zombie-2026-09-09.log yes
echo
echo "對照組：連線健康時不該動它"
run_case "已恢復" tests/fixtures/mom-recovered.log no

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
