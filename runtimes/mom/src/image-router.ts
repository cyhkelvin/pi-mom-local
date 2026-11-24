import { createImageRouter, type ImageConfig, type ImageNotifier, type ImageSupervisor } from "@pi-mom-local/image-router";

/**
 * mom 唯一的產圖 router（GPU 只有一張）。工具和 Slack 層都從這裡拿。
 * IMAGE_ENABLED 沒開時 supervisor 是 null，所有產圖相關的入口都會回「產圖功能沒有啟用」。
 * 產圖本身在 packages/image-router，這裡只負責保管實例和行程結束時收掉 sd-server。
 */
let supervisor: ImageSupervisor | null = null;
let config: ImageConfig | null = null;

export function getImageSupervisor(): ImageSupervisor | null {
	return supervisor;
}

export function getImageConfig(): ImageConfig | null {
	return config;
}

export function initImageRouter(opts: {
	notifier: ImageNotifier;
	isChatBusy: () => boolean;
	log: (msg: string) => void;
	env?: NodeJS.ProcessEnv;
}): ImageSupervisor | null {
	const router = createImageRouter(opts);
	config = router.config;
	supervisor = router.supervisor;
	// mom 不管怎麼結束，都要把 sd-server 帶走（'exit' 裡只能做同步的事）
	if (supervisor) process.on("exit", () => supervisor?.shutdownSync());
	return supervisor;
}
