import { Alert02Icon, CheckmarkCircle02Icon, InformationCircleIcon } from "../../utils/icons";
import type { ChalkToastProps } from "./ChalkToast";

const icons = { info: InformationCircleIcon, success: CheckmarkCircle02Icon, warning: Alert02Icon, error: Alert02Icon } as const;

export default function ToastIcon({ type }: { readonly type: NonNullable<ChalkToastProps["type"]> }) {
  const Icon = icons[type];
  return <Icon />;
}
