import { Tooltip } from "@base-ui/react/tooltip";
import { useRef, type ReactElement, type ReactNode } from "react";
import { useMediaQuery } from "../useMediaQuery";
export function ChalkTooltip({ trigger, children }: { readonly trigger: ReactElement; readonly children: ReactNode }) {
  const container = useRef<HTMLElement>(null);
  const fine = useMediaQuery("(pointer:fine)");
  if (!fine) return trigger;
  return (
    <span
      ref={(element) => {
        container.current = element?.closest<HTMLElement>("[data-chalk]") ?? element;
      }}
      style={{ display: "contents" }}
    >
      <Tooltip.Provider delay={400}>
        <Tooltip.Root>
          <Tooltip.Trigger render={trigger} />
          <Tooltip.Portal container={container}>
            <Tooltip.Positioner side="top" sideOffset={8} collisionPadding={8} style={{ zIndex: 95 }}>
              <Tooltip.Popup data-part="tooltip" className="chalk-tooltip">
                {children}
              </Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </span>
  );
}
