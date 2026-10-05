export async function waitForRecovery(page, waitFor) {
  await waitFor(page, (snapshot) => snapshot.state === "reconnecting" || snapshot.state === "live");
  await waitFor(page, (snapshot) => snapshot.state === "live");
}
