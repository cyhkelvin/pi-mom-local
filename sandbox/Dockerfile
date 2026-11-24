# pi agent 的沙箱 image。
#
# 為什麼要有這個檔案（TASK-037）：原本 start 直接用 alpine:latest 起容器，
# 裝進去的套件在容器被重建時就沒了——「agent 自己 apk add」看似能動，
# 但換一台機器、或容器被刪掉重建，全部消失，不可重現。
#
# 這裡裝的四樣東西各有理由：
#   curl            拿 HTTP 狀態碼與 content-type（wget 拿不到），fetch/search 都要
#   lynx            HTML → 純文字。**這是 context 問題不是方便問題**：本地模型是
#                   gemma4-32k，一頁原始 HTML 就能把 32K context 塞爆（2026-09-02
#                   的「回應中斷」根因就是 context 不夠）
#   jq              解析 search API 的 JSON
#   ca-certificates 沒有它 curl 連不上任何 https
FROM alpine:3.20

RUN apk add --no-cache \
      ca-certificates \
      curl \
      jq \
      lynx \
 && update-ca-certificates

# lynx 預設會問一堆互動問題，關掉才能在 -dump 模式安靜跑完
RUN printf '%s\n' \
      'ACCEPT_ALL_COOKIES:TRUE' \
      'NO_PAUSE:TRUE' \
      'FORCE_SSL_COOKIES_SECURE:TRUE' \
      > /etc/lynx.cfg.local
ENV LYNX_CFG=/etc/lynx.cfg.local

# 中文輸出：musl 本身就是 UTF-8，但 lynx 等工具會看 LANG 決定輸出編碼。
# fetch.sh 另外明確傳 -display_charset=utf-8，這行是給 agent 自己在沙箱裡跑的指令用的。
ENV LANG=C.UTF-8

WORKDIR /workspace

# 容器本身不跑任何服務，只是給 agent 的 bash 用的殼
CMD ["tail", "-f", "/dev/null"]
