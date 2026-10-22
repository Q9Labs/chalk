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

it("uses the primary renderer for focused content when a tile renderer is also supplied", () => {
  const participant = { id: "person", displayName: "Nora" };
  const share: StageItem = { kind: "screen-share", id: "screen-share:person", participant };
  const html = renderToStaticMarkup(<Stage items={[share]} layout="spotlight" pinnedId={share.id} renderContentTile={() => <div>Unfocused content</div>} renderPrimaryContent={() => <div>Focused content</div>} />);
  expect(html).toContain("Focused content");
  expect(html).not.toContain("Unfocused content");
});

it("marks the +N tile with its frame role, so styles that follow the layout see it", () => {
  const people: StageItem[] = ["nora", "akash", "malik"].map((id) => ({ kind: "participant", id, participant: { id, displayName: id } }));
  const html = renderToStaticMarkup(<Stage items={people} layout="grid" maxPerPage={2} generatedAvatars={false} />);
  expect(html.match(/<button[^>]*data-stage-item="stage:more"[^>]*>/)?.[0]).toContain('data-stage-role="grid"');
});
