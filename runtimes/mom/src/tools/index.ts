import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { JobOrigin } from "@pi-mom-local/image-router";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createImageTool } from "./image.js";
import { createReadTool } from "./read.js";
import { createFetchTool, createSearchTool } from "./websearch.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

export function createMomTools(executor: Executor, getImageOrigin?: () => JobOrigin | null): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
		// 2026-09-15：本來是 skill，但本地模型一律把 skill 名稱當工具名發出去
		// （見 websearch.ts 的註解與 TASK-048）。改成真正的工具，讓它的直覺變成對的。
		createSearchTool(executor),
		createFetchTool(executor),
	];
	// 產圖工具只在 IMAGE_ENABLED=1 時註冊，免得模型看到一個永遠回「沒有啟用」的工具
	if (getImageOrigin && (process.env.IMAGE_ENABLED === "1" || process.env.IMAGE_ENABLED === "true")) {
		tools.push(createImageTool(getImageOrigin));
	}
	return tools;
}
