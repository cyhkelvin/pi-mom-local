// !clear-slack：指令解析、只收 bot 自己的訊息（含討論串回覆）、刪除順序、錯誤容忍。
// 對 build 後的 dist 測試：npm run build && node --test test/clear-slack.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseClearRequest } from "../dist/clear.js";
import { clearAskText, collectOwnMessages, deleteOwnMessages, nthNewestTs } from "../dist/slack-clear.js";

const ME = { userId: "UBOT", botId: "BBOT" };

test("clearAskText：說明附上可以直接複製的 confirm 指令", () => {
	assert.match(clearAskText(parseClearRequest("!clear-slack")), /`!clear-slack confirm`/);
	assert.match(clearAskText(parseClearRequest("!clear-all --last 30")), /最近 30 則[\s\S]*`!clear-all confirm --last 30`/);
	assert.match(clearAskText(parseClearRequest("!clear-all --since 2026-11-20")), /2026-11-20 00:00 以後[\s\S]*`!clear-all confirm --since 2026-11-20`/);
});

/** 假的 Slack：history 分兩頁，一個討論串 replies 也分兩頁。 */
function fakeClient({ failTs = new Set(), failFiles = new Set() } = {}) {
	const calls = [];
	const history = [
		[
			{ ts: "10.0", user: "UBOT", text: "最新：bot 的結果", files: [{ id: "F1", user: "UBOT" }] },
			{ ts: "9.0", user: "U1", text: "使用者的問題", reply_count: 3 },
			{ ts: "8.0", bot_id: "BOTHER", user: "UOTHER", text: "別的 bot" },
		],
		[
			{ ts: "7.0", user: "UBOT", text: "bot 的主訊息", reply_count: 1 },
			{ ts: "6.0", user: "UBOT", subtype: "tombstone" },
			{ ts: "5.0", bot_id: "BBOT", text: "沒有 user 欄位的 bot 訊息" },
			{ ts: "4.0", user: "U1", text: "使用者分享別人的圖", files: [{ id: "FU", user: "U1" }] },
		],
	];
	const replies = {
		"9.0": [
			[
				{ ts: "9.0", user: "U1", thread_ts: "9.0" },
				{ ts: "9.1", user: "UBOT", thread_ts: "9.0" },
			],
			[
				{ ts: "9.2", user: "U1", thread_ts: "9.0" },
				{ ts: "9.3", user: "UBOT", thread_ts: "9.0", files: [{ id: "F2", user: "UBOT" }, { id: "FX", user: "U1" }] },
			],
		],
		"7.0": [[{ ts: "7.0", user: "UBOT" }, { ts: "7.1", user: "UBOT", thread_ts: "7.0" }]],
	};
	const page = (pages, cursor) => {
		const i = cursor ? Number(cursor) : 0;
		return { messages: pages[i], response_metadata: { next_cursor: i + 1 < pages.length ? String(i + 1) : "" } };
	};
	const err = (code) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
	return {
		calls,
		conversations: {
			history: async ({ cursor, oldest }) => {
				const p = page(history, cursor);
				return oldest ? { ...p, messages: p.messages.filter((m) => Number(m.ts) >= Number(oldest)) } : p;
			},
			replies: async ({ ts, cursor }) => page(replies[ts], cursor),
		},
		chat: {
			delete: async ({ ts }) => {
				calls.push(`msg ${ts}`);
				if (failTs.has(ts)) throw err(failTs.get?.(ts) ?? "cant_delete_message");
			},
		},
		files: {
			delete: async ({ file }) => {
				calls.push(`file ${file}`);
				if (failFiles.has(file)) throw err("file_not_found");
			},
		},
	};
}

test("collectOwnMessages：只收 bot 的、跨頁、討論串回覆排在主訊息前", async () => {
	const c = fakeClient();
	const items = await collectOwnMessages(c, "C1", ME);
	assert.deepEqual(
		items.map((i) => i.ts),
		["10.0", "9.1", "9.3", "7.1", "7.0", "5.0"],
	);
	assert.deepEqual(items.find((i) => i.ts === "10.0").fileIds, ["F1"]);
	// 別人上傳的檔案不刪
	assert.deepEqual(items.find((i) => i.ts === "9.3").fileIds, ["F2"]);
});

test("deleteOwnMessages：先刪檔再刪訊息，回報進度", async () => {
	const c = fakeClient();
	const items = await collectOwnMessages(c, "C1", ME);
	const progress = [];
	const r = await deleteOwnMessages(c, "C1", items, (d, t) => progress.push(`${d}/${t}`));
	assert.deepEqual(r, { messages: 6, files: 2, failed: [] });
	assert.deepEqual(c.calls, ["file F1", "msg 10.0", "msg 9.1", "file F2", "msg 9.3", "msg 7.1", "msg 7.0", "msg 5.0"]);
	assert.equal(progress.at(-1), "6/6");
});

test("deleteOwnMessages：已經不在的不算失敗，其他錯誤記下來但不中斷", async () => {
	const failTs = new Map([
		["9.1", "message_not_found"],
		["7.0", "cant_delete_message"],
	]);
	const c = fakeClient({ failTs, failFiles: new Set(["F1"]) });
	const items = await collectOwnMessages(c, "C1", ME);
	const r = await deleteOwnMessages(c, "C1", items);
	assert.equal(r.messages, 4);
	assert.equal(r.files, 1);
	assert.deepEqual(r.failed, ["7.0: cant_delete_message"]);
	assert.ok(c.calls.includes("msg 5.0"), "錯誤之後還會繼續刪");
});

test("--since / --last：只收時間點以後的主訊息（含它們的討論串回覆）", async () => {
	const c = fakeClient();
	const items = await collectOwnMessages(c, "C1", ME, { oldest: "7.0" });
	assert.deepEqual(
		items.map((i) => i.ts),
		["10.0", "9.1", "9.3", "7.1", "7.0"],
	);
	// 從新到舊：10.0, 9.0, 8.0, 7.0 …；排除下指令的 10.0 後第 2 則是 8.0
	assert.equal(await nthNewestTs(c, "C1", 2, "10.0"), "8.0");
	assert.equal(await nthNewestTs(c, "C1", 4), "7.0"); // 跨頁
	assert.equal(await nthNewestTs(c, "C1", 99), "0.000000");
	// 清除指令和確認說明不算
	const noisy = fakeClient();
	const h = await noisy.conversations.history({});
	h.messages.unshift({ ts: "11.0", user: "U1", text: "!clear-all --last 2" }, { ts: "11.5", user: "UBOT", text: "_確定的話請回 `!clear-all confirm --last 2`。_" });
	noisy.conversations.history = async () => ({ messages: h.messages, response_metadata: { next_cursor: "" } });
	assert.equal(await nthNewestTs(noisy, "C1", 2, "12.0"), "9.0");
});
