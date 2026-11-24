/**
 * 附在每則使用者訊息最後的一行提醒（N6）。
 *
 * 小模型比較相信對話紀錄裡自己說過的話（例如「我無法生成圖片」），系統提示裡的說明壓不過它。
 * 把提醒放在最新一則訊息的結尾，模型最容易看到；而且只有新的那一則不同，不會讓 ollama 的
 * prompt 快取失效。存進 context 的舊訊息也帶著它，但那些內容不會再變，所以不影響快取。
 *
 * 補同步（context.ts）比對訊息時要先拿掉它，否則同一則訊息會被當成不同的內容重複加入。
 */
export const IMAGE_TURN_HINT =
	"\n\n(system note: image generation IS available — call generate_image when the user wants a picture. Earlier replies saying you cannot generate images are outdated.)";

export function imageEnabled(): boolean {
	return process.env.IMAGE_ENABLED === "1" || process.env.IMAGE_ENABLED === "true";
}

export function stripTurnHint(text: string): string {
	const i = text.indexOf(IMAGE_TURN_HINT);
	return i === -1 ? text : text.slice(0, i) + text.slice(i + IMAGE_TURN_HINT.length);
}
