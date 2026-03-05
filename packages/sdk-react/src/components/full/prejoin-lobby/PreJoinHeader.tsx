import type React from "react";

import { Moon02Icon, Sun02Icon } from "../../../utils/icons";

interface PreJoinHeaderProps {
	roomName?: string;
	isDarkMode: boolean;
	onToggleTheme: () => void;
}

export function PreJoinHeader({
	roomName,
	isDarkMode,
	onToggleTheme,
}: PreJoinHeaderProps): React.JSX.Element {
	return (
		<div className="flex justify-between items-center px-6 py-5 w-full max-w-6xl mx-auto">
			<div className="flex items-center gap-3">
				<img src="/chalk-logo.svg" alt="Chalk" className="h-8 w-auto" draggable={false} />
				{roomName && (
					<>
						<div className="w-px h-6 bg-border/50 mx-1" />
						<span className="text-sm font-medium text-(--muted-foreground) truncate max-w-[200px]">
							{roomName}
						</span>
					</>
				)}
			</div>

			<button
				type="button"
				onClick={onToggleTheme}
				title={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
				aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
				className="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/10 text-(--foreground)"
			>
				{isDarkMode ? <Sun02Icon size={20} /> : <Moon02Icon size={20} />}
			</button>
		</div>
	);
}
