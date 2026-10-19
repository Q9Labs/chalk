import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Stage, type StageItem } from "./Stage";

it("keeps a pinned person visible when shared content fills Grid capacity", () => {
  const person: StageItem = { kind: "participant", id: "person", participant: { id: "person", displayName: "Nora" } };
  const other: StageItem = { kind: "participant", id: "other", participant: { id: "other", displayName: "Akash" } };
  const share: StageItem = { kind: "screen-share", id: "screen-share:other", participant: other.participant };
  const html = renderToStaticMarkup(<Stage items={[person, other, share]} layout="grid" pinnedId={person.id} maxPerPage={2} generatedAvatars={false} />);
  const wrapper = html.match(/<div[^>]*data-stage-item="person"[^>]*>/)?.[0];
  expect(wrapper).toBeDefined();
  expect(wrapper).not.toContain('aria-hidden="true"');
});
