import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { Executor } from "../sandbox.js";

/**
 * `search` 與 `fetch`：把兩個 skill 升級成真正的工具。
 *
 * 為什麼要這樣做（TASK-048）：2026-09-15 本地模型 gemma4 連續兩次
 * 對「查一下 morrison」這種要求發出 `toolName: "search"` 的呼叫，
 * 得到 `Tool search not found`——因為 skill 只是系統提示裡的一段 XML，
 * 不是註冊過的工具。同一份 log 裡它對 bash／write 8 次呼叫沒有一次叫錯，
 * **問題不在它不會用工具，而在 skill 那條路要它多做兩層翻譯**
 * （讀 SKILL.md → 自己組 shell 指令）。註冊成工具就把翻譯層拿掉了。
 *
 * 實作刻意「薄」：真正的邏輯還是那兩支 .sh，工具只是入口。
 * 這樣 tests/skills_test.sh 的 31 項不必重寫，host／docker 兩種
 * sandbox 的行為也自動一致。
 */

const SKILL_DIR = "/workspace/skills";

/**
 * 把字串包成單引號的 shell 參數。
 *
 * ⚠ 這個一定要有：DockerExecutor.exec() 是 `docker exec <c> sh -c '<cmd>'`，
 * 它只 escape 最外層一次。query 來自模型，含單引號時會把指令切斷——
 * 輕則語法錯誤，重則變成任意指令注入。
 */
function shq(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 跑 skill 腳本，把結果整理成模型看得懂的內容。
 *
 * 失敗時**不丟例外**，而是回傳一段帶指示的文字。理由：同一天的 log 顯示
 * 這個模型拿到 isError 的結果會自己編一套業務解釋講給使用者聽
 * （把 "Tool search not found" 說成「找不到包含所有要求的網路來源」）。
 * 與其讓它面對一個裸的錯誤，不如把「請原文轉達、不要自己解釋」直接寫進結果裡。
 */
async function runSkill(
	executor: Executor,
	script: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	const cmd = `sh ${SKILL_DIR}/${script} ${args.map(shq).join(" ")}`;
	const r = await executor.exec(cmd, { signal });
	const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();

	if (r.code !== 0) {
		return {
			content: [
				{
					type: "text",
					text:
						`⚠ 這次沒有執行成功，下面是原始錯誤訊息：\n\n${out || "(沒有輸出)"}\n\n` +
						`把上面的訊息原文轉達給使用者。不要猜測原因，` +
						`不要把它說成「查不到結果」或「資料太分散」——那是不同的事。`,
				},
			],
			details: undefined,
		};
	}
	return { content: [{ type: "text", text: out || "(沒有輸出)" }], details: undefined };
}

const searchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for (shown to user)" }),
	query: Type.String({ description: "Search keywords. One topic per call — do not combine several questions." }),
});

export function createSearchTool(executor: Executor): AgentTool<typeof searchSchema> {
	return {
		name: "search",
		label: "search",
		description:
			"Search the web and get back up to 5 results (title, URL, one-line summary). " +
			"Use this whenever you do not already know the answer, do not know the right URL, " +
			"or need to verify a fact. Results are only leads: to know what a page actually says, " +
			"call `fetch` on its URL afterwards. Search one topic per call — if the user asks about " +
			"several aspects, make several calls rather than combining them into one query. " +
			"Always cite the source URL in your answer.",
		parameters: searchSchema,
		execute: async (_id: string, { query }: { label: string; query: string }, signal?: AbortSignal) =>
			runSkill(executor, "search/search.sh", [query], signal),
	};
}

const fetchSchema = Type.Object({
	label: Type.String({ description: "Brief description of why you're reading this page (shown to user)" }),
	url: Type.String({ description: "Full http:// or https:// URL of the page to read" }),
});

export function createFetchTool(executor: Executor): AgentTool<typeof fetchSchema> {
	return {
		name: "fetch",
		label: "fetch",
		description:
			"Read a web page and get it back as plain text, with layout and links stripped. " +
			"Use this after `search` to read what a page actually says. Output is capped at " +
			"12000 bytes; if it is truncated, do NOT fetch the same URL again — the result will be " +
			"identical. Cannot read PDFs, images, or pages that require login. " +
			"Always cite the source URL in your answer.",
		parameters: fetchSchema,
		execute: async (_id: string, { url }: { label: string; url: string }, signal?: AbortSignal) =>
			runSkill(executor, "fetch/fetch.sh", [url], signal),
	};
}
