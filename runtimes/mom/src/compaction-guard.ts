/**
 * 避免空摘要，並清掉已經產生的空摘要。
 *
 * 2026-11-20 的狀況：pi-coding-agent 預設 keepRecentTokens（20000）大於觸發門檻
 * （32768 − reserveTokens 16384 = 16384）。對話在 16k–20k token 之間時，每一輪都會觸發
 * compaction，但切點永遠落在第一則，沒有任何訊息被摘要，模型就寫出
 * 「No conversation history … contain no text」這種空摘要。一個下午 3 次，每次 1–5 分鐘。
 *
 * 兩層處理：
 * 1. compactionGuardExtension：在 session_before_compact 檢查要摘要的訊息，空的就取消。
 *    從源頭不產生空摘要，也不佔用 GPU。
 * 2. dropEmptyCompactions：在 SessionManager 開啟 context.jsonl 之前，移除已經存在的空摘要，
 *    並把它的下一筆接回上一筆。拿掉 compaction entry 只會讓被它遮住的訊息重新出現，不會遺失對話。
 *    不能在執行中改：SessionManager 把 entry 留在記憶體裡，改檔案會讓兩邊不一致。
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Extension } from "@mariozechner/pi-coding-agent";
import { createSyntheticSourceInfo } from "@mariozechner/pi-coding-agent";

/** 模型在沒有內容可以摘要時寫的句子 */
const EMPTY_SUMMARY_PATTERNS = [
	/no conversation history/i,
	/contain(?:s|ed)? no text/i,
	/conversation (?:history )?(?:was|is) empty/i,
];

export function looksLikeEmptySummary(summary: string): boolean {
	return EMPTY_SUMMARY_PATTERNS.some((p) => p.test(summary));
}

interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
	summary?: string;
	firstKeptEntryId?: string;
	[key: string]: unknown;
}

/**
 * 從 context.jsonl 的文字中移除空摘要，回傳新的文字與移除的 entry id。
 * 判斷空摘要（任一成立）：
 *   - 從上一個有效切點（或開頭）到這次的 firstKeptEntryId 之間沒有任何 message，也就是什麼都沒切到
 *   - 摘要文字符合 EMPTY_SUMMARY_PATTERNS
 */
export function dropEmptyCompactionsFromJsonl(jsonl: string): { text: string; removed: string[] } {
	const lines = jsonl.split("\n").filter((l) => l.trim());
	const entries: Entry[] = lines.map((l) => JSON.parse(l));
	const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id as string, e]));

	// 依檔案順序走一遍（mom 的 context 是一條直線）；記住上一個有效切點的位置
	const indexOf = new Map(entries.map((e, i) => [e.id, i]));
	const removed = new Set<string>();
	let prevCutIndex = 0;
	for (const e of entries) {
		if (e.type !== "compaction" || !e.id) continue;
		const keptIndex = e.firstKeptEntryId ? (indexOf.get(e.firstKeptEntryId) ?? -1) : -1;
		const cutSomething =
			keptIndex > prevCutIndex &&
			entries.slice(prevCutIndex, keptIndex).some((x) => x.type === "message" && x.id !== undefined);
		if (!cutSomething || looksLikeEmptySummary(e.summary ?? "")) {
			removed.add(e.id);
		} else {
			prevCutIndex = keptIndex;
		}
	}
	if (removed.size === 0) return { text: jsonl, removed: [] };

	// 被移除的 entry 的下一筆，接回最近一個沒被移除的上層
	const resolveParent = (pid: string | null | undefined): string | null | undefined => {
		let cur = pid;
		while (cur && removed.has(cur)) cur = byId.get(cur)?.parentId;
		return cur;
	};
	const kept = entries
		.filter((e) => !(e.id && removed.has(e.id)))
		.map((e) => (e.parentId && removed.has(e.parentId) ? { ...e, parentId: resolveParent(e.parentId) ?? null } : e));
	return { text: `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`, removed: [...removed] };
}

/** 在 SessionManager.open 之前呼叫。回傳移除的筆數。 */
export function dropEmptyCompactions(contextFile: string): number {
	if (!existsSync(contextFile)) return 0;
	const original = readFileSync(contextFile, "utf-8");
	const { text, removed } = dropEmptyCompactionsFromJsonl(original);
	if (removed.length > 0) writeFileSync(contextFile, text, "utf-8");
	return removed.length;
}

/**
 * 取消「沒有任何訊息可以摘要」的 compaction。
 * onSkip 用來寫 log（由呼叫端決定 log 的格式與頻道）。
 */
export function compactionGuardExtension(onSkip: (reason: string) => void): Extension {
	const handler = async (event: unknown) => {
		const prep = (event as { preparation?: { messagesToSummarize?: unknown[]; turnPrefixMessages?: unknown[] } })
			.preparation;
		const n = (prep?.messagesToSummarize?.length ?? 0) + (prep?.turnPrefixMessages?.length ?? 0);
		if (n === 0) {
			onSkip("沒有可以摘要的訊息（keepRecentTokens 涵蓋了整段對話）");
			return { cancel: true };
		}
		return undefined;
	};
	const path = "<mom:compaction-guard>";
	return {
		path,
		resolvedPath: path,
		sourceInfo: createSyntheticSourceInfo(path, { source: "mom" }),
		handlers: new Map([["session_before_compact", [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Extension;
}
