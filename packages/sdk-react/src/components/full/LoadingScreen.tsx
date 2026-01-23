import React, { memo } from "react";
import { cn } from "../../utils/cn";

export interface LoadingScreenProps {
	message?: string;
	className?: string;
}

function LoadingScreenBase({
	message = "Loading...",
	className,
}: LoadingScreenProps): React.JSX.Element {
	return (
		<div
			data-chalk
			className={cn(
				"relative flex flex-col items-center justify-center min-h-screen bg-[var(--background)] text-[var(--primary)] overflow-hidden",
				className,
			)}
		>
			{/* Ambient background glow */}
			<div 
				className="absolute inset-0 pointer-events-none opacity-20"
				style={{
					background: "radial-gradient(circle at center, var(--primary) 0%, transparent 60%)"
				}}
			/>

			{/* Main Animation Container */}
			<div className="relative flex items-center justify-center mb-12">
				{/* Expanding Ripples */}
				<div className="absolute w-16 h-16 rounded-full border-2 border-[var(--primary)] chalk-animate-ripple" />
				<div className="absolute w-16 h-16 rounded-full border-2 border-[var(--primary)] chalk-animate-ripple" style={{ animationDelay: "0.8s" }} />
				<div className="absolute w-16 h-16 rounded-full border-2 border-[var(--primary)] chalk-animate-ripple" style={{ animationDelay: "1.6s" }} />

				{/* Outer Rotating Ring (Clockwise) */}
				<div className="absolute w-32 h-32 rounded-full border border-dashed border-[var(--primary)]/40 chalk-animate-spin-slow" />

				{/* Inner Rotating Ring (Counter-Clockwise) */}
				<div className="absolute w-24 h-24 rounded-full border-2 border-dotted border-[var(--primary)]/60 chalk-animate-spin-reverse-slow" />

				{/* Central Core */}
				<div className="relative z-10 w-16 h-16 bg-[var(--primary)]/10 rounded-full flex items-center justify-center backdrop-blur-sm chalk-animate-glow-pulse border border-[var(--primary)]/30">
					<div className="w-6 h-6 bg-[var(--primary)] rounded-full shadow-[0_0_15px_var(--primary)]" />
				</div>
			</div>

			{/* Text Message */}
			<p className="relative z-10 text-[var(--primary)] text-lg font-medium tracking-wide chalk-animate-pulse">
				{message}
			</p>
		</div>
	);
}

export const LoadingScreen = memo(LoadingScreenBase);
LoadingScreen.displayName = "LoadingScreen";
