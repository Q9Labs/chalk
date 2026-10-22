// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { act, readPage } from "../../lib/dashboard/client";
import type { HomeCallDTO, HomeDTO, HomeStatusDTO, LiveDTO } from "../../lib/dashboard/contracts";
import { lastActive } from "../../lib/dashboard/format";
import { HomePage } from "./HomePage";

const router = vi.hoisted(() => ({ state: { location: { pathname: "/dashboard" } }, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children, "aria-label": label }: { children?: ReactNode; "aria-label"?: string }) => createElement("a", { "aria-label": label }, children), useNavigate: () => router.navigate, useRouter: () => router };
});
vi.mock("../../lib/dashboard/client", async (original) => {
  const client = await original<typeof import("../../lib/dashboard/client")>();
  return { ...client, act: vi.fn(), readPage: vi.fn() };
});

type Episode = NonNullable<LiveDTO["episode"]>;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const row = (id: string, name: string): HomeCallDTO => ({ id, name, slug: `call-${id}`, archived: false, admission: "knock", createdAt: "2026-10-21T00:00:00Z", inviteUrl: null, lastActiveAt: null, recentPeople: [] });
const planning = row(uuid(1), "Planning");
const elsewhere = row(uuid(2), "Made in another tab");
const nora = { id: uuid(0xa1), name: "Nora" };
const first: Episode = { id: uuid(0xe1), count: 1, participants: [nora] };
const second: Episode = { id: uuid(0xe2), count: 2, participants: [nora, { id: uuid(0xa2), name: "Akash" }] };

/**
 * The server as Home sees it, answering from `truth` the way `server/home.ts` does: pages of five, and one status
 * answer with every row's live state, last active time and recent people, plus the first page when any of the five
 * newest calls isn't in the list.
 */
type Truth = { calls: HomeCallDTO[]; live: Record<string, Episode>; fail?: boolean; failFirstPage?: boolean; pageSize?: number };
function serve(truth: Truth) {
  const answer = (spaceId: string) => ({ spaceId, episode: truth.live[spaceId] ?? null });
  const pageAt = (offset: number): HomeDTO => {
    const end = offset + (truth.pageSize ?? 5);
    const calls = truth.calls.slice(offset, end);
    return { calls, live: calls.map((call) => answer(call.id)), nextCursor: end < truth.calls.length ? String(end) : null };
  };
  vi.mocked(readPage).mockImplementation(async (name, query) => {
    if (name === "home") {
      const cursor = query && "cursor" in query && query.cursor ? Number(query.cursor) : 0;
      if (!cursor && truth.failFirstPage) throw new Error("page read failed");
      return pageAt(cursor);
    }
    if (name === "call-invite") return { inviteUrl: "https://chalk.example/join/new" };
    if (name !== "home-status") throw new Error(`unexpected ${name}`);
    if (truth.fail) throw new Error("status check failed");
    const ids = query && "spaceIds" in query && query.spaceIds ? query.spaceIds.split(",") : [];
    const calls = ids.map((id) => truth.calls.find((call) => call.id === id) ?? row(id, ""));
    const result: HomeStatusDTO = { live: ids.map(answer), calls: calls.map(({ id, lastActiveAt, recentPeople }) => ({ id, lastActiveAt, recentPeople })) };
    return truth.calls.slice(0, 5).some((call) => !ids.includes(call.id)) ? { ...result, first: pageAt(0) } : result;
  });
}
const requests = () => vi.mocked(readPage).mock.calls.map(([name, query]) => [name, query] as const);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function tick(ms = 5000) {
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function open() {
  await reactAct(async () => {
    render(<HomePage />);
  });
}

it("shows a row that went live between two checks after the next check", async () => {
  const truth: Truth = { calls: [planning], live: {} };
  serve(truth);
  await open();
  truth.live[planning.id] = first;
  await tick();
  expect(screen.getByText("Live · 1 in the call")).toBeTruthy();
  expect(requests().at(-1)).toEqual(["home-status", { home: "1", spaceIds: planning.id }]);
});

it("shows a row that ended between two checks, with its new last-active time, after the next check", async () => {
  const truth: Truth = { calls: [planning], live: { [planning.id]: first } };
  serve(truth);
  await open();
  expect(screen.getByText("Live · 1 in the call")).toBeTruthy();
  const ended = "2026-10-22T10:07:53Z";
  delete truth.live[planning.id];
  truth.calls = [{ ...planning, lastActiveAt: ended, recentPeople: [nora] }];
  await tick();
  expect(screen.queryByText("Live · 1 in the call")).toBeNull();
  expect(screen.getByLabelText(`Planning, last active ${lastActive(ended)}`)).toBeTruthy();
  expect(requests().at(-1)).toEqual(["home-status", { home: "1", spaceIds: planning.id }]);
});

it("shows a row that ended and restarted between two checks as the new call after the next check", async () => {
  const truth: Truth = { calls: [planning], live: { [planning.id]: first } };
  serve(truth);
  await open();
  truth.live[planning.id] = second;
  await tick();
  expect(screen.getByText("Live · 2 in the call")).toBeTruthy();
});

it("finds a call made elsewhere just before this tab made a newer one", async () => {
  const truth: Truth = { calls: [planning], live: {} };
  serve(truth);
  await open();
  const mine = row(uuid(3), "Made in this tab");
  vi.mocked(act).mockResolvedValue({ call: mine });
  // The reload after this tab's new call fails, so only the next check can find the other tab's call.
  truth.calls = [elsewhere, planning];
  truth.failFirstPage = true;
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start a call" }));
  });
  truth.failFirstPage = false;
  truth.calls = [mine, elsewhere, planning];
  expect(screen.queryByText("Made in another tab")).toBeNull();
  // The first check after a failure waits twice the interval.
  await tick(10_000);
  expect(screen.getAllByText(/^(Made in this tab|Made in another tab|Planning)$/).map((item) => item.textContent)).toEqual(["Made in this tab", "Made in another tab", "Planning"]);
});

it("brings back the call pushed past 300 when a shown call is archived", async () => {
  const rows = Array.from({ length: 310 }, (_, index) => row(uuid(0x1000 + index), `Call ${index}`));
  const truth: Truth = { calls: rows, live: {}, pageSize: 50 };
  serve(truth);
  await open();
  for (let count = 1; count < 6; count++)
    await reactAct(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more calls" }));
    });
  truth.calls = [elsewhere, ...rows];
  await tick();
  expect(screen.queryByText("Call 299")).toBeNull();
  // The reload after the archive fails, so only the list Home already holds can fill the gap.
  const archived = rows[5];
  if (!archived) throw new Error("no row to archive");
  vi.mocked(act).mockResolvedValue({ call: { ...archived, archived: true } });
  truth.calls = truth.calls.filter((call) => call !== archived);
  truth.failFirstPage = true;
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: `More actions for ${archived.name}` }));
  });
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive call" }));
  });
  expect(screen.getByText("Call 299")).toBeTruthy();
  expect(screen.getAllByText(/^(Call \d+|Made in another tab)$/)).toHaveLength(300);
}, 20_000);

it("keeps 300 calls when a reload replays more pages than the limit needs", async () => {
  const rows = Array.from({ length: 310 }, (_, index) => row(uuid(0x1000 + index), `Call ${index}`));
  const truth: Truth = { calls: rows, live: {}, pageSize: 50 };
  serve(truth);
  const archived = rows[5];
  if (!archived) throw new Error("no row to archive");
  vi.mocked(act).mockResolvedValue({ call: { ...archived, archived: true } });
  await open();
  const more = async () =>
    reactAct(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more calls" }));
    });
  for (let count = 1; count < 6; count++) await more();
  // Archiving one row brings Show more back while the reload after it fails, so Home reads one page more than 300
  // calls need.
  truth.calls = rows.filter((call) => call !== archived);
  truth.failFirstPage = true;
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: `More actions for ${archived.name}` }));
  });
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive call" }));
  });
  await more();
  expect(screen.getAllByText(/^Call \d+$/)).toHaveLength(300);
  truth.failFirstPage = false;
  // A full first page of calls made elsewhere shares no row with the list, so Home reloads every page it read.
  const fresh = Array.from({ length: 50 }, (_, index) => row(uuid(0x2000 + index), `New ${index}`));
  truth.calls = [...fresh, ...truth.calls];
  await tick();
  await tick();
  expect(screen.getAllByText(/^(Call|New) \d+$/)).toHaveLength(300);
  await tick();
  const [, query] =
    requests()
      .filter(([name]) => name === "home-status")
      .at(-1) ?? [];
  expect(query && "spaceIds" in query ? query.spaceIds?.split(",") : []).toHaveLength(300);
}, 20_000);

// #416: a call that starts and ends between two checks is never live in an answer, but its latest session moves.
it("shows a call that started and ended between two checks with its new last-active time after the next check", async () => {
  const truth: Truth = { calls: [{ ...planning, lastActiveAt: "2026-10-21T09:00:00Z" }], live: {} };
  serve(truth);
  await open();
  const ended = "2026-10-22T10:07:53Z";
  truth.calls = [{ ...planning, lastActiveAt: ended, recentPeople: [nora] }];
  await tick();
  expect(screen.getByLabelText(`Planning, last active ${lastActive(ended)}`)).toBeTruthy();
});

it("puts a call made elsewhere on top within one check and keeps the expanded history", async () => {
  const history = Array.from({ length: 100 }, (_, index) => row(uuid(0x100 + index), `Paged ${index}`));
  const truth: Truth = { calls: history, live: {} };
  serve(truth);
  await open();
  for (let count = 1; count < 20; count++)
    await reactAct(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more calls" }));
    });
  expect(screen.getAllByText(/^Paged \d+$/)).toHaveLength(100);
  truth.calls = [elsewhere, ...history];
  const before = requests().length;
  await tick();
  expect(requests().slice(before)).toEqual([["home-status", { home: "1", spaceIds: history.map((call) => call.id).join(",") }]]);
  expect(screen.getAllByText(/^(Paged \d+|Made in another tab)$/)[0]?.textContent).toBe("Made in another tab");
  expect(screen.getAllByText(/^Paged \d+$/)).toHaveLength(100);
});

it("ends a live call in the same check that finds a call made elsewhere", async () => {
  const truth: Truth = { calls: [planning], live: { [planning.id]: first } };
  serve(truth);
  await open();
  truth.calls = [elsewhere, planning];
  delete truth.live[planning.id];
  await tick();
  expect(screen.getByText("Made in another tab")).toBeTruthy();
  expect(screen.queryByText("Live · 1 in the call")).toBeNull();
});

it("shows a first call while the list is empty", async () => {
  const truth: Truth = { calls: [], live: {} };
  serve(truth);
  await open();
  expect(screen.getByText("No calls yet")).toBeTruthy();
  truth.calls = [elsewhere];
  await tick();
  expect(screen.getByText("Made in another tab")).toBeTruthy();
  expect(requests()[1]).toEqual(["home-status", { home: "1" }]);
});

it("keeps the old rows when a check fails and catches up on the next one", async () => {
  const truth: Truth = { calls: [planning], live: { [planning.id]: first }, fail: true };
  serve(truth);
  await open();
  delete truth.live[planning.id];
  await tick();
  expect(screen.getByText("Live · 1 in the call")).toBeTruthy();
  truth.fail = false;
  // The first retry after a failure waits twice the interval.
  await tick(10_000);
  expect(screen.getByText("Planning")).toBeTruthy();
  expect(screen.queryByText("Live · 1 in the call")).toBeNull();
});

it("makes one request per check however many rows are open", async () => {
  const rows = Array.from({ length: 40 }, (_, index) => row(uuid(0x300 + index), `Call ${index}`));
  const truth: Truth = { calls: rows, live: Object.fromEntries(rows.slice(10, 35).map((call) => [call.id, first])) };
  serve(truth);
  await open();
  for (let count = 1; count < 8; count++)
    await reactAct(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more calls" }));
    });
  const before = requests().length;
  for (let count = 0; count < 4; count++) await tick();
  const checks = requests().slice(before);
  expect(checks.map(([name]) => name)).toEqual(["home-status", "home-status", "home-status", "home-status"]);
  for (const [, query] of checks) expect(query && "spaceIds" in query ? query.spaceIds?.split(",") : []).toEqual(rows.map((call) => call.id));
});

it("stops at the 300 newest calls and checks them all in one request that fits a URL", async () => {
  const rows = Array.from({ length: 310 }, (_, index) => row(uuid(0x1000 + index), `Call ${index}`));
  // Pages of 50 keep the test fast; the server's pages of five reach the same cap.
  const truth: Truth = { calls: rows, live: {}, pageSize: 50 };
  serve(truth);
  await open();
  for (let count = 1; count < 6; count++)
    await reactAct(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more calls" }));
    });
  expect(screen.getAllByText(/^Call \d+$/)).toHaveLength(300);
  expect(screen.queryByRole("button", { name: "Show more calls" })).toBeNull();
  expect(screen.getByText("Home shows your 300 most recent calls.")).toBeTruthy();
  truth.calls = [elsewhere, ...rows];
  await tick();
  expect(screen.getAllByText(/^(Call \d+|Made in another tab)$/)).toHaveLength(300);
  const [name, query] = requests().at(-1) ?? [];
  expect(name).toBe("home-status");
  expect(query && "spaceIds" in query ? query.spaceIds?.split(",") : []).toEqual(rows.slice(0, 300).map((call) => call.id));
  // Cloudflare Workers refuse URLs over 16 KB.
  expect(`https://chalk.example/dashboard-api/home-status?${new URLSearchParams(query ?? {})}`.length).toBeLessThan(16_384);
}, 20_000);

it("pauses its checks while the tab is hidden", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get");
  serve({ calls: [planning], live: {} });
  await open();
  visibility.mockReturnValue("hidden");
  for (let count = 0; count < 4; count++) await tick();
  expect(requests().map(([name]) => name)).toEqual(["home"]);
  visibility.mockReturnValue("visible");
  await tick();
  expect(requests().map(([name]) => name)).toEqual(["home", "home-status"]);
});

// B4 in the QA sweep of 2026-10-22: Home stayed open on the production dashboard while another tab created a call,
// joined it and ended it. Home never changed in the 44 s after the end, while the call page showed the end after
// about 4.9 s. These are the two runs' Home lists and offsets from creation; the Space ids are stand-ins, with run
// 1's call listed before run 2 as it was.
const qaRuns = [
  { run: 1, before: [], made: uuid(0xb1), liveAt: 6731, endedAt: 13400 },
  { run: 2, before: [uuid(0xb1)], made: uuid(0xb2), liveAt: 6272, endedAt: 12830 },
];

it.each(qaRuns)("replays QA's B4 run $run: a call made, started and ended in another tab shows on Home within one check of each change", async ({ before, made, liveAt, endedAt }) => {
  const opened = Date.now();
  const createdAt = 1000;
  const truth: Truth = { calls: before.map((id) => row(id, "New call")), live: {} };
  serve(truth);
  const at = async (ms: number, change: () => void) => {
    await tick(opened + createdAt + ms - Date.now());
    change();
  };
  await open();
  expect(screen.queryAllByText("New call")).toHaveLength(before.length);
  await at(0, () => {
    truth.calls = [row(made, "New call"), ...truth.calls];
  });
  await tick(5000);
  expect(screen.getAllByText("New call")).toHaveLength(before.length + 1);
  await at(liveAt, () => {
    truth.live[made] = first;
  });
  await tick(5000);
  expect(screen.getByText("Live · 1 in the call")).toBeTruthy();
  await at(endedAt, () => {
    delete truth.live[made];
  });
  await tick(5000);
  expect(screen.queryByText("Live · 1 in the call")).toBeNull();
  // Only the page load reads a page; each later answer came in one status check.
  expect(requests().filter(([name]) => name === "home")).toHaveLength(1);
});
