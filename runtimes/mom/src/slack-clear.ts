/**
 * !clear-slack（issue #32）、!clear-all：刪掉這個頻道裡 bot 自己在 Slack 上發過的訊息和上傳的檔案。
 *
 * /clear、/clear-record 只清本機檔案，Slack 畫面上的訊息還在。這個指令補上 Slack 那一側。
 * - 只刪 bot 自己的：Slack 不允許 bot token 刪別人的訊息，使用者自己的訊息要自己刪。
 * - 包括討論串裡的回覆；先刪回覆再刪主訊息，避免留下「此訊息已刪除」的空殼。
 * - bot 上傳的圖片用 files.delete 刪掉檔案本身，不只是訊息。
 * - 刪了就救不回來，所以要先打 `!clear-slack`，看說明後再打 `!clear-slack confirm`。
 * - 可以加範圍（--since、--last，見 clear.ts），只刪那個時間點以後的。
 * - 速率限制（chat.delete 約每分鐘 50 次）交給 @slack/web-api 內建的 429 重試處理。
 */

import { type ClearRequest, describeRange, formatRangeArgs, isClearNoise } from "./clear.js";

/** !clear-slack、!clear-all 沒加 confirm 時的說明，附上可以直接複製的 confirm 指令。 */
export function clearAskText(req: ClearRequest): string {
	const scope = describeRange(req.range);
	const confirmCmd = `!${req.kind} confirm${formatRangeArgs(req.range)}`;
	const own = "你自己的訊息不會被刪（Slack 不允許 bot 刪別人的訊息，請自己刪）。";
	if (req.kind === "clear-all") {
		return (
			`_這會清掉這個頻道${scope}紀錄：先刪掉 bot 在 Slack 上發過的訊息（含討論串回覆和 bot 上傳的圖片），` +
			`再清除同範圍的對話記憶和本機紀錄（log.jsonl、附件），等同 \`!clear-slack confirm\` 加上 \`/clear-record\`。` +
			`刪了就無法復原。MEMORY.md 保留；${own}_\n_確定的話請回 \`${confirmCmd}\`。_`
		);
	}
	return (
		`_這會刪掉這個頻道裡 bot 在 Slack 上發過的${scope}訊息，包括討論串裡的回覆和 bot 上傳的圖片。刪了就無法復原。${own}_\n` +
		`_確定的話請回 \`${confirmCmd}\`。本機紀錄另外用 \`/clear-record\` 清除，或用 \`!clear-all\` 一次清完。_`
	);
}

/** 用到的 Slack Web API 子集；正式環境傳 WebClient，測試傳假的。 */
export interface ClearSlackClient {
	conversations: {
		history(args: { channel: string; cursor?: string; limit?: number; oldest?: string; inclusive?: boolean }): Promise<HistoryPage>;
		replies(args: { channel: string; ts: string; cursor?: string; limit?: number }): Promise<HistoryPage>;
	};
	chat: { delete(args: { channel: string; ts: string }): Promise<unknown> };
	files: { delete(args: { file: string }): Promise<unknown> };
}

interface SlackMsg {
	ts?: string;
	text?: string;
	thread_ts?: string;
	user?: string;
	bot_id?: string;
	subtype?: string;
	reply_count?: number;
	files?: Array<{ id?: string; user?: string }>;
}

interface HistoryPage {
	messages?: SlackMsg[];
	response_metadata?: { next_cursor?: string };
}

export interface OwnMessage {
	ts: string;
	/** 這則訊息附帶、而且是 bot 上傳的檔案 */
	fileIds: string[];
}

export interface BotIdentity {
	userId: string;
	botId?: string;
}

function isOwn(m: SlackMsg, me: BotIdentity): boolean {
	if (!m.ts || m.subtype === "tombstone") return false;
	return m.user === me.userId || (!!me.botId && m.bot_id === me.botId);
}

function ownFiles(m: SlackMsg, me: BotIdentity): string[] {
	return (m.files ?? []).filter((f) => f.id && (!f.user || f.user === me.userId)).map((f) => f.id!);
}

async function pages(fetchPage: (cursor?: string) => Promise<HistoryPage>): Promise<SlackMsg[]> {
	const all: SlackMsg[] = [];
	let cursor: string | undefined;
	do {
		const page = await fetchPage(cursor);
		all.push(...(page.messages ?? []));
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return all;
}

/**
 * 找出頻道裡 bot 自己的訊息，依刪除順序排好：每個討論串的回覆在主訊息之前。
 * 使用者發的主訊息底下有 bot 的回覆時，只收回覆。
 * @param opts.oldest 只看這個 ts（含）以後的主訊息；討論串回覆跟著主訊息走
 */
export async function collectOwnMessages(
	client: ClearSlackClient,
	channel: string,
	me: BotIdentity,
	opts: { oldest?: string } = {},
): Promise<OwnMessage[]> {
	const range = opts.oldest ? { oldest: opts.oldest, inclusive: true } : {};
	const top = await pages((cursor) => client.conversations.history({ channel, cursor, limit: 200, ...range }));
	const out: OwnMessage[] = [];
	for (const m of top) {
		if (!m.ts) continue;
		if (m.reply_count && m.reply_count > 0) {
			const replies = await pages((cursor) => client.conversations.replies({ channel, ts: m.ts!, cursor, limit: 200 }));
			for (const r of replies) {
				if (r.ts === m.ts) continue; // replies 第一筆是主訊息本身
				if (isOwn(r, me)) out.push({ ts: r.ts!, fileIds: ownFiles(r, me) });
			}
		}
		if (isOwn(m, me)) out.push({ ts: m.ts, fileIds: ownFiles(m, me) });
	}
	return out;
}

/**
 * `--last N` 在 Slack 上的換算：頻道主畫面從新到舊數第 N 則的 ts（不算下指令那則，也不算清除指令和確認說明）。
 * 不到 N 則回傳 "0.000000"，也就是全部。討論串回覆不算在 N 裡，會跟著主訊息一起刪。
 */
export async function nthNewestTs(client: ClearSlackClient, channel: string, n: number, excludeTs?: string): Promise<string> {
	let seen = 0;
	let cursor: string | undefined;
	do {
		const page = await client.conversations.history({ channel, cursor, limit: 200 });
		for (const m of page.messages ?? []) {
			if (!m.ts || m.ts === excludeTs || isClearNoise(m.text)) continue;
			if (++seen === n) return m.ts;
		}
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return "0.000000";
}

export interface ClearSlackResult {
	messages: number;
	files: number;
	failed: string[];
}

function slackError(err: unknown): string {
	const e = err as { data?: { error?: string }; message?: string };
	return e?.data?.error ?? e?.message ?? String(err);
}

const FILE_GONE = new Set(["file_not_found", "file_deleted"]);

export async function deleteOwnMessages(
	client: ClearSlackClient,
	channel: string,
	items: OwnMessage[],
	onProgress?: (done: number, total: number) => void,
): Promise<ClearSlackResult> {
	const res: ClearSlackResult = { messages: 0, files: 0, failed: [] };
	let done = 0;
	for (const it of items) {
		for (const file of it.fileIds) {
			try {
				await client.files.delete({ file });
				res.files++;
			} catch (err) {
				const code = slackError(err);
				if (!FILE_GONE.has(code)) res.failed.push(`file ${file}: ${code}`);
			}
		}
		try {
			await client.chat.delete({ channel, ts: it.ts });
			res.messages++;
		} catch (err) {
			const code = slackError(err);
			// 只有檔案的訊息，刪掉檔案時 Slack 可能已經一起收掉了
			if (code !== "message_not_found") res.failed.push(`${it.ts}: ${code}`);
		}
		done++;
		onProgress?.(done, items.length);
	}
	return res;
}
