import { toast } from "sonner";

export const createDebugId = (): string => {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const toDiagnosticText = (
	payload: Record<string, unknown>,
	fallbackTitle: string,
): string => {
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return `${fallbackTitle}\nid: ${String(payload.debugId ?? "unknown")}`;
	}
};

export const copyToClipboard = async (text: string): Promise<void> => {
	try {
		await navigator.clipboard.writeText(text);
		return;
	} catch {
		const textArea = document.createElement("textarea");
		textArea.value = text;
		document.body.appendChild(textArea);
		textArea.select();
		document.execCommand("copy");
		document.body.removeChild(textArea);
	}
};

export const showCopyableErrorToast = (
	message: string,
	buildCopyText: () => string,
): void => {
	toast.error(message, {
		duration: 15000,
		action: {
			label: "Copy error",
			onClick: () => {
				void (async () => {
					await copyToClipboard(buildCopyText());
					toast.success("Copied error details", { duration: 2500 });
				})();
			},
		},
	});
};
