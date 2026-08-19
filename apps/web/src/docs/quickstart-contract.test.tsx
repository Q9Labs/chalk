import { createSpaceClient } from "@q9labsai/chalk-client";
import { Chalk } from "@q9labsai/chalk-react";
import { describe, expect, it } from "vitest";

function buildQuickstartClient() {
  return createSpaceClient({
    space: "design-review",
    getAccess: ({ space, reason }) => fetch(`/api/chalk/spaces/${space}/access?reason=${reason}`),
  });
}

function useQuickstartContract(client: ReturnType<typeof buildQuickstartClient>) {
  const unsubscribe = client.subscribe(() => {
    const snapshot = client.getSnapshot();
    if (snapshot.self.can("sendChat")) {
      void client.chat.send({ text: "Ready when you are." });
    }
  });

  void client.join({ displayName: "Ari", microphone: true, camera: false });
  void client.leave();
  unsubscribe();
  client.dispose();
}

function ReactQuickstart() {
  return <Chalk space="design-review" getAccess={({ space, reason }) => fetch(`/api/chalk/spaces/${space}/access?reason=${reason}`)} />;
}

describe("docs quickstart contract", () => {
  it("compiles against the current client and React surfaces", () => {
    expect(createSpaceClient).toBeTypeOf("function");
    expect(Chalk).toBeDefined();
    expect(buildQuickstartClient).toBeTypeOf("function");
    expect(useQuickstartContract).toBeTypeOf("function");
    expect(ReactQuickstart).toBeTypeOf("function");
  });
});
