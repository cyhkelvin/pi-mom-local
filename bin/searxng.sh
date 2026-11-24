#!/usr/bin/env bash
# 自架 SearXNG——search skill 在 SEARCH_PROVIDER=searxng 時用的後端。
#
# 為什麼有這支（TASK-049）：Brave 與 Tavily 的免費方案現在都要綁信用卡，
# 而且等於把「你查了什麼」交給第三方。SearXNG 是 metasearch，
# 自己不建索引，代你去問 70+ 個上游引擎再合併結果——零 key、零帳號。
#
# 代價寫在前面，不要事後才發現：它是「借用別人的免費」，
# 量一大會被上游引擎擋（CAPTCHA／429）。個人用量沒問題，不要拿來爬。
#
#   bin/searxng.sh up|down|status|test
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

IMAGE="${SEARXNG_IMAGE:-searxng/searxng:latest}"
NAME="${SEARXNG_CONTAINER:-pi-mom-searxng}"
NET="${SANDBOX_NETWORK:-pi-mom-net}"
CONF_DIR="$STATE_DIR/searxng"
TEMPLATE="$REPO_ROOT/sandbox/searxng/settings.yml"

ensure_network() {
	docker network inspect "$NET" >/dev/null 2>&1 || {
		info "建立 docker 網路 $NET"
		docker network create "$NET" >/dev/null
	}
}

ensure_settings() {
	mkdir -p "$CONF_DIR"
	local keyfile="$CONF_DIR/secret_key"
	# secret_key 每個實例一組，產生後留著；重產會讓既有 session 失效。
	# 放 STATE_DIR 不放 repo——它是憑證性質的東西。
	[ -f "$keyfile" ] || { openssl rand -hex 32 > "$keyfile"; chmod 600 "$keyfile"; }
	# 範本比實體新就重新產生，這樣改 settings.yml 才會生效
	if [ ! -f "$CONF_DIR/settings.yml" ] || [ "$TEMPLATE" -nt "$CONF_DIR/settings.yml" ]; then
		sed "s|__SECRET_KEY__|$(cat "$keyfile")|" "$TEMPLATE" > "$CONF_DIR/settings.yml"
		info "已由範本產生 $CONF_DIR/settings.yml"
	fi
}

case "${1:-up}" in
up)
	docker info >/dev/null 2>&1 || die "docker daemon 沒起來 → open -a Docker"
	ensure_network
	ensure_settings
	if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
		ok "SearXNG 已在跑（$NAME）"
		exit 0
	fi
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	info "啟動 SearXNG（$IMAGE）"
	# 刻意不 -p 到主機：這個實例只給同網路的沙箱容器用，不對外露出。
	# limiter 關掉的前提就是這件事。
	docker run -d --name "$NAME" \
		--network "$NET" --network-alias searxng \
		-v "$CONF_DIR/settings.yml:/etc/searxng/settings.yml:ro" \
		-e "SEARXNG_BASE_URL=http://searxng:8080/" \
		--restart unless-stopped \
		"$IMAGE" >/dev/null
	# 起來要一點時間，等它真的能回應再說「就緒」
	for _ in $(seq 1 30); do
		if docker run --rm --network "$NET" "$SANDBOX_IMAGE" \
			curl -sf -m 3 "http://searxng:8080/healthz" >/dev/null 2>&1; then
			ok "SearXNG 就緒（容器內用 http://searxng:8080）"
			exit 0
		fi
		sleep 1
	done
	die "SearXNG 起來了但 30 秒內沒有回應健康檢查
看 log：docker logs $NAME"
	;;
down)
	docker rm -f "$NAME" >/dev/null 2>&1 && ok "已停止 $NAME" || info "$NAME 本來就沒在跑"
	;;
status)
	if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
		ok "$NAME 在跑（$(docker inspect -f '{{.State.Status}}, 啟動於 {{.State.StartedAt}}' "$NAME")）"
	else
		echo "✗ $NAME 沒在跑"
	fi
	;;
test)
	# 直接打 JSON API，確認 formats 有開、limiter 沒擋。
	# jq 的 filter 一律用 ASCII key——非 ASCII 的物件 key 要加引號，
	# 而這裡已經被 sh -c 的單引號包住，再嵌單引號會直接語法錯誤。
	echo "→ 對 SearXNG 打一次真實查詢（台北 天氣）"
	docker run --rm --network "$NET" "$SANDBOX_IMAGE" sh -c '
		curl -sS -m 25 -G --data-urlencode "q=台北 天氣" --data "format=json" \
			http://searxng:8080/search \
		| jq "{count: (.results | length), first_title: .results[0].title, first_url: .results[0].url, engine: .results[0].engine}"'
	;;
*)
	die "用法：bin/searxng.sh up|down|status|test" ;;
esac
