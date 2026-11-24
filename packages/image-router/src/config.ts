import { existsSync, readdirSync } from "fs";
import { dirname, isAbsolute, join, relative, sep } from "path";

/**
 * 產圖設定。全部來自環境變數（config/agent.env 透過 lib.sh 的 `set -a` 匯出）。
 *
 * 注意：start 會把 HOME 換成隔離用的 PI_HOME，所以這裡的預設路徑一律
 * 以 STATE_DIR 為基準，不用 `~`。
 */
export type ResidentMode = "vram" | "ram";

export interface ImageConfig {
	enabled: boolean;
	serverBin: string;
	modelDir: string;
	diffusionModel: string;
	llm: string;
	vae: string;
	/** 一般 LoRA 的資料夾（預設 <modelDir>/loras）。 */
	loraDir: string;
	/** `--lora`（不帶編號）套用的檔案（相對於 loraDir，可以有子資料夾）；空字串 = 用 loras/ 裡排第一的。 */
	lora: string;
	loraWeight: number;
	/** NSFW LoRA 的資料夾（預設 <modelDir>/nsfw），和一般 LoRA 分開放。 */
	nsfwDir: string;
	/** NSFW LoRA 檔名（相對於 nsfwDir）；空字串 = 停用 --nsfw。只在請求明確要求時套用。 */
	nsfwLora: string;
	nsfwLoraWeight: number;
	/**
	 * sd-server 的 --lora-model-dir：loraDir 和 nsfwDir 共同的上層資料夾。
	 * sd-server 只收一個 LoRA 資料夾，但會往下掃子資料夾，請求裡用相對路徑（例如 loras/x.safetensors）指定。
	 */
	loraRoot: string;
	/** loraDir 和 nsfwDir 不在同一層時的錯誤：不加 --lora-model-dir，--lora、--nsfw 都停用。 */
	loraRootError?: string;
	host: string;
	port: number;
	/**
	 * vram：sd-server 的權重放在 VRAM。有人要聊天時，router 會先關掉 sd-server。
	 * ram ：加 --offload-to-cpu，權重常駐在 RAM，只有產圖時才搬進 VRAM，聊天時不必關掉。
	 */
	residentMode: ResidentMode;
	/** 閒置多久後自動關掉 sd-server（秒）。0 = 產完就關。 */
	keepAliveSec: number;
	defaultWidth: number;
	defaultHeight: number;
	defaultSteps: number;
	maxSteps: number;
	/** 寬 × 高的上限；超過就拒絕，避免 6GB 卡 OOM。 */
	maxPixels: number;
	timeoutFactor: number;
	minTimeoutSec: number;
	/** sd-server 啟動加上模型載入的上限（秒）。 */
	loadTimeoutSec: number;
	extraArgs: string[];
	/** 圖片輸出目錄。放在 workspace 底下，沙箱裡的 agent 也能從 /workspace/images 讀到。 */
	outputDir: string;
	statsPath: string;
	pidPath: string;
	logPath: string;
	/** ollama 原生 API（不是 /v1）。HOST 不是 ollama 時為 undefined，router 就不卸載 LLM。 */
	ollamaBaseUrl?: string;
	llmModel?: string;
	/** 產圖前 VRAM 至少要空出多少 MB；拿不到 nvidia-smi 時略過檢查。 */
	vramNeedMb: number;
}

function int(v: string | undefined, d: number): number {
	const n = Number.parseInt(v ?? "", 10);
	return Number.isFinite(n) ? n : d;
}

function num(v: string | undefined, d: number): number {
	const n = Number.parseFloat(v ?? "");
	return Number.isFinite(n) ? n : d;
}

/** "10m" / "90s" / "1h" / "300" → 秒 */
export function parseDuration(v: string | undefined, d: number): number {
	if (!v) return d;
	const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([smh]?)$/i);
	if (!m) return d;
	const n = Number.parseFloat(m[1]);
	const unit = m[2].toLowerCase();
	return Math.round(unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n);
}

/** 兩個資料夾共同的上層資料夾。 */
export function commonDir(a: string, b: string): string {
	let d = a;
	while (true) {
		const r = relative(d, b);
		if (r === "" || (!r.startsWith("..") && !isAbsolute(r))) return d;
		const up = dirname(d);
		if (up === d) return d;
		d = up;
	}
}

/**
 * 模型資料夾。預設 $STATE_DIR/models/image/flux2；舊的配置（模型直接放在 models/image、
 * NSFW LoRA 放在 models/image/loras）還沒搬家時沿用舊路徑，不會壞掉。
 */
function resolveDirs(env: NodeJS.ProcessEnv, stateDir: string, diffusionModel: string, nsfwLora: string) {
	const imageRoot = join(stateDir, "models", "image");
	let modelDir = env.IMAGE_MODEL_DIR || join(imageRoot, "flux2");
	if (!env.IMAGE_MODEL_DIR && !existsSync(join(modelDir, diffusionModel)) && existsSync(join(imageRoot, diffusionModel))) {
		modelDir = imageRoot;
	}
	const loraDir = env.IMAGE_LORA_DIR || join(modelDir, "loras");
	let nsfwDir = env.IMAGE_NSFW_DIR || join(modelDir, "nsfw");
	if (!env.IMAGE_NSFW_DIR && nsfwLora && !existsSync(join(nsfwDir, nsfwLora)) && existsSync(join(loraDir, nsfwLora))) {
		nsfwDir = loraDir;
	}
	const loraRoot = commonDir(loraDir, nsfwDir);
	// sd-server 會往下掃整個 loraRoot；兩個資料夾離太遠時 loraRoot 可能是 / 或家目錄，不能拿來掃
	const near = (d: string) => d === loraRoot || dirname(d) === loraRoot;
	const loraRootError =
		near(loraDir) && near(nsfwDir)
			? undefined
			: `LoRA 資料夾（${loraDir}）和 NSFW 資料夾（${nsfwDir}）要放在同一層，例如 flux2/loras 和 flux2/nsfw。請改 config/agent.env 的 IMAGE_LORA_DIR／IMAGE_NSFW_DIR，然後重啟 bot。`;
	return { modelDir, loraDir, nsfwDir, loraRoot, loraRootError };
}

const LORA_EXT = /\.(safetensors|sft)$/i;

/**
 * loras/ 裡的 LoRA，相對路徑（`/` 分隔），依「子資料夾/檔名」排序（數字照大小：v2 在 v10 前面）。
 * `--lora1`、`--lora2` 就是這個順序。每次呼叫都重新讀資料夾，新增檔案不用重啟。
 */
export function listLoras(cfg: ImageConfig): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		let entries: import("fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
			else if (e.isFile() && LORA_EXT.test(e.name)) out.push(`${prefix}${e.name}`);
		}
	};
	walk(cfg.loraDir, "");
	return out.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}

/** 傳給 sd-server 的 LoRA 路徑：相對於 loraRoot，用 `/` 分隔。file 是 loras/ 裡的相對路徑。 */
export function loraRequestPath(cfg: ImageConfig, kind: "lora" | "nsfw", file?: string): string {
	const full = kind === "lora" ? join(cfg.loraDir, file ?? cfg.lora) : join(cfg.nsfwDir, cfg.nsfwLora);
	return relative(cfg.loraRoot, full).split(sep).join("/");
}

/** LoRA 檔案不在時回傳給使用者看的錯誤；沒問題回傳 null。 */
export function loraFileError(cfg: ImageConfig, kind: "lora" | "nsfw"): string | null {
	if (cfg.loraRootError) return cfg.loraRootError;
	const [dir, file, key] = kind === "lora" ? [cfg.loraDir, cfg.lora, "IMAGE_LORA"] : [cfg.nsfwDir, cfg.nsfwLora, "IMAGE_NSFW_LORA"];
	if (!file) return null;
	const p = join(dir, file);
	if (existsSync(p)) return null;
	return `找不到 ${kind === "lora" ? "LoRA" : "NSFW LoRA"} 檔案：\`${p}\`。請把檔案放進 \`${dir}\`，或改 config/agent.env 的 ${key}，然後重啟 bot。`;
}

export function loadImageConfig(env: NodeJS.ProcessEnv = process.env): ImageConfig {
	const stateDir = env.STATE_DIR || join(process.cwd(), ".pi-mom-local");
	const diffusionModel = env.IMAGE_DIFFUSION_MODEL || "flux-2-klein-4b-Q4_0.gguf";
	// NSFW LoRA 是選用的：沒設 IMAGE_NSFW_LORA 就停用 --nsfw
	const nsfwLora = env.IMAGE_NSFW_LORA ?? "";
	const dirs = resolveDirs(env, stateDir, diffusionModel, nsfwLora);
	const workspace = env.WORKSPACE || join(stateDir, "workspace");
	const [dw, dh] = (env.IMAGE_DEFAULT_SIZE || "768x1024").split("x").map((s) => Number.parseInt(s, 10));

	let ollamaBaseUrl: string | undefined;
	if ((env.HOST || "ollama") === "ollama") {
		ollamaBaseUrl = (env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/v1\/?$/, "");
	}

	return {
		enabled: env.IMAGE_ENABLED === "1" || env.IMAGE_ENABLED === "true",
		serverBin: env.IMAGE_SD_SERVER_BIN || join(stateDir, "bin", "sd-server"),
		modelDir: dirs.modelDir,
		diffusionModel,
		llm: env.IMAGE_LLM || "Qwen3-4B-abliterated.Q4_K_M.gguf",
		vae: env.IMAGE_VAE || "flux2-klein-vae.safetensors",
		loraDir: dirs.loraDir,
		lora: env.IMAGE_LORA ?? "",
		loraWeight: num(env.IMAGE_LORA_WEIGHT, 0.6),
		nsfwDir: dirs.nsfwDir,
		nsfwLora,
		nsfwLoraWeight: num(env.IMAGE_NSFW_LORA_WEIGHT, 1.0),
		loraRoot: dirs.loraRoot,
		loraRootError: dirs.loraRootError,
		host: "127.0.0.1",
		// 不用 sd-server 預設的 1234：會和 LM Studio 撞 port
		port: int(env.IMAGE_PORT, 7861),
		// 預設 ram（2026-11-20 step4 實測）：sd.cpp 本來就把權重放在 RAM，兩種模式速度和 VRAM 峰值都一樣，
		// 常駐閒置時只佔 VRAM 約 0.6GB，可以和 qwen（4.3GB）並存；所以產完不關 sd-server、立刻預熱 ollama
		residentMode: env.IMAGE_RESIDENT_MODE === "vram" ? "vram" : "ram",
		keepAliveSec: parseDuration(env.IMAGE_KEEP_ALIVE, 600),
		defaultWidth: Number.isFinite(dw) ? dw : 768,
		defaultHeight: Number.isFinite(dh) ? dh : 1024,
		defaultSteps: int(env.IMAGE_DEFAULT_STEPS, 4),
		maxSteps: int(env.IMAGE_MAX_STEPS, 8),
		maxPixels: int(env.IMAGE_MAX_PIXELS, 1024 * 1024),
		timeoutFactor: num(env.IMAGE_TIMEOUT_FACTOR, 3),
		minTimeoutSec: int(env.IMAGE_MIN_TIMEOUT_SEC, 180),
		loadTimeoutSec: int(env.IMAGE_LOAD_TIMEOUT_SEC, 180),
		extraArgs: (env.IMAGE_SD_EXTRA_ARGS || "").split(/\s+/).filter(Boolean),
		outputDir: env.IMAGE_OUTPUT_DIR || join(workspace, "images"),
		statsPath: join(stateDir, "image-stats.json"),
		pidPath: join(stateDir, "sd-server.pid"),
		logPath: join(env.LOG_DIR || join(stateDir, "logs"), "sd-server.log"),
		ollamaBaseUrl,
		llmModel: env.LLM_MODEL,
		vramNeedMb: int(env.IMAGE_VRAM_NEED_MB, 4500),
	};
}

/** sd-server 的啟動參數。抽出來讓測試可以檢查。 */
export function buildServerArgs(cfg: ImageConfig): string[] {
	const args = [
		"--listen-ip",
		cfg.host,
		"--listen-port",
		String(cfg.port),
		"--diffusion-model",
		join(cfg.modelDir, cfg.diffusionModel),
		"--llm",
		join(cfg.modelDir, cfg.llm),
		"--vae",
		join(cfg.modelDir, cfg.vae),
		"--cfg-scale",
		"1.0",
		"--steps",
		String(cfg.defaultSteps),
	];
	if (cfg.residentMode === "ram") args.push("--offload-to-cpu");
	// --lora 可以用 loras/ 裡任何一個檔案（之後才放進去的也算），所以一律指定 LoRA 資料夾
	if (!cfg.loraRootError) args.push("--lora-model-dir", cfg.loraRoot);
	return [...args, ...cfg.extraArgs];
}
