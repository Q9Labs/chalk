/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewGallery, PreviewUnavailable, SdkPreviewRouteSurface } from "./sdk-preview.lazy";
import { DEFAULT_PREVIEW_SEARCH, normalizePreviewSearch, serializePreviewSearch } from "../components/sdk-preview/preview-state";

afterEach(cleanup);

describe("SDK preview lazy route", () => {
  it("loads the gallery through the DEV-only lazy boundary", () => {
    if (import.meta.env.DEV) {
      expect(PreviewGallery).toBeDefined();
    } else {
      expect(PreviewGallery).toBeUndefined();
    }
  });

  it("selects the production unavailable surface outside DEV even when a gallery is provided", () => {
    const Gallery = () => <div data-testid="gallery-surface">Gallery</div>;

    render(<SdkPreviewRouteSurface isDev={false} gallery={Gallery} search={DEFAULT_PREVIEW_SEARCH} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "SDK preview unavailable" })).toBeTruthy();
    expect(screen.queryByTestId("gallery-surface")).toBeNull();
  });

  it("selects the lazy gallery surface in DEV when it is available", () => {
    const Gallery = () => <div data-testid="gallery-surface">Gallery</div>;

    render(<SdkPreviewRouteSurface isDev gallery={Gallery} search={DEFAULT_PREVIEW_SEARCH} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId("gallery-surface")).toBeTruthy();
  });

  it("renders the production unavailable surface", () => {
    render(<PreviewUnavailable />);

    expect(screen.getByRole("heading", { name: "SDK preview unavailable" })).toBeTruthy();
    expect(screen.getByText("This development gallery is not included in the production build.")).toBeTruthy();
  });

  it("restores a copied preview URL with canonical palette and lifecycle state", () => {
    const restored = normalizePreviewSearch(new URLSearchParams("view=space&state=left&palette=cosmic&texture=soft-dots&feature-chat=false"));

    expect(restored).toMatchObject({ view: "space", state: "left", palette: "cosmic-chalk", texture: "slate", features: { chat: false } });
    expect(serializePreviewSearch(restored)).toContain("state=left");
  });
});
