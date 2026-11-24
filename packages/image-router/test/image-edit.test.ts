// !edit（參考圖修改，issue #31）的測試。跑法：npm test（會先 build）。Slack 下載參考圖的測試在 runtimes/mom/test/slack-image.test.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
	checkEditPrompt,
	editSize,
	isEditCommand,
	isImgCommand,
	isSexualEdit,
	normalizeEditParams,
	normalizeParams,
	parseEditCommand,
} from "../dist/commands.js";
import { loadImageConfig } from "../dist/config.js";
import { DEFAULT_STATS, estimateTotal, stepSec, updateStats } from "../dist/eta.js";
import { imageInfo, loadLocalImage, toRefImage } from "../dist/ref-image.js";
import { SdClient } from "../dist/sd-client.js";
import { SdServerProcess } from "../dist/server-process.js";
import { failureEventText, ImageSupervisor } from "../dist/supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures", "fake-sd-server.mjs");
chmodSync(FAKE, 0o755);
const tmp = mkdtempSync(join(tmpdir(), "mom-edit-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function cfg(over: Record<string, string> = {}) {
	return loadImageConfig({
		STATE_DIR: join(tmp, `state-${Math.random().toString(36).slice(2)}`),
		IMAGE_ENABLED: "1",
		HOST: "ollama",
		LLM_MODEL: "qwen",
		...over,
	});
}

// ── 小工具：做測試用的圖檔頭 ───────────────────────────────────────────────
function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (const b of buf) {
		crc ^= b;
		for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const c = Buffer.alloc(4);
	c.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, c]);
}
function makePng(w: number, h: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
	for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
/** SOI + APP0（JFIF）+ DQT 片段 + SOF0：只有檔頭，夠判斷尺寸。 */
function makeJpegHeader(w: number, h: number, sof = 0xc0): Buffer {
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
	const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
	const sofSeg = Buffer.from([0xff, sof, 0x00, 0x11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sofSeg, Buffer.from([0xff, 0xd9])]);
}
function makeWebpVp8x(w: number, h: number): Buffer {
	const b = Buffer.alloc(30);
	b.write("RIFF", 0, "ascii");
	b.writeUInt32LE(22, 4);
	b.write("WEBP", 8, "ascii");
	b.write("VP8X", 12, "ascii");
	b.writeUInt32LE(10, 16);
	b.writeUIntLE(w - 1, 24, 3);
	b.writeUIntLE(h - 1, 27, 3);
	return b;
}

// ── 指令 ─────────────────────────────────────────────────────────────────
describe("!edit 指令", () => {
	it("解析：和 !img 共用參數格式，互不誤認", () => {
		assert.ok(isEditCommand("!edit 把雪鏡換成眼鏡"));
		assert.ok(isEditCommand("！edit x"));
		assert.ok(isEditCommand("/edit x"));
		assert.ok(!isEditCommand("!editor x"));
		assert.ok(!isEditCommand("please !edit this"));
		assert.ok(!isImgCommand("!edit x"));
		assert.deepEqual(parseEditCommand("!edit 把雪鏡換成細框眼鏡 --seed 7 --steps 3"), { prompt: "把雪鏡換成細框眼鏡", seed: 7, steps: 3 });
		assert.deepEqual(parseEditCommand("!edit x --size 512x768"), { prompt: "x", width: 512, height: 768 });
		assert.equal(parseEditCommand("hello"), null);
	});

	it("修改說明的檢查：空白、--nsfw、裸露字眼都在下載照片之前擋下", () => {
		assert.match(String(checkEditPrompt({ prompt: "" })), /沒有寫要怎麼改/);
		assert.match(String(checkEditPrompt({ prompt: "x", nsfw: true })), /不支援 `--nsfw`/);
		assert.match(String(checkEditPrompt({ prompt: "make her naked" })), /不做裸露/);
		assert.equal(checkEditPrompt({ prompt: "把雪鏡換成眼鏡" }), null);
	});

	it("裸露、脫衣、性感化字眼（中英文）", () => {
		for (const bad of [
			"make her nude",
			"remove his shirt",
			"take off her clothes",
			"put her in lingerie",
			"without clothes",
			"change to a bikini",
			"讓她裸體",
			"把衣服脫掉",
			"把她的上衣都脫了",
			"讓他不穿衣服",
			"脫光",
			"換成性感內衣",
			"改成比基尼",
		]) {
			assert.ok(isSexualEdit(bad), bad);
		}
		// 不能誤擋一般修改
		for (const ok of [
			"把雪鏡換成細框眼鏡",
			"脫掉帽子",
			"把貓變成人",
			"透視感更強一點",
			"桌上加一杯牛乳",
			"remove the hat",
			"change the background to a beach",
			"add a zebra in the background",
			"add a brass lamp",
		]) {
			assert.ok(!isSexualEdit(ok), ok);
		}
	});

	it("輸出尺寸：保持原圖比例，像素數和 !img 預設相同，對齊 16", () => {
		const c = cfg();
		assert.deepEqual(editSize(4032, 3024, c), { width: 1024, height: 768 }, "手機橫拍 4:3");
		assert.deepEqual(editSize(768, 1024, c), { width: 768, height: 1024 });
		const sq = editSize(1000, 1000, c);
		assert.equal(sq.width, sq.height);
		assert.ok(sq.width * sq.height <= 768 * 1024);
		const wide = editSize(1920, 1080, c);
		assert.equal(wide.width % 16, 0);
		assert.equal(wide.height % 16, 0);
		assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 0.05);
	});

	it("normalizeEditParams：帶上參考圖、不套 LoRA；自訂 --size 照用", () => {
		const c = cfg();
		const ref = { b64: "AAAA", width: 3024, height: 4032, label: "IMG_1.jpg" };
		const p = normalizeEditParams({ prompt: "換成眼鏡" }, ref, c);
		assert.ok(typeof p !== "string");
		assert.equal(p.ref, ref);
		assert.equal(p.nsfw, false);
		assert.deepEqual([p.width, p.height], [768, 1024]);
		const q = normalizeEditParams({ prompt: "x", width: 512, height: 512 }, ref, c);
		assert.ok(typeof q !== "string");
		assert.deepEqual([q.width, q.height], [512, 512]);
		const bad = normalizeEditParams({ prompt: "x", steps: 99 }, ref, c);
		assert.match(String(bad), /步數/);
	});

	it("!edit 可以用 --lora，但不套檔名像 NSFW 的 LoRA", () => {
		const c = cfg();
		const ref = { b64: "AAAA", width: 768, height: 1024, label: "IMG_1.jpg" };
		mkdirSync(c.loraDir, { recursive: true });
		writeFileSync(join(c.loraDir, "asian_mix.safetensors"), "x");
		writeFileSync(join(c.loraDir, "zz_party_time_nsfw.safetensors"), "x");
		const p = normalizeEditParams({ prompt: "換成眼鏡", lora: 1 }, ref, c) as any;
		assert.equal(p.lora, "asian_mix.safetensors");
		assert.match(String(normalizeEditParams({ prompt: "換成眼鏡", lora: 2 }, ref, c)), /看起來是 NSFW LoRA，`!edit` 不套用/);
		// 同一個檔案 !img 可以用
		assert.equal((normalizeParams({ prompt: "x", lora: 2 }, c) as any).lora, "zz_party_time_nsfw.safetensors");
	});
});

// ── 參考圖 ───────────────────────────────────────────────────────────────
describe("參考圖：格式、尺寸", () => {
	it("從檔頭判斷 PNG、JPEG（含 progressive）、WebP 的尺寸", () => {
		assert.deepEqual(imageInfo(makePng(640, 480)), { format: "png", width: 640, height: 480 });
		assert.deepEqual(imageInfo(makeJpegHeader(3024, 4032)), { format: "jpeg", width: 3024, height: 4032 });
		assert.deepEqual(imageInfo(makeJpegHeader(800, 600, 0xc2)), { format: "jpeg", width: 800, height: 600 });
		assert.deepEqual(imageInfo(makeWebpVp8x(1000, 750)), { format: "webp", width: 1000, height: 750 });
		assert.equal(imageInfo(Buffer.from("<!DOCTYPE html><html>login</html>")), null);
		assert.equal(imageInfo(Buffer.alloc(0)), null);
	});

	it("toRefImage：擋下非圖片（例如 Slack 回的登入頁）和太小的圖", () => {
		assert.match(String(toRefImage(Buffer.from("<html>"), "a.heic")), /不是 PNG、JPEG 或 WebP/);
		assert.match(String(toRefImage(makePng(32, 32), "tiny.png")), /太小/);
		const r = toRefImage(makePng(640, 480), "ok.png");
		assert.ok(typeof r !== "string");
		assert.equal(r.width, 640);
		assert.equal(Buffer.from(r.b64, "base64").length, makePng(640, 480).length);
	});

	it("本機圖（bot 剛產出的）直接讀檔；檔案不見時請使用者重傳", () => {
		const f = join(tmp, "img-1.png");
		writeFileSync(f, makePng(768, 1024));
		const r = loadLocalImage(f, "img-1.png");
		assert.ok(typeof r !== "string");
		assert.deepEqual([r.width, r.height], [768, 1024]);
		assert.match(String(loadLocalImage(join(tmp, "gone.png"), "gone.png")), /重新上傳/);
	});
});

// ── 預估時間 ─────────────────────────────────────────────────────────────
describe("eta：參考圖", () => {
	it("沒量過時每步 ×2.1；量過之後另外記錄 +ref，不影響一般產圖", () => {
		let s = updateStats(DEFAULT_STATS, { width: 768, height: 1024, steps: 4, samplingSec: 30 });
		assert.equal(stepSec(s, 768, 1024, false, true), 7.5 * 2.1);
		const plain = estimateTotal(s, { width: 768, height: 1024, steps: 4, needLoad: false, needSwitch: true });
		const edit = estimateTotal(s, { width: 768, height: 1024, steps: 4, needLoad: false, needSwitch: true, ref: true });
		assert.ok(edit > plain);
		s = updateStats(s, { width: 768, height: 1024, steps: 4, samplingSec: 63.2, ref: true });
		assert.equal(stepSec(s, 768, 1024, false, true), 15.8);
		assert.equal(stepSec(s, 768, 1024), 7.5);
		assert.ok("768x1024+ref" in s.stepSecBySize);
	});
});

// ── supervisor ──────────────────────────────────────────────────────────
describe("supervisor：!edit 工作", () => {
	it("送出參考圖和縮放規則；訊息寫「修改」；紀錄附原圖名稱；失敗事件說明是修改", async () => {
		process.env.FAKE_MODE = "ok";
		const port = 19300 + Math.floor(Math.random() * 500);
		const c = cfg({ IMAGE_PORT: String(port), IMAGE_SD_SERVER_BIN: FAKE, IMAGE_KEEP_ALIVE: "60" });
		const server = new SdServerProcess(FAKE, ["--listen-port", String(port)], c.pidPath, c.logPath);
		const notes = { posts: [] as string[], updates: [] as string[], uploads: [] as string[], logs: [] as string[] };
		const sup = new ImageSupervisor({
			cfg: c,
			client: new SdClient(`http://127.0.0.1:${port}`),
			server,
			gpu: { unloadOllama: async () => [], warmOllama: () => {}, vramFreeMb: async () => null },
			notifier: {
				post: async (_c, t) => {
					notes.posts.push(t);
					return "ts1";
				},
				update: async (_c, _ts, t) => {
					notes.updates.push(t);
				},
				upload: async (_c, p) => {
					notes.uploads.push(p);
				},
				logBot: (_c, t) => {
					notes.logs.push(t);
				},
				failed: () => {},
			},
			isChatBusy: () => false,
			pollMs: 20,
			slackUpdateMs: 20,
		});
		const ref = { b64: makePng(1024, 768).toString("base64"), width: 1024, height: 768, label: "ski.jpg" };
		const p = normalizeEditParams({ prompt: "replace the ski goggles with glasses", steps: 2, seed: 3 }, ref, c);
		assert.ok(typeof p !== "string");
		const r = sup.submit(p, { channelId: "C1", channelName: "general", userId: "U1", source: "command" });
		assert.ok(r.accepted);
		assert.match(r.message, /已開始修改圖片（修改「ski\.jpg」、1024×768、2 步、seed 3）/);
		await sup.lastRun;
		const last = await (await fetch(`http://127.0.0.1:${port}/debug/last`)).json();
		assert.deepEqual(last.ref_images, [ref.b64]);
		assert.equal(last.image_preprocess, "target=ref,mode=crop-resize,width=1024,height=768");
		assert.equal(last.lora, undefined);
		assert.equal(notes.uploads.length, 1);
		assert.match(notes.updates.at(-1)!, /✅ 修改完成/);
		assert.match(notes.logs[0], /已傳送修改後的圖片.*原圖「ski\.jpg」.*修改說明：replace the ski goggles/);
		assert.ok(!notes.logs[0].includes(ref.b64), "base64 不能進紀錄");
		const ev = failureEventText({ job: { ...r.job }, reason: "OOM", elapsedSec: 5, etaTotalSec: 60, logTail: "" });
		assert.match(ev, /修改圖片（!edit，原圖「ski\.jpg」）失敗/);
		assert.ok(!ev.includes(ref.b64));
		await sup.shutdown();
	});
});
