#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, dropRunner, getOrCreateRunner } from "./agent.js";
import { type ClearMode, type ClearRequest, clearChannelFiles, cutoffFromLog, dateToTs, describeRange, parseClearRequest } from "./clear.js";
import { clearAskText } from "./slack-clear.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import {
	checkEditPrompt,
	controlWord,
	EDIT_USAGE,
	failureEventText,
	formatLoraList,
	isEditCommand,
	isImgCommand,
	isLoraListCommand,
	normalizeEditParams,
	normalizeParams,
	parseEditCommand,
	parseImgCommand,
} from "@pi-mom-local/image-router";
import { getImageConfig, getImageSupervisor, initImageRouter } from "./image-router.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { firstImage, type ImageSource, loadRefImage } from "./slack-image.js";
import { type MomHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir),
			store: new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create SlackContext adapter
// ============================================================================

function createSlackContext(event: SlackEvent, slack: SlackBot, state: ChannelState, isEvent?: boolean) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		store: state.store,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				try {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

					// Truncate accumulated text if too long (Slack limit is 40K, we use 35K for safety)
					const MAX_MAIN_LENGTH = 35000;
					const truncationNote = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
					if (accumulatedText.length > MAX_MAIN_LENGTH) {
						accumulatedText =
							accumulatedText.substring(0, MAX_MAIN_LENGTH - truncationNote.length) + truncationNote;
					}

					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else {
						messageTs = await slack.postMessage(event.channel, displayText);
					}

					if (shouldLog && messageTs) {
						slack.logBotResponse(event.channel, text, messageTs);
					}
				} catch (err) {
					log.logWarning("Slack respond error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					// Replace the accumulated text entirely, with truncation
					const MAX_MAIN_LENGTH = 35000;
					const truncationNote = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
					if (text.length > MAX_MAIN_LENGTH) {
						accumulatedText = text.substring(0, MAX_MAIN_LENGTH - truncationNote.length) + truncationNote;
					} else {
						accumulatedText = text;
					}

					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else {
						messageTs = await slack.postMessage(event.channel, displayText);
					}
				} catch (err) {
					log.logWarning("Slack replaceMessage error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					if (messageTs) {
						// Truncate thread messages if too long (20K limit for safety)
						const MAX_THREAD_LENGTH = 20000;
						let threadText = text;
						if (threadText.length > MAX_THREAD_LENGTH) {
							threadText = `${threadText.substring(0, MAX_THREAD_LENGTH - 50)}\n\n_(truncated)_`;
						}

						const ts = await slack.postInThread(event.channel, messageTs, threadText);
						threadMessageTs.push(ts);
					}
				} catch (err) {
					log.logWarning("Slack respondInThread error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					try {
						if (!messageTs) {
							accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
							messageTs = await slack.postMessage(event.channel, accumulatedText + workingIndicator);
						}
					} catch (err) {
						log.logWarning("Slack setTyping error", err instanceof Error ? err.message : String(err));
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await slack.uploadFile(event.channel, filePath, title);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				try {
					isWorking = working;
					if (messageTs) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await slack.updateMessage(event.channel, messageTs, displayText);
					}
				} catch (err) {
					log.logWarning("Slack setWorking error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread messages first (in reverse order)
				for (let i = threadMessageTs.length - 1; i >= 0; i--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[i]);
					} catch {
						// Ignore errors deleting thread messages
					}
				}
				threadMessageTs.length = 0;
				// Then delete main message
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},
	};
}

// ============================================================================
// Handler
// ============================================================================

/**
 * 已收下、排在頻道佇列裡但還沒回完的使用者訊息（key：channel:ts）。
 * 產圖要排在它們後面：supervisor 會等這裡清空、而且沒有任何 agent 在跑，才切換 GPU。
 * 產圖一進佇列，intercept 就開始拒收新訊息，所以這個集合只會變小，不會一直等下去。
 */
const acceptedChats = new Set<string>();
const chatKey = (e: SlackEvent) => `${e.channel}:${e.ts}`;

function anyChannelRunning(): boolean {
	for (const st of channelStates.values()) if (st.running) return true;
	return false;
}

/** 有沒有對話在跑，或已收下還沒回的訊息（產圖要等它們）。 */
function chatBusy(): boolean {
	return acceptedChats.size > 0 || anyChannelRunning();
}

function post(slack: SlackBot, channel: string, text: string): void {
	slack.postMessage(channel, text).catch((err) => {
		log.logWarning("Slack post error", err instanceof Error ? err.message : String(err));
	});
}

async function runEvent(event: SlackEvent, slack: SlackBot, isEvent: boolean | undefined, queuedBeforeImage: boolean): Promise<void> {
	const state = getState(event.channel);

	// 產圖中或 sd-server 佔著 VRAM：先讓出 GPU 再跑 agent。
	// 一定要在 state.running = true 之前：supervisor 會等「沒有任何 agent 在跑」才開始產圖，
	// 順序反過來的話兩邊會互等到逾時。
	// 例外：產圖排隊前就收下的訊息先跑（產圖還在 pending，正在等它），不等產圖。
	const sup = getImageSupervisor();
	if (sup && !(queuedBeforeImage && sup.isBusy())) {
		try {
			await sup.prepareForChat();
		} catch (err) {
			log.logWarning("prepareForChat error", err instanceof Error ? err.message : String(err));
		}
	}

	// Start run
	state.running = true;
	state.stopRequested = false;

	log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

	try {
		// Create context adapter
		const ctx = createSlackContext(event, slack, state, isEvent);

		// Run the agent
		await ctx.setTyping(true);
		await ctx.setWorking(true);
		const result = await state.runner.run(ctx as any, state.store);
		await ctx.setWorking(false);

		if (result.stopReason === "aborted" && state.stopRequested) {
			if (state.stopMessageTs) {
				await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
				state.stopMessageTs = undefined;
			} else {
				await slack.postMessage(event.channel, "_Stopped_");
			}
		}
	} catch (err) {
		log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
	} finally {
		state.running = false;
	}
}

/**
 * 每個頻道最近一張圖（使用者上傳的，或 bot 產出的）。`!edit` 沒附照片時改這一張（issue #31）。
 * 只放在記憶體：重啟後要重新上傳，或先 `!img` 產一張。
 */
const lastImage = new Map<string, ImageSource>();

/** 下載參考圖、檢查參數、交給 supervisor。在 intercept 之外非同步執行（下載要時間）。 */
async function startEdit(event: SlackEvent, slack: SlackBot, src: ImageSource): Promise<void> {
	const sup = getImageSupervisor();
	const cfg = getImageConfig();
	if (!sup || !cfg) return;
	let ref: Awaited<ReturnType<typeof loadRefImage>>;
	try {
		ref = await loadRefImage(src, MOM_SLACK_BOT_TOKEN!);
	} catch (err) {
		ref = `下載照片失敗：${err instanceof Error ? err.message : String(err)}`;
	}
	if (typeof ref === "string") {
		post(slack, event.channel, ref);
		return;
	}
	const p = normalizeEditParams(parseEditCommand(event.text)!, ref, cfg);
	if (typeof p === "string") {
		post(slack, event.channel, p);
		return;
	}
	// 下載期間可能有別人開始產圖，或這個頻道開始回覆
	if (sup.isBusy()) {
		post(slack, event.channel, sup.busyReply(event.channel, event.user, true) ?? "_已經有一張圖在產了_");
		return;
	}
	if (handler.isRunning(event.channel)) {
		post(slack, event.channel, "_助理還在回覆上一則訊息，等它講完再下 `!edit`，或先說 `stop`。_");
		return;
	}
	const r = sup.submit(p, {
		channelId: event.channel,
		channelName: slack.getChannel(event.channel)?.name,
		userId: event.user,
		userName: slack.getUser(event.user)?.userName,
		source: "command",
	});
	if (!r.accepted) post(slack, event.channel, r.message);
}

/** 正在跑 !clear-slack 的頻道；同一個頻道不重複刪。 */
const clearingSlack = new Set<string>();

/**
 * 清除頻道的本機對話檔案（/clear、/clear-record、!clear-all 共用）。
 * 同時丟掉記憶體裡的 runner；clear-record 連「最近一張圖」一起忘掉。
 * @param cutoffTs 只清這個時間點以後的；不給就是全部
 */
function clearLocal(channel: string, mode: ClearMode, commandTs: string, cutoffTs?: string): string[] {
	const removed = clearChannelFiles(join(workingDir, channel), mode, commandTs, cutoffTs);
	// 記憶體裡的 runner 還拿著舊訊息，一起丟掉；下一則訊息會從（截過的）context.jsonl 重建
	channelStates.delete(channel);
	dropRunner(channel);
	if (mode === "clear-record") lastImage.delete(channel);
	log.logInfo(`[${channel}] ${mode}${cutoffTs ? ` 從 ${cutoffTs}` : ""}：刪除 ${removed.join(", ") || "（沒有檔案）"}`);
	return removed;
}

/**
 * !clear-slack confirm：刪掉這個頻道裡 bot 在 Slack 上的訊息和檔案（背景執行，可能要好幾分鐘）。
 * !clear-all：Slack 刪完之後再做同範圍的 /clear-record。放在最後做，
 * 才會連刪除期間寫進 log.jsonl 的指令訊息一起清掉。
 */
async function startClearSlack(event: SlackEvent, slack: SlackBot, req: ClearRequest): Promise<void> {
	const ch = event.channel;
	const all = req.kind === "clear-all";
	clearingSlack.add(ch);
	let statusTs: string | undefined;
	let cutoffTs: string | undefined;
	const localNote = () => {
		if (!all) return "";
		try {
			clearLocal(ch, "clear-record", event.ts, cutoffTs);
			return `同範圍的對話記憶和本機紀錄（log.jsonl、附件）也已清除，MEMORY.md 保留。`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${ch}] clear-all 清除本機紀錄失敗`, msg);
			return `本機紀錄清除失敗：${msg}。`;
		}
	};
	try {
		// 範圍換算成時間點：--since 直接用；--last N 從 Slack 主畫面往回數第 N 則（不算下指令那則）
		if (req.range.since) cutoffTs = dateToTs(req.range.since);
		else if (req.range.last) cutoffTs = await slack.nthNewestTs(ch, req.range.last, event.ts);
		const scope = describeRange(req.range);
		const items = await slack.collectOwnMessages(ch, cutoffTs);
		if (items.length === 0) {
			post(slack, ch, `_這個頻道裡沒有 bot 發過的訊息（範圍：${scope}）。${localNote()}_`);
			return;
		}
		const eta = Math.max(1, Math.ceil(items.length / 50));
		statusTs = await slack.postMessage(ch, `_正在刪除 bot 的 ${items.length} 則訊息（範圍：${scope}），約需 ${eta} 分鐘…_`);
		let lastUpdate = Date.now();
		const r = await slack.deleteOwnMessages(ch, items, (done, total) => {
			if (Date.now() - lastUpdate < 10_000 || done === total) return;
			lastUpdate = Date.now();
			slack.updateMessage(ch, statusTs!, `_正在刪除 bot 的訊息：${done}/${total}…_`).catch(() => {});
		});
		log.logInfo(`[${ch}] clear-slack：刪除 ${r.messages} 則訊息、${r.files} 個檔案，失敗 ${r.failed.length}`);
		if (r.failed.length) log.logWarning(`[${ch}] clear-slack 失敗項目`, r.failed.slice(0, 20).join("; "));
		const failNote = r.failed.length ? `，${r.failed.length} 則刪不掉（細節在 log）` : "";
		await slack.updateMessage(
			ch,
			statusTs,
			`_已刪除 bot 的 ${r.messages} 則訊息和 ${r.files} 個檔案${failNote}。${localNote()}你自己的訊息請自己刪。這則通知 1 分鐘後自動消失。_`,
		);
		const ts = statusTs;
		setTimeout(() => slack.deleteMessage(ch, ts).catch(() => {}), 60_000).unref();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning(`[${ch}] clear-slack 失敗`, msg);
		post(slack, ch, `_刪除 Slack 訊息失敗：${msg}_`);
	} finally {
		clearingSlack.delete(ch);
	}
}

const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	intercept(event: SlackEvent, slack: SlackBot): boolean {
		const sup = getImageSupervisor();
		const text = event.text || "";

		// 清除指令（/clear、/clear-record、!clear-slack、!clear-all），可加 --since / --last 範圍，不經過 LLM
		const clearReq = parseClearRequest(text);
		if (clearReq) {
			if (clearReq.error) {
				post(slack, event.channel, clearReq.error);
				return true;
			}
			const slackSide = clearReq.kind === "clear-slack" || clearReq.kind === "clear-all";
			// !clear-slack、!clear-all 要再打 confirm 才真的刪
			if (slackSide && !clearReq.confirm) {
				post(slack, event.channel, clearAskText(clearReq));
				return true;
			}
			if (slackSide && clearingSlack.has(event.channel)) {
				post(slack, event.channel, "_已經在刪了，請稍候。_");
				return true;
			}
			if (this.isRunning(event.channel)) {
				post(slack, event.channel, "_助理還在回覆，先說 `stop`，或等它講完再清除。_");
				return true;
			}
			if (sup?.isBusy()) {
				post(slack, event.channel, "_正在產圖，產完（或 `stop` 取消）之後再清除。_");
				return true;
			}
			if (slackSide) {
				void startClearSlack(event, slack, clearReq);
				return true;
			}
			const mode = clearReq.kind as ClearMode;
			try {
				const r = clearReq.range;
				const cutoffTs = r.since ? dateToTs(r.since) : r.last ? cutoffFromLog(join(workingDir, event.channel), r.last, event.ts) : undefined;
				clearLocal(event.channel, mode, event.ts, cutoffTs);
				const scope = cutoffTs ? describeRange(r) : "的";
				post(
					slack,
					event.channel,
					mode === "clear"
						? `_已清除這個頻道${scope}對話記憶${cutoffTs ? "" : "，接下來會從頭開始"}。本機紀錄（log.jsonl）和 MEMORY.md 保留。_`
						: `_已清除這個頻道${scope}對話記憶和本機紀錄（log.jsonl、附件）。MEMORY.md 保留。_`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[${event.channel}] ${mode} 失敗`, msg);
				post(slack, event.channel, `_清除失敗：${msg}_`);
			}
			return true;
		}

		// !lora：列出 loras/ 裡的 LoRA 和編號（--lora2 用第 2 個）。只讀資料夾，產圖中也能用
		if (isLoraListCommand(text)) {
			const cfg = getImageConfig();
			post(slack, event.channel, cfg ? formatLoraList(cfg) : "_產圖功能沒有啟用（config/agent.env 的 IMAGE_ENABLED=1）_");
			return true;
		}

		// !img：不經過 LLM 直接產圖（對話模型不肯呼叫工具時的退路）
		if (isImgCommand(text)) {
			const cfg = getImageConfig();
			if (!sup || !cfg) {
				post(slack, event.channel, "_產圖功能沒有啟用（config/agent.env 的 IMAGE_ENABLED=1）_");
				return true;
			}
			if (sup.isBusy()) {
				post(slack, event.channel, sup.busyReply(event.channel, event.user, true) ?? "_已經有一張圖在產了_");
				return true;
			}
			if (this.isRunning(event.channel)) {
				post(slack, event.channel, "_助理還在回覆上一則訊息，等它講完再下 `!img`，或先說 `stop`。_");
				return true;
			}
			const p = normalizeParams(parseImgCommand(text)!, cfg);
			if (typeof p === "string") {
				post(slack, event.channel, p);
				return true;
			}
			const r = sup.submit(p, {
				channelId: event.channel,
				channelName: slack.getChannel(event.channel)?.name,
				userId: event.user,
				userName: slack.getUser(event.user)?.userName,
				source: "command",
			});
			// 接受時 supervisor 會自己發進度訊息，這裡只在被拒絕時回覆
			if (!r.accepted) post(slack, event.channel, r.message);
			return true;
		}

		// !edit：用文字修改照片（issue #31），不經過 LLM
		if (isEditCommand(text)) {
			const cfg = getImageConfig();
			if (!sup || !cfg) {
				post(slack, event.channel, "_產圖功能沒有啟用（config/agent.env 的 IMAGE_ENABLED=1）_");
				return true;
			}
			if (sup.isBusy()) {
				post(slack, event.channel, sup.busyReply(event.channel, event.user, true) ?? "_已經有一張圖在產了_");
				return true;
			}
			if (this.isRunning(event.channel)) {
				post(slack, event.channel, "_助理還在回覆上一則訊息，等它講完再下 `!edit`，或先說 `stop`。_");
				return true;
			}
			// 先檢查修改說明，不合格就不必下載照片
			const bad = checkEditPrompt(parseEditCommand(text)!);
			if (bad) {
				post(slack, event.channel, bad);
				return true;
			}
			const attached = firstImage(event.files);
			const src: ImageSource | undefined = attached ? { kind: "slack", file: attached } : lastImage.get(event.channel);
			if (!src) {
				post(slack, event.channel, `這個頻道還沒有可以修改的圖。${EDIT_USAGE}`);
				return true;
			}
			void startEdit(event, slack, src).catch((err) => {
				log.logWarning(`[${event.channel}] !edit 失敗`, err instanceof Error ? err.message : String(err));
				post(slack, event.channel, "_修改圖片失敗，請再試一次。_");
			});
			return true;
		}

		// 產圖期間：所有頻道的訊息都由這裡回覆，不交給 agent（GPU 已經讓給產圖）
		if (!sup || !sup.isBusy()) return false;
		const w = controlWord(text);
		if (w === "stop") {
			post(slack, event.channel, sup.cancel(event.channel, event.user));
		} else {
			const reply = sup.busyReply(event.channel, event.user, w === "wait");
			if (reply) post(slack, event.channel, reply);
		}
		return true;
	},

	async handleStop(channelId: string, slack: SlackBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts; // Save for updating later
		} else {
			await slack.postMessage(channelId, "_Nothing running_");
		}
	},

	eventGate(): Promise<void> | null {
		const sup = getImageSupervisor();
		return sup?.isBusy() ? sup.waitIdle() : null;
	},

	observe(event: SlackEvent): void {
		const img = firstImage(event.files);
		if (img) lastImage.set(event.channel, { kind: "slack", file: img });
	},

	accepted(event: SlackEvent): void {
		acceptedChats.add(chatKey(event));
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const key = chatKey(event);
		// 產圖排進佇列之前就收下的訊息：產圖會等它，所以它不必（也不能）等產圖，否則兩邊互等
		const queuedBeforeImage = !isEvent && acceptedChats.has(key);
		try {
			await runEvent(event, slack, isEvent, queuedBeforeImage);
		} finally {
			acceptedChats.delete(key);
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Shared store for attachment downloads (also used per-channel in getState)
const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });

const bot = new SlackBotClass(handler, {
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
	workingDir,
	store: sharedStore,
});

// 產圖監控器（IMAGE_ENABLED=1 時才會建立）
const imageSup = initImageRouter({
	isChatBusy: chatBusy,
	log: (msg) => log.logInfo(`[image] ${msg}`),
	notifier: {
		post: (channel, text) => bot.postMessage(channel, text),
		update: (channel, ts, text) => bot.updateMessage(channel, ts, text),
		upload: async (channel, path, title) => {
			await bot.uploadFile(channel, path, title);
			// bot 剛產出的圖也可以接著 !edit
			lastImage.set(channel, { kind: "local", path, label: title });
		},
		logBot: (channel, text, ts) => bot.logBotResponse(channel, text, ts),
		failed: (info) => {
			// 交回給 agent：用和排程事件一樣的管道，讓它在該頻道接手說明
			bot.enqueueEvent({
				type: "mention",
				channel: info.job.channelId,
				user: "EVENT",
				text: failureEventText(info),
				ts: Date.now().toString(),
			});
		},
	},
});
if (imageSup) {
	const c = getImageConfig()!;
	log.logInfo(`[image] 產圖已啟用：${c.diffusionModel} + ${c.llm}，常駐模式 ${c.residentMode}，port ${c.port}`);
}

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

bot.start();
