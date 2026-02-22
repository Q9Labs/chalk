import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const clientDir = resolve(process.cwd(), "dist", "client");
const shellPath = resolve(clientDir, "_shell.html");
const indexPath = resolve(clientDir, "index.html");

if (!existsSync(shellPath)) {
	throw new Error(
		`missing ${shellPath}; expected TanStack Start SPA build output to include _shell.html`,
	);
}

// Cloudflare Pages: ensure deep-link loads SPA shell (even if rewrites are not applied).
cpSync(shellPath, indexPath);
