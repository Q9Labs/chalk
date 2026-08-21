import { describe, expect, it, vi } from "vitest";

vi.mock("./EntranceView", () => ({ EntranceView: "EntranceView" }));
vi.mock("./logo/Logo", () => ({ Logo: "Logo" }));
vi.mock("react-native", () => ({ Image: "Image" }));

import { Entrance } from "./Entrance";

describe("Entrance", () => {
  it("exposes the preparation component", () => {
    expect(Entrance).toBeTypeOf("function");
  });

  it("forwards the public cancel callback to the native Entrance view", () => {
    const onCancel = vi.fn();
    const element = Entrance({ onCancel, onJoin: vi.fn(), spaceName: "Space" });

    expect(element.props.onCancel).toBe(onCancel);
  });

  it("uses the SDK wordmark when no custom logo URL is supplied", () => {
    const element = Entrance({ onJoin: vi.fn(), spaceName: "Space" });

    expect(element.props.logo).toMatchObject({ type: "Logo", props: { height: 32, variant: "wordmark" } });
  });
});
