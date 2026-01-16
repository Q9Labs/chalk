import React from "react";
import { cn } from "../../utils/cn";
import { Tooltip } from "./Tooltip";

interface ControlButtonProps {
	icon: React.ReactNode;
	label: string;
	active?: boolean;
	danger?: boolean;
	disabled?: boolean;
	size?: "sm" | "md" | "lg";
	showLabel?: boolean;
	noBorder?: boolean;
	onClick?: () => void;
	className?: string;
	"data-tour"?: string;
}

export const ControlButton = React.memo(
	React.forwardRef<HTMLButtonElement, ControlButtonProps>(
		(
			{
				icon,
				label,
				active = false,
				danger = false,
				disabled = false,
				size = "md",
				showLabel = false,
				noBorder = false,
				onClick,
				className,
				"data-tour": dataTour,
			},
			ref,
		) => {
			const button = (
				<button
					ref={ref}
					type="button"
					onClick={onClick}
					disabled={disabled}
					data-tour={dataTour}
					className={cn(
						"group relative flex items-center justify-center text-white transition-all duration-300 ease-out",
						size === "md" ? "h-[44px] w-[44px] rounded-full" : "h-14 w-14 rounded-full",
						disabled && "cursor-not-allowed opacity-50",
						// Default state (Purple Gradient)
						!disabled && !active && !danger && !noBorder && "shadow-lg hover:brightness-110 bg-[#151515]",
						// No Border state (Ghost)
						!disabled && !active && !danger && noBorder && "bg-[#151515]",
						
						!disabled &&
							active &&
							"bg-[#151515] text-white border-transparent hover:bg-[#252525]",
						danger && "bg-[#EF4444] text-white border-transparent hover:bg-[#DC2626]",
						className,
					)}
					aria-label={label}
					aria-pressed={active}
				>
					{icon}
				</button>
			);

			if (showLabel) {
				return (
					<div className="flex flex-col items-center gap-1">
						{button}
						<span className="text-[var(--chalk-font-size-xs)] text-white/80">
							{label}
						</span>
					</div>
				);
			}

			return (
				<Tooltip content={label} position="top">
					{button}
				</Tooltip>
			);
		},
	),
);

ControlButton.displayName = "ControlButton";
