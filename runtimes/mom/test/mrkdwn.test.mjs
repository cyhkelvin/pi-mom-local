// Markdown → Slack mrkdwn。對 build 後的 dist 測試：npm run build && node --test test/mrkdwn.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToMrkdwn as md } from "../dist/mrkdwn.js";

test("粗體", () => {
	assert.equal(md("今天 **2026 年 11 月 20 日** 晴"), "今天 *2026 年 11 月 20 日* 晴");
	assert.equal(md("__重要__ 事項"), "*重要* 事項");
	assert.equal(md("snake_case__name 不是粗體"), "snake_case__name 不是粗體");
	assert.equal(md("2 ** 3 不是粗體"), "2 ** 3 不是粗體");
});

test("標題，含標題裡的粗體與 emoji", () => {
	assert.equal(md("## 台北天氣"), "*台北天氣*");
	assert.equal(md("## 🌤️ **台北今日（11/20）天氣預報**"), "*🌤️ 台北今日（11/20）天氣預報*");
	assert.equal(md("### **主要天氣現象：**"), "*主要天氣現象：*");
	assert.equal(md("#hashtag 不是標題"), "#hashtag 不是標題");
});

test("連結與圖片", () => {
	assert.equal(md("見 [氣象署](https://www.cwa.gov.tw/V8/C/)"), "見 <https://www.cwa.gov.tw/V8/C/|氣象署>");
	assert.equal(md("![圖](https://x.test/a.png)"), "<https://x.test/a.png|圖>");
});

test("表格包成程式碼區塊，拿掉分隔線", () => {
	const input = "氣溫：\n| 時段 | 氣溫 |\n|------|------|\n| 白天最高 | **15 - 17°C** |\n結束";
	assert.equal(md(input), "氣溫：\n```\n| 時段 | 氣溫 |\n| 白天最高 | **15 - 17°C** |\n```\n結束");
});

test("程式碼區塊和行內程式碼不動", () => {
	const block = "看這段：\n```\n## 不是標題\nx = **kwargs\n```\n**粗**";
	assert.equal(md(block), "看這段：\n```\n## 不是標題\nx = **kwargs\n```\n*粗*");
	assert.equal(md("執行 `ls **/*.ts` 和 **這個**"), "執行 `ls **/*.ts` 和 *這個*");
});

test("串流到一半：未關閉的程式碼區塊和反引號不轉換", () => {
	assert.equal(md("**完成**\n```\n## 還在寫"), "*完成*\n```\n## 還在寫");
	assert.equal(md("**a** `**b**"), "*a* `**b**");
	assert.equal(md("寫到一半 **粗"), "寫到一半 **粗");
});

test("重複套用結果不變（串流 update、產圖進度訊息都會經過）", () => {
	const samples = [
		"## 🌤️ **台北今日（11/20）天氣預報**\n\n### **主要天氣現象：**\n- ⚠️ **大陸冷氣團影響**\n見 [來源](https://a.test/x)",
		"| a | b |\n|---|---|\n| 1 | 2 |",
		"正在產圖（由 <@kelvin> 在 <#C123|general> 觸發）*3/8*、剩約 40s",
		"_Thinking_ `code` ```\nblock\n```",
	];
	for (const s of samples) {
		const once = md(s);
		assert.equal(md(once), once, `第二次套用改變了結果：${JSON.stringify(s)}`);
	}
});

test("已經是 mrkdwn 的內容不被改動", () => {
	const mrkdwn = "*粗體* _斜體_ <https://a.test|連結> <@U123> `code`";
	assert.equal(md(mrkdwn), mrkdwn);
	assert.equal(md(""), "");
});
