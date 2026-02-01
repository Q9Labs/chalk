export type Cleanup = () => Promise<void> | void;

export function registerTeardown(cleanup: Cleanup): () => void {
	let ran = false;
	const runOnce = async () => {
		if (ran) return;
		ran = true;
		await cleanup();
	};

	const onSigint = () => void runOnce().finally(() => process.exit(130));
	const onSigterm = () => void runOnce().finally(() => process.exit(143));

	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	return () => {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	};
}

