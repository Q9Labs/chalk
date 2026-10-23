import { Children, Fragment, isValidElement, type ReactNode } from "react";
import type { ChalkToastProps } from "../chalk-ui/ChalkToast";

/** Read literal text without mounting caller components or their interactive descendants. */
function literalText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (node == null || typeof node === "boolean") return "";
  if (isValidElement<{ readonly children?: ReactNode }>(node)) return typeof node.type === "string" || node.type === Fragment ? literalText(node.props.children) : "";
  if (typeof node === "object" && "then" in node) return "";
  return typeof node === "object" && Symbol.iterator in node ? Children.toArray(node).map(literalText).join("") : "";
}

export function noticeAnnouncement(toast: Pick<ChalkToastProps, "message" | "announcementText">): string {
  return toast.announcementText ?? literalText(toast.message);
}

/** Semantic speech/lifetime revision, independent of JSX and layout chrome. */
export function noticeIdentity(toast: Pick<ChalkToastProps, "message" | "announcementText" | "announcementKey" | "type">): string {
  return JSON.stringify([noticeAnnouncement(toast), toast.announcementKey, toast.type ?? "info"]);
}
