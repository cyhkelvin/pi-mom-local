import { readFileSync } from "fs";
import { basename } from "path";
import type { RefImage } from "./commands.js";

/**
 * !edit 的參考圖：判斷格式和尺寸、轉成送給 sd-server 的 base64（issue #31）。
 * 從聊天介面下載圖片是 runtime 的事（例如 mom 的 slack-image.ts），這裡只處理拿到的位元組。
 */

export type ImageFormat = "png" | "jpeg" | "webp";

/** 從檔頭判斷格式和尺寸。sd-server 解得開 PNG、JPEG、WebP；其他格式回傳 null。 */
export function imageInfo(buf: Buffer): { format: ImageFormat; width: number; height: number } | null {
	if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
		return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
		// 找 SOF0..SOF15（排除 DHT=C4、JPG=C8、DAC=CC）
		let i = 2;
		while (i + 9 < buf.length) {
			if (buf[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = buf[i + 1];
			if (marker === 0xff) {
				i++;
				continue;
			}
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				i += 2;
				continue;
			}
			const len = buf.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
			}
			i += 2 + len;
		}
		return null;
	}
	if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
		const kind = buf.toString("ascii", 12, 16);
		if (kind === "VP8X") return { format: "webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
		if (kind === "VP8L") {
			const b = buf.readUInt32LE(21);
			return { format: "webp", width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
		}
		if (kind === "VP8 ") return { format: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
	}
	return null;
}

const MAX_BYTES = 25 * 1024 * 1024;

/** 把下載或讀到的圖變成 RefImage；格式不支援時回傳給使用者看的錯誤字串。 */
export function toRefImage(buf: Buffer, label: string): RefImage | string {
	const info = imageInfo(buf);
	if (!info) return `「${label}」不是 PNG、JPEG 或 WebP 圖片，沒辦法修改。請改傳 JPG 或 PNG。`;
	if (info.width < 64 || info.height < 64) return `「${label}」太小了（${info.width}×${info.height}），至少要 64×64。`;
	return { b64: buf.toString("base64"), width: info.width, height: info.height, label };
}

/** 讀本機的圖（例如 bot 剛產出的）；讀不到時回傳給使用者看的錯誤字串。 */
export function loadLocalImage(path: string, label?: string): RefImage | string {
	try {
		return toRefImage(readFileSync(path), label || basename(path));
	} catch (err) {
		return `讀不到上一張圖（${err instanceof Error ? err.message : String(err)}），請重新上傳照片。`;
	}
}
