import { PRESENTING_FAILURE_REASONS, PRESENTING_FORMATS, type PresentingFormatFlag, type PresentingFormatId, type PresentingFormatKind } from "./files.gen";

export type { PresentingFailureCode, PresentingFormatFlag, PresentingFormatId, PresentingFormatKind } from "./files.gen";
export { PRESENTING_FAILURE_REASONS, PRESENTING_FORMATS } from "./files.gen";

export type PresentingFormat = (typeof PRESENTING_FORMATS)[number];
export type PresentingFormatFlags = { readonly office?: boolean; readonly keynote?: boolean };

const KIND_LABELS: Readonly<Record<PresentingFormatKind, string>> = { pdf: "PDF", slides: "slides", document: "documents", spreadsheet: "spreadsheets", text: "text files", image: "images" };
const KIND_ORDER: readonly PresentingFormatKind[] = ["pdf", "slides", "document", "spreadsheet", "text", "image"];
const GENERIC_MIME_TYPES: ReadonlySet<string> = new Set(["", "application/octet-stream", "binary/octet-stream", "application/zip", "application/x-zip-compressed", "application/x-cfb"]);

function flagAllowed(flag: PresentingFormatFlag, flags: PresentingFormatFlags): boolean {
  if (flag === "core") return true;
  if (flag === "office") return flags.office === true;
  return flags.office === true && flags.keynote === true;
}

/** The format ids Presenting accepts when the given flags are on; with no flags, only the always-on formats. */
export function presentingFormatIdsFor(flags: PresentingFormatFlags = {}): readonly PresentingFormatId[] {
  return PRESENTING_FORMATS.filter((format) => flagAllowed(format.flag, flags)).map((format) => format.id);
}

export function presentingFormatsFor(ids: readonly string[]): readonly PresentingFormat[] {
  return PRESENTING_FORMATS.filter((format) => ids.includes(format.id));
}

export function presentingMimeTypesFor(ids: readonly string[]): ReadonlySet<string> {
  return new Set(presentingFormatsFor(ids).flatMap((format) => format.mimeTypes));
}

/** The kinds of file a set of formats covers, in display order, such as ["PDF", "slides", "images"]. */
export function presentingKindLabelsFor(ids: readonly string[]): readonly string[] {
  const kinds = new Set(presentingFormatsFor(ids).map((format) => format.kind));
  return KIND_ORDER.filter((kind) => kinds.has(kind)).map((kind) => KIND_LABELS[kind]);
}

/** Copy such as "PDF, slides, documents, spreadsheets, images". */
export function presentingAcceptedLabelFor(ids: readonly string[]): string {
  return presentingKindLabelsFor(ids).join(", ");
}

export function presentingFailureMessage(code: string): string | undefined {
  return PRESENTING_FAILURE_REASONS.find((reason) => reason.code === code)?.message;
}

/** Browsers often report an empty or generic type for Office, OpenDocument and Keynote files, so the extension decides then. */
export function resolveFileMimeType(fileName: string, mimeType: string): string {
  const reported = mimeType.split(";", 1).join("").trim().toLowerCase();
  if (!GENERIC_MIME_TYPES.has(reported)) return mimeType;
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return mimeType;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return PRESENTING_FORMATS.find((format) => (format.extensions as readonly string[]).includes(extension))?.mimeTypes.at(0) ?? mimeType;
}
