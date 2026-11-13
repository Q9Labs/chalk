// The old Sessions and Recordings URLs redirect, the call page lists its past sessions with the shared row, a row opens its session,
// a session's transcript can be deleted, and none of these pages scrolls sideways on a phone.
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const CALL = uuid(0x100);

export async function listChecks({ open, check }) {
  // The old lists: a link filtered to one call opens that call; anything else opens Home.
  {
    const { tab, context } = await open(`/dashboard/sessions?spaceId=${CALL}`);
    await tab.waitForURL(`**/dashboard/call/${CALL}`);
    check("the old Sessions link with a call opens that call", new URL(tab.url()).pathname === `/dashboard/call/${CALL}`, tab.url());
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/recordings");
    await tab.waitForURL((url) => url.pathname === "/dashboard");
    check("the old Recordings link without a call opens Home", new URL(tab.url()).pathname === "/dashboard", tab.url());
    await context.close();
  }

  // The call page's past sessions, and a row opens its session.
  {
    const { tab, context } = await open(`/dashboard/call/${CALL}`);
    await tab.locator(".slist.ses.one .lr:not(.head)").first().waitFor();
    check("the call page lists its sessions with the shared row", (await tab.locator(".slist.ses.one .lr:not(.head)").count()) >= 5);
    await tab.locator(".slist.ses.one .lr:not(.head) a.go").first().click();
    await tab.waitForURL(`**/dashboard/call/${CALL}/session/**`);
    await tab.getByRole("heading", { name: "Who joined" }).waitFor();
    check("a session row opens its session", (await tab.getByRole("heading", { name: "Recording", exact: true }).count()) === 1);
    check("the recording and transcript cards are named landmarks", (await tab.locator("section[aria-labelledby=recording-title]").count()) === 1 && (await tab.locator("section[aria-labelledby=transcript-title]").count()) === 1);
    check("the session shows who joined, one bar for each person", (await tab.locator(".wjr:not(.head)").count()) === 5);
    await tab.locator(".crumb a").click();
    await tab.waitForURL(`**/dashboard/call/${CALL}`);
    await context.close();
  }
  // A session's transcript is deleted from its page: the confirm says what stays, Cancel keeps it, and the page then says it was deleted.
  {
    const { tab, context } = await open(`/dashboard/call/${CALL}/session/${uuid(0x200)}`);
    const trash = tab.locator("section[aria-labelledby=transcript-title]").getByRole("button", { name: "Delete transcript" });
    await trash.click();
    const dialog = tab.getByRole("alertdialog");
    await dialog.waitFor();
    check("deleting a transcript asks first and says the recording stays", (await dialog.innerText()).includes("The recording and the session stay."));
    await dialog.getByRole("button", { name: "Cancel" }).click();
    check("Cancel keeps the transcript", (await tab.getByRole("alertdialog").count()) === 0 && (await trash.count()) === 1);
    await trash.click();
    await tab.getByRole("alertdialog").getByRole("button", { name: "Delete transcript" }).click();
    await tab.getByText("Transcript deleted.").waitFor();
    await tab.getByText("This transcript was deleted").waitFor();
    check("a deleted transcript leaves the session saying so, with no Delete left", (await trash.count()) === 0);
    await context.close();
  }
  {
    const { tab, context } = await open(`/dashboard/call/${CALL}/session/${uuid(0x202)}`);
    await tab.getByText("Recording was off for this session", { exact: true }).waitFor();
    check("a session without a recording says so and still shows who came", (await tab.getByRole("heading", { name: "Who joined" }).count()) === 1);
    const settings = tab.getByRole("link", { name: "Account recording settings" });
    check("a session without a recording links to the recording setting", (await settings.getAttribute("href"))?.endsWith("/dashboard/developer#recording-videos") === true, await settings.getAttribute("href"));
    await context.close();
  }

  // A phone: nothing scrolls sideways, in either theme.
  for (const route of [`/dashboard/call/${CALL}`, `/dashboard/call/${CALL}/session/${uuid(0x200)}`]) {
    for (const theme of ["dark", "light"]) {
      const { tab, context } = await open(route, { width: 390, theme });
      await tab.waitForTimeout(500);
      const sideways = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${route.replace(CALL, "call").replace(uuid(0x200), "session")} does not scroll sideways at 390 (${theme})`, sideways <= 0, `${sideways}px over`);
      await context.close();
    }
  }
}
