import React from "react";
import { cn } from "../../utils/cn";
import { StageIcon } from "./StageIcon";

const COLORS: Readonly<Record<string, string>> = {
  pdf: "bg-[var(--chalk-file-pdf)]",
  doc: "bg-[var(--chalk-file-doc)]",
  docx: "bg-[var(--chalk-file-doc)]",
  odt: "bg-[var(--chalk-file-doc)]",
  xls: "bg-[var(--chalk-file-xls)]",
  xlsx: "bg-[var(--chalk-file-xls)]",
  ods: "bg-[var(--chalk-file-xls)]",
  ppt: "bg-[var(--chalk-file-ppt)]",
  pptx: "bg-[var(--chalk-file-ppt)]",
  odp: "bg-[var(--chalk-file-ppt)]",
  key: "bg-[var(--chalk-file-ppt)]",
};

/** The file's own type as a badge, such as PPTX or DOCX. A name without a short extension gets a neutral document icon. */
export function FileTypeBadge({ fileName, className }: { readonly fileName: string; readonly className?: string }): React.JSX.Element {
  const extension = fileName.includes(".") ? (fileName.split(".").pop() ?? "").toLowerCase() : "";
  const labelled = /^[a-z0-9]{1,4}$/.test(extension);
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-md px-1 text-(length:--type-micro) font-bold", COLORS[extension] ?? "bg-[var(--chalk-file-other)]", className)} aria-hidden="true">
      {labelled ? extension.toUpperCase() : <StageIcon name="file" size={16} />}
    </span>
  );
}
