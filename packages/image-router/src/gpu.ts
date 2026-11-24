import { execFile } from "child_process";

/**
 * 和 GPU、ollama 打交道的小工具。全部可替換（GpuOps 介面），讓測試不必真的有 GPU。
 */
export interface GpuOps {
	/** 卸載 ollama 目前載入的所有模型，回傳卸載了哪些。 */
	unloadOllama(): Promise<string[]>;
	/** 預熱對話模型（不等它完成）。 */
	warmOllama(): void;
	/** VRAM 剩餘 MB；拿不到時回傳 null。 */
	vramFreeMb(): Promise<number | null>;
	/** 已載入的 ollama 模型有多少比例跑在 CPU（0–1，取最大值）；沒載入或拿不到時回傳 null。 */
	ollamaCpuShare?(): Promise<number | null>;
}

function nvidiaSmiFree(): Promise<number | null> {
	return new Promise((resolve) => {
		execFile(
			"nvidia-smi",
			["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
			{ timeout: 5000 },
			(err, stdout) => {
				if (err) return resolve(null);
				const n = Number.parseInt(String(stdout).trim().split("\n")[0], 10);
				resolve(Number.isFinite(n) ? n : null);
			},
		);
	});
}

export function createGpuOps(ollamaBaseUrl: string | undefined, llmModel: string | undefined): GpuOps {
	return {
		async unloadOllama() {
			if (!ollamaBaseUrl) return [];
			try {
				const res = await fetch(`${ollamaBaseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) });
				const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
				const names = (body.models ?? []).map((m) => m.model || m.name).filter((x): x is string => Boolean(x));
				await Promise.all(
					names.map((model) =>
						fetch(`${ollamaBaseUrl}/api/generate`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ model, keep_alive: 0 }),
							signal: AbortSignal.timeout(15000),
						}).catch(() => undefined),
					),
				);
				return names;
			} catch {
				return [];
			}
		},
		async ollamaCpuShare() {
			if (!ollamaBaseUrl) return null;
			try {
				const res = await fetch(`${ollamaBaseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) });
				const body = (await res.json()) as { models?: Array<{ size?: number; size_vram?: number }> };
				const shares = (body.models ?? [])
					.filter((m) => (m.size ?? 0) > 0)
					.map((m) => 1 - (m.size_vram ?? 0) / (m.size as number));
				return shares.length ? Math.max(...shares) : null;
			} catch {
				return null;
			}
		},
		warmOllama() {
			if (!ollamaBaseUrl || !llmModel) return;
			fetch(`${ollamaBaseUrl}/api/generate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: llmModel, keep_alive: "10m" }),
				signal: AbortSignal.timeout(120000),
			}).catch(() => undefined);
		},
		vramFreeMb: nvidiaSmiFree,
	};
}

/** 等 VRAM 空出 needMb，最多 timeoutMs。拿不到 nvidia-smi 時直接放行。 */
export async function waitVramFree(
	ops: GpuOps,
	needMb: number,
	timeoutMs: number,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: boolean; freeMb: number | null }> {
	const deadline = Date.now() + timeoutMs;
	let free = await ops.vramFreeMb();
	while (free !== null && free < needMb && Date.now() < deadline) {
		await sleep(500);
		free = await ops.vramFreeMb();
	}
	return { ok: free === null || free >= needMb, freeMb: free };
}
