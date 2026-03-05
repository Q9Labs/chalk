import type React from "react";

import { cn } from "../../../utils/cn";

interface PreJoinJoinPanelProps {
	displayName: string;
	isLoading: boolean;
	canJoin: boolean;
	onDisplayNameChange: (value: string) => void;
	onJoin: () => void;
}

export function PreJoinJoinPanel({
	displayName,
	isLoading,
	canJoin,
	onDisplayNameChange,
	onJoin,
}: PreJoinJoinPanelProps): React.JSX.Element {
	return (
		<div className="flex flex-col items-start text-left space-y-6 w-full max-w-sm lg:justify-self-end">
			<div className="space-y-2 text-left">
				<h1 className="text-3xl lg:text-4xl font-semibold tracking-tight text-(--foreground)">
					Ready to join?
				</h1>
				<p className="text-(--muted-foreground) text-base">
					You'll be in a waiting room before entering the call
				</p>
			</div>

			<div className="w-full space-y-4">
				<div className="w-full">
					<label htmlFor="display-name" className="sr-only">
						Display Name
					</label>
					<input
						id="display-name"
						type="text"
						value={displayName}
						onChange={(event) => onDisplayNameChange(event.target.value)}
						placeholder="Enter your name"
						disabled={isLoading}
						className={cn(
							"w-full h-12 px-4 rounded-xl text-base transition-all outline-none text-(--foreground) placeholder:text-(--muted-foreground) disabled:opacity-50",
							"border bg-[var(--chalk-lobby-glass-bg)] backdrop-blur-md shadow-sm",
							"border-[var(--chalk-lobby-glass-border)]",
							"focus-visible:border-[#1bb6a6] focus-visible:ring-4 focus-visible:ring-[#1bb6a6]/20 focus-visible:shadow-[0_0_15px_rgba(27,182,166,0.1)]",
						)}
					/>
				</div>

				<button
					type="button"
					onClick={onJoin}
					disabled={!canJoin || isLoading}
					className={cn(
						"relative w-full h-12 rounded-full font-semibold text-base text-white transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 overflow-hidden group",
						"outline-none focus-visible:ring-4 focus-visible:ring-[#1bb6a6]/30",
					)}
					style={{
						background: "linear-gradient(135deg, #1bb6a6 0%, #14a89a 50%, #0d9488 100%)",
						boxShadow:
							"0 4px 14px rgba(27, 182, 166, 0.4), inset 0 1px 0 rgba(255,255,255,0.2)",
					}}
				>
					<div
						className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
						style={{
							background:
								"linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)",
							backgroundSize: "200% 100%",
							animation: "chalk-shimmer 1.5s ease-in-out infinite",
						}}
					/>
					<span className="relative z-10 flex items-center gap-2">
						{isLoading ? "Joining..." : "Ask to join"}
					</span>
				</button>
			</div>
		</div>
	);
}
