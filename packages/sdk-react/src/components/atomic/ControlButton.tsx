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
						"group relative flex items-center justify-center transition-all duration-300 ease-out",
						"text-[var(--foreground,var(--chalk-text-primary))]",
						size === "sm" && "h-9 w-9 rounded-full",
						size === "md" && "h-11 w-11 rounded-full",
						size === "lg" && "h-14 w-14 rounded-full",
						disabled && "cursor-not-allowed opacity-50",
						// Default state
						!disabled && !active && !danger && !noBorder &&
							"bg-[var(--secondary,var(--chalk-bg-secondary))] shadow-lg hover:brightness-110",
						// No Border state (Ghost)
						!disabled && !active && !danger && noBorder &&
							"bg-[var(--secondary,var(--chalk-bg-secondary))]",
						// Active state
						!disabled && active &&
							"bg-[var(--secondary,var(--chalk-bg-secondary))] border-transparent hover:bg-[var(--accent,var(--chalk-bg-tertiary))]",
						// Danger state
						danger && "bg-[var(--destructive,var(--chalk-danger))] text-[var(--destructive-foreground,#fff)] border-transparent hover:opacity-90",
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
						<span className="text-xs text-[var(--muted-foreground,var(--chalk-text-secondary))]">
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
