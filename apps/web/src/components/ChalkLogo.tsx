import { cn } from "../lib/utils";

interface ChalkLogoProps {
	className?: string;
	showText?: boolean;
}

export function ChalkLogo({ className, showText = true }: ChalkLogoProps) {
	return (
		<div className={cn("flex items-center gap-3", className)}>
			<svg
				width="32"
				height="32"
				viewBox="0 0 64 64"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				className="shrink-0"
			>
				{/* Green chalk */}
				<g transform="rotate(-20 16 48)">
					<rect x="8" y="16" width="12" height="40" rx="6" fill="#A8D5A2" />
					<ellipse cx="14" cy="16" rx="6" ry="3.5" fill="#8BC585" />
				</g>

				{/* Yellow chalk */}
				<g transform="rotate(-5 24 44)">
					<rect x="18" y="12" width="12" height="44" rx="6" fill="#F5D76E" />
					<ellipse cx="24" cy="12" rx="6" ry="3.5" fill="#E8C85A" />
				</g>

				{/* Blue chalk */}
				<g transform="rotate(25 44 20)">
					<rect x="28" y="4" width="12" height="42" rx="6" fill="#7EC8E3" />
					<ellipse cx="34" cy="4" rx="6" ry="3.5" fill="#5FB8D9" />
				</g>

				{/* Pink chalk */}
				<g transform="rotate(10 44 40)">
					<rect x="38" y="18" width="12" height="38" rx="6" fill="#F0A0A0" />
					<ellipse cx="44" cy="56" rx="6" ry="3.5" fill="#E88888" />
				</g>
			</svg>
			{showText && (
				<span className="text-2xl font-black tracking-tighter leading-none text-foreground">
					chalk
				</span>
			)}
		</div>
	);
}
