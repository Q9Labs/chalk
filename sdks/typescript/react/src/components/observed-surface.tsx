import { useContext, useEffect, useRef, type ReactNode } from "react";
import type { EventFields, Kernel, SurfaceName } from "@q9labsai/chalk-client";
import { SpaceClientContext } from "../bindings/context";

/** Emits one `surface` observation: `shown` on committed mount, `dismissed` on unmount or when the fields change. */
export type SurfaceObserver = Kernel["surface"];

/**
 * Marks a committed display for the registry kernel. The observer comes from the `observer` prop or, inside
 * `ChalkProvider`, from `client.telemetry.obs`; without either it renders children and observes nothing.
 * A surface is emitted only when its children commit — mount this component where the display truly appears.
 */
export function ObservedSurface<N extends SurfaceName>({ name, fields, observer, children }: { readonly name: N; readonly fields: EventFields[N]; readonly observer?: SurfaceObserver; readonly children?: ReactNode }) {
  const client = useContext(SpaceClientContext);
  const emit = observer ?? client?.telemetry.obs?.surface;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const serialized = JSON.stringify(fields);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] The whole point of the component is a mount-paired emit/dismiss.
  useEffect(() => {
    if (!emit) return;
    const surface = emit(name, fieldsRef.current);
    return () => surface.dismiss();
    // fieldsRef.current stays fresh; the serialized key decides when one surface ends and the next begins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emit, name, serialized]);
  return <>{children}</>;
}
