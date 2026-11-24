#!/usr/bin/env bash
# 日誌容量控管。
#
# 兩段規則：
#   1. 現行日誌超過 MAX_MB（預設 200M）→ copy-truncate 存成 .1，舊的往後推，保留 KEEP 份
#   2. 整個 log 目錄超過 LIMIT_GB（預設 5G）→ 由舊到新刪封存檔，直到降到上限以下
#
# 為什麼用 copy-truncate 而不是 rename：現行日誌正被 tee 開著。
# 改名的話 tee 會繼續寫進被改名的那個 inode，新檔案永遠是空的。
# tee -a 用 O_APPEND，就地清空是安全的。
#
# 用法：bin/rotate-logs.sh [--dry-run]

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

MAX_MB="${MAX_MB:-200}"
LIMIT_GB="${LIMIT_GB:-5}"
KEEP="${KEEP:-5}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

ACTIVE="$LOG_DIR/$RUNTIME.log"
run() { if [ "$DRY" -eq 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

echo "log 目錄：$LOG_DIR（目前 $(du -sh "$LOG_DIR" 2>/dev/null | cut -f1)）"

# --- 1. 現行日誌輪替 --------------------------------------------------------
if [ -f "$ACTIVE" ]; then
	size_mb=$(( $(wc -c < "$ACTIVE") / 1024 / 1024 ))
	echo "現行日誌：$(basename "$ACTIVE") ${size_mb}M（上限 ${MAX_MB}M）"
	if [ "$size_mb" -ge "$MAX_MB" ]; then
		for ((i = KEEP - 1; i >= 1; i--)); do
			[ -f "$ACTIVE.$i" ] && run "mv '$ACTIVE.$i' '$ACTIVE.$((i + 1))'"
		done
		run "cp '$ACTIVE' '$ACTIVE.1'"
		run ": > '$ACTIVE'"
		echo "  → 已輪替（copy-truncate）"
	else
		echo "  → 未達上限，不輪替"
	fi
fi

# --- 2. 目錄總量控管 --------------------------------------------------------
limit_kb=$((LIMIT_GB * 1024 * 1024))
used_kb="$(du -sk "$LOG_DIR" | cut -f1)"
if [ "$used_kb" -le "$limit_kb" ]; then
	echo "✓ 目錄總量未超過 ${LIMIT_GB}G，不刪任何檔案。"
	exit 0
fi

# 由舊到新列出 log 目錄的檔案。GNU（Linux）用 stat -c；BSD（macOS）用 stat -f。
# 不能「先試 BSD 再退回 GNU」：GNU 的 stat -f 是檔案系統資訊，會成功執行但輸出不是 mtime，
# 排序就會亂掉、刪錯檔。所以先用 stat -c 探測是哪一種。
files_oldest_first() {
	local fmt=(-f "%m %N")
	stat -c %Y / >/dev/null 2>&1 && fmt=(-c "%Y %n")
	find "$LOG_DIR" -type f -print0 | xargs -0 stat "${fmt[@]}" | sort -n | cut -d' ' -f2-
}

echo "目錄總量超過 ${LIMIT_GB}G → 由舊到新刪除封存檔"
while IFS= read -r f; do
	[ "$f" = "$ACTIVE" ] && continue          # 絕不刪現行日誌
	used_kb="$(du -sk "$LOG_DIR" | cut -f1)"
	[ "$used_kb" -le "$limit_kb" ] && break
	echo "  刪除 $(basename "$f")（$(du -h "$f" | cut -f1)）"
	run "rm -f '$f'"
done < <(files_oldest_first)

echo "處理後：$(du -sh "$LOG_DIR" | cut -f1)"
