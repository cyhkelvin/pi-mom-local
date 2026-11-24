import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { type ImageConfig, loraRequestPath } from "./config.js";
import type { ImageParams } from "./commands.js";
import {
	type EtaStats,
	estimateRemaining,
	estimateTotal,
	fmtSec,
	loadStats,
	type Measured,
	saveStats,
	stepSec,
	timeoutSec,
	updateStats,
} from "./eta.js";
import { type GpuOps, waitVramFree } from "./gpu.js";
import { checkPng } from "./png-check.js";
import type { SdClient } from "./sd-client.js";
import type { ServerProcess } from "./server-process.js";

/**
 * 產圖監控器（model router 的核心）。跑在 mom 的 node 程序裡，常駐、不佔 GPU。
 *
 * 職責：
 * 1. 全域 GPU 鎖：同一時間只有一個產圖 job；job 進行中所有頻道都不能聊天。
 * 2. 切換：等進行中的對話跑完 → 卸載 ollama → 等 VRAM → 啟動或沿用 sd-server。
 * 3. 監控：輪詢 sd-server 的 job 進度，更新 Slack 進度訊息、即時修正 ETA。
 * 4. 中斷：stop／取消 → 呼叫 cancel API；10 秒內沒停就 kill sd-server。
 * 5. 收尾：成功 → 檢查圖片、上傳；失敗 → 通知 agent 接手說明（附原因和已跑時間）。
 * 6. 常駐：產完先保留 sd-server，連續產圖不必重新載入；閒置 keepAlive 後關掉。
 *    vram 模式下，有人要聊天時先關掉 sd-server，讓出 VRAM 給 ollama。
 */

export type Phase = "pending" | "switching" | "loading" | "conditioning" | "generating" | "decoding" | "finishing";

const PHASE_LABEL: Record<Phase, string> = {
	pending: "等待進行中的對話結束",
	switching: "切換 GPU（卸載對話模型）",
	loading: "啟動產圖程式",
	// sd-server 是延遲載入：第一張圖的權重是在這個階段才真正讀進來
	conditioning: "處理 prompt／載入模型權重",
	generating: "產圖中",
	decoding: "解碼圖片",
	finishing: "上傳圖片",
};

export interface JobOrigin {
	channelId: string;
	channelName?: string;
	userId: string;
	userName?: string;
	source: "tool" | "command";
}

export interface ImageJob extends JobOrigin, ImageParams {
	id: string;
	createdAt: number;
	phase: Phase;
	etaTotalSec: number;
	completedSteps: number;
	samplingStartAt?: number;
	/** 最近一次步數增加的時間。算「每步秒數」要用它，不能用現在時間（卡住時會越算越大）。 */
	lastStepAt?: number;
	vaeStartAt?: number;
	cancelRequested: boolean;
	cancelledBy?: string;
	statusTs?: string;
	sdJobId?: string;
}

export interface FailureInfo {
	job: ImageJob;
	reason: string;
	elapsedSec: number;
	etaTotalSec: number;
	logTail: string;
}

export interface ImageNotifier {
	post(channel: string, text: string): Promise<string>;
	update(channel: string, ts: string, text: string): Promise<void>;
	upload(channel: string, path: string, title: string): Promise<void>;
	logBot(channel: string, text: string, ts: string): void;
	/** 失敗時讓 agent 接手。實作通常是排一個 [IMAGE_JOB_FAILED] 事件給該頻道。 */
	failed(info: FailureInfo): void;
}

export interface SupervisorDeps {
	cfg: ImageConfig;
	client: SdClient;
	server: ServerProcess;
	gpu: GpuOps;
	notifier: ImageNotifier;
	/** 有沒有任何頻道的 agent 正在跑（正在用 ollama）。 */
	isChatBusy: () => boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollMs?: number;
	/** 產圖開始前最多等已收下的對話回完多久，預設 15 分鐘（排隊後就拒收新訊息，正常不會等這麼久）。 */
	chatWaitMs?: number;
	slackUpdateMs?: number;
	log?: (msg: string) => void;
}

export type SubmitResult =
	| { accepted: true; job: ImageJob; etaSec: number; message: string }
	| { accepted: false; message: string };

class Cancelled extends Error {}
class Failed extends Error {}

const BUSY_REPLY_THROTTLE_MS = 10_000;

/** ETA 只分「有沒有套 LoRA」。 */
function usesLora(p: { nsfw: boolean; lora?: string }): boolean {
	return p.nsfw || !!p.lora;
}

function loraName(file: string): string {
	return (file.split("/").pop() ?? file).replace(/\.(safetensors|sft|gguf|ckpt)$/i, "");
}

/** 送給 sd-server 的 lora 欄位；路徑相對於 --lora-model-dir（loraRoot）。 */
function loraList(job: { nsfw: boolean; lora?: string }, cfg: ImageConfig): Array<{ path: string; multiplier: number }> | undefined {
	const out: Array<{ path: string; multiplier: number }> = [];
	if (job.lora) out.push({ path: loraRequestPath(cfg, "lora", job.lora), multiplier: cfg.loraWeight });
	if (job.nsfw && cfg.nsfwLora) out.push({ path: loraRequestPath(cfg, "nsfw"), multiplier: cfg.nsfwLoraWeight });
	return out.length ? out : undefined;
}

export class ImageSupervisor {
	private current: ImageJob | null = null;
	private stats: EtaStats;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private lastBusyReply = new Map<string, number>();
	private idleWaiters: Array<() => void> = [];
	private seq = 0;
	/** 產圖結束後，下一次對話前要檢查對話模型有沒有被 sd-server 擠到 CPU。 */
	private splitCheckPending = false;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly pollMs: number;
	private readonly chatWaitMs: number;
	private readonly slackUpdateMs: number;
	private readonly log: (msg: string) => void;
	/** 讓測試可以等 job 跑完。 */
	lastRun: Promise<void> = Promise.resolve();

	constructor(private d: SupervisorDeps) {
		this.stats = loadStats(d.cfg.statsPath);
		this.now = d.now ?? Date.now;
		this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.pollMs = d.pollMs ?? 1000;
		this.chatWaitMs = d.chatWaitMs ?? 900_000;
		this.slackUpdateMs = d.slackUpdateMs ?? 3000;
		this.log = d.log ?? (() => {});
	}

	// ── 狀態查詢 ───────────────────────────────────────────────────────────

	isBusy(): boolean {
		return this.current !== null;
	}

	currentJob(): ImageJob | null {
		return this.current;
	}

	getStats(): EtaStats {
		return { ...this.stats };
	}

	elapsedSec(job: ImageJob): number {
		return Math.round((this.now() - job.createdAt) / 1000);
	}

	remainingSec(job: ImageJob): number {
		const elapsed = this.elapsedSec(job);
		if (job.phase === "decoding" && job.vaeStartAt !== undefined) {
			const vae = this.stats.vaeSecPerMP * ((job.width * job.height) / 1_000_000);
			return Math.max(1, Math.round(vae - (this.now() - job.vaeStartAt) / 1000));
		}
		const live =
			job.samplingStartAt !== undefined
				? {
						completedSteps: job.completedSteps,
						totalSteps: job.steps,
						stepsElapsedSec: ((job.lastStepAt ?? job.samplingStartAt) - job.samplingStartAt) / 1000,
						currentStepSec: (this.now() - (job.lastStepAt ?? job.samplingStartAt)) / 1000,
					}
				: null;
		return estimateRemaining(this.stats, job.width, job.height, live, job.etaTotalSec - elapsed, usesLora(job), !!job.ref);
	}

	/** 產圖結束後，對話模型什麼時候可以用（P-1：ollama 冷啟動約 30 秒，要讓使用者知道）。 */
	private chatResumeHint(): string {
		return this.d.server.isRunning()
			? "對話模型會在下一則訊息時重新載入（第一則回覆會多等約 30 秒）。"
			: "對話模型重新載入中，約 30 秒後恢復正常回覆速度。";
	}

	private who(job: JobOrigin): string {
		const user = `<@${job.userId}>`;
		const ch = job.channelName ? `#${job.channelName}` : `<#${job.channelId}>`;
		return `由 ${user} 在 ${ch} 觸發`;
	}

	private bar(job: ImageJob): string {
		const n = Math.max(1, job.steps);
		const done = Math.min(n, job.completedSteps);
		return `${"▓".repeat(done)}${"░".repeat(n - done)} ${done}/${n} 步`;
	}

	/** 參數摘要：尺寸、seed、LoRA、修改的是哪張圖。 */
	private summary(job: ImageJob, withSteps = false): string {
		return `${job.ref ? `修改「${job.ref.label}」、` : ""}${job.width}×${job.height}${withSteps ? `、${job.steps} 步` : ""}、seed ${job.seed}${job.lora ? `、LoRA「${loraName(job.lora)}」` : ""}${job.loraNote ? `（${job.loraNote}）` : ""}${job.nsfw ? "、NSFW LoRA" : ""}`;
	}

	progressText(job: ImageJob): string {
		const label = job.cancelRequested ? "🛑 中斷中（要等目前這一步跑完才會停）" : `🎨 ${PHASE_LABEL[job.phase]}`;
		const parts = [label];
		if (job.phase === "generating" || job.phase === "decoding") parts.push(this.bar(job));
		parts.push(`已跑 ${fmtSec(this.elapsedSec(job))}`);
		if (!job.cancelRequested) parts.push(`剩約 ${fmtSec(this.remainingSec(job))}`);
		return `${parts.join(" ・ ")}\n${this.summary(job)}（${this.who(job)}）\n回 \`stop\` 或 \`取消\` 可以中斷。`;
	}

	/**
	 * 產圖期間收到任何訊息時的回覆。
	 * 同一個使用者 10 秒內只回一次（explicit=true 的「等待」除外），避免洗版。
	 */
	busyReply(channelId: string, userId: string, explicit = false): string | null {
		const job = this.current;
		if (!job) return null;
		const key = `${channelId}:${userId}`;
		const last = this.lastBusyReply.get(key) ?? 0;
		if (!explicit && this.now() - last < BUSY_REPLY_THROTTLE_MS) return null;
		this.lastBusyReply.set(key, this.now());
		const canStop = userId === job.userId || channelId === job.channelId;
		const step =
			job.phase === "generating" || job.phase === "decoding" ? `${job.completedSteps}/${job.steps} 步，` : "";
		const lines =
			job.phase === "pending"
				? [
						`⏳ 產圖排隊中（${this.who(job)}）：等之前已收到的訊息回完就開始，預估再 ${fmtSec(this.remainingSec(job))} 後完成。`,
						"排隊和產圖期間不收新訊息，這則沒有交給助理，產完之後請再傳一次。",
					]
				: [
						`⏳ 正在產圖（${this.who(job)}），${step}已跑 ${fmtSec(this.elapsedSec(job))}，剩約 ${fmtSec(this.remainingSec(job))}。`,
						"這段期間對話模型已讓出 GPU，暫時無法對話。這則沒有交給助理，產完之後請再傳一次。",
					];
		lines.push(
			canStop
				? "回 `stop` 或 `取消` 可以中斷產圖，或回 `等待` 查看進度。"
				: "產圖完成後就能繼續對話；回 `等待` 可以查看進度。",
		);
		return lines.join("\n");
	}

	// ── 對外操作 ───────────────────────────────────────────────────────────

	estimate(p: ImageParams): number {
		return estimateTotal(this.stats, {
			width: p.width,
			height: p.height,
			steps: p.steps,
			needLoad: !this.d.server.isRunning(),
			needSwitch: true,
			lora: usesLora(p),
			ref: !!p.ref,
		});
	}

	submit(p: ImageParams, origin: JobOrigin): SubmitResult {
		if (this.current) {
			const r = this.busyReply(origin.channelId, origin.userId, true);
			return { accepted: false, message: r ?? "已經有一張圖在產了，請等它完成。" };
		}
		this.clearIdleTimer();
		const etaSec = this.estimate(p);
		const job: ImageJob = {
			...p,
			...origin,
			id: `img-${this.now()}-${++this.seq}`,
			createdAt: this.now(),
			phase: "pending",
			etaTotalSec: etaSec,
			completedSteps: 0,
			cancelRequested: false,
		};
		this.current = job;
		this.lastRun = this.run(job);
		return {
			accepted: true,
			job,
			etaSec,
			message: `已開始${p.ref ? "修改圖片" : "產圖"}（${this.summary(job, true)}），預估約 ${fmtSec(etaSec)}。完成後會直接傳到這個頻道；這段期間無法對話，回 \`stop\` 或 \`取消\` 可以中斷。`,
		};
	}

	/** 使用者要求中斷。回傳給使用者看的訊息。 */
	cancel(channelId: string, userId: string): string {
		const job = this.current;
		if (!job) return "目前沒有在產圖。";
		if (userId !== job.userId && channelId !== job.channelId) {
			return `只有觸發者或觸發的頻道可以中斷這次產圖（${this.who(job)}）。`;
		}
		job.cancelRequested = true;
		job.cancelledBy = userId;
		void this.pushStatus(job);
		return `🛑 正在中斷產圖（已跑 ${fmtSec(this.elapsedSec(job))}）……`;
	}

	/** 等目前的 job 結束。給排程事件用：它們要用 ollama，不能和產圖搶 GPU。 */
	waitIdle(): Promise<void> {
		if (!this.current) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	/**
	 * agent 要開始跑之前呼叫。vram 模式下 sd-server 佔著 VRAM，要先關掉，
	 * 否則 ollama 只能退到 CPU 跑，對話會慢上好幾倍。
	 */
	async prepareForChat(): Promise<void> {
		if (this.current) await this.waitIdle();
		// 兩種模式都要關：ram 模式的 sd-server 閒置時也佔約 0.6GB VRAM，qwen3.5-32k（約 4.3GB）
		// 加上 ollama 自己保留的餘量就放不下，會被拆 14% 到 CPU，回覆從十幾秒變成好幾分鐘
		// （2026-11-20 23:14 實測）。sd-server 只在連續產圖之間常駐。
		if (this.d.server.isRunning()) {
			this.log("有對話要用 GPU，關掉常駐的 sd-server");
			this.clearIdleTimer();
			await this.d.server.stop();
		}
		// 對話模型如果已經在 sd-server 還佔著 VRAM 時載入（被拆到 CPU），卸載讓它重新完整載入 GPU
		// 只在產圖之後檢查一次：本來就放不進 GPU 的模型（例如換成更大的模型）不能每則訊息都卸載重載
		if (!this.splitCheckPending) return;
		this.splitCheckPending = false;
		const cpu = await this.d.gpu.ollamaCpuShare?.();
		if (cpu !== null && cpu !== undefined && cpu > 0.02) {
			this.log(`對話模型有 ${Math.round(cpu * 100)}% 跑在 CPU，卸載後重新完整載入 GPU`);
			await this.d.gpu.unloadOllama();
		}
	}

	/** mom 結束時呼叫。 */
	async shutdown(): Promise<void> {
		this.clearIdleTimer();
		if (this.current) this.current.cancelRequested = true;
		await this.d.server.stop();
	}

	shutdownSync(): void {
		this.clearIdleTimer();
		this.d.server.killSync();
	}

	// ── 內部 ───────────────────────────────────────────────────────────────

	private clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private scheduleIdleStop(): void {
		this.clearIdleTimer();
		if (!this.d.server.isRunning()) return;
		if (this.d.cfg.keepAliveSec <= 0) {
			void this.d.server.stop();
			return;
		}
		this.idleTimer = setTimeout(() => {
			if (!this.current) {
				this.log(`sd-server 閒置超過 ${this.d.cfg.keepAliveSec} 秒，關閉`);
				void this.d.server.stop();
			}
		}, this.d.cfg.keepAliveSec * 1000);
		this.idleTimer.unref?.();
	}

	/** 取消後最多等多久才強制 kill：至少 10 秒，或 1.5 步 + 5 秒（一步很慢時）。 */
	private cancelGraceMs(job: ImageJob): number {
		let perStep = stepSec(this.stats, job.width, job.height, usesLora(job), !!job.ref);
		if (job.samplingStartAt !== undefined && job.lastStepAt !== undefined && job.completedSteps > 0) {
			perStep = (job.lastStepAt - job.samplingStartAt) / 1000 / job.completedSteps;
		}
		return Math.max(10_000, (perStep * 1.5 + 5) * 1000);
	}

	private checkCancel(job: ImageJob): void {
		if (job.cancelRequested) throw new Cancelled();
	}

	private async setPhase(job: ImageJob, phase: Phase): Promise<void> {
		job.phase = phase;
		await this.pushStatus(job);
	}

	private async pushStatus(job: ImageJob, text?: string): Promise<void> {
		const t = text ?? this.progressText(job);
		try {
			if (job.statusTs) await this.d.notifier.update(job.channelId, job.statusTs, t);
			else job.statusTs = await this.d.notifier.post(job.channelId, t);
		} catch (err) {
			this.log(`Slack 進度訊息更新失敗：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 等所有頻道的對話結束（最多 chatWaitMs）。逾時就失敗，不在對話進行中搶 GPU。 */
	private async waitChatIdle(job: ImageJob): Promise<void> {
		const deadline = this.now() + this.chatWaitMs;
		while (this.d.isChatBusy()) {
			this.checkCancel(job);
			if (this.now() >= deadline) {
				throw new Failed(
					`等了 ${Math.round(this.chatWaitMs / 1000)} 秒，排在產圖前面的對話還沒回完，為了不中斷它沒有開始產圖。等對話結束後再請我產一次，或用 \`!img\`。`,
				);
			}
			await this.sleep(500);
		}
		this.checkCancel(job);
	}

	private async run(job: ImageJob): Promise<void> {
		const m: Measured = { width: job.width, height: job.height, steps: job.steps, lora: usesLora(job), ref: !!job.ref };
		try {
			await this.pushStatus(job);

			// 1. 等其他頻道進行中的對話跑完（它們正在用 ollama）。
			//    等不到就失敗，不能硬卸載：對話還在送請求，ollama 會把模型留在 VRAM（或重新載入），
			//    結果只會是「VRAM 不足」，而且那段對話也被拖慢。2026-11-20 19:07 就是這樣失敗的。
			await this.waitChatIdle(job);

			// 2. 切換 GPU
			await this.setPhase(job, "switching");
			let t = this.now();
			const unloaded = await this.d.gpu.unloadOllama();
			if (unloaded.length) this.log(`已卸載 ollama 模型：${unloaded.join(", ")}`);
			if (!this.d.server.isRunning()) {
				let v = await waitVramFree(this.d.gpu, this.d.cfg.vramNeedMb, 15_000, this.sleep);
				if (!v.ok) {
					// 卸載和某個剛結束的對話請求擦身而過時，ollama 可能又把模型載回去：再等一次對話、再卸載一次
					this.log(`VRAM 只剩 ${v.freeMb} MB，重試卸載一次`);
					await this.waitChatIdle(job);
					const again = await this.d.gpu.unloadOllama();
					if (again.length) this.log(`再次卸載 ollama 模型：${again.join(", ")}`);
					v = await waitVramFree(this.d.gpu, this.d.cfg.vramNeedMb, 20_000, this.sleep);
				}
				if (!v.ok) {
					throw new Failed(
						`VRAM 不足：只剩 ${v.freeMb} MB，需要 ${this.d.cfg.vramNeedMb} MB。已經卸載對話模型兩次仍然不夠，可能有其他程式（例如另一個 ollama 模型或遊戲）佔著顯示卡。`,
					);
				}
			}
			m.switchSec = (this.now() - t) / 1000;
			this.checkCancel(job);

			// 3. 啟動或沿用 sd-server
			const freshServer = !this.d.server.isRunning();
			let loadStartAt = 0;
			if (freshServer) {
				await this.setPhase(job, "loading");
				t = this.now();
				loadStartAt = t;
				await this.d.server.start();
				const loadDeadline = this.now() + this.d.cfg.loadTimeoutSec * 1000;
				for (;;) {
					const ms = await this.d.client.modelState();
					if (ms.state === "ready") break;
					if (ms.state === "error") throw new Failed(`產圖模型載入失敗：${ms.error}`);
					const why = this.d.server.exitReason();
					if (why) throw new Failed(`產圖模型載入失敗：sd-server ${why}`);
					if (this.now() > loadDeadline) {
						throw new Failed(`產圖模型載入逾時（超過 ${this.d.cfg.loadTimeoutSec} 秒）`);
					}
					this.checkCancel(job);
					await this.sleep(this.pollMs);
				}
			}
			this.checkCancel(job);

			// 4. 產圖
			await this.setPhase(job, "conditioning");
			const submitAt = this.now();
			job.sdJobId = await this.d.client.submit({
				prompt: job.prompt,
				width: job.width,
				height: job.height,
				steps: job.steps,
				seed: job.seed,
				lora: loraList(job, this.d.cfg),
				// 參考圖先縮放到輸出尺寸：手機的 12MP 原圖直接送進 VAE 會撐爆記憶體。
				// 比例不同（自訂 --size）時裁切，不拉伸變形
				refImages: job.ref ? [job.ref.b64] : undefined,
				imagePreprocess: job.ref ? `target=ref,mode=crop-resize,width=${job.width},height=${job.height}` : undefined,
			});
			const deadline =
				this.now() + timeoutSec(job.etaTotalSec, this.d.cfg.timeoutFactor, this.d.cfg.minTimeoutSec) * 1000;
			let lastPush = this.now();
			let cancelSentAt: number | null = null;
			let fetchErrors = 0;
			let images: string[] = [];
			for (;;) {
				await this.sleep(this.pollMs);
				const why = this.d.server.exitReason();
				if (why && !this.d.server.isRunning()) {
					if (cancelSentAt !== null) throw new Cancelled();
					throw new Failed(`sd-server 在產圖途中意外結束（${why}）`);
				}
				if (job.cancelRequested && cancelSentAt === null) {
					cancelSentAt = this.now();
					await this.d.client.cancel(job.sdJobId);
				}
				if (cancelSentAt !== null && this.now() - cancelSentAt > this.cancelGraceMs(job)) {
					// 取消要等到下一個 checkpoint（實測：下一步結束時）才生效；等太久就直接收掉 sd-server
					await this.d.server.stop();
					throw new Cancelled();
				}
				if (this.now() > deadline) {
					await this.d.client.cancel(job.sdJobId);
					await this.d.server.stop();
					throw new Failed(`產圖逾時（超過 ${fmtSec((deadline - job.createdAt) / 1000)}，原本預估 ${fmtSec(job.etaTotalSec)}）`);
				}

				let s: Awaited<ReturnType<SdClient["job"]>>;
				try {
					s = await this.d.client.job(job.sdJobId);
					fetchErrors = 0;
				} catch (err) {
					// 連不上：多半是 sd-server 剛好在這一刻掛掉，讓下一輪的 exitReason 檢查判斷；
					// 程序還活著卻連續連不上，就當成失敗
					await this.sleep(200);
					const why2 = this.d.server.exitReason();
					if (why2 && !this.d.server.isRunning()) {
						if (cancelSentAt !== null) throw new Cancelled();
						throw new Failed(`sd-server 在產圖途中意外結束（${why2}）`);
					}
					if (++fetchErrors >= 5) {
						throw new Failed(`連不上 sd-server：${err instanceof Error ? err.message : String(err)}`);
					}
					continue;
				}
				// 實測（sd.cpp 532d2c1）的 stage 順序：conditioning → sampling（unit=steps）
				// → vae_decode（completed=null）→ encoding（unit=images）
				const p = s.progress;
				if (p?.stage === "sampling") {
					if (job.samplingStartAt === undefined) {
						job.samplingStartAt = this.now();
						job.phase = "generating";
					}
					if (typeof p.completed === "number" && p.completed > job.completedSteps) {
						job.completedSteps = p.completed;
						job.lastStepAt = this.now();
					}
					if (typeof p.total === "number" && p.total > 0 && p.total !== job.steps) job.steps = p.total;
				} else if (p && (p.stage === "vae_decode" || p.stage === "encoding") && job.vaeStartAt === undefined) {
					job.vaeStartAt = this.now();
					job.samplingStartAt ??= job.vaeStartAt;
					job.completedSteps = job.steps;
					job.phase = "decoding";
				}
				if (s.status === "completed") {
					images = s.images ?? [];
					break;
				}
				if (s.status === "cancelled") throw new Cancelled();
				if (s.status === "failed") throw new Failed(s.error || "sd-server 回報產圖失敗（沒有附上原因）");

				if (this.now() - lastPush >= this.slackUpdateMs) {
					lastPush = this.now();
					await this.pushStatus(job);
				}
			}
			const end = this.now();
			if (job.samplingStartAt !== undefined) {
				// 抽樣之前的時間：新啟動的 sd-server 算「載入」（延遲載入權重 + 編碼 prompt），
				// 已常駐的算「編碼 prompt」
				m.fresh = freshServer;
				if (freshServer) m.loadSec = (job.samplingStartAt - loadStartAt) / 1000;
				else m.condSec = (job.samplingStartAt - submitAt) / 1000;
				m.samplingSec = ((job.vaeStartAt ?? end) - job.samplingStartAt) / 1000;
				if (job.vaeStartAt !== undefined) m.vaeSec = (end - job.vaeStartAt) / 1000;
			}

			// 5. 檢查並上傳
			if (images.length === 0) throw new Failed("sd-server 回報完成，但沒有回傳任何圖片");
			const buf = Buffer.from(images[0], "base64");
			const verdict = checkPng(buf);
			if (!verdict.ok) throw new Failed(`圖片檢查沒通過：${verdict.reason}`);
			await this.setPhase(job, "finishing");
			mkdirSync(this.d.cfg.outputDir, { recursive: true });
			const file = join(this.d.cfg.outputDir, `${job.id}.png`);
			writeFileSync(file, buf);
			await this.d.notifier.upload(job.channelId, file, `${job.id}.png`);

			const took = this.elapsedSec(job);
			const doneText = `✅ ${job.ref ? "修改完成" : "產圖完成"}，耗時 ${fmtSec(took)}（預估 ${fmtSec(job.etaTotalSec)}）\n${this.summary(job, true)}（${this.who(job)}）\n${this.chatResumeHint()}`;
			await this.pushStatus(job, doneText);
			if (job.statusTs) {
				this.d.notifier.logBot(
					job.channelId,
					job.ref
						? `[已傳送修改後的圖片 ${job.id}.png（workspace 路徑 images/${job.id}.png），原圖「${job.ref.label}」，修改說明：${job.prompt}，${job.width}×${job.height}，seed ${job.seed}，耗時 ${took} 秒]`
						: `[已傳送產出的圖片 ${job.id}.png（workspace 路徑 images/${job.id}.png），prompt：${job.prompt}，${job.width}×${job.height}，seed ${job.seed}，耗時 ${took} 秒]`,
					job.statusTs,
				);
			}
			this.stats = updateStats(this.stats, m);
			try {
				saveStats(this.d.cfg.statsPath, this.stats);
			} catch (err) {
				this.log(`無法寫入 image-stats.json：${err instanceof Error ? err.message : String(err)}`);
			}
		} catch (err) {
			const elapsed = this.elapsedSec(job);
			if (err instanceof Cancelled) {
				await this.pushStatus(
					job,
					`🛑 已取消產圖（已跑 ${fmtSec(elapsed)}，取消者 <@${job.cancelledBy ?? job.userId}>）。${this.chatResumeHint()}`,
				);
			} else {
				const reason = err instanceof Error ? err.message : String(err);
				const logTail = this.d.server.tail(20);
				this.log(`產圖失敗：${reason}`);
				await this.pushStatus(
					job,
					`❌ 產圖失敗（已跑 ${fmtSec(elapsed)}，原本預估 ${fmtSec(job.etaTotalSec)}）：${reason}\n交回給助理說明。`,
				);
				// 失敗後的 sd-server 狀態不可信（可能半載入、可能 CUDA context 壞掉），直接收掉
				await this.d.server.stop();
				// 先釋放鎖，再通知 agent；否則 agent 的事件會卡在 waitIdle
				this.finish();
				this.d.notifier.failed({ job, reason, elapsedSec: elapsed, etaTotalSec: job.etaTotalSec, logTail });
				return;
			}
		}
		this.finish();
	}

	private finish(): void {
		if (!this.current) return;
		this.current = null;
		this.splitCheckPending = true;
		this.scheduleIdleStop();
		// sd-server 還常駐時不預熱：它佔著 VRAM，這時載入的對話模型會被拆到 CPU。
		// 等真的有對話時，prepareForChat 關掉 sd-server 之後才完整載入
		if (!this.d.server.isRunning()) this.d.gpu.warmOllama();
		const waiters = this.idleWaiters.splice(0);
		for (const w of waiters) w();
	}
}

/** 給 agent 看的失敗事件文字。 */
export function failureEventText(info: FailureInfo): string {
	const j = info.job;
	return [
		"[IMAGE_JOB_FAILED]",
		`${j.ref ? `修改圖片（!edit，原圖「${j.ref.label}」）` : "產圖"}失敗，需要你向使用者說明。觸發者 <@${j.userId}>，頻道 ${j.channelName ? `#${j.channelName}` : j.channelId}。`,
		`原因：${info.reason}`,
		`已跑 ${info.elapsedSec} 秒（原本預估 ${info.etaTotalSec} 秒）。`,
		`參數：${j.width}×${j.height}、${j.steps} 步、seed ${j.seed}。${j.ref ? "修改說明" : "prompt"}：${j.prompt}`,
		info.logTail ? `sd-server 最後的輸出：\n${info.logTail}` : "",
		"請用使用者的語言簡短說明失敗原因和已經花掉的時間，並給一個具體建議（例如降低解析度、減少步數、改寫 prompt，或請管理者看 sd-server.log）。不要假裝圖已經產出。",
	]
		.filter(Boolean)
		.join("\n");
}
