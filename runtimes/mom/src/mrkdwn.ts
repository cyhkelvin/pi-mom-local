/**
 * Markdown → Slack mrkdwn。
 *
 * 系統提示已經要求模型用 mrkdwn，但本地小模型（qwen3.5:4b）照樣寫 `## 標題`、`**粗體**`、
 * 表格，Slack 上就是一堆星號和直線。靠模型守規則不可靠，所以送出前由程式轉換。
 *
 * 規則：
 *   **x** / __x__        → *x*
 *   # ~ ###### 標題      → *標題*（標題裡的粗體記號先拿掉）
 *   [文字](url)          → <url|文字>；![alt](url) 同樣處理
 *   Markdown 表格        → 包進 ``` 程式碼區塊（Slack 沒有表格，等寬字至少對得齊）
 *   程式碼區塊、`行內程式碼` 的內容不動
 *
 * 必須「重複套用結果不變」：串流時同一則訊息會用越來越長的文字反覆 update，
 * 產圖的進度訊息也會經過這裡。已經是 mrkdwn 的 *x*、<url|x>、``` 區塊都不會再被改動。
 * 串流到一半、程式碼區塊還沒關閉時，未關閉的部分視為程式碼，不轉換。
 */

const FENCE = "```";

export function markdownToMrkdwn(text: string): string {
	if (!text) return text;
	// 依 ``` 切段：偶數段是一般文字，奇數段是程式碼（最後一段若未關閉也算程式碼）
	const parts = text.split(FENCE);
	return parts.map((part, i) => (i % 2 === 0 ? convertProse(part) : part)).join(FENCE);
}

function convertProse(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		// 表格：連續的 | 開頭行，且第二行是分隔線 |---|---|
		if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
			const table: string[] = [];
			while (i < lines.length && isTableRow(lines[i])) {
				if (!isTableSeparator(lines[i])) table.push(lines[i].trim());
				i++;
			}
			i--;
			out.push(FENCE, ...table, FENCE);
			continue;
		}
		out.push(convertLine(lines[i]));
	}
	return out.join("\n");
}

function isTableRow(line: string): boolean {
	return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
	return /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
}

function convertLine(line: string): string {
	const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
	if (heading) {
		const title = convertInline(heading[1])
			.replace(/^\*(.+)\*$/, "$1")
			.replace(/\*(.+?)\*/g, "$1");
		return `*${title}*`;
	}
	return convertInline(line);
}

/** 行內轉換，跳過 `行內程式碼`（未關閉的反引號之後整段不動） */
function convertInline(line: string): string {
	const segments = line.split("`");
	return segments
		.map((seg, i) => {
			if (i % 2 === 1) return seg; // 反引號裡面
			if (i === segments.length - 1 && segments.length % 2 === 0) return seg; // 未關閉的反引號之後
			return seg
				.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
				.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "*$1*")
				.replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "$1*$2*");
		})
		.join("`");
}
