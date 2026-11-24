import { loadLocalImage, type RefImage, toRefImage } from "@pi-mom-local/image-router";

/**
 * Slack 那一側的參考圖（`!edit`，issue #31）：判斷附檔是不是圖、用 bot token 下載。
 * 判斷格式和尺寸、轉成 sd-server 要的 base64 由 image-router 套件負責。
 *
 * 優先用 Slack 的縮圖 thumb_1024：Slack 已經依 EXIF 轉正（手機直拍的照片原檔常是橫的）、
 * HEIC 也轉成 JPG，最長邊 1024 剛好當參考圖。沒有縮圖才下載原檔。
 */

/** Slack 訊息事件裡 files[] 的欄位（只列用得到的）。 */
export interface SlackFileInfo {
	name?: string;
	mimetype?: string;
	url_private?: string;
	url_private_download?: string;
	thumb_1024?: string;
	thumb_720?: string;
	thumb_480?: string;
}

/** 頻道裡最近一張圖：Slack 上的檔案，或 bot 自己產出、存在本機的圖。 */
export type ImageSource = { kind: "slack"; file: SlackFileInfo } | { kind: "local"; path: string; label: string };

export function isImageFile(f: SlackFileInfo): boolean {
	if (f.mimetype) return f.mimetype.startsWith("image/");
	return /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(f.name ?? "");
}

/** 一則訊息附的第一張圖。 */
export function firstImage(files: SlackFileInfo[] | undefined): SlackFileInfo | undefined {
	return files?.find(isImageFile);
}

const MAX_BYTES = 25 * 1024 * 1024;

/** 下載 Slack 上的圖（用 bot token）。優先縮圖，沒有才抓原檔。 */
export async function fetchSlackImage(
	file: SlackFileInfo,
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<RefImage | string> {
	const label = file.name || "附檔";
	const url = file.thumb_1024 || file.thumb_720 || file.url_private_download || file.url_private;
	if (!url) return `拿不到「${label}」的下載網址。`;
	const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(30_000) });
	if (!res.ok) return `下載「${label}」失敗（HTTP ${res.status}）。`;
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_BYTES) return `「${label}」超過 25MB，請傳小一點的圖。`;
	// 權限不夠時 Slack 會回 200 和登入頁的 HTML，toRefImage 會擋下來
	return toRefImage(buf, label);
}

export async function loadRefImage(src: ImageSource, botToken: string, fetchImpl?: typeof fetch): Promise<RefImage | string> {
	if (src.kind === "slack") return fetchSlackImage(src.file, botToken, fetchImpl);
	return loadLocalImage(src.path, src.label);
}
