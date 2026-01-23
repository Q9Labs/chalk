import { ArrowRight01Icon, Pin01Icon, Cancel01Icon } from "../../utils/icons";
import React from "react";
import { cn } from "../../utils/cn";
import { IconButton } from "../atomic/IconButton";

export interface PinnedMessageBannerProps {
	message: {
		content: string;
		senderName: string;
		timestamp: Date;
	};
	onUnpin?: () => void;
	onJumpToMessage?: () => void;
	className?: string;
}

export const PinnedMessageBanner = React.memo<PinnedMessageBannerProps>(
	({ message, onUnpin, onJumpToMessage, className }) => {
		return (
			<div
				className={cn(
					"flex items-center gap-3 p-3 bg-muted border-b border-border text-sm",
					className,
				)}
			>
				<div className="flex-shrink-0 text-accent-foreground">
					<Pin01Icon size={16} className="fill-current" />
				</div>

				<div
					className="flex-1 min-w-0 cursor-pointer"
					onClick={onJumpToMessage}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							onJumpToMessage?.();
						}
					}}
				>
					<div className="font-semibold text-foreground">
						Pinned Message
					</div>
					<div className="text-muted-foreground truncate">
						<span className="font-medium mr-1">{message.senderName}:</span>
						{message.content}
					</div>
				</div>

				<div className="flex items-center gap-1">
					{onJumpToMessage && (
						<IconButton
							icon={<ArrowRight01Icon size={16} />}
							variant="ghost"
							size="sm"
							onClick={onJumpToMessage}
							aria-label="Jump to message"
						/>
					)}
					{onUnpin && (
						<IconButton
							icon={<Cancel01Icon size={16} />}
							variant="ghost"
							size="sm"
							onClick={onUnpin}
							aria-label="Unpin message"
						/>
					)}
				</div>
			</div>
		);
	},
);

PinnedMessageBanner.displayName = "PinnedMessageBanner";
