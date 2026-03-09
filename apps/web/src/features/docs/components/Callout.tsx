import { AlertCircle, CheckCircle2, Info, Lightbulb, AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

type CalloutType = "info" | "tip" | "warning" | "error" | "success";

interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children: ReactNode;
}

const calloutConfig: Record<
  CalloutType,
  {
    icon: ReactNode;
    className: string;
    defaultTitle: string;
  }
> = {
  info: {
    icon: <Info size={20} />,
    className: "bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-300",
    defaultTitle: "Info",
  },
  tip: {
    icon: <Lightbulb size={20} />,
    className: "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300",
    defaultTitle: "Tip",
  },
  warning: {
    icon: <AlertTriangle size={20} />,
    className: "bg-orange-500/10 border-orange-500/30 text-orange-700 dark:text-orange-300",
    defaultTitle: "Warning",
  },
  error: {
    icon: <AlertCircle size={20} />,
    className: "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300",
    defaultTitle: "Error",
  },
  success: {
    icon: <CheckCircle2 size={20} />,
    className: "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-300",
    defaultTitle: "Success",
  },
};

export function Callout({ type = "info", title, children }: CalloutProps) {
  const config = calloutConfig[type];

  return (
    <div className={`my-6 rounded-lg border p-4 ${config.className}`} role="note">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">{config.icon}</div>
        <div className="min-w-0">
          {title !== undefined ? <p className="font-semibold mb-1">{title}</p> : null}
          <div className="text-sm [&>p]:my-0 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">{children}</div>
        </div>
      </div>
    </div>
  );
}
