import { type ChildProcess, execFileSync, spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, type WriteStream, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * sd-server 子程序的生命週期。
 *
 * 規則：
 * - sd-server 只會由 mom 啟動，pid 記在 pidfile。
 * - mom 結束（正常、SIGINT、SIGTERM、未捕捉例外）時一定要把它帶走，
 *   否則它會繼續佔著 VRAM，ollama 就只能用 CPU 跑。
 * - mom 啟動時如果 pidfile 指向一個還活著的 sd-server（上次沒收乾淨），先 kill 掉。
 */
export interface ServerProcess {
	isRunning(): boolean;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** 同步強制結束（給 process 'exit' handler 用，那裡不能 await）。 */
	killSync(): void;
	/** 最近的輸出（stdout+stderr），給錯誤訊息用。 */
	tail(lines?: number): string;
	/** 本次執行中途有沒有意外結束；回傳結束原因或 null。 */
	exitReason(): string | null;
}

const RING = 300;

export class SdServerProcess implements ServerProcess {
	private child: ChildProcess | null = null;
	private ring: string[] = [];
	private exited: string | null = null;
	private logStream: WriteStream | null = null;

	constructor(
		private bin: string,
		private args: string[],
		private pidPath: string,
		private logPath: string,
	) {}

	isRunning(): boolean {
		return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
	}

	exitReason(): string | null {
		return this.exited;
	}

	tail(lines = 20): string {
		return this.ring.slice(-lines).join("\n");
	}

	private push(chunk: Buffer): void {
		const text = chunk.toString("utf-8");
		this.logStream?.write(text);
		// sd.cpp 的進度條用 \r 覆寫同一行，拆開才看得到最後狀態
		for (const line of text.split(/\r|\n/)) {
			const t = line.trim();
			if (!t) continue;
			this.ring.push(t);
			if (this.ring.length > RING) this.ring.shift();
		}
	}

	async start(): Promise<void> {
		if (this.isRunning()) return;
		if (!existsSync(this.bin)) {
			throw new Error(`找不到 sd-server：${this.bin}（設定 IMAGE_SD_SERVER_BIN，或見 packages/image-router/README.md 的「編譯 sd-server」）`);
		}
		mkdirSync(dirname(this.logPath), { recursive: true });
		this.logStream = createWriteStream(this.logPath, { flags: "a" });
		this.logStream.write(`\n===== ${new Date().toISOString()} start ${this.bin} ${this.args.join(" ")}\n`);
		this.exited = null;
		this.ring = [];
		const child = spawn(this.bin, this.args, { stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;
		child.stdout?.on("data", (c: Buffer) => this.push(c));
		child.stderr?.on("data", (c: Buffer) => this.push(c));
		child.on("exit", (code, signal) => {
			this.exited = signal ? `被 ${signal} 結束` : `exit code ${code}`;
			this.logStream?.write(`===== exit ${this.exited}\n`);
			this.logStream?.end();
			this.logStream = null;
			rmSync(this.pidPath, { force: true });
		});
		child.on("error", (err) => {
			this.exited = `無法啟動：${err.message}`;
		});
		if (child.pid) {
			mkdirSync(dirname(this.pidPath), { recursive: true });
			writeFileSync(this.pidPath, String(child.pid));
		}
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child || !this.isRunning()) {
			this.child = null;
			return;
		}
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// 已經結束
				}
				setTimeout(resolve, 500);
			}, 3000);
			child.once("exit", done);
			child.kill("SIGTERM");
		});
		this.child = null;
		rmSync(this.pidPath, { force: true });
	}

	killSync(): void {
		if (this.child?.pid && this.isRunning()) {
			try {
				process.kill(this.child.pid, "SIGKILL");
			} catch {
				// 已經結束
			}
		}
		rmSync(this.pidPath, { force: true });
	}
}

/**
 * 啟動時清掉上次殘留的 sd-server。只 kill 指令列裡確實有 sd-server 的程序，
 * 避免 pid 被系統重用時誤殺別的程式。回傳被清掉的 pid 或 null。
 */
export function cleanupStaleServer(pidPath: string): number | null {
	if (!existsSync(pidPath)) return null;
	const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
	rmSync(pidPath, { force: true });
	if (!Number.isFinite(pid) || pid <= 1) return null;
	try {
		// /proc 只有 Linux 有；macOS 用 ps
		const cmdline = existsSync(`/proc/${pid}/cmdline`)
			? readFileSync(`/proc/${pid}/cmdline`, "utf-8")
			: execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" });
		if (!cmdline.includes("sd-server")) return null;
		process.kill(pid, "SIGKILL");
		return pid;
	} catch {
		return null;
	}
}
