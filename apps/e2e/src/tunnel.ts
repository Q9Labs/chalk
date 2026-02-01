import { poll } from "./poll";

export type Tunnel = {
	publicUrl: string;
	kill: () => void;
};

export async function startTunnel(opts: { port: number; timeoutMs: number }): Promise<Tunnel> {
	const proc = Bun.spawn(
		["cloudflared", "tunnel", "--url", `http://localhost:${opts.port}`],
		{
			stderr: "pipe",
			stdout: "pipe",
		},
	);

	let buffer = "";
	let publicUrl: string | null = null;
	let exitCode: number | null = null;
	void proc.exited.then((value: any) => {
		if (typeof value === "number") {
			exitCode = value;
			return;
		}
		const candidate = value?.exitCode;
		if (typeof candidate === "number") {
			exitCode = candidate;
			return;
		}
		// Unknown shape; treat as exited to avoid hanging forever.
		exitCode = 0;
	});

	const readStream = async (stream: ReadableStream<Uint8Array> | null) => {
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value);
			const match = buffer.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
			if (match?.[0]) {
				publicUrl = match[0];
				break;
			}
		}
	};

	// Start reading in background
	void readStream(proc.stderr);
	void readStream(proc.stdout);

	const url = await poll<string>({
		timeoutMs: opts.timeoutMs,
		intervalMs: 200,
		action: async () => {
			if (publicUrl) return publicUrl;
			if (exitCode !== null) {
				throw new Error(`cloudflared exited early with code ${exitCode}`);
			}
			return null;
		},
	});

	return {
		publicUrl: url,
		kill: () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				// ignore
			}
		},
	};
}
