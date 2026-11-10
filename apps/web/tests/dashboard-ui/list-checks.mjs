// The Sessions and Recordings pages: filters live in the address, the list pages, the player opens from the list, a transcript is deleted
// only after a confirm, and neither page scrolls sideways on a phone.
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const CALL = uuid(0x100);

export async function listChecks({ open, check, origin }) {
  const rows = (tab) => tab.locator(".slist .lr:not(.head)");
  const clipboard = (tab) => tab.evaluate(() => navigator.clipboard.readText());

  // Sessions: the first page, the next page, and the totals over every match.
  {
    const { tab, context } = await open("/dashboard/sessions");
    check("the top bar has Sessions and Recordings tabs", (await tab.getByRole("link", { name: "Sessions", exact: true }).count()) >= 1 && (await tab.getByRole("link", { name: "Recordings", exact: true }).count()) >= 1);
    await tab.getByRole("heading", { name: "Sessions", level: 1 }).waitFor();
    check("Sessions lists ten rows first", (await rows(tab).count()) === 10, String(await rows(tab).count()));
    const stats = await tab.locator(".stats .stat .v").allInnerTexts();
    check("Sessions totals cover every match, not the page", stats[0] === "13" && stats[2]?.startsWith("11"), stats.join(" | "));
    await tab.getByRole("button", { name: "Show older sessions" }).click();
    await tab.waitForFunction(() => document.querySelectorAll(".slist .lr:not(.head)").length === 13);
    check("Show older sessions adds the rest and the button goes away", (await tab.getByRole("button", { name: "Show older sessions" }).count()) === 0);
    await context.close();
  }

  // Sessions: filters are in the address and show as chips.
  {
    const { tab, context } = await open("/dashboard/sessions");
    await tab.getByRole("link", { name: "Without recording" }).click();
    await tab.waitForFunction(() => new URL(location.href).searchParams.get("show") === "none");
    await tab.waitForTimeout(400);
    check("Without recording keeps only sessions without one", (await rows(tab).count()) === 2, String(await rows(tab).count()));
    check("the filter shows as a chip", (await tab.locator(".lchip").filter({ hasText: "Without recording" }).count()) === 1);
    await tab.getByRole("link", { name: "All sessions" }).click();
    await tab.getByPlaceholder("Search by call name").fill("design");
    await tab.waitForFunction(() => new URL(location.href).searchParams.get("q") === "design");
    await tab.waitForFunction(() => document.querySelectorAll(".slist .lr:not(.head)").length === 1);
    check("search matches the call name and goes in the address", (await rows(tab).first().innerText()).includes("Design review"));
    await tab.getByPlaceholder("Search by call name").fill("zzzz");
    await tab.getByText("No sessions match", { exact: true }).waitFor();
    await tab.getByRole("button", { name: "Clear filters" }).click();
    await tab.waitForFunction(() => document.querySelectorAll(".slist .lr:not(.head)").length === 10);
    check("Clear filters brings the list back", new URL(tab.url()).search === "");
    await context.close();
  }

  // Sessions: a date range from the menu.
  {
    const { tab, context } = await open("/dashboard/sessions");
    await tab.getByRole("button", { name: /Last 30 days/ }).click();
    await tab.getByRole("button", { name: "Last 7 days" }).click();
    await tab.waitForFunction(() => new URL(location.href).searchParams.get("range") === "7d");
    await tab.waitForTimeout(400);
    check("a date range narrows the list", (await rows(tab).count()) === 6, String(await rows(tab).count()));
    await context.close();
  }

  // Sessions: the empty account, the cutoff notice, and a row opens its session.
  {
    const { tab, context } = await open("/dashboard/sessions", { account: "new" });
    await tab.getByText("No sessions yet", { exact: true }).waitFor();
    check("a new account sees the empty state with Start a call", (await tab.getByRole("link", { name: "Start a call" }).count()) >= 1);
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/sessions", { set: "truncated=1" });
    await tab.locator(".lcut").waitFor();
    check("a bounded scan says the oldest sessions may be missing", (await tab.locator(".lcut").innerText()).includes("Older sessions may be missing"));
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/sessions");
    await rows(tab).first().locator("a.go").click();
    await tab.waitForURL(`**/dashboard/call/${CALL}/session/**`);
    await tab.getByRole("heading", { name: "Who joined" }).waitFor();
    check("a session row opens its session", (await tab.getByRole("link", { name: "Sessions", exact: true }).count()) >= 1 && (await tab.getByRole("heading", { name: "Recording", exact: true }).count()) === 1);
    check("the recording and transcript cards are named landmarks", (await tab.locator("section[aria-labelledby=recording-title]").count()) === 1 && (await tab.locator("section[aria-labelledby=transcript-title]").count()) === 1);
    check("the session shows who joined, one bar for each person", (await tab.locator(".wjr:not(.head)").count()) === 5);
    await tab.locator(".crumb a").click();
    await tab.waitForURL("**/dashboard/sessions");
    await context.close();
  }
  {
    const { tab, context } = await open(`/dashboard/call/${CALL}/session/${uuid(0x202)}`);
    await tab.getByText("No recording", { exact: true }).waitFor();
    check("a session without a recording says so and still shows who came", (await tab.getByRole("heading", { name: "Who joined" }).count()) === 1);
    await context.close();
  }

  // Recordings: statuses, the player, and Prepare video.
  {
    const { tab, context } = await open("/dashboard/recordings");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await tab.getByRole("heading", { name: "Recordings", level: 1 }).waitFor();
    check("Recordings lists only sessions that have a recording", (await rows(tab).count()) === 10, String(await rows(tab).count()));
    check("a processing recording tells people they can leave", (await tab.locator(".lnote").innerText()).includes("This page updates by itself"));
    await tab.getByRole("link", { name: "Failed" }).click();
    await tab.waitForFunction(() => new URL(location.href).searchParams.get("status") === "failed");
    await tab.waitForTimeout(400);
    check("the Failed filter shows the two failed recordings with a reason", (await rows(tab).count()) === 2 && (await tab.locator(".u.bad").count()) === 2, String(await rows(tab).count()));
    check("only a retryable failure offers Retry", (await tab.getByRole("button", { name: "Retry" }).count()) === 1);
    await tab.getByRole("link", { name: "Not prepared" }).click();
    await tab.waitForFunction(() => new URL(location.href).searchParams.get("status") === "prepare");
    await tab.waitForTimeout(400);
    await tab.getByRole("button", { name: "Prepare video" }).click();
    await tab.getByRole("button", { name: "Prepare video" }).waitFor({ state: "detached" });
    check("Prepare video moves the row to Processing", (await rows(tab).first().innerText()).includes("Processing"));
    await tab.getByRole("link", { name: "Ready" }).click();
    await tab.waitForFunction(() => new URL(location.href).searchParams.get("status") === "ready");
    await tab.waitForTimeout(400);
    await rows(tab).first().getByRole("button", { name: "Copy link" }).click();
    await tab.getByText("Link copied. It opens for people signed in to this account.").waitFor();
    check("Copy link copies the session address", (await clipboard(tab)).includes(`/dashboard/call/${CALL}/session/`));
    await rows(tab).first().getByRole("button", { name: "Play" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    check("Play opens the player and puts the recording in the address", new URL(tab.url()).searchParams.has("play") && (await dialog.getByRole("link", { name: "Open session" }).count()) >= 1);
    await dialog.locator("video").first().waitFor({ timeout: 8000 });
    check("the player shows the video beside the transcript", (await dialog.locator(".trbox").count()) === 1);
    await tab.keyboard.press("Escape");
    await tab.waitForTimeout(200);
    check("Esc closes the player and the address forgets the recording", (await tab.getByRole("dialog").count()) === 0 && !new URL(tab.url()).searchParams.has("play"));
    check("focus goes back to Play", (await tab.evaluate(() => document.activeElement?.textContent?.trim())) === "Play");
    await context.close();
  }

  // Recordings: deleting a transcript asks first and says what stays.
  {
    const { tab, context } = await open("/dashboard/recordings?status=ready");
    await tab.getByRole("button", { name: "Delete transcript" }).first().click();
    const dialog = tab.getByRole("alertdialog");
    await dialog.waitFor();
    check("the confirm names the transcript and says the recording stays", (await dialog.innerText()).includes("The recording and the session stay."));
    await dialog.getByRole("button", { name: "Cancel" }).click();
    check("Cancel leaves the transcript", (await tab.getByRole("alertdialog").count()) === 0 && (await tab.getByText("Transcript ready").count()) > 0);
    const before = await tab.getByText("Transcript ready").count();
    await tab.getByRole("button", { name: "Delete transcript" }).first().click();
    await tab.getByRole("alertdialog").getByRole("button", { name: "Delete transcript" }).click();
    await tab.getByText("Transcript deleted.").waitFor();
    await tab.waitForFunction((count) => [...document.querySelectorAll(".slist .u")].filter((node) => node.textContent?.includes("Transcript ready")).length === count - 1, before);
    check("a deleted transcript leaves the row without one", true);
    await context.close();
  }

  // Recordings: empty and no-match states.
  {
    const { tab, context } = await open("/dashboard/recordings", { account: "new" });
    await tab.getByText("No recordings yet", { exact: true }).waitFor();
    check("a new account sees the empty state", (await tab.getByRole("link", { name: "Recording settings" }).count()) >= 1);
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/recordings?q=budget");
    await tab.getByText("No recordings match", { exact: true }).waitFor();
    check("a search with no match names the word", (await tab.locator(".blank").innerText()).includes("“budget”"));
    await context.close();
  }

  // The call page's own list is the same row.
  {
    const { tab, context } = await open(`/dashboard/call/${CALL}`);
    await tab.locator(".slist.ses.one .lr:not(.head)").first().waitFor();
    check("the call page lists its sessions with the shared row", (await tab.locator(".slist.ses.one .lr:not(.head)").count()) >= 5);
    await context.close();
  }

  // A phone: nothing scrolls sideways, in either theme.
  for (const route of ["/dashboard/sessions", "/dashboard/recordings", `/dashboard/call/${CALL}/session/${uuid(0x200)}`]) {
    for (const theme of ["dark", "light"]) {
      const { tab, context } = await open(route, { width: 390, theme });
      await tab.waitForTimeout(500);
      const sideways = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${route.replace(CALL, "call").replace(uuid(0x200), "session")} does not scroll sideways at 390 (${theme})`, sideways <= 0, `${sideways}px over`);
      await context.close();
    }
  }
}
