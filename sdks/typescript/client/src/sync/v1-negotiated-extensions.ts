import type { SyncV1ServerFrame } from "../generated/sync";

type Welcome = Extract<SyncV1ServerFrame, { readonly type: "welcome" }>;

export function v1NegotiatedExtensions(welcome?: Welcome) {
  const annotation = welcome?.screen_annotation === true;
  return {
    entryConfirmation: welcome?.entry_confirmation === true,
    mediaOffReason: welcome?.media_off_reason === true,
    connectionQuality: welcome?.connection_quality === true,
    annotation,
    annotationBurnIn: annotation && welcome?.screen_annotation_burn_in === true,
    presenting: welcome?.presenting === true,
  };
}
