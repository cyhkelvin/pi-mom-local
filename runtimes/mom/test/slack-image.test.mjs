// !edit 的 Slack 那一側：挑出圖片附檔、用 bot token 下載參考圖。
// 判斷格式、尺寸的測試在 packages/image-router/test/image-edit.test.ts。跑法：npm test（會先 build）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { fetchSlackImage, firstImage, loadRefImage } from "../dist/slack-image.js";

const tmp = mkdtempSync(join(tmpdir(), "mom-slack-image-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 只有 PNG 檔頭（簽章 + IHDR 寬高），夠 image-router 判斷格式和尺寸。 */
function pngHeader(w, h) {
	const b = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "ascii");
	b.writeUInt32BE(w, 16);
	b.writeUInt32BE(h, 20);
	return b;
}

describe("Slack 參考圖", () => {
	it("只挑圖片附檔", () => {
		assert.equal(firstImage([{ name: "a.pdf", mimetype: "application/pdf" }]), undefined);
		assert.equal(firstImage([{ name: "a.pdf" }, { name: "b.JPG" }])?.name, "b.JPG");
		assert.equal(firstImage([{ name: "x", mimetype: "image/heic" }])?.name, "x");
		assert.equal(firstImage(undefined), undefined);
	});

	it("下載：優先 thumb_1024（Slack 已轉正、轉成 JPG），帶 bot token", async () => {
		const calls = [];
		const fakeFetch = async (url, init) => {
			calls.push({ url, auth: init.headers.Authorization });
			return new Response(pngHeader(1024, 768));
		};
		const r = await fetchSlackImage(
			{ name: "IMG_1.HEIC", mimetype: "image/heic", url_private: "https://files/orig", thumb_1024: "https://files/t1024" },
			"xoxb-test",
			fakeFetch,
		);
		assert.ok(typeof r !== "string");
		assert.deepEqual(calls, [{ url: "https://files/t1024", auth: "Bearer xoxb-test" }]);
		assert.equal(r.label, "IMG_1.HEIC");
		// 沒有縮圖才抓原檔
		await fetchSlackImage({ name: "a.png", url_private: "https://files/orig" }, "t", fakeFetch);
		assert.equal(calls.at(-1).url, "https://files/orig");
	});

	it("下載失敗或拿到 HTML：回傳給使用者看的錯誤", async () => {
		const f404 = async () => new Response("nope", { status: 404 });
		assert.match(String(await fetchSlackImage({ name: "a.png", url_private: "u" }, "t", f404)), /HTTP 404/);
		const fHtml = async () => new Response("<html>sign in</html>");
		assert.match(String(await fetchSlackImage({ name: "a.png", url_private: "u" }, "t", fHtml)), /不是 PNG/);
		assert.match(String(await fetchSlackImage({ name: "a.png" }, "t", f404)), /下載網址/);
	});

	it("頻道最近一張圖是本機檔（bot 剛產出的）時直接讀檔", async () => {
		const f = join(tmp, "img-1.png");
		writeFileSync(f, pngHeader(768, 1024));
		const r = await loadRefImage({ kind: "local", path: f, label: "img-1.png" }, "t");
		assert.ok(typeof r !== "string");
		assert.deepEqual([r.width, r.height], [768, 1024]);
		assert.match(String(await loadRefImage({ kind: "local", path: join(tmp, "gone.png"), label: "gone.png" }, "t")), /重新上傳/);
	});
});
