// The connect flow and Connected apps against the DTO fixture. The handle names the fixture app and scope: chalk_oar_<app>_<read|manage>_<padding>.
const handle = (app, scope) => `chalk_oar_${app}_${scope}_aaaaaaaaaaaaaaaaaaaa`;

export async function connectChecks({ open, check }) {
  async function connect(request, set) {
    const route = request ? `/dashboard/connect?request=${request}` : "/dashboard/connect";
    const { tab, context } = await open(route, set ? { set } : {});
    // The connecting app's own site is out of scope: its navigation stays pending, so the page that started it stays on screen.
    await context.route(/^https:\/\/(?!127)/, (route) => route.fulfill({ status: 204 }));
    const posts = [];
    tab.on("request", (sent) => sent.method() === "POST" && sent.url().includes("/dashboard-api/connect") && posts.push(sent.postDataJSON()));
    return { tab, context, posts };
  }

  {
    const { tab, context } = await connect(handle("claude", "read"));
    try {
      await tab.getByRole("heading", { name: "Connect Claude to Chalk" }).waitFor();
      check("read request has no access choice", (await tab.getByRole("button", { name: "Read and change" }).count()) === 0);
      check("consent names the signed-in account and tenant", await tab.getByText("hasan@q9labs.ai").isVisible() && (await tab.locator(".cwho").innerText()).includes("Hasan Shoaib"));
      check("consent offers to switch account", await tab.getByRole("button", { name: "Switch account" }).isVisible());
      await tab.getByRole("button", { name: "Switch account" }).click();
      await tab.getByRole("button", { name: "Continue with Google" }).click();
      await tab.getByRole("heading", { name: "Connect Claude to Chalk" }).waitFor();
      check("switching accounts signs in again and returns to the same request", tab.url().endsWith(`/dashboard/connect?request=${handle("claude", "read")}`));
      check("consent page leaves out the dashboard frame", (await tab.locator(".topb").count()) === 0);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context, posts } = await connect(handle("claude", "manage"));
    try {
      await tab.getByRole("heading", { name: "Connect Claude to Chalk" }).waitFor();
      check("manage request starts on read only", (await tab.getByRole("button", { name: "Read only" }).getAttribute("aria-pressed")) === "true");
      await tab.getByRole("button", { name: "Read and change" }).click();
      check("choosing read and change updates what is listed", await tab.getByText("See and change your Spaces").isVisible());
      await tab.getByRole("button", { name: "Connect Claude" }).click();
      await tab.getByRole("link", { name: "Continue to claude.ai" }).waitFor();
      check("approving sends the chosen scope and shows the returning state", posts.at(-1)?.action === "approve-connection" && posts.at(-1)?.scope === "chalk:manage");
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context, posts } = await connect(handle("claude", "manage"));
    try {
      await tab.getByRole("button", { name: "Cancel" }).click();
      await tab.getByRole("heading", { name: "Claude wasn’t connected" }).waitFor();
      check("cancelling denies the request and says nothing was connected", posts.at(-1)?.action === "deny-connection" && (await tab.locator(".apair.broken").count()) === 1);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await connect(handle("claude", "manage"), "fail=approve-connection");
    try {
      await tab.getByRole("button", { name: "Read and change" }).click();
      await tab.getByRole("button", { name: "Connect Claude" }).click();
      await tab.getByRole("alert").waitFor();
      const kept = (await tab.getByRole("button", { name: "Read and change" }).getAttribute("aria-pressed")) === "true";
      check("a failed approval keeps the choice and allows another try", kept && (await tab.getByRole("button", { name: "Connect Claude" }).isEnabled()));
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await connect(handle("expired", "read"));
    try {
      await tab.getByRole("heading", { name: "This connection request expired" }).waitFor();
      check("an expired request uses the same standalone layout", (await tab.locator(".topb").count()) === 0 && (await tab.locator(".sibox .apair").count()) === 1);
      check("an expired request shows only the Chalk mark and no account line", (await tab.locator(".sibox .apair .alogo").count()) === 1 && (await tab.locator(".cwho").count()) === 0);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await connect("");
    try {
      await tab.getByRole("heading", { name: "Start from the app" }).waitFor();
      check("a missing request uses the same standalone layout", (await tab.locator(".topb").count()) === 0 && (await tab.locator(".sibox .apair").count()) === 1);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/developer");
    try {
      const rows = tab.locator("table.capps tbody tr");
      await rows.first().waitFor();
      check("connected apps list one row per app", (await rows.count()) === 5);
      await rows.filter({ hasText: "Claude" }).getByRole("button", { name: "Disconnect Claude" }).click();
      const dialog = tab.getByRole("alertdialog");
      check("disconnect confirmation shows the pair as broken", (await dialog.locator(".apair.broken").count()) === 1);
      await dialog.getByRole("button", { name: "Disconnect" }).click();
      await tab.getByText("Disconnected Claude").waitFor();
      check("disconnecting removes the row", (await rows.count()) === 4);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/developer", { set: "manyConnections=1" });
    try {
      const rows = tab.locator("table.capps tbody tr");
      await rows.first().waitFor();
      check("connected apps loads the first page of 25", (await rows.count()) === 25);
      await tab.getByRole("button", { name: "Show more apps" }).click();
      await tab.locator("table.capps tbody tr:nth-child(27)").waitFor();
      check("show more apps adds the rest", (await rows.count()) === 27 && (await tab.getByRole("button", { name: "Show more apps" }).count()) === 0);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/developer", { account: "new" });
    try {
      await tab.getByText("No connected apps").waitFor();
      check("no connected apps explains how to add one", await tab.getByText("Add Chalk as a custom connector").isVisible());
    } finally {
      await context.close();
    }
  }
}
