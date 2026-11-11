import { lazy, Suspense, useState, type ComponentProps } from "react";

const Content = lazy(() => import("./CallDialogContent").then((module) => ({ default: module.CallDialogContent })));

/** The report and shortcuts dialog. Its code downloads the first time a dialog opens, and the dialog then stays mounted. */
export function CallDialog(props: ComponentProps<typeof Content>) {
  const [wanted, setWanted] = useState(props.open);
  if (props.open && !wanted) setWanted(true);
  return wanted ? (
    <Suspense fallback={null}>
      <Content {...props} />
    </Suspense>
  ) : null;
}
