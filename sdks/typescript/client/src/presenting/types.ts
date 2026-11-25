import type { components } from "../generated/presenting-v1";

export type PresentingWire = components["schemas"];
export type PresentingDocument = {
  readonly documentId: string;
  readonly presenterId: string;
  readonly page: number;
  readonly zoom: number;
  readonly startedAtMs: number;
};
export type PresentingReplicaSnapshot = { readonly status: "connecting" | "unavailable" } | { readonly status: "ready"; readonly revision: number; readonly documents: readonly PresentingDocument[] };
export type PresentingCommandResult = { readonly kind: "accepted"; readonly revision: number } | { readonly kind: "rejected"; readonly reason: PresentingWire["Rejected"]["reason"] } | { readonly kind: "delivery_unknown" } | { readonly kind: "unavailable" };
export type PresentingDocumentPage = {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly status: "pending" | "ready";
  readonly imageUrl?: string;
  readonly thumbnailUrl?: string;
};
export type PresentingDocumentManifest = {
  readonly documentId: string;
  readonly attachmentId: string;
  readonly fileName: string;
  readonly status: "preparing" | "ready" | "failed";
  readonly failure?: string;
  readonly pageCount?: number;
  readonly pages: readonly PresentingDocumentPage[];
};
export type PresentingSlice = {
  readonly status: "connecting" | "ready" | "unavailable";
  readonly revision: number;
  readonly documents: readonly PresentingDocument[];
  readonly manifests: Readonly<Record<string, PresentingDocumentManifest>>;
};
