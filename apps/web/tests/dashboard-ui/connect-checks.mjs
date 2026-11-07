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
      check("consent names the signed-in account and tenant", (await tab.getByText("hasan@q9labs.ai").isVisible()) && (await tab.locator(".cwho").innerText()).includes("Hasan Shoaib"));
      check("consent offers to switch account", await tab.getByRole("button", { name: "Switch account" }).isVisible());
      await tab.getByRole("button", { name: "Switch account" }).click();
      // The next sign-in is as the other fixture account.
      await tab.evaluate(() => fetch("/__fixture/set?account=new"));
      await tab.getByRole("button", { name: "Continue with Google" }).click();
      await tab.getByRole("heading", { name: "Connect Claude to Chalk" }).waitFor();
      const who = await tab.locator(".cwho").innerText();
      check("switching accounts returns to the same request as the other account", tab.url().endsWith(`/dashboard/connect?request=${handle("claude", "read")}`) && who.includes("june@example.com") && who.includes("June Park") && !who.includes("hasan@q9labs.ai"), who);
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
    const { tab, context } = await open("/dashboard/apps");
    try {
      const rows = tab.locator("table.capps tbody tr");
      await rows.first().waitFor();
      check("connected apps list one row per app", (await rows.count()) === 5);
      const trash = rows.filter({ hasText: "Claude" }).getByRole("button", { name: "Disconnect Claude" });
      check("a connected app is disconnected with an icon button that has no visible text", (await trash.innerText()).trim() === "" && (await trash.getAttribute("data-tip")) !== null);
      await trash.click();
      const dialog = tab.getByRole("alertdialog");
      check("disconnect confirmation shows the pair as broken", (await dialog.locator(".apair.broken").count()) === 1);
      check("disconnect confirmation starts on Cancel, the safe choice", await dialog.getByRole("button", { name: "Cancel" }).evaluate((node) => node === document.activeElement));
      await tab.setViewportSize({ width: 640, height: 360 });
      const confirmButton = dialog.getByRole("button", { name: "Disconnect" });
      await confirmButton.scrollIntoViewIfNeeded();
      const reach = await confirmButton.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: window.innerHeight };
      });
      check("disconnect button stays reachable on a short screen", reach.top >= 0 && reach.bottom <= reach.height);
      await tab.setViewportSize({ width: 1280, height: 800 });
      await tab.keyboard.press("Escape");
      check("Escape closes the confirmation and keeps the app", (await tab.getByRole("alertdialog").count()) === 0 && (await rows.count()) === 5);
      await trash.click();
      await dialog.getByRole("button", { name: "Disconnect" }).click();
      await tab.getByText("Disconnected Claude").waitFor();
      check("disconnecting removes the row", (await rows.count()) === 4);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/apps", { set: "manyConnections=1" });
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
    const { tab, context } = await open("/dashboard/apps", { set: "manyConnections=1" });
    try {
      await tab.locator("table.capps tbody tr").first().waitFor();
      const rowNames = await tab.locator("table.capps tbody .nm").allInnerTexts();
      check("an app on a later page of the table still shows Connected", !rowNames.includes("Codex") && (await tab.locator(".ctile", { hasText: "Codex" }).first().innerText()).includes("Connected"), rowNames.join());
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/apps");
    try {
      const tiles = tab.locator(".ctile");
      await tiles.first().waitFor();
      check(
        "the AI apps page has its own tab and heading",
        (await tab.getByRole("heading", { level: 1, name: "AI apps" }).isVisible()) && (await tab.getByRole("link", { name: "AI apps", exact: true }).getAttribute("aria-current")) === "page" && (await tab.getByRole("link", { name: "Home", exact: true }).getAttribute("aria-current")) === null,
      );
      check("the page shows the Chalk URL to copy", (await tab.locator(".murl code").innerText()) === "https://api.chalk.test/mcp" && (await tab.locator(".murl").getByRole("button", { name: "Copy URL" }).isVisible()));
      const columns = async (width) => {
        await tab.setViewportSize({ width, height: 900 });
        return tab.locator(".cgrid").evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
      };
      check("the grid has 4 columns on a wide screen, 2 on a tablet and 1 on a phone", (await columns(1280)) === 4 && (await columns(820)) === 2 && (await columns(390)) === 1);
      await tab.setViewportSize({ width: 1280, height: 860 });
      check("the catalog lists the clients that can connect", (await tiles.count()) === 7);
      const boxes = await tiles.evaluateAll((nodes) => nodes.map((node) => ({ w: Math.round(node.getBoundingClientRect().width), h: Math.round(node.getBoundingClientRect().height) })));
      check(
        "every tile is the same size",
        boxes.every((box) => box.w === boxes[0].w && box.h === boxes[0].h),
      );
      const off = await tiles.evaluateAll((nodes) =>
        nodes.flatMap((node) => {
          const tile = node.querySelector(".alogo")?.getBoundingClientRect();
          const art = node.querySelector(".alogo img, .alogo .glyph")?.getBoundingClientRect();
          if (!tile || !art) return [];
          const dx = Math.abs(tile.x + tile.width / 2 - (art.x + art.width / 2));
          const dy = Math.abs(tile.y + tile.height / 2 - (art.y + art.height / 2));
          return dx < 1.5 && dy < 1.5 ? [] : [node.querySelector(".nm")?.textContent];
        }),
      );
      check("logos sit centred inside their tiles", off.length === 0);
      check("a connected app shows Connected and the same name with a suffix does not", (await tiles.filter({ hasText: "Claude" }).first().innerText()).includes("Connected") && !(await tiles.filter({ hasText: "Claude Code" }).innerText()).includes("Connected"));
      check("an app that can't connect yet says Soon", (await tiles.filter({ hasText: "Grok" }).innerText()).includes("Soon"));
      check("Devin stays Soon until Chalk accepts its sign-in address", (await tiles.filter({ hasText: "Devin" }).innerText()).includes("Soon"));
      const connectedTiles = await tiles.filter({ hasText: "Connected" }).locator(".nm").allInnerTexts();
      const tileNames = await tiles.locator(".nm").allInnerTexts();
      const rowNames = (await tab.locator("table.capps tbody .nm").allInnerTexts()).filter((name) => tileNames.includes(name));
      check("the tiles that say Connected are the connected apps in the table", connectedTiles.sort().join() === rowNames.sort().join(), `${connectedTiles} vs ${rowNames}`);
      const search = tab.getByRole("searchbox", { name: "Search AI apps" });
      await tiles.filter({ hasText: "Codex" }).focus();
      await tab.keyboard.press("Enter");
      check("a tile opens from the keyboard", await tab.getByRole("dialog").isVisible());
      await tab.keyboard.press("Escape");
      check("closing the sheet returns focus to its tile", await tiles.filter({ hasText: "Codex" }).evaluate((node) => node === document.activeElement));
      await search.fill("co");
      check("search matches app names only, so a description doesn't pull in other apps", (await tiles.count()) === 2 && (await tiles.filter({ hasText: "Codex" }).count()) === 1 && (await tiles.filter({ hasText: "Claude Code" }).count()) === 1);
      await search.fill("codex");
      check("search narrows the catalog", (await tiles.count()) === 1);
      await search.fill("zzz");
      check("search with no match says so", await tab.getByText("No app matches “zzz”.").isVisible());
      await search.fill("");
      await tab.getByRole("button", { name: "Coding agents" }).click();
      check("the kind filter shows only coding agents", (await tiles.count()) === 4);
      await tab.getByRole("button", { name: "All" }).click();
      await tiles.filter({ hasText: "Claude Code" }).click();
      const sheet = tab.getByRole("dialog");
      check("a client sheet gives the command with this server's address", (await sheet.locator("code").innerText()) === "claude mcp add --transport http chalk https://api.chalk.test/mcp");
      check("the sheet shows the app and Chalk logos", (await sheet.locator(".apair .alogo").count()) === 2);
      await tab.keyboard.press("Escape");
      await tiles.filter({ hasText: "Claude" }).first().click();
      check("a chat app sheet gives the URL and numbered steps", (await sheet.locator("code").innerText()) === "https://api.chalk.test/mcp" && (await sheet.locator("ol li").count()) === 5);
      await tab.keyboard.press("Escape");
      await tiles.filter({ hasText: "Grok" }).click();
      check("an app that can't connect yet offers no steps", (await sheet.locator("code, ol").count()) === 0 && (await sheet.getByText("end to end").isVisible()));
      await tab.keyboard.press("Escape");
      check("Escape closes the sheet", (await tab.getByRole("dialog").count()) === 0);
      await tab.setViewportSize({ width: 390, height: 844 });
      await tiles.filter({ hasText: "Claude Code" }).click();
      await tab.waitForTimeout(400);
      const sheetBox = await sheet.boundingBox();
      check("on a phone the sheet is a tall bottom sheet inside the screen", sheetBox !== null && sheetBox.height > 700 && sheetBox.width <= 390 && sheetBox.y + sheetBox.height <= 844 + 1);
      await tab.keyboard.press("Escape");
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/apps", { set: "manyConnections=1" });
    try {
      await tab.locator("table.capps tbody tr").first().waitFor();
      await tab.getByRole("button", { name: "Disconnect Claude", exact: true }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
      await tab.getByText("Disconnected Claude").waitFor();
      await tab.waitForFunction(() => !Array.from(document.querySelectorAll(".ctile")).find((node) => node.textContent?.includes("Claude") && !node.textContent.includes("Claude Code") && node.textContent.includes("Connected")));
      check("with more pages, disconnecting an app takes its Connected badge off the tile", (await tab.locator(".ctile", { hasText: "ChatGPT" }).innerText()).includes("Connected"));
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/apps", { set: "manyConnections=1&fail=connections-scan" });
    try {
      await tab.locator("table.capps tbody tr").first().waitFor();
      const codex = tab.locator(".ctile", { hasText: "Codex" });
      const before = (await codex.innerText()).includes("Connected");
      await tab.getByRole("button", { name: "Show more apps" }).click();
      await tab.locator("table.capps tbody tr:nth-child(27)").waitFor();
      check("an app on a page the name scan missed shows Connected once its page is loaded", !before && (await codex.innerText()).includes("Connected"));
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/apps", { set: "fail=connections-list" });
    try {
      await tab.getByRole("alert").filter({ hasText: "Couldn’t load your connected apps" }).waitFor();
      check("when the connected apps can't load, the address and every app still show", (await tab.locator(".murl code").innerText()) === "https://api.chalk.test/mcp" && (await tab.locator(".ctile").count()) === 7);
      check("a failed list reads as an error, not as no connected apps", (await tab.getByText("No connected apps").count()) === 0);
      await tab.locator(".ctile", { hasText: "Codex" }).click();
      check("an app's setup opens while the list is down", await tab.getByRole("dialog").isVisible());
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/apps", { account: "new" });
    try {
      await tab.getByText("No connected apps").waitFor();
      check("no connected apps points at the catalog", await tab.getByText("Pick an app above").isVisible());
      check("with nothing connected no tile says Connected", (await tab.locator(".ctile", { hasText: "Connected" }).count()) === 0);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open("/dashboard/developer");
    try {
      await tab.getByRole("link", { name: "Connect an AI app" }).click();
      await tab.getByRole("heading", { level: 1, name: "AI apps" }).waitFor();
      check("the Developer page links to the AI apps page", tab.url().endsWith("/dashboard/apps"));
    } finally {
      await context.close();
    }
  }
}
