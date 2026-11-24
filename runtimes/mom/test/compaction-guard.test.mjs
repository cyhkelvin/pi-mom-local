// 空摘要的預防與清除。對 build 後的 dist 測試：npm run build && node --test test/compaction-guard.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
	compactionGuardExtension,
	dropEmptyCompactions,
	dropEmptyCompactionsFromJsonl,
	looksLikeEmptySummary,
} from "../dist/compaction-guard.js";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const EMPTY = "## Goal\n- (none) - No conversation history or specific task provided in the input.";
const ts = "2026-11-20T09:00:00.000Z";
const header = { type: "session", version: 3, id: "sess-1", timestamp: ts, cwd: "/tmp" };
const msg = (id, parentId, role, text) => ({
	type: "message",
	id,
	parentId,
	timestamp: ts,
	message: role === "user" ? { role, content: [{ type: "text", text }], timestamp: 0 } : {
		role, content: [{ type: "text", text }], api: "openai-completions", provider: "ollama", model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 0,
	},
});
const comp = (id, parentId, firstKeptEntryId, summary) => ({
	type: "compaction", id, parentId, timestamp: ts, summary, firstKeptEntryId, tokensBefore: 17000,
});
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const parse = (text) => text.trim().split("\n").map((l) => JSON.parse(l));

test("和 11/20 實際狀況相同：三筆空摘要都指向第一則 → 全部移除，下一筆接回上一筆", () => {
	const rows = [
		header,
		msg("m1", null, "user", "q1"), msg("m2", "m1", "assistant", "a1"),
		comp("c1", "m2", "m1", EMPTY),
		msg("m3", "c1", "user", "q2"), msg("m4", "m3", "assistant", "a2"),
		comp("c2", "m4", "m1", EMPTY),
		msg("m5", "c2", "user", "q3"), msg("m6", "m5", "assistant", "a3"),
		comp("c3", "m6", "m1", EMPTY),
	];
	const { text, removed } = dropEmptyCompactionsFromJsonl(jsonl(rows));
	assert.deepEqual(removed, ["c1", "c2", "c3"]);
	const out = parse(text);
	assert.equal(out.length, 7);
	assert.equal(out.find((e) => e.id === "m3").parentId, "m2");
	assert.equal(out.find((e) => e.id === "m5").parentId, "m4");
});

test("有切到訊息的正常摘要保留；之後沒有切到新東西的那筆移除", () => {
	const rows = [
		header,
		msg("m1", null, "user", "q1"), msg("m2", "m1", "assistant", "a1"),
		msg("m3", "m2", "user", "q2"), msg("m4", "m3", "assistant", "a2"),
		comp("c1", "m4", "m3", "## Goal\n- 使用者想知道台北天氣"),
		msg("m5", "c1", "user", "q3"),
		comp("c2", "m5", "m3", "## Goal\n- 使用者想知道台北天氣"),
		msg("m6", "c2", "assistant", "a3"),
	];
	const { text, removed } = dropEmptyCompactionsFromJsonl(jsonl(rows));
	assert.deepEqual(removed, ["c2"]);
	assert.equal(parse(text).find((e) => e.id === "m6").parentId, "m5");
});

test("有切到訊息、但摘要文字是空的 → 也移除（被遮住的訊息會重新出現，不會遺失）", () => {
	const rows = [
		header,
		msg("m1", null, "user", "q1"), msg("m2", "m1", "assistant", "a1"),
		msg("m3", "m2", "user", "q2"),
		comp("c1", "m3", "m3", "The <conversation> tags contain no text."),
		msg("m4", "c1", "assistant", "a2"),
	];
	assert.deepEqual(dropEmptyCompactionsFromJsonl(jsonl(rows)).removed, ["c1"]);
});

test("沒有空摘要時，檔案內容一個字都不動", () => {
	const text = jsonl([header, msg("m1", null, "user", "q1"), msg("m2", "m1", "assistant", "a1")]);
	const r = dropEmptyCompactionsFromJsonl(text);
	assert.deepEqual(r.removed, []);
	assert.equal(r.text, text);
});

test("清理後用 SessionManager 開啟：對話一則都沒少，也沒有空摘要", () => {
	const dir = mkdtempSync(join(tmpdir(), "mom-compaction-"));
	dirs.push(dir);
	const file = join(dir, "context.jsonl");
	writeFileSync(file, jsonl([
		header,
		msg("m1", null, "user", "q1"), msg("m2", "m1", "assistant", "a1"),
		comp("c1", "m2", "m1", EMPTY),
		msg("m3", "c1", "user", "q2"), msg("m4", "m3", "assistant", "a2"),
	]));
	assert.equal(dropEmptyCompactions(file), 1);
	assert.equal(dropEmptyCompactions(file), 0, "第二次執行不應再有變動");
	const ctx = SessionManager.open(file, dir).buildSessionContext();
	const texts = ctx.messages.map((m) => m.content?.[0]?.text);
	assert.deepEqual(texts, ["q1", "a1", "q2", "a2"]);
	assert.ok(!readFileSync(file, "utf-8").includes("No conversation history"));
});

test("guard：沒有可摘要的訊息時取消 compaction，有的時候放行", async () => {
	const skipped = [];
	const ext = compactionGuardExtension((r) => skipped.push(r));
	const [handler] = ext.handlers.get("session_before_compact");
	assert.deepEqual(await handler({ preparation: { messagesToSummarize: [], turnPrefixMessages: [] } }), { cancel: true });
	assert.equal(skipped.length, 1);
	assert.equal(await handler({ preparation: { messagesToSummarize: [{}], turnPrefixMessages: [] } }), undefined);
	assert.equal(await handler({ preparation: { messagesToSummarize: [], turnPrefixMessages: [{}] } }), undefined);
	assert.equal(skipped.length, 1);
});

test("空摘要的文字判斷", () => {
	assert.ok(looksLikeEmptySummary(EMPTY));
	assert.ok(looksLikeEmptySummary("Conversation history provided was empty (`<conversation>` tags contain no text)."));
	assert.ok(!looksLikeEmptySummary("## Goal\n- 使用者想產生一張台北夜景的圖"));
});
