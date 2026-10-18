export async function routeCallFixtureAssets(page, boardCss) {
  await page.route("https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@*/dist/prod/index.css", (route) => route.fulfill({ path: boardCss, contentType: "text/css" }));
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ body: "", contentType: "text/css" }));
}
