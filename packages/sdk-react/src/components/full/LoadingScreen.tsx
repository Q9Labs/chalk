import React, { memo, useState, useEffect, useMemo } from "react";
import { cn } from "../../utils/cn";
import { getParticipantGradient, getParticipantColor } from "../../utils/colorGenerator";

export interface LoadingScreenProps {
	message?: string;
	className?: string;
	/** Display name or participant ID used to generate dynamic colors */
	displayName?: string; 
}

function LoadingScreenBase({
	message = "Loading...",
	className,
	displayName = "Chalk User",
}: LoadingScreenProps): React.JSX.Element {
	const [variant, setVariant] = useState<1 | 2 | 3 | 4>(1);
	const [progress, setProgress] = useState(0);

	// Shared progress timer for smooth state when switching variants
	useEffect(() => {
		const interval = setInterval(() => {
			setProgress((p) => (p >= 100 ? 0 : p + 0.3));
		}, 16); // 60fps smooth
		return () => clearInterval(interval);
	}, []);

	// Tie colors directly to the user's generated gradient palette
	const gradient = useMemo(() => getParticipantGradient(displayName), [displayName]);
	const colors = useMemo(() => getParticipantColor(displayName), [displayName]);
	const primaryColor = colors.primary;

	return (
		<div
			data-chalk
			className={cn(
				"relative flex flex-col items-center justify-center min-h-screen bg-[var(--background)] text-[var(--foreground)] overflow-hidden transition-colors duration-1000",
				className,
			)}
		>
			{/* Interactive Variant Switcher (Debug/Preview) */}
			<div className="absolute top-8 left-1/2 -translate-x-1/2 z-50 flex gap-2 p-1.5 bg-[var(--popover)]/80 backdrop-blur-xl rounded-full border border-[var(--border)] shadow-sm">
				{[1, 2, 3, 4].map((v) => (
					<button
						key={v}
						onClick={() => setVariant(v as any)}
						className={cn(
							"w-10 h-10 rounded-full text-sm font-medium transition-all duration-300 flex items-center justify-center font-mono",
							variant === v 
								? "bg-[var(--foreground)] text-[var(--background)] shadow-md scale-105" 
								: "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]"
						)}
						aria-label={`Switch to concept ${v}`}
					>
						{v}
					</button>
				))}
			</div>

			{/* Full Screen Background Renderers */}
			<div className="absolute inset-0 z-0 pointer-events-none">
				<div className={cn("absolute inset-0 transition-opacity duration-1000", variant === 1 ? "opacity-100" : "opacity-0")}>
					<Variant1 primaryColor={primaryColor} />
				</div>
				<div className={cn("absolute inset-0 transition-opacity duration-1000", variant === 2 ? "opacity-100" : "opacity-0")}>
					<Variant2 primaryColor={primaryColor} progress={progress} />
				</div>
				<div className={cn("absolute inset-0 transition-opacity duration-1000", variant === 3 ? "opacity-100" : "opacity-0")}>
					<Variant3 gradient={gradient} />
				</div>
				<div className={cn("absolute inset-0 transition-opacity duration-1000", variant === 4 ? "opacity-100" : "opacity-0")}>
					<Variant4 primaryColor={primaryColor} />
				</div>
			</div>

			{/* Foreground Typography / Branding */}
			<div className="relative z-10 flex flex-col items-center gap-6">
				{/* Chalk Logo or User Initial placeholder can go here if needed, keeping it clean for now */}
				
				<div className="flex flex-col items-center gap-3">
					<p className="text-2xl md:text-3xl font-semibold tracking-tight text-[var(--foreground)] drop-shadow-sm">
						{message}
					</p>
					
					{/* Elegant bouncing dots tied to theme */}
					<div className="flex gap-2 mt-2 opacity-80">
						<div className="w-1.5 h-1.5 rounded-full bg-[var(--foreground)] animate-bounce [animation-delay:-0.3s]" />
						<div className="w-1.5 h-1.5 rounded-full bg-[var(--foreground)] animate-bounce [animation-delay:-0.15s]" />
						<div className="w-1.5 h-1.5 rounded-full bg-[var(--foreground)] animate-bounce" />
					</div>
				</div>
			</div>
		</div>
	);
}

// Concept 1: Massive Ambient Aura
// A full-screen soft glowing orb that gently breathes
const Variant1 = memo(({ primaryColor }: { primaryColor: string }) => (
	<div className="w-full h-full flex items-center justify-center opacity-30 dark:opacity-40">
		<div 
			className="w-[120vw] h-[120vw] md:w-[80vw] md:h-[80vw] rounded-full blur-[100px] md:blur-[150px] animate-pulse [animation-duration:8s]"
			style={{ backgroundColor: primaryColor }}
		/>
	</div>
));
Variant1.displayName = "Variant1";


// Concept 2: Full-Width Cinematic Wipe/Progress
// A glowing line that spans the screen width, tracking the infinite progress
const Variant2 = memo(({ primaryColor, progress }: { primaryColor: string; progress: number }) => (
	<div className="w-full h-full flex flex-col items-center justify-center opacity-80 dark:opacity-100">
		<div 
			className="absolute inset-0 opacity-10 dark:opacity-20" 
			style={{ background: `radial-gradient(circle at center, ${primaryColor} 0%, transparent 70%)` }} 
		/>
		
		{/* The split horizon line */}
		<div className="absolute top-[60%] w-full h-[1px] bg-[var(--border)] overflow-hidden">
			<div 
				className="absolute top-0 bottom-0 h-full w-[40%] rounded-full opacity-80"
				style={{ 
					backgroundColor: primaryColor,
					boxShadow: `0 0 20px 2px ${primaryColor}`,
					left: `${progress - 40}%`, 
				}}
			/>
		</div>
	</div>
));
Variant2.displayName = "Variant2";


// Concept 3: Fluid Mesh
// Soft overlapping full-screen shapes using the participant's exact gradient
const Variant3 = memo(({ gradient }: { gradient: string }) => (
	<div className="w-full h-full opacity-20 dark:opacity-30 overflow-hidden relative">
		<div 
			className="absolute -top-[30%] -left-[10%] w-[80vw] h-[80vw] rounded-[40%] blur-[80px] md:blur-[120px] animate-pulse [animation-duration:10s]"
			style={{ background: gradient }}
		/>
		<div 
			className="absolute -bottom-[30%] -right-[10%] w-[80vw] h-[80vw] rounded-[40%] blur-[80px] md:blur-[120px] animate-pulse [animation-duration:10s] [animation-delay:-5s]"
			style={{ background: gradient }}
		/>
	</div>
));
Variant3.displayName = "Variant3";


// Concept 4: The Core Expand
// A large, centered, minimalist expanding ring system that touches the edges of the screen
const Variant4 = memo(({ primaryColor }: { primaryColor: string }) => (
	<div className="w-full h-full flex items-center justify-center opacity-20 dark:opacity-30">
		<div 
			className="absolute w-[60vw] h-[60vw] max-w-[1000px] max-h-[1000px] border border-solid rounded-full animate-ping [animation-duration:8s]"
			style={{ borderColor: primaryColor }}
		/>
		<div 
			className="absolute w-[60vw] h-[60vw] max-w-[1000px] max-h-[1000px] border border-solid rounded-full animate-ping [animation-duration:8s] [animation-delay:-4s]"
			style={{ borderColor: primaryColor }}
		/>
	</div>
));
Variant4.displayName = "Variant4";

export const LoadingScreen = memo(LoadingScreenBase);
LoadingScreen.displayName = "LoadingScreen";
