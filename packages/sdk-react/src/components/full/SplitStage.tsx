// @ts-nocheck
"use client";

import { useCallback, useMemo, useState } from "react";
import * as resizablePanelsPkg from "react-resizable-panels";
import { cn } from "../../utils/cn";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	MoreVerticalIcon,
} from "../../utils/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui";

const { Group, Panel, Separator, useDefaultLayout, useGroupRef, usePanelRef } =
	resizablePanelsPkg as any;

interface SplitStageProps {
	leftPanel: React.ReactNode;
	rightPanel: React.ReactNode;
	className?: string;
	onLayoutChange?: (sizes: number[]) => void;
}

export function SplitStage({
	leftPanel,
	rightPanel,
	className,
	onLayoutChange,
}: SplitStageProps) {
	const leftPanelId = "chalk-split-left";
	const rightPanelId = "chalk-split-right";
	const defaultLayoutId = "chalk-split-view";

	const groupRef = useGroupRef();
	const leftPanelRef = usePanelRef();
	const rightPanelRef = usePanelRef();
	const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
	const [isRightCollapsed, setIsRightCollapsed] = useState(false);

	const panelIds = useMemo(() => [leftPanelId, rightPanelId], []);
	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: defaultLayoutId,
		panelIds,
	});

	const handleLayoutChanged = useCallback(
		(layout: Record<string, number>) => {
			onLayoutChanged?.(layout);
			onLayoutChange?.([layout[leftPanelId] ?? 0, layout[rightPanelId] ?? 0]);
		},
		[leftPanelId, onLayoutChange, onLayoutChanged, rightPanelId],
	);

	const maximizeLeft = useCallback(() => {
		const right = rightPanelRef.current;
		if (right) {
			right.collapse();
		}
	}, []);

	const maximizeRight = useCallback(() => {
		const left = leftPanelRef.current;
		if (left) {
			left.collapse();
		}
	}, []);

	const resetSplit = useCallback(() => {
		groupRef.current?.setLayout({
			[leftPanelId]: 50,
			[rightPanelId]: 50,
		});
	}, [groupRef, leftPanelId, rightPanelId]);

	return (
		<Group
			orientation="horizontal"
			className={cn("h-full w-full", className)}
			defaultLayout={defaultLayout}
			onLayoutChanged={handleLayoutChanged}
			groupRef={groupRef}
		>
			<Panel
				id={leftPanelId}
				panelRef={leftPanelRef}
				defaultSize="50%"
				minSize="0%"
				collapsible={true}
				onResize={(size) => setIsLeftCollapsed(size.asPercentage <= 0)}
				className={cn(
					"relative transition-all duration-300 ease-in-out",
					isLeftCollapsed && "min-w-[0px] w-[0px] overflow-hidden",
				)}
			>
				{leftPanel}
			</Panel>

			<Separator className="relative w-px bg-white/10 hover:bg-teal-500/50 transition-colors group z-50 flex items-center justify-center mx-1 focus:outline-none">
				<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50">
					<DocketControl
						isLeftCollapsed={isLeftCollapsed}
						isRightCollapsed={isRightCollapsed}
						onMaximizeLeft={maximizeLeft}
						onMaximizeRight={maximizeRight}
						onReset={resetSplit}
					/>
				</div>
			</Separator>

			<Panel
				id={rightPanelId}
				panelRef={rightPanelRef}
				defaultSize="50%"
				minSize="0%"
				collapsible={true}
				onResize={(size) => setIsRightCollapsed(size.asPercentage <= 0)}
				className={cn(
					"relative transition-all duration-300 ease-in-out",
					isRightCollapsed && "min-w-[0px] w-[0px] overflow-hidden",
				)}
			>
				{rightPanel}
			</Panel>
		</Group>
	);
}

function DocketControl({
	isLeftCollapsed,
	isRightCollapsed,
	onMaximizeLeft,
	onMaximizeRight,
	onReset,
}: {
	isLeftCollapsed: boolean;
	isRightCollapsed: boolean;
	onMaximizeLeft: () => void;
	onMaximizeRight: () => void;
	onReset: () => void;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-0.5 p-1 rounded-full shadow-2xl transition-all duration-300 ring-1 ring-white/20",
				isLeftCollapsed || isRightCollapsed
					? "bg-teal-600 scale-110 opacity-100"
					: "bg-zinc-900/95 backdrop-blur-md scale-95 group-hover:scale-100 opacity-90 group-hover:opacity-100",
			)}
		>
			{!isLeftCollapsed && !isRightCollapsed && (
				<>
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									onClick={onMaximizeLeft}
									className="p-1.5 hover:bg-white/10 rounded-full text-white/70 hover:text-white transition-colors"
								>
									<ArrowLeft01Icon className="w-3.5 h-3.5" />
								</button>
							}
						/>
						<TooltipContent side="top">Maximize Screen Share</TooltipContent>
					</Tooltip>

					<div
						onDoubleClick={onReset}
						className="w-4 h-6 flex items-center justify-center cursor-col-resize text-white/30 hover:text-white/60"
					>
						<MoreVerticalIcon className="w-3.5 h-3.5" />
					</div>

					<Tooltip>
						<TooltipTrigger
							render={
								<button
									onClick={onMaximizeRight}
									className="p-1.5 hover:bg-white/10 rounded-full text-white/70 hover:text-white transition-colors"
								>
									<ArrowRight01Icon className="w-3.5 h-3.5" />
								</button>
							}
						/>
						<TooltipContent side="top">Maximize Whiteboard</TooltipContent>
					</Tooltip>
				</>
			)}

			{isRightCollapsed && (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								onClick={onReset}
								className="p-2 bg-teal-500 hover:bg-teal-400 rounded-full text-white shadow-lg transition-all active:scale-95"
							>
								<ArrowLeft01Icon className="w-4 h-4" />
							</button>
						}
					/>
					<TooltipContent side="left" align="center" sideOffset={10}>
						Restore Split View
					</TooltipContent>
				</Tooltip>
			)}

			{isLeftCollapsed && (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								onClick={onReset}
								className="p-2 bg-teal-500 hover:bg-teal-400 rounded-full text-white shadow-lg transition-all active:scale-95"
							>
								<ArrowRight01Icon className="w-4 h-4" />
							</button>
						}
					/>
					<TooltipContent side="right" align="center" sideOffset={10}>
						Restore Split View
					</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}
