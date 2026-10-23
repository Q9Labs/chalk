import { Popover } from "@base-ui/react/popover";
import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { ChalkTooltip } from "./ChalkTooltip";
import { cn } from "../../utils/cn";
export function ChalkPopover({
  trigger,
  children,
  label,
  className,
  alignOffset = 0,
  tooltip,
  open,
  onOpenChange,
}: {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly label: string;
  readonly className?: string;
  readonly tooltip?: string;
  readonly alignOffset?: number;
}) {
  // The call's root holds and clips the popover, so it is also the room the popover fits in, even in a call embedded in a larger page.
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const holder = useCallback((element: HTMLSpanElement | null) => {
    if (element) setRoot(element.closest<HTMLElement>("[data-chalk]") ?? element);
  }, []);
  return (
    <span ref={holder} style={{ display: "contents" }}>
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        {tooltip ? <ChalkTooltip trigger={<Popover.Trigger render={trigger} />}>{tooltip}</ChalkTooltip> : <Popover.Trigger render={trigger} />}
        <Popover.Portal container={root}>
          <Popover.Positioner side="bottom" align="start" alignOffset={alignOffset} sideOffset={8} collisionPadding={8} collisionBoundary={root ?? undefined} className="chalk-popover-positioner">
            <Popover.Popup aria-label={label} data-part="popover" className={cn("chalk-menu chalk-popover", className)}>
              {children}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
