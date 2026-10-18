import { Popover } from "@base-ui/react/popover";
import { useRef, type ReactElement, type ReactNode } from "react";
import { cn } from "../../utils/cn";
export function ChalkPopover({ trigger, children, label, className, alignOffset = 0 }: { readonly trigger: ReactElement; readonly children: ReactNode; readonly label: string; readonly className?: string; readonly alignOffset?: number }) {
  const container = useRef<HTMLElement>(null);
  return (
    <span
      ref={(element) => {
        container.current = element?.closest<HTMLElement>("[data-chalk]") ?? element;
      }}
      style={{ display: "contents" }}
    >
      <Popover.Root>
        <Popover.Trigger render={trigger} />
        <Popover.Portal container={container}>
          <Popover.Positioner side="bottom" align="start" alignOffset={alignOffset} sideOffset={8} collisionPadding={8} className="chalk-popover-positioner">
            <Popover.Popup aria-label={label} data-part="popover" className={cn("chalk-menu chalk-popover", className)}>
              {children}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
