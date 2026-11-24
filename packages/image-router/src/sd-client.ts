/**
 * sd-server（stable-diffusion.cpp）原生非同步 API 的薄封裝。
 * 依據 upstream examples/server/api.md（2026-11，master-1106）。
 *
 *   POST /sdcpp/v1/img_gen            → { id, ... }
 *   GET  /sdcpp/v1/jobs/{id}          → { status, progress{stage,completed,total,unit,elapsed_ms}, result{images[{b64_json}]} }
 *   POST /sdcpp/v1/jobs/{id}/cancel   → 生成中的 job 會在 checkpoint 中斷，要繼續輪詢直到變成 cancelled
 *
 * ⚠ step4 實機驗證前，回應裡的錯誤欄位名稱、就緒判斷方式都是依文件推測；
 *   所以解析時寬鬆處理，未知格式一律保留原文給錯誤訊息用。
 */
export type SdJobStatus = "queued" | "generating" | "completed" | "failed" | "cancelled";

export interface SdProgress {
	stage?: string;
	completed?: number | null;
	total?: number | null;
	unit?: string;
	stage_elapsed_ms?: number;
	elapsed_ms?: number;
}

export interface SdJob {
	id: string;
	status: SdJobStatus;
	progress?: SdProgress;
	images?: string[];
	error?: string;
	cancelRequested?: boolean;
}

export interface ImgGenRequest {
	prompt: string;
	negativePrompt?: string;
	width: number;
	height: number;
	steps: number;
	seed: number;
	cfg?: number;
	/** 每個請求各自指定；quantized 模型會用 at_runtime 套用，不需要重新載入。 */
	lora?: Array<{ path: string; multiplier: number }>;
	/** 參考圖（base64），!edit 用。 */
	refImages?: string[];
	/** sd-server 的 image_preprocess 規則，例如把參考圖縮放到輸出尺寸。 */
	imagePreprocess?: string;
}

export class SdClient {
	constructor(
		private baseUrl: string,
		private fetchImpl: typeof fetch = fetch,
	) {}

	private async json(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<{ status: number; body: any }> {
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(init?.headers || {}) },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		let body: any = text;
		try {
			body = text ? JSON.parse(text) : {};
		} catch {
			// 保留原文
		}
		return { status: res.status, body };
	}

	/**
	 * 模型狀態。依 api.md：GET /sdcpp/v1/models/status → state: empty | loading | ready | error。
	 * 舊版沒有這個端點時，退回看 /v1/models 有沒有列出模型。
	 * 連不上（還在啟動）回傳 "down"。
	 */
	async modelState(): Promise<{ state: "down" | "empty" | "loading" | "ready" | "error"; error?: string }> {
		try {
			const { status, body } = await this.json("/sdcpp/v1/models/status", undefined, 3000);
			if (status === 200 && typeof body?.state === "string") {
				const st = body.state as "empty" | "loading" | "ready" | "error";
				return st === "error" ? { state: "error", error: String(body.error ?? "unknown") } : { state: st };
			}
			const r = await this.json("/v1/models", undefined, 3000);
			if (r.status !== 200) return { state: "loading" };
			return Array.isArray(r.body?.data) && r.body.data.length > 0 ? { state: "ready" } : { state: "loading" };
		} catch {
			return { state: "down" };
		}
	}

	async ready(): Promise<boolean> {
		return (await this.modelState()).state === "ready";
	}

	async submit(req: ImgGenRequest): Promise<string> {
		const payload = {
			prompt: req.prompt,
			negative_prompt: req.negativePrompt ?? "",
			width: req.width,
			height: req.height,
			seed: req.seed,
			// Klein 會被誤判成 Flux 而套用 20 步的預設值，所以每次都明確指定步數
			sample_params: {
				sample_steps: req.steps,
				guidance: { txt_cfg: req.cfg ?? 1.0 },
			},
			output_format: "png",
			...(req.lora?.length ? { lora: req.lora } : {}),
			...(req.refImages?.length ? { ref_images: req.refImages } : {}),
			...(req.imagePreprocess ? { image_preprocess: req.imagePreprocess } : {}),
		};
		const { status, body } = await this.json("/sdcpp/v1/img_gen", { method: "POST", body: JSON.stringify(payload) });
		const id = body?.id ?? body?.job_id ?? body?.job?.id;
		if (status >= 300 || !id) {
			throw new Error(`sd-server 拒絕產圖請求（HTTP ${status}）：${typeof body === "string" ? body : JSON.stringify(body)}`);
		}
		return String(id);
	}

	async job(id: string): Promise<SdJob> {
		const { status, body } = await this.json(`/sdcpp/v1/jobs/${encodeURIComponent(id)}`);
		if (status === 404 || status === 410) return { id, status: "failed", error: `job 不存在（HTTP ${status}）` };
		if (status >= 300) return { id, status: "failed", error: `查詢 job 失敗（HTTP ${status}）` };
		return parseJob(id, body);
	}

	async cancel(id: string): Promise<void> {
		try {
			await this.json(`/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
		} catch {
			// 取消失敗由 supervisor 的強制 kill 接手
		}
	}
}

export function parseJob(id: string, body: any): SdJob {
	const status = String(body?.status ?? "failed") as SdJobStatus;
	const imgs: unknown[] = body?.result?.images ?? body?.images ?? [];
	const images = imgs
		.map((x: any) => (typeof x === "string" ? x : x?.b64_json))
		.filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
	let error: string | undefined;
	const e = body?.error ?? body?.message ?? body?.result?.error;
	if (e) error = typeof e === "string" ? e : (e.message ?? JSON.stringify(e));
	return {
		id,
		status,
		progress: body?.progress ?? undefined,
		images,
		error,
		cancelRequested: Boolean(body?.cancel_requested),
	};
}
