import React, { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import { cn } from "../../utils/cn";
import { Cancel01Icon, SparklesIcon } from "../../utils/icons";
import { IconButton } from "../atomic/IconButton";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import type { WhatsNewData } from "../../hooks/ui/useWhatsNew";

export interface WhatsNewDialogProps {
	/** Whether the dialog is open */
	isOpen: boolean;
	/** Close handler (should also call markAsSeen) */
	onClose: () => void;
	/** The release data to display */
	data: WhatsNewData;
	/** Additional class names */
	className?: string;
}

/**
 * Dialog showing recent release notes
 *
 * @example
 * ```tsx
 * const { isOpen, close, markAsSeen, data } = useWhatsNew();
 *
 * const handleClose = () => {
 *   close();
 *   markAsSeen();
 * };
 *
 * {isOpen && data && (
 *   <WhatsNewDialog isOpen={isOpen} onClose={handleClose} data={data} />
 * )}
 * ```
 */
export const WhatsNewDialog = React.memo<WhatsNewDialogProps>(
	({ isOpen, onClose, data, className }) => {
		const prefersReducedMotion = usePrefersReducedMotion();
		const modalRef = useRef<HTMLDivElement>(null);

		// Handle escape key
		useEffect(() => {
			const handleEscape = (e: KeyboardEvent) => {
				if (e.key === "Escape" && isOpen) {
					onClose();
				}
			};
			document.addEventListener("keydown", handleEscape);
			return () => document.removeEventListener("keydown", handleEscape);
		}, [isOpen, onClose]);

		// Focus trap
		useEffect(() => {
			if (isOpen && modalRef.current) {
				modalRef.current.focus();
			}
		}, [isOpen]);

		if (!isOpen) return null;

		const publishedDate = new Date(data.published_at);
		const formattedDate = publishedDate.toLocaleDateString("en-US", {
			month: "long",
			year: "numeric",
		});

		return (
			<div
				className={cn(
					"fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm",
					"bg-background/80",
					className
				)}
				role="dialog"
				aria-modal="true"
				aria-labelledby="whats-new-title"
			>
				<div
					ref={modalRef}
					tabIndex={-1}
					className={cn(
						"w-full max-w-2xl overflow-hidden rounded-xl shadow-lg",
						"bg-card",
						"border border-border",
						"flex flex-col max-h-[85vh]",
						!prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-200"
					)}
				>
					{/* Header */}
					<div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
						<div className="flex items-center gap-3">
							<div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
								<SparklesIcon size={20} className="text-primary" />
							</div>
							<div>
								<h2
									id="whats-new-title"
									className="text-lg font-semibold text-card-foreground"
								>
									What's New in v{data.version}
								</h2>
								<p className="text-sm text-muted-foreground">{formattedDate}</p>
							</div>
						</div>
						<IconButton
							icon={<Cancel01Icon size={20} />}
							variant="ghost"
							onClick={onClose}
							aria-label="Close"
						/>
					</div>

					{/* Content */}
					<div className="flex-1 overflow-y-auto">
						<div className={cn("flex", data.image_url ? "flex-col md:flex-row" : "")}>
							{/* Image (optional) */}
							{data.image_url && (
								<div className="w-full md:w-2/5 shrink-0 bg-muted">
									<img
										src={data.image_url}
										alt={`What's new in version ${data.version}`}
										className="w-full h-48 md:h-full object-cover"
									/>
								</div>
							)}

							{/* Markdown content */}
							<div
								className={cn(
									"p-6",
									"prose prose-sm dark:prose-invert max-w-none",
									"prose-headings:text-card-foreground prose-headings:font-semibold",
									"prose-h2:text-base prose-h2:mt-4 prose-h2:mb-2",
									"prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1",
									"prose-p:text-muted-foreground prose-p:leading-relaxed",
									"prose-li:text-muted-foreground",
									"prose-strong:text-card-foreground prose-strong:font-medium",
									"prose-a:text-primary hover:prose-a:underline",
									data.image_url ? "md:w-3/5" : "w-full"
								)}
							>
								<Markdown>{data.content}</Markdown>
							</div>
						</div>
					</div>

					{/* Footer */}
					<div className="flex justify-end px-6 py-4 border-t border-border shrink-0">
						<button
							onClick={onClose}
							className={cn(
								"px-6 py-2 rounded-lg font-medium transition-colors",
								"bg-primary text-primary-foreground",
								"hover:opacity-90",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							)}
						>
							Got it!
						</button>
					</div>
				</div>
			</div>
		);
	}
);

WhatsNewDialog.displayName = "WhatsNewDialog";
