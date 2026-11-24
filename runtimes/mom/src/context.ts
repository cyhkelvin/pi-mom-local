/**
 * Context management for mom.
 *
 * Mom uses two files per channel:
 * - context.jsonl: Structured API messages for LLM context (same format as coding-agent sessions)
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - createMomSettingsManager: Creates a SettingsManager backed by workspace settings.json
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import { type SessionManager, type SessionMessageEntry, SettingsManager } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isClearedTs, readClearedRanges } from "./clear.js";
import { formatMessageTimestamp, stripMessageTimestamp } from "./time.js";
import { stripTurnHint } from "./turn-hint.js";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mom wasn't running (channel chatter,
 * backfilled messages, messages while busy) are added to the LLM context.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param excludeSlackTs - Slack timestamp of current message (will be added via prompt(), not sync)
 * @returns Number of messages synced
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	excludeSlackTs?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					// Strip timestamp prefix for comparison. Live and synced messages both carry it now,
						// but older synced entries in context.jsonl don't — comparing without it covers both.
					// Format: [YYYY-MM-DD HH:MM:SS+HH:MM] [username]: text
					let normalized = stripTurnHint(stripMessageTimestamp(content));
					// Strip attachments section
					const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = (part as { type: "text"; text: string }).text;
							normalized = stripTurnHint(stripMessageTimestamp(normalized));
							const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
							if (attachmentsIdx !== -1) {
								normalized = normalized.substring(0, attachmentsIdx);
							}
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context
	// /clear 之後：清除範圍內的訊息不再補同步（issue #30）
	const clearedRanges = readClearedRanges(channelDir);

	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const slackTs = logMsg.ts;
			const date = logMsg.date;
			if (!slackTs || !date) continue;

			// Skip the current message being processed (will be added via prompt())
			if (excludeSlackTs && slackTs === excludeSlackTs) continue;

			// 使用者用 /clear 清掉的舊對話
			if (isClearedTs(slackTs, clearedRanges)) continue;

			// Skip bot messages - added through agent flow
			if (logMsg.isBot) continue;

			// Comparison key: message text without the timestamp prefix
			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;

			// Skip if this exact message text is already in context
			if (existingMessages.has(messageText)) continue;

			// Same "[timestamp] [user]: text" format as live messages (agent.ts), so the model can tell
			// which day "today" referred to. Without it, a message synced while mom was busy/offline
			// has no date at all and the model guesses from nearby messages.
			const parsed = new Date(date).getTime();
			const msgTime = Number.isNaN(parsed) ? Date.now() : parsed;
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: `[${formatMessageTimestamp(new Date(msgTime))}] ${messageText}` }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText); // Track to avoid duplicates within this sync
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	// Sort by timestamp and add to session
	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// Settings manager for mom
// ============================================================================

type MomSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements MomSettingsStorage {
	private settingsPath: string;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
	}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		if (scope === "project") {
			// Mom stores all settings in a single workspace file.
			fn(undefined);
			return;
		}

		const current = existsSync(this.settingsPath) ? readFileSync(this.settingsPath, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) {
			return;
		}

		const dir = dirname(this.settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.settingsPath, next, "utf-8");
	}
}

export function createMomSettingsManager(workspaceDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(workspaceDir));
}
