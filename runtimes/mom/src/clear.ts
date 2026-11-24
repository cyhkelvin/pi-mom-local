import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * 清除指令（issue #30、#32）：/clear、/clear-record、!clear-slack、!clear-all。
 *
 * - clear：只清對話記憶（context.jsonl）。log.jsonl 留著，但要記下清除的範圍，
 *   否則下一輪 syncLogToSessionManager 會把 log.jsonl 裡的舊訊息全部補同步回來。
 * - clear-record：連本機紀錄（log.jsonl、last_prompt.jsonl、attachments/）一起刪。
 * - clear-slack：刪 Slack 上 bot 的訊息（slack-clear.ts）。clear-all = clear-slack + clear-record。
 * 都保留 MEMORY.md：那是 bot 刻意寫下的長期筆記，不是對話紀錄。
 *
 * 範圍參數（四個指令都能用，擇一）：
 * - `--since 2026-11-20`（可加時間 `--since 2026-11-20 15:00`、`--since 11-20`）：這個時間點以後的
 * - `--last 100`：最近 100 則
 * 不加就是全部。範圍一律是「某個時間點以後」，所以本機只要從尾巴截掉，不會留下斷掉的對話。
 *
 * Slack 私訊裡 `/` 開頭的訊息會被當成 slash command 擋下，所以也接受 `!clear`、`！clear`。
 */
export type ClearMode = "clear" | "clear-record";
export type ClearKind = ClearMode | "clear-slack" | "clear-all";

export interface ClearRange {
	since?: Date;
	last?: number;
}

export interface ClearRequest {
	kind: ClearKind;
	/** clear-slack、clear-all 要加 confirm 才真的刪 */
	confirm: boolean;
	range: ClearRange;
	/** 參數寫錯時的說明；有這個就不要執行 */
	error?: string;
}

const CMD = /^\s*[!！/](clear-record|clear-slack|clear-all|clear)(?=\s|$)(.*)$/is;
const CONFIRM = /^(confirm|確認|确认)$/i;
const MAX_LAST = 10000;

export const CLEAR_USAGE =
	"_用法：`/clear`、`/clear-record`、`!clear-slack`、`!clear-all`，可以加一個範圍：" +
	"`--since 2026-11-20`（這天以後，也可以寫 `--since 11-20 15:00`）或 `--last 100`（最近 100 則）。不加就是全部。_";

/** 解析清除指令；不是清除指令回傳 null。參數寫錯時回傳帶 error 的結果，讓 bot 回說明，不要交給模型。 */
export function parseClearRequest(text: string, now: Date = new Date()): ClearRequest | null {
	const m = CMD.exec(text);
	if (!m) return null;
	const req: ClearRequest = { kind: m[1].toLowerCase() as ClearKind, confirm: false, range: {} };
	const tokens = m[2]
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.flatMap((t) => (/^--\w+=/.test(t) ? t.split("=", 2) : [t]));
	const fail = (msg: string) => ({ ...req, error: `_${msg}_\n${CLEAR_USAGE}` });
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (CONFIRM.test(t)) {
			req.confirm = true;
		} else if (/^--since$/i.test(t)) {
			const d = tokens[i + 1];
			if (!d) return fail("`--since` 後面要接日期，例如 `--since 2026-11-20`。");
			const time = tokens[i + 2] && /^\d{1,2}:\d{2}$/.test(tokens[i + 2]) ? tokens[i + 2] : undefined;
			const since = parseSinceDate(d, time, now);
			if (!since) return fail(`看不懂日期「${d}${time ? ` ${time}` : ""}」。`);
			if (since.getTime() > now.getTime()) return fail(`「${formatDateTime(since)}」還沒到。`);
			req.range.since = since;
			i += time ? 2 : 1;
		} else if (/^--last$/i.test(t)) {
			const n = tokens[i + 1];
			if (!n || !/^\d+$/.test(n) || Number(n) < 1 || Number(n) > MAX_LAST) {
				return fail(`\`--last\` 後面要接 1 到 ${MAX_LAST} 的數字，例如 \`--last 100\`。`);
			}
			req.range.last = Number(n);
			i += 1;
		} else {
			return fail(`看不懂「${t}」。`);
		}
	}
	if (req.range.since && req.range.last) return fail("`--since` 和 `--last` 只能選一個。");
	return req;
}

/** 2026-11-20、2026/11/20、11-20、11/20，加上可選的 HH:MM；用本機時區。 */
export function parseSinceDate(date: string, time: string | undefined, now: Date = new Date()): Date | undefined {
	const full = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(date);
	const short = /^(\d{1,2})[-/](\d{1,2})$/.exec(date);
	let y: number;
	let mo: number;
	let d: number;
	if (full) [y, mo, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
	else if (short) [y, mo, d] = [now.getFullYear(), Number(short[1]), Number(short[2])];
	else return undefined;
	let hh = 0;
	let mm = 0;
	if (time) {
		const t = /^(\d{1,2}):(\d{2})$/.exec(time);
		if (!t) return undefined;
		[hh, mm] = [Number(t[1]), Number(t[2])];
		if (hh > 23 || mm > 59) return undefined;
	}
	const r = new Date(y, mo - 1, d, hh, mm);
	// 擋掉 2/30 這種會自動進位的日期
	if (r.getFullYear() !== y || r.getMonth() !== mo - 1 || r.getDate() !== d) return undefined;
	// 只寫月日卻比現在晚，是指去年
	if (short && r.getTime() > now.getTime()) r.setFullYear(y - 1);
	return r;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

export function formatDateTime(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 給人看的範圍說明：「2026-11-20 00:00 以後的」、「最近 100 則」、「全部」 */
export function describeRange(range: ClearRange): string {
	if (range.since) return `${formatDateTime(range.since)} 以後的`;
	if (range.last) return `最近 ${range.last} 則`;
	return "全部";
}

/** 照原樣組回範圍參數，讓 bot 說明時能給出可以直接複製的 confirm 指令。 */
export function formatRangeArgs(range: ClearRange): string {
	if (range.since) {
		const d = range.since;
		const time = d.getHours() || d.getMinutes() ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
		return ` --since ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${time}`;
	}
	if (range.last) return ` --last ${range.last}`;
	return "";
}

/** Date → Slack ts 格式（秒.微秒）。 */
export function dateToTs(d: Date): string {
	return `${Math.floor(d.getTime() / 1000)}.000000`;
}

export function tsToMs(ts: string): number {
	const [s, u = "0"] = ts.split(".");
	return Number(s) * 1000 + Number(u.padEnd(6, "0")) / 1000;
}

/** Slack ts（"1795165288.446299"）比大小：a <= b。 */
export function tsLte(a: string, b: string): boolean {
	const [as, au = "0"] = a.split(".");
	const [bs, bu = "0"] = b.split(".");
	if (Number(as) !== Number(bs)) return Number(as) < Number(bs);
	return Number(au.padEnd(6, "0")) <= Number(bu.padEnd(6, "0"));
}

/**
 * 數「最近 N 則」時不算的訊息：清除指令本身，和 bot 回的確認說明（裡面有 `!clear-… confirm`）。
 * 不然先打 `!clear-all --last 10` 再打 confirm，10 則裡有 3 則是這些。
 */
export function isClearNoise(text: string | undefined): boolean {
	if (!text) return false;
	return CMD.test(text) || /!clear-(slack|all) confirm/.test(text);
}

/** 讀 log.jsonl 的每一行（壞掉的行保留原文，但沒有 ts）。 */
function readLogLines(channelDir: string): Array<{ raw: string; ts?: string; text?: string; attachments: string[] }> {
	const p = join(channelDir, "log.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((raw) => {
			try {
				const j = JSON.parse(raw) as { ts?: string; text?: string; attachments?: Array<{ local?: string }> };
				return { raw, ts: j.ts, text: j.text, attachments: (j.attachments ?? []).map((a) => a.local).filter((x): x is string => !!x) };
			} catch {
				return { raw, attachments: [] };
			}
		});
}

/**
 * `--last N` 在本機紀錄的換算：log.jsonl 從新到舊數第 N 則的 ts（不算下指令的那則和其他清除指令）。
 * 不到 N 則就回傳 "0.000000"，也就是全部。
 */
export function cutoffFromLog(channelDir: string, last: number, excludeTs?: string): string {
	const all = readLogLines(channelDir)
		.filter((l) => !isClearNoise(l.text))
		.map((l) => l.ts)
		.filter((ts): ts is string => !!ts && ts !== excludeTs)
		.sort((a, b) => (tsLte(a, b) ? 1 : -1));
	return all.length < last ? "0.000000" : all[last - 1];
}

/**
 * 記錄清除範圍的檔案；範圍內的 log.jsonl 訊息不再補同步回對話記憶。
 * 每一行是一個範圍：「to」（舊格式，代表 to 以前全部）或「from to」。
 */
export const CLEARED_MARKER = ".context-cleared";

export type ClearedRange = [from: string, to: string];

export function readClearedRanges(channelDir: string): ClearedRange[] {
	try {
		const p = join(channelDir, CLEARED_MARKER);
		if (!existsSync(p)) return [];
		return readFileSync(p, "utf-8")
			.split("\n")
			.map((l) => l.trim().split(/\s+/).filter(Boolean))
			.filter((parts) => parts.length > 0)
			.map((parts): ClearedRange => (parts.length === 1 ? ["0", parts[0]] : [parts[0], parts[1]]));
	} catch {
		return [];
	}
}

export function isClearedTs(ts: string, ranges: ClearedRange[]): boolean {
	return ranges.some(([from, to]) => tsLte(from, ts) && tsLte(ts, to));
}

/**
 * 對話記憶從尾巴截掉：第一筆時間 >= cutoff 的紀錄開始全部丟掉。
 * context.jsonl 是一條往後接的鏈（每筆的 parentId 指向前一筆），保留前段不會有斷掉的參照。
 * @returns 丟掉的筆數；全部丟光時直接刪檔
 */
export function truncateContext(channelDir: string, cutoffTs: string): number {
	const p = join(channelDir, "context.jsonl");
	if (!existsSync(p)) return 0;
	const cutoffMs = tsToMs(cutoffTs);
	const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
	let cut = lines.length;
	for (let i = 0; i < lines.length; i++) {
		let e: { type?: string; timestamp?: string };
		try {
			e = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		if (e.type === "session") continue;
		const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
		if (!Number.isNaN(t) && t >= cutoffMs) {
			cut = i;
			break;
		}
	}
	const removed = lines.length - cut;
	if (removed === 0) return 0;
	const kept = lines.slice(0, cut);
	const keptEntries = kept.filter((l) => {
		try {
			return (JSON.parse(l) as { type?: string }).type !== "session";
		} catch {
			return false;
		}
	});
	if (keptEntries.length === 0) rmSync(p, { force: true });
	else writeFileSync(p, `${kept.join("\n")}\n`);
	return removed;
}

/**
 * 刪除頻道資料夾裡的對話檔案，回傳實際刪掉的項目說明。
 * @param commandTs 下指令那則訊息的 Slack ts；clear 模式會把它寫進 CLEARED_MARKER
 * @param cutoffTs 只清這個時間點以後的（--since、--last）；不給就是全部
 */
export function clearChannelFiles(channelDir: string, mode: ClearMode, commandTs: string, cutoffTs?: string): string[] {
	if (cutoffTs === undefined) return clearAll(channelDir, mode, commandTs);

	const removed: string[] = [];
	const ctx = truncateContext(channelDir, cutoffTs);
	if (ctx) removed.push(`context.jsonl ${ctx} 筆`);
	const lp = join(channelDir, "last_prompt.jsonl");
	if (existsSync(lp)) {
		rmSync(lp, { force: true });
		removed.push("last_prompt.jsonl");
	}
	if (mode === "clear") {
		// log.jsonl 留著，但這段範圍不能再補同步回來
		if (existsSync(channelDir)) {
			const p = join(channelDir, CLEARED_MARKER);
			const prev = existsSync(p) ? readFileSync(p, "utf-8").trimEnd() : "";
			writeFileSync(p, `${prev ? `${prev}\n` : ""}${cutoffTs} ${commandTs}\n`);
		}
		return removed;
	}
	// clear-record：log.jsonl 刪掉範圍內的行，連同那些訊息的附件
	const lines = readLogLines(channelDir);
	const drop = lines.filter((l) => l.ts && tsLte(cutoffTs, l.ts));
	if (drop.length) {
		const keep = lines.filter((l) => !drop.includes(l));
		const logPath = join(channelDir, "log.jsonl");
		if (keep.length) writeFileSync(logPath, `${keep.map((l) => l.raw).join("\n")}\n`);
		else rmSync(logPath, { force: true });
		removed.push(`log.jsonl ${drop.length} 則`);
		// attachments 的 local 是相對於 working dir（頻道資料夾的上一層）
		const root = dirname(channelDir);
		let files = 0;
		for (const rel of drop.flatMap((l) => l.attachments)) {
			const f = join(root, rel);
			if (f.startsWith(join(channelDir, "attachments")) && existsSync(f)) {
				rmSync(f, { force: true });
				files++;
			}
		}
		if (files) removed.push(`attachments ${files} 個`);
	}
	return removed;
}

function clearAll(channelDir: string, mode: ClearMode, commandTs: string): string[] {
	const targets = mode === "clear" ? ["context.jsonl", "last_prompt.jsonl"] : ["context.jsonl", "last_prompt.jsonl", "log.jsonl", "attachments", CLEARED_MARKER];
	const removed: string[] = [];
	for (const name of targets) {
		const p = join(channelDir, name);
		if (existsSync(p)) {
			rmSync(p, { recursive: true, force: true });
			removed.push(name);
		}
	}
	// clear-record 把 log.jsonl 也刪了，不需要時間點；clear 要記下來擋住補同步（全清會蓋掉之前的範圍）
	if (mode === "clear" && existsSync(channelDir)) writeFileSync(join(channelDir, CLEARED_MARKER), `${commandTs}\n`);
	return removed;
}
