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
	// Determine background color based on state
	// danger = always red
	// !active (e.g. muted) = red
	// active (normal) = dark grey
	const isRed = danger || !active;

	return (
		<button
			onClick={onClick}
			aria-label={label}
			title={label}
			className={`
        group relative w-10 h-10 rounded-full flex items-center justify-center
        transition-all duration-200 ease-out
        focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
        ${
					isRed
						? "bg-red-600 text-white hover:bg-red-700 border-transparent"
						: "bg-[#3c4043] text-white hover:bg-[#43474b] border border-transparent hover:border-gray-500"
				}
      `}
		>
			{children}
			<span className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-[#202124] text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-sm border border-white/10 z-50">
				{label}
			</span>
		</button>
	);
}
