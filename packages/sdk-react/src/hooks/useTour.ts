export interface TourStep {
  id?: string;
  title: string;
  content?: string;
  description: string;
  target: string;
  placement?: "left" | "right" | "bottom" | "top";
}
export const DEFAULT_MEETING_TOUR_STEPS: TourStep[] = [];
export function useTour(_steps: TourStep[] = DEFAULT_MEETING_TOUR_STEPS): any {
  return { currentStep: null, currentStepIndex: -1, isActive: false, start: () => {}, next: () => {}, previous: () => {}, skip: () => {}, complete: () => {} };
}
