import { createLazyFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { useCallback, type ComponentType } from "react";
import type React from "react";

import { patchPreviewSearch, type PreviewSearch, type PreviewSearchPatch } from "../components/sdk-preview/preview-state";

export const PreviewGallery = import.meta.env.DEV ? lazyRouteComponent(() => import("../components/sdk-preview/SdkPreviewGallery"), "SdkPreviewGallery") : undefined;

export const Route = createLazyFileRoute("/sdk-preview")({ component: SdkPreviewRoute });

type PreviewGalleryComponent = ComponentType<{
  readonly search: PreviewSearch;
  readonly onSearchChange: (updates: PreviewSearchPatch) => void;
}>;

function SdkPreviewRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearchChange = useCallback(
    (updates: PreviewSearchPatch) => {
      void navigate({
        replace: true,
        search: (current) => patchPreviewSearch(current as PreviewSearch, updates),
      });
    },
    [navigate],
  );

  return <SdkPreviewRouteSurface isDev={import.meta.env.DEV} gallery={PreviewGallery} search={search} onSearchChange={onSearchChange} />;
}

export function SdkPreviewRouteSurface({ isDev, gallery, search, onSearchChange }: { readonly isDev: boolean; readonly gallery?: PreviewGalleryComponent; readonly search: PreviewSearch; readonly onSearchChange: (updates: PreviewSearchPatch) => void }): React.JSX.Element {
  if (!isDev || !gallery) return <PreviewUnavailable />;
  const Gallery = gallery;
  return <Gallery search={search} onSearchChange={onSearchChange} />;
}

export function PreviewUnavailable() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f3ef] px-6 py-16 text-[#202329]">
      <section className="w-full max-w-lg rounded-2xl border border-[#deddd7] bg-[#fbfaf7] p-8 text-center shadow-[0_20px_70px_rgba(12,14,18,0.1)]" aria-labelledby="sdk-preview-unavailable-title">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#6d727b]">404</p>
        <h1 id="sdk-preview-unavailable-title" className="mt-3 text-2xl font-semibold tracking-[-0.03em]">
          SDK preview unavailable
        </h1>
        <p className="mt-3 text-sm leading-6 text-[#6d727b]">This development gallery is not included in the production build.</p>
      </section>
    </main>
  );
}
