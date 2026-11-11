// The real settings page talks to the dashboard DTO fixture, not the public API. Calls settings save when they change.
export async function developerRecordingChecks({ open, fixture, check }) {
  const { tab, context } = await open("/dashboard/developer");
  try {
    const group = tab.getByRole("group", { name: "Recording videos" });
    const onDemand = group.getByRole("button", { name: "On demand" });
    const automatic = group.getByRole("button", { name: "Automatic" });
    await group.waitFor();
    check("recording mode defaults to on demand", (await onDemand.getAttribute("aria-pressed")) === "true" && (await automatic.getAttribute("aria-pressed")) === "false");
    await automatic.click();
    await tab.getByText("Recording settings saved", { exact: true }).waitFor();
    await tab.reload({ waitUntil: "networkidle" });
    check("recording mode saves when chosen and survives reload", (await automatic.getAttribute("aria-pressed")) === "true");
    await fixture("set?fail=set-recording-render-mode");
    await onDemand.click();
    await tab.getByRole("alert").waitFor();
    check("failed recording setting save keeps the saved value", (await automatic.getAttribute("aria-pressed")) === "true" && (await onDemand.getAttribute("aria-pressed")) === "false");
    await fixture("set?fail=");
    await onDemand.click();
    await tab.getByText("Recording settings saved", { exact: true }).waitFor();
    await tab.reload({ waitUntil: "networkidle" });
    check("recording mode can be switched back to on demand", (await onDemand.getAttribute("aria-pressed")) === "true");
  } finally {
    await context.close();
  }
}
