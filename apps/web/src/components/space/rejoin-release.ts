import type { SpaceClient } from "@q9labsai/chalk-client";

/** Release the old arrival before closing its telemetry source and allowing the next arrival to start. */
export async function releaseForRejoin(release: () => Promise<void>, client: Pick<SpaceClient, "telemetry" | "close">): Promise<void> {
  try {
    await release();
  } catch (cause) {
    client.telemetry.rejoinRelease?.("release_failed");
    throw cause;
  }
  client.telemetry.rejoinRelease?.("released");
  await client.close();
}
