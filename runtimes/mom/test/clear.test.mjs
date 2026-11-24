// /clear、/clear-record（issue #30）：指令解析、刪檔範圍、清除後不會被補同步回來。
// 對 build 後的 dist 測試：npm run build && node --test test/clear.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	CLEARED_MARKER,
	clearChannelFiles,
	cutoffFromLog,
	dateToTs,
	formatRangeArgs,
	parseClearRequest,
	truncateContext,
	tsLte,
} from "../dist/clear.js";
import { syncLogToSessionManager } from "../dist/context.js";

const root = mkdtempSync(join(tmpdir(), "mom-clear-"));
after(() => rmSync(root, { recursive: true, force: true }));

function channel(name) {
	const d = join(root, name);
	mkdirSync(join(d, "attachments"), { recursive: true });
	writeFileSync(join(d, "attachments", "a.png"), "x");
	writeFileSync(join(d, "context.jsonl"), "{}\n");
	writeFileSync(join(d, "last_prompt.jsonl"), "{}\n");
	writeFileSync(join(d, "MEMORY.md"), "notes\n");
	writeFileSync(
		join(d, "log.jsonl"),
		[
			{ date: "2026-11-20T09:00:00.000Z", ts: "1795165200.000100", user: "U1", userName: "k", text: "舊訊息：你無法產圖" },
			{ date: "2026-11-20T10:00:00.000Z", ts: "1795168800.000200", user: "U1", userName: "k", text: "/clear" },
			{ date: "2026-11-20T10:01:00.000Z", ts: "1795168860.000300", user: "U1", userName: "k", text: "清除後的新訊息" },
		]
			.map((l) => JSON.stringify(l))
			.join("\n") + "\n",
	);
	return d;
}

function fakeSession() {
	const appended = [];
	return { appended, getEntries: () => [], appendMessage: (m) => appended.push(m) };
}

const NOW = new Date(2026, 10, 23, 17, 0); // 本機時區 2026-11-23 17:00

test("指令解析：/ ! ！ 都可以，大小寫不拘，後面不能黏別的字", () => {
	const kind = (t) => parseClearRequest(t, NOW)?.kind ?? null;
	assert.equal(kind("/clear"), "clear");
	assert.equal(kind(" !CLEAR "), "clear");
	assert.equal(kind("！clear"), "clear");
	assert.equal(kind("/clear-record"), "clear-record");
	assert.equal(kind("!clear-record"), "clear-record");
	assert.equal(kind("!clear-slack"), "clear-slack");
	assert.equal(kind("/clear-all"), "clear-all");
	assert.equal(kind("please /clear"), null);
	assert.equal(kind("/clearance"), null);
	assert.equal(kind("!clear-slackx"), null);
	assert.equal(kind("/img cat"), null);
});

test("指令解析：confirm 和範圍參數", () => {
	const p = (t) => parseClearRequest(t, NOW);
	assert.deepEqual(p("!clear-all"), { kind: "clear-all", confirm: false, range: {} });
	assert.equal(p("!clear-slack confirm").confirm, true);
	assert.equal(p("!clear-slack 確認").confirm, true);
	assert.equal(p("!clear-all --last 100 confirm").range.last, 100);
	assert.equal(p("!clear-all confirm --last=5").range.last, 5);
	assert.equal(p("/clear --since 2026-11-20").range.since.getTime(), new Date(2026, 10, 20).getTime());
	assert.equal(p("/clear --since 2026/11/20 15:30").range.since.getTime(), new Date(2026, 10, 20, 15, 30).getTime());
	assert.equal(p("/clear-record --since 11-20").range.since.getTime(), new Date(2026, 10, 20).getTime());
	// 只寫月日、比現在晚 → 去年
	assert.equal(p("/clear --since 12-25").range.since.getTime(), new Date(2025, 11, 25).getTime());
	for (const bad of [
		"/clear all",
		"/clear --last",
		"/clear --last 0",
		"/clear --last abc",
		"/clear --since",
		"/clear --since 2026-02-30",
		"/clear --since 2026-11-30",
		"/clear --since 2026-11-20 --last 5",
		"!clear-slack now",
	]) {
		assert.match(p(bad).error ?? "", /用法/, bad);
	}
});

test("formatRangeArgs：組回可以複製的參數", () => {
	assert.equal(formatRangeArgs({}), "");
	assert.equal(formatRangeArgs({ last: 100 }), " --last 100");
	assert.equal(formatRangeArgs({ since: new Date(2026, 10, 20) }), " --since 2026-11-20");
	assert.equal(formatRangeArgs({ since: new Date(2026, 10, 20, 9, 5) }), " --since 2026-11-20 09:05");
});

test("Slack ts 比大小", () => {
	assert.ok(tsLte("1795165200.000100", "1795168800.000200"));
	assert.ok(tsLte("1795168800.000200", "1795168800.000200"));
	assert.ok(!tsLte("1795168800.000300", "1795168800.000200"));
	assert.ok(!tsLte("1795168801.000000", "1795168800.999999"));
});

test("/clear：刪 context，保留 log、附件、MEMORY.md，舊訊息不再補同步", () => {
	const d = channel("D1");
	const removed = clearChannelFiles(d, "clear", "1795168800.000200");
	assert.deepEqual(removed.sort(), ["context.jsonl", "last_prompt.jsonl"]);
	assert.ok(existsSync(join(d, "log.jsonl")));
	assert.ok(existsSync(join(d, "attachments", "a.png")));
	assert.ok(existsSync(join(d, "MEMORY.md")));
	assert.equal(readFileSync(join(d, CLEARED_MARKER), "utf-8").trim(), "1795168800.000200");

	const s = fakeSession();
	assert.equal(syncLogToSessionManager(s, d), 1);
	assert.match(s.appended[0].content[0].text, /清除後的新訊息/);
});

test("/clear-record：連 log、附件、last_prompt 都刪，MEMORY.md 保留", () => {
	const d = channel("D2");
	writeFileSync(join(d, CLEARED_MARKER), "1\n");
	const removed = clearChannelFiles(d, "clear-record", "1795168800.000200");
	assert.deepEqual(removed.sort(), [CLEARED_MARKER, "attachments", "context.jsonl", "last_prompt.jsonl", "log.jsonl"].sort());
	assert.ok(existsSync(join(d, "MEMORY.md")));
	assert.equal(syncLogToSessionManager(fakeSession(), d), 0);
});

test("只影響指定的頻道", () => {
	const a = channel("C_A");
	const b = channel("C_B");
	clearChannelFiles(a, "clear-record", "1795168800.000200");
	assert.ok(existsSync(join(b, "context.jsonl")));
	assert.ok(existsSync(join(b, "log.jsonl")));
	assert.ok(!existsSync(join(b, CLEARED_MARKER)));
});

// ---- 範圍清除（--since / --last）----

/** context.jsonl：session 標頭 + 依時間往後接的訊息 */
function writeContext(d, isoTimes) {
	const lines = [{ type: "session", version: 3, id: "s", timestamp: "2026-11-01T00:00:00.000Z" }];
	let parent = null;
	isoTimes.forEach((t, i) => {
		lines.push({ type: "message", id: `m${i}`, parentId: parent, timestamp: t, message: { role: i % 2 ? "assistant" : "user", content: [] } });
		parent = `m${i}`;
	});
	writeFileSync(join(d, "context.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const ctxIds = (d) =>
	readFileSync(join(d, "context.jsonl"), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l).id);
const logTs = (d) =>
	existsSync(join(d, "log.jsonl"))
		? readFileSync(join(d, "log.jsonl"), "utf-8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l).ts)
		: [];

test("truncateContext：從第一筆 >= 時間點的地方截掉；全部截光就刪檔", () => {
	const d = channel("R1");
	writeContext(d, ["2026-11-20T09:00:00.000Z", "2026-11-20T09:00:05.000Z", "2026-11-20T10:00:00.000Z", "2026-11-20T10:00:09.000Z"]);
	// 1795168800 = 2026-11-20T10:00:00Z
	assert.equal(truncateContext(d, "1795168800.000000"), 2);
	assert.deepEqual(ctxIds(d), ["s", "m0", "m1"]);
	assert.equal(truncateContext(d, "1795168800.000000"), 0);
	assert.equal(truncateContext(d, "0.000000"), 2);
	assert.ok(!existsSync(join(d, "context.jsonl")));
});

test("/clear --since：截掉記憶尾巴，log 保留，範圍內的訊息不再補同步，範圍外的照常", () => {
	const d = channel("R2");
	writeContext(d, ["2026-11-20T09:00:00.000Z", "2026-11-20T10:00:01.000Z"]);
	const cutoff = "1795168800.000200"; // 第二則（/clear）的時間
	clearChannelFiles(d, "clear", "1795168900.000000", cutoff);
	assert.deepEqual(ctxIds(d), ["s", "m0"]);
	assert.deepEqual(logTs(d).length, 3);
	assert.equal(readFileSync(join(d, CLEARED_MARKER), "utf-8").trim(), `${cutoff} 1795168900.000000`);
	const s = fakeSession();
	// 舊訊息（範圍外）會補回來；範圍內的兩則不會
	assert.equal(syncLogToSessionManager(s, d), 1);
	assert.match(s.appended[0].content[0].text, /舊訊息/);
});

test("/clear 範圍可以疊加，全清會蓋掉", () => {
	const d = channel("R3");
	writeFileSync(join(d, CLEARED_MARKER), "1795165200.000100\n");
	clearChannelFiles(d, "clear", "1795168900.000000", "1795168860.000300");
	assert.equal(syncLogToSessionManager(fakeSession(), d), 1); // 只剩 /clear 那則
	clearChannelFiles(d, "clear", "1795169000.000000");
	assert.equal(readFileSync(join(d, CLEARED_MARKER), "utf-8").trim(), "1795169000.000000");
});

test("/clear-record --last：刪 log 尾巴和那些訊息的附件，前面的保留", () => {
	const d = channel("R4");
	const lines = readFileSync(join(d, "log.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
	lines[2].attachments = [{ original: "b.png", local: "R4/attachments/b.png" }];
	lines[0].attachments = [{ original: "a.png", local: "R4/attachments/a.png" }];
	writeFileSync(join(d, "attachments", "b.png"), "y");
	writeFileSync(join(d, "log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	writeContext(d, ["2026-11-20T09:00:00.000Z", "2026-11-20T10:00:30.000Z"]);

	// 下指令那則不算：最近 2 則 = 第 2、3 則（第 2 則是 "/clear"，雖然是清除指令但這裡測的是 ts 換算，先換成一般文字）
	lines[1].text = "一般訊息";
	writeFileSync(join(d, "log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	const cmdTs = "1795169000.000000";
	const cutoff = cutoffFromLog(d, 2, cmdTs);
	assert.equal(cutoff, "1795168800.000200");
	const removed = clearChannelFiles(d, "clear-record", cmdTs, cutoff);
	assert.deepEqual(logTs(d), ["1795165200.000100"]);
	assert.ok(existsSync(join(d, "attachments", "a.png")));
	assert.ok(!existsSync(join(d, "attachments", "b.png")));
	assert.deepEqual(ctxIds(d), ["s", "m0"]);
	assert.ok(existsSync(join(d, "MEMORY.md")));
	assert.ok(removed.some((r) => r.startsWith("log.jsonl 2")));
	// 超過總數 = 全部
	assert.equal(cutoffFromLog(d, 50), "0.000000");
	// 清除指令不算在 N 裡
	const e = channel("R5"); // log：舊訊息、/clear、新訊息
	assert.equal(cutoffFromLog(e, 2), "1795165200.000100");
});

test("dateToTs", () => {
	assert.equal(dateToTs(new Date("2026-11-20T10:00:00.900Z")), "1795168800.000000");
});
