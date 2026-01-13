import React, { memo } from "react";
import { Spinner } from "../atomic";
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
			className={cn(
				"flex flex-col items-center justify-center min-h-screen bg-[var(--chalk-bg-primary)] text-[var(--chalk-brand)]",
				className,
			)}
		>
			<Spinner size="lg" />
			<p className="mt-4 text-[var(--chalk-brand)] text-sm animate-pulse">
				{message}
			</p>
		</div>
	);
}

export const LoadingScreen = memo(LoadingScreenBase);
LoadingScreen.displayName = "LoadingScreen";
