/**
 * @pi-mom-local/image-router：本機產圖（FLUX.2 Klein 經 stable-diffusion.cpp 的 sd-server），
 * 和對話模型（ollama）輪流使用同一張 GPU。不綁定任何聊天介面：發訊息、上傳圖片等動作
 * 由 runtime 實作 ImageNotifier 傳進來。架構見 repo 的 docs/architecture.md。
 */
import { buildServerArgs, type ImageConfig, loadImageConfig } from "./config.js";
import { createGpuOps } from "./gpu.js";
import { SdClient } from "./sd-client.js";
import { cleanupStaleServer, SdServerProcess } from "./server-process.js";
import { type ImageNotifier, ImageSupervisor } from "./supervisor.js";

export {
	checkEditPrompt,
	controlWord,
	EDIT_USAGE,
	editSize,
	formatLoraList,
	type ImageParams,
	isEditCommand,
	isImgCommand,
	isLoraListCommand,
	isSexualEdit,
	normalizeEditParams,
	normalizeParams,
	parseEditCommand,
	parseImgCommand,
	type RawImageArgs,
	type RefImage,
	resolveLora,
} from "./commands.js";
export { buildServerArgs, type ImageConfig, listLoras, loadImageConfig, loraFileError, loraRequestPath } from "./config.js";
export { imageInfo, loadLocalImage, toRefImage } from "./ref-image.js";
export {
	failureEventText,
	type FailureInfo,
	type ImageJob,
	type ImageNotifier,
	ImageSupervisor,
	type JobOrigin,
	type SubmitResult,
} from "./supervisor.js";

export interface ImageRouter {
	config: ImageConfig;
	/** IMAGE_ENABLED 沒開時是 null */
	supervisor: ImageSupervisor | null;
}

/**
 * 依環境變數（IMAGE_*）組出產圖 router。GPU 只有一張，一個行程只應該建立一次；
 * 保管這個實例、在行程結束時呼叫 supervisor.shutdownSync() 是 runtime 的責任。
 */
export function createImageRouter(opts: {
	notifier: ImageNotifier;
	/** 有沒有任何對話正在使用對話模型（正在用 GPU） */
	isChatBusy: () => boolean;
	log: (msg: string) => void;
	env?: NodeJS.ProcessEnv;
}): ImageRouter {
	const config = loadImageConfig(opts.env);
	if (!config.enabled) return { config, supervisor: null };

	const stale = cleanupStaleServer(config.pidPath);
	if (stale) opts.log(`清掉上次殘留的 sd-server（PID ${stale}）`);

	const supervisor = new ImageSupervisor({
		cfg: config,
		client: new SdClient(`http://${config.host}:${config.port}`),
		server: new SdServerProcess(config.serverBin, buildServerArgs(config), config.pidPath, config.logPath),
		gpu: createGpuOps(config.ollamaBaseUrl, config.llmModel),
		notifier: opts.notifier,
		isChatBusy: opts.isChatBusy,
		log: opts.log,
	});
	return { config, supervisor };
}
