import { inflateSync } from "zlib";

/**
 * 檢查產出的 PNG 是不是「跑完了但其實壞掉」的圖。
 *
 * 為什麼要有：sd.cpp 有已知問題，例如 Z-Image Base 的 GGUF 在 CUDA 上會跑完，
 * 但輸出一張全白的圖；VAE 精度出錯時也會出現全黑或單一顏色的圖。
 * 這些情況 exit code 都是 0，不檢查的話使用者會收到一張空白圖。
 *
 * 只用 node 內建的 zlib，不另外裝套件。只支援 sd.cpp 會輸出的格式：
 * 8-bit、非交錯的灰階、RGB、RGBA；其他格式一律回傳 ok（不誤判成失敗）。
 */
export interface PngVerdict {
	ok: boolean;
	reason?: string;
	width?: number;
	height?: number;
	mean?: number;
	std?: number;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

export function checkPng(buf: Buffer): PngVerdict {
	// 不用「檔案大小」判斷：全白或單色的圖壓縮後只有幾百 bytes，
	// 用大小擋會給出「檔案太小」這種誤導的原因。一律解開來看內容。
	if (buf.length < 67) return { ok: false, reason: `輸出檔太小（${buf.length} bytes），不是完整的圖片` };
	if (!buf.subarray(0, 8).equals(SIG)) return { ok: false, reason: "輸出檔不是 PNG" };

	let off = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idat: Buffer[] = [];
	while (off + 8 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString("ascii", off + 4, off + 8);
		const data = buf.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		off += 12 + len;
	}

	const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
	if (!width || !height) return { ok: false, reason: "PNG 缺少 IHDR" };
	if (bitDepth !== 8 || interlace !== 0 || !channels) return { ok: true, width, height };

	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch {
		return { ok: false, reason: "PNG 資料損毀（解壓失敗）", width, height };
	}

	const stride = width * channels;
	if (raw.length < (stride + 1) * height) return { ok: false, reason: "PNG 資料不完整", width, height };

	// 還原 filter，同時抽樣計算亮度
	const prev = Buffer.alloc(stride);
	const cur = Buffer.alloc(stride);
	const sampleEvery = Math.max(1, Math.floor((width * height) / 40000));
	let n = 0;
	let sum = 0;
	let sumSq = 0;
	let pixelIndex = 0;
	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		const filter = raw[rowStart];
		for (let x = 0; x < stride; x++) {
			const v = raw[rowStart + 1 + x];
			const a = x >= channels ? cur[x - channels] : 0;
			const b = prev[x];
			const c = x >= channels ? prev[x - channels] : 0;
			let out: number;
			switch (filter) {
				case 0:
					out = v;
					break;
				case 1:
					out = v + a;
					break;
				case 2:
					out = v + b;
					break;
				case 3:
					out = v + ((a + b) >> 1);
					break;
				case 4:
					out = v + paeth(a, b, c);
					break;
				default:
					return { ok: false, reason: `PNG filter 不合法（${filter}）`, width, height };
			}
			cur[x] = out & 0xff;
		}
		for (let x = 0; x < width; x++, pixelIndex++) {
			if (pixelIndex % sampleEvery !== 0) continue;
			const p = x * channels;
			const lum = channels >= 3 ? 0.299 * cur[p] + 0.587 * cur[p + 1] + 0.114 * cur[p + 2] : cur[p];
			sum += lum;
			sumSq += lum * lum;
			n++;
		}
		cur.copy(prev);
	}

	const mean = sum / n;
	const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
	const r = (x: number) => Math.round(x * 10) / 10;
	if (mean > 250 && std < 8) return { ok: false, reason: "產出的是全白圖", width, height, mean: r(mean), std: r(std) };
	if (mean < 5 && std < 8) return { ok: false, reason: "產出的是全黑圖", width, height, mean: r(mean), std: r(std) };
	if (std < 3) return { ok: false, reason: "產出的是單一顏色的圖", width, height, mean: r(mean), std: r(std) };
	return { ok: true, width, height, mean: r(mean), std: r(std) };
}
