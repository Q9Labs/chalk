import { existsSync } from "node:fs";

const WEB_DIR = new URL("..", import.meta.url).pathname;

// Desired dev flow:
// - Vite on 3070 (single origin for browser)
// - Wrangler Pages dev on 3071 (Functions runtime)
// - Vite proxies `/api/*` -> Wrangler to avoid CORS.
const vitePort = Number(process.env.VITE_PORT ?? "3070");
const pagesPort = Number(process.env.PAGES_PORT ?? "3071");

const devVarsPath = `${WEB_DIR}/.dev.vars`;
if (!existsSync(devVarsPath)) {
	// Keep output short; this is the #1 local footgun.
	console.warn(`[web] missing .dev.vars at ${devVarsPath}`);
}

const start = (cmd: string[]) => {
	const proc = Bun.spawn(cmd, {
		cwd: WEB_DIR,
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	if (proc.pid) console.log(`[web] started: ${cmd.join(" ")} (pid=${proc.pid})`);
	return proc;
};

console.log(`[web] open http://localhost:${vitePort}`);

const vite = Bun.spawn(["bunx", "vite", "dev", "--port", String(vitePort), "--strictPort"], {
	cwd: WEB_DIR,
	stdout: "inherit",
	stderr: "inherit",
	env: {
		...process.env,
		CHALK_PAGES_DEV_PORT: String(pagesPort),
	},
});
if (vite.pid)
	console.log(
		`[web] started: bunx vite dev --port ${vitePort} --strictPort (pid=${vite.pid})`,
	);

const pages = start([
	"bunx",
	"wrangler",
	"pages",
	"dev",
	"--proxy",
	String(vitePort),
	"--port",
	String(pagesPort),
]);

const shutdown = () => {
	try {
		vite.kill("SIGTERM");
	} catch {}
	try {
		pages.kill("SIGTERM");
	} catch {}
};

process.on("SIGINT", () => {
	shutdown();
	process.exit(0);
});
process.on("SIGTERM", () => {
	shutdown();
	process.exit(0);
});

await Promise.race([vite.exited, pages.exited]);
shutdown();
process.exit(1);
