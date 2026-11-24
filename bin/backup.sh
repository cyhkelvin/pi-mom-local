#!/usr/bin/env bash
# 備份 Slack 頻道資料，by channel。
#
# 備份什麼：$STATE_DIR/channels 底下每個頻道目錄的全部內容
#   log.jsonl / context.jsonl / last_prompt.jsonl / MEMORY.md 及其他副產物
#
# 為什麼要備份：這些是「必須留存、但絕不能進版控」的東西——
# 裡面有真實對話與使用者記憶，而這個 repo 是 public。

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

DEST="$STATE_DIR/backup"
STAMP="$(date +%F_%H%M)"
mkdir -p "$DEST"

found=0
for dir in "$CHANNELS_DIR"/*/; do
	[ -f "$dir/log.jsonl" ] || continue   # 頻道目錄的判準
	channel="$(basename "$dir")"
	target="$DEST/$channel/$STAMP"
	mkdir -p "$target"
	rsync -a "$dir" "$target/"
	echo "✓ $channel → $target ($(du -sh "$target" | cut -f1), $(wc -l < "$dir/log.jsonl" | tr -d ' ') 則訊息)"
	found=$((found + 1))
done

if [ -f "$CHANNELS_DIR/MEMORY.md" ]; then
	mkdir -p "$DEST/_global/$STAMP"
	cp "$CHANNELS_DIR/MEMORY.md" "$DEST/_global/$STAMP/"
	echo "✓ _global → $DEST/_global/$STAMP (MEMORY.md)"
fi

[ "$found" -eq 0 ] && echo "（沒有找到任何頻道目錄，agent 可能還沒收過訊息）"
echo
echo "備份根目錄：$DEST（$(du -sh "$DEST" | cut -f1)）"
