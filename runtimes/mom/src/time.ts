/**
 * 時間格式化。即時訊息和補同步的訊息都用這裡，確保格式一致：
 * 模型要靠每則訊息前面的 [時間戳] 判斷「今天」「現在」「星期幾」。
 *
 * 現在時間「不」放進系統提示：系統提示必須逐字固定，ollama（llama.cpp）的 prompt 快取
 * 才能重用整段前綴。系統提示裡有一行每分鐘都在變的時間，後面整段對話歷史就得每次重讀，
 * 一則回覆從幾秒變成幾分鐘（2026-11-20 實測）。最後一則訊息的時間戳就是「現在」。
 *
 * 時區取執行環境的本地時區（host 的 /etc/localtime；systemd 服務沿用同一個）。
 */

const pad = (n: number) => n.toString().padStart(2, "0");

const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_ZH = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

/** "+08:00" */
export function formatUtcOffset(d: Date): string {
	const offset = -d.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	return `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/**
 * 訊息前綴用的時間戳："2026-11-20 10:15:03+08:00 Fri 週五"
 * 星期直接寫出來，小模型自己推算星期常算錯（11/20 被說成週六）。
 */
export function formatMessageTimestamp(d: Date): string {
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${formatUtcOffset(d)} ` +
		`${WEEKDAYS_EN[d.getDay()]} ${WEEKDAYS_ZH[d.getDay()]}`
	);
}

/**
 * 去掉訊息開頭的時間戳，用於比對是否為同一則訊息。
 * 兩種格式都要認得：新的 "[... +08:00 Fri 週五] " 和舊資料的 "[... +08:00] "。
 */
export function stripMessageTimestamp(text: string): string {
	return text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}(?: [A-Z][a-z]{2} 週[日一二三四五六])?\] /, "");
}
