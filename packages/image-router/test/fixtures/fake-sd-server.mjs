#!/usr/bin/env node
// 假的 sd-server：模擬 stable-diffusion.cpp 原生非同步 API，給 image.test.ts 用。
// 行為由環境變數 FAKE_MODE 決定：
//   ok     正常：每 STEP_MS 前進一步，跑完回傳一張漸層 PNG
//   white  正常跑完，但回傳全白圖（測壞圖偵測）
//   oom    跑到第 2 步時 job 變成 failed，並在 stderr 印出 CUDA OOM
//   crash  跑到第 2 步時整個程序 exit(139)
//   hang   永遠停在第 1 步（測逾時與取消）；cancel 不理會（測強制 kill）
//   cancelable  每步很慢，但會尊重 cancel API
// 參數照抄真的 sd-server：--listen-port <port>
import http from "node:http";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--listen-port") + 1] || 7861);
const mode = process.env.FAKE_MODE || "ok";
const STEP_MS = Number(process.env.STEP_MS || 40);
const LOAD_MS = Number(process.env.LOAD_MS || 100);
const startedAt = Date.now();

function crc32(buf) {
	let c;
	const table = [];
	for (let n = 0; n < 256; n++) {
		c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	let crc = 0xffffffff;
	for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}

function png(w, h, white) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++) {
			const o = y * (w * 3 + 1) + 1 + x * 3;
			// 加一點雜訊讓壓縮後的檔案大於 10KB
			const n = (x * 7919 + y * 104729) % 37;
			raw[o] = white ? 255 : (x * 255) / w + n;
			raw[o + 1] = white ? 255 : (y * 255) / h;
			raw[o + 2] = white ? 255 : 128 + n;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const jobs = new Map();
let lastBody = null;
let seq = 0;

function tick(job) {
	if (job.status !== "generating") return;
	if (!job.sampling) {
		// 第一個 tick：結束 conditioning，進入 sampling
		job.sampling = true;
		setTimeout(() => tick(job), STEP_MS);
		return;
	}
	if (job.cancel && mode !== "hang") {
		job.status = "cancelled";
		return;
	}
	if (mode === "hang" && job.completed >= 1) return;
	job.completed++;
	if (job.completed === 2 && mode === "oom") {
		process.stderr.write("ggml_cuda_host_malloc: CUDA error: out of memory\n");
		job.status = "failed";
		job.error = "CUDA error: out of memory";
		return;
	}
	if (job.completed === 2 && mode === "crash") {
		process.stderr.write("Segmentation fault\n");
		process.exit(139);
	}
	process.stdout.write(`\r  |${"=".repeat(job.completed)}>| ${job.completed}/${job.steps} - 0.04s/it`);
	if (job.completed >= job.steps && !job.decoding) {
		job.decoding = true;
		setTimeout(() => tick(job), STEP_MS);
		return;
	}
	if (job.decoding) {
		job.status = "completed";
		job.images = [png(Math.min(job.w, 160), Math.min(job.h, 160), mode === "white").toString("base64")];
		return;
	}
	setTimeout(() => tick(job), mode === "cancelable" ? STEP_MS * 5 : STEP_MS);
}

const server = http.createServer((req, res) => {
	const send = (code, body) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	let data = "";
	req.on("data", (c) => (data += c));
	req.on("end", () => {
		const loaded = Date.now() - startedAt >= LOAD_MS;
		if (req.method === "GET" && req.url === "/sdcpp/v1/models/status") {
			if (mode === "loaderr") return send(200, { state: "error", error: "failed to load vae: unknown tensor layout" });
			return send(200, { state: loaded ? "ready" : "loading", origin: "command_line", recipe: null });
		}
		if (req.method === "GET" && req.url === "/debug/last") return send(200, lastBody ?? {});
		if (req.method === "GET" && req.url === "/v1/models") {
			return send(200, { data: loaded ? [{ id: "cli" }] : [] });
		}
		if (req.method === "POST" && req.url === "/sdcpp/v1/img_gen") {
			const b = JSON.parse(data || "{}");
			lastBody = b;
			const id = `job-${++seq}`;
			const job = {
				id,
				status: "generating",
				completed: 0,
				steps: b.sample_params?.sample_steps ?? 4,
				w: b.width,
				h: b.height,
			};
			jobs.set(id, job);
			setTimeout(() => tick(job), STEP_MS);
			return send(202, { id, status: "queued" });
		}
		const m = req.url.match(/^\/sdcpp\/v1\/jobs\/([^/]+)(\/cancel)?$/);
		if (m) {
			const job = jobs.get(m[1]);
			if (!job) return send(404, { error: "not found" });
			if (m[2]) {
				job.cancel = true;
				return send(200, { id: job.id, status: job.status, cancel_requested: true });
			}
			// 照實測（sd.cpp 532d2c1）的 stage 順序：conditioning → sampling → vae_decode → encoding
			let progress;
			if (job.status === "completed") progress = { stage: "encoding", completed: 1, total: 1, unit: "images" };
			else if (job.completed === 0 && !job.sampling) progress = { stage: "conditioning", completed: null, total: null, unit: null };
			else if (job.completed >= job.steps) progress = { stage: "vae_decode", completed: null, total: null, unit: null };
			else progress = { stage: "sampling", completed: job.completed, total: job.steps, unit: "steps" };
			return send(200, {
				id: job.id,
				status: job.status,
				error: job.error ? { code: "generation_failed", message: job.error } : null,
				progress,
				result: job.images ? { output_format: "png", images: job.images.map((b64, index) => ({ index, b64_json: b64 })) } : undefined,
			});
		}
		send(404, { error: "no route" });
	});
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`fake sd-server listening on ${port} mode=${mode}\n`));
process.on("SIGTERM", () => process.exit(0));
