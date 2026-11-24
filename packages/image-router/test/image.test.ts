// 產圖 router／監控器的測試。跑法：npm test（會先 build）
// （import 的是 dist/ 編譯後的檔案；src 互相 import 用 .js 副檔名，node 直接跑 .ts 會解析不到）
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { controlWord, formatLoraList, isLoraListCommand, normalizeParams, parseImgCommand } from "../dist/commands.js";
import { buildServerArgs, listLoras, loadImageConfig, loraRequestPath, parseDuration } from "../dist/config.js";
import { DEFAULT_STATS, estimateRemaining, estimateTotal, fmtSec, loadStats, stepSec, timeoutSec, updateStats } from "../dist/eta.js";
import { waitVramFree } from "../dist/gpu.js";
import { checkPng } from "../dist/png-check.js";
import { parseJob, SdClient } from "../dist/sd-client.js";
import { cleanupStaleServer, SdServerProcess } from "../dist/server-process.js";
import { failureEventText, ImageSupervisor } from "../dist/supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures", "fake-sd-server.mjs");
chmodSync(FAKE, 0o755);
const tmp = mkdtempSync(join(tmpdir(), "mom-image-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 在 path 放一個假的權重檔（只要存在就好）。 */
function touch(path: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "x");
}

/** 新的配置：models/image/flux2/{loras,nsfw}/，兩個 LoRA 檔都放好。 */
function cfg(over: Record<string, string> = {}) {
	const state = join(tmp, `state-${Math.random().toString(36).slice(2)}`);
	touch(join(state, "models", "image", "flux2", "nsfw", "party_time_v2.1_klein4b.safetensors"));
	touch(join(state, "models", "image", "flux2", "loras", "asian.safetensors"));
	return loadImageConfig({
		STATE_DIR: state,
		IMAGE_ENABLED: "1",
		HOST: "ollama",
		LLM_MODEL: "gemma4-32k",
		IMAGE_NSFW_LORA: "party_time_v2.1_klein4b.safetensors",
		...over,
	});
}

// ── 小工具：做 PNG ────────────────────────────────────────────────────────
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
function makePng(w: number, h: number, px: (x: number, y: number) => [number, number, number], filter = 0): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const stride = w * 3;
	const raw = Buffer.alloc((stride + 1) * h);
	let prev = Buffer.alloc(stride);
	for (let y = 0; y < h; y++) {
		const row = Buffer.alloc(stride);
		for (let x = 0; x < w; x++) row.set(px(x, y), x * 3);
		raw[y * (stride + 1)] = filter;
		for (let i = 0; i < stride; i++) {
			// filter 2（Up）：存 row - prev，用來驗證解碼器有正確還原
			raw[y * (stride + 1) + 1 + i] = filter === 2 ? (row[i] - prev[i]) & 0xff : row[i];
		}
		prev = row;
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ── commands ─────────────────────────────────────────────────────────────
describe("commands", () => {
	it("解析 !img 與參數", () => {
		const r = parseImgCommand("!img a woman in a red coat, rainy street --size 512x768 --steps 3 --seed 42");
		assert.deepEqual(r, { prompt: "a woman in a red coat, rainy street", width: 512, height: 768, steps: 3, seed: 42 });
		assert.equal(parseImgCommand("/img cat")?.prompt, "cat");
		assert.equal(parseImgCommand("！img 貓")?.prompt, "貓");
		assert.equal(parseImgCommand("imagine a cat"), null);
		assert.equal(parseImgCommand("!imgx cat"), null);
		assert.deepEqual(parseImgCommand("!img nude figure study --nsfw --seed 1"), { prompt: "nude figure study", seed: 1, nsfw: true });
		assert.equal(parseImgCommand("!img cat --nsfwx")?.nsfw, undefined, "只認完整的 --nsfw");
	});

	it("normalizeParams：預設值、對齊、上限", () => {
		const c = cfg();
		const p = normalizeParams({ prompt: "x", width: 770, height: 1000 }, c);
		assert.ok(typeof p !== "string");
		assert.equal(p.width, 768);
		assert.equal(p.height, 1008 > 1000 ? 1008 : 1000);
		assert.equal(p.steps, 4);
		assert.match(String(normalizeParams({ prompt: "x", width: 2048, height: 2048 }, c)), /超過上限/);
		assert.match(String(normalizeParams({ prompt: "x", steps: 20 }, c)), /步數/);
		assert.match(String(normalizeParams({ prompt: "  " }, c)), /沒有提供 prompt/);
		assert.equal((normalizeParams({ prompt: "x" }, c) as any).nsfw, false, "預設不套 LoRA");
		assert.equal((normalizeParams({ prompt: "x", nsfw: true }, c) as any).nsfw, true);
		assert.match(String(normalizeParams({ prompt: "x", nsfw: true }, cfg({ IMAGE_NSFW_LORA: "" }))), /沒有設定 NSFW LoRA/);
	});

	it("--lora、--loraN：解析、預設、編號、超過檔案數不套用", () => {
		assert.deepEqual(parseImgCommand("!img asian woman, portrait --lora --seed 3"), { prompt: "asian woman, portrait", seed: 3, lora: 0 });
		assert.deepEqual(parseImgCommand("!img x --lora2 --nsfw"), { prompt: "x", lora: 2, nsfw: true });
		assert.equal(parseImgCommand("!img x --loras")?.lora, undefined, "只認 --lora 和 --lora<數字>");
		assert.equal((normalizeParams({ prompt: "x" }, cfg()) as any).lora, undefined, "沒加 --lora 不套");

		// cfg() 的 loras/ 有 asian.safetensors；再放兩個，含子資料夾
		const c = cfg();
		touch(join(c.loraDir, "european", "face_v10.safetensors"));
		touch(join(c.loraDir, "european", "face_v2.safetensors"));
		touch(join(c.loraDir, "readme.txt"));
		assert.deepEqual(listLoras(c), ["asian.safetensors", "european/face_v2.safetensors", "european/face_v10.safetensors"], "數字照大小排、只收 safetensors");
		assert.equal((normalizeParams({ prompt: "x", lora: 0 }, c) as any).lora, "asian.safetensors", "沒設 IMAGE_LORA 時 --lora 用第一個");
		assert.equal((normalizeParams({ prompt: "x", lora: 3 }, c) as any).lora, "european/face_v10.safetensors");
		const p4 = normalizeParams({ prompt: "x", lora: 4 }, c) as any;
		assert.equal(p4.lora, undefined, "沒有第 4 個：不套用");
		assert.match(p4.loraNote, /只有 3 個 LoRA，沒有第 4 個/);

		const d = cfg({ IMAGE_LORA: "zzz.safetensors" });
		touch(join(d.loraDir, "zzz.safetensors"));
		assert.equal((normalizeParams({ prompt: "x", lora: 0 }, d) as any).lora, "zzz.safetensors", "有設 IMAGE_LORA 就用它當預設");
		assert.equal((normalizeParams({ prompt: "x", lora: 1 }, d) as any).lora, "asian.safetensors", "編號照排序，不受預設影響");
		assert.match(String(normalizeParams({ prompt: "x", lora: 0 }, cfg({ IMAGE_LORA: "missing.safetensors" }))), /找不到 LoRA 檔案：.*flux2\/loras\/missing/);
		assert.match(String(normalizeParams({ prompt: "x", nsfw: true }, cfg({ IMAGE_NSFW_LORA: "gone.safetensors" }))), /找不到 NSFW LoRA 檔案：.*flux2\/nsfw\/gone/);

		const empty = cfg();
		rmSync(join(empty.loraDir, "asian.safetensors"));
		assert.match(String(normalizeParams({ prompt: "x", lora: 0 }, empty)), /裡沒有 LoRA/);
		assert.equal((normalizeParams({ prompt: "x", lora: 1 }, empty) as any).loraNote, "loras/ 只有 0 個 LoRA，沒有第 1 個，這張不套用 LoRA");
	});

	it("!lora 清單", () => {
		assert.ok(isLoraListCommand("!lora") && isLoraListCommand("！loras") && !isLoraListCommand("!lora2"));
		const c = cfg();
		touch(join(c.loraDir, "european", "face.safetensors"));
		const t = formatLoraList(c);
		assert.match(t, /1\. asian（預設，`--lora`）\n2\. european\/face\n/);
		assert.match(formatLoraList(cfg({ IMAGE_LORA: "nope.safetensors" })), /不在資料夾裡/);
		const empty = cfg();
		rmSync(join(empty.loraDir, "asian.safetensors"));
		assert.match(formatLoraList(empty), /還沒有 LoRA/);
	});

	it("控制字", () => {
		assert.equal(controlWord("stop"), "stop");
		assert.equal(controlWord(" 取消。"), "stop");
		assert.equal(controlWord("等待"), "wait");
		assert.equal(controlWord("stop the music"), null);
	});
});

// ── config ───────────────────────────────────────────────────────────────
describe("config", () => {
	it("預設路徑以 STATE_DIR 為基準、port 7861、ram 模式（step4 實測後的預設）", () => {
		const c = loadImageConfig({ STATE_DIR: "/s", IMAGE_ENABLED: "1" });
		assert.equal(c.serverBin, "/s/bin/sd-server");
		assert.equal(c.modelDir, "/s/models/image/flux2");
		assert.equal(c.loraDir, "/s/models/image/flux2/loras");
		assert.equal(c.nsfwDir, "/s/models/image/flux2/nsfw");
		assert.equal(c.loraRoot, "/s/models/image/flux2");
		assert.equal(c.lora, "", "預設沒有 --lora");
		assert.equal(c.port, 7861);
		assert.equal(c.residentMode, "ram");
		assert.equal(c.ollamaBaseUrl, "http://localhost:11434");
		assert.equal(loadImageConfig({ HOST: "lmstudio" }).ollamaBaseUrl, undefined);
	});
	it("--lora-model-dir 指向 loras/ 和 nsfw/ 的上層", () => {
		const a = buildServerArgs(cfg());
		assert.equal(a[a.indexOf("--lora-model-dir") + 1].endsWith("/models/image/flux2"), true);
		assert.ok(buildServerArgs(cfg({ IMAGE_NSFW_LORA: "" })).includes("--lora-model-dir"), "--lora 隨時可能用到 loras/ 的檔案");
	});
	it("舊配置（模型在 models/image、NSFW LoRA 在 loras/）還沒搬家時沿用", () => {
		const state = join(tmp, "legacy");
		touch(join(state, "models", "image", "flux-2-klein-4b-Q4_0.gguf"));
		touch(join(state, "models", "image", "loras", "party_time_v2.1_klein4b.safetensors"));
		const c = loadImageConfig({ STATE_DIR: state, IMAGE_NSFW_LORA: "party_time_v2.1_klein4b.safetensors" });
		assert.equal(c.modelDir, join(state, "models", "image"));
		assert.equal(c.nsfwDir, join(state, "models", "image", "loras"));
		assert.equal(loraRequestPath(c, "nsfw"), "party_time_v2.1_klein4b.safetensors");
		assert.equal(c.loraRootError, undefined);
	});
	it("NSFW LoRA 是選用的：沒設 IMAGE_NSFW_LORA 時 --nsfw 停用", () => {
		const c = loadImageConfig({ STATE_DIR: join(tmp, "no-nsfw"), IMAGE_ENABLED: "1" });
		assert.equal(c.nsfwLora, "");
		assert.match(String(normalizeParams({ prompt: "x", nsfw: true }, c)), /沒有設定 NSFW LoRA/);
	});
	it("loras/ 和 nsfw/ 不在同一層：不掃整台電腦，--lora、--nsfw 都停用", () => {
		const c = cfg({ IMAGE_LORA_DIR: "/mnt/d/loras" });
		assert.ok(c.loraRootError);
		assert.ok(!buildServerArgs(c).includes("--lora-model-dir"));
		assert.match(String(normalizeParams({ prompt: "x", nsfw: true }, c)), /要放在同一層/);
		assert.match(String(normalizeParams({ prompt: "x", lora: 1 }, c)), /要放在同一層/);
		// 子資料夾裡的 LoRA（一包多個檔案）
		const d = cfg({ IMAGE_LORA: "european/face_v2.safetensors" });
		assert.equal(loraRequestPath(d, "lora"), "loras/european/face_v2.safetensors");
		assert.equal(loraRequestPath(d, "lora", "x/y.safetensors"), "loras/x/y.safetensors");
		assert.equal(loraRequestPath(d, "nsfw"), "nsfw/party_time_v2.1_klein4b.safetensors");
	});
	it("ram 模式加上 --offload-to-cpu", () => {
		assert.ok(buildServerArgs(cfg()).includes("--offload-to-cpu"));
		assert.ok(!buildServerArgs(cfg({ IMAGE_RESIDENT_MODE: "vram" })).includes("--offload-to-cpu"));
	});
	it("parseDuration", () => {
		assert.equal(parseDuration("10m", 0), 600);
		assert.equal(parseDuration("90s", 0), 90);
		assert.equal(parseDuration("1h", 0), 3600);
		assert.equal(parseDuration("abc", 7), 7);
	});
});

// ── eta ──────────────────────────────────────────────────────────────────
describe("eta", () => {
	it("預估、即時修正、逾時", () => {
		const s = { ...DEFAULT_STATS, switchSec: 2, loadSec: 20, stepSecBase: 0, stepSecPerMP: 10, vaeSecPerMP: 4 };
		assert.equal(estimateTotal(s, { width: 1000, height: 1000, steps: 4, needLoad: true, needSwitch: true }), 66);
		// 已常駐：不算載入，改算 condSec（預設 3）
		assert.equal(estimateTotal(s, { width: 1000, height: 1000, steps: 4, needLoad: false, needSwitch: true }), 49);
		// 實測每步 5 秒、剩 2 步、目前這一步已跑 3 秒 → 10 - 3 + VAE 4 = 11
		assert.equal(
			estimateRemaining(s, 1000, 1000, { completedSteps: 2, totalSteps: 4, stepsElapsedSec: 10, currentStepSec: 3 }, 99),
			11,
		);
		// 倒數不會因為時間過去而變大：目前這一步跑越久，剩餘越少
		const a = estimateRemaining(s, 1000, 1000, { completedSteps: 1, totalSteps: 4, stepsElapsedSec: 5, currentStepSec: 1 }, 0);
		const b = estimateRemaining(s, 1000, 1000, { completedSteps: 1, totalSteps: 4, stepsElapsedSec: 5, currentStepSec: 4 }, 0);
		assert.ok(b < a);
		// 還沒完成任何一步：用統計的每步秒數（10）
		assert.equal(
			estimateRemaining(s, 1000, 1000, { completedSteps: 0, totalSteps: 4, stepsElapsedSec: 0, currentStepSec: 0 }, 0),
			44,
		);
		// 第 0 步已經跑了 60 秒（比統計的 10 秒久很多）：剩下 3 步以 60 秒計，不會顯示 0
		assert.equal(
			estimateRemaining(s, 1000, 1000, { completedSteps: 0, totalSteps: 4, stepsElapsedSec: 0, currentStepSec: 60 }, 0),
			4 * 60 - 60 + 4,
		);
		assert.equal(estimateRemaining(s, 1000, 1000, null, 30.4), 30);
		// 預估已經過了也不顯示 0：下限是 VAE 時間
		assert.equal(estimateRemaining(s, 1000, 1000, null, -20), 4);
		assert.equal(timeoutSec(100, 3, 180), 300);
		assert.equal(timeoutSec(10, 3, 180), 180);
	});
	it("每步秒數：固定成本 + 每百萬像素；量過的尺寸以實測值為準", () => {
		// 預設值（2026-11-20 RTX 2060 實測擬合）：512² 約 7.4、1024² 約 10.2 秒/步
		assert.ok(Math.abs(stepSec(DEFAULT_STATS, 512, 512) - 7.4) < 0.2);
		assert.ok(Math.abs(stepSec(DEFAULT_STATS, 1024, 1024) - 10.2) < 0.2);
		let s = updateStats(DEFAULT_STATS, { width: 768, height: 1024, steps: 4, samplingSec: 30, loadSec: 30 });
		assert.equal(stepSec(s, 768, 1024), 7.5, "第一次量到就直接用實測值");
		assert.equal(s.loadSec, 30);
		s = updateStats(s, { width: 768, height: 1024, steps: 4, samplingSec: 40 });
		assert.equal(stepSec(s, 768, 1024), 7.5 * 0.7 + 10 * 0.3, "之後用 EMA");
		assert.equal(s.samples, 2);
	});
	it("新啟動的第一張圖（含磁碟讀取、CUDA 暖機）不拿來更新每步秒數", () => {
		const s = updateStats(DEFAULT_STATS, { width: 512, height: 512, steps: 4, samplingSec: 46, vaeSec: 9, loadSec: 12, fresh: true });
		assert.equal(stepSec(s, 512, 512), stepSec(DEFAULT_STATS, 512, 512));
		assert.equal(s.vaeSecPerMP, DEFAULT_STATS.vaeSecPerMP);
		assert.equal(s.loadSec, 12, "載入時間照樣記錄");
	});
	it("舊版統計檔（線性模型）不沿用", () => {
		const f = join(tmp, "old-stats.json");
		writeFileSync(f, JSON.stringify({ stepSecPerMP: 906, vaeSecPerMP: 191, samples: 3 }));
		assert.deepEqual(loadStats(f), DEFAULT_STATS);
	});
	it("LoRA 的每步秒數另外記錄；沒量過時用 ×1.45 估", () => {
		let s = updateStats(DEFAULT_STATS, { width: 768, height: 1024, steps: 4, samplingSec: 30 });
		assert.equal(stepSec(s, 768, 1024, true), 7.5 * 1.45);
		s = updateStats(s, { width: 768, height: 1024, steps: 4, samplingSec: 43.2, lora: true });
		assert.equal(stepSec(s, 768, 1024, true), 10.8);
		assert.equal(stepSec(s, 768, 1024), 7.5, "沒套 LoRA 的不受影響");
	});
	it("fmtSec", () => {
		assert.equal(fmtSec(45), "45 秒");
		assert.equal(fmtSec(130), "2 分 10 秒");
		assert.equal(fmtSec(120), "2 分");
	});
});

// ── png-check ────────────────────────────────────────────────────────────
describe("png-check", () => {
	const noisy = (x: number, y: number): [number, number, number] => [
		(x * 13 + y * 7) % 256,
		(x * y) % 256,
		(x * 31 + y * 17) % 256,
	];
	it("正常圖通過（含 Up filter）", () => {
		assert.equal(checkPng(makePng(96, 96, noisy)).ok, true);
		assert.equal(checkPng(makePng(96, 96, noisy, 2)).ok, true);
	});
	it("全白、全黑、單色被擋下", () => {
		assert.match(String(checkPng(makePng(96, 96, () => [255, 255, 255])).reason), /全白/);
		assert.match(String(checkPng(makePng(96, 96, () => [0, 0, 0])).reason), /全黑/);
		assert.match(String(checkPng(makePng(96, 96, () => [90, 120, 200])).reason), /單一顏色/);
	});
	it("太小、不是 PNG", () => {
		assert.match(String(checkPng(Buffer.alloc(10)).reason), /太小/);
		assert.match(String(checkPng(Buffer.alloc(100)).reason), /不是 PNG/);
		assert.match(String(checkPng(Buffer.alloc(20000)).reason), /不是 PNG/);
	});
});

// ── sd-client ────────────────────────────────────────────────────────────
describe("sd-client parseJob", () => {
	it("寬鬆解析 images 與 error", () => {
		const j = parseJob("a", { status: "completed", result: { images: [{ index: 0, b64_json: "QUJD" }] } });
		assert.deepEqual(j.images, ["QUJD"]);
		assert.equal(parseJob("a", { status: "failed", error: { message: "boom" } }).error, "boom");
	});
});

describe("gpu waitVramFree", () => {
	it("等到 VRAM 夠才放行；拿不到 nvidia-smi 直接放行", async () => {
		const seq = [1000, 2000, 5000];
		const ops = { unloadOllama: async () => [], warmOllama() {}, vramFreeMb: async () => seq.shift() ?? 5000 };
		assert.deepEqual(await waitVramFree(ops, 4500, 5000, async () => {}), { ok: true, freeMb: 5000 });
		const none = { ...ops, vramFreeMb: async () => null };
		assert.equal((await waitVramFree(none, 4500, 10, async () => {})).ok, true);
		const never = { ...ops, vramFreeMb: async () => 100 };
		assert.equal((await waitVramFree(never, 4500, 30, async () => new Promise((r) => setTimeout(r, 10)))).ok, false);
	});
});

// ── supervisor + 真的子程序（假 sd-server） ─────────────────────────────────
let nextPort = 18700 + Math.floor(Math.random() * 500);

interface Harness {
	sup: ImageSupervisor;
	server: SdServerProcess;
	notes: { posts: string[]; updates: string[]; uploads: string[]; logs: string[]; failed: any[] };
	gpu: { unloads: number; warms: number };
	chatBusy: { v: boolean };
	c: ReturnType<typeof cfg>;
}

function harness(
	mode: string,
	over: Record<string, string> = {},
	opts: { chatWaitMs?: number; vramFreeMb?: () => Promise<number | null> } = {},
): Harness {
	process.env.FAKE_MODE = mode;
	const port = nextPort++;
	const c = cfg({ IMAGE_PORT: String(port), IMAGE_SD_SERVER_BIN: FAKE, IMAGE_KEEP_ALIVE: "60", ...over });
	const server = new SdServerProcess(FAKE, ["--listen-port", String(port)], c.pidPath, c.logPath);
	const notes = { posts: [] as string[], updates: [] as string[], uploads: [] as string[], logs: [] as string[], failed: [] as any[] };
	const gpu = { unloads: 0, warms: 0 };
	const chatBusy = { v: false };
	const sup = new ImageSupervisor({
		cfg: c,
		client: new SdClient(`http://127.0.0.1:${port}`),
		server,
		gpu: {
			unloadOllama: async () => {
				gpu.unloads++;
				return ["gemma4-32k"];
			},
			warmOllama: () => {
				gpu.warms++;
			},
			vramFreeMb: opts.vramFreeMb ?? (async () => null),
		},
		notifier: {
			post: async (_ch, t) => {
				notes.posts.push(t);
				return "ts1";
			},
			update: async (_ch, _ts, t) => {
				notes.updates.push(t);
			},
			upload: async (_ch, p) => {
				notes.uploads.push(p);
			},
			logBot: (_ch, t) => {
				notes.logs.push(t);
			},
			failed: (info) => {
				notes.failed.push(info);
			},
		},
		isChatBusy: () => chatBusy.v,
		chatWaitMs: opts.chatWaitMs,
		pollMs: 20,
		slackUpdateMs: 20,
	});
	return { sup, server, notes, gpu, chatBusy, c };
}

const origin = { channelId: "C1", channelName: "general", userId: "U1", userName: "kelvin", source: "command" as const };
const params = { prompt: "portrait", width: 512, height: 512, steps: 4, seed: 1, nsfw: false };

async function until(cond: () => boolean, ms = 10000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("until() 逾時");
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("supervisor（假 sd-server 子程序）", () => {
	it("成功：卸載 ollama → 啟動 → 進度 → 上傳 → 記錄 → 保留常駐（vram 模式）", async () => {
		const h = harness("ok", { IMAGE_RESIDENT_MODE: "vram" });
		const r = h.sup.submit(params, origin);
		assert.equal(r.accepted, true);
		assert.ok(h.sup.isBusy());
		// 產圖中別的頻道來訊息：要說是誰在哪觸發，而且不能 stop
		const busy = h.sup.busyReply("C2", "U2");
		assert.match(String(busy), /<@U1> 在 #general 觸發/);
		assert.match(String(busy), /無法對話|不收新訊息/);
		assert.doesNotMatch(String(busy), /stop/);
		assert.equal(h.sup.busyReply("C2", "U2"), null, "10 秒內不重複回覆");
		assert.match(String(h.sup.busyReply("C2", "U2", true)), /已跑|排隊中/, "等待 一定回");
		assert.match(String(h.sup.cancel("C2", "U2")), /只有觸發者/);
		await h.sup.lastRun;
		assert.equal(h.sup.isBusy(), false);
		assert.equal(h.gpu.unloads, 1);
		assert.equal(h.notes.uploads.length, 1);
		assert.ok(existsSync(h.notes.uploads[0]));
		assert.match(h.notes.updates.at(-1)!, /✅ 產圖完成/);
		assert.match(h.notes.logs[0], /已傳送產出的圖片/);
		assert.ok(h.notes.updates.some((u) => /▓/.test(u)), "有步數進度條");
		assert.ok(h.notes.updates.some((u) => /處理 prompt／載入模型權重/.test(u)), "有 conditioning 階段");
		const st = JSON.parse(readFileSync(h.c.statsPath, "utf-8"));
		assert.equal(st.vaeSecPerMP, DEFAULT_STATS.vaeSecPerMP, "新啟動的第一張不更新 VAE／每步秒數");
		assert.deepEqual(st.stepSecBySize, {});
		assert.ok(h.server.isRunning(), "keepAlive 內保留常駐");
		assert.ok(JSON.parse(readFileSync(h.c.statsPath, "utf-8")).samples >= 1, "寫入實測統計");

		// 第二張：不必重新載入（ETA 不含載入時間）
		const eta1 = r.accepted ? r.etaSec : 0;
		const r2 = h.sup.submit(params, origin);
		assert.ok(r2.accepted && r2.etaSec <= eta1);
		await h.sup.lastRun;
		assert.equal(h.notes.uploads.length, 2);
		const st2 = JSON.parse(readFileSync(h.c.statsPath, "utf-8"));
		assert.ok(st2.stepSecBySize["512x512"] > 0, "常駐時的第二張才記錄每步秒數");
		assert.notEqual(st2.vaeSecPerMP, DEFAULT_STATS.vaeSecPerMP);

		// vram 模式：有對話要用 GPU 時關掉 sd-server
		await h.sup.prepareForChat();
		assert.equal(h.server.isRunning(), false);
		assert.equal(existsSync(h.c.pidPath), false);
	});

	it("ram 模式（預設）：sd-server 只在連續產圖之間常駐；有對話時關掉，被拆到 CPU 的對話模型卸載重載", async () => {
		const h = harness("ok");
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.ok(h.server.isRunning(), "產完保持常駐，連續產圖不必重新載入");
		assert.equal(h.gpu.warms, 0, "sd-server 還佔著 VRAM 時不預熱（會被拆到 CPU）");
		assert.match(h.notes.updates.at(-1)!, /下一則訊息時重新載入/, "P-1：告訴使用者對話要等一下");
		// 模擬對話模型已經以 14% CPU 載入（2026-11-20 23:14 的情況）
		(h.sup as any).d.gpu.ollamaCpuShare = async () => 0.14;
		const before = h.gpu.unloads;
		await h.sup.prepareForChat();
		assert.equal(h.server.isRunning(), false, "有對話要用 GPU，關掉 sd-server");
		assert.equal(h.gpu.unloads, before + 1, "被拆到 CPU 的對話模型要卸載重載");
		// 只在產圖後檢查一次：之後就算模型本來就放不進 GPU，也不能每則訊息都卸載
		await h.sup.prepareForChat();
		assert.equal(h.gpu.unloads, before + 1);
		// 再產一張，這次對話模型完整在 GPU 上：不要多此一舉卸載
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		(h.sup as any).d.gpu.ollamaCpuShare = async () => 0;
		const before2 = h.gpu.unloads;
		await h.sup.prepareForChat();
		assert.equal(h.gpu.unloads, before2);
		await h.sup.shutdown();
	});

	it("NSFW LoRA 只在要求時送出；之後的一般請求不帶 LoRA", async () => {
		const h = harness("ok");
		const port = h.c.port;
		h.sup.submit({ ...params, nsfw: true }, origin);
		await h.sup.lastRun;
		let last = await (await fetch(`http://127.0.0.1:${port}/debug/last`)).json();
		assert.deepEqual(last.lora, [{ path: "nsfw/party_time_v2.1_klein4b.safetensors", multiplier: 1 }]);
		assert.match(h.notes.updates.at(-1)!, /NSFW LoRA/);
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		last = await (await fetch(`http://127.0.0.1:${port}/debug/last`)).json();
		assert.equal(last.lora, undefined);
		await h.sup.shutdown();
	});

	it("--lora 和 --nsfw 可以一起用：兩個都送，路徑相對於 flux2/", async () => {
		const h = harness("ok", { IMAGE_LORA_WEIGHT: "0.7" });
		const port = h.c.port;
		h.sup.submit({ ...params, lora: "asian.safetensors", nsfw: true }, origin);
		await h.sup.lastRun;
		const last = await (await fetch(`http://127.0.0.1:${port}/debug/last`)).json();
		assert.deepEqual(last.lora, [
			{ path: "loras/asian.safetensors", multiplier: 0.7 },
			{ path: "nsfw/party_time_v2.1_klein4b.safetensors", multiplier: 1 },
		]);
		assert.match(h.notes.updates.at(-1)!, /LoRA「asian」、NSFW LoRA/);
		// 沒有第 N 個：不送 lora，訊息裡說明
		h.sup.submit({ ...params, loraNote: "loras/ 只有 1 個 LoRA，沒有第 3 個，這張不套用 LoRA" }, origin);
		await h.sup.lastRun;
		const last2 = await (await fetch(`http://127.0.0.1:${port}/debug/last`)).json();
		assert.equal(last2.lora, undefined);
		assert.match(h.notes.updates.at(-1)!, /沒有第 3 個，這張不套用 LoRA/);
		await h.sup.shutdown();
	});

	it("等進行中的對話跑完才開始切換 GPU", async () => {
		const h = harness("ok");
		h.chatBusy.v = true;
		h.sup.submit(params, origin);
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(h.gpu.unloads, 0);
		assert.equal(h.sup.currentJob()?.phase, "pending");
		// 排隊中：拒收的回覆要說是在排隊，而且新訊息沒有交給助理
		const q = String(h.sup.busyReply("C2", "U2", true));
		assert.match(q, /產圖排隊中/);
		assert.match(q, /不收新訊息/);
		h.chatBusy.v = false;
		await h.sup.lastRun;
		assert.equal(h.gpu.unloads, 1);
		await h.sup.shutdown();
	});

	it("其他頻道的對話一直沒結束：逾時就失敗，不在對話中途卸載 ollama", async () => {
		const h = harness("ok", {}, { chatWaitMs: 200 });
		h.chatBusy.v = true;
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.equal(h.gpu.unloads, 0, "對話還在跑，不能卸載");
		assert.equal(h.notes.failed.length, 1);
		assert.match(h.notes.failed[0].reason, /排在產圖前面的對話還沒回完/);
		h.chatBusy.v = false;
		await h.sup.shutdown();
	});

	it("卸載後 VRAM 還不夠：再卸載一次，空出來就繼續產圖", async () => {
		// 第一輪 15 秒內一直只有 2681 MB（模擬 ollama 又把模型載回去），第二次卸載後才空出來
		let unloadsSeen = 0;
		const h = harness("ok", {}, { vramFreeMb: async () => (unloadsSeen >= 2 ? 5000 : 2681) });
		const realUnload = (h.sup as any).d.gpu.unloadOllama;
		(h.sup as any).d.gpu.unloadOllama = async () => {
			unloadsSeen++;
			return realUnload();
		};
		const t0 = Date.now();
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.equal(h.gpu.unloads, 2);
		assert.equal(h.notes.failed.length, 0);
		assert.equal(h.notes.uploads.length, 1);
		assert.ok(Date.now() - t0 >= 14_000, "第一輪有等滿 15 秒");
		await h.sup.shutdown();
	});

	it("取消：觸發者 stop → cancel API → 已取消，不通知 agent", async () => {
		const h = harness("cancelable", { STEP_MS: "60" });
		process.env.STEP_MS = "60";
		h.sup.submit(params, origin);
		await until(() => h.sup.currentJob()?.phase === "generating");
		assert.match(h.sup.cancel("C1", "U9"), /正在中斷/, "同頻道的人也能取消");
		await h.sup.lastRun;
		delete process.env.STEP_MS;
		assert.match(h.notes.updates.at(-1)!, /🛑 已取消產圖/);
		assert.ok(h.notes.updates.some((u) => /中斷中/.test(u)), "取消後進度訊息立刻顯示中斷中");
		assert.equal(h.notes.failed.length, 0);
		assert.equal(h.sup.isBusy(), false);
		await h.sup.shutdown();
	});

	it("OOM：失敗 → 關掉 sd-server → 交回 agent（附原因、已跑時間、log）", async () => {
		const h = harness("oom");
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.equal(h.notes.failed.length, 1);
		const f = h.notes.failed[0];
		assert.match(f.reason, /out of memory/);
		assert.equal(typeof f.elapsedSec, "number");
		assert.match(f.logTail, /CUDA error/);
		const ev = failureEventText(f);
		assert.match(ev, /^\[IMAGE_JOB_FAILED\]/);
		assert.match(ev, /已跑 \d+ 秒/);
		assert.match(h.notes.updates.at(-1)!, /❌ 產圖失敗/);
		assert.equal(h.server.isRunning(), false);
		assert.equal(h.sup.isBusy(), false);
	});

	it("sd-server 當掉：偵測到並交回 agent", async () => {
		const h = harness("crash");
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.match(h.notes.failed[0].reason, /意外結束/);
	});

	it("模型載入錯誤（models/status state=error）：立刻失敗，不等逾時", async () => {
		const h = harness("loaderr");
		const t = Date.now();
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.match(h.notes.failed[0].reason, /載入失敗：failed to load vae/);
		assert.ok(Date.now() - t < 3000);
	});

	it("全白圖：圖片檢查擋下，不上傳", async () => {
		const h = harness("white");
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.equal(h.notes.uploads.length, 0);
		assert.match(h.notes.failed[0].reason, /全白/);
	});

	it("卡住：逾時 → 強制收掉 → 交回 agent", async () => {
		const h = harness("hang", { IMAGE_MIN_TIMEOUT_SEC: "1", IMAGE_TIMEOUT_FACTOR: "0" });
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.match(h.notes.failed[0].reason, /逾時/);
		assert.equal(h.server.isRunning(), false);
	});

	it("卡住時取消：cancel 沒反應，10 秒後強制 kill（這裡只驗證不會永遠卡住）", { timeout: 20000 }, async () => {
		const h = harness("hang");
		h.sup.submit(params, origin);
		await until(() => h.sup.currentJob()?.completedSteps === 1);
		h.sup.cancel("C1", "U1");
		await h.sup.lastRun;
		assert.match(h.notes.updates.at(-1)!, /🛑 已取消產圖/);
		assert.equal(h.server.isRunning(), false);
	});

	it("找不到 sd-server binary：失敗並交回 agent", async () => {
		const h = harness("ok");
		const c = cfg({ IMAGE_SD_SERVER_BIN: "/nope/sd-server" });
		const bad = new SdServerProcess("/nope/sd-server", [], c.pidPath, c.logPath);
		const sup = new ImageSupervisor({ ...(h.sup as any).d, server: bad, cfg: c });
		sup.submit(params, origin);
		await sup.lastRun;
		assert.match(h.notes.failed[0].reason, /找不到 sd-server/);
	});

	it("忙碌時再 submit 會被拒絕", async () => {
		const h = harness("ok");
		h.sup.submit(params, origin);
		const r = h.sup.submit(params, { ...origin, userId: "U2" });
		assert.equal(r.accepted, false);
		await h.sup.lastRun;
		await h.sup.shutdown();
	});

	it("mom 結束：shutdownSync 帶走 sd-server；啟動時清掉殘留 pid", async () => {
		const h = harness("ok");
		h.sup.submit(params, origin);
		await h.sup.lastRun;
		assert.ok(h.server.isRunning());
		const pid = Number(readFileSync(h.c.pidPath, "utf-8"));
		h.sup.shutdownSync();
		await new Promise((r) => setTimeout(r, 200));
		assert.throws(() => process.kill(pid, 0));
		assert.equal(cleanupStaleServer(h.c.pidPath), null);
	});
});
