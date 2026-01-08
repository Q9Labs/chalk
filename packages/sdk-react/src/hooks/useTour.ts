import { useCallback, useEffect, useState } from "react";

export interface TourStep {
	target: string;
	title: string;
	description: string;
	placement?: "top" | "bottom" | "left" | "right";
	action?: "click" | "hover" | "focus";
	nextTrigger?: "button" | "action" | "auto";
	delay?: number;
	spotlight?: boolean;
}

export interface UseTourOptions {
	steps: TourStep[];
	onComplete?: () => void;
	onSkip?: () => void;
	onStepChange?: (step: number) => void;
	storageKey?: string;
}

export interface UseTourReturn {
	isOpen: boolean;
	currentStep: number;
	currentStepData: TourStep | null;
	totalSteps: number;
	start: () => void;
	stop: () => void;
	next: () => void;
	prev: () => void;
	goTo: (step: number) => void;
	skip: () => void;
	complete: () => void;
	hasCompleted: boolean;
	reset: () => void;
}

export function useTour(options: UseTourOptions): UseTourReturn {
	const {
		steps,
		onComplete,
		onSkip,
		onStepChange,
		storageKey = "chalk-tour-completed",
	} = options;

	const [isOpen, setIsOpen] = useState(false);
	const [currentStep, setCurrentStep] = useState(0);
	const [hasCompleted, setHasCompleted] = useState(() => {
		if (typeof window === "undefined") return false;
		return localStorage.getItem(storageKey) === "true";
	});

	const totalSteps = steps.length;
	const currentStepData =
		isOpen && currentStep < totalSteps ? (steps[currentStep] ?? null) : null;

	const start = useCallback(() => {
		setCurrentStep(0);
		setIsOpen(true);
	}, []);

	const stop = useCallback(() => {
		setIsOpen(false);
	}, []);

	const next = useCallback(() => {
		if (currentStep < totalSteps - 1) {
			setCurrentStep((prev) => prev + 1);
		} else {
			// Last step - complete the tour
			setIsOpen(false);
			setHasCompleted(true);
			if (typeof window !== "undefined") {
				localStorage.setItem(storageKey, "true");
			}
			onComplete?.();
		}
	}, [currentStep, totalSteps, storageKey, onComplete]);

	const prev = useCallback(() => {
		if (currentStep > 0) {
			setCurrentStep((prev) => prev - 1);
		}
	}, [currentStep]);

	const goTo = useCallback(
		(step: number) => {
			if (step >= 0 && step < totalSteps) {
				setCurrentStep(step);
			}
		},
		[totalSteps],
	);

	const skip = useCallback(() => {
		setIsOpen(false);
		onSkip?.();
	}, [onSkip]);

	const complete = useCallback(() => {
		setIsOpen(false);
		setHasCompleted(true);
		if (typeof window !== "undefined") {
			localStorage.setItem(storageKey, "true");
		}
		onComplete?.();
	}, [storageKey, onComplete]);

	const reset = useCallback(() => {
		setHasCompleted(false);
		setCurrentStep(0);
		if (typeof window !== "undefined") {
			localStorage.removeItem(storageKey);
		}
	}, [storageKey]);

	// Notify on step change
	useEffect(() => {
		if (isOpen) {
			onStepChange?.(currentStep);
		}
	}, [currentStep, isOpen, onStepChange]);

	return {
		isOpen,
		currentStep,
		currentStepData,
		totalSteps,
		start,
		stop,
		next,
		prev,
		goTo,
		skip,
		complete,
		hasCompleted,
		reset,
	};
}

// Default meeting tour steps
export const DEFAULT_MEETING_TOUR_STEPS: TourStep[] = [
	{
		target: '[data-tour="video-grid"]',
		title: "Video Grid",
		description:
			"This is where you'll see all meeting participants. Click any tile to pin it.",
		placement: "bottom",
		spotlight: true,
	},
	{
		target: '[data-tour="local-video"]',
		title: "Your Video",
		description:
			"Your camera preview. Others can see you when your video is on.",
		placement: "bottom",
		spotlight: true,
	},
	{
		target: '[data-tour="mute-button"]',
		title: "Mute/Unmute",
		description: "Press M or click to mute/unmute your microphone.",
		placement: "top",
		spotlight: true,
	},
	{
		target: '[data-tour="video-button"]',
		title: "Video Toggle",
		description: "Press V or click to turn your camera on/off.",
		placement: "top",
		spotlight: true,
	},
	{
		target: '[data-tour="screenshare-button"]',
		title: "Screen Share",
		description: "Share your screen or a specific window with participants.",
		placement: "top",
		spotlight: true,
	},
	{
		target: '[data-tour="chat-button"]',
		title: "Chat",
		description: "Send messages to everyone in the meeting.",
		placement: "top",
		spotlight: true,
	},
	{
		target: '[data-tour="participants-button"]',
		title: "Participants",
		description: "See who's in the meeting and manage participants.",
		placement: "top",
		spotlight: true,
	},
	{
		target: '[data-tour="reactions-button"]',
		title: "Reactions",
		description: "Send emoji reactions visible to everyone.",
		placement: "top",
		spotlight: true,
	},
	{
		target: '[data-tour="leave-button"]',
		title: "Leave Meeting",
		description: "Click here when you're ready to leave the meeting.",
		placement: "top",
		spotlight: true,
	},
];
