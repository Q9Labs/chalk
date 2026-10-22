import { strict as assert } from "node:assert";

export async function proveToastLayering(browser, styles) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  try {
    await page.setContent(`<style>${styles}</style>
      <main style="position:relative;height:580px">
        <div style="position:absolute;bottom:92px;left:300px;z-index:50">
          <button style="width:180px;height:48px" onclick="this.dataset.clicked='true'">Send a reaction</button>
        </div>
        <div class="chalk-toasts">
          <div class="chalk-toast" role="alert" style="width:500px">
            <span style="flex:1">Your camera couldn’t start. Try again.</span>
            <button aria-label="Dismiss" onclick="this.closest('[role=alert]').remove()">×</button>
          </div>
        </div>
      </main>`);
    const reaction = page.getByRole("button", { name: "Send a reaction", exact: true });
    assert.equal(
      await reaction.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      }),
      true,
      "The error toast must not cover the open z-50 reaction tray",
    );
    await reaction.click();
    assert.equal(await reaction.getAttribute("data-clicked"), "true");
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    assert.equal(await page.getByRole("alert").count(), 0, "The toast dismiss button must remain usable");
  } finally {
    await page.close();
  }
}
