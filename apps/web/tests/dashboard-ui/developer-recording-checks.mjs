// The real settings page talks to the dashboard DTO fixture, not the public API.
export async function developerRecordingChecks({ open, fixture, check }) {
  const { tab, context } = await open("/dashboard/developer");
  try {
    const mode = tab.getByRole("combobox", { name: "Make recording videos" });
    const save = tab.getByRole("button", { name: "Save recording settings" });
    await mode.waitFor();
    check("recording mode defaults to on demand", (await mode.inputValue()) === "on_demand" && (await save.isDisabled()));
    await mode.selectOption("automatic");
    await save.click();
    await tab.getByText("Recording settings saved", { exact: true }).waitFor();
    await tab.reload({ waitUntil: "networkidle" });
    check("recording mode saves and survives reload", (await mode.inputValue()) === "automatic" && (await save.isDisabled()));
    await fixture("set?fail=set-recording-render-mode");
    await mode.selectOption("on_demand");
    await save.click();
    await tab.getByRole("alert").waitFor();
    check("failed recording setting save keeps the draft", (await mode.inputValue()) === "on_demand" && (await save.isEnabled()));
    await fixture("set?fail=");
    await save.click();
    await tab.getByText("Recording settings saved", { exact: true }).waitFor();
    await tab.reload({ waitUntil: "networkidle" });
    check("recording mode can be switched back to on demand", (await mode.inputValue()) === "on_demand");
  } finally {
    await context.close();
  }
}
