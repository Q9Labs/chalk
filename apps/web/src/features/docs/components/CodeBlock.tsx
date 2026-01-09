import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

interface CodeBlockProps {
	children: string;
	language?: string;
	filename?: string;
}

export function CodeBlock({
	children,
	language = "typescript",
	filename,
}: CodeBlockProps) {
	const [html, setHtml] = useState<string>("");
	const [copied, setCopied] = useState(false);
	const [isDark, setIsDark] = useState(false);
	const code = typeof children === "string" ? children.trim() : "";

	// Detect and track dark mode from document class
	useEffect(() => {
		const checkDark = () => {
			setIsDark(document.documentElement.classList.contains("dark"));
		};
		checkDark();

		// Watch for class changes on html element
		const observer = new MutationObserver(checkDark);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let mounted = true;

		async function highlight() {
			// Skip Shiki for plain text - render directly
			if (language === "text" || language === "plaintext" || !language) {
				if (mounted) {
					setHtml(`<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`);
				}
				return;
			}

			try {
				const highlighted = await codeToHtml(code, {
					lang: language,
					theme: isDark ? "github-dark" : "github-light",
				});
				if (mounted) {
					setHtml(highlighted);
				}
			} catch {
				// Fallback for unsupported languages
				if (mounted) {
					setHtml(`<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`);
				}
			}
		}

		highlight();
		return () => {
			mounted = false;
		};
	}, [code, language, isDark]);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(code);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="my-6 rounded-lg border border-border overflow-hidden bg-muted/50">
			{filename && (
				<div className="px-4 py-2 border-b border-border bg-muted/80 text-sm text-muted-foreground font-mono">
					{filename}
				</div>
			)}
			<div className="relative group">
				<button
					type="button"
					onClick={handleCopy}
					className="absolute right-2 top-2 p-2 rounded-md bg-background/80 hover:bg-background border border-border opacity-0 group-hover:opacity-100 transition-opacity"
					aria-label={copied ? "Copied!" : "Copy code"}
				>
					{copied ? (
						<Check size={16} className="text-green-500" />
					) : (
						<Copy size={16} className="text-muted-foreground" />
					)}
				</button>

				{html ? (
					<div
						className="[&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:text-sm [&_pre]:leading-relaxed [&_pre]:m-0 [&_.shiki]:bg-transparent [&_code]:bg-transparent"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki generates safe HTML
						dangerouslySetInnerHTML={{ __html: html }}
					/>
				) : (
					<pre className="p-4 overflow-x-auto text-sm leading-relaxed m-0">
						<code>{code}</code>
					</pre>
				)}
			</div>
		</div>
	);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
