// 補同步（log.jsonl → context）的訊息要帶時間戳，且不能重複加入。
// 對 build 後的 dist 測試：npm run build && node --test test/context-sync.test.mjs
// 預期值都以 Asia/Taipei 寫成，時區在下面固定，不依賴執行環境。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { syncLogToSessionManager } from "../dist/context.js";
import { formatMessageTimestamp, stripMessageTimestamp } from "../dist/time.js";

// 固定時區。ES module 的 import 一律先執行，但被測的函式都在測試執行時才讀時區，
// 而 Node 在執行中改 TZ 會立刻生效，所以在這裡設定就夠了。
process.env.TZ = "Asia/Taipei";

let dir;
before(() => {
	dir = mkdtempSync(join(tmpdir(), "mom-ctx-sync-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function fakeSession(userTexts) {
	const appended = [];
	const entries = userTexts.map((text) => ({ type: "message", message: { role: "user", content: text } }));
	return {
		appended,
		getEntries: () => entries,
		appendMessage: (m) => appended.push(m),
	};
}

function writeLog(lines) {
	writeFileSync(join(dir, "log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("補同步的訊息帶本地時區時間戳，格式和即時訊息相同", () => {
	writeLog([{ date: "2026-11-19T06:47:44.811Z", ts: "1", user: "U1", userName: "kelvin", text: "今天台北下午天氣如何" }]);
	const s = fakeSession([]);
	assert.equal(syncLogToSessionManager(s, dir), 1);
	assert.equal(s.appended[0].content[0].text, "[2026-11-19 14:47:44+08:00 Thu 週四] [kelvin]: 今天台北下午天氣如何");
	assert.equal(s.appended[0].timestamp, Date.parse("2026-11-19T06:47:44.811Z"));
});

test("已在 context 的訊息不重複加入：新格式時間戳、舊格式時間戳、沒有時間戳、陣列格式都算", () => {
	writeLog([
		{ date: "2026-11-17T15:17:04Z", ts: "1", userName: "kelvin", text: "即時訊息" },
		{ date: "2026-11-19T06:47:44Z", ts: "2", userName: "kelvin", text: "舊的補同步訊息" },
		{ date: "2026-11-19T06:48:00Z", ts: "2b", userName: "kelvin", text: "舊格式時間戳" },
		{ date: "2026-11-19T06:50:00Z", ts: "3", userName: "kelvin", text: "新訊息" },
		{ date: "2026-11-19T06:51:00Z", ts: "4", userName: "mom", text: "bot 回覆", isBot: true },
		{ date: "2026-11-19T07:27:01Z", ts: "5", userName: "kelvin", text: "正在處理的訊息" },
	]);
	const s = fakeSession([
		"[2026-11-17 23:17:04+08:00 Tue 週二] [kelvin]: 即時訊息",
		[{ type: "text", text: "[kelvin]: 舊的補同步訊息" }],
		"[2026-11-19 14:48:00+08:00] [kelvin]: 舊格式時間戳",
	]);
	assert.equal(syncLogToSessionManager(s, dir, "5"), 1);
	assert.equal(s.appended[0].content[0].text, "[2026-11-19 14:50:00+08:00 Thu 週四] [kelvin]: 新訊息");
});

test("剛補同步過的訊息，下一輪不會再加入一次", () => {
	writeLog([{ date: "2026-11-19T06:50:00Z", ts: "3", userName: "kelvin", text: "新訊息" }]);
	const first = fakeSession([]);
	syncLogToSessionManager(first, dir);
	const second = fakeSession([first.appended[0].content]);
	assert.equal(syncLogToSessionManager(second, dir), 0);
});

test("時間格式函式", () => {
	const d = new Date("2026-11-20T02:15:09Z");
	assert.equal(formatMessageTimestamp(d), "2026-11-20 10:15:09+08:00 Fri 週五");
	assert.equal(formatMessageTimestamp(new Date("2026-11-21T16:00:00Z")), "2026-11-22 00:00:00+08:00 Sun 週日");
	assert.equal(stripMessageTimestamp("[2026-11-20 10:15:09+08:00 Fri 週五] [kelvin]: hi"), "[kelvin]: hi");
	assert.equal(stripMessageTimestamp("[2026-11-20 10:15:09+08:00] [kelvin]: hi"), "[kelvin]: hi");
	assert.equal(stripMessageTimestamp("[kelvin]: hi"), "[kelvin]: hi");
});

test("訊息結尾帶產圖提醒（N6）時，補同步不會把同一則訊息重複加入", async () => {
	const { IMAGE_TURN_HINT } = await import("../dist/turn-hint.js");
	writeLog([{ date: "2026-11-20T11:00:00.000Z", ts: "9", user: "U1", userName: "kelvin", text: "畫一張咖啡廳" }]);
	const live = `[${formatMessageTimestamp(new Date("2026-11-20T11:00:00.000Z"))}] [kelvin]: 畫一張咖啡廳${IMAGE_TURN_HINT}`;
	const s = fakeSession([live]);
	assert.equal(syncLogToSessionManager(s, dir), 0);
});
