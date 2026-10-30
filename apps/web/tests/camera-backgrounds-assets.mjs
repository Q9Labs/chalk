import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function routePresetAssets(page) {
  await page.route("https://assets.chalkmeet.com/ui/backgrounds/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    assert(name && /^[a-z0-9.-]+\.(avif|webp)$/.test(name));
    await route.fulfill({ body: await readFile(new URL(`../src/call-states/camera-fixtures/${name}`, import.meta.url)), contentType: name.endsWith(".avif") ? "image/avif" : "image/webp", headers: { "Access-Control-Allow-Origin": "*" } });
  });
}
