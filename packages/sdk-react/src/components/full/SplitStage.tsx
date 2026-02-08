// @ts-nocheck
"use client";

import * as resizablePanelsPkg from "react-resizable-panels";
import { useCallback, useMemo, useState } from "react";
import {
    ArrowLeft01Icon,
    ArrowRight01Icon,
    MoreVerticalIcon,
} from "../../utils/icons";
import { cn } from "../../utils/cn";
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

            <Separator
                className="relative w-2 bg-transparent hover:bg-white/10 transition-colors group z-50 flex items-center justify-center -ml-1 -mr-1 focus:outline-none"
            >
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
        <div className="flex items-center gap-0.5 p-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-xl scale-90 group-hover:scale-100 transition-all duration-200">
            {!isLeftCollapsed && !isRightCollapsed && (
                <>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button
                                    onClick={onMaximizeLeft}
                                    className="p-1 hover:bg-white/20 rounded-full text-white/80 hover:text-white transition-colors"
                                >
                                    <ArrowLeft01Icon className="w-3 h-3" />
                                </button>
                            }
                        />
                        <TooltipContent>Maximize Screen Share</TooltipContent>
                    </Tooltip>

                    <div
                        onDoubleClick={onReset}
                        className="w-4 h-6 flex items-center justify-center cursor-col-resize text-white/40 hover:text-white/80"
                    >
                        <MoreVerticalIcon className="w-3 h-3" />
                    </div>

                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button
                                    onClick={onMaximizeRight}
                                    className="p-1 hover:bg-white/20 rounded-full text-white/80 hover:text-white transition-colors"
                                >
                                    <ArrowRight01Icon className="w-3 h-3" />
                                </button>
                            }
                        />
                        <TooltipContent>Maximize Whiteboard</TooltipContent>
                    </Tooltip>
                </>
            )}

            {isRightCollapsed && (
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button
                                onClick={onReset}
                                className="p-1 hover:bg-white/20 rounded-full text-white/80 hover:text-white transition-colors"
                            >
                                <ArrowLeft01Icon className="w-3 h-3" />
                            </button>
                        }
                    />
                    <TooltipContent>Restore Split View</TooltipContent>
                </Tooltip>
            )}

            {isLeftCollapsed && (
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button
                                onClick={onReset}
                                className="p-1 hover:bg-white/20 rounded-full text-white/80 hover:text-white transition-colors"
                            >
                                <ArrowRight01Icon className="w-3 h-3" />
                            </button>
                        }
                    />
                    <TooltipContent>Restore Split View</TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}
