#!/usr/bin/env bash
# 準備本機產圖：下載 FLUX.2 Klein 4B（Q4）、abliterated 文字編碼器、VAE，並檢查 sd-server。
# 可重複執行：已下載且 sha256 正確的檔案會跳過。說明見 packages/image-router/README.md。
#
# 用法：bin/image-setup.sh [--with-nsfw]
#   --with-nsfw  另外下載選用的 NSFW LoRA（Civitai 要登入才能下載：先設環境變數 CIVITAI_TOKEN，
#                在 https://civitai.com/user/account 的 API Keys 產生）。預設不下載。

WITH_NSFW=0
for arg in "$@"; do
	case "$arg" in
		--with-nsfw) WITH_NSFW=1 ;;
		*) echo "用法：bin/image-setup.sh [--with-nsfw]" >&2; exit 2 ;;
	esac
done
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

IMAGE_ROOT="$STATE_DIR/models/image"
MODEL_DIR="${IMAGE_MODEL_DIR:-$IMAGE_ROOT/flux2}"
BIN="${IMAGE_SD_SERVER_BIN:-$STATE_DIR/bin/sd-server}"
mkdir -p "$MODEL_DIR/loras" "$MODEL_DIR/nsfw"

# 舊配置（2026-11-22 以前）：模型直接放在 models/image/，NSFW LoRA 在 models/image/loras/。
# 搬到 flux2/、flux2/nsfw/，不用重新下載。
if [ -z "${IMAGE_MODEL_DIR:-}" ]; then
	for f in flux-2-klein-4b-Q4_0.gguf Qwen3-4B-abliterated.Q4_K_M.gguf flux2-klein-vae.safetensors SHA256SUMS; do
		if [ -f "$IMAGE_ROOT/$f" ] && [ ! -e "$MODEL_DIR/$f" ]; then mv "$IMAGE_ROOT/$f" "$MODEL_DIR/$f" && ok "搬移 $f → flux2/"; fi
	done
	if [ -f "$IMAGE_ROOT/loras/party_time_v2.1_klein4b.safetensors" ] && [ ! -e "$MODEL_DIR/nsfw/party_time_v2.1_klein4b.safetensors" ]; then
		mv "$IMAGE_ROOT/loras/party_time_v2.1_klein4b.safetensors" "$MODEL_DIR/nsfw/" && ok "搬移 NSFW LoRA → flux2/nsfw/"
		rmdir "$IMAGE_ROOT/loras" 2>/dev/null || true
	fi
fi

# 檔名|來源|sha256（2026-11-19 下載時記錄）
MODELS=(
	"flux-2-klein-4b-Q4_0.gguf|https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q4_0.gguf|d1023499ef3f2f82ff7c50e6778495195c1b6cc34835741778868428111f9ff4"
	"Qwen3-4B-abliterated.Q4_K_M.gguf|https://huggingface.co/mradermacher/Qwen3-4B-abliterated-GGUF/resolve/main/Qwen3-4B-abliterated.Q4_K_M.gguf|655eb731037f42b66ada10ecc36681e1f46450f7010b32978ca4a9359a5e1302"
	"flux2-klein-vae.safetensors|https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/main/vae/diffusion_pytorch_model.safetensors|ca70d2202afe6415bdbcb8793ba8cd99fd159cfe6192381504d6c4d3036e0f04"
)
# 選用的 NSFW LoRA（--with-nsfw 才下載）：Civitai 2458332 v2.1 Klein 4B，作者允許商用與衍生。
NSFW_MODEL="nsfw/party_time_v2.1_klein4b.safetensors|https://civitai.com/api/download/models/3373883|3a281e338b72e5219d6ffcea6ca8700d436ecb83abbd9c1124814a622f68fa51"
if [ "$WITH_NSFW" = 1 ]; then
	[ -n "${CIVITAI_TOKEN:-}" ] || die "--with-nsfw 需要 CIVITAI_TOKEN（Civitai 的 API key，https://civitai.com/user/account）"
	MODELS+=("$NSFW_MODEL")
fi

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

info "模型目錄：$MODEL_DIR"
for entry in "${MODELS[@]}"; do
	IFS='|' read -r name url want <<<"$entry"
	f="$MODEL_DIR/$name"
	mkdir -p "$(dirname "$f")"
	if [ -f "$f" ] && [ "$(sha "$f")" = "$want" ]; then
		ok "$name（已存在，sha256 正確）"
		continue
	fi
	echo "→ 下載 $name"
	auth=()
	case "$url" in https://civitai.com/*) auth=(-H "Authorization: Bearer ${CIVITAI_TOKEN:-}") ;; esac
	curl -fL -C - --retry 3 "${auth[@]}" -o "$f" "$url" || die "下載失敗：$url"
	got="$(sha "$f")"
	[ "$got" = "$want" ] || die "$name 的 sha256 不符（$got），檔案可能不完整或上游換了版本"
	ok "$name"
done
echo

info "sd-server"
if [ -x "$BIN" ]; then
	ok "$BIN"
else
	echo "✗ 找不到 $BIN"
	echo "  stable-diffusion.cpp 的 release 沒有 Linux CUDA 版，要自己編譯："
	echo "    git clone --recursive https://github.com/leejet/stable-diffusion.cpp"
	echo "    cmake -B build -DSD_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=75   # 75 = RTX 20 系列"
	echo "    cmake --build build -j --config Release"
	echo "    cp build/bin/sd-server \"$BIN\""
	echo "  （需要 CUDA toolkit / nvcc；macOS 用 -DSD_METAL=ON）"
fi
echo
echo "一般 LoRA（!img ... --lora）：自己下載放進 $MODEL_DIR/loras/，設定 config/agent.env 的 IMAGE_LORA=檔名"
[ "$WITH_NSFW" = 1 ] && echo "NSFW LoRA：在 config/agent.env 設 IMAGE_NSFW_LORA=party_time_v2.1_klein4b.safetensors 才會啟用 --nsfw"
echo "設定：config/agent.env 的 IMAGE_ENABLED=1，然後 bin/stop.sh && bin/start.sh"
