import { type ImageConfig, listLoras, loraFileError } from "./config.js";

/**
 * 產圖的文字指令，以及參數檢查。
 *
 * 為什麼是 `!img` 而不是 `/img`：在 Slack 輸入框打 `/` 開頭會被當成
 * slash command，沒註冊的話 Slack 直接回「不是有效的指令」，訊息根本不會送到 bot。
 * 所以主要用 `!img`；`/img` 仍然接受（例如前面多一個空白時 Slack 會照常送出）。
 */
export interface ImageParams {
	prompt: string;
	width: number;
	height: number;
	steps: number;
	seed: number;
	/** 套用 NSFW LoRA（只在明確要求時）。實測每張多約 14 秒（+40%）、VRAM +0.56GB。 */
	nsfw: boolean;
	/** 套用的一般 LoRA：loras/ 裡的相對路徑（`--lora`、`--lora2`…已經解析好）。沒有就不套。 */
	lora?: string;
	/** 要求了 LoRA 但沒套用時給使用者看的說明，例如「沒有第 3 個」。 */
	loraNote?: string;
	/** !edit：要修改的參考圖。有它就是參考圖修改，不是文字產圖。 */
	ref?: RefImage;
}

/** 參考圖（!edit）。b64 不放進任何訊息或 log。 */
export interface RefImage {
	b64: string;
	width: number;
	height: number;
	/** 給人看的來源說明，例如檔名。 */
	label: string;
}

export interface RawImageArgs {
	prompt: string;
	width?: number;
	height?: number;
	steps?: number;
	seed?: number;
	nsfw?: boolean;
	/** 0 = `--lora`（預設那一個），N = `--loraN`（loras/ 裡第 N 個）。 */
	lora?: number;
}

const CMD = /^\s*[!！/]img\b\s*/i;

export function isImgCommand(text: string): boolean {
	return CMD.test(text);
}

/** 解析 `!img <prompt> [--size 768x1024] [--steps 4] [--seed 42] [--lora|--lora2] [--nsfw]`。不是指令時回傳 null。 */
export function parseImgCommand(text: string): RawImageArgs | null {
	if (!CMD.test(text)) return null;
	let rest = text.replace(CMD, "");
	const out: RawImageArgs = { prompt: "" };
	rest = rest.replace(/--size[=\s]+(\d+)\s*[x×*]\s*(\d+)/i, (_m, w, h) => {
		out.width = Number.parseInt(w, 10);
		out.height = Number.parseInt(h, 10);
		return " ";
	});
	rest = rest.replace(/--steps[=\s]+(\d+)/i, (_m, s) => {
		out.steps = Number.parseInt(s, 10);
		return " ";
	});
	rest = rest.replace(/--seed[=\s]+(-?\d+)/i, (_m, s) => {
		out.seed = Number.parseInt(s, 10);
		return " ";
	});
	rest = rest.replace(/(^|\s)--nsfw(?=\s|$)/i, () => {
		out.nsfw = true;
		return " ";
	});
	rest = rest.replace(/(^|\s)--lora(\d*)(?=\s|$)/i, (_m, _sp, n) => {
		out.lora = n ? Number.parseInt(n, 10) : 0;
		return " ";
	});
	out.prompt = rest.replace(/\s+/g, " ").trim();
	return out;
}

const EDIT_CMD = /^\s*[!！/]edit\b\s*/i;

export function isEditCommand(text: string): boolean {
	return EDIT_CMD.test(text);
}

export const EDIT_USAGE =
	"用法：上傳一張照片，同一則訊息寫 `!edit <要怎麼改>`，例如 `!edit 把雪鏡換成細框眼鏡`。沒附照片時改這個頻道最近一張圖。可加 `--size 768x1024`、`--steps 4`、`--seed 42`、`--lora`。";

/**
 * 解析 `!edit <修改說明> [--size WxH] [--steps N] [--seed N]`。不是指令時回傳 null。
 * 和 !img 共用參數格式；--nsfw 會被保留下來，讓 normalizeEditParams 明確拒絕。
 */
export function parseEditCommand(text: string): RawImageArgs | null {
	if (!EDIT_CMD.test(text)) return null;
	return parseImgCommand(text.replace(EDIT_CMD, "!img "));
}

/**
 * 修改說明裡的裸露、性感化字眼。上傳的照片可能是真人，這類修改一律不做。
 * 盡力而為的關鍵字過濾，不是完整的內容審查。
 */
const SEXUAL_EDIT = [
	/\b(nude|nudity|naked|nsfw|topless|bottomless|undress\w*|unclothed|lingerie|underwear|panties|bra|bikini|thong|sexy|sexual|erotic|porn\w*|nipples?|breasts?|boobs?|genitals?|see[- ]?through)\b/i,
	/\b(remove|take off|strip)\b[^.]{0,30}\b(clothes|clothing|shirt|top|dress|pants|skirt|outfit)\b/i,
	/\b(no|without)\s+(clothes|clothing)\b/i,
	/裸|露點|露点|走光|色情|情趣|性感|內衣|内衣|內褲|内裤|胸罩|比基尼|乳房|乳頭|乳头|下體|下体|透視裝|透视装|透明衣/,
	/[脫脱](光|掉?衣|掉?褲|掉?裤|掉?裙|掉?上衣)/,
	/(衣服|衣物|上衣|褲子|裤子|裙子)[^，。,.]{0,4}[脫脱]/,
	/(不|沒|没)穿(衣|褲|裤)/,
];

export function isSexualEdit(prompt: string): boolean {
	return SEXUAL_EDIT.some((re) => re.test(prompt));
}

/** 依參考圖比例決定輸出尺寸：像素數和 !img 預設相同（768×1024），對齊 16。 */
export function editSize(refW: number, refH: number, cfg: ImageConfig): { width: number; height: number } {
	const budget = Math.min(cfg.defaultWidth * cfg.defaultHeight, cfg.maxPixels);
	const scale = Math.sqrt(budget / (refW * refH));
	const align = (n: number) => Math.max(256, Math.floor(n / 16) * 16);
	return { width: align(refW * scale), height: align(refH * scale) };
}

/** 只看修改說明就能判斷的錯誤（下載照片之前先檢查）。沒問題回傳 null。 */
export function checkEditPrompt(raw: RawImageArgs): string | null {
	if (raw.nsfw) return "`!edit` 不支援 `--nsfw`：上傳的照片可能是真人，不做裸露或性感化的修改。";
	if (!(raw.prompt || "").trim()) return `沒有寫要怎麼改。${EDIT_USAGE}`;
	if (isSexualEdit(raw.prompt)) return "`!edit` 不做裸露、脫衣或性感化的修改：上傳的照片可能是真人。";
	return null;
}

/** !edit 的參數：檢查修改說明，沒給 --size 就依參考圖比例。成功回傳參數，失敗回傳給使用者看的字串。 */
export function normalizeEditParams(raw: RawImageArgs, ref: RefImage, cfg: ImageConfig): ImageParams | string {
	const bad = checkEditPrompt(raw);
	if (bad) return bad;
	const size = raw.width && raw.height ? { width: raw.width, height: raw.height } : editSize(ref.width, ref.height, cfg);
	const p = normalizeParams({ ...raw, ...size, nsfw: false }, cfg, { edit: true });
	if (typeof p === "string") return p.replace("`!img <描述>", "`!edit <修改說明>").replace(" [--nsfw]", "");
	return { ...p, ref };
}

/** 補上預設值並檢查範圍。成功回傳參數，失敗回傳給使用者看的錯誤字串。 */
export function normalizeParams(raw: RawImageArgs, cfg: ImageConfig, opts: { edit?: boolean } = {}): ImageParams | string {
	const prompt = (raw.prompt || "").trim();
	if (!prompt) return "沒有提供 prompt。用法：`!img <描述> [--size 768x1024] [--steps 4] [--seed 42] [--lora|--lora2] [--nsfw]`";
	if (prompt.length > 2000) return "prompt 太長（上限 2000 字）";

	// 寬高對齊 16（Flux 系列的 latent 需要）
	const align = (n: number) => Math.max(256, Math.round(n / 16) * 16);
	const width = align(raw.width ?? cfg.defaultWidth);
	const height = align(raw.height ?? cfg.defaultHeight);
	if (width * height > cfg.maxPixels) {
		return `尺寸 ${width}×${height} 超過上限（${cfg.maxPixels} 像素，約 1024×1024）。6GB 顯示卡放不下更大的圖。`;
	}
	const steps = raw.steps ?? cfg.defaultSteps;
	if (!Number.isInteger(steps) || steps < 1 || steps > cfg.maxSteps) {
		return `步數要在 1 到 ${cfg.maxSteps} 之間（FLUX.2 Klein 建議 4 步）`;
	}
	const seed = raw.seed ?? Math.floor(Math.random() * 2 ** 31);
	const nsfw = raw.nsfw === true;
	if (nsfw && !cfg.nsfwLora) return "沒有設定 NSFW LoRA（config/agent.env 的 IMAGE_NSFW_LORA），不能使用 --nsfw";
	if (nsfw) {
		const err = loraFileError(cfg, "nsfw");
		if (err) return err;
	}
	const out: ImageParams = { prompt, width, height, steps, seed, nsfw };
	if (raw.lora !== undefined) {
		const r = resolveLora(raw.lora, cfg, opts.edit === true);
		if (typeof r === "string") return r;
		Object.assign(out, r);
	}
	return out;
}

/** 檔名看起來是 NSFW 的 LoRA：!edit 不套用（上傳的照片可能是真人）。 */
const NSFW_NAME = /nsfw|nude|naked|porn|hentai|lewd|erotic|sex|breast|nipple|pussy|penis|genital|party[_ -]?time|裸|色情|成人/i;

/** `--lora`／`--loraN` → loras/ 裡的哪個檔案。錯誤回傳字串；第 N 個不存在時不套用、附上說明。 */
export function resolveLora(n: number, cfg: ImageConfig, edit: boolean): { lora?: string; loraNote?: string } | string {
	if (cfg.loraRootError) return cfg.loraRootError;
	const files = listLoras(cfg);
	let file: string | undefined;
	if (n === 0) {
		if (cfg.lora) {
			const err = loraFileError(cfg, "lora");
			if (err) return err;
			file = cfg.lora;
		} else {
			file = files[0];
			if (!file) return `\`${cfg.loraDir}\` 裡沒有 LoRA。把 .safetensors 檔放進去就能用 \`--lora\`（不用重啟）。`;
		}
	} else {
		file = files[n - 1];
		if (!file) return { loraNote: `loras/ 只有 ${files.length} 個 LoRA，沒有第 ${n} 個，這張不套用 LoRA` };
	}
	if (edit && NSFW_NAME.test(file)) {
		return `「${file}」的檔名看起來是 NSFW LoRA，\`!edit\` 不套用（上傳的照片可能是真人）。NSFW LoRA 請放在 nsfw/ 資料夾。`;
	}
	return { lora: file };
}

const LORA_EXT_RE = /\.(safetensors|sft)$/i;

/** `!lora`、`!loras`：列出 loras/ 裡的 LoRA 和編號。 */
const LORA_LIST_CMD = /^\s*[!！/]loras?\s*$/i;

export function isLoraListCommand(text: string): boolean {
	return LORA_LIST_CMD.test(text);
}

export function formatLoraList(cfg: ImageConfig): string {
	if (cfg.loraRootError) return cfg.loraRootError;
	const files = listLoras(cfg);
	if (files.length === 0) {
		return `\`${cfg.loraDir}\` 裡還沒有 LoRA。把 FLUX.2 Klein 4B 用的 .safetensors 檔放進去就能用 \`--lora\`（不用重啟）。`;
	}
	const def = cfg.lora && files.includes(cfg.lora) ? cfg.lora : cfg.lora ? undefined : files[0];
	const lines = files.map((f, i) => `${i + 1}. ${f.replace(LORA_EXT_RE, "")}${f === def ? "（預設，\`--lora\`）" : ""}`);
	const head = `LoRA 清單（\`!img <描述> --lora2\` 用第 2 個，\`--lora\` 用預設）：`;
	const warn = cfg.lora && !def ? `\n_設定的預設 \`${cfg.lora}\` 不在資料夾裡，\`--lora\` 會失敗，請改 IMAGE_LORA 或用編號。_` : "";
	return `${head}\n${lines.join("\n")}${warn}\n_新增或刪除檔案後編號會跟著變。記得在描述裡寫 LoRA 的觸發詞。_`;
}

export type ControlWord = "stop" | "wait" | null;

/** 產圖期間的控制字：stop／取消、等待／進度。 */
export function controlWord(text: string): ControlWord {
	const t = text.trim().toLowerCase().replace(/[。.!！]+$/, "");
	if (["stop", "cancel", "取消", "停止", "中斷"].includes(t)) return "stop";
	if (["wait", "等待", "等", "進度", "status"].includes(t)) return "wait";
	return null;
}
