import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * 產圖時間預估。
 *
 * 模型：總時間 = 切換（卸載 LLM）+（新啟動：載入／常駐：編碼 prompt）
 *             + 步數 × 每步秒數 + VAE 解碼秒數
 *
 * 每步秒數 = 固定成本 + 每百萬像素成本。2026-11-20 在 RTX 2060 Max-Q 上實測
 * （FLUX.2 Klein 4B Q4，sd.cpp 預設把權重放在 RAM、每步從 RAM 串流到 GPU）：
 *   512²：7.3 s/步　768×1024：7.5 s/步　1024²：10.2 s/步
 * 時間幾乎不隨像素數成比例增加，固定成本（每步搬約 2.3GB 權重）佔大部分，
 * 所以不能用「每百萬像素」線性外推。實測過的尺寸會另外記在 stepSecBySize
 * （EMA），以實測值為準；沒量過的尺寸才用公式。
 */
export interface EtaStats {
	switchSec: number;
	/** 新啟動 sd-server 到開始抽樣：延遲載入權重 + 編碼 prompt。 */
	loadSec: number;
	/** sd-server 已常駐時，送出到開始抽樣：編碼 prompt。 */
	condSec: number;
	/** 每步固定成本（秒）。 */
	stepSecBase: number;
	/** 每步每百萬像素成本（秒）。 */
	stepSecPerMP: number;
	/** 實測過的尺寸："768x1024" → 每步秒數（EMA）。 */
	stepSecBySize: Record<string, number>;
	vaeSecPerMP: number;
	samples: number;
}

export const DEFAULT_STATS: EtaStats = {
	switchSec: 2,
	loadSec: 15,
	condSec: 3,
	stepSecBase: 6.5,
	stepSecPerMP: 3.5,
	stepSecBySize: {},
	vaeSecPerMP: 7.8,
	samples: 0,
};

export function sizeKey(width: number, height: number, lora = false, ref = false): string {
	return `${width}x${height}${lora ? "+lora" : ""}${ref ? "+ref" : ""}`;
}

/** 套用 LoRA（at_runtime）時每步變慢的倍數。2026-11-20 實測 768×1024：29.7 → 43.2 秒。 */
export const LORA_STEP_FACTOR = 1.45;

/**
 * 加了參考圖（!edit）時每步變慢的倍數：參考圖的 token 也要跑注意力。
 * 2026-11-22 實測 768×1024：7.5 → 15.8 秒。
 */
export const REF_STEP_FACTOR = 2.1;

/** 某個尺寸的每步秒數：量過就用實測值，否則用公式。 */
export function stepSec(stats: EtaStats, width: number, height: number, lora = false, ref = false): number {
	const measured = stats.stepSecBySize?.[sizeKey(width, height, lora, ref)];
	if (measured !== undefined) return measured;
	if (ref) return stepSec(stats, width, height, lora) * REF_STEP_FACTOR;
	const base = stats.stepSecBySize?.[sizeKey(width, height)] ?? stats.stepSecBase + stats.stepSecPerMP * megapixels(width, height);
	return lora ? base * LORA_STEP_FACTOR : base;
}

const ALPHA = 0.3;

export function megapixels(width: number, height: number): number {
	return (width * height) / 1_000_000;
}

export interface EtaInput {
	width: number;
	height: number;
	steps: number;
	needLoad: boolean;
	needSwitch: boolean;
	lora?: boolean;
	ref?: boolean;
}

/** 開始前的整體預估（秒）。 */
export function estimateTotal(stats: EtaStats, input: EtaInput): number {
	const mp = megapixels(input.width, input.height);
	return Math.round(
		(input.needSwitch ? stats.switchSec : 0) +
			(input.needLoad ? stats.loadSec : stats.condSec) +
			input.steps * stepSec(stats, input.width, input.height, input.lora, input.ref) +
			stats.vaeSecPerMP * mp,
	);
}

export interface LiveProgress {
	completedSteps: number;
	totalSteps: number;
	/** 抽樣開始到「最近一次步數增加」的秒數；還沒完成任何一步時為 0。 */
	stepsElapsedSec: number;
	/** 最近一次步數增加（或抽樣開始）到現在的秒數：目前這一步已經跑了多久。 */
	currentStepSec: number;
}

/**
 * 執行中的剩餘時間（秒），是真正的倒數：
 *   每步秒數 × 剩下的步數 − 目前這一步已經跑掉的時間 + VAE 解碼
 * 每步秒數：完成過至少一步就用實測值，否則用統計值。
 * 不在抽樣階段（live 為 null）時用開始前的預估扣掉已過時間。
 * 下限是 VAE 解碼時間——還沒產完就不顯示「剩 0 秒」。
 */
export function estimateRemaining(
	stats: EtaStats,
	width: number,
	height: number,
	live: LiveProgress | null,
	fallbackRemaining: number,
	lora = false,
	ref = false,
): number {
	const mp = megapixels(width, height);
	const vae = stats.vaeSecPerMP * mp;
	if (!live || live.totalSteps <= 0) return Math.max(Math.round(vae), Math.round(fallbackRemaining));
	// 目前這一步已經跑得比預估久，就以實際已跑的時間為準（第一次產圖、統計還是預設值時常見）
	const perStep = Math.max(
		live.completedSteps > 0 ? live.stepsElapsedSec / live.completedSteps : stepSec(stats, width, height, lora, ref),
		live.currentStepSec,
	);
	const left = Math.max(0, live.totalSteps - live.completedSteps);
	const sampling = Math.max(left > 0 ? perStep * 0.1 : 0, left * perStep - live.currentStepSec);
	return Math.round(sampling + vae);
}

/** 逾時上限：max(ETA × factor, minSec)。 */
export function timeoutSec(etaSec: number, factor: number, minSec: number): number {
	return Math.max(Math.round(etaSec * factor), minSec);
}

export interface Measured {
	width: number;
	height: number;
	steps: number;
	switchSec?: number;
	loadSec?: number;
	condSec?: number;
	samplingSec?: number;
	vaeSec?: number;
	lora?: boolean;
	ref?: boolean;
	/** 新啟動 sd-server 的第一張圖：含磁碟讀取和 CUDA 暖機，抽樣和 VAE 會明顯偏慢，不拿來更新每步秒數。 */
	fresh?: boolean;
}

function ema(old: number, v: number | undefined, first: boolean): number {
	if (v === undefined || !Number.isFinite(v) || v < 0) return old;
	return first ? v : old * (1 - ALPHA) + v * ALPHA;
}

/** 用一次實測結果更新統計。每個欄位第一次有實測值時直接取代預設值。 */
export function updateStats(stats: EtaStats, m: Measured): EtaStats {
	const mp = megapixels(m.width, m.height);
	const first = stats.samples === 0;
	const bySize = { ...(stats.stepSecBySize ?? {}) };
	let vaeSecPerMP = stats.vaeSecPerMP;
	if (!m.fresh && m.samplingSec !== undefined && m.steps > 0) {
		const key = sizeKey(m.width, m.height, m.lora, m.ref);
		const v = m.samplingSec / m.steps;
		bySize[key] = key in bySize ? ema(bySize[key], v, false) : v;
	}
	if (!m.fresh && m.vaeSec !== undefined && mp > 0) vaeSecPerMP = ema(stats.vaeSecPerMP, m.vaeSec / mp, first);
	return {
		...stats,
		switchSec: ema(stats.switchSec, m.switchSec, first),
		loadSec: ema(stats.loadSec, m.loadSec, first),
		condSec: ema(stats.condSec, m.condSec, first),
		stepSecBySize: bySize,
		vaeSecPerMP,
		samples: stats.samples + 1,
	};
}

export function loadStats(path: string): EtaStats {
	try {
		if (existsSync(path)) {
			const d = JSON.parse(readFileSync(path, "utf-8"));
			// 舊版統計檔沒有 stepSecBase／stepSecBySize，而且它的 stepSecPerMP 是線性模型的值，不能沿用
			if (!("stepSecBase" in d)) return { ...DEFAULT_STATS };
			return { ...DEFAULT_STATS, ...d };
		}
	} catch {
		// 壞掉的統計檔不該擋住產圖，退回預設值
	}
	return { ...DEFAULT_STATS };
}

export function saveStats(path: string, stats: EtaStats): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(stats, null, "\t")}\n`);
}

/** 給人看的秒數：45 秒、2 分 10 秒 */
export function fmtSec(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	if (s < 60) return `${s} 秒`;
	const m = Math.floor(s / 60);
	const r = s % 60;
	return r ? `${m} 分 ${r} 秒` : `${m} 分`;
}
