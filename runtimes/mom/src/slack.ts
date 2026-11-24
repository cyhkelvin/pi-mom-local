import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { type ClearSlackClient, type ClearSlackResult, collectOwnMessages, deleteOwnMessages, nthNewestTs, type OwnMessage } from "./slack-clear.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import { markdownToMrkdwn } from "./mrkdwn.js";
import type { Attachment, ChannelStore } from "./store.js";
import type { SlackFileInfo } from "./slack-image.js";

// ============================================================================
// Types
// ============================================================================

export interface SlackEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	/** Slack 原始的檔案物件；!edit 會用到 mimetype、thumb_1024 等欄位（見 slack-image.ts）。 */
	files?: SlackFileInfo[];
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
}

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

// Types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface MomHandler {
	/**
	 * Check if channel is currently running (SYNC)
	 */
	isRunning(channelId: string): boolean;

	/**
	 * Handle an event that triggers mom (ASYNC)
	 * Called only when isRunning() returned false for user messages.
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 * Called when user says "stop" while mom is running
	 */
	handleStop(channelId: string, slack: SlackBot): Promise<void>;

	/**
	 * pi-mom-local：產圖相關的攔截（SYNC）。在 stop／忙碌判斷之前呼叫。
	 * 處理 `!img` 指令，以及產圖期間的所有訊息（回進度、stop／取消、等待）。
	 * 回傳 true 表示訊息已經處理完，不要再交給 agent。
	 */
	intercept?(event: SlackEvent, slack: SlackBot): boolean;
	/** 使用者訊息通過檢查、即將排進頻道佇列時呼叫（產圖要等這些已收下的訊息先回完）。 */
	accepted?(event: SlackEvent): void;
	/** 每則收到的訊息（含頻道裡沒 @ bot 的）都會通知一次，例如記下頻道最近一張圖給 !edit 用。 */
	observe?(event: SlackEvent): void;
	/** 回傳 Promise 時，排程事件要等它 resolve 才排進佇列（產圖期間用）。 */
	eventGate?(): Promise<void> | null;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot {
	private socketClient: SocketModeClient;
	private reconnectDeadline: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private webClient: WebClient;
	private handler: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private botId: string | undefined;
	private startupTs: string | null = null; // Messages older than this are just logged, not processed

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();

	constructor(
		handler: MomHandler,
		config: { appToken: string; botToken: string; workingDir: string; store: ChannelStore },
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		// MOM_SOCKET_DEBUG=1 才開心跳細節：ping 每 5 秒一次，平常開著只會把 log 洗掉
		const socketDebug = process.env.MOM_SOCKET_DEBUG === "1";
		this.socketClient = new SocketModeClient({
			appToken: config.appToken,
			pingPongLoggingEnabled: socketDebug,
			...(socketDebug ? { logLevel: LogLevel.DEBUG } : {}),
		});
		this.webClient = new WebClient(config.botToken);
		this.watchConnection();
	}

	/**
	 * 死線：時間到還沒連上就結束 process，讓「process 活著」重新等於「連線是好的」。
	 * 重啟交給 launchd KeepAlive，這裡只負責結束。
	 *
	 * 同一個欄位管兩種死線，因為兩者不會同時需要：要嘛還沒連上，要嘛連上後斷了。
	 * 已經 arm 的不再重 arm——先按下的那一刻才是斷線的起點。
	 */
	private armDeadline(ms: number, what: string): void {
		if (this.reconnectDeadline || ms <= 0) return;
		this.reconnectDeadline = setTimeout(() => {
			// 不足一秒就用毫秒寫。這行是半夜查死因時唯一的線索，
			// 四捨五入成「0 秒」會讓人以為是別的問題。
			const took = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`;
			log.logWarning(`${what} ${took}，結束 process`);
			// 直接 exit 會把還在管線裡的 log 截掉，等一拍再走
			setTimeout(() => process.exit(1), 250);
		}, ms);
	}

	private disarmDeadline(): void {
		if (this.reconnectDeadline) {
			clearTimeout(this.reconnectDeadline);
			this.reconnectDeadline = null;
		}
	}

	/**
	 * 把連線狀態寫進 log，斷太久就結束 process。
	 *
	 * 2026-09-09：socket 半開三天、log 完全靜音，因為這些狀態事件一個都沒人接。
	 * 注意 autoReconnectEnabled 預設 true 時，斷線走的是 close → reconnecting，
	 * **不會** emit disconnected（見 SocketModeClient 的 close handler），
	 * 所以要盯的是 close／reconnecting／connected 這三個。
	 *
	 * 2026-09-16：上面那三個只涵蓋「連上之後斷掉」。**「從來沒連上」沒有事件**——
	 * 09-11／09-15／09-16 三次殭屍都是這一種：log 停在 `socket: connecting`，
	 * 沒有 close、沒有 reconnecting，所以死線從來沒被按下，process 就這樣活著不做事。
	 * 那道死線改在 start() 裡按（見 CONNECT_DEADLINE_MS），連上就解除。
	 */
	private watchConnection(): void {
		const reconnectMs = Number(process.env.MOM_RECONNECT_DEADLINE_MS ?? 5 * 60 * 1000);

		this.socketClient.on("close", () => {
			log.logWarning("socket 連線中斷");
			this.armDeadline(reconnectMs, "斷線後仍未連回");
		});
		this.socketClient.on("reconnecting", () => {
			this.reconnectAttempts += 1;
			log.logInfo(`socket 重連中（第 ${this.reconnectAttempts} 次）`);
			this.armDeadline(reconnectMs, "斷線後仍未連回");
		});
		this.socketClient.on("connected", () => {
			if (this.reconnectAttempts > 0) {
				log.logInfo(`socket 已連回（重試 ${this.reconnectAttempts} 次）`);
			}
			this.reconnectAttempts = 0;
			this.disarmDeadline();
		});
		for (const state of ["connecting", "authenticated", "disconnecting", "disconnected"] as const) {
			this.socketClient.on(state, () => log.logInfo(`socket: ${state}`));
		}
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;
		this.botId = (auth.bot_id as string | undefined) ?? undefined;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();

		// 啟動死線在這裡按，不在 constructor：上面的 backfill 可能跑好幾分鐘，
		// 那段時間還沒開始連線，算進去會變成無辜的自殺。
		// 涵蓋兩種「從來沒連上」：socketClient.start() 卡住不 resolve，
		// 以及 emit 了 connecting 之後就靜音。連上時由 connected 事件解除。
		this.armDeadline(
			Number(process.env.MOM_CONNECT_DEADLINE_MS ?? 2 * 60 * 1000),
			"開始連線後仍未連上",
		);
		await this.socketClient.start();

		// Record startup time - messages older than this are just logged, not processed
		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text: markdownToMrkdwn(text) });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text: markdownToMrkdwn(text) });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	/** !clear-slack：找出這個頻道裡 bot 自己的訊息（含討論串回覆），依刪除順序排好。 */
	async collectOwnMessages(channel: string, oldest?: string): Promise<OwnMessage[]> {
		if (!this.botUserId) throw new Error("bot 還沒連上 Slack");
		return collectOwnMessages(this.webClient as unknown as ClearSlackClient, channel, { userId: this.botUserId, botId: this.botId }, { oldest });
	}

	/** --last N：頻道從新到舊第 N 則的 ts */
	async nthNewestTs(channel: string, n: number, excludeTs?: string): Promise<string> {
		return nthNewestTs(this.webClient as unknown as ClearSlackClient, channel, n, excludeTs);
	}

	async deleteOwnMessages(channel: string, items: OwnMessage[], onProgress?: (done: number, total: number) => void): Promise<ClearSlackResult> {
		return deleteOwnMessages(this.webClient as unknown as ClearSlackClient, channel, items, onProgress);
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
		return result.ts as string;
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.webClient.files.uploadV2({
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing. Always queues (no "already working" rejection).
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: SlackEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		const gate = this.handler.eventGate?.();
		if (gate) {
			// 產圖排隊／進行中：事件先不進頻道佇列，產完再排。否則它會在佇列裡等產圖，
			// 擋住排在它後面、產圖正在等的使用者訊息，兩邊互等。
			log.logInfo(`[${event.channel}] 產圖中，事件延到產圖結束後再排入佇列`);
			gate.then(() => queue.enqueue(() => this.handler.handleEvent(event, this, true)));
		} else {
			queue.enqueue(() => this.handler.handleEvent(event, this, true));
		}
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip DMs (handled by message event)
			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALWAYS, even for old messages)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);
			this.handler.observe?.(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			// 產圖：!img 指令與產圖期間的所有訊息（含 stop）由 image supervisor 處理
			if (this.handler.intercept?.(slackEvent, this)) {
				ack();
				return;
			}

			// Check for stop command - execute immediately, don't queue!
			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					this.handler.handleStop(e.channel, this); // Don't await, don't queue
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				ack();
				return;
			}

			// SYNC: Check if busy
			if (this.handler.isRunning(e.channel)) {
				this.postMessage(e.channel, "_Already working. Say `@mom stop` to cancel._");
			} else {
				this.handler.accepted?.(slackEvent);
				this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip bot messages, edits, etc.
			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// Skip channel @mentions - already handled by app_mention event
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);
			this.handler.observe?.(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			// Only trigger handler for DMs
			if (isDM) {
				// 產圖：!img 指令與產圖期間的所有訊息（含 stop）由 image supervisor 處理
				if (this.handler.intercept?.(slackEvent, this)) {
					ack();
					return;
				}

				// Check for stop command - execute immediately, don't queue!
				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this); // Don't await, don't queue
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					ack();
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
				} else {
					this.handler.accepted?.(slackEvent);
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
				}
			}

			ack();
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		// Find the biggest ts in log.jsonl
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs, // Only fetch messages newer than what we have
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter: include mom's messages, exclude other bots, skip already logged
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order
		relevantMessages.reverse();

		// Log each message to log.jsonl
		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			// Strip @mentions from text (same as live messages)
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// Process attachments - queues downloads in background
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Only backfill channels that already have a log.jsonl (mom has interacted with them before)
		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		// Fetch public/private channels
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// Also fetch DM channels (IMs)
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						// Use user's name as channel name for DMs
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
