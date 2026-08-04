import { createFileRoute } from "@tanstack/react-router";

import { normalizePreviewSearch } from "../components/sdk-preview/preview-state";

/**
 * The static half of the preview route owns only URL validation. The gallery
 * itself is paired through `sdk-preview.lazy.tsx`, keeping the development
 * fixture out of the production route module.
 */
export const Route = createFileRoute("/sdk-preview")({
  validateSearch: normalizePreviewSearch,
});
