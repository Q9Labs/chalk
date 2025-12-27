export interface ControlButtonProps {
	onClick: () => void;
	active?: boolean;
	danger?: boolean;
	label: string;
	children: React.ReactNode;
}

export function ControlButton({
	onClick,
	active = true,
	danger = false,
	label,
	children,
}: ControlButtonProps) {
	return (
		<button
			onClick={onClick}
			aria-label={label}
			title={label}
			className={`
        group relative w-12 h-12 rounded-full flex items-center justify-center
        transition-all duration-200 ease-out
        focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900
        ${
					danger
						? "bg-gradient-to-b from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 hover:shadow-red-500/40 hover:scale-105 active:scale-95"
						: active
							? "bg-slate-700/80 text-slate-200 hover:bg-slate-600/80 hover:text-white hover:scale-105 active:scale-95"
							: "bg-gradient-to-b from-red-500/90 to-red-600/90 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/30 hover:scale-105 active:scale-95"
				}
      `}
		>
			{children}
			<span className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-slate-800 text-xs text-slate-300 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
				{label}
			</span>
		</button>
	);
}
