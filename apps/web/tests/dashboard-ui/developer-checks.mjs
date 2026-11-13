// The Developer page: secrets never show in full unless asked, Copy copies the whole key, the key picker and the language picker work from the keyboard, and icons come from Chalk's own origin.
const MINTED = "chalk_sk_Rw8f2LqN0vXc.4TzJ7hKp1sYd9mBaE3uG";
const MINTED_MIDDLE = "4TzJ7hKp1sYd9mBaE";
const TENANT = "00000000-0000-4000-8000-000000000001";

export async function developerChecks({ open, check, origin }) {
  const clipboard = (tab) => tab.evaluate(() => navigator.clipboard.readText());
  const bodyText = (tab) => tab.locator("body").innerText();
  const withClipboard = (context) => context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });

  // A new key: the secret is redacted in the dialog and in the row, shown on request, and copied whole.
  {
    const { tab, context } = await open("/dashboard/developer");
    try {
      await withClipboard(context);
      await tab.getByRole("button", { name: "Create API key" }).first().click();
      await tab.getByLabel("Name", { exact: true }).fill("Production server");
      await tab.locator("[role=dialog] button[type=submit]").click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByTestId("secret-text").waitFor();
      const redacted = await dialog.getByTestId("secret-text").textContent();
      check("secret dialog redacts the key", redacted === "chalk_sk_Rw8f••••••••••3uG" && !(await bodyText(tab)).includes(MINTED_MIDDLE), redacted ?? "");
      await dialog.getByRole("button", { name: "Show key" }).click();
      check("the eye shows the full key on request", (await dialog.getByTestId("secret-text").textContent()) === MINTED);
      await dialog.getByRole("button", { name: "Hide key" }).click();
      check("the eye hides it again", (await dialog.getByTestId("secret-text").textContent()) === redacted);
      await dialog.getByRole("button", { name: /^Copy/ }).click();
      check("Copy copies the full key while the screen shows it redacted", (await clipboard(tab)) === MINTED && (await dialog.getByRole("button", { name: "Copied" }).count()) === 1 && !(await bodyText(tab)).includes(MINTED_MIDDLE));
      await dialog.getByRole("button", { name: "Done" }).click();

      const reveal = tab.getByRole("status").filter({ hasText: "Production server is ready" });
      check("the new key's row redacts the secret too", (await reveal.getByTestId("secret-text").textContent()) === redacted && !(await bodyText(tab)).includes(MINTED_MIDDLE));
      const snippet = tab.getByRole("tabpanel");
      check("the snippet draws the new key redacted", (await snippet.innerText()).includes("chalk_sk_Rw8f•") && !(await snippet.innerText()).includes(MINTED_MIDDLE));
      await tab.getByRole("button", { name: "Copy snippet", exact: true }).click();
      const copied = await clipboard(tab);
      check("the snippet's Copy puts the full new key in the text", copied.includes(`CHALK_API_KEY=${MINTED}`) && copied.includes(`CHALK_TENANT_ID=${TENANT}`), copied);
      await tab.reload({ waitUntil: "networkidle" });
      await tab.getByRole("button", { name: "Copy snippet", exact: true }).click();
      check("after a reload nothing holds the secret, and Copy says so with dots", !(await clipboard(tab)).includes(MINTED_MIDDLE) && !(await bodyText(tab)).includes(MINTED_MIDDLE));
    } finally {
      await context.close();
    }
  }

  // The code panel: tabs follow the arrow keys, each shows the tenant and a redacted key.
  {
    const { tab, context } = await open("/dashboard/developer");
    try {
      const tabs = tab.getByRole("tablist", { name: "Code" });
      await tabs.getByRole("tab", { name: ".env" }).focus();
      await tab.keyboard.press("ArrowRight");
      const curl = tabs.getByRole("tab", { name: "cURL" });
      check("arrow key moves to the cURL tab", (await curl.getAttribute("aria-selected")) === "true" && (await tab.getByRole("tabpanel").innerText()).includes(`/v1/tenants/${TENANT}/spaces`));
      await tab.keyboard.press("ArrowRight");
      check("arrow key moves to the TypeScript tab", (await tabs.getByRole("tab", { name: "TypeScript" }).getAttribute("aria-selected")) === "true" && (await tab.getByRole("tabpanel").innerText()).includes("createChalkServerClient"));
      await tab.keyboard.press("Home");
      check("Home returns to the .env tab", (await tabs.getByRole("tab", { name: ".env" }).getAttribute("aria-selected")) === "true");
    } finally {
      await context.close();
    }
  }

  // The key picker: Arrow keys move, Enter chooses, Esc closes and gives focus back.
  {
    const { tab, context } = await open("/dashboard/developer");
    try {
      const picker = tab.getByRole("button", { name: "API key", exact: true });
      await picker.focus();
      await tab.keyboard.press("Enter");
      const list = tab.getByRole("listbox", { name: "API key" });
      await list.waitFor();
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("Enter");
      check("picker: Arrow then Enter chooses the next key and the snippet follows", (await picker.textContent())?.includes("MCP server") === true && (await tab.getByRole("tabpanel").innerText()).includes("chalk_sk_k91P"));
      check("picker: choosing closes it and returns focus to the picker", (await list.count()) === 0 && (await picker.evaluate((node) => node === document.activeElement)));
      await picker.click();
      await tab.keyboard.press("End");
      check("picker: End lands on Create API key", (await list.getByRole("option").last().getAttribute("class"))?.includes("hl") === true);
      await tab.keyboard.press("Escape");
      check("picker: Esc closes it", (await list.count()) === 0 && (await picker.evaluate((node) => node === document.activeElement)));
    } finally {
      await context.close();
    }
  }

  // The language picker: type to search, Arrow and Enter to choose, saved at once, and it stays on screen.
  {
    const { tab, context } = await open("/dashboard/developer", { width: 1100 });
    try {
      const trigger = tab.locator(".lp-trigger");
      await trigger.evaluate((node) => node.scrollIntoView({ block: "end" }));
      await trigger.click();
      const popover = tab.locator(".lp-pop");
      await popover.waitFor();
      const box = await popover.boundingBox();
      const viewport = tab.viewportSize();
      check("language picker opens inside the window, upward when the control is at the bottom", Boolean(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height));
      check("language picker marks the open trigger", (await trigger.getAttribute("aria-expanded")) === "true");
      const search = tab.getByRole("combobox", { name: "Search languages" });
      await search.fill("span");
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("Enter");
      await tab.getByText("Transcript language saved", { exact: true }).waitFor();
      check("language picker: search, Arrow and Enter save the choice", /Spanish|Español/.test((await trigger.textContent()) ?? "") && (await popover.count()) === 0);
      await trigger.click();
      check("language picker marks the chosen row", /Spanish|Español/.test((await tab.locator(".lp-pop [role=option][aria-selected=true]").first().textContent()) ?? ""));
      await tab.keyboard.press("Escape");
      check("language picker: Esc closes it and returns focus", (await tab.locator(".lp-pop").count()) === 0 && (await trigger.evaluate((node) => node === document.activeElement)));
    } finally {
      await context.close();
    }
  }

  // Icons: allowed websites and webhook endpoints ask Chalk for their icon; a site with none gets a lettered tile.
  {
    const { tab, context } = await open("/dashboard/developer");
    try {
      const icon = tab.locator('img[src^="/dashboard-api/favicon?host=chalkmeet.com"]');
      await icon.waitFor({ state: "attached" });
      check("a website's icon loads from Chalk's own origin", await icon.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
      check("a website with no icon gets a lettered tile", (await tab.locator(".fav.tile", { hasText: "L" }).count()) === 1);
    } finally {
      await context.close();
    }
  }

  // The section nav links to each section.
  {
    const { tab, context } = await open("/dashboard/developer");
    try {
      const nav = tab.getByRole("navigation", { name: "On this page" });
      const links = await nav.getByRole("link").allTextContents();
      check(
        "section nav lists every section",
        ["Connect", "API keys", "Websites", "Webhooks", "Calls", "AI apps"].every((name) => links.some((text) => text.startsWith(name))),
        links.join(" | "),
      );
    } finally {
      await context.close();
    }
  }
}
