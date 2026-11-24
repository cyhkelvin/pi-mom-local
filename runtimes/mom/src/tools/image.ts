import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { type JobOrigin, normalizeParams } from "@pi-mom-local/image-router";
import { getImageConfig, getImageSupervisor } from "../image-router.js";

/**
 * generate_image：讓 agent 產圖。
 *
 * **不阻塞**：工具只把 job 交給 supervisor 就立刻回傳 ETA，agent 這輪就結束。
 * 理由：產圖要先把對話模型從 GPU 卸載，如果工具等到產完才回傳，
 * agent 自己就卡在一個已經沒有 GPU 的 LLM 上；而且 slack.ts 在 agent 跑的期間
 * 會一律回「Already working」，使用者看不到產圖進度、也沒辦法取消。
 *
 * supervisor 也會等這一輪 agent 跑完（isChatBusy）才真的卸載 ollama，
 * 所以 agent 看到工具結果之後還有機會講完最後一句話。
 */
const schema = Type.Object({
	label: Type.String({ description: "Brief description shown to the user" }),
	prompt: Type.String({
		description:
			"Detailed English description of the image (subject, appearance, clothing, pose, lighting, camera, style). English works best.",
	}),
	width: Type.Optional(Type.Number({ description: "Width in px, multiple of 16. Default 768. Max area 1024x1024." })),
	height: Type.Optional(Type.Number({ description: "Height in px, multiple of 16. Default 1024." })),
	steps: Type.Optional(Type.Number({ description: "Sampling steps, 1-8. Default 4 (FLUX.2 Klein is distilled for 4)." })),
	seed: Type.Optional(Type.Number({ description: "Random seed; omit for random." })),
	nsfw: Type.Optional(
		Type.Boolean({
			description:
				"Apply the adult-nudity LoRA. Set true ONLY when the user explicitly asks for nudity of fictional adults. Never when anyone depicted is a minor, and never for real, identifiable people. Leave it off for ordinary scenes (including non-sexual scenes with teenagers). About 40% slower.",
		}),
	),
});

export function createImageTool(getOrigin: () => JobOrigin | null): AgentTool<typeof schema> {
	return {
		name: "generate_image",
		label: "generate_image",
		description:
			"Generate an image locally (FLUX.2 Klein 4B). Returns immediately with an ETA; the finished image is posted to the channel automatically — do NOT call attach for it, and do not claim the image is done. While it renders, chat is unavailable for everyone. Only one image at a time.",
		parameters: schema,
		execute: async (_id, args) => {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
			const sup = getImageSupervisor();
			const cfg = getImageConfig();
			if (!sup || !cfg) return text("產圖功能沒有啟用（IMAGE_ENABLED 不是 1）。把這句話原文轉達給使用者。");
			const origin = getOrigin();
			if (!origin) return text("內部錯誤：不知道是哪個頻道觸發的。把這句話原文轉達給使用者。");
			const p = normalizeParams(args, cfg);
			if (typeof p === "string") return text(`參數不合法：${p}。修正後可以再呼叫一次。`);
			const r = sup.submit(p, { ...origin, source: "tool" });
			if (!r.accepted) return text(`沒有開始產圖：${r.message}`);
			return text(
				`${r.message}\n用一句話告訴使用者已經開始產圖、預估時間，以及這段期間無法對話；不要再呼叫其他工具，也不要說圖已經完成。`,
			);
		},
	};
}
